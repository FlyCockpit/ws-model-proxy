//! Short management commands (service managers, `brew`, `tar`, a version
//! probe) run with a deadline, through [`super::run_managed`], with errors
//! that name the program.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;

/// What a management command may print and is kept, per stream.
const OUTPUT_LIMIT: usize = 1 << 20;

/// Run a short management command with a deadline; its status, stdout and
/// stderr. It goes through [`super::run_managed`]: both pipes are
/// drained at once (a program that fills stderr never blocks), it is killed
/// at the deadline with its process group (Unix; a helper that detached into
/// a session of its own is not reached) or its job (Windows), and a helper
/// that holds a pipe after it exited cannot hold the call past it.
pub(crate) fn run_bounded_split(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<(bool, String, String)> {
    let ran = run_bounded_status(program, args, env, timeout)?;
    Ok((ran.code == Some(0), ran.stdout, ran.stderr))
}

/// How a [`run_bounded_status`] command ended: it ran to its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Exited {
    /// Its exit code; `None` when a signal ended it.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// [`run_bounded_split`] with the exit code: `Ok` only for a command that
/// ran to its end (whatever its status); an error when it could not be
/// started, ran out of time, or was stopped, so nothing is known of what it
/// would have said.
pub(crate) fn run_bounded_status(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<Exited> {
    let ran = run_bounded_bytes(program, args, env, timeout)?;
    Ok(Exited {
        code: ran.code,
        stdout: String::from_utf8_lossy(&ran.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&ran.stderr).into_owned(),
    })
}

/// [`run_bounded_status`] with stdout and stderr exactly as the program
/// wrote them (for output that must be read byte for byte, like a path).
pub(crate) fn run_bounded_bytes(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<super::Managed> {
    use super::{RunError, run_managed};
    let program = program.as_ref();
    // The program runs exactly as named; only the messages show it as text.
    let shown = Path::new(program).display();
    match run_managed(program, args, env, timeout, OUTPUT_LIMIT) {
        Ok(ran) => Ok(ran),
        Err(RunError::Spawn) => Err(anyhow::anyhow!("running `{shown}`: it could not start")),
        Err(RunError::Timeout) => Err(anyhow::anyhow!(
            "`{shown}` did not finish within {} s",
            timeout.as_secs()
        )),
        Err(RunError::Cancelled) => Err(anyhow::anyhow!("`{shown}` was stopped: wsmp is exiting")),
        Err(RunError::Resources) => Err(anyhow::anyhow!(
            "running `{shown}`: too many commands are running or stuck; try again later"
        )),
        // A managed run returns every exit status and drops output past the limit.
        Err(RunError::ExitStatus(_) | RunError::OutputTooLarge) => {
            Err(anyhow::anyhow!("running `{shown}` failed unexpectedly"))
        }
    }
}

/// [`run_bounded_split`] with stdout and then stderr as one text.
pub(crate) fn run_bounded(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<(bool, String)> {
    let (ok, out, err) = run_bounded_split(program, args, env, timeout)?;
    Ok((ok, format!("{out}{err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Instant;

    #[cfg(unix)]
    fn sh(script: &str) -> Vec<String> {
        vec!["-c".into(), script.into()]
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_fills_stderr_before_closing_stdout_is_not_blocked() {
        // 256 KiB on stderr while stdout is still open, then a line on stdout:
        // reading stdout to its end first would block the program on the full
        // stderr pipe until the deadline.
        let started = Instant::now();
        let (ok, out, err) = run_bounded_split(
            "sh",
            &sh("head -c 262144 /dev/zero | tr '\\0' e >&2; echo done"),
            &[],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert!(ok);
        assert_eq!(out, "done\n");
        assert_eq!(err.len(), 262_144);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_past_the_limit_is_drained_and_dropped_not_fatal() {
        let (ok, out, err) = run_bounded_split(
            "sh",
            &sh("head -c 3145728 /dev/zero; echo end >&2; exit 3"),
            &[],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert!(!ok, "the exit status is the program's");
        assert_eq!(out.len(), OUTPUT_LIMIT);
        assert_eq!(err, "end\n");
        // stdout first, then stderr, as one text.
        let (_, text) = run_bounded(
            "sh",
            &sh("echo err >&2; echo out"),
            &[("WSMP_TEST_EXTRA", "x".into())],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert_eq!(text, "out\nerr\n");
    }

    #[cfg(unix)]
    #[test]
    fn management_commands_inherit_the_environment_and_take_extra_values() {
        let (ok, out, _) = run_bounded_split(
            "sh",
            &sh("printf '%s %s' \"$WSMP_TEST_EXTRA\" \"${HOME:+home}\""),
            &[("WSMP_TEST_EXTRA", "extra".into())],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert!(ok);
        assert_eq!(out, "extra home");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_helper_holding_the_pipes_cannot_hold_the_call_past_its_deadline() {
        let dir = tempfile::tempdir().expect("dir");
        let pid_file = dir.path().join("helper.pid");
        // The program exits at once; the helper it started keeps stdout and
        // stderr open for 60 s.
        let script = format!(
            "sleep 60 & echo $! > '{}'; echo started",
            pid_file.display()
        );
        let started = Instant::now();
        let result = run_bounded_split("sh", &sh(&script), &[], Duration::from_secs(2));
        let elapsed = started.elapsed();
        let error = result.expect_err("the helper holds the pipes past the deadline");
        assert!(
            format!("{error:#}").contains("did not finish within 2 s"),
            "{error:#}"
        );
        assert!(elapsed < Duration::from_secs(6), "{elapsed:?}");
        // The helper was in the program's group and was killed with it.
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("pid")
            .trim()
            .parse()
            .expect("pid number");
        let gone = (0..200).any(|_| {
            let dead = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|stat| stat.contains(") Z "))
                .unwrap_or(true);
            if !dead {
                std::thread::sleep(Duration::from_millis(25));
            }
            dead
        });
        assert!(gone, "the helper {pid} still runs");
    }

    #[test]
    fn a_program_that_cannot_start_is_an_error() {
        let error = run_bounded(
            "wsmp-no-such-program",
            &[] as &[&str],
            &[],
            Duration::from_secs(5),
        )
        .expect_err("missing");
        assert!(
            format!("{error:#}").contains("could not start"),
            "{error:#}"
        );
    }
}
