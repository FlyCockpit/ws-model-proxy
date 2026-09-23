//! Daemon-lifetime terminal key and feature flags.
//!
//! `connect_foreground` captures this before the reconnect loop. Config is
//! re-read on reconnect and when an inventory reload is acknowledged; those
//! replacements must not change the key or these flags.

use anyhow::Result;

use crate::config::Config;
use crate::protocol::{CliCapabilities, TerminalFeatureSnapshot};
use crate::terminal_crypto::CliTerminalKey;

pub struct TerminalStartup {
    key: CliTerminalKey,
    allow_human_terminal: bool,
    allow_mcp_commands: bool,
    require_terminal_approval: bool,
}

impl TerminalStartup {
    pub fn capture(config: &Config) -> Result<Self> {
        Ok(Self::from_key(CliTerminalKey::generate()?, config))
    }

    pub fn from_key(key: CliTerminalKey, config: &Config) -> Self {
        Self {
            key,
            allow_human_terminal: config.allow_human_terminal,
            allow_mcp_commands: config.allow_mcp_commands,
            require_terminal_approval: config.require_terminal_approval,
        }
    }

    pub fn key(&self) -> &CliTerminalKey {
        &self.key
    }

    pub fn allow_human_terminal(&self) -> bool {
        self.allow_human_terminal
    }

    pub fn allow_mcp_commands(&self) -> bool {
        self.allow_mcp_commands
    }

    pub fn require_terminal_approval(&self) -> bool {
        self.require_terminal_approval
    }

    pub fn capabilities(&self) -> CliCapabilities {
        CliCapabilities::from_snapshot(&TerminalFeatureSnapshot {
            allow_human_terminal: self.allow_human_terminal,
            allow_mcp_commands: self.allow_mcp_commands,
            require_terminal_approval: self.require_terminal_approval,
            terminal_public_key_b64url: self.key.public_b64url().to_string(),
        })
    }
}

/// Hello capabilities always come from the startup snapshot, never the live config.
pub fn hello_capabilities(startup: &TerminalStartup, _live: &Config) -> CliCapabilities {
    startup.capabilities()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_ignore_config_changes_after_startup() {
        let mut config = Config {
            allow_human_terminal: true,
            allow_mcp_commands: true,
            require_terminal_approval: true,
            ..Config::default()
        };
        let startup = TerminalStartup::capture(&config).expect("startup");
        let public_key = startup.key().public_b64url().to_string();
        config.allow_human_terminal = false;
        config.allow_mcp_commands = false;
        config.require_terminal_approval = false;
        let capabilities = hello_capabilities(&startup, &config);
        assert!(capabilities.features.human_terminal);
        assert!(capabilities.features.mcp_commands);
        assert!(capabilities.features.terminal_approval);
        assert_eq!(capabilities.features.terminal_supported, cfg!(unix));
        assert_eq!(capabilities.terminal_public_key, public_key);
        assert!(capabilities.terminal);
        assert!(capabilities.exec);
    }
}
