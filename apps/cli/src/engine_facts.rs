//! The engine facts a probe found, persisted in `lastProbe.engine` and sent
//! as `engineFacts`. Detection (`crate::engine`) and the tokenize probe
//! (`crate::count_context`) produce them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Inference engine kinds on the relay wire (`engineFacts.engine.value`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineKind {
    Generic,
    #[serde(rename = "llama.cpp")]
    LlamaCpp,
    Vllm,
    Sglang,
    Ollama,
    LmStudio,
}

impl EngineKind {
    /// Engines whose live load the telemetry thread can scrape.
    pub fn has_load_source(self) -> bool {
        matches!(self, Self::LlamaCpp | Self::Vllm | Self::Sglang)
    }
}

/// Static facts one probe found. Persisted in `lastProbe.engine` so a reload
/// candidate and a reconnect carry them without another network round trip.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DetectedEngine {
    /// `None` when detection found nothing recognizable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<EngineKind>,
    /// Concurrent sequences: llama.cpp `total_slots`, SGLang `max_running_requests`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slots: Option<u32>,
    /// llama.cpp `default_generation_settings.n_ctx`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_per_slot: Option<u64>,
    /// Total KV capacity in tokens: vLLM `num_gpu_blocks × block_size`,
    /// SGLang `max_total_num_tokens`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_tokens: Option<u64>,
    /// Engine-wide context limit (SGLang `context_length`, llama.cpp per-slot).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_model_len: Option<u64>,
    /// Per model id: vLLM `/v1/models` `max_model_len`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub model_max_len: BTreeMap<String, u64>,
    /// Ids one engine process serves (vLLM/SGLang `--served-model-name` lists).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub served_model_aliases: Vec<String>,
    /// Chat Completions tokenize fact recorded at probe time (`method` or
    /// `unsupported`). `None` means this endpoint has not been probed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_context: Option<CountContextFact>,
}

/// How this engine counts Chat Completions context. Wire value of
/// `count_context.result.method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountContextMethod {
    VllmTokenize,
    TgiChatTokenize,
    LlamaApplyTemplate,
    LlamaInputTokens,
    AdapterCount,
}

impl CountContextMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VllmTokenize => "vllm_tokenize",
            Self::TgiChatTokenize => "tgi_chat_tokenize",
            Self::LlamaApplyTemplate => "llama_apply_template",
            Self::LlamaInputTokens => "llama_input_tokens",
            Self::AdapterCount => "adapter_count",
        }
    }
}

/// Persisted tri-state for `engineFacts.countContext`: a method, explicit
/// unsupported, or absent (`DetectedEngine.count_context == None`) when the
/// endpoint has not been probed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountContextFact {
    Unsupported,
    VllmTokenize,
    TgiChatTokenize,
    LlamaApplyTemplate,
    LlamaInputTokens,
    AdapterCount,
}

impl CountContextFact {
    pub fn method(self) -> Option<CountContextMethod> {
        match self {
            Self::Unsupported => None,
            Self::VllmTokenize => Some(CountContextMethod::VllmTokenize),
            Self::TgiChatTokenize => Some(CountContextMethod::TgiChatTokenize),
            Self::LlamaApplyTemplate => Some(CountContextMethod::LlamaApplyTemplate),
            Self::LlamaInputTokens => Some(CountContextMethod::LlamaInputTokens),
            Self::AdapterCount => Some(CountContextMethod::AdapterCount),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::VllmTokenize => "vllm_tokenize",
            Self::TgiChatTokenize => "tgi_chat_tokenize",
            Self::LlamaApplyTemplate => "llama_apply_template",
            Self::LlamaInputTokens => "llama_input_tokens",
            Self::AdapterCount => "adapter_count",
        }
    }
}

impl From<CountContextMethod> for CountContextFact {
    fn from(method: CountContextMethod) -> Self {
        match method {
            CountContextMethod::VllmTokenize => Self::VllmTokenize,
            CountContextMethod::TgiChatTokenize => Self::TgiChatTokenize,
            CountContextMethod::LlamaApplyTemplate => Self::LlamaApplyTemplate,
            CountContextMethod::LlamaInputTokens => Self::LlamaInputTokens,
            CountContextMethod::AdapterCount => Self::AdapterCount,
        }
    }
}
