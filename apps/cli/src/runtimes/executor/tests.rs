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
        dist_port: None,
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
    /// Units whose process tree still has a task (launched units count unless stopped).
    orphans: RefCell<Vec<String>>,
    port_busy: Cell<bool>,
    /// Single ports something listens on.
    busy_ports: RefCell<Vec<u16>>,
    /// Slices the executor let the manager forget.
    forgotten: RefCell<Vec<String>>,
    /// Slices a stop ended.
    slice_stops: RefCell<Vec<String>>,
    /// A process of the slice survives a stop of the slice.
    slice_survives: Cell<bool>,
    /// What the status command answers: alive, stopped, or (None) an error.
    status_alive: Cell<Option<bool>>,
    /// Whether the user manager errors when asked for a unit's tasks.
    tasks_unknown: Cell<bool>,
    /// Once the port answers, the start unit has no task left (a start that
    /// handed its server off, like `docker compose up -d`).
    detach_on_probe: Cell<bool>,
    /// The start unit's main process exited with status 0.
    exited_cleanly: Cell<bool>,
    /// Whether the runtime holds a rank in units and a slice (systemd); false is a node
    /// without units (macOS), whatever platform the tests run on.
    contains_ranks: Cell<bool>,
}

impl Fake {
    fn new(intent_path: PathBuf) -> Self {
        Self {
            units: RefCell::new(BTreeMap::new()),
            launches: Cell::new(0),
            intent_path,
            stop_fails: Cell::new(false),
            ready: Cell::new(true),
            orphans: RefCell::new(Vec::new()),
            port_busy: Cell::new(false),
            busy_ports: RefCell::new(Vec::new()),
            forgotten: RefCell::new(Vec::new()),
            slice_stops: RefCell::new(Vec::new()),
            slice_survives: Cell::new(false),
            status_alive: Cell::new(None),
            tasks_unknown: Cell::new(false),
            detach_on_probe: Cell::new(false),
            exited_cleanly: Cell::new(false),
            contains_ranks: Cell::new(true),
        }
    }
}

impl Runtime for Fake {
    fn contains_ranks(&self) -> bool {
        self.contains_ranks.get()
    }
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
        self.status_alive.get().context("unknown")
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
    fn healthy_until(&self, _: &Job, _: Deadline) -> std::result::Result<(), HealthMiss> {
        if self.detach_on_probe.get() {
            self.units.borrow_mut().clear();
        }
        if self.ready.get() {
            Ok(())
        } else {
            Err(HealthMiss::Http(503))
        }
    }
    fn tasks_alive(&self, unit: &str, _: Deadline) -> Result<bool> {
        anyhow::ensure!(!self.tasks_unknown.get(), "the user manager did not answer");
        Ok(self.units.borrow().contains_key(unit)
            || self.orphans.borrow().iter().any(|orphan| orphan == unit))
    }
    fn port_free(&self, _: &str, port: u16) -> bool {
        !self.port_busy.get() && !self.busy_ports.borrow().contains(&port)
    }
    fn exited_cleanly(&self, _: &str, _: Deadline) -> Result<bool> {
        Ok(self.exited_cleanly.get())
    }
    fn port_answers(&self, _: &str, _: u16) -> bool {
        self.ready.get()
    }
    fn forget_slice(&self, slice: &str, _: Deadline) {
        self.forgotten.borrow_mut().push(slice.into());
    }
    fn stop_slice(&self, slice: &str, _: Deadline) -> Result<()> {
        self.slice_stops.borrow_mut().push(slice.into());
        anyhow::ensure!(!self.slice_survives.get(), "a process survived SIGKILL");
        self.orphans.borrow_mut().retain(|orphan| orphan != slice);
        Ok(())
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
    for phase in [JobPhase::Readiness, JobPhase::Health] {
        assert_eq!(
            executor.execute(job(phase), &runtime, deadline()).error,
            Some(JobError::InstanceUnknown)
        );
    }
    // A stop without a record is refused while something of the rank runs...
    runtime
        .orphans
        .borrow_mut()
        .push("wsmp-i-abcdefabcdef-r0".into());
    assert_eq!(
        executor
            .execute(job(JobPhase::Stop), &runtime, deadline())
            .error,
        Some(JobError::InstanceUnknown)
    );
    // ...and proven when nothing does (a restart's leading stop after a lost record).
    runtime.orphans.borrow_mut().clear();
    let proven = executor.execute(job(JobPhase::Stop), &runtime, deadline());
    assert_eq!(
        (proven.status, proven.stopped),
        (JobStatus::Succeeded, true)
    );
    assert!(!path.exists());
}

#[test]
fn a_stop_whose_process_is_already_gone_is_proven_although_the_unit_stop_fails() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    // The unit stop errors (say the unit was relaunched under another invocation), but no
    // process of it is left.
    runtime.stop_fails.set(true);
    runtime.units.borrow_mut().clear();
    let stopped = executor.execute(job(JobPhase::Stop), &runtime, deadline());
    assert_eq!(
        (stopped.status, stopped.stopped),
        (JobStatus::Succeeded, true)
    );
}

#[test]
fn a_status_probe_proves_a_stop_the_stops_could_not() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path.clone()).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    // The stop cannot stop the unit (say it was relaunched under another invocation).
    runtime.stop_fails.set(true);
    let failed = executor.execute(job(JobPhase::Stop), &runtime, deadline());
    assert_eq!(failed.status, JobStatus::Failed);
    // While the unit still has a task, or the port is taken, nothing is proven.
    let mut probe = job(JobPhase::Status);
    probe.step_id = "s1".into();
    let alive = executor.execute(probe, &runtime, deadline());
    assert_eq!((alive.status, alive.stopped), (JobStatus::Succeeded, false));
    // Each unproven answer says why, so a person sees why the claim stays held.
    assert_eq!(alive.detail.as_deref(), Some("process_alive"));
    runtime.units.borrow_mut().clear();
    runtime.port_busy.set(true);
    let mut probe = job(JobPhase::Status);
    probe.step_id = "s2".into();
    let busy = executor.execute(probe, &runtime, deadline());
    assert!(!busy.stopped);
    assert_eq!(busy.detail.as_deref(), Some("port_in_use"));
    // The process tree is gone and the port is free: proven, and the record resolves.
    runtime.port_busy.set(false);
    let mut probe = job(JobPhase::Status);
    probe.step_id = "s3".into();
    let proven = executor.execute(probe, &runtime, deadline());
    assert_eq!(
        (proven.status, proven.stopped),
        (JobStatus::Succeeded, true)
    );
    assert_eq!(proven.detail, None);
    assert_eq!(
        executor.observations(&runtime, deadline())[0].1.phase,
        InstancePhase::Stopped
    );
    // A later stop (the unresolved one was resolved by the proof) answers stopped too.
    runtime.stop_fails.set(false);
    let mut stop = job(JobPhase::Stop);
    stop.step_id = "stop-2".into();
    assert!(executor.execute(stop, &runtime, deadline()).stopped);
}

#[test]
fn a_status_probe_proves_a_stop_without_a_record_and_writes_nothing() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path.clone()).expect("load");
    runtime
        .orphans
        .borrow_mut()
        .push("wsmp-i-abcdefabcdef-r0".into());
    assert!(
        !executor
            .execute(job(JobPhase::Status), &runtime, deadline())
            .stopped
    );
    runtime.orphans.borrow_mut().clear();
    let proven = executor.execute(job(JobPhase::Status), &runtime, deadline());
    assert_eq!(
        (proven.status, proven.stopped),
        (JobStatus::Succeeded, true)
    );
    assert!(!path.exists());
}

#[test]
fn a_detached_service_is_proven_stopped_only_by_its_status() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    // The run is a service the node does not own (no unit to watch).
    executor
        .state
        .records
        .get_mut("in1:0")
        .expect("record")
        .invocations
        .insert("wsmp-i-abcdefabcdef-r0".into(), "external".into());
    runtime.units.borrow_mut().clear();
    let mut probe = job(JobPhase::Status);
    probe.step_id = "s1".into();
    assert!(!executor.execute(probe, &runtime, deadline()).stopped);
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

// The result frame comes from the runner, which is Unix-only.
#[cfg(unix)]
#[test]
fn a_failed_health_probe_says_why() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    runtime.ready.set(false);
    let mut health = job(JobPhase::Health);
    health.step_id = "h1".into();
    let outcome = executor.execute(health, &runtime, deadline());
    assert_eq!(
        (outcome.error, outcome.detail.as_deref()),
        (Some(JobError::HealthFailed), Some("http_503"))
    );
    // The unit has no task left: the serving process is unconfirmed, and it
    // counts as one more failed probe rather than an error.
    runtime.units.borrow_mut().clear();
    let mut health = job(JobPhase::Health);
    health.step_id = "h2".into();
    let outcome = executor.execute(health, &runtime, deadline());
    assert_eq!(
        (outcome.error, outcome.detail.as_deref()),
        (Some(JobError::HealthFailed), Some("serving_unconfirmed"))
    );
    assert_eq!(
        executor.state.records["in1:0"].consecutive_health_failures,
        2
    );
    // The detail travels in the result frame.
    let frame = crate::runtimes::runner::result_frame(&job(JobPhase::Health), &outcome);
    let text = serde_json::to_string(&frame).expect("frame");
    assert!(text.contains(r#""detail":"serving_unconfirmed""#), "{text}");
}

/// A probe that uses up all the time it is given.
struct Stalling {
    inner: Fake,
}

impl Runtime for Stalling {
    fn contains_ranks(&self) -> bool {
        self.inner.contains_ranks()
    }
    fn launch(&self, job: &Job, owner: &str, unit: &str, deadline: Deadline) -> Result<String> {
        self.inner.launch(job, owner, unit, deadline)
    }
    fn identity(&self, unit: &str, owner: &str, deadline: Deadline) -> Result<Option<String>> {
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
    fn healthy_until(&self, _: &Job, deadline: Deadline) -> std::result::Result<(), HealthMiss> {
        while deadline.remaining().is_ok() {
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(HealthMiss::Timeout)
    }
    fn tasks_alive(&self, unit: &str, deadline: Deadline) -> Result<bool> {
        self.inner.tasks_alive(unit, deadline)
    }
    fn port_free(&self, host: &str, port: u16) -> bool {
        self.inner.port_free(host, port)
    }
}

#[test]
fn a_stalled_health_probe_answers_timeout_within_its_deadline() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Stalling {
        inner: Fake::new(path.clone()),
    };
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    let mut health = job(JobPhase::Health);
    health.step_id = "h1".into();
    let outcome = executor.execute(health, &runtime, Deadline::new(Duration::from_secs(3)));
    assert_eq!(
        (outcome.error, outcome.detail.as_deref()),
        (Some(JobError::HealthFailed), Some("timeout"))
    );
}

#[test]
fn health_miss_details_are_plain_codes() {
    for (miss, detail) in [
        (HealthMiss::ServingUnconfirmed, "serving_unconfirmed"),
        (HealthMiss::Http(502), "http_502"),
        (HealthMiss::ConnectRefused, "connect_refused"),
        (HealthMiss::Timeout, "timeout"),
        (HealthMiss::Unreachable, "unreachable"),
        (HealthMiss::CommandFailed, "command_failed"),
        (HealthMiss::StatusNotRunning, "status_not_running"),
    ] {
        assert_eq!(miss.detail(), detail);
    }
}

#[test]
fn a_process_start_that_hands_its_server_off_fails_detached() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    runtime.detach_on_probe.set(true);
    runtime.exited_cleanly.set(true);
    let outcome = executor.execute(job(JobPhase::Readiness), &runtime, deadline());
    assert_eq!(outcome.error, Some(JobError::ProcessDetached));
    assert_ne!(
        executor.observations(&runtime, deadline())[0].1.phase,
        InstancePhase::Ready
    );
}

#[test]
fn a_process_start_already_handed_off_at_readiness_fails_detached() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    // The start unit emptied before readiness began (its command exited 0), and the port
    // answers.
    runtime.units.borrow_mut().clear();
    runtime.exited_cleanly.set(true);
    let outcome = executor.execute(job(JobPhase::Readiness), &runtime, deadline());
    assert_eq!(outcome.error, Some(JobError::ProcessDetached));
    // Nothing answers either: an ordinary readiness failure, at once.
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    runtime.units.borrow_mut().clear();
    runtime.ready.set(false);
    let outcome = executor.execute(job(JobPhase::Readiness), &runtime, deadline());
    assert_eq!(outcome.error, Some(JobError::ReadinessFailed));
}

#[test]
fn a_process_that_crashes_after_answering_is_not_a_hand_off() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(job(JobPhase::Start), &runtime, deadline());
    // The server answered once, then died (a crash or an OOM kill, not an exit 0).
    runtime.detach_on_probe.set(true);
    let outcome = executor.execute(job(JobPhase::Readiness), &runtime, deadline());
    assert_eq!(outcome.error, Some(JobError::ReadinessFailed));
}

#[test]
fn a_service_start_may_hand_its_server_off() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    let service = |phase| {
        let mut job = job(phase);
        job.spec["launch"]["management"] = "service".into();
        job.status_command = Some("true".into());
        job
    };
    executor.execute(service(JobPhase::Start), &runtime, deadline());
    // A service's serving process is proven by its status command, not its unit.
    runtime.status_alive.set(Some(true));
    runtime.detach_on_probe.set(true);
    assert_eq!(
        executor
            .execute(service(JobPhase::Readiness), &runtime, deadline())
            .status,
        JobStatus::Succeeded
    );
}

#[test]
fn a_process_stop_without_a_stop_command_is_the_slice_kill_and_the_proof() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    let without = |phase| {
        let mut job = job(phase);
        job.stop_command = String::new();
        job.spec["launch"]["commands"][0]
            .as_object_mut()
            .expect("commands")
            .remove("stop");
        job
    };
    executor.execute(without(JobPhase::Start), &runtime, deadline());
    let stopped = executor.execute(without(JobPhase::Stop), &runtime, deadline());
    assert!(stopped.stopped, "{stopped:?}");
    assert_eq!(
        runtime.slice_stops.borrow().as_slice(),
        ["wsmp_i_abcdefabcdef_r0.slice"]
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
            ("CUDA_DEVICE_ORDER".to_string(), "PCI_BUS_ID".to_string()),
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
    fn contains_ranks(&self) -> bool {
        self.inner.contains_ranks()
    }
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
    fn healthy_until(&self, job: &Job, deadline: Deadline) -> std::result::Result<(), HealthMiss> {
        self.inner.healthy_until(job, deadline)
    }
    fn tasks_alive(&self, unit: &str, deadline: Deadline) -> Result<bool> {
        anyhow::ensure!(!self.erroring.get(), "manager timed out");
        self.inner.tasks_alive(unit, deadline)
    }
    fn port_free(&self, host: &str, port: u16) -> bool {
        self.inner.port_free(host, port)
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

#[test]
fn a_status_probe_whose_status_command_cannot_tell_says_so() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    // A service (no record: it may run outside the node's units) is proven by its status.
    let mut probe = service(job(JobPhase::Status));
    probe.status_command = Some("systemctl is-active llm".into());
    let unproven = executor.execute(probe, &runtime, deadline());
    assert_eq!(
        (unproven.status, unproven.stopped),
        (JobStatus::Succeeded, false)
    );
    assert_eq!(unproven.detail.as_deref(), Some("status_unknown"));
}

/// `job` for a runtime with `management: "service"`.
fn service(mut job: Job) -> Job {
    job.spec["launch"]["management"] = "service".into();
    job
}

/// `job` whose stop, status and health commands are all the stub `true` (status exit 0 says
/// "alive" forever), as the QA runtime that left two ranks held on spark-1958.
fn stubbed(mut job: Job) -> Job {
    job.stop_command = "true".into();
    job.status_command = Some("true".into());
    job.health_command = Some("true".into());
    job
}

#[test]
fn a_stop_whose_command_exits_at_once_completes_although_status_says_alive() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    runtime.status_alive.set(Some(true));
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    let started = Instant::now();
    let stopped = executor.execute(stubbed(job(JobPhase::Stop)), &runtime, deadline());
    assert_eq!(
        (stopped.status, stopped.stopped),
        (JobStatus::Succeeded, true)
    );
    // Proven from the node's own observations, not after the step's deadline.
    assert!(started.elapsed() < Duration::from_secs(2));
    // A re-delivery of the verified stop answers it again.
    let again = executor.execute(stubbed(job(JobPhase::Stop)), &runtime, deadline());
    assert!(again.stopped);
}

#[test]
fn a_stop_is_never_proven_while_its_unit_runs_or_its_port_is_taken() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    // The status command says stopped: that never overrides what the node observes.
    runtime.status_alive.set(Some(false));
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    runtime
        .orphans
        .borrow_mut()
        .push("wsmp-i-abcdefabcdef-r0".into());
    let short = Deadline::new(Duration::from_millis(1_200));
    let alive = executor.execute(stubbed(job(JobPhase::Stop)), &runtime, short);
    assert_eq!((alive.status, alive.stopped), (JobStatus::Failed, false));
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p1".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("process_alive")
    );
    runtime.orphans.borrow_mut().clear();
    runtime.port_busy.set(true);
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p2".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("port_in_use")
    );
    // The user manager cannot say whether a task is left: unproven, saying so.
    runtime.port_busy.set(false);
    runtime.tasks_unknown.set(true);
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p3".into();
    let unknown = executor.execute(probe, &runtime, deadline());
    assert_eq!(
        (unknown.status, unknown.stopped, unknown.detail.as_deref()),
        (JobStatus::Succeeded, false, Some("process_unknown"))
    );
}

/// The state spark-1958 was left in (launched by an older CLI, so a legacy record and no rank
/// slice): the stop of a `process` run whose commands are all `true` failed
/// at its deadline (status kept saying alive), the instance was marked stopped and settled
/// STOPPED, and the rank stays HELD_UNKNOWN. Its unit is gone and its port is free: the next
/// automatic check proves the stop, so the server releases the claim.
#[test]
fn a_rank_marked_stopped_whose_status_is_a_stub_is_proven_once_its_process_is_gone() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    runtime.status_alive.set(Some(true));
    let mut executor = Executor::load(path.clone()).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    // What the earlier node left on disk: the stop still pending, the unit still recorded.
    {
        let record = executor.state.records.get_mut("in1:0").expect("record");
        record.pending = Some(stubbed(job(JobPhase::Stop)));
        record.phase = InstancePhase::Stopping;
    }
    executor.persist().expect("persist");
    // Written by the older CLI that launched it: no `outside_units`, no dist port, and its
    // commands never ran in a rank slice (the slice does not exist: nothing in it).
    let mut stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
    for record in stored["records"]
        .as_object_mut()
        .expect("records")
        .values_mut()
    {
        let record = record.as_object_mut().expect("record");
        assert!(record.remove("outside_units").is_some());
        assert!(record["job"].get("distPort").is_none());
    }
    std::fs::write(&path, serde_json::to_vec(&stored).expect("json")).expect("write");
    // The unit is gone (`systemctl stop` ran), nothing listens on the port.
    runtime.units.borrow_mut().clear();
    let mut executor = Executor::load(path).expect("reload");
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "status-1".into();
    let proven = executor.execute(probe, &runtime, deadline());
    assert_eq!(
        (proven.status, proven.stopped, proven.detail),
        (JobStatus::Succeeded, true, None)
    );
    assert_eq!(
        executor.observations(&runtime, deadline())[0].1.phase,
        InstancePhase::Stopped
    );
}

#[test]
fn a_run_outside_the_nodes_units_needs_its_status_to_say_stopped() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    // A person started it in an operator terminal: no unit of the node holds it.
    executor
        .state
        .records
        .get_mut("in1:0")
        .expect("record")
        .invocations
        .insert("wsmp-i-abcdefabcdef-r0".into(), "external".into());
    runtime.units.borrow_mut().clear();
    runtime.status_alive.set(Some(true));
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p1".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("status_running")
    );
    runtime.status_alive.set(Some(false));
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p2".into();
    assert!(executor.execute(probe, &runtime, deadline()).stopped);
}

#[test]
fn a_service_whose_unit_is_empty_still_needs_its_status_to_say_stopped() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(service(stubbed(job(JobPhase::Start))), &runtime, deadline());
    // The start handed off (docker run -d): the unit has no task, the port is not bound yet.
    runtime.units.borrow_mut().clear();
    runtime.status_alive.set(Some(true));
    let short = Deadline::new(Duration::from_millis(1_200));
    let stop = executor.execute(service(stubbed(job(JobPhase::Stop))), &runtime, short);
    assert_eq!((stop.status, stop.stopped), (JobStatus::Failed, false));
    let mut probe = service(stubbed(job(JobPhase::Status)));
    probe.step_id = "p1".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("status_running")
    );
    runtime.status_alive.set(Some(false));
    let mut probe = service(stubbed(job(JobPhase::Status)));
    probe.step_id = "p2".into();
    assert!(executor.execute(probe, &runtime, deadline()).stopped);
}

#[test]
fn a_prepare_a_person_ran_keeps_the_status_requirement() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    runtime.status_alive.set(Some(true));
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    // A prepare run in an operator terminal may leave a helper outside the node's units.
    executor
        .state
        .records
        .get_mut("in1:0")
        .expect("record")
        .invocations
        .insert("wsmp-i-abcdefabcdef-r0-prepare".into(), "external".into());
    runtime.units.borrow_mut().clear();
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p1".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("status_running")
    );
    runtime.status_alive.set(Some(false));
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p2".into();
    assert!(executor.execute(probe, &runtime, deadline()).stopped);
    // The run's stop cleared its units, but a later check still asks the status command.
    runtime.status_alive.set(Some(true));
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p3".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("status_running")
    );
}

#[test]
fn a_stop_ends_what_its_command_left_in_the_ranks_slice() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    // The stop command forked a `setsid` daemon: the stop ends the slice, then proves it.
    runtime
        .orphans
        .borrow_mut()
        .push("wsmp_i_abcdefabcdef_r0.slice".into());
    let stop = executor.execute(stubbed(job(JobPhase::Stop)), &runtime, deadline());
    assert_eq!((stop.status, stop.stopped), (JobStatus::Succeeded, true));
    assert_eq!(
        *runtime.slice_stops.borrow(),
        vec!["wsmp_i_abcdefabcdef_r0.slice".to_string()]
    );
}

#[test]
fn a_process_that_survives_the_slice_stop_keeps_the_stop_unproven() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    runtime
        .orphans
        .borrow_mut()
        .push("wsmp_i_abcdefabcdef_r0.slice".into());
    runtime.slice_survives.set(true);
    let short = Deadline::new(Duration::from_millis(1_200));
    let stop = executor.execute(stubbed(job(JobPhase::Stop)), &runtime, short);
    assert_eq!((stop.status, stop.stopped), (JobStatus::Failed, false));
    // A status probe kills nothing: it only says why.
    let stops = runtime.slice_stops.borrow().len();
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p1".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("process_alive")
    );
    assert_eq!(runtime.slice_stops.borrow().len(), stops);
    // Gone later (a person ended it): the next probe proves the stop.
    runtime.orphans.borrow_mut().clear();
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p2".into();
    assert!(executor.execute(probe, &runtime, deadline()).stopped);
}

#[test]
fn a_re_delivered_stop_is_proven_again_before_it_answers_stopped() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    assert!(
        executor
            .execute(stubbed(job(JobPhase::Stop)), &runtime, deadline())
            .stopped
    );
    // Something bound the port since: the recorded answer is not repeated, and says why.
    runtime.busy_ports.borrow_mut().push(30001);
    let again = executor.execute(stubbed(job(JobPhase::Stop)), &runtime, deadline());
    assert_eq!(
        (again.stopped, again.detail.as_deref()),
        (false, Some("port_in_use"))
    );
    runtime.busy_ports.borrow_mut().clear();
    assert!(
        executor
            .execute(stubbed(job(JobPhase::Stop)), &runtime, deadline())
            .stopped
    );
}

#[test]
fn the_inventory_reports_stopped_only_while_the_stop_is_proven() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    executor.execute(stubbed(job(JobPhase::Stop)), &runtime, deadline());
    let phase = |executor: &Executor| executor.observations(&runtime, deadline())[0].1.phase;
    assert_eq!(phase(&executor), InstancePhase::Stopped);
    // Empty units alone are no proof (the server releases a claim on `stopped`).
    runtime.busy_ports.borrow_mut().push(30001);
    assert_eq!(phase(&executor), InstancePhase::Unknown);
    runtime.busy_ports.borrow_mut().clear();
    runtime
        .orphans
        .borrow_mut()
        .push("wsmp_i_abcdefabcdef_r0.slice".into());
    assert_eq!(phase(&executor), InstancePhase::Unknown);
}

#[test]
fn a_held_dist_port_keeps_the_stop_unproven() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    let with_dist = |phase: JobPhase| {
        let mut job = stubbed(job(phase));
        job.dist_port = Some(30002);
        job
    };
    executor.execute(with_dist(JobPhase::Start), &runtime, deadline());
    runtime.units.borrow_mut().clear();
    runtime.busy_ports.borrow_mut().push(30002);
    let mut probe = with_dist(JobPhase::Status);
    probe.step_id = "p1".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("port_in_use")
    );
    // A probe rendered without it still checks the launched run's dist port.
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p2".into();
    assert_eq!(
        executor
            .execute(probe, &runtime, deadline())
            .detail
            .as_deref(),
        Some("port_in_use")
    );
    runtime.busy_ports.borrow_mut().clear();
    let mut probe = with_dist(JobPhase::Status);
    probe.step_id = "p3".into();
    assert!(executor.execute(probe, &runtime, deadline()).stopped);
}

#[test]
fn a_ranks_slice_is_flat_and_forgotten_only_once_proven_empty() {
    assert_eq!(
        rank_slice(&job(JobPhase::Stop)),
        "wsmp_i_abcdefabcdef_r0.slice"
    );
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    runtime
        .orphans
        .borrow_mut()
        .push("wsmp_i_abcdefabcdef_r0.slice".into());
    runtime.slice_survives.set(true);
    let short = Deadline::new(Duration::from_millis(600));
    assert!(
        !executor
            .execute(stubbed(job(JobPhase::Stop)), &runtime, short)
            .stopped
    );
    assert!(runtime.forgotten.borrow().is_empty());
    runtime.orphans.borrow_mut().clear();
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p1".into();
    assert!(executor.execute(probe, &runtime, deadline()).stopped);
    assert_eq!(
        *runtime.forgotten.borrow(),
        vec!["wsmp_i_abcdefabcdef_r0.slice".to_string()]
    );
}

#[test]
fn a_new_run_forgets_that_an_earlier_one_ran_outside_the_units() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    runtime.status_alive.set(Some(false));
    let mut executor = Executor::load(path).expect("load");
    executor.execute(stubbed(job(JobPhase::Start)), &runtime, deadline());
    executor
        .state
        .records
        .get_mut("in1:0")
        .expect("record")
        .invocations
        .insert("wsmp-i-abcdefabcdef-r0-prepare".into(), "external".into());
    assert!(
        executor
            .execute(stubbed(job(JobPhase::Stop)), &runtime, deadline())
            .stopped
    );
    assert!(executor.state.records["in1:0"].outside_units);
    // The next run starts with its start (no prepare): nothing of it ran outside the units.
    runtime.status_alive.set(Some(true));
    let mut start = stubbed(job(JobPhase::Start));
    start.step_id = "start-2".into();
    executor.execute(start, &runtime, deadline());
    assert!(!executor.state.records["in1:0"].outside_units);
    runtime.units.borrow_mut().clear();
    let mut probe = stubbed(job(JobPhase::Status));
    probe.step_id = "p1".into();
    assert!(executor.execute(probe, &runtime, deadline()).stopped);
}

/// A node without units (macOS): its stops rest on the status command and the ports,
/// never on units that never held anything, and each unproven answer says which fact failed.
#[test]
fn a_node_without_units_proves_a_stop_by_its_status_and_its_ports() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("in1-r0.json");
    let runtime = Fake::new(path.clone());
    runtime.contains_ranks.set(false);
    let mut executor = Executor::load(path.clone()).expect("load");
    let probe = |step: &str, status: Option<&str>| {
        let mut probe = job(JobPhase::Status);
        probe.step_id = step.into();
        probe.status_command = status.map(str::to_string);
        probe.dist_port = Some(30002);
        probe
    };
    let detail = |outcome: Outcome| (outcome.stopped, outcome.detail);
    // Nothing runs in any unit, yet a run without a status command can never be proven.
    assert_eq!(
        detail(executor.execute(probe("p1", None), &runtime, deadline())),
        (false, Some("unowned_service".into()))
    );
    let status = Some("systemctl is-active llm");
    assert_eq!(
        detail(executor.execute(probe("p2", status), &runtime, deadline())),
        (false, Some("status_unknown".into()))
    );
    runtime.status_alive.set(Some(true));
    assert_eq!(
        detail(executor.execute(probe("p3", status), &runtime, deadline())),
        (false, Some("status_running".into()))
    );
    // Status exit 3 is half the proof: a held port (the dist port too) keeps it unproven.
    runtime.status_alive.set(Some(false));
    runtime.busy_ports.borrow_mut().push(30002);
    assert_eq!(
        detail(executor.execute(probe("p4", status), &runtime, deadline())),
        (false, Some("port_in_use".into()))
    );
    // The inventory runs no status command, but still names a held port.
    let rank = probe("p5", status);
    assert_eq!(
        executor
            .stop_unproven_now(&rank, &runtime, deadline())
            .expect("proof"),
        Some("port_in_use")
    );
    runtime.busy_ports.borrow_mut().clear();
    assert_eq!(
        executor
            .stop_unproven_now(&rank, &runtime, deadline())
            .expect("proof"),
        Some("status_unknown")
    );
    assert_eq!(
        detail(executor.execute(probe("p6", status), &runtime, deadline())),
        (true, None)
    );
    assert!(!path.exists());
}
