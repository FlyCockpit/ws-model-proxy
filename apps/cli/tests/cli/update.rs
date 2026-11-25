//! Updates and the self-replace dead-man.

use crate::{TestServer, cli, json_stdout, write_config};
use predicates::prelude::*;
use serde_json::{Value, json};
use std::fs;
#[cfg(target_os = "linux")]
use std::path::Path;

#[test]
fn remote_updates_are_a_local_setting_and_update_status_reports_it() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    write_config(&config, json!({ "version": 3 }));
    let mut status = cli(&config, &state);
    status.args(["update", "status", "--json"]);
    let value = json_stdout(status);
    assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(value["remoteUpdates"], "allowed");
    // A `target/` build is a source build: it never replaces itself.
    assert_eq!(value["installMethod"], "source");
    assert_eq!(value["strategies"], json!([]));
    assert_eq!(value["lastUpdate"], Value::Null);
    assert!(value["target"].as_str().is_some_and(|t| !t.is_empty()));

    cli(&config, &state)
        .args(["config", "set-remote-updates", "off"])
        .assert()
        .success()
        .stdout(predicate::str::contains("`remoteUpdates` to `off`"));
    let disk: Value = serde_json::from_slice(&fs::read(&config).expect("config")).expect("json");
    assert_eq!(disk["remoteUpdates"], "off");
    let mut show = cli(&config, &state);
    show.args(["config", "--json", "show"]);
    assert_eq!(json_stdout(show)["remoteUpdates"], "off");
    cli(&config, &state)
        .args(["config", "set-remote-updates", "allowed"])
        .assert()
        .success();
    let disk: Value = serde_json::from_slice(&fs::read(&config).expect("config")).expect("json");
    assert!(
        disk.get("remoteUpdates").is_none(),
        "the default is not written"
    );
}

#[test]
fn update_reads_the_server_manifest() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    let server = TestServer::start(vec![(
        "/cli/manifest.json",
        200,
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "commit": null,
            "releaseUrl": null,
            "sourceBuild": false,
            "artifacts": {}
        }),
    )]);
    write_config(
        &config,
        json!({ "version": 3, "serverUrl": server.base_url, "trust": "full" }),
    );
    let mut current = cli(&config, &state);
    current.args(["update", "--json"]);
    let value = json_stdout(current);
    assert_eq!(value["outcome"], "current");
    assert!(!state.join("update").join("state.json").exists());

    let source = TestServer::start(vec![(
        "/cli/manifest.json",
        200,
        json!({
            "version": "99.0.0",
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "sourceBuild": true,
            "artifacts": {}
        }),
    )]);
    write_config(
        &config,
        json!({ "version": 3, "serverUrl": source.base_url, "trust": "full" }),
    );
    cli(&config, &state)
        .args(["update"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("cargo install"))
        .stderr(predicate::str::contains("--rev 0123456789abcdef"));
    assert!(!state.join("update").join("state.json").exists());
}

#[test]
fn the_update_dead_man_leaves_other_updates_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    let state = tmp.path().join("state");
    // No update state: nothing to roll back, nothing touched.
    cli(&config, &state)
        .args([
            "update",
            "rollback",
            "--if-unconfirmed",
            "AAAAAAAAAAAAAAAAAAAAAA",
            "--state-dir",
        ])
        .arg(&state)
        .assert()
        .success();
    assert!(!state.join("update").join("state.json").exists());
    // Hidden from help.
    cli(&config, &state)
        .args(["update", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("status"))
        .stdout(predicate::str::contains("rollback").not());
}

/// Review P14 (F-FA-5) against the built binary, with a fixture `systemctl` and no real
/// service: the dead-man rolls back, the relay's restart fails every try, and the run exits
/// nonzero with its job (the systemd units) kept; the next run, whose restart works, restarts
/// the relay and only then removes the job.
#[cfg(target_os = "linux")]
#[test]
fn a_dead_man_whose_relay_restart_fails_keeps_its_job_and_fails() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config.json");
    fs::write(&config, "{}\n").unwrap();
    let state = tmp.path().join("state");
    let update = state.join("update");
    fs::create_dir_all(&update).unwrap();
    let bin = tmp.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let units = tmp.path().join("xdg/systemd/user");
    fs::create_dir_all(&units).unwrap();
    for name in [
        "wsmp.service",
        "wsmp-update-deadman.service",
        "wsmp-update-deadman.timer",
    ] {
        fs::write(units.join(name), "[Service]\n").unwrap();
    }
    let calls = tmp.path().join("systemctl.log");
    let fail_restart = tmp.path().join("fail-restart");
    fs::write(&fail_restart, "").unwrap();
    let fixture = |name: &str, body: &str| {
        let path = bin.join(name);
        fs::write(&path, body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    };
    fixture(
        "systemctl",
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{calls}'\ncase \"$2\" in\n show) printf 'LoadState=loaded\\nActiveState=inactive\\n';;\n restart) if [ -e '{fail}' ]; then echo 'temporary service-manager failure' >&2; exit 1; fi;;\nesac\nexit 0\n",
            calls = calls.display(),
            fail = fail_restart.display()
        ),
    );
    fixture("journalctl", "#!/bin/sh\nexit 0\n");
    let live = bin.join("wsmp-live");
    let prev = bin.join("wsmp.prev");
    fs::write(&live, "new wsmp 0.4.3\n").unwrap();
    fs::write(&prev, "old wsmp 0.4.2\n").unwrap();
    let id = "AAAAAAAAAAAAAAAAAAAAAA";
    fs::write(
        update.join("state.json"),
        serde_json::to_vec(&json!({
            "updateId": id,
            "origin": "server",
            "strategy": "self-replace",
            "fromVersion": "0.4.2",
            "toVersion": "0.4.3",
            "livePath": live,
            "prevPath": prev,
            "recoveryPath": bin.join(".wsmp-recovery-AAAAAAAAAAAAAAAAAAAAAA"),
            "failedPath": bin.join("wsmp.failed"),
            "rollbackAfterSecs": 90,
            "deadline": 1,
            "deadmanAt": 1,
            "attempts": 1,
            "phase": "swapped",
            "reported": false,
            "updatedAt": "2026-10-31T00:00:00Z",
        }))
        .unwrap(),
    )
    .unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let run = || {
        let mut cmd = cli(&config, &state);
        cmd.env("PATH", &path)
            .env("XDG_CONFIG_HOME", tmp.path().join("xdg"))
            .args(["update", "rollback", "--if-unconfirmed", id, "--state-dir"])
            .arg(&state);
        cmd
    };
    let stored = || -> Value {
        serde_json::from_slice(&fs::read(update.join("state.json")).unwrap()).unwrap()
    };

    run()
        .assert()
        .failure()
        .stderr(predicate::str::contains("did not restart"));
    let log = fs::read_to_string(&calls).unwrap();
    assert_eq!(log.matches("restart").count(), 3, "{log}");
    assert!(
        !log.contains("disable --now wsmp-update-deadman.timer"),
        "{log}"
    );
    assert!(units.join("wsmp-update-deadman.timer").exists());
    assert!(units.join("wsmp-update-deadman.service").exists());
    assert!(fs::read_to_string(&live).unwrap().starts_with("old"));
    assert_eq!(stored()["phase"], "rolled_back");
    assert_eq!(stored()["restartPending"], true);

    // The job's next run: the restart works now.
    fs::remove_file(&fail_restart).unwrap();
    fs::write(&calls, "").unwrap();
    run().assert().success();
    let log = fs::read_to_string(&calls).unwrap();
    assert!(log.contains("--user restart"), "{log}");
    assert!(
        log.contains("disable --now wsmp-update-deadman.timer"),
        "{log}"
    );
    assert!(!units.join("wsmp-update-deadman.timer").exists());
    assert!(!units.join("wsmp-update-deadman.service").exists());
    assert!(stored().get("restartPending").is_none());
}

/// The fixture of a self-replace update whose new build never confirmed, as the installer
/// leaves it, with a stand-in `systemctl` (its `restart` fails while `fail-restart` exists) and
/// `journalctl`, and the real wsmp as the previous build. Nothing touches a real service.
#[cfg(target_os = "linux")]
struct DeadmanFixture {
    tmp: tempfile::TempDir,
    state: std::path::PathBuf,
    units: std::path::PathBuf,
    current: wsmp::update::state::UpdateState,
}

#[cfg(target_os = "linux")]
impl DeadmanFixture {
    /// A current update with its own recovery copy for the rollback job.
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        use wsmp::update::{install, state};
        let tmp = tempfile::tempdir().expect("fixture");
        let state_dir = tmp.path().join("state");
        let bin = tmp.path().join("bin");
        fs::create_dir_all(&bin).expect("fixture");
        let units = tmp.path().join("xdg/systemd/user");
        fs::create_dir_all(&units).expect("fixture");
        fs::write(units.join("wsmp.service"), "[Service]\n").expect("fixture");
        fs::write(tmp.path().join("fail-restart"), "").expect("fixture");
        let fixture = |name: &str, body: String| {
            let path = tmp.path().join("tools").join(name);
            fs::create_dir_all(path.parent().expect("fixture")).expect("fixture");
            fs::write(&path, body).expect("fixture");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("fixture");
        };
        fixture(
            "systemctl",
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{root}/systemctl.log'\ncase \"$2\" in\n show) printf 'LoadState=loaded\\nActiveState=inactive\\n';;\n restart) if [ -e '{root}/fail-restart' ]; then echo 'temporary service-manager failure' >&2; exit 1; fi;;\nesac\nexit 0\n",
                root = tmp.path().display()
            ),
        );
        fixture("journalctl", "#!/bin/sh\nexit 0\n".into());
        let layout =
            install::Layout::beside(&bin.join("wsmp"), "AAAAAAAAAAAAAAAAAAAAAA").expect("fixture");
        // The new build (it fails) is live; the previous build, the real wsmp, is the rollback
        // copy. Linked, not copied: the debug binary is large.
        fs::write(&layout.live, "#!/bin/sh\necho bad-new-build\nexit 1\n").expect("fixture");
        fs::set_permissions(&layout.live, fs::Permissions::from_mode(0o755)).expect("fixture");
        if fs::hard_link(env!("CARGO_BIN_EXE_wsmp"), &layout.prev).is_err() {
            fs::copy(env!("CARGO_BIN_EXE_wsmp"), &layout.prev).expect("fixture");
        }
        install::prepare_recovery(&layout.prev, &layout.recovery).expect("fixture");
        let current = state::UpdateState {
            update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            origin: state::Origin::Server,
            strategy: wsmp::protocol::runtime_spec::UpdateStrategy::SelfReplace,
            from_version: "0.4.2".into(),
            to_version: "0.4.3".into(),
            to_sha256: Some(install::sha256_file(&layout.live).expect("fixture")),
            live_path: layout.live.clone(),
            prev_path: layout.prev.clone(),
            recovery_path: Some(layout.recovery.clone()),
            failed_path: layout.failed.clone(),
            rollback_after_secs: 90,
            deadline: 1,
            deadman_at: Some(1),
            attempts: 1,
            lifecycle: state::Lifecycle::Swapped,
            reason: None,
            detail: None,
            updated_at: "2026-10-31T00:00:00Z".into(),
        };
        state::save(&state_dir.join("update"), &current).expect("fixture");
        Self {
            state: state_dir,
            units,
            current,
            tmp,
        }
    }

    /// The units this release writes for the job (as `SystemdTimer::register` does), and the
    /// `ExecStart` argv of the service: exactly what systemd runs.
    fn arm(&self) -> Vec<String> {
        use wsmp::update::{deadman, flow};
        let spec = flow::deadman_spec(
            &self.current,
            &self.state,
            std::time::Duration::from_secs(90),
        )
        .expect("fixture");
        let (service, timer) = deadman::systemd_units(&spec, 1).expect("fixture");
        fs::write(self.units.join("wsmp-update-deadman.service"), &service).expect("fixture");
        fs::write(self.units.join("wsmp-update-deadman.timer"), timer).expect("fixture");
        let exec = service
            .lines()
            .find_map(|line| line.strip_prefix("ExecStart="))
            .expect("fixture");
        // Plain words here (no quoting or `$`): systemd splits them on spaces.
        assert!(!exec.contains(['"', '\'', '$', '\\']), "{exec}");
        exec.split(' ').map(str::to_string).collect()
    }

    /// Run the job's program exactly as the scheduler does, in a clean environment.
    fn run_job(&self, job: &[String]) -> std::process::Output {
        let path = format!(
            "{}:{}",
            self.tmp.path().join("tools").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        std::process::Command::new(&job[0])
            .args(&job[1..])
            .current_dir(self.tmp.path())
            .env_clear()
            .env("PATH", path)
            .env("HOME", self.tmp.path())
            .env("XDG_CONFIG_HOME", self.tmp.path().join("xdg"))
            .env("XDG_RUNTIME_DIR", self.tmp.path().join("runtime"))
            .output()
            .expect("fixture")
    }

    fn stored(&self) -> Value {
        serde_json::from_slice(&fs::read(self.state.join("update/state.json")).expect("fixture"))
            .expect("fixture")
    }

    fn restarts(&self) -> usize {
        fs::read_to_string(self.tmp.path().join("systemctl.log"))
            .unwrap_or_default()
            .matches("--user restart wsmp.service")
            .count()
    }

    fn restart_works(&self) {
        fs::remove_file(self.tmp.path().join("fail-restart")).expect("fixture");
    }

    fn job_removed(&self) -> bool {
        !self.units.join("wsmp-update-deadman.timer").exists()
            && !self.units.join("wsmp-update-deadman.service").exists()
    }
}

/// Review F-FA-1 (P5, as a test): the program systemd runs for the dead-man is launched
/// itself, after a real restore and a relay restart that fails every try. That run exits
/// nonzero and keeps its job; its program is the recovery copy, which the restore (it consumed
/// `wsmp.prev`) did not touch, so the scheduler's next run of the same program starts, restarts
/// the relay, removes the job and then its program.
#[cfg(target_os = "linux")]
#[test]
fn the_dead_mans_scheduled_program_runs_again_after_a_failed_restart() {
    let node = DeadmanFixture::new();
    let job = node.arm();
    assert_eq!(
        Path::new(&job[0]),
        node.current.recovery_path.as_deref().unwrap()
    );
    assert_ne!(Path::new(&job[0]), node.current.prev_path);

    let first = node.run_job(&job);
    assert!(
        !first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(String::from_utf8_lossy(&first.stderr).contains("did not restart"));
    assert_eq!(node.restarts(), 3);
    assert_eq!(node.stored()["phase"], "rolled_back");
    assert_eq!(node.stored()["restartPending"], true);
    assert!(
        !node.current.prev_path.exists(),
        "the restore consumed the rollback copy"
    );
    assert!(
        Path::new(&job[0]).exists(),
        "the job's program is still there"
    );
    assert!(!node.job_removed());
    // The old build (the real wsmp) is live again.
    assert_eq!(
        wsmp::update::install::sha256_file(&node.current.live_path).unwrap(),
        wsmp::update::install::sha256_file(Path::new(&job[0])).unwrap()
    );

    // The scheduler's next run: exactly the same program and arguments.
    node.restart_works();
    let second = node.run_job(&job);
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(node.restarts(), 4);
    assert!(node.stored().get("restartPending").is_none());
    assert!(node.job_removed());
    assert!(
        !Path::new(&job[0]).exists(),
        "its program goes with the job"
    );
    assert!(node.current.live_path.exists());
}

/// F-FA-1: a rollback interrupted after the restore and before its terminal state was saved
/// (`rollingBack` recorded, `wsmp.prev` already moved back): the job's program is launched
/// again and finishes it: `rolled_back` saved, the relay restarted, the job and its program
/// removed.
#[cfg(target_os = "linux")]
#[test]
fn the_dead_mans_scheduled_program_finishes_a_rollback_cut_short_after_the_restore() {
    let mut node = DeadmanFixture::new();
    let job = node.arm();
    // What the interrupted run did: intent saved, then the restore, then it died.
    node.current.begin_rollback().unwrap();
    wsmp::update::state::save(&node.state.join("update"), &node.current).unwrap();
    let layout = wsmp::update::install::Layout {
        recovery: node.current.recovery_path.clone().unwrap(),
        ..wsmp::update::install::Layout::beside(&node.current.live_path, &node.current.update_id)
            .unwrap()
    };
    assert!(wsmp::update::install::restore(&layout).unwrap());
    assert!(!node.current.prev_path.exists());
    assert_eq!(node.stored()["phase"], "swapped");

    node.restart_works();
    let ran = node.run_job(&job);
    assert!(
        ran.status.success(),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
    assert_eq!(node.stored()["phase"], "rolled_back");
    assert!(node.stored().get("rollingBack").is_none());
    assert!(node.stored().get("restartPending").is_none());
    assert_eq!(node.restarts(), 1);
    assert!(node.job_removed());
    assert!(!Path::new(&job[0]).exists());
    assert!(
        fs::read_to_string(&node.current.failed_path)
            .unwrap()
            .contains("bad-new-build"),
        "the failed build is kept"
    );
}
