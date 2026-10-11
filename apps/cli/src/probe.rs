//! OpenAI-compatible endpoint probing.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::{
    CapabilityConfidence, CapabilityOverrideMode, CapabilitySource, EndpointConfig,
    OpenAiCompatibleCapabilities, ProbeStatus, ReasoningConfig, SurfaceCapabilities,
    SurfaceInventory,
};
use crate::slug::slugify_seed;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub endpoint_slug: String,
    pub status: ProbeStatus,
    pub discovered_model_ids: Vec<String>,
    pub suggested_default_capabilities: OpenAiCompatibleCapabilities,
    pub model_suggestions: Vec<ModelSuggestion>,
    pub error: Option<String>,
    /// Engine detection result (online probes only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<crate::engine::DetectedEngine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSuggestion {
    pub upstream_model_id: String,
    pub slug: String,
    pub capability_override_mode: CapabilityOverrideMode,
    pub capabilities: OpenAiCompatibleCapabilities,
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelRow>,
}

#[derive(Debug, Default, Deserialize)]
struct ModelRow {
    id: String,
    #[serde(default)]
    supports_vision: Option<bool>,
    #[serde(default)]
    supports_video_input: Option<bool>,
    #[serde(default)]
    supports_audio_input: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_advisory_option")]
    supports_reasoning: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_advisory_option")]
    capabilities: Option<UpstreamCapabilityFlags>,
    #[serde(default)]
    architecture: Option<UpstreamArchitecture>,
    #[serde(default, deserialize_with = "deserialize_advisory_option")]
    supported_parameters: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_advisory_option")]
    reasoning: Option<UpstreamReasoning>,
    #[serde(default, deserialize_with = "deserialize_advisory_option")]
    model_spec: Option<UpstreamModelSpec>,
    /// vLLM reports each served model's context limit.
    #[serde(default, deserialize_with = "deserialize_advisory_option")]
    max_model_len: Option<u64>,
}

/// Discovery metadata is advisory: a malformed optional hint must not make an
/// otherwise valid `/v1/models` response fail the endpoint probe.
fn deserialize_advisory_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

#[derive(Debug, Default, Deserialize)]
struct UpstreamCapabilityFlags {
    #[serde(default)]
    vision: Option<bool>,
    #[serde(default)]
    video_input: Option<bool>,
    #[serde(default)]
    audio_input: Option<bool>,
    #[serde(default)]
    reasoning: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UpstreamArchitecture {
    #[serde(default)]
    input_modalities: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
struct UpstreamReasoning {
    #[serde(default, alias = "supportedEfforts")]
    supported_efforts: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamModelSpec {
    #[serde(default)]
    capabilities: Option<UpstreamCapabilityFlags>,
}

pub fn probe_endpoint(endpoint: &EndpointConfig) -> ProbeReport {
    match try_probe_endpoint(endpoint) {
        Ok(mut report) => {
            report.endpoint_slug = endpoint.slug.clone();
            report
        }
        Err(error) => ProbeReport {
            endpoint_slug: endpoint.slug.clone(),
            status: ProbeStatus::Offline,
            discovered_model_ids: Vec::new(),
            suggested_default_capabilities: endpoint.default_capabilities.clone(),
            model_suggestions: Vec::new(),
            error: Some(error.to_string()),
            engine: None,
        },
    }
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

fn try_probe_endpoint(endpoint: &EndpointConfig) -> Result<ProbeReport> {
    let url = models_url(&endpoint.base_url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .max_redirects(0)
        .build()
        .into();
    let request = agent.get(url.as_str()).header("Accept", "application/json");
    let mut response = with_endpoint_auth(request, endpoint)?
        .call()
        .with_context(|| format!("probing endpoint `{}`", endpoint.slug))?;
    let models = response
        .body_mut()
        .read_json::<ModelsResponse>()
        .with_context(|| format!("parsing model list from endpoint `{}`", endpoint.slug))?;
    let rows: Vec<ModelRow> = models
        .data
        .into_iter()
        .filter(|model| !model.id.trim().is_empty())
        .collect();
    let discovered_model_ids = rows
        .iter()
        .map(|model| model.id.clone())
        .collect::<Vec<_>>();
    let model_suggestions = rows
        .iter()
        .filter_map(suggest_model_from_upstream)
        .collect();
    let model_limits = rows
        .iter()
        .map(|row| (row.id.clone(), row.max_model_len))
        .collect::<Vec<_>>();
    let mut engine = crate::engine::detect_engine(endpoint, &model_limits);
    let model = rows.first().map(|row| row.id.as_str());
    // A definition's reader `countRoute` joins the probe with the runtime
    // metrics reader (C4); until then only the built-in engine routes count.
    engine.count_context = Some(crate::count_context::probe_count_context(
        endpoint,
        engine.kind,
        model,
        None,
    ));
    Ok(ProbeReport {
        endpoint_slug: endpoint.slug.clone(),
        status: ProbeStatus::Online,
        discovered_model_ids,
        suggested_default_capabilities: endpoint.default_capabilities.clone(),
        model_suggestions,
        error: None,
        engine: Some(engine),
    })
}

/// `request` with the endpoint's header and auth credentials (node secrets).
pub(crate) fn with_endpoint_auth(
    mut request: ureq::RequestBuilder<ureq::typestate::WithoutBody>,
    endpoint: &EndpointConfig,
) -> Result<ureq::RequestBuilder<ureq::typestate::WithoutBody>> {
    for header in &endpoint.headers {
        let value = crate::secrets::credential(&header.env).with_context(|| {
            format!(
                "reading endpoint header `{}` from `{}`",
                header.name, header.env
            )
        })?;
        request = request.header(&header.name, &value);
    }
    if let Some(auth) = &endpoint.auth {
        let value = crate::secrets::credential(&auth.env)
            .with_context(|| format!("reading typed endpoint credential from `{}`", auth.env))?;
        request = match auth.mode {
            crate::config::EndpointAuthMode::ApiKey => request.header("x-api-key", &value),
            crate::config::EndpointAuthMode::Bearer => {
                request.header("authorization", &format!("Bearer {value}"))
            }
        };
    }
    Ok(request)
}

pub(crate) fn models_url(base_url: &str) -> Result<Url> {
    let mut base =
        Url::parse(base_url).with_context(|| format!("parsing endpoint URL `{base_url}`"))?;
    let path = base.path().trim_end_matches('/').to_string();
    if path.ends_with("/v1/models") || path.ends_with("/models") {
        return Ok(base);
    }
    let joined = if path.ends_with("/v1") {
        "models"
    } else {
        "v1/models"
    };
    if !base.path().ends_with('/') {
        let next = format!("{}/", base.path());
        base.set_path(&next);
    }
    base.join(joined)
        .with_context(|| format!("building model-list URL for `{base_url}`"))
}

fn modality_flag(value: Option<bool>) -> bool {
    value == Some(true)
}

fn architecture_has(architecture: &Option<UpstreamArchitecture>, modality: &str) -> bool {
    architecture
        .as_ref()
        .and_then(|value| value.input_modalities.as_ref())
        .is_some_and(|modalities| {
            modalities
                .iter()
                .any(|item| item.eq_ignore_ascii_case(modality))
        })
}

/// Suggestions come only from upstream model-list metadata, never from the model id.
fn suggest_model_from_upstream(row: &ModelRow) -> Option<ModelSuggestion> {
    let vision = modality_flag(row.supports_vision)
        || row
            .capabilities
            .as_ref()
            .is_some_and(|caps| modality_flag(caps.vision))
        || architecture_has(&row.architecture, "image");
    let video = modality_flag(row.supports_video_input)
        || row
            .capabilities
            .as_ref()
            .is_some_and(|caps| modality_flag(caps.video_input))
        || architecture_has(&row.architecture, "video");
    let audio = modality_flag(row.supports_audio_input)
        || row
            .capabilities
            .as_ref()
            .is_some_and(|caps| modality_flag(caps.audio_input))
        || architecture_has(&row.architecture, "audio");
    let reasoning = upstream_declares_reasoning(row);
    if !vision && !video && !audio && !reasoning {
        return None;
    }
    if reasoning {
        return Some(ModelSuggestion {
            upstream_model_id: row.id.clone(),
            slug: slugify_seed(&row.id, "model"),
            capability_override_mode: CapabilityOverrideMode::Inherit,
            capabilities: reasoning_capabilities(vision, video, audio, reasoning_levels(row)),
        });
    }
    let mut capabilities = OpenAiCompatibleCapabilities::openai_defaults();
    if vision {
        capabilities = capabilities.with_vision();
    }
    if video {
        capabilities = capabilities.with_video();
    }
    if audio {
        capabilities = capabilities.with_chat_audio();
    }
    Some(ModelSuggestion {
        upstream_model_id: row.id.clone(),
        slug: slugify_seed(&row.id, "model"),
        capability_override_mode: CapabilityOverrideMode::Inherit,
        capabilities,
    })
}

const CANONICAL_REASONING_LEVELS: [&str; 7] =
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

fn upstream_declares_reasoning(row: &ModelRow) -> bool {
    modality_flag(row.supports_reasoning)
        || row
            .capabilities
            .as_ref()
            .is_some_and(|caps| modality_flag(caps.reasoning))
        || row.supported_parameters.as_ref().is_some_and(|parameters| {
            parameters.iter().any(|parameter| {
                matches!(
                    parameter.as_str(),
                    "reasoning" | "reasoning_effort" | "include_reasoning"
                )
            })
        })
        || row.model_spec.as_ref().is_some_and(|spec| {
            spec.capabilities
                .as_ref()
                .is_some_and(|caps| modality_flag(caps.reasoning))
        })
}

fn reasoning_levels(row: &ModelRow) -> Option<Vec<String>> {
    let reported = row
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.supported_efforts.as_ref())?;
    let levels = CANONICAL_REASONING_LEVELS
        .iter()
        .filter(|level| {
            reported
                .iter()
                .any(|reported_level| reported_level == **level)
        })
        .map(|level| (*level).to_string())
        .collect::<Vec<_>>();
    (!levels.is_empty()).then_some(levels)
}

fn reasoning_capabilities(
    vision: bool,
    video: bool,
    audio: bool,
    supported_levels: Option<Vec<String>>,
) -> OpenAiCompatibleCapabilities {
    OpenAiCompatibleCapabilities {
        version: 4,
        protocol: "openai-compatible".to_string(),
        surfaces: Some(SurfaceInventory {
            openai_chat_completions: Some(SurfaceCapabilities {
                source: CapabilitySource::Probe,
                confidence: CapabilityConfidence::High,
                supported: None,
                operations: vec!["create".to_string()],
                streaming: Some(true),
                max_context_tokens: None,
                input_images: vision.then_some(true),
                output_images: None,
                input_audio: audio.then_some(true),
                output_audio: None,
                input_video: video.then_some(true),
                output_video: None,
                tools: None,
                parallel_tools: None,
                structured_output: None,
                reasoning: Some(true),
                reasoning_config: supported_levels.map(|supported_levels| ReasoningConfig {
                    supported_levels: Some(supported_levels),
                    default_level: None,
                    encoding: None,
                }),
                hosted_tools: None,
                protocol_version: None,
                beta_features: Vec::new(),
                stream_usage: None,
            }),
            ..SurfaceInventory::default()
        }),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_model_url_from_base_v1() {
        assert_eq!(
            models_url("http://localhost:11434/v1")
                .expect("url")
                .as_str(),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn does_not_infer_modalities_from_model_id() {
        assert!(
            suggest_model_from_upstream(&ModelRow {
                id: "media-describe-omni".to_string(),
                ..ModelRow::default()
            })
            .is_none()
        );
    }

    #[test]
    fn suggests_modalities_from_upstream_metadata_only() {
        let suggestion = suggest_model_from_upstream(&ModelRow {
            id: "plain-name".to_string(),
            supports_vision: Some(true),
            ..ModelRow::default()
        })
        .expect("suggestion");
        assert_eq!(
            suggestion.capabilities.chat_completions.unwrap().vision,
            Some(true)
        );
    }

    #[test]
    fn does_not_infer_reasoning_from_model_id() {
        assert!(
            suggest_model_from_upstream(&ModelRow {
                id: "deepseek-r1-thinking".to_string(),
                ..ModelRow::default()
            })
            .is_none()
        );
    }

    #[test]
    fn suggests_v4_reasoning_from_allowlisted_openrouter_metadata() {
        let suggestion = suggest_model_from_upstream(&ModelRow {
            id: "provider/reasoner".to_string(),
            supports_vision: Some(true),
            supported_parameters: Some(vec!["reasoning_effort".to_string()]),
            reasoning: Some(UpstreamReasoning {
                supported_efforts: Some(vec![
                    "high".to_string(),
                    "not-a-level".to_string(),
                    "low".to_string(),
                    "high".to_string(),
                ]),
            }),
            ..ModelRow::default()
        })
        .expect("suggestion");

        assert_eq!(suggestion.capabilities.version, 4);
        assert!(suggestion.capabilities.chat_completions.is_none());
        let surface = suggestion
            .capabilities
            .surfaces
            .as_ref()
            .and_then(|surfaces| surfaces.openai_chat_completions.as_ref())
            .expect("v4 chat completions surface");
        assert_eq!(surface.source, CapabilitySource::Probe);
        assert_eq!(surface.confidence, CapabilityConfidence::High);
        assert_eq!(surface.operations, ["create"]);
        assert_eq!(surface.input_images, Some(true));
        assert_eq!(surface.reasoning, Some(true));
        assert_eq!(
            surface
                .reasoning_config
                .as_ref()
                .and_then(|config| config.supported_levels.as_ref()),
            Some(&vec!["low".to_string(), "high".to_string()])
        );
    }

    #[test]
    fn suggests_v4_reasoning_from_allowlisted_venice_metadata() {
        let suggestion = suggest_model_from_upstream(&ModelRow {
            id: "venice-reasoner".to_string(),
            model_spec: Some(UpstreamModelSpec {
                capabilities: Some(UpstreamCapabilityFlags {
                    reasoning: Some(true),
                    ..UpstreamCapabilityFlags::default()
                }),
            }),
            ..ModelRow::default()
        })
        .expect("suggestion");

        let surface = suggestion
            .capabilities
            .surfaces
            .as_ref()
            .and_then(|surfaces| surfaces.openai_chat_completions.as_ref())
            .expect("v4 chat completions surface");
        assert_eq!(suggestion.capabilities.version, 4);
        assert_eq!(surface.reasoning, Some(true));
        assert!(surface.reasoning_config.is_none());
    }

    #[test]
    fn non_reasoning_metadata_does_not_create_reasoning_suggestion() {
        let suggestion = suggest_model_from_upstream(&ModelRow {
            id: "plain-name".to_string(),
            supports_vision: Some(true),
            supported_parameters: Some(vec!["temperature".to_string()]),
            ..ModelRow::default()
        })
        .expect("modality suggestion");

        assert_eq!(suggestion.capabilities.version, 1);
        assert!(suggestion.capabilities.surfaces.is_none());
    }

    #[test]
    fn deserializes_exact_reasoning_allowlist_without_regressing_snake_case_modalities() {
        let rows: Vec<ModelRow> = serde_json::from_value(serde_json::json!([
            {
                "id": "root-flag",
                "supports_reasoning": true,
                "supports_video_input": true,
                "supports_audio_input": true
            },
            {
                "id": "capabilities-flag",
                "capabilities": { "reasoning": true }
            },
            {
                "id": "parameters-flag",
                "supported_parameters": ["include_reasoning"]
            },
            {
                "id": "venice-flag",
                "model_spec": { "capabilities": { "reasoning": true } }
            }
        ]))
        .expect("allowlisted model rows deserialize");

        let root_suggestion = suggest_model_from_upstream(&rows[0]).expect("root flag suggestion");
        let root_surface = root_suggestion
            .capabilities
            .surfaces
            .as_ref()
            .and_then(|surfaces| surfaces.openai_chat_completions.as_ref())
            .expect("reasoning surface");
        assert_eq!(root_surface.input_video, Some(true));
        assert_eq!(root_surface.input_audio, Some(true));
        assert!(
            rows[1..]
                .iter()
                .all(|row| suggest_model_from_upstream(row).is_some())
        );
    }

    #[test]
    fn reasoning_effort_list_enriches_but_does_not_enable_reasoning() {
        assert!(
            suggest_model_from_upstream(&ModelRow {
                id: "plain-name".to_string(),
                reasoning: Some(UpstreamReasoning {
                    supported_efforts: Some(vec!["low".to_string()]),
                }),
                ..ModelRow::default()
            })
            .is_none()
        );
    }

    #[test]
    fn ignores_malformed_advisory_reasoning_metadata() {
        let rows: Vec<ModelRow> = serde_json::from_value(serde_json::json!([
            {
                "id": "still-reasoning",
                "supports_reasoning": true,
                "capabilities": "not-an-object",
                "supported_parameters": ["reasoning", 1],
                "reasoning": true,
                "model_spec": []
            },
            {
                "id": "malformed-only",
                "supports_reasoning": "yes",
                "supported_parameters": "reasoning",
                "reasoning": { "supported_efforts": ["low", 1] }
            }
        ]))
        .expect("malformed advisory metadata is ignored");

        let suggestion = suggest_model_from_upstream(&rows[0]).expect("root flag survives");
        let surface = suggestion
            .capabilities
            .surfaces
            .as_ref()
            .and_then(|surfaces| surfaces.openai_chat_completions.as_ref())
            .expect("reasoning surface");
        assert!(surface.reasoning_config.is_none());
        assert!(suggest_model_from_upstream(&rows[1]).is_none());
    }
}
