//! `wsmp config` commands.

use std::path::{Path, PathBuf};

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
    /// Opt in to durable model deployment jobs (off by default). Each job
    /// rechecks this flag; reconnect to refresh the server's feature report.
    ///
    /// Turning this on lets the server run shell commands on this machine
    /// (`/bin/sh -c`, as the user running wsmp) for deployment jobs. The MCP
    /// command mode does not limit jobs the server reports as approved by a
    /// person: they run even when `set-mcp-commands` is `off`. Only jobs the
    /// server reports as agent-authored are checked against the mode, and in
    /// `supervised` their approval is the server's word, not a confirm screen
    /// on this machine. Turn it on only for a server you would trust with a
    /// shell here.
    SetDeployments { state: Switch },
    /// Allow operator terminals for interactive recipe steps (off by default).
    /// Needs deployments on and terminal support; it never enables browser
    /// shells. The owner runs each step's exact command after pressing Enter in
    /// a terminal opened from the dashboard. Without it the server refuses to
    /// plan interactive recipes on this node.
    SetDeploymentOperatorTerminal { state: Switch },
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
    /// too). Takes effect the next time wsmp starts. This does not limit
    /// person-approved deployment jobs; see `set-deployments`.
    SetMcpCommands { mode: McpMode },
    /// Opt in to headless read-only file access with the dashboard grant.
    /// Requires explicit file roots. Restart wsmp to apply.
    SetFileRead { state: Switch },
    /// Confine every file tool to these directories. Suggested roots (never
    /// applied automatically): ~/models, ~/deploy, ~/.config/llama-swap,
    /// ~/.local/state/wsmp/logs. Restart wsmp to apply.
    SetFileRoots {
        #[arg(required = true, num_args = 1..)]
        paths: Vec<PathBuf>,
    },
    /// Clear the file allowlist; headless reads outside unsupervised then refuse.
    /// Restart wsmp to apply.
    ClearFileRoots,
    /// Require approval before a browser can open a terminal.
    SetTerminalApproval { state: Switch },
    /// Let the MCP node file tools run when wsmp itself runs as root (they
    /// refuse `unsupported` by default). Takes effect the next time wsmp starts.
    SetFileToolsAsRoot { state: Switch },
    /// Accept metric sources defined remotely (dashboard or MCP). Each one
    /// still needs `wsmp metrics approve`. Takes effect the next time wsmp
    /// starts.
    SetRemoteMetricSources { state: Switch },
    /// Accept engine adapters defined remotely (dashboard or MCP). Separate
    /// from metric-source opt-in. Each one still needs
    /// `wsmp endpoints adapter approve`. Takes effect the next time wsmp
    /// starts.
    SetRemoteEngineAdapters { state: Switch },
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
        Sub::SetDeployments { state } => {
            Config::update(false, |config| {
                config.allow_deployments = state.enabled();
                Ok(())
            })?;
            if args.json {
                output::json(
                    &serde_json::json!({"key":"allowDeployments","value":state.enabled()}),
                )?;
            } else {
                output::line(format!(
                    "set `allowDeployments` to `{}`; reconnect to refresh server preflight",
                    state.enabled()
                ))?;
            }
        }
        Sub::SetDeploymentOperatorTerminal { state } => {
            Config::update(false, |config| {
                config.allow_deployment_operator_terminal = state.enabled();
                Ok(())
            })?;
            if args.json {
                output::json(&serde_json::json!({
                    "key": "allowDeploymentOperatorTerminal",
                    "value": state.enabled()
                }))?;
            } else {
                output::line(format!(
                    "set `allowDeploymentOperatorTerminal` to `{}`; reconnect to refresh server preflight",
                    state.enabled()
                ))?;
            }
        }
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
            let mut shown = serde_json::to_value(&cfg)?;
            shown["mcpFileRead"] = cfg.mcp_file_read.into();
            shown["fileRoots"] = serde_json::to_value(&cfg.file_roots)?;
            if args.json {
                output::json(&shown)?;
            } else {
                output::text(serde_json::to_string_pretty(&shown)?)?;
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
        Sub::SetFileRead { state } => {
            set_flag(args.json, "mcpFileRead", state.enabled(), |cfg| {
                cfg.mcp_file_read = state.enabled()
            })?;
        }
        Sub::SetFileRoots { paths } => {
            let roots = crate::config::validate_file_roots(paths, dirs::home_dir().as_deref())?;
            Config::update(false, |cfg| {
                cfg.file_roots = roots.clone();
                Ok(())
            })?;
            if args.json {
                output::json(&serde_json::json!({"key":"fileRoots", "value":roots}))?;
            } else {
                output::line("set `fileRoots`; restart wsmp to apply")?;
            }
        }
        Sub::ClearFileRoots => {
            Config::update(false, |cfg| {
                cfg.file_roots.clear();
                Ok(())
            })?;
            if args.json {
                output::json(&serde_json::json!({"key":"fileRoots", "value":[]}))?;
            } else {
                output::line("cleared `fileRoots`; restart wsmp to apply")?;
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
        Sub::SetFileToolsAsRoot { state } => {
            set_flag(args.json, "allowFileToolsAsRoot", state.enabled(), |cfg| {
                cfg.allow_file_tools_as_root = state.enabled();
            })?;
        }
        Sub::SetRemoteMetricSources { state } => {
            set_flag(
                args.json,
                "allowRemoteMetricSources",
                state.enabled(),
                |cfg| {
                    cfg.allow_remote_metric_sources = state.enabled();
                },
            )?;
        }
        Sub::SetRemoteEngineAdapters { state } => {
            set_flag(
                args.json,
                "allowRemoteEngineAdapters",
                state.enabled(),
                |cfg| {
                    cfg.allow_remote_engine_adapters = state.enabled();
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
