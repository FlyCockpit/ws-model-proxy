//! Enrollment with `wsmp login`.

#[cfg(unix)]
use crate::write_config;
use crate::{TestServer, cli, json_stdout};
use predicates::prelude::*;
use serde_json::{Value, json};
use std::fs;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::thread;

const CODE: &str = "wsmp_enr_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const IDENTITY_PREFIX: &str = "B";

fn well_known(origin: &str) -> Value {
    json!({
        "serverVersion": "1.0.0", "protocolVersion": "4.0", "origin": origin,
        "installScript": "/install.sh", "enrollPath": "/api/node/enroll"
    })
}

fn enrolled(slug: &str) -> Value {
    json!({
        "ok": true, "nodeId": "node-1", "slug": slug, "credential": "c".repeat(48),
        "replaced": null, "trustLowerPending": false, "removeAfterOfflineMs": null
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

/// A Relay-only setting an earlier enrollment (another server) left: a fresh
/// enrollment keeps it without an explicit choice and clears it with
/// `--trust full`.
// Clearing needs to know no relay runs; Windows cannot tell, so it always keeps the lowering.
#[cfg(unix)]
#[test]
fn a_fresh_enrollment_clears_a_leftover_lowering_only_when_full_is_chosen() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let frozen = state.join("frozen-definitions.json");
    write_config(
        &config,
        json!({
            "version": 3,
            "serverUrl": "https://old.example.com",
            "cliSlug": "old-box",
            "trust": "full"
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
    // Not while a relay runs here: its reload would write `relay` back.
    #[cfg(unix)]
    {
        let listener = std::os::unix::net::UnixListener::bind(state.join("relay-control.sock"))
            .expect("bind a stand-in relay control socket");
        let relay = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("control request");
            let mut request = String::new();
            stream.read_to_string(&mut request).expect("read request");
            stream.write_all(br#"{"ok":true}"#).expect("answer");
        });
        let (value, stderr) = login(&["--trust", "full"]);
        relay.join().unwrap();
        fs::remove_file(state.join("relay-control.sock")).unwrap();
        assert_eq!(value["trust"], "relay", "{stderr}");
        assert!(stderr.contains("a relay is running here"), "{stderr}");
        assert!(!stderr.contains("pass `--trust full`"), "{stderr}");
        assert!(frozen.exists());
    }
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
    old["protocolVersion"] = json!("3.0");
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
