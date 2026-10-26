//! Every live process on this machine, for the kills that must reach what a process group kill
//! misses (a PTY's session, a launch guard's session). Zombies are skipped: they are already
//! dead and only wait for their parent to reap them. Linux reads `/proc`; macOS and the BSDs
//! have no `/proc` and listing pids needs FFI (`unsafe` is forbidden here), so `/bin/ps` lists
//! them.
//!
//! A list that could not be read is an error, never an empty list: an empty list is the proof
//! that a session is gone.
//!
//! A pid names a process only while it lives: once it is gone, the kernel can hand the same pid
//! to an unrelated process. So every listed process carries its start time too ([`Process`]),
//! and a signal goes to a pid only while that start time still matches.

use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

/// Kill rounds of [`kill_session`]. Session members can fork while they are being killed, so
/// the session is re-scanned until it is empty.
const SESSION_KILL_ROUNDS: usize = 20;

/// When a process started. On Linux, the clock ticks since boot (field 22 of
/// `/proc/<pid>/stat`). Elsewhere, a digest of `ps`'s `lstart`, which has whole seconds only.
/// With its pid it names one process lifetime: a reused pid starts later.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Started(u64);

/// One process lifetime: a pid and when its process started. `started` is `None` when it could
/// not be read; such a process is named by its pid alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Process {
    pub(crate) pid: Pid,
    pub(crate) started: Option<Started>,
}

impl Process {
    /// The process `pid` names now. The caller makes sure that is the one it means (its own
    /// unreaped child, say). A pid out of range, 0 or 1 is never signalled.
    pub(crate) fn of(pid: u32) -> Self {
        let pid = Pid::from_raw(i32::try_from(pid).unwrap_or(0));
        Self {
            pid,
            started: if signallable(pid) { started(pid) } else { None },
        }
    }

    /// The pid as `std::process` and the relay name it (0 for one out of range).
    pub(crate) fn id(&self) -> u32 {
        u32::try_from(self.pid.as_raw()).unwrap_or(0)
    }

    /// Whether the pid still names this process. One whose start time was not known matches
    /// whatever has the pid now.
    fn is_current(&self) -> bool {
        self.started
            .is_none_or(|started_at| started(self.pid) == Some(started_at))
    }

    /// `signal` to this process. `ESRCH` when its pid names another process now (or none). The
    /// check and the signal are two steps, so a pid reused in between is still hit: that needs
    /// the process to exit and its pid to come round again in that instant.
    pub(crate) fn signal(&self, signal: Signal) -> nix::Result<()> {
        if !signallable(self.pid) || !self.is_current() {
            return Err(Errno::ESRCH);
        }
        nix::sys::signal::kill(self.pid, signal)
    }
}

/// Not 0 or below (a process group, or every process) and not init.
fn signallable(pid: Pid) -> bool {
    pid.as_raw() > 1
}

/// The fields of a `/proc/<pid>/stat` after `pid (comm)`, starting with the state. The command
/// is bytes, not text (Linux can cut a name inside a multibyte character), and may itself hold
/// `)`: the fields follow the last one.
#[cfg(target_os = "linux")]
pub(crate) fn stat_fields(stat: &[u8]) -> Option<std::str::SplitAsciiWhitespace<'_>> {
    let end = stat.iter().rposition(|byte| *byte == b')')?;
    Some(
        std::str::from_utf8(&stat[end + 1..])
            .ok()?
            .split_ascii_whitespace(),
    )
}

/// Field 22 of a `/proc/<pid>/stat`: the start time, in clock ticks since boot.
#[cfg(target_os = "linux")]
fn stat_started(stat: &[u8]) -> Option<Started> {
    // The 20th field after `pid (comm)`.
    stat_fields(stat)?.nth(19)?.parse().ok().map(Started)
}

/// A `stat` whose state cannot be parsed counts as live.
#[cfg(target_os = "linux")]
fn stat_is_zombie(stat: &[u8]) -> bool {
    stat_fields(stat)
        .and_then(|mut fields| fields.next())
        .is_some_and(|state| state == "Z")
}

/// The start time of `pid` in clock ticks since boot, which outlives this process (a
/// restarted daemon compares it). `None` when it is gone.
#[cfg(target_os = "linux")]
pub(crate) fn start_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
    stat_started(&stat).map(|Started(ticks)| ticks)
}

#[cfg(target_os = "linux")]
fn started(pid: Pid) -> Option<Started> {
    let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
    stat_started(&stat)
}

#[cfg(target_os = "linux")]
pub(crate) fn live() -> std::io::Result<Vec<Process>> {
    let mut processes = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(raw) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if raw <= 1 {
            continue;
        }
        let stat = match std::fs::read(format!("/proc/{raw}/stat")) {
            Ok(stat) => stat,
            // It exited since the directory was read.
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(nix::libc::ESRCH) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        if !stat_is_zombie(&stat) {
            processes.push(Process {
                pid: Pid::from_raw(raw),
                started: stat_started(&stat),
            });
        }
    }
    Ok(processes)
}

/// `lstart` as `ps` prints it (`Mon Oct 26 10:00:00 2026`), digested. `ps` runs with a cleared
/// environment and `TZ=UTC0`, so every call prints it in the same time zone and locale.
#[cfg(not(target_os = "linux"))]
fn lstart<'a>(fields: impl Iterator<Item = &'a str>) -> Option<Started> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    let mut any = false;
    for field in fields {
        field.hash(&mut hasher);
        any = true;
    }
    any.then(|| Started(hasher.finish()))
}

#[cfg(not(target_os = "linux"))]
fn ps(args: &[&str]) -> std::io::Result<std::process::Output> {
    std::process::Command::new("/bin/ps")
        .args(args)
        .env_clear()
        // Without `TZ`, `ps` prints local time in the system time zone, which can change while
        // a process runs (and with it the digest of its `lstart`).
        .env("TZ", "UTC0")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
}

#[cfg(not(target_os = "linux"))]
fn started(pid: Pid) -> Option<Started> {
    let output = ps(&["-o", "lstart=", "-p", &pid.to_string()]).ok()?;
    if !output.status.success() {
        return None;
    }
    lstart(String::from_utf8_lossy(&output.stdout).split_whitespace())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn live() -> std::io::Result<Vec<Process>> {
    let output = ps(&["-axo", "pid=,stat=,lstart="])?;
    if !output.status.success() {
        return Err(std::io::Error::other("`ps` could not list processes"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let raw = fields.next()?.parse::<i32>().ok()?;
            let zombie = fields.next().is_some_and(|state| state.starts_with('Z'));
            (raw > 1 && !zombie).then(|| Process {
                pid: Pid::from_raw(raw),
                started: lstart(fields),
            })
        })
        .collect())
}

/// Every live process whose session id is confirmed to be `sid`.
pub(crate) fn session_members(sid: Pid) -> std::io::Result<Vec<Process>> {
    Ok(live()?
        .into_iter()
        .filter(|process| nix::unistd::getsid(Some(process.pid)) == Ok(sid))
        .collect())
}

/// SIGKILL every process in the session led by `leader` (a PTY shell spawned with `setsid`, or a
/// launch guard someone else killed), so its pid is the session id. This reaches background
/// jobs in their own process groups and `nohup`/disowned jobs, which a process group kill
/// misses. Rounds repeat because members can fork while the kill is in progress, and because a
/// list that could not be read proves nothing. A live launch guard is never ended this way: a
/// scan can be stale by the time its kill lands, so it gets SIGTERM and ends its session itself
/// (`launch_guard::terminate`).
///
/// `leader` is the leader as it was while it was still unreaped, so a retry after it was reaped
/// still knows it: a pid that leads a session again, but started at another time, is someone
/// else's session, and ours has ended (the kernel does not hand out a pid that is still some
/// session's id while members remain).
///
/// The leader goes last, once a scan found no other member. When no round proved that (or the
/// leader could not be killed), the leader gets SIGTERM and SIGHUP instead (a shell exits on the hangup), and this returns
/// [`SessionKill::Unproven`]. See [`SessionKill`] for what each outcome lets the caller do.
///
/// Only processes whose `getsid` matches are signalled, each only while its start time still
/// matches, and never session 1 or the CLI's own session. A process that calls `setsid()`
/// itself starts a new session and escapes this kill; that is a documented limit.
pub(crate) fn kill_session(leader: Process) -> SessionKill {
    let sid = leader.pid;
    if !signallable(sid) {
        return SessionKill::Reused;
    }
    // Either the leader is our unreaped child, or it was reaped and its session id stays
    // reserved while members remain. A zombie or reaped leader can fail `getsid`; its session
    // members are still confirmed one by one below.
    if leader.is_current() && nix::unistd::getsid(Some(sid)).is_ok_and(|actual| actual != sid) {
        return SessionKill::Ended;
    }
    if nix::unistd::getsid(None).is_ok_and(|own| own == sid) {
        return SessionKill::Reused;
    }
    let own_pid = nix::unistd::getpid();
    for round in 0..SESSION_KILL_ROUNDS {
        if let Ok(members) = session_members(sid) {
            // Read by pid, not from the scan: a later leader that is a zombie now is not listed,
            // and the members of its session are not ours either.
            if pid_reused(leader) {
                return SessionKill::Reused;
            }
            let listed = members.iter().any(|member| member.pid == sid);
            let others = members
                .into_iter()
                .filter(|member| member.pid != sid && member.pid != own_pid)
                .collect::<Vec<_>>();
            if others.is_empty() {
                // A leader that is still there but could not be killed (a privileged program
                // it became) leaves the session unproven.
                if listed
                    && let Err(error) = leader.signal(Signal::SIGKILL)
                    && error != Errno::ESRCH
                {
                    break;
                }
                // The pid may name a later process now, outside the session: its group is not
                // ours either.
                return if pid_reused(leader) {
                    SessionKill::Reused
                } else {
                    SessionKill::Ended
                };
            }
            for member in others {
                let _ = member.signal(Signal::SIGKILL);
            }
        }
        // SIGKILL is asynchronous. Back off a little so a killed process can become a zombie
        // before the next scan.
        if round > 0 {
            std::thread::sleep(Duration::from_millis(5));
        } else {
            std::thread::yield_now();
        }
    }
    if nix::unistd::getsid(Some(sid)) == Ok(sid) {
        let _ = leader.signal(Signal::SIGTERM);
        let _ = leader.signal(Signal::SIGHUP);
    }
    SessionKill::Unproven
}

/// How [`kill_session`] ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionKill {
    /// No member is left (or the leader leads no session): what remains of the leader's process
    /// group, if anything, is still ours, and the caller may kill the group.
    Ended,
    /// The leader's pid names another process now (or never named one of ours): our session
    /// ended earlier. Nothing named by that pid, as a process or as a process group, is ours to
    /// signal.
    Reused,
    /// No round proved the session empty: the caller must not kill the leader or its group by
    /// force either.
    Unproven,
}

impl SessionKill {
    /// Whether nothing of the session can still run (a lingering cleanup is done).
    pub(crate) fn settled(self) -> bool {
        self != Self::Unproven
    }
}

#[cfg(test)]
impl Process {
    /// This pid as a process that started at another time (one whose pid came round again).
    pub(crate) fn another_lifetime(self) -> Self {
        let Started(at) = self.started.unwrap_or(Started(0));
        Self {
            started: Some(Started(at.wrapping_add(1))),
            ..self
        }
    }
}

/// Whether `leader`'s pid names a later process now (a zombie included). Unknown start times
/// prove nothing.
fn pid_reused(leader: Process) -> bool {
    started(leader.pid).is_some_and(|now| {
        reused(
            leader,
            Process {
                pid: leader.pid,
                started: Some(now),
            },
        )
    })
}

/// Whether `now` (listed with `leader`'s pid) is a later process than `leader`. Unknown start
/// times prove nothing.
fn reused(leader: Process, now: Process) -> bool {
    leader
        .started
        .zip(now.started)
        .is_some_and(|(then, now)| then != now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn a_stat_is_read_as_bytes_up_to_the_last_parenthesis() {
        assert!(stat_is_zombie(b"42 (sleep) Z 1 42 42"));
        assert!(!stat_is_zombie(b"42 (sleep) S 1 42 42"));
        // A name cut inside a multibyte character, and one holding `) Z `.
        assert!(stat_is_zombie(b"42 (\xe2\x82) Z 1 42 42"));
        assert!(!stat_is_zombie(b"42 (a) Z (b) R 1 42 42"));
        assert!(!stat_is_zombie(b"garbage"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_stat_names_its_start_time_after_a_name_that_is_not_utf8() {
        let stat =
            b"42 (\xe2\x82) S 1 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
        assert_eq!(stat_started(stat), Some(Started(987654)));
        assert_eq!(stat_started(b"42 (sleep) S 1"), None);
    }

    #[test]
    fn a_process_is_named_by_its_pid_and_start_time() {
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let process = Process::of(child.id());
        let listed = live().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        assert!(process.started.is_some(), "no start time for {process:?}");
        assert!(listed.contains(&process), "{process:?} is not listed");
        // Reaped: the pid names no process of that lifetime now, so nothing is signalled.
        assert_eq!(process.signal(Signal::SIGKILL), Err(Errno::ESRCH));
    }

    #[test]
    fn a_pid_that_names_another_process_is_reused_and_left_alone() {
        use std::os::unix::process::CommandExt;
        // A group leader, as the process that got the pid back can be.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let stale = Process::of(child.id()).another_lifetime();
        let outcome = kill_session(stale);
        let alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(outcome, SessionKill::Reused);
        assert!(alive);
    }

    #[test]
    fn a_session_led_by_a_later_process_is_someone_elses() {
        let pid = Pid::from_raw(4242);
        let then = Process {
            pid,
            started: Some(Started(1)),
        };
        assert!(reused(
            then,
            Process {
                pid,
                started: Some(Started(2))
            }
        ));
        assert!(!reused(then, then));
        assert!(!reused(then, Process { pid, started: None }));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_scan_lists_a_process_whose_name_is_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        // The kernel keeps the first 15 bytes of the file name: the name is cut inside `é`.
        let name = std::ffi::OsStr::from_bytes(b"wsmp-scantest-\xc3\xa9");
        let program = dir.path().join(name);
        // A shell, not `sleep`: a multicall coreutils (uutils) picks its tool by file name, and
        // a renamed copy exits at once. It waits for input until the test drops stdin.
        std::fs::copy("/bin/sh", &program).unwrap();
        let mut child = std::process::Command::new(&program)
            .args(["-c", "read line"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let pid = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap());
        let comm = std::fs::read(format!("/proc/{pid}/comm")).unwrap();
        let listed = super::live();
        let running = child.try_wait().unwrap().is_none();
        let ticks = start_ticks(child.id());
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            std::str::from_utf8(&comm).is_err(),
            "the test needs a name that is not UTF-8: {comm:?}"
        );
        assert!(running, "the test process exited before the scan");
        assert!(ticks.is_some(), "no start time read past the name");
        assert!(listed.unwrap().iter().any(|process| process.pid == pid));
    }
}
