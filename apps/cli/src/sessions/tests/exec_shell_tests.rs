//! `exec.start` with a shell or an argv: what reaches the program is exactly what was sent.
use super::*;

/// A command id no other test in this process uses (a PowerShell command's script is named by it).
fn fresh_id() -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    format!("shell-exec-{}", NEXT.fetch_add(1, Ordering::SeqCst))
}

/// Run `line` in `shell` to the end and return its state and whole output.
fn run(line: &ExecLine<'_>, shell: Option<CommandShell>) -> (ExecState, String) {
    let (tx, rx) = channel();
    // PowerShell can take many seconds to start on a loaded machine: the lifetime must not end it.
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(120));
    // Scripts of this run only, so what is left in the folder is this command's.
    let scripts = tempfile::tempdir().expect("scripts");
    execs.scripts = scripts.path().to_path_buf();
    let id = fresh_id();
    let started = execs.start(
        &enabled_startup(false),
        &id,
        line,
        shell,
        None,
        TEST_TIMEOUT_MS,
    );
    assert!(
        matches!(controls(&started)[0], NodeFrame::ExecStarted { .. }),
        "{:?}",
        controls(&started)
    );
    let deadline = Instant::now() + Duration::from_secs(120);
    while !execs.sessions.is_empty() {
        assert!(Instant::now() < deadline, "command did not complete");
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(FromWorker::ExecBytes {
                command_id,
                stderr,
                bytes,
            }) => execs.on_bytes(&command_id, stderr, &bytes),
            Ok(FromWorker::ExecEof { command_id, stderr }) => execs.on_eof(&command_id, stderr),
            _ => {}
        }
        let _ = execs.poll(Instant::now());
    }
    // A PowerShell command's script goes with it.
    let left: Vec<_> = std::fs::read_dir(scripts.path())
        .expect("scripts")
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    assert!(left.is_empty(), "{left:?}");
    match execs.status(&id, NODE_COMMAND_TAIL_MAX_BYTES).pop() {
        Some(OutboundFrame::Control(NodeFrame::ExecStatus(status))) => {
            (status.state, status.tail.unwrap_or_default())
        }
        _ => panic!("expected an exec.status frame"),
    }
}

fn rejection(line: &ExecLine<'_>, shell: Option<CommandShell>) -> String {
    let (tx, _rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    let frames = execs.start(
        &enabled_startup(false),
        &fresh_id(),
        line,
        shell,
        None,
        TEST_TIMEOUT_MS,
    );
    match controls(&frames).as_slice() {
        [NodeFrame::ExecRejected { reason, .. }] => reason.clone(),
        other => panic!("expected a rejection, got {other:?}"),
    }
}

/// Quotes, a pipe and `%NAME%` that no shell may read.
const LITERAL: &str = "a \"b c\" | %WSMP_NOT_SET% $HOME";

#[test]
fn an_argv_reaches_the_program_exactly() {
    let argv = if cfg!(windows) {
        // Not an `.exe`: it runs in PowerShell, quoted for it.
        vec![
            "Write-Output".to_string(),
            "a 'b c' | %WSMP_NOT_SET%".to_string(),
        ]
    } else {
        vec![
            "printf".to_string(),
            "%s\\n".to_string(),
            LITERAL.to_string(),
        ]
    };
    let (state, output) = run(&ExecLine::Argv(&argv), None);
    assert_eq!(state, ExecState::Succeeded, "{output}");
    assert_eq!(
        output.trim_end(),
        argv.last().map(String::as_str).unwrap_or("")
    );
}

#[test]
fn an_argv_reports_its_program_s_exit_code() {
    let argv: &[&str] = if cfg!(windows) {
        &[
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "exit 7",
        ]
    } else {
        &["sh", "-c", "exit 7"]
    };
    let argv: Vec<String> = argv.iter().map(|arg| (*arg).to_string()).collect();
    let (state, _) = run(&ExecLine::Argv(&argv), None);
    assert_eq!(state, ExecState::Failed);
}

#[cfg(not(windows))]
#[test]
fn only_sh_runs_commands_on_unix() {
    let (state, output) = run(
        &ExecLine::Text("echo \"$((1 + 2))\""),
        Some(CommandShell::Sh),
    );
    assert_eq!((state, output.trim_end()), (ExecState::Succeeded, "3"));
    for shell in [
        CommandShell::Pwsh,
        CommandShell::Powershell,
        CommandShell::Cmd,
    ] {
        assert_eq!(
            rejection(&ExecLine::Text("echo hi"), Some(shell)),
            REASON_SHELL_UNAVAILABLE
        );
    }
}

#[cfg(windows)]
#[test]
fn cmd_gets_the_text_as_written() {
    // std would hand cmd `\"b c\"`: cmd reads the text between its outer quotes as is.
    let (state, output) = run(
        &ExecLine::Text("echo \"b c\" ^| x"),
        Some(CommandShell::Cmd),
    );
    assert_eq!(
        (state, output.trim_end()),
        (ExecState::Succeeded, "\"b c\" | x")
    );
    let (state, _) = run(&ExecLine::Text("exit /b 3"), Some(CommandShell::Cmd));
    assert_eq!(state, ExecState::Failed);
}

#[cfg(windows)]
#[test]
fn powershell_runs_text_with_its_own_quoting_and_variables() {
    for shell in
        crate::shells::command_shells()
            .iter()
            .filter_map(|found| match found.id.as_str() {
                "pwsh" => Some(CommandShell::Pwsh),
                "powershell" => Some(CommandShell::Powershell),
                _ => None,
            })
    {
        let script = format!(
            "$r = 'set'; Write-Output \"$r\"; Write-Output '{}' | ForEach-Object {{ $_ }}",
            LITERAL.replace('\'', "''")
        );
        let (state, output) = run(&ExecLine::Text(&script), Some(shell));
        assert_eq!(state, ExecState::Succeeded, "{shell:?}: {output}");
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines, ["set", LITERAL], "{shell:?}");
        // A native program's exit code is the command's.
        let (state, output) = run(&ExecLine::Text("cmd /c exit 4"), Some(shell));
        assert_eq!(state, ExecState::Failed, "{shell:?}: {output}");
        // Errors and warnings are text, not CLIXML.
        let (state, output) = run(
            &ExecLine::Text("Write-Warning 'careful'; Write-Error 'boom'"),
            Some(shell),
        );
        assert_eq!(state, ExecState::Failed, "{shell:?}: {output}");
        assert!(
            output.contains("careful") && output.contains("boom") && !output.contains("CLIXML"),
            "{shell:?}: {output}"
        );
    }
}

#[cfg(windows)]
#[test]
fn a_cmd_shim_gets_its_arguments_past_cmd_s_second_parse() {
    // npm, npx and pnpm are such shims: cmd would read `&`, `%NAME%` and `^` in their arguments.
    let dir = tempfile::tempdir().expect("dir");
    let shim = dir.path().join("echo-args.cmd");
    std::fs::write(&shim, "@echo off\r\necho(%1\r\necho(%2\r\necho(%3\r\n").expect("shim");
    let argv = vec![
        shim.to_string_lossy().into_owned(),
        "a&b".to_string(),
        "%PATH%".to_string(),
        "x^y z".to_string(),
    ];
    let (state, output) = run(&ExecLine::Argv(&argv), None);
    assert_eq!(state, ExecState::Succeeded, "{output}");
    let lines: Vec<&str> = output.lines().collect();
    assert_eq!(lines, ["\"a&b\"", "\"%PATH%\"", "\"x^y z\""], "{output}");
    // One cmd cannot be handed safely is refused before anything runs.
    let unsafe_argv = vec![shim.to_string_lossy().into_owned(), "a\nb".to_string()];
    assert_eq!(
        rejection(&ExecLine::Argv(&unsafe_argv), None),
        REASON_SPAWN_FAILED
    );
}

#[cfg(windows)]
#[test]
fn text_without_a_shell_runs_in_powershell_on_windows() {
    let (state, output) = run(&ExecLine::Text("$PSVersionTable.PSEdition"), None);
    assert_eq!(state, ExecState::Succeeded, "{output}");
    assert!(matches!(output.trim_end(), "Core" | "Desktop"), "{output}");
}

#[cfg(windows)]
#[test]
fn powershell_writes_utf8_in_a_console_with_the_oem_code_page() {
    use std::io::Read;
    // `spawn_hidden`, as commands start: a console of their own, in the system's OEM code page
    // (not the test terminal's, which may well be UTF-8 already).
    let scripts = tempfile::tempdir().expect("scripts");
    for shell in
        crate::shells::command_shells()
            .iter()
            .filter_map(|found| match found.id.as_str() {
                "pwsh" => Some(CommandShell::Pwsh),
                "powershell" => Some(CommandShell::Powershell),
                _ => None,
            })
    {
        let ExecProcess {
            mut process,
            script: _script,
        } = exec_process(
            &ExecLine::Text("Write-Output '\u{e9}t\u{e9} \u{2713}'; cmd /c echo \u{e9}t\u{e9}"),
            Some(shell),
            scripts.path(),
        )
        .expect("process");
        process
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped());
        let mut child = crate::job_tree::spawn_hidden(process).expect("spawned");
        let mut stdout = Vec::new();
        child
            .stdout
            .take()
            .expect("stdout")
            .read_to_end(&mut stdout)
            .expect("read");
        child.wait().expect("exited");
        let text = String::from_utf8(stdout.clone())
            .unwrap_or_else(|_| panic!("{shell:?} wrote non-UTF-8: {stdout:?}"));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            ["\u{e9}t\u{e9} \u{2713}", "\u{e9}t\u{e9}"],
            "{shell:?}"
        );
    }
}

#[cfg(windows)]
#[test]
fn an_argv_cannot_run_in_sh_on_windows() {
    let argv = vec!["whoami".to_string()];
    assert_eq!(
        rejection(&ExecLine::Argv(&argv), Some(CommandShell::Sh)),
        REASON_SHELL_UNAVAILABLE
    );
}

#[test]
fn a_restarted_daemon_removes_the_scripts_a_crash_left() {
    let dir = tempfile::tempdir().expect("dir");
    let scripts = dir.path().join("exec-scripts");
    std::fs::create_dir_all(&scripts).expect("scripts");
    std::fs::write(scripts.join("left-1.ps1"), "Write-Output token").expect("left");
    std::fs::write(scripts.join("keep.txt"), "not a script").expect("other");
    let (tx, _rx) = channel();
    let (execs, _) = ExecRegistry::new(tx, Duration::from_secs(20))
        .with_table(dir.path().join("node-commands.json"));
    assert_eq!(execs.scripts, scripts);
    assert!(!scripts.join("left-1.ps1").exists());
    assert!(scripts.join("keep.txt").exists());
}

#[cfg(windows)]
#[test]
fn a_script_that_cannot_be_written_is_a_failed_start_not_a_missing_shell() {
    let dir = tempfile::tempdir().expect("dir");
    // A file where the script folder should be.
    let blocked = dir.path().join("scripts");
    std::fs::write(&blocked, "not a folder").expect("file");
    let (tx, _rx) = channel();
    let mut execs = ExecRegistry::new(tx, Duration::from_secs(20));
    execs.scripts = blocked;
    let frames = execs.start(
        &enabled_startup(false),
        &fresh_id(),
        &ExecLine::Text("Write-Output hi"),
        None,
        None,
        TEST_TIMEOUT_MS,
    );
    assert!(
        matches!(controls(&frames).as_slice(), [NodeFrame::ExecRejected { reason, .. }] if reason == REASON_SPAWN_FAILED),
        "{:?}",
        controls(&frames)
    );
}

#[test]
fn an_argv_without_a_program_is_refused() {
    let argv = vec![" ".to_string(), "x".to_string()];
    assert_eq!(rejection(&ExecLine::Argv(&argv), None), REASON_BAD_COMMAND);
}
