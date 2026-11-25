//! Rename under actual saves and faults at every transaction seam: racing
//! creates and saves, cancellation and hook errors, lost replies, and failed
//! cleanup and observations.

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Race {
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
pub(super) const RACES: [Race; 10] = [
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
pub(super) fn race_hook(
    fx: Fx,
    object: Object,
    overwrite: bool,
    race: Race,
    destabilize: bool,
) -> Fx {
    let root = fx.root.clone();
    fx.with_hook(move |step| {
        if destabilize && step == Step::LinkProbed && !root.join("probe-decoy").exists() {
            swap_probe_inode(&root);
        }
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
                if std::fs::symlink_metadata(&src).is_ok() {
                    // Link-first has not captured S. Replacing it must stop the link.
                    object.save(&src, RACER);
                } else {
                    let private = recovery_dirs(&root)[0].join("slot-1");
                    // Preserve the source elsewhere: same-UID private removal itself
                    // is outside the boundary, but publishing the successor isn't.
                    std::fs::rename(&private, root.join("source-rescued")).unwrap();
                    object.put_path(&private, RACER);
                }
            }
            _ => {}
        }
        Ok(())
    })
}
pub(super) struct RaceLink {
    pub(super) link: bool,
    pub(super) link_first: bool,
    pub(super) counts: bool,
}

pub(super) fn assert_race(
    fx: &Fx,
    object: Object,
    overwrite: bool,
    race: Race,
    result: FileResult<Value>,
    publication: RaceLink,
) {
    let RaceLink {
        link,
        link_first,
        counts,
    } = publication;
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
            if link && counts {
                assert!(object.kept(&paths, SOURCE), "D8 keeps last alias");
            } else {
                // No link publication, or a mount whose link counts mean nothing
                // (the guard is off there): residual (g), the alias is cleaned.
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
                    if link_first { 0 } else { 1 },
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
            // Link-first never vacates the source, so a create at src does not
            // land and a plain rename that finds the racer at dst is a clean EEXIST.
            let expect_uncertain = if link_first {
                overwrite
            } else {
                overwrite || race == Race::BothCreate
            };
            assert_eq!(
                e.code,
                if expect_uncertain {
                    ErrorCode::UncertainOutcome
                } else {
                    ErrorCode::Exists
                },
                "{race:?} link_first={link_first} {e:?}"
            );
            assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(RACER));
            assert!(object.kept(&paths, SOURCE));
            if overwrite {
                assert!(object.kept(&paths, DESTINATION));
            }
            if race == Race::BothCreate {
                assert_eq!(
                    object.bytes(&fx.root.join("src")).as_deref(),
                    Some(if link_first { SOURCE } else { "source racer" })
                );
            }
        }
        Race::PrivateSource => {
            assert_eq!(result.unwrap_err().code, ErrorCode::Conflict);
            assert_eq!(object.bytes(&fx.root.join("src")).as_deref(), Some(RACER));
            if link_first {
                assert!(std::fs::symlink_metadata(fx.root.join("source-rescued")).is_err());
            } else {
                assert_eq!(
                    object.bytes(&fx.root.join("source-rescued")).as_deref(),
                    Some(SOURCE)
                );
            }
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
                for destabilize in [false, true] {
                    if destabilize && !matches!(shape, Shape::Link) {
                        continue;
                    }
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
                            // ENOSYS still means "flags unavailable" when the private
                            // NR probe works. EINVAL in that case is a rejected name.
                            faults.push((Primitive::Move, 1, Errno::ENOSYS));
                        }
                        let fx = race_hook(fx, object, overwrite, race, destabilize);
                        let _scope = FaultScope::new(&faults);
                        let result = rename_run(&fx, overwrite, etag.as_deref());
                        assert_race(
                            &fx,
                            object,
                            overwrite,
                            race,
                            result,
                            RaceLink {
                                link: matches!(shape, Shape::Link),
                                link_first: matches!(shape, Shape::Link) && !destabilize,
                                counts: true,
                            },
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn rename_cancel_and_hook_errors_at_every_transaction_seam() {
    for shape in [Shape::Nr, Shape::Link] {
        for overwrite in [false, true] {
            for destabilize in [false, true] {
                if destabilize && !matches!(shape, Shape::Link) {
                    continue;
                }
                for seam in [
                    Step::LinkProbed,
                    Step::Vacating,
                    Step::Captured,
                    Step::Vacated,
                    Step::DestinationVacating,
                    Step::DestinationVacated,
                    Step::Publishing,
                    Step::Linked,
                    Step::Renamed,
                    Step::Disposing,
                ] {
                    if (!overwrite && seam == Step::DestinationVacating)
                        || (seam == Step::LinkProbed && !matches!(shape, Shape::Link))
                        || (seam == Step::Linked && !matches!(shape, Shape::Link))
                        || (destabilize && matches!(seam, Step::LinkProbed | Step::Vacating))
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
                            if destabilize
                                && step == Step::LinkProbed
                                && !root.join("probe-decoy").exists()
                            {
                                swap_probe_inode(&root);
                            }
                            // Ignore preflight dummy/probe disposal for post-capture rows.
                            if step == seam
                                && (seam != Step::Disposing || !root.join("src").exists())
                            {
                                if hook_error {
                                    return Err(FileError::cancelled());
                                }
                                cancel.cancel();
                            }
                            Ok(())
                        });
                        let mut faults = shape.faults(overwrite);
                        if !overwrite && matches!(shape, Shape::Nr) {
                            faults.push((Primitive::Move, 1, Errno::ENOSYS));
                        }
                        let _scope = FaultScope::new(&faults);
                        let result = rename_run(&fx, overwrite, etag.as_deref());
                        if matches!(seam, Step::Vacating | Step::LinkProbed) {
                            assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
                            assert_eq!(snapshot(&fx.root), before);
                        } else {
                            assert!(
                                result.unwrap().get("recovered").is_none(),
                                "{shape:?}/{overwrite}/{destabilize}/{seam:?}/{hook_error}"
                            );
                            assert_eq!(fx.get("dst"), SOURCE);
                        }
                        clean(&fx);
                    }
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
            let result = rename_run(&fx, true, etag.as_deref());
            // Lost publish reply: NR reconciles the transferred dentry, and a
            // stable-inode link commits when `to` presents the held source.
            let value = result.unwrap_or_else(|error| panic!("{shape:?} {errno:?}: {error:?}"));
            assert!(
                value.get("recovered").is_none(),
                "{shape:?} {errno:?} {value}"
            );
            assert!(std::fs::symlink_metadata(fx.root.join("src")).is_err());
            clean(&fx);
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
            let e = rename_run(&fx, true, etag.as_deref()).unwrap_err();
            let paths = error_inventory(&fx, &e);
            assert!(has_bytes(&paths, SOURCE));
            assert!(has_bytes(&paths, DESTINATION));
        }
    }
}

/// O5B-1: a lost plain-link reply. Stable inodes commit (the destination presents
/// the held source). A noino probe leaves the reply unreconcilable: both public
/// names hold the source and the destination stays in the recovery report.
#[test]
fn rename_plain_link_reply_loss_reports_the_published_name() {
    for object in OBJECTS {
        for errno in [Errno::EIO, Errno::ENOENT, Errno::EINVAL] {
            for destabilize in [false, true] {
                let fx = Fx::new();
                let etag = setup(&fx, object, false);
                let root = fx.root.clone();
                let fx = fx.with_hook(move |step| {
                    if destabilize && step == Step::LinkProbed && !root.join("probe-decoy").exists()
                    {
                        swap_probe_inode(&root);
                    }
                    Ok(())
                });
                let _scope = FaultScope::with_after_effects(
                    &Shape::Link.faults(false),
                    &[(Shape::Link.publish(), 1, errno)],
                );
                let result = rename_run(&fx, false, etag.as_deref());
                if destabilize {
                    let error = result.unwrap_err();
                    let paths = kept(&error);
                    assert!(
                        paths.iter().any(|path| path == &fx.root.join("dst")),
                        "{errno:?} {object:?} kept {paths:?}"
                    );
                    assert_eq!(object.bytes(&fx.root.join("src")).as_deref(), Some(SOURCE));
                    assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
                    assert!(object.kept(&paths, SOURCE), "{errno:?} {object:?}");
                } else {
                    let value = result.unwrap();
                    assert!(value.get("recovered").is_none(), "{errno:?} {value}");
                    assert!(std::fs::symlink_metadata(fx.root.join("src")).is_err());
                    assert_eq!(object.bytes(&fx.root.join("dst")).as_deref(), Some(SOURCE));
                    clean(&fx);
                }
            }
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
            let value = rename_run(&fx, true, etag.as_deref()).unwrap();
            assert!(has_bytes(&result_paths(&value), RACER));
            assert_eq!(fx.get("dst"), SOURCE);
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
                let error = rename_run(&fx, overwrite, etag.as_deref()).unwrap_err();
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
                    (Primitive::Identity, 3, Errno::EIO),
                    (Primitive::Identity, 4, Errno::ESTALE),
                    (Primitive::Restore, 1, Errno::EINVAL),
                    (Primitive::Restore, 2, Errno::EINVAL),
                ]));
            }
            Ok(())
        });
        let _outer = FaultScope::new(&Shape::Link.faults(true));
        let error = rename_run(&fx, true, etag.as_deref()).unwrap_err();
        assert!(once.load(Ordering::SeqCst));
        let paths = error_inventory(&fx, &error);
        assert!(has_bytes(&paths, SOURCE));
        assert!(has_bytes(&paths, DESTINATION));
        drop(scope.lock().unwrap().take());
    }
}
