//! Operator terminals on the relay loop: confirm stage, attach at Relay only,
//! the command's PTY, and what the step's runner thread and server hear.

use super::*;
use crate::protocol::frames::{CommandAuthor, JobPhase, JobStatus, TrustValue};
use crate::runtimes::operator::{
    MAX_OPERATOR_TERMINALS, OperatorEvent, OperatorIds, OperatorOpen, OperatorScreen,
};
use std::os::unix::fs::PermissionsExt;
use std::sync::mpsc::Receiver;

fn relay_startup() -> TerminalStartup {
    let config = Config {
        // Neither the browser-terminal switch nor Full control is needed.
        allow_human_terminal: false,
        trust: Some(TrustValue::Relay),
        ..Config::default()
    };
    TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config)
}

fn ids(terminal_id: &str, step_id: &str) -> OperatorIds {
    OperatorIds {
        step_id: step_id.into(),
        instance_id: "in1".into(),
        rank: 0,
        intent_hash: "a".repeat(64),
        owner_epoch: "epoch:1".into(),
        terminal_id: terminal_id.into(),
    }
}

/// A `sudo` stand-in on `PATH` that only records its arguments.
struct FakeSudo {
    dir: tempfile::TempDir,
}

impl FakeSudo {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("sudo.log");
        let script = dir.path().join("sudo");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$*\" >> '{}'\n", log.display()),
        )
        .expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        Self { dir }
    }

    fn env(&self) -> Vec<(String, String)> {
        vec![
            (
                "PATH".into(),
                format!("{}:/usr/bin:/bin", self.dir.path().display()),
            ),
            ("TERM".into(), "xterm-256color".into()),
        ]
    }

    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join("sudo.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }
}

fn request(
    terminal_id: &str,
    step_id: &str,
    command: &str,
    env: Vec<(String, String)>,
) -> (OperatorOpen, Receiver<OperatorEvent>) {
    let (events, rx) = mpsc::sync_channel(8);
    (
        OperatorOpen {
            ids: ids(terminal_id, step_id),
            screen: OperatorScreen {
                node: "spark-1".into(),
                handle: "i-abcdefabcdef".into(),
                phase: JobPhase::Start,
                rank: 0,
                command: command.into(),
                author: CommandAuthor::Agent,
            },
            env,
            events,
        },
        rx,
    )
}

/// `(status, exitCode, terminalId)` of every step result in `frames`.
fn results(frames: &[OutboundFrame]) -> Vec<(JobStatus, Option<u8>, Option<String>)> {
    controls(frames)
        .into_iter()
        .filter_map(|message| match message {
            NodeFrame::RuntimeJobResult {
                status,
                exit_code,
                terminal_id,
                ..
            } => Some((*status, *exit_code, terminal_id.clone())),
            _ => None,
        })
        .collect()
}

fn exits(frames: &[OutboundFrame]) -> Vec<Option<u8>> {
    controls(frames)
        .into_iter()
        .filter_map(|message| match message {
            NodeFrame::TermExit { exit_code, .. } => Some(*exit_code),
            _ => None,
        })
        .collect()
}

fn data(seen: &[Seen]) -> String {
    seen.iter()
        .filter_map(|seen| match seen {
            Seen::Data(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        })
        .collect()
}

/// Pump PTY output into the registry until the operator terminal ends.
fn run_until_closed(
    terminals: &mut TerminalRegistry,
    rx: &mpsc::Receiver<FromWorker>,
) -> Vec<OutboundFrame> {
    let until = Instant::now() + Duration::from_secs(15);
    let mut frames = Vec::new();
    while terminals.sessions.contains_key(MULTI_TERMINAL) && Instant::now() < until {
        while let Ok(message) = rx.recv_timeout(Duration::from_millis(50)) {
            match message {
                FromWorker::TerminalBytes { terminal_id, bytes } => {
                    frames.extend(terminals.on_bytes(&terminal_id, &bytes));
                }
                FromWorker::TerminalEof { terminal_id } => {
                    frames.extend(terminals.on_eof(&terminal_id));
                }
                _ => {}
            }
        }
        frames.extend(terminals.poll(Instant::now()));
    }
    assert!(
        !terminals.sessions.contains_key(MULTI_TERMINAL),
        "the operator terminal ended"
    );
    frames
}

/// As `handle_runtime_job` then the runner thread do it: reserve the id,
/// then open the terminal.
fn reserve_and_open(terminals: &mut TerminalRegistry, open: OperatorOpen) -> Vec<OutboundFrame> {
    match terminals.reserve_operator(&open.ids.step_id, &open.ids.terminal_id) {
        Ok(mut frames) => {
            frames.extend(terminals.open_operator(open));
            frames
        }
        Err(error) => {
            let _ = open.events.try_send(OperatorEvent::Closed);
            vec![OutboundFrame::Control(open.ids.failed(error))]
        }
    }
}

fn type_keys(
    terminals: &mut TerminalRegistry,
    viewer: &mut TestViewer,
    keys: &[u8],
) -> Vec<OutboundFrame> {
    let label = viewer.id.clone();
    send(
        terminals,
        viewer,
        &label,
        &TermPlaintextV2::Data(keys.to_vec()),
    )
}

#[test]
fn a_relay_only_node_attaches_to_the_confirm_screen_and_reads_keys_itself() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = relay_startup();
    let sudo = FakeSudo::new();
    let (open, events) = request(
        MULTI_TERMINAL,
        "step1",
        "touch should-not-exist",
        sudo.env(),
    );
    let frames = reserve_and_open(&mut terminals, open);
    assert_eq!(
        results(&frames),
        vec![(
            JobStatus::AwaitingOperator,
            None,
            Some(MULTI_TERMINAL.to_string())
        )]
    );
    assert_eq!(terminals.human_count(), 0, "not a browser shell");
    assert_eq!(terminals.operator_count(), 1);
    assert_eq!(
        terminals.operator_status("step1", MULTI_TERMINAL),
        Some(JobStatus::AwaitingOperator)
    );
    assert_eq!(terminals.operator_status("other", MULTI_TERMINAL), None);

    let mut a = TestViewer::new(1);
    let frames = attach_viewer(&mut terminals, &startup, &mut a);
    assert!(matches!(
        controls(&frames)[0],
        NodeFrame::TermAttached { .. }
    ));
    let seen = a.receive(MULTI_TERMINAL, &frames);
    let screen = data(&seen);
    assert!(screen.contains("touch should-not-exist"), "{screen}");
    assert!(screen.contains("written by an agent"), "{screen}");
    assert!(screen.contains("Press Enter to run it here"), "{screen}");

    // Keys other than Enter / q reach nothing and change nothing.
    let frames = type_keys(&mut terminals, &mut a, b"ls -la; whoami");
    assert!(results(&frames).is_empty());
    assert!(
        terminals.sessions[MULTI_TERMINAL].pty.is_none(),
        "no process yet"
    );

    // A resize repaints the screen for the new width.
    let label = a.id.clone();
    let frames = send(
        &mut terminals,
        &mut a,
        &label,
        &TermPlaintextV2::Resize { cols: 40, rows: 20 },
    );
    let seen = a.receive(MULTI_TERMINAL, &frames);
    assert!(seen.contains(&Seen::Size(40, 20)));
    assert!(data(&seen).contains("should-not-exist"));

    // Idle detach never closes an operator terminal.
    let _ = terminals.detach(MULTI_TERMINAL, Some(&a.id));
    let _ = terminals.poll(Instant::now() + Duration::from_secs(24 * 3600));
    assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
    assert!(events.try_recv().is_err());
    assert!(sudo.calls().is_empty());
}

#[test]
fn a_decline_closes_the_terminal_without_running_anything() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = relay_startup();
    let sudo = FakeSudo::new();
    let marker = sudo.dir.path().join("ran");
    let (open, events) = request(
        MULTI_TERMINAL,
        "step1",
        &format!("touch '{}'", marker.display()),
        sudo.env(),
    );
    let _ = reserve_and_open(&mut terminals, open);
    let mut a = TestViewer::new(1);
    let _ = attach_viewer(&mut terminals, &startup, &mut a);
    let frames = type_keys(&mut terminals, &mut a, b"q");
    assert_eq!(exits(&frames), vec![None]);
    assert_eq!(
        results(&frames),
        vec![(
            JobStatus::OperatorClosed,
            None,
            Some(MULTI_TERMINAL.to_string())
        )]
    );
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Closed));
    assert!(!terminals.sessions.contains_key(MULTI_TERMINAL));
    assert!(!marker.exists());
    assert!(sudo.calls().is_empty());
}

#[test]
fn enter_runs_only_the_command_between_two_sudo_resets_and_a_failure_closes() {
    let (tx, rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = relay_startup();
    let sudo = FakeSudo::new();
    let (open, events) = request(
        MULTI_TERMINAL,
        "step1",
        "printf 'it ran'; [ -z \"$SUDO_ASKPASS\" ] || exit 9; exit 3",
        sudo.env(),
    );
    let _ = reserve_and_open(&mut terminals, open);
    let mut a = TestViewer::new(1);
    let attached = attach_viewer(&mut terminals, &startup, &mut a);
    let _ = a.receive(MULTI_TERMINAL, &attached);
    let frames = type_keys(&mut terminals, &mut a, b"\r");
    assert_eq!(
        results(&frames),
        vec![(
            JobStatus::OperatorRunning,
            None,
            Some(MULTI_TERMINAL.to_string())
        )]
    );
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Accepted));
    assert_eq!(
        terminals.operator_status("step1", MULTI_TERMINAL),
        Some(JobStatus::OperatorRunning)
    );
    let frames = run_until_closed(&mut terminals, &rx);
    let seen = a.receive(MULTI_TERMINAL, &frames);
    assert!(data(&seen).contains("it ran"), "{seen:?}");
    assert_eq!(exits(&frames), vec![Some(3)]);
    assert_eq!(
        results(&frames),
        vec![(
            JobStatus::OperatorClosed,
            Some(3),
            Some(MULTI_TERMINAL.to_string())
        )]
    );
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Closed));
    assert_eq!(sudo.calls(), vec!["-k".to_string(), "-k".to_string()]);
}

#[test]
fn a_clean_exit_hands_the_step_back_for_its_proof() {
    let (tx, rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = relay_startup();
    let sudo = FakeSudo::new();
    let (open, events) = request(MULTI_TERMINAL, "step1", "true", sudo.env());
    let _ = reserve_and_open(&mut terminals, open);
    let mut a = TestViewer::new(1);
    let _ = attach_viewer(&mut terminals, &startup, &mut a);
    let _ = type_keys(&mut terminals, &mut a, b"\n");
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Accepted));
    let frames = run_until_closed(&mut terminals, &rx);
    assert_eq!(exits(&frames), vec![Some(0)]);
    // The runner thread sends the final result after the proof.
    assert!(results(&frames).is_empty());
    assert_eq!(events.try_recv(), Ok(OperatorEvent::ExitedOk));
    // Input after the end reaches nothing.
    let frames = type_keys(&mut terminals, &mut a, b"echo late\r");
    assert!(frames.is_empty());
}

#[test]
fn a_stop_closes_confirm_screens_but_never_a_running_command() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = relay_startup();
    let sudo = FakeSudo::new();
    let (open, events) = request(MULTI_TERMINAL, "step1", "sleep 30", sudo.env());
    let _ = reserve_and_open(&mut terminals, open);
    let (other, other_events) = request("term-other", "step2", "true", sudo.env());
    let _ = reserve_and_open(&mut terminals, other);
    let mut a = TestViewer::new(1);
    let _ = attach_viewer(&mut terminals, &startup, &mut a);
    let _ = type_keys(&mut terminals, &mut a, b"\r");
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Accepted));
    // Both steps are rank 0 of `in1`: only the one still confirming closes.
    let frames = terminals.close_confirming_for_rank("in1", 0);
    assert_eq!(
        results(&frames),
        vec![(JobStatus::OperatorClosed, None, Some("term-other".into()))]
    );
    assert_eq!(other_events.try_recv(), Ok(OperatorEvent::Closed));
    assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
    assert!(
        terminals
            .close_operator_if_confirming(MULTI_TERMINAL)
            .is_empty()
    );
    // A server close that raced the Enter, and a trust lowering, leave the
    // run alone and send nothing; only the session's end kills it.
    assert!(terminals.close_from_server(MULTI_TERMINAL).is_empty());
    assert!(terminals.on_trust_lowered().is_empty());
    assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
    assert!(events.try_recv().is_err());
    let frames = terminals.close(MULTI_TERMINAL);
    let closed = results(&frames);
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].0, JobStatus::OperatorClosed);
    assert_eq!(closed[0].1, Some(128 + 9), "killed");
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Closed));
}

#[test]
fn a_newer_terminal_replaces_a_confirming_one_and_the_cap_refuses() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let sudo = FakeSudo::new();
    let (first, first_events) = request("term-1", "step1", "true", sudo.env());
    let _ = reserve_and_open(&mut terminals, first);
    let (second, _second_events) = request("term-2", "step1", "true", sudo.env());
    let frames = reserve_and_open(&mut terminals, second);
    assert_eq!(
        results(&frames),
        vec![
            (JobStatus::OperatorClosed, None, Some("term-1".into())),
            (JobStatus::AwaitingOperator, None, Some("term-2".into())),
        ]
    );
    assert_eq!(first_events.try_recv(), Ok(OperatorEvent::Closed));
    let mut keep = Vec::new();
    for index in 1..MAX_OPERATOR_TERMINALS {
        let (open, events) = request(
            &format!("term-x{index}"),
            &format!("s{index}"),
            "true",
            sudo.env(),
        );
        let _ = reserve_and_open(&mut terminals, open);
        keep.push(events);
    }
    assert_eq!(terminals.operator_count(), MAX_OPERATOR_TERMINALS);
    let (over, over_events) = request("term-over", "s-over", "true", sudo.env());
    let frames = reserve_and_open(&mut terminals, over);
    assert!(matches!(
        controls(&frames)[..],
        [NodeFrame::RuntimeJobResult {
            status: JobStatus::Failed,
            error: Some(crate::protocol::frames::JobError::OperatorTerminalsDisabled),
            terminal_id: Some(_),
            ..
        }]
    ));
    assert_eq!(over_events.try_recv(), Ok(OperatorEvent::Closed));
    // Ending the session ends every operator terminal.
    let frames = terminals.kill_all();
    assert_eq!(
        results(&frames)
            .iter()
            .filter(|(status, ..)| *status == JobStatus::OperatorClosed)
            .count(),
        MAX_OPERATOR_TERMINALS
    );
}

#[test]
fn browser_shells_stay_refused_at_relay_only() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = relay_startup();
    let a = TestViewer::new(1);
    let frames = terminals.open(&startup, None, a.handshake("term-shell", 80, 24));
    assert!(rejection(&frames).is_some());
    assert!(terminals.sessions.is_empty());
}

#[test]
fn a_terminal_id_opens_once_and_re_deliveries_never_run_twice() {
    use crate::sessions::OperatorDelivery;
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let sudo = FakeSudo::new();
    assert_eq!(
        terminals.operator_delivery("step1", MULTI_TERMINAL),
        OperatorDelivery::New
    );
    terminals
        .reserve_operator("step1", MULTI_TERMINAL)
        .expect("reserved");
    // Re-delivered while its runner thread has not opened it yet: nothing.
    assert_eq!(
        terminals.operator_delivery("step1", MULTI_TERMINAL),
        OperatorDelivery::Repeat(None)
    );
    assert_eq!(
        terminals.operator_delivery("step2", MULTI_TERMINAL),
        OperatorDelivery::Clash
    );
    let (open, events) = request(MULTI_TERMINAL, "step1", "true", sudo.env());
    let frames = terminals.open_operator(open);
    assert_eq!(results(&frames)[0].0, JobStatus::AwaitingOperator);
    // Re-delivered while open: re-report.
    assert_eq!(
        terminals.operator_delivery("step1", MULTI_TERMINAL),
        OperatorDelivery::Repeat(Some(JobStatus::AwaitingOperator))
    );
    let _ = terminals.close_from_server(MULTI_TERMINAL);
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Closed));
    // Ended: a late copy changes nothing, and the id never opens again.
    assert_eq!(
        terminals.operator_delivery("step1", MULTI_TERMINAL),
        OperatorDelivery::Repeat(None)
    );
    let (again, again_events) = request(MULTI_TERMINAL, "step1", "true", sudo.env());
    let frames = terminals.open_operator(again);
    assert_eq!(
        results(&frames),
        vec![(
            JobStatus::OperatorClosed,
            None,
            Some(MULTI_TERMINAL.to_string())
        )]
    );
    assert_eq!(again_events.try_recv(), Ok(OperatorEvent::Closed));
    assert!(!terminals.sessions.contains_key(MULTI_TERMINAL));
}

#[test]
fn a_newer_dispatch_cancels_an_older_terminal_not_opened_yet() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let sudo = FakeSudo::new();
    terminals
        .reserve_operator("step1", "term-old")
        .expect("old");
    terminals
        .reserve_operator("step1", "term-new")
        .expect("new");
    // The older runner thread reaches its open: it closes at once and lets
    // go of the rank, so the newer one can run.
    let (old, old_events) = request("term-old", "step1", "true", sudo.env());
    let frames = terminals.open_operator(old);
    assert_eq!(
        results(&frames),
        vec![(JobStatus::OperatorClosed, None, Some("term-old".into()))]
    );
    assert_eq!(old_events.try_recv(), Ok(OperatorEvent::Closed));
    let (new, _new_events) = request("term-new", "step1", "true", sudo.env());
    let frames = terminals.open_operator(new);
    assert_eq!(results(&frames)[0].0, JobStatus::AwaitingOperator);
}

#[test]
fn a_close_before_the_terminal_opens_keeps_it_from_ever_opening() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let sudo = FakeSudo::new();
    terminals
        .reserve_operator("step1", MULTI_TERMINAL)
        .expect("reserved");
    assert!(terminals.close_from_server(MULTI_TERMINAL).is_empty());
    let (open, events) = request(MULTI_TERMINAL, "step1", "true", sudo.env());
    let frames = terminals.open_operator(open);
    assert_eq!(
        results(&frames),
        vec![(
            JobStatus::OperatorClosed,
            None,
            Some(MULTI_TERMINAL.to_string())
        )]
    );
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Closed));
    assert!(terminals.sessions.is_empty());
}

#[test]
fn lowering_trust_closes_confirm_screens_and_pending_terminals() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let sudo = FakeSudo::new();
    let (open, events) = request(MULTI_TERMINAL, "step1", "true", sudo.env());
    let _ = reserve_and_open(&mut terminals, open);
    terminals
        .reserve_operator("step2", "term-later")
        .expect("pending");
    let frames = terminals.on_trust_lowered();
    assert_eq!(
        results(&frames),
        vec![(
            JobStatus::OperatorClosed,
            None,
            Some(MULTI_TERMINAL.to_string())
        )]
    );
    assert_eq!(events.try_recv(), Ok(OperatorEvent::Closed));
    // Rendered under the old trust: it never opens.
    let (later, later_events) = request("term-later", "step2", "true", sudo.env());
    let frames = terminals.open_operator(later);
    assert_eq!(results(&frames)[0].0, JobStatus::OperatorClosed);
    assert_eq!(later_events.try_recv(), Ok(OperatorEvent::Closed));
}

/// Queue a browser-shell open that waits for approval (Full control).
fn queue_shell_approval(terminals: &mut TerminalRegistry, dir: &Path) {
    use p256::elliptic_curve::Generate;
    let startup = enabled_startup(true);
    let browser = CliTerminalKey::generate().expect("browser");
    let identity = p256::ecdsa::SigningKey::try_generate().expect("identity");
    let mut raw = [0_u8; 65];
    raw.copy_from_slice(identity.verifying_key().to_sec1_point(false).as_bytes());
    let identity = TerminalIdentity {
        public_key: terminal_crypto::encode_b64url(&raw),
        signature: None,
    };
    let nonce = terminal_crypto::encode_b64url(&[4_u8; 16]);
    let frames = terminals.open(
        &startup,
        Some(dir),
        TermHandshake {
            terminal_id: "term-shell",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: Some(&identity),
        },
    );
    assert!(matches!(
        controls(&frames)[0],
        NodeFrame::TermPending { .. }
    ));
    assert_eq!(terminals.pending.len(), 1);
}

#[test]
fn a_shell_waiting_for_approval_never_spawns_after_a_lowering() {
    let dir = tempfile::tempdir().expect("dir");
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    queue_shell_approval(&mut terminals, dir.path());
    let _ = terminals.on_trust_lowered();
    assert!(terminals.pending.is_empty());
    let frames = terminals.auth(
        &relay_startup(),
        Some(dir.path()),
        "term-shell",
        Some("viewer-a"),
        "c2lnbmF0dXJl",
    );
    assert!(frames.is_empty());
    assert!(terminals.sessions.is_empty(), "no shell at Relay only");
}

#[test]
fn an_approval_is_checked_against_the_trust_of_its_auth() {
    let dir = tempfile::tempdir().expect("dir");
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    queue_shell_approval(&mut terminals, dir.path());
    // The node is Relay only by the time the approval arrives.
    let frames = terminals.auth(
        &relay_startup(),
        Some(dir.path()),
        "term-shell",
        Some("viewer-a"),
        "c2lnbmF0dXJl",
    );
    assert_eq!(
        rejection(&frames),
        Some((Some("viewer-a".to_string()), REASON_DISABLED.to_string()))
    );
    assert!(terminals.sessions.is_empty());
    assert!(terminals.pending.is_empty());
}
