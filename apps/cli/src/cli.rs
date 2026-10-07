//! Command-line interface definition.
//!
//! All argument parsing lives here (clap derive). Each subcommand's *logic*
//! lives in its own file under `src/commands/` — this file only declares the
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

/// The subcommands. Add new ones here, then implement them in `src/commands/`.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Enroll this machine as a node with a code from the Nodes page.
    Login(crate::commands::login::Args),

    /// Show or set what the server may do on this machine.
    Trust(crate::commands::trust::Args),

    /// Set, list or remove node secrets (`WSMP_SECRET_*`).
    Secret(crate::commands::secret::Args),

    /// Inspect the configuration file and resolved paths.
    Config(crate::commands::config::Args),

    /// Run the relay in the foreground (what the service runs).
    Run(crate::commands::run::Args),

    /// Install or inspect a per-user operating-system service for the relay.
    Service(crate::commands::service::Args),

    /// Show whether the relay is running and connected.
    Status(crate::commands::status::Args),

    /// Show the hardware this node detects (memory, GPUs, unified pool).
    Hardware(crate::commands::hardware::Args),

    /// Forget this node's credential.
    Logout(crate::commands::logout::Args),

    /// Generate shell completion scripts.
    Completions(crate::commands::completions::Args),

    /// Approve browser identities and show the CLI identity for terminals.
    Terminal(crate::commands::terminal::Args),

    /// List or apply crash-safe file recovery from abandoned `.wsmp-recover-*` directories.
    Recover(crate::commands::recover::Args),
}
