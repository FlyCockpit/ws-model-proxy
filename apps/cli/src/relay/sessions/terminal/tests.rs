use super::*;
use crate::relay::sessions::test_support::*;

use crate::node::config::Config;
use crate::wire::protocol::frames::TerminalIdentity;
use crate::wire::terminal_crypto::CliTerminalKey;

/// A registry whose terminals run a shell that waits `seconds` and
/// reads nothing.
fn sleeping_registry(
    tx: SyncSender<FromWorker>,
    idle_limit: Duration,
    seconds: u32,
) -> TerminalRegistry {
    #[cfg(unix)]
    let (program, script) = ("/bin/sh", format!("sleep {seconds}"));
    #[cfg(windows)]
    let (program, script) = ("cmd.exe", format!("ping -n {seconds} 127.0.0.1 >nul"));
    let flag = if cfg!(unix) { "-c" } else { "/C" };
    TerminalRegistry::with_shell(tx, idle_limit, program, &[flag, &script])
}

#[test]
fn scrollback_keeps_the_newest_256_kib() {
    let mut buf = VecDeque::new();
    push_scrollback(&mut buf, &vec![1_u8; SCROLLBACK_LIMIT]);
    push_scrollback(&mut buf, &[2, 2, 2]);
    assert_eq!(buf.len(), SCROLLBACK_LIMIT);
    assert_eq!(buf.front().copied(), Some(1));
    assert_eq!(buf.back().copied(), Some(2));
    let drained = buf.iter().rev().take(3).copied().collect::<Vec<_>>();
    assert_eq!(drained, vec![2, 2, 2]);
}

#[test]
#[cfg(unix)]
fn pty_spawn_reads_output_and_close_reaps_it() {
    let (tx, rx) = channel();
    let mut terminals = TerminalRegistry::with_shell(
        tx,
        Duration::from_secs(15 * 60),
        "/bin/sh",
        &["-c", "printf wsmp-pty-ok"],
    );
    let startup = enabled_startup(false);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
    let frames = terminals.open(
        &startup,
        None,
        TermHandshake {
            terminal_id: "term-1",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: None,
            shell: None,
        },
    );
    assert!(matches!(
        &frames[0],
        OutboundFrame::Control(NodeFrame::TermOpened { .. })
    ));
    let deadline = Instant::now() + Duration::from_secs(3);
    let expected = b"wsmp-pty-ok";
    let mut output = Vec::new();
    while Instant::now() < deadline
        && !output
            .windows(expected.len())
            .any(|window| window == expected)
    {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(FromWorker::TerminalBytes { bytes, .. }) => output.extend(bytes),
            Ok(FromWorker::TerminalEof { .. }) => break,
            _ => {}
        }
    }
    assert!(
        output
            .windows(expected.len())
            .any(|window| window == expected),
        "pty did not emit the expected output: {output:?}"
    );
    let _ = terminals.close("term-1");
    drop(terminals);
    drop(rx);
}

/// Opens browser terminals until one is refused; returns how many opened.
fn open_until_refused(startup: &TerminalStartup) -> usize {
    let (tx, rx) = channel();
    let mut terminals = sleeping_registry(tx, Duration::from_secs(60), 30);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[1_u8; 16]);
    let mut opened = 0;
    loop {
        let terminal_id = format!("t{opened}");
        let frames = terminals.open(
            startup,
            None,
            TermHandshake {
                terminal_id: &terminal_id,
                viewer_id: Some("viewer-a"),
                cols: 80,
                rows: 24,
                browser_public_key: browser.public_b64url(),
                browser_nonce: &nonce,
                identity: None,
                shell: None,
            },
        );
        match &frames[0] {
            OutboundFrame::Control(NodeFrame::TermOpened { .. }) => opened += 1,
            OutboundFrame::Control(NodeFrame::TermRejected { reason, .. }) => {
                assert_eq!(reason, REASON_LIMIT);
                break;
            }
            _ => panic!("unexpected reply to term.open"),
        }
        assert!(opened <= 32, "no terminal limit applied");
    }
    drop(terminals);
    drop(rx);
    opened
}

#[test]
fn terminal_concurrency_cap_is_four_by_default_and_configurable() {
    assert_eq!(open_until_refused(&enabled_startup(false)), 4);
    let config = Config {
        allow_human_terminal: true,
        trust: Some(crate::wire::protocol::frames::TrustValue::Full),
        max_terminals: Some(1),
        ..Config::default()
    };
    let startup = TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config);
    assert_eq!(open_until_refused(&startup), 1);
}

#[test]
fn detached_terminal_closes_after_the_injected_idle_timeout() {
    let (tx, _rx) = channel();
    let mut terminals = sleeping_registry(tx, Duration::from_secs(60), 30);
    let startup = enabled_startup(false);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[3_u8; 16]);
    terminals.open(
        &startup,
        None,
        TermHandshake {
            terminal_id: "idle",
            viewer_id: Some("viewer-a"),
            cols: 40,
            rows: 12,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: None,
            shell: None,
        },
    );
    terminals.detach("idle", Some("viewer-a"));
    // The poll clock is passed in, so no real waiting is needed.
    let frames = terminals.poll(Instant::now() + Duration::from_secs(120));
    assert!(matches!(
        &frames[0],
        OutboundFrame::Control(NodeFrame::TermExit { terminal_id, .. })
            if terminal_id == "idle"
    ));
    assert!(!terminals.sessions.contains_key("idle"));
}

#[test]
fn approval_does_not_spawn_until_the_cli_nonce_is_signed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (tx, rx) = channel();
    let mut terminals = sleeping_registry(tx, Duration::from_secs(60), 30);
    let startup = enabled_startup(true);
    let browser = CliTerminalKey::generate().expect("browser");
    use p256::elliptic_curve::Generate;
    let identity = p256::ecdsa::SigningKey::try_generate().expect("identity");
    let identity_raw = {
        let encoded = identity.verifying_key().to_sec1_point(false);
        let mut raw = [0_u8; 65];
        raw.copy_from_slice(encoded.as_bytes());
        raw
    };
    let identity_message = TerminalIdentity {
        public_key: terminal_crypto::encode_b64url(&identity_raw),
        signature: None,
    };
    let nonce = terminal_crypto::encode_b64url(&[4_u8; 16]);
    let frames = terminals.open(
        &startup,
        Some(dir.path()),
        TermHandshake {
            terminal_id: "term-a",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: Some(&identity_message),
            shell: None,
        },
    );
    let (cli_nonce, code) = match &frames[0] {
        OutboundFrame::Control(NodeFrame::TermPending {
            cli_nonce,
            approval_code,
            ..
        }) => (cli_nonce.clone(), approval_code.clone().expect("code")),
        _ => panic!("expected a pending terminal handshake"),
    };
    assert!(terminals.sessions.is_empty());
    assert_eq!(terminals.pending.len(), 1);
    crate::node::approvals::approve(dir.path(), &code).expect("approve");
    let cli_nonce_raw = terminal_crypto::decode_nonce(&cli_nonce).expect("nonce");
    let signature = terminal_crypto::sign_approval_v2(
        &identity,
        "term-a",
        "viewer-a",
        browser.public_raw(),
        &[4_u8; 16],
        startup.terminal_public_key(),
        &cli_nonce_raw,
    )
    .expect("sign");
    let opened = terminals.auth(
        &startup,
        Some(dir.path()),
        "term-a",
        Some("viewer-a"),
        &terminal_crypto::encode_b64url(&signature),
    );
    assert!(matches!(
        &opened[0],
        OutboundFrame::Control(NodeFrame::TermOpened { cli_nonce: opened_nonce, .. })
            if opened_nonce == &cli_nonce
    ));
    assert!(terminals.pending.is_empty());
    assert!(terminals.sessions.contains_key("term-a"));
    drop(terminals);
    drop(rx);
}

#[test]
#[cfg(unix)]
fn pty_close_returns_while_the_slave_is_held() {
    let (tx, rx) = channel();
    let mut terminals = sleeping_registry(tx, Duration::from_secs(60), 120);
    let startup = enabled_startup(false);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
    terminals.open(
        &startup,
        None,
        TermHandshake {
            terminal_id: "held",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: None,
            shell: None,
        },
    );
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    let frames = terminals.close("held");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "close blocked for {:?}",
        started.elapsed()
    );
    assert!(matches!(
        &frames[0],
        OutboundFrame::Control(NodeFrame::TermExit { .. })
    ));
    drop(terminals);
    drop(rx);
}

// Protocol 2.5 (multi-viewer) tests. `TestViewer` plays one browser tab.

const MULTI_TERMINAL: &str = "term-multi";

#[derive(Debug, PartialEq)]
enum Seen {
    Key(u32),
    Size(u16, u16),
    Data(Vec<u8>),
    Opaque,
}

struct TestViewer {
    id: String,
    browser: CliTerminalKey,
    nonce: [u8; 16],
    nonce_b64: String,
    keys: Option<DirectionKeys>,
    tx_seq: u64,
    out: Option<(u32, [u8; 32])>,
}

impl TestViewer {
    fn new(tag: u8) -> Self {
        let nonce = [tag; 16];
        Self {
            id: terminal_crypto::encode_b64url(&[tag.wrapping_add(100); 16]),
            browser: CliTerminalKey::generate().expect("browser"),
            nonce,
            nonce_b64: terminal_crypto::encode_b64url(&nonce),
            keys: None,
            tx_seq: 0,
            out: None,
        }
    }

    fn handshake<'a>(&'a self, terminal_id: &'a str, cols: u16, rows: u16) -> TermHandshake<'a> {
        TermHandshake {
            terminal_id,
            viewer_id: Some(&self.id),
            cols,
            rows,
            browser_public_key: self.browser.public_b64url(),
            browser_nonce: &self.nonce_b64,
            identity: None,
            shell: None,
        }
    }

    fn bind(&mut self, startup: &TerminalStartup, terminal_id: &str, cli_nonce: &str) {
        let ikm = self
            .browser
            .shared_x(startup.terminal_public_key())
            .expect("ecdh");
        let cli_nonce = terminal_crypto::decode_nonce(cli_nonce).expect("nonce");
        self.keys = Some(
            terminal_crypto::derive_direction_keys_v2_from_ikm(
                &ikm,
                startup.terminal_public_key(),
                self.browser.public_raw(),
                &self.nonce,
                &cli_nonce,
                terminal_id,
                &self.id,
            )
            .expect("keys"),
        );
    }

    fn seal(&mut self, terminal_id: &str, message: &TermPlaintextV2) -> (u64, Vec<u8>) {
        let plaintext = terminal_crypto::encode_plaintext_v2(message).expect("encode");
        self.seal_bytes(terminal_id, &plaintext)
    }

    /// Seal raw plaintext bytes, including tags the codec cannot encode.
    fn seal_bytes(&mut self, terminal_id: &str, plaintext: &[u8]) -> (u64, Vec<u8>) {
        self.tx_seq += 1;
        let keys = self.keys.as_ref().expect("bound");
        let body = terminal_crypto::seal_v2(
            &keys.browser_to_cli,
            terminal_id,
            &self.id,
            DIR_BROWSER_TO_CLI,
            self.tx_seq,
            plaintext,
        )
        .expect("seal");
        (self.tx_seq, body)
    }

    fn unicast_messages(
        &self,
        terminal_id: &str,
        frames: &[OutboundFrame],
    ) -> Vec<TermPlaintextV2> {
        frames
            .iter()
            .filter_map(|frame| {
                let OutboundFrame::Binary(
                    NodeBinaryMetadata::TermSealed {
                        seq,
                        viewer_id: Some(viewer_id),
                        epoch: None,
                        ..
                    },
                    body,
                ) = frame
                else {
                    return None;
                };
                if viewer_id != &self.id {
                    return None;
                }
                let bytes = terminal_crypto::open_v2(
                    &self.keys.as_ref().expect("bound").cli_to_browser,
                    terminal_id,
                    viewer_id,
                    DIR_CLI_TO_BROWSER,
                    *seq,
                    body,
                )
                .expect("unicast");
                Some(terminal_crypto::decode_plaintext_v2(&bytes).expect("plaintext"))
            })
            .collect()
    }

    /// Decode the frames the relay would deliver to this tab: unicast
    /// frames addressed to it, and every broadcast frame.
    fn receive(&mut self, terminal_id: &str, frames: &[OutboundFrame]) -> Vec<Seen> {
        let mut seen = Vec::new();
        for frame in frames {
            let OutboundFrame::Binary(
                NodeBinaryMetadata::TermSealed {
                    seq,
                    viewer_id,
                    epoch,
                    ..
                },
                body,
            ) = frame
            else {
                continue;
            };
            let plaintext = match (viewer_id, epoch) {
                (Some(viewer_id), None) => {
                    if viewer_id != &self.id {
                        continue;
                    }
                    let keys = self.keys.as_ref().expect("bound");
                    terminal_crypto::open_v2(
                        &keys.cli_to_browser,
                        terminal_id,
                        viewer_id,
                        DIR_CLI_TO_BROWSER,
                        *seq,
                        body,
                    )
                    .ok()
                }
                (None, Some(epoch)) => self.out.and_then(|(known, key)| {
                    (known == *epoch)
                        .then(|| {
                            terminal_crypto::open_broadcast(&key, terminal_id, *epoch, *seq, body)
                                .ok()
                        })
                        .flatten()
                }),
                _ => panic!("a 2.5 sealed frame carries exactly one of viewerId or epoch"),
            };
            let Some(plaintext) = plaintext else {
                seen.push(Seen::Opaque);
                continue;
            };
            seen.push(
                match terminal_crypto::decode_plaintext_v2(&plaintext).expect("plaintext") {
                    TermPlaintextV2::OutputKey { epoch, key } => {
                        self.out = Some((epoch, key));
                        Seen::Key(epoch)
                    }
                    TermPlaintextV2::Resize { cols, rows } => Seen::Size(cols, rows),
                    TermPlaintextV2::Data(bytes) => Seen::Data(bytes),
                    TermPlaintextV2::ImageCapabilities => continue,
                    TermPlaintextV2::ImageChunk(_)
                    | TermPlaintextV2::ImageReply(_)
                    | TermPlaintextV2::ImagePaste(_)
                    | TermPlaintextV2::ImageCancel(_) => continue,
                },
            );
        }
        seen
    }
}

fn multi_registry(tx: SyncSender<FromWorker>) -> TerminalRegistry {
    sleeping_registry(tx, Duration::from_secs(60), 30)
}

fn cli_nonce_of(frames: &[OutboundFrame]) -> String {
    frames
        .iter()
        .find_map(|frame| match frame {
            OutboundFrame::Control(
                NodeFrame::TermOpened { cli_nonce, .. }
                | NodeFrame::TermAttached { cli_nonce, .. }
                | NodeFrame::TermPending { cli_nonce, .. },
            ) => Some(cli_nonce.clone()),
            _ => None,
        })
        .expect("a handshake reply")
}

fn writer_changes(frames: &[OutboundFrame]) -> Vec<Option<String>> {
    controls(frames)
        .into_iter()
        .filter_map(|message| match message {
            NodeFrame::TermWriter { viewer_id, .. } => Some(viewer_id.clone()),
            _ => None,
        })
        .collect()
}

fn rejection(frames: &[OutboundFrame]) -> Option<(Option<String>, String)> {
    controls(frames)
        .into_iter()
        .find_map(|message| match message {
            NodeFrame::TermRejected {
                viewer_id, reason, ..
            } => Some((viewer_id.clone(), reason.clone())),
            _ => None,
        })
}

fn open_viewer(
    terminals: &mut TerminalRegistry,
    startup: &TerminalStartup,
    viewer: &mut TestViewer,
) -> Vec<OutboundFrame> {
    let frames = terminals.open(startup, None, viewer.handshake(MULTI_TERMINAL, 80, 24));
    viewer.bind(startup, MULTI_TERMINAL, &cli_nonce_of(&frames));
    frames
}

fn attach_viewer(
    terminals: &mut TerminalRegistry,
    startup: &TerminalStartup,
    viewer: &mut TestViewer,
) -> Vec<OutboundFrame> {
    let frames = terminals.attach(startup, None, viewer.handshake(MULTI_TERMINAL, 0, 0));
    viewer.bind(startup, MULTI_TERMINAL, &cli_nonce_of(&frames));
    frames
}

fn send(
    terminals: &mut TerminalRegistry,
    viewer: &mut TestViewer,
    label: &str,
    message: &TermPlaintextV2,
) -> Vec<OutboundFrame> {
    let (seq, body) = viewer.seal(MULTI_TERMINAL, message);
    terminals.handle_sealed(MULTI_TERMINAL, Some(label), seq, &body)
}

#[cfg(windows)]
fn pty_size(terminals: &TerminalRegistry) -> (u16, u16) {
    // The helper owns the console; the registry's record is what it sent.
    let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
    assert!(session.pty().is_some(), "pty");
    session.pty_size
}

#[cfg(unix)]
fn pty_size(terminals: &TerminalRegistry) -> (u16, u16) {
    let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
    let size = session.pty().expect("pty").master.get_size().expect("size");
    assert_eq!(session.pty_size, (size.cols, size.rows));
    (size.cols, size.rows)
}

fn writer(terminals: &TerminalRegistry) -> Option<String> {
    terminals
        .sessions
        .get(MULTI_TERMINAL)
        .expect("session")
        .writer
        .clone()
}

mod process_tests;
mod viewer_tests;

mod operator_tests;

mod image_tests;
