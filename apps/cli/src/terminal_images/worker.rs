//! One daemon-lifetime worker owns every image file and the node-wide quota.
//! Relay code owns only cancellation flags, bounded channels, and reply receivers.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Arc;
#[cfg(unix)]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::{ImageChunk, ImageReply, TerminalImages};

const QUEUE_CAPACITY: usize = 16;
const NODE_MAX_BYTES: usize = 128 * 1024 * 1024;
const NODE_MAX_FILES: usize = 128;
const POLL_INTERVAL: Duration = Duration::from_millis(100);
// Leave transport margin below the browser's 15-second acknowledgement timer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const OFFER_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_PENDING: u8 = 0;
const REQUEST_OFFERED: u8 = 1;
const REQUEST_COMMITTING: u8 = 2;
const REQUEST_ACCEPTED: u8 = 3;
const REQUEST_CANCELLED: u8 = 4;

fn cancel_request(state: &AtomicU8) {
    // Keep cancellation conditional: a paste that is committing or accepted
    // must retain its files. Use CAS to support Rust 1.88 without fetch_update,
    // which newer toolchains deprecate in favor of try_update (Rust 1.95).
    let mut current = state.load(Ordering::Acquire);
    while matches!(current, REQUEST_PENDING | REQUEST_OFFERED) {
        match state.compare_exchange_weak(
            current,
            REQUEST_CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => break,
            Err(observed) => current = observed,
        }
    }
}

/// Owned by exactly one terminal. Jobs hold the flag, never this guard.
pub(crate) struct ImageSession {
    id: u64,
    alive: Arc<AtomicBool>,
    worker_running: Arc<AtomicBool>,
}

impl ImageSession {
    pub(crate) fn supported(&self) -> bool {
        self.worker_running.load(Ordering::Acquire)
    }
}

impl Drop for ImageSession {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
    }
}

pub(crate) struct ImagePending {
    id: [u8; 16],
    session: Arc<AtomicBool>,
    viewer: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
    receiver: Receiver<ImageReply>,
    deadline: Instant,
    offered: RefCell<Option<ImageReply>>,
}

impl ImagePending {
    pub(crate) fn is_current(&self, session: &ImageSession, viewer: &Arc<AtomicBool>) -> bool {
        Arc::ptr_eq(&self.session, &session.alive)
            && Arc::ptr_eq(&self.viewer, viewer)
            && self.session.load(Ordering::Acquire)
            && self.viewer.load(Ordering::Acquire)
    }

    pub(crate) fn poll(&self, now: Instant) -> Option<ImageReply> {
        let offered = self.offered.borrow().is_some();
        if now
            >= self.deadline
                + if offered {
                    OFFER_TIMEOUT
                } else {
                    Duration::ZERO
                }
        {
            return Some(ImageReply::rejected(&self.id, "timeout"));
        }
        if offered {
            return None;
        }
        match self.receiver.try_recv() {
            Ok(reply) => {
                if reply.error.is_some() {
                    return Some(reply);
                }
                if self
                    .state
                    .compare_exchange(
                        REQUEST_PENDING,
                        REQUEST_OFFERED,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
                {
                    *self.offered.borrow_mut() = Some(reply.clone());
                    Some(reply)
                } else {
                    Some(ImageReply::rejected(&self.id, "timeout"))
                }
            }
            Err(TryRecvError::Disconnected) => Some(ImageReply::rejected(&self.id, "unavailable")),
            Err(TryRecvError::Empty) => None,
        }
    }

    pub(crate) fn matches(&self, id: &[u8; 16]) -> bool {
        &self.id == id
    }

    pub(crate) fn accept_next(&self, chunk: &ImageChunk) -> bool {
        let offered = self.offered.borrow();
        offered.as_ref().is_some_and(|reply| {
            reply.path.is_none() && self.id == chunk.id && reply.received == chunk.offset
        }) && self
            .state
            .compare_exchange(
                REQUEST_OFFERED,
                REQUEST_ACCEPTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn begin_paste(&self, paste: &super::ImagePaste) -> bool {
        let offered = self.offered.borrow();
        let Some(path) = offered.as_ref().and_then(|reply| reply.path.as_deref()) else {
            return false;
        };
        let text = super::paste_text(path);
        let bracketed = format!("\x1b[200~{text}\x1b[201~");
        self.id == paste.id
            && (paste.data.as_slice() == text.as_bytes()
                || paste.data.as_slice() == bracketed.as_bytes())
            && self
                .state
                .compare_exchange(
                    REQUEST_OFFERED,
                    REQUEST_COMMITTING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
    }

    pub(crate) fn finish_paste(&self, queued: bool) {
        self.state.store(
            if queued {
                REQUEST_ACCEPTED
            } else {
                REQUEST_CANCELLED
            },
            Ordering::Release,
        );
    }
}

impl Drop for ImagePending {
    fn drop(&mut self) {
        cancel_request(&self.state);
    }
}

struct Job {
    session_id: u64,
    session: Arc<AtomicBool>,
    viewer_id: String,
    viewer: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
    deadline: Instant,
    chunk: ImageChunk,
    reply: SyncSender<ImageReply>,
}

impl Job {
    fn active(&self) -> bool {
        Instant::now() < self.deadline
            && self.session.load(Ordering::Acquire)
            && self.viewer.load(Ordering::Acquire)
            && self.state.load(Ordering::Acquire) != REQUEST_CANCELLED
    }
}

pub(crate) struct ImageWorker {
    sender: Option<SyncSender<Job>>,
    stop: Arc<AtomicBool>,
    #[cfg(unix)]
    running: Arc<AtomicBool>,
    #[cfg(unix)]
    next_session: AtomicU64,
    thread: Option<JoinHandle<()>>,
}

impl ImageWorker {
    pub(crate) fn new() -> Self {
        if cfg!(unix) {
            Self::start(run)
        } else {
            Self {
                sender: None,
                stop: Arc::new(AtomicBool::new(true)),
                #[cfg(unix)]
                running: Arc::new(AtomicBool::new(false)),
                #[cfg(unix)]
                next_session: AtomicU64::new(1),
                thread: None,
            }
        }
    }

    fn start(work: impl FnOnce(Receiver<Job>, Arc<AtomicBool>) + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(true));
        let worker_stop = Arc::clone(&stop);
        let worker_running = Arc::clone(&running);
        // The guard also reports a worker panic, so new sessions never
        // advertise a worker that has already stopped.
        struct Running(Arc<AtomicBool>);
        impl Drop for Running {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let spawned = thread::Builder::new()
            .name("terminal-images".into())
            .spawn(move || {
                let _running = Running(worker_running);
                work(receiver, worker_stop);
            });
        let (sender, thread) = match spawned {
            Ok(thread) => (Some(sender), Some(thread)),
            Err(error) => {
                running.store(false, Ordering::Release);
                tracing::warn!(%error, "could not start terminal image worker");
                (None, None)
            }
        };
        Self {
            sender,
            thread,
            stop,
            #[cfg(unix)]
            running,
            #[cfg(unix)]
            next_session: AtomicU64::new(1),
        }
    }

    #[cfg(unix)]
    pub(crate) fn session(&self) -> ImageSession {
        // NodeLink owns this worker across every registry/reconnect, so IDs
        // remain unique for as long as its filesystem store can refer to them.
        ImageSession {
            id: self.next_session.fetch_add(1, Ordering::Relaxed),
            alive: Arc::new(AtomicBool::new(true)),
            worker_running: Arc::clone(&self.running),
        }
    }

    pub(crate) fn submit(
        &self,
        session: &ImageSession,
        viewer_id: &str,
        viewer: &Arc<AtomicBool>,
        chunk: ImageChunk,
    ) -> Result<ImagePending, &'static str> {
        if !session.supported() {
            return Err("unavailable");
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        let pending = ImagePending {
            id: chunk.id,
            session: Arc::clone(&session.alive),
            viewer: Arc::clone(viewer),
            state: Arc::new(AtomicU8::new(REQUEST_PENDING)),
            receiver,
            deadline: Instant::now() + REQUEST_TIMEOUT,
            offered: RefCell::new(None),
        };
        let job = Job {
            session_id: session.id,
            session: Arc::clone(&session.alive),
            viewer_id: viewer_id.to_string(),
            viewer: Arc::clone(viewer),
            state: Arc::clone(&pending.state),
            chunk,
            reply,
            deadline: pending.deadline,
        };
        match self.sender.as_ref().ok_or("unavailable")?.try_send(job) {
            Ok(()) => Ok(pending),
            Err(TrySendError::Full(_)) => Err("overloaded"),
            Err(TrySendError::Disconnected(_)) => Err("unavailable"),
        }
    }
}

impl Drop for ImageWorker {
    fn drop(&mut self) {
        // Production keeps this owner in NodeLink across reconnects, so joining
        // only happens as the daemon unwinds, never on its active relay loop.
        self.stop.store(true, Ordering::Release);
        self.sender.take();
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::warn!("terminal image worker panicked");
        }
    }
}

struct SessionFiles {
    alive: Arc<AtomicBool>,
    viewers: BTreeMap<String, Arc<AtomicBool>>,
    files: TerminalImages,
    deliveries: Vec<Delivery>,
}

/// A queued acknowledgement is not yet accepted: its request can still time out.
struct Delivery {
    viewer_id: String,
    state: Arc<AtomicU8>,
    deadline: Instant,
    reply: ImageReply,
}

#[derive(Default)]
struct Store {
    sessions: BTreeMap<u64, SessionFiles>,
}

impl Store {
    fn expire(&mut self, now: Instant) {
        // All file and directory destructors run on this worker, too.
        self.sessions
            .retain(|_, session| session.alive.load(Ordering::Acquire));
        for session in self.sessions.values_mut() {
            session.deliveries.retain(|delivery| {
                if now >= delivery.deadline {
                    cancel_request(&delivery.state);
                }
                match delivery.state.load(Ordering::Acquire) {
                    REQUEST_PENDING | REQUEST_OFFERED | REQUEST_COMMITTING => true,
                    REQUEST_ACCEPTED => false,
                    _ => {
                        session
                            .files
                            .cancel_reply(&delivery.viewer_id, &delivery.reply);
                        false
                    }
                }
            });
            session.viewers.retain(|viewer_id, alive| {
                if alive.load(Ordering::Acquire) {
                    true
                } else {
                    session.files.detach(viewer_id);
                    false
                }
            });
            session.files.expire(now);
        }
        // Empty stores own no cancellation-sensitive resources: discard their
        // directory on this worker, then sleep until a new request arrives.
        self.sessions
            .retain(|_, session| session.files.file_count() > 0 || !session.deliveries.is_empty());
    }

    fn receive(&mut self, job: &mut Job) -> ImageReply {
        let session = self
            .sessions
            .entry(job.session_id)
            .or_insert_with(|| SessionFiles {
                alive: Arc::clone(&job.session),
                viewers: BTreeMap::new(),
                files: TerminalImages::default(),
                deliveries: Vec::new(),
            });
        if session
            .viewers
            .get(&job.viewer_id)
            .is_some_and(|old| !Arc::ptr_eq(old, &job.viewer))
        {
            session.files.detach(&job.viewer_id);
        }
        session
            .viewers
            .insert(job.viewer_id.clone(), Arc::clone(&job.viewer));
        if job.chunk.offset == 0 {
            session.files.detach(&job.viewer_id);
            let bytes: usize = self
                .sessions
                .values()
                .map(|session| session.files.reserved_bytes())
                .sum();
            let files: usize = self
                .sessions
                .values()
                .map(|session| session.files.file_count())
                .sum();
            if bytes + job.chunk.total as usize > NODE_MAX_BYTES || files >= NODE_MAX_FILES {
                return ImageReply::rejected(&job.chunk.id, "node_limit");
            }
        }
        let Some(session) = self.sessions.get_mut(&job.session_id) else {
            return ImageReply::rejected(&job.chunk.id, "unavailable");
        };
        // Move the bounded chunk into the filesystem owner, without allocating
        // another buffer for the image bytes.
        session.files.receive(
            &job.viewer_id,
            ImageChunk {
                id: job.chunk.id,
                total: job.chunk.total,
                offset: job.chunk.offset,
                format: job.chunk.format,
                data: std::mem::take(&mut job.chunk.data),
            },
        )
    }

    fn cancel_reply(&mut self, job: &Job, reply: &ImageReply) {
        if let Some(session) = self.sessions.get_mut(&job.session_id) {
            session.files.cancel_reply(&job.viewer_id, reply);
        }
    }

    fn track_delivery(&mut self, job: &Job, reply: ImageReply) {
        if let Some(session) = self.sessions.get_mut(&job.session_id) {
            session.deliveries.push(Delivery {
                viewer_id: job.viewer_id.clone(),
                state: Arc::clone(&job.state),
                deadline: job.deadline + OFFER_TIMEOUT,
                reply,
            });
        }
    }
}

fn run(receiver: Receiver<Job>, stop: Arc<AtomicBool>) {
    let mut store = Store::default();
    while !stop.load(Ordering::Acquire) {
        store.expire(Instant::now());
        let received = if store.sessions.is_empty() {
            receiver.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            receiver.recv_timeout(POLL_INTERVAL)
        };
        let mut job = match received {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => {
                store.expire(Instant::now());
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        // A session can close while recv_timeout waits. Reclaim it before
        // admitting a new upload so reconnects share the same live quota.
        store.expire(Instant::now());
        if stop.load(Ordering::Acquire) || !job.active() {
            store.cancel_reply(&job, &ImageReply::rejected(&job.chunk.id, "unavailable"));
            continue;
        }
        let reply = store.receive(&mut job);
        if stop.load(Ordering::Acquire) || !job.active() {
            store.cancel_reply(&job, &reply);
            continue;
        }
        let delivery = reply.error.is_none().then(|| reply.clone());
        match job.reply.try_send(reply) {
            Ok(()) => {
                if let Some(reply) = delivery {
                    store.track_delivery(&job, reply);
                }
            }
            Err(TrySendError::Disconnected(reply) | TrySendError::Full(reply)) => {
                store.cancel_reply(&job, &reply)
            }
        }
    }
    // Dropping Store removes all retained files before the thread joins.
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Release a paused test worker even if an assertion unwinds, so its
    /// shutdown join cannot wait forever for the test's gate.
    struct ReleaseOnDrop(SyncSender<()>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let _ = self.0.try_send(());
        }
    }

    fn chunk(total: u32) -> ImageChunk {
        ImageChunk {
            id: [1; 16],
            total,
            offset: 0,
            format: 0,
            data: b"\x89PNG\r\n\x1a\n".to_vec(),
        }
    }

    fn wait(pending: &ImagePending) -> ImageReply {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(reply) = pending.poll(Instant::now()) {
                return reply;
            }
            assert!(Instant::now() < deadline, "image worker did not settle");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn upload(
        worker: &ImageWorker,
        session: &ImageSession,
        viewer: &str,
        alive: &Arc<AtomicBool>,
        total: u32,
    ) -> ImageReply {
        let pending = worker
            .submit(session, viewer, alive, chunk(total))
            .expect("submit");
        let reply = wait(&pending);
        if let Some(path) = &reply.path {
            assert!(pending.begin_paste(&super::super::ImagePaste {
                id: [1; 16],
                data: super::super::paste_text(path).into_bytes()
            }));
            pending.finish_paste(true);
        } else if reply.error.is_none() {
            let mut next = chunk(total);
            next.offset = reply.received;
            assert!(pending.accept_next(&next));
        }
        reply
    }

    #[test]
    fn node_quota_counts_reservations_across_sessions_and_reclaims_closed_sessions() {
        let worker = ImageWorker::new();
        let viewer = Arc::new(AtomicBool::new(true));
        let mut sessions = (0..4).map(|_| worker.session()).collect::<Vec<_>>();
        for session in &sessions {
            for index in 0..4 {
                let reply = upload(
                    &worker,
                    session,
                    &index.to_string(),
                    &viewer,
                    super::super::MAX_BYTES as u32,
                );
                assert_eq!(reply.received, 8);
                assert!(reply.error.is_none());
            }
        }
        let next = worker.session();
        assert_eq!(
            upload(&worker, &next, "new", &viewer, 8).error.as_deref(),
            Some("node_limit")
        );
        // A relay reconnect retires its guards, but the worker and quota live on.
        sessions.pop();
        let reply = upload(&worker, &next, "new", &viewer, 8);
        assert!(reply.path.is_some());
        assert!(reply.error.is_none());
    }

    #[test]
    fn node_file_limit_also_bounds_many_small_images() {
        let worker = ImageWorker::new();
        let viewer = Arc::new(AtomicBool::new(true));
        let sessions = (0..4).map(|_| worker.session()).collect::<Vec<_>>();
        for session in &sessions {
            for _ in 0..super::super::SESSION_MAX_FILES {
                assert!(
                    upload(&worker, session, "viewer", &viewer, 8)
                        .error
                        .is_none()
                );
            }
        }
        let extra = worker.session();
        assert_eq!(
            upload(&worker, &extra, "viewer", &viewer, 8)
                .error
                .as_deref(),
            Some("node_limit")
        );
    }

    #[test]
    fn worker_owns_completed_files_until_session_close_and_cleans_up_on_shutdown() {
        let worker = ImageWorker::new();
        let session = worker.session();
        let viewer = Arc::new(AtomicBool::new(true));
        let reply = upload(&worker, &session, "alice", &viewer, 8);
        let path = std::path::PathBuf::from(reply.path.expect("saved path"));
        let directory = path.parent().expect("directory").to_path_buf();
        viewer.store(false, Ordering::Release);
        let other = worker.session();
        let live = Arc::new(AtomicBool::new(true));
        let barrier = upload(&worker, &other, "barrier", &live, 8);
        assert!(barrier.error.is_none());
        assert!(path.exists(), "completed image survives viewer detach");
        drop(session);
        assert!(upload(&worker, &other, "barrier", &live, 8).error.is_none());
        assert!(!path.exists());
        assert!(!directory.exists());
        let last = std::path::PathBuf::from(barrier.path.expect("barrier path"));
        drop(worker);
        assert!(
            !last.exists(),
            "worker shutdown removes even a still-live session's files"
        );
    }

    #[test]
    fn saturated_queue_rejects_without_waiting_for_the_blocked_worker() {
        let (release_tx, paused) = mpsc::sync_channel(1);
        let worker = ImageWorker::start(move |receiver, stop| {
            let _ = paused.recv();
            run(receiver, stop);
        });
        let release = ReleaseOnDrop(release_tx);
        let session = worker.session();
        let viewer = Arc::new(AtomicBool::new(true));
        let pending = (0..QUEUE_CAPACITY)
            .map(|index| {
                worker
                    .submit(&session, &index.to_string(), &viewer, chunk(8))
                    .expect("queue slot")
            })
            .collect::<Vec<_>>();
        let rejected = worker.submit(&session, "overflow", &viewer, chunk(8));
        assert!(matches!(rejected, Err("overloaded")));
        drop(pending);
        release.0.send(()).expect("release worker");
    }

    #[test]
    fn cancelled_queued_work_never_publishes_a_path() {
        let (release_tx, paused) = mpsc::sync_channel(1);
        let worker = ImageWorker::start(move |receiver, stop| {
            let _ = paused.recv();
            run(receiver, stop);
        });
        let release = ReleaseOnDrop(release_tx);
        let session = worker.session();
        let viewer = Arc::new(AtomicBool::new(true));
        let pending = worker
            .submit(&session, "alice", &viewer, chunk(8))
            .expect("submit");
        viewer.store(false, Ordering::Release);
        release.0.send(()).expect("release worker");
        assert_eq!(wait(&pending).error.as_deref(), Some("unavailable"));
    }

    #[test]
    fn queued_request_times_out_without_waiting_for_disk_io() {
        let (release_tx, paused) = mpsc::sync_channel(1);
        let worker = ImageWorker::start(move |receiver, stop| {
            let _ = paused.recv();
            run(receiver, stop);
        });
        let _release = ReleaseOnDrop(release_tx);
        let session = worker.session();
        let viewer = Arc::new(AtomicBool::new(true));
        let pending = worker
            .submit(&session, "alice", &viewer, chunk(8))
            .expect("submit");
        let reply = pending
            .poll(Instant::now() + REQUEST_TIMEOUT)
            .expect("deadline reply");
        assert_eq!(reply.error.as_deref(), Some("timeout"));
        assert!(reply.path.is_none());
    }

    #[test]
    fn viewer_cancellation_deletes_an_acknowledged_partial_upload() {
        let mut store = Store::default();
        let session = Arc::new(AtomicBool::new(true));
        let viewer = Arc::new(AtomicBool::new(true));
        let (reply, _receiver) = mpsc::sync_channel(1);
        let mut job = Job {
            session_id: 1,
            session: Arc::clone(&session),
            viewer_id: "alice".into(),
            viewer: Arc::clone(&viewer),
            state: Arc::new(AtomicU8::new(REQUEST_PENDING)),
            deadline: Instant::now() + REQUEST_TIMEOUT,
            chunk: chunk(12),
            reply,
        };
        let reply = store.receive(&mut job);
        assert_eq!(reply.received, 8);
        assert!(reply.path.is_none());
        let path = store.sessions[&1].files.pending["alice"]
            .file
            .path()
            .to_path_buf();
        viewer.store(false, Ordering::Release);
        store.expire(Instant::now());
        assert!(!path.exists());
        assert!(
            store.sessions.is_empty(),
            "empty session releases its quota"
        );
    }

    #[test]
    fn a_cancelled_completion_never_deletes_an_earlier_pasted_image() {
        let mut store = Store::default();
        let (reply, _receiver) = mpsc::sync_channel(1);
        let mut job = Job {
            session_id: 1,
            session: Arc::new(AtomicBool::new(true)),
            viewer_id: "alice".into(),
            viewer: Arc::new(AtomicBool::new(true)),
            state: Arc::new(AtomicU8::new(REQUEST_PENDING)),
            deadline: Instant::now() + REQUEST_TIMEOUT,
            chunk: chunk(8),
            reply,
        };
        let first = store.receive(&mut job);
        let first_path = std::path::PathBuf::from(first.path.expect("first image"));
        job.chunk = chunk(8);
        let second = store.receive(&mut job);
        let second_path = std::path::PathBuf::from(second.path.as_ref().expect("second image"));
        job.state.store(REQUEST_CANCELLED, Ordering::Release);
        store.cancel_reply(&job, &second);
        assert!(first_path.exists());
        assert!(!second_path.exists());
        assert_eq!(store.sessions[&1].files.reserved_bytes(), 8);
    }

    #[test]
    fn completion_abandoned_before_relay_acceptance_is_deleted_by_the_worker() {
        let worker = ImageWorker::new();
        let session = worker.session();
        let viewer = Arc::new(AtomicBool::new(true));
        let pending = worker
            .submit(&session, "alice", &viewer, chunk(8))
            .expect("submit");
        // Inspect the queued result without claiming it through ImagePending::poll:
        // the request can be cancelled between the write and relay acceptance.
        let reply = pending
            .receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("write completed");
        let path = std::path::PathBuf::from(reply.path.expect("new file"));
        assert!(path.exists());
        drop(pending);
        let barrier = worker.session();
        assert!(
            upload(&worker, &barrier, "barrier", &viewer, 8)
                .error
                .is_none()
        );
        assert!(
            !path.exists(),
            "unaccepted completion was cleaned up off the relay loop"
        );
    }

    #[test]
    fn late_browser_reply_is_not_retained_until_session_end() {
        let worker = ImageWorker::new();
        let session = worker.session();
        let viewer = Arc::new(AtomicBool::new(true));
        let pending = worker
            .submit(&session, "alice", &viewer, chunk(8))
            .expect("submit");
        let reply = wait(&pending); // The relay forwarded the path, but the browser timed out.
        let path = std::path::PathBuf::from(reply.path.expect("offered path"));
        drop(pending); // Encrypted browser cancellation retires this request.
        let barrier = worker.session();
        assert!(
            upload(&worker, &barrier, "barrier", &viewer, 8)
                .error
                .is_none()
        );
        assert!(!path.exists());
    }

    #[test]
    fn an_idle_worker_stops_without_an_upload_waking_it() {
        let worker = ImageWorker::new();
        let running = Arc::clone(&worker.running);
        drop(worker);
        assert!(!running.load(Ordering::Acquire));
    }
}
