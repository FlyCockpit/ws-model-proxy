//! Config commands: `config init`, `show`, `set-server` and the local settings.

use crate::{cli, json_stdout};
use predicates::prelude::*;
use serde_json::{Value, json};
use std::fs;

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
    assert!(show_value.get("endpoints").is_none());
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
    // Trust is configured through `wsmp trust`.
    cli(&config, &state)
        .args(["config", "set-mcp-commands", "unsupervised"])
        .assert()
        .failure();
    cli(&config, &state)
        .args(["config", "set-terminal-approval", "on"])
        .assert()
        .success();
    let cfg: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(cfg["requireTerminalApproval"], true);
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
