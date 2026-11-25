//! The relay run (`wsmp run`) without a server, and the relay protocol helpers.

use crate::{cli, write_config};
use predicates::prelude::*;
use serde_json::{Value, json};
use std::fs;

#[test]
fn run_persists_generated_slug_before_auth_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 3,
            "serverUrl": "http://127.0.0.1:9"
        }),
    );

    // As under the systemd unit: a definitely missing credential exits 4
    // (elsewhere the relay keeps retrying in-process).
    cli(&config, &state)
        .arg("run")
        .env("WSMP_STOP_ON_REJECTED_CREDENTIAL", "1")
        .timeout(std::time::Duration::from_secs(60))
        .assert()
        .code(4)
        .stderr(predicate::str::contains("not enrolled"));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    let slug = cfg["cliSlug"].as_str().expect("slug");
    assert!(slug.starts_with("cli-"));
    assert!(slug.len() <= 63);
}

#[test]
fn run_without_the_stop_marker_keeps_retrying_a_missing_credential() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({ "version": 3, "serverUrl": "http://127.0.0.1:9" }),
    );
    // A macOS LaunchAgent or detached daemon: exiting would only relaunch.
    // The generous timeout leaves room for slow CI startup before the warning.
    let output = cli(&config, &state)
        .arg("run")
        .env_remove("WSMP_STOP_ON_REJECTED_CREDENTIAL")
        .timeout(std::time::Duration::from_secs(10))
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("relay credential unavailable; retrying"),
        "{stderr}"
    );
    // Still running when the timeout killed it. Windows reports a killed
    // process as exit code 1, so only Unix can tell a kill from an exit.
    assert_ne!(output.status.code(), Some(4), "{stderr}");
    #[cfg(unix)]
    assert_eq!(output.status.code(), None, "{stderr}");
}

#[test]
fn protocol_helpers_reject_oversized_binary_chunk() {
    let metadata = wsmp::protocol::NodeBinaryMetadata::RelayResponseBody {
        request_id: "request-1".to_string(),
        chunk_id: "0".to_string(),
        is_final: Some(true),
    };
    let body = vec![0_u8; wsmp::protocol::RELAY_BINARY_CHUNK_MAX_BYTES + 1];
    assert!(wsmp::protocol::encode_binary_frame(&metadata, &body).is_err());
}
