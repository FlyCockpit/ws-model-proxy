//! `wsmp token` commands.

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{Config, validate_env_name};
use crate::output;

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
    /// Record the environment variable that contains a manually created CLI token.
    Login { env_var: String },
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::Login { env_var } => {
            validate_env_name(env_var)?;
            let value = std::env::var(env_var).with_context(|| {
                format!("reading CLI token from environment variable `{env_var}`")
            })?;
            if value.trim().is_empty() {
                anyhow::bail!("CLI token environment variable `{env_var}` is empty");
            }
            let mut cfg = Config::load()?;
            cfg.cli_token_env = Some(env_var.clone());
            cfg.save()?;
            if args.json {
                output::json(&TokenLogin {
                    cli_token_env: env_var,
                })?;
            } else {
                output::line(format!(
                    "recorded CLI token environment variable `{env_var}`"
                ))?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenLogin<'a> {
    cli_token_env: &'a str,
}
