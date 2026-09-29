//! Escaped children and the run budget. A direct child that left its process
//! group is killed by `finish` (it is still ours), so real processes cannot
//! occupy the stuck-child cap any more (only a child in uninterruptible sleep
//! can; the admission arithmetic is unit-tested in `bounded_run.rs`). Many
//! concurrent escapers must all settle by the deadline, leave nothing
//! running, and leave the primitive able to run the next command at once.

#![cfg(unix)]

use std::os::unix::process::CommandExt;
use std::time::{Duration, Instant};

use wsmp::bounded_run::{RunError, run};

/// The child joins the anchor's group (so `killpg(child pid)` finds nothing),
/// writes a byte, sleeps, then touches the marker if it was left alive.
const ESCAPE: &str = "import os,sys,time\nos.setpgid(0, int(sys.argv[1]))\nassert os.getpgid(0) == int(sys.argv[1])\nsys.stdout.write('x')\nsys.stdout.flush()\ntime.sleep(2)\nopen(sys.argv[2], 'w').close()";

#[test]
fn sixteen_concurrent_escaped_children_are_killed_and_nothing_is_refused() {
    std::process::Command::new("python3")
        .arg("--version")
        .output()
        .expect("python3 is required for this test");
    let mut anchor = std::process::Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .expect("anchor");
    let pgid = anchor.id().to_string();
    let dir = tempfile::tempdir().expect("tempdir");
    let barrier = std::sync::Barrier::new(16);
    let started = Instant::now();
    let results = std::thread::scope(|scope| {
        let handles = (0..16)
            .map(|index| {
                let marker = dir.path().join(format!("alive-{index}"));
                let pgid = &pgid;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    run(
                        "python3",
                        &[
                            "-c".to_string(),
                            ESCAPE.to_string(),
                            pgid.clone(),
                            marker.display().to_string(),
                        ],
                        Duration::from_millis(300),
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
            .all(|result| *result == Err(RunError::Timeout)),
        "{results:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    // No run was refused: nothing is stuck.
    assert_eq!(
        run(
            "echo",
            &["hi".to_string()],
            Duration::from_secs(5),
            1024,
            None
        ),
        Ok(b"hi\n".to_vec())
    );
    std::thread::sleep(Duration::from_millis(2_500));
    let survivors = std::fs::read_dir(dir.path()).expect("dir").count();
    let _ = anchor.kill();
    let _ = anchor.wait();
    assert_eq!(survivors, 0, "escaped children outlived the deadline");
}
