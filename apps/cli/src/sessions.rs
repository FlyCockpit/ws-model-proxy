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
//! Every live Unix exec group and PTY session is also recorded in a global
//! list, so a forced shutdown (`crate::shutdown`) can kill them from another
//! thread with [`kill_tracked_children`] when the relay thread is stuck.
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
#[cfg(unix)]
use std::sync::{Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::approvals::{approved_public_key, record_pending};
use crate::child_env::{self, scrub_parent_env};
use crate::config::Config;
use crate::protocol::{
    ClientControlMessage, RelayBinaryFrameMetadata, TerminalIdentity, terminal_supported,
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
    // The shell was spawned with `setsid`, so its session id is its pid. It
    // is our unreaped child here, so the pid cannot have been reused. A
    // zombie leader can fail `getsid` on some platforms; its session members
    // are still confirmed one by one below.
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
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveChild {
    /// An exec shell: the leader of its own process group.
    ExecGroup(u32),
    /// A PTY shell: the leader of its own session.
    PtySession(u32),
}

#[cfg(unix)]
static LIVE_CHILDREN: Mutex<BTreeMap<u64, LiveChild>> = Mutex::new(BTreeMap::new());
#[cfg(unix)]
static NEXT_LIVE_CHILD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Removes its child from [`LIVE_CHILDREN`] when the session that owns the
/// child is dropped.
#[cfg(unix)]
struct LiveChildGuard(u64);

#[cfg(unix)]
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

#[cfg(unix)]
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
    #[cfg(unix)]
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
            LiveChild::ExecGroup(pid) => kill_process_group(pid, false),
            LiveChild::PtySession(pid) => {
                kill_session(pid);
                kill_process_group(pid, false);
            }
        }
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
    /// Dropped after `shutdown_pty` has killed and reaped the session.
    _tracked: Option<LiveChildGuard>,
}

#[cfg(unix)]
fn shutdown_pty(mut runtime: PtyRuntime) -> (Option<i32>, Option<i32>) {
    runtime.stop.store(true, Ordering::SeqCst);
    runtime.input.close();
    if let Some(pid) = runtime.pid {
        kill_session(pid);
        kill_process_group(pid, true);
    }
    // The reader and writer notice `stop` within their poll timeout. Joining
    // either would block: the reader while a background job still holds the
    // slave, the writer while the PTY input buffer is full.
    drop(runtime.writer.take());
    drop(runtime.reader.take());
    let status = reap_after_signal(runtime.pid);
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
}

impl TerminalSession {
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
            // A browser never sends an output key.
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
        }
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
        let prepared = match prepare_handshake(startup, self.sessions.len(), &handshake) {
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
        if self.sessions.len() >= MAX_TERMINALS {
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
        if !startup.allow_human_terminal() || !terminal_supported() {
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
        #[cfg(unix)]
        let (exit_code, signal) = {
            let mut session = session;
            session.pty.take().map(shutdown_pty).unwrap_or((None, None))
        };
        #[cfg(not(unix))]
        let (exit_code, signal) = {
            drop(session);
            (None, None)
        };
        vec![OutboundFrame::Control(ClientControlMessage::TermExit {
            terminal_id: terminal_id.to_string(),
            exit_code,
            signal: signal_token(signal),
        })]
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
            Incoming::Ignore => Vec::new(),
            Incoming::Close => self.close(terminal_id),
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
        // Scrollback is always recorded; output is sealed only for viewers.
        push_scrollback(&mut session.scrollback, bytes);
        if session.multi {
            session.broadcast_data(terminal_id, bytes)
        } else {
            session.seal_legacy_data(terminal_id, bytes)
        }
    }

    #[cfg(unix)]
    pub(crate) fn on_eof(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        self.close(terminal_id)
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
        // Pending viewers do not keep a terminal alive.
        let expired = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.viewers.is_empty()
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
    #[cfg(unix)]
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
        if !startup.allow_mcp_commands() {
            return vec![exec_rejected(command_id, REASON_DISABLED)];
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
    #[cfg(unix)]
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
        #[cfg(unix)]
        _tracked: tracked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_crypto::CliTerminalKey;

    fn channel() -> (SyncSender<FromWorker>, mpsc::Receiver<FromWorker>) {
        mpsc::sync_channel(64)
    }

    fn enabled_startup(approval: bool) -> TerminalStartup {
        let config = Config {
            allow_human_terminal: true,
            allow_mcp_commands: true,
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
            started.elapsed() < Duration::from_secs(2),
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
            started.elapsed() < Duration::from_secs(1),
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
        match rx.recv_timeout(Duration::from_secs(2)) {
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
}
