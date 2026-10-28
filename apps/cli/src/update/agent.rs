//! The relay's side of self-update: answering `agent.update` (the gates, the
//! worker thread that installs), confirming a new build once the session is
//! healthy, and reporting how an update ended after a restart.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use anyhow::Result;

use super::flow::{self, Ended, Machine, OnStart, Progress, Request};
use super::state::{self, Origin, UpdateState};
use crate::protocol::frames::{
    DefinitionSync, InstallMethod, NodeFrame, UpdatePhase, UpdateReason,
};
use crate::protocol::runtime_spec::{RemoteUpdates, SelfUpdateFeatures, UpdateStrategy};

/// A new build confirms after `hello.ok`, the definition sync and this long alive.
pub const CONFIRM_ALIVE: Duration = Duration::from_secs(30);
/// Unconfirmed starts of a new build before it rolls itself back.
pub const MAX_UNCONFIRMED_STARTS: u32 = 3;
/// How long an update waits for the node to go idle before `refused`/`busy`.
pub const IDLE_WAIT_MAX: Duration = Duration::from_secs(30 * 60);

/// Runtime instances keep running when the relay restarts: Linux runs them in
/// systemd user units and Windows in detached runtime hosts, and the next
/// relay adopts them. macOS only wraps services whose start commands must
/// hand them to launchd themselves; that is not verified, so it reports false.
pub fn instances_survive() -> bool {
    cfg!(any(target_os = "linux", windows))
}

/// The strategies this install can update itself with.
pub fn strategies(
    method: InstallMethod,
    has_live: bool,
    under_service: bool,
) -> Vec<UpdateStrategy> {
    if !under_service || !has_live {
        return Vec::new();
    }
    match method {
        InstallMethod::Script | InstallMethod::ScriptPs1 => vec![UpdateStrategy::SelfReplace],
        InstallMethod::Homebrew => vec![UpdateStrategy::Homebrew],
        _ => Vec::new(),
    }
}

fn remote_setting() -> RemoteUpdates {
    crate::config::Config::load_required()
        .map(|config| config.remote_updates)
        .unwrap_or_default()
}

/// The hello `features.selfUpdate`.
pub fn features() -> SelfUpdateFeatures {
    let identity = super::build::identity();
    SelfUpdateFeatures {
        strategies: strategies(
            identity.method,
            identity.live.is_some(),
            crate::daemon::under_service_manager(),
        ),
        instances_survive: instances_survive(),
        remote: remote_setting(),
    }
}

/// An `agent.update` as received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateFrame {
    pub update_id: String,
    pub version: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: Option<String>,
    pub force: bool,
    pub rollback_after_secs: u32,
}

/// What the relay knows when an update arrives.
#[derive(Debug, Clone, Copy)]
pub struct Gate {
    pub full_control: bool,
    pub remote: RemoteUpdates,
    pub method: InstallMethod,
    pub has_live: bool,
    pub under_service: bool,
}

/// The strategy for `frame`, or the refusal.
pub fn check_gate(gate: &Gate, version: &str) -> Result<UpdateStrategy, (UpdateReason, String)> {
    if !gate.full_control {
        return Err((
            UpdateReason::NotOwnerTrust,
            "the node is not at Full control; run `wsmp trust full` on it to allow updates".into(),
        ));
    }
    if gate.remote == RemoteUpdates::Off {
        return Err((
            UpdateReason::OptedOut,
            "this machine's operator turned remote updates off (`wsmp config set-remote-updates allowed` turns them back on)".into(),
        ));
    }
    let strategy = match gate.method {
        InstallMethod::Script | InstallMethod::ScriptPs1 => UpdateStrategy::SelfReplace,
        InstallMethod::Homebrew => UpdateStrategy::Homebrew,
        InstallMethod::Source => {
            return Err((UpdateReason::SourceBuild, super::source_command(version)));
        }
        InstallMethod::Unknown => {
            return Err((
                UpdateReason::UnsupportedMethod,
                super::UNKNOWN_METHOD.into(),
            ));
        }
        other => {
            return Err((
                UpdateReason::UnsupportedMethod,
                format!(
                    "this wsmp was installed with `{}`; update it the same way",
                    other.as_str()
                ),
            ));
        }
    };
    if !gate.has_live {
        return Err((
            UpdateReason::Internal,
            "the running wsmp binary cannot be found".into(),
        ));
    }
    if !gate.under_service {
        return Err((
            UpdateReason::UnsupportedMethod,
            "wsmp is not running as its installed service, so nothing would restart it; run `wsmp service install`, or `wsmp update` on the node".into(),
        ));
    }
    Ok(strategy)
}

fn progress_frame(
    update_id: &str,
    phase: UpdatePhase,
    reason: Option<UpdateReason>,
    detail: Option<String>,
) -> NodeFrame {
    NodeFrame::AgentUpdateProgress {
        update_id: update_id.to_string(),
        phase,
        reason,
        detail: detail.map(|text| super::clip_detail(&text)),
    }
}

fn report_frame(state: &UpdateState) -> NodeFrame {
    progress_frame(
        &state.update_id,
        state.phase.wire(),
        if matches!(state.phase, state::Phase::Failed) {
            Some(state.reason.unwrap_or(UpdateReason::Internal))
        } else {
            None
        },
        state.detail.clone(),
    )
}

enum Event {
    Frame(Box<NodeFrame>),
    /// The new binary is in place: exit for the service to restart.
    Restart,
}

/// What the worker and the relay loop share.
#[derive(Default)]
struct Shared {
    /// No runtime instance runs (set by the relay loop while the worker waits).
    no_instances: AtomicBool,
    /// No node command runs.
    no_commands: AtomicBool,
    /// The worker waits for the node to go idle.
    waiting: AtomicBool,
    /// The owner forced the update (`force`): the server stops the instances
    /// through its own stop operations; node commands are not waited for.
    force: AtomicBool,
    /// From the last idle check to the restart: the relay starts no runtime
    /// launch and no node command, so the node stays idle.
    hold: AtomicBool,
}

struct Worker {
    rx: Receiver<Event>,
    shared: Arc<Shared>,
}

struct Sink {
    update_id: String,
    tx: Sender<Event>,
}

impl Progress for Sink {
    fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>) {
        let _ = self.tx.send(Event::Frame(Box::new(progress_frame(
            &self.update_id,
            phase,
            reason,
            detail,
        ))));
    }
}

/// The relay's update tracker; one per daemon, across reconnects.
pub struct DaemonUpdate {
    started: Instant,
    awaiting: Option<UpdateState>,
    report: Option<UpdateState>,
    registered: bool,
    synced: bool,
    worker: Option<Worker>,
    /// Progress frames that wait for a registered session.
    outbox: Vec<NodeFrame>,
    restart: bool,
    /// The update this relay is installing or has installed (a repeat of its
    /// `agent.update` is never refused).
    current_id: Option<String>,
    /// SHA-256 of this binary, read at start while an update is in flight.
    own_sha256: Option<String>,
}

impl DaemonUpdate {
    /// Look at the update state as the relay starts. An error carries
    /// [`crate::exit::ExitCode::RestartForUpdate`] when this build rolled
    /// itself back.
    pub fn start() -> Result<Self> {
        let mut tracker = Self {
            started: Instant::now(),
            awaiting: None,
            report: None,
            registered: false,
            synced: false,
            worker: None,
            outbox: Vec::new(),
            restart: false,
            current_id: None,
            own_sha256: None,
        };
        let Ok(update_dir) = super::update_dir() else {
            return Ok(tracker);
        };
        if state::load(&update_dir)
            .ok()
            .flatten()
            .is_some_and(|current| current.phase.in_progress())
        {
            tracker.own_sha256 = own_sha256();
        }
        let scheduler = super::deadman::platform();
        match flow::on_start(
            &update_dir,
            scheduler.as_deref(),
            flow::Running {
                version: super::build::version(),
                sha256: tracker.own_sha256.as_deref(),
            },
            MAX_UNCONFIRMED_STARTS,
            super::unix_now(),
        ) {
            Ok(OnStart::Nothing) => {}
            Ok(OnStart::AwaitConfirm(state)) => {
                tracing::info!(
                    update_id = state.update_id,
                    from = state.from_version,
                    attempt = state.attempts,
                    "this build is an update that has not confirmed yet"
                );
                tracker.current_id = Some(state.update_id.clone());
                tracker.awaiting = Some(state);
            }
            Ok(OnStart::Report(state)) => tracker.report = Some(state),
            Ok(OnStart::RolledBackSelf) => {
                return Err(anyhow::anyhow!(
                    "this build did not confirm after {MAX_UNCONFIRMED_STARTS} starts and rolled back; restarting into the previous wsmp"
                )
                .context(crate::exit::CodedError::new(
                    crate::exit::ExitCode::RestartForUpdate,
                )));
            }
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "reading the update state failed"
            ),
        }
        Ok(tracker)
    }

    /// Answer an `agent.update`: frames to send now (a refusal), or nothing
    /// while a worker installs it.
    pub fn request(&mut self, frame: UpdateFrame, gate: &Gate) -> Vec<NodeFrame> {
        let refused_id = frame.update_id.clone();
        let refuse = |reason: UpdateReason, detail: String| {
            vec![progress_frame(
                &refused_id,
                UpdatePhase::Refused,
                Some(reason),
                Some(detail),
            )]
        };
        let recorded = || {
            super::update_dir()
                .ok()
                .and_then(|dir| state::load(&dir).ok().flatten())
                .is_some_and(|current| current.update_id == frame.update_id)
        };
        if self.current_id.as_deref() == Some(frame.update_id.as_str()) || recorded() {
            return self.repeat(&frame);
        }
        if self.worker.is_some() {
            return refuse(
                UpdateReason::InProgress,
                "another update is in progress on this node".into(),
            );
        }
        if self.awaiting.is_some() || self.restart {
            return refuse(
                UpdateReason::InProgress,
                "the last update has not confirmed yet".into(),
            );
        }
        let strategy = match check_gate(gate, &frame.version) {
            Ok(strategy) => strategy,
            Err((reason, detail)) => return refuse(reason, detail),
        };
        let identity = super::build::identity();
        let (Some(live), Ok(state_dir)) = (identity.live.clone(), crate::paths::state_dir()) else {
            return refuse(
                UpdateReason::Internal,
                "the state directory is unknown".into(),
            );
        };
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared::default());
        shared.force.store(frame.force, Ordering::SeqCst);
        let worker_shared = Arc::clone(&shared);
        let update_id = frame.update_id.clone();
        let spawned = std::thread::Builder::new()
            .name("wsmp-update".into())
            .spawn(move || {
                run_worker(
                    &frame,
                    strategy,
                    live,
                    state_dir,
                    identity.target,
                    &tx,
                    &worker_shared,
                );
            });
        match spawned {
            Ok(_) => {
                self.current_id = Some(update_id);
                self.worker = Some(Worker { rx, shared });
                Vec::new()
            }
            Err(error) => refuse(
                UpdateReason::Internal,
                format!("starting the update: {error}"),
            ),
        }
    }

    /// A repeat of the update this relay owns: a late `force` reaches a worker
    /// that still waits for idleness; an update that ended is reported again;
    /// otherwise nothing (the progress already on its way says it).
    fn repeat(&mut self, frame: &UpdateFrame) -> Vec<NodeFrame> {
        if let Some(worker) = &self.worker {
            if frame.force {
                worker.shared.force.store(true, Ordering::SeqCst);
            }
            return Vec::new();
        }
        if self.awaiting.is_some() || self.restart {
            return Vec::new();
        }
        super::update_dir()
            .ok()
            .and_then(|dir| state::load(&dir).ok().flatten())
            .filter(|current| current.update_id == frame.update_id && !current.phase.in_progress())
            .map(|current| vec![report_frame(&current)])
            .unwrap_or_default()
    }

    /// From the last idle check to the restart into a new build: start no
    /// runtime launch and no node command (they would end at the restart).
    pub fn holds_new_work(&self) -> bool {
        self.restart
            || self
                .worker
                .as_ref()
                .is_some_and(|worker| worker.shared.hold.load(Ordering::SeqCst))
    }

    /// The worker waits for the node to go idle: the relay loop reports idleness.
    pub fn wants_idle(&self) -> bool {
        self.worker
            .as_ref()
            .is_some_and(|worker| worker.shared.waiting.load(Ordering::SeqCst))
    }

    pub fn set_idle(&self, no_instances: bool, no_commands: bool) {
        if let Some(worker) = &self.worker {
            worker
                .shared
                .no_instances
                .store(no_instances, Ordering::SeqCst);
            worker
                .shared
                .no_commands
                .store(no_commands, Ordering::SeqCst);
        }
    }

    pub fn on_hello_ok(&mut self, sync: DefinitionSync) {
        self.registered = true;
        self.synced = sync == DefinitionSync::None;
        if let Some(report) = self.report.take() {
            self.outbox.push(report_frame(&report));
        }
    }

    /// A complete definition sync was applied in this session.
    pub fn on_definitions_applied(&mut self) {
        if self.registered {
            self.synced = true;
        }
    }

    pub fn on_session_end(&mut self) {
        self.registered = false;
        self.synced = false;
    }

    /// Frames to send now (only while registered), and whether to exit for
    /// the restart into a new build.
    pub fn poll(&mut self) -> (Vec<NodeFrame>, bool) {
        let mut finished = false;
        if let Some(worker) = &self.worker {
            loop {
                match worker.rx.try_recv() {
                    Ok(Event::Frame(frame)) => self.outbox.push(*frame),
                    Ok(Event::Restart) => {
                        self.restart = true;
                        finished = true;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        finished = true;
                        break;
                    }
                }
            }
        }
        if finished {
            self.worker = None;
        }
        if self.awaiting.is_some()
            && self.registered
            && self.synced
            && self.started.elapsed() >= CONFIRM_ALIVE
        {
            self.confirm_now();
        }
        let frames = if self.registered {
            std::mem::take(&mut self.outbox)
        } else {
            Vec::new()
        };
        // Registered: after the frames (`restarting`) went out. Disconnected:
        // at once; the new binary reports on its own session.
        (
            frames,
            self.restart && (self.outbox.is_empty() || !self.registered),
        )
    }

    fn confirm_now(&mut self) {
        let Some(awaiting) = self.awaiting.take() else {
            return;
        };
        let Ok(update_dir) = super::update_dir() else {
            return;
        };
        let scheduler = super::deadman::platform();
        let result = flow::confirm(
            &update_dir,
            scheduler.as_deref(),
            &awaiting.update_id,
            |confirmed| {
                let identity = super::build::identity();
                Some(super::receipt::InstallReceipt {
                    method: identity.method,
                    version: super::build::version().to_string(),
                    commit: identity.commit,
                    target: Some(identity.target),
                    binary: Some(confirmed.live_path.clone()),
                    installed_at: Some(crate::file_ops::fmt::rfc3339_secs(super::unix_now())),
                })
            },
        );
        match result {
            Ok(flow::Confirm::Confirmed(confirmed)) => {
                tracing::info!(
                    update_id = confirmed.update_id,
                    from = confirmed.from_version,
                    "the update confirmed"
                );
                if confirmed.origin == Origin::Server {
                    self.outbox.push(report_frame(&confirmed));
                }
            }
            Ok(flow::Confirm::RolledBack) => {
                // The previous build is live again and reports the rollback.
                tracing::warn!(
                    update_id = awaiting.update_id,
                    "the update rolled back before it confirmed; restarting into the previous wsmp"
                );
                self.restart = true;
            }
            Ok(flow::Confirm::NotOurs) => tracing::warn!(
                update_id = awaiting.update_id,
                "the update state changed before it confirmed"
            ),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "confirming the update failed");
                // Try again on the next poll.
                self.awaiting = Some(awaiting);
            }
        }
    }

    /// A frame went out: an update's end the server now knows is not
    /// reported again.
    pub fn sent(&self, frame: &NodeFrame) {
        let NodeFrame::AgentUpdateProgress {
            update_id, phase, ..
        } = frame
        else {
            return;
        };
        if !matches!(
            phase,
            UpdatePhase::Confirmed | UpdatePhase::RolledBack | UpdatePhase::Failed
        ) {
            return;
        }
        let Ok(update_dir) = super::update_dir() else {
            return;
        };
        let Ok(Some(_lock)) = state::UpdateLock::wait(&update_dir, flow::LOCK_WAIT) else {
            return;
        };
        if let Ok(Some(mut current)) = state::load(&update_dir)
            && &current.update_id == update_id
            && !current.reported
        {
            current.reported = true;
            let _ = state::save(&update_dir, &current);
        }
    }
}

/// Wait (bounded) until the node is idle: no instance runs and, unless the
/// update is forced, no node command. A forced update's instances are stopped
/// by the server. `false` when it did not go idle in time.
fn wait_idle(shared: &Shared, progress: &mut dyn Progress, limit: Duration) -> bool {
    let idle = || {
        shared.no_instances.load(Ordering::SeqCst)
            && (shared.force.load(Ordering::SeqCst) || shared.no_commands.load(Ordering::SeqCst))
    };
    // The relay loop answers within a poll or two.
    shared.waiting.store(true, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(1500));
    if idle() {
        shared.waiting.store(false, Ordering::SeqCst);
        return true;
    }
    progress.report(UpdatePhase::WaitingIdle, None, None);
    let until = Instant::now() + limit;
    while Instant::now() < until {
        std::thread::sleep(Duration::from_secs(1));
        if idle() {
            shared.waiting.store(false, Ordering::SeqCst);
            return true;
        }
    }
    shared.waiting.store(false, Ordering::SeqCst);
    false
}

fn run_worker(
    frame: &UpdateFrame,
    strategy: UpdateStrategy,
    live: std::path::PathBuf,
    state_dir: std::path::PathBuf,
    target: String,
    tx: &Sender<Event>,
    shared: &Shared,
) {
    let mut sink = Sink {
        update_id: frame.update_id.clone(),
        tx: tx.clone(),
    };
    let update_dir = state_dir.join("update");
    let lock = match state::UpdateLock::acquire(&update_dir) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            sink.report(
                UpdatePhase::Refused,
                Some(UpdateReason::InProgress),
                Some("another update is in progress on this node".into()),
            );
            return;
        }
        Err(error) => {
            sink.report(
                UpdatePhase::Failed,
                Some(UpdateReason::Internal),
                Some(format!("{error:#}")),
            );
            return;
        }
    };
    if let Ok(Some(current)) = state::load(&update_dir)
        && current.phase.in_progress()
    {
        sink.report(
            UpdatePhase::Refused,
            Some(UpdateReason::InProgress),
            Some("another update is in progress on this node".into()),
        );
        return;
    }
    let waited_from = Instant::now();
    if !instances_survive() && !wait_idle(shared, &mut sink, IDLE_WAIT_MAX) {
        sink.report(
            UpdatePhase::Refused,
            Some(UpdateReason::Busy),
            Some("the node did not go idle within 30 minutes".into()),
        );
        return;
    }
    // The node may have got busy during the download: hold new work, then
    // wait (within the same limit) until it is idle again.
    let before_swap = |progress: &mut dyn Progress| -> Result<(), String> {
        if instances_survive() {
            return Ok(());
        }
        shared.hold.store(true, Ordering::SeqCst);
        let left = IDLE_WAIT_MAX.saturating_sub(waited_from.elapsed());
        if wait_idle(shared, progress, left) {
            return Ok(());
        }
        shared.hold.store(false, Ordering::SeqCst);
        Err("the node did not go idle within 30 minutes".into())
    };
    let scheduler = super::deadman::platform();
    let machine = Machine {
        state_dir,
        live,
        target,
        scheduler: scheduler.as_deref(),
        tar: super::install::system_tar(),
        current_version: super::build::version().to_string(),
        before_swap: Some(&before_swap),
    };
    let request = Request {
        update_id: frame.update_id.clone(),
        version: frame.version.clone(),
        artifact_url: frame.artifact_url.clone(),
        sha256: frame.sha256.clone(),
        signature: frame.signature.clone(),
        rollback_after_secs: frame.rollback_after_secs,
        origin: Origin::Server,
    };
    let ended = match strategy {
        UpdateStrategy::SelfReplace => flow::self_replace(&machine, &request, &mut sink),
        UpdateStrategy::Homebrew => homebrew(&machine, &request, &mut sink),
    };
    // The new build takes the lock when it starts.
    drop(lock);
    if ended == Ended::Swapped {
        sink.report(UpdatePhase::Restarting, None, None);
        let _ = tx.send(Event::Restart);
    }
}

/// SHA-256 of the running binary: the file the process was started from
/// (Linux reads it through `/proc/self/exe`, which stays that file even after
/// a rename over its path).
fn own_sha256() -> Option<String> {
    #[cfg(target_os = "linux")]
    let exe = std::path::PathBuf::from("/proc/self/exe");
    #[cfg(not(target_os = "linux"))]
    let exe = std::env::current_exe().ok()?;
    super::install::sha256_file(&exe).ok()
}

/// The Homebrew strategy (D10): refuse a pinned or foreign install, keep the
/// service on the stable `opt` path, `brew upgrade`, and require the version.
pub fn homebrew(machine: &Machine<'_>, request: &Request, progress: &mut dyn Progress) -> Ended {
    let fail = |progress: &mut dyn Progress, phase, reason, detail: String| {
        progress.report(phase, Some(reason), Some(super::clip_detail(&detail)));
        Ended::Stopped
    };
    let Some(keg) = super::homebrew::keg_of(&machine.live) else {
        return fail(
            progress,
            UpdatePhase::Refused,
            UpdateReason::UnsupportedMethod,
            format!(
                "wsmp is not in a Homebrew keg; run: {}",
                super::homebrew::MANUAL_COMMAND
            ),
        );
    };
    match super::homebrew::refusal(&keg) {
        Ok(None) => {}
        Ok(Some(why)) => {
            return fail(
                progress,
                UpdatePhase::Refused,
                UpdateReason::UnsupportedMethod,
                why,
            );
        }
        Err(error) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!("{error:#}"),
            );
        }
    }
    if let Err(error) = crate::commands::service::ensure_stable_executable() {
        tracing::warn!(error = %format!("{error:#}"), "the service could not be moved to the stable Homebrew path");
    }
    progress.report(UpdatePhase::Downloading, None, None);
    if let Err(error) = super::homebrew::upgrade(&keg) {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    let stable = keg.prefix.join("opt").join("wsmp").join("bin").join("wsmp");
    match super::install::probe_version(&stable) {
        Ok(version) if version == request.version => {}
        Ok(version) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!(
                    "Homebrew installed wsmp {version}, not {}; the tap may not have it yet",
                    request.version
                ),
            );
        }
        Err(error) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!("{error:#}"),
            );
        }
    }
    if let Err(error) = flow::record_homebrew(machine, request) {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    Ended::Swapped
}

/// The instance ranks that still run (anything not verified stopped).
pub fn running_instances() -> Vec<crate::runtimes::executor::Job> {
    let Ok(dir) = crate::runtimes::executor::instances_dir() else {
        return Vec::new();
    };
    let (executors, _) = crate::runtimes::executor::read_all(&dir);
    executors
        .iter()
        .flat_map(crate::runtimes::executor::Executor::ranks)
        .filter(|rank| rank.phase != crate::protocol::frames::InstancePhase::Stopped)
        .map(|rank| rank.job)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> Gate {
        Gate {
            full_control: true,
            remote: RemoteUpdates::Allowed,
            method: InstallMethod::Script,
            has_live: true,
            under_service: true,
        }
    }

    fn frame(id: &str, force: bool) -> UpdateFrame {
        UpdateFrame {
            update_id: id.into(),
            version: "0.4.3".into(),
            artifact_url: "https://example.invalid/wsmp.tar.xz".into(),
            sha256: "0".repeat(64),
            signature: None,
            force,
            rollback_after_secs: 90,
        }
    }

    #[test]
    fn the_gates_refuse_with_the_contract_reasons() {
        assert_eq!(
            check_gate(&gate(), "0.4.3"),
            Ok(UpdateStrategy::SelfReplace)
        );
        let refused = |change: &dyn Fn(&mut Gate)| {
            let mut gate = gate();
            change(&mut gate);
            check_gate(&gate, "0.4.3").map_err(|(reason, _)| reason)
        };
        assert_eq!(
            refused(&|g| g.full_control = false),
            Err(UpdateReason::NotOwnerTrust)
        );
        assert_eq!(
            refused(&|g| g.remote = RemoteUpdates::Off),
            Err(UpdateReason::OptedOut)
        );
        assert_eq!(
            refused(&|g| g.method = InstallMethod::Source),
            Err(UpdateReason::SourceBuild)
        );
        assert_eq!(
            refused(&|g| g.method = InstallMethod::Cargo),
            Err(UpdateReason::UnsupportedMethod)
        );
        assert_eq!(
            refused(&|g| g.method = InstallMethod::Npm),
            Err(UpdateReason::UnsupportedMethod)
        );
        assert_eq!(
            refused(&|g| g.under_service = false),
            Err(UpdateReason::UnsupportedMethod)
        );
        assert_eq!(
            refused(&|g| g.method = InstallMethod::Homebrew),
            Ok(UpdateStrategy::Homebrew)
        );
        let (_, command) = check_gate(
            &Gate {
                method: InstallMethod::Source,
                ..gate()
            },
            "0.4.3",
        )
        .expect_err("source");
        assert!(
            command.contains("cargo install") && command.contains("v0.4.3"),
            "{command}"
        );
        // Trust is checked first: a Relay-only node says nothing else.
        let (reason, _) = check_gate(
            &Gate {
                full_control: false,
                remote: RemoteUpdates::Off,
                ..gate()
            },
            "0.4.3",
        )
        .expect_err("trust");
        assert_eq!(reason, UpdateReason::NotOwnerTrust);
    }

    #[test]
    fn strategies_follow_the_install() {
        assert_eq!(
            strategies(InstallMethod::Script, true, true),
            [UpdateStrategy::SelfReplace]
        );
        assert_eq!(
            strategies(InstallMethod::Homebrew, true, true),
            [UpdateStrategy::Homebrew]
        );
        assert!(strategies(InstallMethod::Source, true, true).is_empty());
        assert!(strategies(InstallMethod::Script, true, false).is_empty());
    }

    fn tracker() -> DaemonUpdate {
        DaemonUpdate {
            started: Instant::now(),
            awaiting: None,
            report: None,
            registered: true,
            synced: true,
            worker: None,
            outbox: Vec::new(),
            restart: false,
            current_id: None,
            own_sha256: None,
        }
    }

    fn waiting_worker(tracker: &mut DaemonUpdate, id: &str) -> (Arc<Shared>, Sender<Event>) {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared::default());
        shared.waiting.store(true, Ordering::SeqCst);
        tracker.current_id = Some(id.into());
        tracker.worker = Some(Worker {
            rx,
            shared: Arc::clone(&shared),
        });
        (shared, tx)
    }

    fn reason_of(frames: &[NodeFrame]) -> Option<UpdateReason> {
        match frames {
            [NodeFrame::AgentUpdateProgress { reason, .. }] => *reason,
            _ => None,
        }
    }

    #[test]
    fn a_repeat_of_the_same_update_is_never_refused() {
        let mut tracker = tracker();
        let id = "AAAAAAAAAAAAAAAAAAAAAA";
        let (shared, _tx) = waiting_worker(&mut tracker, id);
        assert!(tracker.wants_idle());
        // Another update is refused.
        let other = tracker.request(frame("BBBBBBBBBBBBBBBBBBBBBB", true), &gate());
        assert_eq!(reason_of(&other), Some(UpdateReason::InProgress));
        // The same one unforced: no answer, the worker goes on.
        assert!(tracker.request(frame(id, false), &gate()).is_empty());
        assert!(!shared.force.load(Ordering::SeqCst));
        // With force: no answer; the server stops the instances.
        assert!(tracker.request(frame(id, true), &gate()).is_empty());
        assert!(shared.force.load(Ordering::SeqCst));
        // A late force once the worker stopped waiting: still no refusal.
        shared.waiting.store(false, Ordering::SeqCst);
        assert!(tracker.request(frame(id, true), &gate()).is_empty());
        // Awaiting the restart: the same id gets no answer either.
        tracker.worker = None;
        tracker.restart = true;
        assert!(tracker.request(frame(id, true), &gate()).is_empty());
    }

    #[test]
    fn new_work_is_held_from_the_last_idle_check_to_the_restart() {
        let mut tracker = tracker();
        let (shared, _tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
        assert!(!tracker.holds_new_work());
        shared.hold.store(true, Ordering::SeqCst);
        assert!(tracker.holds_new_work());
        tracker.worker = None;
        assert!(!tracker.holds_new_work(), "the worker stopped: no hold");
        tracker.restart = true;
        assert!(tracker.holds_new_work());
    }

    #[test]
    fn a_forced_wait_ignores_node_commands_but_not_instances() {
        let shared = Shared::default();
        let (tx, rx) = mpsc::channel();
        let mut sink = Sink {
            update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            tx,
        };
        shared.no_instances.store(true, Ordering::SeqCst);
        shared.no_commands.store(false, Ordering::SeqCst);
        assert!(!wait_idle(&shared, &mut sink, Duration::from_millis(10)));
        assert!(matches!(
            rx.try_recv(),
            Ok(Event::Frame(frame)) if matches!(*frame, NodeFrame::AgentUpdateProgress {
                phase: UpdatePhase::WaitingIdle,
                ..
            })
        ));
        shared.force.store(true, Ordering::SeqCst);
        assert!(wait_idle(&shared, &mut sink, Duration::from_millis(10)));
        shared.no_instances.store(false, Ordering::SeqCst);
        assert!(!wait_idle(&shared, &mut sink, Duration::from_millis(10)));
    }

    #[test]
    fn the_restart_waits_for_the_progress_only_on_a_live_session() {
        let mut tracker = tracker();
        tracker.registered = false;
        let (_shared, tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
        tx.send(Event::Frame(Box::new(progress_frame(
            "AAAAAAAAAAAAAAAAAAAAAA",
            UpdatePhase::Restarting,
            None,
            None,
        ))))
        .expect("send");
        tx.send(Event::Restart).expect("send");
        // Disconnected: restart at once, the progress waits.
        assert_eq!(tracker.poll(), (Vec::new(), true));
        // Registered: the progress goes out first.
        tracker.registered = true;
        let (frames, restart) = tracker.poll();
        assert_eq!(frames.len(), 1);
        assert!(restart);
        // A new update while the restart is pending is in progress.
        let refused = tracker.request(frame("BBBBBBBBBBBBBBBBBBBBBB", false), &gate());
        assert_eq!(reason_of(&refused), Some(UpdateReason::InProgress));
    }
}
