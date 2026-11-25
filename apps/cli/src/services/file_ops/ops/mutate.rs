//! `forwarder_cli_file_rename`, `forwarder_cli_dir_create`,
//! `forwarder_cli_file_delete`: the small mutating tools.
//!
//! Recovery owns every rename and file/symlink delete as one transaction
//! (`recovery::rename`, `recovery::delete`); this module checks the request.
//! Overwrite preflights before any public capture: exchange/NR private dummies,
//! then link probes on the actual source and destination. Exchange-less NR
//! overwrite vacates both into R, proves held identity, and publishes source
//! fail-if-exists. Link publication is link-first when the probe alias and the
//! held source are one object (link S onto `to`, then capture S); noino keeps
//! vacate-first. Direct NR prepares R before moving public names. Returned etags bind the published
//! bytes/mtime to the admitted source. Unpublished user sources are restored
//! only to source or kept, never disposed as generated temps. Directories never
//! overwrite, use NR only, and own-subtree moves are invalid_input. Move EINVAL
//! while NR works in R is invalid_input before capture.
//! File/symlink delete captures/proves before disposal; directory delete uses the
//! kernel's empty-only rmdir rule. Cancellation ends before first capture.
//!
//! Recovery residuals: (a) same-user private-slot replacement between held proof,
//! close and unlink; (a2) absent-private-slot plain capture permits a squatter race;
//! (b) vacant public names during undo; (b2) vacate-first recovery rename's source
//! vacant from capture to operation end; link-first leaves it until `to` holds
//! the object. NR overwrite also vacates the destination.
//! Concurrent creates survive, and blocked restoration reports uncertain_outcome.
//! (d) crashes leave S/D, partial temp/probes or preflight dummies in R, possibly
//! with vacant names or two published/private links. Every R-using op writes a
//! versioned INTENT (phase, per-slot identity, pid/host) before the first capture,
//! including exchange-first overwrite (swap `from <-> to`, then capture D from
//! `from`). Live R dirs are indexed in the CLI state directory; `wsmp recover`
//! rolls forward or back from phase. Success deletes INTENT with an empty R.
//! There is no automatic replay; (e) unheld objects never authorize deletion;
//! (f) another process's NFS fd can leave .nfs residue (own fds close before unlink,
//! except pinned source proof through probe-alias unlink on per-vnode clients);
//! (g) replace/rename expose a link before alias cleanup: on a mount with believable
//! link counts (probed per operation) a count < 2 keeps the last alias, but a writer and
//! third save after that check, or on a mount whose counts mean nothing, can orphan it.
//! Retained aliases can cause nlink 2/hard_linked until manual cleanup.
//! Vacancies are bounded by syscalls, not time; filesystem atomicity is trusted.
//! Recovery mkdir errors fail closed; unreadable macOS/other-Unix files refuse
//! before capture with their actual open errno. Separate residuals: case-only
//! rename, public exclusive-create, rollback_created, R privacy/report bounds,
//! and in-place writes after etag reads. See `recovery` for manual recovery.

use std::ffi::OsStr;
use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::fcntl::{OFlag, openat, readlinkat, renameat};
use nix::sys::stat::{Mode, fstat, mkdirat};
use nix::unistd::{UnlinkatFlags, unlinkat};

use super::write::{DEFAULT_PARENT_MODE, parse_mode};
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::fs::meta::{Kind, Stat, kind_name, perm_mode};
use crate::services::file_ops::fs::policy::Access;
use crate::services::file_ops::fs::resolve::{ResolveOpts, Resolved, resolve};
use crate::services::file_ops::journal::recovery::{self, Held};
use crate::services::file_ops::{Cancel, Step, check_reason};

pub use super::mutate_args::{
    DeleteArgs, DeleteResult, MkdirArgs, MkdirResult, RenameArgs, RenameResult,
};

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

/// The etag a caller would have seen for the object `stat` describes.
fn object_etag(
    ops: &OpContext,
    resolved: &Resolved,
    stat: &Stat,
    cancel: &Cancel,
) -> FileResult<Option<String>> {
    Ok(match stat.kind() {
        Kind::File => {
            let (mut file, opened) = resolved.open_regular(&ops.policy, Access::Remove)?;
            if !opened.same_object(stat) {
                return Err(FileError::conflict("replaced"));
            }
            Some(ops.key.current(&mut file, &opened, cancel)?)
        }
        Kind::Symlink => Some(ops.key.weak_stat(stat)),
        Kind::Dir | Kind::Other => None,
    })
}

pub(crate) fn rename(
    ops: &OpContext,
    args: &RenameArgs,
    cancel: &Cancel,
) -> FileResult<RenameResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.locks.namespace_exclusive(cancel)?;
    let overwrite = args.overwrite.unwrap_or(false);
    if overwrite && args.expected_etag.is_none() {
        return Err(FileError::invalid(
            "expectedEtag (of the destination) is required for overwrite",
        ));
    }
    let from = resolve_path(ops, &args.from, Access::Remove, false, Some(cancel))?;
    let to = resolve_path(ops, &args.to, Access::Write, false, Some(cancel))?;
    if from.is_self() || to.is_self() {
        return Err(FileError::invalid(
            "cannot rename a directory reference such as `/` or `..`",
        ));
    }
    let (from_path, to_path) = (from.full_path(), to.full_path());
    if from_path == to_path {
        return Err(FileError::invalid(
            "source and destination are the same path",
        ));
    }
    let _locks = ops
        .locks
        .lock_pair(from_path.clone(), to_path.clone(), cancel)?;

    let src = from
        .lstat()?
        .ok_or_else(|| FileError::new(ErrorCode::NotFound, "the source does not exist"))?;
    if src.kind() == Kind::Other {
        return Err(FileError::new(
            ErrorCode::SpecialFile,
            "special files are not moved",
        ));
    }
    if src.kind() == Kind::Dir
        && (to.dir_path.starts_with(from.full_path()) || destination_inside_source(&src, &to.dir))
    {
        return Err(FileError::invalid(
            "cannot move a directory into its own subtree",
        ));
    }
    let src = Held::open(&from.dir, &from.name, src)?;
    ops.hook.step(Step::BeforeIdentity)?;
    ops.policy.check_identity(Access::Remove, &src.stat())?;
    ops.hook.step(Step::IdentityChecked)?;
    let src_etag = object_etag(ops, &from, &src.stat(), cancel)?;
    if !overwrite && let Some(expected) = &args.expected_etag {
        match &src_etag {
            Some(current) if current == expected => {}
            Some(current) => return Err(FileError::conflict(current)),
            None => return Err(FileError::invalid("directories have no etag")),
        }
    }

    let dst = to
        .lstat()?
        .map(|stat| Held::open(&to.dir, &to.name, stat))
        .transpose()?;
    // On a volume where names are not case-sensitive (macOS by default) the
    // destination of `notes.txt` -> `Notes.txt` is the source itself: one entry,
    // renamed in place, as on Windows. Its identity and etag were checked as the
    // source; `overwrite` is not needed for it.
    if !overwrite
        && let Some(dst) = &dst
        && case_only_alias(&from, &to, &src.stat(), &dst.stat())?
    {
        ops.hook.step(Step::EtagRechecked)?;
        cancel.check()?;
        case_only_rename(&from, &to)?;
        return Ok(RenameResult {
            etag: src_etag,
            recovered: Vec::new(),
        });
    }
    if let Some(dst) = &dst {
        if !overwrite {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination already exists",
            ));
        }
        if dst.stat().kind() != src.stat().kind() {
            return Err(FileError::new(
                ErrorCode::Exists,
                "overwrite replaces a file with a file (or a symlink with a symlink), not across kinds",
            ));
        }
        if dst.stat().kind() == Kind::Dir || dst.stat().kind() == Kind::Other {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination is a directory or special file and is not overwritten",
            ));
        }
        ops.hook.step(Step::BeforeIdentity)?;
        ops.policy.check_identity(Access::Write, &dst.stat())?;
        ops.hook.step(Step::IdentityChecked)?;
        let current = object_etag(ops, &to, &dst.stat(), cancel)?.unwrap_or_default();
        if args.expected_etag.as_deref() != Some(current.as_str()) {
            return Err(FileError::conflict(&current));
        }
    }

    // Test seam: the last point at which the world can change before the commit.
    ops.hook.step(Step::EtagRechecked)?;
    cancel.check()?;
    let source_stat = src.stat();
    let source_target = if source_stat.kind() == Kind::Symlink {
        Some(readlinkat(from.dir.as_fd(), from.name.as_os_str()).map_err(FileError::errno)?)
    } else {
        None
    };
    let (recovered, linked) = commit_rename(ops, &from, &to, overwrite, src, dst, cancel)?;
    let etag = if linked {
        published_etag(
            ops,
            &to,
            &source_stat,
            src_etag.as_deref(),
            source_target.as_deref(),
        )
        .ok()
        .flatten()
    } else {
        src_etag
    };
    Ok(RenameResult { etag, recovered })
}

/// True when `dest_parent` is the source directory or a descendant of it.
/// Uses inode identity so a case-insensitive volume still refuses, even when
/// the UTF-8 prefix check does not match.
fn destination_inside_source(source: &Stat, dest_parent: impl AsFd) -> bool {
    let Ok(mut fd) = dest_parent.as_fd().try_clone_to_owned() else {
        return false;
    };
    for _ in 0..256 {
        let Ok(raw) = fstat(fd.as_fd()) else {
            return false;
        };
        let current = Stat::from_raw(&raw);
        if current.same_object(source) {
            return true;
        }
        let Ok(parent) = openat(
            fd.as_fd(),
            "..",
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) else {
            return false;
        };
        let Ok(parent_raw) = fstat(parent.as_fd()) else {
            return false;
        };
        if Stat::from_raw(&parent_raw).same_object(&current) {
            return false;
        }
        fd = parent;
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::services::file_ops) enum SameObjectRename {
    Refuse,
    CaseOnlyRename,
    NotSameObject,
}

/// Classify an overwrite after destination policy and ETag checks. Directory
/// identities come from fstat of the held parent fds, not folded path strings.
/// A regular file with one link, differing folded-equivalent names and one
/// parent object is a single entry viewed under two spellings. Plain renameat
/// changes its spelling atomically; exchange/compensation would act on itself.
/// Every other same-object pair is refused, including true hard-link aliases.
///
/// Use the repo's path-classification fold (`redact::fold`): Unicode lower case
/// plus expansions (e.g. Straße == STRASSE), also trimming trailing dots/spaces.
/// Thus those normalization aliases qualify only with the same single-entry
/// identity checks. Non-UTF-8 names fail closed rather than using a lossy fold.
///
/// Exact residual: plain rename replaces whatever occupies the destination name.
/// A racing external writer can turn the alias into a distinct entry after this
/// check and before rename, and that entry can be lost. This needs a volume where
/// the alias is one entry plus a same-user racer creating a second entry under
/// the other spelling inside the microsecond check-to-rename window. The checks
/// are snapshots, not POSIX exclusion against external processes.
pub(in crate::services::file_ops) fn same_object_rename(
    src: &Stat,
    dst: &Stat,
    from_dir: &Stat,
    from_name: &OsStr,
    to_dir: &Stat,
    to_name: &OsStr,
) -> SameObjectRename {
    if !dst.same_object(src) {
        return SameObjectRename::NotSameObject;
    }
    if src.kind() == Kind::File
        && dst.kind() == Kind::File
        && src.nlink == 1
        && dst.nlink == 1
        && from_dir.same_object(to_dir)
        && from_name != to_name
        && matches!((from_name.to_str(), to_name.to_str()), (Some(from), Some(to))
            if crate::services::file_ops::redact::fold(from) == crate::services::file_ops::redact::fold(to))
    {
        SameObjectRename::CaseOnlyRename
    } else {
        SameObjectRename::Refuse
    }
}

/// Whether `to` names the same single entry as `from` under another spelling.
fn case_only_alias(from: &Resolved, to: &Resolved, src: &Stat, dst: &Stat) -> FileResult<bool> {
    let from_dir = Stat::from_raw(&fstat(from.dir.as_fd()).map_err(FileError::errno)?);
    let to_dir = Stat::from_raw(&fstat(to.dir.as_fd()).map_err(FileError::errno)?);
    Ok(
        same_object_rename(src, dst, &from_dir, &from.name, &to_dir, &to.name)
            == SameObjectRename::CaseOnlyRename,
    )
}

/// Change one entry's spelling with a plain `renameat` (see `same_object_rename`
/// for when that is the case and its residual), then sync both directories.
fn case_only_rename(from: &Resolved, to: &Resolved) -> FileResult<()> {
    crate::services::file_ops::fs::exchange::probe_dir_barrier(&from.dir)?;
    crate::services::file_ops::fs::exchange::probe_dir_barrier(&to.dir)?;
    renameat(
        from.dir.as_fd(),
        from.name.as_os_str(),
        to.dir.as_fd(),
        to.name.as_os_str(),
    )
    .map_err(FileError::errno)?;
    nix::unistd::fsync(from.dir.as_fd()).map_err(|_| FileError::mutation_uncertain())?;
    nix::unistd::fsync(to.dir.as_fd()).map_err(|_| FileError::mutation_uncertain())?;
    Ok(())
}

/// Sole overwrite gate for rename: classify same-object pairs before allocating
/// recovery. Case-only aliases use plain renameat with no recovery directory;
/// other overwrites allocate one private recovery directory before mutation. Public
/// names are never unlinked or blindly swapped during compensation.
///
/// Plain rename uses recovery only for fallback or compensation. Both paths can
/// return uncertain_outcome or recovered on success. The module docs and `recovery` describe the held-fd
/// proof, fallback behavior and exact residual windows. Unsupported directory
/// moves and link-less no-replace operations refuse without a public effect.
/// Case-only rename has the separate check-to-rename residual in
/// `same_object_rename`; it neither replaces a checked object nor compensates.
#[allow(clippy::too_many_arguments)]
fn commit_rename(
    ops: &OpContext,
    from: &Resolved,
    to: &Resolved,
    overwrite: bool,
    src: Held,
    dst: Option<Held>,
    cancel: &Cancel,
) -> FileResult<(Vec<String>, bool)> {
    if overwrite && let Some(dst) = &dst {
        let from_dir = Stat::from_raw(&fstat(from.dir.as_fd()).map_err(FileError::errno)?);
        let to_dir = Stat::from_raw(&fstat(to.dir.as_fd()).map_err(FileError::errno)?);
        match same_object_rename(
            &src.stat(),
            &dst.stat(),
            &from_dir,
            &from.name,
            &to_dir,
            &to.name,
        ) {
            SameObjectRename::Refuse => {
                return Err(FileError::invalid(
                    "source and destination are the same file",
                ));
            }
            SameObjectRename::CaseOnlyRename => {
                case_only_rename(from, to)?;
                return Ok((Vec::new(), false));
            }
            SameObjectRename::NotSameObject => {}
        }
    }
    recovery::rename(ops, from, to, src, dst, cancel)
}

/// A link gives d its own presented inode. Bind its bytes/mtime to the admitted
/// source etag before returning d's etag; a later save cannot grant edit authority.
fn published_etag(
    ops: &OpContext,
    to: &Resolved,
    src: &Stat,
    admitted: Option<&str>,
    target: Option<&OsStr>,
) -> FileResult<Option<String>> {
    let Some(now) = to.lstat()? else {
        return Ok(None);
    };
    if now.kind() != src.kind() {
        return Ok(None);
    }
    let same_snapshot = |stat: &Stat| {
        stat.size == src.size
            && stat.mtime_secs == src.mtime_secs
            && stat.mtime_nanos == src.mtime_nanos
    };
    match now.kind() {
        Kind::File => {
            let (mut file, opened) = to.open_regular(&ops.policy, Access::Read)?;
            if !opened.same_object(&now) {
                return Ok(None);
            }
            let mut binding = opened;
            binding.dev = src.dev;
            binding.ino = src.ino;
            let fresh = Cancel::new(); // committed result reads ignore late cancellation
            let (bound, etag) = if admitted.is_some_and(|etag| etag.starts_with("h:")) {
                let bytes = crate::services::file_ops::fs::etag::load_all(
                    &mut file,
                    &opened,
                    crate::services::file_ops::fs::etag::STRONG_ETAG_MAX_BYTES,
                    &fresh,
                )?;
                (
                    ops.key.strong(&binding, &bytes),
                    ops.key.strong(&opened, &bytes),
                )
            } else {
                if !same_snapshot(&opened) {
                    return Ok(None);
                }
                (ops.key.weak_stat(&binding), ops.key.weak_stat(&opened))
            };
            if admitted != Some(bound.as_str()) {
                return Ok(None);
            }
            Ok(Some(etag))
        }
        Kind::Symlink => {
            if !same_snapshot(&now)
                || target
                    != Some(
                        readlinkat(to.dir.as_fd(), to.name.as_os_str())
                            .map_err(FileError::errno)?
                            .as_os_str(),
                    )
            {
                return Ok(None);
            }
            Ok(Some(ops.key.weak_stat(&now)))
        }
        _ => Ok(None),
    }
}

pub(crate) fn mkdir(ops: &OpContext, args: &MkdirArgs, cancel: &Cancel) -> FileResult<MkdirResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.locks.namespace_shared(cancel)?;
    let mode = args
        .mode
        .as_deref()
        .map(parse_mode)
        .transpose()?
        .unwrap_or(DEFAULT_PARENT_MODE);
    let mut resolved = resolve(
        &args.path,
        &ResolveOpts {
            follow_last: true,
            make_parents: args.parents.unwrap_or(true).then_some(mode),
            policy: &ops.policy,
            access: Access::Write,
            cancel: Some(cancel),
        },
    )?;
    let outcome = mkdir_resolved(ops, &mut resolved, mode, cancel);
    if outcome.is_err() {
        resolved.rollback_created();
    }
    outcome
}

fn mkdir_resolved(
    ops: &OpContext,
    resolved: &mut Resolved,
    mode: u32,
    cancel: &Cancel,
) -> FileResult<MkdirResult> {
    if resolved.is_self() {
        return Ok(MkdirResult {
            created: !resolved.created.is_empty(),
        });
    }
    let _lock = ops.locks.lock_path(resolved.full_path(), cancel)?;
    match resolved.lstat()? {
        Some(st) if st.kind() == Kind::Dir => {
            return Ok(MkdirResult { created: false });
        }
        Some(_) => {
            return Err(FileError::new(
                ErrorCode::Exists,
                "a file already exists at this path",
            ));
        }
        None => {}
    }
    ops.hook.step(Step::EtagRechecked)?;
    cancel.check()?;
    crate::services::file_ops::fs::exchange::probe_dir_barrier(&resolved.dir)?;
    match mkdirat(
        resolved.dir.as_fd(),
        resolved.name.as_os_str(),
        perm_mode(mode),
    ) {
        Ok(()) => {
            resolved.created.clear();
            let directory = openat(
                resolved.dir.as_fd(),
                resolved.name.as_os_str(),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| FileError::mutation_uncertain())?;
            nix::unistd::fsync(directory.as_fd()).map_err(|_| FileError::mutation_uncertain())?;
            nix::unistd::fsync(resolved.dir.as_fd())
                .map_err(|_| FileError::mutation_uncertain())?;
            Ok(MkdirResult { created: true })
        }
        Err(Errno::EEXIST) => match resolved.lstat()? {
            Some(st) if st.kind() == Kind::Dir => Ok(MkdirResult { created: false }),
            _ => Err(FileError::new(
                ErrorCode::Exists,
                "a file already exists at this path",
            )),
        },
        Err(errno) => Err(FileError::errno(errno)),
    }
}

pub(crate) fn delete(
    ops: &OpContext,
    args: &DeleteArgs,
    cancel: &Cancel,
) -> FileResult<DeleteResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.locks.namespace_exclusive(cancel)?;
    let resolved = resolve_path(ops, &args.path, Access::Remove, false, Some(cancel))?;
    if resolved.is_self() {
        return Err(FileError::invalid(
            "cannot delete a directory reference such as `/` or `..`",
        ));
    }
    let _lock = ops.locks.lock_path(resolved.full_path(), cancel)?;
    let st = resolved
        .lstat()?
        .ok_or_else(|| FileError::new(ErrorCode::NotFound, "no such file or directory"))?;
    ops.policy.check_identity(Access::Remove, &st)?;
    match st.kind() {
        Kind::Dir | Kind::File | Kind::Symlink => {}
        Kind::Other => {
            return Err(FileError::new(
                ErrorCode::SpecialFile,
                "special files are not deleted",
            ));
        }
    }
    // Pin the inspected object BEFORE reading its etag. Unheld files/symlinks
    // must fail before any public move (notably unreadable mode-000 on macOS).
    let held = Held::open(&resolved.dir, &resolved.name, st)?;
    if st.kind() != Kind::Dir && !held.is_held() {
        // Nothing moved. Report the real open failure; a name that vanished
        // since the lstat is a conflict, and a kind that is never opened (a
        // symlink on Unix other than Linux/macOS) keeps EACCES.
        return Err(match held.open_error() {
            Some(Errno::ENOENT) => FileError::conflict("gone"),
            Some(errno) => FileError::errno(errno),
            None => FileError::errno(Errno::EACCES),
        });
    }
    if let Some(expected) = &args.expected_etag {
        match object_etag(ops, &resolved, &st, cancel)? {
            Some(current) if current == *expected => {}
            Some(current) => return Err(FileError::conflict(&current)),
            None => return Err(FileError::invalid("directories have no etag")),
        }
    }
    // Observable seam for the pre-unlink re-check (race tests swap the name here).
    ops.hook.step(Step::EtagRechecked)?;
    cancel.check()?;
    // The name must still be the object we inspected.
    match resolved.lstat()? {
        Some(now) if held.matches_for_restore(&now) => {}
        _ => return Err(FileError::conflict("replaced")),
    }
    if st.kind() == Kind::Dir {
        // Never capture directories: link-only filesystems cannot restore them.
        // Kernel rmdir removes only an empty directory, preserving saved data.
        crate::services::file_ops::fs::exchange::probe_dir_barrier(&resolved.dir)?;
        unlinkat(
            resolved.dir.as_fd(),
            resolved.name.as_os_str(),
            UnlinkatFlags::RemoveDir,
        )
        .map_err(FileError::errno)?;
        nix::unistd::fsync(resolved.dir.as_fd()).map_err(|_| FileError::mutation_uncertain())?;
        return Ok(DeleteResult {
            deleted: true,
            kind: "dir",
            recovered: Vec::new(),
        });
    }
    let recovered = recovery::delete(ops, &resolved, held, cancel)?;
    Ok(DeleteResult {
        deleted: true,
        kind: kind_name(st.kind()),
        recovered,
    })
}

#[cfg(all(test, target_os = "linux"))]
mod descriptor_tests {
    use super::*;
    use crate::services::file_ops::fs::exchange::{FaultScope, Primitive};
    use crate::services::file_ops::tests::{Fx, args};
    use serde_json::json;

    #[test]
    fn directory_delete_failed_held_observation_refuses_before_rmdir() {
        let fx = Fx::new();
        std::fs::create_dir(fx.root.join("directory")).unwrap();
        let _scope = FaultScope::new(&[(Primitive::Identity, 1, Errno::EIO)]);
        let error = delete(
            fx.ops.context(),
            &args(json!({"path":fx.p("directory")})),
            &fx.cancel,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert!(fx.root.join("directory").is_dir());
        assert_eq!(std::fs::read_dir(&fx.root).unwrap().count(), 1);
        assert!(!FaultScope::calls().contains(&Primitive::Capture));
    }
}

#[cfg(test)]
mod same_object_rename_tests {
    use super::*;

    #[test]
    fn same_object_rename_decision_table() {
        let src = Stat {
            // Stat uses portable u32 mode bits; nix's mode_t is u16 on macOS.
            mode: 0o100_600,
            uid: 1000,
            gid: 1000,
            nlink: 1,
            size: 4,
            dev: 1,
            ino: 10,
            mtime_secs: 0,
            mtime_nanos: 0,
        };
        let dir = Stat {
            mode: 0o040_700,
            ino: 20,
            ..src
        };
        #[derive(Clone, Copy)]
        struct Case {
            label: &'static str,
            src: Stat,
            dst: Stat,
            from_dir: Stat,
            to_dir: Stat,
            from: &'static str,
            to: &'static str,
            expected: SameObjectRename,
        }
        let base = Case {
            label: "one entry, two case spellings",
            src,
            dst: src,
            from_dir: dir,
            to_dir: dir,
            from: "Foo.txt",
            to: "foo.txt",
            expected: SameObjectRename::CaseOnlyRename,
        };
        for case in [
            base,
            Case {
                label: "nlink 2 with identical spelling",
                src: Stat { nlink: 2, ..src },
                dst: Stat { nlink: 2, ..src },
                to: "Foo.txt",
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "same-case hard links with distinct names",
                src: Stat { nlink: 2, ..src },
                dst: Stat { nlink: 2, ..src },
                from: "a",
                to: "b",
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "case-differing hard links on a case-sensitive volume",
                src: Stat { nlink: 2, ..src },
                dst: Stat { nlink: 2, ..src },
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "destination acquired a link after source was sampled",
                dst: Stat { nlink: 2, ..src },
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "source has extra links despite a single-link destination snapshot",
                src: Stat { nlink: 2, ..src },
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "different parent inodes, even if paths fold equally",
                to_dir: Stat { ino: 21, ..dir },
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "different parent devices with the same inode number",
                to_dir: Stat { dev: 2, ..dir },
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "byte-identical names are not a spelling change",
                to: "Foo.txt",
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "different names that are not fold-equivalent",
                to: "bar.txt",
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "repo fold expands sharp s to ss",
                from: "Straße",
                to: "STRASSE",
                ..base
            },
            Case {
                label: "repo fold expands long s and ligatures",
                from: "ſtraﬃc",
                to: "STRAFFIC",
                ..base
            },
            Case {
                label: "repo fold lowercases the Kelvin sign",
                from: "K.txt",
                to: "k.txt",
                ..base
            },
            Case {
                label: "repo fold trims trailing dots",
                from: "Foo.txt.",
                ..base
            },
            Case {
                label: "repo fold trims trailing spaces",
                from: "Foo.txt ",
                ..base
            },
            Case {
                label: "repo fold preserves leading spaces",
                from: " Foo.txt",
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "repo fold does not equate different Unicode normalization",
                from: "é.txt",
                to: "e\u{301}.txt",
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "different file inode",
                dst: Stat { ino: 11, ..src },
                expected: SameObjectRename::NotSameObject,
                ..base
            },
            Case {
                label: "different file device with the same inode number",
                dst: Stat { dev: 2, ..src },
                expected: SameObjectRename::NotSameObject,
                ..base
            },
            Case {
                label: "directory aliases never qualify",
                src: dir,
                dst: dir,
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "symlink aliases never qualify",
                src: Stat {
                    mode: 0o120_777,
                    ..src
                },
                dst: Stat {
                    mode: 0o120_777,
                    ..src
                },
                expected: SameObjectRename::Refuse,
                ..base
            },
            Case {
                label: "special file aliases never qualify",
                src: Stat {
                    mode: 0o010_600,
                    ..src
                },
                dst: Stat {
                    mode: 0o010_600,
                    ..src
                },
                expected: SameObjectRename::Refuse,
                ..base
            },
        ] {
            assert_eq!(
                same_object_rename(
                    &case.src,
                    &case.dst,
                    &case.from_dir,
                    OsStr::new(case.from),
                    &case.to_dir,
                    OsStr::new(case.to),
                ),
                case.expected,
                "{}",
                case.label,
            );
        }
        // Lossy conversion could equate distinct invalid byte spellings.
        use std::os::unix::ffi::OsStrExt;
        assert_eq!(
            same_object_rename(
                &src,
                &src,
                &dir,
                OsStr::from_bytes(b"F\xff"),
                &dir,
                OsStr::from_bytes(b"f\xfe"),
            ),
            SameObjectRename::Refuse,
        );
    }
}
