//! Daemon exit during a run must not orphan the child's process group.
//! `kill_all_active` is what every exit path calls (`shutdown::terminate_by_signal`
//! and `main`). It closes a process-wide registry, so this is the only test
//! in its binary.

#![cfg(unix)]

use std::time::{Duration, Instant};

use wsmp::bounded_run::{RunError, active_runs, kill_all_active, run};

#[test]
fn exiting_kills_the_running_group_and_refuses_later_runs() {
    let marker = std::env::temp_dir().join(format!("wsmp-run-exit-{}.marker", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    // A finished run leaves the registry: a reaped pid must never be killed.
    let done = run(
        "sh",
        &["-c".to_string(), "echo hi".to_string()],
        Duration::from_secs(5),
        1024,
        None,
    );
    assert_eq!(done.as_deref(), Ok(&b"hi\n"[..]));
    assert_eq!(active_runs(), 0);
    // A long command with a background helper that would touch the marker.
    let script = format!("(sleep 1 && touch {}) & sleep 30", marker.display());
    let started = Instant::now();
    let handle = std::thread::spawn(move || {
        run(
            "sh",
            &["-c".to_string(), script],
            Duration::from_secs(30),
            1024,
            None,
        )
    });
    std::thread::sleep(Duration::from_millis(300));
    kill_all_active();
    let result = handle.join().expect("run thread");
    assert!(result.is_err(), "{result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the run outlived the exit: {:?}",
        started.elapsed()
    );
    std::thread::sleep(Duration::from_millis(1_500));
    let survived = marker.exists();
    let _ = std::fs::remove_file(&marker);
    assert!(!survived, "a helper outlived the daemon exit");
    // Nothing new may start once the process is exiting.
    assert_eq!(
        run(
            "sh",
            &["-c".to_string(), "echo hi".to_string()],
            Duration::from_secs(5),
            1024,
            None
        ),
        Err(RunError::Cancelled)
    );
    // ...not even by runs already queued behind the exit: none of them
    // may execute (a check after the spawn would run the command first).
    let dir = tempfile::tempdir().expect("tempdir");
    let results = std::thread::scope(|scope| {
        let handles = (0..100)
            .map(|index| {
                let path = dir.path().join(format!("late-{index}"));
                scope.spawn(move || {
                    run(
                        "touch",
                        &[path.display().to_string()],
                        Duration::from_secs(5),
                        1024,
                        None,
                    )
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("run thread"))
            .collect::<Vec<_>>()
    });
    assert!(
        results
            .iter()
            .all(|result| *result == Err(RunError::Cancelled)),
        "{results:?}"
    );
    assert_eq!(
        std::fs::read_dir(dir.path()).expect("dir").count(),
        0,
        "a command ran after the daemon began exiting"
    );
}
