//! Graceful relay shutdown on SIGTERM, SIGINT, and SIGHUP.
//!
//! [`install`] blocks those signals in the calling thread before any other
//! thread exists, so every later thread inherits the mask and none of them
//! can be killed by the default action. One dedicated thread takes the
//! signals with `sigwait` (no handler, so no `unsafe`). The relay loop polls
//! [`requested`] and unwinds through its normal cleanup: every exec process
//! group and terminal session is killed, the server hears `exec.done` /
//! `term.exit` and a close frame, and the control socket and PID file guards
//! drop. The process then dies from the same signal, so the parent sees the
//! conventional status (143, 130, 129).
//!
//! Cleanup is bounded by [`SHUTDOWN_DEADLINE`]. When it expires, or when a
//! second signal arrives, the watcher kills every tracked child directly,
//! removes the registered runtime files, and exits at once.
//!
//! Children never inherit the blocked mask: `std::process::Command` and
//! `portable-pty` both reset it before `exec`.
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

/// End the process the way `signal` would have: re-raise it with its default
/// action, falling back to exit status `128 + signal`.
pub fn terminate_by_signal(signal: i32) -> ! {
    #[cfg(unix)]
    unix::raise_default(signal);
    std::process::exit(128_i32.saturating_add(signal))
}

#[cfg(unix)]
pub use unix::{ExitCleanup, install, register_exit_cleanup, requested};

#[cfg(not(unix))]
pub use fallback::{ExitCleanup, install, register_exit_cleanup, requested};

#[cfg(unix)]
mod unix {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock, PoisonError};
    use std::thread;
    use std::time::Instant;

    use anyhow::{Context, Result};
    use nix::sys::signal::{SigSet, Signal};

    use super::SHUTDOWN_DEADLINE;

    type Cleanup = Box<dyn Fn() + Send>;

    /// The first shutdown signal, or 0.
    static REQUESTED: AtomicI32 = AtomicI32::new(0);
    static INSTALLED: OnceLock<()> = OnceLock::new();
    static CLEANUPS: Mutex<BTreeMap<u64, Cleanup>> = Mutex::new(BTreeMap::new());
    static NEXT_CLEANUP: AtomicU64 = AtomicU64::new(1);

    /// Start taking shutdown signals. Call from the main thread before any
    /// other thread is spawned; threads that already exist keep the default
    /// action. Later calls are no-ops.
    pub fn install() -> Result<()> {
        if INSTALLED.get().is_some() {
            return Ok(());
        }
        let signals = shutdown_signals();
        signals
            .thread_block()
            .context("blocking shutdown signals for the relay")?;
        thread::Builder::new()
            .name("wsmp-signals".to_string())
            .spawn(move || watch(signals))
            .context("starting the shutdown signal thread")?;
        let _ = INSTALLED.set(());
        Ok(())
    }

    /// The first shutdown signal received, if any.
    pub fn requested() -> Option<i32> {
        match REQUESTED.load(Ordering::SeqCst) {
            0 => None,
            signal => Some(signal),
        }
    }

    /// SIGTERM, SIGINT, and SIGHUP, minus any the relay inherited as ignored
    /// (`nohup`, or a background job of a non-interactive shell). Blocking an
    /// ignored signal would let `sigwait` accept it on Linux and undo that
    /// choice.
    fn shutdown_signals() -> SigSet {
        let mut signals = SigSet::empty();
        for signal in [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP] {
            if !inherited_ignored(signal) {
                signals.add(signal);
            }
        }
        signals
    }

    #[cfg(target_os = "linux")]
    fn inherited_ignored(signal: Signal) -> bool {
        let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
            return false;
        };
        let bit = 1_u64 << ((signal as u32).saturating_sub(1) & 63);
        status
            .lines()
            .find_map(|line| line.strip_prefix("SigIgn:"))
            .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())
            .is_some_and(|mask| mask & bit != 0)
    }

    /// Other kernels discard a signal whose action is SIG_IGN even while it
    /// is blocked, so an inherited ignore keeps working without a check.
    #[cfg(not(target_os = "linux"))]
    fn inherited_ignored(_signal: Signal) -> bool {
        false
    }

    fn watch(signals: SigSet) {
        loop {
            let Ok(signal) = signals.wait() else {
                continue;
            };
            let number = signal as i32;
            if REQUESTED
                .compare_exchange(0, number, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                tracing::info!(
                    signal = %signal,
                    deadline_secs = SHUTDOWN_DEADLINE.as_secs(),
                    "shutdown signal received; stopping terminals and commands"
                );
                start_deadline(number);
                continue;
            }
            tracing::warn!(
                signal = %signal,
                "second shutdown signal received; exiting now"
            );
            force_exit(requested().unwrap_or(number));
        }
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
    fn force_exit(signal: i32) -> ! {
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

    /// Unblock `signal` in this thread and raise it. With the default action
    /// still in place this terminates the whole process.
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
        fn exit_cleanups_run_until_their_guard_drops() {
            use std::sync::Arc;
            use std::sync::atomic::AtomicUsize;

            let runs = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&runs);
            let guard = register_exit_cleanup(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            });
            run_exit_cleanups();
            assert_eq!(runs.load(Ordering::SeqCst), 1);
            drop(guard);
            run_exit_cleanups();
            assert_eq!(
                runs.load(Ordering::SeqCst),
                1,
                "a dropped guard unregisters"
            );
        }

        #[test]
        fn shutdown_signals_skip_only_inherited_ignores() {
            let signals = shutdown_signals();
            for signal in [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP] {
                assert_eq!(signals.contains(signal), !inherited_ignored(signal));
            }
        }
    }
}

/// Signals are not handled here yet: Ctrl-C keeps the platform default.
#[cfg(not(unix))]
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
