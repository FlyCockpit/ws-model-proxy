//! `wsmp run`: the relay in the foreground (what the service runs).

use std::path::PathBuf;

use anyhow::Result;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// The config file to use, ahead of `WSMP_CONFIG`. For a service manager
    /// that cannot set environment variables (Windows Task Scheduler).
    #[arg(long, hide = true, value_name = "PATH")]
    pub config: Option<PathBuf>,
    /// The state directory to use, ahead of `WSMP_STATE_DIR` (see `--config`).
    #[arg(long, hide = true, value_name = "DIR")]
    pub state_dir: Option<PathBuf>,
    /// Also write logs to this file, rotated at 10 MiB with 4 older files kept
    /// (`wsmp service logs` reads it on Windows).
    #[arg(long, hide = true, value_name = "PATH")]
    pub log_file: Option<PathBuf>,
    /// A service manager started this relay: keep retrying a missing
    /// credential or a refused protocol, even when stderr is a console (the
    /// Windows task's headless one), since no one reads it.
    #[arg(long, hide = true)]
    pub service: bool,
}

pub fn run(args: &Args) -> Result<()> {
    if args.config.is_some() || args.state_dir.is_some() {
        crate::paths::pin(args.config.clone(), args.state_dir.clone())?;
    }
    if args.service {
        crate::daemon::run_as_service();
        #[cfg(windows)]
        crate::shutdown::stop_when_console_host_goes();
    }
    crate::trust::refuse_marked("wsmp run")?;
    crate::daemon::connect_foreground()
}
