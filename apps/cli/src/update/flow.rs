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

    // The rollback copy exists before the state that names it.
    let update_dir = machine.update_dir();
    let mut current = UpdateState {
        update_id: request.update_id.clone(),
        origin: request.origin,
        strategy: UpdateStrategy::SelfReplace,
        from_version: machine.current_version.clone(),
        to_version: request.version.clone(),
        live_path: layout.live.clone(),
        prev_path: layout.prev.clone(),
        failed_path: layout.failed.clone(),
        rollback_after_secs: request.rollback_after_secs,
        deadline: super::unix_now() + u64::from(request.rollback_after_secs),
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
            // The progress says it; the server needs no second report.
            current.reported = true;
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
pub fn record_homebrew(machine: &Machine<'_>, request: &Request) -> Result<()> {
    let now = super::unix_now();
    let current = UpdateState {
        update_id: request.update_id.clone(),
        origin: request.origin,
        strategy: UpdateStrategy::Homebrew,
        from_version: machine.current_version.clone(),
        to_version: request.version.clone(),
        live_path: machine.live.clone(),
        prev_path: machine.live.clone(),
        failed_path: machine.live.clone(),
        rollback_after_secs: request.rollback_after_secs,
        deadline: now + u64::from(request.rollback_after_secs),
        attempts: 0,
        phase: Phase::Swapped,
        reason: None,
        detail: None,
        reported: false,
        updated_at: crate::file_ops::fmt::rfc3339_secs(now),
    };
    state::save(&machine.update_dir(), &current)
}

/// One look of the dead-man at the update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rollback {
    /// No such update (another one replaced it): nothing to do.
    NotOurs,
    /// Confirmed, already rolled back, or failed.
    Settled,
    /// Not due yet.
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
/// Nothing happens before the deadline, in any phase: a job that starts at
/// once (macOS `RunAtLoad`) must not take an update that is still being
/// installed (`Armed`) for an abandoned one. `booted_at` (Unix seconds) is when
/// the machine last started: after a reboot during the trial, the deadline is
/// a full window after the boot, so a build that comes up after the reboot can
/// still confirm before a dead-man that fires at boot rolls it back.
pub fn rollback_if_unconfirmed(
    update_dir: &Path,
    update_id: &str,
    now: u64,
    booted_at: Option<u64>,
    log_tail: impl FnOnce() -> Option<String>,
) -> Result<Rollback> {
    let Some(mut current) = state::load(update_dir)? else {
        return Ok(Rollback::NotOurs);
    };
    if current.update_id != update_id {
        return Ok(Rollback::NotOurs);
    }
    if matches!(
        current.phase,
        Phase::Confirmed | Phase::RolledBack | Phase::Failed
    ) {
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
    match current.phase {
        Phase::Confirmed | Phase::RolledBack | Phase::Failed => return Ok(Rollback::Settled),
        // Still armed at the deadline: the installer stopped before the swap.
        Phase::Armed => {
            current.fail(
                UpdateReason::Internal,
                "the update stopped before the swap; nothing was changed",
            )?;
            state::save(update_dir, &current)?;
            let _ =
                std::fs::remove_file(Layout::beside(&current.live_path, &current.update_id)?.new);
            return Ok(Rollback::NeverSwapped);
        }
        Phase::Swapped => {}
    }
    let layout = Layout {
        live: current.live_path.clone(),
        prev: current.prev_path.clone(),
        failed: current.failed_path.clone(),
        ..Layout::beside(&current.live_path, &current.update_id)?
    };
    if !install::restore(&layout)? {
        current.fail(
            UpdateReason::Internal,
            "the new build did not confirm and there is no rollback copy",
        )?;
        state::save(update_dir, &current)?;
        return Ok(Rollback::NoCopy);
    }
    current.advance(Phase::RolledBack)?;
    current.detail = log_tail().map(|tail| super::clip_detail(&tail));
    state::save(update_dir, &current)?;
    Ok(Rollback::RolledBack)
}

/// The new binary has met every condition: record `confirmed`, disarm the
/// dead-man and write the install receipt. The confirmed state, when it was
/// this binary's update.
pub fn confirm(
    update_dir: &Path,
    scheduler: Option<&dyn Scheduler>,
    current_version: &str,
    receipt: impl FnOnce(&UpdateState) -> Option<super::receipt::InstallReceipt>,
) -> Result<Option<UpdateState>> {
    let Some(mut current) = state::load(update_dir)? else {
        return Ok(None);
    };
    if current.to_version != current_version {
        return Ok(None);
    }
    if current.phase == Phase::Armed {
        current.advance(Phase::Swapped)?;
    }
    if current.phase != Phase::Swapped {
        return Ok(None);
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
    // The retired Windows binary is no longer running.
    if let Ok(layout) = Layout::beside(&current.live_path, &current.update_id) {
        let _ = std::fs::remove_file(layout.retired);
    }
    Ok(Some(current))
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

/// Look at the update state when the relay starts. A new binary that is
/// still unconfirmed counts the start, re-arms a dead-man that a reboot
/// lost, and rolls itself back after `max_starts` unconfirmed starts.
pub fn on_start(
    update_dir: &Path,
    scheduler: Option<&dyn Scheduler>,
    current_version: &str,
    max_starts: u32,
    now: u64,
) -> Result<OnStart> {
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
    if current.to_version != current_version {
        // This is not the new build: the swap did not happen or did not take.
        let why = if current.phase == Phase::Armed {
            "the update stopped before the swap; nothing was changed".to_string()
        } else {
            format!(
                "wsmp {current_version} started instead of {}",
                current.to_version
            )
        };
        if current.phase == Phase::Armed {
            let _ =
                std::fs::remove_file(Layout::beside(&current.live_path, &current.update_id)?.new);
        }
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
        let layout = Layout {
            live: current.live_path.clone(),
            prev: current.prev_path.clone(),
            failed: current.failed_path.clone(),
            ..Layout::beside(&current.live_path, &current.update_id)?
        };
        if install::restore(&layout)? {
            current.advance(Phase::RolledBack)?;
            current.detail = Some(format!(
                "wsmp {current_version} started {max_starts} times without confirming"
            ));
            state::save(update_dir, &current)?;
            if let Some(scheduler) = scheduler {
                let _ = super::deadman::disarm(scheduler);
            }
            return Ok(OnStart::RolledBackSelf);
        }
    }
    if let Some(scheduler) = scheduler
        && current.attempts <= max_starts
        && !scheduler.present().unwrap_or(true)
    {
        // A reboot dropped the dead-man (systemd's timer is transient).
        let spec = DeadmanSpec {
            update_id: current.update_id.clone(),
            prev: current.prev_path.clone(),
            state_dir: update_dir
                .parent()
                .context("the update directory has no parent")?
                .to_path_buf(),
            fire_in: Duration::from_secs(u64::from(current.rollback_after_secs)),
        };
        match super::deadman::arm(scheduler, &spec, super::deadman::ARM_WAIT) {
            Ok(()) => current.deadline = now + u64::from(current.rollback_after_secs),
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
            }
        }
        fn live_text(&self) -> String {
            std::fs::read_to_string(&self.live).expect("live")
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
        let start =
            on_start(&node.update_dir(), Some(&node.scheduler), "0.4.3", 3, 0).expect("start");
        assert!(matches!(start, OnStart::AwaitConfirm(ref s) if s.attempts == 1));
        assert_eq!(*node.scheduler.registrations.borrow(), 1);
        let confirmed = confirm(&node.update_dir(), Some(&node.scheduler), "0.4.3", |_| None)
            .expect("confirm")
            .expect("ours");
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
        assert!(!saved.needs_report(), "the progress already said it");
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
            on_start(&node.update_dir(), Some(&node.scheduler), "0.4.2", 3, 0).expect("start");
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
    fn a_crash_looping_build_rolls_itself_back_and_a_lost_dead_man_is_re_armed() {
        let (node, saved) = swapped_node();
        // A reboot dropped the transient timer: the first start re-arms it.
        *node.scheduler.registered.borrow_mut() = None;
        let first =
            on_start(&node.update_dir(), Some(&node.scheduler), "0.4.3", 2, 1_000).expect("start");
        assert!(matches!(first, OnStart::AwaitConfirm(_)));
        assert!(node.scheduler.registered.borrow().is_some());
        let rearmed = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(
            rearmed.deadline,
            1_000 + u64::from(saved.rollback_after_secs)
        );
        assert!(matches!(
            on_start(&node.update_dir(), Some(&node.scheduler), "0.4.3", 2, 1_005).expect("start"),
            OnStart::AwaitConfirm(_)
        ));
        assert_eq!(
            on_start(&node.update_dir(), Some(&node.scheduler), "0.4.3", 2, 1_010).expect("start"),
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
        let start =
            on_start(&node.update_dir(), Some(&node.scheduler), "0.4.2", 3, 0).expect("start");
        let OnStart::Report(report) = start else {
            panic!("expected a report, got {start:?}");
        };
        assert_eq!(report.phase, Phase::Failed);
        assert!(node.live_text().contains("0.4.2"));
        // The dead-man for an update that never swapped moves nothing.
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
