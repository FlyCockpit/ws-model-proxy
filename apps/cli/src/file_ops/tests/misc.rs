//! Root refusal, JSON dispatch, the worker pool.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use serde_json::json;

use super::super::pool::FilePool;
use super::super::{ErrorCode, Policy};
use super::{Fx, args, code, real_uid};

#[test]
fn every_tool_refuses_as_root_unless_allowed() {
    let denied = Fx::with_policy(|_| Policy::new(vec![], vec![], false).with_euid(0));
    denied.put("f", "x\n");
    let ops = &denied.ops;
    let c = &denied.cancel;
    let p = denied.p("f");
    let results = [
        code(ops.read(&args(json!({ "path": p })), c)),
        code(ops.stat(&args(json!({ "paths": [p] })), c)),
        code(ops.dir_list(&args(json!({ "path": denied.p("") })), c)),
        code(ops.search(&args(json!({ "root": p, "pattern": "x" })), c)),
        code(ops.edit(
            &args(json!({ "path": p, "edits": [{ "oldText": "x", "newText": "y" }] })),
            c,
        )),
        code(ops.write(&args(json!({ "path": denied.p("new"), "content": "x" })), c)),
        code(ops.rename(&args(json!({ "from": p, "to": denied.p("g") })), c)),
        code(ops.dir_create(&args(json!({ "path": denied.p("d") })), c)),
        code(ops.delete(&args(json!({ "path": p })), c)),
    ];
    assert!(
        results.iter().all(|c| *c == ErrorCode::Unsupported),
        "{results:?}"
    );
    assert_eq!(denied.get("f"), "x\n");
    let dispatch = ops.execute("read", json!({ "path": p }), c).unwrap_err();
    assert_eq!(dispatch.code, ErrorCode::Unsupported);

    let allowed = Fx::with_policy(|_| Policy::new(vec![], vec![], true).with_euid(0));
    allowed.put("f", "x\n");
    assert!(
        allowed
            .ops
            .read(&args(json!({ "path": allowed.p("f") })), &allowed.cancel)
            .is_ok()
    );
    let plain_user =
        Fx::with_policy(|_| Policy::new(vec![], vec![], false).with_euid(real_uid().max(1)));
    plain_user.put("f", "x\n");
    assert!(
        plain_user
            .ops
            .read(
                &args(json!({ "path": plain_user.p("f") })),
                &plain_user.cancel
            )
            .is_ok()
    );
}

#[test]
fn execute_round_trips_json_and_rejects_unknown_ops_and_fields() {
    let fx = Fx::new();
    fx.put("f.txt", "a\nb\n");
    let read = fx
        .ops
        .execute("read", json!({ "path": fx.p("f.txt") }), &fx.cancel)
        .unwrap();
    assert_eq!(read["text"], "1|a\n2|b");
    assert_eq!(read["totalLines"], 2);
    assert_eq!(read["more"], serde_json::Value::Null);
    assert_eq!(read["secretFile"], false);
    let etag = read["etag"].clone();
    let edit = fx
        .ops
        .execute("edit", json!({ "path": fx.p("f.txt"), "expectedEtag": etag, "edits": [{ "startLine": 2, "endLine": 2, "newText": "B\n" }], "confirm": "RUN" }), &fx.cancel);
    assert_eq!(
        edit.unwrap_err().code,
        ErrorCode::InvalidInput,
        "confirm belongs to the MCP layer, not the CLI args"
    );
    let edit = fx
        .ops
        .execute("edit", json!({ "path": fx.p("f.txt"), "expectedEtag": etag, "edits": [{ "startLine": 2, "endLine": 2, "newText": "B\n" }], "reason": "test" }), &fx.cancel)
        .unwrap();
    assert_eq!(edit["applied"], true);
    assert_eq!(edit["previousEtag"], etag);
    assert!(edit.get("hunks").is_none());
    let write = fx
        .ops
        .execute(
            "write",
            json!({ "path": fx.p("new.txt"), "content": "x" }),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(write["created"], true);
    let mkdir = fx
        .ops
        .execute("mkdir", json!({ "path": fx.p("dd") }), &fx.cancel)
        .unwrap();
    assert_eq!(mkdir, json!({ "created": true }));
    let del = fx
        .ops
        .execute("delete", json!({ "path": fx.p("new.txt") }), &fx.cancel)
        .unwrap();
    assert_eq!(del, json!({ "deleted": true, "type": "file" }));
    for (op, bad) in [
        ("read", json!({ "path": fx.p("f.txt"), "extra": 1 })),
        ("read", json!({ "startLine": 1 })),
        ("read", json!({ "path": 5 })),
        ("stat", json!({ "paths": "x" })),
        ("nope", json!({})),
        (
            "edit",
            json!({ "path": fx.p("f.txt"), "edits": [{ "oldText": "a", "newText": "b", "bogus": true }] }),
        ),
    ] {
        assert_eq!(
            fx.ops
                .execute(op, bad.clone(), &fx.cancel)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput,
            "{op} {bad}"
        );
    }
    // error detail survives serialization for the wire layer
    let err = fx
        .ops
        .execute(
            "edit",
            json!({ "path": fx.p("f.txt"), "edits": [{ "oldText": "zzz", "newText": "b" }] }),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(serde_json::to_value(err.code).unwrap(), "no_match");
}

#[test]
fn pool_runs_work_off_thread_and_enforces_the_in_flight_limit() {
    let pool = FilePool::with_capacity(2, 4);
    let gate = Arc::new(Barrier::new(3));
    let started = Arc::new(AtomicUsize::new(0));
    let mut receivers = Vec::new();
    for _ in 0..2 {
        let (gate, started) = (Arc::clone(&gate), Arc::clone(&started));
        receivers.push(
            pool.submit(
                move || {
                    started.fetch_add(1, Ordering::SeqCst);
                    gate.wait();
                    Ok(1)
                },
                4,
            )
            .unwrap(),
        );
    }
    // two more fit (queued behind the two running workers), the fifth is refused
    for _ in 0..2 {
        receivers.push(pool.submit(|| Ok(1), 4).unwrap());
    }
    let refused = pool.submit(|| Ok(1), 4).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Limit);
    // the caller was not blocked by the workers
    let deadline = Instant::now() + Duration::from_secs(5);
    while started.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(started.load(Ordering::SeqCst), 2);
    gate.wait();
    for rx in receivers {
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap(), 1);
    }
    // capacity frees up again
    assert_eq!(
        pool.submit(|| Ok(7), 4)
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap(),
        7
    );
}

#[test]
fn pool_turns_panics_into_errors_and_keeps_serving() {
    let pool = FilePool::with_capacity(1, 4);
    let rx = pool.submit::<u8, _>(|| panic!("boom"), 4).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::IoError
    );
    assert_eq!(
        pool.submit(|| Ok(2), 4)
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap(),
        2
    );
}

#[test]
fn path_locks_serialize_same_path_only_and_time_out_or_cancel() {
    use super::super::{Cancel, Limits};
    let fx = Fx::new();
    let ops = Arc::new(fx.ops.with_limits(Limits {
        lock_wait: Duration::from_millis(300),
        ..Limits::default()
    }));
    let cancel = Cancel::new();
    let first = ops.lock_path("/x/a".into(), &cancel).unwrap();
    // a different path is not blocked
    let other = ops.lock_path("/x/b".into(), &cancel).unwrap();
    drop(other);
    // the same path waits, then times out
    let started = Instant::now();
    let err = ops
        .lock_path("/x/a".into(), &cancel)
        .err()
        .expect("must time out");
    assert_eq!(err.code, ErrorCode::Timeout);
    assert!(started.elapsed() >= Duration::from_millis(250));
    // a cancel interrupts the wait
    let waiter_cancel = Cancel::new();
    let handle = {
        let (ops, c) = (Arc::clone(&ops), waiter_cancel.clone());
        std::thread::spawn(move || ops.lock_path("/x/a".into(), &c).err().map(|e| e.code))
    };
    std::thread::sleep(Duration::from_millis(50));
    waiter_cancel.cancel();
    assert_eq!(handle.join().unwrap(), Some(ErrorCode::Cancelled));
    // releasing the lock lets the next holder in promptly
    let waiter = {
        let ops = Arc::clone(&ops);
        std::thread::spawn(move || ops.lock_path("/x/a".into(), &Cancel::new()).is_ok())
    };
    std::thread::sleep(Duration::from_millis(50));
    drop(first);
    assert!(waiter.join().unwrap());
}

/// Deterministic discriminator for the in-flight limit: one worker holding one
/// job, `max_in_flight = 1`. The count is at its limit, so the next submit must
/// be refused even though nothing is queued behind it.
#[test]
fn one_held_job_is_the_whole_in_flight_budget() {
    let pool = FilePool::with_capacity(1, 1);
    let held = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let started = Arc::new(AtomicUsize::new(0));
    let (h, r, s) = (
        Arc::clone(&held),
        Arc::clone(&release),
        Arc::clone(&started),
    );
    let _first = pool
        .submit(
            move || {
                s.fetch_add(1, Ordering::SeqCst);
                h.wait();
                r.wait();
                Ok(1)
            },
            1,
        )
        .unwrap();
    // the worker is now inside the job, so the single slot is taken
    held.wait();
    // A failure below must still release the worker: `FilePool::drop` joins the
    // threads, and a panic while the job holds the `release` barrier would hang.
    let started_count = started.load(Ordering::SeqCst);
    let refused = pool.submit(|| Ok(2), 1).map(|_| ()).map_err(|err| err.code);
    release.wait();
    assert_eq!(started_count, 1);
    assert_eq!(refused, Err(ErrorCode::Limit));
    // the slot is released once the job finishes
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match pool.submit(|| Ok(3), 1) {
            Ok(rx) => {
                assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap(), 3);
                break;
            }
            Err(err) => {
                assert_eq!(err.code, ErrorCode::Limit);
                assert!(Instant::now() < deadline, "the slot never freed");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
