use super::*;

#[cfg(windows)]
fn fresh_job_registry() -> &'static Mutex<Registry> {
    Box::leak(Box::new(Mutex::new(Registry::default())))
}

#[cfg(windows)]
fn job_tree(tree: &crate::windows_test_tree::Tree) -> Child {
    let mut command = Command::new("cmd");
    command.args(tree.command("hang"));
    crate::job_tree::spawn(command).expect("job spawn")
}

#[cfg(windows)]
fn held_job(job: JobTree) -> (std::sync::mpsc::Sender<()>, thread::JoinHandle<()>) {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let holder = thread::spawn(move || {
        job.with_job_lock(|| {
            ready_tx.send(()).expect("lock notification");
            release_rx
                .recv_timeout(Duration::from_secs(20))
                .expect("release lock");
        });
        // Deliberately no kill here: cleanup must issue its own kill.
    });
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("held job lock");
    (release_tx, holder)
}

#[cfg(windows)]
#[test]
fn windows_busy_exit_observations_are_inconclusive() {
    use crate::windows_test_tree::Tree;
    // Release rows fail on the old wildcard matches. Deadline/cancel
    // rows pin bounded waiting rather than an unbounded lock acquisition.
    for row in [
        "wait-release",
        "reap-release",
        "wait-deadline",
        "wait-cancel",
    ] {
        let tree = Tree::new();
        let mut command = Command::new("cmd");
        command.args(tree.command(if row.ends_with("release") {
            "success"
        } else {
            "hang"
        }));
        let mut child = crate::job_tree::spawn(command).expect("job spawn");
        tree.read_marker();
        if row.ends_with("release") {
            assert!(wait_for_exit(
                &mut child,
                Instant::now() + Duration::from_secs(5),
                &|| false
            ));
        }
        let (release, holder) = held_job(child.job());
        thread::scope(|scope| {
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let child = &mut child;
            scope.spawn(move || {
                let until = Instant::now() + Duration::from_millis(150);
                let observed = if row == "reap-release" {
                    reap_within(child, until).is_some()
                } else {
                    wait_for_exit(child, until, &|| row == "wait-cancel")
                };
                done_tx.send(observed).expect("observation result");
            });
            if row.ends_with("release") {
                assert!(
                    done_rx.recv_timeout(Duration::from_millis(50)).is_err(),
                    "{row}: busy is not exited"
                );
                release.send(()).expect("release");
                assert!(
                    done_rx
                        .recv_timeout(Duration::from_secs(1))
                        .expect("observed exit"),
                    "{row}"
                );
            } else {
                assert!(
                    !done_rx
                        .recv_timeout(Duration::from_secs(1))
                        .expect("bounded observation"),
                    "{row}"
                );
                release.send(()).expect("release");
            }
        });
        holder.join().expect("lock holder");
    }
}

#[cfg(windows)]
#[test]
fn windows_run_contention_keeps_cleanup_owned_and_retries_termination() {
    use crate::windows_test_tree::{Tree, assert_dead, process_exists};
    // EOF fails on premature Timeout. Short timeout/cancel rows require
    // kill before settlement; long rows require a registered, charged
    // pending owner and a kill after unlock without help from the holder.
    for (path, pending_handoff) in [
        ("eof", false),
        ("timeout", false),
        ("cancel", false),
        ("timeout", true),
        ("cancel", true),
    ] {
        let tree = Tree::new();
        let cancel = AtomicBool::new(false);
        let timeout = if path == "timeout" {
            Duration::from_secs(4)
        } else {
            Duration::from_secs(30)
        };
        let args = tree.command(if path == "eof" { "eof" } else { "detach" });
        let run_started = Instant::now();
        thread::scope(|scope| {
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let args = &args;
            let cancel = &cancel;
            scope.spawn(move || {
                done_tx
                    .send(run("python", &args[2..], timeout, 1024, Some(cancel)))
                    .expect("run result");
            });
            let grandchild = tree.read_marker().parse().expect("grandchild PID");
            let root = std::fs::read_to_string(&tree.root)
                .expect("root PID")
                .trim()
                .parse::<u32>()
                .expect("root PID");
            let (token, job) = {
                let registry = registry();
                registry
                    .groups
                    .iter()
                    .find(|(_, job)| job.id() == root)
                    .map(|(token, job)| (*token, job.clone()))
                    .expect("run registered in ACTIVE")
            };
            let (release, holder) = held_job(job);
            let mut holder = Some(holder);
            let started = Instant::now();
            if path == "eof" {
                std::fs::write(tree.root.with_extension("eof"), "").expect("close stdout");
                assert!(
                    done_rx.recv_timeout(REAP_GRACE * 2).is_err(),
                    "EOF settled before its deadline under contention"
                );
                assert!(registry().groups.contains_key(&token));
                release.send(()).expect("release");
                holder.take().expect("holder").join().expect("lock holder");
                std::fs::write(tree.root.with_extension("exit"), "").expect("allow natural exit");
                assert_eq!(
                    done_rx
                        .recv_timeout(Duration::from_secs(5))
                        .expect("EOF result"),
                    Ok(Vec::new())
                );
            } else {
                if path == "cancel" {
                    cancel.store(true, Ordering::SeqCst);
                } else {
                    // The deadline runs from run() entry, not from fixture startup.
                    thread::sleep(timeout.saturating_sub(run_started.elapsed()));
                }
                if !pending_handoff {
                    assert!(
                        done_rx.recv_timeout(REAP_GRACE / 2).is_err(),
                        "{path}: settled before kill with a live tree"
                    );
                    release.send(()).expect("release");
                    holder.take().expect("holder").join().expect("lock holder");
                }
                let result = done_rx
                    .recv_timeout(REAP_GRACE + Duration::from_secs(2))
                    .expect("bounded run result");
                assert_eq!(
                    result,
                    Err(if path == "cancel" {
                        RunError::Cancelled
                    } else {
                        RunError::Timeout
                    })
                );
                assert!(
                    started.elapsed()
                        < timeout.min(Duration::from_secs(4)) + REAP_GRACE + Duration::from_secs(2)
                );
                if pending_handoff {
                    assert!(
                        registry().groups.contains_key(&token),
                        "pending tree hidden from shutdown"
                    );
                    assert!(lock(&BUDGET).stuck > 0, "pending child lost its permit");
                    assert!(process_exists(root) && process_exists(grandchild));
                    release.send(()).expect("release");
                    holder.take().expect("holder").join().expect("lock holder");
                }
            }
            assert_dead(root);
            assert_dead(grandchild);
            let until = Instant::now() + Duration::from_secs(2);
            while registry().groups.contains_key(&token) {
                assert!(
                    Instant::now() < until,
                    "registration not released after termination"
                );
                thread::sleep(REAP_POLL);
            }
        });
    }
}

#[cfg(windows)]
#[test]
fn windows_registration_identity_survives_a_recycled_root_pid() {
    use crate::windows_test_tree::{Tree, assert_dead};
    // Both states would overwrite/remove B on the old PID-keyed map.
    for root_reaped in [false, true] {
        let shared = fresh_job_registry();
        let first_tree = Tree::new();
        let second_tree = Tree::new();
        let mut command = Command::new("cmd");
        command.args(first_tree.command(if root_reaped { "success" } else { "hang" }));
        let mut first = crate::job_tree::spawn(command).expect("first job");
        let first_grandchild = first_tree
            .read_marker()
            .parse()
            .expect("first grandchild PID");
        let ticket = begin_spawn_in(shared).expect("admission open");
        let first_registration = register_job_in(ticket, first.job()).expect("first registration");
        if root_reaped {
            assert!(wait_for_exit(
                &mut first,
                Instant::now() + Duration::from_secs(5),
                &|| false
            ));
        }
        let second = job_tree(&second_tree);
        let second_grandchild = second_tree
            .read_marker()
            .parse()
            .expect("second grandchild PID");
        assert_eq!(second.job().id(), second.id(), "default diagnostic PID");
        let ticket = begin_spawn_in(shared).expect("admission open");
        let reused_pid_job = second.job().with_test_pid(first.id());
        assert_eq!(reused_pid_job.id(), first.id(), "forced PID reuse seam");
        let second_registration =
            register_job_in(ticket, reused_pid_job).expect("second registration");
        assert_ne!(first_registration.token, second_registration.token);
        assert_eq!(
            lock_registry(shared).groups.len(),
            2,
            "insertion replaced a live registration"
        );
        let permit = admit_in(fresh()).expect("permit");
        finish_job(
            first,
            Instant::now(),
            permit,
            &|| true,
            Some(first_registration),
        );
        assert_dead(first_grandchild);
        assert_eq!(lock_registry(shared).groups.len(), 1);
        assert!(
            lock_registry(shared)
                .groups
                .contains_key(&second_registration.token)
        );
        kill_all_in(shared);
        assert_dead(second.id());
        assert_dead(second_grandchild);
        drop(second);
        drop(second_registration);
        assert!(lock_registry(shared).groups.is_empty());
    }
}

#[cfg(windows)]
#[test]
fn windows_pending_termination_precedes_even_a_cached_root_exit() {
    use crate::windows_test_tree::{Tree, assert_dead, process_exists};
    for root_reaped in [false, true] {
        let tree = Tree::new();
        let shared = fresh_job_registry();
        let budget = fresh();
        let mut command = Command::new("cmd");
        command.args(tree.command(if root_reaped { "success" } else { "hang" }));
        let mut child = crate::job_tree::spawn(command).expect("job spawn");
        let grandchild = tree.read_marker().parse().expect("grandchild PID");
        if root_reaped {
            assert!(wait_for_exit(
                &mut child,
                Instant::now() + Duration::from_secs(5),
                &|| false
            ));
        }
        let ticket = begin_spawn_in(shared).expect("admission open");
        let registration = register_job_in(ticket, child.job()).expect("registration");
        let (release, holder) = held_job(child.job());
        let started = Instant::now();
        let result = finish_job(
            child,
            Instant::now(),
            admit_in(budget).expect("permit"),
            &|| true,
            Some(registration),
        );
        assert!(started.elapsed() < REAP_GRACE + Duration::from_millis(500));
        assert!(result.status.is_none());
        assert_eq!(lock_registry(shared).groups.len(), 1);
        assert_eq!(lock(budget).held, 1);
        assert_eq!(lock(budget).stuck, 1);
        assert!(process_exists(grandchild));
        release.send(()).expect("release");
        holder.join().expect("lock holder");
        assert_dead(grandchild);
        let until = Instant::now() + Duration::from_secs(2);
        while lock(budget).held != 0 {
            assert!(
                Instant::now() < until,
                "cleanup permit retained after reaping"
            );
            thread::sleep(REAP_POLL);
        }
        assert_eq!(lock(budget).stuck, 0);
        assert!(lock_registry(shared).groups.is_empty());
    }
}

#[cfg(windows)]
#[test]
fn windows_registration_token_exhaustion_fails_closed() {
    let shared = fresh_job_registry();
    assert_eq!(lock_registry(shared).next_token, 0, "default token seed");
    lock_registry(shared).next_token = u64::MAX;
    let ticket = begin_spawn_in(shared).expect("admission open");
    let tree = crate::windows_test_tree::Tree::new();
    let child = job_tree(&tree);
    assert!(register_job_in(ticket, child.job()).is_none());
    assert!(begin_spawn_in(shared).is_none());
    assert!(lock_registry(shared).groups.is_empty());
    assert_eq!(lock_registry(shared).spawning, 0);
    crate::windows_test_tree::assert_dead(child.id());
}

#[cfg(windows)]
#[test]
fn shutdown_and_panic_terminate_registered_jobs_from_another_thread() {
    use crate::windows_test_tree::{Tree, assert_dead};
    for panic_hook in [false, true] {
        let tree = Tree::new();
        let shared = fresh_job_registry();
        let ticket = begin_spawn_in(shared).expect("admission open");
        let child = job_tree(&tree);
        let grandchild = tree.read_marker().parse().expect("grandchild PID");
        let _registration = register_job_in(ticket, child.job()).expect("registration");
        thread::spawn(move || {
            if panic_hook {
                kill_all_for_panic_in(shared);
            } else {
                kill_all_in(shared);
            }
        })
        .join()
        .expect("shutdown thread");
        assert_dead(grandchild);
        assert_dead(child.id());
        assert!(begin_spawn_in(shared).is_none());
        // The owner is still live: its Drop did not cause the tree kill.
        drop(child);
    }
}

#[cfg(windows)]
#[test]
fn windows_shutdown_waits_for_and_kills_a_run_mid_spawn() {
    use crate::windows_test_tree::{Tree, assert_dead};
    let tree = Tree::new();
    let shared = fresh_job_registry();
    let ticket = begin_spawn_in(shared).expect("admission open");
    let child = job_tree(&tree);
    let grandchild = tree.read_marker().parse().expect("grandchild PID");
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let exiting = thread::spawn(move || {
        kill_all_in(shared);
        done_tx.send(()).expect("shutdown notification");
    });
    let until = Instant::now() + SHUTDOWN_SPAWN_WAIT;
    while !lock_registry(shared).closed {
        assert!(Instant::now() < until, "shutdown did not close admission");
        thread::sleep(REAP_POLL);
    }
    assert!(done_rx.try_recv().is_err(), "shutdown missed mid-spawn run");
    assert!(register_job_in(ticket, child.job()).is_none());
    done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("shutdown bounded");
    exiting.join().expect("shutdown thread");
    assert_dead(grandchild);
    assert_dead(child.id());
}

#[cfg(windows)]
#[test]
fn windows_shutdown_and_panic_never_block_on_a_held_registry_lock() {
    for panic_hook in [false, true] {
        let shared = fresh_job_registry();
        let guard = lock_registry(shared);
        let started = Instant::now();
        if panic_hook {
            kill_all_for_panic_in(shared);
        } else {
            kill_all_in(shared);
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(guard);
    }
}

fn fresh() -> &'static Mutex<Budget> {
    Box::leak(Box::new(Mutex::new(Budget { held: 0, stuck: 0 })))
}

#[test]
fn concurrent_admission_never_exceeds_the_budget() {
    // Many threads race for permits at once: exactly MAX_RUNS win, the
    // rest are refused, and releasing one admits exactly one more.
    let shared = fresh();
    let barrier = std::sync::Barrier::new(MAX_RUNS * 2);
    let permits = std::thread::scope(|scope| {
        let handles = (0..MAX_RUNS * 2)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    admit_in(shared)
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().expect("admit thread"))
            .collect::<Vec<_>>()
    });
    assert_eq!(permits.len(), MAX_RUNS);
    assert!(admit_in(shared).is_none());
    let mut permits = permits;
    drop(permits.pop());
    assert!(admit_in(shared).is_some());
    drop(permits);
    assert_eq!(lock(shared).held, 0);
}

/// `collect_fds` on its own thread; `None` when it has not returned within
/// `wait` (a drain that never ends would hang the test instead).
#[cfg(unix)]
fn collect_within(
    pipes: Vec<std::os::fd::OwnedFd>,
    deadline: Duration,
    wait: Duration,
) -> Option<(bool, Duration)> {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let started = Instant::now();
    thread::spawn(move || {
        let collected = collect_fds(pipes, started + deadline, 1 << 20, true, &|| false);
        let _ = done_tx.send(matches!(collected, Collected::Unfinished));
    });
    done_rx
        .recv_timeout(wait)
        .ok()
        .map(|unfinished| (unfinished, started.elapsed()))
}

#[cfg(unix)]
#[test]
fn a_pipe_that_never_runs_dry_cannot_hold_the_drain_past_its_deadline() {
    // `/dev/zero` is always readable and never would block: the drain only
    // returns if it checks the deadline between bounded reads.
    let zero = std::fs::File::open("/dev/zero").expect("/dev/zero");
    let (unfinished, elapsed) = collect_within(
        vec![zero.into()],
        Duration::from_millis(200),
        Duration::from_secs(5),
    )
    .expect("the drain returned at its deadline");
    assert!(unfinished, "the deadline ended it");
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
}

#[cfg(unix)]
#[test]
fn a_pipe_that_never_runs_dry_does_not_starve_the_other() {
    // stdout never runs dry; 1 MiB on stderr fills its pipe many times
    // over, so its writer only finishes if stderr gets turns too.
    use std::io::Write;
    let zero = std::fs::File::open("/dev/zero").expect("/dev/zero");
    let (read, write) = nix::unistd::pipe().expect("pipe");
    let (wrote_tx, wrote_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut write = std::fs::File::from(write);
        let _ = wrote_tx.send(write.write_all(&[b'e'; 1 << 20]).is_ok());
    });
    let drained = collect_within(
        vec![zero.into(), read],
        Duration::from_secs(3),
        Duration::from_secs(8),
    );
    assert_eq!(
        wrote_rx.recv_timeout(Duration::from_secs(1)),
        Ok(true),
        "stderr's writer finished while stdout never ran dry"
    );
    assert!(drained.is_some_and(|(unfinished, _)| unfinished));
}

#[cfg(unix)]
fn fresh_registry() -> &'static Mutex<Registry> {
    Box::leak(Box::new(Mutex::new(Registry {
        closed: false,
        groups: BTreeMap::new(),
        spawning: 0,
    })))
}

/// Every way out between the shutdown check and the registration (an early
/// return, a failed spawn, a panic) stops counting the run, so shutdown
/// never waits out its bound for a run that will not register.
#[cfg(unix)]
#[test]
fn a_run_that_gives_up_before_registering_never_holds_up_shutdown() {
    let shared = fresh_registry();
    let returned = begin_spawn_in(shared).expect("admission open");
    let panicked = begin_spawn_in(shared).expect("admission open");
    assert_eq!(lock_registry(shared).spawning, 2);
    drop(returned);
    assert_eq!(lock_registry(shared).spawning, 1);
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _ticket = panicked;
        panic!("mid-spawn");
    }));
    assert!(unwound.is_err());
    assert_eq!(lock_registry(shared).spawning, 0);
    let started = Instant::now();
    kill_all_in(shared);
    assert!(started.elapsed() < SHUTDOWN_SPAWN_WAIT);
    // A registered run is counted once, not again when its ticket goes.
    let shared = fresh_registry();
    let ticket = begin_spawn_in(shared).expect("admission open");
    let mut child = own_group_sleeper();
    assert!(register_in(ticket, child.id(), None));
    assert_eq!(lock_registry(shared).spawning, 0);
    kill_all_in(shared);
    let _ = child.wait();
}

#[cfg(unix)]
fn own_group_sleeper() -> Child {
    use std::os::unix::process::CommandExt;
    crate::subreaper::spawn(
        || Command::new("sleep").arg("30").process_group(0).spawn(),
        |child| Some(child.id()),
    )
    .expect("sleep")
}

/// A run that already passed the shutdown check but is not registered
/// yet when the exit begins: shutdown must wait for it, and its own
/// registration must kill its group (nothing it started outlives the
/// exit). Deleting either the wait or the register-time kill fails this.
#[cfg(unix)]
#[test]
fn a_run_mid_spawn_is_killed_by_its_registration_and_shutdown_waits_for_it() {
    let shared = fresh_registry();
    let ticket = begin_spawn_in(shared).expect("admission open");
    let mut child = own_group_sleeper();
    let pid = child.id();
    let exiting = thread::spawn(move || {
        let started = Instant::now();
        kill_all_in(shared);
        started.elapsed()
    });
    // Shutdown is now waiting for this run to register.
    thread::sleep(Duration::from_millis(300));
    assert!(child.try_wait().expect("try_wait").is_none());
    assert!(
        !register_in(ticket, pid, None),
        "registration after the exit began must be refused"
    );
    let waited = exiting.join().expect("shutdown thread");
    assert!(
        waited >= Duration::from_millis(250),
        "shutdown returned before the mid-spawn run registered: {waited:?}"
    );
    // Killed by `register_in` itself: no `finish` ran for this child.
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().expect("try_wait").is_none() {
        assert!(Instant::now() < deadline, "the mid-spawn child survived");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        begin_spawn_in(shared).is_none(),
        "nothing starts after the exit"
    );
}

/// A registered run whose direct child left its process group (here: it
/// never had its own group, so `killpg(pid)` finds nothing) is still
/// killed at exit: the registry kills the child by pid as well.
#[cfg(unix)]
#[test]
fn exit_kills_a_registered_child_that_is_not_a_group_leader() {
    let shared = fresh_registry();
    let ticket = begin_spawn_in(shared).expect("admission open");
    // No `process_group(0)`: the child shares this test's group.
    let mut child = Command::new("sleep").arg("30").spawn().expect("sleep");
    assert!(register_in(ticket, child.id(), None));
    kill_all_in(shared);
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().expect("try_wait").is_none() {
        assert!(Instant::now() < deadline, "the registered child survived");
        thread::sleep(Duration::from_millis(10));
    }
}

/// The panic hook kills registered runs without blocking, even while
/// another thread holds the registry lock (it gives up rather than hang).
#[cfg(unix)]
#[test]
fn the_panic_hook_kills_registered_runs_and_never_hangs_on_a_held_lock() {
    let shared = fresh_registry();
    let ticket = begin_spawn_in(shared).expect("admission open");
    let mut child = own_group_sleeper();
    assert!(register_in(ticket, child.id(), None));
    kill_all_for_panic_in(shared);
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().expect("try_wait").is_none() {
        assert!(Instant::now() < deadline, "the panic hook left a run alive");
        thread::sleep(Duration::from_millis(10));
    }
    // A lock held elsewhere: the hook returns within its bound.
    let held = fresh_registry();
    let guard = lock_registry(held);
    let started = Instant::now();
    kill_all_for_panic_in(held);
    assert!(started.elapsed() < Duration::from_secs(2));
    drop(guard);
}

#[test]
fn stuck_children_stop_admission_until_they_are_reaped() {
    let shared = fresh();
    lock(shared).stuck = LINGERING_MAX;
    assert!(admit_in(shared).is_none());
    lock(shared).stuck = LINGERING_MAX - 1;
    assert!(admit_in(shared).is_some());
}
