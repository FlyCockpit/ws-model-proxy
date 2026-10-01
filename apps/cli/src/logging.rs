//! Logging setup (tracing).
//!
//! Filtering precedence (highest first):
//!   1. `WSMP_LOG` env var (e.g. `WSMP_LOG=wsmp=debug,warn`)
//!   2. `RUST_LOG` env var
//!   3. `-v` / `-vv` / `--quiet` flags
//!
//! Logs go to **stderr** so they never corrupt machine-readable stdout (e.g.
//! `--json` output piped into `jq`).

use std::io::{IsTerminal, Write};

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::MakeWriterExt;

use crate::cli::LogFormat;

/// Initialize the global tracing subscriber. Call exactly once, early in
/// `main`. Safe to call before argument validation.
pub fn init(format: LogFormat, verbose: u8, quiet: bool) {
    let filter = env_filter("WSMP_LOG")
        .or_else(|| env_filter("RUST_LOG"))
        .unwrap_or_else(|| EnvFilter::new(default_directive(verbose, quiet)));

    // Always write logs to stderr; keep stdout clean for command output.
    let writer = std::io::stderr.with_max_level(tracing::Level::TRACE);
    let ansi = std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none();

    match format {
        LogFormat::Text => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_ansi(ansi)
            .with_target(false)
            .init(),
        LogFormat::Json => tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_ansi(ansi)
            .init(),
    }
}

fn env_filter(name: &str) -> Option<EnvFilter> {
    std::env::var_os(name)?;
    match EnvFilter::try_from_env(name) {
        Ok(filter) => Some(filter),
        Err(err) => {
            let _ = writeln!(
                std::io::stderr().lock(),
                "warning: ignoring invalid `{name}` filter: {err}"
            );
            None
        }
    }
}

/// Map the verbosity flags to an `EnvFilter` directive when no env var is set.
fn default_directive(verbose: u8, quiet: bool) -> String {
    if quiet {
        return "error".to_string();
    }
    match verbose {
        0 => "info",
        1 => "debug",
        _ => "trace",
    }
    .to_string()
}

// Keep an INFO-enabled dispatch alive for the entire test process. Otherwise a
// bare registry test can cache Never for a callsite while another thread uses a
// scoped capture subscriber. Only capture tests serialize; PTY/worker tests do not.
#[cfg(test)]
pub(crate) fn init_test_subscriber() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .with_writer(std::io::sink)
                .with_max_level(tracing::Level::INFO)
                .finish(),
        )
        .expect("test subscriber");
    });
}

#[cfg(test)]
pub(crate) fn test_capture_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    init_test_subscriber();
    guard
}
