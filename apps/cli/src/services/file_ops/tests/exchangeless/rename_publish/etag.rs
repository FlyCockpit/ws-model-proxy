//! The rename etag binding: weak and symlink etags, and a later save that
//! the etag must reject.

use super::*;

#[test]
fn rename_link_etag_rejects_a_later_save_and_exposure_keeps_last_alias() {
    for overwrite in [false, true] {
        for write_open_fd in [false, true] {
            let fx = Fx::new();
            let etag = setup(&fx, Object::File, overwrite);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::Renamed {
                    if write_open_fd {
                        use std::io::Write;
                        let mut open = std::fs::OpenOptions::new()
                            .write(true)
                            .open(root.join("dst"))
                            .unwrap();
                        open.write_all(b"written through published fd").unwrap();
                        save(&root.join("dst"), RACER); // old S now has only R/S
                    } else {
                        save(&root.join("dst"), RACER);
                    }
                }
                Ok(())
            });
            let _scope = FaultScope::new(&Shape::Link.faults(overwrite));
            let value = rename_run(&fx, overwrite, etag.as_deref()).unwrap();
            assert!(
                value["etag"].is_null(),
                "D3 must not hand out racer's edit authority"
            );
            let paths = result_paths(&value);
            if write_open_fd {
                assert!(paths.iter().any(|p| {
                    std::fs::read_to_string(p)
                        .is_ok_and(|s| s.starts_with("written through published fd"))
                }));
            } else {
                assert!(has_bytes(&paths, SOURCE));
            }
            assert_eq!(fx.get("dst"), RACER);
        }
    }
}

#[test]
fn rename_weak_and_symlink_etag_binding_inverse() {
    use crate::services::file_ops::ops::mutate::{RenameArgs, RenameResult};
    for object in OBJECTS {
        for change in [false, true] {
            let fx = Fx::new();
            if matches!(object, Object::File) {
                let file = std::fs::File::create(fx.root.join("src")).unwrap();
                file.set_len(crate::services::file_ops::fs::etag::STRONG_ETAG_MAX_BYTES + 1)
                    .unwrap();
            } else {
                object.put(&fx, "src", SOURCE);
            }
            let source_tag = object.tag(&fx, "src");
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if change && step == Step::Renamed {
                    object.save(&root.join("dst"), RACER);
                }
                Ok(())
            });
            let _scope = FaultScope::new(&Shape::Link.faults(false));
            let result: RenameResult = fx
                .ops
                .rename(
                    &args::<RenameArgs>(json!({
                        "from":fx.p("src"),"to":fx.p("dst"),"expectedEtag":source_tag
                    })),
                    &fx.cancel,
                )
                .unwrap();
            if change {
                assert_eq!(result.etag, None);
            } else {
                assert_eq!(
                    result.etag.as_deref(),
                    Some(object.tag(&fx, "dst").as_str())
                );
                clean(&fx);
            }
        }
    }
}

/// D3 for symlinks: a racer replaces the published name with a symlink of the same
/// length and mtime but another target. Size and mtime alone would accept it; only
/// the target comparison rejects it (O1B-1).
#[test]
fn rename_symlink_etag_requires_the_same_target() {
    use crate::services::file_ops::ops::mutate::{RenameArgs, RenameResult};
    use nix::sys::stat::{UtimensatFlags, utimensat};
    use nix::sys::time::TimeSpec;
    use std::os::unix::fs::MetadataExt;
    for racer_target in [None, Some("x".repeat(SOURCE.len()))] {
        let fx = Fx::new();
        Object::Symlink.put(&fx, "src", SOURCE);
        let source_tag = Object::Symlink.tag(&fx, "src");
        let meta = std::fs::symlink_metadata(fx.root.join("src")).unwrap();
        let mtime = TimeSpec::new(meta.mtime(), meta.mtime_nsec());
        let root = fx.root.clone();
        let racer = racer_target.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::Renamed
                && let Some(target) = &racer
            {
                let public = root.join("dst");
                std::fs::remove_file(&public).unwrap();
                std::os::unix::fs::symlink(target, &public).unwrap();
                utimensat(
                    nix::fcntl::AT_FDCWD,
                    &public,
                    &mtime,
                    &mtime,
                    UtimensatFlags::NoFollowSymlink,
                )
                .unwrap();
            }
            Ok(())
        });
        let _scope = FaultScope::new(&Shape::Link.faults(false));
        let result: RenameResult = fx
            .ops
            .rename(
                &args::<RenameArgs>(json!({
                    "from":fx.p("src"),"to":fx.p("dst"),"expectedEtag":source_tag
                })),
                &fx.cancel,
            )
            .unwrap();
        if racer_target.is_some() {
            assert_eq!(
                result.etag, None,
                "a different target must not yield an etag"
            );
        } else {
            assert_eq!(
                result.etag.as_deref(),
                Some(Object::Symlink.tag(&fx, "dst").as_str())
            );
        }
    }
}
