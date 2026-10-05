//! `wsmp terminal supervised-run --deployment`: the confirm screen of an
//! interactive deployment step (an "operator" step).
//!
//! A recipe command marked interactive (typically one that needs `sudo`)
//! does not run on its own: the daemon opens an operator terminal, and this
//! screen shows the owner what will run there before anything does. The
//! header names the endpoint, its models, this node and rank, the step and
//! who asked for it; then the exact command, every control or invisible
//! character made visible (see [`crate::display_escape`]), the same way as
//! the agent-command screen ([`super::layout`]).
//!
//! The key handling, type-ahead flush, `ready`/`accepted` markers and the
//! daemon's single-use `go` token are the shared confirm mechanics
//! ([`crate::supervised_screen`]). Unlike the agent screen, this child does
//! not `exec` the command: it runs `sh -c <command>` in the same terminal,
//! reports `exited;<code>`, and after a non-zero exit draws the screen again
//! so the owner can retry or close. It never opens a shell.
//!
//! Nothing spawns this screen yet: the job executor still refuses
//! interactive jobs (`interactive_unsupported`) and the hello does not report
//! `deploymentOperator`. The executor and daemon wiring come next.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::{INDENT, Screen, command_size, field, fit, wrap_words};
use crate::deployments::{Action, Actor, Job};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::run;

/// The prompt of the first screen.
pub const PROMPT: &str = "Enter to run · Ctrl-C, Ctrl-D or q to close";
/// The prompt after the command exited non-zero.
pub const RETRY_PROMPT: &str = "Enter to run it again · Ctrl-C, Ctrl-D or q to close";
/// Models named on the screen before the rest are counted.
const MODELS_SHOWN: usize = 3;
const ENDPOINT_MAX_BYTES: usize = 128;
const NODE_MAX_BYTES: usize = 256;
const MODEL_MAX_BYTES: usize = 256;
const MODELS_MAX: usize = 64;

/// What the operator confirm screen shows. The daemon hands it to the child
/// as JSON in `WSMP_SUPERVISED_OPERATOR`; [`OperatorRequest::from_job`]
/// builds it from the job the server sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRequest {
    /// The deployment's endpoint slug (`inst-...`).
    pub endpoint: String,
    pub models: Vec<String>,
    /// This machine, as the dashboard names it.
    pub node: String,
    pub rank: u32,
    pub action: Action,
    /// Who asked for the deployment (the plan's requester).
    pub requested_by: Actor,
    /// A person confirmed the plan (always true for `requested_by: USER`).
    pub human_approved: bool,
    /// Whether an agent wrote this command text; `None` when this machine
    /// was not told (the 2.11 job carries no authorship field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_written: Option<bool>,
    /// The exact command, as the intent hash binds it.
    pub command: String,
}

impl OperatorRequest {
    /// The screen for an interactive job on this `node`. Only a valid job
    /// whose own command is interactive has one.
    pub fn from_job(job: &Job, node: &str) -> Result<Self> {
        job.validate()?;
        anyhow::ensure!(
            job.interactive == Some(true) && job.operator.is_some(),
            "not an interactive deployment job"
        );
        let request = Self {
            endpoint: job.endpoint_slug.clone(),
            models: job.models.clone(),
            node: node.to_string(),
            rank: job.rank,
            action: job.action,
            requested_by: job.actor,
            human_approved: job.human_approved,
            agent_written: None,
            command: job.command.clone(),
        };
        request.validate()?;
        Ok(request)
    }

    /// The bounds the screen relies on. The child re-checks what it is given.
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            matches!(
                self.action,
                Action::Prepare | Action::Start | Action::AfterJoin | Action::Stop
            ),
            "action cannot be interactive"
        );
        anyhow::ensure!(!self.command.trim().is_empty(), "the command is empty");
        crate::child_env::validate_command(&self.command).map_err(anyhow::Error::msg)?;
        anyhow::ensure!(self.rank < 64, "bad rank");
        // Identifiers are single plain lines: nothing the screen would have to
        // escape (escaping stays the backstop) and no line break that could
        // draw a row looking like part of the command.
        let plain = |text: &str, max: usize| {
            !text.is_empty()
                && text.len() <= max
                && !text
                    .chars()
                    .any(|ch| ch == '\n' || crate::display_escape::needs_escape(ch))
        };
        anyhow::ensure!(plain(&self.endpoint, ENDPOINT_MAX_BYTES), "bad endpoint");
        anyhow::ensure!(plain(&self.node, NODE_MAX_BYTES), "bad node name");
        anyhow::ensure!(
            !self.models.is_empty()
                && self.models.len() <= MODELS_MAX
                && self
                    .models
                    .iter()
                    .all(|model| plain(model, MODEL_MAX_BYTES)),
            "bad models"
        );
        anyhow::ensure!(
            self.requested_by == Actor::Agent || self.human_approved,
            "a person's request is always approved"
        );
        Ok(())
    }
}

fn action_text(action: Action) -> &'static str {
    match action {
        Action::Prepare => "prepare (runs before the service starts)",
        Action::Start => "start the service",
        Action::AfterJoin => "start the service after the other nodes joined",
        Action::Stop => "stop the service",
        // `validate` refuses the rest; named anyway so nothing is hidden.
        Action::Readiness => "readiness check",
        Action::Health => "health check",
        Action::Status => "status check",
    }
}

fn requested_by_text(request: &OperatorRequest) -> &'static str {
    match (request.requested_by, request.human_approved) {
        (Actor::User, _) => "you, from the dashboard",
        (Actor::Agent, true) => "an agent; you confirmed the plan",
        (Actor::Agent, false) => "an agent; no person confirmed the plan",
    }
}

fn written_by_text(agent_written: Option<bool>) -> &'static str {
    match agent_written {
        Some(true) => "an agent. Read it before you run it.",
        Some(false) => "you",
        None => "not known here. Read it before you run it.",
    }
}

fn models_text(models: &[String]) -> String {
    let mut text = models
        .iter()
        .take(MODELS_SHOWN)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if models.len() > MODELS_SHOWN {
        text.push_str(&format!(" and {} more", models.len() - MODELS_SHOWN));
    }
    text
}

/// The scrollable part of the screen, laid out for `width` columns.
fn body_rows(request: &OperatorRequest, last_exit: Option<u8>, width: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let title = match last_exit {
        None => "WS Model Proxy: a deployment step needs you to run a command".to_string(),
        Some(code) => {
            format!("WS Model Proxy: the deployment command exited with code {code}")
        }
    };
    wrap_words(&mut rows, &title, width);
    rows.push(String::new());
    // Server-validated, but still untrusted text: every field is escaped.
    field(&mut rows, "Endpoint: ", &request.endpoint, width);
    field(&mut rows, "Models: ", &models_text(&request.models), width);
    field(
        &mut rows,
        "Node: ",
        &format!("{} (rank {})", request.node, request.rank),
        width,
    );
    field(&mut rows, "Step: ", action_text(request.action), width);
    field(
        &mut rows,
        "Requested by: ",
        requested_by_text(request),
        width,
    );
    field(
        &mut rows,
        "Command written by: ",
        written_by_text(request.agent_written),
        width,
    );
    rows.push(String::new());
    wrap_words(
        &mut rows,
        &format!("Command ({}):", command_size(&request.command)),
        width,
    );
    field(&mut rows, INDENT, &request.command, width);
    rows.push(String::new());
    wrap_words(
        &mut rows,
        "Enter runs it here with `sh -c`, as your user. This terminal never opens a shell; it closes when the command succeeds or you close it.",
        width,
    );
    if last_exit.is_some() {
        wrap_words(
            &mut rows,
            "The deployment waits until the command succeeds or you close this terminal.",
            width,
        );
    }
    rows.push(String::new());
    wrap_words(
        &mut rows,
        "Tip: to run this step without you, allow this exact command (with absolute paths) for your user in sudoers with NOPASSWD, then turn Interactive off for it in the recipe.",
        width,
    );
    rows
}

/// Lays the operator screen out for a `cols` x `rows` terminal with the body
/// scrolled to `offset` (clamped); `last_exit` is the code of a failed run
/// when this is the retry screen. The prompt row is always the last row.
pub fn layout(
    request: &OperatorRequest,
    last_exit: Option<u8>,
    cols: usize,
    rows: usize,
    offset: usize,
) -> Screen {
    fit(
        |width| body_rows(request, last_exit, width),
        &command_size(&request.command),
        if last_exit.is_some() {
            RETRY_PROMPT
        } else {
            PROMPT
        },
        cols,
        rows,
        offset,
    )
}

#[cfg(not(unix))]
pub fn run() -> Result<()> {
    anyhow::bail!("deployment operator steps need a Unix terminal")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervised_run::text_width;

    pub(super) fn request(command: &str) -> OperatorRequest {
        OperatorRequest {
            endpoint: "inst-abc123".to_string(),
            models: vec!["org/model".to_string()],
            node: "gpu-box".to_string(),
            rank: 0,
            action: Action::Start,
            requested_by: Actor::Agent,
            human_approved: true,
            agent_written: None,
            command: command.to_string(),
        }
    }

    fn assert_fits(screen: &Screen, cols: usize, rows: usize, prompt: &str) {
        assert!(screen.rows.len() <= rows, "{} rows", screen.rows.len());
        for row in &screen.rows {
            assert!(text_width(row) < cols.max(3), "row {row:?} is too wide");
            assert!(!row.contains(['\n', '\r', '\x1b']));
        }
        assert!(screen.rows.join(" ").ends_with(prompt));
    }

    #[test]
    fn the_screen_names_the_step_and_shows_the_exact_command() {
        let screen = layout(&request("sudo systemctl start vllm"), None, 100, 40, 0);
        assert_fits(&screen, 100, 40, PROMPT);
        assert_eq!(screen.max_offset, 0);
        let text = screen.rows.join("\n");
        for part in [
            "a deployment step needs you to run a command",
            "Endpoint: inst-abc123",
            "Models: org/model",
            "Node: gpu-box (rank 0)",
            "Step: start the service",
            "Requested by: an agent; you confirmed the plan",
            "Command written by: not known here. Read it before you run it.",
            "Command (1 line, 25 bytes):",
            "    sudo systemctl start vllm",
            "never opens a shell",
            "NOPASSWD",
            PROMPT,
        ] {
            assert!(text.contains(part), "missing {part:?} in {text}");
        }
        assert!(!text.contains("exited with code"));
        assert!(!text.contains("not shown"));
    }

    #[test]
    fn every_action_requester_and_author_reads_plainly() {
        for (action, label) in [
            (
                Action::Prepare,
                "Step: prepare (runs before the service starts)",
            ),
            (
                Action::AfterJoin,
                "Step: start the service after the other nodes joined",
            ),
            (Action::Stop, "Step: stop the service"),
        ] {
            let mut req = request("true");
            req.action = action;
            let text = layout(&req, None, 100, 40, 0).rows.join("\n");
            assert!(text.contains(label), "{label}: {text}");
        }
        let mut req = request("true");
        req.requested_by = Actor::User;
        req.agent_written = Some(false);
        let text = layout(&req, None, 100, 40, 0).rows.join("\n");
        assert!(text.contains("Requested by: you, from the dashboard"));
        assert!(text.contains("Command written by: you"));
        req.requested_by = Actor::Agent;
        req.human_approved = false;
        req.agent_written = Some(true);
        let text = layout(&req, None, 100, 40, 0).rows.join("\n");
        assert!(text.contains("Requested by: an agent; no person confirmed the plan"));
        assert!(text.contains("Command written by: an agent. Read it before you run it."));
        req.models = (0..5).map(|n| format!("m{n}")).collect();
        let text = layout(&req, None, 100, 40, 0).rows.join("\n");
        assert!(text.contains("Models: m0, m1, m2 and 2 more"), "{text}");
    }

    #[test]
    fn hidden_control_and_bidi_characters_are_shown_escaped() {
        let mut req = request("echo ok\u{202e}\u{200b}\x1b]0;x\x07\r\nrm -rf /tmp/x");
        req.node = "box\u{2066}evil\x1b[2J".to_string();
        req.endpoint = "inst-\u{feff}a".to_string();
        req.models = vec!["m\u{e0041}".to_string()];
        let screen = layout(&req, None, 100, 40, 0);
        assert_fits(&screen, 100, 40, PROMPT);
        let text = screen.rows.join("\n");
        assert!(
            text.contains(
                "    echo ok\\u{202e}\\u{200b}\\u{1b}]0;x\\u{7}\\u{d}↵\n    rm -rf /tmp/x"
            ),
            "{text}"
        );
        assert!(
            text.contains("Node: box\\u{2066}evil\\u{1b}[2J (rank 0)"),
            "{text}"
        );
        assert!(text.contains("Endpoint: inst-\\u{feff}a"), "{text}");
        assert!(text.contains("Models: m\\u{e0041}"), "{text}");
        for hidden in [
            '\u{202e}',
            '\u{200b}',
            '\u{2066}',
            '\u{feff}',
            '\u{e0041}',
            '\x07',
        ] {
            assert!(!text.contains(hidden), "{hidden:?} drawn raw");
        }
        // The only escape sequences are the screen's own home and clear.
        assert_eq!(screen.paint().matches('\x1b').count(), 2);
    }

    #[test]
    fn the_retry_screen_names_the_exit_code_and_its_own_prompt() {
        let screen = layout(&request("sudo false"), Some(1), 100, 40, 0);
        assert_fits(&screen, 100, 40, RETRY_PROMPT);
        let text = screen.rows.join("\n");
        assert!(text.contains("the deployment command exited with code 1"));
        assert!(text.contains("    sudo false"));
        assert!(text.contains("waits until the command succeeds or you close"));
        assert!(!text.ends_with(&format!("\n{PROMPT}")));
    }

    #[test]
    fn a_large_command_fits_every_terminal_size_and_scrolls() {
        let mut command = String::new();
        for ch in "sudo \u{202e}日本 \n".chars().cycle() {
            if command.len() + ch.len_utf8() > 4096 {
                break;
            }
            command.push(ch);
        }
        let mut req = request(&command);
        req.models = (0..64).map(|n| format!("{n:0>200}")).collect();
        for last_exit in [None, Some(255)] {
            let prompt = if last_exit.is_some() {
                RETRY_PROMPT
            } else {
                PROMPT
            };
            for (cols, rows) in [(80, 24), (40, 12), (20, 6), (200, 60), (3, 3), (1, 1)] {
                for offset in [0, 7, usize::MAX] {
                    let screen = layout(&req, last_exit, cols, rows, offset);
                    assert!(screen.rows.len() <= rows.max(1));
                    assert!(screen.rows.iter().all(|row| !row.contains('\x1b')));
                    if cols >= 20 && rows >= 6 {
                        assert_fits(&screen, cols, rows, prompt);
                    }
                    if cols >= 40 && rows >= 12 {
                        let footer = screen.rows[screen.height..].join(" ");
                        assert!(footer.contains("the rest is not shown"), "{footer}");
                        assert!(footer.contains("bytes"), "{footer}");
                    }
                }
            }
        }
        // Scrolling to the end reaches the sudoers tip.
        let end = layout(&req, None, 80, 24, usize::MAX);
        assert_eq!(end.offset, end.max_offset);
        assert!(end.rows.join(" ").contains("NOPASSWD"));
    }

    #[test]
    fn the_request_round_trips_as_strict_json_and_is_bounded() {
        let req = request("sudo systemctl start vllm");
        let json = serde_json::to_string(&req).expect("json");
        assert!(!json.contains("agentWritten"));
        assert_eq!(
            serde_json::from_str::<OperatorRequest>(&json).expect("parse"),
            req
        );
        let extra = json.replacen('{', r#"{"shell":true,"#, 1);
        assert!(serde_json::from_str::<OperatorRequest>(&extra).is_err());
        req.validate().expect("valid");

        let refused = |change: fn(&mut OperatorRequest)| {
            let mut req = request("sudo true");
            change(&mut req);
            req.validate().is_err()
        };
        assert!(refused(|r| r.action = Action::Status));
        assert!(refused(|r| r.action = Action::Health));
        assert!(refused(|r| r.action = Action::Readiness));
        assert!(refused(|r| r.command = "  ".to_string()));
        assert!(refused(|r| r.command = "a\0b".to_string()));
        assert!(refused(|r| r.command = "x".repeat(4097)));
        assert!(refused(|r| r.rank = 64));
        assert!(refused(|r| r.endpoint.clear()));
        assert!(refused(|r| r.node = "n".repeat(257)));
        assert!(refused(|r| r.models = vec![String::new()]));
        assert!(refused(|r| r.models.clear()));
        assert!(refused(
            |r| r.models = vec!["x\n    sudo rm -rf /".to_string()]
        ));
        assert!(refused(|r| r.node = "box\u{202e}gpj".to_string()));
        assert!(refused(|r| r.node = "box\x1b[2J".to_string()));
        assert!(refused(|r| r.endpoint = "inst-\u{feff}a".to_string()));
        assert!(refused(|r| r.endpoint = "inst-a\nb".to_string()));
        // The backstop for the command itself is escaping, not refusal.
        assert!(!refused(|r| r.command = "echo \u{202e}x\nnext".to_string()));
        assert!(refused(|r| {
            r.requested_by = Actor::User;
            r.human_approved = false;
        }));
    }
}
