//! The `segmented` adapter: each ended turn becomes one 16 kHz WAV file
//! posted to the endpoint's own `/v1/audio/transcriptions` (non-streamed,
//! `response_format=json`). The result is one `delta` with the whole text,
//! then `completed`, the way `whisper-1` behaves.

use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::watch;

use super::EngineEndpoint;
use crate::protocol::RELAY_JSON_CONTROL_MAX_BYTES;
use crate::stt_wire::{
    STT_COMPLETED_TEXT_MAX_BYTES, STT_DELTA_TEXT_MAX_BYTES, STT_MESSAGE_MAX_BYTES,
    STT_TOKEN_COUNT_MAX, SttConfig, SttEngineUsage, SttEvent,
};

/// Output rate of the resampler and of every posted WAV.
pub const SAMPLE_RATE: u32 = 16_000;
/// A response body larger than this is not a transcript.
const RESPONSE_MAX_BYTES: usize = 1024 * 1024;
const TIMEOUT_MIN: Duration = Duration::from_secs(30);

/// One ended turn.
pub struct Item {
    pub item_seq: u32,
    pub samples: Vec<i16>,
    pub config: SttConfig,
}

/// How a turn ended at the engine.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The transcript, with the engine's token usage when it reported one
    /// (kept for metering).
    Text {
        text: String,
        usage: Option<SttEngineUsage>,
    },
    Failed {
        code: &'static str,
        message: String,
    },
}

/// Transcribes one turn; `None` when the session was cancelled meanwhile.
/// The turn is consumed: its samples are freed once the request body holds
/// them, so a turn is never held twice while the engine works.
pub fn transcribe(
    endpoint: &EngineEndpoint,
    item: Item,
    cancel: &mut watch::Receiver<bool>,
) -> Option<Outcome> {
    if item.samples.is_empty() {
        return Some(Outcome::Failed {
            code: "empty_item",
            message: "the item has no audio".into(),
        });
    }
    let runtime = match crate::daemon::upstream_runtime() {
        Ok(runtime) => runtime,
        Err(_) => {
            return Some(Outcome::Failed {
                code: "transport",
                message: "the upstream runtime is unavailable".into(),
            });
        }
    };
    let boundary = format!("wsmp-stt-{:016x}", rand::random::<u64>());
    let seconds = item.samples.len() as u64 / u64::from(SAMPLE_RATE);
    let body = multipart_body(&boundary, endpoint, &item);
    drop(item);
    let request = Request {
        boundary,
        body,
        timeout: TIMEOUT_MIN.max(Duration::from_secs(4 * seconds)),
    };
    runtime.block_on(async {
        tokio::select! {
            outcome = post(endpoint, request) => Some(outcome),
            _ = cancelled(cancel) => None,
        }
    })
}

struct Request {
    boundary: String,
    body: Vec<u8>,
    timeout: Duration,
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    while !*cancel.borrow() {
        if cancel.changed().await.is_err() {
            // The sender is gone: the session is over.
            return;
        }
    }
}

async fn post(endpoint: &EngineEndpoint, request: Request) -> Outcome {
    match send(endpoint, request).await {
        Ok(outcome) => outcome,
        // Never the error text: it can name the endpoint's credentials setup.
        Err(_) => Outcome::Failed {
            code: "transport",
            message: "the transcription request failed".into(),
        },
    }
}

async fn send(endpoint: &EngineEndpoint, request: Request) -> Result<Outcome> {
    let url = crate::daemon::endpoint_url(&endpoint.base_url, "/v1/audio/transcriptions")?;
    let mut builder = crate::daemon::upstream_http_client()?
        .post(url.as_str())
        .timeout(request.timeout)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={}", request.boundary),
        )
        .body(request.body);
    for (name, value) in endpoint.credential_headers()? {
        builder = builder.header(name, value);
    }
    let mut response = builder.send().await.context("posting a turn")?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.context("reading a transcription")? {
        if bytes.len() + chunk.len() > RESPONSE_MAX_BYTES {
            return Ok(Outcome::Failed {
                code: "transcript_too_large",
                message: "the transcription response is too large".into(),
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(outcome(status.as_u16(), &bytes))
}

/// Maps an engine answer to an outcome. Redirects are never followed, so a
/// 3xx is its own failure, not a server error; so is a stray 1xx.
pub fn outcome(status: u16, body: &[u8]) -> Outcome {
    let failed = |code, verb: &str| Outcome::Failed {
        code,
        message: format!("the engine {verb} the turn ({status})"),
    };
    match status {
        200..=299 => {}
        100..=199 => return failed("upstream_1xx", "did not finish"),
        300..=399 => return failed("upstream_redirect", "redirected"),
        400..=499 => return failed("upstream_4xx", "refused"),
        _ => return failed("upstream_5xx", "failed"),
    }
    let value = serde_json::from_slice::<serde_json::Value>(body).ok();
    let Some(text) = value
        .as_ref()
        .and_then(|value| value.get("text"))
        .and_then(serde_json::Value::as_str)
    else {
        return Outcome::Failed {
            code: "invalid_response",
            message: "the engine answered without a transcript".into(),
        };
    };
    Outcome::Text {
        text: text.to_string(),
        usage: value.as_ref().and_then(|value| usage(value.get("usage")?)),
    }
}

/// Token usage in either the OpenAI (`input_tokens`/`output_tokens`) or the
/// vLLM (`prompt_tokens`/`completion_tokens`) spelling; duration-only usage
/// and counts outside the wire bound are dropped.
pub(crate) fn usage(value: &serde_json::Value) -> Option<SttEngineUsage> {
    let count = |names: [&str; 2]| {
        names
            .iter()
            .find_map(|name| value.get(*name)?.as_u64())
            .filter(|tokens| *tokens <= STT_TOKEN_COUNT_MAX)
    };
    let usage = SttEngineUsage {
        input_tokens: count(["input_tokens", "prompt_tokens"]),
        output_tokens: count(["output_tokens", "completion_tokens"]),
    };
    (usage.input_tokens.is_some() || usage.output_tokens.is_some()).then_some(usage)
}

/// The OpenAI file transcription form: the WAV plus `model`,
/// `response_format=json` and the optional language and prompt. The WAV is
/// written straight into the body (one copy of the turn, not two).
pub fn multipart_body(boundary: &str, endpoint: &EngineEndpoint, item: &Item) -> Vec<u8> {
    let mut body = Vec::with_capacity(1024 + 44 + item.samples.len() * 2);
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    };
    field("model", &endpoint.model);
    field("response_format", "json");
    if let Some(language) = &item.config.language {
        field("language", language);
    }
    if let Some(prompt) = &item.config.prompt {
        field("prompt", prompt);
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    write_wav(&mut body, &item.samples);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Appends a 16 kHz mono 16-bit PCM RIFF/WAVE file.
pub fn write_wav(wav: &mut Vec<u8>, samples: &[i16]) {
    let data_len = (samples.len() * 2) as u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
}

/// Room for event text in one JSON control frame: the 64 KiB frame less a
/// margin for the `stt.event` envelope (type, session id, item number, usage
/// counts), which is a few hundred bytes at most.
pub const STT_EVENT_TEXT_ESCAPED_MAX_BYTES: usize = RELAY_JSON_CONTROL_MAX_BYTES - 1024;

/// The bytes `text` takes as a JSON string (quotes included), as serde_json
/// writes it: `"` and `\` and the short escapes take 2 bytes, other control
/// characters 6 (`\u00XX`), everything else its UTF-8 length.
pub fn json_escaped_len(text: &str) -> usize {
    2 + text
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            control if (control as u32) < 0x20 => 6,
            other => other.len_utf8(),
        })
        .sum::<usize>()
}

/// Whether a final transcript fits the wire: at most 48 KiB as text and one
/// control frame once JSON-escaped. Otherwise only its item fails.
pub fn transcript_fits(text: &str) -> bool {
    text.len() <= STT_COMPLETED_TEXT_MAX_BYTES
        && json_escaped_len(text) <= STT_EVENT_TEXT_ESCAPED_MAX_BYTES
}

/// The events one turn produces, always within the wire bounds: the text as
/// deltas that each fit one frame, then `completed`; a transcript over the
/// bounds ([`transcript_fits`]) fails the item instead, never the session.
pub fn events(item_seq: u32, outcome: Outcome) -> Vec<SttEvent> {
    match outcome {
        Outcome::Text { text, .. } if !transcript_fits(&text) => {
            vec![SttEvent::Failed {
                item_seq,
                code: "transcript_too_large".into(),
                message: "the transcript exceeds the frame limit".into(),
            }]
        }
        Outcome::Text { text, usage } => {
            let mut events: Vec<SttEvent> = split_delta_text(&text)
                .into_iter()
                .map(|delta| SttEvent::Delta {
                    item_seq,
                    text: delta.to_string(),
                })
                .collect();
            events.push(SttEvent::Completed {
                item_seq,
                text,
                engine_usage: usage,
            });
            events
        }
        Outcome::Failed { code, message } => vec![SttEvent::Failed {
            item_seq,
            code: code.into(),
            message: truncate(&message, STT_MESSAGE_MAX_BYTES).to_string(),
        }],
    }
}

/// Delta pieces of at most 16 KiB of text whose JSON-escaped form also fits
/// one control frame, cut on character boundaries.
pub fn split_delta_text(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut raw = 0;
    let mut escaped = 2;
    for (index, character) in text.char_indices() {
        let width = character.len_utf8();
        let cost = json_escaped_len(&text[index..index + width]) - 2;
        if raw + width > STT_DELTA_TEXT_MAX_BYTES
            || escaped + cost > STT_EVENT_TEXT_ESCAPED_MAX_BYTES
        {
            pieces.push(&text[start..index]);
            start = index;
            raw = 0;
            escaped = 2;
        }
        raw += width;
        escaped += cost;
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

/// `text` in pieces of at most `max` bytes, cut on character boundaries.
pub fn split_text(text: &str, max: usize) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let piece = truncate(rest, max);
        if piece.is_empty() {
            break;
        }
        pieces.push(piece);
        rest = &rest[piece.len()..];
    }
    pieces
}

/// The longest prefix of `text` of at most `max` bytes on a character boundary.
pub fn truncate(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
