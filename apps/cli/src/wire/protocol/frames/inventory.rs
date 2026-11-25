//! Trust, held definitions, engine facts and the runtime inventory the node
//! reports.

use serde::{Deserialize, Serialize};

use crate::wire::protocol::runtime_spec::{
    EmbeddingContract, Engine, ModelCapability, ReaderSignal, RuntimeSpec, TranscriptionProfile,
};

use super::rules::{FrameRuleError, rule};

pub const RUNTIME_INVENTORY_CHUNK_MAX: usize = 512;

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

impl TrustState {
    pub fn validate(&self) -> Result<(), FrameRuleError> {
        rule(
            self.frozen == (self.value == TrustValue::Relay),
            "frozen is true exactly at relay",
        )
    }
}
