//! A configured model endpoint: its address, auth, engine, models and last
//! probe.

use serde::{Deserialize, Serialize};

use crate::engine_facts;

use super::capabilities::OpenAiCompatibleCapabilities;

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
    /// Hard concurrency sent on every model at registration. Omitted means the
    /// server fallback of 1. An existing non-null capacity is left unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency_limit: Option<u32>,
    /// Declared total KV capacity in tokens. Digest-excluded like
    /// `concurrencyLimit`; when set it wins over a probed K.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_tokens: Option<u64>,
    /// Upstream engine. `auto` (the default) detects it at probe time; an
    /// explicit value overrides detection. llama.cpp and vLLM advertise
    /// `top_k` in the inventory only when declared explicitly.
    #[serde(default, skip_serializing_if = "is_auto_engine")]
    pub engine: EndpointEngine,
    pub default_capabilities: OpenAiCompatibleCapabilities,
    pub headers: Vec<HeaderEnvRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<EndpointAuthConfig>,
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
            concurrency_limit: None,
            kv_tokens: None,
            engine: EndpointEngine::Auto,
            default_capabilities: OpenAiCompatibleCapabilities::default(),
            headers: Vec::new(),
            auth: None,
            models: Vec::new(),
            last_probe: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointAuthConfig {
    pub mode: EndpointAuthMode,
    pub env: String,
}

fn is_auto_engine(engine: &EndpointEngine) -> bool {
    *engine == EndpointEngine::Auto
}

/// Declared upstream engine. `Auto` means "detect at probe time"; every other
/// value is the person's declaration and turns detection off. Only an explicit
/// llama.cpp or vLLM advertises `top_k`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointEngine {
    #[default]
    Auto,
    Generic,
    #[serde(rename = "llama.cpp")]
    LlamaCpp,
    Vllm,
    Sglang,
    Ollama,
    LmStudio,
}

impl EndpointEngine {
    pub fn accepts_top_k(self) -> bool {
        matches!(self, Self::LlamaCpp | Self::Vllm)
    }

    pub fn as_config_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Generic => "generic",
            Self::LlamaCpp => "llama.cpp",
            Self::Vllm => "vllm",
            Self::Sglang => "sglang",
            Self::Ollama => "ollama",
            Self::LmStudio => "lm-studio",
        }
    }

    /// The engine kind this declaration names, or `None` for `auto`.
    pub fn declared_kind(self) -> Option<engine_facts::EngineKind> {
        use engine_facts::EngineKind;
        match self {
            Self::Auto => None,
            Self::Generic => Some(EngineKind::Generic),
            Self::LlamaCpp => Some(EngineKind::LlamaCpp),
            Self::Vllm => Some(EngineKind::Vllm),
            Self::Sglang => Some(EngineKind::Sglang),
            Self::Ollama => Some(EngineKind::Ollama),
            Self::LmStudio => Some(EngineKind::LmStudio),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointAuthMode {
    ApiKey,
    Bearer,
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
    /// Static engine facts from the last probe (engine detection). Reported in
    /// the inventory and never part of the inventory digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<engine_facts::DetectedEngine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeStatus {
    Online,
    Offline,
}

pub(super) fn is_false(value: &bool) -> bool {
    !*value
}
