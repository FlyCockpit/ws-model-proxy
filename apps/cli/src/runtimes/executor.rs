//! Durable runtime-instance execution (ported from the 0.3 deployment
//! executor). No model output is captured or persisted.
//!
//! One record per instance rank, in its own file under
//! `<state>/runtime-instances/`, so several runtimes run side by side. The
//! record and the pending step are fsynced before any external launch; a
//! re-delivered step observes the owned unit instead of replaying an
//! ambiguous launch. Disconnects never change desired state; only a job
//! starts or stops. Every command was rendered by the node itself
//! (`super::render`) from a held or frozen definition.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::frames::{InstancePhase, InstanceRecord, JobError, JobPhase, JobStatus};
use crate::protocol::runtime_spec::{Management, Readiness, RuntimeSpec};

const STATE_LIMIT: usize = 2 * 1024 * 1024;
const INSTANCES_DIR: &str = "runtime-instances";
const COMPLETED_LIMIT: usize = 128;
/// A verified-stopped record keeps answering retries of its stop for this long.
pub const STOPPED_RETENTION_SECS: u64 = 60 * 60;

/// A rendered job: everything one rank's step needs, persisted with the
/// record. `spec` is the held definition exactly as received (relay
/// endpoint, allowlist and readiness come from it, even after the server
/// drops that version).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub step_id: String,
    pub instance_id: String,
    pub runtime_id: String,
    pub version_id: String,
    pub launch_hash: String,
    pub rank: u8,
    pub action: JobPhase,
    pub intent_hash: String,
    pub owner_epoch: String,
    /// The step's own command, rendered (`""` when the phase has none).
    pub command: String,
    pub stop_command: String,
    pub status_command: Option<String>,
    pub health_command: Option<String>,
    /// Node secret names exported to every command (values never stored).
    pub secrets: Vec<String>,
    pub timeout_ms: u64,
    pub unit_name: String,
    pub handle: String,
    pub port: u16,
    /// The rank's second reserved port (`placeholders.dist_port`), when placement gave one:
    /// the stop proof requires it free as well.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dist_port: Option<u16>,
    /// The GPUs placement gave this rank (`placeholders.gpu_ids`, e.g. `0,3`): every command
    /// sees only them (`CUDA_VISIBLE_DEVICES` / `HIP_VISIBLE_DEVICES`), so two runtimes on one
    /// GPU node do not collide even when their commands never name `{{gpu_ids}}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_ids: Option<String>,
    /// Where the engine listens (`127.0.0.1`, or the fabric address).
    pub host: String,
    pub spec: Value,
}

impl Job {
    fn key(&self) -> String {
        format!("{}:{}", self.instance_id, self.rank)
    }

    pub fn parsed_spec(&self) -> Option<RuntimeSpec> {
        serde_json::from_value(self.spec.clone()).ok()
    }

    fn management(&self) -> Management {
        self.parsed_spec()
            .and_then(|spec| spec.launch.map(|launch| launch.management))
            .unwrap_or(Management::Process)
    }

    fn readiness(&self) -> Option<Readiness> {
        self.parsed_spec()
            .and_then(|spec| spec.launch.and_then(|launch| launch.readiness))
    }

    fn health_thresholds(&self) -> (u8, u8) {
        self.parsed_spec()
            .and_then(|spec| spec.launch.map(|launch| launch.health))
            .map_or((3, 1), |health| {
                (health.failure_threshold, health.success_threshold)
            })
    }

    pub fn models(&self) -> Vec<String> {
        self.parsed_spec()
            .and_then(|spec| spec.models)
            .map(|models| models.into_iter().map(|model| model.id).collect())
            .unwrap_or_default()
    }

    /// The base URL the relay and readiness reach.
    pub fn base_url(&self) -> String {
        if self.host.contains(':') {
            format!("http://[{}]:{}", self.host, self.port)
        } else {
            format!("http://{}:{}", self.host, self.port)
        }
    }

    fn identity_matches(&self, other: &Job) -> bool {
        self.version_id == other.version_id
            && self.launch_hash == other.launch_hash
            && self.unit_name == other.unit_name
            && self.port == other.port
            && self.handle == other.handle
            && self.host == other.host
            && self.stop_command == other.stop_command
            && self.status_command == other.status_command
    }
}

/// A step's outcome, before it becomes `runtime.job.result`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub status: JobStatus,
    pub stopped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JobError>,
    /// A stop proof answered not stopped: why (`port_in_use`, `process_alive`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Outcome {
    fn ok(stopped: bool) -> Self {
        Self {
            status: JobStatus::Succeeded,
            stopped,
            error: None,
            detail: None,
        }
    }

    /// A stop proof that did not prove the stop, and why.
    fn unproven(reason: &str) -> Self {
        Self {
            detail: Some(reason.to_string()),
            ..Self::ok(false)
        }
    }

    pub fn failed(error: JobError) -> Self {
        Self {
            status: JobStatus::Failed,
            stopped: false,
            error: Some(error),
            detail: None,
        }
    }

    /// A failed health probe, and why.
    fn unhealthy(miss: HealthMiss) -> Self {
        Self {
            detail: Some(miss.detail()),
            ..Self::failed(JobError::HealthFailed)
        }
    }
}

/// What a health step keeps of its deadline to record and answer its probe.
const HEALTH_ANSWER_RESERVE: Duration = Duration::from_secs(2);

/// Why a health (or readiness) probe failed; a health result sends it as its
/// `detail`. Plain codes only, never the response or command output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthMiss {
    /// The serving process could not be confirmed (its unit has no task left,
    /// or a service's status command did not say alive).
    ServingUnconfirmed,
    /// The readiness URL answered another status.
    Http(u16),
    /// Nothing listens on the port.
    ConnectRefused,
    /// The probe did not finish in time.
    Timeout,
    /// The request failed another way (reset, no route, protocol error).
    Unreachable,
    /// The health command exited non-zero (or could not run).
    CommandFailed,
    /// The status command did not say alive.
    StatusNotRunning,
}

impl HealthMiss {
    pub fn detail(self) -> String {
        match self {
            Self::ServingUnconfirmed => "serving_unconfirmed".into(),
            Self::Http(status) => format!("http_{status}"),
            Self::ConnectRefused => "connect_refused".into(),
            Self::Timeout => "timeout".into(),
            Self::Unreachable => "unreachable".into(),
            Self::CommandFailed => "command_failed".into(),
            Self::StatusNotRunning => "status_not_running".into(),
        }
    }
}

/// An explicit failure code carried through `anyhow`.
#[derive(Debug)]
struct Fail(JobError);

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl std::error::Error for Fail {}

fn fail(code: JobError) -> anyhow::Error {
    anyhow::Error::new(Fail(code))
}

/// One monotonic budget, created at admission, including queue time.
#[derive(Clone, Copy, Debug)]
pub struct Deadline(Instant);

impl Deadline {
    pub fn new(timeout: Duration) -> Self {
        let now = Instant::now();
        Self(
            now.checked_add(timeout.min(Duration::from_millis(86_400_000)))
                .unwrap_or(now),
        )
    }
    pub fn instant(self) -> Instant {
        self.0
    }
    fn remaining(self) -> Result<Duration> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(fail(JobError::JobDeadline));
        }
        Ok(remaining)
    }
    fn sleep(self, duration: Duration) -> Result<()> {
        std::thread::sleep(duration.min(self.remaining()?));
        self.remaining()?;
        Ok(())
    }
    pub(crate) fn cap(self, duration: Duration) -> Self {
        Self(self.0.min(Instant::now() + duration))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Completed {
    hash: String,
    outcome: Outcome,
    action: JobPhase,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    job: Job,
    phase: InstancePhase,
    /// Exact systemd invocation identity per unit, or `external`.
    invocations: BTreeMap<String, String>,
    pending: Option<Job>,
    completed: BTreeMap<String, Completed>,
    observed_step: String,
    observed_hash: String,
    #[serde(default)]
    consecutive_health_failures: u32,
    #[serde(default)]
    consecutive_health_successes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stopped_at: Option<u64>,
    /// A step of this run ran outside the node's units (`external`: a person ran it in an
    /// operator terminal; `self-detached`: no units on this platform). Kept after the stop
    /// clears `invocations`, so a later check still asks its status command.
    #[serde(default)]
    outside_units: bool,
}

impl Record {
    /// The run is proven stopped: its units are forgotten, but not that a step of it ran
    /// outside them.
    fn clear_invocations(&mut self) {
        self.outside_units |= self
            .invocations
            .values()
            .any(|invocation| outside(invocation));
        self.invocations.clear();
    }

    /// Verified stopped with nothing unresolved.
    fn terminal(&self) -> bool {
        self.phase == InstancePhase::Stopped
            && self.invocations.is_empty()
            && self.pending.as_ref().is_none_or(|pending| {
                matches!(
                    pending.action,
                    JobPhase::Readiness | JobPhase::Health | JobPhase::Status
                )
            })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct State {
    version: u32,
    owner_id: String,
    records: BTreeMap<String, Record>,
}

/// The code a failed step answers: an explicit [`Fail`], else the phase's
/// default.
fn failure_code(job: &Job, error: &anyhow::Error) -> JobError {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<Fail>().map(|fail| fail.0))
        .unwrap_or(match job.action {
            JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin => {
                if job.management() == Management::Process {
                    JobError::OwnedLaunchUnconfirmed
                } else {
                    JobError::LaunchUnconfirmed
                }
            }
            JobPhase::Readiness => JobError::ReadinessFailed,
            JobPhase::Health | JobPhase::Status => JobError::HealthFailed,
            JobPhase::Stop => JobError::CommandFailed,
        })
}

/// A new launch may change the version (a restart), but only while nothing
/// of the old one runs.
fn same_instance(record: &Record, job: &Job) -> Result<()> {
    anyhow::ensure!(
        record.job.identity_matches(job)
            || (matches!(job.action, JobPhase::Prepare | JobPhase::Start)
                && record.invocations.is_empty()),
        "instance identity changed"
    );
    Ok(())
}

/// What `execute` would refuse for `job` against an existing record, short
/// of running anything: another instance identity, the same step with
/// another intent, a start that already launched, or another step still
/// unresolved. An operator step is checked before its person can run it.
fn admissible(record: &Record, job: &Job) -> Result<()> {
    same_instance(record, job)?;
    if let Some(done) = record.completed.get(&job.step_id) {
        anyhow::ensure!(done.hash == job.intent_hash, "step intent changed");
    }
    if let Some(pending) = &record.pending {
        anyhow::ensure!(
            (pending.step_id == job.step_id && pending.intent_hash == job.intent_hash)
                || job.action == JobPhase::Stop
                || matches!(
                    pending.action,
                    JobPhase::Readiness | JobPhase::Health | JobPhase::Status
                ),
            "another step is unresolved"
        );
    }
    if matches!(job.action, JobPhase::Start | JobPhase::AfterJoin) {
        anyhow::ensure!(
            !record.invocations.contains_key(&phase_unit(job)),
            "instance is already launched"
        );
    }
    Ok(())
}

/// What a record looked like before an operator step was recorded pending.
#[derive(Debug)]
pub struct OperatorMark {
    created: bool,
    phase: InstancePhase,
    pending: Option<Job>,
    job: Job,
    outside_units: bool,
}

/// Executes the steps of one instance rank (one state file).
pub struct Executor {
    path: PathBuf,
    state: State,
    clock: fn() -> u64,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// What the executor needs from the machine. `NativeRuntime` is systemd.
pub trait Runtime {
    fn cancelled(&self) -> bool {
        false
    }
    /// Whether every command this runtime runs for a rank stays in units and a rank slice it
    /// can observe (`tasks_alive`), as systemd's do on Linux. Without them (macOS runs a
    /// service's commands detached) an empty unit proves nothing, so every stop also needs the
    /// run's status command to say stopped. Required, never defaulted: a wrong `true` would
    /// prove stops from units that never held anything.
    fn contains_ranks(&self) -> bool;
    fn launch(&self, job: &Job, owner: &str, unit: &str, deadline: Deadline) -> Result<String>;
    fn identity(&self, unit: &str, owner: &str, deadline: Deadline) -> Result<Option<String>>;
    fn launch_completed(
        &self,
        job: &Job,
        owner: &str,
        deadline: Deadline,
    ) -> Result<Option<String>> {
        self.identity(&phase_unit(job), owner, deadline)
    }
    fn shell_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<()>;
    /// true alive, false positively stopped (exit 3); errors are unknown.
    fn status_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<bool>;
    fn stop(&self, unit: &str, owner: &str, invocation: &str, deadline: Deadline) -> Result<()>;
    /// Probes the launch's readiness URL once: `Ok` when it answers the
    /// expected status, else why not.
    fn healthy_until(&self, job: &Job, deadline: Deadline) -> std::result::Result<(), HealthMiss>;
    /// Whether any process of the unit's tree still runs (whoever launched it): false when
    /// the unit is gone or its control group has no task. Errors are unknown.
    fn tasks_alive(&self, unit: &str, deadline: Deadline) -> Result<bool>;
    /// Whether nothing listens on `port` (any address, and `host`).
    fn port_free(&self, host: &str, port: u16) -> bool;
    /// Whether the unit's main process exited with status 0 (a `RemainAfterExit` unit stays
    /// active after that). A crash, a signal or a unit still running is not. Errors are unknown.
    fn exited_cleanly(&self, _unit: &str, _deadline: Deadline) -> Result<bool> {
        Ok(false)
    }
    /// Whether something accepts a connection on `host:port` now.
    fn port_answers(&self, _host: &str, _port: u16) -> bool {
        false
    }
    /// The rank's slice was proven empty: let the manager forget it (best effort).
    fn forget_slice(&self, _slice: &str, _deadline: Deadline) {}
    /// A stop ends whatever still runs in the rank's slice: SIGTERM, then SIGKILL after a grace
    /// period. Errors are logged; the proof that follows decides.
    fn stop_slice(&self, _slice: &str, _deadline: Deadline) -> Result<()> {
        Ok(())
    }
}

fn owner_ok(owner: &str) -> bool {
    owner.len() == 24 && owner.bytes().all(|b| b.is_ascii_alphanumeric())
}

impl Executor {
    pub fn load(path: PathBuf) -> Result<Self> {
        use rand::distr::SampleString;
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(nix::libc::O_NOFOLLOW);
        }
        let state = match options.open(&path) {
            Ok(file) => {
                anyhow::ensure!(file.metadata()?.is_file(), "instance state is not a file");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let metadata = file.metadata()?;
                    anyhow::ensure!(
                        metadata.uid() == nix::unistd::Uid::effective().as_raw()
                            && metadata.mode() & 0o077 == 0,
                        "instance state permissions are unsafe"
                    );
                }
                let mut bytes = Vec::new();
                file.take(STATE_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .context("reading instance state")?;
                anyhow::ensure!(bytes.len() <= STATE_LIMIT, "instance state too large");
                let state: State =
                    serde_json::from_slice(&bytes).context("reading instance state")?;
                anyhow::ensure!(state.version == 1, "unsupported instance state version");
                anyhow::ensure!(owner_ok(&state.owner_id), "bad instance state owner");
                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State {
                version: 1,
                owner_id: rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 24),
                records: BTreeMap::new(),
            },
            Err(error) => return Err(error).context("reading instance state"),
        };
        Ok(Self {
            path,
            state,
            clock: unix_now,
        })
    }

    fn persist(&mut self) -> Result<()> {
        let bytes = serde_json::to_vec(&self.state).context("encoding instance state")?;
        anyhow::ensure!(bytes.len() <= STATE_LIMIT, "instance state too large");
        crate::approvals::write_private_atomic(&self.path, &bytes, "instance state", false)?;
        Ok(())
    }

    /// The job the record for `instance_id`/`rank` last ran.
    pub fn recorded_job(&self, instance_id: &str, rank: u8) -> Option<Job> {
        self.state
            .records
            .get(&format!("{instance_id}:{rank}"))
            .map(|record| record.job.clone())
    }

    /// The recorded outcome of this exact step, when it already finished (a
    /// re-delivery answers it without running anything).
    pub fn done(&self, job: &Job) -> Option<Outcome> {
        self.state
            .records
            .get(&job.key())
            .and_then(|record| record.completed.get(&job.step_id))
            .filter(|done| done.hash == job.intent_hash)
            .map(|done| done.outcome.clone())
    }

    /// Durable intent before an operator terminal opens: the step is
    /// recorded pending (fsynced) before a person can run anything, so a
    /// crash during the run leaves a record that a re-dispatch observes
    /// (status first, then the adopt path) instead of replaying blind.
    /// Returns what [`Executor::abandon_operator`] restores.
    pub fn begin_operator(&mut self, job: &Job) -> std::result::Result<OperatorMark, JobError> {
        let key = job.key();
        let mark = match self.state.records.get_mut(&key) {
            Some(record) => {
                // Refused exactly as `execute` would refuse it, before a
                // person can run anything.
                if let Err(error) = admissible(record, job) {
                    let code = failure_code(job, &error);
                    tracing::warn!(step_id = job.step_id, error = ?code, "refused an operator step");
                    return Err(code);
                }
                let mark = OperatorMark {
                    created: false,
                    phase: record.phase,
                    pending: record.pending.clone(),
                    job: record.job.clone(),
                    outside_units: record.outside_units,
                };
                if matches!(job.action, JobPhase::Prepare | JobPhase::Start)
                    && record.invocations.is_empty()
                {
                    record.job = job.clone();
                    record.outside_units = false;
                }
                record.pending = Some(job.clone());
                record.phase = if job.action == JobPhase::Stop {
                    InstancePhase::Stopping
                } else {
                    InstancePhase::Starting
                };
                mark
            }
            None => {
                if job.action == JobPhase::Stop {
                    return Err(JobError::InstanceUnknown);
                }
                self.state.records.insert(
                    key.clone(),
                    Record {
                        job: job.clone(),
                        phase: InstancePhase::Starting,
                        invocations: BTreeMap::new(),
                        pending: Some(job.clone()),
                        completed: BTreeMap::new(),
                        observed_step: job.step_id.clone(),
                        observed_hash: job.intent_hash.clone(),
                        consecutive_health_failures: 0,
                        consecutive_health_successes: 0,
                        stopped_at: None,
                        outside_units: false,
                    },
                );
                OperatorMark {
                    created: true,
                    phase: InstancePhase::Unknown,
                    pending: None,
                    job: job.clone(),
                    outside_units: false,
                }
            }
        };
        if let Err(error) = self.persist() {
            tracing::warn!(error = %format!("{error:#}"), "recording an operator step failed");
            self.abandon_operator(job, mark, false);
            return Err(JobError::LocalConfigUnavailable);
        }
        Ok(mark)
    }

    /// The operator terminal ended without the command succeeding: nothing
    /// is left pending for this step, so a fresh dispatch (a reopen) runs.
    ///
    /// `ran`: a person pressed Enter, so the command ran (it failed or was
    /// killed). The record then stays, unresolved (`Unknown`), so a later
    /// stop tears down and proves what it may have left; only a step whose
    /// command never ran is undone.
    pub fn abandon_operator(&mut self, job: &Job, mark: OperatorMark, ran: bool) {
        let key = job.key();
        let Some(record) = self.state.records.get_mut(&key) else {
            return;
        };
        if record
            .pending
            .as_ref()
            .is_none_or(|pending| pending.step_id != job.step_id)
        {
            return;
        }
        if ran {
            record.pending = mark.pending;
            record.phase = InstancePhase::Unknown;
        } else if mark.created && record.invocations.is_empty() && record.completed.is_empty() {
            self.state.records.remove(&key);
        } else {
            record.pending = mark.pending;
            record.phase = mark.phase;
            record.job = mark.job;
            record.outside_units = mark.outside_units;
        }
        if let Err(error) = self.persist() {
            tracing::warn!(error = %format!("{error:#}"), "clearing an operator step failed");
        }
    }

    /// Verified stopped long enough ago that nothing will ask about it.
    pub fn expired(&self) -> bool {
        let now = (self.clock)();
        !self.state.records.is_empty()
            && self.state.records.values().all(|record| {
                record.terminal()
                    && record
                        .stopped_at
                        .is_some_and(|at| now.saturating_sub(at) >= STOPPED_RETENTION_SECS)
            })
    }

    /// Execute one step. Never panics; every failure is an outcome.
    pub fn execute(&mut self, job: Job, runtime: &impl Runtime, deadline: Deadline) -> Outcome {
        match self.execute_inner(&job, runtime, deadline) {
            Ok(outcome) => outcome,
            Err(error) => {
                let code = failure_code(&job, &error);
                tracing::warn!(
                    step_id = job.step_id,
                    instance_id = job.instance_id,
                    rank = job.rank,
                    phase = ?job.action,
                    error = ?code,
                    "runtime step failed"
                );
                Outcome::failed(code)
            }
        }
    }

    fn execute_inner(
        &mut self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Result<Outcome> {
        deadline.remaining()?;
        if runtime.cancelled() {
            return Err(fail(JobError::SessionDisconnected));
        }
        let key = job.key();
        if job.action == JobPhase::Status {
            return self.prove_stopped(job, runtime, deadline);
        }
        if matches!(
            job.action,
            JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
        ) && !job.command.trim().is_empty()
        {
            // A missing secret refuses the launch before anything is recorded.
            command_env(job)?;
        }
        let mut admitted = false;
        if let Some(record) = self.state.records.get(&key) {
            same_instance(record, job)?;
            if let Some(done) = record.completed.get(&job.step_id) {
                anyhow::ensure!(done.hash == job.intent_hash, "step intent changed");
                if done.action == JobPhase::Stop {
                    anyhow::ensure!(
                        record.phase == InstancePhase::Stopped,
                        "stale stopped result"
                    );
                    for unit in owned_units(job) {
                        anyhow::ensure!(
                            runtime
                                .identity(&unit, &self.state.owner_id, deadline)?
                                .is_none(),
                            "stopped unit revived"
                        );
                    }
                    // Answered again only while the stop still holds, proven afresh (the
                    // port may have been taken since, a process may have come back).
                    if let Some(reason) = self.stop_unproven(
                        job,
                        runtime,
                        deadline.cap(Duration::from_secs(30)),
                        true,
                    )? {
                        tracing::warn!(
                            instance_id = job.instance_id,
                            rank = job.rank,
                            reason,
                            "a stopped run is not proven stopped any more"
                        );
                        return Ok(Outcome::unproven(reason));
                    }
                }
                return Ok(done.outcome.clone());
            }
            if let Some(pending) = &record.pending {
                // A read-only check that failed part way had no effect: a
                // later step replaces it.
                anyhow::ensure!(
                    (pending.step_id == job.step_id && pending.intent_hash == job.intent_hash)
                        || job.action == JobPhase::Stop
                        || matches!(
                            pending.action,
                            JobPhase::Readiness | JobPhase::Health | JobPhase::Status
                        ),
                    "another step is unresolved"
                );
                // A launch may have happened before the node died: never
                // replay it, observe it.
                if pending.step_id == job.step_id
                    && matches!(
                        job.action,
                        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
                    )
                    && !job.command.trim().is_empty()
                {
                    return self.adopt_launch(job, runtime, deadline);
                }
            }
            if matches!(job.action, JobPhase::Start | JobPhase::AfterJoin) {
                anyhow::ensure!(
                    !record.invocations.contains_key(&phase_unit(job)),
                    "instance is already launched"
                );
            }
        } else {
            if job.action == JobPhase::Stop {
                // No record (lost, or the run never reached this node): the stop is still
                // proven when nothing of the rank runs, so a restart's leading stop is not
                // refused forever. Otherwise the node cannot know what to stop.
                let proof = self.prove_stopped(job, runtime, deadline)?;
                if proof.stopped {
                    return Ok(proof);
                }
                return Err(fail(JobError::InstanceUnknown));
            }
            if matches!(
                job.action,
                JobPhase::Readiness | JobPhase::Health | JobPhase::Status
            ) {
                return Err(fail(JobError::InstanceUnknown));
            }
            admitted = true;
            self.state.records.insert(
                key.clone(),
                Record {
                    job: job.clone(),
                    phase: InstancePhase::Unknown,
                    invocations: BTreeMap::new(),
                    pending: None,
                    completed: BTreeMap::new(),
                    observed_step: job.step_id.clone(),
                    observed_hash: job.intent_hash.clone(),
                    consecutive_health_failures: 0,
                    consecutive_health_successes: 0,
                    stopped_at: None,
                    outside_units: false,
                },
            );
        }
        let record = self.state.records.get_mut(&key).context("record")?;
        if matches!(job.action, JobPhase::Prepare | JobPhase::Start) {
            if record.invocations.is_empty() {
                // A new run: nothing of an earlier one ran outside the units any more.
                record.outside_units = false;
            }
            record.job = job.clone();
        }
        record.pending = Some(job.clone());
        match job.action {
            JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin => {
                record.phase = InstancePhase::Starting;
                record.consecutive_health_failures = 0;
                record.consecutive_health_successes = 0;
                record.stopped_at = None;
            }
            JobPhase::Stop => {
                record.phase = InstancePhase::Stopping;
                record.stopped_at = None;
            }
            _ => {}
        }
        // Durable intent BEFORE any external effect.
        if let Err(error) = self.persist() {
            if admitted {
                self.state.records.remove(&key);
            }
            return Err(error);
        }
        if runtime.cancelled() {
            // Nothing external ran: forget a record this step created.
            if admitted {
                self.state.records.remove(&key);
                let _ = self.persist();
            }
            return Err(fail(JobError::SessionDisconnected));
        }
        deadline.remaining()?;
        let outcome = match job.action {
            JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin => {
                if job.command.trim().is_empty() {
                    // No prepare/afterJoin command: nothing to run.
                    Outcome::ok(false)
                } else {
                    let unit = phase_unit(job);
                    let invocation =
                        match runtime.launch(job, &self.state.owner_id, &unit, deadline) {
                            Ok(identity) => identity,
                            // A hand-off is not an unconfirmed launch: keep its reason.
                            Err(error)
                                if failure_code(job, &error) == JobError::ProcessDetached =>
                            {
                                return Err(error);
                            }
                            Err(error) => {
                                deadline.remaining()?;
                                let _ = runtime.identity(&unit, &self.state.owner_id, deadline)?;
                                anyhow::ensure!(
                                    job.management() == Management::Service,
                                    "owned launch unconfirmed"
                                );
                                let Some(status) = job.status_command.as_deref() else {
                                    return Err(error);
                                };
                                anyhow::ensure!(
                                    runtime.status_until(
                                        job,
                                        status,
                                        deadline.cap(Duration::from_secs(30))
                                    )?,
                                    "detached launch is not alive"
                                );
                                "external".to_owned()
                            }
                        };
                    deadline.remaining()?;
                    self.state
                        .records
                        .get_mut(&key)
                        .context("record")?
                        .invocations
                        .insert(unit, invocation);
                    Outcome::ok(false)
                }
            }
            JobPhase::Readiness => {
                // A `process` start must keep its server in the node's units. One that
                // answers while its start unit has no task left handed off (`docker
                // compose up -d`, a daemonizing server): wsmp could neither watch nor stop
                // it, so the start fails and asks for `management: "service"`. (A person's
                // run in an operator terminal is `external`: its status command decides.)
                let record = self.state.records.get(&key).context("record")?;
                let watched = job.management() == Management::Process
                    && record
                        .invocations
                        .get(&phase_unit(job))
                        .is_some_and(|invocation| !outside(invocation));
                let detached = || {
                    Err::<Outcome, _>(fail(JobError::ProcessDetached)).context(
                        "the start handed its server off out of wsmp's units; use management \"service\" with stop and status commands",
                    )
                };
                // Handed off, not crashed: the start command exited 0 and the server answers.
                let handed_off = || -> Result<bool> {
                    Ok(runtime.exited_cleanly(&phase_unit(job), deadline)?
                        && probe_once(job, runtime, deadline.cap(Duration::from_secs(10))).is_ok())
                };
                if !serving_confirmed(record, &self.state.owner_id, runtime, deadline)? {
                    if watched && handed_off()? {
                        return detached();
                    }
                    anyhow::bail!("serving process unconfirmed");
                }
                while probe_once(job, runtime, deadline.cap(Duration::from_secs(10))).is_err() {
                    if runtime.cancelled() {
                        return Err(fail(JobError::SessionDisconnected));
                    }
                    deadline
                        .sleep(Duration::from_millis(500))
                        .map_err(|_| fail(JobError::ReadinessFailed))?;
                }
                if watched
                    && !serving_confirmed(
                        self.state.records.get(&key).context("record")?,
                        &self.state.owner_id,
                        runtime,
                        deadline,
                    )?
                {
                    // A server that answered and then crashed is an ordinary failed
                    // readiness (restarted as usual), not a hand-off.
                    if handed_off()? {
                        return detached();
                    }
                    anyhow::bail!("serving process unconfirmed");
                }
                self.state.records.get_mut(&key).context("record")?.phase = InstancePhase::Ready;
                Outcome::ok(false)
            }
            JobPhase::Status => anyhow::bail!("a status probe is answered by the stop proof"),
            JobPhase::Health => {
                let miss = if serving_confirmed(
                    self.state.records.get(&key).context("record")?,
                    &self.state.owner_id,
                    runtime,
                    deadline,
                )? {
                    // Keep time to answer: a probe that runs out of it is a `timeout`,
                    // not a step past its deadline.
                    let reserve = deadline
                        .remaining()?
                        .saturating_sub(HEALTH_ANSWER_RESERVE)
                        .max(Duration::from_millis(100));
                    probe_once(job, runtime, deadline.cap(reserve)).err()
                } else {
                    Some(HealthMiss::ServingUnconfirmed)
                };
                deadline.remaining()?;
                let healthy = miss.is_none();
                if job.action == JobPhase::Health {
                    let (failure_threshold, success_threshold) = job.health_thresholds();
                    let record = self.state.records.get_mut(&key).context("record")?;
                    if healthy {
                        record.consecutive_health_failures = 0;
                        record.consecutive_health_successes =
                            record.consecutive_health_successes.saturating_add(1);
                        if record.consecutive_health_successes >= u32::from(success_threshold) {
                            record.phase = InstancePhase::Ready;
                        }
                    } else {
                        record.consecutive_health_successes = 0;
                        record.consecutive_health_failures =
                            record.consecutive_health_failures.saturating_add(1);
                        if record.consecutive_health_failures >= u32::from(failure_threshold) {
                            record.phase = InstancePhase::Unhealthy;
                        }
                    }
                }
                miss.map_or_else(|| Outcome::ok(false), Outcome::unhealthy)
            }
            JobPhase::Stop => self
                .stop_teardown(job, runtime, deadline)?
                .context("service remains alive")?,
        };
        self.complete(job, outcome)
    }

    /// Why the rank's stop is not proven, or `None` when it is. Stops, status
    /// probes, a re-delivered stop and the inventory's `stopped` all ask this
    /// one question (the server releases a claim on any of them).
    ///
    /// The proof rests on what the node observes itself: no unit of the rank
    /// (owned, or recorded by its launch) and nothing in the rank's slice
    /// ([`rank_slice`], where every command of the rank runs) has a process
    /// left, and every port reserved for the rank (`port`, `dist_port`) is
    /// free. A `process` runtime runs in the node's own
    /// units (`KillMode=control-group`): those facts are its proof, and its
    /// status command can neither block nor replace them (a stub `true`, "alive"
    /// forever, must not hold a claim forever). A run whose processes may live
    /// outside the node's units also needs its status command to say stopped
    /// (exit 3): a `service` runtime (its start may hand off to docker or a
    /// service manager, so an empty unit and a port not yet bound prove
    /// nothing), a serving step a person ran in an operator terminal
    /// (`external`), and any run on a runtime without units (`self-detached`;
    /// [`Runtime::contains_ranks`]).
    ///
    /// Reasons: `process_alive`, `process_unknown` (the user manager could not
    /// say), `port_in_use`, `port_held_outside_runtime` (a reserved port is
    /// held while the rank's units and slice have no process left: what holds
    /// it escaped them, e.g. `docker compose up -d` or a daemon that
    /// re-parents), `unowned_service` (outside the node's units with no status
    /// command), `status_running`, `status_unknown`.
    ///
    /// `run_status`: false for the inventory, which runs nothing in a rank's slice (it holds no
    /// rank lock): a run that needs its status command is then never reported stopped (a held
    /// port is still named `port_in_use`).
    fn stop_unproven(
        &self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
        run_status: bool,
    ) -> Result<Option<&'static str>> {
        let record = self.state.records.get(&job.key());
        // Every unit of the rank and its slice (every command the node ran for it: start,
        // prepare, after-join, stop, status, health). What the launched run used is checked
        // too: a probe rendered from another version may name other ports or commands.
        let mut units: std::collections::BTreeSet<String> = owned_units(job).into_iter().collect();
        units.insert(rank_slice(job));
        let mut jobs = vec![job];
        if let Some(record) = record {
            units.extend(owned_units(&record.job));
            units.insert(rank_slice(&record.job));
            units.extend(record.invocations.keys().cloned());
            jobs.push(&record.job);
        }
        let mut ports: Vec<(&str, u16)> = Vec::new();
        let mut statuses: Vec<(&Job, &str)> = Vec::new();
        for owner in &jobs {
            for port in std::iter::once(owner.port).chain(owner.dist_port) {
                if !ports.contains(&(owner.host.as_str(), port)) {
                    ports.push((owner.host.as_str(), port));
                }
            }
            if let Some(status) = owner.status_command.as_deref()
                && !statuses.iter().any(|(_, seen)| *seen == status)
            {
                statuses.push((owner, status));
            }
        }
        let detached = !runtime.contains_ranks()
            || jobs
                .iter()
                .any(|owner| owner.management() == Management::Service)
            || record.is_some_and(|record| {
                record.outside_units || record.invocations.values().any(|i| outside(i))
            });
        if detached && statuses.is_empty() {
            return Ok(Some("unowned_service"));
        }
        let port_held = || {
            ports
                .iter()
                .any(|(host, port)| !runtime.port_free(host, *port))
        };
        if detached && !run_status {
            // A held port is a fact; the status command the inventory may not run is not.
            return Ok(Some(if port_held() {
                "port_in_use"
            } else {
                "status_unknown"
            }));
        }
        if detached {
            for (owner, status) in statuses {
                match runtime.status_until(owner, status, deadline.cap(Duration::from_secs(30))) {
                    Ok(false) => {}
                    Ok(true) => return Ok(Some("status_running")),
                    Err(_) => {
                        if runtime.cancelled() {
                            return Err(fail(JobError::SessionDisconnected));
                        }
                        return Ok(Some("status_unknown"));
                    }
                }
            }
        }
        // After the status command (it runs in the rank's slice too): nothing it or any
        // other command of the rank left behind may still run.
        for unit in &units {
            match runtime.tasks_alive(unit, deadline) {
                Ok(false) => {}
                Ok(true) => return Ok(Some("process_alive")),
                Err(_) => {
                    deadline.remaining()?;
                    if runtime.cancelled() {
                        return Err(fail(JobError::SessionDisconnected));
                    }
                    return Ok(Some("process_unknown"));
                }
            }
        }
        if port_held() {
            // Nothing is left in the rank's units: on a runtime that contains its ranks, what
            // holds the port runs outside them (usually something the run started that escaped,
            // or another process). Without units the node cannot tell where it runs.
            return Ok(Some(if runtime.contains_ranks() {
                "port_held_outside_runtime"
            } else {
                "port_in_use"
            }));
        }
        Ok(None)
    }

    /// A status probe (the server sends one when the stops of a stopping rank
    /// failed, or for a claim marked stopped): proves the stop as
    /// [`Executor::stop_unproven`] does. It runs nothing but the status command
    /// of a run outside the node's units, and needs no record (a lost record
    /// cannot block the proof); a proof resolves the record like a verified
    /// stop. A re-delivered probe is proven again, never answered from history:
    /// the machine may have changed since. Anything short of proof answers not
    /// stopped, saying why (`detail`).
    fn prove_stopped(
        &mut self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Result<Outcome> {
        let key = job.key();
        if let Some(reason) = self.stop_unproven(job, runtime, deadline, true)? {
            return Ok(Outcome::unproven(reason));
        }
        deadline.remaining()?;
        runtime.forget_slice(&rank_slice(job), deadline);
        let now = (self.clock)();
        let Some(record) = self.state.records.get_mut(&key) else {
            return Ok(Outcome::ok(true));
        };
        record.clear_invocations();
        record.phase = InstancePhase::Stopped;
        record.stopped_at = Some(now);
        self.complete(job, Outcome::ok(true))
    }

    /// Run the stop command, stop every owned unit, then wait (within the
    /// step's deadline) until the stop is proven ([`Executor::stop_unproven`]).
    /// `None`: not proven by the deadline.
    fn stop_teardown(
        &mut self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Result<Option<Outcome>> {
        let key = job.key();
        let record = self.state.records.get(&key).context("record")?;
        let mut units = record.invocations.clone();
        for unit in owned_units(job) {
            match runtime.identity(&unit, &self.state.owner_id, deadline) {
                Ok(Some(identity)) => {
                    units.entry(unit).or_insert(identity);
                }
                Ok(None) => {}
                // A unit the node cannot identify (relaunched, another description) whose
                // process tree is empty has nothing left to stop.
                Err(_) if !runtime.tasks_alive(&unit, deadline)? => {}
                Err(error) => return Err(error),
            }
        }
        if !job.stop_command.trim().is_empty() {
            // A stop command that fails is not proof either way; the unit
            // stop and status below decide.
            if let Err(error) = runtime.shell_until(job, &job.stop_command, deadline) {
                tracing::warn!(
                    instance_id = job.instance_id,
                    error = %format!("{error:#}"),
                    "the stop command failed"
                );
            }
        }
        let mut failed_units = Vec::new();
        for (unit, invocation) in units {
            if invocation != "external" && invocation != "self-detached" {
                if let Err(error) = runtime.stop(&unit, &self.state.owner_id, &invocation, deadline)
                {
                    failed_units.push((unit, error));
                }
            } else {
                anyhow::ensure!(
                    job.status_command.is_some(),
                    "detached stop requires status proof"
                );
            }
        }
        // Then everything else wsmp launched for the rank: the slice holds nothing but the
        // rank's own commands and what they left behind (a `setsid` daemon of the stop
        // command, say). Only a stop ends it; status and health checks never kill anything.
        if let Err(error) = runtime.stop_slice(&rank_slice(job), deadline) {
            tracing::warn!(
                instance_id = job.instance_id,
                rank = job.rank,
                error = %format!("{error:#}"),
                "stopping the rank's slice failed"
            );
        }
        for (unit, error) in failed_units {
            // The process is already gone (the unit was relaunched under another invocation,
            // or its leftovers cannot be stopped): an empty process tree is the proof.
            // Anything still running keeps the stop unproven.
            anyhow::ensure!(!runtime.tasks_alive(&unit, deadline)?, error);
        }
        // A stop command that exits at once (`true`) leaves nothing to wait for once the
        // proof holds; a status command that keeps saying "alive" does not hold a process
        // runtime's stop until its deadline. Checks back off to one every 5 seconds.
        let mut pause = Duration::from_millis(250);
        loop {
            if runtime.cancelled() {
                return Err(fail(JobError::SessionDisconnected));
            }
            let reason = match self.stop_unproven(job, runtime, deadline, true) {
                Ok(None) => break,
                Ok(Some(reason)) => reason,
                // Out of time inside a check: the same answer as out of time between checks.
                Err(_) if deadline.remaining().is_err() && !runtime.cancelled() => "deadline",
                Err(error) => return Err(error),
            };
            pause = (pause * 2).min(Duration::from_secs(5));
            if deadline.sleep(pause).is_err() {
                tracing::warn!(
                    instance_id = job.instance_id,
                    rank = job.rank,
                    reason,
                    "the stop could not be proven"
                );
                return Ok(None);
            }
        }
        deadline.remaining()?;
        runtime.forget_slice(&rank_slice(job), deadline);
        let now = (self.clock)();
        let record = self.state.records.get_mut(&key).context("record")?;
        record.clear_invocations();
        record.phase = InstancePhase::Stopped;
        record.stopped_at = Some(now);
        Ok(Some(Outcome::ok(true)))
    }

    fn adopt_launch(
        &mut self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Result<Outcome> {
        let unit = phase_unit(job);
        let identity = runtime
            .launch_completed(job, &self.state.owner_id, deadline)?
            .context("launch outcome unknown")?;
        self.state
            .records
            .get_mut(&job.key())
            .context("record")?
            .invocations
            .insert(unit, identity);
        self.complete(job, Outcome::ok(false))
    }

    /// Read-only observation can settle an ambiguous launch after a restart.
    pub fn reconcile(&mut self, runtime: &impl Runtime, deadline: Deadline) {
        let pending = self
            .state
            .records
            .values()
            .filter_map(|record| record.pending.clone())
            .collect::<Vec<_>>();
        for job in pending {
            if matches!(
                job.action,
                JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
            ) && !job.command.trim().is_empty()
            {
                let _ = self.adopt_launch(&job, runtime, deadline);
            }
        }
    }

    fn complete(&mut self, job: &Job, outcome: Outcome) -> Result<Outcome> {
        let record = self.state.records.get_mut(&job.key()).context("record")?;
        if record.completed.len() >= COMPLETED_LIMIT {
            let transient = record
                .completed
                .iter()
                .find(|(_, done)| matches!(done.action, JobPhase::Health | JobPhase::Status))
                .map(|(id, _)| id.clone())
                .or_else(|| record.completed.keys().next().cloned());
            if let Some(id) = transient {
                record.completed.remove(&id);
            }
        }
        record.completed.insert(
            job.step_id.clone(),
            Completed {
                hash: job.intent_hash.clone(),
                outcome: outcome.clone(),
                action: job.action,
            },
        );
        record.outside_units |= record
            .invocations
            .values()
            .any(|invocation| outside(invocation));
        record.pending = None;
        record.observed_step = job.step_id.clone();
        record.observed_hash = job.intent_hash.clone();
        self.persist()?;
        Ok(outcome)
    }

    /// What the inventory reports for this file's ranks, verified against
    /// the machine: `ready` only while every owned unit is the one launched.
    pub fn observations(
        &self,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Vec<(Job, InstanceRecord)> {
        self.state
            .records
            .values()
            .map(|record| {
                let job = &record.job;
                let owned = !record.invocations.is_empty()
                    && record.invocations.iter().all(|(unit, identity)| {
                        if identity == "external" || identity == "self-detached" {
                            return job.status_command.as_deref().is_some_and(|status| {
                                runtime
                                    .status_until(job, status, deadline.cap(Duration::from_secs(5)))
                                    .is_ok_and(|alive| alive)
                            });
                        }
                        runtime
                            .identity(unit, &self.state.owner_id, deadline)
                            .is_ok_and(|seen| seen.as_ref() == Some(identity))
                    })
                    && (job.management() != Management::Process
                        || serving_confirmed(record, &self.state.owner_id, runtime, deadline)
                            .is_ok_and(|alive| alive));
                // `stopped` releases a claim on the server: reported only while the stop is
                // proven afresh, never from empty units alone.
                let absent = record.phase == InstancePhase::Stopped
                    && owned_units(job).iter().all(|unit| {
                        runtime
                            .identity(unit, &self.state.owner_id, deadline)
                            .is_ok_and(|seen| seen.is_none())
                    })
                    && matches!(self.stop_unproven(job, runtime, deadline, false), Ok(None));
                let phase = if absent {
                    InstancePhase::Stopped
                } else if record.pending.is_some() || !owned {
                    InstancePhase::Unknown
                } else {
                    record.phase
                };
                (
                    job.clone(),
                    InstanceRecord {
                        instance_id: job.instance_id.clone(),
                        launch_version_id: job.version_id.clone(),
                        launch_hash: job.launch_hash.clone(),
                        rank: job.rank,
                        intent_hash: record.observed_hash.clone(),
                        step_id: Some(record.observed_step.clone()),
                        phase,
                        unit_name: job.unit_name.clone(),
                        port: job.port,
                        handle: job.handle.clone(),
                        models: job.models(),
                        engine_facts: None,
                    },
                )
            })
            .collect()
    }
}

/// One rank as its record holds it (what `wsmp runtime list` and `wsmp status`
/// show). Nothing here was checked against the machine.
#[derive(Debug, Clone)]
pub struct RankView {
    pub job: Job,
    pub phase: InstancePhase,
    /// The step still unresolved on this rank, when one is.
    pub pending: Option<JobPhase>,
    /// The units the run was launched in (`external` and `self-detached`
    /// steps ran outside units and are not listed).
    pub units: Vec<String>,
}

impl Executor {
    /// Every rank this file records, as recorded.
    pub fn ranks(&self) -> Vec<RankView> {
        self.state
            .records
            .values()
            .map(|record| RankView {
                job: record.job.clone(),
                phase: record.phase,
                pending: record.pending.as_ref().map(|pending| pending.action),
                units: record
                    .invocations
                    .iter()
                    .filter(|(_, invocation)| !outside(invocation))
                    .map(|(unit, _)| unit.clone())
                    .collect(),
            })
            .collect()
    }

    /// The stop proof as the inventory asks it (no status command runs):
    /// `None` when the rank is proven stopped, else why not.
    pub fn stop_unproven_now(
        &self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Result<Option<&'static str>> {
        self.stop_unproven(job, runtime, deadline, false)
    }
}

/// The directory of instance records (`<state>/runtime-instances`).
pub fn instances_dir() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(INSTANCES_DIR))
}

/// Every instance record file in `dir`, read without a lock and without
/// changing anything: expired stopped records are skipped, not removed.
/// Files that cannot be read are named in the second list.
pub fn read_all(dir: &std::path::Path) -> (Vec<Executor>, Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (Vec::new(), Vec::new());
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    let mut executors = Vec::new();
    let mut unreadable = Vec::new();
    for path in paths {
        match Executor::load(path.clone()) {
            Ok(executor) if executor.expired() => {}
            Ok(executor) => executors.push(executor),
            Err(error) => unreadable.push(format!("`{}`: {error:#}", path.display())),
        }
    }
    (executors, unreadable)
}

/// The machine as an interactive step sees it once a person's run of its
/// command exited 0 (or status showed it is not needed): that run was the
/// launch. A prepare is done; a start or after-join counts only once its
/// status command shows the service alive (recorded as `external`, so every
/// later check asks status). Everything else is the inner runtime.
pub struct OperatorRan<'a, R: Runtime> {
    pub inner: &'a R,
}

impl<R: Runtime> OperatorRan<'_, R> {
    fn launched(&self, job: &Job, deadline: Deadline) -> Result<String> {
        if job.action == JobPhase::Prepare {
            return Ok("external".to_owned());
        }
        let status = job
            .status_command
            .as_deref()
            .ok_or_else(|| fail(JobError::LaunchUnconfirmed))?;
        if wait_for_status(job, self.inner, status, true, deadline)? {
            Ok("external".to_owned())
        } else {
            Err(fail(JobError::LaunchUnconfirmed))
        }
    }
}

impl<R: Runtime> Runtime for OperatorRan<'_, R> {
    fn cancelled(&self) -> bool {
        self.inner.cancelled()
    }
    fn contains_ranks(&self) -> bool {
        self.inner.contains_ranks()
    }
    fn launch(&self, job: &Job, _owner: &str, _unit: &str, deadline: Deadline) -> Result<String> {
        self.launched(job, deadline)
    }
    fn identity(&self, unit: &str, owner: &str, deadline: Deadline) -> Result<Option<String>> {
        self.inner.identity(unit, owner, deadline)
    }
    fn launch_completed(
        &self,
        job: &Job,
        _owner: &str,
        deadline: Deadline,
    ) -> Result<Option<String>> {
        self.launched(job, deadline).map(Some)
    }
    fn shell_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<()> {
        // An interactive stop's command already ran in its operator terminal
        // (or status showed it is not needed): never run it again here.
        if job.action == JobPhase::Stop && command == job.stop_command {
            return Ok(());
        }
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
        self.inner.tasks_alive(unit, deadline)
    }
    fn port_free(&self, host: &str, port: u16) -> bool {
        self.inner.port_free(host, port)
    }
    fn forget_slice(&self, slice: &str, deadline: Deadline) {
        self.inner.forget_slice(slice, deadline);
    }
    fn stop_slice(&self, slice: &str, deadline: Deadline) -> Result<()> {
        self.inner.stop_slice(slice, deadline)
    }
}

/// Polls `status` until it shows `alive == want`; a failed probe is no answer.
fn wait_for_status(
    job: &Job,
    runtime: &impl Runtime,
    status: &str,
    want: bool,
    deadline: Deadline,
) -> Result<bool> {
    loop {
        if runtime.cancelled() {
            return Err(fail(JobError::SessionDisconnected));
        }
        if deadline.remaining().is_err() {
            return Ok(false);
        }
        if runtime
            .status_until(job, status, deadline.cap(Duration::from_secs(30)))
            .is_ok_and(|alive| alive == want)
        {
            return Ok(true);
        }
        if deadline.sleep(Duration::from_millis(500)).is_err() {
            return Ok(false);
        }
    }
}

/// One readiness/health probe: the health command, else HTTP readiness,
/// else the status command.
fn probe_once(
    job: &Job,
    runtime: &impl Runtime,
    deadline: Deadline,
) -> std::result::Result<(), HealthMiss> {
    let command = |health: &str| {
        runtime
            .shell_until(job, health, deadline)
            .map_err(|_| HealthMiss::CommandFailed)
    };
    if job.action != JobPhase::Readiness
        && let Some(health) = job.health_command.as_deref()
    {
        return command(health);
    }
    if job.readiness().is_some() {
        return runtime.healthy_until(job, deadline);
    }
    if let Some(health) = job.health_command.as_deref() {
        return command(health);
    }
    let alive = job.status_command.as_deref().is_some_and(|status| {
        runtime
            .status_until(job, status, deadline)
            .is_ok_and(|alive| alive)
    });
    if alive {
        Ok(())
    } else {
        Err(HealthMiss::StatusNotRunning)
    }
}

/// Whether the serving process is up: a status proof for a service the node
/// did not start itself, else its own unit.
fn serving_confirmed(
    record: &Record,
    owner: &str,
    runtime: &impl Runtime,
    deadline: Deadline,
) -> Result<bool> {
    let serving = record.invocations.get(&phase_unit(&record.job));
    if matches!(
        serving.map(String::as_str),
        Some("external" | "self-detached")
    ) {
        let status = record
            .job
            .status_command
            .as_deref()
            .context("external service requires status proof")?;
        return runtime.status_until(&record.job, status, deadline.cap(Duration::from_secs(30)));
    }
    let mut start = record.job.clone();
    start.action = JobPhase::Start;
    Ok(runtime.launch_completed(&start, owner, deadline)?.is_some())
}

pub fn phase_unit(job: &Job) -> String {
    match job.action {
        JobPhase::Prepare => format!("{}-prepare", job.unit_name),
        JobPhase::AfterJoin => format!("{}-after-join", job.unit_name),
        _ => job.unit_name.clone(),
    }
}

/// A run the node did not start in a unit of its own.
fn outside(invocation: &str) -> bool {
    invocation == "external" || invocation == "self-detached"
}

/// The systemd user slice every command of the rank runs in (`wsmp_i_<id>_r<rank>.slice`; no
/// `-`, which would nest it in parent slices that outlive it): the stop proof requires it
/// empty, so nothing a command left behind (forked, `setsid`) escapes the proof.
pub fn rank_slice(job: &Job) -> String {
    format!("{}.slice", job.unit_name.replace('-', "_"))
}

fn owned_units(job: &Job) -> [String; 3] {
    [
        job.unit_name.clone(),
        format!("{}-prepare", job.unit_name),
        format!("{}-after-join", job.unit_name),
    ]
}

/// The variables that limit a command to the rank's GPUs (NVIDIA CUDA, AMD ROCm/HIP).
pub const GPU_VISIBILITY_ENV: [&str; 2] = ["CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES"];

/// The environment every runtime command gets on top of the scrubbed
/// parent environment: the definition's node secrets and, on a placed rank,
/// its GPUs. CUDA numbers devices fastest-first by default; `PCI_BUS_ID`
/// makes its N the `nvidia-smi` index N that `nvidia:N` names.
/// Errors name a missing secret, never a value.
pub fn command_env(job: &Job) -> Result<Vec<(String, String)>> {
    let (mut found, missing) = crate::secrets::values(&job.secrets);
    if let Some(name) = missing.first() {
        return Err(fail(JobError::LocalConfigUnavailable)).with_context(|| {
            format!("node secret `{name}` is not set; run `wsmp secret set {name}`")
        });
    }
    if let Some(ids) = &job.gpu_ids {
        found.push(("CUDA_DEVICE_ORDER".to_string(), "PCI_BUS_ID".to_string()));
        for name in GPU_VISIBILITY_ENV {
            found.push((name.to_string(), ids.clone()));
        }
    }
    Ok(found)
}

#[cfg(unix)]
pub use native::NativeRuntime;

#[cfg(unix)]
pub(crate) mod native;

#[cfg(test)]
mod tests;
