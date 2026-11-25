//! The replace and exclusive-create transactions: each is one call that runs
//! the whole recovery sequence (temp, INTENT, exchange or the exchange-less
//! publisher, compensation, disposal and the final cleanup) and returns the
//! outcome with any recovered paths. `atomic` stages the content; nothing
//! outside this module steps a [`RecoveryDir`].

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat};
use nix::sys::stat::fstatat;
use nix::unistd::fsync;

use super::{Held, Published, RecoveryDir, Slot};
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::services::file_ops::journal::exchange::is_unsupported;
use crate::services::file_ops::journal::intent::Intent;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::services::file_ops::journal::intent::IntentPhase;
use crate::services::file_ops::meta::{Stat, perm_mode};
use crate::services::file_ops::{Cancel, Step};

struct TempGuard<'a> {
    dir: &'a OwnedFd,
    path: PathBuf,
    name: OsString,
    identity: Held,
    recovery: &'a mut RecoveryDir,
    armed: bool,
}

impl TempGuard<'_> {
    fn cleanup(&mut self, ops: &OpContext) -> bool {
        if !self.armed {
            return true;
        }
        self.armed = false;
        let Some(slot) = self.recovery.capture(self.dir, &self.name, &self.path) else {
            return false;
        };
        let _ = ops.hook.step(Step::Captured);
        self.recovery.dispose(ops, &slot, &mut self.identity)
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

/// Replace `name` in `dir` with a private temp that `stage` fills. `orig` is
/// the open original (consumed: it is closed before any private disposal
/// unlink). `stage(temp, orig)` writes, syncs and re-checks; its error disposes
/// the temp without any public effect. Returns the published object's stat and
/// the recovered paths.
pub(in crate::services::file_ops) fn replace(
    ops: &OpContext,
    dir: &OwnedFd,
    name: &OsStr,
    dir_path: &Path,
    orig: File,
    stage: impl FnOnce(&mut File, &mut File) -> FileResult<Stat>,
    cancel: &Cancel,
) -> FileResult<(Stat, Vec<String>)> {
    let mut recovery = RecoveryDir::new(dir, dir_path)?;
    let result = replace_inner(ops, dir, name, dir_path, orig, stage, cancel, &mut recovery);
    // replace_inner closes staging/read files before any final unlink.
    let recovered = recovery.finish();
    match result {
        Ok(_) if !recovery.acknowledges_success() => Err(recovery.uncertain()),
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
    ops: &OpContext,
    dir: &OwnedFd,
    name: &OsStr,
    dir_path: &Path,
    mut orig: File,
    stage: impl FnOnce(&mut File, &mut File) -> FileResult<Stat>,
    cancel: &Cancel,
    recovery: &mut RecoveryDir,
) -> FileResult<Stat> {
    let mut original = Held::from_file(&orig)?;
    let (mut tmp, mut tmp_file) = recovery.create_temp(dir, name, &dir_path.join(name))?;
    // A failed fd proof retains the already-private temp; it is never captured
    // through a public staging name.
    let mut identity = match Held::from_file(&tmp_file) {
        Ok(held) => held,
        Err(_) => return Err(recovery.uncertain()),
    };
    let mut armed = true;
    let prepared = (|| -> FileResult<Stat> {
        let new_stat = stage(&mut tmp_file, &mut orig)?;
        let intent =
            Intent::replace(&dir_path.join(name)).publishing(&dir_path.join(name), &new_stat);
        recovery.prepare_intent(intent)?;
        Ok(new_stat)
    })();
    // The Held proofs are now the only descriptors on these inodes. Their
    // disposal releases the last fd BEFORE unlink, avoiding NFS silly-renames.
    drop(orig);
    drop(tmp_file);
    let result = prepared.and_then(|new_stat| {
        let linked = commit_stage(
            ops,
            recovery,
            &mut tmp,
            &mut original,
            &mut identity,
            &mut armed,
            cancel,
        )?;
        armed = false;
        let _ = ops.hook.step(Step::Renamed);
        // Cancellation is no longer honored after commit, including a hook error.
        ops.hook
            .step(Step::BeforeDirSync)
            .map_err(|_| FileError::mutation_uncertain())?;
        // The commit already crossed this directory's barrier before its
        // durable `committed` record; a repeat failure cannot undo it.
        if let Err(errno) = fsync(dir.as_fd()) {
            tracing::warn!(%errno, "directory sync after committed replace failed");
        }
        let _ = ops.hook.step(Step::DirSynced);
        if linked {
            // Link publication gives the public name its own directory entry. On a
            // mount without stable inode numbers (some FUSE filesystems) that name
            // reports a different inode than the temp the stat came from, and the
            // etag binds the inode: describe the public name, as every later read
            // will. A racer that replaced it meanwhile only yields an etag that
            // matches the racer's file at best, never a stale validation.
            return Ok(fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW)
                .map(|raw| Stat::from_raw(&raw))
                .unwrap_or(new_stat));
        }
        Ok(new_stat)
    });
    if armed && !recovery.dispose(ops, &tmp, &mut identity) {
        Err(recovery.uncertain())
    } else {
        result
    }
}

/// Exchange the private temp with its recorded destination. X can only have
/// come from that destination; no public staging name can admit a foreign origin.
/// Undo restores each captured object to its recorded origin, newest write first.
#[allow(clippy::too_many_arguments)]
fn commit_stage(
    ops: &OpContext,
    recovery: &mut RecoveryDir,
    tmp: &mut Slot,
    original: &mut Held,
    identity: &mut Held,
    armed: &mut bool,
    cancel: &Cancel,
) -> FileResult<bool> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        recovery.set_intent_phase(IntentPhase::Publishing)?;
        match recovery.exchange_temp(tmp) {
            Ok(()) => {
                *armed = false;
                recovery.record_slot_identity(tmp)?;
                let _ = ops.hook.step(Step::Exchanged);
                let _ = ops.hook.step(Step::Captured);
                if recovery.holds(tmp, original) {
                    recovery.sync_effect(&[tmp.origin_dir()])?;
                    recovery.set_intent_phase(IntentPhase::Committed)?;
                    // Committed: cleanup failure is reported in recovered.
                    recovery.dispose(ops, tmp, original);
                    return Ok(false);
                }
                recovery.set_intent_phase(IntentPhase::Compensating)?;
                original.release(); // no longer needed; undo may link this inode
                let y = recovery.capture_origin(tmp);
                if let Some(slot) = &y {
                    recovery.record_slot_identity(slot)?;
                    let _ = ops.hook.step(Step::Captured);
                }
                if let Some(y) = &y
                    && !recovery.holds(y, identity)
                {
                    // Newest foreign write wins; X remains named in recovery.
                    // T's proof is not used to dispose y. An unsupported restore
                    // links T publicly and unlinks slot-2, so this descriptor
                    // must already be closed (F3).
                    identity.release();
                    if recovery.restore(ops, y) {
                        let _ = ops.hook.step(Step::Restored);
                    }
                } else {
                    if let Some(y) = y {
                        recovery.dispose(ops, &y, identity);
                    }
                    // No further disposal uses T's proof. Restore opens its own
                    // proof, and may unlink an alias of T from this private slot.
                    identity.release();
                    if recovery.restore(ops, tmp) {
                        let _ = ops.hook.step(Step::Restored);
                    }
                }
                return if recovery.settled() {
                    Err(FileError::conflict("replaced"))
                } else {
                    Err(recovery.uncertain())
                };
            }
            Err(Errno::ENOENT) => return Err(FileError::conflict("gone")),
            Err(errno) if is_unsupported(errno) => {
                recovery.set_intent_phase(IntentPhase::Prepared)?;
            }
            Err(errno) => return Err(FileError::errno(errno)),
        }
    }
    // The fallback owns T before probing. No outer exit may dispose it again.
    *armed = false;
    recovery.publish_without_exchange(ops, tmp, Some(original), identity, cancel, Published::Temp)
}

/// Exclusive create of `name` in `dir` holding `content`. A failed write
/// captures the name and only disposes the identity of the held created fd; a
/// squatter is retained with uncertainty.
pub(in crate::services::file_ops) fn create(
    ops: &OpContext,
    dir: &OwnedFd,
    dir_path: &Path,
    name: &OsStr,
    content: &[u8],
    mode: u32,
) -> FileResult<(Stat, Vec<String>)> {
    let mut recovery = RecoveryDir::new(dir, dir_path)?;
    let result = (|| -> FileResult<Stat> {
        // Unsupported directory sync refuses before anything is created.
        crate::services::file_ops::fs::sync::probe_dir_barrier(dir)?;
        // The exclusive create is itself a public effect: later barrier
        // failures while disposing it cannot be reported as a clean refusal.
        let before = recovery.effect_checkpoint();
        recovery.begin_public_effect()?;
        let fd = openat(
            dir.as_fd(),
            name,
            OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
            perm_mode(mode & 0o777),
        )
        .map_err(|errno| {
            recovery.effect_refused(before, errno);
            FileError::errno(errno)
        })?;
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
            ops.hook.step(Step::Created)?;
            // On failure the guard captures and disposes the created file by its
            // held identity: its bytes were never acknowledged, and disposal
            // never fsyncs the failed inode again.
            file.write_all(content)?;
            file.sync_all()?;
            fsync(dir.as_fd()).map_err(FileError::errno)?;
            Ok(Stat::from_metadata(&file.metadata()?))
        })();
        if finish.is_ok() {
            guard.armed = false;
        }
        drop(file); // only the Held proof may remain at the cleanup unlink
        if !guard.cleanup(ops) {
            return Err(guard.recovery.uncertain());
        }
        finish
    })();
    let recovered = recovery.finish();
    match result {
        // The created file and its directory entry were synced before success:
        // a later cleanup barrier failure only leaves reported residue.
        Ok(stat) => Ok((stat, recovered)),
        Err(_) if !recovery.settled() => Err(recovery.uncertain()),
        Err(error) => Err(error),
    }
}
