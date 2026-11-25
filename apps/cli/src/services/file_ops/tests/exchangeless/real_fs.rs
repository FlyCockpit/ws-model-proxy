//! Real-filesystem evidence: the env gate for a mounted capability class, the
//! independent capability check, and the end-to-end tests the CI FUSE runner
//! calls by name.

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RealClass {
    pub(super) nr: bool,
    pub(super) link: bool,
    pub(super) noino: bool,
    /// Link counts can be believed (false: the mount always reports 1, like sshfs).
    pub(super) counts: bool,
}

/// Pure test-only gate: env parsing never mutates process-global test state.
fn real_gate(
    dir: Option<&std::ffi::OsStr>,
    class: Option<&std::ffi::OsStr>,
    required: bool,
) -> Option<(PathBuf, RealClass)> {
    if dir.is_none() && class.is_none() && !required {
        return None;
    }
    let directory = dir.expect("declared/required real filesystem needs DIR");
    assert!(
        !directory.is_empty(),
        "real filesystem DIR must not be empty"
    );
    let class = class.expect("declared/required real filesystem needs CLASS");
    let shape = match class.to_str() {
        Some("nr") => RealClass {
            nr: true,
            link: true,
            noino: false,
            counts: true,
        },
        Some("link") => RealClass {
            nr: false,
            link: true,
            noino: false,
            counts: true,
        },
        Some("none") => RealClass {
            nr: false,
            link: false,
            noino: false,
            counts: true,
        },
        Some("nr-noino") => RealClass {
            nr: true,
            link: true,
            noino: true,
            counts: true,
        },
        Some("link-noino") => RealClass {
            nr: false,
            link: true,
            noino: true,
            counts: true,
        },
        // Link counts mean nothing here (always 1, like sshfs); the same strict test.
        Some("link-noino-nlink1") => RealClass {
            nr: false,
            link: true,
            noino: true,
            counts: false,
        },
        Some("none-noino") => RealClass {
            nr: false,
            link: false,
            noino: true,
            counts: true,
        },
        _ => panic!("unknown real filesystem CLASS"),
    };
    Some((PathBuf::from(directory), shape))
}

#[test]
fn exchangeless_real_gate_defaults_and_inverse_failures() {
    use std::ffi::OsStr;
    assert_eq!(real_gate(None, None, false), None);
    for (dir, class, required) in [
        (None, None, true),
        (Some("dir"), None, false),
        (None, Some("nr"), false),
        (Some("dir"), None, true),
        (None, Some("nr"), true),
        (Some("dir"), Some("bad"), false),
        (Some("dir"), Some("nr-noino-noino"), true),
        (Some(""), Some("nr"), true),
        (Some("dir"), Some(""), false),
    ] {
        assert!(
            std::panic::catch_unwind(|| real_gate(
                dir.map(OsStr::new),
                class.map(OsStr::new),
                required
            ))
            .is_err()
        );
    }
    for (class, nr, link, noino, counts) in [
        ("nr", true, true, false, true),
        ("link", false, true, false, true),
        ("none", false, false, false, true),
        ("nr-noino", true, true, true, true),
        ("link-noino", false, true, true, true),
        ("link-noino-nlink1", false, true, true, false),
        ("none-noino", false, false, true, true),
    ] {
        for required in [false, true] {
            assert_eq!(
                real_gate(Some(OsStr::new("dir")), Some(OsStr::new(class)), required),
                Some((
                    PathBuf::from("dir"),
                    RealClass {
                        nr,
                        link,
                        noino,
                        counts
                    }
                ))
            );
        }
    }
}

pub(super) fn real_fixture(directory: &Path) -> Fx {
    let dir = tempfile::tempdir_in(directory).expect("isolated real filesystem fixture");
    let root = std::fs::canonicalize(dir.path()).unwrap();
    Fx {
        _dir: dir,
        root,
        ops: FileOps::new(
            crate::services::file_ops::Policy::new(vec![], vec![], true),
            crate::services::file_ops::EtagKey::from_bytes([7; 32]),
        ),
        cancel: Cancel::new(),
        steps: Arc::new(Mutex::new(Vec::new())),
        _registry: crate::services::file_ops::journal::registry::install_temp_registry(),
    }
}

pub(super) fn check_real_capabilities(directory: &Path, class: RealClass) {
    use nix::fcntl::{OFlag, open};
    use nix::sys::stat::Mode;
    use std::os::fd::AsFd;
    use std::os::unix::fs::MetadataExt;
    let fx = real_fixture(directory);
    fx.put("a", "a");
    fx.put("b", "b");
    let fd = open(
        &fx.root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .unwrap();
    let actual = crate::services::file_ops::fs::exchange::exchange(
        fd.as_fd(),
        "a".as_ref(),
        fd.as_fd(),
        "b".as_ref(),
    );
    assert!(
        actual.is_err_and(crate::services::file_ops::fs::exchange::is_unsupported),
        "supplied declared mount must not support exchange"
    );
    let nr = crate::services::file_ops::fs::exchange::no_replace(
        fd.as_fd(),
        "a".as_ref(),
        fd.as_fd(),
        "absent".as_ref(),
        Primitive::Move,
    );
    assert_eq!(
        nr.is_ok(),
        class.nr,
        "raw absent-name NR must match declared class"
    );
    if !class.nr {
        assert!(nr.is_err_and(crate::services::file_ops::fs::exchange::is_unsupported));
    }
    let source = fx.root.join(if class.nr { "absent" } else { "a" });
    let alias = fx.root.join("alias");
    let linked = std::fs::hard_link(&source, &alias);
    assert_eq!(
        linked.is_ok(),
        class.link,
        "raw absent-name link must match declared class"
    );
    if class.link {
        let one = std::fs::symlink_metadata(&source).unwrap();
        let two = std::fs::symlink_metadata(&alias).unwrap();
        assert_eq!(
            one.ino() != two.ino(),
            class.noino,
            "simultaneous link-name inode mode"
        );
        for path in [&source, &alias] {
            let held = std::fs::File::open(path).unwrap();
            assert_eq!(
                held.metadata().unwrap().ino(),
                std::fs::symlink_metadata(path).unwrap().ino(),
                "own-name fd proof"
            );
        }
    } else {
        assert!(
            linked
                .as_ref()
                .err()
                .and_then(std::io::Error::raw_os_error)
                .is_some_and(
                    |raw| crate::services::file_ops::fs::exchange::is_link_unsupported(
                        Errno::from_raw(raw)
                    )
                )
        );
        // The no-link daemon cannot create this pair. The runner seeds these two
        // hard links in its backing directory before mounting the none classes.
        let one = directory.join("inode-probe-a");
        let two = directory.join("inode-probe-b");
        for path in [&one, &two] {
            let held = std::fs::File::open(path).expect("seeded pair must be openable");
            assert_eq!(
                held.metadata().unwrap().ino(),
                std::fs::symlink_metadata(path).unwrap().ino(),
                "seeded alias own-name fd proof"
            );
        }
        let one = std::fs::symlink_metadata(one).expect("none class needs seeded inode-probe-a");
        let two = std::fs::symlink_metadata(two).expect("none class needs seeded inode-probe-b");
        assert!(
            one.nlink() >= 2 && two.nlink() >= 2,
            "seeded pair must be hard links"
        );
        assert_eq!(
            one.ino() != two.ino(),
            class.noino,
            "seeded link-name inode mode"
        );
    }
}

/// The cached-attribute class: strict like the six-class test, but only this one class.
#[test]
fn exchangeless_real_filesystem_cached_e2e() {
    let directory = std::env::var_os("WSMP_EXCHANGELESS_DIR");
    let class = std::env::var_os("WSMP_EXCHANGELESS_CLASS");
    let required = std::env::var_os("WSMP_EXCHANGELESS_REQUIRED").is_some();
    if directory.is_none() && class.is_none() && !required {
        crate::app::output::diagnostic(
            "SKIP exchangeless cached real filesystem: nothing requested",
        )
        .unwrap();
        return;
    }
    let directory = directory.expect("the cached real filesystem needs DIR");
    assert_eq!(
        class.as_deref().and_then(std::ffi::OsStr::to_str),
        Some("link-noino-cached"),
        "the cached test runs only on the link-noino-cached class"
    );
    let directory = PathBuf::from(directory);
    check_real_capabilities(
        &directory,
        RealClass {
            nr: false,
            link: true,
            noino: true,
            counts: true,
        },
    );
    rename_publish::real_rows::real_cached_rows(&directory);
}

/// Env-gated real mount evidence; the exact name is the CI runner contract.
#[test]
fn exchangeless_real_filesystem_optional_e2e() {
    let directory = std::env::var_os("WSMP_EXCHANGELESS_DIR");
    let class = std::env::var_os("WSMP_EXCHANGELESS_CLASS");
    let required = std::env::var_os("WSMP_EXCHANGELESS_REQUIRED").is_some();
    let Some((directory, class)) = real_gate(directory.as_deref(), class.as_deref(), required)
    else {
        crate::app::output::diagnostic(
            "SKIP exchangeless real filesystem: no mount/class requested",
        )
        .unwrap();
        return;
    };
    check_real_capabilities(&directory, class);
    rename_publish::real_rows::real_rename_rows(&directory, class);
    fn fixture(directory: &Path) -> Fx {
        real_fixture(directory)
    }
    for op in REPLACE_OPS {
        for race in [
            None,
            Some(Step::Vacating),
            Some(Step::Vacated),
            Some(Step::Renamed),
        ] {
            let fx = fixture(directory.as_path());
            let etag = prepare(&fx);
            let doc = fx.root.join("doc");
            let before = snapshot(&fx.root);
            let fx = fx.with_hook(move |step| {
                if Some(step) == race {
                    if step == Step::Vacated {
                        assert!(!doc.exists());
                        std::fs::write(&doc, RACER).unwrap();
                    } else {
                        save(&doc, RACER);
                    }
                }
                Ok(())
            });
            match op.run(&fx, &etag) {
                Ok(value) => {
                    assert!(class.nr || class.link, "none mount must refuse");
                    assert_eq!(
                        fx.get("doc"),
                        if race == Some(Step::Renamed) {
                            RACER
                        } else {
                            EDITED
                        }
                    );
                    assert!(value.get("recovered").is_none());
                    if race.is_none() {
                        // The returned etag must describe the public name even
                        // where link publication gives it its own inode number.
                        assert_eq!(value["etag"], fx.etag("doc"), "{op:?}");
                    }
                    clean(&fx);
                }
                Err(error) if error.code == ErrorCode::UnsafeFilesystem => {
                    assert!(
                        !class.nr && !class.link,
                        "capable mount must publish: {error:?}"
                    );
                    assert_eq!(snapshot(&fx.root), before);
                    clean(&fx);
                }
                Err(error) if race == Some(Step::Vacating) => {
                    assert_eq!(error.code, ErrorCode::Conflict);
                    assert_eq!(fx.get("doc"), RACER);
                    clean(&fx);
                }
                Err(error) if race == Some(Step::Vacated) => {
                    assert!(has_bytes(&kept(&error), ORIGINAL));
                    assert_eq!(fx.get("doc"), RACER);
                    no_public_temp(&fx);
                }
                Err(error) => panic!("real filesystem {op:?}/{race:?}: {error:?}"),
            }
        }
    }
    for kind in DELETE_KINDS {
        for race in [None, Some(Step::Vacating), Some(Step::Vacated)] {
            let fx = fixture(directory.as_path());
            prepare_delete(&fx, kind);
            let doc = fx.root.join("doc");
            let fx = fx.with_hook(move |step| {
                if Some(step) == race {
                    if step == Step::Vacating {
                        save_delete_successor(&doc, kind);
                    } else {
                        assert!(std::fs::symlink_metadata(&doc).is_err());
                        std::fs::write(&doc, RACER).unwrap();
                    }
                }
                Ok(())
            });
            let result = delete(&fx);
            let mut retained = false;
            if race == Some(Step::Vacating) {
                let error = result.unwrap_err();
                retained = error.code == ErrorCode::UncertainOutcome;
                match error.code {
                    ErrorCode::Conflict => match kind {
                        DeleteKind::File => assert_eq!(fx.get("doc"), RACER),
                        DeleteKind::Symlink => assert_eq!(
                            std::fs::read_link(fx.root.join("doc")).unwrap(),
                            Path::new("racer-target")
                        ),
                    },
                    // No restore primitive (neither NOREPLACE nor link): the
                    // racer stays named in recovery, never unlinked.
                    ErrorCode::UncertainOutcome => assert!(
                        match kind {
                            DeleteKind::File => has_bytes(&kept(&error), RACER),
                            DeleteKind::Symlink =>
                                has_symlink(&kept(&error), Path::new("racer-target")),
                        },
                        "racer object must stay in recovery: {error:?}"
                    ),
                    other => panic!("unexpected {other:?}"),
                }
            } else {
                assert!(result.unwrap().get("recovered").is_none());
                if race.is_some() {
                    assert_eq!(fx.get("doc"), RACER);
                } else {
                    assert!(std::fs::symlink_metadata(fx.root.join("doc")).is_err());
                }
            }
            if !retained {
                clean(&fx);
            }
        }
    }
}
