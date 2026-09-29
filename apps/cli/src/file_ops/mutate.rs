//! `forwarder_cli_file_rename`, `forwarder_cli_dir_create`,
//! `forwarder_cli_file_delete`: the small mutating tools.

use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::fcntl::renameat;
use nix::sys::stat::{Mode, mkdirat};
use nix::unistd::{UnlinkatFlags, unlinkat};
use serde::{Deserialize, Serialize};

use super::error::{ErrorCode, FileError, FileResult};
use super::policy::Access;
use super::read::current_etag;
use super::resolve::{Kind, ResolveOpts, Resolved, Stat, resolve};
use super::stat::kind_name;
use super::write::{DEFAULT_PARENT_MODE, parse_mode};
use super::{Cancel, FileOps, check_reason};

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

pub fn rename(ops: &FileOps, args: &RenameArgs, cancel: &Cancel) -> FileResult<RenameResult> {
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

    if let Some(dst) = to.lstat()? {
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
        ops.policy.check_identity(Access::Write, &dst)?;
        let current = object_etag(ops, &to, &dst)?.unwrap_or_default();
        if args.expected_etag.as_deref() != Some(current.as_str()) {
            return Err(FileError::conflict(&current));
        }
    }

    cancel.check()?;
    do_rename(&from, &to, overwrite)?;
    Ok(RenameResult { etag: src_etag })
}

#[cfg(target_os = "linux")]
fn do_rename(from: &Resolved, to: &Resolved, overwrite: bool) -> FileResult<()> {
    use nix::fcntl::{RenameFlags, renameat2};
    if overwrite {
        return renameat(
            from.dir.as_fd(),
            from.name.as_os_str(),
            to.dir.as_fd(),
            to.name.as_os_str(),
        )
        .map_err(FileError::errno);
    }
    match renameat2(
        from.dir.as_fd(),
        from.name.as_os_str(),
        to.dir.as_fd(),
        to.name.as_os_str(),
        RenameFlags::RENAME_NOREPLACE,
    ) {
        Ok(()) => Ok(()),
        // Filesystems without RENAME_NOREPLACE: existence was checked above.
        Err(Errno::EINVAL | Errno::ENOSYS) => renameat(
            from.dir.as_fd(),
            from.name.as_os_str(),
            to.dir.as_fd(),
            to.name.as_os_str(),
        )
        .map_err(FileError::errno),
        Err(errno) => Err(FileError::errno(errno)),
    }
}

#[cfg(not(target_os = "linux"))]
fn do_rename(from: &Resolved, to: &Resolved, _overwrite: bool) -> FileResult<()> {
    // No atomic no-replace rename in nix here: existence was checked above.
    renameat(
        from.dir.as_fd(),
        from.name.as_os_str(),
        to.dir.as_fd(),
        to.name.as_os_str(),
    )
    .map_err(FileError::errno)
}

pub fn mkdir(ops: &FileOps, args: &MkdirArgs, cancel: &Cancel) -> FileResult<MkdirResult> {
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
        Mode::from_bits_truncate(mode),
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

pub fn delete(ops: &FileOps, args: &DeleteArgs, cancel: &Cancel) -> FileResult<DeleteResult> {
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
