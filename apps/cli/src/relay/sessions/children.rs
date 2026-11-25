//! The relay thread's child processes: ending and reaping them, and the global list a forced
//! shutdown kills them from when the relay thread is stuck.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

#[cfg(unix)]
pub(super) fn kill_process_group(pid: u32, fallback_to_pid: bool) {
    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    if raw <= 1 {
        return;
    }
    let id = nix::unistd::Pid::from_raw(raw);
    // After the child has been reaped, `kill(pid)` can hit a reused pid.
    // `killpg` still covers grandchildren that stayed in the group.
    if nix::sys::signal::killpg(id, nix::sys::signal::Signal::SIGKILL).is_err() && fallback_to_pid {
        let _ = nix::sys::signal::kill(id, nix::sys::signal::Signal::SIGKILL);
    }
}

/// Kill a PTY shell's session, then what is left of its process group (`killpg` reaches jobs left
/// in the group). An unproven session keeps its leader, and a shell whose pid names another
/// process now has no group of ours left to kill. `fallback_to_pid`: see [`kill_process_group`]
/// (only for a shell not reaped yet).
#[cfg(unix)]
pub(super) fn end_shell_session(
    shell: crate::process::process_list::Process,
    fallback_to_pid: bool,
) {
    if crate::process::process_list::kill_session(shell)
        == crate::process::process_list::SessionKill::Ended
    {
        kill_process_group(shell.id(), fallback_to_pid);
    }
}

#[cfg(unix)]
pub(super) fn reap_pid(pid: Option<u32>) -> (Option<i32>, Option<i32>) {
    let Some(pid) = pid else {
        return (None, None);
    };
    let Ok(raw) = i32::try_from(pid) else {
        return (None, None);
    };
    if raw <= 1 {
        return (None, None);
    }
    match nix::sys::wait::waitpid(
        nix::unistd::Pid::from_raw(raw),
        Some(nix::sys::wait::WaitPidFlag::WNOHANG),
    ) {
        Ok(nix::sys::wait::WaitStatus::Exited(_, code)) => (Some(code), None),
        Ok(nix::sys::wait::WaitStatus::Signaled(_, signal, _)) => (None, Some(signal as i32)),
        Ok(_) => (None, None),
        Err(_) => (None, None),
    }
}

/// SIGKILL is already delivered. Retry `WNOHANG` only — never `wait`.
#[cfg(unix)]
pub(super) fn reap_after_signal(pid: Option<u32>) -> (Option<i32>, Option<i32>) {
    for _ in 0..32 {
        let status = reap_pid(pid);
        if status.0.is_some() || status.1.is_some() {
            return status;
        }
        std::thread::yield_now();
    }
    for _ in 0..20 {
        let status = reap_pid(pid);
        if status.0.is_some() || status.1.is_some() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    reap_pid(pid)
}

pub(super) fn status_parts(status: std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (status.code(), status.signal())
    }
    #[cfg(not(unix))]
    {
        (status.code(), None)
    }
}

/// A child the relay thread owns, recorded so a forced shutdown can kill it
/// from another thread without the registries.
#[cfg_attr(unix, derive(Clone, Copy, Debug, PartialEq, Eq))]
#[cfg_attr(windows, derive(Clone, Debug))]
pub(super) enum LiveChild {
    /// An exec shell: the leader of its own process group on Unix.
    #[cfg(unix)]
    ExecGroup(u32),
    /// A shared job handle, retained even after the root exits.
    #[cfg(windows)]
    ExecJob(crate::process::job_tree::JobTree),
    /// A PTY shell: the leader of its own session, named by its lifetime (the shell may have
    /// been reaped and its pid reused by the time a forced shutdown gets to it).
    #[cfg(unix)]
    PtySession(crate::process::process_list::Process),
    /// An operator terminal's launch guard, the leader of its PTY's session. Ended by SIGTERM
    /// only ([`crate::process::launch_guard::terminate`]).
    #[cfg(unix)]
    GuardSession(crate::process::process_list::Process),
}

pub(super) static LIVE_CHILDREN: Mutex<BTreeMap<u64, LiveChild>> = Mutex::new(BTreeMap::new());
static NEXT_LIVE_CHILD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Removes its child from [`LIVE_CHILDREN`] when the session that owns the
/// child is dropped.
pub(super) struct LiveChildGuard(u64);

impl LiveChildGuard {
    pub(super) fn track(child: LiveChild) -> Self {
        // Before the first child is listed: a forced exit kills what is listed.
        crate::process::shutdown::register_forced_exit_kill(kill_tracked_children);
        let id = NEXT_LIVE_CHILD.fetch_add(1, Ordering::Relaxed);
        LIVE_CHILDREN
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, child);
        Self(id)
    }
}

impl Drop for LiveChildGuard {
    fn drop(&mut self) {
        LIVE_CHILDREN
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// SIGKILL every exec process group and terminal session still running. Used
/// by a forced shutdown (deadline or second signal) that cannot wait for the
/// relay thread's registries; it does not reap and sends no frames.
fn kill_tracked_children() {
    kill_live_children(|_| true);
}

#[cfg(unix)]
pub(super) fn kill_live_children(select: impl Fn(&LiveChild) -> bool) {
    let children = LIVE_CHILDREN
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .values()
        .copied()
        .filter(|child| select(child))
        .collect::<Vec<_>>();
    // A guard PTY may be reaped and still tracked: its pid is checked, in one listing for all.
    let mut guards = Vec::new();
    for child in children {
        match child {
            #[cfg(unix)]
            LiveChild::ExecGroup(pid) => kill_process_group(pid, false),
            #[cfg(unix)]
            LiveChild::PtySession(shell) => end_shell_session(shell, false),
            #[cfg(unix)]
            LiveChild::GuardSession(guard) => guards.push(guard),
        }
    }
    crate::process::launch_guard::terminate_all(&guards);
}

/// Ownership: the session owns the child; this list owns a job handle clone.
/// Lock order: snapshot under LIVE_CHILDREN, release it, then terminate jobs.
/// Job operations never acquire this list or a session registry. Forced
/// shutdown has one deadline for all lock retries, including a stuck relay.
#[cfg(windows)]
pub(super) fn kill_live_children(select: impl Fn(&LiveChild) -> bool) {
    let until = Instant::now() + Duration::from_millis(200);
    let Ok(live) = crate::process::job_tree::lock_until(&LIVE_CHILDREN, until) else {
        return;
    };
    let children = live
        .values()
        .filter(|child| select(child))
        .cloned()
        .collect::<Vec<_>>();
    drop(live);
    for LiveChild::ExecJob(job) in children {
        let _ = job.terminate_until(until);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A shell whose pid came round to another process: neither that process nor the process
    /// group it leads is killed (the group kill used to follow any session kill that returned).
    #[cfg(unix)]
    #[test]
    fn a_shell_whose_pid_names_another_process_spares_it_and_its_group() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("sleep");
        let stale = crate::process::process_list::Process::of(child.id()).another_lifetime();
        end_shell_session(stale, true);
        std::thread::sleep(Duration::from_millis(50));
        let alive = child.try_wait().expect("try_wait").is_none();
        let _ = child.kill();
        let _ = child.wait();
        assert!(alive, "the process that got the pid back was killed");
    }
}
