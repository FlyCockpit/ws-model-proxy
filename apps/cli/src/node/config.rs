//! CLI-local JSON configuration.
//!
//! The config intentionally stores references to environment variables for
//! secrets, never secret values. Product-native device credentials live in the
//! state directory; endpoint base URLs stay local and are not included in relay
//! registration inventory.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::slug::validate_slug;
use crate::wire::protocol::frames::TrustValue;
use crate::wire::protocol::runtime_spec::{FileRootsSource, RemoteUpdates};

mod capabilities;
mod endpoint;
mod file_roots;
mod origin;
mod store;

pub use capabilities::{
    AudioOperationCapabilities, CapabilityConfidence, CapabilitySource,
    OpenAiCompatibleCapabilities, RealtimeAdapter, ReasoningConfig, SurfaceCapabilities,
    SurfaceInventory,
};
pub use endpoint::{
    CapabilityOverrideMode, EndpointAuthConfig, EndpointAuthMode, EndpointConfig, EndpointEngine,
    EndpointKind, HeaderEnvRef, ModelConfig, ProbeSnapshot, ProbeStatus,
};
pub use file_roots::{file_roots_usable, validate_file_roots};
pub use origin::{
    is_loopback_host, normalize_public_origin, server_url_http_warning, set_server_command,
};
pub use store::ConfigLock;

use endpoint::is_false;
use file_roots::{deserialize_file_roots, validate_file_root_shape};

pub const CONFIG_VERSION: u8 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u8,
    /// A diagnostic about a retired key in the loaded file, never a setting.
    /// Skipped on every save; it has no effect on the node's permissions.
    #[serde(skip)]
    pub retired_command_policy_warning: Option<&'static str>,
    pub server_url: Option<String>,
    /// The server's public origin, pinned by a person on this machine
    /// (`wsmp config set-server <URL> --public-origin <origin>`). The relay
    /// hello signs only this origin, or the server URL's origin when unset.
    /// Needed when the CLI connects through another address (a LAN IP or an
    /// internal hostname). Never taken from the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_origin: Option<String>,
    pub cli_slug: Option<String>,
    /// The node's trust (`full` or `relay`), the authority for what the
    /// server may do here. Lowering sticks: only `wsmp trust full` on a TTY
    /// raises it, and a hot reload of this file never does. Unset means
    /// Relay only (fail closed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<TrustValue>,
    /// Extra hosts (`ip[:port]`, IP literals only) an always-on runtime the
    /// server defines may use besides loopback.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runtime_hosts: Vec<String>,
    /// Extra HTTP(S) origins whose signed `/media/{id}` URLs the relay may fetch
    /// and inline when an endpoint enables `expandMedia`. The connected server's
    /// own origin is always trusted; these are additive.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub media_trusted_origins: Vec<String>,
    /// Browser terminal master switch. Read when the relay starts; turning it
    /// off while the daemon runs takes effect on the next hot reload and ends
    /// open browser shells, turning it on takes a restart.
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_human_terminal: bool,
    /// Require a locally approved browser identity before opening a terminal.
    #[serde(default, skip_serializing_if = "is_false")]
    pub require_terminal_approval: bool,
    /// Browser terminals this machine keeps open at once
    /// ([`MAX_TERMINALS_RANGE`]; unset means [`DEFAULT_MAX_TERMINALS`]).
    /// Operator terminals have their own slots. Read once
    /// when the relay starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_terminals: Option<u32>,
    /// The shell a Windows browser terminal starts when the browser does not
    /// pick one (`pwsh`, `powershell`, `cmd` or `wsl:<distribution>`). Unset,
    /// or not installed: pwsh, then powershell, then cmd. Read once when the
    /// relay starts; ignored on Unix, which runs the login shell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_shell: Option<String>,
    /// Run the MCP node file tools even when the daemon is root (euid 0). Read
    /// once when the relay starts; off by default.
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_file_tools_as_root: bool,
    /// Explicit directory allowlist for every file operation. Unset: the
    /// user's home directory ([`Config::effective_file_roots`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_roots: Vec<PathBuf>,
    /// Turn the node file tools off (no roots at all). Read once when the
    /// relay starts.
    #[serde(default, skip_serializing_if = "is_false")]
    pub disable_file_tools: bool,
    /// Whether the node's owner may update this wsmp from their browser (`allowed`, the
    /// default, or `off`). Read when an update arrives; a person on this machine sets it
    /// (`wsmp config set-remote-updates`).
    #[serde(default, skip_serializing_if = "is_allowed")]
    pub remote_updates: RemoteUpdates,
}

fn is_allowed(value: &RemoteUpdates) -> bool {
    *value == RemoteUpdates::Allowed
}

impl Config {
    /// The origin the relay hello may sign: the pinned public origin, else
    /// the server URL's origin.
    pub fn hello_origin(&self) -> Result<String> {
        if let Some(origin) = &self.public_origin {
            return normalize_public_origin(origin)
                .with_context(|| format!("validating public origin `{origin}`"));
        }
        let server_url = self
            .server_url
            .as_deref()
            .context("server URL is not configured; run `wsmp config set-server <URL>`")?;
        let url = url::Url::parse(server_url)
            .with_context(|| format!("parsing server URL `{server_url}`"))?;
        match url.scheme() {
            "http" | "https" => Ok(url.origin().ascii_serialization()),
            other => anyhow::bail!("unsupported server URL scheme `{other}`"),
        }
    }
}

/// One setting changed on this machine: by a `wsmp config set-*` command,
/// `wsmp login`, or the node's trust rules ([`crate::node::trust`]). Callers check
/// the value first; [`Config::apply`] only records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Setting {
    /// `cliSlug`, the node's name.
    CliSlug(String),
    /// `allowHumanTerminal`, the browser terminal master switch.
    AllowHumanTerminal(bool),
    /// `runtimeHosts`, already parsed as IP literals.
    RuntimeHosts(Vec<String>),
    /// `fileRoots`, already validated; empty clears the allowlist (the home
    /// directory again).
    FileRoots(Vec<PathBuf>),
    /// Whether the node file tools are on (`disableFileTools` is the opposite).
    FileTools(bool),
    /// `requireTerminalApproval`.
    RequireTerminalApproval(bool),
    /// `maxTerminals`, within [`MAX_TERMINALS_RANGE`].
    MaxTerminals(u32),
    /// `allowFileToolsAsRoot`.
    AllowFileToolsAsRoot(bool),
    /// `terminalShell`; `None` goes back to the default.
    TerminalShell(Option<String>),
    /// `remoteUpdates`.
    RemoteUpdates(RemoteUpdates),
    /// `trust`, as the trust rules decided it.
    Trust(TrustValue),
}

impl Config {
    /// Record `setting` in this config (saving is the caller's).
    pub fn apply(&mut self, setting: Setting) {
        match setting {
            Setting::CliSlug(slug) => self.cli_slug = Some(slug),
            Setting::AllowHumanTerminal(allow) => self.allow_human_terminal = allow,
            Setting::RuntimeHosts(hosts) => self.runtime_hosts = hosts,
            Setting::FileRoots(roots) => self.file_roots = roots,
            Setting::FileTools(enabled) => self.disable_file_tools = !enabled,
            Setting::RequireTerminalApproval(require) => self.require_terminal_approval = require,
            Setting::MaxTerminals(count) => self.max_terminals = Some(count),
            Setting::AllowFileToolsAsRoot(allow) => self.allow_file_tools_as_root = allow,
            Setting::TerminalShell(shell) => self.terminal_shell = shell,
            Setting::RemoteUpdates(state) => self.remote_updates = state,
            Setting::Trust(trust) => self.trust = Some(trust),
        }
    }

    /// Record `setting` in the config file: one [`Config::update`] (a
    /// missing file starts from the defaults).
    pub fn set(setting: Setting) -> Result<()> {
        Self::update(false, |config| {
            config.apply(setting);
            Ok(())
        })
    }

    /// Point this config at the server `url`, with `public_origin` pinned or
    /// (`None`) cleared. Returns the pin it replaced, if any.
    pub fn point_at_server(&mut self, url: &str, public_origin: Option<String>) -> Option<String> {
        self.server_url = Some(url.to_string());
        std::mem::replace(&mut self.public_origin, public_origin)
    }

    /// What a `wsmp login` enrolled: the server (and its pinned origin, if
    /// any), the node's slug and the trust decided for it.
    pub fn record_enrollment(
        &mut self,
        server_url: &str,
        public_origin: Option<String>,
        slug: &str,
        trust: TrustValue,
    ) {
        self.point_at_server(server_url, public_origin);
        self.apply(Setting::CliSlug(slug.to_string()));
        self.apply(Setting::Trust(trust));
    }

    /// Whether a server URL is set (the node was enrolled or pointed at one).
    pub fn has_server_url(&self) -> bool {
        self.server_url.is_some()
    }

    /// The server URL of an enrolled node.
    pub fn enrolled_server_url(&self) -> Result<&str> {
        self.server_url
            .as_deref()
            .context("this node is not enrolled; run `wsmp login <url> --code <code>`")
    }

    /// [`Config::hello_origin`], once a server URL or a public origin is set
    /// (`None` before).
    pub fn hello_origin_when_set(&self) -> Option<Result<String>> {
        (self.server_url.is_some() || self.public_origin.is_some()).then(|| self.hello_origin())
    }

    /// The trust this config grants: unset is Relay only (fail closed).
    pub fn configured_trust(&self) -> TrustValue {
        self.trust.unwrap_or(TrustValue::Relay)
    }

    /// The roots file ops are confined to, and where they come from. A Full
    /// node's commands can already do anything as this user, so the home
    /// directory adds no authority; the deny-list keeps wsmp's own state out.
    pub fn effective_file_roots(&self, home: Option<&Path>) -> (Vec<PathBuf>, FileRootsSource) {
        if self.disable_file_tools {
            return (Vec::new(), FileRootsSource::Disabled);
        }
        if !self.file_roots.is_empty() {
            return (self.file_roots.clone(), FileRootsSource::Configured);
        }
        let roots = home
            .and_then(|home| validate_file_roots(&[home.to_path_buf()], None).ok())
            .unwrap_or_default();
        (roots, FileRootsSource::Default)
    }

    /// `wsmp config show`: the config as written, plus the values the relay
    /// derives from it (the file roots and their source, the terminal limit,
    /// the remote update setting, all shown even at their defaults).
    pub fn shown(&self, home: Option<&Path>) -> Result<serde_json::Value> {
        let mut shown = serde_json::to_value(self)?;
        let (roots, source) = self.effective_file_roots(home);
        shown["fileRoots"] = serde_json::to_value(&roots)?;
        shown["fileRootsSource"] = serde_json::to_value(source)?;
        shown["maxTerminals"] = self.effective_max_terminals().into();
        shown["remoteUpdates"] = self.remote_updates.as_str().into();
        Ok(shown)
    }

    /// The node's slug, checked. With none set, one is generated and saved:
    /// under the config lock, after re-reading the file, so a simultaneous
    /// login or config command keeps the slug it wrote. Either way this
    /// config is then the file as saved.
    pub fn ensure_cli_slug(&mut self) -> Result<String> {
        if let Some(slug) = &self.cli_slug {
            validate_slug(slug)?;
            return Ok(slug.clone());
        }
        let _config_lock = ConfigLock::exclusive()?;
        let mut current = Self::load_required()?;
        if let Some(slug) = current.cli_slug.clone() {
            validate_slug(&slug)?;
            *self = current;
            return Ok(slug);
        }
        let slug = crate::slug::generated_slug("cli");
        current.apply(Setting::CliSlug(slug.clone()));
        current.save()?;
        *self = current;
        Ok(slug)
    }
}

/// Browser terminals open at once on one machine when `maxTerminals` is unset.
/// The server applies its own per-CLI and per-user limits too; the lowest wins.
pub const DEFAULT_MAX_TERMINALS: u32 = 4;

/// Accepted `maxTerminals` values (`wsmp config set-max-terminals`).
pub const MAX_TERMINALS_RANGE: std::ops::RangeInclusive<u32> = 1..=32;

/// The current on-disk shape; unknown keys are rejected.
#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct ConfigWire {
    version: u64,
    server_url: Option<String>,
    public_origin: Option<String>,
    cli_slug: Option<String>,
    trust: Option<TrustValue>,
    // Accept and discard a setting written by unreleased 1.0 builds,
    // retaining only a diagnostic for startup and `config show`.
    #[serde(rename = "agentCommands")]
    retired_command_policy_warning: RetiredCommandPolicyWarning,
    runtime_hosts: Vec<String>,
    media_trusted_origins: Vec<String>,
    allow_human_terminal: bool,
    require_terminal_approval: bool,
    max_terminals: Option<u32>,
    terminal_shell: Option<String>,
    allow_file_tools_as_root: bool,
    #[serde(deserialize_with = "deserialize_file_roots")]
    file_roots: Vec<PathBuf>,
    disable_file_tools: bool,
    remote_updates: RemoteUpdates,
}

impl Default for ConfigWire {
    fn default() -> Self {
        let config = Config::default();
        Self {
            version: u64::from(config.version),
            server_url: None,
            public_origin: None,
            cli_slug: None,
            trust: None,
            retired_command_policy_warning: RetiredCommandPolicyWarning::default(),
            runtime_hosts: Vec::new(),
            media_trusted_origins: Vec::new(),
            allow_human_terminal: false,
            require_terminal_approval: false,
            max_terminals: None,
            terminal_shell: None,
            allow_file_tools_as_root: false,
            file_roots: Vec::new(),
            disable_file_tools: false,
            remote_updates: RemoteUpdates::Allowed,
        }
    }
}

#[derive(Default)]
struct RetiredCommandPolicyWarning(Option<&'static str>);

impl<'de> Deserialize<'de> for RetiredCommandPolicyWarning {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Keep accepting any JSON value, just as the accept-and-drop reader did.
        // Never echo an arbitrary config value into a diagnostic.
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(Self(Some(if value.as_str() == Some("isolated") {
            "The agentCommands setting was removed in wsmp 1.0 and is ignored. Agent commands now follow this node's trust level: at Full control they run as this user. Lower trust with `wsmp trust relay` if you relied on isolated."
        } else {
            "The agentCommands setting was removed in wsmp 1.0 and is ignored."
        })))
    }
}

impl<'de> Deserialize<'de> for Config {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ConfigWire::deserialize(deserializer).map_err(|error| {
            if error.to_string().contains("unknown field") {
                serde::de::Error::custom(format!(
                    "{error}; delete that key from the config file before retrying; `wsmp login` also requires a valid config"
                ))
            } else {
                error
            }
        })?;
        if wire.version > u64::from(CONFIG_VERSION) {
            return Err(serde::de::Error::custom(format!(
                "config version {} was written by a newer wsmp; upgrade wsmp to read it",
                wire.version
            )));
        }
        if wire.version == 0 {
            return Err(serde::de::Error::custom(format!(
                "unsupported config version 0; expected 1..={CONFIG_VERSION}"
            )));
        }
        Ok(wire.into())
    }
}

impl From<ConfigWire> for Config {
    fn from(wire: ConfigWire) -> Self {
        Self {
            // 0.4.x preserved earlier version stamps even after saving current keys.
            version: CONFIG_VERSION,
            retired_command_policy_warning: wire.retired_command_policy_warning.0,
            server_url: wire.server_url,
            public_origin: wire.public_origin,
            cli_slug: wire.cli_slug,
            trust: wire.trust,
            runtime_hosts: wire.runtime_hosts,
            media_trusted_origins: wire.media_trusted_origins,
            allow_human_terminal: wire.allow_human_terminal,
            require_terminal_approval: wire.require_terminal_approval,
            max_terminals: wire.max_terminals,
            terminal_shell: wire.terminal_shell,
            allow_file_tools_as_root: wire.allow_file_tools_as_root,
            file_roots: wire.file_roots,
            disable_file_tools: wire.disable_file_tools,
            remote_updates: wire.remote_updates,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            retired_command_policy_warning: None,
            server_url: None,
            public_origin: None,
            cli_slug: None,
            trust: None,
            runtime_hosts: Vec::new(),
            media_trusted_origins: Vec::new(),
            allow_human_terminal: false,
            require_terminal_approval: false,
            max_terminals: None,
            terminal_shell: None,
            allow_file_tools_as_root: false,
            file_roots: Vec::new(),
            disable_file_tools: false,
            remote_updates: RemoteUpdates::Allowed,
        }
    }
}

impl Config {
    /// The browser terminal limit this machine applies: `maxTerminals`, or
    /// [`DEFAULT_MAX_TERMINALS`] when unset.
    pub fn effective_max_terminals(&self) -> u32 {
        self.max_terminals.unwrap_or(DEFAULT_MAX_TERMINALS)
    }

    /// `maxTerminals` is unset or within [`MAX_TERMINALS_RANGE`]; the relay
    /// refuses to start otherwise.
    pub fn validate_max_terminals(&self) -> Result<()> {
        if let Some(count) = self.max_terminals
            && !MAX_TERMINALS_RANGE.contains(&count)
        {
            anyhow::bail!(
                "`maxTerminals` must be an integer from {} to {}",
                MAX_TERMINALS_RANGE.start(),
                MAX_TERMINALS_RANGE.end()
            );
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        validate_file_root_shape(&self.file_roots)?;
        if let Some(origin) = &self.public_origin {
            normalize_public_origin(origin)
                .with_context(|| format!("validating public origin `{origin}`"))?;
        }
        self.validate_max_terminals()?;
        if let Some(slug) = &self.cli_slug {
            validate_slug(slug).with_context(|| format!("validating CLI slug `{slug}`"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::file_roots::MAX_FILE_ROOTS;
    use super::*;

    #[cfg(unix)]
    #[test]
    fn file_grant_config_adversarial_table() {
        let dir = tempfile::tempdir().expect("home");
        let home = std::fs::canonicalize(dir.path()).expect("home");
        let models = home.join("models");
        std::fs::create_dir(&models).expect("models");
        let file = home.join("a-file");
        std::fs::write(&file, "plain").expect("file");
        let alias = home.join("models-alias");
        std::os::unix::fs::symlink(&models, &alias).expect("root alias");
        let good = validate_file_roots(&[PathBuf::from("~/models")], Some(&home)).expect("tilde");
        assert_eq!(good, vec![models.clone()]);
        // Rejected by the UTF-8 check before any filesystem access, so nothing is created
        // (macOS APFS refuses to create such names).
        use std::os::unix::ffi::OsStrExt;
        let non_utf8 = home.join(std::ffi::OsStr::from_bytes(b"non-utf8-\xff"));
        let many: Vec<_> = (0..=MAX_FILE_ROOTS)
            .map(|n| {
                let p = home.join(format!("root-{n}"));
                std::fs::create_dir(&p).expect("root");
                p
            })
            .collect();
        let cases = vec![
            vec![],
            vec![PathBuf::from("models")],
            vec![PathBuf::from("/")],
            vec![home.join("missing")],
            vec![file],
            vec![PathBuf::from("~someone/models")],
            vec![models.clone(), models.clone()],
            vec![models.clone(), alias.clone()],
            vec![home.join("models/../models")],
            many,
            vec![non_utf8],
            vec![PathBuf::from(format!("/{}", "x".repeat(4096)))],
        ];
        for paths in cases {
            assert!(
                validate_file_roots(&paths, Some(&home)).is_err(),
                "{paths:?}"
            );
        }
        assert!(file_roots_usable(&good));
        assert!(!file_roots_usable(&[models, alias]));
        let default: Config = serde_json::from_str("{}").expect("default");
        assert!(default.file_roots.is_empty());
        let sparse = serde_json::to_value(&default).expect("serialize");
        assert!(sparse.get("fileRoots").is_none());
        let enabled = Config {
            file_roots: good,
            ..Config::default()
        };
        let reordered: Config = serde_json::from_str(&format!(
            r#"{{"fileRoots":{},"version":3}}"#,
            serde_json::to_string(&enabled.file_roots).expect("roots")
        ))
        .expect("field order");
        assert_eq!(reordered, enabled);
        let value = serde_json::to_value(&enabled).expect("serialize");
        assert_eq!(
            serde_json::from_value::<Config>(value).expect("roundtrip"),
            enabled
        );
        for text in [
            r#"{"fileRoots":"/tmp"}"#,
            r#"{"fileRoots":[{"path":"/tmp"}]}"#,
            r#"{"fileRoots":[["/tmp"]]}"#,
            r#"{"fileRoots":null}"#,
            r#"{"fileRoots":["relative"]}"#,
            r#"{"fileRoots":["/"]}"#,
            r#"{"fileRoots":["/tmp/../tmp"]}"#,
            r#"{"fileRoots":["/tmp","/tmp/"]}"#,
            r#"{"fileRoots":["/tmp"],"fileRoots":["/tmp"]}"#,
        ] {
            assert!(serde_json::from_str::<Config>(text).is_err(), "{text}");
        }
        assert!(
            serde_json::from_value::<Config>(
                serde_json::json!({"fileRoots":[format!("/{}", "x".repeat(4096))]})
            )
            .is_err()
        );
        // A disappeared directory remains configured intent on disk.
        let missing: Config =
            serde_json::from_value(serde_json::json!({"fileRoots":[home.join("gone")]}))
                .expect("missing root shape");
        assert!(!file_roots_usable(&missing.file_roots));
        assert!(!file_roots_usable(&[]));
    }

    #[test]
    fn current_config_accepts_existing_version_stamps_and_rejects_unknown_keys() {
        for version in 1..=CONFIG_VERSION {
            let config =
                serde_json::from_value::<Config>(serde_json::json!({ "version": version }))
                    .expect("current keys with an earlier stamp");
            assert_eq!(config.version, CONFIG_VERSION);
        }
        for (version, message) in [
            (0, "unsupported config version 0"),
            (u64::from(CONFIG_VERSION) + 1, "written by a newer wsmp"),
            (256, "written by a newer wsmp"),
            (u64::MAX, "written by a newer wsmp"),
        ] {
            let error = serde_json::from_value::<Config>(serde_json::json!({ "version": version }))
                .expect_err("unsupported version");
            assert!(error.to_string().contains(message), "{error}");
        }
        for key in [
            "allowMcpCommands",
            "mcpCommandMode",
            "cliTokenEnv",
            "mcpFileRead",
            "endpoints",
            "unknown",
        ] {
            for version in 1..=CONFIG_VERSION {
                let dir = tempfile::tempdir().expect("dir");
                let path = dir.path().join("config.json");
                std::fs::write(
                    &path,
                    serde_json::json!({ "version": version, key: true }).to_string(),
                )
                .expect("write");
                let error = Config::load_from_path(&path).expect_err("unknown key");
                let message = format!("{error:#}");
                assert!(message.contains(key), "{message}");
                assert!(message.contains(path.to_str().expect("path")), "{message}");
                assert!(message.contains("delete that key"), "{message}");
                assert!(
                    message.contains("`wsmp login` also requires a valid config"),
                    "{message}"
                );
            }
        }
        let relay: Config =
            serde_json::from_value(serde_json::json!({ "trust": "relay" })).expect("trust relay");
        assert_eq!(relay.trust, Some(TrustValue::Relay));
        assert_eq!(
            serde_json::to_value(&relay).expect("serialize")["trust"],
            "relay"
        );
        assert!(serde_json::from_value::<Config>(serde_json::json!({ "trust": "root" })).is_err());
    }

    #[test]
    fn retired_command_policy_is_ignored_on_load_and_dropped_on_save() {
        for mode in ["standard", "isolated"] {
            let dir = tempfile::tempdir().expect("dir");
            let path = dir.path().join("config.json");
            std::fs::write(
                &path,
                serde_json::json!({
                    "agentCommands": mode,
                    "trust": "relay",
                    "requireTerminalApproval": true,
                })
                .to_string(),
            )
            .expect("write");
            let mut config = Config::load_from_path(&path).expect("load prerelease config");
            let warning = config.retired_command_policy_warning.expect("load warning");
            assert!(
                warning.starts_with(
                    "The agentCommands setting was removed in wsmp 1.0 and is ignored."
                )
            );
            assert_eq!(warning.contains("wsmp trust relay"), mode == "isolated");
            // The diagnostic is the only in-memory difference.
            config.retired_command_policy_warning = None;
            assert_eq!(
                config,
                Config {
                    trust: Some(TrustValue::Relay),
                    require_terminal_approval: true,
                    ..Config::default()
                }
            );
            config.retired_command_policy_warning = Some(warning);
            config.save_to_path(path.clone()).expect("save");
            let saved: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).expect("read"))
                    .expect("saved json");
            assert!(saved.get("agentCommands").is_none());
            assert!(saved.get("retiredCommandPolicyWarning").is_none());
            config.retired_command_policy_warning = None;
            assert_eq!(Config::load_from_path(&path).expect("reload"), config);
        }
    }

    #[test]
    fn retired_command_policy_accepts_other_json_values_without_echoing_them() {
        for value in [
            serde_json::Value::Null,
            serde_json::json!(false),
            serde_json::json!(42),
            serde_json::json!(["unrecognized"]),
            serde_json::json!({ "unrecognized": true }),
            serde_json::json!("unrecognized\nvalue"),
        ] {
            let config: Config =
                serde_json::from_value(serde_json::json!({ "agentCommands": value }))
                    .expect("accept and drop any retired value");
            assert_eq!(
                config.retired_command_policy_warning,
                Some("The agentCommands setting was removed in wsmp 1.0 and is ignored.")
            );
            assert_eq!(
                serde_json::to_value(config).expect("serialize"),
                serde_json::to_value(Config::default()).expect("default")
            );
        }
        assert!(Config::default().retired_command_policy_warning.is_none());
        assert!(
            serde_json::from_str::<Config>("{}")
                .expect("no retired key")
                .retired_command_policy_warning
                .is_none()
        );
    }

    #[test]
    fn a_0_4_3_config_with_version_1_preserves_settings_and_saves_version_3() {
        let text = include_str!("../../tests/fixtures/upgrade-0.4.3/config-version-1.json");
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("config.json");
        std::fs::write(&path, text).expect("write");
        let config = Config::load_from_path(&path).expect("load");
        assert_eq!(config.version, CONFIG_VERSION);
        assert_eq!(config.trust, Some(TrustValue::Relay));
        assert!(config.require_terminal_approval);
        assert_eq!(config.max_terminals, Some(2));
        assert_eq!(config.remote_updates, RemoteUpdates::Off);
        config.save_to_path(path.clone()).expect("save");
        let mut expected: serde_json::Value = serde_json::from_str(text).expect("fixture");
        expected["version"] = serde_json::json!(CONFIG_VERSION);
        let actual: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read"))
                .expect("saved json");
        // Serialization omits false switches; compare the complete typed settings.
        assert_eq!(Config::load_from_path(&path).expect("reload"), config);
        assert_eq!(
            serde_json::from_value::<Config>(expected).expect("expected"),
            config
        );
        assert_eq!(actual["version"], CONFIG_VERSION);
    }

    #[test]
    fn round_trips_json_config() {
        let cfg = Config {
            server_url: Some("https://example.test".to_string()),
            cli_slug: Some("desk-01".to_string()),
            runtime_hosts: vec!["10.0.0.5:8000".to_string()],
            ..Config::default()
        };
        let text = serde_json::to_string_pretty(&cfg).expect("serialize");
        let parsed: Config = serde_json::from_str(&text).expect("parse");
        assert_eq!(parsed, cfg);
    }
}
