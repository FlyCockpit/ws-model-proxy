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
    /// Confine every file tool to these directories (unset: your home
    /// directory; wsmp's own files stay off limits). For example ~/models,
    /// ~/deploy, ~/.config/llama-swap. Restart wsmp to apply.
    SetFileRoots {
        #[arg(required = true, num_args = 1..)]
        paths: Vec<PathBuf>,
    },
    /// Clear the file allowlist: file tools go back to your home directory.
    /// Restart wsmp to apply.
    ClearFileRoots,
    /// Turn the node file tools on or off (on by default; off refuses every
    /// file op with `no_roots`). Restart wsmp to apply.
    SetFileTools { state: Switch },
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
    /// Windows: the shell a browser terminal starts unless the browser picks
    /// another (`pwsh`, `powershell`, `cmd` or `wsl:<distribution>`).
    /// `default` goes back to pwsh, then powershell, then cmd. Takes effect
    /// the next time wsmp starts.
    SetTerminalShell { shell: String },
    /// Whether this node's owner may update wsmp from the browser: `allowed`
    /// (the default) or `off`. `wsmp update` here still works. Applies at once.
    SetRemoteUpdates {
        #[arg(value_enum)]
        state: crate::protocol::runtime_spec::RemoteUpdates,
    },
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

impl Sub {
    /// The command, when it changes the config (`None`: read-only).
    fn mutation(&self) -> Option<&'static str> {
        Some(match self {
            Self::Path | Self::Show => return None,
            Self::Init => "wsmp config init",
            Self::SetServer { .. } => "wsmp config set-server",
            Self::SetSlug { .. } => "wsmp config set-slug",
            Self::SetHumanTerminal { .. } => "wsmp config set-human-terminal",
            Self::SetRuntimeHosts { .. } => "wsmp config set-runtime-hosts",
            Self::SetFileRoots { .. } => "wsmp config set-file-roots",
            Self::ClearFileRoots => "wsmp config clear-file-roots",
            Self::SetFileTools { .. } => "wsmp config set-file-tools",
            Self::SetTerminalApproval { .. } => "wsmp config set-terminal-approval",
            Self::SetMaxTerminals { .. } => "wsmp config set-max-terminals",
            Self::SetFileToolsAsRoot { .. } => "wsmp config set-file-tools-as-root",
            Self::SetTerminalShell { .. } => "wsmp config set-terminal-shell",
            Self::SetRemoteUpdates { .. } => "wsmp config set-remote-updates",
        })
    }
}

pub fn run(args: &Args) -> Result<()> {
    if let Some(command) = args.command.mutation() {
        crate::trust::refuse_in_job(command)?;
    }
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
            if let Some(warning) = cfg.retired_command_policy_warning {
                output::diagnostic(format!("warning: {warning}"))?;
            }
            let mut shown = serde_json::to_value(&cfg)?;
            let (roots, source) =
                crate::config::effective_file_roots(&cfg, dirs::home_dir().as_deref());
            shown["fileRoots"] = serde_json::to_value(&roots)?;
            shown["fileRootsSource"] = serde_json::to_value(source)?;
            shown["maxTerminals"] = cfg.effective_max_terminals().into();
            shown["remoteUpdates"] = cfg.remote_updates.as_str().into();
            if cfg!(windows) {
                // What a browser can pick now, the default first.
                shown["terminalShells"] = crate::shells::discover(cfg.terminal_shell.as_deref())
                    .into_iter()
                    .map(|shell| shell.id)
                    .collect::<Vec<_>>()
                    .into();
            }
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
            let cleared = set_server(url, public_origin.clone())?;
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
                output::line(
                    "cleared `fileRoots` (file tools use your home directory); restart wsmp to apply",
                )?;
            }
        }
        Sub::SetFileTools { state } => {
            set_flag(args.json, "fileTools", state.enabled(), |cfg| {
                cfg.disable_file_tools = !state.enabled();
            })?;
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
        Sub::SetTerminalShell { shell } => {
            if !cfg!(windows) {
                anyhow::bail!("terminals run the login shell (`$SHELL`) on this system");
            }
            let value = (shell != "default").then(|| shell.clone());
            if let Some(id) = &value {
                if !crate::shells::valid_id(id) {
                    anyhow::bail!(
                        "`{id}` is not a shell; use `pwsh`, `powershell`, `cmd`, `wsl:<distribution>` or `default`"
                    );
                }
                if !crate::shells::discover(None)
                    .iter()
                    .any(|found| &found.id == id)
                {
                    output::diagnostic(format!(
                        "warning: `{id}` is not installed now; terminals use the default until it is"
                    ))?;
                }
            }
            Config::update(false, |cfg| {
                cfg.terminal_shell = value.clone();
                Ok(())
            })?;
            if args.json {
                output::json(&serde_json::json!({"key": "terminalShell", "value": value}))?;
            } else {
                match &value {
                    Some(id) => output::line(format!("set `terminalShell` to `{id}`"))?,
                    None => output::line("cleared `terminalShell`")?,
                }
                output::line("Restart wsmp to apply.")?;
            }
        }
        Sub::SetRemoteUpdates { state } => {
            let state = *state;
            Config::update(false, |cfg| {
                cfg.remote_updates = state;
                Ok(())
            })?;
            // The running relay reports the new setting at once.
            let _ = crate::control::request_if_running(crate::control::ControlCommand::Reload);
            if args.json {
                output::json(&SetValue {
                    key: "remoteUpdates",
                    value: state.as_str(),
                })?;
            } else {
                output::line(format!("set `remoteUpdates` to `{}`", state.as_str()))?;
            }
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

/// Persist the command's validated addresses under one config lock.
fn set_server(url: &str, public_origin: Option<String>) -> Result<Option<String>> {
    set_server_with_savers(
        url,
        public_origin,
        Config::save,
        crate::state::save_node_credential,
    )
}

fn set_server_with_savers(
    url: &str,
    public_origin: Option<String>,
    save_config: impl Fn(&Config) -> Result<()>,
    save_credential: impl FnOnce(&crate::state::NodeCredential) -> Result<()>,
) -> Result<Option<String>> {
    let _lock = crate::config::ConfigLock::exclusive()?;
    let previous_config = Config::load()?;
    let mut cfg = previous_config.clone();
    // Only move an enrollment paired with the previous config.
    let credential = crate::state::load_node_credential()?.filter(|credential| {
        crate::auth::credential_matches_server(
            credential,
            cfg.server_url.as_deref(),
            cfg.public_origin.as_deref(),
        )
    });
    cfg.server_url = Some(url.to_string());
    let previous = std::mem::replace(&mut cfg.public_origin, public_origin.clone());
    // Save config first: an interruption between saves leaves a legacy-style
    // pair, which the next daemon startup accepts.
    save_config(&cfg)?;
    if let Some(mut credential) = credential {
        credential.server = url.to_string();
        if let Err(error) = save_credential(&credential) {
            if let Err(rollback) = save_config(&previous_config) {
                return Err(error.context(format!(
                    "restoring the previous config also failed: {rollback:#}; retry `wsmp config set-server`"
                )));
            }
            return Err(error);
        }
    }
    Ok(previous.filter(|_| public_origin.is_none()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{NodeCredential, load_node_credential, save_node_credential};

    fn isolated_paths(test_name: &str, run: impl FnOnce()) {
        const CHILD_ROOT: &str = "WSMP_SET_SERVER_FAILURE_TEST_ROOT";
        let Some(root) = std::env::var_os(CHILD_ROOT) else {
            let root = tempfile::tempdir().expect("tempdir");
            let result =
                std::process::Command::new(std::env::current_exe().expect("test executable"))
                    .args(["--exact", test_name, "--nocapture"])
                    .env(CHILD_ROOT, root.path())
                    .output()
                    .expect("isolated test");
            assert!(
                result.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        };
        let root = PathBuf::from(root);
        crate::paths::pin(
            Some(root.join("config/config.json")),
            Some(root.join("state")),
        )
        .expect("isolated paths");
        run();
    }

    #[test]
    fn show_warns_about_retired_command_policy_on_stderr_only() {
        const CHILD_ROOT: &str = "WSMP_CONFIG_SHOW_RETIRED_TEST_ROOT";
        let Some(root) = std::env::var_os(CHILD_ROOT) else {
            // Run the unit-test executable, never the wsmp binary. Capture
            // stderr independently of stdout, including for JSON output.
            for mode in ["standard", "isolated"] {
                let root = tempfile::tempdir().expect("tempdir");
                std::fs::write(
                    root.path().join("config.json"),
                    serde_json::json!({ "agentCommands": mode }).to_string(),
                )
                .expect("prerelease config");
                let result = std::process::Command::new(
                    std::env::current_exe().expect("test executable"),
                )
                .args([
                    "--exact",
                    "commands::config::tests::show_warns_about_retired_command_policy_on_stderr_only",
                    "--nocapture",
                ])
                .env(CHILD_ROOT, root.path())
                .output()
                .expect("isolated unit test");
                let stderr = String::from_utf8(result.stderr).expect("stderr");
                let stdout = String::from_utf8(result.stdout).expect("stdout");
                assert!(result.status.success(), "{stderr}\n{stdout}");
                assert_eq!(stderr.lines().count(), 2, "{stderr}");
                assert_eq!(
                    stderr.matches("warning: The agentCommands setting was removed in wsmp 1.0 and is ignored.").count(),
                    2,
                    "{stderr}"
                );
                assert_eq!(stderr.contains("wsmp trust relay"), mode == "isolated");
                assert!(!stdout.contains("agentCommands"), "{stdout}");
                assert!(!stdout.contains("retiredCommandPolicyWarning"), "{stdout}");
            }
            return;
        };
        let root = PathBuf::from(root);
        crate::paths::pin(Some(root.join("config.json")), Some(root.join("state")))
            .expect("isolated paths");
        for json in [false, true] {
            run(&Args {
                json,
                command: Sub::Show,
            })
            .expect("config show");
        }
    }

    #[test]
    fn set_server_rolls_back_config_when_credential_save_fails() {
        isolated_paths(
            "commands::config::tests::set_server_rolls_back_config_when_credential_save_fails",
            || {
                let original = Config {
                    server_url: Some("https://example.invalid".into()),
                    public_origin: Some("https://public.invalid".into()),
                    cli_slug: Some("spark-1".into()),
                    ..Config::default()
                };
                original.save().expect("initial config");
                let credential = NodeCredential {
                    node_id: "node-1".into(),
                    slug: "spark-1".into(),
                    server: "https://example.invalid".into(),
                    credential: "test-only-token".into(),
                };
                save_node_credential(&credential).expect("initial credential");
                let error = set_server_with_savers(
                    "https://moved.invalid",
                    None,
                    Config::save,
                    |candidate| {
                        let saved = Config::load_required().expect("config saved first");
                        assert_eq!(saved.server_url.as_deref(), Some("https://moved.invalid"));
                        assert!(saved.public_origin.is_none());
                        assert_eq!(candidate.server, "https://moved.invalid");
                        anyhow::bail!("injected credential save failure")
                    },
                )
                .expect_err("credential save fails");
                assert_eq!(error.to_string(), "injected credential save failure");
                assert_eq!(
                    serde_json::to_value(Config::load_required().expect("restored config"))
                        .expect("json"),
                    serde_json::to_value(&original).expect("json")
                );
                assert_eq!(
                    load_node_credential().expect("credential"),
                    Some(credential)
                );
            },
        );
    }

    #[test]
    fn set_server_does_not_save_credential_when_config_save_fails() {
        isolated_paths(
            "commands::config::tests::set_server_does_not_save_credential_when_config_save_fails",
            || {
                Config {
                    server_url: Some("https://example.invalid".into()),
                    ..Config::default()
                }
                .save()
                .expect("initial config");
                let original = NodeCredential {
                    node_id: "node-1".into(),
                    slug: "spark-1".into(),
                    server: "https://example.invalid".into(),
                    credential: "test-only-token".into(),
                };
                save_node_credential(&original).expect("initial credential");
                let error = set_server_with_savers(
                    "https://moved.invalid",
                    None,
                    |_| anyhow::bail!("injected config save failure"),
                    |_| panic!("credential must not be saved"),
                )
                .expect_err("config save fails");
                assert_eq!(error.to_string(), "injected config save failure");
                assert_eq!(
                    Config::load_required()
                        .expect("config")
                        .server_url
                        .as_deref(),
                    Some("https://example.invalid")
                );
                assert_eq!(load_node_credential().expect("credential"), Some(original));
            },
        );
    }

    #[test]
    fn set_server_reports_rollback_failure_and_keeps_the_credential_error() {
        isolated_paths(
            "commands::config::tests::set_server_reports_rollback_failure_and_keeps_the_credential_error",
            || {
                Config {
                    server_url: Some("https://example.invalid".into()),
                    ..Config::default()
                }
                .save()
                .expect("initial config");
                let original = NodeCredential {
                    node_id: "node-1".into(),
                    slug: "spark-1".into(),
                    server: "https://example.invalid".into(),
                    credential: "test-only-token".into(),
                };
                save_node_credential(&original).expect("initial credential");
                let saves = std::cell::Cell::new(0);
                let error = set_server_with_savers(
                    "https://moved.invalid",
                    None,
                    |config| {
                        saves.set(saves.get() + 1);
                        if saves.get() == 2 {
                            anyhow::bail!("injected rollback failure");
                        }
                        config.save()
                    },
                    |_| anyhow::bail!("injected credential save failure"),
                )
                .expect_err("both saves fail");
                assert_eq!(saves.get(), 2);
                let message = format!("{error:#}");
                assert!(message.contains("injected rollback failure"));
                assert!(message.contains("injected credential save failure"));
                assert!(message.contains("retry `wsmp config set-server`"));
                assert_eq!(
                    load_node_credential().expect("credential"),
                    Some(original.clone())
                );
                let config = Config::load_required().expect("config");
                assert_eq!(config.server_url.as_deref(), Some("https://moved.invalid"));
                assert_eq!(
                    crate::auth::CredentialPairing::default()
                        .resolve_credential(
                            config.server_url.as_deref(),
                            config.public_origin.as_deref()
                        )
                        .expect("startup accepts the interrupted pair"),
                    original.credential
                );
            },
        );
    }

    #[test]
    fn credential_pairing_rereads_replacements_and_restart_accepts_the_new_pair() {
        isolated_paths(
            "commands::config::tests::credential_pairing_rereads_replacements_and_restart_accepts_the_new_pair",
            || {
                let original = NodeCredential {
                    node_id: "node-1".into(),
                    slug: "spark-1".into(),
                    server: "https://legacy.invalid".into(),
                    credential: "test-only-token".into(),
                };
                save_node_credential(&original).expect("legacy credential");
                let configured = Some("http://192.168.1.10:3000");
                let mut running = crate::auth::CredentialPairing::default();
                assert_eq!(
                    running
                        .resolve_credential(configured, None)
                        .expect("legacy startup without pin"),
                    original.credential
                );
                let refreshed = NodeCredential {
                    credential: "refreshed-test-token".into(),
                    ..original.clone()
                };
                save_node_credential(&refreshed).expect("refresh");
                assert_eq!(
                    running
                        .resolve_credential(configured, None)
                        .expect("same-server refresh"),
                    refreshed.credential
                );
                let replaced = NodeCredential {
                    server: "https://replacement.invalid".into(),
                    ..refreshed
                };
                save_node_credential(&replaced).expect("replacement enrollment");
                let message = running
                    .resolve_credential(configured, None)
                    .expect_err("changed enrollment")
                    .to_string();
                assert!(message.contains("wsmp service restart"));
                assert!(message.contains("restart `wsmp run`"));
                let mut restarted = crate::auth::CredentialPairing::default();
                assert_eq!(
                    restarted
                        .resolve_credential(configured, None)
                        .expect("restart accepts new startup pair"),
                    replaced.credential
                );
            },
        );
    }

    #[test]
    fn set_server_then_connect_preserves_enrollment_and_private_storage() {
        const CHILD_ROOT: &str = "WSMP_SET_SERVER_TEST_ROOT";
        let Some(root) = std::env::var_os(CHILD_ROOT) else {
            // Path overrides are process-wide. Run this test alone in a child
            // rather than changing another parallel test's config or state.
            let root = tempfile::tempdir().expect("tempdir");
            let result = std::process::Command::new(std::env::current_exe().expect("test executable"))
                .args(["--exact", "commands::config::tests::set_server_then_connect_preserves_enrollment_and_private_storage", "--nocapture"])
                .env(CHILD_ROOT, root.path())
                .output().expect("isolated test");
            assert!(
                result.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        };
        let root = PathBuf::from(root);
        crate::paths::pin(
            Some(root.join("config/config.json")),
            Some(root.join("state")),
        )
        .expect("isolated paths");
        let original = NodeCredential {
            node_id: "node-1".into(),
            slug: "spark-1".into(),
            server: "https://example.invalid/enrolled".into(),
            credential: "test-only-token".into(),
        };
        let config = Config {
            server_url: Some("https://example.invalid".into()),
            ..Config::default()
        };
        config.save().expect("initial config");
        save_node_credential(&original).expect("enrollment");
        let set_server = |url: &str, public_origin: Option<&str>| {
            // Exercise the command's mutation independently of the process
            // ancestry guard: the test runner may itself be a wsmp job.
            super::set_server(url, public_origin.map(str::to_string)).expect("set-server");
        };
        let connect = || {
            let config = Config::load_required().expect("config");
            crate::auth::CredentialPairing::default().resolve_credential(
                config.server_url.as_deref(),
                config.public_origin.as_deref(),
            )
        };
        set_server("http://192.168.1.10:3000", Some("https://example.invalid"));
        let moved = load_node_credential()
            .expect("credential")
            .expect("enrolled");
        assert_eq!(
            moved,
            NodeCredential {
                server: "http://192.168.1.10:3000".into(),
                ..original.clone()
            }
        );
        assert_eq!(connect().expect("connect over LAN"), original.credential);
        // A pre-upgrade LAN config can still hold its public login address.
        save_node_credential(&original).expect("old enrollment address");
        assert_eq!(connect().expect("legacy LAN connect"), original.credential);
        set_server("https://moved.invalid", None);
        assert_eq!(
            connect().expect("connect after domain move"),
            original.credential
        );
        assert_eq!(
            load_node_credential()
                .expect("credential")
                .expect("enrolled")
                .server,
            "https://moved.invalid"
        );
        assert!(
            Config::load_required()
                .expect("config")
                .public_origin
                .is_none()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(crate::paths::node_credential_file().expect("path"))
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(crate::paths::state_dir().expect("path"))
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        // Do not relabel an enrollment unrelated to the previous config.
        save_node_credential(&original).expect("unrelated credential");
        set_server("https://another.invalid", None);
        assert_eq!(
            load_node_credential()
                .expect("credential")
                .expect("enrolled"),
            original
        );
        assert_eq!(
            connect().expect("startup accepts the pre-existing pair"),
            original.credential
        );
        crate::state::remove_node_credential().expect("remove fixture credential");
        set_server("https://unenrolled.invalid", None);
        assert!(load_node_credential().expect("credential").is_none());
    }
}
