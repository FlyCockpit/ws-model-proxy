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

#[cfg(unix)]
use nix::fcntl::{Flock, FlockArg};

use crate::slug::validate_slug;

pub const CONFIG_VERSION: u8 = 1;

fn deserialize_capability_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let version = u8::deserialize(deserializer)?;
    if matches!(version, 1 | 2 | 3) {
        Ok(version)
    } else {
        Err(serde::de::Error::custom(
            "capability version must be 1, 2, or 3",
        ))
    }
}

fn deserialize_compatible_protocol<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let protocol = String::deserialize(deserializer)?;
    if matches!(
        protocol.as_str(),
        "openai-compatible" | "anthropic-compatible"
    ) {
        Ok(protocol)
    } else {
        Err(serde::de::Error::custom(
            "capability protocol must be openai-compatible or anthropic-compatible",
        ))
    }
}

/// A short-lived advisory lock shared by every local config mutation.  The
/// daemon still owns the future control-plane mutation API; this is the
/// transitional guard that prevents a standalone command from overwriting a
/// concurrent reload/probe write.
#[cfg(unix)]
pub struct ConfigLock {
    // Keeping the RAII guard alive holds the advisory lock for the critical
    // section; the field is intentionally otherwise unused.
    _guard: Flock<std::fs::File>,
}

#[cfg(not(unix))]
pub struct ConfigLock;

impl ConfigLock {
    pub fn exclusive() -> Result<Self> {
        let config = crate::paths::config_file()?;
        let directory = config
            .parent()
            .context("config path has no parent directory")?;
        std::fs::create_dir_all(directory)
            .with_context(|| format!("creating config directory `{}`", directory.display()))?;
        create_private_dir(directory)?;
        #[cfg(unix)]
        {
            let lock_path = config.with_extension("json.lock");
            let file = std::fs::OpenOptions::new()
                .create(true)
                // Lock files are persistent coordination points. Preserve any
                // existing inode/content rather than truncating on each lock.
                .truncate(false)
                .read(true)
                .write(true)
                .open(&lock_path)
                .with_context(|| format!("opening config lock `{}`", lock_path.display()))?;
            let lock = Flock::lock(file, FlockArg::LockExclusive)
                .map_err(|(_, error)| anyhow::anyhow!(error))
                .with_context(|| format!("locking config `{}`", config.display()))?;
            Ok(Self { _guard: lock })
        }
        #[cfg(not(unix))]
        {
            // Windows does not expose the Unix control plane. Atomic writes
            // still protect file integrity there; daemon-owned mutations are
            // required before concurrent Windows writers are supported.
            Ok(Self)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub version: u8,
    pub server_url: Option<String>,
    pub cli_slug: Option<String>,
    pub cli_label: Option<String>,
    pub cli_token_env: Option<String>,
    pub endpoints: Vec<EndpointConfig>,
    /// Extra HTTP(S) origins whose signed `/media/{id}` URLs the relay may fetch
    /// and inline when an endpoint enables `expandMedia`. The connected server's
    /// own origin is always trusted; these are additive.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub media_trusted_origins: Vec<String>,
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
            media_trusted_origins: Vec::new(),
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
    /// When true, buffer chat-shaped JSON request bodies for this endpoint and
    /// inline trusted WMP media URLs as `data:` URLs before forwarding upstream.
    /// Off by default; opt in for local upstreams that cannot fetch remote URLs.
    #[serde(skip_serializing_if = "is_false")]
    pub expand_media: bool,
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
            expand_media: false,
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
    #[serde(rename = "anthropic-compatible")]
    AnthropicCompatible,
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
    /// When true, a successful probe keeps this model even if `/v1/models` omits it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            slug: None,
            upstream_model_id: String::new(),
            capability_override_mode: CapabilityOverrideMode::Inherit,
            capabilities: None,
            probe_suggestions: None,
            pinned: false,
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
    #[serde(deserialize_with = "deserialize_capability_version")]
    pub version: u8,
    #[serde(deserialize_with = "deserialize_compatible_protocol")]
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surfaces: Option<SurfaceInventory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
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
            surfaces: None,
            source: None,
            confidence: None,
            models: Some(ModelListCapabilities { list: Some(true) }),
            chat_completions: Some(ChatCompletionsCapabilities {
                supported: Some(true),
                streaming: Some(true),
                vision: None,
                video: None,
                audio: None,
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
            surfaces: None,
            source: None,
            confidence: None,
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
                video: None,
                audio: None,
            });
        chat.vision = Some(true);
        self.chat_completions = Some(chat);
        self
    }

    /// Chat multimodal `video_url` parts (omni / VLM local stacks such as MiMo).
    pub fn with_video(mut self) -> Self {
        let mut chat = self
            .chat_completions
            .unwrap_or(ChatCompletionsCapabilities {
                supported: Some(true),
                streaming: Some(true),
                vision: None,
                video: None,
                audio: None,
            });
        chat.video = Some(true);
        self.chat_completions = Some(chat);
        self
    }

    /// Chat multimodal `input_audio` parts (not dedicated /v1/audio/* endpoints).
    pub fn with_chat_audio(mut self) -> Self {
        let mut chat = self
            .chat_completions
            .unwrap_or(ChatCompletionsCapabilities {
                supported: Some(true),
                streaming: Some(true),
                vision: None,
                video: None,
                audio: None,
            });
        chat.audio = Some(true);
        self.chat_completions = Some(chat);
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SurfaceInventory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_chat_completions: Option<SurfaceCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_responses: Option<SurfaceCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_messages: Option<SurfaceCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_completions: Option<SurfaceCapabilities>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SurfaceCapabilities {
    pub supported: Option<bool>,
    pub streaming: Option<bool>,
    pub max_context_tokens: Option<u64>,
    pub images: Option<bool>,
    pub tools: Option<bool>,
    pub parallel_tools: Option<bool>,
    pub structured_output: Option<bool>,
    pub reasoning: Option<bool>,
    pub hosted_tools: Option<bool>,
    pub count_tokens: Option<bool>,
    pub stateful: Option<bool>,
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub beta_features: Vec<String>,
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
    /// `image_url` content parts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// `video_url` content parts (omni / VLM).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<bool>,
    /// `input_audio` content parts in chat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<bool>,
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
pub struct TranscriptionCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_formats: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_granularities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diarization: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub languages: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_detection: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiple_language_hints: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_upload_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_mime_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AudioOperationCapabilities {
    Boolean(bool),
    Detailed(TranscriptionCapabilities),
}

impl AudioOperationCapabilities {
    pub fn supported(&self) -> Option<bool> {
        match self {
            Self::Boolean(value) => Some(*value),
            Self::Detailed(profile) => profile.supported,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcriptions: Option<AudioOperationCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translations: Option<AudioOperationCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speech: Option<bool>,
}

impl Config {
    /// Execute a complete local read-modify-write under the transitional
    /// exclusive lock. Callers must not call `save` from `update`; this method
    /// persists the returned candidate before releasing the lock.
    pub fn update<T>(required: bool, mutate: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let _lock = ConfigLock::exclusive()?;
        let mut config = if required {
            Self::load_required()?
        } else {
            Self::load()?
        };
        let output = mutate(&mut config)?;
        config.save()?;
        Ok(output)
    }
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
        let _lock = ConfigLock::exclusive()?;
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

fn is_false(value: &bool) -> bool {
    !*value
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

    #[test]
    fn reads_legacy_and_detailed_transcription_capabilities() {
        let legacy: OpenAiCompatibleCapabilities = serde_json::from_value(serde_json::json!({
            "version": 1,
            "protocol": "openai-compatible",
            "audio": { "transcriptions": true }
        }))
        .expect("legacy profile");
        assert_eq!(
            legacy
                .audio
                .as_ref()
                .and_then(|audio| audio.transcriptions.as_ref())
                .and_then(AudioOperationCapabilities::supported),
            Some(true)
        );

        let detailed: OpenAiCompatibleCapabilities = serde_json::from_value(serde_json::json!({
            "version": 2,
            "protocol": "openai-compatible",
            "audio": {
                "transcriptions": {
                    "supported": true,
                    "streaming": true,
                    "responseFormats": ["json", "verbose_json"],
                    "timestampGranularities": ["word"]
                }
            }
        }))
        .expect("detailed profile");
        let profile = detailed.audio.unwrap().transcriptions.unwrap();
        assert_eq!(profile.supported(), Some(true));
        assert!(matches!(profile, AudioOperationCapabilities::Detailed(_)));

        let anthropic: OpenAiCompatibleCapabilities = serde_json::from_value(serde_json::json!({
            "version": 3,
            "protocol": "anthropic-compatible",
            "surfaces": {
                "anthropicMessages": {
                    "supported": true,
                    "streaming": true,
                    "protocolVersion": "2023-06-01"
                }
            }
        }))
        .expect("v3 Anthropic profile");
        assert_eq!(anthropic.version, 3);

        for invalid in [
            serde_json::json!({ "version": 4, "protocol": "openai-compatible" }),
            serde_json::json!({ "version": 2, "protocol": "other" }),
        ] {
            assert!(serde_json::from_value::<OpenAiCompatibleCapabilities>(invalid).is_err());
        }
    }
}
