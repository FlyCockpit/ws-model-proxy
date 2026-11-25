use super::*;
use crate::services::file_ops::Step;
use crate::services::file_ops::journal::exchange::FaultScope;
use crate::services::file_ops::tests::Fx;

fn root(fx: &Fx) -> OwnedFd {
    nix::fcntl::open(
        &fx.root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .unwrap()
}

#[test]
fn restore_uses_recorded_origin_fd_and_name_even_after_parent_rename() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("source-dir/original-name", "captured object");
    fx.put("other-dir/original-name", "unrelated object");
    let source_dir = nix::fcntl::open(
        &fx.root.join("source-dir"),
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .unwrap();
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let slot = recovery
        .capture(&source_dir, "original-name".as_ref(), &path)
        .unwrap();
    std::fs::rename(fx.root.join("source-dir"), fx.root.join("renamed-parent")).unwrap();
    drop(source_dir);
    assert!(recovery.restore(fx.ops.context(), &slot));
    assert_eq!(fx.get("renamed-parent/original-name"), "captured object");
    assert_eq!(fx.get("other-dir/original-name"), "unrelated object");
    assert!(!fx.root.join("original-name").exists());
    assert!(recovery.finish().is_empty());
}

#[test]
fn moved_origin_cannot_be_reclaimed_by_a_successor() {
    let fx = Fx::new();
    let parent = root(&fx);
    let held_file = std::fs::File::open(fx.put("source", "checked source")).unwrap();
    let held = Held::from_file(&held_file).unwrap();
    let origin = Origin::new(&parent, "source".as_ref(), &fx.root.join("source")).unwrap();
    fx.put("destination", "foreign successor");
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let mut slot = recovery
        .capture(
            &parent,
            "destination".as_ref(),
            &fx.root.join("destination"),
        )
        .unwrap();
    assert!(!recovery.reclaim_origin(&mut slot, &held, origin));
    assert!(recovery.restore(fx.ops.context(), &slot));
    assert_eq!(fx.get("source"), "checked source");
    assert_eq!(fx.get("destination"), "foreign successor");
    assert!(recovery.finish().is_empty());
}

#[test]
fn dispose_rejects_equal_path_snapshot_of_freed_and_recreated_object() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("sample", "old unheld object");
    let stale = Stat::from_metadata(&std::fs::symlink_metadata(&path).unwrap());
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, "recreated only copy").unwrap();
    let recreated = Stat::from_metadata(&std::fs::symlink_metadata(&path).unwrap());
    assert_eq!(stale.dev, recreated.dev, "same filesystem");
    // Immediate reuse is permitted, not promised (ext4 reuses; APFS/tmpfs
    // may not). When observed, the stale identity equals the successor.
    if stale.ino == recreated.ino {
        assert!(stale.same_object(&recreated));
    }
    let held_file = std::fs::File::open(fx.put("held", "different pinned inode")).unwrap();
    let mut held = Held::from_file(&held_file).unwrap();
    // Simulate even a matching recycled/path-derived snapshot. This test
    // deterministically proves disposal ignores it and checks the live fd;
    // it does not claim to force inode reuse on every filesystem.
    held.stat = recreated;
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
    let named = Stat::from_raw(
        &fstatat(
            recovery.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .unwrap(),
    );
    assert!(
        named.same_object(&held.stat),
        "path-derived proof would allow deletion"
    );
    assert!(!recovery.holds(&slot, &held));
    assert!(!recovery.dispose(fx.ops.context(), &slot, &mut held));
    let recovered = recovery.finish();
    assert_eq!(
        std::fs::read_to_string(&recovered[0]).unwrap(),
        "recreated only copy"
    );
}

#[test]
fn unheld_object_is_retained_and_reported_in_recovered() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("sample", "unheld only copy");
    let mut held = Held {
        fd: None,
        stat: Stat::from_metadata(&std::fs::metadata(&path).unwrap()),
        open_error: None,
    };
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
    assert!(
        recovery.matches_for_restore(&slot, &held),
        "non-deleting restoration may use a snapshot"
    );
    assert!(!recovery.holds(&slot, &held));
    assert!(!recovery.dispose(fx.ops.context(), &slot, &mut held));
    let result = crate::services::file_ops::ops::mutate::RenameResult {
        etag: None,
        recovered: recovery.finish(),
    };
    assert_eq!(
        std::fs::read_to_string(&result.recovered[0]).unwrap(),
        "unheld only copy"
    );
    assert!(serde_json::to_value(result).unwrap()["recovered"].is_array());
}

#[test]
fn held_open_pins_regular_symlink_and_directory_objects() {
    let fx = Fx::new();
    let parent = root(&fx);
    fx.put("file", "bytes");
    std::os::unix::fs::symlink("missing-target", fx.root.join("symlink")).unwrap();
    std::fs::create_dir(fx.root.join("directory")).unwrap();
    for name in ["file", "symlink", "directory"] {
        let stat = Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join(name)).unwrap());
        let held = Held::open(&parent, name.as_ref(), stat).unwrap();
        assert!(held.fd.is_some(), "{name}");
        std::fs::rename(fx.root.join(name), fx.root.join("moved")).unwrap();
        let now = Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join("moved")).unwrap());
        assert!(held.identity().unwrap().same_object(&now));
        if name == "directory" {
            std::fs::remove_dir(fx.root.join("moved")).unwrap();
        } else {
            std::fs::remove_file(fx.root.join("moved")).unwrap();
        }
        assert!(
            held.identity().unwrap().same_object(&now),
            "unlinked inode is still pinned"
        );
    }
}

#[test]
fn held_open_refuses_a_name_changed_since_lstat() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("sample", "checked");
    let stat = Stat::from_metadata(&std::fs::metadata(&path).unwrap());
    // Keep the old inode alive to make this mismatch deterministic.
    std::fs::rename(&path, fx.root.join("old")).unwrap();
    std::fs::write(&path, "unchecked successor").unwrap();
    let error = Held::open(&parent, "sample".as_ref(), stat).err().unwrap();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(fx.get("sample"), "unchecked successor");
    assert_eq!(fx.get("old"), "checked");
}

#[test]
fn restore_fallback_keeps_directories_and_unsupported_links() {
    for errno in [
        None,
        Some(Errno::EPERM),
        Some(Errno::ENOTSUP),
        Some(Errno::EMLINK),
        Some(Errno::EIO),
    ] {
        let fx = Fx::new();
        let parent = root(&fx);
        let path = fx.root.join("sample");
        if errno.is_none() {
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("child"), "directory bytes").unwrap();
        } else {
            std::fs::write(&path, "file bytes").unwrap();
        }
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
        let mut faults = vec![(Primitive::Restore, 1, Errno::EINVAL)];
        if let Some(errno) = errno {
            faults.push((Primitive::RestoreLink, 1, errno));
        } else {
            faults.push((Primitive::RestoreLink, 1, Errno::EIO));
        }
        let _scope = FaultScope::new(&faults);
        assert!(!recovery.restore(fx.ops.context(), &slot));
        if errno.is_none() {
            assert_eq!(
                fault(Primitive::RestoreLink),
                Err(Errno::EIO),
                "directories never attempt the link fallback"
            );
        }
        assert_eq!(recovery.uncertain().code, ErrorCode::UncertainOutcome);
        let kept = recovery.path.join(&slot.name);
        assert_eq!(
            std::fs::read_to_string(if errno.is_none() {
                kept.join("child")
            } else {
                kept
            })
            .unwrap(),
            if errno.is_none() {
                "directory bytes"
            } else {
                "file bytes"
            }
        );
        assert!(!path.exists());
    }
}

#[test]
fn restore_fallback_never_overwrites_an_existing_public_object() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("sample", "displaced original");
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
    std::fs::write(&path, "newest public object").unwrap();
    let _scope = FaultScope::new(&[(Primitive::Restore, 1, Errno::EINVAL)]);
    assert!(!recovery.restore(fx.ops.context(), &slot));
    assert_eq!(fx.get("sample"), "newest public object");
    assert_eq!(
        std::fs::read_to_string(recovery.path.join(&slot.name)).unwrap(),
        "displaced original"
    );
    assert_eq!(recovery.uncertain().code, ErrorCode::UncertainOutcome);
}

#[test]
fn restore_fallback_disposal_keeps_a_private_slot_successor() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("sample", "linked original");
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
    let private = recovery.path.join(&slot.name);
    let fx = fx.with_hook(move |step| {
        if step == Step::Disposing {
            std::fs::remove_file(&private).unwrap();
            std::fs::write(&private, "private successor").unwrap();
        }
        Ok(())
    });
    let _scope = FaultScope::new(&[(Primitive::Restore, 1, Errno::EINVAL)]);
    assert!(!recovery.restore(fx.ops.context(), &slot));
    let error = recovery.uncertain();
    assert_eq!(error.code, ErrorCode::UncertainOutcome);
    assert_eq!(fx.get("sample"), "linked original");
    assert_eq!(
        std::fs::read_to_string(recovery.path.join(&slot.name)).unwrap(),
        "private successor"
    );
    let kept = error.detail.unwrap()["kept"].as_array().unwrap().clone();
    assert_eq!(kept.len(), 2, "both the slot and public link are reported");
}

#[test]
fn private_noreplace_probe_renames_reporting_without_consuming_capture_capacity() {
    use std::io::Write;
    let fx = Fx::new();
    let parent = root(&fx);
    let original_path = fx.put("destination", "original");
    let original_stat = Stat::from_metadata(&std::fs::metadata(&original_path).unwrap());
    let mut original = Held::open(&parent, "destination".as_ref(), original_stat).unwrap();
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let (mut tmp, mut file) = recovery
        .create_temp(&parent, "destination".as_ref(), &original_path)
        .unwrap();
    file.write_all(b"replacement").unwrap();
    let mut identity = Held::from_file(&file).unwrap();
    drop(file);
    let _faults = FaultScope::new(&[]);
    assert!(matches!(
        recovery
            .probe_publish(fx.ops.context(), &mut tmp, &mut identity)
            .unwrap(),
        PublishMethod::NoReplace
    ));
    assert_eq!(tmp.name, "probe");
    assert_eq!(recovery.kept, [recovery.path.join("probe")]);
    assert!(!recovery.path.join("tmp").exists());
    assert_eq!(recovery.used, 1, "probe is not a capture");
    let original_slot = recovery
        .capture(&parent, "destination".as_ref(), &original_path)
        .unwrap();
    assert_eq!(original_slot.name, "slot-2");
    assert_eq!(recovery.used, 2);
    assert!(recovery.holds(&original_slot, &original));
    original.release();
    assert!(recovery.restore(fx.ops.context(), &original_slot));
    assert!(recovery.dispose(fx.ops.context(), &tmp, &mut identity));
    assert!(!identity.is_held());
    assert_eq!(
        recovery.used, 2,
        "restoring/disposal does not refund captures"
    );
    assert!(recovery.kept.is_empty());
    assert!(recovery.settled());
    assert!(recovery.finish().is_empty());
    assert_eq!(fx.get("destination"), "original");
}

#[test]
fn private_link_probe_proves_the_alias_by_its_own_name_and_keeps_t_pinned() {
    for fail_unlink in [false, true] {
        let fx = Fx::new();
        let parent = root(&fx);
        fx.put("destination", "original");
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let (mut tmp, file) = recovery
            .create_temp(
                &parent,
                "destination".as_ref(),
                &fx.root.join("destination"),
            )
            .unwrap();
        let mut identity = Held::from_file(&file).unwrap();
        drop(file);
        let mut faults = vec![(Primitive::ProbeNoReplace, 1, Errno::EINVAL)];
        if fail_unlink {
            faults.push((Primitive::Unlink, 1, Errno::EIO));
        }
        let _faults = FaultScope::new(&faults);
        let result = recovery.probe_publish(fx.ops.context(), &mut tmp, &mut identity);
        assert_eq!(recovery.used, 1);
        // One proof opened on the alias's own name; T's creation proof is never
        // re-opened (a re-hold by path would lose T's lineage).
        assert_eq!(
            FaultScope::calls()
                .iter()
                .filter(|p| **p == Primitive::Hold)
                .count(),
            1
        );
        assert!(
            identity.is_held(),
            "T stays pinned through the alias unlink"
        );
        assert_eq!(fx.get("destination"), "original");
        assert_eq!(
            FaultScope::calls()
                .iter()
                .filter(|p| **p == Primitive::Unlink)
                .count(),
            1
        );
        if fail_unlink {
            assert_eq!(result.err().unwrap().code, ErrorCode::UncertainOutcome);
            assert_eq!(
                recovery.kept,
                [recovery.path.join("tmp"), recovery.path.join("probe")]
            );
            assert_eq!(
                super::super::recover::present_slots(&recovery.path).len(),
                2
            );
            assert!(!recovery.settled());
        } else {
            assert!(matches!(result.unwrap(), PublishMethod::Link));
            assert_eq!(recovery.kept, [recovery.path.join("tmp")]);
            assert!(!recovery.path.join("probe").exists());
            assert!(recovery.dispose(fx.ops.context(), &tmp, &mut identity));
            assert!(recovery.finish().is_empty());
        }
    }
}

#[test]
fn private_link_probe_with_an_unheld_alias_retains_both_names_uncertain() {
    let fx = Fx::new();
    let parent = root(&fx);
    let destination = fx.put("destination", "original");
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let (mut tmp, file) = recovery
        .create_temp(&parent, "destination".as_ref(), &destination)
        .unwrap();
    let mut identity = Held::from_file(&file).unwrap();
    drop(file);
    let _scope = FaultScope::new(&[
        (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
        (Primitive::Hold, 1, Errno::EACCES),
    ]);
    let error = recovery
        .probe_publish(fx.ops.context(), &mut tmp, &mut identity)
        .err()
        .unwrap();
    // No proof of the alias: it is never unlinked, both private names stay.
    assert_eq!(error.code, ErrorCode::UncertainOutcome);
    assert_eq!(fx.get("destination"), "original");
    assert!(recovery.path.join("probe").exists());
    assert!(recovery.path.join("tmp").exists());
    assert_eq!(
        FaultScope::calls()
            .iter()
            .filter(|p| **p == Primitive::Unlink)
            .count(),
        0
    );
}

#[test]
fn link_publication_keeps_symlink_identity_without_following_its_target() {
    let fx = Fx::new();
    let parent = root(&fx);
    let target = fx.put("target", "target bytes must remain");
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let slot = Slot {
        name: OsString::from("private-link"),
        origin: Origin::new(
            &parent,
            "published-link".as_ref(),
            &fx.root.join("published-link"),
        )
        .unwrap(),
    };
    let private = recovery.path.join(&slot.name);
    std::os::unix::fs::symlink(&target, &private).unwrap();
    recovery.remember(private.clone());
    let stat = Stat::from_metadata(&std::fs::symlink_metadata(&private).unwrap());
    let mut identity = Held::open(&recovery.dir, &slot.name, stat).unwrap();
    assert!(identity.is_held());
    recovery
        .publish_slot(&slot, &slot.origin, PublishMethod::Link)
        .unwrap();
    let published = fx.root.join("published-link");
    let public_stat = Stat::from_metadata(&std::fs::symlink_metadata(&published).unwrap());
    assert_eq!(public_stat.kind(), Kind::Symlink);
    assert!(public_stat.same_object(&identity.stat));
    assert_eq!(std::fs::read_link(&published).unwrap(), target);
    assert!(recovery.dispose(fx.ops.context(), &slot, &mut identity));
    assert!(recovery.finish().is_empty());
    assert!(published.is_symlink());
    assert_eq!(fx.get("target"), "target bytes must remain");
}

#[test]
fn recovery_name_allocation_is_bounded_and_fails_closed() {
    let fx = Fx::new();
    let parent = root(&fx);
    // Every mkdir answers EEXIST: the call must stop after the bound.
    let faults: Vec<_> = (1..=MAX_NAME_ATTEMPTS + 8)
        .map(|nth| (Primitive::Mkdir, nth, Errno::EEXIST))
        .collect();
    let _faults = FaultScope::new(&faults);
    let error = RecoveryDir::new(&parent, &fx.root).err().unwrap();
    assert_eq!(error.code, ErrorCode::IoError);
    assert_eq!(error.message, "EEXIST");
    assert_eq!(
        FaultScope::calls()
            .iter()
            .filter(|p| **p == Primitive::Mkdir)
            .count(),
        MAX_NAME_ATTEMPTS
    );
    assert_eq!(std::fs::read_dir(&fx.root).unwrap().count(), 0);
    // One collision below the bound still succeeds.
    let _faults = FaultScope::new(&[(Primitive::Mkdir, 1, Errno::EEXIST)]);
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    assert!(recovery.finish().is_empty());
}

#[test]
fn startup_report_names_abandoned_recovery_and_leaves_it() {
    let fx = Fx::new();
    let dir = fx.root.join(".wsmp-recover-abcdefghij");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("slot-1"), "kept object").unwrap();
    let mut intent = Intent::delete(&fx.root.join("gone"));
    intent.pid = 0;
    super::super::registry::register(&dir, &intent).unwrap();
    report_abandoned_recovery();
    assert_eq!(
        std::fs::read_to_string(dir.join("slot-1")).unwrap(),
        "kept object"
    );
    assert!(dir.is_dir());
    let message = super::super::recover::describe_abandoned(&dir);
    assert!(!message.contains("read INTENT"), "{message}");
    assert!(message.contains("INTENT absent"), "{message}");
    assert!(message.contains("slot-1"), "{message}");
}

#[test]
fn finish_keeps_intent_when_a_slot_is_retained() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("source", "kept bytes");
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    recovery.prepare_intent(Intent::delete(&path)).unwrap();
    let slot = recovery.capture(&parent, "source".as_ref(), &path).unwrap();
    recovery.keep(&slot);
    let kept = recovery.finish();
    assert!(!kept.is_empty());
    assert!(recovery.path.join("INTENT").is_file());
    assert_eq!(
        std::fs::read_to_string(recovery.path.join(&slot.name)).unwrap(),
        "kept bytes"
    );
}

#[test]
fn capture_without_prepare_writes_create_intent_and_registers() {
    let fx = Fx::new();
    let parent = root(&fx);
    let path = fx.put("created", "bytes");
    let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
    let slot = recovery
        .capture(&parent, "created".as_ref(), &path)
        .unwrap();
    let parsed = super::super::intent::parse_intent(
        &std::fs::read(recovery.path.join("INTENT")).expect("INTENT"),
    )
    .expect("parse");
    assert_eq!(parsed.op, super::super::intent::IntentOp::Create);
    assert_eq!(parsed.phase, IntentPhase::Prepared);
    assert!(
        parsed
            .slots
            .contains_key(&slot.name.to_string_lossy().into_owned())
    );
    let registered = super::super::registry::list_entries();
    assert!(
        registered
            .iter()
            .any(|entry| entry.recovery_path() == recovery.path),
        "{registered:?}"
    );
    recovery.keep(&slot);
    let _ = recovery.finish();
}

#[test]
fn unsupported_directory_sync_cannot_grant_durability() {
    assert!(tolerate_dir_fsync(Ok(()), Path::new("/tmp")).is_ok());
    assert!(tolerate_dir_fsync(Err(Errno::EINVAL), Path::new("/tmp")).is_err());
    assert!(tolerate_dir_fsync(Err(Errno::ENOTSUP), Path::new("/tmp")).is_err());
    let error = tolerate_dir_fsync(Err(Errno::EIO), Path::new("/tmp")).unwrap_err();
    assert_eq!(error.code, ErrorCode::IoError);
}
