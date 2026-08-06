//! `wsmp reload`.
//!
//! The request is served by the live relay daemon and succeeds only after the
//! server durably acknowledges the updated inventory.

use crate::config::Config;
#[cfg(unix)]
use crate::control::{self, ControlCommand};
use crate::output;
use crate::probe::{apply_probe_report, probe_endpoint};
use anyhow::Result;
use serde::Serialize;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
    /// Probe and save local endpoint state without publishing it. This is the
    /// explicit fallback for platforms without the Unix live control socket.
    #[arg(long)]
    offline: bool,
}

pub fn run(args: &Args) -> Result<()> {
    if args.offline {
        return run_offline(args.json);
    }
    #[cfg(not(unix))]
    {
        anyhow::bail!(
            "live reload is unavailable on this platform; use `wsmp reload --offline` to probe and save local state (it does not publish), then run a Unix relay to publish"
        );
    }
    #[cfg(unix)]
    run_live(args.json)
}

#[cfg(unix)]
fn run_live(json: bool) -> Result<()> {
    let response = control::request(ControlCommand::Reload)?;
    let ok = response
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if json {
        output::json(&response)?;
        if !ok {
            anyhow::bail!("reload failed");
        }
    } else if ok {
        let endpoints = response
            .get("endpoints")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        output::line(format!("published {endpoints} endpoints"))?;
    } else {
        let message = response
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("reload failed");
        anyhow::bail!("{message}");
    }
    Ok(())
}

fn run_offline(json: bool) -> Result<()> {
    // Probe before acquiring the lock: an unavailable endpoint must not block
    // unrelated local config changes for its network timeout. `Config::update`
    // rereads under the transitional lock before atomically saving the reports.
    let config = Config::load_required()?;
    config.validate()?;
    let reports = config
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.enabled)
        .map(probe_endpoint)
        .collect::<Vec<_>>();
    Config::update(true, |candidate| {
        for report in &reports {
            apply_probe_report(candidate, report)?;
        }
        candidate.validate()
    })?;

    let result = OfflineReloadResult {
        offline: true,
        published: false,
        endpoints: reports.len(),
        message: "saved local probe state; not published",
    };
    if json {
        output::json(&result)?;
    } else {
        output::line(format!(
            "saved local probe state for {} endpoints; not published",
            result.endpoints
        ))?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineReloadResult {
    offline: bool,
    published: bool,
    endpoints: usize,
    message: &'static str,
}
