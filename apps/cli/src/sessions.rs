//! Terminal and exec sessions multiplexed on one relay connection.
//!
//! Output readers send through [`FromWorker`] on the shared `sync_channel(64)`.
//! Dropping a registry kills every child. `kill_all` is safe to call first; the
//! later drop is a no-op.
//!
//! Unix children are process-group leaders (`setsid` for a PTY, `process_group(0)`
//! for exec) and are stopped with `SIGKILL` to the group. Closing a terminal
//! also kills every process in the shell's session, including background jobs
//! in their own process groups and `nohup`/disowned jobs; only a process that
//! calls `setsid()` itself leaves that session and survives. Windows execs
//! run in a job object assigned before the child starts. Terminating the job
//! kills the whole tree, including detached grandchildren.
//!
//! Every live Unix exec group and PTY session, and every Windows exec, is also
//! recorded in a global list, so a forced shutdown (`crate::shutdown`) can
//! kill them from another thread with [`kill_tracked_children`] when the relay
//! thread is stuck.
//!
//! A terminal closes when its shell exits, not only on PTY EOF: a background
//! or disowned job can hold the PTY open after the shell is gone. The relay
//! loop's `poll` reaps the shell, lets already-written output drain briefly,
//! then kills the rest of the session and reports the shell's exit status.
//!
//! Terminal input never blocks the relay loop. Each terminal has a writer
//! thread fed by a queue of at most [`INPUT_QUEUE_LIMIT`] pending bytes; when
//! the program is not reading and the queue is full, further input is dropped
//! and the viewer is told with `term.input_dropped`.
//!
//! Terminals have many viewers. Each viewer has pairwise v2 keys
//! for its input and for unicast frames (output-key delivery and its scrollback
//! replay). Live output and PTY-size frames are sealed once under a shared
//! per-terminal output key; the relay fans them out. The key rotates to a new
//! epoch whenever a viewer leaves. The PTY size follows the writer, the viewer
//! that most recently typed.

#[cfg(windows)]
use crate::job_tree::Child as ExecChild;
use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::Child as ExecChild;
use std::sync::Arc;
#[cfg(unix)]
use std::sync::Condvar;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::approvals::{approved_public_key, record_pending};
use crate::child_env::{self, scrub_parent_env};
use crate::output_mask::StreamMasker;
use crate::protocol::frames::{
    ExecState, ExecStatus, NODE_COMMAND_MAX_MS, NODE_COMMAND_TAIL_MAX_BYTES, TerminalIdentity,
};
use crate::protocol::{NodeBinaryMetadata, NodeFrame, terminal_supported};
use crate::relay_bus::FromWorker;
use crate::startup::TerminalStartup;
use crate::terminal_crypto::{
    self, DIR_BROWSER_TO_CLI, DIR_CLI_TO_BROWSER, DirectionKeys, TermPlaintextV2,
};

mod operator;
pub(crate) use operator::OperatorDelivery;
#[cfg(unix)]
pub(crate) use operator::operator_base_env;

/// Attached viewers plus pending approvals, per terminal (protocol 2.5).
const MAX_VIEWERS: usize = 8;
const MAX_EXECS: usize = 8;
#[cfg(unix)]
const SCROLLBACK_LIMIT: usize = 256 * 1024;
const READ_CHUNK: usize = 8 * 1024;
const SEAL_CHUNK: usize = 16 * 1024;
#[cfg(unix)]
const DEFAULT_IDLE: Duration = Duration::from_secs(15 * 60);
/// A node command's longest lifetime until the node definition says otherwise.
pub(crate) const DEFAULT_COMMAND_MAX: Duration = Duration::from_millis(NODE_COMMAND_MAX_MS);
#[cfg(unix)]
const PENDING_TTL: Duration = Duration::from_secs(2 * 60);
/// How often attached 2.5 viewers are re-checked against the approvals file.
#[cfg(unix)]
const APPROVAL_RECHECK: Duration = Duration::from_secs(5);
const SEND_WAIT: Duration = Duration::from_millis(200);
#[cfg(unix)]
const READ_POLL: Duration = Duration::from_millis(200);
/// Pending (queued plus in-flight) input bytes per terminal. Input beyond this
/// is dropped rather than blocking the relay loop.
#[cfg(unix)]
const INPUT_QUEUE_LIMIT: usize = 256 * 1024;
/// Kill rounds on terminal close. Session members can fork while they are
/// being killed, so the session is re-scanned until it is empty.
#[cfg(unix)]
const SESSION_KILL_ROUNDS: usize = 20;
/// After the child exits, keep the exec slot until both pipes report EOF, or
/// this long, whichever comes first. A grandchild that holds a pipe must not
/// stall the slot; the leftover bytes are then dropped.
const EXEC_OUTPUT_DRAIN: Duration = Duration::from_millis(500);
/// After the shell exits, keep the terminal until the PTY reports EOF, or this
/// long, whichever comes first. A background or disowned job that still holds
/// the PTY must not keep a dead terminal in its slot.
#[cfg(unix)]
const TERMINAL_OUTPUT_DRAIN: Duration = Duration::from_millis(500);
/// Map key for a handshake that names no viewer. Never a valid wire viewer id.
/// Every accepted handshake carries a valid id, so this is only a fallback.
const LEGACY_VIEWER: &str = "";

const REASON_DISABLED: &str = "disabled";
/// A command refused because the node is at Relay only.
const REASON_TRUST_RELAY: &str = "trust_relay";
const REASON_UNSUPPORTED: &str = "unsupported";
const REASON_LIMIT: &str = "limit";
const REASON_VIEWER_LIMIT: &str = "viewer_limit";
const REASON_APPROVAL_REQUIRED: &str = "approval_required";
const REASON_BAD_SIGNATURE: &str = "bad_signature";
const REASON_BAD_COMMAND: &str = "bad_command";
const REASON_BAD_CWD: &str = "bad_cwd";
const REASON_NOT_FOUND: &str = "not_found";
const REASON_ALREADY_OPEN: &str = "already_open";
const REASON_SPAWN_FAILED: &str = "spawn_failed";
const REASON_BAD_HANDSHAKE: &str = "bad_handshake";
const REASON_BAD_FRAME: &str = "bad_frame";
#[cfg(unix)]
const REASON_EXPIRED: &str = "expired";
#[allow(clippy::large_enum_variant)] // `NodeFrame` carries the telemetry shapes.
pub(crate) enum OutboundFrame {
    Control(NodeFrame),
    Binary(NodeBinaryMetadata, Vec<u8>),
}

#[derive(Clone, Copy)]
pub(crate) struct TermHandshake<'a> {
    pub terminal_id: &'a str,
    /// Minted by the server in protocol 2.5. `None` on a 2.4 relay.
    pub viewer_id: Option<&'a str>,
    pub cols: u16,
    pub rows: u16,
    pub browser_public_key: &'a str,
    pub browser_nonce: &'a str,
    pub identity: Option<&'a TerminalIdentity>,
}

enum Incoming {
    Write(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Undecryptable or out-of-order sealed frames are dropped.
    Ignore,
    /// An authenticated frame with a bad payload removes only its viewer.
    DropViewer,
}

/// Why a browser terminal cannot open: `open` live browser terminals against
/// this machine's `maxTerminals` (`max`).
fn terminal_block_reason(
    supported: bool,
    allowed: bool,
    open: usize,
    max: usize,
) -> Option<&'static str> {
    if !supported {
        return Some(REASON_UNSUPPORTED);
    }
    if !allowed {
        return Some(REASON_DISABLED);
    }
    if open >= max {
        return Some(REASON_LIMIT);
    }
    None
}

#[cfg(unix)]
fn push_scrollback(buf: &mut VecDeque<u8>, bytes: &[u8]) {
    buf.extend(bytes);
    let overflow = buf.len().saturating_sub(SCROLLBACK_LIMIT);
    if overflow > 0 {
        buf.drain(..overflow);
    }
}

fn user_home() -> Result<PathBuf, &'static str> {
    dirs::home_dir().ok_or("home directory is unavailable")
}

fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=256).contains(&bytes.len())
        && !bytes.contains(&0)
        && !bytes.contains(&b'\n')
        && !bytes.contains(&b'\r')
}

fn send_note(tx: &SyncSender<FromWorker>, mut note: FromWorker, stop: &AtomicBool) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        // `SyncSender::send_timeout` is not stable on the 1.88 MSRV. Poll with
        // try_send so a full channel still applies backpressure without dropping
        // output, and so shutdown can unblock the reader.
        match tx.try_send(note) {
            Ok(()) => return,
            Err(mpsc::TrySendError::Full(returned)) => {
                note = returned;
                std::thread::sleep(SEND_WAIT);
            }
            Err(mpsc::TrySendError::Disconnected(_)) => return,
        }
    }
}

#[cfg(not(unix))]
fn pump_reader<R>(
    mut reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut buf = [0_u8; READ_CHUNK];
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
                Ok(count) => {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    send_note(&tx, make_bytes(buf[..count].to_vec()), &stop);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
            }
        }
    })
}

#[cfg(unix)]
fn pump_polled<R>(
    mut reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + std::os::fd::AsFd + Send + 'static,
{
    std::thread::spawn(move || {
        let timeout =
            nix::poll::PollTimeout::try_from(READ_POLL).unwrap_or(nix::poll::PollTimeout::ZERO);
        let mut buf = [0_u8; READ_CHUNK];
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let events = {
                let mut fds = [nix::poll::PollFd::new(
                    reader.as_fd(),
                    nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLHUP,
                )];
                match nix::poll::poll(&mut fds, timeout) {
                    Ok(0) => continue,
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(_) => {
                        send_note(&tx, make_eof(), &stop);
                        return;
                    }
                    Ok(_) => fds[0].revents().unwrap_or(nix::poll::PollFlags::empty()),
                }
            };
            if stop.load(Ordering::Relaxed) {
                return;
            }
            if events.contains(nix::poll::PollFlags::POLLNVAL) {
                send_note(&tx, make_eof(), &stop);
                return;
            }
            let readable = events.contains(nix::poll::PollFlags::POLLIN)
                || events.contains(nix::poll::PollFlags::POLLHUP)
                || events.contains(nix::poll::PollFlags::POLLERR);
            if !readable {
                continue;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
                Ok(count) => {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    send_note(&tx, make_bytes(buf[..count].to_vec()), &stop);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(error) if error.raw_os_error() == Some(nix::errno::Errno::EIO as i32) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
                Err(_) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
            }
        }
    })
}

#[cfg(unix)]
fn pump_exec_reader<R>(
    reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + std::os::fd::AsFd + Send + 'static,
{
    pump_polled(reader, tx, stop, make_bytes, make_eof)
}

#[cfg(not(unix))]
fn pump_exec_reader<R>(
    reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    pump_reader(reader, tx, stop, make_bytes, make_eof)
}

fn identity_public(identity: Option<&TerminalIdentity>) -> Result<[u8; 65], &'static str> {
    let Some(identity) = identity else {
        return Err(REASON_APPROVAL_REQUIRED);
    };
    terminal_crypto::decode_public_key(&identity.public_key).map_err(|_| REASON_APPROVAL_REQUIRED)
}

/// `None` when the identity is already approved. Otherwise the approval code,
/// after the unknown key is written to the pending file.
fn approval_code_for_identity(state_dir: Option<&Path>, identity_raw: &[u8; 65]) -> Option<String> {
    let code = terminal_crypto::approval_code(identity_raw);
    if let Some(dir) = state_dir
        && let Ok(Some(stored)) = approved_public_key(dir, &code)
        && stored == *identity_raw
    {
        return None;
    }
    if let Some(dir) = state_dir
        && let Err(error) = record_pending(dir, identity_raw)
    {
        tracing::warn!(error = %error, "recording a pending terminal approval failed");
    }
    Some(code)
}

/// `false` only when the approvals file positively no longer maps this
/// identity's code to it. A read error keeps the viewer.
#[cfg(unix)]
fn identity_still_approved(state_dir: &Path, identity_raw: &[u8; 65]) -> bool {
    let code = terminal_crypto::approval_code(identity_raw);
    match approved_public_key(state_dir, &code) {
        Ok(Some(stored)) => stored == *identity_raw,
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(error = %error, "re-checking a terminal approval failed");
            true
        }
    }
}

/// `viewer_id` selects the v2 transcript (protocol 2.5); `None` is v1.
#[allow(clippy::too_many_arguments)]
fn approval_signature_ok(
    identity_raw: &[u8; 65],
    signature: &str,
    terminal_id: &str,
    viewer_id: Option<&str>,
    browser_public: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> bool {
    let Ok(signature) = terminal_crypto::decode_exact(signature, 64) else {
        return false;
    };
    match viewer_id {
        Some(viewer_id) => terminal_crypto::verify_approval_signature_v2(
            identity_raw,
            &signature,
            terminal_id,
            viewer_id,
            browser_public,
            browser_nonce,
            cli_public,
            cli_nonce,
        ),
        None => terminal_crypto::verify_approval_signature(
            identity_raw,
            &signature,
            terminal_id,
            browser_public,
            browser_nonce,
            cli_public,
            cli_nonce,
        ),
    }
}

struct PreparedHandshake {
    cols: u16,
    rows: u16,
    browser_public: [u8; 65],
    browser_nonce: [u8; 16],
}

fn handshake_rejected(handshake: &TermHandshake<'_>, reason: &str) -> Box<OutboundFrame> {
    Box::new(term_rejected(
        handshake.terminal_id,
        handshake.viewer_id,
        reason,
        None,
    ))
}

fn fresh_nonce(handshake: &TermHandshake<'_>) -> Result<[u8; 16], Box<OutboundFrame>> {
    match terminal_crypto::random_nonce() {
        Ok(nonce) => Ok(nonce),
        Err(error) => {
            tracing::warn!(
                error = %error,
                terminal_id = handshake.terminal_id,
                "generating a terminal nonce failed"
            );
            Err(handshake_rejected(handshake, REASON_SPAWN_FAILED))
        }
    }
}

fn decode_browser_handshake(
    handshake: &TermHandshake<'_>,
) -> Result<PreparedHandshake, Box<OutboundFrame>> {
    let (cols, rows) = if handshake.cols == 0 && handshake.rows == 0 {
        // Attach does not carry a size. The live pty keeps the size it has.
        (80, 24)
    } else if terminal_crypto::validate_size(handshake.cols, handshake.rows).is_err() {
        return Err(handshake_rejected(handshake, REASON_BAD_HANDSHAKE));
    } else {
        (handshake.cols, handshake.rows)
    };
    let Ok(browser_public) = terminal_crypto::decode_public_key(handshake.browser_public_key)
    else {
        return Err(handshake_rejected(handshake, REASON_BAD_HANDSHAKE));
    };
    let Ok(browser_nonce) = terminal_crypto::decode_nonce(handshake.browser_nonce) else {
        return Err(handshake_rejected(handshake, REASON_BAD_HANDSHAKE));
    };
    Ok(PreparedHandshake {
        cols,
        rows,
        browser_public,
        browser_nonce,
    })
}

fn prepare_handshake(
    startup: &TerminalStartup,
    open_count: usize,
    handshake: &TermHandshake<'_>,
) -> Result<PreparedHandshake, Box<OutboundFrame>> {
    // A pending approval does not consume a live terminal slot.
    let counted = if startup.require_terminal_approval() {
        0
    } else {
        open_count
    };
    if let Some(reason) = terminal_block_reason(
        terminal_supported(),
        // Browser terminals need the local switch and Full control.
        startup.allow_human_terminal() && startup.full_control(),
        counted,
        startup.max_terminals(),
    ) {
        return Err(handshake_rejected(handshake, reason));
    }
    decode_browser_handshake(handshake)
}

fn term_pending(
    terminal_id: &str,
    viewer_id: Option<&str>,
    cli_nonce: &str,
    approval_code: Option<String>,
) -> OutboundFrame {
    OutboundFrame::Control(NodeFrame::TermPending {
        terminal_id: terminal_id.to_string(),
        viewer_id: viewer_id.map(str::to_string),
        cli_nonce: cli_nonce.to_string(),
        approval_code,
    })
}

fn term_rejected(
    terminal_id: &str,
    viewer_id: Option<&str>,
    reason: &str,
    approval_code: Option<String>,
) -> OutboundFrame {
    OutboundFrame::Control(NodeFrame::TermRejected {
        terminal_id: terminal_id.to_string(),
        viewer_id: viewer_id.map(str::to_string),
        reason: reason.to_string(),
        approval_code,
    })
}

fn term_writer(terminal_id: &str, writer: Option<&str>) -> OutboundFrame {
    OutboundFrame::Control(NodeFrame::TermWriter {
        terminal_id: terminal_id.to_string(),
        viewer_id: writer.map(str::to_string),
    })
}

fn sealed_frame(
    terminal_id: &str,
    seq: u64,
    viewer_id: Option<&str>,
    epoch: Option<u32>,
    body: Vec<u8>,
) -> OutboundFrame {
    OutboundFrame::Binary(
        NodeBinaryMetadata::TermSealed {
            terminal_id: terminal_id.to_string(),
            seq,
            viewer_id: viewer_id.map(str::to_string),
            epoch,
        },
        body,
    )
}

/// One info line per command operation (`exec`):
/// the operation, the relay command id and a stable outcome code. Never the
/// command text, cwd, environment or output (the server's audit log holds a
/// hash of the command text plus its program name; this log is the CLI-side
/// record of what happened).
fn log_command_op(op: &'static str, command_id: &str, outcome: &str) {
    tracing::info!(op, command_id, outcome, "command operation");
}

fn rejected_outcome(reason: &str) -> String {
    format!("rejected:{reason}")
}

fn done_outcome(exit_code: Option<i32>, signal: Option<i32>, cause: EndCause) -> String {
    if cause == EndCause::TimedOut {
        "timed_out".to_string()
    } else if cause == EndCause::Cancelled {
        "cancelled".to_string()
    } else if cause == EndCause::Interrupted {
        "interrupted".to_string()
    } else if let Some(code) = exit_code {
        format!("exited:{code}")
    } else if let Some(signal) = signal {
        format!("signaled:{signal}")
    } else {
        "ended".to_string()
    }
}

fn exec_rejected(command_id: &str, reason: &str) -> OutboundFrame {
    log_command_op("exec", command_id, &rejected_outcome(reason));
    OutboundFrame::Control(NodeFrame::ExecRejected {
        command_id: command_id.to_string(),
        reason: reason.to_string(),
    })
}

fn signal_token(signal: Option<i32>) -> Option<String> {
    signal.map(|value| value.to_string())
}

#[cfg(unix)]
fn kill_process_group(pid: u32, fallback_to_pid: bool) {
    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    if raw <= 1 {
        return;
    }
    let id = nix::unistd::Pid::from_raw(raw);
    // After the child has been reaped, `kill(pid)` can hit a reused pid.
    // `killpg` still covers grandchildren that stayed in the group.
    if nix::sys::signal::killpg(id, nix::sys::signal::Signal::SIGKILL).is_err() && fallback_to_pid {
        let _ = nix::sys::signal::kill(id, nix::sys::signal::Signal::SIGKILL);
    }
}

#[cfg(unix)]
fn reap_pid(pid: Option<u32>) -> (Option<i32>, Option<i32>) {
    let Some(pid) = pid else {
        return (None, None);
    };
    let Ok(raw) = i32::try_from(pid) else {
        return (None, None);
    };
    if raw <= 1 {
        return (None, None);
    }
    match nix::sys::wait::waitpid(
        nix::unistd::Pid::from_raw(raw),
        Some(nix::sys::wait::WaitPidFlag::WNOHANG),
    ) {
        Ok(nix::sys::wait::WaitStatus::Exited(_, code)) => (Some(code), None),
        Ok(nix::sys::wait::WaitStatus::Signaled(_, signal, _)) => (None, Some(signal as i32)),
        Ok(_) => (None, None),
        Err(_) => (None, None),
    }
}

/// SIGKILL is already delivered. Retry `WNOHANG` only — never `wait`.
#[cfg(unix)]
fn reap_after_signal(pid: Option<u32>) -> (Option<i32>, Option<i32>) {
    for _ in 0..32 {
        let status = reap_pid(pid);
        if status.0.is_some() || status.1.is_some() {
            return status;
        }
        std::thread::yield_now();
    }
    for _ in 0..20 {
        let status = reap_pid(pid);
        if status.0.is_some() || status.1.is_some() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    reap_pid(pid)
}

fn status_parts(status: std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (status.code(), status.signal())
    }
    #[cfg(not(unix))]
    {
        (status.code(), None)
    }
}

/// Every live process whose session id is confirmed to be `sid`, via
/// `/proc` on Linux. Zombies are skipped: they are already dead and only wait
/// for their parent to reap them.
#[cfg(target_os = "linux")]
fn session_members(sid: nix::unistd::Pid) -> Vec<nix::unistd::Pid> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter(|raw| *raw > 1)
        .filter(|raw| {
            // Field 3 of `stat` (after the parenthesised command) is the state.
            std::fs::read_to_string(format!("/proc/{raw}/stat"))
                .ok()
                .and_then(|stat| {
                    let rest = &stat[stat.rfind(')')? + 1..];
                    rest.split_whitespace().next().map(|state| state != "Z")
                })
                .unwrap_or(false)
        })
        .map(nix::unistd::Pid::from_raw)
        .filter(|pid| nix::unistd::getsid(Some(*pid)) == Ok(sid))
        .collect()
}

/// Every live process whose session id is confirmed to be `sid`. macOS and
/// the BSDs have no `/proc` and listing pids needs FFI (`unsafe` is forbidden
/// here), so `/bin/ps` lists candidates and `getsid` confirms each one.
#[cfg(all(unix, not(target_os = "linux")))]
fn session_members(sid: nix::unistd::Pid) -> Vec<nix::unistd::Pid> {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,stat="])
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let raw = fields.next()?.parse::<i32>().ok()?;
            let zombie = fields.next().is_some_and(|state| state.starts_with('Z'));
            (raw > 1 && !zombie).then(|| nix::unistd::Pid::from_raw(raw))
        })
        .filter(|pid| nix::unistd::getsid(Some(*pid)) == Ok(sid))
        .collect()
}

/// SIGKILL every process in the session led by `leader` (a PTY shell spawned
/// with `setsid`, so its pid is the session id). This reaches background jobs
/// in their own process groups and `nohup`/disowned jobs, which a process
/// group kill misses. Rounds repeat because members can fork while the kill
/// is in progress.
///
/// Only pids whose `getsid` matches are signalled, and never session 1 or
/// the CLI's own session. A process that calls `setsid()` itself starts a new
/// session and escapes this kill; that is a documented limit.
#[cfg(unix)]
fn kill_session(leader: u32) {
    let Ok(raw) = i32::try_from(leader) else {
        return;
    };
    if raw <= 1 {
        return;
    }
    // The shell was spawned with `setsid`, so its session id is its pid.
    // Either it is our unreaped child, or it was reaped just now and the
    // kernel does not hand out a pid that is still some session's id while
    // members remain; either way the pid cannot name an unrelated session. A
    // zombie or reaped leader can fail `getsid`; its session members are
    // still confirmed one by one below.
    let sid = nix::unistd::Pid::from_raw(raw);
    if nix::unistd::getsid(Some(sid)).is_ok_and(|actual| actual != sid) {
        return;
    }
    if nix::unistd::getsid(None).is_ok_and(|own| own == sid) {
        return;
    }
    let own_pid = nix::unistd::getpid();
    for round in 0..SESSION_KILL_ROUNDS {
        let members = session_members(sid);
        if members.is_empty() {
            return;
        }
        for pid in members {
            if pid != own_pid {
                let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
            }
        }
        // SIGKILL is asynchronous. Back off a little so a killed process can
        // become a zombie before the next scan.
        if round > 0 {
            std::thread::sleep(Duration::from_millis(5));
        } else {
            std::thread::yield_now();
        }
    }
}

/// A child the relay thread owns, recorded so a forced shutdown can kill it
/// from another thread without the registries.
#[cfg_attr(unix, derive(Clone, Copy, Debug, PartialEq, Eq))]
#[cfg_attr(windows, derive(Clone, Debug))]
enum LiveChild {
    /// An exec shell: the leader of its own process group on Unix.
    #[cfg(unix)]
    ExecGroup(u32),
    /// A shared job handle, retained even after the root exits.
    #[cfg(windows)]
    ExecJob(crate::job_tree::JobTree),
    /// A PTY shell: the leader of its own session.
    #[cfg(unix)]
    PtySession(u32),
}

static LIVE_CHILDREN: Mutex<BTreeMap<u64, LiveChild>> = Mutex::new(BTreeMap::new());
static NEXT_LIVE_CHILD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Removes its child from [`LIVE_CHILDREN`] when the session that owns the
/// child is dropped.
struct LiveChildGuard(u64);

impl LiveChildGuard {
    fn track(child: LiveChild) -> Self {
        let id = NEXT_LIVE_CHILD.fetch_add(1, Ordering::Relaxed);
        LIVE_CHILDREN
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, child);
        Self(id)
    }
}

impl Drop for LiveChildGuard {
    fn drop(&mut self) {
        LIVE_CHILDREN
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// SIGKILL every exec process group and terminal session still running. Used
/// by a forced shutdown (deadline or second signal) that cannot wait for the
/// relay thread's registries; it does not reap and sends no frames.
pub fn kill_tracked_children() {
    kill_live_children(|_| true);
}

#[cfg(unix)]
fn kill_live_children(select: impl Fn(&LiveChild) -> bool) {
    let children = LIVE_CHILDREN
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .values()
        .copied()
        .filter(|child| select(child))
        .collect::<Vec<_>>();
    for child in children {
        match child {
            #[cfg(unix)]
            LiveChild::ExecGroup(pid) => kill_process_group(pid, false),
            #[cfg(unix)]
            LiveChild::PtySession(pid) => {
                kill_session(pid);
                kill_process_group(pid, false);
            }
        }
    }
}

/// Ownership: the session owns the child; this list owns a job handle clone.
/// Lock order: snapshot under LIVE_CHILDREN, release it, then terminate jobs.
/// Job operations never acquire this list or a session registry. Forced
/// shutdown has one deadline for all lock retries, including a stuck relay.
#[cfg(windows)]
fn kill_live_children(select: impl Fn(&LiveChild) -> bool) {
    let until = Instant::now() + Duration::from_millis(200);
    let Ok(live) = crate::job_tree::lock_until(&LIVE_CHILDREN, until) else {
        return;
    };
    let children = live
        .values()
        .filter(|child| select(child))
        .cloned()
        .collect::<Vec<_>>();
    drop(live);
    for LiveChild::ExecJob(job) in children {
        let _ = job.terminate_until(until);
    }
}

/// Browser input waiting for a terminal's writer thread.
#[cfg(unix)]
struct InputQueue {
    state: Mutex<InputState>,
    ready: Condvar,
}

#[cfg(unix)]
#[derive(Default)]
struct InputState {
    chunks: VecDeque<Vec<u8>>,
    /// Queued plus in-flight bytes.
    pending: usize,
    closed: bool,
    failed: bool,
}

#[cfg(unix)]
impl InputQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(InputState::default()),
            ready: Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InputState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Never blocks on the PTY. `Ok(false)` means the queue is full and the
    /// bytes were dropped. An error means the writer has failed or stopped.
    fn push(&self, bytes: Vec<u8>) -> std::io::Result<bool> {
        let mut state = self.lock();
        if state.failed || state.closed {
            return Err(std::io::Error::other("terminal input is closed"));
        }
        if bytes.is_empty() {
            return Ok(true);
        }
        if state.pending.saturating_add(bytes.len()) > INPUT_QUEUE_LIMIT {
            return Ok(false);
        }
        state.pending += bytes.len();
        state.chunks.push_back(bytes);
        drop(state);
        self.ready.notify_one();
        Ok(true)
    }

    /// The next chunk for the writer, or `None` once the terminal closes.
    fn next(&self, stop: &AtomicBool) -> Option<Vec<u8>> {
        let mut state = self.lock();
        loop {
            if state.closed || stop.load(Ordering::Relaxed) {
                return None;
            }
            if let Some(chunk) = state.chunks.pop_front() {
                return Some(chunk);
            }
            state = self
                .ready
                .wait_timeout(state, READ_POLL)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    fn written(&self, count: usize) {
        let mut state = self.lock();
        state.pending = state.pending.saturating_sub(count);
    }

    fn fail(&self) {
        self.lock().failed = true;
    }

    fn close(&self) {
        let mut state = self.lock();
        state.closed = true;
        state.chunks.clear();
        state.pending = 0;
        drop(state);
        self.ready.notify_all();
    }
}

/// Write all of `bytes` to a non-blocking PTY master, waiting for room with
/// `poll`. `Ok(false)` means `stop` was set first.
#[cfg(unix)]
fn write_polled(
    writer: &mut filedescriptor::FileDescriptor,
    bytes: &[u8],
    stop: &AtomicBool,
) -> std::io::Result<bool> {
    let timeout =
        nix::poll::PollTimeout::try_from(READ_POLL).unwrap_or(nix::poll::PollTimeout::ZERO);
    let mut offset = 0;
    while offset < bytes.len() {
        if stop.load(Ordering::Relaxed) {
            return Ok(false);
        }
        match writer.write(&bytes[offset..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "terminal write failed",
                ));
            }
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let mut fds = [nix::poll::PollFd::new(
                    std::os::fd::AsFd::as_fd(writer),
                    nix::poll::PollFlags::POLLOUT,
                )];
                match nix::poll::poll(&mut fds, timeout) {
                    Ok(_) | Err(nix::errno::Errno::EINTR) => {}
                    Err(errno) => return Err(std::io::Error::from(errno)),
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

/// The per-terminal writer thread. A write error marks the queue failed and
/// asks the relay loop to close the terminal; it never closes it itself.
#[cfg(unix)]
fn pump_input(
    mut writer: filedescriptor::FileDescriptor,
    input: Arc<InputQueue>,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    terminal_id: String,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while let Some(chunk) = input.next(&stop) {
            let result = write_polled(&mut writer, &chunk, &stop);
            input.written(chunk.len());
            match result {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    tracing::debug!(error = %error, terminal_id, "terminal input write failed");
                    input.fail();
                    send_note(&tx, FromWorker::TerminalWriteFailed { terminal_id }, &stop);
                    return;
                }
            }
        }
    })
}

#[cfg(unix)]
struct PtyRuntime {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    input: Arc<InputQueue>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    pid: Option<u32>,
    /// Exit status and the instant `poll` reaped the shell. The terminal
    /// closes on PTY EOF or [`TERMINAL_OUTPUT_DRAIN`] later.
    exited: Option<(Option<i32>, Option<i32>, Instant)>,
    /// Dropped after `shutdown_pty` has killed and reaped the session.
    _tracked: Option<LiveChildGuard>,
}

#[cfg(unix)]
fn shutdown_pty(mut runtime: PtyRuntime) -> (Option<i32>, Option<i32>) {
    runtime.stop.store(true, Ordering::SeqCst);
    runtime.input.close();
    let exited = runtime.exited.map(|(code, signal, _)| (code, signal));
    if let Some(pid) = runtime.pid {
        kill_session(pid);
        // A shell that `poll` already reaped is not signalled by pid again;
        // `killpg` still reaches jobs left in its process group.
        kill_process_group(pid, exited.is_none());
    }
    // The reader and writer notice `stop` within their poll timeout. Joining
    // either would block: the reader while a background job still holds the
    // slave, the writer while the PTY input buffer is full.
    drop(runtime.writer.take());
    drop(runtime.reader.take());
    let status = exited.unwrap_or_else(|| reap_after_signal(runtime.pid));
    drop(runtime.child);
    drop(runtime.master);
    status
}

/// Best-effort wipe of key material. No `unsafe` and no extra crates, so this
/// is an overwrite the optimizer is discouraged (not forbidden) from removing.
fn wipe(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(&*bytes);
}

/// One browser tab.
struct Viewer {
    keys: DirectionKeys,
    last_rx: u64,
    next_tx: u64,
    /// The viewer's own fitted size, from the open request or its last resize.
    last_size: Option<(u16, u16)>,
    /// The identity approved through `term.auth`. Re-checked so a revoke
    /// removes the viewer.
    // Only the relay loop's `poll` (unix: no terminals elsewhere) re-checks it;
    // gating it would fork every handshake path that carries it.
    #[cfg_attr(not(unix), allow(dead_code))]
    approved_identity: Option<[u8; 65]>,
    /// Set after a `term.input_dropped` for this viewer; cleared by the next
    /// input that is queued, so the relay hears once per run of drops.
    input_drop_notified: bool,
}

impl Viewer {
    fn new(
        keys: DirectionKeys,
        last_size: Option<(u16, u16)>,
        approved_identity: Option<[u8; 65]>,
    ) -> Self {
        Self {
            keys,
            last_rx: 0,
            next_tx: 1,
            last_size,
            approved_identity,
            input_drop_notified: false,
        }
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        wipe(&mut self.keys.browser_to_cli);
        wipe(&mut self.keys.cli_to_browser);
    }
}

/// The shared per-terminal output key. `(key, epoch, seq)` never repeats: a
/// new epoch always gets a new random key and restarts `seq` at 1.
struct OutputKey {
    key: [u8; 32],
    epoch: u32,
    next_seq: u64,
}

impl OutputKey {
    #[cfg_attr(not(unix), allow(dead_code))]
    fn first() -> anyhow::Result<Self> {
        Ok(Self {
            key: terminal_crypto::random_output_key()?,
            epoch: 1,
            next_seq: 1,
        })
    }

    fn rotate(&mut self) -> anyhow::Result<()> {
        let Some(epoch) = self.epoch.checked_add(1) else {
            anyhow::bail!("terminal output epoch is exhausted");
        };
        let mut key = terminal_crypto::random_output_key()?;
        wipe(&mut self.key);
        self.key = key;
        wipe(&mut key);
        self.epoch = epoch;
        self.next_seq = 1;
        Ok(())
    }

    fn take_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        seq
    }
}

impl Drop for OutputKey {
    fn drop(&mut self) {
        wipe(&mut self.key);
    }
}

struct TerminalSession {
    viewers: BTreeMap<String, Viewer>,
    /// The viewer that most recently typed.
    writer: Option<String>,
    pty_size: (u16, u16),
    out: Option<OutputKey>,
    /// Set when the viewer set becomes empty; drives the idle close.
    detached_at: Option<Instant>,
    scrollback: VecDeque<u8>,
    #[cfg(unix)]
    pty: Option<PtyRuntime>,
    /// Set iff this is the operator terminal of an interactive runtime step
    /// (`operator`): no PTY until a person accepts on the confirm screen.
    operator: Option<operator::OperatorState>,
}

impl TerminalSession {
    /// Whether viewer keystrokes may reach the PTY now: not once the shell
    /// has exited.
    fn accepts_input(&self) -> bool {
        #[cfg(unix)]
        return self.pty.as_ref().is_some_and(|pty| pty.exited.is_none());
        #[cfg(not(unix))]
        false
    }

    /// One v2 frame under a viewer's pairwise CLI->browser key.
    fn seal_unicast(
        &mut self,
        terminal_id: &str,
        viewer_id: &str,
        message: &TermPlaintextV2,
    ) -> Option<OutboundFrame> {
        let viewer = self.viewers.get_mut(viewer_id)?;
        let mut plaintext = match terminal_crypto::encode_plaintext_v2(message) {
            Ok(plaintext) => plaintext,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "encoding a terminal frame failed");
                return None;
            }
        };
        let seq = viewer.next_tx;
        viewer.next_tx = viewer.next_tx.saturating_add(1);
        let sealed = terminal_crypto::seal_v2(
            &viewer.keys.cli_to_browser,
            terminal_id,
            viewer_id,
            DIR_CLI_TO_BROWSER,
            seq,
            &plaintext,
        );
        wipe(&mut plaintext);
        match sealed {
            Ok(body) => Some(sealed_frame(terminal_id, seq, Some(viewer_id), None, body)),
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "sealing a unicast terminal frame failed");
                None
            }
        }
    }

    /// One frame under the shared output key, for every attached viewer.
    /// Nothing when no viewer is attached.
    fn seal_broadcast(
        &mut self,
        terminal_id: &str,
        message: &TermPlaintextV2,
    ) -> Option<OutboundFrame> {
        if self.viewers.is_empty() {
            return None;
        }
        let out = self.out.as_mut()?;
        let plaintext = match terminal_crypto::encode_plaintext_v2(message) {
            Ok(plaintext) => plaintext,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "encoding a terminal frame failed");
                return None;
            }
        };
        let seq = out.take_seq();
        match terminal_crypto::seal_broadcast(&out.key, terminal_id, out.epoch, seq, &plaintext) {
            Ok(body) => Some(sealed_frame(terminal_id, seq, None, Some(out.epoch), body)),
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "sealing terminal output failed");
                None
            }
        }
    }

    #[cfg(unix)]
    fn broadcast_data(&mut self, terminal_id: &str, data: &[u8]) -> Vec<OutboundFrame> {
        data.chunks(SEAL_CHUNK)
            .filter(|chunk| !chunk.is_empty())
            .filter_map(|chunk| {
                self.seal_broadcast(terminal_id, &TermPlaintextV2::Data(chunk.to_vec()))
            })
            .collect()
    }

    /// The current output key, unicast to one viewer.
    fn key_frame(&mut self, terminal_id: &str, viewer_id: &str) -> Option<OutboundFrame> {
        let (epoch, key) = {
            let out = self.out.as_ref()?;
            (out.epoch, out.key)
        };
        let mut message = TermPlaintextV2::OutputKey { epoch, key };
        let frame = self.seal_unicast(terminal_id, viewer_id, &message);
        if let TermPlaintextV2::OutputKey { key, .. } = &mut message {
            wipe(key);
        }
        frame
    }

    /// Join order, all unicast: output key, PTY size, then scrollback. The
    /// epoch does not change on a join.
    fn join_frames(&mut self, terminal_id: &str, viewer_id: &str) -> Vec<OutboundFrame> {
        let mut frames = Vec::new();
        frames.extend(self.key_frame(terminal_id, viewer_id));
        let (cols, rows) = self.pty_size;
        frames.extend(self.seal_unicast(
            terminal_id,
            viewer_id,
            &TermPlaintextV2::Resize { cols, rows },
        ));
        let replay = self.scrollback.iter().copied().collect::<Vec<_>>();
        for chunk in replay.chunks(SEAL_CHUNK) {
            frames.extend(self.seal_unicast(
                terminal_id,
                viewer_id,
                &TermPlaintextV2::Data(chunk.to_vec()),
            ));
        }
        frames
    }

    /// Next epoch with a fresh key. Every remaining viewer gets the new key
    /// unicast here, before any later broadcast uses it.
    fn rotate(&mut self, terminal_id: &str) -> anyhow::Result<Vec<OutboundFrame>> {
        let Some(out) = self.out.as_mut() else {
            return Ok(Vec::new());
        };
        out.rotate()?;
        let ids = self.viewers.keys().cloned().collect::<Vec<_>>();
        Ok(ids
            .iter()
            .filter_map(|viewer_id| self.key_frame(terminal_id, viewer_id))
            .collect())
    }

    fn decode_incoming(
        &mut self,
        terminal_id: &str,
        viewer_id: &str,
        seq: u64,
        body: &[u8],
    ) -> Incoming {
        // The relay stamps the viewer id; pick that viewer's keys. Never
        // trial-decrypt under other viewers.
        let Some(viewer) = self.viewers.get_mut(viewer_id) else {
            return Incoming::Ignore;
        };
        let opened = terminal_crypto::open_v2(
            &viewer.keys.browser_to_cli,
            terminal_id,
            viewer_id,
            DIR_BROWSER_TO_CLI,
            seq,
            body,
        );
        // Advance the replay cursor only after the frame authenticates.
        // A relay can rewrite the sequence in the cleartext metadata.
        let Ok(plaintext) = opened else {
            return Incoming::Ignore;
        };
        if !terminal_crypto::accept_seq(&mut viewer.last_rx, seq) {
            return Incoming::Ignore;
        };
        match terminal_crypto::decode_plaintext_v2(&plaintext) {
            Ok(TermPlaintextV2::Data(bytes)) => Incoming::Write(bytes),
            Ok(TermPlaintextV2::Resize { cols, rows }) => Incoming::Resize { cols, rows },
            // A browser never sends an output key. Retired and unknown tags
            // fail to decode.
            Ok(TermPlaintextV2::OutputKey { .. }) | Err(_) => Incoming::DropViewer,
        }
    }
}

struct PendingTerminal {
    cols: u16,
    rows: u16,
    browser_public: [u8; 65],
    browser_nonce: [u8; 16],
    cli_nonce: [u8; 16],
    identity: [u8; 65],
    #[cfg(unix)]
    created: Instant,
    attach: bool,
}

/// `(terminalId, viewerId)`.
type PendingKey = (String, String);

fn pending_key(terminal_id: &str, viewer_id: Option<&str>) -> PendingKey {
    (
        terminal_id.to_string(),
        viewer_id.unwrap_or(LEGACY_VIEWER).to_string(),
    )
}

fn wire_viewer(viewer_key: &str) -> Option<&str> {
    (viewer_key != LEGACY_VIEWER).then_some(viewer_key)
}

pub(crate) struct TerminalRegistry {
    sessions: BTreeMap<String, TerminalSession>,
    pending: BTreeMap<PendingKey, PendingTerminal>,
    #[cfg(unix)]
    tx: SyncSender<FromWorker>,
    #[cfg(unix)]
    idle_limit: Duration,
    /// The state dir from the last successful `term.auth`, for approval re-checks.
    state_dir: Option<PathBuf>,
    #[cfg(unix)]
    next_approval_check: Option<Instant>,
    shut_down: bool,
    #[cfg(unix)]
    shell: Option<(String, Vec<String>)>,
    /// Operator terminals submitted to a runner thread and not yet opened, and
    /// every operator terminal id this session took (ids are never reused).
    operators: operator::OperatorBook,
}

/// A wire exit code (`0..=255`); a status outside it is not reported.
fn wire_exit_code(code: Option<i32>) -> Option<u8> {
    code.and_then(|code| u8::try_from(code).ok())
}

fn term_exit(terminal_id: &str, status: (Option<i32>, Option<i32>)) -> OutboundFrame {
    OutboundFrame::Control(NodeFrame::TermExit {
        terminal_id: terminal_id.to_string(),
        exit_code: wire_exit_code(status.0),
        signal: signal_token(status.1),
    })
}

impl TerminalRegistry {
    pub(crate) fn new(tx: SyncSender<FromWorker>) -> Self {
        // Windows spawns no PTY, so no worker thread needs the channel.
        #[cfg(not(unix))]
        drop(tx);
        Self {
            sessions: BTreeMap::new(),
            pending: BTreeMap::new(),
            #[cfg(unix)]
            tx,
            #[cfg(unix)]
            idle_limit: DEFAULT_IDLE,
            state_dir: None,
            #[cfg(unix)]
            next_approval_check: None,
            shut_down: false,
            #[cfg(unix)]
            shell: None,
            operators: operator::OperatorBook::default(),
        }
    }

    /// Browser shells only: operator terminals have their own cap.
    fn human_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.operator.is_none())
            .count()
    }

    /// A registry with a test shell.
    #[cfg(all(unix, test))]
    fn with_shell(
        tx: SyncSender<FromWorker>,
        idle_limit: Duration,
        program: &str,
        args: &[&str],
    ) -> Self {
        let mut registry = Self::new(tx);
        registry.idle_limit = idle_limit;
        registry.shell = Some((
            program.to_string(),
            args.iter().map(|arg| (*arg).to_string()).collect(),
        ));
        registry
    }

    /// A handshake needs a valid terminal id and a valid viewer id.
    fn ids_ok(handshake: &TermHandshake<'_>) -> bool {
        valid_id(handshake.terminal_id) && handshake.viewer_id.is_some_and(valid_id)
    }

    fn pending_for(&self, terminal_id: &str) -> usize {
        self.pending
            .keys()
            .filter(|(pending_terminal, _)| pending_terminal == terminal_id)
            .count()
    }

    pub(crate) fn kill_all(&mut self) -> Vec<OutboundFrame> {
        if self.shut_down {
            return Vec::new();
        }
        self.shut_down = true;
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let mut frames = Vec::new();
        for id in ids {
            frames.extend(self.close(&id));
        }
        self.pending.clear();
        frames
    }

    pub(crate) fn open(
        &mut self,
        startup: &TerminalStartup,
        state_dir: Option<&Path>,
        handshake: TermHandshake<'_>,
    ) -> Vec<OutboundFrame> {
        if self.sessions.contains_key(handshake.terminal_id) {
            return vec![*handshake_rejected(&handshake, REASON_ALREADY_OPEN)];
        }
        if !Self::ids_ok(&handshake)
            || self
                .pending
                .contains_key(&pending_key(handshake.terminal_id, handshake.viewer_id))
        {
            return vec![*handshake_rejected(&handshake, REASON_BAD_HANDSHAKE)];
        }
        let prepared = match prepare_handshake(startup, self.human_count(), &handshake) {
            Ok(prepared) => prepared,
            Err(reject) => return vec![*reject],
        };
        if startup.require_terminal_approval() {
            return self.queue_pending(state_dir, &handshake, prepared, false);
        }
        #[cfg(not(unix))]
        {
            let _ = prepared;
            vec![*handshake_rejected(&handshake, REASON_UNSUPPORTED)]
        }
        #[cfg(unix)]
        {
            let cli_nonce = match fresh_nonce(&handshake) {
                Ok(nonce) => nonce,
                Err(frame) => return vec![*frame],
            };
            self.open_unix(startup, &handshake, prepared, cli_nonce, None)
        }
    }

    #[cfg(unix)]
    fn open_unix(
        &mut self,
        startup: &TerminalStartup,
        handshake: &TermHandshake<'_>,
        prepared: PreparedHandshake,
        cli_nonce: [u8; 16],
        approved_identity: Option<[u8; 65]>,
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        let viewer_id = handshake.viewer_id;
        if self.human_count() >= startup.max_terminals() {
            return vec![*handshake_rejected(handshake, REASON_LIMIT)];
        }
        let home = match user_home() {
            Ok(path) => path,
            Err(_) => return vec![*handshake_rejected(handshake, REASON_BAD_CWD)],
        };
        let cwd = match child_env::resolve_cwd(None, &home) {
            Ok(path) => path,
            Err(_) => return vec![*handshake_rejected(handshake, REASON_BAD_CWD)],
        };
        let keys = match viewer_id {
            Some(viewer_id) => terminal_crypto::derive_direction_keys_v2(
                startup.key(),
                &prepared.browser_public,
                &prepared.browser_nonce,
                &cli_nonce,
                terminal_id,
                viewer_id,
            ),
            None => terminal_crypto::derive_direction_keys(
                startup.key(),
                &prepared.browser_public,
                &prepared.browser_nonce,
                &cli_nonce,
                terminal_id,
            ),
        };
        let keys = match keys {
            Ok(keys) => keys,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "deriving terminal keys failed");
                return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
            }
        };
        let out = match OutputKey::first() {
            Ok(out) => Some(out),
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "generating a terminal output key failed");
                return vec![*handshake_rejected(handshake, REASON_SPAWN_FAILED)];
            }
        };
        let env = terminal_env();
        let (program, args) = self.shell.clone().unwrap_or_else(child_env::login_shell);
        let pty = match spawn_pty(
            &program,
            &args,
            &cwd,
            &env,
            prepared.cols,
            prepared.rows,
            &self.tx,
            terminal_id,
        ) {
            Ok(pty) => pty,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "opening a terminal failed");
                return vec![*handshake_rejected(handshake, REASON_SPAWN_FAILED)];
            }
        };
        let viewer_key = viewer_id.unwrap_or(LEGACY_VIEWER);
        let mut viewers = BTreeMap::new();
        viewers.insert(
            viewer_key.to_string(),
            Viewer::new(
                keys,
                Some((prepared.cols, prepared.rows)),
                approved_identity,
            ),
        );
        let mut session = TerminalSession {
            viewers,
            // The opener is the first writer.
            writer: viewer_id.map(str::to_string),
            pty_size: (prepared.cols, prepared.rows),
            out,
            detached_at: None,
            scrollback: VecDeque::new(),
            pty: Some(pty),
            operator: None,
        };
        let mut frames = vec![OutboundFrame::Control(NodeFrame::TermOpened {
            terminal_id: terminal_id.to_string(),
            viewer_id: viewer_id.map(str::to_string),
            cli_nonce: terminal_crypto::encode_b64url(&cli_nonce),
        })];
        if let Some(viewer_id) = viewer_id {
            frames.extend(session.join_frames(terminal_id, viewer_id));
            frames.push(term_writer(terminal_id, Some(viewer_id)));
        }
        self.sessions.insert(terminal_id.to_string(), session);
        frames
    }

    pub(crate) fn attach(
        &mut self,
        startup: &TerminalStartup,
        state_dir: Option<&Path>,
        handshake: TermHandshake<'_>,
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        let Some(session) = self.sessions.get(terminal_id) else {
            return vec![*handshake_rejected(&handshake, REASON_NOT_FOUND)];
        };
        // Browser terminals need the local switch and Full control. An
        // operator terminal (one a received `runtime.job.operator` named) is
        // attachable at every trust level (spec §4.4, §4.7).
        let allowed = session.operator.is_some()
            || (startup.allow_human_terminal() && startup.full_control());
        if !allowed || !terminal_supported() {
            return vec![*handshake_rejected(
                &handshake,
                if terminal_supported() {
                    REASON_DISABLED
                } else {
                    REASON_UNSUPPORTED
                },
            )];
        }
        if !Self::ids_ok(&handshake) {
            return vec![*handshake_rejected(&handshake, REASON_BAD_HANDSHAKE)];
        }
        if let Some(viewer_id) = handshake.viewer_id {
            if session.viewers.contains_key(viewer_id)
                || self
                    .pending
                    .contains_key(&pending_key(terminal_id, Some(viewer_id)))
            {
                return vec![*handshake_rejected(&handshake, REASON_BAD_HANDSHAKE)];
            }
            if session.viewers.len() + self.pending_for(terminal_id) >= MAX_VIEWERS {
                return vec![*handshake_rejected(&handshake, REASON_VIEWER_LIMIT)];
            }
        }
        let prepared = match decode_browser_handshake(&handshake) {
            Ok(prepared) => prepared,
            Err(frame) => return vec![*frame],
        };
        if startup.require_terminal_approval() {
            // Current viewers stay attached; this one joins after `term.auth`.
            return self.queue_pending(state_dir, &handshake, prepared, true);
        }
        let cli_nonce = match fresh_nonce(&handshake) {
            Ok(nonce) => nonce,
            Err(frame) => return vec![*frame],
        };
        self.finish_attach(startup, &handshake, &prepared, cli_nonce, None)
    }

    pub(crate) fn auth(
        &mut self,
        startup: &TerminalStartup,
        state_dir: Option<&Path>,
        terminal_id: &str,
        viewer_id: Option<&str>,
        signature: &str,
    ) -> Vec<OutboundFrame> {
        let Some(viewer_id) = viewer_id else {
            return Vec::new();
        };
        let viewer_id = Some(viewer_id);
        let key = pending_key(terminal_id, viewer_id);
        let Some(pending) = self.pending.get(&key) else {
            return Vec::new();
        };
        // Only a join to an operator terminal is allowed below Full control;
        // anything else needs the browser-terminal switch and Full control now,
        // not just when it was queued.
        let operator_join = pending.attach
            && self
                .sessions
                .get(terminal_id)
                .is_some_and(|session| session.operator.is_some());
        if !operator_join && !(startup.allow_human_terminal() && startup.full_control()) {
            self.pending.remove(&key);
            return vec![term_rejected(terminal_id, viewer_id, REASON_DISABLED, None)];
        }
        if !approval_signature_ok(
            &pending.identity,
            signature,
            terminal_id,
            viewer_id,
            &pending.browser_public,
            &pending.browser_nonce,
            startup.key().public_raw(),
            &pending.cli_nonce,
        ) {
            self.pending.remove(&key);
            return vec![term_rejected(
                terminal_id,
                viewer_id,
                REASON_BAD_SIGNATURE,
                None,
            )];
        }
        let code = terminal_crypto::approval_code(&pending.identity);
        let approved = state_dir.is_some_and(|dir| {
            approved_public_key(dir, &code)
                .ok()
                .flatten()
                .is_some_and(|stored| stored == pending.identity)
        });
        if !approved {
            return vec![term_rejected(
                terminal_id,
                viewer_id,
                REASON_APPROVAL_REQUIRED,
                Some(code),
            )];
        }
        let Some(pending) = self.pending.remove(&key) else {
            return Vec::new();
        };
        if let Some(dir) = state_dir {
            self.state_dir = Some(dir.to_path_buf());
        }
        let prepared = PreparedHandshake {
            cols: pending.cols,
            rows: pending.rows,
            browser_public: pending.browser_public,
            browser_nonce: pending.browser_nonce,
        };
        let handshake = TermHandshake {
            terminal_id,
            viewer_id,
            cols: prepared.cols,
            rows: prepared.rows,
            browser_public_key: "",
            browser_nonce: "",
            identity: None,
        };
        if pending.attach {
            if !self.sessions.contains_key(terminal_id) {
                return vec![*handshake_rejected(&handshake, REASON_NOT_FOUND)];
            }
            return self.finish_attach(
                startup,
                &handshake,
                &prepared,
                pending.cli_nonce,
                Some(pending.identity),
            );
        }
        #[cfg(not(unix))]
        {
            vec![*handshake_rejected(&handshake, REASON_UNSUPPORTED)]
        }
        #[cfg(unix)]
        {
            self.open_unix(
                startup,
                &handshake,
                prepared,
                pending.cli_nonce,
                Some(pending.identity),
            )
        }
    }

    fn queue_pending(
        &mut self,
        state_dir: Option<&Path>,
        handshake: &TermHandshake<'_>,
        prepared: PreparedHandshake,
        attach: bool,
    ) -> Vec<OutboundFrame> {
        let identity = match identity_public(handshake.identity) {
            Ok(raw) => raw,
            Err(reason) => return vec![*handshake_rejected(handshake, reason)],
        };
        let approval_code = approval_code_for_identity(state_dir, &identity);
        let cli_nonce = match fresh_nonce(handshake) {
            Ok(nonce) => nonce,
            Err(frame) => return vec![*frame],
        };
        self.pending.insert(
            pending_key(handshake.terminal_id, handshake.viewer_id),
            PendingTerminal {
                cols: prepared.cols,
                rows: prepared.rows,
                browser_public: prepared.browser_public,
                browser_nonce: prepared.browser_nonce,
                cli_nonce,
                identity,
                #[cfg(unix)]
                created: Instant::now(),
                attach,
            },
        );
        vec![term_pending(
            handshake.terminal_id,
            handshake.viewer_id,
            &terminal_crypto::encode_b64url(&cli_nonce),
            approval_code,
        )]
    }

    fn finish_attach(
        &mut self,
        startup: &TerminalStartup,
        handshake: &TermHandshake<'_>,
        prepared: &PreparedHandshake,
        cli_nonce: [u8; 16],
        approved_identity: Option<[u8; 65]>,
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        let viewer_id = handshake.viewer_id;
        let keys = match viewer_id {
            Some(viewer_id) => terminal_crypto::derive_direction_keys_v2(
                startup.key(),
                &prepared.browser_public,
                &prepared.browser_nonce,
                &cli_nonce,
                terminal_id,
                viewer_id,
            ),
            None => terminal_crypto::derive_direction_keys(
                startup.key(),
                &prepared.browser_public,
                &prepared.browser_nonce,
                &cli_nonce,
                terminal_id,
            ),
        };
        let Ok(keys) = keys else {
            return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
        };
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return vec![*handshake_rejected(handshake, REASON_NOT_FOUND)];
        };
        let viewer_key = viewer_id.unwrap_or(LEGACY_VIEWER);
        if session.viewers.contains_key(viewer_key) {
            return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
        }
        session.viewers.insert(
            viewer_key.to_string(),
            Viewer::new(keys, None, approved_identity),
        );
        session.detached_at = None;
        let mut frames = vec![OutboundFrame::Control(NodeFrame::TermAttached {
            terminal_id: terminal_id.to_string(),
            viewer_id: viewer_id.map(str::to_string),
            cli_nonce: terminal_crypto::encode_b64url(&cli_nonce),
        })];
        frames.extend(session.join_frames(terminal_id, viewer_key));
        // An operator terminal still on its confirm screen shows it.
        frames.extend(session.confirm_screen_for(terminal_id, viewer_key));
        frames
    }

    /// Stop viewing (the tab's X, or the tab went away). A pending approval
    /// for that viewer is dropped too.
    pub(crate) fn detach(
        &mut self,
        terminal_id: &str,
        viewer_id: Option<&str>,
    ) -> Vec<OutboundFrame> {
        let Some(viewer_id) = viewer_id else {
            return Vec::new();
        };
        self.pending
            .remove(&pending_key(terminal_id, Some(viewer_id)));
        self.remove_viewer(terminal_id, viewer_id, None)
    }

    /// A malformed relay frame that names a viewer. Removes only that viewer
    /// (or its pending approval).
    pub(crate) fn drop_viewer(&mut self, terminal_id: &str, viewer_id: &str) -> Vec<OutboundFrame> {
        if self
            .pending
            .remove(&pending_key(terminal_id, Some(viewer_id)))
            .is_some()
        {
            return vec![term_rejected(
                terminal_id,
                Some(viewer_id),
                REASON_BAD_FRAME,
                None,
            )];
        }
        self.remove_viewer(terminal_id, viewer_id, Some(REASON_BAD_FRAME))
    }

    /// Leave: detach, per-viewer fault, or approval revoked. The writer
    /// becomes none if it left (the PTY keeps its size), and the output key
    /// rotates so the leaver cannot read later frames. `notify` tells the
    /// relay why the CLI removed the viewer on its own.
    fn remove_viewer(
        &mut self,
        terminal_id: &str,
        viewer_id: &str,
        notify: Option<&str>,
    ) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        if session.viewers.remove(viewer_id).is_none() {
            return Vec::new();
        }
        let mut frames = Vec::new();
        if let Some(reason) = notify {
            frames.push(term_rejected(terminal_id, Some(viewer_id), reason, None));
        }
        if session.writer.as_deref() == Some(viewer_id) {
            session.writer = None;
            frames.push(term_writer(terminal_id, None));
        }
        if session.viewers.is_empty() {
            session.detached_at = Some(Instant::now());
        }
        match session.rotate(terminal_id) {
            Ok(key_frames) => frames.extend(key_frames),
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "rotating the terminal output key failed");
                frames.extend(self.close(terminal_id));
            }
        }
        frames
    }

    /// End the terminal now.
    pub(crate) fn close(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        let Some(mut session) = self.sessions.remove(terminal_id) else {
            return Vec::new();
        };
        #[cfg(unix)]
        let (ran, status) = match session.pty.take() {
            Some(pty) => (true, shutdown_pty(pty)),
            None => (false, (None, None)),
        };
        #[cfg(not(unix))]
        let (ran, status) = (false, (None, None));
        let mut frames = vec![term_exit(terminal_id, status)];
        // An operator terminal answers for its step after its exit.
        if let Some(state) = session.operator.take() {
            frames.extend(state.ended(ran, status));
        }
        frames
    }

    pub(crate) fn handle_sealed(
        &mut self,
        terminal_id: &str,
        viewer_id: Option<&str>,
        seq: u64,
        body: &[u8],
    ) -> Vec<OutboundFrame> {
        let Some(viewer_id) = viewer_id else {
            tracing::warn!(terminal_id, "ignoring a sealed frame without a viewer id");
            return Vec::new();
        };
        let viewer_key = viewer_id.to_string();
        let action = {
            let Some(session) = self.sessions.get_mut(terminal_id) else {
                tracing::warn!(
                    terminal_id,
                    "ignoring a sealed frame for an unknown terminal"
                );
                return Vec::new();
            };
            session.decode_incoming(terminal_id, &viewer_key, seq, body)
        };
        match action {
            Incoming::Write(bytes)
                if self
                    .sessions
                    .get(terminal_id)
                    .is_some_and(TerminalSession::confirming) =>
            {
                // The confirm screen reads keys itself; nothing reaches a process.
                self.confirm_input(terminal_id, &viewer_key, &bytes)
            }
            Incoming::Write(bytes) => {
                // Input after the shell exited is dropped here for good.
                if !self
                    .sessions
                    .get(terminal_id)
                    .is_some_and(TerminalSession::accepts_input)
                {
                    return Vec::new();
                }
                let mut frames = Vec::new();
                match self.claim_writer(terminal_id, &viewer_key) {
                    Ok(claimed) => frames.extend(claimed),
                    Err(_) => {
                        frames.extend(self.close(terminal_id));
                        return frames;
                    }
                }
                match self.enqueue_input(terminal_id, bytes) {
                    Ok(queued) => frames.extend(self.note_input(terminal_id, &viewer_key, queued)),
                    Err(_) => frames.extend(self.close(terminal_id)),
                }
                frames
            }
            Incoming::Resize { cols, rows } => {
                let applies = {
                    let Some(session) = self.sessions.get_mut(terminal_id) else {
                        return Vec::new();
                    };
                    if let Some(viewer) = session.viewers.get_mut(&viewer_key) {
                        viewer.last_size = Some((cols, rows));
                    }
                    session
                        .writer
                        .as_deref()
                        .is_none_or(|writer| writer == viewer_key)
                };
                if !applies {
                    return Vec::new();
                }
                match self.apply_size(terminal_id, cols, rows) {
                    Ok(frames) => frames,
                    Err(_) => self.close(terminal_id),
                }
            }
            Incoming::Ignore => Vec::new(),
            Incoming::DropViewer => {
                tracing::warn!(terminal_id, "removing a viewer after a bad terminal frame");
                self.remove_viewer(terminal_id, &viewer_key, Some(REASON_BAD_FRAME))
            }
        }
    }

    /// Track dropped input per viewer. The first drop in a run yields one
    /// `term.input_dropped`; a later queued frame ends the run.
    fn note_input(
        &mut self,
        terminal_id: &str,
        viewer_key: &str,
        queued: bool,
    ) -> Option<OutboundFrame> {
        let viewer = self
            .sessions
            .get_mut(terminal_id)?
            .viewers
            .get_mut(viewer_key)?;
        if queued {
            viewer.input_drop_notified = false;
            return None;
        }
        if viewer.input_drop_notified {
            return None;
        }
        viewer.input_drop_notified = true;
        tracing::warn!(terminal_id, "terminal input queue is full; dropping input");
        Some(OutboundFrame::Control(NodeFrame::TermInputDropped {
            terminal_id: terminal_id.to_string(),
            viewer_id: wire_viewer(viewer_key).map(str::to_string),
        }))
    }

    /// A data frame from a non-writer makes it the writer and applies its
    /// last size before the caller writes. Resize-only frames never get here.
    fn claim_writer(
        &mut self,
        terminal_id: &str,
        viewer_id: &str,
    ) -> std::io::Result<Vec<OutboundFrame>> {
        let size = {
            let Some(session) = self.sessions.get_mut(terminal_id) else {
                return Ok(Vec::new());
            };
            if session.writer.as_deref() == Some(viewer_id) {
                return Ok(Vec::new());
            }
            session.writer = Some(viewer_id.to_string());
            session
                .viewers
                .get(viewer_id)
                .and_then(|viewer| viewer.last_size)
        };
        let mut frames = vec![term_writer(terminal_id, Some(viewer_id))];
        if let Some((cols, rows)) = size {
            frames.extend(self.apply_size(terminal_id, cols, rows)?);
        }
        Ok(frames)
    }

    /// Resize the PTY if the size differs, then broadcast the new size.
    fn apply_size(
        &mut self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> std::io::Result<Vec<OutboundFrame>> {
        if self
            .sessions
            .get(terminal_id)
            .is_some_and(|session| session.pty_size == (cols, rows))
        {
            return Ok(Vec::new());
        }
        self.resize_terminal(terminal_id, cols, rows)?;
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Ok(Vec::new());
        };
        let mut frames: Vec<OutboundFrame> = session
            .seal_broadcast(terminal_id, &TermPlaintextV2::Resize { cols, rows })
            .into_iter()
            .collect();
        // A confirm screen is laid out again for the new width.
        frames.extend(session.confirm_repaint(terminal_id));
        Ok(frames)
    }

    /// PTY output: recorded in the scrollback, sealed for the viewers.
    #[cfg(unix)]
    pub(crate) fn on_bytes(&mut self, terminal_id: &str, bytes: &[u8]) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        // Scrollback is always recorded; output is sealed only for viewers.
        push_scrollback(&mut session.scrollback, bytes);
        session.broadcast_data(terminal_id, bytes)
    }

    /// PTY EOF.
    #[cfg(unix)]
    pub(crate) fn on_eof(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        self.close(terminal_id)
    }

    /// Expire pending approvals, re-check approvals, close exited shells and
    /// idle detached terminals.
    #[cfg(unix)]
    pub(crate) fn poll(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let mut frames = Vec::new();
        let expired_pending = self
            .pending
            .iter()
            .filter(|(_, pending)| now.saturating_duration_since(pending.created) >= PENDING_TTL)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in expired_pending {
            self.pending.remove(&key);
            frames.push(term_rejected(
                &key.0,
                wire_viewer(&key.1),
                REASON_EXPIRED,
                None,
            ));
        }
        frames.extend(self.recheck_approvals(now));
        #[cfg(unix)]
        frames.extend(self.close_exited_shells(now));
        // Pending viewers do not keep a terminal alive.
        let expired = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                // An operator step may wait for its person indefinitely.
                session.operator.is_none()
                    && session.viewers.is_empty()
                    && session.detached_at.is_some_and(|detached| {
                        now.saturating_duration_since(detached) >= self.idle_limit
                    })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            frames.extend(self.close(&id));
        }
        frames
    }

    /// Reap shells that have exited and close their terminals once the output
    /// they left is drained. PTY EOF alone is not enough: a background or
    /// disowned job (`sleep 30 & disown; exit`) keeps the PTY open after the
    /// shell is gone. The close kills every process left in the shell's
    /// session and reports the shell's own exit status.
    #[cfg(unix)]
    fn close_exited_shells(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let mut drained = Vec::new();
        for (terminal_id, session) in &mut self.sessions {
            let Some(pty) = session.pty.as_mut() else {
                continue;
            };
            if pty.exited.is_none() {
                let (code, signal) = reap_pid(pty.pid);
                if code.is_some() || signal.is_some() {
                    pty.exited = Some((code, signal, now));
                }
            }
            if pty.exited.is_some_and(|(_, _, at)| {
                now.saturating_duration_since(at) >= TERMINAL_OUTPUT_DRAIN
            }) {
                drained.push(terminal_id.clone());
            }
        }
        let mut frames = Vec::new();
        for terminal_id in drained {
            frames.extend(self.close(&terminal_id));
        }
        frames
    }

    /// 2.5: a viewer whose approval was revoked leaves (and the key rotates).
    #[cfg(unix)]
    fn recheck_approvals(&mut self, now: Instant) -> Vec<OutboundFrame> {
        if self.next_approval_check.is_some_and(|next| now < next) {
            return Vec::new();
        }
        self.next_approval_check = Some(now + APPROVAL_RECHECK);
        let Some(dir) = self.state_dir.clone() else {
            return Vec::new();
        };
        let revoked = self
            .sessions
            .iter()
            .flat_map(|(terminal_id, session)| {
                session
                    .viewers
                    .iter()
                    .filter(|(_, viewer)| {
                        viewer
                            .approved_identity
                            .is_some_and(|identity| !identity_still_approved(&dir, &identity))
                    })
                    .map(|(viewer_id, _)| (terminal_id.clone(), viewer_id.clone()))
            })
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
        for (terminal_id, viewer_id) in revoked {
            frames.extend(self.remove_viewer(
                &terminal_id,
                &viewer_id,
                Some(REASON_APPROVAL_REQUIRED),
            ));
        }
        frames
    }

    /// Hand input to the terminal's writer thread without blocking.
    /// `Ok(false)`: the input queue is full and the bytes were dropped.
    #[cfg(unix)]
    fn enqueue_input(&mut self, terminal_id: &str, bytes: Vec<u8>) -> std::io::Result<bool> {
        let Some(session) = self.sessions.get(terminal_id) else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        let Some(pty) = session.pty.as_ref() else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        pty.input.push(bytes)
    }

    #[cfg(not(unix))]
    fn enqueue_input(&mut self, _terminal_id: &str, _bytes: Vec<u8>) -> std::io::Result<bool> {
        Err(std::io::Error::other("terminals are unsupported"))
    }

    #[cfg(unix)]
    fn resize_terminal(&mut self, terminal_id: &str, cols: u16, rows: u16) -> std::io::Result<()> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        if session.confirming() {
            // No PTY yet: the size waits for the command's PTY.
            session.pty_size = (cols, rows);
            return Ok(());
        }
        let Some(pty) = session.pty.as_mut() else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        pty.master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        session.pty_size = (cols, rows);
        Ok(())
    }

    #[cfg(not(unix))]
    fn resize_terminal(
        &mut self,
        _terminal_id: &str,
        _cols: u16,
        _rows: u16,
    ) -> std::io::Result<()> {
        Err(std::io::Error::other("terminals are unsupported"))
    }
}

impl Drop for TerminalRegistry {
    fn drop(&mut self) {
        let _ = self.kill_all();
    }
}

#[cfg(unix)]
fn terminal_env() -> Vec<(String, String)> {
    let mut env = scrub_parent_env(&[]);
    env.retain(|(name, _)| name != "TERM");
    env.push(("TERM".to_string(), "xterm-256color".to_string()));
    env
}

/// Borrows a raw descriptor long enough for `filedescriptor` to `dup` it.
/// The number stays valid because the `MasterPty` that owns it is still alive.
#[cfg(unix)]
struct RawFdHandle(std::os::fd::RawFd);

#[cfg(unix)]
impl std::os::fd::AsRawFd for RawFdHandle {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.0
    }
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn spawn_pty(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
    tx: &SyncSender<FromWorker>,
    terminal_id: &str,
) -> anyhow::Result<PtyRuntime> {
    let system = portable_pty::native_pty_system();
    let pair = system.openpty(portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = portable_pty::CommandBuilder::new(program);
    command.env_clear();
    for arg in args {
        command.arg(arg);
    }
    command.cwd(cwd);
    for (name, value) in env {
        command.env(name, value);
    }
    // portable-pty's reader is a private fd with no safe `AsFd`. Opening
    // `/proc/self/fd/N` follows `/dev/ptmx` and allocates a different pty, so
    // duplicate the master with `dup(2)` and poll that copy. Do this before
    // spawn so a failed dup does not leave a child running.
    let raw = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| anyhow::anyhow!("pty master has no file descriptor"))?;
    let reader = filedescriptor::FileDescriptor::dup(&RawFdHandle(raw))?;
    // The writer thread gets its own copy of the master and writes it
    // non-blocking, so a full PTY input buffer never pins that thread past
    // close. `O_NONBLOCK` is shared by every copy of the master; the reader
    // polls before it reads and treats `WouldBlock` as "try again".
    let writer = filedescriptor::FileDescriptor::dup(&RawFdHandle(raw))?;
    let flags = nix::fcntl::OFlag::from_bits_truncate(nix::fcntl::fcntl(
        &writer,
        nix::fcntl::FcntlArg::F_GETFL,
    )?);
    nix::fcntl::fcntl(
        &writer,
        nix::fcntl::FcntlArg::F_SETFL(flags | nix::fcntl::OFlag::O_NONBLOCK),
    )?;
    let child = pair.slave.spawn_command(command)?;
    let pid = child.process_id();
    let tracked = pid.map(|pid| LiveChildGuard::track(LiveChild::PtySession(pid)));
    let stop = Arc::new(AtomicBool::new(false));
    let input = Arc::new(InputQueue::new());
    let writer_thread = pump_input(
        writer,
        Arc::clone(&input),
        tx.clone(),
        Arc::clone(&stop),
        terminal_id.to_string(),
    );
    let terminal_id = terminal_id.to_string();
    let eof_id = terminal_id.clone();
    let thread = pump_polled(
        reader,
        tx.clone(),
        Arc::clone(&stop),
        move |bytes| FromWorker::TerminalBytes {
            terminal_id: terminal_id.clone(),
            bytes,
        },
        move || FromWorker::TerminalEof {
            terminal_id: eof_id.clone(),
        },
    );
    Ok(PtyRuntime {
        child,
        master: pair.master,
        input,
        writer: Some(writer_thread),
        reader: Some(thread),
        stop,
        pid,
        exited: None,
        _tracked: tracked,
    })
}

/// Masked output a command keeps for `exec.poll` (a ring: the newest bytes).
const EXEC_OUTPUT_RING_BYTES: usize = 1024 * 1024;
/// Ended commands whose status `exec.poll` still answers.
const EXEC_RECENT_MAX: usize = 64;
/// The tail an unprompted end status carries.
const EXEC_END_TAIL_BYTES: usize = 4 * 1024;

/// The newest masked output bytes of one command, stdout and stderr in the
/// order they were read.
#[derive(Default)]
struct OutputRing {
    bytes: VecDeque<u8>,
    total: u64,
}

impl OutputRing {
    fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len() as u64);
        self.bytes.extend(bytes);
        let overflow = self.bytes.len().saturating_sub(EXEC_OUTPUT_RING_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }
    }

    /// The last at most `max` bytes as text, cut on a character boundary.
    fn tail(&self, max: usize) -> String {
        let start = self.bytes.len().saturating_sub(max);
        let raw = self.bytes.iter().skip(start).copied().collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&raw).into_owned();
        // Lossy decoding can grow the text; keep it within `max`.
        let mut cut = text.len().saturating_sub(max);
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        text[cut..].to_string()
    }
}

struct ExecSession {
    child: Option<ExecChild>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    /// The end of this command's lifetime: its `timeout_ms`, capped by the
    /// node's `command_max_ms`.
    deadline: Instant,
    started_at: String,
    ends_by: String,
    /// Independent restartable state: stdout cannot open a run on stderr.
    stdout_mask: StreamMasker,
    stderr_mask: StreamMasker,
    output: OutputRing,
    stdout_done: bool,
    stderr_done: bool,
    timed_out: bool,
    finished: bool,
    pid: u32,
    /// Its start time, read once at spawn (the leader may be reaped later).
    start_ticks: Option<u64>,
    /// Exit status and the instant `try_wait` reaped the direct child.
    reaped: Option<(Option<i32>, Option<i32>, Instant)>,
    _tracked: LiveChildGuard,
}

/// A command that ended, kept for `exec.poll`.
struct EndedCommand {
    status: ExecStatus,
    output: OutputRing,
}

/// How a command ended, when the node itself ended it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EndCause {
    /// It exited (or the node saw it gone).
    Exited,
    Cancelled,
    TimedOut,
    /// The daemon shut down with the command running.
    Interrupted,
}

pub(crate) struct ExecRegistry {
    sessions: BTreeMap<String, ExecSession>,
    ended: VecDeque<(String, EndedCommand)>,
    tx: SyncSender<FromWorker>,
    /// The node's `command_max_ms`: no command lives longer.
    command_max: Duration,
    shut_down: bool,
    /// `node-commands.json`: the commands running now, so a daemon that died
    /// can report them `interrupted` (and end their process groups) when it
    /// starts again. `None` in tests that do not persist.
    table: Option<PathBuf>,
}

/// One running command as persisted (no command text, no output).
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunningCommand {
    command_id: String,
    pid: u32,
    /// `/proc/<pid>/stat` start time, so a reused pid is never signalled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_ticks: Option<u64>,
    started_at: String,
    ends_by: String,
}

#[cfg(target_os = "linux")]
fn process_start_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    // Field 22 overall; the 20th after `pid (comm)`.
    rest.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(not(target_os = "linux"))]
fn process_start_ticks(_pid: u32) -> Option<u64> {
    None
}

/// The leader is gone but members of its process group, started no earlier
/// than it, remain (a background child of the command).
#[cfg(target_os = "linux")]
fn group_outlived_leader(pgid: u32, leader_ticks: u64) -> bool {
    if std::path::Path::new(&format!("/proc/{pgid}")).exists() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            return false;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some(rest) = stat.rfind(')').map(|at| &stat[at + 1..]) else {
            return false;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        // After `pid (comm)`: state ppid pgrp ... starttime is the 20th.
        fields.get(2).and_then(|pgrp| pgrp.parse::<u32>().ok()) == Some(pgid)
            && fields
                .get(19)
                .and_then(|ticks| ticks.parse::<u64>().ok())
                .is_some_and(|ticks| ticks >= leader_ticks)
    })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn group_outlived_leader(_pgid: u32, _leader_ticks: u64) -> bool {
    false
}

impl ExecRegistry {
    pub(crate) fn new(tx: SyncSender<FromWorker>, command_max: Duration) -> Self {
        Self {
            sessions: BTreeMap::new(),
            ended: VecDeque::new(),
            tx,
            command_max,
            shut_down: false,
            table: None,
        }
    }

    /// Persist running commands to `path`, and report the ones a previous
    /// daemon left running as `interrupted`: their process groups are ended
    /// first (only when the pid still names the same process).
    pub(crate) fn with_table(mut self, path: PathBuf) -> (Self, Vec<OutboundFrame>) {
        let left: Vec<RunningCommand> = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let mut frames = Vec::new();
        for command in left {
            if !valid_id(&command.command_id) {
                continue;
            }
            #[cfg(unix)]
            if let Some(ticks) = command.start_ticks
                && (process_start_ticks(command.pid) == Some(ticks)
                    || group_outlived_leader(command.pid, ticks))
            {
                kill_process_group(command.pid, false);
            }
            let status = ExecStatus {
                command_id: command.command_id.clone(),
                state: ExecState::Interrupted,
                exit_code: None,
                signal: None,
                started_at: Some(command.started_at),
                ends_by: Some(command.ends_by),
                finished_at: Some(crate::telemetry::now_rfc3339()),
                tail: None,
                truncated: None,
                output_bytes: None,
            };
            log_command_op("exec", &command.command_id, "interrupted by a restart");
            self.ended.push_back((
                command.command_id,
                EndedCommand {
                    status: status.clone(),
                    output: OutputRing::default(),
                },
            ));
            frames.push(OutboundFrame::Control(NodeFrame::ExecStatus(status)));
        }
        while self.ended.len() > EXEC_RECENT_MAX {
            self.ended.pop_front();
        }
        self.table = Some(path);
        self.save_table();
        (self, frames)
    }

    /// The node definition's `commandMaxMs` (applies to later commands).
    pub(crate) fn set_command_max(&mut self, command_max: Duration) {
        self.command_max = command_max.min(DEFAULT_COMMAND_MAX);
    }

    fn save_table(&self) {
        if self.shut_down {
            // `kill_all` wrote the rows the next daemon reports.
            return;
        }
        let running: Vec<RunningCommand> = self
            .sessions
            .iter()
            .map(|(id, session)| RunningCommand {
                command_id: id.clone(),
                pid: session.pid,
                start_ticks: session.start_ticks,
                started_at: session.started_at.clone(),
                ends_by: session.ends_by.clone(),
            })
            .collect();
        self.write_rows(&running);
    }

    fn write_rows(&self, running: &[RunningCommand]) {
        let Some(path) = &self.table else {
            return;
        };
        let written = serde_json::to_vec(running)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| {
                crate::approvals::write_private_atomic(path, &bytes, "node commands", false)
            });
        if let Err(error) = written {
            tracing::warn!(error = %format!("{error:#}"), "recording running commands failed");
        }
    }

    /// The daemon is shutting down: end every command. Their rows stay in
    /// the table (without a start time, so nothing is signalled again) and
    /// the next daemon reports them `interrupted` too, in case this
    /// connection could not.
    pub(crate) fn kill_all(&mut self) -> Vec<OutboundFrame> {
        if self.shut_down {
            return Vec::new();
        }
        self.shut_down = true;
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let rows: Vec<RunningCommand> = self
            .sessions
            .iter()
            .map(|(id, session)| RunningCommand {
                command_id: id.clone(),
                pid: session.pid,
                start_ticks: None,
                started_at: session.started_at.clone(),
                ends_by: session.ends_by.clone(),
            })
            .collect();
        let mut frames = Vec::new();
        for id in ids {
            frames.extend(self.finish(&id, EndCause::Interrupted));
        }
        self.write_rows(&rows);
        frames
    }

    /// Lowering to Relay only: end every running command (its whole process
    /// tree) and report each `interrupted`. The registry keeps answering polls.
    pub(crate) fn interrupt_all(&mut self) -> Vec<OutboundFrame> {
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let mut frames = Vec::new();
        for id in ids {
            frames.extend(self.finish(&id, EndCause::Interrupted));
        }
        frames
    }

    pub(crate) fn start(
        &mut self,
        startup: &TerminalStartup,
        command_id: &str,
        command: &str,
        cwd: Option<&str>,
        timeout_ms: u64,
    ) -> Vec<OutboundFrame> {
        if !valid_id(command_id) {
            return vec![exec_rejected(command_id, REASON_BAD_COMMAND)];
        }
        // Commands run only at Full control.
        if !startup.full_control() {
            return vec![exec_rejected(command_id, REASON_TRUST_RELAY)];
        }
        if self.sessions.contains_key(command_id) {
            return vec![exec_rejected(command_id, REASON_ALREADY_OPEN)];
        }
        if self.sessions.len() >= MAX_EXECS {
            return vec![exec_rejected(command_id, REASON_LIMIT)];
        }
        if let Err(reason) = child_env::validate_command(command) {
            tracing::warn!(command_id, reason, "rejecting an exec command");
            return vec![exec_rejected(command_id, REASON_BAD_COMMAND)];
        }
        let home = match user_home() {
            Ok(path) => path,
            Err(reason) => {
                tracing::warn!(command_id, reason, "rejecting an exec command");
                return vec![exec_rejected(command_id, REASON_BAD_CWD)];
            }
        };
        let cwd = match child_env::resolve_cwd(cwd, &home) {
            Ok(path) => path,
            Err(reason) => {
                tracing::warn!(command_id, reason, "rejecting an exec working directory");
                return vec![exec_rejected(command_id, REASON_BAD_CWD)];
            }
        };
        let lifetime = Duration::from_millis(timeout_ms).min(self.command_max);
        match spawn_exec(&self.tx, command_id, command, &cwd, lifetime) {
            Ok(session) => {
                let frame = NodeFrame::ExecStarted {
                    command_id: command_id.to_string(),
                    started_at: session.started_at.clone(),
                    ends_by: session.ends_by.clone(),
                };
                // A restarted command id replaces its ended record.
                self.ended.retain(|(id, _)| id != command_id);
                self.sessions.insert(command_id.to_string(), session);
                self.save_table();
                log_command_op("exec", command_id, "started");
                vec![OutboundFrame::Control(frame)]
            }
            Err(error) => {
                tracing::warn!(error = %error, command_id, "starting an exec failed");
                vec![exec_rejected(command_id, REASON_SPAWN_FAILED)]
            }
        }
    }

    pub(crate) fn cancel(&mut self, command_id: &str) -> Vec<OutboundFrame> {
        self.finish(command_id, EndCause::Cancelled)
    }

    /// `exec.poll`: the command's state and the last `tail_bytes` of its
    /// masked output. An unknown id answers `unknown`.
    pub(crate) fn status(&self, command_id: &str, tail_bytes: usize) -> Vec<OutboundFrame> {
        let tail_bytes = tail_bytes.min(NODE_COMMAND_TAIL_MAX_BYTES);
        let status = if let Some(session) = self.sessions.get(command_id) {
            with_tail(
                ExecStatus {
                    command_id: command_id.to_string(),
                    state: ExecState::Running,
                    exit_code: None,
                    signal: None,
                    started_at: Some(session.started_at.clone()),
                    ends_by: Some(session.ends_by.clone()),
                    finished_at: None,
                    tail: None,
                    truncated: None,
                    output_bytes: None,
                },
                &session.output,
                tail_bytes,
            )
        } else if let Some((_, ended)) = self.ended.iter().find(|(id, _)| id == command_id) {
            with_tail(ended.status.clone(), &ended.output, tail_bytes)
        } else {
            ExecStatus {
                command_id: command_id.to_string(),
                state: ExecState::Unknown,
                exit_code: None,
                signal: None,
                started_at: None,
                ends_by: None,
                finished_at: Some(crate::telemetry::now_rfc3339()),
                tail: None,
                truncated: None,
                output_bytes: None,
            }
        };
        vec![OutboundFrame::Control(NodeFrame::ExecStatus(status))]
    }

    /// An `exec.start` the daemon could not read (for example a string with
    /// an unpaired surrogate): refuse it so the server's request ends now.
    /// Nothing runs. A command already running under that id is untouched.
    pub(crate) fn reject_malformed(&self, command_id: &str) -> Vec<OutboundFrame> {
        if !valid_id(command_id) || self.sessions.contains_key(command_id) {
            return Vec::new();
        }
        vec![exec_rejected(command_id, REASON_BAD_COMMAND)]
    }

    pub(crate) fn on_bytes(&mut self, command_id: &str, stderr: bool, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let Some(session) = self.sessions.get_mut(command_id) else {
            return;
        };
        if session.finished {
            return;
        }
        let masked = if stderr {
            session.stderr_mask.push(bytes)
        } else {
            session.stdout_mask.push(bytes)
        };
        session.output.push(&masked);
    }

    pub(crate) fn on_eof(&mut self, command_id: &str, stderr: bool) {
        let Some(session) = self.sessions.get_mut(command_id) else {
            return;
        };
        if session.finished {
            return;
        }
        let masked = if stderr {
            session.stderr_done = true;
            session.stderr_mask.finish()
        } else {
            session.stdout_done = true;
            session.stdout_mask.finish()
        };
        // Pipes can close while the process is still running (`sleep
        // >/dev/null`). Reaping happens on `poll` via `try_wait`.
        session.output.push(&masked);
    }

    pub(crate) fn poll(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let mut frames = Vec::new();
        for id in ids {
            let action = {
                let Some(session) = self.sessions.get_mut(&id) else {
                    continue;
                };
                if session.finished {
                    continue;
                }
                let timed_out = now >= session.deadline;
                if timed_out && !session.timed_out {
                    session.timed_out = true;
                    kill_exec(session.pid, session.child.as_mut(), true);
                    let status = reap_child(session.child.as_mut());
                    if status.0.is_some() || status.1.is_some() {
                        session.reaped = Some((status.0, status.1, now));
                    }
                } else if session.reaped.is_none()
                    && let Some(Some(status)) = session
                        .child
                        .as_mut()
                        .and_then(|child| child.try_wait().ok())
                {
                    let parts = status_parts(status);
                    // The direct child is already reaped. Kill grandchildren
                    // that stayed in its group, without signalling the pid
                    // itself again.
                    #[cfg(not(windows))]
                    kill_exec(session.pid, None, false);
                    #[cfg(windows)]
                    kill_exec(session.pid, session.child.as_mut(), false);
                    session.reaped = Some((parts.0, parts.1, now));
                }
                let Some((code, signal, reaped_at)) = session.reaped else {
                    continue;
                };
                let drained = session.stdout_done && session.stderr_done;
                let waited = now.saturating_duration_since(reaped_at) >= EXEC_OUTPUT_DRAIN;
                if drained || waited {
                    let cause = if session.timed_out {
                        EndCause::TimedOut
                    } else {
                        EndCause::Exited
                    };
                    Some(((code, signal), cause))
                } else {
                    None
                }
            };
            if let Some((parts, cause)) = action {
                frames.extend(self.complete(&id, parts, cause));
            }
        }
        frames
    }

    fn finish(&mut self, command_id: &str, cause: EndCause) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(command_id) else {
            return Vec::new();
        };
        if session.finished {
            return Vec::new();
        }
        session.stop.store(true, Ordering::SeqCst);
        kill_exec(session.pid, session.child.as_mut(), true);
        let status = reap_child(session.child.as_mut());
        let cause = if session.timed_out {
            EndCause::TimedOut
        } else {
            cause
        };
        self.complete(command_id, status, cause)
    }

    fn complete(
        &mut self,
        command_id: &str,
        status: (Option<i32>, Option<i32>),
        cause: EndCause,
    ) -> Vec<OutboundFrame> {
        let Some(mut session) = self.sessions.remove(command_id) else {
            return Vec::new();
        };
        self.save_table();
        // Completion/cancel/drain timeout can precede pipe EOF. Keep every
        // held masked tail; late worker bytes cannot reopen a stream.
        for stderr in [false, true] {
            let masked = if stderr {
                session.stderr_mask.finish()
            } else {
                session.stdout_mask.finish()
            };
            session.output.push(&masked);
        }
        session.finished = true;
        session.stop.store(true, Ordering::SeqCst);
        // Reader threads exit on their own. Joining them can block if a
        // grandchild that left the process group still holds a pipe.
        drop(session.stdout_thread.take());
        drop(session.stderr_thread.take());
        drop(session.child.take());
        let (state, exit_code) = match cause {
            EndCause::Cancelled => (ExecState::Cancelled, None),
            EndCause::TimedOut => (ExecState::TimedOut, None),
            EndCause::Interrupted => (ExecState::Interrupted, None),
            EndCause::Exited => match status {
                (Some(0), _) => (ExecState::Succeeded, Some(0)),
                (Some(code), _) => (ExecState::Failed, wire_exit_code(Some(code))),
                (None, _) => (ExecState::Failed, None),
            },
        };
        log_command_op("exec", command_id, &done_outcome(status.0, status.1, cause));
        let ended = ExecStatus {
            command_id: command_id.to_string(),
            state,
            exit_code,
            signal: signal_token(status.1),
            started_at: Some(session.started_at.clone()),
            ends_by: Some(session.ends_by.clone()),
            finished_at: Some(crate::telemetry::now_rfc3339()),
            tail: None,
            truncated: None,
            output_bytes: None,
        };
        let frame = with_tail(ended.clone(), &session.output, EXEC_END_TAIL_BYTES);
        self.ended.retain(|(id, _)| id != command_id);
        // A poll reads at most the last 64 KiB: keep only that much.
        let mut output = std::mem::take(&mut session.output);
        let excess = output
            .bytes
            .len()
            .saturating_sub(NODE_COMMAND_TAIL_MAX_BYTES);
        output.bytes.drain(..excess);
        self.ended.push_back((
            command_id.to_string(),
            EndedCommand {
                status: ended,
                output,
            },
        ));
        while self.ended.len() > EXEC_RECENT_MAX {
            self.ended.pop_front();
        }
        vec![OutboundFrame::Control(NodeFrame::ExecStatus(frame))]
    }

    #[cfg(test)]
    fn pid(&self, command_id: &str) -> Option<u32> {
        self.sessions.get(command_id).map(|session| session.pid)
    }
}

impl Drop for ExecRegistry {
    fn drop(&mut self) {
        let _ = self.kill_all();
    }
}

/// `status` with the output tail, shrunk until the frame fits one control
/// frame (escaping can grow text past its byte count).
fn with_tail(mut status: ExecStatus, output: &OutputRing, max: usize) -> ExecStatus {
    status.output_bytes = Some(output.total);
    let mut max = max.min(NODE_COMMAND_TAIL_MAX_BYTES);
    loop {
        let tail = output.tail(max);
        status.truncated = Some((tail.len() as u64) < output.total);
        status.tail = (!tail.is_empty()).then_some(tail);
        let fits = serde_json::to_string(&NodeFrame::ExecStatus(status.clone()))
            .is_ok_and(|text| text.len() <= crate::protocol::RELAY_JSON_CONTROL_MAX_BYTES);
        if fits || max == 0 {
            return status;
        }
        max /= 2;
    }
}

fn reap_child(child: Option<&mut ExecChild>) -> (Option<i32>, Option<i32>) {
    let Some(child) = child else {
        return (None, None);
    };
    for _ in 0..32 {
        if let Ok(Some(status)) = child.try_wait() {
            return status_parts(status);
        }
        std::thread::yield_now();
    }
    for _ in 0..20 {
        if let Ok(Some(status)) = child.try_wait() {
            return status_parts(status);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    (None, None)
}

fn kill_exec(pid: u32, child: Option<&mut ExecChild>, fallback_to_pid: bool) {
    #[cfg(unix)]
    {
        kill_process_group(pid, fallback_to_pid);
        let _ = child;
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, fallback_to_pid);
        if let Some(child) = child {
            let _ = child.job().terminate();
        }
    }
}

fn spawn_exec(
    tx: &SyncSender<FromWorker>,
    command_id: &str,
    command: &str,
    cwd: &Path,
    lifetime: Duration,
) -> anyhow::Result<ExecSession> {
    let (program, flag) = child_env::exec_shell();
    let mut process = std::process::Command::new(program);
    process
        .arg(flag)
        .arg(command)
        .current_dir(cwd)
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (name, value) in scrub_parent_env(&[]) {
        process.env(name, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    #[cfg(not(windows))]
    let mut child = process.spawn()?;
    #[cfg(windows)]
    let mut child = crate::job_tree::spawn(process)?;
    let pid = child.id();
    #[cfg(not(windows))]
    let tracked = LiveChildGuard::track(LiveChild::ExecGroup(pid));
    #[cfg(windows)]
    let tracked = LiveChildGuard::track(LiveChild::ExecJob(child.job()));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("exec stdout is missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("exec stderr is missing"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stdout_id = command_id.to_string();
    let stdout_eof = command_id.to_string();
    let stderr_id = command_id.to_string();
    let stderr_eof = command_id.to_string();
    let stdout_thread = pump_exec_reader(
        stdout,
        tx.clone(),
        Arc::clone(&stop),
        move |bytes| FromWorker::ExecBytes {
            command_id: stdout_id.clone(),
            stderr: false,
            bytes,
        },
        move || FromWorker::ExecEof {
            command_id: stdout_eof.clone(),
            stderr: false,
        },
    );
    let stderr_thread = pump_exec_reader(
        stderr,
        tx.clone(),
        Arc::clone(&stop),
        move |bytes| FromWorker::ExecBytes {
            command_id: stderr_id.clone(),
            stderr: true,
            bytes,
        },
        move || FromWorker::ExecEof {
            command_id: stderr_eof.clone(),
            stderr: true,
        },
    );
    let started = std::time::SystemTime::now();
    Ok(ExecSession {
        child: Some(child),
        stdout_thread: Some(stdout_thread),
        stderr_thread: Some(stderr_thread),
        stop,
        deadline: Instant::now() + lifetime,
        started_at: crate::telemetry::rfc3339(started),
        ends_by: crate::telemetry::rfc3339(started + lifetime),
        stdout_mask: StreamMasker::new(command),
        stderr_mask: StreamMasker::new(command),
        output: OutputRing::default(),
        stdout_done: false,
        stderr_done: false,
        timed_out: false,
        finished: false,
        pid,
        start_ticks: process_start_ticks(pid),
        reaped: None,
        _tracked: tracked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command lifetime longer than any test.
    const TEST_TIMEOUT_MS: u64 = 600_000;
    use crate::config::Config;
    use crate::terminal_crypto::CliTerminalKey;

    fn channel() -> (SyncSender<FromWorker>, mpsc::Receiver<FromWorker>) {
        mpsc::sync_channel(64)
    }

    fn enabled_startup(approval: bool) -> TerminalStartup {
        let config = Config {
            allow_human_terminal: true,
            trust: Some(crate::protocol::frames::TrustValue::Full),
            require_terminal_approval: approval,
            ..Config::default()
        };
        TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config)
    }

    fn slow_command() -> &'static str {
        if child_env::exec_shell().0 == "sh" {
            "sleep 30"
        } else {
            "ping -n 30 127.0.0.1"
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_exec_cancel_timeout_drop_and_forced_shutdown_kill_grandchildren() {
        use crate::windows_test_tree::{Tree, assert_dead};
        for action in ["cancel", "timeout", "drop", "forced", "root-exit"] {
            let tree = Tree::new();
            let (tx, rx) = channel();
            let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
            // Git Bash can make exec_shell choose sh; both shells and their
            // descendants must remain in the Windows job.
            let mode = if action == "root-exit" {
                "root-exit"
            } else {
                "detach"
            };
            // Exec needs one shell string for sh -c or cmd /C. The fixture
            // cwd lets both shells use relative paths without embedded quotes
            // or Windows backslash escaping, even when the cwd has spaces.
            let command = format!("python tree.py grandchild.pid root.pid {mode}");
            let frames = execs.start(
                &enabled_startup(false),
                "windows-tree",
                &command,
                Some(tree.cwd().to_str().expect("fixture cwd")),
                TEST_TIMEOUT_MS,
            );
            assert!(matches!(
                &frames[0],
                OutboundFrame::Control(NodeFrame::ExecStarted { .. })
            ));
            let grandchild = tree.read_marker().parse().expect("grandchild PID");
            let root = execs.pid("windows-tree").expect("exec root");
            match action {
                "cancel" => {
                    let _ = execs.cancel("windows-tree");
                }
                "timeout" => {
                    let _ = execs.poll(Instant::now() + Duration::from_secs(31));
                }
                "drop" => {
                    drop(execs);
                    assert_dead(grandchild);
                    drop(rx);
                    continue;
                }
                "forced" => kill_live_children(
                    |child| matches!(child, LiveChild::ExecJob(job) if job.id() == root),
                ),
                "root-exit" => {
                    let until = Instant::now() + Duration::from_secs(5);
                    while !execs.sessions.is_empty() && Instant::now() < until {
                        let _ = execs.poll(Instant::now());
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    assert!(execs.sessions.is_empty(), "exited exec kept its slot");
                }
                _ => unreachable!(),
            }
            assert_dead(grandchild);
            assert_dead(root);
            drop(execs);
            drop(rx);
        }
    }

    #[cfg(unix)]
    #[test]
    fn scrollback_keeps_the_newest_256_kib() {
        let mut buf = VecDeque::new();
        push_scrollback(&mut buf, &vec![1_u8; SCROLLBACK_LIMIT]);
        push_scrollback(&mut buf, &[2, 2, 2]);
        assert_eq!(buf.len(), SCROLLBACK_LIMIT);
        assert_eq!(buf.front().copied(), Some(1));
        assert_eq!(buf.back().copied(), Some(2));
        let drained = buf.iter().rev().take(3).copied().collect::<Vec<_>>();
        assert_eq!(drained, vec![2, 2, 2]);
    }

    #[test]
    fn unsupported_disabled_or_over_limit_terminals_are_rejected() {
        assert_eq!(
            terminal_block_reason(false, true, 0, 4),
            Some(REASON_UNSUPPORTED)
        );
        assert_eq!(
            terminal_block_reason(true, false, 0, 4),
            Some(REASON_DISABLED)
        );
        assert_eq!(terminal_block_reason(true, true, 4, 4), Some(REASON_LIMIT));
        assert_eq!(terminal_block_reason(true, true, 3, 4), None);
        assert_eq!(terminal_block_reason(true, true, 1, 1), Some(REASON_LIMIT));
        assert_eq!(terminal_block_reason(true, true, 31, 32), None);
        assert_eq!(terminal_supported(), cfg!(unix));
    }

    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuf {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Ok(mut inner) = self.0.lock() {
                inner.extend_from_slice(bytes);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = LogBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn command_ops_log_op_and_outcome_but_never_the_command_text() {
        let _capture = crate::logging::test_capture_lock();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let (tx, _rx) = channel();
            let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
            let startup = enabled_startup(false);
            // Refused: bad cwd, and the command carries a secret-looking token.
            let secret_cmd = "echo TOPSECRET_TOKEN_9f3a";
            let _ = execs.start(
                &startup,
                "ref1",
                secret_cmd,
                Some("relative"),
                TEST_TIMEOUT_MS,
            );
        });
        let log = String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default())
            .unwrap_or_default();
        assert!(
            log.contains("op=\"exec\"") || log.contains("op=exec"),
            "{log}"
        );
        assert!(log.contains("rejected:bad_cwd"), "{log}");
        assert!(log.contains("ref1"), "{log}");
        assert!(!log.contains("TOPSECRET_TOKEN_9f3a"), "{log}");
        assert!(!log.contains("relative"), "{log}");
    }

    #[test]
    fn a_started_exec_logs_started_and_never_the_command_or_cwd() {
        // The only `start` path the shared log test drives is a refusal; this
        // pins the `Ok` arm's "started" line, which used to go unasserted.
        let _capture = crate::logging::test_capture_lock();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        let cwd = tempfile::tempdir().expect("tempdir");
        let (pid, command, dir) = tracing::subscriber::with_default(subscriber, || {
            let (tx, rx) = channel();
            let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
            let command = slow_command();
            let dir = cwd.path().to_string_lossy().into_owned();
            let started = execs.start(
                &enabled_startup(false),
                "started1",
                command,
                Some(&dir),
                TEST_TIMEOUT_MS,
            );
            assert!(matches!(
                started[0],
                OutboundFrame::Control(NodeFrame::ExecStarted { .. })
            ));
            let pid = execs.pid("started1").expect("pid");
            drop(execs);
            drop(rx);
            (pid, command, dir)
        });
        let log = String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default())
            .unwrap_or_default();
        let ops = command_ops(&log);
        let started = ops
            .iter()
            .filter(|(_, id, outcome)| id == "started1" && outcome == "started")
            .collect::<Vec<_>>();
        assert_eq!(
            started.len(),
            1,
            "no single started line for the exec: {ops:?}"
        );
        assert!(!log.contains(command), "the command text leaked: {log}");
        assert!(!log.contains(&dir), "the cwd leaked: {log}");
        assert!(!process_exists(pid), "the started child was reaped");
    }

    #[test]
    fn exec_rejects_size_nul_cwd_and_the_concurrency_cap() {
        let (tx, _rx) = channel();
        let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
        let startup = enabled_startup(false);
        let rejected = execs.start(&startup, "one", &"a".repeat(4097), None, TEST_TIMEOUT_MS);
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
                if reason == REASON_BAD_COMMAND
        ));
        let rejected = execs.start(&startup, "two", "echo\0no", None, TEST_TIMEOUT_MS);
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
                if reason == REASON_BAD_COMMAND
        ));
        let rejected = execs.start(
            &startup,
            "three",
            "echo ok",
            Some("relative"),
            TEST_TIMEOUT_MS,
        );
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
                if reason == REASON_BAD_CWD
        ));
        assert!(execs.sessions.is_empty());

        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
        for index in 0..MAX_EXECS {
            assert!(matches!(
                execs.start(
                    &startup,
                    &format!("cmd-{index}"),
                    slow_command(),
                    None,
                    TEST_TIMEOUT_MS
                )[0],
                OutboundFrame::Control(NodeFrame::ExecStarted { .. })
            ));
        }
        let rejected = execs.start(&startup, "c", slow_command(), None, TEST_TIMEOUT_MS);
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
                if reason == REASON_LIMIT
        ));
        assert_eq!(execs.sessions.len(), MAX_EXECS);
        drop(execs);
        drop(rx);
    }

    /// A daemon that died left a command running: the next daemon ends its
    /// process group and reports it `interrupted`, once.
    #[cfg(target_os = "linux")]
    #[test]
    fn commands_a_restart_interrupted_are_killed_and_reported() {
        use std::os::unix::process::CommandExt;
        let dir = tempfile::tempdir().expect("dir");
        let table = dir.path().join("node-commands.json");
        let mut child = std::process::Command::new("sleep")
            .arg("300")
            .process_group(0)
            .spawn()
            .expect("sleep");
        let pid = child.id();
        let running = vec![RunningCommand {
            command_id: "left-1".into(),
            pid,
            start_ticks: process_start_ticks(pid),
            started_at: "2026-10-06T00:00:00Z".into(),
            ends_by: "2026-10-07T00:00:00Z".into(),
        }];
        std::fs::write(&table, serde_json::to_vec(&running).expect("json")).expect("table");
        let (tx, _rx) = channel();
        let (execs, frames) =
            ExecRegistry::new(tx, Duration::from_secs(30)).with_table(table.clone());
        assert_eq!(frames.len(), 1);
        let OutboundFrame::Control(NodeFrame::ExecStatus(status)) = &frames[0] else {
            panic!("exec.status");
        };
        assert_eq!(status.state, ExecState::Interrupted);
        assert!(status.validate().is_ok());
        // Polls keep answering it, and the table is now empty.
        let polled = execs.status("left-1", 0);
        assert!(matches!(
            &polled[0],
            OutboundFrame::Control(NodeFrame::ExecStatus(s)) if s.state == ExecState::Interrupted
        ));
        assert_eq!(std::fs::read_to_string(&table).expect("table"), "[]");
        let exited = child.wait().expect("reaped");
        assert!(!exited.success(), "the left command was killed");
        // A pid whose start time no longer matches is never signalled.
        let mut other = std::process::Command::new("sleep")
            .arg("300")
            .process_group(0)
            .spawn()
            .expect("sleep");
        let stale = vec![RunningCommand {
            command_id: "left-2".into(),
            pid: other.id(),
            start_ticks: Some(1),
            started_at: "2026-10-06T00:00:00Z".into(),
            ends_by: "2026-10-07T00:00:00Z".into(),
        }];
        std::fs::write(&table, serde_json::to_vec(&stale).expect("json")).expect("table");
        let (tx, _rx) = channel();
        let (_execs, frames) = ExecRegistry::new(tx, Duration::from_secs(30)).with_table(table);
        assert_eq!(frames.len(), 1);
        assert!(
            other.try_wait().expect("poll").is_none(),
            "an unrelated process survives"
        );
        let _ = other.kill();
        let _ = other.wait();
    }

    #[test]
    fn exec_timeout_uses_the_injected_duration() {
        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_millis(200));
        let startup = enabled_startup(false);
        execs.start(&startup, "slow", slow_command(), None, TEST_TIMEOUT_MS);
        std::thread::sleep(Duration::from_millis(350));
        let deadline = Instant::now() + Duration::from_secs(2);
        let frames = loop {
            while let Ok(message) = rx.try_recv() {
                match message {
                    FromWorker::ExecBytes {
                        command_id,
                        stderr,
                        bytes,
                    } => {
                        execs.on_bytes(&command_id, stderr, &bytes);
                    }
                    FromWorker::ExecEof { command_id, stderr } => {
                        execs.on_eof(&command_id, stderr);
                    }
                    _ => {}
                }
            }
            let frames = execs.poll(Instant::now());
            if !frames.is_empty() {
                break frames;
            }
            if Instant::now() > deadline {
                panic!("timed out command did not finish");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(NodeFrame::ExecStatus(status)) if status.state == ExecState::TimedOut
        ));
        drop(execs);
        drop(rx);
    }

    #[test]
    fn a_timed_out_exec_logs_the_timed_out_outcome() {
        // The frame's `timed_out` flag is asserted above; this pins the CLI
        // log's outcome code, which a dropped branch would quietly turn into
        // `ended`/`signaled` while the frame stayed correct.
        let _capture = crate::logging::test_capture_lock();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        let (tx, rx) = channel();
        tracing::subscriber::with_default(subscriber, || {
            let mut execs = ExecRegistry::new(tx, Duration::from_millis(200));
            execs.start(
                &enabled_startup(false),
                "slow",
                slow_command(),
                None,
                TEST_TIMEOUT_MS,
            );
            std::thread::sleep(Duration::from_millis(350));
            let deadline = Instant::now() + Duration::from_secs(5);
            while execs.poll(Instant::now()).is_empty() {
                while let Ok(message) = rx.try_recv() {
                    match message {
                        FromWorker::ExecBytes {
                            command_id,
                            stderr,
                            bytes,
                        } => {
                            execs.on_bytes(&command_id, stderr, &bytes);
                        }
                        FromWorker::ExecEof { command_id, stderr } => {
                            execs.on_eof(&command_id, stderr);
                        }
                        _ => {}
                    }
                }
                assert!(Instant::now() < deadline, "the exec never timed out");
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        drop(rx);
        let log = String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default())
            .unwrap_or_default();
        let outcomes = command_ops(&log)
            .into_iter()
            .filter(|(_, id, _)| id == "slow")
            .map(|(_, _, outcome)| outcome)
            .collect::<Vec<_>>();
        assert!(
            outcomes.contains(&"timed_out".to_string()),
            "no timed_out outcome line for a timed-out exec: {outcomes:?}\nlog:\n{log}"
        );
    }

    #[test]
    fn dropping_the_exec_registry_reaps_the_child() {
        let (tx, rx) = channel();
        let pid = {
            let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
            execs.start(
                &enabled_startup(false),
                "sleep",
                slow_command(),
                None,
                TEST_TIMEOUT_MS,
            );
            let pid = execs.pid("sleep").expect("pid");
            drop(execs);
            pid
        };
        assert!(!process_exists(pid), "child was not reaped");
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn killing_an_exec_kills_its_process_group() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("grand.pid");
        let command = format!("sleep 120 & echo $! > '{}'; wait", pidfile.display());
        assert!(
            !pidfile.display().to_string().contains('\''),
            "temp path is unsafe to inline in a shell command"
        );
        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
        execs.start(
            &enabled_startup(false),
            "group",
            &command,
            Some(dir.path().to_str().expect("utf8")),
            TEST_TIMEOUT_MS,
        );
        let shell_pid = execs.pid("group").expect("shell");
        let deadline = Instant::now() + Duration::from_secs(2);
        let grand = loop {
            if let Ok(text) = std::fs::read_to_string(&pidfile)
                && let Ok(pid) = text.trim().parse::<u32>()
                && pid > 1
            {
                break pid;
            }
            if Instant::now() > deadline {
                panic!("grandchild pid was not written");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let _ = execs.cancel("group");
        // The grandchild is not our child. Init reaps the zombie after SIGKILL.
        let deadline = Instant::now() + Duration::from_secs(1);
        while process_exists(grand) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let grand_stat = std::fs::read_to_string(format!("/proc/{grand}/stat")).unwrap_or_default();
        assert!(
            !process_exists(grand),
            "grandchild still exists stat={grand_stat}"
        );
        assert!(!process_exists(shell_pid), "shell was not reaped");
        drop(execs);
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn pty_spawn_reads_output_and_close_reaps_it() {
        let (tx, rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(15 * 60),
            "/bin/sh",
            &["-c", "printf wsmp-pty-ok"],
        );
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
        let frames = terminals.open(
            &startup,
            None,
            TermHandshake {
                terminal_id: "term-1",
                viewer_id: Some("viewer-a"),
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(NodeFrame::TermOpened { .. })
        ));
        let deadline = Instant::now() + Duration::from_secs(3);
        let expected = b"wsmp-pty-ok";
        let mut output = Vec::new();
        while Instant::now() < deadline
            && !output
                .windows(expected.len())
                .any(|window| window == expected)
        {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(FromWorker::TerminalBytes { bytes, .. }) => output.extend(bytes),
                Ok(FromWorker::TerminalEof { .. }) => break,
                _ => {}
            }
        }
        assert!(
            output
                .windows(expected.len())
                .any(|window| window == expected),
            "pty did not emit the expected output: {output:?}"
        );
        let _ = terminals.close("term-1");
        drop(terminals);
        drop(rx);
    }

    /// Opens browser terminals until one is refused; returns how many opened.
    #[cfg(unix)]
    fn open_until_refused(startup: &TerminalStartup) -> usize {
        let (tx, rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "sleep 30"],
        );
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[1_u8; 16]);
        let mut opened = 0;
        loop {
            let terminal_id = format!("t{opened}");
            let frames = terminals.open(
                startup,
                None,
                TermHandshake {
                    terminal_id: &terminal_id,
                    viewer_id: Some("viewer-a"),
                    cols: 80,
                    rows: 24,
                    browser_public_key: browser.public_b64url(),
                    browser_nonce: &nonce,
                    identity: None,
                },
            );
            match &frames[0] {
                OutboundFrame::Control(NodeFrame::TermOpened { .. }) => opened += 1,
                OutboundFrame::Control(NodeFrame::TermRejected { reason, .. }) => {
                    assert_eq!(reason, REASON_LIMIT);
                    break;
                }
                _ => panic!("unexpected reply to term.open"),
            }
            assert!(opened <= 32, "no terminal limit applied");
        }
        drop(terminals);
        drop(rx);
        opened
    }

    #[cfg(unix)]
    #[test]
    fn terminal_concurrency_cap_is_four_by_default_and_configurable() {
        assert_eq!(open_until_refused(&enabled_startup(false)), 4);
        let config = Config {
            allow_human_terminal: true,
            trust: Some(crate::protocol::frames::TrustValue::Full),
            max_terminals: Some(1),
            ..Config::default()
        };
        let startup = TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config);
        assert_eq!(open_until_refused(&startup), 1);
    }

    #[cfg(unix)]
    #[test]
    fn detached_terminal_closes_after_the_injected_idle_timeout() {
        let (tx, _rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "sleep 30"],
        );
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[3_u8; 16]);
        terminals.open(
            &startup,
            None,
            TermHandshake {
                terminal_id: "idle",
                viewer_id: Some("viewer-a"),
                cols: 40,
                rows: 12,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        terminals.detach("idle", Some("viewer-a"));
        // The poll clock is passed in, so no real waiting is needed.
        let frames = terminals.poll(Instant::now() + Duration::from_secs(120));
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(NodeFrame::TermExit { terminal_id, .. })
                if terminal_id == "idle"
        ));
        assert!(!terminals.sessions.contains_key("idle"));
    }

    #[test]
    fn approval_signature_includes_the_cli_nonce() {
        let dir = tempfile::tempdir().expect("tempdir");
        let browser = CliTerminalKey::generate().expect("browser");
        use p256::elliptic_curve::Generate;
        let identity = p256::ecdsa::SigningKey::try_generate().expect("identity");
        let identity_raw = {
            let encoded = identity.verifying_key().to_sec1_point(false);
            let mut raw = [0_u8; 65];
            raw.copy_from_slice(encoded.as_bytes());
            raw
        };
        let identity_message = TerminalIdentity {
            public_key: terminal_crypto::encode_b64url(&identity_raw),
            signature: None,
        };
        assert!(identity_public(None).is_err());
        assert_eq!(
            identity_public(Some(&identity_message)).expect("raw"),
            identity_raw
        );
        let code = approval_code_for_identity(Some(dir.path()), &identity_raw).expect("code");
        assert_eq!(code, terminal_crypto::approval_code(&identity_raw));
        let cli = CliTerminalKey::generate().expect("cli");
        let browser_nonce = [4_u8; 16];
        let cli_nonce = [5_u8; 16];
        let signature = terminal_crypto::sign_approval(
            &identity,
            "term-a",
            browser.public_raw(),
            &browser_nonce,
            cli.public_raw(),
            &cli_nonce,
        )
        .expect("sign");
        let encoded = terminal_crypto::encode_b64url(&signature);
        assert!(!approval_signature_ok(
            &identity_raw,
            &encoded,
            "term-a",
            None,
            browser.public_raw(),
            &browser_nonce,
            cli.public_raw(),
            &[6_u8; 16],
        ));
        crate::approvals::approve(dir.path(), &code).expect("approve");
        assert!(approval_code_for_identity(Some(dir.path()), &identity_raw).is_none());
        assert!(approval_signature_ok(
            &identity_raw,
            &encoded,
            "term-a",
            None,
            browser.public_raw(),
            &browser_nonce,
            cli.public_raw(),
            &cli_nonce,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn approval_does_not_spawn_until_the_cli_nonce_is_signed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (tx, rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "sleep 30"],
        );
        let startup = enabled_startup(true);
        let browser = CliTerminalKey::generate().expect("browser");
        use p256::elliptic_curve::Generate;
        let identity = p256::ecdsa::SigningKey::try_generate().expect("identity");
        let identity_raw = {
            let encoded = identity.verifying_key().to_sec1_point(false);
            let mut raw = [0_u8; 65];
            raw.copy_from_slice(encoded.as_bytes());
            raw
        };
        let identity_message = TerminalIdentity {
            public_key: terminal_crypto::encode_b64url(&identity_raw),
            signature: None,
        };
        let nonce = terminal_crypto::encode_b64url(&[4_u8; 16]);
        let frames = terminals.open(
            &startup,
            Some(dir.path()),
            TermHandshake {
                terminal_id: "term-a",
                viewer_id: Some("viewer-a"),
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: Some(&identity_message),
            },
        );
        let (cli_nonce, code) = match &frames[0] {
            OutboundFrame::Control(NodeFrame::TermPending {
                cli_nonce,
                approval_code,
                ..
            }) => (cli_nonce.clone(), approval_code.clone().expect("code")),
            _ => panic!("expected a pending terminal handshake"),
        };
        assert!(terminals.sessions.is_empty());
        assert_eq!(terminals.pending.len(), 1);
        crate::approvals::approve(dir.path(), &code).expect("approve");
        let cli_nonce_raw = terminal_crypto::decode_nonce(&cli_nonce).expect("nonce");
        let signature = terminal_crypto::sign_approval_v2(
            &identity,
            "term-a",
            "viewer-a",
            browser.public_raw(),
            &[4_u8; 16],
            startup.key().public_raw(),
            &cli_nonce_raw,
        )
        .expect("sign");
        let opened = terminals.auth(
            &startup,
            Some(dir.path()),
            "term-a",
            Some("viewer-a"),
            &terminal_crypto::encode_b64url(&signature),
        );
        assert!(matches!(
            &opened[0],
            OutboundFrame::Control(NodeFrame::TermOpened { cli_nonce: opened_nonce, .. })
                if opened_nonce == &cli_nonce
        ));
        assert!(terminals.pending.is_empty());
        assert!(terminals.sessions.contains_key("term-a"));
        drop(terminals);
        drop(rx);
    }

    #[test]
    fn closed_pipes_do_not_wait_for_a_running_command() {
        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
        let command = if cfg!(unix) {
            "exec sleep 30 >/dev/null 2>&1"
        } else {
            slow_command()
        };
        execs.start(
            &enabled_startup(false),
            "sleep",
            command,
            None,
            TEST_TIMEOUT_MS,
        );
        let pid = execs.pid("sleep").expect("pid");
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut stdout_done = false;
        let mut stderr_done = false;
        while Instant::now() < deadline && !(stdout_done && stderr_done) {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(FromWorker::ExecEof { stderr, .. }) => {
                    let started = Instant::now();
                    execs.on_eof("sleep", stderr);
                    assert!(
                        started.elapsed() < Duration::from_millis(500),
                        "eof handling blocked"
                    );
                    if stderr {
                        stderr_done = true;
                    } else {
                        stdout_done = true;
                    }
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if cfg!(unix) {
            assert!(stdout_done && stderr_done, "pipes did not close");
            let started = Instant::now();
            let frames = execs.poll(Instant::now());
            assert!(started.elapsed() < Duration::from_millis(500));
            assert!(
                frames.is_empty(),
                "closed pipes must not finish the command"
            );
            assert!(
                process_exists(pid),
                "process was killed when its pipes closed"
            );
        }
        drop(execs);
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn a_finished_command_kills_grandchildren_in_its_process_group() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("grand.pid");
        let command = format!("sleep 120 & echo $! > '{}'; exit", pidfile.display());
        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
        execs.start(
            &enabled_startup(false),
            "group",
            &command,
            Some(dir.path().to_str().expect("utf8")),
            TEST_TIMEOUT_MS,
        );
        let shell_pid = execs.pid("group").expect("shell");
        let deadline = Instant::now() + Duration::from_secs(2);
        let grand = loop {
            if let Ok(text) = std::fs::read_to_string(&pidfile)
                && let Ok(pid) = text.trim().parse::<u32>()
                && pid > 1
            {
                break pid;
            }
            if Instant::now() > deadline {
                panic!("grandchild pid was not written");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let _ = rx.try_recv();
            let frames = execs.poll(Instant::now());
            if frames
                .iter()
                .any(|frame| matches!(frame, OutboundFrame::Control(NodeFrame::ExecStatus(_))))
            {
                break;
            }
            if Instant::now() > deadline {
                panic!("command did not finish");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        while process_exists(grand) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!process_exists(grand), "grandchild still exists");
        assert!(!process_exists(shell_pid), "shell was not reaped");
        drop(execs);
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn pty_close_returns_while_the_slave_is_held() {
        let (tx, rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "sleep 120"],
        );
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
        terminals.open(
            &startup,
            None,
            TermHandshake {
                terminal_id: "held",
                viewer_id: Some("viewer-a"),
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        let frames = terminals.close("held");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "close blocked for {:?}",
            started.elapsed()
        );
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(NodeFrame::TermExit { .. })
        ));
        drop(terminals);
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn reader_stop_does_not_require_the_fd_to_close() {
        let (reader, _writer) = std::os::unix::net::UnixStream::pair().expect("socket pair");
        reader.set_nonblocking(false).expect("blocking");
        let (tx, _rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel();
        let stop_flag = Arc::clone(&stop);
        let handle = pump_polled(
            reader,
            tx,
            Arc::clone(&stop),
            |_| FromWorker::TerminalBytes {
                terminal_id: "t".to_string(),
                bytes: Vec::new(),
            },
            || FromWorker::TerminalEof {
                terminal_id: "t".to_string(),
            },
        );
        std::thread::spawn(move || {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = handle.join();
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reader did not notice the stop flag");
    }

    // Protocol 2.5 (multi-viewer) tests. `TestViewer` plays one browser tab.

    #[cfg(unix)]
    const MULTI_TERMINAL: &str = "term-multi";

    #[cfg(unix)]
    #[derive(Debug, PartialEq)]
    enum Seen {
        Key(u32),
        Size(u16, u16),
        Data(Vec<u8>),
        Opaque,
    }

    #[cfg(unix)]
    struct TestViewer {
        id: String,
        browser: CliTerminalKey,
        nonce: [u8; 16],
        nonce_b64: String,
        keys: Option<DirectionKeys>,
        tx_seq: u64,
        out: Option<(u32, [u8; 32])>,
    }

    #[cfg(unix)]
    impl TestViewer {
        fn new(tag: u8) -> Self {
            let nonce = [tag; 16];
            Self {
                id: terminal_crypto::encode_b64url(&[tag.wrapping_add(100); 16]),
                browser: CliTerminalKey::generate().expect("browser"),
                nonce,
                nonce_b64: terminal_crypto::encode_b64url(&nonce),
                keys: None,
                tx_seq: 0,
                out: None,
            }
        }

        fn handshake<'a>(
            &'a self,
            terminal_id: &'a str,
            cols: u16,
            rows: u16,
        ) -> TermHandshake<'a> {
            TermHandshake {
                terminal_id,
                viewer_id: Some(&self.id),
                cols,
                rows,
                browser_public_key: self.browser.public_b64url(),
                browser_nonce: &self.nonce_b64,
                identity: None,
            }
        }

        fn bind(&mut self, startup: &TerminalStartup, terminal_id: &str, cli_nonce: &str) {
            let ikm = self
                .browser
                .shared_x(startup.key().public_raw())
                .expect("ecdh");
            let cli_nonce = terminal_crypto::decode_nonce(cli_nonce).expect("nonce");
            self.keys = Some(
                terminal_crypto::derive_direction_keys_v2_from_ikm(
                    &ikm,
                    startup.key().public_raw(),
                    self.browser.public_raw(),
                    &self.nonce,
                    &cli_nonce,
                    terminal_id,
                    &self.id,
                )
                .expect("keys"),
            );
        }

        fn seal(&mut self, terminal_id: &str, message: &TermPlaintextV2) -> (u64, Vec<u8>) {
            let plaintext = terminal_crypto::encode_plaintext_v2(message).expect("encode");
            self.seal_bytes(terminal_id, &plaintext)
        }

        /// Seal raw plaintext bytes, including tags the codec cannot encode.
        fn seal_bytes(&mut self, terminal_id: &str, plaintext: &[u8]) -> (u64, Vec<u8>) {
            self.tx_seq += 1;
            let keys = self.keys.as_ref().expect("bound");
            let body = terminal_crypto::seal_v2(
                &keys.browser_to_cli,
                terminal_id,
                &self.id,
                DIR_BROWSER_TO_CLI,
                self.tx_seq,
                plaintext,
            )
            .expect("seal");
            (self.tx_seq, body)
        }

        /// Decode the frames the relay would deliver to this tab: unicast
        /// frames addressed to it, and every broadcast frame.
        fn receive(&mut self, terminal_id: &str, frames: &[OutboundFrame]) -> Vec<Seen> {
            let mut seen = Vec::new();
            for frame in frames {
                let OutboundFrame::Binary(
                    NodeBinaryMetadata::TermSealed {
                        seq,
                        viewer_id,
                        epoch,
                        ..
                    },
                    body,
                ) = frame
                else {
                    continue;
                };
                let plaintext = match (viewer_id, epoch) {
                    (Some(viewer_id), None) => {
                        if viewer_id != &self.id {
                            continue;
                        }
                        let keys = self.keys.as_ref().expect("bound");
                        terminal_crypto::open_v2(
                            &keys.cli_to_browser,
                            terminal_id,
                            viewer_id,
                            DIR_CLI_TO_BROWSER,
                            *seq,
                            body,
                        )
                        .ok()
                    }
                    (None, Some(epoch)) => self.out.and_then(|(known, key)| {
                        (known == *epoch)
                            .then(|| {
                                terminal_crypto::open_broadcast(
                                    &key,
                                    terminal_id,
                                    *epoch,
                                    *seq,
                                    body,
                                )
                                .ok()
                            })
                            .flatten()
                    }),
                    _ => panic!("a 2.5 sealed frame carries exactly one of viewerId or epoch"),
                };
                let Some(plaintext) = plaintext else {
                    seen.push(Seen::Opaque);
                    continue;
                };
                seen.push(
                    match terminal_crypto::decode_plaintext_v2(&plaintext).expect("plaintext") {
                        TermPlaintextV2::OutputKey { epoch, key } => {
                            self.out = Some((epoch, key));
                            Seen::Key(epoch)
                        }
                        TermPlaintextV2::Resize { cols, rows } => Seen::Size(cols, rows),
                        TermPlaintextV2::Data(bytes) => Seen::Data(bytes),
                    },
                );
            }
            seen
        }
    }

    #[cfg(unix)]
    fn multi_registry(tx: SyncSender<FromWorker>) -> TerminalRegistry {
        TerminalRegistry::with_shell(tx, Duration::from_secs(60), "/bin/sh", &["-c", "sleep 30"])
    }

    #[cfg(unix)]
    fn cli_nonce_of(frames: &[OutboundFrame]) -> String {
        frames
            .iter()
            .find_map(|frame| match frame {
                OutboundFrame::Control(
                    NodeFrame::TermOpened { cli_nonce, .. }
                    | NodeFrame::TermAttached { cli_nonce, .. }
                    | NodeFrame::TermPending { cli_nonce, .. },
                ) => Some(cli_nonce.clone()),
                _ => None,
            })
            .expect("a handshake reply")
    }

    #[cfg(unix)]
    fn controls(frames: &[OutboundFrame]) -> Vec<&NodeFrame> {
        frames
            .iter()
            .filter_map(|frame| match frame {
                OutboundFrame::Control(message) => Some(message),
                OutboundFrame::Binary(..) => None,
            })
            .collect()
    }

    #[cfg(unix)]
    fn writer_changes(frames: &[OutboundFrame]) -> Vec<Option<String>> {
        controls(frames)
            .into_iter()
            .filter_map(|message| match message {
                NodeFrame::TermWriter { viewer_id, .. } => Some(viewer_id.clone()),
                _ => None,
            })
            .collect()
    }

    #[cfg(unix)]
    fn rejection(frames: &[OutboundFrame]) -> Option<(Option<String>, String)> {
        controls(frames)
            .into_iter()
            .find_map(|message| match message {
                NodeFrame::TermRejected {
                    viewer_id, reason, ..
                } => Some((viewer_id.clone(), reason.clone())),
                _ => None,
            })
    }

    #[cfg(unix)]
    fn open_viewer(
        terminals: &mut TerminalRegistry,
        startup: &TerminalStartup,
        viewer: &mut TestViewer,
    ) -> Vec<OutboundFrame> {
        let frames = terminals.open(startup, None, viewer.handshake(MULTI_TERMINAL, 80, 24));
        viewer.bind(startup, MULTI_TERMINAL, &cli_nonce_of(&frames));
        frames
    }

    #[cfg(unix)]
    fn attach_viewer(
        terminals: &mut TerminalRegistry,
        startup: &TerminalStartup,
        viewer: &mut TestViewer,
    ) -> Vec<OutboundFrame> {
        let frames = terminals.attach(startup, None, viewer.handshake(MULTI_TERMINAL, 0, 0));
        viewer.bind(startup, MULTI_TERMINAL, &cli_nonce_of(&frames));
        frames
    }

    #[cfg(unix)]
    fn send(
        terminals: &mut TerminalRegistry,
        viewer: &mut TestViewer,
        label: &str,
        message: &TermPlaintextV2,
    ) -> Vec<OutboundFrame> {
        let (seq, body) = viewer.seal(MULTI_TERMINAL, message);
        terminals.handle_sealed(MULTI_TERMINAL, Some(label), seq, &body)
    }

    #[cfg(unix)]
    fn pty_size(terminals: &TerminalRegistry) -> (u16, u16) {
        let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
        let size = session
            .pty
            .as_ref()
            .expect("pty")
            .master
            .get_size()
            .expect("size");
        assert_eq!(session.pty_size, (size.cols, size.rows));
        (size.cols, size.rows)
    }

    #[cfg(unix)]
    fn writer(terminals: &TerminalRegistry) -> Option<String> {
        terminals
            .sessions
            .get(MULTI_TERMINAL)
            .expect("session")
            .writer
            .clone()
    }

    #[cfg(unix)]
    #[test]
    fn opener_gets_the_key_and_size_and_is_the_first_writer() {
        let (tx, _rx) = channel();
        let mut terminals = multi_registry(tx);
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        let frames = open_viewer(&mut terminals, &startup, &mut a);
        assert!(matches!(
            controls(&frames)[0],
            NodeFrame::TermOpened { viewer_id: Some(id), .. } if id == &a.id
        ));
        assert_eq!(
            a.receive(MULTI_TERMINAL, &frames),
            vec![Seen::Key(1), Seen::Size(80, 24)]
        );
        assert_eq!(writer_changes(&frames), vec![Some(a.id.clone())]);
        assert_eq!(writer(&terminals), Some(a.id.clone()));
    }

    #[cfg(unix)]
    #[test]
    fn retired_review_and_unknown_tags_drop_only_the_sender() {
        let (tx, _rx) = channel();
        let mut terminals = multi_registry(tx);
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        open_viewer(&mut terminals, &startup, &mut a);
        // A 0.3 review toggle, capture and state, then a tag never assigned.
        let retired_capture = [0x05, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
        for (tag, plaintext) in [
            (11, &[0x04, 1][..]),
            (12, &retired_capture[..]),
            (13, &[0x06, 0][..]),
            (14, &[0x07, 1][..]),
        ] {
            let mut sender = TestViewer::new(tag);
            attach_viewer(&mut terminals, &startup, &mut sender);
            let (seq, body) = sender.seal_bytes(MULTI_TERMINAL, plaintext);
            let sender_id = sender.id.clone();
            let frames = terminals.handle_sealed(MULTI_TERMINAL, Some(&sender_id), seq, &body);
            assert_eq!(
                rejection(&frames),
                Some((Some(sender_id), REASON_BAD_FRAME.to_string())),
                "{plaintext:?}"
            );
            let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
            assert_eq!(
                session.viewers.keys().cloned().collect::<Vec<_>>(),
                vec![a.id.clone()],
                "{plaintext:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn two_viewers_decrypt_the_same_broadcast() {
        let (tx, _rx) = channel();
        let mut terminals = multi_registry(tx);
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        let mut b = TestViewer::new(2);
        let opened = open_viewer(&mut terminals, &startup, &mut a);
        a.receive(MULTI_TERMINAL, &opened);
        // Output before B joins is scrollback for B.
        let early = terminals.on_bytes(MULTI_TERMINAL, b"early");
        assert_eq!(
            a.receive(MULTI_TERMINAL, &early),
            vec![Seen::Data(b"early".to_vec())]
        );

        let attached = attach_viewer(&mut terminals, &startup, &mut b);
        assert!(matches!(
            controls(&attached)[0],
            NodeFrame::TermAttached { viewer_id: Some(id), .. } if id == &b.id
        ));
        // Join order: key, PTY size, scrollback. The epoch does not change,
        // and nothing in the join is visible to A.
        assert_eq!(
            b.receive(MULTI_TERMINAL, &attached),
            vec![
                Seen::Key(1),
                Seen::Size(80, 24),
                Seen::Data(b"early".to_vec())
            ]
        );
        assert!(a.receive(MULTI_TERMINAL, &attached).is_empty());
        assert!(writer_changes(&attached).is_empty());

        let live = terminals.on_bytes(MULTI_TERMINAL, b"hello");
        assert_eq!(live.len(), 1, "live output is sealed once");
        assert_eq!(
            a.receive(MULTI_TERMINAL, &live),
            vec![Seen::Data(b"hello".to_vec())]
        );
        assert_eq!(
            b.receive(MULTI_TERMINAL, &live),
            vec![Seen::Data(b"hello".to_vec())]
        );
    }

    #[cfg(unix)]
    #[test]
    fn input_from_b_makes_b_the_writer_and_applies_b_size_first() {
        let (tx, _rx) = channel();
        let mut terminals = multi_registry(tx);
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        let mut b = TestViewer::new(2);
        let opened = open_viewer(&mut terminals, &startup, &mut a);
        a.receive(MULTI_TERMINAL, &opened);
        let attached = attach_viewer(&mut terminals, &startup, &mut b);
        b.receive(MULTI_TERMINAL, &attached);
        assert_eq!(pty_size(&terminals), (80, 24));

        // A resize from a non-writer is only recorded.
        let b_id = b.id.clone();
        let frames = send(
            &mut terminals,
            &mut b,
            &b_id,
            &TermPlaintextV2::Resize {
                cols: 100,
                rows: 40,
            },
        );
        assert!(frames.is_empty());
        assert_eq!(pty_size(&terminals), (80, 24));
        assert_eq!(writer(&terminals), Some(a.id.clone()));

        // B types: B becomes the writer, then B's size is applied and
        // broadcast, before the write.
        let frames = send(
            &mut terminals,
            &mut b,
            &b_id,
            &TermPlaintextV2::Data(b"x".to_vec()),
        );
        assert_eq!(writer_changes(&frames), vec![Some(b.id.clone())]);
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(NodeFrame::TermWriter { .. })
        ));
        assert_eq!(
            a.receive(MULTI_TERMINAL, &frames),
            vec![Seen::Size(100, 40)]
        );
        assert_eq!(
            b.receive(MULTI_TERMINAL, &frames),
            vec![Seen::Size(100, 40)]
        );
        assert_eq!(pty_size(&terminals), (100, 40));
        assert_eq!(writer(&terminals), Some(b.id.clone()));

        // The writer's own resize applies at once.
        let frames = send(
            &mut terminals,
            &mut b,
            &b_id,
            &TermPlaintextV2::Resize {
                cols: 120,
                rows: 50,
            },
        );
        assert_eq!(
            a.receive(MULTI_TERMINAL, &frames),
            vec![Seen::Size(120, 50)]
        );
        assert_eq!(pty_size(&terminals), (120, 50));

        // A types again: A's opening size comes back.
        let a_id = a.id.clone();
        let frames = send(
            &mut terminals,
            &mut a,
            &a_id,
            &TermPlaintextV2::Data(b"y".to_vec()),
        );
        assert_eq!(writer_changes(&frames), vec![Some(a.id.clone())]);
        assert_eq!(b.receive(MULTI_TERMINAL, &frames), vec![Seen::Size(80, 24)]);
        assert_eq!(pty_size(&terminals), (80, 24));

        // Typing again as the writer changes nothing.
        let frames = send(
            &mut terminals,
            &mut a,
            &a_id,
            &TermPlaintextV2::Data(b"z".to_vec()),
        );
        assert!(frames.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_frame_from_a_labelled_b_is_ignored() {
        let (tx, _rx) = channel();
        let mut terminals = multi_registry(tx);
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        let mut b = TestViewer::new(2);
        open_viewer(&mut terminals, &startup, &mut a);
        attach_viewer(&mut terminals, &startup, &mut b);
        let b_id = b.id.clone();

        // A's frame, stamped with B's viewer id by a hostile relay.
        let frames = send(
            &mut terminals,
            &mut a,
            &b_id,
            &TermPlaintextV2::Data(b"forged".to_vec()),
        );
        assert!(frames.is_empty());
        assert_eq!(writer(&terminals), Some(a.id.clone()));
        // Unknown viewer ids are ignored too.
        let frames = send(
            &mut terminals,
            &mut a,
            "no-such-viewer",
            &TermPlaintextV2::Data(b"x".to_vec()),
        );
        assert!(frames.is_empty());
        assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
        // 2.5 frames without a viewer id are dropped.
        let (seq, body) = a.seal(MULTI_TERMINAL, &TermPlaintextV2::Data(b"x".to_vec()));
        assert!(
            terminals
                .handle_sealed(MULTI_TERMINAL, None, seq, &body)
                .is_empty()
        );
        assert_eq!(writer(&terminals), Some(a.id.clone()));

        // B's replay cursor did not move: B's own first frame still counts.
        let frames = send(
            &mut terminals,
            &mut b,
            &b_id,
            &TermPlaintextV2::Data(b"real".to_vec()),
        );
        assert_eq!(writer_changes(&frames), vec![Some(b.id.clone())]);
        assert_eq!(writer(&terminals), Some(b.id.clone()));
    }

    #[cfg(unix)]
    #[test]
    fn a_leave_rotates_the_epoch_and_the_leaver_cannot_open_new_frames() {
        let (tx, _rx) = channel();
        let mut terminals = multi_registry(tx);
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        let mut b = TestViewer::new(2);
        let mut c = TestViewer::new(3);
        let opened = open_viewer(&mut terminals, &startup, &mut a);
        a.receive(MULTI_TERMINAL, &opened);
        let attached = attach_viewer(&mut terminals, &startup, &mut b);
        b.receive(MULTI_TERMINAL, &attached);
        let attached = attach_viewer(&mut terminals, &startup, &mut c);
        c.receive(MULTI_TERMINAL, &attached);
        let (_, b_old_key) = b.out.expect("b key");

        // B takes the writer, then stops viewing.
        let b_id = b.id.clone();
        send(
            &mut terminals,
            &mut b,
            &b_id,
            &TermPlaintextV2::Data(b"b".to_vec()),
        );
        let frames = terminals.detach(MULTI_TERMINAL, Some(&b_id));
        assert_eq!(writer_changes(&frames), vec![None]);
        assert_eq!(writer(&terminals), None);
        assert!(rejection(&frames).is_none(), "a detach is not a rejection");
        assert_eq!(a.receive(MULTI_TERMINAL, &frames), vec![Seen::Key(2)]);
        assert_eq!(c.receive(MULTI_TERMINAL, &frames), vec![Seen::Key(2)]);
        assert!(b.receive(MULTI_TERMINAL, &frames).is_empty());
        assert_ne!(a.out.expect("a key").1, b_old_key);
        assert_eq!(a.out, c.out);

        let live = terminals.on_bytes(MULTI_TERMINAL, b"after");
        assert_eq!(
            a.receive(MULTI_TERMINAL, &live),
            vec![Seen::Data(b"after".to_vec())]
        );
        assert_eq!(
            c.receive(MULTI_TERMINAL, &live),
            vec![Seen::Data(b"after".to_vec())]
        );
        let OutboundFrame::Binary(
            NodeBinaryMetadata::TermSealed {
                seq,
                epoch: Some(epoch),
                ..
            },
            body,
        ) = &live[0]
        else {
            panic!("expected a broadcast frame");
        };
        assert_eq!((*epoch, *seq), (2, 1), "a new epoch restarts seq at 1");
        for try_epoch in [1, 2] {
            assert!(
                terminal_crypto::open_broadcast(&b_old_key, MULTI_TERMINAL, try_epoch, *seq, body)
                    .is_err()
            );
        }
        assert_eq!(b.receive(MULTI_TERMINAL, &live), vec![Seen::Opaque]);
        // The leaver's input is no longer accepted.
        let frames = send(
            &mut terminals,
            &mut b,
            &b_id,
            &TermPlaintextV2::Data(b"late".to_vec()),
        );
        assert!(frames.is_empty());
        // With no writer, any viewer's resize applies.
        let c_id = c.id.clone();
        let frames = send(
            &mut terminals,
            &mut c,
            &c_id,
            &TermPlaintextV2::Resize { cols: 70, rows: 20 },
        );
        assert_eq!(a.receive(MULTI_TERMINAL, &frames), vec![Seen::Size(70, 20)]);
        assert_eq!(pty_size(&terminals), (70, 20));
        assert_eq!(writer(&terminals), None, "a resize never claims the writer");

        // A per-viewer fault removes only C, and rotates again.
        let frames = send(
            &mut terminals,
            &mut c,
            &c_id,
            &TermPlaintextV2::OutputKey {
                epoch: 9,
                key: [0_u8; 32],
            },
        );
        assert_eq!(
            rejection(&frames),
            Some((Some(c.id.clone()), REASON_BAD_FRAME.to_string()))
        );
        assert_eq!(a.receive(MULTI_TERMINAL, &frames), vec![Seen::Key(3)]);
        assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
        let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
        assert_eq!(
            session.viewers.keys().cloned().collect::<Vec<_>>(),
            vec![a.id.clone()]
        );

        // A malformed relay frame naming A removes A as well.
        let a_id = a.id.clone();
        let frames = terminals.drop_viewer(MULTI_TERMINAL, &a_id);
        assert_eq!(
            rejection(&frames),
            Some((Some(a.id.clone()), REASON_BAD_FRAME.to_string()))
        );
        let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
        assert!(session.viewers.is_empty());
        assert!(session.detached_at.is_some());
        // With no viewers, output is only recorded.
        assert!(terminals.on_bytes(MULTI_TERMINAL, b"quiet").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn viewer_cap_duplicates_and_idle_close() {
        const IDLE_LIMIT: Duration = Duration::from_secs(60);
        let (tx, _rx) = channel();
        let mut terminals =
            TerminalRegistry::with_shell(tx, IDLE_LIMIT, "/bin/sh", &["-c", "sleep 30"]);
        let startup = enabled_startup(false);
        let mut viewers = (1..=MAX_VIEWERS as u8)
            .map(TestViewer::new)
            .collect::<Vec<_>>();
        open_viewer(&mut terminals, &startup, &mut viewers[0]);
        for viewer in viewers.iter_mut().skip(1) {
            attach_viewer(&mut terminals, &startup, viewer);
        }
        let extra = TestViewer::new(50);
        let frames = terminals.attach(&startup, None, extra.handshake(MULTI_TERMINAL, 0, 0));
        assert_eq!(
            rejection(&frames),
            Some((Some(extra.id.clone()), REASON_VIEWER_LIMIT.to_string()))
        );
        let duplicate =
            terminals.attach(&startup, None, viewers[1].handshake(MULTI_TERMINAL, 0, 0));
        assert_eq!(
            rejection(&duplicate),
            Some((
                Some(viewers[1].id.clone()),
                REASON_BAD_HANDSHAKE.to_string()
            ))
        );
        let missing = terminals.attach(
            &startup,
            None,
            TermHandshake {
                viewer_id: None,
                ..extra.handshake(MULTI_TERMINAL, 0, 0)
            },
        );
        assert_eq!(
            rejection(&missing),
            Some((None, REASON_BAD_HANDSHAKE.to_string()))
        );

        // One viewer left keeps the terminal alive past the idle limit.
        for viewer in viewers.iter().skip(1) {
            terminals.detach(MULTI_TERMINAL, Some(&viewer.id));
        }
        let past_idle = || Instant::now() + IDLE_LIMIT * 2;
        assert!(terminals.poll(past_idle()).is_empty());
        terminals.detach(MULTI_TERMINAL, Some(&viewers[0].id));
        // The poll clock is passed in, so no real waiting is needed.
        let frames = terminals.poll(past_idle());
        assert!(matches!(
            controls(&frames)[0],
            NodeFrame::TermExit { terminal_id, .. } if terminal_id == MULTI_TERMINAL
        ));
    }

    #[cfg(unix)]
    #[test]
    fn two_pending_approvals_both_complete() {
        use p256::elliptic_curve::Generate;
        let dir = tempfile::tempdir().expect("tempdir");
        let (tx, _rx) = channel();
        let mut terminals = multi_registry(tx);
        let startup = enabled_startup(true);
        let identity = p256::ecdsa::SigningKey::try_generate().expect("identity");
        let identity_raw = {
            let encoded = identity.verifying_key().to_sec1_point(false);
            let mut raw = [0_u8; 65];
            raw.copy_from_slice(encoded.as_bytes());
            raw
        };
        let identity_message = TerminalIdentity {
            public_key: terminal_crypto::encode_b64url(&identity_raw),
            signature: None,
        };
        crate::approvals::record_pending(dir.path(), &identity_raw).expect("pending");
        crate::approvals::approve(dir.path(), &terminal_crypto::approval_code(&identity_raw))
            .expect("approve");
        let sign = |viewer: &TestViewer, cli_nonce: &str| {
            let signature = terminal_crypto::sign_approval_v2(
                &identity,
                MULTI_TERMINAL,
                &viewer.id,
                viewer.browser.public_raw(),
                &viewer.nonce,
                startup.key().public_raw(),
                &terminal_crypto::decode_nonce(cli_nonce).expect("nonce"),
            )
            .expect("sign");
            terminal_crypto::encode_b64url(&signature)
        };

        let mut a = TestViewer::new(1);
        let pending = terminals.open(
            &startup,
            Some(dir.path()),
            TermHandshake {
                identity: Some(&identity_message),
                ..a.handshake(MULTI_TERMINAL, 80, 24)
            },
        );
        assert!(matches!(
            controls(&pending)[0],
            NodeFrame::TermPending { viewer_id: Some(id), .. } if id == &a.id
        ));
        let a_nonce = cli_nonce_of(&pending);
        let a_id = a.id.clone();
        let opened = terminals.auth(
            &startup,
            Some(dir.path()),
            MULTI_TERMINAL,
            Some(&a_id),
            &sign(&a, &a_nonce),
        );
        assert!(matches!(
            controls(&opened)[0],
            NodeFrame::TermOpened { viewer_id: Some(id), .. } if id == &a.id
        ));
        a.bind(&startup, MULTI_TERMINAL, &a_nonce);
        assert_eq!(
            a.receive(MULTI_TERMINAL, &opened),
            vec![Seen::Key(1), Seen::Size(80, 24)]
        );

        let mut b = TestViewer::new(2);
        let mut c = TestViewer::new(3);
        let mut nonces = Vec::new();
        for viewer in [&b, &c] {
            let pending = terminals.attach(
                &startup,
                Some(dir.path()),
                TermHandshake {
                    identity: Some(&identity_message),
                    ..viewer.handshake(MULTI_TERMINAL, 0, 0)
                },
            );
            assert!(matches!(
                controls(&pending)[0],
                NodeFrame::TermPending { viewer_id: Some(id), .. } if id == &viewer.id
            ));
            nonces.push(cli_nonce_of(&pending));
        }
        assert_eq!(terminals.pending.len(), 2);
        // B's signature does not verify for C: the transcript binds the viewer.
        let c_id = c.id.clone();
        let wrong = terminals.auth(
            &startup,
            Some(dir.path()),
            MULTI_TERMINAL,
            Some(&c_id),
            &sign(&b, &nonces[0]),
        );
        assert_eq!(
            rejection(&wrong),
            Some((Some(c.id.clone()), REASON_BAD_SIGNATURE.to_string()))
        );
        // Re-queue C, then complete C before B.
        let pending = terminals.attach(
            &startup,
            Some(dir.path()),
            TermHandshake {
                identity: Some(&identity_message),
                ..c.handshake(MULTI_TERMINAL, 0, 0)
            },
        );
        nonces[1] = cli_nonce_of(&pending);
        let attached_c = terminals.auth(
            &startup,
            Some(dir.path()),
            MULTI_TERMINAL,
            Some(&c_id),
            &sign(&c, &nonces[1]),
        );
        let b_id = b.id.clone();
        let attached_b = terminals.auth(
            &startup,
            Some(dir.path()),
            MULTI_TERMINAL,
            Some(&b_id),
            &sign(&b, &nonces[0]),
        );
        for (viewer, frames, nonce) in [
            (&mut c, &attached_c, &nonces[1]),
            (&mut b, &attached_b, &nonces[0]),
        ] {
            assert!(matches!(
                controls(frames)[0],
                NodeFrame::TermAttached { viewer_id: Some(id), .. } if id == &viewer.id
            ));
            viewer.bind(&startup, MULTI_TERMINAL, nonce);
            assert_eq!(
                viewer.receive(MULTI_TERMINAL, frames),
                vec![Seen::Key(1), Seen::Size(80, 24)]
            );
        }
        assert!(terminals.pending.is_empty());
        let live = terminals.on_bytes(MULTI_TERMINAL, b"all");
        for viewer in [&mut a, &mut b, &mut c] {
            assert_eq!(
                viewer.receive(MULTI_TERMINAL, &live),
                vec![Seen::Data(b"all".to_vec())]
            );
        }

        // Revoking the identity removes every viewer it approved.
        crate::approvals::revoke(dir.path(), &terminal_crypto::approval_code(&identity_raw))
            .expect("revoke");
        let frames = terminals.poll(Instant::now());
        let rejected = controls(&frames)
            .into_iter()
            .filter(|message| {
                matches!(
                    message,
                    NodeFrame::TermRejected { reason, .. }
                        if reason == REASON_APPROVAL_REQUIRED
                )
            })
            .count();
        assert_eq!(rejected, 3);
        assert!(
            terminals
                .sessions
                .get(MULTI_TERMINAL)
                .expect("session")
                .viewers
                .is_empty()
        );
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        let Ok(raw) = i32::try_from(pid) else {
            return false;
        };
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw), None).is_ok()
    }

    #[cfg(not(unix))]
    fn process_exists(pid: u32) -> bool {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "tasklist", "/FI", &format!("PID eq {pid}")]);
        command.output().ok().is_some_and(|output| {
            String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
        })
    }

    #[cfg(unix)]
    fn input_drops(frames: &[OutboundFrame]) -> Vec<Option<String>> {
        controls(frames)
            .into_iter()
            .filter_map(|message| match message {
                NodeFrame::TermInputDropped { viewer_id, .. } => Some(viewer_id.clone()),
                _ => None,
            })
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn a_large_paste_into_a_non_reading_pty_never_blocks_and_overflow_is_signalled() {
        let (tx, rx) = channel();
        // Raw mode without echo: the program never reads, so the PTY input
        // buffer fills and a blocking write would stall the caller.
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "stty raw -echo; sleep 30"],
        );
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        let opened = open_viewer(&mut terminals, &startup, &mut a);
        a.receive(MULTI_TERMINAL, &opened);
        std::thread::sleep(Duration::from_millis(200));
        let a_id = a.id.clone();
        let chunk = vec![b'x'; 16 * 1024];
        let started = Instant::now();
        let mut frames = Vec::new();
        // 2 MiB: far beyond the PTY buffer plus the 256 KiB queue.
        for _ in 0..128 {
            frames.extend(send(
                &mut terminals,
                &mut a,
                &a_id,
                &TermPlaintextV2::Data(chunk.clone()),
            ));
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "input handling blocked for {:?}",
            started.elapsed()
        );
        // One signal per run of drops, addressed to the typing viewer.
        assert_eq!(input_drops(&frames), vec![Some(a_id.clone())]);
        assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
        // The registry still serves other work, such as a resize.
        let resized = send(
            &mut terminals,
            &mut a,
            &a_id,
            &TermPlaintextV2::Resize {
                cols: 100,
                rows: 30,
            },
        );
        assert_eq!(
            a.receive(MULTI_TERMINAL, &resized),
            vec![Seen::Size(100, 30)]
        );
        let started = Instant::now();
        let closed = terminals.close(MULTI_TERMINAL);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "close waited on the blocked writer for {:?}",
            started.elapsed()
        );
        assert!(matches!(controls(&closed)[0], NodeFrame::TermExit { .. }));
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn input_queue_drops_past_the_limit_and_accepts_again_once_written() {
        let queue = InputQueue::new();
        assert!(queue.push(vec![0; INPUT_QUEUE_LIMIT]).expect("push"));
        assert!(!queue.push(vec![0; 1]).expect("full"));
        let stop = AtomicBool::new(false);
        let chunk = queue.next(&stop).expect("chunk");
        // Still in flight: in-flight bytes count against the limit.
        assert!(!queue.push(vec![0; 1]).expect("in flight"));
        queue.written(chunk.len());
        assert!(queue.push(vec![0; 1]).expect("room again"));
        queue.close();
        assert!(queue.push(vec![0; 1]).is_err());
        assert!(queue.next(&stop).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_writer_error_asks_the_relay_loop_to_close_the_terminal() {
        let pipe = filedescriptor::Pipe::new().expect("pipe");
        drop(pipe.read);
        let (tx, rx) = channel();
        let input = Arc::new(InputQueue::new());
        let stop = Arc::new(AtomicBool::new(false));
        let _writer = pump_input(
            pipe.write,
            Arc::clone(&input),
            tx,
            Arc::clone(&stop),
            "broken".to_string(),
        );
        assert!(input.push(b"hello".to_vec()).expect("queued"));
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(FromWorker::TerminalWriteFailed { terminal_id }) => {
                assert_eq!(terminal_id, "broken");
            }
            _ => panic!("the writer did not report its failure"),
        }
        assert!(input.push(b"more".to_vec()).is_err());
        stop.store(true, Ordering::SeqCst);
    }

    /// Alive and not a zombie.
    #[cfg(target_os = "linux")]
    fn process_running(pid: u32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| {
                let rest = &stat[stat.rfind(')')? + 1..];
                rest.split_whitespace().next().map(|state| state != "Z")
            })
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn closing_a_terminal_kills_background_and_nohup_jobs_in_its_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bg_file = dir.path().join("bg.pid");
        let nohup_file = dir.path().join("nohup.pid");
        // `set -m` puts each background job in its own process group, so a
        // process-group kill of the shell alone would miss both.
        let script = format!(
            "set -m; sleep 120 & echo $! > '{}'; nohup sleep 120 >/dev/null 2>&1 & echo $! > '{}'; wait",
            bg_file.display(),
            nohup_file.display()
        );
        let (tx, rx) = channel();
        let mut terminals =
            TerminalRegistry::with_shell(tx, Duration::from_secs(60), "/bin/sh", &["-c", &script]);
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
        terminals.open(
            &startup,
            None,
            TermHandshake {
                terminal_id: "jobs",
                viewer_id: Some("viewer-a"),
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        let shell = terminals
            .sessions
            .get("jobs")
            .and_then(|session| session.pty.as_ref())
            .and_then(|pty| pty.pid)
            .expect("shell pid");
        let read_pid = |path: &Path| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok(text) = std::fs::read_to_string(path)
                    && let Ok(pid) = text.trim().parse::<u32>()
                    && pid > 1
                {
                    return pid;
                }
                assert!(Instant::now() < deadline, "job pid was not written");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let bg = read_pid(&bg_file);
        let nohup = read_pid(&nohup_file);
        let shell_group = nix::unistd::Pid::from_raw(i32::try_from(shell).expect("pid"));
        for job in [bg, nohup] {
            let job_pid = nix::unistd::Pid::from_raw(i32::try_from(job).expect("pid"));
            assert!(process_running(job), "job {job} is not running");
            assert_eq!(nix::unistd::getsid(Some(job_pid)), Ok(shell_group));
            assert_ne!(
                nix::unistd::getpgid(Some(job_pid)),
                Ok(shell_group),
                "job {job} shares the shell's process group"
            );
        }
        let _ = terminals.close("jobs");
        let deadline = Instant::now() + Duration::from_secs(2);
        while (process_running(bg) || process_running(nohup)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!process_running(bg), "background job {bg} survived close");
        assert!(!process_running(nohup), "nohup job {nohup} survived close");
        drop(terminals);
        drop(rx);
    }

    /// Dead or a zombie: the process can no longer act. A zombie is already
    /// dead and only waits for its parent to reap it, and `kill(pid, 0)` still
    /// succeeds for one, so a bare existence check would spin until its
    /// deadline on a loaded macOS runner. Without `/proc` the state comes from
    /// `ps`; if that is unavailable the process is assumed alive (fail closed).
    #[cfg(unix)]
    fn process_dead(pid: u32) -> bool {
        if !process_exists(pid) {
            return true;
        }
        #[cfg(target_os = "linux")]
        {
            !process_running(pid)
        }
        #[cfg(not(target_os = "linux"))]
        {
            std::process::Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .env_clear()
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .ok()
                .is_some_and(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .trim_start()
                        .starts_with('Z')
                })
        }
    }

    /// Dead or a zombie. Killed orphans are reaped by init after a moment.
    #[cfg(unix)]
    fn process_gone(pid: u32) -> bool {
        process_dead(pid)
    }

    /// The zombie case that made the macOS confirm-child wait spin: a child
    /// that exited but was not reaped still satisfies `kill(pid, 0)`, so a bare
    /// existence check cannot tell it apart from a live one. Only a state
    /// check can, and this pins that `process_dead` does so without reaping.
    #[cfg(unix)]
    #[test]
    fn an_unreaped_exited_child_reads_as_dead_but_still_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("ran");
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("touch '{}'; exit 0", marker.display())])
            .spawn()
            .expect("spawn a short-lived child");
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !process_dead(pid) {
            assert!(
                Instant::now() < deadline,
                "the exited child was never seen as dead"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // Never reaped here, so it is still a zombie: a bare existence check
        // would call it alive, which is what wedged the confirm-child wait.
        assert!(process_exists(pid), "the child was reaped, not a zombie");
        assert!(marker.exists());
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_exit_closes_the_terminal_while_a_disowned_job_holds_the_pty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let job_file = dir.path().join("job.pid");
        // The non-interactive form of `sleep 120 & disown; exit`: `set -m`
        // puts the job in its own background process group, so the kernel's
        // hangup on the leader's exit misses it, and its stdout keeps the PTY
        // open after the shell has gone.
        let script = format!(
            "set -m; sleep 120 & echo $! > '{}'; printf wsmp-bye; exit 0",
            job_file.display()
        );
        let (tx, rx) = channel();
        let mut terminals =
            TerminalRegistry::with_shell(tx, Duration::from_secs(60), "/bin/sh", &["-c", &script]);
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
        let opened = terminals.open(
            &startup,
            None,
            TermHandshake {
                terminal_id: "exited",
                viewer_id: Some("viewer-a"),
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        assert!(matches!(
            &opened[0],
            OutboundFrame::Control(NodeFrame::TermOpened { .. })
        ));
        let started = Instant::now();
        let deadline = started + Duration::from_secs(10);
        let mut output = Vec::new();
        let mut sealed_output = false;
        let mut exit = None;
        // Drive the registry the way the relay loop does: drain worker
        // output, then poll.
        while exit.is_none() && Instant::now() < deadline {
            let mut frames = Vec::new();
            while let Ok(note) = rx.try_recv() {
                match note {
                    FromWorker::TerminalBytes { terminal_id, bytes } => {
                        output.extend_from_slice(&bytes);
                        frames.extend(terminals.on_bytes(&terminal_id, &bytes));
                    }
                    FromWorker::TerminalEof { terminal_id } => {
                        frames.extend(terminals.on_eof(&terminal_id));
                    }
                    _ => {}
                }
            }
            frames.extend(terminals.poll(Instant::now()));
            for frame in frames {
                match frame {
                    OutboundFrame::Binary(..) if exit.is_none() => sealed_output = true,
                    OutboundFrame::Control(NodeFrame::TermExit {
                        terminal_id,
                        exit_code,
                        signal,
                    }) => {
                        assert_eq!(terminal_id, "exited");
                        exit = Some((exit_code, signal));
                    }
                    _ => {}
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            exit,
            Some((Some(0), None)),
            "the terminal did not close with the shell's status within {:?}",
            started.elapsed()
        );
        assert!(
            output.windows(8).any(|window| window == b"wsmp-bye"),
            "output written before exit was lost: {output:?}"
        );
        assert!(
            sealed_output,
            "no output reached the viewer before term.exit"
        );
        assert!(terminals.sessions.is_empty(), "the terminal kept its slot");

        let text = std::fs::read_to_string(&job_file).expect("job pid");
        let job = text.trim().parse::<u32>().expect("job pid");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !process_gone(job) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(process_gone(job), "disowned job {job} survived the close");
        drop(terminals);
        drop(rx);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn forced_shutdown_kills_tracked_terminal_sessions_and_exec_groups() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bg_file = dir.path().join("bg.pid");
        let exec_file = dir.path().join("exec.pid");
        let script = format!(
            "set -m; sleep 120 & echo $! > '{}'; wait",
            bg_file.display()
        );
        let (tx, rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx.clone(),
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", &script],
        );
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
        terminals.open(
            &startup,
            None,
            TermHandshake {
                terminal_id: "forced",
                viewer_id: Some("viewer-a"),
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        let shell = terminals
            .sessions
            .get("forced")
            .and_then(|session| session.pty.as_ref())
            .and_then(|pty| pty.pid)
            .expect("shell pid");
        let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
        execs.start(
            &startup,
            "forced",
            &format!("sleep 120 & echo $! > '{}'; wait", exec_file.display()),
            Some(dir.path().to_str().expect("utf8")),
            TEST_TIMEOUT_MS,
        );
        let exec = execs.pid("forced").expect("exec pid");
        let read_pid = |path: &Path| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok(text) = std::fs::read_to_string(path)
                    && let Ok(pid) = text.trim().parse::<u32>()
                    && pid > 1
                {
                    return pid;
                }
                assert!(Instant::now() < deadline, "pid was not written");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let bg = read_pid(&bg_file);
        let exec_grandchild = read_pid(&exec_file);
        let ours = [LiveChild::PtySession(shell), LiveChild::ExecGroup(exec)];
        {
            let live = LIVE_CHILDREN.lock().expect("live children");
            assert!(ours.iter().all(|child| live.values().any(|v| v == child)));
        }

        // Only this test's children: other tests run in parallel.
        kill_live_children(|child| ours.contains(child));
        let deadline = Instant::now() + Duration::from_secs(2);
        while [shell, bg, exec, exec_grandchild]
            .iter()
            .any(|pid| process_running(*pid))
            && Instant::now() < deadline
        {
            // The direct children are ours to reap.
            let _ = reap_pid(Some(shell));
            let _ = reap_pid(Some(exec));
            std::thread::sleep(Duration::from_millis(20));
        }
        for pid in [shell, bg, exec, exec_grandchild] {
            assert!(
                !process_running(pid),
                "process {pid} survived a forced shutdown"
            );
        }

        let _ = terminals.kill_all();
        let _ = execs.kill_all();
        let live = LIVE_CHILDREN.lock().expect("live children");
        assert!(
            ours.iter().all(|child| live.values().all(|v| v != child)),
            "closed sessions leave the forced-shutdown list"
        );
        drop(live);
        drop(rx);
    }

    #[cfg(unix)]
    mod output_mask_tests;

    #[cfg(unix)]
    mod operator_tests;

    /// The `command operation` info lines as `(op, command_id, outcome)`.
    /// The default formatter writes the message last, then the fields in the
    /// `tracing::info!` order; `command_id` is quoted, the other two are bare
    /// (the `op` may be quoted too, depending on the value).
    fn command_ops(log: &str) -> Vec<(String, String, String)> {
        const MESSAGE: &str = "command operation";
        log.lines()
            .filter_map(|line| {
                let marker = line.find(MESSAGE)?;
                let rest = &line[marker + MESSAGE.len()..];
                let words = rest.split_whitespace().collect::<Vec<_>>();
                let [op, command_id, outcome] = words[words.len().checked_sub(3)?..] else {
                    return None;
                };
                Some((
                    op.strip_prefix("op=")?.trim_matches('"').to_string(),
                    command_id
                        .strip_prefix("command_id=")?
                        .trim_matches('"')
                        .to_string(),
                    outcome
                        .strip_prefix("outcome=")?
                        .trim_matches('"')
                        .to_string(),
                ))
            })
            .collect()
    }
}
