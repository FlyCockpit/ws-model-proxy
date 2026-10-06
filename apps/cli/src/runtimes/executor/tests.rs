use super::*;
use std::cell::{Cell, RefCell};

fn job(action: JobPhase) -> Job {
    Job {
        step_id: format!("step-{action:?}"),
        instance_id: "in1".into(),
        runtime_id: "rt1".into(),
        version_id: "vr1".into(),
        launch_hash: "h".repeat(64),
        rank: 0,
        action,
        intent_hash: "a".repeat(64),
        owner_epoch: "epoch".into(),
        command: match action {
            JobPhase::Start => "sleep 30".into(),
            _ => String::new(),
        },
        stop_command: "true".into(),
        status_command: None,
        health_command: None,
        secrets: Vec::new(),
        timeout_ms: 1_000,
        unit_name: "wsmp-i-abcdefabcdef-r0".into(),
        handle: "i-abcdefabcdef".into(),
        port: 30001,
        gpu_ids: None,
        host: "127.0.0.1".into(),
        spec: serde_json::json!({
            "api": "openai", "engine": "vllm", "modelType": "llm",
            "models": [{ "id": "m" }],
            "launch": {
                "management": "process", "groupSize": 1,
                "resources": [{ "kind": "none" }], "labels": [],
                "commands": [{ "start": "sleep 30", "stop": "true" }],
                "readiness": { "path": "/health", "expectedStatus": 200, "timeoutMs": 60000 },
                "health": { "intervalMs": 30000, "failureThreshold": 2, "successThreshold": 1 }
            }
        }),
    }
}

struct Fake {
    units: RefCell<BTreeMap<String, String>>,
    launches: Cell<u32>,
    intent_path: PathBuf,
    stop_fails: Cell<bool>,
    ready: Cell<bool>,
}

impl Fake {
    fn new(intent_path: PathBuf) -> Self {
        Self {
            units: RefCell::new(BTreeMap::new()),
            launches: Cell::new(0),
            intent_path,
            stop_fails: Cell::new(false),
            ready: Cell::new(true),
        }
    }
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
    fn shell_until(&self, _: &Job, _: &str, _: Deadline) -> Result<()> {
        Ok(())
    }
    fn status_until(&self, _: &Job, _: &str, _: Deadline) -> Result<bool> {
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
    fn healthy_until(&self, _: &Job, _: Deadline) -> bool {
        self.ready.get()
    }
}

fn deadline() -> Deadline {
    Deadline::new(Duration::from_secs(5))
}

#[test]
fn durable_intent_dedup_reload_and_a_failed_then_good_stop() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path.clone()).expect("load");
    let start = job(JobPhase::Start);
    assert_eq!(
        executor.execute(start.clone(), &runtime, deadline()).status,
        JobStatus::Succeeded
    );
    assert_eq!(runtime.launches.get(), 1);
    // A re-delivered start (new connection) answers from history.
    let mut executor = Executor::load(path).expect("restart");
    let mut retry = start.clone();
    retry.owner_epoch = "new-epoch".into();
    assert_eq!(
        executor.execute(retry, &runtime, deadline()).status,
        JobStatus::Succeeded
    );
    assert_eq!(runtime.launches.get(), 1);
    assert_eq!(
        executor
            .execute(job(JobPhase::Readiness), &runtime, deadline())
            .status,
        JobStatus::Succeeded
    );
    let observed = executor.observations(&runtime, deadline());
    assert_eq!(observed[0].1.phase, InstancePhase::Ready);
    assert_eq!(observed[0].1.models, ["m"]);
    runtime.stop_fails.set(true);
    let failed = executor.execute(job(JobPhase::Stop), &runtime, deadline());
    assert_eq!(failed.status, JobStatus::Failed);
    assert_eq!(failed.error, Some(JobError::CommandFailed));
    assert!(!failed.stopped);
    runtime.stop_fails.set(false);
    let stopped = executor.execute(job(JobPhase::Stop), &runtime, deadline());
    assert!(stopped.stopped);
    assert_eq!(
        executor.observations(&runtime, deadline())[0].1.phase,
        InstancePhase::Stopped
    );
}

#[test]
fn steps_for_an_unknown_instance_are_refused_and_leave_nothing() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path.clone()).expect("load");
    for phase in [
        JobPhase::Stop,
        JobPhase::Readiness,
        JobPhase::Health,
        JobPhase::Status,
    ] {
        assert_eq!(
            executor.execute(job(phase), &runtime, deadline()).error,
            Some(JobError::InstanceUnknown)
        );
    }
    assert!(!path.exists());
}

#[test]
fn health_hysteresis_marks_unhealthy_then_ready() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    runtime.ready.set(false);
    for index in 0..2 {
        let mut health = job(JobPhase::Health);
        health.step_id = format!("h{index}");
        assert_eq!(
            executor.execute(health, &runtime, deadline()).error,
            Some(JobError::HealthFailed)
        );
    }
    assert_eq!(
        executor.observations(&runtime, deadline())[0].1.phase,
        InstancePhase::Unhealthy
    );
    runtime.ready.set(true);
    let mut health = job(JobPhase::Health);
    health.step_id = "h9".into();
    assert_eq!(
        executor.execute(health, &runtime, deadline()).status,
        JobStatus::Succeeded
    );
    assert_eq!(
        executor.observations(&runtime, deadline())[0].1.phase,
        InstancePhase::Ready
    );
}

#[test]
fn a_prepare_without_a_command_runs_nothing() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    let outcome = executor.execute(job(JobPhase::Prepare), &runtime, deadline());
    assert_eq!(outcome.status, JobStatus::Succeeded);
    assert_eq!(runtime.launches.get(), 0);
}

#[test]
fn an_expired_deadline_is_a_job_deadline() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    let outcome = executor.execute(
        job(JobPhase::Start),
        &runtime,
        Deadline::new(Duration::from_millis(0)),
    );
    assert_eq!(outcome.error, Some(JobError::JobDeadline));
}

#[test]
fn missing_secrets_are_named_never_valued() {
    let mut needs = job(JobPhase::Start);
    needs.secrets = vec!["WSMP_SECRET_DEFINITELY_NOT_SET_7F3A".into()];
    let error = command_env(&needs).expect_err("missing");
    let text = format!("{error:#}");
    assert!(
        text.contains("WSMP_SECRET_DEFINITELY_NOT_SET_7F3A"),
        "{text}"
    );
}

#[test]
fn commands_see_only_the_ranks_gpus() {
    let mut placed = job(JobPhase::Start);
    assert!(command_env(&placed).expect("env").is_empty());
    placed.gpu_ids = Some("0,3".into());
    let env = command_env(&placed).expect("env");
    assert_eq!(
        env,
        vec![
            ("CUDA_VISIBLE_DEVICES".to_string(), "0,3".to_string()),
            ("HIP_VISIBLE_DEVICES".to_string(), "0,3".to_string()),
        ]
    );
    // Persisted records written before the field still load.
    let mut stored = serde_json::to_value(job(JobPhase::Start)).expect("json");
    stored.as_object_mut().expect("object").remove("gpuIds");
    let loaded: Job = serde_json::from_value(stored).expect("old record");
    assert_eq!(loaded.gpu_ids, None);
}

/// A Runtime whose status/health can fail with an error (unknown).
struct Flaky {
    inner: Fake,
    erroring: Cell<bool>,
}

impl Runtime for Flaky {
    fn launch(&self, job: &Job, owner: &str, unit: &str, deadline: Deadline) -> Result<String> {
        self.inner.launch(job, owner, unit, deadline)
    }
    fn identity(&self, unit: &str, owner: &str, deadline: Deadline) -> Result<Option<String>> {
        anyhow::ensure!(!self.erroring.get(), "manager timed out");
        self.inner.identity(unit, owner, deadline)
    }
    fn shell_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<()> {
        self.inner.shell_until(job, command, deadline)
    }
    fn status_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<bool> {
        self.inner.status_until(job, command, deadline)
    }
    fn stop(&self, unit: &str, owner: &str, invocation: &str, deadline: Deadline) -> Result<()> {
        self.inner.stop(unit, owner, invocation, deadline)
    }
    fn healthy_until(&self, job: &Job, deadline: Deadline) -> bool {
        self.inner.healthy_until(job, deadline)
    }
}

#[test]
fn a_check_that_errored_does_not_block_the_next_check() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Flaky {
        inner: Fake::new(path.clone()),
        erroring: Cell::new(false),
    };
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    runtime.erroring.set(true);
    let mut first = job(JobPhase::Health);
    first.step_id = "h1".into();
    assert_eq!(
        executor.execute(first, &runtime, deadline()).status,
        JobStatus::Failed
    );
    runtime.erroring.set(false);
    let mut second = job(JobPhase::Health);
    second.step_id = "h2".into();
    assert_eq!(
        executor.execute(second, &runtime, deadline()).status,
        JobStatus::Succeeded
    );
}

#[test]
fn a_prepare_cannot_swap_the_identity_of_a_running_instance() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    let mut prepare = job(JobPhase::Prepare);
    prepare.port = 40000;
    prepare.version_id = "vr2".into();
    prepare.command = "true".into();
    assert_eq!(
        executor.execute(prepare, &runtime, deadline()).status,
        JobStatus::Failed
    );
    assert_eq!(executor.observations(&runtime, deadline())[0].1.port, 30001);
}

#[test]
fn a_missing_secret_refuses_a_launch_before_anything_is_recorded() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path.clone()).expect("load");
    let mut start = job(JobPhase::Start);
    start.secrets = vec!["WSMP_SECRET_DEFINITELY_NOT_SET_7F3B".into()];
    assert_eq!(
        executor.execute(start, &runtime, deadline()).error,
        Some(JobError::LocalConfigUnavailable)
    );
    assert_eq!(runtime.launches.get(), 0);
    assert!(!path.exists());
}
