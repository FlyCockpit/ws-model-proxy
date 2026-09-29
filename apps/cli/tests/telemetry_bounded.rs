//! `nvidia-smi` and other telemetry helpers run under `run_bounded`. It forks,
//! so it lives in its own test binary rather than beside timing-sensitive
//! unit tests.
//!
//! State table (E = stdout closed, X = the program exited, D = deadline):
//! - E then X (exit 0) before D, at most `limit` bytes → `Output`;
//! - E then X with a nonzero exit → `Failed`;
//! - E, but the program keeps running past D → `Failed`;
//! - X while a helper still holds stdout past D → `Failed`;
//! - neither before D (hung) → `Failed`;
//! - more than `limit` bytes → `Failed`;
//! - and on every row, nothing left in the program's process group survives.

#![cfg(unix)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use wsmp::telemetry::{Bounded, run_bounded};

fn sh(script: &str, timeout: Duration, limit: u64) -> Bounded {
    run_bounded(
        "sh",
        &["-c".to_string(), script.to_string()],
        timeout,
        limit,
    )
}

fn marker(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("wsmp-bounded-{name}-{}.marker", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
}

enum Expect {
    Output(&'static str),
    Failed,
}

#[test]
fn run_bounded_state_table() {
    // (name, script, timeout ms, limit, expected). `{helper}` starts a
    // helper that touches its marker after ~1 s unless it was killed.
    let rows: &[(&str, &str, u64, u64, Expect)] = &[
        (
            "stdout-then-exit",
            "echo out; echo secret-stderr >&2",
            5_000,
            1024,
            Expect::Output("out\n"),
        ),
        (
            "exact-limit",
            "printf 0123456789abcdef",
            5_000,
            16,
            Expect::Output("0123456789abcdef"),
        ),
        (
            "limit-plus-one",
            "printf 0123456789abcdefg",
            5_000,
            16,
            Expect::Failed,
        ),
        ("flood", "yes x | head -c 100000", 5_000, 16, Expect::Failed),
        (
            "nonzero-exit",
            "echo out; exit 3",
            5_000,
            1024,
            Expect::Failed,
        ),
        ("hung", "sleep 30", 200, 1024, Expect::Failed),
        // Closes stdout, cleans up, then exits 0: complete output, success.
        (
            "close-then-cleanup",
            "echo out; exec >&-; sleep 0.2; exit 0",
            5_000,
            1024,
            Expect::Output("out\n"),
        ),
        // Closes stdout and keeps running past the deadline.
        (
            "close-then-hang",
            "echo out; exec >&-; sleep 30",
            300,
            1024,
            Expect::Failed,
        ),
        // A helper holds stdout after the program exited 0 / 7.
        (
            "helper-holds-stdout-exit-0",
            "{helper} exit 0",
            100,
            1024,
            Expect::Failed,
        ),
        (
            "helper-holds-stdout-exit-7",
            "{helper} exit 7",
            100,
            1024,
            Expect::Failed,
        ),
        (
            "helper-holds-stdout-hung",
            "{helper} sleep 30",
            200,
            1024,
            Expect::Failed,
        ),
        // A helper that let go of stdout: the output stands, the helper dies.
        (
            "helper-detached",
            "{detached} echo done",
            5_000,
            1024,
            Expect::Output("done\n"),
        ),
    ];
    let mut markers = Vec::new();
    for (name, script, timeout, limit, expected) in rows {
        let path = marker(name);
        let script = script
            .replace(
                "{helper}",
                &format!("(sleep 1 && touch {}) &", path.display()),
            )
            .replace(
                "{detached}",
                &format!("(sleep 1 && touch {}) >/dev/null &", path.display()),
            );
        let started = Instant::now();
        let result = sh(&script, Duration::from_millis(*timeout), *limit);
        match expected {
            Expect::Output(text) => {
                assert_eq!(result, Bounded::Output((*text).to_string()), "{name}");
            }
            Expect::Failed => assert_eq!(result, Bounded::Failed, "{name}"),
        }
        assert!(
            started.elapsed() < Duration::from_millis(timeout + 2_000),
            "{name} took {:?}",
            started.elapsed()
        );
        markers.push((name, path));
    }
    // Every helper would have touched its marker ~1 s in had it survived.
    std::thread::sleep(Duration::from_millis(1_500));
    for (name, path) in markers {
        let survived = path.exists();
        let _ = std::fs::remove_file(&path);
        assert!(!survived, "{name}: a helper outlived run_bounded");
    }

    assert_eq!(
        run_bounded("wsmp-no-such-program", &[], Duration::from_secs(1), 1024),
        Bounded::Unavailable
    );
}

#[test]
fn run_bounded_never_fails_a_program_that_closes_stdout_just_before_exiting() {
    // coreutils `cat` closes stdout in an atexit handler, just before it
    // exits. Killing the group at stdout EOF made ~1 in 5 of these fail.
    let input = std::env::temp_dir().join(format!("wsmp-bounded-cat-{}.txt", std::process::id()));
    std::fs::write(&input, "42\n").expect("write input");
    let args = [input.display().to_string()];
    let failures = (0..300)
        .filter(|_| {
            run_bounded("cat", &args, Duration::from_secs(5), 1024)
                != Bounded::Output("42\n".to_string())
        })
        .count();
    let _ = std::fs::remove_file(&input);
    assert_eq!(failures, 0, "{failures} of 300 runs failed");
}
