//! The new build's side: what a starting relay does with an update in
//! flight, and the confirmation once its session is healthy.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};

use super::recovery::{
    LOCK_WAIT, Restored, deadman_spec, layout_of, restore_durably, swap_began, sweep_recovery,
};
use crate::protocol::frames::UpdateReason;
use crate::protocol::runtime_spec::UpdateStrategy;
use crate::update::deadman::Scheduler;
use crate::update::install::{self, Layout};
use crate::update::state::{self, Lifecycle, UpdateState};

/// How a confirmation ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confirm {
    /// Recorded `confirmed`.
    Confirmed(Box<UpdateState>),
    /// The dead-man rolled this build back first: it is no longer the live
    /// binary, so the relay restarts into the one that is.
    RolledBack,
    /// Another update owns the state, or it ended some other way.
    NotOurs,
}

/// The new binary of `update_id` has met every condition: record
/// `confirmed`, disarm the dead-man and write the install receipt, all under
/// the update lock. An error (the lock is held) is tried again later.
pub fn confirm(
    update_dir: &Path,
    scheduler: Option<&dyn Scheduler>,
    update_id: &str,
    receipt: impl FnOnce(&UpdateState) -> Option<crate::update::receipt::InstallReceipt>,
) -> Result<Confirm> {
    let Some(_lock) = state::UpdateLock::wait(update_dir, LOCK_WAIT)? else {
        anyhow::bail!("the update state is locked");
    };
    let Some(mut current) = state::load(update_dir)? else {
        return Ok(Confirm::NotOurs);
    };
    if current.update_id != update_id {
        return Ok(Confirm::NotOurs);
    }
    match current.lifecycle {
        Lifecycle::Armed => current.swap()?,
        Lifecycle::Swapped => {}
        // A rollback was decided (it may have restored the old build already): never confirmed.
        Lifecycle::RollingBack | Lifecycle::RolledBack { .. } => return Ok(Confirm::RolledBack),
        Lifecycle::Confirmed { .. } | Lifecycle::Failed { .. } => return Ok(Confirm::NotOurs),
    }
    // Not only the phase: the installed binary must be this update's new build. One that a
    // rollback (or anything else) replaced is not certified; the relay restarts into it.
    if current.strategy == UpdateStrategy::SelfReplace
        && let Some(expected) = current.to_sha256.as_deref()
        && install::sha256_file(&current.live_path).context("reading the installed wsmp")?
            != expected
    {
        return Ok(Confirm::RolledBack);
    }
    current.confirm()?;
    state::save(update_dir, &current)?;
    if current.strategy == UpdateStrategy::SelfReplace
        && let Some(scheduler) = scheduler
        && let Err(error) = crate::update::deadman::disarm(scheduler)
    {
        // It finds the update confirmed and does nothing.
        tracing::warn!(error = %format!("{error:#}"), "disarming the update dead-man failed");
    }
    if let (Some(receipt), Some(state_dir)) = (receipt(&current), update_dir.parent())
        && let Err(error) = crate::update::receipt::write(state_dir, &receipt)
    {
        tracing::warn!(error = %format!("{error:#}"), "writing the install receipt failed");
    }
    install::clear_retired(&current.live_path);
    // Its dead-man's program, once the job is gone.
    sweep_recovery(update_dir, &current.live_path, scheduler);
    Ok(Confirm::Confirmed(Box::new(current)))
}

/// Whether a start must arm the dead-man again: it went missing (removed by
/// hand, or a task that expired), or its job's time passed while nothing ran
/// it. A deadline missed while the machine was off is one: Windows' Task
/// Scheduler may start the missed task only minutes after boot.
fn deadman_lost(scheduler: &dyn Scheduler, deadman_at: Option<u64>, now: u64) -> bool {
    match scheduler.present() {
        Ok(false) => true,
        Ok(true) => {
            deadman_at.is_some_and(|at| at <= now)
                && scheduler.running().is_ok_and(|running| !running)
        }
        Err(_) => false,
    }
}

/// Make sure `current`'s recovery copy is there and is the rollback copy's bytes, writing it
/// (again) from the rollback copy otherwise. A missing recorded path is a stale job.
fn ensure_recovery(current: &mut UpdateState, layout: &Layout) -> Result<()> {
    anyhow::ensure!(
        current.recovery_path.is_some(),
        "the stale update job has no recoveryPath"
    );
    if install::verify_recovery(&layout.prev, &layout.recovery).is_err() {
        install::prepare_recovery(&layout.prev, &layout.recovery)?;
    }
    current.recovery_path = Some(layout.recovery.clone());
    Ok(())
}

/// What a starting relay does about the update state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnStart {
    Nothing,
    /// This binary is the update: confirm it once the session proves healthy.
    AwaitConfirm(UpdateState),
    /// Tell the server how an update ended, after `hello.ok`.
    Report(UpdateState),
    /// This binary started too often without confirming: it rolled itself
    /// back; exit so the service starts the previous binary.
    RolledBackSelf,
}

/// The build that is starting: its version and the SHA-256 of its binary.
#[derive(Debug, Clone, Copy)]
pub struct Running<'a> {
    pub version: &'a str,
    /// `None` when the binary could not be read: the version decides then.
    pub sha256: Option<&'a str>,
}

/// Look at the update state when the relay starts, under the update lock. A
/// new build that is still unconfirmed counts the start, gives itself a full
/// window from now (the restart, the reconnect and the definition sync do not
/// eat into it), re-arms a dead-man that went missing, and rolls itself back
/// after `max_starts` unconfirmed starts.
pub fn on_start(
    update_dir: &Path,
    scheduler: Option<&dyn Scheduler>,
    running: Running<'_>,
    max_starts: u32,
    now: u64,
) -> Result<OnStart> {
    if !state::path(update_dir).exists() {
        return Ok(OnStart::Nothing);
    }
    let Some(_lock) = state::UpdateLock::wait(update_dir, LOCK_WAIT)? else {
        anyhow::bail!("the update state is locked");
    };
    let Some(mut current) = state::load(update_dir)? else {
        return Ok(OnStart::Nothing);
    };
    if current.strategy == UpdateStrategy::SelfReplace
        && current.in_progress()
        && current.recovery_path.is_none()
    {
        // `wsmp update` in 0.4.3 uses HTTP, so it can install this build despite the
        // relay protocol change. Its job runs wsmp.prev and has no recoveryPath.
        // Keep that safety net until normal health confirmation if the bytes match.
        let installed = install::sha256_file(&current.live_path)
            .context("reading the installed wsmp for an update without recoveryPath")?;
        if current.to_sha256.as_deref() != Some(installed.as_str()) {
            current.abandon_rollback();
            current.fail(
                UpdateReason::Internal,
                "discarded stale update job: no recoveryPath was recorded and the installed binary does not match toSha256",
            )?;
            state::save(update_dir, &current)?;
            if let Some(scheduler) = scheduler
                && let Err(error) = crate::update::deadman::disarm(scheduler)
            {
                tracing::warn!(error = %format!("{error:#}"), "discarding the stale update job failed");
            }
        }
    }
    if !current.in_progress() {
        sweep_recovery(update_dir, &current.live_path, scheduler);
        return Ok(if current.needs_report() {
            OnStart::Report(current)
        } else {
            OnStart::Nothing
        });
    }
    let new_build = current.is_new_build(running.version, running.sha256);
    if current.lifecycle == Lifecycle::RollingBack {
        // A rollback was decided and stopped before it was recorded: finish it first.
        let layout = layout_of(&current)?;
        if restore_durably(update_dir, &mut current, &layout)? == Restored::Done {
            current.finish_rollback(false)?;
            current
                .detail
                .get_or_insert_with(|| "the rollback was finished when wsmp started".to_string());
            state::save(update_dir, &current)?;
            if let Some(scheduler) = scheduler {
                let _ = crate::update::deadman::disarm(scheduler);
            }
            sweep_recovery(update_dir, &current.live_path, scheduler);
            return Ok(if new_build {
                // This process is the build that was rolled back: the service starts the other.
                OnStart::RolledBackSelf
            } else if current.needs_report() {
                OnStart::Report(current)
            } else {
                OnStart::Nothing
            });
        }
        // No copy, and the new build is still installed: nothing was restored.
        state::save(update_dir, &current)?;
    }
    if !new_build {
        // This is not the new build: the swap did not happen or did not take.
        let layout = layout_of(&current)?;
        let why = if current.lifecycle == Lifecycle::Armed && !swap_began(&layout) {
            let _ = std::fs::remove_file(&layout.new);
            "the update stopped before the swap; nothing was changed".to_string()
        } else if current.to_version == running.version {
            format!(
                "a different build of wsmp {} started instead of the new one",
                running.version
            )
        } else {
            format!(
                "wsmp {} started instead of {}",
                running.version, current.to_version
            )
        };
        current.fail(UpdateReason::Internal, why)?;
        state::save(update_dir, &current)?;
        if let Some(scheduler) = scheduler {
            let _ = crate::update::deadman::disarm(scheduler);
        }
        sweep_recovery(update_dir, &current.live_path, scheduler);
        return Ok(if current.needs_report() {
            OnStart::Report(current)
        } else {
            OnStart::Nothing
        });
    }
    if current.lifecycle == Lifecycle::Armed {
        current.swap()?;
    }
    current.attempts += 1;
    if current.strategy == UpdateStrategy::Homebrew {
        state::save(update_dir, &current)?;
        return Ok(OnStart::AwaitConfirm(current));
    }
    if current.attempts > max_starts {
        let layout = layout_of(&current)?;
        if restore_durably(update_dir, &mut current, &layout)? == Restored::Done {
            current.finish_rollback(false)?;
            current.detail = Some(format!(
                "wsmp {} started {max_starts} times without confirming",
                running.version
            ));
            state::save(update_dir, &current)?;
            if let Some(scheduler) = scheduler {
                let _ = crate::update::deadman::disarm(scheduler);
            }
            sweep_recovery(update_dir, &current.live_path, scheduler);
            return Ok(OnStart::RolledBackSelf);
        }
    }
    // The window counts from this start: a dead-man that fires at the old
    // deadline finds the update not due and waits.
    current.deadline = current
        .deadline
        .max(now + u64::from(current.rollback_after_secs));
    current.updated_at = crate::file_ops::fmt::rfc3339_secs(now);
    if let Some(scheduler) = scheduler
        && current.attempts <= max_starts
        && deadman_lost(scheduler, current.deadman_at, now)
    {
        let state_dir = update_dir
            .parent()
            .context("the update directory has no parent")?;
        let armed = layout_of(&current)
            .and_then(|layout| ensure_recovery(&mut current, &layout))
            .and_then(|()| {
                deadman_spec(
                    &current,
                    state_dir,
                    Duration::from_secs(current.deadline.saturating_sub(now)),
                )
            })
            .and_then(|spec| {
                crate::update::deadman::arm(scheduler, &spec, crate::update::deadman::ARM_WAIT)
            });
        match armed {
            Ok(()) => current.deadman_at = Some(current.deadline),
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "re-arming the update dead-man failed"
            ),
        }
    }
    state::save(update_dir, &current)?;
    Ok(OnStart::AwaitConfirm(current))
}
