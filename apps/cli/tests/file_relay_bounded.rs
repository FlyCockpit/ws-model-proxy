//! File ops run on the file pool, never on the relay loop.
//!
//! The daemon's loop reads the socket, sends heartbeats every 20 s and drains
//! worker output on a short poll. This test stands in for it: one thread
//! "heartbeats" every 25 ms while it feeds `file.op`s to a `FileRelay` whose
//! ops are made slow (a paused atomic replace, and a real hash of a large
//! file). Every `handle_op`/`handle_body` call must return immediately and the
//! ticks must keep their period; the slow ops finish afterwards through the
//! sink. Beyond the pool's 4 in-flight ops the relay answers `limit` at once.

#![cfg(unix)]

use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use wsmp::file_ops::{EtagKey, FileOps, Policy, Step};
use wsmp::file_relay::{FileFrame, FileRelay, FileRuntime, FileSink};

const TICK: Duration = Duration::from_millis(25);
/// A tick may run this late before the loop counts as stalled.
const MAX_LATE: Duration = Duration::from_millis(400);
const SLOW: Duration = Duration::from_millis(1500);

fn op_id(n: u8) -> String {
    URL_SAFE_NO_PAD.encode([n; 16])
}

fn control(frames: &[FileFrame]) -> Value {
    match frames.first() {
        Some(FileFrame::Control(message)) => serde_json::to_value(message).expect("json"),
        other => panic!("expected a control frame, got {other:?}"),
    }
}

/// Time one call made on the loop thread, then let the schedule run a little.
fn timed(
    spinner: &mut Loop,
    slowest: &mut Duration,
    call: &mut dyn FnMut() -> Vec<FileFrame>,
) -> Vec<FileFrame> {
    let started = Instant::now();
    let frames = call();
    *slowest = (*slowest).max(started.elapsed());
    spinner.run_for(Duration::from_millis(30));
    frames
}

/// Wait for the next settled op the way the loop does: keep ticking.
fn next_settled(
    spinner: &mut Loop,
    rx: &std::sync::mpsc::Receiver<(String, Vec<FileFrame>)>,
) -> (String, Vec<FileFrame>) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(settled) = rx.try_recv() {
            return settled;
        }
        assert!(Instant::now() < deadline, "the op never settled");
        spinner.run_for(Duration::from_millis(10));
    }
}

struct Loop {
    started: Instant,
    ticks: u32,
    worst_late: Duration,
    next: Instant,
}

impl Loop {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            started: now,
            ticks: 0,
            worst_late: Duration::ZERO,
            next: now + TICK,
        }
    }

    /// Run the heartbeat schedule for `span` on this (the "relay loop") thread.
    fn run_for(&mut self, span: Duration) {
        let until = Instant::now() + span;
        while Instant::now() < until {
            let now = Instant::now();
            if now >= self.next {
                self.worst_late = self.worst_late.max(now - self.next);
                self.ticks += 1;
                self.next += TICK;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

#[test]
fn slow_file_ops_never_stall_the_relay_loop() {
    let dir = tempfile::tempdir().expect("dir");
    let policy = Policy::from_environment(vec![std::env::temp_dir()], false);
    let slow_paths: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let hook_counter = Arc::clone(&slow_paths);
    let ops = FileOps::new(policy, EtagKey::random()).with_step_hook(Arc::new(move |step| {
        if step == Step::TempWritten {
            *hook_counter.lock().expect("counter") += 1;
            std::thread::sleep(SLOW);
        }
        Ok(())
    }));
    let runtime = Arc::new(FileRuntime::new(ops));
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let sink: FileSink = Arc::new(move |id, frames| {
        let _ = tx.lock().expect("tx").send((id, frames));
    });
    let mut relay = FileRelay::new(runtime, true, sink);

    // A large file to hash for real: `stat` with `hash` reads all of it.
    let big = dir.path().join("big.bin");
    std::fs::write(&big, vec![7_u8; 48 * 1024 * 1024]).expect("big file");
    // Four replace targets; learn their etags (fast reads) first.
    let mut targets = Vec::new();
    let mut etags = Vec::new();
    for n in 0..4_u8 {
        let path = dir.path().join(format!("t{n}.txt"));
        std::fs::write(&path, "old\n").expect("target");
        let frames = relay.handle_op(
            &op_id(20 + n),
            "read",
            json!({ "path": path.display().to_string() }),
            None,
        );
        assert!(frames.is_empty());
        let (id, frames) = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("read settles");
        assert!(relay.complete(&id));
        etags.push(
            control(&frames)["result"]["etag"]
                .as_str()
                .expect("etag")
                .to_string(),
        );
        targets.push(path);
    }

    let mut spinner = Loop::new();
    let mut slowest_call = Duration::ZERO;

    // Four slow replaces (each pauses 1.5 s in the pool) fill the pool.
    for (n, path) in targets.iter().enumerate() {
        let id = op_id(n as u8 + 1);
        let args = json!({
            "path": path.display().to_string(),
            "ifExists": "replace",
            "expectedEtag": etags[n],
        });
        let frames = timed(&mut spinner, &mut slowest_call, &mut || {
            relay.handle_op(&id, "write", args.clone(), Some(3))
        });
        assert!(frames.is_empty());
        let frames = timed(&mut spinner, &mut slowest_call, &mut || {
            relay.handle_body(&id, b"new".to_vec())
        });
        assert!(frames.is_empty());
    }
    // The pool is now full: a fifth op is refused with `limit`, immediately.
    let refused = timed(&mut spinner, &mut slowest_call, &mut || {
        relay.handle_op(
            &op_id(9),
            "stat",
            json!({ "paths": [big.display().to_string()], "hash": true }),
            None,
        )
    });
    assert_eq!(control(&refused)["reason"], "limit");

    // Let the loop keep its schedule while the slow ops run.
    spinner.run_for(Duration::from_millis(1800));
    let mut finished = 0;
    while finished < 4 {
        let (id, frames) = next_settled(&mut spinner, &rx);
        assert!(relay.complete(&id));
        assert_eq!(control(&frames)["result"]["created"], false, "{frames:?}");
        finished += 1;
    }
    // A real hash of a large file also runs off-loop.
    let frames = timed(&mut spinner, &mut slowest_call, &mut || {
        relay.handle_op(
            &op_id(10),
            "stat",
            json!({ "paths": [big.display().to_string()], "hash": true }),
            None,
        )
    });
    assert!(frames.is_empty());
    let (_, frames) = next_settled(&mut spinner, &rx);
    assert_eq!(control(&frames)["type"], "file.result");

    assert_eq!(*slow_paths.lock().expect("counter"), 4);
    assert!(
        slowest_call < Duration::from_millis(200),
        "handle_op blocked the loop for {slowest_call:?}"
    );
    assert!(
        spinner.worst_late < MAX_LATE,
        "the loop's ticks ran {:?} late",
        spinner.worst_late
    );
    let expected_ticks = (spinner.started.elapsed().as_millis() / TICK.as_millis()) as u32;
    assert!(
        spinner.ticks + 8 >= expected_ticks,
        "{} ticks of {expected_ticks}",
        spinner.ticks
    );
}
