//! `wsmp recover`: list or apply crash-safe file-op recovery from INTENT.

use anyhow::Result;
#[cfg(not(unix))]
use anyhow::bail;

use crate::output;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    pub json: bool,

    /// Roll forward or back from INTENT. Without this flag, only list.
    #[arg(long)]
    pub apply: bool,

    /// Also walk configured file roots for `.wsmp-recover-*` directories.
    /// Startup never does this; it can hang on a dead NFS mount.
    #[arg(long)]
    pub scan: bool,
}

pub fn run(args: &Args) -> Result<()> {
    #[cfg(not(unix))]
    {
        let _ = args;
        bail!("file recovery is only supported on Unix");
    }
    #[cfg(unix)]
    run_unix(args)
}

#[cfg(unix)]
fn run_unix(args: &Args) -> Result<()> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RecoverOutput {
        reports: Vec<crate::file_ops::RecoverReport>,
    }
    let mut reports = crate::file_ops::recover_from_registry(args.apply);
    if args.scan {
        let config = crate::config::Config::load()?;
        reports.extend(crate::file_ops::recover_scan(
            &config.file_roots,
            args.apply,
        ));
    }
    if args.json {
        return output::json(&RecoverOutput { reports });
    }
    if reports.is_empty() {
        output::line("no abandoned file recovery directories")?;
        return Ok(());
    }
    for report in &reports {
        let slots = if report.slots.is_empty() {
            String::new()
        } else {
            format!(" slots={}", report.slots.join(","))
        };
        output::line(format!(
            "{}: {} ({:?}){slots}",
            report.path, report.message, report.action
        ))?;
    }
    if !args.apply {
        output::line("re-run with `--apply` to restore or dispose from INTENT")?;
    }
    Ok(())
}
