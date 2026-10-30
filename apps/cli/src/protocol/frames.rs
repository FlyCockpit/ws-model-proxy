//! Relay protocol 3.0 frames, both directions (S0 contract).
//!
//! Serde mirror of `apps/server/src/relay/frames.ts`. Every fixture under
//! `tests/fixtures/relay-3.0/` must deserialize here and serialize back to the
//! same JSON (tests below). Fields this build does not know in what the server
//! sends are ignored, so a later server may add some, except in runtime
//! definitions (`DefinitionEnvelope`, `NodeDefinition` and the `runtime_spec`
//! types), which stay strict (`deny_unknown_fields`) and are refused part by
//! part (`runtime_store::repair`). Node frames are strict too. Unknown frame
//! types are refused; the server accepts exactly protocol `3.0`.
//!
//! These types fix the wire shape. Value rules the node enforces on top of
//! them (placeholder typing §4.6, define validation §4.3, path allowlist §4.8)
//! land in chunks C1–C4.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::canonical::canonical_json;
use super::runtime_spec::{
    DeclaredHardware, EmbeddingContract, Engine, FABRIC_MEMBERS_MAX, ModelCapability,
    NODE_FABRICS_MAX, NODE_METRIC_COMMANDS_MAX_BYTES, NodeFeatures, NodeMetricCommand,
    RUNTIME_SPEC_MAX_BYTES, ReaderSignal, RuntimeApi, RuntimeKind, RuntimeSpec,
    TranscriptionProfile,
};
use crate::stt_wire::SttEvent;

pub const RELAY_PROTOCOL_VERSION: &str = "3.0";
pub const RELAY_SUBPROTOCOL: &str = "ws-model-proxy.relay.v3";
pub const RUNTIME_INVENTORY_CHUNK_MAX: usize = 512;
/// Byte budget of one chunked frame (define, its answer, inventory, node.metrics).
pub const CHUNK_BUDGET_BYTES: usize = 60 * 1024;
/// Versions one define chunk names (put + keep + remove).
pub const DEFINE_CHUNK_MAX_VERSIONS: usize = 64;

/// Unit names are deterministic (§3.5): `wsmp-<handle>-r<rank>`.
pub fn runtime_unit_name(handle: &str, rank: u8) -> String {
    format!("wsmp-{handle}-r{rank}")
}

/// Why a relayed request or session failed (explicit names: serde's
/// `snake_case` would spell `Upstream5xx` as `upstream5xx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RelayFailure {
    #[serde(rename = "transport")]
    Transport,
    #[serde(rename = "timeout")]
    Timeout,
    #[serde(rename = "disconnected")]
    Disconnected,
    #[serde(rename = "upstream_5xx")]
    Upstream5xx,
    #[serde(rename = "upstream_4xx")]
    Upstream4xx,
    #[serde(rename = "unsupported_capability")]
    UnsupportedCapability,
    #[serde(rename = "not_found")]
    NotFound,
    #[serde(rename = "access_denied")]
    AccessDenied,
    #[serde(rename = "rate_limited")]
    RateLimited,
    #[serde(rename = "request_too_large")]
    RequestTooLarge,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "protocol_error")]
    ProtocolError,
    /// Also how a reason a later server added reads (`relay.cancel`,
    /// `stt.close`): the request or session still ends.
    #[serde(rename = "unknown", other)]
    Unknown,
}

// ── Trust and held definitions ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustValue {
    Full,
    Relay,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustState {
    pub value: TrustValue,
    /// True exactly at relay: held definitions and metric commands are frozen.
    pub frozen: bool,
}

/// One held server-origin definition VERSION: a node keeps every version the
/// server pushed and did not remove (current, profile-pinned, running),
/// keyed by `version_id`. The frozen copy is the same set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldDefinition {
    pub runtime_id: String,
    pub version_id: String,
    pub launch_hash: String,
}

// ── Engine facts and inventory ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactSource {
    Probe,
    Config,
    Reader,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fact<T> {
    pub value: T,
    pub source: FactSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountContext {
    Unsupported,
    VllmTokenize,
    TgiChatTokenize,
    LlamaApplyTemplate,
    LlamaInputTokens,
    ReaderCount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReaderInput {
    Route,
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadReaderFact {
    pub value: LoadReaderValue,
    /// Always `config`.
    pub source: FactSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadReaderValue {
    pub input: ReaderInput,
    pub signals: Vec<ReaderSignal>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineFacts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<Fact<Engine>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<Fact<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctx_per_slot: Option<Fact<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_tokens: Option<Fact<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_model_len: Option<Fact<u64>>,
    #[serde(
        rename = "hostPromptCacheMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub host_prompt_cache_mib: Option<Fact<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_reader: Option<LoadReaderFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count_context: Option<Fact<CountContext>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryModel {
    pub id: String,
    pub capabilities: Vec<ModelCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_contract: Option<EmbeddingContract>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription: Option<TranscriptionProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_facts: Option<EngineFacts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOrigin {
    Node,
    Server,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlwaysOnStatus {
    Unknown,
    Online,
    Degraded,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlwaysOnInventory {
    pub slug: String,
    pub origin: RuntimeOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    pub launch_hash: String,
    /// Node-origin only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<RuntimeSpec>,
    pub status: AlwaysOnStatus,
    pub models: Vec<InventoryModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_facts: Option<EngineFacts>,
    /// `true` when the entry was cut down to fit one chunk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstancePhase {
    Starting,
    Ready,
    Unhealthy,
    Stopping,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceRecord {
    pub instance_id: String,
    pub launch_version_id: String,
    pub launch_hash: String,
    pub rank: u8,
    pub intent_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub phase: InstancePhase,
    pub unit_name: String,
    pub port: u16,
    pub handle: String,
    /// The launch spec's model ids, echoed (never probed): a startable runtime
    /// serves exactly what its spec lists, and one listing none is a service.
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_facts: Option<EngineFacts>,
    /// Whether, as this record was observed, no step that may launch was
    /// admitted for the rank in the node's runner and not cancelled (as a
    /// result's `rank_idle`). A `stopped` record proves the stop only with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank_idle: Option<bool>,
}

// ── node.info / node.metrics ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeOs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCpu {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cores: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuVendorWire {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeGpuInfo {
    pub vendor: GpuVendorWire,
    pub index: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    #[serde(
        rename = "vramTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub vram_total_mib: Option<u64>,
    #[serde(
        rename = "gttTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub gtt_total_mib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gfx_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apu: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pci_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInterfaceInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addresses: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_speed_mbps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtu: Option<u32>,
    /// An RDMA device is bound to this interface (fabric suggestions only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rdma: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExecutionMechanism {
    #[serde(rename = "foreground")]
    Foreground,
    #[serde(rename = "systemd")]
    Systemd,
    #[serde(rename = "launchd")]
    Launchd,
    #[serde(rename = "container")]
    Container,
    #[serde(rename = "systemd+linger")]
    SystemdLinger,
    #[serde(rename = "systemd-no-linger")]
    SystemdNoLinger,
    #[serde(rename = "macos")]
    Macos,
    #[serde(rename = "unsupported")]
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Unified,
    Discrete,
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<NodeOs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<NodeCpu>,
    #[serde(
        rename = "memoryTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub memory_total_mib: Option<u64>,
    #[serde(
        rename = "unifiedMemoryMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub unified_memory_mib: Option<u64>,
    #[serde(
        rename = "acceleratorMemoryMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub accelerator_memory_mib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpus: Option<Vec<NodeGpuInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_kind: Option<NodeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfaces: Option<Vec<NodeInterfaceInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mechanism: Option<ExecutionMechanism>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// A node-side hardware declaration. The 0.4.0 node never sends one:
    /// hardware is declared on the server (web app or MCP), not on the node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared: Option<DeclaredHardware>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCpuMetrics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load5: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load15: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeMemoryMetrics {
    #[serde(rename = "totalMiB", default, skip_serializing_if = "Option::is_none")]
    pub total_mib: Option<u64>,
    #[serde(
        rename = "availableMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub available_mib: Option<u64>,
    #[serde(
        rename = "swapTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub swap_total_mib: Option<u64>,
    #[serde(
        rename = "swapFreeMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub swap_free_mib: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeDiskMetrics {
    pub mount: String,
    #[serde(rename = "totalMiB", default, skip_serializing_if = "Option::is_none")]
    pub total_mib: Option<u64>,
    #[serde(rename = "freeMiB", default, skip_serializing_if = "Option::is_none")]
    pub free_mib: Option<u64>,
}

/// `null` and absent both mean "not reported" (nvidia-smi `[N/A]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeGpuMetrics {
    pub index: u8,
    #[serde(
        rename = "vramUsedMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub vram_used_mib: Option<u64>,
    #[serde(
        rename = "vramTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub vram_total_mib: Option<u64>,
    #[serde(
        rename = "gttUsedMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub gtt_used_mib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature_c: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power_w: Option<f64>,
    #[serde(
        rename = "smClockMHz",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sm_clock_mhz: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInterfaceMetrics {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMetric {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    pub value: f64,
    pub ts: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricCommandState {
    Active,
    Failing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricCommandError {
    Spawn,
    Timeout,
    ExitStatus,
    OutputTooLarge,
    Parse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricCommandStatus {
    pub name: String,
    pub state: MetricCommandState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MetricCommandError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeMetrics {
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<NodeCpuMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<NodeMemoryMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disks: Option<Vec<NodeDiskMetrics>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpus: Option<Vec<NodeGpuMetrics>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfaces: Option<Vec<NodeInterfaceMetrics>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<Vec<CustomMetric>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_commands: Option<Vec<MetricCommandStatus>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abandoned_recovery: Option<u32>,
}

// ── runtime.load ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadSource {
    Builtin,
    Route,
    Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeLoad {
    pub handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub running: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_usage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_occupancy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots_busy: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_cache_hits_delta: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_cache_queries_delta: Option<u64>,
    /// `true` or absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_cache_reset: Option<bool>,
    pub counter_epoch: u32,
    pub source: LoadSource,
    pub ts: String,
}

// ── runtime.define ──

/// Strict, like the spec it carries and [`NodeDefinition`]: a runtime never
/// launches from a definition this build reads only in part. One it cannot
/// read is refused on its own (`runtime_store::repair`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionEnvelope {
    pub runtime_id: String,
    pub version_id: String,
    /// The node recomputes it from `spec` exactly as received
    /// (`canonical::launch_hash`) and refuses `hash_mismatch`.
    pub launch_hash: String,
    pub kind: RuntimeKind,
    pub slug: String,
    pub spec: RuntimeSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeDefinition {
    /// `[start, end]` for the §4.6 port check; frozen at Relay only.
    pub port_range: [u16; 2],
    pub metric_commands: MetricCommandsPush,
    /// The fabrics this node is in; frozen with the rest at Relay only.
    pub fabrics: FabricsPush,
    /// The longest lifetime of one node command.
    pub command_max_ms: u64,
}

/// Node command limits (owner decision round 3).
pub const NODE_COMMAND_MAX_MS: u64 = 86_400_000;
pub const NODE_COMMAND_MIN_MS: u64 = 60_000;
pub const NODE_COMMAND_TAIL_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecState {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Interrupted,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecStatus {
    pub command_id: String,
    pub state: ExecState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// End of the masked combined output ring buffer (at most 64 KiB).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
}

impl ExecStatus {
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        rule(
            (self.state == ExecState::Running) == self.finished_at.is_none(),
            "finishedAt exactly once the command ended",
        )?;
        rule(
            self.exit_code.is_none()
                || matches!(self.state, ExecState::Succeeded | ExecState::Failed),
            "an exit code only for succeeded or failed commands",
        )?;
        rule(
            self.tail
                .as_ref()
                .is_none_or(|tail| tail.len() <= NODE_COMMAND_TAIL_MAX_BYTES),
            "a command output tail is at most 64 KiB",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FabricsPush {
    /// sha256 of the canonical `sets` array.
    pub hash: String,
    pub sets: Vec<FabricSet>,
}

/// One fabric this node is in: its own IP and every member's IP (sorted,
/// including `self_ip`). A multi-node job names the fabric by `fabric_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FabricSet {
    pub fabric_id: String,
    pub name: String,
    pub self_ip: String,
    pub member_ips: Vec<String>,
}

/// UTF-8 bytes of one secret value.
pub const NODE_SECRET_VALUE_MAX_BYTES: usize = 16 * 1024;

/// `secret.set`. `Debug` never prints the value.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSet {
    pub id: String,
    pub name: String,
    pub value: String,
}

impl std::fmt::Debug for SecretSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretSet")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("value", &"[redacted]")
            .finish()
    }
}

impl SecretSet {
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        rule(
            is_secret_name(&self.name),
            "node secrets are named WSMP_SECRET_*",
        )?;
        rule(
            !self.value.is_empty() && self.value.len() <= NODE_SECRET_VALUE_MAX_BYTES,
            "a secret value is 1 byte to 16 KiB",
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretStatus {
    Set,
    Deleted,
    NotFound,
    Refused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretRefusal {
    TrustRelay,
    Invalid,
    StoreFailed,
    Limit,
}

/// A node secret name: `WSMP_SECRET_` and 1 to 64 of `A-Z0-9_`.
pub fn is_secret_name(name: &str) -> bool {
    name.strip_prefix("WSMP_SECRET_").is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 64
            && rest
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    })
}

/// A node's address on a fabric, exactly as the server and the database
/// accept it (`packages/api/src/lib/ip-literal.ts`, shared vectors in
/// `tests/fixtures/relay-3.0/rules/fabric-ip.json`): the canonical text of one
/// address (dotted quad without leading zeros, RFC 5952 IPv6 without an
/// embedded IPv4 part), never 0.0.0.0/8, loopback, `::/96` or IPv4-mapped.
pub fn is_fabric_ip(value: &str) -> bool {
    match value.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let first = ip.octets()[0];
            ip.to_string() == value && first != 0 && first != 127
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            let segments = ip.segments();
            let first_80_zero = segments[..5].iter().all(|segment| *segment == 0);
            !value.contains('.')
                && ip.to_string() == value
                && !(first_80_zero && (segments[5] == 0 || segments[5] == 0xffff))
        }
        Err(_) => false,
    }
}

/// A node-derived interface or RDMA device name (`{{fabric_iface}}`,
/// `{{fabric_rdma_device}}`) is substituted into commands only when it is
/// plain: letters, digits, `_`, `.`, `:`, `-`, not starting with `-`, at most
/// 64 bytes. Anything else refuses the start instead of reaching a shell.
pub fn is_fabric_device_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

impl FabricsPush {
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        rule(
            self.sets.len() <= NODE_FABRICS_MAX,
            "a node is in at most 16 fabrics",
        )?;
        for set in &self.sets {
            rule(
                is_fabric_ip(&set.self_ip) && set.member_ips.iter().all(|ip| is_fabric_ip(ip)),
                "fabric addresses are IP literals",
            )?;
            rule(
                !set.member_ips.is_empty() && set.member_ips.len() <= FABRIC_MEMBERS_MAX,
                "a fabric has 1 to 64 members",
            )?;
            rule(
                set.member_ips.contains(&set.self_ip),
                "memberIps includes selfIp",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricCommandsPush {
    /// sha256 of the canonical `commands` array.
    pub hash: String,
    pub commands: Vec<NodeMetricCommand>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefineStatus {
    Applied,
    Unchanged,
    Removed,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefineRejectReason {
    TrustRelay,
    HashMismatch,
    Invalid,
    BaseUrlNotAllowed,
    EnvNotAllowed,
    Conflict,
    Limit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefineEntryResult {
    pub runtime_id: String,
    pub version_id: String,
    pub status: DefineStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<DefineRejectReason>,
    /// For `invalid`: the JSON path, never spec text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefineNodeResult {
    pub status: DefineStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<DefineRejectReason>,
}

// ── runtime.job ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobPhase {
    Prepare,
    Start,
    AfterJoin,
    Readiness,
    Health,
    Stop,
    Status,
}

/// Placeholder values (template names, snake_case). Decimals are canonical
/// strings substituted verbatim; the node types every value before rendering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobPlaceholders {
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dist_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_addr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_ids: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_gb: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vram_gb: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_fraction: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandAuthor {
    User,
    Agent,
    /// Also an author a later server added: it only labels the screen.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOperator {
    pub terminal_id: String,
    pub command_author: CommandAuthor,
}

/// Most reservations one single-node job names.
pub const JOB_RESERVATIONS_MAX: usize = 8;

/// One reservation of a single-node instance and the worker node it was
/// assigned to. Commands see it as `WSMP_RESERVATION_<index>_NODE` (the slug),
/// `WSMP_RESERVATION_<index>_NODE_ID` and, when placement gave it GPUs,
/// `WSMP_RESERVATION_<index>_GPUS` (the worker's GPU indices, like the rank's
/// own `gpu_ids`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReservation {
    pub index: u8,
    pub node_id: String,
    pub node: String,
    /// The worker GPUs placement accounted to this reservation (`0,3`), in the
    /// format of `placeholders.gpu_ids`. Absent: none recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_ids: Option<String>,
}

/// No command text: the node renders from the held/frozen definition whose
/// `launchHash` matches (§4.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeJob {
    pub step_id: String,
    pub instance_id: String,
    pub runtime_id: String,
    pub launch_version_id: String,
    pub launch_hash: String,
    pub generation: u32,
    pub rank: u8,
    /// Must equal the held/frozen definition's `launch.groupSize`.
    pub nnodes: u8,
    pub phase: JobPhase,
    pub handle: String,
    pub unit_name: String,
    pub placeholders: JobPlaceholders,
    /// Multi-node only: the fabric the instance runs in. The node resolves
    /// `fabric_ip`, `fabric_iface` and `fabric_rdma_device` from its own IP on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fabric_id: Option<String>,
    pub timeout_ms: u64,
    pub owner_epoch: String,
    pub intent_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<JobOperator>,
    /// Single-node only: the worker nodes the instance's reservations were
    /// assigned to (a stop or status job carries those of the launch it
    /// checks). Absent when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reservations: Vec<JobReservation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Succeeded,
    Failed,
    Running,
    AwaitingOperator,
    OperatorRunning,
    OperatorClosed,
}

/// Pre-admission codes (first block) prove the rank never ran the step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobError {
    ExecutionMechanismUnavailable,
    BadJob,
    InteractiveUnsupported,
    OperatorTerminalsDisabled,
    TrustRelay,
    DefinitionMissing,
    DefinitionFrozen,
    LocalConfigUnavailable,
    SessionDisconnected,
    InstanceUnknown,
    OwnedLaunchUnconfirmed,
    LaunchUnconfirmed,
    CommandFailed,
    ReadinessFailed,
    HealthFailed,
    JobDeadline,
    /// A `process` start handed its server off out of wsmp's units (the
    /// start unit has no task left while the port answers).
    ProcessDetached,
}

impl JobError {
    pub fn is_pre_admission(self) -> bool {
        matches!(
            self,
            Self::ExecutionMechanismUnavailable
                | Self::BadJob
                | Self::InteractiveUnsupported
                | Self::OperatorTerminalsDisabled
                | Self::TrustRelay
                | Self::DefinitionMissing
                | Self::DefinitionFrozen
                | Self::LocalConfigUnavailable
                | Self::SessionDisconnected
        )
    }
}

// ── Kept 2.4 shapes ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayMetrics {
    pub completion_tokens: u64,
    /// Always `cl100k_base`.
    pub tokenizer: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountMethod {
    VllmTokenize,
    TgiChatTokenize,
    LlamaApplyTemplate,
    LlamaInputTokens,
    ReaderCount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdentity {
    pub public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeTerminalIdentity {
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloNode {
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub identity_public_key: String,
    pub identity_signature: String,
    pub terminal_public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_identity: Option<NodeTerminalIdentity>,
    /// Which build this is (two `0.4.2` builds can differ). Absent on older CLIs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<NodeBuild>,
    /// Sent only when there is something to say (`wsl: true`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<NodeEnvironment>,
}

/// How this wsmp was installed (`hello.node.build.installMethod`, the install receipt).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallMethod {
    /// The server's `install.sh`.
    Script,
    /// The server's `install.ps1`.
    ScriptPs1,
    Homebrew,
    /// `cargo install` from a registry.
    Cargo,
    Binstall,
    Npm,
    /// Built from a git revision (`WMP_CLI_SOURCE_REV`, `cargo install --git`): never replaced
    /// from the browser (D8).
    Source,
    Unknown,
}

impl InstallMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Script => "script",
            Self::ScriptPs1 => "script-ps1",
            Self::Homebrew => "homebrew",
            Self::Cargo => "cargo",
            Self::Binstall => "binstall",
            Self::Npm => "npm",
            Self::Source => "source",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeBuild {
    /// The git commit this binary was built from (40 lowercase hex), `null` when unknown.
    pub commit: Option<String>,
    pub install_method: InstallMethod,
    /// The Rust target triple this binary was built for.
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeEnvironment {
    /// The node runs inside WSL (`/proc/sys/kernel/osrelease` names Microsoft).
    #[serde(default, skip_serializing_if = "is_false")]
    pub wsl: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// `agent.update.progress` `phase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Refused,
    WaitingIdle,
    Downloading,
    Verifying,
    Armed,
    Swapped,
    Restarting,
    Confirmed,
    RolledBack,
    Failed,
}

/// `agent.update.progress` `reason` (only with `refused` or `failed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateReason {
    NotOwnerTrust,
    OptedOut,
    SourceBuild,
    UnsupportedMethod,
    Busy,
    SignatureMismatch,
    ChecksumMismatch,
    DownloadFailed,
    VersionMismatch,
    AlreadyCurrent,
    InProgress,
    Internal,
}

/// `agent.update.progress` `detail` cap (UTF-16 code units, as the server counts).
pub const UPDATE_DETAIL_MAX_CHARS: usize = 4000;
/// `agent.update` `rollbackAfterSecs` bounds.
pub const UPDATE_ROLLBACK_SECS_RANGE: std::ops::RangeInclusive<u32> = 30..=600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectedServer {
    pub base_url: String,
    pub engine: Engine,
    pub api: RuntimeApi,
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// `hello.ok`'s `features`: optional node frame fields this server accepts.
/// Fields a later server adds here are ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFeatures {
    /// `exec.started` may carry `ranWith`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub exec_ran_with: bool,
    /// A `version_mismatch` refusal in `agent.update.progress` may carry `availableVersion`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub agent_update_available_version: bool,
}

/// How a node command ran (`exec.started`'s `ranWith`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RanWith {
    /// The shell that read the command: `sh`, `pwsh`, `powershell` or `cmd`
    /// (`cmd` also for a `.bat` or `.cmd` argv on Windows, which cmd runs).
    /// Null for a program started directly.
    pub shell: Option<super::runtime_spec::CommandShell>,
    pub mode: RanMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RanMode {
    /// Text, or an argv rendered as a script, read by `shell`.
    Shell,
    /// An argv started as a program, each argument passed exactly.
    Direct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionSync {
    Expect,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolErrorCode {
    UpgradeCli,
    UpgradeServer,
    IdentityMismatch,
    AccessDenied,
    Malformed,
    Internal,
    /// A code a later server added: the node prints the server's message and
    /// reconnects with backoff, rather than failing to read the frame.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpKind {
    Read,
    Stat,
    List,
    Search,
    Edit,
    Write,
    Rename,
    Mkdir,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RequestFamily {
    #[serde(rename = "chat.completions")]
    ChatCompletions,
    #[serde(rename = "embeddings")]
    Embeddings,
    #[serde(rename = "responses")]
    Responses,
    #[serde(rename = "messages")]
    Messages,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "images")]
    Images,
    #[serde(rename = "generic")]
    Generic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HttpMethod {
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "POST")]
    Post,
    /// `DELETE /v1/responses/{id}` (stored Responses objects on the engine).
    #[serde(rename = "DELETE")]
    Delete,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SttAdapter {
    Vllm,
    Segmented,
}

// ── Node → server control frames ──

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum NodeFrame {
    #[serde(rename = "hello")]
    Hello {
        id: String,
        protocol_version: String,
        node: HelloNode,
        trust: TrustState,
        features: NodeFeatures,
        definitions: Vec<HeldDefinition>,
        held_metric_commands_hash: Option<String>,
        held_port_range: Option<[u16; 2]>,
        held_fabrics_hash: Option<String>,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sent_at: Option<String>,
    },
    #[serde(rename = "node.state")]
    NodeState {
        trust: TrustState,
        features: NodeFeatures,
    },
    #[serde(rename = "runtime.inventory")]
    RuntimeInventory {
        snapshot_id: String,
        chunk_index: u32,
        #[serde(rename = "final")]
        is_final: bool,
        always_on: Vec<AlwaysOnInventory>,
        instances: Vec<InstanceRecord>,
    },
    #[serde(rename = "runtime.load")]
    RuntimeLoad(RuntimeLoad),
    #[serde(rename = "runtime.job.result")]
    RuntimeJobResult {
        step_id: String,
        instance_id: String,
        rank: u8,
        intent_hash: String,
        owner_epoch: String,
        status: JobStatus,
        stopped: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<JobError>,
        /// Which check failed: a field path, never a value. A stop proof
        /// answered not stopped: why. A failed health probe: why
        /// (`serving_unconfirmed`, `http_<code>`, `connect_refused`, ...).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<u8>,
        /// A stop or status probe: whether, as it answered, no other step that
        /// may launch (prepare, start, after_join, readiness) was admitted for
        /// the rank in the node's runner and not cancelled, under any
        /// connection (`features.rankIdle`). A stop cancels the others first.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rank_idle: Option<bool>,
    },
    #[serde(rename = "runtime.define.result")]
    /// Answers one define chunk; the final answer also carries the held state.
    RuntimeDefineResult {
        op_id: String,
        chunk_index: u32,
        #[serde(rename = "final")]
        is_final: bool,
        results: Vec<DefineEntryResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node: Option<DefineNodeResult>,
        /// Final only: the complete held set after applying the operation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        held: Option<Vec<HeldDefinition>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "double_option"
        )]
        held_metric_commands_hash: Option<Option<String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "double_option"
        )]
        held_port_range: Option<Option<[u16; 2]>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "double_option"
        )]
        held_fabrics_hash: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frozen: Option<bool>,
    },
    /// Answers `secret.set` / `secret.delete` with the name only.
    #[serde(rename = "secret.result")]
    SecretResult {
        id: String,
        name: String,
        status: SecretStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<SecretRefusal>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_at: Option<String>,
    },
    #[serde(rename = "runtime.detected")]
    RuntimeDetected {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        scanned_at: String,
        servers: Vec<DetectedServer>,
    },
    #[serde(rename = "node.info")]
    NodeInfo(NodeInfo),
    #[serde(rename = "node.metrics")]
    NodeMetrics(NodeMetrics),
    #[serde(rename = "relay.request.body.ack")]
    RelayRequestBodyAck { request_id: String, credits: u32 },
    #[serde(rename = "relay.response.headers")]
    RelayResponseHeaders {
        request_id: String,
        status: u16,
        headers: Vec<(String, String)>,
    },
    #[serde(rename = "relay.complete")]
    RelayComplete {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<RelayUsage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metrics: Option<RelayMetrics>,
    },
    #[serde(rename = "relay.error")]
    RelayError {
        request_id: String,
        failure: RelayFailure,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upstream_status_code: Option<u16>,
    },
    #[serde(rename = "relay.cancelled")]
    RelayCancelled { request_id: String },
    #[serde(rename = "context.count.result")]
    ContextCountResult {
        request_id: String,
        tokens: u64,
        method: CountMethod,
    },
    #[serde(rename = "context.count.error")]
    ContextCountError {
        request_id: String,
        failure: RelayFailure,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "term.pending")]
    TermPending {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        cli_nonce: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        approval_code: Option<String>,
    },
    #[serde(rename = "term.opened")]
    TermOpened {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        cli_nonce: String,
    },
    #[serde(rename = "term.attached")]
    TermAttached {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        cli_nonce: String,
    },
    #[serde(rename = "term.rejected")]
    TermRejected {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        approval_code: Option<String>,
    },
    #[serde(rename = "term.writer")]
    TermWriter {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
    },
    #[serde(rename = "term.input_dropped")]
    TermInputDropped {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
    },
    #[serde(rename = "term.exit")]
    TermExit {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
    #[serde(rename = "exec.started")]
    ExecStarted {
        command_id: String,
        started_at: String,
        /// started_at + min(timeout_ms, the node's command_max_ms).
        ends_by: String,
        /// How the node ran it. Sent only to a server whose `hello.ok` had
        /// `features.execRanWith`: an older server's strict schema refuses it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ran_with: Option<RanWith>,
    },
    #[serde(rename = "exec.rejected")]
    ExecRejected { command_id: String, reason: String },
    /// A command's state: unprompted when it ends, in answer to `exec.poll`,
    /// and after a reconnect for commands a daemon restart interrupted.
    #[serde(rename = "exec.status")]
    ExecStatus(ExecStatus),
    /// The result body is checked per op by the server (`file-protocol.ts`).
    #[serde(rename = "file.result")]
    FileResult {
        op_id: String,
        op: FileOpKind,
        result: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data_field: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body_bytes: Option<u32>,
    },
    /// `reason`: a file error code, `bad_frame`, `trust_relay` or `no_roots`.
    #[serde(rename = "file.rejected")]
    FileRejected {
        op_id: String,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<Value>,
    },
    /// One step of an `agent.update` (or its end). `confirmed` and `rolled_back` come from the
    /// binary that runs after the restart, on a new relay session.
    #[serde(rename = "agent.update.progress")]
    AgentUpdateProgress {
        update_id: String,
        phase: UpdatePhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<UpdateReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        /// The version the node could install instead (Homebrew: its tap's), sent only with
        /// `refused` / `version_mismatch`, and only to a server whose `hello.ok` said it accepts
        /// it (`features.agentUpdateAvailableVersion`; an older server's strict schema refuses
        /// it). The owner may then install it anyway (`agent.update` naming it).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        available_version: Option<String>,
    },
    #[serde(rename = "stt.opened")]
    SttOpened { session_id: String },
    #[serde(rename = "stt.audio.ack")]
    SttAudioAck { session_id: String, bytes: u32 },
    #[serde(rename = "stt.event")]
    SttEvent { session_id: String, event: SttEvent },
    #[serde(rename = "stt.error")]
    SttError {
        session_id: String,
        failure: RelayFailure,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "stt.closed")]
    SttClosed { session_id: String },
}

// ── Server → node control frames ──

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ServerFrame {
    #[serde(rename = "hello.challenge")]
    HelloChallenge { nonce: String, origin: String },
    #[serde(rename = "hello.ok")]
    HelloOk {
        id: String,
        protocol_version: String,
        node_id: String,
        definition_sync: DefinitionSync,
        /// What this server accepts beyond protocol 3.0 as first released.
        /// Absent from an older server: it accepts none of it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        features: Option<ServerFeatures>,
    },
    #[serde(rename = "protocol.error")]
    ProtocolError {
        /// Always `protocol_error`.
        failure: RelayFailure,
        code: ProtocolErrorCode,
        message: String,
        supported_versions: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename = "heartbeat.pong")]
    HeartbeatPong { id: String, received_at: String },
    /// A person lowered trust in the browser. There is no frame that raises it.
    #[serde(rename = "trust.lower")]
    TrustLower { id: String, requested_at: String },
    /// Full control only (Relay only refuses with `trust_relay`). The value is
    /// stored 0600 on the node and never logged; `Debug` redacts it.
    #[serde(rename = "secret.set")]
    SecretSet(SecretSet),
    #[serde(rename = "secret.delete")]
    SecretDelete { id: String, name: String },
    #[serde(rename = "runtime.define")]
    /// One byte-bounded chunk of a define operation; applied after `final`.
    RuntimeDefine {
        op_id: String,
        chunk_index: u32,
        #[serde(rename = "final")]
        is_final: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        put: Option<Vec<DefinitionEnvelope>>,
        /// `complete` only: held versions to keep (by version id).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keep: Option<Vec<String>>,
        /// Incremental only: versions to drop (by version id). A version the node does not
        /// hold is a no-op with no result entry (the final held set is authoritative).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remove: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        complete: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node: Option<NodeDefinition>,
    },
    #[serde(rename = "runtime.detect")]
    RuntimeDetect { id: String },
    #[serde(rename = "runtime.inventory.ok")]
    RuntimeInventoryOk { snapshot_id: String },
    #[serde(rename = "runtime.inventory.error")]
    RuntimeInventoryError {
        snapshot_id: String,
        message: String,
    },
    #[serde(rename = "runtime.job")]
    RuntimeJob(Box<RuntimeJob>),
    #[serde(rename = "relay.request")]
    RelayRequest {
        request_id: String,
        family: RequestFamily,
        method: HttpMethod,
        path: String,
        headers: BTreeMap<String, String>,
        timeout_ms: u64,
        handle: String,
        expect_body: bool,
        /// The exact body length: sent as Content-Length, never chunked framing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body_bytes: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count_first: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count_ceiling: Option<u64>,
    },
    #[serde(rename = "relay.cancel")]
    RelayCancel {
        request_id: String,
        reason: RelayFailure,
    },
    #[serde(rename = "term.open")]
    TermOpen {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        cols: u16,
        rows: u16,
        browser_public_key: String,
        browser_nonce: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        identity: Option<TerminalIdentity>,
        /// One of the `features.terminals.shells` ids this node advertised.
        /// Unset: the node's default. Sent only to a node that advertised
        /// shells.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
    },
    #[serde(rename = "term.attach")]
    TermAttach {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        browser_public_key: String,
        browser_nonce: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        identity: Option<TerminalIdentity>,
    },
    #[serde(rename = "term.detach")]
    TermDetach {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
    },
    #[serde(rename = "term.close")]
    TermClose { terminal_id: String },
    #[serde(rename = "term.auth")]
    TermAuth {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        signature: String,
    },
    #[serde(rename = "exec.start")]
    ExecStart {
        command_id: String,
        /// A text command, run in `shell`. Exactly one of `command` and `argv`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        /// A program and its arguments, each passed exactly (no shell parses them).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        argv: Option<Vec<String>>,
        /// Absent: `sh` (Windows: `pwsh`, else `powershell`). Never `cmd` with `argv`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<super::runtime_spec::CommandShell>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// Capped by the node's `command_max_ms`; the node kills the whole
        /// process tree at the end, on cancel and on daemon shutdown.
        timeout_ms: u64,
    },
    #[serde(rename = "exec.poll")]
    ExecPoll { command_id: String, tail_bytes: u32 },
    #[serde(rename = "exec.cancel")]
    ExecCancel { command_id: String },
    /// 2.4 `file.op` without `mode`/`readGrant`; `args` are checked per op by
    /// the file relay (`file_ops`).
    #[serde(rename = "file.op")]
    FileOp {
        op_id: String,
        op: FileOpKind,
        args: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body_bytes: Option<u32>,
    },
    #[serde(rename = "file.cancel")]
    FileCancel { op_id: String },
    /// Install `version` from `artifactUrl` and restart into it, rolling back by itself
    /// unless the new build confirms within `rollbackAfterSecs`. Older agents drop it
    /// (unknown type); the server sends it only to a node that reports `features.selfUpdate`.
    #[serde(rename = "agent.update")]
    AgentUpdate {
        update_id: String,
        version: String,
        artifact_url: String,
        sha256: String,
        /// Reserved (D9): a detached signature of the artifact. Ignored today.
        signature: Option<String>,
        force: bool,
        rollback_after_secs: u32,
    },
    /// The server stored how `update_id` ended (the node's `confirmed`,
    /// `rolled_back` or `failed`): the node stops reporting it. Until then it
    /// reports the end again after each `hello.ok`.
    #[serde(rename = "agent.update.ack")]
    AgentUpdateAck { update_id: String },
    #[serde(rename = "stt.open")]
    SttOpen {
        session_id: String,
        handle: String,
        upstream_model: String,
        adapter: SttAdapter,
        config: SttConfig,
        max_item_seconds: u32,
        max_session_ms: u64,
        audio_window_bytes: u32,
    },
    #[serde(rename = "stt.update")]
    SttUpdate {
        session_id: String,
        config: SttConfig,
    },
    #[serde(rename = "stt.commit")]
    SttCommit { session_id: String, item_seq: u32 },
    #[serde(rename = "stt.clear")]
    SttClear { session_id: String, item_seq: u32 },
    #[serde(rename = "stt.close")]
    SttClose {
        session_id: String,
        reason: RelayFailure,
    },
}

// ── Binary frame metadata ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ServerBinaryMetadata {
    #[serde(rename = "relay.request.body")]
    RelayRequestBody {
        request_id: String,
        chunk_id: String,
        #[serde(default, rename = "final", skip_serializing_if = "Option::is_none")]
        is_final: Option<bool>,
    },
    #[serde(rename = "term.sealed")]
    TermSealed {
        terminal_id: String,
        seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        epoch: Option<u32>,
    },
    #[serde(rename = "file.body")]
    FileBody { op_id: String },
    #[serde(rename = "stt.audio")]
    SttAudio { session_id: String, seq: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum NodeBinaryMetadata {
    #[serde(rename = "relay.response.body")]
    RelayResponseBody {
        request_id: String,
        chunk_id: String,
        #[serde(default, rename = "final", skip_serializing_if = "Option::is_none")]
        is_final: Option<bool>,
    },
    #[serde(rename = "term.sealed")]
    TermSealed {
        terminal_id: String,
        seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        epoch: Option<u32>,
    },
    #[serde(rename = "file.data")]
    FileData { op_id: String },
}

/// Serde helper for "absent / null / value" fields.
mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, T: Serialize>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

/// A cross-field rule a frame broke (the zod schemas refuse the same frames;
/// shared vectors: `relay-3.0/invalid/*/semantic-*.json`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameRuleError(pub &'static str);

impl std::fmt::Display for FrameRuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for FrameRuleError {}

fn rule(ok: bool, message: &'static str) -> Result<(), FrameRuleError> {
    if ok {
        Ok(())
    } else {
        Err(FrameRuleError(message))
    }
}

impl TrustState {
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        rule(
            self.frozen == (self.value == TrustValue::Relay),
            "frozen is true exactly at relay",
        )
    }
}

fn canonical_len<T: Serialize>(value: &T) -> Option<usize> {
    let value = serde_json::to_value(value).ok()?;
    canonical_json(&value).ok().map(|text| text.len())
}

fn encoded_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

impl DefinitionEnvelope {
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        rule(self.spec.kind() == self.kind, "kind must match the spec")?;
        let secrets = self
            .spec
            .launch
            .iter()
            .flat_map(|launch| launch.secrets.iter().flatten());
        let auth = self.spec.address.iter().flat_map(|address| {
            address.auth.iter().map(|auth| &auth.env).chain(
                address
                    .headers
                    .iter()
                    .flat_map(|headers| headers.iter().map(|header| &header.env)),
            )
        });
        rule(
            secrets.chain(auth).all(|name| is_secret_name(name)),
            "node secrets are named WSMP_SECRET_*",
        )?;
        self.spec.validate_shape().map_err(FrameRuleError)?;
        rule(
            canonical_len(&self.spec).is_some_and(|len| len <= RUNTIME_SPEC_MAX_BYTES),
            "a runtime definition is at most 48 KiB as canonical JSON",
        )
    }
}

impl RuntimeJob {
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        rule(self.rank < self.nnodes, "rank must be below nnodes")?;
        rule(
            (self.nnodes > 1) == self.fabric_id.is_some()
                && (self.nnodes > 1) == self.placeholders.head_addr.is_some(),
            "fabricId and head_addr exactly for multi-node jobs",
        )?;
        rule(
            self.placeholders
                .head_addr
                .as_deref()
                .is_none_or(is_fabric_ip),
            "head_addr is the head's fabric IP",
        )?;
        rule(
            self.unit_name == runtime_unit_name(&self.handle, self.rank),
            "unitName must be wsmp-<handle>-r<rank>",
        )?;
        rule(
            self.reservations.is_empty() || self.nnodes == 1,
            "reservations only on single-node jobs",
        )?;
        rule(
            self.reservations.len() <= JOB_RESERVATIONS_MAX,
            "at most 8 reservations",
        )?;
        let mut seen = [false; JOB_RESERVATIONS_MAX];
        for reservation in &self.reservations {
            let slot = seen.get_mut(usize::from(reservation.index));
            rule(slot.is_some(), "reservation index is 0 to 7")?;
            if let Some(slot) = slot {
                rule(!*slot, "reservation indices are unique")?;
                *slot = true;
            }
            rule(
                is_row_id(&reservation.node_id),
                "reservation nodeId is a row id",
            )?;
            rule(
                is_node_slug(&reservation.node),
                "reservation node is a node slug",
            )?;
            rule(
                reservation.gpu_ids.as_deref().is_none_or(is_gpu_ids),
                "reservation gpuIds is a list of GPU indices",
            )?;
        }
        Ok(())
    }
}

/// A comma list of GPU indices (0–255), unique, at most 64: a rank's
/// `placeholders.gpu_ids` and a reservation's `gpuIds`.
pub fn is_gpu_ids(value: &str) -> bool {
    let parts: Vec<&str> = value.split(',').collect();
    let mut seen = std::collections::BTreeSet::new();
    !value.is_empty()
        && parts.len() <= 64
        && parts.iter().all(|part| {
            (part == &"0" || (!part.starts_with('0') && !part.is_empty()))
                && part.len() <= 3
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u16>().is_ok_and(|n| n <= 255)
                && seen.insert(*part)
        })
}

/// `^[A-Za-z0-9_-]{1,64}$` (the server's `rowIdSchema`).
pub fn is_row_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$` (the server's node slug).
pub fn is_node_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    let plain = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    (3..=63).contains(&bytes.len())
        && bytes.first().is_some_and(plain)
        && bytes.last().is_some_and(plain)
        && bytes.iter().all(|byte| plain(byte) || *byte == b'-')
        && !value.contains("--")
}

/// 22 base64url characters: a 16-byte id (`updateId`).
pub fn is_op_id_shaped(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A git commit id: 40 lowercase hex characters.
pub fn is_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 64 lowercase hex characters.
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A Rust target triple as `hello.node.build.target` carries it: 1-80 of `[A-Za-z0-9_.-]`.
pub fn is_target_triple(value: &str) -> bool {
    (1..=80).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// `MAJOR.MINOR.PATCH` with an optional `-pre` / `+build` of `[0-9A-Za-z.-]`, at most 64
/// characters (what `wsmp --version` prints after `wsmp `).
pub fn is_release_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let (core, rest) = value.split_at(core_end);
    let numbers: Vec<&str> = core.split('.').collect();
    numbers.len() == 3
        && numbers.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
        && rest
            .bytes()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
        && (rest.is_empty() || rest.len() > 1)
}

/// `https://…`, or `http://` to `localhost`, `127.0.0.1` or `[::1]` (tests, development). At
/// most 2048 characters, no credentials.
pub fn is_update_artifact_url(value: &str) -> bool {
    if value.len() > 2048 {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host().is_some(),
        "http" => match url.host() {
            Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
            None => false,
        },
        _ => false,
    }
}

/// `http://(127.0.0.1|[::1]|localhost):<1-5 digits>` with an optional `/v1`
/// (the TS `runtime.detected` `baseUrl` pattern).
fn is_detected_base_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let Some(rest) = ["127.0.0.1:", "[::1]:", "localhost:"]
        .iter()
        .find_map(|host| rest.strip_prefix(host))
    else {
        return false;
    };
    let port = rest.strip_suffix("/v1").unwrap_or(rest);
    (1..=5).contains(&port.len()) && port.bytes().all(|byte| byte.is_ascii_digit())
}

impl NodeFrame {
    /// Cross-field rules serde cannot express.
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        if let Self::Hello { node, .. } = self
            && let Some(build) = &node.build
        {
            rule(
                build.commit.as_deref().is_none_or(is_commit),
                "a build commit is 40 lowercase hex characters",
            )?;
            rule(
                is_target_triple(&build.target),
                "a build target is 1-80 characters of a target triple",
            )?;
        }
        match self {
            Self::AgentUpdateProgress {
                update_id,
                phase,
                reason,
                detail,
                available_version,
            } => {
                rule(
                    is_op_id_shaped(update_id),
                    "an update id is 22 base64url characters",
                )?;
                rule(
                    matches!(phase, UpdatePhase::Refused | UpdatePhase::Failed) == reason.is_some(),
                    "reason exactly for refused and failed updates",
                )?;
                rule(
                    available_version.as_deref().is_none_or(|version| {
                        is_release_version(version)
                            && *phase == UpdatePhase::Refused
                            && *reason == Some(UpdateReason::VersionMismatch)
                    }),
                    "an available version is a release version, only with a version_mismatch refusal",
                )?;
                rule(
                    detail
                        .as_ref()
                        .is_none_or(|text| text.encode_utf16().count() <= UPDATE_DETAIL_MAX_CHARS),
                    "an update detail is at most 4000 characters",
                )
            }
            Self::Hello {
                trust, features, ..
            }
            | Self::NodeState { trust, features } => {
                trust.validate()?;
                let shells = &features.terminals.shells;
                rule(
                    shells.len() <= crate::shells::MAX_SHELLS
                        && shells.iter().all(|id| crate::shells::valid_id(id))
                        && shells
                            .iter()
                            .enumerate()
                            .all(|(index, id)| !shells[..index].contains(id)),
                    "terminal shells are at most 16 distinct pwsh, powershell, cmd or wsl:<name> ids",
                )
            }
            Self::ExecStatus(status) => status.validate(),
            Self::SecretResult {
                name,
                status,
                reason,
                ..
            } => {
                rule(is_secret_name(name), "node secrets are named WSMP_SECRET_*")?;
                rule(
                    (*status == SecretStatus::Refused) == reason.is_some(),
                    "reason exactly for refused results",
                )
            }
            Self::RuntimeJobResult {
                status,
                error,
                exit_code,
                ..
            } => {
                rule(
                    (*status == JobStatus::Failed) == error.is_some(),
                    "error exactly on failed results",
                )?;
                rule(
                    exit_code.is_none() || *status == JobStatus::OperatorClosed,
                    "only operator_closed carries an exit code",
                )
            }
            Self::RuntimeDetected { servers, .. } => {
                rule(servers.len() <= 16, "at most 16 detected servers")?;
                for server in servers {
                    rule(
                        is_detected_base_url(&server.base_url),
                        "a detected server is a loopback http base URL",
                    )?;
                    rule(
                        server.models.len() <= 64
                            && server
                                .models
                                .iter()
                                .all(|id| !id.is_empty() && id.encode_utf16().count() <= 256),
                        "at most 64 detected model ids of 1-256 characters",
                    )?;
                    rule(
                        server.version.as_ref().is_none_or(|version| {
                            let trimmed = version.trim();
                            !trimmed.is_empty() && trimmed.encode_utf16().count() <= 80
                        }),
                        "a detected version is 1-80 characters",
                    )?;
                }
                Ok(())
            }
            Self::NodeMetrics(_) => rule(
                encoded_len(self) <= CHUNK_BUDGET_BYTES,
                "node.metrics stays within the chunk budget",
            ),
            Self::RuntimeDefineResult {
                is_final,
                results,
                held,
                held_metric_commands_hash,
                held_port_range,
                held_fabrics_hash,
                frozen,
                ..
            } => {
                rule(
                    [
                        held.is_some(),
                        held_metric_commands_hash.is_some(),
                        held_port_range.is_some(),
                        held_fabrics_hash.is_some(),
                        frozen.is_some(),
                    ]
                    .iter()
                    .all(|present| present == is_final),
                    "held state exactly on the final answer",
                )?;
                rule(
                    results
                        .iter()
                        .all(|r| (r.status == DefineStatus::Rejected) == r.reason.is_some()),
                    "reason exactly for rejected entries",
                )?;
                rule(
                    results.len() <= DEFINE_CHUNK_MAX_VERSIONS
                        && encoded_len(self) <= CHUNK_BUDGET_BYTES,
                    "a define answer stays within one chunk",
                )
            }
            _ => Ok(()),
        }
    }
}

impl ServerFrame {
    /// Cross-field rules serde cannot express.
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        match self {
            Self::AgentUpdateAck { update_id } => rule(
                is_op_id_shaped(update_id),
                "an update id is 22 base64url characters",
            ),
            Self::AgentUpdate {
                update_id,
                version,
                artifact_url,
                sha256,
                signature,
                rollback_after_secs,
                ..
            } => {
                rule(
                    is_op_id_shaped(update_id),
                    "an update id is 22 base64url characters",
                )?;
                rule(
                    is_release_version(version),
                    "an update version is a release version",
                )?;
                rule(
                    is_update_artifact_url(artifact_url),
                    "an update artifact is an https URL (http only to localhost)",
                )?;
                rule(
                    is_sha256_hex(sha256),
                    "an update sha256 is 64 lowercase hex characters",
                )?;
                rule(
                    signature
                        .as_ref()
                        .is_none_or(|text| !text.is_empty() && text.len() <= 4096),
                    "an update signature is 1-4096 characters",
                )?;
                rule(
                    UPDATE_ROLLBACK_SECS_RANGE.contains(rollback_after_secs),
                    "rollbackAfterSecs is 30 to 600",
                )
            }
            Self::RuntimeJob(job) => job.validate(),
            Self::SecretSet(secret) => secret.validate(),
            Self::TermOpen {
                shell: Some(shell), ..
            } => rule(
                crate::shells::valid_id(shell),
                "a terminal shell is pwsh, powershell, cmd or wsl:<name>",
            ),
            // `relayIdSchema`: the answer echoes it, so it must stay small.
            Self::RuntimeDetect { id } => rule(
                !id.trim().is_empty() && id.encode_utf16().count() <= 128,
                "a relay id is 1-128 characters",
            ),
            Self::ExecStart {
                command,
                argv,
                shell,
                timeout_ms,
                ..
            } => rule(
                (1_000..=NODE_COMMAND_MAX_MS).contains(timeout_ms),
                "a command lifetime is 1 s to 24 h",
            )
            .and_then(|()| {
                rule(
                    command.is_some() != argv.is_some(),
                    "a command is text or an argv, not both",
                )
            })
            .and_then(|()| {
                rule(
                    !(argv.is_some() && *shell == Some(super::runtime_spec::CommandShell::Cmd)),
                    "cmd cannot run an argv",
                )
            }),
            Self::ExecPoll { tail_bytes, .. } => rule(
                (*tail_bytes as usize) <= NODE_COMMAND_TAIL_MAX_BYTES,
                "a poll asks for at most 64 KiB of tail",
            ),
            Self::SecretDelete { name, .. } => {
                rule(is_secret_name(name), "node secrets are named WSMP_SECRET_*")
            }
            Self::RuntimeDefine {
                put,
                keep,
                remove,
                complete,
                node,
                ..
            } => {
                let named = put.as_ref().map_or(0, Vec::len)
                    + keep.as_ref().map_or(0, Vec::len)
                    + remove.as_ref().map_or(0, Vec::len);
                rule(
                    named <= DEFINE_CHUNK_MAX_VERSIONS,
                    "one chunk names at most 64 versions",
                )?;
                if let Some(node) = node {
                    rule(
                        canonical_len(&node.metric_commands.commands)
                            .is_some_and(|len| len <= NODE_METRIC_COMMANDS_MAX_BYTES),
                        "node metric commands are at most 32 KiB together",
                    )?;
                    node.fabrics.validate()?;
                    rule(
                        (NODE_COMMAND_MIN_MS..=NODE_COMMAND_MAX_MS).contains(&node.command_max_ms),
                        "commandMaxMs is 1 min to 24 h",
                    )?;
                }
                let complete = complete.unwrap_or(false);
                rule(
                    !complete || remove.is_none(),
                    "a complete operation lists put and keep, never remove",
                )?;
                rule(
                    complete || keep.is_none(),
                    "keep belongs to complete operations",
                )?;
                put.iter()
                    .flatten()
                    .try_for_each(DefinitionEnvelope::validate)
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::canonical::{canonical_sha256, launch_hash};
    use serde::de::DeserializeOwned;
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/relay-3.0")
    }

    fn load(dir: &str) -> Vec<(String, Value)> {
        let mut entries: Vec<(String, Value)> = std::fs::read_dir(fixtures().join(dir))
            .expect("fixture dir exists")
            .map(|entry| entry.expect("dir entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .map(|path| {
                let text = std::fs::read_to_string(&path).expect("fixture is readable");
                (
                    file_name(&path),
                    serde_json::from_str(&text).expect("fixture is JSON"),
                )
            })
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        assert!(!entries.is_empty(), "no fixtures in {dir}");
        entries
    }

    fn file_name(path: &Path) -> String {
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned()
    }

    /// JSON equality where `87` and `87.0` are the same number.
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(l, r)| same(l, r))
            }
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }

    trait Validated {
        fn ok(&self) -> bool;
    }
    impl Validated for NodeFrame {
        fn ok(&self) -> bool {
            self.validate().is_ok()
        }
    }
    impl Validated for ServerFrame {
        fn ok(&self) -> bool {
            self.validate().is_ok()
        }
    }
    impl Validated for ServerBinaryMetadata {
        fn ok(&self) -> bool {
            true
        }
    }
    impl Validated for NodeBinaryMetadata {
        fn ok(&self) -> bool {
            true
        }
    }
    fn valid<T: Validated>(frame: &T) -> bool {
        frame.ok()
    }

    fn round_trip<T: DeserializeOwned + Serialize + Validated>(dir: &str) -> Vec<(String, T)> {
        load(dir)
            .into_iter()
            .map(|(name, json)| {
                let frame: T = serde_json::from_value(json.clone())
                    .unwrap_or_else(|error| panic!("{dir}/{name}: {error}"));
                assert!(valid(&frame), "{dir}/{name} breaks a cross-field rule");
                let back = serde_json::to_value(&frame).expect("serializes");
                assert!(
                    same(&back, &json),
                    "{dir}/{name} did not round-trip:\n{back}\n{json}"
                );
                (name, frame)
            })
            .collect()
    }

    #[test]
    fn fabric_ips_match_the_shared_vectors() {
        let text = std::fs::read_to_string(fixtures().join("rules/fabric-ip.json"))
            .expect("fabric-ip vectors");
        let vectors: Value = serde_json::from_str(&text).expect("vectors are JSON");
        let list = |key: &str| -> Vec<String> {
            vectors[key]
                .as_array()
                .expect("a list")
                .iter()
                .map(|value| value.as_str().expect("a string").to_owned())
                .collect()
        };
        for ip in list("valid") {
            assert!(is_fabric_ip(&ip), "{ip} should be accepted");
        }
        for ip in list("invalid") {
            assert!(!is_fabric_ip(&ip), "{ip} should be refused");
        }
    }

    #[test]
    fn relay_requests_may_delete_stored_responses() {
        let mut frame: Value = serde_json::from_str(
            &std::fs::read_to_string(fixtures().join("frames/server-to-node/relay.request.json"))
                .expect("relay.request fixture"),
        )
        .expect("fixture is JSON");
        frame["method"] = Value::String("DELETE".into());
        frame["path"] = Value::String("/v1/responses/resp_1".into());
        let parsed: ServerFrame = serde_json::from_value(frame).expect("DELETE parses");
        assert!(
            serde_json::to_string(&parsed)
                .expect("serializes")
                .contains("\"DELETE\"")
        );
    }

    #[test]
    fn fabric_device_names_stay_plain() {
        for name in ["eth0", "enp1s0f0", "ib0", "mlx5_0", "eth0.100", "bond0:1"] {
            assert!(is_fabric_device_name(name), "{name}");
        }
        for name in [
            "",
            "-eth0",
            "eth0;reboot",
            "$(id)",
            "eth 0",
            &"a".repeat(65),
        ] {
            assert!(!is_fabric_device_name(name), "{name}");
        }
    }

    #[test]
    fn node_frames_round_trip() {
        round_trip::<NodeFrame>("frames/node-to-server");
    }

    #[test]
    fn server_frames_round_trip() {
        round_trip::<ServerFrame>("frames/server-to-node");
    }

    #[test]
    fn secret_values_never_reach_debug_output() {
        let frames = round_trip::<ServerFrame>("frames/server-to-node");
        let (_, frame) = frames
            .iter()
            .find(|(name, _)| name == "secret.set.json")
            .expect("secret.set fixture");
        let ServerFrame::SecretSet(secret) = frame else {
            panic!("secret.set parses as SecretSet");
        };
        let printed = format!("{frame:?}");
        assert!(!printed.contains(&secret.value), "{printed}");
        assert!(printed.contains("[redacted]"));
    }

    #[test]
    fn fabric_sets_hash_as_sent() {
        let frames = round_trip::<ServerFrame>("frames/server-to-node");
        let (_, frame) = frames
            .iter()
            .find(|(name, _)| name == "runtime.define.json")
            .expect("runtime.define fixture");
        let ServerFrame::RuntimeDefine {
            node: Some(node), ..
        } = frame
        else {
            panic!("runtime.define carries the node part");
        };
        let sets = serde_json::to_value(&node.fabrics.sets).expect("serializes");
        assert_eq!(
            canonical_sha256(&sets).expect("canonical"),
            node.fabrics.hash
        );
    }

    #[test]
    fn binary_metadata_round_trips() {
        round_trip::<ServerBinaryMetadata>("binary/server-to-node");
        round_trip::<NodeBinaryMetadata>("binary/node-to-server");
    }

    /// Shared vectors the server's schema refuses only for a field it does
    /// not have. wsmp ignores such a field (a later server may add one), and
    /// none of these grants anything: the node renders from its own held
    /// definition and resolves its own interface.
    const IGNORED_FIELD_VECTORS: &[&str] = &[
        "file-op-with-2.4-mode.json",
        "job-carries-command-text.json",
        "job-reservation-unknown-field.json",
        "job-server-sent-interface-name.json",
    ];

    #[test]
    fn hello_ok_features_are_optional_and_lenient() {
        let features = |json: Value| match serde_json::from_value::<ServerFrame>(json) {
            Ok(ServerFrame::HelloOk { features, .. }) => features,
            other => panic!("expected hello.ok, got {other:?}"),
        };
        let hello = |extra: Value| {
            let mut json = serde_json::json!({
                "type": "hello.ok",
                "id": "h-1",
                "protocolVersion": "3.0",
                "nodeId": "nd5q6w7e8r9t0y1u2i3o4p5a6",
                "definitionSync": "none",
            });
            if let (Some(object), Value::Object(extra)) = (json.as_object_mut(), extra) {
                object.extend(extra);
            }
            json
        };
        // An older server: none of it.
        assert_eq!(features(hello(serde_json::json!({}))), None);
        assert!(
            !features(hello(serde_json::json!({ "features": {} })))
                .unwrap_or_default()
                .exec_ran_with
        );
        // A later server's features this build does not know are ignored.
        assert_eq!(
            features(hello(serde_json::json!({
                "features": { "execRanWith": true, "laterThing": { "x": 1 } }
            }))),
            Some(ServerFeatures {
                exec_ran_with: true,
                agent_update_available_version: false,
            })
        );
        assert!(
            features(hello(serde_json::json!({
                "features": { "agentUpdateAvailableVersion": true }
            })))
            .unwrap_or_default()
            .agent_update_available_version
        );
    }

    #[test]
    fn ran_with_has_its_wire_shape() {
        let frame = NodeFrame::ExecStarted {
            command_id: "UnecweYLMFV6n8TpDjNYfQ".into(),
            started_at: "2026-10-06T12:00:00.000Z".into(),
            ends_by: "2026-10-06T13:00:00.000Z".into(),
            ran_with: Some(RanWith {
                shell: None,
                mode: RanMode::Direct,
            }),
        };
        let json = serde_json::to_value(&frame).expect("serializes");
        assert_eq!(
            json["ranWith"],
            serde_json::json!({ "shell": null, "mode": "direct" })
        );
        let without = NodeFrame::ExecStarted {
            command_id: "UnecweYLMFV6n8TpDjNYfQ".into(),
            started_at: "2026-10-06T12:00:00.000Z".into(),
            ends_by: "2026-10-06T13:00:00.000Z".into(),
            ran_with: None,
        };
        let json = serde_json::to_value(&without).expect("serializes");
        assert!(json.get("ranWith").is_none(), "{json}");
    }

    #[test]
    fn invalid_frames_are_refused() {
        for (name, json) in load("invalid/server-to-node") {
            let parsed = serde_json::from_value::<ServerFrame>(json.clone())
                .ok()
                .filter(|frame| frame.validate().is_ok());
            if IGNORED_FIELD_VECTORS.contains(&name.as_str()) {
                let frame = parsed.unwrap_or_else(|| panic!("server-to-node/{name} must parse"));
                let back = serde_json::to_value(&frame).expect("serializes");
                assert!(!same(&back, &json), "{name}: the extra field is dropped");
                continue;
            }
            assert!(parsed.is_none(), "server-to-node/{name} must be refused");
        }
        for (name, json) in load("invalid/node-to-server") {
            let refused = serde_json::from_value::<NodeFrame>(json)
                .map_or(true, |frame| frame.validate().is_err());
            assert!(refused, "node-to-server/{name} must be refused");
        }
    }

    #[test]
    fn define_and_inventory_name_the_launch_hash_of_their_spec() {
        let defines: Vec<Value> = load("frames/server-to-node")
            .into_iter()
            .map(|(_, json)| json)
            .filter(|json| json["type"] == "runtime.define")
            .collect();
        let put: Vec<&Value> = defines
            .iter()
            .filter_map(|define| define["put"].as_array())
            .flatten()
            .collect();
        assert!(put.len() > 1);
        for envelope in put {
            // Hash the spec exactly as received ...
            assert_eq!(
                launch_hash(&envelope["spec"]).expect("hash"),
                envelope["launchHash"].as_str().unwrap_or_default()
            );
            // ... and the typed mirror is complete: re-serializing changes nothing.
            let typed: DefinitionEnvelope =
                serde_json::from_value(envelope.clone()).expect("envelope parses");
            assert_eq!(typed.spec.kind(), typed.kind);
            let reserialized = serde_json::to_value(&typed.spec).expect("spec serializes");
            assert_eq!(
                launch_hash(&reserialized).expect("hash"),
                envelope["launchHash"].as_str().unwrap_or_default()
            );
        }
        let define = defines
            .iter()
            .find(|define| define.get("node").is_some())
            .expect("a define with the node part");
        let commands = &define["node"]["metricCommands"];
        assert_eq!(
            canonical_sha256(&commands["commands"]).expect("hash"),
            commands["hash"].as_str().unwrap_or_default()
        );
        let inventory = load("frames/node-to-server")
            .into_iter()
            .find(|(name, _)| name == "runtime.inventory.json")
            .map(|(_, json)| json)
            .expect("runtime.inventory fixture");
        for entry in inventory["alwaysOn"].as_array().expect("alwaysOn") {
            if let Some(spec) = entry.get("spec") {
                assert_eq!(
                    launch_hash(spec).expect("hash"),
                    entry["launchHash"].as_str().unwrap_or_default()
                );
            }
        }
    }

    #[test]
    fn job_unit_names_follow_the_handle() {
        for (name, frame) in round_trip::<ServerFrame>("frames/server-to-node") {
            if let ServerFrame::RuntimeJob(job) = frame {
                assert_eq!(
                    job.unit_name,
                    runtime_unit_name(&job.handle, job.rank),
                    "{name}"
                );
                assert!(job.rank < job.nnodes, "{name}");
            }
        }
    }

    #[test]
    fn job_reservations_follow_the_rules() {
        let frames = round_trip::<ServerFrame>("frames/server-to-node");
        let Some(ServerFrame::RuntimeJob(job)) = frames
            .into_iter()
            .find(|(name, _)| name == "runtime.job-reservations.json")
            .map(|(_, frame)| frame)
        else {
            panic!("runtime.job-reservations fixture");
        };
        let job = *job;
        assert_eq!(job.reservations.len(), 2);
        assert!(job.validate().is_ok());
        let broken = |change: &dyn Fn(&mut RuntimeJob)| {
            let mut copy = job.clone();
            change(&mut copy);
            copy.validate().is_err()
        };
        let entry = |index: u8| JobReservation {
            index,
            node_id: format!("wk{index}"),
            node: format!("worker-{index}"),
            gpu_ids: None,
        };
        assert!(broken(&|job| job.reservations[1].index = 0));
        assert!(broken(&|job| job.reservations[1].index = 8));
        assert!(broken(
            &|job| job.reservations = (0..9).map(|_| entry(0)).collect()
        ));
        assert!(broken(&|job| job.reservations[0].node_id = String::new()));
        assert!(broken(&|job| job.reservations[0].node_id = "a".repeat(65)));
        assert!(broken(&|job| job.reservations[0].node_id = "wk 1".into()));
        assert!(broken(&|job| job.reservations[0].node = "Worker-a".into()));
        assert!(broken(&|job| job.reservations[0].node = "worker--a".into()));
        assert!(broken(&|job| job.reservations[0].node = "-worker".into()));
        assert!(broken(&|job| job.reservations[0].node = "worker-".into()));
        assert!(broken(&|job| job.reservations[0].node = "ab".into()));
        assert!(broken(&|job| job.reservations[0].node = "a".repeat(64)));
        assert!(!broken(
            &|job| job.reservations = (0..8).map(entry).collect()
        ));
        assert!(!broken(&|job| job.reservations[0].node = "a".repeat(63)));
        assert!(!broken(&|job| job.reservations[0].node = "a1b".into()));
        // Worker GPUs: indices like the rank's `gpu_ids`, never keys or repeats.
        assert_eq!(job.reservations[0].gpu_ids.as_deref(), Some("1"));
        assert!(!broken(
            &|job| job.reservations[0].gpu_ids = Some("0,3".into())
        ));
        assert!(!broken(&|job| job.reservations[0].gpu_ids = None));
        assert!(broken(
            &|job| job.reservations[0].gpu_ids = Some(String::new())
        ));
        assert!(broken(
            &|job| job.reservations[0].gpu_ids = Some("nvidia:1".into())
        ));
        assert!(broken(
            &|job| job.reservations[0].gpu_ids = Some("01".into())
        ));
        assert!(broken(
            &|job| job.reservations[0].gpu_ids = Some("1,1".into())
        ));
        assert!(broken(
            &|job| job.reservations[0].gpu_ids = Some("256".into())
        ));
        assert!(!broken(&|job| job.reservations.clear()));
        // Multi-node jobs carry none.
        assert!(broken(&|job| {
            job.nnodes = 2;
            job.fabric_id = Some("fab_qsfp1".into());
            job.placeholders.head_addr = Some("10.0.0.5".into());
        }));
        // An empty list is never sent.
        let wire = serde_json::to_value(RuntimeJob {
            reservations: Vec::new(),
            ..job
        })
        .expect("serializes");
        assert!(wire.get("reservations").is_none());
    }

    #[test]
    fn agent_updates_follow_the_rules() {
        let frames = round_trip::<ServerFrame>("frames/server-to-node");
        let (_, update) = frames
            .into_iter()
            .find(|(name, _)| name == "agent.update.json")
            .expect("agent.update fixture");
        assert!(update.validate().is_ok());
        let broken = |change: &dyn Fn(&mut Value)| {
            let mut json = serde_json::to_value(&update).expect("serializes");
            change(&mut json);
            serde_json::from_value::<ServerFrame>(json)
                .map_or(true, |frame| frame.validate().is_err())
        };
        for url in [
            "http://example.com/a.tar.xz",
            "ftp://example.com/a.tar.xz",
            "https://user:pw@example.com/a.tar.xz",
            "file:///tmp/a.tar.xz",
            "not a url",
        ] {
            assert!(broken(&|json| json["artifactUrl"] = url.into()), "{url}");
        }
        for url in [
            "http://127.0.0.1:8080/a.tar.xz",
            "http://localhost/a.tar.xz",
            "http://[::1]:3000/a.zip",
            "https://objects.example.com/a.zip?sig=1",
        ] {
            assert!(!broken(&|json| json["artifactUrl"] = url.into()), "{url}");
        }
        assert!(broken(&|json| json["rollbackAfterSecs"] = 29.into()));
        assert!(broken(&|json| json["rollbackAfterSecs"] = 601.into()));
        assert!(!broken(&|json| json["rollbackAfterSecs"] = 30.into()));
        assert!(!broken(&|json| json["rollbackAfterSecs"] = 600.into()));
        assert!(broken(&|json| json["sha256"] = "ab".into()));
        assert!(broken(&|json| json["updateId"] = "short".into()));
        assert!(broken(&|json| json["version"] = "v0.4.3".into()));
        assert!(broken(&|json| json["version"] = "0.4".into()));
        assert!(!broken(&|json| json["version"] = "0.5.0-rc.1".into()));
        assert!(broken(&|json| json["signature"] = "".into()));
        assert!(!broken(&|json| json["signature"] = "RWQ...".into()));
        // A field a later server adds is ignored.
        assert!(!broken(&|json| json["unknown"] = true.into()));
    }

    #[test]
    fn update_progress_follows_the_rules() {
        let frame = |phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>| {
            NodeFrame::AgentUpdateProgress {
                update_id: "q8Zr0T3vX1yB2nC4dE5fGw".into(),
                phase,
                reason,
                detail,
                available_version: None,
            }
        };
        assert!(
            frame(UpdatePhase::Downloading, None, None)
                .validate()
                .is_ok()
        );
        assert!(
            frame(UpdatePhase::Failed, Some(UpdateReason::Internal), None)
                .validate()
                .is_ok()
        );
        assert!(frame(UpdatePhase::Failed, None, None).validate().is_err());
        assert!(
            frame(UpdatePhase::Swapped, Some(UpdateReason::Busy), None)
                .validate()
                .is_err()
        );
        assert!(
            frame(UpdatePhase::RolledBack, None, Some("é".repeat(4000)))
                .validate()
                .is_ok()
        );
        assert!(
            frame(UpdatePhase::RolledBack, None, Some("x".repeat(4001)))
                .validate()
                .is_err()
        );
        let available = |phase, reason, version: &str| NodeFrame::AgentUpdateProgress {
            update_id: "q8Zr0T3vX1yB2nC4dE5fGw".into(),
            phase,
            reason,
            detail: None,
            available_version: Some(version.into()),
        };
        let refused = Some(UpdateReason::VersionMismatch);
        let ok = available(UpdatePhase::Refused, refused, "0.4.4");
        assert!(ok.validate().is_ok());
        assert_eq!(
            serde_json::to_value(&ok).expect("serializes")["availableVersion"],
            "0.4.4"
        );
        assert!(
            available(UpdatePhase::Refused, refused, "latest")
                .validate()
                .is_err()
        );
        assert!(
            available(UpdatePhase::Refused, Some(UpdateReason::Busy), "0.4.4")
                .validate()
                .is_err()
        );
        assert!(
            available(UpdatePhase::Failed, refused, "0.4.4")
                .validate()
                .is_err()
        );
        // Absent unless there is a version to offer.
        assert!(
            serde_json::to_value(frame(UpdatePhase::Refused, refused, None))
                .expect("serializes")
                .get("availableVersion")
                .is_none()
        );
    }

    #[test]
    fn relay_failures_use_the_wire_spelling() {
        assert_eq!(
            serde_json::to_value(RelayFailure::Upstream5xx).expect("serializes"),
            Value::from("upstream_5xx")
        );
    }
}
