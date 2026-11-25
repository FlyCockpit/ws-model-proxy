//! The INTENT record and the durability fence: phase and identity updates,
//! the fresh-inode INTENT writes and directory syncs, and the barrier that
//! decides whether a public effect may start or an outcome can be
//! acknowledged.

use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat, renameat};
use nix::sys::stat::{Mode, fstatat};
use nix::unistd::{UnlinkatFlags, unlinkat};

use super::{RecoveryDir, Slot, refused_without_effect, tolerate_dir_fsync};
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::fs::exchange::barrier_error;
use crate::services::file_ops::fs::meta::Stat;
use crate::services::file_ops::journal::intent::{Intent, IntentPhase};

impl RecoveryDir {
    pub(in crate::services::file_ops) fn set_intent_phase(
        &mut self,
        phase: IntentPhase,
    ) -> FileResult<()> {
        self.check_durability()?;
        let Some(intent) = self.intent.as_ref().map(|intent| intent.at_phase(phase)) else {
            return Ok(());
        };
        self.save_intent(intent)
    }

    pub(in crate::services::file_ops) fn record_slot_identity(
        &mut self,
        slot: &Slot,
    ) -> FileResult<()> {
        self.check_durability()?;
        let Some(mut intent) = self.intent.clone() else {
            return Ok(());
        };
        let key = slot.name.to_string_lossy().into_owned();
        let raw = fstatat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .map_err(FileError::errno)?;
        let stat = Stat::from_raw(&raw);
        intent.record_slot(key, &stat, &slot.origin.path, |name| self.slot_absent(name));
        self.save_intent(intent)
    }

    pub(super) fn slot_absent(&self, name: &str) -> bool {
        matches!(
            fstatat(self.dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW),
            Err(Errno::ENOENT)
        )
    }

    pub(super) fn check_durability(&self) -> FileResult<()> {
        if self.durability_failed {
            Err(FileError::mutation_uncertain())
        } else if let Some(error) = &self.pre_effect_abort {
            Err(error.clone())
        } else {
            Ok(())
        }
    }

    /// Classify a failed persistence or barrier. After a public effect it is
    /// fatal and retains R. Before one, nothing public changed: stop the
    /// operation, but keep R's private entries disposable so cleanup can remove
    /// the pins and R and report a certain error.
    pub(super) fn barrier_failed(&mut self, error: FileError) -> FileError {
        if self.effect_started {
            self.durability_failed = true;
            self.unsettled = true;
        } else if self.pre_effect_abort.is_none() {
            tracing::warn!(recovery = %self.path.display(), error = %error.message,
                "durability barrier failed before any public change; refusing cleanly");
            self.pre_effect_abort = Some(error.clone());
        }
        error
    }

    /// The next syscall may change a public name. Refused after any failure.
    pub(in crate::services::file_ops) fn begin_public_effect(&mut self) -> FileResult<()> {
        self.check_durability()?;
        self.effect_started = true;
        Ok(())
    }

    /// Whether a public effect may have started; pair with `effect_refused`.
    pub(in crate::services::file_ops) fn effect_checkpoint(&self) -> bool {
        self.effect_started
    }

    /// The public syscall started after `before` failed with an errno that
    /// proves nothing moved (a refused rename/link/O_EXCL create is atomic):
    /// return to the prior effect state. Ambiguous replies (EIO, timeouts,
    /// and ENOENT, which an NFS retransmit can return after success) keep it.
    pub(in crate::services::file_ops) fn effect_refused(&mut self, before: bool, errno: Errno) {
        if !before && refused_without_effect(errno) {
            self.effect_started = false;
        }
    }

    /// A barrier failed after the durable `committed` record (a failure
    /// before it would have refused the record itself). Identity or ownership
    /// failures (strangers kept in R) are not barrier failures.
    pub(in crate::services::file_ops) fn committed_barrier_failed(&self) -> bool {
        self.committed && self.durability_failed
    }

    /// Whether a successful result may be acknowledged. A barrier failure after
    /// the durable `committed` INTENT only leaves recoverable residue.
    pub(in crate::services::file_ops) fn acknowledges_success(&self) -> bool {
        !self.durability_failed || self.committed
    }

    /// Each attempt writes a fresh inode. Never retry fsync on an inode whose
    /// writeback failed: Linux may already have cleaned its dirty pages.
    pub(super) fn save_intent(&mut self, intent: Intent) -> FileResult<()> {
        self.check_durability()?;
        let phase = intent.phase;
        match self.persist_intent(&intent) {
            Ok(()) => {
                self.intent = Some(intent);
                if phase == IntentPhase::Committed {
                    self.committed = true;
                }
                Ok(())
            }
            Err(error) => Err(self.barrier_failed(error)),
        }
    }

    /// Public entries become durable before private evidence may be removed.
    ///
    /// Before any public effect the only callers are private cleanups (probe
    /// dummies, a refused temp, final R removal). Their durability grants no
    /// authority: a failure there aborts the operation, and later private
    /// cleanup proceeds without barriers.
    pub(in crate::services::file_ops) fn sync_effect(
        &mut self,
        parents: &[&OwnedFd],
    ) -> FileResult<()> {
        if !self.effect_started && self.pre_effect_abort.is_some() {
            return Ok(());
        }
        self.check_durability()?;
        let result = parents
            .iter()
            .try_for_each(|parent| nix::unistd::fsync(parent.as_fd()))
            .and_then(|()| nix::unistd::fsync(self.dir.as_fd()))
            .and_then(|()| nix::unistd::fsync(self.parent.as_fd()));
        if let Err(errno) = result {
            let error = self.barrier_failed(barrier_error(errno));
            if self.effect_started {
                return Err(error);
            }
        }
        Ok(())
    }

    pub(super) fn persist_intent(&self, intent: &Intent) -> FileResult<()> {
        let body = serde_json::to_vec(intent).map_err(|err| {
            FileError::new(ErrorCode::IoError, format!("INTENT serialize: {err}"))
        })?;
        let tmp_name = "INTENT.new";
        match unlinkat(self.dir.as_fd(), tmp_name, UnlinkatFlags::NoRemoveDir) {
            Ok(()) | Err(Errno::ENOENT) => {}
            Err(errno) => return Err(FileError::errno(errno)),
        }
        let fd = openat(
            self.dir.as_fd(),
            tmp_name,
            OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_WRONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )
        .map_err(FileError::errno)?;
        let mut file = std::fs::File::from(fd);
        file.write_all(&body)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        renameat(self.dir.as_fd(), tmp_name, self.dir.as_fd(), "INTENT")
            .map_err(FileError::errno)?;
        self.fsync_dir_best_effort()
    }

    fn fsync_dir_best_effort(&self) -> FileResult<()> {
        tolerate_dir_fsync(nix::unistd::fsync(self.dir.as_fd()), &self.path)
    }

    pub(super) fn discard_intent(&mut self) {
        match unlinkat(self.dir.as_fd(), "INTENT", UnlinkatFlags::NoRemoveDir) {
            Ok(()) | Err(Errno::ENOENT) => {}
            Err(_) => self.unsettled = true,
        }
        let _ = unlinkat(self.dir.as_fd(), "INTENT.new", UnlinkatFlags::NoRemoveDir);
        if self.registered {
            crate::services::file_ops::journal::registry::unregister(&self.path);
            self.registered = false;
        }
        self.intent = None;
    }
}
