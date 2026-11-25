//! `wsmp secret set|list|remove`: node secrets set on this machine.
//!
//! Works at any trust (this is how a Relay-only node gets secrets). The value
//! is read from the terminal without echo and never printed or logged.

use std::io::{BufRead, IsTerminal, Read, Write};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::app::output;
use crate::process::control::{self, ControlCommand};
use crate::wire::protocol::frames::{NODE_SECRET_VALUE_MAX_BYTES, SecretRefusal, is_secret_name};

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Sub,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Set a secret (`WSMP_SECRET_*`); the value is typed at the prompt.
    Set { name: String },
    /// List secret names and when they were set (never values).
    List,
    /// Remove a secret.
    Remove { name: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed<'a> {
    name: &'a str,
    status: &'a str,
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::List => {
            let entries = crate::node::secrets::entries();
            if args.json {
                return output::json(&entries);
            }
            if entries.is_empty() {
                return output::line("no secrets");
            }
            for entry in entries {
                output::line(format!("{}  (set {})", entry.name, entry.updated_at))?;
            }
            Ok(())
        }
        Sub::Set { name } => {
            check_name(name)?;
            guard_local()?;
            let value = read_value(name)?;
            let result = crate::node::secrets::set_local(name, &value);
            drop(value);
            result.map_err(refusal)?;
            notify();
            finish(args.json, name, "set")
        }
        Sub::Remove { name } => {
            check_name(name)?;
            guard_local()?;
            let status = match crate::node::secrets::delete_local(name).map_err(refusal)? {
                crate::node::secrets::Outcome::NotFound => "not_found",
                _ => "removed",
            };
            notify();
            finish(args.json, name, status)
        }
    }
}

fn check_name(name: &str) -> Result<()> {
    anyhow::ensure!(
        is_secret_name(name),
        "secret names are `WSMP_SECRET_` followed by 1 to 64 of A-Z, 0-9 and _"
    );
    Ok(())
}

/// A person at this machine's terminal, outside the wsmp job tree.
fn guard_local() -> Result<()> {
    if let Some(reason) = crate::node::trust::self_started_by_wsmp() {
        anyhow::bail!(
            "secrets cannot be set from a command, job or terminal wsmp started ({reason})"
        );
    }
    anyhow::ensure!(
        std::io::stdin().is_terminal(),
        "`wsmp secret` needs a person at this machine's terminal"
    );
    Ok(())
}

fn refusal(reason: SecretRefusal) -> anyhow::Error {
    match reason {
        SecretRefusal::Invalid => {
            anyhow::anyhow!("the value must be 1 byte to 16 KiB, without NUL")
        }
        SecretRefusal::Limit => anyhow::anyhow!("this node already keeps 64 secrets"),
        SecretRefusal::StoreFailed | SecretRefusal::TrustRelay => {
            anyhow::anyhow!("storing the secret failed")
        }
    }
}

/// The relay reports the new names (`node.state`); best effort.
fn notify() {
    let _ = control::request_if_running(ControlCommand::Reload);
}

fn finish(json: bool, name: &str, status: &str) -> Result<()> {
    if json {
        return output::json(&Changed { name, status });
    }
    output::line(format!("{name}: {}", status.replace('_', " ")))
}

fn read_value(name: &str) -> Result<String> {
    let mut stderr = std::io::stderr();
    write!(stderr, "value for {name} (not shown): ")?;
    stderr.flush()?;
    let line = {
        let stdin = std::io::stdin();
        #[cfg(unix)]
        let _echo = if stdin.is_terminal() {
            Some(EchoOff::new(&stdin)?)
        } else {
            None
        };
        #[cfg(windows)]
        let _echo = if stdin.is_terminal() {
            echo_guard_or_warn(wsmp_windows::console::EchoOff::stdin(), || {
                writeln!(
                    stderr,
                    "\nwarning: terminal echo cannot be disabled; input will be visible"
                )?;
                stderr.flush()
            })?
        } else {
            None
        };
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .take(NODE_SECRET_VALUE_MAX_BYTES as u64 + 2)
            .read_line(&mut line)
            .context("reading the secret value")?;
        line
    };
    writeln!(stderr)?;
    let value = line.strip_suffix('\n').unwrap_or(&line);
    let value = value.strip_suffix('\r').unwrap_or(value);
    anyhow::ensure!(!value.is_empty(), "no value entered");
    Ok(value.to_string())
}

/// Only non-console Windows terminals may fall back to visible input. A
/// failure to disable echo on a real console remains an error.
#[cfg(any(windows, test))]
fn echo_guard_or_warn<T>(
    guard: std::io::Result<Option<T>>,
    warn: impl FnOnce() -> std::io::Result<()>,
) -> Result<Option<T>> {
    let guard = guard.context("disabling terminal echo")?;
    if guard.is_none() {
        warn().context("warning about visible secret input")?;
    }
    Ok(guard)
}

/// Terminal echo off while the value is typed; restored on drop.
#[cfg(unix)]
struct EchoOff<'a> {
    input: std::os::fd::BorrowedFd<'a>,
    saved: nix::sys::termios::Termios,
}

#[cfg(unix)]
impl<'a> EchoOff<'a> {
    fn new(input: &'a impl std::os::fd::AsFd) -> Result<Self> {
        use nix::sys::termios::{LocalFlags, SetArg, tcgetattr, tcsetattr};
        let saved = tcgetattr(input).context("reading terminal echo mode")?;
        let mut quiet = saved.clone();
        quiet.local_flags.remove(LocalFlags::ECHO);
        quiet.local_flags.insert(LocalFlags::ECHONL);
        tcsetattr(input, SetArg::TCSANOW, &quiet).context("disabling terminal echo")?;
        Ok(Self {
            input: input.as_fd(),
            saved,
        })
    }
}

#[cfg(unix)]
impl Drop for EchoOff<'_> {
    fn drop(&mut self) {
        let _ = nix::sys::termios::tcsetattr(
            self.input,
            nix::sys::termios::SetArg::TCSANOW,
            &self.saved,
        );
    }
}

#[cfg(all(unix, test))]
mod tests {
    use super::EchoOff;
    use nix::sys::termios::{LocalFlags, tcgetattr};

    #[test]
    fn secret_echo_guard_disables_echo_and_restores_terminal_mode() {
        let pty = nix::pty::openpty(None, None).expect("pty");
        let saved = tcgetattr(&pty.slave).expect("original mode");
        {
            let _guard = EchoOff::new(&pty.slave).expect("echo off");
            let quiet = tcgetattr(&pty.slave).expect("quiet mode");
            assert!(!quiet.local_flags.contains(LocalFlags::ECHO));
            assert!(quiet.local_flags.contains(LocalFlags::ECHONL));
        }
        // Compare the mode flags: musl's termios also carries unused c_cc slots
        // and speed fields that need not round-trip byte for byte.
        let restored = tcgetattr(&pty.slave).expect("restored mode");
        assert_eq!(restored.local_flags, saved.local_flags);
        assert_eq!(restored.input_flags, saved.input_flags);
        assert_eq!(restored.output_flags, saved.output_flags);
        assert_eq!(restored.control_flags, saved.control_flags);
    }

    #[test]
    fn secret_echo_guard_refuses_input_when_terminal_mode_cannot_be_read() {
        let file = tempfile::tempfile().expect("tempfile");
        assert!(EchoOff::new(&file).is_err());
    }
}

#[cfg(test)]
mod fallback_tests {
    use super::echo_guard_or_warn;
    use std::cell::Cell;

    #[test]
    fn secret_echo_fallback_warns_only_for_non_console_input() {
        let warnings = Cell::new(0);
        let warn = || {
            warnings.set(warnings.get() + 1);
            Ok(())
        };
        assert_eq!(
            echo_guard_or_warn(Ok(Some(42)), warn).expect("guard"),
            Some(42)
        );
        assert_eq!(warnings.get(), 0);
        assert_eq!(
            echo_guard_or_warn::<()>(Ok(None), warn).expect("pty fallback"),
            None
        );
        assert_eq!(warnings.get(), 1);
        assert!(
            echo_guard_or_warn::<()>(
                Err(std::io::Error::other("setting console mode failed")),
                warn
            )
            .is_err()
        );
        assert_eq!(warnings.get(), 1);
    }

    #[test]
    fn secret_echo_fallback_requires_the_visibility_warning_to_succeed() {
        assert!(
            echo_guard_or_warn::<()>(Ok(None), || Err(std::io::Error::other("stderr failed")))
                .is_err()
        );
    }
}
