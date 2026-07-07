//! `wsmp logout`.

use anyhow::Result;
use serde::Serialize;

use crate::config::Config;
use crate::output;
use crate::state::remove_device_credential;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Also forget the configured CLI token environment variable.
    #[arg(long)]
    token: bool,
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
}

pub fn run(args: &Args) -> Result<()> {
    let removed_device_credential = remove_device_credential()?;
    let mut removed_token_env = false;
    if args.token {
        let mut cfg = Config::load()?;
        removed_token_env = cfg.cli_token_env.take().is_some();
        if removed_token_env {
            cfg.save()?;
        }
    }
    if args.json {
        output::json(&LogoutOutput {
            removed_device_credential,
            removed_token_env,
        })?;
    } else {
        output::line("logged out")?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutOutput {
    removed_device_credential: bool,
    removed_token_env: bool,
}
