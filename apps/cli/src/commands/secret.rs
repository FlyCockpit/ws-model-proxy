//! `wsmp secret set|list|remove`: node secrets set on this machine.
//!
//! Works at any trust (this is how a Relay-only node gets secrets). The value
//! is read from the terminal without echo and never printed or logged.

use std::io::{BufRead, IsTerminal, Read, Write};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::control::{self, ControlCommand};
use crate::output;
use crate::protocol::frames::{NODE_SECRET_VALUE_MAX_BYTES, SecretRefusal, is_secret_name};

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
            let entries = crate::secrets::entries();
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
            let result = crate::secrets::set_local(name, &value);
            drop(value);
            result.map_err(refusal)?;
            notify();
            finish(args.json, name, "set")
        }
        Sub::Remove { name } => {
            check_name(name)?;
            guard_local()?;
            let status = match crate::secrets::delete_local(name).map_err(refusal)? {
                crate::secrets::Outcome::NotFound => "not_found",
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
    if crate::trust::self_started_by_wsmp().is_some() {
        anyhow::bail!("secrets cannot be set from a command, job or terminal wsmp started");
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
        #[cfg(unix)]
        let _echo = EchoOff::new();
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

/// Terminal echo off while the value is typed; restored on drop.
#[cfg(unix)]
struct EchoOff {
    saved: Option<nix::sys::termios::Termios>,
}

#[cfg(unix)]
impl EchoOff {
    fn new() -> Self {
        use nix::sys::termios::{LocalFlags, SetArg, tcgetattr, tcsetattr};
        let stdin = std::io::stdin();
        let saved = tcgetattr(&stdin).ok();
        if let Some(saved) = &saved {
            let mut quiet = saved.clone();
            quiet.local_flags.remove(LocalFlags::ECHO);
            quiet.local_flags.insert(LocalFlags::ECHONL);
            let _ = tcsetattr(&stdin, SetArg::TCSANOW, &quiet);
        }
        Self { saved }
    }
}

#[cfg(unix)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        if let Some(saved) = &self.saved {
            let _ = nix::sys::termios::tcsetattr(
                std::io::stdin(),
                nix::sys::termios::SetArg::TCSANOW,
                saved,
            );
        }
    }
}
