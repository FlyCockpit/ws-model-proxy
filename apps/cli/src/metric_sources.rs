//! Node metric commands (relay 3.0 `node.metrics.custom`).
//!
//! The server defines them in the node part of `runtime.define`
//! (`node.metricCommands`, at most 16, frozen with the rest at Relay only).
//! There is no local hash approval any more: what the server may define
//! follows the node's trust. The daemon hands the held (frozen at Relay
//! only) list to [`Runner`] through the telemetry thread.
//!
//! A command runs every `intervalSecs` and prints numbers in one of three
//! formats: `json` (an object of numbers), `prometheus` (text exposition) or
//! `lines` (`<name> <number>` per line, or one bare number named after the
//! command). Without a `map` every valid series is reported as printed; with
//! one, each mapped metric is read from its series (a JSON pointer for
//! `json`, a series name with optional labels otherwise), aggregated
//! (default sum), scaled and optionally divided by another series.
//!
//! Every run is bounded: its own process group (killed as a whole on
//! timeout), stdin closed, stderr discarded (never read, never uploaded),
//! stdout capped at [`OUTPUT_LIMIT`] bytes. Only numbers and names matching
//! `[A-Za-z0-9_.:-]{1,64}` leave the machine; command text and output never
//! do. Commands run as the OS user that runs wsmp.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::bounded_run::RunError;
use crate::protocol::frames::{
    CustomMetric, MetricCommandError, MetricCommandState, MetricCommandStatus,
};
use crate::protocol::runtime_spec::{
    Aggregate, MetricCommandFormat, NodeMetricCommand, ReaderMapEntry,
};
use crate::protocol::{NODE_METRIC_COMMANDS_MAX, NODE_METRICS_CUSTOM_MAX};
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
pub const RESERVED_PREFIXES: [&str; 3] = ["node.", "endpoint.", "runtime."];

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
    format: MetricCommandFormat,
    command_name: &str,
    bytes: &[u8],
) -> Result<Vec<Series>, MetricCommandError> {
    let text = std::str::from_utf8(bytes).map_err(|_| MetricCommandError::Parse)?;
    let mut parsed = match format {
        MetricCommandFormat::Lines => parse_lines(command_name, text)?,
        MetricCommandFormat::Json => parse_json(text)?,
        MetricCommandFormat::Prometheus => parse_prometheus(text),
    };
    if parsed.is_empty() {
        return Err(MetricCommandError::Parse);
    }
    parsed.truncate(NODE_METRICS_CUSTOM_MAX);
    Ok(parsed)
}

/// `<name> <number>` per line, or exactly one bare number (named after the
/// command). Blank lines and `#` comments are skipped.
fn parse_lines(command_name: &str, text: &str) -> Result<Vec<Series>, MetricCommandError> {
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    if let [only] = lines.as_slice()
        && let Ok(value) = only.parse::<f64>()
    {
        return Ok(series(command_name, BTreeMap::new(), value)
            .into_iter()
            .collect());
    }
    Ok(lines
        .iter()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.next()?;
            let value = fields.next()?.parse::<f64>().ok()?;
            if fields.next().is_some() {
                return None;
            }
            series(name, BTreeMap::new(), value)
        })
        .collect())
}

fn parse_json(text: &str) -> Result<Vec<Series>, MetricCommandError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| MetricCommandError::Parse)?;
    let serde_json::Value::Object(map) = value else {
        return Err(MetricCommandError::Parse);
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
) -> Result<Vec<u8>, MetricCommandError> {
    if crate::child_env::validate_command(command).is_err() || command.trim().is_empty() {
        return Err(MetricCommandError::Spawn);
    }
    let (shell, flag) = crate::child_env::exec_shell();
    let args = [flag.to_string(), command.to_string()];
    crate::bounded_run::run(shell, &args, timeout, OUTPUT_LIMIT, cancel).map_err(
        |error| match error {
            RunError::Spawn | RunError::Resources | RunError::Cancelled => {
                MetricCommandError::Spawn
            }
            RunError::Timeout => MetricCommandError::Timeout,
            RunError::OutputTooLarge => MetricCommandError::OutputTooLarge,
            RunError::ExitStatus => MetricCommandError::ExitStatus,
        },
    )
}

/// A command as the runner sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandSpec {
    pub name: String,
    pub command: String,
    pub interval_secs: u32,
    pub timeout_secs: u32,
    pub format: MetricCommandFormat,
    pub command_sha256: String,
    pub map: Option<BTreeMap<String, ReaderMapEntry>>,
}

impl CommandSpec {
    /// `None` for a command this node will not run (bad name or bounds).
    pub fn from_definition(definition: &NodeMetricCommand) -> Option<Self> {
        let interval_secs = u32::from(definition.interval_secs);
        let timeout_secs = u32::from(definition.timeout_secs);
        let valid = is_metric_name(&definition.name)
            && (INTERVAL_MIN_SECS..=INTERVAL_MAX_SECS).contains(&interval_secs)
            && (TIMEOUT_MIN_SECS..=TIMEOUT_MAX_SECS).contains(&timeout_secs)
            && !definition.command.trim().is_empty()
            && crate::child_env::validate_command(&definition.command).is_ok();
        valid.then(|| Self {
            name: definition.name.clone(),
            command: definition.command.clone(),
            interval_secs,
            timeout_secs,
            format: definition.format,
            command_sha256: sha256_hex(definition.command.as_bytes()),
            map: definition.map.clone(),
        })
    }
}

/// Run a command once and parse its output.
pub fn run_spec(
    spec: &CommandSpec,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<Series>, MetricCommandError> {
    let output = run_command(
        &spec.command,
        Duration::from_secs(u64::from(spec.timeout_secs)),
        cancel,
    )?;
    match &spec.map {
        Some(map) => map_output(spec.format, map, &output),
        None => parse_output(spec.format, &spec.name, &output),
    }
}

fn aggregate(values: &[f64], how: Option<Aggregate>) -> Option<f64> {
    match how.unwrap_or(Aggregate::Sum) {
        Aggregate::Sum => (!values.is_empty()).then(|| values.iter().sum()),
        Aggregate::Max => values.iter().copied().reduce(f64::max),
        Aggregate::First => values.first().copied(),
    }
}

/// Numbers at a JSON pointer: one number (booleans count 1/0), or every
/// number in an array there.
fn json_numbers(document: &serde_json::Value, pointer: &str) -> Vec<f64> {
    let number = |value: &serde_json::Value| match value {
        serde_json::Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        other => other.as_f64(),
    };
    match document.pointer(pointer) {
        Some(serde_json::Value::Array(items)) => items.iter().filter_map(number).collect(),
        Some(value) => number(value).into_iter().collect(),
        None => Vec::new(),
    }
}

/// The values a series selector picks from parsed text series.
fn series_numbers(
    parsed: &[Series],
    name: &str,
    labels: Option<&BTreeMap<String, String>>,
) -> Vec<f64> {
    parsed
        .iter()
        .filter(|series| {
            series.name == name
                && labels.is_none_or(|wanted| {
                    wanted
                        .iter()
                        .all(|(key, value)| series.labels.get(key) == Some(value))
                })
        })
        .map(|series| series.value)
        .collect()
}

/// Picks the numbers a selector (pointer or series name, plus labels) names.
type SeriesPicker = dyn Fn(&str, Option<&BTreeMap<String, String>>) -> Vec<f64>;

/// Apply a command's `map`: one series per mapped metric that resolved.
pub fn map_output(
    format: MetricCommandFormat,
    map: &BTreeMap<String, ReaderMapEntry>,
    bytes: &[u8],
) -> Result<Vec<Series>, MetricCommandError> {
    let text = std::str::from_utf8(bytes).map_err(|_| MetricCommandError::Parse)?;
    let pick: Box<SeriesPicker> = match format {
        MetricCommandFormat::Json => {
            let document: serde_json::Value =
                serde_json::from_str(text).map_err(|_| MetricCommandError::Parse)?;
            Box::new(move |pointer, _| json_numbers(&document, pointer))
        }
        MetricCommandFormat::Prometheus => {
            let parsed = parse_prometheus(text);
            Box::new(move |name, labels| series_numbers(&parsed, name, labels))
        }
        MetricCommandFormat::Lines => {
            let parsed = parse_lines("value", text)?;
            Box::new(move |name, labels| series_numbers(&parsed, name, labels))
        }
    };
    let mut out = Vec::new();
    for (metric, entry) in map {
        let Some(mut value) =
            aggregate(&pick(&entry.series, entry.labels.as_ref()), entry.aggregate)
        else {
            continue;
        };
        if let Some(scale) = entry.scale {
            value *= scale;
        }
        if let Some(divide_by) = &entry.divide_by {
            let Some(divisor) = aggregate(&pick(divide_by, entry.labels.as_ref()), entry.aggregate)
            else {
                continue;
            };
            if divisor == 0.0 {
                continue;
            }
            value /= divisor;
        }
        out.extend(series(metric, BTreeMap::new(), value));
    }
    if out.is_empty() {
        return Err(MetricCommandError::Parse);
    }
    out.truncate(NODE_METRICS_CUSTOM_MAX);
    Ok(out)
}

#[derive(Debug)]
struct LastValues {
    series: Vec<Series>,
    ts: String,
    at: Instant,
}

#[derive(Debug)]
struct CommandState {
    spec: CommandSpec,
    next_due: Instant,
    /// The id of THIS state's run in flight, if any. A result counts only
    /// when it carries this id (a run of a replaced definition never does).
    attempt: Option<u64>,
    last: Option<LastValues>,
    error: Option<MetricCommandError>,
}

/// A run that has not reported yet, live or already cancelled. The runner
/// owns every such run until it reports (or is given up on), so a replaced
/// or withdrawn command's dying run stays cancellable and blocks a new run
/// of the same command.
#[derive(Debug)]
struct Attempt {
    name: String,
    /// Ends this run only (each attempt owns its flag).
    cancel: Arc<AtomicBool>,
    /// A run always returns within its timeout plus the reap grace; past
    /// this the attempt is forgotten so a lost report cannot block forever.
    give_up_at: Instant,
}

const ATTEMPT_GRACE: Duration = Duration::from_secs(10);

/// End every unreported run of this command (idempotent).
fn cancel_name(attempts: &BTreeMap<u64, Attempt>, name: &str) {
    for attempt in attempts.values().filter(|attempt| attempt.name == name) {
        attempt.cancel.store(true, Ordering::SeqCst);
    }
}

struct RunResult {
    name: String,
    attempt: u64,
    command_sha256: String,
    outcome: Result<Vec<Series>, MetricCommandError>,
    ts: String,
    at: Instant,
}

/// Schedules command runs on short-lived threads and keeps their latest
/// values. Owned by the telemetry thread; nothing here blocks.
pub struct Runner {
    states: BTreeMap<String, CommandState>,
    results_tx: Sender<RunResult>,
    results_rx: Receiver<RunResult>,
    changed: bool,
    /// Every unreported run, by attempt id: the one place runs are ended
    /// early (`cancel_name`, `Drop`) and the one place "in flight" is read.
    attempts: BTreeMap<u64, Attempt>,
    next_attempt: u64,
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

impl Default for Runner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner {
    pub fn new() -> Self {
        let (results_tx, results_rx) = mpsc::channel();
        Self {
            states: BTreeMap::new(),
            results_tx,
            results_rx,
            changed: false,
            attempts: BTreeMap::new(),
            next_attempt: 0,
        }
    }

    /// Replace the node's metric commands (a define or a frozen copy).
    /// Commands this node will not run are left out; at most 16 run.
    pub fn set_commands(&mut self, definitions: &[NodeMetricCommand]) {
        let now = Instant::now();
        let mut next = BTreeMap::new();
        for spec in definitions
            .iter()
            .filter_map(CommandSpec::from_definition)
            .take(NODE_METRIC_COMMANDS_MAX)
        {
            let name = spec.name.clone();
            if next.contains_key(&name) {
                continue;
            }
            let state = match self.states.remove(&name) {
                Some(state) if state.spec == spec => state,
                previous => {
                    self.changed = true;
                    // The definition changed: the run of the old one must
                    // not keep executing.
                    if previous.is_some() {
                        cancel_name(&self.attempts, &name);
                    }
                    CommandState {
                        spec,
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
            next.insert(name, state);
        }
        // What is left in the old map was withdrawn: end its run too.
        for withdrawn in self.states.keys() {
            cancel_name(&self.attempts, withdrawn);
        }
        if !self.states.is_empty() {
            self.changed = true;
        }
        self.states = next;
    }

    /// True once after a run finished or a command's state changed.
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// Collect finished runs and start due ones.
    pub fn tick(&mut self, now: Instant) {
        // A run that never reported (a lost thread) is forgotten after its
        // bound, so its command is not blocked forever.
        let mut given_up = Vec::new();
        self.attempts.retain(|id, attempt| {
            if now < attempt.give_up_at {
                return true;
            }
            attempt.cancel.store(true, Ordering::SeqCst);
            given_up.push((*id, attempt.name.clone()));
            false
        });
        for (id, name) in given_up {
            if let Some(state) = self.states.get_mut(&name)
                && state.attempt == Some(id)
            {
                state.attempt = None;
            }
        }
        while let Ok(result) = self.results_rx.try_recv() {
            self.attempts.remove(&result.attempt);
            let Some(state) = self.states.get_mut(&result.name) else {
                continue;
            };
            // Only this state's own run counts: a cancelled run of a
            // replaced or withdrawn definition never clears (or feeds) its
            // successor.
            if state.attempt != Some(result.attempt) {
                continue;
            }
            state.attempt = None;
            if state.spec.command_sha256 != result.command_sha256 {
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
                    tracing::debug!(command = %state.spec.name, ?error, "metric command run failed");
                    // A failed run reports nothing: earlier values are not
                    // passed off as current.
                    state.last = None;
                    state.error = Some(error);
                }
            }
            self.changed = true;
        }
        for (name, state) in &mut self.states {
            if state.attempt.is_some()
                || now < state.next_due
                || self.attempts.values().any(|attempt| attempt.name == *name)
            {
                continue;
            }
            self.next_attempt += 1;
            let attempt_id = self.next_attempt;
            state.next_due = now + Duration::from_secs(u64::from(state.spec.interval_secs));
            let spec = state.spec.clone();
            let tx = self.results_tx.clone();
            let cancel = Arc::new(AtomicBool::new(false));
            let name_for_thread = name.clone();
            let cancel_for_thread = Arc::clone(&cancel);
            let spawned = thread::Builder::new()
                .name("wsmp-metric-command".to_string())
                .spawn(move || {
                    let outcome = run_spec(&spec, Some(&cancel_for_thread));
                    let _ = tx.send(RunResult {
                        name: name_for_thread,
                        attempt: attempt_id,
                        command_sha256: spec.command_sha256,
                        outcome,
                        ts: crate::telemetry::now_rfc3339(),
                        at: Instant::now(),
                    });
                });
            if spawned.is_err() {
                state.error = Some(MetricCommandError::Spawn);
                continue;
            }
            state.attempt = Some(attempt_id);
            self.attempts.insert(
                attempt_id,
                Attempt {
                    name: name.clone(),
                    cancel,
                    give_up_at: now
                        + Duration::from_secs(u64::from(state.spec.timeout_secs))
                        + crate::bounded_run::REAP_GRACE
                        + ATTEMPT_GRACE,
                },
            );
        }
    }

    /// Series to report and every command's status.
    pub fn report(&self, now: Instant) -> (Vec<CustomMetric>, Vec<MetricCommandStatus>) {
        let mut custom = Vec::new();
        let mut statuses = Vec::new();
        for state in self.states.values() {
            let spec = &state.spec;
            statuses.push(MetricCommandStatus {
                name: spec.name.clone(),
                state: if state.error.is_some() {
                    MetricCommandState::Failing
                } else {
                    MetricCommandState::Active
                },
                error: state.error,
            });
            let Some(last) = &state.last else { continue };
            let stale_after =
                Duration::from_secs(u64::from(spec.interval_secs) * u64::from(STALE_INTERVALS));
            if now.duration_since(last.at) >= stale_after {
                continue;
            }
            for series in &last.series {
                custom.push(CustomMetric {
                    name: series.name.clone(),
                    labels: (!series.labels.is_empty()).then(|| series.labels.clone()),
                    value: series.value,
                    ts: last.ts.clone(),
                });
            }
        }
        custom.truncate(NODE_METRICS_CUSTOM_MAX);
        (custom, statuses)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mapped_metrics_select_aggregate_scale_and_divide() {
        use crate::protocol::runtime_spec::{Aggregate, ReaderMapEntry};
        let entry = |series: &str| ReaderMapEntry {
            series: series.to_string(),
            labels: None,
            aggregate: None,
            scale: None,
            divide_by: None,
        };
        let mut map = BTreeMap::new();
        map.insert("gpu_busy".to_string(), entry("/gpus"));
        map.insert(
            "mem_used_fraction".to_string(),
            ReaderMapEntry {
                divide_by: Some("/mem/total".into()),
                ..entry("/mem/used")
            },
        );
        map.insert(
            "first_gpu".to_string(),
            ReaderMapEntry {
                aggregate: Some(Aggregate::First),
                scale: Some(0.5),
                ..entry("/gpus")
            },
        );
        map.insert("missing".to_string(), entry("/nope"));
        let output = br#"{"gpus":[10,20,true],"mem":{"used":3,"total":4}}"#;
        let series = map_output(MetricCommandFormat::Json, &map, output).expect("mapped");
        let value = |name: &str| series.iter().find(|s| s.name == name).map(|s| s.value);
        assert_eq!(value("gpu_busy"), Some(31.0));
        assert_eq!(value("mem_used_fraction"), Some(0.75));
        assert_eq!(value("first_gpu"), Some(5.0));
        assert_eq!(value("missing"), None);

        let mut prom = BTreeMap::new();
        prom.insert(
            "busy".to_string(),
            ReaderMapEntry {
                labels: Some([("gpu".to_string(), "1".to_string())].into()),
                aggregate: Some(Aggregate::Max),
                ..entry("dcgm_util")
            },
        );
        let text = b"dcgm_util{gpu=\"0\"} 5\ndcgm_util{gpu=\"1\"} 7\n";
        let series = map_output(MetricCommandFormat::Prometheus, &prom, text).expect("mapped");
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].value, 7.0);
        assert!(map_output(MetricCommandFormat::Json, &map, b"not json").is_err());
    }

    use super::*;

    fn definition(name: &str, command: &str) -> NodeMetricCommand {
        NodeMetricCommand {
            name: name.to_string(),
            command: command.to_string(),
            interval_secs: 10,
            timeout_secs: 5,
            format: MetricCommandFormat::Lines,
            map: None,
        }
    }

    #[test]
    fn lines_format_names_a_bare_number_after_the_command() {
        let parsed = parse_output(MetricCommandFormat::Lines, "fan_rpm", b" 1200.5\n").expect("ok");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "fan_rpm");
        assert_eq!(parsed[0].value, 1200.5);
        let named = parse_output(
            MetricCommandFormat::Lines,
            "fans",
            b"# fans\nfan0 1200\nfan1 900.5\nbad line here\nnode.cpu 3\n",
        )
        .expect("ok");
        let names = named.iter().map(|s| s.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["fan0", "fan1"]);
        for bad in [&b"NaN"[..], b"inf", b"hot", b"", b"1 2 3"] {
            assert_eq!(
                parse_output(MetricCommandFormat::Lines, "fan_rpm", bad),
                Err(MetricCommandError::Parse),
                "{bad:?}"
            );
        }
        assert_eq!(
            parse_output(MetricCommandFormat::Lines, "x", &[0xff, 0xfe]),
            Err(MetricCommandError::Parse)
        );
    }

    #[test]
    fn json_format_keeps_valid_numeric_entries() {
        let parsed = parse_output(
            MetricCommandFormat::Json,
            "src",
            br#"{"queue.depth": 3, "bad name": 1, "text": "7", "node.cpu": 5, "ok": 1e3}"#,
        )
        .expect("ok");
        let names = parsed.iter().map(|s| s.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["ok", "queue.depth"]);
        assert_eq!(
            parse_output(MetricCommandFormat::Json, "src", b"[1,2]"),
            Err(MetricCommandError::Parse)
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
runtime.running 3
weird{gpu="0"} 1 notatimestamp
escaped{v="a\"b"} 1
"#;
        let parsed =
            parse_output(MetricCommandFormat::Prometheus, "src", text.as_bytes()).expect("ok");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].name, "gpu_temp");
        assert_eq!(parsed[0].labels.get("gpu").map(String::as_str), Some("0"));
        assert_eq!(parsed[1].labels.len(), 2);
        assert_eq!(parsed[1].value, 64.5);
        assert_eq!(parsed[2].name, "up");
    }

    #[test]
    fn a_reserved_label_key_drops_the_series() {
        let prometheus = "bad{__proto__=\"x\"} 1\ngood{proto=\"x\"} 2\n";
        let parsed = parse_output(
            MetricCommandFormat::Prometheus,
            "src",
            prometheus.as_bytes(),
        )
        .expect("ok");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "good");
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
            parse_output(MetricCommandFormat::Prometheus, "src", text.as_bytes()).expect("ok");
        assert_eq!(parsed.len(), NODE_METRICS_CUSTOM_MAX);
        let labels = (0..17)
            .map(|index| format!("l{index}=\"v\""))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            parse_output(
                MetricCommandFormat::Prometheus,
                "src",
                format!("many{{{labels}}} 1\n").as_bytes()
            ),
            Err(MetricCommandError::Parse)
        );
    }

    #[test]
    fn invalid_definitions_never_run_and_names_are_unique() {
        let mut fast = definition("fast", "echo 1");
        fast.interval_secs = 2;
        let mut runner = Runner::new();
        runner.set_commands(&[
            definition("fans", "echo 1"),
            definition("fans", "echo 2"),
            fast,
            definition("bad name", "echo 1"),
        ]);
        let (_, statuses) = runner.report(Instant::now());
        assert_eq!(
            statuses
                .iter()
                .map(|status| status.name.as_str())
                .collect::<Vec<_>>(),
            ["fans"]
        );
        assert_eq!(statuses[0].state, MetricCommandState::Active);
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
            Err(MetricCommandError::ExitStatus)
        );
    }

    #[cfg(unix)]
    #[test]
    fn oversized_output_is_dropped() {
        assert_eq!(
            run_command("head -c 70000 /dev/zero", Duration::from_secs(5), None),
            Err(MetricCommandError::OutputTooLarge)
        );
        let started = Instant::now();
        assert_eq!(
            run_command("yes 1", Duration::from_secs(20), None),
            Err(MetricCommandError::OutputTooLarge)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    fn is_alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
            && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|stat| stat.contains(") Z "))
                .unwrap_or(false)
    }

    #[cfg(unix)]
    fn wait_for_pid(pid_file: &std::path::Path) -> i32 {
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
    #[test]
    fn timeout_kills_the_whole_process_group() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("bg.pid");
        let command = format!("sleep 30 & echo $! > '{}'; sleep 30", pid_file.display());
        let started = Instant::now();
        assert_eq!(
            run_command(&command, Duration::from_secs(1), None),
            Err(MetricCommandError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid = wait_for_pid(&pid_file);
        let deadline = Instant::now() + Duration::from_secs(5);
        while is_alive(pid) {
            assert!(Instant::now() < deadline, "background child survived");
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    #[test]
    fn runner_reports_values_and_drops_stale_ones() {
        let mut runner = Runner::new();
        runner.set_commands(&[definition("temp", "echo 71")]);
        runner.take_changed();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            runner.tick(Instant::now());
            let (custom, _) = runner.report(Instant::now());
            if let Some(metric) = custom.first() {
                assert_eq!(metric.name, "temp");
                assert_eq!(metric.value, 71.0);
                assert!(runner.take_changed());
                break;
            }
            assert!(Instant::now() < deadline, "no value reported");
            thread::sleep(Duration::from_millis(20));
        }
        let (custom, _) = runner.report(Instant::now() + Duration::from_secs(31));
        assert!(custom.is_empty());
    }

    /// A changed or withdrawn definition ends the run in flight at once; an
    /// unchanged one leaves it alone; dropping the runner ends it too.
    #[cfg(unix)]
    #[test]
    fn a_run_in_flight_ends_when_its_definition_changes() {
        #[derive(Clone, Copy, Debug)]
        enum Change {
            Command,
            Withdraw,
            Unchanged,
        }
        for change in [Change::Command, Change::Withdraw, Change::Unchanged] {
            let dir = tempfile::tempdir().expect("tempdir");
            let pid_file = dir.path().join("run.pid");
            let command = format!("echo $$ > '{}'; sleep 60 & wait", pid_file.display());
            let mut slow = definition("slow", &command);
            slow.timeout_secs = 60;
            let mut runner = Runner::new();
            runner.set_commands(std::slice::from_ref(&slow));
            runner.tick(Instant::now());
            let pid = wait_for_pid(&pid_file);
            match change {
                Change::Command => {
                    let mut changed = slow.clone();
                    changed.command = format!("{command}; echo 2");
                    runner.set_commands(&[changed]);
                }
                Change::Withdraw => runner.set_commands(&[]),
                Change::Unchanged => runner.set_commands(std::slice::from_ref(&slow)),
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
                Change::Unchanged => assert!(survived, "{change:?}: an unchanged run was killed"),
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

    #[cfg(unix)]
    #[test]
    fn a_failed_run_drops_the_previous_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let flag = dir.path().join("ok");
        std::fs::write(&flag, "").expect("flag");
        let mut runner = Runner::new();
        runner.set_commands(&[definition(
            "flaky",
            &format!("test -f '{}' && echo 5 || exit 3", flag.display()),
        )]);
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
            if statuses[0].state == MetricCommandState::Failing {
                assert!(custom.is_empty());
                assert_eq!(statuses[0].error, Some(MetricCommandError::ExitStatus));
                break;
            }
            assert!(Instant::now() < deadline, "the failed run was not observed");
            thread::sleep(Duration::from_millis(20));
        }
    }
}
