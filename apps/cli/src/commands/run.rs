//! `wsmp run`: the relay in the foreground (what the service runs).

use anyhow::Result;

#[derive(Debug, clap::Args)]
pub struct Args {}

pub fn run(_args: &Args) -> Result<()> {
    crate::trust::refuse_in_job("wsmp run")?;
    crate::daemon::connect_foreground()
}
