//! The executor's interactive (operator) path: status first, a durable
//! pending step before any terminal, proof after the person's run.

use super::*;
use std::cell::{Cell, RefCell};

fn golden(name: &str) -> Job {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/relay-current/deployment-jobs.json"
    ))
    .expect("golden JSON");
    serde_json::from_value(golden["jobs"][name].clone()).expect(name)
}

/// A runtime whose status the test sets (`None`: the check fails), and
/// which records every shell command and launch.
struct Operated {
    status: Cell<Option<bool>>,
    /// Status reads as not alive for this many probes, then as `status`.
    starting_probes: Cell<u32>,
    /// macOS-like: a launch is "completed" when status says alive.
    mac_like: Cell<bool>,
    stop_fails: Cell<bool>,
    status_checks: Cell<u32>,
    shells: RefCell<Vec<String>>,
    launches: Cell<u32>,
    units: RefCell<BTreeMap<String, String>>,
}

impl Operated {
    fn new(status: Option<bool>) -> Self {
        Self {
            status: Cell::new(status),
            starting_probes: Cell::new(0),
            mac_like: Cell::new(false),
            stop_fails: Cell::new(false),
            status_checks: Cell::new(0),
            shells: RefCell::new(Vec::new()),
            launches: Cell::new(0),
            units: RefCell::new(BTreeMap::new()),
        }
    }
}

impl Runtime for Operated {
    fn launch(&self, _: &Job, _: &str, unit: &str, _: Deadline) -> Result<String> {
        self.launches.set(self.launches.get() + 1);
        self.units
            .borrow_mut()
            .insert(unit.into(), "invocation".into());
        Ok("invocation".into())
    }
    fn identity(&self, unit: &str, _: &str, _: Deadline) -> Result<Option<String>> {
        Ok(self.units.borrow().get(unit).cloned())
    }
    fn shell(&self, command: &str, _: Duration) -> Result<()> {
        self.shells.borrow_mut().push(command.into());
        Ok(())
    }
    fn status(&self, _: &str, _: Duration) -> Result<bool> {
        self.status_checks.set(self.status_checks.get() + 1);
        if self.starting_probes.get() > 0 {
            self.starting_probes.set(self.starting_probes.get() - 1);
            return Ok(false);
        }
        self.status.get().context("status unknown")
    }
    fn launch_completed(
        &self,
        job: &Job,
        owner: &str,
        deadline: Deadline,
    ) -> Result<Option<String>> {
        if self.mac_like.get() {
            return Ok(self
                .status(job.status_command.as_deref().unwrap_or(""), Duration::ZERO)?
                .then(|| "self-detached".to_owned()));
        }
        self.identity(&phase_unit(job), owner, deadline)
    }
    fn stop(&self, unit: &str, _: &str, _: &str, _: Deadline) -> Result<()> {
        anyhow::ensure!(!self.stop_fails.get(), "cannot stop");
        self.units.borrow_mut().remove(unit);
        Ok(())
    }
    fn healthy(&self, _: &Job, _: Duration) -> bool {
        true
    }
}

fn run(executor: &mut Executor, job: &Job, runtime: &Operated) -> Execution {
    executor.execute_job_until(
        job.clone(),
        true,
        McpCommandMode::Off,
        true,
        true,
        runtime,
        Deadline::new(Duration::from_secs(30)),
    )
}

/// A short deadline: a proof that never comes ends the polling quickly.
fn verify(executor: &mut Executor, job: &Job, runtime: &Operated) -> JobResult {
    executor.operator_verify_until(
        job,
        true,
        runtime,
        Deadline::new(Duration::from_millis(1200)),
    )
}

fn reload(path: &std::path::Path) -> Executor {
    Executor::load(path.to_path_buf()).expect("reload")
}

#[test]
fn a_start_not_yet_alive_needs_its_person_and_nothing_runs() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Operated::new(Some(false));
    let mut executor = Executor::load(path.clone()).expect("load");
    let start = golden("interactiveStart");
    let Execution::Operator(open) = run(&mut executor, &start, &runtime) else {
        panic!("an operator terminal is needed");
    };
    assert_eq!(open.job, start);
    assert!(!open.previous_run_unknown);
    // Status was checked first; nothing was launched or run.
    assert_eq!(runtime.status_checks.get(), 1);
    assert_eq!(runtime.launches.get(), 0);
    assert!(runtime.shells.borrow().is_empty());
    // The pending step is durable before any terminal opens.
    let record = reload(&path).state.records[&start.key()].clone();
    assert_eq!(record.pending.as_ref(), Some(&start));
    assert_eq!(
        record.operator,
        Some(OperatorState {
            step_id: start.step_id.clone(),
            intent_hash: start.intent_hash.clone(),
            accepted: false,
            launch_run_unknown: false,
        })
    );
    // A status that cannot be read is no proof either way: a person decides.
    let runtime = Operated::new(None);
    let mut executor = reload(&path);
    assert!(matches!(
        run(&mut executor, &start, &runtime),
        Execution::Operator(_)
    ));
}

#[test]
fn a_start_already_alive_is_adopted_without_a_terminal() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Operated::new(Some(true));
    let mut executor = Executor::load(path.clone()).expect("load");
    let start = golden("interactiveStart");
    let Execution::Done(result) = run(&mut executor, &start, &runtime) else {
        panic!("settled by status");
    };
    assert_eq!(result.status, "succeeded", "{result:?}");
    let record = reload(&path).state.records[&start.key()].clone();
    assert_eq!(
        record.invocations.get(&start.unit_name).map(String::as_str),
        Some("external")
    );
    assert!(record.pending.is_none() && record.operator.is_none());
    assert!(runtime.shells.borrow().is_empty());
    // A repeated delivery answers from history: no second terminal.
    let Execution::Done(again) = run(&mut reload(&path), &start, &Operated::new(Some(false)))
    else {
        panic!("answered from history");
    };
    assert_eq!(again.status, "succeeded");
}

#[test]
fn exit_zero_is_only_a_trigger_for_the_status_proof() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let mut executor = Executor::load(path.clone()).expect("load");
    let start = golden("interactiveStart");
    assert!(matches!(
        run(&mut executor, &start, &Operated::new(Some(false))),
        Execution::Operator(_)
    ));
    // The run reported success but the service is not alive: failed, and the
    // step stays pending (a person can reopen it; status decides again).
    let result = verify(&mut reload(&path), &start, &Operated::new(Some(false)));
    assert_eq!(result.status, "failed");
    assert_eq!(result.error.as_deref(), Some(OPERATOR_UNVERIFIED));
    // Probes that fail are no answer either.
    let result = verify(&mut reload(&path), &start, &Operated::new(None));
    assert_eq!(result.error.as_deref(), Some(OPERATOR_UNVERIFIED));
    assert!(reload(&path).state.records[&start.key()].pending.is_some());
    // With the proof the step succeeds as an external service.
    let result = verify(&mut reload(&path), &start, &Operated::new(Some(true)));
    assert_eq!(result.status, "succeeded", "{result:?}");
    assert!(!result.stopped);
    let record = reload(&path).state.records[&start.key()].clone();
    assert_eq!(
        record.invocations.get(&start.unit_name).map(String::as_str),
        Some("external")
    );
    assert!(record.pending.is_none() && record.operator.is_none());
    // A late duplicate answers from history.
    let again = verify(&mut reload(&path), &start, &Operated::new(Some(false)));
    assert_eq!(again.status, "succeeded");
}

#[test]
fn a_lost_accepted_run_is_reported_on_the_next_terminal() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("interactiveStart");
    let runtime = Operated::new(Some(false));
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &runtime
        ),
        Execution::Operator(_)
    ));
    reload(&path).operator_accepted(&start).expect("accepted");
    assert!(
        reload(&path).state.records[&start.key()]
            .operator
            .as_ref()
            .is_some_and(|operator| operator.accepted)
    );
    // wsmp restarts; the server dispatches the step again. Status first, then
    // a new terminal that says the earlier run's outcome is unknown. Nothing
    // ran on its own.
    let Execution::Operator(open) = run(&mut reload(&path), &start, &runtime) else {
        panic!("a new terminal");
    };
    assert!(open.previous_run_unknown);
    assert!(runtime.shells.borrow().is_empty());
    assert_eq!(runtime.launches.get(), 0);
    // An accept for a step that is not pending changes nothing.
    let mut other = start.clone();
    other.step_id = "tz4a98xxat96iws9zmbrgj3z".into();
    reload(&path).operator_accepted(&other).expect("ignored");
    let result = verify(&mut reload(&path), &other, &runtime);
    assert_eq!(result.error.as_deref(), Some("execution_unconfirmed"));
}

#[test]
fn an_interactive_stop_settles_by_status_or_waits_and_never_runs_its_command() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("interactiveStart");
    let stop = golden("interactiveStop");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(true))
        ),
        Execution::Done(_)
    ));
    // Still alive: the person runs the stop.
    let runtime = Operated::new(Some(true));
    let Execution::Operator(open) = run(&mut reload(&path), &stop, &runtime) else {
        panic!("a stop terminal");
    };
    assert_eq!(open.job.action, Action::Stop);
    assert!(
        runtime.shells.borrow().is_empty(),
        "the stop command is the person's"
    );
    let result = verify(&mut reload(&path), &stop, &Operated::new(Some(true)));
    assert_eq!(result.error.as_deref(), Some(OPERATOR_UNVERIFIED));
    let runtime = Operated::new(Some(false));
    let result = verify(&mut reload(&path), &stop, &runtime);
    assert_eq!(result.status, "succeeded", "{result:?}");
    assert!(result.stopped);
    assert!(runtime.shells.borrow().is_empty());
    let record = reload(&path).state.records[&start.key()].clone();
    assert_eq!(record.phase, "stopped");
    assert!(record.invocations.is_empty());

    // Already stopped by hand: settles without a person.
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(true))
        ),
        Execution::Done(_)
    ));
    let runtime = Operated::new(Some(false));
    let Execution::Done(result) = run(&mut reload(&path), &stop, &runtime) else {
        panic!("auto-settled");
    };
    assert!(result.stopped, "{result:?}");
    assert!(runtime.shells.borrow().is_empty());
}

#[test]
fn a_stop_replaces_a_start_still_waiting_for_its_person() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("interactiveStart");
    let stop = golden("interactiveStop");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(false))
        ),
        Execution::Operator(_)
    ));
    // The start never ran: status shows stopped, so the stop settles.
    let Execution::Done(result) = run(&mut reload(&path), &stop, &Operated::new(Some(false)))
    else {
        panic!("auto-settled");
    };
    assert!(result.stopped, "{result:?}");
    // The start's late verify can no longer succeed.
    let late = verify(&mut reload(&path), &start, &Operated::new(Some(true)));
    assert_eq!(late.error.as_deref(), Some("execution_unconfirmed"));
}

#[test]
fn an_interactive_prepare_succeeds_on_the_clean_exit_alone() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let mut prepare = golden("interactiveStart");
    prepare.action = Action::Prepare;
    prepare.step_id = "tz4a98xxat96iws9zmbrgj3p".into();
    prepare.validate().expect("valid prepare");
    let runtime = Operated::new(Some(true));
    // A prepare has no status shortcut: even an alive service needs the person.
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &prepare,
            &runtime
        ),
        Execution::Operator(_)
    ));
    assert_eq!(runtime.status_checks.get(), 0);
    let result = verify(&mut reload(&path), &prepare, &Operated::new(None));
    assert_eq!(result.status, "succeeded", "{result:?}");
}

#[test]
fn a_stop_interactive_start_runs_like_any_start() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("stopInteractiveStart");
    let runtime = Operated::new(Some(false));
    let Execution::Done(result) = run(
        &mut Executor::load(path.clone()).expect("load"),
        &start,
        &runtime,
    ) else {
        panic!("not interactive itself");
    };
    assert_eq!(result.status, "succeeded", "{result:?}");
    assert_eq!(runtime.launches.get(), 1);
    assert!(reload(&path).state.records[&start.key()].operator.is_none());
}

#[test]
fn operator_follow_ups_refuse_what_is_not_an_operator_step() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let mut executor = Executor::load(path).expect("load");
    let runtime = Operated::new(Some(true));
    let plain = golden("plainStart");
    assert_eq!(
        verify(&mut executor, &plain, &runtime).error.as_deref(),
        Some("bad_job")
    );
    let start = golden("interactiveStart");
    assert_eq!(
        verify(&mut executor, &start, &runtime).error.as_deref(),
        Some("execution_unconfirmed")
    );
    // The agent command policy still applies to interactive jobs.
    let mut agent = start.clone();
    agent.actor = Actor::Agent;
    let Execution::Done(denied) = run(&mut executor, &agent, &runtime) else {
        panic!("denied");
    };
    assert_eq!(denied.error.as_deref(), Some("command_mode_denied"));
    assert_eq!(runtime.status_checks.get(), 0);
}

#[test]
fn the_proof_is_polled_until_the_service_comes_up() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("interactiveStart");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(false))
        ),
        Execution::Operator(_)
    ));
    // `systemctl start` returned while the unit was still activating.
    let runtime = Operated::new(Some(true));
    runtime.starting_probes.set(2);
    let result = reload(&path).operator_verify_until(
        &start,
        true,
        &runtime,
        Deadline::new(Duration::from_secs(10)),
    );
    assert_eq!(result.status, "succeeded", "{result:?}");
    assert_eq!(runtime.status_checks.get(), 3);
}

#[test]
fn a_stop_proof_distinguishes_alive_from_failed_execution() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("interactiveStart");
    let stop = golden("interactiveStop");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(true))
        ),
        Execution::Done(_)
    ));
    assert!(matches!(
        run(&mut reload(&path), &stop, &Operated::new(Some(true))),
        Execution::Operator(_)
    ));
    // A unit the CLI owns cannot be stopped: an execution error, not a
    // missing proof.
    let runtime = Operated::new(Some(false));
    runtime
        .units
        .borrow_mut()
        .insert(format!("{}-prepare", stop.unit_name), "invocation".into());
    runtime.stop_fails.set(true);
    let result = verify(&mut reload(&path), &stop, &runtime);
    assert_eq!(result.error.as_deref(), Some("execution_unconfirmed"));
    // Still alive at the deadline: the proof never came.
    let result = verify(&mut reload(&path), &stop, &Operated::new(Some(true)));
    assert_eq!(result.error.as_deref(), Some(OPERATOR_UNVERIFIED));
    let result = verify(&mut reload(&path), &stop, &Operated::new(Some(false)));
    assert!(result.stopped, "{result:?}");
}

#[test]
fn an_adopted_service_is_proven_by_status_in_readiness_health_and_observations() {
    // Linux-like: no CLI-owned unit exists for a person-started service.
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("interactiveStart");
    let runtime = Operated::new(Some(true));
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &runtime
        ),
        Execution::Done(_)
    ));
    let mut readiness = start.clone();
    readiness.action = Action::Readiness;
    readiness.interactive = None;
    readiness.operator = None;
    readiness.command = String::new();
    readiness.step_id = "tz4a98xxat96iws9zmbrgj3r".into();
    readiness.timeout_ms = 5_000;
    let Execution::Done(ready) = run(&mut reload(&path), &readiness, &runtime) else {
        panic!("readiness");
    };
    assert_eq!(ready.status, "succeeded", "{ready:?}");
    let mut health = readiness.clone();
    health.action = Action::Health;
    health.step_id = "tz4a98xxat96iws9zmbrgj3h".into();
    let Execution::Done(healthy) = run(&mut reload(&path), &health, &runtime) else {
        panic!("health");
    };
    assert_eq!(healthy.status, "succeeded", "{healthy:?}");
    let executor = reload(&path);
    let observed = executor.observations_until(&runtime, Deadline::new(Duration::from_secs(5)));
    assert_eq!(observed[0].phase, "ready", "{observed:?}");
    // Status gone: no longer serving.
    runtime.status.set(Some(false));
    let observed = executor.observations_until(&runtime, Deadline::new(Duration::from_secs(5)));
    assert_eq!(observed[0].phase, "unknown");
}

#[test]
fn reconciliation_never_settles_a_pending_interactive_step() {
    // macOS-like: a "completed launch" is a live status, which a pending
    // interactive prepare must not be mistaken for.
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let mut prepare = golden("interactiveStart");
    prepare.action = Action::Prepare;
    prepare.step_id = "tz4a98xxat96iws9zmbrgj3p".into();
    let runtime = Operated::new(Some(true));
    runtime.mac_like.set(true);
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &prepare,
            &runtime
        ),
        Execution::Operator(_)
    ));
    let mut executor = reload(&path);
    executor
        .reconcile_until(&runtime, Deadline::new(Duration::from_secs(5)))
        .expect("reconcile");
    let record = executor.state.records[&prepare.key()].clone();
    assert_eq!(record.pending.as_ref(), Some(&prepare));
    assert!(!record.completed.contains_key(&prepare.step_id));
}

#[test]
fn a_stop_after_an_accepted_launch_run_never_settles_from_status() {
    // The reviewer's probe: the start's person pressed Enter, then the
    // terminal was lost (reconnect), so the session-level hold is gone. The
    // service may still be activating while status reads "stopped".
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let start = golden("interactiveStart");
    let stop = golden("interactiveStop");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(false))
        ),
        Execution::Operator(_)
    ));
    reload(&path).operator_accepted(&start).expect("accepted");
    let runtime = Operated::new(Some(false));
    let Execution::Operator(open) = run(&mut reload(&path), &stop, &runtime) else {
        panic!("a person runs the stop");
    };
    assert_eq!(open.job.step_id, stop.step_id);
    assert!(runtime.shells.borrow().is_empty());
    // A later delivery of the same stop (its terminal was declined) still
    // knows: the start's state is gone, the stop's record keeps the fact.
    assert!(matches!(
        run(&mut reload(&path), &stop, &Operated::new(Some(false))),
        Execution::Operator(_)
    ));
    // The person's stop and its polled proof settle it.
    let result = verify(&mut reload(&path), &stop, &Operated::new(Some(false)));
    assert!(result.stopped, "{result:?}");

    // Without an accepted run, status still settles a stop at once.
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(false))
        ),
        Execution::Operator(_)
    ));
    assert!(matches!(
        run(&mut reload(&path), &stop, &Operated::new(Some(false))),
        Execution::Done(_)
    ));

    // A non-interactive stop after an accepted run runs its stop command
    // and polls for the proof.
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    assert!(matches!(
        run(
            &mut Executor::load(path.clone()).expect("load"),
            &start,
            &Operated::new(Some(false))
        ),
        Execution::Operator(_)
    ));
    reload(&path).operator_accepted(&start).expect("accepted");
    let mut plain_stop = stop.clone();
    plain_stop.interactive = None;
    plain_stop.stop_interactive = None;
    plain_stop.operator = None;
    let runtime = Operated::new(Some(false));
    runtime.starting_probes.set(0);
    runtime.status.set(Some(false));
    let Execution::Done(result) = run(&mut reload(&path), &plain_stop, &runtime) else {
        panic!("non-interactive");
    };
    assert!(result.stopped, "{result:?}");
    assert_eq!(
        runtime.shells.borrow().as_slice(),
        [stop.stop_command.clone().unwrap_or_default()]
    );
}

#[test]
fn interactive_jobs_need_the_local_operator_terminal_switch() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("instances.json");
    let runtime = Operated::new(Some(false));
    let mut executor = Executor::load(path.clone()).expect("load");
    for name in [
        "interactiveStart",
        "interactiveStop",
        "stopInteractiveStart",
    ] {
        let Execution::Done(result) = executor.execute_job_until(
            golden(name),
            true,
            McpCommandMode::Off,
            true,
            false,
            &runtime,
            Deadline::new(Duration::from_secs(5)),
        ) else {
            panic!("refused");
        };
        assert_eq!(
            result.error.as_deref(),
            Some(OPERATOR_TERMINALS_DISABLED),
            "{name}"
        );
    }
    // Refused before any state, status check or launch.
    assert!(!path.exists());
    assert_eq!(runtime.status_checks.get(), 0);
    assert_eq!(runtime.launches.get(), 0);
    // A plain job is unaffected.
    let Execution::Done(plain) = executor.execute_job_until(
        golden("plainStart"),
        true,
        McpCommandMode::Off,
        true,
        false,
        &runtime,
        Deadline::new(Duration::from_secs(5)),
    ) else {
        panic!("plain");
    };
    assert_eq!(plain.status, "succeeded", "{plain:?}");
}
