//! Replace (edit and write) without exchange: the capability matrix, probe
//! errors, real saves racing every seam, and failed publication, disposal and
//! restore.

use super::*;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn exchangeless_capability_matrix_selects_only_safe_publication() {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Expected {
        Exchange,
        NoReplace,
        Link,
        Refused,
        IoError,
    }
    // EOPNOTSUPP is ENOTSUP on Linux, but a distinct non-capability errno on macOS.
    let exchange_rows = [
        None,
        Some(Errno::EINVAL),
        Some(Errno::ENOSYS),
        Some(Errno::ENOTSUP),
        Some(Errno::EOPNOTSUPP),
        Some(Errno::EPERM),
        Some(Errno::EIO),
    ];
    let no_replace_rows = [None, Some(Errno::EINVAL), Some(Errno::ENOTSUP)];
    let link_rows = [
        None,
        Some(Errno::EPERM),
        Some(Errno::EMLINK),
        Some(Errno::EOPNOTSUPP),
    ];
    let mut rows = 0;
    for op in REPLACE_OPS {
        for exchange in exchange_rows {
            for no_replace in no_replace_rows {
                for link in link_rows {
                    rows += 1;
                    let unsupported = |errno: Errno| {
                        matches!(errno, Errno::EINVAL | Errno::ENOSYS | Errno::ENOTSUP)
                            || (cfg!(target_os = "linux") && errno == Errno::EOPNOTSUPP)
                    };
                    let expected = match exchange {
                        None => Expected::Exchange,
                        Some(errno) if !unsupported(errno) => Expected::IoError,
                        Some(_) => match no_replace {
                            None => Expected::NoReplace,
                            Some(_) => match link {
                                None => Expected::Link,
                                Some(Errno::EMLINK) => Expected::IoError,
                                Some(_) => Expected::Refused,
                            },
                        },
                    };
                    let label =
                        format!("{op:?}: exchange={exchange:?}, nr={no_replace:?}, link={link:?}");
                    let fx = Fx::new();
                    let etag = prepare(&fx);
                    let before = snapshot(&fx.root);
                    let mut faults = Vec::new();
                    if let Some(errno) = exchange {
                        faults.push((Primitive::Exchange, 1, errno));
                    }
                    if let Some(errno) = no_replace {
                        faults.push((Primitive::ProbeNoReplace, 1, errno));
                    }
                    if let Some(errno) = link {
                        faults.push((Primitive::ProbeLink, 1, errno));
                    }
                    let _scope = FaultScope::new(&faults);
                    let result = op.run(&fx, &etag);
                    let calls = FaultScope::calls();
                    assert_eq!(count(&calls, Primitive::Exchange), 1, "{label}");
                    match expected {
                        Expected::Exchange | Expected::NoReplace | Expected::Link => {
                            let value = result.expect(&label);
                            assert!(value.get("recovered").is_none(), "{label}: {value}");
                            assert_eq!(fx.get("doc"), EDITED, "{label}");
                            assert_eq!(fx.get("untouched"), "unrelated bytes\n", "{label}");
                            clean(&fx);
                            let fallback = expected != Expected::Exchange;
                            assert_eq!(
                                count(&calls, Primitive::ProbeNoReplace),
                                usize::from(fallback),
                                "{label}"
                            );
                            assert_eq!(
                                count(&calls, Primitive::ProbeLink),
                                usize::from(expected == Expected::Link),
                                "{label}"
                            );
                            assert_eq!(
                                count(&calls, Primitive::Capture),
                                usize::from(fallback),
                                "{label}"
                            );
                            assert_eq!(
                                count(&calls, Primitive::Publish),
                                usize::from(expected == Expected::NoReplace),
                                "{label}"
                            );
                            assert_eq!(
                                count(&calls, Primitive::PublishLink),
                                usize::from(expected == Expected::Link),
                                "{label}"
                            );
                            if fallback {
                                assert!(
                                    calls
                                        .iter()
                                        .position(|call| *call == Primitive::ProbeNoReplace)
                                        .unwrap()
                                        < calls
                                            .iter()
                                            .position(|call| *call == Primitive::Capture)
                                            .unwrap(),
                                    "{label}: {calls:?}"
                                );
                            }
                        }
                        Expected::Refused | Expected::IoError => {
                            let error = result.expect_err(&label);
                            assert_eq!(
                                error.code,
                                if expected == Expected::Refused {
                                    ErrorCode::UnsafeFilesystem
                                } else {
                                    ErrorCode::IoError
                                },
                                "{label}: {error:?}"
                            );
                            assert_eq!(
                                snapshot(&fx.root),
                                before,
                                "{label}: refusal/error changed names or bytes"
                            );
                            assert_eq!(count(&calls, Primitive::Capture), 0, "{label}");
                            assert_eq!(count(&calls, Primitive::Publish), 0, "{label}");
                            assert_eq!(count(&calls, Primitive::PublishLink), 0, "{label}");
                            clean(&fx);
                        }
                    }
                }
            }
        }
    }
    assert_eq!(rows, 168);
}

#[test]
fn exchangeless_link_probe_resource_errors_are_io_errors_without_public_changes() {
    for op in REPLACE_OPS {
        for errno in [
            Errno::ENOSPC,
            Errno::EDQUOT,
            Errno::EROFS,
            Errno::EACCES,
            Errno::EIO,
            Errno::EMLINK,
        ] {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let before = snapshot(&fx.root);
            let mut faults = PublishMethod::Link.faults();
            faults.push((Primitive::ProbeLink, 1, errno));
            let _scope = FaultScope::new(&faults);
            let error = op.run(&fx, &etag).unwrap_err();
            assert_eq!(error.code, ErrorCode::IoError, "{op:?}/{errno}: {error:?}");
            assert_eq!(error.message, format!("{errno:?}"));
            assert_eq!(snapshot(&fx.root), before, "{op:?}/{errno}");
            assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
            clean(&fx);
        }
    }
}

#[test]
fn exchangeless_replace_restores_a_real_save_at_vacating() {
    for op in REPLACE_OPS {
        for method in METHODS {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let doc = fx.root.join("doc");
            let hit = Arc::new(AtomicBool::new(false));
            let seen = Arc::clone(&hit);
            let fx = fx.with_hook(move |step| {
                if step == Step::Vacating {
                    save(&doc, RACER);
                    seen.store(true, Ordering::SeqCst);
                }
                Ok(())
            });
            let _scope = FaultScope::new(&method.faults());
            let error = op.run(&fx, &etag).unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::Conflict,
                "{op:?}/{method:?}: {error:?}"
            );
            assert_eq!(error.detail, Some(json!({"currentEtag": "replaced"})));
            assert!(hit.load(Ordering::SeqCst));
            assert_eq!(fx.get("doc"), RACER);
            assert_eq!(count(&FaultScope::calls(), method.primitive()), 0);
            clean(&fx);
            no_public_temp(&fx);
        }
    }
}

#[test]
fn exchangeless_replace_keeps_original_when_racer_creates_vacated_name() {
    for op in REPLACE_OPS {
        for method in METHODS {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let doc = fx.root.join("doc");
            let fx = fx.with_hook(move |step| {
                if step == Step::Vacated {
                    assert!(!doc.exists(), "the name must actually be vacant");
                    std::fs::write(&doc, RACER).unwrap();
                }
                Ok(())
            });
            let _scope = FaultScope::new(&method.faults());
            let error = op.run(&fx, &etag).unwrap_err();
            let retained = kept(&error);
            assert!(
                has_bytes(&retained, ORIGINAL),
                "{op:?}/{method:?}: {error:?}"
            );
            assert!(
                !has_bytes(&retained, EDITED),
                "private unpublished T should be disposed"
            );
            assert_eq!(fx.get("doc"), RACER);
            assert_eq!(
                count(&FaultScope::calls(), Primitive::Capture),
                1,
                "never capture the public racer"
            );
            assert_eq!(
                count(&FaultScope::calls(), Primitive::Restore)
                    + count(&FaultScope::calls(), Primitive::RestoreLink),
                0,
                "a blocked name is not retried as a restore: the original is kept as is"
            );
            no_public_temp(&fx);
        }
    }
}

#[test]
fn exchangeless_replace_never_touches_a_save_after_publish() {
    for op in REPLACE_OPS {
        for method in METHODS {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let doc = fx.root.join("doc");
            let fx = fx.with_hook(move |step| {
                if step == Step::Renamed {
                    assert_eq!(std::fs::read_to_string(&doc).unwrap(), EDITED);
                    save(&doc, RACER);
                }
                Ok(())
            });
            let _scope = FaultScope::new(&method.faults());
            let value = op.run(&fx, &etag).unwrap();
            assert!(value.get("recovered").is_none(), "{value}");
            assert_eq!(fx.get("doc"), RACER);
            clean(&fx);
        }
    }
}

#[test]
fn exchangeless_replace_preserves_a_real_save_during_published_cleanup() {
    for op in REPLACE_OPS {
        for method in METHODS {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let doc = fx.root.join("doc");
            let hit = Arc::new(AtomicBool::new(false));
            let seen = Arc::clone(&hit);
            let fx = fx.with_hook(move |step| {
                // The first link-path Disposing is the PRIVATE probe alias;
                // trigger only once T actually occupies the public name.
                if step == Step::Disposing
                    && std::fs::read_to_string(&doc).is_ok_and(|bytes| bytes == EDITED)
                    && !seen.swap(true, Ordering::SeqCst)
                {
                    save(&doc, RACER);
                }
                Ok(())
            });
            let _scope = FaultScope::new(&method.faults());
            let value = op.run(&fx, &etag).unwrap();
            assert!(
                hit.load(Ordering::SeqCst),
                "{op:?}/{method:?}: cleanup boundary did not fire"
            );
            assert_eq!(fx.get("doc"), RACER, "cleanup must use only private names");
            if matches!(method, PublishMethod::Link) {
                assert!(has_bytes(&result_paths(&value), EDITED));
            } else {
                assert!(value.get("recovered").is_none());
                clean(&fx);
            }
        }
    }
}

#[test]
fn exchangeless_link_publish_returns_the_etag_of_the_public_name() {
    // On a mount without stable inode numbers the public name and the private
    // temp report different inodes, and the etag binds the inode. The result
    // must describe the PUBLIC name. Here a save of identical bytes lands after
    // the publish (a different inode, like the public name on such a mount): the
    // returned etag matches that name's etag only if it was taken from the name.
    for op in REPLACE_OPS {
        let fx = Fx::new();
        let etag = prepare(&fx);
        let doc = fx.root.join("doc");
        let fx = fx.with_hook(move |step| {
            if step == Step::DirSynced {
                save(&doc, EDITED);
            }
            Ok(())
        });
        let _scope = FaultScope::new(&PublishMethod::Link.faults());
        let value = op.run(&fx, &etag).unwrap();
        assert_eq!(value["etag"], fx.etag("doc"), "{op:?}");
        clean(&fx);
    }
}

#[test]
fn exchangeless_publish_error_after_effect_reconciles_by_held_identity() {
    for op in REPLACE_OPS {
        for method in METHODS {
            for errno in [Errno::EIO, Errno::ENOENT, Errno::EEXIST, Errno::EINVAL] {
                let fx = Fx::new();
                let etag = prepare(&fx);
                let _scope = FaultScope::with_after_effects(
                    &method.faults(),
                    &[(method.primitive(), 1, errno)],
                );
                let value = op
                    .run(&fx, &etag)
                    .unwrap_or_else(|error| panic!("{op:?}/{method:?}/{errno}: {error:?}"));
                assert!(value.get("recovered").is_none());
                assert_eq!(fx.get("doc"), EDITED);
                assert_eq!(
                    count(&FaultScope::calls(), Primitive::Restore),
                    0,
                    "published T must not be undone"
                );
                clean(&fx);
            }
        }
    }
}

#[test]
fn exchangeless_failed_publish_restores_original_and_disposes_temp_once() {
    // Expected codes are independent of the production errno classifiers.
    // On macOS EOPNOTSUPP is distinct from NOREPLACE's ENOTSUP; link treats
    // either as a capability failure. EPERM is a link-only capability errno.
    let rows = [
        (Errno::EIO, ErrorCode::IoError, ErrorCode::IoError),
        (
            Errno::EINVAL,
            ErrorCode::UnsafeFilesystem,
            ErrorCode::UnsafeFilesystem,
        ),
        (
            Errno::ENOSYS,
            ErrorCode::UnsafeFilesystem,
            ErrorCode::UnsafeFilesystem,
        ),
        (
            Errno::ENOTSUP,
            ErrorCode::UnsafeFilesystem,
            ErrorCode::UnsafeFilesystem,
        ),
        (
            Errno::EOPNOTSUPP,
            if cfg!(target_os = "linux") {
                ErrorCode::UnsafeFilesystem
            } else {
                ErrorCode::IoError
            },
            ErrorCode::UnsafeFilesystem,
        ),
        (
            Errno::EPERM,
            ErrorCode::IoError,
            ErrorCode::UnsafeFilesystem,
        ),
        (Errno::EMLINK, ErrorCode::IoError, ErrorCode::IoError),
        (Errno::ENOSPC, ErrorCode::IoError, ErrorCode::IoError),
        (Errno::EDQUOT, ErrorCode::IoError, ErrorCode::IoError),
        (Errno::EROFS, ErrorCode::IoError, ErrorCode::IoError),
        (Errno::EACCES, ErrorCode::IoError, ErrorCode::IoError),
        (Errno::EXDEV, ErrorCode::IoError, ErrorCode::IoError),
    ];
    let mut checked = 0;
    for op in REPLACE_OPS {
        for method in METHODS {
            for (errno, no_replace_code, link_code) in rows {
                checked += 1;
                let expected = match method {
                    PublishMethod::NoReplace => no_replace_code,
                    PublishMethod::Link => link_code,
                };
                let fx = Fx::new();
                let etag = prepare(&fx);
                let before = snapshot(&fx.root);
                let mut faults = method.faults();
                faults.push((method.primitive(), 1, errno));
                let _scope = FaultScope::new(&faults);
                let error = op.run(&fx, &etag).unwrap_err();
                assert_eq!(error.code, expected, "{op:?}/{method:?}/{errno}: {error:?}");
                assert_eq!(snapshot(&fx.root), before);
                let calls = FaultScope::calls();
                assert_eq!(count(&calls, Primitive::Restore), 1);
                assert_eq!(
                    count(&calls, Primitive::Unlink),
                    if matches!(method, PublishMethod::Link) {
                        2
                    } else {
                        1
                    },
                    "T is disposed exactly once: {calls:?}"
                );
                clean(&fx);
            }
        }
    }
    assert_eq!(checked, 48);
}

#[test]
fn exchangeless_dispose_failures_report_private_alias_and_original() {
    for op in REPLACE_OPS {
        // A private probe alias failure occurs before any public capture.
        let fx = Fx::new();
        let etag = prepare(&fx);
        let mut faults = PublishMethod::Link.faults();
        faults.push((Primitive::Unlink, 1, Errno::EIO));
        let _scope = FaultScope::new(&faults);
        let error = op.run(&fx, &etag).unwrap_err();
        let retained = kept(&error);
        assert_eq!(fx.get("doc"), ORIGINAL);
        assert!(has_bytes(&retained, EDITED));
        assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
        assert_eq!(
            count(&FaultScope::calls(), Primitive::Unlink),
            1,
            "no second disposer for T"
        );
        assert_eq!(
            fx.steps
                .lock()
                .unwrap()
                .iter()
                .filter(|step| **step == Step::Disposing)
                .count(),
            1,
            "the uncertain owner must not invoke a second disposer"
        );
        let dirs = recovery_dirs(&fx.root);
        assert_eq!(dirs.len(), 1);
        assert_eq!(
            std::fs::read_dir(&dirs[0])
                .unwrap()
                .filter(|entry| {
                    let name = entry
                        .as_ref()
                        .ok()
                        .map(|e| e.file_name())
                        .unwrap_or_default();
                    name != "INTENT"
                        && name != "INTENT.new"
                        && name != ".wsmp-lock"
                        && !name.to_string_lossy().starts_with(".wsmp-pin-")
                })
                .count(),
            2,
            "both private T names survive"
        );
        drop(_scope);

        for method in METHODS {
            // The last clean unlink is the captured original's disposal.
            let fx = Fx::new();
            let etag = prepare(&fx);
            let mut faults = method.faults();
            faults.push((Primitive::Unlink, method.clean_unlinks(), Errno::EIO));
            let _scope = FaultScope::new(&faults);
            let value = op.run(&fx, &etag).unwrap();
            assert_eq!(fx.get("doc"), EDITED);
            assert!(
                has_bytes(&result_paths(&value), ORIGINAL),
                "{op:?}/{method:?}: {value}"
            );
        }

        // A failed published link-alias cleanup is success with a recoverable
        // second hard link. A subsequent write must refuse until it is cleaned.
        let fx = Fx::new();
        let etag = prepare(&fx);
        let mut faults = PublishMethod::Link.faults();
        faults.push((Primitive::Unlink, 2, Errno::EIO));
        let _scope = FaultScope::new(&faults);
        let value = op.run(&fx, &etag).unwrap();
        let aliases = result_paths(&value);
        assert!(has_bytes(&aliases, EDITED), "{value}");
        use std::os::unix::fs::MetadataExt;
        let dir = recovery_dirs(&fx.root).pop().expect("recovery");
        let public = std::fs::metadata(fx.root.join("doc")).unwrap();
        let own_pins = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wsmp-pin-")
            })
            .filter(|entry| {
                std::fs::symlink_metadata(entry.path())
                    .is_ok_and(|pin| (pin.dev(), pin.ino()) == (public.dev(), public.ino()))
            })
            .count() as u64;
        assert_eq!(
            public.nlink() - own_pins,
            2,
            "exactly public + retained private alias, excluding durable identity pins"
        );
        assert_eq!(fx.get("doc"), EDITED);
        let new_etag = fx.etag("doc");
        assert_eq!(
            ReplaceOp::Write.run(&fx, &new_etag).unwrap_err().code,
            ErrorCode::HardLinked
        );
    }
}

#[test]
fn exchangeless_failed_restore_retains_and_names_original() {
    for op in REPLACE_OPS {
        for method in METHODS {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let mut faults = method.faults();
            faults.extend([
                (method.primitive(), 1, Errno::EIO),
                (Primitive::Restore, 1, Errno::EIO),
            ]);
            let _scope = FaultScope::new(&faults);
            let error = op.run(&fx, &etag).unwrap_err();
            let retained = kept(&error);
            assert!(has_bytes(&retained, ORIGINAL));
            assert!(!has_bytes(&retained, EDITED));
            assert!(!fx.root.join("doc").exists());
            no_public_temp(&fx);
        }
    }
}

#[test]
fn exchangeless_capture_enoent_is_conflict_gone_and_after_effect_is_uncertain() {
    for op in REPLACE_OPS {
        for method in METHODS {
            let fx = Fx::new();
            let etag = prepare(&fx);
            let doc = fx.root.join("doc");
            let fx = fx.with_hook(move |step| {
                if step == Step::Vacating {
                    std::fs::remove_file(&doc).unwrap();
                }
                Ok(())
            });
            let _scope = FaultScope::new(&method.faults());
            let error = op.run(&fx, &etag).unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::Conflict,
                "{op:?}/{method:?}: {error:?}"
            );
            assert_eq!(error.detail, Some(json!({"currentEtag": "gone"})));
            assert!(!fx.root.join("doc").exists());
            clean(&fx);
            drop(_scope);

            let fx = Fx::new();
            let etag = prepare(&fx);
            let _scope = FaultScope::with_after_effects(
                &method.faults(),
                &[(Primitive::Capture, 1, Errno::ENOENT)],
            );
            let error = op.run(&fx, &etag).unwrap_err();
            assert!(
                has_bytes(&kept(&error), ORIGINAL),
                "after-effect capture cannot say nothing moved"
            );
            assert!(!fx.root.join("doc").exists());
        }
    }
}

#[test]
fn exchangeless_noreplace_probe_error_after_effect_reports_existing_paths() {
    // The private probe rename took effect but its reply failed: the temp now has
    // another name. It must be disposed (not left behind under a stale reported
    // path), and the public original stays untouched.
    for op in REPLACE_OPS {
        let fx = Fx::new();
        let etag = prepare(&fx);
        let before_doc = fx.get("doc");
        let _scope = FaultScope::with_after_effects(
            &[(Primitive::Exchange, 1, Errno::EINVAL)],
            &[(Primitive::ProbeNoReplace, 1, Errno::EIO)],
        );
        let error = op.run(&fx, &etag).unwrap_err();
        assert_eq!(error.code, ErrorCode::IoError, "{op:?}: {error:?}");
        assert_eq!(fx.get("doc"), before_doc);
        assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
        clean(&fx);
    }
}

#[test]
fn exchangeless_noreplace_probe_errors_stop_before_link_or_capture() {
    let mut checked = 0;
    for op in REPLACE_OPS {
        // EPERM must stop this rename probe; only link classifies it as a
        // capability failure. These expectations do not use either classifier.
        for (errno, expected) in [
            (Errno::EIO, ErrorCode::IoError),
            (Errno::EACCES, ErrorCode::IoError),
            (Errno::EPERM, ErrorCode::IoError),
            (Errno::EMLINK, ErrorCode::IoError),
            (Errno::EEXIST, ErrorCode::Exists),
            (Errno::ENOSPC, ErrorCode::IoError),
            (Errno::EDQUOT, ErrorCode::IoError),
            (Errno::EROFS, ErrorCode::IoError),
        ] {
            checked += 1;
            let fx = Fx::new();
            let etag = prepare(&fx);
            let before = snapshot(&fx.root);
            let mut faults = PublishMethod::NoReplace.faults();
            faults.push((Primitive::ProbeNoReplace, 1, errno));
            let _scope = FaultScope::new(&faults);
            let error = op.run(&fx, &etag).unwrap_err();
            assert_eq!(error.code, expected, "{op:?}/{errno}");
            assert_eq!(
                error.message,
                if errno == Errno::EEXIST {
                    "already exists".to_owned()
                } else {
                    format!("{errno:?}")
                }
            );
            assert_eq!(snapshot(&fx.root), before);
            assert_eq!(count(&FaultScope::calls(), Primitive::ProbeLink), 0);
            assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
            clean(&fx);
        }
    }
    assert_eq!(checked, 16);
}

#[test]
fn exchangeless_private_temp_successor_is_refused_before_public_capture() {
    for (op, method) in REPLACE_OPS
        .into_iter()
        .flat_map(|op| METHODS.map(|method| (op, method)))
    {
        let fx = Fx::new();
        let etag = prepare(&fx);
        let public_before = std::fs::symlink_metadata(fx.root.join("doc")).unwrap();
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::EtagRechecked {
                let tmp = recovery_dirs(&root)[0].join("tmp");
                // The original T remains pinned by both staging File and Held.
                std::fs::remove_file(&tmp).unwrap();
                std::fs::write(&tmp, RACER).unwrap();
            }
            Ok(())
        });
        let _scope = FaultScope::new(&method.faults());
        let error = op.run(&fx, &etag).unwrap_err();
        let retained = kept(&error);
        assert_eq!(fx.get("doc"), ORIGINAL);
        use std::os::unix::fs::MetadataExt;
        let public_after = std::fs::symlink_metadata(fx.root.join("doc")).unwrap();
        assert_eq!(
            (public_before.dev(), public_before.ino()),
            (public_after.dev(), public_after.ino())
        );
        assert!(has_bytes(&retained, RACER));
        assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
        assert_eq!(count(&FaultScope::calls(), method.primitive()), 0);
    }
}

#[test]
fn exchangeless_publish_error_does_not_follow_a_public_symlink_to_temp() {
    for op in REPLACE_OPS {
        for method in METHODS {
            for errno in [Errno::EEXIST, Errno::EIO] {
                let fx = Fx::new();
                let etag = prepare(&fx);
                let root = fx.root.clone();
                let link_target = Arc::new(Mutex::new(None));
                let target = Arc::clone(&link_target);
                let fx = fx.with_hook(move |step| {
                    if step == Step::Vacated {
                        let tmp = recovery_dirs(&root)[0].join(match method {
                            PublishMethod::NoReplace => "probe",
                            PublishMethod::Link => "tmp",
                        });
                        std::os::unix::fs::symlink(&tmp, root.join("doc")).unwrap();
                        *target.lock().unwrap() = Some(tmp);
                    }
                    Ok(())
                });
                let mut faults = method.faults();
                faults.push((method.primitive(), 1, errno));
                let _scope = FaultScope::new(&faults);
                let error = op.run(&fx, &etag).unwrap_err();
                assert!(has_bytes(&kept(&error), ORIGINAL));
                assert!(fx.root.join("doc").is_symlink());
                assert_eq!(
                    std::fs::read_link(fx.root.join("doc")).unwrap(),
                    link_target.lock().unwrap().clone().unwrap()
                );
                assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 1);
                assert_eq!(
                    count(&FaultScope::calls(), Primitive::Unlink),
                    if matches!(method, PublishMethod::Link) {
                        2
                    } else {
                        1
                    }
                );
            }
        }
    }
}
