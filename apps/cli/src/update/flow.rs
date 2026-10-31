//! The update sequences, free of the relay: the self-replace install, the
//! Homebrew upgrade, the dead-man's rollback, the new binary's confirmation
//! and what a starting relay does with an update in flight.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

use super::deadman::{DeadmanSpec, Scheduler};
use super::install::{self, Layout};
use super::state::{self, Origin, Phase, UpdateState};
use crate::protocol::frames::{UpdatePhase, UpdateReason};
use crate::protocol::runtime_spec::UpdateStrategy;

/// What to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub update_id: String,
    pub version: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: Option<String>,
    pub rollback_after_secs: u32,
    pub origin: Origin,
}

/// Where progress goes: `agent.update.progress` frames, or a person's terminal.
pub trait Progress {
    fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>);

    /// Refuse with `version_mismatch`, naming the version this node could install instead
    /// (the progress frame's `availableVersion`). A reporter that cannot carry it reports the
    /// refusal alone.
    fn refuse_version(&mut self, available: String, detail: String) {
        let _ = available;
        self.report(
            UpdatePhase::Refused,
            Some(UpdateReason::VersionMismatch),
            Some(detail),
        );
    }
}

/// The last check before the swap: `Err` with why it must not happen now.
pub type BeforeSwap<'a> = dyn Fn(&mut dyn Progress) -> std::result::Result<(), String> + 'a;

/// Whether the update may still go on (the node's trust, its operator's
/// setting): asked between the steps, and refuses with the reason when not.
pub type Proceed<'a> = dyn Fn() -> std::result::Result<(), (UpdateReason, String)> + 'a;

/// The machine an update runs on.
pub struct Machine<'a> {
    /// The node's state directory (`--state-dir` of the dead-man).
    pub state_dir: PathBuf,
    /// The canonical live binary.
    pub live: PathBuf,
    /// The Rust target triple (the archive's `wsmp-<target>/` directory).
    pub target: String,
    /// The dead-man's scheduler; `None` when no service restarts wsmp (the
    /// caller then finishes without one).
    pub scheduler: Option<&'a dyn Scheduler>,
    pub tar: PathBuf,
    pub current_version: String,
    /// Asked last, before anything is armed or moved: `Err` with why the swap
    /// must not happen now (the node is busy again). The relay keeps the node
    /// idle from a yes until it restarts.
    pub before_swap: Option<&'a BeforeSwap<'a>>,
    /// Asked after the download, before the new build runs, and before the
    /// swap.
    pub proceed: Option<&'a Proceed<'a>>,
    /// Homebrew only, before the keg changes: make the installed service
    /// start the stable `opt` path it is given (the path the update probes
    /// after `brew upgrade`), or say why it cannot (the update stops).
    /// [`crate::commands::service::ensure_stable_executable`] outside tests.
    pub stable_service: fn(&Path) -> anyhow::Result<()>,
}

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

impl Machine<'_> {
    pub fn update_dir(&self) -> PathBuf {
        self.state_dir.join("update")
    }
}

/// How an install ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The new binary is in place (state `swapped`): restart into it.
    Swapped,
    /// Refused or failed; the progress already says why. No new build was
    /// recorded as installed. Steps already done stay done: a self-replace
    /// puts the previous binary back, but a Homebrew update may have
    /// refreshed the tap, rewritten the service or run `brew upgrade`
    /// (Homebrew has no rollback).
    Stopped,
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
        Some(super::clip_detail(&detail.into())),
    );
    Ended::Stopped
}

/// The archive's file name from its URL (for `tar`, which reads the format
/// from the content anyway).
fn archive_name(url: &str) -> String {
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
        Ok(Some(current)) => current.update_id != update_id || !current.phase.in_progress(),
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
        deadline: super::unix_now() + u64::from(request.rollback_after_secs),
        deadman_at: machine
            .scheduler
            .map(|_| super::unix_now() + u64::from(request.rollback_after_secs)),
        attempts: 0,
        phase: Phase::Armed,
        reason: None,
        detail: None,
        reported: false,
        rolling_back: false,
        restart_pending: false,
        updated_at: crate::file_ops::fmt::rfc3339_secs(super::unix_now()),
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
    let end = |current: &mut UpdateState,
               progress: &mut dyn Progress,
               phase: UpdatePhase,
               reason: UpdateReason,
               detail: String,
               disarm: bool| {
        let durable =
            current.fail(reason, detail.clone()).is_ok() && save_terminal(&update_dir, current);
        if durable
            && disarm
            && let Some(scheduler) = machine.scheduler
        {
            let _ = super::deadman::disarm(scheduler);
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
        .and_then(|spec| super::deadman::arm(scheduler, &spec, super::deadman::ARM_WAIT));
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
    if current.advance(Phase::Swapped).is_ok()
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
    let now = super::unix_now();
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
        phase: Phase::Swapped,
        reason: None,
        detail: None,
        reported: false,
        rolling_back: false,
        restart_pending: false,
        updated_at: crate::file_ops::fmt::rfc3339_secs(now),
    };
    state::save(&machine.update_dir(), &current)
}

/// How long the dead-man, a confirming build and a starting relay wait for
/// the update lock before they look again later.
#[cfg(not(test))]
pub const LOCK_WAIT: Duration = Duration::from_secs(10);
#[cfg(test)]
pub const LOCK_WAIT: Duration = Duration::from_millis(200);
/// The dead-man's next look when an install or a confirmation holds the lock.
const LOCKED_RETRY: Duration = Duration::from_secs(5);

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

/// The files of `current`'s update.
fn layout_of(current: &UpdateState) -> Result<Layout> {
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

/// Make sure `current`'s recovery copy is there and is the rollback copy's bytes, writing it
/// (again) from the rollback copy otherwise, and record it. An update armed by an earlier build
/// (whose job ran `wsmp.prev`) gets one here, before its job is armed again.
fn ensure_recovery(current: &mut UpdateState, layout: &Layout) -> Result<()> {
    if current.recovery_path.is_none()
        || install::verify_recovery(&layout.prev, &layout.recovery).is_err()
    {
        install::prepare_recovery(&layout.prev, &layout.recovery)?;
    }
    current.recovery_path = Some(layout.recovery.clone());
    Ok(())
}

/// Remove the dead-man programs ([`install::prepare_recovery`]) beside `live` that no job can
/// run any more, under the update lock (the caller holds it). Only when no dead-man job is
/// registered (`present()` is `false`, or there is no scheduler): a job that is still there
/// keeps its program, whatever it is for. The one the state still needs
/// ([`UpdateState::needs_recovery`]: a job lost and armed again runs it) stays. Any doubt (the
/// scheduler cannot tell, the state cannot be read) removes nothing.
fn sweep_recovery(update_dir: &Path, live: &Path, scheduler: Option<&dyn Scheduler>) {
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

/// The dead-man of `update_id` removed its own job (`remove()` succeeded) and has nothing left
/// to do: remove its program (the recovery copy), under the update lock. Kept while the update
/// still needs recovery ([`UpdateState::needs_recovery`]: a restart still owed, a rollback not
/// recorded). A job armed by an earlier build ran `wsmp.prev`, which this build linked again
/// after the restore ([`rollback_if_unconfirmed`]): that link goes instead. Best effort: what
/// stays (Windows cannot delete the running program; the lock was busy) goes with a later
/// sweep.
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
    match &current.recovery_path {
        Some(recovery) => {
            let _ = std::fs::remove_file(recovery);
        }
        None if current.phase == Phase::RolledBack => {
            let _ = std::fs::remove_file(&current.prev_path);
        }
        None => {}
    }
}

/// Whether the swap began: it takes `wsmp.new` away (and on Windows moves
/// the live binary aside first). An `armed` state with either gone is a swap
/// whose `swapped` was never saved.
fn swap_began(layout: &Layout) -> bool {
    std::fs::symlink_metadata(&layout.new).is_err()
        || std::fs::symlink_metadata(&layout.live).is_err()
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
    if !current.phase.in_progress() {
        return Ok(Rollback::Settled);
    }
    // A rollback already decided (its intent is saved, and it may have begun) is finished now,
    // whatever the deadline says since.
    if !current.rolling_back {
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
    if current.phase == Phase::Armed {
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
        current.advance(Phase::Swapped)?;
    }
    if restore_durably(update_dir, &mut current, &layout)? == Restored::NoCopy {
        current.fail(
            UpdateReason::Internal,
            "the new build did not confirm and there is no rollback copy",
        )?;
        state::save(update_dir, &current)?;
        return Ok(Rollback::NoCopy);
    }
    current.advance(Phase::RolledBack)?;
    current.rolling_back = false;
    // The relay still runs the build that failed: this dead-man restarts it, and keeps its job
    // until that worked ([`restart_pending`]).
    current.restart_pending = true;
    current.detail = log_tail().map(|tail| super::clip_detail(&tail));
    // Failing here leaves `swapped` with the intent saved: the job runs again, and the replay
    // finds the restore done.
    state::save(update_dir, &current)?;
    if current.recovery_path.is_none()
        && let Err(error) = install::relink_program(&layout.live, &current.prev_path)
    {
        // A job armed by an earlier build runs `wsmp.prev`, which the restore consumed: its
        // next run (a retried restart) needs it there again.
        tracing::warn!(error = %format!("{error:#}"), "keeping the rollback job's program failed");
    }
    Ok(Rollback::RolledBack)
}

/// How a durable restore went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Restored {
    /// The rollback copy is the live binary now (by this call, or by an earlier one).
    Done,
    /// There is no rollback copy, and the live binary is still the new build.
    NoCopy,
}

/// Put the rollback copy back, durably, under the update lock: the intent (`rolling_back`) is
/// saved before the restore consumes `wsmp.prev`, so a rollback that stops after it (a crash, a
/// failed save) is recognised as done on replay instead of finding no copy. Both rollbacks use
/// it: the dead-man's ([`rollback_if_unconfirmed`]) and the one after too many unconfirmed
/// starts ([`on_start`]). The caller records `rolled_back` on [`Restored::Done`].
fn restore_durably(
    update_dir: &Path,
    current: &mut UpdateState,
    layout: &Layout,
) -> Result<Restored> {
    let copy = std::fs::symlink_metadata(&layout.prev).is_ok();
    if !current.rolling_back {
        if !copy {
            return Ok(Restored::NoCopy);
        }
        current.rolling_back = true;
        if let Err(error) = state::save(update_dir, current) {
            // Nothing was restored: the copy is still there for the next try.
            current.rolling_back = false;
            return Err(error.context("recording the rollback before it begins"));
        }
    }
    let restored_now = copy && install::restore(layout)?;
    if !restored_now && !restore_completed(current, layout)? {
        // The copy went without a restore (removed by hand): nothing to put back.
        current.rolling_back = false;
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

/// Whether the dead-man of `update_id` rolled it back and the relay has not restarted into the
/// restored build yet (its restart failed): the dead-man job's next run restarts it.
pub fn restart_pending(update_dir: &Path, update_id: &str) -> bool {
    matches!(
        state::load(update_dir),
        Ok(Some(current))
            if current.update_id == update_id
                && current.phase == Phase::RolledBack
                && current.restart_pending
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
        && current.restart_pending
    {
        current.restart_pending = false;
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
    if current.phase != Phase::Armed {
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
        Ok(Some(current)) if !current.phase.in_progress() => Some(Rollback::Settled),
        Ok(None) => Some(Rollback::NotOurs),
        _ => None,
    }
}

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
    receipt: impl FnOnce(&UpdateState) -> Option<super::receipt::InstallReceipt>,
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
    // A rollback was decided (it may have restored the old build already): never confirmed.
    if current.rolling_back {
        return Ok(Confirm::RolledBack);
    }
    match current.phase {
        Phase::Armed => current.advance(Phase::Swapped)?,
        Phase::Swapped => {}
        Phase::RolledBack => return Ok(Confirm::RolledBack),
        Phase::Confirmed | Phase::Failed => return Ok(Confirm::NotOurs),
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
    current.advance(Phase::Confirmed)?;
    state::save(update_dir, &current)?;
    if current.strategy == UpdateStrategy::SelfReplace
        && let Some(scheduler) = scheduler
        && let Err(error) = super::deadman::disarm(scheduler)
    {
        // It finds the update confirmed and does nothing.
        tracing::warn!(error = %format!("{error:#}"), "disarming the update dead-man failed");
    }
    if let (Some(receipt), Some(state_dir)) = (receipt(&current), update_dir.parent())
        && let Err(error) = super::receipt::write(state_dir, &receipt)
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
    if !current.phase.in_progress() {
        sweep_recovery(update_dir, &current.live_path, scheduler);
        return Ok(if current.needs_report() {
            OnStart::Report(current)
        } else {
            OnStart::Nothing
        });
    }
    let new_build = current.is_new_build(running.version, running.sha256);
    if current.rolling_back {
        // A rollback was decided and stopped before it was recorded: finish it first.
        let layout = layout_of(&current)?;
        if restore_durably(update_dir, &mut current, &layout)? == Restored::Done {
            current.advance(Phase::RolledBack)?;
            current.rolling_back = false;
            current
                .detail
                .get_or_insert_with(|| "the rollback was finished when wsmp started".to_string());
            state::save(update_dir, &current)?;
            if let Some(scheduler) = scheduler {
                let _ = super::deadman::disarm(scheduler);
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
        let why = if current.phase == Phase::Armed && !swap_began(&layout) {
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
            let _ = super::deadman::disarm(scheduler);
        }
        sweep_recovery(update_dir, &current.live_path, scheduler);
        return Ok(if current.needs_report() {
            OnStart::Report(current)
        } else {
            OnStart::Nothing
        });
    }
    if current.phase == Phase::Armed {
        current.advance(Phase::Swapped)?;
    }
    current.attempts += 1;
    if current.strategy == UpdateStrategy::Homebrew {
        state::save(update_dir, &current)?;
        return Ok(OnStart::AwaitConfirm(current));
    }
    if current.attempts > max_starts {
        let layout = layout_of(&current)?;
        if restore_durably(update_dir, &mut current, &layout)? == Restored::Done {
            current.advance(Phase::RolledBack)?;
            current.rolling_back = false;
            current.detail = Some(format!(
                "wsmp {} started {max_starts} times without confirming",
                running.version
            ));
            state::save(update_dir, &current)?;
            if let Some(scheduler) = scheduler {
                let _ = super::deadman::disarm(scheduler);
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
            .and_then(|spec| super::deadman::arm(scheduler, &spec, super::deadman::ARM_WAIT));
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

#[cfg(test)]
mod tests {
    use super::super::deadman::fake::FakeScheduler;
    use super::*;

    #[derive(Default)]
    struct Recorded(Vec<(UpdatePhase, Option<UpdateReason>, Option<String>)>);

    impl Progress for Recorded {
        fn report(
            &mut self,
            phase: UpdatePhase,
            reason: Option<UpdateReason>,
            detail: Option<String>,
        ) {
            self.0.push((phase, reason, detail));
        }
    }

    impl Recorded {
        #[cfg(unix)]
        fn phases(&self) -> Vec<UpdatePhase> {
            self.0.iter().map(|(phase, _, _)| *phase).collect()
        }
        fn last_reason(&self) -> Option<UpdateReason> {
            self.0.last().and_then(|(_, reason, _)| *reason)
        }
    }

    #[cfg(unix)]
    /// Serves `body` once per connection at any path, on loopback.
    fn serve(body: Vec<u8>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}/wsmp-x86_64-unknown-linux-gnu.tar.gz")
    }

    #[cfg(unix)]
    fn archive_with(script: &str) -> Vec<u8> {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let inner = dir.path().join("wsmp-test-target");
        std::fs::create_dir_all(&inner).expect("mkdir");
        let binary = inner.join("wsmp");
        std::fs::write(&binary, script).expect("write");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let archive = dir.path().join("a.tar.gz");
        let status = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(dir.path())
            .arg("wsmp-test-target")
            .status()
            .expect("tar");
        assert!(status.success());
        std::fs::read(&archive).expect("read")
    }

    struct Node {
        root: tempfile::TempDir,
        live: PathBuf,
        scheduler: FakeScheduler,
    }

    impl Node {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("root");
            let bin = root.path().join("bin");
            std::fs::create_dir_all(&bin).expect("bin");
            let live = bin.join("wsmp");
            std::fs::write(&live, "#!/bin/sh\necho 'wsmp 0.4.2'\n").expect("live");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod");
            }
            Self {
                root,
                live,
                scheduler: FakeScheduler::default(),
            }
        }
        fn state_dir(&self) -> PathBuf {
            self.root.path().join("state")
        }
        #[cfg(unix)]
        fn update_dir(&self) -> PathBuf {
            self.state_dir().join("update")
        }
        fn machine(&self) -> Machine<'_> {
            Machine {
                state_dir: self.state_dir(),
                live: self.live.clone(),
                target: "test-target".into(),
                scheduler: Some(&self.scheduler),
                tar: install::system_tar(),
                current_version: "0.4.2".into(),
                before_swap: None,
                proceed: None,
                stable_service: |_| Ok(()),
            }
        }
        fn live_text(&self) -> String {
            std::fs::read_to_string(&self.live).expect("live")
        }
        #[cfg(unix)]
        fn live_sha(&self) -> String {
            install::sha256_file(&self.live).expect("hash")
        }
        fn untouched(&self) {
            assert!(self.live_text().contains("0.4.2"));
            assert!(self.scheduler.registered.borrow().is_none());
            let names: Vec<String> = std::fs::read_dir(self.live.parent().expect("bin"))
                .expect("dir")
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(names, ["wsmp"], "leftovers");
        }
    }

    /// The old build starting (its hash does not matter once the update ended).
    #[cfg(unix)]
    const OLD_BUILD: Running<'static> = Running {
        version: "0.4.2",
        sha256: None,
    };

    #[cfg(unix)]
    fn new_build(sha256: &str) -> Running<'_> {
        Running {
            version: "0.4.3",
            sha256: Some(sha256),
        }
    }

    fn request(url: String, sha256: String) -> Request {
        Request {
            update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            version: "0.4.3".into(),
            artifact_url: url,
            sha256,
            signature: None,
            rollback_after_secs: 90,
            origin: Origin::Server,
        }
    }

    #[cfg(unix)]
    fn sha(bytes: &[u8]) -> String {
        crate::metric_sources::sha256_hex(bytes)
    }

    #[cfg(unix)]
    #[test]
    fn a_good_build_is_armed_then_swapped_and_confirms() {
        let node = Node::new();
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let url = serve(archive.clone());
        let mut progress = Recorded::default();
        let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
        assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
        assert_eq!(
            progress.phases(),
            [
                UpdatePhase::Downloading,
                UpdatePhase::Verifying,
                UpdatePhase::Armed,
                UpdatePhase::Swapped
            ]
        );
        assert!(node.live_text().contains("0.4.3"));
        let prev = node.live.with_file_name("wsmp.prev");
        assert!(
            std::fs::read_to_string(&prev)
                .expect("prev")
                .contains("0.4.2")
        );
        let spec = node.scheduler.registered.borrow().clone().expect("armed");
        // The job runs its own copy of the old build, not the rollback copy.
        let recovery = node
            .live
            .with_file_name(".wsmp-recovery-AAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(spec.program(), recovery);
        assert_ne!(spec.program(), prev);
        assert_eq!(
            install::sha256_file(&recovery).expect("recovery"),
            install::sha256_file(&prev).expect("prev")
        );
        assert_eq!(spec.fire_in(), Duration::from_secs(90));
        let saved = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(saved.phase, Phase::Swapped);
        assert!(
            !node
                .live
                .with_file_name(".wsmp-update-AAAAAAAAAAAAAAAAAAAAAA")
                .exists()
        );

        // The new binary starts: it awaits confirmation, the dead-man stays.
        assert_eq!(saved.to_sha256.as_deref(), Some(node.live_sha().as_str()));
        let start = on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&node.live_sha()),
            3,
            0,
        )
        .expect("start");
        assert!(matches!(start, OnStart::AwaitConfirm(ref s) if s.attempts == 1));
        assert_eq!(*node.scheduler.registrations.borrow(), 1);
        let Confirm::Confirmed(confirmed) = confirm(
            &node.update_dir(),
            Some(&node.scheduler),
            &saved.update_id,
            |_| None,
        )
        .expect("confirm") else {
            panic!("not confirmed");
        };
        assert_eq!(confirmed.phase, Phase::Confirmed);
        assert!(confirmed.needs_report());
        assert!(node.scheduler.registered.borrow().is_none(), "disarmed");
        // The dead-man firing late finds it settled; the copy is kept.
        let late = rollback_if_unconfirmed(
            &node.update_dir(),
            &confirmed.update_id,
            u64::MAX / 2,
            None,
            || None,
        )
        .expect("check");
        assert_eq!(late, Rollback::Settled);
        assert!(prev.exists());
        // Confirmed and its job removed: the job's program went with it.
        assert!(!recovery.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_bad_checksum_never_swaps() {
        let node = Node::new();
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let url = serve(archive);
        let mut progress = Recorded::default();
        let ended = self_replace(
            &node.machine(),
            &request(url, "0".repeat(64)),
            &mut progress,
        );
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(progress.phases().last(), Some(&UpdatePhase::Refused));
        assert_eq!(progress.last_reason(), Some(UpdateReason::ChecksumMismatch));
        node.untouched();
        assert_eq!(state::load(&node.update_dir()).expect("load"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_build_that_fails_version_never_swaps() {
        for script in [
            "#!/bin/sh\nexit 1\n",
            "#!/bin/sh\necho 'wsmp 0.4.4'\n",
            "#!/bin/sh\necho garbage\n",
        ] {
            let node = Node::new();
            let archive = archive_with(script);
            let url = serve(archive.clone());
            let mut progress = Recorded::default();
            let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
            assert_eq!(ended, Ended::Stopped, "{script}");
            assert_eq!(
                progress.last_reason(),
                Some(UpdateReason::VersionMismatch),
                "{script}"
            );
            node.untouched();
        }
    }

    #[test]
    fn a_failed_download_never_swaps() {
        let node = Node::new();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let mut progress = Recorded::default();
        let ended = self_replace(
            &node.machine(),
            &request(format!("http://127.0.0.1:{port}/a.tar.gz"), "0".repeat(64)),
            &mut progress,
        );
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(progress.last_reason(), Some(UpdateReason::DownloadFailed));
        node.untouched();
    }

    #[cfg(unix)]
    #[test]
    fn a_dead_man_that_cannot_arm_stops_before_the_swap() {
        let node = Node::new();
        *node.scheduler.refuse.borrow_mut() = true;
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let url = serve(archive.clone());
        let mut progress = Recorded::default();
        let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
        assert_eq!(ended, Ended::Stopped);
        assert!(node.live_text().contains("0.4.2"));
        let saved = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(saved.phase, Phase::Failed);
        assert!(
            saved.needs_report(),
            "reported until the server acknowledges it"
        );
    }

    /// Swapped in, as `self_replace` leaves it, with a new build that dies at once.
    #[cfg(unix)]
    fn swapped_node() -> (Node, UpdateState) {
        let node = Node::new();
        let archive = archive_with(
            "#!/bin/sh\ncase \"$1\" in --version) echo 'wsmp 0.4.3';; *) exit 1;; esac\n",
        );
        let url = serve(archive.clone());
        let mut progress = Recorded::default();
        assert_eq!(
            self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress),
            Ended::Swapped
        );
        let saved = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        (node, saved)
    }

    /// R7-B-1, through both producers of a dead-man (the update, and a start
    /// that re-arms a lost one): each runs in a child whose working directory
    /// is the updater's, with a relative state directory. The job it arms
    /// names the state directory absolutely, and that command, run from
    /// another working directory (the scheduler's), restores the old build.
    /// The same command with the relative path finds nothing there and rolls
    /// nothing back (what was armed before).
    #[cfg(unix)]
    #[test]
    fn a_relative_state_dir_is_armed_absolute_and_the_job_restores_from_another_cwd() {
        const NAME: &str = "update::flow::tests::a_relative_state_dir_is_armed_absolute_and_the_job_restores_from_another_cwd";
        const SCRIPT: &str =
            "#!/bin/sh\ncase \"$1\" in --version) echo 'wsmp 0.4.3';; *) exit 1;; esac\n";
        if let Some(mode) = std::env::var_os("WSMP_TEST_R7B1_MODE") {
            let out = PathBuf::from(std::env::var_os("WSMP_TEST_R7B1_OUT").expect("out"));
            let var = |name: &str| std::env::var(name).expect(name);
            let emit = |scheduler: &FakeScheduler| {
                let spec = scheduler.registered.borrow().clone().expect("armed");
                let mut job = vec![spec.program_text().expect("program").to_string()];
                job.extend(spec.rollback_args().expect("args"));
                std::fs::write(&out, job.join("\n")).expect("job");
            };
            let node = Node::new();
            match mode.to_str().expect("mode") {
                "update" => {
                    let archive = archive_with(SCRIPT);
                    let url = serve(archive.clone());
                    let machine = Machine {
                        state_dir: "relative-state".into(),
                        live: var("WSMP_TEST_R7B1_LIVE").into(),
                        ..node.machine()
                    };
                    let mut progress = Recorded::default();
                    let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
                    assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
                }
                "start" => {
                    let sha = var("WSMP_TEST_R7B1_SHA");
                    let now = var("WSMP_TEST_R7B1_NOW").parse().expect("now");
                    let start = on_start(
                        Path::new("relative-state/update"),
                        Some(&node.scheduler),
                        new_build(&sha),
                        3,
                        now,
                    )
                    .expect("start");
                    assert!(matches!(start, OnStart::AwaitConfirm(_)), "{start:?}");
                }
                "job" => {
                    // What `wsmp update rollback` does with the job's
                    // arguments (`commands::update::run`), past any deadline.
                    let job = std::fs::read_to_string(var("WSMP_TEST_R7B1_JOB")).expect("job");
                    let args: Vec<&str> = job.lines().collect();
                    let after = |flag: &str| {
                        args.iter()
                            .position(|arg| *arg == flag)
                            .and_then(|at| args.get(at + 1))
                            .copied()
                            .expect(flag)
                    };
                    crate::paths::pin(None, Some(after("--state-dir").into())).expect("pin");
                    let outcome = rollback_if_unconfirmed(
                        &crate::update::update_dir().expect("update dir"),
                        after("--if-unconfirmed"),
                        u64::MAX / 2,
                        None,
                        || None,
                    );
                    std::fs::write(&out, format!("{outcome:?}")).expect("outcome");
                    return;
                }
                other => panic!("unknown mode {other}"),
            }
            emit(&node.scheduler);
            return;
        }

        let child = |mode: &str, cwd: &Path, out: &Path, env: &[(&str, std::ffi::OsString)]| {
            let ran = std::process::Command::new(std::env::current_exe().expect("exe"))
                .args(["--exact", NAME, "--nocapture"])
                .current_dir(cwd)
                .env("WSMP_TEST_R7B1_MODE", mode)
                .env("WSMP_TEST_R7B1_OUT", out)
                .envs(env.iter().map(|(name, value)| (name, value)))
                .output()
                .expect("child");
            assert!(
                ran.status.success(),
                "{mode}: {}{}",
                String::from_utf8_lossy(&ran.stdout),
                String::from_utf8_lossy(&ran.stderr)
            );
            std::fs::read_to_string(out).expect("child output")
        };
        for producer in ["update", "start"] {
            let node = Node::new();
            let updater = node.root.path().join("updater");
            let manager = node.root.path().join("manager");
            std::fs::create_dir_all(&updater).expect("updater");
            std::fs::create_dir_all(&manager).expect("manager");
            let state_dir = updater.join("relative-state");
            let job_file = node.root.path().join("job");
            if producer == "update" {
                child(
                    producer,
                    &updater,
                    &job_file,
                    &[("WSMP_TEST_R7B1_LIVE", node.live.clone().into())],
                );
            } else {
                // Swapped (here, absolute), then the dead-man went missing:
                // the new build's start re-arms it from a relative path.
                let archive = archive_with(SCRIPT);
                let url = serve(archive.clone());
                let machine = Machine {
                    state_dir: state_dir.clone(),
                    ..node.machine()
                };
                let mut progress = Recorded::default();
                let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
                assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
                let saved = state::load(&state_dir.join("update"))
                    .expect("load")
                    .expect("state");
                child(
                    producer,
                    &updater,
                    &job_file,
                    &[
                        ("WSMP_TEST_R7B1_SHA", node.live_sha().into()),
                        (
                            "WSMP_TEST_R7B1_NOW",
                            (saved.deadline + 10).to_string().into(),
                        ),
                    ],
                );
            }
            let job = std::fs::read_to_string(&job_file).expect("job");
            let expected = std::fs::canonicalize(&updater)
                .expect("canonical")
                .join("relative-state");
            assert!(node.live_text().contains("0.4.3"), "{producer}: swapped");

            // The job as armed before this fix, from the scheduler's directory:
            // no update there, nothing rolled back.
            let relative_job = node.root.path().join("relative-job");
            let relative = job.replace(&expected.display().to_string(), "relative-state");
            std::fs::write(&relative_job, relative).expect("relative job");
            let outcome = child(
                "job",
                &manager,
                &node.root.path().join("relative-outcome"),
                &[("WSMP_TEST_R7B1_JOB", relative_job.into())],
            );
            assert_eq!(outcome, "Ok(NotOurs)", "{producer}");
            assert!(node.live_text().contains("0.4.3"), "{producer}");

            // The job as armed now, from the same directory: the old build is back.
            let outcome = child(
                "job",
                &manager,
                &node.root.path().join("outcome"),
                &[("WSMP_TEST_R7B1_JOB", job_file.into())],
            );
            assert_eq!(outcome, "Ok(RolledBack)", "{producer}");
            assert!(node.live_text().contains("0.4.2"), "{producer}: restored");
            let restored = state::load(&state_dir.join("update"))
                .expect("load")
                .expect("state");
            assert_eq!(restored.phase, Phase::RolledBack, "{producer}");
            // Armed with the updater's directory, made absolute.
            assert!(
                job.ends_with(&format!("\n--state-dir\n{}", expected.display())),
                "{producer}: {job}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unconfirmed_build_is_rolled_back_at_the_deadline() {
        let (node, saved) = swapped_node();
        // A new build that exits right away never confirms; the dead-man fires.
        let early = rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline - 30,
            None,
            || None,
        )
        .expect("early");
        assert_eq!(early, Rollback::NotDue(Duration::from_secs(30)));
        assert!(node.live_text().contains("0.4.3"));
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                "BBBBBBBBBBBBBBBBBBBBBB",
                saved.deadline,
                None,
                || None
            )
            .expect("other"),
            Rollback::NotOurs
        );
        let due = rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline,
            None,
            || Some("panicked at definition sync".into()),
        )
        .expect("due");
        assert_eq!(due, Rollback::RolledBack);
        assert!(node.live_text().contains("0.4.2"));
        assert!(
            std::fs::read_to_string(node.live.with_file_name("wsmp.failed"))
                .expect("failed")
                .contains("0.4.3")
        );
        // The old binary starts and reports the rollback with the log tail.
        let start =
            on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, 0).expect("start");
        let OnStart::Report(report) = start else {
            panic!("expected a report, got {start:?}");
        };
        assert_eq!(report.phase, Phase::RolledBack);
        assert_eq!(
            report.detail.as_deref(),
            Some("panicked at definition sync")
        );
        // Running twice changes nothing.
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                &saved.update_id,
                saved.deadline,
                None,
                || { None }
            )
            .expect("again"),
            Rollback::Settled
        );
        assert!(node.live_text().contains("0.4.2"));
    }

    #[cfg(unix)]
    #[test]
    fn a_dead_man_whose_time_passed_unrun_is_armed_again() {
        let (node, saved) = swapped_node();
        let sha = node.live_sha();
        let deadman_at = saved.deadman_at.expect("armed");
        let before = *node.scheduler.registrations.borrow();
        // A start before the dead-man's time: it will run, nothing to do.
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&sha),
            3,
            deadman_at - 1,
        )
        .expect("start");
        assert_eq!(*node.scheduler.registrations.borrow(), before);
        // After a reboot its time has passed and it is not running: armed for
        // the moved deadline.
        let late = deadman_at + 300;
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&sha),
            3,
            late,
        )
        .expect("start");
        assert_eq!(*node.scheduler.registrations.borrow(), before + 1);
        let rearmed = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(rearmed.deadman_at, Some(rearmed.deadline));
        assert_eq!(
            node.scheduler
                .registered
                .borrow()
                .as_ref()
                .map(DeadmanSpec::fire_in),
            Some(Duration::from_secs(rearmed.deadline - late))
        );
        // Running now (waiting for the deadline): left alone.
        *node.scheduler.running_for.borrow_mut() = 1;
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&sha),
            3,
            rearmed.deadline + 1,
        )
        .expect("start");
        assert_eq!(*node.scheduler.registrations.borrow(), before + 1);
    }

    /// F-FA-1: the dead-man's program (the recovery copy) is not the rollback copy, survives the
    /// restore, and stays while its job is registered or anything is still owed (a restart);
    /// only once the job is gone and nothing is owed does a sweep remove it.
    #[cfg(unix)]
    #[test]
    fn the_job_keeps_its_program_while_it_is_registered_or_owed() {
        let (node, saved) = swapped_node();
        let recovery = saved.recovery_path.clone().expect("recorded");
        assert_eq!(
            node.scheduler
                .registered
                .borrow()
                .as_ref()
                .map(|spec| spec.program().to_path_buf()),
            Some(recovery.clone())
        );
        let outcome = rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline + 10,
            None,
            || None,
        )
        .expect("rollback");
        assert_eq!(outcome, Rollback::RolledBack);
        assert!(
            !saved.prev_path.exists(),
            "the restore consumed the rollback copy"
        );
        assert!(recovery.exists(), "never the job's program");
        // The old build starts while the job is still registered (its restart is owed):
        // nothing is swept.
        let start = |now| {
            on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, now).expect("start")
        };
        start(saved.deadline + 20);
        assert!(recovery.exists(), "a registered job keeps its program");
        // The job is gone but the restart is still owed: kept for a job armed again.
        let spec = node.scheduler.registered.borrow().clone().expect("job");
        node.scheduler.remove().expect("remove");
        start(saved.deadline + 30);
        assert!(recovery.exists(), "still owed");
        // Nothing owed, but a job is registered (its removal failed, say): it keeps its
        // program, whatever the state says.
        node.scheduler.register(&spec).expect("job again");
        restart_done(&node.update_dir(), &saved.update_id).expect("done");
        start(saved.deadline + 40);
        assert!(recovery.exists(), "a registered job keeps its program");
        // Nothing owed and no job: removed.
        node.scheduler.remove().expect("remove");
        start(saved.deadline + 50);
        assert!(!recovery.exists(), "swept");
    }

    /// F-FA-1, the old layout: an update whose job an earlier build armed (it ran `wsmp.prev`;
    /// the state names no recovery copy) and lost is armed again with a recovery copy of the
    /// rollback copy, recorded in the state.
    #[cfg(unix)]
    #[test]
    fn a_job_an_earlier_build_armed_is_armed_again_with_a_recovery_copy() {
        let (node, mut saved) = swapped_node();
        let recovery = saved.recovery_path.take().expect("recorded");
        std::fs::remove_file(&recovery).expect("rm");
        state::save(&node.update_dir(), &saved).expect("save");
        node.scheduler.remove().expect("lost");
        let late = saved.deadline + 300;
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&node.live_sha()),
            3,
            late,
        )
        .expect("start");
        let spec = node
            .scheduler
            .registered
            .borrow()
            .clone()
            .expect("armed again");
        assert_eq!(spec.program(), recovery);
        assert_eq!(
            install::sha256_file(&recovery).expect("copy"),
            install::sha256_file(&saved.prev_path).expect("prev")
        );
        let stored = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(stored.recovery_path.as_deref(), Some(recovery.as_path()));
    }

    /// F-FA-1, the inverse: a recovery copy that cannot be written stops the update before
    /// anything is armed or swapped (the old build stays live, no job).
    #[cfg(unix)]
    #[test]
    fn a_recovery_copy_that_cannot_be_made_stops_before_the_arm() {
        let node = Node::new();
        let blocked = node
            .live
            .with_file_name(".wsmp-recovery-AAAAAAAAAAAAAAAAAAAAAA");
        std::fs::create_dir_all(blocked.join("in-the-way")).expect("dir");
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let url = serve(archive.clone());
        let mut progress = Recorded::default();
        let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(progress.phases().last(), Some(&UpdatePhase::Failed));
        assert!(node.live_text().contains("0.4.2"));
        assert!(node.scheduler.registered.borrow().is_none());
        assert_eq!(*node.scheduler.registrations.borrow(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_crash_looping_build_rolls_itself_back_and_a_lost_dead_man_is_re_armed() {
        let (node, saved) = swapped_node();
        // The dead-man went missing: the first start re-arms it.
        *node.scheduler.registered.borrow_mut() = None;
        let sha = node.live_sha();
        let first_at = saved.deadline + 10;
        let first = on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&sha),
            2,
            first_at,
        )
        .expect("start");
        assert!(matches!(first, OnStart::AwaitConfirm(_)));
        assert!(node.scheduler.registered.borrow().is_some());
        let rearmed = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        // The window counts from the start.
        assert_eq!(
            rearmed.deadline,
            first_at + u64::from(saved.rollback_after_secs)
        );
        assert_eq!(rearmed.deadman_at, rearmed.deadline.into());
        assert!(matches!(
            on_start(
                &node.update_dir(),
                Some(&node.scheduler),
                new_build(&sha),
                2,
                first_at + 5
            )
            .expect("start"),
            OnStart::AwaitConfirm(_)
        ));
        assert_eq!(
            on_start(
                &node.update_dir(),
                Some(&node.scheduler),
                new_build(&sha),
                2,
                first_at + 10
            )
            .expect("start"),
            OnStart::RolledBackSelf
        );
        assert!(node.live_text().contains("0.4.2"));
        assert!(node.scheduler.registered.borrow().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_dead_man_that_starts_at_once_leaves_an_install_in_progress_alone() {
        // macOS `RunAtLoad`: the job runs while the installer is between arming and the swap.
        let node = Node::new();
        let mut armed = state::sample(node.live.parent().expect("bin"), Phase::Armed);
        armed.live_path = node.live.clone();
        armed.deadline = 1_793_188_890;
        state::save(&node.update_dir(), &armed).expect("save");
        let new = Layout::beside(&armed.live_path, &armed.update_id)
            .expect("layout")
            .new;
        std::fs::write(&new, b"new build").expect("staged");
        let early = rollback_if_unconfirmed(
            &node.update_dir(),
            &armed.update_id,
            armed.deadline - 60,
            None,
            || None,
        )
        .expect("check");
        assert_eq!(early, Rollback::NotDue(Duration::from_secs(60)));
        assert!(new.exists(), "the staged build stays");
        let still = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(still.phase, Phase::Armed);
    }

    #[cfg(unix)]
    #[test]
    fn a_reboot_during_the_trial_gives_the_new_build_a_full_window() {
        let (node, saved) = swapped_node();
        let window = u64::from(saved.rollback_after_secs);
        let armed_at = saved.deadline - window;
        // Off past the deadline; the dead-man fires at boot, 5 s after the machine started.
        let boot = saved.deadline + 600;
        let at_boot = rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            boot + 5,
            Some(boot),
            || None,
        )
        .expect("at boot");
        assert_eq!(at_boot, Rollback::NotDue(Duration::from_secs(window - 5)));
        assert!(node.live_text().contains("0.4.3"), "not rolled back yet");
        // A boot before the update was armed changes nothing.
        let earlier_boot = rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline,
            Some(armed_at - 3600),
            || None,
        )
        .expect("old boot");
        assert_eq!(earlier_boot, Rollback::RolledBack);
    }

    #[cfg(unix)]
    #[test]
    fn an_update_interrupted_before_the_swap_fails_safe() {
        let node = Node::new();
        let mut armed = state::sample(node.live.parent().expect("bin"), Phase::Armed);
        armed.live_path = node.live.clone();
        state::save(&node.update_dir(), &armed).expect("save");
        let new = Layout::beside(&armed.live_path, &armed.update_id)
            .expect("layout")
            .new;
        std::fs::write(&new, b"new build").expect("staged");
        let start =
            on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, 0).expect("start");
        let OnStart::Report(report) = start else {
            panic!("expected a report, got {start:?}");
        };
        assert_eq!(report.phase, Phase::Failed);
        assert!(node.live_text().contains("0.4.2"));
        assert!(!new.exists(), "the staged build is removed");
        // The dead-man for an update that never swapped moves nothing.
        std::fs::write(&new, b"new build").expect("staged");
        state::save(&node.update_dir(), &armed).expect("save");
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                &armed.update_id,
                u64::MAX / 2,
                None,
                || None
            )
            .expect("check"),
            Rollback::NeverSwapped
        );
        assert!(node.live_text().contains("0.4.2"));
    }

    #[cfg(unix)]
    #[test]
    fn a_swap_whose_state_was_never_saved_is_still_rolled_back() {
        // The installer died between the swap and saving `swapped`.
        let (node, mut saved) = swapped_node();
        saved.phase = Phase::Armed;
        state::save(&node.update_dir(), &saved).expect("save");
        let due = rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline,
            None,
            || None,
        )
        .expect("due");
        assert_eq!(due, Rollback::RolledBack);
        assert!(node.live_text().contains("0.4.2"));
    }

    #[cfg(unix)]
    #[test]
    fn a_build_rolled_back_first_never_confirms() {
        let (node, saved) = swapped_node();
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                &saved.update_id,
                saved.deadline,
                None,
                || None
            )
            .expect("due"),
            Rollback::RolledBack
        );
        assert_eq!(
            confirm(&node.update_dir(), None, &saved.update_id, |_| None).expect("confirm"),
            Confirm::RolledBack
        );
        assert_eq!(
            state::load(&node.update_dir())
                .expect("load")
                .expect("state")
                .phase,
            Phase::RolledBack
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_lock_keeps_the_dead_man_and_a_confirmation_apart() {
        let (node, saved) = swapped_node();
        let held = state::UpdateLock::acquire(&node.update_dir())
            .expect("lock")
            .expect("free");
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                &saved.update_id,
                saved.deadline,
                None,
                || None
            )
            .expect("locked"),
            Rollback::NotDue(LOCKED_RETRY)
        );
        assert!(confirm(&node.update_dir(), None, &saved.update_id, |_| None).is_err());
        assert!(node.live_text().contains("0.4.3"), "nothing moved");
        drop(held);
        assert!(matches!(
            confirm(&node.update_dir(), None, &saved.update_id, |_| None).expect("confirm"),
            Confirm::Confirmed(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn another_build_of_the_same_version_is_not_the_update() {
        // The install stopped before the swap; the old build has the same version.
        let (node, saved) = swapped_node();
        let other = on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&"0".repeat(64)),
            3,
            0,
        )
        .expect("start");
        let OnStart::Report(report) = other else {
            panic!("expected a report, got {other:?}");
        };
        assert_eq!(report.update_id, saved.update_id);
        assert_eq!(report.phase, Phase::Failed);
    }

    #[cfg(unix)]
    #[test]
    fn the_window_counts_from_the_new_builds_start() {
        let (node, saved) = swapped_node();
        let window = u64::from(saved.rollback_after_secs);
        // A slow restart: the new build starts just before the first deadline.
        let started = saved.deadline - 1;
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&node.live_sha()),
            3,
            started,
        )
        .expect("start");
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                &saved.update_id,
                saved.deadline,
                None,
                || None
            )
            .expect("first deadline"),
            Rollback::NotDue(Duration::from_secs(window - 1))
        );
        assert!(node.live_text().contains("0.4.3"));
    }

    #[cfg(unix)]
    #[test]
    fn a_node_busy_again_before_the_swap_is_left_alone() {
        let node = Node::new();
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let url = serve(archive.clone());
        let busy = |_: &mut dyn Progress| Err("an instance started".to_string());
        let machine = Machine {
            before_swap: Some(&busy),
            ..node.machine()
        };
        let mut progress = Recorded::default();
        let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(progress.last_reason(), Some(UpdateReason::Busy));
        node.untouched();
        assert_eq!(state::load(&node.update_dir()).expect("load"), None);
    }

    /// F-FA-1: full control and the operator's setting are asked again after
    /// the dead-man is armed, right before the swap. Lowered while the
    /// service manager registers the dead-man: refused (the reason the gate
    /// gives), the old build stays, the state is ended (failed, with that
    /// reason, to be reported) and the dead-man removed. Inverses: lowered
    /// before the arm refuses with nothing armed or recorded; never lowered
    /// swaps.
    #[cfg(unix)]
    #[test]
    fn a_node_lowered_while_the_dead_man_registers_is_not_swapped() {
        use std::cell::Cell;
        use std::rc::Rc;
        let lowered_detail = "the node was lowered to Relay only; wsmp was not upgraded";
        for when in ["during the arm", "before the arm", "never"] {
            let node = Node::new();
            let lowered = Rc::new(Cell::new(false));
            let gate = {
                let lowered = Rc::clone(&lowered);
                move || -> std::result::Result<(), (UpdateReason, String)> {
                    if lowered.get() {
                        Err((UpdateReason::NotOwnerTrust, lowered_detail.to_string()))
                    } else {
                        Ok(())
                    }
                }
            };
            // The last step before the arm: the idle check.
            let before = {
                let lowered = Rc::clone(&lowered);
                move |_: &mut dyn Progress| -> std::result::Result<(), String> {
                    if when == "before the arm" {
                        lowered.set(true);
                    }
                    Ok(())
                }
            };
            if when == "during the arm" {
                let lowered = Rc::clone(&lowered);
                *node.scheduler.during_register.borrow_mut() =
                    Some(Box::new(move || lowered.set(true)));
            }
            let machine = Machine {
                proceed: Some(&gate),
                before_swap: Some(&before),
                ..node.machine()
            };
            let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
            let url = serve(archive.clone());
            let mut progress = Recorded::default();
            let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
            let saved = state::load(&node.update_dir()).expect("load");
            match when {
                "during the arm" => {
                    assert_eq!(ended, Ended::Stopped, "{:?}", progress.0);
                    assert_eq!(
                        progress.phases(),
                        [
                            UpdatePhase::Downloading,
                            UpdatePhase::Verifying,
                            UpdatePhase::Armed,
                            UpdatePhase::Refused
                        ]
                    );
                    assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
                    assert!(node.live_text().contains("0.4.2"), "the old build stays");
                    assert_eq!(*node.scheduler.registrations.borrow(), 1);
                    assert!(
                        node.scheduler.registered.borrow().is_none(),
                        "the dead-man is removed"
                    );
                    let saved = saved.expect("state");
                    assert_eq!(saved.phase, Phase::Failed);
                    assert_eq!(saved.reason, Some(UpdateReason::NotOwnerTrust));
                    assert!(saved.needs_report());
                    assert!(
                        !node.live.with_file_name("wsmp.new").exists(),
                        "the new build is not left beside the live one"
                    );
                    // A dead-man that could not be removed finds it settled.
                    assert_eq!(
                        rollback_if_unconfirmed(
                            &node.update_dir(),
                            &saved.update_id,
                            u64::MAX / 2,
                            None,
                            || None
                        )
                        .expect("check"),
                        Rollback::Settled
                    );
                    assert!(node.live_text().contains("0.4.2"));
                }
                "before the arm" => {
                    assert_eq!(ended, Ended::Stopped);
                    assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
                    assert!(!progress.phases().contains(&UpdatePhase::Armed));
                    assert_eq!(*node.scheduler.registrations.borrow(), 0);
                    node.untouched();
                    assert_eq!(saved, None);
                }
                _ => {
                    assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
                    assert!(node.live_text().contains("0.4.3"));
                    assert!(node.scheduler.registered.borrow().is_some(), "armed");
                    assert_eq!(saved.expect("state").phase, Phase::Swapped);
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_waiting_dead_man_sees_its_update_settle_without_the_lock() {
        let (node, saved) = swapped_node();
        assert_eq!(no_longer_due(&node.update_dir(), &saved.update_id), None);
        let _held = state::UpdateLock::acquire(&node.update_dir())
            .expect("lock")
            .expect("free");
        let mut done = saved.clone();
        done.advance(Phase::Confirmed).expect("confirm");
        state::save(&node.update_dir(), &done).expect("save");
        assert_eq!(
            no_longer_due(&node.update_dir(), &saved.update_id),
            Some(Rollback::Settled)
        );
        assert_eq!(
            no_longer_due(&node.update_dir(), "BBBBBBBBBBBBBBBBBBBBBB"),
            Some(Rollback::NotOurs)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_homebrew_update_records_the_new_kegs_build() {
        let node = Node::new();
        let prefix = node.root.path().join("brew");
        let new_keg = prefix.join("Cellar/wsmp/0.4.3/bin");
        std::fs::create_dir_all(&new_keg).expect("keg");
        std::fs::write(new_keg.join("wsmp"), "new build").expect("binary");
        let opt = prefix.join("opt/wsmp");
        std::fs::create_dir_all(opt.parent().expect("opt")).expect("opt dir");
        std::os::unix::fs::symlink(prefix.join("Cellar/wsmp/0.4.3"), &opt).expect("link");
        let stable = opt.join("bin/wsmp");
        record_homebrew(
            &node.machine(),
            &request(String::new(), String::new()),
            &stable,
        )
        .expect("record");
        let saved = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(
            saved.to_sha256.as_deref(),
            Some(sha(b"new build").as_str()),
            "the new keg's binary, not the running one"
        );
        assert_eq!(saved.live_path, stable);
    }

    #[test]
    fn archive_names_come_from_the_url() {
        assert_eq!(
            archive_name("https://h/releases/download/v1/wsmp-x86_64-unknown-linux-gnu.tar.xz?x=1"),
            "wsmp-x86_64-unknown-linux-gnu.tar.xz"
        );
        assert_eq!(archive_name("https://h/"), "wsmp-update-archive");
        assert_eq!(archive_name("https://h/..%2f"), "wsmp-update-archive");
    }

    /// The state directory stops taking writes while the dead-man registers
    /// (`update_dir` becomes a plain file; the real directory, with the
    /// durable `armed` state in it, is kept aside), and the node is lowered
    /// at the same moment. `restore_after`: when to put the directory back
    /// (`None`: only by hand, after the update returned).
    #[cfg(unix)]
    fn revoked_while_storage_fails(
        restore_after: Option<Duration>,
    ) -> (Node, Ended, Recorded, PathBuf) {
        use std::cell::Cell;
        use std::rc::Rc;
        let node = Node::new();
        let held = node.root.path().join("held-state");
        let lowered = Rc::new(Cell::new(false));
        {
            let lowered = Rc::clone(&lowered);
            let (update_dir, held) = (node.update_dir(), held.clone());
            *node.scheduler.during_register.borrow_mut() = Some(Box::new(move || {
                std::fs::rename(&update_dir, &held).expect("aside");
                std::fs::write(&update_dir, b"not a directory").expect("block");
                lowered.set(true);
                if let Some(after) = restore_after {
                    let (update_dir, held) = (update_dir.clone(), held.clone());
                    std::thread::spawn(move || {
                        std::thread::sleep(after);
                        std::fs::remove_file(&update_dir).expect("unblock");
                        std::fs::rename(&held, &update_dir).expect("back");
                    });
                }
            }));
        }
        let gate = {
            let lowered = Rc::clone(&lowered);
            move || -> std::result::Result<(), (UpdateReason, String)> {
                if lowered.get() {
                    Err((UpdateReason::NotOwnerTrust, "lowered during the arm".into()))
                } else {
                    Ok(())
                }
            }
        };
        let machine = Machine {
            proceed: Some(&gate),
            ..node.machine()
        };
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let mut progress = Recorded::default();
        let ended = self_replace(
            &machine,
            &request(serve(archive.clone()), sha(&archive)),
            &mut progress,
        );
        (node, ended, progress, held)
    }

    /// F-FA-3 (the reviewer's `fa_revocation_save_failure_must_keep_a_recovery_trigger`):
    /// refused after the arm while the terminal state cannot be saved at
    /// all. The dead-man stays armed, and `wsmp.new` (its evidence that no
    /// swap happened) stays beside the live binary; once storage works again
    /// the dead-man's own check settles the update (`NeverSwapped`, `failed`)
    /// with the old build in place, and later updates are free again.
    #[cfg(unix)]
    #[test]
    fn fa_revocation_save_failure_must_keep_a_recovery_trigger() {
        let (node, ended, progress, held) = revoked_while_storage_fails(None);
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
        assert!(node.live_text().contains("0.4.2"), "the old build stays");
        assert!(
            node.scheduler.registered.borrow().is_some(),
            "the dead-man stays armed while the end is not durable"
        );
        assert_eq!(*node.scheduler.removals.borrow(), 0);
        assert!(
            node.live.with_file_name("wsmp.new").exists(),
            "the dead-man's evidence (no swap) is kept"
        );
        // Storage works again; the durable state is still `armed`.
        std::fs::remove_file(node.update_dir()).expect("unblock");
        std::fs::rename(&held, node.update_dir()).expect("back");
        let durable = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(durable.phase, Phase::Armed);
        // The dead-man fires at its deadline: nothing was swapped, so it
        // records the end itself and moves nothing.
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                &durable.update_id,
                durable.deadline + 2,
                None,
                || None,
            )
            .expect("dead-man"),
            Rollback::NeverSwapped
        );
        let settled = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(settled.phase, Phase::Failed);
        assert!(!settled.phase.in_progress(), "later updates are free again");
        assert!(!node.live.with_file_name("wsmp.new").exists());
        assert!(node.live_text().contains("0.4.2"));
    }

    /// Inverse: a save that fails once and then works (a transient error)
    /// is tried again; once the end is durable the dead-man is removed and
    /// nothing is left beside the live binary, as with no fault at all.
    #[cfg(unix)]
    #[test]
    fn a_terminal_save_that_fails_once_is_tried_again_before_the_dead_man_goes() {
        let (node, ended, progress, _held) =
            revoked_while_storage_fails(Some(Duration::from_millis(10)));
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
        let saved = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(saved.phase, Phase::Failed);
        assert_eq!(saved.reason, Some(UpdateReason::NotOwnerTrust));
        assert!(
            node.scheduler.registered.borrow().is_none(),
            "removed once durable"
        );
        assert!(!node.live.with_file_name("wsmp.new").exists());
        assert!(node.live_text().contains("0.4.2"));
    }

    /// A scheduler whose registration fails after it made the state directory unwritable (the
    /// installer's terminal saves then fail too), with no job installed (F-FA-3, review P8).
    #[cfg(unix)]
    struct Unarmed<'a> {
        dir: PathBuf,
        held: PathBuf,
        registered: &'a std::cell::Cell<bool>,
    }

    #[cfg(unix)]
    impl Scheduler for Unarmed<'_> {
        fn present(&self) -> Result<bool> {
            Ok(self.registered.get())
        }
        fn running(&self) -> Result<bool> {
            Ok(false)
        }
        fn register(&self, _: &DeadmanSpec) -> Result<()> {
            std::fs::rename(&self.dir, &self.held)?;
            std::fs::write(&self.dir, b"temporarily not a directory")?;
            anyhow::bail!("service manager temporarily unavailable")
        }
        fn remove(&self) -> Result<()> {
            self.registered.set(false);
            Ok(())
        }
    }

    /// Review P8 (F-FA-3), with the fixed expectation: arming fails and every terminal save
    /// fails, so the installer leaves a durable `armed` state and no dead-man. Once storage is
    /// back, the next attempt, under the update lock, settles it (instead of refusing every
    /// update until the relay restarts), and the update after it installs.
    #[cfg(unix)]
    #[test]
    fn fa_unarmed_terminal_save_failure_has_no_recovery_trigger() {
        let node = Node::new();
        let registered = std::cell::Cell::new(false);
        let held = node.root.path().join("held-state");
        let scheduler = Unarmed {
            dir: node.update_dir(),
            held: held.clone(),
            registered: &registered,
        };
        let machine = Machine {
            scheduler: Some(&scheduler),
            ..node.machine()
        };
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let mut reports = Recorded::default();
        assert_eq!(
            self_replace(
                &machine,
                &request(serve(archive.clone()), sha(&archive)),
                &mut reports
            ),
            Ended::Stopped
        );
        assert_eq!(reports.last_reason(), Some(UpdateReason::Internal));
        std::fs::remove_file(node.update_dir()).expect("storage restored");
        std::fs::rename(&held, node.update_dir()).expect("directory restored");
        let stranded = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(stranded.phase, Phase::Armed);
        assert!(!registered.get(), "no dead-man exists to settle this state");
        assert!(node.live.with_file_name("wsmp.new").exists());

        // The next attempt: its lock proves no installer, dead-man run or confirmation is active.
        let lock = state::UpdateLock::acquire(&node.update_dir())
            .expect("lock")
            .expect("free");
        assert!(settle_abandoned(&node.update_dir(), Some(&scheduler), &lock).expect("settle"));
        let settled = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(settled.phase, Phase::Failed);
        assert_eq!(settled.reason, Some(UpdateReason::Internal));
        assert!(!node.live.with_file_name("wsmp.new").exists());
        assert!(node.live_text().contains("0.4.2"), "nothing was moved");

        // And the update after it goes through.
        let mut reports = Recorded::default();
        let mut next = request(serve(archive.clone()), sha(&archive));
        next.update_id = "BBBBBBBBBBBBBBBBBBBBBB".into();
        assert_eq!(
            self_replace(&node.machine(), &next, &mut reports),
            Ended::Swapped
        );
        drop(lock);
    }

    /// The inverse of the settle: an `armed` state that still has an owner is never settled by
    /// a later attempt. Its dead-man is registered; its swap began (`wsmp.new` gone: the new build
    /// may be live); or the scheduler cannot say whether a job is registered.
    #[cfg(unix)]
    #[test]
    fn a_later_attempt_leaves_an_armed_update_that_still_has_an_owner() {
        struct Unsure;
        impl Scheduler for Unsure {
            fn present(&self) -> Result<bool> {
                anyhow::bail!("the service manager did not answer")
            }
            fn running(&self) -> Result<bool> {
                Ok(false)
            }
            fn register(&self, _: &DeadmanSpec) -> Result<()> {
                Ok(())
            }
            fn remove(&self) -> Result<()> {
                Ok(())
            }
        }
        let node = Node::new();
        let update_dir = node.update_dir();
        let mut armed = state::sample(node.live.parent().expect("bin"), Phase::Armed);
        armed.live_path = node.live.clone();
        state::save(&update_dir, &armed).expect("save");
        let new = node.live.with_file_name("wsmp.new");
        std::fs::write(&new, "new").expect("new");
        let lock = state::UpdateLock::acquire(&update_dir)
            .expect("lock")
            .expect("free");
        let still_armed = || {
            state::load(&update_dir)
                .expect("load")
                .expect("state")
                .phase
                == Phase::Armed
        };

        // A registered dead-man owns it.
        let spec = DeadmanSpec::new(
            armed.update_id.clone(),
            &armed.prev_path,
            &node.state_dir(),
            Duration::from_secs(90),
        )
        .expect("spec");
        node.scheduler.register(&spec).expect("register");
        assert!(!settle_abandoned(&update_dir, Some(&node.scheduler), &lock).expect("look"));
        assert!(still_armed());
        node.scheduler.remove().expect("remove");

        // A scheduler that cannot tell: not settled (the error is the caller's to log).
        assert!(settle_abandoned(&update_dir, Some(&Unsure), &lock).is_err());
        assert!(still_armed());

        // The swap began: the dead-man or the next start decides what is live.
        std::fs::remove_file(&new).expect("swap began");
        assert!(!settle_abandoned(&update_dir, Some(&node.scheduler), &lock).expect("look"));
        assert!(still_armed());

        // Control: pre-swap, no job, lock held: settled.
        std::fs::write(&new, "new").expect("new");
        assert!(settle_abandoned(&update_dir, Some(&node.scheduler), &lock).expect("settle"));
        assert!(!still_armed());
    }

    /// Swaps, then lets the dead-man's restore run and fails the `rolled_back` save right after
    /// it (through the log-tail callback, which runs between the two), then puts storage back.
    #[cfg(unix)]
    fn rollback_whose_save_failed() -> (Node, UpdateState) {
        let (node, current) = swapped_node();
        let held = node.root.path().join("held-rollback-state");
        let failed = rollback_if_unconfirmed(
            &node.update_dir(),
            &current.update_id,
            current.deadline + 2,
            None,
            || {
                std::fs::rename(node.update_dir(), &held).expect("block the save");
                std::fs::write(node.update_dir(), b"not a directory").expect("block");
                None
            },
        );
        assert!(failed.is_err());
        assert!(
            node.live_text().contains("0.4.2"),
            "restored before the save failed"
        );
        assert!(!current.prev_path.exists(), "the restore consumed the copy");
        std::fs::remove_file(node.update_dir()).expect("unblock");
        std::fs::rename(&held, node.update_dir()).expect("storage back");
        let stored = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(stored.phase, Phase::Swapped);
        assert!(
            stored.rolling_back,
            "the intent was saved before the restore"
        );
        (node, current)
    }

    /// Review P13 (F-FA-4), with the fixed expectations. The restore ran and its `rolled_back`
    /// save failed. A confirmation (the new build, still running) must not certify the install
    /// the rollback replaced, nor remove the dead-man; the dead-man's next run recognises the
    /// completed restore and records it (it found no copy before: `NoCopy`, and no restart).
    #[cfg(unix)]
    #[test]
    fn fa_rollback_save_failure_can_confirm_the_restored_old_binary() {
        for observer in ["confirm", "retry_rollback"] {
            let (node, current) = rollback_whose_save_failed();
            if observer == "confirm" {
                let confirmed = confirm(
                    &node.update_dir(),
                    Some(&node.scheduler),
                    &current.update_id,
                    |_| None,
                )
                .expect("confirm");
                assert_eq!(confirmed, Confirm::RolledBack);
                assert!(node.live_text().contains("0.4.2"));
                assert!(
                    node.scheduler.registered.borrow().is_some(),
                    "the dead-man stays to finish the rollback"
                );
                let stored = state::load(&node.update_dir())
                    .expect("load")
                    .expect("state");
                assert_ne!(stored.phase, Phase::Confirmed);
            }
            // The dead-man's next run (at once: a decided rollback does not wait for a deadline).
            assert_eq!(
                rollback_if_unconfirmed(
                    &node.update_dir(),
                    &current.update_id,
                    current.deadline.saturating_sub(1_000),
                    None,
                    || None,
                )
                .expect("replay"),
                Rollback::RolledBack
            );
            let done = state::load(&node.update_dir())
                .expect("load")
                .expect("state");
            assert_eq!(done.phase, Phase::RolledBack);
            assert!(!done.rolling_back);
            assert!(
                done.restart_pending,
                "the replay still owes the relay a restart"
            );
            assert!(node.live_text().contains("0.4.2"));
        }
    }

    /// Both rollback sites record their intent before the restore: a restore that fails (here:
    /// the binary's directory cannot be written) finds `rolling_back` already durable, and the
    /// next look finishes the rollback (the dead-man at once, a start as the crash-loop). Without
    /// the intent first, the state would still read as a plain unconfirmed update.
    #[cfg(unix)]
    #[test]
    fn both_rollbacks_record_their_intent_before_the_restore() {
        use std::os::unix::fs::PermissionsExt;
        // Root writes into a read-only directory: the failure cannot be staged.
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        for site in ["deadman", "crash_loop"] {
            let (node, current) = swapped_node();
            let sha = node.live_sha();
            let dir = node.update_dir();
            let bin = node.live.parent().expect("bin").to_path_buf();
            let look = || {
                if site == "deadman" {
                    rollback_if_unconfirmed(
                        &dir,
                        &current.update_id,
                        current.deadline + 2,
                        None,
                        || None,
                    )
                    .map(|_| ())
                } else {
                    on_start(&dir, Some(&node.scheduler), new_build(&sha), 0, 0).map(|_| ())
                }
            };
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o500)).expect("ro");
            let result = look();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("rw");
            assert!(result.is_err(), "{site}: the restore failed");
            assert_eq!(node.live_sha(), sha, "{site}: nothing restored");
            assert!(
                current.prev_path.exists(),
                "{site}: the copy is still there"
            );
            let stored = state::load(&dir).expect("load").expect("state");
            assert_eq!(stored.phase, Phase::Swapped, "{site}");
            assert!(stored.rolling_back, "{site}: the intent was durable first");
            // The next look finishes it.
            look().expect("finished");
            let done = state::load(&dir).expect("load").expect("state");
            assert_eq!(done.phase, Phase::RolledBack, "{site}");
            assert!(node.live_text().contains("0.4.2"), "{site}");
        }
    }

    /// The crash-loop sibling (F-FA-4): a rollback decided and begun, then interrupted (the
    /// restore done, `rolled_back` not saved), is finished by the next start, by the dead-man,
    /// and refused by a confirmation, whichever comes first. One whose restore did not run yet
    /// is finished the same way.
    #[cfg(unix)]
    #[test]
    fn an_interrupted_rollback_is_finished_by_whoever_comes_next() {
        for (restored, next) in [
            (true, "start_old"),
            (true, "deadman"),
            (true, "confirm"),
            (false, "start_new"),
            (false, "deadman"),
            // Decided, not begun: the new build is still installed, and still not confirmed.
            (false, "confirm"),
        ] {
            let (node, current) = swapped_node();
            let sha = node.live_sha();
            let mut interrupted = current.clone();
            interrupted.rolling_back = true;
            state::save(&node.update_dir(), &interrupted).expect("intent");
            if restored {
                let layout = layout_of(&current).expect("layout");
                assert!(install::restore(&layout).expect("restore"));
            }
            match next {
                "start_old" => assert!(matches!(
                    on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, 0)
                        .expect("start"),
                    OnStart::Report(_)
                )),
                "start_new" => assert_eq!(
                    on_start(
                        &node.update_dir(),
                        Some(&node.scheduler),
                        new_build(&sha),
                        3,
                        0
                    )
                    .expect("start"),
                    OnStart::RolledBackSelf
                ),
                "deadman" => assert_eq!(
                    rollback_if_unconfirmed(
                        &node.update_dir(),
                        &current.update_id,
                        0,
                        None,
                        || None
                    )
                    .expect("replay"),
                    Rollback::RolledBack
                ),
                _ => {
                    assert_eq!(
                        confirm(
                            &node.update_dir(),
                            Some(&node.scheduler),
                            &current.update_id,
                            |_| None
                        )
                        .expect("confirm"),
                        Confirm::RolledBack
                    );
                    assert!(node.scheduler.registered.borrow().is_some());
                    continue;
                }
            }
            let done = state::load(&node.update_dir())
                .expect("load")
                .expect("state");
            assert_eq!(done.phase, Phase::RolledBack, "{restored} {next}");
            assert!(!done.rolling_back);
            assert!(node.live_text().contains("0.4.2"), "{restored} {next}");
            assert!(!current.prev_path.exists());
        }
    }

    /// The inverse of the confirmation check: a build whose bytes are this update's confirms (the
    /// check reads the installed binary, not only the phase); one whose bytes are not does not.
    #[cfg(unix)]
    #[test]
    fn a_confirmation_certifies_only_the_installed_new_build() {
        let (node, current) = swapped_node();
        assert!(matches!(
            confirm(
                &node.update_dir(),
                Some(&node.scheduler),
                &current.update_id,
                |_| None
            )
            .expect("confirm"),
            Confirm::Confirmed(_)
        ));
        let (node, current) = swapped_node();
        std::fs::write(&node.live, "#!/bin/sh\necho 'wsmp 0.4.2'\n").expect("replaced");
        assert_eq!(
            confirm(
                &node.update_dir(),
                Some(&node.scheduler),
                &current.update_id,
                |_| None
            )
            .expect("confirm"),
            Confirm::RolledBack
        );
        assert_eq!(
            state::load(&node.update_dir())
                .expect("load")
                .expect("state")
                .phase,
            Phase::Swapped
        );
    }
}
