//! Exchange-less filesystem safety at real filesystem boundaries. Syscall
//! faults select the filesystem capabilities; step hooks perform actual saves.
//! No sleeps, synthetic stat replacements, or scheduler races are involved.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use nix::errno::Errno;
use serde_json::{Value, json};

use super::{Fx, args};
use crate::file_ops::exchange::{FaultScope, Primitive};
use crate::file_ops::{Cancel, ErrorCode, FileError, FileOps, FileResult, Step};

const ORIGINAL: &str = "original contents\n";
const EDITED: &str = "edited contents\n";
const RACER: &str = "concurrent save\n";

#[derive(Clone, Copy, Debug)]
enum ReplaceOp {
    Edit,
    Write,
}

const REPLACE_OPS: [ReplaceOp; 2] = [ReplaceOp::Edit, ReplaceOp::Write];

impl ReplaceOp {
    fn run(self, fx: &Fx, etag: &str) -> FileResult<Value> {
        match self {
            Self::Edit => fx.ops.execute(
                "edit",
                json!({"path": fx.p("doc"), "expectedEtag": etag,
                    "edits": [{"oldText": ORIGINAL, "newText": EDITED}]}),
                &fx.cancel,
            ),
            Self::Write => fx.ops.execute(
                "write",
                json!({"path": fx.p("doc"), "expectedEtag": etag,
                    "ifExists": "replace", "content": EDITED}),
                &fx.cancel,
            ),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum PublishMethod {
    NoReplace,
    Link,
}

const METHODS: [PublishMethod; 2] = [PublishMethod::NoReplace, PublishMethod::Link];

impl PublishMethod {
    fn faults(self) -> Vec<(Primitive, usize, Errno)> {
        let mut faults = Vec::new();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        faults.push((Primitive::Exchange, 1, Errno::EINVAL));
        if matches!(self, Self::Link) {
            faults.push((Primitive::ProbeNoReplace, 1, Errno::EINVAL));
        }
        faults
    }

    fn primitive(self) -> Primitive {
        match self {
            Self::NoReplace => Primitive::Publish,
            Self::Link => Primitive::PublishLink,
        }
    }

    fn clean_unlinks(self) -> usize {
        match self {
            Self::NoReplace => 1,
            Self::Link => 3, // probe alias, published alias, captured original
        }
    }
}

fn prepare(fx: &Fx) -> String {
    fx.put("doc", ORIGINAL);
    fx.put("untouched", "unrelated bytes\n");
    fx.etag("doc")
}

/// Replace with a new inode, exactly as an editor's atomic save does.
fn save(path: &Path, bytes: &str) {
    let incoming = path.with_file_name("racer-incoming");
    std::fs::write(&incoming, bytes).unwrap();
    std::fs::rename(incoming, path).unwrap();
}

fn recovery_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".wsmp-recover-")
        })
        .collect();
    dirs.sort();
    dirs
}

#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Directory,
    File(Vec<u8>, u64, u64, u64),
    Symlink(PathBuf, u64, u64),
}

/// Include every name, inode and byte, including private recovery contents.
/// A refusal cannot pass by moving the original away or leaving a temp behind.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Entry> {
    use std::os::unix::fs::MetadataExt;
    fn visit(root: &Path, dir: &Path, entries: &mut BTreeMap<PathBuf, Entry>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            let value = if metadata.file_type().is_symlink() {
                Entry::Symlink(
                    std::fs::read_link(&path).unwrap(),
                    metadata.dev(),
                    metadata.ino(),
                )
            } else if metadata.is_dir() {
                visit(root, &path, entries);
                Entry::Directory
            } else {
                Entry::File(
                    std::fs::read(&path).unwrap(),
                    metadata.dev(),
                    metadata.ino(),
                    metadata.nlink(),
                )
            };
            entries.insert(relative, value);
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

fn clean(fx: &Fx) {
    assert!(
        recovery_dirs(&fx.root).is_empty(),
        "recovery was left behind"
    );
    assert!(
        fx.leftovers("").is_empty(),
        "a public staging name was left behind"
    );
}

fn count(calls: &[Primitive], primitive: Primitive) -> usize {
    calls.iter().filter(|call| **call == primitive).count()
}

fn kept(error: &FileError) -> Vec<PathBuf> {
    assert_eq!(error.code, ErrorCode::UncertainOutcome, "{error:?}");
    let detail = error.detail.as_ref().expect("recovery detail");
    let recovery = PathBuf::from(detail["recovery"].as_str().unwrap());
    assert!(recovery.is_absolute() && recovery.is_dir());
    let paths: Vec<_> = detail["kept"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| PathBuf::from(path.as_str().unwrap()))
        .collect();
    assert!(!paths.is_empty() && paths.len() <= 4, "{detail}");
    for path in &paths {
        assert!(
            path.is_absolute() && std::fs::symlink_metadata(path).is_ok(),
            "{detail}"
        );
    }
    paths
}

fn has_bytes(paths: &[PathBuf], bytes: &str) -> bool {
    paths.iter().any(|path| {
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
            let children: Vec<_> = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            has_bytes(&children, bytes)
        } else {
            std::fs::read(path).is_ok_and(|actual| actual == bytes.as_bytes())
        }
    })
}

fn has_symlink(paths: &[PathBuf], target: &Path) -> bool {
    paths.iter().any(|path| {
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
            let children: Vec<_> = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            has_symlink(&children, target)
        } else {
            std::fs::read_link(path).is_ok_and(|actual| actual == target)
        }
    })
}

fn result_paths(result: &Value) -> Vec<PathBuf> {
    result["recovered"]
        .as_array()
        .expect("nonempty recovered")
        .iter()
        .map(|path| PathBuf::from(path.as_str().unwrap()))
        .collect()
}

fn no_public_temp(fx: &Fx) {
    for entry in std::fs::read_dir(&fx.root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            assert_ne!(
                std::fs::read(path).unwrap(),
                EDITED.as_bytes(),
                "unpublished temp became public"
            );
        }
    }
}

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
            std::fs::read_dir(&dirs[0]).unwrap().count(),
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
        assert_eq!(std::fs::metadata(fx.root.join("doc")).unwrap().nlink(), 2);
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

#[derive(Clone, Copy, Debug)]
enum DeleteKind {
    File,
    Symlink,
}
const DELETE_KINDS: [DeleteKind; 2] = [DeleteKind::File, DeleteKind::Symlink];

fn prepare_delete(fx: &Fx, kind: DeleteKind) {
    fx.put("untouched", "unrelated bytes\n");
    match kind {
        DeleteKind::File => {
            fx.put("doc", ORIGINAL);
        }
        DeleteKind::Symlink => {
            fx.put("original-target", ORIGINAL);
            fx.put("racer-target", RACER);
            fx.link("original-target", "doc");
        }
    }
}

fn delete(fx: &Fx) -> FileResult<Value> {
    fx.ops
        .execute("delete", json!({"path": fx.p("doc")}), &fx.cancel)
}

fn save_delete_successor(doc: &Path, kind: DeleteKind) {
    match kind {
        DeleteKind::File => save(doc, RACER),
        DeleteKind::Symlink => {
            let incoming = doc.with_file_name("racer-incoming");
            std::os::unix::fs::symlink("racer-target", &incoming).unwrap();
            std::fs::rename(incoming, doc).unwrap();
        }
    }
}

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

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn exchangeless_plain_rename_refuses_no_safe_primitive_without_changes() {
    for directory in [false, true] {
        for link_errno in [Errno::EPERM, Errno::EOPNOTSUPP, Errno::EMLINK] {
            let fx = Fx::new();
            if directory {
                fx.put("src/child", ORIGINAL);
            } else {
                fx.put("src", ORIGINAL);
            }
            fx.put("untouched", RACER);
            let before = snapshot(&fx.root);
            let _scope = FaultScope::new(&[
                (Primitive::Move, 1, Errno::EINVAL),
                (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
                (Primitive::ProbeLink, 1, link_errno),
            ]);
            let error = fx
                .ops
                .rename(
                    &args(json!({"from": fx.p("src"), "to": fx.p("dst")})),
                    &fx.cancel,
                )
                .unwrap_err();
            assert_eq!(
                error.code,
                if !directory && link_errno == Errno::EMLINK {
                    ErrorCode::IoError
                } else {
                    ErrorCode::UnsafeFilesystem
                },
                "dir={directory}/{link_errno}: {error:?}"
            );
            assert_eq!(snapshot(&fx.root), before, "dir={directory}/{link_errno}");
            assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
            clean(&fx);
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn exchangeless_overwrite_rename_refuses_unsupported_exchange_and_restores_source() {
    for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
        let fx = Fx::new();
        fx.put("src", "source contents\n");
        fx.put("dst", ORIGINAL);
        let etag = fx.etag("dst");
        let before = snapshot(&fx.root);
        let _scope = FaultScope::new(&[(Primitive::Exchange, 1, errno)]);
        let error = fx.ops.rename(&args(json!({"from": fx.p("src"), "to": fx.p("dst"), "overwrite": true, "expectedEtag": etag})), &fx.cancel).unwrap_err();
        assert_eq!(
            error.code,
            ErrorCode::UnsafeFilesystem,
            "{errno}: {error:?}"
        );
        assert_eq!(snapshot(&fx.root), before);
        clean(&fx);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn exchangeless_final_unlink_has_no_descriptor_on_disposed_inode() {
    use crate::file_ops::exchange::UNLINK_PROBE;
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
    use crate::file_ops::exchange::UNLINK_PROBE;
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
    assert_eq!(*checks.lock().unwrap(), 1);
    clean(&fx);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RealClass {
    nr: bool,
    link: bool,
    noino: bool,
    /// Link counts can be believed (false: the mount always reports 1, like sshfs).
    counts: bool,
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

fn real_fixture(directory: &Path) -> Fx {
    let dir = tempfile::tempdir_in(directory).expect("isolated real filesystem fixture");
    let root = std::fs::canonicalize(dir.path()).unwrap();
    Fx {
        _dir: dir,
        root,
        ops: FileOps::new(
            crate::file_ops::Policy::new(vec![], vec![], true),
            crate::file_ops::EtagKey::from_bytes([7; 32]),
        ),
        cancel: Cancel::new(),
        steps: Arc::new(Mutex::new(Vec::new())),
    }
}

fn check_real_capabilities(directory: &Path, class: RealClass) {
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
    let actual =
        crate::file_ops::exchange::exchange(fd.as_fd(), "a".as_ref(), fd.as_fd(), "b".as_ref());
    assert!(
        actual.is_err_and(crate::file_ops::exchange::is_unsupported),
        "supplied declared mount must not support exchange"
    );
    let nr = crate::file_ops::exchange::no_replace(
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
        assert!(nr.is_err_and(crate::file_ops::exchange::is_unsupported));
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
                .is_some_and(|raw| crate::file_ops::exchange::is_link_unsupported(
                    Errno::from_raw(raw)
                ))
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
        crate::output::diagnostic("SKIP exchangeless cached real filesystem: nothing requested")
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
    rename_publish::real_cached_rows(&directory);
}

/// Env-gated real mount evidence; the exact name is the CI runner contract.
#[test]
fn exchangeless_real_filesystem_optional_e2e() {
    let directory = std::env::var_os("WSMP_EXCHANGELESS_DIR");
    let class = std::env::var_os("WSMP_EXCHANGELESS_CLASS");
    let required = std::env::var_os("WSMP_EXCHANGELESS_REQUIRED").is_some();
    let Some((directory, class)) = real_gate(directory.as_deref(), class.as_deref(), required)
    else {
        crate::output::diagnostic("SKIP exchangeless real filesystem: no mount/class requested")
            .unwrap();
        return;
    };
    check_real_capabilities(&directory, class);
    rename_publish::real_rename_rows(&directory, class);
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

// Check the inode actually about to lose its private alias. Unrelated inspected
// inodes may remain held; this probe never asserts about those descriptors.
#[cfg(target_os = "linux")]
fn watch_private_unlinks(fx: &Fx, slots: &[&str]) -> Arc<Mutex<Vec<(u64, u64)>>> {
    use crate::file_ops::exchange::UNLINK_PROBE;
    use std::os::unix::fs::MetadataExt;
    let root = fx.root.clone();
    let slots: Vec<_> = slots.iter().map(|slot| (*slot).to_owned()).collect();
    let checks = Arc::new(Mutex::new(Vec::new()));
    let checked = Arc::clone(&checks);
    UNLINK_PROBE.with(|probe| {
        *probe.borrow_mut() = Some(Box::new(move || {
            let dirs = recovery_dirs(&root);
            let nth = checked.lock().unwrap().len();
            let private = dirs[0].join(&slots[nth]);
            let Ok(metadata) = std::fs::symlink_metadata(&private) else {
                return;
            };
            let inode = (metadata.dev(), metadata.ino());
            for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                let path = entry.unwrap().path();
                if let Ok(metadata) = std::fs::metadata(&path) {
                    assert_ne!(
                        (metadata.dev(), metadata.ino()),
                        inode,
                        "descriptor still pins the disposed inode: {path:?}"
                    );
                }
            }
            checked.lock().unwrap().push(inode);
        }));
    });
    checks
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
        assert_eq!(checks.lock().unwrap().len(), 1);
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
    use crate::file_ops::exchange::UNLINK_PROBE;
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
    assert_eq!(*checks.lock().unwrap(), 2);
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

#[test]
fn supervised_exchangeless_replace_uses_safe_publication_and_cancel_boundary() {
    for op in ["edit", "write"] {
        for method in [
            Some(PublishMethod::NoReplace),
            Some(PublishMethod::Link),
            None,
        ] {
            for state in ["clean", "racer", "cancel"] {
                let fx = Fx::new();
                let etag = prepare(&fx);
                let path = fx.root.join("doc");
                let cancel = fx.cancel.clone();
                let fx = fx.with_hook(move |step| {
                    if step == Step::Vacating && state == "cancel" {
                        cancel.cancel();
                    }
                    if step == Step::Vacated {
                        // Cancellation after capture cannot abandon compensation.
                        cancel.cancel();
                        if state == "racer" {
                            std::fs::write(&path, RACER).unwrap();
                        }
                    }
                    Ok(())
                });
                let args = if op == "edit" {
                    json!({"path":fx.p("doc"),"expectedEtag":etag,
                        "edits":[{"oldText":ORIGINAL,"newText":EDITED}]})
                } else {
                    json!({"path":fx.p("doc"),"expectedEtag":etag,"ifExists":"replace"})
                };
                let prepared = fx
                    .ops
                    .prepare_supervised(
                        op,
                        args,
                        (op == "write").then(|| EDITED.as_bytes().to_vec()),
                        &crate::file_ops::EtagKey::from_bytes([19; 32]),
                        &fx.cancel,
                    )
                    .unwrap();
                assert!(prepared.child_input().blocked.is_none());
                let before = snapshot(&fx.root);
                let mut faults = method.unwrap_or(PublishMethod::Link).faults();
                if method.is_none() {
                    faults.push((Primitive::ProbeLink, 1, Errno::EPERM));
                }
                let _scope = FaultScope::new(&faults);
                let result = fx.ops.execute_supervised(prepared, &fx.cancel);
                if method.is_none() {
                    assert_eq!(result.unwrap_err().code, ErrorCode::UnsafeFilesystem);
                    assert_eq!(snapshot(&fx.root), before);
                    assert!(!fx.steps.lock().unwrap().contains(&Step::Vacated));
                    assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
                } else if state == "cancel" {
                    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
                    assert_eq!(snapshot(&fx.root), before);
                    assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
                } else if state == "racer" {
                    let error = result.unwrap_err();
                    assert!(has_bytes(&kept(&error), ORIGINAL));
                    assert_eq!(fx.get("doc"), RACER);
                    let wire = serde_json::to_value(crate::protocol::SupervisedFileOutcome::error(
                        error.code.into(),
                    ))
                    .unwrap();
                    assert_eq!(wire, json!({"fileError":{"code":"uncertain_outcome"}}));
                } else {
                    assert!(result.unwrap().get("recovered").is_none());
                    assert_eq!(fx.get("doc"), EDITED);
                    assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 1);
                    clean(&fx);
                }
            }
        }
    }
    for overwrite in [false, true] {
        let fx = Fx::new();
        fx.put("source", ORIGINAL);
        let etag = if overwrite {
            fx.put("destination", RACER);
            Some(fx.etag("destination"))
        } else {
            None
        };
        let prepared = fx
            .ops
            .prepare_supervised(
                "rename",
                json!({"from":fx.p("source"),"to":fx.p("destination"),
                "overwrite":overwrite,"expectedEtag":etag}),
                None,
                &crate::file_ops::EtagKey::from_bytes([19; 32]),
                &fx.cancel,
            )
            .unwrap();
        assert!(prepared.child_input().blocked.is_none());
        let before = snapshot(&fx.root);
        let faults = if overwrite {
            vec![
                (Primitive::ProbeExchange, 1, Errno::EINVAL),
                (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
                (Primitive::ProbeLink, 1, Errno::EPERM),
            ]
        } else {
            vec![
                (Primitive::Move, 1, Errno::EINVAL),
                (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
                (Primitive::ProbeLink, 1, Errno::EPERM),
            ]
        };
        let _scope = FaultScope::new(&faults);
        assert_eq!(
            fx.ops
                .execute_supervised(prepared, &fx.cancel)
                .unwrap_err()
                .code,
            ErrorCode::UnsafeFilesystem
        );
        assert_eq!(snapshot(&fx.root), before);
    }
}

#[path = "rename_publish.rs"]
mod rename_publish;
