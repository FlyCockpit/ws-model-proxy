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
fn login_slug_conflict_does_not_overwrite_local_slug_or_save_credential() {
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
            409,
            json!({
                "json": {
                    "defined": false,
                    "code": "CONFLICT",
                    "status": 409,
                    "message": "CLI slug `desk-01` is already in use for your account; choose a different slug."
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
        .stderr(predicate::str::contains("choose a different slug"));

    let exchange_request = server.requests.recv().unwrap();
    assert!(exchange_request.contains("POST /api/auth/device/code"));
    let exchange_request = server.requests.recv().unwrap();
    assert!(exchange_request.contains(r#""cliSlug":"desk-01""#));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["cliSlug"], "existing-cli");
    assert!(!state.join("device-auth.json").exists());
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
                    "message": "Device authorization is pending."
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
        .args(["login", "--name", "Test CLI", "--slug", "desk-01"])
        .assert()
        .success()
        .stdout(predicate::str::contains("device login complete"));
    let start_request = server.requests.recv().unwrap();
    assert!(start_request.contains("POST /api/auth/device/code"));
    let pending_request = server.requests.recv().unwrap();
    assert!(pending_request.contains(r#""cliSlug":"desk-01""#));
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
            "Authorization=LOCAL_LLM_AUTH",
        ])
        .assert()
        .success();

    let mut list = cli(&config, &state);
    list.args(["endpoints", "--json", "list"]);
    let value = json_stdout(list);
    assert_eq!(value["endpoints"][0]["slug"], "local");
    assert_eq!(value["endpoints"][0]["headers"][0]["env"], "LOCAL_LLM_AUTH");

    cli(&config, &state)
        .args(["endpoints", "remove", "local"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["endpoints"].as_array().unwrap().len(), 0);
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
                "headers": [{ "name": "Authorization", "env": "LOCAL_LLM_AUTH" }],
                "models": []
            }]
        }),
    );

    let mut probe = cli(&config, &state);
    probe
        .args(["endpoints", "--json", "probe", "local", "--apply"])
        .env("LOCAL_LLM_AUTH", "Bearer upstream-secret");
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
            .contains("authorization: bearer upstream-secret")
    );
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["endpoints"][0]["models"].as_array().unwrap().len(), 2);
    assert_eq!(
        cfg["endpoints"][0]["models"][1]["capabilityOverrideMode"],
        "override"
    );
    assert!(
        !fs::read_to_string(&config)
            .unwrap()
            .contains("upstream-secret")
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
    let metadata = wsmp::protocol::RelayBinaryFrameMetadata {
        r#type: wsmp::protocol::RelayBinaryFrameType::ResponseBody,
        request_id: "request-1".to_string(),
        chunk_id: "0".to_string(),
        final_chunk: Some(true),
    };
    let body = vec![0_u8; wsmp::protocol::RELAY_BINARY_CHUNK_MAX_BYTES + 1];
    assert!(wsmp::protocol::encode_binary_frame(&metadata, &body).is_err());
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
        .stdout(predicate::str::contains("reload"))
        .stdout(predicate::str::contains("logout"));
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
