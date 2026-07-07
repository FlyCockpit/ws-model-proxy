//! OpenAI-compatible endpoint probing.

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

fn try_probe_endpoint(endpoint: &EndpointConfig) -> Result<ProbeReport> {
    let url = models_url(&endpoint.base_url)?;
    let mut request = ureq::get(url.as_str()).set("Accept", "application/json");
    for header in &endpoint.headers {
        let value = std::env::var(&header.env).with_context(|| {
            format!(
                "reading endpoint header `{}` from `{}`",
                header.name, header.env
            )
        })?;
        request = request.set(&header.name, &value);
    }
    let response = request
        .call()
        .with_context(|| format!("probing endpoint `{}`", endpoint.slug))?;
    let models = response
        .into_json::<ModelsResponse>()
        .with_context(|| format!("parsing model list from endpoint `{}`", endpoint.slug))?;
    let discovered_model_ids = models
        .data
        .into_iter()
        .map(|model| model.id)
        .filter(|id| !id.trim().is_empty())
        .collect::<Vec<_>>();
    let suggested_default_capabilities =
        suggest_default_capabilities(&discovered_model_ids, &endpoint.default_capabilities);
    let model_suggestions = discovered_model_ids
        .iter()
        .filter_map(|id| suggest_model(id))
        .collect();
    Ok(ProbeReport {
        endpoint_slug: endpoint.slug.clone(),
        status: ProbeStatus::Online,
        discovered_model_ids,
        suggested_default_capabilities,
        model_suggestions,
        error: None,
    })
}

pub fn apply_probe_report(config: &mut Config, report: &ProbeReport) -> Result<()> {
    let Some(endpoint) = config.endpoint_mut(&report.endpoint_slug) else {
        anyhow::bail!("endpoint `{}` no longer exists", report.endpoint_slug);
    };
    if report.status == ProbeStatus::Online {
        endpoint.default_capabilities = report.suggested_default_capabilities.clone();
        endpoint.last_probe = Some(ProbeSnapshot {
            status: ProbeStatus::Online,
            models: report.discovered_model_ids.clone(),
            suggested_capabilities: report.suggested_default_capabilities.clone(),
        });
        for model_id in &report.discovered_model_ids {
            if !endpoint
                .models
                .iter()
                .any(|model| model.upstream_model_id == *model_id)
            {
                endpoint.models.push(ModelConfig {
                    slug: Some(slugify_seed(model_id, "model")),
                    upstream_model_id: model_id.clone(),
                    ..ModelConfig::default()
                });
            }
        }
        for suggestion in &report.model_suggestions {
            if let Some(model) = endpoint
                .models
                .iter_mut()
                .find(|model| model.upstream_model_id == suggestion.upstream_model_id)
            {
                model.slug = model.slug.clone().or_else(|| Some(suggestion.slug.clone()));
                model.capability_override_mode = suggestion.capability_override_mode.clone();
                model.capabilities = Some(suggestion.capabilities.clone());
                model.probe_suggestions = Some(suggestion.capabilities.clone());
            }
        }
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

fn suggest_default_capabilities(
    ids: &[String],
    configured: &OpenAiCompatibleCapabilities,
) -> OpenAiCompatibleCapabilities {
    let mut suggested = configured.clone();
    if ids.iter().any(|id| id.to_lowercase().contains("embed")) {
        suggested.embeddings = Some(crate::config::EmbeddingsCapabilities {
            supported: Some(true),
        });
    }
    if ids.iter().any(|id| id.to_lowercase().contains("response")) {
        suggested = suggested.with_responses();
    }
    if ids.iter().any(|id| {
        let id = id.to_lowercase();
        id.contains("vision") || id.contains("vl") || id.contains("llava")
    }) {
        suggested = suggested.with_vision();
    }
    suggested
}

fn suggest_model(model_id: &str) -> Option<ModelSuggestion> {
    let lower = model_id.to_lowercase();
    let capabilities = if lower.contains("embed") {
        OpenAiCompatibleCapabilities::embedding_defaults()
    } else if lower.contains("vision") || lower.contains("vl") || lower.contains("llava") {
        OpenAiCompatibleCapabilities::openai_defaults().with_vision()
    } else if lower.contains("response") {
        OpenAiCompatibleCapabilities::openai_defaults().with_responses()
    } else {
        return None;
    };
    Some(ModelSuggestion {
        upstream_model_id: model_id.to_string(),
        slug: slugify_seed(model_id, "model"),
        capability_override_mode: CapabilityOverrideMode::Override,
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
    fn suggests_embedding_override() {
        let suggestion = suggest_model("text-embedding-3-small").expect("suggestion");
        assert_eq!(
            suggestion
                .capabilities
                .embeddings
                .expect("embeddings")
                .supported,
            Some(true)
        );
    }
}
