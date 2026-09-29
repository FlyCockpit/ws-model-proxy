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
//! Windows has no process groups: the tree is ended with `taskkill /T` while
//! the direct child (`cmd`) is still alive. Helpers that outlive an already
//! exited root cannot be found (no job objects without a new dependency).
//!
//! # Daemon exit
//! Each live run's process group is in a process-wide registry.
//! [`kill_all_active`] (called on the first shutdown signal and by `main` before it exits) kills them all
//! (under the registry lock on Unix, so a group is never signalled after
//! its run reaped it) and refuses later runs: the shutdown check happens
//! before anything is spawned, and shutdown waits for runs that are already
//! mid-spawn (each kills its own group at registration), so an exiting daemon does not orphan the group of
//! a command that was running. `SIGKILL` of the daemon itself cannot be
//! caught and can still leave a group behind for up to its timeout.

use std::collections::BTreeSet;
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
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

#[derive(Default)]
struct Registry {
    closed: bool,
    groups: BTreeSet<u32>,
    /// Runs between the shutdown check and their registration: shutdown
    /// waits for them, so none can start a command it never signals.
    spawning: usize,
}

static ACTIVE: Mutex<Registry> = Mutex::new(Registry {
    closed: false,
    groups: BTreeSet::new(),
    spawning: 0,
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
fn register(pid: u32) -> bool {
    register_in(&ACTIVE, pid)
}

fn register_in(shared: &'static Mutex<Registry>, pid: u32) -> bool {
    let mut registry = lock_registry(shared);
    registry.spawning = registry.spawning.saturating_sub(1);
    if registry.closed {
        #[cfg(unix)]
        kill_run(pid);
        #[cfg(not(unix))]
        {
            drop(registry);
            kill_group(pid);
        }
        return false;
    }
    registry.groups.insert(pid);
    true
}

fn unregister(pid: u32) {
    registry().groups.remove(&pid);
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
    #[cfg(not(unix))]
    {
        drop(registry);
        for pid in groups {
            kill_group(pid);
        }
    }
}

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
        // Elsewhere `taskkill` blocks: signal after unlocking.
        #[cfg(not(unix))]
        {
            drop(registry);
            for pid in groups {
                kill_group(pid);
            }
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
    let cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::SeqCst));
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
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            spawn_failed();
            return Err(RunError::Spawn);
        }
    };
    let pid = child.id();
    if !register(pid) {
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
        Some(status) if status.success() => Ok(buffer),
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
/// (`taskkill /T` at the deadline ends the tree that holds it).
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
fn finish(
    mut child: Child,
    until: Instant,
    permit: Permit,
    cancelled: &dyn Fn() -> bool,
) -> Finished {
    let exited = wait_for_exit(&mut child, until, cancelled);
    let pid = child.id();
    kill_group_or_child(&mut child);
    // Off the registry before the reap: the registry never names a pid that
    // has been reaped (and could be reused).
    unregister(pid);
    // A child that already exited keeps the status it exited with; SIGKILL
    // cannot change it. std caches a status `try_wait` already reaped.
    let status = reap_within(&mut child, Instant::now() + REAP_GRACE);
    if status.is_none() {
        hand_off_to_reaper(child, permit);
    }
    Finished { exited, status }
}

fn reap_within(child: &mut Child, until: Instant) -> Option<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < until => thread::sleep(REAP_POLL),
            _ => return None,
        }
    }
}

/// Wait for a child that survived both kills (uninterruptible sleep) on a
/// detached thread so it does not stay a zombie. The thread ends when the
/// child finally dies; until then the run's permit stays held and the child
/// counts as stuck.
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

#[cfg(not(unix))]
fn kill_group(pid: u32) {
    // No process groups: end the whole tree, bounded so a stuck `taskkill`
    // cannot stall the deadline or shutdown. Needs the root alive (a tree
    // whose root already exited cannot be found; see the module docs).
    let Ok(mut taskkill) = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if reap_within(&mut taskkill, Instant::now() + REAP_GRACE).is_none() {
        let _ = taskkill.kill();
        let _ = taskkill.wait();
    }
}

/// Kill everything the run started: the group, then the direct child itself
/// (it may have left the group; while unreaped its pid cannot be recycled,
/// and `Child::kill` is a no-op once std has reaped it).
#[cfg(unix)]
fn kill_group_or_child(child: &mut Child) {
    kill_group(child.id());
    let _ = child.kill();
}

/// The tree first (`taskkill /T` needs the root alive), then the child.
#[cfg(not(unix))]
fn kill_group_or_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        kill_group(child.id());
        let _ = child.kill();
    }
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
            Ok(None) if Instant::now() < until && !cancelled() => thread::sleep(REAP_POLL),
            Ok(None) => return false,
            _ => return true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
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
