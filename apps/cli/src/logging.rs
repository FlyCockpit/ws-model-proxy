//! Logging setup (tracing).
//!
//! Filtering precedence (highest first):
//!   1. `WSMP_LOG` env var (e.g. `WSMP_LOG=wsmp=debug,warn`)
//!   2. `RUST_LOG` env var
//!   3. `-v` / `-vv` / `--quiet` flags
//!
//! Logs go to **stderr** so they never corrupt machine-readable stdout (e.g.
//! `--json` output piped into `jq`). `wsmp run --log-file` also writes them
//! to a file ([`RollingFile`]), for a service manager that keeps no log of
//! its own (Windows Task Scheduler).

use std::fs::{File, OpenOptions};
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::Layer;
use tracing_subscriber::filter::{FilterExt, LevelFilter, Targets};
use tracing_subscriber::fmt::writer::{BoxMakeWriter, MakeWriterExt};
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
pub fn init(format: LogFormat, verbose: u8, quiet: bool, log_file: Option<&Path>) {
    let (filter, user_filter) = match env_filter("WSMP_LOG").or_else(|| env_filter("RUST_LOG")) {
        Some((filter, text)) => (filter, Some(text)),
        None => (EnvFilter::new(default_directive(verbose, quiet)), None),
    };
    // Both must enable an event, so the cap only ever lowers verbosity.
    let filter = filter.and(quiet_dependencies(user_filter.as_deref()));

    // Always write logs to stderr; keep stdout clean for command output.
    let stderr = std::io::stderr.with_max_level(tracing::Level::TRACE);
    let file = log_file.and_then(|path| match RollingFile::open(path) {
        Ok(file) => Some(file),
        Err(error) => {
            warn_invalid("--log-file", &format!("`{}`: {error}", path.display()));
            None
        }
    });
    // No colour codes in a file.
    let ansi =
        file.is_none() && std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none();
    let writer = match file {
        Some(file) => BoxMakeWriter::new(stderr.and(Mutex::new(file))),
        None => BoxMakeWriter::new(stderr),
    };

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

/// Size of `relay.log` before it rolls over.
const LOG_FILE_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// How many rolled-over files (`.1` newest … `.4` oldest) are kept.
const LOG_FILE_KEEP: usize = 4;

/// An append-only log file that rolls over by size: `x.log` becomes
/// `x.log.1`, which becomes `x.log.2`, and so on; the oldest is dropped.
/// A reader holding the file open (`wsmp service logs --follow`) does not
/// block the rename: std opens files with `FILE_SHARE_DELETE` on Windows.
pub struct RollingFile {
    path: PathBuf,
    file: File,
    size: u64,
    max_bytes: u64,
    keep: usize,
}

impl RollingFile {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        Self::with_limits(path, LOG_FILE_MAX_BYTES, LOG_FILE_KEEP)
    }

    fn with_limits(path: &Path, max_bytes: u64, keep: usize) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path: path.to_path_buf(),
            file,
            size,
            max_bytes,
            keep,
        })
    }

    fn rolled(&self, index: usize) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{index}"));
        PathBuf::from(name)
    }

    fn roll_over(&mut self) -> std::io::Result<()> {
        let _ = std::fs::remove_file(self.rolled(self.keep));
        for index in (1..self.keep).rev() {
            let from = self.rolled(index);
            if from.exists() {
                std::fs::rename(&from, self.rolled(index + 1))?;
            }
        }
        std::fs::rename(&self.path, self.rolled(1))?;
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        self.size = 0;
        Ok(())
    }
}

impl Write for RollingFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.size > 0 && self.size.saturating_add(buf.len() as u64) > self.max_bytes {
            // A failed rename keeps appending to the current file; the next
            // attempt comes after another `max_bytes`.
            if self.roll_over().is_err() {
                self.size = 0;
            }
        }
        let written = self.file.write(buf)?;
        self.size = self.size.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
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
    fn the_log_file_rolls_over_by_size_and_keeps_the_newest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("logs").join("relay.log");
        let mut log = RollingFile::with_limits(&path, 10, 2).expect("open");
        for line in ["aaaaaaaa\n", "bbbbbbbb\n", "cccccccc\n", "dddddddd\n"] {
            log.write_all(line.as_bytes()).expect("write");
        }
        let read = |path: &Path| std::fs::read_to_string(path).expect("read");
        assert_eq!(read(&path), "dddddddd\n");
        assert_eq!(read(&log.rolled(1)), "cccccccc\n");
        assert_eq!(read(&log.rolled(2)), "bbbbbbbb\n");
        assert!(!log.rolled(3).exists(), "only `keep` old files");
        // Reopening appends, and counts what is already there.
        drop(log);
        let mut log = RollingFile::with_limits(&path, 10, 2).expect("reopen");
        log.write_all(b"e").expect("write");
        assert_eq!(read(&path), "dddddddd\ne", "exactly at the limit: no roll");
        log.write_all(b"ffff\n").expect("write");
        assert_eq!(read(&path), "ffff\n");
    }

    #[test]
    fn a_reader_holding_the_log_open_does_not_stop_the_roll_over() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.log");
        let mut log = RollingFile::with_limits(&path, 10, 2).expect("open");
        log.write_all(b"first...\n").expect("write");
        let held = File::open(&path).expect("reader");
        log.write_all(b"second..\n").expect("write");
        assert_eq!(
            std::fs::read_to_string(log.rolled(1)).expect("rolled"),
            "first...\n"
        );
        drop(held);
    }

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
