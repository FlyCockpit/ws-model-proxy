//! Relay protocol frame helpers matching `apps/server/src/relay/protocol.ts`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::config::{
    CapabilityOverrideMode, EndpointConfig, EndpointKind, McpCommandMode,
    OpenAiCompatibleCapabilities,
};
pub use crate::terminal_identity::TerminalIdentityProof;

pub const RELAY_PROTOCOL_VERSION: &str = "2.6";
pub const RELAY_SUBPROTOCOL: &str = "ws-model-proxy.relay.v2";
pub const RELAY_JSON_CONTROL_MAX_BYTES: usize = 64 * 1024;
pub const RELAY_BINARY_CHUNK_MAX_BYTES: usize = 1024 * 1024;
pub const RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS: u64 = 20;
/// Request-body flow-control window shared with the server. The CLI buffers at
/// most this many streamed request-body chunks per request and returns one
/// credit (`relay.request.body.ack`) to the server for each chunk its upstream
/// request consumes. Mirrors `RELAY_REQUEST_BODY_WINDOW_CHUNKS` on the server.
pub const RELAY_REQUEST_BODY_WINDOW_CHUNKS: usize = 16;
/// What a pre-2.6 server answers when its strict hello schema rejects a 2.6 hello.
pub const OLDER_SERVER_HELLO_REJECTION: &str = "Malformed relay protocol message.";

/// The fatal error for a `protocol.error` that arrives before `hello.ok`.
/// A pre-2.6 server rejects the 2.6 hello as malformed; say so plainly.
pub fn hello_rejection_message(message: &str) -> String {
    if message == OLDER_SERVER_HELLO_REJECTION {
        format!(
            "the server rejected relay protocol {RELAY_PROTOCOL_VERSION} (`{message}`); upgrade the WS Model Proxy server or use an older wsmp"
        )
    } else {
        format!("relay protocol error: {message}")
    }
}

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
        /// Ordered pairs preserve repeated fields such as `warning` and
        /// `x-ratelimit-*`; servers also accept the legacy object form.
        headers: Vec<(String, String)>,
    },
    #[serde(rename = "relay.complete")]
    RelayComplete {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<RelayUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        metrics: Option<RelayMetrics>,
    },
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
    #[serde(rename = "term.pending")]
    TermPending {
        terminal_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        cli_nonce: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        approval_code: Option<String>,
    },
    #[serde(rename = "term.opened")]
    TermOpened {
        terminal_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        cli_nonce: String,
    },
    #[serde(rename = "term.attached")]
    TermAttached {
        terminal_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        cli_nonce: String,
    },
    #[serde(rename = "term.rejected")]
    TermRejected {
        terminal_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        approval_code: Option<String>,
    },
    /// 2.5 only. The viewer that most recently typed; omitted when there is
    /// no writer. Carries no size.
    #[serde(rename = "term.writer")]
    TermWriter {
        terminal_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
    },
    /// Browser input for this terminal was dropped because the CLI's
    /// per-terminal input queue was full (the program is not reading). The
    /// relay shows that viewer its "input dropped" notice. Sent once per run
    /// of dropped frames per viewer; `viewerId` is omitted on a 2.4 terminal.
    #[serde(rename = "term.input_dropped")]
    TermInputDropped {
        terminal_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
    },
    #[serde(rename = "term.exit")]
    TermExit {
        terminal_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
    /// A supervised terminal's confirm screen is running (no viewers yet).
    #[serde(rename = "term.spawned")]
    TermSpawned {
        terminal_id: String,
        command_id: String,
    },
    /// `term.spawn` was refused; nothing ran.
    #[serde(rename = "supervised.rejected")]
    SupervisedRejected { command_id: String, reason: String },
    /// Enter was pressed on the drawn confirm screen; the command was exec'd.
    #[serde(rename = "supervised.accepted")]
    SupervisedAccepted { command_id: String },
    /// Declined on the confirm screen, or the confirm child ended without accepting.
    #[serde(rename = "supervised.declined")]
    SupervisedDeclined { command_id: String },
    /// The accepted command exited. `review`: output was withheld for review.
    /// `output_bytes` only when `supervised.output` frames were sent.
    #[serde(rename = "supervised.done")]
    SupervisedDone {
        command_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
        review: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_bytes: Option<u64>,
    },
    #[serde(rename = "exec.started")]
    ExecStarted { command_id: String },
    #[serde(rename = "exec.rejected")]
    ExecRejected { command_id: String, reason: String },
    #[serde(rename = "exec.done")]
    ExecDone {
        command_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
        timed_out: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesiredModelCapability {
    pub endpoint_slug: String,
    pub upstream_model_id: String,
    pub capability_override_mode: CapabilityOverrideMode,
    pub capabilities: OpenAiCompatibleCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "prompt_tokens")]
    pub prompt_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "completion_tokens")]
    pub completion_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "total_tokens")]
    pub total_tokens: Option<u32>,
}

/// Internal benchmark metrics, deliberately separate from provider usage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayMetrics {
    pub completion_tokens: u32,
    pub tokenizer: RelayMetricTokenizer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayMetricTokenizer {
    Cl100kBase,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInventory {
    pub slug: String,
    /// This machine's hostname, a reported fact. Omitted when unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub capabilities: CliCapabilities,
}

/// Startup feature flags and the daemon's terminal public key.
///
/// Hello capabilities are built from this snapshot. Later config reloads do not
/// change it.
#[derive(Debug, Clone)]
pub struct TerminalFeatureSnapshot {
    pub allow_human_terminal: bool,
    pub mcp_command_mode: McpCommandMode,
    pub require_terminal_approval: bool,
    /// 65-byte uncompressed SEC1, base64url without padding.
    pub terminal_public_key_b64url: String,
    /// The persistent identity key and its signature over the ECDH key above.
    /// `None` when the identity file could not be loaded.
    pub terminal_identity: Option<TerminalIdentityProof>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliReportedFeatures {
    pub human_terminal: bool,
    pub mcp_command_mode: McpCommandMode,
    pub terminal_approval: bool,
    pub terminal_supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCapabilities {
    pub protocol_version: String,
    pub inventory_ack: bool,
    pub inventory_replace: bool,
    pub endpoint_targeting: bool,
    pub binary_frames: bool,
    pub cancellation: bool,
    pub max_binary_chunk_bytes: usize,
    pub request_body_streaming: bool,
    pub request_body_window_chunks: usize,
    pub shared_tokenizer_tps: bool,
    pub standardized_metrics: bool,
    pub terminal: bool,
    pub exec: bool,
    pub features: CliReportedFeatures,
    pub terminal_public_key: String,
    pub terminal_viewers: bool,
    /// 2.6: this CLI implements supervised terminals (`term.spawn`).
    pub supervised_commands: bool,
    /// The browser pins this key and checks the signature before any
    /// terminal handshake.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_identity: Option<TerminalIdentityProof>,
}

impl CliCapabilities {
    pub fn from_snapshot(snapshot: &TerminalFeatureSnapshot) -> Self {
        Self {
            protocol_version: RELAY_PROTOCOL_VERSION.to_string(),
            inventory_ack: true,
            inventory_replace: true,
            endpoint_targeting: true,
            binary_frames: true,
            cancellation: true,
            max_binary_chunk_bytes: RELAY_BINARY_CHUNK_MAX_BYTES,
            request_body_streaming: true,
            request_body_window_chunks: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
            shared_tokenizer_tps: true,
            standardized_metrics: true,
            terminal: true,
            exec: true,
            features: CliReportedFeatures {
                human_terminal: snapshot.allow_human_terminal,
                mcp_command_mode: snapshot.mcp_command_mode,
                terminal_approval: snapshot.require_terminal_approval,
                terminal_supported: cfg!(unix),
            },
            terminal_public_key: snapshot.terminal_public_key_b64url.clone(),
            terminal_viewers: true,
            supervised_commands: true,
            terminal_identity: snapshot.terminal_identity.clone(),
        }
    }
}

pub fn terminal_supported() -> bool {
    cfg!(unix)
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
    /// Omitted from the inventory digest. The server stores it on create and
    /// when an auto capacity limit is still null.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency_limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRevision {
    pub inventory_seq: u64,
    pub inventory_digest: String,
    pub inventory_acknowledged_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdentity {
    pub public_key: String,
    /// Present on `term.auth`. Open and attach carry the public key only; the
    /// signature is over a transcript that includes the CLI nonce from `term.pending`.
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum KnownServerControlMessage {
    #[serde(rename = "hello.ok")]
    HelloOk {
        id: String,
        protocol_version: String,
        revision: InventoryRevision,
        #[serde(default)]
        desired_capabilities: Vec<DesiredModelCapability>,
    },
    #[serde(rename = "inventory.ok")]
    InventoryOk {
        id: String,
        revision: InventoryRevision,
        #[serde(default)]
        desired_capabilities: Vec<DesiredModelCapability>,
    },
    #[serde(rename = "inventory.error")]
    InventoryError { id: String, message: String },
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
        endpoint_slug: String,
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
    #[serde(rename = "term.open")]
    TermOpen {
        terminal_id: String,
        cols: u16,
        rows: u16,
        browser_public_key: String,
        browser_nonce: String,
        #[serde(default)]
        identity: Option<TerminalIdentity>,
        #[serde(default)]
        viewer_id: Option<String>,
    },
    #[serde(rename = "term.attach")]
    TermAttach {
        terminal_id: String,
        #[serde(default)]
        viewer_id: Option<String>,
        browser_public_key: String,
        browser_nonce: String,
        #[serde(default)]
        identity: Option<TerminalIdentity>,
    },
    #[serde(rename = "term.detach")]
    TermDetach {
        terminal_id: String,
        #[serde(default)]
        viewer_id: Option<String>,
    },
    #[serde(rename = "term.close")]
    TermClose { terminal_id: String },
    #[serde(rename = "term.auth")]
    TermAuth {
        terminal_id: String,
        #[serde(default)]
        viewer_id: Option<String>,
        signature: String,
    },
    #[serde(rename = "exec.start")]
    ExecStart {
        command_id: String,
        command: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    #[serde(rename = "exec.cancel")]
    ExecCancel { command_id: String },
    #[serde(rename = "term.spawn")]
    TermSpawn {
        terminal_id: String,
        command_id: String,
        command: String,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        requester: String,
        share_output: bool,
    },
    #[serde(rename = "supervised.cancel")]
    SupervisedCancel {
        command_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

/// A supervised command request, as `term.spawn` carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisedSpawn {
    pub terminal_id: String,
    pub command_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub reason: Option<String>,
    pub requester: String,
    pub share_output: bool,
}

#[derive(Debug, Clone)]
pub enum ServerControlMessage {
    HelloOk {
        id: String,
        protocol_version: String,
        revision: InventoryRevision,
        desired_capabilities: Vec<DesiredModelCapability>,
    },
    InventoryOk {
        id: String,
        revision: InventoryRevision,
        desired_capabilities: Vec<DesiredModelCapability>,
    },
    InventoryError {
        id: String,
        message: String,
    },
    HeartbeatPong {
        id: String,
        received_at: String,
    },
    RelayRequest {
        request_id: String,
        family: String,
        method: String,
        path: String,
        headers: std::collections::BTreeMap<String, String>,
        timeout_ms: u64,
        endpoint_slug: String,
        expect_body: bool,
    },
    RelayCancel {
        request_id: String,
        reason: RelayFailure,
    },
    ProtocolError {
        failure: RelayFailure,
        message: String,
        request_id: Option<String>,
    },
    TermOpen {
        terminal_id: String,
        cols: u16,
        rows: u16,
        browser_public_key: String,
        browser_nonce: String,
        identity: Option<TerminalIdentity>,
        viewer_id: Option<String>,
    },
    TermAttach {
        terminal_id: String,
        viewer_id: Option<String>,
        browser_public_key: String,
        browser_nonce: String,
        identity: Option<TerminalIdentity>,
    },
    TermDetach {
        terminal_id: String,
        viewer_id: Option<String>,
    },
    TermClose {
        terminal_id: String,
    },
    TermAuth {
        terminal_id: String,
        viewer_id: Option<String>,
        signature: String,
    },
    ExecStart {
        command_id: String,
        command: String,
        cwd: Option<String>,
    },
    ExecCancel {
        command_id: String,
    },
    TermSpawn(SupervisedSpawn),
    SupervisedCancel {
        command_id: String,
        /// `true` for the server's confirm deadline (`reason: "expire"`) or a
        /// browser decline (`reason: "decline"`): a request the CLI decides
        /// against an Enter it may already have taken. Without a reason (or
        /// with another one) the terminal simply ends.
        if_waiting: bool,
    },
    Unknown {
        type_name: String,
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
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum RelayBinaryFrameMetadata {
    #[serde(rename = "relay.request.body")]
    RequestBody {
        request_id: String,
        chunk_id: String,
        #[serde(rename = "final", default, skip_serializing_if = "Option::is_none")]
        final_chunk: Option<bool>,
    },
    #[serde(rename = "relay.response.body")]
    ResponseBody {
        request_id: String,
        chunk_id: String,
        #[serde(rename = "final", default, skip_serializing_if = "Option::is_none")]
        final_chunk: Option<bool>,
    },
    /// 2.5 adds exactly one routing field on CLI->browser frames: `viewerId`
    /// for unicast (pairwise keys) or `epoch` for broadcast (shared output
    /// key). Browser->CLI frames carry the `viewerId` the server stamped.
    /// 2.4 frames carry neither.
    #[serde(rename = "term.sealed")]
    TermSealed {
        terminal_id: String,
        seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        epoch: Option<u32>,
    },
    #[serde(rename = "exec.stdout")]
    ExecStdout { command_id: String, seq: u64 },
    #[serde(rename = "exec.stderr")]
    ExecStderr { command_id: String, seq: u64 },
    /// Shared supervised output (never while under review): the first bytes
    /// (`head`) or the last bytes (`tail`) after the accept marker.
    #[serde(rename = "supervised.output")]
    SupervisedOutput {
        command_id: String,
        part: SupervisedOutputPart,
        seq: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupervisedOutputPart {
    Head,
    Tail,
}

impl RelayBinaryFrameMetadata {
    pub fn routing_id(&self) -> &str {
        match self {
            Self::RequestBody { request_id, .. } | Self::ResponseBody { request_id, .. } => {
                request_id
            }
            Self::TermSealed { terminal_id, .. } => terminal_id,
            Self::ExecStdout { command_id, .. }
            | Self::ExecStderr { command_id, .. }
            | Self::SupervisedOutput { command_id, .. } => command_id,
        }
    }
}

pub fn endpoint_inventory(endpoint: &EndpointConfig, status: EndpointStatus) -> EndpointInventory {
    let mut default_capabilities = endpoint.default_capabilities.clone();
    if endpoint.engine.accepts_top_k() {
        default_capabilities.advertise_top_k();
    }
    EndpointInventory {
        slug: endpoint.slug.clone(),
        label: endpoint.label.clone(),
        kind: match endpoint.kind {
            EndpointKind::OpenAiCompatible => "openai-compatible",
            EndpointKind::AnthropicCompatible => "anthropic-compatible",
        }
        .to_string(),
        status,
        default_capabilities,
        probe_suggestions: endpoint
            .last_probe
            .as_ref()
            .map(|probe| probe.suggested_capabilities.clone()),
        models: endpoint
            .models
            .iter()
            .map(|model| {
                let mut capabilities = model.capabilities.clone();
                if endpoint.engine.accepts_top_k()
                    && let Some(capabilities) = capabilities.as_mut()
                {
                    capabilities.advertise_top_k();
                }
                DiscoveredModelInventory {
                    slug: model.slug.clone(),
                    upstream_model_id: model.upstream_model_id.clone(),
                    capabilities,
                    capability_override_mode: model.capability_override_mode.clone(),
                    probe_suggestions: model.probe_suggestions.clone(),
                    concurrency_limit: endpoint.concurrency_limit,
                }
            })
            .collect(),
    }
}

/// SHA-256 identity for the server's complete inventory replacement snapshot.
///
/// This deliberately excludes volatile probe health and suggestions. It mirrors
/// `inventoryDigestFor` in the server registration module: object keys are
/// sorted recursively, endpoints are ordered by slug, and models by upstream
/// model id. Keep the test vector below in sync with that implementation.
pub fn inventory_digest(endpoints: &[EndpointInventory]) -> String {
    let mut identity = endpoints
        .iter()
        .map(|endpoint| {
            let mut models = endpoint
                .models
                .iter()
                .map(|model| {
                    json!({
                        "slug": &model.slug,
                        "upstreamModelId": &model.upstream_model_id,
                        "capabilityOverrideMode": &model.capability_override_mode,
                        "capabilities": &model.capabilities,
                    })
                })
                .collect::<Vec<_>>();
            models.sort_by(|left, right| {
                left["upstreamModelId"]
                    .as_str()
                    .cmp(&right["upstreamModelId"].as_str())
            });
            json!({
                "slug": &endpoint.slug,
                "label": &endpoint.label,
                "kind": &endpoint.kind,
                "defaultCapabilities": &endpoint.default_capabilities,
                "models": models,
            })
        })
        .collect::<Vec<_>>();
    identity.sort_by(|left, right| left["slug"].as_str().cmp(&right["slug"].as_str()));
    let canonical = stable_json(&Value::Array(identity));
    // digest 0.11 returns `hybrid_array::Array`, which (unlike the old
    // `generic_array::GenericArray`) does not implement `LowerHex`, so encode
    // the bytes ourselves rather than pull in a hex crate.
    Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn stable_json(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.to_string(),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => stable_object_json(values),
    }
}

fn stable_object_json(values: &Map<String, Value>) -> String {
    let mut keys = values.keys().collect::<Vec<_>>();
    keys.sort_unstable();
    format!(
        "{{{}}}",
        keys.into_iter()
            .map(|key| format!(
                "{}:{}",
                Value::String(key.clone()),
                stable_json(&values[key])
            ))
            .collect::<Vec<_>>()
            .join(",")
    )
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
    let value: Value = serde_json::from_str(text).context("parsing relay server control frame")?;
    let Some(type_name) = value.get("type").and_then(Value::as_str) else {
        anyhow::bail!("parsing relay server control frame");
    };
    if !known_server_frame(type_name) {
        return Ok(ServerControlMessage::Unknown {
            type_name: type_name.to_string(),
        });
    }
    let known: KnownServerControlMessage =
        serde_json::from_value(value).context("parsing relay server control frame")?;
    Ok(known.into())
}

fn known_server_frame(type_name: &str) -> bool {
    matches!(
        type_name,
        "hello.ok"
            | "inventory.ok"
            | "inventory.error"
            | "heartbeat.pong"
            | "relay.request"
            | "relay.cancel"
            | "protocol.error"
            | "term.open"
            | "term.attach"
            | "term.detach"
            | "term.close"
            | "term.auth"
            | "exec.start"
            | "exec.cancel"
            | "term.spawn"
            | "supervised.cancel"
    )
}

impl From<KnownServerControlMessage> for ServerControlMessage {
    fn from(message: KnownServerControlMessage) -> Self {
        match message {
            KnownServerControlMessage::HelloOk {
                id,
                protocol_version,
                revision,
                desired_capabilities,
            } => Self::HelloOk {
                id,
                protocol_version,
                revision,
                desired_capabilities,
            },
            KnownServerControlMessage::InventoryOk {
                id,
                revision,
                desired_capabilities,
            } => Self::InventoryOk {
                id,
                revision,
                desired_capabilities,
            },
            KnownServerControlMessage::InventoryError { id, message } => {
                Self::InventoryError { id, message }
            }
            KnownServerControlMessage::HeartbeatPong { id, received_at } => {
                Self::HeartbeatPong { id, received_at }
            }
            KnownServerControlMessage::RelayRequest {
                request_id,
                family,
                method,
                path,
                headers,
                timeout_ms,
                endpoint_slug,
                expect_body,
            } => Self::RelayRequest {
                request_id,
                family,
                method,
                path,
                headers,
                timeout_ms,
                endpoint_slug,
                expect_body,
            },
            KnownServerControlMessage::RelayCancel { request_id, reason } => {
                Self::RelayCancel { request_id, reason }
            }
            KnownServerControlMessage::ProtocolError {
                failure,
                message,
                request_id,
            } => Self::ProtocolError {
                failure,
                message,
                request_id,
            },
            KnownServerControlMessage::TermOpen {
                terminal_id,
                cols,
                rows,
                browser_public_key,
                browser_nonce,
                identity,
                viewer_id,
            } => Self::TermOpen {
                terminal_id,
                cols,
                rows,
                browser_public_key,
                browser_nonce,
                identity,
                viewer_id,
            },
            KnownServerControlMessage::TermAttach {
                terminal_id,
                viewer_id,
                browser_public_key,
                browser_nonce,
                identity,
            } => Self::TermAttach {
                terminal_id,
                viewer_id,
                browser_public_key,
                browser_nonce,
                identity,
            },
            KnownServerControlMessage::TermDetach {
                terminal_id,
                viewer_id,
            } => Self::TermDetach {
                terminal_id,
                viewer_id,
            },
            KnownServerControlMessage::TermClose { terminal_id } => Self::TermClose { terminal_id },
            KnownServerControlMessage::TermAuth {
                terminal_id,
                viewer_id,
                signature,
            } => Self::TermAuth {
                terminal_id,
                viewer_id,
                signature,
            },
            KnownServerControlMessage::ExecStart {
                command_id,
                command,
                cwd,
            } => Self::ExecStart {
                command_id,
                command,
                cwd,
            },
            KnownServerControlMessage::ExecCancel { command_id } => Self::ExecCancel { command_id },
            KnownServerControlMessage::TermSpawn {
                terminal_id,
                command_id,
                command,
                cwd,
                reason,
                requester,
                share_output,
            } => Self::TermSpawn(SupervisedSpawn {
                terminal_id,
                command_id,
                command,
                cwd,
                reason,
                requester,
                share_output,
            }),
            KnownServerControlMessage::SupervisedCancel { command_id, reason } => {
                Self::SupervisedCancel {
                    command_id,
                    if_waiting: matches!(reason.as_deref(), Some("expire" | "decline")),
                }
            }
        }
    }
}

#[cfg(test)]
mod inventory_digest_tests {
    use super::*;

    /// Cross-language canonicalization vector shared with the server's
    /// `inventoryDigestFor`: SHA-256 of the canonical empty replacement list.
    #[test]
    fn inventory_digest_matches_shared_empty_snapshot_vector() {
        assert_eq!(
            inventory_digest(&[]),
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        );
    }

    #[test]
    fn inventory_digest_matches_shared_nonempty_snapshot_vector() {
        let endpoints = vec![EndpointInventory {
            slug: "example".to_string(),
            label: "Example".to_string(),
            kind: "openai-compatible".to_string(),
            status: EndpointStatus::Online,
            default_capabilities: OpenAiCompatibleCapabilities::default(),
            probe_suggestions: None,
            models: vec![DiscoveredModelInventory {
                slug: None,
                upstream_model_id: "model-a".to_string(),
                capabilities: None,
                capability_override_mode: CapabilityOverrideMode::Inherit,
                probe_suggestions: None,
                concurrency_limit: None,
            }],
        }];
        assert_eq!(
            inventory_digest(&endpoints),
            "52e5e23c121ae39dcc319aa506661ec50474c3c8c645cbe09a8121a47d37bc23"
        );
    }
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
    /// 2.5: a malformed frame that names a viewer removes only that viewer.
    DropViewer {
        terminal_id: String,
        viewer_id: String,
    },
    CloseCommand {
        command_id: String,
    },
    /// A malformed `term.spawn` that names a command: refuse it, spawn nothing.
    RejectSupervised {
        command_id: String,
    },
    /// A malformed `exec.start` that names a command: refuse it, run nothing
    /// (a command already running under that id is left alone).
    RejectExec {
        command_id: String,
    },
    /// A malformed `supervised.*` that names a command: end that command.
    CancelSupervised {
        command_id: String,
    },
}

pub fn control_frame_fault(text: &str) -> FrameFault {
    if text.len() > RELAY_JSON_CONTROL_MAX_BYTES {
        // Byte 256 can fall inside a multibyte char; `&str` indexing panics.
        // Walk back. `floor_char_boundary` is not stable on MSRV 1.88.
        let mut end = 256.min(text.len());
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        let head = &text[..end];
        if head.contains("\"relay.request\"") {
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

pub fn binary_frame_fault(frame: &[u8]) -> Result<(RelayBinaryFrameMetadata, Vec<u8>), FrameFault> {
    match parse_binary_frame(frame) {
        Ok(parsed) => Ok(parsed),
        Err(_) => Err(classify_binary_metadata(frame)),
    }
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
    if !known_binary_type(type_name) {
        return FrameFault::Ignore;
    }
    interactive_fault(&value, false)
}

fn known_binary_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "relay.request.body"
            | "relay.response.body"
            | "term.sealed"
            | "exec.stdout"
            | "exec.stderr"
            | "supervised.output"
    )
}

fn interactive_fault(value: &Value, text_frame: bool) -> FrameFault {
    let type_name = value.get("type").and_then(Value::as_str).unwrap_or("");
    if type_name == "relay.request" || type_name == "relay.request.body" {
        return FrameFault::Fatal;
    }
    if type_name == "term.spawn"
        && let Some(command_id) = string_field(value, "commandId")
    {
        return FrameFault::RejectSupervised { command_id };
    }
    if type_name.starts_with("supervised.") {
        return match string_field(value, "commandId") {
            Some(command_id) => FrameFault::CancelSupervised { command_id },
            None => FrameFault::Ignore,
        };
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
    if text_frame {
        return FrameFault::Fatal;
    }
    FrameFault::Ignore
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

    #[test]
    fn llama_and_vllm_advertise_top_k_and_copy_concurrency() {
        let mut endpoint = EndpointConfig {
            slug: "local".to_string(),
            label: "Local".to_string(),
            engine: crate::config::EndpointEngine::LlamaCpp,
            concurrency_limit: Some(4),
            models: vec![crate::config::ModelConfig {
                upstream_model_id: "llama-local".to_string(),
                capabilities: Some(OpenAiCompatibleCapabilities::openai_defaults()),
                ..crate::config::ModelConfig::default()
            }],
            ..EndpointConfig::default()
        };
        let inventory = endpoint_inventory(&endpoint, EndpointStatus::Unknown);
        let sampling = inventory
            .default_capabilities
            .sampling
            .as_ref()
            .expect("default sampling");
        assert!(
            sampling
                .parameters
                .iter()
                .any(|parameter| parameter == "top_k")
        );
        let model = &inventory.models[0];
        assert_eq!(model.concurrency_limit, Some(4));
        assert!(
            model
                .capabilities
                .as_ref()
                .and_then(|capabilities| capabilities.sampling.as_ref())
                .is_some_and(|sampling| sampling
                    .parameters
                    .iter()
                    .any(|parameter| parameter == "top_k"))
        );
        let encoded = serde_json::to_value(&inventory).expect("encode");
        assert!(encoded["models"][0]["concurrencyLimit"].as_u64() == Some(4));
        assert!(!inventory_digest(std::slice::from_ref(&inventory)).is_empty());

        endpoint.engine = crate::config::EndpointEngine::Generic;
        endpoint.concurrency_limit = None;
        let plain = endpoint_inventory(&endpoint, EndpointStatus::Unknown);
        assert!(plain.default_capabilities.sampling.is_none());
        assert!(plain.models[0].concurrency_limit.is_none());

        endpoint.engine = crate::config::EndpointEngine::Vllm;
        let vllm = endpoint_inventory(&endpoint, EndpointStatus::Unknown);
        assert!(
            vllm.default_capabilities
                .sampling
                .as_ref()
                .is_some_and(|sampling| sampling
                    .parameters
                    .iter()
                    .any(|parameter| parameter == "top_k"))
        );
    }

    #[test]
    fn rejects_oversized_binary_chunks() {
        let metadata = RelayBinaryFrameMetadata::ResponseBody {
            request_id: "request".to_string(),
            chunk_id: "0".to_string(),
            final_chunk: None,
        };
        let body = vec![0_u8; RELAY_BINARY_CHUNK_MAX_BYTES + 1];
        assert!(encode_binary_frame(&metadata, &body).is_err());
    }

    #[test]
    fn round_trips_binary_frame() {
        let metadata = RelayBinaryFrameMetadata::RequestBody {
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
    fn hello_omits_an_unavailable_hostname() {
        let inventory = CliInventory {
            slug: "desktop".to_string(),
            hostname: None,
            version: None,
            capabilities: CliCapabilities::from_snapshot(&TerminalFeatureSnapshot {
                allow_human_terminal: false,
                mcp_command_mode: McpCommandMode::Off,
                require_terminal_approval: false,
                terminal_public_key_b64url: "AQID".to_string(),
                terminal_identity: None,
            }),
        };
        let encoded = serde_json::to_string(&inventory).expect("encode");
        assert!(!encoded.contains("hostname"));
        assert!(!encoded.contains("label"));
    }

    #[test]
    fn control_frames_use_server_field_casing() {
        let message = ClientControlMessage::Hello {
            id: "hello-1".to_string(),
            protocol_version: RELAY_PROTOCOL_VERSION.to_string(),
            cli: CliInventory {
                slug: "desktop".to_string(),
                hostname: Some("desk-01.local".to_string()),
                version: None,
                capabilities: CliCapabilities::from_snapshot(&TerminalFeatureSnapshot {
                    allow_human_terminal: false,
                    mcp_command_mode: McpCommandMode::Supervised,
                    require_terminal_approval: false,
                    terminal_public_key_b64url: "AQID".to_string(),
                    terminal_identity: Some(TerminalIdentityProof {
                        public_key: "BAQE".to_string(),
                        signature: "Sig".to_string(),
                    }),
                }),
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

        assert!(encoded.contains(r#""protocolVersion":"2.6""#));
        assert!(encoded.contains(r#""supervisedCommands":true"#));
        assert!(encoded.contains(r#""hostname":"desk-01.local""#));
        assert!(!encoded.contains(r#""label":"Desktop""#));
        assert!(encoded.contains(r#""terminalViewers":true"#));
        assert!(encoded.contains(r#""terminalIdentity":{"publicKey":"BAQE","signature":"Sig"}"#));
        assert!(encoded.contains(r#""sharedTokenizerTps":true"#));
        assert!(encoded.contains(r#""standardizedMetrics":true"#));
        assert!(encoded.contains(r#""terminal":true"#));
        assert!(encoded.contains(r#""exec":true"#));
        assert!(encoded.contains(r#""terminalPublicKey":"AQID""#));
        assert!(encoded.contains(r#""mcpCommandMode":"supervised""#));
        assert!(!encoded.contains(r#""mcpCommands""#));
        assert!(encoded.contains(r#""humanTerminal":false"#));
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
            r#"{"type":"relay.request","requestId":"request-1","family":"generic","method":"POST","path":"/v1/chat/completions","headers":{},"timeoutMs":30000,"endpointSlug":"local","expectBody":true}"#,
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

        let unknown =
            parse_server_control(r#"{"type":"future.frame","extra":1}"#).expect("unknown");
        assert!(matches!(
            unknown,
            ServerControlMessage::Unknown { type_name } if type_name == "future.frame"
        ));
        assert!(parse_server_control(r#"{"type":"hello.ok"}"#).is_err());
        assert!(parse_server_control(r#"{"type":"term.open","terminalId":"t"}"#).is_err());
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
            control_frame_fault(r#"{"type":"exec.cancel","commandId":7}"#),
            FrameFault::Ignore
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

        let unknown_meta = br#"{"type":"no.such"}"#;
        let mut unknown = (unknown_meta.len() as u32).to_be_bytes().to_vec();
        unknown.extend_from_slice(unknown_meta);
        assert!(matches!(
            binary_frame_fault(&unknown),
            Err(FrameFault::Ignore)
        ));
        let mut sealed = br#"{"type":"term.sealed","terminalId":"term-9"}"#.to_vec();
        // Missing seq makes the known metadata fail schema validation.
        let mut bad_sealed = (sealed.len() as u32).to_be_bytes().to_vec();
        bad_sealed.append(&mut sealed);
        assert_eq!(
            binary_frame_fault(&bad_sealed).expect_err("malformed sealed"),
            FrameFault::CloseTerminal {
                terminal_id: "term-9".to_string(),
            }
        );
        let mut request = br#"{"type":"relay.request.body"}"#.to_vec();
        let mut bad_request = (request.len() as u32).to_be_bytes().to_vec();
        bad_request.append(&mut request);
        assert_eq!(
            binary_frame_fault(&bad_request).expect_err("malformed body"),
            FrameFault::Fatal
        );
    }

    #[test]
    fn a_lone_surrogate_fails_only_the_request_that_carries_it() {
        // serde_json cannot hold an unpaired surrogate, so the normal parse fails.
        let spawn = r#"{"type":"term.spawn","terminalId":"t","commandId":"c","command":"echo \ud800","requester":"a","shareOutput":false}"#;
        assert!(parse_server_control(spawn).is_err());
        assert_eq!(
            control_frame_fault(spawn),
            FrameFault::RejectSupervised {
                command_id: "c".to_string()
            }
        );
        assert_eq!(
            control_frame_fault(
                r#"{"type":"exec.start","commandId":"e","command":"ls","cwd":"\udc00"}"#
            ),
            FrameFault::RejectExec {
                command_id: "e".to_string()
            }
        );
        // The id itself may be the bad string: it is still named, as U+FFFD.
        assert_eq!(
            control_frame_fault(r#"{"type":"supervised.cancel","commandId":"\udbff"}"#),
            FrameFault::CancelSupervised {
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
        // Binary metadata gets the same treatment.
        let meta = br#"{"type":"term.sealed","terminalId":"t9","x":"\udfff"}"#;
        let mut frame = (meta.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(meta);
        assert_eq!(
            binary_frame_fault(&frame).expect_err("malformed sealed"),
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
        // A valid escaped pair is left alone.
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"\ud83d\ude00"}"#),
            None
        );
        // An escaped backslash followed by text that looks like an escape.
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\\ud800"}"#), None);
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"x\ud800y","b":"\udc00","c":"\ud800\u0041"}"#)
                .as_deref(),
            Some(r#"{"a":"x\ufffdy","b":"\ufffd","c":"\ufffd\u0041"}"#)
        );
        // Outside strings nothing is touched (and the JSON stays invalid).
        assert_eq!(replace_lone_surrogate_escapes(r#"{\ud800}"#), None);
    }

    #[test]
    fn oversized_multibyte_control_frame_is_ignored_without_panic() {
        // `你` is E4 BD A0. 256 % 3 == 1, so byte 256 is inside a character.
        // The frame must also exceed the 64 KiB control limit.
        let text = "你".repeat((RELAY_JSON_CONTROL_MAX_BYTES / 3) + 2);
        assert!(text.len() > RELAY_JSON_CONTROL_MAX_BYTES);
        assert!(!text.is_char_boundary(256));
        assert_eq!(control_frame_fault(&text), FrameFault::Ignore);

        let ignored = " ".repeat(RELAY_JSON_CONTROL_MAX_BYTES + 1);
        assert_eq!(control_frame_fault(&ignored), FrameFault::Ignore);

        // 24-byte ASCII needle, then `你`. 256 % 3 == 1, so the cut is mid-character
        // and the walk-back must still see `"relay.request"`.
        let mut fatal = r#"{"type":"relay.request"}"#.to_string();
        fatal.push_str(&"你".repeat((RELAY_JSON_CONTROL_MAX_BYTES / 3) + 2));
        assert!(fatal.len() > RELAY_JSON_CONTROL_MAX_BYTES);
        assert!(!fatal.is_char_boundary(256));
        assert_eq!(control_frame_fault(&fatal), FrameFault::Fatal);
    }
    #[test]
    fn a_pre_2_6_server_rejection_says_to_upgrade_the_server() {
        let message = hello_rejection_message(OLDER_SERVER_HELLO_REJECTION);
        assert!(message.contains("rejected relay protocol 2.6"), "{message}");
        assert!(
            message.contains("upgrade the WS Model Proxy server"),
            "{message}"
        );
        assert_eq!(
            hello_rejection_message("access_denied"),
            "relay protocol error: access_denied"
        );
    }

    #[test]
    fn supervised_messages_use_server_field_casing() {
        let spawn = parse_server_control(
            r#"{"type":"term.spawn","terminalId":"t","commandId":"c","command":"ls -l","cwd":"~/x","reason":"why","requester":"agent","shareOutput":true}"#,
        )
        .expect("spawn");
        match spawn {
            ServerControlMessage::TermSpawn(spawn) => {
                assert_eq!(spawn.command, "ls -l");
                assert_eq!(spawn.cwd.as_deref(), Some("~/x"));
                assert_eq!(spawn.reason.as_deref(), Some("why"));
                assert_eq!(spawn.requester, "agent");
                assert!(spawn.share_output);
            }
            other => panic!("unexpected message: {other:?}"),
        }
        let minimal = parse_server_control(
            r#"{"type":"term.spawn","terminalId":"t","commandId":"c","command":"ls","requester":"a","shareOutput":false}"#,
        )
        .expect("minimal spawn");
        assert!(
            matches!(minimal, ServerControlMessage::TermSpawn(ref s) if s.cwd.is_none() && s.reason.is_none())
        );
        let cancel = parse_server_control(r#"{"type":"supervised.cancel","commandId":"c"}"#)
            .expect("cancel");
        assert!(
            matches!(cancel, ServerControlMessage::SupervisedCancel { command_id, if_waiting: false } if command_id == "c")
        );
        let expire = parse_server_control(
            r#"{"type":"supervised.cancel","commandId":"c","reason":"expire"}"#,
        )
        .expect("expire");
        assert!(matches!(
            expire,
            ServerControlMessage::SupervisedCancel {
                if_waiting: true,
                ..
            }
        ));
        let decline = parse_server_control(
            r#"{"type":"supervised.cancel","commandId":"c","reason":"decline"}"#,
        )
        .expect("decline");
        assert!(matches!(
            decline,
            ServerControlMessage::SupervisedCancel {
                if_waiting: true,
                ..
            }
        ));
        // Any other reason ends the terminal.
        let other = parse_server_control(
            r#"{"type":"supervised.cancel","commandId":"c","reason":"later"}"#,
        )
        .expect("other");
        assert!(matches!(
            other,
            ServerControlMessage::SupervisedCancel {
                if_waiting: false,
                ..
            }
        ));
        assert_eq!(
            encode_control(&ClientControlMessage::TermSpawned {
                terminal_id: "t".to_string(),
                command_id: "c".to_string(),
            })
            .expect("spawned"),
            r#"{"type":"term.spawned","terminalId":"t","commandId":"c"}"#
        );
        assert_eq!(
            encode_control(&ClientControlMessage::SupervisedDone {
                command_id: "c".to_string(),
                exit_code: Some(0),
                signal: None,
                review: false,
                output_bytes: Some(12),
            })
            .expect("done"),
            r#"{"type":"supervised.done","commandId":"c","exitCode":0,"review":false,"outputBytes":12}"#
        );
        assert_eq!(
            encode_control(&ClientControlMessage::SupervisedDone {
                command_id: "c".to_string(),
                exit_code: None,
                signal: Some("9".to_string()),
                review: true,
                output_bytes: None,
            })
            .expect("done review"),
            r#"{"type":"supervised.done","commandId":"c","signal":"9","review":true}"#
        );
        assert_eq!(
            encode_control(&ClientControlMessage::SupervisedRejected {
                command_id: "c".to_string(),
                reason: "disabled".to_string(),
            })
            .expect("rejected"),
            r#"{"type":"supervised.rejected","commandId":"c","reason":"disabled"}"#
        );
        let output = RelayBinaryFrameMetadata::SupervisedOutput {
            command_id: "c".to_string(),
            part: SupervisedOutputPart::Tail,
            seq: 2,
        };
        let encoded = encode_binary_frame(&output, b"x").expect("output");
        let text = String::from_utf8_lossy(&encoded[4..encoded.len() - 1]).to_string();
        assert_eq!(
            text,
            r#"{"type":"supervised.output","commandId":"c","part":"tail","seq":2}"#
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"term.spawn","terminalId":"t","commandId":"c"}"#),
            FrameFault::RejectSupervised {
                command_id: "c".to_string()
            }
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"supervised.cancel","commandId":7}"#),
            FrameFault::Ignore
        );
        assert_eq!(
            control_frame_fault(r#"{"type":"supervised.cancel","commandId":"c","x":{}}"#),
            FrameFault::CancelSupervised {
                command_id: "c".to_string()
            }
        );
    }

    #[test]
    fn term_messages_carry_viewer_ids_in_camel_case() {
        let pending = encode_control(&ClientControlMessage::TermPending {
            terminal_id: "t".to_string(),
            viewer_id: Some("v".to_string()),
            cli_nonce: "n".to_string(),
            approval_code: None,
        })
        .expect("pending");
        assert!(pending.contains(r#""viewerId":"v""#));
        for (message, viewer) in [
            (
                ClientControlMessage::TermOpened {
                    terminal_id: "t".to_string(),
                    viewer_id: Some("v".to_string()),
                    cli_nonce: "n".to_string(),
                },
                true,
            ),
            (
                ClientControlMessage::TermAttached {
                    terminal_id: "t".to_string(),
                    viewer_id: None,
                    cli_nonce: "n".to_string(),
                },
                false,
            ),
            (
                ClientControlMessage::TermRejected {
                    terminal_id: "t".to_string(),
                    viewer_id: Some("v".to_string()),
                    reason: "viewer_limit".to_string(),
                    approval_code: None,
                },
                true,
            ),
        ] {
            let text = encode_control(&message).expect("encode");
            assert_eq!(text.contains(r#""viewerId":"v""#), viewer, "{text}");
            assert!(!text.contains("viewer_id"));
            assert!(!text.contains(":null"));
        }
        let writer = encode_control(&ClientControlMessage::TermWriter {
            terminal_id: "t".to_string(),
            viewer_id: Some("v".to_string()),
        })
        .expect("writer");
        assert_eq!(
            writer,
            r#"{"type":"term.writer","terminalId":"t","viewerId":"v"}"#
        );
        let none = encode_control(&ClientControlMessage::TermWriter {
            terminal_id: "t".to_string(),
            viewer_id: None,
        })
        .expect("writer");
        assert_eq!(none, r#"{"type":"term.writer","terminalId":"t"}"#);
        let dropped = encode_control(&ClientControlMessage::TermInputDropped {
            terminal_id: "t".to_string(),
            viewer_id: Some("v".to_string()),
        })
        .expect("input dropped");
        assert_eq!(
            dropped,
            r#"{"type":"term.input_dropped","terminalId":"t","viewerId":"v"}"#
        );

        let key = "A".repeat(87);
        let nonce = "B".repeat(22);
        let open = parse_server_control(&format!(
            r#"{{"type":"term.open","terminalId":"t","viewerId":"v","cols":80,"rows":24,"browserPublicKey":"{key}","browserNonce":"{nonce}"}}"#
        ))
        .expect("open");
        assert!(
            matches!(open, ServerControlMessage::TermOpen { viewer_id: Some(v), .. } if v == "v")
        );
        let attach = parse_server_control(&format!(
            r#"{{"type":"term.attach","terminalId":"t","viewerId":"v","browserPublicKey":"{key}","browserNonce":"{nonce}"}}"#
        ))
        .expect("attach");
        assert!(
            matches!(attach, ServerControlMessage::TermAttach { viewer_id: Some(v), .. } if v == "v")
        );
        let legacy_attach = parse_server_control(&format!(
            r#"{{"type":"term.attach","terminalId":"t","browserPublicKey":"{key}","browserNonce":"{nonce}"}}"#
        ))
        .expect("legacy attach");
        assert!(matches!(
            legacy_attach,
            ServerControlMessage::TermAttach {
                viewer_id: None,
                ..
            }
        ));
        let detach =
            parse_server_control(r#"{"type":"term.detach","terminalId":"t","viewerId":"v"}"#)
                .expect("detach");
        assert!(
            matches!(detach, ServerControlMessage::TermDetach { viewer_id: Some(v), .. } if v == "v")
        );
        let auth = parse_server_control(
            r#"{"type":"term.auth","terminalId":"t","viewerId":"v","signature":"sig"}"#,
        )
        .expect("auth");
        assert!(
            matches!(auth, ServerControlMessage::TermAuth { viewer_id: Some(v), signature, .. } if v == "v" && signature == "sig")
        );
    }

    #[test]
    fn sealed_metadata_sets_viewer_or_epoch() {
        let unicast = RelayBinaryFrameMetadata::TermSealed {
            terminal_id: "t".to_string(),
            seq: 1,
            viewer_id: Some("v".to_string()),
            epoch: None,
        };
        let encoded = encode_binary_frame(&unicast, b"x").expect("unicast");
        let text = String::from_utf8_lossy(&encoded[4..encoded.len() - 1]).to_string();
        assert_eq!(
            text,
            r#"{"type":"term.sealed","terminalId":"t","seq":1,"viewerId":"v"}"#
        );
        let broadcast = RelayBinaryFrameMetadata::TermSealed {
            terminal_id: "t".to_string(),
            seq: 2,
            viewer_id: None,
            epoch: Some(3),
        };
        let encoded = encode_binary_frame(&broadcast, b"x").expect("broadcast");
        let text = String::from_utf8_lossy(&encoded[4..encoded.len() - 1]).to_string();
        assert_eq!(
            text,
            r#"{"type":"term.sealed","terminalId":"t","seq":2,"epoch":3}"#
        );
        let (parsed, _) = parse_binary_frame(&encoded).expect("parse");
        assert_eq!(parsed, broadcast);
        // An incoming 2.4 frame has neither field.
        let meta = br#"{"type":"term.sealed","terminalId":"t","seq":4}"#;
        let mut legacy = (meta.len() as u32).to_be_bytes().to_vec();
        legacy.extend_from_slice(meta);
        let (parsed, _) = parse_binary_frame(&legacy).expect("legacy");
        assert!(matches!(
            parsed,
            RelayBinaryFrameMetadata::TermSealed {
                viewer_id: None,
                epoch: None,
                ..
            }
        ));
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
        let meta = br#"{"type":"term.sealed","terminalId":"t","viewerId":"v"}"#;
        let mut frame = (meta.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(meta);
        assert_eq!(
            binary_frame_fault(&frame).expect_err("malformed"),
            FrameFault::DropViewer {
                terminal_id: "t".to_string(),
                viewer_id: "v".to_string(),
            }
        );
    }
}
