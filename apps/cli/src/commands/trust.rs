//! `wsmp trust [full|relay]`: show or set what the server may do here.
//!
//! Lowering works from anywhere and sticks. Raising needs a person at a
//! terminal: no `--yes`, no environment override, never from a process wsmp
//! started (the daemon checks the caller's process tree too).

use std::io::{BufRead, IsTerminal, Write};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::Config;
use crate::control::{self, ControlCommand};
use crate::output;
use crate::protocol::frames::TrustValue;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// `full` (definitions, commands, files, terminals) or `relay` (relay
    /// requests and start/stop of definitions already here). Omit to show.
    #[arg(value_enum)]
    level: Option<Level>,
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum Level {
    Full,
    Relay,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrustOutput<'a> {
    trust: &'a str,
    changed: bool,
    relay_running: bool,
}

pub fn run(args: &Args) -> Result<()> {
    match args.level {
        None => show(args.json),
        Some(Level::Relay) => lower(args.json),
        Some(Level::Full) => raise(args.json),
    }
}

fn show(json: bool) -> Result<()> {
    let config = Config::load_required()?;
    let trust = crate::trust::configured(&config);
    if json {
        return output::json(&TrustOutput {
            trust: crate::trust::word(trust),
            changed: false,
            relay_running: false,
        });
    }
    output::line(format!("trust: {}", describe(trust)))?;
    if trust == TrustValue::Relay {
        output::line("raise with `wsmp trust full` on this machine's terminal")?;
    }
    Ok(())
}

fn describe(trust: TrustValue) -> &'static str {
    match trust {
        TrustValue::Full => "full control",
        TrustValue::Relay => "relay only",
    }
}

fn answer_ok(response: &serde_json::Value) -> Result<bool> {
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let message = response
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the relay refused");
        anyhow::bail!("{}", crate::display_escape::escape_single_line(message));
    }
    Ok(response.get("state").and_then(serde_json::Value::as_str) == Some("changed"))
}

fn lower(json: bool) -> Result<()> {
    // Lowering is always allowed: persist it here first, so it sticks even
    // when the relay is busy or unreachable; then tell the relay.
    let before = crate::trust::configured(&Config::load_required()?);
    if before == TrustValue::Full {
        crate::trust::persist_lowering()?;
    } else {
        crate::trust::persist_relay()?;
    }
    let running = match control::request_if_running(ControlCommand::TrustRelay) {
        Ok(Some(response)) => {
            if let Err(error) = answer_ok(&response) {
                output::diagnostic(format!(
                    "warning: lowered in config.json, but the relay answered: {error}"
                ))?;
            }
            true
        }
        Ok(None) => false,
        Err(error) => {
            output::diagnostic(format!(
                "warning: lowered in config.json; the relay picks it up within 2 s ({error:#})"
            ))?;
            true
        }
    };
    report(json, TrustValue::Relay, before == TrustValue::Full, running)
}

fn raise(json: bool) -> Result<()> {
    if let Some(refusal) = crate::trust::caller_marker_refusal() {
        anyhow::bail!("{refusal}");
    }
    anyhow::ensure!(
        std::io::stdin().is_terminal() && std::io::stderr().is_terminal(),
        "`wsmp trust full` needs a person at this machine's terminal"
    );
    let config = Config::load_required()?;
    if crate::trust::configured(&config) == TrustValue::Full {
        return report(json, TrustValue::Full, false, false);
    }
    let server = config.server_url.as_deref().unwrap_or("the server");
    let mut stderr = std::io::stderr();
    writeln!(
        stderr,
        "Full control lets {} define and start model servers, run commands, read and write files in folders you allow, and open terminals here. Anyone who controls that server or your account can do the same.",
        crate::display_escape::escape_single_line(server)
    )?;
    write!(stderr, "Type `full` to allow it: ")?;
    stderr.flush()?;
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .context("reading the confirmation")?;
    anyhow::ensure!(line.trim() == "full", "trust left at relay only");
    let (changed, running) = match control::request_if_running(ControlCommand::TrustFull)? {
        Some(response) => (answer_ok(&response)?, true),
        None => {
            // No relay to check this process: check it here, the same way.
            #[cfg(unix)]
            crate::trust::peer_may_raise(i32::try_from(std::process::id()).unwrap_or(0), 0)
                .map_err(|reason| anyhow::anyhow!("{reason}"))?;
            crate::trust::persist_full()?;
            (true, false)
        }
    };
    report(json, TrustValue::Full, changed, running)
}

fn report(json: bool, trust: TrustValue, changed: bool, running: bool) -> Result<()> {
    if json {
        return output::json(&TrustOutput {
            trust: crate::trust::word(trust),
            changed,
            relay_running: running,
        });
    }
    let state = if changed { "now" } else { "already" };
    output::line(format!("trust: {state} {}", describe(trust)))
}
