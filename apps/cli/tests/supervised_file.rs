#![cfg(unix)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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
        builder.env(
            "WSMP_SUPERVISED_FILE_ROOTS",
            serde_json::to_string(&input.roots).expect("roots snapshot"),
        );
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

fn canonical_root(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().expect("canonical tempdir")
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
    let root = canonical_root(&dir);
    let target = root.join("settings.txt");
    let before = include_bytes!("fixtures/masking/supervised-file.txt");
    std::fs::write(&target, before).expect("write target");
    let input = prepare(
        &root,
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
    assert!(
        screen.contains("Unified diff (disk content masked):"),
        "{screen}"
    );
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
    let root = canonical_root(&dir);
    let missing = root.join("missing.txt");
    let input = prepare(
        &root,
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
    let root = canonical_root(&dir);
    let target = root.join("plain.txt");
    std::fs::write(&target, b"old\n").expect("write target");
    let mut input = prepare(
        &root,
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
    assert!(
        !screen.contains("Unified diff (disk content masked):"),
        "{screen}"
    );
    child.send(b"q");
    assert!(child.wait_for(&PtyChild::marker("blocked;conflict")));
    child.child.wait().expect("mismatch child exits");
    assert_eq!(std::fs::read(&target).expect("read target"), b"old\n");
}

#[test]
fn gap_real_child_decline_keys_apply_nothing_for_all_five_operations() {
    use std::os::unix::fs::PermissionsExt;

    for op in ["edit", "write", "rename", "mkdir", "delete"] {
        for key in [b'q', 3, 4] {
            let dir = tempfile::tempdir().unwrap();
            let root = canonical_root(&dir);
            let source = root.join("source");
            let destination = root.join("destination");
            std::fs::write(&source, b"old\n").unwrap();
            let (args, body) = match op {
                "edit" => (
                    json!({"path":source,"edits":[{"oldText":"old","newText":"new"}]}),
                    None,
                ),
                "write" => (json!({"path":destination}), Some(b"new\n".to_vec())),
                "rename" => (json!({"from":source,"to":destination}), None),
                "mkdir" => (json!({"path":destination,"parents":false}), None),
                _ => (json!({"path":source}), None),
            };
            let input = prepare(&root, op, args, body.clone());
            assert_eq!(input.blocked, None, "{op}");
            let body_dir = tempfile::tempdir().unwrap();
            std::fs::set_permissions(body_dir.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            let body_path = body.map(|bytes| {
                let path = body_dir.path().join("body");
                std::fs::write(&path, bytes).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
                path
            });
            let mut child = PtyChild::spawn(&input, body_path.as_deref());
            assert!(child.wait_for(&PtyChild::marker("ready")), "{op} key={key}");
            child.send(&[key]);
            assert!(child.wait_for(b"Declined."), "{op} key={key}");
            child.child.wait().expect("declined child exits");
            assert!(
                !child
                    .seen
                    .windows(PtyChild::marker("accepted").len())
                    .any(|part| part == PtyChild::marker("accepted")),
                "{op} key={key}"
            );
            assert_eq!(std::fs::read(&source).unwrap(), b"old\n");
            assert!(!destination.exists(), "{op} key={key}");
            assert_eq!(
                std::fs::read_dir(dir.path()).unwrap().count(),
                1,
                "temporary file leaked"
            );
            assert_eq!(
                std::fs::read_dir(body_dir.path()).unwrap().count(),
                0,
                "private body leaked"
            );
        }
    }
}

#[test]
fn oversized_real_child_blocks_after_dismissal_without_accepting_or_writing() {
    let dir = tempfile::tempdir().unwrap();
    let root = canonical_root(&dir);
    let target = root.join("plain.txt");
    std::fs::write(&target, b"old\n").unwrap();
    let input = prepare(
        &root,
        "edit",
        json!({"path":target,"edits":[{"oldText":"old","newText":"padding".repeat(1500)}]}),
        None,
    );
    assert_eq!(input.blocked, Some(wsmp::file_ops::ErrorCode::TooLarge));
    let mut child = PtyChild::spawn(&input, None);
    assert!(child.wait_for(&PtyChild::marker("ready")));
    let screen = String::from_utf8_lossy(&child.seen);
    assert!(screen.contains("cannot be applied"), "{screen}");
    assert!(screen.contains("too_large"), "{screen}");
    child.send(b"\r");
    assert!(child.wait_for(&PtyChild::marker("blocked;too_large")));
    assert!(
        !child
            .seen
            .windows(PtyChild::marker("accepted").len())
            .any(|part| part == PtyChild::marker("accepted"))
    );
    child.child.wait().expect("blocked child exits");
    assert_eq!(std::fs::read(&target).unwrap(), b"old\n");
}

#[test]
fn canonical_fixture_root_handles_a_symlinked_temp_base() {
    let base = tempfile::tempdir().unwrap();
    let alias = base.path().join("alias");
    std::os::unix::fs::symlink(base.path(), &alias).unwrap();
    let dir = tempfile::Builder::new().tempdir_in(&alias).unwrap();
    let root = canonical_root(&dir);
    let target = root.join("plain.txt");
    std::fs::write(&target, "old\n").unwrap();
    let input = prepare(
        &root,
        "edit",
        json!({"path":target,"edits":[{"oldText":"old","newText":"new"}]}),
        None,
    );
    assert_eq!(input.blocked, None);
    assert_eq!(root, dir.path().canonicalize().unwrap());
}

#[test]
fn real_child_blocks_carried_masked_bytes_before_drawing_any_diff() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/masking/consent-provenance.json")).unwrap();
    for row in rows.iter().filter(|row| row["blocked"] == true) {
        let name = row["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root(&dir);
        let target = root.join("plain.txt");
        let before = row["before"].as_str().unwrap();
        std::fs::write(&target, before).unwrap();
        let mut input = prepare(
            &root,
            "edit",
            json!({"path":target,"expectedEtag":etag(&root, &target),"edits":row["edits"]}),
            None,
        );
        // Do not let the daemon's blocked hint make this test pass: the real
        // child must independently enforce the provenance rule from disk.
        input.blocked = None;
        let mut child = PtyChild::spawn(&input, None);
        assert!(child.wait_for(&PtyChild::marker("ready")), "{name}");
        let screen = String::from_utf8_lossy(&child.seen);
        assert!(screen.contains("cannot be applied"), "{name}: {screen}");
        assert!(screen.contains("redacted_span"), "{name}: {screen}");
        assert!(!screen.contains("Unified diff"), "{name}: {screen}");
        child.send(b"\r");
        assert!(
            child.wait_for(&PtyChild::marker("blocked;redacted_span")),
            "{name}"
        );
        assert!(
            !child
                .seen
                .windows(PtyChild::marker("accepted").len())
                .any(|part| part == PtyChild::marker("accepted")),
            "{name}"
        );
        child.child.wait().unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), before, "{name}");
    }
}

fn etag(root: &Path, target: &Path) -> String {
    let ops = FileOps::new(
        Policy::from_environment(vec![root.to_owned()], true),
        EtagKey::from_bytes([9; 32]),
    );
    ops.stat(
        &serde_json::from_value(json!({"paths":[target],"hash":true})).expect("stat args"),
        &Cancel::new(),
    )
    .expect("stat target")
    .entries
    .into_iter()
    .next()
    .expect("stat entry")
    .etag
    .expect("strong etag")
}

#[test]
fn real_child_configured_root_table_waits_for_keypress_with_matching_codes() {
    use std::os::unix::fs::PermissionsExt;
    for state in ["alias", "real", "outside", "escape", "removed", "long"] {
        if state == "long" && !cfg!(target_os = "linux") {
            continue;
        }
        for op in [
            "edit",
            "write",
            "delete",
            "mkdir",
            "rename-from",
            "rename-to",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let base = canonical_root(&dir);
            let root = base.join("root");
            let outside = base.join("outside");
            std::fs::create_dir(&root).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(root.join("source"), b"old\n").unwrap();
            std::fs::write(outside.join("source"), b"outside private context\n").unwrap();
            std::os::unix::fs::symlink(&root, base.join("alias")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
            let ops = FileOps::new(
                Policy::from_environment(
                    if state == "long" {
                        Vec::new()
                    } else {
                        vec![root.clone()]
                    },
                    true,
                ),
                EtagKey::from_bytes([9; 32]),
            );
            if state == "removed" {
                std::fs::remove_dir_all(&root).unwrap();
            }
            if state == "long" {
                let suffix = (0..15)
                    .map(|_| "a".repeat(240))
                    .collect::<Vec<_>>()
                    .join("/");
                for i in 0..39 {
                    std::os::unix::fs::symlink(
                        format!("link{}/{suffix}", i + 1),
                        root.join(format!("link{i}")),
                    )
                    .unwrap();
                }
            }
            let path = match state {
                "alias" => base.join("alias"),
                "outside" => outside.clone(),
                "escape" => root.join("escape"),
                "long" => root.join("link0"),
                _ => root.clone(),
            };
            let (operation, args, body) = match op {
                "edit" => (
                    "edit",
                    json!({"path":path.join("source"),"edits":[{"oldText":"old","newText":"new"}]}),
                    None,
                ),
                "write" => (
                    "write",
                    json!({"path":path.join("target")}),
                    Some(b"new\n".to_vec()),
                ),
                "delete" => ("delete", json!({"path":path.join("source")}), None),
                "mkdir" => ("mkdir", json!({"path":path.join("target")}), None),
                "rename-from" => (
                    "rename",
                    json!({"from":path.join("source"),"to":root.join("target")}),
                    None,
                ),
                _ => (
                    "rename",
                    json!({"from":root.join("source"),"to":path.join("target")}),
                    None,
                ),
            };
            let prepared = ops
                .prepare_supervised(
                    operation,
                    args,
                    body.clone(),
                    &EtagKey::from_bytes(PREVIEW_KEY),
                    &Cancel::new(),
                )
                .unwrap();
            let body_dir = tempfile::tempdir().unwrap();
            std::fs::set_permissions(body_dir.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            let body_file = body.as_ref().map(|bytes| {
                let path = body_dir.path().join("body");
                std::fs::write(&path, bytes).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
                path
            });
            let mut child = PtyChild::spawn(prepared.child_input(), body_file.as_deref());
            assert!(
                child.wait_for(&PtyChild::marker("ready")),
                "{state} {op}: {}",
                String::from_utf8_lossy(&child.seen)
            );
            assert!(
                !child
                    .seen
                    .windows(PtyChild::marker("accepted").len())
                    .any(|w| w == PtyChild::marker("accepted"))
            );
            assert!(!root.join("target").exists());
            assert!(!outside.join("target").exists());
            assert_eq!(
                std::fs::read(outside.join("source")).unwrap(),
                b"outside private context\n"
            );
            if matches!(state, "alias" | "real") {
                assert_eq!(prepared.child_input().blocked, None);
                assert!(!String::from_utf8_lossy(&child.seen).contains("Error code:"));
                child.send(b"q");
                assert!(child.wait_for(b"Declined."), "{state} {op}");
                assert_eq!(std::fs::read(root.join("source")).unwrap(), b"old\n");
            } else {
                let code = if state == "long" {
                    wsmp::file_ops::ErrorCode::TooLarge
                } else {
                    wsmp::file_ops::ErrorCode::PathDenied
                };
                assert_eq!(prepared.child_input().blocked, Some(code));
                let code = code.as_str();
                let text = String::from_utf8_lossy(&child.seen);
                assert!(
                    text.contains(&format!("Error code: {code}")),
                    "{state} {op}: {text}"
                );
                assert!(!text.contains("outside private context"));
                assert!(
                    !child
                        .seen
                        .windows(PtyChild::marker(&format!("blocked;{code}")).len())
                        .any(|w| w == PtyChild::marker(&format!("blocked;{code}")))
                );
                child.send(b"\r");
                assert!(
                    child.wait_for(&PtyChild::marker(&format!("blocked;{code}"))),
                    "{state} {op}"
                );
            }
        }
    }
}

#[test]
fn real_child_missing_root_snapshot_has_no_unrestricted_default() {
    let mut cmd = assert_cmd::Command::cargo_bin("wsmp").unwrap();
    cmd.args(["terminal", "supervised-file"])
        .env("WSMP_SUPERVISED_FILE_OP", "mkdir")
        .env("WSMP_SUPERVISED_FILE_ARGS", r#"{"path":"/tmp/unused"}"#)
        .env_remove("WSMP_SUPERVISED_FILE_ROOTS");
    let output = cmd.output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("WSMP_SUPERVISED_FILE_ROOTS"));
}
