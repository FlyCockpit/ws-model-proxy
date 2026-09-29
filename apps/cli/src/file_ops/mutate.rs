//! `forwarder_cli_file_rename`, `forwarder_cli_dir_create`,
//! `forwarder_cli_file_delete`: the small mutating tools.

use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::fcntl::AtFlags;
#[cfg(not(target_os = "linux"))]
use nix::fcntl::renameat;
use nix::sys::stat::mkdirat;
use nix::unistd::{UnlinkatFlags, linkat, unlinkat};
use serde::{Deserialize, Serialize};

use super::atomic::perm_mode;
use super::error::{ErrorCode, FileError, FileResult};
use super::policy::Access;
use super::read::current_etag;
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
fn object_etag(ops: &FileOps, resolved: &Resolved, stat: &Stat) -> FileResult<Option<String>> {
    Ok(match stat.kind() {
        Kind::File => {
            let (mut file, opened) = resolved.open_regular(&ops.policy, Access::Remove)?;
            if !opened.same_object(stat) {
                return Err(FileError::conflict("replaced"));
            }
            Some(current_etag(ops, &mut file, &opened)?)
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
    ops.policy.check_identity(Access::Remove, &src)?;
    let src_etag = object_etag(ops, &from, &src)?;
    if !overwrite && let Some(expected) = &args.expected_etag {
        match &src_etag {
            Some(current) if current == expected => {}
            Some(current) => return Err(FileError::conflict(current)),
            None => return Err(FileError::invalid("directories have no etag")),
        }
    }

    let dst = to.lstat()?;
    if let Some(dst) = &dst {
        if !overwrite {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination already exists",
            ));
        }
        if dst.kind() == Kind::Dir || dst.kind() == Kind::Other {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination is a directory or special file and is not overwritten",
            ));
        }
        ops.policy.check_identity(Access::Write, dst)?;
        let current = object_etag(ops, &to, dst)?.unwrap_or_default();
        if args.expected_etag.as_deref() != Some(current.as_str()) {
            return Err(FileError::conflict(&current));
        }
    }

    cancel.check()?;
    // Test seam: the last point at which the world can change before the commit.
    ops.step(Step::EtagRechecked)?;
    commit_rename(&from, &to, overwrite, &src, dst.as_ref())?;
    Ok(RenameResult { etag: src_etag })
}

/// Commit the rename and verify that the objects that moved are the ones that
/// were checked. `dst` is the destination object that `expectedEtag` covered
/// (`None` when nothing was at the destination).
///
/// * No overwrite (or an empty destination): an atomic no-replace rename, so a
///   destination that appeared after the check is never replaced.
/// * Overwrite of a checked destination (Linux): `RENAME_EXCHANGE`, then the old
///   destination is at the source name and is removed only when it is the object
///   whose etag was checked; otherwise the exchange is undone.
///
/// Residual (documented in the plan): on non-Linux systems overwrite and
/// directory moves have no atomic primitive here and rely on the checks above.
fn commit_rename(
    from: &Resolved,
    to: &Resolved,
    overwrite: bool,
    src: &Stat,
    dst: Option<&Stat>,
) -> FileResult<()> {
    match (overwrite, dst) {
        (true, Some(dst)) => exchange_over(from, to, src, dst),
        _ => {
            move_no_replace(from, to, src)?;
            verify_moved(from, to, src)
        }
    }
}

/// After a move: the destination name must hold the source object.
fn verify_moved(from: &Resolved, to: &Resolved, src: &Stat) -> FileResult<()> {
    match to.lstat()? {
        Some(now) if now.same_object(src) => Ok(()),
        _ => {
            // Another object was moved. Put it back when nothing took its place.
            let _ = move_no_replace(to, from, src);
            Err(FileError::conflict("replaced"))
        }
    }
}

#[cfg(target_os = "linux")]
fn unsupported_atomic() -> FileError {
    FileError::new(
        ErrorCode::Unsupported,
        "this filesystem has no atomic no-replace rename for directories",
    )
}

/// Rename without replacing an existing destination, atomically.
fn move_no_replace(from: &Resolved, to: &Resolved, src: &Stat) -> FileResult<()> {
    #[cfg(target_os = "linux")]
    {
        use nix::fcntl::{RenameFlags, renameat2};
        match renameat2(
            from.dir.as_fd(),
            from.name.as_os_str(),
            to.dir.as_fd(),
            to.name.as_os_str(),
            RenameFlags::RENAME_NOREPLACE,
        ) {
            Ok(()) => return Ok(()),
            Err(Errno::EEXIST) => return Err(exists_error()),
            Err(Errno::EINVAL | Errno::ENOSYS) => {}
            Err(errno) => return Err(FileError::errno(errno)),
        }
    }
    if src.kind() == Kind::Dir {
        #[cfg(target_os = "linux")]
        return Err(unsupported_atomic());
        // Non-Linux: no atomic primitive for directories; existence was checked.
        #[cfg(not(target_os = "linux"))]
        return renameat(
            from.dir.as_fd(),
            from.name.as_os_str(),
            to.dir.as_fd(),
            to.name.as_os_str(),
        )
        .map_err(FileError::errno);
    }
    // link + unlink: `linkat` fails with EEXIST instead of replacing.
    match linkat(
        from.dir.as_fd(),
        from.name.as_os_str(),
        to.dir.as_fd(),
        to.name.as_os_str(),
        AtFlags::empty(),
    ) {
        Ok(()) => {}
        Err(Errno::EEXIST) => return Err(exists_error()),
        Err(errno) => return Err(FileError::errno(errno)),
    }
    match from.lstat()? {
        Some(now) if now.same_object(src) => unlinkat(
            from.dir.as_fd(),
            from.name.as_os_str(),
            UnlinkatFlags::NoRemoveDir,
        )
        .map_err(FileError::errno),
        _ => {
            // The source name changed hands: undo our new link, keep theirs.
            let _ = unlinkat(
                to.dir.as_fd(),
                to.name.as_os_str(),
                UnlinkatFlags::NoRemoveDir,
            );
            Err(FileError::conflict("replaced"))
        }
    }
}

fn exists_error() -> FileError {
    FileError::new(ErrorCode::Exists, "the destination already exists")
}

#[cfg(target_os = "linux")]
fn exchange_over(from: &Resolved, to: &Resolved, src: &Stat, dst: &Stat) -> FileResult<()> {
    use nix::fcntl::{RenameFlags, renameat2};
    let swap = || {
        renameat2(
            from.dir.as_fd(),
            from.name.as_os_str(),
            to.dir.as_fd(),
            to.name.as_os_str(),
            RenameFlags::RENAME_EXCHANGE,
        )
    };
    match swap() {
        Ok(()) => {}
        Err(Errno::EINVAL | Errno::ENOSYS) => {
            return Err(FileError::new(
                ErrorCode::Unsupported,
                "this filesystem cannot replace a destination atomically",
            ));
        }
        Err(errno) => return Err(FileError::errno(errno)),
    }
    let moved_ok = matches!(to.lstat(), Ok(Some(ref now)) if now.same_object(src));
    let old_ok = matches!(from.lstat(), Ok(Some(ref now)) if now.same_object(dst));
    if !(moved_ok && old_ok) {
        // A different object was in play: exchange back, refuse.
        let _ = swap();
        return Err(FileError::conflict("replaced"));
    }
    unlinkat(
        from.dir.as_fd(),
        from.name.as_os_str(),
        UnlinkatFlags::NoRemoveDir,
    )
    .map_err(FileError::errno)
}

#[cfg(not(target_os = "linux"))]
fn exchange_over(from: &Resolved, to: &Resolved, src: &Stat, _dst: &Stat) -> FileResult<()> {
    renameat(
        from.dir.as_fd(),
        from.name.as_os_str(),
        to.dir.as_fd(),
        to.name.as_os_str(),
    )
    .map_err(FileError::errno)?;
    verify_moved_after(to, src)
}

#[cfg(not(target_os = "linux"))]
fn verify_moved_after(to: &Resolved, src: &Stat) -> FileResult<()> {
    match to.lstat()? {
        Some(now) if now.same_object(src) => Ok(()),
        _ => Err(FileError::conflict("replaced")),
    }
}

pub(crate) fn mkdir(ops: &FileOps, args: &MkdirArgs, cancel: &Cancel) -> FileResult<MkdirResult> {
    check_reason(&args.reason)?;
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
        match object_etag(ops, &resolved, &st)? {
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
