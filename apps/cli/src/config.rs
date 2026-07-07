//! CLI-local JSON configuration.
//!
//! The config intentionally stores references to environment variables for
//! secrets, never secret values. Product-native device credentials live in the
//! state directory; endpoint base URLs stay local and are not included in relay
//! registration inventory.

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::slug::validate_slug;

pub const CONFIG_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub version: u8,
    pub server_url: Option<String>,
    pub cli_slug: Option<String>,
    pub cli_label: Option<String>,
    pub cli_token_env: Option<String>,
    pub endpoints: Vec<EndpointConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            server_url: None,
            cli_slug: None,
            cli_label: None,
            cli_token_env: None,
            endpoints: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EndpointConfig {
    pub slug: String,
    pub label: String,
    pub kind: EndpointKind,
    pub base_url: String,
    pub enabled: bool,
    pub default_capabilities: OpenAiCompatibleCapabilities,
    pub headers: Vec<HeaderEnvRef>,
    pub models: Vec<ModelConfig>,
    pub last_probe: Option<ProbeSnapshot>,
}

impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            slug: String::new(),
            label: String::new(),
            kind: EndpointKind::OpenAiCompatible,
            base_url: String::new(),
            enabled: true,
            default_capabilities: OpenAiCompatibleCapabilities::default(),
            headers: Vec::new(),
            models: Vec::new(),
            last_probe: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointKind {
    #[serde(rename = "openai-compatible")]
    #[default]
    OpenAiCompatible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderEnvRef {
    pub name: String,
    pub env: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelConfig {
    pub slug: Option<String>,
    pub upstream_model_id: String,
    pub capability_override_mode: CapabilityOverrideMode,
    pub capabilities: Option<OpenAiCompatibleCapabilities>,
    pub probe_suggestions: Option<OpenAiCompatibleCapabilities>,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            slug: None,
            upstream_model_id: String::new(),
            capability_override_mode: CapabilityOverrideMode::Inherit,
            capabilities: None,
            probe_suggestions: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityOverrideMode {
    #[default]
    Inherit,
    Override,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSnapshot {
    pub status: ProbeStatus,
    pub models: Vec<String>,
    pub suggested_capabilities: OpenAiCompatibleCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeStatus {
    Online,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenAiCompatibleCapabilities {
    pub version: u8,
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<ModelListCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_completions: Option<ChatCompletionsCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completions: Option<CompletionsCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeddings: Option<EmbeddingsCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responses: Option<ResponsesCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioCapabilities>,
}

impl Default for OpenAiCompatibleCapabilities {
    fn default() -> Self {
        Self::openai_defaults()
    }
}

impl OpenAiCompatibleCapabilities {
    pub fn openai_defaults() -> Self {
        Self {
            version: 1,
            protocol: "openai-compatible".to_string(),
            models: Some(ModelListCapabilities { list: Some(true) }),
            chat_completions: Some(ChatCompletionsCapabilities {
                supported: Some(true),
                streaming: Some(true),
                vision: None,
            }),
            completions: None,
            embeddings: None,
            responses: None,
            audio: None,
        }
    }

    pub fn embedding_defaults() -> Self {
        Self {
            version: 1,
            protocol: "openai-compatible".to_string(),
            models: Some(ModelListCapabilities { list: Some(true) }),
            chat_completions: None,
            completions: None,
            embeddings: Some(EmbeddingsCapabilities {
                supported: Some(true),
            }),
            responses: None,
            audio: None,
        }
    }

    pub fn with_responses(mut self) -> Self {
        self.responses = Some(ResponsesCapabilities {
            supported: Some(true),
            streaming: Some(true),
            stateful_follow_ups: None,
            retrieve: None,
            delete: None,
            cancel: None,
            list_input_items: None,
            count_tokens: None,
            compact: None,
        });
        self
    }

    pub fn with_vision(mut self) -> Self {
        let mut chat = self
            .chat_completions
            .unwrap_or(ChatCompletionsCapabilities {
                supported: Some(true),
                streaming: Some(true),
                vision: None,
            });
        chat.vision = Some(true);
        self.chat_completions = Some(chat);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelListCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<bool>,
}

impl Default for ModelListCapabilities {
    fn default() -> Self {
        Self { list: Some(true) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatCompletionsCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CompletionsCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct EmbeddingsCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ResponsesCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stateful_follow_ups: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieve: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_input_items: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_tokens: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcriptions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translations: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speech: Option<bool>,
}

impl Config {
    pub fn load() -> Result<Self> {
        Self::load_from_path(&crate::paths::config_file()?)
    }

    pub fn load_required() -> Result<Self> {
        let path = crate::paths::config_file()?;
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parsing config file `{}`", path.display())),
            Err(err) if err.kind() == ErrorKind::NotFound => {
                anyhow::bail!(
                    "config file `{}` does not exist; run `wsmp config init`",
                    path.display()
                )
            }
            Err(err) => {
                Err(err).with_context(|| format!("reading config file `{}`", path.display()))
            }
        }
    }

    pub fn load_from_path(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parsing config file `{}`", path.display())),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => {
                Err(err).with_context(|| format!("reading config file `{}`", path.display()))
            }
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = crate::paths::config_file()?;
        self.save_to_path(path)
    }

    pub fn save_to_path(&self, path: PathBuf) -> Result<()> {
        let dir = path
            .parent()
            .map(Path::to_path_buf)
            .context("config path has no parent directory")?;
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating config directory `{}`", dir.display()))?;
        create_private_dir(&dir)?;
        let text = serde_json::to_string_pretty(self).context("serializing config")?;
        let mut file = NamedTempFile::new_in(&dir)
            .with_context(|| format!("creating temporary config file in `{}`", dir.display()))?;
        file.write_all(text.as_bytes())
            .with_context(|| format!("writing temporary config file for `{}`", path.display()))?;
        file.write_all(b"\n")
            .with_context(|| format!("writing temporary config file for `{}`", path.display()))?;
        file.as_file()
            .sync_all()
            .with_context(|| format!("syncing temporary config file for `{}`", path.display()))?;
        file.persist(&path)
            .map_err(|err| err.error)
            .with_context(|| format!("moving temporary config file to `{}`", path.display()))?;
        sync_parent_dir(&path)?;
        Ok(())
    }

    pub fn save_new(&self) -> Result<bool> {
        let path = crate::paths::config_file()?;
        if path
            .try_exists()
            .with_context(|| format!("checking whether config file `{}` exists", path.display()))?
        {
            return Ok(false);
        }
        self.save_to_path(path)?;
        Ok(true)
    }

    pub fn endpoint(&self, slug: &str) -> Option<&EndpointConfig> {
        self.endpoints.iter().find(|endpoint| endpoint.slug == slug)
    }

    pub fn endpoint_mut(&mut self, slug: &str) -> Option<&mut EndpointConfig> {
        self.endpoints
            .iter_mut()
            .find(|endpoint| endpoint.slug == slug)
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(slug) = &self.cli_slug {
            validate_slug(slug).with_context(|| format!("validating CLI slug `{slug}`"))?;
        }
        for endpoint in &self.endpoints {
            validate_slug(&endpoint.slug)
                .with_context(|| format!("validating endpoint slug `{}`", endpoint.slug))?;
            for model in &endpoint.models {
                if let Some(slug) = &model.slug {
                    validate_slug(slug)
                        .with_context(|| format!("validating model slug `{slug}`"))?;
                }
            }
        }
        Ok(())
    }
}

pub fn validate_env_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        anyhow::bail!("environment variable name cannot be empty");
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        anyhow::bail!("environment variable name `{name}` must start with a letter or `_`");
    }
    if !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        anyhow::bail!(
            "environment variable name `{name}` may only contain letters, numbers, and `_`"
        );
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::metadata(dir)
        .with_context(|| format!("reading metadata for `{}`", dir.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(dir, permissions)
        .with_context(|| format!("setting private permissions on `{}`", dir.display()))
}

#[cfg(not(unix))]
fn create_private_dir(_dir: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> Result<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::File::open(dir)
        .and_then(|dir_file| dir_file.sync_all())
        .with_context(|| format!("syncing config directory `{}`", dir.display()))
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_json_config() {
        let cfg = Config {
            server_url: Some("https://example.test".to_string()),
            cli_slug: Some("desk-01".to_string()),
            endpoints: vec![EndpointConfig {
                slug: "local".to_string(),
                label: "Local".to_string(),
                base_url: "http://127.0.0.1:11434/v1".to_string(),
                ..EndpointConfig::default()
            }],
            ..Config::default()
        };
        let text = serde_json::to_string_pretty(&cfg).expect("serialize");
        let parsed: Config = serde_json::from_str(&text).expect("parse");
        assert_eq!(parsed, cfg);
    }

    #[test]
    fn validates_env_name_shape() {
        validate_env_name("WSMP_TOKEN").expect("valid");
        assert!(validate_env_name("1TOKEN").is_err());
        assert!(validate_env_name("TOKEN-NAME").is_err());
    }
}
