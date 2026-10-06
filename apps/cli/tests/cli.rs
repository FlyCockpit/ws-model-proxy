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
    // A rate limit always says when to come back, as the server does.
    let retry_after = if status == 429 {
        "Retry-After: 1\r\n"
    } else {
        ""
    };
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\n{retry_after}Content-Length: {}\r\nConnection: close\r\n\r\n",
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
fn config_set_server_pins_and_clears_a_public_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["config", "init"])
        .assert()
        .success();

    let mut set = cli(&config, &state);
    set.args([
        "config",
        "--json",
        "set-server",
        "http://10.0.0.5:3000",
        "--public-origin",
        "https://WSMP.example.com:443/",
    ]);
    let value = json_stdout(set);
    assert_eq!(value["value"], "http://10.0.0.5:3000");
    // Stored canonical: lowercase host, default port and root path dropped.
    assert_eq!(value["publicOrigin"], "https://wsmp.example.com");
    let mut show = cli(&config, &state);
    show.args(["config", "--json", "show"]);
    let shown = json_stdout(show);
    assert_eq!(shown["serverUrl"], "http://10.0.0.5:3000");
    assert_eq!(shown["publicOrigin"], "https://wsmp.example.com");
    assert_eq!(shown["helloOrigin"], "https://wsmp.example.com");

    // Not an origin, or a host a shell would interpret: refused, config
    // unchanged. Built at run time so the source holds no literal credential URL for secret scanners.
    let with_credentials = format!("https://{}:{}@wsmp.example.com", "user", "pw");
    for bad in [
        "https://wsmp.example.com/app",
        with_credentials.as_str(),
        "ftp://wsmp.example.com",
        "https://wsmp.example.com/?x=1",
        "https://a$({touch,pwned}).com",
        "https://a;id.com",
    ] {
        cli(&config, &state)
            .args(["config", "set-server", "http://10.0.0.5:3000"])
            .args(["--public-origin", bad])
            .assert()
            .failure()
            .stderr(predicate::str::contains("public origin"));
    }
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["publicOrigin"], "https://wsmp.example.com");

    // Setting the server again without the flag clears the pin, and says so.
    cli(&config, &state)
        .args(["config", "set-server", "http://10.0.0.5:3000"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "cleared the pinned public origin `https://wsmp.example.com`",
        ));
    let mut show = cli(&config, &state);
    show.args(["config", "--json", "show"]);
    let shown = json_stdout(show);
    assert!(shown.get("publicOrigin").is_none());
    assert_eq!(shown["helloOrigin"], "http://10.0.0.5:3000");

    // The warning is about the connect URL, where the traffic goes: a
    // plain-http LAN connect URL warns, a plain-http pin alone does not.
    cli(&config, &state)
        .args(["config", "set-server", "http://10.0.0.5:3000"])
        .args(["--public-origin", "http://wsmp.lan:3000"])
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "the server URL `http://10.0.0.5:3000` uses plain http",
        ));
    cli(&config, &state)
        .args(["config", "set-server", "https://wsmp.example.com"])
        .args(["--public-origin", "http://wsmp.lan:3000"])
        .assert()
        .success()
        .stderr(predicate::str::contains("plain http").not());
    cli(&config, &state)
        .args(["config", "set-server", "http://127.0.0.1:3000"])
        .args(["--public-origin", "http://wsmp.lan:3000"])
        .assert()
        .success()
        .stderr(predicate::str::contains("plain http").not());
    // Clearing the pin via --json names it.
    let mut clear = cli(&config, &state);
    clear.args(["config", "--json", "set-server", "http://10.0.0.5:3000"]);
    let value = json_stdout(clear);
    assert_eq!(value["clearedPublicOrigin"], "http://wsmp.lan:3000");
    assert!(value["publicOrigin"].is_null());
}

#[test]
fn run_persists_generated_slug_before_auth_failure() {
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

    // As under the systemd unit: a definitely missing credential exits 4
    // (elsewhere the relay keeps retrying in-process).
    cli(&config, &state)
        .arg("run")
        .env("WSMP_STOP_ON_REJECTED_CREDENTIAL", "1")
        .timeout(std::time::Duration::from_secs(60))
        .assert()
        .code(4)
        .stderr(predicate::str::contains("no CLI token env var"));
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
        json!({ "version": 1, "serverUrl": "http://127.0.0.1:9", "endpoints": [] }),
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
fn login_waits_out_a_short_device_code_rate_limit_once() {
    let started = json!({
        "device_code": "device-code-1",
        "user_code": "ABCD-EFGH",
        "verification_uri": "http://example.test/en-US/device",
        "expires_in": 30,
        "interval": 1
    });
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            429,
            json!({ "error": "Too many attempts." }),
        ),
        ("/api/auth/device/code", 200, started),
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
    cli(&config, &state)
        .args(["login", "--slug", "desk-01"])
        .write_stdin("")
        .assert()
        .success()
        .stderr(predicate::str::contains("rate limited, retry in 1 s"));
    server.join();
}

#[test]
fn login_reports_a_repeated_device_code_rate_limit_with_its_wait() {
    let server = TestServer::start(vec![
        (
            "/api/auth/device/code",
            429,
            json!({ "error": "Too many attempts." }),
        ),
        (
            "/api/auth/device/code",
            429,
            json!({ "error": "Too many attempts." }),
        ),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({ "version": 1, "serverUrl": server.base_url }),
    );
    cli(&config, &state)
        .args(["login", "--slug", "desk-01"])
        .write_stdin("")
        .assert()
        .failure()
        .stderr(predicate::str::contains("rate limited, retry in 1 s"));
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
    assert!(success_request.contains(r#""identityPublicKey":"#));

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
fn protocol_helpers_reject_oversized_binary_chunk() {
    let metadata = wsmp::protocol::NodeBinaryMetadata::RelayResponseBody {
        request_id: "request-1".to_string(),
        chunk_id: "0".to_string(),
        is_final: Some(true),
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

#[test]
fn config_file_tools_as_root_defaults_off_persists_and_shows() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["config", "init"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert!(cfg.get("allowFileToolsAsRoot").is_none());
    cli(&config, &state)
        .args(["config", "--json", "set-file-tools-as-root", "on"])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""key":"allowFileToolsAsRoot""#))
        .stdout(predicate::str::contains(r#""value":true"#));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["allowFileToolsAsRoot"], true);
    cli(&config, &state)
        .args(["config", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""allowFileToolsAsRoot": true"#));
    cli(&config, &state)
        .args(["config", "set-file-tools-as-root", "off"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Restart wsmp to apply."));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert!(cfg.get("allowFileToolsAsRoot").is_none());
    cli(&config, &state)
        .args(["config", "set-file-tools-as-root", "maybe"])
        .assert()
        .failure();
}

#[test]
fn config_max_terminals_defaults_to_four_and_accepts_one_to_thirty_two() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["config", "init"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert!(cfg.get("maxTerminals").is_none());
    cli(&config, &state)
        .args(["config", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""maxTerminals": 4"#));
    for rejected in ["0", "33", "-1", "many"] {
        cli(&config, &state)
            .args(["config", "set-max-terminals", rejected])
            .assert()
            .failure();
    }
    cli(&config, &state)
        .args(["config", "--json", "set-max-terminals", "32"])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""key":"maxTerminals""#))
        .stdout(predicate::str::contains(r#""value":32"#));
    cli(&config, &state)
        .args(["config", "set-max-terminals", "1"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Restart wsmp to apply."));
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["maxTerminals"], 1);
    // A hand-edited value outside the range stops the relay before it connects.
    let mut cfg = cfg;
    cfg["maxTerminals"] = json!(0);
    fs::write(&config, serde_json::to_vec(&cfg).unwrap()).unwrap();
    cli(&config, &state)
        .args(["run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "`maxTerminals` must be an integer from 1 to 32",
        ));
    // `config show` flags it rather than presenting it as the limit in effect.
    cli(&config, &state)
        .args(["config", "--json", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""maxTerminalsInvalid":true"#))
        .stderr(predicate::str::contains("the relay will not start"));
}

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
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: ws-model-proxy.relay.v3\r\n\r\n"
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write handshake");
                // The CLI signs only its configured server's origin.
                write_text(
                    &mut stream,
                    &format!(
                        r#"{{"type":"hello.challenge","nonce":"AAECAwQFBgcICQoLDA0ODw","origin":"http://{addr}"}}"#
                    ),
                );
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

    struct Setup {
        _tmp: tempfile::TempDir,
        dir: PathBuf,
        state: PathBuf,
        relay: FakeRelay,
        child: Child,
    }

    fn start_relay(args: &[&str]) -> Setup {
        start_relay_with(args, json!({}))
    }

    /// `extra` is merged over the base config (top-level keys).
    fn start_relay_with(args: &[&str], extra: Value) -> Setup {
        start_relay_logged(args, extra, &[], Stdio::null())
    }

    /// `start_relay_with`, plus extra environment and a chosen stderr.
    fn start_relay_logged(
        args: &[&str],
        extra: Value,
        env: &[(&str, &str)],
        stderr: Stdio,
    ) -> Setup {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().canonicalize().expect("canonical tempdir");
        let config = dir.join("config.json");
        let state = dir.join("state");
        let relay = FakeRelay::start();
        let mut value = json!({
            "version": 1,
            "serverUrl": relay.server_url,
            "cliSlug": "cli-signal-test",
            "cliTokenEnv": TOKEN_ENV,
            "allowMcpCommands": true,
            "endpoints": []
        });
        if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        write_config(&config, value);
        let child = std::process::Command::new(env!("CARGO_BIN_EXE_wsmp"))
            .args(args)
            .env("WSMP_CONFIG", &config)
            .env("WSMP_STATE_DIR", &state)
            .env("HOME", &dir)
            .env(TOKEN_ENV, "signal-test-token")
            .env_remove("WSMP_LOG")
            .env_remove("RUST_LOG")
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
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
        let command = format!(
            "echo $$ > '{}'; sleep 300 & echo $! > '{}'; wait",
            shell_pid.display(),
            grand_pid.display()
        );
        write_text(
            &mut socket,
            &json!({ "type": "exec.start", "commandId": "sig-1", "command": command, "timeoutMs": 600_000 }).to_string(),
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
            Seen::Text(value) if value["type"] == "exec.status" => Some(value),
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
        let mut setup = start_relay(&["run"]);
        let (shell, grand) = start_exec(&setup);
        assert!(process_alive(&shell) && process_alive(&grand));
        assert_takes_shutdown_signals(&shell);
        assert_takes_shutdown_signals(&grand);
        signal(setup.child.id(), "TERM");
        assert_clean_shutdown(&mut setup, &shell, &grand, 15);
    }

    /// SIGHUP, SIGINT, and SIGTERM.
    const SHUTDOWN_SIGNALS: u64 = 0x4003;

    /// Linux only: the signals `pid` blocks, read by this process from the
    /// kernel. Never ask a shell to report it: dash clears its mask at
    /// startup and would hide a mask the relay passed down.
    fn blocked_signals(pid: &str) -> Option<u64> {
        let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        let mask = status
            .lines()
            .find_map(|line| line.strip_prefix("SigBlk:"))?;
        u64::from_str_radix(mask.trim(), 16).ok()
    }

    /// The relay's children must start with the shutdown signals unblocked,
    /// or `kill`, `timeout`, and deployment stop commands cannot end them.
    fn assert_takes_shutdown_signals(pid: &str) {
        if let Some(blocked) = blocked_signals(pid) {
            assert_eq!(
                blocked & SHUTDOWN_SIGNALS,
                0,
                "process {pid} started with shutdown signals blocked ({blocked:#x})"
            );
        }
    }

    /// Exec commands run by bash, which (unlike dash) keeps the signal mask
    /// it inherits and passes it to every program it starts. A plain SIGTERM
    /// must still end such a program. bash stands in for `sh` through
    /// `PATH`; it is `/bin/sh` on macOS, Fedora, RHEL, and Arch.
    #[test]
    fn exec_commands_under_bash_can_be_stopped_with_sigterm() {
        let Some(bash) = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]
            .into_iter()
            .map(Path::new)
            .find(|path| path.is_file())
        else {
            return;
        };
        let bin = tempfile::tempdir().expect("tempdir");
        std::os::unix::fs::symlink(bash, bin.path().join("sh")).expect("link sh to bash");
        let path = std::env::join_paths(std::iter::once(bin.path().to_path_buf()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .expect("join PATH");
        let path = path.to_str().expect("utf-8 PATH");
        let mut setup = start_relay_logged(&["run"], json!({}), &[("PATH", path)], Stdio::null());
        let (shell, grand) = start_exec(&setup);
        assert!(process_alive(&shell) && process_alive(&grand));
        assert_takes_shutdown_signals(&shell);
        assert_takes_shutdown_signals(&grand);
        // What `kill`, `pkill`, `timeout`, or a deployment stop command does.
        signal(grand.parse().expect("grandchild pid"), "TERM");
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_alive(&grand) {
            assert!(
                Instant::now() < deadline,
                "SIGTERM did not end a program an exec command started under bash"
            );
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            setup.relay.next_text("exec.status")["commandId"],
            "sig-1",
            "the command ends once its program does"
        );
        signal(setup.child.id(), "TERM");
        let status = wait_for_exit(&mut setup.child);
        assert_eq!(
            status.signal(),
            Some(15),
            "the relay dies from the signal it took: {status:?}"
        );
    }

    /// Two signals back to back may take the immediate-exit path instead of
    /// the normal unwind. Either way the children and runtime files are gone.
    #[test]
    fn a_second_signal_still_kills_children_and_removes_runtime_files() {
        let mut setup = start_relay(&["run"]);
        let (shell, grand) = start_exec(&setup);
        signal(setup.child.id(), "TERM");
        signal(setup.child.id(), "TERM");
        let status = wait_for_exit(&mut setup.child);
        assert!(
            status.signal() == Some(15) || status.code() == Some(143),
            "unexpected relay status {status:?}"
        );
        wait_until_gone(&shell);
        wait_until_gone(&grand);
        assert!(
            !setup.state.join("relay-control.sock").exists(),
            "control socket removed"
        );
    }

    /// At trace verbosity the WebSocket client must not print the relay
    /// handshake (it carries the credential) or relay frames (they carry
    /// model requests and transcripts), whichever way trace is turned on.
    #[test]
    fn trace_logging_never_prints_the_credential_or_relay_frames() {
        // The credential and a marker the server puts in a frame body.
        const FRAME_MARKER: &str = "frame-body-marker-5c1e";
        /// Arguments, then extra environment.
        type Case<'a> = (&'a [&'a str], &'a [(&'a str, &'a str)]);
        let cases: [Case; 3] = [
            (&["-vv", "run"], &[]),
            (&["run"], &[("RUST_LOG", "trace")]),
            (&["run"], &[("WSMP_LOG", "trace")]),
        ];
        for (args, env) in cases {
            let log = tempfile::NamedTempFile::new().expect("log file");
            let stderr = Stdio::from(log.reopen().expect("reopen log"));
            let mut setup = start_relay_logged(args, json!({}), env, stderr);
            setup.relay.next_text("hello");
            let mut socket = setup
                .relay
                .socket
                .recv_timeout(Duration::from_secs(5))
                .expect("relay socket");
            // Not a frame the CLI understands, but it is read and dropped,
            // which is where a frame trace would print it.
            write_text(
                &mut socket,
                &json!({ "type": "x.unknown", "body": FRAME_MARKER }).to_string(),
            );
            // wsmp's own DEBUG line proves the verbose filter is in effect.
            write_text(
                &mut socket,
                r#"{"type":"heartbeat.pong","id":"pong-1","receivedAt":"2026-01-01T00:00:00Z"}"#,
            );
            thread::sleep(Duration::from_millis(500));
            signal(setup.child.id(), "TERM");
            let _ = wait_for_exit(&mut setup.child);
            let output = fs::read_to_string(log.path()).expect("read log");
            let case = format!("{args:?} {env:?}");
            assert!(
                output.contains("relay heartbeat acknowledged"),
                "{case}: verbose logging was not on:\n{output}"
            );
            for secret in [
                "signal-test-token",
                "Bearer",
                "authorization",
                "Authorization",
                "AAECAwQFBgcICQoLDA0ODw",
                FRAME_MARKER,
            ] {
                assert!(
                    !output.contains(secret),
                    "{case}: `{secret}` reached the log:\n{output}"
                );
            }
        }
    }

    /// JSON may escape an unpaired UTF-16 surrogate, which no Rust string can
    /// hold. Such a frame fails only the request it names; the daemon (model
    /// serving, every other terminal and command) keeps running.
    #[test]
    fn a_frame_with_a_lone_surrogate_fails_only_its_own_request() {
        let mut setup = start_relay(&["run"]);
        setup.relay.next_text("hello");
        let mut socket = setup
            .relay
            .socket
            .recv_timeout(Duration::from_secs(5))
            .expect("relay socket");
        write_text(
            &mut socket,
            r#"{"type":"exec.start","commandId":"bad-1","command":"echo \ud800","timeoutMs":60000}"#,
        );
        let rejected = setup.relay.next_text("exec.rejected");
        assert_eq!(rejected["commandId"], "bad-1");
        assert_eq!(rejected["reason"], "bad_command");
        // A cancel for an unknown command names nothing live: nothing happens.
        write_text(
            &mut socket,
            r#"{"type":"exec.cancel","commandId":"\udbff"}"#,
        );
        // Still serving: a well-formed command runs.
        write_text(
            &mut socket,
            &json!({ "type": "exec.start", "commandId": "good-1", "command": "echo ok", "timeoutMs": 60_000 })
                .to_string(),
        );
        assert_eq!(setup.relay.next_text("exec.started")["commandId"], "good-1");
        assert_eq!(setup.relay.next_text("exec.status")["commandId"], "good-1");
        assert!(
            setup.child.try_wait().expect("poll relay").is_none(),
            "the daemon exited on a malformed frame"
        );
        signal(setup.child.id(), "TERM");
        let _ = wait_for_exit(&mut setup.child);
    }
}

#[test]
fn config_read_grant_is_explicit_and_roots_are_validated() {
    let tmp = tempfile::tempdir().expect("home");
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let models = tmp.path().join("models");
    fs::create_dir(&models).expect("models");
    cli(&config, &state)
        .args(["config", "init"])
        .assert()
        .success();
    let mut show = cli(&config, &state);
    show.args(["config", "--json", "show"]);
    let value = json_stdout(show);
    assert_eq!(value["mcpFileRead"], false);
    assert_eq!(value["fileRoots"], json!([]));
    let disk: Value = serde_json::from_slice(&fs::read(&config).expect("config")).expect("json");
    assert!(disk.get("mcpFileRead").is_none());
    assert!(disk.get("fileRoots").is_none());
    cli(&config, &state)
        .args(["config", "set-file-read", "on"])
        .assert()
        .success();
    // `~` expands through the platform home directory, which HOME redirects on Unix only.
    let root_arg = if cfg!(unix) {
        "~/models".to_string()
    } else {
        models.to_str().expect("utf-8 temp path").to_string()
    };
    cli(&config, &state)
        .env("HOME", tmp.path())
        .args(["config", "set-file-roots", &root_arg])
        .assert()
        .success();
    let disk: Value = serde_json::from_slice(&fs::read(&config).expect("config")).expect("json");
    assert_eq!(disk["mcpFileRead"], true);
    assert_eq!(
        disk["fileRoots"],
        json!([fs::canonicalize(&models).expect("root")])
    );
    for args in [
        vec!["config", "set-file-roots"],
        vec!["config", "set-file-roots", "/"],
        vec!["config", "set-file-roots", "relative"],
        vec!["config", "set-file-read", "maybe"],
    ] {
        cli(&config, &state).args(args).assert().failure();
        let unchanged: Value =
            serde_json::from_slice(&fs::read(&config).expect("config")).expect("json");
        assert_eq!(unchanged, disk);
    }
    cli(&config, &state)
        .args(["config", "set-file-roots", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("~/models"))
        .stdout(predicate::str::contains("~/deploy"))
        .stdout(predicate::str::contains("~/.config/llama-swap"))
        .stdout(predicate::str::contains("~/.local/state/wsmp/logs"));
    cli(&config, &state)
        .args(["config", "clear-file-roots"])
        .assert()
        .success();
    cli(&config, &state)
        .args(["config", "set-file-read", "off"])
        .assert()
        .success();
    let mut show = cli(&config, &state);
    show.args(["config", "--json", "show"]);
    let value = json_stdout(show);
    assert_eq!(value["mcpFileRead"], false);
    assert_eq!(value["fileRoots"], json!([]));
}
