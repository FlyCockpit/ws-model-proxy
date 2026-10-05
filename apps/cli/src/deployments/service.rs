//! Session-bound bounded work queue. Model units themselves are never children
//! of the relay process and are never stopped by session Drop.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};

use super::{Deadline, Executor, Job, JobResult, NativeRuntime, Observed};

struct Admitted {
    job: Job,
    deadline: Deadline,
}

impl Admitted {
    fn new(job: Job) -> Self {
        let deadline = Deadline::new(Duration::from_millis(job.timeout_ms));
        Self { job, deadline }
    }
}

#[derive(Debug)]
pub struct Update {
    pub result: Option<JobResult>,
    pub instances: Vec<Observed>,
    pub published: Vec<Job>,
    pub endpoints: Vec<crate::config::EndpointConfig>,
}

pub struct Runner {
    jobs: SyncSender<Admitted>,
    updates: Receiver<Update>,
    cancel: Arc<AtomicBool>,
}

/// A full publication queue applies backpressure instead of losing a job's
/// result. Session cancellation interrupts the wait even while commit ACKs
/// are stalled. At most 32 queued updates plus this one producer are retained.
fn publish_update(tx: &SyncSender<Update>, cancel: &AtomicBool, mut update: Update) -> bool {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        match tx.try_send(update) {
            Ok(()) => return true,
            Err(mpsc::TrySendError::Full(pending)) => {
                update = pending;
                thread::sleep(Duration::from_millis(10));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
        }
    }
}

fn active_sender() -> &'static std::sync::Mutex<Option<SyncSender<Admitted>>> {
    static ACTIVE: std::sync::OnceLock<std::sync::Mutex<Option<SyncSender<Admitted>>>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(|| std::sync::Mutex::new(None))
}

pub fn submit(job: Job) -> Result<()> {
    let admitted = Admitted::new(job);
    active_sender()
        .lock()
        .map_err(|_| anyhow::anyhow!("deployment queue unavailable"))?
        .as_ref()
        .context("deployment worker unavailable")?
        .try_send(admitted)
        .context("deployment queue full")
}

impl Runner {
    pub fn start() -> Result<Self> {
        let (jobs, rx) = mpsc::sync_channel::<Admitted>(32);
        *active_sender()
            .lock()
            .map_err(|_| anyhow::anyhow!("deployment queue unavailable"))? = Some(jobs.clone());
        let (tx, updates) = mpsc::sync_channel::<Update>(32);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        thread::Builder::new()
            .name("wsmp-deployments".into())
            .spawn(move || {
                let runtime = NativeRuntime {
                    cancel: Some(worker_cancel.clone()),
                };
                let publish = |executor: &mut Executor, result, deadline: Deadline| {
                    let _ = executor.reconcile_until(&runtime, deadline);
                    let published = executor.published_jobs_until(&runtime, deadline);
                    // Native probes belong to reconnect initialization, not an
                    // action's total budget. Reuse already probed endpoints.
                    let previous = super::managed_endpoints();
                    let endpoints = published
                        .iter()
                        .map(|job| {
                            previous
                                .iter()
                                .find(|endpoint| endpoint.slug == job.endpoint_slug)
                                .cloned()
                                .unwrap_or_else(|| super::endpoint_for(job))
                        })
                        .collect();
                    publish_update(
                        &tx,
                        &worker_cancel,
                        Update {
                            result,
                            instances: executor.observations_until(&runtime, deadline),
                            published,
                            endpoints,
                        },
                    )
                };
                // This lock excludes other CLI processes and prior reconnect workers.
                // Each action reloads durable state after locking, never a pre-lock cache.
                let execute = |admitted: Option<Admitted>| -> Result<()> {
                    let deadline = admitted
                        .as_ref()
                        .map(|job| job.deadline)
                        .unwrap_or_else(|| Deadline::new(Duration::from_secs(30)));
                    if let Some(admitted) = &admitted {
                        admitted.deadline.remaining()?;
                    }
                    let path = super::state_path()?;
                    let _lock = state_lock(&path)?;
                    let mut executor = Executor::load(path)?;
                    let result = admitted.map(|Admitted { job, deadline }| {
                        if worker_cancel.load(Ordering::SeqCst) {
                            return JobResult::failure(&job, "session_disconnected");
                        }
                        let config = match crate::config::Config::load() {
                            Ok(config) => config,
                            Err(_) => return JobResult::failure(&job, "local_config_unavailable"),
                        };
                        if !super::activation_supported(
                            job.action,
                            super::mechanism_until(deadline, Some(&worker_cancel)),
                        ) {
                            return JobResult::failure(&job, "execution_mechanism_unavailable");
                        }
                        executor.execute_until(
                            job,
                            config.allow_deployments,
                            config.mcp_command_mode,
                            &runtime,
                            deadline,
                        )
                    });
                    if !worker_cancel.load(Ordering::SeqCst)
                        && !publish(&mut executor, result, deadline)
                    {
                        anyhow::bail!("deployment update queue unavailable");
                    }
                    Ok(())
                };
                if execute(None).is_err() {
                    let _ = publish_update(
                        &tx,
                        &worker_cancel,
                        Update {
                            result: None,
                            instances: Vec::new(),
                            published: Vec::new(),
                            endpoints: Vec::new(),
                        },
                    );
                }
                while !worker_cancel.load(Ordering::SeqCst) {
                    match rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(admitted) => {
                            let fallback = admitted.job.clone();
                            if execute(Some(admitted)).is_err() {
                                let _ = publish_update(
                                    &tx,
                                    &worker_cancel,
                                    Update {
                                        result: Some(JobResult::failure(
                                            &fallback,
                                            "state_unavailable",
                                        )),
                                        instances: Vec::new(),
                                        published: Vec::new(),
                                        endpoints: Vec::new(),
                                    },
                                );
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .context("starting deployment worker")?;
        Ok(Self {
            jobs,
            updates,
            cancel,
        })
    }

    pub fn submit(&self, job: Job) -> Result<()> {
        self.jobs
            .try_send(Admitted::new(job))
            .context("deployment queue is full")
    }

    pub fn try_update(&self) -> Option<Update> {
        self.updates.try_recv().ok()
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut active) = active_sender().lock() {
            *active = None;
        }
    }
}

pub(super) fn state_lock(path: &std::path::Path) -> Result<nix::fcntl::Flock<std::fs::File>> {
    use std::os::unix::fs::OpenOptionsExt;
    let parent = path.parent().context("deployment state parent missing")?;
    std::fs::create_dir_all(parent).context("creating deployment state directory")?;
    let metadata = std::fs::symlink_metadata(parent)?;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    anyhow::ensure!(
        metadata.is_dir() && metadata.uid() == nix::unistd::Uid::effective().as_raw(),
        "unsafe deployment state directory"
    );
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(parent.join("instances.lock"))
        .context("opening deployment state lock")?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file()
            && metadata.uid() == nix::unistd::Uid::effective().as_raw()
            && metadata.mode() & 0o077 == 0,
        "unsafe deployment state lock"
    );
    nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
        .map_err(|(_, error)| anyhow::anyhow!("deployment state busy: {error}"))
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    fn update() -> Update {
        Update {
            result: None,
            instances: Vec::new(),
            published: Vec::new(),
            endpoints: Vec::new(),
        }
    }
    #[test]
    fn full_update_queue_backpressures_and_cancellation_settles() {
        let (tx, rx) = mpsc::sync_channel(32);
        for _ in 0..32 {
            tx.try_send(update()).expect("fill");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let stopped = cancel.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = done_tx.send(publish_update(&tx, &stopped, update()));
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        cancel.store(true, Ordering::SeqCst);
        assert!(
            !done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("cancelled producer")
        );
        worker.join().expect("join");
        assert_eq!(rx.try_iter().count(), 32);
    }
    #[test]
    fn full_update_queue_retains_result_then_delivers_when_reader_resumes() {
        let (tx, rx) = mpsc::sync_channel(32);
        for _ in 0..32 {
            tx.try_send(update()).expect("fill");
        }
        let worker = thread::spawn(move || {
            let mut last = update();
            last.result = Some(JobResult {
                frame_type: "deployment.job.result".into(),
                step_id: "last".into(),
                instance_id: "fixture".into(),
                rank: 0,
                intent_hash: "a".repeat(64),
                owner_epoch: "epoch".into(),
                status: "succeeded".into(),
                stopped: false,
                error: None,
                terminal_id: None,
                exit_code: None,
            });
            publish_update(&tx, &AtomicBool::new(false), last)
        });
        thread::sleep(Duration::from_millis(50));
        rx.recv().expect("release slot");
        assert!(worker.join().expect("join"));
        let remaining = rx.try_iter().collect::<Vec<_>>();
        assert_eq!(remaining.len(), 32);
        assert_eq!(
            remaining
                .last()
                .and_then(|update| update.result.as_ref())
                .map(|result| result.step_id.as_str()),
            Some("last")
        );
    }
}
