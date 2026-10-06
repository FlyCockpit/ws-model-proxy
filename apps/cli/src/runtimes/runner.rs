//! Runs admitted jobs off the relay loop: one thread per job, at most one
//! job per instance rank at a time (in-process mutex plus a file lock), many
//! instances side by side. A stop for a rank cancels that rank's running
//! step first. Model units are never children of the relay: dropping the
//! runner only cancels the steps in flight.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};

use super::executor::{Deadline, Executor, Job, NativeRuntime, Outcome};
use crate::protocol::frames::{InstanceRecord, JobError, NodeFrame};

/// Steps running at once.
const RUNNING_MAX: usize = 32;
const INSTANCES_DIR: &str = "runtime-instances";

/// What a finished step (or an observation pass) reports.
#[derive(Debug)]
pub struct Update {
    pub result: Option<NodeFrame>,
    /// Every instance rank this node knows, verified against the machine.
    pub instances: Vec<(Job, InstanceRecord)>,
}

pub fn result_frame(job: &Job, outcome: &Outcome) -> NodeFrame {
    NodeFrame::RuntimeJobResult {
        step_id: job.step_id.clone(),
        instance_id: job.instance_id.clone(),
        rank: job.rank,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        status: outcome.status,
        stopped: outcome.stopped,
        error: outcome.error,
        detail: None,
        terminal_id: None,
        exit_code: None,
    }
}

pub fn instances_dir() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(INSTANCES_DIR))
}

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

pub struct Runner {
    tx: SyncSender<Update>,
    updates: Receiver<Update>,
    running: Arc<Mutex<BTreeMap<String, Vec<Arc<AtomicBool>>>>>,
    keys: Arc<Mutex<BTreeMap<String, Arc<Mutex<()>>>>>,
    active: Arc<AtomicUsize>,
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
            dir,
        };
        runner.observe();
        Ok(runner)
    }

    /// A fresh observation of every instance (no step).
    pub fn observe(&self) {
        let tx = self.tx.clone();
        let dir = self.dir.clone();
        let _ = std::thread::Builder::new()
            .name("wsmp-instances".into())
            .spawn(move || {
                let instances = observe_all(&dir);
                let _ = tx.send(Update {
                    result: None,
                    instances,
                });
            });
    }

    pub fn try_update(&self) -> Option<Update> {
        self.updates.try_recv().ok()
    }

    /// Run `job` on its own thread. Refused (the caller answers
    /// `session_disconnected`, a pre-admission code) when too many run.
    pub fn submit(&self, job: Job) -> Result<()> {
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
            if job.action == crate::protocol::frames::JobPhase::Stop {
                // A stop wins over whatever this rank is still doing.
                for flag in flags.iter() {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            flags.push(Arc::clone(&cancel));
        }
        let key_lock = {
            let mut keys = self
                .keys
                .lock()
                .map_err(|_| anyhow::anyhow!("runner state poisoned"))?;
            Arc::clone(keys.entry(key.clone()).or_default())
        };
        let deadline = Deadline::new(Duration::from_millis(job.timeout_ms));
        let tx = self.tx.clone();
        let dir = self.dir.clone();
        let running = Arc::clone(&self.running);
        let active = Arc::clone(&self.active);
        active.fetch_add(1, Ordering::SeqCst);
        let spawned = std::thread::Builder::new()
            .name("wsmp-runtime-step".into())
            .spawn(move || {
                let outcome = {
                    let _held = key_lock.lock();
                    run_step(&dir, &key, job.clone(), &cancel, deadline)
                };
                if let Ok(mut running) = running.lock()
                    && let Some(flags) = running.get_mut(&key)
                {
                    flags.retain(|flag| !Arc::ptr_eq(flag, &cancel));
                    if flags.is_empty() {
                        running.remove(&key);
                    }
                }
                let instances = observe_all(&dir);
                let _ = tx.send(Update {
                    result: Some(result_frame(&job, &outcome)),
                    instances,
                });
                active.fetch_sub(1, Ordering::SeqCst);
            });
        if let Err(error) = spawned {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return Err(error).context("starting a runtime step");
        }
        Ok(())
    }
}

impl Drop for Runner {
    /// The connection ended: cancel steps in flight (units keep running).
    fn drop(&mut self) {
        if let Ok(running) = self.running.lock() {
            for flag in running.values().flatten() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
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
            "runtimes need a systemd user manager that outlives logins; run `loginctl enable-linger`"
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

#[cfg(unix)]
fn file_lock(dir: &Path, key: &str) -> Result<nix::fcntl::Flock<std::fs::File>> {
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
    nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusive)
        .map_err(|(_, error)| anyhow::anyhow!("locking instance state: {error}"))
}

/// Every instance record on disk, verified; expired stopped records go.
pub fn observe_all(dir: &Path) -> Vec<(Job, InstanceRecord)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let runtime = NativeRuntime { cancel: None };
    let mut out = Vec::new();
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    for path in paths {
        let Ok(executor) = Executor::load(path.clone()) else {
            continue;
        };
        let deadline = Deadline::new(Duration::from_secs(20));
        if executor.expired() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("lock"));
            continue;
        }
        out.extend(executor.observations(&runtime, deadline));
    }
    out
}
