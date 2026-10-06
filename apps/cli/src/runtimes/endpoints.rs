//! What the relay, telemetry and live STT reach for a runtime handle.
//!
//! A relayed request names a handle: an always-on runtime's slug, or a
//! managed instance's `i-<id12>`. Each resolves to the endpoint shape the
//! request workers already speak (`EndpointConfig`), built only from held
//! definitions and the node's own instance records, never from the request.

use std::collections::BTreeMap;

use crate::config::{
    EndpointAuthConfig, EndpointAuthMode, EndpointConfig, EndpointEngine, EndpointKind,
    HeaderEnvRef, ModelConfig, OpenAiCompatibleCapabilities,
};
use crate::protocol::frames::{AlwaysOnInventory, AlwaysOnStatus, InventoryModel, RuntimeOrigin};
use crate::protocol::runtime_spec::{
    AuthMode, Engine, ModelCapability, ModelType, RuntimeApi, RuntimeSpec,
};
use crate::runtime_store::{HeldVersion, Store};

/// One reachable runtime: its handle, its endpoint, and the definition the
/// allowlist (§4.8) is derived from.
#[derive(Debug, Clone)]
pub struct Target {
    pub endpoint: EndpointConfig,
    pub spec: RuntimeSpec,
}

/// Instances this node runs, by handle: rank 0 of every ready instance.
pub fn instance_targets(
    instances: &[(
        crate::runtimes::executor::Job,
        crate::protocol::frames::InstanceRecord,
    )],
) -> BTreeMap<String, Target> {
    instances
        .iter()
        .filter(|(job, record)| {
            job.rank == 0
                && matches!(
                    record.phase,
                    crate::protocol::frames::InstancePhase::Ready
                        | crate::protocol::frames::InstancePhase::Unhealthy
                )
        })
        .filter_map(|(job, _)| {
            let spec = job.parsed_spec()?;
            spec.models.as_ref()?;
            let endpoint = endpoint_for(&job.handle, &spec, job.base_url());
            Some((job.handle.clone(), Target { endpoint, spec }))
        })
        .collect()
}

/// The always-on version a slug currently means: the last one received for
/// its runtime (a newer push of the same runtime is appended).
pub fn current_always_on(store: &Store) -> Vec<(&HeldVersion, RuntimeSpec)> {
    let mut by_runtime: BTreeMap<&str, (&HeldVersion, RuntimeSpec)> = BTreeMap::new();
    for held in store.always_on() {
        match held.parsed() {
            Ok(spec) => {
                by_runtime.insert(held.runtime_id.as_str(), (held, spec));
            }
            Err(error) => tracing::warn!(
                version_id = held.version_id,
                error = %format!("{error:#}"),
                "skipping an unreadable held definition"
            ),
        }
    }
    by_runtime.into_values().collect()
}

pub fn always_on_targets(store: &Store) -> BTreeMap<String, Target> {
    current_always_on(store)
        .into_iter()
        .filter_map(|(held, spec)| {
            let base_url = spec.address.as_ref()?.base_url.clone();
            let endpoint = endpoint_for(&held.slug, &spec, base_url);
            Some((held.slug.clone(), Target { endpoint, spec }))
        })
        .collect()
}

fn engine_of(engine: Option<Engine>) -> EndpointEngine {
    match engine {
        Some(Engine::Vllm) => EndpointEngine::Vllm,
        Some(Engine::Sglang) => EndpointEngine::Sglang,
        Some(Engine::LlamaCpp) => EndpointEngine::LlamaCpp,
        Some(Engine::Ollama) => EndpointEngine::Ollama,
        Some(Engine::LmStudio) => EndpointEngine::LmStudio,
        Some(Engine::Other) => EndpointEngine::Generic,
        None => EndpointEngine::Auto,
    }
}

/// The relay endpoint for a spec at `base_url` (an always-on address, or an
/// instance's own port).
pub fn endpoint_for(handle: &str, spec: &RuntimeSpec, base_url: String) -> EndpointConfig {
    let mut capabilities = match spec.model_type {
        Some(ModelType::Embeddings) => OpenAiCompatibleCapabilities::embedding_defaults(),
        Some(ModelType::Transcription) => OpenAiCompatibleCapabilities::transcription(
            spec.models
                .iter()
                .flatten()
                .find_map(|model| model.transcription.as_ref()),
        ),
        _ => OpenAiCompatibleCapabilities::openai_defaults(),
    };
    if let Some(embeddings) = capabilities.embeddings.as_mut() {
        embeddings.contract = spec
            .models
            .iter()
            .flatten()
            .find_map(|model| model.embedding_contract.clone());
    }
    let mut headers = Vec::new();
    let mut auth = None;
    if let Some(address) = &spec.address {
        if let Some(address_auth) = &address.auth {
            match (address_auth.mode, &address_auth.header) {
                (AuthMode::Header, Some(name)) => headers.push(HeaderEnvRef {
                    name: name.clone(),
                    env: address_auth.env.clone(),
                }),
                _ => {
                    auth = Some(EndpointAuthConfig {
                        mode: EndpointAuthMode::Bearer,
                        env: address_auth.env.clone(),
                    });
                }
            }
        }
        for header in address.headers.iter().flatten() {
            headers.push(HeaderEnvRef {
                name: header.name.clone(),
                env: header.env.clone(),
            });
        }
    }
    EndpointConfig {
        slug: handle.to_string(),
        label: handle.to_string(),
        kind: if spec.api == Some(RuntimeApi::Anthropic) {
            EndpointKind::AnthropicCompatible
        } else {
            EndpointKind::OpenAiCompatible
        },
        base_url,
        enabled: true,
        expand_media: spec.expand_media.unwrap_or(false),
        engine: engine_of(spec.engine),
        default_capabilities: capabilities.clone(),
        headers,
        auth,
        models: spec
            .models
            .iter()
            .flatten()
            .map(|model| ModelConfig {
                upstream_model_id: model.id.clone(),
                pinned: true,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

/// The capabilities a served model has on the wire: as declared, else the
/// model type's default.
pub fn model_capabilities(
    spec: &RuntimeSpec,
    declared: Option<&[ModelCapability]>,
) -> Vec<ModelCapability> {
    if let Some(declared) = declared {
        return declared.to_vec();
    }
    match spec.model_type {
        Some(ModelType::Embeddings) => vec![ModelCapability::Embedding],
        Some(ModelType::Transcription) => vec![ModelCapability::AudioInput],
        _ => vec![ModelCapability::TextGeneration],
    }
}

/// Inventory models from the spec, or from what a probe discovered when the
/// spec pins none.
pub fn inventory_models(spec: &RuntimeSpec, discovered: &[String]) -> Vec<InventoryModel> {
    match &spec.models {
        Some(models) => models
            .iter()
            .map(|model| InventoryModel {
                id: model.id.clone(),
                capabilities: model_capabilities(spec, model.capabilities.as_deref()),
                embedding_contract: model.embedding_contract.clone(),
                transcription: model.transcription.clone(),
                engine_facts: None,
            })
            .collect(),
        None => discovered
            .iter()
            .take(64)
            .map(|id| InventoryModel {
                id: id.clone(),
                capabilities: model_capabilities(spec, None),
                embedding_contract: None,
                transcription: None,
                engine_facts: None,
            })
            .collect(),
    }
}

/// An always-on entry for `runtime.inventory`.
pub fn always_on_entry(
    held: &HeldVersion,
    spec: &RuntimeSpec,
    status: AlwaysOnStatus,
    discovered: &[String],
) -> AlwaysOnInventory {
    AlwaysOnInventory {
        slug: held.slug.clone(),
        origin: RuntimeOrigin::Server,
        runtime_id: Some(held.runtime_id.clone()),
        version_id: Some(held.version_id.clone()),
        launch_hash: held.launch_hash.clone(),
        spec: None,
        status,
        models: inventory_models(spec, discovered),
        engine_facts: None,
        truncated: None,
    }
}
