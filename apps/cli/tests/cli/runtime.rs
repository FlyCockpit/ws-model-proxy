//! Runtimes and secrets.

use crate::{TestServer, cli, json_stdout, write_config};
use predicates::prelude::*;
use serde_json::json;
use std::fs;
use std::path::Path;

#[test]
fn secrets_need_a_terminal_and_list_names_only() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["secret", "set", "WSMP_SECRET_HF"])
        .write_stdin("hf_value\n")
        .assert()
        .failure()
        .stderr(predicate::str::contains("terminal"));
    cli(&config, &state)
        .args(["secret", "set", "HF_TOKEN"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("WSMP_SECRET_"));
    cli(&config, &state)
        .args(["secret", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains("no secrets"));
}

fn write_held_always_on(state: &Path, base_url: &str) {
    fs::create_dir_all(state).expect("state dir");
    let store = json!({
        "version": 1,
        "held": [{
            "runtimeId": "rt-1", "versionId": "ver-1", "launchHash": "h", "kind": "always_on",
            "slug": "local-llm",
            "spec": {
                "api": "openai", "engine": "ollama", "modelType": "llm",
                "models": [{ "id": "llama3" }],
                "address": { "baseUrl": base_url }
            }
        }]
    });
    let path = state.join("runtime-store.json");
    fs::write(&path, serde_json::to_vec(&store).expect("json")).expect("write store");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
    }
}

#[test]
fn runtime_list_and_status_show_the_held_runtimes() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(&config, json!({ "version": 3, "trust": "full" }));
    write_held_always_on(&state, "http://127.0.0.1:9");
    let mut list = cli(&config, &state);
    list.args(["runtime", "list", "--json"]);
    let view = json_stdout(list);
    assert_eq!(view["trust"], "full");
    assert_eq!(view["definitions"], "live");
    assert_eq!(view["runtimes"][0]["slug"], "local-llm");
    assert_eq!(view["runtimes"][0]["kind"], "always_on");
    assert_eq!(view["runtimes"][0]["models"][0], "llama3");
    assert_eq!(view["instances"], json!([]));
    cli(&config, &state)
        .args(["runtime", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains("local-llm  always_on"));
    let mut status = cli(&config, &state);
    status.args(["status", "--json"]);
    let status = json_stdout(status);
    assert_eq!(status["state"], "not_running");
    assert_eq!(status["runtimes"][0]["slug"], "local-llm");
    cli(&config, &state)
        .args(["status"])
        .assert()
        .success()
        .stdout(predicate::str::contains("relay: not running"))
        .stdout(predicate::str::contains("local-llm  always_on"));
}

#[test]
fn runtime_test_asks_the_model_list_and_reports_status_and_latency() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(&config, json!({ "version": 3, "trust": "relay" }));
    let server = TestServer::start(vec![(
        "/v1/models",
        200,
        json!({ "data": [{ "id": "llama3" }, { "id": "qwen" }] }),
    )]);
    write_held_always_on(&state, &server.base_url);
    let mut test = cli(&config, &state);
    test.args(["runtime", "test", "local-llm", "--json"]);
    let results = json_stdout(test);
    assert_eq!(results[0]["target"], "local-llm");
    assert_eq!(results[0]["ok"], true);
    assert_eq!(results[0]["status"], 200);
    assert_eq!(results[0]["models"], 2);
    assert!(results[0]["latencyMs"].is_u64());
    let request = server.requests.recv().expect("one request");
    assert!(request.starts_with("GET /v1/models "), "{request}");
    server.join();
    cli(&config, &state)
        .args(["runtime", "test", "nope"])
        .assert()
        .code(3);
}
