//! Trust levels and the guard on commands wsmp itself started.

use crate::{cli, write_config};
use predicates::prelude::*;
use serde_json::{Value, json};
use std::fs;
#[cfg(target_os = "linux")]
use std::io::Write;

#[test]
fn trust_lowers_without_a_relay_and_refuses_to_raise_without_a_terminal() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(&config, json!({ "version": 3, "trust": "full" }));
    cli(&config, &state)
        .args(["trust", "relay"])
        .assert()
        .success()
        .stdout(predicate::str::contains("now relay only"));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["trust"], "relay");
    assert!(state.join("frozen-definitions.json").exists());
    // No terminal: refused, and the file still says relay.
    cli(&config, &state)
        .args(["trust", "full"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("terminal"));
    // From a process wsmp started: refused before anything else.
    cli(&config, &state)
        .args(["trust", "full"])
        .env("WSMP_JOB", "1")
        .assert()
        .failure()
        .stderr(predicate::str::contains("cannot run from a command"));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["trust"], "relay");
}

/// A command, job or terminal wsmp started cannot change wsmp's own
/// settings, credential, service or terminal approvals; reads still work.
#[test]
fn commands_wsmp_started_cannot_change_wsmp_itself() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 3,
            "serverUrl": "https://wsmp.example.com",
            "cliSlug": "spark-1",
            "trust": "full"
        }),
    );
    fs::create_dir_all(&state).unwrap();
    fs::write(
        state.join("node-credential.json"),
        json!({ "nodeId": "node-1", "slug": "spark-1", "server": "https://wsmp.example.com", "credential": "c".repeat(48) })
            .to_string(),
    )
    .unwrap();
    let before = fs::read(&config).unwrap();
    let home = tmp.path().display().to_string();
    let refused: &[&[&str]] = &[
        &["config", "init"],
        &["config", "set-server", "https://evil.example.com"],
        &["config", "set-slug", "other"],
        &["config", "set-human-terminal", "on"],
        &["config", "set-runtime-hosts", "10.0.0.5"],
        &["config", "set-file-roots", "/"],
        &["config", "clear-file-roots"],
        &["config", "set-file-tools", "on"],
        &["config", "set-terminal-approval", "off"],
        &["config", "set-max-terminals", "32"],
        &["config", "set-file-tools-as-root", "on"],
        &["service", "install"],
        &["service", "uninstall"],
        &["service", "restart"],
        &["logout"],
        &["terminal", "approve", "ABCD-EFGH"],
        &["run"],
        // File recovery exists on Unix only (elsewhere it is refused as unsupported first).
        #[cfg(unix)]
        &["recover", "--apply"],
    ];
    for args in refused {
        cli(&config, &state)
            .args(*args)
            .env("WSMP_JOB", "1")
            .env("HOME", &home)
            .assert()
            .failure()
            .stderr(predicate::str::contains(
                "cannot run from a command, job or terminal wsmp started",
            ));
    }
    assert_eq!(fs::read(&config).unwrap(), before, "the config changed");
    assert!(state.join("node-credential.json").exists());
    // Reads stay allowed.
    let allowed: &[&[&str]] = &[
        &["config", "show"],
        &["config", "path"],
        &["terminal", "approvals", "list"],
        &["runtime", "list"],
        // File recovery exists on Unix only (elsewhere `wsmp recover` refuses as unsupported).
        #[cfg(unix)]
        &["recover"],
        &["trust"],
        // Lowering works from anywhere.
        &["trust", "relay"],
    ];
    for args in allowed {
        cli(&config, &state)
            .args(*args)
            .env("WSMP_JOB", "1")
            .env("HOME", &home)
            .assert()
            .success();
    }
    // Revoking narrows access too: not refused (the code is just unknown).
    cli(&config, &state)
        .args(["terminal", "approvals", "revoke", "ABCD-EFGH"])
        .env("WSMP_JOB", "1")
        .assert()
        .failure()
        .stderr(predicate::str::contains("cannot run from").not());
}

/// Real system (Linux with a systemd user manager; run with `--ignored`):
/// `wsmp trust full` works from a person's ordinary terminal, whose
/// ancestors include the unreadable user manager or sshd, and is refused
/// from a `systemd-run --user --unit` service that dropped `WSMP_JOB`.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "needs a systemd user manager and `script`"]
fn trust_full_from_a_terminal_but_not_from_a_user_service() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({ "version": 3, "serverUrl": "https://wsmp.example.com", "trust": "full" }),
    );
    cli(&config, &state)
        .args(["trust", "relay"])
        .assert()
        .success();
    let wsmp = assert_cmd::cargo::cargo_bin("wsmp");
    // A user service, with the marker dropped: refused before any prompt.
    let unit = format!("provtest-{}", std::process::id());
    let refused = std::process::Command::new("systemd-run")
        .args(["--user", "--quiet", "--wait", "--pipe", "--collect"])
        .arg(format!("--unit={unit}"))
        .arg(format!("--setenv=WSMP_CONFIG={}", config.display()))
        .arg(format!("--setenv=WSMP_STATE_DIR={}", state.display()))
        .args(["env", "-u", "WSMP_JOB"])
        .arg(&wsmp)
        .args(["trust", "full"])
        .stdin(std::process::Stdio::null())
        .output()
        .expect("systemd-run");
    assert!(!refused.status.success());
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("cannot run from a command"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );
    // A terminal (a pty from `script`) in this shell: raised.
    let command = format!(
        "WSMP_CONFIG='{}' WSMP_STATE_DIR='{}' '{}' trust full",
        config.display(),
        state.display(),
        wsmp.display()
    );
    let raised = std::process::Command::new("script")
        .args(["-qec", &command, "/dev/null"])
        .env_remove("WSMP_JOB")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            std::thread::sleep(std::time::Duration::from_millis(500));
            child.stdin.take().expect("stdin").write_all(b"full\n")?;
            child.wait_with_output()
        })
        .expect("script");
    let out = String::from_utf8_lossy(&raised.stdout);
    assert!(out.contains("trust: now full control"), "{out}");
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["trust"], "full");
}
