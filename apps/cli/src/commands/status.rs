//! `wsmp status`: whether the relay runs here and how its connection stands.
//!
//! The answer comes from the running relay over its same-user control
//! socket, never from a PID file. Runtimes, instances and detected servers
//! join this report with the runtime store (C2).

use anyhow::Result;
use serde::Serialize;

use crate::control::{self, ControlCommand};
use crate::output;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit a stable JSON status object.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotRunning<'a> {
    ok: bool,
    state: &'a str,
    message: String,
}

pub fn run(args: &Args) -> Result<()> {
    match control::request(ControlCommand::Status) {
        Ok(response) => {
            if args.json {
                output::json(&response)?;
            } else {
                for line in format_status(&response) {
                    output::line(line)?;
                }
            }
            Ok(())
        }
        Err(error) => {
            let message = format!("{error:#}");
            if args.json {
                output::json(&NotRunning {
                    ok: false,
                    state: "not_running",
                    message,
                })?;
            } else {
                output::line("relay: not running")?;
                output::line(format!("detail: {message}"))?;
            }
            Ok(())
        }
    }
}

fn field<'a>(response: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    response.get(key).and_then(serde_json::Value::as_str)
}

fn format_status(response: &serde_json::Value) -> Vec<String> {
    let mut lines = vec![format!(
        "relay: {}",
        field(response, "state").unwrap_or("unknown")
    )];
    if let Some(connection) = field(response, "connection") {
        lines.push(format!("connection: {connection}"));
    }
    if let Some(node) = field(response, "node") {
        lines.push(format!("node: `{node}`"));
    }
    if let Some(trust) = field(response, "trust") {
        lines.push(format!("trust: {trust}"));
    }
    if let Some(message) = field(response, "message") {
        lines.push(format!("detail: {message}"));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines_follow_the_control_response() {
        let response = serde_json::json!({
            "ok": true,
            "state": "running",
            "connection": "connected",
            "node": "spark-1",
            "trust": "full",
        });
        assert_eq!(
            format_status(&response),
            [
                "relay: running",
                "connection: connected",
                "node: `spark-1`",
                "trust: full",
            ]
        );
    }
}
