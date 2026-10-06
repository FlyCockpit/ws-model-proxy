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
}

impl Outcome {
    fn ok(stopped: bool) -> Self {
        Self {
            status: JobStatus::Succeeded,
            stopped,
            error: None,
        }
    }

    pub fn failed(error: JobError) -> Self {
        Self {
            status: JobStatus::Failed,
            stopped: false,
            error: Some(error),
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
}

impl Record {
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
    fn healthy_until(&self, job: &Job, deadline: Deadline) -> bool;
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
                let code = error
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
                    });
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
            // A new launch may change the version (a restart), but only while
            // nothing of the old one runs.
            anyhow::ensure!(
                record.job.identity_matches(job)
                    || (matches!(job.action, JobPhase::Prepare | JobPhase::Start)
                        && record.invocations.is_empty()),
                "instance identity changed"
            );
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
                    if let Some(status) = job.status_command.as_deref() {
                        anyhow::ensure!(
                            !runtime.status_until(
                                job,
                                status,
                                deadline.cap(Duration::from_secs(5))
                            )?,
                            "stopped service revived"
                        );
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
            if matches!(
                job.action,
                JobPhase::Readiness | JobPhase::Health | JobPhase::Status | JobPhase::Stop
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
                },
            );
        }
        let record = self.state.records.get_mut(&key).context("record")?;
        if matches!(job.action, JobPhase::Prepare | JobPhase::Start) {
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
                anyhow::ensure!(
                    serving_confirmed(
                        self.state.records.get(&key).context("record")?,
                        &self.state.owner_id,
                        runtime,
                        deadline
                    )?,
                    "serving process unconfirmed"
                );
                while !probe_once(job, runtime, deadline.cap(Duration::from_secs(10))) {
                    if runtime.cancelled() {
                        return Err(fail(JobError::SessionDisconnected));
                    }
                    deadline
                        .sleep(Duration::from_millis(500))
                        .map_err(|_| fail(JobError::ReadinessFailed))?;
                }
                self.state.records.get_mut(&key).context("record")?.phase = InstancePhase::Ready;
                Outcome::ok(false)
            }
            JobPhase::Health | JobPhase::Status => {
                anyhow::ensure!(
                    serving_confirmed(
                        self.state.records.get(&key).context("record")?,
                        &self.state.owner_id,
                        runtime,
                        deadline
                    )?,
                    "serving process unconfirmed"
                );
                let healthy = probe_once(job, runtime, deadline);
                deadline.remaining()?;
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
                if healthy {
                    Outcome::ok(false)
                } else {
                    Outcome::failed(JobError::HealthFailed)
                }
            }
            JobPhase::Stop => self
                .stop_teardown(job, runtime, deadline)?
                .context("service remains alive")?,
        };
        self.complete(job, outcome)
    }

    /// Run the stop command, stop every owned unit, then require status
    /// (when defined) to show the service stopped. `None`: still alive.
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
            if let Some(identity) = runtime.identity(&unit, &self.state.owner_id, deadline)? {
                units.entry(unit).or_insert(identity);
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
        for (unit, invocation) in units {
            if invocation != "external" && invocation != "self-detached" {
                runtime.stop(&unit, &self.state.owner_id, &invocation, deadline)?;
            } else {
                anyhow::ensure!(
                    job.status_command.is_some(),
                    "detached stop requires status proof"
                );
            }
        }
        if let Some(status) = job.status_command.as_deref() {
            let stopped = wait_for_status(job, runtime, status, false, deadline)?;
            if !stopped {
                return Ok(None);
            }
        }
        deadline.remaining()?;
        let now = (self.clock)();
        let record = self.state.records.get_mut(&key).context("record")?;
        record.invocations.clear();
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
                let absent = record.phase == InstancePhase::Stopped
                    && owned_units(job).iter().all(|unit| {
                        runtime
                            .identity(unit, &self.state.owner_id, deadline)
                            .is_ok_and(|seen| seen.is_none())
                    });
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
fn probe_once(job: &Job, runtime: &impl Runtime, deadline: Deadline) -> bool {
    if job.action != JobPhase::Readiness
        && let Some(health) = job.health_command.as_deref()
    {
        return runtime.shell_until(job, health, deadline).is_ok();
    }
    if job.readiness().is_some() {
        return runtime.healthy_until(job, deadline);
    }
    if let Some(health) = job.health_command.as_deref() {
        return runtime.shell_until(job, health, deadline).is_ok();
    }
    job.status_command.as_deref().is_some_and(|status| {
        runtime
            .status_until(job, status, deadline)
            .is_ok_and(|alive| alive)
    })
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

fn owned_units(job: &Job) -> [String; 3] {
    [
        job.unit_name.clone(),
        format!("{}-prepare", job.unit_name),
        format!("{}-after-join", job.unit_name),
    ]
}

/// The environment every runtime command gets on top of the scrubbed
/// parent environment: the job marker and the definition's node secrets.
/// Errors name a missing secret, never a value.
pub fn command_env(job: &Job) -> Result<Vec<(String, String)>> {
    let (found, missing) = crate::secrets::values(&job.secrets);
    if let Some(name) = missing.first() {
        return Err(fail(JobError::LocalConfigUnavailable)).with_context(|| {
            format!("node secret `{name}` is not set; run `wsmp secret set {name}`")
        });
    }
    Ok(found)
}

#[cfg(unix)]
pub use native::NativeRuntime;

#[cfg(unix)]
pub(crate) mod native;

#[cfg(test)]
mod tests;
