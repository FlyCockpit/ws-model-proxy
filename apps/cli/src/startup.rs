//! Daemon-lifetime terminal key, identity key, trust and features.
//!
//! `connect_foreground` captures this before the reconnect loop. Trust comes
//! from `config.json` `trust` (unset: Relay only). The daemon changes it only
//! through [`TerminalStartup::lower_trust`] (any lowering) and
//! [`TerminalStartup::raise_trust`] (after `wsmp trust full` passed the
//! control socket's peer check). Relay only refuses commands, file ops,
//! browser terminals and runtime definitions on this node.

use anyhow::{Context, Result};

use crate::config::Config;
use crate::protocol::frames::{HelloNode, NodeTerminalIdentity, TrustState, TrustValue};
use crate::protocol::runtime_spec::{
    CommandShell, FileFeatures, LaunchFeatures, Management, NodeFeatures, NodePlatform,
    TerminalFeatures,
};
use crate::terminal_crypto::CliTerminalKey;
use crate::terminal_identity::{self, CliIdentity};

pub struct TerminalStartup {
    key: CliTerminalKey,
    /// Persistent identity from `terminal-identity.json`. `None` only in tests;
    /// production startup refuses to connect without a loadable identity.
    identity: Option<CliIdentity>,
    allow_human_terminal: bool,
    /// Full control until lowered; a lowering latches for the daemon's life.
    full: std::sync::atomic::AtomicBool,
    require_terminal_approval: bool,
    max_terminals: usize,
    allow_file_tools_as_root: bool,
    file_roots: Vec<std::path::PathBuf>,
    file_roots_configured: bool,
    file_roots_source: crate::config::FileRootsSource,
    /// `config.json` `runtimeHosts`, re-read on hot reload.
    runtime_hosts: std::sync::Mutex<Vec<String>>,
    /// The shells a browser terminal may start, the default first (none on
    /// Unix: the login shell). Found once, as the relay starts.
    shells: Vec<crate::shells::Shell>,
}

impl TerminalStartup {
    pub fn capture(config: &Config) -> Result<Self> {
        let startup = Self::from_key(CliTerminalKey::generate()?, config);
        let state_dir = crate::paths::state_dir().context("determining the state directory")?;
        let identity = terminal_identity::load_or_create(&state_dir)
            .context("loading the CLI identity key")?;
        tracing::info!(
            fingerprint = %identity.fingerprint(),
            "loaded the CLI identity key"
        );
        Ok(startup.with_identity(identity))
    }

    pub fn from_key(key: CliTerminalKey, config: &Config) -> Self {
        Self::from_key_with_home(key, config, dirs::home_dir().as_deref())
    }

    /// [`Self::from_key`] with an explicit home directory (the default root).
    pub fn from_key_with_home(
        key: CliTerminalKey,
        config: &Config,
        home: Option<&std::path::Path>,
    ) -> Self {
        let (file_roots, file_roots_source) = crate::config::effective_file_roots(config, home);
        Self {
            key,
            identity: None,
            allow_human_terminal: config.allow_human_terminal,
            full: std::sync::atomic::AtomicBool::new(
                crate::trust::at_startup(config) == TrustValue::Full,
            ),
            require_terminal_approval: config.require_terminal_approval,
            max_terminals: usize::try_from(config.effective_max_terminals()).unwrap_or(usize::MAX),
            allow_file_tools_as_root: config.allow_file_tools_as_root,
            file_roots_configured: crate::config::file_roots_usable(&file_roots),
            file_roots,
            file_roots_source,
            runtime_hosts: std::sync::Mutex::new(config.runtime_hosts.clone()),
            shells: crate::shells::discover(config.terminal_shell.as_deref()),
        }
    }

    pub fn with_identity(mut self, identity: CliIdentity) -> Self {
        self.identity = Some(identity);
        self
    }

    pub fn key(&self) -> &CliTerminalKey {
        &self.key
    }

    pub fn identity(&self) -> Option<&CliIdentity> {
        self.identity.as_ref()
    }

    pub fn allow_human_terminal(&self) -> bool {
        self.allow_human_terminal
    }

    /// The node's trust for this daemon's lifetime.
    pub fn trust_value(&self) -> TrustValue {
        if self.full_control() {
            TrustValue::Full
        } else {
            TrustValue::Relay
        }
    }

    /// Relay only from now on. Returns whether trust changed.
    pub fn lower_trust(&self) -> bool {
        self.full.swap(false, std::sync::atomic::Ordering::SeqCst)
    }

    /// Full control again: only after `wsmp trust full` passed the control
    /// socket's peer check and was persisted. Returns whether trust changed.
    pub fn raise_trust(&self) -> bool {
        !self.full.swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    pub fn runtime_hosts(&self) -> Vec<String> {
        self.runtime_hosts
            .lock()
            .map(|hosts| hosts.clone())
            .unwrap_or_default()
    }

    pub fn set_runtime_hosts(&self, hosts: Vec<String>) {
        if let Ok(mut current) = self.runtime_hosts.lock() {
            *current = hosts;
        }
    }

    /// Full control: definitions, commands, file ops and browser terminals.
    pub fn full_control(&self) -> bool {
        self.full.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The hello / `node.state` trust: frozen exactly at Relay only.
    pub fn trust(&self) -> TrustState {
        let value = self.trust_value();
        TrustState {
            value,
            frozen: value == TrustValue::Relay,
        }
    }

    pub fn require_terminal_approval(&self) -> bool {
        self.require_terminal_approval
    }

    /// The shell a browser terminal starts: `id`, or the default when `None`.
    /// `None` for an id this node did not advertise, and on Unix, where
    /// terminals run the login shell.
    pub fn shell(&self, id: Option<&str>) -> Option<&crate::shells::Shell> {
        match id {
            Some(id) => self.shells.iter().find(|shell| shell.id == id),
            None => self.shells.first(),
        }
    }

    /// Browser terminals this machine keeps open at once (`maxTerminals`).
    pub fn max_terminals(&self) -> usize {
        self.max_terminals
    }

    /// `allowFileToolsAsRoot` as it was when the relay started.
    pub fn allow_file_tools_as_root(&self) -> bool {
        self.allow_file_tools_as_root
    }

    pub fn file_roots(&self) -> &[std::path::PathBuf] {
        &self.file_roots
    }

    /// What this node offers (the hello `features`).
    pub fn features(&self) -> NodeFeatures {
        NodeFeatures {
            terminals: TerminalFeatures {
                supported: crate::protocol::terminal_supported() && self.allow_human_terminal,
                max: u8::try_from(self.max_terminals).unwrap_or(u8::MAX),
                approval_required: self.require_terminal_approval,
                shells: self.shells.iter().map(|shell| shell.id.clone()).collect(),
            },
            // Interactive runtime steps run in operator terminals wherever a
            // PTY can be offered, at every trust level (spec §4.7).
            operator_terminals: crate::protocol::operator_terminals_supported(),
            files: FileFeatures {
                // As the tools take and show paths (Windows: `/c/...`), so the
                // server's own root check matches what the node resolves.
                roots: self.file_roots_configured.then(|| {
                    self.file_roots
                        .iter()
                        .filter_map(|root| crate::file_ops::display_path(root))
                        .collect()
                }),
                as_root: self.allow_file_tools_as_root,
                source: self.file_roots_source,
            },
            runtime_hosts: self.runtime_hosts(),
            media_expand: true,
            live_stt: true,
            job_reservations: true,
            rank_idle: true,
            launch: self.launch_features(),
            secrets: crate::secrets::entries(),
        }
    }

    /// What runtime launches can run here. Linux runs processes in systemd units and Windows in
    /// runtime hosts, and both wrap services; macOS only wraps services (their status commands
    /// prove them). Unix text commands run in `sh`; Windows in the shells it found (never a WSL
    /// distribution).
    fn launch_features(&self) -> Option<LaunchFeatures> {
        let platform = NodePlatform::current()?;
        let management = match platform {
            NodePlatform::Linux => vec![Management::Process, Management::Service],
            NodePlatform::Macos => vec![Management::Service],
            NodePlatform::Windows => vec![Management::Process, Management::Service],
        };
        let shells = if cfg!(windows) {
            self.shells
                .iter()
                .filter_map(|shell| match shell.id.as_str() {
                    "pwsh" => Some(CommandShell::Pwsh),
                    "powershell" => Some(CommandShell::Powershell),
                    "cmd" => Some(CommandShell::Cmd),
                    _ => None,
                })
                .collect()
        } else {
            vec![CommandShell::Sh]
        };
        Some(LaunchFeatures {
            platform,
            management,
            shells,
        })
    }

    /// The hello `node`: `identity_signature` signs the challenge, and the
    /// terminal identity proves this session's ECDH key.
    pub fn hello_node(&self, node_slug: &str, identity_signature: String) -> HelloNode {
        let terminal_identity = self.identity.as_ref().and_then(|identity| {
            identity
                .prove(node_slug, self.key.public_raw())
                .inspect_err(|error| {
                    tracing::warn!(error = %error, "signing the terminal key failed");
                })
                .ok()
                .map(|proof| NodeTerminalIdentity {
                    public_key: proof.public_key,
                    signature: proof.signature,
                })
        });
        HelloNode {
            slug: node_slug.to_string(),
            hostname: crate::hostname::reported_hostname(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            identity_public_key: self
                .identity
                .as_ref()
                .map(CliIdentity::public_b64url)
                .unwrap_or_default(),
            identity_signature,
            terminal_public_key: self.key.public_b64url().to_string(),
            terminal_identity,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> CliTerminalKey {
        CliTerminalKey::generate().expect("key")
    }

    #[test]
    fn features_ignore_config_changes_after_startup() {
        let dir = tempfile::tempdir().expect("roots");
        let mut config = Config {
            file_roots: vec![dir.path().to_path_buf()],
            allow_human_terminal: true,
            trust: Some(TrustValue::Full),
            require_terminal_approval: true,
            allow_file_tools_as_root: true,
            ..Config::default()
        };
        let startup = TerminalStartup::capture(&config).expect("startup");
        config.allow_human_terminal = false;
        config.trust = Some(TrustValue::Relay);
        config.file_roots.clear();
        let features = startup.features();
        assert!(features.terminals.supported);
        // Windows names its shells, the default first; Unix runs the login
        // shell and names none.
        assert_eq!(features.terminals.shells.is_empty(), cfg!(unix));
        if cfg!(windows) {
            let default = startup.shell(None).expect("a default shell");
            assert_eq!(features.terminals.shells[0], default.id);
            assert!(startup.shell(Some("cmd")).is_some());
        }
        assert!(startup.shell(Some("not-a-shell")).is_none());
        assert!(features.terminals.approval_required);
        assert_eq!(features.terminals.max, 4);
        assert_eq!(
            features.files.roots,
            Some(vec![
                crate::file_ops::display_path(dir.path()).expect("shown")
            ])
        );
        assert!(features.files.as_root);
        // Operator terminals need only a PTY (ConPTY on Windows): no switch, any trust level.
        assert!(features.operator_terminals);
        assert!(features.job_reservations);
        assert!(features.rank_idle);
        assert!(startup.full_control());
        assert_eq!(
            startup.trust(),
            TrustState {
                value: TrustValue::Full,
                frozen: false
            }
        );
        assert!(startup.identity().is_some());
    }

    #[test]
    fn unset_or_relay_trust_is_relay_only_and_frozen_and_only_raise_goes_up() {
        for trust in [None, Some(TrustValue::Relay)] {
            let config = Config {
                trust,
                ..Config::default()
            };
            let startup = TerminalStartup::from_key(key(), &config);
            assert!(!startup.full_control());
            let trust = startup.trust();
            assert_eq!(trust.value, TrustValue::Relay);
            assert!(trust.frozen);
            assert!(trust.validate().is_ok());
            assert!(!startup.lower_trust());
            assert!(startup.raise_trust());
            assert!(startup.full_control());
            assert!(startup.lower_trust());
            assert!(!startup.full_control());
        }
    }

    #[test]
    fn broken_roots_are_not_reported() {
        let dir = tempfile::tempdir().expect("dir");
        let config = Config {
            file_roots: vec![dir.path().join("missing")],
            ..Config::default()
        };
        let startup = TerminalStartup::from_key(key(), &config);
        assert_eq!(startup.features().files.roots, None);
        assert_eq!(startup.file_roots(), config.file_roots);
    }

    #[test]
    fn file_roots_default_to_home_and_say_where_they_come_from() {
        use crate::config::FileRootsSource;
        let home = tempfile::tempdir().expect("home");
        let physical = std::fs::canonicalize(home.path()).expect("physical home");
        let startup =
            TerminalStartup::from_key_with_home(key(), &Config::default(), Some(home.path()));
        let files = startup.features().files;
        assert_eq!(files.source, FileRootsSource::Default);
        // As the file tools show paths: as is on Unix, `/c/...` on Windows.
        assert_eq!(
            files.roots,
            Some(vec![
                crate::file_ops::display_path(&physical).expect("shown")
            ])
        );
        assert_eq!(startup.file_roots(), [physical]);

        let configured_dir = tempfile::tempdir().expect("configured");
        let configured = Config {
            file_roots: vec![configured_dir.path().to_path_buf()],
            ..Config::default()
        };
        let startup = TerminalStartup::from_key_with_home(key(), &configured, Some(home.path()));
        assert_eq!(startup.features().files.source, FileRootsSource::Configured);
        assert_eq!(startup.file_roots(), configured.file_roots);

        // Off wins over configured roots, and no home means no default roots.
        let off = Config {
            disable_file_tools: true,
            ..configured
        };
        let startup = TerminalStartup::from_key_with_home(key(), &off, Some(home.path()));
        assert_eq!(startup.features().files.source, FileRootsSource::Disabled);
        assert_eq!(startup.features().files.roots, None);
        assert!(startup.file_roots().is_empty());
        let homeless = TerminalStartup::from_key_with_home(key(), &Config::default(), None);
        assert_eq!(homeless.features().files.roots, None);
        assert_eq!(homeless.features().files.source, FileRootsSource::Default);
    }

    #[test]
    fn the_terminal_limit_is_the_configured_one_or_four() {
        assert_eq!(
            TerminalStartup::from_key(key(), &Config::default()).max_terminals(),
            4
        );
        let config = Config {
            max_terminals: Some(9),
            ..Config::default()
        };
        assert_eq!(TerminalStartup::from_key(key(), &config).max_terminals(), 9);
    }

    #[test]
    fn the_hello_node_carries_a_signature_over_the_ecdh_key_and_slug() {
        use crate::terminal_crypto::{decode_exact, decode_public_key, verify_cli_identity};

        let config = Config::default();
        let without = TerminalStartup::from_key(key(), &config);
        assert!(
            without
                .hello_node("desk-01", String::new())
                .terminal_identity
                .is_none()
        );
        let identity = CliIdentity::from_scalar_bytes(&[7_u8; 32]).expect("identity");
        let startup = without.with_identity(identity);
        let node = startup.hello_node("desk-01", "sig".to_string());
        assert_eq!(node.slug, "desk-01");
        assert_eq!(node.identity_signature, "sig");
        assert_eq!(node.terminal_public_key, startup.key().public_b64url());
        let proof = node.terminal_identity.expect("proof");
        let public = decode_public_key(&proof.public_key).expect("public");
        let signature = decode_exact(&proof.signature, 64).expect("signature");
        assert!(verify_cli_identity(
            &public,
            &signature,
            "desk-01",
            startup.key().public_raw()
        ));
        assert!(!verify_cli_identity(
            &public,
            &signature,
            "desk-02",
            startup.key().public_raw()
        ));
    }
}
