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

fn exec_streams(frames: &[OutboundFrame]) -> (Vec<u8>, Vec<u8>) {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let (mut stdout_seq, mut stderr_seq) = (0, 0);
    for frame in frames {
        match frame {
            OutboundFrame::Binary(RelayBinaryFrameMetadata::ExecStdout { seq, .. }, bytes) => {
                assert_eq!(*seq, stdout_seq + 1);
                stdout_seq = *seq;
                stdout.extend(bytes);
            }
            OutboundFrame::Binary(RelayBinaryFrameMetadata::ExecStderr { seq, .. }, bytes) => {
                assert_eq!(*seq, stderr_seq + 1);
                stderr_seq = *seq;
                stderr.extend(bytes);
            }
            _ => {}
        }
    }
    (stdout, stderr)
}

#[test]
fn exec_has_independent_stream_state_and_flushes_before_done_without_eof() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let started = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-exec",
        slow_command(),
        None,
    );
    assert!(matches!(
        controls(&started)[0],
        ClientControlMessage::ExecStarted { .. }
    ));
    let pem = case("missing-pem-end");
    let eof = case("eof");
    let mut frames = Vec::new();
    for byte in pem.input.as_bytes() {
        frames.extend(execs.on_bytes("mask-exec", false, &[*byte]));
    }
    frames.extend(execs.on_bytes("mask-exec", true, b"stderr-public\n"));
    for byte in eof.input.as_bytes() {
        assert!(execs.on_bytes("mask-exec", true, &[*byte]).is_empty());
    }
    frames.extend(execs.cancel("mask-exec"));
    assert!(matches!(
        frames.last(),
        Some(OutboundFrame::Control(
            ClientControlMessage::ExecDone { .. }
        ))
    ));
    let (out, err) = exec_streams(&frames);
    assert_eq!(out, pem.expected.as_bytes());
    assert_eq!(err, format!("stderr-public\n{}", eof.expected).as_bytes());
    assert!(execs.sessions.is_empty());
    assert!(execs.on_bytes("mask-exec", false, b"late\n").is_empty());
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
    );
    let eof = case("eof");
    for stderr in [false, true] {
        assert!(
            execs
                .on_bytes("mask-eof", stderr, eof.input.as_bytes())
                .is_empty()
        );
        let frames = execs.on_eof("mask-eof", stderr);
        let (out, err) = exec_streams(&frames);
        let (data, other) = if stderr { (err, out) } else { (out, err) };
        assert_eq!(data, eof.expected.as_bytes());
        assert!(other.is_empty());
        assert!(execs.on_eof("mask-eof", stderr).is_empty());
    }
    assert_eq!(
        execs.sessions.len(),
        1,
        "pipe EOF is not process completion"
    );
    assert!(execs.on_bytes("mask-eof", false, b"late\n").is_empty());
    let frames = execs.cancel("mask-eof");
    assert_eq!(frames.len(), 1, "EOF tails must not be sent twice");
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
    );
    let input = format!(
        "{}\r\nnext\n  continuation\nresult: 42\n",
        "z".repeat(crate::output_mask::MAX_HELD_BYTES + 1)
    );
    let mut frames = Vec::new();
    for chunk in input.as_bytes().chunks(997) {
        frames.extend(execs.on_bytes("mask-long", false, chunk));
    }
    frames.extend(execs.on_bytes("mask-long", true, b"stderr-visible\n"));
    frames.extend(execs.cancel("mask-long"));
    let (out, err) = exec_streams(&frames);
    assert_eq!(
        out,
        "⟦redacted line⟧\r\n⟦redacted line⟧\n⟦redacted⟧\nresult: 42\n".as_bytes()
    );
    assert_eq!(err, b"stderr-visible\n");
    assert!(execs.sessions.is_empty());
    drop(execs);
    drop(rx);
}

#[test]
fn real_exec_pipe_output_uses_the_masker_on_both_streams() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let command = include_str!("../../../tests/fixtures/masking/stream-exec.sh");
    let mut frames = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-real",
        command,
        None,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !execs.sessions.is_empty() {
        assert!(Instant::now() < deadline, "command did not complete");
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(FromWorker::ExecBytes {
                command_id,
                stderr,
                bytes,
            }) => {
                frames.extend(execs.on_bytes(&command_id, stderr, &bytes));
            }
            Ok(FromWorker::ExecEof { command_id, stderr }) => {
                frames.extend(execs.on_eof(&command_id, stderr));
            }
            _ => {}
        }
        frames.extend(execs.poll(Instant::now()));
    }
    let (out, err) = exec_streams(&frames);
    assert_eq!(out, "⟦redacted line⟧\n⟦redacted line⟧".as_bytes());
    assert_eq!(
        err,
        "stderr-visible\nserve --api-key ⟦redacted:22⟧".as_bytes()
    );
}

#[test]
fn exec_command_text_naming_the_hf_token_file_selects_the_hf_class() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    // The command only NAMES the token file (in a comment); nothing reads it.
    let mut frames = execs.start(
        &enabled_startup(false),
        &Config::default(),
        "mask-hf",
        "printf 'plainword\\n'; printf 'other\\n' >&2 # ~/.cache/huggingface/token",
        None,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !execs.sessions.is_empty() {
        assert!(Instant::now() < deadline, "command did not complete");
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(FromWorker::ExecBytes {
                command_id,
                stderr,
                bytes,
            }) => frames.extend(execs.on_bytes(&command_id, stderr, &bytes)),
            Ok(FromWorker::ExecEof { command_id, stderr }) => {
                frames.extend(execs.on_eof(&command_id, stderr));
            }
            _ => {}
        }
        frames.extend(execs.poll(Instant::now()));
    }
    let (out, err) = exec_streams(&frames);
    assert_eq!(out, "⟦redacted:9⟧\n".as_bytes());
    assert_eq!(err, "⟦redacted:5⟧\n".as_bytes());
}

fn shared_parts(frames: &[OutboundFrame]) -> (Vec<u8>, Vec<u8>, u64) {
    let (mut head, mut tail, mut total) = (Vec::new(), Vec::new(), None);
    for frame in frames {
        match frame {
            OutboundFrame::Binary(
                RelayBinaryFrameMetadata::SupervisedOutput { part, .. },
                bytes,
            ) => match part {
                SupervisedOutputPart::Head => head.extend(bytes),
                SupervisedOutputPart::Tail => tail.extend(bytes),
            },
            OutboundFrame::Control(ClientControlMessage::SupervisedDone {
                output_bytes, ..
            }) => {
                total = *output_bytes;
            }
            _ => {}
        }
    }
    (head, tail, total.expect("masked output byte count"))
}

fn accept(
    terminals: &mut TerminalRegistry,
    rx: &mpsc::Receiver<FromWorker>,
    frames: &mut Vec<OutboundFrame>,
    viewer: &mut TestViewer,
) {
    pump_until(terminals, rx, frames, |terminals, _| {
        phase(terminals) == Some(SupervisedPhase::Confirm)
    });
    let label = viewer.id.clone();
    frames.extend(send(
        terminals,
        viewer,
        &label,
        &TermPlaintextV2::Data(b"ok\r".to_vec()),
    ));
    pump_until(terminals, rx, frames, |terminals, _| {
        phase(terminals) == Some(SupervisedPhase::Running)
    });
}

#[test]
fn supervised_masks_before_head_tail_cuts_and_counts_masked_bytes() {
    let (tx, rx) = channel();
    let mut terminals = supervised_registry(tx, &fake_confirm_output(None, "sleep 30"));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
    let mut viewer = TestViewer::new(81);
    let _ = attach_viewer(&mut terminals, &startup, &mut viewer);
    accept(&mut terminals, &rx, &mut frames, &mut viewer);

    let head_cap = terminal_crypto::CAPTURE_HEAD_MAX;
    let tail_cap = terminal_crypto::CAPTURE_TAIL_MAX;
    let secret = include_str!("../../../tests/fixtures/masking/stream-boundary.txt");
    let prefix = "x\n".repeat((head_cap - 24) / 2);
    let middle = "m\n".repeat(tail_cap / 2);
    let suffix = "t\n".repeat((tail_cap - 20) / 2);
    // The two raw boundaries both land inside the seeded value. A test that
    // only masks retained head/tail bytes necessarily leaves a visible remnant.
    let input = format!("{prefix}{secret}\n{middle}{secret}\n{suffix}");
    let second_start = prefix.len() + secret.len() + 1 + middle.len();
    let raw_tail_start = input.len() - tail_cap;
    assert!(head_cap > prefix.len() && head_cap < prefix.len() + secret.len());
    assert!(raw_tail_start > second_start && raw_tail_start < second_start + secret.len());
    for chunk in input.as_bytes().chunks(997) {
        frames.extend(terminals.on_bytes(MULTI_TERMINAL, chunk));
    }
    frames.extend(terminals.on_eof(MULTI_TERMINAL));
    frames.extend(terminals.finish_supervised(MULTI_TERMINAL, Instant::now()));
    let (head, tail, total) = shared_parts(&frames);
    let expected = format!("{prefix}⟦redacted line⟧\n\n{middle}⟦redacted line⟧\n\n{suffix}");
    assert_eq!(total, expected.len() as u64);
    assert!(head == expected.as_bytes()[..head_cap], "wrong masked head");
    // Capture advances the retained tail to a complete UTF-8/parser boundary.
    let mut tail_start = expected.len() - tail_cap;
    while !expected.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    assert!(
        tail == expected.as_bytes()[tail_start..],
        "wrong masked tail"
    );
    assert!(head.len() <= head_cap && tail.len() <= tail_cap);
    assert!(terminals.sessions.is_empty());
}

#[test]
fn supervised_capture_recovers_after_a_long_line_and_counts_visible_results() {
    let (tx, rx) = channel();
    let mut terminals = supervised_registry(tx, &fake_confirm_output(None, "sleep 30"));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
    let mut viewer = TestViewer::new(84);
    let _ = attach_viewer(&mut terminals, &startup, &mut viewer);
    accept(&mut terminals, &rx, &mut frames, &mut viewer);
    let input = format!(
        "{}\r\nnext\n  continuation\nresult: 42",
        "z".repeat(crate::output_mask::MAX_HELD_BYTES + 1)
    );
    for chunk in input.as_bytes().chunks(997) {
        frames.extend(terminals.on_bytes(MULTI_TERMINAL, chunk));
    }
    frames.extend(terminals.on_eof(MULTI_TERMINAL));
    frames.extend(terminals.finish_supervised(MULTI_TERMINAL, Instant::now()));
    let (head, tail, total) = shared_parts(&frames);
    assert_eq!(
        head,
        "⟦redacted line⟧\r\n⟦redacted line⟧\n⟦redacted⟧\nresult: 42".as_bytes()
    );
    assert!(tail.is_empty());
    assert_eq!(total, head.len() as u64);
    assert!(terminals.sessions.is_empty());
}

#[test]
fn supervised_viewer_stays_raw_and_shared_partial_line_flushes_at_completion() {
    let (tx, rx) = channel();
    let mut terminals = supervised_registry(tx, &fake_confirm_output(None, "sleep 30"));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &spawn_request(true));
    let mut viewer = TestViewer::new(82);
    let joined = attach_viewer(&mut terminals, &startup, &mut viewer);
    let mut seen = viewer.receive(MULTI_TERMINAL, &joined);
    accept(&mut terminals, &rx, &mut frames, &mut viewer);
    let input = include_str!("../../../tests/fixtures/masking/stream-session.txt");
    for byte in input.as_bytes() {
        frames.extend(terminals.on_bytes(MULTI_TERMINAL, &[*byte]));
    }
    // Completion without an EOF must flush the final secret flag line.
    frames.extend(terminals.finish_supervised(MULTI_TERMINAL, Instant::now()));
    let (head, tail, total) = shared_parts(&frames);
    assert_eq!(head, "public-first\n⟦redacted line⟧\n⟦redacted line⟧\n\nmax_tokens=4096\nserve --api-key ⟦redacted:22⟧".as_bytes());
    assert!(tail.is_empty());
    assert_eq!(total, head.len() as u64);
    seen.extend(viewer.receive(MULTI_TERMINAL, &frames));
    let shown = seen_data(&seen);
    assert!(
        contains(&shown, input.as_bytes()),
        "encrypted viewer did not get original output"
    );
}

#[test]
fn supervised_hf_review_capture_is_masked_at_eof_and_reuses_the_same_copy() {
    let (tx, rx) = channel();
    let mut terminals = supervised_registry(tx, &fake_confirm_output(None, "sleep 30"));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let mut request = spawn_request(true);
    request.command = "cat ~/.huggingface/token".to_string();
    let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
    let mut viewer = TestViewer::new(83);
    let joined = attach_viewer(&mut terminals, &startup, &mut viewer);
    let mut seen = viewer.receive(MULTI_TERMINAL, &joined);
    accept(&mut terminals, &rx, &mut frames, &mut viewer);
    let label = viewer.id.clone();
    frames.extend(send(
        &mut terminals,
        &mut viewer,
        &label,
        &TermPlaintextV2::ReviewToggle(true),
    ));
    let hf = case("hf");
    for byte in hf.input.as_bytes() {
        frames.extend(terminals.on_bytes(MULTI_TERMINAL, &[*byte]));
    }
    let eof = case("eof");
    frames.extend(terminals.on_bytes(MULTI_TERMINAL, eof.input.as_bytes()));
    frames.extend(terminals.on_eof(MULTI_TERMINAL));
    let supervised = terminals
        .sessions
        .get(MULTI_TERMINAL)
        .expect("session")
        .supervised
        .as_ref()
        .expect("supervised");
    assert_eq!(
        supervised.mask.held(),
        0,
        "EOF kept a tail until process exit"
    );
    frames.extend(terminals.finish_supervised(MULTI_TERMINAL, Instant::now()));
    assert!(
        !frames.iter().any(|f| matches!(
            f,
            OutboundFrame::Binary(RelayBinaryFrameMetadata::SupervisedOutput { .. }, _)
        )),
        "review output was sent to the server before the person reviewed it"
    );
    seen.extend(viewer.receive(MULTI_TERMINAL, &frames));
    let expected = format!("{}⟦redacted:{}⟧", hf.expected, eof.input.chars().count());
    let (total, head, tail) = seen
        .iter()
        .find_map(|s| match s {
            Seen::Capture(total, head, tail) => Some((*total, head, tail)),
            _ => None,
        })
        .expect("review capture");
    assert_eq!(*head, expected.as_bytes());
    assert!(tail.is_empty());
    assert_eq!(total, expected.len() as u64);
    let _ = terminals.close(MULTI_TERMINAL);
    assert!(terminals.sessions.is_empty());
}
