//! The dead-man's side: the rollback at the deadline, the restart it owes,
//! its cleanup, and a later attempt settling an update abandoned before its
//! swap.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;

use super::recovery::{LOCK_WAIT, Restored, layout_of, restore_durably, swap_began};
use crate::protocol::frames::UpdateReason;
use crate::update::deadman::Scheduler;
use crate::update::install;
use crate::update::state::{self, Lifecycle};

/// The dead-man's next look when an install or a confirmation holds the lock.
pub(super) const LOCKED_RETRY: Duration = Duration::from_secs(5);

/// One look of the dead-man at the update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rollback {
    /// No such update (another one replaced it): nothing to do.
    NotOurs,
    /// Confirmed, already rolled back, or failed.
    Settled,
    /// Not due yet, or the lock is held (an install still running past the
    /// deadline, or a confirmation): look again after this.
    NotDue(Duration),
    /// The update never swapped; it is marked failed and nothing moved.
    NeverSwapped,
    /// Rolled back: restart the service.
    RolledBack,
    /// Due, but there is no rollback copy.
    NoCopy,
}

/// The dead-man's check: roll back `update_id` if it is due and still
/// unconfirmed. `log_tail` is the failed build's log, kept for the report.
///
/// It holds the update lock, so a confirmation cannot land while it rolls
/// back (nor an install still running). Nothing happens before the deadline,
/// in any phase: a job that starts at once (macOS `RunAtLoad`) must not take
/// an update that is still being installed (`Armed`) for an abandoned one.
/// `booted_at` (Unix seconds) is when the machine last started: after a
/// reboot during the trial, the deadline is a full window after the boot, so
/// a build that comes up after the reboot can still confirm before a dead-man
/// that fires at boot rolls it back.
pub fn rollback_if_unconfirmed(
    update_dir: &Path,
    update_id: &str,
    now: u64,
    booted_at: Option<u64>,
    log_tail: impl FnOnce() -> Option<String>,
) -> Result<Rollback> {
    let Some(_lock) = state::UpdateLock::wait(update_dir, LOCK_WAIT)? else {
        return Ok(Rollback::NotDue(LOCKED_RETRY));
    };
    let Some(mut current) = state::load(update_dir)? else {
        return Ok(Rollback::NotOurs);
    };
    if current.update_id != update_id {
        return Ok(Rollback::NotOurs);
    }
    if !current.in_progress() || current.recovery_path.is_none() {
        return Ok(Rollback::Settled);
    }
    // A rollback already decided (its intent is saved, and it may have begun) is finished now,
    // whatever the deadline says since.
    if current.lifecycle != Lifecycle::RollingBack {
        let window = u64::from(current.rollback_after_secs);
        let armed_at = current.deadline.saturating_sub(window);
        let due = match booted_at {
            Some(boot) if boot > armed_at => current.deadline.max(boot.saturating_add(window)),
            _ => current.deadline,
        };
        // One second of slack for a timer that fires a little early.
        if now + 1 < due {
            return Ok(Rollback::NotDue(Duration::from_secs(due - now)));
        }
    }
    let layout = layout_of(&current)?;
    if current.lifecycle == Lifecycle::Armed {
        if !swap_began(&layout) {
            // Still armed at the deadline: the installer stopped before the swap.
            current.fail(
                UpdateReason::Internal,
                "the update stopped before the swap; nothing was changed",
            )?;
            state::save(update_dir, &current)?;
            let _ = std::fs::remove_file(&layout.new);
            return Ok(Rollback::NeverSwapped);
        }
        current.swap()?;
    }
    if restore_durably(update_dir, &mut current, &layout)? == Restored::NoCopy {
        current.fail(
            UpdateReason::Internal,
            "the new build did not confirm and there is no rollback copy",
        )?;
        state::save(update_dir, &current)?;
        return Ok(Rollback::NoCopy);
    }
    // The relay still runs the build that failed: this dead-man restarts it, and keeps its job
    // until that worked ([`restart_pending`]).
    current.finish_rollback(true)?;
    current.detail = log_tail().map(|tail| crate::update::clip_detail(&tail));
    // Failing here leaves `swapped` with the intent saved: the job runs again, and the replay
    // finds the restore done.
    state::save(update_dir, &current)?;
    Ok(Rollback::RolledBack)
}

/// The dead-man of `update_id` removed its own job (`remove()` succeeded) and has nothing left
/// to do: remove its program (the recovery copy), under the update lock. Kept while the update
/// still needs recovery ([`UpdateState::needs_recovery`](state::UpdateState::needs_recovery): a restart still owed, a rollback not
/// recorded). Best effort: what stays (Windows cannot delete the running program;
/// the lock was busy) goes with a later sweep.
pub fn job_removed(update_dir: &Path, update_id: &str) {
    let Ok(Some(_lock)) = state::UpdateLock::wait(update_dir, LOCK_WAIT) else {
        return;
    };
    let Ok(Some(current)) = state::load(update_dir) else {
        return;
    };
    if current.update_id != update_id || current.needs_recovery() {
        return;
    }
    if let Some(recovery) = &current.recovery_path {
        let _ = std::fs::remove_file(recovery);
    }
}

/// Whether the dead-man of `update_id` rolled it back and the relay has not restarted into the
/// restored build yet (its restart failed): the dead-man job's next run restarts it.
pub fn restart_pending(update_dir: &Path, update_id: &str) -> bool {
    matches!(
        state::load(update_dir),
        Ok(Some(current))
            if current.update_id == update_id && current.recovery_path.is_some() && current.lifecycle.restart_pending()
    )
}

/// The relay restarted into the restored build: the dead-man owes nothing more. Best effort
/// (a mark left behind costs one more restart, if the job could not be removed either).
pub fn restart_done(update_dir: &Path, update_id: &str) -> Result<()> {
    let Some(_lock) = state::UpdateLock::wait(update_dir, LOCK_WAIT)? else {
        anyhow::bail!("the update state is locked");
    };
    if let Some(mut current) = state::load(update_dir)?
        && current.update_id == update_id
        && current.restart_done()
    {
        state::save(update_dir, &current)?;
    }
    Ok(())
}

/// A later update attempt, holding the update lock (`_held`: no installer, dead-man run or
/// confirmation can run meanwhile, all take it), settles an update that was abandoned before
/// its swap: still `armed`, `wsmp.new` still there (the swap did not begin), and no recovery job
/// registered (its arming failed, or there is no scheduler). Its installer ended without
/// recording the end (the terminal save failed) and nothing else would ever finish it until the
/// relay restarts. It is recorded failed, nothing moved. True when it settled one. An `armed`
/// state whose swap began, or whose dead-man is registered (or the scheduler cannot tell), is
/// left to its owner: the dead-man, or the next start.
pub fn settle_abandoned(
    update_dir: &Path,
    scheduler: Option<&dyn Scheduler>,
    _held: &state::UpdateLock,
) -> Result<bool> {
    let Some(mut current) = state::load(update_dir)? else {
        return Ok(false);
    };
    if current.lifecycle != Lifecycle::Armed {
        return Ok(false);
    }
    let layout = layout_of(&current)?;
    if swap_began(&layout) {
        return Ok(false);
    }
    if let Some(scheduler) = scheduler
        && scheduler.present()?
    {
        return Ok(false);
    }
    current.fail(
        UpdateReason::Internal,
        "the update stopped before the swap; nothing was changed",
    )?;
    state::save(update_dir, &current)?;
    install::clean(&layout);
    Ok(true)
}

/// What the dead-man of `update_id` can tell without the lock: the update
/// settled ([`Rollback::Settled`]) or another one replaced it
/// ([`Rollback::NotOurs`]). `None` while it may still need a rollback.
pub fn no_longer_due(update_dir: &Path, update_id: &str) -> Option<Rollback> {
    match state::load(update_dir) {
        Ok(Some(current)) if current.update_id != update_id => Some(Rollback::NotOurs),
        Ok(Some(current)) if !current.in_progress() || current.recovery_path.is_none() => {
            Some(Rollback::Settled)
        }
        Ok(None) => Some(Rollback::NotOurs),
        _ => None,
    }
}
