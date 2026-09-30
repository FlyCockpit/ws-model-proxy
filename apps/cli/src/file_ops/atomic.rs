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
//! 6. exchange tmp with name where supported and remove the checked original,
//!    otherwise `renameat(dirfd, tmp, dirfd, name)`; then `fsync(dirfd)`;
//! 7. on failure, capture the temp into recovery and dispose only its identity.
//!
//! Recovery and exact POSIX residual windows: (a) a same-user writer discovering
//! the private random directory can replace a slot between its identity check
//! and unlink (the only deleting window); (b) a concurrent create during the
//! vacant-name undo window keeps the displaced object in recovery; (c) plain
//! rename on exchange-less filesystems retains its precommit race; (d) crashes
//! leave recovery/staging names. See `recovery` for manual recovery and bounds.
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
use std::path::Path;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat, renameat};
use nix::sys::stat::{Mode, fchmod, fstatat, mode_t};
use nix::unistd::{Gid, Uid, fchown, fsync};
use rand::distr::{Alphanumeric, SampleString};

use super::error::{ErrorCode, FileError, FileResult};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::exchange::{exchange, is_unsupported};
use super::read::current_etag;
use super::recovery::RecoveryDir;
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
    path: std::path::PathBuf,
    name: OsString,
    identity: Stat,
    recovery: &'a mut RecoveryDir,
    armed: bool,
}

impl TempGuard<'_> {
    fn cleanup(&mut self, ops: &FileOps) -> bool {
        if !self.armed {
            return true;
        }
        self.armed = false;
        let Some(slot) = self.recovery.capture(self.dir, &self.name, &self.path) else {
            return false;
        };
        let _ = ops.step(Step::Captured);
        self.recovery.dispose(ops, &slot, &self.identity)
    }
}

impl Drop for TempGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            // Unwind safety net only captures; it never unlinks a public name.
            self.armed = false;
            let _ = self.recovery.capture(self.dir, &self.name, &self.path);
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
    dir_path: &Path,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    cancel: &Cancel,
) -> FileResult<(Stat, Vec<String>)> {
    check_replaceable(ops, orig_stat)?;
    let mut recovery = RecoveryDir::new(dir, dir_path)?;
    let result = replace_inner(
        ops,
        dir,
        name,
        dir_path,
        orig,
        orig_stat,
        orig_etag,
        content,
        cancel,
        &mut recovery,
    );
    let recovered = recovery.finish();
    match result {
        Ok(stat) => Ok((stat, recovered)),
        Err(error) if error.code == ErrorCode::UncertainOutcome || !recovery.settled() => {
            Err(recovery.uncertain())
        }
        Err(error) => Err(error),
    }
}

/// All exits after opening the temp flow through cleanup; the outer wrapper
/// finishes the recovery directory and lets uncertainty override an earlier error.
#[allow(clippy::too_many_arguments)]
fn replace_inner(
    ops: &FileOps,
    dir: &OwnedFd,
    name: &OsStr,
    dir_path: &Path,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    cancel: &Cancel,
    recovery: &mut RecoveryDir,
) -> FileResult<Stat> {
    let tmp = temp_name(name);
    let fd = openat(
        dir.as_fd(),
        tmp.as_os_str(),
        OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
        perm_mode(0o600),
    )
    .map_err(FileError::errno)?;
    let mut tmp_file = File::from(fd);
    // fstat is on the held fd, never a sampled public pathname. If it fails,
    // capture without disposal: there is no proven identity to authorize unlink.
    let identity = match nix::sys::stat::fstat(tmp_file.as_fd()) {
        Ok(raw) => Stat::from_raw(&raw),
        Err(_) => {
            let _ = recovery.capture(dir, &tmp, &dir_path.join(&tmp));
            return Err(recovery.uncertain());
        }
    };
    let mut guard = TempGuard {
        dir,
        path: dir_path.join(&tmp),
        name: tmp,
        identity,
        recovery,
        armed: true,
    };
    let result = (|| -> FileResult<Stat> {
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
        let new_stat = Stat::from_metadata(&tmp_file.metadata()?);
        recheck(ops, dir, name, orig, orig_stat, orig_etag, cancel)?;
        ops.step(Step::EtagRechecked)?;
        cancel.check()?;
        commit_stage(ops, &mut guard, name, dir_path, orig_stat, &new_stat)?;
        guard.armed = false;
        let _ = ops.step(Step::Renamed);
        fsync(dir.as_fd()).map_err(FileError::errno)?;
        let _ = ops.step(Step::DirSynced);
        Ok(new_stat)
    })();
    if !guard.cleanup(ops) {
        Err(guard.recovery.uncertain())
    } else {
        result
    }
}

/// Exchange first, then capture the displaced object; NEVER unlink or swap back
/// a public name using an earlier stat. Undo captures both objects and restores
/// using NOREPLACE. Unproven objects are retained, with an uncertain outcome.
fn commit_stage(
    ops: &FileOps,
    guard: &mut TempGuard<'_>,
    name: &OsStr,
    dir_path: &Path,
    orig_stat: &Stat,
    staged_stat: &Stat,
) -> FileResult<()> {
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = (ops, dir_path, orig_stat, staged_stat);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        match exchange(
            guard.dir.as_fd(),
            guard.name.as_os_str(),
            guard.dir.as_fd(),
            name,
        ) {
            Ok(()) => {
                guard.armed = false;
                let _ = ops.step(Step::Exchanged);
                let Some(x) = guard.recovery.capture(guard.dir, &guard.name, &guard.path) else {
                    guard
                        .recovery
                        .record_public(guard.dir, name, &dir_path.join(name));
                    return Err(guard.recovery.uncertain());
                };
                let _ = ops.step(Step::Captured);
                if guard.recovery.holds(&x, orig_stat) {
                    // Committed: retention is a successful edit with recovered paths.
                    guard.recovery.dispose(ops, &x, orig_stat);
                    return Ok(());
                }
                let y = guard
                    .recovery
                    .capture(guard.dir, name, &dir_path.join(name));
                if y.is_some() {
                    let _ = ops.step(Step::Captured);
                }
                if guard
                    .recovery
                    .restore(&x, guard.dir, name, &dir_path.join(name))
                {
                    let _ = ops.step(Step::Restored);
                }
                if let Some(y) = y {
                    guard.recovery.dispose(ops, &y, staged_stat);
                }
                guard.recovery.finish();
                return if guard.recovery.settled() {
                    Err(FileError::conflict("replaced"))
                } else {
                    Err(guard.recovery.uncertain())
                };
            }
            Err(Errno::ENOENT) => return Err(FileError::conflict("gone")),
            Err(errno) if is_unsupported(errno) => {}
            Err(errno) => return Err(FileError::errno(errno)),
        }
    }
    // The unchanged exchange-less plain-rename race is documented above.
    renameat(
        guard.dir.as_fd(),
        guard.name.as_os_str(),
        guard.dir.as_fd(),
        name,
    )
    .map_err(FileError::errno)
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

/// Exclusive create. A failed write captures the name and only disposes the
/// identity of the held created fd; a squatter is retained with uncertainty.
pub(crate) fn create_new(
    ops: &FileOps,
    dir: &OwnedFd,
    dir_path: &Path,
    name: &OsStr,
    content: &[u8],
    mode: u32,
) -> FileResult<(Stat, Vec<String>)> {
    let mut recovery = RecoveryDir::new(dir, dir_path)?;
    let result = (|| -> FileResult<Stat> {
        let fd = openat(
            dir.as_fd(),
            name,
            OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
            perm_mode(mode & 0o777),
        )
        .map_err(FileError::errno)?;
        let mut file = File::from(fd);
        let identity = match nix::sys::stat::fstat(file.as_fd()) {
            Ok(raw) => Stat::from_raw(&raw),
            Err(_) => {
                let _ = recovery.capture(dir, name, &dir_path.join(name));
                return Err(recovery.uncertain());
            }
        };
        let mut guard = TempGuard {
            dir,
            name: name.to_os_string(),
            path: dir_path.join(name),
            identity,
            recovery: &mut recovery,
            armed: true,
        };
        let finish = (|| -> FileResult<Stat> {
            ops.step(Step::Created)?;
            file.write_all(content)?;
            file.sync_all()?;
            fsync(dir.as_fd()).map_err(FileError::errno)?;
            Ok(Stat::from_metadata(&file.metadata()?))
        })();
        if finish.is_ok() {
            guard.armed = false;
        }
        if !guard.cleanup(ops) {
            return Err(guard.recovery.uncertain());
        }
        finish
    })();
    let recovered = recovery.finish();
    match result {
        Ok(stat) => Ok((stat, recovered)),
        Err(_) if !recovery.settled() => Err(recovery.uncertain()),
        Err(error) => Err(error),
    }
}
