//! This binary has one test because shutdown closes the global run registry.
#![cfg(windows)]

#[path = "support/windows_tree.rs"]
mod windows_tree;

use std::time::{Duration, Instant};
use windows_tree::{Tree, assert_dead};
use wsmp::bounded_run::{RunError, active_runs, kill_all_active, run};

#[test]
fn shutdown_reaches_the_job_registered_by_run_and_refuses_later_runs() {
    let tree = Tree::new();
    let args = tree.command("detach");
    std::thread::scope(|scope| {
        let runner = scope.spawn(|| run("cmd", &args, Duration::from_secs(30), 1024, None));
        let grandchild = tree.read_marker().parse().expect("grandchild PID");
        assert_eq!(active_runs(), 1, "run must register in ACTIVE");
        let started = Instant::now();
        kill_all_active();
        assert!(runner.join().expect("run thread").is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_dead(grandchild);
        assert_eq!(active_runs(), 0);
    });
    assert_eq!(
        run(
            "cmd",
            &["/C".into(), "exit 0".into()],
            Duration::from_secs(5),
            1024,
            None
        ),
        Err(RunError::Cancelled)
    );
}
