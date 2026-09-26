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
        let mut config = Config {
            allow_human_terminal: true,
            mcp_command_mode: McpCommandMode::Unsupervised,
            require_terminal_approval: true,
            ..Config::default()
        };
        let startup = TerminalStartup::capture(&config).expect("startup");
        let public_key = startup.key().public_b64url().to_string();
        config.allow_human_terminal = false;
        config.mcp_command_mode = McpCommandMode::Off;
        config.require_terminal_approval = false;
        let capabilities = hello_capabilities(&startup, &config, "desk-01");
        assert!(capabilities.features.human_terminal);
        assert_eq!(
            capabilities.features.mcp_command_mode,
            McpCommandMode::Unsupervised
        );
        assert!(capabilities.features.terminal_approval);
        assert_eq!(capabilities.features.terminal_supported, cfg!(unix));
        assert_eq!(capabilities.terminal_public_key, public_key);
        assert!(capabilities.terminal);
        assert!(capabilities.exec);
        assert_eq!(capabilities.protocol_version, "2.6");
        assert!(capabilities.terminal_viewers);
        assert!(capabilities.supervised_commands);
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
