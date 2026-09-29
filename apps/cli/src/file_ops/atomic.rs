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

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStringExt;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat, renameat};
use nix::sys::stat::{Mode, fchmod, fstatat};
use nix::unistd::{Gid, Uid, UnlinkatFlags, fchown, fsync, unlinkat};
use rand::distr::{Alphanumeric, SampleString};

use super::error::{ErrorCode, FileError, FileResult};
use super::read::current_etag;
use super::resolve::Stat;
use super::text::floor_boundary;
use super::{Cancel, FileOps, Step};

/// Longest base name kept in the temp name (NAME_MAX is 255).
const TEMP_BASE_MAX: usize = 200;

/// Refuse files an atomic replace would damage.
pub fn check_replaceable(ops: &FileOps, stat: &Stat) -> FileResult<()> {
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
pub fn replace(
    ops: &FileOps,
    dir: &OwnedFd,
    name: &OsStr,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    cancel: &Cancel,
) -> FileResult<()> {
    check_replaceable(ops, orig_stat)?;
    let tmp = temp_name(name);
    let fd = openat(
        dir.as_fd(),
        tmp.as_os_str(),
        OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o600),
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
    fchmod(
        tmp_file.as_fd(),
        Mode::from_bits_truncate(orig_stat.mode & 0o7777),
    )
    .map_err(FileError::errno)?;
    ops.step(Step::Chmodded)?;

    recheck(ops, dir, name, orig, orig_stat, orig_etag)?;
    ops.step(Step::EtagRechecked)?;
    cancel.check()?;

    renameat(dir.as_fd(), guard.name.as_os_str(), dir.as_fd(), name).map_err(FileError::errno)?;
    guard.armed = false;
    // Committed: hook errors below cannot undo the rename.
    let _ = ops.step(Step::Renamed);
    fsync(dir.as_fd()).map_err(FileError::errno)?;
    let _ = ops.step(Step::DirSynced);
    Ok(())
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
    let current = read_from_start(ops, orig, &now)?;
    if current != orig_etag {
        return Err(FileError::conflict(&current));
    }
    Ok(())
}

fn read_from_start(ops: &FileOps, file: &mut File, stat: &Stat) -> FileResult<String> {
    use std::io::Seek;
    file.rewind()?;
    current_etag(ops, file, stat)
}

/// Create `name` exclusively with `mode` (after umask) and `content`. The new
/// file is removed again if any later step fails.
pub fn create_new(dir: &OwnedFd, name: &OsStr, content: &[u8], mode: u32) -> FileResult<()> {
    let fd = openat(
        dir.as_fd(),
        name,
        OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(mode & 0o777),
    )
    .map_err(FileError::errno)?;
    let mut file = File::from(fd);
    let finish = (|| -> FileResult<()> {
        file.write_all(content)?;
        file.sync_all()?;
        fsync(dir.as_fd()).map_err(FileError::errno)?;
        Ok(())
    })();
    if finish.is_err() {
        let _ = unlinkat(dir.as_fd(), name, UnlinkatFlags::NoRemoveDir);
    }
    finish
}
