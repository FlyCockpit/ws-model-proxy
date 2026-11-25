//! Linux descriptor evidence: no descriptor of this process is still open on
//! an inode when the unlink that disposes or restores it runs.

use super::*;

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_final_unlink_has_no_descriptor_on_disposed_inode() {
    use crate::services::file_ops::fs::exchange::UNLINK_PROBE;
    use std::os::unix::fs::MetadataExt;
    for delete_op in [false, true] {
        for method in METHODS {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let original = std::fs::metadata(fx.root.join("doc")).unwrap();
            let original_id = (original.dev(), original.ino());
            let root = fx.root.clone();
            let checks = Arc::new(Mutex::new(0usize));
            let checked = Arc::clone(&checks);
            let _scope = FaultScope::new(&method.faults());
            UNLINK_PROBE.with(|probe| {
                *probe.borrow_mut() = Some(Box::new(move || {
                    let nth = *checked.lock().unwrap() + 1;
                    // Link order: private probe alias, published T alias,
                    // captured original. Other Held objects may still be live.
                    // The probe alias unlink (nth 1) deliberately keeps T's own proof
                    // open: it pins T's inode against number reuse, and the unlinked
                    // dentry is the alias's, not the one T's proof was opened on.
                    if !delete_op && matches!(method, PublishMethod::Link) && nth == 1 {
                        *checked.lock().unwrap() += 1;
                        return;
                    }
                    let disposed_id = if !delete_op && matches!(method, PublishMethod::Link) && nth == 2 {
                        let dirs = recovery_dirs(&root);
                        let temp = std::fs::metadata(dirs[0].join("tmp")).unwrap();
                        (temp.dev(), temp.ino())
                    } else { original_id };
                    for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                        let path = entry.unwrap().path();
                        if let Ok(metadata) = std::fs::metadata(&path) {
                            assert_ne!((metadata.dev(), metadata.ino()), disposed_id,
                                "delete={delete_op}/{method:?}/unlink={nth}: disposed inode fd remains open: {path:?}");
                        }
                    }
                    *checked.lock().unwrap() += 1;
                }));
            });
            if delete_op {
                delete(&fx).unwrap();
            } else {
                ReplaceOp::Write.run(&fx, &etag).unwrap();
            }
            assert_eq!(
                *checks.lock().unwrap(),
                if delete_op { 1 } else { method.clean_unlinks() }
            );
            clean(&fx);
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_restore_link_unlink_has_no_descriptor_on_disposed_inode() {
    use crate::services::file_ops::fs::exchange::UNLINK_PROBE;
    use std::os::unix::fs::MetadataExt;
    for method in METHODS {
        let fx = Fx::new();
        let etag = prepare(&fx);
        let original = std::fs::metadata(fx.root.join("doc")).unwrap();
        let original_id = (original.dev(), original.ino());
        let root = fx.root.clone();
        let checks = Arc::new(Mutex::new(0usize));
        let checked = Arc::clone(&checks);
        let mut faults = method.faults();
        faults.extend([
            (method.primitive(), 1, Errno::EIO),
            (Primitive::Restore, 1, Errno::EINVAL),
        ]);
        let _scope = FaultScope::new(&faults);
        UNLINK_PROBE.with(|probe| {
            *probe.borrow_mut() = Some(Box::new(move || {
                let nth = *checked.lock().unwrap() + 1;
                if matches!(method, PublishMethod::Link) && nth == 1 {
                    // Probe alias unlink: T's own proof stays open by design.
                    *checked.lock().unwrap() += 1;
                    return;
                }
                let restore_unlink = match method { PublishMethod::NoReplace => 1, PublishMethod::Link => 2 };
                let disposed_id = if nth == restore_unlink { original_id } else {
                    let dirs = recovery_dirs(&root);
                    let temp = std::fs::metadata(dirs[0].join(match method { PublishMethod::NoReplace => "probe", PublishMethod::Link => "tmp" })).unwrap();
                    (temp.dev(), temp.ino())
                };
                for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                    let path = entry.unwrap().path();
                    if let Ok(metadata) = std::fs::metadata(&path) {
                        assert_ne!((metadata.dev(), metadata.ino()), disposed_id,
                            "{method:?}/unlink={nth}: fd pins restore alias or private temp: {path:?}");
                    }
                }
                *checked.lock().unwrap() += 1;
            }));
        });
        let error = ReplaceOp::Write.run(&fx, &etag).unwrap_err();
        assert_eq!(error.code, ErrorCode::IoError);
        assert_eq!(fx.get("doc"), ORIGINAL);
        assert_eq!(count(&FaultScope::calls(), Primitive::RestoreLink), 1);
        assert_eq!(
            *checks.lock().unwrap(),
            if matches!(method, PublishMethod::NoReplace) {
                2
            } else {
                3
            }
        );
        clean(&fx);
    }

    // Unsupported overwrite exchange restores the captured source through a
    // link as well; its inspected Held must also be closed before alias unlink.
    let fx = Fx::new();
    fx.put("src", "source contents\n");
    fx.put("dst", ORIGINAL);
    let etag = fx.etag("dst");
    let source = std::fs::metadata(fx.root.join("src")).unwrap();
    let source_id = (source.dev(), source.ino());
    let checks = Arc::new(Mutex::new(0usize));
    let checked = Arc::clone(&checks);
    let root = fx.root.clone();
    let _scope = FaultScope::new(&[
        (Primitive::Exchange, 1, Errno::EINVAL),
        (Primitive::Restore, 1, Errno::EINVAL),
    ]);
    UNLINK_PROBE.with(|probe| {
        *probe.borrow_mut() = Some(Box::new(move || {
            if recovery_dirs(&root)
                .first()
                .is_none_or(|r| !r.join("slot-1").exists() && !r.join("slot-2").exists())
            {
                return;
            }
            for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                let path = entry.unwrap().path();
                if let Ok(metadata) = std::fs::metadata(&path) {
                    assert_ne!(
                        (metadata.dev(), metadata.ino()),
                        source_id,
                        "overwrite source Held remains live at restore alias unlink"
                    );
                }
            }
            *checked.lock().unwrap() += 1;
        }));
    });
    let error = fx.ops.rename(&args(json!({"from": fx.p("src"), "to": fx.p("dst"), "overwrite": true, "expectedEtag": etag})), &fx.cancel).unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsafeFilesystem);
    assert_eq!(fx.get("src"), "source contents\n");
    assert_eq!(fx.get("dst"), ORIGINAL);
    // Exchange-first fails closed before capturing, so no restore-alias unlink.
    assert_eq!(*checks.lock().unwrap(), 0);
    clean(&fx);
}

/// C5A-2: a failed observation of the displaced object must release T's peer
/// descriptor before restore unlinks slot-2.
#[cfg(target_os = "linux")]
#[test]
fn replace_undo_releases_peer_descriptor_before_restore_unlink() {
    for op in REPLACE_OPS {
        let fx = Fx::new();
        let etag = prepare(&fx);
        let _scope = FaultScope::new(&[
            (Primitive::Identity, 1, Errno::EIO),
            (Primitive::Identity, 2, Errno::ESTALE),
            (Primitive::Restore, 1, Errno::EINVAL),
        ]);
        let checks = watch_private_unlinks(&fx, &["slot-2"]);
        let error = op.run(&fx, &etag).unwrap_err();
        assert_eq!(error.code, ErrorCode::UncertainOutcome);
        assert_eq!(checks.lock().unwrap().len(), 1, "{op:?}");
        assert_eq!(fx.get("doc"), EDITED);
        assert!(has_bytes(&kept(&error), ORIGINAL));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_plain_link_rename_closes_both_proofs_before_unlink() {
    for racer in [false, true] {
        let fx = Fx::new();
        fx.put("src", ORIGINAL);
        let dst = fx.root.join("dst");
        let fx = fx.with_hook(move |step| {
            if racer && step == Step::Renamed {
                save(&dst, RACER);
            }
            Ok(())
        });
        let _scope = FaultScope::new(&[
            (Primitive::Move, 1, Errno::EINVAL),
            (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
        ]);
        let checks = watch_private_unlinks(&fx, &["slot-1"]);
        let result = fx
            .ops
            .rename(
                &args(json!({"from":fx.p("src"),"to":fx.p("dst")})),
                &fx.cancel,
            )
            .unwrap();
        assert_eq!(checks.lock().unwrap().len(), usize::from(!racer));
        if racer {
            assert!(has_bytes(
                &result
                    .recovered
                    .iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>(),
                ORIGINAL
            ));
            assert_eq!(fx.get("dst"), RACER);
        } else {
            assert!(result.recovered.is_empty());
            assert_eq!(fx.get("dst"), ORIGINAL);
            clean(&fx);
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_overwrite_initial_mismatch_closes_matching_proofs_for_restore() {
    for captured_destination in [false, true] {
        let fx = Fx::new();
        fx.put("src", ORIGINAL);
        fx.put("dst", RACER);
        let etag = fx.etag("dst");
        let src = fx.root.join("src");
        let dst = fx.root.join("dst");
        let fx = fx.with_hook(move |step| {
            if captured_destination && step == Step::EtagRechecked {
                std::fs::rename(&dst, &src).unwrap();
            }
            Ok(())
        });
        let mut faults = vec![(Primitive::Restore, 1, Errno::EINVAL)];
        if !captured_destination {
            faults.push((Primitive::Identity, 3, Errno::EIO));
        }
        let _scope = FaultScope::new(&faults);
        let checks = watch_private_unlinks(&fx, &["slot-1"]);
        let error = fx
            .ops
            .rename(
                &args(json!({"from":fx.p("src"),"to":fx.p("dst"),
            "overwrite":true,"expectedEtag":etag})),
                &fx.cancel,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        // Exchange-first refuses dest/src identity failures before capturing.
        assert_eq!(checks.lock().unwrap().len(), 0);
        assert_eq!(
            fx.get("src"),
            if captured_destination {
                RACER
            } else {
                ORIGINAL
            }
        );
        if !captured_destination {
            assert_eq!(fx.get("dst"), RACER);
        }
        clean(&fx);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_supported_overwrite_undo_releases_source_and_destination() {
    use crate::services::file_ops::fs::exchange::UNLINK_PROBE;
    use std::os::unix::fs::MetadataExt;
    let fx = Fx::new();
    fx.put("src", ORIGINAL);
    fx.put("dst", RACER);
    let etag = fx.etag("dst");
    let src_meta = std::fs::metadata(fx.root.join("src")).unwrap();
    let dst_meta = std::fs::metadata(fx.root.join("dst")).unwrap();
    let ids = [
        (dst_meta.dev(), dst_meta.ino()),
        (src_meta.dev(), src_meta.ino()),
    ];
    let _scope = FaultScope::new(&[
        (Primitive::Identity, 4, Errno::EIO),
        (Primitive::Restore, 1, Errno::EINVAL),
        (Primitive::Restore, 2, Errno::EINVAL),
    ]);
    let checks = Arc::new(Mutex::new(0usize));
    let checked = Arc::clone(&checks);
    let root = fx.root.clone();
    UNLINK_PROBE.with(|probe| {
        *probe.borrow_mut() = Some(Box::new(move || {
            if recovery_dirs(&root)
                .first()
                .is_none_or(|r| !r.join("slot-1").exists() && !r.join("slot-2").exists())
            {
                return;
            }
            let nth = *checked.lock().unwrap();
            assert!(nth < ids.len());
            for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                if let Ok(metadata) = std::fs::metadata(entry.unwrap().path()) {
                    assert_ne!(
                        (metadata.dev(), metadata.ino()),
                        ids[nth],
                        "undo fd pins restored inode at unlink {nth}"
                    );
                }
            }
            *checked.lock().unwrap() += 1;
        }));
    });
    let error = fx
        .ops
        .rename(
            &args(json!({"from":fx.p("src"),"to":fx.p("dst"),
        "overwrite":true,"expectedEtag":etag})),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    // Exchange-first identity failure is before the swap; nothing to restore.
    assert_eq!(*checks.lock().unwrap(), 0);
    assert_eq!(fx.get("src"), ORIGINAL);
    assert_eq!(fx.get("dst"), RACER);
    clean(&fx);
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_supported_replace_undo_releases_original_before_restore() {
    for op in REPLACE_OPS {
        let fx = Fx::new();
        let etag = prepare(&fx);
        let _scope = FaultScope::new(&[
            (Primitive::Identity, 1, Errno::EIO),
            (Primitive::Restore, 1, Errno::EINVAL),
        ]);
        let checks = watch_private_unlinks(&fx, &["slot-2", "tmp"]);
        let error = op.run(&fx, &etag).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(checks.lock().unwrap().len(), 2);
        assert_eq!(fx.get("doc"), ORIGINAL);
        clean(&fx);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_supported_replace_undo_releases_temp_before_alias_restore() {
    for op in REPLACE_OPS {
        let fx = Fx::new();
        let etag = prepare(&fx);
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::Exchanged {
                let private = recovery_dirs(&root)[0].join("tmp");
                // Preserve the displaced original, then introduce a real T
                // alias in its slot. A lost capture reply leaves another T alias.
                std::fs::rename(&private, root.join("saved-original")).unwrap();
                std::fs::hard_link(root.join("doc"), &private).unwrap();
            }
            Ok(())
        });
        let _scope = FaultScope::with_after_effects(
            &[(Primitive::Restore, 1, Errno::EINVAL)],
            &[(Primitive::Capture, 1, Errno::EIO)],
        );
        let checks = watch_private_unlinks(&fx, &["tmp"]);
        let error = op.run(&fx, &etag).unwrap_err();
        assert!(has_bytes(&kept(&error), EDITED));
        assert_eq!(checks.lock().unwrap().len(), 1);
        assert_eq!(fx.get("doc"), EDITED);
        assert_eq!(fx.get("saved-original"), ORIGINAL);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_exclusive_create_error_closes_file_before_cleanup() {
    let fx = Fx::new().with_hook(|step| {
        if step == Step::Created {
            return Err(FileError::errno(Errno::EIO));
        }
        Ok(())
    });
    let _scope = FaultScope::new(&[]);
    let checks = watch_private_unlinks(&fx, &["slot-1"]);
    let error = fx
        .ops
        .execute(
            "write",
            json!({"path":fx.p("created"),
        "content":EDITED,"ifExists":"fail"}),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::IoError);
    assert_eq!(checks.lock().unwrap().len(), 1);
    assert!(!fx.root.join("created").exists());
    clean(&fx);
}
