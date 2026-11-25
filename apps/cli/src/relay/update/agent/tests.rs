use super::*;
use crate::wire::protocol::frames::InstallMethod;

#[test]
fn mark_acked_ignores_another_update() {
    let dir = tempfile::tempdir().expect("dir");
    let current = state::sample(dir.path(), state::Phase::Confirmed);
    state::save(dir.path(), &current).expect("save");
    assert_eq!(
        mark_acked(dir.path(), "not-ours").expect("ack"),
        Acked::NotOurs
    );
    assert_eq!(state::load(dir.path()).expect("load"), Some(current));
}

#[test]
fn mark_acked_never_waits_for_a_busy_lock_and_can_retry() {
    let dir = tempfile::tempdir().expect("dir");
    let current = state::sample(dir.path(), state::Phase::Confirmed);
    state::save(dir.path(), &current).expect("save");
    let lock = state::UpdateLock::acquire(dir.path())
        .expect("lock")
        .expect("free");
    let start = Instant::now();
    let result = mark_acked(dir.path(), &current.update_id).expect("ack");
    assert!(start.elapsed() < Duration::from_millis(50));
    assert_eq!(result, Acked::Busy);
    assert_eq!(
        state::load(dir.path()).expect("load"),
        Some(current.clone())
    );
    drop(lock);
    assert_eq!(
        mark_acked(dir.path(), &current.update_id).expect("retry"),
        Acked::Marked
    );
    assert!(
        !state::load(dir.path())
            .expect("load")
            .expect("state")
            .needs_report()
    );
}

#[test]
fn mark_acked_marks_a_terminal_update_only_once() {
    let dir = tempfile::tempdir().expect("dir");
    let current = state::sample(dir.path(), state::Phase::Confirmed);
    state::save(dir.path(), &current).expect("save");
    assert_eq!(
        mark_acked(dir.path(), &current.update_id).expect("ack"),
        Acked::Marked
    );
    assert!(
        !state::load(dir.path())
            .expect("load")
            .expect("state")
            .needs_report()
    );
    assert_eq!(
        mark_acked(dir.path(), &current.update_id).expect("repeat"),
        Acked::NotOurs
    );
}

#[test]
fn mark_acked_ignores_an_unfinished_update_even_with_a_busy_lock() {
    let dir = tempfile::tempdir().expect("dir");
    let current = state::sample(dir.path(), state::Phase::Swapped);
    state::save(dir.path(), &current).expect("save");
    let _lock = state::UpdateLock::acquire(dir.path())
        .expect("lock")
        .expect("free");
    assert_eq!(
        mark_acked(dir.path(), &current.update_id).expect("ack"),
        Acked::NotOurs
    );
    assert_eq!(state::load(dir.path()).expect("load"), Some(current));
}

#[test]
fn spawn_confirm_does_not_wait_for_the_update_lock() {
    let dir = tempfile::tempdir().expect("dir");
    let current = state::sample(dir.path(), state::Phase::Swapped);
    state::save(dir.path(), &current).expect("save");
    let _lock = state::UpdateLock::acquire(dir.path())
        .expect("lock")
        .expect("free");
    let start = Instant::now();
    let rx = spawn_confirm(dir.path().to_owned(), current.update_id, || None).expect("spawn");
    assert!(start.elapsed() < Duration::from_millis(50));
    assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    let result = rx
        .recv_timeout(Duration::from_secs(1))
        .expect("worker result");
    assert_eq!(
        result.expect_err("busy lock").to_string(),
        "the update state is locked"
    );
}

#[test]
fn spawn_confirm_confirms_a_swapped_build_without_a_real_scheduler() {
    let dir = tempfile::tempdir().expect("dir");
    let update_dir = dir.path().join("update");
    let mut current = state::sample(dir.path(), state::Phase::Swapped);
    current.strategy = UpdateStrategy::Homebrew;
    state::save(&update_dir, &current).expect("save");
    let rx = spawn_confirm(update_dir.clone(), current.update_id, || {
        assert_eq!(std::thread::current().name(), Some("wsmp-update-confirm"));
        None
    })
    .expect("spawn");
    let result = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("worker result")
        .expect("confirm");
    assert!(matches!(result, flow::Confirm::Confirmed(_)));
    assert_eq!(
        state::load(&update_dir)
            .expect("load")
            .expect("state")
            .phase(),
        state::Phase::Confirmed
    );
}

#[test]
fn startup_initialization_retries_a_busy_lock_then_allows_confirmation() {
    let dir = tempfile::tempdir().expect("dir");
    let mut current = state::sample(dir.path(), state::Phase::Swapped);
    current.strategy = UpdateStrategy::Homebrew;
    state::save(dir.path(), &current).expect("save");
    let mut lock = state::UpdateLock::acquire(dir.path()).expect("lock");
    assert!(lock.is_some());
    let mut initialization = StartInitialization {
        own_sha256: Some("test-build".into()),
        ..StartInitialization::default()
    };
    assert!(
        initialization
            .attempt_at(dir.path(), &current.to_version, None)
            .is_err()
    );
    // The initial failure ran before the lock was released. Subsequent
    // attempts use exactly the retry worker's initialization context.
    let result = retry_start(
        || initialization.attempt_at(dir.path(), &current.to_version, None),
        |_| drop(lock.take()),
    )
    .expect("retry succeeds");
    let OnStart::AwaitConfirm(ref awaiting) = result else {
        panic!("await confirmation");
    };
    assert_eq!(awaiting.attempts, 1);
    let (tx, rx) = mpsc::channel();
    let mut tracker = tracker();
    tracker.tracking = Tracking::Initializing(rx);
    assert!(!tracker.poll(true).1);
    assert!(matches!(tracker.tracking, Tracking::Initializing(_)));
    tx.send(Ok(result)).expect("initialized");
    assert!(!tracker.poll(true).1);
    assert!(matches!(tracker.tracking, Tracking::AwaitingConfirm(_)));
    // Confirm through the ordinary worker using the temporary update dir.
    let rx =
        spawn_confirm(dir.path().to_owned(), current.update_id.clone(), || None).expect("spawn");
    let confirmed = rx.recv_timeout(Duration::from_secs(2)).expect("worker");
    let Tracking::AwaitingConfirm(awaiting) =
        std::mem::replace(&mut tracker.tracking, Tracking::Idle)
    else {
        panic!("awaiting");
    };
    tracker.apply_confirm_result(awaiting, confirmed);
    assert!(matches!(tracker.tracking, Tracking::Idle));
    let saved = state::load(dir.path()).expect("load").expect("state");
    assert_eq!(saved.phase(), state::Phase::Confirmed);
    assert_eq!(saved.attempts, 1);
}

#[test]
fn startup_initialization_persistent_failure_is_bounded_and_never_counts_twice() {
    let dir = tempfile::tempdir().expect("dir");
    let mut current = state::sample(dir.path(), state::Phase::Swapped);
    current.strategy = UpdateStrategy::Homebrew;
    state::save(dir.path(), &current).expect("save");
    let _lock = state::UpdateLock::acquire(dir.path())
        .expect("lock")
        .expect("free");
    let mut initialization = StartInitialization {
        own_sha256: Some("test-build".into()),
        ..StartInitialization::default()
    };
    let mut waits = Vec::new();
    let result = retry_start(
        || initialization.attempt_at(dir.path(), &current.to_version, None),
        |delay| waits.push(delay.as_secs()),
    );
    assert!(result.is_err());
    assert_eq!(waits, [1, 2, 4, 8, 16, 30]);
    let mut tracker = tracker();
    tracker.apply_start_result(result);
    for _ in 0..10 {
        assert_eq!(tracker.poll(true), (Vec::new(), false));
        assert!(matches!(tracker.tracking, Tracking::InitializationFailed));
    }
    assert_eq!(state::load(dir.path()).expect("load"), Some(current));
}

#[test]
fn startup_initialization_resumes_a_persisted_count_without_replaying_on_start() {
    let dir = tempfile::tempdir().expect("dir");
    let mut current = state::sample(dir.path(), state::Phase::Swapped);
    current.strategy = UpdateStrategy::Homebrew;
    current.attempts = 1;
    state::save(dir.path(), &current).expect("save");
    // Simulate state::save replacing the file, then returning a sync error.
    let mut initialization = StartInitialization {
        before: Some((current.update_id.clone(), 0)),
        own_sha256: Some("test-build".into()),
    };
    for _ in 0..2 {
        assert!(
            matches!(initialization.attempt_at(dir.path(), &current.to_version, None), Ok(OnStart::AwaitConfirm(state)) if state.attempts == 1)
        );
        assert_eq!(
            state::load(dir.path()).expect("load"),
            Some(current.clone())
        );
    }
    // A decided rollback or too many starts must never become confirmable.
    current.lifecycle = state::Lifecycle::RollingBack;
    state::save(dir.path(), &current).expect("save");
    assert!(
        initialization
            .attempt_at(dir.path(), &current.to_version, None)
            .is_err()
    );
    current.lifecycle = state::Lifecycle::Swapped;
    current.attempts = MAX_UNCONFIRMED_STARTS + 1;
    state::save(dir.path(), &current).expect("save");
    assert!(
        initialization
            .attempt_at(dir.path(), &current.to_version, None)
            .is_err()
    );
    assert_eq!(state::load(dir.path()).expect("load"), Some(current));
}

#[test]
fn startup_initialization_rollback_requests_a_restart_after_retry() {
    let mut tracker = tracker();
    let (tx, rx) = mpsc::channel();
    tracker.tracking = Tracking::Initializing(rx);
    tx.send(Ok(OnStart::RolledBackSelf)).expect("result");
    assert!(tracker.poll(true).1);
    assert!(matches!(tracker.tracking, Tracking::Restarting));
}

#[test]
fn confirmation_retry_grows_from_one_second_to_a_minute() {
    let mut retry = ConfirmRetry::default();
    let mut now = Instant::now();
    assert!(retry.ready(now));
    for seconds in [1, 2, 4, 8, 16, 32, 60, 60] {
        let delay = Duration::from_secs(seconds);
        assert_eq!(retry.failed(now), delay);
        assert!(!retry.ready(now));
        assert!(!retry.ready(now + delay - Duration::from_nanos(1)));
        now += delay;
        assert!(retry.ready(now));
    }
}

#[test]
fn confirming_errors_and_dead_threads_return_to_awaiting_confirm() {
    let dir = tempfile::tempdir().expect("dir");
    for disconnected in [false, true] {
        let current = state::sample(dir.path(), state::Phase::Swapped);
        let (tx, rx) = mpsc::channel();
        if !disconnected {
            tx.send(Err(anyhow::anyhow!("confirmation failed")))
                .expect("result");
        }
        drop(tx);
        let mut tracker = tracker();
        tracker.started = Instant::now() - CONFIRM_ALIVE;
        tracker.tracking = Tracking::Confirming {
            awaiting: Box::new(current.clone()),
            rx,
        };
        let (frames, restart) = tracker.poll(true);
        assert!(frames.is_empty());
        assert!(!restart);
        assert!(
            matches!(&tracker.tracking, Tracking::AwaitingConfirm(awaiting) if **awaiting == current)
        );
        let next = tracker.confirm_retry.next_attempt.expect("retry scheduled");
        assert!(!tracker.confirm_retry.ready(next - Duration::from_nanos(1)));
        for _ in 0..10 {
            assert!(tracker.poll(true).0.is_empty());
            assert!(matches!(tracker.tracking, Tracking::AwaitingConfirm(_)));
            assert_eq!(tracker.confirm_retry.next_attempt, Some(next));
        }
    }
}

#[test]
fn confirming_allows_work_ignores_repeats_and_refuses_another_update() {
    let dir = tempfile::tempdir().expect("dir");
    let current = state::sample(dir.path(), state::Phase::Swapped);
    let (tx, rx) = mpsc::channel();
    let mut tracker = tracker();
    tracker.current_id = Some(current.update_id.clone());
    tracker.tracking = Tracking::Confirming {
        awaiting: Box::new(current.clone()),
        rx,
    };
    assert!(!tracker.holds_new_work());
    assert!(
        tracker
            .request(
                frame(&current.update_id, true),
                &gate(),
                TrustWatch::full_for_tests()
            )
            .is_empty()
    );
    assert_eq!(
        reason_of(&tracker.request(
            frame("BBBBBBBBBBBBBBBBBBBBBB", false),
            &gate(),
            TrustWatch::full_for_tests()
        )),
        Some(UpdateReason::InProgress)
    );
    assert!(tracker.poll(true).0.is_empty());
    assert!(matches!(tracker.tracking, Tracking::Confirming { .. }));
    tx.send(Ok(flow::Confirm::RolledBack)).expect("result");
    assert!(tracker.poll(true).1);
    assert!(matches!(tracker.tracking, Tracking::Restarting));
}

#[test]
fn confirming_reports_success_and_returns_to_idle() {
    let dir = tempfile::tempdir().expect("dir");
    let current = state::sample(dir.path(), state::Phase::Confirmed);
    let (tx, rx) = mpsc::channel();
    let mut tracker = tracker();
    tracker.tracking = Tracking::Confirming {
        awaiting: Box::new(current.clone()),
        rx,
    };
    tx.send(Ok(flow::Confirm::Confirmed(Box::new(current))))
        .expect("result");
    let (frames, restart) = tracker.poll(true);
    assert!(matches!(
        frames.as_slice(),
        [NodeFrame::AgentUpdateProgress {
            phase: UpdatePhase::Confirmed,
            ..
        }]
    ));
    assert!(!restart);
    assert!(matches!(tracker.tracking, Tracking::Idle));
}

fn gate() -> Gate {
    Gate {
        full_control: true,
        remote: RemoteUpdates::Allowed,
        method: InstallMethod::Script,
        has_live: true,
        under_service: true,
    }
}

fn frame(id: &str, force: bool) -> UpdateFrame {
    UpdateFrame {
        update_id: id.into(),
        version: "0.4.3".into(),
        artifact_url: "https://example.invalid/wsmp.tar.xz".into(),
        sha256: "0".repeat(64),
        signature: None,
        force,
        rollback_after_secs: 90,
    }
}

/// A Homebrew prefix with a wsmp 0.4.2 keg from `flycockpit/tap` and a fake
/// `brew`: `--prefix` names the prefix, `list --pinned` names nothing,
/// `update` leaves `updated`, `info` answers with the version in
/// `tap-version`, and `upgrade` leaves `upgraded` (the
/// `HOMEBREW_NO_AUTO_UPDATE` it saw) and installs the tap's version then
/// (`installed`, and an `opt/wsmp/bin/wsmp` that prints it). Every call is
/// logged in `calls`. A step can be held: with `hold-<step>` present
/// (`update`, `info-<n>` for the n-th info, `upgrade`), it leaves
/// `in-<step>` and waits (10 s at most) for `release-<step>`.
#[cfg(unix)]
struct FakeBrew {
    root: tempfile::TempDir,
    prefix: std::path::PathBuf,
    keg: std::path::PathBuf,
}

#[cfg(unix)]
impl FakeBrew {
    fn new(tap_version: &str) -> Self {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().expect("dir");
        let prefix = root.path().join("homebrew");
        let keg = prefix.join("Cellar/wsmp/0.4.2");
        std::fs::create_dir_all(keg.join("bin")).expect("keg");
        std::fs::write(keg.join("bin/wsmp"), "").expect("wsmp");
        std::fs::write(
            keg.join("INSTALL_RECEIPT.json"),
            r#"{"source":{"tap":"flycockpit/tap"}}"#,
        )
        .expect("receipt");
        let brew = prefix.join("bin/brew");
        std::fs::create_dir_all(prefix.join("bin")).expect("bin");
        let dir = root.path().display().to_string();
        let home = prefix.display().to_string();
        std::fs::write(
            &brew,
            format!(
                "#!/bin/sh\n\
                 r='{dir}'\n\
                 echo \"$1\" >> \"$r/calls\"\n\
                 hold() {{\n\
                   [ -e \"$r/hold-$1\" ] || return 0\n\
                   touch \"$r/in-$1\"\n\
                   i=0\n\
                   while [ ! -e \"$r/release-$1\" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n\
                 }}\n\
                 case \"$1\" in\n\
                 --prefix) printf '%s\\n' '{home}';;\n\
                 update) touch \"$r/updated\"; hold update;;\n\
                 info)\n\
                   n=$(cat \"$r/infos\" 2>/dev/null || echo 0); n=$((n+1)); echo $n > \"$r/infos\"\n\
                   hold info-$n\n\
                   printf '{{\"formulae\":[{{\"name\":\"wsmp\",\"versions\":{{\"stable\":\"%s\"}}}}]}}' \"$(cat \"$r/tap-version\")\";;\n\
                 upgrade)\n\
                   printf '%s' \"$HOMEBREW_NO_AUTO_UPDATE\" > \"$r/upgraded\"\n\
                   hold upgrade\n\
                   v=$(cat \"$r/tap-version\")\n\
                   mkdir -p '{home}/opt/wsmp/bin'\n\
                   printf '#!/bin/sh\\necho \"wsmp %s\"\\n' \"$v\" > '{home}/opt/wsmp/bin/wsmp'\n\
                   [ -e \"$r/broken-probe\" ] && printf '#!/bin/sh\\nexit 3\\n' > '{home}/opt/wsmp/bin/wsmp'\n\
                   chmod 755 '{home}/opt/wsmp/bin/wsmp'\n\
                   printf '%s' \"$v\" > \"$r/installed\";;\n\
                 esac\n\
                 exit 0\n"
            ),
        )
        .expect("brew");
        std::fs::set_permissions(&brew, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let fake = Self { root, prefix, keg };
        fake.set_tap_version(tap_version);
        fake
    }

    fn set_tap_version(&self, version: &str) {
        std::fs::write(self.root.path().join("tap-version"), version).expect("tap version");
    }

    fn marker(&self, name: &str) -> std::path::PathBuf {
        self.root.path().join(name)
    }

    /// Hold `step` until [`FakeBrew::release`].
    fn hold(&self, step: &str) {
        std::fs::write(self.marker(&format!("hold-{step}")), "").expect("hold");
    }

    fn release(&self, step: &str) {
        std::fs::write(self.marker(&format!("release-{step}")), "").expect("release");
    }

    /// Wait (10 s at most) until a held `step` is reached.
    fn reached(&self, step: &str) -> bool {
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            if self.marker(&format!("in-{step}")).exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn installed(&self) -> Option<String> {
        std::fs::read_to_string(self.marker("installed")).ok()
    }

    fn machine<'a>(&self, before_swap: Option<&'a flow::BeforeSwap<'a>>) -> Machine<'a> {
        Machine {
            state_dir: self.root.path().join("state"),
            live: self.keg.join("bin/wsmp"),
            target: "test-target".into(),
            scheduler: None,
            tar: super::super::install::system_tar(),
            current_version: "0.4.2".into(),
            before_swap,
            proceed: None,
            stable_service: |_| Ok(()),
        }
    }

    /// The production worker on this prefix, on its own thread, as a
    /// platform where instances do (not) survive the restart.
    fn worker(
        &self,
        shared: &Arc<Shared>,
        instances_survive: bool,
    ) -> (std::thread::JoinHandle<()>, Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::clone(shared);
        let live = self.keg.join("bin/wsmp");
        let state_dir = self.root.path().join("state");
        let handle = std::thread::spawn(move || {
            run_worker(
                &frame("AAAAAAAAAAAAAAAAAAAAAA", false),
                UpdateStrategy::Homebrew,
                live,
                state_dir,
                "test-target".into(),
                &tx,
                &shared,
                &Host {
                    instances_survive,
                    remote: || RemoteUpdates::Allowed,
                    stable_service: |_| Ok(()),
                    scheduler: || None,
                },
            );
        });
        (handle, rx)
    }
}

/// The worker's progress, as (phase, reason), until it ends (10 s at most).
#[cfg(unix)]
fn worker_reports(rx: &Receiver<Event>) -> (Vec<(UpdatePhase, Option<UpdateReason>)>, bool) {
    let mut seen = Vec::new();
    let mut restart = false;
    while let Ok(event) = rx.recv_timeout(Duration::from_secs(10)) {
        match event {
            Event::Frame(frame) => {
                if let NodeFrame::AgentUpdateProgress { phase, reason, .. } = *frame {
                    seen.push((phase, reason));
                }
            }
            Event::Restart => restart = true,
        }
    }
    (seen, restart)
}

#[cfg(unix)]
fn homebrew_request(version: &str) -> Request {
    Request {
        update_id: "u-1".into(),
        version: version.into(),
        artifact_url: String::new(),
        sha256: String::new(),
        signature: None,
        rollback_after_secs: 90,
        origin: Origin::Server,
    }
}

/// Every report, with the `availableVersion` of a version refusal.
#[cfg(unix)]
#[derive(Default)]
struct Seen(Vec<(UpdatePhase, Option<UpdateReason>, Option<String>)>);
#[cfg(unix)]
impl Progress for Seen {
    fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, _: Option<String>) {
        self.0.push((phase, reason, None));
    }
    fn refuse_version(&mut self, available: String, _: String) {
        self.0.push((
            UpdatePhase::Refused,
            Some(UpdateReason::VersionMismatch),
            Some(available),
        ));
    }
}

#[cfg(unix)]
#[test]
fn a_homebrew_update_checks_idle_before_brew_changes_anything() {
    let brew = FakeBrew::new("0.4.3");
    let busy = |_: &mut dyn Progress| -> Result<(), String> { Err("busy".into()) };
    let machine = brew.machine(Some(&busy));
    let mut seen = Seen::default();
    assert_eq!(
        homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
        Ended::Stopped
    );
    assert_eq!(
        seen.0,
        [
            (UpdatePhase::Downloading, None, None),
            (UpdatePhase::Refused, Some(UpdateReason::Busy), None)
        ]
    );
    assert!(
        brew.marker("updated").exists(),
        "the tap is refreshed first"
    );
    assert!(
        !brew.marker("upgraded").exists(),
        "brew upgrade must not run while busy"
    );
    assert!(state::load(&machine.update_dir()).expect("load").is_none());
}

#[cfg(unix)]
#[test]
fn a_homebrew_tap_with_another_version_is_refused_before_anything_is_installed() {
    // The tap is ahead of the server (and, the same way, behind it).
    for (tap, asked) in [("0.4.4", "0.4.3"), ("0.4.2", "0.4.3")] {
        let brew = FakeBrew::new(tap);
        let idle_checked = std::cell::Cell::new(false);
        let idle = |_: &mut dyn Progress| -> Result<(), String> {
            idle_checked.set(true);
            Ok(())
        };
        let machine = brew.machine(Some(&idle));
        let mut seen = Seen::default();
        assert_eq!(
            homebrew(&machine, &homebrew_request(asked), &mut seen),
            Ended::Stopped
        );
        assert_eq!(
            seen.0,
            [
                (UpdatePhase::Downloading, None, None),
                (
                    UpdatePhase::Refused,
                    Some(UpdateReason::VersionMismatch),
                    Some(tap.to_string())
                )
            ],
            "tap {tap}, asked {asked}"
        );
        assert!(brew.marker("updated").exists());
        assert!(!brew.marker("upgraded").exists(), "nothing is installed");
        assert!(!idle_checked.get(), "refused before it waits for idle");
        assert!(state::load(&machine.update_dir()).expect("load").is_none());
    }
}

#[cfg(unix)]
#[test]
fn a_homebrew_update_installs_the_version_it_checked_even_if_the_tap_moves() {
    // Another shell's `brew update` comes after the last version check, while
    // `brew upgrade` is about to read the formula. It takes Homebrew's update
    // lock first (`flock(2)` on `<prefix>/var/homebrew/locks/update`), as
    // `cmd/update.sh` does: wsmp holds it, so this one cannot move the tap.
    let brew = FakeBrew::new("0.4.3");
    brew.hold("upgrade");
    let (ended, moved) = std::thread::scope(|scope| {
        let update = scope.spawn(|| {
            let idle = |_: &mut dyn Progress| -> Result<(), String> { Ok(()) };
            let machine = brew.machine(Some(&idle));
            homebrew(&machine, &homebrew_request("0.4.3"), &mut Seen::default())
        });
        assert!(brew.reached("upgrade"), "brew upgrade starts");
        let other = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(super::super::homebrew::TapLock::path(&brew.prefix))
            .expect("lock file");
        let moved =
            match nix::fcntl::Flock::lock(other, nix::fcntl::FlockArg::LockExclusiveNonblock) {
                Ok(_held) => {
                    brew.set_tap_version("0.4.4");
                    true
                }
                Err(_) => false,
            };
        brew.release("upgrade");
        (update.join().expect("update"), moved)
    });
    assert!(!moved, "the other `brew update` could not take the lock");
    assert_eq!(ended, Ended::Swapped);
    assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
    assert_eq!(
        std::fs::read_to_string(brew.marker("upgraded")).expect("upgraded"),
        "1",
        "HOMEBREW_NO_AUTO_UPDATE is set"
    );
    // The lock is Homebrew's again once the upgrade has run.
    assert!(
        super::super::homebrew::TapLock::acquire(&brew.prefix, Duration::ZERO, &|| true)
            .expect("lock")
            .is_some()
    );
}

/// F-FB-7: the idle wait may take up to 30 minutes, then the service, `brew
/// --prefix` and up to 5 minutes for Homebrew's lock follow. The server's
/// `waiting_idle` window (31 minutes) must not have to cover them: the node
/// says `downloading` as soon as it is idle, before it waits for the lock,
/// and again once it holds it (a fresh window for the check and the upgrade).
#[cfg(unix)]
#[test]
fn a_homebrew_update_reports_downloading_when_idle_before_it_waits_for_the_lock() {
    struct Phases(std::sync::Arc<std::sync::Mutex<Vec<UpdatePhase>>>);
    impl Progress for Phases {
        fn report(&mut self, phase: UpdatePhase, _: Option<UpdateReason>, _: Option<String>) {
            self.0.lock().expect("seen").push(phase);
        }
    }
    let brew = FakeBrew::new("0.4.3");
    // Another `brew update` holds Homebrew's lock while the node waits for idle.
    std::fs::create_dir_all(
        super::super::homebrew::TapLock::path(&brew.prefix)
            .parent()
            .expect("locks"),
    )
    .expect("locks dir");
    let other = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(super::super::homebrew::TapLock::path(&brew.prefix))
        .expect("lock file");
    let held =
        nix::fcntl::Flock::lock(other, nix::fcntl::FlockArg::LockExclusiveNonblock).expect("held");
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let snapshot = || seen.lock().expect("seen").clone();
    let ended = std::thread::scope(|scope| {
        let update = scope.spawn(|| {
            // The node was busy, then went idle.
            let idle = |progress: &mut dyn Progress| -> Result<(), String> {
                progress.report(UpdatePhase::WaitingIdle, None, None);
                Ok(())
            };
            let machine = brew.machine(Some(&idle));
            let mut progress = Phases(std::sync::Arc::clone(&seen));
            homebrew(&machine, &homebrew_request("0.4.3"), &mut progress)
        });
        let until = Instant::now() + Duration::from_secs(10);
        while snapshot().len() < 3 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Still waiting for the lock (nothing installed), and already
        // `downloading` again since it went idle.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            snapshot(),
            [
                UpdatePhase::Downloading,
                UpdatePhase::WaitingIdle,
                UpdatePhase::Downloading
            ]
        );
        assert!(!brew.marker("upgraded").exists(), "waiting for the lock");
        drop(held);
        update.join().expect("update")
    });
    assert_eq!(ended, Ended::Swapped);
    // Once it holds the lock: `downloading` again, for the check and the upgrade.
    assert_eq!(
        snapshot(),
        [
            UpdatePhase::Downloading,
            UpdatePhase::WaitingIdle,
            UpdatePhase::Downloading,
            UpdatePhase::Downloading
        ]
    );
    assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
}

/// Every report's detail.
#[cfg(unix)]
#[derive(Default)]
struct Details(Vec<(UpdatePhase, Option<UpdateReason>, Option<String>)>);
#[cfg(unix)]
impl Progress for Details {
    fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>) {
        self.0.push((phase, reason, detail));
    }
}

/// brew installed the asked-for version, but its version cannot be read
/// back: the failure says it could not be checked, not that another
/// version was installed.
#[cfg(unix)]
#[test]
fn a_version_that_cannot_be_checked_after_brew_says_so() {
    let brew = FakeBrew::new("0.4.3");
    std::fs::write(brew.marker("broken-probe"), "").expect("marker");
    let mut seen = Details::default();
    let ended = homebrew(&brew.machine(None), &homebrew_request("0.4.3"), &mut seen);
    assert_eq!(ended, Ended::Stopped);
    assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
    let (phase, reason, detail) = seen.0.last().cloned().expect("a report");
    assert_eq!(
        (phase, reason),
        (UpdatePhase::Failed, Some(UpdateReason::VersionMismatch))
    );
    let detail = detail.expect("detail");
    assert!(detail.contains("could not be checked"), "{detail}");
    assert!(!detail.contains("installed wsmp 0"), "{detail}");
    // A version that is read back and differs still says which.
    let brew = FakeBrew::new("0.4.3");
    let mut seen = Details::default();
    let ended = homebrew(&brew.machine(None), &homebrew_request("0.4.4"), &mut seen);
    assert_eq!(ended, Ended::Stopped);
    assert!(seen.0.iter().all(|(_, _, detail)| {
        detail
            .as_deref()
            .is_none_or(|d| !d.contains("could not be checked"))
    }));
}

#[cfg(unix)]
#[test]
fn a_homebrew_tap_that_moves_while_the_node_waits_is_refused_under_the_lock() {
    // The tap moves between the first check and the one under the lock (a
    // `brew update` while the node waited for idle).
    let brew = FakeBrew::new("0.4.3");
    let moved = |_: &mut dyn Progress| -> Result<(), String> {
        brew.set_tap_version("0.4.4");
        Ok(())
    };
    let machine = brew.machine(Some(&moved));
    let mut seen = Seen::default();
    assert_eq!(
        homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
        Ended::Stopped
    );
    assert_eq!(
        seen.0.last(),
        Some(&(
            UpdatePhase::Refused,
            Some(UpdateReason::VersionMismatch),
            Some("0.4.4".to_string())
        ))
    );
    assert!(!brew.marker("upgraded").exists(), "nothing is installed");
}

/// The path [`Machine::stable_service`] makes the service start is the
/// path the update probes after `brew upgrade`: the probe is what shows
/// the restart target runs (RC6), so they must be the same path.
#[cfg(unix)]
#[test]
fn the_service_is_made_to_start_exactly_the_path_the_update_probes() {
    static GIVEN: std::sync::Mutex<Vec<std::path::PathBuf>> = std::sync::Mutex::new(Vec::new());
    let brew = FakeBrew::new("0.4.3");
    let machine = Machine {
        stable_service: |stable| {
            GIVEN.lock().expect("given").push(stable.to_path_buf());
            Ok(())
        },
        ..brew.machine(None)
    };
    assert_eq!(
        homebrew(&machine, &homebrew_request("0.4.3"), &mut Seen::default()),
        Ended::Swapped
    );
    let stable = brew.prefix.join("opt/wsmp/bin/wsmp");
    assert_eq!(*GIVEN.lock().expect("given"), vec![stable.clone()]);
    // What was probed (and recorded) is that path: the fake upgrade put a
    // `wsmp 0.4.3` there, and only it.
    let recorded = state::load(&machine.update_dir())
        .expect("load")
        .expect("recorded");
    assert_eq!(recorded.live_path, stable);
    assert_eq!(brew.installed().as_deref(), Some("0.4.3"));
    // A target that does not run stops the update after brew, recording
    // nothing: no restart into it.
    let broken = FakeBrew::new("0.4.3");
    std::fs::write(broken.marker("broken-probe"), "").expect("marker");
    let machine = Machine {
        stable_service: |_| Ok(()),
        ..broken.machine(None)
    };
    let mut seen = Seen::default();
    assert_eq!(
        homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
        Ended::Stopped
    );
    assert_eq!(
        seen.0.last(),
        Some(&(
            UpdatePhase::Failed,
            Some(UpdateReason::VersionMismatch),
            None
        ))
    );
    assert!(state::load(&machine.update_dir()).expect("load").is_none());
}

#[cfg(unix)]
#[test]
fn a_service_that_cannot_move_to_the_stable_path_stops_a_homebrew_update_first() {
    let brew = FakeBrew::new("0.4.3");
    let machine = Machine {
        stable_service: |_| Err(anyhow::anyhow!("the relay service cannot be read")),
        ..brew.machine(None)
    };
    let mut seen = Seen::default();
    assert_eq!(
        homebrew(&machine, &homebrew_request("0.4.3"), &mut seen),
        Ended::Stopped
    );
    assert_eq!(
        seen.0.last(),
        Some(&(
            UpdatePhase::Refused,
            Some(UpdateReason::UnsupportedMethod),
            None
        ))
    );
    assert!(!brew.marker("upgraded").exists(), "the keg is untouched");
    assert!(state::load(&machine.update_dir()).expect("load").is_none());
}

/// F-FA-3 through the production worker: an earlier update left `armed` before its swap with
/// no rollback job (its arming and its terminal saves failed) no longer refuses every later
/// update "in progress" until the relay restarts. The worker, holding the update lock, settles
/// it and goes on (here to the tap check). Inverse: one whose swap began is still in progress.
#[cfg(unix)]
#[test]
fn a_worker_settles_an_update_abandoned_before_its_swap_and_goes_on() {
    for swap_began in [false, true] {
        let brew = FakeBrew::new("0.4.4");
        let update_dir = brew.root.path().join("state/update");
        let bin = brew.root.path().join("self-replace");
        std::fs::create_dir_all(&bin).expect("bin");
        let mut abandoned = state::sample(&bin, state::Phase::Armed);
        abandoned.update_id = "ZZZZZZZZZZZZZZZZZZZZZZ".into();
        std::fs::write(&abandoned.live_path, "old").expect("live");
        if !swap_began {
            std::fs::write(bin.join("wsmp.new"), "new").expect("new");
        }
        state::save(&update_dir, &abandoned).expect("save");
        let shared = Arc::new(Shared::default());
        shared.no_instances.store(true, Ordering::SeqCst);
        shared.no_commands.store(true, Ordering::SeqCst);
        let (worker, rx) = brew.worker(&shared, true);
        let (seen, _) = worker_reports(&rx);
        worker.join().expect("worker");
        let stored = state::load(&update_dir).expect("load").expect("state");
        if swap_began {
            assert_eq!(
                seen,
                [(UpdatePhase::Refused, Some(UpdateReason::InProgress))]
            );
            assert_eq!(stored.phase(), state::Phase::Armed);
        } else {
            assert_eq!(
                seen,
                [
                    (UpdatePhase::Downloading, None),
                    (UpdatePhase::Refused, Some(UpdateReason::VersionMismatch)),
                ]
            );
            assert_eq!(stored.update_id, "ZZZZZZZZZZZZZZZZZZZZZZ");
            assert_eq!(stored.phase(), state::Phase::Failed);
            assert!(!bin.join("wsmp.new").exists());
        }
    }
}

#[cfg(unix)]
#[test]
fn a_busy_node_hears_about_the_taps_version_before_it_waits_for_idle() {
    // macOS (instances do not survive the restart): the worker waits for idle
    // only after the tap check, so the refusal comes at once.
    let brew = FakeBrew::new("0.4.4");
    let shared = Arc::new(Shared::default());
    // Busy: an instance runs.
    shared.no_instances.store(false, Ordering::SeqCst);
    let started = Instant::now();
    let (worker, rx) = brew.worker(&shared, false);
    let (seen, restart) = worker_reports(&rx);
    // Checked before the join: a worker that waits for idle first would
    // hold the join for 30 minutes.
    assert_eq!(
        seen,
        [
            (UpdatePhase::Downloading, None),
            (UpdatePhase::Refused, Some(UpdateReason::VersionMismatch)),
        ]
    );
    worker.join().expect("worker");
    assert!(!restart);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(!brew.marker("upgraded").exists());
}

#[cfg(unix)]
#[test]
fn a_node_lowered_while_brew_runs_installs_nothing() {
    // Lowered to Relay only while the tap refreshes, or while the last
    // version check runs: the next step that changes something refuses.
    for step in ["update", "info-2"] {
        let brew = FakeBrew::new("0.4.3");
        brew.hold(step);
        let shared = Arc::new(Shared::default());
        shared.no_instances.store(true, Ordering::SeqCst);
        shared.no_commands.store(true, Ordering::SeqCst);
        let (worker, rx) = brew.worker(&shared, true);
        assert!(brew.reached(step), "{step} runs");
        shared.lowered.store(true, Ordering::SeqCst);
        brew.release(step);
        let (seen, restart) = worker_reports(&rx);
        worker.join().expect("worker");
        assert_eq!(
            seen.last(),
            Some(&(UpdatePhase::Refused, Some(UpdateReason::NotOwnerTrust))),
            "{step}: {seen:?}"
        );
        assert!(!restart, "{step}");
        assert!(
            !brew.marker("upgraded").exists(),
            "{step}: nothing installed"
        );
    }
}

/// F-FA-2 (P-BOUNDARY): trust lowered through the daemon's own authority
/// ([`crate::relay::startup::TerminalStartup::lower_trust`]) while the last
/// version check runs, with no relay poll after it (`Shared.lowered` is
/// never set): the worker's check before `brew upgrade` sees the lowering
/// and installs nothing. Lowered and raised again before the check: that
/// attempt is still refused. Inverse: not lowered, the same worker
/// upgrades and restarts.
#[cfg(unix)]
#[test]
fn a_lowering_reaches_the_update_worker_without_a_poll() {
    use crate::wire::protocol::frames::TrustValue;
    for case in ["lowered", "lowered-then-raised", "not-lowered"] {
        let config = crate::node::config::Config {
            trust: Some(TrustValue::Full),
            ..crate::node::config::Config::default()
        };
        let startup = crate::relay::startup::TerminalStartup::from_key(
            crate::wire::terminal_crypto::CliTerminalKey::generate().expect("key"),
            &config,
        );
        let brew = FakeBrew::new("0.4.3");
        brew.hold("info-2");
        let shared = Arc::new(Shared::new(startup.trust_watch(), false));
        shared.no_instances.store(true, Ordering::SeqCst);
        shared.no_commands.store(true, Ordering::SeqCst);
        let (worker, rx) = brew.worker(&shared, true);
        assert!(brew.reached("info-2"), "{case}: the last check runs");
        match case {
            "lowered" => {
                assert!(startup.lower_trust());
            }
            "lowered-then-raised" => {
                assert!(startup.lower_trust());
                assert!(startup.raise_trust());
                assert!(startup.full_control());
            }
            _ => {}
        }
        // No poll: the relay loop's copy was never told.
        assert!(!shared.lowered.load(Ordering::SeqCst), "{case}");
        brew.release("info-2");
        let (seen, restart) = worker_reports(&rx);
        worker.join().expect("worker");
        if case == "not-lowered" {
            assert!(restart, "{case}: {seen:?}");
            assert!(brew.marker("upgraded").exists(), "{case}: upgraded");
        } else {
            assert_eq!(
                seen.last(),
                Some(&(UpdatePhase::Refused, Some(UpdateReason::NotOwnerTrust))),
                "{case}: {seen:?}"
            );
            assert!(!restart, "{case}");
            assert!(
                !brew.marker("upgraded").exists(),
                "{case}: nothing installed"
            );
        }
    }
}

/// F-FA-2: an update asked under a watch that a lowering revoked since
/// (lowered and raised again before the frame was answered) is refused at
/// once. Inverse: a watch taken after the raise starts the worker.
#[test]
fn an_update_asked_under_a_revoked_watch_is_refused() {
    use crate::wire::protocol::frames::TrustValue;
    let config = crate::node::config::Config {
        trust: Some(TrustValue::Full),
        ..crate::node::config::Config::default()
    };
    let startup = crate::relay::startup::TerminalStartup::from_key(
        crate::wire::terminal_crypto::CliTerminalKey::generate().expect("key"),
        &config,
    );
    let before = startup.trust_watch();
    assert!(startup.lower_trust());
    assert!(startup.raise_trust());
    let gate = Gate {
        full_control: startup.full_control(),
        remote: RemoteUpdates::Allowed,
        method: InstallMethod::Unknown,
        has_live: true,
        under_service: true,
    };
    let mut tracker = tracker();
    let reason_of = |frames: Vec<NodeFrame>| match frames.as_slice() {
        [NodeFrame::AgentUpdateProgress { reason, .. }] => *reason,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        reason_of(tracker.request(frame("CCCCCCCCCCCCCCCCCCCCCC", false), &gate, before)),
        Some(UpdateReason::NotOwnerTrust)
    );
    // Inverse: the gate after that (here: the install method) decides.
    assert_eq!(
        reason_of(tracker.request(
            frame("DDDDDDDDDDDDDDDDDDDDDD", false),
            &gate,
            startup.trust_watch()
        )),
        Some(UpdateReason::UnsupportedMethod)
    );
}

/// F-FA-3: a worker waiting for a busy node to go idle stops waiting as
/// soon as the node is lowered: refused with that reason (not busy, not
/// after 30 minutes), nothing installed, its hold on new work let go and
/// the worker ended (so the update lock is free). Both waits: Homebrew's
/// last idle check (holding new work) and a self-replace's before its
/// download. Inverse: the same busy worker, not lowered, is still waiting.
/// Lowered through the daemon's authority (F-FA-2), with no poll after it.
#[cfg(unix)]
#[test]
fn a_node_lowered_while_its_update_waits_for_idle_stops_waiting() {
    for strategy in [UpdateStrategy::Homebrew, UpdateStrategy::SelfReplace] {
        let brew = FakeBrew::new("0.4.3");
        let startup = crate::relay::startup::TerminalStartup::from_key(
            crate::wire::terminal_crypto::CliTerminalKey::generate().expect("key"),
            &crate::node::config::Config {
                trust: Some(crate::wire::protocol::frames::TrustValue::Full),
                ..crate::node::config::Config::default()
            },
        );
        let shared = Arc::new(Shared::new(startup.trust_watch(), false));
        // Busy: an instance runs.
        shared.no_instances.store(false, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        let worker_shared = Arc::clone(&shared);
        let live = brew.keg.join("bin/wsmp");
        let state_dir = brew.root.path().join("state");
        let worker = std::thread::spawn(move || {
            run_worker(
                &frame("AAAAAAAAAAAAAAAAAAAAAA", false),
                strategy,
                live,
                state_dir,
                "test-target".into(),
                &tx,
                &worker_shared,
                &Host {
                    instances_survive: false,
                    remote: || RemoteUpdates::Allowed,
                    stable_service: |_| Ok(()),
                    scheduler: || None,
                },
            );
        });
        let mut seen = Vec::new();
        while let Ok(Event::Frame(frame)) = rx.recv_timeout(Duration::from_secs(10)) {
            if let NodeFrame::AgentUpdateProgress { phase, reason, .. } = *frame {
                seen.push((phase, reason));
                if phase == UpdatePhase::WaitingIdle {
                    break;
                }
            }
        }
        assert_eq!(
            seen.last(),
            Some(&(UpdatePhase::WaitingIdle, None)),
            "{strategy:?}"
        );
        // Inverse: not lowered, still waiting (and, for Homebrew, holding).
        std::thread::sleep(Duration::from_millis(2500));
        assert!(!worker.is_finished(), "{strategy:?}: still waiting");
        assert_eq!(
            shared.stage.load(),
            if strategy == UpdateStrategy::Homebrew {
                WorkerStage::HoldingWaitingIdle
            } else {
                WorkerStage::WaitingIdle
            },
            "{strategy:?}"
        );
        let lowered_at = Instant::now();
        assert!(startup.lower_trust());
        let (rest, restart) = worker_reports(&rx);
        // Checked before the join: a worker that kept waiting would hold
        // the join for up to 30 minutes.
        assert_eq!(
            rest,
            [(UpdatePhase::Refused, Some(UpdateReason::NotOwnerTrust))],
            "{strategy:?}"
        );
        assert!(
            lowered_at.elapsed() < Duration::from_secs(5),
            "{strategy:?}"
        );
        worker.join().expect("worker");
        assert!(!restart);
        assert_eq!(
            shared.stage.load(),
            WorkerStage::Preparing,
            "{strategy:?}: hold let go"
        );
        assert!(!brew.marker("upgraded").exists(), "{strategy:?}");
        assert!(
            state::UpdateLock::acquire(&brew.root.path().join("state/update"))
                .expect("lock")
                .is_some(),
            "{strategy:?}: the update lock is free"
        );
    }
}

#[test]
fn a_version_refusal_names_the_available_version() {
    let (tx, rx) = mpsc::channel();
    let mut sink = Sink {
        update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
        tx,
    };
    sink.refuse_version("0.4.4".into(), "the tap has 0.4.4".into());
    let Ok(Event::Frame(frame)) = rx.try_recv() else {
        panic!("a frame");
    };
    assert!(frame.validate().is_ok());
    assert!(matches!(
        *frame,
        NodeFrame::AgentUpdateProgress {
            phase: UpdatePhase::Refused,
            reason: Some(UpdateReason::VersionMismatch),
            available_version: Some(ref version),
            ..
        } if version == "0.4.4"
    ));
    // Not a release version: the refusal goes out without it.
    sink.refuse_version("HEAD".into(), "odd".into());
    let Ok(Event::Frame(frame)) = rx.try_recv() else {
        panic!("a frame");
    };
    assert!(matches!(
        *frame,
        NodeFrame::AgentUpdateProgress {
            available_version: None,
            ..
        }
    ));
}

#[test]
fn a_registered_session_always_reports_the_available_version() {
    let mut tracker = tracker();
    for _ in 0..2 {
        tracker.on_hello_ok(DefinitionSync::None);
        let (_shared, tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
        let mut sink = Sink {
            update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            tx,
        };
        sink.refuse_version("1.0.1".into(), "the tap has 1.0.1".into());
        drop(sink);
        let (frames, _) = tracker.poll(true);
        assert!(
            matches!(frames.as_slice(), [NodeFrame::AgentUpdateProgress { available_version: Some(version), .. }] if version == "1.0.1")
        );
        tracker.on_session_end();
    }
}

#[test]
fn the_gates_refuse_with_the_contract_reasons() {
    assert_eq!(
        check_gate(&gate(), "0.4.3"),
        Ok(UpdateStrategy::SelfReplace)
    );
    let refused = |change: &dyn Fn(&mut Gate)| {
        let mut gate = gate();
        change(&mut gate);
        check_gate(&gate, "0.4.3").map_err(|(reason, _)| reason)
    };
    assert_eq!(
        refused(&|g| g.full_control = false),
        Err(UpdateReason::NotOwnerTrust)
    );
    assert_eq!(
        refused(&|g| g.remote = RemoteUpdates::Off),
        Err(UpdateReason::OptedOut)
    );
    assert_eq!(
        refused(&|g| g.method = InstallMethod::Source),
        Err(UpdateReason::SourceBuild)
    );
    assert_eq!(
        refused(&|g| g.method = InstallMethod::Cargo),
        Err(UpdateReason::UnsupportedMethod)
    );
    assert_eq!(
        refused(&|g| g.method = InstallMethod::Npm),
        Err(UpdateReason::UnsupportedMethod)
    );
    assert_eq!(
        refused(&|g| g.under_service = false),
        Err(UpdateReason::UnsupportedMethod)
    );
    assert_eq!(
        refused(&|g| g.method = InstallMethod::Homebrew),
        Ok(UpdateStrategy::Homebrew)
    );
    let (_, command) = check_gate(
        &Gate {
            method: InstallMethod::Source,
            ..gate()
        },
        "0.4.3",
    )
    .expect_err("source");
    assert!(
        command.contains("cargo install") && command.contains("v0.4.3"),
        "{command}"
    );
    // Trust is checked first: a Relay-only node says nothing else.
    let (reason, _) = check_gate(
        &Gate {
            full_control: false,
            remote: RemoteUpdates::Off,
            ..gate()
        },
        "0.4.3",
    )
    .expect_err("trust");
    assert_eq!(reason, UpdateReason::NotOwnerTrust);
}

#[test]
fn strategies_follow_the_install() {
    assert_eq!(
        strategies(InstallMethod::Script, true, true),
        [UpdateStrategy::SelfReplace]
    );
    assert_eq!(
        strategies(InstallMethod::Homebrew, true, true),
        [UpdateStrategy::Homebrew]
    );
    assert!(strategies(InstallMethod::Source, true, true).is_empty());
    assert!(strategies(InstallMethod::Script, true, false).is_empty());
}

fn tracker() -> DaemonUpdate {
    DaemonUpdate {
        started: Instant::now(),
        tracking: Tracking::Idle,
        connection: Connection::Registered { synced: true },
        outbox: Vec::new(),
        current_id: None,
        confirm_retry: ConfirmRetry::default(),
    }
}

fn waiting_worker(tracker: &mut DaemonUpdate, id: &str) -> (Arc<Shared>, Sender<Event>) {
    let (tx, rx) = mpsc::channel();
    let shared = Arc::new(Shared::default());
    shared.stage.set(WorkerStage::WaitingIdle);
    tracker.current_id = Some(id.into());
    tracker.tracking = Tracking::Installing(Worker {
        rx,
        shared: Arc::clone(&shared),
    });
    (shared, tx)
}

fn reason_of(frames: &[NodeFrame]) -> Option<UpdateReason> {
    match frames {
        [NodeFrame::AgentUpdateProgress { reason, .. }] => *reason,
        _ => None,
    }
}

#[test]
fn a_repeat_of_the_same_update_is_never_refused() {
    let mut tracker = tracker();
    let id = "AAAAAAAAAAAAAAAAAAAAAA";
    let (shared, _tx) = waiting_worker(&mut tracker, id);
    assert!(tracker.wants_idle());
    // Another update is refused.
    let other = tracker.request(
        frame("BBBBBBBBBBBBBBBBBBBBBB", true),
        &gate(),
        TrustWatch::full_for_tests(),
    );
    assert_eq!(reason_of(&other), Some(UpdateReason::InProgress));
    // The same one unforced: no answer, the worker goes on.
    assert!(
        tracker
            .request(frame(id, false), &gate(), TrustWatch::full_for_tests())
            .is_empty()
    );
    assert!(!shared.force.load(Ordering::SeqCst));
    // With force: no answer; the server stops the instances.
    assert!(
        tracker
            .request(frame(id, true), &gate(), TrustWatch::full_for_tests())
            .is_empty()
    );
    assert!(shared.force.load(Ordering::SeqCst));
    // A late force once the worker stopped waiting: still no refusal.
    assert!(shared.stage.advance(WorkerStage::end_wait, "test"));
    assert!(!tracker.wants_idle());
    assert!(
        tracker
            .request(frame(id, true), &gate(), TrustWatch::full_for_tests())
            .is_empty()
    );
    // Awaiting the restart: the same id gets no answer either.
    tracker.tracking = Tracking::Restarting;
    assert!(
        tracker
            .request(frame(id, true), &gate(), TrustWatch::full_for_tests())
            .is_empty()
    );
}

#[test]
fn a_node_lowered_to_relay_only_stops_its_update() {
    let mut tracker = tracker();
    let (shared, _tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
    let _ = tracker.poll(true);
    assert!(!shared.lowered.load(Ordering::SeqCst));
    let _ = tracker.poll(false);
    assert!(shared.lowered.load(Ordering::SeqCst));
}

#[test]
fn new_work_is_held_from_the_last_idle_check_to_the_restart() {
    let mut tracker = tracker();
    let (shared, _tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
    assert!(!tracker.holds_new_work());
    assert!(shared.stage.advance(WorkerStage::end_wait, "test"));
    assert!(shared.stage.advance(WorkerStage::hold, "test"));
    assert!(tracker.holds_new_work());
    assert!(shared.stage.advance(WorkerStage::begin_wait, "test"));
    assert!(tracker.holds_new_work() && tracker.wants_idle());
    assert!(shared.stage.advance(WorkerStage::end_wait, "test"));
    assert!(tracker.holds_new_work() && !tracker.wants_idle());
    tracker.tracking = Tracking::Idle;
    assert!(!tracker.holds_new_work(), "the worker stopped: no hold");
    tracker.tracking = Tracking::Restarting;
    assert!(tracker.holds_new_work());
}

#[test]
fn a_forced_wait_ignores_node_commands_but_not_instances() {
    let shared = Shared::default();
    let (tx, rx) = mpsc::channel();
    let mut sink = Sink {
        update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
        tx,
    };
    shared.no_instances.store(true, Ordering::SeqCst);
    shared.no_commands.store(false, Ordering::SeqCst);
    assert!(!shared.wait_idle(&mut sink, Duration::from_millis(10), &|| false));
    assert!(matches!(
        rx.try_recv(),
        Ok(Event::Frame(frame)) if matches!(*frame, NodeFrame::AgentUpdateProgress {
            phase: UpdatePhase::WaitingIdle,
            ..
        })
    ));
    shared.force.store(true, Ordering::SeqCst);
    assert!(shared.wait_idle(&mut sink, Duration::from_millis(10), &|| false));
    shared.no_instances.store(false, Ordering::SeqCst);
    assert!(!shared.wait_idle(&mut sink, Duration::from_millis(10), &|| false));
}

#[test]
fn the_restart_waits_for_the_progress_only_on_a_live_session() {
    let mut tracker = tracker();
    tracker.on_session_end();
    let (_shared, tx) = waiting_worker(&mut tracker, "AAAAAAAAAAAAAAAAAAAAAA");
    tx.send(Event::Frame(Box::new(progress_frame(
        "AAAAAAAAAAAAAAAAAAAAAA",
        UpdatePhase::Restarting,
        None,
        None,
    ))))
    .expect("send");
    tx.send(Event::Restart).expect("send");
    // Disconnected: restart at once, the progress waits.
    assert_eq!(tracker.poll(true), (Vec::new(), true));
    // Registered: the progress goes out first.
    tracker.on_hello_ok(DefinitionSync::None);
    let (frames, restart) = tracker.poll(true);
    assert_eq!(frames.len(), 1);
    assert!(restart);
    // A new update while the restart is pending is in progress.
    let refused = tracker.request(
        frame("BBBBBBBBBBBBBBBBBBBBBB", false),
        &gate(),
        TrustWatch::full_for_tests(),
    );
    assert_eq!(reason_of(&refused), Some(UpdateReason::InProgress));
}
