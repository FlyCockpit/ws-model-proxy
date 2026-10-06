//! `bounded_run::run` state table (see the module docs for E, X, D). It forks,
//! so it lives in its own test binary rather than beside timing-sensitive
//! unit tests. Every row also proves nothing the program left in its process
//! group outlives the call, and that the call settles by its `max` time.

#![cfg(unix)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use wsmp::bounded_run::{REAP_GRACE, RunError, run, run_until_any_status};

/// A process in its own group, alive for the test: the escaping child joins
/// that group, so the deadline's `killpg(child pid)` finds nothing to kill.
struct Anchor(std::process::Child);

impl Anchor {
    fn start() -> Self {
        use std::os::unix::process::CommandExt;
        let child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("anchor");
        Self(child)
    }
    fn pgid(&self) -> String {
        self.0.id().to_string()
    }
}

impl Drop for Anchor {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const ESCAPE: &str = "import os,sys,time\nos.setpgid(0, int(sys.argv[1]))\nassert os.getpgid(0) == int(sys.argv[1])\nsys.stdout.write('x')\nsys.stdout.flush()\ntime.sleep(int(sys.argv[2]))";

fn marker(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("wsmp-run-{name}-{}.marker", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
}

#[derive(Debug, PartialEq)]
enum Expect {
    Ok(&'static str),
    Err(RunError),
}

struct Row {
    name: &'static str,
    script: &'static str,
    timeout_ms: u64,
    limit: usize,
    expect: Expect,
    /// The call must have returned within this many milliseconds.
    max_ms: u64,
}

const fn row(
    name: &'static str,
    script: &'static str,
    timeout_ms: u64,
    limit: usize,
    expect: Expect,
    max_ms: u64,
) -> Row {
    Row {
        name,
        script,
        timeout_ms,
        limit,
        expect,
        max_ms,
    }
}

fn sh(
    script: &str,
    timeout: Duration,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, RunError> {
    run(
        "sh",
        &["-c".to_string(), script.to_string()],
        timeout,
        limit,
        cancel,
    )
}

#[test]
fn bounded_run_state_table() {
    // `{helper}` starts a background helper that touches its marker after
    // ~1 s unless it was killed; `{detached}` does the same with stdout
    // closed.
    let rows = [
        row(
            "stdout-then-exit",
            "echo out; echo secret-stderr >&2",
            5_000,
            1024,
            Expect::Ok("out\n"),
            2_000,
        ),
        row(
            "exact-limit",
            "printf 0123456789abcdef",
            5_000,
            16,
            Expect::Ok("0123456789abcdef"),
            2_000,
        ),
        row(
            "limit-plus-one",
            "printf 0123456789abcdefg",
            5_000,
            16,
            Expect::Err(RunError::OutputTooLarge),
            2_000,
        ),
        row(
            "flood",
            "yes x | head -c 100000",
            5_000,
            16,
            Expect::Err(RunError::OutputTooLarge),
            2_000,
        ),
        row(
            "flood-then-hang",
            "yes x | head -c 100000; sleep 30",
            5_000,
            16,
            Expect::Err(RunError::OutputTooLarge),
            2_000,
        ),
        row(
            "nonzero-exit",
            "echo out; exit 3",
            5_000,
            1024,
            Expect::Err(RunError::ExitStatus),
            2_000,
        ),
        row(
            "exit-by-signal",
            "echo out; kill -9 $$",
            5_000,
            1024,
            Expect::Err(RunError::ExitStatus),
            2_000,
        ),
        row(
            "hung",
            "sleep 30",
            200,
            1024,
            Expect::Err(RunError::Timeout),
            1_500,
        ),
        // The program ignores SIGTERM: only the group SIGKILL ends it.
        row(
            "hung-ignoring-sigterm",
            "trap '' TERM; sleep 30",
            200,
            1024,
            Expect::Err(RunError::Timeout),
            1_500,
        ),
        // X before E: the program exited, a helper still holds stdout.
        row(
            "exit-0-before-eof",
            "{helper} exit 0",
            200,
            1024,
            Expect::Err(RunError::Timeout),
            1_500,
        ),
        row(
            "exit-7-before-eof",
            "{helper} exit 7",
            200,
            1024,
            Expect::Err(RunError::Timeout),
            1_500,
        ),
        row(
            "helper-holds-stdout-hung",
            "{helper} sleep 30",
            200,
            1024,
            Expect::Err(RunError::Timeout),
            1_500,
        ),
        // E before X: stdout closes, the program cleans up and exits 0.
        row(
            "eof-then-cleanup-exit-0",
            "echo out; exec >&-; sleep 0.2; exit 0",
            5_000,
            1024,
            Expect::Ok("out\n"),
            3_000,
        ),
        row(
            "eof-then-nonzero-exit",
            "echo out; exec >&-; sleep 0.1; exit 4",
            5_000,
            1024,
            Expect::Err(RunError::ExitStatus),
            3_000,
        ),
        // E, then the program keeps running past the deadline.
        row(
            "eof-then-hang",
            "echo out; exec >&-; sleep 30",
            300,
            1024,
            Expect::Err(RunError::Timeout),
            1_800,
        ),
        // A helper that let go of stdout: the output stands, the helper dies.
        row(
            "detached-helper",
            "{detached} echo done",
            5_000,
            1024,
            Expect::Ok("done\n"),
            2_000,
        ),
    ];
    let mut markers = Vec::new();
    for row in &rows {
        let path = marker(row.name);
        let script = row
            .script
            .replace(
                "{helper}",
                &format!("(sleep 1 && touch {}) &", path.display()),
            )
            .replace(
                "{detached}",
                &format!("(sleep 1 && touch {}) >/dev/null &", path.display()),
            );
        let started = Instant::now();
        let result = sh(
            &script,
            Duration::from_millis(row.timeout_ms),
            row.limit,
            None,
        );
        let elapsed = started.elapsed();
        match (&row.expect, result) {
            (Expect::Ok(text), Ok(bytes)) => {
                assert_eq!(String::from_utf8_lossy(&bytes), *text, "{}", row.name)
            }
            (Expect::Err(want), Err(got)) => assert_eq!(*want, got, "{}", row.name),
            (want, got) => panic!("{}: wanted {want:?}, got {got:?}", row.name),
        }
        assert!(
            elapsed < Duration::from_millis(row.max_ms),
            "{} took {elapsed:?}",
            row.name
        );
        markers.push((row.name, path));
    }
    // Every helper would have touched its marker ~1 s in had it survived.
    std::thread::sleep(Duration::from_millis(1_500));
    for (name, path) in markers {
        let survived = path.exists();
        let _ = std::fs::remove_file(&path);
        assert!(!survived, "{name}: a helper outlived the run");
    }
}

#[test]
fn a_program_that_cannot_start_is_a_spawn_error() {
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

/// The direct child leaves its process group (the deadline's `killpg` cannot
/// reach it) and sleeps past the deadline. The call must settle by the
/// deadline plus the reap grace, and the child itself must be killed (it is
/// still ours), not left to run on.
#[test]
fn a_child_outside_its_group_is_killed_and_settles_by_the_deadline() {
    // The escaping child is a python3 one-liner (every CI runner has it).
    std::process::Command::new("python3")
        .arg("--version")
        .output()
        .expect("python3 is required for this test");
    let anchor = Anchor::start();
    let path = marker("escaped-direct");
    let script = format!(
        "{ESCAPE}\nopen({:?}, 'w').close()",
        path.display().to_string()
    );
    let started = Instant::now();
    let result = run(
        "python3",
        &["-c".to_string(), script, anchor.pgid(), "2".to_string()],
        Duration::from_millis(300),
        1024,
        None,
    );
    let elapsed = started.elapsed();
    assert_eq!(result, Err(RunError::Timeout));
    assert!(
        elapsed < Duration::from_millis(300) + REAP_GRACE + Duration::from_millis(1_200),
        "settled in {elapsed:?}"
    );
    std::thread::sleep(Duration::from_millis(2_500));
    let survived = path.exists();
    let _ = std::fs::remove_file(&path);
    assert!(
        !survived,
        "the child outside its group outlived the deadline"
    );
}

/// stdout closed but the program keeps running (the table's "E, but the
/// program still runs"): a cancel must still end the run at the next poll,
/// not at the deadline.
#[test]
fn cancel_after_stdout_closed_kills_at_once() {
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let result = std::thread::scope(|scope| {
        let handle = scope.spawn(|| {
            sh(
                "exec 1>&-; sleep 30",
                Duration::from_secs(30),
                1024,
                Some(&cancel),
            )
        });
        std::thread::sleep(Duration::from_millis(300));
        cancel.store(true, Ordering::SeqCst);
        handle.join().expect("run thread")
    });
    assert_eq!(result, Err(RunError::Cancelled));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

/// The caller cancels: the group dies at the next poll, whatever the deadline.
#[test]
fn cancel_kills_the_group_at_once() {
    let path = marker("cancel");
    let cancel = AtomicBool::new(false);
    let script = format!("(sleep 1 && touch {}) & sleep 30", path.display());
    let started = Instant::now();
    let result = std::thread::scope(|scope| {
        let handle = scope.spawn(|| sh(&script, Duration::from_secs(30), 1024, Some(&cancel)));
        std::thread::sleep(Duration::from_millis(200));
        cancel.store(true, Ordering::SeqCst);
        handle.join().expect("run thread")
    });
    assert_eq!(result, Err(RunError::Cancelled));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    std::thread::sleep(Duration::from_millis(1_500));
    let survived = path.exists();
    let _ = std::fs::remove_file(&path);
    assert!(!survived, "the helper outlived a cancelled run");
}

/// `run_until_any_status` keeps stdout on a nonzero exit (how
/// `systemctl is-system-running` reports `degraded`), but every other failure
/// stays an error.
#[test]
fn any_status_returns_stdout_on_a_nonzero_exit() {
    let args = |script: &str| vec!["-c".to_string(), script.to_string()];
    let deadline = || Instant::now() + Duration::from_secs(5);
    assert_eq!(
        run_until_any_status("sh", &args("echo degraded; exit 1"), deadline(), 1024, None),
        Ok(b"degraded\n".to_vec())
    );
    assert_eq!(
        run_until_any_status("sh", &args("echo running"), deadline(), 1024, None),
        Ok(b"running\n".to_vec())
    );
    assert_eq!(
        run_until_any_status(
            "sh",
            &args("yes x | head -c 4096; exit 1"),
            deadline(),
            16,
            None
        ),
        Err(RunError::OutputTooLarge)
    );
    assert_eq!(
        run_until_any_status("wsmp-no-such-program", &[], deadline(), 16, None),
        Err(RunError::Spawn)
    );
}
