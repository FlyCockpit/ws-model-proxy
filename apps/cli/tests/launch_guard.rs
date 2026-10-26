//! The launch guard (`wsmp __launch-guard`): a guarded command ends with the process that
//! started it, and a daemon's `settle` waits for that.
#![cfg(unix)]

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HELPER_ENV: &str = "WSMP_LAUNCH_GUARD_TEST_PARENT";
const LEAVER_ENV: &str = "WSMP_LAUNCH_GUARD_TEST_LEAVER";

fn guard(parent: u32, lock: &Path, script: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wsmp"));
    command
        .arg("__launch-guard")
        .arg("--parent")
        .arg(parent.to_string())
        .arg("--lock")
        .arg(lock)
        .arg("--")
        .args(["/bin/sh", "-c", script])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn lock_held(lock: &Path) -> bool {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock);
    let Ok(file) = file else {
        return false;
    };
    nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock).is_err()
}

/// Not a test of its own: the parent the guard of `guarded_command_ends_with_its_parent`
/// outlives. It starts the guard outside any group of its own, as `bounded_run` does, then
/// waits to be killed.
#[test]
fn launch_guard_parent_helper() {
    let Some(spec) = std::env::var_os(HELPER_ENV) else {
        return;
    };
    let spec = PathBuf::from(spec);
    let lock = spec.join("relay-launchers.lock");
    let marker = spec.join("launched");
    let mut child = guard(
        std::process::id(),
        &lock,
        &format!("sleep 1; touch '{}'", marker.display()),
    )
    .stdout(Stdio::null())
    .spawn()
    .expect("guard starts");
    let _ = child.wait();
    // Stay alive until the test kills this process.
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn guarded_command_ends_with_its_parent() {
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::lock_path(dir.path());
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "launch_guard_parent_helper", "--nocapture"])
        .env(HELPER_ENV, dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !lock_held(&lock) {
        assert!(Instant::now() < until, "the guard never took its lock");
        std::thread::sleep(Duration::from_millis(10));
    }
    // SIGKILL: nothing of the parent runs on the way out.
    parent.kill().unwrap();
    parent.wait().unwrap();
    wsmp::launch_guard::settle(dir.path(), Duration::from_secs(5))
        .expect("the guard ends once its parent is gone");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        !dir.path().join("launched").exists(),
        "the command ran on after its parent died"
    );
}

#[test]
fn guard_passes_output_and_exit_status_through() {
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::lock_path(dir.path());
    let output = guard(std::process::id(), &lock, "printf ran; exit 3")
        .output()
        .unwrap();
    assert_eq!(output.stdout, b"ran");
    assert_eq!(output.status.code(), Some(3));
}

#[test]
fn guard_runs_nothing_for_a_parent_that_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::lock_path(dir.path());
    let marker = dir.path().join("launched");
    let script = format!("touch '{}'", marker.display());
    // Not this test's process id: the guard's parent is gone.
    let stale = std::process::id().wrapping_add(1);
    let status = guard(stale, &lock, &script).status().unwrap();
    assert!(!status.success());
    // Leading a process group: it cannot start a session of its own, so it is refused.
    let status = guard(std::process::id(), &lock, &script)
        .process_group(0)
        .status()
        .unwrap();
    assert!(!status.success());
    assert!(!marker.exists());
}

#[test]
fn guard_ends_what_the_command_left_behind_before_its_lock_goes() {
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::lock_path(dir.path());
    let marker = dir.path().join("launched");
    // The shell exits at once; the helper it forked would launch a second later.
    let script = format!(
        "(sleep 1; touch '{}') </dev/null >/dev/null 2>&1 & exit 0",
        marker.display()
    );
    let status = guard(std::process::id(), &lock, &script)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!marker.exists(), "a helper outlived the guard");
}

/// Whether this process started with SIGINT ignored (a shell's background job: `cmd &`). The
/// command would inherit that, and a shell cannot undo it. Linux reads `/proc`; macOS has none,
/// so `ps` reports the mask there. A mask that cannot be read counts as ignored: the test then
/// has nothing it can rely on.
fn interrupts_ignored() -> bool {
    let mask = match std::fs::read_to_string("/proc/self/status") {
        Ok(status) => status
            .lines()
            .find_map(|line| line.strip_prefix("SigIgn:"))
            .map(|mask| mask.trim().to_owned()),
        Err(_) => Command::new("/bin/ps")
            .args(["-o", "sigignore=", "-p", &std::process::id().to_string()])
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned()),
    };
    mask.and_then(|mask| u64::from_str_radix(&mask, 16).ok())
        .is_none_or(|mask| mask & (1 << (nix::libc::SIGINT - 1)) != 0)
}

#[test]
fn a_terminal_interrupt_ends_the_command_not_the_guard() {
    // Nothing to test when the command could not take an interrupt anyway.
    if interrupts_ignored() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::lock_path(dir.path());
    let running = dir.path().join("running");
    let mut child = guard(
        std::process::id(),
        &lock,
        &format!("touch '{}'; sleep 5", running.display()),
    )
    .stdout(Stdio::null())
    .spawn()
    .unwrap();
    let group = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap());
    let until = Instant::now() + Duration::from_secs(10);
    while !running.exists() {
        assert!(Instant::now() < until, "the command never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    // What a terminal's Ctrl-C does: SIGINT to the whole foreground group (the guard's own, in
    // the session it started).
    std::thread::sleep(Duration::from_millis(50));
    nix::sys::signal::killpg(group, nix::sys::signal::SIGINT).unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(128 + 2), "{status:?}");
}

/// Not a test of its own: a helper that moves to a process group of its own (as job control or
/// a subprocess library does), then would launch a second later.
#[test]
fn launch_guard_group_leaver_helper() {
    let Some(marker) = std::env::var_os(LEAVER_ENV) else {
        return;
    };
    nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0)).unwrap();
    std::thread::sleep(Duration::from_secs(1));
    std::fs::write(marker, b"").unwrap();
}

/// A script that starts [`launch_guard_group_leaver_helper`] (in `tests`, this test binary) in
/// the background, then runs `rest`.
fn leaver_script(tests: &Path, rest: &str) -> String {
    format!(
        "'{}' --exact launch_guard_group_leaver_helper --nocapture </dev/null >/dev/null 2>&1 & {rest}",
        tests.display()
    )
}

#[test]
fn guard_ends_what_left_its_group_before_its_lock_goes() {
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::lock_path(dir.path());
    let marker = dir.path().join("launched");
    let status = guard(
        std::process::id(),
        &lock,
        &leaver_script(&std::env::current_exe().unwrap(), "sleep 0.3; exit 0"),
    )
    .env(LEAVER_ENV, &marker)
    .stdout(Stdio::null())
    .status()
    .unwrap();
    assert!(status.success());
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        !marker.exists(),
        "a helper in another group outlived the guard"
    );
}

#[test]
fn a_guard_killed_at_its_deadline_takes_its_session_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::guard_lock_arg(dir.path()).unwrap();
    let marker = dir.path().join("launched");
    let (exe, args) = wsmp::launch_guard::wrap(
        env!("CARGO_BIN_EXE_wsmp"),
        std::process::id(),
        &lock,
        "/bin/sh",
        &[
            "-c".to_owned(),
            leaver_script(&std::env::current_exe().unwrap(), "sleep 10"),
        ],
    );
    let env = [(LEAVER_ENV.to_owned(), marker.to_string_lossy().into_owned())];
    // bounded_run sends the guard SIGTERM at the deadline: it ends its session before it exits.
    let outcome = wsmp::bounded_run::run_until_env(
        &exe,
        &args,
        Instant::now() + Duration::from_millis(300),
        64,
        None,
        &env,
    );
    assert_eq!(outcome, Err(wsmp::bounded_run::RunError::Timeout));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        !marker.exists(),
        "a helper outlived the guard bounded_run killed"
    );
}

#[test]
fn sigterm_ends_the_guards_session_before_the_guard() {
    let dir = tempfile::tempdir().unwrap();
    let lock = wsmp::launch_guard::lock_path(dir.path());
    let marker = dir.path().join("launched");
    let mut child = guard(
        std::process::id(),
        &lock,
        &leaver_script(&std::env::current_exe().unwrap(), "sleep 10"),
    )
    .env(LEAVER_ENV, &marker)
    .stdout(Stdio::null())
    .spawn()
    .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !lock_held(&lock) {
        assert!(Instant::now() < until, "the guard never took its lock");
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(200));
    let pid = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap());
    nix::sys::signal::kill(pid, nix::sys::signal::SIGTERM).unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(128 + 15), "{status:?}");
    assert!(!lock_held(&lock));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!marker.exists(), "a helper outlived the guard's SIGTERM");
}
