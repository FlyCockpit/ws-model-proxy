//! `wsmp config` commands.

use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{Config, McpCommandMode};
use crate::output;
use crate::slug::validate_slug;

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
    /// Print the path to the config file.
    Path,
    /// Create a default JSON config file if one does not already exist.
    Init,
    /// Print the effective JSON config.
    Show,
    /// Set the self-hosted web app server URL.
    SetServer { url: String },
    /// Set this CLI connection's slug.
    SetSlug { slug: String },
    /// Allow browser terminals. Takes effect the next time wsmp starts.
    SetHumanTerminal { state: Switch },
    /// Choose what MCP agents may run: `off`, `supervised` (a person confirms
    /// each command in a browser terminal), or `unsupervised` (headless exec
    /// too). Takes effect the next time wsmp starts.
    SetMcpCommands { mode: McpMode },
    /// Require approval before a browser can open a terminal.
    SetTerminalApproval { state: Switch },
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum Switch {
    On,
    Off,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum McpMode {
    Off,
    Supervised,
    Unsupervised,
}

impl McpMode {
    fn mode(self) -> McpCommandMode {
        match self {
            Self::Off => McpCommandMode::Off,
            Self::Supervised => McpCommandMode::Supervised,
            Self::Unsupervised => McpCommandMode::Unsupervised,
        }
    }
}

impl Switch {
    fn enabled(self) -> bool {
        matches!(self, Self::On)
    }
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::Path => {
            let path = crate::paths::config_file()?;
            if args.json {
                output::json(&ConfigPath::new(&path))?;
            } else {
                output::line(path.display())?;
            }
        }
        Sub::Init => {
            let path = crate::paths::config_file()?;
            let created = Config::default()
                .save_new()
                .context("writing default config file")?;
            if args.json {
                output::json(&ConfigInit::new(&path, created))?;
            } else if created {
                output::line(format!("wrote config to `{}`", path.display()))?;
            } else {
                output::line(format!("config already exists at `{}`", path.display()))?;
            }
        }
        Sub::Show => {
            let cfg = Config::load_required()?;
            if args.json {
                output::json(&cfg)?;
            } else {
                output::text(serde_json::to_string_pretty(&cfg)?)?;
                output::line("")?;
            }
        }
        Sub::SetServer { url } => {
            url::Url::parse(url).with_context(|| format!("parsing server URL `{url}`"))?;
            Config::update(false, |cfg| {
                cfg.server_url = Some(url.clone());
                Ok(())
            })?;
            if args.json {
                output::json(&SetValue {
                    key: "serverUrl",
                    value: url,
                })?;
            } else {
                output::line(format!("set server URL to `{url}`"))?;
            }
        }
        Sub::SetSlug { slug } => {
            validate_slug(slug)?;
            Config::update(false, |cfg| {
                cfg.cli_slug = Some(slug.clone());
                Ok(())
            })?;
            if args.json {
                output::json(&SetValue {
                    key: "cliSlug",
                    value: slug,
                })?;
            } else {
                output::line(format!("set CLI slug to `{slug}`"))?;
            }
        }
        Sub::SetHumanTerminal { state } => {
            set_flag(args.json, "allowHumanTerminal", state.enabled(), |cfg| {
                cfg.allow_human_terminal = state.enabled();
            })?;
        }
        Sub::SetMcpCommands { mode } => {
            let mode = mode.mode();
            Config::update(false, |cfg| {
                cfg.mcp_command_mode = mode;
                Ok(())
            })?;
            if args.json {
                output::json(&SetValue {
                    key: "mcpCommandMode",
                    value: mode.as_str(),
                })?;
            } else {
                output::line(format!("set `mcpCommandMode` to `{}`", mode.as_str()))?;
                if mode == McpCommandMode::Supervised {
                    output::line(
                        "Tip: `wsmp config set-terminal-approval on` makes browsers prove an approved identity before they can confirm a command.",
                    )?;
                }
                output::line("Restart wsmp to apply.")?;
            }
        }
        Sub::SetTerminalApproval { state } => {
            set_flag(
                args.json,
                "requireTerminalApproval",
                state.enabled(),
                |cfg| {
                    cfg.require_terminal_approval = state.enabled();
                },
            )?;
        }
    }
    Ok(())
}

fn set_flag(
    json: bool,
    key: &'static str,
    value: bool,
    mutate: impl FnOnce(&mut Config),
) -> Result<()> {
    Config::update(false, |cfg| {
        mutate(cfg);
        Ok(())
    })?;
    if json {
        output::json(&SetFlag { key, value })?;
    } else {
        output::line(format!(
            "set `{key}` to `{}`",
            if value { "on" } else { "off" }
        ))?;
        output::line("Restart wsmp to apply.")?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct ConfigPath {
    path: String,
}

impl ConfigPath {
    fn new(path: &Path) -> Self {
        Self {
            path: path.display().to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ConfigInit {
    path: String,
    created: bool,
}

impl ConfigInit {
    fn new(path: &Path, created: bool) -> Self {
        Self {
            path: path.display().to_string(),
            created,
        }
    }
}

#[derive(Debug, Serialize)]
struct SetValue<'a> {
    key: &'static str,
    value: &'a str,
}

#[derive(Debug, Serialize)]
struct SetFlag {
    key: &'static str,
    value: bool,
}
