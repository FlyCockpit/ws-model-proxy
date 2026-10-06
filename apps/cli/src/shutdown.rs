//! Graceful relay shutdown on SIGTERM, SIGINT, and SIGHUP, and on Windows
//! on Ctrl-C, Ctrl-Break, console close, and system shutdown.
//!
//! On Unix, [`install`] registers those signals with tokio's handler, which
//! one dedicated thread drives. Nothing blocks them: every thread, and every
//! child the relay starts, keeps an empty signal mask. (std hands a child the
//! caller's mask unchanged, and bash keeps an inherited mask for everything
//! it runs, so a blocked mask would make exec commands, metric sources, and
//! deployment start/stop commands immune to `kill`, `timeout`, and `pkill`.)
//! The relay loop polls [`requested`] and unwinds through its normal
//! cleanup: every exec process group and terminal session is killed, the
//! server hears `exec.done` / `term.exit` and a close frame, and the control
//! socket and PID file guards drop. The process then dies from the same
//! signal, so the parent sees the conventional status (143, 130, 129).
//! Because a handler stays installed, dying from the signal re-executes this
//! binary in a mode that only raises it (see [`terminate_by_signal`]).
//!
//! A signal can land on any thread, so a blocking call with a timeout may
//! fail once with `EINTR` (`ErrorKind::Interrupted`). Relay socket reads treat
//! that like their poll timeout.
//!
//! Telemetry runs (`nvidia-smi` and custom metric commands) are killed with
//! their process groups on every way out, through
//! [`crate::bounded_run::kill_all_active`].
//!
//! Cleanup is bounded by [`SHUTDOWN_DEADLINE`]. When it expires, or when a
//! second signal arrives, the watcher kills every tracked child directly,
//! removes the registered runtime files, and exits at once.
//!
//! Windows takes console control events through tokio's handler on its own
//! thread and follows the same path: flag, deadline, forced kill of tracked
//! exec commands, then exit with status `128 + n`.
//!
//! SIGKILL cannot be caught. It is the one way to stop the relay that can
//! leave exec commands and terminal processes running.

use std::fmt;
use std::time::Duration;

/// How long normal cleanup may run after the first signal.
pub const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(5);

/// The relay stopped because a shutdown signal arrived. `main` turns this into
/// the conventional exit status instead of printing an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShutdownRequested {
    pub signal: i32,
}

impl fmt::Display for ShutdownRequested {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "relay stopped by signal {}", self.signal)
    }
}

impl std::error::Error for ShutdownRequested {}

/// The signal carried by a [`ShutdownRequested`] anywhere in `err`.
pub fn signal_of(err: &anyhow::Error) -> Option<i32> {
    err.chain()
        .find_map(|cause| cause.downcast_ref::<ShutdownRequested>())
        .map(|shutdown| shutdown.signal)
}

/// End the process the way `signal` would have, falling back to exit status
/// `128 + signal`.
///
/// On Unix the relay's handler for `signal` cannot be reset without
/// `unsafe`, so once [`install`] has run this re-executes the binary (same
/// PID) with [`DIE_BY_SIGNAL_ARG`]: `exec` puts caught signals back to
/// their default action, and the new image raises `signal` at once (see
/// [`die_if_reexecuted`]). A service manager then sees a death by SIGTERM
/// (a clean stop to systemd) rather than exit status 143.
pub fn terminate_by_signal(signal: i32) -> ! {
    #[cfg(unix)]
    unix::die_by(signal);
    std::process::exit(128_i32.saturating_add(signal))
}

/// First argument of the re-executed image that only dies from a signal.
/// Not a command: [`die_if_reexecuted`] handles it before argument parsing.
#[cfg(unix)]
pub const DIE_BY_SIGNAL_ARG: &str = "__wsmp-die-by-signal";

/// Call first in `main`. When this image was started by
/// [`terminate_by_signal`], raise the signal it names and never return.
pub fn die_if_reexecuted() {
    #[cfg(unix)]
    {
        let args = std::env::args_os().skip(1).collect::<Vec<_>>();
        let [mode, signal] = args.as_slice() else {
            return;
        };
        if mode != DIE_BY_SIGNAL_ARG {
            return;
        }
        let Some(signal) = signal
            .to_str()
            .and_then(|signal| signal.parse::<i32>().ok())
        else {
            return;
        };
        unix::raise_default(signal);
        std::process::exit(128_i32.saturating_add(signal))
    }
}

#[cfg(any(unix, windows))]
pub use tracked::{ExitCleanup, register_exit_cleanup, requested};

#[cfg(unix)]
pub use unix::install;

#[cfg(windows)]
pub use windows::install;

#[cfg(not(any(unix, windows)))]
pub use fallback::{ExitCleanup, install, register_exit_cleanup, requested};

/// State shared by the platform watchers: the first request, the deadline,
/// the forced exit, and the runtime-file cleanups it runs.
#[cfg(any(unix, windows))]
mod tracked {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
    use std::sync::{Mutex, PoisonError};
    use std::thread;
    use std::time::Instant;

    use super::SHUTDOWN_DEADLINE;

    type Cleanup = Box<dyn Fn() + Send>;

    /// The first shutdown signal, or 0.
    static REQUESTED: AtomicI32 = AtomicI32::new(0);
    static CLEANUPS: Mutex<BTreeMap<u64, Cleanup>> = Mutex::new(BTreeMap::new());
    static NEXT_CLEANUP: AtomicU64 = AtomicU64::new(1);

    /// The first shutdown signal received, if any.
    pub fn requested() -> Option<i32> {
        match REQUESTED.load(Ordering::SeqCst) {
            0 => None,
            signal => Some(signal),
        }
    }

    /// A shutdown request arrived. The first starts graceful cleanup under
    /// [`SHUTDOWN_DEADLINE`]; a second one exits at once.
    pub(super) fn receive(number: i32, name: &str) {
        if REQUESTED
            .compare_exchange(0, number, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            tracing::info!(
                signal = name,
                deadline_secs = SHUTDOWN_DEADLINE.as_secs(),
                "shutdown signal received; stopping terminals and commands"
            );
            // Telemetry commands need no grace: end them (and refuse new ones) now.
            crate::bounded_run::kill_all_active();
            start_deadline(number);
            return;
        }
        tracing::warn!(
            signal = name,
            "second shutdown signal received; exiting now"
        );
        force_exit(requested().unwrap_or(number));
    }

    fn start_deadline(signal: i32) {
        let deadline = Instant::now() + SHUTDOWN_DEADLINE;
        let spawned = thread::Builder::new()
            .name("wsmp-shutdown-deadline".to_string())
            .spawn(move || {
                // `sleep` can wake early on some platforms; loop to the instant.
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    thread::sleep(remaining);
                }
                tracing::warn!(
                    deadline_secs = SHUTDOWN_DEADLINE.as_secs(),
                    "relay cleanup did not finish before the shutdown deadline; exiting now"
                );
                force_exit(signal);
            });
        if spawned.is_err() {
            // No deadline thread: cleanup is unbounded, so do not wait on it.
            force_exit(signal);
        }
    }

    /// Best-effort synchronous cleanup, then exit without unwinding.
    pub(super) fn force_exit(signal: i32) -> ! {
        crate::sessions::kill_tracked_children();
        run_exit_cleanups();
        super::terminate_by_signal(signal)
    }

    fn run_exit_cleanups() {
        // A cleanup that panicked while registered must not stop the others.
        let cleanups = CLEANUPS.lock().unwrap_or_else(PoisonError::into_inner);
        for cleanup in cleanups.values() {
            cleanup();
        }
    }

    /// Removes its cleanup when dropped. The owner's normal `Drop` does the
    /// real work; this is only for a forced exit that skips destructors.
    #[must_use = "the cleanup is unregistered when this guard drops"]
    pub struct ExitCleanup(u64);

    #[cfg(all(test, unix))]
    impl ExitCleanup {
        pub(crate) fn run_registered(&self) {
            let cleanups = CLEANUPS.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(cleanup) = cleanups.get(&self.0) {
                cleanup();
            }
        }
    }

    impl Drop for ExitCleanup {
        fn drop(&mut self) {
            CLEANUPS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.0);
        }
    }

    /// Run `cleanup` if the process is forced to exit before the returned
    /// guard drops. Keep it short and non-blocking: it runs on the way out.
    pub fn register_exit_cleanup(cleanup: impl Fn() + Send + 'static) -> ExitCleanup {
        let id = NEXT_CLEANUP.fetch_add(1, Ordering::Relaxed);
        CLEANUPS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, Box::new(cleanup));
        ExitCleanup(id)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn exit_cleanups_run_until_their_guard_drops() {
            use std::sync::Arc;
            use std::sync::atomic::AtomicUsize;

            let runs = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&runs);
            let guard = register_exit_cleanup(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            });
            let id = guard.0;
            // A process-wide cleanup is only safe on the way out. Other tests
            // can own live runtime files, so invoke only this registration.
            let run_registered_cleanup = || {
                let cleanups = CLEANUPS.lock().unwrap_or_else(PoisonError::into_inner);
                if let Some(cleanup) = cleanups.get(&id) {
                    cleanup();
                }
            };
            run_registered_cleanup();
            assert_eq!(runs.load(Ordering::SeqCst), 1);
            drop(guard);
            run_registered_cleanup();
            assert_eq!(
                runs.load(Ordering::SeqCst),
                1,
                "a dropped guard unregisters"
            );
        }
    }
}

#[cfg(unix)]
mod unix {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    use anyhow::{Context, Result};
    use nix::sys::signal::{SigSet, Signal};
    use tokio::signal::unix::{SignalKind, signal};

    /// Set once tokio's handler is in place for the shutdown signals.
    static INSTALLED: OnceLock<()> = OnceLock::new();
    /// Set the moment tokio's handler replaces the default action for any
    /// shutdown signal, before the watcher thread exists: from then on only
    /// a re-executed image can die from the signal (see [`die_by`]).
    static HANDLER_INSTALLED: AtomicBool = AtomicBool::new(false);

    /// Start taking shutdown signals. The handlers are registered before
    /// this returns, so a signal that lands later (even before the watcher
    /// thread runs) starts a graceful shutdown instead of the default
    /// action. Later calls are no-ops.
    ///
    /// Nothing is blocked: threads and children keep their signal mask.
    pub fn install() -> Result<()> {
        if INSTALLED.get().is_some() {
            return Ok(());
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("starting the shutdown signal runtime")?;
        let listeners = {
            let _entered = runtime.enter();
            shutdown_signals()
                .into_iter()
                .map(|kind| {
                    let listener = signal(SignalKind::from_raw(kind as i32))
                        .with_context(|| format!("listening for {}", kind.as_str()))?;
                    HANDLER_INSTALLED.store(true, Ordering::SeqCst);
                    Ok((kind, listener))
                })
                .collect::<Result<Vec<_>>>()?
        };
        thread::Builder::new()
            .name("wsmp-signals".to_string())
            .spawn(move || {
                runtime.block_on(async move {
                    for (kind, mut listener) in listeners {
                        tokio::spawn(async move {
                            while listener.recv().await.is_some() {
                                super::tracked::receive(kind as i32, kind.as_str());
                            }
                        });
                    }
                    std::future::pending::<()>().await;
                });
            })
            .context("starting the shutdown signal thread")?;
        let _ = INSTALLED.set(());
        Ok(())
    }

    /// SIGTERM, SIGINT, and SIGHUP, minus any the relay inherited as ignored
    /// (`nohup`, as `wsmp daemon start` uses, or a background job of a
    /// non-interactive shell). Installing a handler would undo that choice.
    fn shutdown_signals() -> Vec<Signal> {
        let ignored = inherited_ignored_mask();
        [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP]
            .into_iter()
            .filter(|signal| ignored & signal_bit(*signal) == 0)
            .collect()
    }

    /// The bit for `signal` in a kernel signal mask.
    fn signal_bit(signal: Signal) -> u64 {
        1_u64 << ((signal as u32).saturating_sub(1) & 63)
    }

    /// The signals this process inherited as ignored, from the kernel's
    /// view of this process. Nothing has replaced an action yet.
    #[cfg(target_os = "linux")]
    fn inherited_ignored_mask() -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix("SigIgn:"))
                    .and_then(parse_mask)
            })
            .unwrap_or(0)
    }

    /// Without `/proc`, ask `ps` (BSD `sigignore`, a hex mask); reading the
    /// action directly takes `sigaction`, which needs `unsafe`. When `ps`
    /// fails, assume nothing is ignored.
    #[cfg(not(target_os = "linux"))]
    fn inherited_ignored_mask() -> u64 {
        std::process::Command::new("/bin/ps")
            .args(["-o", "sigignore=", "-p"])
            .arg(std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| parse_mask(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or(0)
    }

    fn parse_mask(text: &str) -> Option<u64> {
        let text = text.trim();
        let text = text
            .strip_prefix("0x")
            .or_else(|| text.strip_prefix("0X"))
            .unwrap_or(text);
        u64::from_str_radix(text, 16).ok()
    }

    /// End the process with `signal`. Once the handler is installed only a
    /// new image has the default action back; if `exec` fails the caller
    /// falls back to an exit status.
    pub(super) fn die_by(signal: i32) {
        if HANDLER_INSTALLED.load(Ordering::SeqCst) {
            reexec_to_raise(signal);
        } else {
            raise_default(signal);
        }
    }

    /// Replace this image (same PID, so the parent still waits on it) with
    /// one that raises `signal` before doing anything else. Linux uses
    /// `/proc/self/exe`, which still works after the binary was replaced
    /// on disk. Returns only when `exec` failed.
    fn reexec_to_raise(signal: i32) {
        use std::os::unix::process::CommandExt;
        let exe = if cfg!(target_os = "linux") {
            std::path::PathBuf::from("/proc/self/exe")
        } else {
            match std::env::current_exe() {
                Ok(exe) => exe,
                Err(_) => return,
            }
        };
        let _error = std::process::Command::new(exe)
            .arg(super::DIE_BY_SIGNAL_ARG)
            .arg(signal.to_string())
            .exec();
    }

    /// Unblock `signal` in this thread and raise it. With the default action
    /// in place this terminates the whole process.
    pub(super) fn raise_default(signal: i32) {
        let Ok(signal) = Signal::try_from(signal) else {
            return;
        };
        let mut set = SigSet::empty();
        set.add(signal);
        if set.thread_unblock().is_ok() {
            let _ = nix::sys::signal::raise(signal);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn shutdown_signals_skip_only_inherited_ignores() {
            let signals = shutdown_signals();
            let ignored = inherited_ignored_mask();
            for signal in [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP] {
                assert_eq!(signals.contains(&signal), ignored & signal_bit(signal) == 0);
            }
        }

        #[test]
        fn signal_masks_parse_with_or_without_a_prefix() {
            assert_eq!(parse_mask(" 0000000000001000\n"), Some(0x1000));
            assert_eq!(parse_mask("0x1"), Some(1));
            assert_eq!(parse_mask(""), None);
            assert_eq!(signal_bit(Signal::SIGHUP), 1);
            assert_eq!(
                signal_bit(Signal::SIGTERM)
                    | signal_bit(Signal::SIGINT)
                    | signal_bit(Signal::SIGHUP),
                0x4003
            );
        }
    }
}

/// Console control events through tokio's handler. Ctrl-C and Ctrl-Break
/// start the same bounded shutdown as SIGINT on Unix; closing the console
/// window or a system shutdown does too, within the time Windows allows.
#[cfg(windows)]
mod windows {
    use std::sync::OnceLock;
    use std::thread;

    use anyhow::{Context, Result};
    use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_shutdown};

    /// Exit statuses follow the Unix convention (`128 + n`): SIGINT for
    /// Ctrl-C, SIGBREAK (21 in the Windows C runtime) for Ctrl-Break, and
    /// SIGTERM for a console close or system shutdown.
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;
    const SIGBREAK: i32 = 21;

    static INSTALLED: OnceLock<()> = OnceLock::new();

    /// Start taking console control events. The listeners are registered
    /// before this returns, so the platform default (immediate exit) no
    /// longer applies. Later calls are no-ops.
    pub fn install() -> Result<()> {
        if INSTALLED.get().is_some() {
            return Ok(());
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("starting the console control runtime")?;
        let (mut interrupt, mut brk, close, shutdown) = {
            let _entered = runtime.enter();
            let interrupt = ctrl_c().context("listening for Ctrl-C")?;
            let brk = ctrl_break().context("listening for Ctrl-Break")?;
            // Best effort: without these the platform default still ends the
            // relay when the console closes or the system shuts down.
            let close = ctrl_close().ok();
            let shutdown = ctrl_shutdown().ok();
            (interrupt, brk, close, shutdown)
        };
        thread::Builder::new()
            .name("wsmp-signals".to_string())
            .spawn(move || {
                runtime.block_on(async move {
                    let mut close = close;
                    let mut shutdown = shutdown;
                    loop {
                        tokio::select! {
                            Some(()) = interrupt.recv() => {
                                super::tracked::receive(SIGINT, "CTRL_C");
                            }
                            Some(()) = brk.recv() => {
                                super::tracked::receive(SIGBREAK, "CTRL_BREAK");
                            }
                            Some(()) = recv_optional(close.as_mut().map(|c| c.recv())) => {
                                super::tracked::receive(SIGTERM, "CTRL_CLOSE");
                            }
                            Some(()) = recv_optional(shutdown.as_mut().map(|s| s.recv())) => {
                                super::tracked::receive(SIGTERM, "CTRL_SHUTDOWN");
                            }
                            else => break,
                        }
                    }
                });
            })
            .context("starting the shutdown signal thread")?;
        let _ = INSTALLED.set(());
        Ok(())
    }

    /// A listener that failed to register never fires.
    async fn recv_optional<F>(recv: Option<F>) -> Option<()>
    where
        F: std::future::Future<Output = Option<()>>,
    {
        match recv {
            Some(recv) => recv.await,
            None => std::future::pending().await,
        }
    }
}

/// Signals are not handled on this platform: the default action applies.
#[cfg(not(any(unix, windows)))]
mod fallback {
    use anyhow::Result;

    pub struct ExitCleanup;

    pub fn install() -> Result<()> {
        Ok(())
    }

    pub fn requested() -> Option<i32> {
        None
    }

    pub fn register_exit_cleanup(_cleanup: impl Fn() + Send + 'static) -> ExitCleanup {
        ExitCleanup
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_of_finds_the_shutdown_marker_through_context() {
        let err = anyhow::Error::new(ShutdownRequested { signal: 15 }).context("relay stopped");
        assert_eq!(signal_of(&err), Some(15));
        assert_eq!(signal_of(&anyhow::anyhow!("other")), None);
    }
}
