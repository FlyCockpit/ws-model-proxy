//! `forwarder_cli_file_rename`, `forwarder_cli_dir_create`,
//! `forwarder_cli_file_delete` on Windows: the checks of the Unix `mutate`
//! (kinds, etags, protected files, a directory into its own subtree), on paths.
//!
//! Every object is re-checked by identity (volume serial and file index) just
//! before it is moved or removed. A rename never replaces what it did not
//! check: without `overwrite` it fails if the destination appeared meanwhile;
//! with it, the destination checked is the one replaced, short of a writer that
//! swaps it between that check and the rename. A deleted file is removed, not
//! moved aside first, and there is no recovery journal (the Unix `recovery`).
//! A directory is deleted only when empty. `mode` is refused: Windows has none.

use std::os::windows::fs::FileTypeExt;
use std::path::Path;

use super::error::{ErrorCode, FileError, FileResult};
use super::policy::Access;
use super::read::current_etag;
use super::resolve::{Kind, ResolveOpts, Resolved, Stat, resolve, same_path};
use super::stat::kind_name;
use super::{Cancel, FileOps, Step, check_reason};

pub use super::mutate_args::{
    DeleteArgs, DeleteResult, MkdirArgs, MkdirResult, RenameArgs, RenameResult,
};

fn resolve_path(
    ops: &FileOps,
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
    ops: &FileOps,
    resolved: &Resolved,
    stat: &Stat,
    access: Access,
    cancel: &Cancel,
) -> FileResult<Option<String>> {
    Ok(match stat.kind() {
        Kind::File => {
            let (mut file, opened) = resolved.open_regular(&ops.policy, access)?;
            if !opened.same_object(stat) {
                return Err(FileError::conflict("replaced"));
            }
            Some(current_etag(ops, &mut file, &opened, cancel)?)
        }
        Kind::Symlink => Some(ops.key.weak_stat(stat)),
        Kind::Dir | Kind::Other => None,
    })
}

/// The name must still be the object that was checked.
fn still_same(resolved: &Resolved, checked: &Stat) -> FileResult<()> {
    match resolved.lstat()? {
        Some(now) if now.same_object(checked) => Ok(()),
        Some(_) => Err(FileError::conflict("replaced")),
        None => Err(FileError::conflict("gone")),
    }
}

/// Whether `inner` is `outer` or beneath it (case-insensitively, as NTFS
/// compares names).
fn within(inner: &Path, outer: &Path) -> bool {
    match (
        super::resolve::posix_view(inner),
        super::resolve::posix_view(outer),
    ) {
        (Some(inner), Some(outer)) => {
            let (inner, outer) = (inner.to_lowercase(), outer.to_lowercase());
            inner == outer || inner.starts_with(&format!("{outer}/"))
        }
        _ => false,
    }
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
    let from = resolve_path(ops, &args.from, Access::Remove, false, Some(cancel))?;
    let to = resolve_path(ops, &args.to, Access::Write, false, Some(cancel))?;
    if from.is_self() || to.is_self() {
        return Err(FileError::invalid(
            "cannot rename a directory reference such as a drive root",
        ));
    }
    let (from_path, to_path) = (from.full_path(), to.full_path());
    if from_path == to_path {
        return Err(FileError::invalid(
            "source and destination are the same path",
        ));
    }
    // Names that differ in case only are one name on NTFS: the move renames it.
    let case_only = same_path(&from_path, &to_path);
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
    if src.kind() == Kind::Dir && !case_only && within(&to.dir_path, &from_path) {
        return Err(FileError::invalid(
            "cannot move a directory into its own subtree",
        ));
    }
    ops.step(Step::BeforeIdentity)?;
    ops.policy.check_identity(Access::Remove, &src)?;
    ops.step(Step::IdentityChecked)?;
    let src_etag = object_etag(ops, &from, &src, Access::Remove, cancel)?;
    if !overwrite && let Some(expected) = &args.expected_etag {
        match &src_etag {
            Some(current) if current == expected => {}
            Some(current) => return Err(FileError::conflict(current)),
            None => return Err(FileError::invalid("directories have no etag")),
        }
    }

    let dst = if case_only { None } else { to.lstat()? };
    if let Some(dst) = &dst {
        if !overwrite {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination already exists",
            ));
        }
        if dst.kind() != src.kind() {
            return Err(FileError::new(
                ErrorCode::Exists,
                "overwrite replaces a file with a file (or a symlink with a symlink), not across kinds",
            ));
        }
        if dst.kind() == Kind::Dir || dst.kind() == Kind::Other {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination is a directory or special file and is not overwritten",
            ));
        }
        ops.step(Step::BeforeIdentity)?;
        ops.policy.check_identity(Access::Write, dst)?;
        ops.step(Step::IdentityChecked)?;
        let current = object_etag(ops, &to, dst, Access::Write, cancel)?.unwrap_or_default();
        if args.expected_etag.as_deref() != Some(current.as_str()) {
            return Err(FileError::conflict(&current));
        }
    }

    ops.step(Step::EtagRechecked)?;
    cancel.check()?;
    still_same(&from, &src)?;
    match &dst {
        Some(dst) => {
            still_same(&to, dst)?;
            super::atomic::rename_retrying(&from_path, &to_path)?;
        }
        None => wsmp_windows::move_no_replace(&from_path, &to_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                FileError::new(ErrorCode::Exists, "the destination already exists")
            } else {
                FileError::io(&error)
            }
        })?,
    }
    let _ = ops.step(Step::Renamed);
    // The moved object keeps its identity and bytes: describe it at its new name.
    let etag = match src.kind() {
        Kind::File => Some(
            resolve_path(ops, &args.to, Access::Read, false, Some(cancel))
                .and_then(|moved| {
                    let (mut file, stat) = moved.open_regular(&ops.policy, Access::Read)?;
                    current_etag(ops, &mut file, &stat, cancel)
                })
                .map_err(|_| FileError::mutation_uncertain())?,
        ),
        Kind::Symlink => Some(ops.key.weak_stat(&Stat::of_path(&to_path)?)),
        Kind::Dir | Kind::Other => None,
    };
    Ok(RenameResult {
        recovered: Vec::new(),
        etag,
    })
}

pub(crate) fn mkdir(ops: &FileOps, args: &MkdirArgs, cancel: &Cancel) -> FileResult<MkdirResult> {
    check_reason(&args.reason)?;
    if args.mode.is_some() {
        return Err(FileError::invalid(
            "mode is not supported on Windows; leave it out",
        ));
    }
    let _namespace = ops.namespace_shared(cancel)?;
    let mut resolved = resolve(
        &args.path,
        &ResolveOpts {
            follow_last: true,
            make_parents: args
                .parents
                .unwrap_or(true)
                .then_some(super::write::DEFAULT_PARENT_MODE),
            policy: &ops.policy,
            access: Access::Write,
            cancel: Some(cancel),
        },
    )?;
    let outcome = mkdir_resolved(ops, &mut resolved, cancel);
    if outcome.is_err() {
        resolved.rollback_created();
    }
    outcome
}

fn mkdir_resolved(
    ops: &FileOps,
    resolved: &mut Resolved,
    cancel: &Cancel,
) -> FileResult<MkdirResult> {
    if resolved.is_self() {
        return Ok(MkdirResult {
            created: !resolved.created.is_empty(),
        });
    }
    let _lock = ops.lock_path(resolved.full_path(), cancel)?;
    let existing = |resolved: &Resolved| match resolved.lstat()? {
        Some(stat) if stat.kind() == Kind::Dir => Ok(MkdirResult { created: false }),
        _ => Err(FileError::new(
            ErrorCode::Exists,
            "a file already exists at this path",
        )),
    };
    if resolved.lstat()?.is_some() {
        return existing(resolved);
    }
    ops.step(Step::EtagRechecked)?;
    cancel.check()?;
    match std::fs::create_dir(resolved.full_path()) {
        Ok(()) => {
            resolved.created.clear();
            Ok(MkdirResult { created: true })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => existing(resolved),
        Err(error) => Err(FileError::io(&error)),
    }
}

pub(crate) fn delete(
    ops: &FileOps,
    args: &DeleteArgs,
    cancel: &Cancel,
) -> FileResult<DeleteResult> {
    check_reason(&args.reason)?;
    let _namespace = ops.namespace_exclusive(cancel)?;
    let resolved = resolve_path(ops, &args.path, Access::Remove, false, Some(cancel))?;
    if resolved.is_self() {
        return Err(FileError::invalid(
            "cannot delete a directory reference such as a drive root",
        ));
    }
    let full = resolved.full_path();
    let _lock = ops.lock_path(full.clone(), cancel)?;
    let st = resolved
        .lstat()?
        .ok_or_else(|| FileError::new(ErrorCode::NotFound, "no such file or directory"))?;
    ops.policy.check_identity(Access::Remove, &st)?;
    if st.kind() == Kind::Other {
        return Err(FileError::new(
            ErrorCode::SpecialFile,
            "special files are not deleted",
        ));
    }
    if let Some(expected) = &args.expected_etag {
        match object_etag(ops, &resolved, &st, Access::Remove, cancel)? {
            Some(current) if current == *expected => {}
            Some(current) => return Err(FileError::conflict(&current)),
            None => return Err(FileError::invalid("directories have no etag")),
        }
    }
    ops.step(Step::EtagRechecked)?;
    cancel.check()?;
    still_same(&resolved, &st)?;
    // A link to a directory (a directory symlink or a junction) is removed as
    // a directory entry: the link goes, never what it points at.
    let directory_entry = match st.kind() {
        Kind::Dir => true,
        Kind::Symlink => std::fs::symlink_metadata(&full)?
            .file_type()
            .is_symlink_dir(),
        Kind::File | Kind::Other => false,
    };
    // A directory that is not empty fails here (`io_error`, as `ENOTEMPTY` on Unix).
    if directory_entry {
        std::fs::remove_dir(&full)?;
    } else {
        std::fs::remove_file(&full)?;
    }
    Ok(DeleteResult {
        deleted: true,
        kind: kind_name(st.kind()),
        recovered: Vec::new(),
    })
}
