//! The relay as a child subreaper, so what its commands leave behind stays its.
//!
//! A command the relay starts can leave a process that detaches from it:
//! `setsid -f`, a double fork, `nohup … &` from a shell that then exits. The
//! kernel re-parents such an orphan to its nearest subreaper ancestor, else to
//! init. On Linux `wsmp run` marks itself a child subreaper
//! (`PR_SET_CHILD_SUBREAPER`, [`start`]), so those orphans re-parent to the
//! relay and stay its descendants: [`crate::trust::started_by_wsmp`] rule (c)
//! still finds the relay above them. Under `wsmp.service` the unit's cgroup
//! already caught them; a relay run by hand from a terminal shares the
//! terminal's cgroup, so only this keeps them caught.
//!
//! Adopted orphans must be reaped, never with `waitpid(-1)`: that could take
//! the exit status of a child the relay waits for itself (an exec command, a
//! terminal shell, a bounded run). Every such child is spawned through
//! [`spawn`], which returns it in an [`Owned`] handle that keeps its pid
//! registered until the handle drops. [`reap_adopted`] then waits only for
//! zombie children whose pid is not registered:
//! - a spawn holds the gate shared from fork to registration and a scan holds
//!   it exclusively, so no scan sees a child before it is registered;
//! - only zombies are waited for, and an unregistered zombie has no other
//!   waiter, so its pid cannot be reused before `waitpid(pid, WNOHANG)`;
//! - a registered pid is skipped even when its owner already reaped it and the
//!   pid went to an adopted orphan; that orphan is reaped once the handle
//!   drops. A handle dropped without a wait leaves a zombie this reaps.
//!
//! New code that spawns a child the relay waits for must go through [`spawn`],
//! or its status can be taken by the next scan.
//!
//! Shutdown leaves adopted orphans alone, as it always has: cleanup kills each
//! exec command's process group and each terminal's session, not a process
//! that left them, and those re-parent upward once the relay exits. Runtimes
//! run in systemd units, never as the relay's descendants.

use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Mutex, PoisonError, RwLock};

/// Held shared by [`spawn`] from fork to registration, exclusively by a scan.
static GATE: RwLock<()> = RwLock::new(());
/// Registered pids, counted: a reaped pid can be reused while its old handle
/// lives on.
static OWNED: Mutex<BTreeMap<u32, usize>> = Mutex::new(BTreeMap::new());

/// A child the relay spawned and waits for itself. Its pid stays registered
/// (never reaped by [`reap_adopted`]) until this drops.
#[derive(Debug)]
pub struct Owned<C> {
    child: C,
    pid: Option<u32>,
}

impl<C> Deref for Owned<C> {
    type Target = C;
    fn deref(&self) -> &C {
        &self.child
    }
}

impl<C> DerefMut for Owned<C> {
    fn deref_mut(&mut self) -> &mut C {
        &mut self.child
    }
}

impl<C> Drop for Owned<C> {
    fn drop(&mut self) {
        let Some(pid) = self.pid else {
            return;
        };
        let mut owned = OWNED.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = owned.get_mut(&pid) {
            *count -= 1;
            if *count == 0 {
                owned.remove(&pid);
            }
        }
    }
}

/// Spawn a child the caller will wait for, registered before any scan can
/// see it. `pid` names the spawned child (`None`: nothing to register).
pub fn spawn<C, E>(
    spawn: impl FnOnce() -> Result<C, E>,
    pid: impl FnOnce(&C) -> Option<u32>,
) -> Result<Owned<C>, E> {
    let _gate = GATE.read().unwrap_or_else(PoisonError::into_inner);
    let child = spawn()?;
    let pid = pid(&child);
    if let Some(pid) = pid {
        *OWNED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(pid)
            .or_insert(0) += 1;
    }
    Ok(Owned { child, pid })
}

/// How often adopted orphans that exited are reaped.
#[cfg(target_os = "linux")]
const REAP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Make this process a child subreaper and reap adopted orphans from a
/// background thread. `wsmp run` calls it once at startup. Without a thread
/// the process does not become a subreaper (its orphans would stay zombies).
#[cfg(target_os = "linux")]
pub fn start() {
    let spawned = std::thread::Builder::new()
        .name("wsmp-subreaper".to_string())
        .spawn(|| {
            loop {
                std::thread::sleep(REAP_INTERVAL);
                reap_adopted();
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "no reaper thread; commands' orphans re-parent away from the relay");
        return;
    }
    if let Err(error) = nix::sys::prctl::set_child_subreaper(true) {
        tracing::warn!(%error, "cannot become a child subreaper; commands' orphans re-parent away from the relay");
    }
}

/// Elsewhere orphans re-parent to init (macOS: `trust` walks `ps`).
#[cfg(not(target_os = "linux"))]
pub fn start() {}

/// Reap every child that is a zombie and not registered by [`spawn`]: the
/// orphans this subreaper adopted. Returns how many were reaped.
#[cfg(target_os = "linux")]
pub fn reap_adopted() -> usize {
    reap_adopted_where(|_| true)
}

/// [`reap_adopted`] limited to the children `consider` accepts (tests share a
/// process with other tests' children).
#[cfg(target_os = "linux")]
pub(crate) fn reap_adopted_where(consider: impl Fn(u32) -> bool) -> usize {
    use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
    let _gate = GATE.write().unwrap_or_else(PoisonError::into_inner);
    // Registration needs the gate, so the set can only shrink while it is
    // held: this copy skips at least every pid registered now.
    let owned: std::collections::BTreeSet<u32> = OWNED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .keys()
        .copied()
        .collect();
    let me = std::process::id();
    let mut reaped = 0;
    for pid in children(me) {
        if owned.contains(&pid) || !consider(pid) || !is_zombie_child(pid, me) {
            continue;
        }
        let Ok(raw) = i32::try_from(pid) else {
            continue;
        };
        match waitpid(nix::unistd::Pid::from_raw(raw), Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::StillAlive) | Err(_) => {}
            Ok(_) => reaped += 1,
        }
    }
    reaped
}

/// This process's children (every thread's), zombies included: the
/// `children` files where the kernel has them, else a scan of `/proc`.
#[cfg(target_os = "linux")]
fn children(me: u32) -> Vec<u32> {
    let parse = |text: &str| -> Vec<u32> {
        text.split_whitespace()
            .filter_map(|pid| pid.parse().ok())
            .collect()
    };
    if std::path::Path::new(&format!("/proc/self/task/{me}/children")).exists() {
        let Ok(tasks) = std::fs::read_dir("/proc/self/task") else {
            return Vec::new();
        };
        return tasks
            .flatten()
            .filter_map(|task| std::fs::read_to_string(task.path().join("children")).ok())
            .flat_map(|text| parse(&text))
            .collect();
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| stat_fields(*pid).is_some_and(|(_, ppid)| ppid == me))
        .collect()
}

/// A zombie whose parent is `me`.
#[cfg(target_os = "linux")]
fn is_zombie_child(pid: u32, me: u32) -> bool {
    stat_fields(pid).is_some_and(|(state, ppid)| state == 'Z' && ppid == me)
}

/// State and parent pid from `/proc/<pid>/stat` (`pid (comm) S ppid …`;
/// `comm` may hold spaces and parentheses).
#[cfg(target_os = "linux")]
fn stat_fields(pid: u32) -> Option<(char, u32)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut rest = stat[stat.rfind(')')? + 1..].split_whitespace();
    let state = rest.next()?.chars().next()?;
    let ppid = rest.next()?.parse().ok()?;
    Some((state, ppid))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn until(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn reaps_unregistered_zombies_and_leaves_owned_children_to_their_owner() {
        let mut owned = spawn(
            || Command::new("true").stdin(Stdio::null()).spawn(),
            |child| Some(child.id()),
        )
        .expect("owned child");
        // Spawned outside `spawn`, then dropped without a wait: an orphan
        // stand-in nobody waits for.
        let stray = Command::new("true")
            .stdin(Stdio::null())
            .spawn()
            .expect("stray child")
            .id();
        let me = std::process::id();
        let mine = [owned.id(), stray];
        assert!(
            until(|| mine.iter().all(|pid| is_zombie_child(*pid, me))),
            "both children exit"
        );
        assert!(children(me).contains(&stray), "zombies are listed");
        let reaped = reap_adopted_where(|pid| mine.contains(&pid));
        assert_eq!(reaped, 1, "only the stray zombie is reaped");
        assert!(!is_zombie_child(stray, me), "the stray is gone");
        // The owner still gets its child's status.
        assert!(owned.wait().expect("owner's wait").success());
        // A dropped handle unregisters its pid.
        let pid = owned.id();
        drop(owned);
        assert!(
            !OWNED
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains_key(&pid)
        );
    }
}
