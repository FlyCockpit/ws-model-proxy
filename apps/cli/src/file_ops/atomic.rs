//! Atomic replace and exclusive create (plan section 3.3).
//!
//! Replace, on the held parent dirfd:
//! 1. `openat(dirfd, ".<name>.wsmp-<rand>", O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY, 0600)`;
//! 2. write the content, then `fsync`;
//! 3. `fchown` to the original uid/gid, **then** `fchmod` to the original mode
//!    (in that order, so a chown cannot strip bits after chmod);
//! 4. re-check the etag on the still-open original fd, and that the name still
//!    refers to the same file;
//! 5. honor cancellation (the last point where it is honored);
//! 6. `renameat(dirfd, tmp, dirfd, name)`, then `fsync(dirfd)`;
//! 7. on any failure before the rename, `unlinkat` the temp file.
//!
//! Refused up front: files owned by another uid (a non-root rename would change
//! the owner), hard-linked files (the rename would break the link), and
//! setuid/setgid files.
//!
//! Only mode, owner and group are carried over: extended attributes and POSIX
//! ACLs (SELinux labels, `security.*`, `user.*`, inherit-only ACEs) are **not**
//! copied, so a replaced file loses them.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStringExt;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat, renameat};
use nix::sys::stat::{Mode, fchmod, fstatat, mode_t};
use nix::unistd::{Gid, Uid, UnlinkatFlags, fchown, fsync, unlinkat};
use rand::distr::{Alphanumeric, SampleString};

use super::error::{ErrorCode, FileError, FileResult};
use super::read::current_etag;
use super::resolve::Stat;
use super::text::floor_boundary;
use super::{Cancel, FileOps, Step};

/// Longest base name kept in the temp name (NAME_MAX is 255).
const TEMP_BASE_MAX: usize = 200;

/// Permission bits as a [`Mode`]. `mode_t` is `u32` on Linux and `u16` on macOS,
/// so the cast is what makes `Mode::from_bits_truncate` portable.
#[allow(clippy::unnecessary_cast)]
pub(crate) fn perm_mode(bits: u32) -> Mode {
    Mode::from_bits_truncate(bits as mode_t)
}

/// Refuse files an atomic replace would damage.
pub(crate) fn check_replaceable(ops: &FileOps, stat: &Stat) -> FileResult<()> {
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

struct TempGuard<'a> {
    dir: &'a OwnedFd,
    name: OsString,
    armed: bool,
}

impl Drop for TempGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = unlinkat(
                self.dir.as_fd(),
                self.name.as_os_str(),
                UnlinkatFlags::NoRemoveDir,
            );
        }
    }
}

fn temp_name(name: &OsStr) -> OsString {
    let lossy = name.to_string_lossy();
    let base = &lossy[..floor_boundary(&lossy, TEMP_BASE_MAX)];
    let suffix = Alphanumeric.sample_string(&mut rand::rng(), 10);
    OsString::from_vec(format!(".{base}.wsmp-{suffix}").into_bytes())
}

/// Replace `name` in `dir` with `content`. `orig` is the open original and
/// `orig_etag` the etag of the bytes the new content was derived from.
#[allow(clippy::too_many_arguments)]
pub(crate) fn replace(
    ops: &FileOps,
    dir: &OwnedFd,
    name: &OsStr,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    cancel: &Cancel,
) -> FileResult<Stat> {
    replace_impl(
        ops, dir, name, orig, orig_stat, orig_etag, content, None, cancel,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn replace_supervised(
    ops: &FileOps,
    dir: &OwnedFd,
    name: &OsStr,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    pin: &super::supervised::PinnedPath,
    cancel: &Cancel,
) -> FileResult<Stat> {
    replace_impl(
        ops,
        dir,
        name,
        orig,
        orig_stat,
        orig_etag,
        content,
        Some(pin),
        cancel,
    )
}

#[allow(clippy::too_many_arguments)]
fn replace_impl(
    ops: &FileOps,
    dir: &OwnedFd,
    name: &OsStr,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<Stat> {
    check_replaceable(ops, orig_stat)?;
    let tmp = temp_name(name);
    let fd = openat(
        dir.as_fd(),
        tmp.as_os_str(),
        OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
        perm_mode(0o600),
    )
    .map_err(FileError::errno)?;
    let mut guard = TempGuard {
        dir,
        name: tmp,
        armed: true,
    };
    let mut tmp_file = File::from(fd);
    ops.step(Step::TempCreated)?;

    tmp_file.write_all(content)?;
    ops.step(Step::TempWritten)?;
    tmp_file.sync_all()?;
    ops.step(Step::TempSynced)?;

    fchown(
        tmp_file.as_fd(),
        Some(Uid::from_raw(orig_stat.uid)),
        Some(Gid::from_raw(orig_stat.gid)),
    )
    .map_err(FileError::errno)?;
    ops.step(Step::Chowned)?;
    fchmod(tmp_file.as_fd(), perm_mode(orig_stat.mode & 0o7777)).map_err(FileError::errno)?;
    ops.step(Step::Chmodded)?;
    // the identity the replacement will have once renamed (etags are bound to it)
    let new_stat = Stat::from_metadata(&tmp_file.metadata()?);

    recheck(ops, dir, name, orig, orig_stat, orig_etag, cancel)?;
    ops.step(Step::EtagRechecked)?;
    if let Some(pin) = pin {
        pin.verify_at(ops, dir, name, super::policy::Access::Write, cancel)?;
    }
    cancel.check()?;

    commit_stage(
        dir,
        guard.name.as_os_str(),
        name,
        orig_stat,
        &new_stat,
        &mut guard.armed,
    )?;
    guard.armed = false;
    // Committed: cancellation and observational hook errors cannot undo the
    // rename. Any failure to finish syncing has an unknown mutation outcome.
    let _ = ops.step(Step::Renamed);
    ops.step(Step::BeforeDirSync)
        .map_err(|_| FileError::mutation_uncertain())?;
    fsync(dir.as_fd()).map_err(|_| FileError::mutation_uncertain())?;
    let _ = ops.step(Step::DirSynced);
    Ok(new_stat)
}

/// Put the staged file at `name`, replacing only the object that was checked.
///
/// Linux: `RENAME_EXCHANGE`, then the staged name holds whatever was at `name`;
/// if that is not the original object (a successor slipped in after the final
/// re-check) the exchange is undone and the caller gets a conflict, so an
/// unapproved successor is never overwritten. After an exchange the guard is
/// disarmed: the staged name is unlinked here, and only when it still holds the
/// object we put there (a double race must not delete a third object). Crash
/// states: between the exchange and the unlink the old file is under the staging
/// name (no data is lost). Elsewhere (and on filesystems without exchange) a plain
/// rename is used and the re-check is the only guard: a documented residual.
fn commit_stage(
    dir: &OwnedFd,
    stage: &OsStr,
    name: &OsStr,
    orig_stat: &Stat,
    staged_stat: &Stat,
    armed: &mut bool,
) -> FileResult<()> {
    #[cfg(not(target_os = "linux"))]
    let _ = (orig_stat, staged_stat, &armed);
    #[cfg(target_os = "linux")]
    {
        use nix::fcntl::{RenameFlags, renameat2};
        let swap = || {
            renameat2(
                dir.as_fd(),
                stage,
                dir.as_fd(),
                name,
                RenameFlags::RENAME_EXCHANGE,
            )
        };
        let holds = |expected: &Stat| {
            fstatat(dir.as_fd(), stage, AtFlags::AT_SYMLINK_NOFOLLOW)
                .is_ok_and(|held| Stat::from_raw(&held).same_object(expected))
        };
        match swap() {
            Ok(()) => {
                // the guard must not unlink a name that now holds someone else's file
                *armed = false;
                if holds(orig_stat) {
                    // the original: it is replaced, drop it (already committed: a
                    // failed cleanup is not a failed edit)
                    let _ = unlinkat(dir.as_fd(), stage, UnlinkatFlags::NoRemoveDir);
                    return Ok(());
                }
                // a successor: restore it, and drop our staged file only when the
                // stage name holds it again
                swap().map_err(|_| FileError::mutation_uncertain())?;
                if holds(staged_stat) {
                    let _ = unlinkat(dir.as_fd(), stage, UnlinkatFlags::NoRemoveDir);
                }
                return Err(FileError::conflict("replaced"));
            }
            Err(Errno::ENOENT) => return Err(FileError::conflict("gone")),
            Err(Errno::EINVAL | Errno::ENOSYS) => {}
            Err(errno) => return Err(FileError::errno(errno)),
        }
    }
    renameat(dir.as_fd(), stage, dir.as_fd(), name).map_err(FileError::errno)
}

/// The name must still point at the file we read, and that file must still
/// hold the bytes the edit was computed from.
fn recheck(
    ops: &FileOps,
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
    ops: &FileOps,
    file: &mut File,
    stat: &Stat,
    cancel: &Cancel,
) -> FileResult<String> {
    use std::io::Seek;
    file.rewind()?;
    current_etag(ops, file, stat, cancel)
}

/// Create `name` exclusively with `mode` (after umask) and `content`. The new
/// file is removed again if any later step fails.
pub(crate) fn create_new(
    dir: &OwnedFd,
    name: &OsStr,
    content: &[u8],
    mode: u32,
) -> FileResult<Stat> {
    let fd = openat(
        dir.as_fd(),
        name,
        OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
        perm_mode(mode & 0o777),
    )
    .map_err(FileError::errno)?;
    let mut file = File::from(fd);
    let finish = (|| -> FileResult<Stat> {
        file.write_all(content)?;
        file.sync_all()?;
        fsync(dir.as_fd()).map_err(FileError::errno)?;
        Ok(Stat::from_metadata(&file.metadata()?))
    })();
    if finish.is_err() {
        let _ = unlinkat(dir.as_fd(), name, UnlinkatFlags::NoRemoveDir);
    }
    finish
}
