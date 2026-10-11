//! The one bounded-run primitive: run a program with a hard deadline and
//! collect its stdout. `nvidia-smi` (node telemetry) and every custom metric
//! source ([`crate::metric_sources`], which run arbitrary commands) go
//! through [`run`]; nothing else in the telemetry path spawns a process.
//!
//! Limits, all enforced here: scrubbed environment, no stdin, stderr
//! discarded (never read), stdout capped, its own process group, killed at
//! the deadline, and a bounded reap (see below).
//!
//! # State table
//! E = stdout closed (every writer let go of the pipe), X = the program
//! exited, D = the deadline, C = the caller cancelled or the daemon is
//! exiting ([`kill_all_active`]).
//!
//! | observed | result | group |
//! |---|---|---|
//! | E, then X (exit 0) before D, at most `limit` bytes | `Ok(bytes)` | leftovers killed |
//! | E, then X with a nonzero exit or a signal | `ExitStatus` | leftovers killed |
//! | E, but the program still runs at D | `Timeout` | killed |
//! | X, but a helper holds stdout at D | `Timeout` | killed |
//! | neither by D | `Timeout` | killed |
//! | more than `limit` bytes | `OutputTooLarge` | killed at once |
//! | C at any point | `Cancelled` | killed at once |
//! | the program cannot start | `Spawn` | none |
//! | no pipe, no budget (too many runs, or too many stuck children) | `Resources` | killed / refused |
//!
//! # The one exit path
//! Every path after spawn goes through [`finish`]: wait (until the deadline
//! or a cancel) for the direct child to exit without reaping it where the
//! platform allows, `SIGKILL` its whole process group and the direct child
//! itself (a child that left its group is still ours to kill), then reap it
//! for at most [`REAP_GRACE`]. A child that survives even that (blocked in
//! uninterruptible sleep) is handed to a detached reaper thread; the call
//! still returns within about `timeout + REAP_GRACE`.
//!
//! # Budget
//! One [`Budget`], one lock, one admission point ([`admit`]): a run holds a
//! permit from before it spawns until it is fully finished, and a stuck
//! child keeps its permit until it is reaped. At most [`MAX_RUNS`] permits
//! exist, and while [`LINGERING_MAX`] children are stuck no new run is
//! admitted (`Resources`). Stuck children can therefore exceed
//! [`LINGERING_MAX`] only by runs that were already in flight when the cap
//! was reached, and never [`MAX_RUNS`] in all. On Unix the run thread reads
//! stdout itself (non-blocking, polled), so no thread or descriptor outlives
//! a run; a helper that left the group holding the pipe cannot leak either.
//!
//! Windows assigns each suspended child to a job object before it can run.
//! Terminating the job kills the whole tree, including detached helpers and
//! helpers whose root already exited. Owner drop also terminates leftovers,
//! and closing the last job handle kills the tree even on abrupt CLI exit.
//!
//! # Daemon exit
//! Each live run's process group is in a process-wide registry.
//! [`kill_all_active`] (called on the first shutdown signal and by `main` before it exits) kills them all
//! (under the registry lock on Unix, so a group is never signalled after
//! its run reaped it) and refuses later runs: the shutdown check happens
//! before anything is spawned, and shutdown waits for runs that are already
//! mid-spawn (each kills its own group at registration), so an exiting daemon does not orphan the group of
//! a command that was running. A panic in a release build (which aborts)
//! ends the runs in flight first ([`kill_all_active_for_panic`], installed by
//! `main`). On Unix, `SIGKILL` of the daemon itself cannot be caught and can
//! leave a command running until it exits by itself.

#[cfg(windows)]
use crate::job_tree::{Child, JobTree};
#[cfg(windows)]
use std::collections::BTreeMap;
#[cfg(not(windows))]
use std::collections::BTreeSet;
/// Registered with the subreaper, so its scan never reaps the run's child.
#[cfg(not(windows))]
type Child = crate::subreaper::Owned<std::process::Child>;
use std::process::{ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// How long the reap after the group kill may take before the child is left
/// to a detached reaper thread.
pub const REAP_GRACE: Duration = Duration::from_millis(1_000);
/// Children that survived the kill and are still being reaped. At this many,
/// new runs are refused.
pub const LINGERING_MAX: usize = 8;
/// Runs in flight plus stuck children, all counted against one budget. Above
/// the scheduler's bound of 50 custom sources plus the built-in telemetry.
pub const MAX_RUNS: usize = 64;
/// How often the wait loops check the deadline and the cancel flag.
const POLL: Duration = Duration::from_millis(25);
const REAP_POLL: Duration = Duration::from_millis(5);
/// How long shutdown waits for runs that are mid-spawn.
const SHUTDOWN_SPAWN_WAIT: Duration = Duration::from_secs(1);

/// Why a run produced no output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunError {
    /// The program could not be started (not installed, not executable).
    Spawn,
    /// The deadline passed before the run completed.
    Timeout,
    /// stdout was longer than the limit.
    OutputTooLarge,
    /// The program exited nonzero or was ended by a signal.
    ExitStatus,
    /// The caller cancelled, or the daemon is exiting.
    Cancelled,
    /// A local resource is missing (no stdout pipe, no thread, or too many
    /// children stuck from earlier runs); nothing was started or it was
    /// killed at once.
    Resources,
}

/// The one budget. `held` counts permits (a run in flight, or a stuck child
/// still being reaped); `stuck` counts the latter.
struct Budget {
    held: usize,
    stuck: usize,
}

static BUDGET: Mutex<Budget> = Mutex::new(Budget { held: 0, stuck: 0 });

/// One run's claim on a budget; released on drop (or moved to a reaper).
struct Permit(&'static Mutex<Budget>);

fn lock(budget: &'static Mutex<Budget>) -> std::sync::MutexGuard<'static, Budget> {
    budget.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The only admission check: atomically reserve a permit, or refuse.
fn admit() -> Option<Permit> {
    admit_in(&BUDGET)
}

fn admit_in(shared: &'static Mutex<Budget>) -> Option<Permit> {
    let mut budget = lock(shared);
    if budget.stuck >= LINGERING_MAX || budget.held >= MAX_RUNS {
        return None;
    }
    budget.held += 1;
    Some(Permit(shared))
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut budget = lock(self.0);
        budget.held = budget.held.saturating_sub(1);
    }
}

#[cfg(windows)]
type Groups = BTreeMap<u64, JobTree>;
#[cfg(not(windows))]
type Groups = BTreeSet<u32>;

#[derive(Default)]
struct Registry {
    closed: bool,
    groups: Groups,
    /// Runs between the shutdown check and their registration: shutdown
    /// waits for them, so none can start a command it never signals.
    spawning: usize,
    #[cfg(windows)]
    next_token: u64,
}

static ACTIVE: Mutex<Registry> = Mutex::new(Registry {
    closed: false,
    groups: Groups::new(),
    spawning: 0,
    #[cfg(windows)]
    next_token: 0,
});

fn lock_registry(shared: &'static Mutex<Registry>) -> std::sync::MutexGuard<'static, Registry> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    lock_registry(&ACTIVE)
}

/// The shutdown check that comes BEFORE anything is spawned: `false` when
/// the process is already exiting (nothing is started). On `true` the run
/// is counted as spawning until [`register`] or [`spawn_failed`].
fn begin_spawn() -> bool {
    begin_spawn_in(&ACTIVE)
}

fn begin_spawn_in(shared: &'static Mutex<Registry>) -> bool {
    let mut registry = lock_registry(shared);
    if registry.closed {
        return false;
    }
    registry.spawning += 1;
    true
}

fn spawn_failed() {
    let mut registry = registry();
    registry.spawning = registry.spawning.saturating_sub(1);
}

/// Record a live run. `false` when the process began exiting after
/// [`begin_spawn`]: the group is killed here (under the lock on Unix, so
/// `kill_all_active` never returns before it), and the caller gives up.
#[cfg(unix)]
fn register(pid: u32) -> bool {
    register_in(&ACTIVE, pid)
}

#[cfg(unix)]
fn register_in(shared: &'static Mutex<Registry>, pid: u32) -> bool {
    let mut registry = lock_registry(shared);
    registry.spawning = registry.spawning.saturating_sub(1);
    if registry.closed {
        #[cfg(unix)]
        kill_run(pid);
        return false;
    }
    registry.groups.insert(pid);
    true
}

#[cfg(not(windows))]
fn unregister(pid: u32) {
    registry().groups.remove(&pid);
}

/// Ownership: the run owns the child and the registry owns a job handle clone
/// until termination succeeds, including a pending reaper handoff. Lock order
/// on Windows: release the registry before touching
/// a job. No job operation acquires the registry or budget lock. Job operations
/// hold their lock only for nonblocking OS calls, never for a wait or pipe read.
#[cfg(windows)]
fn register_job_in(shared: &'static Mutex<Registry>, job: JobTree) -> Option<JobRegistration> {
    let mut registry = lock_registry(shared);
    let token = registry.next_token.checked_add(1);
    if registry.closed || token.is_none() {
        // Exhaustion must fail closed rather than wrap and reuse an identity.
        registry.closed = true;
        drop(registry);
        kill_group(&job);
        // Keep this run counted as spawning until its job has been signalled.
        lock_registry(shared).spawning -= 1;
        return None;
    }
    let token = token?;
    registry.next_token = token;
    registry.groups.insert(token, job);
    registry.spawning -= 1;
    Some(JobRegistration { shared, token })
}

/// A run's identity, independent of its cached diagnostic PID. This guard
/// moves to the reaper on a pending kill, so shutdown can still reach the job.
#[cfg(windows)]
struct JobRegistration {
    shared: &'static Mutex<Registry>,
    token: u64,
}

#[cfg(windows)]
impl Drop for JobRegistration {
    fn drop(&mut self) {
        lock_registry(self.shared).groups.remove(&self.token);
    }
}

/// Shutdown and panic share one deadline for lock retries across every job.
/// A stuck lock cannot block shutdown, nor prevent signalling accessible jobs.
#[cfg(windows)]
fn close_jobs_in(shared: &'static Mutex<Registry>, until: Instant) -> bool {
    let Ok(mut registry) = crate::job_tree::lock_until(shared, until) else {
        return false;
    };
    registry.closed = true;
    // Retain handles until each owner unregisters: shutdown never relies on a
    // recycled PID, and panic/abort still closes every live kernel job handle.
    let jobs = registry.groups.values().cloned().collect::<Vec<_>>();
    let spawning = registry.spawning;
    drop(registry);
    for job in jobs {
        let _ = job.terminate_until(until);
    }
    spawning == 0
}

#[cfg(windows)]
fn kill_all_for_panic_in(shared: &'static Mutex<Registry>) {
    close_jobs_in(shared, Instant::now() + Duration::from_millis(200));
}

#[cfg(windows)]
fn kill_all_in(shared: &'static Mutex<Registry>) {
    let until = Instant::now() + SHUTDOWN_SPAWN_WAIT;
    while !close_jobs_in(shared, until) && Instant::now() < until {
        thread::sleep(Duration::from_millis(2));
    }
}

/// Runs in flight (registered and not yet finished).
pub fn active_runs() -> usize {
    registry().groups.len()
}

/// Kill the process group of every run in flight and refuse later runs. Call
/// on every path that ends the process. Idempotent, and safe to call from any
/// thread; it waits (at most [`SHUTDOWN_SPAWN_WAIT`]) for runs that are
/// mid-spawn, so it returns only once nothing it could have started is left.
pub fn kill_all_active() {
    kill_all_in(&ACTIVE);
}

/// The panic-hook variant of [`kill_all_active`]: never blocks (a panic may
/// come from a thread that holds the registry lock, and waiting for mid-spawn
/// runs is pointless when the process is about to abort). It closes the
/// registry and kills what it can reach without waiting for the lock.
pub fn kill_all_active_for_panic() {
    kill_all_for_panic_in(&ACTIVE);
}

#[cfg(unix)]
fn kill_all_for_panic_in(shared: &'static Mutex<Registry>) {
    let mut registry = match shared.try_lock() {
        Ok(registry) => registry,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        // Held by another thread: it is between two statements of a
        // registry operation, so retry briefly rather than block.
        Err(std::sync::TryLockError::WouldBlock) => {
            let until = Instant::now() + Duration::from_millis(200);
            loop {
                if let Ok(registry) = shared.try_lock() {
                    break registry;
                }
                if Instant::now() >= until {
                    return;
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
    };
    registry.closed = true;
    let groups = std::mem::take(&mut registry.groups);
    #[cfg(unix)]
    for pid in groups {
        kill_run(pid);
    }
}

#[cfg(unix)]
fn kill_all_in(shared: &'static Mutex<Registry>) {
    {
        let mut registry = lock_registry(shared);
        registry.closed = true;
        let groups = std::mem::take(&mut registry.groups);
        // Unix: `killpg` is a non-blocking syscall, and `finish` unregisters
        // (under this lock) before it reaps, so no signalled id can have been
        // reaped and recycled.
        #[cfg(unix)]
        for pid in groups {
            kill_run(pid);
        }
    }
    // A run past its shutdown check but not yet registered is killed by its
    // own `register`; wait (bounded) until every such run has passed it.
    let until = Instant::now() + SHUTDOWN_SPAWN_WAIT;
    while lock_registry(shared).spawning > 0 && Instant::now() < until {
        thread::sleep(Duration::from_millis(2));
    }
}

/// Run `program` with the limits above and return its stdout.
///
/// `cancel`, when set, ends the run at the next poll (a few milliseconds),
/// including while it waits for the program to exit after stdout closed.
pub fn run(
    program: &str,
    args: &[String],
    timeout: Duration,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, RunError> {
    let deadline = Instant::now() + timeout;
    run_inner(program, args, deadline, limit, cancel, None, false, &[])
}

/// Total budget variant: settlement shares the caller's absolute deadline.
/// Pending reaping retains its permit and can never return a success verdict.
pub fn run_until(
    program: &str,
    args: &[String],
    deadline: Instant,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, RunError> {
    run_inner(
        program,
        args,
        deadline,
        limit,
        cancel,
        Some(deadline),
        false,
        &[],
    )
}

/// [`run_until`] with extra environment on top of the scrubbed parent
/// environment (runtime commands: node secrets). Never log `env`.
pub fn run_until_env(
    program: &str,
    args: &[String],
    deadline: Instant,
    limit: usize,
    cancel: Option<&AtomicBool>,
    env: &[(String, String)],
) -> Result<Vec<u8>, RunError> {
    run_inner(
        program,
        args,
        deadline,
        limit,
        cancel,
        Some(deadline),
        false,
        env,
    )
}

/// [`run_until`] for programs that report through stdout and their exit
/// status at once (`systemctl is-system-running` prints `degraded` and exits
/// 1): stdout is returned whatever the exit status, never `ExitStatus`. Every
/// other failure (spawn, timeout, size, cancel) is still an error.
pub fn run_until_any_status(
    program: &str,
    args: &[String],
    deadline: Instant,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, RunError> {
    run_inner(
        program,
        args,
        deadline,
        limit,
        cancel,
        Some(deadline),
        true,
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
fn run_inner(
    program: &str,
    args: &[String],
    deadline: Instant,
    limit: usize,
    cancel: Option<&AtomicBool>,
    settlement: Option<Instant>,
    any_status: bool,
    extra_env: &[(String, String)],
) -> Result<Vec<u8>, RunError> {
    let cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::SeqCst));
    if cancelled() {
        return Err(RunError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(RunError::Timeout);
    }
    // The one admission point: reserved before anything is spawned.
    let Some(permit) = admit() else {
        return Err(RunError::Resources);
    };
    // Shutdown check first: after `kill_all_active` nothing is started.
    if !begin_spawn() {
        return Err(RunError::Cancelled);
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(crate::child_env::scrub_parent_env(&[]))
        .envs(
            extra_env
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Never read, never uploaded.
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so the deadline kills everything it started.
        command.process_group(0);
    }
    if cancelled() || Instant::now() >= deadline {
        spawn_failed();
        return Err(if cancelled() {
            RunError::Cancelled
        } else {
            RunError::Timeout
        });
    }
    #[cfg(not(windows))]
    let mut child = match crate::subreaper::spawn(|| command.spawn(), |child| Some(child.id())) {
        Ok(child) => child,
        Err(_) => {
            spawn_failed();
            return Err(RunError::Spawn);
        }
    };
    #[cfg(windows)]
    let mut child = match crate::job_tree::spawn(command) {
        Ok(child) => child,
        Err(_) => {
            spawn_failed();
            return Err(RunError::Spawn);
        }
    };
    #[cfg(not(windows))]
    let pid = child.id();
    #[cfg(not(windows))]
    let registered = register(pid);
    #[cfg(windows)]
    let registration = register_job_in(&ACTIVE, child.job());
    #[cfg(windows)]
    let registered = registration.is_some();
    #[cfg(windows)]
    let finish = |child, until, permit, cancelled: &dyn Fn() -> bool| {
        finish_job_until(child, until, permit, cancelled, registration, settlement)
    };
    #[cfg(not(windows))]
    let finish = |child, until, permit, cancelled: &dyn Fn() -> bool| {
        finish_until(child, until, permit, cancelled, settlement)
    };
    if !registered {
        finish(child, Instant::now(), permit, &|| true);
        return Err(RunError::Cancelled);
    }
    let Some(stdout) = child.stdout.take() else {
        finish(child, Instant::now(), permit, &|| true);
        return Err(RunError::Resources);
    };
    // The pipe is dropped inside `collect`, so nothing holds it after this.
    let output = match collect(stdout, deadline, limit, &cancelled) {
        Collected::Output(buffer) => Some(buffer),
        Collected::Unfinished => None,
        Collected::Resources => {
            finish(child, Instant::now(), permit, &|| true);
            return Err(RunError::Resources);
        }
    };
    let over_limit = output.as_ref().is_some_and(|buffer| buffer.len() > limit);
    // Refused output, a missing pipe result or a cancel: do not wait for exit.
    let wait_until = if output.is_some() && !over_limit && !cancelled() {
        deadline
    } else {
        Instant::now()
    };
    let finished = finish(child, wait_until, permit, &cancelled);
    if cancelled() {
        return Err(RunError::Cancelled);
    }
    if settlement.is_some() && Instant::now() >= deadline {
        return Err(RunError::Timeout);
    }
    let Some(buffer) = output else {
        return Err(RunError::Timeout);
    };
    if over_limit {
        return Err(RunError::OutputTooLarge);
    }
    if !finished.exited {
        return Err(RunError::Timeout);
    }
    match finished.status {
        Some(status) if status.success() || any_status => Ok(buffer),
        Some(_) => Err(RunError::ExitStatus),
        // Exited but never reaped in the grace: no verdict on its status.
        None => Err(RunError::Timeout),
    }
}

/// How reading stdout ended.
enum Collected {
    /// The pipe closed (or more than `limit` bytes arrived: the buffer is
    /// then longer than `limit`).
    Output(Vec<u8>),
    /// The deadline passed or the caller cancelled first.
    Unfinished,
    /// The pipe could not be read (no thread, no polling).
    Resources,
}

/// Read stdout until it closes, exceeds `limit`, the deadline passes or the
/// caller cancels. Consumes the pipe, so it is closed when this returns.
///
/// Unix: the calling thread polls a non-blocking descriptor; there is no
/// reader thread that a helper holding the pipe could pin.
#[cfg(unix)]
fn collect(
    mut stdout: ChildStdout,
    deadline: Instant,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> Collected {
    use std::io::{ErrorKind, Read};
    use std::os::fd::AsFd;

    use nix::errno::Errno;
    use nix::fcntl::{FcntlArg, OFlag, fcntl};
    use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

    let Ok(flags) = fcntl(stdout.as_fd(), FcntlArg::F_GETFL) else {
        return Collected::Resources;
    };
    let nonblocking = OFlag::from_bits_retain(flags) | OFlag::O_NONBLOCK;
    if fcntl(stdout.as_fd(), FcntlArg::F_SETFL(nonblocking)).is_err() {
        return Collected::Resources;
    }
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        if cancelled() {
            return Collected::Unfinished;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Collected::Unfinished;
        }
        let wait = remaining.min(POLL);
        let millis = u16::try_from(wait.as_millis()).unwrap_or(u16::MAX);
        let ready = {
            let mut fds = [PollFd::new(stdout.as_fd(), PollFlags::POLLIN)];
            poll(&mut fds, PollTimeout::from(millis))
        };
        match ready {
            Ok(0) | Err(Errno::EINTR) => continue,
            Ok(_) => {}
            Err(_) => return Collected::Resources,
        }
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => return Collected::Output(buffer),
                Ok(read) => {
                    buffer.extend_from_slice(&chunk[..read]);
                    if buffer.len() > limit {
                        return Collected::Output(buffer);
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                // A broken pipe end is the end of the output.
                Err(_) => return Collected::Output(buffer),
            }
        }
    }
}

/// Windows has no pollable pipe here: a reader thread owns the pipe and the
/// result arrives on a channel, so a leaked pipe never blocks the caller
/// (terminating the Windows job at the deadline closes every writer).
#[cfg(not(unix))]
fn collect(
    stdout: ChildStdout,
    deadline: Instant,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> Collected {
    use std::io::Read;
    use std::sync::mpsc::{self, RecvTimeoutError};

    let (done_tx, done_rx) = mpsc::channel();
    let reader = thread::Builder::new()
        .name("wsmp-bounded-read".to_string())
        .spawn(move || {
            let mut buffer = Vec::new();
            let _ = stdout
                .take((limit as u64).saturating_add(1))
                .read_to_end(&mut buffer);
            let _ = done_tx.send(buffer);
        });
    if reader.is_err() {
        return Collected::Resources;
    }
    loop {
        if cancelled() {
            return Collected::Unfinished;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Collected::Unfinished;
        }
        match done_rx.recv_timeout(remaining.min(POLL)) {
            Ok(buffer) => return Collected::Output(buffer),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Collected::Unfinished,
        }
    }
}

/// What [`finish`] learned.
struct Finished {
    /// The program exited on its own before `until` (it was not killed for
    /// running too long).
    exited: bool,
    /// Its status, when it was reaped within [`REAP_GRACE`].
    status: Option<ExitStatus>,
}

/// The one exit path after spawn: wait until `until` (or a cancel) for the
/// child to exit (unreaped where the platform allows), kill every process
/// left in its group and the child itself, drop the run from the registry,
/// then reap the child for at most [`REAP_GRACE`]; a child that is still not
/// reaped goes to a detached reaper thread that keeps the run's permit.
///
/// On Linux the wait uses `waitid(WNOWAIT)`, so the child stays a zombie and
/// its pid (the group id) cannot be recycled before the kills. Other
/// Unix targets reap first: POSIX does not reuse a pid while a process group
/// with that id has members, so a surviving helper keeps the id safe; with no
/// helper left the kill can only miss (a recycled pid would also have to have
/// become a group leader in the microseconds between).
#[cfg(not(windows))]
fn finish_until(
    mut child: Child,
    until: Instant,
    permit: Permit,
    cancelled: &dyn Fn() -> bool,
    settlement: Option<Instant>,
) -> Finished {
    let exited = wait_for_exit(&mut child, until, cancelled);
    let pid = child.id();
    kill_group_or_child(&mut child);
    // Off the registry before the reap: the registry never names a pid that
    // has been reaped (and could be reused).
    unregister(pid);
    // A child that already exited keeps the status it exited with; SIGKILL
    // cannot change it. std caches a status `try_wait` already reaped.
    let status = reap_within(
        &mut child,
        settlement.unwrap_or_else(|| Instant::now() + REAP_GRACE),
    );
    if status.is_none() {
        hand_off_to_reaper(child, permit);
    }
    Finished { exited, status }
}

/// Windows settlement uses one grace deadline for termination and reaping.
/// A busy lock is inconclusive: keep both the registration and permit with
/// the cleanup owner until the pending job kill is actually issued.
#[cfg(windows)]
#[cfg(test)]
fn finish_job(
    child: Child,
    until: Instant,
    permit: Permit,
    cancelled: &dyn Fn() -> bool,
    registration: Option<JobRegistration>,
) -> Finished {
    finish_job_until(child, until, permit, cancelled, registration, None)
}

#[cfg(windows)]
fn finish_job_until(
    mut child: Child,
    until: Instant,
    permit: Permit,
    cancelled: &dyn Fn() -> bool,
    registration: Option<JobRegistration>,
    settlement: Option<Instant>,
) -> Finished {
    let exited = wait_for_exit(&mut child, until, cancelled);
    let reap_until = settlement.unwrap_or_else(|| Instant::now() + REAP_GRACE);
    if !child.ensure_terminated(reap_until) {
        hand_off_job_to_reaper(child, permit, registration);
        return Finished {
            exited,
            status: None,
        };
    }
    drop(registration);
    let status = reap_within(&mut child, reap_until);
    if status.is_none() {
        hand_off_job_to_reaper(child, permit, None);
    }
    Finished { exited, status }
}

fn reap_within(child: &mut Child, until: Instant) -> Option<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            #[cfg(windows)]
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
            {
                thread::sleep(REAP_POLL);
            }
            Ok(None) if Instant::now() < until => thread::sleep(REAP_POLL),
            _ => return None,
        }
    }
}

/// Wait for a child that survived both kills (uninterruptible sleep) on a
/// detached thread so it does not stay a zombie. The thread ends when the
/// child finally dies; until then the run's permit stays held and the child
/// counts as stuck.
#[cfg(not(windows))]
fn hand_off_to_reaper(mut child: Child, permit: Permit) {
    lock(permit.0).stuck += 1;
    let shared = permit.0;
    let spawned = thread::Builder::new()
        .name("wsmp-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
            {
                let mut budget = lock(shared);
                budget.stuck = budget.stuck.saturating_sub(1);
            }
            drop(permit);
        });
    if spawned.is_err() {
        // The child (dropped with the closure) is not reaped; nothing more
        // can be done without a thread.
        let mut budget = lock(shared);
        budget.stuck = budget.stuck.saturating_sub(1);
    }
}

#[cfg(windows)]
fn hand_off_job_to_reaper(mut child: Child, permit: Permit, registration: Option<JobRegistration>) {
    lock(permit.0).stuck += 1;
    let shared = permit.0;
    let spawned = thread::Builder::new()
        .name("wsmp-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
            // wait retries termination before observing even a cached exit.
            // Drop the child before the guard on errors or thread failure,
            // leaving kill-on-close as the fallback for the owned wrapper.
            drop(child);
            drop(registration);
            {
                let mut budget = lock(shared);
                budget.stuck = budget.stuck.saturating_sub(1);
            }
            drop(permit);
        });
    if spawned.is_err() {
        let mut budget = lock(shared);
        budget.stuck = budget.stuck.saturating_sub(1);
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    if raw <= 1 {
        return;
    }
    // ESRCH (the group is already gone) is fine.
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(raw),
        nix::sys::signal::Signal::SIGKILL,
    );
}

/// Everything a registered run started: its group AND the direct child by pid
/// (it may have left the group). On Linux a registered run is still an
/// unreaped zombie or live process (`waitid(WNOWAIT)` in `finish`), so its
/// pid cannot have been recycled. Other Unix targets reap first, so this
/// widens the accepted G1-2 window (a recycled pid, in the microseconds
/// between the reap and `unregister`) from the group kill to this one.
#[cfg(unix)]
fn kill_run(pid: u32) {
    kill_group(pid);
    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    if raw > 1 {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(raw),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

#[cfg(windows)]
fn kill_group(job: &JobTree) {
    let _ = job.terminate();
}

/// Kill everything the run started: the group, then the direct child itself
/// (it may have left the group; while unreaped its pid cannot be recycled,
/// and `Child::kill` is a no-op once std has reaped it).
#[cfg(unix)]
fn kill_group_or_child(child: &mut Child) {
    kill_group(child.id());
    let _ = child.kill();
}

/// Poll until the child has exited, `until` passes or the caller cancels,
/// leaving it unreaped. True when it exited.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn wait_for_exit(child: &mut Child, until: Instant, cancelled: &dyn Fn() -> bool) -> bool {
    use nix::sys::wait::{Id, WaitPidFlag, WaitStatus, waitid};
    let Ok(raw) = i32::try_from(child.id()) else {
        return false;
    };
    let flags = WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT;
    loop {
        match waitid(Id::Pid(nix::unistd::Pid::from_raw(raw)), flags) {
            Ok(WaitStatus::StillAlive) if Instant::now() < until && !cancelled() => {
                thread::sleep(REAP_POLL);
            }
            Ok(WaitStatus::StillAlive) => return false,
            _ => return true,
        }
    }
}

/// Poll until the child has exited, `until` passes or the caller cancels
/// (this reaps; see [`finish`]). True when it exited.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn wait_for_exit(child: &mut Child, until: Instant, cancelled: &dyn Fn() -> bool) -> bool {
    loop {
        match child.try_wait() {
            #[cfg(windows)]
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= until || cancelled() {
                    return false;
                }
                thread::sleep(REAP_POLL);
            }
            Ok(None) if Instant::now() < until && !cancelled() => thread::sleep(REAP_POLL),
            Ok(None) => return false,
            _ => return true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn fresh_job_registry() -> &'static Mutex<Registry> {
        Box::leak(Box::new(Mutex::new(Registry::default())))
    }

    #[cfg(windows)]
    fn job_tree(tree: &crate::windows_test_tree::Tree) -> Child {
        let mut command = Command::new("cmd");
        command.args(tree.command("hang"));
        crate::job_tree::spawn(command).expect("job spawn")
    }

    #[cfg(windows)]
    fn held_job(job: JobTree) -> (std::sync::mpsc::Sender<()>, thread::JoinHandle<()>) {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = thread::spawn(move || {
            job.with_job_lock(|| {
                ready_tx.send(()).expect("lock notification");
                release_rx
                    .recv_timeout(Duration::from_secs(20))
                    .expect("release lock");
            });
            // Deliberately no kill here: cleanup must issue its own kill.
        });
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("held job lock");
        (release_tx, holder)
    }

    #[cfg(windows)]
    #[test]
    fn windows_busy_exit_observations_are_inconclusive() {
        use crate::windows_test_tree::Tree;
        // Release rows fail on the old wildcard matches. Deadline/cancel
        // rows pin bounded waiting rather than an unbounded lock acquisition.
        for row in [
            "wait-release",
            "reap-release",
            "wait-deadline",
            "wait-cancel",
        ] {
            let tree = Tree::new();
            let mut command = Command::new("cmd");
            command.args(tree.command(if row.ends_with("release") {
                "success"
            } else {
                "hang"
            }));
            let mut child = crate::job_tree::spawn(command).expect("job spawn");
            tree.read_marker();
            if row.ends_with("release") {
                assert!(wait_for_exit(
                    &mut child,
                    Instant::now() + Duration::from_secs(5),
                    &|| false
                ));
            }
            let (release, holder) = held_job(child.job());
            thread::scope(|scope| {
                let (done_tx, done_rx) = std::sync::mpsc::channel();
                let child = &mut child;
                scope.spawn(move || {
                    let until = Instant::now() + Duration::from_millis(150);
                    let observed = if row == "reap-release" {
                        reap_within(child, until).is_some()
                    } else {
                        wait_for_exit(child, until, &|| row == "wait-cancel")
                    };
                    done_tx.send(observed).expect("observation result");
                });
                if row.ends_with("release") {
                    assert!(
                        done_rx.recv_timeout(Duration::from_millis(50)).is_err(),
                        "{row}: busy is not exited"
                    );
                    release.send(()).expect("release");
                    assert!(
                        done_rx
                            .recv_timeout(Duration::from_secs(1))
                            .expect("observed exit"),
                        "{row}"
                    );
                } else {
                    assert!(
                        !done_rx
                            .recv_timeout(Duration::from_secs(1))
                            .expect("bounded observation"),
                        "{row}"
                    );
                    release.send(()).expect("release");
                }
            });
            holder.join().expect("lock holder");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_run_contention_keeps_cleanup_owned_and_retries_termination() {
        use crate::windows_test_tree::{Tree, assert_dead, process_exists};
        // EOF fails on premature Timeout. Short timeout/cancel rows require
        // kill before settlement; long rows require a registered, charged
        // pending owner and a kill after unlock without help from the holder.
        for (path, pending_handoff) in [
            ("eof", false),
            ("timeout", false),
            ("cancel", false),
            ("timeout", true),
            ("cancel", true),
        ] {
            let tree = Tree::new();
            let cancel = AtomicBool::new(false);
            let timeout = if path == "timeout" {
                Duration::from_secs(4)
            } else {
                Duration::from_secs(30)
            };
            let args = tree.command(if path == "eof" { "eof" } else { "detach" });
            let run_started = Instant::now();
            thread::scope(|scope| {
                let (done_tx, done_rx) = std::sync::mpsc::channel();
                let args = &args;
                let cancel = &cancel;
                scope.spawn(move || {
                    done_tx
                        .send(run("python", &args[2..], timeout, 1024, Some(cancel)))
                        .expect("run result");
                });
                let grandchild = tree.read_marker().parse().expect("grandchild PID");
                let root = std::fs::read_to_string(&tree.root)
                    .expect("root PID")
                    .trim()
                    .parse::<u32>()
                    .expect("root PID");
                let (token, job) = {
                    let registry = registry();
                    registry
                        .groups
                        .iter()
                        .find(|(_, job)| job.id() == root)
                        .map(|(token, job)| (*token, job.clone()))
                        .expect("run registered in ACTIVE")
                };
                let (release, holder) = held_job(job);
                let mut holder = Some(holder);
                let started = Instant::now();
                if path == "eof" {
                    std::fs::write(tree.root.with_extension("eof"), "").expect("close stdout");
                    assert!(
                        done_rx.recv_timeout(REAP_GRACE * 2).is_err(),
                        "EOF settled before its deadline under contention"
                    );
                    assert!(registry().groups.contains_key(&token));
                    release.send(()).expect("release");
                    holder.take().expect("holder").join().expect("lock holder");
                    std::fs::write(tree.root.with_extension("exit"), "")
                        .expect("allow natural exit");
                    assert_eq!(
                        done_rx
                            .recv_timeout(Duration::from_secs(5))
                            .expect("EOF result"),
                        Ok(Vec::new())
                    );
                } else {
                    if path == "cancel" {
                        cancel.store(true, Ordering::SeqCst);
                    } else {
                        // The deadline runs from run() entry, not from fixture startup.
                        thread::sleep(timeout.saturating_sub(run_started.elapsed()));
                    }
                    if !pending_handoff {
                        assert!(
                            done_rx.recv_timeout(REAP_GRACE / 2).is_err(),
                            "{path}: settled before kill with a live tree"
                        );
                        release.send(()).expect("release");
                        holder.take().expect("holder").join().expect("lock holder");
                    }
                    let result = done_rx
                        .recv_timeout(REAP_GRACE + Duration::from_secs(2))
                        .expect("bounded run result");
                    assert_eq!(
                        result,
                        Err(if path == "cancel" {
                            RunError::Cancelled
                        } else {
                            RunError::Timeout
                        })
                    );
                    assert!(
                        started.elapsed()
                            < timeout.min(Duration::from_secs(4))
                                + REAP_GRACE
                                + Duration::from_secs(2)
                    );
                    if pending_handoff {
                        assert!(
                            registry().groups.contains_key(&token),
                            "pending tree hidden from shutdown"
                        );
                        assert!(lock(&BUDGET).stuck > 0, "pending child lost its permit");
                        assert!(process_exists(root) && process_exists(grandchild));
                        release.send(()).expect("release");
                        holder.take().expect("holder").join().expect("lock holder");
                    }
                }
                assert_dead(root);
                assert_dead(grandchild);
                let until = Instant::now() + Duration::from_secs(2);
                while registry().groups.contains_key(&token) {
                    assert!(
                        Instant::now() < until,
                        "registration not released after termination"
                    );
                    thread::sleep(REAP_POLL);
                }
            });
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_registration_identity_survives_a_recycled_root_pid() {
        use crate::windows_test_tree::{Tree, assert_dead};
        // Both states would overwrite/remove B on the old PID-keyed map.
        for root_reaped in [false, true] {
            let shared = fresh_job_registry();
            let first_tree = Tree::new();
            let second_tree = Tree::new();
            let mut command = Command::new("cmd");
            command.args(first_tree.command(if root_reaped { "success" } else { "hang" }));
            let mut first = crate::job_tree::spawn(command).expect("first job");
            let first_grandchild = first_tree
                .read_marker()
                .parse()
                .expect("first grandchild PID");
            assert!(begin_spawn_in(shared));
            let first_registration =
                register_job_in(shared, first.job()).expect("first registration");
            if root_reaped {
                assert!(wait_for_exit(
                    &mut first,
                    Instant::now() + Duration::from_secs(5),
                    &|| false
                ));
            }
            let second = job_tree(&second_tree);
            let second_grandchild = second_tree
                .read_marker()
                .parse()
                .expect("second grandchild PID");
            assert_eq!(second.job().id(), second.id(), "default diagnostic PID");
            assert!(begin_spawn_in(shared));
            let reused_pid_job = second.job().with_test_pid(first.id());
            assert_eq!(reused_pid_job.id(), first.id(), "forced PID reuse seam");
            let second_registration =
                register_job_in(shared, reused_pid_job).expect("second registration");
            assert_ne!(first_registration.token, second_registration.token);
            assert_eq!(
                lock_registry(shared).groups.len(),
                2,
                "insertion replaced a live registration"
            );
            let permit = admit_in(fresh()).expect("permit");
            finish_job(
                first,
                Instant::now(),
                permit,
                &|| true,
                Some(first_registration),
            );
            assert_dead(first_grandchild);
            assert_eq!(lock_registry(shared).groups.len(), 1);
            assert!(
                lock_registry(shared)
                    .groups
                    .contains_key(&second_registration.token)
            );
            kill_all_in(shared);
            assert_dead(second.id());
            assert_dead(second_grandchild);
            drop(second);
            drop(second_registration);
            assert!(lock_registry(shared).groups.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_pending_termination_precedes_even_a_cached_root_exit() {
        use crate::windows_test_tree::{Tree, assert_dead, process_exists};
        for root_reaped in [false, true] {
            let tree = Tree::new();
            let shared = fresh_job_registry();
            let budget = fresh();
            let mut command = Command::new("cmd");
            command.args(tree.command(if root_reaped { "success" } else { "hang" }));
            let mut child = crate::job_tree::spawn(command).expect("job spawn");
            let grandchild = tree.read_marker().parse().expect("grandchild PID");
            if root_reaped {
                assert!(wait_for_exit(
                    &mut child,
                    Instant::now() + Duration::from_secs(5),
                    &|| false
                ));
            }
            assert!(begin_spawn_in(shared));
            let registration = register_job_in(shared, child.job()).expect("registration");
            let (release, holder) = held_job(child.job());
            let started = Instant::now();
            let result = finish_job(
                child,
                Instant::now(),
                admit_in(budget).expect("permit"),
                &|| true,
                Some(registration),
            );
            assert!(started.elapsed() < REAP_GRACE + Duration::from_millis(500));
            assert!(result.status.is_none());
            assert_eq!(lock_registry(shared).groups.len(), 1);
            assert_eq!(lock(budget).held, 1);
            assert_eq!(lock(budget).stuck, 1);
            assert!(process_exists(grandchild));
            release.send(()).expect("release");
            holder.join().expect("lock holder");
            assert_dead(grandchild);
            let until = Instant::now() + Duration::from_secs(2);
            while lock(budget).held != 0 {
                assert!(
                    Instant::now() < until,
                    "cleanup permit retained after reaping"
                );
                thread::sleep(REAP_POLL);
            }
            assert_eq!(lock(budget).stuck, 0);
            assert!(lock_registry(shared).groups.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_registration_token_exhaustion_fails_closed() {
        let shared = fresh_job_registry();
        assert_eq!(lock_registry(shared).next_token, 0, "default token seed");
        lock_registry(shared).next_token = u64::MAX;
        assert!(begin_spawn_in(shared));
        let tree = crate::windows_test_tree::Tree::new();
        let child = job_tree(&tree);
        assert!(register_job_in(shared, child.job()).is_none());
        assert!(!begin_spawn_in(shared));
        assert!(lock_registry(shared).groups.is_empty());
        assert_eq!(lock_registry(shared).spawning, 0);
        crate::windows_test_tree::assert_dead(child.id());
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_and_panic_terminate_registered_jobs_from_another_thread() {
        use crate::windows_test_tree::{Tree, assert_dead};
        for panic_hook in [false, true] {
            let tree = Tree::new();
            let shared = fresh_job_registry();
            assert!(begin_spawn_in(shared));
            let child = job_tree(&tree);
            let grandchild = tree.read_marker().parse().expect("grandchild PID");
            let _registration = register_job_in(shared, child.job()).expect("registration");
            thread::spawn(move || {
                if panic_hook {
                    kill_all_for_panic_in(shared);
                } else {
                    kill_all_in(shared);
                }
            })
            .join()
            .expect("shutdown thread");
            assert_dead(grandchild);
            assert_dead(child.id());
            assert!(!begin_spawn_in(shared));
            // The owner is still live: its Drop did not cause the tree kill.
            drop(child);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_shutdown_waits_for_and_kills_a_run_mid_spawn() {
        use crate::windows_test_tree::{Tree, assert_dead};
        let tree = Tree::new();
        let shared = fresh_job_registry();
        assert!(begin_spawn_in(shared));
        let child = job_tree(&tree);
        let grandchild = tree.read_marker().parse().expect("grandchild PID");
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let exiting = thread::spawn(move || {
            kill_all_in(shared);
            done_tx.send(()).expect("shutdown notification");
        });
        let until = Instant::now() + SHUTDOWN_SPAWN_WAIT;
        while !lock_registry(shared).closed {
            assert!(Instant::now() < until, "shutdown did not close admission");
            thread::sleep(REAP_POLL);
        }
        assert!(done_rx.try_recv().is_err(), "shutdown missed mid-spawn run");
        assert!(register_job_in(shared, child.job()).is_none());
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("shutdown bounded");
        exiting.join().expect("shutdown thread");
        assert_dead(grandchild);
        assert_dead(child.id());
    }

    #[cfg(windows)]
    #[test]
    fn windows_shutdown_and_panic_never_block_on_a_held_registry_lock() {
        for panic_hook in [false, true] {
            let shared = fresh_job_registry();
            let guard = lock_registry(shared);
            let started = Instant::now();
            if panic_hook {
                kill_all_for_panic_in(shared);
            } else {
                kill_all_in(shared);
            }
            assert!(started.elapsed() < Duration::from_secs(2));
            drop(guard);
        }
    }

    fn fresh() -> &'static Mutex<Budget> {
        Box::leak(Box::new(Mutex::new(Budget { held: 0, stuck: 0 })))
    }

    #[test]
    fn concurrent_admission_never_exceeds_the_budget() {
        // Many threads race for permits at once: exactly MAX_RUNS win, the
        // rest are refused, and releasing one admits exactly one more.
        let shared = fresh();
        let barrier = std::sync::Barrier::new(MAX_RUNS * 2);
        let permits = std::thread::scope(|scope| {
            let handles = (0..MAX_RUNS * 2)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        admit_in(shared)
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().expect("admit thread"))
                .collect::<Vec<_>>()
        });
        assert_eq!(permits.len(), MAX_RUNS);
        assert!(admit_in(shared).is_none());
        let mut permits = permits;
        drop(permits.pop());
        assert!(admit_in(shared).is_some());
        drop(permits);
        assert_eq!(lock(shared).held, 0);
    }

    #[cfg(unix)]
    fn fresh_registry() -> &'static Mutex<Registry> {
        Box::leak(Box::new(Mutex::new(Registry {
            closed: false,
            groups: BTreeSet::new(),
            spawning: 0,
        })))
    }

    #[cfg(unix)]
    fn own_group_sleeper() -> Child {
        use std::os::unix::process::CommandExt;
        crate::subreaper::spawn(
            || Command::new("sleep").arg("30").process_group(0).spawn(),
            |child| Some(child.id()),
        )
        .expect("sleep")
    }

    /// A run that already passed the shutdown check but is not registered
    /// yet when the exit begins: shutdown must wait for it, and its own
    /// registration must kill its group (nothing it started outlives the
    /// exit). Deleting either the wait or the register-time kill fails this.
    #[cfg(unix)]
    #[test]
    fn a_run_mid_spawn_is_killed_by_its_registration_and_shutdown_waits_for_it() {
        let shared = fresh_registry();
        assert!(begin_spawn_in(shared));
        let mut child = own_group_sleeper();
        let pid = child.id();
        let exiting = thread::spawn(move || {
            let started = Instant::now();
            kill_all_in(shared);
            started.elapsed()
        });
        // Shutdown is now waiting for this run to register.
        thread::sleep(Duration::from_millis(300));
        assert!(child.try_wait().expect("try_wait").is_none());
        assert!(
            !register_in(shared, pid),
            "registration after the exit began must be refused"
        );
        let waited = exiting.join().expect("shutdown thread");
        assert!(
            waited >= Duration::from_millis(250),
            "shutdown returned before the mid-spawn run registered: {waited:?}"
        );
        // Killed by `register_in` itself: no `finish` ran for this child.
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.try_wait().expect("try_wait").is_none() {
            assert!(Instant::now() < deadline, "the mid-spawn child survived");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!begin_spawn_in(shared), "nothing starts after the exit");
    }

    /// A registered run whose direct child left its process group (here: it
    /// never had its own group, so `killpg(pid)` finds nothing) is still
    /// killed at exit: the registry kills the child by pid as well.
    #[cfg(unix)]
    #[test]
    fn exit_kills_a_registered_child_that_is_not_a_group_leader() {
        let shared = fresh_registry();
        assert!(begin_spawn_in(shared));
        // No `process_group(0)`: the child shares this test's group.
        let mut child = Command::new("sleep").arg("30").spawn().expect("sleep");
        assert!(register_in(shared, child.id()));
        kill_all_in(shared);
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.try_wait().expect("try_wait").is_none() {
            assert!(Instant::now() < deadline, "the registered child survived");
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// The panic hook kills registered runs without blocking, even while
    /// another thread holds the registry lock (it gives up rather than hang).
    #[cfg(unix)]
    #[test]
    fn the_panic_hook_kills_registered_runs_and_never_hangs_on_a_held_lock() {
        let shared = fresh_registry();
        assert!(begin_spawn_in(shared));
        let mut child = own_group_sleeper();
        assert!(register_in(shared, child.id()));
        kill_all_for_panic_in(shared);
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.try_wait().expect("try_wait").is_none() {
            assert!(Instant::now() < deadline, "the panic hook left a run alive");
            thread::sleep(Duration::from_millis(10));
        }
        // A lock held elsewhere: the hook returns within its bound.
        let held = fresh_registry();
        let guard = lock_registry(held);
        let started = Instant::now();
        kill_all_for_panic_in(held);
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(guard);
    }

    #[test]
    fn stuck_children_stop_admission_until_they_are_reaped() {
        let shared = fresh();
        lock(shared).stuck = LINGERING_MAX;
        assert!(admit_in(shared).is_none());
        lock(shared).stuck = LINGERING_MAX - 1;
        assert!(admit_in(shared).is_some());
    }
}
