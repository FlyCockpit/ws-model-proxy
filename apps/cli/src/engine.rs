//! Inference engine detection and live load parsing.
//!
//! Detection runs at probe time (connect, reconnect, `wsmp reload`) and reads
//! static facts: slot count, per-slot context, KV capacity. Load sampling runs
//! on the telemetry thread (`crate::telemetry`) and reads running/waiting
//! counts. Every parser here is pure so recorded fixtures can test it.
//!
//! Privacy: llama.cpp `/slots` can include prompt text. [`parse_llama_slots`]
//! deserializes only `id`, `n_ctx` and `is_processing`; serde drops every
//! other field while parsing, so nothing else can reach a relay frame.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::EndpointConfig;

/// Largest body read from `/props`, `/get_server_info`, `/api/version` and
/// `/api/v0/models`.
pub(crate) const JSON_BODY_LIMIT: u64 = 256 * 1024;
/// Largest `/metrics` body read. vLLM histograms are verbose.
pub(crate) const METRICS_BODY_LIMIT: u64 = 2 * 1024 * 1024;
/// `/slots` may carry prompt text in some builds; the body is read (bounded)
/// and parsed without keeping it.
const SLOTS_BODY_LIMIT: u64 = 4 * 1024 * 1024;
/// Most samples read from one Prometheus exposition.
const PROMETHEUS_SAMPLE_LIMIT: usize = 20_000;
/// Detection requests at probe time.
pub const DETECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Load scrapes on the telemetry thread; shorter than the sampling interval.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(2);
const SERVED_ALIAS_LIMIT: usize = 64;

/// Inference engine kinds on the relay wire (`engineFacts.engine.value`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineKind {
    Generic,
    #[serde(rename = "llama.cpp")]
    LlamaCpp,
    Vllm,
    Sglang,
    Ollama,
    LmStudio,
}

impl EngineKind {
    /// Engines whose live load the telemetry thread can scrape.
    pub fn has_load_source(self) -> bool {
        matches!(self, Self::LlamaCpp | Self::Vllm | Self::Sglang)
    }
}

/// Static facts one probe found. Persisted in `lastProbe.engine` so a reload
/// candidate and a reconnect carry them without another network round trip.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DetectedEngine {
    /// `None` when detection found nothing recognizable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<EngineKind>,
    /// Concurrent sequences: llama.cpp `total_slots`, SGLang `max_running_requests`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slots: Option<u32>,
    /// llama.cpp `default_generation_settings.n_ctx`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_per_slot: Option<u64>,
    /// Total KV capacity in tokens: vLLM `num_gpu_blocks × block_size`,
    /// SGLang `max_total_num_tokens`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_tokens: Option<u64>,
    /// Engine-wide context limit (SGLang `context_length`, llama.cpp per-slot).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_model_len: Option<u64>,
    /// Per model id: vLLM `/v1/models` `max_model_len`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub model_max_len: BTreeMap<String, u64>,
    /// Ids one engine process serves (vLLM/SGLang `--served-model-name` lists).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub served_model_aliases: Vec<String>,
    /// Chat Completions tokenize fact recorded at probe time (`method` or
    /// `unsupported`). `None` means this endpoint has not been probed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_context: Option<crate::count_context::CountContextFact>,
}

/// The engine this endpoint runs and whether the person declared it.
pub fn effective_kind(endpoint: &EndpointConfig) -> Option<(EngineKind, bool)> {
    if let Some(kind) = endpoint.engine.declared_kind() {
        return Some((kind, true));
    }
    endpoint
        .last_probe
        .as_ref()
        .and_then(|probe| probe.engine.as_ref())
        .and_then(|engine| engine.kind)
        .map(|kind| (kind, false))
}

/// The engine's server root: the base URL without a trailing `/v1` (and
/// without `/models`). llama.cpp, vLLM, SGLang and Ollama serve their
/// management routes there.
pub fn engine_root_url(base_url: &str) -> Result<Url> {
    let mut url =
        Url::parse(base_url).with_context(|| format!("parsing endpoint URL `{base_url}`"))?;
    let mut path = url.path().trim_end_matches('/').to_string();
    for suffix in ["/models", "/v1"] {
        if let Some(stripped) = path.strip_suffix(suffix) {
            path = stripped.to_string();
        }
    }
    path.push('/');
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub(crate) fn route_url(base_url: &str, route: &str) -> Result<Url> {
    let base = engine_root_url(base_url)?;
    let joined = base
        .join(route)
        .with_context(|| format!("building `{route}` URL for `{base_url}`"))?;
    if joined.origin() != base.origin() {
        anyhow::bail!("route `{route}` leaves the endpoint origin");
    }
    Ok(joined)
}

pub(crate) fn endpoint_header_pairs(endpoint: &EndpointConfig) -> Result<Vec<(String, String)>> {
    let mut pairs = Vec::new();
    for header in &endpoint.headers {
        let value = std::env::var(&header.env).with_context(|| {
            format!(
                "reading endpoint header `{}` from `{}`",
                header.name, header.env
            )
        })?;
        pairs.push((header.name.clone(), value));
    }
    if let Some(auth) = &endpoint.auth {
        let value = std::env::var(&auth.env)
            .with_context(|| format!("reading typed endpoint credential from `{}`", auth.env))?;
        match auth.mode {
            crate::config::EndpointAuthMode::ApiKey => {
                pairs.push(("x-api-key".to_string(), value));
            }
            crate::config::EndpointAuthMode::Bearer => {
                pairs.push(("authorization".to_string(), format!("Bearer {value}")));
            }
        }
    }
    Ok(pairs)
}

pub(crate) fn http_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .build()
        .into()
}

/// GET one engine route with the endpoint's configured credentials and read
/// at most `limit` bytes. A non-2xx status is an error.
pub(crate) fn fetch_route(
    agent: &ureq::Agent,
    endpoint: &EndpointConfig,
    route: &str,
    limit: u64,
) -> Result<String> {
    let url = route_url(&endpoint.base_url, route)?;
    let mut request = agent.get(url.as_str());
    for (name, value) in endpoint_header_pairs(endpoint)? {
        request = request.header(&name, &value);
    }
    let mut response = request
        .call()
        .with_context(|| format!("requesting `{route}` from endpoint `{}`", endpoint.slug))?;
    read_decoded_body(response.body_mut(), limit)
        .with_context(|| format!("reading `{route}` from endpoint `{}`", endpoint.slug))
}

/// Read a response body, holding the DECODED size to `limit`. ureq's own
/// limit sits beneath content decoding and counts compressed bytes, so a
/// small gzip body could otherwise expand far past it. The wire limit stays
/// as well; the decoded reader then stops at `limit + 1` bytes.
pub(crate) fn read_decoded_body(body: &mut ureq::Body, limit: u64) -> Result<String> {
    use std::io::Read;
    let mut decoded = Vec::new();
    // ureq refuses a body that reaches its limit; one byte of slack keeps an
    // exact-limit body legal, and the decoded check below is the real bound.
    body.with_config()
        .limit(limit.saturating_add(1))
        .reader()
        .take(limit.saturating_add(1))
        .read_to_end(&mut decoded)
        .context("reading the response body")?;
    if decoded.len() as u64 > limit {
        anyhow::bail!("the decoded response body exceeds {limit} bytes");
    }
    String::from_utf8(decoded).context("the response body is not UTF-8")
}

/// Detect the engine and its static facts. `models` are the ids and
/// `max_model_len` values from `/v1/models`. A declared engine probes only
/// its own route; `generic` probes nothing.
pub fn detect_engine(
    endpoint: &EndpointConfig,
    models: &[(String, Option<u64>)],
) -> DetectedEngine {
    let agent = http_agent(DETECT_TIMEOUT);
    let fetch = |route: &str, limit: u64| fetch_route(&agent, endpoint, route, limit).ok();
    detect_with(endpoint.engine.declared_kind(), models, fetch)
}

/// Detection over an injected fetcher, so fixtures can drive it.
pub fn detect_with(
    declared: Option<EngineKind>,
    models: &[(String, Option<u64>)],
    fetch: impl Fn(&str, u64) -> Option<String>,
) -> DetectedEngine {
    let mut detected = DetectedEngine {
        model_max_len: models
            .iter()
            .filter_map(|(id, len)| {
                len.filter(|value| *value > 0)
                    .map(|value| (id.clone(), value))
            })
            .collect(),
        ..DetectedEngine::default()
    };
    let llama_router = std::cell::Cell::new(true);
    let try_llama = |detected: &mut DetectedEngine| {
        let props = fetch("props", JSON_BODY_LIMIT).and_then(|body| parse_llama_props(&body));
        props.map(|props| {
            llama_router.set(props.router);
            detected.kind = Some(EngineKind::LlamaCpp);
            detected.slots = props.total_slots;
            detected.ctx_per_slot = props.n_ctx;
            detected.max_model_len = props.n_ctx;
        })
    };
    let try_sglang = |detected: &mut DetectedEngine| {
        let info = fetch("get_server_info", JSON_BODY_LIMIT)
            .and_then(|body| parse_sglang_server_info(&body));
        info.map(|info| {
            detected.kind = Some(EngineKind::Sglang);
            detected.slots = info.max_running_requests;
            detected.kv_tokens = info.max_total_num_tokens;
            detected.max_model_len = info.context_length;
        })
    };
    // `/metrics` names its engine by prefix: `vllm:` or `sglang:` (an SGLang
    // without `/get_server_info` still gets its kind, without facts).
    let try_metrics = |detected: &mut DetectedEngine, accept: &[EngineKind]| {
        let body = fetch("metrics", METRICS_BODY_LIMIT)?;
        let samples = parse_prometheus(&body);
        let has_prefix =
            |prefix: &str| samples.iter().any(|sample| sample.name.starts_with(prefix));
        if accept.contains(&EngineKind::Vllm) && has_prefix("vllm:") {
            detected.kind = Some(EngineKind::Vllm);
            detected.kv_tokens = vllm_kv_tokens(&samples);
            return Some(());
        }
        if accept.contains(&EngineKind::Sglang) && has_prefix("sglang:") {
            detected.kind = Some(EngineKind::Sglang);
            return Some(());
        }
        None
    };
    let try_ollama = |detected: &mut DetectedEngine| {
        fetch("api/version", JSON_BODY_LIMIT)
            .filter(|body| is_ollama_version(body))
            .map(|_| detected.kind = Some(EngineKind::Ollama))
    };
    let try_lm_studio = |detected: &mut DetectedEngine| {
        fetch("api/v0/models", JSON_BODY_LIMIT)
            .filter(|body| is_lm_studio_models(body))
            .map(|_| detected.kind = Some(EngineKind::LmStudio))
    };

    match declared {
        Some(EngineKind::Generic) => {}
        Some(EngineKind::LlamaCpp) => {
            let _ = try_llama(&mut detected);
        }
        Some(EngineKind::Sglang) => {
            let _ = try_sglang(&mut detected);
        }
        Some(EngineKind::Vllm) => {
            let _ = try_metrics(&mut detected, &[EngineKind::Vllm]);
        }
        Some(EngineKind::Ollama | EngineKind::LmStudio) => {}
        None => {
            // Most specific first: `/props` and `/get_server_info` are
            // engine-specific JSON; `/metrics` distinguishes vLLM by prefix.
            let _ = try_llama(&mut detected)
                .or_else(|| try_sglang(&mut detected))
                .or_else(|| try_metrics(&mut detected, &[EngineKind::Vllm, EngineKind::Sglang]))
                .or_else(|| try_ollama(&mut detected))
                .or_else(|| try_lm_studio(&mut detected));
        }
    }
    let kind = declared.or(detected.kind);
    if (matches!(kind, Some(EngineKind::Vllm | EngineKind::Sglang))
        || (kind == Some(EngineKind::LlamaCpp) && !llama_router.get()))
        && models.len() > 1
    {
        let mut seen = std::collections::HashSet::new();
        detected.served_model_aliases = models
            .iter()
            .map(|(id, _)| id.clone())
            .filter(|id| !id.trim().is_empty() && seen.insert(id.clone()))
            .take(SERVED_ALIAS_LIMIT)
            .collect();
        if detected.served_model_aliases.len() < 2 {
            detected.served_model_aliases.clear();
        }
    }
    detected
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LlamaProps {
    pub router: bool,
    pub total_slots: Option<u32>,
    pub n_ctx: Option<u64>,
}

/// llama.cpp `GET /props`. Recognized by `total_slots` or
/// `default_generation_settings`.
pub fn parse_llama_props(body: &str) -> Option<LlamaProps> {
    #[derive(Deserialize)]
    struct Settings {
        #[serde(default)]
        n_ctx: Option<u64>,
    }
    #[derive(Deserialize)]
    struct Props {
        #[serde(default)]
        role: Option<String>,
        #[serde(default)]
        total_slots: Option<u32>,
        #[serde(default)]
        default_generation_settings: Option<Settings>,
    }
    let props: Props = serde_json::from_str(body).ok()?;
    if props.role.as_deref() != Some("router")
        && props.total_slots.is_none()
        && props.default_generation_settings.is_none()
    {
        return None;
    }
    Some(LlamaProps {
        router: props.role.as_deref() == Some("router"),
        total_slots: props
            .total_slots
            .filter(|value| (1..=10_000).contains(value)),
        n_ctx: props
            .default_generation_settings
            .and_then(|settings| settings.n_ctx)
            .filter(|value| *value > 0),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SglangServerInfo {
    pub max_running_requests: Option<u32>,
    pub max_total_num_tokens: Option<u64>,
    pub context_length: Option<u64>,
}

/// SGLang `GET /get_server_info`. Recognized by `max_total_num_tokens` or
/// `max_running_requests`.
pub fn parse_sglang_server_info(body: &str) -> Option<SglangServerInfo> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let object = value.as_object()?;
    let number = |key: &str| object.get(key).and_then(serde_json::Value::as_u64);
    let max_running_requests = number("max_running_requests")
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| (1..=10_000).contains(value));
    let max_total_num_tokens = number("max_total_num_tokens").filter(|value| *value > 0);
    if max_running_requests.is_none() && max_total_num_tokens.is_none() {
        return None;
    }
    Some(SglangServerInfo {
        max_running_requests,
        max_total_num_tokens,
        context_length: number("context_length").filter(|value| *value > 0),
    })
}

/// Ollama `GET /api/version`: `{"version": "..."}`.
pub fn is_ollama_version(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("version").cloned())
        .is_some_and(|version| version.is_string())
}

/// LM Studio `GET /api/v0/models`: `{"data": [{"id", "state", ...}]}`.
pub fn is_lm_studio_models(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("data").cloned())
        .and_then(|data| data.as_array().cloned())
        .is_some_and(|rows| {
            !rows.is_empty()
                && rows
                    .iter()
                    .all(|row| row.get("id").is_some() && row.get("state").is_some())
        })
}

/// One Prometheus text-format sample.
#[derive(Debug, Clone, PartialEq)]
pub struct PromSample {
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub value: f64,
}

/// A small Prometheus text-exposition parser: `name{k="v",...} value [ts]`.
/// Comments and malformed lines are skipped. At most
/// `PROMETHEUS_SAMPLE_LIMIT` samples are kept.
pub fn parse_prometheus(body: &str) -> Vec<PromSample> {
    let mut samples = Vec::new();
    for line in body.lines() {
        if samples.len() >= PROMETHEUS_SAMPLE_LIMIT {
            break;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(sample) = parse_prometheus_line(line) {
            samples.push(sample);
        }
    }
    samples
}

fn parse_prometheus_line(line: &str) -> Option<PromSample> {
    let name_end = line
        .find(|character: char| character == '{' || character.is_whitespace())
        .unwrap_or(line.len());
    let name = &line[..name_end];
    if name.is_empty() {
        return None;
    }
    let mut rest = &line[name_end..];
    let mut labels = BTreeMap::new();
    if let Some(after_brace) = rest.strip_prefix('{') {
        let (parsed, remainder) = parse_prometheus_labels(after_brace)?;
        labels = parsed;
        rest = remainder;
    }
    let value_text = rest.split_whitespace().next()?;
    let value = match value_text {
        "+Inf" => f64::INFINITY,
        "-Inf" => f64::NEG_INFINITY,
        text => text.parse::<f64>().ok()?,
    };
    Some(PromSample {
        name: name.to_string(),
        labels,
        value,
    })
}

/// Parses `k="v",k2="v2"}` and returns the labels and the text after `}`.
fn parse_prometheus_labels(text: &str) -> Option<(BTreeMap<String, String>, &str)> {
    let mut labels = BTreeMap::new();
    let mut chars = text.char_indices().peekable();
    loop {
        while chars
            .peek()
            .is_some_and(|(_, c)| *c == ',' || c.is_whitespace())
        {
            chars.next();
        }
        let (start, first) = *chars.peek()?;
        if first == '}' {
            return Some((labels, &text[start + 1..]));
        }
        let mut key_end = start;
        while let Some((index, c)) = chars.peek().copied() {
            if c == '=' {
                key_end = index;
                break;
            }
            chars.next();
        }
        let key = text[start..key_end].trim().to_string();
        chars.next(); // '='
        if chars.next().map(|(_, c)| c) != Some('"') {
            return None;
        }
        let mut value = String::new();
        loop {
            let (_, c) = chars.next()?;
            match c {
                '\\' => {
                    let (_, escaped) = chars.next()?;
                    value.push(match escaped {
                        'n' => '\n',
                        other => other,
                    });
                }
                '"' => break,
                other => value.push(other),
            }
        }
        labels.insert(key, value);
    }
}

fn first_value(samples: &[PromSample], names: &[&str]) -> Option<f64> {
    names.iter().find_map(|name| {
        samples
            .iter()
            .find(|sample| sample.name == *name && sample.value.is_finite())
            .map(|sample| sample.value)
    })
}

fn process_start_time_seconds(samples: &[PromSample]) -> Option<f64> {
    first_value(samples, &["process_start_time_seconds"]).filter(|value| *value > 0.0)
}

fn sum_values(samples: &[PromSample], names: &[&str]) -> Option<f64> {
    names.iter().find_map(|name| {
        let values = samples
            .iter()
            .filter(|sample| sample.name == *name && sample.value.is_finite())
            .map(|sample| sample.value)
            .collect::<Vec<_>>();
        (!values.is_empty()).then(|| values.iter().sum())
    })
}

/// vLLM `vllm:cache_config_info{num_gpu_blocks="N",block_size="B"} 1`.
pub fn vllm_kv_tokens(samples: &[PromSample]) -> Option<u64> {
    let info = samples
        .iter()
        .find(|sample| sample.name == "vllm:cache_config_info")?;
    let blocks = info.labels.get("num_gpu_blocks")?.parse::<u64>().ok()?;
    let block_size = info.labels.get("block_size")?.parse::<u64>().ok()?;
    blocks.checked_mul(block_size).filter(|value| *value > 0)
}

/// One live load reading, before the relay frame adds slugs and time.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadReading {
    pub running: u64,
    pub waiting: Option<u64>,
    pub kv_usage: Option<f64>,
    /// Active plus idle cached prefixes. Display only; never a FULL signal.
    pub kv_occupancy: Option<f64>,
    pub slots_busy: Option<u64>,
    pub deferred: Option<u64>,
    /// Cumulative prefix-cache counters; the sampler turns them into deltas.
    pub prefix_cache_hits_total: Option<f64>,
    pub prefix_cache_queries_total: Option<f64>,
    /// Prometheus `process_start_time_seconds` when the exposition has it.
    pub process_start_time_seconds: Option<f64>,
    pub source: LoadSource,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoadSource {
    #[default]
    #[serde(rename = "llama.cpp-slots")]
    LlamaCppSlots,
    #[serde(rename = "llama.cpp-metrics")]
    LlamaCppMetrics,
    VllmMetrics,
    SglangMetrics,
    Custom,
}

fn count(value: Option<f64>) -> Option<u64> {
    value
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.round() as u64)
}

fn fraction(value: Option<f64>) -> Option<f64> {
    value
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
}

/// vLLM `/metrics`. Sums across `model_name` labels.
pub fn vllm_load(samples: &[PromSample]) -> Option<LoadReading> {
    let running = count(sum_values(samples, &["vllm:num_requests_running"]))?;
    let waiting = count(sum_values(samples, &["vllm:num_requests_waiting"])).unwrap_or(0);
    Some(LoadReading {
        running,
        waiting: Some(waiting),
        kv_usage: fraction(first_value(
            samples,
            &["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"],
        )),
        prefix_cache_hits_total: sum_values(
            samples,
            &["vllm:prefix_cache_hits_total", "vllm:prefix_cache_hits"],
        ),
        prefix_cache_queries_total: sum_values(
            samples,
            &[
                "vllm:prefix_cache_queries_total",
                "vllm:prefix_cache_queries",
            ],
        ),
        process_start_time_seconds: process_start_time_seconds(samples),
        source: LoadSource::VllmMetrics,
        ..LoadReading::default()
    })
}

/// SGLang `/metrics`.
pub fn sglang_load(samples: &[PromSample]) -> Option<LoadReading> {
    let running = count(sum_values(samples, &["sglang:num_running_reqs"]))?;
    Some(LoadReading {
        running,
        waiting: Some(count(sum_values(samples, &["sglang:num_queue_reqs"])).unwrap_or(0)),
        kv_usage: fraction(first_value(samples, &["sglang:token_usage"])),
        process_start_time_seconds: process_start_time_seconds(samples),
        source: LoadSource::SglangMetrics,
        ..LoadReading::default()
    })
}

/// llama.cpp `/metrics` (server started with `--metrics`).
pub fn llama_metrics_load(samples: &[PromSample]) -> Option<LoadReading> {
    let running = count(first_value(samples, &["llamacpp:requests_processing"]))?;
    let deferred = count(first_value(samples, &["llamacpp:requests_deferred"]));
    Some(LoadReading {
        running,
        waiting: Some(deferred.unwrap_or(0)),
        deferred,
        kv_occupancy: fraction(first_value(samples, &["llamacpp:kv_cache_usage_ratio"])),
        process_start_time_seconds: process_start_time_seconds(samples),
        source: LoadSource::LlamaCppMetrics,
        ..LoadReading::default()
    })
}

/// The only `/slots` fields the CLI reads. Everything else in a slot
/// (prompt, generated text, tokens, sampling params) is discarded by serde.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LlamaSlot {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub n_ctx: Option<u64>,
    #[serde(default)]
    pub is_processing: Option<bool>,
}

/// llama.cpp `GET /slots`: an array of slot objects.
pub fn parse_llama_slots(body: &str) -> Option<Vec<LlamaSlot>> {
    serde_json::from_str::<Vec<LlamaSlot>>(body).ok()
}

/// Busy-slot load from `/slots`. `/slots` cannot see the queue, so `waiting`
/// is 0 here; `/metrics` (`--metrics`) adds `deferred`.
pub fn llama_slots_load(slots: &[LlamaSlot]) -> LoadReading {
    let busy = slots
        .iter()
        .filter(|slot| slot.is_processing == Some(true))
        .count() as u64;
    LoadReading {
        running: busy,
        waiting: Some(0),
        slots_busy: Some(busy),
        source: LoadSource::LlamaCppSlots,
        ..LoadReading::default()
    }
}

/// Scrape one endpoint's live load. `None` for an engine without a load
/// source or when every scrape fails.
pub fn sample_load(
    agent: &ureq::Agent,
    endpoint: &EndpointConfig,
    kind: EngineKind,
) -> Option<LoadReading> {
    let metrics = |limit| {
        fetch_route(agent, endpoint, "metrics", limit)
            .ok()
            .map(|body| parse_prometheus(&body))
    };
    match kind {
        EngineKind::Vllm => metrics(METRICS_BODY_LIMIT).and_then(|samples| vllm_load(&samples)),
        EngineKind::Sglang => metrics(METRICS_BODY_LIMIT).and_then(|samples| sglang_load(&samples)),
        EngineKind::LlamaCpp => {
            let from_slots = fetch_route(agent, endpoint, "slots", SLOTS_BODY_LIMIT)
                .ok()
                .and_then(|body| parse_llama_slots(&body))
                .map(|slots| llama_slots_load(&slots));
            let from_metrics =
                metrics(METRICS_BODY_LIMIT).and_then(|samples| llama_metrics_load(&samples));
            merge_llama_load(from_slots, from_metrics)
        }
        EngineKind::Generic | EngineKind::Ollama | EngineKind::LmStudio => None,
    }
}

/// `/metrics` supplies running/deferred; `/slots` adds the busy-slot count.
pub fn merge_llama_load(
    from_slots: Option<LoadReading>,
    from_metrics: Option<LoadReading>,
) -> Option<LoadReading> {
    match (from_slots, from_metrics) {
        (Some(slots), Some(mut metrics)) => {
            metrics.slots_busy = slots.slots_busy;
            Some(metrics)
        }
        (slots, metrics) => metrics.or(slots),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LLAMA_PROPS: &str = include_str!("../tests/fixtures/engines/llama-props.json");
    const LLAMA_SLOTS: &str = include_str!("../tests/fixtures/engines/llama-slots.json");
    const LLAMA_METRICS: &str = include_str!("../tests/fixtures/engines/llama-metrics.txt");
    const VLLM_METRICS: &str = include_str!("../tests/fixtures/engines/vllm-metrics.txt");
    const SGLANG_METRICS: &str = include_str!("../tests/fixtures/engines/sglang-metrics.txt");
    const SGLANG_INFO: &str = include_str!("../tests/fixtures/engines/sglang-server-info.json");
    const OLLAMA_VERSION: &str = include_str!("../tests/fixtures/engines/ollama-version.json");
    const LM_STUDIO_MODELS: &str = include_str!("../tests/fixtures/engines/lm-studio-models.json");

    fn fixture_fetch(
        routes: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str, u64) -> Option<String> {
        move |route, _| {
            routes
                .iter()
                .find(|(name, _)| *name == route)
                .map(|(_, body)| (*body).to_string())
        }
    }

    #[test]
    fn engine_root_strips_v1_and_models() {
        for (base, root) in [
            ("http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/"),
            ("http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/"),
            ("http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8080/"),
            ("http://127.0.0.1:8080", "http://127.0.0.1:8080/"),
            ("http://host/proxy/llama/v1", "http://host/proxy/llama/"),
        ] {
            assert_eq!(engine_root_url(base).expect("root").as_str(), root);
        }
        assert_eq!(
            route_url("http://127.0.0.1:11434/v1", "api/version")
                .expect("route")
                .as_str(),
            "http://127.0.0.1:11434/api/version"
        );
        assert_eq!(
            route_url("http://127.0.0.1:8080/v1", "/metrics")
                .expect("route")
                .as_str(),
            "http://127.0.0.1:8080/metrics"
        );
        assert!(
            route_url("http://127.0.0.1:8080/v1", "https:evil.example/x")
                .unwrap_err()
                .to_string()
                .contains("leaves the endpoint origin")
        );
        assert!(
            route_url("http://127.0.0.1:8080/v1", "//evil.example/x")
                .unwrap_err()
                .to_string()
                .contains("leaves the endpoint origin")
        );
    }

    #[test]
    fn detects_llama_cpp_from_props() {
        let detected = detect_with(
            None,
            &[("qwen".to_string(), None)],
            fixture_fetch(&[("props", LLAMA_PROPS), ("metrics", VLLM_METRICS)]),
        );
        assert_eq!(detected.kind, Some(EngineKind::LlamaCpp));
        assert_eq!(detected.slots, Some(4));
        assert_eq!(detected.ctx_per_slot, Some(32768));
        assert_eq!(detected.max_model_len, Some(32768));
        assert_eq!(detected.kv_tokens, None);
        assert!(detected.served_model_aliases.is_empty());
    }

    #[test]
    fn alias_proof_table() {
        let two = vec![("a".to_string(), None), ("b".to_string(), None)];
        for (kind, props, models, expected) in [
            (
                EngineKind::LlamaCpp,
                LLAMA_PROPS,
                two.clone(),
                vec!["a", "b"],
            ),
            (
                EngineKind::LlamaCpp,
                r#"{"role":"router","total_slots":4}"#,
                two.clone(),
                vec![],
            ),
            (
                EngineKind::LlamaCpp,
                r#"{"role":"router"}"#,
                two.clone(),
                vec![],
            ),
            (EngineKind::LlamaCpp, "malformed", two.clone(), vec![]),
            (
                EngineKind::LlamaCpp,
                LLAMA_PROPS,
                vec![("a".to_string(), None)],
                vec![],
            ),
            (
                EngineKind::LlamaCpp,
                LLAMA_PROPS,
                vec![("a".to_string(), None), ("a".to_string(), None)],
                vec![],
            ),
            (
                EngineKind::LlamaCpp,
                LLAMA_PROPS,
                vec![
                    ("a".to_string(), None),
                    ("a".to_string(), None),
                    ("b".to_string(), None),
                ],
                vec!["a", "b"],
            ),
            (EngineKind::Ollama, LLAMA_PROPS, two.clone(), vec![]),
            (EngineKind::LmStudio, LLAMA_PROPS, two.clone(), vec![]),
            (EngineKind::Generic, LLAMA_PROPS, two, vec![]),
        ] {
            let detected = detect_with(Some(kind), &models, |_, _| Some(props.to_string()));
            assert_eq!(detected.served_model_aliases, expected, "{kind:?} {props}");
        }
        let models = (0..70)
            .flat_map(|i| [(format!("m{i}"), None), (format!("m{i}"), None)])
            .collect::<Vec<_>>();
        let detected = detect_with(None, &models, fixture_fetch(&[("props", LLAMA_PROPS)]));
        assert_eq!(
            detected.served_model_aliases,
            (0..64).map(|i| format!("m{i}")).collect::<Vec<_>>()
        );
    }

    #[test]
    fn detects_vllm_from_metrics_prefix_and_cache_config() {
        let detected = detect_with(
            None,
            &[
                ("meta/llama".to_string(), Some(131_072)),
                ("llama-alias".to_string(), Some(131_072)),
            ],
            fixture_fetch(&[("metrics", VLLM_METRICS)]),
        );
        assert_eq!(detected.kind, Some(EngineKind::Vllm));
        assert_eq!(detected.kv_tokens, Some(2_048 * 16));
        assert_eq!(detected.slots, None, "vLLM reports no hard cap");
        assert_eq!(detected.model_max_len.get("meta/llama"), Some(&131_072));
        assert_eq!(detected.served_model_aliases, ["meta/llama", "llama-alias"]);
    }

    #[test]
    fn detects_sglang_from_server_info() {
        let detected = detect_with(
            None,
            &[("qwen".to_string(), None)],
            fixture_fetch(&[
                ("get_server_info", SGLANG_INFO),
                ("metrics", SGLANG_METRICS),
            ]),
        );
        assert_eq!(detected.kind, Some(EngineKind::Sglang));
        assert_eq!(detected.slots, Some(48));
        assert_eq!(detected.kv_tokens, Some(412_000));
        assert_eq!(detected.max_model_len, Some(40_960));
    }

    #[test]
    fn sglang_metrics_are_not_mistaken_for_vllm() {
        let detected = detect_with(None, &[], fixture_fetch(&[("metrics", SGLANG_METRICS)]));
        assert_eq!(detected.kind, Some(EngineKind::Sglang));
        assert_eq!(detected.kv_tokens, None);
        let declared_vllm = detect_with(
            Some(EngineKind::Vllm),
            &[],
            fixture_fetch(&[("metrics", SGLANG_METRICS)]),
        );
        assert_eq!(declared_vllm.kind, None);
    }

    #[test]
    fn detects_ollama_and_lm_studio() {
        let ollama = detect_with(None, &[], fixture_fetch(&[("api/version", OLLAMA_VERSION)]));
        assert_eq!(ollama.kind, Some(EngineKind::Ollama));
        assert_eq!(
            ollama.slots, None,
            "Ollama does not expose its parallel count"
        );
        let lm_studio = detect_with(
            None,
            &[],
            fixture_fetch(&[("api/v0/models", LM_STUDIO_MODELS)]),
        );
        assert_eq!(lm_studio.kind, Some(EngineKind::LmStudio));
    }

    #[test]
    fn declared_engine_overrides_detection_and_generic_probes_nothing() {
        let asked = std::cell::RefCell::new(Vec::<String>::new());
        let fetch = |route: &str, _: u64| {
            asked.borrow_mut().push(route.to_string());
            (route == "props").then(|| LLAMA_PROPS.to_string())
        };
        let generic = detect_with(Some(EngineKind::Generic), &[], fetch);
        assert_eq!(generic.kind, None);
        assert!(asked.borrow().is_empty(), "generic must not probe");

        let vllm = detect_with(Some(EngineKind::Vllm), &[], fetch);
        assert_eq!(vllm.kind, None, "a declared vLLM reads only `/metrics`");
        assert_eq!(*asked.borrow(), ["metrics"]);
    }

    #[test]
    fn nothing_recognized_yields_no_kind() {
        let detected = detect_with(None, &[], |_, _| Some("not json".to_string()));
        assert_eq!(detected, DetectedEngine::default());
    }

    #[test]
    fn prometheus_parser_reads_labels_escapes_and_skips_junk() {
        let samples = parse_prometheus(
            "# HELP x y\nfoo{a=\"1\",b=\"q\\\"x\"} 3.5 1700000000\nbar 2\n{bad} 1\nbaz{a=\"1\" 2\nqux +Inf\n",
        );
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0].name, "foo");
        assert_eq!(samples[0].labels.get("b").map(String::as_str), Some("q\"x"));
        assert_eq!(samples[0].value, 3.5);
        assert_eq!(samples[1].name, "bar");
        assert!(samples[2].value.is_infinite());
    }

    #[test]
    fn vllm_load_reads_running_waiting_and_kv_usage() {
        let load = vllm_load(&parse_prometheus(VLLM_METRICS)).expect("load");
        assert_eq!(load.running, 3);
        assert_eq!(load.waiting, Some(2));
        assert_eq!(load.kv_usage, Some(0.42));
        assert_eq!(load.prefix_cache_hits_total, Some(1200.0));
        assert_eq!(load.prefix_cache_queries_total, Some(4000.0));
        assert_eq!(load.process_start_time_seconds, None);
        assert_eq!(load.source, LoadSource::VllmMetrics);
    }

    #[test]
    fn process_start_time_seconds_is_read_from_prometheus() {
        let samples = parse_prometheus(concat!(
            "process_start_time_seconds 1700000000.5\n",
            "vllm:num_requests_running 1\n",
            "vllm:num_requests_waiting 0\n",
        ));
        let load = vllm_load(&samples).expect("load");
        assert_eq!(load.process_start_time_seconds, Some(1_700_000_000.5));
        let missing = parse_prometheus(concat!(
            "process_start_time_seconds 0\n",
            "vllm:num_requests_running 1\n",
        ));
        assert_eq!(
            vllm_load(&missing)
                .expect("load")
                .process_start_time_seconds,
            None
        );
    }

    #[test]
    fn sglang_load_reads_running_queue_and_token_usage() {
        let load = sglang_load(&parse_prometheus(SGLANG_METRICS)).expect("load");
        assert_eq!(load.running, 7);
        assert_eq!(load.waiting, Some(1));
        assert_eq!(load.kv_usage, Some(0.5));
    }

    #[test]
    fn llama_load_merges_metrics_and_slots() {
        let slots = parse_llama_slots(LLAMA_SLOTS).expect("slots");
        let merged = merge_llama_load(
            Some(llama_slots_load(&slots)),
            llama_metrics_load(&parse_prometheus(LLAMA_METRICS)),
        )
        .expect("load");
        assert_eq!(merged.running, 1);
        assert_eq!(merged.deferred, Some(2));
        assert_eq!(merged.waiting, Some(2));
        assert_eq!(merged.slots_busy, Some(1));
        assert_eq!(merged.kv_occupancy, Some(0.35));
        assert_eq!(merged.kv_usage, None);
        assert_eq!(merged.source, LoadSource::LlamaCppMetrics);
        let slots_only = merge_llama_load(Some(llama_slots_load(&slots)), None).expect("load");
        assert_eq!(slots_only.running, 1);
        assert_eq!(slots_only.waiting, Some(0));
    }

    #[test]
    fn llama_slots_parsing_never_keeps_prompt_text() {
        assert!(
            LLAMA_SLOTS.contains("TOP-SECRET-PROMPT"),
            "fixture carries prompt text"
        );
        let slots = parse_llama_slots(LLAMA_SLOTS).expect("slots");
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].n_ctx, Some(32768));
        let debug = format!("{slots:?} {:?}", llama_slots_load(&slots));
        assert!(!debug.contains("TOP-SECRET"), "{debug}");
        assert!(!debug.contains("prompt"), "{debug}");
    }

    /// Serve one HTTP response on loopback; `None` when loopback bind is denied.
    fn serve_once(
        body: Vec<u8>,
        encoding: Option<&'static str>,
    ) -> Option<(String, std::thread::JoinHandle<()>)> {
        use std::io::{Read, Write};
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return None,
            Err(error) => panic!("bind test engine: {error}"),
        };
        let address = listener.local_addr().expect("test engine address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept engine request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            let encoding = encoding
                .map(|value| format!("content-encoding: {value}\r\n"))
                .unwrap_or_default();
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n{encoding}content-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        });
        Some((format!("http://{address}/v1"), server))
    }

    fn fetch_once(
        body: Vec<u8>,
        encoding: Option<&'static str>,
        limit: u64,
    ) -> Option<Result<String>> {
        let (base_url, server) = serve_once(body, encoding)?;
        let endpoint = EndpointConfig {
            slug: "engine".to_string(),
            base_url,
            ..EndpointConfig::default()
        };
        let result = fetch_route(&http_agent(DETECT_TIMEOUT), &endpoint, "props", limit);
        server.join().expect("test engine thread");
        Some(result)
    }

    #[test]
    fn engine_body_limits_count_decoded_bytes_not_compressed_bytes() {
        let oversized = include_bytes!("../tests/fixtures/engines/oversized-props.json.gz");
        assert!(
            (oversized.len() as u64) < JSON_BODY_LIMIT,
            "the wire body fits the limit"
        );
        let Some(result) = fetch_once(oversized.to_vec(), Some("gzip"), JSON_BODY_LIMIT) else {
            return;
        };
        let error = result.expect_err("a gzip body that decodes past the limit is refused");
        assert!(format!("{error:#}").contains("exceeds"), "{error:#}");

        // Legitimate compressed responses still work.
        let small = include_bytes!("../tests/fixtures/engines/small-props.json.gz");
        let Some(result) = fetch_once(small.to_vec(), Some("gzip"), JSON_BODY_LIMIT) else {
            return;
        };
        assert!(
            result
                .expect("small gzip body")
                .contains("\"total_slots\":4")
        );
    }

    #[test]
    fn engine_body_limit_accepts_exactly_the_limit_and_refuses_one_more_byte() {
        let Some(result) = fetch_once(vec![b'x'; 1024], None, 1024) else {
            return;
        };
        assert_eq!(result.expect("exact-limit body").len(), 1024);
        let Some(result) = fetch_once(vec![b'x'; 1025], None, 1024) else {
            return;
        };
        assert!(result.is_err(), "limit + 1 is refused");
    }
}
