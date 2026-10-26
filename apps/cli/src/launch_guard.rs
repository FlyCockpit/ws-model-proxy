//! The launch guard: every command a runtime step runs (`systemd-run`, `systemctl`, a
//! service's shell commands, an interactive step's command in its operator terminal) runs under
//! `wsmp __launch-guard`, so nothing it starts outlives the process that started it.
//!
//! A runner's idle answer proves that nothing of a rank runs, but it covers only what that
//! runner knows of. A daemon ended by SIGKILL (or the OOM killer) forgets every command it had
//! in flight: a `systemd-run` that has not submitted its unit yet, a macOS start shell (or a
//! helper it forked) that has not launched its service yet. A replacement daemon would answer
//! idle, and the command would launch after the server released the rank. The guard closes
//! that. It leads a session of its own (it starts one, or an operator terminal's PTY made it
//! the leader of one), and its scope is that session: everything the command started, in
//! whatever process group, except what moved out with `setsid`.
//! - It takes a shared lock on `relay-launchers.lock`, then checks that its parent is still the
//!   process that started it, and only then starts the command in its scope.
//! - Once the parent is gone (checked every [`POLL`]), once the command exited, or on SIGTERM,
//!   it SIGKILLs every process of its scope until none is left that it did not kill, and only
//!   then exits. So its lock is held while anything of the command can still run. A process
//!   list that cannot be read proves nothing, and neither does a kill that failed (a process of
//!   another user, say one `sudo` left behind): the guard keeps its lock and tries again, for
//!   as long as it takes. A replacement daemon then refuses to start, naming the lock. Once it
//!   starts ending its scope, it starts no command any more.
//! - A daemon takes that lock exclusively once at start ([`settle`]), right after its singleton
//!   lock and before it answers anything, so it starts only once every guard of an earlier
//!   daemon has ended. A guard of a dead daemon that took its lock only after that finds its
//!   parent gone and starts nothing.
//! - Whoever ends a guard from outside does it so that the lock outlasts the session:
//!   `bounded_run` (which starts the guard outside any group of its own, so it can start its
//!   session) and an operator terminal's close send it SIGTERM, never SIGKILL. Only a guard
//!   someone else SIGKILLs (the OOM killer) drops its lock early; whoever reaps it then kills its
//!   session.
//! - A guard the daemon stops waiting for while it is still ending its session (a kill it keeps
//!   retrying, a session someone else's kill of the guard left behind) is [`lingering`] until it
//!   has: meanwhile no rank of this node is proven idle (`runner`), since what the guard has not
//!   ended yet may still launch. Process ids name these processes; that a pid can be reused
//!   while cleanup waits is a documented limit.
//!
//! What a command moves out with `setsid` is not the guard's. On Linux the rank's slice still
//! holds it for the stop proof; on macOS only the service's status command proves anything.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

/// The hidden subcommand.
pub const SUBCOMMAND: &str = "__launch-guard";
/// How often a guard checks on its command and its parent.
pub const POLL: Duration = Duration::from_millis(25);
/// How long a starting daemon waits for an earlier daemon's guards to end.
pub const SETTLE_WAIT: Duration = Duration::from_secs(30);

/// The longest a lingering cleanup ([`linger`]) waits between checks. It starts at [`POLL`] and
/// doubles: most guards end within a few polls (a deadline's SIGTERM), and no rank is proven
/// idle until the cleanup notices.
const LINGER_POLL: Duration = Duration::from_secs(1);

/// Lingering cleanups of this daemon ([`linger`]).
static LINGERING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Whether a guard this daemon started may still be ending its session while nobody waits for
/// it: no rank is proven idle until it has.
pub fn lingering() -> bool {
    LINGERING.load(std::sync::atomic::Ordering::SeqCst) > 0
}

/// Runs `settled` on a thread of its own, at most [`LINGER_POLL`] apart, until it returns `true`;
/// [`lingering`] holds until then. Counted before this returns, so a step that hands its cleanup
/// over is never forgotten before the cleanup counts. With no thread to run it, the count stays
/// for good: nothing will prove the cleanup ended.
pub fn linger(mut settled: impl FnMut() -> bool + Send + 'static) {
    use std::sync::atomic::Ordering;
    LINGERING.fetch_add(1, Ordering::SeqCst);
    let _ = std::thread::Builder::new()
        .name("wsmp-linger".to_string())
        .spawn(move || {
            let mut wait = POLL;
            while !settled() {
                std::thread::sleep(wait);
                wait = (wait * 2).min(LINGER_POLL);
            }
            LINGERING.fetch_sub(1, Ordering::SeqCst);
        });
}

/// Serialises unit tests that make a cleanup linger with those that need no rank to be held up
/// by one ([`lingering`] is process-wide).
#[cfg(test)]
pub(crate) fn lingering_serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The session of a guard someone else killed (it could not end its session itself): killed
/// here, and [`linger`]ing until a scan proves it empty. `guard` is the guard as it was before it
/// was reaped.
#[cfg(unix)]
pub(crate) fn end_killed_session(guard: crate::process_list::Process) {
    if !crate::process_list::kill_session(guard) {
        linger(move || crate::process_list::kill_session(guard));
    }
}

/// SIGTERM to a launch guard: it ends its session itself, holding its lock until it has. One
/// that has not blocked the signal yet has started nothing, and the signal ends it. Nothing is
/// sent once `guard`'s pid names another process.
#[cfg(unix)]
pub(crate) fn terminate(guard: crate::process_list::Process) {
    let _ = guard.signal(nix::sys::signal::Signal::SIGTERM);
}

pub fn lock_path(state_dir: &Path) -> PathBuf {
    state_dir.join("relay-launchers.lock")
}

/// [`lock_path`] made absolute against this process's working directory (the daemon never
/// changes it), so a guard that runs elsewhere (an operator command starts in the home
/// directory) and the daemon's [`settle`] name the same file under a relative state directory.
fn absolute_lock(state_dir: &Path) -> Result<PathBuf> {
    let path = lock_path(state_dir);
    std::path::absolute(&path)
        .with_context(|| format!("resolving launcher lock `{}`", path.display()))
}

/// The launcher lock as a guard argument: [`absolute_lock`], and UTF-8, since the argument is
/// text and a rewritten name would be another file. A state directory that is not UTF-8 is
/// refused here, so no runtime command starts without the fence.
pub fn guard_lock_arg(state_dir: &Path) -> Result<String> {
    absolute_lock(state_dir)?
        .into_os_string()
        .into_string()
        .map_err(|path| {
            anyhow::anyhow!(
                "the relay state directory `{}` is not UTF-8; runtime commands need one that is",
                Path::new(&path).display()
            )
        })
}

/// `program args` as the guard runs it: `<wsmp> __launch-guard --parent <pid> --lock <path>
/// -- program args`. `lock` comes from [`guard_lock_arg`].
pub fn wrap(
    exe: &str,
    parent: u32,
    lock: &str,
    program: &str,
    args: &[String],
) -> (String, Vec<String>) {
    let mut wrapped = vec![
        SUBCOMMAND.to_owned(),
        "--parent".to_owned(),
        parent.to_string(),
        "--lock".to_owned(),
        lock.to_owned(),
        "--".to_owned(),
        program.to_owned(),
    ];
    wrapped.extend_from_slice(args);
    (exe.to_owned(), wrapped)
}

/// `program args` under the guard of this process. Unit tests run the program as is: their
/// binary is the test harness, which has no guard subcommand (`tests/launch_guard.rs` runs the
/// real one).
pub fn command(program: &str, args: &[String]) -> Result<(String, Vec<String>)> {
    if cfg!(test) {
        return Ok((program.to_owned(), args.to_vec()));
    }
    let lock = guard_lock_arg(&crate::paths::state_dir()?)?;
    // `/proc/self/exe` is this binary even after an upgrade replaced its file.
    let exe = if cfg!(target_os = "linux") {
        "/proc/self/exe".to_owned()
    } else {
        std::env::current_exe()
            .context("the wsmp binary could not be found")?
            .to_string_lossy()
            .into_owned()
    };
    Ok(wrap(&exe, std::process::id(), &lock, program, args))
}

#[cfg(unix)]
fn open_lock(path: &Path) -> Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| format!("opening launcher lock `{}`", path.display()))
}

/// Wait (at most `wait`) until no guard holds the launcher lock of `state_dir`: every command an
/// earlier daemon started has ended. Called once the singleton daemon lock is held, so no new
/// guard of another daemon can start meanwhile.
#[cfg(unix)]
pub fn settle(state_dir: &Path, wait: Duration) -> Result<()> {
    use nix::fcntl::{Flock, FlockArg};
    use std::time::Instant;
    let path = absolute_lock(state_dir)?;
    let mut file = open_lock(&path)?;
    let until = Instant::now() + wait;
    loop {
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            // Dropping the lock releases it: this daemon's own guards share it from now on.
            Ok(_lock) => return Ok(()),
            Err((back, nix::errno::Errno::EWOULDBLOCK)) if Instant::now() < until => {
                file = back;
                std::thread::sleep(POLL);
            }
            Err((_, nix::errno::Errno::EWOULDBLOCK)) => anyhow::bail!(
                "a runtime command of an earlier relay daemon still runs (it holds `{}`)",
                path.display()
            ),
            Err((_, error)) => {
                return Err(error)
                    .with_context(|| format!("locking launcher lock `{}`", path.display()));
            }
        }
    }
}

/// The guard itself (see the module docs). Never returns on success: it exits with the
/// command's status (128 + the signal for a command a signal ended).
#[cfg(unix)]
pub fn guard(parent: u32, lock: &Path, program: &OsString, args: &[OsString]) -> Result<()> {
    use nix::fcntl::{Flock, FlockArg};
    use nix::sys::signal::{SigSet, SigmaskHow, Signal, pthread_sigmask};
    use std::os::unix::process::{ExitStatusExt, parent_id};
    use std::process::Command;

    // Its scope is named by its own pid: it must lead its session. A PTY's command already
    // does; a process group leader cannot start one, so it is refused.
    let me = nix::unistd::getpid();
    if nix::unistd::getsid(None) != Ok(me) {
        nix::unistd::setsid().context("the launch guard needs a session of its own")?;
    }
    // A terminal's Ctrl-C or hangup is the command's to take, not the guard's, and SIGTERM is
    // taken by the ender thread below: all blocked here and in the threads (started below, they
    // inherit the mask). A spawned child starts with an empty mask.
    let mut blocked = SigSet::empty();
    for signal in [
        Signal::SIGINT,
        Signal::SIGQUIT,
        Signal::SIGHUP,
        Signal::SIGTERM,
    ] {
        blocked.add(signal);
    }
    pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&blocked), None)
        .context("blocking signals in the launch guard")?;
    let _lock = Flock::lock(open_lock(lock)?, FlockArg::LockShared)
        .map_err(|(_, error)| error)
        .with_context(|| format!("locking launcher lock `{}`", lock.display()))?;
    // Checked holding the lock: a settled replacement daemon never misses this guard.
    anyhow::ensure!(
        parent_id() == parent,
        "the process that started this command is gone"
    );
    // The watcher ends the scope once the parent is gone, the ender on SIGTERM; this thread
    // waits for the command. They start first, so no command runs unwatched. The command
    // starts holding `STARTING`, and whoever ends the scope (one of the three) takes it for good
    // first: a command starts before that, and so is ended by it, or never, and only one of
    // them exits.
    static STARTING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn end(code: i32) -> ! {
        let _closed = STARTING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        kill_scope();
        std::process::exit(code);
    }
    std::thread::Builder::new()
        .spawn(move || {
            loop {
                std::thread::sleep(POLL);
                if parent_id() != parent {
                    end(1);
                }
            }
        })
        .context("starting the launch guard's watcher")?;
    let mut terminate = SigSet::empty();
    terminate.add(Signal::SIGTERM);
    std::thread::Builder::new()
        .spawn(move || {
            loop {
                if terminate.wait() == Ok(Signal::SIGTERM) {
                    end(128 + Signal::SIGTERM as i32);
                }
            }
        })
        .context("starting the launch guard's ender")?;
    // stdio, environment, process group and session are the guard's.
    let spawned = {
        let _starting = STARTING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Command::new(program).args(args).spawn()
    };
    let mut child = spawned.with_context(|| format!("starting `{}`", program.to_string_lossy()))?;
    let status = child.wait();
    // What the command left behind in the scope goes before the lock does. Through `end`: when
    // the watcher or the ender is already ending the scope (it killed the command), its exit
    // is the guard's.
    let code = status
        .ok()
        .and_then(|status| {
            status
                .code()
                .or_else(|| status.signal().map(|signal| 128 + signal))
        })
        .unwrap_or(1);
    end(code);
}

/// SIGKILL every process of this guard's session but itself, until a scan finds none it has not
/// killed: a killed process runs nothing more, and what forked meanwhile is found by the next
/// scan. What it killed is remembered by pid and start time, so a process that got a killed
/// one's pid back (a long run of failed kills can see pids come round) is not taken for it.
/// A scan that fails is repeated, and so is a kill that failed (`EPERM`): it never returns
/// before a scan succeeded and found nothing it has not killed.
#[cfg(unix)]
fn kill_scope() {
    let me = nix::unistd::getpid();
    let mut signalled = std::collections::BTreeSet::new();
    loop {
        let Ok(members) = crate::process_list::session_members(me) else {
            std::thread::sleep(POLL);
            continue;
        };
        let fresh = members
            .into_iter()
            .filter(|member| member.pid != me && !signalled.contains(member))
            .collect::<Vec<_>>();
        if fresh.is_empty() {
            return;
        }
        let mut refused = false;
        for member in fresh {
            match member.signal(nix::sys::signal::SIGKILL) {
                Ok(()) => {
                    signalled.insert(member);
                }
                // Gone since the scan (its pid may name a later process: the next scan finds
                // that one).
                Err(nix::errno::Errno::ESRCH) => {}
                Err(_) => refused = true,
            }
        }
        if refused {
            std::thread::sleep(POLL);
        }
    }
}

#[cfg(not(unix))]
pub fn settle(_state_dir: &Path, _wait: Duration) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
pub fn guard(_parent: u32, _lock: &Path, _program: &OsString, _args: &[OsString]) -> Result<()> {
    anyhow::bail!("the launch guard runs on Unix only")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn wrap_puts_the_command_after_the_guard_arguments() {
        let (exe, args) = wrap(
            "/proc/self/exe",
            42,
            "/state/relay-launchers.lock",
            "env",
            &["--user".to_owned(), "--".to_owned()],
        );
        assert_eq!(exe, "/proc/self/exe");
        assert_eq!(
            args,
            [
                SUBCOMMAND,
                "--parent",
                "42",
                "--lock",
                "/state/relay-launchers.lock",
                "--",
                "env",
                "--user",
                "--",
            ]
        );
    }

    #[test]
    fn a_relative_state_directory_names_one_absolute_lock() {
        // The guard of an operator command runs from the home directory, the daemon from
        // wherever it started: both must lock the file the daemon's directory names.
        let lock = guard_lock_arg(Path::new("state")).unwrap();
        let expected = std::env::current_dir()
            .unwrap()
            .join("state")
            .join("relay-launchers.lock");
        assert_eq!(Path::new(&lock), expected);
        assert_eq!(absolute_lock(Path::new("state")).unwrap(), expected);
        let (_, args) = wrap("/proc/self/exe", 42, &lock, "env", &[]);
        assert_eq!(args[4], expected.to_str().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_state_directory_that_is_not_utf8_is_refused_not_rewritten() {
        use std::os::unix::ffi::OsStrExt;
        let dir = Path::new(std::ffi::OsStr::from_bytes(b"/state-\xff"));
        let error = guard_lock_arg(dir).unwrap_err();
        assert!(error.to_string().contains("not UTF-8"), "{error}");
    }

    #[test]
    fn a_cleanup_lingers_until_it_settles() {
        let _serial = lingering_serial();
        assert!(!lingering());
        let (settle_tx, settle_rx) = std::sync::mpsc::channel::<()>();
        linger(move || settle_rx.try_recv().is_ok());
        assert!(lingering(), "counted before `linger` returns");
        settle_tx.send(()).unwrap();
        let until = Instant::now() + LINGER_POLL * 3;
        while lingering() && Instant::now() < until {
            std::thread::sleep(POLL);
        }
        assert!(!lingering());
    }

    #[cfg(unix)]
    #[test]
    fn settle_waits_for_a_guard_holding_the_lock() {
        use nix::fcntl::{Flock, FlockArg};
        let dir = tempfile::tempdir().unwrap();
        let held = Flock::lock(
            open_lock(&lock_path(dir.path())).unwrap(),
            FlockArg::LockShared,
        )
        .map_err(|(_, error)| error)
        .unwrap();
        let error = settle(dir.path(), Duration::from_millis(100)).unwrap_err();
        assert!(error.to_string().contains("still runs"), "{error}");
        drop(held);
        settle(dir.path(), Duration::from_millis(100)).unwrap();
    }
}
