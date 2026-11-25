//! The rename rows run on real mounts by the real-filesystem tests, and the
//! capability check's refusal of an exchange-capable mount.

use super::races::{RACES, Race, RaceLink, assert_race, race_hook};
use super::*;
use crate::file_ops::tests::exchangeless::real_fs::{
    RealClass, check_real_capabilities, real_fixture,
};

/// Rows for a link-only mount WITHOUT stable inode numbers that keeps libfuse's default
/// attribute and lookup caching (class `link-noino-cached`, like NFS or SMB with their
/// attribute caches). A cached link count is stale in both directions, so these rows
/// pin the forced-sync count: a clean rename leaves no residue (O2B-2) and a true
/// alias pair whose public name was replaced after the publish keeps its object
/// (O2B-1).
pub(in crate::file_ops::tests::exchangeless) fn real_cached_rows(directory: &Path) {
    use nix::fcntl::AT_FDCWD;
    for object in OBJECTS {
        for overwrite in [false, true] {
            let fx = real_fixture(directory);
            let etag = setup(&fx, object, overwrite);
            let value = rename_run(&fx, overwrite, etag.as_deref()).unwrap();
            assert!(
                value.get("recovered").is_none(),
                "{object:?} overwrite={overwrite}: a clean rename must leave nothing: {value}"
            );
            assert!(
                recovery_dirs(&fx.root).is_empty(),
                "{object:?}: recovery directory left behind"
            );
            assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
        }
        for save in [false, true] {
            let fx = real_fixture(directory);
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
            nix::unistd::linkat(
                AT_FDCWD,
                &fx.root.join("src"),
                AT_FDCWD,
                &fx.root.join("dst"),
                nix::fcntl::AtFlags::empty(),
            )
            .unwrap();
            let etag = object.tag(&fx, "dst");
            let result = rename_run(&fx, true, Some(&etag));
            let expected = if matches!(object, Object::File) && save {
                format!("{SOURCE}+WRITER")
            } else {
                SOURCE.to_owned()
            };
            let reported: Vec<PathBuf> = match &result {
                Ok(value) => inventory(&fx, value),
                Err(error) => error_inventory(&fx, error),
            };
            if save {
                assert!(
                    reported
                        .iter()
                        .any(|path| object.bytes(path).as_deref() == Some(expected.as_str())),
                    "{object:?}: the displaced object must stay reported: {result:?} {reported:?}"
                );
            } else {
                let value = result.unwrap();
                assert!(value.get("recovered").is_none(), "{object:?}: {value}");
                assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
            }
        }
    }
}

pub(in crate::file_ops::tests::exchangeless) fn real_rename_rows(
    directory: &Path,
    class: RealClass,
) {
    for object in OBJECTS {
        for overwrite in [false, true] {
            let fx = real_fixture(directory);
            let etag = setup(&fx, object, overwrite);
            let before = snapshot(&fx.root);
            let result = rename_run(&fx, overwrite, etag.as_deref());
            if !class.nr && !class.link {
                assert_eq!(result.unwrap_err().code, ErrorCode::UnsafeFilesystem);
                assert_eq!(snapshot(&fx.root), before);
            } else {
                let value = result.unwrap();
                assert!(value.get("recovered").is_none());
                assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
                assert_eq!(value["etag"], object.tag(&fx, "dst"));
                use std::os::unix::fs::MetadataExt;
                assert_eq!(
                    std::fs::symlink_metadata(fx.root.join("dst"))
                        .unwrap()
                        .nlink(),
                    1
                );
            }
            clean(&fx);
            if !class.nr && !class.link {
                continue;
            }
            // Direct NR is covered above. Force its safe fallback to exercise plain
            // capture races on the same real mount; all capture/publish/restore calls
            // themselves use the raw mounted primitives. Link-only needs no faults.
            for race in RACES {
                if !overwrite
                    && matches!(
                        race,
                        Race::DestinationSave | Race::DestinationGone | Race::DestinationDirectory
                    )
                {
                    continue;
                }
                let fx = real_fixture(directory);
                let etag = setup(&fx, object, overwrite);
                let fx = race_hook(fx, object, overwrite, race, false);
                let faults = if !overwrite && class.nr {
                    vec![(Primitive::Move, 1, Errno::ENOSYS)]
                } else {
                    vec![]
                };
                let _scope = FaultScope::new(&faults);
                let result = rename_run(&fx, overwrite, etag.as_deref());
                assert_race(
                    &fx,
                    object,
                    overwrite,
                    race,
                    result,
                    RaceLink {
                        link: !class.nr,
                        link_first: !class.nr && class.link && !class.noino,
                        counts: class.counts,
                    },
                );
            }
        }
    }
    for (to, overwrite) in [
        ("moved", false),
        ("tree/sub/moved", false),
        ("empty", true),
        ("nonempty", true),
    ] {
        let fx = real_fixture(directory);
        fx.put("tree/sub/child", SOURCE);
        std::fs::create_dir(fx.root.join("empty")).unwrap();
        fx.put("nonempty/child", DESTINATION);
        let before = snapshot(&fx.root);
        let result=fx.ops.rename(&args(json!({"from":fx.p("tree"),"to":fx.p(to),"overwrite":overwrite,"expectedEtag":overwrite.then_some("unused")})),&fx.cancel);
        if to == "moved" && class.nr {
            assert!(result.unwrap().recovered.is_empty());
            assert_eq!(fx.get("moved/sub/child"), SOURCE);
        } else {
            assert_eq!(
                result.unwrap_err().code,
                if to.starts_with("tree/") {
                    ErrorCode::InvalidInput
                } else if overwrite {
                    ErrorCode::Exists
                } else {
                    ErrorCode::UnsafeFilesystem
                }
            );
            assert_eq!(snapshot(&fx.root), before);
        }
        clean(&fx);
    }
    if class.noino && class.link {
        // True source/destination hard-link aliases present different inodes.
        let fx = real_fixture(directory);
        fx.put("src", SOURCE);
        std::fs::hard_link(fx.root.join("src"), fx.root.join("dst")).unwrap();
        let tag = fx.etag("dst");
        let value = rename_run(&fx, true, Some(&tag)).unwrap();
        assert_eq!(fx.get("dst"), SOURCE);
        assert!(value.get("recovered").is_none());
        clean(&fx);
    }
    // Bound etag and nlink checks on real link mounts, including noino.
    if class.link && !class.nr {
        for overwrite in [false, true] {
            let fx = real_fixture(directory);
            let etag = setup(&fx, Object::File, overwrite);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::Renamed {
                    use std::io::Write;
                    let mut fd = std::fs::OpenOptions::new()
                        .write(true)
                        .open(root.join("dst"))
                        .unwrap();
                    fd.write_all(b"fd-written-source").unwrap();
                    save(&root.join("dst"), RACER);
                }
                Ok(())
            });
            let value = rename_run(&fx, overwrite, etag.as_deref()).unwrap();
            assert!(value["etag"].is_null());
            assert_eq!(fx.get("dst"), RACER);
            if class.counts {
                assert!(result_paths(&value).iter().any(|p| {
                    std::fs::read_to_string(p).is_ok_and(|s| s.starts_with("fd-written-source"))
                }));
            } else {
                // Link counts mean nothing on this mount, so the guard is off and the
                // exposed-writer race is residual (g): the alias is cleaned, nothing kept.
                assert!(value.get("recovered").is_none(), "{value}");
            }
        }
    }
}

#[test]
fn real_gate_rejects_exchange_capable_mount_without_skip() {
    let fx = Fx::new();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_real_capabilities(
            &fx.root,
            RealClass {
                nr: true,
                link: true,
                noino: false,
                counts: true,
            }
        )))
        .is_err(),
        "a declared exchange-less mount with exchange must fail, never SKIP"
    );
}
