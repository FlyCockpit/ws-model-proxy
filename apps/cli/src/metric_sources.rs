//! Custom metric sources (relay 2.7 `node.metrics.custom`, S-B part 2).
//!
//! A source is a shell command that runs every `intervalSecs` and prints
//! numbers in one of three formats. Local sources come from the config file.
//! Remote sources arrive in `metrics.sources.set`; the daemon stores them in
//! `<state dir>/remote-metric-sources.json` and they run only when
//!
//! - the local opt-in `allowRemoteMetricSources` was on when wsmp started, and
//! - the person approved the exact command locally (`wsmp metrics approve`),
//!   which pins its SHA-256 in the config. A changed command string needs a
//!   new approval; until then the source does not run.
//!
//! Every run is bounded: its own process group (killed as a whole on
//! timeout), stdin closed, stderr discarded (never read, never uploaded),
//! stdout capped at [`OUTPUT_LIMIT`] bytes. Only numbers and names matching
//! `[A-Za-z0-9_.:-]{1,64}` leave the machine; command text and output never
//! do. Commands run as the OS user that runs wsmp.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::bounded_run::RunError;
use crate::config::{Config, MetricSourceConfig, MetricsConfig};
use crate::protocol::{
    CustomMetric, MetricSourceError, MetricSourceFormat, MetricSourceOrigin, MetricSourceState,
    MetricSourceStatus, NODE_METRICS_CUSTOM_MAX, NODE_METRICS_SOURCES_MAX, RemoteMetricSource,
};
use crate::telemetry::{is_label_key, is_metric_name};

/// Largest stdout a run may print; more is `output_too_large` and no values.
pub const OUTPUT_LIMIT: usize = 64 * 1024;
/// Most labels one series may carry.
pub const LABELS_MAX: usize = 16;
pub const INTERVAL_MIN_SECS: u32 = 5;
pub const INTERVAL_MAX_SECS: u32 = 86_400;
pub const TIMEOUT_MIN_SECS: u32 = 1;
pub const TIMEOUT_MAX_SECS: u32 = 300;
/// Series older than this many intervals are no longer reported.
pub const STALE_INTERVALS: u32 = 3;
/// Name prefixes the server reserves for built-in metrics.
pub const RESERVED_PREFIXES: [&str; 2] = ["node.", "endpoint."];
/// Remote definitions, in the state directory.
pub const REMOTE_SOURCES_FILE: &str = "remote-metric-sources.json";
/// How often the runner checks the config file for changed local sources or
/// approvals.
const RELOAD_CHECK_INTERVAL: Duration = Duration::from_secs(3);

/// One parsed series.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Series {
    pub name: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    pub value: f64,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn reserved(name: &str) -> bool {
    RESERVED_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn series(name: &str, labels: BTreeMap<String, String>, value: f64) -> Option<Series> {
    (is_metric_name(name)
        && !reserved(name)
        && value.is_finite()
        && labels.len() <= LABELS_MAX
        && labels
            .iter()
            .all(|(key, value)| is_label_key(key) && is_metric_name(value)))
    .then(|| Series {
        name: name.to_string(),
        labels,
        value,
    })
}

/// Parse one run's stdout. Invalid series are dropped; output with nothing
/// usable is a parse error. At most [`NODE_METRICS_CUSTOM_MAX`] series.
pub fn parse_output(
    format: MetricSourceFormat,
    source_name: &str,
    bytes: &[u8],
) -> Result<Vec<Series>, MetricSourceError> {
    let text = std::str::from_utf8(bytes).map_err(|_| MetricSourceError::Parse)?;
    let mut parsed = match format {
        MetricSourceFormat::Number => {
            let value = text
                .trim()
                .parse::<f64>()
                .map_err(|_| MetricSourceError::Parse)?;
            series(source_name, BTreeMap::new(), value)
                .into_iter()
                .collect()
        }
        MetricSourceFormat::Json => parse_json(text)?,
        MetricSourceFormat::Prometheus => parse_prometheus(text),
    };
    if parsed.is_empty() {
        return Err(MetricSourceError::Parse);
    }
    parsed.truncate(NODE_METRICS_CUSTOM_MAX);
    Ok(parsed)
}

fn parse_json(text: &str) -> Result<Vec<Series>, MetricSourceError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| MetricSourceError::Parse)?;
    let serde_json::Value::Object(map) = value else {
        return Err(MetricSourceError::Parse);
    };
    Ok(map
        .iter()
        .filter_map(|(name, value)| series(name, BTreeMap::new(), value.as_f64()?))
        .collect())
}

/// Prometheus text exposition: `name{k="v",...} value [timestamp]`.
fn parse_prometheus(text: &str) -> Vec<Series> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(parse_prometheus_line)
        .collect()
}

fn parse_prometheus_line(line: &str) -> Option<Series> {
    let name_end = line
        .find(|c: char| c == '{' || c.is_whitespace())
        .unwrap_or(line.len());
    let name = &line[..name_end];
    let mut rest = &line[name_end..];
    let mut labels = BTreeMap::new();
    if let Some(after_brace) = rest.strip_prefix('{') {
        let (parsed, remaining) = parse_labels(after_brace)?;
        labels = parsed;
        rest = remaining;
    }
    let mut fields = rest.split_whitespace();
    let value = match fields.next()? {
        // Prometheus spells these out; they are never sent.
        "NaN" | "+Inf" | "-Inf" | "Inf" => return None,
        text => text.parse::<f64>().ok()?,
    };
    // An optional timestamp may follow; anything else is malformed.
    if let Some(timestamp) = fields.next() {
        timestamp.parse::<i64>().ok()?;
    }
    if fields.next().is_some() {
        return None;
    }
    series(name, labels, value)
}

/// Labels after `{` up to the closing `}`; returns the text after it.
fn parse_labels(mut text: &str) -> Option<(BTreeMap<String, String>, &str)> {
    let mut labels = BTreeMap::new();
    loop {
        text = text.trim_start();
        if let Some(rest) = text.strip_prefix('}') {
            return Some((labels, rest));
        }
        let eq = text.find('=')?;
        let key = text[..eq].trim().to_string();
        let after = text[eq + 1..].trim_start().strip_prefix('"')?;
        let mut value = String::new();
        let mut chars = after.char_indices();
        let end = loop {
            let (index, c) = chars.next()?;
            match c {
                '"' => break index,
                '\\' => {
                    let (_, escaped) = chars.next()?;
                    value.push(match escaped {
                        'n' => '\n',
                        other => other,
                    });
                }
                other => value.push(other),
            }
        };
        if labels.insert(key, value).is_some() {
            return None;
        }
        text = after[end + 1..].trim_start();
        if let Some(rest) = text.strip_prefix(',') {
            text = rest;
        }
    }
}

/// Run a command once with every limit applied; returns its stdout. All of
/// the process handling (own process group, scrubbed environment, no stdin,
/// stderr discarded, stdout cap, deadline, bounded reap, daemon-exit kill)
/// is [`crate::bounded_run::run`]; this maps its errors to the wire codes.
pub fn run_command(
    command: &str,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, MetricSourceError> {
    if crate::child_env::validate_command(command).is_err() || command.trim().is_empty() {
        return Err(MetricSourceError::Spawn);
    }
    let (shell, flag) = crate::child_env::exec_shell();
    let args = [flag.to_string(), command.to_string()];
    crate::bounded_run::run(shell, &args, timeout, OUTPUT_LIMIT, cancel).map_err(
        |error| match error {
            RunError::Spawn | RunError::Resources | RunError::Cancelled => MetricSourceError::Spawn,
            RunError::Timeout => MetricSourceError::Timeout,
            RunError::OutputTooLarge => MetricSourceError::OutputTooLarge,
            RunError::ExitStatus => MetricSourceError::ExitStatus,
        },
    )
}

/// Run a source once and parse its output.
pub fn run_source(
    spec: &SourceSpec,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<Series>, MetricSourceError> {
    let output = run_command(
        &spec.command,
        Duration::from_secs(u64::from(spec.timeout_secs)),
        cancel,
    )?;
    parse_output(spec.format, &spec.name, &output)
}

/// A source as the runner sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSpec {
    pub name: String,
    pub origin: MetricSourceOrigin,
    pub command: String,
    pub interval_secs: u32,
    pub timeout_secs: u32,
    pub format: MetricSourceFormat,
    pub command_sha256: String,
}

/// Why a source runs or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    Run,
    /// Local source with an invalid name, interval, timeout or command.
    Disabled,
    /// Remote source without the local opt-in, or shadowed by a local one.
    Refused,
    /// Remote source whose exact command has no local approval.
    PendingApproval,
}

fn valid_bounds(command: &str, interval_secs: u32, timeout_secs: u32) -> bool {
    (INTERVAL_MIN_SECS..=INTERVAL_MAX_SECS).contains(&interval_secs)
        && (TIMEOUT_MIN_SECS..=TIMEOUT_MAX_SECS).contains(&timeout_secs)
        && !command.trim().is_empty()
        && crate::child_env::validate_command(command).is_ok()
}

fn local_spec(name: &str, source: &MetricSourceConfig) -> SourceSpec {
    SourceSpec {
        name: name.to_string(),
        origin: MetricSourceOrigin::Local,
        command: source.command.clone(),
        interval_secs: source.interval_secs,
        timeout_secs: source.timeout_secs,
        format: source.format,
        command_sha256: sha256_hex(source.command.as_bytes()),
    }
}

fn remote_spec(source: &RemoteMetricSource) -> SourceSpec {
    SourceSpec {
        name: source.name.clone(),
        origin: MetricSourceOrigin::Remote,
        command: source.command.clone(),
        interval_secs: source.interval_secs,
        timeout_secs: source.timeout_secs,
        format: source.format,
        command_sha256: sha256_hex(source.command.as_bytes()),
    }
}

/// Every local and remote source with its eligibility, locals first, each
/// group sorted by name. Sources whose names cannot be reported are left out.
pub fn effective_sources(
    metrics: &MetricsConfig,
    remote: &[RemoteMetricSource],
    allow_remote: bool,
) -> Vec<(SourceSpec, Eligibility)> {
    let mut sources = Vec::new();
    for (name, source) in &metrics.sources {
        if !is_metric_name(name) {
            tracing::warn!("a local metric source has an invalid name; skipped");
            continue;
        }
        let eligibility =
            if valid_bounds(&source.command, source.interval_secs, source.timeout_secs) {
                Eligibility::Run
            } else {
                Eligibility::Disabled
            };
        sources.push((local_spec(name, source), eligibility));
    }
    let mut remote = remote
        .iter()
        .filter(|source| is_metric_name(&source.name))
        .collect::<Vec<_>>();
    remote.sort_by(|left, right| left.name.cmp(&right.name));
    remote.dedup_by(|left, right| left.name == right.name);
    for source in remote {
        let spec = remote_spec(source);
        let eligibility = if !allow_remote
            || metrics.sources.contains_key(&source.name)
            || !valid_bounds(&source.command, source.interval_secs, source.timeout_secs)
        {
            Eligibility::Refused
        } else if metrics
            .approved_remote_sources
            .get(&source.name)
            .is_some_and(|hash| hash.eq_ignore_ascii_case(&spec.command_sha256))
        {
            Eligibility::Run
        } else {
            Eligibility::PendingApproval
        };
        sources.push((spec, eligibility));
    }
    sources.truncate(NODE_METRICS_SOURCES_MAX);
    sources
}

/// `<state dir>/remote-metric-sources.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSourcesFile {
    pub sources: Vec<RemoteMetricSource>,
}

pub fn remote_sources_path() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(REMOTE_SOURCES_FILE))
}

pub fn load_remote_sources_from(path: &Path) -> Result<Vec<RemoteMetricSource>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str::<RemoteSourcesFile>(&text)
            .with_context(|| format!("parsing `{}`", path.display()))?
            .sources),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("reading `{}`", path.display())),
    }
}

pub fn load_remote_sources() -> Result<Vec<RemoteMetricSource>> {
    load_remote_sources_from(&remote_sources_path()?)
}

/// Replace the stored remote definitions (atomic, private permissions).
pub fn save_remote_sources_to(path: &Path, sources: &[RemoteMetricSource]) -> Result<()> {
    let dir = path
        .parent()
        .context("remote metric sources path has no parent directory")?;
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating state directory `{}`", dir.display()))?;
    let text = serde_json::to_string_pretty(&RemoteSourcesFile {
        sources: sources.to_vec(),
    })
    .context("serializing remote metric sources")?;
    let mut file = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("creating a temporary file in `{}`", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .context("setting private permissions on remote metric sources")?;
    }
    std::io::Write::write_all(&mut file, text.as_bytes())
        .context("writing remote metric sources")?;
    file.as_file()
        .sync_all()
        .context("syncing remote metric sources")?;
    file.persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("replacing `{}`", path.display()))?;
    Ok(())
}

pub fn save_remote_sources(sources: &[RemoteMetricSource]) -> Result<()> {
    save_remote_sources_to(&remote_sources_path()?, sources)
}

#[derive(Debug)]
struct LastValues {
    series: Vec<Series>,
    ts: String,
    at: Instant,
}

#[derive(Debug)]
struct SourceState {
    spec: SourceSpec,
    eligibility: Eligibility,
    next_due: Instant,
    /// The id of THIS state's run in flight, if any. A result counts only
    /// when it carries this id (a run of a replaced definition never does).
    attempt: Option<u64>,
    last: Option<LastValues>,
    error: Option<MetricSourceError>,
}

/// A run that has not reported yet, live or already cancelled. The runner
/// owns every such run until it reports (or is given up on), so a
/// replaced or withdrawn source's dying run stays cancellable and blocks a
/// new run of the same source.
#[derive(Debug)]
struct Attempt {
    key: SourceKey,
    /// Ends this run only (each attempt owns its flag).
    cancel: Arc<AtomicBool>,
    /// A run always returns within its timeout plus the reap grace; past
    /// this the attempt is forgotten so a lost report cannot block forever.
    give_up_at: Instant,
}

const ATTEMPT_GRACE: Duration = Duration::from_secs(10);

type SourceKey = (bool, String);

/// End every unreported run of this source (idempotent).
fn cancel_key(attempts: &BTreeMap<u64, Attempt>, key: &SourceKey) {
    for attempt in attempts.values().filter(|attempt| attempt.key == *key) {
        attempt.cancel.store(true, Ordering::SeqCst);
    }
}

fn key(spec: &SourceSpec) -> SourceKey {
    (spec.origin == MetricSourceOrigin::Remote, spec.name.clone())
}

struct RunResult {
    key: SourceKey,
    attempt: u64,
    command_sha256: String,
    outcome: Result<Vec<Series>, MetricSourceError>,
    ts: String,
    at: Instant,
}

/// Where the runner reads its inputs.
#[derive(Debug, Clone)]
pub struct RunnerSettings {
    /// The opt-in as read when wsmp started.
    pub allow_remote: bool,
    /// Config file for local sources and approvals (re-read on change).
    pub config_path: Option<PathBuf>,
    /// Stored remote definitions (read once at start; later updates arrive
    /// through [`Runner::set_remote`]).
    pub remote_path: Option<PathBuf>,
}

impl RunnerSettings {
    pub fn from_environment(allow_remote: bool) -> Self {
        Self {
            allow_remote,
            config_path: crate::paths::config_file().ok(),
            remote_path: remote_sources_path().ok(),
        }
    }
}

/// Schedules source runs on short-lived threads and keeps their latest
/// values. Owned by the telemetry thread; nothing here blocks.
pub struct Runner {
    settings: RunnerSettings,
    metrics: MetricsConfig,
    remote: Vec<RemoteMetricSource>,
    config_mtime: Option<SystemTime>,
    next_reload_check: Instant,
    states: BTreeMap<SourceKey, SourceState>,
    results_tx: Sender<RunResult>,
    results_rx: Receiver<RunResult>,
    changed: bool,
    /// Every unreported run, by attempt id: the one place runs are ended
    /// early (`cancel_key`, `Drop`) and the one place "in flight" is read.
    attempts: BTreeMap<u64, Attempt>,
    next_attempt: u64,
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}

impl Drop for Runner {
    /// The session ended: every run in flight kills its process group at the
    /// next poll instead of running out.
    fn drop(&mut self) {
        for attempt in self.attempts.values() {
            attempt.cancel.store(true, Ordering::SeqCst);
        }
    }
}

impl Runner {
    pub fn new(settings: RunnerSettings) -> Self {
        let (results_tx, results_rx) = mpsc::channel();
        let remote = settings
            .remote_path
            .as_deref()
            .map(load_remote_sources_from)
            .transpose()
            .unwrap_or_else(|error| {
                tracing::warn!(error = %format!("{error:#}"), "stored remote metric sources are unreadable; ignored");
                None
            })
            .unwrap_or_default();
        let mut runner = Self {
            settings,
            metrics: MetricsConfig::default(),
            remote,
            config_mtime: None,
            next_reload_check: Instant::now(),
            states: BTreeMap::new(),
            results_tx,
            results_rx,
            changed: false,
            attempts: BTreeMap::new(),
            next_attempt: 0,
        };
        runner.reload_config(true);
        runner.rebuild(Instant::now());
        runner
    }

    /// For tests and callers that already hold the config.
    pub fn with_inputs(
        settings: RunnerSettings,
        metrics: MetricsConfig,
        remote: Vec<RemoteMetricSource>,
    ) -> Self {
        let (results_tx, results_rx) = mpsc::channel();
        let mut runner = Self {
            settings,
            metrics,
            remote,
            config_mtime: None,
            next_reload_check: Instant::now() + RELOAD_CHECK_INTERVAL,
            states: BTreeMap::new(),
            results_tx,
            results_rx,
            changed: false,
            attempts: BTreeMap::new(),
            next_attempt: 0,
        };
        runner.rebuild(Instant::now());
        runner
    }

    /// `metrics.sources.set` replaced the remote definitions.
    pub fn set_remote(&mut self, remote: Vec<RemoteMetricSource>) {
        self.remote = remote;
        self.rebuild(Instant::now());
        self.changed = true;
    }

    /// Replace the local sources and approvals (the config changed).
    pub fn set_metrics_config(&mut self, metrics: MetricsConfig) {
        if self.metrics != metrics {
            self.metrics = metrics;
            self.rebuild(Instant::now());
        }
    }

    /// True once after a run finished or a source's state changed.
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    fn reload_config(&mut self, force: bool) {
        let Some(path) = self.settings.config_path.clone() else {
            return;
        };
        let mtime = modified(&path);
        if !force && mtime == self.config_mtime {
            return;
        }
        self.config_mtime = mtime;
        match Config::load_from_path(&path) {
            Ok(config) => self.set_metrics_config(config.metrics),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "re-reading metric sources from the config failed; keeping the previous ones");
            }
        }
    }

    fn rebuild(&mut self, now: Instant) {
        let effective = effective_sources(&self.metrics, &self.remote, self.settings.allow_remote);
        let mut next = BTreeMap::new();
        for (spec, eligibility) in effective {
            let source_key = key(&spec);
            let state = match self.states.remove(&source_key) {
                Some(state) if state.spec == spec && state.eligibility == eligibility => state,
                previous => {
                    self.changed = true;
                    // The definition or its authority changed (command,
                    // withdrawal is handled below, approval revoked, opt-in):
                    // the run of the old one must not keep executing.
                    if previous.is_some() {
                        cancel_key(&self.attempts, &source_key);
                    }
                    SourceState {
                        spec,
                        eligibility,
                        next_due: now,
                        // A run of the old definition is being ended; its
                        // result is ignored (it carries another attempt id)
                        // and no run of the new one starts until it reports.
                        attempt: None,
                        last: None,
                        error: None,
                    }
                }
            };
            next.insert(source_key, state);
        }
        // What is left in the old map was withdrawn (or is no longer
        // reportable): end its run too.
        for withdrawn in self.states.keys() {
            cancel_key(&self.attempts, withdrawn);
        }
        if !self.states.is_empty() {
            self.changed = true;
        }
        self.states = next;
    }

    /// Reload inputs when due, collect finished runs and start due ones.
    pub fn tick(&mut self, now: Instant) {
        if now >= self.next_reload_check {
            self.next_reload_check = now + RELOAD_CHECK_INTERVAL;
            self.reload_config(false);
        }
        // A run that never reported (a lost thread) is forgotten after its
        // bound, so its source is not blocked forever.
        let mut given_up = Vec::new();
        self.attempts.retain(|id, attempt| {
            if now < attempt.give_up_at {
                return true;
            }
            attempt.cancel.store(true, Ordering::SeqCst);
            given_up.push((*id, attempt.key.clone()));
            false
        });
        for (id, key) in given_up {
            if let Some(state) = self.states.get_mut(&key)
                && state.attempt == Some(id)
            {
                state.attempt = None;
            }
        }
        while let Ok(result) = self.results_rx.try_recv() {
            self.attempts.remove(&result.attempt);
            let Some(state) = self.states.get_mut(&result.key) else {
                continue;
            };
            // Only this state's own run counts: a cancelled run of a
            // replaced or withdrawn definition never clears (or feeds) its
            // successor.
            if state.attempt != Some(result.attempt) {
                continue;
            }
            state.attempt = None;
            if state.spec.command_sha256 != result.command_sha256
                || state.eligibility != Eligibility::Run
            {
                continue;
            }
            match result.outcome {
                Ok(series) => {
                    state.last = Some(LastValues {
                        series,
                        ts: result.ts,
                        at: result.at,
                    });
                    state.error = None;
                }
                Err(error) => {
                    tracing::debug!(source = %state.spec.name, ?error, "metric source run failed");
                    // A failed run reports nothing: earlier values are not
                    // passed off as current.
                    state.last = None;
                    state.error = Some(error);
                }
            }
            self.changed = true;
        }
        for (source_key, state) in &mut self.states {
            if state.eligibility != Eligibility::Run
                || state.attempt.is_some()
                || now < state.next_due
                || self
                    .attempts
                    .values()
                    .any(|attempt| attempt.key == *source_key)
            {
                continue;
            }
            self.next_attempt += 1;
            let attempt_id = self.next_attempt;
            state.next_due = now + Duration::from_secs(u64::from(state.spec.interval_secs));
            let spec = state.spec.clone();
            let tx = self.results_tx.clone();
            let cancel = Arc::new(AtomicBool::new(false));
            let key_for_thread = source_key.clone();
            let cancel_for_thread = Arc::clone(&cancel);
            let spawned = thread::Builder::new()
                .name("wsmp-metric-source".to_string())
                .spawn(move || {
                    let outcome = run_source(&spec, Some(&cancel_for_thread));
                    let _ = tx.send(RunResult {
                        key: key_for_thread,
                        attempt: attempt_id,
                        command_sha256: spec.command_sha256,
                        outcome,
                        ts: crate::telemetry::now_rfc3339(),
                        at: Instant::now(),
                    });
                });
            if spawned.is_err() {
                state.error = Some(MetricSourceError::Spawn);
                continue;
            }
            state.attempt = Some(attempt_id);
            self.attempts.insert(
                attempt_id,
                Attempt {
                    key: source_key.clone(),
                    cancel,
                    give_up_at: now
                        + Duration::from_secs(u64::from(state.spec.timeout_secs))
                        + crate::bounded_run::REAP_GRACE
                        + ATTEMPT_GRACE,
                },
            );
        }
    }

    /// Series to report and every source's status.
    pub fn report(&self, now: Instant) -> (Vec<CustomMetric>, Vec<MetricSourceStatus>) {
        let mut custom = Vec::new();
        let mut statuses = Vec::new();
        for state in self.states.values() {
            let spec = &state.spec;
            let (state_name, error) = match state.eligibility {
                Eligibility::Run => match state.error {
                    Some(error) => (MetricSourceState::Failing, Some(error)),
                    None => (MetricSourceState::Active, None),
                },
                Eligibility::Disabled => (MetricSourceState::Disabled, None),
                Eligibility::Refused => (MetricSourceState::Refused, None),
                Eligibility::PendingApproval => (MetricSourceState::PendingApproval, None),
            };
            statuses.push(MetricSourceStatus {
                name: spec.name.clone(),
                origin: spec.origin,
                state: state_name,
                command_sha256: Some(spec.command_sha256.clone()),
                error,
                interval_secs: (INTERVAL_MIN_SECS..=INTERVAL_MAX_SECS)
                    .contains(&spec.interval_secs)
                    .then_some(spec.interval_secs),
            });
            if state.eligibility != Eligibility::Run {
                continue;
            }
            let Some(last) = &state.last else { continue };
            let stale_after =
                Duration::from_secs(u64::from(spec.interval_secs) * u64::from(STALE_INTERVALS));
            if now.duration_since(last.at) >= stale_after {
                continue;
            }
            for series in &last.series {
                custom.push(CustomMetric {
                    source: spec.name.clone(),
                    name: series.name.clone(),
                    labels: series.labels.clone(),
                    value: series.value,
                    ts: last.ts.clone(),
                });
            }
        }
        custom.truncate(NODE_METRICS_CUSTOM_MAX);
        statuses.truncate(NODE_METRICS_SOURCES_MAX);
        (custom, statuses)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(name: &str, command: &str) -> RemoteMetricSource {
        RemoteMetricSource {
            name: name.to_string(),
            command: command.to_string(),
            interval_secs: 10,
            timeout_secs: 5,
            format: MetricSourceFormat::Number,
        }
    }

    fn settings(allow_remote: bool) -> RunnerSettings {
        RunnerSettings {
            allow_remote,
            config_path: None,
            remote_path: None,
        }
    }

    fn state_of(runner: &Runner, name: &str) -> MetricSourceStatus {
        runner
            .report(Instant::now())
            .1
            .into_iter()
            .find(|status| status.name == name)
            .expect("status")
    }

    #[test]
    fn number_format_uses_the_source_name() {
        let parsed = parse_output(MetricSourceFormat::Number, "fan_rpm", b" 1200.5\n").expect("ok");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "fan_rpm");
        assert_eq!(parsed[0].value, 1200.5);
        for bad in [&b"NaN"[..], b"inf", b"hot", b"", b"1 2"] {
            assert_eq!(
                parse_output(MetricSourceFormat::Number, "fan_rpm", bad),
                Err(MetricSourceError::Parse),
                "{bad:?}"
            );
        }
        assert_eq!(
            parse_output(MetricSourceFormat::Number, "x", &[0xff, 0xfe]),
            Err(MetricSourceError::Parse)
        );
    }

    #[test]
    fn json_format_keeps_valid_numeric_entries() {
        let parsed = parse_output(
            MetricSourceFormat::Json,
            "src",
            br#"{"queue.depth": 3, "bad name": 1, "text": "7", "node.cpu": 5, "ok": 1e3}"#,
        )
        .expect("ok");
        let names = parsed.iter().map(|s| s.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["ok", "queue.depth"]);
        assert_eq!(
            parse_output(MetricSourceFormat::Json, "src", b"[1,2]"),
            Err(MetricSourceError::Parse)
        );
        assert_eq!(
            parse_output(MetricSourceFormat::Json, "src", br#"{"a": "x"}"#),
            Err(MetricSourceError::Parse)
        );
    }

    #[test]
    fn prometheus_format_parses_labels_and_drops_invalid_series() {
        let text = r#"# HELP gpu_temp GPU temperature
# TYPE gpu_temp gauge
gpu_temp{gpu="0"} 71
gpu_temp{gpu="1",slot="a"} 64.5 1700000000000
up 1
bad{gpu="has space"} 2
nan_metric NaN
inf_metric +Inf
endpoint.running 3
weird{gpu="0"} 1 notatimestamp
escaped{v="a\"b"} 1
"#;
        let parsed =
            parse_output(MetricSourceFormat::Prometheus, "src", text.as_bytes()).expect("ok");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].name, "gpu_temp");
        assert_eq!(parsed[0].labels.get("gpu").map(String::as_str), Some("0"));
        assert_eq!(parsed[1].labels.len(), 2);
        assert_eq!(parsed[1].value, 64.5);
        assert_eq!(parsed[2].name, "up");
    }

    #[test]
    fn a_reserved_label_key_drops_the_series_in_every_format() {
        // `__proto__` matches the name pattern but the server would drop it
        // silently, so the series never leaves the machine.
        let prometheus = "bad{__proto__=\"x\"} 1\ngood{proto=\"x\"} 2\n";
        let parsed =
            parse_output(MetricSourceFormat::Prometheus, "src", prometheus.as_bytes()).expect("ok");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "good");
        assert_eq!(
            parse_output(
                MetricSourceFormat::Prometheus,
                "src",
                b"bad{__proto__=\"x\"} 1\n"
            ),
            Err(MetricSourceError::Parse)
        );
        let labels = |key: &str| [(key.to_string(), "v".to_string())].into_iter().collect();
        assert!(series("s", labels("__proto__"), 1.0).is_none());
        assert!(series("s", labels("_proto__"), 1.0).is_some());
    }

    #[test]
    fn at_most_fifty_series_and_sixteen_labels() {
        let mut text = String::new();
        for index in 0..80 {
            text.push_str(&format!("m{index} {index}\n"));
        }
        let parsed =
            parse_output(MetricSourceFormat::Prometheus, "src", text.as_bytes()).expect("ok");
        assert_eq!(parsed.len(), NODE_METRICS_CUSTOM_MAX);
        let labels = (0..17)
            .map(|index| format!("l{index}=\"v\""))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            parse_output(
                MetricSourceFormat::Prometheus,
                "src",
                format!("many{{{labels}}} 1\n").as_bytes()
            ),
            Err(MetricSourceError::Parse)
        );
        let long = "x".repeat(65);
        assert_eq!(
            parse_output(
                MetricSourceFormat::Prometheus,
                "src",
                format!("{long} 1\n").as_bytes()
            ),
            Err(MetricSourceError::Parse)
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_command_and_never_captures_stderr() {
        let output = run_command(
            "echo 42; echo super-secret-stderr >&2",
            Duration::from_secs(5),
            None,
        )
        .expect("ran");
        let text = String::from_utf8(output).expect("utf8");
        assert_eq!(text.trim(), "42");
        assert!(!text.contains("super-secret-stderr"));
        assert_eq!(
            run_command("exit 3", Duration::from_secs(5), None),
            Err(MetricSourceError::ExitStatus)
        );
    }

    #[cfg(unix)]
    #[test]
    fn oversized_output_is_dropped() {
        assert_eq!(
            run_command("head -c 70000 /dev/zero", Duration::from_secs(5), None),
            Err(MetricSourceError::OutputTooLarge)
        );
        // An endless writer is stopped at the limit, not at the timeout.
        let started = Instant::now();
        assert_eq!(
            run_command("yes 1", Duration::from_secs(20), None),
            Err(MetricSourceError::OutputTooLarge)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        // A command that keeps running after printing too much is stopped as
        // soon as the limit is crossed, not at its timeout.
        let started = Instant::now();
        assert_eq!(
            run_command(
                "head -c 70000 /dev/zero; sleep 30",
                Duration::from_secs(20),
                None
            ),
            Err(MetricSourceError::OutputTooLarge)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_whole_process_group() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("bg.pid");
        let command = format!("sleep 30 & echo $! > '{}'; sleep 30", pid_file.display());
        let started = Instant::now();
        assert_eq!(
            run_command(&command, Duration::from_secs(1), None),
            Err(MetricSourceError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("pid file")
            .trim()
            .parse()
            .expect("pid");
        // The background sleep was in the group: it is gone (or a zombie
        // reaped by init shortly).
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
                && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .map(|stat| stat.contains(") Z "))
                    .unwrap_or(false);
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "background child survived");
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn remote_sources_need_opt_in_and_the_exact_approved_hash() {
        let sources = vec![remote("fans", "echo 1")];
        let refused =
            Runner::with_inputs(settings(false), MetricsConfig::default(), sources.clone());
        assert_eq!(state_of(&refused, "fans").state, MetricSourceState::Refused);

        let mut runner =
            Runner::with_inputs(settings(true), MetricsConfig::default(), sources.clone());
        let pending = state_of(&runner, "fans");
        assert_eq!(pending.state, MetricSourceState::PendingApproval);
        assert_eq!(
            pending.command_sha256.as_deref(),
            Some(sha256_hex(b"echo 1").as_str())
        );
        assert_eq!(pending.interval_secs, Some(10));
        runner.tick(Instant::now());
        assert!(runner.attempts.is_empty(), "a pending source never runs");

        let mut approved = MetricsConfig::default();
        approved
            .approved_remote_sources
            .insert("fans".to_string(), sha256_hex(b"echo 1"));
        runner.set_metrics_config(approved);
        assert_eq!(state_of(&runner, "fans").state, MetricSourceState::Active);

        runner.set_remote(vec![remote("fans", "echo 2")]);
        assert_eq!(
            state_of(&runner, "fans").state,
            MetricSourceState::PendingApproval,
            "a changed command needs a new approval"
        );
    }

    #[test]
    fn a_local_source_shadows_a_remote_one_and_invalid_locals_are_disabled() {
        let mut metrics = MetricsConfig::default();
        metrics.sources.insert(
            "fans".to_string(),
            MetricSourceConfig {
                command: "echo 1".to_string(),
                interval_secs: 10,
                timeout_secs: 5,
                format: MetricSourceFormat::Number,
            },
        );
        metrics.sources.insert(
            "fast".to_string(),
            MetricSourceConfig {
                command: "echo 1".to_string(),
                interval_secs: 2,
                timeout_secs: 5,
                format: MetricSourceFormat::Number,
            },
        );
        metrics
            .approved_remote_sources
            .insert("fans".to_string(), sha256_hex(b"echo remote"));
        let runner =
            Runner::with_inputs(settings(true), metrics, vec![remote("fans", "echo remote")]);
        let (_, statuses) = runner.report(Instant::now());
        let local = statuses
            .iter()
            .find(|s| s.name == "fans" && s.origin == MetricSourceOrigin::Local)
            .expect("local");
        let remote_status = statuses
            .iter()
            .find(|s| s.name == "fans" && s.origin == MetricSourceOrigin::Remote)
            .expect("remote");
        assert_eq!(local.state, MetricSourceState::Active);
        assert_eq!(remote_status.state, MetricSourceState::Refused);
        let fast = statuses.iter().find(|s| s.name == "fast").expect("fast");
        assert_eq!(fast.state, MetricSourceState::Disabled);
        assert_eq!(fast.interval_secs, None);
    }

    #[cfg(unix)]
    #[test]
    fn runner_reports_values_of_active_sources() {
        let mut metrics = MetricsConfig::default();
        metrics.sources.insert(
            "temp".to_string(),
            MetricSourceConfig {
                command: "echo 71".to_string(),
                interval_secs: 10,
                timeout_secs: 5,
                format: MetricSourceFormat::Number,
            },
        );
        let mut runner = Runner::with_inputs(settings(false), metrics, Vec::new());
        runner.take_changed();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            runner.tick(Instant::now());
            let (custom, _) = runner.report(Instant::now());
            if let Some(metric) = custom.first() {
                assert_eq!(metric.source, "temp");
                assert_eq!(metric.name, "temp");
                assert_eq!(metric.value, 71.0);
                assert!(runner.take_changed());
                break;
            }
            assert!(Instant::now() < deadline, "no value reported");
            thread::sleep(Duration::from_millis(20));
        }
        // Stale after 3 intervals.
        let (custom, _) = runner.report(Instant::now() + Duration::from_secs(31));
        assert!(custom.is_empty());
    }

    #[cfg(unix)]
    fn approved_remote(command: &str) -> (MetricsConfig, RemoteMetricSource) {
        let mut metrics = MetricsConfig::default();
        metrics
            .approved_remote_sources
            .insert("slow".to_string(), sha256_hex(command.as_bytes()));
        (metrics, remote("slow", command))
    }

    #[cfg(unix)]
    fn wait_for_pid(pid_file: &Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(pid) = std::fs::read_to_string(pid_file)
                .ok()
                .and_then(|text| text.trim().parse().ok())
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "the command never started");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    fn is_alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
            && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|stat| stat.contains(") Z "))
                .unwrap_or(false)
    }

    /// Any change that removes a run's authority ends the run in flight at
    /// once: a changed command, a withdrawal, a revoked approval. An
    /// unchanged rebuild leaves it alone.
    #[cfg(unix)]
    #[test]
    fn a_run_in_flight_ends_when_its_authority_changes() {
        #[derive(Clone, Copy, Debug)]
        enum Change {
            Command,
            Withdraw,
            Revoke,
            Unchanged,
        }
        for change in [
            Change::Command,
            Change::Withdraw,
            Change::Revoke,
            Change::Unchanged,
        ] {
            let dir = tempfile::tempdir().expect("tempdir");
            let pid_file = dir.path().join("run.pid");
            let command = format!("echo $$ > '{}'; sleep 60 & wait", pid_file.display());
            let (metrics, definition) = approved_remote(&command);
            let mut runner = Runner::with_inputs(settings(true), metrics.clone(), vec![definition]);
            runner.tick(Instant::now());
            let pid = wait_for_pid(&pid_file);
            match change {
                Change::Command => {
                    runner.set_remote(vec![remote("slow", &format!("{command}; echo 2"))]);
                }
                Change::Withdraw => runner.set_remote(Vec::new()),
                Change::Revoke => runner.set_metrics_config(MetricsConfig::default()),
                Change::Unchanged => {
                    runner.set_remote(vec![remote("slow", &command)]);
                    runner.set_metrics_config(metrics);
                }
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            let survived = loop {
                if !is_alive(pid) {
                    break false;
                }
                if Instant::now() >= deadline {
                    break true;
                }
                thread::sleep(Duration::from_millis(50));
            };
            match change {
                Change::Unchanged => {
                    assert!(survived, "{change:?}: an unchanged source was killed")
                }
                _ => assert!(!survived, "{change:?}: the old command kept running"),
            }
            drop(runner);
            let deadline = Instant::now() + Duration::from_secs(3);
            while is_alive(pid) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
            assert!(
                !is_alive(pid),
                "{change:?}: dropping the runner left it running"
            );
        }
    }

    /// A run whose report never arrives is given up after its bound: the
    /// attempt is forgotten, its run is cancelled, and the source runs
    /// again instead of staying blocked forever.
    #[cfg(unix)]
    #[test]
    fn a_lost_report_is_given_up_and_the_source_runs_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("runs.pid");
        // Exits by itself after 1 s; its 5 s timeout never matters.
        let command = format!("echo $$ >> '{}'; sleep 1", pid_file.display());
        let (metrics, definition) = approved_remote(&command);
        let mut runner = Runner::with_inputs(settings(true), metrics, vec![definition]);
        let started = Instant::now();
        runner.tick(started);
        let _ = wait_for_pid(&pid_file);
        let (old_id, old_cancel) = runner
            .attempts
            .iter()
            .next()
            .map(|(id, attempt)| (*id, Arc::clone(&attempt.cancel)))
            .expect("an attempt");
        // The report is lost: take it off the channel before the runner sees it.
        runner
            .results_rx
            .recv_timeout(Duration::from_secs(15))
            .expect("the run reports");
        // Before the bound the attempt is still owned (nothing restarts).
        runner.tick(started + Duration::from_secs(12));
        assert!(runner.attempts.contains_key(&old_id));
        assert!(!old_cancel.load(Ordering::SeqCst));
        // Past timeout (5) + reap grace (1) + slack (10): forgotten and cancelled,
        // and the source (due again) starts a new run.
        runner.tick(started + Duration::from_secs(17));
        assert!(
            old_cancel.load(Ordering::SeqCst),
            "the lost run was not cancelled"
        );
        assert!(
            !runner.attempts.contains_key(&old_id),
            "the lost attempt was kept"
        );
        assert_eq!(runner.attempts.len(), 1, "the source did not run again");
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::fs::read_to_string(&pid_file)
            .unwrap_or_default()
            .lines()
            .count()
            < 2
        {
            assert!(Instant::now() < deadline, "the new run never started");
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// A cancelled run reports late. It must neither start alongside the
    /// re-added source's new run, nor strip that run's cancel handle (so a
    /// later withdrawal still ends it).
    #[cfg(unix)]
    #[test]
    fn a_dying_run_neither_overlaps_nor_disarms_its_successor() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("runs.pid");
        let command = format!("echo $$ >> '{}'; sleep 60 & wait", pid_file.display());
        let (metrics, definition) = approved_remote(&command);
        let mut runner = Runner::with_inputs(settings(true), metrics, vec![definition.clone()]);
        runner.tick(Instant::now());
        let pids = |count: usize| -> Vec<i32> {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let pids: Vec<i32> = std::fs::read_to_string(&pid_file)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| line.trim().parse().ok())
                    .collect();
                if pids.len() >= count {
                    return pids;
                }
                assert!(Instant::now() < deadline, "run {count} never started");
                thread::sleep(Duration::from_millis(20));
            }
        };
        let first = pids(1)[0];
        // Withdrawn and re-added before the cancelled run has reported.
        runner.set_remote(Vec::new());
        runner.set_remote(vec![definition]);
        runner.tick(Instant::now());
        assert_eq!(
            runner.attempts.len(),
            1,
            "a new run started while the old one was still unreported"
        );
        // Tick until the old run has reported and the new one is running.
        let deadline = Instant::now() + Duration::from_secs(10);
        while runner.attempts.len() != 1
            || !runner
                .attempts
                .values()
                .all(|attempt| attempt.key.1 == "slow")
            || std::fs::read_to_string(&pid_file)
                .unwrap_or_default()
                .lines()
                .count()
                < 2
        {
            assert!(Instant::now() < deadline, "the re-added source never ran");
            runner.tick(Instant::now());
            thread::sleep(Duration::from_millis(20));
        }
        let second = pids(2)[1];
        assert!(!is_alive(first), "the cancelled run is still running");
        assert!(is_alive(second));
        // The old run's `Cancelled` report was drained by those ticks: it must
        // not have been applied to the successor (attempt id check).
        let successor = runner.states.values().next().expect("the re-added source");
        assert!(
            successor.error.is_none(),
            "a stale report failed the successor"
        );
        assert!(
            successor.attempt.is_some(),
            "a stale report cleared the successor's run"
        );
        // The old run's report must not have disarmed the new run: a later
        // withdrawal still ends it.
        runner.set_remote(Vec::new());
        let deadline = Instant::now() + Duration::from_secs(3);
        while is_alive(second) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!is_alive(second), "the successor survived its withdrawal");
    }

    /// The session ended (the runner is dropped): a run in flight is killed
    /// with its process group at once, not left to run out its timeout.
    #[cfg(unix)]
    #[test]
    fn dropping_the_runner_kills_runs_in_flight() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("run.pid");
        let mut metrics = MetricsConfig::default();
        metrics.sources.insert(
            "slow".to_string(),
            MetricSourceConfig {
                command: format!("echo $$ > '{}'; sleep 60 & wait", pid_file.display()),
                interval_secs: 10,
                timeout_secs: 60,
                format: MetricSourceFormat::Number,
            },
        );
        let mut runner = Runner::with_inputs(settings(false), metrics, Vec::new());
        runner.tick(Instant::now());
        let deadline = Instant::now() + Duration::from_secs(10);
        let pid: i32 = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.trim().parse().ok())
            {
                break pid;
            }
            assert!(Instant::now() < deadline, "the command never started");
            thread::sleep(Duration::from_millis(20));
        };
        drop(runner);
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
                && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .map(|stat| stat.contains(") Z "))
                    .unwrap_or(false);
            if !alive {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "a run outlived its dropped runner"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_run_drops_the_previous_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let flag = dir.path().join("ok");
        std::fs::write(&flag, "").expect("flag");
        let mut metrics = MetricsConfig::default();
        metrics.sources.insert(
            "flaky".to_string(),
            MetricSourceConfig {
                command: format!("test -f '{}' && echo 5 || exit 3", flag.display()),
                interval_secs: 10,
                timeout_secs: 5,
                format: MetricSourceFormat::Number,
            },
        );
        let mut runner = Runner::with_inputs(settings(false), metrics, Vec::new());
        let deadline = Instant::now() + Duration::from_secs(10);
        while runner.report(Instant::now()).0.is_empty() {
            runner.tick(Instant::now());
            assert!(Instant::now() < deadline, "no value reported");
            thread::sleep(Duration::from_millis(20));
        }
        std::fs::remove_file(&flag).expect("remove flag");
        for state in runner.states.values_mut() {
            state.next_due = Instant::now();
        }
        loop {
            runner.tick(Instant::now());
            let (custom, statuses) = runner.report(Instant::now());
            if statuses[0].state == MetricSourceState::Failing {
                assert!(
                    custom.is_empty(),
                    "values of the last good run are not reported"
                );
                assert_eq!(statuses[0].error, Some(MetricSourceError::ExitStatus));
                break;
            }
            assert!(Instant::now() < deadline, "the failed run was not observed");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn remote_sources_file_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state").join(REMOTE_SOURCES_FILE);
        assert!(load_remote_sources_from(&path).expect("missing").is_empty());
        save_remote_sources_to(&path, &[remote("fans", "echo 1")]).expect("save");
        let loaded = load_remote_sources_from(&path).expect("load");
        assert_eq!(loaded, vec![remote("fans", "echo 1")]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
