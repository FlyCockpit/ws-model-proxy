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

    let capped = run_bounded(
        "sh",
        &["-c".to_string(), "yes x | head -c 100000".to_string()],
        Duration::from_secs(5),
        16,
    );
    if let Bounded::Output(text) = capped {
        assert!(text.len() <= 16, "stdout is capped at the limit");
    }

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
