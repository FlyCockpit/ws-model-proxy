//! `wsmp endpoints` commands.

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{
    Config, EndpointConfig, EndpointEngine, HeaderEnvRef, OpenAiCompatibleCapabilities,
    validate_env_name,
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
    /// Declare the upstream engine. llama.cpp and vLLM advertise `top_k`.
    Engine(EngineArgs),
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
    /// Upstream engine. `llama.cpp` and `vllm` advertise `top_k`.
    #[arg(long, value_enum)]
    engine: Option<EngineChoice>,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum EngineChoice {
    Generic,
    #[value(name = "llama.cpp")]
    LlamaCpp,
    Vllm,
}

impl From<EngineChoice> for EndpointEngine {
    fn from(choice: EngineChoice) -> Self {
        match choice {
            EngineChoice::Generic => Self::Generic,
            EngineChoice::LlamaCpp => Self::LlamaCpp,
            EngineChoice::Vllm => Self::Vllm,
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
struct EngineArgs {
    slug: String,
    #[arg(value_enum)]
    engine: EngineChoice,
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
        Sub::Engine(engine) => set_engine(args.json, engine),
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
