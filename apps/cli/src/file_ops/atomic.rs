//! Atomic replace and exclusive create (plan section 3.3).
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
//! 7. if exchange is unsupported, plain cross-directory rename `R/tmp -> name`
//!    retains the documented replace race. The parent directory is fsynced after
//!    the commit and R is removed last (an unreported empty R after a power loss is
//!    harmless);
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
//! (b2) overwrite rename's source is vacant from capture through operation end,
//! and a concurrent create is kept and reported when it blocks restoration;
//! (c) exchange-less replace's cross-directory plain-rename race (window exact
//! in `recovery`); (d) crash
//! residue in `.wsmp-recover-*` (including replace's partial tmp) or both links;
//! (e) unheld objects are never deleted. See `recovery` for restore fallbacks,
//! manual recovery and bounds.
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
use std::path::Path;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat};
use nix::sys::stat::{Mode, fchmod, fstatat, mode_t};
use nix::unistd::{Gid, Uid, fchown, fsync};

use super::error::{ErrorCode, FileError, FileResult};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::exchange::is_unsupported;
use super::read::current_etag;
use super::recovery::{Held, RecoveryDir, Slot};
use super::resolve::Stat;
use super::{Cancel, FileOps, Step};

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
    identity: Held,
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

/// Replace `name` in `dir` with `content`. `orig` is the open original (consumed:
/// it is closed before the recovery directory is removed) and
/// `orig_etag` the etag of the bytes the new content was derived from.
#[allow(clippy::too_many_arguments)]
pub(crate) fn replace(
    ops: &FileOps,
    dir: &OwnedFd,
    name: &OsStr,
    dir_path: &Path,
    orig: File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    cancel: &Cancel,
) -> FileResult<(Stat, Vec<String>)> {
    replace_impl(
        ops, dir, name, dir_path, orig, orig_stat, orig_etag, content, None, cancel,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn replace_supervised(
    ops: &FileOps,
    dir: &OwnedFd,
    name: &OsStr,
    dir_path: &Path,
    orig: File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    pin: &super::supervised::PinnedPath,
    cancel: &Cancel,
) -> FileResult<(Stat, Vec<String>)> {
    replace_impl(
        ops,
        dir,
        name,
        dir_path,
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
    dir_path: &Path,
    mut orig: File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<(Stat, Vec<String>)> {
    check_replaceable(ops, orig_stat)?;
    let mut recovery = RecoveryDir::new(dir, dir_path)?;
    let result = replace_inner(
        ops,
        dir,
        name,
        dir_path,
        &mut orig,
        orig_stat,
        orig_etag,
        content,
        pin,
        cancel,
        &mut recovery,
    );
    // Every held fd is closed before the recovery directory is removed (an NFS
    // client silly-renames an unlinked-but-open file into it, so rmdir would fail).
    // replace_inner's own handles (temp, original dup) ended with its return.
    drop(orig);
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
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
    recovery: &mut RecoveryDir,
) -> FileResult<Stat> {
    let original = Held::from_file(orig)?;
    let (mut tmp, mut tmp_file) = recovery.create_temp(dir, name, &dir_path.join(name))?;
    // A failed fd proof retains the already-private temp; it is never captured
    // through a public staging name.
    let identity = match Held::from_file(&tmp_file) {
        Ok(held) => held,
        Err(_) => return Err(recovery.uncertain()),
    };
    let mut armed = true;
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
        if let Some(pin) = pin {
            pin.verify_at(ops, dir, name, super::policy::Access::Write, cancel)?;
            ops.step(Step::SupervisedPinVerified)?;
        }
        cancel.check()?;
        commit_stage(ops, recovery, &mut tmp, &original, &identity, &mut armed)?;
        armed = false;
        let _ = ops.step(Step::Renamed);
        // Cancellation is no longer honored after commit, including a hook error.
        ops.step(Step::BeforeDirSync)
            .map_err(|_| FileError::mutation_uncertain())?;
        fsync(dir.as_fd()).map_err(FileError::errno)?;
        let _ = ops.step(Step::DirSynced);
        Ok(new_stat)
    })();
    if armed && !recovery.dispose(ops, &tmp, &identity) {
        Err(recovery.uncertain())
    } else {
        result
    }
}

/// Exchange the private temp with its recorded destination. X can only have
/// come from that destination; no public staging name can admit a foreign origin.
/// Undo restores each captured object to its recorded origin, newest write first.
fn commit_stage(
    ops: &FileOps,
    recovery: &mut RecoveryDir,
    tmp: &mut Slot,
    original: &Held,
    identity: &Held,
    armed: &mut bool,
) -> FileResult<()> {
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = (ops, original, identity, armed);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        match recovery.exchange_temp(tmp) {
            Ok(()) => {
                *armed = false;
                let _ = ops.step(Step::Exchanged);
                let _ = ops.step(Step::Captured);
                if recovery.holds(tmp, original) {
                    // Committed: cleanup failure is reported in recovered.
                    recovery.dispose(ops, tmp, original);
                    return Ok(());
                }
                let y = recovery.capture_origin(tmp);
                if y.is_some() {
                    let _ = ops.step(Step::Captured);
                }
                if let Some(y) = &y
                    && !recovery.holds(y, identity)
                {
                    // Newest foreign write wins; X remains named in recovery.
                    if recovery.restore(ops, y) {
                        let _ = ops.step(Step::Restored);
                    }
                } else {
                    if let Some(y) = y {
                        recovery.dispose(ops, &y, identity);
                    }
                    if recovery.restore(ops, tmp) {
                        let _ = ops.step(Step::Restored);
                    }
                }
                return if recovery.settled() {
                    Err(FileError::conflict("replaced"))
                } else {
                    Err(recovery.uncertain())
                };
            }
            Err(Errno::ENOENT) => return Err(FileError::conflict("gone")),
            Err(errno) if is_unsupported(errno) => {}
            Err(errno) => return Err(FileError::errno(errno)),
        }
    }
    recovery.commit_temp(tmp).map_err(FileError::errno)
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
        let identity = match Held::from_file(&file) {
            Ok(held) => held,
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
