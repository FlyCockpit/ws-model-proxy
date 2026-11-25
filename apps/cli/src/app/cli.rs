//! Command-line interface definition.
//!
//! All argument parsing lives here (clap derive). Each subcommand's *logic*
//! lives in its own file under `src/app/commands/` — this file only declares the
//! shape of the CLI. Keeping parsing and logic separate keeps both readable and
//! makes commands easy to test in isolation.

use clap::{Parser, Subcommand, ValueEnum};

/// Top-level CLI. The `about` text is shown in `--help`.
#[derive(Debug, Parser)]
#[command(
    name = "wsmp",
    version,
    about = "Command-line relay client for WS Model Proxy.",
    // Let every subcommand report the same package version.
    propagate_version = true
)]
pub struct Cli {
    /// How to format log output. `text` is human-friendly; `json` is for
    /// machines (pipe into `jq`, ship to a log collector, etc.).
    #[arg(long, value_enum, default_value_t = LogFormat::Text, global = true)]
    pub log_format: LogFormat,

    /// Increase log verbosity (-v = debug, -vv = trace). Overridden by the
    /// `WSMP_LOG` / `RUST_LOG` env var if set.
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    pub verbose: u8,

    /// Silence all logs except errors.
    #[arg(short, long, global = true, conflicts_with = "verbose")]
    pub quiet: bool,

    #[command(subcommand)]
    pub command: Command,
}

/// Log output format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum LogFormat {
    /// Human-readable, colored when attached to a terminal.
    Text,
    /// One JSON object per line.
    Json,
}

/// The subcommands. Add new ones here, then implement them in `src/app/commands/`.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Enroll this machine as a node with a code from the Nodes page.
    Login(crate::app::commands::setup::login::Args),

    /// Show or set what the server may do on this machine.
    Trust(crate::app::commands::setup::trust::Args),

    /// Set, list or remove node secrets (`WSMP_SECRET_*`).
    Secret(crate::app::commands::setup::secret::Args),

    /// Inspect the configuration file and resolved paths.
    Config(crate::app::commands::setup::config::Args),

    /// Run the relay in the foreground (what the service runs).
    Run(crate::app::commands::operate::run::Args),

    /// List the runtimes and instances this node holds, or test one.
    Runtime(crate::app::commands::operate::runtime::Args),

    /// Install or inspect a per-user operating-system service for the relay.
    Service(crate::app::commands::setup::service::Args),

    /// Show whether the relay is running and connected.
    Status(crate::app::commands::operate::status::Args),

    /// Show the hardware this node detects (memory, GPUs, unified pool).
    Hardware(crate::app::commands::operate::hardware::Args),

    /// Forget this node's credential.
    Logout(crate::app::commands::setup::logout::Args),

    /// Generate shell completion scripts.
    Completions(crate::app::commands::completions::Args),

    /// Approve browser identities and show the CLI identity for terminals.
    Terminal(crate::app::commands::setup::terminal::Args),

    /// Install the server's wsmp here (verified, rolled back by itself if it
    /// does not come up), or show the last update.
    Update(crate::app::commands::operate::update::Args),

    /// List or apply crash-safe file recovery from abandoned `.wsmp-recover-*` directories.
    Recover(crate::app::commands::operate::recover::Args),

    /// Internal: run a runtime command so it cannot outlive the relay that started it.
    #[command(name = "__launch-guard", hide = true)]
    LaunchGuard(crate::app::commands::internal::launch_guard::Args),
    /// Internal: hosts one Windows browser terminal's console (started by
    /// the relay).
    #[cfg(windows)]
    #[command(name = "__conpty-host", hide = true)]
    ConptyHost(crate::app::commands::internal::conpty_host::Args),
    /// Internal: holds one Windows runtime unit's command and everything it
    /// starts (started by the relay).
    #[cfg(windows)]
    #[command(name = "__runtime-host", hide = true)]
    RuntimeHost(crate::app::commands::internal::runtime_host::Args),

    /// Internal: how a launch guard starts its command (with the signals it blocked unblocked).
    #[command(name = "__launch-guard-exec", hide = true)]
    LaunchGuardExec(crate::app::commands::internal::launch_guard::ExecArgs),
}
