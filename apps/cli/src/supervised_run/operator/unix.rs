//! The Unix side of the operator confirm child: read the request the daemon
//! handed over, run the confirm/retry cycle and the command itself.
//!
//! The cycle is the marker grammar `ready -> accepted -> exited;<code>`
//! (see `sessions::supervised_pty::MarkerScanner::operator`): the shared
//! confirm mechanics emit `ready` and `accepted` and wait for the daemon's
//! `go`; this child then runs `sh -c <command>` in the same terminal and
//! emits `exited;<code>`. Exit 0 ends the child. Any other code is shown and
//! the screen is drawn again for a retry (a new `ready`). Closing (`q`,
//! Ctrl-C, Ctrl-D) ends it without running anything more. It never runs a
//! shell of its own.

use anyhow::{Context, Result};

use super::{OperatorRequest, layout};
use crate::sessions::{
    SUPERVISED_ENV_MARKER, SUPERVISED_ENV_NAMES, SUPERVISED_ENV_OPERATOR, supervised_marker,
};
use crate::supervised_screen::{ConfirmAction, ConfirmOutcome, interact, wait_for_any_key};

fn required_env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| {
        format!(
            "`{name}` is not set; `wsmp terminal supervised-run --deployment` is started by the relay daemon"
        )
    })
}

/// The request and marker from the daemon's env, checked before anything is
/// drawn.
fn request_from_env() -> Result<(OperatorRequest, String)> {
    let marker = required_env(SUPERVISED_ENV_MARKER)?;
    if marker.len() != 32 || !marker.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("`{SUPERVISED_ENV_MARKER}` is malformed");
    }
    let request = parse_request(&required_env(SUPERVISED_ENV_OPERATOR)?)?;
    Ok((request, marker))
}

fn parse_request(json: &str) -> Result<OperatorRequest> {
    let request: OperatorRequest = serde_json::from_str(json)
        .with_context(|| format!("`{SUPERVISED_ENV_OPERATOR}` is malformed"))?;
    request.validate()?;
    Ok(request)
}

/// The code `exited;<code>` reports: the exit status, or 128 + the signal
/// that ended the command, as a shell reports it.
fn exit_code(status: std::process::ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt;
    let code = status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(255);
    u8::try_from(code.clamp(0, 255)).unwrap_or(255)
}

/// `/bin/sh -c <command>` (as non-interactive deployment commands run)
/// without the daemon's env names.
fn shell_command(command: &str) -> std::process::Command {
    let mut process = std::process::Command::new("/bin/sh");
    process.arg("-c").arg(command);
    for name in SUPERVISED_ENV_NAMES {
        process.env_remove(name);
    }
    process
}

/// Runs the confirmed command in this terminal and returns its exit code.
/// The daemon's env names are removed from its env; this process's own env
/// (which still holds the marker) is hidden by [`hide_own_env`] on Linux. A
/// command that cannot start reports 127, like a shell.
fn run_command(command: &str) -> u8 {
    let mut process = shell_command(command);
    // std resets the signal mask in the child, so the command gets Ctrl-C
    // and Ctrl-\ normally while this process (which blocks them) survives
    // to report the exit and offer a retry.
    match process.status() {
        Ok(status) => exit_code(status),
        Err(error) => {
            let _ = crate::output::diagnostic(format!("wsmp: could not run the command: {error}"));
            127
        }
    }
}

/// Ctrl-C and Ctrl-\ typed while the command runs reach the whole foreground
/// process group. Blocked here (never unblocked), they end only the command.
/// The confirm screen reads keys in raw mode, where they are plain bytes.
fn block_terminal_signals() -> Result<()> {
    use nix::sys::signal::{SigSet, Signal};
    let mut signals = SigSet::empty();
    signals.add(Signal::SIGINT);
    signals.add(Signal::SIGQUIT);
    signals.thread_block().context("blocking terminal signals")
}

/// Keeps the command (same uid) from reading this process's initial env,
/// which holds the marker and the request, through `/proc/<pid>/environ`
/// or ptrace: a non-dumpable process needs `CAP_SYS_PTRACE` for both. The
/// command execs and is dumpable again. Elsewhere (macOS exposes same-uid
/// env through `KERN_PROCARGS2`) the daemon must not pass the marker in env.
fn hide_own_env() -> Result<()> {
    #[cfg(target_os = "linux")]
    nix::sys::prctl::set_dumpable(false).context("hiding the marker from the command")?;
    Ok(())
}

/// Puts back sane terminal output state before this child draws: whatever
/// the command (or output it printed) left behind, such as concealed text,
/// another character set, a scroll region or no autowrap, must not hide or
/// garble the screen. Soft reset, SGR reset, ASCII set, full scroll region,
/// autowrap on, cursor visible.
const TERMINAL_RESET: &[u8] = b"\x1b[!p\x1b[0m\x1b(B\x1b[r\x1b[?7h\x1b[?25h";

fn reset_terminal() {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    let _ = stdout
        .write_all(TERMINAL_RESET)
        .and_then(|()| stdout.flush());
}

/// Restores the terminal settings this child started with (the command may
/// have left `-echo`, raw mode or others), so every confirm screen and every
/// run starts from them.
fn restore_settings(original: &nix::sys::termios::Termios) {
    let _ = nix::sys::termios::tcsetattr(
        std::io::stdin(),
        nix::sys::termios::SetArg::TCSANOW,
        original,
    );
}

pub fn run() -> Result<()> {
    use std::io::Write;

    hide_own_env()?;
    let (request, marker) = request_from_env()?;
    block_terminal_signals()?;
    let settings =
        nix::sys::termios::tcgetattr(std::io::stdin()).context("reading terminal settings")?;
    let mut last_exit = None;
    loop {
        restore_settings(&settings);
        reset_terminal();
        match interact(&marker, ConfirmAction::Apply, |cols, rows, offset| {
            layout(&request, last_exit, cols, rows, offset)
        })? {
            ConfirmOutcome::Accepted => {}
            ConfirmOutcome::Declined => return Ok(()),
            ConfirmOutcome::Dismissed => {
                anyhow::bail!("operator screen returned a blocked outcome")
            }
        }
        restore_settings(&settings);
        let code = run_command(&request.command);
        restore_settings(&settings);
        reset_terminal();
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(&supervised_marker(&format!("exited;{code}"), &marker))
            .and_then(|()| stdout.flush())
            .context("reporting the command's exit")?;
        if code == 0 {
            let _ = stdout.write_all(
                b"\r\nThe command succeeded. WS Model Proxy checks the service next.\r\n",
            );
            let _ = stdout.flush();
            return Ok(());
        }
        drop(stdout);
        let message =
            format!("\r\nThe command exited with code {code}. Press any key to continue.\r\n");
        if !wait_for_any_key(&message)? {
            anyhow::bail!("terminal closed after the command failed");
        }
        last_exit = Some(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervised_run::operator::tests::request;

    #[test]
    fn the_request_env_is_strict_json_and_validated() {
        let req = request("sudo systemctl start vllm");
        let json = serde_json::to_string(&req).expect("json");
        assert_eq!(parse_request(&json).expect("parse"), req);
        assert!(parse_request("{}").is_err());
        assert!(parse_request("not json").is_err());
        let mut status = req.clone();
        status.action = crate::deployments::Action::Status;
        let error = parse_request(&serde_json::to_string(&status).expect("json"))
            .expect_err("status is never interactive");
        assert!(
            error.to_string().contains("cannot be interactive"),
            "{error}"
        );
    }

    #[test]
    fn exit_codes_follow_the_shell_convention() {
        let status = |script: &str| {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .status()
                .expect("sh runs")
        };
        assert_eq!(exit_code(status("exit 0")), 0);
        assert_eq!(exit_code(status("exit 3")), 3);
        assert_eq!(exit_code(status("exit 255")), 255);
        // Killed by SIGTERM (15): 128 + 15.
        assert_eq!(exit_code(status("kill -TERM $$")), 143);
        assert_eq!(run_command("exit 7"), 7);
    }

    #[test]
    fn the_command_does_not_see_the_daemon_env() {
        let process = shell_command("true");
        assert_eq!(process.get_program(), "/bin/sh");
        assert_eq!(
            process.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("-c"), std::ffi::OsStr::new("true")]
        );
        let removed = process
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for name in SUPERVISED_ENV_NAMES {
            assert!(removed.iter().any(|removed| removed == name), "{name}");
        }
        assert!(SUPERVISED_ENV_NAMES.contains(&SUPERVISED_ENV_OPERATOR));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_command_starts_with_no_blocked_signals() {
        // Run on a fresh thread: the block applies to that thread only.
        let blocked = std::thread::spawn(|| {
            block_terminal_signals().expect("block");
            let output = std::process::Command::new("sh")
                .arg("-c")
                .arg("grep '^SigBlk:' /proc/self/status")
                .output()
                .expect("sh");
            String::from_utf8(output.stdout).expect("utf8")
        })
        .join()
        .expect("thread");
        let mask = blocked
            .trim()
            .strip_prefix("SigBlk:")
            .expect("SigBlk line")
            .trim();
        assert!(mask.bytes().all(|byte| byte == b'0'), "{mask}");
    }
}
