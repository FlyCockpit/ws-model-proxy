//! The `vllm` adapter: one session bridged to vLLM's realtime transcription
//! WebSocket (`/v1/realtime`, vLLM >= 0.16), so deltas arrive while the
//! person is still speaking.
//!
//! vLLM's protocol (`vllm/entrypoints/speech_to_text/realtime/`, checked
//! against `connection.py` and `protocol.py`):
//!
//! - The server sends `session.created`; the client sends
//!   `session.update{model}`. A wrong model gets `error{model_not_found}`; a
//!   right one gets **no answer**. Events are handled strictly in order, so
//!   the adapter follows the update with an event vLLM does not know and
//!   takes its `error{unknown_event}` as the proof that the update passed.
//! - `input_audio_buffer.commit` (no `final`) starts one generation;
//!   `input_audio_buffer.append{audio}` (PCM16, 16 kHz, mono, base64, never
//!   empty) feeds it; `commit{final:true}` ends its audio. The engine answers
//!   `transcription.delta{delta}` while it runs and `transcription.done{text,
//!   usage}` at the end, then clears its audio queue. Audio sent between the
//!   final commit and `done` would be lost, so the next item's audio waits
//!   (unacknowledged, so the credit window bounds it) until `done`.
//! - There is no clear, no VAD, no language and no prompt. A cleared item
//!   that already started is finished silently and its result dropped.
//! - vLLM marks a generation finished only after `done` (and the queue
//!   clear), so a start commit for the next item on the same connection can
//!   be ignored; an `error` during a generation leaves the queue in an
//!   unknown state. So each item gets a fresh connection (a few ms on
//!   localhost; each generation is a new engine request anyway).
//!
//! One thread per session owns the blocking `tungstenite` socket (the relay
//! client's crate; no new dependency). It reads with a short timeout and
//! takes relay input between reads. Logs carry ids, counts and codes only.

use std::io::ErrorKind;
use std::net::{Shutdown, TcpStream};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use base64::Engine as _;
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::{HeaderName, HeaderValue};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use super::{
    EngineEndpoint, EngineSocket, Input, SessionThread, ack, emit, emit_event, error, resample,
    segmented,
};
use crate::protocol::{ClientControlMessage, RelayFailure};
use crate::stt_wire::{STT_COMPLETED_TEXT_MAX_BYTES, SttEvent};

/// Connecting, the WebSocket handshake, and each handshake answer.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// One engine read; relay input is taken between reads.
const READ_POLL: Duration = Duration::from_millis(25);
/// A write the engine does not take within this is a dead engine.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// From the final commit to `transcription.done`.
const FINISH_TIMEOUT: Duration = Duration::from_secs(60);
/// One `append` carries at most 100 ms at 16 kHz.
const APPEND_MAX_SAMPLES: usize = 1_600;
/// Engine messages larger than this are not transcription events.
const ENGINE_MESSAGE_MAX_BYTES: usize = 1024 * 1024;
/// Relay inputs taken per pass, so engine events are never starved.
const INPUTS_PER_PASS: usize = 64;
/// The event the readiness probe sends; vLLM answers it with an error.
const PROBE_EVENT: &str = "wsmp.ready_probe";

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// Why a session ends from inside the thread.
enum Stop {
    /// Already reported, cancelled, or the relay loop is gone.
    Quiet,
    /// Report this `stt.error` and end.
    Fail(RelayFailure, &'static str),
}

/// The item the engine is working on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// No generation: the open item has no audio yet.
    Idle,
    /// A generation runs for `item`; `sent` samples so far.
    Streaming {
        item: u32,
        sent: usize,
        text_bytes: usize,
    },
    /// The final commit is sent; waiting for `done`. A cleared item drops
    /// its result.
    Finishing {
        item: u32,
        discard: bool,
        since: Instant,
        text_bytes: usize,
    },
}

/// Runs one `vllm` session until it ends; reports its own ending.
pub(super) fn run_session(session: SessionThread, slot: &EngineSocket) {
    let mut bridge = Bridge {
        session_id: session.session_id,
        endpoint: session.endpoint,
        tx: session.tx,
        cancel: session.cancel,
        slot: slot.clone(),
        socket: None,
        state: State::Idle,
        item_seq: 0,
        carry: Vec::new(),
        resampler: resample::Resampler24To16::new(),
        max_samples: session.max_item_seconds as usize * segmented::SAMPLE_RATE as usize,
        started: Instant::now(),
    };
    let ended = bridge.run(&session.inbox);
    bridge.disconnect();
    if let Err(Stop::Fail(failure, message)) = ended {
        tracing::warn!(
            session_id = %bridge.session_id,
            reason = message,
            "speech-to-text session failed"
        );
        emit(
            &bridge.tx,
            &bridge.session_id,
            error(&bridge.session_id, failure, message),
        );
    }
}

struct Bridge {
    session_id: String,
    endpoint: EngineEndpoint,
    tx: std::sync::mpsc::SyncSender<crate::relay_bus::FromWorker>,
    cancel: tokio::sync::watch::Receiver<bool>,
    slot: EngineSocket,
    socket: Option<Socket>,
    state: State,
    /// The open item's number (the next audio belongs to it).
    item_seq: u32,
    /// Resampled audio past the valve, for the next item.
    carry: Vec<i16>,
    resampler: resample::Resampler24To16,
    max_samples: usize,
    started: Instant,
}

impl Bridge {
    fn run(&mut self, inbox: &super::SessionInput) -> Result<(), Stop> {
        self.connect()?;
        self.send_relay(ClientControlMessage::SttOpened {
            session_id: self.session_id.clone(),
        })?;
        tracing::info!(
            session_id = %self.session_id,
            elapsed_ms = self.started.elapsed().as_millis() as u64,
            "speech-to-text engine session ready"
        );
        loop {
            self.check_cancel()?;
            self.read_engine()?;
            if let State::Finishing { since, .. } = self.state {
                // The next item's input waits for `done` (see the module docs).
                if since.elapsed() >= FINISH_TIMEOUT {
                    self.end_item_failed("timeout", "the engine did not finish the item")?;
                }
                continue;
            }
            for _ in 0..INPUTS_PER_PASS {
                let Some(input) = inbox.try_next().map_err(|()| Stop::Quiet)? else {
                    break;
                };
                self.input(input)?;
                if matches!(self.state, State::Finishing { .. }) {
                    break;
                }
            }
        }
    }

    fn check_cancel(&self) -> Result<(), Stop> {
        if *self.cancel.borrow() {
            return Err(Stop::Quiet);
        }
        Ok(())
    }

    fn input(&mut self, input: Input) -> Result<(), Stop> {
        match input {
            Input::Audio(bytes) => {
                let received = bytes.len() as u32;
                let mut samples = Vec::with_capacity(bytes.len() / 3 + 1);
                self.resampler.push(&bytes, &mut samples);
                self.feed(samples)?;
                // Acknowledged once written to the engine (or carried).
                self.send_relay(ack(&self.session_id, received))
            }
            Input::Commit(seq) => {
                if !self.names_open_item(seq, "commit")? {
                    return Ok(());
                }
                match self.state {
                    State::Streaming { .. } => self.finish(false),
                    _ => {
                        let item_seq = self.advance()?;
                        self.event(SttEvent::Failed {
                            item_seq,
                            code: "empty_item".into(),
                            message: "the item has no audio".into(),
                        })
                    }
                }
            }
            Input::Clear(seq) => {
                if !self.names_open_item(seq, "clear")? {
                    return Ok(());
                }
                match self.state {
                    State::Streaming { .. } => self.finish(true),
                    _ => self.advance().map(|_| ()),
                }
            }
            Input::Update(config) => {
                if config.is_empty() {
                    Ok(())
                } else {
                    Err(Stop::Fail(
                        RelayFailure::UnsupportedCapability,
                        "the vllm adapter takes no language or prompt",
                    ))
                }
            }
        }
    }

    /// True for the open item; false for an older one (the valve or the
    /// engine already ended it); a future item is a protocol error.
    fn names_open_item(&self, seq: u32, what: &'static str) -> Result<bool, Stop> {
        if seq > self.item_seq {
            return Err(Stop::Fail(
                RelayFailure::ProtocolError,
                if what == "commit" {
                    "commit names an item that has not started"
                } else {
                    "clear names an item that has not started"
                },
            ));
        }
        Ok(seq == self.item_seq)
    }

    /// Ends the open item's numbering; returns its number.
    fn advance(&mut self) -> Result<u32, Stop> {
        let item = self.item_seq;
        self.item_seq = self.item_seq.checked_add(1).ok_or(Stop::Fail(
            RelayFailure::ProtocolError,
            "the session ran out of item numbers",
        ))?;
        Ok(item)
    }

    /// Sends audio into the open item, starting its generation at its first
    /// sample and ending it at the `max_item_seconds` valve. What is past
    /// the valve waits in `carry` for the next item.
    fn feed(&mut self, samples: Vec<i16>) -> Result<(), Stop> {
        let mut rest = samples.as_slice();
        while !rest.is_empty() {
            match self.state {
                State::Finishing { .. } => {
                    self.carry.extend_from_slice(rest);
                    return Ok(());
                }
                State::Idle => {
                    self.send_engine(&json!({"type": "input_audio_buffer.commit"}))?;
                    self.state = State::Streaming {
                        item: self.item_seq,
                        sent: 0,
                        text_bytes: 0,
                    };
                }
                State::Streaming {
                    item,
                    sent,
                    text_bytes,
                } => {
                    let take = rest.len().min(self.max_samples - sent);
                    let (now, later) = rest.split_at(take);
                    for chunk in now.chunks(APPEND_MAX_SAMPLES) {
                        self.append(chunk)?;
                    }
                    rest = later;
                    let sent = sent + take;
                    self.state = State::Streaming {
                        item,
                        sent,
                        text_bytes,
                    };
                    if sent >= self.max_samples {
                        self.event(SttEvent::AutoCommitted { item_seq: item })?;
                        self.finish(false)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn append(&mut self, samples: &[i16]) -> Result<(), Stop> {
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let audio = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.send_engine(&json!({"type": "input_audio_buffer.append", "audio": audio}))
    }

    /// The final commit for the streaming item; its result is dropped when
    /// `discard` (a clear).
    fn finish(&mut self, discard: bool) -> Result<(), Stop> {
        let State::Streaming {
            item, text_bytes, ..
        } = self.state
        else {
            return Ok(());
        };
        self.send_engine(&json!({"type": "input_audio_buffer.commit", "final": true}))?;
        self.advance()?;
        self.state = State::Finishing {
            item,
            discard,
            since: Instant::now(),
            text_bytes,
        };
        Ok(())
    }

    /// Reads at most one engine message (waiting up to [`READ_POLL`]).
    fn read_engine(&mut self) -> Result<(), Stop> {
        let socket = self.socket.as_mut().ok_or(Stop::Quiet)?;
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                return Ok(());
            }
            Err(_) => {
                self.check_cancel()?;
                return Err(Stop::Fail(
                    RelayFailure::Transport,
                    "the engine connection closed",
                ));
            }
        };
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => {
                return Err(Stop::Fail(
                    RelayFailure::Transport,
                    "the engine connection closed",
                ));
            }
            _ => return Ok(()),
        };
        let Ok(event) = serde_json::from_str::<Value>(text.as_str()) else {
            return Ok(());
        };
        match event.get("type").and_then(Value::as_str) {
            Some("transcription.delta") => {
                let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                self.delta(delta)
            }
            Some("transcription.done") => self.done(&event),
            Some("error") => {
                let code = event.get("code").and_then(Value::as_str).unwrap_or("");
                self.engine_error(code)
            }
            _ => Ok(()),
        }
    }

    fn delta(&mut self, delta: &str) -> Result<(), Stop> {
        let (item, discard, total) = match &mut self.state {
            State::Streaming {
                item, text_bytes, ..
            } => {
                *text_bytes += delta.len();
                (*item, false, *text_bytes)
            }
            State::Finishing {
                item,
                discard,
                text_bytes,
                ..
            } => {
                *text_bytes += delta.len();
                (*item, *discard, *text_bytes)
            }
            State::Idle => return Ok(()),
        };
        if total > STT_COMPLETED_TEXT_MAX_BYTES {
            return self.end_item_failed("transcript_too_large", "the transcript exceeds 48 KiB");
        }
        if discard || delta.is_empty() {
            return Ok(());
        }
        // Each piece also fits one control frame once JSON-escaped.
        for piece in segmented::split_delta_text(delta) {
            self.event(SttEvent::Delta {
                item_seq: item,
                text: piece.to_string(),
            })?;
        }
        Ok(())
    }

    fn done(&mut self, event: &Value) -> Result<(), Stop> {
        let (item, discard) = match self.state {
            State::Finishing { item, discard, .. } => (item, discard),
            // The engine ended the item itself (its token limit, say): like
            // the valve, the item is committed for the client.
            State::Streaming { item, .. } => {
                self.event(SttEvent::AutoCommitted { item_seq: item })?;
                self.advance()?;
                (item, false)
            }
            State::Idle => return Ok(()),
        };
        self.state = State::Idle;
        if !discard {
            let text = event
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let usage = event.get("usage").and_then(segmented::usage);
            tracing::info!(
                session_id = %self.session_id,
                item_seq = item,
                "speech-to-text item transcribed"
            );
            for event in segmented::events(item, segmented::Outcome::Text { text, usage })
                .into_iter()
                // The deltas already went out as they came.
                .filter(|event| !matches!(event, SttEvent::Delta { .. }))
            {
                self.event(event)?;
            }
        }
        self.next_connection()
    }

    fn engine_error(&mut self, code: &str) -> Result<(), Stop> {
        match self.state {
            State::Idle => Err(Stop::Fail(
                RelayFailure::Upstream5xx,
                "the engine reported an error",
            )),
            _ => {
                let (code, message) = match code {
                    "invalid_audio" => ("invalid_audio", "the engine refused the audio"),
                    _ => ("engine_error", "the engine failed the item"),
                };
                self.end_item_failed(code, message)
            }
        }
    }

    /// The engine failed the item in flight: report it (unless cleared),
    /// then reconnect, since the engine's audio queue is now unknown.
    fn end_item_failed(&mut self, code: &str, message: &str) -> Result<(), Stop> {
        let (item, discard) = match self.state {
            State::Streaming { item, .. } => {
                self.event(SttEvent::AutoCommitted { item_seq: item })?;
                self.advance()?;
                (item, false)
            }
            State::Finishing { item, discard, .. } => (item, discard),
            State::Idle => return Ok(()),
        };
        tracing::warn!(
            session_id = %self.session_id,
            item_seq = item,
            code,
            "speech-to-text item failed at the engine"
        );
        self.state = State::Idle;
        if !discard {
            self.event(SttEvent::Failed {
                item_seq: item,
                code: code.into(),
                message: message.into(),
            })?;
        }
        self.next_connection()
    }

    /// Every item gets a fresh engine connection: vLLM marks a generation
    /// finished only after it has sent `done` and cleared its queue, so a
    /// start commit on the same connection can race that and be ignored.
    /// After an error the old queue's state is unknown as well. A new
    /// connection (with its own readiness check) is a new, empty session.
    fn next_connection(&mut self) -> Result<(), Stop> {
        self.disconnect();
        self.check_cancel()?;
        self.connect()?;
        let carry = std::mem::take(&mut self.carry);
        self.feed(carry)
    }

    fn event(&self, event: SttEvent) -> Result<(), Stop> {
        if emit_event(&self.tx, &self.session_id, event) {
            Ok(())
        } else {
            Err(Stop::Quiet)
        }
    }

    fn send_relay(&self, message: ClientControlMessage) -> Result<(), Stop> {
        if emit(&self.tx, &self.session_id, message) {
            Ok(())
        } else {
            Err(Stop::Quiet)
        }
    }

    fn send_engine(&mut self, event: &Value) -> Result<(), Stop> {
        let socket = self.socket.as_mut().ok_or(Stop::Quiet)?;
        if socket.send(Message::Text(event.to_string().into())).is_ok() {
            return Ok(());
        }
        self.check_cancel()?;
        Err(Stop::Fail(
            RelayFailure::Transport,
            "writing to the engine failed",
        ))
    }

    /// Opens the engine session: WebSocket handshake, `session.created`,
    /// `session.update{model}` and the readiness probe.
    fn connect(&mut self) -> Result<(), Stop> {
        let (socket, tcp) = open_socket(&self.endpoint).map_err(|failure| {
            tracing::info!(
                session_id = %self.session_id,
                reason = failure.1,
                "speech-to-text engine connection failed"
            );
            Stop::Fail(failure.0, failure.1)
        })?;
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some(tcp);
        }
        self.socket = Some(socket);
        // The relay loop may have ended the session while this connected.
        self.check_cancel()?;
        self.wait_for(|event| match event.get("type").and_then(Value::as_str) {
            Some("session.created") => Some(Ok(())),
            Some("error") => Some(Err(Stop::Fail(
                RelayFailure::Upstream5xx,
                "the engine refused the session",
            ))),
            _ => None,
        })?;
        let model = self.endpoint.model.clone();
        self.send_engine(&json!({"type": "session.update", "model": model}))?;
        self.send_engine(&json!({"type": PROBE_EVENT}))?;
        self.wait_for(|event| match event.get("type").and_then(Value::as_str) {
            // Our probe's answer: the update before it passed.
            Some("error") if event.get("code").and_then(Value::as_str) == Some("unknown_event") => {
                Some(Ok(()))
            }
            Some("session.updated") => Some(Ok(())),
            Some("error") => Some(Err(match event.get("code").and_then(Value::as_str) {
                Some("model_not_found" | "invalid_event") => Stop::Fail(
                    RelayFailure::NotFound,
                    "the engine does not serve that model",
                ),
                _ => Stop::Fail(RelayFailure::Upstream4xx, "the engine refused the session"),
            })),
            _ => None,
        })
    }

    /// Reads engine events until `decide` settles, within the handshake time.
    fn wait_for(
        &mut self,
        decide: impl Fn(&Value) -> Option<Result<(), Stop>>,
    ) -> Result<(), Stop> {
        let until = Instant::now() + HANDSHAKE_TIMEOUT;
        loop {
            self.check_cancel()?;
            if Instant::now() >= until {
                return Err(Stop::Fail(
                    RelayFailure::Timeout,
                    "the engine did not answer the session setup",
                ));
            }
            let socket = self.socket.as_mut().ok_or(Stop::Quiet)?;
            let text = match socket.read() {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(_)) => {
                    return Err(Stop::Fail(
                        RelayFailure::Transport,
                        "the engine connection closed",
                    ));
                }
                Ok(_) => continue,
                Err(tungstenite::Error::Io(error))
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    continue;
                }
                Err(_) => {
                    self.check_cancel()?;
                    return Err(Stop::Fail(
                        RelayFailure::Transport,
                        "the engine connection closed",
                    ));
                }
            };
            if let Ok(event) = serde_json::from_str::<Value>(text.as_str())
                && let Some(decision) = decide(&event)
            {
                return decision;
            }
        }
    }

    /// Closes the engine connection: vLLM cancels a running generation when
    /// its socket goes away.
    fn disconnect(&mut self) {
        if let Some(mut socket) = self.socket.take() {
            let _ = socket.close(None);
            let _ = socket.flush();
        }
        if let Some(tcp) = self.slot.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tcp.shutdown(Shutdown::Both);
        }
    }
}

type OpenFailure = (RelayFailure, &'static str);

/// Connects to `/v1/realtime` with the endpoint's headers. Returns the
/// socket (reading with [`READ_POLL`]) and a handle to shut it down.
fn open_socket(endpoint: &EngineEndpoint) -> Result<(Socket, TcpStream), OpenFailure> {
    let request = realtime_request(endpoint).map_err(|_| {
        (
            RelayFailure::UnsupportedCapability,
            "the engine realtime URL or credentials are not usable",
        )
    })?;
    let uri = request.uri().clone();
    let host = uri.host().unwrap_or_default().to_string();
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("wss") {
            443
        } else {
            80
        });
    let addresses = std::net::ToSocketAddrs::to_socket_addrs(&(host.as_str(), port))
        .map_err(|_| (RelayFailure::Transport, "could not resolve the engine"))?;
    let tcp = addresses
        .into_iter()
        .find_map(|address| TcpStream::connect_timeout(&address, HANDSHAKE_TIMEOUT).ok())
        .ok_or((RelayFailure::Transport, "could not connect to the engine"))?;
    let configure = |tcp: &TcpStream, read: Duration| {
        tcp.set_read_timeout(Some(read))?;
        tcp.set_write_timeout(Some(WRITE_TIMEOUT))?;
        tcp.set_nodelay(true)?;
        tcp.try_clone()
    };
    let handle = configure(&tcp, HANDSHAKE_TIMEOUT)
        .map_err(|_| (RelayFailure::Transport, "could not connect to the engine"))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(ENGINE_MESSAGE_MAX_BYTES))
        .max_frame_size(Some(ENGINE_MESSAGE_MAX_BYTES));
    let (socket, _) = tungstenite::client_tls_with_config(request, tcp, Some(config), None)
        .map_err(|error| match error {
            tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response)) => {
                match response.status().as_u16() {
                    // No realtime route: the engine is too old or not vLLM.
                    404 | 405 => (
                        RelayFailure::UnsupportedCapability,
                        "the engine has no realtime endpoint",
                    ),
                    400..=499 => (
                        RelayFailure::Upstream4xx,
                        "the engine refused the connection",
                    ),
                    _ => (
                        RelayFailure::Upstream5xx,
                        "the engine failed the connection",
                    ),
                }
            }
            _ => (
                RelayFailure::Transport,
                "the engine WebSocket handshake failed",
            ),
        })?;
    handle
        .set_read_timeout(Some(READ_POLL))
        .map_err(|_| (RelayFailure::Transport, "could not connect to the engine"))?;
    Ok((socket, handle))
}

/// The handshake request for the endpoint's `/v1/realtime`, `ws` or `wss`
/// after its `http` or `https` base URL, with the configured headers.
fn realtime_request(endpoint: &EngineEndpoint) -> Result<tungstenite::handshake::client::Request> {
    let mut url = crate::daemon::endpoint_url(&endpoint.base_url, "/v1/realtime")?;
    let scheme = match url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        _ => return Err(anyhow!("the engine URL is not http or https")),
    };
    url.set_scheme(scheme)
        .map_err(|()| anyhow!("the engine URL has no WebSocket form"))?;
    let mut request = url
        .as_str()
        .into_client_request()
        .context("building the engine request")?;
    for (name, value) in endpoint.credential_headers()? {
        request.headers_mut().insert(
            HeaderName::from_bytes(name.as_bytes()).context("an endpoint header name")?,
            HeaderValue::from_str(&value).context("an endpoint header value")?,
        );
    }
    Ok(request)
}
