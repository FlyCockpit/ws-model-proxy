//! Relay protocol 3.0: the frame types (`frames`), the runtime definition
//! shape (`runtime_spec`), canonical JSON for `launchHash` (`canonical`), and
//! the codec the daemon uses on top of them.
//!
//! The server accepts exactly protocol 3.0 and so does this CLI. Server
//! frames are parsed strictly (`deny_unknown_fields`) and then checked for
//! the cross-field rules serde cannot express (`ServerFrame::validate`). A
//! frame that fails either is classified by [`control_frame_fault`] or
//! [`binary_frame_fault`]: it ends at most the request, terminal, command,
//! file op or speech session it names, except a malformed model-relay frame,
//! which ends the session.

pub mod canonical;
pub mod frames;
pub mod runtime_spec;

use anyhow::{Context, Result};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

pub use frames::{
    NodeBinaryMetadata, NodeFrame, ProtocolErrorCode, RELAY_PROTOCOL_VERSION, RELAY_SUBPROTOCOL,
    RelayFailure, ServerBinaryMetadata, ServerFrame,
};

pub const RELAY_JSON_CONTROL_MAX_BYTES: usize = 64 * 1024;
pub const RELAY_BINARY_CHUNK_MAX_BYTES: usize = 1024 * 1024;
pub const RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS: u64 = 20;
/// Request-body flow-control window shared with the server. The CLI buffers at
/// most this many streamed request-body chunks per request and returns one
/// credit (`relay.request.body.ack`) to the server for each chunk its upstream
/// request consumes. Mirrors `RELAY_REQUEST_BODY_WINDOW_CHUNKS` on the server.
pub const RELAY_REQUEST_BODY_WINDOW_CHUNKS: usize = 16;
/// Node telemetry list bounds; they mirror the server's strict schemas
/// (`apps/server/src/relay/frames.ts`).
/// Custom values in one `node.metrics` (16 commands × 16 metrics).
pub const NODE_METRICS_CUSTOM_MAX: usize = 256;
/// Values one metric command contributes.
pub const NODE_METRIC_COMMAND_VALUES_MAX: usize = 16;
pub const NODE_METRIC_COMMANDS_MAX: usize = 16;
pub const NODE_GPU_MAX: usize = 32;
pub const NODE_INTERFACE_MAX: usize = 32;
pub const NODE_INTERFACE_ADDRESS_MAX: usize = 16;
pub const NODE_DISK_MAX: usize = 16;

/// Browser terminals need a PTY, which this CLI only has on Unix.
pub fn terminal_supported() -> bool {
    cfg!(unix)
}

/// The fatal error for a `protocol.error` (or an older server's reply) that
/// arrives before `hello.ok`. A reply without a code comes from a server that
/// does not speak 3.0: say plainly to upgrade the server. A coded
/// `upgrade_cli` names the CLI and how to install the matching one.
pub fn hello_rejection_message(message: &str, code: Option<&ProtocolErrorCode>) -> String {
    match code {
        Some(ProtocolErrorCode::UpgradeServer) | None => format!(
            "the server rejected relay protocol {RELAY_PROTOCOL_VERSION} (`{message}`); upgrade the WS Model Proxy server or use an older wsmp"
        ),
        Some(ProtocolErrorCode::UpgradeCli) => format!(
            "relay protocol error: {message} This wsmp speaks relay protocol {RELAY_PROTOCOL_VERSION}. \
             Install the server's build by re-running its install.sh \
             (`curl -fsSL https://<your server>/install.sh | sh`), then restart wsmp"
        ),
        Some(_) => format!("relay protocol error: {message}"),
    }
}

/// Serializes one node frame after checking its cross-field rules and the
/// control-frame size cap.
pub fn encode_control(frame: &NodeFrame) -> Result<String> {
    frame
        .validate()
        .map_err(|error| anyhow::anyhow!("relay frame breaks a protocol rule: {error}"))?;
    crate::stt_wire::validate_node_frame(frame)?;
    let text = serde_json::to_string(frame).context("serializing relay control frame")?;
    anyhow::ensure!(
        text.len() <= RELAY_JSON_CONTROL_MAX_BYTES,
        "JSON control frame exceeds 64 KiB"
    );
    Ok(text)
}

/// Parses one server control frame strictly (shape, then cross-field rules).
pub fn parse_server_control(text: &str) -> Result<ServerFrame> {
    anyhow::ensure!(
        text.len() <= RELAY_JSON_CONTROL_MAX_BYTES,
        "JSON control frame exceeds 64 KiB"
    );
    let value: Value = serde_json::from_str(text).context("parsing relay server control frame")?;
    let type_name = value
        .get("type")
        .and_then(Value::as_str)
        .context("relay server control frame has no type")?;
    if type_name.starts_with("stt.")
        && let Some(config) = value.get("config")
    {
        // serde reads a struct from an array too; the server's strict schema
        // allows only an object of strings.
        let strict = config
            .as_object()
            .is_some_and(|fields| fields.values().all(Value::is_string));
        anyhow::ensure!(strict, "stt config must be an object of strings");
    }
    let frame: ServerFrame =
        serde_json::from_value(value).context("parsing relay server control frame")?;
    frame
        .validate()
        .map_err(|error| anyhow::anyhow!("relay server frame breaks a protocol rule: {error}"))?;
    crate::stt_wire::validate_server_frame(&frame)?;
    Ok(frame)
}

/// `[u32 big-endian metadata length][metadata JSON][body]`.
pub fn encode_binary_frame<M: Serialize>(metadata: &M, body: &[u8]) -> Result<Vec<u8>> {
    anyhow::ensure!(
        body.len() <= RELAY_BINARY_CHUNK_MAX_BYTES,
        "binary body chunk exceeds 1 MiB"
    );
    let metadata = serde_json::to_vec(metadata).context("serializing relay binary metadata")?;
    anyhow::ensure!(
        metadata.len() <= RELAY_JSON_CONTROL_MAX_BYTES,
        "binary frame metadata exceeds 64 KiB"
    );
    let metadata_len = u32::try_from(metadata.len()).context("binary metadata is too large")?;
    let mut frame = Vec::with_capacity(4 + metadata.len() + body.len());
    frame.extend_from_slice(&metadata_len.to_be_bytes());
    frame.extend_from_slice(&metadata);
    frame.extend_from_slice(body);
    Ok(frame)
}

/// Splits a binary frame and parses its metadata as `M` (strict serde).
pub fn decode_binary_frame<M: DeserializeOwned>(frame: &[u8]) -> Result<(M, Vec<u8>)> {
    anyhow::ensure!(frame.len() >= 4, "binary frame is missing metadata length");
    let metadata_len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    anyhow::ensure!(
        metadata_len <= RELAY_JSON_CONTROL_MAX_BYTES,
        "binary frame metadata exceeds 64 KiB"
    );
    let body_offset = 4 + metadata_len;
    anyhow::ensure!(
        body_offset <= frame.len(),
        "binary frame metadata length is invalid"
    );
    anyhow::ensure!(
        frame.len() - body_offset <= RELAY_BINARY_CHUNK_MAX_BYTES,
        "binary body chunk exceeds 1 MiB"
    );
    let metadata =
        serde_json::from_slice(&frame[4..body_offset]).context("parsing relay binary metadata")?;
    Ok((metadata, frame[body_offset..].to_vec()))
}

/// Parses a server binary frame and checks `stt.audio` against its limits.
pub fn parse_binary_frame(frame: &[u8]) -> Result<(ServerBinaryMetadata, Vec<u8>)> {
    let (metadata, body) = decode_binary_frame::<ServerBinaryMetadata>(frame)?;
    if let ServerBinaryMetadata::SttAudio { session_id, seq } = &metadata {
        crate::stt_wire::validate_audio_frame(session_id, *seq, body.len())?;
    }
    Ok((metadata, body))
}

/// Which session a server binary frame belongs to.
pub fn server_binary_routing_id(metadata: &ServerBinaryMetadata) -> &str {
    match metadata {
        ServerBinaryMetadata::RelayRequestBody { request_id, .. } => request_id,
        ServerBinaryMetadata::TermSealed { terminal_id, .. } => terminal_id,
        ServerBinaryMetadata::FileBody { op_id } => op_id,
        ServerBinaryMetadata::SttAudio { session_id, .. } => session_id,
    }
}

/// What a frame the daemon cannot accept as a normal message must do.
/// Malformed model-relay frames stay fatal. `term.*` and `exec.*` close only
/// the named session. Anything else is ignored so one bad frame cannot end
/// the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameFault {
    Fatal,
    Ignore,
    CloseTerminal {
        terminal_id: String,
    },
    /// A malformed frame that names a viewer removes only that viewer.
    DropViewer {
        terminal_id: String,
        viewer_id: String,
    },
    CloseCommand {
        command_id: String,
    },
    /// A malformed `exec.start` that names a command: refuse it, run nothing
    /// (a command already running under that id is left alone).
    RejectExec {
        command_id: String,
    },
    /// A malformed `file.op` that names an op: answer `file.rejected bad_frame`.
    RejectFile {
        op_id: String,
    },
    /// A malformed `stt.open` that names a session: answer `stt.error`.
    RejectStt {
        session_id: String,
    },
    /// Any other malformed `stt.*` frame (text or `stt.audio`) that names a
    /// session: a live session fails, an unknown one is ignored.
    FailStt {
        session_id: String,
    },
}

/// Classifies a server control frame that failed [`parse_server_control`].
pub fn control_frame_fault(text: &str) -> FrameFault {
    if text.len() > RELAY_JSON_CONTROL_MAX_BYTES {
        // Byte 256 can fall inside a multibyte char; `&str` indexing panics.
        // Walk back. `floor_char_boundary` is not stable on MSRV 1.88.
        let mut end = 256.min(text.len());
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        if text[..end].contains("\"relay.request\"") {
            return FrameFault::Fatal;
        }
        return FrameFault::Ignore;
    }
    // Not JSON at all (and not a frame whose strings only hold an escaped
    // lone surrogate): nothing in it can be attributed, and a server that
    // sends it is broken, so the session ends.
    let Some(value) = parse_for_fault(text) else {
        return FrameFault::Fatal;
    };
    interactive_fault(&value, true)
}

/// Parses a frame that failed its normal parse, only to learn what it names.
/// JSON allows a `\u` escape of an unpaired UTF-16 surrogate (RFC 8259
/// section 8.2), which no Rust string can hold, so serde_json refuses the
/// whole frame. Such escapes are read as U+FFFD here; nothing in a faulty
/// frame is ever acted on beyond the ids that name its request.
fn parse_for_fault(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }
    let repaired = replace_lone_surrogate_escapes(text)?;
    serde_json::from_str::<Value>(&repaired).ok()
}

fn hex_unit(bytes: &[u8], at: usize) -> Option<u16> {
    let digits = std::str::from_utf8(bytes.get(at..at + 4)?).ok()?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(digits, 16).ok()
}

/// `text` with every string escape of an unpaired surrogate replaced by
/// `\ufffd`, or `None` when it has none. Escaped pairs stay as they are.
fn replace_lone_surrogate_escapes(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut repaired = String::with_capacity(text.len());
    let mut copied = 0;
    let mut in_string = false;
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if !in_string {
            in_string = byte == b'"';
            at += 1;
            continue;
        }
        if byte == b'"' {
            in_string = false;
            at += 1;
            continue;
        }
        if byte != b'\\' {
            at += 1;
            continue;
        }
        let unit = (bytes.get(at + 1) == Some(&b'u'))
            .then(|| hex_unit(bytes, at + 2))
            .flatten();
        let Some(unit) = unit else {
            // Any other escape: skip the escaped character.
            at += 2;
            continue;
        };
        let paired = (0xD800..=0xDBFF).contains(&unit)
            && bytes.get(at + 6) == Some(&b'\\')
            && bytes.get(at + 7) == Some(&b'u')
            && hex_unit(bytes, at + 8).is_some_and(|low| (0xDC00..=0xDFFF).contains(&low));
        if paired {
            at += 12;
        } else if (0xD800..=0xDFFF).contains(&unit) {
            // Every cut is at an ASCII byte, so it is a char boundary.
            repaired.push_str(&text[copied..at]);
            repaired.push_str("\\ufffd");
            at += 6;
            copied = at;
        } else {
            at += 6;
        }
    }
    if copied == 0 {
        return None;
    }
    repaired.push_str(&text[copied..]);
    Some(repaired)
}

/// Parses a server binary frame, or says what its failure must do.
pub fn binary_frame_fault(frame: &[u8]) -> Result<(ServerBinaryMetadata, Vec<u8>), FrameFault> {
    parse_binary_frame(frame).map_err(|_| classify_binary_metadata(frame))
}

fn classify_binary_metadata(frame: &[u8]) -> FrameFault {
    if frame.len() < 4 {
        return FrameFault::Ignore;
    }
    let length = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if length > RELAY_JSON_CONTROL_MAX_BYTES || frame.len() < 4 + length {
        let head = &frame[4..frame.len().min(4 + 256)];
        if bytes_contain(head, b"relay.request.body") {
            return FrameFault::Fatal;
        }
        return FrameFault::Ignore;
    }
    let metadata = &frame[4..4 + length];
    let Some(value) = std::str::from_utf8(metadata).ok().and_then(parse_for_fault) else {
        if bytes_contain(metadata, b"relay.request.body") {
            return FrameFault::Fatal;
        }
        return FrameFault::Ignore;
    };
    let type_name = value.get("type").and_then(Value::as_str).unwrap_or("");
    if type_name == "relay.request.body" {
        return FrameFault::Fatal;
    }
    if !matches!(type_name, "term.sealed" | "file.body" | "stt.audio") {
        return FrameFault::Ignore;
    }
    interactive_fault(&value, false)
}

/// Every server control frame type of protocol 3.0.
fn known_server_frame(type_name: &str) -> bool {
    matches!(
        type_name,
        "hello.challenge"
            | "hello.ok"
            | "protocol.error"
            | "heartbeat.pong"
            | "trust.lower"
            | "runtime.define"
            | "runtime.detect"
            | "runtime.inventory.ok"
            | "runtime.inventory.error"
            | "runtime.job"
            | "relay.request"
            | "relay.cancel"
            | "term.open"
            | "term.attach"
            | "term.detach"
            | "term.close"
            | "term.auth"
            | "exec.start"
            | "exec.cancel"
            | "file.op"
            | "file.cancel"
            | "stt.open"
            | "stt.update"
            | "stt.commit"
            | "stt.clear"
            | "stt.close"
    )
}

fn interactive_fault(value: &Value, text_frame: bool) -> FrameFault {
    let type_name = value.get("type").and_then(Value::as_str).unwrap_or("");
    if type_name == "relay.request" || type_name == "relay.request.body" {
        return FrameFault::Fatal;
    }
    // A bad `file.op` is refused by name; any other bad `file.*` frame is
    // dropped (an unknown opId is never fatal).
    if type_name == "file.op"
        && let Some(op_id) = string_field(value, "opId").filter(|id| is_op_id_shaped(id))
    {
        return FrameFault::RejectFile { op_id };
    }
    if type_name.starts_with("file.") {
        return FrameFault::Ignore;
    }
    // Live speech-to-text: a bad frame concerns one session, never the
    // relay. A bad `stt.open` is refused by name so the server can try
    // another node at once; any other bad frame for a live session fails
    // that session (its audio or commands would be lost otherwise).
    if type_name.starts_with("stt.") {
        let Some(session_id) =
            string_field(value, "sessionId").filter(|id| crate::stt_wire::is_session_id(id))
        else {
            return FrameFault::Ignore;
        };
        if type_name == "stt.open" {
            return FrameFault::RejectStt { session_id };
        }
        return FrameFault::FailStt { session_id };
    }
    if type_name.starts_with("term.") {
        let Some(terminal_id) = string_field(value, "terminalId") else {
            return FrameFault::Ignore;
        };
        if type_name != "term.close"
            && let Some(viewer_id) = string_field(value, "viewerId")
        {
            return FrameFault::DropViewer {
                terminal_id,
                viewer_id,
            };
        }
        return FrameFault::CloseTerminal { terminal_id };
    }
    if type_name == "exec.start"
        && let Some(command_id) = string_field(value, "commandId")
    {
        return FrameFault::RejectExec { command_id };
    }
    if type_name.starts_with("exec.") {
        return match string_field(value, "commandId") {
            Some(command_id) => FrameFault::CloseCommand { command_id },
            None => FrameFault::Ignore,
        };
    }
    // A malformed frame of a known 3.0 type is a broken server; a frame type
    // this protocol does not have is refused and dropped.
    if text_frame && known_server_frame(type_name) {
        return FrameFault::Fatal;
    }
    FrameFault::Ignore
}

/// 22 base64url characters: the shape of a 16-byte `opId`. A rejection only
/// echoes ids of this shape, so a hostile frame cannot make one huge.
fn is_op_id_shaped(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Field names of an object, for strict metadata checks.
    fn keys(value: &Value) -> Vec<String> {
        value
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn binary(metadata: &[u8]) -> Vec<u8> {
        let mut frame = (metadata.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(metadata);
        frame
    }

    #[test]
    fn rejects_oversized_binary_chunks() {
        let metadata = NodeBinaryMetadata::RelayResponseBody {
            request_id: "request".to_string(),
            chunk_id: "0".to_string(),
            is_final: None,
        };
        let body = vec![0_u8; RELAY_BINARY_CHUNK_MAX_BYTES + 1];
        assert!(encode_binary_frame(&metadata, &body).is_err());
    }

    #[test]
    fn round_trips_binary_frames() {
        let metadata = ServerBinaryMetadata::RelayRequestBody {
            request_id: "request".to_string(),
            chunk_id: "0".to_string(),
            is_final: Some(true),
        };
        let encoded = encode_binary_frame(&metadata, b"abc").expect("encode");
        let (decoded, body) = parse_binary_frame(&encoded).expect("parse");
        assert_eq!(decoded, metadata);
        assert_eq!(body, b"abc");
        assert_eq!(server_binary_routing_id(&decoded), "request");

        let node = NodeBinaryMetadata::FileData {
            op_id: "op".to_string(),
        };
        let encoded = encode_binary_frame(&node, b"out").expect("encode");
        let (decoded, body) = decode_binary_frame::<NodeBinaryMetadata>(&encoded).expect("parse");
        assert_eq!(decoded, node);
        assert_eq!(body, b"out");
        let (value, _) = decode_binary_frame::<Value>(&encoded).expect("value");
        assert_eq!(keys(&value), ["opId", "type"]);
    }

    #[test]
    fn node_frames_are_checked_before_they_leave() {
        let bad = NodeFrame::RuntimeJobResult {
            step_id: "s".to_string(),
            instance_id: "i".to_string(),
            rank: 0,
            intent_hash: "h".to_string(),
            owner_epoch: "e".to_string(),
            status: frames::JobStatus::Failed,
            stopped: false,
            error: None,
            detail: None,
            terminal_id: None,
            exit_code: None,
        };
        assert!(encode_control(&bad).is_err());
        let heartbeat = NodeFrame::Heartbeat {
            id: "hb-1".to_string(),
            sent_at: None,
        };
        assert_eq!(
            encode_control(&heartbeat).expect("encodes"),
            r#"{"type":"heartbeat","id":"hb-1"}"#
        );
    }

    #[test]
    fn server_frames_are_parsed_strictly() {
        assert!(matches!(
            parse_server_control(r#"{"type":"heartbeat.pong","id":"1","receivedAt":"now"}"#),
            Ok(ServerFrame::HeartbeatPong { .. })
        ));
        // Unknown fields and 2.x frames are refused.
        assert!(
            parse_server_control(r#"{"type":"heartbeat.pong","id":"1","receivedAt":"now","x":1}"#)
                .is_err()
        );
        assert!(parse_server_control(r#"{"type":"inventory.ok","id":"1"}"#).is_err());
        // A hello.challenge without an origin (a 2.x server) is refused.
        assert!(parse_server_control(r#"{"type":"hello.challenge","nonce":"n"}"#).is_err());
        // An stt config must be an object of strings.
        let open = |config: &str| {
            format!(
                r#"{{"type":"stt.update","sessionId":"AAECAwQFBgcICQoLDA0ODw","config":{config}}}"#
            )
        };
        assert!(parse_server_control(&open("{}")).is_ok());
        assert!(parse_server_control(&open("[]")).is_err());
        assert!(parse_server_control(&open(r#"{"language":5}"#)).is_err());
    }

    #[test]
    fn malformed_term_open_is_not_fatal_and_unknown_binary_is_ignored() {
        assert_eq!(
            control_frame_fault(r#"{"type":"term.open","terminalId":"term-1"}"#),
            FrameFault::CloseTerminal {
                terminal_id: "term-1".to_string(),
            }
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"term.open"}"#),
            FrameFault::Ignore
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"exec.start"}"#),
            FrameFault::Ignore
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"exec.start","commandId":"cmd-1"}"#),
            FrameFault::RejectExec {
                command_id: "cmd-1".to_string(),
            }
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"exec.cancel","commandId":"cmd-1","x":{}}"#),
            FrameFault::CloseCommand {
                command_id: "cmd-1".to_string(),
            }
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"relay.request"}"#),
            FrameFault::Fatal
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"hello.ok"}"#),
            FrameFault::Fatal
        );
        // A removed 2.x frame type is dropped, never acted on.
        assert_eq!(
            control_frame_fault(r#"{"type":"term.spawn","commandId":"c"}"#),
            FrameFault::Ignore
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"metrics.sources.set","id":"1"}"#),
            FrameFault::Ignore
        );

        assert!(matches!(
            binary_frame_fault(&binary(br#"{"type":"no.such"}"#)),
            Err(FrameFault::Ignore)
        ));
        // Missing seq makes the known metadata fail schema validation.
        assert_eq!(
            binary_frame_fault(&binary(br#"{"type":"term.sealed","terminalId":"term-9"}"#))
                .expect_err("malformed sealed"),
            FrameFault::CloseTerminal {
                terminal_id: "term-9".to_string(),
            }
        );
        assert_eq!(
            binary_frame_fault(&binary(br#"{"type":"relay.request.body"}"#))
                .expect_err("malformed body"),
            FrameFault::Fatal
        );
    }

    #[test]
    fn a_lone_surrogate_fails_only_the_request_that_carries_it() {
        let exec = r#"{"type":"exec.start","commandId":"e","command":"ls","cwd":"\udc00"}"#;
        assert!(parse_server_control(exec).is_err());
        assert_eq!(
            control_frame_fault(exec),
            FrameFault::RejectExec {
                command_id: "e".to_string()
            }
        );
        // The id itself may be the bad string: it is still named, as U+FFFD.
        assert_eq!(
            control_frame_fault(r#"{"type":"exec.cancel","commandId":"\udbff"}"#),
            FrameFault::CloseCommand {
                command_id: "\u{fffd}".to_string()
            }
        );
        assert_eq!(
            control_frame_fault(
                r#"{"type":"term.attach","terminalId":"t","viewerId":"v","browserPublicKey":"\ud83d"}"#
            ),
            FrameFault::DropViewer {
                terminal_id: "t".to_string(),
                viewer_id: "v".to_string()
            }
        );
        // Model relay frames and frames naming nothing stay fatal.
        assert_eq!(
            control_frame_fault(r#"{"type":"relay.request","path":"\ud800"}"#),
            FrameFault::Fatal
        );
        assert_eq!(control_frame_fault("not json \\ud800"), FrameFault::Fatal);
        assert_eq!(
            binary_frame_fault(&binary(
                br#"{"type":"term.sealed","terminalId":"t9","x":"\udfff"}"#
            ))
            .expect_err("malformed sealed"),
            FrameFault::CloseTerminal {
                terminal_id: "t9".to_string()
            }
        );
    }

    #[test]
    fn only_unpaired_surrogate_escapes_are_replaced() {
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"plain \u0041"}"#),
            None
        );
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"\ud83d\ude00"}"#),
            None
        );
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\\ud800"}"#), None);
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"x\ud800y","b":"\udc00","c":"\ud800\u0041"}"#)
                .as_deref(),
            Some(r#"{"a":"x\ufffdy","b":"\ufffd","c":"\ufffd\u0041"}"#)
        );
        assert_eq!(replace_lone_surrogate_escapes(r#"{\ud800}"#), None);
    }

    #[test]
    fn oversized_multibyte_control_frame_is_ignored_without_panic() {
        let text = "你".repeat((RELAY_JSON_CONTROL_MAX_BYTES / 3) + 2);
        assert!(text.len() > RELAY_JSON_CONTROL_MAX_BYTES);
        assert!(!text.is_char_boundary(256));
        assert_eq!(control_frame_fault(&text), FrameFault::Ignore);

        let mut fatal = r#"{"type":"relay.request"}"#.to_string();
        fatal.push_str(&"你".repeat((RELAY_JSON_CONTROL_MAX_BYTES / 3) + 2));
        assert!(!fatal.is_char_boundary(256));
        assert_eq!(control_frame_fault(&fatal), FrameFault::Fatal);
    }

    #[test]
    fn rejection_messages_name_who_must_upgrade() {
        let message = hello_rejection_message("Malformed relay protocol message.", None);
        assert!(
            message.contains(&format!("rejected relay protocol {RELAY_PROTOCOL_VERSION}")),
            "{message}"
        );
        assert!(message.contains("upgrade the WS Model Proxy server"));
        let reply = "This server requires a newer wsmp. Upgrade wsmp and restart it.";
        let upgrade_cli = hello_rejection_message(reply, Some(&ProtocolErrorCode::UpgradeCli));
        assert!(
            upgrade_cli.starts_with(&format!("relay protocol error: {reply}")),
            "{upgrade_cli}"
        );
        assert!(upgrade_cli.contains("install.sh"), "{upgrade_cli}");
    }

    #[test]
    fn malformed_frames_naming_a_viewer_drop_only_that_viewer() {
        assert_eq!(
            control_frame_fault(r#"{"type":"term.auth","terminalId":"t","viewerId":"v"}"#),
            FrameFault::DropViewer {
                terminal_id: "t".to_string(),
                viewer_id: "v".to_string(),
            }
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"term.close","terminalId":"t","viewerId":"v"}"#),
            FrameFault::CloseTerminal {
                terminal_id: "t".to_string(),
            }
        );
        assert_eq!(
            binary_frame_fault(&binary(
                br#"{"type":"term.sealed","terminalId":"t","viewerId":"v"}"#
            ))
            .expect_err("malformed"),
            FrameFault::DropViewer {
                terminal_id: "t".to_string(),
                viewer_id: "v".to_string(),
            }
        );
    }

    #[test]
    fn a_malformed_file_op_is_rejected_by_name_and_other_bad_file_frames_are_ignored() {
        let id = "AAECAwQFBgcICQoLDA0ODw";
        let missing = format!(r#"{{"type":"file.op","opId":"{id}","op":"read"}}"#);
        assert!(parse_server_control(&missing).is_err());
        assert!(matches!(
            control_frame_fault(&missing),
            FrameFault::RejectFile { op_id } if op_id == id
        ));
        // 2.x consent fields are refused too, by name.
        let with_mode = format!(
            r#"{{"type":"file.op","opId":"{id}","op":"read","args":{{}},"mode":"unsupervised","readGrant":true}}"#
        );
        assert!(parse_server_control(&with_mode).is_err());
        assert!(matches!(
            control_frame_fault(&with_mode),
            FrameFault::RejectFile { .. }
        ));
        for text in [
            r#"{"type":"file.op","op":"read"}"#,
            r#"{"type":"file.op","opId":"short","op":"read"}"#,
            r#"{"type":"file.cancel"}"#,
            r#"{"type":"file.cancel","opId":7}"#,
        ] {
            assert!(
                matches!(control_frame_fault(text), FrameFault::Ignore),
                "{text}"
            );
        }
        let mut frame = binary(br#"{"type":"file.body"}"#);
        frame.extend_from_slice(b"x");
        assert!(matches!(
            binary_frame_fault(&frame),
            Err(FrameFault::Ignore)
        ));
    }
}
