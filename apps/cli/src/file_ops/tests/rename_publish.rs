//! #172 rename transaction tables. All races are actual saves at deterministic
//! seams; Linux and macOS execute the same rows (FUSE evidence is Linux-only).
use super::*;
use crate::file_ops::mutate::RenameAtomicCapability;

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
                let stat = crate::file_ops::resolve::Stat::from_metadata(
                    &std::fs::metadata(fx.root.join(name)).unwrap(),
                );
                if stat.size > crate::file_ops::etag::STRONG_ETAG_MAX_BYTES {
                    fx.ops.key.weak_stat(&stat)
                } else {
                    fx.etag(name)
                }
            }
            Self::Symlink => fx
                .ops
                .key
                .weak_stat(&crate::file_ops::resolve::Stat::from_metadata(
                    &std::fs::symlink_metadata(fx.root.join(name)).unwrap(),
                )),
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
fn rename_run(fx: &Fx, overwrite: bool, etag: Option<&str>, supervised: bool) -> FileResult<Value> {
    let input =
        json!({"from":fx.p("src"), "to":fx.p("dst"), "overwrite":overwrite,"expectedEtag":etag});
    if supervised {
        let prepared = fx.ops.prepare_supervised(
            "rename",
            input,
            None,
            &crate::file_ops::EtagKey::from_bytes([19; 32]),
            &fx.cancel,
        )?;
        assert!(prepared.child_input().blocked.is_none());
        fx.ops.execute_supervised(prepared, &fx.cancel)
    } else {
        fx.ops.execute("rename", input, &fx.cancel)
    }
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
fn rename_clean_shapes_kinds_supervision_and_third_links() {
    for object in OBJECTS {
        for shape in [Shape::Exchange, Shape::Nr, Shape::Link, Shape::None] {
            for overwrite in [false, true] {
                for supervised in [false, true] {
                    let fx = Fx::new();
                    let etag = setup(&fx, object, overwrite);
                    let before = snapshot(&fx.root);
                    let _scope = FaultScope::new(&shape.faults(overwrite));
                    let result = rename_run(&fx, overwrite, etag.as_deref(), supervised);
                    if matches!(shape, Shape::None) {
                        assert_eq!(result.unwrap_err().code, ErrorCode::UnsafeFilesystem);
                        assert_eq!(snapshot(&fx.root), before);
                        assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
                    } else {
                        let value = result.unwrap_or_else(|e| {
                            panic!("{shape:?}/{object:?}/{overwrite}/{supervised}: {e:?}")
                        });
                        assert!(value.get("recovered").is_none(), "{value}");
                        assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
                        assert!(std::fs::symlink_metadata(fx.root.join("src")).is_err());
                        assert_eq!(value["etag"], object.tag(&fx, "dst"));
                    }
                    clean(&fx);
                }
            }
        }
    }
    for overwrite in [false, true] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, overwrite);
        std::fs::hard_link(fx.root.join("src"), fx.root.join("third")).unwrap();
        let _scope = FaultScope::new(&Shape::Link.faults(overwrite));
        assert!(
            rename_run(&fx, overwrite, etag.as_deref(), false)
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
                let error = rename_run(&fx, overwrite, etag.as_deref(), false).unwrap_err();
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
        rename_run(&fx, true, etag.as_deref(), false).unwrap();
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
            rename_run(&fx, true, etag.as_deref(), false)
                .unwrap_err()
                .code,
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
                let result = rename_run(&fx, true, etag.as_deref(), false);
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
            for (primitive, nth, errno, after) in [
                (Primitive::PublishPrepare, 1, Errno::EIO, false), // D1 site 1
                (Primitive::Capture, 2, Errno::ENOENT, false),     // D1 site 2
                (Primitive::Capture, 2, Errno::EIO, true),
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
                let error = rename_run(&fx, true, etag.as_deref(), false).unwrap_err();
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Race {
    SourceSave,
    SourceCreate,
    DestinationSave,
    DestinationGone,
    DestinationCreate,
    BothCreate,
    AfterSave,
    AfterRemove,
    PrivateSource,
    DestinationDirectory,
}
const RACES: [Race; 10] = [
    Race::SourceSave,
    Race::SourceCreate,
    Race::DestinationSave,
    Race::DestinationGone,
    Race::DestinationCreate,
    Race::BothCreate,
    Race::AfterSave,
    Race::AfterRemove,
    Race::PrivateSource,
    Race::DestinationDirectory,
];
fn race_hook(fx: Fx, object: Object, overwrite: bool, race: Race) -> Fx {
    let root = fx.root.clone();
    fx.with_hook(move |step| {
        let src = root.join("src");
        let dst = root.join("dst");
        match (step, race) {
            (Step::Vacating, Race::SourceSave) => object.save(&src, RACER),
            (Step::Vacated, Race::SourceCreate) => object.put_path(&src, RACER),
            (Step::DestinationVacating, Race::DestinationSave) if overwrite => {
                object.save(&dst, RACER)
            }
            (Step::DestinationVacating, Race::DestinationGone) if overwrite => {
                std::fs::remove_file(&dst).unwrap()
            }
            (Step::DestinationVacating, Race::DestinationDirectory) if overwrite => {
                std::fs::remove_file(&dst).unwrap();
                std::fs::create_dir(&dst).unwrap();
                std::fs::write(dst.join("child"), RACER).unwrap();
            }
            (Step::DestinationVacated, Race::DestinationCreate) => object.put_path(&dst, RACER),
            (Step::DestinationVacated, Race::BothCreate) => {
                object.put_path(&src, "source racer");
                object.put_path(&dst, RACER);
            }
            (Step::Renamed, Race::AfterSave) => object.save(&dst, RACER),
            (Step::Renamed, Race::AfterRemove) => std::fs::remove_file(&dst).unwrap(),
            (Step::Publishing, Race::PrivateSource) => {
                let private = recovery_dirs(&root)[0].join("slot-1");
                // Preserve the source elsewhere: same-UID private removal itself
                // is outside the boundary, but publishing the successor isn't.
                std::fs::rename(&private, root.join("source-rescued")).unwrap();
                object.put_path(&private, RACER);
            }
            _ => {}
        }
        Ok(())
    })
}
impl Object {
    fn put_path(self, path: &Path, text: &str) {
        match self {
            Self::File => std::fs::write(path, text).unwrap(),
            Self::Symlink => std::os::unix::fs::symlink(text, path).unwrap(),
        }
    }
}
fn assert_race(
    fx: &Fx,
    object: Object,
    overwrite: bool,
    race: Race,
    result: FileResult<Value>,
    link: bool,
) {
    let mut paths = match &result {
        Ok(value) => inventory(fx, value),
        Err(e) => error_inventory(fx, e),
    };
    paths.push(fx.root.join("source-rescued"));
    match race {
        Race::AfterSave | Race::AfterRemove => {
            let value = result.unwrap();
            assert!(value["etag"].is_null() || !link, "{value}");
            if race == Race::AfterSave {
                assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(RACER));
            }
            if link {
                assert!(object.kept(&paths, SOURCE), "D8 keeps last alias");
            } else {
                clean(fx);
            }
        }
        Race::SourceCreate => {
            result.unwrap();
            assert_eq!(object.bytes(&fx.root.join("src")).as_deref(), Some(RACER));
            assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
            clean(fx);
        }
        Race::SourceSave | Race::DestinationSave => {
            assert_eq!(result.unwrap_err().code, ErrorCode::Conflict);
            if race == Race::SourceSave {
                assert_eq!(
                    count(&FaultScope::calls(), Primitive::Capture),
                    1,
                    "source mismatch stops BEFORE destination capture"
                );
                assert!(
                    !fx.steps
                        .lock()
                        .unwrap()
                        .contains(&Step::DestinationVacating)
                );
            }
            assert_eq!(
                object
                    .bytes(&fx.root.join(if race == Race::SourceSave {
                        "src"
                    } else {
                        "dst"
                    }))
                    .as_deref(),
                Some(RACER)
            );
            if race == Race::DestinationSave {
                assert!(object.kept(&paths, SOURCE));
            }
            clean(fx);
        }
        Race::DestinationGone => {
            let e = result.unwrap_err();
            assert_eq!(e.code, ErrorCode::Conflict);
            assert_eq!(e.detail, Some(json!({"currentEtag":"gone"})));
            assert!(object.kept(&paths, SOURCE));
            clean(fx);
        }
        Race::DestinationCreate | Race::BothCreate => {
            let e = result.unwrap_err();
            assert_eq!(
                e.code,
                if overwrite || race == Race::BothCreate {
                    ErrorCode::UncertainOutcome
                } else {
                    ErrorCode::Exists
                }
            );
            assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(RACER));
            assert!(object.kept(&paths, SOURCE));
            if overwrite {
                assert!(object.kept(&paths, DESTINATION));
            }
            if race == Race::BothCreate {
                assert_eq!(
                    object.bytes(&fx.root.join("src")).as_deref(),
                    Some("source racer")
                );
            }
        }
        Race::PrivateSource => {
            assert_eq!(result.unwrap_err().code, ErrorCode::Conflict);
            assert_eq!(
                object.bytes(&fx.root.join("source-rescued")).as_deref(),
                Some(SOURCE)
            );
            assert_eq!(object.bytes(&fx.root.join("src")).as_deref(), Some(RACER));
            if overwrite {
                assert_eq!(
                    object.bytes(&fx.root.join("dst")).as_deref(),
                    Some(DESTINATION)
                );
            } else {
                assert!(std::fs::symlink_metadata(fx.root.join("dst")).is_err());
            }
        }
        Race::DestinationDirectory => {
            let e = result.unwrap_err();
            assert_eq!(
                e.code,
                if link {
                    ErrorCode::UncertainOutcome
                } else {
                    ErrorCode::Conflict
                }
            );
            assert!(object.kept(&paths, SOURCE));
            assert!(
                snapshot(&fx.root)
                    .values()
                    .any(|entry| matches!(entry,Entry::File(bytes,..) if bytes==RACER.as_bytes()))
            );
        }
    }
}
#[test]
fn rename_races_restore_origins_preserve_creates_and_do_not_chase_commits() {
    for object in OBJECTS {
        for shape in [Shape::Nr, Shape::Link] {
            for overwrite in [false, true] {
                for race in RACES {
                    if !overwrite
                        && matches!(
                            race,
                            Race::DestinationSave
                                | Race::DestinationGone
                                | Race::DestinationDirectory
                        )
                    {
                        continue;
                    }
                    let fx = Fx::new();
                    let etag = setup(&fx, object, overwrite);
                    // Force plain NR through the recovery publisher for race coverage;
                    // direct NR verification retains its existing tests.
                    let mut faults = shape.faults(overwrite);
                    if !overwrite && matches!(shape, Shape::Nr) {
                        faults.push((Primitive::Move, 1, Errno::EINVAL));
                    }
                    let fx = race_hook(fx, object, overwrite, race);
                    let _scope = FaultScope::new(&faults);
                    let result = rename_run(&fx, overwrite, etag.as_deref(), false);
                    assert_race(
                        &fx,
                        object,
                        overwrite,
                        race,
                        result,
                        matches!(shape, Shape::Link),
                    );
                }
            }
        }
    }
}

#[test]
fn rename_cancel_and_hook_errors_at_every_transaction_seam() {
    for shape in [Shape::Nr, Shape::Link] {
        for overwrite in [false, true] {
            for seam in [
                Step::LinkProbed,
                Step::Vacating,
                Step::Captured,
                Step::Vacated,
                Step::DestinationVacating,
                Step::DestinationVacated,
                Step::Publishing,
                Step::Renamed,
                Step::Disposing,
            ] {
                if (!overwrite && seam == Step::DestinationVacating)
                    || (seam == Step::LinkProbed && !matches!(shape, Shape::Link))
                {
                    continue;
                }
                for hook_error in [false, true] {
                    let fx = Fx::new();
                    let etag = setup(&fx, Object::File, overwrite);
                    let before = snapshot(&fx.root);
                    let cancel = fx.cancel.clone();
                    let root = fx.root.clone();
                    let fx = fx.with_hook(move |step| {
                        // Ignore preflight dummy/probe disposal for post-capture rows.
                        if step == seam && (seam != Step::Disposing || !root.join("src").exists()) {
                            if hook_error {
                                return Err(FileError::cancelled());
                            }
                            cancel.cancel();
                        }
                        Ok(())
                    });
                    let mut faults = shape.faults(overwrite);
                    if !overwrite && matches!(shape, Shape::Nr) {
                        faults.push((Primitive::Move, 1, Errno::EINVAL));
                    }
                    let _scope = FaultScope::new(&faults);
                    let result = rename_run(&fx, overwrite, etag.as_deref(), false);
                    if matches!(seam, Step::Vacating | Step::LinkProbed) {
                        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
                        assert_eq!(snapshot(&fx.root), before);
                    } else {
                        assert!(result.unwrap().get("recovered").is_none());
                        assert_eq!(fx.get("dst"), SOURCE);
                    }
                    clean(&fx);
                }
            }
        }
    }
}

#[test]
fn rename_reply_loss_nr_commits_link_keeps_and_restore_never_overwrites() {
    for shape in [Shape::Nr, Shape::Link] {
        for errno in [Errno::EIO, Errno::ENOENT, Errno::EEXIST, Errno::EINVAL] {
            let fx = Fx::new();
            let etag = setup(&fx, Object::File, true);
            let _scope =
                FaultScope::with_after_effects(&shape.faults(true), &[(shape.publish(), 1, errno)]);
            let result = rename_run(&fx, true, etag.as_deref(), false);
            if matches!(shape, Shape::Nr) {
                assert!(result.unwrap().get("recovered").is_none());
                clean(&fx);
            } else {
                let e = result.unwrap_err();
                let paths = error_inventory(&fx, &e);
                assert!(has_bytes(&paths, SOURCE));
                assert!(has_bytes(&paths, DESTINATION));
            }
            assert_eq!(fx.get("dst"), SOURCE);
        }
    }
    for primitive in [Primitive::Restore, Primitive::RestoreLink] {
        for after in [false, true] {
            let fx = Fx::new();
            let etag = setup(&fx, Object::File, true);
            let mut faults = Shape::Link.faults(true);
            faults.push((Primitive::PublishLink, 1, Errno::EIO));
            faults.retain(|(p, n, _)| !(*p == primitive && *n == 1));
            if primitive == Primitive::RestoreLink {
                faults.push((Primitive::Restore, 1, Errno::EINVAL));
            }
            let effects = if after {
                vec![(primitive, 1, Errno::EIO)]
            } else {
                faults.push((primitive, 1, Errno::EIO));
                vec![]
            };
            let _scope = FaultScope::with_after_effects(&faults, &effects);
            let e = rename_run(&fx, true, etag.as_deref(), false).unwrap_err();
            let paths = error_inventory(&fx, &e);
            assert!(has_bytes(&paths, SOURCE));
            assert!(has_bytes(&paths, DESTINATION));
        }
    }
}

#[test]
fn rename_cleanup_failures_report_alias_and_destination_after_known_commit() {
    for shape in [Shape::Nr, Shape::Link] {
        // Target only committed cleanup, not the preflight dummies/probes.
        for original in [false, true] {
            if matches!(shape, Shape::Nr) && !original {
                continue;
            }
            let fx = Fx::new();
            let etag = setup(&fx, Object::File, true);
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::Disposing
                    && std::fs::read_to_string(root.join("dst")).is_ok_and(|s| s == SOURCE)
                {
                    let slot =
                        recovery_dirs(&root)[0].join(if original { "slot-2" } else { "slot-1" });
                    if slot.exists() {
                        save(&slot, RACER);
                    }
                }
                Ok(())
            });
            let _scope = FaultScope::new(&shape.faults(true));
            let value = rename_run(&fx, true, etag.as_deref(), false).unwrap();
            assert!(has_bytes(&result_paths(&value), RACER));
            assert_eq!(fx.get("dst"), SOURCE);
        }
    }
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
        assert_eq!(count(&FaultScope::calls(), Primitive::Mkdir), 0);
        clean(&fx);
    }
    let fx = Fx::new();
    let etag = setup(&fx, Object::File, false);
    fx.ops
        .set_rename_atomic_capability(RenameAtomicCapability::LinksAndExchange);
    let _scope = FaultScope::new(&[]);
    assert!(
        rename_run(&fx, false, etag.as_deref(), true)
            .unwrap()
            .get("recovered")
            .is_none()
    );
    assert_eq!(count(&FaultScope::calls(), Primitive::Move), 1);
    assert_eq!(count(&FaultScope::calls(), Primitive::Mkdir), 0);
    clean(&fx);
}

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
            let value = rename_run(&fx, overwrite, etag.as_deref(), false).unwrap();
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

pub(super) fn real_rename_rows(directory: &Path, class: RealClass) {
    for object in OBJECTS {
        for overwrite in [false, true] {
            let fx = real_fixture(directory);
            let etag = setup(&fx, object, overwrite);
            let before = snapshot(&fx.root);
            let result = rename_run(&fx, overwrite, etag.as_deref(), false);
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
                let fx = race_hook(fx, object, overwrite, race);
                let faults = if !overwrite && class.nr {
                    vec![(Primitive::Move, 1, Errno::EINVAL)]
                } else {
                    vec![]
                };
                let _scope = FaultScope::new(&faults);
                let result = rename_run(&fx, overwrite, etag.as_deref(), false);
                assert_race(&fx, object, overwrite, race, result, !class.nr);
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
        let value = rename_run(&fx, true, Some(&tag), false).unwrap();
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
            let value = rename_run(&fx, overwrite, etag.as_deref(), false).unwrap();
            assert!(value["etag"].is_null());
            assert_eq!(fx.get("dst"), RACER);
            assert!(result_paths(&value).iter().any(|p| {
                std::fs::read_to_string(p).is_ok_and(|s| s.starts_with("fd-written-source"))
            }));
        }
    }
}

#[test]
fn rename_double_observation_and_unheld_failures_keep_data() {
    for overwrite in [false, true] {
        for object in OBJECTS {
            for nth in [1, 2] {
                let fx = Fx::new();
                let etag = setup(&fx, object, overwrite);
                let before = snapshot(&fx.root);
                let mut faults = Shape::Link.faults(overwrite);
                faults.push((Primitive::Hold, nth, Errno::EMFILE));
                if !overwrite && nth == 2 {
                    continue;
                } // D does not exist
                let _scope = FaultScope::new(&faults);
                let error = rename_run(&fx, overwrite, etag.as_deref(), false).unwrap_err();
                assert_eq!(error.code, ErrorCode::IoError);
                assert_eq!(error.message, "EMFILE");
                assert_eq!(snapshot(&fx.root), before);
                assert_eq!(count(&FaultScope::calls(), Primitive::Capture), 0);
                clean(&fx);
            }
        }
    }
    // Two failed live observations never license deletion. Drive them at each
    // postcapture seam, then inventory actual user bytes and reporting paths.
    for seam in [Step::Captured, Step::Publishing] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, true);
        let once = Arc::new(AtomicBool::new(false));
        let fired = Arc::clone(&once);
        let scope = Arc::new(Mutex::new(None));
        let store = Arc::clone(&scope);
        let fx = fx.with_hook(move |step| {
            if step == seam && !fired.swap(true, Ordering::SeqCst) {
                // Thread-local replacement resets counts at this precise seam.
                *store.lock().unwrap() = Some(FaultScope::new(&[
                    (Primitive::Identity, 1, Errno::EIO),
                    (Primitive::Identity, 2, Errno::ESTALE),
                    (Primitive::Restore, 1, Errno::EINVAL),
                    (Primitive::Restore, 2, Errno::EINVAL),
                ]));
            }
            Ok(())
        });
        let _outer = FaultScope::new(&Shape::Link.faults(true));
        let error = rename_run(&fx, true, etag.as_deref(), false).unwrap_err();
        assert!(once.load(Ordering::SeqCst));
        let paths = error_inventory(&fx, &error);
        assert!(has_bytes(&paths, SOURCE));
        assert!(has_bytes(&paths, DESTINATION));
        drop(scope.lock().unwrap().take());
    }
}

#[test]
fn rename_weak_and_symlink_etag_binding_inverse() {
    use crate::file_ops::mutate::{RenameArgs, RenameResult};
    for object in OBJECTS {
        for change in [false, true] {
            let fx = Fx::new();
            if matches!(object, Object::File) {
                let file = std::fs::File::create(fx.root.join("src")).unwrap();
                file.set_len(crate::file_ops::etag::STRONG_ETAG_MAX_BYTES + 1)
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
    use crate::file_ops::mutate::{RenameArgs, RenameResult};
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
                        faults.push((Primitive::Move, 1, Errno::EINVAL));
                    }
                    let _scope = FaultScope::new(&faults);
                    let result = fx.ops.execute("rename", json!({"from":fx.p("a/src"),"to":fx.p("b/dst"),"overwrite":overwrite,"expectedEtag":tag}), &fx.cancel);
                    if race {
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
fn rename_failed_destination_capture_releases_source_before_restore_alias_unlink() {
    for failure in [None, Some(Errno::EIO), Some(Errno::ESTALE)] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, true);
        #[cfg(target_os = "linux")]
        let root = fx.root.clone();
        let scope = Arc::new(Mutex::new(None));
        let injected = Arc::clone(&scope);
        let fx=fx.with_hook(move|step| {
            if step==Step::DestinationVacating {
                let mut rows=vec![(Primitive::Capture,1,Errno::ENOENT),(Primitive::Restore,1,Errno::EINVAL)];
                if let Some(errno)=failure {rows.push((Primitive::Identity,1,errno));}
                *injected.lock().unwrap()=Some(FaultScope::new(&rows));
                #[cfg(target_os="linux")]
                {
                    use crate::file_ops::exchange::UNLINK_PROBE;
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
        let error = rename_run(&fx, true, etag.as_deref(), false).unwrap_err();
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
        if step == Step::DestinationVacating {
            let private = recovery_dirs(&racer_root)[0].join("slot-1");
            let public = racer_root.join("dst");
            std::fs::remove_file(&public).unwrap();
            std::fs::hard_link(private, public).unwrap();
            #[cfg(target_os = "linux")]
            {
                use crate::file_ops::exchange::UNLINK_PROBE;
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
    let result = rename_run(&fx, true, etag.as_deref(), false);
    let error = result.unwrap_err();
    // Nothing is lost: the source bytes are back at their origin or reported.
    assert!(
        fx.root.join("src").exists() || has_bytes(&error_inventory(&fx, &error), SOURCE),
        "{error:?}"
    );
}

#[test]
fn rename_shared_case_alias_origin_is_restored_as_gone() {
    use crate::file_ops::policy::Access;
    use crate::file_ops::recovery::{Held, RecoveryDir};
    use crate::file_ops::resolve::{ResolveOpts, resolve};
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
                    policy: &fx.ops.policy,
                    access: Access::Remove,
                    preview_missing: false,
                    pin: None,
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
            .preflight_move(&fx.ops, &from, &to, &src, Some(&dst))
            .unwrap();
        let error = recovery
            .commit_move(
                &fx.ops,
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
fn real_gate_rejects_exchange_capable_mount_without_skip() {
    let fx = Fx::new();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_real_capabilities(
            &fx.root,
            RealClass {
                nr: true,
                link: true,
                noino: false
            }
        )))
        .is_err(),
        "a declared exchange-less mount with exchange must fail, never SKIP"
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
            let result = rename_run(&fx, true, etag.as_deref(), false);
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
    use crate::file_ops::policy::Access;
    use crate::file_ops::recovery::{Held, RecoveryDir};
    use crate::file_ops::resolve::{ResolveOpts, resolve};
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
                        policy: &fx.ops.policy,
                        access: Access::Remove,
                        preview_missing: false,
                        pin: None,
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
                .preflight_move(&fx.ops, &from, &to, &src, Some(&dst))
                .unwrap();
            recovery
                .commit_move(
                    &fx.ops,
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

#[test]
fn rename_true_alias_pair_closes_both_private_proofs_before_committed_unlinks() {
    use crate::file_ops::policy::Access;
    use crate::file_ops::recovery::{Held, RecoveryDir};
    use crate::file_ops::resolve::{ResolveOpts, resolve};
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
                        policy: &fx.ops.policy,
                        access: Access::Remove,
                        preview_missing: false,
                        pin: None,
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
                .preflight_move(&fx.ops, &from, &to, &src, Some(&dst))
                .unwrap();
            #[cfg(target_os = "linux")]
            let checks = if matches!(shape, Shape::Link) {
                Some(watch_private_unlinks(&fx, &["slot-2", "slot-1"]))
            } else {
                None
            };
            recovery
                .commit_move(
                    &fx.ops,
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
