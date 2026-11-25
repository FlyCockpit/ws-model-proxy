//! Publication: putting a private object into its vacant public name with the
//! selected no-overwrite primitive, the exchange-less replace, and the rename
//! commit in its exchange, link-first and vacate-first orders.

use std::os::fd::AsFd;

use nix::errno::Errno;
use nix::fcntl::AtFlags;
use nix::sys::stat::fstatat;
use nix::unistd::linkat;

use super::{Held, LinkOrder, Origin, PublishMethod, Published, RecoveryDir, Slot};
use crate::file_ops::context::OpContext;
use crate::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::file_ops::fs::exchange::{
    Primitive, fault, is_link_unsupported, is_unsupported, no_replace, run,
};
use crate::file_ops::fs::resolve::Resolved;
use crate::file_ops::journal::intent::{IntentOrder, IntentPhase};
use crate::file_ops::{Cancel, Step};

impl RecoveryDir {
    pub(super) fn publish_slot(
        &self,
        slot: &Slot,
        target: &Origin,
        method: PublishMethod,
    ) -> Result<(), Errno> {
        match method {
            PublishMethod::NoReplace => no_replace(
                self.dir.as_fd(),
                &slot.name,
                target.dir.as_fd(),
                &target.name,
                Primitive::Publish,
            ),
            PublishMethod::Link => run(Primitive::PublishLink, || {
                linkat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    target.dir.as_fd(),
                    target.name.as_os_str(),
                    AtFlags::empty(),
                )
            }),
        }
    }

    /// Exactly one ownership policy for every non-commit exit. Source origin
    /// never changes to the publication target. Failed restoration only keeps.
    fn abort_published(
        &mut self,
        ops: &OpContext,
        slot: &Slot,
        held: &mut Held,
        published: &Published<'_>,
    ) {
        if self
            .intent
            .as_ref()
            .is_some_and(|intent| intent.phase != IntentPhase::Committed)
            && self.set_intent_phase(IntentPhase::Compensating).is_err()
        {
            return;
        }
        match published {
            Published::Temp => {
                self.dispose(ops, slot, held);
            }
            Published::UserSource { origin, .. } => {
                debug_assert_eq!(slot.origin.path, origin.full_path());
                held.release(); // unconditional, even after failed observation
                if self.restore(ops, slot) {
                    let _ = ops.hook.step(Step::Restored);
                }
            }
        }
    }

    /// Shared exchange-less publisher: replace owns disposable T; rename owns
    /// non-disposable S already captured by commit_move. No duplicated ladder.
    #[allow(clippy::too_many_arguments)]
    pub(in crate::file_ops) fn publish_without_exchange(
        &mut self,
        ops: &OpContext,
        tmp: &mut Slot,
        mut original: Option<&mut Held>,
        identity: &mut Held,
        cancel: &Cancel,
        published: Published<'_>,
    ) -> FileResult<bool> {
        let prepared = (|| {
            fault(Primitive::PublishPrepare).map_err(FileError::errno)?;
            let (target, method) = match &published {
                Published::Temp => {
                    let method = self.probe_publish(ops, tmp, identity)?;
                    if !self.holds(tmp, identity) {
                        self.keep(tmp);
                        return Err(self.uncertain());
                    }
                    ops.hook.step(Step::Vacating)?;
                    cancel.check()?;
                    (
                        Origin::new(&tmp.origin.dir, &tmp.origin.name, &tmp.origin.path),
                        method,
                    )
                }
                Published::UserSource { target, method, .. } => (
                    Origin::new(&target.dir, &target.name, &target.full_path()),
                    *method,
                ),
            };
            Ok((target.map_err(FileError::errno)?, method))
        })();
        let (target, method) = match prepared {
            Ok(value) => value,
            Err(error) => {
                if error.code != ErrorCode::UncertainOutcome {
                    if matches!(published, Published::UserSource { .. })
                        && let Some(held) = original.as_mut()
                    {
                        // The destination's proof may be a second name of the source's own
                        // object (noino alias pair): close it before the restore unlink (F3).
                        held.release();
                    }
                    self.abort_published(ops, tmp, identity, &published); // D1 site 1
                }
                return Err(error);
            }
        };
        let captured = if original.is_some() {
            if matches!(published, Published::UserSource { .. }) {
                let _ = ops.hook.step(Step::DestinationVacating);
            }
            let mark = self.checkpoint();
            let Some(slot) = self.capture(&target.dir, &target.name, &target.path) else {
                let errno = self.abort_capture(mark);
                if let Some(held) = original.as_mut() {
                    held.release();
                }
                self.abort_published(ops, tmp, identity, &published); // D1 site 2
                return Err(match errno {
                    Some(Errno::ENOENT) => FileError::conflict("gone"),
                    Some(errno) => FileError::errno(errno),
                    None => self.uncertain(),
                });
            };
            if let Some(held) = original.as_mut()
                && !self.holds(&slot, held)
            {
                held.release();
                // Both proofs close before restore opens an own-name alias proof:
                // noino can hide a real S/D hard-link pair.
                if matches!(published, Published::UserSource { .. }) {
                    identity.release();
                }
                if self.restore(ops, &slot) {
                    let _ = ops.hook.step(Step::Restored);
                }
                self.abort_published(ops, tmp, identity, &published); // D1 site 3
                return Err(if self.settled() {
                    FileError::conflict("replaced")
                } else {
                    self.uncertain()
                });
            }
            Some(slot)
        } else {
            None
        };
        if let Some(slot) = &captured {
            self.record_slot_identity(slot)?;
            self.set_intent_phase(IntentPhase::Captured)?;
        }
        let _ = ops.hook.step(if matches!(published, Published::Temp) {
            Step::Vacated
        } else {
            Step::DestinationVacated
        });
        let _ = ops.hook.step(Step::Publishing);
        if !self.holds(tmp, identity) {
            if let Some(held) = original.as_mut() {
                held.release();
            }
            if matches!(published, Published::UserSource { .. }) {
                identity.release();
            }
            if let Some(slot) = &captured {
                self.restore(ops, slot);
            }
            self.abort_published(ops, tmp, identity, &published);
            return Err(if self.settled() {
                FileError::conflict("replaced")
            } else {
                self.uncertain()
            });
        }
        self.set_intent_phase(IntentPhase::Publishing)?;
        self.begin_public_effect()?;
        let result = self.publish_slot(tmp, &target, method);
        // Rename link errors have no cross-name proof on noino; only a transferred
        // NR dentry can reconcile a lost reply. Replacement retains its protocol.
        let committed = result.is_ok()
            || (matches!(method, PublishMethod::NoReplace) || matches!(published, Published::Temp))
                && self.holds_name(&target.dir, &target.name, identity);
        if committed {
            self.sync_effect(&[&target.dir])?;
            self.set_intent_phase(IntentPhase::Committed)?;
            if matches!(published, Published::UserSource { .. }) {
                let _ = ops.hook.step(Step::Renamed);
                if matches!(method, PublishMethod::Link) {
                    let _ = ops.hook.step(Step::Linked);
                }
            }
            // Release D even when it aliases S under another presented inode.
            // Its disposal opens no replacement proof: release S before D unlink.
            match method {
                PublishMethod::NoReplace => {
                    self.kept.retain(|p| *p != self.path.join(&tmp.name));
                    identity.release();
                }
                PublishMethod::Link => {
                    if matches!(published, Published::UserSource { .. })
                        && let (Some(slot), Some(held)) = (&captured, original.as_mut())
                    {
                        self.dispose_link_move(ops, tmp, identity, slot, held);
                        return Ok(true);
                    }
                    self.dispose_alias(ops, tmp, identity);
                    identity.release();
                }
            }
            if let (Some(slot), Some(held)) = (&captured, original) {
                self.dispose(ops, slot, held);
            }
            return Ok(matches!(method, PublishMethod::Link));
        }
        if result == Err(Errno::EEXIST)
            || (matches!(published, Published::UserSource { .. })
                && matches!(method, PublishMethod::Link)
                && !matches!(
                    fstatat(
                        target.dir.as_fd(),
                        target.name.as_os_str(),
                        AtFlags::AT_SYMLINK_NOFOLLOW
                    ),
                    Err(Errno::ENOENT)
                ))
        {
            if let Some(slot) = &captured {
                self.keep(slot);
            }
            if let Some(held) = original {
                held.release();
            }
            // A definite collision stays a plain exists error. Any other reply
            // can mean the link landed: name that public path and keep recovery.
            if result != Err(Errno::EEXIST) {
                self.record_public(&target.dir, &target.name, &target.path);
                self.unsettled = true;
            }
            self.abort_published(ops, tmp, identity, &published); // D1 site 4
            if captured.is_none() && self.settled() && result == Err(Errno::EEXIST) {
                return Err(FileError::errno(Errno::EEXIST));
            }
            return Err(self.uncertain());
        }
        if let Some(held) = original {
            held.release();
        }
        if matches!(published, Published::UserSource { .. }) {
            identity.release();
        }
        if let Some(slot) = &captured
            && self.restore(ops, slot)
        {
            let _ = ops.hook.step(Step::Restored);
        }
        // Temp still needs its creation proof for disposal. It was released above
        // only on user-source compensation, where no deletion is authorized.
        self.abort_published(ops, tmp, identity, &published); // D1 site 5
        let errno = result.err().unwrap_or(Errno::EIO);
        Err(
            if match method {
                PublishMethod::NoReplace => is_unsupported(errno),
                PublishMethod::Link => is_link_unsupported(errno),
            } {
                FileError::unsafe_filesystem()
            } else {
                FileError::errno(errno)
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::file_ops) fn commit_move(
        &mut self,
        ops: &OpContext,
        from: &Resolved,
        to: &Resolved,
        src: &mut Held,
        dst: Option<&mut Held>,
        method: Option<PublishMethod>,
        cancel: &Cancel,
    ) -> FileResult<bool> {
        if matches!(method, Some(PublishMethod::Link))
            && self.link_order == Some(LinkOrder::LinkFirst)
        {
            return self.commit_link_first(ops, from, to, src, dst, cancel);
        }
        let order = if method.is_none() {
            IntentOrder::ExchangeFirst
        } else if self.link_order == Some(LinkOrder::LinkFirst) {
            IntentOrder::LinkFirst
        } else {
            IntentOrder::VacateFirst
        };
        ops.hook.step(Step::Vacating)?;
        cancel.check()?; // last cancellation point, BEFORE the first public mutation
        self.write_rename_intent(order, from, to, dst.is_some(), &src.stat())?;
        tracing::info!(recovery = %self.path().display(), source = %from.full_path().display(),
            destination = %to.full_path().display(), order = ?order,
            "rename capture; manual recovery after a crash");
        if method.is_none() {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if let Some(dst) = dst {
                return self.exchange_move(ops, from, to, src, dst).map(|()| false);
            }
            return Err(self.uncertain());
        }
        let mark = self.checkpoint();
        let Some(mut slot) = self.capture(&from.dir, &from.name, &from.full_path()) else {
            return Err(match self.abort_capture(mark) {
                Some(Errno::ENOENT) => FileError::conflict("gone"),
                Some(errno) => FileError::errno(errno),
                None => self.uncertain(),
            });
        };
        self.record_slot_identity(&slot)?;
        self.set_intent_phase(IntentPhase::Captured)?;
        let _ = ops.hook.step(Step::Captured);
        if !self.holds(&slot, src) {
            src.release();
            if let Some(dst) = dst {
                dst.release();
            }
            if self.restore(ops, &slot) {
                let _ = ops.hook.step(Step::Restored);
            }
            return Err(if self.settled() {
                FileError::conflict("replaced")
            } else {
                self.uncertain()
            });
        }
        let _ = ops.hook.step(Step::Vacated);
        if let Some(method) = method {
            let result = self.publish_without_exchange(
                ops,
                &mut slot,
                dst,
                src,
                cancel,
                Published::UserSource {
                    origin: from,
                    target: to,
                    method,
                },
            );
            return result;
        }
        self.keep(&slot);
        Err(self.uncertain())
    }

    /// Stable-inode link rename. Overwrite captures D only, links the still-public
    /// source onto `to`, then captures S. Plain rename links first and never
    /// vacates S before `to` exists. A lost link reply is a commit when `to`
    /// presents the held source inode.
    #[allow(clippy::too_many_arguments)]
    fn commit_link_first(
        &mut self,
        ops: &OpContext,
        from: &Resolved,
        to: &Resolved,
        src: &mut Held,
        mut dst: Option<&mut Held>,
        cancel: &Cancel,
    ) -> FileResult<bool> {
        fault(Primitive::PublishPrepare).map_err(FileError::errno)?;
        tracing::info!(recovery = %self.path().display(), source = %from.full_path().display(),
            destination = %to.full_path().display(), order = "link-first",
            "rename capture; manual recovery after a crash");
        ops.hook.step(Step::Vacating)?;
        cancel.check()?;
        if !self.holds_name(&from.dir, &from.name, src) {
            return Err(self.conflict_or_uncertain("replaced"));
        }
        self.write_rename_intent(IntentOrder::LinkFirst, from, to, dst.is_some(), &src.stat())?;
        let mut captured_dest = None;
        if dst.is_some() {
            let _ = ops.hook.step(Step::DestinationVacating);
            let mark = self.checkpoint();
            let Some(slot) = self.capture(&to.dir, &to.name, &to.full_path()) else {
                return Err(match self.abort_capture(mark) {
                    Some(Errno::ENOENT) => FileError::conflict("gone"),
                    Some(errno) => FileError::errno(errno),
                    None => self.uncertain(),
                });
            };
            let Some(held) = dst.as_deref_mut() else {
                return Err(self.uncertain());
            };
            let dest_matches = self.holds(&slot, held);
            if !dest_matches {
                self.undo_captured_destination(ops, &Some(slot), src, Some(held));
                return Err(self.conflict_or_uncertain("replaced"));
            }
            // One directory entry under two names: capturing D took S as well.
            let source_went_with_dest =
                !self.holds_name(&from.dir, &from.name, src) && self.holds(&slot, src);
            if source_went_with_dest {
                self.undo_captured_destination(ops, &Some(slot), src, Some(held));
                return Err(self.conflict_or_uncertain("gone"));
            }
            self.record_slot_identity(&slot)?;
            self.set_intent_phase(IntentPhase::Captured)?;
            captured_dest = Some(slot);
        }
        let _ = ops.hook.step(Step::DestinationVacated);
        let _ = ops.hook.step(Step::Publishing);
        if !self.holds_name(&from.dir, &from.name, src) {
            self.undo_captured_destination(ops, &captured_dest, src, dst.as_deref_mut());
            return Err(self.conflict_or_uncertain("replaced"));
        }
        self.set_intent_phase(IntentPhase::Publishing)?;
        let before = self.effect_checkpoint();
        self.begin_public_effect()?;
        let linked = run(Primitive::PublishLink, || {
            linkat(
                from.dir.as_fd(),
                from.name.as_os_str(),
                to.dir.as_fd(),
                to.name.as_os_str(),
                AtFlags::empty(),
            )
        });
        let committed = linked.is_ok() || self.holds_name(&to.dir, &to.name, src);
        if !committed {
            let errno = linked.err().unwrap_or(Errno::EIO);
            self.effect_refused(before, errno);
            self.undo_captured_destination(ops, &captured_dest, src, dst.as_deref_mut());
            if !self.settled() {
                return Err(self.uncertain());
            }
            return Err(if errno == Errno::EEXIST {
                FileError::errno(Errno::EEXIST)
            } else if errno == Errno::EINVAL {
                FileError::invalid("destination name is not valid on this filesystem")
            } else if is_link_unsupported(errno) {
                FileError::unsafe_filesystem()
            } else {
                FileError::errno(errno)
            });
        }
        self.sync_effect(&[&to.dir, &from.dir])?;
        self.set_intent_phase(IntentPhase::Committed)?;
        let _ = ops.hook.step(Step::Linked);
        // `to` holds the source. Capture S before Renamed: a racer that replaces
        // both public names after the link would otherwise orphan the inode.
        if !self.holds_name(&from.dir, &from.name, src) {
            if self.holds_name(&to.dir, &to.name, src) {
                src.release();
                if let (Some(slot), Some(held)) = (&captured_dest, dst.as_deref_mut()) {
                    self.dispose(ops, slot, held);
                }
                return Ok(true);
            }
            if let Some(slot) = &captured_dest {
                self.keep(slot);
            }
            self.unsettled = true;
            return Err(self.uncertain());
        }
        let mark = self.checkpoint();
        let Some(source_slot) = self.capture(&from.dir, &from.name, &from.full_path()) else {
            match self.abort_capture(mark) {
                Some(Errno::ENOENT) if self.holds_name(&to.dir, &to.name, src) => {
                    src.release();
                    if let (Some(slot), Some(held)) = (&captured_dest, dst.as_deref_mut()) {
                        self.dispose(ops, slot, held);
                    }
                    return Ok(true);
                }
                _ => {
                    if let Some(slot) = &captured_dest {
                        self.keep(slot);
                    }
                    self.unsettled = true;
                    return Err(self.uncertain());
                }
            }
        };
        self.record_slot_identity(&source_slot)?;
        let _ = ops.hook.step(Step::Captured);
        let _ = ops.hook.step(Step::Vacated);
        let _ = ops.hook.step(Step::Renamed);
        if !self.holds(&source_slot, src) {
            src.release();
            if self.restore(ops, &source_slot) {
                let _ = ops.hook.step(Step::Restored);
            }
            if let (Some(slot), Some(held)) = (&captured_dest, dst.as_mut()) {
                self.dispose(ops, slot, held);
            }
            return self.ok_if_settled();
        }
        match (&captured_dest, dst.as_mut()) {
            (Some(slot), Some(held)) => {
                self.dispose_link_move(ops, &source_slot, src, slot, held);
            }
            _ => {
                self.dispose_alias(ops, &source_slot, src);
            }
        }
        // The link committed. Residue (last alias, failed cleanup) is `recovered`.
        Ok(true)
    }

    fn conflict_or_uncertain(&mut self, current: &str) -> FileError {
        if self.settled() {
            FileError::conflict(current)
        } else {
            self.uncertain()
        }
    }

    fn ok_if_settled(&mut self) -> FileResult<bool> {
        if self.settled() {
            Ok(true)
        } else {
            Err(self.uncertain())
        }
    }

    fn undo_captured_destination(
        &mut self,
        ops: &OpContext,
        slot: &Option<Slot>,
        src: &mut Held,
        dst: Option<&mut Held>,
    ) {
        src.release();
        if let Some(held) = dst {
            held.release();
        }
        if let Some(slot) = slot
            && self.restore(ops, slot)
        {
            let _ = ops.hook.step(Step::Restored);
        }
    }

    /// Exchange `from <-> to` first so S is published before D is captured.
    /// D is briefly visible under the source name; no object is R-only until
    /// after the commit point.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn exchange_move(
        &mut self,
        ops: &OpContext,
        from: &Resolved,
        to: &Resolved,
        src: &mut Held,
        dst: &mut Held,
    ) -> FileResult<()> {
        if !self.holds_name(&from.dir, &from.name, src) {
            return Err(self.conflict_or_uncertain("replaced"));
        }
        if !self.holds_name(&to.dir, &to.name, dst) {
            return Err(self.conflict_or_uncertain("replaced"));
        }
        self.set_intent_phase(IntentPhase::Publishing)?;
        let before = self.effect_checkpoint();
        self.begin_public_effect()?;
        match crate::file_ops::fs::exchange::exchange(
            from.dir.as_fd(),
            &from.name,
            to.dir.as_fd(),
            &to.name,
        ) {
            Ok(()) => {}
            Err(_errno) if self.holds_name(&to.dir, &to.name, src) => {
                // Lost reply: the swap took effect.
            }
            Err(errno) => {
                self.effect_refused(before, errno);
                return Err(if is_unsupported(errno) {
                    FileError::unsafe_filesystem()
                } else {
                    FileError::errno(errno)
                });
            }
        }
        let _ = ops.hook.step(Step::Exchanged);
        if !self.holds_name(&to.dir, &to.name, src) {
            src.release();
            dst.release();
            self.unsettled = true;
            self.record_public(&to.dir, &to.name, &to.full_path());
            self.record_public(&from.dir, &from.name, &from.full_path());
            return Err(self.uncertain());
        }
        if !self.holds_name(&from.dir, &from.name, dst) {
            src.release();
            dst.release();
            self.unsettled = true;
            self.record_public(&to.dir, &to.name, &to.full_path());
            self.record_public(&from.dir, &from.name, &from.full_path());
            return Err(self.uncertain());
        }
        self.sync_effect(&[&to.dir, &from.dir])?;
        self.set_intent_phase(IntentPhase::Committed)?;
        let mark = self.checkpoint();
        let Some(slot) = self.capture(&from.dir, &from.name, &from.full_path()) else {
            src.release();
            dst.release();
            return match self.abort_capture(mark) {
                Some(Errno::ENOENT) => Ok(()),
                Some(errno) => Err(FileError::errno(errno)),
                None => Err(self.uncertain()),
            };
        };
        self.record_slot_identity(&slot)?;
        let _ = ops.hook.step(Step::Captured);
        let _ = ops.hook.step(Step::Vacated);
        if self.holds(&slot, dst) {
            src.release();
            self.dispose(ops, &slot, dst);
            return Ok(());
        }
        dst.release();
        src.release();
        self.keep(&slot);
        Err(if self.settled() {
            FileError::conflict("replaced")
        } else {
            self.uncertain()
        })
    }
}
