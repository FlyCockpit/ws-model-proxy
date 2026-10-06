//! Relayed-request allowlist (§4.8, every trust level).
//!
//! A `relay.request` may reach only the `(method, path)` pairs its runtime's
//! `api` and model type need, plus the readiness path, the metrics reader
//! route and `countRoute` from the held definition. Anything else is refused
//! (`path_not_allowed`) before a connection is opened, which keeps engine
//! admin APIs (Ollama pull/delete, llama.cpp slot save/restore, LoRA and
//! weight loading) out of reach of the server.

use crate::protocol::runtime_spec::{MetricsReader, ModelType, RuntimeApi, RuntimeSpec};

/// What the relay answers for a refused request.
pub const PATH_NOT_ALLOWED: &str = "path_not_allowed";

/// A request path the node will even consider: one leading slash, no `//`,
/// no `.`/`..` segment, no scheme, query, fragment, backslash, whitespace,
/// control character or percent-encoded `.`/`/`.
pub fn path_is_plain(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    path.starts_with('/')
        && !path.contains("//")
        && path.len() <= 2048
        && !path
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '\\'))
        && !path
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
        && !lower.contains("%2e")
        && !lower.contains("%2f")
        && !lower.contains("%5c")
        && !path.contains("://")
}

/// One path segment that names a stored response (`resp_…`).
fn response_id(segment: &str) -> bool {
    (1..=128).contains(&segment.len())
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether `method path` may reach a runtime defined by `spec`.
pub fn allowed(spec: &RuntimeSpec, method: &str, path: &str) -> bool {
    if !path_is_plain(path) {
        return false;
    }
    let api = spec.api.unwrap_or(RuntimeApi::Openai);
    let model_type = spec.model_type;
    let fixed: &[(&str, &str)] = match (api, model_type) {
        (RuntimeApi::Openai, Some(ModelType::Llm)) => &[
            ("POST", "/v1/chat/completions"),
            ("POST", "/v1/completions"),
            ("POST", "/v1/responses"),
            ("GET", "/v1/models"),
        ],
        (RuntimeApi::Openai, Some(ModelType::Embeddings)) => {
            &[("POST", "/v1/embeddings"), ("GET", "/v1/models")]
        }
        (RuntimeApi::Openai, Some(ModelType::Transcription)) => {
            &[("POST", "/v1/audio/transcriptions"), ("GET", "/v1/models")]
        }
        (RuntimeApi::Anthropic, Some(ModelType::Llm)) => &[
            ("POST", "/v1/messages"),
            ("POST", "/v1/messages/count_tokens"),
            ("GET", "/v1/models"),
        ],
        // A service (no models) is never proxied.
        _ => &[],
    };
    if fixed.iter().any(|(m, p)| *m == method && *p == path) {
        return true;
    }
    // Stored Responses: DELETE one by id, nothing else under it.
    if api == RuntimeApi::Openai
        && model_type == Some(ModelType::Llm)
        && method == "DELETE"
        && path.strip_prefix("/v1/responses/").is_some_and(response_id)
    {
        return true;
    }
    if model_type.is_none() {
        return false;
    }
    // Routes the held definition itself names.
    let readiness = spec
        .launch
        .as_ref()
        .and_then(|launch| launch.readiness.as_ref())
        .map(|readiness| readiness.path.as_str());
    if method == "GET" && readiness == Some(path) {
        return true;
    }
    if let Some(MetricsReader::Route {
        route, count_route, ..
    }) = &spec.metrics_reader
    {
        if method == "GET" && route == path {
            return true;
        }
        if method == "POST" && count_route.as_deref() == Some(path) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(value: serde_json::Value) -> RuntimeSpec {
        serde_json::from_value(value).expect("spec")
    }

    fn openai_llm() -> RuntimeSpec {
        spec(json!({
            "api": "openai", "engine": "llama_cpp", "modelType": "llm",
            "address": { "baseUrl": "http://127.0.0.1:8080/v1" },
            "metricsReader": {
                "kind": "route", "route": "/slots", "format": "json", "map": {},
                "countRoute": "/apply-template"
            }
        }))
    }

    #[test]
    fn the_api_and_model_type_decide_the_routes() {
        let llm = openai_llm();
        for (method, path) in [
            ("POST", "/v1/chat/completions"),
            ("POST", "/v1/completions"),
            ("POST", "/v1/responses"),
            ("GET", "/v1/models"),
            ("DELETE", "/v1/responses/resp_abc-123"),
            ("GET", "/slots"),
            ("POST", "/apply-template"),
        ] {
            assert!(allowed(&llm, method, path), "{method} {path}");
        }
        for (method, path) in [
            ("GET", "/v1/chat/completions"),
            ("POST", "/v1/embeddings"),
            ("POST", "/api/pull"),
            ("POST", "/api/delete"),
            ("POST", "/slots/0?action=save"),
            ("POST", "/slots"),
            ("POST", "/lora-adapters"),
            ("DELETE", "/v1/models"),
            ("DELETE", "/v1/responses"),
            ("DELETE", "/v1/responses/a/b"),
            ("DELETE", "/v1/chat/completions"),
            ("DELETE", "/v1/responses/../../api/delete"),
            ("GET", "/v1/responses/resp_1"),
        ] {
            assert!(!allowed(&llm, method, path), "{method} {path}");
        }
        let embeddings = spec(json!({
            "api": "openai", "engine": "vllm", "modelType": "embeddings",
            "address": { "baseUrl": "http://127.0.0.1:8000" }
        }));
        assert!(allowed(&embeddings, "POST", "/v1/embeddings"));
        assert!(!allowed(&embeddings, "POST", "/v1/chat/completions"));
        assert!(!allowed(&embeddings, "DELETE", "/v1/responses/r1"));
        let anthropic = spec(json!({
            "api": "anthropic", "engine": "other", "modelType": "llm",
            "address": { "baseUrl": "http://127.0.0.1:8000" }
        }));
        assert!(allowed(&anthropic, "POST", "/v1/messages/count_tokens"));
        assert!(!allowed(&anthropic, "POST", "/v1/responses"));
        assert!(!allowed(&anthropic, "DELETE", "/v1/responses/r1"));
        let transcription = spec(json!({
            "api": "openai", "engine": "vllm", "modelType": "transcription",
            "address": { "baseUrl": "http://127.0.0.1:8000" }
        }));
        assert!(allowed(&transcription, "POST", "/v1/audio/transcriptions"));
        assert!(!allowed(&transcription, "POST", "/v1/audio/speech"));
    }

    #[test]
    fn traversal_and_encoding_tricks_are_refused_before_matching() {
        let llm = openai_llm();
        for path in [
            "/v1/../v1/models",
            "/v1//models",
            "//127.0.0.1/v1/models",
            "/v1/%2e%2e/api/pull",
            "/v1%2Fmodels",
            "/v1/models?x=1",
            "/v1/models#x",
            "\\v1\\models",
            "/v1/./models",
            "http://evil/v1/models",
            "v1/models",
            "/v1/models\n",
        ] {
            assert!(
                !path_is_plain(path) || !allowed(&llm, "GET", path),
                "{path:?}"
            );
            assert!(!allowed(&llm, "GET", path), "{path:?}");
        }
    }

    #[test]
    fn a_service_is_never_proxied() {
        let service = spec(json!({
            "launch": {
                "management": "service", "groupSize": 1,
                "resources": [{ "kind": "none" }], "labels": [],
                "commands": [{ "start": "a", "stop": "b", "status": "c" }],
                "readiness": { "path": "/health", "expectedStatus": 200, "timeoutMs": 60000 },
                "health": { "intervalMs": 30000, "failureThreshold": 3, "successThreshold": 1 }
            }
        }));
        assert!(!allowed(&service, "GET", "/health"));
        assert!(!allowed(&service, "GET", "/v1/models"));
    }
}
