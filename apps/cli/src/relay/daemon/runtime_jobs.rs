//! `runtime.job` steps: rendered and admitted to the runner, refused before
//! admission, and the runner's results and observations.

use anyhow::Result;

use crate::relay::startup::TerminalStartup;
use crate::services::runtimes::executor::Job;
use crate::wire::protocol::NodeFrame;
use crate::wire::protocol::frames::{JobError, JobPhase, JobStatus, TrustValue};

use super::session::{FrameClass, Session, emit, emit_control, send_inventory};
use super::wire::{RelaySessionResult, send_control, send_outbound_frames, send_stt_frames};

/// `runtime.job`: render from the held/frozen definition and run it off this
/// loop, or refuse before admission. A stop or check of an instance whose
/// version the server since dropped runs from the instance's own record.
///
/// An interactive step (`job.operator`) runs in its operator terminal
/// (`crate::services::runtimes::operator`); every answer to it names that terminal. A
/// re-delivery of a terminal already open re-reports its state. A stop for a
/// rank closes that rank's operator terminals still on their confirm screen
/// (a person's run in progress is never cut off: the stop waits for it).
pub(super) fn handle_runtime_job<S>(
    socket: &mut tungstenite::WebSocket<S>,
    startup: &TerminalStartup,
    session: &mut Session,
    job: crate::wire::protocol::frames::RuntimeJob,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let terminal_id = job
        .operator()
        .map(|(terminal_id, _)| terminal_id.to_owned());
    let refusal = |error: JobError, detail: Option<String>| NodeFrame::RuntimeJobResult {
        step_id: job.step_id.clone(),
        instance_id: job.instance_id.clone(),
        rank: job.rank,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        status: JobStatus::Failed,
        stopped: false,
        error: Some(error),
        detail,
        terminal_id: terminal_id.clone(),
        exit_code: None,
        rank_idle: None,
    };
    // About to restart into a new build: nothing new starts (the server sends
    // a start refused this way again, without counting an attempt).
    if session.update.holds_new_work()
        && matches!(
            job.phase,
            JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
        )
    {
        return send_control(
            socket,
            &refusal(
                JobError::SessionDisconnected,
                Some("wsmp is restarting into an update".into()),
            ),
            "refusing a runtime step during an update",
        );
    }
    if let Some((terminal_id, _)) = job.operator() {
        use crate::relay::sessions::OperatorDelivery;
        match session
            .terminals
            .operator_delivery(&job.step_id, terminal_id)
        {
            OperatorDelivery::New => {}
            // Already open (re-report it), still pending or already ended:
            // never a second run under one terminal id.
            OperatorDelivery::Repeat(status) => {
                let Some(status) = status else {
                    return Ok(());
                };
                let ids = operator_ids(&job, terminal_id);
                return send_control(socket, &ids.result(status, None), "re-reporting a step");
            }
            OperatorDelivery::Clash => {
                return send_control(
                    socket,
                    &refusal(JobError::BadJob, Some("operator".into())),
                    "refusing an operator step",
                );
            }
        }
    }
    let facts = crate::services::runtimes::render::NodeFacts::current();
    let trust = startup.trust_value();
    let missing = if trust == TrustValue::Full {
        JobError::DefinitionMissing
    } else {
        JobError::DefinitionFrozen
    };
    let refused_with = |error: JobError, detail: &str| crate::services::runtimes::render::Refusal {
        error,
        detail: Some(detail.to_string()),
    };
    let rendered = if let Err(refused) = crate::services::runtimes::render::check_ids(&job) {
        Err(refused)
    } else if matches!(
        job.phase,
        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
    ) {
        session.runtimes.render(&job, trust, &facts)
    } else {
        // Checks and stops run the commands the rank was launched with (its
        // own record), never re-rendered. Checks still need the version held;
        // a stop also works after the server dropped it.
        let held = session
            .runtimes
            .holds(&job.launch_version_id, &job.launch_hash);
        let recorded = crate::services::runtimes::runner::recorded_job(&job.instance_id, job.rank)
            .filter(|known| {
                known.version_id == job.launch_version_id
                    && known.launch_hash == job.launch_hash
                    && known.unit_name == job.unit_name
                    && known.handle == job.handle
                    && known.runtime_id == job.runtime_id
            });
        // A stop, and a status probe proving one, also work after the server dropped it.
        if !held && job.phase != JobPhase::Stop && job.phase != JobPhase::Status {
            Err(refused_with(missing, "launchVersionId"))
        } else if let Some(known) = recorded {
            from_record(&job, known)
        } else if held {
            // No record: the executor answers `instance_unknown`.
            session.runtimes.render(&job, trust, &facts)
        } else {
            Err(refused_with(missing, "launchVersionId"))
        }
    };
    let rendered = match rendered {
        Ok(rendered) => rendered,
        Err(refused) => {
            tracing::warn!(
                step_id = job.step_id,
                error = ?refused.error,
                detail = refused.detail.as_deref().unwrap_or(""),
                "refused a runtime job before admission"
            );
            return send_control(
                socket,
                &refusal(refused.error, refused.detail),
                "refusing a runtime job",
            );
        }
    };
    // Only an admitted stop closes the rank's confirm screens (a person's
    // run in progress is never cut off: the stop waits for it).
    if job.phase == JobPhase::Stop {
        let closed = session
            .terminals
            .close_confirming_for_rank(&job.instance_id, job.rank);
        send_outbound_frames(socket, closed)?;
    }
    {
        let ticket = match job.operator() {
            None => None,
            Some((terminal_id, author)) => {
                // Taken now, before the runner thread exists: a re-delivery
                // or a newer dispatch of the step sees it (see `reserve_operator`).
                match session
                    .terminals
                    .reserve_operator(&job.step_id, terminal_id)
                {
                    Ok(closed) => send_outbound_frames(socket, closed)?,
                    Err(error) => {
                        return send_control(
                            socket,
                            &refusal(error, None),
                            "refusing an operator step",
                        );
                    }
                }
                Some(operator_ticket(&job, terminal_id, author, &rendered))
            }
        };
        // Live speech-to-text sessions on the instance end before its stop
        // runs, and none opens there meanwhile.
        let ended = stt_step_submitting(&mut session.stt, &job);
        send_stt_frames(socket, &mut session.stt, ended)?;
        let submitted = match (session.runner.as_ref(), ticket) {
            (Some(runner), Some(ticket)) => runner.submit_operator(rendered, ticket),
            (Some(runner), None) => runner.submit(rendered),
            (None, _) => Err(anyhow::anyhow!("runtime steps are unavailable")),
        };
        stt_step_submitted(&mut session.stt, &job, submitted.is_ok());
        if let Err(error) = submitted {
            if let Some(terminal_id) = &terminal_id {
                session.terminals.release_operator(terminal_id);
            }
            tracing::warn!(error = %format!("{error:#}"), "could not run a runtime job");
            return send_control(
                socket,
                &refusal(JobError::SessionDisconnected, None),
                "refusing a runtime job",
            );
        }
        Ok(())
    }
}

/// What a runtime step about to be submitted does to live speech-to-text:
/// a stop ends the sessions on its instance's endpoint (its handle) and
/// marks the endpoint, so none opens there until the stop is settled
/// ([`crate::services::stt::SttRegistry::endpoint_stopping`]). Every rank's stop marks
/// the handle; only the node running rank 0 serves it, and the endpoint
/// check drops a mark on an endpoint this node does not serve.
fn stt_step_submitting(
    stt: &mut crate::services::stt::SttRegistry,
    job: &crate::wire::protocol::frames::RuntimeJob,
) -> Vec<NodeFrame> {
    if job.phase == JobPhase::Stop {
        stt.endpoint_stopping(&job.handle, &job.step_id)
    } else {
        Vec::new()
    }
}

/// After the runner took (`admitted`) or refused a runtime step: a refused
/// stop leaves its endpoint serving; an admitted start lifts the stop mark,
/// at once if the stop is done, else when it finishes.
fn stt_step_submitted(
    stt: &mut crate::services::stt::SttRegistry,
    job: &crate::wire::protocol::frames::RuntimeJob,
    admitted: bool,
) {
    match job.phase {
        JobPhase::Stop if !admitted => stt.stop_failed(&job.step_id),
        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin if admitted => {
            stt.endpoint_starting(&job.handle);
        }
        _ => {}
    }
}

/// A runtime step its runner thread is done with: a stop that succeeded
/// may let a waiting start take sessions again; one that failed (or whose
/// operator terminal closed without success) leaves its endpoint serving.
/// Any other step's id names no mark.
fn stt_step_ended(
    stt: &mut crate::services::stt::SttRegistry,
    ended: &crate::services::runtimes::runner::StepEnded,
) {
    if ended.succeeded {
        stt.stop_finished(&ended.step_id);
    } else {
        stt.stop_failed(&ended.step_id);
    }
}

/// A check or stop from the rank's own record (never re-rendered). An
/// interactive stop runs only in its operator terminal, and only an
/// interactive stop gets one.
fn from_record(
    job: &crate::wire::protocol::frames::RuntimeJob,
    known: Job,
) -> Result<Job, crate::services::runtimes::render::Refusal> {
    let interactive = known.parsed_spec().is_some_and(|spec| {
        crate::services::runtimes::render::interactive_phase(&spec, job.rank, job.phase)
    });
    if interactive != job.operator().is_some() {
        return Err(crate::services::runtimes::render::Refusal {
            error: JobError::BadJob,
            detail: Some("operator".into()),
        });
    }
    // The job's reservations, else those of the launch it checks or stops.
    let reservations = job.reservations_or(&known.reservations);
    Ok(Job {
        step_id: job.step_id.clone(),
        action: job.phase,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        timeout_ms: job.timeout_ms.clamp(1, 3_600_000),
        command: String::new(),
        reservations,
        ..known
    })
}

/// The operator ticket of an admitted interactive job. The screen shows
/// what the node itself rendered (or recorded), never server-supplied text.
fn operator_ticket(
    job: &crate::wire::protocol::frames::RuntimeJob,
    terminal_id: &str,
    author: crate::wire::protocol::frames::CommandAuthor,
    rendered: &Job,
) -> crate::services::runtimes::runner::OperatorTicket {
    let command = rendered.operator_cmd().script.to_string();
    crate::services::runtimes::runner::OperatorTicket {
        ids: operator_ids(job, terminal_id),
        screen: crate::services::runtimes::operator::OperatorScreen {
            node: crate::services::runtimes::operator::node_name(),
            handle: rendered.handle.clone(),
            phase: rendered.action,
            rank: rendered.rank,
            command,
            author,
        },
        base_env: crate::relay::sessions::operator_base_env(),
    }
}

/// Who an operator step's answers name.
fn operator_ids(
    job: &crate::wire::protocol::frames::RuntimeJob,
    terminal_id: &str,
) -> crate::services::runtimes::operator::OperatorIds {
    crate::services::runtimes::operator::OperatorIds {
        step_id: job.step_id.clone(),
        instance_id: job.instance_id.clone(),
        rank: job.rank,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        terminal_id: terminal_id.to_string(),
    }
}

/// Step results and instance observations from the runner.
///
/// Operator terminal frames and step results are this connection's own
/// ([`FrameClass::SessionScoped`]): one that lands between the hello and
/// `hello.ok` is held until `hello.ok` (it used to be dropped there, which
/// lost a step result the server was waiting for).
pub(super) fn drain_runner<S>(
    socket: &mut tungstenite::WebSocket<S>,
    session: &mut Session,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    use crate::services::runtimes::runner::{OperatorRequest, Update};
    while let Some(update) = session
        .runner
        .as_ref()
        .and_then(|runner| runner.try_update())
    {
        match update {
            Update::Operator(request) => {
                let frames = match request {
                    OperatorRequest::Open(open) => session.terminals.open_operator(*open),
                    OperatorRequest::CloseIfConfirming { terminal_id } => {
                        session.terminals.close_operator_if_confirming(&terminal_id)
                    }
                };
                emit(socket, session, FrameClass::SessionScoped, frames)?;
            }
            Update::Observation {
                generation,
                result,
                ended,
                instances,
            } => {
                if generation > session.observed_generation {
                    session.observed_generation = generation;
                    session.runtimes.set_instances(instances);
                }
                if let Some(ended) = &ended {
                    stt_step_ended(&mut session.stt, ended);
                }
                // An operator step's runner thread is done with its terminal id.
                if let Some(NodeFrame::RuntimeJobResult {
                    terminal_id: Some(terminal_id),
                    ..
                }) = &result
                {
                    session.terminals.release_operator(terminal_id);
                }
                if let Some(result) = result {
                    emit_control(socket, session, FrameClass::SessionScoped, result)?;
                }
                // `hello.ok` sends one anyway.
                if session.phase.is_registered() {
                    send_inventory(session);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn stop_job(operator: bool) -> crate::wire::protocol::frames::RuntimeJob {
        crate::wire::protocol::frames::RuntimeJob {
            step_id: "step1".into(),
            instance_id: "in1".into(),
            runtime_id: "rt1".into(),
            launch_version_id: "vr1".into(),
            launch_hash: "h".repeat(64),
            generation: 1,
            rank: 0,
            nnodes: 1,
            phase: JobPhase::Stop,
            handle: "i-abcdefabcdef".into(),
            unit_name: "wsmp-i-abcdefabcdef-r0".into(),
            placeholders: crate::wire::protocol::frames::JobPlaceholders {
                port: 30001,
                dist_port: None,
                head_addr: None,
                gpu_ids: None,
                memory_gb: None,
                vram_gb: None,
                memory_fraction: None,
            },
            fabric_id: None,
            timeout_ms: 60_000,
            owner_epoch: "epoch:1".into(),
            intent_hash: "b".repeat(64),
            operator: operator.then(|| crate::wire::protocol::frames::JobOperator {
                terminal_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
                command_author: crate::wire::protocol::frames::CommandAuthor::User,
            }),
            reservations: Vec::new(),
        }
    }

    /// The instance `stop_job` names, served as a live STT endpoint, and another.
    fn stt_endpoints() -> Vec<crate::node::config::EndpointConfig> {
        use crate::services::stt::tests::{endpoint, segmented};
        vec![
            endpoint(
                "i-abcdefabcdef",
                "http://127.0.0.1:9",
                segmented(None, None),
            ),
            endpoint(
                "i-000000000000",
                "http://127.0.0.1:9",
                segmented(None, None),
            ),
        ]
    }

    fn opens(
        stt: &mut crate::services::stt::SttRegistry,
        managed: &[crate::node::config::EndpointConfig],
        n: u8,
        slug: &str,
    ) -> bool {
        use crate::services::stt::tests::{open, session_id};
        stt.handle(open(&session_id(n), slug), managed, Instant::now())
            .is_empty()
    }

    fn job_in(phase: JobPhase, step_id: &str) -> crate::wire::protocol::frames::RuntimeJob {
        crate::wire::protocol::frames::RuntimeJob {
            step_id: step_id.into(),
            phase,
            ..stop_job(false)
        }
    }

    fn ended(step_id: &str, succeeded: bool) -> crate::services::runtimes::runner::StepEnded {
        crate::services::runtimes::runner::StepEnded {
            step_id: step_id.into(),
            succeeded,
        }
    }

    #[test]
    fn a_stop_job_ends_the_stt_sessions_on_its_instance_before_it_runs() {
        use crate::services::stt::tests::{is_error, registry, session_id};
        let (mut stt, _rx) = registry();
        let managed = stt_endpoints();
        assert!(opens(&mut stt, &managed, 1, "i-abcdefabcdef"));
        assert!(opens(&mut stt, &managed, 2, "i-000000000000"));
        let stop = stop_job(false);
        let frames = stt_step_submitting(&mut stt, &stop);
        assert_eq!(frames.len(), 1);
        assert!(is_error(
            &frames[0],
            crate::wire::protocol::RelayFailure::NotFound
        ));
        assert!(!stt.is_live(&session_id(1)));
        assert!(stt.is_live(&session_id(2)), "another instance's session");
        stt_step_submitted(&mut stt, &stop, true);
        assert!(
            !opens(&mut stt, &managed, 3, "i-abcdefabcdef"),
            "no session opens while the stop runs"
        );
        // Other steps change nothing: no sessions end, no mark.
        for phase in [JobPhase::Status, JobPhase::Health, JobPhase::Readiness] {
            assert!(stt_step_submitting(&mut stt, &job_in(phase, "probe")).is_empty());
        }
        assert!(stt.is_live(&session_id(2)));
        stt.abort_all();
    }

    #[test]
    fn a_refused_or_failed_stop_lifts_its_stt_mark() {
        let (mut stt, _rx) = crate::services::stt::tests::registry();
        let managed = stt_endpoints();
        // The runner refuses the stop: its endpoint still serves.
        let stop = stop_job(false);
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, false);
        assert!(opens(&mut stt, &managed, 1, "i-abcdefabcdef"));
        // The stop runs and fails (or its operator terminal closes).
        let stop = job_in(JobPhase::Stop, "step2");
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        stt_step_ended(&mut stt, &ended("other", false));
        assert!(!opens(&mut stt, &managed, 2, "i-abcdefabcdef"));
        stt_step_ended(&mut stt, &ended("step2", false));
        assert!(opens(&mut stt, &managed, 3, "i-abcdefabcdef"));
        stt.abort_all();
    }

    #[test]
    fn a_start_after_a_stop_takes_stt_sessions_once_the_stop_is_done() {
        let (mut stt, _rx) = crate::services::stt::tests::registry();
        let managed = stt_endpoints();
        // A start admitted while the stop runs waits for it.
        let stop = stop_job(false);
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        let start = job_in(JobPhase::Start, "start1");
        stt_step_submitting(&mut stt, &start);
        stt_step_submitted(&mut stt, &start, true);
        assert!(!opens(&mut stt, &managed, 1, "i-abcdefabcdef"));
        // A re-delivery of the stop keeps the start waiting.
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        // The start's own result names no mark.
        stt_step_ended(&mut stt, &ended("start1", true));
        assert!(!opens(&mut stt, &managed, 2, "i-abcdefabcdef"));
        stt_step_ended(&mut stt, &ended("step1", true));
        assert!(opens(&mut stt, &managed, 3, "i-abcdefabcdef"));

        // A stop that finished first: a refused start keeps the mark, an
        // admitted prepare lifts it.
        let stop = job_in(JobPhase::Stop, "step2");
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        stt_step_ended(&mut stt, &ended("step2", true));
        assert!(!opens(&mut stt, &managed, 4, "i-abcdefabcdef"));
        let prepare = job_in(JobPhase::Prepare, "prep1");
        stt_step_submitted(&mut stt, &prepare, false);
        assert!(!opens(&mut stt, &managed, 5, "i-abcdefabcdef"));
        stt_step_submitted(&mut stt, &prepare, true);
        assert!(opens(&mut stt, &managed, 6, "i-abcdefabcdef"));
        stt.abort_all();
    }

    fn recorded(interactive_stop: bool) -> Job {
        let mut commands = serde_json::json!({
            "start": "sudo systemctl start x", "stop": "sudo systemctl stop x",
            "status": "systemctl is-active x"
        });
        if interactive_stop {
            commands["interactive"] = serde_json::json!({ "stop": true });
        }
        Job {
            step_id: "start-step".into(),
            instance_id: "in1".into(),
            runtime_id: "rt1".into(),
            version_id: "vr1".into(),
            launch_hash: "h".repeat(64),
            rank: 0,
            action: JobPhase::Start,
            intent_hash: "a".repeat(64),
            owner_epoch: "epoch:0".into(),
            command: "sudo systemctl start x".into(),
            stop_command: "sudo systemctl stop x".into(),
            status_command: Some("systemctl is-active x".into()),
            health_command: None,
            command_argv: None,
            stop_argv: None,
            status_argv: None,
            health_argv: None,
            shell: crate::wire::protocol::runtime_spec::CommandShell::Sh,
            secrets: Vec::new(),
            timeout_ms: 60_000,
            unit_name: "wsmp-i-abcdefabcdef-r0".into(),
            handle: "i-abcdefabcdef".into(),
            port: 30001,
            gpu_ids: None,
            dist_port: None,
            host: "127.0.0.1".into(),
            reservations: Vec::new(),
            spec: serde_json::json!({
                "api": "openai", "engine": "vllm", "modelType": "llm",
                "launch": {
                    "management": "service", "groupSize": 1,
                    "resources": [{ "kind": "none" }], "labels": [],
                    "commands": [commands],
                    "health": { "intervalMs": 30000, "failureThreshold": 2, "successThreshold": 1 }
                }
            }),
        }
    }

    #[test]
    fn a_recorded_stop_runs_in_an_operator_terminal_exactly_when_it_is_interactive() {
        for (interactive, operator) in [(true, false), (false, true)] {
            let refused = from_record(&stop_job(operator), recorded(interactive))
                .expect_err("operator mismatch");
            assert_eq!(refused.error, JobError::BadJob);
            assert_eq!(refused.detail.as_deref(), Some("operator"));
        }
        for interactive in [true, false] {
            let job = from_record(&stop_job(interactive), recorded(interactive)).expect("admitted");
            assert_eq!(job.action, JobPhase::Stop);
            assert_eq!(job.step_id, "step1");
            assert_eq!(job.stop_command, "sudo systemctl stop x");
        }
    }

    #[test]
    fn a_recorded_stop_uses_the_jobs_reservations_else_the_launch_reservations() {
        let reservation = |index: u8, node: &str| crate::wire::protocol::frames::JobReservation {
            index,
            node_id: format!("wk{index}"),
            node: node.into(),
            gpu_ids: None,
        };
        let mut launched = recorded(false);
        launched.reservations = vec![reservation(0, "worker-a")];
        // A stop that names none sees the worker the launch was started with.
        let job = from_record(&stop_job(false), launched.clone()).expect("admitted");
        assert_eq!(job.reservations, vec![reservation(0, "worker-a")]);
        // A stop that names its own uses them.
        let mut naming = stop_job(false);
        naming.reservations = vec![reservation(1, "worker-b")];
        let job = from_record(&naming, launched).expect("admitted");
        assert_eq!(job.reservations, vec![reservation(1, "worker-b")]);
    }

    #[test]
    fn the_operator_screen_shows_what_the_node_rendered_not_the_server_handle() {
        let mut job = stop_job(true);
        job.handle = "i-zzzzzzzzzzzz".into();
        let rendered = recorded(true);
        let Some((terminal_id, author)) = job.operator() else {
            panic!("operator job");
        };
        let ticket = operator_ticket(&job, terminal_id, author, &rendered);
        assert_eq!(ticket.screen.handle, "i-abcdefabcdef");
        assert_eq!(ticket.screen.command, "sudo systemctl start x");
        assert_eq!(ticket.ids.terminal_id, "AAAAAAAAAAAAAAAAAAAAAA");
    }
}
