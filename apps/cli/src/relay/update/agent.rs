//! The relay's side of self-update: answering `agent.update` (the gates, the
//! worker thread that installs), confirming a new build once the session is
//! healthy, and reporting how an update ended after a restart.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use anyhow::Result;

use super::flow::{self, Ended, Machine, OnStart, Progress, Request};
use super::state::{self, Origin, UpdateState};
use crate::node::trust::TrustWatch;
use crate::wire::protocol::frames::{DefinitionSync, NodeFrame, UpdatePhase, UpdateReason};
use crate::wire::protocol::runtime_spec::{RemoteUpdates, UpdateStrategy};

mod brew;
mod gate;

pub use brew::homebrew;
pub use gate::{Gate, UpdateFrame, features, instances_survive, running_instances, strategies};
use gate::{check_gate, remote_setting};

/// A new build confirms after `hello.ok`, the definition sync and this long alive.
pub const CONFIRM_ALIVE: Duration = Duration::from_secs(30);
/// Unconfirmed starts of a new build before it rolls itself back.
pub const MAX_UNCONFIRMED_STARTS: u32 = 3;
/// How long an update waits for the node to go idle before `refused`/`busy`.
pub const IDLE_WAIT_MAX: Duration = Duration::from_secs(30 * 60);
const CONFIRM_RETRY_INITIAL: Duration = Duration::from_secs(1);
const CONFIRM_RETRY_MAX: Duration = Duration::from_secs(60);

struct ConfirmRetry {
    next_attempt: Option<Instant>,
    delay: Duration,
}

impl Default for ConfirmRetry {
    fn default() -> Self {
        Self {
            next_attempt: None,
            delay: CONFIRM_RETRY_INITIAL,
        }
    }
}

impl ConfirmRetry {
    fn ready(&self, now: Instant) -> bool {
        self.next_attempt.is_none_or(|next| now >= next)
    }

    fn failed(&mut self, now: Instant) -> Duration {
        let delay = self.delay;
        self.next_attempt = Some(now + delay);
        self.delay = delay.saturating_mul(2).min(CONFIRM_RETRY_MAX);
        delay
    }
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
        // A CAS loop rather than `fetch_update`, which current Rust deprecates for a
        // replacement newer than our MSRV (1.89).
        let mut value = self.0.load(Ordering::SeqCst);
        let moved = loop {
            let Some(next) = step(WorkerStage::from_u8(value)) else {
                break false;
            };
            match self.0.compare_exchange_weak(
                value,
                next as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break true,
                Err(current) => value = current,
            }
        };
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
    /// ([`TerminalStartup::trust_watch`](crate::relay::startup::TerminalStartup::trust_watch)):
    /// revoked at the lowering itself, not at the next poll, and for good.
    trust: TrustWatch,
}

impl Shared {
    fn new(trust: TrustWatch, force: bool) -> Self {
        Self {
            no_instances: AtomicBool::new(false),
            no_commands: AtomicBool::new(false),
            stage: AtomicStage::new(),
            force: AtomicBool::new(force),
            lowered: AtomicBool::new(false),
            trust,
        }
    }

    /// The node is not at Full control for this update any more.
    fn revoked(&self) -> bool {
        self.lowered.load(Ordering::SeqCst) || self.trust.revoked()
    }

    /// The owner forced the update after it was asked for (a late `force`).
    fn force(&self) {
        self.force.store(true, Ordering::SeqCst);
    }

    /// The relay loop saw the node lose Full control.
    fn lower(&self) {
        self.lowered.store(true, Ordering::SeqCst);
    }

    /// The relay loop's report of what runs on the node now.
    fn set_idle(&self, no_instances: bool, no_commands: bool) {
        self.no_instances.store(no_instances, Ordering::SeqCst);
        self.no_commands.store(no_commands, Ordering::SeqCst);
    }

    /// No instance runs and, unless the update is forced, no node command.
    fn is_idle(&self) -> bool {
        self.no_instances.load(Ordering::SeqCst)
            && (self.force.load(Ordering::SeqCst) || self.no_commands.load(Ordering::SeqCst))
    }

    /// See [`WorkerStage::wants_idle`].
    fn wants_idle(&self) -> bool {
        self.stage.load().wants_idle()
    }

    /// See [`WorkerStage::holds_new_work`].
    fn holds_new_work(&self) -> bool {
        self.stage.load().holds_new_work()
    }

    /// From here to the restart, the relay loop starts no new work.
    fn hold_new_work(&self) {
        self.stage.advance(WorkerStage::hold, "hold new work");
    }

    /// The update will not restart after all: new work may start again.
    fn release_new_work(&self) {
        self.stage
            .advance(WorkerStage::release, "let go of new work");
    }

    /// Wait (bounded) until the node is idle: no instance runs and, unless the
    /// update is forced, no node command. A forced update's instances are stopped
    /// by the server. `false` when it did not go idle in time, or as soon as
    /// `stopped` (the node was lowered, or its operator turned remote updates
    /// off: the caller then refuses with that reason).
    fn wait_idle(
        &self,
        progress: &mut dyn Progress,
        limit: Duration,
        stopped: &dyn Fn() -> bool,
    ) -> bool {
        // The relay loop answers within a poll or two.
        self.stage.advance(WorkerStage::begin_wait, "wait for idle");
        let end_wait = || {
            self.stage
                .advance(WorkerStage::end_wait, "end the wait for idle")
        };
        std::thread::sleep(Duration::from_millis(1500));
        if self.is_idle() {
            end_wait();
            return true;
        }
        progress.report(UpdatePhase::WaitingIdle, None, None);
        let until = Instant::now() + limit;
        while Instant::now() < until && !stopped() {
            std::thread::sleep(Duration::from_secs(1));
            if self.is_idle() {
                end_wait();
                return true;
            }
        }
        end_wait();
        false
    }
}

#[cfg(test)]
impl Default for Shared {
    fn default() -> Self {
        Self::new(TrustWatch::full_for_tests(), false)
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
            && crate::wire::protocol::frames::is_release_version(&available)
        {
            *available_version = Some(available);
        }
        let _ = self.tx.send(Event::Frame(Box::new(frame)));
    }
}

/// Remember the pre-start counter across errors, including a rename that
/// succeeded before a directory sync failed. Replaying on_start must never
/// increment this process's durable counter twice.
#[derive(Default)]
struct StartInitialization {
    before: Option<(String, u32)>,
    own_sha256: Option<String>,
}

impl StartInitialization {
    fn attempt(&mut self) -> Result<OnStart> {
        let update_dir = super::update_dir()?;
        self.attempt_at(
            &update_dir,
            super::build::version(),
            super::deadman::platform().as_deref(),
        )
    }

    fn attempt_at(
        &mut self,
        update_dir: &Path,
        version: &str,
        scheduler: Option<&dyn super::deadman::Scheduler>,
    ) -> Result<OnStart> {
        if let Some(current) = state::load(update_dir)? {
            if current.in_progress() && self.own_sha256.is_none() {
                self.own_sha256 = own_sha256();
            }
            if let Some((id, attempts)) = &self.before {
                anyhow::ensure!(
                    id == &current.update_id,
                    "the update changed during startup initialization"
                );
                if current.attempts > *attempts {
                    // A previous call persisted its count but returned an I/O error.
                    // Resume only a valid trial, never a decided rollback.
                    return match current.lifecycle {
                        state::Lifecycle::Swapped
                            if current.attempts <= MAX_UNCONFIRMED_STARTS
                                && current.is_new_build(version, self.own_sha256.as_deref()) =>
                        {
                            Ok(OnStart::AwaitConfirm(current))
                        }
                        state::Lifecycle::RolledBack { .. } => Ok(OnStart::RolledBackSelf),
                        _ => anyhow::bail!(
                            "update startup was already counted; refusing to count it again"
                        ),
                    };
                }
            } else {
                self.before = Some((current.update_id.clone(), current.attempts));
            }
        }
        flow::on_start(
            update_dir,
            scheduler,
            flow::Running {
                version,
                sha256: self.own_sha256.as_deref(),
            },
            MAX_UNCONFIRMED_STARTS,
            super::unix_now(),
        )
    }
}

/// Retry transient lock/I/O failures with capped exponential backoff. All waits
/// and filesystem work after the first failure run on the startup worker.
fn retry_start(
    mut attempt: impl FnMut() -> Result<OnStart>,
    mut wait: impl FnMut(Duration),
) -> Result<OnStart> {
    let mut delay = Duration::from_secs(1);
    for retry in 0..6 {
        wait(delay);
        match attempt() {
            Ok(result) => return Ok(result),
            Err(error) if retry == 5 => return Err(error),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "retrying update tracking initialization")
            }
        }
        delay = delay.saturating_mul(2).min(Duration::from_secs(30));
    }
    anyhow::bail!("update tracking initialization exhausted its retries")
}

/// What the relay is doing about updates.
///
/// ```text
/// Idle ──request──▶ Installing ──swapped──▶ Restarting
///                      └──stopped──▶ Idle
/// (start error) Initializing ──ready──▶ AwaitingConfirm / Idle / Restarting
///                    └──exhausted──▶ InitializationFailed
/// (start) AwaitingConfirm ──healthy──▶ Confirming ──confirmed / not ours──▶ Idle
///                 ▲                    ├──rolled back first──▶ Restarting
///                 └──error / dead thread──┘
/// ```
enum Tracking {
    /// No update runs here (one may have ended: a repeat of its `agent.update` reports it).
    Idle,
    /// Startup failed; a bounded retry worker initializes without blocking relay I/O.
    Initializing(Receiver<Result<OnStart>>),
    /// Initialization exhausted its retries. Never confirm or install without a snapshot.
    InitializationFailed,
    /// A worker installs one.
    Installing(Worker),
    /// This build is an update that has not confirmed yet: it confirms once the session is
    /// healthy.
    AwaitingConfirm(Box<UpdateState>),
    /// Confirmation runs off the relay loop; polling applies its result.
    Confirming {
        awaiting: Box<UpdateState>,
        rx: Receiver<Result<flow::Confirm>>,
    },
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
    confirm_retry: ConfirmRetry,
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
            confirm_retry: ConfirmRetry::default(),
        };
        let mut initialization = StartInitialization::default();
        match initialization.attempt() {
            Ok(result) => {
                if matches!(result, OnStart::RolledBackSelf) {
                    return Err(anyhow::anyhow!(
                        "this build did not confirm after {MAX_UNCONFIRMED_STARTS} starts and rolled back; restarting into the previous wsmp"
                    ).context(crate::exit::CodedError::new(
                        crate::exit::ExitCode::RestartForUpdate,
                    )));
                }
                tracker.apply_start_result(Ok(result));
            }
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "initializing update tracking failed; retrying off the relay loop");
                let (tx, rx) = mpsc::channel();
                match std::thread::Builder::new()
                    .name("wsmp-update-start".into())
                    .spawn(move || {
                        let result = retry_start(|| initialization.attempt(), std::thread::sleep);
                        let _ = tx.send(result);
                    }) {
                    Ok(_) => tracker.tracking = Tracking::Initializing(rx),
                    Err(error) => tracker.apply_start_result(Err(error.into())),
                }
            }
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
            Tracking::Initializing(_)
            | Tracking::InitializationFailed
            | Tracking::AwaitingConfirm(_)
            | Tracking::Confirming { .. }
            | Tracking::Restarting => {
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
        let shared = Arc::new(Shared::new(trust, frame.force));
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
                    worker.shared.force();
                }
                return Vec::new();
            }
            Tracking::Initializing(_)
            | Tracking::InitializationFailed
            | Tracking::AwaitingConfirm(_)
            | Tracking::Confirming { .. }
            | Tracking::Restarting => {
                return Vec::new();
            }
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
            Tracking::Installing(worker) => worker.shared.holds_new_work(),
            Tracking::Idle
            | Tracking::Initializing(_)
            | Tracking::InitializationFailed
            | Tracking::AwaitingConfirm(_)
            | Tracking::Confirming { .. } => false,
        }
    }

    /// The worker waits for the node to go idle: the relay loop reports idleness.
    pub fn wants_idle(&self) -> bool {
        self.worker()
            .is_some_and(|worker| worker.shared.wants_idle())
    }

    fn worker(&self) -> Option<&Worker> {
        match &self.tracking {
            Tracking::Installing(worker) => Some(worker),
            _ => None,
        }
    }

    pub fn set_idle(&self, no_instances: bool, no_commands: bool) {
        if let Some(worker) = self.worker() {
            worker.shared.set_idle(no_instances, no_commands);
        }
    }

    pub fn on_hello_ok(&mut self, sync: DefinitionSync) {
        self.connection = Connection::Registered {
            synced: sync == DefinitionSync::None,
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
            worker.shared.lower();
        }
        if let Tracking::Initializing(rx) = &self.tracking {
            match rx.try_recv() {
                Ok(result) => self.apply_start_result(result),
                Err(mpsc::TryRecvError::Disconnected) => self.apply_start_result(Err(
                    anyhow::anyhow!("the update initialization thread ended without a result"),
                )),
                Err(mpsc::TryRecvError::Empty) => {}
            }
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
        let confirmed = self.poll_confirm();
        if !confirmed
            && matches!(self.tracking, Tracking::AwaitingConfirm(_))
            && matches!(self.connection, Connection::Registered { synced: true, .. })
            && self.started.elapsed() >= CONFIRM_ALIVE
            && self.confirm_retry.ready(Instant::now())
        {
            self.confirm_now();
        }
        let frames = match self.connection {
            Connection::Registered { .. } => std::mem::take(&mut self.outbox),
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

    fn apply_start_result(&mut self, result: Result<OnStart>) {
        self.tracking = match result {
            Ok(OnStart::AwaitConfirm(state)) => {
                tracing::info!(
                    update_id = state.update_id,
                    attempt = state.attempts,
                    "this build is an update that has not confirmed yet"
                );
                self.current_id = Some(state.update_id.clone());
                Tracking::AwaitingConfirm(Box::new(state))
            }
            Ok(OnStart::RolledBackSelf) => Tracking::Restarting,
            Ok(OnStart::Report(state)) => {
                tracing::info!(update_id = state.update_id, phase = ?state.phase(), "an update ended; reporting it");
                // hello.ok may have arrived before the retry worker finished.
                if matches!(self.connection, Connection::Registered { .. }) {
                    self.outbox.push(report_frame(&state));
                }
                Tracking::Idle
            }
            Ok(OnStart::Nothing) => Tracking::Idle,
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "update tracking initialization failed; leaving confirmation disabled");
                Tracking::InitializationFailed
            }
        };
    }

    /// Apply a completed confirmation without waiting for its worker.
    fn poll_confirm(&mut self) -> bool {
        let result = match &self.tracking {
            Tracking::Confirming { rx, .. } => rx.try_recv(),
            _ => return false,
        };
        if matches!(result, Err(mpsc::TryRecvError::Empty)) {
            return false;
        }
        let Tracking::Confirming { awaiting, .. } =
            std::mem::replace(&mut self.tracking, Tracking::Idle)
        else {
            return false;
        };
        match result {
            Ok(result) => self.apply_confirm_result(awaiting, result),
            Err(_) => {
                self.retry_confirm(
                    awaiting,
                    anyhow::anyhow!("the update confirmation thread ended without a result"),
                );
            }
        }
        true
    }

    /// Start confirmation once the session is healthy and the retry backoff has elapsed.
    fn confirm_now(&mut self) {
        if !self.confirm_retry.ready(Instant::now()) {
            return;
        }
        let awaiting = match std::mem::replace(&mut self.tracking, Tracking::Idle) {
            Tracking::AwaitingConfirm(awaiting) => awaiting,
            other => {
                self.tracking = other;
                return;
            }
        };
        let update_dir = match super::update_dir() {
            Ok(dir) => dir,
            Err(error) => {
                self.retry_confirm(awaiting, error);
                return;
            }
        };
        match spawn_confirm(
            update_dir,
            awaiting.update_id.clone(),
            super::deadman::platform,
        ) {
            Ok(rx) => self.tracking = Tracking::Confirming { awaiting, rx },
            Err(error) => {
                self.retry_confirm(awaiting, error.into());
            }
        }
    }

    /// Until confirmed (or found rolled back, or not ours), await it again after an error.
    fn apply_confirm_result(&mut self, awaiting: Box<UpdateState>, result: Result<flow::Confirm>) {
        if result.is_ok() {
            self.confirm_retry = ConfirmRetry::default();
        }
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
                self.retry_confirm(awaiting, error);
            }
        }
    }

    /// One warning per failed attempt; polling during the backoff neither logs nor spawns.
    fn retry_confirm(&mut self, awaiting: Box<UpdateState>, error: anyhow::Error) {
        let delay = self.confirm_retry.failed(Instant::now());
        tracing::warn!(
            error = %format!("{error:#}"),
            retry_after_secs = delay.as_secs(),
            "confirming the update failed; retrying after backoff"
        );
        self.tracking = Tracking::AwaitingConfirm(awaiting);
    }

    /// The server stored how `update_id` ended (`agent.update.ack`): it is not
    /// reported again.
    pub fn acked(&self, update_id: &str) {
        if let Ok(dir) = super::update_dir() {
            let _ = mark_acked(&dir, update_id);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Acked {
    NotOurs,
    Busy,
    Marked,
}

fn mark_acked(update_dir: &Path, update_id: &str) -> Result<Acked> {
    // Atomic replacement makes this lock-free read a consistent snapshot.
    match state::load(update_dir)? {
        Some(current) if current.update_id == update_id && current.needs_report() => {}
        _ => return Ok(Acked::NotOurs),
    }
    let Some(_lock) = state::UpdateLock::acquire(update_dir)? else {
        tracing::debug!(
            update_id,
            "the update lock is busy; the next hello.ok reports it again"
        );
        return Ok(Acked::Busy);
    };
    // The snapshot may have changed before we acquired the lock.
    if let Some(mut current) = state::load(update_dir)?
        && current.update_id == update_id
        && current.mark_reported()
    {
        state::save(update_dir, &current)?;
        tracing::info!(update_id, "the server stored how the update ended");
        return Ok(Acked::Marked);
    }
    Ok(Acked::NotOurs)
}

/// The factory constructs the scheduler on the worker, so platform schedulers
/// need not be Send. Tests inject a factory that never touches the real scheduler.
fn spawn_confirm(
    update_dir: PathBuf,
    update_id: String,
    scheduler: impl FnOnce() -> Option<Box<dyn super::deadman::Scheduler>> + Send + 'static,
) -> io::Result<Receiver<Result<flow::Confirm>>> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("wsmp-update-confirm".into())
        .spawn(move || {
            let scheduler = scheduler();
            let result =
                flow::confirm(&update_dir, scheduler.as_deref(), &update_id, |confirmed| {
                    let identity = super::build::identity();
                    Some(super::receipt::InstallReceipt {
                        method: identity.method,
                        version: super::build::version().to_string(),
                        commit: identity.commit,
                        target: Some(identity.target),
                        binary: Some(confirmed.live_path.clone()),
                        installed_at: Some(crate::services::file_ops::fmt::rfc3339_secs(
                            super::unix_now(),
                        )),
                    })
                });
            let _ = tx.send(result);
        })?;
    Ok(rx)
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
            stable_service: crate::host::service::files::ensure_stable_executable,
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
        && !shared.wait_idle(&mut sink, IDLE_WAIT_MAX, &stopped)
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
        shared.hold_new_work();
        let left = IDLE_WAIT_MAX.saturating_sub(waited_from.elapsed());
        if shared.wait_idle(progress, left, &stopped) {
            return Ok(());
        }
        shared.release_new_work();
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

#[cfg(test)]
mod tests;
