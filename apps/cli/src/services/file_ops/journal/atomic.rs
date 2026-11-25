//! Atomic replace and exclusive create (plan section 3.3). Each runs as one
//! recovery transaction (`recovery::replace`, `recovery::create`); this module
//! refuses unsafe targets and stages and re-checks the content.
//!
//! Replace, on held directory fds:
//! 1. create mode-0600 `tmp` INSIDE a mode-0700 `.wsmp-recover-*` directory
//!    beside the target; no public staging name exists;
//! 2. write the content, then fsync the held temp;
//! 3. fchown to the original uid/gid, THEN fchmod to its mode;
//! 4. re-check the etag on the still-open original and its public-name identity;
//! 5. honor cancellation (the last point where it is honored);
//! 6. cross-directory exchange `R/tmp <-> dir/name`. The displaced object in
//!    `R/tmp` came from `name` by construction. Dispose it only with the original
//!    held fd. On mismatch, capture the destination and undo to recorded origins:
//!    dispose our proven temp and restore the displaced object, or restore the
//!    newest external write and keep the older object with uncertain_outcome;
//! 7. if exchange is unsupported, first probe NOREPLACE/link at an absent private
//!    name; capture and prove the original, then publish into its vacant name using
//!    only the selected no-overwrite primitive. If neither works, nothing public
//!    changes. Fsync the parent after commit; remove R last;
//! 8. precommit failure disposes the already-private temp by its held fd,
//!    without capturing any public name. A crash leaves a discoverable R/tmp.
//!
//! Replace and exclusive create use recovery and can return uncertain_outcome
//! or successful results with recovered paths. Exclusive-create cleanup still
//! captures the public created name and disposes only its held identity.
//! Exact recovery residuals: (a) a guessed private-slot replacement between
//! held-fd proof and unlinkat; (a2) plain-rename capture fallback overwriting a
//! squatter after the private slot was checked absent; (b) public names briefly
//! vacant during undo, so concurrent creates prevent NOREPLACE restoration;
//! (b2) recovery rename's source is vacant from capture through operation end,
//! with destination also vacant during exchange-less overwrite publication,
//! and a concurrent create is kept and reported when it blocks restoration;
//! (d) crash residue in R (original plus partial tmp/renamed probe and public name
//! vacant, captured delete, rename S/D or preflight dummies) or both links; (e) unheld objects are never deleted;
//! (f) another process's open NFS fd can leave .nfs residue; our own fds close before
//! unlink; (g) replace/rename link publication exposes T/S before alias unlink;
//! where link counts can be believed (probed per operation) a count < 2 retains the
//! last alias; where they cannot (sshfs) or after that check, the race remains.
//! Failed alias cleanup leaves nlink 2 and hard_linked refusal until manual cleanup.
//! The vacant interval is bounded by syscalls, never by elapsed time; publication
//! depends on the filesystem's actual NOREPLACE/link atomicity. See `recovery` for
//! platform facts, in-place-write loss, restore fallbacks and separate case-only
//! rename, exclusive-create and rollback_created residuals. Rename shares the
//! safe publisher but keeps every unpublished user source; Temps stay disposable.
//!
//! Refused up front: files owned by another uid (a non-root rename would change
//! the owner), hard-linked files (the rename would break the link), and
//! setuid/setgid files.
//!
//! Only mode, owner and group are carried over: extended attributes and POSIX
//! ACLs (SELinux labels, `security.*`, `user.*`, inherit-only ACEs) are **not**
//! copied, so a replaced file loses them.

use std::ffi::OsStr;
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;

use nix::errno::Errno;
use nix::fcntl::AtFlags;
use nix::sys::stat::{fchmod, fstatat};
use nix::unistd::{Gid, Uid, fchown};

use super::recovery;
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::fs::meta::{Stat, perm_mode};
use crate::services::file_ops::{Cancel, Step};

/// Refuse files an atomic replace would damage.
pub(crate) fn check_replaceable(ops: &OpContext, stat: &Stat) -> FileResult<()> {
    let euid = ops.policy.euid();
    if stat.uid != euid && euid != 0 {
        return Err(FileError::new(
            ErrorCode::OwnerMismatch,
            "the file is owned by another user; replacing it would change its owner",
        ));
    }
    if stat.nlink > 1 {
        return Err(FileError::new(
            ErrorCode::HardLinked,
            "the file has several hard links; replacing it would break them (use the shell)",
        ));
    }
    if stat.mode & 0o6000 != 0 {
        return Err(FileError::new(
            ErrorCode::Setuid,
            "setuid and setgid files are not modified",
        ));
    }
    Ok(())
}

/// Replace `name` in `dir` with `content`. `orig` is the open original (consumed:
/// it is closed before any private disposal unlink) and
/// `orig_etag` the etag of the bytes the new content was derived from.
#[allow(clippy::too_many_arguments)]
pub(crate) fn replace(
    ops: &OpContext,
    dir: &OwnedFd,
    name: &OsStr,
    dir_path: &Path,
    orig: File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    cancel: &Cancel,
) -> FileResult<(Stat, Vec<String>)> {
    check_replaceable(ops, orig_stat)?;
    let stage = |tmp_file: &mut File, orig: &mut File| -> FileResult<Stat> {
        ops.hook.step(Step::TempCreated)?;
        // A failed write or writeback of the private temp is disposed by its
        // held proof (never fsynced again, never published or certified).
        tmp_file.write_all(content)?;
        ops.hook.step(Step::TempWritten)?;
        tmp_file.sync_all()?;
        ops.hook.step(Step::TempSynced)?;
        fchown(
            tmp_file.as_fd(),
            Some(Uid::from_raw(orig_stat.uid)),
            Some(Gid::from_raw(orig_stat.gid)),
        )
        .map_err(FileError::errno)?;
        ops.hook.step(Step::Chowned)?;
        fchmod(tmp_file.as_fd(), perm_mode(orig_stat.mode & 0o7777)).map_err(FileError::errno)?;
        ops.hook.step(Step::Chmodded)?;
        tmp_file.sync_all()?;
        let new_stat = Stat::from_metadata(&tmp_file.metadata()?);
        recheck(ops, dir, name, orig, orig_stat, orig_etag, cancel)?;
        ops.hook.step(Step::EtagRechecked)?;
        cancel.check()?;
        Ok(new_stat)
    };
    recovery::replace(ops, dir, name, dir_path, orig, stage, cancel)
}

/// The name must still point at the file we read, and that file must still
/// hold the bytes the edit was computed from.
fn recheck(
    ops: &OpContext,
    dir: &OwnedFd,
    name: &OsStr,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    cancel: &Cancel,
) -> FileResult<()> {
    let named =
        fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW).map_err(|errno| match errno {
            Errno::ENOENT => FileError::conflict("gone"),
            other => FileError::errno(other),
        })?;
    if !Stat::from_raw(&named).same_object(orig_stat) {
        return Err(FileError::conflict("replaced"));
    }
    let now = Stat::from_metadata(&orig.metadata()?);
    let current = read_from_start(ops, orig, &now, cancel)?;
    if current != orig_etag {
        return Err(FileError::conflict(&current));
    }
    Ok(())
}

fn read_from_start(
    ops: &OpContext,
    file: &mut File,
    stat: &Stat,
    cancel: &Cancel,
) -> FileResult<String> {
    use std::io::Seek;
    file.rewind()?;
    ops.key.current(file, stat, cancel)
}

/// Exclusive create. A failed write captures the name and only disposes the
/// identity of the held created fd; a squatter is retained with uncertainty.
pub(crate) fn create_new(
    ops: &OpContext,
    dir: &OwnedFd,
    dir_path: &Path,
    name: &OsStr,
    content: &[u8],
    mode: u32,
) -> FileResult<(Stat, Vec<String>)> {
    recovery::create(ops, dir, dir_path, name, content, mode)
}
