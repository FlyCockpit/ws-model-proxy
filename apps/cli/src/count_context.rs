//! Engine tokenize for Chat Completions (`count_context`).
//!
//! Probe records which route works; the live op POSTs the request's `messages`
//! (never logged) and returns only a count. Token pieces and rendered prompts
//! are dropped after the integer is known.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::EndpointConfig;
use crate::engine::{self, EngineKind, read_decoded_body};

/// Largest tokenize JSON body. A near-ceiling count can return a long `tokens`
/// array; only the length is kept.
const TOKENIZE_BODY_LIMIT: u64 = 8 * 1024 * 1024;
/// Probe and live count share this bound so a huge chat body cannot pin the CLI.
pub const COUNT_CONTEXT_MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

const PROBE_MESSAGES: &str = r#"[{"role":"user","content":"a"}]"#;

/// How this engine counts Chat Completions context. Wire value of
/// `engineFacts.countContext` and `count_context.result.method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountContextMethod {
    VllmTokenize,
    TgiChatTokenize,
    LlamaApplyTemplate,
}

impl CountContextMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VllmTokenize => "vllm_tokenize",
            Self::TgiChatTokenize => "tgi_chat_tokenize",
            Self::LlamaApplyTemplate => "llama_apply_template",
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

/// Probe which tokenize route this engine answers. `post(route, json_body)`
/// returns the response body on 2xx.
pub fn probe_with(
    declared: Option<EngineKind>,
    kind: Option<EngineKind>,
    post: impl Fn(&str, &Value) -> Option<String>,
) -> Option<CountContextMethod> {
    match declared.or(kind) {
        Some(EngineKind::Generic | EngineKind::Ollama | EngineKind::LmStudio | EngineKind::Sglang) => {
            return None;
        }
        Some(EngineKind::Vllm) => return try_vllm(&post),
        Some(EngineKind::LlamaCpp) => return try_llama(&post),
        None => {}
    }
    try_vllm(&post)
        .or_else(|| try_tgi(&post))
        .or_else(|| try_llama(&post))
}

fn probe_messages() -> Value {
    serde_json::from_str(PROBE_MESSAGES).expect("probe messages")
}

fn try_vllm(post: &impl Fn(&str, &Value) -> Option<String>) -> Option<CountContextMethod> {
    let body = json!({ "messages": probe_messages() });
    let response = post("tokenize", &body)?;
    parse_token_count(&response).map(|_| CountContextMethod::VllmTokenize)
}

fn try_tgi(post: &impl Fn(&str, &Value) -> Option<String>) -> Option<CountContextMethod> {
    let body = json!({ "messages": probe_messages() });
    let response = post("chat_tokenize", &body)?;
    parse_token_count(&response).map(|_| CountContextMethod::TgiChatTokenize)
}

fn try_llama(post: &impl Fn(&str, &Value) -> Option<String>) -> Option<CountContextMethod> {
    let body = json!({ "messages": probe_messages() });
    let applied = post("apply-template", &body)?;
    let prompt = parse_applied_prompt(&applied)?;
    let tokenize = json!({ "content": prompt, "add_special": false });
    let response = post("tokenize", &tokenize)?;
    parse_token_count(&response).map(|_| CountContextMethod::LlamaApplyTemplate)
}

/// Detect tokenize support with the endpoint's credentials.
pub fn probe_count_context(endpoint: &EndpointConfig, kind: Option<EngineKind>) -> Option<CountContextMethod> {
    let declared = endpoint.engine.declared_kind();
    let agent = engine::http_agent(engine::DETECT_TIMEOUT);
    let post = |route: &str, body: &Value| {
        post_json_route(&agent, endpoint, route, body, TOKENIZE_BODY_LIMIT).ok()
    };
    probe_with(declared, kind, post)
}

/// Count one Chat Completions body. `messages` must be a JSON array.
pub fn count_chat(
    endpoint: &EndpointConfig,
    model: &str,
    body: &Value,
    method: Option<CountContextMethod>,
    timeout: Duration,
) -> std::result::Result<CountContextOutcome, CountContextError> {
    let messages = body
        .get("messages")
        .filter(|value| value.is_array())
        .cloned()
        .ok_or_else(|| CountContextError::new(CountContextErrorKind::InvalidInput, "count_context body has no messages array"))?;
    let tools = body.get("tools").cloned();
    let resolved = method.or_else(|| {
        let kind = engine::effective_kind(endpoint).map(|(kind, _)| kind);
        match kind {
            Some(EngineKind::Vllm) => Some(CountContextMethod::VllmTokenize),
            Some(EngineKind::LlamaCpp) => Some(CountContextMethod::LlamaApplyTemplate),
            _ => None,
        }
    });
    let Some(method) = resolved else {
        return Err(CountContextError::new(
            CountContextErrorKind::Unsupported,
            "this engine has no tokenize route",
        ));
    };
    let agent = engine::http_agent(timeout);
    match method {
        CountContextMethod::VllmTokenize => {
            let mut payload = json!({ "model": model, "messages": messages });
            if let Some(tools) = tools {
                payload
                    .as_object_mut()
                    .expect("object")
                    .insert("tools".to_string(), tools);
            }
            let response = post_counted(&agent, endpoint, "tokenize", &payload)?;
            let tokens = parse_token_count(&response).ok_or_else(|| {
                CountContextError::new(CountContextErrorKind::Unsupported, "vLLM /tokenize returned no count")
            })?;
            Ok(CountContextOutcome { tokens, method })
        }
        CountContextMethod::TgiChatTokenize => {
            let mut payload = json!({ "model": model, "messages": messages });
            if let Some(tools) = tools {
                payload
                    .as_object_mut()
                    .expect("object")
                    .insert("tools".to_string(), tools);
            }
            let response = post_counted(&agent, endpoint, "chat_tokenize", &payload)?;
            let tokens = parse_token_count(&response).ok_or_else(|| {
                CountContextError::new(
                    CountContextErrorKind::Unsupported,
                    "TGI /chat_tokenize returned no count",
                )
            })?;
            Ok(CountContextOutcome { tokens, method })
        }
        CountContextMethod::LlamaApplyTemplate => {
            let payload = json!({ "messages": messages });
            let applied = post_counted(&agent, endpoint, "apply-template", &payload)?;
            let prompt = parse_applied_prompt(&applied).ok_or_else(|| {
                CountContextError::new(
                    CountContextErrorKind::Unsupported,
                    "llama.cpp /apply-template returned no prompt",
                )
            })?;
            let tokenize = json!({ "content": prompt, "add_special": false });
            let response = post_counted(&agent, endpoint, "tokenize", &tokenize)?;
            let tokens = parse_token_count(&response).ok_or_else(|| {
                CountContextError::new(
                    CountContextErrorKind::Unsupported,
                    "llama.cpp /tokenize returned no count",
                )
            })?;
            Ok(CountContextOutcome { tokens, method })
        }
    }
}

/// Integer token count from a tokenize JSON body. Token strings are ignored.
pub fn parse_token_count(body: &str) -> Option<u64> {
    let value: Value = serde_json::from_str(body).ok()?;
    count_from_value(&value)
}

fn count_from_value(value: &Value) -> Option<u64> {
    as_count(value.get("count"))
        .or_else(|| as_count(value.pointer("/tokenize_response/count")))
        .or_else(|| tokens_len(value.get("tokens")))
        .or_else(|| tokens_len(value.pointer("/tokenize_response/tokens")))
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

fn post_counted(
    agent: &ureq::Agent,
    endpoint: &EndpointConfig,
    route: &str,
    body: &Value,
) -> std::result::Result<String, CountContextError> {
    post_json_route(agent, endpoint, route, body, TOKENIZE_BODY_LIMIT).map_err(|error| {
        classify_post_error(error, route)
    })
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
    const LLAMA_TEMPLATE: &str = include_str!("../tests/fixtures/engines/llama-apply-template.json");
    const LLAMA_TOKENS: &str = include_str!("../tests/fixtures/engines/llama-tokenize.json");

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

    #[test]
    fn fixtures_carry_no_prompt_text() {
        for body in [VLLM, TGI, LLAMA_TEMPLATE, LLAMA_TOKENS] {
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
        assert_eq!(
            parse_token_count(r#"{"tokenize_response":{"count":3}}"#),
            Some(3)
        );
        assert_eq!(
            parse_token_count(r#"{"tokenize_response":{"tokens":[1,2]}}"#),
            Some(2)
        );
        assert_eq!(parse_token_count("{}"), None);
    }

    #[test]
    fn probe_records_the_matching_route() {
        assert_eq!(
            probe_with(
                Some(EngineKind::Vllm),
                None,
                fixture_post(&[("tokenize", VLLM)]),
            ),
            Some(CountContextMethod::VllmTokenize)
        );
        assert_eq!(
            probe_with(
                None,
                None,
                fixture_post(&[("chat_tokenize", TGI)]),
            ),
            Some(CountContextMethod::TgiChatTokenize)
        );
        assert_eq!(
            probe_with(
                Some(EngineKind::LlamaCpp),
                None,
                fixture_post(&[("apply-template", LLAMA_TEMPLATE), ("tokenize", LLAMA_TOKENS)]),
            ),
            Some(CountContextMethod::LlamaApplyTemplate)
        );
        assert_eq!(
            probe_with(
                Some(EngineKind::Ollama),
                None,
                fixture_post(&[("tokenize", VLLM), ("chat_tokenize", TGI)]),
            ),
            None
        );
        assert_eq!(
            probe_with(Some(EngineKind::Generic), None, fixture_post(&[("tokenize", VLLM)])),
            None
        );
        assert_eq!(
            probe_with(
                Some(EngineKind::Sglang),
                None,
                fixture_post(&[("tokenize", VLLM)]),
            ),
            None
        );
    }

    #[test]
    fn declared_vllm_does_not_fall_through_to_tgi() {
        assert_eq!(
            probe_with(
                Some(EngineKind::Vllm),
                None,
                fixture_post(&[("chat_tokenize", TGI)]),
            ),
            None
        );
    }

    #[test]
    fn llama_probe_needs_both_routes() {
        assert_eq!(
            probe_with(
                Some(EngineKind::LlamaCpp),
                None,
                fixture_post(&[("apply-template", LLAMA_TEMPLATE)]),
            ),
            None
        );
        assert_eq!(
            probe_with(
                Some(EngineKind::LlamaCpp),
                None,
                fixture_post(&[("tokenize", LLAMA_TOKENS)]),
            ),
            None
        );
    }
}
