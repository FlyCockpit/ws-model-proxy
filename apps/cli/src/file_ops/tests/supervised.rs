use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use super::super::supervised::SupervisedPreview;
use super::super::{Cancel, ErrorCode, EtagKey, FileOps, Policy, Step};
use super::{Fx, code};
use crate::file_ops::mutate::{RenameAtomicCapability, supervised_overwrite_supported};

fn key() -> EtagKey {
    EtagKey::from_bytes([19; 32])
}

fn prepare(
    fx: &Fx,
    op: &str,
    args: Value,
    body: Option<Vec<u8>>,
) -> super::super::PreparedSupervised {
    fx.ops
        .prepare_supervised(op, args, body, &key(), &fx.cancel)
        .expect("prepare")
}

#[test]
fn previews_every_operation_without_mutating_and_child_recomputes_the_token() {
    let fx = Fx::new();
    fx.put("edit.txt", "before\n");
    fx.put("write.txt", "old\n");
    fx.put("rename.txt", "move\n");
    fx.put("delete.txt", "remove\n");
    let edit_etag = fx.etag("edit.txt");
    let write_etag = fx.etag("write.txt");
    let rows = [
        (
            "edit",
            json!({"path": fx.p("edit.txt"), "expectedEtag": edit_etag, "edits": [{"oldText":"before", "newText":"after"}]}),
            None,
        ),
        (
            "write",
            json!({"path": fx.p("write.txt"), "ifExists":"replace", "expectedEtag": write_etag}),
            Some(b"new\n".to_vec()),
        ),
        (
            "rename",
            json!({"from": fx.p("rename.txt"), "to": fx.p("renamed.txt")}),
            None,
        ),
        (
            "mkdir",
            json!({"path": fx.p("new/child"), "parents":true}),
            None,
        ),
        ("delete", json!({"path": fx.p("delete.txt")}), None),
    ];
    for (op, args, body) in rows {
        let prepared = prepare(&fx, op, args, body.clone());
        assert_eq!(prepared.child_input().blocked, None, "{op}");
        let child = prepared.child_input().clone();
        let preview = fx
            .ops
            .preview_supervised(op, child.args, body.as_deref(), &key(), &fx.cancel)
            .expect("child preview");
        assert_eq!(preview.preview_etag(), child.preview_etag, "{op}");
        assert!(
            matches!(&preview, SupervisedPreview::Allowed(_)),
            "{op}: {preview:?}"
        );
    }
    assert_eq!(fx.get("edit.txt"), "before\n");
    assert_eq!(fx.get("write.txt"), "old\n");
    assert!(fx.root.join("rename.txt").exists());
    assert!(!fx.root.join("renamed.txt").exists());
    assert!(
        !fx.root.join("new").exists(),
        "preview must not create parents"
    );
    assert!(fx.root.join("delete.txt").exists());
}

#[test]
fn apply_uses_prepared_body_and_missing_parent_snapshot() {
    let fx = Fx::new();
    let prepared = prepare(
        &fx,
        "write",
        json!({"path": fx.p("a/b/new.txt"), "makeParents":true}),
        Some(b"approved\n".to_vec()),
    );
    assert!(!fx.root.join("a").exists());
    fx.ops
        .execute_supervised(prepared, &fx.cancel)
        .expect("apply");
    assert_eq!(fx.get("a/b/new.txt"), "approved\n");
}

#[test]
fn prepared_create_refuses_a_parent_that_appeared_after_preview() {
    let fx = Fx::new();
    let prepared = prepare(
        &fx,
        "write",
        json!({"path": fx.p("a/b/new.txt"), "makeParents":true}),
        Some(b"approved\n".to_vec()),
    );
    std::fs::create_dir(fx.root.join("a")).unwrap();
    assert_eq!(
        code(fx.ops.execute_supervised(prepared, &fx.cancel)),
        ErrorCode::Conflict
    );
    assert!(!fx.root.join("a/b/new.txt").exists());
}

#[test]
fn prepared_edit_refuses_changed_content_and_leaves_it_unchanged() {
    let fx = Fx::new();
    fx.put("f.txt", "one\n");
    let prepared = prepare(
        &fx,
        "edit",
        json!({"path": fx.p("f.txt"), "expectedEtag":fx.etag("f.txt"), "edits":[{"oldText":"one", "newText":"approved"}]}),
        None,
    );
    fx.put("f.txt", "raced\n");
    assert_eq!(
        code(fx.ops.execute_supervised(prepared, &fx.cancel)),
        ErrorCode::Conflict
    );
    assert_eq!(fx.get("f.txt"), "raced\n");
}

#[test]
fn agent_etag_and_state_errors_are_blocked_not_pre_display_errors() {
    let fx = Fx::new();
    fx.put("f.txt", "one\n");
    let cases = [
        (
            "edit",
            json!({"path":fx.p("f.txt"), "expectedEtag":"h:wrong", "edits":[{"oldText":"one", "newText":"two"}]}),
            ErrorCode::Conflict,
        ),
        (
            "delete",
            json!({"path":fx.p("missing")}),
            ErrorCode::NotFound,
        ),
        ("mkdir", json!({"path":fx.p("f.txt")}), ErrorCode::Exists),
    ];
    for (op, args, expected) in cases {
        let prepared = prepare(&fx, op, args, None);
        assert_eq!(prepared.child_input().blocked, Some(expected), "{op}");
    }
}

#[test]
fn create_collision_remains_exists_on_the_independent_child_preview() {
    let fx = Fx::new();
    fx.put("exists.txt", "unchanged\n");
    let prepared = prepare(
        &fx,
        "write",
        json!({"path":fx.p("exists.txt")}),
        Some(b"new\n".to_vec()),
    );
    let child = prepared.child_input();
    assert_eq!(child.blocked, Some(ErrorCode::Exists));
    assert!(child.args["expectedEtag"].is_null());
    let preview = fx
        .ops
        .preview_supervised(
            "write",
            child.args.clone(),
            Some(b"new\n"),
            &key(),
            &fx.cancel,
        )
        .expect("child preview");
    assert!(matches!(
        preview,
        SupervisedPreview::Blocked {
            code: ErrorCode::Exists,
            ..
        }
    ));
    assert_eq!(preview.preview_etag(), child.preview_etag);
    assert_eq!(fx.get("exists.txt"), "unchanged\n");
}

#[test]
fn apply_rechecks_root_roots_and_protected_policy_for_every_operation() {
    use super::super::policy::{Deny, Protected};

    for op in ["edit", "write", "rename", "mkdir", "delete"] {
        for refusal in [ErrorCode::Unsupported, ErrorCode::PathDenied] {
            for protected in [false, true] {
                let fx = Fx::new();
                fx.put("source", "old\n");
                let (args, body) = match op {
                    "edit" => (
                        json!({"path": fx.p("source"), "edits": [{"oldText":"old", "newText":"new"}]}),
                        None,
                    ),
                    "write" => (json!({"path": fx.p("created")}), Some(b"new\n".to_vec())),
                    "rename" => (json!({"from": fx.p("source"), "to": fx.p("created")}), None),
                    "mkdir" => (json!({"path": fx.p("created"), "parents": false}), None),
                    "delete" => (json!({"path": fx.p("source")}), None),
                    _ => unreachable!(),
                };
                let prepared = prepare(&fx, op, args, body);
                assert!(prepared.child_input().blocked.is_none(), "{op}");
                let policy = match refusal {
                    ErrorCode::Unsupported => Policy::new(vec![], vec![], false).with_euid(0),
                    _ if protected => Policy::new(
                        vec![],
                        vec![Protected {
                            path: fx.root.clone(),
                            subtree: true,
                            deny: Deny::ReadWrite,
                        }],
                        true,
                    ),
                    _ => Policy::new(vec![fx.root.join("outside")], vec![], true),
                };
                let denied_ops = FileOps::new(policy, EtagKey::from_bytes([7; 32]));
                assert_eq!(
                    code(denied_ops.execute_supervised(prepared, &fx.cancel)),
                    refusal,
                    "{op} protected={protected}"
                );
                assert_eq!(fx.get("source"), "old\n");
                assert!(!fx.root.join("created").exists());
            }
        }
    }
}

#[test]
fn secret_scopes_are_refused_for_every_operation_and_both_rename_sides() {
    let secret_paths = [
        ".env",
        "id_rsa",
        ".ssh/id_rsa",
        ".cache/huggingface/token",
        ".huggingface/token",
        ".ssh/nested/plain.txt",
    ];
    let operations = [
        "edit",
        "write",
        "mkdir",
        "delete",
        "rename-from",
        "rename-to",
    ];
    let mut reached_display = Vec::new();

    for secret_path in secret_paths {
        for operation in operations {
            let fx = Fx::new();
            let (op, args, body) = match operation {
                "edit" => {
                    fx.put(secret_path, "before\n");
                    (
                        "edit",
                        json!({"path":fx.p(secret_path), "edits":[{"oldText":"before", "newText":"after"}]}),
                        None,
                    )
                }
                "write" => (
                    "write",
                    json!({"path":fx.p(secret_path), "makeParents":true}),
                    Some(b"after\n".to_vec()),
                ),
                "mkdir" => (
                    "mkdir",
                    json!({"path":fx.p(secret_path), "parents":true}),
                    None,
                ),
                "delete" => {
                    fx.put(secret_path, "before\n");
                    ("delete", json!({"path":fx.p(secret_path)}), None)
                }
                "rename-from" => {
                    fx.put(secret_path, "before\n");
                    (
                        "rename",
                        json!({"from":fx.p(secret_path), "to":fx.p("plain-destination.txt")}),
                        None,
                    )
                }
                "rename-to" => {
                    fx.put("plain-source.txt", "before\n");
                    std::fs::create_dir_all(
                        fx.root
                            .join(secret_path)
                            .parent()
                            .expect("secret path has a parent"),
                    )
                    .expect("destination parent");
                    (
                        "rename",
                        json!({"from":fx.p("plain-source.txt"), "to":fx.p(secret_path)}),
                        None,
                    )
                }
                _ => unreachable!(),
            };

            match fx
                .ops
                .prepare_supervised(op, args, body, &key(), &fx.cancel)
            {
                Err(error) => assert_eq!(
                    error.code,
                    ErrorCode::SecretFile,
                    "{operation} against {secret_path}"
                ),
                Ok(prepared) => reached_display.push(format!(
                    "{operation} against {secret_path}: {:?}",
                    prepared.child_input().blocked
                )),
            }
        }
    }
    assert!(
        reached_display.is_empty(),
        "secret scopes reached display preparation: {reached_display:#?}"
    );
}

#[test]
fn root_policy_is_checked_before_preview_for_every_operation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("edit.txt"), "before\n").unwrap();
    std::fs::write(root.join("rename-source.txt"), "before\n").unwrap();
    std::fs::write(root.join("delete.txt"), "before\n").unwrap();
    let policy = Policy::new(vec![], vec![], false).with_euid(0);
    let ops = FileOps::new(policy, EtagKey::from_bytes([7; 32]));
    let rows = [
        (
            "edit",
            json!({"path":root.join("edit.txt"), "edits":[{"oldText":"before", "newText":"after"}]}),
            None,
        ),
        (
            "write",
            json!({"path":root.join("write.txt")}),
            Some(b"after\n".to_vec()),
        ),
        (
            "rename",
            json!({"from":root.join("rename-source.txt"), "to":root.join("rename-destination.txt")}),
            None,
        ),
        ("mkdir", json!({"path":root.join("new-directory")}), None),
        ("delete", json!({"path":root.join("delete.txt")}), None),
    ];

    for (op, args, body) in rows {
        assert_eq!(
            code(ops.prepare_supervised(op, args, body, &key(), &Cancel::new())),
            ErrorCode::Unsupported,
            "{op}"
        );
    }
}

#[test]
fn supervised_replace_rechecks_after_the_last_hook() {
    let changed = Arc::new(AtomicBool::new(false));
    let changed_hook = Arc::clone(&changed);
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("f.txt");
    std::fs::write(&path, "before\n").expect("fixture");
    let hook_path = path.clone();
    let policy = super::super::Policy::new(vec![], vec![], true);
    let ops = super::super::FileOps::new(policy, EtagKey::from_bytes([7; 32])).with_step_hook(
        Arc::new(move |step| {
            if step == Step::EtagRechecked && !changed_hook.swap(true, Ordering::SeqCst) {
                std::fs::write(&hook_path, "raced\n").expect("race write");
            }
            Ok(())
        }),
    );
    let cancel = Cancel::new();
    let etag = match ops
        .read(
            &serde_json::from_value(json!({"path":path})).unwrap(),
            &cancel,
        )
        .unwrap()
    {
        super::super::read::ReadOutcome::Content(result) => result.etag,
        _ => unreachable!(),
    };
    let prepared = ops
        .prepare_supervised(
            "edit",
            json!({"path":path, "expectedEtag":etag, "edits":[{"oldText":"before", "newText":"approved"}]}),
            None,
            &key(),
            &cancel,
        )
        .unwrap();
    let error = ops.execute_supervised(prepared, &cancel).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "raced\n");
}

#[test]
fn invalid_shape_is_rejected_before_any_state_lookup() {
    let fx = Fx::new();
    let error = fx
        .ops
        .prepare_supervised(
            "delete",
            json!({"path":fx.p("missing/parent/file"), "diff":"forged"}),
            None,
            &key(),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[test]
fn filesystem_invalid_input_is_blocked_but_invalid_path_strings_are_pre_display_errors() {
    let fx = Fx::new();
    let link = fx.root.join("invalid-target-link");
    std::os::unix::fs::symlink(OsString::from_vec(vec![0xff]), &link).unwrap();
    let args = json!({
        "path":link,
        "edits":[{"oldText":"before", "newText":"after"}]
    });
    let prepared = fx
        .ops
        .prepare_supervised("edit", args, None, &key(), &fx.cancel)
        .expect("filesystem state errors reach the dismissal screen");
    assert_eq!(
        prepared.child_input().blocked,
        Some(ErrorCode::InvalidInput)
    );
    assert!(matches!(
        fx.ops.preview_supervised(
            "edit",
            prepared.child_input().args.clone(),
            None,
            &key(),
            &fx.cancel,
        ),
        Ok(SupervisedPreview::Blocked {
            code: ErrorCode::InvalidInput,
            ..
        })
    ));

    let long = format!("/{}", "x".repeat(4096));
    for path in ["relative/path", "/tmp/nul\0path", &long] {
        let error = fx
            .ops
            .prepare_supervised(
                "edit",
                json!({"path":path, "edits":[{"oldText":"before", "newText":"after"}]}),
                None,
                &key(),
                &fx.cancel,
            )
            .expect_err("invalid request path must be refused before display");
        assert_eq!(error.code, ErrorCode::InvalidInput, "{path:?}");
    }
}

#[test]
fn cancelled_apply_does_not_create_missing_parents() {
    let fx = Fx::new();
    let prepared = prepare(
        &fx,
        "write",
        json!({"path":fx.p("cancelled/child/file"), "makeParents":true}),
        Some(b"x".to_vec()),
    );
    let cancelled = Cancel::new();
    cancelled.cancel();
    assert_eq!(
        code(fx.ops.execute_supervised(prepared, &cancelled)),
        ErrorCode::Cancelled
    );
    assert!(!fx.root.join("cancelled").exists());
}

#[test]
fn hardlinks_and_protected_inode_aliases_are_blocked() {
    let hard = Fx::new();
    hard.put("hard.txt", "x\n");
    std::fs::hard_link(hard.root.join("hard.txt"), hard.root.join("alias.txt")).unwrap();
    let prepared = prepare(
        &hard,
        "edit",
        json!({"path":hard.p("alias.txt"), "edits":[{"oldText":"x", "newText":"y"}]}),
        None,
    );
    assert_eq!(prepared.child_input().blocked, Some(ErrorCode::HardLinked));

    let protected = Fx::with_policy(Fx::protecting(&[(
        "protected.txt",
        super::super::policy::Deny::WriteOnly,
    )]));
    protected.put("protected.txt", "x\n");
    std::fs::hard_link(
        protected.root.join("protected.txt"),
        protected.root.join("innocent-name.txt"),
    )
    .unwrap();
    let prepared = prepare(
        &protected,
        "edit",
        json!({"path":protected.p("innocent-name.txt"), "edits":[{"oldText":"x", "newText":"y"}]}),
        None,
    );
    assert_eq!(prepared.child_input().blocked, Some(ErrorCode::PathDenied));
}

#[test]
fn owner_mismatch_and_undisplayable_binary_are_blocked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.txt");
    std::fs::write(&path, "x\n").unwrap();
    let policy = Policy::new(vec![], vec![], true).with_euid(12345);
    let ops = FileOps::new(policy, EtagKey::from_bytes([7; 32]));
    let prepared = ops
        .prepare_supervised(
            "edit",
            json!({"path":path, "edits":[{"oldText":"x", "newText":"y"}]}),
            None,
            &key(),
            &Cancel::new(),
        )
        .unwrap();
    assert_eq!(
        prepared.child_input().blocked,
        Some(ErrorCode::OwnerMismatch)
    );

    let fx = Fx::new();
    let prepared = prepare(
        &fx,
        "write",
        json!({"path":fx.p("binary.bin")}),
        Some(vec![0, 1, 2]),
    );
    assert_eq!(prepared.child_input().blocked, Some(ErrorCode::BinaryFile));
    assert!(!fx.root.join("binary.bin").exists());
}

#[test]
fn preview_masks_assignment_values_in_plain_files() {
    let fx = Fx::new();
    let fixture = include_str!("../../../tests/fixtures/masking/supervised-file.txt");
    let secret = fixture
        .lines()
        .next()
        .and_then(|line| line.split_once('='))
        .map(|(_, value)| value)
        .expect("fixture assignment");
    fx.put("plain.conf", fixture);
    let prepared = prepare(
        &fx,
        "edit",
        json!({"path":fx.p("plain.conf"), "edits":[{"oldText":"visible=old", "newText":"visible=new"}]}),
        None,
    );
    let child = prepared.child_input();
    let preview = fx
        .ops
        .preview_supervised("edit", child.args.clone(), None, &key(), &fx.cancel)
        .unwrap();
    let SupervisedPreview::Allowed(allowed) = preview else {
        panic!("expected allowed preview: {preview:?}");
    };
    let diff = allowed.diff.join("\n");
    assert!(diff.contains("redacted"), "{diff}");
    assert!(!diff.contains(secret), "{diff}");
}

#[test]
fn new_write_preview_shows_body_assignments_and_leaves_disk_unchanged() {
    let fx = Fx::new();
    let fixture = include_str!("../../../tests/fixtures/masking/supervised-file.txt");
    let secret = fixture
        .lines()
        .next()
        .and_then(|line| line.split_once('='))
        .map(|(_, value)| value)
        .expect("fixture assignment");
    let prepared = prepare(
        &fx,
        "write",
        json!({"path":fx.p("new.conf")}),
        Some(fixture.as_bytes().to_vec()),
    );
    let preview = fx
        .ops
        .preview_supervised(
            "write",
            prepared.child_input().args.clone(),
            Some(fixture.as_bytes()),
            &key(),
            &fx.cancel,
        )
        .expect("preview");
    let SupervisedPreview::Allowed(allowed) = preview else {
        panic!("expected visible write preview");
    };
    let diff = allowed.diff.join("\n");
    assert!(diff.contains("+DEMO_TOKEN="), "{diff}");
    assert!(diff.contains("+masked-adjacent=old"), "{diff}");
    assert!(diff.contains(secret), "{diff}");
    assert!(!fx.root.join("new.conf").exists());
}

#[test]
fn write_preview_blocks_when_diff_bytes_change_after_snapshot() {
    let changed = Arc::new(AtomicBool::new(false));
    let changed_hook = Arc::clone(&changed);
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("f.txt");
    std::fs::write(&path, "pinned\n").expect("fixture");
    let stat = super::super::resolve::Stat::from_metadata(&std::fs::metadata(&path).unwrap());
    let expected_etag = key().strong(&stat, b"pinned\n");
    let hook_path = path.clone();
    let ops = FileOps::new(
        Policy::new(vec![], vec![], true),
        EtagKey::from_bytes([7; 32]),
    )
    .with_step_hook(Arc::new(move |step| {
        if step == Step::SupervisedPreviewRead && !changed_hook.swap(true, Ordering::SeqCst) {
            std::fs::write(&hook_path, "raced\n").expect("race write");
        }
        Ok(())
    }));

    let preview = ops
        .preview_supervised(
            "write",
            json!({"path":path, "ifExists":"replace", "expectedEtag":expected_etag}),
            Some(b"approved\n"),
            &key(),
            &Cancel::new(),
        )
        .expect("state races reach the dismissal screen");
    assert!(
        changed.load(Ordering::SeqCst),
        "preview seam was not exercised"
    );
    assert!(matches!(
        preview,
        SupervisedPreview::Blocked {
            code: ErrorCode::Conflict,
            ..
        }
    ));
}

#[test]
fn snapshot_derives_both_etags_from_the_same_buffered_bytes() {
    let changed = Arc::new(AtomicBool::new(false));
    let changed_hook = Arc::clone(&changed);
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("f.txt");
    std::fs::write(&path, "pinned\n").expect("fixture");
    let daemon_key = EtagKey::from_bytes([7; 32]);
    let stat = super::super::resolve::Stat::from_metadata(&std::fs::metadata(&path).unwrap());
    let daemon_etag = daemon_key.strong(&stat, b"pinned\n");
    let hook_path = path.clone();
    let ops = FileOps::new(Policy::new(vec![], vec![], true), daemon_key).with_step_hook(Arc::new(
        move |step| {
            if step == Step::SupervisedSnapshotRead && !changed_hook.swap(true, Ordering::SeqCst) {
                std::fs::write(&hook_path, "raced!\n").expect("race write");
            }
            Ok(())
        },
    ));

    let prepared = ops
        .prepare_supervised(
            "write",
            json!({"path":path, "ifExists":"replace", "expectedEtag":daemon_etag}),
            Some(b"approved\n".to_vec()),
            &key(),
            &Cancel::new(),
        )
        .expect("state races reach the dismissal screen");
    assert!(
        changed.load(Ordering::SeqCst),
        "snapshot seam was not exercised"
    );
    assert_eq!(prepared.child_input().blocked, Some(ErrorCode::Conflict));
    assert_eq!(
        prepared.child_input().args["expectedEtag"],
        key().strong(&stat, b"pinned\n")
    );
}

#[test]
fn rename_pins_destination_absence() {
    let fx = Fx::new();
    fx.put("source.txt", "approved\n");
    let prepared = prepare(
        &fx,
        "rename",
        json!({"from":fx.p("source.txt"), "to":fx.p("destination.txt")}),
        None,
    );
    fx.put("destination.txt", "appeared\n");
    assert_eq!(
        code(fx.ops.execute_supervised(prepared, &fx.cancel)),
        ErrorCode::Conflict
    );
    assert_eq!(fx.get("source.txt"), "approved\n");
    assert_eq!(fx.get("destination.txt"), "appeared\n");
}

#[test]
fn unsupported_platform_blocks_unsafe_rename_previews_without_mutating() {
    for case in ["overwrite", "directory"] {
        let fx = Fx::new();
        fx.ops
            .set_rename_atomic_capability(RenameAtomicCapability::HardLinksOnly);
        let args = if case == "overwrite" {
            fx.put("source.txt", "source\n");
            fx.put("destination.txt", "destination\n");
            json!({
                "from": fx.p("source.txt"),
                "to": fx.p("destination.txt"),
                "overwrite": true,
                "expectedEtag": fx.etag("destination.txt")
            })
        } else {
            std::fs::create_dir(fx.root.join("source-dir")).unwrap();
            json!({"from": fx.p("source-dir"), "to": fx.p("destination-dir")})
        };

        let prepared = prepare(&fx, "rename", args, None);
        assert_eq!(
            prepared.child_input().blocked,
            Some(ErrorCode::Unsupported),
            "{case}"
        );
        if case == "overwrite" {
            assert_eq!(fx.get("source.txt"), "source\n");
            assert_eq!(fx.get("destination.txt"), "destination\n");
        } else {
            assert!(fx.root.join("source-dir").is_dir());
            assert!(!fx.root.join("destination-dir").exists());
        }
    }
}

#[test]
fn supervised_apply_rechecks_atomic_rename_capability() {
    let fx = Fx::new();
    fx.put("source.txt", "source\n");
    let prepared = prepare(
        &fx,
        "rename",
        json!({"from": fx.p("source.txt"), "to": fx.p("destination.txt")}),
        None,
    );
    assert_eq!(prepared.child_input().blocked, None);

    fx.ops
        .set_rename_atomic_capability(RenameAtomicCapability::Unavailable);
    assert_eq!(
        code(fx.ops.execute_supervised(prepared, &fx.cancel)),
        ErrorCode::Unsupported
    );
    assert_eq!(fx.get("source.txt"), "source\n");
    assert!(!fx.root.join("destination.txt").exists());
}

#[test]
fn hard_link_platform_still_allows_regular_no_replace_rename() {
    let fx = Fx::new();
    fx.put("source.txt", "source\n");
    fx.ops
        .set_rename_atomic_capability(RenameAtomicCapability::HardLinksOnly);
    let prepared = prepare(
        &fx,
        "rename",
        json!({"from": fx.p("source.txt"), "to": fx.p("destination.txt")}),
        None,
    );
    assert_eq!(prepared.child_input().blocked, None);
    fx.ops
        .execute_supervised(prepared, &fx.cancel)
        .expect("regular no-replace rename");
    assert!(!fx.root.join("source.txt").exists());
    assert_eq!(fx.get("destination.txt"), "source\n");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_supervised_overwrite_uses_atomic_exchange() {
    let fx = Fx::new();
    fx.put("source.txt", "source\n");
    fx.put("destination.txt", "destination\n");
    let prepared = prepare(
        &fx,
        "rename",
        json!({
            "from": fx.p("source.txt"),
            "to": fx.p("destination.txt"),
            "overwrite": true,
            "expectedEtag": fx.etag("destination.txt")
        }),
        None,
    );
    assert_eq!(prepared.child_input().blocked, None);
    fx.ops
        .execute_supervised(prepared, &fx.cancel)
        .expect("atomic overwrite");
    assert!(!fx.root.join("source.txt").exists());
    assert_eq!(fx.get("destination.txt"), "source\n");
}

#[test]
fn a_swapped_input_symlink_cannot_redirect_the_prepared_edit() {
    let fx = Fx::new();
    fx.put("approved.txt", "before\n");
    fx.put("other.txt", "before\n");
    fx.link("approved.txt", "current");
    let prepared = prepare(
        &fx,
        "edit",
        json!({"path":fx.p("current"), "edits":[{"oldText":"before", "newText":"after"}]}),
        None,
    );
    std::fs::remove_file(fx.root.join("current")).unwrap();
    fx.link("other.txt", "current");
    assert_eq!(
        code(fx.ops.execute_supervised(prepared, &fx.cancel)),
        ErrorCode::Conflict
    );
    assert_eq!(fx.get("approved.txt"), "before\n");
    assert_eq!(fx.get("other.txt"), "before\n");
}

#[test]
fn gap_required_agent_etags_are_not_synthesized_from_preview() {
    let fx = Fx::new();
    fx.put("source", "old\n");
    fx.put("destination", "destination\n");
    let cases = [
        (
            "edit",
            json!({"path":fx.p("source"), "edits":[{"startLine":1,"endLine":1,"newText":"new"}]}),
            None,
        ),
        (
            "write",
            json!({"path":fx.p("source"), "ifExists":"replace"}),
            Some(b"new\n".to_vec()),
        ),
        (
            "rename",
            json!({"from":fx.p("source"), "to":fx.p("destination"), "overwrite":true}),
            None,
        ),
    ];
    for (op, args, body) in cases {
        assert_eq!(
            code(
                fx.ops
                    .prepare_supervised(op, args, body, &key(), &fx.cancel)
            ),
            ErrorCode::InvalidInput,
            "{op}"
        );
        assert_eq!(fx.get("source"), "old\n");
        assert_eq!(fx.get("destination"), "destination\n");
        assert!(fx.leftovers("").is_empty());
    }
}

#[test]
fn gap_exact_edit_without_agent_etag_is_pinned_to_displayed_bytes() {
    for raced in [false, true] {
        let fx = Fx::new();
        fx.put("source", "old\ncontext\n");
        let prepared = prepare(
            &fx,
            "edit",
            json!({"path":fx.p("source"), "edits":[{"oldText":"old","newText":"new"}]}),
            None,
        );
        assert_eq!(prepared.child_input().blocked, None);
        if raced {
            // The match still exists: rerunning an unpinned exact edit would succeed.
            fx.put("source", "old\nraced context\n");
            assert_eq!(
                code(fx.ops.execute_supervised(prepared, &fx.cancel)),
                ErrorCode::Conflict
            );
            assert_eq!(fx.get("source"), "old\nraced context\n");
        } else {
            fx.ops
                .execute_supervised(prepared, &fx.cancel)
                .expect("apply without agent etag");
            assert_eq!(fx.get("source"), "new\ncontext\n");
        }
        assert!(fx.leftovers("").is_empty());
    }
}

#[test]
fn gap_apply_rechecks_hardlinks_and_owner_for_every_existing_file_operand() {
    for op in [
        "edit",
        "write",
        "delete",
        "rename-source",
        "rename-destination",
    ] {
        for refusal in [ErrorCode::HardLinked, ErrorCode::OwnerMismatch] {
            let fx = Fx::new();
            fx.put("source", "old\n");
            fx.put("destination", "destination\n");
            let (operation, args, body) = match op {
                "edit" => (
                    "edit",
                    json!({"path":fx.p("source"),"edits":[{"oldText":"old","newText":"new"}]}),
                    None,
                ),
                "write" => (
                    "write",
                    json!({"path":fx.p("source"),"ifExists":"replace","expectedEtag":fx.etag("source")}),
                    Some(b"new\n".to_vec()),
                ),
                "delete" => ("delete", json!({"path":fx.p("source")}), None),
                "rename-source" => (
                    "rename",
                    json!({"from":fx.p("source"),"to":fx.p("absent")}),
                    None,
                ),
                _ => (
                    "rename",
                    json!({"from":fx.p("source"),"to":fx.p("destination"),"overwrite":true,"expectedEtag":fx.etag("destination")}),
                    None,
                ),
            };
            let prepared = prepare(&fx, operation, args.clone(), body.clone());
            if op == "rename-destination"
                && !supervised_overwrite_supported(fx.ops.rename_atomic_capability())
            {
                assert_eq!(prepared.child_input().blocked, Some(ErrorCode::Unsupported));
                assert_eq!(fx.get("source"), "old\n");
                assert_eq!(fx.get("destination"), "destination\n");
                continue;
            }
            assert_eq!(prepared.child_input().blocked, None, "{op}");
            let affected = if op == "rename-destination" {
                "destination"
            } else {
                "source"
            };
            let denied_ops;
            let apply_ops = if refusal == ErrorCode::HardLinked {
                // Keep the pinned inode/content; only the link count changes after preview.
                // A separate identity-swap refusal cannot hide a missing hard-link guard.
                std::fs::hard_link(fx.root.join(affected), fx.root.join("alias")).unwrap();
                &fx.ops
            } else {
                // Effective-uid seam models a foreign owner without chown privileges.
                denied_ops = FileOps::new(
                    Policy::new(vec![], vec![], true)
                        .with_euid(super::real_uid().saturating_add(1)),
                    EtagKey::from_bytes([7; 32]),
                );
                &denied_ops
            };
            assert_eq!(
                code(apply_ops.execute_supervised(prepared, &fx.cancel)),
                refusal,
                "{op} {refusal:?}"
            );
            assert_eq!(fx.get("source"), "old\n", "{op}");
            assert_eq!(fx.get("destination"), "destination\n", "{op}");
            if refusal == ErrorCode::HardLinked {
                assert_eq!(fx.get("alias"), fx.get(affected));
            }
            assert!(fx.leftovers("").is_empty());
            // The same state is also blocked on a fresh preview. Apply is
            // asserted first so a preview-only guard cannot satisfy this test.
            let blocked = apply_ops
                .prepare_supervised(operation, args, body, &key(), &fx.cancel)
                .expect("state refusal is displayed");
            assert_eq!(blocked.child_input().blocked, Some(refusal), "{op}");
        }
    }
}

#[test]
fn gap_apply_refuses_replacement_with_hardlinked_inode_after_preview() {
    for op in ["edit", "write", "delete", "rename"] {
        let fx = Fx::new();
        fx.put("source", "old\n");
        fx.put("destination", "destination\n");
        let (args, body) = match op {
            "edit" => (
                json!({"path":fx.p("source"),"edits":[{"oldText":"old","newText":"new"}]}),
                None,
            ),
            "write" => (
                json!({"path":fx.p("source"),"ifExists":"replace","expectedEtag":fx.etag("source")}),
                Some(b"new\n".to_vec()),
            ),
            "delete" => (json!({"path":fx.p("source")}), None),
            _ => (json!({"from":fx.p("source"),"to":fx.p("absent")}), None),
        };
        let prepared = prepare(&fx, op, args, body);
        assert_eq!(prepared.child_input().blocked, None);
        let affected = "source";
        fx.put("replacement", fx.get(affected));
        std::fs::remove_file(fx.root.join(affected)).unwrap();
        std::fs::hard_link(fx.root.join("replacement"), fx.root.join(affected)).unwrap();
        let error = code(fx.ops.execute_supervised(prepared, &fx.cancel));
        assert!(
            matches!(error, ErrorCode::Conflict | ErrorCode::HardLinked),
            "{op}: {error:?}"
        );
        assert_eq!(fx.get("source"), "old\n");
        assert_eq!(fx.get("destination"), "destination\n");
        assert_eq!(fx.get("replacement"), fx.get(affected));
        assert!(fx.leftovers("").is_empty());
    }
}

mod consent;
mod guard_matrix;

#[test]
fn supervised_dry_run_is_invalid_before_disk_and_in_both_entry_points() {
    let fx = Fx::new();
    for path in [fx.p("absent"), fx.p("present")] {
        fx.put("present", "old\n");
        let raw = json!({"path":path,"dryRun":true,"edits":[{"oldText":"old","newText":"new"}]});
        assert_eq!(
            code(
                fx.ops
                    .prepare_supervised("edit", raw.clone(), None, &key(), &fx.cancel)
            ),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(
                fx.ops
                    .preview_supervised("edit", raw, None, &key(), &fx.cancel)
            ),
            ErrorCode::InvalidInput
        );
        assert_eq!(fx.get("present"), "old\n");
        assert!(!fx.root.join("absent").exists());
    }
}

#[test]
fn supervised_result_etags_describe_the_committed_file_object() {
    for op in ["edit", "write-create", "write-replace", "rename"] {
        let fx = Fx::new();
        fx.put("source", "old\n");
        let (wire_op, args, body, result_path) = match op {
            "edit" => (
                "edit",
                json!({"path":fx.p("source"), "edits":[{"oldText":"old", "newText":"new"}]}),
                None,
                "source",
            ),
            "write-create" => (
                "write",
                json!({"path":fx.p("new")}),
                Some(b"new\n".to_vec()),
                "new",
            ),
            "write-replace" => (
                "write",
                json!({"path":fx.p("source"), "ifExists":"replace", "expectedEtag":fx.etag("source")}),
                Some(b"new\n".to_vec()),
                "source",
            ),
            _ => (
                "rename",
                json!({"from":fx.p("source"), "to":fx.p("new")}),
                None,
                "new",
            ),
        };
        let prepared = prepare(&fx, wire_op, args, body);
        let result = fx.ops.execute_supervised(prepared, &fx.cancel).unwrap();
        assert_eq!(result["etag"], fx.etag(result_path), "{op}");
    }
}

#[test]
fn supervised_mutations_share_the_headless_namespace_guard() {
    use std::sync::mpsc;
    use std::time::Duration;
    for op in ["edit", "write", "mkdir", "rename", "delete"] {
        let fx = Fx::new();
        fx.put("source", "old\n");
        fx.put("other", "other\n");
        let (request, body) = match op {
            "edit" => (
                json!({"path":fx.p("source"), "edits":[{"oldText":"old", "newText":"new"}]}),
                None,
            ),
            "write" => (json!({"path":fx.p("new")}), Some(b"new\n".to_vec())),
            "mkdir" => (json!({"path":fx.p("new")}), None),
            "rename" => (json!({"from":fx.p("source"), "to":fx.p("new")}), None),
            _ => (json!({"path":fx.p("source")}), None),
        };
        let prepared = prepare(&fx, op, request, body);
        assert_eq!(prepared.child_input().blocked, None);
        let (reached_tx, reached_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let release_rx = std::sync::Mutex::new(release_rx);
        let first = AtomicBool::new(true);
        let mut fx = fx.with_hook(move |step| {
            if step == Step::SupervisedPinVerified && first.swap(false, Ordering::SeqCst) {
                reached_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
            Ok(())
        });
        fx.ops.limits.lock_wait = Duration::from_millis(50);
        let fx = Arc::new(fx);
        let worker_fx = Arc::clone(&fx);
        let apply = std::thread::spawn(move || {
            worker_fx
                .ops
                .execute_supervised(prepared, &worker_fx.cancel)
        });
        reached_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let contending = if matches!(op, "rename" | "delete") {
            fx.ops.execute(
                "write",
                json!({"path":fx.p("independent"), "content":"must wait"}),
                &fx.cancel,
            )
        } else {
            fx.ops.execute(
                "rename",
                json!({"from":fx.p("other"), "to":fx.p("moved-other")}),
                &fx.cancel,
            )
        };
        release_tx.send(()).unwrap();
        apply.join().unwrap().unwrap();
        assert_eq!(code(contending), ErrorCode::Timeout, "{op}");
        assert_eq!(fx.get("other"), "other\n");
        assert!(!fx.root.join("independent").exists());
        assert!(!fx.root.join("moved-other").exists());
    }
}

#[test]
fn physical_path_policy_errors_are_blocked_for_every_supervised_operand() {
    use crate::file_ops::policy::{Deny, Protected};
    let fx = Fx::with_policy(|root| {
        Policy::new(
            vec![],
            vec![Protected {
                path: root.join("protected"),
                subtree: true,
                deny: Deny::WriteOnly,
            }],
            true,
        )
    });
    for (directory, expected) in [
        (".ssh", ErrorCode::SecretFile),
        ("protected", ErrorCode::PathDenied),
    ] {
        std::fs::create_dir(fx.root.join(directory)).unwrap();
        fx.put(&format!("{directory}/private"), "private fixture\n");
        let alias_name = format!("alias-{}", expected.as_str());
        std::os::unix::fs::symlink(fx.root.join(directory), fx.root.join(&alias_name)).unwrap();
        let alias = fx.p(&format!("{alias_name}/private"));
        for (op, args, body) in [
            (
                "edit",
                json!({"path":alias,"edits":[{"oldText":"private","newText":"changed"}]}),
                None,
            ),
            ("write", json!({"path":alias}), Some(b"new\n".to_vec())),
            ("delete", json!({"path":alias}), None),
            (
                "mkdir",
                json!({"path":fx.p(&format!("{alias_name}/new"))}),
                None,
            ),
            ("rename", json!({"from":alias,"to":fx.p("dest")}), None),
            ("rename", json!({"from":fx.p("source"),"to":alias}), None),
        ] {
            fx.put("source", "source\n");
            let prepared = fx
                .ops
                .prepare_supervised(op, args, body, &key(), &fx.cancel)
                .expect("physical path policy waits for a dismissal key");
            assert_eq!(
                prepared.child_input().blocked,
                Some(expected),
                "{op} {directory}"
            );
        }
        assert_eq!(fx.get(&format!("{directory}/private")), "private fixture\n");
    }
}
