//! The `segmented` adapter: each ended turn becomes one 16 kHz WAV file
//! posted to the endpoint's own `/v1/audio/transcriptions` (non-streamed,
//! `response_format=json`). The result is one `delta` with the whole text,
//! then `completed`, the way `whisper-1` behaves.

use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::watch;

use crate::config::EndpointAuthMode;
use crate::stt_wire::{
    STT_COMPLETED_TEXT_MAX_BYTES, STT_DELTA_TEXT_MAX_BYTES, STT_MESSAGE_MAX_BYTES,
    STT_TOKEN_COUNT_MAX, SttConfig, SttEngineUsage, SttEvent,
};

/// Output rate of the resampler and of every posted WAV.
pub const SAMPLE_RATE: u32 = 16_000;
/// A response body larger than this is not a transcript.
const RESPONSE_MAX_BYTES: usize = 1024 * 1024;
const TIMEOUT_MIN: Duration = Duration::from_secs(30);

/// Where and how to post one turn.
#[derive(Debug, Clone)]
pub struct FileEndpoint {
    pub base_url: String,
    /// `(header name, environment variable)` pairs, as configured.
    pub headers: Vec<(String, String)>,
    pub auth: Option<(EndpointAuthMode, String)>,
    pub model: String,
}

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
    endpoint: &FileEndpoint,
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

async fn post(endpoint: &FileEndpoint, request: Request) -> Outcome {
    match send(endpoint, request).await {
        Ok(outcome) => outcome,
        // Never the error text: it can name the endpoint's credentials setup.
        Err(_) => Outcome::Failed {
            code: "transport",
            message: "the transcription request failed".into(),
        },
    }
}

async fn send(endpoint: &FileEndpoint, request: Request) -> Result<Outcome> {
    let url = crate::daemon::endpoint_url(&endpoint.base_url, "/v1/audio/transcriptions")?;
    let mut builder = crate::daemon::upstream_http_client()?
        .post(url.as_str())
        .timeout(request.timeout)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={}", request.boundary),
        )
        .body(request.body);
    for (name, env) in &endpoint.headers {
        let value =
            std::env::var(env).with_context(|| format!("reading endpoint header `{name}`"))?;
        builder = builder.header(name, value);
    }
    if let Some((mode, env)) = &endpoint.auth {
        let value = std::env::var(env).context("reading typed endpoint credential")?;
        builder = match mode {
            EndpointAuthMode::ApiKey => builder.header("x-api-key", value),
            EndpointAuthMode::Bearer => builder.header("authorization", format!("Bearer {value}")),
        };
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
/// 3xx is its own failure, not a server error.
pub fn outcome(status: u16, body: &[u8]) -> Outcome {
    let failed = |code, verb: &str| Outcome::Failed {
        code,
        message: format!("the engine {verb} the turn ({status})"),
    };
    match status {
        200..=299 => {}
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
fn usage(value: &serde_json::Value) -> Option<SttEngineUsage> {
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
pub fn multipart_body(boundary: &str, endpoint: &FileEndpoint, item: &Item) -> Vec<u8> {
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

/// The events one turn produces, always within the wire bounds: the text as
/// deltas of at most 16 KiB, then `completed`; a transcript over 48 KiB
/// fails the item instead.
pub fn events(item_seq: u32, outcome: Outcome) -> Vec<SttEvent> {
    match outcome {
        Outcome::Text { text, .. } if text.len() > STT_COMPLETED_TEXT_MAX_BYTES => {
            vec![SttEvent::Failed {
                item_seq,
                code: "transcript_too_large".into(),
                message: "the transcript exceeds 48 KiB".into(),
            }]
        }
        Outcome::Text { text, usage } => {
            let mut events: Vec<SttEvent> = split_text(&text, STT_DELTA_TEXT_MAX_BYTES)
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
