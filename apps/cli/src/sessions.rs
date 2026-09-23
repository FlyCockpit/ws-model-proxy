//! Terminal and exec sessions multiplexed on one relay connection.
//!
//! Output readers send through [`FromWorker`] on the shared `sync_channel(64)`.
//! Dropping a registry kills every child. `kill_all` is safe to call first; the
//! later drop is a no-op.
//!
//! Unix children are process-group leaders (`setsid` for a PTY, `process_group(0)`
//! for exec) and are stopped with `SIGKILL` to the group. Windows has no
//! process-group kill: only the direct child is terminated, so grandchildren of
//! an exec may survive.

use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
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
    self, DIR_BROWSER_TO_CLI, DIR_CLI_TO_BROWSER, DirectionKeys, TermPlaintext,
};

const MAX_TERMINALS: usize = 2;
const MAX_EXECS: usize = 2;
const SCROLLBACK_LIMIT: usize = 256 * 1024;
const READ_CHUNK: usize = 8 * 1024;
const SEAL_CHUNK: usize = 16 * 1024;
const DEFAULT_IDLE: Duration = Duration::from_secs(15 * 60);
pub(crate) const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PENDING_TTL: Duration = Duration::from_secs(2 * 60);
const SEND_WAIT: Duration = Duration::from_millis(200);
const READ_POLL: Duration = Duration::from_millis(200);

const REASON_DISABLED: &str = "disabled";
const REASON_UNSUPPORTED: &str = "unsupported";
const REASON_LIMIT: &str = "limit";
const REASON_APPROVAL_REQUIRED: &str = "approval_required";
const REASON_BAD_SIGNATURE: &str = "bad_signature";
const REASON_BAD_COMMAND: &str = "bad_command";
const REASON_BAD_CWD: &str = "bad_cwd";
const REASON_NOT_FOUND: &str = "not_found";
const REASON_ALREADY_OPEN: &str = "already_open";
const REASON_SPAWN_FAILED: &str = "spawn_failed";
const REASON_BAD_HANDSHAKE: &str = "bad_handshake";
const REASON_EXPIRED: &str = "expired";

pub(crate) enum OutboundFrame {
    Control(ClientControlMessage),
    Binary(RelayBinaryFrameMetadata, Vec<u8>),
}

pub(crate) struct TermHandshake<'a> {
    pub terminal_id: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub browser_public_key: &'a str,
    pub browser_nonce: &'a str,
    pub identity: Option<&'a TerminalIdentity>,
}

struct LiveCrypto {
    keys: DirectionKeys,
    last_rx: u64,
    next_tx: u64,
}

enum Incoming {
    Write(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Undecryptable or out-of-order sealed frames are dropped.
    Ignore,
    Close,
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

fn approval_signature_ok(
    identity_raw: &[u8; 65],
    signature: &str,
    terminal_id: &str,
    browser_public: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> bool {
    let Ok(signature) = terminal_crypto::decode_exact(signature, 64) else {
        return false;
    };
    terminal_crypto::verify_approval_signature(
        identity_raw,
        &signature,
        terminal_id,
        browser_public,
        browser_nonce,
        cli_public,
        cli_nonce,
    )
}

struct PreparedHandshake {
    cols: u16,
    rows: u16,
    browser_public: [u8; 65],
    browser_nonce: [u8; 16],
}

fn fresh_nonce(terminal_id: &str) -> Result<[u8; 16], Box<OutboundFrame>> {
    match terminal_crypto::random_nonce() {
        Ok(nonce) => Ok(nonce),
        Err(error) => {
            tracing::warn!(error = %error, terminal_id, "generating a terminal nonce failed");
            Err(Box::new(term_rejected(
                terminal_id,
                REASON_SPAWN_FAILED,
                None,
            )))
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
        return Err(Box::new(term_rejected(
            handshake.terminal_id,
            REASON_BAD_HANDSHAKE,
            None,
        )));
    } else {
        (handshake.cols, handshake.rows)
    };
    let browser_public = match terminal_crypto::decode_public_key(handshake.browser_public_key) {
        Ok(raw) => raw,
        Err(_) => {
            return Err(Box::new(term_rejected(
                handshake.terminal_id,
                REASON_BAD_HANDSHAKE,
                None,
            )));
        }
    };
    let browser_nonce = match terminal_crypto::decode_nonce(handshake.browser_nonce) {
        Ok(raw) => raw,
        Err(_) => {
            return Err(Box::new(term_rejected(
                handshake.terminal_id,
                REASON_BAD_HANDSHAKE,
                None,
            )));
        }
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
    _attach: bool,
) -> Result<PreparedHandshake, Box<OutboundFrame>> {
    let terminal_id = handshake.terminal_id;
    if !valid_id(terminal_id) {
        return Err(Box::new(term_rejected(
            terminal_id,
            REASON_BAD_HANDSHAKE,
            None,
        )));
    }
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
        return Err(Box::new(term_rejected(terminal_id, reason, None)));
    }
    decode_browser_handshake(handshake)
}

fn term_pending(
    terminal_id: &str,
    cli_nonce: &str,
    approval_code: Option<String>,
) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::TermPending {
        terminal_id: terminal_id.to_string(),
        cli_nonce: cli_nonce.to_string(),
        approval_code,
    })
}

fn term_rejected(terminal_id: &str, reason: &str, approval_code: Option<String>) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::TermRejected {
        terminal_id: terminal_id.to_string(),
        reason: reason.to_string(),
        approval_code,
    })
}

fn exec_rejected(command_id: &str, reason: &str) -> OutboundFrame {
    OutboundFrame::Control(ClientControlMessage::ExecRejected {
        command_id: command_id.to_string(),
        reason: reason.to_string(),
    })
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
        signal,
        timed_out,
    })
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    if raw <= 1 {
        return;
    }
    let id = nix::unistd::Pid::from_raw(raw);
    if nix::sys::signal::killpg(id, nix::sys::signal::Signal::SIGKILL).is_err() {
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

#[cfg(unix)]
struct PtyRuntime {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    pid: Option<u32>,
}

#[cfg(unix)]
fn shutdown_pty(mut runtime: PtyRuntime) -> (Option<i32>, Option<i32>) {
    runtime.stop.store(true, Ordering::SeqCst);
    if let Some(pid) = runtime.pid {
        kill_process_group(pid);
    }
    drop(runtime.writer);
    // The reader notices `stop` on its poll timeout. Joining it would block
    // while a background job still holds the slave.
    drop(runtime.reader.take());
    let status = reap_after_signal(runtime.pid);
    drop(runtime.child);
    drop(runtime.master);
    status
}

struct TerminalSession {
    attached: bool,
    detached_at: Option<Instant>,
    scrollback: VecDeque<u8>,
    crypto: Option<LiveCrypto>,
    #[cfg(unix)]
    pty: Option<PtyRuntime>,
}

impl TerminalSession {
    fn seal_data(&mut self, terminal_id: &str, data: &[u8]) -> Vec<OutboundFrame> {
        let Some(crypto) = self.crypto.as_mut() else {
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
            let seq = crypto.next_tx;
            crypto.next_tx = crypto.next_tx.saturating_add(1);
            match terminal_crypto::seal(
                &crypto.keys.cli_to_browser,
                terminal_id,
                DIR_CLI_TO_BROWSER,
                seq,
                &plaintext,
            ) {
                Ok(body) => frames.push(OutboundFrame::Binary(
                    RelayBinaryFrameMetadata::TermSealed {
                        terminal_id: terminal_id.to_string(),
                        seq,
                    },
                    body,
                )),
                Err(error) => {
                    tracing::warn!(error = %error, terminal_id, "sealing terminal output failed");
                    break;
                }
            }
        }
        frames
    }

    fn decode_incoming(&mut self, terminal_id: &str, seq: u64, body: &[u8]) -> Incoming {
        let Some(crypto) = self.crypto.as_mut() else {
            return Incoming::Ignore;
        };
        if !terminal_crypto::accept_seq(&mut crypto.last_rx, seq) {
            return Incoming::Ignore;
        }
        let opened = terminal_crypto::open(
            &crypto.keys.browser_to_cli,
            terminal_id,
            DIR_BROWSER_TO_CLI,
            seq,
            body,
        );
        let Ok(plaintext) = opened else {
            return Incoming::Ignore;
        };
        match terminal_crypto::decode_plaintext(&plaintext) {
            Ok(TermPlaintext::Data(bytes)) => Incoming::Write(bytes),
            Ok(TermPlaintext::Resize { cols, rows }) => Incoming::Resize { cols, rows },
            Err(_) => Incoming::Close,
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

pub(crate) struct TerminalRegistry {
    sessions: BTreeMap<String, TerminalSession>,
    pending: BTreeMap<String, PendingTerminal>,
    tx: SyncSender<FromWorker>,
    idle_limit: Duration,
    shut_down: bool,
    #[cfg(unix)]
    shell: Option<(String, Vec<String>)>,
}

impl TerminalRegistry {
    pub(crate) fn new(tx: SyncSender<FromWorker>) -> Self {
        Self {
            sessions: BTreeMap::new(),
            pending: BTreeMap::new(),
            tx,
            idle_limit: DEFAULT_IDLE,
            shut_down: false,
            #[cfg(unix)]
            shell: None,
        }
    }

    #[cfg(all(unix, test))]
    fn with_shell(
        tx: SyncSender<FromWorker>,
        idle_limit: Duration,
        program: &str,
        args: &[&str],
    ) -> Self {
        Self {
            sessions: BTreeMap::new(),
            pending: BTreeMap::new(),
            tx,
            idle_limit,
            shut_down: false,
            shell: Some((
                program.to_string(),
                args.iter().map(|arg| (*arg).to_string()).collect(),
            )),
        }
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
        if self.sessions.contains_key(handshake.terminal_id) {
            return vec![term_rejected(
                handshake.terminal_id,
                REASON_ALREADY_OPEN,
                None,
            )];
        }
        let prepared = match prepare_handshake(startup, self.sessions.len(), &handshake, false) {
            Ok(prepared) => prepared,
            Err(reject) => return vec![*reject],
        };
        if startup.require_terminal_approval() {
            return self.queue_pending(state_dir, &handshake, prepared, false);
        }
        #[cfg(not(unix))]
        {
            let _ = (config, prepared);
            return vec![term_rejected(
                handshake.terminal_id,
                REASON_UNSUPPORTED,
                None,
            )];
        }
        #[cfg(unix)]
        {
            let cli_nonce = match fresh_nonce(handshake.terminal_id) {
                Ok(nonce) => nonce,
                Err(frame) => return vec![*frame],
            };
            self.open_unix(startup, config, &handshake, prepared, cli_nonce)
        }
    }

    #[cfg(unix)]
    #[allow(clippy::too_many_arguments)]
    fn open_unix(
        &mut self,
        startup: &TerminalStartup,
        config: &Config,
        handshake: &TermHandshake<'_>,
        prepared: PreparedHandshake,
        cli_nonce: [u8; 16],
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        if self.sessions.len() >= MAX_TERMINALS {
            return vec![term_rejected(terminal_id, REASON_LIMIT, None)];
        }
        let home = match user_home() {
            Ok(path) => path,
            Err(_) => return vec![term_rejected(terminal_id, REASON_BAD_CWD, None)],
        };
        let cwd = match child_env::resolve_cwd(None, &home) {
            Ok(path) => path,
            Err(_) => return vec![term_rejected(terminal_id, REASON_BAD_CWD, None)],
        };
        let keys = match terminal_crypto::derive_direction_keys(
            startup.key(),
            &prepared.browser_public,
            &prepared.browser_nonce,
            &cli_nonce,
            terminal_id,
        ) {
            Ok(keys) => keys,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "deriving terminal keys failed");
                return vec![term_rejected(terminal_id, REASON_BAD_HANDSHAKE, None)];
            }
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
                return vec![term_rejected(terminal_id, REASON_SPAWN_FAILED, None)];
            }
        };
        self.sessions.insert(
            terminal_id.to_string(),
            TerminalSession {
                attached: true,
                detached_at: None,
                scrollback: VecDeque::new(),
                crypto: Some(LiveCrypto {
                    keys,
                    last_rx: 0,
                    next_tx: 1,
                }),
                pty: Some(pty),
            },
        );
        vec![OutboundFrame::Control(ClientControlMessage::TermOpened {
            terminal_id: terminal_id.to_string(),
            cli_nonce: terminal_crypto::encode_b64url(&cli_nonce),
        })]
    }

    pub(crate) fn attach(
        &mut self,
        startup: &TerminalStartup,
        state_dir: Option<&Path>,
        handshake: TermHandshake<'_>,
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        if !self.sessions.contains_key(terminal_id) {
            return vec![term_rejected(terminal_id, REASON_NOT_FOUND, None)];
        }
        if !startup.allow_human_terminal() || !terminal_supported() {
            return vec![term_rejected(
                terminal_id,
                if terminal_supported() {
                    REASON_DISABLED
                } else {
                    REASON_UNSUPPORTED
                },
                None,
            )];
        }
        let prepared = match decode_browser_handshake(&handshake) {
            Ok(prepared) => prepared,
            Err(frame) => return vec![*frame],
        };
        if startup.require_terminal_approval() {
            // Leave the current viewer attached until `term.auth` succeeds.
            return self.queue_pending(state_dir, &handshake, prepared, true);
        }
        let cli_nonce = match fresh_nonce(terminal_id) {
            Ok(nonce) => nonce,
            Err(frame) => return vec![*frame],
        };
        self.finish_attach(startup, terminal_id, &prepared, cli_nonce)
    }

    pub(crate) fn auth(
        &mut self,
        startup: &TerminalStartup,
        config: &Config,
        state_dir: Option<&Path>,
        terminal_id: &str,
        signature: &str,
    ) -> Vec<OutboundFrame> {
        let Some(pending) = self.pending.get(terminal_id) else {
            return Vec::new();
        };
        if !approval_signature_ok(
            &pending.identity,
            signature,
            terminal_id,
            &pending.browser_public,
            &pending.browser_nonce,
            startup.key().public_raw(),
            &pending.cli_nonce,
        ) {
            self.pending.remove(terminal_id);
            return vec![term_rejected(terminal_id, REASON_BAD_SIGNATURE, None)];
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
                REASON_APPROVAL_REQUIRED,
                Some(code),
            )];
        }
        let pending = self.pending.remove(terminal_id).expect("pending");
        let prepared = PreparedHandshake {
            cols: pending.cols,
            rows: pending.rows,
            browser_public: pending.browser_public,
            browser_nonce: pending.browser_nonce,
        };
        if pending.attach {
            if !self.sessions.contains_key(terminal_id) {
                return vec![term_rejected(terminal_id, REASON_NOT_FOUND, None)];
            }
            return self.finish_attach(startup, terminal_id, &prepared, pending.cli_nonce);
        }
        #[cfg(not(unix))]
        {
            let _ = config;
            return vec![term_rejected(terminal_id, REASON_UNSUPPORTED, None)];
        }
        #[cfg(unix)]
        {
            let handshake = TermHandshake {
                terminal_id,
                cols: prepared.cols,
                rows: prepared.rows,
                browser_public_key: "",
                browser_nonce: "",
                identity: None,
            };
            self.open_unix(startup, config, &handshake, prepared, pending.cli_nonce)
        }
    }

    fn queue_pending(
        &mut self,
        state_dir: Option<&Path>,
        handshake: &TermHandshake<'_>,
        prepared: PreparedHandshake,
        attach: bool,
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        let identity = match identity_public(handshake.identity) {
            Ok(raw) => raw,
            Err(reason) => return vec![term_rejected(terminal_id, reason, None)],
        };
        let approval_code = approval_code_for_identity(state_dir, &identity);
        let cli_nonce = match fresh_nonce(terminal_id) {
            Ok(nonce) => nonce,
            Err(frame) => return vec![*frame],
        };
        self.pending.insert(
            terminal_id.to_string(),
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
            terminal_id,
            &terminal_crypto::encode_b64url(&cli_nonce),
            approval_code,
        )]
    }

    fn finish_attach(
        &mut self,
        startup: &TerminalStartup,
        terminal_id: &str,
        prepared: &PreparedHandshake,
        cli_nonce: [u8; 16],
    ) -> Vec<OutboundFrame> {
        let keys = match terminal_crypto::derive_direction_keys(
            startup.key(),
            &prepared.browser_public,
            &prepared.browser_nonce,
            &cli_nonce,
            terminal_id,
        ) {
            Ok(keys) => keys,
            Err(_) => return vec![term_rejected(terminal_id, REASON_BAD_HANDSHAKE, None)],
        };
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return vec![term_rejected(terminal_id, REASON_NOT_FOUND, None)];
        };
        session.crypto = Some(LiveCrypto {
            keys,
            last_rx: 0,
            next_tx: 1,
        });
        session.attached = true;
        session.detached_at = None;
        let replay = session.scrollback.iter().copied().collect::<Vec<_>>();
        let mut frames = vec![OutboundFrame::Control(ClientControlMessage::TermAttached {
            terminal_id: terminal_id.to_string(),
            cli_nonce: terminal_crypto::encode_b64url(&cli_nonce),
        })];
        frames.extend(session.seal_data(terminal_id, &replay));
        frames
    }

    pub(crate) fn detach(&mut self, terminal_id: &str) {
        if let Some(session) = self.sessions.get_mut(terminal_id)
            && session.attached
        {
            session.attached = false;
            session.detached_at = Some(Instant::now());
        }
    }

    pub(crate) fn close(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        let Some(mut session) = self.sessions.remove(terminal_id) else {
            return Vec::new();
        };
        #[cfg(unix)]
        let (exit_code, signal) = session.pty.take().map(shutdown_pty).unwrap_or((None, None));
        #[cfg(not(unix))]
        let (exit_code, signal) = (None, None);
        let _ = session;
        vec![OutboundFrame::Control(ClientControlMessage::TermExit {
            terminal_id: terminal_id.to_string(),
            exit_code,
            signal,
        })]
    }

    pub(crate) fn handle_sealed(
        &mut self,
        terminal_id: &str,
        seq: u64,
        body: &[u8],
    ) -> Vec<OutboundFrame> {
        let action = {
            let Some(session) = self.sessions.get_mut(terminal_id) else {
                tracing::warn!(
                    terminal_id,
                    "ignoring a sealed frame for an unknown terminal"
                );
                return Vec::new();
            };
            session.decode_incoming(terminal_id, seq, body)
        };
        match action {
            Incoming::Write(bytes) => {
                if self.write_terminal(terminal_id, &bytes).is_err() {
                    self.close(terminal_id)
                } else {
                    Vec::new()
                }
            }
            Incoming::Resize { cols, rows } => {
                if self.resize_terminal(terminal_id, cols, rows).is_err() {
                    self.close(terminal_id)
                } else {
                    Vec::new()
                }
            }
            Incoming::Ignore => Vec::new(),
            Incoming::Close => self.close(terminal_id),
        }
    }

    pub(crate) fn on_bytes(&mut self, terminal_id: &str, bytes: &[u8]) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        push_scrollback(&mut session.scrollback, bytes);
        if session.attached {
            session.seal_data(terminal_id, bytes)
        } else {
            Vec::new()
        }
    }

    pub(crate) fn on_eof(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        self.close(terminal_id)
    }

    pub(crate) fn poll(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let expired_pending = self
            .pending
            .iter()
            .filter(|(_, pending)| now.saturating_duration_since(pending.created) >= PENDING_TTL)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
        for id in expired_pending {
            self.pending.remove(&id);
            frames.push(term_rejected(&id, REASON_EXPIRED, None));
        }
        let expired = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                !session.attached
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

    #[cfg(unix)]
    fn write_terminal(&mut self, terminal_id: &str, bytes: &[u8]) -> std::io::Result<()> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        let Some(pty) = session.pty.as_mut() else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        write_all(&mut pty.writer, bytes)
    }

    #[cfg(not(unix))]
    fn write_terminal(&mut self, _terminal_id: &str, _bytes: &[u8]) -> std::io::Result<()> {
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
            .map_err(|error| std::io::Error::other(error.to_string()))
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
    let child = pair.slave.spawn_command(command)?;
    let pid = child.process_id();
    let writer = pair.master.take_writer()?;
    let stop = Arc::new(AtomicBool::new(false));
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
        writer,
        reader: Some(thread),
        stop,
        pid,
    })
}

fn write_all(writer: &mut dyn Write, bytes: &[u8]) -> std::io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        match writer.write(&bytes[offset..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "terminal write failed",
                ));
            }
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    writer.flush()
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
                    session.stop.store(true, Ordering::SeqCst);
                    kill_exec(session.pid, session.child.as_mut());
                    let status = reap_child(session.child.as_mut());
                    if status.0.is_some() || status.1.is_some() {
                        Some((status, true))
                    } else {
                        None
                    }
                } else {
                    match session
                        .child
                        .as_mut()
                        .and_then(|child| child.try_wait().ok())
                    {
                        Some(Some(status)) => {
                            let parts = status_parts(status);
                            // The direct child is already reaped. Kill grandchildren
                            // that stayed in its process group.
                            kill_exec(session.pid, None);
                            Some((parts, session.timed_out))
                        }
                        _ => None,
                    }
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
            kill_exec(session.pid, session.child.as_mut());
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

fn kill_exec(pid: u32, child: Option<&mut std::process::Child>) {
    #[cfg(unix)]
    {
        kill_process_group(pid);
        let _ = child;
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
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
        let frames = execs.poll(Instant::now());
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
                cols: 40,
                rows: 12,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
            },
        );
        terminals.detach("idle");
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
}
