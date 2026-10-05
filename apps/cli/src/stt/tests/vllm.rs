//! The `vllm` adapter against a fake vLLM realtime engine on loopback. The
//! fake follows `vllm/entrypoints/speech_to_text/realtime/connection.py`:
//! silent `session.update`, `unknown_event` errors, one generation per
//! start commit, deltas while audio arrives, `done` after the final commit
//! and a cleared queue afterwards (audio sent before `done` is lost).

use std::net::TcpListener;

use base64::Engine as _;
use tungstenite::Message;
use tungstenite::handshake::server::{Request, Response};

use super::*;
use crate::config::{EndpointAuthConfig, EndpointAuthMode};

/// How the fake engine behaves.
#[derive(Clone)]
struct Script {
    model: String,
    /// The delta sent for each append inside a generation.
    delta: String,
    /// On this append, counted over all connections (1-based):
    /// `error{processing_error}` and the generation dies without `done`.
    fail_on_append: Option<usize>,
    /// On this append, counted over all connections: the engine drops the
    /// socket.
    drop_on_append: Option<usize>,
    /// The engine ends a generation itself after this many appends.
    end_after_appends: Option<usize>,
    /// Between the final commit and `done`.
    done_delay: Duration,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            model: MODEL.into(),
            delta: "w ".into(),
            fail_on_append: None,
            drop_on_append: None,
            end_after_appends: None,
            done_delay: Duration::ZERO,
        }
    }
}

#[derive(Default)]
struct VllmSeen {
    connections: usize,
    /// Appends received, over all connections.
    appends: usize,
    authorization: Vec<Option<String>>,
    /// Event types received, over all connections.
    events: Vec<String>,
    /// Samples per generation that reached `done`.
    generations: Vec<usize>,
    /// Samples appended between a final commit and `done` (vLLM drops them).
    lost: usize,
    /// Connections the client closed.
    hung_up: usize,
}

struct FakeVllm {
    base_url: String,
    seen: Arc<Mutex<VllmSeen>>,
}

impl FakeVllm {
    fn start(script: Script) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base_url = format!("http://{}", listener.local_addr().expect("addr"));
        let seen = Arc::new(Mutex::new(VllmSeen::default()));
        let state = Arc::clone(&seen);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let state = Arc::clone(&state);
                let script = script.clone();
                thread::spawn(move || serve_realtime(stream, &script, &state));
            }
        });
        Self { base_url, seen }
    }

    fn seen<T>(&self, read: impl FnOnce(&VllmSeen) -> T) -> T {
        read(&self.seen.lock().expect("seen"))
    }

    fn wait(&self, done: impl Fn(&VllmSeen) -> bool) -> bool {
        let until = Instant::now() + WAIT;
        while Instant::now() < until {
            if self.seen(&done) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

fn serve_realtime(stream: TcpStream, script: &Script, seen: &Mutex<VllmSeen>) {
    let authorization = Arc::new(Mutex::new(None));
    let capture = Arc::clone(&authorization);
    // The `Err` type is tungstenite's `Callback` contract, not ours.
    #[allow(clippy::result_large_err)]
    let callback = move |request: &Request, response: Response| {
        assert_eq!(request.uri().path(), "/v1/realtime");
        *capture.lock().expect("auth") = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        Ok(response)
    };
    let Ok(mut socket) = tungstenite::accept_hdr(stream, callback) else {
        return;
    };
    {
        let mut seen = seen.lock().expect("seen");
        seen.connections += 1;
        let authorization = authorization.lock().expect("auth").clone();
        seen.authorization.push(authorization);
    }
    let send = |socket: &mut tungstenite::WebSocket<TcpStream>, value: serde_json::Value| {
        socket.send(Message::Text(value.to_string().into())).is_ok()
    };
    if !send(
        &mut socket,
        serde_json::json!({"type": "session.created", "id": "sess-1", "created": 1}),
    ) {
        return;
    }
    let mut validated = false;
    // Samples queued before the generation starts belong to it.
    let mut queued = 0usize;
    // (samples, appends, text) of the running generation.
    let mut generation: Option<(usize, usize, String)> = None;
    let done = |socket: &mut tungstenite::WebSocket<TcpStream>,
                generation: (usize, usize, String)| {
        seen.lock().expect("seen").generations.push(generation.0);
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "transcription.done",
                    "text": generation.2,
                    "usage": {
                        "prompt_tokens": generation.0 / 160,
                        "completion_tokens": generation.1,
                        "total_tokens": generation.0 / 160 + generation.1,
                    },
                })
                .to_string()
                .into(),
            ))
            .is_ok()
    };
    loop {
        let text = match socket.read() {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) | Err(_) => {
                seen.lock().expect("seen").hung_up += 1;
                return;
            }
            Ok(_) => continue,
        };
        let event: serde_json::Value = serde_json::from_str(text.as_str()).expect("json");
        let kind = event["type"].as_str().unwrap_or("").to_string();
        seen.lock().expect("seen").events.push(kind.clone());
        match kind.as_str() {
            "session.update" => {
                if event["model"] == script.model.as_str() {
                    validated = true;
                } else if !send(
                    &mut socket,
                    serde_json::json!({"type": "error", "error": "no such model", "code": "model_not_found"}),
                ) {
                    return;
                }
            }
            "input_audio_buffer.append" => {
                let audio = base64::engine::general_purpose::STANDARD
                    .decode(event["audio"].as_str().expect("audio"))
                    .expect("base64");
                assert!(!audio.is_empty() && audio.len().is_multiple_of(2));
                assert!(audio.len() <= 3_200, "appends carry at most 100 ms");
                let samples = audio.len() / 2;
                let appends = {
                    let mut seen = seen.lock().expect("seen");
                    seen.appends += 1;
                    seen.appends
                };
                if script.drop_on_append == Some(appends) {
                    return;
                }
                if script.fail_on_append == Some(appends) {
                    generation = None;
                    if !send(
                        &mut socket,
                        serde_json::json!({"type": "error", "error": "boom ERRMARKER", "code": "processing_error"}),
                    ) {
                        return;
                    }
                    continue;
                }
                let Some(running) = generation.as_mut() else {
                    queued += samples;
                    continue;
                };
                running.0 += samples;
                running.1 += 1;
                running.2.push_str(&script.delta);
                if !send(
                    &mut socket,
                    serde_json::json!({"type": "transcription.delta", "delta": script.delta}),
                ) {
                    return;
                }
                if script.end_after_appends == Some(running.1) {
                    let ended = generation.take().expect("running");
                    if !done(&mut socket, ended) {
                        return;
                    }
                    queued = 0;
                }
            }
            "input_audio_buffer.commit" if event["final"] == true => {
                let Some(ended) = generation.take() else {
                    continue;
                };
                // Anything appended before `done` is cleared with the queue.
                let until = Instant::now() + script.done_delay;
                let _ = socket
                    .get_ref()
                    .set_read_timeout(Some(Duration::from_millis(10)));
                while Instant::now() < until {
                    match socket.read() {
                        Ok(Message::Text(text)) => {
                            let event: serde_json::Value =
                                serde_json::from_str(text.as_str()).expect("json");
                            let kind = event["type"].as_str().unwrap_or("").to_string();
                            if kind == "input_audio_buffer.append" {
                                let audio = event["audio"].as_str().unwrap_or("");
                                seen.lock().expect("seen").lost += audio.len() * 3 / 8;
                            }
                            seen.lock().expect("seen").events.push(kind);
                        }
                        Err(tungstenite::Error::Io(error))
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Ok(_) => {}
                        Err(_) => {
                            seen.lock().expect("seen").hung_up += 1;
                            return;
                        }
                    }
                }
                let _ = socket.get_ref().set_read_timeout(None);
                if !done(&mut socket, ended) {
                    return;
                }
                queued = 0;
            }
            "input_audio_buffer.commit" => {
                if !validated {
                    if !send(
                        &mut socket,
                        serde_json::json!({"type": "error", "error": "not validated", "code": "model_not_validated"}),
                    ) {
                        return;
                    }
                } else if generation.is_none() {
                    generation = Some((queued, 0, String::new()));
                    queued = 0;
                }
            }
            other => {
                if !send(
                    &mut socket,
                    serde_json::json!({"type": "error", "error": format!("Unknown event type: {other}"), "code": "unknown_event"}),
                ) {
                    return;
                }
            }
        }
    }
}

fn vllm_profile(
    max_item_seconds: Option<u32>,
    max_sessions: Option<u32>,
) -> Option<RealtimeTranscriptionProfile> {
    Some(RealtimeTranscriptionProfile {
        adapter: RealtimeAdapter::Vllm,
        max_item_seconds,
        max_sessions,
    })
}

/// An environment variable present in this process whose value is a valid
/// header value; it stands in for the endpoint's credential (tests never
/// set variables: the crate forbids `unsafe`).
fn credential_env() -> (String, String) {
    std::env::vars()
        .find(|(name, value)| {
            !name.is_empty()
                && (1..=64).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/._-".contains(&byte))
        })
        .expect("a usable environment variable")
}

fn vllm_endpoint(base_url: &str, max_item_seconds: Option<u32>) -> EndpointConfig {
    let mut endpoint = endpoint("inst-v", base_url, vllm_profile(max_item_seconds, None));
    endpoint.auth = Some(EndpointAuthConfig {
        mode: EndpointAuthMode::Bearer,
        env: credential_env().0,
    });
    endpoint
}

fn open_vllm(session_id: &str) -> SttServerMessage {
    let mut message = open(session_id, "inst-v");
    if let SttServerMessage::Open {
        adapter, config, ..
    } = &mut message
    {
        *adapter = RealtimeAdapter::Vllm;
        *config = SttConfig::default();
    }
    message
}

fn command(registry: &mut SttRegistry, message: SttServerMessage) {
    let refused = registry.handle(message, &[], Instant::now());
    assert!(refused.is_empty(), "{refused:?}");
}

fn commit(item_seq: u32) -> SttServerMessage {
    SttServerMessage::Commit {
        session_id: SESSION.into(),
        item_seq,
    }
}

fn clear(item_seq: u32) -> SttServerMessage {
    SttServerMessage::Clear {
        session_id: SESSION.into(),
        item_seq,
    }
}

/// Opens [`SESSION`] on the fake and waits for `stt.opened`.
fn opened(engine: &FakeVllm, max_item_seconds: Option<u32>) -> (SttRegistry, Receiver<FromWorker>) {
    let (mut registry, rx) = registry();
    let managed = [vllm_endpoint(&engine.base_url, max_item_seconds)];
    assert!(
        registry
            .handle(open_vllm(SESSION), &managed, Instant::now())
            .is_empty()
    );
    let first = pump(&mut registry, &rx, |sent| !sent.is_empty());
    assert!(
        matches!(first[..], [ClientControlMessage::SttOpened { .. }]),
        "{first:?}"
    );
    (registry, rx)
}

fn summary(sent: &[ClientControlMessage]) -> Vec<String> {
    events(sent)
        .into_iter()
        .filter(|event| !matches!(event, SttEvent::Delta { .. }))
        .map(|event| match event {
            SttEvent::Delta { item_seq, text } => format!("delta {item_seq} {text}"),
            SttEvent::Completed { item_seq, text, .. } => format!("completed {item_seq} {text}"),
            SttEvent::Failed { item_seq, code, .. } => format!("failed {item_seq} {code}"),
            SttEvent::AutoCommitted { item_seq } => format!("auto {item_seq}"),
        })
        .collect()
}

fn acked(sent: &[ClientControlMessage]) -> u64 {
    sent.iter()
        .filter_map(|message| match message {
            ClientControlMessage::SttAudioAck { bytes, .. } => Some(u64::from(*bytes)),
            _ => None,
        })
        .sum()
}

fn completed(item: u32) -> impl Fn(&[ClientControlMessage]) -> bool {
    has_event(
        move |event| matches!(event, SttEvent::Completed { item_seq, .. } if *item_seq == item),
    )
}

#[test]
fn vllm_streams_deltas_while_audio_flows_and_completes_items_in_order() {
    let engine = FakeVllm::start(Script {
        done_delay: Duration::from_millis(300),
        ..Script::default()
    });
    let (mut registry, rx) = opened(&engine, None);
    // Handshake: credential forwarded, the model checked, then the probe.
    engine.seen(|seen| {
        assert_eq!(
            seen.authorization,
            [Some(format!("Bearer {}", credential_env().1))]
        );
        assert_eq!(seen.events[..2], ["session.update", PROBE_EVENT_FOR_TESTS]);
    });
    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    // Live: deltas for item 0 arrive before anything is committed.
    sent.extend(pump(
        &mut registry,
        &rx,
        has_event(|event| matches!(event, SttEvent::Delta { item_seq: 0, .. })),
    ));
    assert!(
        events(&sent)
            .iter()
            .all(|event| matches!(event, SttEvent::Delta { item_seq: 0, .. }))
    );
    command(&mut registry, commit(0));
    // The next item's audio comes at once; the engine is still finishing
    // item 0, so the adapter must hold it until `done`.
    sent.extend(stream_audio(&mut registry, &rx, SESSION, 10, speech(1)));
    command(&mut registry, commit(1));
    sent.extend(pump(&mut registry, &rx, completed(1)));
    assert_eq!(
        summary(&sent),
        [
            format!("completed 0 {}", "w ".repeat(10)),
            format!("completed 1 {}", "w ".repeat(10)),
        ]
    );
    let usage = events(&sent)
        .into_iter()
        .find_map(|event| match event {
            SttEvent::Completed {
                item_seq: 0,
                engine_usage,
                ..
            } => engine_usage.clone(),
            _ => None,
        })
        .expect("usage");
    assert_eq!(usage.input_tokens, Some(100));
    assert_eq!(usage.output_tokens, Some(10));
    // 1 s at 24 kHz became exactly 1 s at 16 kHz per item; nothing was lost.
    assert_eq!(acked(&sent), 2 * 48_000);
    // A fresh connection, with its own readiness check, per item (the one
    // after item 1 opens right after its `completed`).
    assert!(engine.wait(|seen| {
        seen.events
            .iter()
            .filter(|event| *event == PROBE_EVENT_FOR_TESTS)
            .count()
            == 3
    }));
    engine.seen(|seen| {
        assert_eq!(seen.generations, [16_000, 16_000]);
        assert_eq!(seen.lost, 0);
        assert_eq!(seen.connections, 3);
        for kind in ["session.update", PROBE_EVENT_FOR_TESTS] {
            assert_eq!(seen.events.iter().filter(|event| *event == kind).count(), 3);
        }
    });
    assert!(registry.is_live(SESSION));
    registry.abort_all();
    assert!(
        engine.wait(|seen| seen.hung_up == 3),
        "the engine sees every connection closed"
    );
}

/// The probe event name, as the fake sees it.
const PROBE_EVENT_FOR_TESTS: &str = "wsmp.ready_probe";

#[test]
fn vllm_open_fails_for_a_wrong_model_or_an_engine_without_realtime() {
    let engine = FakeVllm::start(Script {
        model: "someone/else".into(),
        ..Script::default()
    });
    let (mut registry, rx) = registry();
    let managed = [vllm_endpoint(&engine.base_url, None)];
    assert!(
        registry
            .handle(open_vllm(SESSION), &managed, Instant::now())
            .is_empty()
    );
    let sent = pump(&mut registry, &rx, |sent| !sent.is_empty());
    assert!(is_error(&sent[0], RelayFailure::NotFound), "{sent:?}");
    assert!(!registry.is_live(SESSION));

    // A plain HTTP server (no `/v1/realtime`): 404 on the upgrade.
    let http = FakeEngine::start(vec![Reply {
        status: 404,
        body: "{}".into(),
        delay: Duration::ZERO,
    }]);
    let managed = [vllm_endpoint(&http.base_url, None)];
    let other = session_id(7);
    assert!(
        registry
            .handle(open_vllm(&other), &managed, Instant::now())
            .is_empty()
    );
    let sent = pump(&mut registry, &rx, |sent| !sent.is_empty());
    assert!(
        is_error(&sent[0], RelayFailure::UnsupportedCapability),
        "{sent:?}"
    );

    // Nothing listening at all.
    let closed = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base_url = format!("http://{}", closed.local_addr().expect("addr"));
    drop(closed);
    let managed = [vllm_endpoint(&base_url, None)];
    let third = session_id(8);
    assert!(
        registry
            .handle(open_vllm(&third), &managed, Instant::now())
            .is_empty()
    );
    let sent = pump(&mut registry, &rx, |sent| !sent.is_empty());
    assert!(is_error(&sent[0], RelayFailure::Transport), "{sent:?}");
    assert!(registry.is_empty());
}

#[test]
fn vllm_refuses_a_language_or_prompt_and_honours_max_sessions() {
    let (mut registry, rx) = registry();
    let mut capped = endpoint("inst-v", "http://127.0.0.1:9", vllm_profile(None, Some(1)));
    capped.auth = None;
    let managed = [capped];
    // vLLM's realtime protocol has no language.
    let mut with_language = open_vllm(&session_id(1));
    if let SttServerMessage::Open { config, .. } = &mut with_language {
        config.language = Some("es".into());
    }
    let refused = registry.handle(with_language, &managed, Instant::now());
    assert!(is_error(&refused[0], RelayFailure::UnsupportedCapability));
    // maxSessions 1: the second open on the endpoint is refused at once.
    let first = open_vllm(&session_id(2));
    assert!(registry.handle(first, &managed, Instant::now()).is_empty());
    let second = registry.handle(open_vllm(&session_id(3)), &managed, Instant::now());
    assert!(
        is_error(&second[0], RelayFailure::RateLimited),
        "{second:?}"
    );
    // The first one cannot reach its (absent) engine and reports it.
    let sent = pump(&mut registry, &rx, |sent| !sent.is_empty());
    assert!(is_error(&sent[0], RelayFailure::Transport), "{sent:?}");
    assert!(registry.is_empty());
}

#[test]
fn vllm_engine_error_fails_only_the_item_and_the_session_reconnects() {
    // The 3rd append of the first connection fails the generation.
    let engine = FakeVllm::start(Script {
        fail_on_append: Some(3),
        ..Script::default()
    });
    let (mut registry, rx) = opened(&engine, None);
    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    sent.extend(pump(
        &mut registry,
        &rx,
        has_event(|event| matches!(event, SttEvent::Failed { .. })),
    ));
    // The client's commit for the failed item arrives late: ignored.
    command(&mut registry, commit(0));
    // The rest of the audio (if the engine failed mid-frame) and the next
    // turn go to item 1 on a fresh engine connection.
    sent.extend(stream_audio(&mut registry, &rx, SESSION, 10, speech(1)));
    command(&mut registry, commit(1));
    sent.extend(pump(&mut registry, &rx, completed(1)));
    let summary = summary(&sent);
    assert_eq!(summary[..2], ["auto 0", "failed 0 engine_error"]);
    assert!(
        summary
            .last()
            .is_some_and(|last| last.starts_with("completed 1 ")),
        "{summary:?}"
    );
    assert!(registry.is_live(SESSION));
    assert_eq!(acked(&sent), 2 * 48_000);
    // The first connection, the one after the failure, the one after item 1.
    assert!(engine.wait(|seen| seen.connections == 3));
    registry.abort_all();
}

#[test]
fn vllm_engine_socket_loss_ends_the_session() {
    let engine = FakeVllm::start(Script {
        drop_on_append: Some(2),
        ..Script::default()
    });
    let (mut registry, rx) = opened(&engine, None);
    for (seq, frame) in speech(1).into_iter().enumerate() {
        if !registry.is_live(SESSION) {
            break;
        }
        let _ = registry.audio(SESSION, seq as u64, frame);
    }
    let sent = pump(&mut registry, &rx, |sent| {
        sent.iter()
            .any(|message| matches!(message, ClientControlMessage::SttError { .. }))
    });
    assert!(
        sent.iter()
            .any(|message| is_error(message, RelayFailure::Transport)),
        "{sent:?}"
    );
    assert!(!registry.is_live(SESSION));
}

#[test]
fn vllm_clear_before_and_after_the_item_starts() {
    let engine = FakeVllm::start(Script {
        done_delay: Duration::from_millis(100),
        ..Script::default()
    });
    let (mut registry, rx) = opened(&engine, None);
    // Before any audio: nothing reaches the engine; item 0 is used up.
    command(&mut registry, clear(0));
    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    // Started: vLLM has no clear, so the item is finished and dropped.
    command(&mut registry, clear(1));
    sent.extend(stream_audio(&mut registry, &rx, SESSION, 10, speech(1)));
    command(&mut registry, commit(2));
    sent.extend(pump(&mut registry, &rx, completed(2)));
    assert_eq!(summary(&sent), [format!("completed 2 {}", "w ".repeat(10))]);
    // Deltas of the cleared item may have gone out live; none after the clear
    // carry a later number than the item they belong to.
    assert!(events(&sent).iter().all(|event| match event {
        SttEvent::Delta { item_seq, .. } => *item_seq == 1 || *item_seq == 2,
        _ => true,
    }));
    engine.seen(|seen| {
        assert_eq!(seen.generations, [16_000, 16_000]);
        assert_eq!(seen.lost, 0);
    });
    registry.abort_all();
}

#[test]
fn vllm_valve_ends_a_long_item_and_the_rest_goes_to_the_next() {
    let engine = FakeVllm::start(Script {
        done_delay: Duration::from_millis(200),
        ..Script::default()
    });
    // The recipe declares 5 s; the server asked for 30 s.
    let (mut registry, rx) = opened(&engine, Some(5));
    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(6));
    command(&mut registry, commit(1));
    sent.extend(pump(&mut registry, &rx, completed(1)));
    let summary = summary(&sent);
    assert_eq!(summary[0], "auto 0");
    assert!(summary[1].starts_with("completed 0 "), "{summary:?}");
    assert!(summary[2].starts_with("completed 1 "), "{summary:?}");
    engine.seen(|seen| {
        assert_eq!(seen.generations, [5 * 16_000, 16_000]);
        assert_eq!(seen.lost, 0);
    });
    // The client's commit for item 0, after the valve: ignored.
    command(&mut registry, commit(0));
    assert!(registry.is_live(SESSION));
    registry.abort_all();
}

#[test]
fn vllm_engine_that_ends_an_item_itself_commits_it_for_the_client() {
    let engine = FakeVllm::start(Script {
        end_after_appends: Some(4),
        ..Script::default()
    });
    let (mut registry, rx) = opened(&engine, None);
    // 0.4 s: 4 appends of 100 ms, then the engine ends the generation.
    let frames = speech(1);
    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, frames[..4].to_vec());
    sent.extend(pump(&mut registry, &rx, completed(0)));
    sent.extend(stream_audio(
        &mut registry,
        &rx,
        SESSION,
        4,
        frames[4..6].to_vec(),
    ));
    command(&mut registry, commit(1));
    sent.extend(pump(&mut registry, &rx, completed(1)));
    assert_eq!(
        summary(&sent),
        [
            "auto 0".to_string(),
            format!("completed 0 {}", "w ".repeat(4)),
            format!("completed 1 {}", "w ".repeat(2)),
        ]
    );
    registry.abort_all();
}

#[test]
fn vllm_close_hangs_up_on_the_engine_mid_item() {
    let engine = FakeVllm::start(Script::default());
    let (mut registry, rx) = opened(&engine, None);
    stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    let closed = registry.handle(
        SttServerMessage::Close {
            session_id: SESSION.into(),
            reason: RelayFailure::Cancelled,
        },
        &[],
        Instant::now(),
    );
    assert!(matches!(
        closed[..],
        [ClientControlMessage::SttClosed { .. }]
    ));
    let started = Instant::now();
    assert!(engine.wait(|seen| seen.hung_up == 1));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn vllm_transcripts_stay_within_the_wire_contract() {
    // 20 KiB per delta: split into 16 KiB pieces, and the item fails once
    // its text passes 48 KiB.
    let engine = FakeVllm::start(Script {
        delta: "x".repeat(20 * 1024),
        ..Script::default()
    });
    let (mut registry, rx) = opened(&engine, None);
    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    sent.extend(pump(
        &mut registry,
        &rx,
        has_event(|event| matches!(event, SttEvent::Failed { .. })),
    ));
    for event in events(&sent) {
        if let SttEvent::Delta { text, .. } = event {
            assert!(text.len() <= crate::stt_wire::STT_DELTA_TEXT_MAX_BYTES);
        }
        let frame = ClientControlMessage::SttEvent {
            session_id: SESSION.into(),
            event: event.clone(),
        };
        assert!(crate::protocol::encode_control(&frame).is_ok());
    }
    assert_eq!(
        summary(&sent)[..2],
        ["auto 0", "failed 0 transcript_too_large"]
    );
    registry.abort_all();
}

#[test]
fn a_refused_or_failed_stop_lets_the_endpoint_take_sessions_again() {
    let (mut registry, _rx) = registry();
    let now = Instant::now();
    let managed = vec![endpoint(
        "inst-a",
        "http://127.0.0.1:9",
        segmented(None, None),
    )];
    registry.endpoint_stopping("inst-a", "step-stop");
    let refused = registry.handle(open(&session_id(1), "inst-a"), &managed, now);
    assert!(is_error(&refused[0], RelayFailure::NotFound));
    // Another step's failure changes nothing.
    registry.stop_failed("step-other");
    let refused = registry.handle(open(&session_id(2), "inst-a"), &managed, now);
    assert!(is_error(&refused[0], RelayFailure::NotFound));
    registry.stop_failed("step-stop");
    assert!(
        registry
            .handle(open(&session_id(3), "inst-a"), &managed, now)
            .is_empty()
    );
    registry.abort_all();
}

/// Review regression (chunk 4): with the real logging setup at `trace`
/// (`wsmp -vv`), a session logs no transcript, no engine error text and no
/// engine credential. The `log` bridge is process-wide, so the session runs
/// in a child test process whose stderr is checked here.
#[test]
fn a_trace_level_session_logs_no_transcript_or_credential() {
    const CHILD: &str = "WSMP_TEST_STT_TRACE_CHILD";
    if std::env::var_os(CHILD).is_some() {
        crate::logging::init(crate::cli::LogFormat::Text, 2, false);
        tracing::trace!("trace logging is on");
        let engine = FakeVllm::start(Script {
            delta: "TRANSCRIPTMARKER ".into(),
            fail_on_append: Some(12),
            ..Script::default()
        });
        let (mut registry, rx) = opened(&engine, None);
        let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
        command(&mut registry, commit(0));
        sent.extend(pump(&mut registry, &rx, completed(0)));
        // Item 1 fails at the engine (its error text carries a marker).
        sent.extend(stream_audio(&mut registry, &rx, SESSION, 10, speech(1)));
        sent.extend(pump(
            &mut registry,
            &rx,
            has_event(|event| matches!(event, SttEvent::Failed { .. })),
        ));
        assert!(
            events(&sent)
                .iter()
                .any(|event| matches!(event, SttEvent::Delta { text, .. } if text.contains("TRANSCRIPTMARKER")))
        );
        registry.abort_all();
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("test exe"))
        .args([
            "--exact",
            "stt::tests::vllm::a_trace_level_session_logs_no_transcript_or_credential",
            "--test-threads=1",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env_remove("WSMP_LOG")
        .env_remove("RUST_LOG")
        .env("NO_COLOR", "1")
        .output()
        .expect("child");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(stderr.contains("trace logging is on"), "{stderr}");
    assert!(stderr.contains("speech-to-text engine session ready"));
    for marker in ["TRANSCRIPTMARKER", "ERRMARKER", "Bearer", "authorization"] {
        assert!(!stderr.contains(marker), "{marker} in the logs:\n{stderr}");
    }
}
