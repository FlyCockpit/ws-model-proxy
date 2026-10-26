//! `wsmp __runtime-host --dir <dir> --unit <unit> --invocation <id> --shell <shell> --script
//! <script> [--argv-json <args>]` — internal: the relay starts one per Windows runtime unit
//! ([`crate::runtimes::executor::windows`]).

use std::path::PathBuf;

use anyhow::Result;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// The unit records' directory.
    #[arg(long)]
    dir: PathBuf,
    /// The unit this host runs.
    #[arg(long)]
    unit: String,
    /// The launch's invocation id (in the unit's record).
    #[arg(long)]
    invocation: String,
    /// `pwsh`, `powershell` or `cmd`.
    #[arg(long)]
    shell: String,
    /// The command, for the shell.
    #[arg(long, allow_hyphen_values = true)]
    script: String,
    /// The arguments the script was rendered from (a JSON array), when it was an argv: an
    /// `.exe` starts directly.
    #[arg(long, allow_hyphen_values = true)]
    argv_json: Option<String>,
}

pub fn run(args: &Args) -> Result<()> {
    crate::runtimes::executor::windows::host(&crate::runtimes::executor::windows::HostArgs {
        dir: &args.dir,
        unit: &args.unit,
        invocation: &args.invocation,
        shell: &args.shell,
        script: &args.script,
        argv_json: args.argv_json.as_deref(),
    })
}
