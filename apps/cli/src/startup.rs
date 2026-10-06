//! Daemon-lifetime terminal key, identity key, trust and features.
//!
//! `connect_foreground` captures this before the reconnect loop. Config is
//! re-read on reconnect; that must not change the key, the trust or these
//! features (hot reload with `node.state` lands with config v3, C1).
//!
//! S0 trust bridge: until `config.json` v3 carries `trust` (C1), the node is
//! at Full control exactly when the old most permissive switch is set
//! (`mcpCommandMode: unsupervised`, which allowed headless commands and file
//! ops); every other config is Relay only. Relay only refuses commands, file
//! ops, browser terminals and runtime definitions on this node.

use anyhow::{Context, Result};

use crate::config::{Config, McpCommandMode};
use crate::protocol::frames::{HelloNode, NodeTerminalIdentity, TrustState, TrustValue};
use crate::protocol::runtime_spec::{FileFeatures, NodeFeatures, TerminalFeatures};
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
        Self {
            key,
            identity: None,
            allow_human_terminal: config.allow_human_terminal,
            full: std::sync::atomic::AtomicBool::new(
                config.mcp_command_mode == McpCommandMode::Unsupervised,
            ),
            require_terminal_approval: config.require_terminal_approval,
            max_terminals: usize::try_from(config.effective_max_terminals()).unwrap_or(usize::MAX),
            allow_file_tools_as_root: config.allow_file_tools_as_root,
            file_roots: config.file_roots.clone(),
            file_roots_configured: crate::config::file_roots_usable(&config.file_roots),
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

    /// `trust.lower`: Relay only from now on. There is no way back up here.
    pub fn lower_trust(&self) {
        self.full.store(false, std::sync::atomic::Ordering::SeqCst);
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
            },
            // Operator terminals run interactive steps of runtime jobs, which
            // land with the runtime store (C2/C3).
            operator_terminals: false,
            files: FileFeatures {
                roots: self.file_roots_configured.then(|| {
                    self.file_roots
                        .iter()
                        .map(|root| root.display().to_string())
                        .collect()
                }),
                as_root: self.allow_file_tools_as_root,
            },
            runtime_hosts: Vec::new(),
            media_expand: true,
            live_stt: true,
            // Node secrets (`secrets.env`) land with config v3 (C1).
            secrets: Vec::new(),
        }
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
            mcp_command_mode: McpCommandMode::Unsupervised,
            require_terminal_approval: true,
            allow_file_tools_as_root: true,
            ..Config::default()
        };
        let startup = TerminalStartup::capture(&config).expect("startup");
        config.allow_human_terminal = false;
        config.mcp_command_mode = McpCommandMode::Off;
        config.file_roots.clear();
        let features = startup.features();
        assert_eq!(features.terminals.supported, cfg!(unix));
        assert!(features.terminals.approval_required);
        assert_eq!(features.terminals.max, 4);
        assert_eq!(
            features.files.roots,
            Some(vec![dir.path().display().to_string()])
        );
        assert!(features.files.as_root);
        assert!(!features.operator_terminals);
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
    fn anything_but_unsupervised_is_relay_only_and_frozen() {
        for mode in [McpCommandMode::Off, McpCommandMode::Supervised] {
            let config = Config {
                mcp_command_mode: mode,
                ..Config::default()
            };
            let startup = TerminalStartup::from_key(key(), &config);
            assert!(!startup.full_control());
            let trust = startup.trust();
            assert_eq!(trust.value, TrustValue::Relay);
            assert!(trust.frozen);
            assert!(trust.validate().is_ok());
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
