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
//! and signals check that start time when it was captured. An unreadable start time still
//! falls back to the pid alone, and `lstart` has only second precision; these remaining
//! identity gaps are tracked in issue #244, along with the check-to-signal race.

use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

/// Kill rounds of [`kill_session`]. Session members can fork while they are being killed, so
/// the session is re-scanned until it is empty.
const SESSION_KILL_ROUNDS: usize = 20;

/// When a process started. On Linux, the clock ticks since boot (field 22 of
/// `/proc/<pid>/stat`). Elsewhere, a digest of `ps`'s `lstart`, which has whole seconds only.
/// With its pid it distinguishes process lifetimes to the clock's precision.
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

    /// `signal` to this process without reading its start time: only for the caller's own
    /// child that is not reaped yet, whose pid cannot name another process. A start time that
    /// cannot be read now (a `ps` that timed out) must not cost such a child its signal.
    pub(crate) fn signal_unreaped_child(&self, signal: Signal) -> nix::Result<()> {
        if !signallable(self.pid) {
            return Err(Errno::ESRCH);
        }
        nix::sys::signal::kill(self.pid, signal)
    }
}

/// `signal` to each of `processes` whose pid still names it, checked against one listing (on
/// macOS one `ps` for all, not one per process). A listing that cannot be read signals none. A
/// zombie is not listed: it is already dead.
pub(crate) fn signal_current(processes: &[Process], signal: Signal) {
    if processes.is_empty() {
        return;
    }
    let Ok(listed) = live() else {
        return;
    };
    for process in processes {
        let current = listed.iter().any(|now| {
            now.pid == process.pid && process.started.is_none_or(|at| now.started == Some(at))
        });
        if current && signallable(process.pid) {
            let _ = nix::sys::signal::kill(process.pid, signal);
        }
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

/// When `pid`'s process started, `None` when that is not known (see [`read_started`]).
fn started(pid: Pid) -> Option<Started> {
    read_started(pid).ok().flatten()
}

/// When `pid`'s process started: `Ok(None)` only when no process has the pid, `Err` when it
/// could not be read (or does not parse). An error says nothing about the pid: it is never taken
/// for "the same process" or for "no process".
fn read_started(pid: Pid) -> std::io::Result<Option<Started>> {
    #[cfg(test)]
    if tests::START_READS_FAIL.get() {
        return Err(std::io::Error::other(
            "start times are unreadable in this test",
        ));
    }
    read_started_now(pid)
}

#[cfg(target_os = "linux")]
fn read_started_now(pid: Pid) -> std::io::Result<Option<Started>> {
    match std::fs::read(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat_started(&stat).map(Some).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "no start time in the stat")
        }),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.raw_os_error() == Some(nix::libc::ESRCH) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
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
#[cfg(any(test, not(target_os = "linux")))]
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

/// How long `ps` may take. Cleanup runs it on shutdown, so a `ps` that hangs must not hang it:
/// past this, the listing is an error (nothing proven, nothing signalled), never a wait.
#[cfg(not(target_os = "linux"))]
const PS_TIMEOUT: Duration = Duration::from_secs(2);

/// How much of `ps`'s diagnostics is kept: only whether there are any matters.
#[cfg(not(target_os = "linux"))]
const PS_STDERR_LIMIT: u64 = 4096;

/// How many `ps` may be running (or given up and not reaped yet) at once. A `ps` stuck in the
/// kernel keeps its slot until it is reaped, so retries cannot pile up threads and processes:
/// past this, a listing is an error at once.
#[cfg(not(target_os = "linux"))]
const PS_MAX_OUTSTANDING: usize = 4;

#[cfg(not(target_os = "linux"))]
static PS_OUTSTANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// One of [`PS_MAX_OUTSTANDING`], held until its `ps` is reaped.
#[cfg(not(target_os = "linux"))]
struct PsSlot;

#[cfg(not(target_os = "linux"))]
impl PsSlot {
    fn take() -> std::io::Result<Self> {
        use std::sync::atomic::Ordering;
        // `fetch_update` is deprecated on current Rust; its replacement requires a newer
        // compiler than our MSRV. Keep the bounded increment on Rust 1.89 with a CAS loop.
        let mut held = PS_OUTSTANDING.load(Ordering::Acquire);
        loop {
            if held >= PS_MAX_OUTSTANDING {
                return Err(std::io::Error::other("too many `ps` still running"));
            }
            match PS_OUTSTANDING.compare_exchange_weak(
                held,
                held + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(Self),
                Err(current) => held = current,
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
impl Drop for PsSlot {
    fn drop(&mut self) {
        PS_OUTSTANDING.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

/// `ps`'s standard output, once it exited (within [`PS_TIMEOUT`]).
#[cfg(not(target_os = "linux"))]
fn ps(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    let slot = PsSlot::take()?;
    let mut child = std::process::Command::new("/bin/ps")
        .args(args)
        .env_clear()
        // Without `TZ`, `ps` prints local time in the system time zone, which can change while
        // a process runs (and with it the digest of its `lstart`).
        .env("TZ", "UTC0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        // Read once it exited (see below): `ps` prints a diagnostic there when it fails.
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    // Read on a thread: a full listing can outgrow the pipe, and `ps` waits until it is read.
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("`ps` has no output"))?;
    // A thread that cannot start (resource pressure) is an error like any failed listing.
    let reader = match std::thread::Builder::new().spawn(move || {
        let mut out = Vec::new();
        stdout.read_to_end(&mut out).map(|_| out)
    }) {
        Ok(reader) => reader,
        Err(error) => {
            give_up(child, slot);
            return Err(error);
        }
    };
    let until = std::time::Instant::now() + PS_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = reader
                    .join()
                    .map_err(|_| std::io::Error::other("reading `ps` failed"))??;
                // `ps` has exited and starts no children, so this ends at once; a diagnostic
                // longer than the pipe would have kept it from exiting.
                let mut stderr = Vec::new();
                if let Some(pipe) = child.stderr.take() {
                    pipe.take(PS_STDERR_LIMIT).read_to_end(&mut stderr)?;
                }
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) if std::time::Instant::now() < until => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(None) => {
                give_up(child, slot);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "`ps` did not answer in time",
                ));
            }
            Err(error) => {
                give_up(child, slot);
                return Err(error);
            }
        }
    }
}

/// Kill a `ps` this listing no longer waits for, and reap it off this thread: one stuck in the
/// kernel may not die at once. Its slot goes once it is reaped. With no thread to spare it is
/// left unreaped (a zombie until the CLI exits) and keeps its slot.
#[cfg(not(target_os = "linux"))]
fn give_up(mut child: std::process::Child, slot: PsSlot) {
    let _ = child.kill();
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    let reaper = std::thread::Builder::new().spawn(move || {
        let _ = child.wait();
        drop(slot);
    });
    if let Err(error) = reaper {
        // The closure (and the slot in it) is dropped with the error: keep the slot held.
        drop(error);
        PS_OUTSTANDING.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[cfg(not(target_os = "linux"))]
fn read_started_now(pid: Pid) -> std::io::Result<Option<Started>> {
    let output = ps(&["-o", "lstart=", "-p", &pid.to_string()])?;
    ps_start_time(output.status.code(), &output.stdout, &output.stderr)
}

/// What `ps -o lstart= -p <pid>` said, from its exit code (`None`: ended by a signal), output and
/// diagnostics. It exits 1 and prints nothing at all when no process has the pid; any other
/// failure (a signal, another code, a diagnostic) proves nothing, and neither does a success
/// without a start time.
#[cfg(any(test, not(target_os = "linux")))]
fn ps_start_time(
    code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> std::io::Result<Option<Started>> {
    let text = String::from_utf8_lossy(stdout);
    match code {
        Some(0) => lstart(text.split_whitespace()).map(Some).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "`ps` printed no start time",
            )
        }),
        Some(1) if text.trim().is_empty() && stderr.is_empty() => Ok(None),
        _ => Err(std::io::Error::other("`ps` failed")),
    }
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
/// list or a start time that could not be read proves nothing. A live launch guard is never ended this way: a
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
    kill_session_of(Leader {
        process: leader,
        unreaped_child: false,
    })
}

/// [`kill_session`] for a leader that is the caller's own child and not reaped yet (a zombie
/// included), such as a PTY shell its owner is closing: its pid cannot name another process
/// until it is reaped, so no start time is read for it (on macOS each read is a `ps`).
pub(crate) fn kill_child_session(child: Process) -> SessionKill {
    kill_session_of(Leader {
        process: child,
        unreaped_child: true,
    })
}

/// A session leader as [`kill_session_of`] knows it.
#[derive(Clone, Copy)]
struct Leader {
    process: Process,
    /// The caller's own child, not reaped yet: its pid still names it.
    unreaped_child: bool,
}

impl Leader {
    fn is_current(self) -> bool {
        self.unreaped_child || self.process.is_current()
    }

    /// What its pid names now; see [`leader_now`].
    fn now(self) -> std::io::Result<LeaderNow> {
        if self.unreaped_child {
            return Ok(LeaderNow::Same);
        }
        leader_now(self.process)
    }

    fn signal(self, signal: Signal) -> nix::Result<()> {
        if self.unreaped_child {
            self.process.signal_unreaped_child(signal)
        } else {
            self.process.signal(signal)
        }
    }
}

fn kill_session_of(leader: Leader) -> SessionKill {
    let sid = leader.process.pid;
    if !signallable(sid) {
        return SessionKill::Reused;
    }
    // Either the leader is not reaped yet, or it was reaped and its session id stays
    // reserved while members remain. A zombie or reaped leader can fail `getsid`; its session
    // members are still confirmed one by one below. `getsid` goes first: a leader that still
    // leads its session (a running PTY shell) needs no start-time read (on macOS, a `ps`).
    if nix::unistd::getsid(Some(sid)).is_ok_and(|actual| actual != sid) && leader.is_current() {
        return SessionKill::Ended;
    }
    if nix::unistd::getsid(None).is_ok_and(|own| own == sid) {
        return SessionKill::Reused;
    }
    let own_pid = nix::unistd::getpid();
    for round in 0..SESSION_KILL_ROUNDS {
        match kill_round(leader, own_pid) {
            Round::Settled(outcome) => return outcome,
            Round::LeaderStuck => break,
            Round::Again => {}
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

/// What one round of [`kill_session`] proved.
enum Round {
    Settled(SessionKill),
    /// Nothing proven (a listing or a start time could not be read), or members were killed:
    /// list again.
    Again,
    /// The leader is still there but could not be killed (a privileged program it became).
    LeaderStuck,
}

/// One listing of `leader`'s session: kill the members other than the leader, or once there are
/// none, the leader.
fn kill_round(leader: Leader, own_pid: Pid) -> Round {
    let sid = leader.process.pid;
    let Ok(members) = session_members(sid) else {
        return Round::Again;
    };
    // Read by pid after the scan, not from it: a later leader that is a zombie now is not listed,
    // and a scan is not atomic (it can hold our leader and members of a later session under its
    // pid), so the members of a session its pid leads now are not ours either.
    match leader.now() {
        Ok(LeaderNow::Reused) => return Round::Settled(SessionKill::Reused),
        Ok(LeaderNow::Same | LeaderNow::Gone) => {}
        Err(_) => return Round::Again,
    }
    let listed = members.iter().any(|member| member.pid == sid);
    let others = members
        .into_iter()
        .filter(|member| member.pid != sid && member.pid != own_pid)
        .collect::<Vec<_>>();
    if others.is_empty() {
        // A leader that is still there but could not be killed (a privileged program it
        // became) leaves the session unproven.
        if listed
            && let Err(error) = leader.signal(Signal::SIGKILL)
            && error != Errno::ESRCH
        {
            return Round::LeaderStuck;
        }
        // The pid may name a later process now, outside the session: its group is not ours
        // either. A start time that could not be read proves neither.
        return match leader.now() {
            Ok(LeaderNow::Reused) => Round::Settled(SessionKill::Reused),
            Ok(LeaderNow::Same | LeaderNow::Gone) => Round::Settled(SessionKill::Ended),
            Err(_) => Round::Again,
        };
    }
    for member in others {
        let _ = member.signal(Signal::SIGKILL);
    }
    Round::Again
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

/// What `leader`'s pid names now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LeaderNow {
    /// The leader (a zombie included), or whatever has the pid when the leader's start time was
    /// never known: unknown start times prove nothing.
    Same,
    /// No process.
    Gone,
    /// A later process.
    Reused,
}

/// What `leader`'s pid names now. A start time that cannot be read now is an error, never
/// "the same" or "gone".
fn leader_now(leader: Process) -> std::io::Result<LeaderNow> {
    if leader.started.is_none() {
        return Ok(LeaderNow::Same);
    }
    let Some(now) = read_started(leader.pid)? else {
        return Ok(LeaderNow::Gone);
    };
    let now = Process {
        pid: leader.pid,
        started: Some(now),
    };
    Ok(if reused(leader, now) {
        LeaderNow::Reused
    } else {
        LeaderNow::Same
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

    thread_local! {
        /// Makes every start-time read on this thread fail, as a `ps` that finds no free slot
        /// or times out does on macOS.
        pub(super) static START_READS_FAIL: std::cell::Cell<bool> =
            const { std::cell::Cell::new(false) };
    }

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

    /// A start time that cannot be read now proves nothing about a pid: the session of a leader
    /// whose pid may name another process now is never reported ended, so its caller does not
    /// kill that process's group (macOS used to, when `ps` found no free slot).
    // Linux only: with start times unreadable `kill_session` lists the session in every round,
    // and on macOS each listing is a `ps` that would hold one of the few slots the tests running
    // beside it need. The logic is the same on every platform.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_unreadable_start_time_never_proves_a_pid_still_ours() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let stale = Process::of(child.id()).another_lifetime();
        START_READS_FAIL.set(true);
        let outcome = kill_session(stale);
        START_READS_FAIL.set(false);
        let alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(outcome, SessionKill::Unproven);
        assert!(alive);
    }

    /// A session whose leader is the caller's unreaped child is ended without reading the
    /// leader's start time (members are still checked one by one).
    // Linux only: with start times unreadable `kill_session` lists the session in every round,
    // and on macOS each listing is a `ps` that would hold one of the few slots the tests running
    // beside it need. The logic is the same on every platform.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_unreaped_childs_session_is_ended_without_reading_its_start_time() {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize::default())
            .unwrap();
        let mut command = portable_pty::CommandBuilder::new("sleep");
        command.arg("30");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        // A known start time (not read: a read can fail under load), so `kill_session` below
        // needs to read the current one.
        let leader = Process {
            pid: Pid::from_raw(i32::try_from(child.process_id().unwrap()).unwrap()),
            started: Some(Started(1)),
        };
        START_READS_FAIL.set(true);
        let outcome = kill_child_session(leader);
        let unproven = kill_session(leader);
        START_READS_FAIL.set(false);
        let status = child.wait().unwrap();
        drop(pair.master);
        assert_eq!(outcome, SessionKill::Ended);
        assert!(!status.success(), "{status:?}");
        // The same leader not known to be unreaped proves nothing without its start time.
        assert_eq!(unproven, SessionKill::Unproven);
    }

    /// `ps -o lstart= -p` names absence only by exiting 1 with no output and no diagnostic.
    #[test]
    fn only_a_silent_exit_1_of_ps_names_no_process() {
        let started = b"Mon Oct 26 10:00:00 2026\n";
        assert!(ps_start_time(Some(0), started, b"").unwrap().is_some());
        assert!(ps_start_time(Some(0), b"", b"").is_err());
        assert!(ps_start_time(Some(1), b"", b"").unwrap().is_none());
        assert!(ps_start_time(Some(1), b"\n", b"").unwrap().is_none());
        assert!(ps_start_time(Some(1), b"", b"ps: out of memory\n").is_err());
        assert!(ps_start_time(Some(1), started, b"").is_err());
        assert!(ps_start_time(Some(2), b"", b"").is_err());
        // Ended by a signal.
        assert!(ps_start_time(None, b"", b"").is_err());
    }

    #[test]
    fn one_listing_signals_only_the_processes_still_themselves() {
        let mut ours = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut other = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let current = Process::of(ours.id());
        let stale = Process::of(other.id()).another_lifetime();
        signal_current(&[current, stale], Signal::SIGKILL);
        let ours_status = ours.wait().unwrap();
        let other_alive = other.try_wait().unwrap().is_none();
        let _ = other.kill();
        let _ = other.wait();
        assert!(!ours_status.success(), "{ours_status:?}");
        assert!(
            other_alive,
            "a pid that names another process was signalled"
        );
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
        // The kernel keeps the first 15 bytes of the file name: the name is cut inside `é`. A
        // script, not a copy of `sleep`: a multi-call coreutils binary picks its tool by name and
        // would exit at once under this one.
        let name = std::ffi::OsStr::from_bytes(b"wsmp-scantest-\xc3\xa9");
        let program = dir.path().join(name);
        // A shell, not `sleep`: a multicall coreutils (uutils) picks its tool by file name, and
        // a renamed copy exits at once. It says it is running, then waits for input until the
        // test drops stdin.
        std::fs::copy("/bin/sh", &program).unwrap();
        // Another test thread can fork while the copy is still open for writing, which makes
        // the exec fail with ETXTBSY until that child execs.
        let mut attempts = 0;
        let mut child = loop {
            match std::process::Command::new(&program)
                .args(["-c", "echo running; read line"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
            {
                Err(error)
                    if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 50 =>
                {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                spawned => break spawned.unwrap(),
            }
        };
        // `spawn` can return before the child's exec gave it the script's name (until then its
        // comm is this test thread's name). The script's first line proves the exec happened.
        let mut running_line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.take().unwrap()),
            &mut running_line,
        )
        .unwrap();
        assert_eq!(running_line, "running\n", "the test process did not start");
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
