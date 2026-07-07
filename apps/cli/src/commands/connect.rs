//! `wsmp connect`.

use anyhow::Result;

use crate::daemon::connect_foreground;

#[derive(Debug, clap::Args)]
pub struct Args {}

pub fn run(_args: &Args) -> Result<()> {
    connect_foreground()
}
