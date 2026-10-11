//! The 0.4.0 runtime definition (`runtime.define` envelopes, `runtimes.json`,
//! `frozen-definitions.json`) and the node's own definition parts.
//!
//! Serde mirror of `packages/api/src/lib/runtime-spec.ts`. These types fix the
//! shape (`deny_unknown_fields` everywhere); the text, placeholder, interactive
//! and address rules the node enforces before accepting a `put` (§4.3) are
//! implemented on top of them in the runtime store (chunk C2).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeApi {
    Openai,
    Anthropic,
}

/// The one engine vocabulary. `auto` exists only as a CLI detection input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Vllm,
    Sglang,
    LlamaCpp,
    Ollama,
    LmStudio,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelType {
    Llm,
    Embeddings,
    Transcription,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCapability {
    TextGeneration,
    VisionInput,
    VideoInput,
    Embedding,
    AudioInput,
    AudioOutput,
    ResponsesApi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    AlwaysOn,
    Startable,
}

/// Placeholders a command may use (§4.6 types every value on the node).
/// `head_addr` is the head's IP on the instance's fabric (server-sent); the
/// `fabric_*` values are derived by the node from its own IP on that fabric
/// (`/sys/class/net`, the InfiniBand device mapping). The server never sends
/// interface or device names.
pub const RUNTIME_PLACEHOLDERS: [&str; 12] = [
    "node_rank",
    "nnodes",
    "port",
    "dist_port",
    "memory_gb",
    "gpu_ids",
    "vram_gb",
    "memory_fraction",
    "head_addr",
    "fabric_ip",
    "fabric_iface",
    "fabric_rdma_device",
];
/// Fabrics one node belongs to, and members of one fabric.
pub const NODE_FABRICS_MAX: usize = 16;
pub const FABRIC_MEMBERS_MAX: usize = 64;
pub const RUNTIME_COMMAND_MAX_BYTES: usize = 4096;
/// Canonical bytes of one spec; below the 64 KiB control cap so one define
/// envelope always fits one chunk.
pub const RUNTIME_SPEC_MAX_BYTES: usize = 48 * 1024;
/// Canonical bytes of all node metric commands together.
pub const NODE_METRIC_COMMANDS_MAX_BYTES: usize = 32 * 1024;
pub const RUNTIME_DEFINITIONS_MAX: usize = 128;
pub const NODE_METRIC_COMMANDS_MAX: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSpec {
    /// `api`, `engine`, `model_type` and `models` together: absent on a
    /// service (startable, never proxied).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<RuntimeApi>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<Engine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_type: Option<ModelType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<SpecModel>>,
    /// ALWAYS_ON only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<Address>,
    /// STARTABLE only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<Launch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics_reader: Option<MetricsReader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expand_media: Option<bool>,
}

impl RuntimeSpec {
    /// The kind the spec implies: `launch` ⇔ startable.
    pub fn kind(&self) -> RuntimeKind {
        if self.launch.is_some() {
            RuntimeKind::Startable
        } else {
            RuntimeKind::AlwaysOn
        }
    }

    /// Serves models: always-on, or startable with `models`. Otherwise a
    /// service (never proxied).
    pub fn serves(&self) -> bool {
        self.address.is_some() || self.models.is_some()
    }

    /// The served/service shape the server's `runtimeSpecSchema` enforces:
    /// `api`, `engine` and `model_type` exactly when the runtime serves; a
    /// service has no metrics reader or media expansion; a served startable
    /// runtime has HTTP readiness, a service HTTP readiness or a
    /// `status`/`health` command per rank.
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        let serves = self.serves();
        if self.address.is_some() == self.launch.is_some() {
            return Err("a runtime has exactly one of address or launch");
        }
        if [
            self.api.is_some(),
            self.engine.is_some(),
            self.model_type.is_some(),
        ]
        .iter()
        .any(|present| *present != serves)
        {
            return Err(if serves {
                "a runtime that serves models declares api, engine and modelType"
            } else {
                "a service has no api, engine or modelType"
            });
        }
        if !serves && (self.metrics_reader.is_some() || self.expand_media.is_some()) {
            return Err("a service has no metrics reader or media expansion");
        }
        if let Some(launch) = &self.launch {
            if serves && launch.readiness.is_none() {
                return Err("a runtime that serves models needs an HTTP readiness check");
            }
            if !serves
                && launch.readiness.is_none()
                && !launch
                    .commands
                    .iter()
                    .all(|commands| commands.status.is_some() || commands.health.is_some())
            {
                return Err(
                    "a service needs an HTTP readiness check or a status/health command per rank",
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpecModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<ModelCapability>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_contract: Option<EmbeddingContract>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription: Option<TranscriptionProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddingContract {
    pub model: String,
    pub revision: String,
    pub dimensions: u32,
    pub normalization: EmbeddingNormalization,
    pub vector_space: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingNormalization {
    None,
    L2,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_formats: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_granularities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diarization: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub languages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language_detection: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiple_language_hints: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_upload_bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_mime_types: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realtime: Option<RealtimeProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RealtimeProfile {
    pub adapter: RealtimeAdapter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_item_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_sessions: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeAdapter {
    Vllm,
    Segmented,
}

// ── Address (ALWAYS_ON) ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Address {
    /// `http(s)://host[:port][/prefix]`; host loopback or an IP literal listed
    /// in `config.json` `runtimeHosts` (checked on the node, §4.3 step 4).
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AddressAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Vec<AddressHeader>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddressAuth {
    pub mode: AuthMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// A node secret name (`WSMP_SECRET_*`); the value never leaves the node.
    pub env: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    Bearer,
    Header,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddressHeader {
    pub name: String,
    pub env: String,
}

// ── Launch (STARTABLE) ──

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub management: Management,
    pub group_size: u8,
    pub resources: Vec<Resource>,
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<FixedPort>,
    /// Multi-node only: the fabric (by name) every rank shares.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fabric: Option<String>,
    pub commands: Vec<Commands>,
    /// Node secrets (names) exported to every command of this runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<Vec<String>>,
    /// Required when the runtime serves models; a service may use
    /// `status`/`health` commands instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness: Option<Readiness>,
    pub health: Health,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Management {
    /// The node owns the unit (was `ownedProcess`).
    Process,
    /// Stop/status commands prove the state (was `externalService`).
    Service,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedPort {
    pub fixed: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Resource {
    /// Takes no node memory budget (a quick service wrap).
    None {},
    Unified {
        memory_gb: f64,
    },
    Cpu {
        ram_gb: f64,
    },
    Discrete {
        gpu_count: u16,
        vram_gb: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ram_gb: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vendor: Option<GpuVendor>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commands {
    pub start: String,
    /// Optional for a `process` runtime (its stop is the rank's slice kill
    /// and the node's proof); a `service` runtime must have one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepare: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_join: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive: Option<Interactive>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeouts_sec: Option<Timeouts>,
}

/// Whether a status command could ever say stopped (exit 3). Refused: an
/// empty command, `true`, `:`, `exit 0`, `/bin/true` and `/usr/bin/true`,
/// compared after collapsing spaces, tabs and line breaks and dropping
/// trailing semicolons. Nothing else is parsed. Twin of the server's
/// `statusCanReportStopped` (`packages/api/src/lib/runtime-spec.ts`); shared
/// vectors in `tests/fixtures/relay-3.0/rules/status-command.json`.
pub fn status_can_report_stopped(command: &str) -> bool {
    let mut text = command
        .split([' ', '\t', '\n', '\r'])
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    while let Some(rest) = text.strip_suffix(';') {
        text = rest.strip_suffix(' ').unwrap_or(rest).to_owned();
    }
    !matches!(
        text.as_str(),
        "" | "true" | ":" | "exit 0" | "/bin/true" | "/usr/bin/true"
    )
}

/// Each flag is `true` or absent on the wire.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interactive {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepare: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_join: Option<bool>,
}

/// Step deadlines in seconds: prepare ≤ 86 400 (model downloads), others ≤ 3 600.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Timeouts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepare: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_join: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Readiness {
    /// Origin-relative; also the health probe path (§4.8).
    pub path: String,
    pub expected_status: u16,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Health {
    pub interval_ms: u32,
    pub failure_threshold: u8,
    pub success_threshold: u8,
}

// ── Metrics reader ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReaderSignal {
    Running,
    Waiting,
    KvUsage,
    KvOccupancy,
    SlotsBusy,
    Deferred,
    PrefixCacheHitsTotal,
    PrefixCacheQueriesTotal,
    KvTokens,
    Slots,
    MaxModelLen,
    CtxPerSlot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Aggregate {
    Sum,
    Max,
    First,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderMapEntry {
    /// A Prometheus series name or an RFC 6901 JSON pointer.
    pub series: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<Aggregate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub divide_by: Option<String>,
}

pub type ReaderMap = BTreeMap<ReaderSignal, ReaderMapEntry>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReaderFormat {
    Json,
    Prometheus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MetricsReader {
    /// By engine: vLLM/SGLang `/metrics`, llama.cpp `/slots`.
    Builtin {},
    /// GET on the runtime's own origin, no redirects.
    Route {
        route: String,
        format: ReaderFormat,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interval_secs: Option<u8>,
        map: ReaderMap,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count_route: Option<String>,
    },
    /// Runs on the node; defined only at Full control, frozen at Relay only.
    Command {
        command: String,
        format: ReaderFormat,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interval_secs: Option<u8>,
        map: ReaderMap,
    },
}

// ── The node's own definition (`runtime.define.node`) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricCommandFormat {
    Json,
    Prometheus,
    Lines,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeMetricCommand {
    pub name: String,
    pub command: String,
    pub interval_secs: u16,
    pub timeout_secs: u8,
    pub format: MetricCommandFormat,
    /// Metric name → where to read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<BTreeMap<String, ReaderMapEntry>>,
}

/// The hardware declaration: browser or agent (`Node.declaredResources`), or
/// the node's `node.info.declared` (which also carries `labels`; the 0.4.0
/// node never sends one).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredHardware {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<HardwareKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_gb: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accelerator_memory_gb: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved_memory_gb: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved_vram_gb: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpus: Option<Vec<DeclaredGpu>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HardwareKind {
    Cpu,
    Discrete,
    Unified,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredGpu {
    pub vendor: GpuVendor,
    pub index: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub vram_gb: f64,
}

/// Evidence only (hello / `node.state`), never a setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeFeatures {
    pub terminals: TerminalFeatures,
    pub operator_terminals: bool,
    pub files: FileFeatures,
    pub runtime_hosts: Vec<String>,
    pub media_expand: bool,
    pub live_stt: bool,
    /// The node's secrets: names and when they were last set (never values).
    pub secrets: Vec<SecretEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretEntry {
    pub name: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalFeatures {
    pub supported: bool,
    pub max: u8,
    pub approval_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileFeatures {
    /// `null`: no usable roots (file ops refused with `no_roots`).
    pub roots: Option<Vec<String>>,
    pub as_root: bool,
    /// Where the roots come from: the home directory by default, the
    /// configured list, or none (file tools turned off).
    pub source: crate::config::FileRootsSource,
}

#[cfg(test)]
mod tests {
    use super::status_can_report_stopped;

    #[test]
    fn status_commands_match_the_shared_vectors() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/relay-3.0/rules/status-command.json");
        let text = std::fs::read_to_string(path).expect("status-command vectors");
        let vectors: serde_json::Value = serde_json::from_str(&text).expect("vectors are JSON");
        let list = |key: &str| -> Vec<String> {
            vectors[key]
                .as_array()
                .expect("a list")
                .iter()
                .map(|value| value.as_str().expect("a string").to_owned())
                .collect()
        };
        for command in list("refused") {
            assert!(
                !status_can_report_stopped(&command),
                "{command:?} should be refused"
            );
        }
        for command in list("accepted") {
            assert!(
                status_can_report_stopped(&command),
                "{command:?} should be accepted"
            );
        }
    }
}
