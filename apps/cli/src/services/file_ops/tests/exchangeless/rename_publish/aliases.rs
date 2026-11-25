//! Link aliases and their proofs: failed link-count reads, true S/D alias
//! pairs, the last name of an object, proofs closed before each restore or
//! committed unlink, and the link order learned from the probe.

use super::*;

/// O2B-3: when the fresh link-count read fails, the alias is kept and reported; it
/// is never deleted on an unknown count. Covers the single alias (plain rename) and
/// the S/D batch (overwrite), for every count read of the operation.
#[test]
fn rename_failed_link_count_read_keeps_the_alias_and_reports_it() {
    for object in OBJECTS {
        for overwrite in [false, true] {
            let clean = {
                let fx = Fx::new();
                let etag = setup(&fx, object, overwrite);
                let _scope = FaultScope::new(&Shape::Link.faults(overwrite));
                let value = rename_run(&fx, overwrite, etag.as_deref()).unwrap();
                assert!(value.get("recovered").is_none(), "{object:?}: {value}");
                count(&FaultScope::calls(), Primitive::LinkCount)
            };
            assert!(
                clean >= 1,
                "{object:?} overwrite={overwrite}: a count must be read"
            );
            for nth in 1..=clean {
                let fx = Fx::new();
                let etag = setup(&fx, object, overwrite);
                let mut faults = Shape::Link.faults(overwrite);
                faults.push((Primitive::LinkCount, nth, Errno::EIO));
                let _scope = FaultScope::new(&faults);
                match rename_run(&fx, overwrite, etag.as_deref()) {
                    Ok(value) => {
                        // Success: the published name holds the source; any private
                        // alias the unknown count kept is reported, with its bytes.
                        assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
                        let paths = inventory(&fx, &value);
                        let reported = value.get("recovered").is_some();
                        if nth == clean {
                            // The last read decides the published alias: unknown means kept.
                            assert!(reported, "{object:?} overwrite={overwrite}: {value}");
                        }
                        if !reported {
                            // Nothing kept: the read must not have been the deciding one.
                            assert!(recovery_dirs(&fx.root).is_empty(), "{object:?} nth={nth}");
                        } else {
                            assert!(
                                paths
                                    .iter()
                                    .any(|p| object.bytes(p).as_deref() == Some(SOURCE)),
                                "{object:?} nth={nth}: {paths:?}"
                            );
                        }
                    }
                    Err(error) => {
                        assert_eq!(error.code, ErrorCode::UncertainOutcome, "{error:?}");
                        let paths = error_inventory(&fx, &error);
                        assert!(
                            paths
                                .iter()
                                .any(|p| object.bytes(p).as_deref() == Some(SOURCE)),
                            "{object:?} nth={nth}: {paths:?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn rename_failed_destination_capture_releases_source_before_restore_alias_unlink() {
    for failure in [None, Some(Errno::EIO), Some(Errno::ESTALE)] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, true);
        #[cfg(target_os = "linux")]
        let root = fx.root.clone();
        let scope = Arc::new(Mutex::new(None));
        let injected = Arc::clone(&scope);
        let probe_root = fx.root.clone();
        let fx=fx.with_hook(move|step| {
            if step == Step::LinkProbed && !probe_root.join("probe-decoy").exists() {
                swap_probe_inode(&probe_root);
            }
            if step==Step::DestinationVacating {
                let mut rows=vec![(Primitive::Capture,1,Errno::ENOENT),(Primitive::Restore,1,Errno::EINVAL)];
                if let Some(errno)=failure {rows.push((Primitive::Identity,1,errno));}
                *injected.lock().unwrap()=Some(FaultScope::new(&rows));
                #[cfg(target_os="linux")]
                {
                    use crate::services::file_ops::fs::exchange::UNLINK_PROBE;
                    use std::os::unix::fs::MetadataExt;
                    let root=root.clone();
                    UNLINK_PROBE.with(|probe|*probe.borrow_mut()=Some(Box::new(move|| {
                        let private=recovery_dirs(&root)[0].join("slot-1");
                        let meta=std::fs::symlink_metadata(private).unwrap();
                        for fd in std::fs::read_dir("/proc/self/fd").unwrap() {
                            if let Ok(held)=std::fs::metadata(fd.unwrap().path()) {
                                assert_ne!((held.dev(),held.ino()),(meta.dev(),meta.ino()),
                                    "failed observation must not leave source proof open during restore unlink");
                            }
                        }
                    })));
                }
            } Ok(())
        });
        let _scope = FaultScope::new(&Shape::Link.faults(true));
        let error = rename_run(&fx, true, etag.as_deref()).unwrap_err();
        let paths = error_inventory(&fx, &error);
        assert!(has_bytes(&paths, SOURCE));
        assert!(has_bytes(&paths, DESTINATION));
        if failure.is_none() {
            assert_eq!(error.code, ErrorCode::Conflict);
            clean(&fx);
        }
        drop(scope.lock().unwrap().take());
    }
}

/// A racer replaces the destination with a hard link to the captured source, so
/// the captured "destination" is the source's own inode. The source proof must be
/// closed before the restore unlinks that private slot (F3 on a noino alias pair).
#[test]
fn rename_destination_mismatch_closes_source_proof_before_restore_unlink() {
    let fx = Fx::new();
    let etag = setup(&fx, Object::File, true);
    #[cfg(target_os = "linux")]
    let root = fx.root.clone();
    let racer_root = fx.root.clone();
    let fx = fx.with_hook(move |step| {
        if step == Step::LinkProbed && !racer_root.join("probe-decoy").exists() {
            swap_probe_inode(&racer_root);
        }
        if step == Step::DestinationVacating {
            let private = recovery_dirs(&racer_root)[0].join("slot-1");
            let public = racer_root.join("dst");
            std::fs::remove_file(&public).unwrap();
            std::fs::hard_link(private, public).unwrap();
            #[cfg(target_os = "linux")]
            {
                use crate::services::file_ops::fs::exchange::UNLINK_PROBE;
                use std::os::unix::fs::MetadataExt;
                let root = root.clone();
                UNLINK_PROBE.with(|probe| {
                    *probe.borrow_mut() = Some(Box::new(move || {
                        let Ok(meta) =
                            std::fs::symlink_metadata(recovery_dirs(&root)[0].join("slot-2"))
                        else {
                            return;
                        };
                        for fd in std::fs::read_dir("/proc/self/fd").unwrap() {
                            if let Ok(held) = std::fs::metadata(fd.unwrap().path()) {
                                assert_ne!(
                                    (held.dev(), held.ino()),
                                    (meta.dev(), meta.ino()),
                                    "no operation-owned descriptor may stay open on the object being unlinked"
                                );
                            }
                        }
                    }));
                });
            }
        }
        Ok(())
    });
    let _scope = FaultScope::new(&Shape::Link.faults(true));
    let result = rename_run(&fx, true, etag.as_deref());
    let error = result.unwrap_err();
    // Nothing is lost: the source bytes are back at their origin or reported.
    assert!(
        fx.root.join("src").exists() || has_bytes(&error_inventory(&fx, &error), SOURCE),
        "{error:?}"
    );
}

#[test]
fn rename_each_link_alias_disposal_keeps_a_last_name() {
    for object in OBJECTS {
        for site in ["probe", "restore", "publish"] {
            let fx = Fx::new();
            let etag = setup(&fx, object, true);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                let src = root.join("src");
                let dst = root.join("dst");
                if site == "restore"
                    && step == Step::LinkProbed
                    && !root.join("probe-decoy").exists()
                {
                    // Vacating save is observed only after S is already captured.
                    swap_probe_inode(&root);
                }
                if site == "probe"
                    && step == Step::LinkProbed
                    && object.bytes(&src).as_deref() == Some(SOURCE)
                {
                    std::fs::remove_file(&src).unwrap();
                }
                if site == "restore" && step == Step::Vacating {
                    object.save(&src, RACER);
                }
                if site == "restore"
                    && step == Step::Disposing
                    && object.bytes(&src).as_deref() == Some(RACER)
                    && std::fs::symlink_metadata(recovery_dirs(&root)[0].join("slot-1")).is_ok()
                {
                    std::fs::remove_file(&src).unwrap();
                }
                if site == "publish"
                    && step == Step::Disposing
                    && object.bytes(&dst).as_deref() == Some(SOURCE)
                {
                    std::fs::remove_file(&dst).unwrap();
                }
                Ok(())
            });
            let _scope = FaultScope::new(&Shape::Link.faults(true));
            let result = rename_run(&fx, true, etag.as_deref());
            if site == "publish" {
                let value = result.unwrap();
                assert!(object.kept(&result_paths(&value), SOURCE));
                assert!(value["etag"].is_null());
            } else {
                let e = result.unwrap_err();
                let paths = kept(&e);
                assert!(object.kept(&paths, if site == "restore" { RACER } else { SOURCE }));
                assert_eq!(
                    object.bytes(&fx.root.join("dst")).as_deref(),
                    Some(DESTINATION)
                );
            }
        }
    }
}

/// C1A-1: S and D are two names of one object (a true alias pair, admitted on mounts
/// without stable inodes). After the publish a writer writes through the public name
/// and a third save replaces it. The two private names are then the object's only
/// names: the batch cleanup must not delete both.
#[test]
fn rename_true_alias_pair_with_a_post_publication_save_keeps_the_object() {
    use crate::services::file_ops::fs::policy::Access;
    use crate::services::file_ops::fs::resolve::{ResolveOpts, resolve};
    use crate::services::file_ops::journal::recovery::{Held, RecoveryDir};
    use std::os::fd::AsFd;
    for object in OBJECTS {
        for save in [false, true] {
            let fx = Fx::new();
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if save && step == Step::Renamed {
                    let public = root.join("dst");
                    if matches!(object, Object::File) {
                        use std::io::Write;
                        let mut writer = std::fs::OpenOptions::new()
                            .append(true)
                            .open(&public)
                            .unwrap();
                        writer.write_all(b"+WRITER").unwrap();
                    }
                    object.save(&public, RACER);
                }
                Ok(())
            });
            object.put(&fx, "src", SOURCE);
            let resolve_name = |name: &str| {
                resolve(
                    &fx.p(name),
                    &ResolveOpts {
                        follow_last: false,
                        make_parents: None,
                        policy: fx.ops.policy(),
                        access: Access::Remove,
                        cancel: None,
                    },
                )
                .unwrap()
            };
            let from = resolve_name("src");
            nix::unistd::linkat(
                from.dir.as_fd(),
                from.name.as_os_str(),
                from.dir.as_fd(),
                "dst",
                nix::fcntl::AtFlags::empty(),
            )
            .unwrap();
            let to = resolve_name("dst");
            let mut src =
                Held::open(&from.dir, &from.name, from.lstat().unwrap().unwrap()).unwrap();
            let mut dst = Held::open(&to.dir, &to.name, to.lstat().unwrap().unwrap()).unwrap();
            let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path).unwrap();
            let _scope = FaultScope::new(&Shape::Link.faults(true));
            let method = recovery
                .preflight_move(fx.ops.context(), &from, &to, &src, Some(&dst))
                .unwrap();
            recovery
                .commit_move(
                    fx.ops.context(),
                    &from,
                    &to,
                    &mut src,
                    Some(&mut dst),
                    method,
                    &fx.cancel,
                )
                .unwrap();
            let recovered: Vec<PathBuf> =
                recovery.finish().into_iter().map(PathBuf::from).collect();
            if save {
                // The object the writer wrote to lost its public name: it must stay.
                let expected = if matches!(object, Object::File) {
                    format!("{SOURCE}+WRITER")
                } else {
                    SOURCE.to_owned()
                };
                assert!(
                    recovered
                        .iter()
                        .any(|path| object.bytes(path).as_deref() == Some(expected.as_str())),
                    "{object:?}: the displaced object's bytes must stay reported: {recovered:?}"
                );
            } else {
                assert!(recovered.is_empty(), "{object:?}: {recovered:?}");
                assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
            }
        }
    }
}

/// C4A-1: the publisher's prepare-error exit (here an injected EMFILE) must close the
/// destination's proof before the restore unlinks the source's private alias: with a
/// true S/D alias pair both descriptors are on the object being unlinked (F3).
#[test]
fn rename_prepare_error_exit_closes_the_destination_proof_before_the_restore_unlink() {
    use crate::services::file_ops::fs::policy::Access;
    use crate::services::file_ops::fs::resolve::{ResolveOpts, resolve};
    use crate::services::file_ops::journal::recovery::{Held, RecoveryDir};
    let fx = Fx::new();
    object_put_pair(&fx);
    let resolve_name = |name: &str| {
        resolve(
            &fx.p(name),
            &ResolveOpts {
                follow_last: false,
                make_parents: None,
                policy: fx.ops.policy(),
                access: Access::Remove,
                cancel: None,
            },
        )
        .unwrap()
    };
    let from = resolve_name("src");
    let to = resolve_name("dst");
    let mut src = Held::open(&from.dir, &from.name, from.lstat().unwrap().unwrap()).unwrap();
    let mut dst = Held::open(&to.dir, &to.name, to.lstat().unwrap().unwrap()).unwrap();
    let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path).unwrap();
    let mut faults = Shape::Link.faults(true);
    faults.push((Primitive::PublishPrepare, 1, Errno::EMFILE));
    let _scope = FaultScope::new(&faults);
    let method = recovery
        .preflight_move(fx.ops.context(), &from, &to, &src, Some(&dst))
        .unwrap();
    // Stable inodes would link first and fail PublishPrepare before capture.
    recovery.set_link_order(crate::services::file_ops::journal::recovery::LinkOrder::VacateFirst);
    #[cfg(target_os = "linux")]
    let checks = {
        use crate::services::file_ops::fs::exchange::UNLINK_PROBE;
        use std::os::unix::fs::MetadataExt;
        let root = fx.root.clone();
        let seen = Arc::new(Mutex::new(0usize));
        let counted = Arc::clone(&seen);
        UNLINK_PROBE.with(|probe| {
            *probe.borrow_mut() = Some(Box::new(move || {
                let Ok(meta) = std::fs::symlink_metadata(recovery_dirs(&root)[0].join("slot-1"))
                else {
                    return;
                };
                for fd in std::fs::read_dir("/proc/self/fd").unwrap() {
                    if let Ok(held) = std::fs::metadata(fd.unwrap().path()) {
                        assert_ne!(
                            (held.dev(), held.ino()),
                            (meta.dev(), meta.ino()),
                            "a descriptor stays open on the object whose private name is unlinked"
                        );
                    }
                }
                *counted.lock().unwrap() += 1;
            }));
        });
        seen
    };
    let error = recovery
        .commit_move(
            fx.ops.context(),
            &from,
            &to,
            &mut src,
            Some(&mut dst),
            method,
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::IoError);
    #[cfg(target_os = "linux")]
    assert!(
        *checks.lock().unwrap() >= 1,
        "the restore unlink must have run"
    );
    assert!(recovery.finish().is_empty());
    assert_eq!(fx.get("src"), SOURCE);
    assert_eq!(fx.get("dst"), SOURCE);
}

fn object_put_pair(fx: &Fx) {
    fx.put("src", SOURCE);
    std::fs::hard_link(fx.root.join("src"), fx.root.join("dst")).unwrap();
}

#[test]
fn rename_true_alias_pair_closes_both_private_proofs_before_committed_unlinks() {
    use crate::services::file_ops::fs::policy::Access;
    use crate::services::file_ops::fs::resolve::{ResolveOpts, resolve};
    use crate::services::file_ops::journal::recovery::{Held, RecoveryDir};
    use std::os::fd::AsFd;
    for shape in [Shape::Nr, Shape::Link] {
        for object in OBJECTS {
            let fx = Fx::new();
            object.put(&fx, "src", SOURCE);
            // Exercise the transaction directly: stable-inode admission recognizes
            // this alias pair, while noino admission reaches this same transaction.
            let resolve_name = |name: &str| {
                resolve(
                    &fx.p(name),
                    &ResolveOpts {
                        follow_last: false,
                        make_parents: None,
                        policy: fx.ops.policy(),
                        access: Access::Remove,
                        cancel: None,
                    },
                )
                .unwrap()
            };
            let from = resolve_name("src");
            nix::unistd::linkat(
                from.dir.as_fd(),
                from.name.as_os_str(),
                from.dir.as_fd(),
                "dst",
                nix::fcntl::AtFlags::empty(),
            )
            .unwrap(); // explicitly preserve the symlink itself on both platforms
            let to = resolve_name("dst");
            let mut src =
                Held::open(&from.dir, &from.name, from.lstat().unwrap().unwrap()).unwrap();
            let mut dst = Held::open(&to.dir, &to.name, to.lstat().unwrap().unwrap()).unwrap();
            let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path).unwrap();
            let _scope = FaultScope::new(&shape.faults(true));
            let method = recovery
                .preflight_move(fx.ops.context(), &from, &to, &src, Some(&dst))
                .unwrap();
            #[cfg(target_os = "linux")]
            let checks = if matches!(shape, Shape::Link) {
                // Link-first captures D into slot-1 and S into slot-2, and
                // unlinks the displaced destination before the source alias.
                Some(watch_private_unlinks(&fx, &["slot-1", "slot-2"]))
            } else {
                None
            };
            recovery
                .commit_move(
                    fx.ops.context(),
                    &from,
                    &to,
                    &mut src,
                    Some(&mut dst),
                    method,
                    &fx.cancel,
                )
                .unwrap();
            #[cfg(target_os = "linux")]
            if let Some(checks) = checks {
                assert_eq!(checks.lock().unwrap().len(), 2);
            }
            assert!(!src.is_held());
            assert!(!dst.is_held());
            assert!(recovery.finish().is_empty());
            assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
            assert!(std::fs::symlink_metadata(fx.root.join("src")).is_err());
            clean(&fx);
        }
    }
}

#[test]
fn rename_link_order_follows_probe_inode_stability() {
    for overwrite in [false, true] {
        for destabilize in [false, true] {
            let fx = Fx::new();
            let etag = setup(&fx, Object::File, overwrite);
            let root = fx.root.clone();
            let at_publish = Arc::new(Mutex::new(None));
            let record = Arc::clone(&at_publish);
            let fx = fx.with_hook(move |step| {
                if destabilize && step == Step::LinkProbed && !root.join("probe-decoy").exists() {
                    swap_probe_inode(&root);
                }
                if step == Step::Publishing {
                    *record.lock().unwrap() =
                        Some(std::fs::symlink_metadata(root.join("src")).is_ok());
                }
                Ok(())
            });
            let _scope = FaultScope::new(&Shape::Link.faults(overwrite));
            let value = rename_run(&fx, overwrite, etag.as_deref()).unwrap();
            assert!(value.get("recovered").is_none(), "{value}");
            let calls = FaultScope::calls();
            let publish_at = calls
                .iter()
                .position(|call| *call == Primitive::PublishLink)
                .expect("link publish");
            let captures_before = calls[..publish_at]
                .iter()
                .filter(|call| **call == Primitive::Capture)
                .count();
            let src_public = at_publish.lock().unwrap().expect("publishing seam");
            if destabilize {
                assert!(!src_public, "vacate-first captures S before publish");
                assert!(captures_before >= 1, "{calls:?}");
            } else {
                assert!(src_public, "link-first leaves S in place through publish");
                assert_eq!(captures_before, if overwrite { 1 } else { 0 }, "{calls:?}");
            }
            assert_eq!(fx.get("dst"), SOURCE);
            clean(&fx);
        }
    }
}
