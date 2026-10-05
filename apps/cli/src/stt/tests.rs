use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use super::*;
use crate::config::{ModelConfig, OpenAiCompatibleCapabilities};

mod vllm;
use crate::deployments::{RealtimeTranscriptionProfile, TranscriptionProfile};

const SESSION: &str = "AAECAwQFBgcICQoLDA0ODw";
const MODEL: &str = "fixture/whisper";
const WAIT: Duration = Duration::from_secs(10);

/// What the fake engine answers one request with.
#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    delay: Duration,
}

impl Reply {
    fn text(text: &str) -> Self {
        Self {
            status: 200,
            body: serde_json::json!({ "text": text }).to_string(),
            delay: Duration::ZERO,
        }
    }
}

#[derive(Default)]
struct Seen {
    requests: Vec<(String, Vec<u8>)>,
    /// The client hung up while a reply was still delayed.
    hung_up: bool,
}

/// A local file-transcription engine: answers each request in turn with the
/// scripted replies (the last one repeats). No network beyond loopback.
struct FakeEngine {
    base_url: String,
    seen: Arc<Mutex<Seen>>,
}

impl FakeEngine {
    fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base_url = format!("http://{}", listener.local_addr().expect("addr"));
        let seen = Arc::new(Mutex::new(Seen::default()));
        let state = Arc::clone(&seen);
        thread::spawn(move || {
            for (index, stream) in listener.incoming().enumerate() {
                let Ok(stream) = stream else { return };
                let reply = replies
                    .get(index)
                    .or(replies.last())
                    .cloned()
                    .expect("a reply");
                let state = Arc::clone(&state);
                thread::spawn(move || serve(stream, &reply, &state));
            }
        });
        Self { base_url, seen }
    }

    fn requests(&self) -> Vec<(String, Vec<u8>)> {
        self.seen.lock().expect("seen").requests.clone()
    }

    fn hung_up(&self) -> bool {
        self.seen.lock().expect("seen").hung_up
    }
}

fn serve(mut stream: TcpStream, reply: &Reply, seen: &Mutex<Seen>) {
    let mut data = Vec::new();
    let mut buffer = [0u8; 8192];
    let header_end = loop {
        let Ok(read) = stream.read(&mut buffer) else {
            return;
        };
        if read == 0 {
            return;
        }
        data.extend_from_slice(&buffer[..read]);
        if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&data[..header_end]).to_string();
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while data.len() < header_end + length {
        let Ok(read) = stream.read(&mut buffer) else {
            return;
        };
        if read == 0 {
            return;
        }
        data.extend_from_slice(&buffer[..read]);
    }
    seen.lock()
        .expect("seen")
        .requests
        .push((head, data[header_end..header_end + length].to_vec()));
    if !reply.delay.is_zero() {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
        let until = Instant::now() + reply.delay;
        while Instant::now() < until {
            match stream.read(&mut buffer) {
                Ok(0) => {
                    seen.lock().expect("seen").hung_up = true;
                    return;
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => {
                    seen.lock().expect("seen").hung_up = true;
                    return;
                }
            }
        }
    }
    let response = format!(
        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        reply.status,
        reply.body.len(),
        reply.body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn endpoint(
    slug: &str,
    base_url: &str,
    realtime: Option<RealtimeTranscriptionProfile>,
) -> EndpointConfig {
    let profile = TranscriptionProfile {
        realtime,
        ..Default::default()
    };
    EndpointConfig {
        slug: slug.to_string(),
        label: slug.to_string(),
        base_url: base_url.to_string(),
        enabled: true,
        default_capabilities: OpenAiCompatibleCapabilities::transcription(Some(&profile)),
        models: vec![ModelConfig {
            upstream_model_id: MODEL.to_string(),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn segmented(
    max_item_seconds: Option<u32>,
    max_sessions: Option<u32>,
) -> Option<RealtimeTranscriptionProfile> {
    Some(RealtimeTranscriptionProfile {
        adapter: RealtimeAdapter::Segmented,
        max_item_seconds,
        max_sessions,
    })
}

fn open(session_id: &str, slug: &str) -> SttServerMessage {
    SttServerMessage::Open {
        session_id: session_id.to_string(),
        endpoint_slug: slug.to_string(),
        upstream_model: MODEL.to_string(),
        adapter: RealtimeAdapter::Segmented,
        config: SttConfig {
            language: Some("es".into()),
            prompt: None,
        },
        max_item_seconds: 30,
        max_session_ms: 60_000,
        audio_window_bytes: 256 * 1024,
    }
}

fn session_id(n: u8) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([n; 16])
}

fn registry() -> (SttRegistry, Receiver<FromWorker>) {
    let (tx, rx) = mpsc::sync_channel(64);
    (SttRegistry::new(tx), rx)
}

/// The frames the relay loop would send, until `done` holds or the wait ends.
fn pump(
    registry: &mut SttRegistry,
    rx: &Receiver<FromWorker>,
    done: impl Fn(&[ClientControlMessage]) -> bool,
) -> Vec<ClientControlMessage> {
    let mut sent = Vec::new();
    let until = Instant::now() + WAIT;
    while !done(&sent) && Instant::now() < until {
        if let Ok(FromWorker::Stt {
            session_id,
            message,
        }) = rx.recv_timeout(Duration::from_millis(20))
            && let Some(message) = registry.outbound(&session_id, message)
        {
            sent.push(message);
        }
    }
    sent
}

fn events(sent: &[ClientControlMessage]) -> Vec<&SttEvent> {
    sent.iter()
        .filter_map(|message| match message {
            ClientControlMessage::SttEvent { event, .. } => Some(event),
            _ => None,
        })
        .collect()
}

fn has_event(predicate: impl Fn(&SttEvent) -> bool) -> impl Fn(&[ClientControlMessage]) -> bool {
    move |sent| events(sent).into_iter().any(&predicate)
}

fn is_error(message: &ClientControlMessage, expected: RelayFailure) -> bool {
    matches!(message, ClientControlMessage::SttError { failure, .. } if *failure == expected)
}

/// `seconds` of a 24 kHz sine as s16le frames of 100 ms (4 800 bytes).
fn speech(seconds: usize) -> Vec<Vec<u8>> {
    let samples: Vec<u8> = (0..seconds * 24_000)
        .flat_map(|n| {
            let value =
                (8_000.0 * (2.0 * std::f64::consts::PI * 440.0 * n as f64 / 24_000.0).sin()) as i16;
            value.to_le_bytes()
        })
        .collect();
    samples.chunks(4_800).map(<[u8]>::to_vec).collect()
}

/// Sends audio within the credit window, returning credit as acks arrive.
fn stream_audio(
    registry: &mut SttRegistry,
    rx: &Receiver<FromWorker>,
    id: &str,
    first_seq: u64,
    frames: Vec<Vec<u8>>,
) -> Vec<ClientControlMessage> {
    let mut sent = Vec::new();
    for (offset, frame) in frames.into_iter().enumerate() {
        // Like the server: send only within the credit returned so far.
        let until = Instant::now() + WAIT;
        while registry
            .credit(id)
            .is_some_and(|credit| credit < frame.len() as u64)
            && Instant::now() < until
        {
            if let Ok(FromWorker::Stt {
                session_id,
                message,
            }) = rx.recv_timeout(Duration::from_millis(20))
                && let Some(message) = registry.outbound(&session_id, message)
            {
                sent.push(message);
            }
        }
        let refused = registry.audio(id, first_seq + offset as u64, frame);
        assert!(refused.is_empty(), "{refused:?}");
    }
    sent
}

#[test]
fn opens_only_on_a_recipe_endpoint_that_advertises_the_requested_adapter() {
    let (mut registry, _rx) = registry();
    let now = Instant::now();
    let refused = |registry: &mut SttRegistry, message, managed: &[EndpointConfig], failure| {
        let frames = registry.handle(message, managed, now);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert!(is_error(&frames[0], failure), "{frames:?}");
        assert!(registry.is_empty());
    };
    // A hand-configured endpoint is not in the managed list, whatever it advertises.
    refused(
        &mut registry,
        open(&session_id(1), "inst-a"),
        &[],
        RelayFailure::NotFound,
    );
    let plain = endpoint("inst-a", "http://127.0.0.1:9", None);
    refused(
        &mut registry,
        open(&session_id(2), "inst-a"),
        std::slice::from_ref(&plain),
        RelayFailure::UnsupportedCapability,
    );
    let mut disabled = endpoint("inst-a", "http://127.0.0.1:9", segmented(None, None));
    disabled.enabled = false;
    refused(
        &mut registry,
        open(&session_id(3), "inst-a"),
        &[disabled],
        RelayFailure::NotFound,
    );
    let vllm = endpoint(
        "inst-a",
        "http://127.0.0.1:9",
        Some(RealtimeTranscriptionProfile {
            adapter: RealtimeAdapter::Vllm,
            max_item_seconds: None,
            max_sessions: None,
        }),
    );
    // Adapter mismatch, and a vllm open with a language (vLLM has none).
    refused(
        &mut registry,
        open(&session_id(4), "inst-a"),
        std::slice::from_ref(&vllm),
        RelayFailure::UnsupportedCapability,
    );
    let mut vllm_open = open(&session_id(5), "inst-a");
    if let SttServerMessage::Open { adapter, .. } = &mut vllm_open {
        *adapter = RealtimeAdapter::Vllm;
    }
    refused(
        &mut registry,
        vllm_open,
        &[vllm],
        RelayFailure::UnsupportedCapability,
    );
    let good = endpoint("inst-a", "http://127.0.0.1:9", segmented(None, None));
    let mut other_model = open(&session_id(6), "inst-a");
    if let SttServerMessage::Open { upstream_model, .. } = &mut other_model {
        *upstream_model = "other/model".into();
    }
    refused(&mut registry, other_model, &[good], RelayFailure::NotFound);
}

#[test]
fn caps_sessions_per_endpoint_and_per_process_and_refuses_reused_ids() {
    let (mut registry, _rx) = registry();
    let now = Instant::now();
    let capped = endpoint("inst-a", "http://127.0.0.1:9", segmented(None, Some(2)));
    let wide = endpoint("inst-b", "http://127.0.0.1:9", segmented(None, None));
    let managed = [capped, wide];
    for n in 0..2 {
        assert!(
            registry
                .handle(open(&session_id(n), "inst-a"), &managed, now)
                .is_empty()
        );
    }
    let third = registry.handle(open(&session_id(2), "inst-a"), &managed, now);
    assert!(is_error(&third[0], RelayFailure::RateLimited));
    for n in 10..16 {
        assert!(
            registry
                .handle(open(&session_id(n), "inst-b"), &managed, now)
                .is_empty()
        );
    }
    assert_eq!(registry.len(), STT_SESSIONS_MAX);
    let ninth = registry.handle(open(&session_id(20), "inst-b"), &managed, now);
    assert!(is_error(&ninth[0], RelayFailure::RateLimited));
    // A live id reused: the session and the request both fail, once.
    let reused = registry.handle(open(&session_id(0), "inst-b"), &managed, now);
    assert_eq!(reused.len(), 1);
    assert!(is_error(&reused[0], RelayFailure::ProtocolError));
    assert!(!registry.is_live(&session_id(0)));
    // An ended id is never reopened.
    let again = registry.handle(open(&session_id(0), "inst-b"), &managed, now);
    assert!(is_error(&again[0], RelayFailure::ProtocolError));
    registry.abort_all();
    assert!(registry.is_empty());
}

#[test]
fn transcribes_committed_turns_through_the_file_endpoint_in_order() {
    let engine = FakeEngine::start(vec![
        Reply {
            delay: Duration::from_millis(300),
            ..Reply::text("primera frase")
        },
        Reply {
            status: 400,
            body: r#"{"error":"bad audio"}"#.into(),
            delay: Duration::ZERO,
        },
        Reply::text("tercera"),
    ]);
    let (mut registry, rx) = registry();
    let managed = [endpoint("inst-a", &engine.base_url, segmented(None, None))];
    assert!(
        registry
            .handle(open(SESSION, "inst-a"), &managed, Instant::now())
            .is_empty()
    );
    let opened = pump(&mut registry, &rx, |sent| !sent.is_empty());
    assert!(matches!(opened[0], ClientControlMessage::SttOpened { .. }));

    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    let commit = |registry: &mut SttRegistry, seq| {
        let frames = registry.handle(
            SttServerMessage::Commit {
                session_id: SESSION.into(),
                item_seq: seq,
            },
            &[],
            Instant::now(),
        );
        assert!(frames.is_empty());
    };
    commit(&mut registry, 0);
    sent.extend(stream_audio(&mut registry, &rx, SESSION, 10, speech(1)));
    commit(&mut registry, 1);
    // A config change applies from the next turn.
    registry.handle(
        SttServerMessage::Update {
            session_id: SESSION.into(),
            config: SttConfig {
                language: Some("en".into()),
                prompt: Some("Glosario: WSMP".into()),
            },
        },
        &[],
        Instant::now(),
    );
    sent.extend(stream_audio(&mut registry, &rx, SESSION, 20, speech(1)));
    commit(&mut registry, 2);
    // A commit racing the valve for an ended item is no error.
    commit(&mut registry, 1);
    sent.extend(pump(
        &mut registry,
        &rx,
        has_event(|event| matches!(event, SttEvent::Completed { item_seq: 2, .. })),
    ));

    // Every received byte was acknowledged, never more.
    let acked: u64 = sent
        .iter()
        .filter_map(|message| match message {
            ClientControlMessage::SttAudioAck { bytes, .. } => Some(u64::from(*bytes)),
            _ => None,
        })
        .sum();
    assert_eq!(acked, 3 * 48_000);
    // Results in commit order; the 4xx fails only its item.
    let summary: Vec<String> = events(&sent)
        .into_iter()
        .map(|event| match event {
            SttEvent::Delta { item_seq, text } => format!("delta {item_seq} {text}"),
            SttEvent::Completed { item_seq, text, .. } => format!("completed {item_seq} {text}"),
            SttEvent::Failed { item_seq, code, .. } => format!("failed {item_seq} {code}"),
            SttEvent::AutoCommitted { item_seq } => format!("auto {item_seq}"),
        })
        .collect();
    assert_eq!(
        summary,
        [
            "delta 0 primera frase",
            "completed 0 primera frase",
            "failed 1 upstream_4xx",
            "delta 2 tercera",
            "completed 2 tercera",
        ]
    );
    assert!(registry.is_live(SESSION));
    // The engine got a 16 kHz mono WAV of the turn plus the form fields.
    let requests = engine.requests();
    assert_eq!(requests.len(), 3);
    let (head, body) = &requests[0];
    assert!(head.starts_with("POST /v1/audio/transcriptions "), "{head}");
    let body_text = String::from_utf8_lossy(body);
    for field in [
        "name=\"model\"\r\n\r\nfixture/whisper",
        "name=\"response_format\"\r\n\r\njson",
        "name=\"language\"\r\n\r\nes",
    ] {
        assert!(body_text.contains(field), "{field}");
    }
    assert!(!body_text.contains("name=\"prompt\""));
    let wav_at = body.windows(4).position(|w| w == b"RIFF").expect("wav");
    let wav = &body[wav_at..];
    assert_eq!(&wav[8..16], b"WAVEfmt ");
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
    let data_len = u32::from_le_bytes(wav[40..44].try_into().unwrap());
    assert_eq!(data_len, 32_000, "1 s at 16 kHz s16");
    // The update reached the third turn only.
    let third = String::from_utf8_lossy(&requests[2].1).to_string();
    assert!(third.contains("name=\"language\"\r\n\r\nen") && third.contains("Glosario: WSMP"));
    registry.abort_all();
}

#[test]
fn the_valve_ends_a_long_turn_at_max_item_seconds() {
    let engine = FakeEngine::start(vec![Reply::text("cinco segundos")]);
    let (mut registry, rx) = registry();
    let managed = [endpoint(
        "inst-a",
        &engine.base_url,
        segmented(Some(5), None),
    )];
    // The server asks for 30 s; the recipe declared 5 s, which wins.
    assert!(
        registry
            .handle(open(SESSION, "inst-a"), &managed, Instant::now())
            .is_empty()
    );
    let mut sent = stream_audio(&mut registry, &rx, SESSION, 0, speech(6));
    sent.extend(pump(
        &mut registry,
        &rx,
        has_event(|event| matches!(event, SttEvent::Completed { item_seq: 0, .. })),
    ));
    let summary: Vec<_> = events(&sent)
        .into_iter()
        .filter(|event| !matches!(event, SttEvent::Delta { .. }))
        .collect();
    assert!(matches!(
        summary[0],
        SttEvent::AutoCommitted { item_seq: 0 }
    ));
    assert!(matches!(
        summary[1],
        SttEvent::Completed { item_seq: 0, .. }
    ));
    let (_, body) = &engine.requests()[0];
    let wav_at = body.windows(4).position(|w| w == b"RIFF").expect("wav");
    let data_len = u32::from_le_bytes(body[wav_at + 40..wav_at + 44].try_into().unwrap());
    assert_eq!(data_len, 5 * 32_000);
    // The client's late commit for the same item changes nothing; the rest
    // of the audio is item 1.
    assert!(
        registry
            .handle(
                SttServerMessage::Commit {
                    session_id: SESSION.into(),
                    item_seq: 0,
                },
                &[],
                Instant::now(),
            )
            .is_empty()
    );
    registry.abort_all();
}

#[test]
fn a_bad_sequence_or_credit_or_commit_fails_only_that_session() {
    let (mut registry, rx) = registry();
    let managed = [endpoint(
        "inst-a",
        "http://127.0.0.1:9",
        segmented(None, None),
    )];
    let now = Instant::now();
    let a = session_id(1);
    let b = session_id(2);
    let c = session_id(3);
    for id in [&a, &b, &c] {
        assert!(
            registry
                .handle(open(id, "inst-a"), &managed, now)
                .is_empty()
        );
    }
    // Out of sequence (a gap): the session fails; late audio is then dropped.
    assert!(registry.audio(&a, 0, vec![0; 4_800]).is_empty());
    let gap = registry.audio(&a, 2, vec![0; 4_800]);
    assert!(is_error(&gap[0], RelayFailure::ProtocolError));
    assert!(registry.audio(&a, 3, vec![0; 4_800]).is_empty());
    // More than the granted window before any acknowledgement.
    let mut over = Vec::new();
    for seq in 0..9 {
        over = registry.audio(&b, seq, vec![0; 32 * 1024]);
        if !over.is_empty() {
            break;
        }
    }
    assert!(is_error(&over[0], RelayFailure::ProtocolError));
    // A commit for an item that has not started.
    registry.handle(
        SttServerMessage::Commit {
            session_id: c.clone(),
            item_seq: 5,
        },
        &[],
        now,
    );
    let sent = pump(&mut registry, &rx, |sent| {
        sent.iter()
            .any(|message| is_error(message, RelayFailure::ProtocolError))
    });
    assert!(sent.iter().any(|message| matches!(
        message,
        ClientControlMessage::SttError { session_id, .. } if *session_id == c
    )));
    assert!(registry.is_empty());
    // A malformed frame for a live session fails it; for an unknown one, nothing.
    let d = session_id(4);
    assert!(
        registry
            .handle(open(&d, "inst-a"), &managed, now)
            .is_empty()
    );
    assert!(is_error(
        &registry.malformed(&d, false)[0],
        RelayFailure::ProtocolError
    ));
    assert!(registry.malformed(&d, false).is_empty());
    assert!(registry.malformed(&session_id(9), false).is_empty());
}

#[test]
fn close_and_abort_end_sessions_and_cancel_the_engine_request() {
    let engine = FakeEngine::start(vec![Reply {
        delay: Duration::from_secs(20),
        ..Reply::text("never")
    }]);
    let (mut registry, rx) = registry();
    let managed = [endpoint("inst-a", &engine.base_url, segmented(None, None))];
    assert!(
        registry
            .handle(open(SESSION, "inst-a"), &managed, Instant::now())
            .is_empty()
    );
    stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    registry.handle(
        SttServerMessage::Commit {
            session_id: SESSION.into(),
            item_seq: 0,
        },
        &[],
        Instant::now(),
    );
    let until = Instant::now() + WAIT;
    while engine.requests().is_empty() && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(engine.requests().len(), 1);
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
    // The engine sees its connection close well before its reply was due.
    let until = Instant::now() + Duration::from_secs(5);
    while !engine.hung_up() && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(engine.hung_up());
    // Frames of the closed session are dropped; a second close says nothing.
    assert!(
        registry
            .outbound(
                SESSION,
                ClientControlMessage::SttOpened {
                    session_id: SESSION.into(),
                },
            )
            .is_none()
    );
    assert!(
        registry
            .handle(
                SttServerMessage::Close {
                    session_id: SESSION.into(),
                    reason: RelayFailure::Cancelled,
                },
                &[],
                Instant::now(),
            )
            .is_empty()
    );
}

#[test]
fn poll_ends_sessions_past_their_deadline_or_whose_deployment_stopped() {
    let (mut registry, _rx) = registry();
    let now = Instant::now();
    let managed = vec![
        endpoint("inst-a", "http://127.0.0.1:9", segmented(None, None)),
        endpoint("inst-b", "http://127.0.0.1:9", segmented(None, None)),
    ];
    assert!(
        registry
            .handle(open(&session_id(1), "inst-a"), &managed, now)
            .is_empty()
    );
    assert!(
        registry
            .handle(open(&session_id(2), "inst-b"), &managed, now)
            .is_empty()
    );
    assert!(registry.poll(now, || managed.clone()).is_empty());
    // The endpoint list is read at most once a second.
    assert!(
        registry
            .poll(now, || panic!("read again within a second"))
            .is_empty()
    );
    // inst-b's deployment stopped.
    let stopped = registry.poll(now + Duration::from_secs(2), || managed[..1].to_vec());
    assert!(matches!(
        &stopped[..],
        [ClientControlMessage::SttError { failure: RelayFailure::NotFound, message: Some(message), .. }]
            if message == "model_unavailable"
    ));
    // 60 s + grace later the other one has outlived maxSessionMs.
    let late = registry.poll(now + Duration::from_secs(66), || managed.clone());
    assert!(is_error(&late[0], RelayFailure::Timeout));
    assert!(registry.is_empty());
    // Nothing live: the endpoint list is never read.
    assert!(
        registry
            .poll(now, || panic!("read with no live session"))
            .is_empty()
    );
}

#[test]
fn escape_heavy_transcripts_fail_only_their_item_and_deltas_fit_a_frame() {
    let text = |text: String| segmented::Outcome::Text { text, usage: None };
    let encodes = |event: SttEvent| {
        crate::protocol::encode_control(&ClientControlMessage::SttEvent {
            session_id: SESSION.into(),
            event,
        })
        .is_ok()
    };
    // Each control character escapes to 6 bytes: 11 000 of them are 66 000
    // bytes once escaped, over the 64 KiB frame, though only 11 KB raw.
    let controls = "\u{1}".repeat(11_000);
    assert_eq!(segmented::json_escaped_len(&controls), 66_002);
    let events = segmented::events(7, text(controls));
    assert!(matches!(
        &events[..],
        [SttEvent::Failed { code, .. }] if code == "transcript_too_large"
    ));
    assert!(events.into_iter().all(encodes));
    // Quotes and newlines (2 bytes each) just under 48 KiB raw: also too big.
    let quotes = "\"\n".repeat(20_000);
    assert!(!segmented::transcript_fits(&quotes));
    // A transcript that fits is delivered whole, and every delta piece
    // (16 KiB of control characters would be 96 KiB escaped) fits a frame.
    let fits = format!("{}{}", "\u{2}".repeat(9_000), "ok \"quoted\" é");
    assert!(segmented::transcript_fits(&fits));
    let events = segmented::events(8, text(fits.clone()));
    let deltas: String = events
        .iter()
        .filter_map(|event| match event {
            SttEvent::Delta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, fits);
    assert!(events.into_iter().all(encodes));
    let control_run = "\u{3}".repeat(16_384);
    let pieces = segmented::split_delta_text(&control_run);
    assert!(pieces.len() > 1);
    assert!(pieces.iter().all(|piece| {
        piece.len() <= crate::stt_wire::STT_DELTA_TEXT_MAX_BYTES
            && segmented::json_escaped_len(piece) <= segmented::STT_EVENT_TEXT_ESCAPED_MAX_BYTES
    }));
    assert_eq!(pieces.concat(), control_run);
    // The escape table agrees with serde_json.
    for sample in ["a\"b\\c\n\r\t\u{8}\u{c}\u{1f}é😀", ""] {
        assert_eq!(
            segmented::json_escaped_len(sample),
            serde_json::to_string(sample)
                .map(|json| json.len())
                .unwrap_or(0)
        );
    }
}

#[test]
fn turn_events_stay_within_the_wire_contract() {
    let long = "é".repeat(20_000);
    let text = |text: String| segmented::Outcome::Text { text, usage: None };
    let events = segmented::events(3, text(long.clone()));
    let deltas: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            SttEvent::Delta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas.len(), 3);
    assert_eq!(deltas.concat(), long);
    let too_long = segmented::events(4, text("a".repeat(49_153)));
    assert!(matches!(
        &too_long[..],
        [SttEvent::Failed { code, .. }] if code == "transcript_too_large"
    ));
    let failed = segmented::events(
        5,
        segmented::Outcome::Failed {
            code: "transport",
            message: "é".repeat(600),
        },
    );
    for event in events.into_iter().chain(too_long).chain(failed) {
        let frame = ClientControlMessage::SttEvent {
            session_id: SESSION.into(),
            event,
        };
        assert!(crate::protocol::encode_control(&frame).is_ok());
    }
    // An empty turn is reported, not posted.
    let mut cancel = watch::channel(false).1;
    let empty = segmented::transcribe(
        &EngineEndpoint {
            base_url: "http://127.0.0.1:9".into(),
            headers: Vec::new(),
            auth: None,
            model: MODEL.into(),
        },
        segmented::Item {
            item_seq: 0,
            samples: Vec::new(),
            config: SttConfig::default(),
        },
        &mut cancel,
    );
    assert!(matches!(
        empty,
        Some(segmented::Outcome::Failed {
            code: "empty_item",
            ..
        })
    ));
}

/// Review regression (chunk 3): a burst of small frames within the granted
/// credit, with the engine stuck, must stall on credit and never fail; a
/// commit sent meanwhile must not fail either.
#[test]
fn a_burst_of_small_frames_within_credit_stalls_instead_of_failing() {
    let engine = FakeEngine::start(vec![Reply {
        delay: Duration::from_secs(30),
        ..Reply::text("slow")
    }]);
    let (mut registry, rx) = registry();
    let managed = [endpoint(
        "inst-a",
        &engine.base_url,
        segmented(Some(5), None),
    )];
    assert!(
        registry
            .handle(open(SESSION, "inst-a"), &managed, Instant::now())
            .is_empty()
    );
    // 20 ms frames (960 bytes at 24 kHz s16), sent as fast as credit allows.
    let audio: Vec<u8> = speech(40).concat();
    let mut sent_frames = 0u64;
    let mut committed = false;
    let deadline = Instant::now() + Duration::from_secs(3);
    'frames: for frame in audio.chunks(960) {
        loop {
            while let Ok(FromWorker::Stt {
                session_id,
                message,
            }) = rx.try_recv()
            {
                let message = registry.outbound(&session_id, message);
                assert!(
                    !matches!(message, Some(ClientControlMessage::SttError { .. })),
                    "{message:?}"
                );
            }
            if registry
                .credit(SESSION)
                .is_some_and(|credit| credit >= frame.len() as u64)
            {
                break;
            }
            if Instant::now() > deadline {
                break 'frames;
            }
            // Credit ran out: the engine is stuck. A commit now is legal. Item 0
            // is open or was just ended by the 5 s valve; either way this is no
            // error (a commit for an ended item is ignored).
            if !committed {
                committed = true;
                let refused = registry.handle(
                    SttServerMessage::Commit {
                        session_id: SESSION.into(),
                        item_seq: 0,
                    },
                    &[],
                    Instant::now(),
                );
                assert!(refused.is_empty(), "{refused:?}");
            }
            thread::sleep(Duration::from_millis(5));
        }
        let refused = registry.audio(SESSION, sent_frames, frame.to_vec());
        assert!(refused.is_empty(), "frame {sent_frames}: {refused:?}");
        sent_frames += 1;
    }
    assert!(
        registry.is_live(SESSION),
        "the session stalls, it does not fail"
    );
    // At least one whole default window (273 frames of 960 bytes) went in.
    assert!(sent_frames > 273, "{sent_frames} frames");
    registry.abort_all();
}

#[test]
fn queued_audio_frames_are_bounded_in_count_too() {
    let engine = FakeEngine::start(vec![Reply {
        delay: Duration::from_secs(30),
        ..Reply::text("slow")
    }]);
    let (mut registry, rx) = registry();
    let managed = [endpoint("inst-a", &engine.base_url, segmented(None, None))];
    assert!(
        registry
            .handle(open(SESSION, "inst-a"), &managed, Instant::now())
            .is_empty()
    );
    let first = speech(1);
    let mut seq = first.len() as u64;
    stream_audio(&mut registry, &rx, SESSION, 0, first);
    // Block the session thread behind the stuck engine (as in the command test).
    for item_seq in 0..3 {
        assert!(
            registry
                .handle(
                    SttServerMessage::Commit {
                        session_id: SESSION.into(),
                        item_seq,
                    },
                    &[],
                    Instant::now(),
                )
                .is_empty()
        );
    }
    thread::sleep(Duration::from_millis(300));
    // 2-byte frames fit the credit window many times over; the count cap ends it.
    let mut refused = Vec::new();
    for _ in 0..=AUDIO_FRAMES_QUEUED_MAX {
        refused = registry.audio(SESSION, seq, vec![0, 0]);
        seq += 1;
        if !refused.is_empty() {
            break;
        }
    }
    assert!(
        is_error(&refused[0], RelayFailure::ProtocolError),
        "{refused:?}"
    );
    assert!(!registry.is_live(SESSION));
    registry.abort_all();
}

#[test]
fn session_threads_still_running_count_against_new_opens() {
    let (mut registry, _rx) = registry();
    let now = Instant::now();
    let managed = [endpoint(
        "inst-a",
        "http://127.0.0.1:9",
        segmented(None, None),
    )];
    // As if earlier sessions' threads were still stuck connecting.
    registry.threads.store(STT_THREADS_MAX, Ordering::SeqCst);
    let refused = registry.handle(open(&session_id(1), "inst-a"), &managed, now);
    assert!(
        is_error(&refused[0], RelayFailure::RateLimited),
        "{refused:?}"
    );
    registry.threads.store(0, Ordering::SeqCst);
    assert!(
        registry
            .handle(open(&session_id(2), "inst-a"), &managed, now)
            .is_empty()
    );
    assert_eq!(registry.threads.load(Ordering::SeqCst), 1);
    // The slot is released when the thread itself ends, not when the session does.
    registry.abort_all();
    let until = Instant::now() + WAIT;
    while registry.threads.load(Ordering::SeqCst) > 0 && Instant::now() < until {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(registry.threads.load(Ordering::SeqCst), 0);
}

#[test]
fn queued_commands_are_bounded_per_session() {
    let engine = FakeEngine::start(vec![Reply {
        delay: Duration::from_secs(30),
        ..Reply::text("slow")
    }]);
    let (mut registry, rx) = registry();
    let managed = [endpoint("inst-a", &engine.base_url, segmented(None, None))];
    assert!(
        registry
            .handle(open(SESSION, "inst-a"), &managed, Instant::now())
            .is_empty()
    );
    stream_audio(&mut registry, &rx, SESSION, 0, speech(1));
    let control =
        |registry: &mut SttRegistry, message| registry.handle(message, &[], Instant::now());
    // Turn 0 goes to the stuck engine, turn 1 fills the turn queue, and the
    // empty turn 2 blocks the session thread.
    for item_seq in 0..3 {
        let refused = control(
            &mut registry,
            SttServerMessage::Commit {
                session_id: SESSION.into(),
                item_seq,
            },
        );
        assert!(refused.is_empty());
    }
    thread::sleep(Duration::from_millis(300));
    let mut refused = Vec::new();
    for _ in 0..CONTROL_QUEUE_MAX + 1 {
        refused = control(
            &mut registry,
            SttServerMessage::Update {
                session_id: SESSION.into(),
                config: SttConfig::default(),
            },
        );
        if !refused.is_empty() {
            break;
        }
    }
    assert!(
        is_error(&refused[0], RelayFailure::ProtocolError),
        "{refused:?}"
    );
    assert!(!registry.is_live(SESSION));
}

#[test]
fn a_start_that_arrives_after_its_stop_finished_lifts_the_mark() {
    // The usual order: the server sends the start after the stop's result.
    // A fast start can republish the endpoint before the snapshot ever drops
    // it, so the start itself must lift the mark.
    let (mut registry, _rx) = registry();
    let now = Instant::now();
    let managed = vec![endpoint(
        "inst-a",
        "http://127.0.0.1:9",
        segmented(None, None),
    )];
    registry.endpoint_stopping("inst-a", "step-1");
    registry.stop_finished("step-1");
    let refused = registry.handle(open(&session_id(1), "inst-a"), &managed, now);
    assert!(is_error(&refused[0], RelayFailure::NotFound));
    registry.endpoint_starting("inst-a");
    assert!(
        registry
            .handle(open(&session_id(2), "inst-a"), &managed, now)
            .is_empty()
    );
    // A later stop marks the endpoint afresh.
    registry.endpoint_stopping("inst-a", "step-2");
    let refused = registry.handle(open(&session_id(3), "inst-a"), &managed, now);
    assert!(is_error(&refused[0], RelayFailure::NotFound));
    registry.abort_all();
}

#[test]
fn a_stop_job_ends_the_endpoints_sessions_before_it_runs() {
    let (mut registry, _rx) = registry();
    let now = Instant::now();
    let managed = vec![
        endpoint("inst-a", "http://127.0.0.1:9", segmented(None, None)),
        endpoint("inst-b", "http://127.0.0.1:9", segmented(None, None)),
    ];
    for (n, slug) in [(1, "inst-a"), (2, "inst-a"), (3, "inst-b")] {
        assert!(
            registry
                .handle(open(&session_id(n), slug), &managed, now)
                .is_empty()
        );
    }
    let ended = registry.endpoint_stopping("inst-a", "step-1");
    assert_eq!(ended.len(), 2);
    assert!(ended.iter().all(|frame| matches!(
        frame,
        ClientControlMessage::SttError { failure: RelayFailure::NotFound, message: Some(message), .. }
            if message == "model_unavailable"
    )));
    assert!(registry.is_live(&session_id(3)));
    // Still in the snapshot while the stop runs, but no new session there.
    let refused = registry.handle(open(&session_id(4), "inst-a"), &managed, now);
    assert!(is_error(&refused[0], RelayFailure::NotFound));
    // A start job that arrives while the stop still runs keeps the mark:
    // the engine is about to die.
    registry.endpoint_starting("inst-a");
    let refused = registry.handle(open(&session_id(7), "inst-a"), &managed, now);
    assert!(is_error(&refused[0], RelayFailure::NotFound));
    // Another stop finishing changes nothing; this stop finishing lifts it.
    registry.stop_finished("step-other");
    assert!(
        !registry
            .handle(open(&session_id(8), "inst-a"), &managed, now)
            .is_empty()
    );
    registry.stop_finished("step-1");
    assert!(
        registry
            .handle(open(&session_id(5), "inst-a"), &managed, now)
            .is_empty()
    );
    // A stop that finished with no start waiting keeps the mark until the
    // endpoint leaves the snapshot.
    registry.endpoint_stopping("inst-b", "step-2");
    registry.stop_finished("step-2");
    let refused = registry.handle(open(&session_id(9), "inst-b"), &managed, now);
    assert!(is_error(&refused[0], RelayFailure::NotFound));
    registry.stop_failed("step-2");
    // Or the endpoint leaving the snapshot does.
    registry.endpoint_stopping("inst-a", "step-1");
    let after = registry.poll(now, || managed[1..].to_vec());
    assert!(after.is_empty(), "inst-a has no session left: {after:?}");
    let reopened = vec![managed[0].clone()];
    assert!(
        registry
            .handle(open(&session_id(6), "inst-a"), &reopened, now)
            .is_empty()
    );
    registry.abort_all();
}

#[test]
fn engine_answers_map_to_outcomes_and_keep_usage() {
    let text = |status, body: &str| segmented::outcome(status, body.as_bytes());
    assert_eq!(
        text(
            200,
            r#"{"text":"hola","usage":{"prompt_tokens":120,"completion_tokens":3}}"#
        ),
        segmented::Outcome::Text {
            text: "hola".into(),
            usage: Some(crate::stt_wire::SttEngineUsage {
                input_tokens: Some(120),
                output_tokens: Some(3),
            }),
        }
    );
    assert_eq!(
        text(
            200,
            r#"{"text":"hi","usage":{"type":"duration","seconds":2}}"#
        ),
        segmented::Outcome::Text {
            text: "hi".into(),
            usage: None,
        }
    );
    let code = |outcome| match outcome {
        segmented::Outcome::Failed { code, .. } => code,
        segmented::Outcome::Text { .. } => "text",
    };
    assert_eq!(code(text(101, "")), "upstream_1xx");
    assert_eq!(code(text(302, "")), "upstream_redirect");
    assert_eq!(code(text(404, "")), "upstream_4xx");
    assert_eq!(code(text(503, "")), "upstream_5xx");
    assert_eq!(code(text(200, "not json")), "invalid_response");
    // Usage travels on `completed`.
    let events = segmented::events(
        0,
        segmented::Outcome::Text {
            text: "ok".into(),
            usage: Some(crate::stt_wire::SttEngineUsage {
                input_tokens: Some(1),
                output_tokens: None,
            }),
        },
    );
    assert!(matches!(
        events.last(),
        Some(SttEvent::Completed {
            engine_usage: Some(_),
            ..
        })
    ));
}
