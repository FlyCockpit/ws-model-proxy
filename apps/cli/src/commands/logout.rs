//! `wsmp logout`: forget this node's credential.

use anyhow::Result;
use serde::Serialize;

use crate::output;
use crate::state::remove_node_credential;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
}

pub fn run(args: &Args) -> Result<()> {
    let removed_credential = remove_node_credential()?;
    if args.json {
        output::json(&LogoutOutput { removed_credential })?;
    } else {
        output::line("logged out")?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutOutput {
    removed_credential: bool,
}
