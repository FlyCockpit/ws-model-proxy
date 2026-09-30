#![cfg(unix)]

use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use wsmp::file_ops::{Cancel, EtagKey, FileOps, Policy, SupervisedChildInput};

const MARKER: &str = "00112233445566778899aabbccddeeff";
const PREVIEW_KEY: [u8; 32] = [7; 32];

struct PtyChild {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    seen: Vec<u8>,
    reader: Option<thread::JoinHandle<()>>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

impl PtyChild {
    fn spawn(input: &SupervisedChildInput, body: Option<&Path>) -> Self {
        let system = portable_pty::native_pty_system();
        let pair = system
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a pty");
        let mut builder = portable_pty::CommandBuilder::new(assert_cmd::cargo::cargo_bin("wsmp"));
        builder.args(["terminal", "supervised-file"]);
        builder.env("WSMP_SUPERVISED_FILE_OP", &input.op);
        builder.env(
            "WSMP_SUPERVISED_FILE_ARGS",
            serde_json::to_string(&input.args).expect("serialize child args"),
        );
        builder.env("WSMP_SUPERVISED_FILE_ETAG_KEY", "07".repeat(32));
        builder.env("WSMP_SUPERVISED_FILE_PREIMAGE", &input.preview_etag);
        builder.env("WSMP_SUPERVISED_FILE_ALLOW_ROOT", "1");
        if let Some(code) = input.blocked {
            builder.env("WSMP_SUPERVISED_FILE_BLOCKED", code.as_str());
        }
        if let Some(path) = body {
            builder.env("WSMP_SUPERVISED_FILE_BODY", path);
        }
        builder.env("WSMP_SUPERVISED_REQUESTER", "test agent\x1b");
        builder.env("WSMP_SUPERVISED_MARKER", MARKER);
        // File screens must ignore both command and spawn-level reason.
        builder.env("WSMP_SUPERVISED_COMMAND", "FORGED COMMAND MUST NOT APPEAR");
        builder.env("WSMP_SUPERVISED_REASON", "FORGED REASON MUST NOT APPEAR");
        builder.env_remove("WSMP_LOG");
        builder.env_remove("RUST_LOG");
        let child = pair.slave.spawn_command(builder).expect("spawn wsmp");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("pty reader");
        let writer = pair.master.take_writer().expect("pty writer");
        let (tx, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            while let Ok(count) = reader.read(&mut buf) {
                if count == 0 || tx.send(buf[..count].to_vec()).is_err() {
                    return;
                }
            }
        });
        Self {
            child,
            writer,
            output,
            seen: Vec::new(),
            reader: Some(reader),
            _master: pair.master,
        }
    }

    fn marker(kind: &str) -> Vec<u8> {
        format!("\x1b]7717;wsmp-supervised;{kind};{MARKER}\x07").into_bytes()
    }

    fn wait_for(&mut self, needle: &[u8]) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self
                .seen
                .windows(needle.len())
                .any(|window| window == needle)
            {
                return true;
            }
            if let Ok(bytes) = self.output.recv_timeout(Duration::from_millis(50)) {
                self.seen.extend(bytes);
            }
        }
        false
    }

    fn send(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).expect("write PTY input");
        self.writer.flush().expect("flush PTY input");
    }
}

impl Drop for PtyChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn prepare(root: &Path, op: &str, args: Value, body: Option<Vec<u8>>) -> SupervisedChildInput {
    let ops = FileOps::new(
        Policy::from_environment(vec![root.to_owned()], true),
        EtagKey::from_bytes([9; 32]),
    );
    ops.prepare_supervised(
        op,
        args,
        body,
        &EtagKey::from_bytes(PREVIEW_KEY),
        &Cancel::new(),
    )
    .expect("prepare supervised request")
    .child_input()
    .clone()
}

#[test]
fn real_child_masks_disk_diff_and_enter_never_applies() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("settings.txt");
    let before = include_bytes!("fixtures/masking/supervised-file.txt");
    std::fs::write(&target, before).expect("write target");
    let input = prepare(
        dir.path(),
        "edit",
        json!({
            "path": target,
            "edits": [{
                "oldText": "visible=old",
                "newText": "visible=new",
                "expectedMatches": 1
            }],
            "reason": "update visible setting\u{202e}\u{1b}"
        }),
        None,
    );
    assert!(input.blocked.is_none());
    let mut child = PtyChild::spawn(&input, None);
    assert!(
        child.wait_for(&PtyChild::marker("ready")),
        "{}",
        String::from_utf8_lossy(&child.seen)
    );
    let screen = String::from_utf8_lossy(&child.seen);
    assert!(screen.contains("Masked unified diff:"), "{screen}");
    assert!(screen.contains("redacted"), "{screen}");
    assert!(!screen.contains("fixture-value-not-a-real-credential"));
    assert!(screen.contains("\\u{202e}\\u{1b}"), "{screen}");
    assert!(!screen.contains("FORGED COMMAND MUST NOT APPEAR"));
    assert!(!screen.contains("FORGED REASON MUST NOT APPEAR"));

    child.send(b"\r");
    assert!(child.wait_for(&PtyChild::marker("accepted")));
    assert_eq!(std::fs::read(&target).expect("read before go"), before);
    child.send(&PtyChild::marker("go"));
    child.child.wait().expect("child exits after go");
    assert_eq!(std::fs::read(&target).expect("read after go"), before);
}

#[test]
fn blocked_real_child_allows_every_dismiss_key_and_never_accepts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("missing.txt");
    let input = prepare(
        dir.path(),
        "delete",
        json!({"path": missing, "reason": "remove stale file"}),
        None,
    );
    let code = input.blocked.expect("state refusal");
    for key in [b"\r".as_slice(), b"q", b"\x03", b"\x04"] {
        let mut child = PtyChild::spawn(&input, None);
        assert!(
            child.wait_for(&PtyChild::marker("ready")),
            "{}",
            String::from_utf8_lossy(&child.seen)
        );
        child.send(key);
        assert!(child.wait_for(&PtyChild::marker(&format!("blocked;{}", code.as_str()))));
        let accepted = PtyChild::marker("accepted");
        assert!(
            !child
                .seen
                .windows(accepted.len())
                .any(|window| window == accepted)
        );
        child.child.wait().expect("blocked child exits");
    }
    assert!(!missing.exists());
}

#[test]
fn mismatched_preview_token_becomes_blocked_before_diff_is_drawn() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("plain.txt");
    std::fs::write(&target, b"old\n").expect("write target");
    let mut input = prepare(
        dir.path(),
        "edit",
        json!({
            "path": target,
            "edits": [{"oldText": "old", "newText": "new", "expectedMatches": 1}],
            "reason": "update text"
        }),
        None,
    );
    input.preview_etag = "h:AAAAAAAAAAAAAAAAAAAAAA".to_owned();
    let mut child = PtyChild::spawn(&input, None);
    assert!(
        child.wait_for(&PtyChild::marker("ready")),
        "{}",
        String::from_utf8_lossy(&child.seen)
    );
    let screen = String::from_utf8_lossy(&child.seen);
    assert!(screen.contains("cannot be applied"), "{screen}");
    assert!(screen.contains("conflict"), "{screen}");
    assert!(!screen.contains("Masked unified diff:"), "{screen}");
    child.send(b"q");
    assert!(child.wait_for(&PtyChild::marker("blocked;conflict")));
    child.child.wait().expect("mismatch child exits");
    assert_eq!(std::fs::read(&target).expect("read target"), b"old\n");
}
