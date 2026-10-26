//! `wsmp __launch-guard --parent <pid> --lock <path> -- <program> [args]` — internal: the
//! relay runs every runtime command through it ([`crate::launch_guard`]).

use std::ffi::OsString;
use std::path::PathBuf;

use anyhow::Result;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// The process id of the relay that started this command.
    #[arg(long)]
    parent: u32,
    /// The launcher lock the guard holds while the command runs.
    #[arg(long)]
    lock: PathBuf,
    /// The program and its arguments.
    #[arg(last = true, required = true)]
    command: Vec<OsString>,
}

pub fn run(args: &Args) -> Result<()> {
    let (program, rest) = args
        .command
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("no command"))?;
    crate::launch_guard::guard(args.parent, &args.lock, program, rest)
}

/// `wsmp __launch-guard-exec -- <program> [args]` — internal: how a guard starts its command.
#[derive(Debug, clap::Args)]
pub struct ExecArgs {
    /// The program and its arguments.
    #[arg(last = true, required = true)]
    command: Vec<OsString>,
}

pub fn exec(args: &ExecArgs) -> Result<()> {
    let (program, rest) = args
        .command
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("no command"))?;
    crate::launch_guard::exec(program, rest)
}
