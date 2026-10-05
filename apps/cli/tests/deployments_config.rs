use assert_cmd::Command;
use serde_json::Value;

#[test]
fn local_deployment_opt_in_round_trips_and_defaults_off() {
    let root = tempfile::tempdir().expect("root");
    let path = root.path().join("config.json");
    let state = root.path().join("state");
    assert!(!wsmp::config::Config::default().allow_deployments);
    for enabled in [true, false] {
        let result = Command::cargo_bin("wsmp")
            .expect("binary")
            .env("WSMP_CONFIG", &path)
            .env("WSMP_STATE_DIR", &state)
            .env_remove("WSMP_LOG")
            .env_remove("RUST_LOG")
            .args([
                "config",
                "--json",
                "set-deployments",
                if enabled { "on" } else { "off" },
            ])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let output: Value = serde_json::from_slice(&result).expect("JSON");
        assert_eq!(output["key"], "allowDeployments");
        assert_eq!(output["value"], enabled);
        let config: wsmp::config::Config =
            serde_json::from_slice(&std::fs::read(&path).expect("config file")).expect("config");
        assert_eq!(config.allow_deployments, enabled);
    }
}
