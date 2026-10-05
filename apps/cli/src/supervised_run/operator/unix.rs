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
    SUPERVISED_ENV_MARKER_FILE, SUPERVISED_ENV_NAMES, SUPERVISED_ENV_OPERATOR, supervised_marker,
};
use crate::supervised_screen::{ConfirmAction, ConfirmOutcome, interact, wait_for_any_key};

fn required_env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| {
        format!(
            "`{name}` is not set; `wsmp terminal supervised-run --deployment` is started by the relay daemon"
        )
    })
}

/// The request (env) and marker (a private file the daemon wrote), checked
/// before anything is drawn. The marker file is removed here, before any
/// command can run, so the command can read the marker neither from this
/// process's env (on any platform) nor from the file.
fn request_from_env() -> Result<(OperatorRequest, String)> {
    let path = required_env(SUPERVISED_ENV_MARKER_FILE)?;
    let marker = take_marker(std::path::Path::new(&path))?;
    let request = parse_request(&required_env(SUPERVISED_ENV_OPERATOR)?)?;
    Ok((request, marker))
}

/// Reads and removes the marker file: exactly 32 hex characters. Fails
/// closed when it cannot be removed.
fn take_marker(path: &std::path::Path) -> Result<String> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut marker = String::new();
    options
        .open(path)
        .and_then(|file| file.take(64).read_to_string(&mut marker))
        .with_context(|| format!("reading `{SUPERVISED_ENV_MARKER_FILE}`"))?;
    std::fs::remove_file(path)
        .with_context(|| format!("removing `{SUPERVISED_ENV_MARKER_FILE}`"))?;
    if marker.len() != 32 || !marker.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("`{SUPERVISED_ENV_MARKER_FILE}` is malformed");
    }
    Ok(marker)
}

fn parse_request(json: &str) -> Result<OperatorRequest> {
    let request: OperatorRequest = serde_json::from_str(json)
        .with_context(|| format!("`{SUPERVISED_ENV_OPERATOR}` is malformed"))?;
    request.validate()?;
    Ok(request)
}

/// The code `exited;<code>` reports: the exit status, or 128 + the signal
/// that ended the command, as a shell reports it.
fn exit_code(status: nix::sys::wait::WaitStatus) -> u8 {
    use nix::sys::wait::WaitStatus;
    let code = match status {
        WaitStatus::Exited(_, code) => code,
        WaitStatus::Signaled(_, signal, _) => 128 + signal as i32,
        _ => 255,
    };
    u8::try_from(code.clamp(0, 255)).unwrap_or(255)
}

/// The shell non-interactive deployment commands run in: `/bin/sh -c`.
const SHELL: &std::ffi::CStr = c"/bin/sh";

fn shell_args(command: &str) -> Result<Vec<std::ffi::CString>> {
    Ok(vec![
        c"sh".to_owned(),
        c"-c".to_owned(),
        std::ffi::CString::new(command).context("the command contains a NUL byte")?,
    ])
}

/// This process's env without the daemon's env names, as `NAME=value`.
fn command_env() -> Vec<std::ffi::CString> {
    env_without_daemon_names(std::env::vars_os())
}

fn env_without_daemon_names(
    vars: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    vars.filter(|(name, _)| {
        !SUPERVISED_ENV_NAMES
            .iter()
            .any(|removed| name.as_bytes() == removed.as_bytes())
    })
    .filter_map(|(name, value)| {
        let mut entry = name.as_bytes().to_vec();
        entry.push(b'=');
        entry.extend_from_slice(value.as_bytes());
        std::ffi::CString::new(entry).ok()
    })
    .collect()
}

/// Spawns `path` with `args` and `env` in this terminal and waits for it.
///
/// The child starts with no blocked signals (this screen blocks SIGINT and
/// SIGQUIT in [`block_terminal_signals`]) and with SIGINT, SIGQUIT and SIGPIPE
/// back at their default actions. `std::process::Command` cannot do this without
/// `unsafe`: it hands the caller's mask on unchanged. Not every `/bin/sh`
/// clears an inherited mask (dash does; bash, which is `/bin/sh` on macOS
/// and some Linux distributions, keeps it and passes it to everything it
/// runs), so a command started through std would ignore Ctrl-C there.
fn spawn_and_wait(
    path: &std::ffi::CStr,
    args: &[std::ffi::CString],
    env: &[std::ffi::CString],
) -> nix::Result<nix::sys::wait::WaitStatus> {
    use nix::errno::Errno;
    use nix::spawn::{PosixSpawnAttr, PosixSpawnFileActions, PosixSpawnFlags, posix_spawn};
    use nix::sys::signal::{SigSet, Signal};
    use nix::sys::wait::waitpid;

    let mask = SigSet::empty();
    let mut defaults = SigSet::empty();
    for signal in [Signal::SIGINT, Signal::SIGQUIT, Signal::SIGPIPE] {
        defaults.add(signal);
    }
    let mut attr = PosixSpawnAttr::init()?;
    attr.set_sigmask(&mask)?;
    attr.set_sigdefault(&defaults)?;
    attr.set_flags(
        PosixSpawnFlags::POSIX_SPAWN_SETSIGMASK | PosixSpawnFlags::POSIX_SPAWN_SETSIGDEF,
    )?;
    let actions = PosixSpawnFileActions::init()?;
    let pid = posix_spawn(path, &actions, &attr, args, env)?;
    loop {
        match waitpid(pid, None) {
            Err(Errno::EINTR) => {}
            result => return result,
        }
    }
}

/// Runs the confirmed command in this terminal and returns its exit code.
/// The daemon's env names are removed from its env; this process's own env
/// (which still holds the marker) is hidden by [`hide_own_env`] on Linux.
/// Ctrl-C and Ctrl-\ reach the command (see [`spawn_and_wait`]) while this
/// process, which blocks them, survives to report the exit and offer a
/// retry. A command that cannot start reports 127, like a shell.
fn run_command(command: &str) -> u8 {
    let status = shell_args(command).and_then(|args| {
        spawn_and_wait(SHELL, &args, &command_env()).context("starting `/bin/sh`")
    });
    match status {
        Ok(status) => exit_code(status),
        Err(error) => {
            let _ =
                crate::output::diagnostic(format!("wsmp: could not run the command: {error:#}"));
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

/// Keeps the command (same uid) from reading this process's memory and
/// initial env (the request and the marker file's path; the marker itself
/// never travels in env) through `/proc/<pid>/environ`, `/proc/<pid>/mem`
/// or ptrace: a non-dumpable process needs `CAP_SYS_PTRACE` for those. The
/// command execs and is dumpable again. Linux only; elsewhere the marker is
/// protected by being read from a private file that is removed before any
/// command runs.
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
        assert_eq!(run_command("exit 0"), 0);
        assert_eq!(run_command("exit 3"), 3);
        assert_eq!(run_command("exit 255"), 255);
        // Killed by SIGTERM (15): 128 + 15.
        assert_eq!(run_command("kill -TERM $$"), 143);
        assert_eq!(run_command("exit 7"), 7);
    }

    #[test]
    fn the_command_does_not_see_the_daemon_env() {
        assert_eq!(SHELL, c"/bin/sh");
        assert_eq!(
            shell_args("true").expect("args"),
            vec![c"sh".to_owned(), c"-c".to_owned(), c"true".to_owned()]
        );
        assert!(shell_args("a\0b").is_err());
        let vars = SUPERVISED_ENV_NAMES
            .iter()
            .map(|name| (name.into(), "secret".into()))
            .chain([("PATH".into(), "/usr/bin".into())]);
        assert_eq!(
            env_without_daemon_names(vars),
            vec![c"PATH=/usr/bin".to_owned()]
        );
        assert!(SUPERVISED_ENV_NAMES.contains(&SUPERVISED_ENV_OPERATOR));
    }

    /// The command must take Ctrl-C even though this process blocks it, and
    /// whichever shell `/bin/sh` is: bash keeps an inherited mask, so a
    /// blocked SIGINT would leave `kill -INT $$` pending and the script
    /// would carry on to `exit 0`.
    #[test]
    fn the_command_ends_on_sigint_although_this_process_blocks_it() {
        // Run on a fresh thread: the block applies to that thread only.
        let code = std::thread::spawn(|| {
            block_terminal_signals().expect("block");
            run_command("kill -INT $$; exit 0")
        })
        .join()
        .expect("thread");
        assert_eq!(code, 130);
    }

    /// The mask the command starts with, checked without a shell in between
    /// (dash would clear it and hide a leak).
    #[cfg(target_os = "linux")]
    #[test]
    fn the_command_starts_with_no_blocked_signals() {
        let status = std::thread::spawn(|| {
            block_terminal_signals().expect("block");
            let args = [
                c"env".to_owned(),
                c"grep".to_owned(),
                c"-Eq".to_owned(),
                c"^SigBlk:[[:space:]]+0+$".to_owned(),
                c"/proc/self/status".to_owned(),
            ];
            spawn_and_wait(c"/usr/bin/env", &args, &command_env()).expect("spawn")
        })
        .join()
        .expect("thread");
        assert_eq!(exit_code(status), 0, "{status:?}");
    }
}
