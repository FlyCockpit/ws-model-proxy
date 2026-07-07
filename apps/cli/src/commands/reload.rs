//! `wsmp reload`.
//!
//! v1 has no background control socket; this command validates and refreshes
//! local endpoint inventory so supervisors can run it before restarting the
//! foreground daemon.

use anyhow::Result;
use serde::Serialize;

use crate::config::Config;
use crate::output;
use crate::probe::{apply_probe_report, probe_endpoint};

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
}

pub fn run(args: &Args) -> Result<()> {
    let mut cfg = Config::load_required()?;
    cfg.validate()?;
    let reports = cfg
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.enabled)
        .map(probe_endpoint)
        .collect::<Vec<_>>();
    for report in &reports {
        apply_probe_report(&mut cfg, report)?;
    }
    cfg.save()?;
    if args.json {
        output::json(&ReloadOutput {
            reloaded: true,
            endpoints: reports.len(),
        })?;
    } else {
        output::line(format!("reloaded {} endpoints", reports.len()))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct ReloadOutput {
    reloaded: bool,
    endpoints: usize,
}
