//! What the installer, the dead-man and a starting relay share: the update
//! lock's wait, an update's files, the dead-man job's program, and the durable
//! restore of the rollback copy.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::update::deadman::{DeadmanSpec, Scheduler};
use crate::update::install::{self, Layout};
use crate::update::state::{self, Lifecycle, UpdateState};

/// How long the dead-man, a confirming build and a starting relay wait for
/// the update lock before they look again later.
#[cfg(not(test))]
pub(super) const LOCK_WAIT: Duration = Duration::from_secs(10);
#[cfg(test)]
pub(super) const LOCK_WAIT: Duration = Duration::from_millis(200);
/// The files of `current`'s update.
pub(super) fn layout_of(current: &UpdateState) -> Result<Layout> {
    let beside = Layout::beside(&current.live_path, &current.update_id)?;
    Ok(Layout {
        live: current.live_path.clone(),
        prev: current.prev_path.clone(),
        failed: current.failed_path.clone(),
        recovery: current
            .recovery_path
            .clone()
            .unwrap_or_else(|| beside.recovery.clone()),
        ..beside
    })
}

/// The dead-man job for `current`: it runs the recorded recovery copy
/// ([`UpdateState::recovery_path`], [`install::prepare_recovery`]), never the rollback copy the
/// restore consumes. The one place a job's program is chosen: the installer and a start that
/// arms a lost job again both use it. An error when no recovery copy is recorded.
pub fn deadman_spec(
    current: &UpdateState,
    state_dir: &Path,
    fire_in: Duration,
) -> Result<DeadmanSpec> {
    let program = current
        .recovery_path
        .as_deref()
        .context("the update has no program recorded for its rollback job")?;
    DeadmanSpec::new(current.update_id.clone(), program, state_dir, fire_in)
}

/// Remove the dead-man programs ([`install::prepare_recovery`]) beside `live` that no job can
/// run any more, under the update lock (the caller holds it). Only when no dead-man job is
/// registered (`present()` is `false`, or there is no scheduler): a job that is still there
/// keeps its program, whatever it is for. The one the state still needs
/// ([`UpdateState::needs_recovery`]: a job lost and armed again runs it) stays. Any doubt (the
/// scheduler cannot tell, the state cannot be read) removes nothing.
pub(super) fn sweep_recovery(update_dir: &Path, live: &Path, scheduler: Option<&dyn Scheduler>) {
    if install::recovery_copies(live).is_empty() {
        return;
    }
    if let Some(scheduler) = scheduler
        && !matches!(scheduler.present(), Ok(false))
    {
        return;
    }
    let keep = match state::load(update_dir) {
        Ok(current) => current
            .filter(UpdateState::needs_recovery)
            .and_then(|current| current.recovery_path),
        Err(_) => return,
    };
    install::clear_recovery(live, keep.as_deref());
}

/// Whether the swap began: it takes `wsmp.new` away (and on Windows moves
/// the live binary aside first). An `armed` state with either gone is a swap
/// whose `swapped` was never saved.
pub(super) fn swap_began(layout: &Layout) -> bool {
    std::fs::symlink_metadata(&layout.new).is_err()
        || std::fs::symlink_metadata(&layout.live).is_err()
}

/// How a durable restore went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Restored {
    /// The rollback copy is the live binary now (by this call, or by an earlier one).
    Done,
    /// There is no rollback copy, and the live binary is still the new build.
    NoCopy,
}

/// Put the rollback copy back, durably, under the update lock, from `swapped`: the intent
/// ([`Lifecycle::RollingBack`]) is saved before the restore consumes `wsmp.prev`, so a rollback
/// that stops after it (a crash, a failed save) is recognised as done on replay instead of
/// finding no copy. Both rollbacks use it: the dead-man's ([`rollback_if_unconfirmed`](super::rollback_if_unconfirmed)) and the
/// one after too many unconfirmed starts ([`on_start`](super::on_start)).
///
/// On [`Restored::Done`], `current` is still [`Lifecycle::RollingBack`]: the caller records
/// `rolled_back` ([`UpdateState::finish_rollback`]). On [`Restored::NoCopy`] it is `swapped`
/// again and the caller saves what comes next (failed, or still unconfirmed); until then the
/// disk may still say rolling back, which a replay finds the same way. On an error the disk
/// says what `current` says, or the intent was saved and the restore failed (a replay finishes
/// it).
pub(super) fn restore_durably(
    update_dir: &Path,
    current: &mut UpdateState,
    layout: &Layout,
) -> Result<Restored> {
    let copy = std::fs::symlink_metadata(&layout.prev).is_ok();
    if current.lifecycle != Lifecycle::RollingBack {
        if !copy {
            return Ok(Restored::NoCopy);
        }
        current.begin_rollback()?;
        if let Err(error) = state::save(update_dir, current) {
            // Nothing was restored: the copy is still there for the next try.
            current.abandon_rollback();
            return Err(error.context("recording the rollback before it begins"));
        }
    }
    let restored_now = copy && install::restore(layout)?;
    if !restored_now && !restore_completed(current, layout)? {
        // The copy went without a restore (removed by hand): nothing to put back.
        current.abandon_rollback();
        return Ok(Restored::NoCopy);
    }
    install::clear_retired(&layout.live);
    Ok(Restored::Done)
}

/// With the rollback decided and its copy gone: whether the restore already ran. The live
/// binary is then no longer the new build (by its SHA-256, when the update recorded one; without
/// it, the intent and the consumed copy decide). An unreadable live binary is an error: the
/// rollback is tried again later.
fn restore_completed(current: &UpdateState, layout: &Layout) -> Result<bool> {
    let Some(new) = current.to_sha256.as_deref() else {
        return Ok(true);
    };
    Ok(install::sha256_file(&layout.live)? != new)
}
