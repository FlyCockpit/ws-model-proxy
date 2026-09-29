//! `wsmp metrics`: list, test and approve custom metric sources.
//!
//! Local sources live in the config file (`metrics.sources`). Remote sources
//! arrive from the server and are stored in the state directory; each needs
//! the `allowRemoteMetricSources` opt-in and an approval of its exact command
//! (`wsmp metrics approve`), which pins the command's SHA-256 in the config.
//! The running daemon re-reads approvals within a few seconds.

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::config::Config;
use crate::display_escape::escape_for_display;
use crate::metric_sources::{
    self, Eligibility, Series, SourceSpec, effective_sources, load_remote_sources, sha256_hex,
};
use crate::output;
use crate::protocol::{MetricSourceError, MetricSourceFormat, MetricSourceOrigin};

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
    /// List local and remote metric sources and their state.
    List,
    /// Run a source once now, with the same limits, and print what it reports.
    Test { name: String },
    /// Approve a remote source's exact command. A changed command needs a
    /// new approval.
    Approve {
        name: String,
        /// Only approve if the command's SHA-256 is exactly this (as shown by
        /// `wsmp metrics list`).
        #[arg(long)]
        sha256: Option<String>,
    },
    /// Remove the approval of a remote source; it stops running.
    Revoke { name: String },
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::List => list(args.json),
        Sub::Test { name } => test(args.json, name),
        Sub::Approve { name, sha256 } => approve(args.json, name, sha256.as_deref()),
        Sub::Revoke { name } => revoke(args.json, name),
    }
}

fn origin_str(origin: MetricSourceOrigin) -> &'static str {
    match origin {
        MetricSourceOrigin::Local => "local",
        MetricSourceOrigin::Remote => "remote",
    }
}

fn format_str(format: MetricSourceFormat) -> &'static str {
    match format {
        MetricSourceFormat::Number => "number",
        MetricSourceFormat::Json => "json",
        MetricSourceFormat::Prometheus => "prometheus",
    }
}

fn eligibility_str(eligibility: Eligibility) -> &'static str {
    match eligibility {
        Eligibility::Run => "active",
        Eligibility::Disabled => "disabled",
        Eligibility::Refused => "refused",
        Eligibility::PendingApproval => "pending_approval",
    }
}

fn error_str(error: MetricSourceError) -> &'static str {
    match error {
        MetricSourceError::Spawn => "spawn",
        MetricSourceError::Timeout => "timeout",
        MetricSourceError::ExitStatus => "exit_status",
        MetricSourceError::OutputTooLarge => "output_too_large",
        MetricSourceError::Parse => "parse",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListedSource {
    name: String,
    origin: &'static str,
    state: &'static str,
    interval_secs: u32,
    timeout_secs: u32,
    format: &'static str,
    command: String,
    command_sha256: String,
}

fn sources(config: &Config) -> Result<Vec<(SourceSpec, Eligibility)>> {
    let remote = load_remote_sources()?;
    Ok(effective_sources(
        &config.metrics,
        &remote,
        config.allow_remote_metric_sources,
    ))
}

fn list(json: bool) -> Result<()> {
    let config = Config::load()?;
    let listed = sources(&config)?
        .into_iter()
        .map(|(spec, eligibility)| ListedSource {
            name: spec.name,
            origin: origin_str(spec.origin),
            state: eligibility_str(eligibility),
            interval_secs: spec.interval_secs,
            timeout_secs: spec.timeout_secs,
            format: format_str(spec.format),
            command: spec.command,
            command_sha256: spec.command_sha256,
        })
        .collect::<Vec<_>>();
    if json {
        return output::json(&ListResult {
            allow_remote_metric_sources: config.allow_remote_metric_sources,
            sources: &listed,
        });
    }
    if listed.is_empty() {
        return output::line("no metric sources");
    }
    for source in &listed {
        output::line(format!(
            "{} ({}, {}) every {}s, timeout {}s, {}",
            source.name,
            source.origin,
            source.state,
            source.interval_secs,
            source.timeout_secs,
            source.format
        ))?;
        output::line(format!(
            "  command: {}",
            escape_for_display(&source.command)
        ))?;
        output::line(format!("  sha256:  {}", source.command_sha256))?;
    }
    if !config.allow_remote_metric_sources && listed.iter().any(|s| s.origin == "remote") {
        output::line(
            "Remote sources are refused: `wsmp config set-remote-metric-sources on` opts in (restart wsmp to apply).",
        )?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResult<'a> {
    allow_remote_metric_sources: bool,
    sources: &'a [ListedSource],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApproveResult<'a> {
    name: &'a str,
    command_sha256: &'a str,
    command: &'a str,
    allow_remote_metric_sources: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevokeResult<'a> {
    name: &'a str,
    revoked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    name: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    series: Vec<Series>,
}

fn test(json: bool, name: &str) -> Result<()> {
    let config = Config::load()?;
    let found = sources(&config)?
        .into_iter()
        .filter(|(spec, _)| spec.name == name)
        // A local source shadows a remote one of the same name.
        .min_by_key(|(spec, _)| spec.origin == MetricSourceOrigin::Remote);
    let Some((spec, eligibility)) = found else {
        bail!("no metric source named `{}`", escape_for_display(name));
    };
    if spec.origin == MetricSourceOrigin::Remote && eligibility != Eligibility::Run {
        bail!(
            "remote source `{}` is {}; approve it (and opt in) before testing it",
            spec.name,
            eligibility_str(eligibility)
        );
    }
    if eligibility == Eligibility::Disabled {
        bail!(
            "source `{}` is disabled: check its interval (5..=86400 s), timeout (1..=300 s) and command",
            spec.name
        );
    }
    // Take shutdown signals so Ctrl-C ends the command's process group (it is
    // not in the terminal's foreground group) instead of orphaning it.
    crate::shutdown::install()?;
    let outcome = metric_sources::run_source(&spec, None);
    if let Some(signal) = crate::shutdown::requested() {
        return Err(crate::shutdown::ShutdownRequested { signal }.into());
    }
    let result = TestResult {
        name: spec.name.clone(),
        ok: outcome.is_ok(),
        error: outcome.as_ref().err().map(|error| error_str(*error)),
        series: outcome.unwrap_or_default(),
    };
    if json {
        return output::json(&result);
    }
    if let Some(error) = result.error {
        output::line(format!("{}: failed ({error})", result.name))?;
        return Ok(());
    }
    for series in &result.series {
        let labels = series
            .labels
            .iter()
            .map(|(key, value)| format!("{key}=\"{value}\""))
            .collect::<Vec<_>>()
            .join(",");
        if labels.is_empty() {
            output::line(format!("{} {}", series.name, series.value))?;
        } else {
            output::line(format!("{}{{{labels}}} {}", series.name, series.value))?;
        }
    }
    Ok(())
}

fn approve(json: bool, name: &str, expected: Option<&str>) -> Result<()> {
    let remote = load_remote_sources()?;
    let Some(source) = remote.iter().find(|source| source.name == name) else {
        bail!(
            "no remote metric source named `{}` has been received",
            escape_for_display(name)
        );
    };
    let hash = sha256_hex(source.command.as_bytes());
    if let Some(expected) = expected
        && !expected.trim().eq_ignore_ascii_case(&hash)
    {
        bail!(
            "the command of `{}` changed: its SHA-256 is {hash}, not {}",
            source.name,
            escape_for_display(expected.trim())
        );
    }
    let opted_in = Config::update(false, |cfg| {
        cfg.metrics
            .approved_remote_sources
            .insert(source.name.clone(), hash.clone());
        Ok(cfg.allow_remote_metric_sources)
    })
    .context("storing the approval")?;
    if json {
        return output::json(&ApproveResult {
            name: &source.name,
            command_sha256: &hash,
            command: &source.command,
            allow_remote_metric_sources: opted_in,
        });
    }
    output::line(format!(
        "approved `{}` (sha256 {hash}); it runs as your OS user:",
        source.name
    ))?;
    output::line(format!("  {}", escape_for_display(&source.command)))?;
    if !opted_in {
        output::line(
            "Remote sources are still refused until `wsmp config set-remote-metric-sources on` (restart wsmp to apply).",
        )?;
    }
    Ok(())
}

fn revoke(json: bool, name: &str) -> Result<()> {
    let removed = Config::update(false, |cfg| {
        Ok(cfg.metrics.approved_remote_sources.remove(name).is_some())
    })?;
    if json {
        return output::json(&RevokeResult {
            name,
            revoked: removed,
        });
    }
    if removed {
        output::line(format!(
            "revoked the approval of `{}`",
            escape_for_display(name)
        ))
    } else {
        output::line(format!("`{}` was not approved", escape_for_display(name)))
    }
}
