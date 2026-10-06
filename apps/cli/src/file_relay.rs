//! Node file ops (relay 3.0 `file.op`): the CLI side.
//!
//! One [`FileRelay`] lives for one relay session (the daemon builds it beside
//! its terminal and exec registries). It never touches the filesystem on the
//! relay loop: an admitted op is handed to the [`FilePool`] and its finished
//! frames come back through the session's sink (the daemon turns them into
//! `FromWorker::FileFrames`), where the loop sends them only if the op is
//! still pending. Everything an op does to the wire goes through ONE settle
//! point, [`settle`], which also writes the info log line (op, path, outcome;
//! never content).
//!
//! Admission ([`admit`]) is a pure function re-checked on every op: the
//! node's trust (Relay only -> `trust_relay`), configured file roots (none ->
//! `no_roots`) and the root refusal (`unsupported` at euid 0 unless
//! `allowFileToolsAsRoot`). The server's admission is a separate,
//! independent check.
//!
//! Frames, per `apps/server/src/relay/file-protocol.ts`:
//! - `file.op` -> `file.result` (+ a binary `file.data` frame when the op's big
//!   text field is over 48 KiB) or `file.rejected`;
//! - a write's content arrives as one binary `file.body` frame (`bodyBytes`
//!   long) and is injected as base64 `content` before `FileOps::execute`, so
//!   the redaction-marker check in `write.rs` still runs;
//! - `file.cancel` and `file.body` for an unknown opId are dropped.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Map, Value};

use crate::display_escape::escape_for_display;
use crate::file_ops::pool::{FilePool, MAX_IN_FLIGHT};
use crate::file_ops::{
    Cancel, ErrorCode, EtagKey, FileError, FileOps, FileResult, Policy, PreparedSupervised,
};
use crate::protocol::frames::FileOpKind;
use crate::protocol::{
    NodeBinaryMetadata, NodeFrame, RELAY_BINARY_CHUNK_MAX_BYTES, RELAY_JSON_CONTROL_MAX_BYTES,
};

/// Text above this many bytes travels as a binary `file.data` frame.
pub const INLINE_TEXT_MAX_BYTES: usize = 48 * 1024;
/// A write's content and any `file.data` body are one binary frame.
pub const BODY_MAX_BYTES: usize = RELAY_BINARY_CHUNK_MAX_BYTES;
/// Ops this session may hold at once (queued, running or waiting for a body).
/// The server allows 4 per CLI; this only bounds a misbehaving server.
pub const MAX_PENDING: usize = 8;
/// How long a write may wait for its `file.body` frame.
pub const BODY_WAIT: Duration = Duration::from_secs(10);
const LOG_TARGET_MAX_CHARS: usize = 300;
const LOG_REASON_MAX_CHARS: usize = 200;

pub const OPS: [&str; 9] = [
    "read", "stat", "list", "search", "edit", "write", "rename", "mkdir", "delete",
];

/// The read class: the only ops the read grant can admit. Anything else,
/// including an unknown name, is write-class and fails closed.
pub fn is_read_op(op: &str) -> bool {
    matches!(op, "read" | "stat" | "list" | "search")
}

/// The wire name of an op, or `None` for a name 3.0 does not have.
pub fn op_kind(op: &str) -> Option<FileOpKind> {
    Some(match op {
        "read" => FileOpKind::Read,
        "stat" => FileOpKind::Stat,
        "list" => FileOpKind::List,
        "search" => FileOpKind::Search,
        "edit" => FileOpKind::Edit,
        "write" => FileOpKind::Write,
        "rename" => FileOpKind::Rename,
        "mkdir" => FileOpKind::Mkdir,
        "delete" => FileOpKind::Delete,
        _ => return None,
    })
}

/// The op name of a wire kind (the inverse of [`op_kind`]).
pub fn op_name(kind: FileOpKind) -> &'static str {
    match kind {
        FileOpKind::Read => "read",
        FileOpKind::Stat => "stat",
        FileOpKind::List => "list",
        FileOpKind::Search => "search",
        FileOpKind::Edit => "edit",
        FileOpKind::Write => "write",
        FileOpKind::Rename => "rename",
        FileOpKind::Mkdir => "mkdir",
        FileOpKind::Delete => "delete",
    }
}

/// A frame a settled op wants sent, in order.
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)] // `NodeFrame` carries the telemetry shapes.
pub enum FileFrame {
    Control(NodeFrame),
    Binary(NodeBinaryMetadata, Vec<u8>),
}

/// Receives `(opId, frames)` when an op settles on a pool worker. The daemon
/// forwards it to the relay loop; it must not block for long.
pub type FileSink = Arc<dyn Fn(String, Vec<FileFrame>) + Send + Sync>;

/// The engine and worker pool: built once per daemon.
pub struct FileRuntime {
    /// Shared with running jobs, so a job never holds the pool (dropping the
    /// pool joins its workers, which a worker cannot do to itself).
    ops: Arc<FileOps>,
    pool: FilePool,
}

impl FileRuntime {
    pub fn new(ops: FileOps) -> Self {
        Self {
            ops: Arc::new(ops),
            pool: FilePool::new(),
        }
    }

    #[doc(hidden)]
    pub fn with_pool(ops: FileOps, pool: FilePool) -> Self {
        Self {
            ops: Arc::new(ops),
            pool,
        }
    }

    pub fn policy(&self) -> &Policy {
        self.ops.policy()
    }

    pub fn ops(&self) -> Arc<FileOps> {
        Arc::clone(&self.ops)
    }

    /// Queue non-mutating preparation. The callback is invoked exactly once;
    /// a worker panic is converted to `io_error` before the callback boundary.
    pub fn prepare_supervised<F>(
        &self,
        op: String,
        args: Value,
        body: Option<Vec<u8>>,
        preview_key: EtagKey,
        cancel: Cancel,
        done: F,
    ) -> FileResult<()>
    where
        F: FnOnce(FileResult<PreparedSupervised>) + Send + 'static,
    {
        let ops = Arc::clone(&self.ops);
        let job = move || -> FileResult<()> {
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
                ops.prepare_supervised(&op, args, body, &preview_key, &cancel)
            }))
            .unwrap_or_else(|_| {
                Err(FileError::new(
                    ErrorCode::IoError,
                    "file preparation panicked",
                ))
            });
            done(outcome);
            Ok(())
        };
        self.pool.submit(job, MAX_IN_FLIGHT).map(|_| ())
    }

    /// Queue the one daemon-side application of an immutable prepared request.
    pub fn apply_supervised<F>(
        &self,
        prepared: PreparedSupervised,
        cancel: Cancel,
        done: F,
    ) -> FileResult<()>
    where
        F: FnOnce(FileResult<Value>) + Send + 'static,
    {
        let ops = Arc::clone(&self.ops);
        let job = move || -> FileResult<()> {
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
                ops.execute_supervised(prepared, &cancel)
            }))
            .unwrap_or_else(|_| {
                Err(FileError::new(
                    ErrorCode::IoError,
                    "file operation panicked",
                ))
            });
            done(outcome);
            Ok(())
        };
        self.pool.submit(job, MAX_IN_FLIGHT).map(|_| ())
    }
}

static SHARED: OnceLock<Arc<FileRuntime>> = OnceLock::new();

/// Daemon-lifetime policy and etag key, confined by the startup roots.
pub fn shared_runtime(allow_root: bool, roots: &[std::path::PathBuf]) -> Arc<FileRuntime> {
    Arc::clone(SHARED.get_or_init(|| {
        Arc::new(FileRuntime::new(FileOps::new(
            Policy::from_environment(roots.to_vec(), allow_root),
            EtagKey::random(),
        )))
    }))
}

/// Every reason `refuse` can pass: the wire reasons from `admit`/framing plus
/// the file error codes the pending cap and the root check use. Mirrored by
/// `FILE_WIRE_REASONS` + `FILE_ERROR_CODES` in
/// `apps/server/src/relay/file-protocol.ts`; a reason outside that union fails
/// the server's strict schema, which settles the op as io_error.
pub const WIRE_REFUSAL_REASONS: [&str; 3] = ["bad_frame", "trust_relay", "no_roots"];
/// {@link WIRE_REFUSAL_REASONS} plus the two file error codes `refuse` passes.
pub const REFUSE_REASONS: [&str; 5] = [
    "bad_frame",
    "trust_relay",
    "no_roots",
    "unsupported",
    "limit",
];

/// Pure admission table: Full control, configured roots, and the root UID
/// consent, in that order.
pub fn admit(
    full_control: bool,
    roots: bool,
    euid: u32,
    allow_root: bool,
) -> Result<(), &'static str> {
    if !full_control {
        return Err("trust_relay");
    }
    if !roots {
        return Err("no_roots");
    }
    if euid == 0 && !allow_root {
        return Err("unsupported");
    }
    Ok(())
}

/// What is logged about one op: never any content.
#[derive(Debug, Clone)]
pub struct OpSummary {
    pub op: String,
    pub target: String,
    pub reason: Option<String>,
}

fn clip(text: &str, max_chars: usize) -> String {
    let clipped: String = text.chars().take(max_chars).collect();
    escape_for_display(&clipped).replace('\n', "\\n")
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

pub fn summarize(op: &str, args: &Value) -> OpSummary {
    let target = match op {
        "stat" => match args.get("paths").and_then(Value::as_array) {
            Some(paths) => {
                let first = paths.first().and_then(Value::as_str).unwrap_or("");
                match paths.len() {
                    0 | 1 => clip(first, LOG_TARGET_MAX_CHARS),
                    more => format!("{} (+{} more)", clip(first, LOG_TARGET_MAX_CHARS), more - 1),
                }
            }
            None => String::new(),
        },
        "search" => clip(string_arg(args, "root").unwrap_or(""), LOG_TARGET_MAX_CHARS),
        "rename" => format!(
            "{} -> {}",
            clip(string_arg(args, "from").unwrap_or(""), LOG_TARGET_MAX_CHARS),
            clip(string_arg(args, "to").unwrap_or(""), LOG_TARGET_MAX_CHARS)
        ),
        _ => clip(string_arg(args, "path").unwrap_or(""), LOG_TARGET_MAX_CHARS),
    };
    OpSummary {
        op: if OPS.contains(&op) {
            op.to_string()
        } else {
            "unknown".to_string()
        },
        target,
        reason: string_arg(args, "reason").map(|reason| clip(reason, LOG_REASON_MAX_CHARS)),
    }
}

fn valid_op_id(id: &str) -> bool {
    id.len() == 22
        && URL_SAFE_NO_PAD
            .decode(id)
            .map(|bytes| bytes.len() == 16)
            .unwrap_or(false)
}

/// The keys `fileRejectDetailSchema` (server) accepts, with their shapes.
/// Anything else a `FileError` carries is dropped.
/// The library's etag shape: `h:` (strong) or `w:` (weak) plus 22 base64url characters.
fn is_etag(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 24
        && matches!(bytes[0], b'h' | b'w')
        && bytes[1] == b':'
        && bytes[2..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// An absolute recovery path as the server schema accepts it (`recoveryPathSchema`).
fn is_recovery_path(text: &str) -> bool {
    text.starts_with('/') && text.len() <= 8192 && !text.contains('\0')
}

pub fn filter_detail(detail: &Value) -> Option<Value> {
    let object = detail.as_object()?;
    let mut out = Map::new();
    for (key, value) in object {
        let keep = match key.as_str() {
            "currentEtag" => value
                .as_str()
                .is_some_and(|s| is_etag(s) || matches!(s, "replaced" | "gone")),
            "etag" => value.as_str().is_some_and(is_etag),
            "sniff" => value.as_str().is_some_and(|s| s.len() <= 32),
            "size" | "edit" | "nearestLine" | "line" | "found" | "retryAfterMs" => {
                value.as_u64().is_some()
            }
            "expected" => value.as_u64().is_some() || value.as_str().is_some_and(|s| s.len() <= 16),
            "lines" => value.as_array().is_some_and(|items| {
                items.len() <= 5 && items.iter().all(|i| i.as_u64().is_some())
            }),
            "recovery" => value.as_str().is_some_and(is_recovery_path),
            "kept" => value.as_array().is_some_and(|items| {
                items.len() <= 4
                    && items
                        .iter()
                        .all(|i| i.as_str().is_some_and(is_recovery_path))
            }),
            _ => false,
        };
        if keep {
            out.insert(key.clone(), value.clone());
        }
    }
    // The server accepts the recovery facts only as a pair (`uncertain_outcome`
    // requires both): a lone half is dropped rather than failing the frame.
    if out.contains_key("recovery") != out.contains_key("kept") {
        out.remove("recovery");
        out.remove("kept");
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

fn data_field(op: &str) -> Option<&'static str> {
    match op {
        "read" => Some("text"),
        "list" => Some("entries"),
        "search" => Some("matches"),
        "edit" | "write" => Some("diff"),
        _ => None,
    }
}

/// The spilled field's name and bytes.
type Spilled = Option<(&'static str, Vec<u8>)>;

/// Moves the op's big text field (over 48 KiB) out of `result`: the field is
/// emptied and its bytes returned for a `file.data` frame.
fn split_result(op: &str, mut result: Value) -> FileResult<(Value, Spilled)> {
    let Some(field) = data_field(op) else {
        return Ok((result, None));
    };
    let big = result
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|text| text.len() > INLINE_TEXT_MAX_BYTES);
    if !big {
        return Ok((result, None));
    }
    let text = match result.get_mut(field) {
        Some(slot) => std::mem::replace(slot, Value::String(String::new())),
        None => Value::Null,
    };
    let bytes = text.as_str().unwrap_or("").as_bytes().to_vec();
    if bytes.len() > BODY_MAX_BYTES {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            "the result is larger than one relay frame",
        ));
    }
    Ok((result, Some((field, bytes))))
}

fn rejected(op_id: &str, reason: &str, detail: Option<Value>) -> NodeFrame {
    NodeFrame::FileRejected {
        op_id: op_id.to_string(),
        reason: reason.to_string(),
        detail,
    }
}

fn frames_for(op_id: &str, op: &str, outcome: FileResult<Value>) -> (Vec<FileFrame>, String) {
    let value = match outcome {
        Ok(value) => value,
        Err(error) => {
            let code = error.code.as_str().to_string();
            let detail = error.detail.as_ref().and_then(filter_detail);
            return (
                vec![FileFrame::Control(rejected(op_id, &code, detail))],
                code,
            );
        }
    };
    let mutating = matches!(op, "edit" | "write" | "rename" | "mkdir" | "delete");
    let mut value = value;
    if let Some(frames) = encode_result(op_id, op, value.clone()) {
        return (frames, "ok".to_string());
    }
    if mutating {
        // The change is already committed: a result that is too big must never
        // become a definitive refusal. Shed the optional bulk (hunk list, then
        // the diff) and encode again.
        for field in ["hunks", "diff"] {
            if let Some(object) = value.as_object_mut() {
                object.remove(field);
            }
            if let Some(frames) = encode_result(op_id, op, value.clone()) {
                return (frames, "ok".to_string());
            }
        }
        // Still too big (not expected): say the outcome is not known. The server
        // reports a mutating `io_error` as `outcome: "unknown"`.
        return (
            vec![FileFrame::Control(rejected(op_id, "io_error", None))],
            "io_error".to_string(),
        );
    }
    (
        vec![FileFrame::Control(rejected(op_id, "too_large", None))],
        "too_large".to_string(),
    )
}

/// The wire frames of one successful result, or `None` when it cannot be sent
/// (a spilled body over one frame, or a control frame over 64 KiB).
fn encode_result(op_id: &str, op: &str, value: Value) -> Option<Vec<FileFrame>> {
    let (result, data) = split_result(op, value).ok()?;
    let (data_field, body_bytes, body) = match data {
        Some((field, bytes)) => (
            Some(field.to_string()),
            Some(u32::try_from(bytes.len()).ok()?),
            Some(bytes),
        ),
        None => (None, None, None),
    };
    let message = NodeFrame::FileResult {
        op_id: op_id.to_string(),
        op: op_kind(op)?,
        result,
        data_field,
        body_bytes,
    };
    match serde_json::to_string(&message) {
        Ok(text) if text.len() <= RELAY_JSON_CONTROL_MAX_BYTES => {}
        _ => return None,
    }
    let mut frames = vec![FileFrame::Control(message)];
    if let Some(bytes) = body {
        frames.push(FileFrame::Binary(
            NodeBinaryMetadata::FileData {
                op_id: op_id.to_string(),
            },
            bytes,
        ));
    }
    Some(frames)
}

/// THE settle point: every op, however it ends (result, error, refusal, bad
/// frame, cancel), is logged and turned into its wire frames here. The
/// info log line carries the op, its path(s) and the outcome code, never file
/// content and never an error message.
///
/// TODO(#132): `recordCliAgentAction` audit is server-side; nothing to add on
/// the CLI. The server's settle point is `settleFileOp` in
/// `apps/server/src/relay/cli-file-ops.ts`.
pub fn settle(op_id: &str, summary: &OpSummary, outcome: FileResult<Value>) -> Vec<FileFrame> {
    let (frames, outcome_code) = frames_for(op_id, &summary.op, outcome);
    log_outcome(summary, &outcome_code);
    frames
}

/// Shared metadata-only outcome logging for headless and supervised file ops.
pub(crate) fn log_outcome(summary: &OpSummary, outcome_code: &str) {
    tracing::info!(
        op = %summary.op,
        target = %summary.target,
        outcome = %outcome_code,
        reason = summary.reason.as_deref(),
        "file op"
    );
}

struct AwaitingBody {
    args: Value,
    expected: usize,
    since: Instant,
}

struct Pending {
    cancel: Cancel,
    summary: OpSummary,
    op: String,
    awaiting: Option<AwaitingBody>,
}

/// Per-session state: the ops in flight and the runtime that runs them.
pub struct FileRelay {
    runtime: Arc<FileRuntime>,
    full_control: bool,
    sink: FileSink,
    pending: HashMap<String, Pending>,
}

impl FileRelay {
    /// `full_control` is the daemon's trust snapshot; it is checked again on
    /// every op.
    pub fn new(runtime: Arc<FileRuntime>, full_control: bool, sink: FileSink) -> Self {
        Self {
            runtime,
            full_control,
            sink,
            pending: HashMap::new(),
        }
    }

    /// `trust.lower`: refuse every later op (`trust_relay`) and cancel the
    /// pending ones.
    pub fn lower_trust(&mut self) {
        self.full_control = false;
        self.cancel_all();
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// A `file.op` frame. Returns the frames to send now (a refusal); an
    /// admitted op answers later through the sink.
    pub fn handle_op(
        &mut self,
        op_id: &str,
        op: &str,
        args: Value,
        body_bytes: Option<usize>,
    ) -> Vec<FileFrame> {
        if !valid_op_id(op_id) {
            tracing::warn!("dropping a file.op with an invalid opId");
            return Vec::new();
        }
        if self.pending.contains_key(op_id) {
            tracing::warn!("dropping a file.op that reuses a pending opId");
            return Vec::new();
        }
        let summary = summarize(op, &args);
        let bad_frame = || Err(FileError::new(ErrorCode::InvalidInput, "bad_frame"));
        let malformed: FileResult<()> = (|| {
            if !OPS.contains(&op) {
                return bad_frame();
            }
            let Some(object) = args.as_object() else {
                return bad_frame();
            };
            match (op, body_bytes) {
                ("write", Some(bytes)) if bytes <= BODY_MAX_BYTES => {}
                ("write", _) => return bad_frame(),
                (_, Some(_)) => return bad_frame(),
                (_, None) => {}
            }
            // Content rides in `file.body`; an inline copy would be ambiguous.
            if op == "write" && (object.contains_key("content") || object.contains_key("encoding"))
            {
                return bad_frame();
            }
            Ok(())
        })();
        if malformed.is_err() {
            return self.refuse(op_id, &summary, "bad_frame");
        }
        let policy = self.runtime.policy();
        if let Err(reason) = admit(
            self.full_control,
            policy.roots_configured(),
            policy.euid(),
            policy.allow_root(),
        ) {
            return self.refuse(op_id, &summary, reason);
        }
        if self.pending.len() >= MAX_PENDING {
            return self.refuse(op_id, &summary, "limit");
        }
        let cancel = Cancel::new();
        let awaiting = (op == "write").then(|| AwaitingBody {
            args: args.clone(),
            expected: body_bytes.unwrap_or(0),
            since: Instant::now(),
        });
        let submit_now = awaiting.is_none();
        self.pending.insert(
            op_id.to_string(),
            Pending {
                cancel: cancel.clone(),
                summary,
                op: op.to_string(),
                awaiting,
            },
        );
        if submit_now {
            return self.submit(op_id, op, args, cancel);
        }
        Vec::new()
    }

    /// The single binary `file.body` frame of a write.
    pub fn handle_body(&mut self, op_id: &str, body: Vec<u8>) -> Vec<FileFrame> {
        let Some(pending) = self.pending.get_mut(op_id) else {
            tracing::debug!("dropping a file.body for an unknown opId");
            return Vec::new();
        };
        let Some(awaiting) = pending.awaiting.take() else {
            tracing::warn!("dropping a file.body the op did not ask for");
            return Vec::new();
        };
        if body.len() != awaiting.expected {
            let summary = pending.summary.clone();
            self.pending.remove(op_id);
            return self.refuse(op_id, &summary, "bad_frame");
        }
        let cancel = pending.cancel.clone();
        let mut args = awaiting.args;
        if let Some(object) = args.as_object_mut() {
            object.insert("content".to_string(), Value::String(STANDARD.encode(&body)));
            object.insert("encoding".to_string(), Value::String("base64".to_string()));
        }
        let op = pending.op.clone();
        self.submit(op_id, &op, args, cancel)
    }

    /// `file.cancel`: stop the op at its next check. Its result is dropped;
    /// an unknown opId is ignored.
    pub fn handle_cancel(&mut self, op_id: &str) {
        let Some(pending) = self.pending.remove(op_id) else {
            tracing::debug!("dropping a file.cancel for an unknown opId");
            return;
        };
        pending.cancel.cancel();
        if pending.awaiting.is_some() {
            // Never reached the pool: settle (log) it here.
            let _ = settle(op_id, &pending.summary, Err(FileError::cancelled()));
        }
    }

    /// Drop writes whose `file.body` never arrived (`bad_frame`).
    pub fn expire_stale(&mut self, now: Instant) -> Vec<FileFrame> {
        let stale: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, pending)| {
                pending
                    .awaiting
                    .as_ref()
                    .is_some_and(|waiting| now.duration_since(waiting.since) >= BODY_WAIT)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut frames = Vec::new();
        for op_id in stale {
            if let Some(pending) = self.pending.remove(&op_id) {
                pending.cancel.cancel();
                frames.extend(self.refuse(&op_id, &pending.summary, "bad_frame"));
            }
        }
        frames
    }

    /// The loop received the frames of `op_id`: true when the op is still
    /// pending (send them), false when it was cancelled or the session moved on.
    pub fn complete(&mut self, op_id: &str) -> bool {
        self.pending.remove(op_id).is_some()
    }

    /// Cancel every pending op (session teardown, also on drop).
    pub fn cancel_all(&mut self) {
        for (_, pending) in self.pending.drain() {
            pending.cancel.cancel();
        }
    }

    fn refuse(&mut self, op_id: &str, summary: &OpSummary, reason: &str) -> Vec<FileFrame> {
        // Not all of these are `ErrorCode`s; same log line as `settle`.
        debug_assert!(
            REFUSE_REASONS.contains(&reason),
            "refuse() reason {reason:?} is outside REFUSE_REASONS, mirrored by \
             FILE_WIRE_REASONS/FILE_ERROR_CODES in \
             apps/server/src/relay/file-protocol.ts"
        );
        tracing::info!(
            op = %summary.op,
            target = %summary.target,
            outcome = %reason,
            "file op"
        );
        vec![FileFrame::Control(rejected(op_id, reason, None))]
    }

    fn submit(&mut self, op_id: &str, op: &str, args: Value, cancel: Cancel) -> Vec<FileFrame> {
        let summary = match self.pending.get(op_id) {
            Some(pending) => pending.summary.clone(),
            None => return Vec::new(),
        };
        let ops = Arc::clone(&self.runtime.ops);
        let sink = Arc::clone(&self.sink);
        let job_op_id = op_id.to_string();
        let job_op = op.to_string();
        let job_summary = summary.clone();
        let job = move || -> FileResult<()> {
            let outcome =
                // Only effective in unwinding builds (tests, dev); release builds
                // use `panic=abort`, where a panic ends the process and the server
                // reports the lost session's mutations as unknown.
                std::panic::catch_unwind(AssertUnwindSafe(|| ops.execute(&job_op, args, &cancel)))
                    .unwrap_or_else(|_| {
                        Err(FileError::new(
                            ErrorCode::IoError,
                            "file operation panicked",
                        ))
                    });
            let frames = settle(&job_op_id, &job_summary, outcome);
            sink(job_op_id, frames);
            Ok(())
        };
        match self.runtime.pool.submit(job, MAX_IN_FLIGHT) {
            Ok(_receiver) => Vec::new(),
            Err(error) => {
                self.pending.remove(op_id);
                settle(op_id, &summary, Err(error))
            }
        }
    }
}

impl Drop for FileRelay {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

#[cfg(test)]
mod tests;
