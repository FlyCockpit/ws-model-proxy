//! Browser and operator terminals: one process per terminal, shared by its viewers, each with
//! its own keys, and the registry the relay loop drives.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::time::{Duration, Instant};

use super::handshake::{
    PreparedHandshake, TermHandshake, approval_code_for_identity, approval_signature_ok,
    decode_browser_handshake, fresh_nonce, handshake_rejected, identity_public,
    identity_still_approved, prepare_handshake, term_rejected,
};
use super::pty::{PtyRuntime, shutdown_pty, spawn_pty};
use super::{
    Lifecycle, OutboundFrame, REASON_ALREADY_OPEN, REASON_APPROVAL_REQUIRED, REASON_BAD_CWD,
    REASON_BAD_FRAME, REASON_BAD_HANDSHAKE, REASON_BAD_SIGNATURE, REASON_DISABLED, REASON_EXPIRED,
    REASON_LIMIT, REASON_NOT_FOUND, REASON_SPAWN_FAILED, REASON_UNSUPPORTED, REASON_VIEWER_LIMIT,
    signal_token, user_home, valid_id, wire_exit_code,
};
use crate::node::approvals::approved_public_key;
use crate::process::child_env::{self, scrub_parent_env};
use crate::relay::startup::TerminalStartup;
use crate::services::relay_bus::FromWorker;
use crate::wire::protocol::{NodeBinaryMetadata, NodeFrame, terminal_supported};
use crate::wire::terminal_crypto::{
    self, DIR_BROWSER_TO_CLI, DIR_CLI_TO_BROWSER, DirectionKeys, TermPlaintextV2,
};

mod operator;
pub(crate) use operator::OperatorDelivery;
pub(crate) use operator::operator_base_env;

/// Attached viewers plus pending approvals, per terminal (protocol 2.5).
const MAX_VIEWERS: usize = 8;
const SCROLLBACK_LIMIT: usize = 256 * 1024;
const SEAL_CHUNK: usize = 16 * 1024;
const DEFAULT_IDLE: Duration = Duration::from_secs(15 * 60);
const PENDING_TTL: Duration = Duration::from_secs(2 * 60);
/// How often attached 2.5 viewers are re-checked against the approvals file.
const APPROVAL_RECHECK: Duration = Duration::from_secs(5);
/// After the shell exits, keep the terminal until the PTY reports EOF, or this
/// long, whichever comes first. A background or disowned job that still holds
/// the PTY must not keep a dead terminal in its slot.
const TERMINAL_OUTPUT_DRAIN: Duration = Duration::from_millis(500);

enum Incoming {
    Write(Vec<u8>),
    Image(crate::wire::terminal_images::ImageChunk),
    ImagePaste(crate::wire::terminal_images::ImagePaste),
    ImageCancel([u8; 16]),
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Undecryptable or out-of-order sealed frames are dropped.
    Ignore,
    /// An authenticated frame with a bad payload removes only its viewer.
    DropViewer,
}

fn push_scrollback(buf: &mut VecDeque<u8>, bytes: &[u8]) {
    buf.extend(bytes);
    let overflow = buf.len().saturating_sub(SCROLLBACK_LIMIT);
    if overflow > 0 {
        buf.drain(..overflow);
    }
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

/// Best-effort wipe of key material. No `unsafe` and no extra crates, so this
/// is an overwrite the optimizer is discouraged (not forbidden) from removing.
fn wipe(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(&*bytes);
}

/// One browser tab.
struct Viewer {
    image_alive: Arc<AtomicBool>,
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
            image_alive: Arc::new(AtomicBool::new(true)),
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
        self.image_alive.store(false, Ordering::Release);
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
    images: crate::wire::terminal_images::ImageSession,
    /// The viewer that most recently typed.
    writer: Option<String>,
    pty_size: (u16, u16),
    out: OutputKey,
    /// Whether anyone views it; a detached browser shell closes after the idle limit.
    attachment: Attachment,
    scrollback: VecDeque<u8>,
    phase: TerminalPhase,
    /// Set iff this is the operator terminal of an interactive runtime step
    /// (`operator`): it starts [`TerminalPhase::Confirming`] and gets a PTY only when a
    /// person accepts. A browser shell starts [`TerminalPhase::Running`] and is never
    /// `Confirming`.
    operator: Option<operator::OperatorState>,
}

/// Where a terminal's process is in its life. The terminal leaves the registry when it
/// closes, so there is no closed phase.
///
/// ```text
/// Confirming --Enter (operator only)--> Running --poll reaps it (or Windows EOF)--> Exited
/// any phase --close, PTY EOF, decline, idle, shutdown--> closed (removed)
/// Exited --TERMINAL_OUTPUT_DRAIN--> closed (removed)
/// ```
enum TerminalPhase {
    /// An operator terminal on its confirm screen: no process yet. The writer's keys go to
    /// the confirm screen; a resize only records the size.
    Confirming,
    /// The PTY's process runs and takes viewer input.
    Running(PtyRuntime),
    /// The process exited with `status`, seen at `at`. Input is dropped; the terminal closes
    /// on PTY EOF or [`TERMINAL_OUTPUT_DRAIN`] after `at` (a background job may hold the PTY
    /// open after the shell is gone), and reports `status`.
    Exited {
        pty: PtyRuntime,
        status: (Option<i32>, Option<i32>),
        at: Instant,
    },
}

/// Whether a terminal has viewers. Kept in step with `TerminalSession::viewers` by
/// [`TerminalSession::add_viewer`] and [`TerminalSession::take_viewer`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Attachment {
    Attached,
    /// No viewer since `since` (an operator terminal opens this way).
    Detached {
        since: Instant,
    },
}

impl TerminalSession {
    /// Whether viewer keystrokes may reach the PTY now: not on a confirm screen and not once
    /// the shell has exited.
    fn accepts_input(&self) -> bool {
        matches!(self.phase, TerminalPhase::Running(_))
    }

    /// The terminal's PTY, running or exited (none on a confirm screen).
    fn pty(&self) -> Option<&PtyRuntime> {
        match &self.phase {
            TerminalPhase::Confirming => None,
            TerminalPhase::Running(pty) | TerminalPhase::Exited { pty, .. } => Some(pty),
        }
    }

    #[cfg(all(test, unix))]
    fn pty_mut(&mut self) -> Option<&mut PtyRuntime> {
        match &mut self.phase {
            TerminalPhase::Confirming => None,
            TerminalPhase::Running(pty) | TerminalPhase::Exited { pty, .. } => Some(pty),
        }
    }

    /// Running -> Exited, with the status read at `at`. Any other phase is left as it is.
    fn mark_exited(&mut self, status: (Option<i32>, Option<i32>), at: Instant) {
        let phase = std::mem::replace(&mut self.phase, TerminalPhase::Confirming);
        self.phase = match phase {
            TerminalPhase::Running(pty) => TerminalPhase::Exited { pty, status, at },
            other => other,
        };
    }

    /// End the process (if one ever ran). `ran`: a PTY existed; the status is its exit.
    fn shut_down(
        self,
    ) -> (
        bool,
        (Option<i32>, Option<i32>),
        Option<operator::OperatorState>,
    ) {
        let (ran, status) = match self.phase {
            TerminalPhase::Confirming => (false, (None, None)),
            TerminalPhase::Running(pty) => (true, shutdown_pty(pty, None)),
            TerminalPhase::Exited { pty, status, .. } => (true, shutdown_pty(pty, Some(status))),
        };
        (ran, status, self.operator)
    }

    fn add_viewer(&mut self, viewer_key: String, viewer: Viewer) {
        self.viewers.insert(viewer_key, viewer);
        self.attachment = Attachment::Attached;
    }

    /// Remove a viewer; the last one leaving starts the idle clock.
    fn take_viewer(&mut self, viewer_id: &str, now: Instant) -> Option<Viewer> {
        let viewer = self.viewers.remove(viewer_id)?;
        if self.viewers.is_empty() {
            self.attachment = Attachment::Detached { since: now };
        }
        Some(viewer)
    }

    /// A browser shell nobody has viewed for `limit`. An operator step may wait for its
    /// person indefinitely.
    fn idle_for(&self, now: Instant, limit: Duration) -> bool {
        self.operator.is_none()
            && matches!(self.attachment, Attachment::Detached { since }
                if now.saturating_duration_since(since) >= limit)
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
        let out = &mut self.out;
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
        let (epoch, key) = (self.out.epoch, self.out.key);
        let mut message = TermPlaintextV2::OutputKey { epoch, key };
        let frame = self.seal_unicast(terminal_id, viewer_id, &message);
        if let TermPlaintextV2::OutputKey { key, .. } = &mut message {
            wipe(key);
        }
        frame
    }

    /// Join order, all unicast: output key, human-shell capabilities, PTY
    /// size, then scrollback. The epoch does not change on a join.
    fn join_frames(&mut self, terminal_id: &str, viewer_id: &str) -> Vec<OutboundFrame> {
        let mut frames = Vec::new();
        frames.extend(self.key_frame(terminal_id, viewer_id));
        // A browser only uploads after this authenticated capability arrives.
        // Older browsers ignore the unknown unicast tag; older CLIs never advertise it.
        if self.operator.is_none() && self.images.supported() {
            frames.extend(self.seal_unicast(
                terminal_id,
                viewer_id,
                &TermPlaintextV2::ImageCapabilities,
            ));
        }
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
        self.out.rotate()?;
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
            Ok(TermPlaintextV2::ImageChunk(chunk)) => Incoming::Image(chunk),
            Ok(TermPlaintextV2::ImagePaste(paste)) => Incoming::ImagePaste(paste),
            Ok(TermPlaintextV2::ImageCancel(id)) => Incoming::ImageCancel(id),
            // A browser never sends an output key. Retired and unknown tags
            // fail to decode.
            Ok(
                TermPlaintextV2::OutputKey { .. }
                | TermPlaintextV2::ImageCapabilities
                | TermPlaintextV2::ImageReply(_),
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
    shell: Option<String>,
}

/// `(terminalId, viewerId)`.
type PendingKey = (String, Option<String>);

fn pending_key(terminal_id: &str, viewer_id: Option<&str>) -> PendingKey {
    (terminal_id.to_string(), viewer_id.map(str::to_string))
}

pub(crate) struct TerminalRegistry {
    sessions: BTreeMap<String, TerminalSession>,
    image_pending: BTreeMap<(String, String), crate::wire::terminal_images::ImagePending>,
    image_worker: Arc<crate::wire::terminal_images::ImageWorker>,
    pending: BTreeMap<PendingKey, PendingTerminal>,
    tx: SyncSender<FromWorker>,
    idle_limit: Duration,
    /// The state dir from the last successful `term.auth`, for approval re-checks.
    state_dir: Option<PathBuf>,
    next_approval_check: Option<Instant>,
    lifecycle: Lifecycle,
    /// A test's shell in place of the login shell or the node's default.
    shell: Option<(String, Vec<String>)>,
    /// Operator terminals submitted to a runner thread and not yet opened, and
    /// every operator terminal id this session took (ids are never reused).
    operators: operator::OperatorBook,
}

fn term_exit(terminal_id: &str, status: (Option<i32>, Option<i32>)) -> OutboundFrame {
    OutboundFrame::Control(NodeFrame::TermExit {
        terminal_id: terminal_id.to_string(),
        exit_code: wire_exit_code(status.0),
        signal: signal_token(status.1),
    })
}

impl TerminalRegistry {
    #[cfg(test)]
    pub(crate) fn new(tx: SyncSender<FromWorker>) -> Self {
        Self::with_image_worker(
            tx,
            Arc::new(crate::wire::terminal_images::ImageWorker::new()),
        )
    }

    pub(crate) fn with_image_worker(
        tx: SyncSender<FromWorker>,
        image_worker: Arc<crate::wire::terminal_images::ImageWorker>,
    ) -> Self {
        Self {
            sessions: BTreeMap::new(),
            image_pending: BTreeMap::new(),
            image_worker,
            pending: BTreeMap::new(),
            tx,
            idle_limit: DEFAULT_IDLE,
            state_dir: None,
            next_approval_check: None,
            lifecycle: Lifecycle::Open,
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
    #[cfg(test)]
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
        if !self.lifecycle.shut_down() {
            return Vec::new();
        }
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
        // After `kill_all` no shell spawns (and none queues for an approval).
        if self.lifecycle.is_shut_down() {
            return vec![*handshake_rejected(&handshake, REASON_SPAWN_FAILED)];
        }
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
        let cli_nonce = match fresh_nonce(&handshake) {
            Ok(nonce) => nonce,
            Err(frame) => return vec![*frame],
        };
        self.open_shell(startup, &handshake, prepared, cli_nonce, None)
    }

    fn open_shell(
        &mut self,
        startup: &TerminalStartup,
        handshake: &TermHandshake<'_>,
        prepared: PreparedHandshake,
        cli_nonce: [u8; 16],
        approved_identity: Option<[u8; 65]>,
    ) -> Vec<OutboundFrame> {
        let terminal_id = handshake.terminal_id;
        let Some(viewer_id) = handshake.viewer_id else {
            return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
        };
        // Also reached from `auth` for an open approved after the shutdown began.
        if self.lifecycle.is_shut_down() {
            return vec![*handshake_rejected(handshake, REASON_SPAWN_FAILED)];
        }
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
        let keys = startup.derive_terminal_keys(
            &prepared.browser_public,
            &prepared.browser_nonce,
            &cli_nonce,
            terminal_id,
            viewer_id,
        );
        let keys = match keys {
            Ok(keys) => keys,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "deriving terminal keys failed");
                return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
            }
        };
        let out = match OutputKey::first() {
            Ok(out) => out,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "generating a terminal output key failed");
                return vec![*handshake_rejected(handshake, REASON_SPAWN_FAILED)];
            }
        };
        let env = terminal_env();
        let Some((program, args)) = self.shell_command(startup, prepared.shell.as_deref()) else {
            return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
        };
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
        let viewer_key = viewer_id;
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
            images: self
                .image_worker
                .session(paste_quoting(startup, prepared.shell.as_deref())),
            // The opener is the first writer.
            writer: Some(viewer_id.to_string()),
            pty_size: (prepared.cols, prepared.rows),
            out,
            // The opener views it.
            attachment: Attachment::Attached,
            scrollback: VecDeque::new(),
            phase: TerminalPhase::Running(pty),
            operator: None,
        };
        let mut frames = vec![OutboundFrame::Control(NodeFrame::TermOpened {
            terminal_id: terminal_id.to_string(),
            viewer_id: Some(viewer_id.to_string()),
            cli_nonce: terminal_crypto::encode_b64url(&cli_nonce),
        })];
        frames.extend(session.join_frames(terminal_id, viewer_id));
        frames.push(term_writer(terminal_id, Some(viewer_id)));
        self.sessions.insert(terminal_id.to_string(), session);
        frames
    }

    /// The program and arguments a browser terminal starts: `shell` (an id
    /// this node advertised), or a test's shell, or the default: the login
    /// shell on Unix, the node's default shell on Windows.
    fn shell_command(
        &self,
        startup: &TerminalStartup,
        shell: Option<&str>,
    ) -> Option<(std::ffi::OsString, Vec<String>)> {
        if shell.is_none()
            && let Some((program, args)) = self.shell.clone()
        {
            return Some((program.into(), args));
        }
        platform_shell(startup, shell)
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
        if !(operator_join || startup.allow_human_terminal() && startup.full_control()) {
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
            startup.terminal_public_key(),
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
            shell: pending.shell,
        };
        let handshake = TermHandshake {
            terminal_id,
            viewer_id,
            cols: prepared.cols,
            rows: prepared.rows,
            browser_public_key: "",
            browser_nonce: "",
            identity: None,
            shell: None,
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
        self.open_shell(
            startup,
            &handshake,
            prepared,
            pending.cli_nonce,
            Some(pending.identity),
        )
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
                shell: prepared.shell,
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
        let Some(viewer_id) = handshake.viewer_id else {
            return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
        };
        let keys = startup.derive_terminal_keys(
            &prepared.browser_public,
            &prepared.browser_nonce,
            &cli_nonce,
            terminal_id,
            viewer_id,
        );
        let Ok(keys) = keys else {
            return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
        };
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return vec![*handshake_rejected(handshake, REASON_NOT_FOUND)];
        };
        let viewer_key = viewer_id;
        if session.viewers.contains_key(viewer_key) {
            return vec![*handshake_rejected(handshake, REASON_BAD_HANDSHAKE)];
        }
        session.add_viewer(
            viewer_key.to_string(),
            Viewer::new(keys, None, approved_identity),
        );
        let mut frames = vec![OutboundFrame::Control(NodeFrame::TermAttached {
            terminal_id: terminal_id.to_string(),
            viewer_id: Some(viewer_id.to_string()),
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
        if session.take_viewer(viewer_id, Instant::now()).is_none() {
            return Vec::new();
        }
        self.image_pending
            .remove(&(terminal_id.to_string(), viewer_id.to_string()));
        let mut frames = Vec::new();
        if let Some(reason) = notify {
            frames.push(term_rejected(terminal_id, Some(viewer_id), reason, None));
        }
        if session.writer.as_deref() == Some(viewer_id) {
            session.writer = None;
            frames.push(term_writer(terminal_id, None));
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
        let Some(session) = self.sessions.remove(terminal_id) else {
            return Vec::new();
        };
        self.image_pending.retain(|(id, _), _| id != terminal_id);
        let (ran, status, operator) = session.shut_down();
        let mut frames = vec![term_exit(terminal_id, status)];
        // An operator terminal answers for its step after its exit.
        if let Some(state) = operator {
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
        let mut frames = self.poll_image_replies(Instant::now());
        frames.extend(self.handle_sealed_inner(terminal_id, viewer_id, seq, body));
        frames
    }

    /// Poll only in-memory receivers; the image worker owns all filesystem I/O.
    fn poll_image_replies(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let sessions = &self.sessions;
        self.image_pending
            .retain(|(terminal_id, viewer_id), pending| {
                sessions.get(terminal_id).is_some_and(|session| {
                    // Shell exit aborts the browser upload after output drains
                    // (retireAfterDrain -> forgetSession); no reply is needed here.
                    session.accepts_input()
                        && session.viewers.get(viewer_id).is_some_and(|viewer| {
                            pending.is_current(&session.images, &viewer.image_alive)
                        })
                })
            });
        let ready = self
            .image_pending
            .iter()
            .filter_map(|(key, pending)| pending.poll(now).map(|reply| (key.clone(), reply)))
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
        for ((terminal_id, viewer_id), reply) in ready {
            if reply.error.is_some() {
                self.image_pending
                    .remove(&(terminal_id.clone(), viewer_id.clone()));
            }
            if let Some(session) = self.sessions.get_mut(&terminal_id) {
                frames.extend(session.seal_unicast(
                    &terminal_id,
                    &viewer_id,
                    &TermPlaintextV2::ImageReply(reply),
                ));
            }
        }
        frames
    }

    fn handle_sealed_inner(
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
            Incoming::ImageCancel(id) => {
                let key = (terminal_id.to_string(), viewer_key);
                if self
                    .image_pending
                    .get(&key)
                    .is_some_and(|pending| pending.matches(&id))
                {
                    self.image_pending.remove(&key);
                }
                Vec::new()
            }
            Incoming::ImagePaste(paste) => {
                let key = (terminal_id.to_string(), viewer_key.clone());
                let live = self
                    .sessions
                    .get(terminal_id)
                    .is_some_and(|session| session.operator.is_none() && session.accepts_input());
                if !live
                    || !self
                        .image_pending
                        .get(&key)
                        .is_some_and(|pending| pending.begin_paste(&paste))
                {
                    // This paste was never queued. Report dropped input without
                    // changing the suppression state for actual queue overflow.
                    tracing::warn!(
                        terminal_id,
                        "terminal image paste rejected: offer is unavailable, expired, or invalid"
                    );
                    return vec![OutboundFrame::Control(NodeFrame::TermInputDropped {
                        terminal_id: terminal_id.to_string(),
                        viewer_id: Some(viewer_key.to_string()),
                    })];
                }
                let mut frames = match self.claim_writer(terminal_id, &viewer_key) {
                    Ok(frames) => frames,
                    Err(_) => {
                        if let Some(pending) = self.image_pending.get(&key) {
                            pending.finish_paste(false);
                        }
                        return self.close(terminal_id);
                    }
                };
                let queued = self.enqueue_input(terminal_id, paste.data);
                if let Some(pending) = self.image_pending.remove(&key) {
                    pending.finish_paste(queued.as_ref().is_ok_and(|queued| *queued));
                }
                match queued {
                    Ok(queued) => frames.extend(self.note_input(terminal_id, &viewer_key, queued)),
                    Err(_) => frames.extend(self.close(terminal_id)),
                }
                frames
            }
            Incoming::Image(chunk) => {
                let key = (terminal_id.to_string(), viewer_key.clone());
                if self
                    .image_pending
                    .get(&key)
                    .is_some_and(|pending| pending.accept_next(&chunk))
                {
                    self.image_pending.remove(&key);
                }
                let Some(session) = self.sessions.get_mut(terminal_id) else {
                    return Vec::new();
                };
                // File writes are only for live human shells, never operator steps
                // (which may be attached at Relay-only trust) or confirm screens.
                let id = chunk.id;
                let result = if session.operator.is_some() || !session.accepts_input() {
                    Err("unavailable")
                } else if self.image_pending.contains_key(&key) {
                    Err("busy")
                } else if let Some(viewer) = session.viewers.get(&viewer_key) {
                    self.image_worker.submit(
                        &session.images,
                        &viewer_key,
                        &viewer.image_alive,
                        chunk,
                    )
                } else {
                    Err("unavailable")
                };
                let reply = match result {
                    Ok(pending) => {
                        self.image_pending.insert(key, pending);
                        return Vec::new();
                    }
                    Err(reason) => crate::wire::terminal_images::ImageReply::rejected(&id, reason),
                };
                session
                    .seal_unicast(
                        terminal_id,
                        &viewer_key,
                        &TermPlaintextV2::ImageReply(reply),
                    )
                    .into_iter()
                    .collect()
            }
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
            viewer_id: Some(viewer_key.to_string()),
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
    pub(crate) fn on_bytes(&mut self, terminal_id: &str, bytes: &[u8]) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        // Scrollback is always recorded; output is sealed only for viewers.
        push_scrollback(&mut session.scrollback, bytes);
        session.broadcast_data(terminal_id, bytes)
    }

    /// PTY EOF.
    pub(crate) fn on_eof(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        // Windows: the helper's output ends only as it exits, with the
        // shell's exit code. Read it before the close ends the job; the
        // process may take a moment to be marked exited.
        #[cfg(windows)]
        if let Some(session) = self.sessions.get_mut(terminal_id)
            && let TerminalPhase::Running(pty) = &mut session.phase
        {
            let until = Instant::now() + Duration::from_millis(250);
            loop {
                if let Some(status) = pty.reap() {
                    session.mark_exited(status, Instant::now());
                    break;
                }
                if Instant::now() >= until {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        self.close(terminal_id)
    }

    /// Expire pending approvals, re-check approvals, close exited shells and
    /// idle detached terminals.
    pub(crate) fn poll(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let mut frames = Vec::new();
        frames.extend(self.poll_image_replies(now));
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
                key.1.as_deref(),
                REASON_EXPIRED,
                None,
            ));
        }
        frames.extend(self.recheck_approvals(now));
        frames.extend(self.close_exited_shells(now));
        // Pending viewers do not keep a terminal alive.
        let expired = self
            .sessions
            .iter()
            .filter(|(_, session)| session.idle_for(now, self.idle_limit))
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
    fn close_exited_shells(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let mut drained = Vec::new();
        for (terminal_id, session) in &mut self.sessions {
            if let TerminalPhase::Running(pty) = &mut session.phase
                && let Some(status) = pty.reap()
            {
                session.mark_exited(status, now);
            }
            if let TerminalPhase::Exited { at, .. } = session.phase
                && now.saturating_duration_since(at) >= TERMINAL_OUTPUT_DRAIN
            {
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
    fn enqueue_input(&mut self, terminal_id: &str, bytes: Vec<u8>) -> std::io::Result<bool> {
        let Some(session) = self.sessions.get(terminal_id) else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        let Some(pty) = session.pty() else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        pty.push_input(bytes)
    }

    fn resize_terminal(&mut self, terminal_id: &str, cols: u16, rows: u16) -> std::io::Result<()> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Err(std::io::Error::other("terminal is closed"));
        };
        match session.pty() {
            // No PTY yet: the size waits for the command's PTY.
            None => {}
            Some(pty) => pty.resize(cols, rows)?,
        }
        session.pty_size = (cols, rows);
        Ok(())
    }
}

impl Drop for TerminalRegistry {
    fn drop(&mut self) {
        let _ = self.kill_all();
    }
}

/// Unix: the login shell; a node that advertised no shells takes no id.
#[cfg(unix)]
fn platform_shell(
    _startup: &TerminalStartup,
    shell: Option<&str>,
) -> Option<(std::ffi::OsString, Vec<String>)> {
    let (program, args) = child_env::login_shell();
    shell.is_none().then(|| (program.into(), args))
}

/// Windows: `shell`, or the node's default, from the shells found at startup.
#[cfg(windows)]
fn platform_shell(
    startup: &TerminalStartup,
    shell: Option<&str>,
) -> Option<(std::ffi::OsString, Vec<String>)> {
    startup
        .shell(shell)
        .map(|found| (found.program.clone().into_os_string(), found.args.clone()))
}

/// How the terminal's shell takes a pasted image path: `sh` on Unix; on Windows PowerShell,
/// Command Prompt or a WSL distribution (`None`: an unknown shell, which takes no images).
fn paste_quoting(
    startup: &TerminalStartup,
    shell: Option<&str>,
) -> Option<crate::wire::terminal_images::PasteQuoting> {
    if cfg!(windows) {
        startup
            .shell(shell)
            .and_then(|found| crate::wire::terminal_images::PasteQuoting::for_shell(&found.id))
    } else {
        Some(crate::wire::terminal_images::PasteQuoting::Posix)
    }
}

fn terminal_env() -> Vec<(String, String)> {
    let mut env = scrub_parent_env(&[]);
    // A Windows console has no TERM; programs ask the console instead.
    if cfg!(unix) {
        env.retain(|(name, _)| name != "TERM");
        env.push(("TERM".to_string(), "xterm-256color".to_string()));
    }
    env
}

#[cfg(test)]
mod tests;
