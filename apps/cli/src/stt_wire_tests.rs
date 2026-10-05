use super::*;
use crate::protocol::{
    FrameFault, ServerControlMessage, control_frame_fault, encode_control, parse_binary_frame,
    parse_server_control,
};

const SESSION: &str = "AAECAwQFBgcICQoLDA0ODw";

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/relay-current")
        .join(name)
}

fn read_fixture(name: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fixture(name)).expect("fixture"))
        .expect("fixture JSON")
}

fn session() -> String {
    SESSION.to_string()
}

/// Every CLI to server `stt.*` frame shape the server must accept.
fn accepted_client_frames() -> Vec<(&'static str, ClientControlMessage)> {
    vec![
        (
            "opened",
            ClientControlMessage::SttOpened {
                session_id: session(),
            },
        ),
        (
            "ack",
            ClientControlMessage::SttAudioAck {
                session_id: session(),
                bytes: 32 * 1024,
            },
        ),
        (
            "ackWholeWindow",
            ClientControlMessage::SttAudioAck {
                session_id: session(),
                bytes: STT_AUDIO_WINDOW_MAX_BYTES,
            },
        ),
        (
            "delta",
            ClientControlMessage::SttEvent {
                session_id: session(),
                event: SttEvent::Delta {
                    item_seq: 0,
                    text: "Hola, ¿qué tal?\n\"bien\"".into(),
                },
            },
        ),
        (
            "deltaAtLimit",
            ClientControlMessage::SttEvent {
                session_id: session(),
                event: SttEvent::Delta {
                    item_seq: 1,
                    text: "é".repeat(STT_DELTA_TEXT_MAX_BYTES / 2),
                },
            },
        ),
        (
            "completed",
            ClientControlMessage::SttEvent {
                session_id: session(),
                event: SttEvent::Completed {
                    item_seq: 2,
                    text: "Hello world.".into(),
                    engine_usage: Some(SttEngineUsage {
                        input_tokens: Some(125),
                        output_tokens: Some(4),
                    }),
                },
            },
        ),
        (
            "completedEmptyWithoutUsage",
            ClientControlMessage::SttEvent {
                session_id: session(),
                event: SttEvent::Completed {
                    item_seq: u32::MAX,
                    text: String::new(),
                    engine_usage: None,
                },
            },
        ),
        (
            "completedAtLimit",
            ClientControlMessage::SttEvent {
                session_id: session(),
                event: SttEvent::Completed {
                    item_seq: 3,
                    text: "a".repeat(STT_COMPLETED_TEXT_MAX_BYTES),
                    engine_usage: Some(SttEngineUsage {
                        input_tokens: Some(STT_TOKEN_COUNT_MAX),
                        output_tokens: None,
                    }),
                },
            },
        ),
        (
            "failed",
            ClientControlMessage::SttEvent {
                session_id: session(),
                event: SttEvent::Failed {
                    item_seq: 4,
                    code: "upstream_4xx".into(),
                    message: "the engine refused the audio".into(),
                },
            },
        ),
        (
            "autoCommitted",
            ClientControlMessage::SttEvent {
                session_id: session(),
                event: SttEvent::AutoCommitted { item_seq: 5 },
            },
        ),
        (
            "error",
            ClientControlMessage::SttError {
                session_id: session(),
                failure: RelayFailure::UnsupportedCapability,
                message: Some("live transcription is not available on this node".into()),
            },
        ),
        (
            "errorWithoutMessage",
            ClientControlMessage::SttError {
                session_id: session(),
                failure: RelayFailure::Transport,
                message: None,
            },
        ),
        (
            "closed",
            ClientControlMessage::SttClosed {
                session_id: session(),
            },
        ),
    ]
}

/// Frames the CLI refuses to encode; the server must refuse them too.
fn rejected_client_frames() -> Vec<(&'static str, ClientControlMessage)> {
    let event = |event| ClientControlMessage::SttEvent {
        session_id: session(),
        event,
    };
    vec![
        (
            "nonCanonicalSession",
            ClientControlMessage::SttOpened {
                session_id: "AAECAwQFBgcICQoLDA0ODx".into(),
            },
        ),
        (
            "ackZero",
            ClientControlMessage::SttAudioAck {
                session_id: session(),
                bytes: 0,
            },
        ),
        (
            "ackOverWindow",
            ClientControlMessage::SttAudioAck {
                session_id: session(),
                bytes: STT_AUDIO_WINDOW_MAX_BYTES + 1,
            },
        ),
        (
            "deltaOverLimit",
            event(SttEvent::Delta {
                item_seq: 0,
                text: "a".repeat(STT_DELTA_TEXT_MAX_BYTES + 1),
            }),
        ),
        (
            "completedOverLimit",
            event(SttEvent::Completed {
                item_seq: 0,
                text: "é".repeat(STT_COMPLETED_TEXT_MAX_BYTES / 2) + "a",
                engine_usage: None,
            }),
        ),
        (
            "usageOverLimit",
            event(SttEvent::Completed {
                item_seq: 0,
                text: String::new(),
                engine_usage: Some(SttEngineUsage {
                    input_tokens: None,
                    output_tokens: Some(STT_TOKEN_COUNT_MAX + 1),
                }),
            }),
        ),
        (
            "failedCodeNotToken",
            event(SttEvent::Failed {
                item_seq: 0,
                code: "Upstream-4xx".into(),
                message: String::new(),
            }),
        ),
        (
            "failedMessageOverLimit",
            event(SttEvent::Failed {
                item_seq: 0,
                code: "processing_error".into(),
                message: "a".repeat(STT_MESSAGE_MAX_BYTES + 1),
            }),
        ),
        (
            "errorMessageOverLimit",
            ClientControlMessage::SttError {
                session_id: session(),
                failure: RelayFailure::Unknown,
                message: Some("é".repeat(STT_MESSAGE_MAX_BYTES / 2 + 1)),
            },
        ),
    ]
}

#[test]
fn current_stt_events_match_shared_golden() {
    let mut frames = serde_json::Map::new();
    for (name, message) in accepted_client_frames() {
        let wire = encode_control(&message).unwrap_or_else(|error| panic!("{name}: {error}"));
        frames.insert(name.to_string(), wire.into());
    }
    let mut rejected = serde_json::Map::new();
    for (name, message) in rejected_client_frames() {
        assert!(encode_control(&message).is_err(), "{name} must be refused");
        let wire = serde_json::to_string(&message).expect("raw frame");
        rejected.insert(name.to_string(), wire.into());
    }
    // Shapes serde cannot even produce; the server must refuse them as well.
    for (name, wire) in [
        (
            "openedUnknownKey",
            format!(r#"{{"type":"stt.opened","sessionId":"{SESSION}","extra":1}}"#),
        ),
        (
            "eventUnknownKind",
            format!(
                r#"{{"type":"stt.event","sessionId":"{SESSION}","event":{{"kind":"partial","itemSeq":0}}}}"#
            ),
        ),
        (
            "eventItemSeqTooLarge",
            format!(
                r#"{{"type":"stt.event","sessionId":"{SESSION}","event":{{"kind":"auto_committed","itemSeq":4294967296}}}}"#
            ),
        ),
        (
            "errorUnknownFailure",
            format!(r#"{{"type":"stt.error","sessionId":"{SESSION}","failure":"engine_gone"}}"#),
        ),
        (
            "unknownType",
            format!(r#"{{"type":"stt.partial","sessionId":"{SESSION}"}}"#),
        ),
    ] {
        rejected.insert(name.to_string(), wire.into());
    }
    let actual = serde_json::json!({
        "protocolVersion": crate::protocol::RELAY_PROTOCOL_VERSION,
        "frames": frames,
        "rejected": rejected,
    });
    // The server parses these (apps/server/src/relay/stt-protocol.test.ts).
    let path = fixture("stt-events.json");
    if std::env::var_os("WSMP_UPDATE_GOLDEN").is_some() {
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&actual).expect("json") + "\n",
        )
        .expect("write golden");
    }
    assert_eq!(read_fixture("stt-events.json"), actual);
}

#[test]
fn current_stt_frames_match_shared_golden() {
    let golden = read_fixture("stt-frames.json");
    assert_eq!(
        golden["protocolVersion"],
        crate::protocol::RELAY_PROTOCOL_VERSION
    );
    let frames = golden["frames"].as_object().expect("frames");
    assert!(!frames.is_empty());
    for (name, wire) in frames {
        let wire = wire.as_str().expect("wire text");
        let ServerControlMessage::Stt(message) =
            parse_server_control(wire).unwrap_or_else(|error| panic!("{name}: {error:#}"))
        else {
            panic!("{name} is not an stt frame");
        };
        // Decoding and re-encoding is byte for byte, so nothing is lost.
        assert_eq!(
            serde_json::to_string(&message).expect("encode"),
            wire,
            "{name}"
        );
    }
    for (name, wire) in golden["rejected"].as_object().expect("rejected") {
        let wire = wire.as_str().expect("wire text");
        assert!(
            parse_server_control(wire).is_err(),
            "{name} must be refused"
        );
    }
    let audio_frame = |case: &serde_json::Value| {
        let metadata = case["metadata"].as_str().expect("metadata").as_bytes();
        let body = case["bodyBytes"].as_u64().expect("bodyBytes") as usize;
        let mut frame = (metadata.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(metadata);
        frame.resize(frame.len() + body, 0);
        frame
    };
    for (name, case) in golden["audio"]["accepted"].as_object().expect("audio") {
        let (metadata, body) = parse_binary_frame(&audio_frame(case))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(
            matches!(
                metadata,
                crate::protocol::RelayBinaryFrameMetadata::SttAudio { .. }
            ),
            "{name}"
        );
        assert_eq!(body.len() as u64, case["bodyBytes"], "{name}");
    }
    for (name, case) in golden["audio"]["rejected"].as_object().expect("audio") {
        assert!(
            parse_binary_frame(&audio_frame(case)).is_err(),
            "{name} must be refused"
        );
    }
}

#[test]
fn a_malformed_stt_frame_names_its_session_and_is_never_fatal() {
    let open = format!(r#"{{"type":"stt.open","sessionId":"{SESSION}","adapter":"openai"}}"#);
    assert!(parse_server_control(&open).is_err());
    assert_eq!(
        control_frame_fault(&open),
        FrameFault::RejectStt {
            session_id: session()
        }
    );
    // A session id the CLI would not echo is dropped instead.
    let unnamed = r#"{"type":"stt.open","sessionId":"x","adapter":"vllm"}"#;
    assert_eq!(control_frame_fault(unnamed), FrameFault::Ignore);
    // Any other malformed frame names its session: a live one fails, an
    // unknown one is ignored (`SttRegistry::malformed`).
    let named = FrameFault::FailStt {
        session_id: session(),
    };
    let commit = format!(r#"{{"type":"stt.commit","sessionId":"{SESSION}","itemSeq":-1}}"#);
    assert_eq!(control_frame_fault(&commit), named);
    let unknown = format!(r#"{{"type":"stt.pause","sessionId":"{SESSION}"}}"#);
    assert!(parse_server_control(&unknown).is_err());
    assert_eq!(control_frame_fault(&unknown), named);
    let config =
        format!(r#"{{"type":"stt.update","sessionId":"{SESSION}","config":{{"language":null}}}}"#);
    assert!(parse_server_control(&config).is_err());
    assert_eq!(control_frame_fault(&config), named);
    let no_session = r#"{"type":"stt.commit","itemSeq":1}"#;
    assert_eq!(control_frame_fault(no_session), FrameFault::Ignore);

    // A malformed audio frame names its session too, never fatal.
    let metadata = format!(r#"{{"type":"stt.audio","sessionId":"{SESSION}","seq":0}}"#);
    let mut odd = (metadata.len() as u32).to_be_bytes().to_vec();
    odd.extend_from_slice(metadata.as_bytes());
    odd.push(0);
    assert_eq!(crate::protocol::binary_frame_fault(&odd).err(), Some(named));
}

#[test]
fn session_ids_are_canonical_16_byte_base64url() {
    assert!(is_session_id(SESSION));
    for bad in [
        "",
        "AAECAwQFBgcICQoLDA0ODx",
        "AAECAwQFBgcICQoLDA0OD",
        "AAECAwQFBgcICQoLDA0ODw=",
        "AAECAwQFBgcICQoLDA0OD+",
    ] {
        assert!(!is_session_id(bad), "{bad}");
    }
}
