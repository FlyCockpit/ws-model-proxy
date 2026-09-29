//! Shutdown racing runs that are starting: every run is either refused before
//! it spawns or killed with its group by the time `kill_all_active` returns.
//! It closes the process-wide registry, so it is the only test in its binary.

#![cfg(target_os = "linux")]

use std::time::{Duration, Instant};

use wsmp::bounded_run::{kill_all_active, run};

fn alive(pid: i32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
        && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| stat.contains(") Z "))
            .unwrap_or(false)
}

#[test]
fn no_run_survives_kill_all_active_however_it_races() {
    let dir = tempfile::tempdir().expect("tempdir");
    let started = Instant::now();
    std::thread::scope(|scope| {
        let handles = (0..48)
            .map(|index| {
                let pid_file = dir.path().join(format!("pid-{index}"));
                scope.spawn(move || {
                    // Start runs continuously so some are mid-spawn when the
                    // exit begins.
                    while started.elapsed() < Duration::from_secs(20) {
                        let script = format!("echo $$ > '{}'; sleep 30 & wait", pid_file.display());
                        if run(
                            "sh",
                            &["-c".to_string(), script],
                            Duration::from_secs(30),
                            1024,
                            None,
                        )
                        .is_err()
                        {
                            break;
                        }
                    }
                })
            })
            .collect::<Vec<_>>();
        std::thread::sleep(Duration::from_millis(150));
        kill_all_active();
        // Returned: every pid ever written must already be dead or dying.
        let deadline = Instant::now() + Duration::from_secs(2);
        for entry in std::fs::read_dir(dir.path()).expect("dir") {
            let path = entry.expect("entry").path();
            let Some(pid) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
            else {
                continue;
            };
            while alive(pid) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(!alive(pid), "{} survived the exit", path.display());
        }
        for handle in handles {
            handle.join().expect("run thread");
        }
    });
}
