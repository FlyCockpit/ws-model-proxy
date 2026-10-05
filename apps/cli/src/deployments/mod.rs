//! Durable deployment execution. No chat/model output is captured or persisted.
//!
//! A record and pending step are fsynced before any external launch. Re-entry
//! observes owned units instead of replaying an ambiguous launch. Disconnect
//! never changes desired state; only an authorized job can start or stop.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::McpCommandMode;

const STATE_LIMIT: usize = 8 * 1024 * 1024;
/// Every action except stop must leave this much of `STATE_LIMIT` free, so a
/// stop's durable intent always fits: a stop never fails for state growth.
const STOP_RESERVE: usize = 2 * 1024 * 1024;
const COMPLETED_LIMIT: usize = 128;
/// Admission refuses a new instance record beyond this many records.
const RECORD_LIMIT: usize = 256;
/// A verified-stopped record keeps answering retries of its stop (the server
/// retries an unconfirmed stop a few times, each within 300 s) for this long,
/// unless state capacity is needed first.
const STOPPED_RETENTION_SECS: u64 = 60 * 60;
/// Largest byte length of any command in a job. Must equal
/// `DEPLOYMENT_COMMAND_MAX_BYTES` in `packages/config/src/deployment-protocol.ts`:
/// the server refuses longer recipe and rendered commands for this reason.
pub const DEPLOYMENT_COMMAND_MAX_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Prepare,
    Start,
    AfterJoin,
    Readiness,
    Health,
    Stop,
    Status,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Actor {
    User,
    Agent,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Engine {
    #[serde(rename = "vllm")]
    Vllm,
    #[serde(rename = "sglang")]
    Sglang,
    #[serde(rename = "llama.cpp")]
    LlamaCpp,
    #[serde(rename = "other")]
    Other,
}

/// Owner-authored service boundary. Shell spelling cannot establish ownership.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Management {
    #[serde(rename = "ownedProcess")]
    OwnedProcess,
    #[serde(rename = "externalService")]
    ExternalService,
}

/// A single monotonic budget, created on job admission, including queue time.
#[derive(Clone, Copy, Debug)]
pub struct Deadline(Instant);

impl Deadline {
    pub fn new(timeout: Duration) -> Self {
        let now = Instant::now();
        Self(
            now.checked_add(timeout.min(Duration::from_millis(900_000)))
                .unwrap_or(now),
        )
    }
    fn remaining(self) -> Result<Duration> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        anyhow::ensure!(!remaining.is_zero(), "deployment deadline expired");
        Ok(remaining)
    }
    fn sleep(self, duration: Duration) -> Result<()> {
        std::thread::sleep(duration.min(self.remaining()?));
        self.remaining()?;
        Ok(())
    }
    fn cap(self, duration: Duration) -> Self {
        Self(self.0.min(Instant::now() + duration))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddingContract {
    pub model: String,
    pub revision: String,
    pub dimensions: u32,
    pub normalization: String,
    pub vector_space: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Readiness {
    pub path: String,
    pub expected_status: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Health {
    pub interval_ms: u64,
    pub failure_threshold: u32,
    pub success_threshold: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub step_id: String,
    pub instance_id: String,
    pub revision_id: String,
    pub rank: u32,
    pub action: Action,
    pub intent_hash: String,
    pub owner_epoch: String,
    pub actor: Actor,
    pub human_approved: bool,
    pub attachment: String,
    pub engine: Engine,
    pub management: Management,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_contract: Option<EmbeddingContract>,
    pub command: String,
    #[serde(default)]
    pub stop_command: Option<String>,
    #[serde(default)]
    pub status_command: Option<String>,
    #[serde(default)]
    pub health_command: Option<String>,
    pub timeout_ms: u64,
    pub unit_name: String,
    pub port: u16,
    pub endpoint_slug: String,
    pub models: Vec<String>,
    pub context_window: Option<u64>,
    pub readiness: Readiness,
    pub health: Health,
}

impl Job {
    pub fn validate(&self) -> Result<()> {
        fn id(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }
        anyhow::ensure!(
            self.frame_type == "deployment.job"
                && id(&self.step_id)
                && id(&self.instance_id)
                && id(&self.revision_id)
                && id(&self.owner_epoch),
            "bad deployment identity"
        );
        anyhow::ensure!(
            self.rank < 64
                && self.instance_id.bytes().all(|b| b.is_ascii_alphanumeric())
                && self.unit_name == format!("wsmp-i-{}-r{}", self.instance_id, self.rank),
            "bad deployment unit"
        );
        anyhow::ensure!(
            self.intent_hash.len() == 64
                && self
                    .intent_hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "bad deployment hash"
        );
        anyhow::ensure!(
            self.port > 0
                && self.endpoint_slug.starts_with("inst-")
                && crate::slug::validate_slug(&self.endpoint_slug).is_ok(),
            "bad deployment endpoint"
        );
        anyhow::ensure!(
            !self.models.is_empty()
                && self.models.len() <= 64
                && self
                    .models
                    .iter()
                    .all(|m| !m.is_empty() && m.len() <= 256 && !m.contains('\0')),
            "bad deployment models"
        );
        anyhow::ensure!(
            matches!(self.attachment.as_str(), "llm" | "embeddings"),
            "bad deployment attachment"
        );
        anyhow::ensure!(
            (5_000..=300_000).contains(&self.health.interval_ms)
                && (1..=20).contains(&self.health.failure_threshold)
                && (1..=20).contains(&self.health.success_threshold),
            "bad deployment health policy"
        );
        anyhow::ensure!(
            self.readiness.path.starts_with('/')
                && !self.readiness.path.starts_with("//")
                && self.readiness.path.len() <= 2048
                && !self.readiness.path.contains(['\r', '\n', '#'])
                && (200..=399).contains(&self.readiness.expected_status),
            "bad deployment readiness"
        );
        let maximum = match self.action {
            Action::Start | Action::Prepare | Action::AfterJoin | Action::Readiness => 900_000,
            Action::Stop => 300_000,
            _ => 30_000,
        };
        anyhow::ensure!(
            (1..=maximum).contains(&self.timeout_ms),
            "bad deployment timeout"
        );
        for command in [
            &self.command,
            self.stop_command.as_deref().unwrap_or(""),
            self.status_command.as_deref().unwrap_or(""),
            self.health_command.as_deref().unwrap_or(""),
        ] {
            anyhow::ensure!(
                command.len() <= DEPLOYMENT_COMMAND_MAX_BYTES,
                "deployment command is longer than {DEPLOYMENT_COMMAND_MAX_BYTES} bytes"
            );
            crate::child_env::validate_command(command).map_err(anyhow::Error::msg)?;
        }
        if self.management == Management::ExternalService {
            anyhow::ensure!(
                self.stop_command
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty())
                    && self
                        .status_command
                        .as_ref()
                        .is_some_and(|s| !s.trim().is_empty()),
                "external service requires stop and status proof"
            );
        }
        if let Some(contract) = &self.embedding_contract {
            anyhow::ensure!(
                contract.dimensions > 0
                    && contract.dimensions <= 1_000_000
                    && matches!(contract.normalization.as_str(), "none" | "l2")
                    && [&contract.model, &contract.revision, &contract.vector_space]
                        .iter()
                        .all(|v| !v.trim().is_empty() && v.len() <= 256),
                "bad embedding contract"
            );
        }
        Ok(())
    }
    fn key(&self) -> String {
        format!("{}:{}", self.instance_id, self.rank)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub step_id: String,
    pub instance_id: String,
    pub rank: u32,
    pub intent_hash: String,
    pub owner_epoch: String,
    pub status: String,
    pub stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl JobResult {
    pub fn failure(job: &Job, code: &str) -> Self {
        Self::new(job, false, false, Some(code))
    }
    fn new(job: &Job, succeeded: bool, stopped: bool, error: Option<&str>) -> Self {
        Self {
            frame_type: "deployment.job.result".into(),
            step_id: job.step_id.clone(),
            instance_id: job.instance_id.clone(),
            rank: job.rank,
            intent_hash: job.intent_hash.clone(),
            owner_epoch: job.owner_epoch.clone(),
            status: if succeeded { "succeeded" } else { "failed" }.into(),
            stopped,
            error: error.map(str::to_owned),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Observed {
    pub step_id: String,
    pub instance_id: String,
    pub revision_id: String,
    pub rank: u32,
    pub intent_hash: String,
    pub phase: String,
    pub unit_name: String,
    pub port: u16,
    pub endpoint_slug: String,
    pub models: Vec<String>,
    pub context_window: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Completed {
    hash: String,
    result: JobResult,
    action: Action,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    job: Job,
    phase: String,
    /// Exact systemd invocation identity, not a reusable unit name or PID.
    invocations: BTreeMap<String, String>,
    pending: Option<Job>,
    completed: BTreeMap<String, Completed>,
    /// Last verified successful action; pending actions do not overwrite it.
    observed_step: String,
    observed_hash: String,
    #[serde(default)]
    consecutive_health_failures: u32,
    #[serde(default)]
    consecutive_health_successes: u32,
    /// Unix seconds when a stop was verified; `None` while not stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stopped_at: Option<u64>,
}

impl Record {
    /// Verified stopped with nothing unresolved: no owned invocation and no
    /// pending action that could have had an external effect (a failed
    /// read-only readiness/health/status check has none). Only such a record
    /// may ever be pruned.
    fn terminal(&self) -> bool {
        self.phase == "stopped"
            && self.invocations.is_empty()
            && self.pending.as_ref().is_none_or(|pending| {
                matches!(
                    pending.action,
                    Action::Readiness | Action::Health | Action::Status
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

pub struct Executor {
    path: PathBuf,
    state: State,
    /// Wall clock in Unix seconds; replaced only by tests.
    clock: fn() -> u64,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub trait Runtime {
    fn cancelled(&self) -> bool {
        false
    }
    fn launch(
        &self,
        job: &Job,
        owner: &str,
        phase_unit: &str,
        deadline: Deadline,
    ) -> Result<String>;
    fn identity(&self, unit: &str, owner: &str, deadline: Deadline) -> Result<Option<String>>;
    fn launch_completed(
        &self,
        job: &Job,
        owner: &str,
        deadline: Deadline,
    ) -> Result<Option<String>> {
        self.identity(&phase_unit(job), owner, deadline)
    }
    fn shell(&self, command: &str, timeout: Duration) -> Result<()>;
    fn shell_until(&self, command: &str, deadline: Deadline) -> Result<()> {
        self.shell(command, deadline.remaining()?)
    }
    /// true means alive; false means positively observed stopped; errors are
    /// unknown, never proof of absence. Status scripts use exit0 / exit3.
    fn status(&self, command: &str, timeout: Duration) -> Result<bool>;
    fn status_until(&self, command: &str, deadline: Deadline) -> Result<bool> {
        self.status(command, deadline.remaining()?)
    }
    fn stop(&self, unit: &str, owner: &str, invocation: &str, deadline: Deadline) -> Result<()>;
    fn healthy(&self, job: &Job, timeout: Duration) -> bool;
    fn healthy_until(&self, job: &Job, deadline: Deadline) -> bool {
        deadline
            .remaining()
            .is_ok_and(|remaining| self.healthy(job, remaining))
    }
}

impl Executor {
    pub fn load(path: PathBuf) -> Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(nix::libc::O_NOFOLLOW);
        }
        let state = match options.open(&path) {
            Ok(file) => {
                anyhow::ensure!(
                    file.metadata()?.is_file(),
                    "deployment state is not a regular file"
                );
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let metadata = file.metadata()?;
                    anyhow::ensure!(
                        metadata.uid() == nix::unistd::Uid::effective().as_raw()
                            && metadata.mode() & 0o077 == 0,
                        "deployment state permissions are unsafe"
                    );
                }
                let mut bytes = Vec::new();
                file.take(STATE_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .context("reading deployment state")?;
                anyhow::ensure!(bytes.len() <= STATE_LIMIT, "deployment state too large");
                let state: State =
                    serde_json::from_slice(&bytes).context("reading deployment state")?;
                anyhow::ensure!(state.version == 1, "unsupported deployment state version");
                for record in state.records.values() {
                    record.job.validate()?;
                    if let Some(pending) = &record.pending {
                        pending.validate()?;
                    }
                }
                anyhow::ensure!(
                    state.owner_id.len() == 24
                        && state.owner_id.bytes().all(|b| b.is_ascii_alphanumeric()),
                    "bad deployment owner"
                );
                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State {
                version: 1,
                owner_id: rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 24),
                records: BTreeMap::new(),
            },
            Err(error) => return Err(error).context("reading deployment state"),
        };
        Ok(Self {
            path,
            state,
            clock: unix_now,
        })
    }

    /// Removes verified-stopped records past their retention. A record with
    /// no stop time (written before stop times were kept) starts its
    /// retention now.
    fn prune_expired(&mut self, keep: &str) {
        let now = (self.clock)();
        self.state.records.retain(|key, record| {
            if key == keep || !record.terminal() {
                return true;
            }
            let stopped_at = *record.stopped_at.get_or_insert(now);
            now.saturating_sub(stopped_at) < STOPPED_RETENTION_SECS
        });
    }

    /// Verified-stopped records other than `keep`, oldest stop first.
    fn terminal_by_age(&self, keep: &str) -> Vec<String> {
        let mut terminal = self
            .state
            .records
            .iter()
            .filter(|(key, record)| key.as_str() != keep && record.terminal())
            .map(|(key, record)| (record.stopped_at.unwrap_or(0), key.clone()))
            .collect::<Vec<_>>();
        terminal.sort();
        terminal.into_iter().map(|(_, key)| key).collect()
    }

    /// Evicts the oldest verified-stopped records other than `keep` until
    /// about `excess` encoded bytes are freed. Returns whether any went.
    fn evict_terminal_bytes(&mut self, mut excess: usize, keep: &str) -> bool {
        let mut evicted = false;
        for key in self.terminal_by_age(keep) {
            if excess == 0 {
                break;
            }
            if let Some(record) = self.state.records.remove(&key) {
                // `"key":` plus a separator around the record's own encoding.
                let size = serde_json::to_vec(&record).map_or(0, |bytes| bytes.len());
                excess = excess.saturating_sub(size + key.len() + 4);
                evicted = true;
            }
        }
        evicted
    }

    /// Writes state no larger than `limit`, first dropping expired stopped
    /// records, then the oldest stopped records, then transient health/status
    /// replay history (re-running a read-only check is harmless). Nothing that
    /// a launch or an unconfirmed stop depends on is ever dropped.
    fn persist_within(&mut self, limit: usize, keep: &str) -> Result<()> {
        self.prune_expired(keep);
        let mut bytes = serde_json::to_vec(&self.state).context("encoding deployment state")?;
        while bytes.len() > limit && self.evict_terminal_bytes(bytes.len() - limit, keep) {
            bytes = serde_json::to_vec(&self.state).context("encoding deployment state")?;
        }
        if bytes.len() > limit {
            for record in self.state.records.values_mut() {
                record
                    .completed
                    .retain(|_, done| !matches!(done.action, Action::Health | Action::Status));
            }
            bytes = serde_json::to_vec(&self.state).context("encoding deployment state")?;
        }
        anyhow::ensure!(bytes.len() <= limit, "deployment state too large");
        crate::approvals::write_private_atomic(&self.path, &bytes, "deployment state", false)?;
        Ok(())
    }

    /// Makes room for a new instance record or refuses it. Refusing a new
    /// instance is safe; refusing a stop is not, so stops never come here.
    fn admit_record(&mut self, keep: &str) -> Result<()> {
        self.prune_expired(keep);
        let excess = (self.state.records.len() + 1).saturating_sub(RECORD_LIMIT);
        for key in self.terminal_by_age(keep).into_iter().take(excess) {
            self.state.records.remove(&key);
        }
        anyhow::ensure!(
            self.state.records.len() < RECORD_LIMIT,
            "deployment state full"
        );
        Ok(())
    }

    /// Caller owns the process-wide execution mutex and cross-process state
    /// lock. Authorization is fresh for every entry, including deduplicated jobs.
    pub fn execute(
        &mut self,
        job: Job,
        enabled: bool,
        mode: McpCommandMode,
        runtime: &impl Runtime,
    ) -> JobResult {
        let deadline = Deadline::new(Duration::from_millis(job.timeout_ms));
        self.execute_until(job, enabled, mode, runtime, deadline)
    }

    pub fn execute_until(
        &mut self,
        job: Job,
        enabled: bool,
        mode: McpCommandMode,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> JobResult {
        if job.validate().is_err() {
            return JobResult::failure(&job, "bad_job");
        }
        if !enabled {
            return JobResult::failure(&job, "feature_disabled");
        }
        if job.actor == Actor::Agent
            && (mode == McpCommandMode::Off
                || (mode == McpCommandMode::Supervised && !job.human_approved))
        {
            return JobResult::failure(&job, "command_mode_denied");
        }
        match self.execute_inner(&job, runtime, deadline) {
            Ok(result) => result,
            Err(_) => JobResult::failure(&job, "execution_unconfirmed"),
        }
    }

    fn execute_inner(
        &mut self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Result<JobResult> {
        deadline.remaining()?;
        anyhow::ensure!(!runtime.cancelled(), "session disconnected");
        let key = job.key();
        let mut admitted = false;
        if let Some(record) = self.state.records.get(&key) {
            anyhow::ensure!(
                record.job.revision_id == job.revision_id
                    && record.job.unit_name == job.unit_name
                    && record.job.port == job.port
                    && record.job.endpoint_slug == job.endpoint_slug
                    && record.job.engine == job.engine
                    && record.job.management == job.management
                    && record.job.stop_command == job.stop_command
                    && record.job.status_command == job.status_command
                    && record.job.attachment == job.attachment
                    && record.job.embedding_contract == job.embedding_contract
                    && record.job.models == job.models,
                "deployment identity mismatch"
            );
            if let Some(done) = record.completed.get(&job.step_id) {
                anyhow::ensure!(done.hash == job.intent_hash, "step intent changed");
                if done.action == Action::Stop {
                    anyhow::ensure!(record.phase == "stopped", "stale stopped result");
                    for unit in [
                        job.unit_name.clone(),
                        format!("{}-prepare", job.unit_name),
                        format!("{}-after-join", job.unit_name),
                    ] {
                        anyhow::ensure!(
                            runtime
                                .identity(&unit, &self.state.owner_id, deadline)?
                                .is_none(),
                            "stopped unit revived"
                        );
                    }
                    if let Some(status) = job
                        .status_command
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                    {
                        anyhow::ensure!(
                            !runtime.status_until(status, deadline.cap(Duration::from_secs(5)))?,
                            "stopped service revived"
                        );
                    }
                }
                let mut result = done.result.clone();
                result.owner_epoch = job.owner_epoch.clone();
                return Ok(result);
            }
            if let Some(pending) = &record.pending {
                anyhow::ensure!(
                    pending.step_id == job.step_id && pending.intent_hash == job.intent_hash
                        || job.action == Action::Stop,
                    "another action is unresolved"
                );
                // A launch can have happened before the CLI died. Never replay it.
                if matches!(
                    job.action,
                    Action::Prepare | Action::Start | Action::AfterJoin
                ) {
                    return self.adopt_launch(job, runtime, deadline);
                }
            }
        } else {
            anyhow::ensure!(
                !matches!(
                    job.action,
                    Action::Readiness | Action::Health | Action::Status | Action::Stop
                ),
                "instance is unknown"
            );
            self.admit_record(&key)?;
            admitted = true;
            self.state.records.insert(
                key.clone(),
                Record {
                    job: job.clone(),
                    phase: "unknown".into(),
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
        let record = self
            .state
            .records
            .get_mut(&key)
            .context("missing deployment record")?;
        if matches!(job.action, Action::Start | Action::AfterJoin) {
            anyhow::ensure!(
                !record.invocations.contains_key(&phase_unit(job)),
                "instance is already launched"
            );
        }
        if job.action == Action::Start {
            record.job = job.clone();
        }
        record.pending = Some(job.clone());
        if matches!(
            job.action,
            Action::Prepare | Action::Start | Action::AfterJoin
        ) {
            record.phase = "starting".into();
            // A (re)launch starts a new process: health hysteresis starts over with it, as on
            // the server, so an old streak cannot mark the new process unhealthy early.
            record.consecutive_health_failures = 0;
            record.consecutive_health_successes = 0;
            record.stopped_at = None;
        }
        if job.action == Action::Stop {
            record.phase = "stopping".into();
            record.stopped_at = None;
        }
        // Durable intent BEFORE external effects. Only a stop may use the
        // reserve, so state growth from other actions can never block a stop.
        let limit = if job.action == Action::Stop {
            STATE_LIMIT
        } else {
            STATE_LIMIT - STOP_RESERVE
        };
        if let Err(error) = self.persist_within(limit, &key) {
            if admitted {
                // Never leave an unpersisted, never-launched record behind.
                self.state.records.remove(&key);
            }
            return Err(error);
        }
        anyhow::ensure!(!runtime.cancelled(), "session disconnected");

        deadline.remaining()?;
        let outcome = match job.action {
            Action::Prepare | Action::Start | Action::AfterJoin => {
                let unit = phase_unit(job);
                let invocation = match runtime.launch(job, &self.state.owner_id, &unit, deadline) {
                    Ok(identity) => identity,
                    Err(error) => {
                        // A positive detached-status script cannot override a
                        // foreign unit ownership refusal or unavailable manager.
                        deadline.remaining()?;
                        let _ = runtime.identity(&unit, &self.state.owner_id, deadline)?;
                        anyhow::ensure!(
                            job.management == Management::ExternalService,
                            "owned launch unconfirmed"
                        );
                        let Some(status) = job.status_command.as_deref() else {
                            return Err(error);
                        };
                        anyhow::ensure!(
                            runtime.status_until(status, deadline.cap(Duration::from_secs(30)))?,
                            "detached launch is not alive"
                        );
                        "external".to_owned()
                    }
                };
                deadline.remaining()?;
                anyhow::ensure!(!runtime.cancelled(), "session disconnected");
                self.state
                    .records
                    .get_mut(&key)
                    .context("record")?
                    .invocations
                    .insert(unit, invocation);
                JobResult::new(job, true, false, None)
            }
            Action::Readiness => {
                anyhow::ensure!(
                    runtime
                        .launch_completed(
                            &self.state.records.get(&key).context("record")?.job,
                            &self.state.owner_id,
                            deadline
                        )?
                        .is_some(),
                    "serving process unconfirmed"
                );
                while !runtime.healthy_until(job, deadline.cap(Duration::from_secs(2))) {
                    anyhow::ensure!(!runtime.cancelled(), "session disconnected");
                    deadline.sleep(Duration::from_millis(200))?;
                }
                deadline.remaining()?;
                anyhow::ensure!(!runtime.cancelled(), "session disconnected");
                self.state.records.get_mut(&key).context("record")?.phase = "ready".into();
                JobResult::new(job, true, false, None)
            }
            Action::Health | Action::Status => {
                anyhow::ensure!(
                    runtime
                        .launch_completed(
                            &self.state.records.get(&key).context("record")?.job,
                            &self.state.owner_id,
                            deadline
                        )?
                        .is_some(),
                    "serving process unconfirmed"
                );
                let healthy = if !job.command.trim().is_empty() {
                    runtime.shell_until(&job.command, deadline).is_ok()
                } else {
                    runtime.healthy_until(job, deadline)
                };
                deadline.remaining()?;
                anyhow::ensure!(!runtime.cancelled(), "session disconnected");
                if job.action == Action::Health {
                    let record = self.state.records.get_mut(&key).context("record")?;
                    if healthy {
                        record.consecutive_health_failures = 0;
                        record.consecutive_health_successes =
                            record.consecutive_health_successes.saturating_add(1);
                        if record.consecutive_health_successes >= job.health.success_threshold {
                            record.phase = "ready".into();
                        }
                    } else {
                        record.consecutive_health_successes = 0;
                        record.consecutive_health_failures =
                            record.consecutive_health_failures.saturating_add(1);
                        if record.consecutive_health_failures >= job.health.failure_threshold {
                            record.phase = "unhealthy".into();
                        }
                    }
                }
                JobResult::new(
                    job,
                    healthy,
                    false,
                    if healthy { None } else { Some("unhealthy") },
                )
            }
            Action::Stop => {
                let record = self.state.records.get(&key).context("record")?;
                // A failed/empty start has never established the declared
                // backend boundary. Cleaning its wrapper cannot settle a
                // potentially detached backend or release its claims.
                anyhow::ensure!(
                    job.management != Management::OwnedProcess
                        || record.invocations.contains_key(&job.unit_name),
                    "owned backend launch was never confirmed"
                );
                // A pending launch may have executed before its reply was persisted.
                let mut units = record.invocations.clone();
                for unit in [
                    job.unit_name.clone(),
                    format!("{}-prepare", job.unit_name),
                    format!("{}-after-join", job.unit_name),
                ] {
                    if let Some(identity) =
                        runtime.identity(&unit, &self.state.owner_id, deadline)?
                    {
                        units.entry(unit).or_insert(identity);
                    }
                }
                if let Some(stop) = job.stop_command.as_deref().filter(|s| !s.trim().is_empty()) {
                    runtime.shell_until(stop, deadline)?;
                }
                for (unit, invocation) in units {
                    if invocation != "external" && invocation != "self-detached" {
                        runtime.stop(&unit, &self.state.owner_id, &invocation, deadline)?;
                    } else {
                        anyhow::ensure!(
                            job.status_command
                                .as_ref()
                                .is_some_and(|s| !s.trim().is_empty()),
                            "detached stop requires status proof"
                        );
                    }
                }
                if let Some(status) = job
                    .status_command
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                {
                    // External detached services are stopped only on a verified
                    // negative status, not missing record/disconnected socket.
                    anyhow::ensure!(
                        !runtime.status_until(status, deadline.cap(Duration::from_secs(30)))?,
                        "external service remains alive"
                    );
                }
                deadline.remaining()?;
                anyhow::ensure!(!runtime.cancelled(), "session disconnected");
                let now = (self.clock)();
                let record = self.state.records.get_mut(&key).context("record")?;
                record.invocations.clear();
                record.phase = "stopped".into();
                record.stopped_at = Some(now);
                JobResult::new(job, true, true, None)
            }
        };
        self.complete(job, outcome)
    }

    fn adopt_launch(
        &mut self,
        job: &Job,
        runtime: &impl Runtime,
        deadline: Deadline,
    ) -> Result<JobResult> {
        let unit = phase_unit(job);
        let identity = runtime
            .launch_completed(job, &self.state.owner_id, deadline)?
            .context("launch outcome unknown")?;
        deadline.remaining()?;
        anyhow::ensure!(!runtime.cancelled(), "session disconnected");
        self.state
            .records
            .get_mut(&job.key())
            .context("record")?
            .invocations
            .insert(unit, identity);
        self.complete(job, JobResult::new(job, true, false, None))
    }

    /// Read-only process observations can settle a durable ambiguous launch;
    /// they never launch/stop a process while disconnected.
    pub fn reconcile(&mut self, runtime: &impl Runtime) -> Result<()> {
        self.reconcile_until(runtime, Deadline::new(Duration::from_secs(30)))
    }

    pub fn reconcile_until(&mut self, runtime: &impl Runtime, deadline: Deadline) -> Result<()> {
        let pending = self
            .state
            .records
            .values()
            .filter_map(|record| record.pending.clone())
            .collect::<Vec<_>>();
        for job in pending {
            if matches!(
                job.action,
                Action::Prepare | Action::Start | Action::AfterJoin
            ) {
                let _ = self.adopt_launch(&job, runtime, deadline);
            }
        }
        Ok(())
    }

    fn complete(&mut self, job: &Job, result: JobResult) -> Result<JobResult> {
        let record = self.state.records.get_mut(&job.key()).context("record")?;
        if record.completed.len() >= COMPLETED_LIMIT
            && let Some(transient) = record
                .completed
                .iter()
                .find(|(_, done)| matches!(done.action, Action::Health | Action::Status))
                .map(|(id, _)| id.clone())
        {
            record.completed.remove(&transient);
        }
        anyhow::ensure!(
            record.completed.len() < COMPLETED_LIMIT || record.completed.contains_key(&job.step_id),
            "step history requires reconciliation"
        );
        record.completed.insert(
            job.step_id.clone(),
            Completed {
                hash: job.intent_hash.clone(),
                result: result.clone(),
                action: job.action,
            },
        );
        record.pending = None;
        record.observed_step = job.step_id.clone();
        record.observed_hash = job.intent_hash.clone();
        // An effect already happened: record it whenever it fits at all.
        self.persist_within(STATE_LIMIT, &job.key())?;
        Ok(result)
    }

    pub fn observations(&self, runtime: &impl Runtime) -> Vec<Observed> {
        self.observations_until(runtime, Deadline::new(Duration::from_secs(30)))
    }

    pub fn observations_until(&self, runtime: &impl Runtime, deadline: Deadline) -> Vec<Observed> {
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
                                    .status_until(status, deadline.cap(Duration::from_secs(5)))
                                    .is_ok_and(|alive| alive)
                            });
                        }
                        runtime
                            .identity(unit, &self.state.owner_id, deadline)
                            .is_ok_and(|seen| seen.as_ref() == Some(identity))
                    })
                    && runtime
                        .launch_completed(job, &self.state.owner_id, deadline)
                        .is_ok_and(|seen| seen.is_some());
                let absent = record.phase == "stopped"
                    && [
                        job.unit_name.clone(),
                        format!("{}-prepare", job.unit_name),
                        format!("{}-after-join", job.unit_name),
                    ]
                    .iter()
                    .all(|unit| {
                        runtime
                            .identity(unit, &self.state.owner_id, deadline)
                            .is_ok_and(|seen| seen.is_none())
                    })
                    && job
                        .status_command
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .is_none_or(|status| {
                            runtime
                                .status_until(status, deadline)
                                .is_ok_and(|alive| !alive)
                        });
                let phase = if absent {
                    "stopped"
                } else if record.pending.is_some() || !owned {
                    "unknown"
                } else {
                    record.phase.as_str()
                };
                Observed {
                    step_id: record.observed_step.clone(),
                    instance_id: job.instance_id.clone(),
                    revision_id: job.revision_id.clone(),
                    rank: job.rank,
                    intent_hash: record.observed_hash.clone(),
                    phase: phase.into(),
                    unit_name: job.unit_name.clone(),
                    port: job.port,
                    endpoint_slug: job.endpoint_slug.clone(),
                    models: job.models.clone(),
                    context_window: job.context_window,
                }
            })
            .collect()
    }

    pub fn published_jobs(&self, runtime: &impl Runtime) -> Vec<Job> {
        self.published_jobs_until(runtime, Deadline::new(Duration::from_secs(30)))
    }

    pub fn published_jobs_until(&self, runtime: &impl Runtime, deadline: Deadline) -> Vec<Job> {
        let observations = self.observations_until(runtime, deadline);
        self.state
            .records
            .values()
            .filter(|record| {
                record.job.rank == 0
                    && observations.iter().any(|o| {
                        o.instance_id == record.job.instance_id && o.rank == 0 && o.phase == "ready"
                    })
            })
            .map(|record| record.job.clone())
            .collect()
    }
}

fn phase_unit(job: &Job) -> String {
    match job.action {
        Action::Prepare => format!("{}-prepare", job.unit_name),
        Action::AfterJoin => format!("{}-after-join", job.unit_name),
        _ => job.unit_name.clone(),
    }
}

use rand::distr::SampleString;

#[cfg(unix)]
pub struct NativeRuntime {
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

#[cfg(target_os = "linux")]
fn manager_until(
    program: &str,
    args: &[String],
    deadline: Deadline,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String> {
    deadline.remaining()?;
    let mut invocation = vec![
        format!(
            "XDG_RUNTIME_DIR=/run/user/{}",
            nix::unistd::Uid::effective().as_raw()
        ),
        program.to_owned(),
    ];
    invocation.extend_from_slice(args);
    let bytes = crate::bounded_run::run_until("env", &invocation, deadline.0, 8192, cancel)
        .map_err(|_| anyhow::anyhow!("manager unavailable"))?;
    String::from_utf8(bytes).context("manager invalid output")
}

#[cfg(unix)]
impl Runtime for NativeRuntime {
    fn cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst))
            || crate::shutdown::requested().is_some()
    }
    fn launch(&self, job: &Job, owner: &str, unit: &str, deadline: Deadline) -> Result<String> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        #[cfg(target_os = "linux")]
        {
            let description = format!("wsmp-deployment:{owner}:{}:{}", job.instance_id, job.rank);
            let mut args = vec![
                "--user".into(),
                "--quiet".into(),
                "--no-block".into(),
                format!("--unit={unit}"),
                "--collect".into(),
                "--property=RemainAfterExit=yes".into(),
                format!("--description={description}"),
                "--property=StandardOutput=null".into(),
                "--property=StandardError=null".into(),
                "--property=KillMode=control-group".into(),
                "--property=Restart=no".into(),
                "--property=TasksAccounting=yes".into(),
                "--".into(),
                "/bin/sh".into(),
                "-c".into(),
                job.command.clone(),
            ];
            let synchronous = matches!(job.action, Action::Prepare | Action::AfterJoin);
            args.insert(
                2,
                if synchronous {
                    "--service-type=oneshot"
                } else {
                    "--service-type=exec"
                }
                .into(),
            );
            if synchronous {
                args.insert(2, "--property=TimeoutStartFailureMode=kill".into());
                args.insert(
                    2,
                    format!(
                        "--property=TimeoutStartSec={}ms",
                        deadline.remaining()?.as_millis().max(1)
                    ),
                );
            }
            let outcome = (|| {
                manager_until("systemd-run", &args, deadline, self.cancel.as_deref())?;
                loop {
                    if let Some(identity) = self.launch_completed(job, owner, deadline)? {
                        return Ok(identity);
                    }
                    anyhow::ensure!(!self.cancelled(), "launch incomplete");
                    deadline.sleep(Duration::from_millis(100))?;
                }
            })();
            if outcome.is_err() && self.cancelled() && deadline.remaining().is_ok() {
                // Cleanup is permitted on cancellation, within the ORIGINAL
                // budget. Do not let the cancel flag suppress its own cleanup.
                // A completed serving launch never enters this rollback path.
                let cleanup = NativeRuntime { cancel: None };
                if cleanup
                    .identity(unit, owner, deadline)
                    .is_ok_and(|seen| seen.is_some())
                {
                    let _ = manager_until(
                        "systemctl",
                        &[
                            "--user".into(),
                            "kill".into(),
                            "--kill-whom=all".into(),
                            "--signal=KILL".into(),
                            unit.into(),
                        ],
                        deadline,
                        None,
                    );
                }
            }
            outcome
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (owner, unit);
            anyhow::ensure!(
                job.status_command
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty()),
                "macos requires status command"
            );
            anyhow::ensure!(
                job.management == Management::ExternalService,
                "macos requires external service contract"
            );
            self.shell_until(&job.command, deadline)?;
            Ok("self-detached".into())
        }
    }
    fn identity(&self, unit: &str, owner: &str, deadline: Deadline) -> Result<Option<String>> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        #[cfg(target_os = "linux")]
        {
            let output = manager_until(
                "systemctl",
                &[
                    "--user".into(),
                    "show".into(),
                    unit.into(),
                    "--property=LoadState,ActiveState,Description,InvocationID,TasksCurrent,ControlGroup".into(),
                ],
                deadline,
                self.cancel.as_deref(),
            )?;
            let fields = output
                .lines()
                .filter_map(|line| line.split_once('='))
                .collect::<BTreeMap<_, _>>();
            if fields.get("LoadState") == Some(&"not-found")
                || (fields
                    .get("ActiveState")
                    .is_some_and(|s| matches!(*s, "inactive" | "failed"))
                    && (fields.get("TasksCurrent") == Some(&"0")
                        || fields.get("ControlGroup") == Some(&"")))
            {
                return Ok(None);
            }
            let base = unit
                .strip_suffix("-prepare")
                .or_else(|| unit.strip_suffix("-after-join"))
                .unwrap_or(unit);
            let (instance, rank) = base
                .strip_prefix("wsmp-i-")
                .and_then(|base| base.rsplit_once("-r"))
                .context("bad unit identity")?;
            let expected = format!("wsmp-deployment:{owner}:{instance}:{rank}");
            anyhow::ensure!(
                fields.get("Description") == Some(&expected.as_str()),
                "foreign unit"
            );
            let invocation = fields
                .get("InvocationID")
                .filter(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
                .context("missing unit invocation")?;
            Ok(Some((*invocation).to_string()))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (unit, owner);
            Ok(None)
        }
    }
    fn launch_completed(
        &self,
        job: &Job,
        owner: &str,
        deadline: Deadline,
    ) -> Result<Option<String>> {
        deadline.remaining()?;
        #[cfg(not(target_os = "linux"))]
        {
            let _ = owner;
            let status = job
                .status_command
                .as_deref()
                .context("detached status required")?;
            return Ok(self
                .status_until(status, deadline)?
                .then(|| "self-detached".into()));
        }
        #[cfg(target_os = "linux")]
        {
            let unit = phase_unit(job);
            let identity = self.identity(&unit, owner, deadline)?;
            if identity.is_none() {
                return Ok(None);
            }
            #[cfg(target_os = "linux")]
            if matches!(job.action, Action::Prepare | Action::AfterJoin) {
                let output = manager_until(
                    "systemctl",
                    &[
                        "--user".into(),
                        "show".into(),
                        unit,
                        "--property=SubState,ExecMainStatus".into(),
                    ],
                    deadline,
                    self.cancel.as_deref(),
                )?;
                let fields = output
                    .lines()
                    .filter_map(|line| line.split_once('='))
                    .collect::<BTreeMap<_, _>>();
                if fields.get("SubState") != Some(&"exited")
                    || fields.get("ExecMainStatus") != Some(&"0")
                {
                    return Ok(None);
                }
            } else if job.management == Management::OwnedProcess {
                let output = manager_until(
                    "systemctl",
                    &[
                        "--user".into(),
                        "show".into(),
                        unit,
                        "--property=TasksCurrent".into(),
                    ],
                    deadline,
                    self.cancel.as_deref(),
                )?;
                if !output
                    .trim()
                    .strip_prefix("TasksCurrent=")
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_some_and(|tasks| tasks > 0)
                {
                    return Ok(None);
                }
            } else {
                let status = job
                    .status_command
                    .as_deref()
                    .context("external status required")?;
                if !self.status_until(status, deadline)? {
                    return Ok(None);
                }
            }
            Ok(identity)
        }
    }
    fn shell(&self, command: &str, timeout: Duration) -> Result<()> {
        self.shell_until(command, Deadline::new(timeout))
    }
    fn shell_until(&self, command: &str, deadline: Deadline) -> Result<()> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        // Redirect before evaluating any caller command: no backend output can
        // reach a pipe, a journal, or the CLI's operational diagnostics.
        crate::bounded_run::run_until(
            "/bin/sh",
            &["-c".into(), format!("exec >/dev/null 2>&1; {command}")],
            deadline.0,
            0,
            self.cancel.as_deref(),
        )
        .map_err(|_| anyhow::anyhow!("command unconfirmed"))?;
        Ok(())
    }
    fn status(&self, command: &str, timeout: Duration) -> Result<bool> {
        self.status_until(command, Deadline::new(timeout))
    }
    fn status_until(&self, command: &str, deadline: Deadline) -> Result<bool> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        let script = format!(
            "( {command}\n) >/dev/null 2>&1; rc=$?; if [ \"$rc\" -eq 0 ]; then printf alive; elif [ \"$rc\" -eq 3 ]; then printf stopped; else printf unknown; fi"
        );
        let output = crate::bounded_run::run_until(
            "/bin/sh",
            &["-c".into(), script],
            deadline.0,
            16,
            self.cancel.as_deref(),
        )
        .map_err(|_| anyhow::anyhow!("status unconfirmed"))?;
        match output.as_slice() {
            b"alive" => Ok(true),
            b"stopped" => Ok(false),
            _ => anyhow::bail!("status unconfirmed"),
        }
    }
    fn stop(&self, unit: &str, owner: &str, invocation: &str, deadline: Deadline) -> Result<()> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        #[cfg(target_os = "linux")]
        {
            if let Some(current) = self.identity(unit, owner, deadline)? {
                anyhow::ensure!(current == invocation, "unit invocation changed");
                manager_until(
                    "systemctl",
                    &["--user".into(), "stop".into(), unit.into()],
                    deadline,
                    self.cancel.as_deref(),
                )?;
            }
            anyhow::ensure!(
                self.identity(unit, owner, deadline)?.is_none(),
                "unit remains alive"
            );
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (unit, owner, invocation);
        }
        Ok(())
    }
    fn healthy(&self, job: &Job, timeout: Duration) -> bool {
        self.healthy_until(job, Deadline::new(timeout))
    }
    fn healthy_until(&self, job: &Job, deadline: Deadline) -> bool {
        if self.cancelled() {
            return false;
        }
        let Ok(timeout) = deadline.remaining() else {
            return false;
        };
        if timeout.is_zero() {
            return false;
        }
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .new_agent();
        if deadline.remaining().is_err() || self.cancelled() {
            return false;
        }
        let healthy = agent
            .get(format!(
                "http://127.0.0.1:{}{}",
                job.port, job.readiness.path
            ))
            .call()
            .is_ok_and(|response| response.status().as_u16() == job.readiness.expected_status);
        healthy && !self.cancelled() && deadline.remaining().is_ok()
    }
}

pub fn state_path() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join("instances.json"))
}

#[derive(Default, Clone)]
struct Snapshot {
    instances: Vec<Observed>,
    published: Vec<Job>,
    endpoints: Vec<crate::config::EndpointConfig>,
}

fn snapshot() -> &'static std::sync::Mutex<Snapshot> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Snapshot>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(Snapshot::default()))
}

pub fn replace_snapshot(
    instances: Vec<Observed>,
    published: Vec<Job>,
    endpoints: Vec<crate::config::EndpointConfig>,
) {
    if let Ok(mut cache) = snapshot().lock() {
        *cache = Snapshot {
            instances,
            published,
            endpoints,
        };
    }
}

/// Runs before connecting, never on the socket reactor. Failure publishes no
/// endpoint: persisted ready is not a substitute for verified process liveness.
pub fn refresh_snapshot() -> Result<()> {
    #[cfg(unix)]
    {
        let path = state_path()?;
        let _lock = service::state_lock(&path)?;
        let mut executor = Executor::load(path)?;
        let runtime = NativeRuntime { cancel: None };
        executor.reconcile(&runtime)?;
        let published = executor.published_jobs(&runtime);
        let endpoints = probe_managed_jobs(&published);
        replace_snapshot(executor.observations(&runtime), published, endpoints);
    }
    Ok(())
}

pub struct EncodedSnapshot {
    pub id: String,
    pub frames: Vec<String>,
}

pub fn instances_frames() -> Result<EncodedSnapshot> {
    let mut instances = snapshot()
        .lock()
        .map(|cache| cache.instances.clone())
        .unwrap_or_default();
    instances.sort_by_key(|instance| instance.phase == "stopped");
    encode_instances(&instances)
}

fn encode_instances(instances: &[Observed]) -> Result<EncodedSnapshot> {
    anyhow::ensure!(instances.len() <= 65_536, "deployment inventory too large");
    let snapshot_id = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 32);
    let encode = |batch: &[&Observed], index: usize, final_chunk: bool| {
        serde_json::json!({"type":"deployment.instances", "snapshotId":snapshot_id, "chunkIndex":index, "final":final_chunk, "instances":batch}).to_string()
    };
    let mut frames = Vec::new();
    let mut total_bytes = 0;
    let mut batch = Vec::new();
    for instance in instances {
        batch.push(instance);
        let encoded = encode(&batch, frames.len(), false);
        if encoded.len() > crate::protocol::RELAY_JSON_CONTROL_MAX_BYTES || batch.len() > 512 {
            batch.pop();
            anyhow::ensure!(!batch.is_empty(), "deployment observation too large");
            let encoded = encode(&batch, frames.len(), false);
            total_bytes += encoded.len();
            anyhow::ensure!(
                total_bytes <= 8 * 1024 * 1024,
                "deployment inventory too large"
            );
            frames.push(encoded);
            batch.clear();
            batch.push(instance);
        }
    }
    if !batch.is_empty() || frames.is_empty() {
        let encoded = encode(&batch, frames.len(), true);
        anyhow::ensure!(
            encoded.len() <= crate::protocol::RELAY_JSON_CONTROL_MAX_BYTES,
            "deployment observation too large"
        );
        total_bytes += encoded.len();
        anyhow::ensure!(
            total_bytes <= 8 * 1024 * 1024,
            "deployment inventory too large"
        );
        frames.push(encoded);
    }
    Ok(EncodedSnapshot {
        id: snapshot_id,
        frames,
    })
}

pub fn managed_endpoints() -> Vec<crate::config::EndpointConfig> {
    snapshot()
        .lock()
        .map(|cache| cache.endpoints.clone())
        .unwrap_or_default()
}

fn endpoint_for(job: &Job) -> crate::config::EndpointConfig {
    let mut capabilities = if job.attachment == "embeddings" {
        crate::config::OpenAiCompatibleCapabilities::embedding_defaults()
    } else {
        crate::config::OpenAiCompatibleCapabilities::openai_defaults()
    };
    if let Some(embeddings) = capabilities.embeddings.as_mut() {
        embeddings.contract = job.embedding_contract.clone();
    }
    crate::config::EndpointConfig {
        slug: job.endpoint_slug.clone(),
        label: job.endpoint_slug.clone(),
        base_url: format!("http://127.0.0.1:{}", job.port),
        engine: match job.engine {
            Engine::Vllm => crate::config::EndpointEngine::Vllm,
            Engine::Sglang => crate::config::EndpointEngine::Sglang,
            Engine::LlamaCpp => crate::config::EndpointEngine::LlamaCpp,
            Engine::Other => crate::config::EndpointEngine::Generic,
        },
        default_capabilities: capabilities.clone(),
        models: job
            .models
            .iter()
            .map(|model| crate::config::ModelConfig {
                upstream_model_id: model.clone(),
                capabilities: Some(capabilities.clone()),
                pinned: true,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

/// Background-only native engine/count probing. A recipe engine declaration
/// is not proof that its native count route actually works.
pub fn probe_managed_jobs(jobs: &[Job]) -> Vec<crate::config::EndpointConfig> {
    let previous = managed_endpoints();
    jobs.iter()
        .map(|job| {
            let mut endpoint = endpoint_for(job);
            endpoint.last_probe = previous
                .iter()
                .find(|old| old.slug == endpoint.slug && old.engine == endpoint.engine)
                .and_then(|old| old.last_probe.clone());
            if endpoint.last_probe.is_none() && job.engine != Engine::Other {
                let report = crate::probe::probe_endpoint(&endpoint, false, &BTreeMap::new());
                endpoint.last_probe = Some(crate::config::ProbeSnapshot {
                    status: report.status,
                    models: job.models.clone(),
                    suggested_capabilities: endpoint.default_capabilities.clone(),
                    engine: report.engine,
                    adapter: None,
                });
            }
            endpoint
        })
        .collect()
}

pub fn managed_inventory() -> Vec<crate::protocol::EndpointInventory> {
    snapshot()
        .lock()
        .map(|cache| {
            cache
                .published
                .iter()
                .map(|job| {
                    let mut endpoint = crate::protocol::endpoint_inventory(
                        cache
                            .endpoints
                            .iter()
                            .find(|endpoint| endpoint.slug == job.endpoint_slug)
                            .unwrap_or(&endpoint_for(job)),
                        crate::protocol::EndpointStatus::Online,
                    );
                    endpoint.deployment_instance_id = Some(job.instance_id.clone());
                    for model in &mut endpoint.models {
                        model.engine_facts = Some(crate::protocol::EngineFacts {
                            max_model_len: job
                                .context_window
                                .map(crate::protocol::EngineFact::config),
                            ..Default::default()
                        });
                    }
                    endpoint
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn mechanism() -> &'static str {
    mechanism_until(Deadline::new(Duration::from_secs(10)), None)
}

pub fn mechanism_until(
    deadline: Deadline,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> &'static str {
    #[cfg(target_os = "linux")]
    {
        let uid = nix::unistd::Uid::effective().as_raw().to_string();
        let manager_running = manager_until(
            "systemctl",
            &["--user".into(), "is-system-running".into()],
            deadline,
            cancel,
        )
        .is_ok();
        if !manager_running {
            return "unsupported";
        }
        let linger = manager_until(
            "loginctl",
            &["show-user".into(), uid, "-p".into(), "Linger".into()],
            deadline,
            cancel,
        )
        .is_ok_and(|text| text.trim() == "Linger=yes");
        if linger {
            "systemd+linger"
        } else {
            "systemd-no-linger"
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (deadline, cancel);
        "macos"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (deadline, cancel);
        "unsupported"
    }
}

pub fn activation_supported(action: Action, mechanism: &str) -> bool {
    !matches!(action, Action::Prepare | Action::Start | Action::AfterJoin)
        || matches!(mechanism, "systemd+linger" | "macos")
}

#[cfg(unix)]
pub mod service;
#[cfg(test)]
mod tests;
