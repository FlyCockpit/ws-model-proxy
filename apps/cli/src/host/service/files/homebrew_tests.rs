//! The production path through the update child: [`ensure_stable_executable`]
//! and the whole Homebrew update, run by a parent test as a child of the test
//! binary.

use super::tests::*;
use super::*;
use crate::host::service::text::{
    path_text, render_launch_agent_plist, render_macos_service_wrapper, render_systemd_user_unit,
};

/// The production path, on Linux, run by a parent test as a child of this
/// test binary (so the environment is its own): with `WSMP_TEST_THROUGH`
/// `ensure`, [`ensure_stable_executable`] for the Homebrew prefix
/// `WSMP_TEST_PREFIX`; with `update`, the whole Homebrew update
/// ([`crate::relay::update::agent::homebrew`], its service step that same
/// function) against that prefix's fake `brew`. Writes what happened to
/// `WSMP_TEST_THROUGH_OUT`; a no-op in an ordinary test run.
#[cfg(target_os = "linux")]
#[test]
fn through_the_update_child() {
    use crate::relay::update::flow::{Machine, Progress, Request};
    use crate::wire::protocol::frames::{UpdatePhase, UpdateReason};

    struct Log(String);
    impl Progress for Log {
        fn report(
            &mut self,
            phase: UpdatePhase,
            reason: Option<UpdateReason>,
            detail: Option<String>,
        ) {
            self.0.push_str(&format!(
                "{phase:?} {reason:?} {}\n",
                detail.unwrap_or_default().replace('\n', " ")
            ));
        }
    }

    let Some(out) = std::env::var_os("WSMP_TEST_THROUGH_OUT") else {
        return;
    };
    let prefix = PathBuf::from(std::env::var_os("WSMP_TEST_PREFIX").expect("prefix"));
    let live = prefix.join("Cellar/wsmp/0.4.2/bin/wsmp");
    let stable = crate::relay::update::homebrew::stable_path(&live).expect("a keg");
    let result = match std::env::var("WSMP_TEST_THROUGH").as_deref() {
        Ok("update") => {
            let machine = Machine {
                state_dir: PathBuf::from(std::env::var_os("WSMP_STATE_DIR").expect("state")),
                live,
                target: "test-target".into(),
                scheduler: None,
                tar: crate::relay::update::install::system_tar(),
                current_version: "0.4.2".into(),
                before_swap: None,
                proceed: None,
                stable_service: ensure_stable_executable,
            };
            let request = Request {
                update_id: "u-1".into(),
                version: "0.4.3".into(),
                artifact_url: String::new(),
                sha256: String::new(),
                signature: None,
                rollback_after_secs: 90,
                origin: crate::relay::update::state::Origin::Cli,
            };
            let mut log = Log(String::new());
            let ended = crate::relay::update::agent::homebrew(&machine, &request, &mut log);
            format!("{ended:?}\n{}", log.0)
        }
        _ => match ensure_stable_executable(&stable) {
            Ok(()) => "ok".to_string(),
            Err(error) => format!("error: {error:#}").replace('\n', " "),
        },
    };
    std::fs::write(out, result).expect("write the result");
}

/// A Homebrew prefix for [`through_the_update_child`]: kegs 0.4.2 (the
/// running one, from `flycockpit/tap`) as `opt/wsmp`; a fake `brew` whose
/// tap has 0.4.3 and whose `upgrade` pours that keg (its binary's mode
/// from `upgrade-mode`) and moves `opt/wsmp` to it; a fake `systemctl`
/// that logs what it is asked; `XDG_CONFIG_HOME` here.
#[cfg(target_os = "linux")]
struct Through {
    dir: tempfile::TempDir,
    unit: PathBuf,
    /// `opt/wsmp/bin/wsmp`.
    stable: String,
}

#[cfg(target_os = "linux")]
impl Through {
    fn new() -> Self {
        Self::named(".tmp")
    }

    /// [`Through::new`] in a directory whose name starts with `name`.
    fn named(name: &str) -> Self {
        let dir = tempfile::Builder::new()
            .prefix(name)
            .tempdir()
            .expect("dir");
        let root = dir.path().display().to_string();
        let keg = dir.path().join("Cellar/wsmp/0.4.2");
        std::fs::create_dir_all(keg.join("bin")).expect("keg");
        std::fs::write(keg.join("bin/wsmp"), keg_script("0.4.2")).expect("wsmp");
        set_mode(&keg.join("bin/wsmp"), 0o755);
        std::fs::write(
            keg.join("INSTALL_RECEIPT.json"),
            r#"{"source":{"tap":"flycockpit/tap"}}"#,
        )
        .expect("receipt");
        std::fs::create_dir_all(dir.path().join("opt")).expect("opt");
        std::os::unix::fs::symlink(&keg, dir.path().join("opt/wsmp")).expect("link");
        std::fs::create_dir_all(dir.path().join("bin")).expect("bin");
        let script = keg_script("0.4.3")
            .replace('\\', "\\\\")
            .replace('\'', "'\\''")
            .replace('%', "%%")
            .replace('\n', "\\n");
        std::fs::write(
            dir.path().join("bin/brew"),
            format!(
                "#!/bin/sh\nr='{root}'\necho \"$1\" >> \"$r/brew.log\"\ncase \"$1\" in\n\
                 --prefix) printf '%s\\n' \"$r\";;\n\
                 info) printf '{{\"formulae\":[{{\"name\":\"wsmp\",\"versions\":{{\"stable\":\"0.4.3\"}}}}]}}';;\n\
                 upgrade)\n  mkdir -p \"$r/Cellar/wsmp/0.4.3/bin\"\n\
                   printf '{script}' > \"$r/Cellar/wsmp/0.4.3/bin/wsmp\"\n\
                   chmod \"$(cat \"$r/upgrade-mode\" 2>/dev/null || echo 755)\" \"$r/Cellar/wsmp/0.4.3/bin/wsmp\"\n\
                   ln -sfn \"$r/Cellar/wsmp/0.4.3\" \"$r/opt/wsmp\";;\n\
                 esac\nexit 0\n"
            ),
        )
        .expect("brew");
        set_mode(&dir.path().join("bin/brew"), 0o755);
        let fake = dir.path().join("fakebin");
        std::fs::create_dir_all(&fake).expect("fakebin");
        std::fs::write(
            fake.join("systemctl"),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$WSMP_TEST_SYSTEMCTL_LOG\"\nexit 0\n",
        )
        .expect("systemctl");
        set_mode(&fake.join("systemctl"), 0o755);
        let units = dir.path().join("config/systemd/user");
        std::fs::create_dir_all(&units).expect("units");
        std::fs::create_dir_all(dir.path().join("state")).expect("state");
        Self {
            unit: units.join("wsmp.service"),
            stable: dir.path().join("opt/wsmp/bin/wsmp").display().to_string(),
            dir,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// The child's `PATH`: the fake `systemctl` first.
    fn path_env(&self) -> String {
        format!("{}:/usr/bin:/bin", self.path("fakebin").display())
    }

    /// The unit `wsmp service install` writes from the child's shell for
    /// `executable`.
    fn unit_for(&self, executable: &str) -> String {
        render_systemd_user_unit(
            executable,
            &[
                (
                    "WSMP_CONFIG",
                    self.path("config.json").display().to_string(),
                ),
                ("WSMP_STATE_DIR", self.path("state").display().to_string()),
                ("PATH", self.pinned_path()),
            ],
        )
        .expect("render")
    }

    /// The `PATH` the unit pins from [`Self::path_env`]: the fake bin is
    /// in a temporary directory, which [`service_path`] leaves off.
    fn pinned_path(&self) -> String {
        if crate::host::service::path_env::SessionDirs::current()
            .scope_of(&self.path("fakebin"))
            .is_some()
        {
            "/usr/bin:/bin".to_owned()
        } else {
            self.path_env()
        }
    }

    fn stable_unit(&self) -> String {
        self.unit_for(&self.stable)
    }

    fn child(&self, through: &str, fail_dir_sync_once: bool) -> String {
        self.child_with(through, fail_dir_sync_once, &self.path("config.json"))
    }

    /// [`Through::child`] with `config` as its `WSMP_CONFIG` (a pin).
    fn child_with(&self, through: &str, fail_dir_sync_once: bool, config: &Path) -> String {
        let mut command = std::process::Command::new(std::env::current_exe().expect("test binary"));
        command
            .args([
                "--exact",
                "host::service::files::homebrew_tests::through_the_update_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("WSMP_TEST_THROUGH", through)
            .env("WSMP_TEST_THROUGH_OUT", self.path("through.result"))
            .env("WSMP_TEST_PREFIX", self.dir.path())
            .env("XDG_CONFIG_HOME", self.path("config"))
            .env("WSMP_CONFIG", config)
            .env("WSMP_STATE_DIR", self.path("state"))
            .env("PATH", self.path_env())
            .env("WSMP_TEST_SYSTEMCTL_LOG", self.path("systemctl.log"))
            .env("WSMP_TEST_DIR_SYNC_LOG", self.path("dirsync.log"));
        if fail_dir_sync_once {
            command.env("WSMP_TEST_DIR_SYNC_FAIL_ONCE", self.path("dirsync.failed"));
        }
        let _ = std::fs::remove_file(self.path("through.result"));
        let output = command.output().expect("run the child");
        std::fs::read_to_string(self.path("through.result")).unwrap_or_else(|_| {
            panic!(
                "no result from the child: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        })
    }

    /// One update's service step: `ok` or `error: …`.
    fn ensure(&self, fail_dir_sync_once: bool) -> String {
        self.child("ensure", fail_dir_sync_once)
    }

    /// A whole Homebrew update to 0.4.3: `Swapped` or `Stopped`, then the
    /// progress it reported.
    fn update(&self) -> String {
        self.child("update", false)
    }

    /// What was logged to `name` since the last call, and clears it.
    fn take(&self, name: &str) -> String {
        let path = self.path(name);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let _ = std::fs::remove_file(&path);
        text
    }

    /// The program the unit's `ExecStart=` runs, and what it prints for
    /// `--version`: what the restart would start.
    fn unit_runs(&self) -> (String, String) {
        let text = std::fs::read_to_string(&self.unit).expect("unit");
        let program = text
            .lines()
            .find_map(|line| line.strip_prefix("ExecStart="))
            .and_then(|exec| exec.strip_suffix(" run"))
            .expect("ExecStart")
            .to_string();
        let out = run_script(Path::new(&program), &["--version"]);
        (
            program,
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        )
    }
}

/// R5-A-1, whole update (A5-FINAL-SECURITY, A5-PIN): a Homebrew prefix
/// with a newline in it, or a newline in a pin, is refused before brew
/// changes the keg, with wsmp's old unit as it was and nothing recorded.
#[cfg(target_os = "linux")]
#[test]
fn a_newline_in_the_prefix_or_a_pin_stops_the_update_before_the_keg_changes() {
    let check = |through: &Through, result: &str, old: &str| {
        assert!(
            result.starts_with("Stopped\n")
                && result.contains("Refused Some(UnsupportedMethod)")
                && result.contains("U+000A"),
            "{result}"
        );
        assert!(
            !through.take("brew.log").contains("upgrade"),
            "keg untouched"
        );
        assert_eq!(std::fs::read_to_string(&through.unit).expect("read"), old);
        assert_eq!(through.take("systemctl.log"), "", "no reload");
        assert!(
            crate::relay::update::state::load(&through.path("state/update"))
                .expect("load")
                .is_none(),
            "nothing recorded"
        );
    };
    let through = Through::named("r6\nprefix");
    let old = render_systemd_user_unit("/bin/true", &[]).expect("render");
    std::fs::write(&through.unit, &old).expect("write");
    let result = through.update();
    check(&through, &result, &old);

    let through = Through::new();
    let old = through.stable_unit();
    std::fs::write(&through.unit, &old).expect("write");
    let config = through.path("config\nnode.json");
    std::fs::write(&config, "{}").expect("config");
    let result = through.child_with("update", false, &config);
    check(&through, &result, &old);
}

/// A3-DIRSYNC: a directory sync that fails after the rename leaves a
/// whole new unit and an error; the next update syncs the directory and
/// reloads before it reports success.
#[cfg(target_os = "linux")]
#[test]
fn ensure_stable_executable_finishes_a_move_whose_directory_sync_failed() {
    let through = Through::new();
    std::fs::write(
        &through.unit,
        through.unit_for(
            &through
                .path("Cellar/wsmp/0.4.2/bin/wsmp")
                .display()
                .to_string(),
        ),
    )
    .expect("write");
    let first = through.ensure(true);
    assert!(
        first.starts_with("error:") && first.contains("syncing"),
        "{first}"
    );
    assert!(through.path("dirsync.failed").exists(), "the fault fired");
    assert_eq!(
        std::fs::read_to_string(&through.unit).expect("read"),
        through.stable_unit()
    );
    assert_eq!(
        through.take("systemctl.log"),
        "",
        "not reloaded after a failed sync"
    );
    through.take("dirsync.log");
    let second = through.ensure(true);
    assert_eq!(second, "ok");
    let units = through.unit.parent().expect("dir").display().to_string();
    assert!(
        through
            .take("dirsync.log")
            .lines()
            .any(|line| line == units),
        "the retry synced the unit's directory"
    );
    assert_eq!(through.take("systemctl.log"), "--user daemon-reload\n");
}

/// Through the production function, every unit a review found accepted
/// or refused (A4-ADV; A3 short write, FIFO, dangling link): wsmp's unit
/// in any shape is written again as install writes it; what is broken
/// or written by hand stops the update untouched and unreloaded; no unit
/// and a healthy unit pass as they are.
#[cfg(target_os = "linux")]
#[test]
fn ensure_stable_executable_writes_wsmps_unit_again_and_refuses_a_broken_one() {
    use std::os::unix::fs::{MetadataExt, symlink};
    let through = Through::new();
    let healthy = through.stable_unit();
    assert_eq!(through.ensure(false), "ok", "no unit");
    assert_eq!(through.take("systemctl.log"), "", "no unit, no reload");
    assert!(std::fs::symlink_metadata(&through.unit).is_err());
    // Healthy, and hard-linked: nothing written (same inode), reloaded.
    std::fs::write(&through.unit, &healthy).expect("write");
    set_mode(&through.unit, SERVICE_FILE_MODE);
    let other = through.path("hardlink.service");
    std::fs::hard_link(&through.unit, &other).expect("hard link");
    assert_eq!(through.ensure(false), "ok", "healthy");
    assert_eq!(through.take("systemctl.log"), "--user daemon-reload\n");
    assert_eq!(
        std::fs::metadata(&through.unit).expect("meta").ino(),
        std::fs::metadata(&other).expect("meta").ino()
    );
    std::fs::remove_file(&other).expect("rm");
    // wsmp's unit, not as install writes it now: written again.
    let alias = through.path("pinned-wsmp");
    symlink(through.path("Cellar/wsmp/0.4.2/bin/wsmp"), &alias).expect("alias");
    for (state, text, mode) in [
        (
            "--version",
            healthy.replace(" run\n", " --version\n"),
            0o644,
        ),
        (
            "an alias",
            through.unit_for(&alias.display().to_string()),
            0o644,
        ),
        ("trailing text", format!("{healthy}garbage\n"), 0o644),
        (
            "cut short",
            healthy[..healthy.len() - 10].to_string(),
            0o644,
        ),
        ("mode 0666", healthy.clone(), 0o666),
    ] {
        std::fs::write(&through.unit, &text).expect("write");
        set_mode(&through.unit, mode);
        assert_eq!(through.ensure(false), "ok", "{state}");
        assert_eq!(
            std::fs::read_to_string(&through.unit).expect("read"),
            healthy,
            "{state}"
        );
        assert_eq!(mode_of(&through.unit), SERVICE_FILE_MODE, "{state}");
        assert_eq!(
            through.take("systemctl.log"),
            "--user daemon-reload\n",
            "{state}"
        );
    }
    // Through a link to a file elsewhere: its target is written, the link
    // stays.
    std::fs::remove_file(&through.unit).expect("rm");
    let elsewhere = through.path("elsewhere.service");
    std::fs::write(&elsewhere, healthy.replace(" run\n", " --version\n")).expect("w");
    symlink(&elsewhere, &through.unit).expect("link");
    assert_eq!(through.ensure(false), "ok", "a link");
    assert!(
        std::fs::symlink_metadata(&through.unit)
            .expect("meta")
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read_to_string(&elsewhere).expect("read"), healthy);
    through.take("systemctl.log");
    std::fs::remove_file(&through.unit).expect("rm");
    let refused = |needle: &str| {
        let bytes = bytes_of(&through.unit);
        let started = std::time::Instant::now();
        let result = through.ensure(false);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(60),
            "{needle}"
        );
        assert!(
            result.starts_with("error:") && result.contains(needle),
            "{needle}: {result}"
        );
        assert_eq!(through.take("systemctl.log"), "", "{needle}: reloaded");
        assert_eq!(bytes_of(&through.unit), bytes, "{needle}: changed");
    };
    std::fs::write(
        &through.unit,
        format!(
            "[Service]\nExecStart={} run\n",
            through.path("Cellar/wsmp/0.4.2/bin/wsmp").display()
        ),
    )
    .expect("write");
    refused("not written by `wsmp service install`");
    std::fs::write(
        &through.unit,
        "[Service]\nExecStart=/usr/local/bin/wsmp run\n",
    )
    .expect("write");
    refused("not written by `wsmp service install`");
    std::fs::remove_file(&through.unit).expect("rm");
    symlink(through.path("gone.service"), &through.unit).expect("link");
    refused("is a link to nothing");
    std::fs::remove_file(&through.unit).expect("rm");
    symlink(&through.unit, &through.unit).expect("loop");
    refused("could not be resolved");
    std::fs::remove_file(&through.unit).expect("rm");
    std::fs::create_dir(&through.unit).expect("dir");
    refused("not a regular file");
    std::fs::remove_dir(&through.unit).expect("rm");
    nix::unistd::mkfifo(&through.unit, nix::sys::stat::Mode::S_IRWXU).expect("fifo");
    refused("not a regular file");
    std::fs::remove_file(&through.unit).expect("rm");
    std::fs::write(
        &through.unit,
        through.unit_for(
            &through
                .path("Cellar/wsmp/0.4.2/bin/wsmp")
                .display()
                .to_string(),
        ),
    )
    .expect("write");
    std::fs::remove_file(through.path("opt/wsmp")).expect("unlink");
    refused("`brew link wsmp`");
}

/// The whole Homebrew update through its production code (B4-FILESYSTEM,
/// A4-ADV, B4-RUNNABILITY): the service is written onto the stable path
/// before the keg changes, the upgrade moves `opt`, and the probe of that
/// same path is what lets the update record the new build. An alias of
/// the old keg does not survive, and a target that cannot run stops the
/// update before anything is recorded.
#[cfg(target_os = "linux")]
#[test]
fn a_homebrew_update_moves_the_service_onto_the_path_it_probes() {
    // An alias that resolves today to the running keg, and that keg made
    // unrunnable (mode 0001): neither matters, the service is written
    // onto `opt`, which after the upgrade runs 0.4.3.
    let through = Through::new();
    let alias = through.path("pinned-wsmp");
    std::os::unix::fs::symlink(through.path("Cellar/wsmp/0.4.2/bin/wsmp"), &alias).expect("alias");
    std::fs::write(
        &through.unit,
        through.unit_for(&alias.display().to_string()),
    )
    .expect("write");
    set_mode(&through.path("Cellar/wsmp/0.4.2/bin/wsmp"), 0o001);
    let result = through.update();
    assert!(result.starts_with("Swapped\n"), "{result}");
    assert_eq!(
        std::fs::read_to_string(&through.unit).expect("read"),
        through.stable_unit()
    );
    assert_eq!(through.take("systemctl.log"), "--user daemon-reload\n");
    assert_eq!(
        through.unit_runs(),
        (through.stable.clone(), "wsmp 0.4.3".to_string())
    );
    assert!(through.take("brew.log").contains("upgrade\n"));

    // A unit edited to `--version`: written back to `run` before brew.
    let through = Through::new();
    std::fs::write(
        &through.unit,
        through.stable_unit().replace(" run\n", " --version\n"),
    )
    .expect("write");
    assert!(through.update().starts_with("Swapped\n"));
    assert_eq!(
        std::fs::read_to_string(&through.unit).expect("read"),
        through.stable_unit()
    );

    // The new keg's binary cannot run (mode 0001): the probe of the
    // service's own path fails, nothing is recorded, no restart.
    let through = Through::new();
    std::fs::write(&through.unit, through.stable_unit()).expect("write");
    std::fs::write(through.path("upgrade-mode"), "0001").expect("mode");
    let result = through.update();
    assert!(result.starts_with("Stopped\n"), "{result}");
    assert!(
        result.contains("Failed Some(VersionMismatch)") && result.contains(&through.stable),
        "{result}"
    );
    assert!(
        crate::relay::update::state::load(&through.path("state/update"))
            .expect("load")
            .is_none(),
        "nothing recorded"
    );

    // A unit by hand on a Cellar path: refused before brew changes anything.
    let through = Through::new();
    let by_hand = format!(
        "[Service]\nExecStart={} run\n",
        through.path("Cellar/wsmp/0.4.2/bin/wsmp").display()
    );
    std::fs::write(&through.unit, &by_hand).expect("write");
    let result = through.update();
    assert!(
        result.starts_with("Stopped\n") && result.contains("Refused Some(UnsupportedMethod)"),
        "{result}"
    );
    assert!(
        !through.take("brew.log").contains("upgrade"),
        "the keg is untouched"
    );
    assert_eq!(
        std::fs::read_to_string(&through.unit).expect("read"),
        by_hand
    );

    // Inverses: a healthy unit is not written (same inode), no unit is
    // not created; both update.
    use std::os::unix::fs::MetadataExt;
    let through = Through::new();
    std::fs::write(&through.unit, through.stable_unit()).expect("write");
    set_mode(&through.unit, SERVICE_FILE_MODE);
    let inode = std::fs::metadata(&through.unit).expect("meta").ino();
    assert!(through.update().starts_with("Swapped\n"));
    assert_eq!(std::fs::metadata(&through.unit).expect("meta").ino(), inode);
    let through = Through::new();
    assert!(through.update().starts_with("Swapped\n"));
    assert!(std::fs::symlink_metadata(&through.unit).is_err());
    assert_eq!(through.take("systemctl.log"), "");
}

/// macOS's pair of service files, for an in-process Homebrew update on
/// a [`Through`] prefix ([`homebrew_update_with_pair`]): the wrapper and
/// the plist in the prefix (`stable` is `<prefix>/opt/wsmp/bin/wsmp`),
/// rendered as `wsmp service install` writes them, a plist's label read
/// by [`label_reader`]. The same service step `ensure_stable_executable`
/// takes on macOS, with these paths.
#[cfg(target_os = "linux")]
fn pair_in_prefix(stable: &Path) -> Result<()> {
    let prefix = stable.ancestors().nth(4).context("no prefix")?;
    let wrapper = prefix.join("wsmp-service-run.sh");
    let plist = prefix.join("com.flycockpit.wsmp.plist");
    stable_service_files(
        &[
            (&wrapper, ServiceKind::LaunchdWrapper),
            (&plist, ServiceKind::LaunchdPlist),
        ],
        stable,
        || Ok(vec![pair_wrapper(stable)?, pair_plist(prefix)?]),
        &publish_file,
        no_reload,
        &label_reader,
    )
}

/// The wrapper [`pair_in_prefix`] writes.
#[cfg(target_os = "linux")]
fn pair_wrapper(executable: &Path) -> Result<String> {
    render_macos_service_wrapper(path_text("the executable", executable)?, &pins())
}

/// The plist [`pair_in_prefix`] writes.
#[cfg(target_os = "linux")]
fn pair_plist(prefix: &Path) -> Result<String> {
    render_launch_agent_plist(
        crate::host::service::MACOS_LABEL,
        path_text("the wrapper", &prefix.join("wsmp-service-run.sh"))?,
        "/Users/u",
        "/Users/u/Library/Logs/ws-model-proxy/relay.out.log",
        "/Users/u/Library/Logs/ws-model-proxy/relay.err.log",
    )
}

/// The whole Homebrew update ([`crate::relay::update::agent::homebrew`]) on
/// `through`'s prefix, in this process, its service step
/// [`pair_in_prefix`]: `Swapped` or `Stopped`, then the progress.
#[cfg(target_os = "linux")]
fn homebrew_update_with_pair(through: &Through) -> String {
    use crate::relay::update::flow::{Machine, Progress, Request};
    use crate::wire::protocol::frames::{UpdatePhase, UpdateReason};
    struct Log(String);
    impl Progress for Log {
        fn report(
            &mut self,
            phase: UpdatePhase,
            reason: Option<UpdateReason>,
            detail: Option<String>,
        ) {
            self.0.push_str(&format!(
                "{phase:?} {reason:?} {}\n",
                detail.unwrap_or_default().replace('\n', " ")
            ));
        }
    }
    let machine = Machine {
        state_dir: through.path("state"),
        live: through.path("Cellar/wsmp/0.4.2/bin/wsmp"),
        target: "test-target".into(),
        scheduler: None,
        tar: crate::relay::update::install::system_tar(),
        current_version: "0.4.2".into(),
        before_swap: None,
        proceed: None,
        stable_service: pair_in_prefix,
    };
    let request = Request {
        update_id: "u-1".into(),
        version: "0.4.3".into(),
        artifact_url: String::new(),
        sha256: String::new(),
        signature: None,
        rollback_after_secs: 90,
        origin: crate::relay::update::state::Origin::Cli,
    };
    let mut log = Log(String::new());
    let ended = crate::relay::update::agent::homebrew(&machine, &request, &mut log);
    format!("{ended:?}\n{}", log.0)
}

/// Owner, 2026-10-30, through the Homebrew update itself: any service
/// file not written by `wsmp service install` stops the update before
/// the keg changes (no `brew upgrade`), every file byte for byte as it
/// was, nothing reloaded or recorded, for the one reason that it is not
/// wsmp's: a systemd unit (the real `ensure_stable_executable`, in a
/// child), a wrapper or a plist (XML or binary, another label or none),
/// each on a `Cellar` path, on the stable path, or spelled so no text
/// search finds the `Cellar` path (systemd's `\x43ellar`: F-FA-2;
/// CDATA and a binary string with a literal `&#108;`: B8-CDATA-INVERSE).
/// Inverses: wsmp's files (even a plist saved again in binary, on an
/// old `Cellar` path) are written again and the update installs; no
/// service installs too.
#[cfg(target_os = "linux")]
#[test]
fn a_homebrew_update_refuses_any_service_file_by_hand() {
    let refused =
        |through: &Through, result: &str, files: &[(&Path, Option<Vec<u8>>)], case: &str| {
            assert!(
                result.starts_with("Stopped\n")
                    && result.contains("Refused Some(UnsupportedMethod)")
                    && result.contains("was not written by `wsmp service install`")
                    && result.contains("Run `wsmp service install`")
                    && result.contains("update by hand"),
                "{case}: {result}"
            );
            assert!(
                !through.take("brew.log").contains("upgrade"),
                "{case}: the keg is untouched"
            );
            for (path, before) in files {
                assert_eq!(
                    &bytes_of(path),
                    before,
                    "{case}: `{}` changed",
                    path.display()
                );
            }
            assert_eq!(through.take("systemctl.log"), "", "{case}: reloaded");
            assert!(
                crate::relay::update::state::load(&through.path("state/update"))
                    .expect("load")
                    .is_none(),
                "{case}: recorded"
            );
        };

    // Units, through the production service step.
    let old = |through: &Through| {
        through
            .path("Cellar/wsmp/0.4.2/bin/wsmp")
            .display()
            .to_string()
    };
    type Unit = fn(&Through) -> String;
    let units: [(&str, Unit); 4] = [
        ("unit, another program", |_| {
            "[Service]\nExecStart=/usr/local/bin/wsmp run\n".to_string()
        }),
        ("unit, Cellar", |t| {
            format!(
                "[Service]\nExecStart={} run\n",
                t.path("Cellar/wsmp/0.4.2/bin/wsmp").display()
            )
        }),
        ("unit, stable", |t| {
            format!("[Service]\nExecStart={} run\n", t.stable)
        }),
        ("unit, \\x43ellar", |t| {
            format!(
                "[Service]\nExecStart={} run\n",
                t.path("Cellar/wsmp/0.4.2/bin/wsmp")
                    .display()
                    .to_string()
                    .replace("/Cellar/", "/\\x43ellar/")
            )
        }),
    ];
    for (case, text) in units {
        let through = Through::new();
        let text = text(&through);
        assert_eq!(text.contains("Cellar"), case == "unit, Cellar", "{case}");
        std::fs::write(&through.unit, &text).expect("write");
        let result = through.update();
        refused(
            &through,
            &result,
            &[(&through.unit, Some(text.into_bytes()))],
            case,
        );
    }

    // macOS's pair, through the same update in this process.
    let pair = |through: &Through| {
        (
            through.path("wsmp-service-run.sh"),
            through.path("com.flycockpit.wsmp.plist"),
        )
    };
    let check_pair = |case: &str, wrapper_bytes: Option<&[u8]>, plist_bytes: &[u8]| {
        let through = Through::new();
        let (wrapper, plist) = pair(&through);
        if let Some(bytes) = wrapper_bytes {
            std::fs::write(&wrapper, bytes).expect("wrapper");
            set_mode(&wrapper, PRIVATE_SCRIPT_MODE);
        }
        std::fs::write(&plist, plist_bytes).expect("plist");
        let before = [
            (wrapper.as_path(), bytes_of(&wrapper)),
            (plist.as_path(), bytes_of(&plist)),
        ];
        let result = homebrew_update_with_pair(&through);
        refused(&through, &result, &before, case);
    };
    let probe = Through::new();
    let stable = PathBuf::from(&probe.stable);
    let prefix = probe.dir.path();
    let ours = pair_plist(prefix).expect("plist");
    let healthy_wrapper = pair_wrapper(&stable).expect("wrapper");
    let wrapper_name = prefix.join("wsmp-service-run.sh").display().to_string();
    let cellar = old(&probe);
    let theirs = ours.replace(crate::host::service::MACOS_LABEL, "com.example.relay");
    let runs = |program: &str| theirs.replace(&wrapper_name, program);
    // Wrappers by hand beside wsmp's plist.
    for (case, program) in [
        ("wrapper, Cellar", &cellar),
        ("wrapper, stable", &probe.stable),
    ] {
        let wrapper = format!("#!/bin/sh\nexec '{program}' run\n");
        check_pair(case, Some(wrapper.as_bytes()), ours.as_bytes());
    }
    // Plists by hand beside wsmp's wrapper, and beside none.
    let mut plists: Vec<(String, Vec<u8>)> = vec![
        ("XML, Cellar".into(), runs(&cellar).into_bytes()),
        ("XML, stable".into(), runs(&probe.stable).into_bytes()),
        (
            "XML, CDATA with a literal reference".into(),
            runs("<![CDATA[/opt/x/Cel&#108;ar/wsmp/0.4.2/bin/wsmp]]>").into_bytes(),
        ),
        (
            "XML, no label".into(),
            b"<?xml version=\"1.0\"?><plist><dict/></plist>".to_vec(),
        ),
    ];
    match resaved_plist(theirs.as_bytes(), "FMT_BINARY") {
        Some(_) => {
            for (case, program) in [
                ("binary, Cellar", cellar.clone()),
                ("binary, stable", probe.stable.clone()),
                (
                    "binary, a literal reference",
                    "/opt/x/Cel&#108;ar/wsmp/0.4.2/bin/wsmp".into(),
                ),
                (
                    "binary, UTF-16 Cellar",
                    cellar.replace("/Cellar/", "/\u{e9}/../Cellar/"),
                ),
            ] {
                let bytes = resaved_plist(runs(&program).as_bytes(), "FMT_BINARY").expect("save");
                plists.push((case.into(), bytes));
            }
        }
        None => {
            #[allow(clippy::print_stderr)]
            {
                eprintln!("skipped: no python3 to save a binary plist");
            }
        }
    }
    for (case, bytes) in &plists {
        check_pair(
            &format!("{case}, wsmp's wrapper"),
            Some(healthy_wrapper.as_bytes()),
            bytes,
        );
        check_pair(&format!("{case}, no wrapper"), None, bytes);
    }

    // Inverses. wsmp's pair on an old Cellar path (its plist saved again
    // in binary when python3 is there): written again, then installed.
    let through = Through::new();
    let (wrapper, plist) = pair(&through);
    let old_wrapper = pair_wrapper(Path::new(&old(&through))).expect("wrapper");
    std::fs::write(&wrapper, &old_wrapper).expect("wrapper");
    let wsmps_plist = pair_plist(through.dir.path()).expect("plist");
    let saved = resaved_plist(wsmps_plist.as_bytes(), "FMT_BINARY")
        .unwrap_or_else(|| wsmps_plist.clone().into_bytes());
    std::fs::write(&plist, &saved).expect("plist");
    let result = homebrew_update_with_pair(&through);
    assert!(result.starts_with("Swapped\n"), "{result}");
    assert!(through.take("brew.log").contains("upgrade\n"));
    assert_eq!(
        std::fs::read_to_string(&wrapper).expect("wrapper"),
        pair_wrapper(Path::new(&through.stable)).expect("wrapper")
    );
    assert_eq!(std::fs::read_to_string(&plist).expect("plist"), wsmps_plist);
    // No service: installed, nothing written.
    let through = Through::new();
    let (wrapper, plist) = pair(&through);
    let result = homebrew_update_with_pair(&through);
    assert!(result.starts_with("Swapped\n"), "{result}");
    assert!(bytes_of(&wrapper).is_none() && bytes_of(&plist).is_none());
}

/// `systemd-analyze verify --man=no` on `unit`: whether it passed, and
/// what it printed. None when the tool is missing or cannot verify even
/// a one-line unit here (then the parser checks are skipped).
#[cfg(target_os = "linux")]
fn systemd_verify(unit: &Path) -> Option<(bool, String)> {
    let verify = |unit: &Path| {
        let output = std::process::Command::new("systemd-analyze")
            .args(["verify", "--man=no"])
            .arg(unit)
            .output()
            .ok()?;
        Some((
            output.status.success(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    };
    let dir = tempfile::tempdir().expect("dir");
    let plain = dir.path().join("wsmp.service");
    std::fs::write(&plain, "[Service]\nExecStart=/bin/true\n").expect("write");
    match verify(&plain) {
        Some((true, _)) => verify(unit),
        other => {
            // Said, so a skipped parser check is visible in the test log.
            #[allow(clippy::print_stderr)]
            {
                eprintln!("systemd-analyze cannot verify here, skipped: {other:?}");
            }
            None
        }
    }
}

/// R5-A-1, the real parser: the unit an update writes passes
/// `systemd-analyze verify` (which also checks that `ExecStart=`'s program
/// runs), with no setting ignored; so does one with spaces, `%`, `$`,
/// quotes, backslashes and non-ASCII in its values. Inverse: the newline
/// the old serializer wrote inside quotes fails the same check.
#[cfg(target_os = "linux")]
#[test]
fn systemd_reads_the_unit_wsmp_writes() {
    let through = Through::new();
    std::fs::write(&through.unit, through.unit_for("/bin/true")).expect("write");
    assert!(through.update().starts_with("Swapped\n"));
    let Some((ok, text)) = systemd_verify(&through.unit) else {
        return;
    };
    assert!(ok && !text.contains("ignoring"), "{text}");

    let odd = through.path("a b%$é");
    std::fs::create_dir_all(&odd).expect("dir");
    std::fs::copy("/bin/true", odd.join("wsmp")).expect("copy");
    let unit = through.path("odd/wsmp.service");
    std::fs::create_dir_all(unit.parent().expect("parent")).expect("dir");
    let rendered = render_systemd_user_unit(
        odd.join("wsmp").to_str().expect("utf-8"),
        &[
            ("WSMP_CONFIG", "/u/it's a \"b\\c\" 100% $HOME é".to_string()),
            ("PATH", "/usr/bin:/bin".to_string()),
        ],
    )
    .expect("render");
    std::fs::write(&unit, rendered).expect("write");
    let (ok, text) = systemd_verify(&unit).expect("verify");
    assert!(ok && !text.contains("ignoring"), "{text}");

    // What the old serializer wrote for a newline: rejected.
    std::fs::write(
        &unit,
        format!(
            "[Service]\nExecStart=\"{}\nb\" run\nEnvironment=\"WSMP_CONFIG=/u/a\nb\"\n",
            odd.join("wsmp").display()
        ),
    )
    .expect("write");
    let (ok, text) = systemd_verify(&unit).expect("verify");
    assert!(!ok && text.contains("Unbalanced quoting"), "{text}");
}
