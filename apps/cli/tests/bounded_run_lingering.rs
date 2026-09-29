//! A child that survives the deadline kill (here: it left its process group,
//! as a command stuck in the kernel or one that calls `setpgid` would) must
//! not pile up: it is handed to a reaper, and at `LINGERING_MAX` stuck
//! children new runs are refused until they finish. It owns a process-wide
//! counter, so it is the only test in its binary.

#![cfg(unix)]

use std::os::unix::process::CommandExt;
use std::time::{Duration, Instant};

use wsmp::bounded_run::{LINGERING_MAX, RunError, run};

/// The child joins the anchor's group, so `killpg(child pid)` finds nothing.
const ESCAPE: &str = "import os,sys,time\nos.setpgid(0, int(sys.argv[1]))\nassert os.getpgid(0) == int(sys.argv[1])\nsys.stdout.write('x')\nsys.stdout.flush()\ntime.sleep(int(sys.argv[2]))";

fn stuck(pgid: &str) -> Result<Vec<u8>, RunError> {
    run(
        "python3",
        &[
            "-c".to_string(),
            ESCAPE.to_string(),
            pgid.to_string(),
            "5".to_string(),
        ],
        Duration::from_millis(200),
        1024,
        None,
    )
}

#[test]
fn stuck_children_are_capped_and_the_cap_recovers() {
    // The escaping child is a python3 one-liner (every CI runner has it).
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
    let started = Instant::now();
    let results = std::thread::scope(|scope| {
        let handles = (0..LINGERING_MAX)
            .map(|_| scope.spawn(|| stuck(&pgid)))
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
    // Every slot is held by a child still asleep: refused, not started.
    assert_eq!(
        run(
            "echo",
            &["hi".to_string()],
            Duration::from_secs(5),
            1024,
            None
        ),
        Err(RunError::Resources)
    );
    // They exit on their own; the reapers free the slots.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match run(
            "echo",
            &["hi".to_string()],
            Duration::from_secs(5),
            1024,
            None,
        ) {
            Ok(bytes) => {
                assert_eq!(bytes, b"hi\n");
                break;
            }
            Err(RunError::Resources) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(200));
            }
            other => panic!("did not recover: {other:?}"),
        }
    }
    let _ = anchor.kill();
    let _ = anchor.wait();
}
