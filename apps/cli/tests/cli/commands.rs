//! Help, completions, the service subcommands, status and hardware.

use crate::{cli, json_stdout};
use predicates::prelude::*;

#[test]
fn help_lists_ready_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    cli(&config, tmp.path())
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("login"))
        .stdout(predicate::str::contains("run"))
        .stdout(predicate::str::contains("status"))
        .stdout(predicate::str::contains("service"))
        .stdout(predicate::str::contains("recover"))
        .stdout(predicate::str::contains("logout"))
        .stdout(predicate::str::contains("endpoints").not())
        .stdout(predicate::str::contains("daemon").not());
}

#[test]
fn service_offers_restart_and_logs_and_no_env_file_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["service", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("restart"))
        .stdout(predicate::str::contains("logs"))
        .stdout(predicate::str::contains("env-sync").not())
        .stdout(predicate::str::contains("env-path").not());
    cli(&config, &state)
        .args(["service", "env-sync"])
        .assert()
        .code(2);
}

#[test]
fn completions_generates_shell_script() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    cli(&config, tmp.path())
        .args(["completions", "bash"])
        .assert()
        .success()
        .stdout(predicate::str::contains("_wsmp"));
}

#[test]
fn status_reports_a_relay_that_is_not_running() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["status", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""state":"not_running""#));
}

#[test]
fn hardware_reports_this_machine_as_json() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let mut cmd = cli(&config, &state);
    cmd.args(["hardware", "--json"]);
    let report = json_stdout(cmd);
    let detected = &report["detected"];
    assert!(
        ["cpu", "discrete", "unified"].contains(&detected["nodeKind"].as_str().unwrap_or("")),
        "{report}"
    );
    assert!(detected["gpus"].is_array(), "{report}");
    assert!(detected["notes"].is_array(), "{report}");
}
