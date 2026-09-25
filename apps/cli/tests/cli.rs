use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc;
use std::thread;

fn cli(config: &Path, state: &Path) -> Command {
    let mut cmd = Command::cargo_bin("wsmp").expect("binary builds");
    cmd.env("WSMP_CONFIG", config);
    cmd.env("WSMP_STATE_DIR", state);
    cmd.env_remove("WSMP_LOG");
    cmd.env_remove("RUST_LOG");
    cmd
}

fn json_stdout(mut cmd: Command) -> Value {
    let stdout = cmd.assert().success().get_output().stdout.clone();
    serde_json::from_slice(&stdout).expect("stdout is valid JSON")
}

fn write_config(path: &Path, value: Value) {
    let parent = path.parent().expect("parent");
    fs::create_dir_all(parent).expect("create config dir");
    fs::write(path, serde_json::to_vec_pretty(&value).expect("json")).expect("write config");
}

struct TestServer {
    base_url: String,
    requests: mpsc::Receiver<String>,
    handle: thread::JoinHandle<()>,
}

impl TestServer {
    fn start(routes: Vec<(&'static str, u16, Value)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for (path, status, body) in routes {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let request = read_request(&mut stream);
                let _ = tx.send(request.clone());
                let response_body = if request.starts_with(&format!("GET {path} "))
                    || request.starts_with(&format!("POST {path} "))
                {
                    body.to_string()
                } else {
                    json!({ "error": "not found" }).to_string()
                };
                write_response(&mut stream, status, response_body.as_bytes());
            }
        });
        Self {
            base_url: format!("http://{addr}"),
            requests: rx,
            handle,
        }
    }

    fn join(self) {
        self.handle.join().expect("server thread joins");
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let n = stream.read(&mut buffer).expect("read request");
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
        if request_is_complete(&bytes) {
            break;
        }
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn request_is_complete(bytes: &[u8]) -> bool {
    let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then_some(value)
        })
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    bytes.len() >= header_end + 4 + content_length
}

fn write_response(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let status_text = if status == 200 { "OK" } else { "ERROR" };
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .expect("write response");
    stream.write_all(body).expect("write body");
}

#[test]
fn config_init_and_show_use_explicit_config_file() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("custom").join("config.json");
    let state = tmp.path().join("state");

    let mut init = cli(&config, &state);
    init.args(["config", "--json", "init"]);
    let init_value = json_stdout(init);
    assert_eq!(init_value["created"], true);
    assert_eq!(init_value["path"], config.display().to_string());

    let mut show = cli(&config, &state);
    show.args(["config", "--json", "show"]);
    let show_value = json_stdout(show);
    assert_eq!(show_value["version"], 1);
    assert!(
        show_value["endpoints"]
            .as_array()
            .is_some_and(Vec::is_empty)
    );
}

#[test]
fn config_show_missing_config_is_error() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("missing.json");
    cli(&config, tmp.path())
        .args(["config", "show"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("config file"))
        .stderr(predicate::str::contains("config init"));
}

#[test]
fn config_set_server_and_slug_write_json() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["config", "init"])
        .assert()
        .success();
    cli(&config, &state)
        .args(["config", "set-server", "http://127.0.0.1:3000"])
        .assert()
        .success();
    cli(&config, &state)
        .args(["config", "set-slug", "desk-01"])
        .assert()
        .success();

    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["serverUrl"], "http://127.0.0.1:3000");
    assert_eq!(cfg["cliSlug"], "desk-01");
}

#[test]
fn token_login_records_env_var_name_not_secret_value() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let mut cmd = cli(&config, &state);
    cmd.args(["token", "--json", "login", "WSMP_TEST_TOKEN"])
        .env("WSMP_TEST_TOKEN", "wsmp_cli_secret_for_test");
    let value = json_stdout(cmd);
    assert_eq!(value["cliTokenEnv"], "WSMP_TEST_TOKEN");

    let text = fs::read_to_string(&config).unwrap();
    assert!(text.contains("WSMP_TEST_TOKEN"));
    assert!(!text.contains("wsmp_cli_secret_for_test"));
}

#[test]
fn connect_persists_generated_slug_before_auth_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "serverUrl": "http://127.0.0.1:9",
            "endpoints": []
        }),
    );

    cli(&config, &state)
        .arg("connect")
        .assert()
        .failure()
        .stderr(predicate::str::contains("no CLI token env var"));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    let slug = cfg["cliSlug"].as_str().expect("slug");
    assert!(slug.starts_with("cli-"));
    assert!(slug.len() <= 63);
}

#[test]
fn login_rejects_invalid_slug_before_device_authorization_request() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "serverUrl": "http://127.0.0.1:9"
        }),
    );

    cli(&config, &state)
        .args(["login", "--slug", "desk.01"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("validating CLI slug"));

    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert!(cfg.get("cliSlug").is_none());
    assert!(!state.join("device-auth.json").exists());
}

#[test]
fn login_rejects_the_removed_name_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "serverUrl": "http://127.0.0.1:9"
        }),
    );

    cli(&config, &state)
        .args(["login", "--name", "Desk", "--slug", "desk-01"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("--name"));
}

#[test]
fn non_interactive_login_defaults_the_slug_from_the_hostname() {
    let Some(expected) = wsmp::hostname::hostname_slug() else {
        // No usable hostname here: login must ask for `--slug` instead.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config.json");
        let state = tmp.path().join("state");
        write_config(
            &config,
            json!({ "version": 1, "serverUrl": "http://127.0.0.1:9" }),
        );
        cli(&config, &state)
            .arg("login")
            .write_stdin("")
            .assert()
            .failure()
            .stderr(predicate::str::contains("pass `--slug <slug>`"));
        return;
    };
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            200,
            json!({
                "device_code": "device-code-1",
                "user_code": "ABCD-EFGH",
                "verification_uri": "http://example.test/en-US/device",
                "expires_in": 30,
                "interval": 1
            }),
        ),
        (
            "/rpc/cliCredentials/exchangeDeviceCode",
            200,
            json!({
                "json": {
                    "credentialId": "credential-1",
                    "userId": "user-1",
                    "secret": "wsmp_device_secret_for_test"
                }
            }),
        ),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({ "version": 1, "serverUrl": server.base_url }),
    );

    // assert_cmd gives the child a non-terminal stdin.
    cli(&config, &state)
        .arg("login")
        .write_stdin("")
        .assert()
        .success();
    let start_request = server.requests.recv().unwrap();
    assert!(start_request.contains("POST /api/auth/device/code"));
    let exchange_request = server.requests.recv().unwrap();
    assert!(exchange_request.contains(&format!(r#""cliSlug":"{expected}""#)));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["cliSlug"], expected.as_str());
    server.join();
}

#[test]
fn login_rejection_does_not_overwrite_local_slug_or_save_credential() {
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            200,
            json!({
                "device_code": "device-code-1",
                "user_code": "ABCD-EFGH",
                "verification_uri": "http://example.test/en-US/device",
                "expires_in": 30,
                "interval": 1
            }),
        ),
        (
            "/rpc/cliCredentials/exchangeDeviceCode",
            400,
            json!({
                "json": {
                    "defined": false,
                    "code": "BAD_REQUEST",
                    "status": 400,
                    "message": "Device authorization was requested for a different CLI slug."
                }
            }),
        ),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "serverUrl": server.base_url,
            "cliSlug": "existing-cli"
        }),
    );

    cli(&config, &state)
        .args(["login", "--slug", "desk-01"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("different CLI slug"));

    let start_request = server.requests.recv().unwrap();
    assert!(start_request.contains("POST /api/auth/device/code"));
    let exchange_request = server.requests.recv().unwrap();
    assert!(exchange_request.contains(r#""cliSlug":"desk-01""#));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["cliSlug"], "existing-cli");
    assert!(!state.join("device-auth.json").exists());
    server.join();
}

#[test]
fn login_untagged_error_fails_fast_even_when_the_message_says_pending() {
    // Only one exchange response is served. Classifying by message text (it
    // says "pending") instead of `data.deviceFlowError` would poll again, hit
    // a closed server, and fail with a transport error instead of this error.
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            200,
            json!({
                "device_code": "device-code-1",
                "user_code": "ABCD-EFGH",
                "verification_uri": "http://example.test/en-US/device",
                "expires_in": 30,
                "interval": 1
            }),
        ),
        (
            "/rpc/cliCredentials/exchangeDeviceCode",
            400,
            json!({
                "json": {
                    "defined": false,
                    "code": "BAD_REQUEST",
                    "status": 400,
                    "message": "Device authorization is pending, but for a different CLI slug."
                }
            }),
        ),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({ "version": 1, "serverUrl": server.base_url }),
    );

    let started = std::time::Instant::now();
    cli(&config, &state)
        .args(["login", "--slug", "pending-ci"])
        .timeout(std::time::Duration::from_secs(10))
        .assert()
        .failure()
        .stderr(predicate::str::contains("for a different CLI slug"));
    // One poll interval (1s), not a poll loop until the 30s expiry.
    assert!(started.elapsed() < std::time::Duration::from_secs(8));
    assert!(!state.join("device-auth.json").exists());
    server.join();
}

#[test]
fn relogin_with_the_saved_slug_overwrites_the_device_credential() {
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            200,
            json!({
                "device_code": "device-code-2",
                "user_code": "WXYZ-2345",
                "verification_uri": "http://example.test/en-US/device",
                "expires_in": 30,
                "interval": 1
            }),
        ),
        (
            "/rpc/cliCredentials/exchangeDeviceCode",
            200,
            json!({
                "json": {
                    "credentialId": "credential-2",
                    "userId": "user-1",
                    "secret": "wsmp_device_new_secret"
                }
            }),
        ),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({ "version": 1, "serverUrl": server.base_url, "cliSlug": "desk-01" }),
    );
    fs::create_dir_all(&state).unwrap();
    fs::write(
        state.join("device-auth.json"),
        serde_json::to_string(&json!({
            "credentialId": "credential-1",
            "userId": "user-1",
            "secret": "wsmp_device_old_secret"
        }))
        .unwrap(),
    )
    .unwrap();

    cli(&config, &state)
        .arg("login")
        .write_stdin("")
        .assert()
        .success();

    // The approval request names the saved slug, so the approver sees which
    // device this login replaces.
    let start_request = server.requests.recv().unwrap();
    assert!(start_request.contains(r#""scope":"cli-slug:desk-01""#));
    let exchange_request = server.requests.recv().unwrap();
    assert!(exchange_request.contains(r#""cliSlug":"desk-01""#));
    let credential_text = fs::read_to_string(state.join("device-auth.json")).unwrap();
    assert!(credential_text.contains("wsmp_device_new_secret"));
    assert!(!credential_text.contains("wsmp_device_old_secret"));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["cliSlug"], "desk-01");
    server.join();
}

#[test]
fn non_interactive_login_defaults_to_the_saved_slug() {
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            200,
            json!({
                "device_code": "device-code-1",
                "user_code": "ABCD-EFGH",
                "verification_uri": "http://example.test/en-US/device",
                "expires_in": 30,
                "interval": 1
            }),
        ),
        (
            "/rpc/cliCredentials/exchangeDeviceCode",
            200,
            json!({
                "json": {
                    "credentialId": "credential-1",
                    "userId": "user-1",
                    "secret": "wsmp_device_secret_for_test"
                }
            }),
        ),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({ "version": 1, "serverUrl": server.base_url, "cliSlug": "saved-cli" }),
    );

    cli(&config, &state)
        .arg("login")
        .write_stdin("")
        .assert()
        .success();
    let _start_request = server.requests.recv().unwrap();
    let exchange_request = server.requests.recv().unwrap();
    assert!(exchange_request.contains(r#""cliSlug":"saved-cli""#));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["cliSlug"], "saved-cli");
    server.join();
}

#[test]
fn login_writes_device_credential_to_state_dir() {
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            200,
            json!({
                "device_code": "device-code-1",
                "user_code": "ABCD-EFGH",
                "verification_uri": "http://example.test/en-US/device",
                "expires_in": 30,
                "interval": 1
            }),
        ),
        (
            "/rpc/cliCredentials/exchangeDeviceCode",
            400,
            json!({
                "json": {
                    "defined": false,
                    "code": "BAD_REQUEST",
                    "status": 400,
                    "message": "Device authorization is pending.",
                    "data": { "deviceFlowError": "authorization_pending" }
                }
            }),
        ),
        (
            "/rpc/cliCredentials/exchangeDeviceCode",
            200,
            json!({
                "json": {
                    "credentialId": "credential-1",
                    "userId": "user-1",
                    "secret": "wsmp_device_secret_for_test"
                }
            }),
        ),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "serverUrl": server.base_url
        }),
    );

    cli(&config, &state)
        .args(["login", "--slug", "desk-01"])
        .assert()
        .success()
        .stdout(predicate::str::contains("device login complete"));
    let start_request = server.requests.recv().unwrap();
    assert!(start_request.contains("POST /api/auth/device/code"));
    assert!(start_request.contains(r#""scope":"cli-slug:desk-01""#));
    let pending_request = server.requests.recv().unwrap();
    assert!(pending_request.contains(r#""cliSlug":"desk-01""#));
    // The device's name is dashboard-owned; login sends none.
    assert!(!pending_request.contains(r#""name""#));
    let success_request = server.requests.recv().unwrap();
    assert!(success_request.contains(r#""cliSlug":"desk-01""#));

    let credential_path = state.join("device-auth.json");
    let credential_text = fs::read_to_string(&credential_path).unwrap();
    assert!(credential_text.contains("wsmp_device_secret_for_test"));
    assert!(!config.parent().unwrap().join("device-auth.json").exists());
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["cliSlug"], "desk-01");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&credential_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    server.join();
}

#[test]
fn endpoints_add_list_remove_json() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args([
            "endpoints",
            "add",
            "--slug",
            "local",
            "--label",
            "Local",
            "--base-url",
            "http://127.0.0.1:11434/v1",
            "--header-env",
            "OpenAI-Organization=LOCAL_LLM_ORG",
        ])
        .assert()
        .success();

    let mut list = cli(&config, &state);
    list.args(["endpoints", "--json", "list"]);
    let value = json_stdout(list);
    assert_eq!(value["endpoints"][0]["slug"], "local");
    assert_eq!(value["endpoints"][0]["headers"][0]["env"], "LOCAL_LLM_ORG");

    cli(&config, &state)
        .args(["endpoints", "remove", "local"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["endpoints"].as_array().unwrap().len(), 0);
}

#[test]
fn endpoints_concurrency_and_engine_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args([
            "endpoints",
            "add",
            "--slug",
            "local",
            "--label",
            "Local",
            "--base-url",
            "http://127.0.0.1:8080/v1",
            "--concurrency-limit",
            "4",
            "--engine",
            "llama.cpp",
        ])
        .assert()
        .success();
    let mut list = cli(&config, &state);
    list.args(["endpoints", "--json", "list"]);
    let value = json_stdout(list);
    assert_eq!(value["endpoints"][0]["concurrencyLimit"], 4);
    assert_eq!(value["endpoints"][0]["engine"], "llama.cpp");

    cli(&config, &state)
        .args(["endpoints", "concurrency", "local", "--clear"])
        .assert()
        .success();
    cli(&config, &state)
        .args(["endpoints", "engine", "local", "vllm"])
        .assert()
        .success();
    let mut list = cli(&config, &state);
    list.args(["endpoints", "--json", "list"]);
    let value = json_stdout(list);
    assert!(value["endpoints"][0].get("concurrencyLimit").is_none());
    assert_eq!(value["endpoints"][0]["engine"], "vllm");

    cli(&config, &state)
        .args(["endpoints", "concurrency", "missing", "2"])
        .assert()
        .failure()
        .code(3)
        .stderr(predicate::str::contains("endpoint `missing` not found"));
}

#[test]
fn endpoints_remove_unknown_slug_exits_3_not_found() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(&config, json!({ "version": 1, "endpoints": [] }));
    cli(&config, &state)
        .args(["endpoints", "remove", "missing"])
        .assert()
        .failure()
        .code(3)
        .stderr(predicate::str::contains("endpoint `missing` not found"));
}

#[test]
fn endpoints_probe_success_applies_model_suggestions_and_uses_secret_env_header() {
    let server = TestServer::start(vec![(
        "/v1/models",
        200,
        json!({
            "data": [
                { "id": "llama-3.2-vision" },
                { "id": "text-embedding-3-small" }
            ]
        }),
    )]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "endpoints": [{
                "slug": "local",
                "label": "Local",
                "kind": "openai-compatible",
                "baseUrl": server.base_url,
                "enabled": true,
                "defaultCapabilities": {
                    "version": 1,
                    "protocol": "openai-compatible",
                    "models": { "list": true },
                    "chatCompletions": { "supported": true, "streaming": true }
                },
                "headers": [],
                "auth": { "mode": "bearer", "env": "LOCAL_LLM_AUTH" },
                "models": []
            }]
        }),
    );

    let mut probe = cli(&config, &state);
    probe
        .args(["endpoints", "--json", "probe", "local", "--apply"])
        .env("LOCAL_LLM_AUTH", "upstream-secret");
    let value = json_stdout(probe);
    assert_eq!(value["reports"][0]["status"], "online");
    assert_eq!(
        value["reports"][0]["discoveredModelIds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let request = server.requests.recv().unwrap();
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer upstream-secret"),
        "request did not contain typed auth header: {request:?}"
    );
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["endpoints"][0]["models"].as_array().unwrap().len(), 2);
    assert_eq!(
        cfg["endpoints"][0]["models"][1]["capabilityOverrideMode"],
        "inherit"
    );
    assert!(
        !fs::read_to_string(&config)
            .unwrap()
            .contains("upstream-secret")
    );
    server.join();
}

#[test]
fn endpoints_probe_stores_reasoning_metadata_as_an_advisory_v4_suggestion() {
    let server = TestServer::start(vec![(
        "/v1/models",
        200,
        json!({
            "data": [{
                "id": "provider/reasoner",
                "supported_parameters": ["reasoning_effort"],
                "reasoning": {
                    "supported_efforts": ["high", "medium", "unknown"]
                }
            }]
        }),
    )]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "endpoints": [{
                "slug": "local",
                "label": "Local",
                "baseUrl": server.base_url,
                "enabled": true,
                "models": [{
                    "upstreamModelId": "provider/reasoner",
                    "capabilityOverrideMode": "override",
                    "capabilities": {
                        "version": 1,
                        "protocol": "openai-compatible",
                        "chatCompletions": { "supported": true, "streaming": true }
                    }
                }]
            }]
        }),
    );

    cli(&config, &state)
        .args(["endpoints", "probe", "local", "--apply"])
        .assert()
        .success();

    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    let model = &cfg["endpoints"][0]["models"][0];
    assert_eq!(model["capabilityOverrideMode"], "override");
    assert_eq!(model["capabilities"]["version"], 1);
    assert_eq!(model["probeSuggestions"]["version"], 4);
    assert_eq!(
        model["probeSuggestions"]["surfaces"]["openaiChatCompletions"]["reasoning"],
        true
    );
    assert_eq!(
        model["probeSuggestions"]["surfaces"]["openaiChatCompletions"]["reasoningConfig"]["supportedLevels"],
        json!(["medium", "high"])
    );
    server.join();
}

#[test]
fn endpoints_probe_failure_reports_without_panic() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "endpoints": [{
                "slug": "local",
                "label": "Local",
                "baseUrl": "http://127.0.0.1:9",
                "enabled": true
            }]
        }),
    );
    let mut probe = cli(&config, &state);
    probe.args(["endpoints", "--json", "probe", "local"]);
    let value = json_stdout(probe);
    assert_eq!(value["reports"][0]["status"], "offline");
    assert!(value["reports"][0]["error"].as_str().is_some());
}

#[test]
fn protocol_helpers_reject_oversized_binary_chunk() {
    let metadata = wsmp::protocol::RelayBinaryFrameMetadata::ResponseBody {
        request_id: "request-1".to_string(),
        chunk_id: "0".to_string(),
        final_chunk: Some(true),
    };
    let body = vec![0_u8; wsmp::protocol::RELAY_BINARY_CHUNK_MAX_BYTES + 1];
    assert!(wsmp::protocol::encode_binary_frame(&metadata, &body).is_err());
}

#[test]
fn config_terminal_flags_persist_and_ask_for_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["config", "set-human-terminal", "on"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Restart wsmp to apply."));
    cli(&config, &state)
        .args(["config", "--json", "set-mcp-commands", "supervised"])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""key":"mcpCommandMode""#))
        .stdout(predicate::str::contains(r#""value":"supervised""#));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["allowHumanTerminal"], true);
    assert_eq!(cfg["mcpCommandMode"], "supervised");
    assert!(cfg.get("allowMcpCommands").is_none());
    assert!(cfg.get("requireTerminalApproval").is_none());
    cli(&config, &state)
        .args(["config", "set-mcp-commands", "off"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Restart wsmp to apply."));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert!(cfg.get("mcpCommandMode").is_none());
    cli(&config, &state)
        .args(["config", "set-mcp-commands", "on"])
        .assert()
        .failure();

    // A config from an older wsmp keeps its MCP commands switch, as a mode.
    fs::write(&config, r#"{"version":1,"allowMcpCommands":true}"#).unwrap();
    cli(&config, &state)
        .args(["config", "set-terminal-approval", "on"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["mcpCommandMode"], "unsupervised");
    assert!(cfg.get("allowMcpCommands").is_none());

    cli(&config, &state)
        .args(["config", "set-terminal-approval", "off"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Restart wsmp to apply."));
}

#[cfg(unix)]
#[test]
fn supervised_run_without_the_daemon_env_fails_and_runs_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let witness = tmp.path().join("ran");
    // Only a command: the rest of the daemon-provided env is missing.
    cli(&config, &state)
        .args(["terminal", "supervised-run"])
        .env(
            "WSMP_SUPERVISED_COMMAND",
            format!("touch {}", witness.display()),
        )
        .env_remove("WSMP_SUPERVISED_REASON")
        .env_remove("WSMP_SUPERVISED_REQUESTER")
        .env_remove("WSMP_SUPERVISED_SHARE")
        .env_remove("WSMP_SUPERVISED_MARKER")
        .assert()
        .failure()
        .stderr(predicate::str::contains("started by the relay daemon"));
    // Every variable set, but stdin is not a terminal: still nothing runs.
    cli(&config, &state)
        .args(["terminal", "supervised-run"])
        .env(
            "WSMP_SUPERVISED_COMMAND",
            format!("touch {}", witness.display()),
        )
        .env("WSMP_SUPERVISED_REASON", "")
        .env("WSMP_SUPERVISED_REQUESTER", "agent")
        .env("WSMP_SUPERVISED_SHARE", "0")
        .env("WSMP_SUPERVISED_MARKER", "0123456789abcdef0123456789abcdef")
        .write_stdin("\n")
        .assert()
        .failure();
    assert!(!witness.exists());
}

#[test]
fn approve_and_daemon_status_use_the_state_dir() {
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
    let pid = "version=1\npid=2147483646\ntoken=state-dir-token\n";
    fs::write(state.join("relay.pid"), pid).unwrap();
    fs::write(decoy.join("relay.pid"), pid).unwrap();

    cli(&config, &state)
        .args(["terminal", "--json", "approve", "QSOWJSS6"])
        .assert()
        .success();
    assert!(state.join("terminal-approvals.json").is_file());
    assert!(!decoy.join("terminal-approvals.json").exists());

    cli(&config, &state)
        .args(["daemon", "status"])
        .assert()
        .failure();
    assert!(
        !state.join("relay.pid").exists(),
        "daemon status did not read the PID file in WSMP_STATE_DIR"
    );
    assert!(
        decoy.join("relay.pid").is_file(),
        "daemon status touched a state dir other than WSMP_STATE_DIR"
    );
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
fn help_lists_ready_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    cli(&config, tmp.path())
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("login"))
        .stdout(predicate::str::contains("token"))
        .stdout(predicate::str::contains("endpoints"))
        .stdout(predicate::str::contains("connect"))
        .stdout(predicate::str::contains("daemon"))
        .stdout(predicate::str::contains("service"))
        .stdout(predicate::str::contains("reload"))
        .stdout(predicate::str::contains("logout"));
}

#[test]
fn daemon_status_requires_the_live_control_socket() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["daemon", "status"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "relay daemon is not running (control socket unavailable",
        ))
        .stderr(predicate::str::contains("wsmp daemon start"));
}

#[test]
fn daemon_stop_explains_that_it_only_stops_detached_relays() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["daemon", "stop"])
        .assert()
        .success()
        .stdout(predicate::str::contains("no detached relay is running"))
        .stdout(predicate::str::contains("wsmp service status"));
}

#[test]
fn service_env_path_points_under_config_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config").join("config.json");
    let state = tmp.path().join("state");
    let stdout = cli(&config, &state)
        .args(["service", "env-path"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let path = String::from_utf8_lossy(&stdout);
    assert!(
        path.contains("service.env"),
        "expected service.env path, got {path}"
    );
}

#[test]
fn service_env_sync_writes_private_file_without_echoing_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config").join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "cliTokenEnv": "WSMP_SERVICE_SYNC_TOKEN",
            "endpoints": []
        }),
    );
    let secret = "super-secret-service-token-value";
    let assert = cli(&config, &state)
        .args(["service", "env-sync"])
        .env("WSMP_SERVICE_SYNC_TOKEN", secret)
        .assert()
        .success();
    let stdout = String::from_utf8_lossy(&assert.get_output().stdout);
    assert!(stdout.contains("WSMP_SERVICE_SYNC_TOKEN"));
    assert!(
        !stdout.contains(secret),
        "env-sync must not print secret values"
    );

    let env_path = tmp.path().join("config").join("service.env");
    let body = fs::read_to_string(&env_path).expect("service.env written");
    assert!(body.contains("WSMP_SERVICE_SYNC_TOKEN="));
    assert!(body.contains(secret));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&env_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "service.env must be mode 0600");
    }
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

/// A real `wsmp` relay against a minimal in-test websocket relay: a shutdown
/// signal must kill running exec commands, tell the server, and remove the
/// runtime files before the process dies from that signal.
#[cfg(unix)]
mod signal_shutdown {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::{Child, Stdio};
    use std::time::{Duration, Instant};

    const TOKEN_ENV: &str = "WSMP_SIGNAL_TEST_TOKEN";

    /// SHA-1, only for the websocket handshake's `Sec-WebSocket-Accept`.
    fn sha1(data: &[u8]) -> [u8; 20] {
        let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
        let mut message = data.to_vec();
        let bit_len = (data.len() as u64).wrapping_mul(8);
        message.push(0x80);
        while message.len() % 64 != 56 {
            message.push(0);
        }
        message.extend_from_slice(&bit_len.to_be_bytes());
        for chunk in message.chunks(64) {
            let mut w = [0_u32; 80];
            for (i, word) in chunk.chunks(4).enumerate() {
                w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
            }
            for i in 16..80 {
                w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
            }
            let [mut a, mut b, mut c, mut d, mut e] = h;
            for (i, word) in w.iter().enumerate() {
                let (f, k) = match i {
                    0..=19 => ((b & c) | (!b & d), 0x5A827999),
                    20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                    40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                    _ => (b ^ c ^ d, 0xCA62C1D6),
                };
                let temp = a
                    .rotate_left(5)
                    .wrapping_add(f)
                    .wrapping_add(e)
                    .wrapping_add(k)
                    .wrapping_add(*word);
                e = d;
                d = c;
                c = b.rotate_left(30);
                b = a;
                a = temp;
            }
            for (slot, value) in h.iter_mut().zip([a, b, c, d, e]) {
                *slot = slot.wrapping_add(value);
            }
        }
        let mut out = [0_u8; 20];
        for (i, word) in h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn base64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (u32::from(chunk[0]) << 16)
                | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
                | u32::from(*chunk.get(2).unwrap_or(&0));
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(TABLE[(n >> (18 - 6 * i)) as usize & 63] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn handshake_digest_matches_rfc_6455_example() {
        let accept = base64(&sha1(
            b"dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        ));
        assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    /// A client frame: opcode and unmasked payload. `None` on EOF.
    fn read_frame(stream: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
        let mut header = [0_u8; 2];
        stream.read_exact(&mut header).ok()?;
        let opcode = header[0] & 0x0f;
        let masked = header[1] & 0x80 != 0;
        let len = match header[1] & 0x7f {
            126 => {
                let mut bytes = [0_u8; 2];
                stream.read_exact(&mut bytes).ok()?;
                u64::from(u16::from_be_bytes(bytes))
            }
            127 => {
                let mut bytes = [0_u8; 8];
                stream.read_exact(&mut bytes).ok()?;
                u64::from_be_bytes(bytes)
            }
            short => u64::from(short),
        };
        let mut mask = [0_u8; 4];
        if masked {
            stream.read_exact(&mut mask).ok()?;
        }
        let mut payload = vec![0_u8; usize::try_from(len).ok()?];
        stream.read_exact(&mut payload).ok()?;
        if masked {
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[i % 4];
            }
        }
        Some((opcode, payload))
    }

    fn write_text(stream: &mut TcpStream, text: &str) {
        let payload = text.as_bytes();
        let mut frame = vec![0x81_u8];
        if payload.len() < 126 {
            frame.push(payload.len() as u8);
        } else {
            frame.push(126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        frame.extend_from_slice(payload);
        stream.write_all(&frame).expect("write server frame");
    }

    enum Seen {
        Text(Value),
        Close(u16),
    }

    struct FakeRelay {
        server_url: String,
        socket: mpsc::Receiver<TcpStream>,
        frames: mpsc::Receiver<Seen>,
    }

    impl FakeRelay {
        /// Accept one relay websocket and forward the client's frames.
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake relay");
            let addr = listener.local_addr().expect("relay addr");
            let (socket_tx, socket) = mpsc::channel();
            let (frame_tx, frames) = mpsc::channel();
            thread::spawn(move || {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let request = read_request(&mut stream);
                let key = request
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("sec-websocket-key")
                            .then(|| value.trim().to_string())
                    })
                    .expect("websocket key");
                let accept = base64(&sha1(
                    format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes(),
                ));
                let response = format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: ws-model-proxy.relay.v2\r\n\r\n"
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write handshake");
                let _ = socket_tx.send(stream.try_clone().expect("clone relay socket"));
                while let Some((opcode, payload)) = read_frame(&mut stream) {
                    let seen = match opcode {
                        1 => match serde_json::from_slice(&payload) {
                            Ok(value) => Seen::Text(value),
                            Err(_) => continue,
                        },
                        8 => Seen::Close(if payload.len() >= 2 {
                            u16::from_be_bytes([payload[0], payload[1]])
                        } else {
                            0
                        }),
                        _ => continue,
                    };
                    let close = matches!(seen, Seen::Close(_));
                    if frame_tx.send(seen).is_err() || close {
                        return;
                    }
                }
            });
            Self {
                server_url: format!("http://{addr}"),
                socket,
                frames,
            }
        }

        fn next_text(&self, type_name: &str) -> Value {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match self.frames.recv_timeout(remaining) {
                    Ok(Seen::Text(value)) if value["type"] == type_name => return value,
                    Ok(_) => {}
                    Err(error) => panic!("no `{type_name}` frame from the relay: {error}"),
                }
            }
        }

        /// Every frame until the client closes or the timeout passes.
        fn rest(&self, timeout: Duration) -> Vec<Seen> {
            let deadline = Instant::now() + timeout;
            let mut seen = Vec::new();
            while let Ok(frame) = self
                .frames
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                let close = matches!(frame, Seen::Close(_));
                seen.push(frame);
                if close {
                    break;
                }
            }
            seen
        }
    }

    fn wait_for_file(path: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(text) = fs::read_to_string(path)
                && text.ends_with('\n')
            {
                return text.trim().to_string();
            }
            assert!(
                Instant::now() < deadline,
                "`{}` never appeared",
                path.display()
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Alive and not a zombie.
    fn process_alive(pid: &str) -> bool {
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .expect("run ps");
        let stat = String::from_utf8_lossy(&output.stdout);
        let stat = stat.trim();
        !stat.is_empty() && !stat.starts_with('Z')
    }

    fn wait_until_gone(pid: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while process_alive(pid) {
            assert!(Instant::now() < deadline, "process {pid} survived shutdown");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn signal(pid: u32, name: &str) {
        let status = std::process::Command::new("kill")
            .args([&format!("-{name}"), &pid.to_string()])
            .status()
            .expect("run kill");
        assert!(status.success(), "kill -{name} {pid}");
    }

    fn wait_for_exit(child: &mut Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = child.try_wait().expect("wait for relay") {
                return status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("relay did not exit after the shutdown signal");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Linux only: whether this test process inherited `signal` as ignored,
    /// in which case the relay honours that and the test cannot run.
    fn inherited_ignored(signal: u32) -> bool {
        fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                let mask = status
                    .lines()
                    .find_map(|line| line.strip_prefix("SigIgn:"))?;
                u64::from_str_radix(mask.trim(), 16).ok()
            })
            .is_some_and(|mask| mask & (1 << (signal - 1)) != 0)
    }

    struct Setup {
        _tmp: tempfile::TempDir,
        dir: PathBuf,
        state: PathBuf,
        relay: FakeRelay,
        child: Child,
    }

    fn start_relay(args: &[&str]) -> Setup {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().canonicalize().expect("canonical tempdir");
        let config = dir.join("config.json");
        let state = dir.join("state");
        let relay = FakeRelay::start();
        write_config(
            &config,
            json!({
                "version": 1,
                "serverUrl": relay.server_url,
                "cliSlug": "cli-signal-test",
                "cliTokenEnv": TOKEN_ENV,
                "allowMcpCommands": true,
                "endpoints": []
            }),
        );
        let child = std::process::Command::new(env!("CARGO_BIN_EXE_wsmp"))
            .args(args)
            .env("WSMP_CONFIG", &config)
            .env("WSMP_STATE_DIR", &state)
            .env("HOME", &dir)
            .env(TOKEN_ENV, "signal-test-token")
            .env_remove("WSMP_LOG")
            .env_remove("RUST_LOG")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start relay");
        Setup {
            _tmp: tmp,
            dir,
            state,
            relay,
            child,
        }
    }

    /// Start an exec whose shell and backgrounded grandchild record their pids.
    fn start_exec(setup: &Setup) -> (String, String) {
        setup.relay.next_text("hello");
        let mut socket = setup
            .relay
            .socket
            .recv_timeout(Duration::from_secs(5))
            .expect("relay socket");
        let shell_pid = setup.dir.join("shell.pid");
        let grand_pid = setup.dir.join("grand.pid");
        // On Linux, a child of the shell also records its own blocked mask.
        let command = format!(
            "if [ -r /proc/self/status ]; then grep SigBlk: /proc/self/status > '{}'; fi; echo $$ > '{}'; sleep 300 & echo $! > '{}'; wait",
            setup.dir.join("mask").display(),
            shell_pid.display(),
            grand_pid.display()
        );
        write_text(
            &mut socket,
            &json!({ "type": "exec.start", "commandId": "sig-1", "command": command }).to_string(),
        );
        setup.relay.next_text("exec.started");
        (wait_for_file(&shell_pid), wait_for_file(&grand_pid))
    }

    fn assert_clean_shutdown(setup: &mut Setup, shell: &str, grand: &str, signal_number: i32) {
        let status = wait_for_exit(&mut setup.child);
        assert!(
            status.signal() == Some(signal_number) || status.code() == Some(128 + signal_number),
            "unexpected relay status {status:?}"
        );
        wait_until_gone(shell);
        wait_until_gone(grand);
        let rest = setup.relay.rest(Duration::from_secs(5));
        let done = rest.iter().find_map(|frame| match frame {
            Seen::Text(value) if value["type"] == "exec.done" => Some(value),
            _ => None,
        });
        assert_eq!(
            done.map(|value| value["commandId"].clone()),
            Some(json!("sig-1")),
            "the server hears that the command ended"
        );
        assert!(
            rest.iter()
                .any(|frame| matches!(frame, Seen::Close(code) if *code == 1001)),
            "the relay closes the websocket as going away"
        );
        assert!(
            !setup.state.join("relay-control.sock").exists(),
            "control socket removed"
        );
    }

    #[test]
    fn sigterm_kills_running_exec_commands_and_cleans_up() {
        let mut setup = start_relay(&["connect"]);
        let (shell, grand) = start_exec(&setup);
        assert!(process_alive(&shell) && process_alive(&grand));
        // The relay blocks shutdown signals; its children must not inherit that.
        if let Ok(line) = fs::read_to_string(setup.dir.join("mask")) {
            let blocked = line
                .strip_prefix("SigBlk:")
                .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())
                .expect("SigBlk");
            // SIGHUP, SIGINT, SIGTERM.
            assert_eq!(blocked & 0x4003, 0, "exec children start unblocked");
        }
        signal(setup.child.id(), "TERM");
        assert_clean_shutdown(&mut setup, &shell, &grand, 15);
    }

    #[test]
    fn sigint_stops_a_detached_style_relay_and_removes_its_pid_file() {
        if inherited_ignored(2) {
            return;
        }
        let mut setup = start_relay(&[
            "daemon",
            "start",
            "--foreground",
            "--detach-token",
            "signal-test-token",
        ]);
        let (shell, grand) = start_exec(&setup);
        let pid_file = setup.state.join("relay.pid");
        assert!(pid_file.is_file(), "detached relay claims the PID file");
        signal(setup.child.id(), "INT");
        assert_clean_shutdown(&mut setup, &shell, &grand, 2);
        assert!(!pid_file.exists(), "PID file removed");
    }

    /// Two signals back to back may take the immediate-exit path instead of
    /// the normal unwind. Either way the children and runtime files are gone.
    #[test]
    fn a_second_signal_still_kills_children_and_removes_runtime_files() {
        let mut setup = start_relay(&[
            "daemon",
            "start",
            "--foreground",
            "--detach-token",
            "signal-test-token-2",
        ]);
        let (shell, grand) = start_exec(&setup);
        let pid_file = setup.state.join("relay.pid");
        assert!(pid_file.is_file(), "detached relay claims the PID file");
        signal(setup.child.id(), "TERM");
        signal(setup.child.id(), "TERM");
        let status = wait_for_exit(&mut setup.child);
        assert!(
            status.signal() == Some(15) || status.code() == Some(143),
            "unexpected relay status {status:?}"
        );
        wait_until_gone(&shell);
        wait_until_gone(&grand);
        assert!(!pid_file.exists(), "PID file removed");
        assert!(
            !setup.state.join("relay-control.sock").exists(),
            "control socket removed"
        );
    }

    /// JSON may escape an unpaired UTF-16 surrogate, which no Rust string can
    /// hold. Such a frame fails only the request it names; the daemon (model
    /// serving, every other terminal and command) keeps running.
    #[test]
    fn a_frame_with_a_lone_surrogate_fails_only_its_own_request() {
        let mut setup = start_relay(&["connect"]);
        setup.relay.next_text("hello");
        let mut socket = setup
            .relay
            .socket
            .recv_timeout(Duration::from_secs(5))
            .expect("relay socket");
        write_text(
            &mut socket,
            r#"{"type":"exec.start","commandId":"bad-1","command":"echo \ud800"}"#,
        );
        let rejected = setup.relay.next_text("exec.rejected");
        assert_eq!(rejected["commandId"], "bad-1");
        assert_eq!(rejected["reason"], "bad_command");
        write_text(
            &mut socket,
            r#"{"type":"term.spawn","terminalId":"AAAAAAAAAAAAAAAAAAAAAA","commandId":"bad-2","command":"true","reason":"x\udc00","requester":"agent","shareOutput":false}"#,
        );
        let rejected = setup.relay.next_text("supervised.rejected");
        assert_eq!(rejected["commandId"], "bad-2");
        // A cancel for an unknown command names nothing live: nothing happens.
        write_text(
            &mut socket,
            r#"{"type":"supervised.cancel","commandId":"\udbff"}"#,
        );
        // Still serving: a well-formed command runs.
        write_text(
            &mut socket,
            &json!({ "type": "exec.start", "commandId": "good-1", "command": "echo ok" })
                .to_string(),
        );
        assert_eq!(setup.relay.next_text("exec.started")["commandId"], "good-1");
        assert_eq!(setup.relay.next_text("exec.done")["commandId"], "good-1");
        assert!(
            setup.child.try_wait().expect("poll relay").is_none(),
            "the daemon exited on a malformed frame"
        );
        signal(setup.child.id(), "TERM");
        let _ = wait_for_exit(&mut setup.child);
    }
}

/// Runs the real confirm child in a PTY, as the relay daemon does.
#[cfg(unix)]
struct ConfirmChild {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    seen: Vec<u8>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[cfg(unix)]
impl ConfirmChild {
    const MARKER: &'static str = "00112233445566778899aabbccddeeff";

    fn spawn(command: &str, share: bool, cwd: &Path) -> Self {
        let system = portable_pty::native_pty_system();
        let pair = system
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a pty");
        let mut builder = portable_pty::CommandBuilder::new(assert_cmd::cargo::cargo_bin("wsmp"));
        builder.args(["terminal", "supervised-run"]);
        builder.cwd(cwd);
        builder.env("WSMP_SUPERVISED_COMMAND", command);
        builder.env("WSMP_SUPERVISED_REASON", "because\u{202e}txt.exe");
        builder.env("WSMP_SUPERVISED_REQUESTER", "test agent");
        builder.env("WSMP_SUPERVISED_SHARE", if share { "1" } else { "0" });
        builder.env("WSMP_SUPERVISED_MARKER", Self::MARKER);
        builder.env_remove("WSMP_LOG");
        builder.env_remove("RUST_LOG");
        let child = pair.slave.spawn_command(builder).expect("spawn wsmp");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("pty reader");
        let writer = pair.master.take_writer().expect("pty writer");
        let (tx, output) = mpsc::channel();
        thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            while let Ok(count) = reader.read(&mut buf) {
                if count == 0 || tx.send(buf[..count].to_vec()).is_err() {
                    return;
                }
            }
        });
        Self {
            child,
            writer,
            output,
            seen: Vec::new(),
            master: pair.master,
        }
    }

    fn marker(kind: &str) -> Vec<u8> {
        format!("\x1b]7717;wsmp-supervised;{kind};{}\x07", Self::MARKER).into_bytes()
    }

    fn wait_for(&mut self, needle: &[u8]) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if self
                .seen
                .windows(needle.len())
                .any(|window| window == needle)
            {
                return true;
            }
            if let Ok(bytes) = self
                .output
                .recv_timeout(std::time::Duration::from_millis(50))
            {
                self.seen.extend(bytes);
            }
        }
        false
    }

    fn pump(&mut self, wait: std::time::Duration) {
        if let Ok(bytes) = self.output.recv_timeout(wait) {
            self.seen.extend(bytes);
        }
    }

    fn type_keys(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).expect("type keys");
        self.writer.flush().expect("flush keys");
    }

    /// The relay daemon's go-ahead after it took `accepted`.
    fn release(&mut self) {
        let go = Self::marker("go");
        self.type_keys(&go);
    }

    fn resize(&self, cols: u16, rows: u16) {
        self.master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("resize the pty");
    }

    /// How many paints (each starts with home + clear) were seen so far.
    fn paints(&self) -> usize {
        self.seen
            .windows(Self::CLEAR.len())
            .filter(|window| *window == Self::CLEAR)
            .count()
    }

    /// Waits for a paint that started after the first `after` paints and was
    /// written in full (its last row ends the prompt, which is always drawn
    /// last), and returns its rows. A paint still arriving in pieces never
    /// qualifies, whatever its length so far.
    fn wait_for_paint(&mut self, after: usize) -> Vec<String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if self.paints() > after {
                let paint = self.last_paint();
                if paint.last().is_some_and(|row| row.ends_with("decline")) {
                    return paint;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no complete repaint after paint {after}: {:?}",
                String::from_utf8_lossy(&self.seen)
            );
            self.pump(std::time::Duration::from_millis(50));
        }
    }

    const CLEAR: &[u8] = b"\x1b[H\x1b[2J";

    /// The rows of the most recent paint of the confirm screen, as far as it
    /// arrived (use `wait_for_paint` to know it is complete).
    fn last_paint(&self) -> Vec<String> {
        let text = String::from_utf8_lossy(&self.seen).to_string();
        let start = text.rfind("\x1b[H\x1b[2J").expect("a paint") + "\x1b[H\x1b[2J".len();
        let paint = &text[start..];
        let end = paint.find('\x1b').unwrap_or(paint.len());
        paint[..end]
            .split('\n')
            .map(|row| row.trim_end_matches('\r').to_string())
            .collect()
    }

    fn exit_code(&mut self) -> u32 {
        self.child.wait().expect("wait for wsmp").exit_code()
    }
}

#[cfg(unix)]
#[test]
fn confirm_screen_ignores_type_ahead_and_runs_only_after_enter() {
    let tmp = tempfile::tempdir().unwrap();
    let witness = tmp.path().join("ran");
    let command = format!(
        "touch {} && printf 'hello-%s\\n' supervised",
        witness.display()
    );
    let mut child = ConfirmChild::spawn(&command, true, tmp.path());
    // Enter typed before the screen is drawn must not run the command.
    child.type_keys(b"\r\r\r");
    assert!(child.wait_for(&ConfirmChild::marker("ready")));
    assert!(!witness.exists());
    let screen = String::from_utf8_lossy(&child.seen).to_string();
    assert!(screen.contains("Requested by: test agent"), "{screen}");
    assert!(screen.contains("because\\u{202e}txt.exe"), "{screen}");
    assert!(screen.contains("Output will be shared with the requesting agent."));
    assert!(screen.contains(&witness.display().to_string()));
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(!witness.exists(), "type-ahead ran the command");
    child.type_keys(b"x \x1b[A\r");
    assert!(child.wait_for(&ConfirmChild::marker("accepted")));
    // Enter alone does not start it: the daemon's go does.
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(!witness.exists(), "the command ran before the go");
    child.type_keys(b"\r\r");
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(
        !witness.exists(),
        "keys other than the go started the command"
    );
    child.release();
    assert!(child.wait_for(b"hello-supervised"));
    assert_eq!(child.exit_code(), 0);
    assert!(witness.exists());
}

#[cfg(unix)]
#[test]
fn confirm_screen_declines_on_q_and_runs_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let witness = tmp.path().join("ran");
    let mut child = ConfirmChild::spawn(&format!("touch {}", witness.display()), false, tmp.path());
    assert!(child.wait_for(&ConfirmChild::marker("ready")));
    assert!(String::from_utf8_lossy(&child.seen).contains("Output stays in this terminal."));
    child.type_keys(b"q");
    assert!(child.wait_for(b"Declined."));
    assert_eq!(child.exit_code(), 0);
    assert!(!child.seen.windows(8).any(|window| window == b"accepted"));
    assert!(!witness.exists());
}

#[cfg(unix)]
#[test]
fn a_confirmed_command_without_the_go_never_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let witness = tmp.path().join("ran");
    let mut child = ConfirmChild::spawn(&format!("touch {}", witness.display()), false, tmp.path());
    assert!(child.wait_for(&ConfirmChild::marker("ready")));
    child.type_keys(b"\r");
    assert!(child.wait_for(&ConfirmChild::marker("accepted")));
    // A wrong go (another request's marker) is not the go.
    child.type_keys(b"\x1b]7717;wsmp-supervised;go;ffffffffffffffffffffffffffffffff\x07");
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(!witness.exists());
    // The daemon ends it instead (a server expiry won the race).
    child.child.kill().expect("kill the confirm child");
    let _ = child.child.wait();
    assert!(!witness.exists());
}

#[cfg(unix)]
#[test]
fn a_tall_command_fits_the_screen_and_follows_a_resize() {
    let tmp = tempfile::tempdir().unwrap();
    let command = (0..300)
        .map(|n| format!("echo line-{n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut child = ConfirmChild::spawn(&command, false, tmp.path());
    assert!(child.wait_for(&ConfirmChild::marker("ready")));
    let first = child.last_paint();
    assert!(first.len() <= 24, "{first:?}");
    let joined = first.join("\n");
    assert!(joined.contains("Requested by: test agent"), "{joined}");
    assert!(joined.contains("echo line-0"), "{joined}");
    assert!(joined.contains("the rest is not shown"), "{joined}");
    assert!(joined.contains("300 lines"), "{joined}");
    assert!(joined.ends_with("Enter to run · Ctrl-C, Ctrl-D or q to decline"));

    // A narrower, shorter terminal gets a new layout that still fits.
    let before = child.paints();
    child.resize(40, 12);
    let narrow = child.wait_for_paint(before);
    assert!(narrow.len() <= 12, "{narrow:?}");
    assert!(
        narrow.iter().all(|row| row.chars().count() < 40),
        "{narrow:?}"
    );
    assert!(narrow.join(" ").contains("not shown"), "{narrow:?}");

    // Scrolling to the end shows the output notice; `q` still declines.
    let before = child.paints();
    child.type_keys(b"G");
    let end = child.wait_for_paint(before).join(" ");
    assert!(end.contains("Output stays in this terminal."), "{end}");
    assert!(end.contains("echo line-299"), "{end}");
    child.type_keys(b"q");
    assert!(child.wait_for(b"Declined."));
    assert_eq!(child.exit_code(), 0);
}
