//! Delete without exchange: files and symlinks are captured and proven before
//! disposal, directories bypass recovery, and cancellation or a hook error
//! (delete and replace alike) stops only before capture.

use super::*;

#[test]
fn exchangeless_delete_captures_files_and_symlinks_before_disposing() {
    for kind in DELETE_KINDS {
        for race in [Step::Vacating, Step::Vacated] {
            let fx = Fx::new();
            prepare_delete(&fx, kind);
            let doc = fx.root.join("doc");
            let hit = Arc::new(AtomicBool::new(false));
            let seen = Arc::clone(&hit);
            let fx = fx.with_hook(move |step| {
                if step == race {
                    seen.store(true, Ordering::SeqCst);
                    if race == Step::Vacating {
                        save_delete_successor(&doc, kind);
                    } else {
                        assert!(!doc.exists());
                        std::fs::write(&doc, RACER).unwrap();
                    }
                }
                Ok(())
            });
            let _scope = FaultScope::new(&[]);
            let result = delete(&fx);
            assert!(
                hit.load(Ordering::SeqCst),
                "{kind:?}/{race:?}: hook not reached"
            );
            if race == Step::Vacating {
                let error = result.unwrap_err();
                assert_eq!(error.code, ErrorCode::Conflict, "{kind:?}: {error:?}");
                assert_eq!(error.detail, Some(json!({"currentEtag": "replaced"})));
                if matches!(kind, DeleteKind::Symlink) {
                    assert_eq!(
                        std::fs::read_link(fx.root.join("doc")).unwrap(),
                        Path::new("racer-target")
                    );
                }
                assert_eq!(
                    count(&FaultScope::calls(), Primitive::Unlink),
                    0,
                    "no unproven disposal"
                );
            } else {
                let value = result.unwrap();
                assert_eq!(value["deleted"], true);
                assert!(value.get("recovered").is_none());
                assert_eq!(
                    count(&FaultScope::calls(), Primitive::Capture),
                    1,
                    "never recapture racer"
                );
            }
            assert_eq!(fx.get("doc"), RACER, "{kind:?}/{race:?}");
            if matches!(kind, DeleteKind::Symlink) {
                assert_eq!(fx.get("original-target"), ORIGINAL);
                assert_eq!(fx.get("racer-target"), RACER);
            }
            clean(&fx);
        }
    }
}

#[test]
fn exchangeless_delete_success_serializes_recovery_only_when_nonempty() {
    for kind in DELETE_KINDS {
        for fail_dispose in [false, true] {
            let fx = Fx::new();
            prepare_delete(&fx, kind);
            let faults = if fail_dispose {
                vec![(Primitive::Unlink, 1, Errno::EIO)]
            } else {
                vec![]
            };
            let _scope = FaultScope::new(&faults);
            let value = delete(&fx).unwrap();
            assert_eq!(value["deleted"], true);
            assert_eq!(
                value["type"],
                if matches!(kind, DeleteKind::File) {
                    "file"
                } else {
                    "symlink"
                }
            );
            assert!(std::fs::symlink_metadata(fx.root.join("doc")).is_err());
            if fail_dispose {
                let retained = result_paths(&value);
                if matches!(kind, DeleteKind::File) {
                    assert!(has_bytes(&retained, ORIGINAL));
                }
                if matches!(kind, DeleteKind::Symlink) {
                    assert!(has_symlink(&retained, Path::new("original-target")));
                }
            } else {
                assert!(
                    value.get("recovered").is_none(),
                    "empty must be absent: {value}"
                );
                clean(&fx);
            }
        }
    }
    assert_eq!(ErrorCode::UnsafeFilesystem.as_str(), "unsafe_filesystem");
    assert_eq!(
        serde_json::to_value(ErrorCode::UnsafeFilesystem).unwrap(),
        "unsafe_filesystem"
    );
}

#[test]
fn exchangeless_delete_successor_restore_link_or_failure_preserves_data() {
    for kind in DELETE_KINDS {
        for restore_error in [Some(Errno::EINVAL), Some(Errno::EIO)] {
            let fx = Fx::new();
            prepare_delete(&fx, kind);
            let doc = fx.root.join("doc");
            let fx = fx.with_hook(move |step| {
                if step == Step::Vacating {
                    save_delete_successor(&doc, kind);
                }
                Ok(())
            });
            let faults: Vec<_> = restore_error
                .into_iter()
                .map(|errno| (Primitive::Restore, 1, errno))
                .collect();
            let _scope = FaultScope::new(&faults);
            let error = delete(&fx).unwrap_err();
            if restore_error == Some(Errno::EINVAL) {
                assert_eq!(error.code, ErrorCode::Conflict);
                assert_eq!(fx.get("doc"), RACER);
                assert_eq!(count(&FaultScope::calls(), Primitive::RestoreLink), 1);
                clean(&fx);
            } else {
                let retained = kept(&error);
                assert!(std::fs::symlink_metadata(fx.root.join("doc")).is_err());
                if matches!(kind, DeleteKind::File) {
                    assert!(has_bytes(&retained, RACER));
                } else {
                    assert!(has_symlink(&retained, Path::new("racer-target")));
                }
            }
        }
    }
}

#[test]
fn exchangeless_delete_capture_enoent_is_conflict_gone_without_recovery() {
    for kind in DELETE_KINDS {
        let fx = Fx::new();
        prepare_delete(&fx, kind);
        let doc = fx.root.join("doc");
        let fx = fx.with_hook(move |step| {
            if step == Step::Vacating {
                std::fs::remove_file(&doc).unwrap();
            }
            Ok(())
        });
        let _scope = FaultScope::new(&[]);
        let error = delete(&fx).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(error.detail, Some(json!({"currentEtag": "gone"})));
        assert!(std::fs::symlink_metadata(fx.root.join("doc")).is_err());
        assert_eq!(count(&FaultScope::calls(), Primitive::Unlink), 0);
        clean(&fx);
    }
}

#[test]
fn exchangeless_delete_refuses_mkdir_and_unheld_failures_before_capture() {
    for kind in DELETE_KINDS {
        // The refusal reports the REAL open errno; a name that vanished since the
        // lstat is a conflict ("gone"), never a fabricated EACCES.
        for (primitive, errno, expected) in [
            (Primitive::Mkdir, Errno::ENOSPC, ErrorCode::IoError),
            (Primitive::Hold, Errno::EACCES, ErrorCode::IoError),
            (Primitive::Hold, Errno::EMFILE, ErrorCode::IoError),
            (Primitive::Hold, Errno::ENOENT, ErrorCode::Conflict),
        ] {
            let fx = Fx::new();
            prepare_delete(&fx, kind);
            let before = snapshot(&fx.root);
            let _scope = FaultScope::new(&[(primitive, 1, errno)]);
            let error = delete(&fx).unwrap_err();
            assert_eq!(
                error.code, expected,
                "{kind:?}/{primitive:?}/{errno:?}: {error:?}"
            );
            if expected == ErrorCode::IoError {
                assert_eq!(error.message, format!("{errno:?}"));
            }
            assert_eq!(snapshot(&fx.root), before);
            assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
            clean(&fx);
        }
    }
}

#[test]
fn exchangeless_directory_delete_bypasses_recovery_even_when_mkdir_fails() {
    for nonempty in [false, true] {
        let fx = Fx::new();
        std::fs::create_dir(fx.root.join("doc")).unwrap();
        if nonempty {
            fx.put("doc/child", RACER);
        }
        let before = snapshot(&fx.root);
        let _scope = FaultScope::new(&[(Primitive::Mkdir, 1, Errno::ENOSPC)]);
        let result = delete(&fx);
        if nonempty {
            assert_eq!(result.unwrap_err().code, ErrorCode::IoError);
            assert_eq!(
                snapshot(&fx.root),
                before,
                "nonempty directory stays at its original name"
            );
        } else {
            let value = result.unwrap();
            assert_eq!(value, json!({"deleted": true, "type": "dir"}));
            assert!(!fx.root.join("doc").exists());
        }
        let calls = FaultScope::calls();
        assert_eq!(count(&calls, Primitive::Mkdir), 0);
        assert_eq!(count(&calls, Primitive::Capture), 0);
        assert!(!fx.steps.lock().unwrap().contains(&Step::Vacated));
        clean(&fx);
    }
}

#[test]
fn exchangeless_delete_capture_reply_loss_is_uncertain_and_names_the_object() {
    for kind in DELETE_KINDS {
        let fx = Fx::new();
        prepare_delete(&fx, kind);
        let _scope = FaultScope::after_effect(&[(Primitive::Capture, 1, Errno::ENOENT)]);
        let error = delete(&fx).unwrap_err();
        let retained = kept(&error);
        assert!(std::fs::symlink_metadata(fx.root.join("doc")).is_err());
        if matches!(kind, DeleteKind::File) {
            assert!(has_bytes(&retained, ORIGINAL));
        } else {
            assert!(has_symlink(&retained, Path::new("original-target")));
        }
        assert_eq!(
            count(&FaultScope::calls(), Primitive::Unlink),
            0,
            "lost capture reply cannot authorize disposal"
        );
    }
}

#[test]
fn exchangeless_cancellation_and_hook_errors_stop_only_before_capture() {
    for delete_op in [false, true] {
        for op in REPLACE_OPS {
            for method in METHODS {
                for step in [Step::EtagRechecked, Step::Vacating, Step::Vacated] {
                    for cancel_instead_of_error in [false, true] {
                        let fx = Fx::new();
                        let etag = prepare(&fx);
                        let before = snapshot(&fx.root);
                        let cancel = fx.cancel.clone();
                        let fx = fx.with_hook(move |current| {
                            if current == step {
                                if cancel_instead_of_error {
                                    cancel.cancel();
                                } else {
                                    return Err(FileError::errno(Errno::EIO));
                                }
                            }
                            Ok(())
                        });
                        let _scope = FaultScope::new(&method.faults());
                        let result = if delete_op {
                            delete(&fx)
                        } else {
                            op.run(&fx, &etag)
                        };
                        if step == Step::Vacated {
                            let value = result.unwrap_or_else(|error| panic!("delete={delete_op}/{op:?}/{method:?}/{step:?}/cancel={cancel_instead_of_error}: {error:?}"));
                            assert!(value.get("recovered").is_none());
                            if delete_op {
                                assert!(!fx.root.join("doc").exists());
                            } else {
                                assert_eq!(fx.get("doc"), EDITED);
                            }
                        } else {
                            let error = result.unwrap_err();
                            assert_eq!(
                                error.code,
                                if cancel_instead_of_error {
                                    ErrorCode::Cancelled
                                } else {
                                    ErrorCode::IoError
                                }
                            );
                            assert_eq!(snapshot(&fx.root), before);
                            assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
                        }
                        clean(&fx);
                    }
                }
            }
        }
    }
}
