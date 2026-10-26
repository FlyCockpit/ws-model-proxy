//! Windows runtime units through the real `wsmp __runtime-host`: a unit runs
//! its command and everything that command starts, outlives nothing it should
//! not, and a stop ends the whole tree.

#![cfg(windows)]

use std::path::Path;
use std::time::{Duration, Instant};

use wsmp::protocol::runtime_spec::CommandShell;
use wsmp::runtimes::executor::Deadline;
use wsmp::runtimes::executor::windows::{
    HostLaunch, exited_cleanly, identity, read_record, running, start, stop, stop_slice,
    tasks_alive,
};

const OWNER: &str = "abcdefghijklmnopqrstuvwx";
const EXE: &str = env!("CARGO_BIN_EXE_wsmp");

fn launch(dir: &Path, unit: &str, script: &str) -> String {
    start(
        dir,
        &HostLaunch {
            exe: Path::new(EXE),
            owner: OWNER,
            unit,
            slice: "wsmp_test_r0.slice",
            shell: CommandShell::Powershell,
            script,
            env: &[("WSMP_TEST_VALUE".to_string(), "from-env".to_string())],
        },
    )
    .expect("the host starts")
}

fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn process_exists(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
}

/// A file a PowerShell script wrote (`Set-Content` may add a BOM).
fn read_text(file: &Path) -> Option<String> {
    std::fs::read_to_string(file)
        .ok()
        .map(|text| text.trim().trim_start_matches('\u{feff}').to_string())
}

/// A long-running start with a helper the command started detached (a
/// console of its own, which Ctrl+Break cannot reach): the helper keeps the
/// unit alive, and a stop ends the job, helper included, after the grace.
#[test]
fn a_stop_ends_the_command_and_what_it_started() {
    let dir = tempfile::tempdir().expect("dir");
    let hosts = dir.path();
    let helper_pid = hosts.join("helper.pid");
    let env_seen = hosts.join("env.txt");
    let script = format!(
        "$env:WSMP_TEST_VALUE | Set-Content -LiteralPath '{}'\n\
         $p = Start-Process -PassThru -WindowStyle Hidden ping -ArgumentList '-n','120','127.0.0.1'\n\
         $p.Id | Set-Content -LiteralPath '{}'\n\
         ping -n 120 127.0.0.1 | Out-Null",
        env_seen.display(),
        helper_pid.display()
    );
    let invocation = launch(hosts, "wsmp-test-r0", &script);
    wait_for("the helper", Duration::from_secs(30), || {
        read_text(&helper_pid).is_some_and(|pid| pid.parse::<u32>().is_ok())
    });
    let helper: u32 = read_text(&helper_pid)
        .and_then(|pid| pid.parse().ok())
        .expect("helper pid");
    assert!(process_exists(helper));
    assert_eq!(read_text(&env_seen).as_deref(), Some("from-env"));
    assert!(running(hosts, "wsmp-test-r0").expect("running"));
    assert_eq!(
        identity(hosts, "wsmp-test-r0", OWNER).expect("identity"),
        Some(invocation.clone())
    );
    assert!(tasks_alive(hosts, "wsmp-test-r0").expect("unit"));
    assert!(tasks_alive(hosts, "wsmp_test_r0.slice").expect("slice"));
    assert!(
        identity(hosts, "wsmp-test-r0", "zyxwvutsrqponmlkjihgfedc").is_err(),
        "someone else's unit"
    );

    let started = Instant::now();
    stop_slice(
        hosts,
        "wsmp_test_r0.slice",
        Duration::from_secs(2),
        Deadline::new(Duration::from_secs(60)),
    )
    .expect("the slice stops");
    assert!(
        started.elapsed() >= Duration::from_secs(2),
        "the helper kept the job alive until the grace ended"
    );
    assert!(!tasks_alive(hosts, "wsmp_test_r0.slice").expect("slice"));
    wait_for("the helper to end", Duration::from_secs(10), || {
        !process_exists(helper)
    });
    // The host ended with its job: a running record without its host is gone, not exited.
    assert_eq!(
        identity(hosts, "wsmp-test-r0", OWNER).expect("identity"),
        None
    );
    stop(
        hosts,
        "wsmp-test-r0",
        &invocation,
        Duration::ZERO,
        Deadline::new(Duration::from_secs(10)),
    )
    .expect("forgotten");
    assert!(
        read_record(hosts, "wsmp-test-r0")
            .expect("record")
            .is_none()
    );
}

/// Ctrl+Break ends a command that takes it, well before the grace.
#[test]
fn a_stop_breaks_the_command_first() {
    let dir = tempfile::tempdir().expect("dir");
    let invocation = launch(
        dir.path(),
        "wsmp-test-r1",
        "ping -n 120 127.0.0.1 | Out-Null",
    );
    wait_for("the host", Duration::from_secs(30), || {
        running(dir.path(), "wsmp-test-r1").expect("running")
    });
    let started = Instant::now();
    stop(
        dir.path(),
        "wsmp-test-r1",
        &invocation,
        Duration::from_secs(20),
        Deadline::new(Duration::from_secs(60)),
    )
    .expect("the stop");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "Ctrl+Break ended it before the grace: {:?}",
        started.elapsed()
    );
    assert_eq!(
        identity(dir.path(), "wsmp-test-r1", OWNER).expect("identity"),
        None
    );
}

/// Exit 0 leaves the unit there, with nothing running, until a stop; a
/// failure takes the unit with it.
#[test]
fn a_clean_exit_stays_and_a_failure_goes() {
    let dir = tempfile::tempdir().expect("dir");
    let invocation = launch(dir.path(), "wsmp-test-r2-prepare", "Write-Output done");
    wait_for("the clean exit", Duration::from_secs(30), || {
        exited_cleanly(dir.path(), "wsmp-test-r2-prepare").expect("record")
            && !tasks_alive(dir.path(), "wsmp-test-r2-prepare").expect("unit")
    });
    assert_eq!(
        identity(dir.path(), "wsmp-test-r2-prepare", OWNER).expect("identity"),
        Some(invocation.clone())
    );
    stop(
        dir.path(),
        "wsmp-test-r2-prepare",
        &invocation,
        Duration::from_secs(1),
        Deadline::new(Duration::from_secs(10)),
    )
    .expect("the stop");
    assert_eq!(
        identity(dir.path(), "wsmp-test-r2-prepare", OWNER).expect("identity"),
        None
    );

    launch(dir.path(), "wsmp-test-r3", "cmd /c exit 7");
    wait_for("the failed unit to go", Duration::from_secs(30), || {
        read_record(dir.path(), "wsmp-test-r3")
            .expect("record")
            .is_none()
    });
    assert!(!tasks_alive(dir.path(), "wsmp-test-r3").expect("unit"));
}

/// A second launch of a running unit is refused; a stop request for another
/// invocation is ignored.
#[test]
fn a_running_unit_is_launched_once() {
    let dir = tempfile::tempdir().expect("dir");
    let invocation = launch(
        dir.path(),
        "wsmp-test-r4",
        "ping -n 120 127.0.0.1 | Out-Null",
    );
    wait_for("the host", Duration::from_secs(30), || {
        running(dir.path(), "wsmp-test-r4").expect("running")
    });
    let again = start(
        dir.path(),
        &HostLaunch {
            exe: Path::new(EXE),
            owner: OWNER,
            unit: "wsmp-test-r4",
            slice: "wsmp_test_r0.slice",
            shell: CommandShell::Powershell,
            script: "exit 0",
            env: &[],
        },
    );
    assert!(again.is_err(), "a second host for a running unit");
    let other = "0".repeat(32);
    assert!(
        stop(
            dir.path(),
            "wsmp-test-r4",
            &other,
            Duration::ZERO,
            Deadline::new(Duration::from_secs(2)),
        )
        .is_err(),
        "a stop for another invocation does not end this one"
    );
    assert!(running(dir.path(), "wsmp-test-r4").expect("running"));
    stop(
        dir.path(),
        "wsmp-test-r4",
        &invocation,
        Duration::from_secs(5),
        Deadline::new(Duration::from_secs(30)),
    )
    .expect("the stop");
}

/// A unit outlives the process that launched it (a daemon restart): the
/// launch runs in a child test process that exits right after.
#[test]
fn a_unit_outlives_its_launcher() {
    if let Some(dir) = std::env::var_os("WSMP_RUNTIME_HOST_LAUNCHER") {
        launch(
            Path::new(&dir),
            "wsmp-test-r5",
            "ping -n 120 127.0.0.1 | Out-Null",
        );
        return;
    }
    let dir = tempfile::tempdir().expect("dir");
    let status = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", "a_unit_outlives_its_launcher"])
        .env("WSMP_RUNTIME_HOST_LAUNCHER", dir.path())
        .stdout(std::process::Stdio::null())
        .status()
        .expect("the launcher runs");
    assert!(status.success(), "{status}");
    wait_for("the host", Duration::from_secs(30), || {
        running(dir.path(), "wsmp-test-r5").expect("running")
    });
    std::thread::sleep(Duration::from_secs(1));
    assert!(running(dir.path(), "wsmp-test-r5").expect("running"));
    let invocation = identity(dir.path(), "wsmp-test-r5", OWNER)
        .expect("identity")
        .expect("the unit is there");
    stop(
        dir.path(),
        "wsmp-test-r5",
        &invocation,
        Duration::from_secs(5),
        Deadline::new(Duration::from_secs(30)),
    )
    .expect("the stop");
}

/// What a runtime runs counts as started by wsmp even with no relay running
/// (runtimes outlive it) and without `WSMP_JOB`: it cannot raise trust.
#[test]
fn a_runtime_cannot_raise_trust_without_a_relay() {
    let dir = tempfile::tempdir().expect("dir");
    let err = dir.path().join("trust.err");
    let code = dir.path().join("trust.code");
    let script = format!(
        "Remove-Item Env:WSMP_JOB -ErrorAction SilentlyContinue\n\
         $said = & '{EXE}' trust full 2>&1 | Out-String\n\
         $code = $LASTEXITCODE\n\
         $said | Set-Content -Encoding UTF8 -LiteralPath '{}'\n\
         $code | Set-Content -LiteralPath '{}'",
        err.display(),
        code.display()
    );
    let invocation = launch(dir.path(), "wsmp-test-r6", &script);
    wait_for("the attempt", Duration::from_secs(30), || {
        read_text(&code).is_some_and(|code| !code.is_empty())
    });
    let refusal = read_text(&err).expect("stderr");
    assert!(
        refusal.contains("wsmp started"),
        "refused as started by wsmp: {refusal}"
    );
    assert_ne!(read_text(&code).as_deref(), Some("0"));
    // The same command from outside a runtime is not refused for that (it
    // needs a person at a terminal instead).
    let outside = std::process::Command::new(EXE)
        .args(["trust", "full"])
        .env_remove("WSMP_JOB")
        .env("WSMP_CONFIG", dir.path().join("config.json"))
        .env("WSMP_STATE_DIR", dir.path())
        .stdin(std::process::Stdio::null())
        .output()
        .expect("wsmp runs");
    let said = String::from_utf8_lossy(&outside.stderr);
    assert!(!said.contains("wsmp started"), "{said}");
    let _ = stop(
        dir.path(),
        "wsmp-test-r6",
        &invocation,
        Duration::ZERO,
        Deadline::new(Duration::from_secs(10)),
    );
}
