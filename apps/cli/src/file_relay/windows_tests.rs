//! The read file tools on Windows, through the relay: POSIX-view paths in and
//! out, writes refused before they run, names that alias another object
//! refused, protected files refused by path and by identity, and links out of
//! the roots neither followed nor walked into.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};

use super::*;
use crate::file_ops::policy::{Deny, Protected};

const WAIT: Duration = Duration::from_secs(10);

fn op_id(n: u8) -> String {
    URL_SAFE_NO_PAD.encode([n; 16])
}

struct Fixture {
    _dir: tempfile::TempDir,
    /// The root, physical (`\\?\C:\...`).
    root: PathBuf,
    /// Outside the root, beside it.
    outside: PathBuf,
    relay: FileRelay,
    rx: Receiver<(String, Vec<FileFrame>)>,
}

/// A root with `notes.txt`, `sub/deep.txt`, `.hidden` and a protected
/// `guarded.txt`; a sibling directory outside the root holds `secret.txt`.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("dir");
    let base = std::fs::canonicalize(dir.path()).expect("canonical");
    let root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir_all(root.join("sub")).expect("root");
    std::fs::create_dir_all(&outside).expect("outside");
    std::fs::write(root.join("notes.txt"), "alpha\r\nneedle beta\r\n").expect("notes");
    std::fs::write(root.join("sub").join("deep.txt"), "needle deep\n").expect("deep");
    std::fs::write(root.join(".hidden"), "h\n").expect("hidden");
    std::fs::write(root.join("guarded.txt"), "guarded\n").expect("guarded");
    std::fs::write(outside.join("secret.txt"), "needle secret\n").expect("secret");
    let protected = vec![Protected {
        path: root.join("guarded.txt"),
        subtree: false,
        deny: Deny::ReadWrite,
    }];
    let policy = Policy::new(vec![root.clone()], protected, false).with_euid(1);
    let runtime = Arc::new(FileRuntime::new(FileOps::new(policy, EtagKey::random())));
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let sink: FileSink = Arc::new(move |op_id, frames| {
        let _ = tx.lock().expect("sink").send((op_id, frames));
    });
    Fixture {
        _dir: dir,
        root,
        outside,
        relay: FileRelay::new(runtime, true, sink),
        rx,
    }
}

fn view(path: &Path) -> String {
    crate::file_ops::display_path(path).expect("a drive path")
}

impl Fixture {
    /// Runs one op and returns its one control frame.
    fn run(&mut self, n: u8, op: &str, args: Value) -> Value {
        let refused = self.relay.handle_op(&op_id(n), op, args, None);
        let frames = if refused.is_empty() {
            let (id, frames) = self.rx.recv_timeout(WAIT).expect("op settles");
            assert_eq!(id, op_id(n));
            assert!(self.relay.complete(&id));
            frames
        } else {
            refused
        };
        assert_eq!(frames.len(), 1, "{frames:?}");
        match &frames[0] {
            FileFrame::Control(message) => serde_json::to_value(message).expect("json"),
            FileFrame::Binary(..) => panic!("expected a control frame"),
        }
    }
}

fn refusal(frame: &Value) -> &str {
    assert_eq!(frame["type"], "file.rejected", "{frame}");
    frame["reason"].as_str().expect("reason")
}

#[test]
fn roots_and_paths_are_shown_in_the_posix_view() {
    let fx = fixture();
    let shown = view(&fx.root);
    assert!(shown.starts_with('/'), "{shown}");
    assert_eq!(&shown[2..3], "/");
    assert!(shown[1..2].chars().all(|c| c.is_ascii_lowercase()));
    assert!(!shown.contains('\\'));
}

#[test]
fn a_read_serves_the_file_with_its_etag() {
    let mut fx = fixture();
    let path = format!("{}/notes.txt", view(&fx.root));
    let frame = fx.run(1, "read", json!({ "path": path }));
    assert_eq!(frame["type"], "file.result", "{frame}");
    assert_eq!(frame["result"]["text"], "1|alpha\n2|needle beta");
    assert_eq!(frame["result"]["eol"], "crlf");
    let etag = frame["result"]["etag"].as_str().expect("etag").to_string();
    assert!(etag.starts_with("h:"));
    assert!(frame["result"].get("resolvedPath").is_none(), "{frame}");
    // Unchanged on a re-read with its etag.
    let frame = fx.run(2, "read", json!({ "path": path, "ifNoneMatch": etag }));
    assert_eq!(frame["result"]["unchanged"], true, "{frame}");
    // A spelling in another case is the same file, echoed in its real case.
    let upper = path.to_uppercase().replacen("/C/", "/c/", 1);
    let upper = format!("/{}", &upper[1..]);
    let frame = fx.run(3, "read", json!({ "path": upper }));
    assert_eq!(frame["type"], "file.result", "{frame}");
}

#[test]
fn stat_list_and_search_answer_in_the_posix_view() {
    let mut fx = fixture();
    let root = view(&fx.root);
    let frame = fx.run(
        1,
        "stat",
        json!({ "paths": [format!("{root}/notes.txt"), format!("{root}/sub"), format!("{root}/nope")], "hash": true }),
    );
    let entries = frame["result"]["entries"].as_array().expect("entries");
    assert_eq!(entries[0]["type"], "file", "{frame}");
    assert_eq!(entries[0]["size"], 20);
    assert!(
        entries[0]["etag"]
            .as_str()
            .is_some_and(|e| e.starts_with("h:"))
    );
    assert!(entries[0].get("owner").is_none());
    assert_eq!(entries[1]["type"], "dir");
    assert_eq!(entries[2]["error"], "not_found");

    let frame = fx.run(2, "list", json!({ "path": root, "depth": 2 }));
    let listing = frame["result"]["entries"].as_str().expect("entries");
    assert!(listing.contains(&format!("{root}/notes.txt")), "{listing}");
    assert!(listing.contains(&format!("d {root}/sub/")), "{listing}");
    assert!(
        listing.contains(&format!("{root}/sub/deep.txt")),
        "{listing}"
    );
    assert!(!listing.contains(".hidden"), "{listing}");
    assert!(!listing.contains('\\'), "{listing}");

    let frame = fx.run(3, "search", json!({ "root": root, "pattern": "needle" }));
    let matches = frame["result"]["matches"].as_str().expect("matches");
    assert!(
        matches.contains(&format!("{root}/notes.txt:2|needle beta")),
        "{matches}"
    );
    assert!(
        matches.contains(&format!("{root}/sub/deep.txt:1|needle deep")),
        "{matches}"
    );
    assert!(!matches.contains("secret"), "{matches}");
}

#[test]
fn every_write_op_is_refused_before_it_runs() {
    let mut fx = fixture();
    let root = view(&fx.root);
    for (n, op, args) in [
        (
            1,
            "edit",
            json!({ "path": format!("{root}/notes.txt"), "oldText": "alpha", "newText": "x" }),
        ),
        (
            2,
            "rename",
            json!({ "from": format!("{root}/notes.txt"), "to": format!("{root}/n.txt") }),
        ),
        (3, "mkdir", json!({ "path": format!("{root}/new") })),
        (4, "delete", json!({ "path": format!("{root}/notes.txt") })),
    ] {
        assert_eq!(refusal(&fx.run(n, op, args)), "unsupported", "{op}");
    }
    let refused = fx.relay.handle_op(
        &op_id(5),
        "write",
        json!({ "path": format!("{root}/w.txt") }),
        Some(3),
    );
    assert_eq!(refused.len(), 1);
    assert!(fx.root.join("notes.txt").exists());
    assert!(!fx.root.join("new").exists() && !fx.root.join("w.txt").exists());
}

#[test]
fn names_that_alias_another_object_and_paths_outside_are_refused() {
    let mut fx = fixture();
    let root = view(&fx.root);
    let outside = view(&fx.outside);
    let error = |frame: &Value| {
        assert_eq!(frame["type"], "file.rejected", "{frame}");
        frame["reason"].as_str().expect("reason").to_string()
    };
    for (n, path, expected) in [
        (1, format!("{root}/notes.txt:stream"), "invalid_input"),
        (2, format!("{root}/sub/../notes.txt"), "invalid_input"),
        (3, format!("{root}/NUL"), "invalid_input"),
        (4, format!("{root}/notes.txt."), "invalid_input"),
        (5, format!("{outside}/secret.txt"), "path_denied"),
        (6, root.replacen('/', "", 1), "invalid_input"),
    ] {
        assert_eq!(
            error(&fx.run(n, "read", json!({ "path": path }))),
            expected,
            "{path}"
        );
    }
}

#[test]
fn a_protected_file_is_refused_by_name_and_through_a_hard_link() {
    let mut fx = fixture();
    let root = view(&fx.root);
    let frame = fx.run(1, "read", json!({ "path": format!("{root}/guarded.txt") }));
    assert_eq!(refusal(&frame), "path_denied");
    std::fs::hard_link(fx.root.join("guarded.txt"), fx.root.join("alias.txt")).expect("link");
    let frame = fx.run(2, "read", json!({ "path": format!("{root}/alias.txt") }));
    assert_eq!(refusal(&frame), "path_denied");
    let frame = fx.run(3, "search", json!({ "root": root, "pattern": "guarded" }));
    assert_eq!(frame["result"]["count"], 0, "{frame}");
}

#[test]
fn a_junction_out_of_the_root_is_neither_followed_nor_walked() {
    let mut fx = fixture();
    let link = fx.root.join("door");
    let made = std::process::Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&fx.outside)
        .output()
        .expect("mklink");
    assert!(made.status.success(), "{made:?}");
    let root = view(&fx.root);
    let frame = fx.run(
        1,
        "read",
        json!({ "path": format!("{root}/door/secret.txt") }),
    );
    assert_eq!(refusal(&frame), "path_denied");
    let frame = fx.run(2, "list", json!({ "path": root, "depth": 3 }));
    let listing = frame["result"]["entries"].as_str().expect("entries");
    assert!(listing.contains(&format!("l {root}/door ->")), "{listing}");
    assert!(!listing.contains("secret"), "{listing}");
    let frame = fx.run(3, "search", json!({ "root": root, "pattern": "secret" }));
    assert_eq!(frame["result"]["count"], 0, "{frame}");
    let frame = fx.run(4, "stat", json!({ "paths": [format!("{root}/door")] }));
    assert_eq!(frame["result"]["entries"][0]["type"], "symlink", "{frame}");
    // Its target lies outside the root: reported, not followed.
    assert_eq!(
        frame["result"]["entries"][0]["targetType"], "denied",
        "{frame}"
    );
}
