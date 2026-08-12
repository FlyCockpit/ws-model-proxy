//! OpenAI-compatible endpoint probing.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::{
    CapabilityOverrideMode, Config, EndpointConfig, ModelConfig, OpenAiCompatibleCapabilities,
    ProbeSnapshot, ProbeStatus,
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

#[derive(Debug, Deserialize)]
struct ModelRow {
    id: String,
    #[serde(default)]
    supports_vision: Option<bool>,
    #[serde(default)]
    supports_video_input: Option<bool>,
    #[serde(default)]
    supports_audio_input: Option<bool>,
    #[serde(default)]
    capabilities: Option<UpstreamCapabilityFlags>,
    #[serde(default)]
    architecture: Option<UpstreamArchitecture>,
}

#[derive(Debug, Deserialize)]
struct UpstreamCapabilityFlags {
    #[serde(default)]
    vision: Option<bool>,
    #[serde(default)]
    video_input: Option<bool>,
    #[serde(default)]
    audio_input: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UpstreamArchitecture {
    #[serde(default)]
    input_modalities: Option<Vec<String>>,
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
        },
    }
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

fn try_probe_endpoint(endpoint: &EndpointConfig) -> Result<ProbeReport> {
    let url = models_url(&endpoint.base_url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .build()
        .into();
    let mut request = agent.get(url.as_str()).header("Accept", "application/json");
    for header in &endpoint.headers {
        let value = std::env::var(&header.env).with_context(|| {
            format!(
                "reading endpoint header `{}` from `{}`",
                header.name, header.env
            )
        })?;
        request = request.header(&header.name, &value);
    }
    let mut response = request
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
    let discovered_model_ids = rows.iter().map(|model| model.id.clone()).collect::<Vec<_>>();
    let model_suggestions = rows.iter().filter_map(suggest_model_from_upstream).collect();
    Ok(ProbeReport {
        endpoint_slug: endpoint.slug.clone(),
        status: ProbeStatus::Online,
        discovered_model_ids,
        suggested_default_capabilities: endpoint.default_capabilities.clone(),
        model_suggestions,
        error: None,
    })
}

pub fn apply_probe_report(
    config: &mut Config,
    report: &ProbeReport,
    replace: bool,
) -> Result<()> {
    let Some(endpoint) = config.endpoint_mut(&report.endpoint_slug) else {
        anyhow::bail!("endpoint `{}` no longer exists", report.endpoint_slug);
    };
    if report.status == ProbeStatus::Online {
        endpoint.last_probe = Some(ProbeSnapshot {
            status: ProbeStatus::Online,
            models: report.discovered_model_ids.clone(),
            suggested_capabilities: endpoint.default_capabilities.clone(),
        });
        let discovered: std::collections::HashSet<&str> = report
            .discovered_model_ids
            .iter()
            .map(String::as_str)
            .collect();
        let mut next_models: Vec<ModelConfig> = if replace {
            endpoint
                .models
                .iter()
                .filter(|model| discovered.contains(model.upstream_model_id.as_str()) || model.pinned)
                .cloned()
                .collect()
        } else {
            endpoint.models.clone()
        };
        for model_id in &report.discovered_model_ids {
            if !next_models
                .iter()
                .any(|model| model.upstream_model_id == *model_id)
            {
                next_models.push(ModelConfig {
                    slug: Some(slugify_seed(model_id, "model")),
                    upstream_model_id: model_id.clone(),
                    ..ModelConfig::default()
                });
            }
        }
        for suggestion in &report.model_suggestions {
            if let Some(model) = next_models
                .iter_mut()
                .find(|model| model.upstream_model_id == suggestion.upstream_model_id)
            {
                model.slug = model.slug.clone().or_else(|| Some(suggestion.slug.clone()));
                model.probe_suggestions = Some(suggestion.capabilities.clone());
            }
        }
        endpoint.models = next_models;
    } else {
        endpoint.last_probe = Some(ProbeSnapshot {
            status: ProbeStatus::Offline,
            models: Vec::new(),
            suggested_capabilities: endpoint.default_capabilities.clone(),
        });
    }
    Ok(())
}

fn models_url(base_url: &str) -> Result<Url> {
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
    if !vision && !video && !audio {
        return None;
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
        assert!(suggest_model_from_upstream(&ModelRow {
            id: "media-describe-omni".to_string(),
            supports_vision: None,
            supports_video_input: None,
            supports_audio_input: None,
            capabilities: None,
            architecture: None,
        })
        .is_none());
    }

    #[test]
    fn suggests_modalities_from_upstream_metadata_only() {
        let suggestion = suggest_model_from_upstream(&ModelRow {
            id: "plain-name".to_string(),
            supports_vision: Some(true),
            supports_video_input: None,
            supports_audio_input: None,
            capabilities: None,
            architecture: None,
        })
        .expect("suggestion");
        assert_eq!(
            suggestion.capabilities.chat_completions.unwrap().vision,
            Some(true)
        );
    }

    #[test]
    fn successful_probe_accumulates_by_default_and_preserves_desired_caps() {
        let mut config = Config {
            endpoints: vec![EndpointConfig {
                slug: "local".into(),
                models: vec![ModelConfig {
                    upstream_model_id: "gone".into(),
                    capability_override_mode: CapabilityOverrideMode::Override,
                    capabilities: Some(OpenAiCompatibleCapabilities::openai_defaults()),
                    ..ModelConfig::default()
                }],
                ..EndpointConfig::default()
            }],
            ..Config::default()
        };
        apply_probe_report(
            &mut config,
            &ProbeReport {
                endpoint_slug: "local".into(),
                status: ProbeStatus::Online,
                discovered_model_ids: vec!["new".into()],
                suggested_default_capabilities: OpenAiCompatibleCapabilities::default(),
                model_suggestions: vec![],
                error: None,
            },
            false,
        )
        .expect("apply");
        let ids: Vec<&str> = config.endpoints[0]
            .models
            .iter()
            .map(|model| model.upstream_model_id.as_str())
            .collect();
        assert_eq!(ids, ["gone", "new"]);
    }

    #[test]
    fn successful_probe_replaces_unpinned_models_and_preserves_desired_caps() {
        let mut config = Config {
            endpoints: vec![EndpointConfig {
                slug: "local".into(),
                models: vec![
                    ModelConfig {
                        upstream_model_id: "gone".into(),
                        capability_override_mode: CapabilityOverrideMode::Override,
                        capabilities: Some(OpenAiCompatibleCapabilities::openai_defaults()),
                        ..ModelConfig::default()
                    },
                    ModelConfig {
                        upstream_model_id: "kept".into(),
                        capability_override_mode: CapabilityOverrideMode::Override,
                        capabilities: Some(
                            OpenAiCompatibleCapabilities::openai_defaults().with_vision(),
                        ),
                        ..ModelConfig::default()
                    },
                    ModelConfig {
                        upstream_model_id: "pinned-missing".into(),
                        pinned: true,
                        ..ModelConfig::default()
                    },
                ],
                ..EndpointConfig::default()
            }],
            ..Config::default()
        };
        apply_probe_report(
            &mut config,
            &ProbeReport {
                endpoint_slug: "local".into(),
                status: ProbeStatus::Online,
                discovered_model_ids: vec!["kept".into(), "new".into()],
                suggested_default_capabilities: OpenAiCompatibleCapabilities::default(),
                model_suggestions: vec![ModelSuggestion {
                    upstream_model_id: "kept".into(),
                    slug: "kept".into(),
                    capability_override_mode: CapabilityOverrideMode::Override,
                    capabilities: OpenAiCompatibleCapabilities::openai_defaults(),
                }],
                error: None,
            },
            true,
        )
        .expect("apply");
        let models = &config.endpoints[0].models;
        let ids: Vec<&str> = models.iter().map(|model| model.upstream_model_id.as_str()).collect();
        assert_eq!(ids, ["kept", "pinned-missing", "new"]);
        let kept = models
            .iter()
            .find(|model| model.upstream_model_id == "kept")
            .expect("kept");
        assert_eq!(kept.capability_override_mode, CapabilityOverrideMode::Override);
        assert_eq!(
            kept.capabilities
                .as_ref()
                .unwrap()
                .chat_completions
                .as_ref()
                .unwrap()
                .vision,
            Some(true)
        );
    }
}
