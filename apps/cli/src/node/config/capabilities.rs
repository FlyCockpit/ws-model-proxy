//! The capability profile a model or endpoint advertises (protocol 3 and
//! the v4 surface inventory), with its wire validation.

use anyhow::Result;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};

/// Largest Anthropic thinking budget that remains exactly representable after
/// the TypeScript encoder reserves 1,024 visible-output tokens.
/// Keep this synchronized with the TypeScript reasoning contract.
pub const ANTHROPIC_THINKING_BUDGET_MAX: u64 = 9_007_199_254_739_967;

fn deserialize_capability_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let version = u8::deserialize(deserializer)?;
    if matches!(version, 1..=4) {
        Ok(version)
    } else {
        Err(serde::de::Error::custom(
            "capability version must be 1, 2, 3, or 4",
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase", try_from = "RawCapabilities")]
pub struct OpenAiCompatibleCapabilities {
    #[serde(deserialize_with = "deserialize_capability_version")]
    pub version: u8,
    #[serde(deserialize_with = "deserialize_compatible_protocol")]
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surfaces: Option<SurfaceInventory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<CapabilitySource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<CapabilityConfidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<ModelListCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_completions: Option<ChatCompletionsCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeddings: Option<EmbeddingsCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responses: Option<ResponsesCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling: Option<SamplingCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SamplingCapabilities {
    pub parameters: Vec<String>,
}

// v1/v2 capability inventories never had a `surfaces` member.  Keep that
// wire invariant even if a caller constructs this public Rust type directly.
// Deserialization has the matching rejection in `TryFrom<RawCapabilities>`.
impl Serialize for OpenAiCompatibleCapabilities {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("OpenAiCompatibleCapabilities", 10)?;
        state.serialize_field("version", &self.version)?;
        state.serialize_field("protocol", &self.protocol)?;
        if self.version >= 3
            && let Some(value) = &self.surfaces
        {
            state.serialize_field("surfaces", value)?;
        }
        if let Some(value) = &self.source {
            state.serialize_field("source", value)?;
        }
        if let Some(value) = &self.confidence {
            state.serialize_field("confidence", value)?;
        }
        if let Some(value) = &self.models {
            state.serialize_field("models", value)?;
        }
        if let Some(value) = &self.chat_completions {
            state.serialize_field("chatCompletions", value)?;
        }
        if let Some(value) = &self.embeddings {
            state.serialize_field("embeddings", value)?;
        }
        if let Some(value) = &self.responses {
            state.serialize_field("responses", value)?;
        }
        if let Some(value) = &self.audio {
            state.serialize_field("audio", value)?;
        }
        if let Some(value) = &self.sampling {
            state.serialize_field("sampling", value)?;
        }
        state.end()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct RawCapabilities {
    #[serde(deserialize_with = "deserialize_capability_version")]
    version: u8,
    #[serde(deserialize_with = "deserialize_compatible_protocol")]
    protocol: String,
    surfaces: Option<SurfaceInventory>,
    source: Option<CapabilitySource>,
    confidence: Option<CapabilityConfidence>,
    models: Option<ModelListCapabilities>,
    chat_completions: Option<ChatCompletionsCapabilities>,
    embeddings: Option<EmbeddingsCapabilities>,
    responses: Option<ResponsesCapabilities>,
    audio: Option<AudioCapabilities>,
    #[serde(default)]
    sampling: Option<SamplingCapabilities>,
}

impl Default for RawCapabilities {
    fn default() -> Self {
        Self {
            version: 1,
            protocol: "openai-compatible".to_string(),
            surfaces: None,
            source: None,
            confidence: None,
            models: None,
            chat_completions: None,
            embeddings: None,
            responses: None,
            audio: None,
            sampling: None,
        }
    }
}

impl TryFrom<RawCapabilities> for OpenAiCompatibleCapabilities {
    type Error = String;

    fn try_from(value: RawCapabilities) -> std::result::Result<Self, Self::Error> {
        if value.version < 3 && value.protocol != "openai-compatible" {
            return Err(
                "capability inventory versions 1 and 2 require protocol `openai-compatible`"
                    .to_string(),
            );
        }
        if value.version < 3 && value.surfaces.is_some() {
            return Err(format!(
                "version {} capabilities cannot use `surfaces`",
                value.version
            ));
        }
        if value.version >= 3 && value.surfaces.is_none() {
            return Err(format!(
                "version {} capabilities require `surfaces`",
                value.version
            ));
        }
        if value.version == 3
            && value
                .surfaces
                .as_ref()
                .is_some_and(SurfaceInventory::has_v4_fields)
        {
            return Err("version 3 capabilities cannot use version 4 operation fields".to_string());
        }
        if value.version >= 3 {
            value
                .surfaces
                .as_ref()
                .expect("checked above")
                .validate_reasoning_configs()?;
        }
        if value.version == 4 {
            if value.models.is_some()
                || value.chat_completions.is_some()
                || value.embeddings.is_some()
                || value.responses.is_some()
                || value.audio.is_some()
            {
                return Err("version 4 capabilities cannot use legacy operation fields".to_string());
            }
            value
                .surfaces
                .as_ref()
                .expect("checked above")
                .validate_v4(&value.protocol)?;
        }
        Ok(Self {
            version: value.version,
            protocol: value.protocol,
            surfaces: value.surfaces,
            source: value.source,
            confidence: value.confidence,
            models: value.models,
            chat_completions: value.chat_completions,
            embeddings: value.embeddings,
            responses: value.responses,
            audio: value.audio,
            sampling: value.sampling,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilitySource {
    Declared,
    Probe,
    Dashboard,
    Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityConfidence {
    Exact,
    High,
    Estimated,
    Unknown,
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
            embeddings: None,
            responses: None,
            audio: None,
            sampling: None,
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
            embeddings: Some(EmbeddingsCapabilities {
                supported: Some(true),
                contract: None,
            }),
            responses: None,
            audio: None,
            sampling: None,
        }
    }

    /// A speech-to-text server: transcriptions only, with the options its
    /// recipe declares. Version 2 is the first that carries a detailed
    /// transcription profile (version 1 accepts only a boolean there).
    pub fn transcription(
        profile: Option<&crate::wire::protocol::runtime_spec::TranscriptionProfile>,
    ) -> Self {
        let profile = profile.cloned().unwrap_or_default();
        Self {
            version: 2,
            protocol: "openai-compatible".to_string(),
            surfaces: None,
            source: None,
            confidence: None,
            models: Some(ModelListCapabilities { list: Some(true) }),
            chat_completions: None,
            embeddings: None,
            responses: None,
            audio: Some(AudioCapabilities {
                transcriptions: Some(AudioOperationCapabilities::Detailed(
                    TranscriptionCapabilities {
                        supported: Some(true),
                        streaming: Some(profile.streaming.unwrap_or(true)),
                        response_formats: profile.response_formats,
                        timestamp_granularities: profile.timestamp_granularities,
                        diarization: profile.diarization,
                        languages: profile.languages,
                        language_detection: profile.language_detection,
                        multiple_language_hints: profile.multiple_language_hints,
                        max_upload_bytes: profile.max_upload_bytes.map(u64::from),
                        accepted_mime_types: profile.accepted_mime_types,
                        realtime: profile.realtime.map(|realtime| {
                            RealtimeTranscriptionCapabilities {
                                supported: Some(true),
                                adapter: match realtime.adapter {
                                    crate::wire::protocol::runtime_spec::RealtimeAdapter::Vllm => {
                                        RealtimeAdapter::Vllm
                                    }
                                    crate::wire::protocol::runtime_spec::RealtimeAdapter::Segmented => {
                                        RealtimeAdapter::Segmented
                                    }
                                },
                                max_item_seconds: realtime.max_item_seconds,
                                max_sessions: realtime.max_sessions,
                            }
                        }),
                    },
                )),
                translations: None,
                speech: None,
            }),
            sampling: None,
        }
    }

    pub fn advertise_top_k(&mut self) {
        let sampling = self
            .sampling
            .get_or_insert_with(SamplingCapabilities::default);
        if !sampling
            .parameters
            .iter()
            .any(|parameter| parameter == "top_k")
        {
            sampling.parameters.push("top_k".to_string());
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
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceInventory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_chat_completions: Option<SurfaceCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_responses: Option<ResponsesSurfaceCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_messages: Option<AnthropicSurfaceCapabilities>,
}

impl SurfaceInventory {
    fn has_v4_fields(&self) -> bool {
        self.openai_chat_completions
            .as_ref()
            .is_some_and(|surface| !surface.operations.is_empty())
            || self
                .openai_responses
                .as_ref()
                .is_some_and(|surface| !surface.common.operations.is_empty())
            || self.anthropic_messages.as_ref().is_some_and(|surface| {
                !surface.common.operations.is_empty() || !surface.protocol_versions.is_empty()
            })
    }

    fn validate_v4(&self, protocol: &str) -> std::result::Result<(), String> {
        fn validate_common(
            name: &str,
            surface: &SurfaceCapabilities,
            allowed: &[&str],
        ) -> std::result::Result<(), String> {
            if surface.operations.is_empty() {
                return Err(format!("version 4 surface `{name}` requires `operations`"));
            }
            let mut seen = std::collections::HashSet::new();
            for operation in &surface.operations {
                if !allowed.contains(&operation.as_str()) {
                    return Err(format!(
                        "version 4 surface `{name}` has unknown operation `{operation}`"
                    ));
                }
                if !seen.insert(operation) {
                    return Err(format!(
                        "version 4 surface `{name}` has duplicate operation `{operation}`"
                    ));
                }
            }
            if surface.supported.is_some()
                || surface.protocol_version.is_some()
                || !surface.beta_features.is_empty()
            {
                return Err(format!(
                    "version 4 surface `{name}` uses legacy capability fields"
                ));
            }
            Ok(())
        }

        if let Some(surface) = &self.openai_chat_completions {
            validate_common("openaiChatCompletions", surface, &["create"])?;
        }
        if let Some(surface) = &self.openai_responses {
            validate_common(
                "openaiResponses",
                &surface.common,
                &[
                    "create",
                    "statefulFollowUps",
                    "retrieve",
                    "delete",
                    "cancel",
                    "listInputItems",
                    "countTokens",
                    "compact",
                ],
            )?;
            if surface.responses_lifecycle.is_some() {
                return Err(
                    "version 4 openaiResponses uses legacy `responsesLifecycle`".to_string()
                );
            }
        }
        if let Some(surface) = &self.anthropic_messages {
            validate_common(
                "anthropicMessages",
                &surface.common,
                &["create", "countTokens"],
            )?;
            if surface.count_tokens.is_some() || surface.protocol_versions.is_empty() {
                return Err(
                    "version 4 anthropicMessages requires `protocolVersions` and cannot use legacy `countTokens`"
                        .to_string(),
                );
            }
            let mut versions = std::collections::HashSet::new();
            for version in &surface.protocol_versions {
                let normalized_version = version.version.trim();
                if normalized_version.is_empty() || !versions.insert(normalized_version) {
                    return Err(
                        "Anthropic protocol versions must be non-empty and unique".to_string()
                    );
                }
                let mut betas = std::collections::HashSet::new();
                if version.beta_features.iter().any(|beta| {
                    let normalized_beta = beta.trim();
                    normalized_beta.is_empty() || !betas.insert(normalized_beta)
                }) {
                    return Err("Anthropic beta features must be non-empty and unique".to_string());
                }
            }
        }
        let has_openai = self.openai_chat_completions.is_some() || self.openai_responses.is_some();
        if protocol == "openai-compatible" && self.anthropic_messages.is_some() {
            return Err(
                "openai-compatible version 4 capabilities cannot declare anthropicMessages"
                    .to_string(),
            );
        }
        if protocol == "anthropic-compatible" && has_openai {
            return Err(
                "anthropic-compatible version 4 capabilities cannot declare OpenAI surfaces"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn validate_reasoning_configs(&self) -> std::result::Result<(), String> {
        fn validate(
            name: &str,
            surface: &SurfaceCapabilities,
            anthropic: bool,
        ) -> std::result::Result<(), String> {
            let Some(config) = &surface.reasoning_config else {
                return Ok(());
            };
            if surface.reasoning != Some(true) {
                return Err(format!(
                    "surface `{name}` reasoningConfig requires reasoning: true"
                ));
            }
            config.validate(name, anthropic)
        }
        if let Some(surface) = &self.openai_chat_completions {
            validate("openaiChatCompletions", surface, false)?;
        }
        if let Some(surface) = &self.openai_responses {
            validate("openaiResponses", &surface.common, false)?;
        }
        if let Some(surface) = &self.anthropic_messages {
            validate("anthropicMessages", &surface.common, true)?;
        }
        // The server schema accepts `streamUsage` on the Chat surface only.
        for (name, common) in [
            (
                "openaiResponses",
                self.openai_responses.as_ref().map(|s| &s.common),
            ),
            (
                "anthropicMessages",
                self.anthropic_messages.as_ref().map(|s| &s.common),
            ),
        ] {
            if common.is_some_and(|surface| surface.stream_usage.is_some()) {
                return Err(format!(
                    "surface `{name}` cannot declare streamUsage; it applies to openaiChatCompletions only"
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceCapabilities {
    pub source: CapabilitySource,
    pub confidence: CapabilityConfidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_images: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_images: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_video: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_video: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_config: Option<ReasoningConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub beta_features: Vec<String>,
    /// Chat Completions only: `false` marks an endpoint that rejects
    /// `stream_options.include_usage`, so adapted streams omit it. Absent means true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_usage: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReasoningConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_levels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<ReasoningEncoding>,
}

impl ReasoningConfig {
    fn validate(&self, surface: &str, anthropic: bool) -> std::result::Result<(), String> {
        const LEVELS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
        if self.supported_levels.is_none()
            && self.default_level.is_none()
            && self.encoding.is_none()
        {
            return Err(format!(
                "surface `{surface}` reasoningConfig cannot be empty"
            ));
        }
        if let Some(levels) = &self.supported_levels {
            if levels.is_empty() || levels.len() > LEVELS.len() {
                return Err(format!(
                    "surface `{surface}` reasoningConfig supportedLevels must contain 1 to 7 levels"
                ));
            }
            let mut seen = std::collections::HashSet::new();
            for level in levels {
                if !LEVELS.contains(&level.as_str()) || !seen.insert(level) {
                    return Err(format!(
                        "surface `{surface}` has invalid or duplicate reasoning level `{level}`"
                    ));
                }
            }
            if let Some(default_level) = &self.default_level
                && !levels.contains(default_level)
            {
                return Err(format!(
                    "surface `{surface}` defaultLevel must be in supportedLevels"
                ));
            }
        } else if let Some(default_level) = &self.default_level
            && !LEVELS.contains(&default_level.as_str())
        {
            return Err(format!(
                "surface `{surface}` has invalid reasoning defaultLevel `{default_level}`"
            ));
        }
        if let Some(encoding) = &self.encoding {
            if encoding.is_anthropic() != anthropic {
                return Err(format!(
                    "surface `{surface}` has an encoding for the wrong protocol family"
                ));
            }
            if let ReasoningEncoding::AnthropicThinking {
                budget_by_level: Some(budgets),
            } = encoding
            {
                for (level, budget) in budgets {
                    if !LEVELS.contains(&level.as_str())
                        || *budget < 1024
                        || *budget > ANTHROPIC_THINKING_BUDGET_MAX
                    {
                        return Err(format!(
                            "surface `{surface}` has invalid thinking budget for `{level}`"
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReasoningEncoding {
    OpenaiReasoningEffort,
    OpenaiReasoningObject,
    OpenaiOutputConfigEffort,
    OpenaiTopLevelEffort,
    AnthropicThinking {
        #[serde(rename = "budgetByLevel", skip_serializing_if = "Option::is_none")]
        budget_by_level: Option<std::collections::BTreeMap<String, u64>>,
    },
    AnthropicAdaptiveThinking,
    AnthropicOutputConfigEffort,
}

impl ReasoningEncoding {
    fn is_anthropic(&self) -> bool {
        matches!(
            self,
            Self::AnthropicThinking { .. }
                | Self::AnthropicAdaptiveThinking
                | Self::AnthropicOutputConfigEffort
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnthropicSurfaceCapabilities {
    #[serde(flatten)]
    pub common: SurfaceCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_tokens: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protocol_versions: Vec<AnthropicProtocolVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnthropicProtocolVersion {
    pub version: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub beta_features: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsesSurfaceCapabilities {
    #[serde(flatten)]
    pub common: SurfaceCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responses_lifecycle: Option<ResponsesLifecycleCapabilities>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsesLifecycleCapabilities {
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
pub struct EmbeddingsCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<crate::wire::protocol::runtime_spec::EmbeddingContract>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realtime: Option<RealtimeTranscriptionCapabilities>,
}

/// The engine bridge a live `/v1/realtime` transcription session uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RealtimeAdapter {
    /// vLLM's own `/v1/realtime` protocol: deltas while the person speaks.
    Vllm,
    /// Each committed turn goes to the endpoint's file transcription route.
    Segmented,
}

/// Live transcription an endpoint advertises (the server's strict
/// `realtimeTranscriptionCapabilitiesSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RealtimeTranscriptionCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    pub adapter: RealtimeAdapter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_item_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_sessions: Option<u32>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_round_trips_reasoning_config() {
        let valid = serde_json::json!({
            "version": 4,
            "protocol": "openai-compatible",
            "surfaces": {
                "openaiChatCompletions": {
                    "source": "provider",
                    "confidence": "exact",
                    "operations": ["create"],
                    "reasoning": true,
                    "reasoningConfig": {
                        "supportedLevels": ["none", "low"],
                        "defaultLevel": "low",
                        "encoding": { "kind": "openai_reasoning_effort" }
                    }
                }
            }
        });
        let parsed: OpenAiCompatibleCapabilities =
            serde_json::from_value(valid).expect("valid reasoning config");
        let serialized = serde_json::to_value(parsed).expect("serialize reasoning config");
        assert_eq!(
            serialized["surfaces"]["openaiChatCompletions"]["reasoningConfig"]["defaultLevel"],
            "low"
        );

        for invalid in [
            serde_json::json!({
                "version": 4, "protocol": "openai-compatible", "surfaces": {
                    "openaiChatCompletions": {
                        "source": "provider", "confidence": "exact", "operations": ["create"],
                        "reasoning": true, "reasoningConfig": { "encoding": { "kind": "anthropic_thinking" } }
                    }
                }
            }),
            serde_json::json!({
                "version": 4, "protocol": "openai-compatible", "surfaces": {
                    "openaiChatCompletions": {
                        "source": "provider", "confidence": "exact", "operations": ["create"],
                        "reasoning": true, "reasoningConfig": { "extra": true }
                    }
                }
            }),
        ] {
            assert!(serde_json::from_value::<OpenAiCompatibleCapabilities>(invalid).is_err());
        }
    }

    #[test]
    fn mirrors_reasoning_contract_validation_across_versions_and_families() {
        for valid in [
            serde_json::json!({ "version": 3, "protocol": "openai-compatible", "surfaces": {
                "openaiChatCompletions": {
                    "source": "provider", "confidence": "exact", "supported": true, "reasoning": true,
                    "reasoningConfig": { "encoding": { "kind": "openai_reasoning_effort" } }
                }
            }}),
            serde_json::json!({ "version": 4, "protocol": "openai-compatible", "surfaces": {
                "openaiChatCompletions": {
                    "source": "provider", "confidence": "exact", "operations": ["create"], "reasoning": true,
                    "reasoningConfig": { "encoding": { "kind": "openai_reasoning_effort" } }
                }
            }}),
            serde_json::json!({ "version": 3, "protocol": "anthropic-compatible", "surfaces": {
                "anthropicMessages": {
                    "source": "provider", "confidence": "exact", "supported": true, "reasoning": true,
                    "reasoningConfig": { "encoding": { "kind": "anthropic_thinking", "budgetByLevel": { "low": 2048 } } }
                }
            }}),
            serde_json::json!({ "version": 4, "protocol": "anthropic-compatible", "surfaces": {
                "anthropicMessages": {
                    "source": "provider", "confidence": "exact", "operations": ["create"],
                    "protocolVersions": [{ "version": "2023-06-01" }], "reasoning": true,
                    "reasoningConfig": { "encoding": { "kind": "anthropic_thinking", "budgetByLevel": { "low": 2048 } } }
                }
            }}),
        ] {
            let parsed = serde_json::from_value::<OpenAiCompatibleCapabilities>(valid)
                .expect("valid cross-language reasoning contract");
            let serialized = serde_json::to_value(parsed).expect("serialize reasoning config");
            if let Some(anthropic) = serialized.pointer("/surfaces/anthropicMessages") {
                assert_eq!(
                    anthropic.pointer("/reasoningConfig/encoding/budgetByLevel"),
                    Some(&serde_json::json!({ "low": 2048 })),
                );
            }
        }

        let max_budget = serde_json::json!({ "version": 4, "protocol": "anthropic-compatible", "surfaces": {
            "anthropicMessages": {
                "source": "provider", "confidence": "exact", "operations": ["create"],
                "protocolVersions": [{ "version": "2023-06-01" }], "reasoning": true,
                "reasoningConfig": { "encoding": { "kind": "anthropic_thinking", "budgetByLevel": { "max": ANTHROPIC_THINKING_BUDGET_MAX } } }
            }
        }});
        assert!(serde_json::from_value::<OpenAiCompatibleCapabilities>(max_budget).is_ok());

        let invalids = [
            // Both encoding-family directions, for v3 and v4 surface shapes.
            serde_json::json!({ "version": 3, "protocol": "openai-compatible", "surfaces": {
                "openaiChatCompletions": { "source": "provider", "confidence": "exact", "supported": true, "reasoning": true, "reasoningConfig": { "encoding": { "kind": "anthropic_thinking" } } }
            }}),
            serde_json::json!({ "version": 4, "protocol": "anthropic-compatible", "surfaces": {
                "anthropicMessages": { "source": "provider", "confidence": "exact", "operations": ["create"], "protocolVersions": [{ "version": "2023-06-01" }], "reasoning": true, "reasoningConfig": { "encoding": { "kind": "openai_reasoning_effort" } } }
            }}),
            serde_json::json!({ "version": 3, "protocol": "openai-compatible", "surfaces": {
                "openaiChatCompletions": { "source": "provider", "confidence": "exact", "supported": true, "reasoningConfig": { "supportedLevels": ["low"] } }
            }}),
            serde_json::json!({ "version": 4, "protocol": "openai-compatible", "surfaces": {
                "openaiChatCompletions": { "source": "provider", "confidence": "exact", "operations": ["create"], "reasoning": true, "reasoningConfig": { "supportedLevels": ["low", "low"] } }
            }}),
            serde_json::json!({ "version": 3, "protocol": "anthropic-compatible", "surfaces": {
                "anthropicMessages": { "source": "provider", "confidence": "exact", "supported": true, "reasoning": true, "reasoningConfig": { "supportedLevels": ["low"], "defaultLevel": "high" } }
            }}),
            serde_json::json!({ "version": 4, "protocol": "anthropic-compatible", "surfaces": {
                "anthropicMessages": { "source": "provider", "confidence": "exact", "operations": ["create"], "protocolVersions": [{ "version": "2023-06-01" }], "reasoning": true, "reasoningConfig": { "encoding": { "kind": "anthropic_thinking", "budgetByLevel": { "low": 1 } } } }
            }}),
            serde_json::json!({ "version": 4, "protocol": "anthropic-compatible", "surfaces": {
                "anthropicMessages": { "source": "provider", "confidence": "exact", "operations": ["create"], "protocolVersions": [{ "version": "2023-06-01" }], "reasoning": true, "reasoningConfig": { "encoding": { "kind": "anthropic_thinking", "budgetByLevel": { "low": ANTHROPIC_THINKING_BUDGET_MAX + 1 } } } }
            }}),
        ];
        for invalid in invalids {
            assert!(serde_json::from_value::<OpenAiCompatibleCapabilities>(invalid).is_err());
        }
    }

    #[test]
    fn removed_completions_capability_keys_are_rejected_by_name() {
        for (key, value) in [
            (
                "completions",
                serde_json::json!({ "version": 1, "protocol": "openai-compatible", "completions": { "supported": true } }),
            ),
            (
                "openaiCompletions",
                serde_json::json!({ "version": 3, "protocol": "openai-compatible", "surfaces": { "openaiCompletions": { "supported": true } } }),
            ),
        ] {
            let error = serde_json::from_value::<OpenAiCompatibleCapabilities>(value)
                .expect_err("removed capability");
            assert!(error.to_string().contains(key), "{error}");
        }
    }

    #[test]
    fn accepts_stream_usage_on_the_chat_surface_only() {
        let inventory = |surfaces: serde_json::Value, protocol: &str| {
            serde_json::from_value::<OpenAiCompatibleCapabilities>(serde_json::json!({
                "version": 4, "protocol": protocol, "surfaces": surfaces
            }))
        };
        for stream_usage in [false, true] {
            let parsed = inventory(
                serde_json::json!({ "openaiChatCompletions": {
                    "source": "declared", "confidence": "exact",
                    "operations": ["create"], "streamUsage": stream_usage
                }}),
                "openai-compatible",
            )
            .expect("chat streamUsage");
            let chat = parsed
                .surfaces
                .as_ref()
                .and_then(|surfaces| surfaces.openai_chat_completions.as_ref())
                .expect("chat surface");
            assert_eq!(chat.stream_usage, Some(stream_usage));
            let written = serde_json::to_value(&parsed).expect("serialize");
            assert_eq!(
                written["surfaces"]["openaiChatCompletions"]["streamUsage"],
                stream_usage
            );
        }
        let absent = inventory(
            serde_json::json!({ "openaiChatCompletions": {
                "source": "declared", "confidence": "exact", "operations": ["create"]
            }}),
            "openai-compatible",
        )
        .expect("chat without streamUsage");
        let written = serde_json::to_value(&absent).expect("serialize");
        assert!(
            written["surfaces"]["openaiChatCompletions"]
                .get("streamUsage")
                .is_none()
        );
        assert!(
            inventory(
                serde_json::json!({ "openaiResponses": {
                    "source": "declared", "confidence": "exact",
                    "operations": ["create"], "streamUsage": false
                }}),
                "openai-compatible",
            )
            .is_err()
        );
        assert!(
            inventory(
                serde_json::json!({ "anthropicMessages": {
                    "source": "declared", "confidence": "exact", "operations": ["create"],
                    "protocolVersions": [{ "version": "2023-06-01" }], "streamUsage": false
                }}),
                "anthropic-compatible",
            )
            .is_err()
        );
        assert!(
            inventory(
                serde_json::json!({ "anthropicMessages": {
                    "source": "declared", "confidence": "exact", "operations": ["create"],
                    "protocolVersions": [{ "version": "2023-06-01" }]
                }}),
                "anthropic-compatible",
            )
            .is_ok()
        );
    }

    #[test]
    fn rejects_v1_v2_surfaces_and_never_serializes_them() {
        for version in [1, 2] {
            assert!(
                serde_json::from_value::<OpenAiCompatibleCapabilities>(serde_json::json!({
                    "version": version, "protocol": "openai-compatible", "surfaces": {}
                }))
                .is_err()
            );
        }
        let legacy = OpenAiCompatibleCapabilities {
            surfaces: Some(SurfaceInventory::default()),
            ..OpenAiCompatibleCapabilities::default()
        };
        let serialized = serde_json::to_value(legacy).expect("serialize legacy inventory");
        assert!(serialized.get("surfaces").is_none());
    }

    #[test]
    fn validates_exact_v4_operations_and_anthropic_versions() {
        let valid = serde_json::json!({
            "version": 4,
            "protocol": "anthropic-compatible",
            "surfaces": {
                "anthropicMessages": {
                    "source": "provider",
                    "confidence": "exact",
                    "operations": ["create", "countTokens"],
                    "streaming": true,
                    "protocolVersions": [{
                        "version": "2023-06-01",
                        "betaFeatures": ["prompt-caching-2024-07-31"]
                    }]
                }
            }
        });
        let parsed: OpenAiCompatibleCapabilities =
            serde_json::from_value(valid.clone()).expect("valid v4 inventory");
        assert_eq!(parsed.version, 4);

        for invalid in [
            serde_json::json!({
                "version": 4,
                "protocol": "anthropic-compatible",
                "surfaces": { "anthropicMessages": {
                    "source": "provider", "confidence": "exact",
                    "operations": ["unknown"],
                    "protocolVersions": [{"version": "2023-06-01"}]
                }}
            }),
            serde_json::json!({
                "version": 4,
                "protocol": "anthropic-compatible",
                "surfaces": { "anthropicMessages": {
                    "source": "provider", "confidence": "exact",
                    "operations": ["create", "create"],
                    "protocolVersions": [{"version": "2023-06-01"}]
                }}
            }),
            serde_json::json!({
                "version": 4,
                "protocol": "anthropic-compatible",
                "surfaces": { "anthropicMessages": {
                    "source": "provider", "confidence": "exact",
                    "operations": ["create"]
                }}
            }),
            serde_json::json!({
                "version": 4,
                "protocol": "anthropic-compatible",
                "surfaces": { "anthropicMessages": {
                    "source": "provider", "confidence": "exact",
                    "operations": ["create"],
                    "protocolVersions": [{
                        "version": "2023-06-01",
                        "betaFeatures": ["beta-one", " beta-one "]
                    }]
                }}
            }),
            serde_json::json!({
                "version": 4,
                "protocol": "openai-compatible",
                "surfaces": { "anthropicMessages": {
                    "source": "provider", "confidence": "exact",
                    "operations": ["create"],
                    "protocolVersions": [{"version": "2023-06-01"}]
                }}
            }),
            serde_json::json!({
                "version": 4,
                "protocol": "anthropic-compatible",
                "surfaces": { "openaiResponses": {
                    "source": "provider", "confidence": "exact",
                    "operations": ["create"]
                }}
            }),
        ] {
            assert!(serde_json::from_value::<OpenAiCompatibleCapabilities>(invalid).is_err());
        }
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
                    "source": "declared",
                    "confidence": "exact",
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
            serde_json::json!({ "version": 1, "protocol": "anthropic-compatible" }),
            serde_json::json!({ "version": 2, "protocol": "anthropic-compatible" }),
        ] {
            assert!(serde_json::from_value::<OpenAiCompatibleCapabilities>(invalid).is_err());
        }
    }

    #[test]
    fn matches_shared_v3_wire_fixtures() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/fixtures/capabilities-v3-wire.json"
        ))
        .expect("shared capability fixture");
        for valid in fixture["valid"].as_array().expect("valid fixtures") {
            let parsed = serde_json::from_value::<OpenAiCompatibleCapabilities>(valid.clone())
                .expect("valid TS/Rust fixture");
            let serialized = serde_json::to_value(&parsed).expect("serialize valid fixture");
            assert_eq!(serialized, *valid, "Rust wire output stays sparse");
            assert!(
                !serialized.to_string().contains(":null"),
                "Rust capability profiles must omit absent optional fields"
            );
            let round_trip: OpenAiCompatibleCapabilities =
                serde_json::from_value(serialized).expect("round-trip serialized profile");
            assert_eq!(round_trip, parsed);
        }
        for invalid in fixture["invalid"].as_array().expect("invalid fixtures") {
            assert!(
                serde_json::from_value::<OpenAiCompatibleCapabilities>(invalid.clone()).is_err()
            );
        }
    }
}
