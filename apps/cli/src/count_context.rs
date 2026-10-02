//! Engine tokenize for Chat Completions (`count_context`).
//!
//! Probe records a tri-state per endpoint (method / unsupported / not probed).
//! POSTs run only when the engine kind or a custom adapter declares a count
//! route. The live op POSTs the request's `messages` (never logged) and returns
//! only a count. Token pieces and rendered prompts are dropped after the integer
//! is known.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::config::EndpointConfig;
use crate::engine::{self, EngineKind, read_decoded_body};

/// Largest tokenize JSON body. A near-ceiling count can return a long `tokens`
/// array; only the length is kept.
const TOKENIZE_BODY_LIMIT: u64 = 8 * 1024 * 1024;
/// Probe and live count share this bound so a huge chat body cannot pin the CLI.
pub const COUNT_CONTEXT_MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

const LLAMA_INPUT_TOKEN_ROUTES: [&str; 2] = [
    "v1/chat/completions/input_tokens",
    "chat/completions/input_tokens",
];

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CountContextOutcome {
    pub tokens: u64,
    pub method: CountContextMethod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CountContextErrorKind {
    Unsupported,
    InvalidInput,
    Upstream4xx,
    Upstream5xx,
    Transport,
    Timeout,
    TooLarge,
}

impl CountContextErrorKind {
    pub fn relay_failure(self) -> crate::protocol::RelayFailure {
        use crate::protocol::RelayFailure;
        match self {
            Self::Unsupported => RelayFailure::UnsupportedCapability,
            Self::InvalidInput => RelayFailure::ProtocolError,
            Self::Upstream4xx => RelayFailure::Upstream4xx,
            Self::Upstream5xx => RelayFailure::Upstream5xx,
            Self::Transport => RelayFailure::Transport,
            Self::Timeout => RelayFailure::Timeout,
            Self::TooLarge => RelayFailure::RequestTooLarge,
        }
    }
}

#[derive(Debug)]
pub struct CountContextError {
    pub kind: CountContextErrorKind,
    pub message: String,
}

impl CountContextError {
    fn new(kind: CountContextErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// Inputs that decide whether a tokenize POST is allowed.
#[derive(Debug, Clone, Copy)]
pub struct CountProbeRequest<'a> {
    pub declared: Option<EngineKind>,
    pub kind: Option<EngineKind>,
    pub model: Option<&'a str>,
    pub adapter_count_route: Option<&'a str>,
}

/// Probe which tokenize route this engine answers. `post(route, json_body)`
/// returns the response body on 2xx. `get(route)` is used only to recognize
/// TGI (`GET /info`) before POSTing `/chat_tokenize`.
pub fn probe_with(
    request: CountProbeRequest<'_>,
    post: impl Fn(&str, &Value) -> Option<String>,
    get: impl Fn(&str) -> Option<String>,
) -> CountContextFact {
    if let Some(route) = request.adapter_count_route
        && try_adapter(&post, route, request.model).is_some()
    {
        return CountContextFact::AdapterCount;
    }
    let resolved = request.declared.or(request.kind);
    match resolved {
        Some(EngineKind::Vllm) => return fact_from_method(try_vllm(&post, request.model)),
        Some(EngineKind::LlamaCpp) => return fact_from_method(try_llama(&post, request.model)),
        Some(
            EngineKind::Generic | EngineKind::Ollama | EngineKind::LmStudio | EngineKind::Sglang,
        ) => {
            return CountContextFact::Unsupported;
        }
        None => {}
    }
    if get("info").as_deref().is_some_and(is_tgi_info) {
        return fact_from_method(try_tgi(&post, request.model));
    }
    CountContextFact::Unsupported
}

fn fact_from_method(method: Option<CountContextMethod>) -> CountContextFact {
    method
        .map(CountContextFact::from)
        .unwrap_or(CountContextFact::Unsupported)
}

fn probe_messages() -> Value {
    json!([{"role": "user", "content": "a"}])
}

fn probe_chat_body(model: Option<&str>) -> Value {
    let mut map = Map::new();
    map.insert("messages".to_string(), probe_messages());
    if let Some(model) = model {
        map.insert("model".to_string(), json!(model));
    }
    Value::Object(map)
}

fn try_adapter(
    post: &impl Fn(&str, &Value) -> Option<String>,
    route: &str,
    model: Option<&str>,
) -> Option<CountContextMethod> {
    let response = post(route, &probe_chat_body(model))?;
    parse_probe_count(&response).map(|_| CountContextMethod::AdapterCount)
}

fn try_vllm(
    post: &impl Fn(&str, &Value) -> Option<String>,
    model: Option<&str>,
) -> Option<CountContextMethod> {
    let response = post("tokenize", &probe_chat_body(model))?;
    parse_probe_count(&response).map(|_| CountContextMethod::VllmTokenize)
}

fn try_tgi(
    post: &impl Fn(&str, &Value) -> Option<String>,
    model: Option<&str>,
) -> Option<CountContextMethod> {
    let response = post("chat_tokenize", &probe_chat_body(model))?;
    parse_probe_count(&response).map(|_| CountContextMethod::TgiChatTokenize)
}

fn try_llama(
    post: &impl Fn(&str, &Value) -> Option<String>,
    model: Option<&str>,
) -> Option<CountContextMethod> {
    let chat = probe_chat_body(model);
    for route in LLAMA_INPUT_TOKEN_ROUTES {
        if let Some(response) = post(route, &chat)
            && parse_probe_count(&response).is_some()
        {
            return Some(CountContextMethod::LlamaInputTokens);
        }
    }
    let applied = post("apply-template", &chat)?;
    let prompt = parse_applied_prompt(&applied)?;
    let response = post("tokenize", &llama_tokenize_body(model, prompt))?;
    parse_probe_count(&response).map(|_| CountContextMethod::LlamaApplyTemplate)
}

/// Detect tokenize support with the endpoint's credentials.
pub fn probe_count_context(
    endpoint: &EndpointConfig,
    kind: Option<EngineKind>,
    model: Option<&str>,
    adapter_count_route: Option<&str>,
) -> CountContextFact {
    let declared = endpoint.engine.declared_kind();
    let agent = engine::http_agent(engine::DETECT_TIMEOUT);
    let post = |route: &str, body: &Value| {
        post_json_route(&agent, endpoint, route, body, TOKENIZE_BODY_LIMIT).ok()
    };
    let get =
        |route: &str| engine::fetch_route(&agent, endpoint, route, engine::JSON_BODY_LIMIT).ok();
    probe_with(
        CountProbeRequest {
            declared,
            kind,
            model,
            adapter_count_route,
        },
        post,
        get,
    )
}

/// Count one Chat Completions body. `messages` must be a JSON array.
pub fn count_chat(
    endpoint: &EndpointConfig,
    model: &str,
    body: &Value,
    method: Option<CountContextMethod>,
    adapter_count_route: Option<&str>,
    timeout: Duration,
) -> std::result::Result<CountContextOutcome, CountContextError> {
    let messages = body
        .get("messages")
        .filter(|value| value.is_array())
        .cloned()
        .ok_or_else(|| {
            CountContextError::new(
                CountContextErrorKind::InvalidInput,
                "count_context body has no messages array",
            )
        })?;
    let Some(method) = method else {
        return Err(CountContextError::new(
            CountContextErrorKind::Unsupported,
            "this engine has no tokenize route",
        ));
    };
    let deadline = Instant::now() + timeout;
    let tokens = match method {
        CountContextMethod::VllmTokenize => {
            let payload =
                chat_count_payload(model, &messages, body, &["tools", "chat_template_kwargs"]);
            let response = post_counted_until(endpoint, "tokenize", &payload, deadline)?;
            parse_required_count(&response, "vLLM /tokenize returned no count")?
        }
        CountContextMethod::TgiChatTokenize => {
            let payload = chat_count_payload(model, &messages, body, &["tools"]);
            let response = post_counted_until(endpoint, "chat_tokenize", &payload, deadline)?;
            parse_required_count(&response, "TGI /chat_tokenize returned no count")?
        }
        CountContextMethod::LlamaInputTokens => {
            let payload = chat_count_payload(
                model,
                &messages,
                body,
                &["tools", "tool_choice", "chat_template_kwargs"],
            );
            llama_input_tokens_count(endpoint, &payload, deadline)?
        }
        CountContextMethod::LlamaApplyTemplate => {
            let payload = chat_count_payload(
                model,
                &messages,
                body,
                &["tools", "tool_choice", "chat_template_kwargs"],
            );
            let applied = post_counted_until(endpoint, "apply-template", &payload, deadline)?;
            let prompt = parse_applied_prompt(&applied).ok_or_else(|| {
                CountContextError::new(
                    CountContextErrorKind::Unsupported,
                    "llama.cpp /apply-template returned no prompt",
                )
            })?;
            let tokenize = llama_tokenize_body(Some(model), prompt);
            let response = post_counted_until(endpoint, "tokenize", &tokenize, deadline)?;
            parse_required_count(&response, "llama.cpp /tokenize returned no count")?
        }
        CountContextMethod::AdapterCount => {
            let route = adapter_count_route.ok_or_else(|| {
                CountContextError::new(
                    CountContextErrorKind::Unsupported,
                    "this adapter has no count route",
                )
            })?;
            let payload = chat_count_payload(
                model,
                &messages,
                body,
                &["tools", "tool_choice", "chat_template_kwargs"],
            );
            let response = post_counted_until(endpoint, route, &payload, deadline)?;
            parse_required_count(&response, "adapter count route returned no count")?
        }
    };
    let tokens = accept_count(tokens, &messages)?;
    Ok(CountContextOutcome { tokens, method })
}

fn chat_count_payload(model: &str, messages: &Value, body: &Value, keys: &[&str]) -> Value {
    let mut map = Map::new();
    map.insert("model".to_string(), json!(model));
    map.insert("messages".to_string(), messages.clone());
    if let Some(src) = body.as_object() {
        for key in keys {
            if let Some(value) = src.get(*key) {
                map.insert((*key).to_string(), value.clone());
            }
        }
    }
    Value::Object(map)
}

fn llama_tokenize_body(model: Option<&str>, prompt: String) -> Value {
    let mut map = Map::new();
    map.insert("content".to_string(), json!(prompt));
    map.insert("add_special".to_string(), json!(true));
    if let Some(model) = model {
        map.insert("model".to_string(), json!(model));
    }
    Value::Object(map)
}

fn llama_input_tokens_count(
    endpoint: &EndpointConfig,
    payload: &Value,
    deadline: Instant,
) -> std::result::Result<u64, CountContextError> {
    let mut last_error = None;
    for route in LLAMA_INPUT_TOKEN_ROUTES {
        match post_counted_until(endpoint, route, payload, deadline) {
            Ok(response) => {
                return parse_required_count(
                    &response,
                    "llama.cpp /input_tokens returned no count",
                );
            }
            Err(error)
                if matches!(
                    error.kind,
                    CountContextErrorKind::Upstream4xx | CountContextErrorKind::Unsupported
                ) =>
            {
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    match last_error {
        Some(error) => Err(error),
        None => Err(CountContextError::new(
            CountContextErrorKind::Unsupported,
            "llama.cpp /input_tokens returned no count",
        )),
    }
}

fn parse_required_count(
    body: &str,
    message: &'static str,
) -> std::result::Result<u64, CountContextError> {
    parse_token_count(body)
        .ok_or_else(|| CountContextError::new(CountContextErrorKind::Unsupported, message))
}

fn accept_count(tokens: u64, messages: &Value) -> std::result::Result<u64, CountContextError> {
    let empty = messages.as_array().is_none_or(|rows| rows.is_empty());
    if tokens == 0 && !empty {
        return Err(CountContextError::new(
            CountContextErrorKind::Unsupported,
            "tokenize returned 0 for a non-empty messages array",
        ));
    }
    Ok(tokens)
}

/// Integer token count from a tokenize JSON body. Token strings are ignored.
/// An explicit `count` (then `input_tokens`) wins over `tokens.len()`.
pub fn parse_token_count(body: &str) -> Option<u64> {
    let value: Value = serde_json::from_str(body).ok()?;
    count_from_value(&value)
}

fn parse_probe_count(body: &str) -> Option<u64> {
    parse_token_count(body).filter(|count| *count >= 1)
}

fn count_from_value(value: &Value) -> Option<u64> {
    as_count(value.get("count"))
        .or_else(|| as_count(value.get("input_tokens")))
        .or_else(|| {
            value
                .get("tokenize_response")
                .and_then(Value::as_array)
                .map(|tokens| tokens.len() as u64)
        })
        .or_else(|| tokens_len(value.get("tokens")))
}

fn as_count(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(count) = value.as_u64() {
        return Some(count);
    }
    let count = value.as_i64()?;
    (count >= 0).then_some(count as u64)
}

fn tokens_len(value: Option<&Value>) -> Option<u64> {
    Some(value?.as_array()?.len() as u64)
}

fn parse_applied_prompt(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    value
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// TGI `GET /info`: `model_id` plus the two length caps.
pub fn is_tgi_info(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("model_id").is_some_and(Value::is_string)
        && object
            .get("max_input_length")
            .and_then(Value::as_u64)
            .is_some()
        && object
            .get("max_total_tokens")
            .and_then(Value::as_u64)
            .is_some()
}

fn post_counted_until(
    endpoint: &EndpointConfig,
    route: &str,
    body: &Value,
    deadline: Instant,
) -> std::result::Result<String, CountContextError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(CountContextError::new(
            CountContextErrorKind::Timeout,
            format!("posting `{route}` timed out"),
        ));
    }
    let agent = engine::http_agent(remaining);
    post_json_route(&agent, endpoint, route, body, TOKENIZE_BODY_LIMIT)
        .map_err(|error| classify_post_error(error, route))
}

fn classify_post_error(error: anyhow::Error, route: &str) -> CountContextError {
    let message = format!("posting `{route}` failed");
    let kind = error.chain().find_map(|cause| {
        let err = cause.downcast_ref::<ureq::Error>()?;
        match err {
            ureq::Error::StatusCode(400..=499) => Some(CountContextErrorKind::Upstream4xx),
            ureq::Error::StatusCode(500..=599) => Some(CountContextErrorKind::Upstream5xx),
            ureq::Error::Timeout(_) => Some(CountContextErrorKind::Timeout),
            _ => None,
        }
    });
    let kind = kind.unwrap_or_else(|| {
        let text = format!("{error:#}").to_ascii_lowercase();
        if text.contains("timed out") || text.contains("timeout") {
            CountContextErrorKind::Timeout
        } else if text.contains("exceeds") {
            CountContextErrorKind::TooLarge
        } else {
            CountContextErrorKind::Transport
        }
    });
    CountContextError::new(kind, message)
}

pub(crate) fn post_json_route(
    agent: &ureq::Agent,
    endpoint: &EndpointConfig,
    route: &str,
    body: &Value,
    limit: u64,
) -> Result<String> {
    let url = engine::route_url(&endpoint.base_url, route)?;
    let mut request = agent
        .post(url.as_str())
        .header("content-type", "application/json")
        .header("accept", "application/json");
    for (name, value) in engine::endpoint_header_pairs(endpoint)? {
        request = request.header(&name, &value);
    }
    let mut response = request
        .send_json(body)
        .with_context(|| format!("posting `{route}` to endpoint `{}`", endpoint.slug))?;
    read_decoded_body(response.body_mut(), limit)
        .with_context(|| format!("reading `{route}` from endpoint `{}`", endpoint.slug))
}

/// Parse a `count_context` request body. The integer count is the only kept fact.
pub fn parse_count_context_body(bytes: &[u8]) -> std::result::Result<Value, CountContextError> {
    if bytes.len() > COUNT_CONTEXT_MAX_BODY_BYTES {
        return Err(CountContextError::new(
            CountContextErrorKind::TooLarge,
            "count_context body exceeds its size limit",
        ));
    }
    serde_json::from_slice(bytes).map_err(|_| {
        CountContextError::new(
            CountContextErrorKind::InvalidInput,
            "count_context body is not JSON",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VLLM: &str = include_str!("../tests/fixtures/engines/vllm-tokenize.json");
    const TGI: &str = include_str!("../tests/fixtures/engines/tgi-chat-tokenize.json");
    const TGI_INFO: &str =
        r#"{"model_id":"placeholder","max_input_length":4096,"max_total_tokens":8192}"#;
    const LLAMA_TEMPLATE: &str =
        include_str!("../tests/fixtures/engines/llama-apply-template.json");
    const LLAMA_TOKENS: &str = include_str!("../tests/fixtures/engines/llama-tokenize.json");
    const LLAMA_INPUT: &str = include_str!("../tests/fixtures/engines/llama-input-tokens.json");

    fn fixture_post(
        routes: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str, &Value) -> Option<String> {
        move |route, _| {
            routes
                .iter()
                .find(|(name, _)| *name == route)
                .map(|(_, body)| (*body).to_string())
        }
    }

    fn fixture_get(
        routes: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<String> {
        move |route| {
            routes
                .iter()
                .find(|(name, _)| *name == route)
                .map(|(_, body)| (*body).to_string())
        }
    }

    fn probe(
        declared: Option<EngineKind>,
        kind: Option<EngineKind>,
        posts: &'static [(&'static str, &'static str)],
        gets: &'static [(&'static str, &'static str)],
    ) -> CountContextFact {
        probe_with(
            CountProbeRequest {
                declared,
                kind,
                model: None,
                adapter_count_route: None,
            },
            fixture_post(posts),
            fixture_get(gets),
        )
    }

    #[test]
    fn fixtures_carry_no_prompt_text() {
        for body in [VLLM, TGI, LLAMA_TEMPLATE, LLAMA_TOKENS, LLAMA_INPUT] {
            let lower = body.to_ascii_lowercase();
            assert!(!lower.contains("user prompt"));
            assert!(!lower.contains("tell me"));
            assert!(!lower.contains("hello, "));
        }
        assert!(parse_applied_prompt(LLAMA_TEMPLATE).is_some());
    }

    #[test]
    fn parses_each_engine_count_without_keeping_tokens() {
        assert_eq!(parse_token_count(VLLM), Some(12));
        assert_eq!(parse_token_count(TGI), Some(8));
        assert_eq!(parse_token_count(LLAMA_TOKENS), Some(4));
        assert_eq!(parse_token_count(LLAMA_INPUT), Some(6));
        assert_eq!(
            parse_token_count(r#"{"count":5,"tokens":[1,2,3]}"#),
            Some(5)
        );
        assert_eq!(parse_token_count(r#"{"tokens":[]}"#), Some(0));
        assert_eq!(parse_token_count("{}"), None);
        assert!(parse_token_count(r#"{"tokenize_response":{"count":3}}"#).is_none());
        assert!(parse_token_count(r#"{"tokenize_response":{"tokens":[1,2]}}"#).is_none());
    }

    #[test]
    fn probe_rejects_a_zero_count() {
        assert_eq!(
            probe(
                Some(EngineKind::Vllm),
                None,
                &[("tokenize", r#"{"tokens":[]}"#)],
                &[],
            ),
            CountContextFact::Unsupported
        );
        assert_eq!(parse_probe_count(r#"{"tokens":[]}"#), None);
        assert_eq!(parse_probe_count(r#"{"count":0}"#), None);
        assert_eq!(parse_probe_count(VLLM), Some(12));
    }

    #[test]
    fn zero_on_non_empty_messages_is_unsupported() {
        let messages = json!([{"role":"user","content":"a"}]);
        assert!(accept_count(0, &messages).is_err());
        assert_eq!(accept_count(3, &messages).unwrap(), 3);
        assert_eq!(accept_count(0, &json!([])).unwrap(), 0);
    }

    #[test]
    fn probe_records_the_matching_route() {
        assert_eq!(
            probe(Some(EngineKind::Vllm), None, &[("tokenize", VLLM)], &[],),
            CountContextFact::VllmTokenize
        );
        assert_eq!(
            probe(None, None, &[("chat_tokenize", TGI)], &[("info", TGI_INFO)]),
            CountContextFact::TgiChatTokenize
        );
        assert_eq!(
            probe(
                Some(EngineKind::LlamaCpp),
                None,
                &[("v1/chat/completions/input_tokens", LLAMA_INPUT)],
                &[],
            ),
            CountContextFact::LlamaInputTokens
        );
        assert_eq!(
            probe(
                Some(EngineKind::LlamaCpp),
                None,
                &[
                    ("apply-template", LLAMA_TEMPLATE),
                    ("tokenize", LLAMA_TOKENS)
                ],
                &[],
            ),
            CountContextFact::LlamaApplyTemplate
        );
        assert_eq!(
            probe(
                Some(EngineKind::Ollama),
                None,
                &[("tokenize", VLLM), ("chat_tokenize", TGI)],
                &[("info", TGI_INFO)],
            ),
            CountContextFact::Unsupported
        );
        assert_eq!(
            probe(Some(EngineKind::Generic), None, &[("tokenize", VLLM)], &[],),
            CountContextFact::Unsupported
        );
        assert_eq!(
            probe(Some(EngineKind::Sglang), None, &[("tokenize", VLLM)], &[],),
            CountContextFact::Unsupported
        );
        assert_eq!(
            probe(Some(EngineKind::LmStudio), None, &[("tokenize", VLLM)], &[],),
            CountContextFact::Unsupported
        );
    }

    #[test]
    fn auto_undetected_does_not_post_tokenize_routes() {
        assert_eq!(
            probe(
                None,
                None,
                &[("tokenize", VLLM), ("chat_tokenize", TGI)],
                &[]
            ),
            CountContextFact::Unsupported
        );
    }

    #[test]
    fn declared_vllm_does_not_fall_through_to_tgi() {
        assert_eq!(
            probe(
                Some(EngineKind::Vllm),
                None,
                &[("chat_tokenize", TGI)],
                &[("info", TGI_INFO)],
            ),
            CountContextFact::Unsupported
        );
    }

    #[test]
    fn llama_prefers_input_tokens_over_apply_template() {
        assert_eq!(
            probe(
                Some(EngineKind::LlamaCpp),
                None,
                &[
                    ("v1/chat/completions/input_tokens", LLAMA_INPUT),
                    ("apply-template", LLAMA_TEMPLATE),
                    ("tokenize", LLAMA_TOKENS)
                ],
                &[],
            ),
            CountContextFact::LlamaInputTokens
        );
        assert_eq!(
            probe(
                Some(EngineKind::LlamaCpp),
                None,
                &[("chat/completions/input_tokens", LLAMA_INPUT)],
                &[],
            ),
            CountContextFact::LlamaInputTokens
        );
    }

    #[test]
    fn llama_probe_needs_both_fallback_routes() {
        assert_eq!(
            probe(
                Some(EngineKind::LlamaCpp),
                None,
                &[("apply-template", LLAMA_TEMPLATE)],
                &[],
            ),
            CountContextFact::Unsupported
        );
        assert_eq!(
            probe(
                Some(EngineKind::LlamaCpp),
                None,
                &[("tokenize", LLAMA_TOKENS)],
                &[],
            ),
            CountContextFact::Unsupported
        );
    }

    #[test]
    fn adapter_count_route_is_probed_when_declared() {
        let fact = probe_with(
            CountProbeRequest {
                declared: Some(EngineKind::Generic),
                kind: None,
                model: Some("m"),
                adapter_count_route: Some("/count"),
            },
            fixture_post(&[("/count", r#"{"count":4}"#)]),
            fixture_get(&[]),
        );
        assert_eq!(fact, CountContextFact::AdapterCount);
        let skipped = probe_with(
            CountProbeRequest {
                declared: Some(EngineKind::Generic),
                kind: None,
                model: None,
                adapter_count_route: None,
            },
            fixture_post(&[("/count", r#"{"count":4}"#)]),
            fixture_get(&[]),
        );
        assert_eq!(skipped, CountContextFact::Unsupported);
    }

    #[test]
    fn tgi_info_is_recognized_without_posting() {
        assert!(is_tgi_info(TGI_INFO));
        assert!(!is_tgi_info(r#"{"version":"1"}"#));
        assert!(!is_tgi_info("{}"));
    }

    #[test]
    fn chat_payload_forwards_only_requested_keys_and_model() {
        let body = json!({
            "messages": [{"role":"user","content":"a"}],
            "tools": [{"type":"function"}],
            "tool_choice": "auto",
            "chat_template_kwargs": {"enable_thinking": true},
            "foo": 1
        });
        let payload = chat_count_payload(
            "m",
            &body["messages"],
            &body,
            &["tools", "chat_template_kwargs"],
        );
        assert_eq!(payload["model"], "m");
        assert!(payload.get("tools").is_some());
        assert!(payload.get("chat_template_kwargs").is_some());
        assert!(payload.get("tool_choice").is_none());
        assert!(payload.get("foo").is_none());
    }

    #[test]
    fn llama_tokenize_fallback_sets_add_special_and_model() {
        let body = llama_tokenize_body(Some("m"), "<s>".to_string());
        assert_eq!(body["add_special"], true);
        assert_eq!(body["model"], "m");
        assert_eq!(body["content"], "<s>");
    }

    #[test]
    fn over_limit_body_is_too_large() {
        let error = anyhow::anyhow!("the decoded response body exceeds 8 bytes");
        let classified = classify_post_error(error, "tokenize");
        assert_eq!(classified.kind, CountContextErrorKind::TooLarge);
    }
}
