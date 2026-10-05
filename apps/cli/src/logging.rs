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
use tracing_subscriber::Layer;
use tracing_subscriber::filter::{FilterExt, LevelFilter, Targets};
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::cli::LogFormat;

/// HTTP and WebSocket client crates whose debug/trace output prints request
/// headers (the relay credential, engine API keys) or message bodies (relay
/// frames: model requests, completions, transcripts). Their `log` records
/// reach this subscriber through `tracing-log`. `-vv` and a broad
/// `RUST_LOG`/`WSMP_LOG=trace` cap them at INFO; a filter that names one of
/// them explicitly (e.g. `WSMP_LOG=tungstenite=trace`) is taken as a
/// deliberate choice and lifts that crate's cap.
const QUIET_CRATES: &[&str] = &[
    "tungstenite",
    "ureq",
    "ureq_proto",
    "reqwest",
    "hyper",
    "hyper_util",
];

/// Initialize the global tracing subscriber. Call exactly once, early in
/// `main`. Safe to call before argument validation.
pub fn init(format: LogFormat, verbose: u8, quiet: bool) {
    let (filter, user_filter) = match env_filter("WSMP_LOG").or_else(|| env_filter("RUST_LOG")) {
        Some((filter, text)) => (filter, Some(text)),
        None => (EnvFilter::new(default_directive(verbose, quiet)), None),
    };
    // Both must enable an event, so the cap only ever lowers verbosity.
    let filter = filter.and(quiet_dependencies(user_filter.as_deref()));

    // Always write logs to stderr; keep stdout clean for command output.
    let writer = std::io::stderr.with_max_level(tracing::Level::TRACE);
    let ansi = std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none();

    match format {
        LogFormat::Text => tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer)
                    .with_ansi(ansi)
                    .with_target(false)
                    .with_filter(filter),
            )
            .init(),
        LogFormat::Json => tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .json()
                    .with_writer(writer)
                    .with_ansi(ansi)
                    .with_filter(filter),
            )
            .init(),
    }
}

/// INFO for every `QUIET_CRATES` entry the user's filter does not name.
fn quiet_dependencies(user_filter: Option<&str>) -> Targets {
    QUIET_CRATES.iter().fold(
        Targets::new().with_default(LevelFilter::TRACE),
        |targets, name| {
            let named = user_filter.is_some_and(|filter| names_target(filter, name));
            // An explicit TRACE entry also keeps a shorter prefix (`hyper`)
            // from capping a named longer one (`hyper_util`).
            let level = if named {
                LevelFilter::TRACE
            } else {
                LevelFilter::INFO
            };
            targets.with_target(*name, level)
        },
    )
}

/// Whether an `EnvFilter` directive string names `crate_name` (or a module
/// in it) as a target.
fn names_target(filter: &str, crate_name: &str) -> bool {
    filter.split(',').any(|directive| {
        let target = directive.split(['[', '=']).next().unwrap_or("").trim();
        target == crate_name
            || target
                .strip_prefix(crate_name)
                .is_some_and(|rest| rest.starts_with("::"))
    })
}

/// The filter in env var `name` and its text, or `None` (with a warning when
/// it is set but unusable).
fn env_filter(name: &str) -> Option<(EnvFilter, String)> {
    let text = match std::env::var(name) {
        Ok(text) => text,
        Err(std::env::VarError::NotPresent) => return None,
        Err(err) => {
            warn_invalid(name, &err);
            return None;
        }
    };
    match EnvFilter::try_new(&text) {
        Ok(filter) => Some((filter, text)),
        Err(err) => {
            warn_invalid(name, &err);
            None
        }
    }
}

fn warn_invalid(name: &str, err: &dyn std::fmt::Display) {
    let _ = writeln!(
        std::io::stderr().lock(),
        "warning: ignoring invalid `{name}` filter: {err}"
    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Level;

    #[test]
    fn names_target_matches_whole_crate_names_and_their_modules() {
        assert!(names_target("tungstenite=trace", "tungstenite"));
        assert!(names_target(
            "warn, tungstenite::protocol=debug",
            "tungstenite"
        ));
        assert!(names_target("tungstenite", "tungstenite"));
        assert!(names_target("hyper[conn]=trace", "hyper"));
        assert!(!names_target("trace", "tungstenite"));
        assert!(!names_target("wsmp=trace,debug", "tungstenite"));
        assert!(!names_target("tokio_tungstenite=trace", "tungstenite"));
        assert!(!names_target("hyper_util=trace", "hyper"));
    }

    #[test]
    fn broad_filters_cap_http_and_websocket_clients_at_info() {
        for user in [None, Some("trace"), Some("wsmp=trace,trace")] {
            let targets = quiet_dependencies(user);
            for target in [
                "tungstenite::handshake::client",
                "ureq_proto::client",
                "reqwest::connect",
                "hyper_util::client",
            ] {
                assert!(
                    targets.would_enable(target, &Level::INFO),
                    "{user:?} {target}"
                );
                assert!(
                    !targets.would_enable(target, &Level::DEBUG),
                    "{user:?} {target}"
                );
            }
            assert!(targets.would_enable("wsmp::daemon", &Level::TRACE));
        }
    }

    #[test]
    fn an_explicitly_named_client_crate_is_not_capped() {
        let targets = quiet_dependencies(Some("trace,tungstenite=trace,hyper_util=trace"));
        assert!(targets.would_enable("tungstenite::protocol", &Level::TRACE));
        assert!(targets.would_enable("hyper_util::client", &Level::TRACE));
        assert!(!targets.would_enable("hyper::proto", &Level::DEBUG));
        assert!(!targets.would_enable("ureq::run", &Level::DEBUG));
    }
}
