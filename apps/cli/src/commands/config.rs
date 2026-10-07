//! `wsmp config` commands.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{Config, normalize_public_origin, server_url_http_warning};
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
    /// Set the self-hosted web app server URL this CLI connects to.
    ///
    /// The relay hello signs the server's origin, and the CLI signs only the
    /// origin set here: `--public-origin`, else this URL's origin. When this
    /// machine reaches the server through another address (a LAN IP or an
    /// internal hostname), pass the server's public origin (the origin of its
    /// `BETTER_AUTH_URL`), for example
    /// `wsmp config set-server http://10.0.0.5:3000 --public-origin https://wsmp.example.com`.
    /// Setting the server again without `--public-origin` clears it. Restart
    /// wsmp to apply; no new login is needed.
    SetServer {
        url: String,
        /// The server's public origin (`https://host[:port]`) when it differs
        /// from the URL's origin. Plain http is accepted.
        #[arg(long)]
        public_origin: Option<String>,
    },
    /// Set this CLI connection's slug.
    SetSlug { slug: String },
    /// Allow browser terminals (also asked at `wsmp login`). Takes effect
    /// the next time wsmp starts.
    SetHumanTerminal { state: Switch },
    /// Extra hosts (`ip` or `ip:port`, IP literals) a server-defined
    /// always-on runtime may use besides loopback. Applies at once.
    SetRuntimeHosts {
        #[arg(num_args = 0..)]
        hosts: Vec<String>,
    },
    /// Confine every file tool to these directories. Suggested roots (never
    /// applied automatically): ~/models, ~/deploy, ~/.config/llama-swap,
    /// ~/.local/state/wsmp/logs. Restart wsmp to apply.
    SetFileRoots {
        #[arg(required = true, num_args = 1..)]
        paths: Vec<PathBuf>,
    },
    /// Clear the file allowlist; file ops are then refused (`no_roots`).
    /// Restart wsmp to apply.
    ClearFileRoots,
    /// Require approval before a browser can open a terminal.
    SetTerminalApproval { state: Switch },
    /// Cap the browser terminals open at once on this machine (1 to 32,
    /// default 4). The server also caps terminals per CLI and per user; the
    /// lowest limit applies. Operator terminals have their own slots. Takes
    /// effect the next time wsmp starts.
    SetMaxTerminals {
        #[arg(value_parser = clap::value_parser!(u32).range(1..=32))]
        count: u32,
    },
    /// Let the MCP node file tools run when wsmp itself runs as root (they
    /// refuse `unsupported` by default). Takes effect the next time wsmp starts.
    SetFileToolsAsRoot { state: Switch },
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub(crate) enum Switch {
    On,
    Off,
}

impl Switch {
    pub(crate) fn enabled(self) -> bool {
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
            let mut shown = serde_json::to_value(&cfg)?;
            shown["fileRoots"] = serde_json::to_value(&cfg.file_roots)?;
            shown["maxTerminals"] = cfg.effective_max_terminals().into();
            // The origin the relay hello signs (pinned, else the server URL's).
            if cfg.server_url.is_some() || cfg.public_origin.is_some() {
                shown["helloOrigin"] = match cfg.hello_origin() {
                    Ok(origin) => origin.into(),
                    Err(error) => {
                        output::diagnostic(format!("warning: {error:#}"))?;
                        serde_json::Value::Null
                    }
                };
            }
            // Where this shell looks; a service resolving a different state
            // directory reads a different device credential.
            shown["configFile"] = crate::paths::config_file()?.display().to_string().into();
            shown["stateDir"] = crate::paths::state_dir()?.display().to_string().into();
            // An out-of-range value is shown as written, but flagged: the
            // relay refuses to start with it, so no limit is in effect.
            if let Err(error) = cfg.validate_max_terminals() {
                shown["maxTerminalsInvalid"] = true.into();
                output::diagnostic(format!(
                    "warning: {error}; the relay will not start until it is fixed (`wsmp config set-max-terminals <n>`)"
                ))?;
            }
            if args.json {
                output::json(&shown)?;
            } else {
                output::text(serde_json::to_string_pretty(&shown)?)?;
                output::line("")?;
            }
        }
        Sub::SetServer { url, public_origin } => {
            url::Url::parse(url).with_context(|| format!("parsing server URL `{url}`"))?;
            let public_origin = public_origin
                .as_deref()
                .map(|origin| {
                    normalize_public_origin(origin)
                        .with_context(|| format!("checking public origin `{origin}`"))
                })
                .transpose()?;
            // The pin dropped by setting the server again without the flag.
            let cleared = Config::update(false, |cfg| {
                cfg.server_url = Some(url.clone());
                let previous = std::mem::replace(&mut cfg.public_origin, public_origin.clone());
                Ok(previous.filter(|_| public_origin.is_none()))
            })?;
            // The CLI's traffic goes to the connect URL; a plain-http public
            // origin is only a name and needs no warning.
            if let Some(warning) = server_url_http_warning(url) {
                output::diagnostic(warning)?;
            }
            if args.json {
                output::json(&SetServer {
                    key: "serverUrl",
                    value: url,
                    public_origin: public_origin.as_deref(),
                    cleared_public_origin: cleared.as_deref(),
                })?;
            } else {
                output::line(format!("set server URL to `{url}`"))?;
                match (&public_origin, &cleared) {
                    (Some(origin), _) => output::line(format!("set public origin to `{origin}`"))?,
                    (None, Some(previous)) => output::line(format!(
                        "cleared the pinned public origin `{previous}`; the relay now signs the server URL's origin"
                    ))?,
                    (None, None) => output::line("public origin: the server URL's origin")?,
                }
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
        Sub::SetRuntimeHosts { hosts } => {
            for host in hosts {
                anyhow::ensure!(
                    crate::runtime_store::validate::parse_runtime_host(host).is_some(),
                    "`{host}` is not an IP literal with an optional port"
                );
            }
            Config::update(false, |cfg| {
                cfg.runtime_hosts = hosts.clone();
                Ok(())
            })?;
            let _ = crate::control::request_if_running(crate::control::ControlCommand::Reload);
            if args.json {
                output::json(&serde_json::json!({"key": "runtimeHosts", "value": hosts}))?;
            } else {
                output::line("set `runtimeHosts`")?;
            }
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
        Sub::SetMaxTerminals { count } => {
            // clap bounds `count` to `MAX_TERMINALS_RANGE`.
            let count = *count;
            Config::update(false, |cfg| {
                cfg.max_terminals = Some(count);
                Ok(())
            })?;
            if args.json {
                output::json(&serde_json::json!({"key": "maxTerminals", "value": count}))?;
            } else {
                output::line(format!("set `maxTerminals` to `{count}`"))?;
                output::line("Restart wsmp to apply.")?;
            }
        }
        Sub::SetFileToolsAsRoot { state } => {
            set_flag(args.json, "allowFileToolsAsRoot", state.enabled(), |cfg| {
                cfg.allow_file_tools_as_root = state.enabled();
            })?;
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

/// `set-server --json`: the `SetValue` shape plus the pinned public origin
/// (`null` when the server URL's origin is used).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetServer<'a> {
    key: &'static str,
    value: &'a str,
    public_origin: Option<&'a str>,
    /// The previously pinned origin this call removed, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    cleared_public_origin: Option<&'a str>,
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
