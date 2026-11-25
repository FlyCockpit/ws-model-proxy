//! The runtime frames' payloads: `runtime.load`, `runtime.define` and its
//! answer, node commands, fabrics, secrets, metric commands and
//! `runtime.job`.

use serde::{Deserialize, Serialize};

use crate::wire::protocol::runtime_spec::{
    Engine, FABRIC_MEMBERS_MAX, NODE_FABRICS_MAX, NodeMetricCommand, RUNTIME_SPEC_MAX_BYTES,
    RuntimeApi, RuntimeKind, RuntimeSpec,
};

use super::rules::{
    FrameRuleError, canonical_len, is_fabric_ip, is_gpu_ids, is_node_slug, is_row_id,
    is_secret_name, rule,
};

/// Unit names are deterministic (§3.5): `wsmp-<handle>-r<rank>`.
pub fn runtime_unit_name(handle: &str, rank: u8) -> String {
    format!("wsmp-{handle}-r{rank}")
}

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

/// How a node command ran (`exec.started`'s `ranWith`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RanWith {
    /// The shell that read the command: `sh`, `pwsh`, `powershell` or `cmd`
    /// (`cmd` also for a `.bat` or `.cmd` argv on Windows, which cmd runs).
    /// Null for a program started directly.
    pub shell: Option<crate::wire::protocol::runtime_spec::CommandShell>,
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
    /// The operator terminal an interactive step runs in, and who wrote its command.
    /// `None` for a step the node runs itself.
    pub fn operator(&self) -> Option<(&str, CommandAuthor)> {
        self.operator
            .as_ref()
            .map(|operator| (operator.terminal_id.as_str(), operator.command_author))
    }

    /// The job's reservations, else `launch`'s (those of the launch a stop or check
    /// names).
    pub fn reservations_or(&self, launch: &[JobReservation]) -> Vec<JobReservation> {
        if self.reservations.is_empty() {
            launch.to_vec()
        } else {
            self.reservations.clone()
        }
    }

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
