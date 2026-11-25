//! A terminal's processes: input that never blocks, and what ends with the terminal.

use super::*;
#[cfg(target_os = "linux")]
use crate::relay::sessions::children::{LIVE_CHILDREN, LiveChild, kill_live_children, reap_pid};
#[cfg(unix)]
use crate::relay::sessions::pty::RawFdHandle;
#[cfg(target_os = "linux")]
use crate::relay::sessions::{DEFAULT_COMMAND_MAX, ExecRegistry};
#[cfg(unix)]
use std::io::Write;
#[cfg(windows)]
use std::sync::mpsc;

#[cfg(unix)]
fn input_drops(frames: &[OutboundFrame]) -> Vec<Option<String>> {
    controls(frames)
        .into_iter()
        .filter_map(|message| match message {
            NodeFrame::TermInputDropped { viewer_id, .. } => Some(viewer_id.clone()),
            _ => None,
        })
        .collect()
}

#[test]
#[cfg(unix)]
fn a_large_paste_into_a_non_reading_pty_never_blocks_and_overflow_is_signalled() {
    let (tx, rx) = channel();
    // Raw mode without echo: the program never reads, so the PTY input
    // buffer fills and a blocking write would stall the caller.
    let mut terminals = TerminalRegistry::with_shell(
        tx,
        Duration::from_secs(60),
        "/bin/sh",
        &["-c", "stty raw -echo; printf wsmp-raw; sleep 600"],
    );
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let opened = open_viewer(&mut terminals, &startup, &mut a);
    a.receive(MULTI_TERMINAL, &opened);
    // Raw mode must be in force before any input: a canonical-mode line
    // discipline discards a long line instead of filling up.
    let expected = b"wsmp-raw";
    let mut output = Vec::new();
    while !output
        .windows(expected.len())
        .any(|window| window == expected)
    {
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(FromWorker::TerminalBytes { bytes, .. }) => output.extend(bytes),
            Ok(_) => {}
            Err(error) => panic!("the shell never entered raw mode: {error} {output:?}"),
        }
    }
    // Fill the PTY input buffer directly, before the writer thread gets any
    // input. The room left after `WouldBlock` (at most the line
    // discipline's buffer, which the kernel may still drain into) is
    // smaller than one chunk, so the writer can never finish a chunk and
    // the queue can never shrink during the paste: exactly one run of
    // drops, however the threads are scheduled.
    let chunk = vec![b'x'; 16 * 1024];
    {
        let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
        let raw = session
            .pty()
            .expect("pty")
            .master
            .as_raw_fd()
            .expect("master fd");
        // Shares the writer's O_NONBLOCK open file description.
        let mut master = filedescriptor::FileDescriptor::dup(&RawFdHandle(raw)).expect("dup");
        let mut filled = 0usize;
        loop {
            match master.write(&chunk[..1024]) {
                Ok(count) => filled += count,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => panic!("filling the pty failed: {error}"),
            }
            assert!(filled < 8 * 1024 * 1024, "the pty never filled up");
        }
    }
    let a_id = a.id.clone();
    let mut frames = Vec::new();
    // 2 MiB: far beyond the PTY buffer plus the 256 KiB queue.
    for _ in 0..128 {
        frames.extend(send(
            &mut terminals,
            &mut a,
            &a_id,
            &TermPlaintextV2::Data(chunk.clone()),
        ));
    }
    // The PTY stays full until the shell exits, so a blocking write could
    // only have returned once the shell was gone. Liveness, not speed:
    // a slow (debug, loaded) but non-blocking paste still passes.
    let shell_running = terminals
        .sessions
        .get_mut(MULTI_TERMINAL)
        .and_then(|session| session.pty_mut())
        .expect("pty")
        .child
        .try_wait()
        .expect("try_wait")
        .is_none();
    assert!(shell_running, "input handling waited for the shell to exit");
    // One signal per run of drops, addressed to the typing viewer.
    assert_eq!(input_drops(&frames), vec![Some(a_id.clone())]);
    assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
    // The registry still serves other work, such as a resize.
    let resized = send(
        &mut terminals,
        &mut a,
        &a_id,
        &TermPlaintextV2::Resize {
            cols: 100,
            rows: 30,
        },
    );
    assert_eq!(
        a.receive(MULTI_TERMINAL, &resized),
        vec![Seen::Size(100, 30)]
    );
    let started = Instant::now();
    let closed = terminals.close(MULTI_TERMINAL);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "close waited on the blocked writer for {:?}",
        started.elapsed()
    );
    assert!(matches!(controls(&closed)[0], NodeFrame::TermExit { .. }));
    drop(rx);
}

#[cfg(target_os = "linux")]
#[test]
fn closing_a_launch_guards_terminal_terminates_the_guard_and_lingers_until_it_ends() {
    use std::os::unix::fs::PermissionsExt;
    let _serial = crate::process::launch_guard::lingering_serial();
    let dir = tempfile::tempdir().expect("tempdir");
    let marker = |name: &str| dir.path().join(name);
    // Stands in for the guard (its first argument is the guard subcommand): it leaves a
    // helper in another group of its session, and on SIGTERM takes a while to end.
    let script = marker("guard");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\ntrap '' HUP INT QUIT\ntrap 'echo > \"{term}\"; sleep 0.5; exit 143' TERM\nset -m\n(trap '' HUP; exec sleep 120) &\necho $! > \"{helper}\"\nwhile :; do sleep 0.02; done\n",
            term = marker("term").display(),
            helper = marker("helper.pid").display(),
        ),
    )
    .expect("script");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let (tx, rx) = channel();
    let mut terminals = TerminalRegistry::with_shell(
        tx,
        Duration::from_secs(60),
        script.to_str().expect("path"),
        &[crate::process::launch_guard::SUBCOMMAND],
    );
    let startup = enabled_startup(false);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
    terminals.open(
        &startup,
        None,
        TermHandshake {
            terminal_id: "guard",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: None,
            shell: None,
        },
    );
    assert!(
        terminals
            .sessions
            .get("guard")
            .and_then(|session| session.pty())
            .is_some_and(|pty| pty.guarded)
    );
    let wait_for = |path: &Path| {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "{} was not written",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    wait_for(&marker("helper.pid"));
    std::thread::sleep(Duration::from_millis(50));
    let helper = std::fs::read_to_string(marker("helper.pid"))
        .expect("helper pid")
        .trim()
        .parse::<u32>()
        .expect("helper pid");
    assert!(!crate::process::launch_guard::lingering());
    let _ = terminals.close("guard");
    assert!(
        crate::process::launch_guard::lingering(),
        "the guard still ends its session"
    );
    wait_for(&marker("term"));
    // The session is the guard's to end: close killed nothing in it.
    assert!(process_running(helper), "close killed the guard's session");
    let deadline = Instant::now() + Duration::from_secs(5);
    while crate::process::launch_guard::lingering() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !crate::process::launch_guard::lingering(),
        "the guard exited"
    );
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(helper).expect("pid")),
        nix::sys::signal::Signal::SIGKILL,
    );
    drop(terminals);
    drop(rx);
}

#[cfg(target_os = "linux")]
#[test]
fn closing_a_terminal_kills_background_and_nohup_jobs_in_its_session() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bg_file = dir.path().join("bg.pid");
    let nohup_file = dir.path().join("nohup.pid");
    // `set -m` puts each background job in its own process group, so a
    // process-group kill of the shell alone would miss both.
    let script = format!(
        "set -m; sleep 120 & echo $! > '{}'; nohup sleep 120 >/dev/null 2>&1 & echo $! > '{}'; wait",
        bg_file.display(),
        nohup_file.display()
    );
    let (tx, rx) = channel();
    let mut terminals =
        TerminalRegistry::with_shell(tx, Duration::from_secs(60), "/bin/sh", &["-c", &script]);
    let startup = enabled_startup(false);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
    terminals.open(
        &startup,
        None,
        TermHandshake {
            terminal_id: "jobs",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: None,
            shell: None,
        },
    );
    let shell = terminals
        .sessions
        .get("jobs")
        .and_then(|session| session.pty())
        .and_then(|pty| pty.pid)
        .expect("shell pid");
    let read_pid = |path: &Path| {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(text) = std::fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse::<u32>()
                && pid > 1
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "job pid was not written");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let bg = read_pid(&bg_file);
    let nohup = read_pid(&nohup_file);
    let shell_group = nix::unistd::Pid::from_raw(i32::try_from(shell).expect("pid"));
    for job in [bg, nohup] {
        let job_pid = nix::unistd::Pid::from_raw(i32::try_from(job).expect("pid"));
        assert!(process_running(job), "job {job} is not running");
        assert_eq!(nix::unistd::getsid(Some(job_pid)), Ok(shell_group));
        assert_ne!(
            nix::unistd::getpgid(Some(job_pid)),
            Ok(shell_group),
            "job {job} shares the shell's process group"
        );
    }
    let _ = terminals.close("jobs");
    let deadline = Instant::now() + Duration::from_secs(2);
    while (process_running(bg) || process_running(nohup)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!process_running(bg), "background job {bg} survived close");
    assert!(!process_running(nohup), "nohup job {nohup} survived close");
    drop(terminals);
    drop(rx);
}

#[test]
#[cfg(unix)]
fn a_shell_exit_closes_the_terminal_while_a_disowned_job_holds_the_pty() {
    let dir = tempfile::tempdir().expect("tempdir");
    let job_file = dir.path().join("job.pid");
    // The non-interactive form of `sleep 120 & disown; exit`: `set -m`
    // puts the job in its own background process group, so the kernel's
    // hangup on the leader's exit misses it, and its stdout keeps the PTY
    // open after the shell has gone.
    let script = format!(
        "set -m; sleep 120 & echo $! > '{}'; printf wsmp-bye; exit 0",
        job_file.display()
    );
    let (tx, rx) = channel();
    let mut terminals =
        TerminalRegistry::with_shell(tx, Duration::from_secs(60), "/bin/sh", &["-c", &script]);
    let startup = enabled_startup(false);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
    let opened = terminals.open(
        &startup,
        None,
        TermHandshake {
            terminal_id: "exited",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: None,
            shell: None,
        },
    );
    assert!(matches!(
        &opened[0],
        OutboundFrame::Control(NodeFrame::TermOpened { .. })
    ));
    let started = Instant::now();
    let deadline = started + Duration::from_secs(10);
    let mut output = Vec::new();
    let mut sealed_output = false;
    let mut exit = None;
    // Drive the registry the way the relay loop does: drain worker
    // output, then poll.
    while exit.is_none() && Instant::now() < deadline {
        let mut frames = Vec::new();
        while let Ok(note) = rx.try_recv() {
            match note {
                FromWorker::TerminalBytes { terminal_id, bytes } => {
                    output.extend_from_slice(&bytes);
                    frames.extend(terminals.on_bytes(&terminal_id, &bytes));
                }
                FromWorker::TerminalEof { terminal_id } => {
                    frames.extend(terminals.on_eof(&terminal_id));
                }
                _ => {}
            }
        }
        frames.extend(terminals.poll(Instant::now()));
        for frame in frames {
            match frame {
                OutboundFrame::Binary(..) if exit.is_none() => sealed_output = true,
                OutboundFrame::Control(NodeFrame::TermExit {
                    terminal_id,
                    exit_code,
                    signal,
                }) => {
                    assert_eq!(terminal_id, "exited");
                    exit = Some((exit_code, signal));
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        exit,
        Some((Some(0), None)),
        "the terminal did not close with the shell's status within {:?}",
        started.elapsed()
    );
    assert!(
        output.windows(8).any(|window| window == b"wsmp-bye"),
        "output written before exit was lost: {output:?}"
    );
    assert!(
        sealed_output,
        "no output reached the viewer before term.exit"
    );
    assert!(terminals.sessions.is_empty(), "the terminal kept its slot");

    let text = std::fs::read_to_string(&job_file).expect("job pid");
    let job = text.trim().parse::<u32>().expect("job pid");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !process_gone(job) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(process_gone(job), "disowned job {job} survived the close");
    drop(terminals);
    drop(rx);
}

#[cfg(target_os = "linux")]
#[test]
fn forced_shutdown_kills_tracked_terminal_sessions_and_exec_groups() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bg_file = dir.path().join("bg.pid");
    let exec_file = dir.path().join("exec.pid");
    let script = format!(
        "set -m; sleep 120 & echo $! > '{}'; wait",
        bg_file.display()
    );
    let (tx, rx) = channel();
    let mut terminals = TerminalRegistry::with_shell(
        tx.clone(),
        Duration::from_secs(60),
        "/bin/sh",
        &["-c", &script],
    );
    let startup = enabled_startup(false);
    let browser = CliTerminalKey::generate().expect("browser");
    let nonce = terminal_crypto::encode_b64url(&[9_u8; 16]);
    terminals.open(
        &startup,
        None,
        TermHandshake {
            terminal_id: "forced",
            viewer_id: Some("viewer-a"),
            cols: 80,
            rows: 24,
            browser_public_key: browser.public_b64url(),
            browser_nonce: &nonce,
            identity: None,
            shell: None,
        },
    );
    let shell = terminals
        .sessions
        .get("forced")
        .and_then(|session| session.pty())
        .and_then(|pty| pty.pid)
        .expect("shell pid");
    let mut execs = ExecRegistry::new(tx, DEFAULT_COMMAND_MAX);
    execs.start_text(
        &startup,
        "forced",
        &format!("sleep 120 & echo $! > '{}'; wait", exec_file.display()),
        Some(dir.path().to_str().expect("utf8")),
        TEST_TIMEOUT_MS,
    );
    let exec = execs.pid("forced").expect("exec pid");
    let read_pid = |path: &Path| {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(text) = std::fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse::<u32>()
                && pid > 1
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "pid was not written");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let bg = read_pid(&bg_file);
    let exec_grandchild = read_pid(&exec_file);
    let ours = [
        LiveChild::PtySession(crate::process::process_list::Process::of(shell)),
        LiveChild::ExecGroup(exec),
    ];
    {
        let live = LIVE_CHILDREN.lock().expect("live children");
        assert!(ours.iter().all(|child| live.values().any(|v| v == child)));
    }

    // Only this test's children: other tests run in parallel.
    kill_live_children(|child| ours.contains(child));
    let deadline = Instant::now() + Duration::from_secs(2);
    while [shell, bg, exec, exec_grandchild]
        .iter()
        .any(|pid| process_running(*pid))
        && Instant::now() < deadline
    {
        // The direct children are ours to reap.
        let _ = reap_pid(Some(shell));
        let _ = reap_pid(Some(exec));
        std::thread::sleep(Duration::from_millis(20));
    }
    for pid in [shell, bg, exec, exec_grandchild] {
        assert!(
            !process_running(pid),
            "process {pid} survived a forced shutdown"
        );
    }

    let _ = terminals.kill_all();
    let _ = execs.kill_all();
    let live = LIVE_CHILDREN.lock().expect("live children");
    assert!(
        ours.iter().all(|child| live.values().all(|v| v != child)),
        "closed sessions leave the forced-shutdown list"
    );
    drop(live);
    drop(rx);
}

/// Feeds worker notes and polls until `terminal_id` exits or `limit`
/// passes, collecting what viewer `a` reads. Returns the exit code
/// (`None` inside: no code was reported) and the output.
#[cfg(windows)]
fn run_until_exit(
    terminals: &mut TerminalRegistry,
    rx: &mpsc::Receiver<FromWorker>,
    viewer: &mut TestViewer,
    limit: Duration,
    mut on_output: impl FnMut(&mut TerminalRegistry, &mut TestViewer, &str),
) -> (Option<Option<u8>>, String) {
    let deadline = Instant::now() + limit;
    let mut output = Vec::new();
    while Instant::now() < deadline {
        let mut frames = Vec::new();
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(FromWorker::TerminalBytes { terminal_id, bytes }) => {
                frames.extend(terminals.on_bytes(&terminal_id, &bytes));
            }
            Ok(FromWorker::TerminalEof { terminal_id }) => {
                frames.extend(terminals.on_eof(&terminal_id));
            }
            _ => {}
        }
        frames.extend(terminals.poll(Instant::now()));
        for seen in viewer.receive(MULTI_TERMINAL, &frames) {
            if let Seen::Data(bytes) = seen {
                output.extend(bytes);
            }
        }
        let text = String::from_utf8_lossy(&output).into_owned();
        for frame in controls(&frames) {
            if let NodeFrame::TermExit { exit_code, .. } = frame {
                return (Some(*exit_code), text);
            }
        }
        on_output(terminals, viewer, &text);
    }
    (None, String::from_utf8_lossy(&output).into_owned())
}

/// A Windows terminal end to end: the shell runs on a real pseudoconsole
/// through the `__conpty-host` helper, typed input and resizes reach it,
/// and its exit code is reported when it exits.
#[cfg(windows)]
#[test]
fn a_windows_terminal_runs_the_shell_and_reports_its_exit_code() {
    let (tx, rx) = channel();
    let mut terminals =
        TerminalRegistry::with_shell(tx, Duration::from_secs(60), "cmd.exe", &["/D", "/Q", "/K"]);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let opened = open_viewer(&mut terminals, &startup, &mut a);
    a.receive(MULTI_TERMINAL, &opened);
    let label = a.id.clone();
    send(
        &mut terminals,
        &mut a,
        &label,
        &TermPlaintextV2::Resize {
            cols: 100,
            rows: 30,
        },
    );
    assert_eq!(pty_size(&terminals), (100, 30));
    // `%OS%` comes from the scrubbed environment; the echoed command
    // line itself does not contain the expanded text.
    send(
        &mut terminals,
        &mut a,
        &label,
        &TermPlaintextV2::Data(b"echo wsmp-%OS%-ok\r".to_vec()),
    );
    let mut typed_exit = false;
    let (exit, output) = run_until_exit(
        &mut terminals,
        &rx,
        &mut a,
        Duration::from_secs(30),
        |terminals, viewer, text| {
            if !typed_exit && text.contains("wsmp-Windows_NT-ok") {
                typed_exit = true;
                send(
                    terminals,
                    viewer,
                    &label,
                    &TermPlaintextV2::Data(b"exit 7\r".to_vec()),
                );
            }
        },
    );
    assert!(typed_exit, "the shell never ran the input: {output:?}");
    assert_eq!(exit, Some(Some(7)), "{output:?}");
    assert!(terminals.sessions.is_empty());
}

/// Closing a Windows terminal, or its shell exiting, ends everything the
/// shell started, even a detached process that left the console.
#[cfg(windows)]
#[test]
fn a_windows_terminal_ends_what_its_shell_started() {
    use crate::windows_test_tree::{Tree, assert_dead};
    // `detach-exit`: the shell exits after starting a detached process,
    // which closing the console alone would not end.
    for mode in ["detach", "detach-exit"] {
        let tree = Tree::new();
        let (tx, rx) = channel();
        let args = tree.command(mode);
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        let mut terminals =
            TerminalRegistry::with_shell(tx, Duration::from_secs(60), "cmd.exe", &args);
        let startup = enabled_startup(false);
        let mut a = TestViewer::new(1);
        let opened = open_viewer(&mut terminals, &startup, &mut a);
        a.receive(MULTI_TERMINAL, &opened);
        let grandchild = tree.read_marker().parse().expect("grandchild PID");
        assert!(process_exists(grandchild), "{mode}: grandchild not running");
        if mode == "detach" {
            // The shell is still running: a close from the browser.
            let frames = terminals.close(MULTI_TERMINAL);
            assert!(
                controls(&frames)
                    .iter()
                    .any(|frame| matches!(frame, NodeFrame::TermExit { .. }))
            );
        } else {
            // The shell exited on its own; the terminal closes itself.
            let (exit, output) = run_until_exit(
                &mut terminals,
                &rx,
                &mut a,
                Duration::from_secs(30),
                |_, _, _| {},
            );
            assert_eq!(exit, Some(Some(0)), "{output:?}");
        }
        assert_dead(grandchild);
    }
}
