//! #172 rename transaction tables. All races are actual saves at deterministic
//! seams; Linux and macOS execute the same rows (FUSE evidence is Linux-only).
use super::*;

mod aliases;
mod etag;
mod intent;
mod races;
pub(super) mod real_rows;

#[derive(Clone, Copy, Debug)]
enum Shape {
    Exchange,
    Nr,
    Link,
    None,
}
impl Shape {
    fn faults(self, overwrite: bool) -> Vec<(Primitive, usize, Errno)> {
        let mut rows = Vec::new();
        if !overwrite && !matches!(self, Self::Exchange | Self::Nr) {
            rows.push((Primitive::Move, 1, Errno::EINVAL));
        }
        if overwrite && !matches!(self, Self::Exchange) {
            rows.push((Primitive::ProbeExchange, 1, Errno::EINVAL));
        }
        if matches!(self, Self::Link | Self::None) {
            rows.push((Primitive::ProbeNoReplace, 1, Errno::EINVAL));
            // Real link-only mounts also reject capture/restore flags.
            for nth in 1..=2 {
                rows.push((Primitive::Capture, nth, Errno::EINVAL));
                rows.push((Primitive::Restore, nth, Errno::EINVAL));
            }
        }
        if matches!(self, Self::None) {
            rows.push((Primitive::ProbeLink, 1, Errno::EPERM));
        }
        rows
    }
    fn publish(self) -> Primitive {
        if matches!(self, Self::Link) {
            Primitive::PublishLink
        } else {
            Primitive::Publish
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Object {
    File,
    Symlink,
}
impl Object {
    fn put(self, fx: &Fx, name: &str, text: &str) {
        match self {
            Self::File => {
                fx.put(name, text);
            }
            Self::Symlink => fx.link(text, name),
        }
    }
    fn bytes(self, path: &Path) -> Option<String> {
        match self {
            Self::File => std::fs::read_to_string(path).ok(),
            Self::Symlink => std::fs::read_link(path)
                .ok()
                .map(|p| p.to_string_lossy().into_owned()),
        }
    }
    fn tag(self, fx: &Fx, name: &str) -> String {
        match self {
            Self::File => {
                let stat = crate::services::file_ops::fs::meta::Stat::from_metadata(
                    &std::fs::metadata(fx.root.join(name)).unwrap(),
                );
                if stat.size > crate::services::file_ops::fs::etag::STRONG_ETAG_MAX_BYTES {
                    fx.ops.context().key.weak_stat(&stat)
                } else {
                    fx.etag(name)
                }
            }
            Self::Symlink => fx.ops.context().key.weak_stat(
                &crate::services::file_ops::fs::meta::Stat::from_metadata(
                    &std::fs::symlink_metadata(fx.root.join(name)).unwrap(),
                ),
            ),
        }
    }
    fn save(self, path: &Path, text: &str) {
        match self {
            Self::File => save(path, text),
            Self::Symlink => {
                let incoming = path.with_file_name("incoming-link");
                std::os::unix::fs::symlink(text, &incoming).unwrap();
                std::fs::rename(incoming, path).unwrap();
            }
        }
    }
    fn kept(self, paths: &[PathBuf], text: &str) -> bool {
        match self {
            Self::File => has_bytes(paths, text),
            Self::Symlink => has_symlink(paths, Path::new(text)),
        }
    }
}
impl Object {
    /// Exclusive create. Vacate-first races run against a vacant name; link-first
    /// still has the source, and truncating it would destroy the admitted bytes.
    fn put_path(self, path: &Path, text: &str) {
        match self {
            Self::File => {
                use std::io::Write;
                match std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                {
                    Ok(mut file) => file.write_all(text.as_bytes()).unwrap(),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("create {path:?}: {error}"),
                }
            }
            Self::Symlink => match std::os::unix::fs::symlink(text, path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("symlink {path:?}: {error}"),
            },
        }
    }
}
const OBJECTS: [Object; 2] = [Object::File, Object::Symlink];
const SOURCE: &str = "source bytes or dangling target";
const DESTINATION: &str = "destination bytes or dangling target";
fn setup(fx: &Fx, object: Object, overwrite: bool) -> Option<String> {
    object.put(fx, "src", SOURCE);
    if overwrite {
        object.put(fx, "dst", DESTINATION);
        Some(object.tag(fx, "dst"))
    } else {
        None
    }
}
fn rename_run(fx: &Fx, overwrite: bool, etag: Option<&str>) -> FileResult<Value> {
    let input =
        json!({"from":fx.p("src"), "to":fx.p("dst"), "overwrite":overwrite,"expectedEtag":etag});
    fx.ops.execute("rename", input, &fx.cancel)
}
fn inventory(fx: &Fx, value: &Value) -> Vec<PathBuf> {
    let mut paths = vec![fx.root.join("src"), fx.root.join("dst")];
    if let Some(recovered) = value.get("recovered") {
        paths.extend(
            recovered
                .as_array()
                .unwrap()
                .iter()
                .map(|p| PathBuf::from(p.as_str().unwrap())),
        );
    }
    paths
}
fn error_inventory(fx: &Fx, error: &FileError) -> Vec<PathBuf> {
    let mut paths = vec![fx.root.join("src"), fx.root.join("dst")];
    if error.code == ErrorCode::UncertainOutcome {
        paths.extend(kept(error));
    }
    paths
}

#[test]
fn rename_clean_shapes_kinds_and_third_links() {
    for object in OBJECTS {
        for shape in [Shape::Exchange, Shape::Nr, Shape::Link, Shape::None] {
            for overwrite in [false, true] {
                let fx = Fx::new();
                let etag = setup(&fx, object, overwrite);
                let before = snapshot(&fx.root);
                let _scope = FaultScope::new(&shape.faults(overwrite));
                let result = rename_run(&fx, overwrite, etag.as_deref());
                if matches!(shape, Shape::None) {
                    assert_eq!(result.unwrap_err().code, ErrorCode::UnsafeFilesystem);
                    assert_eq!(snapshot(&fx.root), before);
                    assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
                } else {
                    let value = result
                        .unwrap_or_else(|e| panic!("{shape:?}/{object:?}/{overwrite}: {e:?}"));
                    assert!(value.get("recovered").is_none(), "{value}");
                    assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
                    assert!(std::fs::symlink_metadata(fx.root.join("src")).is_err());
                    assert_eq!(value["etag"], object.tag(&fx, "dst"));
                }
                clean(&fx);
            }
        }
    }
    for overwrite in [false, true] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, overwrite);
        std::fs::hard_link(fx.root.join("src"), fx.root.join("third")).unwrap();
        let _scope = FaultScope::new(&Shape::Link.faults(overwrite));
        assert!(
            rename_run(&fx, overwrite, etag.as_deref())
                .unwrap()
                .get("recovered")
                .is_none()
        );
        assert_eq!(fx.get("third"), SOURCE);
        assert_eq!(fx.get("dst"), SOURCE);
        clean(&fx);
    }
}

#[test]
fn rename_preflight_errno_and_actual_object_table() {
    for overwrite in [false, true] {
        for object in OBJECTS {
            for (primitive, nth, errno, expected) in [
                (Primitive::ProbeCreate, 1, Errno::ENOSPC, ErrorCode::IoError),
                (Primitive::ProbeCreate, 1, Errno::EDQUOT, ErrorCode::IoError),
                (Primitive::ProbeCreate, 1, Errno::EACCES, ErrorCode::IoError),
                (Primitive::ProbeCreate, 1, Errno::EIO, ErrorCode::IoError),
                (Primitive::ProbeCreate, 2, Errno::ENOSPC, ErrorCode::IoError),
                (Primitive::ProbeCreate, 2, Errno::EDQUOT, ErrorCode::IoError),
                (Primitive::ProbeCreate, 2, Errno::EACCES, ErrorCode::IoError),
                (Primitive::ProbeCreate, 2, Errno::EIO, ErrorCode::IoError),
                (
                    Primitive::ProbeNoReplace,
                    1,
                    Errno::EPERM,
                    ErrorCode::IoError,
                ),
                (
                    Primitive::ProbeNoReplace,
                    1,
                    Errno::EXDEV,
                    ErrorCode::IoError,
                ),
                (
                    Primitive::ProbeNoReplace,
                    1,
                    Errno::ENOSPC,
                    ErrorCode::IoError,
                ),
                (
                    Primitive::ProbeNoReplace,
                    1,
                    Errno::EDQUOT,
                    ErrorCode::IoError,
                ),
                (
                    Primitive::ProbeNoReplace,
                    1,
                    Errno::EACCES,
                    ErrorCode::IoError,
                ),
                (Primitive::ProbeNoReplace, 1, Errno::EIO, ErrorCode::IoError),
                (
                    Primitive::ProbeLink,
                    1,
                    Errno::EPERM,
                    ErrorCode::UnsafeFilesystem,
                ),
                (Primitive::ProbeLink, 1, Errno::EMLINK, ErrorCode::IoError),
                (Primitive::ProbeLink, 1, Errno::ENOSPC, ErrorCode::IoError),
                (Primitive::ProbeLink, 1, Errno::EIO, ErrorCode::IoError),
                (
                    Primitive::ProbeLink,
                    2,
                    Errno::EPERM,
                    ErrorCode::UnsafeFilesystem,
                ),
            ] {
                if nth == 2 && !overwrite {
                    continue;
                }
                let fx = Fx::new();
                let etag = setup(&fx, object, overwrite);
                let before = snapshot(&fx.root);
                let mut faults = Shape::Link.faults(overwrite);
                faults.retain(|(p, n, _)| (*p, *n) != (primitive, nth));
                faults.push((primitive, nth, errno));
                let _scope = FaultScope::new(&faults);
                let error = rename_run(&fx, overwrite, etag.as_deref()).unwrap_err();
                assert_eq!(
                    error.code, expected,
                    "{overwrite}/{object:?}/{primitive:?}/{nth}/{errno}"
                );
                assert_eq!(snapshot(&fx.root), before);
                clean(&fx);
                assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
            }
        }
    }
    // Discriminates D2's actual-object probe from a dummy-file link: inspect the
    // alias while it exists, before any capture, over S and D separately.
    for object in OBJECTS {
        let fx = Fx::new();
        let etag = setup(&fx, object, true);
        let root = fx.root.clone();
        let probes = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&probes);
        let fx = fx.with_hook(move |step| {
            if step == Step::LinkProbed {
                assert!(root.join("src").exists() || root.join("src").is_symlink());
                seen.lock().unwrap().push(
                    object
                        .bytes(&recovery_dirs(&root)[0].join("probe"))
                        .unwrap(),
                );
            }
            Ok(())
        });
        let _scope = FaultScope::new(&Shape::Link.faults(true));
        rename_run(&fx, true, etag.as_deref()).unwrap();
        assert_eq!(*probes.lock().unwrap(), [SOURCE, DESTINATION]);
        clean(&fx);
    }
    for errno in [
        Errno::EPERM,
        Errno::EXDEV,
        Errno::ENOSPC,
        Errno::EDQUOT,
        Errno::EACCES,
        Errno::EIO,
    ] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, true);
        let before = snapshot(&fx.root);
        let _scope = FaultScope::new(&[(Primitive::ProbeExchange, 1, errno)]);
        assert_eq!(
            rename_run(&fx, true, etag.as_deref()).unwrap_err().code,
            ErrorCode::IoError
        );
        assert_eq!(snapshot(&fx.root), before);
        clean(&fx);
    }
    // Each rung recognizes only the capability errnos, and the next rung really
    // runs. In particular NR failure must test actual-object linking, not refuse.
    for object in OBJECTS {
        for primitive in [
            Primitive::ProbeExchange,
            Primitive::ProbeNoReplace,
            Primitive::ProbeLink,
        ] {
            for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
                let fx = Fx::new();
                let etag = setup(&fx, object, true);
                let before = snapshot(&fx.root);
                let mut faults = if primitive == Primitive::ProbeExchange {
                    Shape::Nr.faults(true)
                } else {
                    Shape::Link.faults(true)
                };
                faults.retain(|(p, n, _)| (*p, *n) != (primitive, 1));
                faults.push((primitive, 1, errno));
                let _scope = FaultScope::new(&faults);
                let result = rename_run(&fx, true, etag.as_deref());
                if primitive == Primitive::ProbeLink {
                    assert_eq!(result.unwrap_err().code, ErrorCode::UnsafeFilesystem);
                    assert_eq!(snapshot(&fx.root), before);
                    assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
                } else {
                    assert!(result.unwrap().get("recovered").is_none());
                    assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
                    assert_eq!(
                        count(&FaultScope::calls(), Primitive::ProbeLink),
                        if primitive == Primitive::ProbeExchange {
                            0
                        } else {
                            2
                        }
                    );
                }
                clean(&fx);
            }
        }
    }
}

#[test]
fn rename_noncommit_paths_never_dispose_the_user_source() {
    for object in OBJECTS {
        for shape in [Shape::Nr, Shape::Link] {
            // Link-first's first capture is the destination. NR captures it second.
            let dest_capture = if matches!(shape, Shape::Link) { 1 } else { 2 };
            for (primitive, nth, errno, after) in [
                (Primitive::PublishPrepare, 1, Errno::EIO, false), // D1 site 1
                (Primitive::Capture, dest_capture, Errno::ENOENT, false), // D1 site 2
                (Primitive::Capture, dest_capture, Errno::EIO, true),
                (shape.publish(), 1, Errno::EIO, false), // D1 site 5
                (shape.publish(), 1, Errno::EPERM, false),
                (shape.publish(), 1, Errno::EMLINK, false),
                (shape.publish(), 1, Errno::ENOSPC, false),
                (shape.publish(), 1, Errno::EEXIST, false), // D1 site 4
            ] {
                let fx = Fx::new();
                let etag = setup(&fx, object, true);
                let mut faults = shape.faults(true);
                faults.retain(|(p, n, _)| !(*p == primitive && *n == nth));
                let effects = if after {
                    vec![(primitive, nth, errno)]
                } else {
                    faults.push((primitive, nth, errno));
                    vec![]
                };
                let _scope = FaultScope::with_after_effects(&faults, &effects);
                let error = rename_run(&fx, true, etag.as_deref()).unwrap_err();
                let paths = error_inventory(&fx, &error);
                assert!(
                    object.kept(&paths, SOURCE),
                    "{object:?}/{shape:?}/{primitive:?}/{after}: {error:?}"
                );
                assert!(
                    object.kept(&paths, DESTINATION),
                    "D must survive: {error:?}"
                );
                if error.code != ErrorCode::UncertainOutcome {
                    clean(&fx);
                }
            }
        }
    }
}

#[test]
fn rename_directory_unsupported_nr_stays_unsafe_filesystem() {
    let fx = Fx::new();
    fx.put("tree/sub/child", SOURCE);
    let _scope = FaultScope::new(&[
        (Primitive::Move, 1, Errno::EINVAL),
        (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
    ]);
    let error = fx
        .ops
        .rename(
            &args(json!({"from":fx.p("tree"),"to":fx.p("elsewhere"),"overwrite":false})),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsafeFilesystem);
}

#[test]
fn rename_directory_identity_walk_refuses_a_child() {
    let fx = Fx::new();
    fx.put("tree/sub/child", SOURCE);
    let _scope = FaultScope::new(&[]);
    let error = fx
        .ops
        .rename(
            &args(json!({"from":fx.p("tree"),"to":fx.p("tree/sub/moved"),"overwrite":false})),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[test]
fn rename_directories_subtree_and_macos_direct_nr_inverse() {
    for (to, overwrite, expected) in [
        ("tree/sub/moved", false, Some(ErrorCode::InvalidInput)),
        ("empty", true, Some(ErrorCode::Exists)),
        ("nonempty", true, Some(ErrorCode::Exists)),
        ("moved", false, None),
    ] {
        let fx = Fx::new();
        fx.put("tree/sub/child", SOURCE);
        std::fs::create_dir(fx.root.join("empty")).unwrap();
        fx.put("nonempty/child", DESTINATION);
        let before = snapshot(&fx.root);
        let _scope = FaultScope::new(&[]);
        let result=fx.ops.rename(&args(json!({"from":fx.p("tree"),"to":fx.p(to),"overwrite":overwrite,"expectedEtag":overwrite.then_some("unused")})),&fx.cancel);
        if let Some(code) = expected {
            assert_eq!(result.unwrap_err().code, code);
            assert_eq!(snapshot(&fx.root), before);
        } else {
            assert!(result.unwrap().recovered.is_empty());
            assert_eq!(fx.get("moved/sub/child"), SOURCE);
        }
        assert_eq!(
            count(&FaultScope::calls(), Primitive::Mkdir),
            usize::from(expected.is_none())
        );
        clean(&fx);
    }
    let fx = Fx::new();
    let etag = setup(&fx, Object::File, false);
    let _scope = FaultScope::new(&[]);
    assert!(
        rename_run(&fx, false, etag.as_deref())
            .unwrap()
            .get("recovered")
            .is_none()
    );
    assert_eq!(count(&FaultScope::calls(), Primitive::Move), 1);
    assert_eq!(count(&FaultScope::calls(), Primitive::Mkdir), 1);
    clean(&fx);
}

#[test]
fn rename_cross_parent_clean_and_both_origin_collision_table() {
    for object in OBJECTS {
        for shape in [Shape::Nr, Shape::Link] {
            for overwrite in [false, true] {
                for race in [false, true] {
                    let fx = Fx::new();
                    std::fs::create_dir(fx.root.join("a")).unwrap();
                    std::fs::create_dir(fx.root.join("b")).unwrap();
                    object.put(&fx, "a/src", SOURCE);
                    let tag = if overwrite {
                        object.put(&fx, "b/dst", DESTINATION);
                        Some(object.tag(&fx, "b/dst"))
                    } else {
                        None
                    };
                    let root = fx.root.clone();
                    let fx = fx.with_hook(move |step| {
                        if race && step == Step::DestinationVacated {
                            object.put_path(&root.join("a/src"), "source racer");
                            object.put_path(&root.join("b/dst"), RACER);
                        }
                        Ok(())
                    });
                    let mut faults = shape.faults(overwrite);
                    if !overwrite && matches!(shape, Shape::Nr) {
                        faults.push((Primitive::Move, 1, Errno::ENOSYS));
                    }
                    let _scope = FaultScope::new(&faults);
                    let result = fx.ops.execute("rename", json!({"from":fx.p("a/src"),"to":fx.p("b/dst"),"overwrite":overwrite,"expectedEtag":tag}), &fx.cancel);
                    if race && matches!(shape, Shape::Link) {
                        // Stable inodes link first: the source name is still the
                        // admitted object, so the exclusive create does not land.
                        if overwrite {
                            let e = result.unwrap_err();
                            let paths = kept(&e);
                            // S was never captured. D stays in R because the racer
                            // occupies the destination name.
                            assert!(object.kept(&paths, DESTINATION), "{e:?} {paths:?}");
                            assert_eq!(
                                object.bytes(&fx.root.join("a/src")).as_deref(),
                                Some(SOURCE)
                            );
                            assert_eq!(
                                object.bytes(&fx.root.join("b/dst")).as_deref(),
                                Some(RACER)
                            );
                        } else {
                            let e = result.unwrap_err();
                            assert_eq!(e.code, ErrorCode::Exists, "{e:?}");
                            assert_eq!(
                                object.bytes(&fx.root.join("a/src")).as_deref(),
                                Some(SOURCE)
                            );
                            assert_eq!(
                                object.bytes(&fx.root.join("b/dst")).as_deref(),
                                Some(RACER)
                            );
                            clean(&fx);
                        }
                    } else if race {
                        let e = result.unwrap_err();
                        let paths = kept(&e);
                        assert!(object.kept(&paths, SOURCE));
                        if overwrite {
                            assert!(object.kept(&paths, DESTINATION));
                        }
                        assert_eq!(
                            object.bytes(&fx.root.join("a/src")).as_deref(),
                            Some("source racer")
                        );
                        assert_eq!(object.bytes(&fx.root.join("b/dst")).as_deref(), Some(RACER));
                    } else {
                        let value = result.unwrap();
                        assert!(value.get("recovered").is_none());
                        assert_eq!(value["etag"], object.tag(&fx, "b/dst"));
                        assert_eq!(
                            object.bytes(&fx.root.join("b/dst")).as_deref(),
                            Some(SOURCE)
                        );
                        assert!(!snapshot(&fx.root).keys().any(|p| {
                            p.components()
                                .any(|c| c.as_os_str().to_string_lossy().starts_with(".wsmp-"))
                        }));
                    }
                }
            }
        }
    }
    for from in ["tree", "alias"] {
        let fx = Fx::new();
        fx.put("tree/sub/child", SOURCE);
        fx.link("tree", "alias");
        let before = snapshot(&fx.root);
        let _scope = FaultScope::new(&[]);
        // A symlink leaf is moved as an object, while a symlink parent resolves
        // physically. Only the directory itself has the ancestry gate.
        let input = json!({"from":fx.p(if from=="alias" {"alias/sub"}else{"tree"}),
            "to":fx.p(if from=="alias" {"tree/sub/moved"}else{"alias/sub/moved"})});
        assert_eq!(
            fx.ops
                .execute("rename", input, &fx.cancel)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert_eq!(snapshot(&fx.root), before);
        assert_eq!(count(&FaultScope::calls(), Primitive::Mkdir), 0);
    }
}

#[test]
fn rename_shared_case_alias_origin_is_restored_as_gone() {
    use crate::services::file_ops::fs::policy::Access;
    use crate::services::file_ops::fs::resolve::{ResolveOpts, resolve};
    use crate::services::file_ops::journal::recovery::{Held, RecoveryDir};
    // Models a case-only noino alias at the transaction boundary: capturing S
    // vacates the same entry D resolves to. Admission's cross-name identity may
    // miss that alias on noino; the owner must return S to s, never delete it.
    for shape in [Shape::Nr, Shape::Link] {
        let fx = Fx::new();
        fx.put("src", SOURCE);
        let resolve_src = || {
            resolve(
                &fx.p("src"),
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
        let from = resolve_src();
        let to = resolve_src();
        let stat = from.lstat().unwrap().unwrap();
        let mut src = Held::open(&from.dir, &from.name, stat).unwrap();
        let mut dst = Held::open(&to.dir, &to.name, stat).unwrap();
        let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path).unwrap();
        let _scope = FaultScope::new(&shape.faults(true));
        let method = recovery
            .preflight_move(fx.ops.context(), &from, &to, &src, Some(&dst))
            .unwrap();
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
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(error.detail, Some(json!({"currentEtag":"gone"})));
        drop(src);
        drop(dst);
        assert!(recovery.finish().is_empty());
        assert_eq!(fx.get("src"), SOURCE);
        clean(&fx);
    }
}

#[test]
fn rename_rejected_destination_name_is_invalid_input_before_capture() {
    for overwrite in [false, true] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, overwrite);
        let before = snapshot(&fx.root);
        let mut faults = vec![(Primitive::Move, 1, Errno::EINVAL)];
        if overwrite {
            faults.push((Primitive::ProbeExchange, 1, Errno::EINVAL));
        }
        let _scope = FaultScope::new(&faults);
        let error = rename_run(&fx, overwrite, etag.as_deref()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{overwrite} {error:?}");
        assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
        assert_eq!(snapshot(&fx.root), before);
        clean(&fx);
    }
    let fx = Fx::new();
    fx.put("tree/sub/child", SOURCE);
    let before = snapshot(&fx.root);
    let _scope = FaultScope::new(&[(Primitive::Move, 1, Errno::EINVAL)]);
    let error = fx
        .ops
        .rename(
            &args(json!({"from":fx.p("tree"),"to":fx.p("elsewhere"),"overwrite":false})),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput, "{error:?}");
    assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
    assert_eq!(snapshot(&fx.root), before);
    clean(&fx);
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

/// Replace the first link probe with a different inode that still has two names,
/// so alias disposal can unlink it and the rename takes the noino order.
fn swap_probe_inode(root: &Path) {
    let probe = recovery_dirs(root)
        .into_iter()
        .next()
        .expect("recovery dir")
        .join("probe");
    std::fs::remove_file(&probe).unwrap();
    let decoy = root.join("probe-decoy");
    std::fs::write(&decoy, "different inode").unwrap();
    std::fs::hard_link(&decoy, &probe).unwrap();
}
