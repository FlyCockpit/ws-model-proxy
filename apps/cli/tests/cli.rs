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
    assert_eq!(show_value["version"], 3);
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

const CODE: &str = "wsmp_enr_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const IDENTITY_PREFIX: &str = "B";

fn well_known(origin: &str) -> Value {
    json!({
        "serverVersion": "0.4.0", "protocolVersion": "3.0", "origin": origin,
        "installScript": "/install.sh", "enrollPath": "/api/node/enroll"
    })
}

fn enrolled(slug: &str) -> Value {
    json!({
        "ok": true, "nodeId": "node-1", "slug": slug, "credential": "c".repeat(48),
        "replaced": null, "trustLowerPending": false
    })
}

#[test]
fn login_enrolls_with_a_code_and_stores_a_private_credential() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    // The server announces a public origin other than the URL: it is pinned.
    let server = TestServer::start(vec![
        (
            "/.well-known/wsmp",
            200,
            well_known("https://wsmp.example.com"),
        ),
        ("/api/node/enroll", 200, enrolled("spark-1")),
    ]);
    let mut cmd = cli(&config, &state);
    cmd.args([
        "login",
        &server.base_url,
        "--code",
        CODE,
        "--slug",
        "spark-1",
        "--trust",
        "relay",
        "--no-service",
        "--json",
    ]);
    let value = json_stdout(cmd);
    assert_eq!(value["slug"], "spark-1");
    assert_eq!(value["trust"], "relay");
    let well_known_request = server.requests.recv().unwrap();
    assert!(well_known_request.starts_with("GET /.well-known/wsmp "));
    let enroll_request = server.requests.recv().unwrap();
    assert!(enroll_request.starts_with("POST /api/node/enroll "));
    let body: Value =
        serde_json::from_str(enroll_request.split("\r\n\r\n").nth(1).expect("body")).unwrap();
    assert_eq!(body["code"], CODE);
    assert_eq!(body["slug"], "spark-1");
    assert_eq!(body["replaceConfirmed"], false);
    assert!(
        body["identityPublicKey"]
            .as_str()
            .unwrap()
            .starts_with(IDENTITY_PREFIX)
    );
    server.join();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["serverUrl"], value["server"]);
    assert_eq!(cfg["publicOrigin"], "https://wsmp.example.com");
    assert_eq!(cfg["cliSlug"], "spark-1");
    assert_eq!(cfg["trust"], "relay");
    let credential = state.join("node-credential.json");
    let saved: Value = serde_json::from_slice(&fs::read(&credential).unwrap()).unwrap();
    assert_eq!(saved["credential"], "c".repeat(48));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&credential).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // The code never reaches stdout or the config.
    assert!(!fs::read_to_string(&config).unwrap().contains(CODE));
}

#[test]
fn a_fresh_login_takes_the_chosen_trust_and_a_lowered_node_stays_lowered() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let server = TestServer::start(vec![
        (
            "/.well-known/wsmp",
            200,
            well_known("https://wsmp.example.com"),
        ),
        ("/api/node/enroll", 200, enrolled("spark-1")),
    ]);
    let mut cmd = cli(&config, &state);
    cmd.args([
        "login",
        &server.base_url,
        "--code",
        CODE,
        "--slug",
        "spark-1",
        "--trust",
        "full",
        "--no-service",
        "--json",
    ]);
    assert_eq!(json_stdout(cmd)["trust"], "full");
    server.join();
    // Lowered, then logged in again asking for full: stays relay.
    cli(&config, &state)
        .args(["trust", "relay"])
        .assert()
        .success();
    let server = TestServer::start(vec![
        (
            "/.well-known/wsmp",
            200,
            well_known("https://wsmp.example.com"),
        ),
        ("/api/node/enroll", 200, enrolled("spark-1")),
    ]);
    let mut again = cli(&config, &state);
    again.args([
        "login",
        &server.base_url,
        "--code",
        CODE,
        "--slug",
        "spark-1",
        "--trust",
        "full",
        "--no-service",
        "--json",
    ]);
    // A same-server re-login keeps the person's lowering, even with `--trust full`.
    assert_eq!(json_stdout(again)["trust"], "relay");
    assert!(state.join("frozen-definitions.json").exists());
    server.join();
    // Not from a process wsmp started.
    cli(&config, &state)
        .args([
            "login",
            "http://127.0.0.1:9",
            "--code",
            CODE,
            "--no-service",
        ])
        .env("WSMP_JOB", "1")
        .assert()
        .failure()
        .stderr(predicate::str::contains("cannot run from a command"));
}

/// Leftover 0.3 state (a config without `trust`, an old credential) is not
/// a lowering and not this node: the login takes `--trust` and a new name.
#[test]
fn a_login_over_leftover_0_3_state_is_a_fresh_enrollment() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(
        &config,
        json!({
            "version": 1,
            "serverUrl": "https://old.example.com",
            "cliSlug": "old-box",
            "endpoints": []
        }),
    );
    fs::create_dir_all(&state).unwrap();
    fs::write(
        state.join("node-credential.json"),
        json!({ "token": "old-0.3-credential", "server": "https://old.example.com" }).to_string(),
    )
    .unwrap();
    let server = TestServer::start(vec![
        (
            "/.well-known/wsmp",
            200,
            well_known("https://wsmp.example.com"),
        ),
        ("/api/node/enroll", 200, enrolled("fresh-box")),
    ]);
    let mut cmd = cli(&config, &state);
    cmd.args([
        "login",
        &server.base_url,
        "--code",
        CODE,
        "--trust",
        "full",
        "--no-service",
        "--json",
    ]);
    assert_eq!(json_stdout(cmd)["trust"], "full");
    server.requests.recv().unwrap();
    let enroll_request = server.requests.recv().unwrap();
    let body: Value =
        serde_json::from_str(enroll_request.split("\r\n\r\n").nth(1).expect("body")).unwrap();
    assert_ne!(body["slug"], "old-box", "the old node's name was reused");
    server.join();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["trust"], "full");
    assert_eq!(cfg["cliSlug"], "fresh-box");
}

/// A Relay-only setting an earlier enrollment (another server) left: a fresh
/// enrollment keeps it without an explicit choice and clears it with
/// `--trust full`.
#[test]
fn a_fresh_enrollment_clears_a_leftover_lowering_only_when_full_is_chosen() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let frozen = state.join("frozen-definitions.json");
    write_config(
        &config,
        json!({
            "version": 1,
            "serverUrl": "https://old.example.com",
            "cliSlug": "old-box",
            "trust": "full",
            "endpoints": []
        }),
    );
    cli(&config, &state)
        .args(["trust", "relay"])
        .assert()
        .success();
    assert!(frozen.exists());
    let login = |extra: &[&str]| {
        let server = TestServer::start(vec![
            (
                "/.well-known/wsmp",
                200,
                well_known("https://wsmp.example.com"),
            ),
            ("/api/node/enroll", 200, enrolled("fresh-box")),
        ]);
        let mut cmd = cli(&config, &state);
        cmd.args([
            "login",
            &server.base_url,
            "--code",
            CODE,
            "--slug",
            "fresh-box",
            "--no-service",
            "--json",
        ]);
        cmd.args(extra);
        let output = cmd.assert().success().get_output().clone();
        server.join();
        // Next login is to another server again: forget this enrollment.
        fs::remove_file(state.join("node-credential.json")).unwrap();
        let mut cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        cfg["serverUrl"] = "https://old.example.com".into();
        cfg.as_object_mut().unwrap().remove("publicOrigin");
        write_config(&config, cfg);
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        (value, String::from_utf8(output.stderr).unwrap())
    };
    // No explicit choice (no terminal, no `--trust`): stays Relay only.
    let (value, stderr) = login(&[]);
    assert_eq!(value["trust"], "relay");
    assert!(
        stderr.contains("pass `--trust full` to clear that"),
        "{stderr}"
    );
    assert!(!stderr.contains("full control"), "{stderr}");
    assert!(frozen.exists());
    // An explicit `--trust relay` keeps it too.
    let (value, _) = login(&["--trust", "relay"]);
    assert_eq!(value["trust"], "relay");
    assert!(frozen.exists());
    // An explicit `--trust full` clears it, and says so.
    let (value, stderr) = login(&["--trust", "full"]);
    assert_eq!(value["trust"], "full", "{stderr}");
    assert!(
        stderr.contains("cleared the Relay-only setting"),
        "{stderr}"
    );
    assert!(!frozen.exists());
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["trust"], "full");
}

#[test]
fn login_sets_browser_terminals_by_flag_and_keeps_them_without_a_terminal() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let login = |extra: &[&str]| {
        let server = TestServer::start(vec![
            (
                "/.well-known/wsmp",
                200,
                well_known("https://wsmp.example.com"),
            ),
            ("/api/node/enroll", 200, enrolled("spark-1")),
        ]);
        let mut cmd = cli(&config, &state);
        cmd.args([
            "login",
            &server.base_url,
            "--code",
            CODE,
            "--slug",
            "spark-1",
            "--trust",
            "full",
            "--no-service",
        ]);
        cmd.args(extra);
        let output = cmd.assert().success().get_output().clone();
        server.join();
        let saved: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        (
            String::from_utf8(output.stdout).unwrap(),
            String::from_utf8(output.stderr).unwrap(),
            saved["allowHumanTerminal"].as_bool().unwrap_or(false),
        )
    };
    // No terminal, no flag: off, and the output says so.
    let (stdout, stderr, saved) = login(&["--json"]);
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["allowHumanTerminal"], false);
    assert!(!saved);
    assert!(
        stderr.contains("no terminal to ask, so browser terminals stay off"),
        "{stderr}"
    );
    // The flag turns them on, without the warning.
    let (stdout, stderr, saved) = login(&["--human-terminal", "on"]);
    assert!(stdout.contains("browser terminals: on"), "{stdout}");
    assert!(saved);
    assert!(!stderr.contains("no terminal to ask"), "{stderr}");
    // A re-login that changes it reminds a running relay to restart.
    assert!(
        stderr.contains("restart wsmp if it is already running"),
        "{stderr}"
    );
    // A later login without the flag keeps the saved choice.
    let (stdout, stderr, saved) = login(&["--json"]);
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["allowHumanTerminal"], true);
    assert!(saved);
    assert!(stderr.contains("browser terminals stay on"), "{stderr}");
    assert!(!stderr.contains("restart wsmp"), "{stderr}");
    // `off` turns them off again; the config command still works after.
    let (_, _, saved) = login(&["--human-terminal", "off"]);
    assert!(!saved);
    // Relay only: nothing to warn about, but an explicit flag is still saved
    // and the output says terminals need full control.
    let relay = tmp.path().join("relay");
    let relay_config = relay.join("config.json");
    let relay_state = relay.join("state");
    let relay_login = |extra: &[&str]| {
        let server = TestServer::start(vec![
            (
                "/.well-known/wsmp",
                200,
                well_known("https://wsmp.example.com"),
            ),
            ("/api/node/enroll", 200, enrolled("spark-2")),
        ]);
        let mut cmd = cli(&relay_config, &relay_state);
        cmd.args([
            "login",
            &server.base_url,
            "--code",
            CODE,
            "--slug",
            "spark-2",
            "--trust",
            "relay",
            "--no-service",
        ]);
        cmd.args(extra);
        let output = cmd.assert().success().get_output().clone();
        server.join();
        (
            String::from_utf8(output.stdout).unwrap(),
            String::from_utf8(output.stderr).unwrap(),
        )
    };
    let (stdout, stderr) = relay_login(&[]);
    assert!(stdout.contains("browser terminals: off"), "{stdout}");
    assert!(
        !stderr.contains("no terminal to ask, so browser"),
        "{stderr}"
    );
    let (stdout, _) = relay_login(&["--human-terminal", "on"]);
    assert!(
        stdout.contains("browser terminals: on (they need full control)"),
        "{stdout}"
    );
    let cfg: Value = serde_json::from_slice(&fs::read(&relay_config).unwrap()).unwrap();
    assert_eq!(cfg["allowHumanTerminal"], true);
    cli(&config, &state)
        .args(["config", "set-human-terminal", "on"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["allowHumanTerminal"], true);
    // Anything but on|off is refused before contacting a server.
    cli(&config, &state)
        .args([
            "login",
            "http://127.0.0.1:9",
            "--code",
            CODE,
            "--human-terminal",
            "yes",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("--human-terminal"));
}

#[test]
fn login_refuses_a_malformed_code_before_any_exchange() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let server = TestServer::start(vec![(
        "/.well-known/wsmp",
        200,
        well_known("https://wsmp.example.com"),
    )]);
    cli(&config, &state)
        .args([
            "login",
            &server.base_url,
            "--code",
            "nope",
            "--slug",
            "node-a",
            "--no-service",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("not an enrollment code"));
    server.join();
    assert!(!state.join("node-credential.json").exists());
}

#[test]
fn login_refuses_a_server_on_another_protocol() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let mut old = well_known("https://wsmp.example.com");
    old["protocolVersion"] = json!("2.4");
    let server = TestServer::start(vec![("/.well-known/wsmp", 200, old)]);
    cli(&config, &state)
        .args([
            "login",
            &server.base_url,
            "--code",
            CODE,
            "--slug",
            "node-a",
            "--no-service",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("upgrade the server"));
    server.join();
}

#[test]
fn login_needs_replace_confirmation_without_a_terminal() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let server = TestServer::start(vec![
        (
            "/.well-known/wsmp",
            200,
            well_known("https://wsmp.example.com"),
        ),
        (
            "/api/node/enroll",
            409,
            json!({ "ok": false, "error": "replace_confirmation_required", "replaces": { "slug": "old-1" } }),
        ),
    ]);
    cli(&config, &state)
        .args([
            "login",
            &server.base_url,
            "--code",
            CODE,
            "--slug",
            "node-a",
            "--no-service",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("This replaces node old-1"))
        .stderr(predicate::str::contains("--replace"));
    server.join();
    assert!(!state.join("node-credential.json").exists());
}

#[test]
fn login_reports_a_taken_slug() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let server = TestServer::start(vec![
        (
            "/.well-known/wsmp",
            200,
            well_known("https://wsmp.example.com"),
        ),
        (
            "/api/node/enroll",
            409,
            json!({ "ok": false, "error": "slug_taken" }),
        ),
    ]);
    cli(&config, &state)
        .args([
            "login",
            &server.base_url,
            "--code",
            CODE,
            "--slug",
            "node-a",
            "--no-service",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("--slug"));
    server.join();
}

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
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["allowHumanTerminal"], true);
    assert!(cfg.get("requireTerminalApproval").is_none());
    // The 0.3 command switches are gone: trust is the one switch.
    cli(&config, &state)
        .args(["config", "set-mcp-commands", "unsupervised"])
        .assert()
        .failure();
    // A config from an older wsmp loses its old switches on the next write.
    fs::write(
        &config,
        r#"{"version":1,"allowMcpCommands":true,"mcpCommandMode":"unsupervised"}"#,
    )
    .unwrap();
    cli(&config, &state)
        .args(["config", "set-terminal-approval", "on"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert!(cfg.get("mcpCommandMode").is_none());
    assert!(cfg.get("allowMcpCommands").is_none());
    assert!(cfg.get("trust").is_none());
    cli(&config, &state)
        .args(["config", "set-terminal-approval", "off"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Restart wsmp to apply."));
}

#[test]
fn config_runtime_hosts_take_ip_literals_only() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    cli(&config, &state)
        .args(["config", "set-runtime-hosts", "10.0.0.5:8000", "[fd00::1]"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["runtimeHosts"], json!(["10.0.0.5:8000", "[fd00::1]"]));
    cli(&config, &state)
        .args(["config", "set-runtime-hosts", "gpu.lan"])
        .assert()
        .failure();
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
            "endpoints": [{
                "slug": "local", "label": "local", "baseUrl": "http://127.0.0.1:8000",
                "headers": [{ "name": "Authorization", "env": "WSMP_SERVICE_SYNC_TOKEN" }]
            }]
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
        start_relay_prepared(args, extra, env, stderr, &|_| {})
    }

    /// `start_relay_logged`, with `prepare` run on the state dir first.
    fn start_relay_prepared(
        args: &[&str],
        extra: Value,
        env: &[(&str, &str)],
        stderr: Stdio,
        prepare: &dyn Fn(&Path),
    ) -> Setup {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().canonicalize().expect("canonical tempdir");
        let config = dir.join("config.json");
        let state = dir.join("state");
        fs::create_dir_all(&state).expect("state dir");
        prepare(&state);
        let relay = FakeRelay::start();
        let mut value = json!({
            "version": 1,
            "serverUrl": relay.server_url,
            "cliSlug": "cli-signal-test",
            "trust": "full",
            "endpoints": []
        });
        if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        write_config(&config, value);
        fs::create_dir_all(&state).expect("state dir");
        fs::write(
            state.join("node-credential.json"),
            json!({
                "nodeId": "node-1", "slug": "cli-signal-test", "server": relay.server_url,
                "credential": "signal-test-token"
            })
            .to_string(),
        )
        .expect("credential");
        let child = std::process::Command::new(env!("CARGO_BIN_EXE_wsmp"))
            .args(args)
            .env("WSMP_CONFIG", &config)
            .env("WSMP_STATE_DIR", &state)
            .env("HOME", &dir)
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
        hello_ok(&mut socket);
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
        hello_ok(&mut socket);
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

    /// A one-request HTTP upstream; returns its base URL and the request it saw.
    fn upstream(body: &'static str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind upstream");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let request = read_request(&mut stream);
                let _ = tx.send(request);
                write_response(&mut stream, 200, body.as_bytes());
            }
        });
        (base, rx)
    }

    fn hello_ok(socket: &mut TcpStream) {
        write_text(
            socket,
            r#"{"type":"hello.ok","id":"h-1","protocolVersion":"3.0","nodeId":"node-1","definitionSync":"expect"}"#,
        );
    }

    fn define_always_on(socket: &mut TcpStream, op: &str, base_url: &str, auth: Option<&str>) {
        let mut spec = json!({
            "api": "openai", "engine": "vllm", "modelType": "llm",
            "models": [{ "id": "tiny" }],
            "address": { "baseUrl": base_url }
        });
        if let Some(env) = auth {
            spec["address"]["auth"] = json!({ "mode": "bearer", "env": env });
        }
        let hash = wsmp::protocol::canonical::launch_hash(&spec).expect("hash");
        write_text(
            socket,
            &json!({
                "type": "runtime.define", "opId": op, "chunkIndex": 0, "final": true,
                "put": [{
                    "runtimeId": "rt1", "versionId": "vr1", "launchHash": hash,
                    "kind": "always_on", "slug": "tiny", "spec": spec
                }]
            })
            .to_string(),
        );
    }

    /// Enrolled node, Full control: the server defines an always-on runtime,
    /// the node holds it, reports it, and relays a request to it, with the
    /// node secret as the bearer credential and never in the log.
    #[test]
    fn end_to_end_define_hold_and_relay_to_an_always_on_runtime() {
        let log = tempfile::NamedTempFile::new().expect("log file");
        let stderr = Stdio::from(log.reopen().expect("reopen log"));
        let mut setup = start_relay_logged(&["-vv", "run"], json!({}), &[], stderr);
        let hello = setup.relay.next_text("hello");
        assert_eq!(hello["trust"]["value"], "full");
        assert_eq!(hello["definitions"], json!([]));
        let mut socket = setup
            .relay
            .socket
            .recv_timeout(Duration::from_secs(5))
            .expect("relay socket");
        hello_ok(&mut socket);
        setup.relay.next_text("runtime.inventory");
        // The secret arrives over the relay; its value must never be logged.
        const SECRET: &str = "secret-value-7f3a9c";
        write_text(
            &mut socket,
            &json!({ "type": "secret.set", "id": "s1", "name": "WSMP_SECRET_TINY", "value": SECRET })
                .to_string(),
        );
        let result = setup.relay.next_text("secret.result");
        assert_eq!(result["status"], "set");
        assert!(!result.to_string().contains(SECRET));
        let (base, seen) = upstream(r#"{"id":"c1","choices":[]}"#);
        define_always_on(
            &mut socket,
            "op1",
            &format!("{base}/v1"),
            Some("WSMP_SECRET_TINY"),
        );
        let defined = setup.relay.next_text("runtime.define.result");
        assert_eq!(defined["results"][0]["status"], "applied", "{defined}");
        assert_eq!(defined["held"][0]["versionId"], "vr1");
        let inventory = setup.relay.next_text("runtime.inventory");
        assert_eq!(inventory["alwaysOn"][0]["slug"], "tiny");
        assert_eq!(inventory["alwaysOn"][0]["models"][0]["id"], "tiny");
        write_text(
            &mut socket,
            &json!({
                "type": "relay.request", "requestId": "r1", "family": "chat.completions",
                "method": "POST", "path": "/v1/chat/completions", "headers": {}, "timeoutMs": 10_000,
                "handle": "tiny", "expectBody": false
            })
            .to_string(),
        );
        let headers = setup.relay.next_text("relay.response.headers");
        assert_eq!(headers["status"], 200);
        let request = loop {
            let request = seen
                .recv_timeout(Duration::from_secs(10))
                .expect("upstream saw it");
            if request.starts_with("POST ") {
                break request;
            }
        };
        assert!(
            request.starts_with("POST /v1/chat/completions "),
            "{request}"
        );
        assert!(request.contains(&format!("Bearer {SECRET}")));
        setup.relay.next_text("relay.complete");
        // An engine admin route is refused before any connection.
        write_text(
            &mut socket,
            &json!({
                "type": "relay.request", "requestId": "r3", "family": "generic",
                "method": "POST", "path": "/api/pull", "headers": {}, "timeoutMs": 10_000,
                "handle": "tiny", "expectBody": false
            })
            .to_string(),
        );
        let refused = setup.relay.next_text("relay.error");
        assert_eq!(refused["requestId"], "r3");
        assert_eq!(refused["failure"], "access_denied");
        assert_eq!(refused["message"], "path_not_allowed");
        assert!(
            seen.recv_timeout(Duration::from_millis(300))
                .map_or(true, |request| !request.contains("/api/pull")),
            "the refused path reached the upstream"
        );
        // An unknown handle is refused without reaching anything.
        write_text(
            &mut socket,
            &json!({
                "type": "relay.request", "requestId": "r2", "family": "chat.completions",
                "method": "GET", "path": "/v1/models", "headers": {}, "timeoutMs": 10_000,
                "handle": "nope", "expectBody": false
            })
            .to_string(),
        );
        assert_eq!(setup.relay.next_text("relay.error")["requestId"], "r2");
        signal(setup.child.id(), "TERM");
        let _ = wait_for_exit(&mut setup.child);
        let output = fs::read_to_string(log.path()).expect("read log");
        assert!(
            !output.contains(SECRET),
            "the secret reached the log:\n{output}"
        );
        // The definition survives a restart: a new relay reports it held.
        let stored = fs::read_to_string(setup.state.join("runtime-store.json")).expect("store");
        assert!(stored.contains("vr1"));
        assert!(!stored.contains(SECRET));
    }

    /// A startable definition is held; a job naming it with a value outside
    /// the node's rules is refused before admission, and a job naming a
    /// version the node does not hold is `definition_missing`.
    #[test]
    fn runtime_jobs_render_only_from_held_definitions() {
        let mut setup = start_relay(&["run"]);
        setup.relay.next_text("hello");
        let mut socket = setup
            .relay
            .socket
            .recv_timeout(Duration::from_secs(5))
            .expect("relay socket");
        hello_ok(&mut socket);
        setup.relay.next_text("runtime.inventory");
        let spec = json!({
            "api": "openai", "engine": "vllm", "modelType": "llm",
            "models": [{ "id": "m" }],
            "launch": {
                "management": "process", "groupSize": 1,
                "resources": [{ "kind": "none" }], "labels": [],
                "commands": [{ "start": "vllm serve m --host 127.0.0.1 --port {{port}}", "stop": "true" }],
                "readiness": { "path": "/health", "expectedStatus": 200, "timeoutMs": 60000 },
                "health": { "intervalMs": 30000, "failureThreshold": 3, "successThreshold": 1 }
            }
        });
        let hash = wsmp::protocol::canonical::launch_hash(&spec).expect("hash");
        let commands = json!([]);
        let fabrics = json!([]);
        write_text(
            &mut socket,
            &json!({
                "type": "runtime.define", "opId": "op1", "chunkIndex": 0, "final": true,
                "put": [{
                    "runtimeId": "rt1", "versionId": "vr1", "launchHash": hash,
                    "kind": "startable", "slug": "qwen", "spec": spec
                }],
                "node": {
                    "portRange": [30000, 30999],
                    "metricCommands": {
                        "hash": wsmp::protocol::canonical::canonical_sha256(&commands).expect("hash"),
                        "commands": commands
                    },
                    "fabrics": {
                        "hash": wsmp::protocol::canonical::canonical_sha256(&fabrics).expect("hash"),
                        "sets": fabrics
                    },
                    "commandMaxMs": 86_400_000
                }
            })
            .to_string(),
        );
        let defined = setup.relay.next_text("runtime.define.result");
        assert_eq!(defined["results"][0]["status"], "applied", "{defined}");
        assert_eq!(defined["heldPortRange"], json!([30000, 30999]));
        let job = |step: &str, version: &str, port: u16| {
            json!({
                "type": "runtime.job", "stepId": step, "instanceId": "in1",
                "runtimeId": "rt1", "launchVersionId": version, "launchHash": hash,
                "generation": 1, "rank": 0, "nnodes": 1, "phase": "start",
                "handle": "i-abcdefabcdef", "unitName": "wsmp-i-abcdefabcdef-r0",
                "placeholders": { "port": port }, "timeoutMs": 60_000,
                "ownerEpoch": "epoch:1", "intentHash": "a".repeat(64)
            })
            .to_string()
        };
        write_text(&mut socket, &job("st1", "vr1", 22_000));
        let refused = setup.relay.next_text("runtime.job.result");
        assert_eq!(refused["error"], "bad_job", "{refused}");
        assert_eq!(refused["detail"], "placeholders.port");
        write_text(&mut socket, &job("st2", "vr-not-held", 30_001));
        let missing = setup.relay.next_text("runtime.job.result");
        assert_eq!(missing["error"], "definition_missing", "{missing}");
        signal(setup.child.id(), "TERM");
        let _ = wait_for_exit(&mut setup.child);
    }

    /// A node that was lowered stays lowered across a restart even when
    /// config.json was edited back to `full`: only `wsmp trust full` raises.
    #[test]
    fn a_frozen_copy_keeps_a_hand_raised_node_relay_only() {
        let mut setup = start_relay_prepared(&["run"], json!({}), &[], Stdio::null(), &|state| {
            fs::write(
                state.join("frozen-definitions.json"),
                r#"{"version":1,"held":[]}"#,
            )
            .expect("frozen");
        });
        let hello = setup.relay.next_text("hello");
        assert_eq!(hello["trust"], json!({ "value": "relay", "frozen": true }));
        let config: Value =
            serde_json::from_slice(&fs::read(setup.dir.join("config.json")).expect("config"))
                .expect("json");
        assert_eq!(config["trust"], "relay");
        signal(setup.child.id(), "TERM");
        let _ = wait_for_exit(&mut setup.child);
    }

    /// `trust.lower` sticks: persisted, frozen, reported; defines are refused.
    #[test]
    fn trust_lower_persists_freezes_and_refuses_defines() {
        let mut setup = start_relay(&["run"]);
        setup.relay.next_text("hello");
        let mut socket = setup
            .relay
            .socket
            .recv_timeout(Duration::from_secs(5))
            .expect("relay socket");
        hello_ok(&mut socket);
        setup.relay.next_text("runtime.inventory");
        write_text(
            &mut socket,
            r#"{"type":"trust.lower","id":"t1","requestedAt":"2026-10-06T00:00:00Z"}"#,
        );
        let state = setup.relay.next_text("node.state");
        assert_eq!(state["trust"], json!({ "value": "relay", "frozen": true }));
        let config: Value =
            serde_json::from_slice(&fs::read(setup.dir.join("config.json")).expect("config"))
                .expect("json");
        assert_eq!(config["trust"], "relay");
        assert!(setup.state.join("frozen-definitions.json").exists());
        define_always_on(&mut socket, "op1", "http://127.0.0.1:9/v1", None);
        let refused = setup.relay.next_text("runtime.define.result");
        assert_eq!(refused["results"][0]["reason"], "trust_relay");
        assert_eq!(refused["frozen"], true);
        // Commands are refused at Relay only.
        write_text(
            &mut socket,
            &json!({ "type": "exec.start", "commandId": "c1", "command": "true", "timeoutMs": 60_000 })
                .to_string(),
        );
        assert_eq!(
            setup.relay.next_text("exec.rejected")["reason"],
            "trust_relay"
        );
        // Remote secret writes are refused at Relay only (set them on the node).
        write_text(
            &mut socket,
            &json!({ "type": "secret.set", "id": "s9", "name": "WSMP_SECRET_X", "value": "v-123" })
                .to_string(),
        );
        let refused = setup.relay.next_text("secret.result");
        assert_eq!(refused["status"], "refused");
        assert_eq!(refused["reason"], "trust_relay");
        assert!(!setup.state.join("node-secrets.json").exists());
        // A hand edit back to `full` does not raise: the daemon writes relay back.
        let mut edited = config.clone();
        edited["trust"] = json!("full");
        write_config(&setup.dir.join("config.json"), edited);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let now: Value =
                serde_json::from_slice(&fs::read(setup.dir.join("config.json")).expect("config"))
                    .expect("json");
            if now["trust"] == "relay" {
                break;
            }
            assert!(Instant::now() < deadline, "the hand-edited raise stuck");
            thread::sleep(Duration::from_millis(100));
        }
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
    let home_root = fs::canonicalize(tmp.path()).expect("home root");
    let show_roots = || {
        let mut show = cli(&config, &state);
        show.env("HOME", tmp.path())
            .args(["config", "--json", "show"]);
        let value = json_stdout(show);
        (value["fileRoots"].clone(), value["fileRootsSource"].clone())
    };
    // Unset roots: the home directory, said to be the default.
    if cfg!(unix) {
        assert_eq!(show_roots(), (json!([home_root]), json!("default")));
    }
    let disk: Value = serde_json::from_slice(&fs::read(&config).expect("config")).expect("json");
    assert!(disk.get("fileRoots").is_none());
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
    assert_eq!(
        disk["fileRoots"],
        json!([fs::canonicalize(&models).expect("root")])
    );
    for args in [
        vec!["config", "set-file-roots"],
        vec!["config", "set-file-roots", "/"],
        vec!["config", "set-file-roots", "relative"],
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
        .stdout(predicate::str::contains("~/.config/llama-swap"));
    assert_eq!(show_roots().1, json!("configured"));
    cli(&config, &state)
        .args(["config", "clear-file-roots"])
        .assert()
        .success();
    if cfg!(unix) {
        assert_eq!(show_roots(), (json!([home_root]), json!("default")));
    }
    cli(&config, &state)
        .args(["config", "set-file-tools", "off"])
        .assert()
        .success();
    assert_eq!(show_roots(), (json!([]), json!("disabled")));
    let disk: Value = serde_json::from_slice(&fs::read(&config).expect("config")).expect("json");
    assert_eq!(disk["disableFileTools"], json!(true));
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
