//! Cases added by the stage-3 review: protected paths compared physically,
//! rename bound to the checked objects, multi-line quoted values in any file,
//! bounded work on adversarial input.

use std::io::Write;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use serde_json::json;

use super::*;
use crate::file_ops::policy::Deny;
use crate::file_ops::redact;

// ---- protected paths are compared in the resolver's (physical) namespace ----

#[test]
fn protected_entries_behind_a_symlinked_state_dir_are_protected_by_physical_name() {
    // WSMP_STATE_DIR reached through a symlink; the leaf does not exist yet.
    let fx = Fx::with_policy(|root| {
        std::fs::create_dir(root.join("real-state")).unwrap();
        std::os::unix::fs::symlink(root.join("real-state"), root.join("configured-state")).unwrap();
        Policy::new(
            vec![],
            vec![Protected {
                path: root.join("configured-state/device-auth.json"),
                subtree: false,
                deny: Deny::ReadWrite,
            }],
            true,
        )
    });
    // create a missing protected file through its physical parent
    let r = fx.ops.write(
        &args(json!({ "path": fx.p("real-state/device-auth.json"), "content": "x" })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::PathDenied);
    assert!(!fx.root.join("real-state/device-auth.json").exists());
    // and through the configured (symlink) name
    let r = fx.ops.write(
        &args(json!({ "path": fx.p("configured-state/device-auth.json"), "content": "x" })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::PathDenied);
    // the physical parent of a protected file cannot be moved or removed
    fx.put("real-state/other.txt", "keep");
    for op in ["delete", "rename"] {
        let r = fx.ops.execute(
            op,
            if op == "delete" {
                json!({ "path": fx.p("real-state") })
            } else {
                json!({ "from": fx.p("real-state"), "to": fx.p("moved") })
            },
            &fx.cancel,
        );
        assert_eq!(
            r.expect_err("protected parent").code,
            ErrorCode::PathDenied,
            "{op}"
        );
    }
    assert!(fx.root.join("real-state/other.txt").exists());
}

#[test]
fn an_unreadable_protected_identity_fails_closed() {
    use std::os::unix::fs::PermissionsExt;
    if real_uid() == 0 {
        return;
    }
    let fx = Fx::with_policy(Fx::protecting(&[(
        "locked/device-auth.json",
        Deny::ReadWrite,
    )]));
    fx.put("locked/device-auth.json", "{}");
    fx.put("plain.txt", "hello\n");
    std::fs::set_permissions(
        fx.root.join("locked"),
        std::fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    // the protected file's inode cannot be examined: the check refuses instead of skipping
    let r = fx
        .ops
        .read(&args(json!({ "path": fx.p("plain.txt") })), &fx.cancel);
    std::fs::set_permissions(
        fx.root.join("locked"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert_eq!(code(r), ErrorCode::PathDenied);
}

// ---- rename is bound to the objects that were checked -----------------------

fn rename(fx: &Fx, value: serde_json::Value) -> FileResult<super::super::mutate::RenameResult> {
    fx.ops.rename(&args(value), &fx.cancel)
}

/// A hook that runs `act` once, at the last point before the rename commits.
fn once_before_commit(act: impl Fn() + Send + Sync + 'static) -> impl Fn(Step) -> FileResult<()> {
    let done = std::sync::atomic::AtomicBool::new(false);
    move |step| {
        if step == Step::EtagRechecked && !done.swap(true, std::sync::atomic::Ordering::SeqCst) {
            act();
        }
        Ok(())
    }
}

#[test]
fn rename_without_overwrite_never_replaces_a_destination_created_after_the_check() {
    let dst = Arc::new(std::sync::Mutex::new(std::path::PathBuf::new()));
    let seen = Arc::clone(&dst);
    let fx = Fx::new().with_hook(once_before_commit(move || {
        std::fs::write(&*seen.lock().unwrap(), "theirs").unwrap();
    }));
    *dst.lock().unwrap() = fx.root.join("dst.txt");
    fx.put("src.txt", "mine");
    let r = rename(
        &fx,
        json!({ "from": fx.p("src.txt"), "to": fx.p("dst.txt") }),
    );
    assert_eq!(code(r), ErrorCode::Exists);
    assert_eq!(fx.get("dst.txt"), "theirs");
    assert_eq!(fx.get("src.txt"), "mine");
}

// Linux and macOS use atomic exchange to preserve an unchecked destination.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn rename_overwrite_never_replaces_a_destination_swapped_after_the_etag_check() {
    let root = Arc::new(std::sync::Mutex::new(std::path::PathBuf::new()));
    let seen = Arc::clone(&root);
    let fx = Fx::new().with_hook(once_before_commit(move || {
        let root = seen.lock().unwrap();
        // a successor object at the destination name (new inode)
        std::fs::write(root.join("successor.tmp"), "successor").unwrap();
        std::fs::rename(root.join("successor.tmp"), root.join("dst.txt")).unwrap();
    }));
    *root.lock().unwrap() = fx.root.clone();
    fx.put("src.txt", "mine");
    fx.put("dst.txt", "old");
    let etag = fx.etag("dst.txt");
    let r = rename(
        &fx,
        json!({ "from": fx.p("src.txt"), "to": fx.p("dst.txt"), "overwrite": true, "expectedEtag": etag }),
    );
    assert_eq!(code(r), ErrorCode::Conflict);
    assert_eq!(
        fx.get("dst.txt"),
        "successor",
        "the unchecked successor survives"
    );
    assert_eq!(
        fx.get("src.txt"),
        "mine",
        "the source is back under its name"
    );
}

#[test]
fn rename_moves_back_a_source_that_was_swapped_after_the_check() {
    let root = Arc::new(std::sync::Mutex::new(std::path::PathBuf::new()));
    let seen = Arc::clone(&root);
    let fx = Fx::new().with_hook(once_before_commit(move || {
        let root = seen.lock().unwrap();
        std::fs::write(root.join("replacement.tmp"), "replacement").unwrap();
        std::fs::rename(root.join("replacement.tmp"), root.join("src.txt")).unwrap();
    }));
    *root.lock().unwrap() = fx.root.clone();
    fx.put("src.txt", "checked");
    let r = rename(
        &fx,
        json!({ "from": fx.p("src.txt"), "to": fx.p("dst.txt") }),
    );
    assert_eq!(code(r), ErrorCode::Conflict);
    assert!(
        !fx.root.join("dst.txt").exists(),
        "the unchecked object was not left at the destination"
    );
    assert_eq!(fx.get("src.txt"), "replacement");
}

#[test]
fn rename_overwrite_still_replaces_the_checked_destination() {
    let fx = Fx::new();
    fx.put("src.txt", "mine");
    fx.put("dst.txt", "old");
    let etag = fx.etag("dst.txt");
    rename(
        &fx,
        json!({ "from": fx.p("src.txt"), "to": fx.p("dst.txt"), "overwrite": true, "expectedEtag": etag }),
    )
    .unwrap();
    assert_eq!(fx.get("dst.txt"), "mine");
    assert!(!fx.root.join("src.txt").exists());
    assert!(fx.leftovers("").is_empty());
}

// ---- multi-line quoted values are masked in ordinary files too --------------

#[test]
fn a_multi_line_quoted_value_in_a_plain_file_is_masked_in_every_window() {
    let fx = Fx::new();
    fx.put(
        "notes.txt",
        "intro\nX_TOKEN=\"first-secret\nsecond-secret\nthird-secret\" # note\n\nafter\n",
    );
    for start in 1..=5 {
        let r = fx.read_with(json!({ "path": fx.p("notes.txt"), "startLine": start }));
        for leaked in ["first-secret", "second-secret", "third-secret"] {
            assert!(!r.text.contains(leaked), "startLine {start}: {}", r.text);
        }
    }
    // a closing quote does not end masking (`# note` is part of the masked line);
    // the blank line does
    let r = fx.read_with(json!({ "path": fx.p("notes.txt"), "startLine": 4 }));
    assert!(
        !r.text.contains("# note") && r.text.contains("after"),
        "{}",
        r.text
    );
    // edits address the masked view, so the continuation cannot be probed either
    let probe = fx.ops.edit(
        &args(json!({ "path": fx.p("notes.txt"), "edits": [{ "oldText": "second-secret", "newText": "x" }] })),
        &fx.cancel,
    );
    assert_eq!(code(probe), ErrorCode::NoMatch);
}

#[test]
fn tokens_without_assignment_syntax_are_masked_by_read_search_and_edit() {
    let fx = Fx::new();
    fx.put(
        "cfg.txt",
        "prefix apiKey hunter2\nfollowing-value\nvisible\n",
    );
    let read = fx.read("cfg.txt").text;
    assert!(!read.contains("hunter2") && !read.contains("following-value"));
    assert!(read.contains("⟦redacted line⟧") && read.contains("visible"));
    let searched = fx
        .ops
        .search(
            &args(json!({ "root": fx.p(""), "pattern": "following-value" })),
            &fx.cancel,
        )
        .unwrap();
    assert!(searched.matches.is_empty());
    let probe = fx.ops.edit(
        &args(
            json!({ "path": fx.p("cfg.txt"), "edits": [{ "oldText": "hunter2", "newText": "x" }] }),
        ),
        &fx.cancel,
    );
    assert_eq!(code(probe), ErrorCode::NoMatch);
}

// ---- adversarial input stays bounded -----------------------------------------

#[test]
fn edit_that_would_exceed_the_size_cap_fails_before_materialising_replacements() {
    let fx = Fx::new();
    fx.put("a.txt", "a".repeat(50_000));
    let started = Instant::now();
    let r = fx.ops.edit(
        &args(json!({ "path": fx.p("a.txt"), "edits": [{
            "oldText": "a", "newText": "b".repeat(1024), "expectedMatches": "all" }],
            "dryRun": true })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::TooLarge);
    assert!(started.elapsed() < Duration::from_secs(5));
    // newText and match counts are capped up front
    let r = fx.ops.edit(
        &args(json!({ "path": fx.p("a.txt"), "edits": [{
            "oldText": "a", "newText": "b".repeat(1024 * 1024 + 1) }] })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::InvalidInput);
    fx.put("many.txt", "a".repeat(100_001));
    let r = fx.ops.edit(
        &args(json!({ "path": fx.p("many.txt"), "edits": [{
            "oldText": "a", "newText": "b", "expectedMatches": "all" }] })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::MatchCount);
}

#[test]
fn edit_planning_over_many_masked_spans_is_not_quadratic() {
    let fx = Fx::new();
    let mut body = String::new();
    for i in 0..30_000 {
        body.push_str(&format!("K{i}_KEY=value{i}\n"));
    }
    fx.put("big.conf", &body);
    let started = Instant::now();
    // every match is between two masked values, so none touches a span
    let r = fx.ops.edit(
        &args(json!({ "path": fx.p("big.conf"), "edits": [{
            "oldText": "\n", "newText": "\n", "expectedMatches": "all" }],
            "dryRun": true })),
        &fx.cancel,
    );
    r.expect("30k matches are within the cap");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_line_longer_than_16_mib_in_a_file_over_64_mib_is_refused_not_buffered() {
    let fx = Fx::new();
    let path = fx.root.join("sparse.txt");
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(&[b'a'; 9000]).unwrap();
    file.set_len(70 * 1024 * 1024).unwrap();
    drop(file);
    let r = fx
        .ops
        .read(&args(json!({ "path": fx.p("sparse.txt") })), &fx.cancel);
    assert_eq!(code(r), ErrorCode::TooLarge);
    let r = fx.ops.read(
        &args(json!({ "path": fx.p("sparse.txt"), "startLine": 2 })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::TooLarge);
}

#[test]
fn edits_to_one_path_queue_instead_of_failing_their_recheck() {
    let fx = Arc::new(Fx::new());
    let body: String = (1..=6).map(|i| format!("l{i}\n")).collect();
    fx.put("q.txt", body);
    let barrier = Arc::new(Barrier::new(6));
    let handles: Vec<_> = (1..=6)
        .map(|i| {
            let (fx, barrier) = (Arc::clone(&fx), Arc::clone(&barrier));
            std::thread::spawn(move || {
                barrier.wait();
                fx.ops.edit(
                    &args(json!({ "path": fx.p("q.txt"),
                        "edits": [{ "oldText": format!("l{i}\n"), "newText": format!("L{i}\n") }] })),
                    &fx.cancel,
                )
            })
        })
        .collect();
    for h in handles {
        h.join()
            .unwrap()
            .expect("a queued edit without expectedEtag applies to the newer content");
    }
    assert_eq!(fx.get("q.txt"), "L1\nL2\nL3\nL4\nL5\nL6\n");
}

// ---- masking context comes from a bounded lookback, lossy for bad UTF-8 -----

#[test]
fn context_lines_that_are_not_utf8_still_advance_the_masking_state() {
    let fx = Fx::new();
    fx.put(
        "latin1.txt",
        b"X_TOKEN=\"v\xe9 opens\nsecond-line-secret\"\nB=1\n",
    );
    let r = fx.read_with(json!({ "path": fx.p("latin1.txt"), "startLine": 2 }));
    assert!(!r.text.contains("second-line-secret"), "{}", r.text);
    fx.put("app.env", b"NOTE=\"v\xe9 opens\nsecond-env-secret\"\nB=1\n");
    let r = fx.read_with(json!({ "path": fx.p("app.env"), "startLine": 2 }));
    assert!(!r.text.contains("second-env-secret"), "{}", r.text);
    // an invalid line INSIDE the window of an env file is masked whole, not a binary error
    let r = fx.read_with(json!({ "path": fx.p("app.env"), "startLine": 1 }));
    assert!(
        r.text.starts_with("1|\u{27E6}redacted\u{27E7}"),
        "{}",
        r.text
    );
    let key = pem("RSA PRIVATE KEY", "MIIEsecretbase64\n");
    let (first, rest) = key.split_once('\n').unwrap();
    let mut bytes = b"# v\xe9 ".to_vec();
    bytes.extend_from_slice(first.as_bytes());
    bytes.push(b'\n');
    bytes.extend_from_slice(rest.as_bytes());
    fx.put("k.pem", bytes);
    let r = fx.read_with(json!({ "path": fx.p("k.pem"), "startLine": 2 }));
    assert!(!r.text.contains("MIIEsecretbase64"), "{}", r.text);
}

#[test]
fn a_window_inside_a_multi_line_value_is_masked_from_the_lookback() {
    let fx = Fx::new();
    let mut body = String::from("X_TOKEN=\"start\n");
    for i in 0..30_000 {
        body.push_str(&format!("secret-line-{i}\n"));
    }
    body.push_str("end\"\n\nvisible\n");
    fx.put("long.txt", &body);
    // the window starts ~400 KiB inside the value, well within the 1 MiB lookback
    let r = fx.read_with(json!({ "path": fx.p("long.txt"), "startLine": 29_000, "maxLines": 5 }));
    assert!(!r.text.contains("secret-line"), "{}", r.text);
    let r = fx.read_with(json!({ "path": fx.p("long.txt"), "startLine": 30_002 }));
    assert!(r.text.contains("visible"), "{}", r.text);
    assert!(
        !r.text.contains("secret-line") && !r.text.contains("end\""),
        "{}",
        r.text
    );
}

#[test]
fn the_tail_window_of_a_huge_file_sees_a_value_opened_in_the_lookback() {
    let fx = Fx::new();
    let path = fx.root.join("huge.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let block = "log line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20_000);
    for _ in 0..70 {
        file.write_all(block.as_bytes()).unwrap();
    }
    file.write_all(b"X_TOKEN=\"opening\n").unwrap();
    for i in 0..20 {
        writeln!(file, "tail-secret-{i}").unwrap();
    }
    file.write_all(b"end\"\n\nafter\n").unwrap();
    file.flush().unwrap();
    drop(file);
    assert!(std::fs::metadata(&path).unwrap().len() > 64 * 1024 * 1024);
    let r = fx.read_with(json!({ "path": fx.p("huge.log"), "startLine": -5 }));
    assert!(!r.text.contains("tail-secret"), "{}", r.text);
    assert!(r.text.contains("after"), "{}", r.text);
}

#[test]
fn rename_overwrite_refuses_a_different_object_kind() {
    let fx = Fx::new();
    fx.put("d/x", "x");
    fx.put("f.txt", "file");
    let etag = fx.etag("f.txt");
    let r = rename(
        &fx,
        json!({ "from": fx.p("d"), "to": fx.p("f.txt"), "overwrite": true, "expectedEtag": etag }),
    );
    assert_eq!(code(r), ErrorCode::Exists);
    assert_eq!(fx.get("f.txt"), "file");
    assert!(fx.root.join("d/x").exists());
}

// ---- cancellation reaches the large-file read loops ---------------------------

#[test]
fn a_cancelled_read_of_a_huge_file_stops_instead_of_scanning_it() {
    let fx = Arc::new(Fx::new());
    let path = fx.root.join("huge.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let block = "log line 0123456789012345678901234567890123456789\n".repeat(20_000);
    for _ in 0..70 {
        file.write_all(block.as_bytes()).unwrap();
    }
    file.flush().unwrap();
    drop(file);
    // already cancelled: refused up front, in the head path and the tail path
    fx.cancel.cancel();
    for start in [1_i64, -3, 1_000_000] {
        let r = fx.ops.read(
            &args(json!({ "path": fx.p("huge.log"), "startLine": start })),
            &fx.cancel,
        );
        assert_eq!(code(r), ErrorCode::Cancelled, "startLine {start}");
    }
    // cancelled while the prefix is being scanned: observed at the next check, long
    // before the 1.4 M lines are read
    let fx2 = Arc::new(Fx::new());
    std::fs::copy(&path, fx2.root.join("huge.log")).unwrap();
    let canceller = {
        let fx2 = Arc::clone(&fx2);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2));
            fx2.cancel.cancel();
        })
    };
    let started = Instant::now();
    let r = fx2.ops.read(
        &args(json!({ "path": fx2.p("huge.log"), "startLine": 1_400_000 })),
        &fx2.cancel,
    );
    canceller.join().unwrap();
    let elapsed = started.elapsed();
    match r {
        Err(err) => assert_eq!(err.code, ErrorCode::Cancelled, "{elapsed:?}"),
        // the scan finished before the flag was set on a very fast machine: not a failure
        Ok(_) => assert!(elapsed < Duration::from_millis(50), "{elapsed:?}"),
    }
}

#[test]
fn an_extreme_line_range_is_invalid_input_not_a_panic() {
    let fx = Fx::new();
    fx.put("a.txt", "one\ntwo\n");
    let etag = fx.etag("a.txt");
    for (start, end) in [
        (1_u64, u64::MAX),
        (u64::MAX, u64::MAX),
        (4, 2),
        (u64::MAX, 1),
    ] {
        let r = fx.ops.edit(
            &args(json!({ "path": fx.p("a.txt"), "expectedEtag": etag,
                "edits": [{ "startLine": start, "endLine": end, "newText": "x\n" }] })),
            &fx.cancel,
        );
        assert!(matches!(code(r), ErrorCode::InvalidInput), "{start}..{end}");
    }
    // the supported empty insertion range still works
    fx.ops
        .edit(
            &args(json!({ "path": fx.p("a.txt"), "expectedEtag": etag,
                "edits": [{ "startLine": 2, "endLine": 1, "newText": "x\n" }] })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(fx.get("a.txt"), "one\nx\ntwo\n");
}

// ---- the lookback keeps the line that straddles it ---------------------------

#[test]
fn a_previous_line_longer_than_the_lookback_still_gives_the_window_its_state() {
    let fx = Fx::new();
    let long = "x".repeat(redact::LOOKBACK_BYTES + 100_000);
    fx.put(
        "quote.txt",
        format!("{long}\nAPI_KEY=\"opening\nleaked-quote-secret\"\n\nafter\n"),
    );
    let r = fx.read_with(json!({ "path": fx.p("quote.txt"), "startLine": 3 }));
    assert!(!r.text.contains("leaked-quote-secret"), "{}", r.text);
    fx.put(
        "flag.txt",
        format!("{long}\nrun --token\nleaked-flag-secret\n"),
    );
    let r = fx.read_with(json!({ "path": fx.p("flag.txt"), "startLine": 3 }));
    assert!(!r.text.contains("leaked-flag-secret"), "{}", r.text);
    // the value is opened on the very line that straddles the lookback boundary
    let filler = "y\n".repeat(redact::LOOKBACK_BYTES / 2 - 8);
    fx.put(
        "straddle.txt",
        format!("API_KEY=\"opening {long}\nsecret-in-middle\n{filler}visible-a\nvisible-b\n"),
    );
    let r = fx.read_with(json!({ "path": fx.p("straddle.txt"), "startLine": 2, "maxLines": 1 }));
    assert!(!r.text.contains("secret-in-middle"), "{}", r.text);
}

fn write_huge_with_run(fx: &Fx, name: &str, blocks_before: usize, blocks_after: usize) -> u64 {
    let path = fx.root.join(name);
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let block = "log line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20_000);
    for _ in 0..blocks_before {
        file.write_all(block.as_bytes()).unwrap();
    }
    let opener_line = blocks_before as u64 * 20_000 + 1;
    file.write_all(b"X_TOKEN=\"opening\n").unwrap();
    // a run far longer than the 128 KiB a bare tail chunk would hold, inside the lookback
    for i in 0..12_000 {
        writeln!(file, "tail-secret-{i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").unwrap();
    }
    file.write_all(b"\nafter\n").unwrap();
    for _ in 0..blocks_after {
        file.write_all(block.as_bytes()).unwrap();
    }
    file.flush().unwrap();
    drop(file);
    assert!(std::fs::metadata(&path).unwrap().len() > 64 * 1024 * 1024);
    opener_line
}

#[test]
fn large_file_windows_see_a_value_opened_just_before_a_positive_or_tail_window() {
    let fx = Fx::new();
    // positive window inside the value, in a file over 64 MiB (opener ~59 MiB in)
    let opener_line = write_huge_with_run(&fx, "pos.log", 63, 8);
    let r = fx.read_with(
        json!({ "path": fx.p("pos.log"), "startLine": opener_line + 11_000, "maxLines": 3 }),
    );
    assert!(!r.text.contains("tail-secret"), "{}", r.text);
    // tail windows: one right after the run, one inside it (opener ~500 KiB before)
    write_huge_with_run(&fx, "tail.log", 70, 0);
    let r = fx.read_with(json!({ "path": fx.p("tail.log"), "startLine": -3 }));
    assert!(
        r.text.contains("after") && !r.text.contains("tail-secret"),
        "{}",
        r.text
    );
    let r = fx.read_with(json!({ "path": fx.p("tail.log"), "startLine": -5_000 }));
    assert!(!r.text.contains("tail-secret"), "{}", r.text);
}

// ---- an agent cannot build a masked run that a windowed read would miss -------

#[test]
fn edits_cannot_manufacture_a_masked_run_longer_than_the_read_lookback() {
    let fx = Fx::new();
    fx.put("cfg.sh", "echo start\nPASSWORD=hunter2-secret\necho end\n");
    let filler = "filler filler filler filler\n".repeat(700_000 / 28);
    // Step 1 adds an opener before the protected line: a run of ~700 KB is allowed.
    fx.ops
        .edit(
            &args(json!({ "path": fx.p("cfg.sh"), "edits": [{
                "oldText": "echo start\n", "newText": format!("echo start\nPASSWORD=\"\n{filler}") }] })),
            &fx.cancel,
        )
        .expect("a run inside the lookback is fine");
    // step 2: insert another 700 KB above the value line: the run would be longer than
    // the lookback, so a read starting at the value could not see the opener
    let etag = fx.etag("cfg.sh");
    let r = fx.ops.edit(
        &args(
            json!({ "path": fx.p("cfg.sh"), "expectedEtag": etag, "edits": [{
            "startLine": 4, "endLine": 3, "newText": filler }] }),
        ),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::RedactedSpan);
    let last = fx.read_with(json!({ "path": fx.p("cfg.sh"), "startLine": -2 }));
    assert!(!last.text.contains("hunter2-secret"), "{}", last.text);
}

// ---- Unicode spellings that a casefold volume resolves to the secret file -----

#[test]
fn folded_spellings_are_secret_class_for_reads_and_mutations() {
    let fx = Fx::new();
    let key = pem("PRIVATE KEY", "FAKEKEYBODY\n");
    fx.put("server.\u{212A}ey", &key);
    fx.put(".cache/huggingface/to\u{212A}en", "hf_fakeTokenValue123\n");
    for path in ["server.\u{212A}ey", ".cache/huggingface/to\u{212A}en"] {
        let r = fx.read_with(json!({ "path": fx.p(path) }));
        assert!(r.secret_file, "{path}");
        assert!(
            !r.text.contains("FAKEKEYBODY") && !r.text.contains("hf_fake"),
            "{}",
            r.text
        );
        let d = fx
            .ops
            .execute("delete", json!({ "path": fx.p(path) }), &fx.cancel);
        assert_eq!(d.expect_err("secret").code, ErrorCode::SecretFile, "{path}");
    }
    for (from, to) in [(".\u{DF}h", "x1"), (".\u{17F}sh", "x2")] {
        let r = fx.ops.execute(
            "rename",
            json!({ "from": fx.p(from), "to": fx.p(to) }),
            &fx.cancel,
        );
        assert_eq!(code(r), ErrorCode::SecretFile, "{from}");
    }
}

// ---- CRLF translation counts against the newText cap ---------------------------

#[test]
fn crlf_translation_cannot_push_new_text_past_its_cap() {
    let fx = Fx::new();
    fx.put("crlf.txt", "a\r\nb\r\n");
    let r = fx.ops.edit(
        &args(json!({ "path": fx.p("crlf.txt"), "edits": [{
            "oldText": "a", "newText": "\n".repeat(700_000) }] })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::InvalidInput);
}

#[test]
fn a_tail_read_after_a_line_longer_than_16_mib_is_refused_not_served_unmasked() {
    let fx = Fx::new();
    let path = fx.root.join("longline.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let chunk = vec![b'x'; 1 << 20];
    for _ in 0..70 {
        file.write_all(&chunk).unwrap();
    }
    file.write_all(b"\nK_TOKEN=\"opening\ntail-continued-secret\n\nafter\n")
        .unwrap();
    file.flush().unwrap();
    drop(file);
    let r = fx.ops.read(
        &args(json!({ "path": fx.p("longline.log"), "startLine": -3 })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::TooLarge);
}

#[test]
fn names_that_start_with_an_underscore_are_secret_names() {
    let fx = Fx::new();
    fx.put(
        "env.sh",
        "_DEPLOY_TOKEN=lead-secret\nexport __A_KEY=other-secret\n",
    );
    let r = fx.read("env.sh");
    assert!(
        !r.text.contains("lead-secret") && !r.text.contains("other-secret"),
        "{}",
        r.text
    );
}

// ---- one line-splitting rule for read, search and edit ------------------------

#[test]
fn stray_carriage_returns_do_not_make_read_and_the_edit_view_disagree() {
    let fx = Fx::new();
    for (name, text) in [
        (
            "cr2.yml",
            "      - --api-key\r\r\n      - SECRETXAGENT\r\r\n",
        ),
        ("cr1.yml", "      - --api-key\r\n      - SECRETXAGENT\r\n"),
        ("crlone.yml", "run --token \r\rSECRETXCR2\r\n"),
    ] {
        fx.put(name, text);
        for start in 1..=3 {
            let r = fx.read_with(json!({ "path": fx.p(name), "startLine": start }));
            assert!(
                !r.text.contains("SECRETX"),
                "{name} startLine {start}: {:?}",
                r.text
            );
        }
    }
    // an edit that appends stray CRs to the flag line cannot unmask the next line
    fx.put("deploy.yml", "      - --api-key\n      - SECRETXAGENT\n");
    let _ = fx.ops.edit(
        &args(json!({ "path": fx.p("deploy.yml"),
            "edits": [{ "oldText": "- --api-key", "newText": "- --api-key\r\r" }] })),
        &fx.cancel,
    );
    let r = fx.read_with(json!({ "path": fx.p("deploy.yml"), "startLine": 1 }));
    assert!(!r.text.contains("SECRETXAGENT"), "{:?}", r.text);
}

// ---- etags do not confirm a guess of a masked value ---------------------------

#[test]
fn the_same_bytes_in_another_file_do_not_share_an_etag() {
    let fx = Fx::new();
    fx.put("target.conf", "PORT=8080\nDB_PASSWORD=abc12\n");
    // the agent writes a candidate file with the guessed value
    let created = fx
        .ops
        .write(
            &args(
                json!({ "path": fx.p("guess.conf"), "content": "PORT=8080\nDB_PASSWORD=abc12\n" }),
            ),
            &fx.cancel,
        )
        .unwrap();
    assert_ne!(
        created.etag,
        fx.etag("target.conf"),
        "an etag must not confirm a guess"
    );
    // every etag that a tool returns for a file equals what a later read returns
    assert_eq!(created.etag, fx.etag("guess.conf"));
    let edited = fx
        .ops
        .edit(
            &args(json!({ "path": fx.p("guess.conf"), "edits": [{ "oldText": "PORT=8080", "newText": "PORT=9090" }] })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(edited.etag, fx.etag("guess.conf"));
    let etag = fx.etag("guess.conf");
    let moved = fx
        .ops
        .rename(
            &args(json!({ "from": fx.p("guess.conf"), "to": fx.p("moved.conf") })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(
        moved.etag.as_deref(),
        Some(etag.as_str()),
        "a rename keeps the object, so its etag"
    );
    assert_eq!(fx.etag("moved.conf"), etag);
    let hashed = fx
        .ops
        .stat(
            &args(json!({ "paths": [fx.p("moved.conf")], "hash": true })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(hashed.entries[0].etag.as_deref(), Some(etag.as_str()));
}

// ---- closure tests for the lookback on large files and the edit guard ---------

/// A file over 64 MiB whose secret run is opened at the END of a long line that
/// straddles the lookback boundary of the window. Returns (window start line).
fn write_straddle_file(
    fx: &Fx,
    name: &str,
    filler_blocks: usize,
    continuation_lines: usize,
    tail_filler_blocks: usize,
) -> u64 {
    let path = fx.root.join(name);
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let block = "log line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20_000);
    for _ in 0..filler_blocks {
        file.write_all(block.as_bytes()).unwrap();
    }
    let mut line = 20_000 * filler_blocks as u64;
    // a 300 KB line that ends in the opener of a value
    file.write_all("y".repeat(300_000).as_bytes()).unwrap();
    file.write_all(b" API_KEY=\"opening\n").unwrap();
    line += 1;
    // continuation lines of the value
    for i in 0..continuation_lines {
        writeln!(file, "continued-secret-{i:06}-xxxxxxxxxxxxxxxxxx").unwrap();
    }
    line += continuation_lines as u64;
    file.write_all(b"final-continued-secret\n\nvisible-end\n")
        .unwrap();
    for _ in 0..tail_filler_blocks {
        file.write_all(block.as_bytes()).unwrap();
    }
    file.flush().unwrap();
    drop(file);
    line + 1
}

#[test]
fn a_value_opened_on_the_line_that_straddles_the_lookback_masks_a_large_file_window() {
    let fx = Fx::new();
    // positive window: the boundary byte (1 MiB before the window) is inside the long line
    let window = write_straddle_file(&fx, "pos.log", 60, 19_500, 9);
    assert!(std::fs::metadata(fx.root.join("pos.log")).unwrap().len() > 64 * 1024 * 1024);
    let r = fx.read_with(json!({ "path": fx.p("pos.log"), "startLine": window, "maxLines": 1 }));
    assert!(!r.text.contains("final-continued-secret"), "{}", r.text);
    // tail window: the chunk boundary falls inside the long line
    write_straddle_file(&fx, "tail.log", 69, 24_000, 0);
    let r = fx.read_with(json!({ "path": fx.p("tail.log"), "startLine": -3 }));
    assert!(!r.text.contains("final-continued-secret"), "{}", r.text);
    assert!(r.text.contains("visible-end"), "{}", r.text);
}

#[test]
fn a_short_value_past_the_first_mebibyte_does_not_block_edits() {
    let fx = Fx::new();
    let mut body = "filler line of text\n".repeat(60_000);
    body.push_str("X_TOKEN=\"a\nb\"\n\nend\n");
    fx.put("big.txt", &body);
    fx.ops
        .edit(
            &args(json!({ "path": fx.p("big.txt"), "edits": [{ "oldText": "end", "newText": "fin" }] })),
            &fx.cancel,
        )
        .expect("the run is short: the edit applies");
    assert!(fx.get("big.txt").ends_with("\nfin\n"));
}

#[test]
fn a_secret_flag_with_a_line_continuation_only_hides_its_value() {
    let fx = Fx::new();
    fx.put(
        "start.sh",
        "#!/bin/sh\nexec llama-server \\\n  --api-key \"$KEY\" \\\n  --ctx-size 32768 \\\n  --port 8080\n",
    );
    let r = fx.read("start.sh");
    assert!(
        r.text.contains("--ctx-size 32768") && r.text.contains("--port 8080"),
        "{}",
        r.text
    );
    fx.ops
        .edit(
            &args(json!({ "path": fx.p("start.sh"),
                "edits": [{ "oldText": "--ctx-size 32768", "newText": "--ctx-size 65536" }] })),
            &fx.cancel,
        )
        .unwrap();
}

// ---- a directory cannot move under an in-flight change -------------------------

#[test]
fn renaming_a_parent_waits_for_an_in_flight_edit_below_it() {
    use std::sync::mpsc;
    let (reached_tx, reached_rx) = mpsc::channel::<()>();
    let (resume_tx, resume_rx) = mpsc::channel::<()>();
    let resume_rx = std::sync::Mutex::new(resume_rx);
    let reached_tx = std::sync::Mutex::new(reached_tx);
    let first = std::sync::atomic::AtomicBool::new(true);
    let fx = Arc::new(Fx::new().with_hook(move |step| {
        if step == Step::EtagRechecked && first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let _ = reached_tx.lock().unwrap().send(());
            let _ = resume_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(20));
        }
        Ok(())
    }));
    fx.put("d/f.txt", "one\n");
    let editor = {
        let fx = Arc::clone(&fx);
        std::thread::spawn(move || {
            fx.ops.edit(
                &args(json!({ "path": fx.p("d/f.txt"), "edits": [{ "oldText": "one", "newText": "A" }] })),
                &fx.cancel,
            )
        })
    };
    reached_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("edit A reached its final recheck");
    let renamer = {
        let fx = Arc::clone(&fx);
        std::thread::spawn(move || {
            fx.ops.rename(
                &args(json!({ "from": fx.p("d"), "to": fx.p("e") })),
                &fx.cancel,
            )
        })
    };
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !renamer.is_finished(),
        "the rename must wait for the edit in flight"
    );
    assert!(fx.root.join("d/f.txt").exists(), "nothing moved yet");
    resume_tx.send(()).unwrap();
    editor.join().unwrap().expect("edit A commits");
    renamer.join().unwrap().expect("the rename runs after it");
    assert_eq!(fx.get("e/f.txt"), "A\n");
}

// ---- cancellation reaches search and hashing -----------------------------------

#[test]
fn cancelled_single_file_search_and_stat_hash_stop() {
    let fx = Fx::new();
    fx.put("one.txt", "needle\n");
    fx.cancel.cancel();
    let r = fx.ops.search(
        &args(json!({ "root": fx.p("one.txt"), "pattern": "needle" })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::Cancelled);
    let r = fx.ops.stat(
        &args(json!({ "paths": [fx.p("one.txt")], "hash": true })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::Cancelled);
    // (the between-chunk check itself is pinned by
    // `read::cancel_tests::the_chunked_reader_observes_a_cancel_between_chunks`)
}

// ---- edits cannot arrange a layout that a restarted window masker misreads -----

#[test]
fn edits_cannot_arrange_a_layout_that_makes_a_window_show_a_masked_value() {
    let fx = Fx::new();
    fx.put(
        "cfg.yaml",
        "name: demo\nDEPLOY_KEY: |\n  line-one-of-key\n\n  hunter2-block-secret\ndone: yes\n",
    );
    let block = "  eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n".repeat(950_000 / 35);
    // an accepted edit that puts a quoted opener inside a preceding block ...
    let _ = fx.ops.edit(
        &args(json!({ "path": fx.p("cfg.yaml"), "edits": [{
            "oldText": "name: demo\n",
            "newText": format!("name: demo\nE_KEY: |\n{block}  Y_TOKEN=\"open\n  more\nend-of-e\n") }] })),
        &fx.cancel,
    );
    let etag = fx.etag("cfg.yaml");
    let gap = "gap gap gap gap gap gap gap\n".repeat(500_000 / 28);
    let _ = fx.ops.edit(
        &args(
            json!({ "path": fx.p("cfg.yaml"), "expectedEtag": etag, "edits": [{
            "oldText": "end-of-e\n", "newText": format!("end-of-e\n{gap}") }] }),
        ),
        &fx.cancel,
    );
    // ... whether or not the edits were accepted, no window may show the value
    let full = fx.read_with(json!({ "path": fx.p("cfg.yaml"), "startLine": -2 }));
    assert!(!full.text.contains("hunter2-block-secret"), "{}", full.text);
    let total = fx.read_with(json!({ "path": fx.p("cfg.yaml"), "startLine": 1, "maxLines": 1 }));
    let lines = total.total_lines.expect("in-memory read has a line count");
    for start in [
        lines.saturating_sub(3),
        lines.saturating_sub(2),
        lines.saturating_sub(1),
    ] {
        let r = fx.read_with(json!({ "path": fx.p("cfg.yaml"), "startLine": start.max(1) }));
        assert!(
            !r.text.contains("hunter2-block-secret"),
            "startLine {start}: {}",
            r.text
        );
    }
}

// ---- private keys are masked by content in any file ---------------------------

#[test]
fn a_private_key_in_an_ordinary_file_is_masked_for_read_search_and_diff() {
    let fx = Fx::new();
    let key = pem("OPENSSH PRIVATE KEY", &"KEYBODYLINE\n".repeat(300));
    fx.put("notes.txt", format!("intro line\n{key}outro line\n"));
    // every window, including one that starts in the middle of the block
    for start in [1_u64, 2, 100, 250, 301, 302, 303] {
        let r = fx.read_with(json!({ "path": fx.p("notes.txt"), "startLine": start }));
        assert!(
            !r.text.contains("KEYBODYLINE") && !r.text.contains("PRIVATE KEY"),
            "start {start}: {}",
            r.text.get(..200).unwrap_or(&r.text)
        );
    }
    let tail = fx.read_with(json!({ "path": fx.p("notes.txt"), "startLine": -2 }));
    assert!(tail.text.contains("outro line"), "{}", tail.text);
    // search sees only the masked view
    let hits = fx
        .ops
        .search(
            &args(json!({ "root": fx.p("notes.txt"), "pattern": "KEYBODYLINE" })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(hits.count, 0, "{}", hits.matches);
    let hits = fx
        .ops
        .search(
            &args(json!({ "root": fx.p("notes.txt"), "pattern": "outro" })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(hits.count, 1);
    // an edit whose range touches the block is refused; one elsewhere works and
    // its diff carries no key bytes
    let touch = fx.ops.edit(
        &args(json!({ "path": fx.p("notes.txt"), "edits": [{
            "oldText": "\u{27E6}redacted\u{27E7}", "newText": "x", "expectedMatches": "all" }] })),
        &fx.cancel,
    );
    assert_eq!(code(touch), ErrorCode::RedactedSpan);
    let ok = fx
        .ops
        .edit(
            &args(json!({ "path": fx.p("notes.txt"), "edits": [{ "oldText": "outro", "newText": "OUTRO" }] })),
            &fx.cancel,
        )
        .unwrap();
    assert!(!ok.diff.unwrap_or_default().contains("KEYBODYLINE"));
    assert!(
        fx.get("notes.txt").contains("KEYBODYLINE"),
        "the file itself is untouched"
    );
    // a public key stays visible
    fx.put("pub.txt", pem("PUBLIC KEY", "PUBLICBODY\n"));
    assert!(fx.read("pub.txt").text.contains("PUBLICBODY"));
}

// ---- bounded token lines protect source bytes through every read window -------

#[test]
fn token_lines_and_their_following_lines_are_protected_in_every_window() {
    let fx = Fx::new();
    for (name, token_line, value_line) in [
        (
            "deploy.yaml",
            "  - name: api_key",
            "    value: fixture-value",
        ),
        ("node.js", "const apiKey =", "  'fixture-value';"),
        ("notes.txt", "credential hf-token", "fixture-value"),
    ] {
        fx.put(
            name,
            format!("intro\n{token_line}\n{value_line}\nvisible\n"),
        );
        for start in [1, 2, 3, -2] {
            let read = fx.read_with(json!({ "path": fx.p(name), "startLine": start }));
            assert!(
                !read.text.contains("fixture-value"),
                "{name}: {}",
                read.text
            );
            assert!(read.text.contains("visible"), "{name}: {}", read.text);
        }
        for line in [2, 3] {
            let result = fx.ops.edit(
                &args(
                    json!({ "path": fx.p(name), "expectedEtag": fx.etag(name), "edits": [{
                    "startLine": line, "endLine": line, "newText": "replacement\n" }] }),
                ),
                &fx.cancel,
            );
            assert_eq!(code(result), ErrorCode::RedactedSpan, "{name}: {line}");
        }
        fx.ops
            .edit(
                &args(json!({ "path": fx.p(name), "edits": [{
                "oldText": "visible", "newText": "edited" }] })),
                &fx.cancel,
            )
            .unwrap();
        assert!(fx.get(name).ends_with("edited\n"));
    }
}

#[test]
fn a_delete_waits_for_an_in_flight_change_elsewhere_in_the_namespace() {
    use std::sync::mpsc;
    let (reached_tx, reached_rx) = mpsc::channel::<()>();
    let (resume_tx, resume_rx) = mpsc::channel::<()>();
    let resume_rx = std::sync::Mutex::new(resume_rx);
    let reached_tx = std::sync::Mutex::new(reached_tx);
    let first = std::sync::atomic::AtomicBool::new(true);
    let fx = Arc::new(Fx::new().with_hook(move |step| {
        if step == Step::EtagRechecked && first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let _ = reached_tx.lock().unwrap().send(());
            let _ = resume_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(20));
        }
        Ok(())
    }));
    fx.put("d/f.txt", "one\n");
    fx.put("d/other.txt", "gone soon\n");
    let editor = {
        let fx = Arc::clone(&fx);
        std::thread::spawn(move || {
            fx.ops.edit(
                &args(json!({ "path": fx.p("d/f.txt"), "edits": [{ "oldText": "one", "newText": "A" }] })),
                &fx.cancel,
            )
        })
    };
    reached_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("the edit reached its final recheck");
    // a DIFFERENT path: only the namespace guard (not the per-path lock) can hold it back
    let deleter = {
        let fx = Arc::clone(&fx);
        std::thread::spawn(move || {
            fx.ops
                .delete(&args(json!({ "path": fx.p("d/other.txt") })), &fx.cancel)
        })
    };
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !deleter.is_finished() && fx.root.join("d/other.txt").exists(),
        "the delete must wait for the edit in flight"
    );
    resume_tx.send(()).unwrap();
    editor.join().unwrap().expect("the edit commits");
    deleter.join().unwrap().expect("the delete runs after it");
    assert!(!fx.root.join("d/other.txt").exists());
}

#[test]
fn a_waiting_rename_holds_back_later_edits_so_it_cannot_starve() {
    use std::sync::mpsc;
    let (reached_tx, reached_rx) = mpsc::channel::<()>();
    let (resume_tx, resume_rx) = mpsc::channel::<()>();
    let resume_rx = std::sync::Mutex::new(resume_rx);
    let reached_tx = std::sync::Mutex::new(reached_tx);
    let first = std::sync::atomic::AtomicBool::new(true);
    let fx = Arc::new(Fx::new().with_hook(move |step| {
        if step == Step::EtagRechecked && first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let _ = reached_tx.lock().unwrap().send(());
            let _ = resume_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(20));
        }
        Ok(())
    }));
    fx.put("a/one.txt", "one\n");
    fx.put("b/two.txt", "two\n");
    fx.put("d/keep.txt", "k\n");
    let edit_a = {
        let fx = Arc::clone(&fx);
        std::thread::spawn(move || {
            fx.ops.edit(
                &args(json!({ "path": fx.p("a/one.txt"), "edits": [{ "oldText": "one", "newText": "1" }] })),
                &fx.cancel,
            )
        })
    };
    reached_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("edit A holds the shared guard");
    let renamer = {
        let fx = Arc::clone(&fx);
        std::thread::spawn(move || {
            fx.ops.rename(
                &args(json!({ "from": fx.p("d"), "to": fx.p("e") })),
                &fx.cancel,
            )
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    // a NEW edit queues behind the waiting rename instead of overtaking it
    let edit_b = {
        let fx = Arc::clone(&fx);
        std::thread::spawn(move || {
            fx.ops.edit(
                &args(json!({ "path": fx.p("b/two.txt"), "edits": [{ "oldText": "two", "newText": "2" }] })),
                &fx.cancel,
            )
        })
    };
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !edit_b.is_finished(),
        "a later edit must not overtake the waiting rename"
    );
    resume_tx.send(()).unwrap();
    edit_a.join().unwrap().expect("edit A commits");
    renamer.join().unwrap().expect("the rename runs next");
    edit_b
        .join()
        .unwrap()
        .expect("edit B runs after the rename");
    assert_eq!(fx.get("b/two.txt"), "2\n");
}

#[test]
fn a_tail_window_of_lines_that_mask_short_still_sees_its_context() {
    let fx = Fx::new();
    let path = fx.root.join("shrink.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let block = "log line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20_000);
    for _ in 0..68 {
        file.write_all(block.as_bytes()).unwrap();
    }
    // an open quote, three continuation lines, then secret assignments whose masked
    // form is tiny: the window's RAW size dwarfs its masked size
    file.write_all(b"DB_PASSWORD=\"open-quote-start\n").unwrap();
    for part in ["A", "B", "C"] {
        file.write_all(format!("LEAKED-CONTINUATION-{part}-{}\n", "x".repeat(3_000)).as_bytes())
            .unwrap();
    }
    for _ in 0..11 {
        file.write_all(format!("Z_TOKEN={}\n", "a".repeat(20_000)).as_bytes())
            .unwrap();
    }
    file.flush().unwrap();
    drop(file);
    assert!(std::fs::metadata(&path).unwrap().len() > 64 * 1024 * 1024);
    // the window starts at continuation line B: its opener is two lines above it
    let r =
        fx.read_with(json!({ "path": fx.p("shrink.log"), "startLine": -13, "maxBytes": 131_072 }));
    assert!(
        !r.text.contains("LEAKED-CONTINUATION"),
        "{}",
        r.text.get(..120).unwrap_or(&r.text)
    );
}

// ---- a tail read returns the lines it was asked for --------------------------------

#[test]
fn a_tail_read_returns_every_requested_line_even_when_they_mask_short() {
    let fx = Fx::new();
    let path = fx.root.join("wide.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let block = "log line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20_000);
    for _ in 0..68 {
        file.write_all(block.as_bytes()).unwrap();
    }
    for i in 0..12 {
        file.write_all(format!("W{i}_TOKEN={}\n", "a".repeat(110_000)).as_bytes())
            .unwrap();
    }
    file.flush().unwrap();
    drop(file);
    assert!(std::fs::metadata(&path).unwrap().len() > 64 * 1024 * 1024);
    let r = fx.read_with(json!({ "path": fx.p("wide.log"), "startLine": -12, "maxLines": 12 }));
    assert_eq!(r.text.lines().count(), 12, "{}", r.text);
    assert!(!r.text.contains("aaaa"), "{}", r.text);
    // more raw than the scan bound: refused, never a silent subset
    let r = fx.ops.read(
        &args(json!({ "path": fx.p("wide.log"), "startLine": -1_000_000, "maxLines": 2000 })),
        &fx.cancel,
    );
    if let Ok(ok) = r {
        // the file's whole tail fits the bound: fine, but then it must be complete
        match ok {
            crate::file_ops::read::ReadOutcome::Content(c) => assert!(c.text.lines().count() > 12),
            crate::file_ops::read::ReadOutcome::Unchanged { .. } => panic!("unexpected"),
        }
    }
}

// ---- the file tools' own staging files are not tool targets --------------------------

#[test]
fn another_tool_call_cannot_replace_a_staged_file() {
    let fx = Fx::new();
    fx.put("ordinary.txt", "one\n");
    for tool in ["write", "delete", "rename", "mkdir"] {
        let staged = fx.p(".ordinary.txt.wsmp-abcdefghij");
        let value = match tool {
            "write" => json!({ "path": staged, "content": "swap" }),
            "delete" => json!({ "path": staged }),
            "rename" => json!({ "from": staged, "to": fx.p("elsewhere.txt") }),
            _ => json!({ "path": staged }),
        };
        let r = fx.ops.execute(tool, value, &fx.cancel);
        assert_eq!(
            r.expect_err("staged names are refused").code,
            ErrorCode::PathDenied,
            "{tool}"
        );
    }
    // an ordinary dotfile that merely looks similar is fine
    fx.ops
        .write(
            &args(json!({ "path": fx.p(".ordinary.txt.wsmp-short"), "content": "ok" })),
            &fx.cancel,
        )
        .unwrap();
}

// ---- an atomic replace never overwrites a successor inserted after the last check -----

// Linux and macOS use atomic exchange to restore a successor and clean up the stage.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn a_successor_inserted_before_the_commit_is_preserved_and_the_edit_conflicts() {
    let root = Arc::new(std::sync::Mutex::new(std::path::PathBuf::new()));
    let seen = Arc::clone(&root);
    let fx = Fx::new().with_hook(once_before_commit(move || {
        let root = seen.lock().unwrap();
        std::fs::write(root.join("successor.tmp"), "concurrent update").unwrap();
        std::fs::rename(root.join("successor.tmp"), root.join("doc.txt")).unwrap();
    }));
    *root.lock().unwrap() = fx.root.clone();
    fx.put("doc.txt", "original\n");
    let r = fx.ops.edit(
        &args(json!({ "path": fx.p("doc.txt"), "edits": [{ "oldText": "original", "newText": "edited" }] })),
        &fx.cancel,
    );
    assert_eq!(code(r), ErrorCode::Conflict);
    assert_eq!(
        fx.get("doc.txt"),
        "concurrent update",
        "the successor survives"
    );
    assert!(fx.leftovers("").is_empty(), "the staged file is cleaned up");
    // an uncontended replace still works
    let fx2 = Fx::new();
    fx2.put("doc.txt", "original\n");
    fx2.ops
        .edit(
            &args(json!({ "path": fx2.p("doc.txt"), "edits": [{ "oldText": "original", "newText": "edited" }] })),
            &fx2.cancel,
        )
        .unwrap();
    assert_eq!(fx2.get("doc.txt"), "edited\n");
    assert!(fx2.leftovers("").is_empty());
}

// ---- the large-file tail contract: complete, marked, or refused -------------------

#[test]
fn a_large_file_tail_marks_lines_cut_by_the_output_cap_and_refuses_an_unscannable_tail() {
    let fx = Fx::new();
    let path = fx.root.join("marked.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let block = "log line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(20_000);
    for _ in 0..68 {
        file.write_all(block.as_bytes()).unwrap();
    }
    for i in 0..50 {
        writeln!(file, "tail line {i:02} {}", "z".repeat(1_000)).unwrap();
    }
    file.flush().unwrap();
    drop(file);
    let r = fx.read_with(json!({ "path": fx.p("marked.log"), "startLine": -50 }));
    assert!(
        r.text.starts_with("\u{2026}[truncated: "),
        "{}",
        r.text.get(..80).unwrap_or(&r.text)
    );
    assert!(r.text.contains("tail line 49"), "the newest line is kept");
    // four 12 MiB lines: the raw tail of four lines is beyond the 32 MiB scan bound
    // (the message names that bound, so it is not the output cap that fired)
    let path = fx.root.join("unscannable.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    for _ in 0..68 {
        file.write_all(block.as_bytes()).unwrap();
    }
    for _ in 0..4 {
        file.write_all("w".repeat(12 << 20).as_bytes()).unwrap();
        file.write_all(b"\n").unwrap();
    }
    file.flush().unwrap();
    drop(file);
    let r = fx.ops.read(
        &args(json!({ "path": fx.p("unscannable.log"), "startLine": -4 })),
        &fx.cancel,
    );
    let err = r.expect_err("the tail is beyond the scan bound");
    assert_eq!(err.code, ErrorCode::TooLarge);
    assert!(err.message.contains("scan bound"), "{}", err.message);
}

#[test]
fn staging_names_are_refused_under_every_folded_spelling() {
    let fx = Fx::new();
    for staged in [
        ".doc.txt.wsmp-a1b2c3d4e5",
        ".doc.txt.WSMP-a1b2c3d4e5",
        ".doc.txt.w\u{17F}mp-a1b2c3d4e5",
        ".doc.txt.wsmp-a1b2c3d4e5.",
        ".doc.txt.wsmp-a1b2c3d4e5 ",
    ] {
        let r = fx.ops.write(
            &args(json!({ "path": fx.p(staged), "content": "x" })),
            &fx.cancel,
        );
        assert_eq!(code(r), ErrorCode::PathDenied, "{staged:?}");
    }
}

// ---- the callers of the exchange treat each errno class as documented ---------------

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod exchange_callers {
    use super::*;
    use crate::file_ops::exchange::{FaultScope, Primitive};
    use nix::errno::Errno;

    fn inject(errno: Errno) -> FaultScope {
        FaultScope::new(&[(Primitive::Exchange, 1, errno)])
    }

    fn edit(fx: &Fx) -> FileResult<super::super::super::edit::EditResult> {
        fx.ops.edit(
            &args(json!({ "path": fx.p("doc.txt"), "edits": [{ "oldText": "original", "newText": "edited" }] })),
            &fx.cancel,
        )
    }

    fn overwrite(fx: &Fx) -> FileResult<super::super::super::mutate::RenameResult> {
        fx.put("src.txt", "mine");
        fx.put("dst.txt", "old");
        let etag = fx.etag("dst.txt");
        rename(
            fx,
            json!({ "from": fx.p("src.txt"), "to": fx.p("dst.txt"), "overwrite": true, "expectedEtag": etag }),
        )
    }

    #[test]
    fn a_replace_uses_safe_publication_only_for_unsupported_errors() {
        for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
            let fx = Fx::new();
            fx.put("doc.txt", "original\n");
            let _faults = inject(errno);
            edit(&fx).unwrap_or_else(|e| panic!("{errno}: {e:?}"));
            assert_eq!(fx.get("doc.txt"), "edited\n", "{errno}");
            assert!(fx.leftovers("").is_empty(), "{errno}");
        }
        for errno in [Errno::EPERM, Errno::EXDEV, Errno::EIO] {
            let fx = Fx::new();
            fx.put("doc.txt", "original\n");
            let _faults = inject(errno);
            assert!(
                edit(&fx).is_err(),
                "{errno} must not fall back to a plain rename"
            );
            assert_eq!(fx.get("doc.txt"), "original\n", "{errno}");
            assert!(fx.leftovers("").is_empty(), "{errno}");
        }
    }

    #[test]
    fn a_replace_reports_a_file_deleted_before_the_commit_as_gone() {
        let fx = Fx::new();
        fx.put("doc.txt", "original\n");
        let _faults = inject(Errno::ENOENT);
        let error = edit(&fx).expect_err("the exchange found nothing to replace");
        assert_eq!(error.code, ErrorCode::Conflict);
        assert!(fx.leftovers("").is_empty());
    }

    #[test]
    fn an_overwrite_onto_another_name_of_the_same_file_refuses_and_keeps_it() {
        let fx = Fx::new();
        fx.put("src.txt", "mine");
        std::fs::hard_link(fx.root.join("src.txt"), fx.root.join("dst.txt")).unwrap();
        let etag = fx.etag("dst.txt");
        let r = rename(
            &fx,
            json!({ "from": fx.p("src.txt"), "to": fx.p("dst.txt"), "overwrite": true, "expectedEtag": etag }),
        );
        assert_eq!(code(r), ErrorCode::InvalidInput);
        assert_eq!(fx.get("src.txt"), "mine");
        assert_eq!(fx.get("dst.txt"), "mine");
    }

    #[test]
    fn an_overwrite_maps_unsupported_errors_to_unsafe_filesystem_and_others_to_their_own_error() {
        for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
            let fx = Fx::new();
            let _faults = inject(errno);
            assert_eq!(code(overwrite(&fx)), ErrorCode::UnsafeFilesystem, "{errno}");
            assert_eq!(fx.get("dst.txt"), "old", "{errno}");
            assert_eq!(fx.get("src.txt"), "mine", "{errno}");
        }
        for errno in [Errno::EPERM, Errno::EXDEV, Errno::EIO] {
            let fx = Fx::new();
            let _faults = inject(errno);
            assert_eq!(code(overwrite(&fx)), ErrorCode::IoError, "{errno}");
            assert_eq!(fx.get("dst.txt"), "old", "{errno}");
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn rename_overwrite_refuses_case_differing_hard_link_alias() {
    use crate::file_ops::resolve::Stat;

    let fx = Fx::new();
    fx.put("a", "keep these bytes\n");
    std::fs::hard_link(fx.root.join("a"), fx.root.join("A")).unwrap();
    let before = Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join("a")).unwrap());
    assert_eq!(before.nlink, 2);
    let etag = fx.etag("A");
    // Destination ETag validation still precedes the same-object decision.
    assert_eq!(
        code(rename(
            &fx,
            json!({ "from": fx.p("a"), "to": fx.p("A"), "overwrite": true, "expectedEtag": "h:stale" }),
        )),
        ErrorCode::Conflict,
    );
    let error = rename(
        &fx,
        json!({ "from": fx.p("a"), "to": fx.p("A"), "overwrite": true, "expectedEtag": etag }),
    )
    .expect_err("two hard links must not be treated as a single-entry alias");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.message, "source and destination are the same file");
    assert_eq!(fx.get("a"), "keep these bytes\n");
    assert_eq!(fx.get("A"), "keep these bytes\n");
    for name in ["a", "A"] {
        let after = Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join(name)).unwrap());
        assert!(after.same_object(&before));
        assert_eq!(after.nlink, 2);
    }
    let mut names: Vec<_> = std::fs::read_dir(&fx.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(names, ["A", "a"]);
}

#[cfg(target_os = "macos")]
#[test]
fn rename_overwrite_case_only_alias_changes_spelling_on_case_insensitive_volume() {
    use crate::file_ops::exchange::{FaultScope, Primitive};
    use crate::file_ops::resolve::Stat;
    use nix::errno::Errno;

    let fx = Fx::new();
    fx.put("Probe", "probe");
    match std::fs::symlink_metadata(fx.root.join("probe")) {
        Ok(alias) => {
            let probe =
                Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join("Probe")).unwrap());
            assert!(probe.same_object(&Stat::from_metadata(&alias)));
            assert_eq!(probe.nlink, 1);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            writeln!(
                std::io::stderr(),
                "skipping case-only rename: temp directory volume is case-sensitive"
            )
            .expect("print skip reason");
            return;
        }
        Err(error) => panic!("case-insensitivity probe failed: {error}"),
    }
    std::fs::remove_file(fx.root.join("Probe")).unwrap();
    fx.put("Foo.txt", "keep these bytes\n");
    let before = Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join("Foo.txt")).unwrap());
    let etag = fx.etag("foo.txt");
    assert_eq!(
        code(rename(
            &fx,
            json!({ "from": fx.p("Foo.txt"), "to": fx.p("foo.txt") })
        )),
        ErrorCode::Exists,
    );
    assert_eq!(
        code(rename(
            &fx,
            json!({ "from": fx.p("Foo.txt"), "to": fx.p("foo.txt"), "overwrite": true, "expectedEtag": "h:stale" }),
        )),
        ErrorCode::Conflict,
    );
    // A recovery allocation would try Rmdir at finish, retaining a path under
    // this fault. Case-only rename must neither allocate it nor use exchange.
    let _faults = FaultScope::new(&[
        (Primitive::Exchange, 1, Errno::EIO),
        (Primitive::Capture, 1, Errno::EIO),
        (Primitive::Rmdir, 1, Errno::EIO),
    ]);
    let result = rename(
        &fx,
        json!({ "from": fx.p("Foo.txt"), "to": fx.p("foo.txt"), "overwrite": true, "expectedEtag": etag }),
    )
    .expect("case-only overwrite must update the stored spelling");
    assert_eq!(result.etag.as_deref(), Some(etag.as_str()));
    assert!(result.recovered.is_empty());
    assert_eq!(fx.get("foo.txt"), "keep these bytes\n");
    let after = Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join("foo.txt")).unwrap());
    assert!(after.same_object(&before));
    assert_eq!(after.nlink, 1);
    let names: Vec<_> = std::fs::read_dir(&fx.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["foo.txt"]);

    std::fs::hard_link(fx.root.join("foo.txt"), fx.root.join("alias.txt")).unwrap();
    // nlink > 1 refuses even the two case spellings of the original entry.
    for to in ["alias.txt", "FOO.txt"] {
        let error = rename(
            &fx,
            json!({ "from": fx.p("foo.txt"), "to": fx.p(to), "overwrite": true, "expectedEtag": fx.etag(to) }),
        )
        .expect_err("hard-link aliases remain refused on a case-insensitive volume");
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.message, "source and destination are the same file");
        assert_eq!(fx.get("foo.txt"), "keep these bytes\n");
        assert_eq!(fx.get("alias.txt"), "keep these bytes\n");
    }
    let mut names: Vec<_> = std::fs::read_dir(&fx.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(names, ["alias.txt", "foo.txt"]);
}
