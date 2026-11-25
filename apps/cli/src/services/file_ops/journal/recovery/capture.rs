//! Capture and restore: moving a public object into a slot of R with its
//! recorded origin, undoing a capture that changed nothing, the identity checks
//! that let a slot go back, and the non-overwriting restore.

use std::ffi::{OsStr, OsString};
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, renameat};
use nix::sys::stat::fstatat;
use nix::unistd::linkat;

use super::{Checkpoint, Held, Origin, RecoveryDir, Slot};
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{FileError, FileResult};
use crate::services::file_ops::fs::resolve::Resolved;
use crate::services::file_ops::journal::exchange::{Primitive, is_unsupported, no_replace, run};
use crate::services::file_ops::journal::intent::IntentPhase;
use crate::services::file_ops::meta::{Kind, Stat};

impl RecoveryDir {
    /// A previously moved candidate can reclaim its recorded pre-move origin
    /// only with identity evidence. This never authorizes disposal. Overwrite
    /// undo additionally requires holds(), so unheld objects stay at their
    /// captured destination origin.
    #[cfg(test)]
    pub(in crate::services::file_ops) fn reclaim_origin(
        &mut self,
        slot: &mut Slot,
        held: &Held,
        origin: Origin,
    ) -> bool {
        if !self.matches_for_restore(slot, held) {
            return false;
        }
        if let Some(mut intent) = self.intent.clone() {
            let key = slot.name.to_string_lossy().into_owned();
            intent.reclaim_origin(&key, &origin.path);
            if self.save_intent(intent).is_err() {
                return false;
            }
        }
        slot.origin = origin;
        true
    }

    /// Direct-move rejection: establish the SOURCE map before destination
    /// capture. A crash on either side of capture must never restore at DST.
    pub(in crate::services::file_ops) fn capture_moved(
        &mut self,
        to: &Resolved,
        candidate: &Held,
        origin: Origin,
    ) -> Option<Slot> {
        let mut intent = self.intent.clone().unwrap_or_else(|| {
            crate::services::file_ops::journal::intent::Intent::create(&origin.path)
        });
        let (record, anchored_candidate) =
            intent.compensate_move(&origin.path, &candidate.stat())?;
        if !anchored_candidate && self.anchor_at(record, &to.dir, &to.name).is_err() {
            self.unsettled = true;
            return None;
        }
        if self.intent.is_none() {
            if self.prepare_intent(intent).is_err() {
                return None;
            }
        } else if self.save_intent(intent).is_err() {
            return None;
        }
        let mut slot = self.capture(&to.dir, &to.name, &to.full_path())?;
        // Disk already names the source. Live restoration uses the original FD
        // so a renamed source parent does not redirect compensation.
        slot.origin = origin;
        Some(slot)
    }

    pub(in crate::services::file_ops) fn capture(
        &mut self,
        from_dir: &OwnedFd,
        from_name: &OsStr,
        from_path: &Path,
    ) -> Option<Slot> {
        if self.check_durability().is_err() {
            return None;
        }
        if self.intent.is_none()
            && let Err(error) = self.prepare_intent(
                crate::services::file_ops::journal::intent::Intent::create(from_path),
            )
        {
            tracing::warn!(
                recovery = %self.path.display(),
                error = %error,
                "could not write INTENT before capture"
            );
            if self.pre_effect_abort.is_none() {
                self.unsettled = true;
            }
            return None;
        }
        if self.used >= 2 {
            self.unsettled = true;
            self.remember(from_path.to_path_buf());
            return None;
        }
        self.used += 1;
        let origin = match Origin::new(from_dir, from_name, from_path) {
            Ok(origin) => origin,
            Err(_) => {
                self.unsettled = true;
                self.remember(from_path.to_path_buf());
                return None;
            }
        };
        let slot = Slot {
            name: OsString::from(format!("slot-{}", self.used)),
            origin,
        };
        let captured_phase = self
            .intent
            .as_ref()
            .map(|intent| intent.phase)
            .unwrap_or(IntentPhase::Prepared);
        // Dynamic compensation slots need a map too, before their public name
        // can move. Preserve planned origins (exchange D is captured at S).
        // A durable commit stays authoritative: a post-commit capture only
        // collects leftovers to dispose, never restoration authority.
        if let Some(mut intent) = self.intent.clone() {
            let key = slot.name.to_string_lossy().into_owned();
            intent.plan_capture(key, from_path, |name| self.slot_absent(name));
            if self.save_intent(intent).is_err() {
                self.used -= 1;
                return None;
            }
        }
        if self.begin_public_effect().is_err() {
            self.used -= 1;
            return None;
        }
        let captured = no_replace(
            from_dir.as_fd(),
            from_name,
            self.dir.as_fd(),
            &slot.name,
            Primitive::Capture,
        )
        .or_else(|errno| {
            if is_unsupported(errno) {
                // Fresh, absent slot inside our private directory. A squatter
                // arriving after this check is the documented window (a2).
                match fstatat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                ) {
                    Err(Errno::ENOENT) => renameat(
                        from_dir.as_fd(),
                        from_name,
                        self.dir.as_fd(),
                        slot.name.as_os_str(),
                    ),
                    Ok(_) => Err(Errno::EEXIST),
                    Err(error) => Err(error),
                }
            } else {
                Err(errno)
            }
        });
        match captured {
            Ok(()) => {
                self.remember(self.path.join(&slot.name));
                // No data barrier: a captured user object's bytes are unchanged
                // (and may be unreadable, e.g. mode 000), and CLI-written files
                // were synced before publication. Never refsync a failed inode.
                if self.sync_effect(&[from_dir]).is_err()
                    || self.record_slot_identity(&slot).is_err()
                    || self.set_intent_phase(captured_phase).is_err()
                {
                    return None;
                }
                Some(slot)
            }
            Err(errno) => {
                self.last_errno = Some(errno);
                self.unsettled = true;
                // An after-effect reply may leave the public origin vacant.
                // Report only names that still exist, alongside the actual slot.
                self.record_public(from_dir, from_name, from_path);
                // A competing entry at the private slot caused EEXIST: keep and
                // report it too. A slot observed occupied is never replaced.
                if fstatat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .is_ok()
                {
                    self.remember(self.path.join(&slot.name));
                    if self.record_slot_identity(&slot).is_err() {
                        self.durability_failed = true;
                        self.unsettled = true;
                    }
                }
                None
            }
        }
    }

    pub(in crate::services::file_ops) fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            used: self.used,
            kept: self.kept.len(),
            unsettled: self.unsettled,
            phase: self.intent.as_ref().map(|intent| intent.phase),
            effect_started: self.effect_started,
        }
    }

    /// The capture that just failed moved nothing when its errno says the rename
    /// was refused before it ran (a failed rename is atomic): forget it and hand
    /// back the errno so the caller can report an ordinary error with nothing to
    /// recover. Anything else (EIO and timeouts may follow a rename that took
    /// effect, an occupied private slot, the two-object cap) stays unsettled.
    pub(in crate::services::file_ops) fn abort_capture(
        &mut self,
        mark: Checkpoint,
    ) -> Option<Errno> {
        let errno = self.last_errno.take()?;
        // An occupied private slot contradicts "moved nothing" (an NFS
        // retransmit can report ENOENT after the capture took effect).
        if !self.slot_absent(&format!("slot-{}", mark.used + 1)) {
            return None;
        }
        if !matches!(
            errno,
            Errno::ENOENT
                | Errno::EXDEV
                | Errno::EACCES
                | Errno::EPERM
                | Errno::EROFS
                | Errno::ENOTDIR
                | Errno::EISDIR
                | Errno::ENOSPC
                | Errno::EDQUOT
                | Errno::ELOOP
                | Errno::ENAMETOOLONG
                | Errno::EBUSY
        ) {
            return None;
        }
        self.used = mark.used;
        // The refused rename moved nothing: no public effect started here.
        self.effect_started = mark.effect_started;
        if self
            .set_intent_phase(mark.phase.unwrap_or(IntentPhase::Prepared))
            .is_err()
        {
            return None;
        }
        self.kept.truncate(mark.kept);
        self.unsettled = mark.unsettled;
        Some(errno)
    }

    /// Keep a slot's object where it is and report it (its origin is unproven).
    pub(in crate::services::file_ops) fn keep(&mut self, slot: &Slot) {
        self.unsettled = true;
        self.remember(self.path.join(&slot.name));
    }

    pub(in crate::services::file_ops) fn path(&self) -> &Path {
        &self.path
    }

    pub(in crate::services::file_ops) fn record_public(
        &mut self,
        dir: &OwnedFd,
        name: &OsStr,
        path: &Path,
    ) {
        if fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW).is_ok() {
            self.remember(path.to_path_buf());
        }
    }

    pub(in crate::services::file_ops) fn matches_for_restore(
        &self,
        slot: &Slot,
        held: &Held,
    ) -> bool {
        fstatat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .is_ok_and(|raw| held.matches_for_restore(&Stat::from_raw(&raw)))
    }

    pub(in crate::services::file_ops) fn restore(&mut self, ops: &OpContext, slot: &Slot) -> bool {
        if self.begin_public_effect().is_err() {
            return false;
        }
        if self
            .intent
            .as_ref()
            .is_some_and(|intent| intent.phase != IntentPhase::Committed)
            && self.set_intent_phase(IntentPhase::Compensating).is_err()
        {
            return false;
        }
        let Origin {
            dir,
            name,
            path: public_path,
        } = &slot.origin;
        let restored = no_replace(
            self.dir.as_fd(),
            &slot.name,
            dir.as_fd(),
            name,
            Primitive::Restore,
        );
        if restored.is_err_and(is_unsupported) {
            // Public names must remain EEXIST-safe. Hold the actual slot before
            // linking it, then use the sole disposal primitive for its unlink.
            let linked = (|| -> FileResult<bool> {
                let raw = fstatat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .map_err(FileError::errno)?;
                let stat = Stat::from_raw(&raw);
                if stat.kind() == Kind::Dir {
                    return Ok(false);
                }
                let mut held = Held::open(&self.dir, &slot.name, stat)?;
                run(Primitive::RestoreLink, || {
                    linkat(
                        self.dir.as_fd(),
                        slot.name.as_os_str(),
                        dir.as_fd(),
                        name.as_os_str(),
                        AtFlags::empty(),
                    )
                })
                .map_err(FileError::errno)?;
                self.sync_effect(&[dir])?;
                Ok(self.dispose_alias(ops, slot, &mut held))
            })();
            if matches!(linked, Ok(true)) {
                return true;
            }
            self.unsettled = true;
            self.record_public(dir, name, public_path);
            return false;
        }
        match restored {
            Ok(()) => {
                if self.sync_effect(&[dir]).is_err() {
                    self.record_public(dir, name, public_path);
                    return false;
                }
                self.kept.retain(|p| *p != self.path.join(&slot.name));
                true
            }
            Err(_) => {
                self.unsettled = true;
                if matches!(
                    fstatat(
                        self.dir.as_fd(),
                        slot.name.as_os_str(),
                        AtFlags::AT_SYMLINK_NOFOLLOW
                    ),
                    Err(Errno::ENOENT)
                ) {
                    self.kept.retain(|p| *p != self.path.join(&slot.name));
                }
                self.record_public(dir, name, public_path);
                false
            }
        }
    }
}
