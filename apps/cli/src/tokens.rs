//! Bounded completion-token estimation for relay usage reporting.
//!
//! Upstream counts remain available for observability. The relay additionally
//! uses one shared `cl100k_base` tokenizer so Chat Test TPS stays comparable
//! across models with different native tokenizers. This count is not persisted
//! as provider usage.

use tiktoken_rs::cl100k_base_singleton;

use crate::protocol::{RelayMetricTokenizer, RelayMetrics};

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
        completion_tokens: count_completion_tokens(text),
        tokenizer: RelayMetricTokenizer::Cl100kBase,
    })
}

/// Incremental, byte-oriented collector for streaming OpenAI-compatible
/// responses. HTTP chunks may split a UTF-8 code point, so JSON is parsed only
/// after a complete SSE line is available.
#[derive(Debug, Default)]
pub struct CompletionTextCollector {
    line_buf: Vec<u8>,
    completion: String,
    raw_json: Vec<u8>,
    saw_sse_data: bool,
    line_overflow: bool,
    exceeded_limit: bool,
}

impl CompletionTextCollector {
    pub fn feed(&mut self, chunk: &[u8]) {
        if !self.saw_sse_data && !self.exceeded_limit {
            self.push_raw_json(chunk);
        }

        for byte in chunk.iter().copied() {
            if self.line_overflow {
                if byte == b'\n' {
                    self.line_overflow = false;
                }
                continue;
            }
            if self.line_buf.len() == COMPLETION_TEXT_MAX_BYTES {
                self.line_buf.clear();
                self.exceeded_limit = true;
                self.line_overflow = byte != b'\n';
                continue;
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
        if !self.line_buf.is_empty() && !self.line_overflow {
            let line = std::mem::take(&mut self.line_buf);
            self.consume_line(&line);
        }
        if self.exceeded_limit {
            return None;
        }
        if self.completion.is_empty() && !self.saw_sse_data {
            return completion_text_from_json_bytes(&self.raw_json);
        }
        Some(self.completion)
    }

    fn push_raw_json(&mut self, chunk: &[u8]) {
        let remaining = COMPLETION_TEXT_MAX_BYTES.saturating_sub(self.raw_json.len());
        if chunk.len() > remaining {
            self.exceeded_limit = true;
            return;
        }
        self.raw_json.extend_from_slice(chunk);
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
        if !self.saw_sse_data {
            self.saw_sse_data = true;
            self.raw_json.clear();
        }
        if let Some(piece) = completion_text_from_json_bytes(data) {
            self.push_completion(&piece);
        }
    }

    fn push_completion(&mut self, piece: &str) {
        if piece.len() > COMPLETION_TEXT_MAX_BYTES.saturating_sub(self.completion.len()) {
            self.completion.clear();
            self.exceeded_limit = true;
            return;
        }
        self.completion.push_str(piece);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standardized_metrics_use_the_shared_count() {
        let metrics = standardized_completion_metrics(Some("longer text")).expect("metrics");
        assert_eq!(
            metrics.completion_tokens,
            count_completion_tokens("longer text")
        );
        assert_eq!(metrics.tokenizer, RelayMetricTokenizer::Cl100kBase);
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
}
