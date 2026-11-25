//! Helpers the terminal and exec tests share.

use std::sync::mpsc::{self, SyncSender};
#[cfg(unix)]
use std::time::{Duration, Instant};

use super::OutboundFrame;
use crate::config::Config;
use crate::protocol::NodeFrame;
use crate::relay_bus::FromWorker;
use crate::startup::TerminalStartup;
use crate::terminal_crypto::CliTerminalKey;

/// A command lifetime longer than any test.
pub(super) const TEST_TIMEOUT_MS: u64 = 600_000;

pub(super) fn channel() -> (SyncSender<FromWorker>, mpsc::Receiver<FromWorker>) {
    mpsc::sync_channel(64)
}

pub(super) fn enabled_startup(approval: bool) -> TerminalStartup {
    let config = Config {
        allow_human_terminal: true,
        trust: Some(crate::protocol::frames::TrustValue::Full),
        require_terminal_approval: approval,
        ..Config::default()
    };
    TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &config)
}

pub(super) fn controls(frames: &[OutboundFrame]) -> Vec<&NodeFrame> {
    frames
        .iter()
        .filter_map(|frame| match frame {
            OutboundFrame::Control(message) => Some(message),
            OutboundFrame::Binary(..) => None,
        })
        .collect()
}

#[cfg(unix)]
pub(super) fn process_exists(pid: u32) -> bool {
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw), None).is_ok()
}

#[cfg(not(unix))]
pub(super) fn process_exists(pid: u32) -> bool {
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", "tasklist", "/FI", &format!("PID eq {pid}")]);
    command
        .output()
        .ok()
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
}

/// Alive and not a zombie.
#[cfg(target_os = "linux")]
pub(super) fn process_running(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            let rest = &stat[stat.rfind(')')? + 1..];
            rest.split_whitespace().next().map(|state| state != "Z")
        })
        .unwrap_or(false)
}

/// Dead or a zombie: the process can no longer act. A zombie is already
/// dead and only waits for its parent to reap it, and `kill(pid, 0)` still
/// succeeds for one, so a bare existence check would spin until its
/// deadline on a loaded macOS runner. Without `/proc` the state comes from
/// `ps`; if that is unavailable the process is assumed alive (fail closed).
#[cfg(unix)]
pub(super) fn process_dead(pid: u32) -> bool {
    if !process_exists(pid) {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        !process_running(pid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::process::Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .is_some_and(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim_start()
                    .starts_with('Z')
            })
    }
}

/// Dead or a zombie. Killed orphans are reaped by init after a moment.
#[cfg(unix)]
pub(super) fn process_gone(pid: u32) -> bool {
    process_dead(pid)
}

/// The zombie case that made the macOS confirm-child wait spin: a child
/// that exited but was not reaped still satisfies `kill(pid, 0)`, so a bare
/// existence check cannot tell it apart from a live one. Only a state
/// check can, and this pins that `process_dead` does so without reaping.
#[test]
#[cfg(unix)]
fn an_unreaped_exited_child_reads_as_dead_but_still_exists() {
    let dir = tempfile::tempdir().expect("tempdir");
    let marker = dir.path().join("ran");
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", &format!("touch '{}'; exit 0", marker.display())])
        .spawn()
        .expect("spawn a short-lived child");
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !process_dead(pid) {
        assert!(
            Instant::now() < deadline,
            "the exited child was never seen as dead"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // Never reaped here, so it is still a zombie: a bare existence check
    // would call it alive, which is what wedged the confirm-child wait.
    assert!(process_exists(pid), "the child was reaped, not a zombie");
    assert!(marker.exists());
    let _ = child.wait();
}
