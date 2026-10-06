use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    input: String,
    expected: String,
}

fn case(name: &str) -> Case {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/masking/stream-cases.json"
    ))
    .expect("fixture");
    cases.into_iter().find(|row| row.name == name).expect("row")
}

/// The command's status as `exec.poll` answers it (the whole masked tail).
fn polled(execs: &ExecRegistry, command_id: &str) -> ExecStatus {
    match execs.status(command_id, NODE_COMMAND_TAIL_MAX_BYTES).pop() {
        Some(OutboundFrame::Control(NodeFrame::ExecStatus(status))) => status,
        _ => panic!("expected an exec.status frame"),
    }
}

fn tail(execs: &ExecRegistry, command_id: &str) -> String {
    polled(execs, command_id).tail.unwrap_or_default()
}

/// Feed worker output until the command has ended.
fn run_to_end(execs: &mut ExecRegistry, rx: &mpsc::Receiver<FromWorker>) -> Vec<OutboundFrame> {
    let mut frames = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !execs.sessions.is_empty() {
        assert!(Instant::now() < deadline, "command did not complete");
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(FromWorker::ExecBytes {
                command_id,
                stderr,
                bytes,
            }) => execs.on_bytes(&command_id, stderr, &bytes),
            Ok(FromWorker::ExecEof { command_id, stderr }) => {
                execs.on_eof(&command_id, stderr);
            }
            _ => {}
        }
        frames.extend(execs.poll(Instant::now()));
    }
    frames
}

#[test]
fn exec_has_independent_stream_state_and_flushes_before_the_end_without_eof() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let started = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-exec",
        slow_command(),
        None,
        TEST_TIMEOUT_MS,
    );
    assert!(matches!(
        controls(&started)[0],
        NodeFrame::ExecStarted { .. }
    ));
    let pem = case("missing-pem-end");
    let eof = case("eof");
    for byte in pem.input.as_bytes() {
        execs.on_bytes("mask-exec", false, &[*byte]);
    }
    execs.on_bytes("mask-exec", true, b"stderr-public\n");
    for byte in eof.input.as_bytes() {
        execs.on_bytes("mask-exec", true, &[*byte]);
    }
    let frames = execs.cancel("mask-exec");
    let [OutboundFrame::Control(NodeFrame::ExecStatus(ended))] = frames.as_slice() else {
        panic!("one exec.status ends the command");
    };
    assert_eq!(ended.state, ExecState::Cancelled);
    assert!(execs.sessions.is_empty());
    // Each stream was masked on its own (stdout held its unfinished PEM
    // until the end) and flushed at the end.
    let output = tail(&execs, "mask-exec");
    assert!(output.contains("stderr-public\n"), "{output}");
    assert_eq!(
        output.replacen("stderr-public\n", "", 1),
        format!("{}{}", pem.expected, eof.expected)
    );
    execs.on_bytes("mask-exec", false, b"late\n");
    assert!(!tail(&execs, "mask-exec").contains("late"));
    drop(execs);
    drop(rx);
}

#[test]
fn exec_flushes_each_eof_immediately_while_the_child_is_running() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let _ = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-eof",
        slow_command(),
        None,
        TEST_TIMEOUT_MS,
    );
    let eof = case("eof");
    execs.on_bytes("mask-eof", false, eof.input.as_bytes());
    execs.on_eof("mask-eof", false);
    assert_eq!(tail(&execs, "mask-eof"), eof.expected);
    assert_eq!(polled(&execs, "mask-eof").state, ExecState::Running);
    execs.on_eof("mask-eof", false);
    assert_eq!(tail(&execs, "mask-eof"), eof.expected, "flushed once");
    assert_eq!(
        execs.sessions.len(),
        1,
        "pipe EOF is not process completion"
    );
    let frames = execs.cancel("mask-eof");
    assert_eq!(frames.len(), 1);
    assert_eq!(
        tail(&execs, "mask-eof"),
        eof.expected,
        "not doubled at the end"
    );
    drop(execs);
    drop(rx);
}

#[test]
fn exec_recovers_after_a_long_line_without_hiding_later_results() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let _ = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-long",
        slow_command(),
        None,
        TEST_TIMEOUT_MS,
    );
    let input = format!(
        "{}\r\nnext\n  continuation\nordinary output\n\nresult: 42\n",
        "z".repeat(crate::output_mask::MAX_HELD_BYTES + 1)
    );
    for chunk in input.as_bytes().chunks(997) {
        execs.on_bytes("mask-long", false, chunk);
    }
    execs.on_bytes("mask-long", true, b"stderr-visible\n");
    let _ = execs.cancel("mask-long");
    let output = tail(&execs, "mask-long");
    assert!(
        output.starts_with(
            "⟦redacted line⟧\r\n⟦redacted line⟧\n⟦redacted⟧\n⟦redacted⟧\n\nresult: 42\n"
        ),
        "{output}"
    );
    assert!(output.ends_with("stderr-visible\n"), "{output}");
    assert!(execs.sessions.is_empty());
    drop(execs);
    drop(rx);
}

#[test]
fn real_exec_pipe_output_uses_the_masker_on_both_streams() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let command = include_str!("../../../tests/fixtures/masking/stream-exec-colored.sh");
    let _ = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-real",
        command,
        None,
        TEST_TIMEOUT_MS,
    );
    let frames = run_to_end(&mut execs, &rx);
    assert!(frames.iter().any(|frame| matches!(
        frame,
        OutboundFrame::Control(NodeFrame::ExecStatus(status))
            if matches!(status.state, ExecState::Succeeded | ExecState::Failed)
    )));
    let output = tail(&execs, "mask-real");
    // The streams interleave in the ring; each is masked on its own.
    assert_eq!(output.matches("⟦redacted line⟧").count(), 2, "{output}");
    assert!(!output.contains("session-value"), "{output}");
    assert!(output.contains("stderr-visible\n"), "{output}");
    assert!(output.contains("serve --api-key ⟦redacted:22⟧"), "{output}");
}

#[test]
fn exec_command_text_naming_the_hf_token_file_selects_the_hf_class() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    // The command only NAMES the token file (in a comment); nothing reads it.
    let _ = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-hf",
        "printf 'plainword\\n'; printf 'other\\n' >&2 # ~/.cache/huggingface/token",
        None,
        TEST_TIMEOUT_MS,
    );
    run_to_end(&mut execs, &rx);
    let output = tail(&execs, "mask-hf");
    assert!(output.contains("⟦redacted:9⟧\n"), "{output}");
    assert!(output.contains("⟦redacted:5⟧\n"), "{output}");
    assert!(!output.contains("plainword") && !output.contains("other"));
}

#[test]
fn an_unknown_command_polls_as_unknown_and_tails_fit_one_frame() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let unknown = polled(&execs, "never-started");
    assert_eq!(unknown.state, ExecState::Unknown);
    assert!(NodeFrame::ExecStatus(unknown).validate().is_ok());
    let _ = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "big",
        slow_command(),
        None,
        TEST_TIMEOUT_MS,
    );
    // Quotes escape to two bytes each: the tail shrinks to fit one frame.
    execs.on_bytes("big", false, &b"\"\"\"\n".repeat(60_000));
    let status = polled(&execs, "big");
    assert_eq!(status.truncated, Some(true));
    let frame = NodeFrame::ExecStatus(status);
    assert!(crate::protocol::encode_control(&frame).is_ok());
    let _ = execs.cancel("big");
    drop(execs);
    drop(rx);
}
