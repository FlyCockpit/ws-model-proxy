//! `wsmp endpoints` commands.

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{
    Config, EndpointConfig, HeaderEnvRef, OpenAiCompatibleCapabilities, validate_env_name,
};
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
}

#[derive(Debug, clap::Args)]
struct ProbeArgs {
    slug: Option<String>,
    /// Apply non-secret probe suggestions to local config.
    #[arg(long)]
    apply: bool,
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::Add(add) => add_endpoint(args.json, add),
        Sub::Remove { slug } => remove_endpoint(args.json, slug),
        Sub::List => list_endpoints(args.json),
        Sub::Probe(probe) => probe_endpoints(args.json, probe),
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
    let mut cfg = Config::load()?;
    if cfg.endpoint(&args.slug).is_some() {
        anyhow::bail!("endpoint `{}` already exists", args.slug);
    }
    let endpoint = EndpointConfig {
        slug: args.slug.clone(),
        label: args.label.clone(),
        base_url: args.base_url.clone(),
        enabled: !args.disabled,
        headers,
        default_capabilities: OpenAiCompatibleCapabilities::default(),
        ..EndpointConfig::default()
    };
    cfg.endpoints.push(endpoint.clone());
    cfg.save()?;
    if json {
        output::json(&endpoint)?;
    } else {
        output::line(format!("added endpoint `{}`", endpoint.slug))?;
    }
    Ok(())
}

fn remove_endpoint(json: bool, slug: &str) -> Result<()> {
    let mut cfg = Config::load_required()?;
    let before = cfg.endpoints.len();
    cfg.endpoints.retain(|endpoint| endpoint.slug != slug);
    let removed = before != cfg.endpoints.len();
    if !removed {
        anyhow::bail!("endpoint `{slug}` not found");
    }
    cfg.save()?;
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
    let mut cfg = Config::load_required()?;
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
        for report in &reports {
            apply_probe_report(&mut cfg, report)?;
        }
        cfg.save()?;
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
