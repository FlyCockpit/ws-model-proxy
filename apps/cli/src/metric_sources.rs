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
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::{Config, MetricSourceConfig, MetricsConfig};
use crate::protocol::{
    CustomMetric, MetricSourceError, MetricSourceFormat, MetricSourceOrigin, MetricSourceState,
    MetricSourceStatus, NODE_METRICS_CUSTOM_MAX, NODE_METRICS_SOURCES_MAX, RemoteMetricSource,
};
use crate::telemetry::is_metric_name;

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
const WAIT_POLL: Duration = Duration::from_millis(25);

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
            .all(|(key, value)| is_metric_name(key) && is_metric_name(value)))
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

/// Run a command once with every limit applied; returns its stdout.
pub fn run_command(command: &str, timeout: Duration) -> Result<Vec<u8>, MetricSourceError> {
    if crate::child_env::validate_command(command).is_err() || command.trim().is_empty() {
        return Err(MetricSourceError::Spawn);
    }
    let (shell, flag) = crate::child_env::exec_shell();
    let mut builder = Command::new(shell);
    builder
        .arg(flag)
        .arg(command)
        .env_clear()
        .envs(crate::child_env::scrub_parent_env(&[]))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Never read, never uploaded.
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so a timeout kills everything it started.
        builder.process_group(0);
    }
    let mut child = builder.spawn().map_err(|_| MetricSourceError::Spawn)?;
    let pid = child.id();
    let Some(stdout) = child.stdout.take() else {
        kill_group(&mut child, pid);
        let _ = child.wait();
        return Err(MetricSourceError::Spawn);
    };
    let (done_tx, done_rx) = mpsc::channel();
    // The reader owns the pipe so a full pipe cannot stall the child. It
    // stops one byte past the limit, which is how oversize is detected.
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout
            .take(OUTPUT_LIMIT as u64 + 1)
            .read_to_end(&mut buffer);
        let _ = done_tx.send(buffer);
    });
    let deadline = Instant::now() + timeout;
    let mut early: Option<Vec<u8>> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if early.is_none()
            && let Ok(buffer) = done_rx.try_recv()
        {
            if buffer.len() > OUTPUT_LIMIT {
                kill_group(&mut child, pid);
                let _ = child.wait();
                return Err(MetricSourceError::OutputTooLarge);
            }
            early = Some(buffer);
        }
        if Instant::now() >= deadline {
            kill_group(&mut child, pid);
            let _ = child.wait();
            return Err(MetricSourceError::Timeout);
        }
        thread::sleep(WAIT_POLL);
    };
    // Background children left in the group would keep stdout open.
    kill_group(&mut child, pid);
    let Some(status) = status else {
        return Err(MetricSourceError::Spawn);
    };
    let buffer = match early {
        Some(buffer) => buffer,
        None => done_rx
            .recv_timeout(Duration::from_millis(500))
            .map_err(|_| MetricSourceError::Timeout)?,
    };
    if buffer.len() > OUTPUT_LIMIT {
        return Err(MetricSourceError::OutputTooLarge);
    }
    if !status.success() {
        return Err(MetricSourceError::ExitStatus);
    }
    Ok(buffer)
}

#[cfg(unix)]
fn kill_group(_child: &mut std::process::Child, pid: u32) {
    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    if raw <= 1 {
        return;
    }
    // ESRCH (the group is already gone) is fine.
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(raw),
        nix::sys::signal::Signal::SIGKILL,
    );
}

#[cfg(not(unix))]
fn kill_group(child: &mut std::process::Child, _pid: u32) {
    let _ = child.kill();
}

/// Run a source once and parse its output.
pub fn run_source(spec: &SourceSpec) -> Result<Vec<Series>, MetricSourceError> {
    let output = run_command(
        &spec.command,
        Duration::from_secs(u64::from(spec.timeout_secs)),
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
    in_flight: bool,
    last: Option<LastValues>,
    error: Option<MetricSourceError>,
}

type SourceKey = (bool, String);

fn key(spec: &SourceSpec) -> SourceKey {
    (spec.origin == MetricSourceOrigin::Remote, spec.name.clone())
}

struct RunResult {
    key: SourceKey,
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
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
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
                    SourceState {
                        spec,
                        eligibility,
                        next_due: now,
                        // A run of the old definition may still finish; its
                        // result is ignored (hash mismatch) and it cannot
                        // overlap a run of the new one for long: timeouts
                        // bound it.
                        in_flight: previous.is_some_and(|previous| previous.in_flight),
                        last: None,
                        error: None,
                    }
                }
            };
            next.insert(source_key, state);
        }
        if next.len() != self.states.len() {
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
        while let Ok(result) = self.results_rx.try_recv() {
            let Some(state) = self.states.get_mut(&result.key) else {
                continue;
            };
            state.in_flight = false;
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
            if state.eligibility != Eligibility::Run || state.in_flight || now < state.next_due {
                continue;
            }
            state.in_flight = true;
            state.next_due = now + Duration::from_secs(u64::from(state.spec.interval_secs));
            let spec = state.spec.clone();
            let tx = self.results_tx.clone();
            let source_key = source_key.clone();
            let spawned = thread::Builder::new()
                .name("wsmp-metric-source".to_string())
                .spawn(move || {
                    let outcome = run_source(&spec);
                    let _ = tx.send(RunResult {
                        key: source_key,
                        command_sha256: spec.command_sha256,
                        outcome,
                        ts: crate::telemetry::now_rfc3339(),
                        at: Instant::now(),
                    });
                });
            if spawned.is_err() {
                state.in_flight = false;
                state.error = Some(MetricSourceError::Spawn);
            }
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
        )
        .expect("ran");
        let text = String::from_utf8(output).expect("utf8");
        assert_eq!(text.trim(), "42");
        assert!(!text.contains("super-secret-stderr"));
        assert_eq!(
            run_command("exit 3", Duration::from_secs(5)),
            Err(MetricSourceError::ExitStatus)
        );
    }

    #[cfg(unix)]
    #[test]
    fn oversized_output_is_dropped() {
        assert_eq!(
            run_command("head -c 70000 /dev/zero", Duration::from_secs(5)),
            Err(MetricSourceError::OutputTooLarge)
        );
        // An endless writer is stopped at the limit, not at the timeout.
        let started = Instant::now();
        assert_eq!(
            run_command("yes 1", Duration::from_secs(20)),
            Err(MetricSourceError::OutputTooLarge)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        // A command that keeps running after printing too much is stopped as
        // soon as the limit is crossed, not at its timeout.
        let started = Instant::now();
        assert_eq!(
            run_command("head -c 70000 /dev/zero; sleep 30", Duration::from_secs(20)),
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
            run_command(&command, Duration::from_secs(1)),
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
        assert!(
            runner.states.values().all(|state| !state.in_flight),
            "a pending source never runs"
        );

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
