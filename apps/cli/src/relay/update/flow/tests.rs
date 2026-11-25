#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use anyhow::Result;

use super::super::deadman::fake::FakeScheduler;
use super::installer::archive_name;
#[cfg(unix)]
use super::recovery::layout_of;
#[cfg(unix)]
use super::rollback::LOCKED_RETRY;
use super::*;
#[cfg(unix)]
use crate::relay::update::deadman::DeadmanSpec;
use crate::relay::update::install;
#[cfg(unix)]
use crate::relay::update::install::Layout;
#[cfg(unix)]
use crate::relay::update::state::{self, Lifecycle, Phase, UpdateState};

#[derive(Default)]
struct Recorded(Vec<(UpdatePhase, Option<UpdateReason>, Option<String>)>);

impl Progress for Recorded {
    fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>) {
        self.0.push((phase, reason, detail));
    }
}

impl Recorded {
    #[cfg(unix)]
    fn phases(&self) -> Vec<UpdatePhase> {
        self.0.iter().map(|(phase, _, _)| *phase).collect()
    }
    fn last_reason(&self) -> Option<UpdateReason> {
        self.0.last().and_then(|(_, reason, _)| *reason)
    }
}

#[cfg(unix)]
/// Serves `body` once per connection at any path, on loopback.
fn serve(body: Vec<u8>) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let Ok(mut stream) = stream else { continue };
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    format!("http://127.0.0.1:{port}/wsmp-x86_64-unknown-linux-gnu.tar.gz")
}

#[cfg(unix)]
fn archive_with(script: &str) -> Vec<u8> {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("dir");
    let inner = dir.path().join("wsmp-test-target");
    std::fs::create_dir_all(&inner).expect("mkdir");
    let binary = inner.join("wsmp");
    std::fs::write(&binary, script).expect("write");
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let archive = dir.path().join("a.tar.gz");
    let status = std::process::Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(dir.path())
        .arg("wsmp-test-target")
        .status()
        .expect("tar");
    assert!(status.success());
    std::fs::read(&archive).expect("read")
}

struct Node {
    root: tempfile::TempDir,
    live: PathBuf,
    scheduler: FakeScheduler,
}

impl Node {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("root");
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        let live = bin.join("wsmp");
        std::fs::write(&live, "#!/bin/sh\necho 'wsmp 0.4.2'\n").expect("live");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        Self {
            root,
            live,
            scheduler: FakeScheduler::default(),
        }
    }
    fn state_dir(&self) -> PathBuf {
        self.root.path().join("state")
    }
    #[cfg(unix)]
    fn update_dir(&self) -> PathBuf {
        self.state_dir().join("update")
    }
    fn machine(&self) -> Machine<'_> {
        Machine {
            state_dir: self.state_dir(),
            live: self.live.clone(),
            target: "test-target".into(),
            scheduler: Some(&self.scheduler),
            tar: install::system_tar(),
            current_version: "0.4.2".into(),
            before_swap: None,
            proceed: None,
            stable_service: |_| Ok(()),
        }
    }
    fn live_text(&self) -> String {
        std::fs::read_to_string(&self.live).expect("live")
    }
    #[cfg(unix)]
    fn live_sha(&self) -> String {
        install::sha256_file(&self.live).expect("hash")
    }
    fn untouched(&self) {
        assert!(self.live_text().contains("0.4.2"));
        assert!(self.scheduler.registered.borrow().is_none());
        let names: Vec<String> = std::fs::read_dir(self.live.parent().expect("bin"))
            .expect("dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["wsmp"], "leftovers");
    }
}

/// The old build starting (its hash does not matter once the update ended).
#[cfg(unix)]
const OLD_BUILD: Running<'static> = Running {
    version: "0.4.2",
    sha256: None,
};

#[cfg(unix)]
fn new_build(sha256: &str) -> Running<'_> {
    Running {
        version: "0.4.3",
        sha256: Some(sha256),
    }
}

fn request(url: String, sha256: String) -> Request {
    Request {
        update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
        version: "0.4.3".into(),
        artifact_url: url,
        sha256,
        signature: None,
        rollback_after_secs: 90,
        origin: Origin::Server,
    }
}

#[cfg(unix)]
fn sha(bytes: &[u8]) -> String {
    crate::services::metric_sources::sha256_hex(bytes)
}

#[cfg(unix)]
#[test]
fn a_good_build_is_armed_then_swapped_and_confirms() {
    let node = Node::new();
    let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
    let url = serve(archive.clone());
    let mut progress = Recorded::default();
    let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
    assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
    assert_eq!(
        progress.phases(),
        [
            UpdatePhase::Downloading,
            UpdatePhase::Verifying,
            UpdatePhase::Armed,
            UpdatePhase::Swapped
        ]
    );
    assert!(node.live_text().contains("0.4.3"));
    let prev = node.live.with_file_name("wsmp.prev");
    assert!(
        std::fs::read_to_string(&prev)
            .expect("prev")
            .contains("0.4.2")
    );
    let spec = node.scheduler.registered.borrow().clone().expect("armed");
    // The job runs its own copy of the old build, not the rollback copy.
    let recovery = node
        .live
        .with_file_name(".wsmp-recovery-AAAAAAAAAAAAAAAAAAAAAA");
    assert_eq!(spec.program(), recovery);
    assert_ne!(spec.program(), prev);
    assert_eq!(
        install::sha256_file(&recovery).expect("recovery"),
        install::sha256_file(&prev).expect("prev")
    );
    assert_eq!(spec.fire_in(), Duration::from_secs(90));
    let saved = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(saved.phase(), Phase::Swapped);
    assert!(
        !node
            .live
            .with_file_name(".wsmp-update-AAAAAAAAAAAAAAAAAAAAAA")
            .exists()
    );

    // The new binary starts: it awaits confirmation, the dead-man stays.
    assert_eq!(saved.to_sha256.as_deref(), Some(node.live_sha().as_str()));
    let start = on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        new_build(&node.live_sha()),
        3,
        0,
    )
    .expect("start");
    assert!(matches!(start, OnStart::AwaitConfirm(ref s) if s.attempts == 1));
    assert_eq!(*node.scheduler.registrations.borrow(), 1);
    let Confirm::Confirmed(confirmed) = confirm(
        &node.update_dir(),
        Some(&node.scheduler),
        &saved.update_id,
        |_| None,
    )
    .expect("confirm") else {
        panic!("not confirmed");
    };
    assert_eq!(confirmed.phase(), Phase::Confirmed);
    assert!(confirmed.needs_report());
    assert!(node.scheduler.registered.borrow().is_none(), "disarmed");
    // The dead-man firing late finds it settled; the copy is kept.
    let late = rollback_if_unconfirmed(
        &node.update_dir(),
        &confirmed.update_id,
        u64::MAX / 2,
        None,
        || None,
    )
    .expect("check");
    assert_eq!(late, Rollback::Settled);
    assert!(prev.exists());
    // Confirmed and its job removed: the job's program went with it.
    assert!(!recovery.exists());
}

#[cfg(unix)]
#[test]
fn a_bad_checksum_never_swaps() {
    let node = Node::new();
    let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
    let url = serve(archive);
    let mut progress = Recorded::default();
    let ended = self_replace(
        &node.machine(),
        &request(url, "0".repeat(64)),
        &mut progress,
    );
    assert_eq!(ended, Ended::Stopped);
    assert_eq!(progress.phases().last(), Some(&UpdatePhase::Refused));
    assert_eq!(progress.last_reason(), Some(UpdateReason::ChecksumMismatch));
    node.untouched();
    assert_eq!(state::load(&node.update_dir()).expect("load"), None);
}

#[cfg(unix)]
#[test]
fn a_build_that_fails_version_never_swaps() {
    for script in [
        "#!/bin/sh\nexit 1\n",
        "#!/bin/sh\necho 'wsmp 0.4.4'\n",
        "#!/bin/sh\necho garbage\n",
    ] {
        let node = Node::new();
        let archive = archive_with(script);
        let url = serve(archive.clone());
        let mut progress = Recorded::default();
        let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
        assert_eq!(ended, Ended::Stopped, "{script}");
        assert_eq!(
            progress.last_reason(),
            Some(UpdateReason::VersionMismatch),
            "{script}"
        );
        node.untouched();
    }
}

#[test]
fn a_failed_download_never_swaps() {
    let node = Node::new();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let mut progress = Recorded::default();
    let ended = self_replace(
        &node.machine(),
        &request(format!("http://127.0.0.1:{port}/a.tar.gz"), "0".repeat(64)),
        &mut progress,
    );
    assert_eq!(ended, Ended::Stopped);
    assert_eq!(progress.last_reason(), Some(UpdateReason::DownloadFailed));
    node.untouched();
}

#[cfg(unix)]
#[test]
fn a_dead_man_that_cannot_arm_stops_before_the_swap() {
    let node = Node::new();
    *node.scheduler.refuse.borrow_mut() = true;
    let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
    let url = serve(archive.clone());
    let mut progress = Recorded::default();
    let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
    assert_eq!(ended, Ended::Stopped);
    assert!(node.live_text().contains("0.4.2"));
    let saved = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(saved.phase(), Phase::Failed);
    assert!(
        saved.needs_report(),
        "reported until the server acknowledges it"
    );
}

/// Swapped in, as `self_replace` leaves it, with a new build that dies at once.
#[cfg(unix)]
fn swapped_node() -> (Node, UpdateState) {
    let node = Node::new();
    let archive =
        archive_with("#!/bin/sh\ncase \"$1\" in --version) echo 'wsmp 0.4.3';; *) exit 1;; esac\n");
    let url = serve(archive.clone());
    let mut progress = Recorded::default();
    assert_eq!(
        self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress),
        Ended::Swapped
    );
    let saved = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    (node, saved)
}

/// R7-B-1, through both producers of a dead-man (the update, and a start
/// that re-arms a lost one): each runs in a child whose working directory
/// is the updater's, with a relative state directory. The job it arms
/// names the state directory absolutely, and that command, run from
/// another working directory (the scheduler's), restores the old build.
/// The same command with the relative path finds nothing there and rolls
/// nothing back (what was armed before).
#[cfg(unix)]
#[test]
fn a_relative_state_dir_is_armed_absolute_and_the_job_restores_from_another_cwd() {
    const NAME: &str = "relay::update::flow::tests::a_relative_state_dir_is_armed_absolute_and_the_job_restores_from_another_cwd";
    const SCRIPT: &str =
        "#!/bin/sh\ncase \"$1\" in --version) echo 'wsmp 0.4.3';; *) exit 1;; esac\n";
    if let Some(mode) = std::env::var_os("WSMP_TEST_R7B1_MODE") {
        let out = PathBuf::from(std::env::var_os("WSMP_TEST_R7B1_OUT").expect("out"));
        let var = |name: &str| std::env::var(name).expect(name);
        let emit = |scheduler: &FakeScheduler| {
            let spec = scheduler.registered.borrow().clone().expect("armed");
            let mut job = vec![spec.program_text().expect("program").to_string()];
            job.extend(spec.rollback_args().expect("args"));
            std::fs::write(&out, job.join("\n")).expect("job");
        };
        let node = Node::new();
        match mode.to_str().expect("mode") {
            "update" => {
                let archive = archive_with(SCRIPT);
                let url = serve(archive.clone());
                let machine = Machine {
                    state_dir: "relative-state".into(),
                    live: var("WSMP_TEST_R7B1_LIVE").into(),
                    ..node.machine()
                };
                let mut progress = Recorded::default();
                let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
                assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
            }
            "start" => {
                let sha = var("WSMP_TEST_R7B1_SHA");
                let now = var("WSMP_TEST_R7B1_NOW").parse().expect("now");
                let start = on_start(
                    Path::new("relative-state/update"),
                    Some(&node.scheduler),
                    new_build(&sha),
                    3,
                    now,
                )
                .expect("start");
                assert!(matches!(start, OnStart::AwaitConfirm(_)), "{start:?}");
            }
            "job" => {
                // What `wsmp update rollback` does with the job's
                // arguments (`commands::update::run`), past any deadline.
                let job = std::fs::read_to_string(var("WSMP_TEST_R7B1_JOB")).expect("job");
                let args: Vec<&str> = job.lines().collect();
                let after = |flag: &str| {
                    args.iter()
                        .position(|arg| *arg == flag)
                        .and_then(|at| args.get(at + 1))
                        .copied()
                        .expect(flag)
                };
                crate::paths::pin(None, Some(after("--state-dir").into())).expect("pin");
                let outcome = rollback_if_unconfirmed(
                    &crate::relay::update::update_dir().expect("update dir"),
                    after("--if-unconfirmed"),
                    u64::MAX / 2,
                    None,
                    || None,
                );
                std::fs::write(&out, format!("{outcome:?}")).expect("outcome");
                return;
            }
            other => panic!("unknown mode {other}"),
        }
        emit(&node.scheduler);
        return;
    }

    let child = |mode: &str, cwd: &Path, out: &Path, env: &[(&str, std::ffi::OsString)]| {
        let ran = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", NAME, "--nocapture"])
            .current_dir(cwd)
            .env("WSMP_TEST_R7B1_MODE", mode)
            .env("WSMP_TEST_R7B1_OUT", out)
            .envs(env.iter().map(|(name, value)| (name, value)))
            .output()
            .expect("child");
        assert!(
            ran.status.success(),
            "{mode}: {}{}",
            String::from_utf8_lossy(&ran.stdout),
            String::from_utf8_lossy(&ran.stderr)
        );
        std::fs::read_to_string(out).expect("child output")
    };
    for producer in ["update", "start"] {
        let node = Node::new();
        let updater = node.root.path().join("updater");
        let manager = node.root.path().join("manager");
        std::fs::create_dir_all(&updater).expect("updater");
        std::fs::create_dir_all(&manager).expect("manager");
        let state_dir = updater.join("relative-state");
        let job_file = node.root.path().join("job");
        if producer == "update" {
            child(
                producer,
                &updater,
                &job_file,
                &[("WSMP_TEST_R7B1_LIVE", node.live.clone().into())],
            );
        } else {
            // Swapped (here, absolute), then the dead-man went missing:
            // the new build's start re-arms it from a relative path.
            let archive = archive_with(SCRIPT);
            let url = serve(archive.clone());
            let machine = Machine {
                state_dir: state_dir.clone(),
                ..node.machine()
            };
            let mut progress = Recorded::default();
            let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
            assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
            let saved = state::load(&state_dir.join("update"))
                .expect("load")
                .expect("state");
            child(
                producer,
                &updater,
                &job_file,
                &[
                    ("WSMP_TEST_R7B1_SHA", node.live_sha().into()),
                    (
                        "WSMP_TEST_R7B1_NOW",
                        (saved.deadline + 10).to_string().into(),
                    ),
                ],
            );
        }
        let job = std::fs::read_to_string(&job_file).expect("job");
        let expected = std::fs::canonicalize(&updater)
            .expect("canonical")
            .join("relative-state");
        assert!(node.live_text().contains("0.4.3"), "{producer}: swapped");

        // The job as armed before this fix, from the scheduler's directory:
        // no update there, nothing rolled back.
        let relative_job = node.root.path().join("relative-job");
        let relative = job.replace(&expected.display().to_string(), "relative-state");
        std::fs::write(&relative_job, relative).expect("relative job");
        let outcome = child(
            "job",
            &manager,
            &node.root.path().join("relative-outcome"),
            &[("WSMP_TEST_R7B1_JOB", relative_job.into())],
        );
        assert_eq!(outcome, "Ok(NotOurs)", "{producer}");
        assert!(node.live_text().contains("0.4.3"), "{producer}");

        // The job as armed now, from the same directory: the old build is back.
        let outcome = child(
            "job",
            &manager,
            &node.root.path().join("outcome"),
            &[("WSMP_TEST_R7B1_JOB", job_file.into())],
        );
        assert_eq!(outcome, "Ok(RolledBack)", "{producer}");
        assert!(node.live_text().contains("0.4.2"), "{producer}: restored");
        let restored = state::load(&state_dir.join("update"))
            .expect("load")
            .expect("state");
        assert_eq!(restored.phase(), Phase::RolledBack, "{producer}");
        // Armed with the updater's directory, made absolute.
        assert!(
            job.ends_with(&format!("\n--state-dir\n{}", expected.display())),
            "{producer}: {job}"
        );
    }
}

#[cfg(unix)]
#[test]
fn an_unconfirmed_build_is_rolled_back_at_the_deadline() {
    let (node, saved) = swapped_node();
    // A new build that exits right away never confirms; the dead-man fires.
    let early = rollback_if_unconfirmed(
        &node.update_dir(),
        &saved.update_id,
        saved.deadline - 30,
        None,
        || None,
    )
    .expect("early");
    assert_eq!(early, Rollback::NotDue(Duration::from_secs(30)));
    assert!(node.live_text().contains("0.4.3"));
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            "BBBBBBBBBBBBBBBBBBBBBB",
            saved.deadline,
            None,
            || None
        )
        .expect("other"),
        Rollback::NotOurs
    );
    let due = rollback_if_unconfirmed(
        &node.update_dir(),
        &saved.update_id,
        saved.deadline,
        None,
        || Some("panicked at definition sync".into()),
    )
    .expect("due");
    assert_eq!(due, Rollback::RolledBack);
    assert!(node.live_text().contains("0.4.2"));
    assert!(
        std::fs::read_to_string(node.live.with_file_name("wsmp.failed"))
            .expect("failed")
            .contains("0.4.3")
    );
    // The old binary starts and reports the rollback with the log tail.
    let start =
        on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, 0).expect("start");
    let OnStart::Report(report) = start else {
        panic!("expected a report, got {start:?}");
    };
    assert_eq!(report.phase(), Phase::RolledBack);
    assert_eq!(
        report.detail.as_deref(),
        Some("panicked at definition sync")
    );
    // Running twice changes nothing.
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline,
            None,
            || { None }
        )
        .expect("again"),
        Rollback::Settled
    );
    assert!(node.live_text().contains("0.4.2"));
}

#[cfg(unix)]
#[test]
fn a_dead_man_whose_time_passed_unrun_is_armed_again() {
    let (node, saved) = swapped_node();
    let sha = node.live_sha();
    let deadman_at = saved.deadman_at.expect("armed");
    let before = *node.scheduler.registrations.borrow();
    // A start before the dead-man's time: it will run, nothing to do.
    on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        new_build(&sha),
        3,
        deadman_at - 1,
    )
    .expect("start");
    assert_eq!(*node.scheduler.registrations.borrow(), before);
    // After a reboot its time has passed and it is not running: armed for
    // the moved deadline.
    let late = deadman_at + 300;
    on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        new_build(&sha),
        3,
        late,
    )
    .expect("start");
    assert_eq!(*node.scheduler.registrations.borrow(), before + 1);
    let rearmed = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(rearmed.deadman_at, Some(rearmed.deadline));
    assert_eq!(
        node.scheduler
            .registered
            .borrow()
            .as_ref()
            .map(DeadmanSpec::fire_in),
        Some(Duration::from_secs(rearmed.deadline - late))
    );
    // Running now (waiting for the deadline): left alone.
    *node.scheduler.running_for.borrow_mut() = 1;
    on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        new_build(&sha),
        3,
        rearmed.deadline + 1,
    )
    .expect("start");
    assert_eq!(*node.scheduler.registrations.borrow(), before + 1);
}

/// F-FA-1: the dead-man's program (the recovery copy) is not the rollback copy, survives the
/// restore, and stays while its job is registered or anything is still owed (a restart);
/// only once the job is gone and nothing is owed does a sweep remove it.
#[cfg(unix)]
#[test]
fn the_job_keeps_its_program_while_it_is_registered_or_owed() {
    let (node, saved) = swapped_node();
    let recovery = saved.recovery_path.clone().expect("recorded");
    assert_eq!(
        node.scheduler
            .registered
            .borrow()
            .as_ref()
            .map(|spec| spec.program().to_path_buf()),
        Some(recovery.clone())
    );
    let outcome = rollback_if_unconfirmed(
        &node.update_dir(),
        &saved.update_id,
        saved.deadline + 10,
        None,
        || None,
    )
    .expect("rollback");
    assert_eq!(outcome, Rollback::RolledBack);
    assert!(
        !saved.prev_path.exists(),
        "the restore consumed the rollback copy"
    );
    assert!(recovery.exists(), "never the job's program");
    // The old build starts while the job is still registered (its restart is owed):
    // nothing is swept.
    let start = |now| {
        on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, now).expect("start")
    };
    start(saved.deadline + 20);
    assert!(recovery.exists(), "a registered job keeps its program");
    // The job is gone but the restart is still owed: kept for a job armed again.
    let spec = node.scheduler.registered.borrow().clone().expect("job");
    node.scheduler.remove().expect("remove");
    start(saved.deadline + 30);
    assert!(recovery.exists(), "still owed");
    // Nothing owed, but a job is registered (its removal failed, say): it keeps its
    // program, whatever the state says.
    node.scheduler.register(&spec).expect("job again");
    restart_done(&node.update_dir(), &saved.update_id).expect("done");
    start(saved.deadline + 40);
    assert!(recovery.exists(), "a registered job keeps its program");
    // Nothing owed and no job: removed.
    node.scheduler.remove().expect("remove");
    start(saved.deadline + 50);
    assert!(!recovery.exists(), "swept");
}

#[cfg(unix)]
#[test]
fn a_job_without_recovery_or_matching_installed_bytes_is_discarded() {
    let (node, mut saved) = swapped_node();
    saved.recovery_path = None;
    state::save(&node.update_dir(), &saved).expect("save");
    std::fs::write(&node.live, "another build").expect("replace live");
    let live = node.live_text();
    let prev = std::fs::read(&saved.prev_path).expect("prev");
    assert_eq!(
        no_longer_due(&node.update_dir(), &saved.update_id),
        Some(Rollback::Settled)
    );
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline + 300,
            None,
            || None
        )
        .expect("stale"),
        Rollback::Settled
    );
    assert!(matches!(
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&node.live_sha()),
            3,
            saved.deadline + 300
        )
        .expect("start"),
        OnStart::Report(_)
    ));
    assert!(
        node.scheduler.registered.borrow().is_none(),
        "stale job removed"
    );
    assert_eq!(node.live_text(), live);
    assert_eq!(std::fs::read(&saved.prev_path).expect("prev"), prev);
    let stored = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(stored.phase(), Phase::Failed);
    assert!(stored.recovery_path.is_none());
}

#[cfg(unix)]
#[test]
fn a_0_4_3_update_state_without_recovery_path_confirms_matching_bytes() {
    let node = Node::new();
    let mut fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/upgrade-0.4.3/state.json"
    ))
    .expect("fixture");
    fixture["livePath"] = serde_json::json!(node.live);
    fixture["prevPath"] = serde_json::json!(node.live.with_file_name("wsmp.prev"));
    fixture["failedPath"] = serde_json::json!(node.live.with_file_name("wsmp.failed"));
    std::fs::create_dir_all(node.update_dir()).expect("dir");
    std::fs::write(state::path(&node.update_dir()), fixture.to_string()).expect("state");
    std::fs::write(&node.live, b"wsmp 1.0 fixture\n").expect("live");
    let saved = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert!(saved.recovery_path.is_none());
    std::fs::write(&saved.prev_path, "wsmp 0.4.3 fixture").expect("prev");
    let spec = DeadmanSpec::new(
        saved.update_id.clone(),
        &saved.prev_path,
        node.root.path(),
        Duration::from_secs(90),
    )
    .expect("old dead-man");
    node.scheduler.register(&spec).expect("register");
    let started = on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        Running {
            version: "1.0.0",
            sha256: Some(&node.live_sha()),
        },
        3,
        saved.deadline - 90,
    )
    .expect("start new build");
    assert!(matches!(started, OnStart::AwaitConfirm(ref current)
        if current.attempts == 1 && current.recovery_path.is_none()));
    assert!(
        node.scheduler.registered.borrow().is_some(),
        "rollback stays armed until healthy"
    );
    assert!(matches!(
        confirm(
            &node.update_dir(),
            Some(&node.scheduler),
            &saved.update_id,
            |_| None
        )
        .expect("confirm"),
        Confirm::Confirmed(_)
    ));
    assert!(
        node.scheduler.registered.borrow().is_none(),
        "disarmed after confirmation"
    );
    assert_eq!(
        state::load(&node.update_dir())
            .expect("reload")
            .expect("state")
            .phase(),
        state::Phase::Confirmed
    );
    assert_eq!(
        std::fs::read(&node.live).expect("live"),
        b"wsmp 1.0 fixture\n"
    );
}

/// F-FA-1, the inverse: a recovery copy that cannot be written stops the update before
/// anything is armed or swapped (the old build stays live, no job).
#[cfg(unix)]
#[test]
fn a_recovery_copy_that_cannot_be_made_stops_before_the_arm() {
    let node = Node::new();
    let blocked = node
        .live
        .with_file_name(".wsmp-recovery-AAAAAAAAAAAAAAAAAAAAAA");
    std::fs::create_dir_all(blocked.join("in-the-way")).expect("dir");
    let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
    let url = serve(archive.clone());
    let mut progress = Recorded::default();
    let ended = self_replace(&node.machine(), &request(url, sha(&archive)), &mut progress);
    assert_eq!(ended, Ended::Stopped);
    assert_eq!(progress.phases().last(), Some(&UpdatePhase::Failed));
    assert!(node.live_text().contains("0.4.2"));
    assert!(node.scheduler.registered.borrow().is_none());
    assert_eq!(*node.scheduler.registrations.borrow(), 0);
}

#[cfg(unix)]
#[test]
fn a_crash_looping_build_rolls_itself_back_and_a_lost_dead_man_is_re_armed() {
    let (node, saved) = swapped_node();
    // The dead-man went missing: the first start re-arms it.
    *node.scheduler.registered.borrow_mut() = None;
    let sha = node.live_sha();
    let first_at = saved.deadline + 10;
    let first = on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        new_build(&sha),
        2,
        first_at,
    )
    .expect("start");
    assert!(matches!(first, OnStart::AwaitConfirm(_)));
    assert!(node.scheduler.registered.borrow().is_some());
    let rearmed = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    // The window counts from the start.
    assert_eq!(
        rearmed.deadline,
        first_at + u64::from(saved.rollback_after_secs)
    );
    assert_eq!(rearmed.deadman_at, rearmed.deadline.into());
    assert!(matches!(
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&sha),
            2,
            first_at + 5
        )
        .expect("start"),
        OnStart::AwaitConfirm(_)
    ));
    assert_eq!(
        on_start(
            &node.update_dir(),
            Some(&node.scheduler),
            new_build(&sha),
            2,
            first_at + 10
        )
        .expect("start"),
        OnStart::RolledBackSelf
    );
    assert!(node.live_text().contains("0.4.2"));
    assert!(node.scheduler.registered.borrow().is_none());
}

#[cfg(unix)]
#[test]
fn a_dead_man_that_starts_at_once_leaves_an_install_in_progress_alone() {
    // macOS `RunAtLoad`: the job runs while the installer is between arming and the swap.
    let node = Node::new();
    let mut armed = state::sample(node.live.parent().expect("bin"), Phase::Armed);
    armed.live_path = node.live.clone();
    armed.recovery_path = Some(
        Layout::beside(&armed.live_path, &armed.update_id)
            .expect("layout")
            .recovery,
    );
    armed.deadline = 1_793_188_890;
    state::save(&node.update_dir(), &armed).expect("save");
    let new = Layout::beside(&armed.live_path, &armed.update_id)
        .expect("layout")
        .new;
    std::fs::write(&new, b"new build").expect("staged");
    let early = rollback_if_unconfirmed(
        &node.update_dir(),
        &armed.update_id,
        armed.deadline - 60,
        None,
        || None,
    )
    .expect("check");
    assert_eq!(early, Rollback::NotDue(Duration::from_secs(60)));
    assert!(new.exists(), "the staged build stays");
    let still = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(still.phase(), Phase::Armed);
}

#[cfg(unix)]
#[test]
fn a_reboot_during_the_trial_gives_the_new_build_a_full_window() {
    let (node, saved) = swapped_node();
    let window = u64::from(saved.rollback_after_secs);
    let armed_at = saved.deadline - window;
    // Off past the deadline; the dead-man fires at boot, 5 s after the machine started.
    let boot = saved.deadline + 600;
    let at_boot = rollback_if_unconfirmed(
        &node.update_dir(),
        &saved.update_id,
        boot + 5,
        Some(boot),
        || None,
    )
    .expect("at boot");
    assert_eq!(at_boot, Rollback::NotDue(Duration::from_secs(window - 5)));
    assert!(node.live_text().contains("0.4.3"), "not rolled back yet");
    // A boot before the update was armed changes nothing.
    let earlier_boot = rollback_if_unconfirmed(
        &node.update_dir(),
        &saved.update_id,
        saved.deadline,
        Some(armed_at - 3600),
        || None,
    )
    .expect("old boot");
    assert_eq!(earlier_boot, Rollback::RolledBack);
}

#[cfg(unix)]
#[test]
fn an_update_interrupted_before_the_swap_fails_safe() {
    let node = Node::new();
    let mut armed = state::sample(node.live.parent().expect("bin"), Phase::Armed);
    armed.live_path = node.live.clone();
    armed.recovery_path = Some(
        Layout::beside(&armed.live_path, &armed.update_id)
            .expect("layout")
            .recovery,
    );
    state::save(&node.update_dir(), &armed).expect("save");
    let new = Layout::beside(&armed.live_path, &armed.update_id)
        .expect("layout")
        .new;
    std::fs::write(&new, b"new build").expect("staged");
    let start =
        on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, 0).expect("start");
    let OnStart::Report(report) = start else {
        panic!("expected a report, got {start:?}");
    };
    assert_eq!(report.phase(), Phase::Failed);
    assert!(node.live_text().contains("0.4.2"));
    assert!(!new.exists(), "the staged build is removed");
    // The dead-man for an update that never swapped moves nothing.
    std::fs::write(&new, b"new build").expect("staged");
    state::save(&node.update_dir(), &armed).expect("save");
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            &armed.update_id,
            u64::MAX / 2,
            None,
            || None
        )
        .expect("check"),
        Rollback::NeverSwapped
    );
    assert!(node.live_text().contains("0.4.2"));
}

#[cfg(unix)]
#[test]
fn a_swap_whose_state_was_never_saved_is_still_rolled_back() {
    // The installer died between the swap and saving `swapped`.
    let (node, mut saved) = swapped_node();
    saved.lifecycle = Lifecycle::Armed;
    state::save(&node.update_dir(), &saved).expect("save");
    let due = rollback_if_unconfirmed(
        &node.update_dir(),
        &saved.update_id,
        saved.deadline,
        None,
        || None,
    )
    .expect("due");
    assert_eq!(due, Rollback::RolledBack);
    assert!(node.live_text().contains("0.4.2"));
}

#[cfg(unix)]
#[test]
fn a_build_rolled_back_first_never_confirms() {
    let (node, saved) = swapped_node();
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline,
            None,
            || None
        )
        .expect("due"),
        Rollback::RolledBack
    );
    assert_eq!(
        confirm(&node.update_dir(), None, &saved.update_id, |_| None).expect("confirm"),
        Confirm::RolledBack
    );
    assert_eq!(
        state::load(&node.update_dir())
            .expect("load")
            .expect("state")
            .phase(),
        Phase::RolledBack
    );
}

#[cfg(unix)]
#[test]
fn the_lock_keeps_the_dead_man_and_a_confirmation_apart() {
    let (node, saved) = swapped_node();
    let held = state::UpdateLock::acquire(&node.update_dir())
        .expect("lock")
        .expect("free");
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline,
            None,
            || None
        )
        .expect("locked"),
        Rollback::NotDue(LOCKED_RETRY)
    );
    assert!(confirm(&node.update_dir(), None, &saved.update_id, |_| None).is_err());
    assert!(node.live_text().contains("0.4.3"), "nothing moved");
    drop(held);
    assert!(matches!(
        confirm(&node.update_dir(), None, &saved.update_id, |_| None).expect("confirm"),
        Confirm::Confirmed(_)
    ));
}

#[cfg(unix)]
#[test]
fn another_build_of_the_same_version_is_not_the_update() {
    // The install stopped before the swap; the old build has the same version.
    let (node, saved) = swapped_node();
    let other = on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        new_build(&"0".repeat(64)),
        3,
        0,
    )
    .expect("start");
    let OnStart::Report(report) = other else {
        panic!("expected a report, got {other:?}");
    };
    assert_eq!(report.update_id, saved.update_id);
    assert_eq!(report.phase(), Phase::Failed);
}

#[cfg(unix)]
#[test]
fn the_window_counts_from_the_new_builds_start() {
    let (node, saved) = swapped_node();
    let window = u64::from(saved.rollback_after_secs);
    // A slow restart: the new build starts just before the first deadline.
    let started = saved.deadline - 1;
    on_start(
        &node.update_dir(),
        Some(&node.scheduler),
        new_build(&node.live_sha()),
        3,
        started,
    )
    .expect("start");
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            &saved.update_id,
            saved.deadline,
            None,
            || None
        )
        .expect("first deadline"),
        Rollback::NotDue(Duration::from_secs(window - 1))
    );
    assert!(node.live_text().contains("0.4.3"));
}

#[cfg(unix)]
#[test]
fn a_node_busy_again_before_the_swap_is_left_alone() {
    let node = Node::new();
    let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
    let url = serve(archive.clone());
    let busy = |_: &mut dyn Progress| Err("an instance started".to_string());
    let machine = Machine {
        before_swap: Some(&busy),
        ..node.machine()
    };
    let mut progress = Recorded::default();
    let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
    assert_eq!(ended, Ended::Stopped);
    assert_eq!(progress.last_reason(), Some(UpdateReason::Busy));
    node.untouched();
    assert_eq!(state::load(&node.update_dir()).expect("load"), None);
}

/// F-FA-1: full control and the operator's setting are asked again after
/// the dead-man is armed, right before the swap. Lowered while the
/// service manager registers the dead-man: refused (the reason the gate
/// gives), the old build stays, the state is ended (failed, with that
/// reason, to be reported) and the dead-man removed. Inverses: lowered
/// before the arm refuses with nothing armed or recorded; never lowered
/// swaps.
#[cfg(unix)]
#[test]
fn a_node_lowered_while_the_dead_man_registers_is_not_swapped() {
    use std::cell::Cell;
    use std::rc::Rc;
    let lowered_detail = "the node was lowered to Relay only; wsmp was not upgraded";
    for when in ["during the arm", "before the arm", "never"] {
        let node = Node::new();
        let lowered = Rc::new(Cell::new(false));
        let gate = {
            let lowered = Rc::clone(&lowered);
            move || -> std::result::Result<(), (UpdateReason, String)> {
                if lowered.get() {
                    Err((UpdateReason::NotOwnerTrust, lowered_detail.to_string()))
                } else {
                    Ok(())
                }
            }
        };
        // The last step before the arm: the idle check.
        let before = {
            let lowered = Rc::clone(&lowered);
            move |_: &mut dyn Progress| -> std::result::Result<(), String> {
                if when == "before the arm" {
                    lowered.set(true);
                }
                Ok(())
            }
        };
        if when == "during the arm" {
            let lowered = Rc::clone(&lowered);
            *node.scheduler.during_register.borrow_mut() =
                Some(Box::new(move || lowered.set(true)));
        }
        let machine = Machine {
            proceed: Some(&gate),
            before_swap: Some(&before),
            ..node.machine()
        };
        let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
        let url = serve(archive.clone());
        let mut progress = Recorded::default();
        let ended = self_replace(&machine, &request(url, sha(&archive)), &mut progress);
        let saved = state::load(&node.update_dir()).expect("load");
        match when {
            "during the arm" => {
                assert_eq!(ended, Ended::Stopped, "{:?}", progress.0);
                assert_eq!(
                    progress.phases(),
                    [
                        UpdatePhase::Downloading,
                        UpdatePhase::Verifying,
                        UpdatePhase::Armed,
                        UpdatePhase::Refused
                    ]
                );
                assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
                assert!(node.live_text().contains("0.4.2"), "the old build stays");
                assert_eq!(*node.scheduler.registrations.borrow(), 1);
                assert!(
                    node.scheduler.registered.borrow().is_none(),
                    "the dead-man is removed"
                );
                let saved = saved.expect("state");
                assert_eq!(saved.phase(), Phase::Failed);
                assert_eq!(saved.reason, Some(UpdateReason::NotOwnerTrust));
                assert!(saved.needs_report());
                assert!(
                    !node.live.with_file_name("wsmp.new").exists(),
                    "the new build is not left beside the live one"
                );
                // A dead-man that could not be removed finds it settled.
                assert_eq!(
                    rollback_if_unconfirmed(
                        &node.update_dir(),
                        &saved.update_id,
                        u64::MAX / 2,
                        None,
                        || None
                    )
                    .expect("check"),
                    Rollback::Settled
                );
                assert!(node.live_text().contains("0.4.2"));
            }
            "before the arm" => {
                assert_eq!(ended, Ended::Stopped);
                assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
                assert!(!progress.phases().contains(&UpdatePhase::Armed));
                assert_eq!(*node.scheduler.registrations.borrow(), 0);
                node.untouched();
                assert_eq!(saved, None);
            }
            _ => {
                assert_eq!(ended, Ended::Swapped, "{:?}", progress.0);
                assert!(node.live_text().contains("0.4.3"));
                assert!(node.scheduler.registered.borrow().is_some(), "armed");
                assert_eq!(saved.expect("state").phase(), Phase::Swapped);
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn a_waiting_dead_man_sees_its_update_settle_without_the_lock() {
    let (node, saved) = swapped_node();
    assert_eq!(no_longer_due(&node.update_dir(), &saved.update_id), None);
    let _held = state::UpdateLock::acquire(&node.update_dir())
        .expect("lock")
        .expect("free");
    let mut done = saved.clone();
    done.confirm().expect("confirm");
    state::save(&node.update_dir(), &done).expect("save");
    assert_eq!(
        no_longer_due(&node.update_dir(), &saved.update_id),
        Some(Rollback::Settled)
    );
    assert_eq!(
        no_longer_due(&node.update_dir(), "BBBBBBBBBBBBBBBBBBBBBB"),
        Some(Rollback::NotOurs)
    );
}

#[cfg(unix)]
#[test]
fn a_homebrew_update_records_the_new_kegs_build() {
    let node = Node::new();
    let prefix = node.root.path().join("brew");
    let new_keg = prefix.join("Cellar/wsmp/0.4.3/bin");
    std::fs::create_dir_all(&new_keg).expect("keg");
    std::fs::write(new_keg.join("wsmp"), "new build").expect("binary");
    let opt = prefix.join("opt/wsmp");
    std::fs::create_dir_all(opt.parent().expect("opt")).expect("opt dir");
    std::os::unix::fs::symlink(prefix.join("Cellar/wsmp/0.4.3"), &opt).expect("link");
    let stable = opt.join("bin/wsmp");
    record_homebrew(
        &node.machine(),
        &request(String::new(), String::new()),
        &stable,
    )
    .expect("record");
    let saved = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(
        saved.to_sha256.as_deref(),
        Some(sha(b"new build").as_str()),
        "the new keg's binary, not the running one"
    );
    assert_eq!(saved.live_path, stable);
}

#[test]
fn archive_names_come_from_the_url() {
    assert_eq!(
        archive_name("https://h/releases/download/v1/wsmp-x86_64-unknown-linux-gnu.tar.xz?x=1"),
        "wsmp-x86_64-unknown-linux-gnu.tar.xz"
    );
    assert_eq!(archive_name("https://h/"), "wsmp-update-archive");
    assert_eq!(archive_name("https://h/..%2f"), "wsmp-update-archive");
}

/// The state directory stops taking writes while the dead-man registers
/// (`update_dir` becomes a plain file; the real directory, with the
/// durable `armed` state in it, is kept aside), and the node is lowered
/// at the same moment. `restore_after`: when to put the directory back
/// (`None`: only by hand, after the update returned).
#[cfg(unix)]
fn revoked_while_storage_fails(
    restore_after: Option<Duration>,
) -> (Node, Ended, Recorded, PathBuf) {
    use std::cell::Cell;
    use std::rc::Rc;
    let node = Node::new();
    let held = node.root.path().join("held-state");
    let lowered = Rc::new(Cell::new(false));
    {
        let lowered = Rc::clone(&lowered);
        let (update_dir, held) = (node.update_dir(), held.clone());
        *node.scheduler.during_register.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&update_dir, &held).expect("aside");
            std::fs::write(&update_dir, b"not a directory").expect("block");
            lowered.set(true);
            if let Some(after) = restore_after {
                let (update_dir, held) = (update_dir.clone(), held.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(after);
                    std::fs::remove_file(&update_dir).expect("unblock");
                    std::fs::rename(&held, &update_dir).expect("back");
                });
            }
        }));
    }
    let gate = {
        let lowered = Rc::clone(&lowered);
        move || -> std::result::Result<(), (UpdateReason, String)> {
            if lowered.get() {
                Err((UpdateReason::NotOwnerTrust, "lowered during the arm".into()))
            } else {
                Ok(())
            }
        }
    };
    let machine = Machine {
        proceed: Some(&gate),
        ..node.machine()
    };
    let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
    let mut progress = Recorded::default();
    let ended = self_replace(
        &machine,
        &request(serve(archive.clone()), sha(&archive)),
        &mut progress,
    );
    (node, ended, progress, held)
}

/// F-FA-3 (the reviewer's `fa_revocation_save_failure_must_keep_a_recovery_trigger`):
/// refused after the arm while the terminal state cannot be saved at
/// all. The dead-man stays armed, and `wsmp.new` (its evidence that no
/// swap happened) stays beside the live binary; once storage works again
/// the dead-man's own check settles the update (`NeverSwapped`, `failed`)
/// with the old build in place, and later updates are free again.
#[cfg(unix)]
#[test]
fn fa_revocation_save_failure_must_keep_a_recovery_trigger() {
    let (node, ended, progress, held) = revoked_while_storage_fails(None);
    assert_eq!(ended, Ended::Stopped);
    assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
    assert!(node.live_text().contains("0.4.2"), "the old build stays");
    assert!(
        node.scheduler.registered.borrow().is_some(),
        "the dead-man stays armed while the end is not durable"
    );
    assert_eq!(*node.scheduler.removals.borrow(), 0);
    assert!(
        node.live.with_file_name("wsmp.new").exists(),
        "the dead-man's evidence (no swap) is kept"
    );
    // Storage works again; the durable state is still `armed`.
    std::fs::remove_file(node.update_dir()).expect("unblock");
    std::fs::rename(&held, node.update_dir()).expect("back");
    let durable = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(durable.phase(), Phase::Armed);
    // The dead-man fires at its deadline: nothing was swapped, so it
    // records the end itself and moves nothing.
    assert_eq!(
        rollback_if_unconfirmed(
            &node.update_dir(),
            &durable.update_id,
            durable.deadline + 2,
            None,
            || None,
        )
        .expect("dead-man"),
        Rollback::NeverSwapped
    );
    let settled = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(settled.phase(), Phase::Failed);
    assert!(
        !settled.phase().in_progress(),
        "later updates are free again"
    );
    assert!(!node.live.with_file_name("wsmp.new").exists());
    assert!(node.live_text().contains("0.4.2"));
}

/// Inverse: a save that fails once and then works (a transient error)
/// is tried again; once the end is durable the dead-man is removed and
/// nothing is left beside the live binary, as with no fault at all.
#[cfg(unix)]
#[test]
fn a_terminal_save_that_fails_once_is_tried_again_before_the_dead_man_goes() {
    let (node, ended, progress, _held) =
        revoked_while_storage_fails(Some(Duration::from_millis(10)));
    assert_eq!(ended, Ended::Stopped);
    assert_eq!(progress.last_reason(), Some(UpdateReason::NotOwnerTrust));
    let saved = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(saved.phase(), Phase::Failed);
    assert_eq!(saved.reason, Some(UpdateReason::NotOwnerTrust));
    assert!(
        node.scheduler.registered.borrow().is_none(),
        "removed once durable"
    );
    assert!(!node.live.with_file_name("wsmp.new").exists());
    assert!(node.live_text().contains("0.4.2"));
}

/// A scheduler whose registration fails after it made the state directory unwritable (the
/// installer's terminal saves then fail too), with no job installed (F-FA-3, review P8).
#[cfg(unix)]
struct Unarmed<'a> {
    dir: PathBuf,
    held: PathBuf,
    registered: &'a std::cell::Cell<bool>,
}

#[cfg(unix)]
impl Scheduler for Unarmed<'_> {
    fn present(&self) -> Result<bool> {
        Ok(self.registered.get())
    }
    fn running(&self) -> Result<bool> {
        Ok(false)
    }
    fn register(&self, _: &DeadmanSpec) -> Result<()> {
        std::fs::rename(&self.dir, &self.held)?;
        std::fs::write(&self.dir, b"temporarily not a directory")?;
        anyhow::bail!("service manager temporarily unavailable")
    }
    fn remove(&self) -> Result<()> {
        self.registered.set(false);
        Ok(())
    }
}

/// Review P8 (F-FA-3), with the fixed expectation: arming fails and every terminal save
/// fails, so the installer leaves a durable `armed` state and no dead-man. Once storage is
/// back, the next attempt, under the update lock, settles it (instead of refusing every
/// update until the relay restarts), and the update after it installs.
#[cfg(unix)]
#[test]
fn fa_unarmed_terminal_save_failure_has_no_recovery_trigger() {
    let node = Node::new();
    let registered = std::cell::Cell::new(false);
    let held = node.root.path().join("held-state");
    let scheduler = Unarmed {
        dir: node.update_dir(),
        held: held.clone(),
        registered: &registered,
    };
    let machine = Machine {
        scheduler: Some(&scheduler),
        ..node.machine()
    };
    let archive = archive_with("#!/bin/sh\necho 'wsmp 0.4.3'\n");
    let mut reports = Recorded::default();
    assert_eq!(
        self_replace(
            &machine,
            &request(serve(archive.clone()), sha(&archive)),
            &mut reports
        ),
        Ended::Stopped
    );
    assert_eq!(reports.last_reason(), Some(UpdateReason::Internal));
    std::fs::remove_file(node.update_dir()).expect("storage restored");
    std::fs::rename(&held, node.update_dir()).expect("directory restored");
    let stranded = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(stranded.phase(), Phase::Armed);
    assert!(!registered.get(), "no dead-man exists to settle this state");
    assert!(node.live.with_file_name("wsmp.new").exists());

    // The next attempt: its lock proves no installer, dead-man run or confirmation is active.
    let lock = state::UpdateLock::acquire(&node.update_dir())
        .expect("lock")
        .expect("free");
    assert!(settle_abandoned(&node.update_dir(), Some(&scheduler), &lock).expect("settle"));
    let settled = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(settled.phase(), Phase::Failed);
    assert_eq!(settled.reason, Some(UpdateReason::Internal));
    assert!(!node.live.with_file_name("wsmp.new").exists());
    assert!(node.live_text().contains("0.4.2"), "nothing was moved");

    // And the update after it goes through.
    let mut reports = Recorded::default();
    let mut next = request(serve(archive.clone()), sha(&archive));
    next.update_id = "BBBBBBBBBBBBBBBBBBBBBB".into();
    assert_eq!(
        self_replace(&node.machine(), &next, &mut reports),
        Ended::Swapped
    );
    drop(lock);
}

/// The inverse of the settle: an `armed` state that still has an owner is never settled by
/// a later attempt. Its dead-man is registered; its swap began (`wsmp.new` gone: the new build
/// may be live); or the scheduler cannot say whether a job is registered.
#[cfg(unix)]
#[test]
fn a_later_attempt_leaves_an_armed_update_that_still_has_an_owner() {
    struct Unsure;
    impl Scheduler for Unsure {
        fn present(&self) -> Result<bool> {
            anyhow::bail!("the service manager did not answer")
        }
        fn running(&self) -> Result<bool> {
            Ok(false)
        }
        fn register(&self, _: &DeadmanSpec) -> Result<()> {
            Ok(())
        }
        fn remove(&self) -> Result<()> {
            Ok(())
        }
    }
    let node = Node::new();
    let update_dir = node.update_dir();
    let mut armed = state::sample(node.live.parent().expect("bin"), Phase::Armed);
    armed.live_path = node.live.clone();
    armed.recovery_path = Some(
        Layout::beside(&armed.live_path, &armed.update_id)
            .expect("layout")
            .recovery,
    );
    state::save(&update_dir, &armed).expect("save");
    let new = node.live.with_file_name("wsmp.new");
    std::fs::write(&new, "new").expect("new");
    let lock = state::UpdateLock::acquire(&update_dir)
        .expect("lock")
        .expect("free");
    let still_armed = || {
        state::load(&update_dir)
            .expect("load")
            .expect("state")
            .phase()
            == Phase::Armed
    };

    // A registered dead-man owns it.
    let spec = DeadmanSpec::new(
        armed.update_id.clone(),
        armed.recovery_path.as_deref().expect("recovery"),
        &node.state_dir(),
        Duration::from_secs(90),
    )
    .expect("spec");
    node.scheduler.register(&spec).expect("register");
    assert!(!settle_abandoned(&update_dir, Some(&node.scheduler), &lock).expect("look"));
    assert!(still_armed());
    node.scheduler.remove().expect("remove");

    // A scheduler that cannot tell: not settled (the error is the caller's to log).
    assert!(settle_abandoned(&update_dir, Some(&Unsure), &lock).is_err());
    assert!(still_armed());

    // The swap began: the dead-man or the next start decides what is live.
    std::fs::remove_file(&new).expect("swap began");
    assert!(!settle_abandoned(&update_dir, Some(&node.scheduler), &lock).expect("look"));
    assert!(still_armed());

    // Control: pre-swap, no job, lock held: settled.
    std::fs::write(&new, "new").expect("new");
    assert!(settle_abandoned(&update_dir, Some(&node.scheduler), &lock).expect("settle"));
    assert!(!still_armed());
}

/// Swaps, then lets the dead-man's restore run and fails the `rolled_back` save right after
/// it (through the log-tail callback, which runs between the two), then puts storage back.
#[cfg(unix)]
fn rollback_whose_save_failed() -> (Node, UpdateState) {
    let (node, current) = swapped_node();
    let held = node.root.path().join("held-rollback-state");
    let failed = rollback_if_unconfirmed(
        &node.update_dir(),
        &current.update_id,
        current.deadline + 2,
        None,
        || {
            std::fs::rename(node.update_dir(), &held).expect("block the save");
            std::fs::write(node.update_dir(), b"not a directory").expect("block");
            None
        },
    );
    assert!(failed.is_err());
    assert!(
        node.live_text().contains("0.4.2"),
        "restored before the save failed"
    );
    assert!(!current.prev_path.exists(), "the restore consumed the copy");
    std::fs::remove_file(node.update_dir()).expect("unblock");
    std::fs::rename(&held, node.update_dir()).expect("storage back");
    let stored = state::load(&node.update_dir())
        .expect("load")
        .expect("state");
    assert_eq!(stored.phase(), Phase::Swapped);
    assert_eq!(
        stored.lifecycle,
        Lifecycle::RollingBack,
        "the intent was saved before the restore"
    );
    (node, current)
}

/// Review P13 (F-FA-4), with the fixed expectations. The restore ran and its `rolled_back`
/// save failed. A confirmation (the new build, still running) must not certify the install
/// the rollback replaced, nor remove the dead-man; the dead-man's next run recognises the
/// completed restore and records it (it found no copy before: `NoCopy`, and no restart).
#[cfg(unix)]
#[test]
fn fa_rollback_save_failure_can_confirm_the_restored_old_binary() {
    for observer in ["confirm", "retry_rollback"] {
        let (node, current) = rollback_whose_save_failed();
        if observer == "confirm" {
            let confirmed = confirm(
                &node.update_dir(),
                Some(&node.scheduler),
                &current.update_id,
                |_| None,
            )
            .expect("confirm");
            assert_eq!(confirmed, Confirm::RolledBack);
            assert!(node.live_text().contains("0.4.2"));
            assert!(
                node.scheduler.registered.borrow().is_some(),
                "the dead-man stays to finish the rollback"
            );
            let stored = state::load(&node.update_dir())
                .expect("load")
                .expect("state");
            assert_ne!(stored.phase(), Phase::Confirmed);
        }
        // The dead-man's next run (at once: a decided rollback does not wait for a deadline).
        assert_eq!(
            rollback_if_unconfirmed(
                &node.update_dir(),
                &current.update_id,
                current.deadline.saturating_sub(1_000),
                None,
                || None,
            )
            .expect("replay"),
            Rollback::RolledBack
        );
        let done = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(done.phase(), Phase::RolledBack);
        assert!(
            done.lifecycle.restart_pending(),
            "the replay still owes the relay a restart"
        );
        assert!(node.live_text().contains("0.4.2"));
    }
}

/// Both rollback sites record their intent before the restore: a restore that fails (here:
/// the binary's directory cannot be written) finds the rollback intent already durable, and the
/// next look finishes the rollback (the dead-man at once, a start as the crash-loop). Without
/// the intent first, the state would still read as a plain unconfirmed update.
#[cfg(unix)]
#[test]
fn both_rollbacks_record_their_intent_before_the_restore() {
    use std::os::unix::fs::PermissionsExt;
    // Root writes into a read-only directory: the failure cannot be staged.
    if nix::unistd::Uid::effective().is_root() {
        return;
    }
    for site in ["deadman", "crash_loop"] {
        let (node, current) = swapped_node();
        let sha = node.live_sha();
        let dir = node.update_dir();
        let bin = node.live.parent().expect("bin").to_path_buf();
        let look = || {
            if site == "deadman" {
                rollback_if_unconfirmed(
                    &dir,
                    &current.update_id,
                    current.deadline + 2,
                    None,
                    || None,
                )
                .map(|_| ())
            } else {
                on_start(&dir, Some(&node.scheduler), new_build(&sha), 0, 0).map(|_| ())
            }
        };
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o500)).expect("ro");
        let result = look();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("rw");
        assert!(result.is_err(), "{site}: the restore failed");
        assert_eq!(node.live_sha(), sha, "{site}: nothing restored");
        assert!(
            current.prev_path.exists(),
            "{site}: the copy is still there"
        );
        let stored = state::load(&dir).expect("load").expect("state");
        assert_eq!(stored.phase(), Phase::Swapped, "{site}");
        assert_eq!(
            stored.lifecycle,
            Lifecycle::RollingBack,
            "{site}: the intent was durable first"
        );
        // The next look finishes it.
        look().expect("finished");
        let done = state::load(&dir).expect("load").expect("state");
        assert_eq!(done.phase(), Phase::RolledBack, "{site}");
        assert!(node.live_text().contains("0.4.2"), "{site}");
    }
}

/// The crash-loop sibling (F-FA-4): a rollback decided and begun, then interrupted (the
/// restore done, `rolled_back` not saved), is finished by the next start, by the dead-man,
/// and refused by a confirmation, whichever comes first. One whose restore did not run yet
/// is finished the same way.
#[cfg(unix)]
#[test]
fn an_interrupted_rollback_is_finished_by_whoever_comes_next() {
    for (restored, next) in [
        (true, "start_old"),
        (true, "deadman"),
        (true, "confirm"),
        (false, "start_new"),
        (false, "deadman"),
        // Decided, not begun: the new build is still installed, and still not confirmed.
        (false, "confirm"),
    ] {
        let (node, current) = swapped_node();
        let sha = node.live_sha();
        let mut interrupted = current.clone();
        interrupted.begin_rollback().expect("decide");
        state::save(&node.update_dir(), &interrupted).expect("intent");
        if restored {
            let layout = layout_of(&current).expect("layout");
            assert!(install::restore(&layout).expect("restore"));
        }
        match next {
            "start_old" => assert!(matches!(
                on_start(&node.update_dir(), Some(&node.scheduler), OLD_BUILD, 3, 0)
                    .expect("start"),
                OnStart::Report(_)
            )),
            "start_new" => assert_eq!(
                on_start(
                    &node.update_dir(),
                    Some(&node.scheduler),
                    new_build(&sha),
                    3,
                    0
                )
                .expect("start"),
                OnStart::RolledBackSelf
            ),
            "deadman" => assert_eq!(
                rollback_if_unconfirmed(&node.update_dir(), &current.update_id, 0, None, || None)
                    .expect("replay"),
                Rollback::RolledBack
            ),
            _ => {
                assert_eq!(
                    confirm(
                        &node.update_dir(),
                        Some(&node.scheduler),
                        &current.update_id,
                        |_| None
                    )
                    .expect("confirm"),
                    Confirm::RolledBack
                );
                assert!(node.scheduler.registered.borrow().is_some());
                continue;
            }
        }
        let done = state::load(&node.update_dir())
            .expect("load")
            .expect("state");
        assert_eq!(done.phase(), Phase::RolledBack, "{restored} {next}");
        assert!(node.live_text().contains("0.4.2"), "{restored} {next}");
        assert!(!current.prev_path.exists());
    }
}

/// The inverse of the confirmation check: a build whose bytes are this update's confirms (the
/// check reads the installed binary, not only the phase); one whose bytes are not does not.
#[cfg(unix)]
#[test]
fn a_confirmation_certifies_only_the_installed_new_build() {
    let (node, current) = swapped_node();
    assert!(matches!(
        confirm(
            &node.update_dir(),
            Some(&node.scheduler),
            &current.update_id,
            |_| None
        )
        .expect("confirm"),
        Confirm::Confirmed(_)
    ));
    let (node, current) = swapped_node();
    std::fs::write(&node.live, "#!/bin/sh\necho 'wsmp 0.4.2'\n").expect("replaced");
    assert_eq!(
        confirm(
            &node.update_dir(),
            Some(&node.scheduler),
            &current.update_id,
            |_| None
        )
        .expect("confirm"),
        Confirm::RolledBack
    );
    assert_eq!(
        state::load(&node.update_dir())
            .expect("load")
            .expect("state")
            .phase(),
        Phase::Swapped
    );
}
