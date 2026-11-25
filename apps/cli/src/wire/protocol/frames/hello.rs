//! The handshake: the node's `hello`, its build and environment, terminal
//! identities, definition sync and the `protocol.error` codes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdentity {
    pub public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeTerminalIdentity {
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloNode {
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub identity_public_key: String,
    pub identity_signature: String,
    pub terminal_public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_identity: Option<NodeTerminalIdentity>,
    /// Which build this is (two builds of the same version can differ).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<NodeBuild>,
    /// Sent only when there is something to say (`wsl: true`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<NodeEnvironment>,
}

/// How this wsmp was installed (`hello.node.build.installMethod`, the install receipt).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallMethod {
    /// The server's `install.sh`.
    Script,
    /// The server's `install.ps1`.
    ScriptPs1,
    Homebrew,
    /// `cargo install` from a registry.
    Cargo,
    Binstall,
    Npm,
    /// Built from a git revision (`WMP_CLI_SOURCE_REV`, `cargo install --git`): never replaced
    /// from the browser (D8).
    Source,
    Unknown,
}

impl InstallMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Script => "script",
            Self::ScriptPs1 => "script-ps1",
            Self::Homebrew => "homebrew",
            Self::Cargo => "cargo",
            Self::Binstall => "binstall",
            Self::Npm => "npm",
            Self::Source => "source",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeBuild {
    /// The git commit this binary was built from (40 lowercase hex), `null` when unknown.
    pub commit: Option<String>,
    pub install_method: InstallMethod,
    /// The Rust target triple this binary was built for.
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeEnvironment {
    /// The node runs inside WSL (`/proc/sys/kernel/osrelease` names Microsoft).
    #[serde(default, skip_serializing_if = "is_false")]
    pub wsl: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionSync {
    Expect,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolErrorCode {
    UpgradeCli,
    UpgradeServer,
    IdentityMismatch,
    AccessDenied,
    Malformed,
    Internal,
    /// A code a later server added: the node prints the server's message and
    /// reconnects with backoff, rather than failing to read the frame.
    #[serde(other)]
    Unknown,
}
