//! A helper outside the group that holds stdout must not leak a thread or a
//! descriptor per run. It counts this process's threads and descriptors, so it
//! is the only test in its binary.

#![cfg(target_os = "linux")]

use std::time::Duration;

use wsmp::bounded_run::{RunError, run};

fn sh(script: &str, timeout: Duration) -> Result<Vec<u8>, RunError> {
    run(
        "sh",
        &["-c".to_string(), script.to_string()],
        timeout,
        1024,
        None,
    )
}

fn open_descriptors() -> usize {
    std::fs::read_dir("/proc/self/fd").map_or(0, Iterator::count)
}

fn threads() -> usize {
    std::fs::read_dir("/proc/self/task").map_or(0, Iterator::count)
}

/// A helper that leaves the group while holding stdout (`setsid daemon &`)
/// cannot be killed by the group kill. The run still settles at the deadline
/// and must leave no reader thread and no pipe descriptor behind, however
/// many runs repeat.
#[test]
fn a_pipe_holder_outside_the_group_leaks_no_thread_or_descriptor() {
    std::process::Command::new("setsid")
        .arg("--version")
        .output()
        .expect("setsid (util-linux) is required for this test");
    let dir = tempfile::tempdir().expect("tempdir");
    let before_fds = open_descriptors();
    let before_threads = threads();
    let mut holders = Vec::new();
    for round in 0..10 {
        let pid_file = dir.path().join(format!("holder-{round}.pid"));
        let script = format!("setsid sleep 25 & echo $! > {}; echo 1", pid_file.display());
        assert_eq!(
            sh(&script, Duration::from_millis(300)),
            Err(RunError::Timeout),
            "round {round}"
        );
        holders.push(pid_file);
    }
    let after_fds = open_descriptors();
    let after_threads = threads();
    for pid_file in holders {
        if let Some(pid) = std::fs::read_to_string(pid_file)
            .ok()
            .and_then(|text| text.trim().parse::<i32>().ok())
        {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
    assert_eq!(after_fds, before_fds, "leaked descriptors");
    assert_eq!(after_threads, before_threads, "leaked threads");
}
