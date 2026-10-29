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
    /// Refused or failed; the progress already says why. Nothing was changed.
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
    let ended = install_files(machine, request, &layout, progress);
    if ended == Ended::Stopped {
        install::clean(&layout);
    } else {
        let _ = std::fs::remove_dir_all(&layout.staging);
    }
    ended
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
    let failed = |current: &mut UpdateState, progress: &mut dyn Progress, detail: String| {
        if current.fail(UpdateReason::Internal, detail.clone()).is_ok() {
            // Reported again on later sessions until the server acknowledges it.
            let _ = state::save(&update_dir, current);
        }
        stop(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            detail,
        )
    };
    if let Some(scheduler) = machine.scheduler {
        let spec = DeadmanSpec {
            update_id: request.update_id.clone(),
            prev: layout.prev.clone(),
            state_dir: machine.state_dir.clone(),
            fire_in: Duration::from_secs(u64::from(request.rollback_after_secs)),
        };
        if let Err(error) = super::deadman::arm(scheduler, &spec, super::deadman::ARM_WAIT) {
            return failed(
                &mut current,
                progress,
                format!("arming the rollback: {error:#}"),
            );
        }
        progress.report(UpdatePhase::Armed, None, None);
    }
    if let Err(error) = install::swap(layout) {
        if let Some(scheduler) = machine.scheduler {
            let _ = super::deadman::disarm(scheduler);
        }
        return failed(&mut current, progress, format!("{error:#}"));
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
        failed_path: stable.to_path_buf(),
        rollback_after_secs: request.rollback_after_secs,
        deadline: now + u64::from(request.rollback_after_secs),
        deadman_at: None,
        attempts: 0,
        phase: Phase::Swapped,
        reason: None,
        detail: None,
        reported: false,
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
    Ok(Layout {
        live: current.live_path.clone(),
        prev: current.prev_path.clone(),
        failed: current.failed_path.clone(),
        ..Layout::beside(&current.live_path, &current.update_id)?
    })
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
    if !install::restore(&layout)? {
        current.fail(
            UpdateReason::Internal,
            "the new build did not confirm and there is no rollback copy",
        )?;
        state::save(update_dir, &current)?;
        return Ok(Rollback::NoCopy);
    }
    install::clear_retired(&layout.live);
    current.advance(Phase::RolledBack)?;
    current.detail = log_tail().map(|tail| super::clip_detail(&tail));
    state::save(update_dir, &current)?;
    Ok(Rollback::RolledBack)
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
    match current.phase {
        Phase::Armed => current.advance(Phase::Swapped)?,
        Phase::Swapped => {}
        Phase::RolledBack => return Ok(Confirm::RolledBack),
        Phase::Confirmed | Phase::Failed => return Ok(Confirm::NotOurs),
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
        return Ok(if current.needs_report() {
            OnStart::Report(current)
        } else {
            OnStart::Nothing
        });
    }
    if !current.is_new_build(running.version, running.sha256) {
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
        if install::restore(&layout)? {
            install::clear_retired(&layout.live);
            current.advance(Phase::RolledBack)?;
            current.detail = Some(format!(
                "wsmp {} started {max_starts} times without confirming",
                running.version
            ));
            state::save(update_dir, &current)?;
            if let Some(scheduler) = scheduler {
                let _ = super::deadman::disarm(scheduler);
            }
            return Ok(OnStart::RolledBackSelf);
        }
    }
    // The window counts from this start: a dead-man that fires at the old
    // deadline finds the update not due and waits.
    current.deadline = current
        .deadline
        .max(now + u64::from(current.rollback_after_secs));
    if let Some(scheduler) = scheduler
        && current.attempts <= max_starts
        && deadman_lost(scheduler, current.deadman_at, now)
    {
        let spec = DeadmanSpec {
            update_id: current.update_id.clone(),
            prev: current.prev_path.clone(),
            state_dir: update_dir
                .parent()
                .context("the update directory has no parent")?
                .to_path_buf(),
            fire_in: Duration::from_secs(current.deadline.saturating_sub(now)),
        };
        match super::deadman::arm(scheduler, &spec, super::deadman::ARM_WAIT) {
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
        assert_eq!(spec.prev, prev);
        assert_eq!(spec.fire_in, Duration::from_secs(90));
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
                .map(|spec| spec.fire_in),
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
}
