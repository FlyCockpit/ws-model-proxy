//! Relay protocol frame helpers matching `apps/server/src/relay/protocol.ts`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::{CapabilityOverrideMode, EndpointConfig, OpenAiCompatibleCapabilities};

pub const RELAY_PROTOCOL_VERSION: &str = "2.0";
pub const RELAY_SUBPROTOCOL: &str = "ws-model-proxy.relay.v2";
pub const RELAY_JSON_CONTROL_MAX_BYTES: usize = 64 * 1024;
pub const RELAY_BINARY_CHUNK_MAX_BYTES: usize = 1024 * 1024;
pub const RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS: u64 = 20;
/// Request-body flow-control window shared with the server. The CLI buffers at
/// most this many streamed request-body chunks per request and returns one
/// credit (`relay.request.body.ack`) to the server for each chunk its upstream
/// request consumes. Mirrors `RELAY_REQUEST_BODY_WINDOW_CHUNKS` on the server.
pub const RELAY_REQUEST_BODY_WINDOW_CHUNKS: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientControlMessage {
    #[serde(rename = "hello")]
    Hello {
        id: String,
        protocol_version: String,
        cli: CliInventory,
        endpoints: Vec<EndpointInventory>,
    },
    #[serde(rename = "inventory.update")]
    InventoryUpdate {
        id: String,
        endpoints: Vec<EndpointInventory>,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sent_at: Option<String>,
    },
    #[serde(rename = "relay.request.body.ack")]
    RelayRequestBodyAck { request_id: String, credits: u32 },
    #[serde(rename = "relay.response.headers")]
    RelayResponseHeaders {
        request_id: String,
        status: u16,
        headers: std::collections::BTreeMap<String, String>,
    },
    #[serde(rename = "relay.complete")]
    RelayComplete { request_id: String },
    #[serde(rename = "relay.error")]
    RelayError {
        request_id: String,
        failure: RelayFailure,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        upstream_status_code: Option<u16>,
    },
    #[serde(rename = "relay.cancelled")]
    RelayCancelled { request_id: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInventory {
    pub slug: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub capabilities: CliCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCapabilities {
    pub protocol_version: String,
    pub binary_frames: bool,
    pub cancellation: bool,
    pub max_binary_chunk_bytes: usize,
    pub request_body_streaming: bool,
    pub request_body_window_chunks: usize,
}

impl Default for CliCapabilities {
    fn default() -> Self {
        Self {
            protocol_version: RELAY_PROTOCOL_VERSION.to_string(),
            binary_frames: true,
            cancellation: true,
            max_binary_chunk_bytes: RELAY_BINARY_CHUNK_MAX_BYTES,
            request_body_streaming: true,
            request_body_window_chunks: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInventory {
    pub slug: String,
    pub label: String,
    pub kind: String,
    pub status: EndpointStatus,
    pub default_capabilities: OpenAiCompatibleCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_suggestions: Option<OpenAiCompatibleCapabilities>,
    pub models: Vec<DiscoveredModelInventory>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointStatus {
    Unknown,
    Online,
    Offline,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModelInventory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    pub upstream_model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<OpenAiCompatibleCapabilities>,
    pub capability_override_mode: CapabilityOverrideMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_suggestions: Option<OpenAiCompatibleCapabilities>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerControlMessage {
    #[serde(rename = "hello.ok")]
    HelloOk {
        id: String,
        protocol_version: String,
    },
    #[serde(rename = "heartbeat.pong")]
    HeartbeatPong { id: String, received_at: String },
    #[serde(rename = "relay.request")]
    RelayRequest {
        request_id: String,
        family: String,
        method: String,
        path: String,
        headers: std::collections::BTreeMap<String, String>,
        timeout_ms: u64,
        expect_body: bool,
    },
    #[serde(rename = "relay.cancel")]
    RelayCancel {
        request_id: String,
        reason: RelayFailure,
    },
    #[serde(rename = "protocol.error")]
    ProtocolError {
        failure: RelayFailure,
        message: String,
        request_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayFailure {
    Transport,
    Timeout,
    Disconnected,
    Upstream5xx,
    Upstream4xx,
    UnsupportedCapability,
    NotFound,
    AccessDenied,
    RateLimited,
    RequestTooLarge,
    Cancelled,
    ProtocolError,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayBinaryFrameMetadata {
    pub r#type: RelayBinaryFrameType,
    pub request_id: String,
    pub chunk_id: String,
    #[serde(rename = "final", skip_serializing_if = "Option::is_none")]
    pub final_chunk: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RelayBinaryFrameType {
    #[serde(rename = "relay.request.body")]
    RequestBody,
    #[serde(rename = "relay.response.body")]
    ResponseBody,
}

pub fn endpoint_inventory(endpoint: &EndpointConfig, status: EndpointStatus) -> EndpointInventory {
    EndpointInventory {
        slug: endpoint.slug.clone(),
        label: endpoint.label.clone(),
        kind: "openai-compatible".to_string(),
        status,
        default_capabilities: endpoint.default_capabilities.clone(),
        probe_suggestions: endpoint
            .last_probe
            .as_ref()
            .map(|probe| probe.suggested_capabilities.clone()),
        models: endpoint
            .models
            .iter()
            .map(|model| DiscoveredModelInventory {
                slug: model.slug.clone(),
                upstream_model_id: model.upstream_model_id.clone(),
                capabilities: model.capabilities.clone(),
                capability_override_mode: model.capability_override_mode.clone(),
                probe_suggestions: model.probe_suggestions.clone(),
            })
            .collect(),
    }
}

pub fn encode_control(message: &ClientControlMessage) -> Result<String> {
    let text = serde_json::to_string(message).context("serializing relay control frame")?;
    if text.len() > RELAY_JSON_CONTROL_MAX_BYTES {
        anyhow::bail!("JSON control frame exceeds 64 KiB");
    }
    Ok(text)
}

pub fn parse_server_control(text: &str) -> Result<ServerControlMessage> {
    if text.len() > RELAY_JSON_CONTROL_MAX_BYTES {
        anyhow::bail!("JSON control frame exceeds 64 KiB");
    }
    serde_json::from_str(text).context("parsing relay server control frame")
}

pub fn encode_binary_frame(metadata: &RelayBinaryFrameMetadata, body: &[u8]) -> Result<Vec<u8>> {
    if body.len() > RELAY_BINARY_CHUNK_MAX_BYTES {
        anyhow::bail!("binary body chunk exceeds 1 MiB");
    }
    let metadata = serde_json::to_vec(metadata).context("serializing relay binary metadata")?;
    if metadata.len() > RELAY_JSON_CONTROL_MAX_BYTES {
        anyhow::bail!("binary frame metadata exceeds 64 KiB");
    }
    let metadata_len = u32::try_from(metadata.len()).context("binary metadata is too large")?;
    let mut frame = Vec::with_capacity(4 + metadata.len() + body.len());
    frame.extend_from_slice(&metadata_len.to_be_bytes());
    frame.extend_from_slice(&metadata);
    frame.extend_from_slice(body);
    Ok(frame)
}

pub fn parse_binary_frame(frame: &[u8]) -> Result<(RelayBinaryFrameMetadata, Vec<u8>)> {
    if frame.len() < 4 {
        anyhow::bail!("binary frame is missing metadata length");
    }
    let length_bytes: [u8; 4] = frame[0..4]
        .try_into()
        .context("reading binary metadata length")?;
    let metadata_len = u32::from_be_bytes(length_bytes) as usize;
    if metadata_len > RELAY_JSON_CONTROL_MAX_BYTES {
        anyhow::bail!("binary frame metadata exceeds 64 KiB");
    }
    let body_offset = 4 + metadata_len;
    if body_offset > frame.len() {
        anyhow::bail!("binary frame metadata length is invalid");
    }
    let body_len = frame.len() - body_offset;
    if body_len > RELAY_BINARY_CHUNK_MAX_BYTES {
        anyhow::bail!("binary body chunk exceeds 1 MiB");
    }
    let metadata =
        serde_json::from_slice(&frame[4..body_offset]).context("parsing relay binary metadata")?;
    Ok((metadata, frame[body_offset..].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_binary_chunks() {
        let metadata = RelayBinaryFrameMetadata {
            r#type: RelayBinaryFrameType::ResponseBody,
            request_id: "request".to_string(),
            chunk_id: "0".to_string(),
            final_chunk: None,
        };
        let body = vec![0_u8; RELAY_BINARY_CHUNK_MAX_BYTES + 1];
        assert!(encode_binary_frame(&metadata, &body).is_err());
    }

    #[test]
    fn round_trips_binary_frame() {
        let metadata = RelayBinaryFrameMetadata {
            r#type: RelayBinaryFrameType::RequestBody,
            request_id: "request".to_string(),
            chunk_id: "0".to_string(),
            final_chunk: Some(true),
        };
        let encoded = encode_binary_frame(&metadata, b"abc").expect("encode");
        let (decoded, body) = parse_binary_frame(&encoded).expect("parse");
        assert_eq!(decoded, metadata);
        assert_eq!(body, b"abc");
    }

    #[test]
    fn control_frames_use_server_field_casing() {
        let message = ClientControlMessage::Hello {
            id: "hello-1".to_string(),
            protocol_version: RELAY_PROTOCOL_VERSION.to_string(),
            cli: CliInventory {
                slug: "desktop".to_string(),
                label: "Desktop".to_string(),
                version: None,
                capabilities: CliCapabilities::default(),
            },
            endpoints: vec![EndpointInventory {
                slug: "local".to_string(),
                label: "Local".to_string(),
                kind: "openai-compatible".to_string(),
                status: EndpointStatus::Online,
                default_capabilities: OpenAiCompatibleCapabilities::openai_defaults(),
                probe_suggestions: None,
                models: Vec::new(),
            }],
        };

        let encoded = encode_control(&message).expect("encode");

        assert!(encoded.contains(r#""protocolVersion":"2.0""#));
        assert!(encoded.contains(r#""maxBinaryChunkBytes":1048576"#));
        assert!(encoded.contains(r#""requestBodyStreaming":true"#));
        assert!(encoded.contains(r#""requestBodyWindowChunks":16"#));
        assert!(!encoded.contains("protocol_version"));
        assert!(!encoded.contains(":null"));

        let ack = encode_control(&ClientControlMessage::RelayRequestBodyAck {
            request_id: "request-1".to_string(),
            credits: 3,
        })
        .expect("encode ack");
        assert!(ack.contains(r#""type":"relay.request.body.ack""#));
        assert!(ack.contains(r#""requestId":"request-1""#));
        assert!(ack.contains(r#""credits":3"#));

        let heartbeat = encode_control(&ClientControlMessage::Heartbeat {
            id: "heartbeat-1".to_string(),
            sent_at: None,
        })
        .expect("encode heartbeat");
        assert!(!heartbeat.contains("sentAt"));
        assert!(!heartbeat.contains(":null"));

        let relay_error = encode_control(&ClientControlMessage::RelayError {
            request_id: "request-1".to_string(),
            failure: RelayFailure::Transport,
            message: None,
            upstream_status_code: None,
        })
        .expect("encode relay error");
        assert!(!relay_error.contains("message"));
        assert!(!relay_error.contains("upstreamStatusCode"));
        assert!(!relay_error.contains(":null"));

        let parsed = parse_server_control(
            r#"{"type":"relay.request","requestId":"request-1","family":"generic","method":"POST","path":"/v1/chat/completions","headers":{},"timeoutMs":30000,"expectBody":true}"#,
        )
        .expect("parse server control");
        match parsed {
            ServerControlMessage::RelayRequest {
                request_id,
                timeout_ms,
                expect_body,
                ..
            } => {
                assert_eq!(request_id, "request-1");
                assert_eq!(timeout_ms, 30_000);
                assert!(expect_body);
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }
}
