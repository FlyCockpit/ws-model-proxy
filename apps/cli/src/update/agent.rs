//! The relay's side of self-update: answering `agent.update` (the gates, the
//! worker thread that installs), confirming a new build once the session is
//! healthy, and reporting how an update ended after a restart.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use anyhow::Result;

use super::flow::{self, Ended, Machine, OnStart, Progress, Request};
use super::state::{self, Origin, UpdateState};
use crate::protocol::frames::{
    DefinitionSync, InstallMethod, NodeFrame, UpdatePhase, UpdateReason,
};
use crate::protocol::runtime_spec::{RemoteUpdates, SelfUpdateFeatures, UpdateStrategy};
use crate::startup::TrustWatch;

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
        available_version: None,
    }
}

fn report_frame(state: &UpdateState) -> NodeFrame {
    progress_frame(
        &state.update_id,
        state.phase().wire(),
        if state.phase() == state::Phase::Failed {
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

/// Where the worker is, as the relay loop sees it: whether it waits for the node to go idle,
/// and whether the relay holds new work (from the last idle check to the restart, the relay
/// starts no runtime launch and no node command, so the node stays idle).
///
/// ```text
/// Preparing ──begin_wait──▶ WaitingIdle ──end_wait──▶ Preparing     (a self-replace, before its download)
/// Preparing ──hold──▶ Holding ──begin_wait──▶ HoldingWaitingIdle ──end_wait──▶ Holding
/// Holding ──release──▶ Preparing                                     (that wait timed out or was stopped)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum WorkerStage {
    /// Downloading, verifying, unpacking: the node may be busy.
    Preparing = 0,
    /// Waiting for the node to go idle; new work is not held.
    WaitingIdle = 1,
    /// The last idle check: new work is held while it waits for the node to go idle again.
    HoldingWaitingIdle = 2,
    /// New work is held (the node was idle at the last check): the swap and the restart.
    Holding = 3,
}

impl WorkerStage {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::WaitingIdle,
            2 => Self::HoldingWaitingIdle,
            3 => Self::Holding,
            _ => Self::Preparing,
        }
    }

    fn wants_idle(self) -> bool {
        matches!(self, Self::WaitingIdle | Self::HoldingWaitingIdle)
    }

    fn holds_new_work(self) -> bool {
        matches!(self, Self::HoldingWaitingIdle | Self::Holding)
    }

    fn begin_wait(self) -> Option<Self> {
        match self {
            Self::Preparing => Some(Self::WaitingIdle),
            Self::Holding => Some(Self::HoldingWaitingIdle),
            Self::WaitingIdle | Self::HoldingWaitingIdle => None,
        }
    }

    fn end_wait(self) -> Option<Self> {
        match self {
            Self::WaitingIdle => Some(Self::Preparing),
            Self::HoldingWaitingIdle => Some(Self::Holding),
            Self::Preparing | Self::Holding => None,
        }
    }

    fn hold(self) -> Option<Self> {
        match self {
            Self::Preparing => Some(Self::Holding),
            _ => None,
        }
    }

    fn release(self) -> Option<Self> {
        match self {
            Self::Holding => Some(Self::Preparing),
            _ => None,
        }
    }
}

/// A [`WorkerStage`] the worker moves and the relay loop reads, one atomic value (the two never
/// disagree about waiting and holding).
struct AtomicStage(AtomicU8);

impl AtomicStage {
    fn new() -> Self {
        Self(AtomicU8::new(WorkerStage::Preparing as u8))
    }

    fn load(&self) -> WorkerStage {
        WorkerStage::from_u8(self.0.load(Ordering::SeqCst))
    }

    /// Move by `step`; a move `step` does not allow from the current stage changes nothing
    /// (and is logged: the worker's own sequence never asks for one).
    fn advance(&self, step: fn(WorkerStage) -> Option<WorkerStage>, what: &str) -> bool {
        let moved = self
            .0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                step(WorkerStage::from_u8(value)).map(|next| next as u8)
            })
            .is_ok();
        if !moved {
            tracing::warn!(stage = ?self.load(), what, "the update worker cannot move here");
        }
        moved
    }

    #[cfg(test)]
    fn set(&self, stage: WorkerStage) {
        self.0.store(stage as u8, Ordering::SeqCst);
    }
}

/// What the worker and the relay loop share.
struct Shared {
    /// No runtime instance runs (set by the relay loop while the worker waits).
    no_instances: AtomicBool,
    /// No node command runs.
    no_commands: AtomicBool,
    /// Whether the worker waits for the node to go idle, and whether new work is held.
    stage: AtomicStage,
    /// The owner forced the update (`force`): the server stops the instances
    /// through its own stop operations; node commands are not waited for.
    force: AtomicBool,
    /// The node lost Full control (seen by the relay loop's poll): the update
    /// stops at its next step.
    lowered: AtomicBool,
    /// The daemon's own trust, as this update was asked under it
    /// ([`TerminalStartup::trust_watch`](crate::startup::TerminalStartup::trust_watch)):
    /// revoked at the lowering itself, not at the next poll, and for good.
    trust: TrustWatch,
}

impl Shared {
    fn new(trust: TrustWatch) -> Self {
        Self {
            no_instances: AtomicBool::new(false),
            no_commands: AtomicBool::new(false),
            stage: AtomicStage::new(),
            force: AtomicBool::new(false),
            lowered: AtomicBool::new(false),
            trust,
        }
    }

    /// The node is not at Full control for this update any more.
    fn revoked(&self) -> bool {
        self.lowered.load(Ordering::SeqCst) || self.trust.revoked()
    }
}

#[cfg(test)]
impl Default for Shared {
    fn default() -> Self {
        Self::new(TrustWatch::full_for_tests())
    }
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
        tracing::info!(
            update_id = %self.update_id,
            ?phase,
            ?reason,
            detail = detail.as_deref().unwrap_or_default(),
            "update progress"
        );
        let _ = self.tx.send(Event::Frame(Box::new(progress_frame(
            &self.update_id,
            phase,
            reason,
            detail,
        ))));
    }

    fn refuse_version(&mut self, available: String, detail: String) {
        tracing::info!(
            update_id = %self.update_id,
            available = %available,
            detail = %detail,
            "update refused: another version is available"
        );
        let mut frame = progress_frame(
            &self.update_id,
            UpdatePhase::Refused,
            Some(UpdateReason::VersionMismatch),
            Some(detail),
        );
        if let NodeFrame::AgentUpdateProgress {
            available_version, ..
        } = &mut frame
            && crate::protocol::frames::is_release_version(&available)
        {
            *available_version = Some(available);
        }
        let _ = self.tx.send(Event::Frame(Box::new(frame)));
    }
}

/// What the relay is doing about updates.
///
/// ```text
/// Idle ──request──▶ Installing ──swapped──▶ Restarting
///                      └──stopped──▶ Idle
/// (start) AwaitingConfirm ──confirmed / not ours──▶ Idle
///                        └──rolled back first──▶ Restarting
/// ```
enum Tracking {
    /// No update runs here (one may have ended: a repeat of its `agent.update` reports it).
    Idle,
    /// A worker installs one.
    Installing(Worker),
    /// This build is an update that has not confirmed yet: it confirms once the session is
    /// healthy.
    AwaitingConfirm(Box<UpdateState>),
    /// The relay exits for its service to start the build that is now live (the new one, or
    /// the previous one after a rollback). Nothing else starts meanwhile.
    Restarting,
}

/// The relay's session with the server, as updates see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Connection {
    /// No session, or one that has not had `hello.ok` yet: progress waits in the outbox.
    Disconnected,
    Registered {
        /// The session's definitions are in sync (none to sync, or a complete sync applied).
        synced: bool,
        /// This session's server said at `hello.ok` that a refusal may carry
        /// `availableVersion` (`features.agentUpdateAvailableVersion`). Until then, and with
        /// any other server, the field is left out: an older server's strict schema would
        /// refuse the whole frame.
        available_version_accepted: bool,
    },
}

/// The relay's update tracker; one per daemon, across reconnects.
pub struct DaemonUpdate {
    started: Instant,
    tracking: Tracking,
    connection: Connection,
    /// Progress frames that wait for a registered session.
    outbox: Vec<NodeFrame>,
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
            tracking: Tracking::Idle,
            connection: Connection::Disconnected,
            outbox: Vec::new(),
            current_id: None,
            own_sha256: None,
        };
        let Ok(update_dir) = super::update_dir() else {
            return Ok(tracker);
        };
        if state::load(&update_dir)
            .ok()
            .flatten()
            .is_some_and(|current| current.in_progress())
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
                tracker.tracking = Tracking::AwaitingConfirm(Box::new(state));
            }
            // Sent after each `hello.ok` until the server acknowledges it.
            Ok(OnStart::Report(state)) => tracing::info!(
                update_id = state.update_id,
                phase = ?state.phase(),
                "an update ended; reporting it"
            ),
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
    /// while a worker installs it. `trust`: the daemon's trust, taken before
    /// `gate` was read; the worker asks it at every step.
    pub fn request(
        &mut self,
        frame: UpdateFrame,
        gate: &Gate,
        trust: TrustWatch,
    ) -> Vec<NodeFrame> {
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
        match self.tracking {
            Tracking::Idle => {}
            Tracking::Installing(_) => {
                return refuse(
                    UpdateReason::InProgress,
                    "another update is in progress on this node".into(),
                );
            }
            Tracking::AwaitingConfirm(_) | Tracking::Restarting => {
                return refuse(
                    UpdateReason::InProgress,
                    "the last update has not confirmed yet".into(),
                );
            }
        }
        // Lowered since the watch was taken (after `gate` read Full control).
        let gate = &Gate {
            full_control: gate.full_control && !trust.revoked(),
            ..*gate
        };
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
        let shared = Arc::new(Shared::new(trust));
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
                    &Host::this_machine(),
                );
            });
        match spawned {
            Ok(_) => {
                self.current_id = Some(update_id);
                self.tracking = Tracking::Installing(Worker { rx, shared });
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
        match &self.tracking {
            Tracking::Installing(worker) => {
                if frame.force {
                    worker.shared.force.store(true, Ordering::SeqCst);
                }
                return Vec::new();
            }
            Tracking::AwaitingConfirm(_) | Tracking::Restarting => return Vec::new(),
            Tracking::Idle => {}
        }
        super::update_dir()
            .ok()
            .and_then(|dir| state::load(&dir).ok().flatten())
            .filter(|current| current.update_id == frame.update_id && !current.in_progress())
            .map(|current| vec![report_frame(&current)])
            .unwrap_or_default()
    }

    /// From the last idle check to the restart into a new build: start no
    /// runtime launch and no node command (they would end at the restart).
    pub fn holds_new_work(&self) -> bool {
        match &self.tracking {
            Tracking::Restarting => true,
            Tracking::Installing(worker) => worker.shared.stage.load().holds_new_work(),
            Tracking::Idle | Tracking::AwaitingConfirm(_) => false,
        }
    }

    /// The worker waits for the node to go idle: the relay loop reports idleness.
    pub fn wants_idle(&self) -> bool {
        self.worker()
            .is_some_and(|worker| worker.shared.stage.load().wants_idle())
    }

    fn worker(&self) -> Option<&Worker> {
        match &self.tracking {
            Tracking::Installing(worker) => Some(worker),
            _ => None,
        }
    }

    pub fn set_idle(&self, no_instances: bool, no_commands: bool) {
        if let Some(worker) = self.worker() {
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

    /// `available_version`: the server's `hello.ok` `features.agentUpdateAvailableVersion`.
    pub fn on_hello_ok(&mut self, sync: DefinitionSync, available_version: bool) {
        self.connection = Connection::Registered {
            synced: sync == DefinitionSync::None,
            available_version_accepted: available_version,
        };
        // An update's end, until the server acknowledges it (`agent.update.ack`):
        // a report the server got but did not store is sent again.
        if let Some(ended) = super::update_dir()
            .ok()
            .and_then(|dir| state::load(&dir).ok().flatten())
            .filter(UpdateState::needs_report)
        {
            self.outbox.push(report_frame(&ended));
        }
    }

    /// A complete definition sync was applied in this session.
    pub fn on_definitions_applied(&mut self) {
        if let Connection::Registered { synced, .. } = &mut self.connection {
            *synced = true;
        }
    }

    pub fn on_session_end(&mut self) {
        self.connection = Connection::Disconnected;
    }

    /// Frames to send now (only while registered), and whether to exit for
    /// the restart into a new build. `full_control` is the node's trust now: a
    /// worker of a node lowered to Relay only stops at its next step. (The
    /// worker sees a lowering sooner, through its [`TrustWatch`]; this latch
    /// is a second way to the same stop.)
    pub fn poll(&mut self, full_control: bool) -> (Vec<NodeFrame>, bool) {
        if !full_control && let Some(worker) = self.worker() {
            worker.shared.lowered.store(true, Ordering::SeqCst);
        }
        let mut ended = None;
        if let Tracking::Installing(worker) = &self.tracking {
            loop {
                match worker.rx.try_recv() {
                    Ok(Event::Frame(frame)) => self.outbox.push(*frame),
                    Ok(Event::Restart) => {
                        ended = Some(Tracking::Restarting);
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        ended = Some(Tracking::Idle);
                        break;
                    }
                }
            }
        }
        if let Some(next) = ended {
            self.tracking = next;
        }
        if matches!(self.tracking, Tracking::AwaitingConfirm(_))
            && matches!(self.connection, Connection::Registered { synced: true, .. })
            && self.started.elapsed() >= CONFIRM_ALIVE
        {
            self.confirm_now();
        }
        let frames = match self.connection {
            Connection::Registered {
                available_version_accepted,
                ..
            } => std::mem::take(&mut self.outbox)
                .into_iter()
                .map(|frame| for_server(frame, available_version_accepted))
                .collect(),
            Connection::Disconnected => Vec::new(),
        };
        // Registered: after the frames (`restarting`) went out. Disconnected:
        // at once; the new binary reports on its own session.
        let registered = matches!(self.connection, Connection::Registered { .. });
        (
            frames,
            matches!(self.tracking, Tracking::Restarting)
                && (self.outbox.is_empty() || !registered),
        )
    }

    /// Confirm the build this relay awaits. Until it is confirmed (or found rolled back, or
    /// not ours), the tracker awaits it again after an error.
    fn confirm_now(&mut self) {
        let awaiting = match std::mem::replace(&mut self.tracking, Tracking::Idle) {
            Tracking::AwaitingConfirm(awaiting) => awaiting,
            other => {
                self.tracking = other;
                return;
            }
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
                self.tracking = Tracking::Restarting;
            }
            Ok(flow::Confirm::NotOurs) => tracing::warn!(
                update_id = awaiting.update_id,
                "the update state changed before it confirmed"
            ),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "confirming the update failed");
                // Try again on the next poll.
                self.tracking = Tracking::AwaitingConfirm(awaiting);
            }
        }
    }

    /// The server stored how `update_id` ended (`agent.update.ack`): it is not
    /// reported again.
    pub fn acked(&self, update_id: &str) {
        let Ok(update_dir) = super::update_dir() else {
            return;
        };
        let Ok(Some(_lock)) = state::UpdateLock::wait(&update_dir, flow::LOCK_WAIT) else {
            return;
        };
        if let Ok(Some(mut current)) = state::load(&update_dir)
            && current.update_id == update_id
            && current.mark_reported()
        {
            let _ = state::save(&update_dir, &current);
            tracing::info!(update_id, "the server stored how the update ended");
        }
    }
}

/// A progress frame as this session's server can read it: `availableVersion` only to a server
/// that said it accepts it (the refusal's detail names the version either way).
fn for_server(mut frame: NodeFrame, available_version_accepted: bool) -> NodeFrame {
    if !available_version_accepted
        && let NodeFrame::AgentUpdateProgress {
            available_version, ..
        } = &mut frame
    {
        *available_version = None;
    }
    frame
}

/// Wait (bounded) until the node is idle: no instance runs and, unless the
/// update is forced, no node command. A forced update's instances are stopped
/// by the server. `false` when it did not go idle in time, or as soon as
/// `stopped` (the node was lowered, or its operator turned remote updates
/// off: the caller then refuses with that reason).
fn wait_idle(
    shared: &Shared,
    progress: &mut dyn Progress,
    limit: Duration,
    stopped: &dyn Fn() -> bool,
) -> bool {
    let idle = || {
        shared.no_instances.load(Ordering::SeqCst)
            && (shared.force.load(Ordering::SeqCst) || shared.no_commands.load(Ordering::SeqCst))
    };
    // The relay loop answers within a poll or two.
    shared
        .stage
        .advance(WorkerStage::begin_wait, "wait for idle");
    let end_wait = || {
        shared
            .stage
            .advance(WorkerStage::end_wait, "end the wait for idle")
    };
    std::thread::sleep(Duration::from_millis(1500));
    if idle() {
        end_wait();
        return true;
    }
    progress.report(UpdatePhase::WaitingIdle, None, None);
    let until = Instant::now() + limit;
    while Instant::now() < until && !stopped() {
        std::thread::sleep(Duration::from_secs(1));
        if idle() {
            end_wait();
            return true;
        }
    }
    end_wait();
    false
}

/// What the worker asks of this machine; tests run it as another platform would.
struct Host {
    /// [`instances_survive`].
    instances_survive: bool,
    /// The operator's remote-update setting, read again at every step.
    remote: fn() -> RemoteUpdates,
    /// [`Machine::stable_service`].
    stable_service: fn(&std::path::Path) -> Result<()>,
    /// The dead-man's scheduler ([`super::deadman::platform`]): what a self-replace arms, and
    /// what tells whether an earlier update still has a rollback job.
    scheduler: fn() -> Option<Box<dyn super::deadman::Scheduler>>,
}

impl Host {
    fn this_machine() -> Self {
        Self {
            instances_survive: instances_survive(),
            remote: remote_setting,
            stable_service: crate::commands::service::ensure_stable_executable,
            scheduler: super::deadman::platform,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_worker(
    frame: &UpdateFrame,
    strategy: UpdateStrategy,
    live: std::path::PathBuf,
    state_dir: std::path::PathBuf,
    target: String,
    tx: &Sender<Event>,
    shared: &Shared,
    host: &Host,
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
    // An update abandoned before its swap with nothing left to finish it (no installer: this
    // worker holds the lock; no dead-man registered) is settled here, not refused until the relay
    // restarts. One whose dead-man or swap is still in play stays its owner's.
    let scheduler = (host.scheduler)();
    if let Err(error) = flow::settle_abandoned(&update_dir, scheduler.as_deref(), &lock) {
        tracing::warn!(error = %format!("{error:#}"), "looking at an earlier update failed");
    }
    if let Ok(Some(current)) = state::load(&update_dir)
        && current.in_progress()
    {
        sink.report(
            UpdatePhase::Refused,
            Some(UpdateReason::InProgress),
            Some("another update is in progress on this node".into()),
        );
        return;
    }
    // Full control and the operator's setting hold for the whole update, not
    // only when it was asked for.
    let proceed = || -> Result<(), (UpdateReason, String)> {
        if shared.revoked() {
            return Err((
                UpdateReason::NotOwnerTrust,
                "the node was lowered to Relay only; wsmp was not upgraded".into(),
            ));
        }
        if (host.remote)() == RemoteUpdates::Off {
            return Err((
                UpdateReason::OptedOut,
                "this machine's operator turned remote updates off; wsmp was not upgraded".into(),
            ));
        }
        Ok(())
    };
    let waited_from = Instant::now();
    // A self-replace waits for idle before it downloads. Homebrew waits in
    // `before_swap` instead, after its tap check: a tap without the version
    // asked for is refused at once, not after up to 30 minutes of waiting.
    // A wait ends as soon as the update may not go on (F-FA-3): it refuses
    // with that reason then, letting go of the update lock and the hold.
    let stopped = || proceed().is_err();
    if strategy == UpdateStrategy::SelfReplace
        && !host.instances_survive
        && !wait_idle(shared, &mut sink, IDLE_WAIT_MAX, &stopped)
    {
        let (reason, detail) = proceed().err().unwrap_or((
            UpdateReason::Busy,
            "the node did not go idle within 30 minutes".into(),
        ));
        sink.report(UpdatePhase::Refused, Some(reason), Some(detail));
        return;
    }
    // The node may have got busy during the download: hold new work, then
    // wait (within the same limit) until it is idle again.
    let before_swap = |progress: &mut dyn Progress| -> Result<(), String> {
        if host.instances_survive {
            return Ok(());
        }
        shared.stage.advance(WorkerStage::hold, "hold new work");
        let left = IDLE_WAIT_MAX.saturating_sub(waited_from.elapsed());
        if wait_idle(shared, progress, left, &stopped) {
            return Ok(());
        }
        shared
            .stage
            .advance(WorkerStage::release, "let go of new work");
        // When stopped, the caller's next check refuses with the reason.
        Err("the node did not go idle within 30 minutes".into())
    };
    let machine = Machine {
        state_dir,
        live,
        target,
        scheduler: scheduler.as_deref(),
        tar: super::install::system_tar(),
        current_version: super::build::version().to_string(),
        before_swap: Some(&before_swap),
        proceed: Some(&proceed),
        stable_service: host.stable_service,
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
        // The relay exits and its service manager starts it again. On macOS
        // launchd starts the definition it loaded, not the plist as rewritten
        // (see `ensure_stable_executable`; recovery: `wsmp service install`).
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

/// The Homebrew strategy (D10), in this order:
///
/// 1. refuse a pinned or foreign install;
/// 2. refresh the tap (`brew update`) and refuse, with nothing installed,
///    when it does not have exactly the version asked for: before any wait
///    for idle, so the refusal (and the version the tap has) comes at once;
/// 3. the last idle check and the work hold (`before_swap`);
/// 4. make the service start the stable `opt` path (an update that cannot
///    stops here);
/// 5. take Homebrew's update lock ([`super::homebrew::TapLock`]), check the
///    tap's version again under it, and `brew upgrade` still under it: an
///    ordinary `brew update` meanwhile fails at once on the held lock (and has
///    to be run again). One that was already starting when a `brew cleanup`
///    replaced the lock file can still move the tap (a gap in Homebrew's own
///    locking): step 6 reports that as a version mismatch. So can one in the
///    window after wsmp dies mid-upgrade, but then no step 6 runs: the
///    server's deadline and the version the next start reports show it;
/// 6. require the installed version, and record it.
///
/// Full control and the operator's setting are asked again right before each
/// step that changes something: the tap refresh, the service, the upgrade.
pub fn homebrew(machine: &Machine<'_>, request: &Request, progress: &mut dyn Progress) -> Ended {
    let fail = |progress: &mut dyn Progress, phase, reason, detail: String| {
        progress.report(phase, Some(reason), Some(super::clip_detail(&detail)));
        Ended::Stopped
    };
    let proceed = |progress: &mut dyn Progress| match machine.proceed.map(|proceed| proceed()) {
        Some(Err((reason, detail))) => Err(fail(progress, UpdatePhase::Refused, reason, detail)),
        _ => Ok(()),
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
    // The tap's version before anything is installed: `brew upgrade` takes
    // whatever the tap has, and the keg it switches to cannot be rolled back.
    // `downloading` from here: the refresh fetches the taps.
    if let Err(ended) = proceed(progress) {
        return ended;
    }
    progress.report(UpdatePhase::Downloading, None, None);
    if let Err(error) = super::homebrew::refresh(&keg) {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::DownloadFailed,
            format!("{error:#}"),
        );
    }
    if let Some(ended) = refuse_other_tap_version(&keg, machine, request, progress) {
        return ended;
    }
    // brew installs and switches the keg in one step, so the last idle check
    // and the work hold come before it, as before a self-replace swap.
    if let Some(before_swap) = machine.before_swap
        && let Err(why) = before_swap(progress)
    {
        // A wait the update may no longer go on ended: that reason, not busy.
        if let Err(ended) = proceed(progress) {
            return ended;
        }
        return fail(progress, UpdatePhase::Refused, UpdateReason::Busy, why);
    }
    if let Err(ended) = proceed(progress) {
        return ended;
    }
    // Idle (after a wait of up to 30 minutes, reported `waiting_idle`): from
    // here the server's download window covers the service, `brew --prefix`
    // and the lock wait, not what is left of the idle one.
    progress.report(UpdatePhase::Downloading, None, None);
    // The path the service is made to start, and the one probed after the
    // upgrade: one value, so the probe runs exactly what the restart runs.
    let stable = keg.prefix.join("opt").join("wsmp").join("bin").join("wsmp");
    // A service that would restart into the old keg's path (still the old
    // build after the upgrade, which keeps it: a later `brew cleanup` may
    // remove it) makes the update useless: stop before the keg changes.
    if let Err(error) = (machine.stable_service)(&stable) {
        return fail(
            progress,
            UpdatePhase::Refused,
            UpdateReason::UnsupportedMethod,
            format!("{error:#}"),
        );
    }
    let lock = match super::homebrew::prefix(&keg).and_then(|prefix| {
        super::homebrew::TapLock::acquire(&prefix, super::homebrew::TAP_LOCK_WAIT, &|| {
            machine.proceed.is_none_or(|proceed| proceed().is_ok())
        })
    }) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            if let Err(ended) = proceed(progress) {
                return ended;
            }
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!(
                    "another `brew update` kept Homebrew's update lock for {} minutes; wsmp was not upgraded",
                    super::homebrew::TAP_LOCK_WAIT.as_secs() / 60
                ),
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
    };
    // Again: a fresh download window for the check and the upgrade.
    progress.report(UpdatePhase::Downloading, None, None);
    // Again, under the lock: someone may have run `brew update` while the node
    // waited for idle. From now until the upgrade has run, an ordinary one
    // fails on the held lock (see step 5 for the ones the lock does not stop).
    if let Some(ended) = refuse_other_tap_version(&keg, machine, request, progress) {
        return ended;
    }
    if let Err(ended) = proceed(progress) {
        return ended;
    }
    // The lock is let go as soon as brew is done.
    let upgraded = super::homebrew::upgrade(&keg, lock);
    if let Err(error) = upgraded {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    match super::install::probe_version(&stable) {
        Ok(version) if version == request.version => {}
        Ok(version) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!(
                    "Homebrew installed wsmp {version}, not {}; the tap changed during the upgrade",
                    request.version
                ),
            );
        }
        // brew has run, so something may have changed on disk; which version is
        // there now is not known.
        Err(error) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!(
                    "Homebrew ran the upgrade, but the installed wsmp's version could not be checked ({error:#}); check `{}` --version before restarting the node",
                    stable.display()
                ),
            );
        }
    }
    if let Err(error) = flow::record_homebrew(machine, request, &stable) {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    Ended::Swapped
}

/// The tap's version check: `Some` (reported) when the update must stop here,
/// before `brew upgrade`: the tap cannot be read, or it has another version.
fn refuse_other_tap_version(
    keg: &super::homebrew::Keg,
    machine: &Machine<'_>,
    request: &Request,
    progress: &mut dyn Progress,
) -> Option<Ended> {
    match super::homebrew::tap_version(keg) {
        Ok(available) => {
            let why = super::homebrew::version_refusal(
                &available,
                &request.version,
                &machine.current_version,
            )?;
            progress.refuse_version(available, super::clip_detail(&why));
            Some(Ended::Stopped)
        }
        Err(error) => {
            progress.report(
                UpdatePhase::Failed,
                Some(UpdateReason::Internal),
                Some(super::clip_detail(&format!("{error:#}"))),
            );
            Some(Ended::Stopped)
        }
    }
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

    /// A Homebrew prefix with a wsmp 0.4.2 keg from `flycockpit/tap` and a fake
    /// `brew`: `--prefix` names the prefix, `list --pinned` names nothing,
    /// `update` leaves `updated`, `info` answers with the version in
    /// `tap-version`, and `upgrade` leaves `upgraded` (the
    /// `HOMEBREW_NO_AUTO_UPDATE` it saw) and installs the tap's version then
    /// (`installed`, and an `opt/wsmp/bin/wsmp` that prints it). Every call is
    /// logged in `calls`. A step can be held: with `hold-<step>` present
    /// (`update`, `info-<n>` for the n-th info, `upgrade`), it leaves
    /// `in-<step>` and waits (10 s at most) for `release-<step>`.
    #[cfg(unix)]
    struct FakeBrew {
        root: tempfile::TempDir,
        prefix: std::path::PathBuf,
        keg: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl FakeBrew {
        fn new(tap_version: &str) -> Self {
            use std::os::unix::fs::PermissionsExt as _;
            let root = tempfile::tempdir().expect("dir");
            let prefix = root.path().join("homebrew");
            let keg = prefix.join("Cellar/wsmp/0.4.2");
            std::fs::create_dir_all(keg.join("bin")).expect("keg");
            std::fs::write(keg.join("bin/wsmp"), "").expect("wsmp");
            std::fs::write(
                keg.join("INSTALL_RECEIPT.json"),
                r#"{"source":{"tap":"flycockpit/tap"}}"#,
            )
            .expect("receipt");
            let brew = prefix.join("bin/brew");
            std::fs::create_dir_all(prefix.join("bin")).expect("bin");
            let dir = root.path().display().to_string();
            let home = prefix.display().to_string();
            std::fs::write(
                &brew,
                format!(
                    "#!/bin/sh\n\
                     r='{dir}'\n\
                     echo \"$1\" >> \"$r/calls\"\n\
                     hold() {{\n\
                       [ -e \"$r/hold-$1\" ] || return 0\n\
                       touch \"$r/in-$1\"\n\
                       i=0\n\
                       while [ ! -e \"$r/release-$1\" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n\
                     }}\n\
                     case \"$1\" in\n\
                     --prefix) printf '%s\\n' '{home}';;\n\
                     update) touch \"$r/updated\"; hold update;;\n\
                     info)\n\
                       n=$(cat \"$r/infos\" 2>/dev/null || echo 0); n=$((n+1)); echo $n > \"$r/infos\"\n\
                       hold info-$n\n\
                       printf '{{\"formulae\":[{{\"name\":\"wsmp\",\"versions\":{{\"stable\":\"%s\"}}}}]}}' \"$(cat \"$r/tap-version\")\";;\n\
                     upgrade)\n\
                       printf '%s' \"$HOMEBREW_NO_AUTO_UPDATE\" > \"$r/upgraded\"\n\
                       hold upgrade\n\
                       v=$(cat \"$r/tap-version\")\n\
                       mkdir -p '{home}/opt/wsmp/bin'\n\
                       printf '#!/bin/sh\\necho \"wsmp %s\"\\n' \"$v\" > '{home}/opt/wsmp/bin/wsmp'\n\
                       [ -e \"$r/broken-probe\" ] && printf '#!/bin/sh\\nexit 3\\n' > '{home}/opt/wsmp/bin/wsmp'\n\
                       chmod 755 '{home}/opt/wsmp/bin/wsmp'\n\
                       printf '%s' \"$v\" > \"$r/installed\";;\n\
                     esac\n\
                     exit 0\n"
                ),
            )
            .expect("brew");
            std::fs::set_permissions(&brew, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            let fake = Self { root, prefix, keg };
            fake.set_tap_version(tap_version);
            fake
        }

        fn set_tap_version(&self, version: &str) {
            std::fs::write(self.root.path().join("tap-version"), version).expect("tap version");
        }

        fn marker(&self, name: &str) -> std::path::PathBuf {
            self.root.path().join(name)
        }

        /// Hold `step` until [`FakeBrew::release`].
        fn hold(&self, step: &str) {
            std::fs::write(self.marker(&format!("hold-{step}")), "").expect("hold");
        }

        fn release(&self, step: &str) {
            std::fs::write(self.marker(&format!("release-{step}")), "").expect("release");
        }

        /// Wait (10 s at most) until a held `step` is reached.
        fn reached(&self, step: &str) -> bool {
            let until = Instant::now() + Duration::from_secs(10);
            while Instant::now() < until {
                if self.marker(&format!("in-{step}")).exists() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            false
        }

        fn installed(&self) -> Option<String> {
            std::fs::read_to_string(self.marker("installed")).ok()
        }

        fn machine<'a>(&self, before_swap: Option<&'a flow::BeforeSwap<'a>>) -> Machine<'a> {
            Machine {
                state_dir: self.root.path().join("state"),
                live: self.keg.join("bin/wsmp"),
                target: "test-target".into(),
                scheduler: None,
                tar: super::super::install::system_tar(),
                current_version: "0.4.2".into(),
                before_swap,
                proceed: None,
                stable_service: |_| Ok(()),
            }
        }

        /// The production worker on this prefix, on its own thread, as a
        /// platform where instances do (not) survive the restart.
        fn worker(
            &self,
            shared: &Arc<Shared>,
            instances_survive: bool,
        ) -> (std::thread::JoinHandle<()>, Receiver<Event>) {
            let (tx, rx) = mpsc::channel();
            let shared = Arc::clone(shared);
            let live = self.keg.join("bin/wsmp");
            let state_dir = self.root.path().join("state");
            let handle = std::thread::spawn(move || {
                run_worker(
                    &frame("AAAAAAAAAAAAAAAAAAAAAA", false),
                    UpdateStrategy::Homebrew,
                    live,
                    state_dir,
                    "test-target".into(),
                    &tx,
                    &shared,
                    &Host {
                        instances_survive,
                        remote: || RemoteUpdates::Allowed,
                        stable_service: |_| Ok(()),
                        scheduler: || None,
                    },
                );
            });
            (handle, rx)
        }
    }

    /// The worker's progress, as (phase, reason), until it ends (10 s at most).
    #[cfg(unix)]
    fn worker_reports(rx: &Receiver<Event>) -> (Vec<(UpdatePhase, Option<UpdateReason>)>, bool) {
        let mut seen = Vec::new();
        let mut restart = false;
        while let Ok(event) = rx.recv_timeout(Duration::from_secs(10)) {
            match event {
                Event::Frame(frame) => {
                    if let NodeFrame::AgentUpdateProgress { phase, reason, .. } = *frame {
                        seen.push((phase, reason));
                    }
                }
                Event::Restart => restart = true,
            }
        }
        (seen, restart)
    }

    #[cfg(unix)]
    fn homebrew_request(version: &str) -> Request {
        Request {
            update_id: "u-1".into(),
            version: version.into(),
            artifact_url: String::new(),
            sha256: String::new(),
            signature: None,
            rollback_after_secs: 90,
            origin: Origin::Server,
        }
    }

    /// Every report, with the `availableVersion` of a version refusal.
    #[cfg(unix)]
    #[derive(Default)]
    struct Seen(Vec<(UpdatePhase, Option<UpdateReason>, Option<String>)>);
    #[cfg(unix)]
    impl Progress for Seen {
        fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, _: Option<String>) {
            self.0.push((phase, reason, None));
        }
        fn refuse_version(&mut self, available: String, _: String) {
            self.0.push((
                UpdatePhase::Refused,
                Some(UpdateReason::VersionMismatch),
                Some(available),
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_homebrew_update_checks_idle_before_brew_changes_anything() {
        let brew = FakeBrew::new("0.4.3");
        let busy = |_: &mut dyn Progress| -> Result<(), String> { Err("busy".into()) };
        let machine = brew.machine(Some(&busy));
        let mut seen = Seen::default();
        assert_eq!(
            homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
            Ended::Stopped
        );
        assert_eq!(
            seen.0,
            [
                (UpdatePhase::Downloading, None, None),
                (UpdatePhase::Refused, Some(UpdateReason::Busy), None)
            ]
        );
        assert!(
            brew.marker("updated").exists(),
            "the tap is refreshed first"
        );
        assert!(
            !brew.marker("upgraded").exists(),
            "brew upgrade must not run while busy"
        );
        assert!(state::load(&machine.update_dir()).expect("load").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_homebrew_tap_with_another_version_is_refused_before_anything_is_installed() {
        // The tap is ahead of the server (and, the same way, behind it).
        for (tap, asked) in [("0.4.4", "0.4.3"), ("0.4.2", "0.4.3")] {
            let brew = FakeBrew::new(tap);
            let idle_checked = std::cell::Cell::new(false);
            let idle = |_: &mut dyn Progress| -> Result<(), String> {
                idle_checked.set(true);
                Ok(())
            };
            let machine = brew.machine(Some(&idle));
            let mut seen = Seen::default();
            assert_eq!(
                homebrew(&machine, &homebrew_request(asked), &mut seen),
                Ended::Stopped
            );
            assert_eq!(
                seen.0,
                [
                    (UpdatePhase::Downloading, None, None),
                    (
                        UpdatePhase::Refused,
                        Some(UpdateReason::VersionMismatch),
                        Some(tap.to_string())
                    )
                ],
                "tap {tap}, asked {asked}"
            );
            assert!(brew.marker("updated").exists());
            assert!(!brew.marker("upgraded").exists(), "nothing is installed");
            assert!(!idle_checked.get(), "refused before it waits for idle");
            assert!(state::load(&machine.update_dir()).expect("load").is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_homebrew_update_installs_the_version_it_checked_even_if_the_tap_moves() {
        // Another shell's `brew update` comes after the last version check, while
        // `brew upgrade` is about to read the formula. It takes Homebrew's update
        // lock first (`flock(2)` on `<prefix>/var/homebrew/locks/update`), as
        // `cmd/update.sh` does: wsmp holds it, so this one cannot move the tap.
        let brew = FakeBrew::new("0.4.3");
        brew.hold("upgrade");
        let (ended, moved) = std::thread::scope(|scope| {
            let update = scope.spawn(|| {
                let idle = |_: &mut dyn Progress| -> Result<(), String> { Ok(()) };
                let machine = brew.machine(Some(&idle));
                homebrew(&machine, &homebrew_request("0.4.3"), &mut Seen::default())
            });
            assert!(brew.reached("upgrade"), "brew upgrade starts");
            let other = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(super::super::homebrew::TapLock::path(&brew.prefix))
                .expect("lock file");
            let moved =
                match nix::fcntl::Flock::lock(other, nix::fcntl::FlockArg::LockExclusiveNonblock) {
                    Ok(_held) => {
                        brew.set_tap_version("0.4.4");
                        true
                    }
                    Err(_) => false,
                };
            brew.release("upgrade");
            (update.join().expect("update"), moved)
        });
        assert!(!moved, "the other `brew update` could not take the lock");
        assert_eq!(ended, Ended::Swapped);
        assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
        assert_eq!(
            std::fs::read_to_string(brew.marker("upgraded")).expect("upgraded"),
            "1",
            "HOMEBREW_NO_AUTO_UPDATE is set"
        );
        // The lock is Homebrew's again once the upgrade has run.
        assert!(
            super::super::homebrew::TapLock::acquire(&brew.prefix, Duration::ZERO, &|| true)
                .expect("lock")
                .is_some()
        );
    }

    /// F-FB-7: the idle wait may take up to 30 minutes, then the service, `brew
    /// --prefix` and up to 5 minutes for Homebrew's lock follow. The server's
    /// `waiting_idle` window (31 minutes) must not have to cover them: the node
    /// says `downloading` as soon as it is idle, before it waits for the lock,
    /// and again once it holds it (a fresh window for the check and the upgrade).
    #[cfg(unix)]
    #[test]
    fn a_homebrew_update_reports_downloading_when_idle_before_it_waits_for_the_lock() {
        struct Phases(std::sync::Arc<std::sync::Mutex<Vec<UpdatePhase>>>);
        impl Progress for Phases {
            fn report(&mut self, phase: UpdatePhase, _: Option<UpdateReason>, _: Option<String>) {
                self.0.lock().expect("seen").push(phase);
            }
        }
        let brew = FakeBrew::new("0.4.3");
        // Another `brew update` holds Homebrew's lock while the node waits for idle.
        std::fs::create_dir_all(
            super::super::homebrew::TapLock::path(&brew.prefix)
                .parent()
                .expect("locks"),
        )
        .expect("locks dir");
        let other = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(super::super::homebrew::TapLock::path(&brew.prefix))
            .expect("lock file");
        let held = nix::fcntl::Flock::lock(other, nix::fcntl::FlockArg::LockExclusiveNonblock)
            .expect("held");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let snapshot = || seen.lock().expect("seen").clone();
        let ended = std::thread::scope(|scope| {
            let update = scope.spawn(|| {
                // The node was busy, then went idle.
                let idle = |progress: &mut dyn Progress| -> Result<(), String> {
                    progress.report(UpdatePhase::WaitingIdle, None, None);
                    Ok(())
                };
                let machine = brew.machine(Some(&idle));
                let mut progress = Phases(std::sync::Arc::clone(&seen));
                homebrew(&machine, &homebrew_request("0.4.3"), &mut progress)
            });
            let until = Instant::now() + Duration::from_secs(10);
            while snapshot().len() < 3 && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
            // Still waiting for the lock (nothing installed), and already
            // `downloading` again since it went idle.
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(
                snapshot(),
                [
                    UpdatePhase::Downloading,
                    UpdatePhase::WaitingIdle,
                    UpdatePhase::Downloading
                ]
            );
            assert!(!brew.marker("upgraded").exists(), "waiting for the lock");
            drop(held);
            update.join().expect("update")
        });
        assert_eq!(ended, Ended::Swapped);
        // Once it holds the lock: `downloading` again, for the check and the upgrade.
        assert_eq!(
            snapshot(),
            [
                UpdatePhase::Downloading,
                UpdatePhase::WaitingIdle,
                UpdatePhase::Downloading,
                UpdatePhase::Downloading
            ]
        );
        assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
    }

    /// Every report's detail.
    #[cfg(unix)]
    #[derive(Default)]
    struct Details(Vec<(UpdatePhase, Option<UpdateReason>, Option<String>)>);
    #[cfg(unix)]
    impl Progress for Details {
        fn report(
            &mut self,
            phase: UpdatePhase,
            reason: Option<UpdateReason>,
            detail: Option<String>,
        ) {
            self.0.push((phase, reason, detail));
        }
    }

    /// brew installed the asked-for version, but its version cannot be read
    /// back: the failure says it could not be checked, not that another
    /// version was installed.
    #[cfg(unix)]
    #[test]
    fn a_version_that_cannot_be_checked_after_brew_says_so() {
        let brew = FakeBrew::new("0.4.3");
        std::fs::write(brew.marker("broken-probe"), "").expect("marker");
        let mut seen = Details::default();
        let ended = homebrew(&brew.machine(None), &homebrew_request("0.4.3"), &mut seen);
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
        let (phase, reason, detail) = seen.0.last().cloned().expect("a report");
        assert_eq!(
            (phase, reason),
            (UpdatePhase::Failed, Some(UpdateReason::VersionMismatch))
        );
        let detail = detail.expect("detail");
        assert!(detail.contains("could not be checked"), "{detail}");
        assert!(!detail.contains("installed wsmp 0"), "{detail}");
        // A version that is read back and differs still says which.
        let brew = FakeBrew::new("0.4.3");
        let mut seen = Details::default();
        let ended = homebrew(&brew.machine(None), &homebrew_request("0.4.4"), &mut seen);
        assert_eq!(ended, Ended::Stopped);
        assert!(seen.0.iter().all(|(_, _, detail)| {
            detail
                .as_deref()
                .is_none_or(|d| !d.contains("could not be checked"))
        }));
    }

    #[cfg(unix)]
    #[test]
    fn a_homebrew_tap_that_moves_while_the_node_waits_is_refused_under_the_lock() {
        // The tap moves between the first check and the one under the lock (a
        // `brew update` while the node waited for idle).
        let brew = FakeBrew::new("0.4.3");
        let moved = |_: &mut dyn Progress| -> Result<(), String> {
            brew.set_tap_version("0.4.4");
            Ok(())
        };
        let machine = brew.machine(Some(&moved));
        let mut seen = Seen::default();
        assert_eq!(
            homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
            Ended::Stopped
        );
        assert_eq!(
            seen.0.last(),
            Some(&(
                UpdatePhase::Refused,
                Some(UpdateReason::VersionMismatch),
                Some("0.4.4".to_string())
            ))
        );
        assert!(!brew.marker("upgraded").exists(), "nothing is installed");
    }

    /// The path [`Machine::stable_service`] makes the service start is the
    /// path the update probes after `brew upgrade`: the probe is what shows
    /// the restart target runs (RC6), so they must be the same path.
    #[cfg(unix)]
    #[test]
    fn the_service_is_made_to_start_exactly_the_path_the_update_probes() {
        static GIVEN: std::sync::Mutex<Vec<std::path::PathBuf>> = std::sync::Mutex::new(Vec::new());
        let brew = FakeBrew::new("0.4.3");
        let machine = Machine {
            stable_service: |stable| {
                GIVEN.lock().expect("given").push(stable.to_path_buf());
                Ok(())
            },
            ..brew.machine(None)
        };
        assert_eq!(
            homebrew(&machine, &homebrew_request("0.4.3"), &mut Seen::default()),
            Ended::Swapped
        );
        let stable = brew.prefix.join("opt/wsmp/bin/wsmp");
        assert_eq!(*GIVEN.lock().expect("given"), vec![stable.clone()]);
        // What was probed (and recorded) is that path: the fake upgrade put a
        // `wsmp 0.4.3` there, and only it.
        let recorded = state::load(&machine.update_dir())
            .expect("load")
            .expect("recorded");
        assert_eq!(recorded.live_path, stable);
        assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
        // A target that does not run stops the update after brew, recording
        // nothing: no restart into it.
        let broken = FakeBrew::new("0.4.3");
        std::fs::write(broken.marker("broken-probe"), "").expect("marker");
        let machine = Machine {
            stable_service: |_| Ok(()),
            ..broken.machine(None)
        };
        let mut seen = Seen::default();
        assert_eq!(
            homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
            Ended::Stopped
        );
        assert_eq!(
            seen.0.last(),
            Some(&(
                UpdatePhase::Failed,
                Some(UpdateReason::VersionMismatch),
                None
            ))
        );
        assert!(state::load(&machine.update_dir()).expect("load").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_service_that_cannot_move_to_the_stable_path_stops_a_homebrew_update_first() {
        let brew = FakeBrew::new("0.4.3");
        let machine = Machine {
            stable_service: |_| Err(anyhow::anyhow!("the relay service cannot be read")),
            ..brew.machine(None)
        };
        let mut seen = Seen::default();
        assert_eq!(
            homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
            Ended::Stopped
        );
        assert_eq!(
            seen.0.last(),
            Some(&(
                UpdatePhase::Refused,
                Some(UpdateReason::UnsupportedMethod),
                None
            ))
        );
        assert!(!brew.marker("upgraded").exists(), "the keg is untouched");
        assert!(state::load(&machine.update_dir()).expect("load").is_none());
    }

    /// F-FA-3 through the production worker: an earlier update left `armed` before its swap with
    /// no rollback job (its arming and its terminal saves failed) no longer refuses every later
    /// update "in progress" until the relay restarts. The worker, holding the update lock, settles
    /// it and goes on (here to the tap check). Inverse: one whose swap began is still in progress.
    #[cfg(unix)]
    #[test]
    fn a_worker_settles_an_update_abandoned_before_its_swap_and_goes_on() {
        for swap_began in [false, true] {
            let brew = FakeBrew::new("0.4.4");
            let update_dir = brew.root.path().join("state/update");
            let bin = brew.root.path().join("self-replace");
            std::fs::create_dir_all(&bin).expect("bin");
            let mut abandoned = state::sample(&bin, state::Phase::Armed);
            abandoned.update_id = "ZZZZZZZZZZZZZZZZZZZZZZ".into();
            std::fs::write(&abandoned.live_path, "old").expect("live");
            if !swap_began {
                std::fs::write(bin.join("wsmp.new"), "new").expect("new");
            }
            state::save(&update_dir, &abandoned).expect("save");
            let shared = Arc::new(Shared::default());
            shared.no_instances.store(true, Ordering::SeqCst);
            shared.no_commands.store(true, Ordering::SeqCst);
            let (worker, rx) = brew.worker(&shared, true);
            let (seen, _) = worker_reports(&rx);
            worker.join().expect("worker");
            let stored = state::load(&update_dir).expect("load").expect("state");
            if swap_began {
                assert_eq!(
                    seen,
                    [(UpdatePhase::Refused, Some(UpdateReason::InProgress))]
                );
                assert_eq!(stored.phase(), state::Phase::Armed);
            } else {
                assert_eq!(
                    seen,
                    [
                        (UpdatePhase::Downloading, None),
                        (UpdatePhase::Refused, Some(UpdateReason::VersionMismatch)),
                    ]
                );
                assert_eq!(stored.update_id, "ZZZZZZZZZZZZZZZZZZZZZZ");
                assert_eq!(stored.phase(), state::Phase::Failed);
                assert!(!bin.join("wsmp.new").exists());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_busy_node_hears_about_the_taps_version_before_it_waits_for_idle() {
        // macOS (instances do not survive the restart): the worker waits for idle
        // only after the tap check, so the refusal comes at once.
        let brew = FakeBrew::new("0.4.4");
        let shared = Arc::new(Shared::default());
        // Busy: an instance runs.
        shared.no_instances.store(false, Ordering::SeqCst);
        let started = Instant::now();
        let (worker, rx) = brew.worker(&shared, false);
        let (seen, restart) = worker_reports(&rx);
        // Checked before the join: a worker that waits for idle first would
        // hold the join for 30 minutes.
        assert_eq!(
            seen,
            [
                (UpdatePhase::Downloading, None),
                (UpdatePhase::Refused, Some(UpdateReason::VersionMismatch)),
            ]
        );
        worker.join().expect("worker");
        assert!(!restart);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(!brew.marker("upgraded").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_node_lowered_while_brew_runs_installs_nothing() {
        // Lowered to Relay only while the tap refreshes, or while the last
        // version check runs: the next step that changes something refuses.
        for step in ["update", "info-2"] {
            let brew = FakeBrew::new("0.4.3");
            brew.hold(step);
            let shared = Arc::new(Shared::default());
            shared.no_instances.store(true, Ordering::SeqCst);
            shared.no_commands.store(true, Ordering::SeqCst);
            let (worker, rx) = brew.worker(&shared, true);
            assert!(brew.reached(step), "{step} runs");
            shared.lowered.store(true, Ordering::SeqCst);
            brew.release(step);
            let (seen, restart) = worker_reports(&rx);
            worker.join().expect("worker");
            assert_eq!(
                seen.last(),
                Some(&(UpdatePhase::Refused, Some(UpdateReason::NotOwnerTrust))),
                "{step}: {seen:?}"
            );
            assert!(!restart, "{step}");
            assert!(
                !brew.marker("upgraded").exists(),
                "{step}: nothing installed"
            );
        }
    }

    /// F-FA-2 (P-BOUNDARY): trust lowered through the daemon's own authority
    /// ([`crate::startup::TerminalStartup::lower_trust`]) while the last
    /// version check runs, with no relay poll after it (`Shared.lowered` is
    /// never set): the worker's check before `brew upgrade` sees the lowering
    /// and installs nothing. Lowered and raised again before the check: that
    /// attempt is still refused. Inverse: not lowered, the same worker
    /// upgrades and restarts.
    #[cfg(unix)]
    #[test]
    fn a_lowering_reaches_the_update_worker_without_a_poll() {
        use crate::protocol::frames::TrustValue;
        for case in ["lowered", "lowered-then-raised", "not-lowered"] {
            let config = crate::config::Config {
                trust: Some(TrustValue::Full),
                ..crate::config::Config::default()
            };
            let startup = crate::startup::TerminalStartup::from_key(
                crate::terminal_crypto::CliTerminalKey::generate().expect("key"),
                &config,
            );
            let brew = FakeBrew::new("0.4.3");
            brew.hold("info-2");
            let shared = Arc::new(Shared::new(startup.trust_watch()));
            shared.no_instances.store(true, Ordering::SeqCst);
            shared.no_commands.store(true, Ordering::SeqCst);
            let (worker, rx) = brew.worker(&shared, true);
            assert!(brew.reached("info-2"), "{case}: the last check runs");
            match case {
                "lowered" => {
                    assert!(startup.lower_trust());
                }
                "lowered-then-raised" => {
                    assert!(startup.lower_trust());
                    assert!(startup.raise_trust());
                    assert!(startup.full_control());
                }
                _ => {}
            }
            // No poll: the relay loop's copy was never told.
            assert!(!shared.lowered.load(Ordering::SeqCst), "{case}");
            brew.release("info-2");
            let (seen, restart) = worker_reports(&rx);
            worker.join().expect("worker");
            if case == "not-lowered" {
                assert!(restart, "{case}: {seen:?}");
                assert!(brew.marker("upgraded").exists(), "{case}: upgraded");
            } else {
                assert_eq!(
                    seen.last(),
                    Some(&(UpdatePhase::Refused, Some(UpdateReason::NotOwnerTrust))),
                    "{case}: {seen:?}"
                );
                assert!(!restart, "{case}");
                assert!(
                    !brew.marker("upgraded").exists(),
                    "{case}: nothing installed"
                );
            }
        }
    }

    /// F-FA-2: an update asked under a watch that a lowering revoked since
    /// (lowered and raised again before the frame was answered) is refused at
    /// once. Inverse: a watch taken after the raise starts the worker.
    #[test]
    fn an_update_asked_under_a_revoked_watch_is_refused() {
        use crate::protocol::frames::TrustValue;
        let config = crate::config::Config {
            trust: Some(TrustValue::Full),
            ..crate::config::Config::default()
        };
        let startup = crate::startup::TerminalStartup::from_key(
            crate::terminal_crypto::CliTerminalKey::generate().expect("key"),
            &config,
        );
        let before = startup.trust_watch();
        assert!(startup.lower_trust());
        assert!(startup.raise_trust());
        let gate = Gate {
            full_control: startup.full_control(),
            remote: RemoteUpdates::Allowed,
            method: InstallMethod::Unknown,
            has_live: true,
            under_service: true,
        };
        let mut tracker = tracker();
        let reason_of = |frames: Vec<NodeFrame>| match frames.as_slice() {
            [NodeFrame::AgentUpdateProgress { reason, .. }] => *reason,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            reason_of(tracker.request(frame("CCCCCCCCCCCCCCCCCCCCCC", false), &gate, before)),
            Some(UpdateReason::NotOwnerTrust)
        );
        // Inverse: the gate after that (here: the install method) decides.
        assert_eq!(
            reason_of(tracker.request(
                frame("DDDDDDDDDDDDDDDDDDDDDD", false),
                &gate,
                startup.trust_watch()
            )),
            Some(UpdateReason::UnsupportedMethod)
        );
    }

    /// F-FA-3: a worker waiting for a busy node to go idle stops waiting as
    /// soon as the node is lowered: refused with that reason (not busy, not
    /// after 30 minutes), nothing installed, its hold on new work let go and
    /// the worker ended (so the update lock is free). Both waits: Homebrew's
    /// last idle check (holding new work) and a self-replace's before its
    /// download. Inverse: the same busy worker, not lowered, is still waiting.
    /// Lowered through the daemon's authority (F-FA-2), with no poll after it.
    #[cfg(unix)]
    #[test]
    fn a_node_lowered_while_its_update_waits_for_idle_stops_waiting() {
        for strategy in [UpdateStrategy::Homebrew, UpdateStrategy::SelfReplace] {
            let brew = FakeBrew::new("0.4.3");
            let startup = crate::startup::TerminalStartup::from_key(
                crate::terminal_crypto::CliTerminalKey::generate().expect("key"),
                &crate::config::Config {
                    trust: Some(crate::protocol::frames::TrustValue::Full),
                    ..crate::config::Config::default()
                },
            );
            let shared = Arc::new(Shared::new(startup.trust_watch()));
            // Busy: an instance runs.
            shared.no_instances.store(false, Ordering::SeqCst);
            let (tx, rx) = mpsc::channel();
            let worker_shared = Arc::clone(&shared);
            let live = brew.keg.join("bin/wsmp");
            let state_dir = brew.root.path().join("state");
            let worker = std::thread::spawn(move || {
                run_worker(
                    &frame("AAAAAAAAAAAAAAAAAAAAAA", false),
                    strategy,
                    live,
                    state_dir,
                    "test-target".into(),
                    &tx,
                    &worker_shared,
                    &Host {
                        instances_survive: false,
                        remote: || RemoteUpdates::Allowed,
                        stable_service: |_| Ok(()),
                        scheduler: || None,
                    },
                );
            });
            let mut seen = Vec::new();
            while let Ok(Event::Frame(frame)) = rx.recv_timeout(Duration::from_secs(10)) {
                if let NodeFrame::AgentUpdateProgress { phase, reason, .. } = *frame {
                    seen.push((phase, reason));
                    if phase == UpdatePhase::WaitingIdle {
                        break;
                    }
                }
            }
            assert_eq!(
                seen.last(),
                Some(&(UpdatePhase::WaitingIdle, None)),
                "{strategy:?}"
            );
            // Inverse: not lowered, still waiting (and, for Homebrew, holding).
            std::thread::sleep(Duration::from_millis(2500));
            assert!(!worker.is_finished(), "{strategy:?}: still waiting");
            assert_eq!(
                shared.stage.load(),
                if strategy == UpdateStrategy::Homebrew {
                    WorkerStage::HoldingWaitingIdle
                } else {
                    WorkerStage::WaitingIdle
                },
                "{strategy:?}"
            );
            let lowered_at = Instant::now();
            assert!(startup.lower_trust());
            let (rest, restart) = worker_reports(&rx);
            // Checked before the join: a worker that kept waiting would hold
            // the join for up to 30 minutes.
            assert_eq!(
                rest,
                [(UpdatePhase::Refused, Some(UpdateReason::NotOwnerTrust))],
                "{strategy:?}"
            );
            assert!(
                lowered_at.elapsed() < Duration::from_secs(5),
                "{strategy:?}"
            );
            worker.join().expect("worker");
            assert!(!restart);
            assert_eq!(
                shared.stage.load(),
                WorkerStage::Preparing,
                "{strategy:?}: hold let go"
            );
            assert!(!brew.marker("upgraded").exists(), "{strategy:?}");
            assert!(
                state::UpdateLock::acquire(&brew.root.path().join("state/update"))
                    .expect("lock")
                    .is_some(),
                "{strategy:?}: the update lock is free"
            );
        }
    }

    #[test]
    fn a_version_refusal_names_the_available_version() {
        let (tx, rx) = mpsc::channel();
        let mut sink = Sink {
            update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            tx,
        };
        sink.refuse_version("0.4.4".into(), "the tap has 0.4.4".into());
        let Ok(Event::Frame(frame)) = rx.try_recv() else {
            panic!("a frame");
        };
        assert!(frame.validate().is_ok());
        assert!(matches!(
            *frame,
            NodeFrame::AgentUpdateProgress {
                phase: UpdatePhase::Refused,
                reason: Some(UpdateReason::VersionMismatch),
                available_version: Some(ref version),
                ..
            } if version == "0.4.4"
        ));
        // Not a release version: the refusal goes out without it.
        sink.refuse_version("HEAD".into(), "odd".into());
        let Ok(Event::Frame(frame)) = rx.try_recv() else {
            panic!("a frame");
        };
        assert!(matches!(
            *frame,
            NodeFrame::AgentUpdateProgress {
                available_version: None,
                ..
            }
        ));
    }

    /// Every key path of a JSON value (`features.selfUpdate.remote`), array items as `[]`.
    fn key_paths(
        value: &serde_json::Value,
        prefix: &str,
        out: &mut std::collections::BTreeSet<String>,
    ) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, inner) in map {
                    let path = if prefix.is_empty() {
                        key.clone()
                    } else {
                        format!("{prefix}.{key}")
                    };
                    out.insert(path.clone());
                    key_paths(inner, &path, out);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    key_paths(item, &format!("{prefix}[]"), out);
                }
            }
            _ => {}
        }
    }

    /// The key paths of the frames wsmp 0.4.3 sent (frozen in `tests/fixtures/released/0.4.3`),
    /// which a 0.4.3 server's strict schemas accept.
    fn released_paths(names: &[&str]) -> std::collections::BTreeSet<String> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/released/0.4.3/frames/node-to-server");
        let mut out = std::collections::BTreeSet::new();
        for name in names {
            let text = std::fs::read_to_string(dir.join(name)).expect("released fixture");
            let value: serde_json::Value = serde_json::from_str(&text).expect("json");
            key_paths(&value, "", &mut out);
        }
        out
    }

    #[test]
    fn the_hello_self_update_has_only_what_a_0_4_3_server_reads() {
        let released = released_paths(&["hello-self-update.json"]);
        let ours = serde_json::json!({ "features": { "selfUpdate": features() } });
        let mut paths = std::collections::BTreeSet::new();
        key_paths(&ours, "", &mut paths);
        let new: Vec<_> = paths.difference(&released).collect();
        assert!(new.is_empty(), "fields a 0.4.3 server refuses: {new:?}");
    }

    #[test]
    fn a_refusal_names_the_available_version_only_to_a_server_that_accepts_it() {
        let released = released_paths(&[
            "agent.update.progress.json",
            "agent.update.progress-refused.json",
        ]);
        let mut tracker = tracker();
        let id = "AAAAAAAAAAAAAAAAAAAAAA";
        let refuse = |tracker: &mut DaemonUpdate| {
            let (_shared, tx) = waiting_worker(tracker, id);
            let mut sink = Sink {
                update_id: id.into(),
                tx,
            };
            sink.refuse_version("0.4.4".into(), "the tap has wsmp 0.4.4, not 0.4.3".into());
            drop(sink);
            let (frames, _) = tracker.poll(true);
            let [frame] = frames.as_slice() else {
                panic!("one frame: {frames:?}");
            };
            assert!(frame.validate().is_ok());
            serde_json::to_value(frame).expect("serializes")
        };
        // A server that did not say it accepts it (0.4.3): today's frame shape exactly, the
        // version only in the detail.
        tracker.on_hello_ok(DefinitionSync::None, false);
        let plain = refuse(&mut tracker);
        assert_eq!(plain["reason"], "version_mismatch");
        assert!(plain.get("availableVersion").is_none());
        assert!(
            plain["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("0.4.4")),
            "{plain}"
        );
        let mut paths = std::collections::BTreeSet::new();
        key_paths(&plain, "", &mut paths);
        let new: Vec<_> = paths.difference(&released).collect();
        assert!(new.is_empty(), "fields a 0.4.3 server refuses: {new:?}");
        // A server that does.
        tracker.on_session_end();
        tracker.on_hello_ok(DefinitionSync::None, true);
        assert_eq!(refuse(&mut tracker)["availableVersion"], "0.4.4");
        // A reconnect to another server forgets it.
        tracker.on_session_end();
        tracker.on_hello_ok(DefinitionSync::None, false);
        assert!(refuse(&mut tracker).get("availableVersion").is_none());
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
            tracking: Tracking::Idle,
            connection: Connection::Registered {
                synced: true,
                available_version_accepted: false,
            },
            outbox: Vec::new(),
            current_id: None,
            own_sha256: None,
        }
    }

    fn waiting_worker(tracker: &mut DaemonUpdate, id: &str) -> (Arc<Shared>, Sender<Event>) {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared::default());
        shared.stage.set(WorkerStage::WaitingIdle);
        tracker.current_id = Some(id.into());
        tracker.tracking = Tracking::Installing(Worker {
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
        let other = tracker.request(
            frame("BBBBBBBBBBBBBBBBBBBBBB", true),
            &gate(),
            TrustWatch::full_for_tests(),
        );
        assert_eq!(reason_of(&other), Some(UpdateReason::InProgress));
        // The same one unforced: no answer, the worker goes on.
        assert!(
            tracker
                .request(frame(id, false), &gate(), TrustWatch::full_for_tests())
                .is_empty()
        );
        assert!(!shared.force.load(Ordering::SeqCst));
        // With force: no answer; the server stops the instances.
        assert!(
            tracker
                .request(frame(id, true), &gate(), TrustWatch::full_for_tests())
                .is_empty()
        );
        assert!(shared.force.load(Ordering::SeqCst));
        // A late force once the worker stopped waiting: still no refusal.
        assert!(shared.stage.advance(WorkerStage::end_wait, "test"));
        assert!(!tracker.wants_idle());
        assert!(
            tracker
                .request(frame(id, true), &gate(), TrustWatch::full_for_tests())
                .is_empty()
        );
        // Awaiting the restart: the same id gets no answer either.
        tracker.tracking = Tracking::Restarting;
        assert!(
            tracker
                .request(frame(id, true), &gate(), TrustWatch::full_for_tests())
                .is_empty()
        );
    }

    #[test]
    fn a_node_lowered_to_relay_only_stops_its_update() {
        let mut tracker = tracker();
        let (shared, _tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
        let _ = tracker.poll(true);
        assert!(!shared.lowered.load(Ordering::SeqCst));
        let _ = tracker.poll(false);
        assert!(shared.lowered.load(Ordering::SeqCst));
    }

    #[test]
    fn new_work_is_held_from_the_last_idle_check_to_the_restart() {
        let mut tracker = tracker();
        let (shared, _tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
        assert!(!tracker.holds_new_work());
        assert!(shared.stage.advance(WorkerStage::end_wait, "test"));
        assert!(shared.stage.advance(WorkerStage::hold, "test"));
        assert!(tracker.holds_new_work());
        assert!(shared.stage.advance(WorkerStage::begin_wait, "test"));
        assert!(tracker.holds_new_work() && tracker.wants_idle());
        assert!(shared.stage.advance(WorkerStage::end_wait, "test"));
        assert!(tracker.holds_new_work() && !tracker.wants_idle());
        tracker.tracking = Tracking::Idle;
        assert!(!tracker.holds_new_work(), "the worker stopped: no hold");
        tracker.tracking = Tracking::Restarting;
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
        assert!(!wait_idle(
            &shared,
            &mut sink,
            Duration::from_millis(10),
            &|| false
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(Event::Frame(frame)) if matches!(*frame, NodeFrame::AgentUpdateProgress {
                phase: UpdatePhase::WaitingIdle,
                ..
            })
        ));
        shared.force.store(true, Ordering::SeqCst);
        assert!(wait_idle(
            &shared,
            &mut sink,
            Duration::from_millis(10),
            &|| false
        ));
        shared.no_instances.store(false, Ordering::SeqCst);
        assert!(!wait_idle(
            &shared,
            &mut sink,
            Duration::from_millis(10),
            &|| false
        ));
    }

    #[test]
    fn the_restart_waits_for_the_progress_only_on_a_live_session() {
        let mut tracker = tracker();
        tracker.on_session_end();
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
        assert_eq!(tracker.poll(true), (Vec::new(), true));
        // Registered: the progress goes out first.
        tracker.on_hello_ok(DefinitionSync::None, false);
        let (frames, restart) = tracker.poll(true);
        assert_eq!(frames.len(), 1);
        assert!(restart);
        // A new update while the restart is pending is in progress.
        let refused = tracker.request(
            frame("BBBBBBBBBBBBBBBBBBBBBB", false),
            &gate(),
            TrustWatch::full_for_tests(),
        );
        assert_eq!(reason_of(&refused), Some(UpdateReason::InProgress));
    }
}
