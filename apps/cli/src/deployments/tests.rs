use super::*;
use std::cell::{Cell, RefCell};

#[test]
fn current_inventory_wire_matches_shared_golden() {
    let observed = Observed {
        step_id: "step-fixture".into(),
        instance_id: "fixture".into(),
        revision_id: "revision".into(),
        rank: 0,
        intent_hash: "a".repeat(64),
        phase: "ready".into(),
        unit_name: "wsmp-i-fixture-r0".into(),
        port: 30001,
        endpoint_slug: "inst-fixture-1".into(),
        models: vec!["fixture".into()],
        context_window: Some(4096),
    };
    let normalize = |snapshot: EncodedSnapshot| {
        snapshot
            .frames
            .iter()
            .map(|frame| {
                let mut value: serde_json::Value = serde_json::from_str(frame).expect("frame JSON");
                assert_eq!(value["snapshotId"], snapshot.id);
                value["snapshotId"] = "A".repeat(32).into();
                value
            })
            .collect::<Vec<_>>()
    };
    let actual = serde_json::json!({
        "protocolVersion": crate::protocol::RELAY_PROTOCOL_VERSION,
        "empty": normalize(encode_instances(&[]).expect("empty")),
        "nonempty": normalize(encode_instances(&[observed]).expect("nonempty")),
    });
    let expected: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/relay-current/deployment-inventory.json"
    ))
    .expect("golden JSON");
    assert_eq!(actual, expected);
}

fn job(action: Action) -> Job {
    Job {
        frame_type: "deployment.job".into(),
        step_id: format!("step-{action:?}"),
        instance_id: "fixture".into(),
        revision_id: "revision".into(),
        rank: 0,
        action,
        intent_hash: "a".repeat(64),
        owner_epoch: "epoch".into(),
        actor: Actor::User,
        human_approved: true,
        attachment: "llm".into(),
        engine: Engine::Other,
        management: Management::OwnedProcess,
        embedding_contract: None,
        transcription_profile: None,
        command: "sleep 30".into(),
        interactive: None,
        stop_interactive: None,
        operator: None,
        stop_command: Some("true".into()),
        status_command: None,
        health_command: None,
        timeout_ms: 1000,
        unit_name: "wsmp-i-fixture-r0".into(),
        port: 30001,
        endpoint_slug: "inst-fixture-1".into(),
        models: vec!["fixture".into()],
        context_window: Some(4096),
        readiness: Readiness {
            path: "/health".into(),
            expected_status: 200,
            timeout_ms: None,
        },
        health: Health {
            interval_ms: 30_000,
            failure_threshold: 3,
            success_threshold: 1,
        },
    }
}

struct Fake {
    units: RefCell<BTreeMap<String, String>>,
    launches: Cell<u32>,
    intent_path: PathBuf,
    stop_fails: Cell<bool>,
    ready: Cell<bool>,
}
impl Runtime for Fake {
    fn launch(&self, _: &Job, _: &str, unit: &str, _: Deadline) -> Result<String> {
        let state: State = serde_json::from_slice(&std::fs::read(&self.intent_path)?)?;
        anyhow::ensure!(
            state
                .records
                .values()
                .any(|record| record.pending.is_some()),
            "launch before durable intent"
        );
        self.launches.set(self.launches.get() + 1);
        self.units
            .borrow_mut()
            .insert(unit.into(), "invocation".into());
        Ok("invocation".into())
    }
    fn identity(&self, unit: &str, _: &str, _: Deadline) -> Result<Option<String>> {
        Ok(self.units.borrow().get(unit).cloned())
    }
    fn shell(&self, _: &str, _: Duration) -> Result<()> {
        Ok(())
    }
    fn status(&self, _: &str, _: Duration) -> Result<bool> {
        anyhow::bail!("unknown")
    }
    fn stop(&self, unit: &str, _: &str, invocation: &str, _: Deadline) -> Result<()> {
        anyhow::ensure!(!self.stop_fails.get(), "cannot stop");
        anyhow::ensure!(
            self.units
                .borrow()
                .get(unit)
                .is_none_or(|current| current == invocation),
            "foreign successor"
        );
        self.units.borrow_mut().remove(unit);
        Ok(())
    }
    fn healthy(&self, _: &Job, _: Duration) -> bool {
        self.ready.get()
    }
}

#[test]
fn durable_intent_dedup_reload_fences_and_failed_stop() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.clone(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    };
    let mut executor = Executor::load(path.clone()).expect("load");
    let start = job(Action::Start);
    assert_eq!(
        executor
            .execute(start.clone(), true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded"
    );
    assert_eq!(runtime.launches.get(), 1);
    let mut executor = Executor::load(path).expect("restart");
    let mut retry = start.clone();
    retry.owner_epoch = "new-epoch".into();
    let reply = executor.execute(retry, true, McpCommandMode::Off, &runtime);
    assert_eq!(reply.owner_epoch, "new-epoch");
    assert_eq!(runtime.launches.get(), 1);
    assert_eq!(
        executor
            .execute(job(Action::Readiness), true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded"
    );
    assert_eq!(executor.published_jobs(&runtime).len(), 1);
    runtime.stop_fails.set(true);
    let stopped = executor.execute(job(Action::Stop), true, McpCommandMode::Off, &runtime);
    assert!(!stopped.stopped);
    assert_eq!(stopped.status, "failed");
    assert!(executor.published_jobs(&runtime).is_empty());
    assert!(!runtime.units.borrow().is_empty());
    runtime.stop_fails.set(false);
    assert!(
        executor
            .execute(job(Action::Stop), true, McpCommandMode::Off, &runtime)
            .stopped
    );
    assert_eq!(executor.observations(&runtime)[0].phase, "stopped");
    assert_eq!(
        executor.observations(&runtime)[0].step_id,
        job(Action::Stop).step_id
    );
}

#[test]
fn local_policy_rechecked_even_for_cached_step() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.clone(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    };
    let mut executor = Executor::load(path).expect("load");
    let mut start = job(Action::Start);
    start.actor = Actor::Agent;
    start.human_approved = true;
    assert_eq!(
        executor
            .execute(start.clone(), true, McpCommandMode::Off, &runtime)
            .error
            .as_deref(),
        Some("command_mode_denied")
    );
    assert_eq!(runtime.launches.get(), 0);
    assert_eq!(
        executor
            .execute(start.clone(), true, McpCommandMode::Supervised, &runtime)
            .status,
        "succeeded"
    );
    assert_eq!(
        executor
            .execute(start.clone(), false, McpCommandMode::Unsupervised, &runtime)
            .error
            .as_deref(),
        Some("feature_disabled")
    );
    assert_eq!(
        executor
            .execute(start, true, McpCommandMode::Off, &runtime)
            .error
            .as_deref(),
        Some("command_mode_denied")
    );
    assert_eq!(runtime.launches.get(), 1);
}

#[cfg(unix)]
#[test]
fn actual_status_command_distinguishes_absence_unknown_and_timeout() {
    let runtime = NativeRuntime { cancel: None };
    assert!(
        runtime
            .status("exit 0", Duration::from_secs(1))
            .expect("alive")
    );
    assert!(
        !runtime
            .status("exit 3", Duration::from_secs(1))
            .expect("stopped")
    );
    assert!(runtime.status("exit 1", Duration::from_secs(1)).is_err());
    assert!(
        runtime
            .status("sleep 2", Duration::from_millis(30))
            .is_err()
    );
    runtime
        .shell(
            "printf 'private model content'; printf 'private prompt' >&2",
            Duration::from_secs(1),
        )
        .expect("null output");
}

#[cfg(unix)]
#[test]
fn actual_localhost_readiness_rejects_redirect_and_timeout() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    for (status, pause, expected) in [(200, 0, true), (302, 0, false), (200, 250, false)] {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local fixture");
        let mut readiness = job(Action::Readiness);
        readiness.port = listener.local_addr().expect("address").port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("timeout");
            let mut request = [0; 2048];
            let size = socket.read(&mut request).expect("request");
            assert!(String::from_utf8_lossy(&request[..size]).starts_with("GET /health "));
            std::thread::sleep(Duration::from_millis(pause));
            let _ = write!(
                socket,
                "HTTP/1.1 {status} fixture\r\nContent-Length: 0\r\nLocation: http://127.0.0.1:1/\r\nConnection: close\r\n\r\n"
            );
        });
        let runtime = NativeRuntime { cancel: None };
        assert_eq!(
            runtime.healthy(&readiness, Duration::from_millis(100)),
            expected
        );
        server.join().expect("server");
    }
}

#[cfg(unix)]
#[test]
fn actual_disconnect_cancels_command_before_followup_effect() {
    let root = tempfile::tempdir().expect("root");
    let effect = root.path().join("effect");
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker_cancel = cancel.clone();
    let setter = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        worker_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let runtime = NativeRuntime {
        cancel: Some(cancel),
    };
    assert!(
        runtime
            .shell(
                &format!("sleep 1; touch '{}'", effect.display()),
                Duration::from_secs(2)
            )
            .is_err()
    );
    setter.join().expect("cancel setter");
    std::thread::sleep(Duration::from_millis(1100));
    assert!(!effect.exists(), "disconnected helper continued its effect");
}

#[test]
fn unknown_stop_and_reserved_manual_namespace_are_refused() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.clone(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    };
    let mut executor = Executor::load(path).expect("load");
    assert!(
        !executor
            .execute(job(Action::Stop), true, McpCommandMode::Off, &runtime)
            .stopped
    );
    let config = crate::config::Config {
        endpoints: vec![endpoint_for(&job(Action::Start))],
        ..Default::default()
    };
    assert!(config.validate().is_err());
}

#[test]
fn embedding_contract_and_engine_declaration_do_not_invent_native_count() {
    let mut embedding = job(Action::Start);
    embedding.attachment = "embeddings".into();
    embedding.engine = Engine::Vllm;
    embedding.embedding_contract = Some(EmbeddingContract {
        model: "fixture".into(),
        revision: "revision-1".into(),
        dimensions: 1536,
        normalization: "l2".into(),
        vector_space: "fixture-vectors".into(),
    });
    assert!(embedding.validate().is_ok());
    let endpoint = endpoint_for(&embedding);
    assert!(endpoint.default_capabilities.chat_completions.is_none());
    let inventory =
        crate::protocol::endpoint_inventory(&endpoint, crate::protocol::EndpointStatus::Online);
    let serialized = serde_json::to_value(inventory).expect("inventory");
    assert_eq!(
        serialized["defaultCapabilities"]["embeddings"]["contract"]["vectorSpace"],
        "fixture-vectors"
    );
    assert!(serialized["engineFacts"].get("countContext").is_none());
    for mechanism in ["systemd-no-linger", "unsupported"] {
        assert!(!activation_supported(Action::Start, mechanism));
        assert!(activation_supported(Action::Stop, mechanism));
    }
}

#[test]
fn transcription_recipe_advertises_its_profile_as_the_server_golden() {
    let mut transcription = job(Action::Start);
    transcription.attachment = "transcription".into();
    transcription.transcription_profile = Some(TranscriptionProfile {
        response_formats: Some(vec!["json".into(), "verbose_json".into(), "text".into()]),
        timestamp_granularities: Some(vec!["word".into()]),
        languages: Some(vec!["en".into(), "es".into()]),
        language_detection: Some(true),
        max_upload_bytes: Some(26_214_400),
        accepted_mime_types: Some(vec!["audio/wav".into(), "audio/mpeg".into()]),
        ..Default::default()
    });
    assert!(transcription.validate().is_ok());
    let endpoint = endpoint_for(&transcription);
    assert!(endpoint.default_capabilities.chat_completions.is_none());
    assert!(endpoint.default_capabilities.embeddings.is_none());
    let inventory =
        crate::protocol::endpoint_inventory(&endpoint, crate::protocol::EndpointStatus::Online);
    let actual = serde_json::to_value(inventory).expect("inventory");
    // The server parses this exact payload (apps/server/src/deployments/inventory-wire.test.ts).
    let golden = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/relay-current/transcription-endpoint.json"
    );
    if std::env::var_os("WSMP_UPDATE_GOLDEN").is_some() {
        std::fs::write(
            golden,
            serde_json::to_string_pretty(&actual).expect("json") + "\n",
        )
        .expect("write golden");
    }
    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(golden).expect("golden")).expect("json");
    assert_eq!(actual, expected);
    let capabilities = &actual["defaultCapabilities"];
    // Version 2 is the first that carries a detailed transcription profile.
    assert_eq!(capabilities["version"], 2);
    assert_eq!(capabilities["audio"]["transcriptions"]["streaming"], true);

    let mut misplaced = job(Action::Start);
    misplaced.transcription_profile = Some(TranscriptionProfile::default());
    assert!(
        misplaced.validate().is_err(),
        "a profile needs a transcription attachment"
    );
    let mut unknown = job(Action::Start);
    unknown.attachment = "speech".into();
    assert!(unknown.validate().is_err());
}

#[test]
fn a_maximal_transcription_endpoint_fits_one_control_frame() {
    let token = |i: usize| format!("{i:0>64}");
    let mut transcription = job(Action::Start);
    transcription.attachment = "transcription".into();
    // vLLM also sends the profile once more as probe suggestions.
    transcription.engine = Engine::Vllm;
    transcription.models = (0..64)
        .map(|i| format!("{}{i:0>3}", "m".repeat(253)))
        .collect();
    transcription.transcription_profile = Some(TranscriptionProfile {
        streaming: Some(true),
        response_formats: Some((0..8).map(token).collect()),
        timestamp_granularities: Some((0..4).map(token).collect()),
        diarization: Some(true),
        languages: Some((0..128).map(token).collect()),
        language_detection: Some(true),
        multiple_language_hints: Some(true),
        max_upload_bytes: Some(i32::MAX as u64),
        accepted_mime_types: Some((0..16).map(token).collect()),
    });
    assert!(transcription.validate().is_ok());
    let inventory = crate::protocol::endpoint_inventory(
        &endpoint_for(&transcription),
        crate::protocol::EndpointStatus::Online,
    );
    let bytes = serde_json::to_vec(&inventory).expect("inventory").len();
    // Fits one relay control frame with room for the hello or update around it.
    assert!(
        bytes < crate::protocol::RELAY_JSON_CONTROL_MAX_BYTES * 3 / 4,
        "{bytes} bytes"
    );
}

#[test]
fn reconnect_instance_frames_are_bounded_complete_and_include_empty() {
    let mut observed = Observed {
        step_id: "step".into(),
        instance_id: "instance".into(),
        revision_id: "revision".into(),
        rank: 0,
        intent_hash: "a".repeat(64),
        phase: "stopped".into(),
        unit_name: "wsmp-i-instance-r0".into(),
        port: 30001,
        endpoint_slug: "inst-fixture-1".into(),
        models: vec!["m".repeat(256); 32],
        context_window: Some(4096),
    };
    let mut instances = Vec::new();
    for index in 0..600 {
        observed.instance_id = format!("instance{index}");
        instances.push(observed.clone());
    }
    let frames = encode_instances(&instances).expect("chunks").frames;
    assert!(frames.len() > 1);
    if let Ok(output) = std::env::var("WSMP_DEPLOYMENT_WIRE_OUTPUT") {
        std::fs::write(
            output,
            serde_json::to_vec(&frames).expect("wire vector JSON"),
        )
        .expect("task wire output");
    }
    let mut count = 0;
    let last_index = frames.len() - 1;
    let mut snapshot_id = None;
    for (index, frame) in frames.into_iter().enumerate() {
        assert!(frame.len() <= crate::protocol::RELAY_JSON_CONTROL_MAX_BYTES);
        let value: serde_json::Value = serde_json::from_str(&frame).expect("JSON");
        let entries = value["instances"].as_array().expect("array");
        assert_eq!(value["chunkIndex"], index);
        assert_eq!(value["final"], index == last_index);
        if let Some(id) = &snapshot_id {
            assert_eq!(&value["snapshotId"], id);
        }
        snapshot_id = Some(value["snapshotId"].clone());
        assert!(entries.len() <= 512);
        count += entries.len();
    }
    assert_eq!(count, 600);
    assert_eq!(encode_instances(&[]).expect("empty").frames.len(), 1);
    observed.models = vec!["m".repeat(256); 64];
    assert!(
        encode_instances(&vec![observed.clone(); 600]).is_err(),
        "whole snapshot bytes are bounded, not only each chunk"
    );
    observed.models.clear();
    assert!(
        encode_instances(&vec![observed; 65_537]).is_err(),
        "whole snapshot record cap is checked before framing"
    );
}

#[test]
fn health_thresholds_preserve_grace_and_require_recovery_successes() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.clone(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    };
    let mut executor = Executor::load(path).expect("load");
    assert_eq!(
        executor
            .execute(job(Action::Start), true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded"
    );
    assert_eq!(
        executor
            .execute(job(Action::Readiness), true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded"
    );
    runtime.ready.set(false);
    for index in 1..=3 {
        let mut health = job(Action::Health);
        health.command.clear();
        health.step_id = format!("failed-health-{index}");
        assert_eq!(
            executor
                .execute(health, true, McpCommandMode::Off, &runtime)
                .status,
            "failed"
        );
        assert_eq!(
            executor.published_jobs(&runtime).len(),
            usize::from(index < 3)
        );
    }
    runtime.ready.set(true);
    let mut recovery = job(Action::Health);
    recovery.command.clear();
    recovery.health.success_threshold = 2;
    for index in 1..=2 {
        recovery.step_id = format!("recovery-health-{index}");
        assert_eq!(
            executor
                .execute(recovery.clone(), true, McpCommandMode::Off, &runtime)
                .status,
            "succeeded"
        );
        assert_eq!(
            executor.published_jobs(&runtime).len(),
            usize::from(index == 2)
        );
    }
}

#[test]
fn restart_starts_health_hysteresis_over() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.clone(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    };
    let mut executor = Executor::load(path).expect("load");
    let run = |executor: &mut Executor, job: Job| {
        executor
            .execute(job, true, McpCommandMode::Off, &runtime)
            .status
    };
    let failed_health = |id: &str| {
        let mut health = job(Action::Health);
        health.command.clear();
        health.step_id = id.into();
        health
    };
    assert_eq!(run(&mut executor, job(Action::Start)), "succeeded");
    assert_eq!(run(&mut executor, job(Action::Readiness)), "succeeded");
    runtime.ready.set(false);
    for index in 1..=2 {
        assert_eq!(
            run(&mut executor, failed_health(&format!("old-{index}"))),
            "failed"
        );
    }
    let mut stop = job(Action::Stop);
    stop.step_id = "stop".into();
    assert_eq!(run(&mut executor, stop), "succeeded");
    runtime.ready.set(true);
    let mut restart = job(Action::Start);
    restart.step_id = "restart".into();
    assert_eq!(run(&mut executor, restart), "succeeded");
    let mut ready = job(Action::Readiness);
    ready.step_id = "restart-ready".into();
    assert_eq!(run(&mut executor, ready), "succeeded");
    runtime.ready.set(false);
    // One failure after the restart is below the threshold of three.
    assert_eq!(run(&mut executor, failed_health("new-1")), "failed");
    assert_eq!(executor.published_jobs(&runtime).len(), 1);
}

#[cfg(target_os = "linux")]
#[test]
fn actual_transient_unit_restart_adoption_and_foreign_invocation_refusal() {
    if std::env::var("WSMP_DEPLOYMENT_RUNTIME_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }
    let runtime = NativeRuntime { cancel: None };
    let mechanism = super::mechanism();
    assert_eq!(
        activation_supported(Action::Start, mechanism),
        mechanism == "systemd+linger"
    );
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let mut executor = Executor::load(path.clone()).expect("load");
    let mut start = job(Action::Start);
    start.instance_id = format!(
        "fixture{}",
        rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 12)
    );
    start.unit_name = format!("wsmp-i-{}-r0", start.instance_id);
    struct OwnedFixture {
        units: Vec<String>,
        owner: String,
    }
    impl Drop for OwnedFixture {
        fn drop(&mut self) {
            let runtime = NativeRuntime { cancel: None };
            for unit in &self.units {
                if let Ok(Some(invocation)) =
                    runtime.identity(unit, &self.owner, Deadline::new(Duration::from_secs(5)))
                {
                    let _ = runtime.stop(
                        unit,
                        &self.owner,
                        &invocation,
                        Deadline::new(Duration::from_secs(5)),
                    );
                }
            }
        }
    }
    let _cleanup = OwnedFixture {
        units: vec![
            start.unit_name.clone(),
            format!("{}-prepare", start.unit_name),
        ],
        owner: executor.state.owner_id.clone(),
    };
    // Runtime owning-boundary qualification only: production service preflight
    // must still refuse activation when Linger=no; no host setting is changed.
    let mut prepare = start.clone();
    prepare.action = Action::Prepare;
    prepare.step_id = "real-prepare".into();
    prepare.command = "true".into();
    assert_eq!(
        executor
            .execute(prepare, true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded",
        "actual prepare must finish before start"
    );
    let result = executor.execute(start.clone(), true, McpCommandMode::Off, &runtime);
    assert_eq!(
        result.status, "succeeded",
        "actual manager unit launch failed"
    );
    let owner = executor.state.owner_id.clone();
    let invocation = runtime
        .identity(
            &start.unit_name,
            &owner,
            Deadline::new(Duration::from_secs(5)),
        )
        .expect("owned")
        .expect("active");
    assert!(
        runtime
            .identity(
                &start.unit_name,
                "foreign-owner",
                Deadline::new(Duration::from_secs(5))
            )
            .is_err()
    );
    assert!(
        runtime
            .stop(
                &start.unit_name,
                &owner,
                "foreign-invocation",
                Deadline::new(Duration::from_secs(5))
            )
            .is_err()
    );
    // Model a crash after the real launch, before recording its completion.
    let record = executor
        .state
        .records
        .get_mut(&start.key())
        .expect("record");
    record.pending = Some(start.clone());
    record.completed.remove(&start.step_id);
    record.invocations.remove(&start.unit_name);
    executor
        .persist_within(STATE_LIMIT, "")
        .expect("crash state");
    let mut executor = Executor::load(path).expect("restart load");
    assert_eq!(
        executor
            .execute(start.clone(), true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded",
        "adopt ambiguous real launch without replay"
    );
    assert_eq!(
        runtime
            .identity(
                &start.unit_name,
                &owner,
                Deadline::new(Duration::from_secs(5))
            )
            .expect("identity"),
        Some(invocation.clone())
    );
    assert_eq!(executor.observations(&runtime)[0].phase, "starting");
    assert!(
        runtime
            .identity(
                &start.unit_name,
                &owner,
                Deadline::new(Duration::from_secs(5))
            )
            .expect("still owned")
            .is_some()
    );
    let mut stop = start.clone();
    stop.action = Action::Stop;
    stop.step_id = "real-stop".into();
    stop.command = "true".into();
    assert!(
        executor
            .execute(stop, true, McpCommandMode::Off, &runtime)
            .stopped,
        "owned stop tears down all phase units"
    );
    assert!(
        runtime
            .identity(
                &start.unit_name,
                &owner,
                Deadline::new(Duration::from_secs(5))
            )
            .expect("gone")
            .is_none()
    );
}

#[cfg(target_os = "linux")]
struct UnitCleanup(Vec<String>);

#[cfg(target_os = "linux")]
impl Drop for UnitCleanup {
    fn drop(&mut self) {
        for unit in &self.0 {
            let _ = manager_until(
                "systemctl",
                &[
                    "--user".into(),
                    "kill".into(),
                    "--kill-whom=all".into(),
                    "--signal=KILL".into(),
                    unit.clone(),
                ],
                Deadline::new(Duration::from_secs(3)),
                None,
            );
            let _ = manager_until(
                "systemctl",
                &["--user".into(), "stop".into(), unit.clone()],
                Deadline::new(Duration::from_secs(3)),
                None,
            );
        }
    }
}

#[cfg(target_os = "linux")]
fn runtime_fixture(command: &str) -> (tempfile::TempDir, Executor, Job, UnitCleanup) {
    let root = tempfile::tempdir().expect("root");
    let executor = Executor::load(root.path().join("instances.json")).expect("state");
    let mut start = job(Action::Start);
    start.instance_id = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 20);
    start.unit_name = format!("wsmp-i-{}-r0", start.instance_id);
    start.command = command.into();
    start.timeout_ms = 2000;
    let cleanup = UnitCleanup(vec![start.unit_name.clone()]);
    (root, executor, start, cleanup)
}

#[cfg(target_os = "linux")]
#[test]
fn actual_job_deadline_bounds_stalled_manager_stop_and_fast_inverse() {
    if std::env::var("WSMP_DEPLOYMENT_RUNTIME_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }
    let runtime = NativeRuntime { cancel: None };
    for (command, timeout, expected) in [
        ("trap '' TERM; while :; do sleep 1; done", 180, false),
        ("sleep 30 & wait", 2000, true),
    ] {
        let (_root, mut executor, start, _cleanup) = runtime_fixture(command);
        assert_eq!(
            executor
                .execute(start.clone(), true, McpCommandMode::Off, &runtime)
                .status,
            "succeeded"
        );
        let mut stop = start.clone();
        stop.action = Action::Stop;
        stop.step_id = "deadline-stop".into();
        stop.timeout_ms = timeout;
        let began = Instant::now();
        let result = executor.execute(stop, true, McpCommandMode::Off, &runtime);
        assert!(
            began.elapsed() < Duration::from_millis(timeout + 120),
            "stop reset the total deadline: {:?}",
            began.elapsed()
        );
        assert_eq!(
            result.stopped, expected,
            "pending manager stop must not report stopped"
        );
        if !expected {
            assert_eq!(executor.state.records[&start.key()].phase, "stopping");
            assert!(executor.published_jobs(&runtime).is_empty());
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn actual_prepare_deadline_and_cancel_prevent_delayed_effect() {
    if std::env::var("WSMP_DEPLOYMENT_RUNTIME_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }
    for cancel_early in [false, true] {
        let (root, mut executor, mut prepare, mut cleanup) = runtime_fixture("true");
        prepare.action = Action::Prepare;
        prepare.step_id = "bounded-prepare".into();
        prepare.timeout_ms = if cancel_early { 1500 } else { 180 };
        cleanup.0.push(phase_unit(&prepare));
        let effect = root.path().join("late-effect");
        prepare.command = format!("trap '' TERM; sleep 0.5; touch '{}'", effect.display());
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cancel.clone();
        let setter = std::thread::spawn(move || {
            if cancel_early {
                std::thread::sleep(Duration::from_millis(80));
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let runtime = NativeRuntime {
            cancel: Some(cancel),
        };
        let began = Instant::now();
        let result = executor.execute(prepare.clone(), true, McpCommandMode::Off, &runtime);
        assert_eq!(result.status, "failed");
        assert!(!result.stopped);
        assert!(began.elapsed() < Duration::from_millis(prepare.timeout_ms + 120));
        setter.join().expect("setter");
        std::thread::sleep(Duration::from_millis(550));
        assert!(
            !effect.exists(),
            "prepare effect survived deadline/cancellation"
        );
    }
}

#[cfg(unix)]
#[test]
fn actual_total_deadline_covers_shell_status_readiness_and_admission() {
    let root = tempfile::tempdir().expect("root");
    let effect = root.path().join("effect");
    let runtime = NativeRuntime { cancel: None };
    // Wide margins: spawning a shell takes tens of milliseconds on loaded
    // CI runners (macOS especially), so the first operation must fit easily
    // and the second must clearly overrun what is left.
    let budget = Deadline::new(Duration::from_millis(1500));
    runtime
        .shell("sleep 0.3", budget.remaining().expect("budget"))
        .expect("first operation");
    assert!(
        runtime
            .shell(
                &format!("sleep 1.5; touch '{}'", effect.display()),
                budget.remaining().expect("remaining")
            )
            .is_err()
    );
    assert!(budget.remaining().is_err());
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!effect.exists(), "effect after total deadline");
    assert!(
        runtime
            .status("sleep 1; exit 3", Duration::from_millis(40))
            .is_err()
    );
    runtime
        .shell("true", Duration::from_secs(1))
        .expect("fast inverse");
    assert!(
        !runtime
            .status("exit 3", Duration::from_secs(1))
            .expect("fast absence")
    );

    let path = root.path().join("instances.json");
    let fake = Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.clone(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    };
    let mut executor = Executor::load(path).expect("load");
    let start = job(Action::Start);
    let expired = Deadline::new(Duration::ZERO);
    assert_eq!(
        executor
            .execute_until(start.clone(), true, McpCommandMode::Off, &fake, expired)
            .status,
        "failed"
    );
    assert_eq!(fake.launches.get(), 0, "expired admission launched");
    assert_eq!(
        executor
            .execute(start.clone(), true, McpCommandMode::Off, &fake)
            .status,
        "succeeded"
    );
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener");
    let mut readiness = job(Action::Readiness);
    readiness.port = start.port;
    // Exercise actual HTTP timeout directly; no server response or mock HTTP.
    let mut http = readiness.clone();
    http.port = listener.local_addr().expect("address").port();
    let began = Instant::now();
    assert!(!runtime.healthy(&http, Duration::from_millis(60)));
    assert!(began.elapsed() < Duration::from_millis(180));
}

#[cfg(target_os = "linux")]
#[test]
fn actual_external_escape_requires_teardown_and_empty_owned_unit_is_unknown() {
    if std::env::var("WSMP_DEPLOYMENT_RUNTIME_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }
    let runtime = NativeRuntime { cancel: None };
    let (_root, mut empty, mut start, _cleanup) = runtime_fixture("true");
    start.timeout_ms = 180;
    assert_eq!(
        empty
            .execute(start.clone(), true, McpCommandMode::Off, &runtime)
            .status,
        "failed",
        "empty active-exited unit is not an owned backend"
    );
    assert!(empty.published_jobs(&runtime).is_empty());
    let mut empty_stop = start.clone();
    empty_stop.action = Action::Stop;
    empty_stop.step_id = "empty-stop".into();
    assert!(
        !empty
            .execute(empty_stop, true, McpCommandMode::Off, &runtime)
            .stopped,
        "unknown empty start cannot release backend claims"
    );

    let manager_env = format!(
        "env XDG_RUNTIME_DIR=/run/user/{}",
        nix::unistd::Uid::effective().as_raw()
    );
    let (_root, mut accidental, mut detached, mut cleanup) = runtime_fixture("true");
    let unclaimed = format!("wsmp-i-{}-external", detached.instance_id);
    cleanup.0.push(unclaimed.clone());
    detached.command = format!(
        "{manager_env} systemd-run --user --quiet --unit={unclaimed} --property=StandardOutput=null --property=StandardError=null --property=Restart=no /bin/sleep 30"
    );
    detached.timeout_ms = 180;
    assert_eq!(
        accidental
            .execute(detached.clone(), true, McpCommandMode::Off, &runtime)
            .status,
        "failed",
        "accidental detachment is not an owned launch"
    );
    detached.action = Action::Stop;
    detached.step_id = "accidental-stop".into();
    assert!(
        !accidental
            .execute(detached, true, McpCommandMode::Off, &runtime)
            .stopped,
        "accidental external detachment cannot release claims"
    );
    assert!(
        runtime
            .status(
                &format!("{manager_env} systemctl --user is-active --quiet {unclaimed}"),
                Duration::from_secs(1)
            )
            .expect("escaped backend survives")
    );

    let (root, mut executor, mut start, mut cleanup) = runtime_fixture("true");
    let escaped = format!("wsmp-i-{}-external", start.instance_id);
    cleanup.0.push(escaped.clone());
    let permit = root.path().join("allow-teardown");
    start.management = Management::ExternalService;
    start.command = format!(
        "{manager_env} systemd-run --user --quiet --unit={escaped} --property=StandardOutput=null --property=StandardError=null --property=Restart=no /bin/sleep 30"
    );
    start.stop_command = Some(format!(
        "if [ -e '{}' ]; then {manager_env} systemctl --user stop {escaped}; fi",
        permit.display()
    ));
    start.status_command = Some(format!(
        "state=$({manager_env} systemctl --user show {escaped} -p ActiveState --value) || exit 1; case \"$state\" in active|activating|deactivating) exit 0;; inactive|failed) exit 3;; *) exit 1;; esac"
    ));
    assert_eq!(
        executor
            .execute(start.clone(), true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded",
        "external declared launch"
    );
    let mut stop = start.clone();
    stop.action = Action::Stop;
    stop.step_id = "external-stop".into();
    stop.command = "true".into();
    let result = executor.execute(stop.clone(), true, McpCommandMode::Off, &runtime);
    assert!(
        !result.stopped,
        "escaped backend survived owned unit teardown"
    );
    assert_eq!(result.status, "failed");
    assert!(
        runtime
            .identity(
                &start.unit_name,
                &executor.state.owner_id,
                Deadline::new(Duration::from_secs(1))
            )
            .expect("unit absence")
            .is_none()
    );
    assert!(
        runtime
            .status(
                start.status_command.as_deref().expect("status"),
                Duration::from_secs(1)
            )
            .expect("escaped process lives")
    );
    std::fs::write(permit, b"teardown").expect("permit");
    assert!(
        executor
            .execute(stop.clone(), true, McpCommandMode::Off, &runtime)
            .stopped,
        "positive external teardown inverse"
    );
    assert!(
        executor
            .execute(stop, true, McpCommandMode::Off, &runtime)
            .stopped,
        "cached stop rechecks absence"
    );
    let mut undeclared = start;
    undeclared.status_command = None;
    assert!(
        undeclared.validate().is_err(),
        "external contract cannot omit absence proof"
    );
}

#[cfg(unix)]
#[test]
fn deployment_lock_child_helper() {
    let Some(path) = std::env::var_os("WSMP_TEST_DEPLOYMENT_LOCK") else {
        return;
    };
    let expect_busy = std::env::var_os("WSMP_TEST_LOCK_BUSY").is_some();
    assert_eq!(
        super::service::state_lock(&PathBuf::from(path)).is_err(),
        expect_busy
    );
}

#[cfg(unix)]
#[test]
fn actual_cross_process_instances_lock_and_private_files() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let root = tempfile::tempdir().expect("root");
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777))
        .expect("fixture permissions");
    let path = root.path().join("instances.json");
    let lock = super::service::state_lock(&path).expect("lock");
    let probe = |busy| {
        let mut child = std::process::Command::new(std::env::current_exe().expect("test exe"));
        child
            .args([
                "--exact",
                "deployments::tests::deployment_lock_child_helper",
                "--test-threads=1",
            ])
            .env("WSMP_TEST_DEPLOYMENT_LOCK", &path);
        if busy {
            child.env("WSMP_TEST_LOCK_BUSY", "1");
        }
        assert!(child.status().expect("child").success());
    };
    probe(true);
    assert_eq!(
        std::fs::metadata(root.path()).expect("directory").mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(root.path().join("instances.lock"))
            .expect("file")
            .mode()
            & 0o777,
        0o600
    );
    drop(lock);
    probe(false);
    let other = tempfile::tempdir().expect("other");
    std::os::unix::fs::symlink(
        root.path().join("instances.lock"),
        other.path().join("instances.lock"),
    )
    .expect("symlink");
    assert!(
        super::service::state_lock(&other.path().join("instances.json")).is_err(),
        "nofollow lock"
    );
}

#[test]
fn command_limit_counts_bytes_and_matches_the_server() {
    // The server refuses longer recipe and rendered commands with the same constant.
    let shared = include_str!("../../../../packages/config/src/deployment-protocol.ts");
    assert!(shared.contains(&format!(
        "export const DEPLOYMENT_COMMAND_MAX_BYTES = {DEPLOYMENT_COMMAND_MAX_BYTES};"
    )));
    let with = |command: String| {
        let mut start = job(Action::Start);
        start.command = command;
        start.validate()
    };
    assert!(with("a".repeat(DEPLOYMENT_COMMAND_MAX_BYTES)).is_ok());
    assert!(with("a".repeat(DEPLOYMENT_COMMAND_MAX_BYTES + 1)).is_err());
    assert!(with("é".repeat(DEPLOYMENT_COMMAND_MAX_BYTES / 2)).is_ok());
    assert!(with(format!("{}a", "é".repeat(DEPLOYMENT_COMMAND_MAX_BYTES / 2))).is_err());
    let mut stop = job(Action::Stop);
    stop.stop_command = Some("s".repeat(DEPLOYMENT_COMMAND_MAX_BYTES + 1));
    assert!(stop.validate().is_err());
}

fn instance_job(action: Action, index: usize) -> Job {
    let mut job = job(action);
    job.instance_id = format!("fixture{index}");
    job.unit_name = format!("wsmp-i-fixture{index}-r0");
    job.endpoint_slug = format!("inst-fixture{index}-1");
    job.step_id = format!("step-{action:?}-{index}");
    // These tests encode multi-MiB state in a debug build alongside the rest
    // of the suite; a 1 s budget measures machine load, not the behavior.
    // 30 s is within every action's protocol maximum.
    job.timeout_ms = 30_000;
    job
}

fn fake(path: &std::path::Path) -> Fake {
    Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.to_path_buf(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    }
}

const T0: u64 = 1_000_000;
thread_local! {
    static NOW: Cell<u64> = const { Cell::new(T0) };
}
fn test_clock() -> u64 {
    NOW.with(Cell::get)
}

/// A record as the executor leaves it: live after a start, or verified
/// stopped. `pad` adds non-transient launch history.
fn seeded_record(job: Job, stopped: bool, pad: usize) -> Record {
    let mut completed = BTreeMap::new();
    for step in 0..pad {
        let mut done = job.clone();
        done.action = Action::Prepare;
        done.step_id = format!("prepare-{step}");
        completed.insert(
            done.step_id.clone(),
            Completed {
                hash: done.intent_hash.clone(),
                result: JobResult::new(&done, true, false, None),
                action: Action::Prepare,
            },
        );
    }
    Record {
        invocations: if stopped {
            BTreeMap::new()
        } else {
            BTreeMap::from([(job.unit_name.clone(), "invocation".to_owned())])
        },
        phase: if stopped { "stopped" } else { "ready" }.into(),
        pending: None,
        completed,
        observed_step: job.step_id.clone(),
        observed_hash: job.intent_hash.clone(),
        consecutive_health_failures: 0,
        consecutive_health_successes: 0,
        stopped_at: stopped.then_some(T0),
        operator: None,
        job,
    }
}

fn state_bytes(executor: &Executor) -> usize {
    serde_json::to_vec(&executor.state).expect("encode").len()
}

#[test]
fn churned_instances_keep_deployment_state_bounded() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = fake(&path);
    let mut executor = Executor::load(path.clone()).expect("load");
    executor.clock = test_clock;
    NOW.with(|now| now.set(T0));
    // Earlier lifetime churn: as many verified-stopped records as fit.
    let seeded = RECORD_LIMIT - 8;
    for index in 0..seeded {
        let record = seeded_record(instance_job(Action::Start, index), true, 0);
        executor
            .state
            .records
            .insert(format!("fixture{index}:0"), record);
    }
    executor.persist_within(STATE_LIMIT, "").expect("seed");
    // Real start/health/stop cycles push past the record limit.
    let churn = seeded + 40;
    for index in seeded..churn {
        NOW.with(|now| now.set(T0 + index as u64));
        assert_eq!(
            executor
                .execute(
                    instance_job(Action::Start, index),
                    true,
                    McpCommandMode::Off,
                    &runtime
                )
                .status,
            "succeeded",
            "start {index}"
        );
        executor.execute(
            instance_job(Action::Health, index),
            true,
            McpCommandMode::Off,
            &runtime,
        );
        assert!(
            executor
                .execute(
                    instance_job(Action::Stop, index),
                    true,
                    McpCommandMode::Off,
                    &runtime
                )
                .stopped,
            "stop {index}"
        );
        assert!(executor.state.records.len() <= RECORD_LIMIT);
    }
    assert_eq!(runtime.launches.get(), 40);
    assert_eq!(
        Executor::load(path.clone())
            .expect("reload")
            .state
            .records
            .len(),
        RECORD_LIMIT
    );
    // The oldest stopped records made room; recent stops still answer a
    // retry of the same step from their durable record.
    assert!(!executor.state.records.contains_key("fixture0:0"));
    let mut retry = instance_job(Action::Stop, churn - 1);
    retry.owner_epoch = "retry".into();
    let reply = executor.execute(retry, true, McpCommandMode::Off, &runtime);
    assert!(reply.stopped);
    assert_eq!(reply.owner_epoch, "retry");
    let on_disk = std::fs::metadata(&path).expect("state").len() as usize;
    assert!(on_disk < STATE_LIMIT - STOP_RESERVE, "{on_disk}");

    // A live record is never pruned; past the retention window every stopped
    // record is dropped on the next write.
    let live = churn;
    executor.execute(
        instance_job(Action::Start, live),
        true,
        McpCommandMode::Off,
        &runtime,
    );
    NOW.with(|now| now.set(T0 + churn as u64 + STOPPED_RETENTION_SECS));
    let start = instance_job(Action::Start, live + 1);
    assert_eq!(
        executor
            .execute(start, true, McpCommandMode::Off, &runtime)
            .status,
        "succeeded"
    );
    let reloaded = Executor::load(path).expect("reload");
    assert_eq!(
        reloaded.state.records.keys().cloned().collect::<Vec<_>>(),
        vec![format!("fixture{live}:0"), format!("fixture{}:0", live + 1)]
    );
}

#[test]
fn stop_runs_when_state_is_near_its_limit_and_new_work_is_refused() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = fake(&path);
    let mut executor = Executor::load(path.clone()).expect("load");
    executor.clock = test_clock;
    NOW.with(|now| now.set(T0));
    let large = |index: usize| {
        let mut job = instance_job(Action::Start, index);
        job.command = "c".repeat(DEPLOYMENT_COMMAND_MAX_BYTES);
        job.stop_command = Some("s".repeat(DEPLOYMENT_COMMAND_MAX_BYTES));
        job.models = (0..64)
            .map(|model| format!("{model:02}{}", "m".repeat(254)))
            .collect();
        job
    };
    // Live records past the admission limit with under two records' worth of
    // the hard limit left, as if earlier stops had used the reserve.
    let record_bytes = serde_json::to_vec(&seeded_record(large(0), false, 40))
        .expect("encode")
        .len();
    let count = (STATE_LIMIT - 2 * record_bytes) / (record_bytes + 16);
    assert!(count < RECORD_LIMIT, "{count}");
    for index in 0..count {
        executor.state.records.insert(
            format!("fixture{index}:0"),
            seeded_record(large(index), false, 40),
        );
    }
    let seeded = state_bytes(&executor);
    assert!(seeded > STATE_LIMIT - STOP_RESERVE && seeded < STATE_LIMIT - record_bytes);
    executor.persist_within(STATE_LIMIT, "").expect("seed");

    // A new instance cannot take the stop reserve: refused before any launch,
    // without leaving its record behind, for size and not for time.
    let refused = executor
        .execute_inner(
            &instance_job(Action::Start, count),
            &runtime,
            Deadline::new(Duration::from_secs(30)),
        )
        .expect_err("refused");
    assert_eq!(refused.to_string(), "deployment state too large");
    assert_eq!(runtime.launches.get(), 0);
    assert_eq!(executor.state.records.len(), count);

    // Live instances can still be stopped, with a maximal stop job.
    for victim in [0, count / 2, count - 1] {
        let unit = format!("wsmp-i-fixture{victim}-r0");
        runtime
            .units
            .borrow_mut()
            .insert(unit.clone(), "invocation".into());
        let mut stop = large(victim);
        stop.action = Action::Stop;
        stop.step_id = format!("stop-{victim}");
        let reply = executor.execute(stop, true, McpCommandMode::Off, &runtime);
        assert!(reply.stopped, "stop {victim}: {:?}", reply.error);
        assert!(!runtime.units.borrow().contains_key(&unit));
    }
    let on_disk = std::fs::metadata(&path).expect("state").len() as usize;
    assert!(on_disk <= STATE_LIMIT);

    // Once records are verified stopped, they are the first to make room.
    for record in executor.state.records.values_mut() {
        record.phase = "stopped".into();
        record.invocations.clear();
        record.stopped_at = Some(T0);
    }
    executor
        .persist_within(STATE_LIMIT, "")
        .expect("seed stopped");
    let admitted = executor.execute(
        instance_job(Action::Start, count),
        true,
        McpCommandMode::Off,
        &runtime,
    );
    assert_eq!(admitted.status, "succeeded", "{:?}", admitted.error);
    assert!(state_bytes(&executor) <= STATE_LIMIT - STOP_RESERVE);
    assert!(executor.state.records.len() < count);
}

fn job_golden() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/relay-current/deployment-jobs.json"
    ))
    .expect("golden JSON")
}

fn golden_job(name: &str) -> Job {
    serde_json::from_value(job_golden()["jobs"][name].clone()).expect(name)
}

fn fake_runtime(path: &std::path::Path) -> Fake {
    Fake {
        units: RefCell::new(BTreeMap::new()),
        launches: Cell::new(0),
        intent_path: path.to_path_buf(),
        stop_fails: Cell::new(false),
        ready: Cell::new(true),
    }
}

#[test]
fn current_job_wire_matches_shared_golden() {
    let golden = job_golden();
    assert_eq!(
        golden["protocolVersion"],
        crate::protocol::RELAY_PROTOCOL_VERSION
    );
    let jobs = golden["jobs"].as_object().expect("jobs");
    assert_eq!(jobs.len(), 4);
    for (name, value) in jobs {
        let job: Job = serde_json::from_value(value.clone()).expect(name);
        job.validate().expect(name);
        // Decoding and re-encoding loses nothing, so a persisted job stays the
        // job the server hashed.
        assert_eq!(
            &serde_json::to_value(&job).expect("encode"),
            value,
            "{name}"
        );
        assert_eq!(job.needs_operator(), name != "plainStart", "{name}");
    }

    let interactive = golden_job("interactiveStart");
    let results = &golden["results"];
    let encode = |result: &JobResult| serde_json::to_value(result).expect("result");
    assert_eq!(
        encode(&JobResult::failure(&interactive, INTERACTIVE_UNSUPPORTED)),
        results["interactiveRefused"]
    );
    assert_eq!(
        encode(&JobResult::failure(
            &golden_job("stopInteractiveStart"),
            INTERACTIVE_UNSUPPORTED
        )),
        results["stopInteractiveRefused"]
    );
    // Finals of an interactive job are bound to its dispatch's terminal; a
    // remembered final answers a later delivery under that delivery's ids.
    let succeeded = JobResult::new(&interactive, true, false, None);
    assert_eq!(encode(&succeeded), results["operatorSucceeded"]);
    let mut later = interactive.clone();
    later.owner_epoch = "later:2".into();
    if let Some(operator) = later.operator.as_mut() {
        operator.terminal_id = "BBECAwQFBgcICQoLDA0ODw".into();
    }
    let answered = succeeded.clone().answering(&later);
    assert_eq!(answered.owner_epoch, "later:2");
    assert_eq!(
        answered.terminal_id.as_deref(),
        Some("BBECAwQFBgcICQoLDA0ODw")
    );
    assert_eq!(
        JobResult::new(&golden_job("plainStart"), true, false, None).terminal_id,
        None
    );
    for (progress, name) in [
        (OperatorProgress::Awaiting, "awaitingOperator"),
        (OperatorProgress::Running, "operatorRunning"),
        (OperatorProgress::Closed(Some(1)), "operatorClosed"),
        (OperatorProgress::Closed(None), "operatorDeclined"),
    ] {
        let result = JobResult::operator(&interactive, progress).expect(name);
        assert_eq!(encode(&result), results[name], "{name}");
    }
    assert_eq!(
        encode(
            &JobResult::operator_failed(&interactive, "operator_terminal_failed")
                .expect("operator job")
        ),
        results["operatorTerminalFailed"]
    );
    assert!(JobResult::operator_failed(&golden_job("plainStart"), "x").is_none());
    assert!(JobResult::operator(&golden_job("plainStart"), OperatorProgress::Awaiting).is_none());
}

#[test]
fn wire_edge_cases_agree_with_the_server_mirror() {
    // The server's `deploymentJobWireIssue` accepts and rejects exactly these
    // (`packages/api/src/lib/deployment-job-golden.test.ts`).
    let golden = job_golden();
    let accepted = golden["wireCases"]["accepted"]
        .as_object()
        .expect("accepted");
    let rejected = golden["wireCases"]["rejected"]
        .as_object()
        .expect("rejected");
    assert!(!accepted.is_empty() && !rejected.is_empty());
    for (name, value) in accepted {
        let job: Job = serde_json::from_value(value.clone()).expect(name);
        job.validate()
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    for (name, value) in rejected {
        let refused = serde_json::from_value::<Job>(value.clone())
            .map_or(true, |job| job.validate().is_err());
        assert!(refused, "{name} must be refused");
    }
    // The forwarder slug rules on their own, reserved words included.
    for slug in golden["slugCases"]["accepted"].as_array().expect("slugs") {
        let slug = slug.as_str().expect("slug");
        assert!(crate::slug::validate_slug(slug).is_ok(), "{slug}");
    }
    for slug in golden["slugCases"]["rejected"].as_array().expect("slugs") {
        let slug = slug.as_str().expect("slug");
        assert!(crate::slug::validate_slug(slug).is_err(), "{slug}");
    }
}

#[test]
fn server_shaped_plain_job_runs_unchanged() {
    // The exact frame the server dispatches: an `<uuid>:<generation>` owner
    // epoch and the recipe's `readiness.timeoutMs`.
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = fake_runtime(&path);
    let mut executor = Executor::load(path).expect("load");
    let start = golden_job("plainStart");
    let result = executor.execute(start.clone(), true, McpCommandMode::Off, &runtime);
    assert_eq!(result.status, "succeeded", "{result:?}");
    assert_eq!(result.owner_epoch, start.owner_epoch);
    assert_eq!(runtime.launches.get(), 1);
}

/// Without operator terminals (no Unix PTY), every job with an interactive
/// field is refused before any state is touched.
#[test]
fn interactive_jobs_are_refused_before_any_state_or_launch() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = fake_runtime(&path);
    let mut executor = Executor::load(path.clone()).expect("load");
    for name in [
        "interactiveStart",
        "interactiveStop",
        "stopInteractiveStart",
    ] {
        for mode in [McpCommandMode::Off, McpCommandMode::Unsupervised] {
            let result = executor.execute(golden_job(name), true, mode, &runtime);
            assert_eq!(result.status, "failed", "{name}");
            assert_eq!(result.error.as_deref(), Some(INTERACTIVE_UNSUPPORTED));
            assert!(!result.stopped);
            // A final names the job's operator terminal, if it had one.
            let job = golden_job(name);
            assert_eq!(
                result.terminal_id.as_deref(),
                job.operator.as_ref().map(|op| op.terminal_id.as_str())
            );
        }
    }
    assert_eq!(runtime.launches.get(), 0);
    assert!(!path.exists(), "nothing was recorded");
    // A malformed interactive job is still `bad_job`, not a refusal.
    let mut malformed = golden_job("interactiveStart");
    malformed.operator = None;
    let result = executor.execute(malformed, true, McpCommandMode::Off, &runtime);
    assert_eq!(result.error.as_deref(), Some("bad_job"));
}

#[test]
fn interactive_fields_follow_the_server_intent_rules() {
    let valid = golden_job("interactiveStart");
    let refused = |change: &dyn Fn(&mut Job), why: &str| {
        let mut job = valid.clone();
        change(&mut job);
        assert!(job.validate().is_err(), "{why}");
    };
    refused(&|j| j.interactive = Some(false), "false is never sent");
    refused(&|j| j.stop_interactive = Some(false), "false is never sent");
    refused(&|j| j.operator = None, "interactive without a terminal");
    refused(
        &|j| j.terminal("AAECAwQFBgcICQoLDA0OD"),
        "terminal id is 22 characters",
    );
    refused(
        &|j| j.terminal("AAECAwQFBgcICQoLDA0OD!"),
        "terminal id is base64url",
    );
    refused(
        &|j| j.action = Action::Readiness,
        "readiness is never interactive",
    );
    refused(
        &|j| j.action = Action::Health,
        "health is never interactive",
    );
    refused(
        &|j| j.action = Action::Status,
        "status is never interactive",
    );
    refused(
        &|j| {
            j.action = Action::AfterJoin;
            j.management = Management::OwnedProcess;
        },
        "interactive after_join must be an external service",
    );
    refused(
        &|j| j.management = Management::OwnedProcess,
        "interactive start must be an external service",
    );
    refused(&|j| j.status_command = Some(" ".into()), "needs status");

    let mut prepare = valid.clone();
    prepare.action = Action::Prepare;
    prepare.management = Management::OwnedProcess;
    prepare
        .validate()
        .expect("an owned prepare may be interactive");

    let mut terminal_only = golden_job("plainStart");
    terminal_only.operator = valid.operator.clone();
    assert!(
        terminal_only.validate().is_err(),
        "a terminal without interactive"
    );
    let mut stop_flag = golden_job("plainStart");
    stop_flag.stop_interactive = Some(true);
    assert!(
        stop_flag.validate().is_err(),
        "an interactive stop needs status"
    );
    stop_flag.status_command = Some("pgrep fixture".into());
    stop_flag.validate().expect("stopInteractive with status");

    // Strict decoding is unchanged for everything else.
    let mut extra = job_golden()["jobs"]["interactiveStart"].clone();
    extra["operator"]["viewerId"] = "x".into();
    assert!(serde_json::from_value::<Job>(extra).is_err());
    let mut author = job_golden()["jobs"]["interactiveStart"].clone();
    author["operator"]["commandAuthor"] = "person".into();
    assert!(serde_json::from_value::<Job>(author).is_err());
    let mut no_author = job_golden()["jobs"]["interactiveStart"].clone();
    no_author["operator"]
        .as_object_mut()
        .expect("operator")
        .remove("commandAuthor");
    assert!(serde_json::from_value::<Job>(no_author).is_err());
    assert_eq!(
        golden_job("interactiveStop")
            .operator
            .map(|operator| operator.command_author),
        Some(CommandAuthor::Agent)
    );
    let mut extra = job_golden()["jobs"]["plainStart"].clone();
    extra["operatorTerminal"] = "x".into();
    assert!(serde_json::from_value::<Job>(extra).is_err());

    let mut epoch = golden_job("plainStart");
    epoch.owner_epoch = "epoch/7".into();
    assert!(epoch.validate().is_err());
    let mut readiness = golden_job("plainStart");
    readiness.readiness.timeout_ms = Some(900_001);
    assert!(readiness.validate().is_err());
}

trait TerminalId {
    fn terminal(&mut self, id: &str);
}
impl TerminalId for Job {
    fn terminal(&mut self, id: &str) {
        self.operator = Some(Operator {
            terminal_id: id.into(),
            command_author: CommandAuthor::Unknown,
        });
    }
}
