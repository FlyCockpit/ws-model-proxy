//! Custom engine adapter: a per-endpoint route or command that produces
//! normalized engine signals (relay 2.9).
//!
//! Values outside their range are dropped, not clamped. A reading without
//! `running` is not sent. Adapter status never includes command text, raw
//! output, stderr, route bodies, or label values.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::bounded_run::RunError;
use crate::config::EndpointConfig;
use crate::engine::{LoadReading, LoadSource, PromSample, parse_prometheus};
use crate::metric_sources::{OUTPUT_LIMIT, sha256_hex};
use crate::protocol::RemoteEngineAdapter;
use crate::telemetry_bounds::LOAD_COUNT_MAX;

pub const ADAPTER_INTERVAL_MIN_SECS: u32 = 2;
pub const ADAPTER_INTERVAL_MAX_SECS: u32 = 5;
pub const ADAPTER_TIMEOUT_MIN_SECS: u32 = 1;
pub const ADAPTER_TIMEOUT_MAX_SECS: u32 = 4;
const TOKEN_COUNT_MAX: u64 = 1_000_000_000_000;
const SLOTS_MAX: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdapterSignal {
    Running,
    Waiting,
    KvUsage,
    KvOccupancy,
    SlotsBusy,
    Deferred,
    PrefixCacheHitsTotal,
    PrefixCacheQueriesTotal,
    KvTokens,
    Slots,
    MaxModelLen,
    CtxPerSlot,
}

impl AdapterSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::KvUsage => "kvUsage",
            Self::KvOccupancy => "kvOccupancy",
            Self::SlotsBusy => "slotsBusy",
            Self::Deferred => "deferred",
            Self::PrefixCacheHitsTotal => "prefixCacheHitsTotal",
            Self::PrefixCacheQueriesTotal => "prefixCacheQueriesTotal",
            Self::KvTokens => "kvTokens",
            Self::Slots => "slots",
            Self::MaxModelLen => "maxModelLen",
            Self::CtxPerSlot => "ctxPerSlot",
        }
    }

    fn is_fraction(self) -> bool {
        matches!(self, Self::KvUsage | Self::KvOccupancy)
    }
}

const CANONICAL_SIGNALS: [AdapterSignal; 12] = [
    AdapterSignal::Running,
    AdapterSignal::Waiting,
    AdapterSignal::KvUsage,
    AdapterSignal::KvOccupancy,
    AdapterSignal::SlotsBusy,
    AdapterSignal::Deferred,
    AdapterSignal::PrefixCacheHitsTotal,
    AdapterSignal::PrefixCacheQueriesTotal,
    AdapterSignal::KvTokens,
    AdapterSignal::Slots,
    AdapterSignal::MaxModelLen,
    AdapterSignal::CtxPerSlot,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterFormat {
    Json,
    Prometheus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AggregateKind {
    Sum,
    Max,
    First,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalSelector {
    pub series: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<AggregateKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
}

impl PartialEq for SignalSelector {
    fn eq(&self, other: &Self) -> bool {
        self.series == other.series
            && self.labels == other.labels
            && self.aggregate == other.aggregate
            && match (self.scale, other.scale) {
                (None, None) => true,
                (Some(left), Some(right)) => left.to_bits() == right.to_bits(),
                _ => false,
            }
    }
}

impl Eq for SignalSelector {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AdapterInput {
    Route { route: String },
    Command { command: String },
}

impl AdapterInput {
    pub fn kind(&self) -> AdapterInputKind {
        match self {
            Self::Route { .. } => AdapterInputKind::Route,
            Self::Command { .. } => AdapterInputKind::Command,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterInputKind {
    Route,
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAdapterConfig {
    pub input: AdapterInput,
    pub format: AdapterFormat,
    #[serde(default = "default_interval_secs")]
    pub interval_secs: u32,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub map: BTreeMap<AdapterSignal, SignalSelector>,
    /// Optional POST path that counts Chat Completions tokens, like a load route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count_route: Option<String>,
}

fn default_interval_secs() -> u32 {
    ADAPTER_INTERVAL_MIN_SECS
}

fn default_timeout_secs() -> u32 {
    2
}

impl EngineAdapterConfig {
    pub fn validate(&self) -> Result<()> {
        match &self.input {
            AdapterInput::Route { route } => validate_route(route)
                .map_err(|reason| anyhow::anyhow!("adapter route is invalid: {reason}"))?,
            AdapterInput::Command { command } => {
                if command.trim().is_empty() {
                    bail!("adapter command cannot be empty");
                }
                crate::child_env::validate_command(command)
                    .map_err(|reason| anyhow::anyhow!("adapter command is invalid: {reason}"))?;
            }
        }
        if !(ADAPTER_INTERVAL_MIN_SECS..=ADAPTER_INTERVAL_MAX_SECS).contains(&self.interval_secs) {
            bail!(
                "adapter intervalSecs must be an integer from {ADAPTER_INTERVAL_MIN_SECS} to {ADAPTER_INTERVAL_MAX_SECS}"
            );
        }
        if !(ADAPTER_TIMEOUT_MIN_SECS..=ADAPTER_TIMEOUT_MAX_SECS).contains(&self.timeout_secs) {
            bail!(
                "adapter timeoutSecs must be an integer from {ADAPTER_TIMEOUT_MIN_SECS} to {ADAPTER_TIMEOUT_MAX_SECS}"
            );
        }
        if self.format == AdapterFormat::Prometheus && self.map.is_empty() {
            bail!("prometheus adapters need a map from signals to series");
        }
        for selector in self.map.values() {
            if selector.series.trim().is_empty() {
                bail!("adapter map series cannot be empty");
            }
        }
        if let Some(route) = &self.count_route {
            validate_route(route)
                .map_err(|reason| anyhow::anyhow!("adapter count route is invalid: {reason}"))?;
        }
        Ok(())
    }

    pub fn signals(&self) -> Vec<AdapterSignal> {
        if self.map.is_empty() {
            CANONICAL_SIGNALS.to_vec()
        } else {
            self.map.keys().copied().collect()
        }
    }

    pub fn input_kind(&self) -> AdapterInputKind {
        self.input.kind()
    }
}

/// Integer facts cached from the last successful adapter run at probe time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCachedFacts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slots: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_per_slot: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_model_len: Option<u64>,
}

impl AdapterCachedFacts {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterError {
    Spawn,
    Timeout,
    ExitStatus,
    OutputTooLarge,
    Parse,
    Http,
    OutOfRange,
    Unmapped,
}

impl AdapterError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spawn => "spawn",
            Self::Timeout => "timeout",
            Self::ExitStatus => "exit_status",
            Self::OutputTooLarge => "output_too_large",
            Self::Parse => "parse",
            Self::Http => "http",
            Self::OutOfRange => "out_of_range",
            Self::Unmapped => "unmapped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterState {
    Active,
    Failing,
    Disabled,
    PendingApproval,
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAdapterStatus {
    pub endpoint_slug: String,
    pub input: AdapterInputKind,
    pub state: AdapterState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AdapterError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DropReason {
    Unmapped,
    OutOfRange,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedSignal {
    pub signal: AdapterSignal,
    pub reason: DropReason,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdapterSample {
    pub reading: Option<LoadReading>,
    pub facts: AdapterCachedFacts,
    pub values: BTreeMap<AdapterSignal, f64>,
    pub dropped: Vec<DroppedSignal>,
    pub missing: Vec<AdapterSignal>,
    pub error: Option<AdapterError>,
}

/// How the load scheduler scrapes one endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadPlan {
    BuiltIn(crate::engine::EngineKind),
    Adapter(EngineAdapterConfig),
}

/// Path on the endpoint origin: one leading `/`, no scheme, host, whitespace,
/// `..`, query, or fragment. `Url::join` still has to stay on that origin.
pub fn validate_route(route: &str) -> Result<(), &'static str> {
    if route.is_empty() {
        return Err("empty");
    }
    if route.bytes().any(|byte| byte <= 32 || byte == 127) {
        return Err("control");
    }
    if route.contains('\\') {
        return Err("backslash");
    }
    if has_scheme_prefix(route) {
        return Err("scheme");
    }
    if route.starts_with("//") {
        return Err("host");
    }
    if !route.starts_with('/') {
        return Err("path");
    }
    if route.contains("..") {
        return Err("parent");
    }
    if route.contains('?') {
        return Err("query");
    }
    if route.contains('#') {
        return Err("fragment");
    }
    Ok(())
}

fn has_scheme_prefix(route: &str) -> bool {
    let bytes = route.as_bytes();
    if bytes.first().is_none_or(|byte| !byte.is_ascii_alphabetic()) {
        return false;
    }
    for byte in bytes.iter().skip(1) {
        if *byte == b':' {
            return true;
        }
        if !byte.is_ascii_alphanumeric() && !matches!(byte, b'+' | b'-' | b'.') {
            return false;
        }
    }
    false
}

/// Parse `--map signal=series[{k="v"}][*scale]`.
pub fn parse_map_flag(raw: &str) -> Result<(AdapterSignal, SignalSelector)> {
    let Some((name, rest)) = raw.split_once('=') else {
        bail!("map `{raw}` must use `signal=series`");
    };
    let signal: AdapterSignal = serde_json::from_value(serde_json::Value::String(name.to_string()))
        .map_err(|_| anyhow::anyhow!("unknown adapter signal `{name}`"))?;
    let rest = rest.trim();
    if rest.is_empty() {
        bail!("map `{raw}` is missing a series name");
    }
    let (body, scale) = match rest.rsplit_once('*') {
        Some((body, scale_text)) if !body.is_empty() && !scale_text.is_empty() => {
            let scale: f64 = scale_text
                .parse()
                .map_err(|_| anyhow::anyhow!("map `{raw}` scale is not a number"))?;
            if !scale.is_finite() {
                bail!("map `{raw}` scale is not finite");
            }
            (body, Some(scale))
        }
        _ => (rest, None),
    };
    let (series, labels) = if let Some(start) = body.find('{') {
        let series = body[..start].trim().to_string();
        if series.is_empty() {
            bail!("map `{raw}` is missing a series name");
        }
        let labels = parse_selector_labels(&body[start..])
            .ok_or_else(|| anyhow::anyhow!("map `{raw}` labels are invalid"))?;
        (series, labels)
    } else {
        (body.trim().to_string(), BTreeMap::new())
    };
    Ok((
        signal,
        SignalSelector {
            series,
            labels,
            aggregate: None,
            scale,
        },
    ))
}

fn parse_selector_labels(text: &str) -> Option<BTreeMap<String, String>> {
    let body = text.trim().strip_prefix('{')?.strip_suffix('}')?;
    if body.trim().is_empty() {
        return Some(BTreeMap::new());
    }
    let mut labels = BTreeMap::new();
    for part in body.split(',') {
        let (key, value) = part.split_once('=')?;
        let key = key.trim();
        let value = value.trim().strip_prefix('"')?.strip_suffix('"')?;
        if key.is_empty() {
            return None;
        }
        labels.insert(key.to_string(), value.to_string());
    }
    Some(labels)
}

pub fn sample(
    endpoint: &EndpointConfig,
    spec: &EngineAdapterConfig,
    cancel: Option<&AtomicBool>,
) -> Result<AdapterSample, AdapterError> {
    let body = fetch_body(endpoint, spec, cancel)?;
    parse_adapter_body(spec, &body)
}

fn fetch_body(
    endpoint: &EndpointConfig,
    spec: &EngineAdapterConfig,
    cancel: Option<&AtomicBool>,
) -> Result<String, AdapterError> {
    let timeout = Duration::from_secs(u64::from(spec.timeout_secs));
    match &spec.input {
        AdapterInput::Route { route } => {
            validate_route(route).map_err(|_| AdapterError::Http)?;
            let agent = crate::engine::http_agent(timeout);
            let limit = match spec.format {
                AdapterFormat::Json => crate::engine::JSON_BODY_LIMIT,
                AdapterFormat::Prometheus => crate::engine::METRICS_BODY_LIMIT,
            };
            crate::engine::fetch_route(&agent, endpoint, route, limit)
                .map_err(|_| AdapterError::Http)
        }
        AdapterInput::Command { command } => {
            let bytes = run_adapter_command(command, timeout, cancel)?;
            String::from_utf8(bytes).map_err(|_| AdapterError::Parse)
        }
    }
}

fn run_adapter_command(
    command: &str,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, AdapterError> {
    if crate::child_env::validate_command(command).is_err() || command.trim().is_empty() {
        return Err(AdapterError::Spawn);
    }
    let (shell, flag) = crate::child_env::exec_shell();
    let args = [flag.to_string(), command.to_string()];
    crate::bounded_run::run(shell, &args, timeout, OUTPUT_LIMIT, cancel).map_err(
        |error| match error {
            RunError::Spawn | RunError::Resources | RunError::Cancelled => AdapterError::Spawn,
            RunError::Timeout => AdapterError::Timeout,
            RunError::OutputTooLarge => AdapterError::OutputTooLarge,
            RunError::ExitStatus => AdapterError::ExitStatus,
        },
    )
}

/// Parse adapter stdout or a route body into normalized signals.
pub fn parse_adapter_body(
    spec: &EngineAdapterConfig,
    body: &str,
) -> Result<AdapterSample, AdapterError> {
    let raw = match spec.format {
        AdapterFormat::Json => collect_json(spec, body)?,
        AdapterFormat::Prometheus => collect_prometheus(spec, body)?,
    };
    Ok(normalize(spec, raw))
}

fn collect_json(
    spec: &EngineAdapterConfig,
    body: &str,
) -> Result<BTreeMap<AdapterSignal, Option<f64>>, AdapterError> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| AdapterError::Parse)?;
    let object = value.as_object().ok_or(AdapterError::Parse)?;
    let mut out = BTreeMap::new();
    if spec.map.is_empty() {
        for signal in CANONICAL_SIGNALS {
            out.insert(signal, json_number(object.get(signal.as_str())));
        }
        if out.values().all(Option::is_none) {
            return Err(AdapterError::Parse);
        }
        return Ok(out);
    }
    for (signal, selector) in &spec.map {
        let number = json_number(object.get(selector.series.as_str()))
            .map(|value| apply_scale(value, selector.scale));
        out.insert(*signal, number);
    }
    Ok(out)
}

fn json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .filter(|n| n.is_finite())
}

fn collect_prometheus(
    spec: &EngineAdapterConfig,
    body: &str,
) -> Result<BTreeMap<AdapterSignal, Option<f64>>, AdapterError> {
    if spec.map.is_empty() {
        return Err(AdapterError::Parse);
    }
    let samples = parse_prometheus(body);
    if samples.is_empty() {
        return Err(AdapterError::Parse);
    }
    let mut out = BTreeMap::new();
    for (signal, selector) in &spec.map {
        out.insert(*signal, select_prometheus(&samples, selector, *signal));
    }
    Ok(out)
}

fn select_prometheus(
    samples: &[PromSample],
    selector: &SignalSelector,
    signal: AdapterSignal,
) -> Option<f64> {
    let matched = samples
        .iter()
        .filter(|sample| {
            sample.name == selector.series
                && sample.value.is_finite()
                && selector
                    .labels
                    .iter()
                    .all(|(key, value)| sample.labels.get(key).is_some_and(|found| found == value))
        })
        .map(|sample| sample.value)
        .collect::<Vec<_>>();
    if matched.is_empty() {
        return None;
    }
    let aggregate = selector.aggregate.unwrap_or(default_aggregate(signal));
    let raw = match aggregate {
        AggregateKind::Sum => matched.iter().sum(),
        AggregateKind::Max => matched.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        AggregateKind::First => matched[0],
    };
    Some(apply_scale(raw, selector.scale))
}

fn default_aggregate(signal: AdapterSignal) -> AggregateKind {
    if signal.is_fraction() {
        AggregateKind::Max
    } else {
        AggregateKind::Sum
    }
}

fn apply_scale(value: f64, scale: Option<f64>) -> f64 {
    match scale {
        Some(scale) if scale.is_finite() => value * scale,
        _ => value,
    }
}

fn normalize(
    spec: &EngineAdapterConfig,
    raw: BTreeMap<AdapterSignal, Option<f64>>,
) -> AdapterSample {
    let expected = spec.signals();
    let mut values = BTreeMap::new();
    let mut dropped = Vec::new();
    let mut missing = Vec::new();
    for signal in &expected {
        match raw.get(signal).copied().flatten() {
            None => {
                dropped.push(DroppedSignal {
                    signal: *signal,
                    reason: DropReason::Unmapped,
                });
                missing.push(*signal);
            }
            Some(value) => match normalize_signal(*signal, value) {
                None => dropped.push(DroppedSignal {
                    signal: *signal,
                    reason: DropReason::OutOfRange,
                }),
                Some(kept) => {
                    values.insert(*signal, kept);
                }
            },
        }
    }
    let facts = AdapterCachedFacts {
        slots: values
            .get(&AdapterSignal::Slots)
            .and_then(|value| u32::try_from(*value as u64).ok()),
        ctx_per_slot: values
            .get(&AdapterSignal::CtxPerSlot)
            .map(|value| *value as u64),
        kv_tokens: values
            .get(&AdapterSignal::KvTokens)
            .map(|value| *value as u64),
        max_model_len: values
            .get(&AdapterSignal::MaxModelLen)
            .map(|value| *value as u64),
    };
    let running = values
        .get(&AdapterSignal::Running)
        .map(|value| *value as u64);
    let reading = running.map(|running| LoadReading {
        running,
        waiting: values
            .get(&AdapterSignal::Waiting)
            .map(|value| *value as u64),
        kv_usage: values.get(&AdapterSignal::KvUsage).copied(),
        kv_occupancy: values.get(&AdapterSignal::KvOccupancy).copied(),
        slots_busy: values
            .get(&AdapterSignal::SlotsBusy)
            .map(|value| *value as u64),
        deferred: values
            .get(&AdapterSignal::Deferred)
            .map(|value| *value as u64),
        prefix_cache_hits_total: values.get(&AdapterSignal::PrefixCacheHitsTotal).copied(),
        prefix_cache_queries_total: values.get(&AdapterSignal::PrefixCacheQueriesTotal).copied(),
        process_start_time_seconds: None,
        source: LoadSource::Custom,
    });
    let error = if reading.is_some() {
        None
    } else if dropped
        .iter()
        .any(|row| row.signal == AdapterSignal::Running && row.reason == DropReason::OutOfRange)
    {
        Some(AdapterError::OutOfRange)
    } else {
        Some(AdapterError::Unmapped)
    };
    AdapterSample {
        reading,
        facts,
        values,
        dropped,
        missing,
        error,
    }
}

fn normalize_signal(signal: AdapterSignal, value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    match signal {
        AdapterSignal::KvUsage | AdapterSignal::KvOccupancy => {
            (0.0..=1.0).contains(&value).then_some(value)
        }
        AdapterSignal::Running
        | AdapterSignal::Waiting
        | AdapterSignal::SlotsBusy
        | AdapterSignal::Deferred => drop_count(value, LOAD_COUNT_MAX),
        AdapterSignal::PrefixCacheHitsTotal | AdapterSignal::PrefixCacheQueriesTotal => {
            // Cumulative since engine start; bound like byte counters so a
            // long-uptime engine keeps reporting. Wire values are deltas.
            drop_count(value, crate::telemetry::BYTE_COUNTER_MAX)
        }
        AdapterSignal::Slots => drop_count(value, SLOTS_MAX).filter(|kept| *kept >= 1.0),
        AdapterSignal::KvTokens | AdapterSignal::MaxModelLen | AdapterSignal::CtxPerSlot => {
            drop_count(value, TOKEN_COUNT_MAX).filter(|kept| *kept >= 1.0)
        }
    }
}

fn drop_count(value: f64, max: u64) -> Option<f64> {
    if value < 0.0 {
        return None;
    }
    let rounded = value.round();
    (rounded <= max as f64).then_some(rounded)
}

/// Local adapter, else an approved remote adapter for this endpoint.
pub fn effective_engine_adapter(
    endpoint: &EndpointConfig,
    remote: &[RemoteEngineAdapter],
    allow_remote: bool,
    approved: &std::collections::BTreeMap<String, String>,
) -> Option<EngineAdapterConfig> {
    if let Some(spec) = endpoint.engine_adapter.clone() {
        return spec.validate().is_ok().then_some(spec);
    }
    let adapter = remote
        .iter()
        .find(|adapter| adapter.endpoint_slug == endpoint.slug)?;
    let spec = adapter.to_config();
    (remote_adapter_eligibility(
        &spec,
        &adapter.endpoint_slug,
        allow_remote,
        false,
        approved.get(&adapter.endpoint_slug).map(String::as_str),
    ) == RemoteAdapterEligibility::Run)
        .then_some(spec)
}

/// Probe-time adapter facts. `None` keeps the previous cache (a short outage
/// must not drop K to null).
pub fn probe_facts(endpoint: &EndpointConfig) -> Option<AdapterCachedFacts> {
    probe_facts_with(endpoint, endpoint.engine_adapter.as_ref())
}

pub fn probe_facts_with(
    endpoint: &EndpointConfig,
    spec: Option<&EngineAdapterConfig>,
) -> Option<AdapterCachedFacts> {
    let spec = spec?;
    match sample(endpoint, spec, None) {
        Ok(sample) if !sample.facts.is_empty() => Some(sample.facts),
        _ => None,
    }
}

/// Remote definitions, in the state directory.
pub const REMOTE_ADAPTERS_FILE: &str = "remote-engine-adapters.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAdaptersFile {
    pub adapters: Vec<RemoteEngineAdapter>,
}

pub fn remote_adapters_path() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(REMOTE_ADAPTERS_FILE))
}

pub fn load_remote_adapters_from(path: &Path) -> Result<Vec<RemoteEngineAdapter>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str::<RemoteAdaptersFile>(&text)
            .with_context(|| format!("parsing `{}`", path.display()))?
            .adapters),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("reading `{}`", path.display())),
    }
}

pub fn load_remote_adapters() -> Result<Vec<RemoteEngineAdapter>> {
    load_remote_adapters_from(&remote_adapters_path()?)
}

pub fn save_remote_adapters_to(path: &Path, adapters: &[RemoteEngineAdapter]) -> Result<()> {
    let dir = path
        .parent()
        .context("remote engine adapters path has no parent directory")?;
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating state directory `{}`", dir.display()))?;
    let text = serde_json::to_string_pretty(&RemoteAdaptersFile {
        adapters: adapters.to_vec(),
    })
    .context("serializing remote engine adapters")?;
    let mut file = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("creating a temporary file in `{}`", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .context("setting private permissions on remote engine adapters")?;
    }
    std::io::Write::write_all(&mut file, text.as_bytes())
        .context("writing remote engine adapters")?;
    file.as_file()
        .sync_all()
        .context("syncing remote engine adapters")?;
    file.persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("replacing `{}`", path.display()))?;
    Ok(())
}

pub fn save_remote_adapters(adapters: &[RemoteEngineAdapter]) -> Result<()> {
    save_remote_adapters_to(&remote_adapters_path()?, adapters)
}

fn json_stringify_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let raw = serde_json::to_string(&serde_json::Value::Number(n.clone())).expect("number");
    if let Some(stripped) = raw.strip_suffix(".0") {
        stripped.to_string()
    } else {
        raw
    }
}

fn canonical_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let inner = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("object key"),
                        canonical_value(&map[key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{inner}}}")
        }
        serde_json::Value::Array(items) => {
            let inner = items
                .iter()
                .map(canonical_value)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{inner}]")
        }
        serde_json::Value::Number(n) => json_stringify_number(n),
        other => serde_json::to_string(other).expect("json atom"),
    }
}

/// Compact JSON with sorted keys; SHA-256 of this is the approval pin.
pub fn canonical_spec_json(endpoint_slug: &str, spec: &EngineAdapterConfig) -> String {
    let mut value = serde_json::json!({
        "endpointSlug": endpoint_slug,
        "format": spec.format,
        "input": spec.input,
        "intervalSecs": spec.interval_secs,
        "map": spec.map,
        "timeoutSecs": spec.timeout_secs,
    });
    if let Some(route) = &spec.count_route
        && let Some(object) = value.as_object_mut()
    {
        object.insert("countRoute".to_string(), serde_json::json!(route));
    }
    canonical_value(&value)
}

pub fn spec_sha256(endpoint_slug: &str, spec: &EngineAdapterConfig) -> String {
    sha256_hex(canonical_spec_json(endpoint_slug, spec).as_bytes())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteAdapterEligibility {
    Run,
    PendingApproval,
    Refused,
}

/// Local adapters shadow remotes. Metric-source opt-in is a different flag.
pub fn remote_adapter_eligibility(
    spec: &EngineAdapterConfig,
    endpoint_slug: &str,
    allow_remote: bool,
    local_has_adapter: bool,
    approved_hash: Option<&str>,
) -> RemoteAdapterEligibility {
    if !allow_remote || local_has_adapter || spec.validate().is_err() {
        return RemoteAdapterEligibility::Refused;
    }
    let hash = spec_sha256(endpoint_slug, spec);
    if approved_hash.is_some_and(|stored| stored.eq_ignore_ascii_case(&hash)) {
        RemoteAdapterEligibility::Run
    } else {
        RemoteAdapterEligibility::PendingApproval
    }
}

pub fn status_for_eligibility(
    endpoint_slug: &str,
    spec: &EngineAdapterConfig,
    eligibility: RemoteAdapterEligibility,
) -> EngineAdapterStatus {
    EngineAdapterStatus {
        endpoint_slug: endpoint_slug.to_string(),
        input: spec.input_kind(),
        state: match eligibility {
            RemoteAdapterEligibility::Run => AdapterState::Active,
            RemoteAdapterEligibility::PendingApproval => AdapterState::PendingApproval,
            RemoteAdapterEligibility::Refused => AdapterState::Refused,
        },
        error: None,
    }
}

pub fn status_for(
    endpoint_slug: &str,
    spec: &EngineAdapterConfig,
    sample: Result<&AdapterSample, AdapterError>,
) -> EngineAdapterStatus {
    match sample {
        Ok(sample) if sample.reading.is_some() => EngineAdapterStatus {
            endpoint_slug: endpoint_slug.to_string(),
            input: spec.input_kind(),
            state: AdapterState::Active,
            error: None,
        },
        Ok(sample) => EngineAdapterStatus {
            endpoint_slug: endpoint_slug.to_string(),
            input: spec.input_kind(),
            state: AdapterState::Failing,
            error: sample.error,
        },
        Err(error) => EngineAdapterStatus {
            endpoint_slug: endpoint_slug.to_string(),
            input: spec.input_kind(),
            state: AdapterState::Failing,
            error: Some(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_spec(map: BTreeMap<AdapterSignal, SignalSelector>) -> EngineAdapterConfig {
        EngineAdapterConfig {
            input: AdapterInput::Route {
                route: "/stats".to_string(),
            },
            format: AdapterFormat::Json,
            interval_secs: 2,
            timeout_secs: 2,
            map,
            count_route: None,
        }
    }

    fn prom_spec(map: BTreeMap<AdapterSignal, SignalSelector>) -> EngineAdapterConfig {
        EngineAdapterConfig {
            input: AdapterInput::Route {
                route: "/metrics".to_string(),
            },
            format: AdapterFormat::Prometheus,
            interval_secs: 2,
            timeout_secs: 2,
            map,
            count_route: None,
        }
    }

    fn selector(series: &str, scale: Option<f64>) -> SignalSelector {
        SignalSelector {
            series: series.to_string(),
            labels: BTreeMap::new(),
            aggregate: None,
            scale,
        }
    }

    #[test]
    fn route_validation_rejects_scheme_host_parent_query_and_fragment() {
        assert_eq!(validate_route("/metrics"), Ok(()));
        assert_eq!(validate_route("/v1/load"), Ok(()));
        assert_eq!(validate_route(""), Err("empty"));
        assert_eq!(validate_route("  "), Err("control"));
        assert_eq!(validate_route("https:evil.example/x"), Err("scheme"));
        assert_eq!(validate_route("http:foo"), Err("scheme"));
        assert_eq!(validate_route("http://127.0.0.1/metrics"), Err("scheme"));
        assert_eq!(validate_route("//evil.example/x"), Err("host"));
        assert_eq!(validate_route("/\t/evil.example/x"), Err("control"));
        assert_eq!(validate_route(" /abs"), Err("control"));
        assert_eq!(validate_route("foo/bar"), Err("path"));
        assert_eq!(validate_route("metrics"), Err("path"));
        assert_eq!(validate_route("/foo/../metrics"), Err("parent"));
        assert_eq!(validate_route("/metrics?full=1"), Err("query"));
        assert_eq!(validate_route("/metrics#a"), Err("fragment"));
    }

    #[test]
    fn json_canonical_keys_need_no_map() {
        let spec = json_spec(BTreeMap::new());
        let sample = parse_adapter_body(&spec, r#"{"running": 3, "kvUsage": 0.4, "waiting": 1}"#)
            .expect("parse");
        let reading = sample.reading.expect("running");
        assert_eq!(reading.running, 3);
        assert_eq!(reading.waiting, Some(1));
        assert_eq!(reading.kv_usage, Some(0.4));
        assert_eq!(reading.source, LoadSource::Custom);
        assert!(sample.error.is_none());
    }

    #[test]
    fn prometheus_needs_a_map_and_applies_scale_and_sum() {
        let mut map = BTreeMap::new();
        map.insert(AdapterSignal::Running, selector("my_running", None));
        map.insert(AdapterSignal::KvUsage, selector("kv_active", Some(0.01)));
        map.insert(
            AdapterSignal::PrefixCacheHitsTotal,
            SignalSelector {
                series: "hits".to_string(),
                labels: BTreeMap::new(),
                aggregate: Some(AggregateKind::Sum),
                scale: None,
            },
        );
        let spec = prom_spec(map);
        let body = "\
my_running{model=\"a\"} 2
my_running{model=\"b\"} 1
kv_active 40
hits{model=\"a\"} 10
hits{model=\"b\"} 5
";
        let sample = parse_adapter_body(&spec, body).expect("parse");
        let reading = sample.reading.expect("running");
        assert_eq!(reading.running, 3);
        assert_eq!(reading.kv_usage, Some(0.4));
        assert_eq!(reading.prefix_cache_hits_total, Some(15.0));
    }

    #[test]
    fn out_of_range_values_are_dropped_not_clamped() {
        let spec = json_spec(BTreeMap::new());
        let sample = parse_adapter_body(
            &spec,
            r#"{"running": 3, "kvUsage": 95, "waiting": -1, "kvOccupancy": 1.5}"#,
        )
        .expect("parse");
        let reading = sample.reading.expect("running");
        assert_eq!(reading.kv_usage, None);
        assert_eq!(reading.waiting, None);
        assert_eq!(reading.kv_occupancy, None);
        assert!(sample.dropped.iter().any(
            |row| row.signal == AdapterSignal::KvUsage && row.reason == DropReason::OutOfRange
        ));
    }

    #[test]
    fn prefix_cache_counters_use_the_byte_counter_bound() {
        let spec = json_spec(BTreeMap::new());
        let kept = parse_adapter_body(
            &spec,
            r#"{"running": 1, "prefixCacheHitsTotal": 1000001, "prefixCacheQueriesTotal": 2000000}"#,
        )
        .expect("parse");
        let reading = kept.reading.expect("running");
        assert_eq!(reading.prefix_cache_hits_total, Some(1_000_001.0));
        assert_eq!(reading.prefix_cache_queries_total, Some(2_000_000.0));
        // Long-uptime totals above the token bound (1e12) must still report.
        let long_uptime = parse_adapter_body(
            &spec,
            r#"{"running": 1, "prefixCacheHitsTotal": 1000000000001}"#,
        )
        .expect("parse");
        assert_eq!(
            long_uptime
                .reading
                .expect("running")
                .prefix_cache_hits_total,
            Some(1_000_000_000_001.0)
        );
        let over = crate::telemetry::BYTE_COUNTER_MAX as f64 + 1.0;
        let dropped = parse_adapter_body(
            &spec,
            &format!(r#"{{"running": 1, "prefixCacheHitsTotal": {over}}}"#),
        )
        .expect("parse");
        assert_eq!(
            dropped.reading.expect("running").prefix_cache_hits_total,
            None
        );
        assert!(dropped.dropped.iter().any(|row| {
            row.signal == AdapterSignal::PrefixCacheHitsTotal
                && row.reason == DropReason::OutOfRange
        }));
    }

    #[test]
    fn a_reading_without_running_is_not_sent() {
        let spec = json_spec(BTreeMap::new());
        let sample = parse_adapter_body(&spec, r#"{"waiting": 2, "kvUsage": 0.2}"#).expect("parse");
        assert!(sample.reading.is_none());
        assert_eq!(sample.error, Some(AdapterError::Unmapped));
        let sample = parse_adapter_body(&spec, r#"{"running": 2e6}"#).expect("parse");
        assert!(sample.reading.is_none());
        assert_eq!(sample.error, Some(AdapterError::OutOfRange));
    }

    #[test]
    fn counts_are_rounded_and_facts_are_extracted() {
        let spec = json_spec(BTreeMap::new());
        let sample = parse_adapter_body(
            &spec,
            r#"{"running": 2.6, "slots": 8, "kvTokens": 262144, "maxModelLen": 8192}"#,
        )
        .expect("parse");
        assert_eq!(sample.reading.expect("running").running, 3);
        assert_eq!(sample.facts.slots, Some(8));
        assert_eq!(sample.facts.kv_tokens, Some(262_144));
        assert_eq!(sample.facts.max_model_len, Some(8_192));
    }

    #[test]
    fn parse_map_flag_reads_labels_and_scale() {
        let (signal, selector) =
            parse_map_flag(r#"kvUsage=kv_active{engine="0"}*0.01"#).expect("map");
        assert_eq!(signal, AdapterSignal::KvUsage);
        assert_eq!(selector.series, "kv_active");
        assert_eq!(selector.labels.get("engine").map(String::as_str), Some("0"));
        assert_eq!(selector.scale, Some(0.01));
    }

    #[test]
    fn effective_adapter_prefers_local_then_approved_remote() {
        let endpoint = EndpointConfig {
            slug: "gpu".to_string(),
            engine: crate::config::EndpointEngine::Generic,
            ..EndpointConfig::default()
        };
        let remote = crate::protocol::RemoteEngineAdapter {
            endpoint_slug: "gpu".to_string(),
            input: AdapterInput::Route {
                route: "/stats".to_string(),
            },
            format: AdapterFormat::Json,
            interval_secs: 2,
            timeout_secs: 2,
            map: BTreeMap::new(),
            count_route: None,
        };
        let spec = remote.to_config();
        let hash = spec_sha256("gpu", &spec);
        let mut approved = BTreeMap::new();
        approved.insert("gpu".to_string(), hash);
        assert!(
            effective_engine_adapter(&endpoint, std::slice::from_ref(&remote), false, &approved)
                .is_none(),
            "without opt-in the remote stays off"
        );
        let effective =
            effective_engine_adapter(&endpoint, std::slice::from_ref(&remote), true, &approved)
                .expect("run");
        assert_eq!(effective, spec);
        let mut local = endpoint.clone();
        local.engine_adapter = Some(EngineAdapterConfig {
            input: AdapterInput::Route {
                route: "/local-stats".to_string(),
            },
            format: AdapterFormat::Json,
            interval_secs: 2,
            timeout_secs: 2,
            map: BTreeMap::new(),
            count_route: None,
        });
        let shadowed = effective_engine_adapter(&local, &[remote], true, &approved).expect("local");
        assert_eq!(
            shadowed.input,
            AdapterInput::Route {
                route: "/local-stats".to_string()
            }
        );
    }

    #[test]
    fn prometheus_without_map_is_a_parse_error() {
        let spec = prom_spec(BTreeMap::new());
        assert_eq!(
            parse_adapter_body(&spec, "foo 1\n").err(),
            Some(AdapterError::Parse)
        );
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_is_reported() {
        let spec = EngineAdapterConfig {
            input: AdapterInput::Command {
                command: "sleep 30".to_string(),
            },
            format: AdapterFormat::Json,
            interval_secs: 2,
            timeout_secs: 1,
            map: BTreeMap::new(),
            count_route: None,
        };
        let endpoint = EndpointConfig {
            slug: "local".to_string(),
            ..EndpointConfig::default()
        };
        let started = std::time::Instant::now();
        assert_eq!(
            sample(&endpoint, &spec, None).err(),
            Some(AdapterError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    fn command_spec() -> EngineAdapterConfig {
        EngineAdapterConfig {
            input: AdapterInput::Command {
                command: "echo 1".to_string(),
            },
            format: AdapterFormat::Json,
            interval_secs: 2,
            timeout_secs: 2,
            map: BTreeMap::new(),
            count_route: None,
        }
    }

    #[test]
    fn canonical_spec_json_matches_the_server_vector() {
        assert_eq!(
            canonical_spec_json("gpu", &command_spec()),
            r#"{"endpointSlug":"gpu","format":"json","input":{"command":"echo 1"},"intervalSecs":2,"map":{},"timeoutSecs":2}"#
        );
        let mut map = BTreeMap::new();
        map.insert(AdapterSignal::Running, selector("my_running", Some(1.0)));
        let mapped = EngineAdapterConfig {
            input: AdapterInput::Route {
                route: "/metrics".to_string(),
            },
            format: AdapterFormat::Prometheus,
            interval_secs: 2,
            timeout_secs: 2,
            map,
            count_route: None,
        };
        assert_eq!(
            canonical_spec_json("gpu", &mapped),
            r#"{"endpointSlug":"gpu","format":"prometheus","input":{"route":"/metrics"},"intervalSecs":2,"map":{"running":{"scale":1,"series":"my_running"}},"timeoutSecs":2}"#
        );
        assert_ne!(
            spec_sha256("gpu", &command_spec()),
            spec_sha256("gpu", &mapped)
        );
    }

    #[test]
    fn remote_eligibility_needs_opt_in_and_a_matching_hash() {
        let spec = command_spec();
        let hash = spec_sha256("gpu", &spec);
        assert_eq!(
            remote_adapter_eligibility(&spec, "gpu", false, false, Some(&hash)),
            RemoteAdapterEligibility::Refused
        );
        assert_eq!(
            remote_adapter_eligibility(&spec, "gpu", true, false, None),
            RemoteAdapterEligibility::PendingApproval
        );
        assert_eq!(
            remote_adapter_eligibility(&spec, "gpu", true, false, Some("deadbeef")),
            RemoteAdapterEligibility::PendingApproval
        );
        assert_eq!(
            remote_adapter_eligibility(&spec, "gpu", true, false, Some(&hash)),
            RemoteAdapterEligibility::Run
        );
        assert_eq!(
            remote_adapter_eligibility(&spec, "gpu", true, true, Some(&hash)),
            RemoteAdapterEligibility::Refused
        );
    }

    #[test]
    fn remote_route_that_leaves_origin_is_refused_even_with_a_matching_hash() {
        let spec = EngineAdapterConfig {
            input: AdapterInput::Route {
                route: "https:evil.example/x".to_string(),
            },
            format: AdapterFormat::Json,
            interval_secs: 2,
            timeout_secs: 2,
            map: BTreeMap::new(),
            count_route: None,
        };
        let hash = spec_sha256("gpu", &spec);
        assert_eq!(
            remote_adapter_eligibility(&spec, "gpu", true, false, Some(&hash)),
            RemoteAdapterEligibility::Refused
        );
        assert!(spec.validate().is_err());
    }
}
