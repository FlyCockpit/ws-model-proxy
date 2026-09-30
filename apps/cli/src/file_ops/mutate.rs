//! `forwarder_cli_file_rename`, `forwarder_cli_dir_create`,
//! `forwarder_cli_file_delete`: the small mutating tools.
//!
//! Plain and overwrite rename use recovery and can return uncertain_outcome
//! or recovered paths on success. Overwrite vacates the source into a private
//! slot, verifies its held fd, then exchanges that slot with the destination.
//! The exchanged-out object therefore has destination origin by construction.
//! A proven source captured during undo returns to its recorded source origin;
//! a newer destination writer returns to destination, keeping the older object
//! in recovery. Exchange failure restores source; unsupported exchange returns
//! Unsupported without a plain overwrite fallback.
//!
//! Recovery residuals: (a) a guessed private-slot replacement between held-fd
//! proof and unlinkat; (a2) plain-rename capture fallback overwriting a squatter
//! after the private slot was checked absent; (b) public names briefly vacant
//! during undo; (b2) overwrite's source is vacant from capture through operation
//! end, so a concurrent source create survives on success and is kept/reported
//! with uncertainty if it blocks restoration; (c) exchange-less replace retains
//! its cross-directory plain-rename race; (d) crashes leave `.wsmp-recover-*`
//! (also the home of replace's partial temp) or both links; (e) unheld objects
//! are never deleted. See `recovery` for manual recovery and restore fallbacks;
//! case-only rename and link-less fallback retain their separate residual races.

use std::ffi::OsStr;
use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, renameat};
use nix::sys::stat::{fstat, mkdirat};
use nix::unistd::{UnlinkatFlags, linkat, unlinkat};
use serde::{Deserialize, Serialize};

use super::atomic::perm_mode;
use super::error::{ErrorCode, FileError, FileResult};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::exchange::{Primitive, is_unsupported, no_replace};
use super::policy::Access;
use super::read::current_etag;
use super::recovery::{Held, Origin, RecoveryDir};
use super::resolve::{Kind, ResolveOpts, Resolved, Stat, resolve};
use super::stat::kind_name;
use super::write::{DEFAULT_PARENT_MODE, parse_mode};
use super::{Cancel, FileOps, Step, check_reason};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameArgs {
    pub from: String,
    pub to: String,
    pub overwrite: Option<bool>,
    /// With `overwrite: true` (required): the etag of the DESTINATION being
    /// replaced. Otherwise, optionally, the etag of the source.
    pub expected_etag: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recovered: Vec<String>,
    /// Etag of the moved file (none for directories).
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MkdirArgs {
    pub path: String,
    pub parents: Option<bool>,
    pub mode: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MkdirResult {
    pub created: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteArgs {
    pub path: String,
    pub expected_etag: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeleteResult {
    pub deleted: bool,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

fn resolve_for(
    ops: &FileOps,
    path: &str,
    access: Access,
    follow_last: bool,
) -> FileResult<Resolved> {
    resolve(
        path,
        &ResolveOpts {
            follow_last,
            make_parents: None,
            policy: &ops.policy,
            access,
        },
    )
}

/// The etag a caller would have seen for the object `stat` describes.
fn object_etag(
    ops: &FileOps,
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
            Some(current_etag(ops, &mut file, &opened, cancel)?)
        }
        Kind::Symlink => Some(ops.key.weak_stat(stat)),
        Kind::Dir | Kind::Other => None,
    })
}

pub(crate) fn rename(
    ops: &FileOps,
    args: &RenameArgs,
    cancel: &Cancel,
) -> FileResult<RenameResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.namespace_exclusive(cancel)?;
    let overwrite = args.overwrite.unwrap_or(false);
    if overwrite && args.expected_etag.is_none() {
        return Err(FileError::invalid(
            "expectedEtag (of the destination) is required for overwrite",
        ));
    }
    let from = resolve_for(ops, &args.from, Access::Remove, false)?;
    let to = resolve_for(ops, &args.to, Access::Write, false)?;
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
    // Lock in path order so two renames cannot deadlock each other.
    let (first, second) = if from_path <= to_path {
        (from_path.clone(), to_path.clone())
    } else {
        (to_path.clone(), from_path.clone())
    };
    let _lock_a = ops.lock_path(first, cancel)?;
    let _lock_b = ops.lock_path(second, cancel)?;

    let src = from
        .lstat()?
        .ok_or_else(|| FileError::new(ErrorCode::NotFound, "the source does not exist"))?;
    if src.kind() == Kind::Other {
        return Err(FileError::new(
            ErrorCode::SpecialFile,
            "special files are not moved",
        ));
    }
    let src = Held::open(&from.dir, &from.name, src)?;
    ops.policy.check_identity(Access::Remove, &src.stat)?;
    let src_etag = object_etag(ops, &from, &src.stat, cancel)?;
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
    if let Some(dst) = &dst {
        if !overwrite {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination already exists",
            ));
        }
        if dst.stat.kind() != src.stat.kind() {
            return Err(FileError::new(
                ErrorCode::Exists,
                "overwrite replaces a file with a file (or a symlink with a symlink), not across kinds",
            ));
        }
        if dst.stat.kind() == Kind::Dir || dst.stat.kind() == Kind::Other {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination is a directory or special file and is not overwritten",
            ));
        }
        ops.policy.check_identity(Access::Write, &dst.stat)?;
        let current = object_etag(ops, &to, &dst.stat, cancel)?.unwrap_or_default();
        if args.expected_etag.as_deref() != Some(current.as_str()) {
            return Err(FileError::conflict(&current));
        }
    }

    cancel.check()?;
    // Test seam: the last point at which the world can change before the commit.
    ops.step(Step::EtagRechecked)?;
    let recovered = commit_rename(ops, &from, &to, overwrite, src, dst)?;
    Ok(RenameResult {
        etag: src_etag,
        recovered,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SameObjectRename {
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
fn same_object_rename(
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
            if super::redact::fold(from) == super::redact::fold(to))
    {
        SameObjectRename::CaseOnlyRename
    } else {
        SameObjectRename::Refuse
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

/// Sole overwrite gate for rename: classify same-object pairs before allocating
/// recovery. Case-only aliases use plain renameat with no recovery directory;
/// other commits allocate one private recovery directory before mutation. Public
/// names are never unlinked or blindly swapped during compensation.
///
/// Plain rename also uses recovery. Both paths can return uncertain_outcome or
/// recovered on success. The module docs and `recovery` describe the held-fd
/// proof, fallback behavior and exact residual windows. Other Unix directory
/// moves and link-less no-replace fallbacks retain their precommit check race.
/// Case-only rename has the separate check-to-rename residual in
/// `same_object_rename`; it neither replaces a checked object nor compensates.
fn commit_rename(
    ops: &FileOps,
    from: &Resolved,
    to: &Resolved,
    overwrite: bool,
    src: Held,
    dst: Option<Held>,
) -> FileResult<Vec<String>> {
    if overwrite && let Some(dst) = &dst {
        let from_dir = Stat::from_raw(&fstat(from.dir.as_fd()).map_err(FileError::errno)?);
        let to_dir = Stat::from_raw(&fstat(to.dir.as_fd()).map_err(FileError::errno)?);
        match same_object_rename(
            &src.stat, &dst.stat, &from_dir, &from.name, &to_dir, &to.name,
        ) {
            SameObjectRename::Refuse => {
                return Err(FileError::invalid(
                    "source and destination are the same file",
                ));
            }
            SameObjectRename::CaseOnlyRename => {
                renameat(
                    from.dir.as_fd(),
                    from.name.as_os_str(),
                    to.dir.as_fd(),
                    to.name.as_os_str(),
                )
                .map_err(FileError::errno)?;
                return Ok(Vec::new());
            }
            SameObjectRename::NotSameObject => {}
        }
    }
    let mut recovery = RecoveryDir::new(&to.dir, &to.dir_path)?;
    let result = match (overwrite, dst.as_ref()) {
        (true, Some(dst)) => exchange_over(ops, &mut recovery, from, to, &src, dst),
        _ => {
            // Track the actual candidate after the final hook as well as the
            // checked source. This snapshot is never authority to unlink a
            // public name; it only permits NOREPLACE restoration from recovery.
            let candidate = from.lstat().and_then(|stat| {
                stat.map(|stat| Held::open(&from.dir, &from.name, stat))
                    .transpose()
            });
            match candidate {
                Ok(Some(candidate)) => {
                    let origin = Origin::new(&from.dir, &from.name, &from.full_path())
                        .map_err(FileError::errno)?;
                    move_no_replace(ops, &mut recovery, from, to, &src).and_then(|()| {
                        verify_moved(ops, &mut recovery, to, &src, &candidate, origin)
                    })
                }
                Ok(None) => Err(FileError::conflict("gone")),
                Err(error) => Err(error),
            }
        }
    };
    // Close every held fd before the recovery directory is removed: a network
    // filesystem (NFS) silly-renames an unlinked-but-open file into the directory
    // and rmdir would fail until the last descriptor is closed.
    drop(src);
    drop(dst);
    let recovered = recovery.finish();
    match result {
        Ok(()) => Ok(recovered),
        Err(error) if error.code == ErrorCode::UncertainOutcome || !recovery.settled() => {
            Err(recovery.uncertain())
        }
        Err(error) => Err(error),
    }
}

/// Capture a post-move mismatch. Restore only the candidate identity observed
/// before the move, using NOREPLACE; newer destination successors stay in recovery.
fn verify_moved(
    ops: &FileOps,
    recovery: &mut RecoveryDir,
    to: &Resolved,
    src: &Held,
    candidate: &Held,
    origin: Origin,
) -> FileResult<()> {
    let _ = ops.step(Step::Moved);
    match to.lstat() {
        Ok(Some(now)) if src.matches_for_restore(&now) => Ok(()),
        _ => {
            if let Some(mut slot) = recovery.capture(&to.dir, &to.name, &to.full_path()) {
                let _ = ops.step(Step::Captured);
                if recovery.reclaim_origin(&mut slot, candidate, origin)
                    && recovery.restore(ops, &slot)
                {
                    let _ = ops.step(Step::Restored);
                    if recovery.settled() {
                        return Err(FileError::conflict("replaced"));
                    }
                }
            }
            Err(recovery.uncertain())
        }
    }
}

/// Rename without replacing an existing destination. The link fallback also
/// captures its source before disposal, and captures its destination on undo.
fn move_no_replace(
    ops: &FileOps,
    recovery: &mut RecoveryDir,
    from: &Resolved,
    to: &Resolved,
    src: &Held,
) -> FileResult<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    match no_replace(
        from.dir.as_fd(),
        from.name.as_os_str(),
        to.dir.as_fd(),
        to.name.as_os_str(),
        Primitive::Move,
    ) {
        Ok(()) => return Ok(()),
        Err(Errno::EEXIST) => return Err(exists_error()),
        Err(errno) if is_unsupported(errno) => {}
        Err(errno) => return Err(FileError::errno(errno)),
    }
    if src.stat.kind() == Kind::Dir {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        return Err(FileError::new(
            ErrorCode::Unsupported,
            "this filesystem has no atomic no-replace rename for directories",
        ));
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        return renameat(
            from.dir.as_fd(),
            from.name.as_os_str(),
            to.dir.as_fd(),
            to.name.as_os_str(),
        )
        .map_err(FileError::errno);
    }
    match linkat(
        from.dir.as_fd(),
        from.name.as_os_str(),
        to.dir.as_fd(),
        to.name.as_os_str(),
        AtFlags::empty(),
    ) {
        Ok(()) => {}
        Err(Errno::EEXIST) => return Err(exists_error()),
        Err(Errno::EPERM | Errno::ENOTSUP | Errno::EMLINK) => {
            return renameat(
                from.dir.as_fd(),
                from.name.as_os_str(),
                to.dir.as_fd(),
                to.name.as_os_str(),
            )
            .map_err(FileError::errno);
        }
        Err(errno) => return Err(FileError::errno(errno)),
    }
    let _ = ops.step(Step::Linked);
    let Some(x) = recovery.capture(&from.dir, &from.name, &from.full_path()) else {
        recovery.record_public(&to.dir, &to.name, &to.full_path());
        return Err(recovery.uncertain());
    };
    let _ = ops.step(Step::Captured);
    if recovery.matches_for_restore(&x, src)
        && matches!(to.lstat(), Ok(Some(now)) if src.matches_for_restore(&now))
    {
        recovery.dispose(ops, &x, src);
        return Ok(());
    }
    // Keep the actual source under its original name if still vacant. Remove
    // the new link only when the captured object proves it is our source.
    if recovery.restore(ops, &x) {
        let _ = ops.step(Step::Restored);
    }
    if let Some(y) = recovery.capture(&to.dir, &to.name, &to.full_path()) {
        let _ = ops.step(Step::Captured);
        recovery.dispose(ops, &y, src);
    }
    if recovery.settled() {
        Err(FileError::conflict("replaced"))
    } else {
        Err(recovery.uncertain())
    }
}

fn exists_error() -> FileError {
    FileError::new(ErrorCode::Exists, "the destination already exists")
}

/// An overwrite has no non-atomic fallback: a filesystem without exchange refuses
/// it as unsupported and every other errno is its own error.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn overwrite_exchange_error(errno: Errno) -> FileError {
    if is_unsupported(errno) {
        FileError::new(
            ErrorCode::Unsupported,
            "this filesystem cannot replace a destination atomically",
        )
    } else {
        FileError::errno(errno)
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod exchange_error_tests {
    use super::*;

    #[test]
    fn overwrite_refuses_an_exchange_less_filesystem_as_unsupported_only() {
        for errno in [Errno::EINVAL, Errno::ENOSYS] {
            assert_eq!(overwrite_exchange_error(errno).code, ErrorCode::Unsupported);
        }
        for errno in [Errno::EPERM, Errno::EXDEV, Errno::EACCES, Errno::EIO] {
            assert_ne!(
                overwrite_exchange_error(errno).code,
                ErrorCode::Unsupported,
                "{errno}"
            );
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange_over(
    ops: &FileOps,
    recovery: &mut RecoveryDir,
    from: &Resolved,
    to: &Resolved,
    src: &Held,
    dst: &Held,
) -> FileResult<()> {
    // Capture before exchanging: the public source is never used as a staging
    // slot for the destination. Its vacancy is the documented window (b2).
    // Crash window: between this capture and the exchange the source exists only
    // inside the recovery directory, so say where (daemon log) before moving it.
    tracing::info!(
        recovery = %recovery.path().display(),
        "overwrite rename: the source is held in the recovery directory until the exchange completes"
    );
    let mark = recovery.checkpoint();
    let Some(mut x) = recovery.capture(&from.dir, &from.name, &from.full_path()) else {
        // A refused rename moved nothing: an ordinary error, nothing to recover.
        return Err(match recovery.abort_capture(mark) {
            Some(errno) => overwrite_exchange_error(errno),
            None => recovery.uncertain(),
        });
    };
    let _ = ops.step(Step::Captured);
    if !recovery.holds(&x, src) {
        if recovery.restore(ops, &x) {
            let _ = ops.step(Step::Restored);
        }
        return if recovery.settled() {
            Err(FileError::conflict("replaced"))
        } else {
            Err(recovery.uncertain())
        };
    }
    let _ = ops.step(Step::Vacated);
    let destination = Origin::new(&to.dir, &to.name, &to.full_path());
    let source_origin = match destination.and_then(|origin| recovery.exchange(&mut x, origin)) {
        Ok(origin) => origin,
        Err(errno) => {
            // An exchange that reported an error may still have taken effect: only
            // a slot that still holds the checked source goes back to its name.
            if recovery.holds(&x, src) {
                if recovery.restore(ops, &x) {
                    let _ = ops.step(Step::Restored);
                }
            } else {
                recovery.keep(&x);
            }
            // No plain overwrite fallback. The outer wrapper reports uncertainty
            // if a concurrent source create or restore failure kept the source.
            return Err(overwrite_exchange_error(errno));
        }
    };
    let _ = ops.step(Step::Exchanged);
    let _ = ops.step(Step::Captured);
    if recovery.holds(&x, dst) {
        recovery.dispose(ops, &x, dst);
        return Ok(());
    }
    let y = recovery.capture(&to.dir, &to.name, &to.full_path());
    if y.is_some() {
        let _ = ops.step(Step::Captured);
    }
    if let Some(mut y) = y {
        if recovery.holds(&y, src) {
            // Proven S can reclaim only its recorded source origin from step 1.
            if recovery.restore(ops, &x) {
                let _ = ops.step(Step::Restored);
            }
            if recovery.reclaim_origin(&mut y, src, source_origin) && recovery.restore(ops, &y) {
                let _ = ops.step(Step::Restored);
            }
        } else if recovery.restore(ops, &y) {
            // Newest writer returns to its captured destination origin; X stays.
            let _ = ops.step(Step::Restored);
        }
    }
    if recovery.settled() {
        Err(FileError::conflict("replaced"))
    } else {
        Err(recovery.uncertain())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn exchange_over(
    _ops: &FileOps,
    _recovery: &mut RecoveryDir,
    _from: &Resolved,
    _to: &Resolved,
    _src: &Held,
    _dst: &Held,
) -> FileResult<()> {
    Err(FileError::new(
        ErrorCode::Unsupported,
        "this platform cannot replace a destination atomically",
    ))
}

pub(crate) fn mkdir(ops: &FileOps, args: &MkdirArgs, cancel: &Cancel) -> FileResult<MkdirResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.namespace_shared(cancel)?;
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
        },
    )?;
    let outcome = mkdir_resolved(ops, &mut resolved, mode, cancel);
    if outcome.is_err() {
        resolved.rollback_created();
    }
    outcome
}

fn mkdir_resolved(
    ops: &FileOps,
    resolved: &mut Resolved,
    mode: u32,
    cancel: &Cancel,
) -> FileResult<MkdirResult> {
    if resolved.is_self() {
        return Ok(MkdirResult {
            created: !resolved.created.is_empty(),
        });
    }
    let _lock = ops.lock_path(resolved.full_path(), cancel)?;
    match resolved.lstat()? {
        Some(st) if st.kind() == Kind::Dir => return Ok(MkdirResult { created: false }),
        Some(_) => {
            return Err(FileError::new(
                ErrorCode::Exists,
                "a file already exists at this path",
            ));
        }
        None => {}
    }
    cancel.check()?;
    match mkdirat(
        resolved.dir.as_fd(),
        resolved.name.as_os_str(),
        perm_mode(mode),
    ) {
        Ok(()) => {
            resolved.created.clear();
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
    ops: &FileOps,
    args: &DeleteArgs,
    cancel: &Cancel,
) -> FileResult<DeleteResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.namespace_exclusive(cancel)?;
    let resolved = resolve_for(ops, &args.path, Access::Remove, false)?;
    if resolved.is_self() {
        return Err(FileError::invalid(
            "cannot delete a directory reference such as `/` or `..`",
        ));
    }
    let _lock = ops.lock_path(resolved.full_path(), cancel)?;
    let st = resolved
        .lstat()?
        .ok_or_else(|| FileError::new(ErrorCode::NotFound, "no such file or directory"))?;
    ops.policy.check_identity(Access::Remove, &st)?;
    let flag = match st.kind() {
        Kind::Dir => UnlinkatFlags::RemoveDir,
        Kind::File | Kind::Symlink => UnlinkatFlags::NoRemoveDir,
        Kind::Other => {
            return Err(FileError::new(
                ErrorCode::SpecialFile,
                "special files are not deleted",
            ));
        }
    };
    if let Some(expected) = &args.expected_etag {
        match object_etag(ops, &resolved, &st, cancel)? {
            Some(current) if current == *expected => {}
            Some(current) => return Err(FileError::conflict(&current)),
            None => return Err(FileError::invalid("directories have no etag")),
        }
    }
    cancel.check()?;
    // Observable seam for the pre-unlink re-check (race tests swap the name here).
    ops.step(Step::EtagRechecked)?;
    // The name must still be the object we inspected.
    match resolved.lstat()? {
        Some(now) if now.same_object(&st) => {}
        _ => return Err(FileError::conflict("replaced")),
    }
    unlinkat(resolved.dir.as_fd(), resolved.name.as_os_str(), flag).map_err(FileError::errno)?;
    Ok(DeleteResult {
        deleted: true,
        kind: kind_name(st.kind()),
    })
}
