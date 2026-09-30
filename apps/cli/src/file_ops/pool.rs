//! A small worker pool so file operations never run on the synchronous relay
//! loop (a slow hash or search must not stall heartbeats). Two worker threads,
//! at most four operations in flight per CLI (plan section 3.3).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;

use super::error::{ErrorCode, FileError, FileResult};

pub const WORKERS: usize = 2;
pub const MAX_IN_FLIGHT: usize = 4;

type Job = Box<dyn FnOnce() + Send + 'static>;

thread_local! {
    static CONTAINED_PANIC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The process panic hook must not shut down unrelated telemetry for a file
/// job whose panic is caught and reported as io_error. The flag is private,
/// per-thread, and set only around the pool's catch boundary.
#[doc(hidden)]
pub fn worker_panic_is_contained() -> bool {
    CONTAINED_PANIC.get()
}

struct PanicBoundary(bool);

impl PanicBoundary {
    fn enter() -> Self {
        Self(CONTAINED_PANIC.replace(true))
    }
}

impl Drop for PanicBoundary {
    fn drop(&mut self) {
        CONTAINED_PANIC.set(self.0);
    }
}

pub struct FilePool {
    tx: Option<SyncSender<Job>>,
    in_flight: Arc<AtomicUsize>,
    handles: Vec<thread::JoinHandle<()>>,
}

struct InFlight(Arc<AtomicUsize>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl FilePool {
    pub fn new() -> Self {
        Self::with_capacity(WORKERS, MAX_IN_FLIGHT)
    }

    #[doc(hidden)]
    pub fn with_capacity(workers: usize, max_in_flight: usize) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Job>(max_in_flight);
        let rx = Arc::new(Mutex::new(rx));
        let handles = (0..workers)
            .map(|index| {
                let rx = Arc::clone(&rx);
                thread::Builder::new()
                    .name(format!("wsmp-file-{index}"))
                    .spawn(move || {
                        loop {
                            let job = match rx.lock() {
                                Ok(rx) => rx.recv(),
                                Err(_) => return,
                            };
                            match job {
                                Ok(job) => job(),
                                Err(_) => return,
                            }
                        }
                    })
                    .expect("spawn file worker")
            })
            .collect();
        Self {
            tx: Some(tx),
            in_flight: Arc::new(AtomicUsize::new(0)),
            handles,
        }
    }

    /// Queue `work`; the receiver yields its result. Refused with `limit` when
    /// `max_in_flight` operations are already queued or running.
    pub fn submit<T, F>(&self, work: F, max_in_flight: usize) -> FileResult<Receiver<FileResult<T>>>
    where
        T: Send + 'static,
        F: FnOnce() -> FileResult<T> + Send + 'static,
    {
        let limit_err = || FileError::new(ErrorCode::Limit, "too many file operations in flight");
        if self.in_flight.fetch_add(1, Ordering::SeqCst) >= max_in_flight {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return Err(limit_err());
        }
        let guard = InFlight(Arc::clone(&self.in_flight));
        let (result_tx, result_rx) = mpsc::channel();
        let job: Job = Box::new(move || {
            let _guard = guard;
            let _panic_boundary = PanicBoundary::enter();
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                .unwrap_or_else(|_| {
                    Err(FileError::new(
                        ErrorCode::IoError,
                        "file operation panicked",
                    ))
                });
            let _ = result_tx.send(outcome);
        });
        match self.tx.as_ref().map(|tx| tx.try_send(job)) {
            Some(Ok(())) => Ok(result_rx),
            _ => Err(limit_err()),
        }
    }
}

impl Default for FilePool {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for FilePool {
    fn drop(&mut self) {
        self.tx.take();
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}
