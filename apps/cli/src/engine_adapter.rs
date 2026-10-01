//! Custom engine adapter: a per-endpoint route or command that produces
//! normalized engine signals (relay 2.9).
//!
//! Values outside their range are dropped, not clamped. A reading without
//! `running` is not sent. Adapter status never includes command text, raw
//! output, stderr, route bodies, or label values.

use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::bounded_run::RunError;
use crate::config::EndpointConfig;
use crate::engine::{LoadReading, LoadSource, PromSample, parse_prometheus};
use crate::metric_sources::OUTPUT_LIMIT;
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
#[serde(rename_all = "lowercase")]
pub enum AdapterState {
    Active,
    Failing,
    Disabled,
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

/// Relative path on the endpoint root: no scheme, host, `..`, query, or fragment.
pub fn validate_route(route: &str) -> Result<(), &'static str> {
    let route = route.trim();
    if route.is_empty() {
        return Err("empty");
    }
    if route.as_bytes().contains(&0) {
        return Err("nul");
    }
    if route.contains('\\') {
        return Err("backslash");
    }
    if route.contains("://") {
        return Err("scheme");
    }
    if route.starts_with("//") {
        return Err("host");
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
        | AdapterSignal::Deferred
        | AdapterSignal::PrefixCacheHitsTotal
        | AdapterSignal::PrefixCacheQueriesTotal => drop_count(value, LOAD_COUNT_MAX),
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

/// Probe-time adapter facts. `None` keeps the previous cache (a short outage
/// must not drop K to null).
pub fn probe_facts(endpoint: &EndpointConfig) -> Option<AdapterCachedFacts> {
    let spec = endpoint.engine_adapter.as_ref()?;
    match sample(endpoint, spec, None) {
        Ok(sample) if !sample.facts.is_empty() => Some(sample.facts),
        _ => None,
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
                route: "stats".to_string(),
            },
            format: AdapterFormat::Json,
            interval_secs: 2,
            timeout_secs: 2,
            map,
        }
    }

    fn prom_spec(map: BTreeMap<AdapterSignal, SignalSelector>) -> EngineAdapterConfig {
        EngineAdapterConfig {
            input: AdapterInput::Route {
                route: "metrics".to_string(),
            },
            format: AdapterFormat::Prometheus,
            interval_secs: 2,
            timeout_secs: 2,
            map,
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
        assert_eq!(validate_route("metrics"), Ok(()));
        assert_eq!(validate_route("/metrics"), Ok(()));
        assert_eq!(validate_route("v1/stats.json"), Ok(()));
        assert_eq!(validate_route(""), Err("empty"));
        assert_eq!(validate_route("  "), Err("empty"));
        assert_eq!(validate_route("http://127.0.0.1/metrics"), Err("scheme"));
        assert_eq!(validate_route("//host/metrics"), Err("host"));
        assert_eq!(validate_route("../metrics"), Err("parent"));
        assert_eq!(validate_route("foo/../metrics"), Err("parent"));
        assert_eq!(validate_route("metrics?full=1"), Err("query"));
        assert_eq!(validate_route("metrics#a"), Err("fragment"));
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
}
