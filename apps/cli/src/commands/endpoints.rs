//! `wsmp endpoints` commands.

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{
    Config, EndpointConfig, EndpointEngine, HeaderEnvRef, OpenAiCompatibleCapabilities,
    validate_env_name,
};
use crate::engine_adapter::{
    AdapterFormat, AdapterInput, AdapterSample, DropReason, EngineAdapterConfig, parse_map_flag,
};
use crate::exit::{CodedError, ExitCode};
use crate::output;
use crate::probe::{ProbeReport, apply_probe_report, probe_endpoint};
use crate::slug::validate_slug;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Sub,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Add an OpenAI-compatible local endpoint.
    Add(AddArgs),
    /// Remove an endpoint by slug.
    Remove { slug: String },
    /// List configured endpoints.
    List,
    /// Probe one endpoint or all enabled endpoints.
    Probe(ProbeArgs),
    /// Set or clear the concurrency sent for every model on an endpoint.
    Concurrency(ConcurrencyArgs),
    /// Set or clear the declared KV capacity in tokens for an endpoint.
    #[command(name = "kv-tokens")]
    KvTokens(KvTokensArgs),
    /// Declare the upstream engine. llama.cpp and vLLM advertise `top_k`.
    Engine(EngineArgs),
    /// Configure a custom engine adapter for an endpoint.
    Adapter(AdapterArgs),
}

#[derive(Debug, clap::Args)]
struct AddArgs {
    #[arg(long)]
    slug: String,
    #[arg(long)]
    label: String,
    #[arg(long)]
    base_url: String,
    /// Header reference in `Header-Name=ENV_VAR` form. Repeatable.
    #[arg(long = "header-env")]
    header_env: Vec<String>,
    /// Add the endpoint disabled.
    #[arg(long)]
    disabled: bool,
    /// Inline trusted WMP media URLs as base64 `data:` URLs before forwarding to
    /// this endpoint. Use for local upstreams that cannot fetch remote URLs.
    #[arg(long)]
    expand_media: bool,
    /// Hard concurrency registered for every model on this endpoint (1–10000).
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=10_000))]
    concurrency_limit: Option<u32>,
    /// Upstream engine (default `auto`: detected at probe time). An explicit
    /// `llama.cpp` or `vllm` also advertises `top_k`.
    #[arg(long, value_enum)]
    engine: Option<EngineChoice>,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum EngineChoice {
    /// Detect the engine at probe time.
    Auto,
    /// No engine detection or load sampling (remote providers).
    Generic,
    #[value(name = "llama.cpp")]
    LlamaCpp,
    Vllm,
    Sglang,
    Ollama,
    #[value(name = "lm-studio")]
    LmStudio,
}

impl From<EngineChoice> for EndpointEngine {
    fn from(choice: EngineChoice) -> Self {
        match choice {
            EngineChoice::Auto => Self::Auto,
            EngineChoice::Generic => Self::Generic,
            EngineChoice::LlamaCpp => Self::LlamaCpp,
            EngineChoice::Vllm => Self::Vllm,
            EngineChoice::Sglang => Self::Sglang,
            EngineChoice::Ollama => Self::Ollama,
            EngineChoice::LmStudio => Self::LmStudio,
        }
    }
}

#[derive(Debug, clap::Args)]
struct ConcurrencyArgs {
    slug: String,
    /// Integer from 1 to 10000.
    #[arg(
        value_parser = clap::value_parser!(u32).range(1..=10_000),
        required_unless_present = "clear"
    )]
    limit: Option<u32>,
    /// Omit concurrency so the server uses its fallback of 1 for a new capacity.
    #[arg(long, conflicts_with = "limit")]
    clear: bool,
}

#[derive(Debug, clap::Args)]
struct KvTokensArgs {
    slug: String,
    /// Total KV capacity in tokens (1 to 1e12).
    #[arg(
        value_parser = clap::value_parser!(u64).range(1..=1_000_000_000_000),
        required_unless_present = "clear"
    )]
    tokens: Option<u64>,
    /// Omit the declared KV size so the server uses the probed value.
    #[arg(long, conflicts_with = "tokens")]
    clear: bool,
}

#[derive(Debug, clap::Args)]
struct EngineArgs {
    slug: String,
    #[arg(value_enum)]
    engine: EngineChoice,
}

#[derive(Debug, clap::Args)]
struct AdapterArgs {
    #[command(subcommand)]
    command: AdapterSub,
}

#[derive(Debug, clap::Subcommand)]
enum AdapterSub {
    /// Set a custom engine adapter on an endpoint.
    Set(AdapterSetArgs),
    /// Show the adapter configured on an endpoint.
    Show { slug: String },
    /// Remove the adapter from an endpoint.
    Clear { slug: String },
    /// Run the adapter once and print normalized signals. Never prints raw output.
    Test { slug: String },
}

#[derive(Debug, clap::Args)]
struct AdapterSetArgs {
    slug: String,
    /// Relative path on the endpoint root (no scheme, host, `..`, or query).
    #[arg(long, conflicts_with = "command")]
    route: Option<String>,
    /// Local command, run with the same bounds as metric sources.
    #[arg(long)]
    command: Option<String>,
    /// `json` (canonical keys need no map) or `prometheus` (map required).
    #[arg(long, value_enum)]
    format: AdapterFormatChoice,
    /// `signal=series[{k="v"}][*scale]`. Repeatable.
    #[arg(long = "map")]
    map: Vec<String>,
    /// Sample interval in seconds (2–5). Default 2.
    #[arg(long, value_parser = clap::value_parser!(u32).range(2..=5))]
    interval: Option<u32>,
    /// Per-sample timeout in seconds (1–4). Default 2.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=4))]
    timeout: Option<u32>,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum AdapterFormatChoice {
    Json,
    Prometheus,
}

#[derive(Debug, clap::Args)]
struct ProbeArgs {
    slug: Option<String>,
    /// Apply non-secret probe suggestions to local config.
    #[arg(long)]
    apply: bool,
    /// When applying, drop unpinned models that were absent from this probe.
    #[arg(long, requires = "apply")]
    replace: bool,
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::Add(add) => add_endpoint(args.json, add),
        Sub::Remove { slug } => remove_endpoint(args.json, slug),
        Sub::List => list_endpoints(args.json),
        Sub::Probe(probe) => probe_endpoints(args.json, probe),
        Sub::Concurrency(concurrency) => set_concurrency(args.json, concurrency),
        Sub::KvTokens(kv_tokens) => set_kv_tokens(args.json, kv_tokens),
        Sub::Engine(engine) => set_engine(args.json, engine),
        Sub::Adapter(adapter) => adapter_command(args.json, adapter),
    }
}

fn add_endpoint(json: bool, args: &AddArgs) -> Result<()> {
    validate_slug(&args.slug)?;
    url::Url::parse(&args.base_url)
        .with_context(|| format!("parsing endpoint URL `{}`", args.base_url))?;
    let headers = args
        .header_env
        .iter()
        .map(|raw| parse_header_env(raw))
        .collect::<Result<Vec<_>>>()?;
    let endpoint = EndpointConfig {
        slug: args.slug.clone(),
        label: args.label.clone(),
        base_url: args.base_url.clone(),
        enabled: !args.disabled,
        expand_media: args.expand_media,
        concurrency_limit: args.concurrency_limit,
        engine: args.engine.map(EndpointEngine::from).unwrap_or_default(),
        headers,
        default_capabilities: OpenAiCompatibleCapabilities::default(),
        ..EndpointConfig::default()
    };
    Config::update(false, |cfg| {
        if cfg.endpoint(&args.slug).is_some() {
            anyhow::bail!("endpoint `{}` already exists", args.slug);
        }
        cfg.endpoints.push(endpoint.clone());
        Ok(())
    })?;
    if json {
        output::json(&endpoint)?;
    } else {
        output::line(format!("added endpoint `{}`", endpoint.slug))?;
    }
    Ok(())
}

fn remove_endpoint(json: bool, slug: &str) -> Result<()> {
    let removed = Config::update(true, |cfg| {
        let before = cfg.endpoints.len();
        cfg.endpoints.retain(|endpoint| endpoint.slug != slug);
        let removed = before != cfg.endpoints.len();
        if !removed {
            // The caller named a specific endpoint that does not exist —
            // exit code 3 per the stable exit-code contract (README.md).
            return Err(anyhow::Error::msg(format!("endpoint `{slug}` not found"))
                .context(CodedError::new(ExitCode::NotFound)));
        }
        Ok(removed)
    })?;
    if json {
        output::json(&RemoveResult { slug, removed })?;
    } else {
        output::line(format!("removed endpoint `{slug}`"))?;
    }
    Ok(())
}

fn list_endpoints(json: bool) -> Result<()> {
    let cfg = Config::load_required()?;
    if json {
        output::json(&EndpointList {
            endpoints: cfg.endpoints,
        })?;
    } else {
        for endpoint in cfg.endpoints {
            output::line(format!(
                "{}\t{}\t{}\t{}",
                endpoint.slug,
                if endpoint.enabled {
                    "enabled"
                } else {
                    "disabled"
                },
                endpoint.label,
                endpoint.base_url
            ))?;
        }
    }
    Ok(())
}

fn probe_endpoints(json: bool, args: &ProbeArgs) -> Result<()> {
    // Probe outside the lock so an unavailable upstream cannot starve ordinary
    // config changes. Applying the reports reacquires and rereads under lock.
    let cfg = Config::load_required()?;
    let endpoints = cfg
        .endpoints
        .iter()
        .filter(|endpoint| args.slug.as_ref().is_none_or(|slug| endpoint.slug == *slug))
        .cloned()
        .collect::<Vec<_>>();
    if endpoints.is_empty() {
        anyhow::bail!("no matching endpoints to probe");
    }
    let reports = endpoints
        .iter()
        .map(probe_endpoint)
        .collect::<Vec<ProbeReport>>();
    if args.apply {
        Config::update(true, |candidate| {
            for report in &reports {
                apply_probe_report(candidate, report, args.replace)?;
            }
            Ok(())
        })?;
    }
    if json {
        output::json(&ProbeOutput {
            applied: args.apply,
            reports,
        })?;
    } else {
        for report in reports {
            if let Some(error) = report.error {
                output::line(format!("{}\toffline\t{error}", report.endpoint_slug))?;
            } else {
                output::line(format!(
                    "{}\tonline\t{} models",
                    report.endpoint_slug,
                    report.discovered_model_ids.len()
                ))?;
                for model in report.discovered_model_ids {
                    output::line(format!("  {model}"))?;
                }
            }
        }
    }
    Ok(())
}

fn set_concurrency(json: bool, args: &ConcurrencyArgs) -> Result<()> {
    let limit = if args.clear { None } else { args.limit };
    let endpoint = update_endpoint(&args.slug, |endpoint| {
        endpoint.concurrency_limit = limit;
        Ok(())
    })?;
    if json {
        output::json(&endpoint)?;
    } else if let Some(limit) = limit {
        output::line(format!(
            "set concurrency for `{}` to {limit}",
            endpoint.slug
        ))?;
    } else {
        output::line(format!("cleared concurrency for `{}`", endpoint.slug))?;
    }
    Ok(())
}

fn set_kv_tokens(json: bool, args: &KvTokensArgs) -> Result<()> {
    let tokens = if args.clear { None } else { args.tokens };
    let endpoint = update_endpoint(&args.slug, |endpoint| {
        endpoint.kv_tokens = tokens;
        Ok(())
    })?;
    if tokens.is_some()
        && crate::engine::effective_kind(&endpoint)
            .is_some_and(|(kind, _)| kind == crate::engine::EngineKind::LlamaCpp)
    {
        output::diagnostic(
            "warning: llama.cpp stays slot-based; a declared KV size is stored but does not switch protection to token mode",
        )?;
    }
    if json {
        output::json(&endpoint)?;
    } else if let Some(tokens) = tokens {
        output::line(format!("set kv-tokens for `{}` to {tokens}", endpoint.slug))?;
    } else {
        output::line(format!("cleared kv-tokens for `{}`", endpoint.slug))?;
    }
    Ok(())
}

fn adapter_command(json: bool, args: &AdapterArgs) -> Result<()> {
    match &args.command {
        AdapterSub::Set(set) => adapter_set(json, set),
        AdapterSub::Show { slug } => adapter_show(json, slug),
        AdapterSub::Clear { slug } => adapter_clear(json, slug),
        AdapterSub::Test { slug } => adapter_test(json, slug),
    }
}

fn adapter_set(json: bool, args: &AdapterSetArgs) -> Result<()> {
    let input = match (&args.route, &args.command) {
        (Some(route), None) => AdapterInput::Route {
            route: route.clone(),
        },
        (None, Some(command)) => AdapterInput::Command {
            command: command.clone(),
        },
        _ => anyhow::bail!("adapter set requires exactly one of --route or --command"),
    };
    let mut map = std::collections::BTreeMap::new();
    for raw in &args.map {
        let (signal, selector) = parse_map_flag(raw)?;
        map.insert(signal, selector);
    }
    let spec = EngineAdapterConfig {
        input,
        format: match args.format {
            AdapterFormatChoice::Json => AdapterFormat::Json,
            AdapterFormatChoice::Prometheus => AdapterFormat::Prometheus,
        },
        interval_secs: args.interval.unwrap_or(2),
        timeout_secs: args.timeout.unwrap_or(2),
        map,
    };
    spec.validate()?;
    let endpoint = update_endpoint(&args.slug, |endpoint| {
        endpoint.engine_adapter = Some(spec.clone());
        Ok(())
    })?;
    if crate::engine::effective_kind(&endpoint).is_some_and(|(kind, _)| kind.has_load_source()) {
        output::diagnostic(
            "warning: the adapter replaces the built-in load scrape for this endpoint",
        )?;
    }
    if json {
        output::json(&endpoint)?;
    } else {
        output::line(format!(
            "set adapter for `{}` ({})",
            endpoint.slug,
            match spec.input {
                AdapterInput::Route { .. } => "route",
                AdapterInput::Command { .. } => "command",
            }
        ))?;
    }
    Ok(())
}

fn adapter_show(json: bool, slug: &str) -> Result<()> {
    let config = Config::load_required()?;
    let endpoint = config.endpoint(slug).ok_or_else(|| {
        anyhow::Error::msg(format!("endpoint `{slug}` not found"))
            .context(CodedError::new(ExitCode::NotFound))
    })?;
    let Some(spec) = &endpoint.engine_adapter else {
        if json {
            output::json(&serde_json::json!({ "slug": slug, "adapter": null }))?;
        } else {
            output::line(format!("no adapter configured for `{slug}`"))?;
        }
        return Ok(());
    };
    if json {
        output::json(&spec)?;
    } else {
        match &spec.input {
            AdapterInput::Route { route } => {
                output::line(format!("{slug}\troute\t{route}"))?;
            }
            AdapterInput::Command { command } => {
                output::line(format!("{slug}\tcommand\t{command}"))?;
            }
        }
        output::line(format!(
            "  format {} interval {}s timeout {}s",
            match spec.format {
                AdapterFormat::Json => "json",
                AdapterFormat::Prometheus => "prometheus",
            },
            spec.interval_secs,
            spec.timeout_secs
        ))?;
        for (signal, selector) in &spec.map {
            output::line(format!("  map {}={}", signal.as_str(), selector.series))?;
        }
    }
    Ok(())
}

fn adapter_clear(json: bool, slug: &str) -> Result<()> {
    let endpoint = update_endpoint(slug, |endpoint| {
        endpoint.engine_adapter = None;
        if let Some(probe) = endpoint.last_probe.as_mut() {
            probe.adapter = None;
        }
        Ok(())
    })?;
    if json {
        output::json(&endpoint)?;
    } else {
        output::line(format!("cleared adapter for `{slug}`"))?;
    }
    Ok(())
}

fn adapter_test(json: bool, slug: &str) -> Result<()> {
    let config = Config::load_required()?;
    let endpoint = config.endpoint(slug).cloned().ok_or_else(|| {
        anyhow::Error::msg(format!("endpoint `{slug}` not found"))
            .context(CodedError::new(ExitCode::NotFound))
    })?;
    let Some(spec) = &endpoint.engine_adapter else {
        anyhow::bail!("no adapter configured for `{slug}`");
    };
    spec.validate()?;
    let sample = crate::engine_adapter::sample(&endpoint, spec, None);
    print_adapter_test(json, slug, sample)
}

fn print_adapter_test(
    json: bool,
    slug: &str,
    sample: Result<AdapterSample, crate::engine_adapter::AdapterError>,
) -> Result<()> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TestOutput {
        slug: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        running: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        waiting: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        kv_usage: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        kv_occupancy: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        slots_busy: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        deferred: Option<u64>,
        dropped: Vec<DroppedRow>,
        missing: Vec<&'static str>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DroppedRow {
        signal: &'static str,
        reason: &'static str,
    }
    let output_value = match sample {
        Ok(sample) => {
            let reading = sample.reading.as_ref();
            TestOutput {
                slug: slug.to_string(),
                ok: reading.is_some(),
                error: sample.error.map(|error| error.as_str()),
                running: reading.map(|reading| reading.running),
                waiting: reading.and_then(|reading| reading.waiting),
                kv_usage: reading.and_then(|reading| reading.kv_usage),
                kv_occupancy: reading.and_then(|reading| reading.kv_occupancy),
                slots_busy: reading.and_then(|reading| reading.slots_busy),
                deferred: reading.and_then(|reading| reading.deferred),
                dropped: sample
                    .dropped
                    .iter()
                    .map(|row| DroppedRow {
                        signal: row.signal.as_str(),
                        reason: match row.reason {
                            DropReason::Unmapped => "unmapped",
                            DropReason::OutOfRange => "out_of_range",
                        },
                    })
                    .collect(),
                missing: sample
                    .missing
                    .iter()
                    .map(|signal| signal.as_str())
                    .collect(),
            }
        }
        Err(error) => TestOutput {
            slug: slug.to_string(),
            ok: false,
            error: Some(error.as_str()),
            running: None,
            waiting: None,
            kv_usage: None,
            kv_occupancy: None,
            slots_busy: None,
            deferred: None,
            dropped: Vec::new(),
            missing: Vec::new(),
        },
    };
    if json {
        output::json(&output_value)?;
    } else if output_value.ok {
        let mut parts = vec![format!("running={}", output_value.running.unwrap_or(0))];
        if let Some(waiting) = output_value.waiting {
            parts.push(format!("waiting={waiting}"));
        }
        if let Some(kv) = output_value.kv_usage {
            parts.push(format!("kvUsage={kv}"));
        }
        if let Some(kv) = output_value.kv_occupancy {
            parts.push(format!("kvOccupancy={kv}"));
        }
        output::line(format!("{slug}\t{}", parts.join(" ")))?;
        for row in &output_value.dropped {
            output::line(format!("  dropped {} ({})", row.signal, row.reason))?;
        }
    } else {
        output::line(format!(
            "{slug}\tfailing\t{}",
            output_value.error.unwrap_or("unknown")
        ))?;
        for row in &output_value.dropped {
            output::line(format!("  dropped {} ({})", row.signal, row.reason))?;
        }
    }
    Ok(())
}

fn set_engine(json: bool, args: &EngineArgs) -> Result<()> {
    let engine = EndpointEngine::from(args.engine);
    let endpoint = update_endpoint(&args.slug, |endpoint| {
        endpoint.engine = engine;
        Ok(())
    })?;
    if json {
        output::json(&endpoint)?;
    } else {
        output::line(format!(
            "set engine for `{}` to {}",
            endpoint.slug,
            engine.as_config_str()
        ))?;
    }
    Ok(())
}

fn update_endpoint(
    slug: &str,
    mutate: impl FnOnce(&mut EndpointConfig) -> Result<()>,
) -> Result<EndpointConfig> {
    Config::update(true, |cfg| {
        let endpoint = cfg
            .endpoints
            .iter_mut()
            .find(|endpoint| endpoint.slug == slug)
            .ok_or_else(|| {
                anyhow::Error::msg(format!("endpoint `{slug}` not found"))
                    .context(CodedError::new(ExitCode::NotFound))
            })?;
        mutate(endpoint)?;
        Ok(endpoint.clone())
    })
}

fn parse_header_env(raw: &str) -> Result<HeaderEnvRef> {
    let Some((name, env)) = raw.split_once('=') else {
        anyhow::bail!("header env `{raw}` must use `Header-Name=ENV_VAR`");
    };
    if name.trim().is_empty() {
        anyhow::bail!("header name cannot be empty");
    }
    validate_env_name(env)?;
    Ok(HeaderEnvRef {
        name: name.trim().to_string(),
        env: env.to_string(),
    })
}

#[derive(Debug, Serialize)]
struct RemoveResult<'a> {
    slug: &'a str,
    removed: bool,
}

#[derive(Debug, Serialize)]
struct EndpointList {
    endpoints: Vec<EndpointConfig>,
}

#[derive(Debug, Serialize)]
struct ProbeOutput {
    applied: bool,
    reports: Vec<ProbeReport>,
}
