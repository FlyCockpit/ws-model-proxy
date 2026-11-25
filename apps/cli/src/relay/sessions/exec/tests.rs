use super::*;
use crate::relay::sessions::test_support::*;

use crate::node::config::Config;
#[cfg(windows)]
use crate::relay::sessions::children::kill_live_children;
use crate::wire::terminal_crypto::CliTerminalKey;
use std::sync::mpsc;

#[test]
fn relay_only_refuses_text_and_argv_before_creating_scripts() {
    let startup =
        TerminalStartup::from_key(CliTerminalKey::generate().expect("key"), &Config::default());
    let (tx, _rx) = channel();
    let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
    let scripts = tempfile::tempdir().expect("scripts parent");
    execs.scripts = scripts.path().join("never-created");
    let argv = vec!["nonexistent-program".to_string()];
    for line in [ExecLine::Text("echo should-not-run"), ExecLine::Argv(&argv)] {
        let frames = execs.start(&startup, "relay-only", &line, None, None, TEST_TIMEOUT_MS);
        assert!(matches!(
            frames.as_slice(),
            [OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })]
                if reason == REASON_TRUST_RELAY
        ));
        assert!(execs.sessions.is_empty());
        assert!(!execs.scripts.exists());
    }
}

fn slow_command() -> &'static str {
    // `ping.exe` is a child process the command's job must end (PowerShell runs it too).
    if cfg!(unix) {
        "sleep 30"
    } else {
        "ping -n 30 127.0.0.1"
    }
}

#[cfg(windows)]
#[test]
fn windows_exec_cancel_timeout_drop_and_forced_shutdown_kill_grandchildren() {
    use crate::windows_test_tree::{Tree, assert_dead};
    for action in ["cancel", "timeout", "drop", "forced", "root-exit"] {
        let tree = Tree::new();
        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
        // The default shell (PowerShell) and its descendants must
        // remain in the Windows job.
        let mode = if action == "root-exit" {
            "root-exit"
        } else {
            "detach"
        };
        // The fixture cwd lets the command use relative paths without
        // embedded quotes or Windows backslash escaping, even when the cwd
        // has spaces.
        let command = format!("python tree.py grandchild.pid root.pid {mode}");
        let frames = execs.start_text(
            &enabled_startup(false),
            "windows-tree",
            &command,
            Some(tree.cwd().to_str().expect("fixture cwd")),
            TEST_TIMEOUT_MS,
        );
        assert!(matches!(
            &frames[0],
            OutboundFrame::Control(NodeFrame::ExecStarted { .. })
        ));
        let grandchild = tree.read_marker().parse().expect("grandchild PID");
        let root = execs.pid("windows-tree").expect("exec root");
        match action {
            "cancel" => {
                let _ = execs.cancel("windows-tree");
            }
            "timeout" => {
                let _ = execs.poll(Instant::now() + Duration::from_secs(31));
            }
            "drop" => {
                drop(execs);
                assert_dead(grandchild);
                drop(rx);
                continue;
            }
            "forced" => kill_live_children(
                |child| matches!(child, LiveChild::ExecJob(job) if job.id() == root),
            ),
            "root-exit" => {
                let until = Instant::now() + Duration::from_secs(5);
                while !execs.sessions.is_empty() && Instant::now() < until {
                    let _ = execs.poll(Instant::now());
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!(execs.sessions.is_empty(), "exited exec kept its slot");
            }
            _ => unreachable!(),
        }
        assert_dead(grandchild);
        assert_dead(root);
        drop(execs);
        drop(rx);
    }
}

#[derive(Clone, Default)]
struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogBuf {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut inner) = self.0.lock() {
            inner.extend_from_slice(bytes);
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[test]
fn command_ops_log_op_and_outcome_but_never_the_command_text() {
    let _capture = crate::app::logging::test_capture_lock();
    let buf = LogBuf::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buf.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        let (tx, _rx) = channel();
        let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
        let startup = enabled_startup(false);
        // Refused: bad cwd, and the command carries a secret-looking token.
        let secret_cmd = "echo TOPSECRET_TOKEN_9f3a";
        let _ = execs.start_text(
            &startup,
            "ref1",
            secret_cmd,
            Some("relative"),
            TEST_TIMEOUT_MS,
        );
    });
    let log =
        String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default()).unwrap_or_default();
    assert!(
        log.contains("op=\"exec\"") || log.contains("op=exec"),
        "{log}"
    );
    assert!(log.contains("rejected:bad_cwd"), "{log}");
    assert!(log.contains("ref1"), "{log}");
    assert!(!log.contains("TOPSECRET_TOKEN_9f3a"), "{log}");
    assert!(!log.contains("relative"), "{log}");
}

#[test]
fn a_started_exec_logs_started_and_never_the_command_or_cwd() {
    // The only `start` path the shared log test drives is a refusal; this
    // pins the `Ok` arm's "started" line, which used to go unasserted.
    let _capture = crate::app::logging::test_capture_lock();
    let buf = LogBuf::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buf.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .finish();
    let cwd = tempfile::tempdir().expect("tempdir");
    let (pid, command, dir) = tracing::subscriber::with_default(subscriber, || {
        let (tx, rx) = channel();
        let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
        let command = slow_command();
        let dir = cwd.path().to_string_lossy().into_owned();
        let started = execs.start_text(
            &enabled_startup(false),
            "started1",
            command,
            Some(&dir),
            TEST_TIMEOUT_MS,
        );
        assert!(matches!(
            started[0],
            OutboundFrame::Control(NodeFrame::ExecStarted { .. })
        ));
        let pid = execs.pid("started1").expect("pid");
        drop(execs);
        drop(rx);
        (pid, command, dir)
    });
    let log =
        String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default()).unwrap_or_default();
    let ops = command_ops(&log);
    let started = ops
        .iter()
        .filter(|(_, id, outcome)| id == "started1" && outcome == "started")
        .collect::<Vec<_>>();
    assert_eq!(
        started.len(),
        1,
        "no single started line for the exec: {ops:?}"
    );
    assert!(!log.contains(command), "the command text leaked: {log}");
    assert!(!log.contains(&dir), "the cwd leaked: {log}");
    assert!(!process_exists(pid), "the started child was reaped");
}

#[test]
fn exec_rejects_size_nul_cwd_and_the_concurrency_cap() {
    let (tx, _rx) = channel();
    let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
    let startup = enabled_startup(false);
    let rejected = execs.start_text(&startup, "one", &"a".repeat(4097), None, TEST_TIMEOUT_MS);
    assert!(matches!(
        &rejected[0],
        OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
            if reason == REASON_BAD_COMMAND
    ));
    let rejected = execs.start_text(&startup, "two", "echo\0no", None, TEST_TIMEOUT_MS);
    assert!(matches!(
        &rejected[0],
        OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
            if reason == REASON_BAD_COMMAND
    ));
    let rejected = execs.start_text(
        &startup,
        "three",
        "echo ok",
        Some("relative"),
        TEST_TIMEOUT_MS,
    );
    assert!(matches!(
        &rejected[0],
        OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
            if reason == REASON_BAD_CWD
    ));
    assert!(execs.sessions.is_empty());

    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
    for index in 0..MAX_EXECS {
        assert!(matches!(
            execs.start_text(
                &startup,
                &format!("cmd-{index}"),
                slow_command(),
                None,
                TEST_TIMEOUT_MS
            )[0],
            OutboundFrame::Control(NodeFrame::ExecStarted { .. })
        ));
    }
    let rejected = execs.start_text(&startup, "c", slow_command(), None, TEST_TIMEOUT_MS);
    assert!(matches!(
        &rejected[0],
        OutboundFrame::Control(NodeFrame::ExecRejected { reason, .. })
            if reason == REASON_LIMIT
    ));
    assert_eq!(execs.sessions.len(), MAX_EXECS);
    drop(execs);
    drop(rx);
}

/// A daemon that died left a command running: the next daemon ends its
/// process group and reports it `interrupted`, once.
#[cfg(target_os = "linux")]
#[test]
fn commands_a_restart_interrupted_are_killed_and_reported() {
    use std::os::unix::process::CommandExt;
    let dir = tempfile::tempdir().expect("dir");
    let table = dir.path().join("node-commands.json");
    let mut child = std::process::Command::new("sleep")
        .arg("300")
        .process_group(0)
        .spawn()
        .expect("sleep");
    let pid = child.id();
    let running = vec![RunningCommand {
        command_id: "left-1".into(),
        pid,
        start_ticks: process_start_ticks(pid),
        started_at: "2026-10-06T00:00:00Z".into(),
        ends_by: "2026-10-07T00:00:00Z".into(),
    }];
    std::fs::write(&table, serde_json::to_vec(&running).expect("json")).expect("table");
    let (tx, _rx) = channel();
    let (execs, frames) = ExecRegistry::new(tx, Duration::from_secs(30)).with_table(table.clone());
    assert_eq!(frames.len(), 1);
    let OutboundFrame::Control(NodeFrame::ExecStatus(status)) = &frames[0] else {
        panic!("exec.status");
    };
    assert_eq!(status.state, ExecState::Interrupted);
    assert!(status.validate().is_ok());
    // Polls keep answering it, and the table is now empty.
    let polled = execs.status("left-1", 0);
    assert!(matches!(
        &polled[0],
        OutboundFrame::Control(NodeFrame::ExecStatus(s)) if s.state == ExecState::Interrupted
    ));
    assert_eq!(std::fs::read_to_string(&table).expect("table"), "[]");
    let exited = child.wait().expect("reaped");
    assert!(!exited.success(), "the left command was killed");
    // A pid whose start time no longer matches is never signalled.
    let mut other = std::process::Command::new("sleep")
        .arg("300")
        .process_group(0)
        .spawn()
        .expect("sleep");
    let stale = vec![RunningCommand {
        command_id: "left-2".into(),
        pid: other.id(),
        start_ticks: Some(1),
        started_at: "2026-10-06T00:00:00Z".into(),
        ends_by: "2026-10-07T00:00:00Z".into(),
    }];
    std::fs::write(&table, serde_json::to_vec(&stale).expect("json")).expect("table");
    let (tx, _rx) = channel();
    let (_execs, frames) = ExecRegistry::new(tx, Duration::from_secs(30)).with_table(table);
    assert_eq!(frames.len(), 1);
    assert!(
        other.try_wait().expect("poll").is_none(),
        "an unrelated process survives"
    );
    let _ = other.kill();
    let _ = other.wait();
}

#[test]
fn exec_timeout_uses_the_injected_duration() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_millis(200));
    let startup = enabled_startup(false);
    execs.start_text(&startup, "slow", slow_command(), None, TEST_TIMEOUT_MS);
    std::thread::sleep(Duration::from_millis(350));
    let deadline = Instant::now() + Duration::from_secs(2);
    let frames = loop {
        while let Ok(message) = rx.try_recv() {
            match message {
                FromWorker::ExecBytes {
                    command_id,
                    stderr,
                    bytes,
                } => {
                    execs.on_bytes(&command_id, stderr, &bytes);
                }
                FromWorker::ExecEof { command_id, stderr } => {
                    execs.on_eof(&command_id, stderr);
                }
                _ => {}
            }
        }
        let frames = execs.poll(Instant::now());
        if !frames.is_empty() {
            break frames;
        }
        if Instant::now() > deadline {
            panic!("timed out command did not finish");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(matches!(
        &frames[0],
        OutboundFrame::Control(NodeFrame::ExecStatus(status)) if status.state == ExecState::TimedOut
    ));
    drop(execs);
    drop(rx);
}

#[test]
fn exec_end_cause_precedence() {
    let at = Instant::now();
    let reaped = |timed_out| ExecPhase::Reaped {
        status: (Some(3), None),
        at,
        timed_out,
    };
    for requested in [EndCause::Exited, EndCause::Cancelled, EndCause::Interrupted] {
        // A timeout the node already acted on wins over a later cancel or shutdown.
        assert!(ExecPhase::TimedOut.end_cause(requested) == EndCause::TimedOut);
        assert!(reaped(true).end_cause(requested) == EndCause::TimedOut);
        // Otherwise the requested cause wins, even over an exit still draining.
        assert!(ExecPhase::Running.end_cause(requested) == requested);
        assert!(reaped(false).end_cause(requested) == requested);
    }
    // Only an unreaped leader is signalled by pid.
    assert!(!ExecPhase::Running.reaped());
    assert!(!ExecPhase::TimedOut.reaped());
    assert!(reaped(false).reaped());
}

#[test]
fn exec_start_after_kill_all_is_refused() {
    let (tx, _rx) = channel();
    let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
    assert!(execs.kill_all().is_empty());
    let rejected = execs.start_text(
        &enabled_startup(false),
        "late",
        slow_command(),
        None,
        TEST_TIMEOUT_MS,
    );
    assert!(matches!(
        &rejected[..],
        [OutboundFrame::Control(NodeFrame::ExecRejected { command_id, reason })]
            if command_id == "late" && reason == REASON_SPAWN_FAILED
    ));
    assert!(execs.sessions.is_empty(), "nothing runs after the shutdown");
    assert!(
        execs.kill_all().is_empty(),
        "a second shutdown does nothing"
    );
}

#[test]
#[cfg(unix)]
fn an_exec_reaped_before_its_deadline_is_not_timed_out_while_it_drains() {
    let (tx, _rx) = channel();
    let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
    execs.start_text(&enabled_startup(false), "quick", "exit 3", None, 2_000);
    // Reap it before its deadline; its pipe EOFs are never fed, so it waits to drain.
    let until = Instant::now() + Duration::from_secs(1);
    while !execs.sessions["quick"].phase.reaped() {
        assert!(execs.poll(Instant::now()).is_empty(), "it waits to drain");
        assert!(Instant::now() < until, "the command never exited");
        std::thread::sleep(Duration::from_millis(10));
    }
    let ExecPhase::Reaped { at, .. } = execs.sessions["quick"].phase else {
        unreachable!("checked above");
    };
    let deadline = execs.sessions["quick"].deadline;
    assert!(deadline > at, "reaped before its deadline");
    // The deadline passes while the output drains: the exit is still reported.
    let frames = execs.poll(deadline.max(at + EXEC_OUTPUT_DRAIN));
    assert!(
        matches!(
            &frames[..],
            [OutboundFrame::Control(NodeFrame::ExecStatus(status))]
                if status.state == ExecState::Failed && status.exit_code == Some(3)
        ),
        "the exit is reported, not a timeout"
    );
}

#[test]
fn a_timed_out_exec_logs_the_timed_out_outcome() {
    // The frame's `timed_out` flag is asserted above; this pins the CLI
    // log's outcome code, which a dropped branch would quietly turn into
    // `ended`/`signaled` while the frame stayed correct.
    let _capture = crate::app::logging::test_capture_lock();
    let buf = LogBuf::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buf.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .finish();
    let (tx, rx) = channel();
    tracing::subscriber::with_default(subscriber, || {
        let mut execs = ExecRegistry::new(tx, Duration::from_millis(200));
        execs.start_text(
            &enabled_startup(false),
            "slow",
            slow_command(),
            None,
            TEST_TIMEOUT_MS,
        );
        std::thread::sleep(Duration::from_millis(350));
        let deadline = Instant::now() + Duration::from_secs(5);
        while execs.poll(Instant::now()).is_empty() {
            while let Ok(message) = rx.try_recv() {
                match message {
                    FromWorker::ExecBytes {
                        command_id,
                        stderr,
                        bytes,
                    } => {
                        execs.on_bytes(&command_id, stderr, &bytes);
                    }
                    FromWorker::ExecEof { command_id, stderr } => {
                        execs.on_eof(&command_id, stderr);
                    }
                    _ => {}
                }
            }
            assert!(Instant::now() < deadline, "the exec never timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    drop(rx);
    let log =
        String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default()).unwrap_or_default();
    let outcomes = command_ops(&log)
        .into_iter()
        .filter(|(_, id, _)| id == "slow")
        .map(|(_, _, outcome)| outcome)
        .collect::<Vec<_>>();
    assert!(
        outcomes.contains(&"timed_out".to_string()),
        "no timed_out outcome line for a timed-out exec: {outcomes:?}\nlog:\n{log}"
    );
}

#[test]
fn dropping_the_exec_registry_reaps_the_child() {
    let (tx, rx) = channel();
    let pid = {
        let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
        execs.start_text(
            &enabled_startup(false),
            "sleep",
            slow_command(),
            None,
            TEST_TIMEOUT_MS,
        );
        let pid = execs.pid("sleep").expect("pid");
        drop(execs);
        pid
    };
    // Ending a Windows job is asynchronous: a loaded machine can list the process a moment.
    let until = Instant::now() + Duration::from_secs(5);
    while process_exists(pid) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!process_exists(pid), "child was not reaped");
    drop(rx);
}

#[test]
#[cfg(unix)]
fn killing_an_exec_kills_its_process_group() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pidfile = dir.path().join("grand.pid");
    let command = format!("sleep 120 & echo $! > '{}'; wait", pidfile.display());
    assert!(
        !pidfile.display().to_string().contains('\''),
        "temp path is unsafe to inline in a shell command"
    );
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
    execs.start_text(
        &enabled_startup(false),
        "group",
        &command,
        Some(dir.path().to_str().expect("utf8")),
        TEST_TIMEOUT_MS,
    );
    let shell_pid = execs.pid("group").expect("shell");
    let deadline = Instant::now() + Duration::from_secs(2);
    let grand = loop {
        if let Ok(text) = std::fs::read_to_string(&pidfile)
            && let Ok(pid) = text.trim().parse::<u32>()
            && pid > 1
        {
            break pid;
        }
        if Instant::now() > deadline {
            panic!("grandchild pid was not written");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let _ = execs.cancel("group");
    // The grandchild is not our child. Init reaps the zombie after SIGKILL.
    let deadline = Instant::now() + Duration::from_secs(1);
    while process_exists(grand) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let grand_stat = std::fs::read_to_string(format!("/proc/{grand}/stat")).unwrap_or_default();
    assert!(
        !process_exists(grand),
        "grandchild still exists stat={grand_stat}"
    );
    assert!(!process_exists(shell_pid), "shell was not reaped");
    drop(execs);
    drop(rx);
}

#[test]
fn closed_pipes_do_not_wait_for_a_running_command() {
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
    let command = if cfg!(unix) {
        "exec sleep 30 >/dev/null 2>&1"
    } else {
        slow_command()
    };
    execs.start_text(
        &enabled_startup(false),
        "sleep",
        command,
        None,
        TEST_TIMEOUT_MS,
    );
    let pid = execs.pid("sleep").expect("pid");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut stdout_done = false;
    let mut stderr_done = false;
    while Instant::now() < deadline && !(stdout_done && stderr_done) {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(FromWorker::ExecEof { stderr, .. }) => {
                let started = Instant::now();
                execs.on_eof("sleep", stderr);
                assert!(
                    started.elapsed() < Duration::from_millis(500),
                    "eof handling blocked"
                );
                if stderr {
                    stderr_done = true;
                } else {
                    stdout_done = true;
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if cfg!(unix) {
        assert!(stdout_done && stderr_done, "pipes did not close");
        let started = Instant::now();
        let frames = execs.poll(Instant::now());
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(
            frames.is_empty(),
            "closed pipes must not finish the command"
        );
        assert!(
            process_exists(pid),
            "process was killed when its pipes closed"
        );
    }
    drop(execs);
    drop(rx);
}

#[test]
#[cfg(unix)]
fn a_finished_command_kills_grandchildren_in_its_process_group() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pidfile = dir.path().join("grand.pid");
    let command = format!("sleep 120 & echo $! > '{}'; exit", pidfile.display());
    let (tx, rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(30));
    execs.start_text(
        &enabled_startup(false),
        "group",
        &command,
        Some(dir.path().to_str().expect("utf8")),
        TEST_TIMEOUT_MS,
    );
    let shell_pid = execs.pid("group").expect("shell");
    let deadline = Instant::now() + Duration::from_secs(2);
    let grand = loop {
        if let Ok(text) = std::fs::read_to_string(&pidfile)
            && let Ok(pid) = text.trim().parse::<u32>()
            && pid > 1
        {
            break pid;
        }
        if Instant::now() > deadline {
            panic!("grandchild pid was not written");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let _ = rx.try_recv();
        let frames = execs.poll(Instant::now());
        if frames
            .iter()
            .any(|frame| matches!(frame, OutboundFrame::Control(NodeFrame::ExecStatus(_))))
        {
            break;
        }
        if Instant::now() > deadline {
            panic!("command did not finish");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    while process_exists(grand) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!process_exists(grand), "grandchild still exists");
    assert!(!process_exists(shell_pid), "shell was not reaped");
    drop(execs);
    drop(rx);
}

mod exec_shell_tests;
mod output_mask_tests;

/// The `command operation` info lines as `(op, command_id, outcome)`.
/// The default formatter writes the message last, then the fields in the
/// `tracing::info!` order; `command_id` is quoted, the other two are bare
/// (the `op` may be quoted too, depending on the value).
fn command_ops(log: &str) -> Vec<(String, String, String)> {
    const MESSAGE: &str = "command operation";
    log.lines()
        .filter_map(|line| {
            let marker = line.find(MESSAGE)?;
            let rest = &line[marker + MESSAGE.len()..];
            let words = rest.split_whitespace().collect::<Vec<_>>();
            let [op, command_id, outcome] = words[words.len().checked_sub(3)?..] else {
                return None;
            };
            Some((
                op.strip_prefix("op=")?.trim_matches('"').to_string(),
                command_id
                    .strip_prefix("command_id=")?
                    .trim_matches('"')
                    .to_string(),
                outcome
                    .strip_prefix("outcome=")?
                    .trim_matches('"')
                    .to_string(),
            ))
        })
        .collect()
}
