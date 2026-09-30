//! Windows tree cleanup, exercised by the existing windows-latest CI job.
#![cfg(windows)]

#[path = "support/windows_tree.rs"]
mod windows_tree;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows_tree::{Tree, assert_dead};
use wsmp::bounded_run::{REAP_GRACE, RunError, run};

fn cmd(tree: &Tree, mode: &str, cancel: Option<&AtomicBool>) -> Result<Vec<u8>, RunError> {
    run(
        "cmd",
        &tree.command(mode),
        Duration::from_secs(4),
        1024,
        cancel,
    )
}

#[test]
fn timeout_kills_the_tree_with_a_live_root_and_with_an_exited_root() {
    for mode in ["hang", "root-exit", "detach", "breakaway"] {
        let tree = Tree::new();
        let started = Instant::now();
        assert_eq!(cmd(&tree, mode, None), Err(RunError::Timeout), "{mode}");
        assert!(started.elapsed() < Duration::from_secs(4) + REAP_GRACE + Duration::from_secs(2));
        let marker = tree.read_marker();
        if mode == "breakaway" && marker == "denied" {
            // Jobs without BREAKAWAY_OK reject a requested escape before it
            // can execute. If Windows permits the spawn, it must still die.
            continue;
        }
        assert_dead(marker.parse().expect("grandchild PID"));
    }
}

#[test]
fn cancel_kills_a_detached_grandchild() {
    let tree = Tree::new();
    let cancel = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let runner = scope.spawn(|| cmd(&tree, "detach", Some(&cancel)));
        let pid = tree.read_marker().parse().expect("grandchild PID");
        let started = Instant::now();
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(runner.join().expect("run thread"), Err(RunError::Cancelled));
        assert!(started.elapsed() < REAP_GRACE + Duration::from_secs(2));
        assert_dead(pid);
    });
}

#[test]
fn success_kills_leftovers_after_the_root_exits() {
    let tree = Tree::new();
    assert_eq!(cmd(&tree, "success", None), Ok(Vec::new()));
    assert_dead(tree.read_marker().parse().expect("grandchild PID"));
}

#[test]
fn a_program_that_cannot_start_fails_closed() {
    assert_eq!(
        run(
            "wsmp-no-such-program",
            &[],
            Duration::from_secs(1),
            1024,
            None
        ),
        Err(RunError::Spawn)
    );
}
