//! Server → node control frames and binary metadata.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::wire::protocol::runtime_spec::NODE_METRIC_COMMANDS_MAX_BYTES;

use super::hello::{DefinitionSync, ProtocolErrorCode, TerminalIdentity};
use super::relay::{FileOpKind, HttpMethod, RelayFailure, RequestFamily, SttAdapter, SttConfig};
use super::rules::{
    DEFINE_CHUNK_MAX_VERSIONS, FrameRuleError, canonical_len, is_op_id_shaped, is_release_version,
    is_secret_name, is_sha256_hex, is_update_artifact_url, rule,
};
use super::runtime::{
    DefinitionEnvelope, NODE_COMMAND_MAX_MS, NODE_COMMAND_MIN_MS, NODE_COMMAND_TAIL_MAX_BYTES,
    NodeDefinition, RuntimeJob, SecretSet,
};
use super::update::UPDATE_ROLLBACK_SECS_RANGE;

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
        shell: Option<crate::wire::protocol::runtime_spec::CommandShell>,
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
                crate::wire::protocol::valid_shell_id(shell),
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
                    !(argv.is_some()
                        && *shell == Some(crate::wire::protocol::runtime_spec::CommandShell::Cmd)),
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
