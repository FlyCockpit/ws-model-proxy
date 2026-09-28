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
