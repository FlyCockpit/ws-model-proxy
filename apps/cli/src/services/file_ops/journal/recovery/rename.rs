//! The rename transaction: one call runs a rename (direct no-replace move,
//! the exchange-less fallback, or an overwrite) with its INTENT, compensation
//! and final cleanup, and returns the recovered paths and whether the
//! destination was published by a link. `mutate` checks the request, the
//! identities and etags and the same-object cases; nothing outside this
//! module steps a [`RecoveryDir`] for a rename.

use std::os::fd::AsFd;

use nix::errno::Errno;

use super::{Held, Origin, PublishMethod, RecoveryDir, refused_without_effect};
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::fs::exchange::{Primitive, is_unsupported, no_replace};
use crate::services::file_ops::fs::meta::Kind;
use crate::services::file_ops::fs::resolve::Resolved;
use crate::services::file_ops::journal::intent::{Intent, IntentOrder, IntentPhase};
use crate::services::file_ops::{Cancel, Step};

/// Move `src` (held at `from`) to `to`. `dst` is the held destination only for
/// an overwrite (a rename without overwrite never reaches here with one).
/// Plain rename uses recovery only for fallback or compensation; both paths
/// can return uncertain_outcome or recovered paths on success. Unsupported
/// directory moves and link-less no-replace operations refuse without a public
/// effect.
pub(in crate::services::file_ops) fn rename(
    ops: &OpContext,
    from: &Resolved,
    to: &Resolved,
    mut src: Held,
    mut dst: Option<Held>,
    cancel: &Cancel,
) -> FileResult<(Vec<String>, bool)> {
    // Direct NR uses a pre-effect journal too.
    // EINVAL is also how vfat/exFAT/SMB reject a destination name. When a later
    // private NR probe succeeds, that EINVAL is `invalid_input`, not a missing
    // rename flag — and nothing is captured.
    let mut candidate = None;
    let mut move_errno: Option<Errno> = None;
    if dst.is_none() {
        candidate = from
            .lstat()?
            .map(|stat| Held::open(&from.dir, &from.name, stat))
            .transpose()?;
        let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path)?;
        let intent = Intent::rename(
            IntentOrder::VacateFirst,
            &from.full_path(),
            &to.full_path(),
            false,
        )
        .publishing(&to.full_path(), &src.stat());
        recovery.prepare_intent(intent)?;
        recovery.set_intent_phase(IntentPhase::Publishing)?;
        let before = recovery.effect_checkpoint();
        recovery.begin_public_effect()?;
        let moved = no_replace(
            from.dir.as_fd(),
            &from.name,
            to.dir.as_fd(),
            &to.name,
            Primitive::Move,
        );
        if let Err(errno) = moved {
            recovery.effect_refused(before, errno);
        }
        match moved {
            Ok(()) => {
                let _ = ops.hook.step(Step::Moved);
                if matches!(to.lstat(), Ok(Some(now)) if src.matches_for_restore(&now)) {
                    let result = recovery
                        .sync_effect(&[&from.dir, &to.dir])
                        .and_then(|()| recovery.set_intent_phase(IntentPhase::Committed))
                        .map(|()| false);
                    return finish_move(&mut recovery, result);
                }
                let origin = Origin::new(&from.dir, &from.name, &from.full_path())
                    .map_err(FileError::errno)?;
                let result = match candidate.as_mut() {
                    Some(candidate) => {
                        verify_moved(ops, &mut recovery, to, &mut src, candidate, origin)
                    }
                    None => Err(recovery.uncertain()),
                };
                drop(src);
                drop(candidate);
                drop(dst);
                return finish_move(&mut recovery, result.map(|()| false));
            }
            Err(Errno::EEXIST) => return Err(exists_error()),
            Err(errno) if is_unsupported(errno) => {
                // Nothing moved. Release this R (pins, journal, registry)
                // before any fallback allocates its own.
                recovery.close_unused()?;
                move_errno = Some(errno);
            }
            Err(errno) if refused_without_effect(errno) => {
                return Err(FileError::errno(errno));
            }
            // Ambiguous reply (EIO, timeouts, ENOENT/ESTALE after an NFS
            // retransmit, EINTR): decide from the names, never the errno.
            Err(errno) if matches!(from.lstat(), Ok(Some(now)) if src.matches_for_restore(&now)) => {
                return Err(FileError::errno(errno));
            }
            Err(_) if matches!(to.lstat(), Ok(Some(now)) if src.matches_for_restore(&now)) => {
                let _ = ops.hook.step(Step::Moved);
                let result = recovery
                    .sync_effect(&[&from.dir, &to.dir])
                    .and_then(|()| recovery.set_intent_phase(IntentPhase::Committed))
                    .map(|()| false);
                return finish_move(&mut recovery, result);
            }
            Err(_) => return Err(recovery.uncertain()),
        }
        if src.stat().kind() == Kind::Dir {
            if move_errno == Some(Errno::EINVAL) {
                let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path)?;
                let result = match recovery.noreplace_works(ops, to) {
                    Ok(true) => Err(rejected_name()),
                    Ok(false) => Err(FileError::unsafe_filesystem()),
                    Err(error) => Err(error),
                };
                drop(src);
                drop(candidate);
                drop(dst);
                return finish_move(&mut recovery, result);
            }
            return Err(FileError::unsafe_filesystem());
        }
    }
    if !src.is_held() {
        return Err(unheld_error(&src));
    }
    if let Some(dst) = &dst
        && !dst.is_held()
    {
        return Err(unheld_error(dst));
    }
    drop(candidate); // fallback owns just S/D, never a duplicate candidate proof
    let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path)?;
    let result = recovery
        .preflight_move(ops, from, to, &src, dst.as_ref())
        .and_then(|method| {
            if move_errno == Some(Errno::EINVAL) && matches!(method, Some(PublishMethod::NoReplace))
            {
                return Err(rejected_name());
            }
            // Overwrite never tried Move. NR working in R does not prove the
            // public destination name is legal; EEXIST does, EINVAL does not.
            if dst.is_some() && matches!(method, Some(PublishMethod::NoReplace)) {
                let intent = Intent::rename(
                    IntentOrder::VacateFirst,
                    &from.full_path(),
                    &to.full_path(),
                    false,
                )
                .publishing(&to.full_path(), &src.stat());
                recovery.prepare_intent(intent)?;
                recovery.set_intent_phase(IntentPhase::Publishing)?;
                let before = recovery.effect_checkpoint();
                recovery.begin_public_effect()?;
                let moved = no_replace(
                    from.dir.as_fd(),
                    &from.name,
                    to.dir.as_fd(),
                    &to.name,
                    Primitive::Move,
                );
                if let Err(errno) = moved {
                    recovery.effect_refused(before, errno);
                }
                match moved {
                    Ok(()) => {
                        let _ = ops.hook.step(Step::Moved);
                        if matches!(to.lstat(), Ok(Some(now)) if src.matches_for_restore(&now)) {
                            recovery.sync_effect(&[&from.dir, &to.dir])?;
                            recovery.set_intent_phase(IntentPhase::Committed)?;
                            return Ok(false);
                        }
                        // Publication is unvalidated. Leave its fence and public
                        // names intact; do not manufacture a destination origin.
                        recovery.record_public(&to.dir, &to.name, &to.full_path());
                        return Err(recovery.uncertain());
                    }
                    Err(Errno::EEXIST) => {
                        recovery.set_intent_phase(IntentPhase::Prepared)?;
                    }
                    Err(Errno::EINVAL) => return Err(rejected_name()),
                    Err(errno) if refused_without_effect(errno) => {
                        return Err(FileError::errno(errno));
                    }
                    // Ambiguous reply: decide from the names, never the errno.
                    Err(errno) if matches!(from.lstat(), Ok(Some(now)) if src.matches_for_restore(&now)) => {
                        return Err(FileError::errno(errno));
                    }
                    Err(_) if matches!(to.lstat(), Ok(Some(now)) if src.matches_for_restore(&now)) => {
                        recovery.sync_effect(&[&from.dir, &to.dir])?;
                        recovery.set_intent_phase(IntentPhase::Committed)?;
                        return Ok(false);
                    }
                    Err(_) => return Err(recovery.uncertain()),
                }
            }
            recovery.commit_move(ops, from, to, &mut src, dst.as_mut(), method, cancel)
        });
    drop(src);
    drop(dst);
    finish_move(&mut recovery, result)
}

fn unheld_error(held: &Held) -> FileError {
    match held.open_error() {
        Some(Errno::ENOENT) => FileError::conflict("gone"),
        Some(errno) => FileError::errno(errno),
        None => FileError::errno(Errno::EACCES),
    }
}

fn finish_move(
    recovery: &mut RecoveryDir,
    result: FileResult<bool>,
) -> FileResult<(Vec<String>, bool)> {
    let recovered = recovery.finish();
    match result {
        Ok(_) if !recovery.acknowledges_success() => Err(recovery.uncertain()),
        Ok(linked) => Ok((recovered, linked)),
        // The durable `committed` record proves the rename took effect: a later
        // durability-barrier failure is reported residue, not an uncertain
        // outcome. The published etag is re-derived from the public name.
        Err(error) if recovery.committed_barrier_failed() => {
            tracing::warn!(error = %error.message, "rename committed; cleanup residue retained");
            Ok((recovered, true))
        }
        Err(error) if error.code == ErrorCode::UncertainOutcome || !recovery.settled() => {
            Err(recovery.uncertain())
        }
        Err(error) => Err(error),
    }
}

/// Capture a post-move mismatch. Restore only the candidate identity observed
/// before the move, using NOREPLACE; newer destination successors stay in recovery.
fn verify_moved(
    ops: &OpContext,
    recovery: &mut RecoveryDir,
    to: &Resolved,
    src: &mut Held,
    candidate: &mut Held,
    origin: Origin,
) -> FileResult<()> {
    match to.lstat() {
        Ok(Some(now)) if src.matches_for_restore(&now) => Ok(()),
        _ => {
            if let Some(slot) = recovery.capture_moved(to, candidate, origin) {
                let _ = ops.hook.step(Step::Captured);
                if recovery.matches_for_restore(&slot, candidate) {
                    // Nothing after this uses either proof, and restore may unlink
                    // a private alias of this inode: close both unconditionally
                    // (a failed observation must not leave one open).
                    candidate.release();
                    src.release();
                    if !recovery.restore(ops, &slot) {
                        return Err(recovery.uncertain());
                    }
                    let _ = ops.hook.step(Step::Restored);
                    if recovery.settled() {
                        return Err(FileError::conflict("replaced"));
                    }
                }
            }
            Err(recovery.uncertain())
        }
    }
}

fn exists_error() -> FileError {
    FileError::new(ErrorCode::Exists, "the destination already exists")
}

fn rejected_name() -> FileError {
    FileError::invalid("destination name is not valid on this filesystem")
}

#[cfg(all(test, target_os = "linux"))]
mod descriptor_tests {
    use super::*;
    use crate::services::file_ops::fs::exchange::{FaultScope, UNLINK_PROBE};
    use crate::services::file_ops::fs::policy::Access;
    use crate::services::file_ops::fs::resolve::{ResolveOpts, resolve};
    use crate::services::file_ops::tests::Fx;
    use std::os::unix::fs::MetadataExt;
    use std::sync::{Arc, Mutex};

    fn resolve_path(
        ops: &OpContext,
        path: &str,
        access: Access,
        follow_last: bool,
        cancel: Option<&Cancel>,
    ) -> FileResult<Resolved> {
        resolve(
            path,
            &ResolveOpts {
                follow_last,
                make_parents: None,
                policy: &ops.policy,
                access,
                cancel,
            },
        )
    }

    #[test]
    fn verify_moved_observation_failure_closes_both_proofs_before_restore_unlink() {
        let fx = Fx::new();
        let path = fx.put("source", "checked source");
        let from = resolve_path(
            fx.ops.context(),
            &fx.p("source"),
            Access::Remove,
            false,
            None,
        )
        .unwrap();
        let stat = from.lstat().unwrap().unwrap();
        let mut src = Held::open(&from.dir, &from.name, stat).unwrap();
        let mut candidate = Held::open(&from.dir, &from.name, stat).unwrap();
        let origin = Origin::new(&from.dir, &from.name, &path).unwrap();
        std::fs::rename(path, fx.root.join("destination")).unwrap();
        let to = resolve_path(
            fx.ops.context(),
            &fx.p("destination"),
            Access::Write,
            false,
            None,
        )
        .unwrap();
        let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path).unwrap();
        let _scope = FaultScope::new(&[
            (Primitive::Identity, 1, Errno::EIO),
            (Primitive::Restore, 1, Errno::EINVAL),
        ]);
        let checks = Arc::new(Mutex::new(0usize));
        let checked = Arc::clone(&checks);
        let inode = (stat.dev, stat.ino);
        UNLINK_PROBE.with(|probe| {
            *probe.borrow_mut() = Some(Box::new(move || {
                for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                    if let Ok(metadata) = std::fs::metadata(entry.unwrap().path()) {
                        assert_ne!(
                            (metadata.dev(), metadata.ino()),
                            inode,
                            "source/candidate proof pins the restore alias"
                        );
                    }
                }
                *checked.lock().unwrap() += 1;
            }));
        });
        let error = verify_moved(
            fx.ops.context(),
            &mut recovery,
            &to,
            &mut src,
            &mut candidate,
            origin,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(*checks.lock().unwrap(), 1);
        assert_eq!(fx.get("source"), "checked source");
        assert!(!fx.root.join("destination").exists());
        assert!(recovery.finish().is_empty());
    }

    #[test]
    fn verify_moved_second_observation_failure_never_unlinks_with_a_proof_open() {
        let fx = Fx::new();
        let path = fx.put("source", "checked source");
        let from = resolve_path(
            fx.ops.context(),
            &fx.p("source"),
            Access::Remove,
            false,
            None,
        )
        .unwrap();
        let stat = from.lstat().unwrap().unwrap();
        let mut src = Held::open(&from.dir, &from.name, stat).unwrap();
        let mut candidate = Held::open(&from.dir, &from.name, stat).unwrap();
        let origin = Origin::new(&from.dir, &from.name, &path).unwrap();
        std::fs::rename(path, fx.root.join("destination")).unwrap();
        let to = resolve_path(
            fx.ops.context(),
            &fx.p("destination"),
            Access::Write,
            false,
            None,
        )
        .unwrap();
        let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path).unwrap();
        let _scope = FaultScope::new(&[
            (Primitive::Identity, 1, Errno::EIO),
            // The third observation is the restore's own disposal proof: its
            // failure keeps the alias (uncertain). A release that depended on a
            // successful observation would unlink with src still open.
            (Primitive::Identity, 3, Errno::EIO),
            (Primitive::Restore, 1, Errno::EINVAL),
        ]);
        let checks = Arc::new(Mutex::new(0usize));
        let checked = Arc::clone(&checks);
        let inode = (stat.dev, stat.ino);
        UNLINK_PROBE.with(|probe| {
            *probe.borrow_mut() = Some(Box::new(move || {
                for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                    if let Ok(metadata) = std::fs::metadata(entry.unwrap().path()) {
                        assert_ne!(
                            (metadata.dev(), metadata.ino()),
                            inode,
                            "source/candidate proof pins the restore alias"
                        );
                    }
                }
                *checked.lock().unwrap() += 1;
            }));
        });
        let error = verify_moved(
            fx.ops.context(),
            &mut recovery,
            &to,
            &mut src,
            &mut candidate,
            origin,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::UncertainOutcome);
        assert_eq!(*checks.lock().unwrap(), 0, "no unlink may happen");
        assert!(!fx.root.join("destination").exists());
        assert!(!recovery.finish().is_empty(), "the object stays reported");
    }
}
