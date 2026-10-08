//! `wsmp status`: whether the relay runs here and how its connection stands.
//!
//! The relay's state comes from the running relay over its same-user control
//! socket, never from a PID file. The runtimes and instances come from the
//! node's own files (as `wsmp runtime list` reads them), whether or not the
//! relay runs.

use anyhow::Result;
use serde::Serialize;

use crate::config::Config;
use crate::control::{self, ControlCommand};
use crate::display_escape::escape_single_line;
use crate::output;
use crate::runtimes::local::{self, LocalView, word};

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
    let mut response = match control::request(ControlCommand::Status) {
        Ok(response) => response,
        Err(error) => serde_json::to_value(NotRunning {
            ok: false,
            state: "not_running",
            message: format!("{error:#}"),
        })?,
    };
    let view = match Config::load() {
        Ok(config) => Some(local::load(&config, false)),
        Err(error) => {
            output::diagnostic(format!("warning: runtimes not shown: {error:#}"))?;
            None
        }
    };
    if let (Some(view), Some(object)) = (&view, response.as_object_mut()) {
        object.insert("definitions".into(), view.definitions.into());
        object.insert("runtimes".into(), serde_json::to_value(&view.runtimes)?);
        object.insert("instances".into(), serde_json::to_value(&view.instances)?);
        if !view.warnings.is_empty() {
            object.insert("warnings".into(), serde_json::to_value(&view.warnings)?);
        }
    }
    if args.json {
        return output::json(&response);
    }
    let mut lines = format_status(&response);
    if let Some(view) = &view {
        lines.extend(format_local(view));
    }
    for line in lines {
        output::line(line)?;
    }
    Ok(())
}

fn field<'a>(response: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    response.get(key).and_then(serde_json::Value::as_str)
}

fn format_status(response: &serde_json::Value) -> Vec<String> {
    let mut lines = vec![format!(
        "relay: {}",
        match field(response, "state") {
            Some("not_running") => "not running",
            Some(state) => state,
            None => "unknown",
        }
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

/// One line per runtime and per instance rank, as recorded.
fn format_local(view: &LocalView) -> Vec<String> {
    let mut lines = Vec::new();
    if view.runtimes.is_empty() {
        lines.push(format!("runtimes: none ({} definitions)", view.definitions));
    } else {
        lines.push(format!("runtimes ({} definitions):", view.definitions));
        for row in &view.runtimes {
            let mut line = format!("  {}  {}", escape_single_line(&row.slug), word(&row.kind));
            if let Some(base_url) = &row.base_url {
                line.push_str(&format!("  {}", escape_single_line(base_url)));
            }
            if !row.models.is_empty() {
                line.push_str(&format!(
                    "  {}",
                    crate::commands::runtime::models_text(&row.models)
                ));
            }
            lines.push(line);
        }
    }
    if view.instances.is_empty() {
        lines.push("instances: none".to_string());
    } else {
        lines.push("instances:".to_string());
        for row in &view.instances {
            lines.push(format!(
                "  {} r{}  {}  {}  port {}",
                escape_single_line(&row.handle),
                row.rank,
                row.runtime
                    .as_deref()
                    .map_or_else(|| "(runtime not held)".to_string(), escape_single_line),
                word(&row.phase),
                row.port
            ));
        }
    }
    for warning in &view.warnings {
        lines.push(format!("warning: {}", escape_single_line(warning)));
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
