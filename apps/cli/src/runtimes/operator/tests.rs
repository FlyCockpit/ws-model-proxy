use super::*;
use crate::protocol::frames::InstancePhase;
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::sync::Arc;

fn screen(command: &str, author: CommandAuthor) -> OperatorScreen {
    OperatorScreen {
        node: "spark-1".into(),
        handle: "i-abcdefabcdef".into(),
        phase: JobPhase::Start,
        rank: 1,
        command: command.into(),
        author,
    }
}

#[test]
fn the_confirm_screen_shows_the_command_its_author_and_the_password_note() {
    let rows = layout(
        &screen("sudo systemctl start vllm", CommandAuthor::User),
        100,
        40,
    );
    let text = rows.join("\n");
    assert!(text.contains("A step of i-abcdefabcdef needs you on spark-1."));
    assert!(text.contains("Step: start (node 2 of the runtime)"));
    assert!(text.contains("(written by you; 1 lines, 25 characters)"));
    assert!(text.contains("    sudo systemctl start vllm"));
    assert!(text.contains("passes through the server"));
    assert_eq!(
        rows.last().map(String::as_str),
        Some("Press Enter to run it here. Press q to close without running.")
    );
    assert!(!text.contains("scroll up"), "it fits");
    for (author, shown) in [
        (CommandAuthor::Agent, "written by an agent"),
        (CommandAuthor::Unknown, "written by unknown"),
    ] {
        assert!(
            layout(&screen("x", author), 100, 40)
                .join("\n")
                .contains(shown)
        );
    }
    // Every row fits the width; a long command wraps, indented.
    let long = "a".repeat(250);
    let rows = layout(&screen(&long, CommandAuthor::User), 60, 40);
    assert!(rows.iter().all(|row| row.chars().count() <= 60));
    assert!(rows.iter().filter(|row| row.starts_with("    a")).count() >= 4);
    let painted =
        String::from_utf8(paint(&screen("x", CommandAuthor::User), 80, 24)).expect("utf8");
    assert!(painted.starts_with("\x1b[H\x1b[2J"));
    assert!(
        painted.ends_with("without running."),
        "prompt on the last row"
    );
}

#[test]
fn a_tall_command_says_so_beside_the_prompt_and_blank_runs_collapse() {
    let tall = (1..=60)
        .map(|n| format!("echo {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let rows = layout(&screen(&tall, CommandAuthor::Agent), 80, 24);
    let text = rows.join("\n");
    assert!(text.contains("(written by an agent; 60 lines, "));
    let n = rows.len();
    assert!(rows[n - 2].contains("The command is 60 lines"), "{rows:?}");
    assert!(rows[n - 2].contains("scroll up to read all of it"));
    assert!(rows[n - 1].starts_with("Press Enter"));
    // Hundreds of blank lines cannot push the start of the command away.
    let hidden = format!("echo safe{}rm -rf ~/x\n\n\nend", "\n".repeat(500));
    let rows = layout(&screen(&hidden, CommandAuthor::Agent), 80, 24);
    assert!(rows.len() < 24, "{rows:?}");
    let text = rows.join("\n");
    assert!(text.contains("    echo safe\n    \\u{a} x499 (blank lines)\n    rm -rf ~/x"));
    assert!(text.contains("    \\u{a} x2 (blank lines)\n    end"));
    // A single blank line stays as it is.
    assert!(
        layout(&screen("a\n\nb", CommandAuthor::User), 80, 24)
            .join("\n")
            .contains("    a\n    \n    b")
    );
}

#[test]
fn control_bidi_and_invisible_characters_cannot_hide_part_of_the_command() {
    let hostile = "sudo true \u{1b}[2K\u{202e}tsoh\u{200b}\r# harmless";
    let mut evil = screen(hostile, CommandAuthor::Agent);
    evil.handle = "i-x\u{1b}]0;t\u{7}".into();
    evil.node = "n\u{202e}".into();
    let text = layout(&evil, 200, 60).join("\n");
    assert!(
        !text.chars().any(|ch| ch.is_control() && ch != '\n'),
        "{text:?}"
    );
    assert!(!text.contains('\u{202e}') && !text.contains('\u{200b}'));
    assert!(text.contains("\\u{1b}[2K\\u{202e}tsoh\\u{200b}\\u{d}# harmless"));
}

#[test]
fn only_enter_accepts_and_only_q_or_ctrl_c_d_decline() {
    assert_eq!(confirm_key(b"\r"), Some(ConfirmKey::Accept));
    assert_eq!(confirm_key(b"\n"), Some(ConfirmKey::Accept));
    for key in [&b"q"[..], b"Q", b"\x03", b"\x04"] {
        assert_eq!(confirm_key(key), Some(ConfirmKey::Decline));
    }
    assert_eq!(confirm_key(b"y yes ls \x1b[A\t"), None);
    // The first decisive key wins.
    assert_eq!(confirm_key(b"xq\r"), Some(ConfirmKey::Decline));
    assert_eq!(confirm_key(b"x\rq"), Some(ConfirmKey::Accept));
}

#[test]
fn the_environment_drops_askpass_and_startup_files() {
    let base = vec![
        ("PATH".to_string(), "/bin".to_string()),
        ("SUDO_ASKPASS".to_string(), "/tmp/steal".to_string()),
        ("BASH_ENV".to_string(), "/tmp/rc".to_string()),
        ("ENV".to_string(), "/tmp/rc".to_string()),
        ("WSMP_JOB".to_string(), "1".to_string()),
        ("TOKEN".to_string(), "old".to_string()),
    ];
    let extra = vec![
        ("TOKEN".to_string(), "secret".to_string()),
        ("SUDO_ASKPASS".to_string(), "/tmp/again".to_string()),
    ];
    let env = operator_env(&base, &extra);
    let names = env
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, ["PATH", "WSMP_JOB", "TOKEN"]);
    assert!(env.contains(&("TOKEN".to_string(), "secret".to_string())));
    let open = OperatorOpen {
        ids: OperatorIds {
            step_id: "s".into(),
            instance_id: "i".into(),
            rank: 0,
            intent_hash: "a".repeat(64),
            owner_epoch: "e".into(),
            terminal_id: "t".into(),
        },
        screen: screen("x", CommandAuthor::User),
        env,
        events: std::sync::mpsc::sync_channel(1).0,
    };
    assert!(!format!("{open:?}").contains("secret"));
}

#[test]
fn results_name_the_terminal_and_only_operator_closed_carries_an_exit_code() {
    let ids = OperatorIds {
        step_id: "s".into(),
        instance_id: "i".into(),
        rank: 0,
        intent_hash: "a".repeat(64),
        owner_epoch: "e".into(),
        terminal_id: "t".into(),
    };
    for status in [
        JobStatus::AwaitingOperator,
        JobStatus::OperatorRunning,
        JobStatus::OperatorClosed,
    ] {
        let NodeFrame::RuntimeJobResult {
            exit_code,
            terminal_id,
            error,
            ..
        } = ids.result(status, Some(3))
        else {
            panic!("a job result");
        };
        assert_eq!(terminal_id.as_deref(), Some("t"));
        assert_eq!(error, None);
        assert_eq!(exit_code.is_some(), status == JobStatus::OperatorClosed);
    }
    let NodeFrame::RuntimeJobResult {
        status,
        error,
        terminal_id,
        ..
    } = ids.failed(JobError::OperatorTerminalsDisabled)
    else {
        panic!("a job result");
    };
    assert_eq!(status, JobStatus::Failed);
    assert_eq!(error, Some(JobError::OperatorTerminalsDisabled));
    assert_eq!(terminal_id.as_deref(), Some("t"));
    assert_eq!(exit_code((Some(0), None)), Some(0));
    assert_eq!(exit_code((None, Some(2))), Some(130));
    assert_eq!(exit_code((None, None)), None);
}

// ── The wrapper, run as the PTY would run it (without a PTY) ──

#[cfg(unix)]
fn fake_sudo() -> (tempfile::TempDir, String) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("dir");
    let log = dir.path().join("sudo.log");
    let script = dir.path().join("sudo");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho \"$*\" >> '{}'\n", log.display()),
    )
    .expect("script");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let path = format!("{}:/usr/bin:/bin", dir.path().display());
    (dir, path)
}

#[cfg(unix)]
fn run_wrapper(command: &str, path: &str) -> (Option<i32>, String) {
    let (program, args) = wrapper_argv(command);
    let output = std::process::Command::new(program)
        .args(args)
        .env_clear()
        .env("PATH", path)
        .output()
        .expect("run");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    )
}

#[cfg(unix)]
#[test]
fn the_wrapper_resets_sudo_before_and_after_and_keeps_the_exit_code() {
    let (dir, path) = fake_sudo();
    let log = dir.path().join("sudo.log");
    let (code, out) = run_wrapper("echo \"a;b\" 'c d' $0; exit 7", &path);
    assert_eq!(code, Some(7));
    // `$1` reaches its own shell verbatim: quotes and `;` keep their meaning.
    assert_eq!(out, "a;b c d /bin/sh\n");
    assert_eq!(
        std::fs::read_to_string(&log).expect("log"),
        "-k\n-k\n",
        "sudo -k before and after"
    );
    let (code, _) = run_wrapper("true", &path);
    assert_eq!(code, Some(0));
    // A command starting with `-` or `+` is a command, never shell options.
    let (code, out) = run_wrapper("-x 2>/dev/null; echo after", &path);
    assert_eq!((code, out.as_str()), (Some(0), "after\n"));
    let (_, out) = run_wrapper("+o 2>/dev/null; echo plus", &path);
    assert_eq!(out, "plus\n");
    // Without sudo on PATH nothing else is tried (builtins only here).
    let (code, out) = run_wrapper("echo ok", "/nonexistent");
    assert_eq!((code, out.as_str()), (Some(0), "ok\n"));
}

#[cfg(unix)]
#[test]
fn ctrl_c_ends_the_command_but_the_wrapper_still_resets_sudo() {
    // Spawned the way the operator terminal spawns it, through portable-pty,
    // which resets SIGINT to its default and gives the child its own session.
    // A plain `std::process::Command` would hand the wrapper this process's
    // dispositions, and a test run started as a background job of a
    // non-interactive shell inherits SIGINT as ignored, which no shell can
    // trap or undo: `sleep` would then outlive the Ctrl-C.
    let (dir, path) = fake_sudo();
    let log = dir.path().join("sudo.log");
    let started = dir.path().join("started");
    let (program, args) = wrapper_argv(&format!("touch '{}'; sleep 30", started.display()));
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize::default())
        .expect("pty");
    let mut command = portable_pty::CommandBuilder::new(program);
    command.args(args);
    command.env_clear();
    command.env("PATH", &path);
    command.cwd(dir.path());
    let mut child = pair.slave.spawn_command(command).expect("spawn");
    drop(pair.slave);
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !started.exists() && std::time::Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(started.exists());
    let pid = child.process_id().expect("pid");
    // The session leader leads its own process group.
    let group = nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid"));
    // As a terminal delivers Ctrl-C: SIGINT to the whole foreground group.
    nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGINT).expect("signal");
    let status = child.wait().expect("wait");
    assert_eq!(status.exit_code(), 130, "the command died of SIGINT");
    assert_eq!(std::fs::read_to_string(&log).expect("log"), "-k\n-k\n");
    drop(pair.master);
}

// ── The step flow, with a scripted machine and terminal ──

struct Machine {
    /// What the status command answers, in order (the last repeats).
    status: RefCell<Vec<Result<bool, ()>>>,
    stops: Cell<u32>,
    shells: RefCell<Vec<String>>,
}

impl Machine {
    fn new(status: Vec<Result<bool, ()>>) -> Self {
        Self {
            status: RefCell::new(status),
            stops: Cell::new(0),
            shells: RefCell::new(Vec::new()),
        }
    }
}

impl Runtime for Machine {
    fn contains_ranks(&self) -> bool {
        true
    }
    fn launch(&self, _: &Job, _: &str, _: &str, _: Deadline) -> anyhow::Result<String> {
        anyhow::bail!("an operator step never launches a unit")
    }
    fn identity(&self, _: &str, _: &str, _: Deadline) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
    fn shell_until(&self, _: &Job, command: &str, _: Deadline) -> anyhow::Result<()> {
        self.shells.borrow_mut().push(command.to_string());
        Ok(())
    }
    fn status_until(&self, _: &Job, _: &str, _: Deadline) -> anyhow::Result<bool> {
        let mut answers = self.status.borrow_mut();
        let answer = if answers.len() > 1 {
            answers.remove(0)
        } else {
            answers.first().copied().unwrap_or(Err(()))
        };
        answer.map_err(|()| anyhow::anyhow!("unknown"))
    }
    fn stop(&self, _: &str, _: &str, _: &str, _: Deadline) -> anyhow::Result<()> {
        self.stops.set(self.stops.get() + 1);
        Ok(())
    }
    fn healthy_until(
        &self,
        _: &Job,
        _: Deadline,
    ) -> Result<(), crate::runtimes::executor::HealthMiss> {
        Ok(())
    }
    fn tasks_alive(&self, _: &str, _: Deadline) -> anyhow::Result<bool> {
        Ok(false)
    }
    fn port_free(&self, _: &str, _: u16) -> bool {
        true
    }
}

fn job(action: JobPhase) -> Job {
    Job {
        step_id: format!("step-{action:?}"),
        instance_id: "in1".into(),
        runtime_id: "rt1".into(),
        version_id: "vr1".into(),
        launch_hash: "h".repeat(64),
        rank: 0,
        action,
        intent_hash: "a".repeat(64),
        owner_epoch: "epoch".into(),
        command: match action {
            JobPhase::Prepare => "sudo apt-get install -y x".into(),
            JobPhase::Start => "sudo systemctl start x".into(),
            _ => String::new(),
        },
        stop_command: "sudo systemctl stop x".into(),
        status_command: Some("systemctl is-active x".into()),
        health_command: None,
        secrets: Vec::new(),
        timeout_ms: 2_000,
        unit_name: "wsmp-i-abcdefabcdef-r0".into(),
        handle: "i-abcdefabcdef".into(),
        port: 30001,
        gpu_ids: None,
        dist_port: None,
        host: "127.0.0.1".into(),
        spec: serde_json::json!({
            "api": "openai", "engine": "vllm", "modelType": "llm",
            "models": [{ "id": "m" }],
            "launch": {
                "management": "service", "groupSize": 1,
                "resources": [{ "kind": "none" }], "labels": [],
                "commands": [{
                    "start": "sudo systemctl start x", "stop": "sudo systemctl stop x",
                    "status": "systemctl is-active x",
                    "interactive": { "start": true, "stop": true }
                }],
                "health": { "intervalMs": 30000, "failureThreshold": 2, "successThreshold": 1 }
            }
        }),
    }
}

/// A terminal driven by a script: the events it reports once opened.
struct Terminal {
    script: Vec<(Duration, OperatorEvent)>,
    opened: Cell<u32>,
    closes: Cell<u32>,
    held: RefCell<Option<SyncSender<OperatorEvent>>>,
    /// Set when the terminal opens (a stop arriving while it shows its screen).
    cancel_on_open: Option<Arc<AtomicBool>>,
    refuse: Option<JobError>,
    /// Set right after the scripted Accepted is sent (a stop during the run).
    cancel_after_accept: Option<Arc<AtomicBool>>,
    /// The instance state file: the step must be durable on disk at open.
    durable: Option<PathBuf>,
}

impl Terminal {
    fn new(script: Vec<(Duration, OperatorEvent)>) -> Self {
        Self {
            script,
            opened: Cell::new(0),
            closes: Cell::new(0),
            held: RefCell::new(None),
            cancel_on_open: None,
            refuse: None,
            cancel_after_accept: None,
            durable: None,
        }
    }
}

impl OperatorLink for Terminal {
    fn open(&self, _: &Job, events: SyncSender<OperatorEvent>) -> Result<(), JobError> {
        if let Some(error) = self.refuse {
            return Err(error);
        }
        self.opened.set(self.opened.get() + 1);
        if let Some(path) = &self.durable {
            let state = std::fs::read_to_string(path).expect("the step is on disk");
            assert!(
                state.contains("\"pending\":{"),
                "pending before the terminal opens"
            );
        }
        if let Some(cancel) = &self.cancel_on_open {
            cancel.store(true, Ordering::SeqCst);
        }
        let script = self.script.clone();
        let sender = events.clone();
        let after_accept = self.cancel_after_accept.clone();
        std::thread::spawn(move || {
            for (wait, event) in script {
                std::thread::sleep(wait);
                let _ = sender.send(event);
                if event == OperatorEvent::Accepted
                    && let Some(cancel) = &after_accept
                {
                    cancel.store(true, Ordering::SeqCst);
                }
            }
        });
        *self.held.borrow_mut() = Some(events);
        Ok(())
    }
    fn close_if_confirming(&self) {
        self.closes.set(self.closes.get() + 1);
        if let Some(events) = self.held.borrow_mut().take() {
            let _ = events.send(OperatorEvent::Closed);
        }
    }
}

fn fresh() -> (tempfile::TempDir, PathBuf, Executor) {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("in1-r0.json");
    let executor = Executor::load(path.clone()).expect("load");
    (dir, path, executor)
}

const NOW: Duration = Duration::ZERO;

fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

#[test]
fn a_crash_during_a_persons_run_leaves_a_record_the_re_dispatch_settles() {
    let (_dir, path, mut executor) = fresh();
    // The node died while the person's start ran: only the durable intent
    // remains.
    let start = job(JobPhase::Start);
    executor.begin_operator(&start).expect("durable");
    drop(executor);
    let mut executor = Executor::load(path).expect("after the crash");
    let machine = Machine::new(vec![Ok(true)]);
    let observed = executor.observations(&machine, Deadline::new(Duration::from_secs(1)));
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].1.phase, InstancePhase::Unknown);
    // The re-dispatch checks status first: alive, so no terminal again.
    let terminal = Terminal::new(Vec::new());
    let outcome = run_operator(
        &mut executor,
        start,
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(outcome.status, JobStatus::Succeeded);
    assert_eq!(terminal.opened.get(), 0);
}

#[test]
fn a_decline_answers_nothing_more_and_leaves_no_pending_step() {
    let (_dir, path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(false)]);
    let terminal = Terminal::new(vec![(NOW, OperatorEvent::Closed)]);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    );
    assert_eq!(outcome, None, "operator_closed already went out");
    assert_eq!(terminal.opened.get(), 1);
    // The record made for the step is gone again: nothing ran.
    let mut executor = Executor::load(path).expect("reload");
    assert!(
        executor
            .observations(&machine, Deadline::new(Duration::from_secs(1)))
            .is_empty()
    );
    // A fresh dispatch of the same step (a reopen) is not blocked.
    let terminal = Terminal::new(vec![
        (NOW, OperatorEvent::Accepted),
        (NOW, OperatorEvent::ExitedOk),
    ]);
    let machine = Machine::new(vec![Ok(false), Ok(true)]);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("a final result");
    assert_eq!(outcome.status, JobStatus::Succeeded);
}

#[test]
fn a_clean_run_counts_once_status_shows_the_service_alive() {
    let (_dir, _path, mut executor) = fresh();
    // Not alive at first (the person is needed), then alive after the run.
    let machine = Machine::new(vec![Ok(false), Ok(false), Ok(true)]);
    let terminal = Terminal::new(vec![
        (NOW, OperatorEvent::Accepted),
        (Duration::from_millis(50), OperatorEvent::ExitedOk),
    ]);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(outcome.status, JobStatus::Succeeded);
    let observed = executor.observations(&machine, Deadline::new(Duration::from_secs(1)));
    assert_eq!(observed.len(), 1);
    // A re-delivery answers from history without a terminal.
    let again = Terminal::new(Vec::new());
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &again,
        &no_cancel(),
    )
    .expect("from history");
    assert_eq!(outcome.status, JobStatus::Succeeded);
    assert_eq!(again.opened.get(), 0);
}

#[test]
fn a_run_whose_service_never_comes_up_fails_unconfirmed() {
    let (_dir, _path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(false)]);
    let terminal = Terminal::new(vec![
        (NOW, OperatorEvent::Accepted),
        (NOW, OperatorEvent::ExitedOk),
    ]);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(outcome.status, JobStatus::Failed);
    assert!(matches!(
        outcome.error,
        Some(JobError::LaunchUnconfirmed | JobError::JobDeadline)
    ));
}

#[test]
fn status_first_settles_a_start_already_alive_without_a_terminal() {
    let (_dir, _path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(true)]);
    let terminal = Terminal::new(Vec::new());
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(outcome.status, JobStatus::Succeeded);
    assert_eq!(terminal.opened.get(), 0);
}

#[test]
fn a_prepare_always_needs_its_person() {
    let (_dir, _path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(true)]);
    let terminal = Terminal::new(vec![
        (NOW, OperatorEvent::Accepted),
        (NOW, OperatorEvent::ExitedOk),
    ]);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Prepare),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(terminal.opened.get(), 1);
    assert_eq!(outcome.status, JobStatus::Succeeded);
}

#[test]
fn an_interactive_stop_runs_its_command_once_then_proves_the_stop() {
    let (_dir, _path, mut executor) = fresh();
    // Started by a person (alive at once: status-first).
    let machine = Machine::new(vec![Ok(true)]);
    let none = Terminal::new(Vec::new());
    let _ = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &none,
        &no_cancel(),
    );
    // Alive at the stop: the person runs the stop command; then stopped.
    let machine = Machine::new(vec![Ok(true), Ok(false)]);
    let terminal = Terminal::new(vec![
        (NOW, OperatorEvent::Accepted),
        (NOW, OperatorEvent::ExitedOk),
    ]);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Stop),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(outcome.status, JobStatus::Succeeded);
    assert!(outcome.stopped);
    assert!(
        machine.shells.borrow().is_empty(),
        "the stop command is never run again by the node"
    );
    // The inventory runs no command in the rank's slice (it holds no rank lock): a service,
    // proven only by its status command, is never reported stopped from there.
    let observed = executor.observations(&machine, Deadline::new(Duration::from_secs(1)));
    assert_eq!(observed[0].1.phase, InstancePhase::Unknown);
}

#[test]
fn status_first_settles_a_stop_already_stopped() {
    let (_dir, _path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(true)]);
    let none = Terminal::new(Vec::new());
    let _ = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &none,
        &no_cancel(),
    );
    let machine = Machine::new(vec![Ok(false)]);
    let terminal = Terminal::new(Vec::new());
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Stop),
        &machine,
        &machine,
        &terminal,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(
        (outcome.status, outcome.stopped),
        (JobStatus::Succeeded, true)
    );
    assert_eq!(terminal.opened.get(), 0);
    assert!(machine.shells.borrow().is_empty());
}

#[test]
fn a_stop_closes_a_confirm_screen_but_waits_behind_a_running_command() {
    // While confirming: the stop's cancel closes the terminal.
    let (_dir, _path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(false)]);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut terminal = Terminal::new(Vec::new());
    terminal.cancel_on_open = Some(Arc::clone(&cancel));
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &cancel,
    );
    assert_eq!(outcome, None);
    assert_eq!(terminal.closes.get(), 1);

    // Once accepted: never closed; the run ends and is proven.
    let (_dir, path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(false), Ok(true)]);
    let cancel = Arc::new(AtomicBool::new(false));
    // The stop's cancel lands right after the Enter, while the command runs
    // (several cancel polls pass before the command ends).
    let mut terminal = Terminal::new(vec![
        (NOW, OperatorEvent::Accepted),
        (Duration::from_millis(700), OperatorEvent::ExitedOk),
    ]);
    terminal.cancel_after_accept = Some(Arc::clone(&cancel));
    terminal.durable = Some(path);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &cancel,
    )
    .expect("final");
    assert_eq!(terminal.closes.get(), 0, "a person's run is never cut off");
    assert_eq!(outcome.status, JobStatus::Succeeded);
}

#[test]
fn a_cancel_before_the_terminal_or_a_refused_open_answers_a_failure() {
    let (_dir, _path, mut executor) = fresh();
    let machine = Machine::new(vec![Ok(false)]);
    let terminal = Terminal::new(Vec::new());
    let cancelled = AtomicBool::new(true);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &terminal,
        &cancelled,
    )
    .expect("final");
    assert_eq!(outcome.error, Some(JobError::SessionDisconnected));
    assert_eq!(terminal.opened.get(), 0);
    let mut refusing = Terminal::new(Vec::new());
    refusing.refuse = Some(JobError::LocalConfigUnavailable);
    let outcome = run_operator(
        &mut executor,
        job(JobPhase::Start),
        &machine,
        &machine,
        &refusing,
        &no_cancel(),
    )
    .expect("final");
    assert_eq!(outcome.error, Some(JobError::LocalConfigUnavailable));
}

/// Run `job` with status answering `status` and a terminal scripted by
/// `script`; returns the outcome and whether the terminal opened.
fn operate(
    executor: &mut Executor,
    job: Job,
    status: Vec<Result<bool, ()>>,
    script: Vec<(Duration, OperatorEvent)>,
) -> (Option<Outcome>, bool) {
    let machine = Machine::new(status);
    let terminal = Terminal::new(script);
    let outcome = run_operator(executor, job, &machine, &machine, &terminal, &no_cancel());
    (outcome, terminal.opened.get() > 0)
}

#[test]
fn an_operator_step_is_refused_before_its_screen_as_execute_would_refuse_it() {
    let (_dir, _path, mut executor) = fresh();
    // A start a person already got going (status-first settles it).
    let start = job(JobPhase::Start);
    let (outcome, _) = operate(&mut executor, start.clone(), vec![Ok(true)], Vec::new());
    assert_eq!(outcome.expect("final").status, JobStatus::Succeeded);

    // The same step with another intent.
    let mut changed = start.clone();
    changed.intent_hash = "c".repeat(64);
    let (outcome, opened) = operate(&mut executor, changed, vec![Ok(false)], Vec::new());
    assert!(!opened);
    assert_eq!(
        outcome.expect("refused").error,
        Some(JobError::LaunchUnconfirmed)
    );

    // Another start of the instance that is already launched.
    let mut second = start.clone();
    second.step_id = "step-again".into();
    let (outcome, opened) = operate(&mut executor, second, vec![Ok(false)], Vec::new());
    assert!(!opened);
    assert_eq!(outcome.expect("refused").status, JobStatus::Failed);

    // Another instance identity while the old one runs.
    let mut moved = job(JobPhase::Prepare);
    moved.port = 30999;
    let (outcome, opened) = operate(&mut executor, moved, vec![Ok(false)], Vec::new());
    assert!(!opened);
    assert_eq!(outcome.expect("refused").status, JobStatus::Failed);
}

#[test]
fn a_run_that_failed_keeps_its_record_but_a_decline_leaves_none() {
    // Accepted, then the command failed: something may have run.
    let (_dir, path, mut executor) = fresh();
    let (outcome, opened) = operate(
        &mut executor,
        job(JobPhase::Start),
        vec![Ok(false)],
        vec![(NOW, OperatorEvent::Accepted), (NOW, OperatorEvent::Closed)],
    );
    assert!(opened);
    assert_eq!(outcome, None);
    let executor = Executor::load(path).expect("reload");
    let machine = Machine::new(vec![Ok(false)]);
    let observed = executor.observations(&machine, Deadline::new(Duration::from_secs(1)));
    assert_eq!(observed.len(), 1, "a later stop can tear down and prove");
    assert_eq!(observed[0].1.phase, InstancePhase::Unknown);

    // Declined before Enter: nothing ran, nothing is kept.
    let (_dir, path, mut executor) = fresh();
    let (outcome, _) = operate(
        &mut executor,
        job(JobPhase::Start),
        vec![Ok(false)],
        vec![(NOW, OperatorEvent::Closed)],
    );
    assert_eq!(outcome, None);
    let executor = Executor::load(path).expect("reload");
    assert!(
        executor
            .observations(&machine, Deadline::new(Duration::from_secs(1)))
            .is_empty()
    );
}

#[test]
fn wide_characters_count_two_columns_for_wrapping_and_the_scroll_note() {
    // 20 lines of 30 CJK characters: 60 columns each, two rows at 40 wide.
    let line = "漢".repeat(30);
    let tall = vec![line.as_str(); 20].join("\n");
    let rows = layout(&screen(&tall, CommandAuthor::User), 40, 30);
    assert!(
        rows.iter().all(|row| row
            .chars()
            .map(|ch| if ch.is_ascii() { 1 } else { 2 })
            .sum::<usize>()
            <= 40),
        "{rows:?}"
    );
    let n = rows.len();
    assert!(n > 30);
    // The note (wrapped at this width) sits right above the prompt.
    let bottom = rows[n - 4..].join(" ");
    assert!(bottom.contains("The command is 20 lines"), "{bottom}");
    assert!(bottom.contains("scroll up to read"), "{bottom}");
    assert!(rows[n - 1].starts_with("q to close") || rows[n - 2].starts_with("Press Enter"));
    // The same text in ASCII fits and needs no note.
    let ascii = vec!["x".repeat(30); 5].join("\n");
    let rows = layout(&screen(&ascii, CommandAuthor::User), 40, 30);
    assert!(!rows.join("\n").contains("scroll up"));
    // Emoji count as wide too.
    let rows = layout(&screen(&"🚀".repeat(40), CommandAuthor::User), 40, 30);
    assert!(rows.iter().filter(|row| row.contains('🚀')).count() >= 3);
}
