//! Every live process on this machine, for the kills that must reach what a process group kill
//! misses (a PTY's session, a launch guard's session). Zombies are skipped: they are already
//! dead and only wait for their parent to reap them. Linux reads `/proc`; macOS and the BSDs
//! have no `/proc` and listing pids needs FFI (`unsafe` is forbidden here), so `/bin/ps` lists
//! them.
//!
//! A list that could not be read is an error, never an empty list: an empty list is the proof
//! that a session is gone.

use std::time::Duration;

use nix::unistd::Pid;

/// Kill rounds of [`kill_session`]. Session members can fork while they are being killed, so
/// the session is re-scanned until it is empty.
const SESSION_KILL_ROUNDS: usize = 20;

#[cfg(target_os = "linux")]
pub(crate) fn live() -> std::io::Result<Vec<Pid>> {
    let mut pids = Vec::new();
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
            pids.push(Pid::from_raw(raw));
        }
    }
    Ok(pids)
}

/// Field 3 of `/proc/<pid>/stat`, after the parenthesised command, is the state. The command
/// is bytes, not text (Linux can cut a name inside a multibyte character), and may itself hold
/// `)`: the state follows the last one. A `stat` that cannot be parsed counts as live.
#[cfg(target_os = "linux")]
fn stat_is_zombie(stat: &[u8]) -> bool {
    stat.iter()
        .rposition(|byte| *byte == b')')
        .and_then(|end| {
            stat[end + 1..]
                .split(u8::is_ascii_whitespace)
                .find(|field| !field.is_empty())
        })
        .is_some_and(|state| state == b"Z")
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn live() -> std::io::Result<Vec<Pid>> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,stat="])
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other("`ps` could not list processes"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let raw = fields.next()?.parse::<i32>().ok()?;
            let zombie = fields.next().is_some_and(|state| state.starts_with('Z'));
            (raw > 1 && !zombie).then(|| Pid::from_raw(raw))
        })
        .collect())
}

/// Every live process whose session id is confirmed to be `sid`.
pub(crate) fn session_members(sid: Pid) -> std::io::Result<Vec<Pid>> {
    Ok(live()?
        .into_iter()
        .filter(|pid| nix::unistd::getsid(Some(*pid)) == Ok(sid))
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
/// The leader goes last, once a scan found no other member. When no round proved that, the
/// leader gets SIGTERM and SIGHUP instead (a shell exits on the hangup), and this returns
/// `false`: the caller must not kill the leader or its group by force either. `true` otherwise
/// (also when `leader` leads no session).
///
/// Only pids whose `getsid` matches are signalled, and never session 1 or the CLI's own session.
/// A process that calls `setsid()` itself starts a new session and escapes this kill; that is a
/// documented limit.
pub(crate) fn kill_session(leader: u32) -> bool {
    let Ok(raw) = i32::try_from(leader) else {
        return true;
    };
    if raw <= 1 {
        return true;
    }
    // The leader's session id is its pid. Either it is our unreaped child, or it was reaped just
    // now and the kernel does not hand out a pid that is still some session's id while members
    // remain; either way the pid cannot name an unrelated session. A zombie or reaped leader can
    // fail `getsid`; its session members are still confirmed one by one below.
    let sid = Pid::from_raw(raw);
    if nix::unistd::getsid(Some(sid)).is_ok_and(|actual| actual != sid) {
        return true;
    }
    if nix::unistd::getsid(None).is_ok_and(|own| own == sid) {
        return true;
    }
    let own_pid = nix::unistd::getpid();
    for round in 0..SESSION_KILL_ROUNDS {
        if let Ok(members) = session_members(sid) {
            // Listed, so confirmed to be the leader still (not a reused pid).
            let leader_live = members.contains(&sid);
            let others = members
                .into_iter()
                .filter(|pid| *pid != sid && *pid != own_pid)
                .collect::<Vec<_>>();
            if others.is_empty() {
                if leader_live {
                    let _ = nix::sys::signal::kill(sid, nix::sys::signal::Signal::SIGKILL);
                }
                return true;
            }
            for pid in others {
                let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
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
        let _ = nix::sys::signal::kill(sid, nix::sys::signal::Signal::SIGTERM);
        let _ = nix::sys::signal::kill(sid, nix::sys::signal::Signal::SIGHUP);
    }
    false
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    #[test]
    fn a_stat_is_read_as_bytes_up_to_the_last_parenthesis() {
        use super::stat_is_zombie;
        assert!(stat_is_zombie(b"42 (sleep) Z 1 42 42"));
        assert!(!stat_is_zombie(b"42 (sleep) S 1 42 42"));
        // A name cut inside a multibyte character, and one holding `) Z `.
        assert!(stat_is_zombie(b"42 (wsmp-\xc3) Z 1 42 42"));
        assert!(!stat_is_zombie(b"42 (a) Z (b) R 1 42 42"));
        assert!(!stat_is_zombie(b"garbage"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_scan_lists_a_process_whose_name_is_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // The kernel keeps the first 15 bytes of the file name: the name is cut inside `é`. A
        // script, not a copy of `sleep`: a multi-call coreutils binary picks its tool by name and
        // would exit at once under this one.
        let name = std::ffi::OsStr::from_bytes(b"wsmp-scantest-\xc3\xa9");
        let program = dir.path().join(name);
        std::fs::write(&program, "#!/bin/sh\nread line\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Another test thread can fork while the script is still open for writing, which makes
        // the exec fail with ETXTBSY until that child execs.
        let mut attempts = 0;
        let mut child = loop {
            match std::process::Command::new(&program)
                .stdin(std::process::Stdio::piped())
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
        let pid = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap());
        let comm = std::fs::read(format!("/proc/{pid}/comm")).unwrap();
        let listed = super::live();
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            std::str::from_utf8(&comm).is_err(),
            "the test needs a name that is not UTF-8: {comm:?}"
        );
        assert!(listed.unwrap().contains(&pid));
    }
}
