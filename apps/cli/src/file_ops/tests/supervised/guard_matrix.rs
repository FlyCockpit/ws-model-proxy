//! One operation/seam/attack matrix. Transient swaps isolate an early guard:
//! restoring the name at the next seam prevents a later guard hiding its loss.
use std::collections::BTreeMap;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry(u64, u64, u32, u32, u32, u64, Vec<u8>);

fn tree(root: &Path) -> BTreeMap<PathBuf, Entry> {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Entry>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".wsmp-")
            {
                continue;
            }
            let meta = std::fs::symlink_metadata(&path).unwrap();
            let bytes = if meta.is_symlink() {
                std::fs::read_link(&path)
                    .unwrap()
                    .into_os_string()
                    .into_vec()
            } else if meta.is_file() {
                std::fs::read(&path).unwrap()
            } else {
                Vec::new()
            };
            out.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                Entry(
                    meta.dev(),
                    meta.ino(),
                    meta.mode(),
                    meta.uid(),
                    meta.gid(),
                    meta.nlink(),
                    bytes,
                ),
            );
            if meta.is_dir() {
                visit(root, &path, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attack {
    Inode,
    Content,
    Appeared,
    AncestorDirectory,
    AncestorSymlink,
    ProtectedAlias,
    Cancel,
    OpenRace,
    LeafSymlink,
}

#[derive(Debug, Clone, Copy)]
struct Row {
    operand: &'static str,
    step: Option<Step>,
    occurrence: usize,
    attack: Attack,
    restore: Option<Step>,
    no_op: bool,
}

const OPERANDS: [&str; 7] = [
    "edit",
    "write-replace",
    "write-create",
    "rename-source",
    "rename-overwrite",
    "delete",
    "mkdir",
];

fn run(row: Row) {
    let fx = Fx::with_policy(Fx::protecting(&[(
        "protected",
        crate::file_ops::policy::Deny::WriteOnly,
    )]));
    std::fs::create_dir(fx.root.join("parent")).unwrap();
    fx.put("parent/source", "old\n");
    if row.operand == "rename-overwrite" {
        fx.put("parent/destination", "destination\n");
    }
    if row.operand == "mkdir-existing" {
        std::fs::create_dir(fx.root.join("parent/new")).unwrap();
    }
    let source = fx.p("parent/source");
    let destination = fx.p("parent/destination");
    let target = match row.operand {
        "write-create" | "mkdir" | "mkdir-existing" => fx.root.join("parent/new"),
        "rename-overwrite" | "rename-absent" => fx.root.join("parent/destination"),
        _ => fx.root.join("parent/source"),
    };
    let (op, args, body) = match row.operand {
        "edit" => (
            "edit",
            json!({"path":source,"edits":[{"oldText":"old","newText":if row.no_op {"old"} else {"new"}}]}),
            None,
        ),
        "write-create" => ("write", json!({"path":target}), Some(b"new\n".to_vec())),
        "write-replace" => (
            "write",
            json!({"path":source,"ifExists":"replace","expectedEtag":fx.etag("parent/source")}),
            Some(b"new\n".to_vec()),
        ),
        "mkdir" | "mkdir-existing" => ("mkdir", json!({"path":target}), None),
        "delete" => ("delete", json!({"path":source}), None),
        "rename-overwrite" => (
            "rename",
            json!({"from":source,"to":destination,"overwrite":true,"expectedEtag":fx.etag("parent/destination")}),
            None,
        ),
        _ => ("rename", json!({"from":source,"to":destination}), None),
    };
    let prepared = prepare(&fx, op, args, body);
    assert_eq!(prepared.child_input().blocked, None, "{row:?}");
    let root = fx.root.clone();
    let snapshot = Arc::new(Mutex::new(tree(&root)));
    let saved_snapshot = Arc::clone(&snapshot);
    let hits = Arc::new(Mutex::new(0));
    let hook_hits = Arc::clone(&hits);
    let restored = Arc::new(AtomicBool::new(false));
    let hook_restored = Arc::clone(&restored);
    let restore_hits = Arc::new(Mutex::new(0));
    let cancel = fx.cancel.clone();
    let change = move || {
        match row.attack {
            Attack::Inode | Attack::OpenRace => {
                if target.is_dir() {
                    std::fs::rename(&target, root.join("held-original")).unwrap();
                    std::fs::create_dir(&target).unwrap();
                } else {
                    let bytes = std::fs::read(&target).unwrap();
                    std::fs::rename(&target, root.join("held-original")).unwrap();
                    std::fs::write(&target, bytes).unwrap();
                }
            }
            Attack::LeafSymlink => {
                let moved = target.with_file_name("moved-source");
                std::fs::rename(&target, &moved).unwrap();
                symlink(&moved, &target).unwrap();
            }
            Attack::Content => std::fs::write(&target, "raced\n").unwrap(),
            Attack::Appeared => {
                if row.operand == "mkdir" {
                    std::fs::create_dir(&target).unwrap();
                } else {
                    std::fs::write(&target, "appeared\n").unwrap();
                }
            }
            Attack::AncestorDirectory | Attack::AncestorSymlink => {
                std::fs::rename(root.join("parent"), root.join("held-parent")).unwrap();
                let replacement = if row.attack == Attack::AncestorSymlink {
                    root.join("redirect")
                } else {
                    root.join("parent")
                };
                std::fs::create_dir(&replacement).unwrap();
                // Preserve leaf identities and bytes: ONLY the ancestor changed.
                for entry in std::fs::read_dir(root.join("held-parent"))
                    .unwrap()
                    .filter(|_| row.step.is_none())
                {
                    let entry = entry.unwrap();
                    if !matches!(entry.file_name().to_str(), Some("source" | "destination")) {
                        continue;
                    }
                    std::fs::rename(entry.path(), replacement.join(entry.file_name())).unwrap();
                }
                if row.attack == Attack::AncestorSymlink {
                    symlink(&replacement, root.join("parent")).unwrap();
                }
            }
            Attack::ProtectedAlias => std::fs::hard_link(&target, root.join("protected")).unwrap(),
            Attack::Cancel => cancel.cancel(),
        }
        *saved_snapshot.lock().unwrap() = tree(&root);
    };
    if row.step.is_none() {
        change();
    }
    let hook_target = match row.operand {
        "rename-overwrite" | "rename-absent" => fx.root.join("parent/destination"),
        "mkdir-existing" => fx.root.join("parent/new"),
        _ => fx.root.join("parent/source"),
    };
    let hook_root = fx.root.clone();
    let hook_snapshot = Arc::clone(&snapshot);
    let fx = fx.with_hook(move |step| {
        if Some(step) == row.step {
            let mut count = hook_hits.lock().unwrap();
            *count += 1;
            if *count == row.occurrence {
                change();
            }
        }
        if Some(step) == row.restore {
            let mut count = restore_hits.lock().unwrap();
            *count += 1;
            // OpenRace restores just after the fd was opened, before its check.
            if *count == row.occurrence && !hook_restored.swap(true, Ordering::SeqCst) {
                if row.attack == Attack::ProtectedAlias {
                    std::fs::remove_file(hook_root.join("protected")).unwrap();
                } else {
                    if hook_target.is_dir() {
                        std::fs::remove_dir(&hook_target).unwrap();
                    } else {
                        std::fs::remove_file(&hook_target).unwrap();
                    }
                    if row.attack != Attack::Appeared {
                        std::fs::rename(hook_root.join("held-original"), &hook_target).unwrap();
                    }
                }
                *hook_snapshot.lock().unwrap() = tree(&hook_root);
            }
        }
        Ok(())
    });
    let result = fx.ops.execute_supervised(prepared, &fx.cancel);
    fn no_temps(dir: &Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            assert!(
                !path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".wsmp-"),
                "temporary file leaked: {path:?}"
            );
            if std::fs::symlink_metadata(&path).unwrap().is_dir() {
                no_temps(&path);
            }
        }
    }
    no_temps(&fx.root);
    let expected = match row.attack {
        Attack::Cancel => ErrorCode::Cancelled,
        Attack::ProtectedAlias => ErrorCode::PathDenied,
        _ => ErrorCode::Conflict,
    };
    assert_eq!(code(result), expected, "{row:?}");
    if row.step.is_some() {
        assert!(
            *hits.lock().unwrap() >= row.occurrence,
            "hook not reached: {row:?}"
        );
    }
    assert_eq!(
        tree(&fx.root),
        *snapshot.lock().unwrap(),
        "daemon changed disk: {row:?}"
    );
}

#[test]
fn supervised_tail_cancel_rename_and_delete() {
    for operand in [
        "rename-source",
        "rename-overwrite",
        "rename-absent",
        "delete",
    ] {
        run(Row {
            operand,
            step: Some(Step::SupervisedPinVerified),
            // Initial and final verifies: two pins for rename, one for delete.
            occurrence: if operand == "delete" { 2 } else { 4 },
            attack: Attack::Cancel,
            restore: None,
            no_op: false,
        });
    }
}

#[test]
fn supervised_guard_matrix() {
    for operand in OPERANDS.into_iter().chain(["rename-absent"]) {
        for attack in [Attack::AncestorDirectory, Attack::AncestorSymlink] {
            run(Row {
                operand,
                step: None,
                occurrence: 1,
                attack,
                restore: None,
                no_op: false,
            });
            run(Row {
                operand,
                step: Some(Step::EtagRechecked),
                occurrence: 1,
                attack,
                restore: None,
                no_op: false,
            });
        }
        let absent = matches!(operand, "mkdir" | "write-create" | "rename-absent");
        let occurrence = if matches!(operand, "rename-overwrite" | "rename-absent") {
            2
        } else {
            1
        };
        run(Row {
            operand,
            step: Some(Step::SupervisedBeforePin),
            occurrence,
            attack: if absent {
                Attack::Appeared
            } else {
                Attack::Inode
            },
            restore: Some(Step::SupervisedPinVerified),
            no_op: false,
        });
        run(Row {
            operand,
            step: Some(Step::EtagRechecked),
            occurrence: 1,
            attack: if absent {
                Attack::Appeared
            } else {
                Attack::Content
            },
            restore: None,
            no_op: false,
        });
        if !absent {
            run(Row {
                operand,
                step: None,
                occurrence: 1,
                attack: Attack::Content,
                restore: None,
                no_op: false,
            });
            run(Row {
                operand,
                step: Some(Step::EtagRechecked),
                occurrence: 1,
                attack: Attack::Inode,
                restore: None,
                no_op: false,
            });
            for occurrence in [occurrence, occurrence * 2] {
                for attack in [
                    Attack::Inode,
                    Attack::AncestorDirectory,
                    Attack::AncestorSymlink,
                ] {
                    run(Row {
                        operand,
                        step: Some(Step::PinOpened),
                        occurrence,
                        attack,
                        restore: None,
                        no_op: false,
                    });
                }
            }
            run(Row {
                operand,
                step: None,
                occurrence: 1,
                attack: Attack::Inode,
                restore: None,
                no_op: false,
            });
            run(Row {
                operand,
                step: Some(Step::PinBeforeOpen),
                occurrence,
                attack: Attack::OpenRace,
                restore: Some(Step::PinOpened),
                no_op: false,
            });
            // Final verifier: restore the name after opening a different fd.
            run(Row {
                operand,
                step: Some(Step::PinBeforeOpen),
                occurrence: occurrence * 2,
                attack: Attack::OpenRace,
                restore: Some(Step::PinOpened),
                no_op: false,
            });
        }
        if matches!(operand, "rename-source" | "rename-overwrite") {
            run(Row {
                operand,
                step: Some(Step::BeforeIdentity),
                occurrence,
                attack: Attack::ProtectedAlias,
                restore: Some(Step::IdentityChecked),
                no_op: false,
            });
        }
        if operand != "rename-absent" {
            run(Row {
                operand,
                step: Some(Step::EtagRechecked),
                occurrence: 1,
                attack: Attack::Cancel,
                restore: None,
                no_op: false,
            });
        }
    }
    for (step, attack, restore) in [
        (None, Attack::Inode, None),
        (None, Attack::AncestorDirectory, None),
        (None, Attack::AncestorSymlink, None),
        (
            Some(Step::SupervisedBeforePin),
            Attack::Inode,
            Some(Step::SupervisedPinVerified),
        ),
    ] {
        run(Row {
            operand: "mkdir-existing",
            step,
            occurrence: 1,
            attack,
            restore,
            no_op: false,
        });
    }
    run(Row {
        operand: "edit",
        step: Some(Step::SupervisedOpenedVerified),
        occurrence: 1,
        attack: Attack::Inode,
        restore: None,
        no_op: true,
    });
    run(Row {
        operand: "mkdir-existing",
        step: Some(Step::SupervisedPinVerified),
        occurrence: 1,
        attack: Attack::Inode,
        restore: None,
        no_op: true,
    });
    for operand in ["edit", "write-replace"] {
        run(Row {
            operand,
            step: None,
            occurrence: 1,
            attack: Attack::LeafSymlink,
            restore: None,
            no_op: false,
        });
    }
    run(Row {
        operand: "edit",
        step: Some(Step::SupervisedBeforeOpen),
        occurrence: 1,
        attack: Attack::Inode,
        restore: Some(Step::SupervisedOpened),
        no_op: true,
    });
}

#[test]
fn supervised_write_open_race_is_bound_by_the_commit_checks() {
    run(Row {
        operand: "write-replace",
        step: Some(Step::SupervisedBeforeOpen),
        occurrence: 1,
        attack: Attack::Inode,
        restore: None,
        no_op: false,
    });
}
