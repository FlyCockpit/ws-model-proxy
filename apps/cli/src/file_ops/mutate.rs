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
//! unsafe_filesystem without a plain overwrite fallback. Plain rename uses only
//! NOREPLACE or hard links; absent both it refuses with the same code. File/symlink
//! delete captures into R and verifies Held before disposal; a concurrent successor
//! is restored or reported, never unlinked. Directory delete stays by-name rmdir:
//! the kernel emptiness check cannot destroy a racer's saved contents.
//!
//! Recovery residuals: (a) a guessed private-slot replacement between held-fd
//! proof and unlinkat; (a2) plain-rename capture fallback overwriting a squatter
//! after the private slot was checked absent; (b) public names briefly vacant
//! during undo; (b2) overwrite's source is vacant from capture through operation
//! end, so a concurrent source create survives on success and is kept/reported
//! with uncertainty if it blocks restoration; (d) crashes leave original plus T
//! (tmp/probe) in R with a vacant name, a captured delete with its name vacant, or
//! both links; (e) unheld objects are never deleted; (f) another process's open NFS
//! fd can leave .nfs residue, while ours close BEFORE unlink; (g) link-published T
//! has a brief exposed alias window (failed cleanup leaves nlink 2/hard_linked).
//! Vacancies are bounded by syscalls, not time; filesystem NOREPLACE/link atomicity
//! is trusted. Delete needs R and fails closed on mkdir ENOSPC/EDQUOT/EMLINK or any
//! error; free space using the shell. Files the CLI user cannot open read-only
//! (macOS and other Unix: mode 000 or 0200) refuse before capture. See `recovery` for platform facts and manual recovery. Case-only rename,
//! exclusive-create, rollback_created and exchange-less overwrite refusal remain
//! separate residuals; in-place writes after etag reads remain unprotected.

use std::ffi::OsStr;
use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, renameat};
use nix::sys::stat::{fstat, mkdirat};
use nix::unistd::{UnlinkatFlags, linkat, unlinkat};
use serde::{Deserialize, Serialize};

use super::atomic::perm_mode;
use super::error::{ErrorCode, FileError, FileResult};
use super::exchange::{Primitive, is_link_unsupported, is_unsupported, no_replace, run};
use super::policy::Access;
use super::read::current_etag;
use super::recovery::{Held, Origin, RecoveryDir};
use super::resolve::{Kind, ResolveOpts, Resolved, Stat, resolve};
use super::stat::kind_name;
use super::write::{DEFAULT_PARENT_MODE, parse_mode};
use super::{Cancel, FileOps, Step, check_reason};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum RenameAtomicCapability {
    HardLinksOnly = 0,
    Kernel = 1,
    /// macOS: atomic exchange replaces a checked destination, regular files move
    /// without replacing through link + unlink, and directories have no atomic
    /// no-replace primitive (refused for supervised requests).
    LinksAndExchange = 3,
    #[cfg(test)]
    Unavailable = 2,
}

impl RenameAtomicCapability {
    #[cfg(test)]
    pub(crate) fn from_u8(value: u8) -> Self {
        match value {
            value if value == Self::Kernel as u8 => Self::Kernel,
            value if value == Self::LinksAndExchange as u8 => Self::LinksAndExchange,
            value if value == Self::Unavailable as u8 => Self::Unavailable,
            _ => Self::HardLinksOnly,
        }
    }
}

pub(crate) const fn platform_rename_capability() -> RenameAtomicCapability {
    if cfg!(target_os = "linux") {
        RenameAtomicCapability::Kernel
    } else if cfg!(target_os = "macos") {
        RenameAtomicCapability::LinksAndExchange
    } else {
        RenameAtomicCapability::HardLinksOnly
    }
}

/// Whether a supervised rename may replace a checked destination atomically.
pub(crate) const fn supervised_overwrite_supported(capability: RenameAtomicCapability) -> bool {
    matches!(
        capability,
        RenameAtomicCapability::Kernel | RenameAtomicCapability::LinksAndExchange
    )
}

pub(crate) fn check_supervised_rename_capability(
    capability: RenameAtomicCapability,
    source_kind: Kind,
    overwrite: bool,
    destination_exists: bool,
) -> FileResult<()> {
    match capability {
        RenameAtomicCapability::Kernel => return Ok(()),
        #[cfg(test)]
        RenameAtomicCapability::Unavailable => {
            return Err(FileError::new(
                ErrorCode::Unsupported,
                "this filesystem has no safe atomic rename primitive",
            ));
        }
        RenameAtomicCapability::LinksAndExchange | RenameAtomicCapability::HardLinksOnly => {}
    }
    if overwrite && destination_exists && !supervised_overwrite_supported(capability) {
        return Err(FileError::new(
            ErrorCode::Unsupported,
            "this platform cannot replace a destination atomically",
        ));
    }
    if source_kind == Kind::Dir {
        return Err(FileError::new(
            ErrorCode::Unsupported,
            "this platform has no atomic no-replace rename for directories",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteArgs {
    pub path: String,
    pub expected_etag: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeleteResult {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recovered: Vec<String>,
    pub deleted: bool,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

fn resolve_for_pin(
    ops: &FileOps,
    path: &str,
    access: Access,
    follow_last: bool,
    pin: Option<&super::supervised::PinnedPath>,
    cancel: Option<&Cancel>,
) -> FileResult<Resolved> {
    resolve(
        path,
        &ResolveOpts {
            follow_last,
            make_parents: None,
            policy: &ops.policy,
            access,
            preview_missing: false,
            pin: pin.map(|pin| &pin.ancestor),
            cancel,
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
    rename_impl(ops, args, None, None, cancel)
}

pub(crate) fn rename_supervised(
    ops: &FileOps,
    args: &RenameArgs,
    from_pin: &super::supervised::PinnedPath,
    to_pin: &super::supervised::PinnedPath,
    cancel: &Cancel,
) -> FileResult<RenameResult> {
    rename_impl(ops, args, Some(from_pin), Some(to_pin), cancel)
}

fn rename_impl(
    ops: &FileOps,
    args: &RenameArgs,
    from_pin: Option<&super::supervised::PinnedPath>,
    to_pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<RenameResult> {
    let supervised = from_pin.is_some() && to_pin.is_some();
    check_reason(&args.reason)?;
    let _namespace = ops.namespace_exclusive(cancel)?;
    let overwrite = args.overwrite.unwrap_or(false);
    if overwrite && args.expected_etag.is_none() {
        return Err(FileError::invalid(
            "expectedEtag (of the destination) is required for overwrite",
        ));
    }
    let from = resolve_for_pin(
        ops,
        &args.from,
        Access::Remove,
        false,
        from_pin,
        Some(cancel),
    )?;
    let to = resolve_for_pin(ops, &args.to, Access::Write, false, to_pin, Some(cancel))?;
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
    if let Some(pin) = from_pin {
        ops.step(Step::SupervisedBeforePin)?;
        pin.verify(ops, &from, Access::Remove, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }
    if let Some(pin) = to_pin {
        ops.step(Step::SupervisedBeforePin)?;
        pin.verify(ops, &to, Access::Write, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }

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
    ops.step(Step::BeforeIdentity)?;
    ops.policy.check_identity(Access::Remove, &src.stat)?;
    ops.step(Step::IdentityChecked)?;
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
        ops.step(Step::BeforeIdentity)?;
        ops.policy.check_identity(Access::Write, &dst.stat)?;
        ops.step(Step::IdentityChecked)?;
        let current = object_etag(ops, &to, &dst.stat, cancel)?.unwrap_or_default();
        if args.expected_etag.as_deref() != Some(current.as_str()) {
            return Err(FileError::conflict(&current));
        }
    }

    if supervised {
        check_supervised_rename_capability(
            ops.rename_atomic_capability(),
            src.stat.kind(),
            overwrite,
            dst.is_some(),
        )?;
    }

    // Test seam: the last point at which the world can change before the commit.
    ops.step(Step::EtagRechecked)?;
    if let Some(pin) = from_pin {
        pin.verify(ops, &from, Access::Remove, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }
    if let Some(pin) = to_pin {
        pin.verify(ops, &to, Access::Write, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }
    cancel.check()?;
    let recovered = commit_rename(ops, &from, &to, overwrite, src, dst, supervised)?;
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
/// proof, fallback behavior and exact residual windows. Unsupported directory
/// moves and link-less no-replace operations refuse without a public effect.
/// Case-only rename has the separate check-to-rename residual in
/// `same_object_rename`; it neither replaces a checked object nor compensates.
#[allow(clippy::too_many_arguments)]
fn commit_rename(
    ops: &FileOps,
    from: &Resolved,
    to: &Resolved,
    overwrite: bool,
    mut src: Held,
    mut dst: Option<Held>,
    supervised: bool,
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
    let result = match (overwrite, dst.as_mut()) {
        (true, Some(dst)) => exchange_over(ops, &mut recovery, from, to, &mut src, dst),
        _ => {
            // Track the actual candidate after the final hook as well as the
            // checked source. This snapshot is never authority to unlink a
            // public name; it only permits NOREPLACE restoration from recovery.
            let candidate = from.lstat().and_then(|stat| {
                stat.map(|stat| Held::open(&from.dir, &from.name, stat))
                    .transpose()
            });
            match candidate {
                Ok(Some(mut candidate)) => {
                    let origin = Origin::new(&from.dir, &from.name, &from.full_path())
                        .map_err(FileError::errno)?;
                    move_no_replace(
                        ops,
                        &mut recovery,
                        from,
                        to,
                        &mut src,
                        &mut candidate,
                        supervised,
                    )
                    .and_then(|()| {
                        verify_moved(ops, &mut recovery, to, &mut src, &mut candidate, origin)
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
    src: &mut Held,
    candidate: &mut Held,
    origin: Origin,
) -> FileResult<()> {
    let _ = ops.step(Step::Moved);
    match to.lstat() {
        Ok(Some(now)) if src.matches_for_restore(&now) => Ok(()),
        _ => {
            if let Some(mut slot) = recovery.capture(&to.dir, &to.name, &to.full_path()) {
                let _ = ops.step(Step::Captured);
                if recovery.reclaim_origin(&mut slot, candidate, origin) {
                    // Nothing after this uses either proof, and restore may unlink
                    // a private alias of this inode: close both unconditionally
                    // (a failed observation must not leave one open).
                    candidate.release();
                    src.release();
                    if !recovery.restore(ops, &slot) {
                        return Err(recovery.uncertain());
                    }
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
    src: &mut Held,
    candidate: &mut Held,
    supervised: bool,
) -> FileResult<()> {
    if !supervised || ops.rename_atomic_capability() == RenameAtomicCapability::Kernel {
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
    }
    if src.stat.kind() == Kind::Dir {
        return Err(FileError::unsafe_filesystem());
    }
    match run(Primitive::MoveLink, || {
        linkat(
            from.dir.as_fd(),
            from.name.as_os_str(),
            to.dir.as_fd(),
            to.name.as_os_str(),
            AtFlags::empty(),
        )
    }) {
        Ok(()) => {}
        Err(Errno::EEXIST) => return Err(exists_error()),
        Err(errno) if is_link_unsupported(errno) => return Err(FileError::unsafe_filesystem()),
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
        if candidate.stat.same_object(&src.stat) {
            candidate.release();
        }
        recovery.dispose(ops, &x, src);
        return Ok(());
    }
    // Keep the actual source under its original name if still vacant. Remove
    // the new link only when the captured object proves it is our source.
    if recovery.holds(&x, src) {
        src.release(); // restore may dispose its private link alias
    }
    if recovery.holds(&x, candidate) {
        candidate.release();
    }
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
/// it as unsafe_filesystem and every other errno is its own error.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn overwrite_exchange_error(errno: Errno) -> FileError {
    if is_unsupported(errno) {
        FileError::unsafe_filesystem()
    } else {
        FileError::errno(errno)
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod exchange_error_tests {
    use super::*;

    #[test]
    fn overwrite_refuses_an_exchange_less_filesystem_as_unsafe_only() {
        for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
            assert_eq!(
                overwrite_exchange_error(errno).code,
                ErrorCode::UnsafeFilesystem
            );
        }
        for errno in [Errno::EPERM, Errno::EXDEV, Errno::EACCES, Errno::EIO] {
            assert_ne!(
                overwrite_exchange_error(errno).code,
                ErrorCode::UnsafeFilesystem,
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
    src: &mut Held,
    dst: &mut Held,
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
        src.release();
        dst.release();
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
                src.release();
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
    dst.release(); // proof failed; compensation may restore this inode
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
            src.release();
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
    _src: &mut Held,
    _dst: &mut Held,
) -> FileResult<()> {
    Err(FileError::unsafe_filesystem())
}

pub(crate) fn mkdir(ops: &FileOps, args: &MkdirArgs, cancel: &Cancel) -> FileResult<MkdirResult> {
    mkdir_impl(ops, args, None, cancel)
}

pub(crate) fn mkdir_supervised(
    ops: &FileOps,
    args: &MkdirArgs,
    pin: &super::supervised::PinnedPath,
    cancel: &Cancel,
) -> FileResult<MkdirResult> {
    mkdir_impl(ops, args, Some(pin), cancel)
}

fn mkdir_impl(
    ops: &FileOps,
    args: &MkdirArgs,
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<MkdirResult> {
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
            preview_missing: false,
            pin: pin.map(|pin| &pin.ancestor),
            cancel: Some(cancel),
        },
    )?;
    let outcome = mkdir_resolved(ops, &mut resolved, mode, pin, cancel);
    if outcome.is_err() {
        resolved.rollback_created();
    }
    outcome
}

fn mkdir_resolved(
    ops: &FileOps,
    resolved: &mut Resolved,
    mode: u32,
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<MkdirResult> {
    if resolved.is_self() {
        return Ok(MkdirResult {
            created: !resolved.created.is_empty(),
        });
    }
    let _lock = ops.lock_path(resolved.full_path(), cancel)?;
    if let Some(pin) = pin {
        ops.step(Step::SupervisedBeforePin)?;
        pin.verify(ops, resolved, Access::Write, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }
    match resolved.lstat()? {
        Some(st) if st.kind() == Kind::Dir => {
            if let Some(pin) = pin {
                pin.verify(ops, resolved, Access::Write, cancel)?;
            }
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
    ops.step(Step::EtagRechecked)?;
    if let Some(pin) = pin {
        pin.verify(ops, resolved, Access::Write, cancel)?;
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
    delete_impl(ops, args, None, cancel)
}

pub(crate) fn delete_supervised(
    ops: &FileOps,
    args: &DeleteArgs,
    pin: &super::supervised::PinnedPath,
    cancel: &Cancel,
) -> FileResult<DeleteResult> {
    delete_impl(ops, args, Some(pin), cancel)
}

fn delete_impl(
    ops: &FileOps,
    args: &DeleteArgs,
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<DeleteResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.namespace_exclusive(cancel)?;
    let resolved = resolve_for_pin(ops, &args.path, Access::Remove, false, pin, Some(cancel))?;
    if resolved.is_self() {
        return Err(FileError::invalid(
            "cannot delete a directory reference such as `/` or `..`",
        ));
    }
    let _lock = ops.lock_path(resolved.full_path(), cancel)?;
    if let Some(pin) = pin {
        ops.step(Step::SupervisedBeforePin)?;
        pin.verify(ops, &resolved, Access::Remove, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }
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
    let mut held = Held::open(&resolved.dir, &resolved.name, st)?;
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
    ops.step(Step::EtagRechecked)?;
    if let Some(pin) = pin {
        pin.verify(ops, &resolved, Access::Remove, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }
    cancel.check()?;
    // The name must still be the object we inspected.
    match resolved.lstat()? {
        Some(now) if held.matches_for_restore(&now) => {}
        _ => return Err(FileError::conflict("replaced")),
    }
    if st.kind() == Kind::Dir {
        // Never capture directories: link-only filesystems cannot restore them.
        // Kernel rmdir removes only an empty directory, preserving saved data.
        unlinkat(
            resolved.dir.as_fd(),
            resolved.name.as_os_str(),
            UnlinkatFlags::RemoveDir,
        )
        .map_err(FileError::errno)?;
        return Ok(DeleteResult {
            deleted: true,
            kind: "dir",
            recovered: Vec::new(),
        });
    }
    let mut recovery = RecoveryDir::new(&resolved.dir, &resolved.dir_path)?;
    let result = (|| {
        ops.step(Step::Vacating)?;
        cancel.check()?; // last cancellation point before public capture
        let mark = recovery.checkpoint();
        let Some(slot) = recovery.capture(&resolved.dir, &resolved.name, &resolved.full_path())
        else {
            return Err(match recovery.abort_capture(mark) {
                Some(Errno::ENOENT) => FileError::conflict("gone"),
                Some(errno) => FileError::errno(errno),
                None => recovery.uncertain(),
            });
        };
        let _ = ops.step(Step::Vacated);
        if !recovery.holds(&slot, &held) {
            held.release();
            if recovery.restore(ops, &slot) {
                let _ = ops.step(Step::Restored);
            }
            return if recovery.settled() {
                Err(FileError::conflict("replaced"))
            } else {
                Err(recovery.uncertain())
            };
        }
        // A proven delete is committed; failed cleanup is recoverable success.
        recovery.dispose(ops, &slot, &mut held);
        Ok(())
    })();
    held.release();
    let recovered = recovery.finish();
    match result {
        Ok(()) => Ok(DeleteResult {
            deleted: true,
            kind: kind_name(st.kind()),
            recovered,
        }),
        Err(error) if error.code == ErrorCode::UncertainOutcome || !recovery.settled() => {
            Err(recovery.uncertain())
        }
        Err(error) => Err(error),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod descriptor_tests {
    use super::*;
    use crate::file_ops::exchange::{FaultScope, UNLINK_PROBE};
    use crate::file_ops::tests::{Fx, args};
    use serde_json::json;
    use std::os::unix::fs::MetadataExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn verify_moved_observation_failure_closes_both_proofs_before_restore_unlink() {
        let fx = Fx::new();
        let path = fx.put("source", "checked source");
        let from =
            resolve_for_pin(&fx.ops, &fx.p("source"), Access::Remove, false, None, None).unwrap();
        let stat = from.lstat().unwrap().unwrap();
        let mut src = Held::open(&from.dir, &from.name, stat).unwrap();
        let mut candidate = Held::open(&from.dir, &from.name, stat).unwrap();
        let origin = Origin::new(&from.dir, &from.name, &path).unwrap();
        std::fs::rename(path, fx.root.join("destination")).unwrap();
        let to = resolve_for_pin(
            &fx.ops,
            &fx.p("destination"),
            Access::Write,
            false,
            None,
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
            &fx.ops,
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
        let from =
            resolve_for_pin(&fx.ops, &fx.p("source"), Access::Remove, false, None, None).unwrap();
        let stat = from.lstat().unwrap().unwrap();
        let mut src = Held::open(&from.dir, &from.name, stat).unwrap();
        let mut candidate = Held::open(&from.dir, &from.name, stat).unwrap();
        let origin = Origin::new(&from.dir, &from.name, &path).unwrap();
        std::fs::rename(path, fx.root.join("destination")).unwrap();
        let to = resolve_for_pin(
            &fx.ops,
            &fx.p("destination"),
            Access::Write,
            false,
            None,
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
            &fx.ops,
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

    #[test]
    fn directory_delete_failed_held_observation_refuses_before_rmdir() {
        let fx = Fx::new();
        std::fs::create_dir(fx.root.join("directory")).unwrap();
        let _scope = FaultScope::new(&[(Primitive::Identity, 1, Errno::EIO)]);
        let error = delete(
            &fx.ops,
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
mod supervised_capability_tests {
    use super::*;

    #[test]
    fn platform_capability_pins_supervised_overwrite_and_directory_rules() {
        // The production row for this platform, independent of the helper under test.
        let expected = if cfg!(target_os = "linux") {
            RenameAtomicCapability::Kernel
        } else if cfg!(target_os = "macos") {
            RenameAtomicCapability::LinksAndExchange
        } else {
            RenameAtomicCapability::HardLinksOnly
        };
        assert_eq!(platform_rename_capability(), expected);
        assert_eq!(
            supervised_overwrite_supported(platform_rename_capability()),
            cfg!(any(target_os = "linux", target_os = "macos"))
        );
    }

    #[test]
    fn macos_links_and_exchange_allows_overwrite_but_refuses_directory_moves() {
        let cap = RenameAtomicCapability::LinksAndExchange;
        assert!(check_supervised_rename_capability(cap, Kind::File, true, true).is_ok());
        assert!(check_supervised_rename_capability(cap, Kind::File, false, false).is_ok());
        assert_eq!(
            check_supervised_rename_capability(cap, Kind::Dir, false, false)
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
        let links = RenameAtomicCapability::HardLinksOnly;
        assert_eq!(
            check_supervised_rename_capability(links, Kind::File, true, true)
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
    }
}
