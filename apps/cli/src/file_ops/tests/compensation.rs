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

fn private_temp(root: &Path) -> PathBuf {
    recovery_dirs(root).pop().unwrap().join("tmp")
}

fn public_stages(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            p.is_file() && name.contains(".wsmp-") && !name.starts_with(".wsmp-lock-.wsmp-recover-")
        })
        .collect()
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

fn is_recovery_metadata(name: &std::ffi::OsStr) -> bool {
    name == "INTENT"
        || name == "INTENT.new"
        || name == ".wsmp-lock"
        || name.to_string_lossy().starts_with(".wsmp-pin-")
}

fn private_object(dir: &Path) -> PathBuf {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| !is_recovery_metadata(p.file_name().unwrap()))
        .expect("private slot")
}

fn slot_count(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter(|entry| {
            let name = entry
                .as_ref()
                .ok()
                .map(|e| e.file_name())
                .unwrap_or_default();
            !is_recovery_metadata(&name)
        })
        .count()
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
    assert!(slot_count(&dir) <= 2, "two-slot bound");
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
        Primitive::ProbeExchange,
        Primitive::ProbeCreate,
        Primitive::PublishPrepare,
        Primitive::ProbeNoReplace,
        Primitive::ProbeLink,
        Primitive::Publish,
        Primitive::PublishLink,
        Primitive::Mkdir,
        Primitive::Hold,
        Primitive::Identity,
        Primitive::Capture,
        Primitive::Restore,
        Primitive::RestoreLink,
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

/// Opus p9: an editor saves the public source after vacate/exchange. The
/// checked destination never visits that name, so the save cannot be captured
/// as a destination object. Also exercise conflict undo with both objects saved.
#[test]
fn compensation_c1a1_source_save_after_vacate_or_exchange_never_moves_to_destination() {
    for phase in [Step::Vacated, Step::Exchanged] {
        for conflict in [false, true] {
            let fx = Fx::new();
            let etag = Op::Rename.prepare(&fx);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if conflict && step == Step::EtagRechecked {
                    std::fs::rename(root.join("dst.txt"), root.join("checked-destination")).unwrap();
                    std::fs::write(root.join("dst.txt"), "unchecked destination").unwrap();
                }
                if step == phase {
                    if phase == Step::Vacated {
                        assert!(!root.join("src.txt").exists());
                    }
                    // A separate writer process, as in Opus's executed probe.
                    assert!(std::process::Command::new("sh").args([
                        "-c", "printf %s C-saved-to-src > incoming-save; mv -f incoming-save src.txt",
                    ]).current_dir(&root).status().unwrap().success());
                }
                Ok(())
            });
            if conflict {
                let error = Op::Rename.run(&fx, &etag).unwrap_err();
                assert_eq!(error.code, ErrorCode::Conflict, "{phase:?} {error:?}");
                assert_eq!(fx.get("dst.txt"), "unchecked destination");
                assert_eq!(fx.get("checked-destination"), "original");
                assert_eq!(fx.get("src.txt"), "mine");
                clean(&fx);
            } else if phase == Step::Exchanged {
                let result = Op::Rename.run(&fx, &etag);
                assert_eq!(fx.get("dst.txt"), "mine");
                let kept = match result {
                    Ok(value) => paths(&value["recovered"]),
                    Err(error) => uncertain(&error),
                };
                assert!(
                    contains_bytes(&kept, "C-saved-to-src")
                        || fx.get("src.txt") == "C-saved-to-src"
                );
            } else {
                Op::Rename.run(&fx, &etag).unwrap();
                assert_eq!(fx.get("dst.txt"), "mine");
                // Only the held, checked destination was disposed.
                assert!(!contains_bytes(&[fx.root.join("dst.txt")], "original"));
                assert_eq!(fx.get("src.txt"), "C-saved-to-src");
                clean(&fx);
            }
        }
    }
}

/// Opus p9b has no public stage to overwrite now. A save to the former stage
/// shape remains at that name through both a normal commit and conflict undo.
#[test]
fn compensation_replace_has_only_a_private_temp_and_no_public_stage_to_race() {
    for op in [Op::Replace, Op::Write] {
        for conflict in [false, true] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::TempCreated {
                    assert!(public_stages(&root).is_empty(), "no public staging name");
                    assert!(private_temp(&root).is_file());
                    let entries = std::fs::read_dir(&root)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .collect::<Vec<_>>();
                    assert_eq!(
                        entries.len(),
                        3,
                        "public document, private recovery directory, cleanup lock only"
                    );
                    let locks = entries
                        .iter()
                        .filter(|path| {
                            path.file_name()
                                .unwrap()
                                .to_string_lossy()
                                .starts_with(".wsmp-lock-.wsmp-recover-")
                        })
                        .collect::<Vec<_>>();
                    assert_eq!(locks.len(), 1);
                    assert_eq!(std::fs::metadata(locks[0]).unwrap().len(), 0);
                }
                if conflict && step == Step::EtagRechecked {
                    std::fs::rename(root.join("doc.txt"), root.join("checked-destination"))
                        .unwrap();
                    std::fs::write(root.join("doc.txt"), "unchecked destination").unwrap();
                }
                if step == Step::Exchanged {
                    assert!(public_stages(&root).is_empty());
                    std::fs::write(root.join(".doc.txt.wsmp-racer00000"), "C-at-would-be-stage")
                        .unwrap();
                }
                Ok(())
            });
            if conflict {
                assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
                assert_eq!(fx.get("doc.txt"), "unchecked destination");
                assert_eq!(fx.get("checked-destination"), "original");
            } else {
                op.run(&fx, &etag).unwrap();
                assert_eq!(fx.get("doc.txt"), "edited");
            }
            assert_eq!(fx.get(".doc.txt.wsmp-racer00000"), "C-at-would-be-stage");
            assert!(recovery_dirs(&fx.root).is_empty());
        }
    }
}

/// Unlike successor(), this releases the last NAME before allocating the new
/// file. The operation's Held fd must pin the old inode, so reuse is impossible
/// during this hook even on ext4. Survival is deterministic on every filesystem.
#[test]
fn compensation_c1b1_unlink_then_recreate_before_private_dispose_survives() {
    use std::os::unix::fs::MetadataExt;

    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::Disposing
                && (!matches!(op, Op::Rename) || !root.join("src.txt").exists())
            {
                let dir = recovery_dirs(&root).pop().unwrap();
                let private = private_object(&dir);
                let old = std::fs::symlink_metadata(&private).unwrap();
                std::fs::remove_file(&private).unwrap();
                std::fs::write(&private, "recreated only copy").unwrap();
                let new = std::fs::symlink_metadata(&private).unwrap();
                assert_eq!(old.dev(), new.dev(), "same filesystem");
                assert_ne!(old.ino(), new.ino(), "Held pins the unlinked inode");
            }
            Ok(())
        });
        let result = op.run(&fx, &etag).unwrap();
        assert!(contains_bytes(
            &paths(&result["recovered"]),
            "recreated only copy"
        ));
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
                // the public name a racer can really reach: the rename source, or the
                // published replacement (replace has no public staging name)
                *observed.lock().unwrap() = if matches!(op, Op::Rename) {
                    root.join("src.txt")
                } else {
                    root.join("doc.txt")
                };
            }
            if step == Step::Disposing
                && (!matches!(op, Op::Rename) || !root.join("src.txt").exists())
            {
                successor(&observed.lock().unwrap(), "successor only copy");
            }
            Ok(())
        });
        if undo {
            // the racer takes the vacated public name while the undo disposes our
            // temp: the no-replace restore of the older successor then finds the
            // name taken, so it stays in recovery and the outcome is uncertain
            let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
            assert!(contains_bytes(&kept, "concurrent update"));
            assert_eq!(fx.get(op.destination()), "successor only copy");
        } else {
            op.run(&fx, &etag).unwrap();
            assert!(recovery_dirs(&fx.root).is_empty());
        }
        assert_eq!(
            std::fs::read_to_string(&*public.lock().unwrap()).unwrap(),
            "successor only copy"
        );
    }
}

#[test]
fn compensation_c1a2_newer_destination_before_undo_is_reported_and_kept() {
    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let destination = fx.root.join(op.destination());
        let fx = fx.with_hook(move |step| {
            if step == Step::EtagRechecked {
                successor(&destination, "concurrent update");
            }
            if step == Step::Exchanged {
                successor(&destination, "later update");
            }
            Ok(())
        });
        if matches!(op, Op::Rename) {
            // Exchange-first sees the dest successor before any public swap.
            assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
            assert_eq!(fx.get("dst.txt"), "concurrent update");
            assert_eq!(fx.get("src.txt"), "mine");
            clean(&fx);
            continue;
        }
        let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
        assert!(contains_bytes(&kept, "concurrent update"));
        assert_eq!(fx.get(op.destination()), "later update");
    }
}

#[test]
fn compensation_c1a3_each_failed_capture_restore_dispose_rmdir_reports_surviving_bytes() {
    for op in OPS {
        let mut faults = vec![
            (Primitive::Capture, 1),
            (Primitive::Restore, 1),
            (Primitive::Rmdir, 1),
        ];
        if matches!(op, Op::Replace) {
            faults.push((Primitive::Unlink, 1));
        } else {
            faults.push((Primitive::Capture, 2));
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
            if matches!(op, Op::Rename) {
                // Exchange-first refuses the dest successor before capture.
                let error = op.run(&fx, &etag).unwrap_err();
                assert_eq!(
                    error.code,
                    ErrorCode::Conflict,
                    "{op:?} {primitive:?}/{nth}"
                );
                assert_eq!(fx.get("dst.txt"), "concurrent update");
                assert_eq!(fx.get("src.txt"), "mine");
                clean(&fx);
                continue;
            }
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
fn compensation_capture_falls_back_only_for_unsupported_errors() {
    for op in OPS {
        for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let destination = fx.root.join(op.destination());
            let fx = fx.with_hook(move |step| {
                if matches!(op, Op::Replace) && step == Step::EtagRechecked {
                    successor(&destination, "unchecked destination");
                }
                Ok(())
            });
            let _scope = FaultScope::new(&[(Primitive::Capture, 1, errno)]);
            if matches!(op, Op::Replace) {
                assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
                assert_eq!(fx.get(op.destination()), "unchecked destination");
            } else {
                assert!(op.run(&fx, &etag).unwrap().get("recovered").is_none());
            }
            clean(&fx);
        }
    }
}

/// Model a filesystem rejecting flags at every relevant call, rather than the
/// former Capture-only capability seam. Include both restore calls on undo.
fn no_flags() -> FaultScope {
    FaultScope::new(&[
        (Primitive::Move, 1, Errno::EINVAL),
        (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
        (Primitive::Capture, 1, Errno::EINVAL),
        (Primitive::Capture, 2, Errno::EINVAL),
        (Primitive::Restore, 1, Errno::EINVAL),
        (Primitive::Restore, 2, Errno::EINVAL),
    ])
}

#[test]
fn compensation_no_flags_precommit_errors_and_cancel_clean_temps() {
    for code in [
        ErrorCode::IoError,
        ErrorCode::Cancelled,
        ErrorCode::Conflict,
    ] {
        let fx = Fx::new();
        let etag = Op::Replace.prepare(&fx);
        let destination = fx.root.join("doc.txt");
        let cancel = fx.cancel.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::TempSynced {
                match code {
                    ErrorCode::IoError => return Err(FileError::errno(Errno::EIO)),
                    ErrorCode::Cancelled => cancel.cancel(),
                    _ => std::fs::write(&destination, "concurrent update").unwrap(),
                }
            }
            Ok(())
        });
        let _scope = no_flags();
        assert_eq!(Op::Replace.run(&fx, &etag).unwrap_err().code, code);
        assert_eq!(
            fx.get("doc.txt"),
            if code == ErrorCode::Conflict {
                "concurrent update"
            } else {
                "original"
            }
        );
        clean(&fx);
    }
}

#[test]
fn compensation_no_flags_plain_rename_has_one_link_and_no_leftovers() {
    use std::os::unix::fs::MetadataExt;
    let fx = Fx::new();
    fx.put("src.txt", "mine");
    let _scope = no_flags();
    let result = fx
        .ops
        .rename(
            &args(json!({"from": fx.p("src.txt"), "to": fx.p("dst.txt")})),
            &fx.cancel,
        )
        .unwrap();
    assert!(result.recovered.is_empty());
    assert_eq!(fx.get("dst.txt"), "mine");
    assert_eq!(
        std::fs::metadata(fx.root.join("dst.txt")).unwrap().nlink(),
        1
    );
    assert!(!fx.root.join("src.txt").exists());
    clean(&fx);
}

#[test]
fn compensation_no_flags_undo_conflict_settles_without_extra_links() {
    for op in OPS {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let destination = fx.root.join(op.destination());
        let fx = fx.with_hook(move |step| {
            if step == Step::EtagRechecked {
                successor(&destination, "concurrent update");
            }
            Ok(())
        });
        let _scope = no_flags();
        assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(fx.get(op.destination()), "concurrent update");
        if matches!(op, Op::Rename) {
            assert_eq!(fx.get("src.txt"), "mine");
        }
        clean(&fx);
    }
    let fx = Fx::new();
    fx.put("src.txt", "mine");
    let source = fx.root.join("src.txt");
    let fx = fx.with_hook(move |step| {
        if step == Step::Vacating {
            successor(&source, "source successor");
        }
        Ok(())
    });
    let _scope = no_flags();
    assert_eq!(
        fx.ops
            .rename(
                &args(json!({"from": fx.p("src.txt"), "to": fx.p("dst.txt")})),
                &fx.cancel
            )
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(fx.get("src.txt"), "source successor");
    assert!(!fx.root.join("dst.txt").exists());
    clean(&fx);
}

#[test]
fn compensation_no_flags_successor_races_keep_every_external_object() {
    for collide in [false, true] {
        let fx = Fx::new();
        fx.put("src.txt", "mine");
        let source = fx.root.join("src.txt");
        let target = fx.root.join("dst.txt");
        let fx = fx.with_hook(move |step| {
            if step == Step::Renamed {
                successor(&source, "source successor");
                successor(&target, "destination successor");
            }
            if collide && step == Step::Vacated {
                std::fs::write(&source, "created during vacancy").unwrap();
            }
            Ok(())
        });
        let _scope = no_flags();
        let result = fx
            .ops
            .rename(
                &args(json!({"from":fx.p("src.txt"),"to":fx.p("dst.txt")})),
                &fx.cancel,
            )
            .unwrap();
        let recovered: Vec<_> = result.recovered.iter().map(PathBuf::from).collect();
        assert!(contains_bytes(&recovered, "mine"));
        assert_eq!(fx.get("src.txt"), "source successor");
        assert_eq!(fx.get("dst.txt"), "destination successor");
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
            if step == Step::Captured
                && captures.fetch_add(1, Ordering::SeqCst)
                    == if matches!(op, Op::Rename) { 2 } else { 1 }
            {
                successor(&destination, "created during vacant undo");
            }
            Ok(())
        });
        if matches!(op, Op::Rename) {
            assert_eq!(op.run(&fx, &etag).unwrap_err().code, ErrorCode::Conflict);
            assert_eq!(fx.get("dst.txt"), "concurrent update");
            assert_eq!(fx.get("src.txt"), "mine");
            clean(&fx);
            continue;
        }
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
    // Exchange-first never vacates the source: dest successor is Conflict.
    assert_eq!(
        Op::Rename.run(&fx, &etag).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(fx.get("dst.txt"), "concurrent update");
    assert_eq!(fx.get("src.txt"), "mine");
    clean(&fx);
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
                    private_temp(&root)
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
            let _scope = FaultScope::new(&[(
                primitive,
                if matches!(op, Op::Rename) && primitive == Primitive::Unlink {
                    3
                } else {
                    1
                },
                Errno::EIO,
            )]);
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
            if step == Step::Disposing
                && (!matches!(op, Op::Rename) || !root.join("src.txt").exists())
            {
                let dir = recovery_dirs(&root).pop().unwrap();
                let slot = private_object(&dir);
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
    for phase in [Step::Renamed, Step::Moved] {
        let fx = Fx::new();
        fx.put("src.txt", "mine");
        let source = fx.root.join("src.txt");
        let target = fx.root.join("dst.txt");
        let fx = fx.with_hook(move |step| {
            if step == phase {
                if phase == Step::Renamed {
                    successor(&source, "source successor");
                }
                successor(&target, "destination successor");
            }
            Ok(())
        });
        let _scope = FaultScope::new(if phase == Step::Renamed {
            &[
                (Primitive::Move, 1, Errno::EINVAL),
                (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
            ]
        } else {
            &[]
        });
        let result = fx.ops.rename(
            &args(json!({"from":fx.p("src.txt"),"to":fx.p("dst.txt")})),
            &fx.cancel,
        );
        if phase == Step::Renamed {
            let recovered: Vec<_> = result
                .unwrap()
                .recovered
                .iter()
                .map(PathBuf::from)
                .collect();
            assert!(contains_bytes(&recovered, "mine"));
            assert_eq!(fx.get("src.txt"), "source successor");
            assert_eq!(fx.get("dst.txt"), "destination successor");
        } else {
            assert!(contains_bytes(
                &uncertain(&result.unwrap_err()),
                "destination successor"
            ));
        }
    }
}

#[test]
fn compensation_capture_collision_never_replaces_a_private_slot_squatter() {
    for unsupported in [false, true] {
        for op in OPS {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::EtagRechecked {
                    std::fs::rename(
                        root.join(op.destination()),
                        root.join("checked-destination"),
                    )
                    .unwrap();
                    std::fs::write(root.join(op.destination()), "unchecked destination").unwrap();
                }
                if step == Step::Exchanged {
                    let dir = recovery_dirs(&root).pop().unwrap();
                    std::fs::write(dir.join("slot-2"), "slot squatter only copy").unwrap();
                }
                Ok(())
            });
            if matches!(op, Op::Rename) {
                let error = op.run(&fx, &etag).unwrap_err();
                assert_eq!(error.code, ErrorCode::Conflict, "{unsupported}");
                assert_eq!(fx.get("dst.txt"), "unchecked destination");
                assert_eq!(fx.get("checked-destination"), "original");
                assert_eq!(fx.get("src.txt"), "mine");
                clean(&fx);
                continue;
            }
            let faults = [(
                Primitive::Capture,
                if matches!(op, Op::Rename) { 2 } else { 1 },
                Errno::EINVAL,
            )];
            let _scope = FaultScope::new(if unsupported { &faults } else { &[] });
            let kept = uncertain(&op.run(&fx, &etag).unwrap_err());
            let mut locations = kept;
            locations.push(fx.root.join(op.destination()));
            locations.push(fx.root.join("checked-destination"));
            assert!(contains_bytes(&locations, "slot squatter only copy"));
            assert!(contains_bytes(&locations, "original"));
            assert!(contains_bytes(&locations, "unchecked destination"));
            assert!(contains_bytes(
                &locations,
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
fn compensation_rename_vacate_verification_restores_unchecked_source_to_source() {
    let fx = Fx::new();
    let etag = Op::Rename.prepare(&fx);
    let root = fx.root.clone();
    let fx = fx.with_hook(move |step| {
        if step == Step::EtagRechecked {
            std::fs::rename(root.join("src.txt"), root.join("checked-source")).unwrap();
            std::fs::write(root.join("src.txt"), "unchecked source").unwrap();
        }
        Ok(())
    });
    assert_eq!(
        Op::Rename.run(&fx, &etag).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(fx.get("src.txt"), "unchecked source");
    assert_eq!(fx.get("dst.txt"), "original");
    assert_eq!(fx.get("checked-source"), "mine");
    assert!(!fx.steps.lock().unwrap().contains(&Step::Exchanged));
    clean(&fx);
}

#[test]
fn compensation_precommit_and_create_faults_prefer_uncertainty_to_the_initial_error() {
    for create in [false, true] {
        for primitive in [Primitive::Capture, Primitive::Unlink, Primitive::Rmdir] {
            // A replace temp is already private: capture faults cannot affect
            // its precommit cleanup. Exclusive create still needs capture.
            if !create && primitive == Primitive::Capture {
                continue;
            }
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
            if step == Step::Renamed {
                successor(
                    if change_source { &source } else { &target },
                    "successor only copy",
                );
            }
            Ok(())
        });
        let _scope = FaultScope::new(&[
            (Primitive::Move, 1, Errno::EINVAL),
            (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
        ]);
        let result = fx
            .ops
            .rename(
                &args(json!({"from":fx.p("src.txt"),"to":fx.p("dst.txt")})),
                &fx.cancel,
            )
            .unwrap();
        if change_source {
            assert_eq!(fx.get("src.txt"), "successor only copy");
            assert_eq!(fx.get("dst.txt"), "mine");
            clean(&fx);
        } else {
            assert!(contains_bytes(
                &result
                    .recovered
                    .iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>(),
                "mine"
            ));
            assert_eq!(fx.get("dst.txt"), "successor only copy");
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
    assert_eq!(slot_count(&dir), 2);
    assert!(dir.join("INTENT").is_file(), "unsettled R keeps INTENT");
}

thread_local! {
    static LOG: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Routes the scoped capture subscriber to the calling thread's buffer. The shared
/// logging helper keeps an INFO-enabled global subscriber installed, so parallel
/// calls cannot cache disabled interest before this scoped subscriber is entered.
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
    let _capture = crate::logging::test_capture_lock();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(ThreadLog)
        .with_ansi(false)
        .finish();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    for op in OPS {
        for retained_by_error in [false, true] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let destination = fx.root.join(op.destination());
            let fx = fx.with_hook(move |step| {
                if retained_by_error && matches!(op, Op::Replace) && step == Step::EtagRechecked {
                    successor(&destination, "unchecked destination");
                }
                Ok(())
            });
            LOG.with(|log| log.borrow_mut().clear());
            let primitive = if retained_by_error {
                Primitive::Capture
            } else {
                Primitive::Unlink
            };
            let _scope = FaultScope::new(&[(
                primitive,
                if matches!(op, Op::Rename) && primitive == Primitive::Unlink {
                    3
                } else {
                    1
                },
                Errno::EIO,
            )]);
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

#[test]
fn compensation_exchange_error_restores_vacated_source_without_plain_overwrite() {
    for errno in [
        Errno::EINVAL,
        Errno::ENOSYS,
        Errno::ENOTSUP,
        Errno::EIO,
        Errno::EXDEV,
        Errno::EPERM,
    ] {
        let fx = Fx::new();
        let etag = Op::Rename.prepare(&fx);
        let _scope = FaultScope::new(&[(Primitive::Exchange, 1, errno)]);
        let error = Op::Rename.run(&fx, &etag).unwrap_err();
        assert_eq!(
            error.code,
            if crate::file_ops::exchange::is_unsupported(errno) {
                ErrorCode::UnsafeFilesystem
            } else {
                ErrorCode::IoError
            },
            "{errno}"
        );
        assert_eq!(fx.get("src.txt"), "mine");
        assert_eq!(fx.get("dst.txt"), "original");
        assert!(!fx.steps.lock().unwrap().contains(&Step::Exchanged));
        clean(&fx);
    }
}

#[test]
fn compensation_vacate_mismatch_and_restore_collision_keep_every_object() {
    let fx = Fx::new();
    let etag = Op::Rename.prepare(&fx);
    let root = fx.root.clone();
    let fx = fx.with_hook(move |step| {
        if step == Step::EtagRechecked {
            std::fs::rename(root.join("src.txt"), root.join("checked-source")).unwrap();
            std::fs::write(root.join("src.txt"), "unchecked source").unwrap();
        }
        if step == Step::Captured {
            std::fs::write(root.join("src.txt"), "newest source").unwrap();
        }
        Ok(())
    });
    // Exchange-first refuses a source successor before the swap.
    let error = Op::Rename.run(&fx, &etag).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(fx.get("checked-source"), "mine");
    assert_eq!(fx.get("src.txt"), "unchecked source");
    assert_eq!(fx.get("dst.txt"), "original");
    assert!(!fx.steps.lock().unwrap().contains(&Step::Exchanged));
    clean(&fx);
}

#[test]
fn compensation_replace_cross_directory_exchange_errors_use_only_supported_fallbacks() {
    for op in [Op::Replace, Op::Write] {
        for errno in [
            Errno::EINVAL,
            Errno::ENOSYS,
            Errno::ENOTSUP,
            Errno::EIO,
            Errno::EXDEV,
            Errno::EPERM,
            Errno::ENOENT,
        ] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::TempCreated {
                    assert!(public_stages(&root).is_empty());
                    assert!(private_temp(&root).exists());
                }
                Ok(())
            });
            let _scope = FaultScope::new(&[(Primitive::Exchange, 1, errno)]);
            let result = op.run(&fx, &etag);
            if crate::file_ops::exchange::is_unsupported(errno) {
                assert!(result.unwrap().get("recovered").is_none());
                assert_eq!(fx.get("doc.txt"), "edited");
            } else {
                assert_eq!(
                    result.unwrap_err().code,
                    if errno == Errno::ENOENT {
                        ErrorCode::Conflict
                    } else {
                        ErrorCode::IoError
                    }
                );
                assert_eq!(fx.get("doc.txt"), "original");
            }
            clean(&fx);
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn compensation_tmpfs_replace_and_edit_exchange_across_recovery_directory() {
    use crate::file_ops::{atomic, read, resolve::Stat};
    use nix::fcntl::{OFlag, open};
    use nix::sys::stat::Mode;
    use std::os::fd::AsFd;

    // /dev is deliberately denied by file-tool policy. Exercise the exact shared
    // atomic commit used by edit and write-replace through held fds, without
    // changing that policy. Their API flows are covered on the ordinary fixture.
    let mut fx = Fx::new();
    fx._dir = tempfile::tempdir_in("/dev/shm").expect("Linux tmpfs fixture");
    fx.root = std::fs::canonicalize(fx._dir.path()).unwrap();
    assert_eq!(
        nix::sys::statfs::statfs(&fx.root)
            .unwrap()
            .filesystem_type(),
        nix::sys::statfs::TMPFS_MAGIC
    );
    fx.put("doc.txt", "original");
    let mut original = std::fs::File::open(fx.root.join("doc.txt")).unwrap();
    let stat = Stat::from_metadata(&original.metadata().unwrap());
    let etag = read::current_etag(&fx.ops, &mut original, &stat, &fx.cancel).unwrap();
    let dir = open(
        &fx.root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .unwrap();
    let root = fx.root.clone();
    let fx = fx.with_hook(move |step| {
        if step == Step::TempCreated {
            assert!(public_stages(&root).is_empty());
            assert!(private_temp(&root).exists());
        }
        if step == Step::Exchanged {
            assert_eq!(
                std::fs::read_to_string(private_temp(&root)).unwrap(),
                "original"
            );
            assert_eq!(
                std::fs::read_to_string(root.join("doc.txt")).unwrap(),
                "edited"
            );
        }
        Ok(())
    });
    let (_, recovered) = atomic::replace(
        &fx.ops,
        &dir,
        "doc.txt".as_ref(),
        &fx.root,
        original,
        &stat,
        &etag,
        b"edited",
        &fx.cancel,
    )
    .unwrap();
    assert!(recovered.is_empty());
    assert_eq!(
        nix::sys::stat::fstat(dir.as_fd()).unwrap().st_dev,
        std::os::unix::fs::MetadataExt::dev(&std::fs::metadata(fx.root.join("doc.txt")).unwrap())
    );
    assert!(
        fx.steps.lock().unwrap().contains(&Step::Exchanged),
        "real cross-directory exchange"
    );
    clean(&fx);
}

#[test]
fn compensation_replace_precommit_cleanup_never_captures_a_public_name() {
    let fx = Fx::new();
    let etag = Op::Replace.prepare(&fx);
    let fx = fx.with_hook(|step| {
        if step == Step::TempWritten {
            return Err(FileError::cancelled());
        }
        Ok(())
    });
    let _scope = FaultScope::new(&[(Primitive::Capture, 1, Errno::EIO)]);
    assert_eq!(
        Op::Replace.run(&fx, &etag).unwrap_err().code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        fault(Primitive::Capture),
        Err(Errno::EIO),
        "cleanup never attempts capture"
    );
    assert_eq!(fx.get("doc.txt"), "original");
    clean(&fx);
}

#[test]
fn compensation_no_flags_exchange_less_rename_restores_source_with_one_link() {
    use std::os::unix::fs::MetadataExt;
    let fx = Fx::new();
    let etag = Op::Rename.prepare(&fx);
    let _scope = FaultScope::new(&[
        (Primitive::Capture, 1, Errno::EINVAL),
        (Primitive::Exchange, 1, Errno::EINVAL),
        (Primitive::Restore, 1, Errno::EINVAL),
    ]);
    assert_eq!(
        Op::Rename.run(&fx, &etag).unwrap_err().code,
        ErrorCode::UnsafeFilesystem
    );
    assert_eq!(fx.get("src.txt"), "mine");
    assert_eq!(fx.get("dst.txt"), "original");
    assert_eq!(
        std::fs::metadata(fx.root.join("src.txt")).unwrap().nlink(),
        1
    );
    clean(&fx);
}

/// NFS silly-renames an unlinked-but-open file into its directory, so the
/// recovery directory's rmdir fails while any descriptor on a disposed object is
/// still open. Every operation must close its held fds before the rmdir.
#[cfg(target_os = "linux")]
#[test]
fn compensation_closes_held_descriptors_before_removing_the_recovery_directory() {
    use std::sync::{Arc, Mutex};

    use crate::file_ops::exchange::RMDIR_PROBE;

    /// Descriptors of this process that point under `root` (a disposed file
    /// still open shows as `<path> (deleted)`).
    fn open_under(root: &Path) -> Vec<String> {
        std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
            .map(|target| target.to_string_lossy().into_owned())
            .filter(|target| target.starts_with(root.to_string_lossy().as_ref()))
            // the directory descriptors the operation itself uses stay open
            .filter(|target| !target.ends_with(".wsmp-recover") && !Path::new(target).is_dir())
            // Cleanup exclusion is outside R; unlike disposed objects, this
            // inode must remain held through rmdir and is not unlinked yet.
            .filter(|target| !target.contains("/.wsmp-lock-.wsmp-recover-"))
            .collect()
    }

    for op in [Op::Replace, Op::Write, Op::Rename] {
        let fx = Fx::new();
        let etag = op.prepare(&fx);
        let seen = Arc::new(Mutex::new(None));
        let (root, sink) = (fx.root.clone(), seen.clone());
        let _scope = FaultScope::new(&[]);
        RMDIR_PROBE.with(|probe| {
            *probe.borrow_mut() = Some(Box::new(move || {
                *sink.lock().unwrap() = Some(open_under(&root));
            }));
        });
        op.run(&fx, &etag).unwrap();
        let open = seen.lock().unwrap().clone().expect("the rmdir ran");
        assert!(open.is_empty(), "{op:?}: still open at rmdir: {open:?}");
    }
}

/// A refused vacate moved nothing: an ordinary error (as before recovery existed),
/// the source and destination untouched, no recovery directory left behind.
/// EIO may follow an effective rename, so it stays uncertain.
#[test]
fn compensation_failed_vacate_is_a_plain_settled_error() {
    for (errno, code) in [
        (Errno::ENOENT, ErrorCode::Conflict),
        (Errno::EXDEV, ErrorCode::IoError),
        (Errno::EACCES, ErrorCode::IoError),
        (Errno::ENOSPC, ErrorCode::IoError),
    ] {
        let fx = Fx::new();
        let etag = Op::Rename.prepare(&fx);
        let _faults = FaultScope::new(&[
            (Primitive::ProbeExchange, 1, Errno::EINVAL),
            (Primitive::Capture, 1, errno),
        ]);
        let error = Op::Rename.run(&fx, &etag).unwrap_err();
        assert_eq!(error.code, code, "{errno}: {error:?}");
        assert_eq!(fx.get("src.txt"), "mine", "{errno}");
        assert_eq!(fx.get("dst.txt"), "original", "{errno}");
        assert!(recovery_dirs(&fx.root).is_empty(), "{errno}");
    }
    let fx = Fx::new();
    let etag = Op::Rename.prepare(&fx);
    let _faults = FaultScope::new(&[
        (Primitive::ProbeExchange, 1, Errno::EINVAL),
        (Primitive::Capture, 1, Errno::EIO),
    ]);
    let error = Op::Rename.run(&fx, &etag).unwrap_err();
    assert_eq!(error.code, ErrorCode::UncertainOutcome, "{error:?}");
}

/// An exchange that reports an error may still have taken effect: the slot goes
/// back to the source name only while it still holds the checked source.
#[test]
fn compensation_exchange_error_never_restores_an_unproven_slot_to_the_source() {
    let fx = Fx::new();
    let etag = Op::Rename.prepare(&fx);
    let root = fx.root.clone();
    let fx = fx.with_hook(move |step| {
        if step == Step::Captured {
            // the slot no longer holds the checked destination
            let slot = recovery_dirs(&root).pop().unwrap().join("slot-1");
            std::fs::remove_file(&slot).unwrap();
            std::fs::write(&slot, "destination object").unwrap();
        }
        Ok(())
    });
    let _faults = FaultScope::after_effect(&[(Primitive::Exchange, 1, Errno::EIO)]);
    let error = Op::Rename.run(&fx, &etag).unwrap_err();
    let kept = uncertain(&error);
    assert!(contains_bytes(&kept, "destination object"));
    assert!(
        !fx.root.join("src.txt").exists(),
        "leftover destination was captured from the source name"
    );
    assert_eq!(fx.get("dst.txt"), "mine");
}

#[test]
fn supervised_recovery_shares_private_staging_compensation_and_person_log() {
    let _capture = crate::logging::test_capture_lock();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(ThreadLog)
        .with_ansi(false)
        .finish();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    for op in [Op::Replace, Op::Write, Op::Rename] {
        for state in ["clean", "cleanup", "uncertain"] {
            let fx = Fx::new();
            let etag = op.prepare(&fx);
            let destination = fx.root.join(op.destination());
            let root = fx.root.clone();
            let cancel = fx.cancel.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::TempCreated {
                    assert!(private_temp(&root).is_file());
                    assert!(public_stages(&root).is_empty());
                }
                if step == Step::Exchanged {
                    // A late cancellation cannot change the committed outcome.
                    cancel.cancel();
                    if state == "uncertain" {
                        if matches!(op, Op::Rename) {
                            // Exchange-first leaves D under the source name.
                            std::fs::rename(root.join("src.txt"), root.join("prior-destination"))
                                .unwrap();
                            std::fs::write(root.join("src.txt"), "unchecked displaced writer")
                                .unwrap();
                        } else {
                            let displaced = recovery_dirs(&root).pop().unwrap().join("tmp");
                            std::fs::rename(&displaced, root.join("prior-destination")).unwrap();
                            std::fs::write(&displaced, "unchecked displaced writer").unwrap();
                        }
                        successor(&destination, "newest external writer");
                    }
                }
                Ok(())
            });
            let (name, args, body) = match op {
                Op::Replace => (
                    "edit",
                    json!({"path":fx.p("doc.txt"), "expectedEtag":etag,
                    "edits":[{"oldText":"original", "newText":"edited"}]}),
                    None,
                ),
                Op::Write => (
                    "write",
                    json!({"path":fx.p("doc.txt"), "expectedEtag":etag,
                    "ifExists":"replace"}),
                    Some(b"edited".to_vec()),
                ),
                Op::Rename => (
                    "rename",
                    json!({"from":fx.p("src.txt"), "to":fx.p("dst.txt"),
                    "overwrite":true, "expectedEtag":etag}),
                    None,
                ),
            };
            let prepared = fx
                .ops
                .prepare_supervised(
                    name,
                    args,
                    body,
                    &crate::file_ops::EtagKey::from_bytes([19; 32]),
                    &fx.cancel,
                )
                .unwrap();
            assert_eq!(prepared.child_input().blocked, None, "{op:?}: {state}");
            LOG.with(|log| log.borrow_mut().clear());
            let faults = match state {
                "cleanup" => vec![(
                    Primitive::Unlink,
                    if matches!(op, Op::Rename) { 3 } else { 1 },
                    Errno::EIO,
                )],
                "uncertain" => vec![(Primitive::Capture, 1, Errno::EIO)],
                _ => vec![],
            };
            let _scope = FaultScope::new(&faults);
            let result = fx.ops.execute_supervised(prepared, &fx.cancel);
            let kept = if state == "uncertain" {
                let error = result.unwrap_err();
                let kept = uncertain(&error);
                assert_eq!(error.code, ErrorCode::UncertainOutcome);
                assert_eq!(fx.get(op.destination()), "newest external writer");
                assert_eq!(fx.get("prior-destination"), "original");
                kept
            } else {
                let result = result.unwrap();
                let kept = result.get("recovered").map(paths).unwrap_or_default();
                assert_eq!(kept.is_empty(), state == "clean");
                let _ = name;
                assert_eq!(
                    fx.get(op.destination()),
                    if matches!(op, Op::Rename) {
                        "mine"
                    } else {
                        "edited"
                    }
                );
                kept
            };
            let log = LOG.with(|log| String::from_utf8(log.borrow().clone()).unwrap());
            assert_eq!(
                log.contains("file recovery retained"),
                state != "clean",
                "{log}"
            );
            for path in kept {
                assert!(
                    log.contains(path.to_str().unwrap()),
                    "person must receive {path:?}: {log}"
                );
            }
            for content in ["original", "edited", "mine", "newest external writer"] {
                assert!(!log.contains(content), "log contains file content: {log}");
            }
        }
    }
}

#[test]
fn supervised_delete_capture_preserves_successors_and_logs_recovery_only_to_person() {
    let _capture = crate::logging::test_capture_lock();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(ThreadLog)
        .with_ansi(false)
        .finish();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    for state in ["clean", "cleanup", "successor", "swapped", "cancel"] {
        let fx = Fx::new();
        fx.put("doc.txt", "original");
        let path = fx.root.join("doc.txt");
        let cancel = fx.cancel.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::Vacating {
                if state == "cancel" {
                    cancel.cancel();
                }
                if state == "swapped" {
                    successor(&path, "newest external writer");
                }
            }
            if step == Step::Vacated {
                cancel.cancel(); // capture already committed: must finish safely
                if state == "successor" {
                    std::fs::write(&path, "newest external writer").unwrap();
                }
            }
            Ok(())
        });
        let prepared = fx
            .ops
            .prepare_supervised(
                "delete",
                json!({"path":fx.p("doc.txt"),"expectedEtag":fx.etag("doc.txt")}),
                None,
                &crate::file_ops::EtagKey::from_bytes([19; 32]),
                &fx.cancel,
            )
            .unwrap();
        assert!(prepared.child_input().blocked.is_none());
        LOG.with(|log| log.borrow_mut().clear());
        let faults = if state == "cleanup" {
            vec![(Primitive::Unlink, 1, Errno::EIO)]
        } else {
            vec![]
        };
        let _scope = FaultScope::new(&faults);
        let result = fx.ops.execute_supervised(prepared, &fx.cancel);
        if matches!(state, "cancel" | "swapped") {
            assert_eq!(
                result.unwrap_err().code,
                if state == "cancel" {
                    ErrorCode::Cancelled
                } else {
                    ErrorCode::Conflict
                }
            );
            assert_eq!(
                fx.get("doc.txt"),
                if state == "cancel" {
                    "original"
                } else {
                    "newest external writer"
                }
            );
            assert!(!FaultScope::calls().contains(&Primitive::Unlink));
            assert!(recovery_dirs(&fx.root).is_empty());
            continue;
        }
        let result = result.unwrap();
        assert_eq!(result["deleted"], true);
        assert_eq!(result["type"], "file");
        if state == "successor" {
            assert_eq!(fx.get("doc.txt"), "newest external writer");
        } else {
            assert!(!fx.root.join("doc.txt").exists());
        }
        let kept = result.get("recovered").map(paths).unwrap_or_default();
        assert_eq!(kept.is_empty(), state != "cleanup");
        let log = LOG.with(|log| String::from_utf8(log.borrow().clone()).unwrap());
        assert_eq!(
            log.contains("file recovery retained"),
            state == "cleanup",
            "{log}"
        );
        for path in kept {
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
            assert!(log.contains(path.to_str().unwrap()), "{log}");
        }
        assert!(!log.contains("newest external writer"));
        assert_eq!(result["deleted"], json!(true));
        assert_eq!(result["type"], json!("file"));
    }
}
