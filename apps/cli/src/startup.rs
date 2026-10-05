//! Daemon-lifetime terminal key, identity key, and feature flags.
//!
//! `connect_foreground` captures this before the reconnect loop. Config is
//! re-read on reconnect and when an inventory reload is acknowledged; those
//! replacements must not change the key or these flags.

use anyhow::{Context, Result};

use crate::config::{Config, McpCommandMode};
use crate::protocol::{CliCapabilities, TerminalFeatureSnapshot};
use crate::terminal_crypto::CliTerminalKey;
use crate::terminal_identity::{self, CliIdentity};

pub struct TerminalStartup {
    key: CliTerminalKey,
    /// Persistent identity from `terminal-identity.json`. `None` only in tests;
    /// production startup refuses to connect without a loadable identity.
    identity: Option<CliIdentity>,
    allow_human_terminal: bool,
    mcp_command_mode: McpCommandMode,
    require_terminal_approval: bool,
    allow_file_tools_as_root: bool,
    mcp_file_read: bool,
    file_roots: Vec<std::path::PathBuf>,
    file_roots_configured: bool,
    allow_remote_metric_sources: bool,
    allow_remote_engine_adapters: bool,
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
            mcp_command_mode: config.mcp_command_mode,
            require_terminal_approval: config.require_terminal_approval,
            allow_file_tools_as_root: config.allow_file_tools_as_root,
            mcp_file_read: config.mcp_file_read,
            file_roots: config.file_roots.clone(),
            file_roots_configured: crate::config::file_roots_usable(&config.file_roots),
            allow_remote_metric_sources: config.allow_remote_metric_sources,
            allow_remote_engine_adapters: config.allow_remote_engine_adapters,
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

    pub fn allow_remote_engine_adapters(&self) -> bool {
        self.allow_remote_engine_adapters
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
            allow_remote_engine_adapters: self.allow_remote_engine_adapters,
            terminal_public_key_b64url: self.key.public_b64url().to_string(),
            terminal_identity,
        })
    }
}

/// Terminal grants remain startup-scoped; deployment opt-in is reported fresh.
pub fn hello_capabilities(
    startup: &TerminalStartup,
    live: &Config,
    cli_slug: &str,
) -> CliCapabilities {
    let mut capabilities = startup.capabilities(cli_slug);
    capabilities.features.deployments = live.allow_deployments;
    // Interactive deployment steps run in an operator terminal: only with
    // both local opt-ins and a PTY.
    capabilities.features.deployment_operator = live.allow_deployments
        && live.allow_deployment_operator_terminal
        && crate::protocol::terminal_supported();
    capabilities
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
            allow_remote_engine_adapters: true,
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
        config.allow_remote_engine_adapters = false;
        let capabilities = hello_capabilities(&startup, &config, "desk-01");
        assert!(!capabilities.features.deployments);
        config.allow_deployments = true;
        assert!(
            hello_capabilities(&startup, &config, "desk-01")
                .features
                .deployments
        );
        // Operator terminals need deployments, their own switch and a PTY.
        assert!(!capabilities.features.deployment_operator);
        assert!(
            !hello_capabilities(&startup, &config, "desk-01")
                .features
                .deployment_operator,
            "deployments alone do not enable operator terminals"
        );
        config.allow_deployment_operator_terminal = true;
        assert_eq!(
            hello_capabilities(&startup, &config, "desk-01")
                .features
                .deployment_operator,
            crate::protocol::terminal_supported()
        );
        config.allow_deployments = false;
        assert!(
            !hello_capabilities(&startup, &config, "desk-01")
                .features
                .deployment_operator
        );
        config.allow_deployments = true;
        assert!(capabilities.features.human_terminal);
        assert!(
            capabilities.features.remote_metric_sources,
            "the opt-in is read once at startup"
        );
        assert!(
            capabilities.features.remote_engine_adapters,
            "adapter opt-in is read once at startup"
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
        assert!(capabilities.features.mcp_file_read);
        assert!(startup.mcp_file_read());
        assert_eq!(startup.file_roots(), &[dir.path().to_path_buf()]);
        assert!(capabilities.features.file_roots_configured);
        assert!(capabilities.features.allow_file_tools_as_root);
        assert!(startup.identity().is_some());
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
