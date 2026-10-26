//! Runs admitted jobs off the relay loop: one thread per job, at most one
//! job per instance rank at a time (in-process mutex plus a file lock), many
//! instances side by side. A stop for a rank cancels that rank's running
//! step first. Model units are never children of the relay: dropping the
//! runner only cancels the steps in flight.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::Duration;

use anyhow::{Context, Result};

use super::executor::{Deadline, Executor, Job, NativeRuntime, Outcome};
use super::operator::{OperatorEvent, OperatorIds, OperatorLink, OperatorOpen, OperatorScreen};
use crate::protocol::frames::{InstanceRecord, JobError, NodeFrame};

/// Steps running at once.
const RUNNING_MAX: usize = 32;

/// What a finished step (or an observation pass) reports.
#[derive(Debug)]
pub struct Update {
    /// Observations are ordered: an older one never replaces a newer one.
    pub generation: u64,
    pub result: Option<NodeFrame>,
    /// Every instance rank this node knows, verified against the machine.
    pub instances: Vec<(Job, InstanceRecord)>,
    /// An operator step asks the relay loop for its terminal (no result and
    /// no observation ride along).
    pub operator: Option<OperatorRequest>,
}

/// What an operator step's runner thread asks of the relay loop.
#[derive(Debug)]
pub enum OperatorRequest {
    /// Open the step's operator terminal (confirm stage).
    Open(Box<OperatorOpen>),
    /// The step was cancelled (a stop): close its terminal unless a person's
    /// run of the command is already under way.
    CloseIfConfirming { terminal_id: String },
}

/// What an operator job brings beside the rendered job.
#[derive(Clone, Debug)]
pub struct OperatorTicket {
    pub ids: OperatorIds,
    pub screen: OperatorScreen,
    /// The scrubbed terminal environment the command starts from.
    pub base_env: Vec<(String, String)>,
}

pub fn result_frame(job: &Job, outcome: &Outcome) -> NodeFrame {
    result_frame_for(job, outcome, None)
}

/// [`result_frame`] naming the operator terminal of the dispatch it answers.
pub fn result_frame_for(job: &Job, outcome: &Outcome, terminal_id: Option<&str>) -> NodeFrame {
    NodeFrame::RuntimeJobResult {
        step_id: job.step_id.clone(),
        instance_id: job.instance_id.clone(),
        rank: job.rank,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        status: outcome.status,
        stopped: outcome.stopped,
        error: outcome.error,
        detail: outcome.detail.clone(),
        terminal_id: terminal_id.map(str::to_string),
        exit_code: None,
        rank_idle: None,
    }
}

pub use super::executor::instances_dir;

/// `<instance>-r<rank>`, plain characters only.
fn key_name(job: &Job) -> Option<String> {
    let ok = !job.instance_id.is_empty()
        && job.instance_id.len() <= 128
        && job
            .instance_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then(|| format!("{}-r{}", job.instance_id, job.rank))
}

/// One step in flight on a rank: its cancel flag, its dispatch (step id and
/// operator terminal id), and whether it may launch (a start phase).
type InFlight = (Arc<AtomicBool>, String, bool);

/// The phases that may launch a process (the server's `RUN_START_PHASES`).
fn may_launch(phase: crate::protocol::frames::JobPhase) -> bool {
    use crate::protocol::frames::JobPhase;
    matches!(
        phase,
        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin | JobPhase::Readiness
    )
}

/// Takes a step off its rank's in-flight list (its cancel flag names it).
fn forget_step(
    running: &Mutex<BTreeMap<String, Vec<InFlight>>>,
    key: &str,
    cancel: &Arc<AtomicBool>,
) {
    let mut running = running.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(flags) = running.get_mut(key) {
        flags.retain(|(flag, _, _)| !Arc::ptr_eq(flag, cancel));
        if flags.is_empty() {
            running.remove(key);
        }
    }
}

/// Whether no step that may launch is in flight on rank `key` and not
/// cancelled (a cancelled one checks its flag before it runs anything), and no
/// launch guard of this node is still ending its session unwatched
/// ([`crate::launch_guard::lingering`]): a step forgotten while its cleanup
/// lingers could still launch, and that cleanup names no rank.
fn rank_idle(running: &Mutex<BTreeMap<String, Vec<InFlight>>>, key: &str) -> bool {
    rank_idle_given(running, key, crate::launch_guard::lingering())
}

fn rank_idle_given(
    running: &Mutex<BTreeMap<String, Vec<InFlight>>>,
    key: &str,
    lingering: bool,
) -> bool {
    if lingering {
        return false;
    }
    let running = running.lock().unwrap_or_else(PoisonError::into_inner);
    running.get(key).is_none_or(|flags| {
        flags
            .iter()
            .all(|(flag, _, launches)| !*launches || flag.load(Ordering::SeqCst))
    })
}

/// Runs `step` holding the rank (`held`), then takes the in-flight check
/// (`rank_idle`) before letting the rank go: a step that may launch runs only
/// holding the rank, so none ran between `step` and the check, and any
/// admitted after it was delivered after `step`'s dispatch (frames are
/// admitted in order). What `step` observed stopped is proven stopped only
/// when the check says idle.
fn holding_rank<T>(
    held: MutexGuard<'_, ()>,
    running: &Mutex<BTreeMap<String, Vec<InFlight>>>,
    key: &str,
    step: impl FnOnce() -> T,
) -> (T, bool) {
    let out = step();
    let idle = rank_idle(running, key);
    drop(held);
    (out, idle)
}

/// The rank's in-process lock (every step on the rank runs holding it).
fn rank_lock(keys: &Mutex<BTreeMap<String, Arc<Mutex<()>>>>, key: &str) -> Arc<Mutex<()>> {
    let mut keys = keys.lock().unwrap_or_else(PoisonError::into_inner);
    Arc::clone(keys.entry(key.to_string()).or_default())
}

/// Every instance record on disk, verified (expired stopped records go),
/// each marked with whether its rank was idle (`InstanceRecord::rank_idle`).
/// Each rank is observed holding its lock, and the in-flight check is taken
/// in the same hold: a step that may launch runs only holding it, so nothing
/// launched between the check and the observation. A rank a step holds is
/// not idle.
fn observe_all_idle(
    dir: &Path,
    keys: &Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    running: &Mutex<BTreeMap<String, Vec<InFlight>>>,
) -> Vec<(Job, InstanceRecord)> {
    let runtime = NativeRuntime { cancel: None };
    let mut out = Vec::new();
    for path in instance_paths(dir) {
        let Some(key) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let lock = rank_lock(keys, key);
        let held = match lock.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        };
        let (mut observed, idle) = match held {
            Some(held) => holding_rank(held, running, key, || observe_path(dir, &path, &runtime)),
            None => (observe_path(dir, &path, &runtime), false),
        };
        for (job, record) in &mut observed {
            record.rank_idle = key_name(job).map(|name| idle && name == key);
        }
        out.extend(observed);
    }
    out
}

pub struct Runner {
    tx: SyncSender<Update>,
    updates: Receiver<Update>,
    /// Per rank: each step in flight, its cancel flag and dispatch (step id
    /// and operator terminal id).
    running: Arc<Mutex<BTreeMap<String, Vec<InFlight>>>>,
    keys: Arc<Mutex<BTreeMap<String, Arc<Mutex<()>>>>>,
    active: Arc<AtomicUsize>,
    generation: Arc<std::sync::atomic::AtomicU64>,
    dir: PathBuf,
}

impl Runner {
    pub fn start() -> Result<Self> {
        let dir = instances_dir()?;
        let (tx, updates) = mpsc::sync_channel(64);
        let runner = Self {
            tx,
            updates,
            running: Arc::new(Mutex::new(BTreeMap::new())),
            keys: Arc::new(Mutex::new(BTreeMap::new())),
            active: Arc::new(AtomicUsize::new(0)),
            generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            dir,
        };
        runner.observe();
        Ok(runner)
    }

    /// A fresh observation of every instance (no step).
    pub fn observe(&self) {
        let tx = self.tx.clone();
        let dir = self.dir.clone();
        let generation = Arc::clone(&self.generation);
        let running = Arc::clone(&self.running);
        let keys = Arc::clone(&self.keys);
        let _ = std::thread::Builder::new()
            .name("wsmp-instances".into())
            .spawn(move || {
                let generation = generation.fetch_add(1, Ordering::SeqCst) + 1;
                let instances = observe_all_idle(&dir, &keys, &running);
                let _ = tx.send(Update {
                    generation,
                    result: None,
                    instances,
                    operator: None,
                });
            });
    }

    pub fn try_update(&self) -> Option<Update> {
        self.updates.try_recv().ok()
    }

    /// Run `job` on its own thread. Refused (the caller answers
    /// `session_disconnected`, a pre-admission code) when too many run.
    pub fn submit(&self, job: Job) -> Result<()> {
        self.spawn_step(job, None)
    }

    /// Run an interactive job: status first, then its operator terminal
    /// (see `super::operator`). Its results name the ticket's terminal.
    pub fn submit_operator(&self, job: Job, ticket: OperatorTicket) -> Result<()> {
        self.spawn_step(job, Some(ticket))
    }

    fn spawn_step(&self, job: Job, ticket: Option<OperatorTicket>) -> Result<()> {
        let key = key_name(&job).context("bad instance id")?;
        anyhow::ensure!(
            self.active.load(Ordering::SeqCst) < RUNNING_MAX,
            "too many runtime steps are running"
        );
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut running = self
                .running
                .lock()
                .map_err(|_| anyhow::anyhow!("runner state poisoned"))?;
            let flags = running.entry(key.clone()).or_default();
            let dispatch = format!(
                "{}:{}",
                job.step_id,
                ticket
                    .as_ref()
                    .map_or("", |ticket| ticket.ids.terminal_id.as_str())
            );
            let stop = job.action == crate::protocol::frames::JobPhase::Stop;
            if !admit_step(flags, dispatch, stop, may_launch(job.action), &cancel) {
                tracing::info!(step_id = job.step_id, "a runtime step is already in flight");
                return Ok(());
            }
        }
        let key_lock = rank_lock(&self.keys, &key);
        let keys = Arc::clone(&self.keys);
        let deadline = Deadline::new(Duration::from_millis(job.timeout_ms));
        let tx = self.tx.clone();
        let dir = self.dir.clone();
        let running = Arc::clone(&self.running);
        let active = Arc::clone(&self.active);
        let generation = Arc::clone(&self.generation);
        active.fetch_add(1, Ordering::SeqCst);
        // What a failed spawn rolls back (the thread takes the originals).
        let (admitted_key, admitted) = (key.clone(), Arc::clone(&cancel));
        let spawned = std::thread::Builder::new()
            .name("wsmp-runtime-step".into())
            .spawn(move || {
                let terminal_id = ticket.as_ref().map(|ticket| ticket.ids.terminal_id.clone());
                // Stops and operator steps wait for the rank as long as it
                // takes (a stop waits behind a person's run). Any other step
                // waits only within its own deadline: a rank whose step waits
                // on a person must not park every probe for it.
                let waits =
                    ticket.is_some() || job.action == crate::protocol::frames::JobPhase::Stop;
                let (outcome, idle) = match lock_rank(&key_lock, (!waits).then_some(deadline)) {
                    None => (Some(Outcome::failed(JobError::JobDeadline)), false),
                    Some(held) => holding_rank(held, &running, &key, || match ticket {
                        Some(ticket) => {
                            run_operator_step(&dir, &key, job.clone(), &ticket, &cancel, &tx)
                        }
                        None => Some(run_step(&dir, &key, job.clone(), &cancel, deadline)),
                    }),
                };
                forget_step(&running, &key, &cancel);
                let generation = generation.fetch_add(1, Ordering::SeqCst) + 1;
                let instances = observe_all_idle(&dir, &keys, &running);
                let _ = tx.send(Update {
                    generation,
                    result: outcome.map(|outcome| {
                        let mut frame = result_frame_for(&job, &outcome, terminal_id.as_deref());
                        if matches!(
                            job.action,
                            crate::protocol::frames::JobPhase::Stop
                                | crate::protocol::frames::JobPhase::Status
                        ) && let NodeFrame::RuntimeJobResult { rank_idle, .. } = &mut frame
                        {
                            *rank_idle = Some(idle);
                        }
                        frame
                    }),
                    instances,
                    operator: None,
                });
                active.fetch_sub(1, Ordering::SeqCst);
            });
        if let Err(error) = spawned {
            self.active.fetch_sub(1, Ordering::SeqCst);
            // Never admitted after all: off the rank's list, so a re-delivery runs and the rank
            // is idle again (`rank_idle`).
            forget_step(&self.running, &admitted_key, &admitted);
            return Err(error).context("starting a runtime step");
        }
        Ok(())
    }
}

/// Register a step on its rank's in-flight list. A re-delivery of a
/// dispatch already in flight (step id and operator terminal id; a stop
/// parked behind a person's run, say) is not run again: `false`. A stop
/// cancels whatever the rank is still doing, except a person's run of an
/// operator command: the stop waits for it on the rank's lock
/// (`super::operator::run_operator`).
fn admit_step(
    flags: &mut Vec<InFlight>,
    dispatch: String,
    stop: bool,
    launches: bool,
    cancel: &Arc<AtomicBool>,
) -> bool {
    if flags.iter().any(|(_, other, _)| *other == dispatch) {
        return false;
    }
    if stop {
        for (flag, _, _) in flags.iter() {
            flag.store(true, Ordering::SeqCst);
        }
    }
    flags.push((Arc::clone(cancel), dispatch, launches));
    true
}

/// How often a step waiting for its rank within a deadline tries again.
const RANK_LOCK_POLL: Duration = Duration::from_millis(100);

/// The rank's in-process lock: waited for without limit (`None`), or tried
/// until `deadline` passes (`None` back: the step gives up).
fn lock_rank(lock: &Mutex<()>, deadline: Option<Deadline>) -> Option<MutexGuard<'_, ()>> {
    let Some(deadline) = deadline else {
        return Some(lock.lock().unwrap_or_else(PoisonError::into_inner));
    };
    loop {
        match lock.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {}
        }
        let left = deadline
            .instant()
            .saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        std::thread::sleep(RANK_LOCK_POLL.min(left));
    }
}

/// How an operator step's runner thread reaches the relay loop: through the
/// runner's update channel.
struct RunnerLink<'a> {
    tx: &'a SyncSender<Update>,
    ticket: &'a OperatorTicket,
}

impl OperatorLink for RunnerLink<'_> {
    fn open(
        &self,
        job: &Job,
        events: SyncSender<OperatorEvent>,
    ) -> std::result::Result<(), JobError> {
        let extra = super::executor::command_env(job).map_err(|error| {
            tracing::warn!(error = %format!("{error:#}"), "an operator step cannot start");
            JobError::LocalConfigUnavailable
        })?;
        let open = OperatorOpen {
            ids: self.ticket.ids.clone(),
            screen: self.ticket.screen.clone(),
            env: super::operator::operator_env(&self.ticket.base_env, &extra),
            events,
        };
        self.tx
            .send(Update {
                generation: 0,
                result: None,
                instances: Vec::new(),
                operator: Some(OperatorRequest::Open(Box::new(open))),
            })
            .map_err(|_| JobError::SessionDisconnected)
    }

    fn close_if_confirming(&self) {
        let _ = self.tx.send(Update {
            generation: 0,
            result: None,
            instances: Vec::new(),
            operator: Some(OperatorRequest::CloseIfConfirming {
                terminal_id: self.ticket.ids.terminal_id.clone(),
            }),
        });
    }
}

/// An operator step under its rank's locks. `None`: the terminal ended
/// without success and `operator_closed` already went out.
fn run_operator_step(
    dir: &Path,
    key: &str,
    job: Job,
    ticket: &OperatorTicket,
    cancel: &Arc<AtomicBool>,
    tx: &SyncSender<Update>,
) -> Option<Outcome> {
    if cancel.load(Ordering::SeqCst) {
        return Some(Outcome::failed(JobError::SessionDisconnected));
    }
    let mechanism = super::executor::native::mechanism_until(
        Deadline::new(Duration::from_secs(10)),
        Some(cancel.as_ref()),
    );
    if !super::executor::native::activation_supported(job.action, mechanism) {
        tracing::warn!(
            mechanism,
            "{}",
            super::executor::native::USER_MANAGER_NEEDED
        );
        return Some(Outcome::failed(JobError::ExecutionMechanismUnavailable));
    }
    let _lock = match file_lock(dir, key) {
        Ok(lock) => lock,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "locking instance state failed");
            return Some(Outcome::failed(JobError::LocalConfigUnavailable));
        }
    };
    let mut executor = match Executor::load(dir.join(format!("{key}.json"))) {
        Ok(executor) => executor,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "reading instance state failed");
            return Some(Outcome::failed(JobError::LocalConfigUnavailable));
        }
    };
    let checking = NativeRuntime {
        cancel: Some(Arc::clone(cancel)),
    };
    // A person's accepted run is never cut off; neither is its proof.
    let verifying = NativeRuntime { cancel: None };
    let link = RunnerLink { tx, ticket };
    super::operator::run_operator(&mut executor, job, &checking, &verifying, &link, cancel)
}

/// The rendered job a rank last ran (its own record), for steps on an
/// instance whose version the server since dropped.
pub fn recorded_job(instance_id: &str, rank: u8) -> Option<Job> {
    let dir = instances_dir().ok()?;
    let ok = !instance_id.is_empty()
        && instance_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !ok {
        return None;
    }
    Executor::load(dir.join(format!("{instance_id}-r{rank}.json")))
        .ok()?
        .recorded_job(instance_id, rank)
}

fn run_step(
    dir: &Path,
    key: &str,
    job: Job,
    cancel: &Arc<AtomicBool>,
    deadline: Deadline,
) -> Outcome {
    if cancel.load(Ordering::SeqCst) {
        return Outcome::failed(JobError::SessionDisconnected);
    }
    let mechanism = super::executor::native::mechanism_until(
        deadline.cap(Duration::from_secs(10)),
        Some(cancel.as_ref()),
    );
    if !super::executor::native::activation_supported(job.action, mechanism) {
        tracing::warn!(
            mechanism,
            "{}",
            super::executor::native::USER_MANAGER_NEEDED
        );
        return Outcome::failed(JobError::ExecutionMechanismUnavailable);
    }
    let _lock = match file_lock(dir, key) {
        Ok(lock) => lock,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "locking instance state failed");
            return Outcome::failed(JobError::LocalConfigUnavailable);
        }
    };
    let mut executor = match Executor::load(dir.join(format!("{key}.json"))) {
        Ok(executor) => executor,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "reading instance state failed");
            return Outcome::failed(JobError::LocalConfigUnavailable);
        }
    };
    let runtime = NativeRuntime {
        cancel: Some(Arc::clone(cancel)),
    };
    executor.execute(job, &runtime, deadline)
}

/// Delete an expired record only under its lock, re-checked after locking
/// (a step may have started on it). The lock file stays.
fn remove_expired(dir: &Path, path: &Path) {
    let Some(key) = path.file_stem().and_then(|stem| stem.to_str()) else {
        return;
    };
    let Ok(_lock) = file_lock_now(dir, key) else {
        return;
    };
    if Executor::load(path.to_path_buf()).is_ok_and(|executor| executor.expired()) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(unix)]
fn file_lock(dir: &Path, key: &str) -> Result<nix::fcntl::Flock<std::fs::File>> {
    lock_with(dir, key, nix::fcntl::FlockArg::LockExclusive)
}

/// The lock when it is free right now; never waits.
#[cfg(unix)]
fn file_lock_now(dir: &Path, key: &str) -> Result<nix::fcntl::Flock<std::fs::File>> {
    lock_with(dir, key, nix::fcntl::FlockArg::LockExclusiveNonblock)
}

#[cfg(unix)]
fn lock_with(
    dir: &Path,
    key: &str,
    mode: nix::fcntl::FlockArg,
) -> Result<nix::fcntl::Flock<std::fs::File>> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    std::fs::create_dir_all(dir).context("creating the instance state directory")?;
    let metadata = std::fs::symlink_metadata(dir)?;
    anyhow::ensure!(
        metadata.is_dir() && metadata.uid() == nix::unistd::Uid::effective().as_raw(),
        "unsafe instance state directory"
    );
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(dir.join(format!("{key}.lock")))
        .context("opening the instance lock")?;
    nix::fcntl::Flock::lock(file, mode)
        .map_err(|(_, error)| anyhow::anyhow!("locking instance state: {error}"))
}

/// Windows has no `flock`: the lock file opened unshared is the lock (released when the handle
/// closes, the process's end included), retried until it is free.
#[cfg(windows)]
fn file_lock(dir: &Path, key: &str) -> Result<std::fs::File> {
    loop {
        match lock_now(dir, key)? {
            Some(file) => return Ok(file),
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// The lock when it is free right now; never waits.
#[cfg(windows)]
fn file_lock_now(dir: &Path, key: &str) -> Result<std::fs::File> {
    lock_now(dir, key)?.context("instance state is locked")
}

/// `None` while someone else holds it.
#[cfg(windows)]
fn lock_now(dir: &Path, key: &str) -> Result<Option<std::fs::File>> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::create_dir_all(dir).context("creating the instance state directory")?;
    anyhow::ensure!(
        std::fs::symlink_metadata(dir)?.is_dir(),
        "unsafe instance state directory"
    );
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(dir.join(format!("{key}.lock")))
    {
        Ok(file) => Ok(Some(file)),
        // ERROR_SHARING_VIOLATION
        Err(error) if error.raw_os_error() == Some(32) => Ok(None),
        Err(error) => Err(error).context("opening the instance lock"),
    }
}

/// The instance record files, in name order.
fn instance_paths(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
}

/// One record file's observations, verified; an expired stopped record goes.
fn observe_path(dir: &Path, path: &Path, runtime: &NativeRuntime) -> Vec<(Job, InstanceRecord)> {
    let Ok(executor) = Executor::load(path.to_path_buf()) else {
        return Vec::new();
    };
    if executor.expired() {
        remove_expired(dir, path);
        return Vec::new();
    }
    executor.observations(runtime, Deadline::new(Duration::from_secs(20)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_gives_up_on_a_rank_held_by_a_person_within_its_deadline() {
        let rank = Mutex::new(());
        let held = rank.lock().expect("a person's step holds the rank");
        let started = std::time::Instant::now();
        let deadline = Deadline::new(Duration::from_millis(300));
        assert!(lock_rank(&rank, Some(deadline)).is_none());
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(held);
        assert!(lock_rank(&rank, Some(Deadline::new(Duration::from_millis(300)))).is_some());
        // Stops and operator steps wait without a deadline.
        assert!(lock_rank(&rank, None).is_some());
    }

    #[test]
    fn a_rank_is_idle_only_without_a_step_that_may_launch_and_is_not_cancelled() {
        let _serial = crate::launch_guard::lingering_serial();
        let running = Mutex::new(BTreeMap::new());
        assert!(rank_idle(&running, "i-r0"), "nothing in flight");
        let start = Arc::new(AtomicBool::new(false));
        {
            let mut map = running.lock().expect("runner state");
            let flags: &mut Vec<InFlight> = map.entry("i-r0".to_string()).or_default();
            assert!(admit_step(flags, "s1:".into(), false, true, &start));
            // A status probe (it launches nothing) changes nothing.
            let probe = Arc::new(AtomicBool::new(false));
            assert!(admit_step(flags, "p1:".into(), false, false, &probe));
        }
        assert!(!rank_idle(&running, "i-r0"), "a start waits for the rank");
        assert!(rank_idle(&running, "i-r1"), "another rank");
        {
            let mut map = running.lock().expect("runner state");
            let flags = map.get_mut("i-r0").expect("in flight");
            let stop = Arc::new(AtomicBool::new(false));
            assert!(admit_step(flags, "s2:".into(), true, false, &stop));
        }
        assert!(rank_idle(&running, "i-r0"), "the stop cancelled the start");
    }

    #[test]
    fn no_rank_is_idle_while_a_launch_guard_lingers() {
        // A closed operator terminal whose guard still ends its session: its step is forgotten,
        // but what the guard has not ended yet may still launch.
        let running = Mutex::new(BTreeMap::new());
        assert!(rank_idle_given(&running, "i-r0", false));
        assert!(!rank_idle_given(&running, "i-r0", true));
        assert!(!rank_idle_given(&running, "other-r3", true));
    }

    #[test]
    fn a_proof_is_idle_only_if_no_start_waited_for_the_rank_during_it() {
        let _serial = crate::launch_guard::lingering_serial();
        // A start is admitted and waits for the rank while a status probe
        // holds it. Once the probe lets the rank go, the start runs (it may
        // launch) and leaves the list: the probe's answer must still say
        // not idle, whatever runs first afterwards.
        let running = Arc::new(Mutex::new(BTreeMap::new()));
        let rank = Arc::new(Mutex::new(()));
        let start = Arc::new(AtomicBool::new(false));
        {
            let mut map = running.lock().expect("runner state");
            let flags: &mut Vec<InFlight> = map.entry("i-r0".to_string()).or_default();
            assert!(admit_step(flags, "s1:".into(), false, true, &start));
        }
        let held = rank.lock().expect("the probe holds the rank");
        let starter = {
            let (running, rank, start) = (Arc::clone(&running), Arc::clone(&rank), start);
            std::thread::spawn(move || {
                let _running_start = rank.lock().expect("the start runs");
                forget_step(&running, "i-r0", &start);
            })
        };
        let ((), idle) = holding_rank(held, &running, "i-r0", || {
            // The probe's proof: the start has not run (it waits for the rank).
        });
        starter.join().expect("the start ran");
        assert!(!idle, "a start waited for the rank during the proof");
        let ((), idle) = holding_rank(rank.lock().expect("rank"), &running, "i-r0", || {});
        assert!(idle, "nothing in flight any more");
    }

    #[test]
    fn a_step_never_spawned_leaves_no_ghost_on_its_rank() {
        let _serial = crate::launch_guard::lingering_serial();
        let running = Mutex::new(BTreeMap::new());
        let start = Arc::new(AtomicBool::new(false));
        {
            let mut map = running.lock().expect("runner state");
            let flags: &mut Vec<InFlight> = map.entry("i-r0".to_string()).or_default();
            assert!(admit_step(flags, "s1:".into(), false, true, &start));
        }
        assert!(!rank_idle(&running, "i-r0"));
        // Its worker could not be started: rolled back.
        forget_step(&running, "i-r0", &start);
        assert!(rank_idle(&running, "i-r0"));
        // A re-delivery of the same dispatch is admitted again.
        let again = Arc::new(AtomicBool::new(false));
        let mut map = running.lock().expect("runner state");
        let flags: &mut Vec<InFlight> = map.entry("i-r0".to_string()).or_default();
        assert!(admit_step(flags, "s1:".into(), false, true, &again));
    }

    #[test]
    fn a_re_delivered_dispatch_in_flight_is_not_run_again() {
        let mut flags = Vec::new();
        let start = Arc::new(AtomicBool::new(false));
        assert!(admit_step(
            &mut flags,
            "s1:term-a".into(),
            false,
            true,
            &start
        ));
        let stop = Arc::new(AtomicBool::new(false));
        assert!(admit_step(&mut flags, "s2:".into(), true, false, &stop));
        assert!(
            start.load(Ordering::SeqCst),
            "the stop cancels the rank's step"
        );
        // The same stop again (parked behind a person's run): no second thread.
        let again = Arc::new(AtomicBool::new(false));
        assert!(!admit_step(&mut flags, "s2:".into(), true, false, &again));
        assert_eq!(flags.len(), 2);
        // A newer dispatch of a step (another terminal id) is its own.
        assert!(admit_step(
            &mut flags,
            "s1:term-b".into(),
            false,
            true,
            &again
        ));
        assert_eq!(flags.len(), 3);
    }
}
