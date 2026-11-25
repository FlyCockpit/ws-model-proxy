//! Settling R: disposing proven objects (and the private link aliases) by
//! their held identity, then finishing the operation, which removes or reports
//! what is left.

use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::os::fd::AsFd;
use std::os::unix::fs::OpenOptionsExt;

use nix::errno::Errno;
use nix::fcntl::AtFlags;
use nix::sys::stat::fstatat;
use nix::unistd::{UnlinkatFlags, unlinkat};
use serde_json::json;

use super::{Held, MAX_REPORTED, RecoveryDir, Slot, unlink_cleanup_lock};
use crate::services::file_ops::Step;
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::journal::exchange::{Primitive, link_count, run};
use crate::services::file_ops::meta::Stat;

impl RecoveryDir {
    pub(in crate::services::file_ops) fn dispose(
        &mut self,
        ops: &OpContext,
        slot: &Slot,
        held: &mut Held,
    ) -> bool {
        self.dispose_inner(ops, slot, held, false)
    }

    pub(super) fn dispose_alias(&mut self, ops: &OpContext, slot: &Slot, held: &mut Held) -> bool {
        self.dispose_inner(ops, slot, held, true)
    }

    fn dispose_inner(
        &mut self,
        ops: &OpContext,
        slot: &Slot,
        held: &mut Held,
        alias: bool,
    ) -> bool {
        let proven = self.prepare_dispose(ops, slot, held, alias);
        held.release();
        proven && self.unlink_proven(slot)
    }

    /// On noino S and D can be hard links with different presented inode numbers.
    /// Prove both private names first, then close BOTH descriptors before either
    /// unlink. No snapshot or reopened successor can authorize D's disposal.
    ///
    /// D goes first, and S's link count is read AFTER it: when D is a second name of
    /// S's own object, the count before D's unlink still included the name this
    /// batch deletes, so a public name already replaced by a racer would leave S's
    /// alias looking like it has a surviving link and both private names would go
    /// (C1A-1). The count is read by name (no descriptor stays open on the object).
    pub(super) fn dispose_link_move(
        &mut self,
        ops: &OpContext,
        source: &Slot,
        src: &mut Held,
        destination: &Slot,
        dst: &mut Held,
    ) {
        let dispose_destination = self.prepare_dispose(ops, destination, dst, false);
        let dispose_source = self.prepare_dispose(ops, source, src, false);
        src.release();
        dst.release(); // H12: close the possible alias peer before any unlink
        if dispose_destination {
            self.unlink_proven(destination);
        }
        if dispose_source {
            // The guard is a veto on a believable count only (Linux: forced-sync).
            // An unreadable count under a believable mount keeps the alias.
            let survives = self.counts_reliable != Some(true)
                || self
                    .non_anchor_link_count(source)
                    .is_ok_and(|count| count >= 2);
            if survives {
                self.unlink_proven(source);
            } else {
                // The public name is gone (or the count is unknown): this alias
                // may be the object's last name. Keep and report it.
                self.unsettled = true;
            }
        }
    }

    fn prepare_dispose(&mut self, ops: &OpContext, slot: &Slot, held: &Held, alias: bool) -> bool {
        if self.durability_failed {
            return false;
        }
        // The seam is before the ownership check. Public-name successors must
        // already have been captured; tests must not simulate private exclusion.
        let _ = ops.hook.step(Step::Disposing);
        if !self.holds(slot, held) {
            self.unsettled = true;
            return false;
        }
        // An exposed alias must not be its object's last name: veto the unlink on a
        // believable count below 2 (see `calibrate_counts`; best effort, never a proof).
        if alias
            && self.counts_reliable == Some(true)
            && !self
                .non_anchor_link_count(slot)
                .is_ok_and(|count| count >= 2)
        {
            self.unsettled = true;
            return false;
        }
        true
    }

    fn non_anchor_link_count(&self, slot: &Slot) -> Result<u64, Errno> {
        let raw = fstatat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )?;
        let stat = Stat::from_raw(&raw);
        let own = self
            .anchors
            .iter()
            .filter(|(_, held)| held.live_stat().is_some_and(|pin| pin.same_object(&stat)))
            .count() as u64;
        link_count(self.dir.as_fd(), slot.name.as_os_str()).map(|count| count.saturating_sub(own))
    }

    /// The caller has proved this private name and released every possible peer.
    fn unlink_proven(&mut self, slot: &Slot) -> bool {
        // A durable anchor is a name, not an fd that may sillyrename the
        // candidate on NFS. Close our anchor peers for this inode too. The
        // protected hardlink remains throughout, so its inode cannot recycle.
        let candidate = fstatat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .ok()
        .map(|raw| Stat::from_raw(&raw));
        let mut released = Vec::new();
        for (index, (_, held)) in self.anchors.iter_mut().enumerate() {
            if candidate.is_some_and(|candidate| {
                held.live_stat()
                    .is_some_and(|pin| pin.same_object(&candidate))
            }) {
                held.release();
                released.push(index);
            }
        }
        let result = run(Primitive::Unlink, || {
            unlinkat(
                self.dir.as_fd(),
                slot.name.as_os_str(),
                UnlinkatFlags::NoRemoveDir,
            )
        });
        for index in released {
            let (name, held) = &mut self.anchors[index];
            // The anchor was not unlinked, and its randomized private name is
            // protected by the same integrity boundary as INTENT. Re-opening
            // never adopts a mismatching occupant or an unheld proof.
            match Held::open(&self.dir, OsStr::new(name), held.stat()) {
                Ok(reopened) if reopened.is_held() => *held = reopened,
                _ => self.unsettled = true,
            }
        }
        match result {
            Ok(()) => {
                // The slot name is gone: never report it. A failed barrier
                // keeps R itself (pins and INTENT) as the residue to report.
                self.kept.retain(|p| *p != self.path.join(&slot.name));
                if self.sync_effect(&[]).is_err() {
                    let path = self.path.clone();
                    self.remember(path);
                    return false;
                }
                true
            }
            Err(_) => {
                self.unsettled = true;
                false
            }
        }
    }

    /// Explicit end of the lifecycle. ENOTEMPTY and every other rmdir failure
    /// retain the directory. An already unsettled operation also retains even
    /// an empty directory so its recovery location stays discoverable. A
    /// captured/restored object is never auto-cleaned.
    /// Release an R that was journaled for a direct move the filesystem
    /// refused without effect, before a fallback allocates its own R.
    pub(in crate::services::file_ops) fn close_unused(&mut self) -> FileResult<()> {
        let _ = self.finish();
        if self.pre_effect_abort.is_some() || !self.settled() {
            return Err(self.uncertain());
        }
        Ok(())
    }

    pub(in crate::services::file_ops) fn finish(&mut self) -> Vec<String> {
        if !self.finished {
            self.finished = true;
            if !self.durability_failed && self.sync_effect(&[]).is_err() {
                self.unsettled = true;
            }
            let cleanup_intent = self.intent.clone();
            if self.settled() {
                // All candidate effects are finished. Prove every anchor with
                // its original live descriptor, then close every peer before
                // unlink (including NFS clients with per-vnode sillyrenames).
                let mut proven = Vec::new();
                for (name, held) in &self.anchors {
                    if self.holds_name(&self.dir, OsStr::new(name), held) {
                        proven.push(name.clone());
                    } else {
                        self.unsettled = true;
                    }
                }
                self.anchors.clear();
                for name in proven {
                    if unlinkat(self.dir.as_fd(), name.as_str(), UnlinkatFlags::NoRemoveDir)
                        .is_err()
                    {
                        self.unsettled = true;
                    }
                }
                if self.sync_effect(&[]).is_err() {
                    self.unsettled = true;
                }
            }
            // Keep metadata for unresolved slots and foreign entries, including
            // hidden NFS leftovers. Hold the lock through cleanup.
            if self.settled() {
                match self
                    .dir
                    .try_clone()
                    .ok()
                    .and_then(|fd| nix::dir::Dir::from_fd(fd).ok())
                {
                    Some(mut entries) => {
                        for entry in entries.iter() {
                            let Ok(entry) = entry else {
                                self.unsettled = true;
                                break;
                            };
                            let name = entry.file_name().to_bytes();
                            if !matches!(
                                name,
                                b"." | b".." | b"INTENT" | b"INTENT.new" | b".wsmp-lock"
                            ) {
                                self.unsettled = true;
                                break;
                            }
                        }
                    }
                    None => self.unsettled = true,
                }
            }
            // Success and clean refusals drop the crash map with R only when R
            // is actually empty. An unsettled operation, or a captured slot
            // still in `kept`, keeps INTENT.
            if self.settled() && self.cleanup_lock.is_none() {
                // Unsupported locks cannot protect the handoff away from the
                // internal inode. Keep discoverable metadata rather than race.
                self.unsettled = true;
            }
            if self.settled() {
                // Close the lock fd before unlink: NFS otherwise creates a
                // silly-rename which itself prevents removing R. The owner
                // pid remains live while this final empty cleanup runs.
                self.lock = None;
                self.discard_intent();
                match unlinkat(self.dir.as_fd(), ".wsmp-lock", UnlinkatFlags::NoRemoveDir) {
                    Ok(()) | Err(Errno::ENOENT) => {}
                    Err(_) => self.unsettled = true,
                }
                if self.sync_effect(&[]).is_err() {
                    self.unsettled = true;
                }
            }
            if self.unsettled
                || run(Primitive::Rmdir, || {
                    unlinkat(
                        self.parent.as_fd(),
                        self.name.as_os_str(),
                        UnlinkatFlags::RemoveDir,
                    )
                })
                .is_err()
            {
                self.unsettled = true;
                // A refused/failed rmdir must not strand an otherwise empty
                // directory after its metadata was removed.
                if self.intent.is_none()
                    && let Some(intent) = cleanup_intent
                {
                    if self.persist_intent(&intent).is_ok() {
                        self.registered = crate::services::file_ops::journal::registry::register(
                            &self.path, &intent,
                        )
                        .is_ok();
                    }
                    self.intent = Some(intent);
                }
                let _ = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .mode(0o600)
                    .custom_flags(nix::libc::O_NOFOLLOW)
                    .open(self.path.join(".wsmp-lock"));
                // Include the directory itself (also discovers externally added slots).
                if self.kept.is_empty() {
                    self.remember(self.path.clone());
                }
            } else if self.registered {
                crate::services::file_ops::journal::registry::unregister(&self.path);
                self.registered = false;
            }
            // R and its evidence are already gone. A lost rmdir can at most
            // resurrect an empty R, which is harmless; it grants no authority
            // and cannot make the operation's outcome uncertain.
            if !self.unsettled
                && (self.effect_started || self.pre_effect_abort.is_none())
                && let Err(errno) = nix::unistd::fsync(self.parent.as_fd())
            {
                tracing::warn!(recovery = %self.path.display(), %errno, "recovery parent sync failed after rmdir; an empty recovery directory may reappear");
            }
            if !self.unsettled {
                let lock_name = format!(".wsmp-lock-{}", self.name.to_string_lossy());
                unlink_cleanup_lock(
                    &self.parent,
                    OsStr::new(&lock_name),
                    self.cleanup_lock.as_ref(),
                );
                self.cleanup_lock = None;
            }
            if self.unsettled || !self.kept.is_empty() {
                tracing::warn!(recovery = %self.path.display(), kept = ?self.kept, "file recovery retained; manual recovery required");
            }
            self.lock = None;
        }
        // The wire schema bounds the list (`recovered` <= 4); the warning above
        // names every retained path, so nothing is lost by the clamp.
        self.kept
            .iter()
            .take(MAX_REPORTED)
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    pub(in crate::services::file_ops) fn uncertain(&mut self) -> FileError {
        // Nothing public changed: once R is cleanly gone the failure is certain.
        if !self.effect_started
            && let Some(error) = self.pre_effect_abort.clone()
        {
            let kept = self.finish();
            if self.settled() && kept.is_empty() {
                return error;
            }
        }
        self.unsettled = true;
        let kept = self.finish();
        FileError::new(
            ErrorCode::UncertainOutcome,
            "file outcome is uncertain; inspect recovery",
        )
        .with_detail(json!({ "recovery": self.path.to_string_lossy(), "kept": kept }))
    }

    pub(in crate::services::file_ops) fn settled(&self) -> bool {
        !self.durability_failed && !self.unsettled && self.kept.is_empty()
    }
}
