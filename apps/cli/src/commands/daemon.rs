//! Local lifecycle controls for the websocket relay.
//!
//! `wsmp daemon start --detach` owns a PID file under the state directory so
//! `status` / `stop` can manage that single background process. Foreground
//! starts (`wsmp daemon start`, `wsmp connect`) and OS service units do not
//! claim that PID file — service managers track their own processes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::Subcommand;

use crate::output;

const PID_FILE_VERSION: u32 = 1;
const PID_CLAIM_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    command: CommandName,
}

#[derive(Debug, Subcommand)]
enum CommandName {
    /// Start the relay daemon. Foreground is the default.
    Start {
        /// Spawn the relay in the background and return immediately.
        #[arg(long, conflicts_with = "foreground")]
        detach: bool,
        /// Explicitly run in the foreground (used by service managers).
        #[arg(long)]
        foreground: bool,
        /// Internal ownership marker used only by `start --detach` children.
        #[arg(long, hide = true, requires = "foreground")]
        detach_token: Option<String>,
    },
    /// Stop a relay started with `wsmp daemon start --detach`.
    Stop,
    /// Print whether a detached relay process is running.
    Status,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PidRecord {
    pub version: u32,
    pub pid: u32,
    pub token: String,
}

impl PidRecord {
    pub fn new(pid: u32, token: impl Into<String>) -> Self {
        Self {
            version: PID_FILE_VERSION,
            pid,
            token: token.into(),
        }
    }
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        CommandName::Start { detach, .. } if *detach => start_detached(),
        CommandName::Start { detach_token, .. } => run_foreground(detach_token.as_deref()),
        CommandName::Stop => stop(),
        CommandName::Status => status(),
    }
}

fn pid_file() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join("relay.pid"))
}

/// Serialize a PID ownership record. Format is line-oriented and stable:
/// `version`, `pid`, `token`.
pub fn format_pid_record(record: &PidRecord) -> String {
    format!(
        "version={}\npid={}\ntoken={}\n",
        record.version, record.pid, record.token
    )
}

/// Parse a PID ownership record written by [`format_pid_record`].
pub fn parse_pid_record(text: &str) -> Result<PidRecord> {
    let mut version = None;
    let mut pid = None;
    let mut token = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            anyhow::bail!("invalid relay PID file line `{line}`");
        };
        match key.trim() {
            "version" => {
                version = Some(
                    value
                        .trim()
                        .parse::<u32>()
                        .context("parsing relay PID file version")?,
                );
            }
            "pid" => {
                pid = Some(
                    value
                        .trim()
                        .parse::<u32>()
                        .context("parsing relay PID file pid")?,
                );
            }
            "token" => {
                let value = value.trim();
                if value.is_empty() || !token_chars_valid(value) {
                    anyhow::bail!("invalid relay PID file token");
                }
                token = Some(value.to_string());
            }
            other => anyhow::bail!("unknown relay PID file field `{other}`"),
        }
    }
    let version = version.context("relay PID file is missing `version`")?;
    if version != PID_FILE_VERSION {
        anyhow::bail!("unsupported relay PID file version `{version}`");
    }
    let pid = pid.context("relay PID file is missing `pid`")?;
    if pid == 0 {
        anyhow::bail!("relay PID file contains an invalid pid");
    }
    let token = token.context("relay PID file is missing `token`")?;
    Ok(PidRecord {
        version,
        pid,
        token,
    })
}

fn token_chars_valid(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        && token.len() <= 128
}

fn read_pid_record(path: &Path) -> Result<Option<PidRecord>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("reading `{}`", path.display())),
    };
    parse_pid_record(&text)
        .map(Some)
        .with_context(|| format!("parsing relay PID file `{}`", path.display()))
}

fn process_running(pid: u32) -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        // `kill -0` only checks whether the process exists and is signalable by
        // this user — it does not deliver a signal.
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        false
    }
}

/// Best-effort check that `pid` still looks like this CLI's detached relay.
/// Used to avoid signalling a recycled PID that now belongs to an unrelated
/// process.
pub fn process_looks_like_wsmp_daemon(pid: u32, token: &str) -> bool {
    let Some(cmdline) = read_process_cmdline(pid) else {
        return false;
    };
    cmdline_looks_like_detached_daemon(&cmdline, token)
}

fn cmdline_looks_like_detached_daemon(cmdline: &str, token: &str) -> bool {
    let lower = cmdline.to_ascii_lowercase();
    let has_binary = lower.contains("wsmp") || lower.contains("ws-model-proxy");
    let has_daemon = lower.contains("daemon");
    let has_token = cmdline.split_whitespace().any(|argument| argument == token)
        && cmdline
            .split_whitespace()
            .any(|argument| argument == "--detach-token");
    has_binary && has_daemon && has_token
}

fn read_process_cmdline(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let raw = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        if raw.is_empty() {
            return None;
        }
        Some(
            raw.split(|byte| *byte == 0)
                .filter(|part| !part.is_empty())
                .map(|part| String::from_utf8_lossy(part).into_owned())
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "args="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() { None } else { Some(text) }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// Decide whether an existing PID file still represents a live detached daemon
/// that we must not overwrite.
pub fn live_detached_owner(record: &PidRecord) -> bool {
    process_running(record.pid) && process_looks_like_wsmp_daemon(record.pid, &record.token)
}

fn new_detach_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos}-{}", std::process::id())
}

fn start_detached() -> Result<()> {
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    anyhow::bail!("`wsmp daemon start --detach` is only supported on Linux and macOS");

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let path = pid_file()?;
        if let Some(record) = read_pid_record(&path)? {
            if live_detached_owner(&record) {
                anyhow::bail!("relay daemon is already running (pid {})", record.pid);
            }
            // Stale or unowned file — only remove after the ownership check so
            // concurrent starts do not clobber a live daemon's record blindly.
            remove_pid_file_if_matches(&path, &record)?;
        }

        let executable = std::env::current_exe().context("resolving the wsmp executable")?;
        let token = new_detach_token();
        // Keep the Child handle until we return so the OS does not reap it as an
        // unexpected short-lived process while we wait for the PID claim. We do
        // not `wait()` on success — the relay keeps running after this CLI exits.
        let child = spawn_detached_child(&executable, &token)?;
        let child_pid = child.id();

        // Wait until the child has exclusively claimed the PID file with our
        // token, or until it exits early with an error.
        let deadline = Instant::now() + PID_CLAIM_TIMEOUT;
        loop {
            if let Some(record) = read_pid_record(&path)? {
                if record.token == token && record.pid == child_pid {
                    // Intentionally leak/drop without wait: process is detached.
                    drop(child);
                    return output::line(format!("relay daemon started (pid {child_pid})"));
                }
                if live_detached_owner(&record) && record.token != token {
                    anyhow::bail!(
                        "another relay daemon claimed the PID file (pid {})",
                        record.pid
                    );
                }
            }
            if !process_running(child_pid) {
                anyhow::bail!(
                    "detached relay daemon exited before claiming the PID file (pid {child_pid})"
                );
            }
            if Instant::now() >= deadline {
                anyhow::bail!(
                    "timed out waiting for detached relay daemon (pid {child_pid}) to claim `{}`",
                    path.display()
                );
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_detached_child(executable: &Path, token: &str) -> Result<std::process::Child> {
    // `setsid` creates a new session (and process group) so the child is not
    // attached to the caller's controlling terminal and will not receive that
    // terminal's hangup signals.
    Command::new("setsid")
        .arg(executable)
        .args(["daemon", "start", "--foreground", "--detach-token", token])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("starting detached relay daemon via `setsid`")
}

#[cfg(target_os = "macos")]
fn spawn_detached_child(executable: &Path, token: &str) -> Result<std::process::Child> {
    use std::os::unix::process::CommandExt;

    // macOS has no portable `setsid` binary. `nohup` ignores SIGHUP before exec,
    // and `process_group(0)` places the child in a new process group so terminal
    // job-control signals aimed at the foreground group do not reach it.
    let mut command = Command::new("nohup");
    command
        .arg(executable)
        .args(["daemon", "start", "--foreground", "--detach-token", token])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    command
        .spawn()
        .context("starting detached relay daemon via `nohup`")
}

fn run_foreground(detach_token: Option<&str>) -> Result<()> {
    // Only the detached child claims the shared PID file. Foreground runs and
    // OS service units leave lifecycle tracking to the terminal / service manager.
    let guard = if let Some(token) = detach_token {
        if !token_chars_valid(token) {
            anyhow::bail!("detached daemon ownership token is invalid");
        }
        Some(claim_pid_file(token.to_string())?)
    } else {
        None
    };

    let result = crate::daemon::connect_foreground();
    drop(guard);
    result
}

struct PidFileGuard {
    path: PathBuf,
    record: PidRecord,
}

impl Drop for PidFileGuard {
    fn drop(&mut self) {
        let _ = remove_pid_file_if_matches(&self.path, &self.record);
    }
}

fn claim_pid_file(token: String) -> Result<PidFileGuard> {
    let path = pid_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
        #[cfg(unix)]
        set_private_dir(parent)?;
    }

    let record = PidRecord::new(std::process::id(), token);
    let body = format_pid_record(&record);

    // Exclusive create avoids two children racing to own the same PID file.
    // One retry after clearing a verified-stale (or corrupt leftover) record.
    for attempt in 0..2 {
        match write_pid_file_exclusive(&path, body.as_bytes()) {
            Ok(()) => return Ok(PidFileGuard { path, record }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                match read_pid_record(&path) {
                    Ok(Some(existing)) => {
                        if live_detached_owner(&existing) {
                            anyhow::bail!("relay daemon is already running (pid {})", existing.pid);
                        }
                        remove_pid_file_if_matches(&path, &existing)?;
                    }
                    Ok(None) => {
                        // Lost a race with a remover; retry exclusive create.
                    }
                    Err(_) => {
                        // Corrupt leftover from a crashed writer: remove and retry.
                        // A live owner always rewrites a valid record on claim.
                        match fs::remove_file(&path) {
                            Ok(()) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(error) => {
                                return Err(error).with_context(|| {
                                    format!("removing corrupt `{}`", path.display())
                                });
                            }
                        }
                    }
                }
            }
            Err(error) => {
                return Err(error).with_context(|| format!("writing `{}`", path.display()));
            }
        }
    }
    anyhow::bail!(
        "relay daemon is already running (could not claim `{}`)",
        path.display()
    )
}

fn write_pid_file_exclusive(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }
}

fn remove_pid_file_if_matches(path: &Path, expected: &PidRecord) -> Result<()> {
    match read_pid_record(path)? {
        Some(current) if current == *expected => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| format!("removing `{}`", path.display())),
        },
        // File gone, replaced, or owned by someone else — leave it alone.
        _ => Ok(()),
    }
}

#[cfg(unix)]
fn set_private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::metadata(path).with_context(|| format!("reading metadata for `{}`", path.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

fn stop() -> Result<()> {
    let path = pid_file()?;
    let Some(record) = read_pid_record(&path)? else {
        return output::line("relay daemon is not running");
    };
    if !process_running(record.pid) {
        remove_pid_file_if_matches(&path, &record)?;
        return output::line("relay daemon is not running");
    }
    if !process_looks_like_wsmp_daemon(record.pid, &record.token) {
        // PID reuse / foreign process: do not signal. Leave the file for the
        // operator to inspect; claiming a new detach will refuse or replace
        // only after identity checks.
        anyhow::bail!(
            "pid {} from `{}` does not look like a wsmp daemon; refusing to signal it",
            record.pid,
            path.display()
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let stopped = Command::new("kill")
            .args(["-TERM", &record.pid.to_string()])
            .status()
            .context("stopping relay daemon")?
            .success();
        if !stopped {
            anyhow::bail!("relay daemon rejected the stop signal");
        }
        let deadline = Instant::now() + STOP_WAIT_TIMEOUT;
        while Instant::now() < deadline {
            if !process_running(record.pid) {
                remove_pid_file_if_matches(&path, &record)?;
                return output::line(format!("relay daemon stopped (pid {})", record.pid));
            }
            thread::sleep(Duration::from_millis(50));
        }
        anyhow::bail!(
            "relay daemon (pid {}) did not exit after SIGTERM; try again or inspect the process",
            record.pid
        );
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = record;
        anyhow::bail!("`wsmp daemon stop` is only supported on Linux and macOS");
    }
}

fn status() -> Result<()> {
    let path = pid_file()?;
    match read_pid_record(&path)? {
        Some(record) if live_detached_owner(&record) => {
            output::line(format!("relay daemon running (pid {})", record.pid))
        }
        Some(record) => {
            // Stale file from a dead process — clean up only our record.
            remove_pid_file_if_matches(&path, &record)?;
            output::line("relay daemon is not running")
        }
        None => output::line("relay daemon is not running"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_record_round_trips() {
        let record = PidRecord::new(4242, "token-abc_01");
        let text = format_pid_record(&record);
        let parsed = parse_pid_record(&text).expect("parse");
        assert_eq!(parsed, record);
    }

    #[test]
    fn pid_record_rejects_corrupt_input() {
        assert!(parse_pid_record("").is_err());
        assert!(parse_pid_record("pid=1\n").is_err());
        assert!(parse_pid_record("version=1\npid=0\ntoken=abc\n").is_err());
        assert!(parse_pid_record("version=1\npid=1\ntoken=bad token\n").is_err());
        assert!(parse_pid_record("version=99\npid=1\ntoken=abc\n").is_err());
    }

    #[test]
    fn pid_record_ignores_comments_and_blank_lines() {
        let text = "# ownership\n\nversion=1\npid=9\ntoken=xyz\n";
        let parsed = parse_pid_record(text).expect("parse");
        assert_eq!(parsed.pid, 9);
        assert_eq!(parsed.token, "xyz");
    }

    #[test]
    fn token_validation_accepts_safe_tokens() {
        assert!(token_chars_valid("abc-123_XYZ"));
        assert!(!token_chars_valid(""));
        assert!(!token_chars_valid("has space"));
        assert!(!token_chars_valid(&"a".repeat(129)));
    }

    #[test]
    fn detached_command_line_requires_the_record_token() {
        let command = "wsmp daemon start --foreground --detach-token token-123";
        assert!(cmdline_looks_like_detached_daemon(command, "token-123"));
        assert!(!cmdline_looks_like_detached_daemon(command, "different-token"));
        assert!(!cmdline_looks_like_detached_daemon(
            "wsmp daemon start --foreground",
            "token-123"
        ));
    }
}
