//! Bounded completion-token estimation for relay usage reporting.
//!
//! Upstream counts remain available for observability. The relay additionally
//! uses one shared `cl100k_base` tokenizer so Chat Test TPS stays comparable
//! across models with different native tokenizers. This count is not persisted
//! as provider usage.

use tiktoken_rs::cl100k_base_singleton;

use crate::protocol::frames::RelayMetrics;

/// The one tokenizer relay metrics name.
pub const RELAY_METRIC_TOKENIZER: &str = "cl100k_base";

/// Memory retained for an otherwise unbounded upstream completion. Large
/// responses simply omit the fallback estimate instead of risking relay OOM.
const COMPLETION_TEXT_MAX_BYTES: usize = 1024 * 1024;

/// Count ordinary tokens in generated completion text with the shared baseline
/// tokenizer. This is deliberately not a provider-native usage value.
pub fn count_completion_tokens(text: &str) -> u32 {
    let count = cl100k_base_singleton().count_ordinary(text);
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Build standardized TPS metrics without altering upstream usage fields.
pub fn standardized_completion_metrics(completion_text: Option<&str>) -> Option<RelayMetrics> {
    completion_text.map(|text| RelayMetrics {
        completion_tokens: u64::from(count_completion_tokens(text)),
        tokenizer: RELAY_METRIC_TOKENIZER.to_string(),
    })
}

/// Incremental, byte-oriented collector for streaming OpenAI-compatible
/// responses. HTTP chunks may split a UTF-8 code point, so JSON is parsed only
/// after a complete SSE line is available.
#[derive(Debug, Default)]
pub struct CompletionTextCollector {
    line_buf: Vec<u8>,
    mode: CollectorMode,
}

/// What the collector has learnt about the response so far.
#[derive(Debug)]
enum CollectorMode {
    /// No SSE `data:` line yet: the body is kept whole (up to the cap) in
    /// case it is one plain JSON completion. `raw_json` is `None` once the
    /// body outgrew the cap: it can then only still be SSE.
    Detecting { raw_json: Option<Vec<u8>> },
    /// An SSE stream: the completion text gathered from its `data:` lines.
    Sse { completion: String },
    /// A bounded limit was exceeded: no estimate, and nothing more is parsed.
    Exceeded,
}

impl Default for CollectorMode {
    fn default() -> Self {
        Self::Detecting {
            raw_json: Some(Vec::new()),
        }
    }
}

impl CompletionTextCollector {
    pub fn feed(&mut self, chunk: &[u8]) {
        if let CollectorMode::Detecting { raw_json } = &mut self.mode {
            // Too big to be one plain JSON completion; an SSE stream may
            // still follow in the same bytes.
            if let Some(raw) = raw_json {
                if chunk.len() > COMPLETION_TEXT_MAX_BYTES.saturating_sub(raw.len()) {
                    *raw_json = None;
                } else {
                    raw.extend_from_slice(chunk);
                }
            }
        }

        for byte in chunk.iter().copied() {
            if matches!(self.mode, CollectorMode::Exceeded) {
                return;
            }
            if self.line_buf.len() == COMPLETION_TEXT_MAX_BYTES {
                self.exceed();
                return;
            }
            self.line_buf.push(byte);
            if byte == b'\n' {
                let line = std::mem::take(&mut self.line_buf);
                self.consume_line(&line);
            }
        }
    }

    /// Returns `None` when the response exceeded a bounded collector limit or
    /// was not a parseable OpenAI-compatible completion.
    pub fn finish(mut self) -> Option<String> {
        if !self.line_buf.is_empty() && !matches!(self.mode, CollectorMode::Exceeded) {
            let line = std::mem::take(&mut self.line_buf);
            self.consume_line(&line);
        }
        match self.mode {
            CollectorMode::Detecting { raw_json } => completion_text_from_json_bytes(&raw_json?),
            CollectorMode::Sse { completion } => Some(completion),
            CollectorMode::Exceeded => None,
        }
    }

    fn exceed(&mut self) {
        self.line_buf = Vec::new();
        self.mode = CollectorMode::Exceeded;
    }

    fn consume_line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let data = data.trim_ascii_start();
        if data.is_empty() || data == b"[DONE]" {
            return;
        }
        if matches!(self.mode, CollectorMode::Detecting { .. }) {
            self.mode = CollectorMode::Sse {
                completion: String::new(),
            };
        }
        if let Some(piece) = completion_text_from_json_bytes(data) {
            self.push_completion(&piece);
        }
    }

    fn push_completion(&mut self, piece: &str) {
        let CollectorMode::Sse { completion } = &mut self.mode else {
            return;
        };
        if piece.len() > COMPLETION_TEXT_MAX_BYTES.saturating_sub(completion.len()) {
            self.exceed();
            return;
        }
        completion.push_str(piece);
    }
}

fn completion_text_from_json_bytes(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    completion_text_from_json_value(&value)
}

fn completion_text_from_json_value(value: &serde_json::Value) -> Option<String> {
    let choices = value.get("choices")?.as_array()?;
    let mut out = String::new();
    for choice in choices {
        push_reasoning_text(&mut out, choice);
        push_tool_call_arguments(&mut out, choice.pointer("/delta/tool_calls"));
        push_tool_call_arguments(&mut out, choice.pointer("/message/tool_calls"));
        if let Some(content) = choice
            .pointer("/delta/content")
            .and_then(serde_json::Value::as_str)
        {
            out.push_str(content);
            continue;
        }
        if let Some(content) = choice
            .pointer("/message/content")
            .and_then(serde_json::Value::as_str)
        {
            out.push_str(content);
            continue;
        }
        if let Some(text) = choice.get("text").and_then(serde_json::Value::as_str) {
            out.push_str(text);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn push_reasoning_text(out: &mut String, choice: &serde_json::Value) {
    for pointer in [
        "/delta/reasoning_content",
        "/delta/reasoning",
        "/message/reasoning_content",
        "/message/reasoning",
    ] {
        if let Some(text) = choice.pointer(pointer).and_then(serde_json::Value::as_str) {
            out.push_str(text);
            return;
        }
    }
}

fn push_tool_call_arguments(out: &mut String, tool_calls: Option<&serde_json::Value>) {
    let Some(tool_calls) = tool_calls.and_then(serde_json::Value::as_array) else {
        return;
    };
    for call in tool_calls {
        if let Some(arguments) = call
            .pointer("/function/arguments")
            .and_then(serde_json::Value::as_str)
        {
            out.push_str(arguments);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standardized_metrics_use_the_shared_count() {
        let metrics = standardized_completion_metrics(Some("longer text")).expect("metrics");
        assert_eq!(
            metrics.completion_tokens,
            u64::from(count_completion_tokens("longer text"))
        );
        assert_eq!(metrics.tokenizer, RELAY_METRIC_TOKENIZER);
    }

    #[test]
    fn absent_completion_text_has_no_standardized_metrics() {
        assert_eq!(standardized_completion_metrics(None), None);
    }

    #[test]
    fn preserves_sse_content_when_utf8_is_split_between_http_chunks() {
        let mut collector = CompletionTextCollector::default();
        collector.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"");
        collector.feed(&[0xf0, 0x9f]);
        collector.feed(&[0x92, 0xa1]);
        collector.feed(b"\"}}]}\n\n");
        assert_eq!(collector.finish().as_deref(), Some("💡"));
    }

    #[test]
    fn refuses_an_estimate_after_the_bounded_completion_limit() {
        let mut collector = CompletionTextCollector::default();
        let response = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\n",
            "x".repeat(COMPLETION_TEXT_MAX_BYTES + 1)
        );
        collector.feed(response.as_bytes());
        assert_eq!(collector.finish(), None);
    }

    /// One large HTTP chunk of an ordinary SSE stream (many small events,
    /// together over the cap) still yields its estimate: only a plain JSON
    /// body has to fit the cap whole.
    #[test]
    fn a_first_chunk_over_the_cap_of_a_valid_sse_stream_still_counts() {
        let event = "data: {\"choices\":[{\"delta\":{\"content\":\"ab\"}}]}\n\n";
        let events = COMPLETION_TEXT_MAX_BYTES / event.len() + 2;
        let body = event.repeat(events);
        assert!(body.len() > COMPLETION_TEXT_MAX_BYTES);
        let mut collector = CompletionTextCollector::default();
        collector.feed(body.as_bytes());
        assert_eq!(collector.finish().map(|text| text.len()), Some(events * 2));
    }

    #[test]
    fn a_plain_json_body_over_the_cap_has_no_estimate() {
        let body = format!(
            "{{\"choices\":[{{\"message\":{{\"content\":\"{}\"}}}}]}}",
            "x".repeat(COMPLETION_TEXT_MAX_BYTES)
        );
        let mut collector = CompletionTextCollector::default();
        collector.feed(body.as_bytes());
        assert_eq!(collector.finish(), None);
        let mut small = CompletionTextCollector::default();
        small.feed(br#"{"choices":[{"message":{"content":"hi"}}]}"#);
        assert_eq!(small.finish().as_deref(), Some("hi"));
    }

    #[test]
    fn nothing_is_parsed_once_the_limit_is_exceeded() {
        let mut collector = CompletionTextCollector::default();
        let huge = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\n",
            "x".repeat(COMPLETION_TEXT_MAX_BYTES / 2 + 1)
        );
        collector.feed(huge.as_bytes());
        collector.feed(huge.as_bytes());
        assert!(matches!(collector.mode, CollectorMode::Exceeded));
        collector.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\n");
        assert!(collector.line_buf.is_empty());
        assert_eq!(collector.finish(), None);
    }

    #[test]
    fn counts_reasoning_only_sse_deltas() {
        let mut collector = CompletionTextCollector::default();
        collector.feed(br#"data: {"choices":[{"delta":{"reasoning_content":"plan then "}}]}"#);
        collector.feed(b"\n\n");
        collector.feed(br#"data: {"choices":[{"delta":{"reasoning":"answer"}}]}"#);
        collector.feed(b"\n\n");
        assert_eq!(collector.finish().as_deref(), Some("plan then answer"));
    }

    #[test]
    fn counts_mixed_reasoning_and_content() {
        let mut collector = CompletionTextCollector::default();
        collector.feed(
            br#"data: {"choices":[{"delta":{"reasoning_content":"think ","content":"hi "}}]}"#,
        );
        collector.feed(b"\n\n");
        collector.feed(
            br#"data: {"choices":[{"message":{"reasoning_content":"more ","content":"there"}}]}"#,
        );
        collector.feed(b"\n\n");
        assert_eq!(collector.finish().as_deref(), Some("think hi more there"));
    }

    #[test]
    fn counts_tool_call_argument_deltas() {
        let mut collector = CompletionTextCollector::default();
        collector.feed(
            br#"data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\"q\":"}}]}}]}"#,
        );
        collector.feed(b"\n\n");
        collector.feed(
            br#"data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\"hi\"}"}}]}}]}"#,
        );
        collector.feed(b"\n\n");
        assert_eq!(collector.finish().as_deref(), Some("{\"q\":\"hi\"}"));
    }
}
