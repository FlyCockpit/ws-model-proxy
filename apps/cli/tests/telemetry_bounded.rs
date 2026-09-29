//! `nvidia-smi` and other telemetry helpers run under `run_bounded`. It forks,
//! so it lives in its own test binary rather than beside timing-sensitive
//! unit tests.

#![cfg(unix)]

use std::time::{Duration, Instant};

use wsmp::telemetry::{Bounded, run_bounded};

#[test]
fn run_bounded_kills_a_hung_program_and_discards_stderr() {
    let started = Instant::now();
    let hung = run_bounded(
        "sh",
        &["-c".to_string(), "sleep 30".to_string()],
        Duration::from_millis(200),
        1024,
    );
    assert_eq!(hung, Bounded::Failed);
    assert!(started.elapsed() < Duration::from_secs(5));

    let output = run_bounded(
        "sh",
        &[
            "-c".to_string(),
            "echo out; echo secret-stderr >&2".to_string(),
        ],
        Duration::from_secs(5),
        1024,
    );
    assert_eq!(output, Bounded::Output("out\n".to_string()));

    // Exactly the limit is output; one byte more is a failure (oversized
    // output is dropped, never truncated into a misleading value).
    let exact = run_bounded(
        "sh",
        &["-c".to_string(), "printf 0123456789abcdef".to_string()],
        Duration::from_secs(5),
        16,
    );
    assert_eq!(exact, Bounded::Output("0123456789abcdef".to_string()));
    let over = run_bounded(
        "sh",
        &["-c".to_string(), "printf 0123456789abcdefg".to_string()],
        Duration::from_secs(5),
        16,
    );
    assert_eq!(over, Bounded::Failed);
    let flood = run_bounded(
        "sh",
        &["-c".to_string(), "yes x | head -c 100000".to_string()],
        Duration::from_secs(5),
        16,
    );
    assert_eq!(flood, Bounded::Failed);

    assert_eq!(
        run_bounded("wsmp-no-such-program", &[], Duration::from_secs(1), 1024),
        Bounded::Unavailable
    );
}

#[test]
fn run_bounded_kills_a_descendant_holding_the_stdout_pipe() {
    // A tool that forks a helper sharing stdout: killing only the direct
    // child would leave the helper running (and holding the pipe) until it
    // exits. With the child in its own process group it is killed too.
    let marker = std::env::temp_dir().join(format!(
        "wsmp-bounded-descendant-{}.marker",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let script = format!("(sleep 1 && touch {}) & sleep 30", marker.display());

    let result = run_bounded(
        "sh",
        &["-c".to_string(), script],
        Duration::from_millis(200),
        1024,
    );
    assert_eq!(result, Bounded::Failed);

    // The descendant would touch the marker ~1s in; if it survived the group
    // kill the marker appears.
    std::thread::sleep(Duration::from_millis(1500));
    let survived = marker.exists();
    let _ = std::fs::remove_file(&marker);
    assert!(
        !survived,
        "the descendant was not reaped with its process group"
    );
}

/// Run `script` (which starts a helper that touches the marker after ~1 s)
/// and report whether the helper survived `run_bounded`.
fn helper_survives(name: &str, script_after_helper: &str, timeout: Duration) -> (Bounded, bool) {
    let marker =
        std::env::temp_dir().join(format!("wsmp-bounded-{name}-{}.marker", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let script = format!(
        "(sleep 1 && touch {}) & {script_after_helper}",
        marker.display()
    );
    let result = run_bounded("sh", &["-c".to_string(), script], timeout, 1024);
    std::thread::sleep(Duration::from_millis(1500));
    let survived = marker.exists();
    let _ = std::fs::remove_file(&marker);
    (result, survived)
}

#[test]
fn run_bounded_kills_helpers_left_by_a_tool_that_exits_first() {
    // The tool exits 0 while its helper still holds stdout: the pipe never
    // closes before the deadline, and the helper must not outlive the call.
    let (result, survived) = helper_survives("exit-zero", "exit 0", Duration::from_millis(100));
    assert_eq!(result, Bounded::Failed);
    assert!(!survived, "a helper of a tool that exited 0 survived");

    // Same with a failing exit status.
    let (result, survived) = helper_survives("exit-seven", "exit 7", Duration::from_millis(100));
    assert_eq!(result, Bounded::Failed);
    assert!(!survived, "a helper of a tool that exited 7 survived");

    // A helper that let go of stdout: the tool's output is complete and
    // valid, and the leftover helper is still killed.
    let marker = std::env::temp_dir().join(format!(
        "wsmp-bounded-detached-{}.marker",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let script = format!(
        "(sleep 1 && touch {}) >/dev/null & echo done",
        marker.display()
    );
    let result = run_bounded(
        "sh",
        &["-c".to_string(), script],
        Duration::from_secs(5),
        1024,
    );
    assert_eq!(result, Bounded::Output("done\n".to_string()));
    std::thread::sleep(Duration::from_millis(1500));
    let survived = marker.exists();
    let _ = std::fs::remove_file(&marker);
    assert!(!survived, "a helper detached from stdout survived");
}
