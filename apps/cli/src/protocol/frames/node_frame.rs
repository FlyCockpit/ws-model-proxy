//! Node → server control frames and binary metadata.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::runtime_spec::NodeFeatures;

use super::hello::HelloNode;
use super::inventory::{AlwaysOnInventory, HeldDefinition, InstanceRecord, TrustState};
use super::node_info::{NodeInfo, NodeMetrics};
use super::relay::{CountMethod, FileOpKind, RelayFailure, RelayMetrics, RelayUsage, SttEvent};
use super::rules::{
    CHUNK_BUDGET_BYTES, DEFINE_CHUNK_MAX_VERSIONS, FrameRuleError, encoded_len, is_commit,
    is_detected_base_url, is_op_id_shaped, is_release_version, is_secret_name, is_target_triple,
    rule,
};
use super::runtime::{
    DefineEntryResult, DefineNodeResult, DefineStatus, DetectedServer, ExecStatus, JobError,
    JobStatus, RanWith, RuntimeLoad, SecretRefusal, SecretStatus,
};
use super::update::{UPDATE_DETAIL_MAX_CHARS, UpdatePhase, UpdateReason};

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
        /// How the node ran it.
        ran_with: RanWith,
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
        /// The version the node could install instead, sent with a
        /// `refused` / `version_mismatch` reply so the owner may install it anyway.
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
                    shells.len() <= crate::protocol::MAX_SHELLS
                        && shells.iter().all(|id| crate::protocol::valid_shell_id(id))
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
