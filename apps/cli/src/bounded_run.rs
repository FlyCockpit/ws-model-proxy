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
//! | no pipe, no reader thread, too many stuck children | `Resources` | killed |
//!
//! # The one exit path
//! Every path after spawn goes through [`finish`]: wait (until the deadline)
//! for the direct child to exit without reaping it where the platform
//! allows, `SIGKILL` its whole process group, then reap it for at most
//! [`REAP_GRACE`]. A child that survives the kill (blocked in uninterruptible
//! sleep, or one that moved itself out of the group) is handed to a detached
//! reaper thread and counted in [`LINGERING_MAX`]; the call still returns
//! within about `timeout + REAP_GRACE`. At the cap new runs are refused
//! (`Resources`) instead of piling up stuck processes.
//!
//! # Daemon exit
//! Each live run's process group is in a process-wide registry.
//! [`kill_all_active`] (called on the first shutdown signal and by `main` before it exits) kills them all
//! and refuses later runs, so an exiting daemon does not orphan the group of
//! a command that was running. `SIGKILL` of the daemon itself cannot be
//! caught and can still leave a group behind for up to its timeout.

use std::collections::BTreeSet;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// How long the reap after the group kill may take before the child is left
/// to a detached reaper thread.
pub const REAP_GRACE: Duration = Duration::from_millis(1_000);
/// Children that survived the group kill and are still being reaped. At this
/// many, new runs are refused.
pub const LINGERING_MAX: usize = 8;
/// How often the wait loops check the deadline and the cancel flag.
const POLL: Duration = Duration::from_millis(25);
const REAP_POLL: Duration = Duration::from_millis(5);

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

static LINGERING: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct Registry {
    closed: bool,
    groups: BTreeSet<u32>,
}

static ACTIVE: Mutex<Registry> = Mutex::new(Registry {
    closed: false,
    groups: BTreeSet::new(),
});

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    ACTIVE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Record a live run. `false` when the process is already exiting: the
/// caller must kill what it started and give up.
fn register(pid: u32) -> bool {
    let mut registry = registry();
    if registry.closed {
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
/// on every path that ends the process. Idempotent, non-blocking, and safe
/// to call from any thread.
pub fn kill_all_active() {
    let groups = {
        let mut registry = registry();
        registry.closed = true;
        std::mem::take(&mut registry.groups)
    };
    for pid in groups {
        kill_group(pid);
    }
}

/// Run `program` with the limits above and return its stdout.
///
/// `cancel`, when set, ends the run at the next poll (a few milliseconds).
pub fn run(
    program: &str,
    args: &[String],
    timeout: Duration,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, RunError> {
    let deadline = Instant::now() + timeout;
    if LINGERING.load(Ordering::SeqCst) >= LINGERING_MAX {
        return Err(RunError::Resources);
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
    let mut child = command.spawn().map_err(|_| RunError::Spawn)?;
    let pid = child.id();
    if !register(pid) {
        finish(child, Instant::now());
        return Err(RunError::Cancelled);
    }
    let Some(stdout) = child.stdout.take() else {
        finish(child, Instant::now());
        return Err(RunError::Resources);
    };
    let (done_tx, done_rx) = mpsc::channel();
    // The reader owns the pipe so a full pipe cannot stall the child; the
    // result arrives on a channel so a leaked pipe never blocks this thread.
    // It reads one byte past the limit to tell "exactly the limit" from "more".
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
        finish(child, Instant::now());
        return Err(RunError::Resources);
    }
    let cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::SeqCst));
    let mut output = None;
    loop {
        if cancelled() {
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match done_rx.recv_timeout(remaining.min(POLL)) {
            Ok(buffer) => {
                output = Some(buffer);
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let over_limit = output.as_ref().is_some_and(|buffer| buffer.len() > limit);
    // Refused output, a missing pipe result or a cancel: do not wait for exit.
    let wait_until = if output.is_some() && !over_limit && !cancelled() {
        deadline
    } else {
        Instant::now()
    };
    let finished = finish(child, wait_until);
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

/// What [`finish`] learned.
struct Finished {
    /// The program exited on its own before `until` (it was not killed for
    /// running too long).
    exited: bool,
    /// Its status, when it was reaped within [`REAP_GRACE`].
    status: Option<ExitStatus>,
}

/// The one exit path after spawn: wait until `until` for the child to exit
/// (unreaped where the platform allows), kill every process left in its
/// group, drop the run from the registry, then reap the child for at most
/// [`REAP_GRACE`]; a child that is still not reaped goes to a detached
/// reaper thread.
///
/// On Linux the wait uses `waitid(WNOWAIT)`, so the child stays a zombie and
/// its pid (the group id) cannot be recycled before the group kill. Other
/// Unix targets reap first: POSIX does not reuse a pid while a process group
/// with that id has members, so a surviving helper keeps the id safe; with no
/// helper left the kill can only miss (a recycled pid would also have to have
/// become a group leader in the microseconds between).
fn finish(mut child: Child, until: Instant) -> Finished {
    let exited = wait_for_exit(&mut child, until);
    let pid = child.id();
    kill_group_or_child(&mut child);
    // Off the registry before the reap: the registry never names a pid that
    // has been reaped (and could be reused).
    unregister(pid);
    // A child that already exited keeps the status it exited with; SIGKILL
    // cannot change it. std caches a status `try_wait` already reaped.
    let status = reap_within(&mut child, Instant::now() + REAP_GRACE);
    if status.is_none() {
        hand_off_to_reaper(child);
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

/// Wait for a child that survived the group kill on a detached thread so it
/// does not stay a zombie. The thread ends when the child finally dies.
fn hand_off_to_reaper(mut child: Child) {
    LINGERING.fetch_add(1, Ordering::SeqCst);
    let spawned = thread::Builder::new()
        .name("wsmp-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
            LINGERING.fetch_sub(1, Ordering::SeqCst);
        });
    if spawned.is_err() {
        // The child (dropped with the closure) is not reaped; nothing more
        // can be done without a thread.
        LINGERING.fetch_sub(1, Ordering::SeqCst);
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

#[cfg(not(unix))]
fn kill_group(pid: u32) {
    // No process groups: end the whole tree.
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(unix)]
fn kill_group_or_child(child: &mut Child) {
    kill_group(child.id());
}

#[cfg(not(unix))]
fn kill_group_or_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
}

/// Poll until the child has exited or `until` passes, leaving it unreaped.
/// True when it exited.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn wait_for_exit(child: &mut Child, until: Instant) -> bool {
    use nix::sys::wait::{Id, WaitPidFlag, WaitStatus, waitid};
    let Ok(raw) = i32::try_from(child.id()) else {
        return false;
    };
    let flags = WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT;
    loop {
        match waitid(Id::Pid(nix::unistd::Pid::from_raw(raw)), flags) {
            Ok(WaitStatus::StillAlive) if Instant::now() < until => thread::sleep(REAP_POLL),
            Ok(WaitStatus::StillAlive) => return false,
            _ => return true,
        }
    }
}

/// Poll until the child has exited or `until` passes (this reaps; see
/// [`finish`]). True when it exited.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn wait_for_exit(child: &mut Child, until: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(None) if Instant::now() < until => thread::sleep(REAP_POLL),
            Ok(None) => return false,
            _ => return true,
        }
    }
}
