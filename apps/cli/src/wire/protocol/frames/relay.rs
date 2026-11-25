//! Model-relay, file-op and speech-session payloads.

use serde::{Deserialize, Serialize};

/// Why a relayed request or session failed (explicit names: serde's
/// `snake_case` would spell `Upstream5xx` as `upstream5xx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RelayFailure {
    #[serde(rename = "transport")]
    Transport,
    #[serde(rename = "timeout")]
    Timeout,
    #[serde(rename = "disconnected")]
    Disconnected,
    #[serde(rename = "upstream_5xx")]
    Upstream5xx,
    #[serde(rename = "upstream_4xx")]
    Upstream4xx,
    #[serde(rename = "unsupported_capability")]
    UnsupportedCapability,
    #[serde(rename = "not_found")]
    NotFound,
    #[serde(rename = "access_denied")]
    AccessDenied,
    #[serde(rename = "rate_limited")]
    RateLimited,
    #[serde(rename = "request_too_large")]
    RequestTooLarge,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "protocol_error")]
    ProtocolError,
    /// Also how a reason a later server added reads (`relay.cancel`,
    /// `stt.close`): the request or session still ends.
    #[serde(rename = "unknown", other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayMetrics {
    pub completion_tokens: u64,
    /// Always `cl100k_base`.
    pub tokenizer: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountMethod {
    VllmTokenize,
    TgiChatTokenize,
    LlamaApplyTemplate,
    LlamaInputTokens,
    ReaderCount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpKind {
    Read,
    Stat,
    List,
    Search,
    Edit,
    Write,
    Rename,
    Mkdir,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RequestFamily {
    #[serde(rename = "chat.completions")]
    ChatCompletions,
    #[serde(rename = "embeddings")]
    Embeddings,
    #[serde(rename = "responses")]
    Responses,
    #[serde(rename = "messages")]
    Messages,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "images")]
    Images,
    #[serde(rename = "generic")]
    Generic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HttpMethod {
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "POST")]
    Post,
    /// `DELETE /v1/responses/{id}` (stored Responses objects on the engine).
    #[serde(rename = "DELETE")]
    Delete,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SttAdapter {
    Vllm,
    Segmented,
}

/// Token usage an engine reported for one item.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SttEngineUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

/// A normalized transcription event (`stt.event`), CLI to server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SttEvent {
    Delta {
        item_seq: u32,
        text: String,
    },
    Completed {
        item_seq: u32,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        engine_usage: Option<SttEngineUsage>,
    },
    Failed {
        item_seq: u32,
        code: String,
        message: String,
    },
    /// The `maxItemSeconds` valve ended the open item.
    AutoCommitted {
        item_seq: u32,
    },
}
