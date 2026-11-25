//! Token usage an upstream reports at the end of a response (JSON or the
//! final SSE event), read from a bounded tail of the response.

use crate::protocol::frames::RelayUsage;

/// Keep enough of a streaming completion to parse a terminal OpenAI usage
/// event without retaining an unbounded generated response in the relay.
const RELAY_USAGE_TAIL_MAX_BYTES: usize = 256 * 1024;

pub(super) fn append_usage_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.len() >= RELAY_USAGE_TAIL_MAX_BYTES {
        tail.clear();
        tail.extend_from_slice(&chunk[chunk.len() - RELAY_USAGE_TAIL_MAX_BYTES..]);
        return;
    }
    let excess = tail
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(RELAY_USAGE_TAIL_MAX_BYTES);
    if excess > 0 {
        tail.drain(..excess);
    }
    tail.extend_from_slice(chunk);
}

/// Usage as an OpenAI-compatible upstream reports it (snake_case, with
/// extra fields the relay ignores).
#[derive(serde::Deserialize)]
struct UpstreamUsage {
    #[serde(default, alias = "promptTokens")]
    prompt_tokens: Option<u64>,
    #[serde(default, alias = "completionTokens")]
    completion_tokens: Option<u64>,
    #[serde(default, alias = "totalTokens")]
    total_tokens: Option<u64>,
}

impl From<UpstreamUsage> for RelayUsage {
    fn from(usage: UpstreamUsage) -> Self {
        Self {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
        }
    }
}

/// Extract upstream-provided terminal usage from either a JSON completion or
/// the final OpenAI SSE `data:` event. Shared-tokenizer accounting is separate
/// from usage and happens in [`standardized_completion_metrics`](crate::tokens::standardized_completion_metrics).
pub(super) fn terminal_usage_from_response(bytes: &[u8]) -> Option<RelayUsage> {
    #[derive(serde::Deserialize)]
    struct Completion {
        usage: Option<UpstreamUsage>,
    }

    serde_json::from_slice::<Completion>(bytes)
        .ok()
        .and_then(|completion| completion.usage)
        .map(RelayUsage::from)
        .or_else(|| terminal_usage_from_json_tail(bytes))
        .or_else(|| {
            std::str::from_utf8(bytes).ok().and_then(|body| {
                body.lines()
                    .filter_map(|line| {
                        line.strip_prefix("data: ")
                            .filter(|data| *data != "[DONE]")
                            .and_then(|data| serde_json::from_str::<Completion>(data).ok())
                            .and_then(|completion| completion.usage)
                    })
                    .next_back()
                    .map(RelayUsage::from)
            })
        })
}

/// Parse a complete `usage` object from a bounded trailing window of a large
/// non-stream JSON response. Unlike deserializing the whole tail, this remains
/// valid when the beginning of the document was intentionally discarded.
fn terminal_usage_from_json_tail(bytes: &[u8]) -> Option<RelayUsage> {
    const USAGE_KEY: &[u8] = b"\"usage\"";
    bytes
        .windows(USAGE_KEY.len())
        .enumerate()
        .rev()
        .filter_map(|(index, window)| (window == USAGE_KEY).then_some(index + USAGE_KEY.len()))
        .find_map(|after_key| {
            let mut index = after_key;
            while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
            }
            if bytes.get(index) != Some(&b':') {
                return None;
            }
            index += 1;
            while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
            }
            let end = json_object_end(bytes, index)?;
            serde_json::from_slice::<UpstreamUsage>(&bytes[index..end])
                .ok()
                .map(RelayUsage::from)
        })
}

/// Return the exclusive end of a JSON object starting at `start`, respecting
/// nested objects/arrays and quoted escape sequences.
fn json_object_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'{') {
        return None;
    }
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'\"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'\"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(start + offset + 1);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_usage_comes_from_the_final_sse_completion_event() {
        let response = b"data: {\"usage\":{\"completionTokens\":2}}\n\ndata: {\"usage\":{\"promptTokens\":3,\"completionTokens\":5,\"totalTokens\":8}}\n\ndata: [DONE]\n\n";
        assert_eq!(
            terminal_usage_from_response(response),
            Some(RelayUsage {
                prompt_tokens: Some(3),
                completion_tokens: Some(5),
                total_tokens: Some(8),
            })
        );
    }

    #[test]
    fn terminal_usage_never_fabricates_missing_metrics() {
        assert_eq!(terminal_usage_from_response(br#"{"choices":[]}"#), None);
    }

    #[test]
    fn terminal_usage_survives_a_truncated_large_non_stream_json_tail() {
        let response = format!(
            r#"{{"choices":[{{"text":"{}"}}],"usage":{{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}}}"#,
            "x".repeat(RELAY_USAGE_TAIL_MAX_BYTES + 1),
        );
        let mut tail = Vec::new();
        append_usage_tail(&mut tail, response.as_bytes());

        assert_eq!(
            terminal_usage_from_response(&tail),
            Some(RelayUsage {
                prompt_tokens: Some(3),
                completion_tokens: Some(5),
                total_tokens: Some(8),
            })
        );
    }
}
