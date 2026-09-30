//! In-process versions of C1a-1/2/3 from codex-r1a-preload.c. Real filesystem
//! renames hit the post-exchange / pre-undo boundaries on Linux and macOS.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use nix::errno::Errno;
use serde_json::{Value, json};

use super::{Fx, args};
use crate::file_ops::exchange::{FaultScope, Primitive, fault};
use crate::file_ops::policy::Access;
use crate::file_ops::{ErrorCode, FileError, FileResult, Step};

#[derive(Clone, Copy, Debug)]
enum Op {
    Replace,
    Write,
    Rename,
}

const OPS: [Op; 2] = [Op::Replace, Op::Rename];

impl Op {
    fn destination(self) -> &'static str {
        match self {
            Self::Rename => "dst.txt",
            _ => "doc.txt",
        }
    }

    fn prepare(self, fx: &Fx) -> String {
        if matches!(self, Self::Rename) {
            fx.put("src.txt", "mine");
        }
        fx.put(self.destination(), "original");
        fx.etag(self.destination())
    }

    fn run(self, fx: &Fx, etag: &str) -> FileResult<Value> {
        match self {
            Self::Replace => fx
                .ops
                .edit(
                    &args(json!({"path": fx.p("doc.txt"), "expectedEtag": etag,
                "edits": [{"oldText": "original", "newText": "edited"}]})),
                    &fx.cancel,
                )
                .map(|r| serde_json::to_value(r).unwrap()),
            Self::Write => fx
                .ops
                .write(
                    &args(json!({"path": fx.p("doc.txt"), "expectedEtag": etag,
                "ifExists": "replace", "content": "edited"})),
                    &fx.cancel,
                )
                .map(|r| serde_json::to_value(r).unwrap()),
            Self::Rename => fx
                .ops
                .rename(
                    &args(json!({"from": fx.p("src.txt"), "to": fx.p("dst.txt"),
                "overwrite": true, "expectedEtag": etag})),
                    &fx.cancel,
                )
                .map(|r| serde_json::to_value(r).unwrap()),
        }
    }
}

/// Install a new inode, like the interposer's child (writing in place would not
/// discriminate an inode-ownership guard).
fn successor(path: &Path, bytes: &str) {
    let incoming = path.with_file_name("incoming.txt");
    std::fs::write(&incoming, bytes).unwrap();
    std::fs::rename(incoming, path).unwrap();
}

fn stage(root: &Path) -> PathBuf {
    std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.is_file() && p.file_name().unwrap().to_string_lossy().contains(".wsmp-"))
        .unwrap()
}

fn recovery_dirs(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".wsmp-recover-")
        })
        .collect()
}

fn paths(value: &Value) -> Vec<PathBuf> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| PathBuf::from(v.as_str().unwrap()))
        .collect()
}

fn uncertain(error: &FileError) -> Vec<PathBuf> {
    assert_eq!(error.code, ErrorCode::UncertainOutcome, "{error:?}");
    assert_eq!(error.message, "file outcome is uncertain; inspect recovery");
    let detail = error.detail.as_ref().unwrap();
    let dir = PathBuf::from(detail["recovery"].as_str().unwrap());
    assert!(dir.is_absolute() && dir.is_dir(), "{detail}");
    let kept = paths(&detail["kept"]);
    assert!(!kept.is_empty() && kept.len() <= 4);
    for p in &kept {
        assert!(p.is_absolute() && p.exists(), "reported object: {p:?}");
    }
    assert!(
        std::fs::read_dir(dir).unwrap().count() <= 2,
        "two-slot bound"
    );
    kept
}

fn contains_bytes(paths: &[PathBuf], bytes: &str) -> bool {
    paths
        .iter()
        .any(|p| std::fs::read(p).is_ok_and(|b| b == bytes.as_bytes()))
}

fn clean(fx: &Fx) {
    assert!(fx.leftovers("").is_empty());
    assert!(recovery_dirs(&fx.root).is_empty());
}

#[test]
fn compensation_fault_table_is_off_by_default_nth_and_thread_local() {
    for primitive in [
        Primitive::Exchange,
        Primitive::Capture,
        Primitive::Restore,
        Primitive::Move,
        Primitive::Unlink,
        Primitive::Rmdir,
    ] {
        assert_eq!(fault(primitive), Ok(()));
        {
            let _scope = FaultScope::new(&[(primitive, 2, Errno::EIO)]);
            assert_eq!(fault(primitive), Ok(()));
            assert_eq!(
                std::thread::spawn(move || fault(primitive)).join().unwrap(),
                Ok(())
            );
            assert_eq!(fault(primitive), Err(Errno::EIO));
            assert_eq!(fault(primitive), Ok(()));
        }
        assert_eq!(fault(primitive), Ok(()));
    }
}

#[test]
fn compensation_clean_success_and_conflict_leave_no_recovery() {
    for op in [Op::Replace, Op::Write, Op::Rename] {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let result = op.run(&fx, &etag).unwrap();
        assert!(
            result.get("recovered").is_none(),
            "skip empty serialization"
        );
        assert_eq!(
            fx.get(op.destination()),
            if matches!(op, Op::Rename) {
                "mine"
            } else {
                "edited"
            }
        );
        clean(&fx);

        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let destination = fx.root.join(op.destination());
        let fx = fx.with_hook(move |step| {
            if step == Step::EtagRechecked {
                successor(&destination, "concurrent update");
            }
            Ok(())
        });
        assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(fx.get(op.destination()), "concurrent update");
        if matches!(op, Op::Rename) {
            assert_eq!(fx.get("src.txt"), "mine");
        }
        clean(&fx);
    }
}

#[test]
fn compensation_c1a1_successor_before_capture_survives_replace_and_rename() {
    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::Exchanged {
                let public = if matches!(op, Op::Rename) {
                    root.join("src.txt")
                } else {
                    stage(&root)
                };
                successor(&public, "successor only copy");
            }
            Ok(())
        });
        assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(fx.get(op.destination()), "successor only copy");
        if matches!(op, Op::Rename) {
            assert_eq!(fx.get("src.txt"), "mine");
        }
        clean(&fx);
    }
}

#[test]
fn compensation_c1a1_successor_at_public_name_before_private_unlink_is_untouched() {
    for (op, undo) in [
        (Op::Replace, false),
        (Op::Rename, false),
        (Op::Replace, true),
    ] {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let root = fx.root.clone();
        let destination = fx.root.join(op.destination());
        let public = std::sync::Arc::new(std::sync::Mutex::new(PathBuf::new()));
        let observed = public.clone();
        let fx = fx.with_hook(move |step| {
            if undo && step == Step::EtagRechecked {
                successor(&destination, "concurrent update");
            }
            if step == Step::Exchanged {
                *observed.lock().unwrap() = if matches!(op, Op::Rename) {
                    root.join("src.txt")
                } else {
                    stage(&root)
                };
            }
            if step == Step::Disposing {
                successor(&observed.lock().unwrap(), "successor only copy");
            }
            Ok(())
        });
        if undo {
            assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
            assert_eq!(fx.get(op.destination()), "concurrent update");
        } else {
            op.run(&fx, &etag).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(&*public.lock().unwrap()).unwrap(),
            "successor only copy"
        );
        assert!(recovery_dirs(&fx.root).is_empty());
    }
}

#[test]
fn compensation_c1a2_newer_destination_before_undo_is_reported_and_kept() {
    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let destination = fx.root.join(op.destination());
        let captures = AtomicUsize::new(0);
        let fx = fx.with_hook(move |step| {
            if step == Step::EtagRechecked {
                successor(&destination, "concurrent update");
            }
            if step == Step::Captured && captures.fetch_add(1, Ordering::SeqCst) == 0 {
                successor(&destination, "later update");
            }
            Ok(())
        });
        let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
        assert!(contains_bytes(&kept, "later update"));
        assert_eq!(fx.get(op.destination()), "concurrent update");
    }
}

#[test]
fn compensation_c1a3_each_failed_capture_restore_dispose_rmdir_reports_surviving_bytes() {
    for op in OPS {
        let mut faults = vec![
            (Primitive::Capture, 1),
            (Primitive::Capture, 2),
            (Primitive::Restore, 1),
            (Primitive::Rmdir, 1),
        ];
        if matches!(op, Op::Replace) {
            faults.push((Primitive::Unlink, 1));
        } else {
            faults.push((Primitive::Restore, 2));
        }
        for (primitive, nth) in faults {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let destination = fx.root.join(op.destination());
            let fx = fx.with_hook(move |step| {
                if step == Step::EtagRechecked {
                    successor(&destination, "concurrent update");
                }
                Ok(())
            });
            let _scope = FaultScope::new(&[(primitive, nth, Errno::EIO)]);
            let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
            let mut locations = kept.clone();
            locations.push(fx.root.join(op.destination()));
            if matches!(op, Op::Rename) {
                locations.push(fx.root.join("src.txt"));
            }
            assert!(
                contains_bytes(&locations, "concurrent update"),
                "{op:?} {primitive:?}/{nth}"
            );
            if matches!(op, Op::Rename) {
                assert!(
                    contains_bytes(&locations, "mine"),
                    "checked source survives"
                );
            }
            if matches!(
                primitive,
                Primitive::Capture | Primitive::Restore | Primitive::Unlink
            ) {
                assert!(kept.iter().any(|p| p.is_file()), "retained bytes are named");
            }
            if primitive == Primitive::Unlink {
                assert!(contains_bytes(&kept, "edited"));
            }
        }
    }
}

#[test]
fn compensation_unsupported_capture_never_falls_back_to_overwriting() {
    for op in OPS {
        for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let _scope = FaultScope::new(&[(Primitive::Capture, 1, errno)]);
            let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
            assert!(contains_bytes(&kept, "original"));
            assert!(contains_bytes(
                &kept,
                if matches!(op, Op::Rename) {
                    "mine"
                } else {
                    "edited"
                }
            ));
        }
    }
}

#[test]
fn compensation_restore_collision_keeps_both_generations_and_names_them() {
    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let destination = fx.root.join(op.destination());
        let captures = AtomicUsize::new(0);
        let fx = fx.with_hook(move |step| {
            if step == Step::EtagRechecked {
                successor(&destination, "concurrent update");
            }
            if step == Step::Captured && captures.fetch_add(1, Ordering::SeqCst) == 1 {
                successor(&destination, "created during vacant undo");
            }
            Ok(())
        });
        let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
        assert!(contains_bytes(&kept, "concurrent update"));
        assert!(contains_bytes(&kept, "created during vacant undo"));
        assert_eq!(fx.get(op.destination()), "created during vacant undo");
    }
}

#[test]
fn compensation_rename_source_restore_collision_keeps_checked_source() {
    let fx = Fx::new();
    let etag = Op::Rename.prepare(&fx);
    let destination = fx.root.join("dst.txt");
    let source = fx.root.join("src.txt");
    let once = AtomicBool::new(false);
    let fx = fx.with_hook(move |step| {
        if step == Step::EtagRechecked {
            successor(&destination, "concurrent update");
        }
        if step == Step::Restored && !once.swap(true, Ordering::SeqCst) {
            successor(&source, "source squatter");
        }
        Ok(())
    });
    let kept = uncertain(&Op::Rename.run(&fx, &etag).unwrap_err());
    assert!(contains_bytes(&kept, "mine"));
    assert!(contains_bytes(&kept, "source squatter"));
    assert_eq!(fx.get("dst.txt"), "concurrent update");
}

#[test]
fn compensation_precommit_temp_and_create_squatters_are_captured_not_deleted() {
    for create in [false, true] {
        let fx = Fx::new();
        let etag = Op::Replace.prepare(&fx);
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step
                == if create {
                    Step::Created
                } else {
                    Step::TempCreated
                }
            {
                let name = if create {
                    root.join("new.txt")
                } else {
                    stage(&root)
                };
                successor(&name, "squatter only copy");
                return Err(FileError::errno(Errno::EIO));
            }
            Ok(())
        });
        let error = if create {
            fx.ops
                .write(
                    &args(json!({"path": fx.p("new.txt"), "content": "new"})),
                    &fx.cancel,
                )
                .unwrap_err()
        } else {
            Op::Replace.run(&fx, &etag).unwrap_err()
        };
        let kept = uncertain(&error);
        assert!(contains_bytes(&kept, "squatter only copy"));
        assert_eq!(fx.get("doc.txt"), "original");
    }
}

#[test]
fn compensation_success_with_unlink_or_rmdir_retention_reports_recovered_for_all_results() {
    for op in [Op::Replace, Op::Write, Op::Rename] {
        for primitive in [Primitive::Unlink, Primitive::Rmdir] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let _scope = FaultScope::new(&[(primitive, 1, Errno::EIO)]);
            let result = op.run(&fx, &etag).unwrap();
            let recovered = paths(&result["recovered"]);
            assert!(!recovered.is_empty());
            assert!(recovered.iter().all(|p| p.is_absolute() && p.exists()));
            if primitive == Primitive::Unlink {
                assert!(contains_bytes(&recovered, "original"));
            } else {
                assert!(recovered.iter().any(|p| p.is_dir()));
            }
            assert_eq!(
                fx.get(op.destination()),
                if matches!(op, Op::Rename) {
                    "mine"
                } else {
                    "edited"
                }
            );
        }
    }
}

#[test]
fn compensation_private_slot_mismatch_is_kept_even_after_successful_commit() {
    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::Disposing {
                let dir = recovery_dirs(&root).pop().unwrap();
                let slot = std::fs::read_dir(dir)
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                successor(&slot, "private squatter");
            }
            Ok(())
        });
        let result = op.run(&fx, &etag).unwrap();
        assert!(contains_bytes(
            &paths(&result["recovered"]),
            "private squatter"
        ));
    }
}

#[test]
fn compensation_recovery_policy_protects_every_folded_component_and_all_mutations() {
    let fx = Fx::new();
    for name in [
        ".wsmp-recover-a1b2c3d4e5",
        ".WSMP-RECOVER-A1B2C3D4E5",
        ".wſmp-recover-a1b2c3d4e5",
        ".wsmp-recover-a1b2c3d4e5.",
        ".wsmp-recover-a1b2c3d4e5 ",
    ] {
        for relative in [
            name.to_owned(),
            format!("{name}/slot-1"),
            format!("nested/{name}/deep/new.txt"),
        ] {
            let path = fx.root.join(relative);
            assert!(fx.ops.policy.check_path(Access::Read, &path).is_ok());
            assert!(!fx.ops.policy.hidden_from_walk(&path));
            for access in [Access::Write, Access::Remove] {
                assert_eq!(
                    fx.ops.policy.check_path(access, &path).unwrap_err().code,
                    ErrorCode::PathDenied
                );
            }
        }
    }
    for name in [
        ".wsmp-recover-short",
        ".wsmp-recover-a1b2c3d4e5x",
        "wsmp-recover-a1b2c3d4e5",
    ] {
        assert!(
            fx.ops
                .policy
                .check_path(Access::Write, &fx.root.join(name))
                .is_ok()
        );
    }
    for op in [
        "write",
        "edit",
        "delete",
        "mkdir",
        "rename-from",
        "rename-to",
    ] {
        let path = fx.p(".wsmp-recover-a1b2c3d4e5/new.txt");
        fx.put("ordinary.txt", "original");
        fx.put(".wsmp-recover-a1b2c3d4e5/new.txt", "a");
        let (tool, value) = match op {
            "rename-from" => ("rename", json!({"from": path, "to": fx.p("other.txt")})),
            "rename-to" => ("rename", json!({"from": fx.p("ordinary.txt"), "to": path})),
            "edit" => (
                op,
                json!({"path": path, "edits": [{"oldText": "a", "newText": "b"}]}),
            ),
            "write" => (
                op,
                json!({"path": path, "content": "new", "makeParents": true}),
            ),
            _ => (op, json!({"path": path})),
        };
        assert_eq!(
            fx.ops.execute(tool, value, &fx.cancel).unwrap_err().code,
            ErrorCode::PathDenied,
            "{op}"
        );
    }
}

#[test]
fn compensation_link_fallback_cleanup_and_verify_moved_keep_successors() {
    for phase in [Step::Linked, Step::Moved] {
        let fx = Fx::new();
        fx.put("src.txt", "mine");
        let source = fx.root.join("src.txt");
        let target = fx.root.join("dst.txt");
        let fx = fx.with_hook(move |step| {
            if step == phase {
                if phase == Step::Linked {
                    successor(&source, "source successor");
                }
                successor(&target, "destination successor");
            }
            Ok(())
        });
        let _scope = FaultScope::new(if phase == Step::Linked {
            &[(Primitive::Move, 1, Errno::EINVAL)]
        } else {
            &[]
        });
        let result = fx.ops.rename(
            &args(json!({"from": fx.p("src.txt"), "to": fx.p("dst.txt")})),
            &fx.cancel,
        );
        let kept = uncertain(&result.unwrap_err());
        assert!(contains_bytes(&kept, "destination successor"));
        if phase == Step::Linked {
            assert_eq!(fx.get("src.txt"), "source successor");
        }
    }
}

#[test]
fn compensation_capture_collision_never_replaces_a_private_slot_squatter() {
    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::Exchanged {
                let dir = recovery_dirs(&root).pop().unwrap();
                std::fs::write(dir.join("slot-1"), "slot squatter only copy").unwrap();
            }
            Ok(())
        });
        let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
        assert!(contains_bytes(&kept, "slot squatter only copy"));
        assert!(contains_bytes(&kept, "original"));
        assert!(contains_bytes(
            &kept,
            if matches!(op, Op::Rename) {
                "mine"
            } else {
                "edited"
            }
        ));
    }
}

#[test]
fn compensation_rename_unchecked_source_is_kept_in_recovery() {
    let fx = Fx::new();
    let etag = Op::Rename.prepare(&fx);
    let source = fx.root.join("src.txt");
    let fx = fx.with_hook(move |step| {
        if step == Step::EtagRechecked {
            successor(&source, "unchecked source");
        }
        Ok(())
    });
    let kept = uncertain(&Op::Rename.run(&fx, &etag).unwrap_err());
    assert!(contains_bytes(&kept, "unchecked source"));
    assert_eq!(fx.get("dst.txt"), "original");
}

#[test]
fn compensation_precommit_and_create_faults_prefer_uncertainty_to_the_initial_error() {
    for create in [false, true] {
        for primitive in [Primitive::Capture, Primitive::Unlink, Primitive::Rmdir] {
            let fx = Fx::new();
            let etag = Op::Replace.prepare(&fx);
            let fx = fx.with_hook(move |step| {
                if step
                    == if create {
                        Step::Created
                    } else {
                        Step::TempWritten
                    }
                {
                    return Err(FileError::cancelled());
                }
                Ok(())
            });
            let _scope = FaultScope::new(&[(primitive, 1, Errno::EIO)]);
            let error = if create {
                fx.ops
                    .write(
                        &args(json!({"path": fx.p("new.txt"), "content": "new"})),
                        &fx.cancel,
                    )
                    .unwrap_err()
            } else {
                Op::Replace.run(&fx, &etag).unwrap_err()
            };
            let kept = uncertain(&error);
            if primitive != Primitive::Rmdir {
                assert!(contains_bytes(&kept, if create { "" } else { "edited" }));
            }
            assert_eq!(fx.get("doc.txt"), "original");
        }
    }
}

#[test]
fn compensation_link_fallback_checks_both_captured_source_and_link_destination() {
    for change_source in [false, true] {
        let fx = Fx::new();
        fx.put("src.txt", "mine");
        let source = fx.root.join("src.txt");
        let target = fx.root.join("dst.txt");
        let fx = fx.with_hook(move |step| {
            if step == Step::Linked {
                successor(
                    if change_source { &source } else { &target },
                    "successor only copy",
                );
            }
            Ok(())
        });
        let _scope = FaultScope::new(&[(Primitive::Move, 1, Errno::EINVAL)]);
        let error = fx
            .ops
            .rename(
                &args(json!({"from": fx.p("src.txt"), "to": fx.p("dst.txt")})),
                &fx.cancel,
            )
            .unwrap_err();
        if change_source {
            assert_eq!(error.code, ErrorCode::Conflict);
            assert_eq!(fx.get("src.txt"), "successor only copy");
            assert!(!fx.root.join("dst.txt").exists());
            clean(&fx);
        } else {
            let kept = uncertain(&error);
            assert!(contains_bytes(&kept, "successor only copy"));
            assert_eq!(fx.get("src.txt"), "mine");
        }
    }
}

#[test]
fn compensation_recovery_dir_is_private_and_holds_at_most_two_objects() {
    use std::os::unix::fs::PermissionsExt;

    use nix::fcntl::{OFlag, open};
    use nix::sys::stat::Mode;

    use crate::file_ops::recovery::RecoveryDir;

    let fx = Fx::new();
    for name in ["a", "b", "c", "d", "e"] {
        fx.put(name, name);
    }
    let root = open(
        &fx.root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .unwrap();
    let mut recovery = RecoveryDir::new(&root, &fx.root).unwrap();
    let dir = recovery_dirs(&fx.root).pop().unwrap();
    assert_eq!(
        std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700,
        "the recovery directory is private to its owner"
    );
    assert!(
        recovery
            .capture(&root, "a".as_ref(), &fx.root.join("a"))
            .is_some()
    );
    assert!(
        recovery
            .capture(&root, "b".as_ref(), &fx.root.join("b"))
            .is_some()
    );
    // a third capture is refused: the object stays at its public name and the
    // operation is unsettled, so the directory (and both slots) are retained
    assert!(
        recovery
            .capture(&root, "c".as_ref(), &fx.root.join("c"))
            .is_none()
    );
    assert_eq!(fx.get("c"), "c");
    assert!(!recovery.settled());
    for name in ["d", "e"] {
        assert!(
            recovery
                .capture(&root, name.as_ref(), &fx.root.join(name))
                .is_none()
        );
    }
    // five retained locations (two slots, three refused names): the reported list
    // is clamped to the wire bound, the first entries being the slots
    let kept = recovery.finish();
    assert_eq!(kept.len(), 4, "{kept:?}");
    assert!(
        kept[0].ends_with("slot-1") && kept[1].ends_with("slot-2"),
        "{kept:?}"
    );
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
}

thread_local! {
    static LOG: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Routes the process-wide test subscriber's output to the CALLING thread's buffer, so
/// parallel tests never see each other's lines (a scoped `with_default` subscriber
/// is unreliable here: other threads hit these callsites first with none installed,
/// and tracing caches that "disabled" interest).
struct ThreadLog;
impl std::io::Write for ThreadLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        LOG.with(|log| log.borrow_mut().extend_from_slice(bytes));
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for ThreadLog {
    type Writer = ThreadLog;
    fn make_writer(&'a self) -> ThreadLog {
        ThreadLog
    }
}

/// Retained recovery locations reach the daemon log, on the success path (only
/// the cleanup failed) and on the uncertain-outcome path.
#[test]
fn compensation_retention_is_logged_with_the_recovery_paths() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_writer(ThreadLog)
            .with_ansi(false)
            .finish();
        tracing::subscriber::set_global_default(subscriber).expect("no other test installs one");
    });
    for op in OPS {
        for retained_by_error in [false, true] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            LOG.with(|log| log.borrow_mut().clear());
            let primitive = if retained_by_error {
                Primitive::Capture
            } else {
                Primitive::Unlink
            };
            let _scope = FaultScope::new(&[(primitive, 1, Errno::EIO)]);
            let result = op.run(&fx, &etag);
            let kept = if retained_by_error {
                uncertain(&result.unwrap_err())
            } else {
                paths(&result.unwrap()["recovered"])
            };
            let log = LOG.with(|log| String::from_utf8(log.borrow().clone()).unwrap());
            assert!(log.contains("WARN"), "{op:?}: {log}");
            assert!(log.contains("file recovery retained"), "{op:?}: {log}");
            for path in &kept {
                assert!(
                    log.contains(path.to_string_lossy().as_ref()),
                    "{op:?}: the log names {path:?}: {log}"
                );
            }
        }
    }
}
