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
//! calls `setsid()` itself leaves that session and survives. Windows has no
//! process-group kill: only the direct child is terminated, so grandchildren of
//! an exec may survive.
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
//! Protocol 2.5 terminals have many viewers. Each viewer has pairwise v2 keys
//! for its input and for unicast frames (output-key delivery and its scrollback
//! replay). Live output and PTY-size frames are sealed once under a shared
//! per-terminal output key; the relay fans them out. The key rotates to a new
//! epoch whenever a viewer leaves. The PTY size follows the writer, the viewer
//! that most recently typed. Protocol 2.4 keeps one implicit viewer, v1 crypto,
//! and attach-replaces-viewer.

use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
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
use crate::config::Config;
#[cfg(unix)]
use crate::protocol::SupervisedOutputPart;
use crate::protocol::{
    ClientControlMessage, RelayBinaryFrameMetadata, SupervisedSpawn, TerminalIdentity,
    terminal_supported,
};
use crate::relay_bus::FromWorker;
use crate::startup::TerminalStartup;
use crate::terminal_crypto::{
    self, DIR_BROWSER_TO_CLI, DIR_CLI_TO_BROWSER, DirectionKeys, TermPlaintext, TermPlaintextV2,
};

const MAX_TERMINALS: usize = 2;
/// Attached viewers plus pending approvals, per terminal (protocol 2.5).
const MAX_VIEWERS: usize = 8;
const MAX_EXECS: usize = 2;
#[cfg(unix)]
const SCROLLBACK_LIMIT: usize = 256 * 1024;
const READ_CHUNK: usize = 8 * 1024;
const SEAL_CHUNK: usize = 16 * 1024;
const DEFAULT_IDLE: Duration = Duration::from_secs(15 * 60);
pub(crate) const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PENDING_TTL: Duration = Duration::from_secs(2 * 60);
/// How often attached 2.5 viewers are re-checked against the approvals file.
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
/// Map key for the single implicit viewer of a 2.4 (legacy) terminal. Never a
/// valid wire viewer id, so it cannot collide with a 2.5 viewer.
const LEGACY_VIEWER: &str = "";

const REASON_DISABLED: &str = "disabled";
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
const REASON_EXPIRED: &str = "expired";
const REASON_SUPERVISED_ONLY: &str = "supervised_only";
/// The supervised working directory is not valid UTF-8, so the confirm
/// screen could not show it exactly. Passed through to the agent as the
/// rejection reason.
const REASON_CWD_NOT_UTF8: &str = "cwd_not_utf8";

/// Supervised terminals waiting for Enter (starting or on the confirm screen).
const MAX_SUPERVISED_AWAITING: usize = 1;
/// Supervised terminals with a live PTY (awaiting Enter or running). With
/// one awaiting slot this is "1 awaiting + 1 running", enforced at spawn: an
/// Enter on a drawn screen is never refused. Finished review-pending
/// terminals (no PTY) do not count.
const MAX_SUPERVISED_LIVE: usize = 2;
/// Safety net for a confirm screen nobody answered. The server expires the
/// request at 15 minutes and normally cancels it first.
const SUPERVISED_CONFIRM_TTL: Duration = Duration::from_secs(16 * 60);
/// How long a finished command's output capture waits for review.
const SUPERVISED_REVIEW_TTL: Duration = Duration::from_secs(15 * 60);
const SUPERVISED_REASON_MAX_CHARS: usize = 500;
const SUPERVISED_REQUESTER_MAX_CHARS: usize = 100;

#[cfg(unix)]
mod supervised_pty;
#[cfg(unix)]
use supervised_pty::{MarkerEvent, Piece};
#[cfg(unix)]
pub(crate) use supervised_pty::{
    SUPERVISED_ENV_COMMAND, SUPERVISED_ENV_MARKER, SUPERVISED_ENV_NAMES, SUPERVISED_ENV_REASON,
    SUPERVISED_ENV_REQUESTER, SUPERVISED_ENV_SHARE, supervised_marker,
};

pub(crate) enum OutboundFrame {
    Control(ClientControlMessage),
    Binary(RelayBinaryFrameMetadata, Vec<u8>),
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
    /// 2.4: an authenticated frame with a bad payload closes the terminal.
    Close,
    /// 2.5: an authenticated frame with a bad payload removes only its viewer.
    DropViewer,
    /// A supervised command's "review output before sending" checkbox.
    ReviewToggle(bool),
}

fn terminal_block_reason(supported: bool, allowed: bool, open: usize) -> Option<&'static str> {
    if !supported {
        return Some(REASON_UNSUPPORTED);
    }
    if !allowed {
        return Some(REASON_DISABLED);
    }
    if open >= MAX_TERMINALS {
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

fn denied_env_names(config: &Config) -> Vec<String> {
    crate::commands::service::required_service_env_names(config)
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
        startup.allow_human_terminal(),
        counted,
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
    OutboundFrame::Control(ClientControlMessage::TermPending {
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
    OutboundFrame::Control(ClientControlMessage::TermRejected {
        terminal_id: terminal_id.to_string(),
        viewer_id: viewer_id.map(str::to_string),
        reason: reason.to_string(),
        approval_code,
    })
}

fn term_writer(terminal_id: &str, writer: Option<&str>) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::TermWriter {
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
        RelayBinaryFrameMetadata::TermSealed {
            terminal_id: terminal_id.to_string(),
            seq,
            viewer_id: viewer_id.map(str::to_string),
            epoch,
        },
        body,
    )
}

fn exec_rejected(command_id: &str, reason: &str) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::ExecRejected {
        command_id: command_id.to_string(),
        reason: reason.to_string(),
    })
}

fn signal_token(signal: Option<i32>) -> Option<String> {
    signal.map(|value| value.to_string())
}

fn exec_done(
    command_id: &str,
    exit_code: Option<i32>,
    signal: Option<i32>,
    timed_out: bool,
) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::ExecDone {
        command_id: command_id.to_string(),
        exit_code,
        signal: signal_token(signal),
        timed_out,
    })
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveChild {
    /// An exec shell: the leader of its own process group on Unix. On
    /// Windows its process handle stays open while it is tracked, so the pid
    /// cannot be reused.
    ExecGroup(u32),
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
            #[cfg(not(unix))]
            LiveChild::ExecGroup(pid) => kill_process_tree(pid),
            #[cfg(unix)]
            LiveChild::PtySession(pid) => {
                kill_session(pid);
                kill_process_group(pid, false);
            }
        }
    }
}

/// Windows has no process groups. The relay thread owns the `Child`, so a
/// forced shutdown ends the exec and its descendants with `taskkill /T /F`.
#[cfg(not(unix))]
fn kill_process_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
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

    /// The daemon's own bytes (the supervised `go` token): queued behind
    /// what is already there, never dropped for a full queue.
    fn push_control(&self, bytes: Vec<u8>) -> std::io::Result<()> {
        let mut state = self.lock();
        if state.failed || state.closed {
            return Err(std::io::Error::other("terminal input is closed"));
        }
        state.pending += bytes.len();
        state.chunks.push_back(bytes);
        drop(state);
        self.ready.notify_one();
        Ok(())
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

fn wipe_capture_message(message: &mut TermPlaintextV2) {
    if let TermPlaintextV2::ReviewCapture { head, tail, .. } = message {
        wipe(head);
        wipe(tail);
    }
}

/// One browser tab. On a 2.4 terminal the single implicit viewer uses v1 keys.
struct Viewer {
    keys: DirectionKeys,
    last_rx: u64,
    next_tx: u64,
    /// The viewer's own fitted size, from the open request or its last resize.
    last_size: Option<(u16, u16)>,
    /// The identity approved through `term.auth`. Re-checked so a revoke
    /// removes the viewer.
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

/// The bytes a command printed after Enter, bounded like the server's exec
/// buffers: the first [`terminal_crypto::CAPTURE_HEAD_MAX`] bytes and a
/// rolling last [`terminal_crypto::CAPTURE_TAIL_MAX`] bytes of the stream.
#[derive(Default)]
struct Capture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: u64,
}

impl Capture {
    /// The server's view: the tail only once the stream is past the head.
    fn parts(&self) -> (Vec<u8>, Vec<u8>) {
        let tail = if self.total > terminal_crypto::CAPTURE_HEAD_MAX as u64 {
            self.tail.iter().copied().collect()
        } else {
            Vec::new()
        };
        (self.head.clone(), tail)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        wipe(&mut self.head);
        self.tail.iter_mut().for_each(|byte| *byte = 0);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    not(unix),
    expect(
        dead_code,
        reason = "only the Unix PTY path (`supervised_pty`) creates a supervised terminal; \
                  elsewhere the shared checks below only ever see `None`"
    )
)]
enum SupervisedPhase {
    /// The confirm child is starting; its screen is not drawn yet.
    Starting,
    /// The confirm screen is drawn and waits for Enter.
    Confirm,
    /// Enter was pressed; the command runs in the PTY.
    Running,
    /// The command exited and its capture waits for review. No PTY.
    Finished,
}

/// An agent-requested terminal: a confirm screen, then exactly one command.
struct Supervised {
    command_id: String,
    share_output: bool,
    /// Terminal-wide "review output before sending".
    review: bool,
    phase: SupervisedPhase,
    /// The confirm child's markers, the `go` token and PTY EOF.
    #[cfg(unix)]
    child: supervised_pty::ChildLink,
    capture: Capture,
    spawned_at: Instant,
    finished_at: Option<Instant>,
    /// Kept for the `term.exit` of a finished session.
    exit_status: (Option<i32>, Option<i32>),
    /// A person pressed Enter but `go` could not be written (the PTY is
    /// going away): the command never started, and this is not a decline.
    start_failed: bool,
}

impl Supervised {
    fn awaiting(&self) -> bool {
        matches!(
            self.phase,
            SupervisedPhase::Starting | SupervisedPhase::Confirm
        )
    }

    fn capture_message(&self) -> TermPlaintextV2 {
        let (head, tail) = self.capture.parts();
        TermPlaintextV2::ReviewCapture {
            total: self.capture.total,
            head,
            tail,
        }
    }
}

struct TerminalSession {
    /// Protocol 2.5: v2 crypto, broadcast output, and writer tracking.
    multi: bool,
    viewers: BTreeMap<String, Viewer>,
    /// 2.5 only. The viewer that most recently typed.
    writer: Option<String>,
    pty_size: (u16, u16),
    /// 2.5 only. `None` on a 2.4 terminal.
    out: Option<OutputKey>,
    /// Set when the viewer set becomes empty; drives the idle close.
    detached_at: Option<Instant>,
    scrollback: VecDeque<u8>,
    #[cfg(unix)]
    pty: Option<PtyRuntime>,
    /// Set on an agent-requested (supervised) terminal.
    supervised: Option<Supervised>,
}

impl TerminalSession {
    /// Whether viewer keystrokes may reach the PTY now. A supervised terminal
    /// takes input only once its confirm screen is drawn and while the
    /// command has not exited; everything else is dropped, never queued.
    fn accepts_input(&self) -> bool {
        #[cfg(unix)]
        if self.pty.as_ref().is_none_or(|pty| pty.exited.is_some()) {
            return false;
        }
        match &self.supervised {
            None => true,
            Some(supervised) => matches!(
                supervised.phase,
                SupervisedPhase::Confirm | SupervisedPhase::Running
            ),
        }
    }

    /// Supervised PTY output: markers become phase changes and never reach
    /// viewers; bytes after Enter also go to the capture.
    #[cfg(unix)]
    fn supervised_bytes(&mut self, terminal_id: &str, bytes: &[u8]) -> Vec<OutboundFrame> {
        let mut frames = Vec::new();
        let mut display = Vec::new();
        {
            let Some(supervised) = self.supervised.as_mut() else {
                return frames;
            };
            if supervised.phase == SupervisedPhase::Finished {
                return frames;
            }
            for piece in supervised.child.scanner.feed(bytes) {
                match piece {
                    Piece::Bytes(bytes) => {
                        if supervised.phase == SupervisedPhase::Running {
                            supervised.capture.push(&bytes);
                        }
                        display.extend(bytes);
                    }
                    Piece::Event(MarkerEvent::Ready) => {
                        if supervised.phase == SupervisedPhase::Starting {
                            supervised.phase = SupervisedPhase::Confirm;
                        }
                    }
                    Piece::Event(MarkerEvent::Accepted) => {
                        // The decision point: only a request still waiting
                        // here starts; the child execs only on `go`.
                        if supervised.phase != SupervisedPhase::Confirm {
                            continue;
                        }
                        let released = self
                            .pty
                            .as_ref()
                            .map(|pty| pty.input.push_control(supervised.child.go.clone()));
                        if let Some(Ok(())) = released {
                            supervised.phase = SupervisedPhase::Running;
                            frames.push(OutboundFrame::Control(
                                ClientControlMessage::SupervisedAccepted {
                                    command_id: supervised.command_id.clone(),
                                },
                            ));
                        } else {
                            // The PTY is going away; the child exits without
                            // running anything. Only `term.exit` reports it:
                            // a person pressed Enter, so it is no decline.
                            supervised.start_failed = true;
                            tracing::warn!(terminal_id, "could not start a confirmed command");
                        }
                    }
                }
            }
        }
        if !display.is_empty() {
            push_scrollback(&mut self.scrollback, &display);
            frames.extend(self.broadcast_data(terminal_id, &display));
        }
        frames
    }

    /// Unicast to a joining viewer: the review flag, and the capture when a
    /// finished command waits for review.
    fn supervised_join_frames(&mut self, terminal_id: &str, viewer_id: &str) -> Vec<OutboundFrame> {
        let Some(supervised) = self.supervised.as_ref() else {
            return Vec::new();
        };
        if !supervised.share_output {
            return Vec::new();
        }
        let review = supervised.review;
        let capture = (supervised.phase == SupervisedPhase::Finished && review)
            .then(|| supervised.capture_message());
        let mut frames = Vec::new();
        frames.extend(self.seal_unicast(
            terminal_id,
            viewer_id,
            &TermPlaintextV2::ReviewState(review),
        ));
        if let Some(mut message) = capture {
            frames.extend(self.seal_unicast(terminal_id, viewer_id, &message));
            wipe_capture_message(&mut message);
        }
        frames
    }

    /// v1 output for the single 2.4 viewer. Nothing when it is detached.
    fn seal_legacy_data(&mut self, terminal_id: &str, data: &[u8]) -> Vec<OutboundFrame> {
        let Some(viewer) = self.viewers.get_mut(LEGACY_VIEWER) else {
            return Vec::new();
        };
        let mut frames = Vec::new();
        for chunk in data.chunks(SEAL_CHUNK) {
            if chunk.is_empty() {
                continue;
            }
            let Ok(plaintext) =
                terminal_crypto::encode_plaintext(&TermPlaintext::Data(chunk.to_vec()))
            else {
                continue;
            };
            let seq = viewer.next_tx;
            viewer.next_tx = viewer.next_tx.saturating_add(1);
            match terminal_crypto::seal(
                &viewer.keys.cli_to_browser,
                terminal_id,
                DIR_CLI_TO_BROWSER,
                seq,
                &plaintext,
            ) {
                Ok(body) => frames.push(sealed_frame(terminal_id, seq, None, None, body)),
                Err(error) => {
                    tracing::warn!(error = %error, terminal_id, "sealing terminal output failed");
                    break;
                }
            }
        }
        frames
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
        let multi = self.multi;
        // The relay stamps the viewer id; pick that viewer's keys. Never
        // trial-decrypt under other viewers.
        let Some(viewer) = self.viewers.get_mut(viewer_id) else {
            return Incoming::Ignore;
        };
        let opened = if multi {
            terminal_crypto::open_v2(
                &viewer.keys.browser_to_cli,
                terminal_id,
                viewer_id,
                DIR_BROWSER_TO_CLI,
                seq,
                body,
            )
        } else {
            terminal_crypto::open(
                &viewer.keys.browser_to_cli,
                terminal_id,
                DIR_BROWSER_TO_CLI,
                seq,
                body,
            )
        };
        // Advance the replay cursor only after the frame authenticates.
        // A relay can rewrite the sequence in the cleartext metadata.
        let Ok(plaintext) = opened else {
            return Incoming::Ignore;
        };
        if !terminal_crypto::accept_seq(&mut viewer.last_rx, seq) {
            return Incoming::Ignore;
        };
        if !multi {
            return match terminal_crypto::decode_plaintext(&plaintext) {
                Ok(TermPlaintext::Data(bytes)) => Incoming::Write(bytes),
                Ok(TermPlaintext::Resize { cols, rows }) => Incoming::Resize { cols, rows },
                Err(_) => Incoming::Close,
            };
        }
        match terminal_crypto::decode_plaintext_v2(&plaintext) {
            Ok(TermPlaintextV2::Data(bytes)) => Incoming::Write(bytes),
            Ok(TermPlaintextV2::Resize { cols, rows }) => Incoming::Resize { cols, rows },
            Ok(TermPlaintextV2::ReviewToggle(on)) => Incoming::ReviewToggle(on),
            // A browser never sends an output key, a capture, or a review state.
            Ok(
                TermPlaintextV2::OutputKey { .. }
                | TermPlaintextV2::ReviewCapture { .. }
                | TermPlaintextV2::ReviewState(_),
            )
            | Err(_) => Incoming::DropViewer,
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
    created: Instant,
    attach: bool,
}

/// `(terminalId, viewerId)`; a 2.4 terminal uses [`LEGACY_VIEWER`].
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
    idle_limit: Duration,
    /// Protocol 2.5 multi-viewer mode. `false` runs the 2.4 single-viewer path.
    multi: bool,
    /// The state dir from the last successful `term.auth`, for approval re-checks.
    state_dir: Option<PathBuf>,
    next_approval_check: Option<Instant>,
    shut_down: bool,
    #[cfg(unix)]
    shell: Option<(String, Vec<String>)>,
    /// The confirm child program. `None`: this binary, `terminal supervised-run`.
    #[cfg(unix)]
    supervised_program: Option<(String, Vec<String>)>,
    confirm_ttl: Duration,
    review_ttl: Duration,
}

fn supervised_rejected(command_id: &str, reason: &str) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::SupervisedRejected {
        command_id: command_id.to_string(),
        reason: reason.to_string(),
    })
}

fn term_exit(terminal_id: &str, status: (Option<i32>, Option<i32>)) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::TermExit {
        terminal_id: terminal_id.to_string(),
        exit_code: status.0,
        signal: signal_token(status.1),
    })
}

impl TerminalRegistry {
    pub(crate) fn new(tx: SyncSender<FromWorker>, multi: bool) -> Self {
        // Windows spawns no PTY, so no worker thread needs the channel.
        #[cfg(not(unix))]
        drop(tx);
        Self {
            sessions: BTreeMap::new(),
            pending: BTreeMap::new(),
            #[cfg(unix)]
            tx,
            idle_limit: DEFAULT_IDLE,
            multi,
            state_dir: None,
            next_approval_check: None,
            shut_down: false,
            #[cfg(unix)]
            shell: None,
            #[cfg(unix)]
            supervised_program: None,
            confirm_ttl: SUPERVISED_CONFIRM_TTL,
            review_ttl: SUPERVISED_REVIEW_TTL,
        }
    }

    /// Human (browser-opened) terminals. Supervised terminals have their own slots.
    fn human_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.supervised.is_none())
            .count()
    }

    fn supervised_counts(&self) -> (usize, usize) {
        let mut awaiting = 0;
        let mut running = 0;
        for supervised in self
            .sessions
            .values()
            .filter_map(|session| session.supervised.as_ref())
        {
            if supervised.awaiting() {
                awaiting += 1;
            } else if supervised.phase == SupervisedPhase::Running {
                running += 1;
            }
        }
        (awaiting, running)
    }

    /// `term.spawn`: a viewer-less terminal whose PTY child shows the confirm
    /// screen for exactly this command. Nothing runs until a viewer presses
    /// Enter on that screen.
    pub(crate) fn spawn_supervised(
        &mut self,
        startup: &TerminalStartup,
        config: &Config,
        spawn: &SupervisedSpawn,
    ) -> Vec<OutboundFrame> {
        let command_id = spawn.command_id.as_str();
        if !valid_id(command_id) || !valid_id(&spawn.terminal_id) {
            return vec![supervised_rejected(command_id, REASON_BAD_COMMAND)];
        }
        if !terminal_supported() || !self.multi {
            return vec![supervised_rejected(command_id, REASON_UNSUPPORTED)];
        }
        if !startup.mcp_command_mode().allows_supervised() {
            return vec![supervised_rejected(command_id, REASON_DISABLED)];
        }
        if self.sessions.contains_key(&spawn.terminal_id)
            || self.sessions.values().any(|session| {
                session
                    .supervised
                    .as_ref()
                    .is_some_and(|supervised| supervised.command_id == command_id)
            })
        {
            return vec![supervised_rejected(command_id, REASON_ALREADY_OPEN)];
        }
        let (awaiting, running) = self.supervised_counts();
        if awaiting >= MAX_SUPERVISED_AWAITING || awaiting + running >= MAX_SUPERVISED_LIVE {
            return vec![supervised_rejected(command_id, REASON_LIMIT)];
        }
        if spawn.command.is_empty() || child_env::validate_command(&spawn.command).is_err() {
            return vec![supervised_rejected(command_id, REASON_BAD_COMMAND)];
        }
        let reason = spawn.reason.as_deref().unwrap_or("");
        if reason.contains('\0')
            || reason.chars().count() > SUPERVISED_REASON_MAX_CHARS
            || spawn.requester.is_empty()
            || spawn.requester.contains('\0')
            || spawn.requester.chars().count() > SUPERVISED_REQUESTER_MAX_CHARS
        {
            return vec![supervised_rejected(command_id, REASON_BAD_COMMAND)];
        }
        let home = match user_home() {
            Ok(path) => path,
            Err(_) => return vec![supervised_rejected(command_id, REASON_BAD_CWD)],
        };
        let cwd = match child_env::resolve_cwd(spawn.cwd.as_deref(), &home) {
            Ok(path) => path,
            Err(reason) => {
                tracing::warn!(
                    command_id,
                    reason,
                    "rejecting a supervised working directory"
                );
                return vec![supervised_rejected(command_id, REASON_BAD_CWD)];
            }
        };
        // I1: the confirm screen shows `getcwd()` (the physical path). Refuse
        // before any PTY or child exists when that path cannot be shown
        // exactly, and spawn in the checked physical path.
        let cwd = match child_env::confirm_screen_cwd(&cwd) {
            Ok((physical, _)) => physical,
            Err(child_env::ConfirmCwdError::Unresolvable) => {
                tracing::warn!(
                    command_id,
                    "rejecting an unresolvable supervised working directory"
                );
                return vec![supervised_rejected(command_id, REASON_BAD_CWD)];
            }
            Err(child_env::ConfirmCwdError::NotUtf8) => {
                tracing::warn!(
                    command_id,
                    "rejecting a non-UTF-8 supervised working directory"
                );
                return vec![supervised_rejected(command_id, REASON_CWD_NOT_UTF8)];
            }
        };
        #[cfg(not(unix))]
        {
            let _ = (config, cwd, reason);
            vec![supervised_rejected(command_id, REASON_UNSUPPORTED)]
        }
        #[cfg(unix)]
        {
            self.spawn_supervised_unix(config, spawn, reason, &cwd)
        }
    }

    #[cfg(unix)]
    fn spawn_supervised_unix(
        &mut self,
        config: &Config,
        spawn: &SupervisedSpawn,
        reason: &str,
        cwd: &Path,
    ) -> Vec<OutboundFrame> {
        let command_id = spawn.command_id.as_str();
        let terminal_id = spawn.terminal_id.as_str();
        let marker = match terminal_crypto::random_nonce() {
            Ok(bytes) => bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            Err(error) => {
                tracing::warn!(error = %error, command_id, "generating a supervised marker failed");
                return vec![supervised_rejected(command_id, REASON_SPAWN_FAILED)];
            }
        };
        let out = match OutputKey::first() {
            Ok(out) => out,
            Err(error) => {
                tracing::warn!(error = %error, command_id, "generating a terminal output key failed");
                return vec![supervised_rejected(command_id, REASON_SPAWN_FAILED)];
            }
        };
        let (program, args) = match self.supervised_program.clone() {
            Some(program) => program,
            None => match std::env::current_exe() {
                Ok(path) => (
                    path.to_string_lossy().into_owned(),
                    vec!["terminal".to_string(), "supervised-run".to_string()],
                ),
                Err(error) => {
                    tracing::warn!(error = %error, command_id, "locating the wsmp binary failed");
                    return vec![supervised_rejected(command_id, REASON_SPAWN_FAILED)];
                }
            },
        };
        let mut env = terminal_env(config);
        env.push((SUPERVISED_ENV_COMMAND.to_string(), spawn.command.clone()));
        env.push((SUPERVISED_ENV_REASON.to_string(), reason.to_string()));
        env.push((
            SUPERVISED_ENV_REQUESTER.to_string(),
            spawn.requester.clone(),
        ));
        env.push((
            SUPERVISED_ENV_SHARE.to_string(),
            if spawn.share_output { "1" } else { "0" }.to_string(),
        ));
        env.push((SUPERVISED_ENV_MARKER.to_string(), marker.clone()));
        let (cols, rows) = (80, 24);
        let pty = match spawn_pty(
            &program,
            &args,
            cwd,
            &env,
            cols,
            rows,
            &self.tx,
            terminal_id,
        ) {
            Ok(pty) => pty,
            Err(error) => {
                tracing::warn!(error = %error, command_id, "starting a supervised terminal failed");
                return vec![supervised_rejected(command_id, REASON_SPAWN_FAILED)];
            }
        };
        let now = Instant::now();
        self.sessions.insert(
            terminal_id.to_string(),
            TerminalSession {
                multi: true,
                viewers: BTreeMap::new(),
                writer: None,
                pty_size: (cols, rows),
                out: Some(out),
                detached_at: Some(now),
                scrollback: VecDeque::new(),
                pty: Some(pty),
                supervised: Some(Supervised {
                    command_id: command_id.to_string(),
                    share_output: spawn.share_output,
                    review: false,
                    phase: SupervisedPhase::Starting,
                    child: supervised_pty::ChildLink::new(&marker),
                    capture: Capture::default(),
                    spawned_at: now,
                    finished_at: None,
                    exit_status: (None, None),
                    start_failed: false,
                }),
            },
        );
        vec![OutboundFrame::Control(ClientControlMessage::TermSpawned {
            terminal_id: terminal_id.to_string(),
            command_id: command_id.to_string(),
        })]
    }

    /// `supervised.cancel`: end the command's terminal in whatever state it
    /// is. With `if_waiting` (the server's confirm deadline, or a decline
    /// from the browser) it is a request this registry decides: a request
    /// still waiting is declined (`supervised.declined`, then `term.exit`)
    /// and its command never starts; one whose Enter was already taken keeps
    /// running, and the `supervised.accepted` already sent is the answer.
    pub(crate) fn cancel_supervised(
        &mut self,
        command_id: &str,
        if_waiting: bool,
    ) -> Vec<OutboundFrame> {
        let found = self.sessions.iter().find_map(|(terminal_id, session)| {
            session
                .supervised
                .as_ref()
                .filter(|supervised| supervised.command_id == command_id)
                .map(|supervised| {
                    (
                        terminal_id.clone(),
                        supervised.awaiting(),
                        supervised.start_failed,
                    )
                })
        });
        let Some((terminal_id, awaiting, start_failed)) = found else {
            return Vec::new();
        };
        if !if_waiting || start_failed {
            return self.close(&terminal_id);
        }
        if !awaiting {
            return Vec::new();
        }
        let mut frames = vec![OutboundFrame::Control(
            ClientControlMessage::SupervisedDeclined {
                command_id: command_id.to_string(),
            },
        )];
        frames.extend(self.close(&terminal_id));
        frames
    }

    /// The confirm child or the command exited: report the outcome, then end
    /// the terminal, or keep a finished one whose capture waits for review.
    #[cfg(unix)]
    fn finish_supervised(&mut self, terminal_id: &str, now: Instant) -> Vec<OutboundFrame> {
        let (status, phase, command_id, share_output, review, start_failed) = {
            let Some(session) = self.sessions.get_mut(terminal_id) else {
                return Vec::new();
            };
            let Some(phase) = session
                .supervised
                .as_ref()
                .map(|supervised| supervised.phase)
            else {
                return Vec::new();
            };
            if phase == SupervisedPhase::Finished {
                return Vec::new();
            }
            let status = session.pty.take().map(shutdown_pty).unwrap_or((None, None));
            let Some(supervised) = session.supervised.as_mut() else {
                return Vec::new();
            };
            supervised.exit_status = status;
            (
                status,
                phase,
                supervised.command_id.clone(),
                supervised.share_output,
                supervised.review,
                supervised.start_failed,
            )
        };
        let mut frames = Vec::new();
        if phase != SupervisedPhase::Running {
            // No Enter was taken (or its `go` never reached the child): the
            // command did not start. Only a real decline says `declined`.
            if !start_failed {
                frames.push(OutboundFrame::Control(
                    ClientControlMessage::SupervisedDeclined { command_id },
                ));
            }
            self.sessions.remove(terminal_id);
            frames.push(term_exit(terminal_id, status));
            return frames;
        }
        let done = |review: bool, output_bytes: Option<u64>| {
            OutboundFrame::Control(ClientControlMessage::SupervisedDone {
                command_id: command_id.clone(),
                exit_code: status.0,
                signal: signal_token(status.1),
                review,
                output_bytes,
            })
        };
        if share_output && review {
            frames.push(done(true, None));
            let Some(session) = self.sessions.get_mut(terminal_id) else {
                return frames;
            };
            let message = session.supervised.as_mut().map(|supervised| {
                supervised.phase = SupervisedPhase::Finished;
                supervised.finished_at = Some(now);
                supervised.capture_message()
            });
            if let Some(mut message) = message {
                let viewers = session.viewers.keys().cloned().collect::<Vec<_>>();
                for viewer_id in viewers {
                    frames.extend(session.seal_unicast(terminal_id, &viewer_id, &message));
                }
                wipe_capture_message(&mut message);
            }
            return frames;
        }
        if share_output {
            let (head, tail, total) = match self
                .sessions
                .get(terminal_id)
                .and_then(|session| session.supervised.as_ref())
            {
                Some(supervised) => {
                    let (head, tail) = supervised.capture.parts();
                    (head, tail, supervised.capture.total)
                }
                None => (Vec::new(), Vec::new(), 0),
            };
            for (seq, part, body) in [
                (1, SupervisedOutputPart::Head, head),
                (2, SupervisedOutputPart::Tail, tail),
            ] {
                if body.is_empty() {
                    continue;
                }
                frames.push(OutboundFrame::Binary(
                    RelayBinaryFrameMetadata::SupervisedOutput {
                        command_id: command_id.clone(),
                        part,
                        seq,
                    },
                    body,
                ));
            }
            frames.push(done(false, Some(total)));
        } else {
            frames.push(done(false, None));
        }
        self.sessions.remove(terminal_id);
        frames.push(term_exit(terminal_id, status));
        frames
    }

    /// A 2.4 (single-viewer) registry with a test shell.
    #[cfg(all(unix, test))]
    fn with_shell(
        tx: SyncSender<FromWorker>,
        idle_limit: Duration,
        program: &str,
        args: &[&str],
    ) -> Self {
        Self::with_shell_mode(tx, idle_limit, program, args, false)
    }

    #[cfg(all(unix, test))]
    fn with_shell_mode(
        tx: SyncSender<FromWorker>,
        idle_limit: Duration,
        program: &str,
        args: &[&str],
        multi: bool,
    ) -> Self {
        let mut registry = Self::new(tx, multi);
        registry.idle_limit = idle_limit;
        registry.shell = Some((
            program.to_string(),
            args.iter().map(|arg| (*arg).to_string()).collect(),
        ));
        registry
    }

    /// 2.4 relays never send a viewer id; ignore one if it appears. 2.5
    /// requires a valid one.
    fn normalize<'a>(&self, handshake: TermHandshake<'a>) -> TermHandshake<'a> {
        TermHandshake {
            viewer_id: if self.multi {
                handshake.viewer_id
            } else {
                None
            },
            ..handshake
        }
    }

    fn ids_ok(&self, handshake: &TermHandshake<'_>) -> bool {
        valid_id(handshake.terminal_id)
            && (!self.multi || handshake.viewer_id.is_some_and(valid_id))
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
        config: &Config,
        state_dir: Option<&Path>,
        handshake: TermHandshake<'_>,
    ) -> Vec<OutboundFrame> {
        let handshake = self.normalize(handshake);
        if self.sessions.contains_key(handshake.terminal_id) {
            return vec![*handshake_rejected(&handshake, REASON_ALREADY_OPEN)];
        }
        if !self.ids_ok(&handshake)
            || (self.multi
                && self
                    .pending
                    .contains_key(&pending_key(handshake.terminal_id, handshake.viewer_id)))
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
            let _ = (config, prepared);
            vec![*handshake_rejected(&handshake, REASON_UNSUPPORTED)]
        }
        #[cfg(unix)]
        {
            let cli_nonce = match fresh_nonce(&handshake) {
                Ok(nonce) => nonce,
                Err(frame) => return vec![*frame],
            };
            self.open_unix(startup, config, &handshake, prepared, cli_nonce, None)
        }
    }

    #[cfg(unix)]
    fn open_unix(
        &mut self,
        startup: &TerminalStartup,
        config: &Config,
        handshake: &TermHandshake<'_>,
        prepared: PreparedHandshake,
        cli_nonce: [u8; 16],
        approved_identity: Option<[u8; 65]>,
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        let viewer_id = handshake.viewer_id;
        if self.human_count() >= MAX_TERMINALS {
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
        let out = if self.multi {
            match OutputKey::first() {
                Ok(out) => Some(out),
                Err(error) => {
                    tracing::warn!(error = %error, terminal_id, "generating a terminal output key failed");
                    return vec![*handshake_rejected(handshake, REASON_SPAWN_FAILED)];
                }
            }
        } else {
            None
        };
        let env = terminal_env(config);
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
            multi: self.multi,
            viewers,
            // The opener is the first writer.
            writer: viewer_id.map(str::to_string),
            pty_size: (prepared.cols, prepared.rows),
            out,
            detached_at: None,
            scrollback: VecDeque::new(),
            pty: Some(pty),
            supervised: None,
        };
        let mut frames = vec![OutboundFrame::Control(ClientControlMessage::TermOpened {
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
        let handshake = self.normalize(handshake);
        let terminal_id = handshake.terminal_id;
        let Some(session) = self.sessions.get(terminal_id) else {
            return vec![*handshake_rejected(&handshake, REASON_NOT_FOUND)];
        };
        // A supervised terminal is gated by the MCP command policy, not by the
        // human terminal switch; approval still applies to every viewer.
        let allowed = if session.supervised.is_some() {
            startup.mcp_command_mode().allows_supervised()
        } else {
            startup.allow_human_terminal()
        };
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
        if !self.ids_ok(&handshake) {
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
        config: &Config,
        state_dir: Option<&Path>,
        terminal_id: &str,
        viewer_id: Option<&str>,
        signature: &str,
    ) -> Vec<OutboundFrame> {
        let viewer_id = if self.multi {
            let Some(viewer_id) = viewer_id else {
                return Vec::new();
            };
            Some(viewer_id)
        } else {
            None
        };
        let key = pending_key(terminal_id, viewer_id);
        let Some(pending) = self.pending.get(&key) else {
            return Vec::new();
        };
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
            let _ = config;
            vec![*handshake_rejected(&handshake, REASON_UNSUPPORTED)]
        }
        #[cfg(unix)]
        {
            self.open_unix(
                startup,
                config,
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
        let multi = self.multi;
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return vec![*handshake_rejected(handshake, REASON_NOT_FOUND)];
        };
        let viewer_key = viewer_id.unwrap_or(LEGACY_VIEWER);
        if multi {
            if session.viewers.contains_key(viewer_key) {
                return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
            }
        } else {
            // 2.4: attach replaces the single viewer.
            session.viewers.clear();
        }
        session.viewers.insert(
            viewer_key.to_string(),
            Viewer::new(keys, None, approved_identity),
        );
        session.detached_at = None;
        let mut frames = vec![OutboundFrame::Control(ClientControlMessage::TermAttached {
            terminal_id: terminal_id.to_string(),
            viewer_id: viewer_id.map(str::to_string),
            cli_nonce: terminal_crypto::encode_b64url(&cli_nonce),
        })];
        if multi {
            frames.extend(session.join_frames(terminal_id, viewer_key));
            frames.extend(session.supervised_join_frames(terminal_id, viewer_key));
        } else {
            let replay = session.scrollback.iter().copied().collect::<Vec<_>>();
            frames.extend(session.seal_legacy_data(terminal_id, &replay));
        }
        frames
    }

    /// 2.5: stop viewing (the tab's X, or the tab went away). A pending
    /// approval for that viewer is dropped too. 2.4: the single viewer leaves.
    pub(crate) fn detach(
        &mut self,
        terminal_id: &str,
        viewer_id: Option<&str>,
    ) -> Vec<OutboundFrame> {
        if !self.multi {
            if let Some(session) = self.sessions.get_mut(terminal_id)
                && !session.viewers.is_empty()
            {
                session.viewers.clear();
                session.detached_at = Some(Instant::now());
            }
            return Vec::new();
        }
        let Some(viewer_id) = viewer_id else {
            return Vec::new();
        };
        self.pending
            .remove(&pending_key(terminal_id, Some(viewer_id)));
        self.remove_viewer(terminal_id, viewer_id, None)
    }

    /// A malformed relay frame that names a viewer. 2.5 removes only that
    /// viewer (or its pending approval); 2.4 closes the terminal as before.
    pub(crate) fn drop_viewer(&mut self, terminal_id: &str, viewer_id: &str) -> Vec<OutboundFrame> {
        if !self.multi {
            return self.close(terminal_id);
        }
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

    pub(crate) fn close(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.remove(terminal_id) else {
            return Vec::new();
        };
        let recorded = session
            .supervised
            .as_ref()
            .map_or((None, None), |supervised| supervised.exit_status);
        #[cfg(unix)]
        let status = {
            let mut session = session;
            session.pty.take().map(shutdown_pty).unwrap_or(recorded)
        };
        #[cfg(not(unix))]
        let status = {
            drop(session);
            recorded
        };
        vec![term_exit(terminal_id, status)]
    }

    pub(crate) fn handle_sealed(
        &mut self,
        terminal_id: &str,
        viewer_id: Option<&str>,
        seq: u64,
        body: &[u8],
    ) -> Vec<OutboundFrame> {
        let viewer_key = if self.multi {
            let Some(viewer_id) = viewer_id else {
                tracing::warn!(terminal_id, "ignoring a sealed frame without a viewer id");
                return Vec::new();
            };
            viewer_id.to_string()
        } else {
            LEGACY_VIEWER.to_string()
        };
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
            Incoming::Write(bytes) => {
                // Type-ahead before a supervised confirm screen is drawn, and
                // input after its command exited, is dropped here for good.
                if !self
                    .sessions
                    .get(terminal_id)
                    .is_some_and(TerminalSession::accepts_input)
                {
                    return Vec::new();
                }
                let mut frames = Vec::new();
                if self.multi {
                    match self.claim_writer(terminal_id, &viewer_key) {
                        Ok(claimed) => frames.extend(claimed),
                        Err(_) => {
                            frames.extend(self.close(terminal_id));
                            return frames;
                        }
                    }
                }
                match self.enqueue_input(terminal_id, bytes) {
                    Ok(queued) => frames.extend(self.note_input(terminal_id, &viewer_key, queued)),
                    Err(_) => frames.extend(self.close(terminal_id)),
                }
                frames
            }
            Incoming::Resize { cols, rows } => {
                #[cfg(unix)]
                if self
                    .sessions
                    .get(terminal_id)
                    .is_some_and(|session| session.pty.is_none())
                {
                    // A finished supervised command has no PTY to resize.
                    return Vec::new();
                }
                if !self.multi {
                    return if self.resize_terminal(terminal_id, cols, rows).is_err() {
                        self.close(terminal_id)
                    } else {
                        Vec::new()
                    };
                }
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
            Incoming::ReviewToggle(on) => self.toggle_review(terminal_id, &viewer_key, on),
            Incoming::Ignore => Vec::new(),
            Incoming::Close => self.close(terminal_id),
            Incoming::DropViewer => {
                tracing::warn!(terminal_id, "removing a viewer after a bad terminal frame");
                self.remove_viewer(terminal_id, &viewer_key, Some(REASON_BAD_FRAME))
            }
        }
    }

    /// Any viewer may turn review on or off until the command exits. Every
    /// viewer hears the new state. On a human terminal the frame is invalid.
    fn toggle_review(
        &mut self,
        terminal_id: &str,
        viewer_key: &str,
        on: bool,
    ) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        let Some(supervised) = session.supervised.as_mut() else {
            tracing::warn!(
                terminal_id,
                "removing a viewer after a review frame on a human terminal"
            );
            return self.remove_viewer(terminal_id, viewer_key, Some(REASON_BAD_FRAME));
        };
        if !supervised.share_output
            || supervised.phase == SupervisedPhase::Finished
            || supervised.review == on
        {
            return Vec::new();
        }
        supervised.review = on;
        session
            .seal_broadcast(terminal_id, &TermPlaintextV2::ReviewState(on))
            .into_iter()
            .collect()
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
        Some(OutboundFrame::Control(
            ClientControlMessage::TermInputDropped {
                terminal_id: terminal_id.to_string(),
                viewer_id: wire_viewer(viewer_key).map(str::to_string),
            },
        ))
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
        Ok(session
            .seal_broadcast(terminal_id, &TermPlaintextV2::Resize { cols, rows })
            .into_iter()
            .collect())
    }

    #[cfg(unix)]
    pub(crate) fn on_bytes(&mut self, terminal_id: &str, bytes: &[u8]) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        if session.supervised.is_some() {
            return session.supervised_bytes(terminal_id, bytes);
        }
        // Scrollback is always recorded; output is sealed only for viewers.
        push_scrollback(&mut session.scrollback, bytes);
        if session.multi {
            session.broadcast_data(terminal_id, bytes)
        } else {
            session.seal_legacy_data(terminal_id, bytes)
        }
    }

    /// PTY EOF. A supervised terminal is finished only after its child is
    /// reaped, so the outcome and exit status are never lost.
    #[cfg(unix)]
    pub(crate) fn on_eof(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        let Some(supervised) = session.supervised.as_mut() else {
            return self.close(terminal_id);
        };
        supervised.child.eof = true;
        if session.pty.as_ref().is_some_and(|pty| pty.exited.is_some()) {
            return self.finish_supervised(terminal_id, Instant::now());
        }
        Vec::new()
    }

    pub(crate) fn poll(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let expired_pending = self
            .pending
            .iter()
            .filter(|(_, pending)| now.saturating_duration_since(pending.created) >= PENDING_TTL)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
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
        // Pending viewers do not keep a terminal alive. An unanswered confirm
        // screen and an unreviewed capture have their own deadlines.
        let expired = self
            .sessions
            .iter()
            .filter(|(_, session)| match session.supervised.as_ref() {
                Some(supervised) if supervised.awaiting() => {
                    now.saturating_duration_since(supervised.spawned_at) >= self.confirm_ttl
                }
                Some(supervised) if supervised.phase == SupervisedPhase::Finished => supervised
                    .finished_at
                    .is_some_and(|at| now.saturating_duration_since(at) >= self.review_ttl),
                _ => {
                    session.viewers.is_empty()
                        && session.detached_at.is_some_and(|detached| {
                            now.saturating_duration_since(detached) >= self.idle_limit
                        })
                }
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
            // A supervised command whose PTY already hit EOF has delivered
            // all of its output; it need not wait out the drain.
            let all_output = session
                .supervised
                .as_ref()
                .is_some_and(|supervised| supervised.child.eof);
            if pty.exited.is_some_and(|(_, _, at)| {
                all_output || now.saturating_duration_since(at) >= TERMINAL_OUTPUT_DRAIN
            }) {
                drained.push((terminal_id.clone(), session.supervised.is_some()));
            }
        }
        let mut frames = Vec::new();
        for (terminal_id, supervised) in drained {
            if supervised {
                frames.extend(self.finish_supervised(&terminal_id, now));
            } else {
                frames.extend(self.close(&terminal_id));
            }
        }
        frames
    }

    /// 2.5: a viewer whose approval was revoked leaves (and the key rotates).
    fn recheck_approvals(&mut self, now: Instant) -> Vec<OutboundFrame> {
        if !self.multi || self.next_approval_check.is_some_and(|next| now < next) {
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
fn terminal_env(config: &Config) -> Vec<(String, String)> {
    let mut env = scrub_parent_env(&denied_env_names(config));
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

struct ExecSession {
    child: Option<std::process::Child>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    started: Instant,
    stdout_seq: u64,
    stderr_seq: u64,
    stdout_done: bool,
    stderr_done: bool,
    timed_out: bool,
    finished: bool,
    pid: u32,
    /// Exit status and the instant `try_wait` reaped the direct child.
    reaped: Option<(Option<i32>, Option<i32>, Instant)>,
    _tracked: LiveChildGuard,
}

pub(crate) struct ExecRegistry {
    sessions: BTreeMap<String, ExecSession>,
    tx: SyncSender<FromWorker>,
    timeout: Duration,
    shut_down: bool,
}

impl ExecRegistry {
    pub(crate) fn new(tx: SyncSender<FromWorker>, timeout: Duration) -> Self {
        Self {
            sessions: BTreeMap::new(),
            tx,
            timeout,
            shut_down: false,
        }
    }

    pub(crate) fn kill_all(&mut self) -> Vec<OutboundFrame> {
        if self.shut_down {
            return Vec::new();
        }
        self.shut_down = true;
        let ids = self
            .sessions
            .iter()
            .map(|(id, session)| (id.clone(), session.timed_out))
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
        for (id, timed_out) in ids {
            frames.extend(self.finish(&id, true, timed_out));
        }
        frames
    }

    pub(crate) fn start(
        &mut self,
        startup: &TerminalStartup,
        config: &Config,
        command_id: &str,
        command: &str,
        cwd: Option<&str>,
    ) -> Vec<OutboundFrame> {
        if !valid_id(command_id) {
            return vec![exec_rejected(command_id, REASON_BAD_COMMAND)];
        }
        let mode = startup.mcp_command_mode();
        if !mode.allows_exec() {
            // `supervised` lets an agent act here only through a person
            // pressing Enter on a supervised terminal.
            let reason = if mode.allows_supervised() {
                REASON_SUPERVISED_ONLY
            } else {
                REASON_DISABLED
            };
            return vec![exec_rejected(command_id, reason)];
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
        match spawn_exec(&self.tx, command_id, command, &cwd, config) {
            Ok(session) => {
                self.sessions.insert(command_id.to_string(), session);
                vec![OutboundFrame::Control(ClientControlMessage::ExecStarted {
                    command_id: command_id.to_string(),
                })]
            }
            Err(error) => {
                tracing::warn!(error = %error, command_id, "starting an exec failed");
                vec![exec_rejected(command_id, REASON_SPAWN_FAILED)]
            }
        }
    }

    pub(crate) fn cancel(&mut self, command_id: &str) -> Vec<OutboundFrame> {
        self.finish(command_id, true, false)
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

    pub(crate) fn on_bytes(
        &mut self,
        command_id: &str,
        stderr: bool,
        bytes: &[u8],
    ) -> Vec<OutboundFrame> {
        if bytes.is_empty() {
            return Vec::new();
        }
        let Some(session) = self.sessions.get_mut(command_id) else {
            return Vec::new();
        };
        if session.finished {
            return Vec::new();
        }
        let seq = if stderr {
            session.stderr_seq = session.stderr_seq.saturating_add(1);
            session.stderr_seq
        } else {
            session.stdout_seq = session.stdout_seq.saturating_add(1);
            session.stdout_seq
        };
        let metadata = if stderr {
            RelayBinaryFrameMetadata::ExecStderr {
                command_id: command_id.to_string(),
                seq,
            }
        } else {
            RelayBinaryFrameMetadata::ExecStdout {
                command_id: command_id.to_string(),
                seq,
            }
        };
        vec![OutboundFrame::Binary(metadata, bytes.to_vec())]
    }

    pub(crate) fn on_eof(&mut self, command_id: &str, stderr: bool) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(command_id) else {
            return Vec::new();
        };
        if session.finished {
            return Vec::new();
        }
        if stderr {
            session.stderr_done = true;
        } else {
            session.stdout_done = true;
        }
        // Pipes can close while the process is still running (`sleep
        // >/dev/null`). Reaping happens on `poll` via `try_wait`.
        Vec::new()
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
                let timed_out = now.saturating_duration_since(session.started) >= self.timeout;
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
                    kill_exec(session.pid, None, false);
                    session.reaped = Some((parts.0, parts.1, now));
                }
                let Some((code, signal, reaped_at)) = session.reaped else {
                    continue;
                };
                let drained = session.stdout_done && session.stderr_done;
                let waited = now.saturating_duration_since(reaped_at) >= EXEC_OUTPUT_DRAIN;
                if drained || waited {
                    Some(((code, signal), session.timed_out))
                } else {
                    None
                }
            };
            if let Some((parts, timed_out)) = action {
                frames.extend(self.complete(&id, parts, timed_out));
            }
        }
        frames
    }

    fn finish(&mut self, command_id: &str, kill: bool, timed_out: bool) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(command_id) else {
            return Vec::new();
        };
        if session.finished {
            return Vec::new();
        }
        session.timed_out = timed_out || session.timed_out;
        session.stop.store(true, Ordering::SeqCst);
        if kill {
            kill_exec(session.pid, session.child.as_mut(), true);
        }
        let status = reap_child(session.child.as_mut());
        let timed_out = session.timed_out;
        self.complete(command_id, status, timed_out)
    }

    fn complete(
        &mut self,
        command_id: &str,
        status: (Option<i32>, Option<i32>),
        timed_out: bool,
    ) -> Vec<OutboundFrame> {
        let Some(mut session) = self.sessions.remove(command_id) else {
            return Vec::new();
        };
        session.finished = true;
        session.stop.store(true, Ordering::SeqCst);
        // Reader threads exit on their own. Joining them can block if a
        // grandchild that left the process group still holds a pipe.
        drop(session.stdout_thread.take());
        drop(session.stderr_thread.take());
        drop(session.child.take());
        vec![exec_done(
            command_id,
            status.0,
            status.1,
            timed_out || session.timed_out,
        )]
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

fn reap_child(child: Option<&mut std::process::Child>) -> (Option<i32>, Option<i32>) {
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

fn kill_exec(pid: u32, child: Option<&mut std::process::Child>, fallback_to_pid: bool) {
    #[cfg(unix)]
    {
        kill_process_group(pid, fallback_to_pid);
        let _ = child;
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, fallback_to_pid);
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

fn spawn_exec(
    tx: &SyncSender<FromWorker>,
    command_id: &str,
    command: &str,
    cwd: &Path,
    config: &Config,
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
    for (name, value) in scrub_parent_env(&denied_env_names(config)) {
        process.env(name, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = process.spawn()?;
    let pid = child.id();
    let tracked = LiveChildGuard::track(LiveChild::ExecGroup(pid));
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
    Ok(ExecSession {
        child: Some(child),
        stdout_thread: Some(stdout_thread),
        stderr_thread: Some(stderr_thread),
        stop,
        started: Instant::now(),
        stdout_seq: 0,
        stderr_seq: 0,
        stdout_done: false,
        stderr_done: false,
        timed_out: false,
        finished: false,
        pid,
        reaped: None,
        _tracked: tracked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::McpCommandMode;
    use crate::terminal_crypto::CliTerminalKey;

    fn channel() -> (SyncSender<FromWorker>, mpsc::Receiver<FromWorker>) {
        mpsc::sync_channel(64)
    }

    fn enabled_startup(approval: bool) -> TerminalStartup {
        let config = Config {
            allow_human_terminal: true,
            mcp_command_mode: McpCommandMode::Unsupervised,
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
    fn unsupported_or_disabled_terminals_are_rejected() {
        assert_eq!(
            terminal_block_reason(false, true, 0),
            Some(REASON_UNSUPPORTED)
        );
        assert_eq!(terminal_block_reason(true, false, 0), Some(REASON_DISABLED));
        assert_eq!(terminal_block_reason(true, true, 2), Some(REASON_LIMIT));
        assert_eq!(terminal_block_reason(true, true, 1), None);
        assert_eq!(terminal_supported(), cfg!(unix));
    }

    #[test]
    fn exec_rejects_size_nul_cwd_and_the_concurrency_cap() {
        let (tx, _rx) = channel();
        let mut execs = ExecRegistry::new(tx, DEFAULT_EXEC_TIMEOUT);
        let startup = enabled_startup(false);
        let config = Config::default();
        let rejected = execs.start(&startup, &config, "one", &"a".repeat(4097), None);
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(ClientControlMessage::ExecRejected { reason, .. })
                if reason == REASON_BAD_COMMAND
        ));
        let rejected = execs.start(&startup, &config, "two", "echo\0no", None);
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(ClientControlMessage::ExecRejected { reason, .. })
                if reason == REASON_BAD_COMMAND
        ));
        let rejected = execs.start(&startup, &config, "three", "echo ok", Some("relative"));
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(ClientControlMessage::ExecRejected { reason, .. })
                if reason == REASON_BAD_CWD
        ));
        assert!(execs.sessions.is_empty());

        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
        assert!(matches!(
            execs.start(&startup, &config, "a", slow_command(), None)[0],
            OutboundFrame::Control(ClientControlMessage::ExecStarted { .. })
        ));
        assert!(matches!(
            execs.start(&startup, &config, "b", slow_command(), None)[0],
            OutboundFrame::Control(ClientControlMessage::ExecStarted { .. })
        ));
        let rejected = execs.start(&startup, &config, "c", slow_command(), None);
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(ClientControlMessage::ExecRejected { reason, .. })
                if reason == REASON_LIMIT
        ));
        assert_eq!(execs.sessions.len(), 2);
        drop(execs);
        drop(rx);
    }

    #[test]
    fn exec_timeout_uses_the_injected_duration() {
        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_millis(200));
        let startup = enabled_startup(false);
        execs.start(&startup, &Config::default(), "slow", slow_command(), None);
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
                        let _ = execs.on_bytes(&command_id, stderr, &bytes);
                    }
                    FromWorker::ExecEof { command_id, stderr } => {
                        let _ = execs.on_eof(&command_id, stderr);
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
            OutboundFrame::Control(ClientControlMessage::ExecDone { timed_out, .. }) if *timed_out
        ));
        drop(execs);
        drop(rx);
    }

    #[test]
    fn dropping_the_exec_registry_reaps_the_child() {
        let (tx, rx) = channel();
        let pid = {
            let mut execs = ExecRegistry::new(tx, DEFAULT_EXEC_TIMEOUT);
            execs.start(
                &enabled_startup(false),
                &Config::default(),
                "sleep",
                slow_command(),
                None,
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
        let mut execs = ExecRegistry::new(tx, DEFAULT_EXEC_TIMEOUT);
        execs.start(
            &enabled_startup(false),
            &Config::default(),
            "group",
            &command,
            Some(dir.path().to_str().expect("utf8")),
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
            &Config::default(),
            None,
            TermHandshake {
                terminal_id: "term-1",
                viewer_id: None,
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(ClientControlMessage::TermOpened { .. })
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

    #[cfg(unix)]
    #[test]
    fn terminal_concurrency_cap_is_two() {
        let (tx, rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "sleep 30"],
        );
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[1_u8; 16]);
        for terminal_id in ["t1", "t2"] {
            let frames = terminals.open(
                &startup,
                &Config::default(),
                None,
                TermHandshake {
                    terminal_id,
                    viewer_id: None,
                    cols: 80,
                    rows: 24,
                    browser_public_key: browser.public_b64url(),
                    browser_nonce: &nonce,
                    identity: None,
                },
            );
            assert!(matches!(
                &frames[0],
                OutboundFrame::Control(ClientControlMessage::TermOpened { .. })
            ));
        }
        let rejected = terminals.open(
            &startup,
            &Config::default(),
            None,
            TermHandshake {
                terminal_id: "t3",
                viewer_id: None,
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        assert!(matches!(
            &rejected[0],
            OutboundFrame::Control(ClientControlMessage::TermRejected { reason, .. })
                if reason == REASON_LIMIT
        ));
        drop(terminals);
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn detached_terminal_closes_after_the_injected_idle_timeout() {
        let (tx, _rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_millis(200),
            "/bin/sh",
            &["-c", "sleep 30"],
        );
        let startup = enabled_startup(false);
        let browser = CliTerminalKey::generate().expect("browser");
        let nonce = terminal_crypto::encode_b64url(&[3_u8; 16]);
        terminals.open(
            &startup,
            &Config::default(),
            None,
            TermHandshake {
                terminal_id: "idle",
                viewer_id: None,
                cols: 40,
                rows: 12,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        terminals.detach("idle", None);
        std::thread::sleep(Duration::from_millis(250));
        let frames = terminals.poll(Instant::now());
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(ClientControlMessage::TermExit { terminal_id, .. })
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
            &Config::default(),
            Some(dir.path()),
            TermHandshake {
                terminal_id: "term-a",
                viewer_id: None,
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: Some(&identity_message),
            },
        );
        let (cli_nonce, code) = match &frames[0] {
            OutboundFrame::Control(ClientControlMessage::TermPending {
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
        let signature = terminal_crypto::sign_approval(
            &identity,
            "term-a",
            browser.public_raw(),
            &[4_u8; 16],
            startup.key().public_raw(),
            &cli_nonce_raw,
        )
        .expect("sign");
        let opened = terminals.auth(
            &startup,
            &Config::default(),
            Some(dir.path()),
            "term-a",
            None,
            &terminal_crypto::encode_b64url(&signature),
        );
        assert!(matches!(
            &opened[0],
            OutboundFrame::Control(ClientControlMessage::TermOpened { cli_nonce: opened_nonce, .. })
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
            &Config::default(),
            "sleep",
            command,
            None,
        );
        let pid = execs.pid("sleep").expect("pid");
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut stdout_done = false;
        let mut stderr_done = false;
        while Instant::now() < deadline && !(stdout_done && stderr_done) {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(FromWorker::ExecEof { stderr, .. }) => {
                    let started = Instant::now();
                    let frames = execs.on_eof("sleep", stderr);
                    assert!(
                        started.elapsed() < Duration::from_millis(500),
                        "eof handling blocked"
                    );
                    assert!(frames.is_empty());
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
            &Config::default(),
            "group",
            &command,
            Some(dir.path().to_str().expect("utf8")),
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
            if frames.iter().any(|frame| {
                matches!(
                    frame,
                    OutboundFrame::Control(ClientControlMessage::ExecDone { .. })
                )
            }) {
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
            &Config::default(),
            None,
            TermHandshake {
                terminal_id: "held",
                viewer_id: None,
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
            OutboundFrame::Control(ClientControlMessage::TermExit { .. })
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
        Review(bool),
        Capture(u64, Vec<u8>, Vec<u8>),
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
            self.tx_seq += 1;
            let keys = self.keys.as_ref().expect("bound");
            let plaintext = terminal_crypto::encode_plaintext_v2(message).expect("encode");
            let body = terminal_crypto::seal_v2(
                &keys.browser_to_cli,
                terminal_id,
                &self.id,
                DIR_BROWSER_TO_CLI,
                self.tx_seq,
                &plaintext,
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
                    RelayBinaryFrameMetadata::TermSealed {
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
                        TermPlaintextV2::ReviewState(on) => Seen::Review(on),
                        TermPlaintextV2::ReviewCapture { total, head, tail } => {
                            Seen::Capture(total, head, tail)
                        }
                        TermPlaintextV2::ReviewToggle(_) => {
                            panic!("the CLI never sends a review toggle")
                        }
                    },
                );
            }
            seen
        }
    }

    #[cfg(unix)]
    fn multi_registry(tx: SyncSender<FromWorker>) -> TerminalRegistry {
        TerminalRegistry::with_shell_mode(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "sleep 30"],
            true,
        )
    }

    #[cfg(unix)]
    fn cli_nonce_of(frames: &[OutboundFrame]) -> String {
        frames
            .iter()
            .find_map(|frame| match frame {
                OutboundFrame::Control(
                    ClientControlMessage::TermOpened { cli_nonce, .. }
                    | ClientControlMessage::TermAttached { cli_nonce, .. }
                    | ClientControlMessage::TermPending { cli_nonce, .. },
                ) => Some(cli_nonce.clone()),
                _ => None,
            })
            .expect("a handshake reply")
    }

    #[cfg(unix)]
    fn controls(frames: &[OutboundFrame]) -> Vec<&ClientControlMessage> {
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
                ClientControlMessage::TermWriter { viewer_id, .. } => Some(viewer_id.clone()),
                _ => None,
            })
            .collect()
    }

    #[cfg(unix)]
    fn rejection(frames: &[OutboundFrame]) -> Option<(Option<String>, String)> {
        controls(frames)
            .into_iter()
            .find_map(|message| match message {
                ClientControlMessage::TermRejected {
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
        let frames = terminals.open(
            startup,
            &Config::default(),
            None,
            viewer.handshake(MULTI_TERMINAL, 80, 24),
        );
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
            ClientControlMessage::TermOpened { viewer_id: Some(id), .. } if id == &a.id
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
            ClientControlMessage::TermAttached { viewer_id: Some(id), .. } if id == &b.id
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
            OutboundFrame::Control(ClientControlMessage::TermWriter { .. })
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
            RelayBinaryFrameMetadata::TermSealed {
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
        let (tx, _rx) = channel();
        let mut terminals = TerminalRegistry::with_shell_mode(
            tx,
            Duration::from_millis(200),
            "/bin/sh",
            &["-c", "sleep 30"],
            true,
        );
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
        std::thread::sleep(Duration::from_millis(250));
        assert!(terminals.poll(Instant::now()).is_empty());
        terminals.detach(MULTI_TERMINAL, Some(&viewers[0].id));
        std::thread::sleep(Duration::from_millis(250));
        let frames = terminals.poll(Instant::now());
        assert!(matches!(
            controls(&frames)[0],
            ClientControlMessage::TermExit { terminal_id, .. } if terminal_id == MULTI_TERMINAL
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
            &Config::default(),
            Some(dir.path()),
            TermHandshake {
                identity: Some(&identity_message),
                ..a.handshake(MULTI_TERMINAL, 80, 24)
            },
        );
        assert!(matches!(
            controls(&pending)[0],
            ClientControlMessage::TermPending { viewer_id: Some(id), .. } if id == &a.id
        ));
        let a_nonce = cli_nonce_of(&pending);
        let a_id = a.id.clone();
        let opened = terminals.auth(
            &startup,
            &Config::default(),
            Some(dir.path()),
            MULTI_TERMINAL,
            Some(&a_id),
            &sign(&a, &a_nonce),
        );
        assert!(matches!(
            controls(&opened)[0],
            ClientControlMessage::TermOpened { viewer_id: Some(id), .. } if id == &a.id
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
                ClientControlMessage::TermPending { viewer_id: Some(id), .. } if id == &viewer.id
            ));
            nonces.push(cli_nonce_of(&pending));
        }
        assert_eq!(terminals.pending.len(), 2);
        // B's signature does not verify for C: the transcript binds the viewer.
        let c_id = c.id.clone();
        let wrong = terminals.auth(
            &startup,
            &Config::default(),
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
            &Config::default(),
            Some(dir.path()),
            MULTI_TERMINAL,
            Some(&c_id),
            &sign(&c, &nonces[1]),
        );
        let b_id = b.id.clone();
        let attached_b = terminals.auth(
            &startup,
            &Config::default(),
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
                ClientControlMessage::TermAttached { viewer_id: Some(id), .. } if id == &viewer.id
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
                    ClientControlMessage::TermRejected { reason, .. }
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
    #[test]
    fn legacy_mode_sends_no_viewer_ids_writer_or_broadcast() {
        let (tx, _rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "sleep 30"],
        );
        let startup = enabled_startup(false);
        let a = TestViewer::new(1);
        // A viewer id from a 2.4 relay is ignored.
        let frames = terminals.open(
            &startup,
            &Config::default(),
            None,
            a.handshake(MULTI_TERMINAL, 80, 24),
        );
        assert_eq!(frames.len(), 1);
        assert!(matches!(
            controls(&frames)[0],
            ClientControlMessage::TermOpened {
                viewer_id: None,
                ..
            }
        ));
        let output = terminals.on_bytes(MULTI_TERMINAL, b"x");
        assert!(matches!(
            &output[0],
            OutboundFrame::Binary(
                RelayBinaryFrameMetadata::TermSealed {
                    viewer_id: None,
                    epoch: None,
                    ..
                },
                _
            )
        ));
        // Attach replaces the viewer without a writer message.
        let b = TestViewer::new(2);
        let frames = terminals.attach(&startup, None, b.handshake(MULTI_TERMINAL, 0, 0));
        assert!(matches!(
            controls(&frames)[0],
            ClientControlMessage::TermAttached {
                viewer_id: None,
                ..
            }
        ));
        assert!(writer_changes(&frames).is_empty());
        let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
        assert_eq!(session.viewers.len(), 1);
        assert!(session.out.is_none());
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
                ClientControlMessage::TermInputDropped { viewer_id, .. } => Some(viewer_id.clone()),
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
        let mut terminals = TerminalRegistry::with_shell_mode(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "stty raw -echo; sleep 30"],
            true,
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
        assert!(matches!(
            controls(&closed)[0],
            ClientControlMessage::TermExit { .. }
        ));
        drop(rx);
    }

    #[cfg(unix)]
    #[test]
    fn a_legacy_overflow_signals_without_a_viewer_id() {
        let (tx, _rx) = channel();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_secs(60),
            "/bin/sh",
            &["-c", "stty raw -echo; sleep 30"],
        );
        let startup = enabled_startup(false);
        let a = TestViewer::new(1);
        let frames = terminals.open(
            &startup,
            &Config::default(),
            None,
            TermHandshake {
                viewer_id: None,
                ..a.handshake(MULTI_TERMINAL, 80, 24)
            },
        );
        let ikm = a
            .browser
            .shared_x(startup.key().public_raw())
            .expect("ecdh");
        let cli_nonce = terminal_crypto::decode_nonce(&cli_nonce_of(&frames)).expect("nonce");
        let keys = terminal_crypto::derive_direction_keys_from_ikm(
            &ikm,
            startup.key().public_raw(),
            a.browser.public_raw(),
            &a.nonce,
            &cli_nonce,
            MULTI_TERMINAL,
        )
        .expect("keys");
        std::thread::sleep(Duration::from_millis(200));
        let plaintext =
            terminal_crypto::encode_plaintext(&TermPlaintext::Data(vec![b'y'; 16 * 1024]))
                .expect("plaintext");
        let mut out = Vec::new();
        for seq in 1..=128_u64 {
            let body = terminal_crypto::seal(
                &keys.browser_to_cli,
                MULTI_TERMINAL,
                DIR_BROWSER_TO_CLI,
                seq,
                &plaintext,
            )
            .expect("seal");
            out.extend(terminals.handle_sealed(MULTI_TERMINAL, None, seq, &body));
        }
        assert_eq!(input_drops(&out), vec![None]);
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
            &Config::default(),
            None,
            TermHandshake {
                terminal_id: "jobs",
                viewer_id: None,
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

    /// Dead or a zombie. Elsewhere than Linux a killed orphan is reaped by
    /// init, so plain existence is enough.
    #[cfg(unix)]
    fn process_gone(pid: u32) -> bool {
        #[cfg(target_os = "linux")]
        {
            !process_running(pid)
        }
        #[cfg(not(target_os = "linux"))]
        {
            !process_exists(pid)
        }
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
            &Config::default(),
            None,
            TermHandshake {
                terminal_id: "exited",
                viewer_id: None,
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        assert!(matches!(
            &opened[0],
            OutboundFrame::Control(ClientControlMessage::TermOpened { .. })
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
                    OutboundFrame::Control(ClientControlMessage::TermExit {
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
            &Config::default(),
            None,
            TermHandshake {
                terminal_id: "forced",
                viewer_id: None,
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
        let mut execs = ExecRegistry::new(tx, DEFAULT_EXEC_TIMEOUT);
        execs.start(
            &startup,
            &Config::default(),
            "forced",
            &format!("sleep 120 & echo $! > '{}'; wait", exec_file.display()),
            Some(dir.path().to_str().expect("utf8")),
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

    // Supervised (agent-requested) terminals.

    #[cfg(unix)]
    const SUPERVISED_COMMAND_ID: &str = "cmd-supervised-1";

    /// Stands in for `wsmp terminal supervised-run`: draws a screen, prints the
    /// ready marker, reads one line (canonical tty, so type-ahead would be
    /// read too), declines on `q`, else prints the accepted marker and "runs".
    #[cfg(unix)]
    /// A stand-in for `wsmp terminal supervised-run` with the same marker
    /// and `go` handshake: after Enter it prints `accepted` with echo off,
    /// then runs its "command" only once the daemon's `go` token arrives.
    #[cfg(unix)]
    fn fake_confirm(witness: Option<&Path>) -> String {
        let go_len = supervised_marker("go", "00112233445566778899aabbccddeeff").len();
        let touch = witness.map_or(String::new(), |path| {
            format!("touch '{}'\n", path.display())
        });
        format!(
            r#"sleep 0.4
printf 'SCREEN\n'
printf '\033]7717;wsmp-supervised;ready;%s\007' "$WSMP_SUPERVISED_MARKER"
IFS= read -r line
case "$line" in q*) printf 'Declined\n'; exit 0;; esac
printf 'got[%s]\n' "$line"
stty -echo -icanon min 1 time 0
printf '\033]7717;wsmp-supervised;accepted;%s\007' "$WSMP_SUPERVISED_MARKER"
go=$(head -c {go_len})
stty echo icanon
[ "$go" = "$(printf '\033]7717;wsmp-supervised;go;%s\007' "$WSMP_SUPERVISED_MARKER")" ] || exit 99
{touch}printf 'after-accept\n'
printf '\033]7717;wsmp-supervised;ready;%s\007' "$WSMP_SUPERVISED_MARKER"
exit 3
"#
        )
    }

    #[cfg(unix)]
    fn supervised_startup(mode: McpCommandMode, approval: bool) -> TerminalStartup {
        let config = Config {
            allow_human_terminal: false,
            mcp_command_mode: mode,
            require_terminal_approval: approval,
            ..Config::default()
        };
        TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config)
    }

    #[cfg(unix)]
    fn supervised_registry(tx: SyncSender<FromWorker>, script: &str) -> TerminalRegistry {
        let mut terminals = multi_registry(tx);
        terminals.supervised_program = Some((
            "/bin/sh".to_string(),
            vec!["-c".to_string(), script.to_string()],
        ));
        terminals
    }

    #[cfg(unix)]
    fn spawn_request(share_output: bool) -> SupervisedSpawn {
        SupervisedSpawn {
            terminal_id: MULTI_TERMINAL.to_string(),
            command_id: SUPERVISED_COMMAND_ID.to_string(),
            command: "make install".to_string(),
            cwd: None,
            reason: Some("needs your password".to_string()),
            requester: "test agent".to_string(),
            share_output,
        }
    }

    #[cfg(unix)]
    fn phase(terminals: &TerminalRegistry) -> Option<SupervisedPhase> {
        terminals
            .sessions
            .get(MULTI_TERMINAL)
            .and_then(|session| session.supervised.as_ref())
            .map(|supervised| supervised.phase)
    }

    /// Run the relay loop's worker and poll steps until `done` holds.
    #[cfg(unix)]
    fn pump_until(
        terminals: &mut TerminalRegistry,
        rx: &mpsc::Receiver<FromWorker>,
        frames: &mut Vec<OutboundFrame>,
        done: impl Fn(&TerminalRegistry, &[OutboundFrame]) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done(terminals, frames) {
            assert!(
                Instant::now() < deadline,
                "timed out waiting on the supervised terminal"
            );
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(FromWorker::TerminalBytes { terminal_id, bytes }) => {
                    frames.extend(terminals.on_bytes(&terminal_id, &bytes));
                }
                Ok(FromWorker::TerminalEof { terminal_id }) => {
                    frames.extend(terminals.on_eof(&terminal_id));
                }
                _ => {}
            }
            frames.extend(terminals.poll(Instant::now()));
        }
    }

    #[cfg(unix)]
    fn has_exit(_: &TerminalRegistry, frames: &[OutboundFrame]) -> bool {
        controls(frames)
            .iter()
            .any(|message| matches!(message, ClientControlMessage::TermExit { .. }))
    }

    #[cfg(unix)]
    fn seen_data(seen: &[Seen]) -> Vec<u8> {
        seen.iter()
            .filter_map(|item| match item {
                Seen::Data(bytes) => Some(bytes.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    #[cfg(unix)]
    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        supervised_pty::find_subslice(haystack, needle).is_some()
    }

    #[cfg(unix)]
    fn outcome_kinds(frames: &[OutboundFrame]) -> Vec<&'static str> {
        frames
            .iter()
            .filter_map(|frame| match frame {
                OutboundFrame::Control(ClientControlMessage::TermSpawned { .. }) => Some("spawned"),
                OutboundFrame::Control(ClientControlMessage::SupervisedAccepted { .. }) => {
                    Some("accepted")
                }
                OutboundFrame::Control(ClientControlMessage::SupervisedDeclined { .. }) => {
                    Some("declined")
                }
                OutboundFrame::Control(ClientControlMessage::SupervisedDone { .. }) => Some("done"),
                OutboundFrame::Control(ClientControlMessage::TermExit { .. }) => Some("exit"),
                OutboundFrame::Binary(
                    RelayBinaryFrameMetadata::SupervisedOutput { part, .. },
                    _,
                ) => Some(match part {
                    SupervisedOutputPart::Head => "head",
                    SupervisedOutputPart::Tail => "tail",
                }),
                _ => None,
            })
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn type_ahead_before_the_screen_is_dropped_and_enter_after_it_runs_and_shares() {
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(None));
        // No human terminal switch: supervised terminals do not need it.
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
        assert_eq!(outcome_kinds(&frames), vec!["spawned"]);
        assert_eq!(phase(&terminals), Some(SupervisedPhase::Starting));

        let mut a = TestViewer::new(1);
        let joined = attach_viewer(&mut terminals, &startup, &mut a);
        let mut seen = a.receive(MULTI_TERMINAL, &joined);
        assert!(seen.contains(&Seen::Review(false)), "{seen:?}");

        // Typed before the confirm screen was drawn: dropped, never queued.
        let label = a.id.clone();
        assert!(
            send(
                &mut terminals,
                &mut a,
                &label,
                &TermPlaintextV2::Data(b"early\r".to_vec())
            )
            .is_empty()
        );
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"ok\r".to_vec()),
        ));
        pump_until(&mut terminals, &rx, &mut frames, has_exit);

        assert_eq!(
            outcome_kinds(&frames),
            vec!["spawned", "accepted", "head", "done", "exit"]
        );
        seen.extend(a.receive(MULTI_TERMINAL, &frames));
        let shown = seen_data(&seen);
        assert!(contains(&shown, b"SCREEN"));
        assert!(
            contains(&shown, b"got[ok]"),
            "{}",
            String::from_utf8_lossy(&shown)
        );
        assert!(!contains(&shown, b"early"));
        // The markers before Enter never reach a viewer.
        let before_accept =
            &shown[..supervised_pty::find_subslice(&shown, b"after-accept").expect("output")];
        assert!(!contains(before_accept, b"wsmp-supervised"));

        let head = frames
            .iter()
            .find_map(|frame| match frame {
                OutboundFrame::Binary(RelayBinaryFrameMetadata::SupervisedOutput { .. }, body) => {
                    Some(body.clone())
                }
                _ => None,
            })
            .expect("head");
        assert!(contains(&head, b"after-accept"));
        assert!(!contains(&head, b"got["));
        assert!(!contains(&head, b"SCREEN"));
        // The spoofed marker the command printed after Enter is plain output.
        assert!(contains(&head, b"wsmp-supervised;ready"));
        let done = controls(&frames)
            .into_iter()
            .find_map(|message| match message {
                ClientControlMessage::SupervisedDone {
                    exit_code,
                    review,
                    output_bytes,
                    ..
                } => Some((*exit_code, *review, *output_bytes)),
                _ => None,
            })
            .expect("done");
        assert_eq!(done, (Some(3), false, Some(head.len() as u64)));
        assert!(terminals.sessions.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn declining_reports_declined_then_exit_and_runs_nothing() {
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(None));
        let startup = supervised_startup(McpCommandMode::Unsupervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
        let mut a = TestViewer::new(2);
        let _ = attach_viewer(&mut terminals, &startup, &mut a);
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        let label = a.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"q\r".to_vec()),
        ));
        pump_until(&mut terminals, &rx, &mut frames, has_exit);
        assert_eq!(outcome_kinds(&frames), vec!["spawned", "declined", "exit"]);
    }

    /// Raw PTY output of the supervised terminal, not yet handed to the
    /// registry, until `needle` shows up.
    #[cfg(unix)]
    fn hold_output_until(rx: &mpsc::Receiver<FromWorker>, needle: &[u8]) -> Vec<Vec<u8>> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut held = Vec::new();
        let mut seen = Vec::new();
        while !contains(&seen, needle) {
            assert!(Instant::now() < deadline, "timed out waiting for output");
            if let Ok(FromWorker::TerminalBytes { bytes, .. }) =
                rx.recv_timeout(Duration::from_millis(20))
            {
                seen.extend(&bytes);
                held.push(bytes);
            }
        }
        held
    }

    #[cfg(unix)]
    #[test]
    fn an_expiry_handled_before_the_enter_declines_and_the_command_never_starts() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let witness = tmp.path().join("ran");
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(Some(&witness)));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
        let mut a = TestViewer::new(9);
        let _ = attach_viewer(&mut terminals, &startup, &mut a);
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        let label = a.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"ok\r".to_vec()),
        ));
        // Enter was pressed and the child said so, but the expiry is handled
        // before the daemon reads that: the request is still waiting.
        let held = hold_output_until(&rx, b"wsmp-supervised;accepted;");
        let answer = terminals.cancel_supervised(SUPERVISED_COMMAND_ID, true);
        assert_eq!(outcome_kinds(&answer), vec!["declined", "exit"]);
        for bytes in held {
            assert!(terminals.on_bytes(MULTI_TERMINAL, &bytes).is_empty());
        }
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            !witness.exists(),
            "the command started without the daemon's go"
        );
        assert!(terminals.sessions.is_empty());
        // Nothing but the waiting request is answered: an unknown id is a no-op.
        assert!(terminals.cancel_supervised("cmd-unknown", true).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn an_enter_taken_before_the_expiry_keeps_running_to_its_end() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let witness = tmp.path().join("ran");
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(Some(&witness)));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
        let mut a = TestViewer::new(10);
        let _ = attach_viewer(&mut terminals, &startup, &mut a);
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        let label = a.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"ok\r".to_vec()),
        ));
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Running)
        });
        // The expiry arrives after the Enter was taken: it is not obeyed.
        assert!(
            terminals
                .cancel_supervised(SUPERVISED_COMMAND_ID, true)
                .is_empty()
        );
        pump_until(&mut terminals, &rx, &mut frames, has_exit);
        assert_eq!(
            outcome_kinds(&frames),
            vec!["spawned", "accepted", "head", "done", "exit"]
        );
        assert!(witness.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_browser_decline_after_the_enter_is_ignored_and_the_command_runs_to_its_end() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let witness = tmp.path().join("ran");
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(Some(&witness)));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
        let mut a = TestViewer::new(11);
        let _ = attach_viewer(&mut terminals, &startup, &mut a);
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        let label = a.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"ok\r".to_vec()),
        ));
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Running)
        });
        // The server's decline request, exactly as it arrives on the wire.
        let wire = format!(
            r#"{{"type":"supervised.cancel","commandId":"{SUPERVISED_COMMAND_ID}","reason":"decline"}}"#
        );
        let Ok(crate::protocol::ServerControlMessage::SupervisedCancel {
            command_id,
            if_waiting,
        }) = crate::protocol::parse_server_control(&wire)
        else {
            panic!("decline request did not parse");
        };
        assert!(if_waiting);
        // Enter came first: the decline is not obeyed.
        assert!(
            terminals
                .cancel_supervised(&command_id, if_waiting)
                .is_empty()
        );
        pump_until(&mut terminals, &rx, &mut frames, has_exit);
        assert_eq!(
            outcome_kinds(&frames),
            vec!["spawned", "accepted", "head", "done", "exit"]
        );
        assert!(witness.exists());
    }

    #[cfg(unix)]
    #[test]
    fn an_enter_whose_go_cannot_be_written_is_not_reported_as_a_decline() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let witness = tmp.path().join("ran");
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(Some(&witness)));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
        let mut a = TestViewer::new(12);
        let _ = attach_viewer(&mut terminals, &startup, &mut a);
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        let label = a.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"ok\r".to_vec()),
        ));
        let held = hold_output_until(&rx, b"wsmp-supervised;accepted;");
        // The PTY input fails before the daemon takes the accepted marker.
        terminals
            .sessions
            .get(MULTI_TERMINAL)
            .and_then(|session| session.pty.as_ref())
            .expect("pty")
            .input
            .fail();
        for bytes in held {
            let out = terminals.on_bytes(MULTI_TERMINAL, &bytes);
            assert!(!outcome_kinds(&out).contains(&"accepted"));
        }
        // A stop now ends the terminal without claiming anyone declined.
        let answer = terminals.cancel_supervised(SUPERVISED_COMMAND_ID, true);
        assert_eq!(outcome_kinds(&answer), vec!["exit"]);
        std::thread::sleep(Duration::from_millis(300));
        assert!(!witness.exists(), "the command started without go");
    }

    #[cfg(unix)]
    #[test]
    fn review_withholds_output_from_the_relay_and_hands_the_capture_to_viewers() {
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(None));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
        let mut a = TestViewer::new(3);
        let joined = attach_viewer(&mut terminals, &startup, &mut a);
        let _ = a.receive(MULTI_TERMINAL, &joined);
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        let label = a.id.clone();
        let toggled = send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::ReviewToggle(true),
        );
        assert_eq!(
            a.receive(MULTI_TERMINAL, &toggled),
            vec![Seen::Review(true)]
        );
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"ok\r".to_vec()),
        ));
        pump_until(&mut terminals, &rx, &mut frames, |_, frames| {
            outcome_kinds(frames).contains(&"done")
        });
        assert_eq!(outcome_kinds(&frames), vec!["spawned", "accepted", "done"]);
        assert!(controls(&frames).iter().any(|message| matches!(
            message,
            ClientControlMessage::SupervisedDone {
                review: true,
                output_bytes: None,
                ..
            }
        )));
        let capture = a
            .receive(MULTI_TERMINAL, &frames)
            .into_iter()
            .find_map(|item| match item {
                Seen::Capture(total, head, tail) => Some((total, head, tail)),
                _ => None,
            })
            .expect("capture for the attached viewer");
        assert!(contains(&capture.1, b"after-accept"));
        assert_eq!(capture.0, capture.1.len() as u64);
        assert!(capture.2.is_empty());
        assert_eq!(phase(&terminals), Some(SupervisedPhase::Finished));

        // Input after the command exited goes nowhere; a later viewer still
        // gets the review state and the capture.
        assert!(
            send(
                &mut terminals,
                &mut a,
                &label,
                &TermPlaintextV2::Data(b"x".to_vec())
            )
            .is_empty()
        );
        assert!(
            send(
                &mut terminals,
                &mut a,
                &label,
                &TermPlaintextV2::ReviewToggle(false)
            )
            .is_empty()
        );
        let mut b = TestViewer::new(4);
        let joined = attach_viewer(&mut terminals, &startup, &mut b);
        let seen = b.receive(MULTI_TERMINAL, &joined);
        assert!(seen.contains(&Seen::Review(true)), "{seen:?}");
        assert!(seen.iter().any(|item| matches!(item, Seen::Capture(..))));

        let ended = terminals.cancel_supervised(SUPERVISED_COMMAND_ID, false);
        assert_eq!(outcome_kinds(&ended), vec!["exit"]);
        assert!(controls(&ended).iter().any(|message| matches!(
            message,
            ClientControlMessage::TermExit {
                exit_code: Some(3),
                ..
            }
        )));
    }

    #[cfg(unix)]
    #[test]
    fn private_output_never_leaves_the_cli_and_review_cannot_be_toggled() {
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_confirm(None));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let mut frames =
            terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(false));
        let mut a = TestViewer::new(5);
        let joined = attach_viewer(&mut terminals, &startup, &mut a);
        let seen = a.receive(MULTI_TERMINAL, &joined);
        assert!(!seen.iter().any(|item| matches!(item, Seen::Review(_))));
        pump_until(&mut terminals, &rx, &mut frames, |terminals, _| {
            phase(terminals) == Some(SupervisedPhase::Confirm)
        });
        let label = a.id.clone();
        assert!(
            send(
                &mut terminals,
                &mut a,
                &label,
                &TermPlaintextV2::ReviewToggle(true)
            )
            .is_empty()
        );
        frames.extend(send(
            &mut terminals,
            &mut a,
            &label,
            &TermPlaintextV2::Data(b"ok\r".to_vec()),
        ));
        pump_until(&mut terminals, &rx, &mut frames, has_exit);
        assert_eq!(
            outcome_kinds(&frames),
            vec!["spawned", "accepted", "done", "exit"]
        );
        assert!(controls(&frames).iter().any(|message| matches!(
            message,
            ClientControlMessage::SupervisedDone {
                review: false,
                output_bytes: None,
                ..
            }
        )));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn supervised_spawn_refuses_a_cwd_the_confirm_screen_cannot_show_exactly() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let root = tempfile::tempdir().expect("tempdir");
        let bad = root.path().join(OsStr::from_bytes(b"a\xff"));
        std::fs::create_dir(&bad).expect("non-utf8 dir");
        // The agent's cwd is text, so a non-UTF-8 directory arrives through
        // a symlink (or the `$HOME` default / `~/` expansion); the check is
        // on the resolved physical path either way.
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&bad, &link).expect("symlink");
        let (tx, _rx) = channel();
        let mut terminals = supervised_registry(tx, "sleep 30");
        let supervised = supervised_startup(McpCommandMode::Supervised, false);
        let mut request = spawn_request(true);
        request.cwd = Some(link.to_str().expect("utf8 link").to_string());
        let frames = terminals.spawn_supervised(&supervised, &Config::default(), &request);
        assert_eq!(frames.len(), 1);
        assert!(matches!(
            controls(&frames)[0],
            ClientControlMessage::SupervisedRejected { reason, .. } if reason == REASON_CWD_NOT_UTF8
        ));
        assert!(terminals.sessions.is_empty());

        // A UTF-8 directory is accepted.
        let good = root.path().join("good");
        std::fs::create_dir(&good).expect("dir");
        request.cwd = Some(good.to_str().expect("utf8").to_string());
        let frames = terminals.spawn_supervised(&supervised, &Config::default(), &request);
        assert_eq!(outcome_kinds(&frames), vec!["spawned"]);
    }

    #[cfg(unix)]
    #[test]
    fn policy_gates_supervised_spawn_attach_and_exec() {
        let (tx, _rx) = channel();
        let mut terminals = supervised_registry(tx.clone(), "sleep 30");
        let off = supervised_startup(McpCommandMode::Off, false);
        let frames = terminals.spawn_supervised(&off, &Config::default(), &spawn_request(true));
        assert!(matches!(
            controls(&frames)[0],
            ClientControlMessage::SupervisedRejected { reason, .. } if reason == REASON_DISABLED
        ));
        assert!(terminals.sessions.is_empty());

        let supervised = supervised_startup(McpCommandMode::Supervised, false);
        let frames =
            terminals.spawn_supervised(&supervised, &Config::default(), &spawn_request(true));
        assert_eq!(outcome_kinds(&frames), vec!["spawned"]);
        // One request waiting for Enter per CLI.
        let mut second = spawn_request(true);
        second.terminal_id = "term-supervised-2".to_string();
        second.command_id = "cmd-supervised-2".to_string();
        assert!(matches!(
            controls(&terminals.spawn_supervised(&supervised, &Config::default(), &second))[0],
            ClientControlMessage::SupervisedRejected { reason, .. } if reason == REASON_LIMIT
        ));
        // With the policy off, a viewer cannot attach to it.
        let mut a = TestViewer::new(6);
        let refused = terminals.attach(&off, None, a.handshake(MULTI_TERMINAL, 0, 0));
        assert_eq!(
            rejection(&refused),
            Some((Some(a.id.clone()), REASON_DISABLED.to_string()))
        );
        // Approval still applies to supervised terminals.
        let approval = supervised_startup(McpCommandMode::Supervised, true);
        let identity = TerminalIdentity {
            public_key: CliTerminalKey::generate()
                .expect("id")
                .public_b64url()
                .to_string(),
            signature: None,
        };
        let mut handshake = a.handshake(MULTI_TERMINAL, 0, 0);
        handshake.identity = Some(&identity);
        let pending = terminals.attach(&approval, None, handshake);
        assert!(matches!(
            controls(&pending)[0],
            ClientControlMessage::TermPending { .. }
        ));
        let _ = &mut a;

        // The supervised terminal does not take a human terminal slot.
        let human = enabled_startup(false);
        for tag in [7, 8] {
            let viewer = TestViewer::new(tag);
            let id = format!("term-human-{tag}");
            let frames = terminals.open(
                &human,
                &Config::default(),
                None,
                viewer.handshake(&id, 80, 24),
            );
            assert!(
                matches!(
                    controls(&frames)[0],
                    ClientControlMessage::TermOpened { .. }
                ),
                "human terminal {tag} was refused"
            );
        }

        let mut execs = ExecRegistry::new(tx, DEFAULT_EXEC_TIMEOUT);
        let frames = execs.start(&supervised, &Config::default(), "cmd-exec-1", "true", None);
        assert!(matches!(
            controls(&frames)[0],
            ClientControlMessage::ExecRejected { reason, .. } if reason == REASON_SUPERVISED_ONLY
        ));
        let frames = execs.start(&off, &Config::default(), "cmd-exec-2", "true", None);
        assert!(matches!(
            controls(&frames)[0],
            ClientControlMessage::ExecRejected { reason, .. } if reason == REASON_DISABLED
        ));
        let _ = terminals.kill_all();
    }
}
