//! The installs: the self-replace (download, verify, unpack, test-run, keep
//! the rollback copy, arm the dead-man, swap) and the record of a Homebrew
//! upgrade.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;

use super::recovery::{deadman_spec, swap_began, sweep_recovery};
use super::{Ended, Machine, Progress, Request};
use crate::relay::update::install::{self, Layout};
use crate::relay::update::state::{self, Lifecycle, UpdateState};
use crate::wire::protocol::frames::{UpdatePhase, UpdateReason};
use crate::wire::protocol::runtime_spec::UpdateStrategy;

impl Machine<'_> {
    fn may_proceed(&self, progress: &mut dyn Progress) -> std::result::Result<(), Ended> {
        match self.proceed.map(|proceed| proceed()) {
            Some(Err((reason, detail))) => {
                Err(stop(progress, UpdatePhase::Refused, reason, detail))
            }
            _ => Ok(()),
        }
    }
}

fn stop(
    progress: &mut dyn Progress,
    phase: UpdatePhase,
    reason: UpdateReason,
    detail: impl Into<String>,
) -> Ended {
    progress.report(
        phase,
        Some(reason),
        Some(crate::relay::update::clip_detail(&detail.into())),
    );
    Ended::Stopped
}

/// The archive's file name from its URL (for `tar`, which reads the format
/// from the content anyway).
pub(super) fn archive_name(url: &str) -> String {
    let last = url
        .split(['?', '#'])
        .next()
        .and_then(|path| path.rsplit('/').next())
        .unwrap_or_default();
    if !last.is_empty()
        && last.len() <= 128
        && last
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !last.starts_with('.')
    {
        last.to_string()
    } else {
        "wsmp-update-archive".to_string()
    }
}

/// Download, verify, unpack, test-run, keep the rollback copy, record the
/// state, arm the dead-man and swap. The caller holds the update lock and
/// has checked the gates; it sends `restarting` and restarts on
/// [`Ended::Swapped`].
pub fn self_replace(
    machine: &Machine<'_>,
    request: &Request,
    progress: &mut dyn Progress,
) -> Ended {
    let layout = match Layout::beside(&machine.live, &request.update_id) {
        Ok(layout) => layout,
        Err(error) => {
            return stop(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!("{error:#}"),
            );
        }
    };
    install::clear_retired(&layout.live);
    // Dead-man programs of earlier updates that no job runs any more.
    sweep_recovery(&machine.update_dir(), &layout.live, machine.scheduler);
    let ended = install_files(machine, request, &layout, progress);
    if ended == Ended::Stopped && settled(&machine.update_dir(), &request.update_id) {
        install::clean(&layout);
        // This update's dead-man program too, once no job is registered (its removal
        // failed, or arming failed after it registered: then the copy stays for it).
        sweep_recovery(&machine.update_dir(), &layout.live, machine.scheduler);
    } else {
        // Swapped, or stopped with this update still recorded in progress (its terminal state
        // could not be saved, or the swap began): `wsmp.new` and the rollback copy are the
        // dead-man's evidence (whether the swap happened, what to put back). Only staging goes.
        let _ = std::fs::remove_dir_all(&layout.staging);
    }
    ended
}

/// Whether nothing durable still names `update_id` as in progress: no state, another update's,
/// or this one ended. An unreadable state counts as not settled (its evidence is kept).
fn settled(update_dir: &Path, update_id: &str) -> bool {
    match state::load(update_dir) {
        Ok(Some(current)) => current.update_id != update_id || !current.in_progress(),
        Ok(None) => true,
        Err(_) => false,
    }
}

/// How often a terminal state is written before the update leaves it to the dead-man.
const TERMINAL_SAVE_ATTEMPTS: u32 = 4;

/// Save the terminal state `current` (already moved there), trying again on a failure (a
/// transient storage error). True once it is durable: only then may the dead-man be removed.
fn save_terminal(update_dir: &Path, current: &UpdateState) -> bool {
    let mut wait = Duration::from_millis(50);
    for attempt in 1..=TERMINAL_SAVE_ATTEMPTS {
        match state::save(update_dir, current) {
            Ok(()) => return true,
            Err(error) => {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    attempt,
                    "recording the update's end failed"
                );
                if attempt < TERMINAL_SAVE_ATTEMPTS {
                    std::thread::sleep(wait);
                    wait *= 3;
                }
            }
        }
    }
    false
}

fn install_files(
    machine: &Machine<'_>,
    request: &Request,
    layout: &Layout,
    progress: &mut dyn Progress,
) -> Ended {
    progress.report(UpdatePhase::Downloading, None, None);
    let _ = std::fs::remove_dir_all(&layout.staging);
    if let Err(error) = std::fs::create_dir_all(&layout.staging) {
        return stop(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("cannot write beside `{}`: {error}", machine.live.display()),
        );
    }
    let archive = layout.staging.join(archive_name(&request.artifact_url));
    if let Err(error) = install::download(&request.artifact_url, &archive) {
        return stop(
            progress,
            UpdatePhase::Failed,
            UpdateReason::DownloadFailed,
            format!("{error:#}"),
        );
    }

    if let Err(ended) = machine.may_proceed(progress) {
        return ended;
    }
    progress.report(UpdatePhase::Verifying, None, None);
    match install::sha256_file(&archive) {
        Ok(actual) if actual == request.sha256 => {}
        Ok(actual) => {
            return stop(
                progress,
                UpdatePhase::Refused,
                UpdateReason::ChecksumMismatch,
                format!(
                    "the archive's SHA-256 is {actual}, not {}; nothing was installed",
                    request.sha256
                ),
            );
        }
        Err(error) => {
            return stop(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!("{error:#}"),
            );
        }
    }
    if let Err(why) = install::verify_signature(request.signature.as_deref(), &archive) {
        return stop(
            progress,
            UpdatePhase::Refused,
            UpdateReason::SignatureMismatch,
            why,
        );
    }
    let found = match install::extract(
        &machine.tar,
        &archive,
        &layout.staging.join("unpacked"),
        &machine.target,
    ) {
        Ok(found) => found,
        Err(error) => {
            return stop(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!("{error:#}"),
            );
        }
    };
    // The new build runs here (`--version`): not once the update may not go on.
    if let Err(ended) = machine.may_proceed(progress) {
        return ended;
    }
    match install::probe_version(&found) {
        Ok(version) if version == request.version => {}
        Ok(version) => {
            return stop(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!("the new build is wsmp {version}, not {}", request.version),
            );
        }
        Err(error) => {
            return stop(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!("{error:#}"),
            );
        }
    }
    // Last, before anything outside the staging directory changes.
    if let Some(before_swap) = machine.before_swap
        && let Err(why) = before_swap(progress)
    {
        // A wait the update may no longer go on ended: that reason, not busy.
        if let Err(ended) = machine.may_proceed(progress) {
            return ended;
        }
        return stop(progress, UpdatePhase::Refused, UpdateReason::Busy, why);
    }
    if let Err(ended) = machine.may_proceed(progress) {
        return ended;
    }
    if let Err(error) =
        install::stage_new(&found, layout).and_then(|()| install::prepare_prev(layout))
    {
        return stop(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    // The dead-man's own program, beside the rollback copy, that no swap or rollback moves:
    // made and verified before the state that names it and the job that runs it.
    if machine.scheduler.is_some()
        && let Err(error) = install::prepare_recovery(&layout.prev, &layout.recovery)
    {
        return stop(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("writing the rollback job's program: {error:#}"),
        );
    }

    let to_sha256 = match install::sha256_file(&layout.new) {
        Ok(sha256) => sha256,
        Err(error) => {
            return stop(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!("{error:#}"),
            );
        }
    };

    // The rollback copy and `wsmp.new` exist before the state that names
    // them; the swap takes `wsmp.new` away, which is how the dead-man knows a
    // swap happened when the process died before it saved `swapped`.
    let update_dir = machine.update_dir();
    let mut current = UpdateState {
        update_id: request.update_id.clone(),
        origin: request.origin,
        strategy: UpdateStrategy::SelfReplace,
        from_version: machine.current_version.clone(),
        to_version: request.version.clone(),
        to_sha256: Some(to_sha256),
        live_path: layout.live.clone(),
        prev_path: layout.prev.clone(),
        recovery_path: machine.scheduler.map(|_| layout.recovery.clone()),
        failed_path: layout.failed.clone(),
        rollback_after_secs: request.rollback_after_secs,
        deadline: crate::relay::update::unix_now() + u64::from(request.rollback_after_secs),
        deadman_at: machine
            .scheduler
            .map(|_| crate::relay::update::unix_now() + u64::from(request.rollback_after_secs)),
        attempts: 0,
        lifecycle: Lifecycle::Armed,
        reason: None,
        detail: None,
        updated_at: crate::services::file_ops::fmt::rfc3339_secs(crate::relay::update::unix_now()),
    };
    if let Err(error) = state::save(&update_dir, &current) {
        return stop(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    // Ends the update as `phase`/`reason`: the terminal state is saved first (reported again on
    // later sessions until the server acknowledges it), and the dead-man is removed only once it
    // is durable. Not durable: the dead-man stays, with `wsmp.new` (the swap did not happen) and
    // the rollback copy; at its deadline it finds `armed` and settles it (`NeverSwapped`). An
    // update whose dead-man could not be armed has no job to settle it: the next update attempt
    // does, under the update lock ([`settle_abandoned`]), or else the next start (`on_start`).
    // `current` moves to `failed` only once that is durable: in memory it says what the disk says.
    let end = |current: &mut UpdateState,
               progress: &mut dyn Progress,
               phase: UpdatePhase,
               reason: UpdateReason,
               detail: String,
               disarm: bool| {
        let mut ended = current.clone();
        let durable =
            ended.fail(reason, detail.clone()).is_ok() && save_terminal(&update_dir, &ended);
        if durable {
            *current = ended;
            if disarm && let Some(scheduler) = machine.scheduler {
                let _ = crate::relay::update::deadman::disarm(scheduler);
            }
        }
        stop(progress, phase, reason, detail)
    };
    let failed = |current: &mut UpdateState, progress: &mut dyn Progress, detail: String| {
        end(
            current,
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            detail,
            false,
        )
    };
    if let Some(scheduler) = machine.scheduler {
        let armed = deadman_spec(
            &current,
            &machine.state_dir,
            Duration::from_secs(u64::from(request.rollback_after_secs)),
        )
        .and_then(|spec| {
            crate::relay::update::deadman::arm(
                scheduler,
                &spec,
                crate::relay::update::deadman::ARM_WAIT,
            )
        });
        if let Err(error) = armed {
            return failed(
                &mut current,
                progress,
                format!("arming the rollback: {error:#}"),
            );
        }
        progress.report(UpdatePhase::Armed, None, None);
    }
    // Arming can wait on the service manager (a rollback still running, a
    // name not yet free): the node may have been lowered or its operator may
    // have turned remote updates off meanwhile. Asked again last, right
    // before the swap. A refusal here ends the update like any other, with
    // the old binary in place: the state is recorded as ended first (so a
    // dead-man that cannot be removed finds it settled and moves nothing),
    // then, once that is durable, the dead-man is removed.
    if let Some(Err((reason, detail))) = machine.proceed.map(|proceed| proceed()) {
        return end(
            &mut current,
            progress,
            UpdatePhase::Refused,
            reason,
            detail,
            true,
        );
    }
    if let Err(error) = install::swap(layout) {
        let detail = format!("{error:#}");
        if swap_began(layout) {
            // Partly done (Windows: the live binary moved aside, and putting it back failed):
            // the state stays `armed` and the dead-man puts the rollback copy back.
            return stop(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                detail,
            );
        }
        return end(
            &mut current,
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            detail,
            true,
        );
    }
    if current.swap().is_ok()
        && let Err(error) = state::save(&update_dir, &current)
    {
        // The new binary treats an `armed` state for its own version as swapped.
        tracing::warn!(error = %format!("{error:#}"), "recording the swap failed");
    }
    progress.report(UpdatePhase::Swapped, None, None);
    Ended::Swapped
}

/// Record a Homebrew upgrade that installed `to_version`, so the new binary
/// confirms it after the restart (no dead-man: D10).
/// `stable` is the keg-independent `opt/wsmp/bin/wsmp`, which now leads to
/// the new keg's binary (the old keg stays: Homebrew's cleanup is off).
pub fn record_homebrew(machine: &Machine<'_>, request: &Request, stable: &Path) -> Result<()> {
    let now = crate::relay::update::unix_now();
    let to_sha256 = std::fs::canonicalize(stable)
        .ok()
        .and_then(|binary| install::sha256_file(&binary).ok());
    let current = UpdateState {
        update_id: request.update_id.clone(),
        origin: request.origin,
        strategy: UpdateStrategy::Homebrew,
        from_version: machine.current_version.clone(),
        to_version: request.version.clone(),
        to_sha256,
        live_path: stable.to_path_buf(),
        prev_path: stable.to_path_buf(),
        recovery_path: None,
        failed_path: stable.to_path_buf(),
        rollback_after_secs: request.rollback_after_secs,
        deadline: now + u64::from(request.rollback_after_secs),
        deadman_at: None,
        attempts: 0,
        lifecycle: Lifecycle::Swapped,
        reason: None,
        detail: None,
        updated_at: crate::services::file_ops::fmt::rfc3339_secs(now),
    };
    state::save(&machine.update_dir(), &current)
}
