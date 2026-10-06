//! Relay protocol 3.0 frames, both directions (S0 contract).
//!
//! Serde mirror of `apps/server/src/relay/frames.ts`. Every fixture under
//! `tests/fixtures/relay-3.0/` must deserialize here and serialize back to the
//! same JSON (tests below). Unknown fields and frame types are refused
//! (`deny_unknown_fields`); the server accepts exactly protocol `3.0`.
//!
//! These types fix the wire shape. Value rules the node enforces on top of
//! them (placeholder typing §4.6, define validation §4.3, path allowlist §4.8)
//! land in chunks C1–C4.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::runtime_spec::{
    DeclaredHardware, EmbeddingContract, Engine, ModelCapability, NodeFeatures, NodeMetricCommand,
    ReaderSignal, RuntimeApi, RuntimeKind, RuntimeSpec, TranscriptionProfile,
};
use crate::stt_wire::SttEvent;

pub const RELAY_PROTOCOL_VERSION: &str = "3.0";
pub const RELAY_SUBPROTOCOL: &str = "ws-model-proxy.relay.v3";
pub const RUNTIME_INVENTORY_CHUNK_MAX: usize = 512;

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
    #[serde(rename = "unknown")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_peers: Option<Vec<FrozenPeerSet>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrozenPeerSet {
    pub runtime_id: String,
    pub head_addr: String,
    pub peers: Vec<String>,
}

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
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_facts: Option<EngineFacts>,
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
    /// The node-side declaration (`config.json` `hardware`), incl. reserved memory.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
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
#[serde(deny_unknown_fields)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iface: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandAuthor {
    User,
    Agent,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobOperator {
    pub terminal_id: String,
    pub command_author: CommandAuthor,
}

/// No command text: the node renders from the held/frozen definition whose
/// `launchHash` matches (§4.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    pub timeout_ms: u64,
    pub owner_epoch: String,
    pub intent_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<JobOperator>,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
}

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
        runtimes: Vec<AlwaysOnInventory>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<u8>,
    },
    #[serde(rename = "runtime.define.result")]
    RuntimeDefineResult {
        op_id: String,
        results: Vec<DefineEntryResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node: Option<DefineNodeResult>,
        /// The complete held set after applying the frame.
        held: Vec<HeldDefinition>,
        held_metric_commands_hash: Option<String>,
        held_port_range: Option<[u16; 2]>,
        frozen: bool,
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
    ExecStarted { command_id: String },
    #[serde(rename = "exec.rejected")]
    ExecRejected { command_id: String, reason: String },
    #[serde(rename = "exec.done")]
    ExecDone {
        command_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
        timed_out: bool,
    },
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
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ServerFrame {
    #[serde(rename = "hello.challenge")]
    HelloChallenge { nonce: String, origin: String },
    #[serde(rename = "hello.ok")]
    HelloOk {
        id: String,
        protocol_version: String,
        node_id: String,
        definition_sync: DefinitionSync,
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
    #[serde(rename = "runtime.define")]
    RuntimeDefine {
        op_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        put: Option<Vec<DefinitionEnvelope>>,
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
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
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
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
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
    #[serde(rename = "exec.stdout")]
    ExecStdout { command_id: String, seq: u64 },
    #[serde(rename = "exec.stderr")]
    ExecStderr { command_id: String, seq: u64 },
    #[serde(rename = "file.data")]
    FileData { op_id: String },
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

    fn round_trip<T: DeserializeOwned + Serialize>(dir: &str) -> Vec<(String, T)> {
        load(dir)
            .into_iter()
            .map(|(name, json)| {
                let frame: T = serde_json::from_value(json.clone())
                    .unwrap_or_else(|error| panic!("{dir}/{name}: {error}"));
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
    fn node_frames_round_trip() {
        round_trip::<NodeFrame>("frames/node-to-server");
    }

    #[test]
    fn server_frames_round_trip() {
        round_trip::<ServerFrame>("frames/server-to-node");
    }

    #[test]
    fn binary_metadata_round_trips() {
        round_trip::<ServerBinaryMetadata>("binary/server-to-node");
        round_trip::<NodeBinaryMetadata>("binary/node-to-server");
    }

    #[test]
    fn invalid_frames_are_refused() {
        for (name, json) in load("invalid/server-to-node") {
            assert!(
                serde_json::from_value::<ServerFrame>(json).is_err(),
                "server-to-node/{name} must be refused"
            );
        }
        for (name, json) in load("invalid/node-to-server") {
            assert!(
                serde_json::from_value::<NodeFrame>(json).is_err(),
                "node-to-server/{name} must be refused"
            );
        }
    }

    #[test]
    fn define_and_inventory_name_the_launch_hash_of_their_spec() {
        let define = load("frames/server-to-node")
            .into_iter()
            .find(|(name, _)| name == "runtime.define.json")
            .map(|(_, json)| json)
            .expect("runtime.define fixture");
        let put = define["put"].as_array().expect("put");
        assert!(!put.is_empty());
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
    fn relay_failures_use_the_wire_spelling() {
        assert_eq!(
            serde_json::to_value(RelayFailure::Upstream5xx).expect("serializes"),
            Value::from("upstream_5xx")
        );
    }
}
