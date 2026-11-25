//! The delete transaction for a file or symlink: one call captures the held
//! object into recovery under a durable INTENT, proves its identity, commits and
//! disposes it, or restores a racer's object, and returns the recovered paths.
//! `mutate` checks the request and pins the object; directories never come here
//! (kernel rmdir removes only an empty one).

use nix::errno::Errno;

use super::{Held, RecoveryDir};
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::fs::resolve::Resolved;
use crate::services::file_ops::journal::intent::{Intent, IntentPhase};
use crate::services::file_ops::{Cancel, Step};

/// Delete the object `held` pins at `resolved`. Cancellation is honored until
/// the capture; a proven delete is committed, and failed cleanup after that is
/// recoverable success (reported in the returned paths).
pub(in crate::services::file_ops) fn delete(
    ops: &OpContext,
    resolved: &Resolved,
    mut held: Held,
    cancel: &Cancel,
) -> FileResult<Vec<String>> {
    let mut recovery = RecoveryDir::new(&resolved.dir, &resolved.dir_path)?;
    let result = (|| {
        ops.hook.step(Step::Vacating)?;
        cancel.check()?; // last cancellation point before public capture
        recovery.prepare_intent(Intent::delete(&resolved.full_path()))?;
        let mark = recovery.checkpoint();
        let Some(slot) = recovery.capture(&resolved.dir, &resolved.name, &resolved.full_path())
        else {
            return Err(match recovery.abort_capture(mark) {
                Some(Errno::ENOENT) => FileError::conflict("gone"),
                Some(errno) => FileError::errno(errno),
                None => recovery.uncertain(),
            });
        };
        recovery.record_slot_identity(&slot)?;
        recovery.set_intent_phase(IntentPhase::Captured)?;
        let _ = ops.hook.step(Step::Vacated);
        if !recovery.holds(&slot, &held) {
            held.release();
            if recovery.restore(ops, &slot) {
                let _ = ops.hook.step(Step::Restored);
            }
            return if recovery.settled() {
                Err(FileError::conflict("replaced"))
            } else {
                Err(recovery.uncertain())
            };
        }
        // A proven delete is committed; failed cleanup is recoverable success.
        recovery.set_intent_phase(IntentPhase::Publishing)?;
        recovery.sync_effect(&[&resolved.dir])?;
        recovery.set_intent_phase(IntentPhase::Committed)?;
        recovery.dispose(ops, &slot, &mut held);
        Ok(())
    })();
    held.release();
    let recovered = recovery.finish();
    match result {
        Ok(()) if !recovery.acknowledges_success() => Err(recovery.uncertain()),
        Ok(()) => Ok(recovered),
        Err(error) if error.code == ErrorCode::UncertainOutcome || !recovery.settled() => {
            Err(recovery.uncertain())
        }
        Err(error) => Err(error),
    }
}
