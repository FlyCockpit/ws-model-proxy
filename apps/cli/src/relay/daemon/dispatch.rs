//! Frames from the server: each control and binary frame routed to the
//! part of the session it concerns, and malformed frames refused by name.

use std::time::Instant;

use anyhow::Result;

use crate::node::config::Config;
use crate::relay::sessions::{ExecLine, ExecRegistry, TermHandshake, TerminalRegistry};
use crate::relay::startup::TerminalStartup;
use crate::services::stt_wire::SttServerMessage;
use crate::wire::protocol::frames::{HttpMethod, SecretRefusal, SecretStatus};
use crate::wire::protocol::{
    FrameFault, NodeFrame, ProtocolErrorCode, RelayFailure, ServerBinaryMetadata, ServerFrame,
    binary_frame_fault, control_frame_fault, parse_server_control,
};

use super::handshake::{StopOn, hello_rejection};
use super::local::{NodeChange, apply_lower};
use super::request_body::{BodyRoute, deliver_body_chunk};
use super::requests::{RelayRequest, RequestBody, RequestState, Retire, start_relay_request};
use super::runtime_jobs::handle_runtime_job;
use super::session::{
    Session, SessionPhase, apply_node_changes, node_state, send_inventory, sync_metric_commands,
};
use super::wire::{
    RelaySessionError, RelaySessionResult, send_control, send_file_frames, send_outbound_frames,
    send_relay_error, send_stt_frames,
};

/// A control frame that does not parse: what it concerns (one request, one
/// terminal, one command, ...) is refused by name, or the session ends
/// ([`FrameFault::Fatal`]). The log names the frame's type and serde's message,
/// which names the field that failed.
fn handle_unreadable<S>(
    socket: &mut tungstenite::WebSocket<S>,
    session: &mut Session,
    text: &str,
    error: &anyhow::Error,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let value = serde_json::from_str::<serde_json::Value>(text).ok();
    let frame_type = value
        .as_ref()
        .and_then(|value| value.get("type")?.as_str().map(str::to_owned));
    // The JSON path that failed, when serde can place it (`$` when it cannot).
    let path = value
        .as_ref()
        .and_then(crate::node::runtime_store::repair::first_error::<ServerFrame>)
        .map(|(path, _)| path);
    tracing::warn!(
        frame_type = frame_type.as_deref().unwrap_or("(none)"),
        path = path.as_deref().unwrap_or("(unknown)"),
        error = %format!("{error:#}"),
        "a relay frame could not be read"
    );
    let fault = control_frame_fault(text);
    if let Some(result) = apply_stt_fault(socket, &mut session.stt, &fault) {
        return result;
    }
    apply_frame_fault(socket, fault, &mut session.terminals, session.execs, error)
}

pub(super) fn handle_text<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    startup: &TerminalStartup,
    session: &mut Session,
    text: &str,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    // A `runtime.define` with one definition (or a node part) this build cannot
    // read: those parts are refused by id and the rest is handled, instead of
    // the whole frame ending the session (`runtime_store::repair`).
    let mut repaired_text = None;
    let mut define_refusals = None;
    let frame = match parse_server_control(text) {
        Ok(frame) => frame,
        Err(error) => {
            if let Some(repaired) = crate::node::runtime_store::repair::repair_runtime_define(
                text,
                parse_server_control,
                |part| {
                    tracing::warn!(
                        part = %part.part,
                        path = %part.path,
                        error = %part.error,
                        "refusing a runtime definition this wsmp cannot read"
                    );
                },
            ) {
                repaired_text = Some(repaired.text);
                define_refusals = Some(repaired.refusals);
                repaired.frame
            } else {
                return handle_unreadable(socket, session, text, &error);
            }
        }
    };
    let text = repaired_text.as_deref().unwrap_or(text);
    if let Some(message) = SttServerMessage::from_frame(&frame) {
        let endpoints = if matches!(message, SttServerMessage::Open { .. }) {
            session.runtimes.endpoints()
        } else {
            Vec::new()
        };
        let frames = session.stt.handle(message, &endpoints, Instant::now());
        return send_stt_frames(socket, &mut session.stt, frames);
    }
    let state_dir = crate::paths::state_dir().ok();
    match frame {
        ServerFrame::HelloOk {
            id,
            node_id,
            definition_sync,
            ..
        } => {
            if session.phase.is_registered() {
                return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                    "duplicate relay registration acknowledgement"
                )));
            }
            session.phase = SessionPhase::Registered {
                since: Instant::now(),
            };
            tracing::info!(id, node_id, ?definition_sync, "relay registration accepted");
            session.update.on_hello_ok(definition_sync);
            send_inventory(session);
        }
        ServerFrame::HelloChallenge { .. } => {
            return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                "server sent hello.challenge after hello"
            )));
        }
        ServerFrame::ProtocolError { message, code, .. } => {
            if code == ProtocolErrorCode::Internal {
                return Err(RelaySessionError::Reconnectable {
                    error: anyhow::anyhow!("relay protocol error: {message}"),
                });
            }
            if session.phase.is_registered() {
                return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                    "relay protocol error: {message}"
                )));
            }
            return Err(hello_rejection(&message, &code, StopOn::here()));
        }
        ServerFrame::HeartbeatPong { id, .. } => {
            tracing::debug!(id, "relay heartbeat acknowledged");
        }
        ServerFrame::TrustLower { id, .. } => {
            lower_trust(socket, startup, session, &id)?;
        }
        ServerFrame::RuntimeDefine { .. } => {
            let runtime_hosts = startup.runtime_hosts();
            let busy_ports = session.runtimes.busy_ports();
            let ctx = crate::node::runtime_store::DefineContext {
                trust: startup.trust_value(),
                runtime_hosts: &runtime_hosts,
                busy_ports: &busy_ports,
            };
            let live = crate::node::runtime_store::live_path().map_err(RelaySessionError::Fatal)?;
            let is_final = matches!(frame, ServerFrame::RuntimeDefine { is_final: true, .. });
            match session.defines.handle(text, &frame, &ctx, &live) {
                Ok(mut outcome) => {
                    if let Some(refusals) = &define_refusals {
                        refusals.merge_into(&mut outcome.answer);
                    }
                    send_control(socket, &outcome.answer, "answering a runtime definition")?;
                    if is_final {
                        session.update.on_definitions_applied();
                    }
                    if outcome.changed {
                        session
                            .runtimes
                            .reload(startup.trust_value(), &startup.runtime_hosts());
                        session
                            .execs
                            .set_command_max(session.runtimes.command_max());
                        sync_metric_commands(session);
                        send_inventory(session);
                    }
                }
                Err(error) => {
                    // Out-of-order chunks or an unreadable store: the server
                    // times the operation out and retries it whole.
                    tracing::warn!(
                        error = %format!("{error:#}"),
                        "a runtime definition could not be applied"
                    );
                }
            }
        }
        ServerFrame::AgentUpdate {
            update_id,
            version,
            artifact_url,
            sha256,
            signature,
            force,
            rollback_after_secs,
        } => {
            let identity = crate::relay::update::build::identity();
            // Taken first: a lowering from here on revokes the update, at once.
            let trust = startup.trust_watch();
            let gate = crate::relay::update::agent::Gate {
                full_control: startup.full_control(),
                remote: Config::load_required()
                    .map(|config| config.remote_updates)
                    .unwrap_or_default(),
                method: identity.method,
                has_live: identity.live.is_some(),
                under_service: crate::host::service::under_service_manager(),
            };
            tracing::info!(update_id, version, force, "update requested");
            let frames = session.update.request(
                crate::relay::update::agent::UpdateFrame {
                    update_id,
                    version,
                    artifact_url,
                    sha256,
                    signature,
                    force,
                    rollback_after_secs,
                },
                &gate,
                trust,
            );
            for frame in frames {
                send_control(socket, &frame, "answering an update")?;
            }
        }
        ServerFrame::AgentUpdateAck { update_id } => session.update.acked(&update_id),
        ServerFrame::RuntimeDetect { id } => {
            // Off this loop: a scan takes seconds. Ports the node's own
            // instances hold are runtimes already, not discoveries.
            crate::services::runtimes::detect::spawn(
                session.worker_tx.clone(),
                id,
                session.runtimes.busy_ports().into_keys().collect(),
            );
        }
        ServerFrame::RuntimeInventoryOk { snapshot_id } => {
            tracing::debug!(snapshot_id, "runtime inventory acknowledged");
        }
        ServerFrame::RuntimeInventoryError {
            snapshot_id,
            message,
        } => {
            tracing::warn!(
                snapshot_id,
                message,
                "the server rejected the runtime inventory"
            );
        }
        ServerFrame::RuntimeJob(job) => {
            handle_runtime_job(socket, startup, session, *job)?;
        }
        ServerFrame::SecretSet(secret) => {
            let result =
                crate::node::secrets::set(startup.full_control(), &secret.name, &secret.value);
            for frame in secret_answer(secret.id, secret.name, result, || node_state(startup)) {
                send_control(socket, &frame, "answering a secret write")?;
            }
        }
        ServerFrame::SecretDelete { id, name } => {
            let result = crate::node::secrets::delete(startup.full_control(), &name);
            for frame in secret_answer(id, name, result, || node_state(startup)) {
                send_control(socket, &frame, "answering a secret removal")?;
            }
        }
        ServerFrame::RelayCancel { request_id, reason } => {
            tracing::warn!(request_id, ?reason, "relay request cancelled");
            // Cancelled request: any body chunks still in flight are late, not
            // premature — drop them silently rather than faulting them.
            if session.requests.retire(&request_id, Retire::Cancelled) {
                send_control(
                    socket,
                    &NodeFrame::RelayCancelled { request_id },
                    "sending relay cancellation acknowledgement",
                )?;
            }
        }
        ServerFrame::RelayRequest {
            request_id,
            method,
            path,
            headers,
            timeout_ms,
            handle,
            expect_body,
            body_bytes,
            count_first,
            count_ceiling,
            ..
        } => {
            start_relay_request(
                socket,
                config,
                &session.runtimes,
                &session.worker_tx,
                &mut session.requests,
                RelayRequest {
                    request_id,
                    method: match method {
                        HttpMethod::Get => "GET",
                        HttpMethod::Post => "POST",
                        HttpMethod::Delete => "DELETE",
                    }
                    .to_string(),
                    path,
                    headers,
                    timeout_ms,
                    handle,
                    expect_body,
                    body_bytes,
                    count_first: count_first.unwrap_or(false),
                    count_ceiling,
                },
            )?;
        }
        ServerFrame::TermOpen {
            terminal_id,
            viewer_id,
            cols,
            rows,
            browser_public_key,
            browser_nonce,
            identity,
            shell,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.open(
                    startup,
                    state_dir.as_deref(),
                    TermHandshake {
                        terminal_id: &terminal_id,
                        viewer_id: viewer_id.as_deref(),
                        cols,
                        rows,
                        browser_public_key: &browser_public_key,
                        browser_nonce: &browser_nonce,
                        identity: identity.as_ref(),
                        shell: shell.as_deref(),
                    },
                ),
            )?;
        }
        ServerFrame::TermAttach {
            terminal_id,
            viewer_id,
            browser_public_key,
            browser_nonce,
            identity,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.attach(
                    startup,
                    state_dir.as_deref(),
                    TermHandshake {
                        terminal_id: &terminal_id,
                        viewer_id: viewer_id.as_deref(),
                        cols: 0,
                        rows: 0,
                        browser_public_key: &browser_public_key,
                        browser_nonce: &browser_nonce,
                        identity: identity.as_ref(),
                        shell: None,
                    },
                ),
            )?;
        }
        ServerFrame::TermDetach {
            terminal_id,
            viewer_id,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.detach(&terminal_id, viewer_id.as_deref()),
            )?;
        }
        ServerFrame::TermClose { terminal_id } => {
            send_outbound_frames(socket, session.terminals.close_from_server(&terminal_id))?;
        }
        ServerFrame::TermAuth {
            terminal_id,
            viewer_id,
            signature,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.auth(
                    startup,
                    state_dir.as_deref(),
                    &terminal_id,
                    viewer_id.as_deref(),
                    &signature,
                ),
            )?;
        }
        ServerFrame::ExecStart {
            command_id,
            command,
            argv,
            shell,
            cwd,
            timeout_ms,
        } => {
            // The frame rules let exactly one of `command` and `argv` through.
            if session.update.holds_new_work() {
                return send_control(
                    socket,
                    &NodeFrame::ExecRejected {
                        command_id,
                        reason: "updating".into(),
                    },
                    "refusing a command during an update",
                );
            }
            let line = match (&command, &argv) {
                (Some(text), _) => ExecLine::Text(text),
                (None, Some(argv)) => ExecLine::Argv(argv),
                (None, None) => ExecLine::Argv(&[]),
            };
            send_outbound_frames(
                socket,
                session.execs.start(
                    startup,
                    &command_id,
                    &line,
                    shell,
                    cwd.as_deref(),
                    timeout_ms,
                ),
            )?;
        }
        ServerFrame::ExecPoll {
            command_id,
            tail_bytes,
        } => {
            send_outbound_frames(
                socket,
                session
                    .execs
                    .status(&command_id, usize::try_from(tail_bytes).unwrap_or(0)),
            )?;
        }
        ServerFrame::ExecCancel { command_id } => {
            send_outbound_frames(socket, session.execs.cancel(&command_id))?;
        }
        ServerFrame::FileOp {
            op_id,
            op,
            args,
            body_bytes,
        } => {
            send_file_frames(
                socket,
                session.files.handle_op(
                    &op_id,
                    crate::services::file_relay::op_name(op),
                    args,
                    body_bytes.and_then(|bytes| usize::try_from(bytes).ok()),
                ),
            )?;
        }
        ServerFrame::FileCancel { op_id } => {
            session.files.handle_cancel(&op_id);
        }
        // Speech frames were handled above.
        ServerFrame::SttOpen { .. }
        | ServerFrame::SttUpdate { .. }
        | ServerFrame::SttCommit { .. }
        | ServerFrame::SttClear { .. }
        | ServerFrame::SttClose { .. } => {}
    }
    Ok(())
}

/// `trust.lower`: Relay only from now on, persisted and frozen, then the
/// same effects as any lowering. Answered with `node.state`.
fn lower_trust<S>(
    socket: &mut tungstenite::WebSocket<S>,
    startup: &TerminalStartup,
    session: &mut Session,
    id: &str,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    if let Err(error) = apply_lower(startup) {
        // Latched for this daemon anyway; the frozen copy, when it was
        // written, keeps the node lowered after a restart.
        tracing::error!(
            error = %format!("{error:#}"),
            "persisting the lowered trust failed"
        );
    }
    tracing::warn!(id, "a person lowered this node to Relay only");
    apply_node_changes(socket, startup, session, &[NodeChange::Trust])
}

/// The answer to a secret write, then (when the secret set changed) a
/// `node.state` whose features carry the new secret names, so the server
/// lists them without waiting for the next hello.
fn secret_answer(
    id: String,
    name: String,
    result: Result<crate::node::secrets::Outcome, SecretRefusal>,
    state: impl FnOnce() -> NodeFrame,
) -> Vec<NodeFrame> {
    let changed = matches!(
        result,
        Ok(crate::node::secrets::Outcome::Set { .. } | crate::node::secrets::Outcome::Deleted)
    );
    let mut frames = vec![secret_result(id, name, result)];
    if changed {
        frames.push(state());
    }
    frames
}

fn secret_result(
    id: String,
    name: String,
    result: Result<crate::node::secrets::Outcome, SecretRefusal>,
) -> NodeFrame {
    let (status, reason, updated_at) = match result {
        Ok(crate::node::secrets::Outcome::Set { updated_at }) => {
            (SecretStatus::Set, None, Some(updated_at))
        }
        Ok(crate::node::secrets::Outcome::Deleted) => (SecretStatus::Deleted, None, None),
        Ok(crate::node::secrets::Outcome::NotFound) => (SecretStatus::NotFound, None, None),
        Err(reason) => (SecretStatus::Refused, Some(reason), None),
    };
    NodeFrame::SecretResult {
        id,
        name,
        status,
        reason,
        updated_at,
    }
}

/// A malformed frame that names a speech-to-text session concerns only it.
fn apply_stt_fault<S>(
    socket: &mut tungstenite::WebSocket<S>,
    stt: &mut crate::services::stt::SttRegistry,
    fault: &FrameFault,
) -> Option<RelaySessionResult<()>>
where
    S: std::io::Read + std::io::Write,
{
    let frames = match fault {
        FrameFault::RejectStt { session_id } => stt.malformed(session_id, true),
        FrameFault::FailStt { session_id } => stt.malformed(session_id, false),
        _ => return None,
    };
    tracing::warn!("a malformed speech-to-text frame");
    Some(send_stt_frames(socket, stt, frames))
}

fn apply_frame_fault<S>(
    socket: &mut tungstenite::WebSocket<S>,
    fault: FrameFault,
    terminals: &mut TerminalRegistry,
    execs: &mut ExecRegistry,
    error: &anyhow::Error,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    match fault {
        FrameFault::Fatal => {
            let _ = error;
            Err(RelaySessionError::Fatal(anyhow::anyhow!(
                "malformed relay frame"
            )))
        }
        FrameFault::Ignore => {
            tracing::warn!("ignoring a malformed or unknown relay frame");
            Ok(())
        }
        FrameFault::CloseTerminal { terminal_id } => {
            tracing::warn!(terminal_id, "closing a terminal after a malformed frame");
            send_outbound_frames(socket, terminals.close_from_server(&terminal_id))
        }
        FrameFault::DropViewer {
            terminal_id,
            viewer_id,
        } => {
            tracing::warn!(
                terminal_id,
                "removing a terminal viewer after a malformed frame"
            );
            send_outbound_frames(socket, terminals.drop_viewer(&terminal_id, &viewer_id))
        }
        FrameFault::CloseCommand { command_id } => {
            tracing::warn!(command_id, "closing a command after a malformed frame");
            send_outbound_frames(socket, execs.cancel(&command_id))
        }
        FrameFault::RejectExec { command_id } => {
            tracing::warn!(command_id, "refusing a malformed exec command request");
            // `reject_malformed` builds the refusal through `exec_rejected`,
            // which logs that command's one outcome line.
            send_outbound_frames(socket, execs.reject_malformed(&command_id))
        }
        FrameFault::RejectUpdate { update_id } => {
            tracing::warn!(update_id, "refusing a malformed update request");
            send_control(
                socket,
                &NodeFrame::AgentUpdateProgress {
                    update_id,
                    phase: crate::wire::protocol::frames::UpdatePhase::Failed,
                    reason: Some(crate::wire::protocol::frames::UpdateReason::Internal),
                    detail: Some("the node could not read this `agent.update`".into()),
                    available_version: None,
                },
                "refusing an update",
            )
        }
        FrameFault::RejectFile { op_id } => {
            tracing::warn!("refusing a malformed file op");
            send_control(
                socket,
                &NodeFrame::FileRejected {
                    op_id,
                    reason: "bad_frame".to_string(),
                    detail: None,
                },
                "sending a file op rejection",
            )
        }
        // Speech-to-text faults go to the session registry first
        // (`apply_stt_fault`); one arriving here has nothing left to name.
        FrameFault::RejectStt { .. } | FrameFault::FailStt { .. } => {
            tracing::warn!("ignoring a malformed speech-to-text frame");
            Ok(())
        }
    }
}

pub(super) fn handle_binary<S>(
    socket: &mut tungstenite::WebSocket<S>,
    bytes: &[u8],
    session: &mut Session,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let (metadata, body) = match binary_frame_fault(bytes) {
        Ok(parsed) => parsed,
        Err(fault) => {
            if let Some(result) = apply_stt_fault(socket, &mut session.stt, &fault) {
                return result;
            }
            return apply_frame_fault(
                socket,
                fault,
                &mut session.terminals,
                session.execs,
                &anyhow::anyhow!("malformed relay binary frame"),
            );
        }
    };
    let (request_id, is_final) = match metadata {
        ServerBinaryMetadata::RelayRequestBody {
            request_id,
            is_final,
            ..
        } => (request_id, is_final),
        ServerBinaryMetadata::TermSealed {
            terminal_id,
            seq,
            viewer_id,
            ..
        } => {
            return send_outbound_frames(
                socket,
                session
                    .terminals
                    .handle_sealed(&terminal_id, viewer_id.as_deref(), seq, &body),
            );
        }
        ServerBinaryMetadata::FileBody { op_id } => {
            send_file_frames(socket, session.files.handle_body(&op_id, body))?;
            return Ok(());
        }
        ServerBinaryMetadata::SttAudio { session_id, seq } => {
            let frames = session.stt.audio(&session_id, seq, body);
            return send_stt_frames(socket, &mut session.stt, frames);
        }
    };

    let last = is_final == Some(true);
    let requests = &mut session.requests;
    let worker = match requests.state(&request_id) {
        RequestState::Live(worker) => worker,
        // A fast upstream responded and was reaped before the server
        // flushed the body tail: expected, dropped silently.
        RequestState::Retired => {
            tracing::debug!(
                request_id = request_id,
                "dropping late relay body chunk for an already-finished request"
            );
            return Ok(());
        }
        // Only a genuinely unknown id is a protocol violation.
        RequestState::Unknown => {
            send_relay_error(
                socket,
                &request_id,
                RelayFailure::ProtocolError,
                Some("request body chunk arrived before request metadata".to_string()),
                None,
            )?;
            return Ok(());
        }
    };
    let body_tx = match &worker.body {
        RequestBody::Open(body_tx) => body_tx,
        RequestBody::Complete => {
            // The server never sends past `isFinal`; nothing reads it.
            tracing::warn!(
                request_id = request_id,
                "dropping a relay body chunk after the final one"
            );
            return Ok(());
        }
        RequestBody::None => {
            // Body frame for a request that declared no body.
            requests.retire(&request_id, Retire::Faulted);
            send_relay_error(
                socket,
                &request_id,
                RelayFailure::ProtocolError,
                Some("unexpected request body chunk for a body-less request".to_string()),
                None,
            )?;
            return Ok(());
        }
    };

    tracing::debug!(
        request_id = request_id,
        bytes = body.len(),
        "received relay request body chunk"
    );

    match deliver_body_chunk(body_tx, body, last) {
        BodyRoute::Delivered | BodyRoute::WorkerGone => {
            // Gone: upstream already finished or rejected the request early;
            // further body frames drop and the worker reports the outcome.
            if last {
                // Queued chunks still reach the worker after the sender drops.
                worker.body = RequestBody::Complete;
            }
            Ok(())
        }
        BodyRoute::OverCredit => {
            requests.retire(&request_id, Retire::Faulted);
            send_relay_error(
                socket,
                &request_id,
                RelayFailure::ProtocolError,
                Some("request body exceeded the granted flow-control window".to_string()),
                None,
            )?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::link::RELAY_WORKER_OUTBOUND_CAPACITY;
    use super::super::wire::send_stt;
    use super::super::wire::tests::sink_socket;
    use super::*;
    use crate::relay::sessions::DEFAULT_COMMAND_MAX;
    use crate::services::relay_bus::FromWorker;
    use std::sync::mpsc;

    /// Collects `tracing` output for tests (an in-memory writer).
    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuf {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Ok(mut inner) = self.0.lock() {
                inner.extend_from_slice(bytes);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = LogBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// A malformed `exec.start` / `term.spawn` names a command but cannot be
    /// read as a request, so it never reaches a registry. The daemon still
    /// owes that command its one outcome line (AC 8): without the explicit
    /// log here, a refused command would leave no CLI-side record at all.
    #[test]
    fn malformed_command_requests_log_one_rejection_each() {
        let _capture = crate::app::logging::test_capture_lock();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let (tx, _rx) = mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
            let mut terminals = TerminalRegistry::new(tx);
            let (exec_tx, _exec_rx) =
                mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
            let mut execs = ExecRegistry::new(exec_tx, DEFAULT_COMMAND_MAX);
            let error = anyhow::anyhow!("malformed relay frame");
            // The frame names a command but its command string is NUL-bearing
            // (and it lacks `timeoutMs`): `control_frame_fault` attributes it
            // and `apply_frame_fault` refuses it without reaching a registry.
            let frame = r#"{"type":"exec.start","commandId":"cmd-exec-9f3a","command":"x\u0000y"}"#;
            {
                let mut socket = sink_socket();
                let fault = crate::wire::protocol::control_frame_fault(frame);
                assert!(
                    apply_frame_fault(&mut socket, fault, &mut terminals, &mut execs, &error)
                        .is_ok(),
                    "a refused command is not fatal"
                );
                assert!(
                    !socket.get_ref().written.is_empty(),
                    "the refusal frame is written back"
                );
            }
        });
        let log = String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default())
            .unwrap_or_default();
        // Count only the outcome lines: the `warn!` above also names the id.
        let outcomes = |command_id: &str| {
            log.lines()
                .filter(|line| line.contains("command operation") && line.contains(command_id))
                .count()
        };
        assert_eq!(outcomes("cmd-exec-9f3a"), 1, "{log}");
        assert!(log.contains("rejected:bad_command"), "{log}");
        assert!(
            !log.contains("x\\u0000y") && !log.contains("x\u{0}"),
            "the command text leaked: {log}"
        );
    }

    #[test]
    fn a_refused_stt_frame_ends_only_its_session_and_never_the_relay() {
        let session = "AAECAwQFBgcICQoLDA0ODw";
        let (tx, _rx) = mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
        let mut stt = crate::services::stt::SttRegistry::new(tx);
        let mut socket = sink_socket();
        // A transcript over the wire limit: the encoder refuses it, the
        // session gets one stt.error, and the relay goes on.
        let oversized = NodeFrame::SttEvent {
            session_id: session.to_string(),
            event: crate::wire::protocol::frames::SttEvent::Delta {
                item_seq: 0,
                text: "secret ".repeat(4_000),
            },
        };
        assert!(send_stt(&mut socket, &mut stt, oversized).is_ok());
        let written = String::from_utf8_lossy(&socket.get_ref().written).to_string();
        assert!(written.contains("stt.error") && written.contains("protocol_error"));
        assert!(
            !written.contains("secret"),
            "the refused text never goes out"
        );

        // A malformed open that names its session is refused by name, not fatally.
        let mut socket = sink_socket();
        let other = "AQIDBAUGBwgJCgsMDQ4PEA";
        let malformed = format!(r#"{{"type":"stt.open","sessionId":"{other}"}}"#);
        let fault = crate::wire::protocol::control_frame_fault(&malformed);
        let outcome = apply_stt_fault(&mut socket, &mut stt, &fault).expect("an stt fault");
        assert!(outcome.is_ok());
        let written = String::from_utf8_lossy(&socket.get_ref().written).to_string();
        assert!(written.contains("stt.error") && written.contains(other));
        // A malformed frame for a session that is not live sends nothing.
        let mut socket = sink_socket();
        let commit = format!(r#"{{"type":"stt.commit","sessionId":"{session}","itemSeq":-1}}"#);
        let fault = crate::wire::protocol::control_frame_fault(&commit);
        assert!(apply_stt_fault(&mut socket, &mut stt, &fault).is_some_and(|r| r.is_ok()));
        assert!(socket.get_ref().written.is_empty());
    }

    /// A secret write that changed the set is followed by a `node.state`, so
    /// the server lists the new name at once; a refusal or no-op is not.
    #[test]
    fn a_changed_secret_set_reports_the_node_state() {
        // Stands in for the real `node.state` (built from the startup).
        let state = || NodeFrame::RelayCancelled {
            request_id: "state".into(),
        };
        let kinds = |frames: Vec<NodeFrame>| {
            frames
                .iter()
                .map(|frame| match frame {
                    NodeFrame::SecretResult { .. } => "secret.result",
                    NodeFrame::RelayCancelled { .. } => "node.state",
                    _ => "other",
                })
                .collect::<Vec<_>>()
        };
        let set = Ok(crate::node::secrets::Outcome::Set {
            updated_at: "2026-10-07T00:00:00Z".to_string(),
        });
        assert_eq!(
            kinds(secret_answer(
                "1".into(),
                "WSMP_SECRET_A".into(),
                set,
                state
            )),
            ["secret.result", "node.state"]
        );
        let deleted = Ok(crate::node::secrets::Outcome::Deleted);
        assert_eq!(
            kinds(secret_answer(
                "2".into(),
                "WSMP_SECRET_A".into(),
                deleted,
                state
            )),
            ["secret.result", "node.state"]
        );
        let missing = Ok(crate::node::secrets::Outcome::NotFound);
        assert_eq!(
            kinds(secret_answer(
                "3".into(),
                "WSMP_SECRET_A".into(),
                missing,
                state
            )),
            ["secret.result"]
        );
        let refused = Err(SecretRefusal::TrustRelay);
        assert_eq!(
            kinds(secret_answer(
                "4".into(),
                "WSMP_SECRET_A".into(),
                refused,
                state
            )),
            ["secret.result"]
        );
    }
}
