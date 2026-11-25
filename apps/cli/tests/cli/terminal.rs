//! Terminal approvals, the terminal identity and the Windows console host.

use crate::cli;
use predicates::prelude::*;
use serde_json::Value;
use std::fs;

#[test]
fn approve_uses_the_state_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let decoy = tmp.path().join("decoy");
    fs::create_dir_all(&state).unwrap();
    fs::create_dir_all(&decoy).unwrap();
    fs::write(
        state.join("terminal-approval-pending.json"),
        "{\n  \"entries\": {\n    \"QSOWJSS6\": \"AQ\"\n  }\n}\n",
    )
    .unwrap();
    fs::write(
        decoy.join("terminal-approval-pending.json"),
        "{\n  \"entries\": {\n    \"QSOWJSS6\": \"AQ\"\n  }\n}\n",
    )
    .unwrap();
    cli(&config, &state)
        .args(["terminal", "--json", "approve", "QSOWJSS6"])
        .assert()
        .success();
    assert!(state.join("terminal-approvals.json").is_file());
    assert!(!decoy.join("terminal-approvals.json").exists());
}

#[test]
fn terminal_approve_unknown_code_exits_3_not_found() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["terminal", "approve", "QSOWJSS6"])
        .assert()
        .failure()
        .code(3)
        .stderr(predicate::str::contains(
            "terminal approval `QSOWJSS6` not found",
        ));
}

#[test]
fn terminal_fingerprint_creates_the_identity_once_in_the_state_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let first = cli(&config, &state)
        .args(["terminal", "fingerprint"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let fingerprint = String::from_utf8(first).unwrap().trim().to_string();
    let groups: Vec<&str> = fingerprint.split(' ').collect();
    assert_eq!(groups.len(), 8, "{fingerprint}");
    assert!(groups.iter().all(|group| {
        group.len() == 4
            && group
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
    }));
    let identity = state.join("terminal-identity.json");
    assert!(identity.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&identity).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let json = cli(&config, &state)
        .args(["terminal", "--json", "fingerprint"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let value: Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(value["fingerprint"], fingerprint);
    assert_eq!(value["publicKey"].as_str().unwrap().len(), 87);
}

/// The real `wsmp __conpty-host` (unit tests stand the test binary in for
/// it): it runs the shell on a pseudoconsole, writes the console's output to
/// stdout, applies framed input and exits with the shell's code.
#[cfg(windows)]
#[test]
fn the_conpty_host_runs_a_shell_on_a_console_and_exits_with_its_code() {
    use std::io::{Read, Write};
    use std::process::Stdio;

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_wsmp"))
        .args([
            "__conpty-host",
            "--cols",
            "80",
            "--rows",
            "24",
            "--",
            "cmd.exe",
            "/D",
            "/Q",
            "/K",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("helper");
    let mut stdin = child.stdin.take().expect("stdin");
    // Kind 0 (input), a little-endian length, the bytes.
    let mut frame = |bytes: &[u8]| {
        let mut framed = vec![0_u8];
        framed.extend(u32::try_from(bytes.len()).expect("len").to_le_bytes());
        framed.extend(bytes);
        stdin.write_all(&framed).expect("write");
    };
    frame(b"echo conpty-host-%OS%\r");
    frame(b"exit 5\r");
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_end(&mut output)
        .expect("read");
    let status = child.wait().expect("wait");
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("conpty-host-Windows_NT"), "{text:?}");
    assert_eq!(status.code(), Some(5), "{text:?}");
}
