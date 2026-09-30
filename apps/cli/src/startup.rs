//! Daemon-lifetime terminal key, identity key, and feature flags.
//!
//! `connect_foreground` captures this before the reconnect loop. Config is
//! re-read on reconnect and when an inventory reload is acknowledged; those
//! replacements must not change the key or these flags.

use anyhow::Result;

use crate::config::{Config, McpCommandMode};
use crate::protocol::{CliCapabilities, TerminalFeatureSnapshot};
use crate::terminal_crypto::CliTerminalKey;
use crate::terminal_identity::{self, CliIdentity};

pub struct TerminalStartup {
    key: CliTerminalKey,
    /// Persistent identity from `terminal-identity.json`. `None` when it could
    /// not be loaded; browsers then refuse this CLI's terminals.
    identity: Option<CliIdentity>,
    allow_human_terminal: bool,
    mcp_command_mode: McpCommandMode,
    require_terminal_approval: bool,
    allow_file_tools_as_root: bool,
    mcp_file_read: bool,
    file_roots: Vec<std::path::PathBuf>,
    file_roots_configured: bool,
    allow_remote_metric_sources: bool,
}

impl TerminalStartup {
    pub fn capture(config: &Config) -> Result<Self> {
        let startup = Self::from_key(CliTerminalKey::generate()?, config);
        let identity = crate::paths::state_dir()
            .and_then(|state_dir| terminal_identity::load_or_create(&state_dir));
        Ok(match identity {
            Ok(identity) => {
                tracing::info!(
                    fingerprint = %identity.fingerprint(),
                    "loaded the terminal identity key"
                );
                startup.with_identity(identity)
            }
            Err(error) => {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    "terminal identity key is unavailable; browsers will refuse terminals"
                );
                startup
            }
        })
    }

    pub fn from_key(key: CliTerminalKey, config: &Config) -> Self {
        Self {
            key,
            identity: None,
            allow_human_terminal: config.allow_human_terminal,
            mcp_command_mode: config.mcp_command_mode,
            require_terminal_approval: config.require_terminal_approval,
            allow_file_tools_as_root: config.allow_file_tools_as_root,
            mcp_file_read: config.mcp_file_read,
            file_roots: config.file_roots.clone(),
            file_roots_configured: crate::config::file_roots_usable(&config.file_roots),
            allow_remote_metric_sources: config.allow_remote_metric_sources,
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

    pub fn mcp_command_mode(&self) -> McpCommandMode {
        self.mcp_command_mode
    }

    pub fn require_terminal_approval(&self) -> bool {
        self.require_terminal_approval
    }

    /// `allowFileToolsAsRoot` as it was when the relay started.
    pub fn allow_file_tools_as_root(&self) -> bool {
        self.allow_file_tools_as_root
    }

    pub fn mcp_file_read(&self) -> bool {
        self.mcp_file_read
    }
    pub fn file_roots(&self) -> &[std::path::PathBuf] {
        &self.file_roots
    }
    /// The local remote-metric-source opt-in, fixed for the daemon's lifetime.
    pub fn allow_remote_metric_sources(&self) -> bool {
        self.allow_remote_metric_sources
    }

    /// `cli_slug` is the slug this hello reports; the identity signs it with
    /// the ECDH key.
    pub fn capabilities(&self, cli_slug: &str) -> CliCapabilities {
        let terminal_identity = self.identity.as_ref().and_then(|identity| {
            identity
                .prove(cli_slug, self.key.public_raw())
                .inspect_err(|error| {
                    tracing::warn!(error = %error, "signing the terminal key failed");
                })
                .ok()
        });
        CliCapabilities::from_snapshot(&TerminalFeatureSnapshot {
            allow_human_terminal: self.allow_human_terminal,
            mcp_command_mode: self.mcp_command_mode,
            require_terminal_approval: self.require_terminal_approval,
            allow_file_tools_as_root: self.allow_file_tools_as_root,
            mcp_file_read: self.mcp_file_read,
            file_roots_configured: self.file_roots_configured,
            allow_remote_metric_sources: self.allow_remote_metric_sources,
            terminal_public_key_b64url: self.key.public_b64url().to_string(),
            terminal_identity,
        })
    }
}

/// Hello capabilities always come from the startup snapshot, never the live config.
pub fn hello_capabilities(
    startup: &TerminalStartup,
    _live: &Config,
    cli_slug: &str,
) -> CliCapabilities {
    startup.capabilities(cli_slug)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_ignore_config_changes_after_startup() {
        let dir = tempfile::tempdir().expect("roots");
        let mut config = Config {
            mcp_file_read: true,
            file_roots: vec![dir.path().to_path_buf()],
            allow_human_terminal: true,
            mcp_command_mode: McpCommandMode::Unsupervised,
            require_terminal_approval: true,
            allow_file_tools_as_root: true,
            allow_remote_metric_sources: true,
            ..Config::default()
        };
        let startup = TerminalStartup::capture(&config).expect("startup");
        let public_key = startup.key().public_b64url().to_string();
        config.allow_human_terminal = false;
        config.mcp_command_mode = McpCommandMode::Off;
        config.require_terminal_approval = false;
        config.allow_file_tools_as_root = false;
        config.mcp_file_read = false;
        config.file_roots.clear();
        config.allow_remote_metric_sources = false;
        let capabilities = hello_capabilities(&startup, &config, "desk-01");
        assert!(capabilities.features.human_terminal);
        assert!(
            capabilities.features.remote_metric_sources,
            "the opt-in is read once at startup"
        );
        assert!(
            !TerminalStartup::from_key(
                CliTerminalKey::generate().expect("key"),
                &Config::default()
            )
            .capabilities("desk-01")
            .features
            .remote_metric_sources,
            "off by default"
        );
        assert_eq!(
            capabilities.features.mcp_command_mode,
            McpCommandMode::Unsupervised
        );
        assert!(capabilities.features.terminal_approval);
        assert_eq!(capabilities.features.terminal_supported, cfg!(unix));
        assert_eq!(capabilities.terminal_public_key, public_key);
        assert!(capabilities.terminal);
        assert!(capabilities.exec);
        assert_eq!(capabilities.protocol_version, "2.8");
        assert!(capabilities.file_ops);
        assert!(capabilities.features.mcp_file_read);
        assert!(startup.mcp_file_read());
        assert_eq!(startup.file_roots(), &[dir.path().to_path_buf()]);
        assert!(capabilities.features.file_roots_configured);
        assert!(capabilities.features.allow_file_tools_as_root);
        assert!(capabilities.terminal_viewers);
        assert!(capabilities.supervised_commands);
    }

    #[test]
    fn broken_roots_are_not_reported_as_configured() {
        let dir = tempfile::tempdir().expect("dir");
        let config = Config {
            mcp_file_read: true,
            file_roots: vec![dir.path().join("missing")],
            ..Config::default()
        };
        let startup = TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config);
        assert!(
            !startup
                .capabilities("test-cli")
                .features
                .file_roots_configured
        );
        assert_eq!(startup.file_roots(), config.file_roots);
        assert!(
            !TerminalStartup::from_key(
                CliTerminalKey::generate().expect("key"),
                &Config::default()
            )
            .capabilities("test-cli")
            .features
            .mcp_file_read
        );
    }

    #[test]
    fn capabilities_carry_a_signature_over_the_ecdh_key_and_slug() {
        use crate::terminal_crypto::{decode_exact, decode_public_key, verify_cli_identity};

        let config = Config::default();
        let without = TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config);
        assert!(without.capabilities("desk-01").terminal_identity.is_none());
        let identity = CliIdentity::from_scalar_bytes(&[7_u8; 32]).expect("identity");
        let fingerprint = identity.fingerprint();
        let startup = without.with_identity(identity);
        assert_eq!(
            startup.identity().map(CliIdentity::fingerprint),
            Some(fingerprint)
        );
        let proof = startup
            .capabilities("desk-01")
            .terminal_identity
            .expect("proof");
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
