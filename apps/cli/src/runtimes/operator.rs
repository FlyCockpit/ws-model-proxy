//! Operator terminals: the terminal in which a person runs an interactive
//! runtime step (`runtime.job.operator`, spec §4.7).
//!
//! A step's runner thread checks status first; only a step that still needs
//! its person asks the relay loop to open the terminal ([`OperatorOpen`]).
//! The terminal starts in a confirm stage with no process: the daemon itself
//! draws the confirm screen (the exact rendered command and who wrote it)
//! and reads the writer's keys. Enter spawns a fresh PTY that runs exactly
//! `/bin/sh -c WRAPPER wsmp-operator <command>`: [`WRAPPER`] runs `sudo -k`
//! (when `sudo` exists) before and after the command and nothing else, so
//! no shell prompt is ever offered and no sudo credential outlives the step.
//! Viewer input reaches the PTY only while that command runs. When it exits
//! the terminal ends; exit 0 hands the step back to its runner thread for
//! the status proof, anything else answers `operator_closed`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender};
use std::time::Duration;

use super::executor::{Deadline, Executor, Job, OperatorRan, Outcome, Runtime};
use crate::protocol::NodeFrame;
use crate::protocol::frames::{CommandAuthor, JobError, JobPhase, JobStatus};

/// Live operator terminals per node. The server opens at most a few (four
/// per node, stops aside); this only bounds a misbehaving server.
pub const MAX_OPERATOR_TERMINALS: usize = 8;

/// `$0` of the wrapper shell.
pub const WRAPPER_NAME: &str = "wsmp-operator";

/// The fixed script the operator PTY runs (`/bin/sh -c WRAPPER wsmp-operator
/// <command>`). The command arrives as `$1` and runs in its own
/// `/bin/sh -c`, so no quoting of it is ever needed. The outer shell traps
/// INT and QUIT with a command (a trap the command's shell resets to the
/// default), so Ctrl-C ends the command while the outer shell lives on to
/// run the trailing `sudo -k`.
pub const WRAPPER: &str = "trap : INT QUIT
if command -v sudo >/dev/null 2>&1; then sudo -k >/dev/null 2>&1; fi
/bin/sh -c -- \"$1\"
status=$?
if command -v sudo >/dev/null 2>&1; then sudo -k >/dev/null 2>&1; fi
exit $status
";

/// Variables the operator command never inherits: an askpass helper would
/// take the password outside the terminal, and `BASH_ENV` / `ENV` would run
/// a startup file in a non-interactive shell.
pub const REMOVED_ENV: [&str; 3] = ["SUDO_ASKPASS", "BASH_ENV", "ENV"];

/// The program and arguments of the operator PTY's child.
pub fn wrapper_argv(command: &str) -> (String, Vec<String>) {
    (
        "/bin/sh".to_string(),
        vec![
            "-c".to_string(),
            WRAPPER.to_string(),
            WRAPPER_NAME.to_string(),
            command.to_string(),
        ],
    )
}

/// `base` (the scrubbed terminal environment) plus the step's own variables
/// (node secrets, GPU visibility), without [`REMOVED_ENV`].
pub fn operator_env(
    base: &[(String, String)],
    extra: &[(String, String)],
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .iter()
        .filter(|(name, _)| !extra.iter().any(|(other, _)| other == name))
        .cloned()
        .collect();
    env.extend(extra.iter().cloned());
    env.retain(|(name, _)| !REMOVED_ENV.contains(&name.as_str()));
    env
}

/// Who a step's operator result names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperatorIds {
    pub step_id: String,
    pub instance_id: String,
    pub rank: u8,
    pub intent_hash: String,
    pub owner_epoch: String,
    pub terminal_id: String,
}

impl OperatorIds {
    /// A `runtime.job.result` for this step that names its terminal.
    pub fn result(&self, status: JobStatus, exit_code: Option<u8>) -> NodeFrame {
        NodeFrame::RuntimeJobResult {
            step_id: self.step_id.clone(),
            instance_id: self.instance_id.clone(),
            rank: self.rank,
            intent_hash: self.intent_hash.clone(),
            owner_epoch: self.owner_epoch.clone(),
            status,
            stopped: false,
            error: None,
            detail: None,
            terminal_id: Some(self.terminal_id.clone()),
            exit_code: if status == JobStatus::OperatorClosed {
                exit_code
            } else {
                None
            },
        }
    }
}

impl OperatorIds {
    /// A refusal of this step that names its terminal.
    pub fn failed(&self, error: JobError) -> NodeFrame {
        let mut frame = self.result(JobStatus::Failed, None);
        if let NodeFrame::RuntimeJobResult { error: slot, .. } = &mut frame {
            *slot = Some(error);
        }
        frame
    }
}

/// What the confirm screen shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperatorScreen {
    pub node: String,
    pub handle: String,
    pub phase: JobPhase,
    pub rank: u8,
    pub command: String,
    pub author: CommandAuthor,
}

fn phase_name(phase: JobPhase) -> &'static str {
    match phase {
        JobPhase::Prepare => "prepare",
        JobPhase::Start => "start",
        JobPhase::AfterJoin => "after join",
        JobPhase::Readiness => "readiness",
        JobPhase::Health => "health",
        JobPhase::Stop => "stop",
        JobPhase::Status => "status",
    }
}

fn author_text(author: CommandAuthor) -> &'static str {
    match author {
        CommandAuthor::User => "you",
        CommandAuthor::Agent => "an agent",
        CommandAuthor::Unknown => "unknown",
    }
}

/// This machine's name for the screen: the reported hostname, or a neutral
/// fallback.
pub fn node_name() -> String {
    crate::hostname::reported_hostname().unwrap_or_else(|| "this machine".to_string())
}

/// Columns a character may take: wide (CJK, emoji) characters take two, and
/// without a width table every non-ASCII character is counted as wide, so
/// a row never spills onto a second terminal row and the row count (which
/// decides the "scroll up" note) never undercounts.
fn columns(ch: char) -> usize {
    if ch.is_ascii() { 1 } else { 2 }
}

/// `text` cut into rows of at most `width` columns.
fn wrap(text: &str, width: usize, indent: &str, rows: &mut Vec<String>) {
    let width = width.saturating_sub(indent.chars().count()).max(2);
    for line in text.split('\n') {
        let mut row = String::new();
        let mut used = 0;
        for ch in line.chars() {
            if used + columns(ch) > width && !row.is_empty() {
                rows.push(format!("{indent}{row}"));
                row.clear();
                used = 0;
            }
            row.push(ch);
            used += columns(ch);
        }
        rows.push(format!("{indent}{row}"));
    }
}

/// The command as shown: escaped, and every run of two or more blank lines
/// collapsed into one marker row, so blank lines cannot push the rest of the
/// command (or the header) out of view.
fn command_text(command: &str) -> String {
    let escaped = crate::display_escape::escape_for_display(command);
    let mut out: Vec<String> = Vec::new();
    let mut blanks = 0usize;
    let flush = |blanks: usize, out: &mut Vec<String>| match blanks {
        0 => {}
        1 => out.push(String::new()),
        n => out.push(format!("\\u{{a}} x{n} (blank lines)")),
    };
    for line in escaped.split('\n') {
        if line.trim().is_empty() {
            blanks += 1;
            continue;
        }
        flush(blanks, &mut out);
        blanks = 0;
        out.push(line.to_string());
    }
    flush(blanks, &mut out);
    out.join("\n")
}

/// The confirm screen as plain rows (no terminal controls), laid out for
/// `cols` × `rows`. Every untrusted value is escaped so control, bidi and
/// invisible characters cannot hide part of the command. The header names
/// the command's size; the Enter/q prompt is always the last row, and when
/// the screen is taller than the terminal a note beside it says to scroll
/// up and read all of the command first.
pub fn layout(screen: &OperatorScreen, cols: u16, rows: u16) -> Vec<String> {
    let width = usize::from(cols.max(20));
    let mut out = Vec::new();
    let single = crate::display_escape::escape_single_line;
    let lines = screen.command.split('\n').count();
    let chars = screen.command.chars().count();
    wrap(
        &format!(
            "A step of {} needs you on {}.",
            single(&screen.handle),
            single(&screen.node)
        ),
        width,
        "",
        &mut out,
    );
    wrap(
        &format!(
            "Step: {} (node {} of the runtime)",
            phase_name(screen.phase),
            u16::from(screen.rank) + 1
        ),
        width,
        "",
        &mut out,
    );
    wrap(
        &format!(
            "This command will run here (written by {}; {lines} lines, {chars} characters):",
            author_text(screen.author)
        ),
        width,
        "",
        &mut out,
    );
    wrap(
        "What you type (a sudo password too) passes through the server and this page to the command.",
        width,
        "",
        &mut out,
    );
    out.push(String::new());
    wrap(&command_text(&screen.command), width, "    ", &mut out);
    out.push(String::new());
    let prompt = "Press Enter to run it here. Press q to close without running.";
    let mut tail = Vec::new();
    wrap(prompt, width, "", &mut tail);
    if out.len() + tail.len() > usize::from(rows.max(1)) {
        let mut note = Vec::new();
        wrap(
            &format!(
                "The command is {lines} lines ({chars} characters): scroll up to read all of it."
            ),
            width,
            "",
            &mut note,
        );
        out.extend(note);
    }
    out.extend(tail);
    out
}

/// The screen as terminal output: clear, then the rows (no line break after
/// the last, so the prompt stays on the bottom row).
pub fn paint(screen: &OperatorScreen, cols: u16, rows: u16) -> Vec<u8> {
    format!("\x1b[H\x1b[2J{}", layout(screen, cols, rows).join("\r\n")).into_bytes()
}

/// A decisive key on the confirm screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmKey {
    Accept,
    Decline,
}

/// The first decisive key in `bytes`: Enter accepts; `q`, `Q`, Ctrl-C and
/// Ctrl-D decline; everything else is ignored.
pub fn confirm_key(bytes: &[u8]) -> Option<ConfirmKey> {
    bytes.iter().find_map(|byte| match byte {
        b'\r' | b'\n' => Some(ConfirmKey::Accept),
        b'q' | b'Q' | 0x03 | 0x04 => Some(ConfirmKey::Decline),
        _ => None,
    })
}

/// What an operator terminal tells its step's runner thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperatorEvent {
    /// A person pressed Enter; the command runs in a fresh PTY.
    Accepted,
    /// The command exited 0: check the proof.
    ExitedOk,
    /// The terminal ended without success; `operator_closed` was sent.
    Closed,
}

/// A runner thread's request to open an operator terminal.
#[derive(Clone)]
pub struct OperatorOpen {
    pub ids: OperatorIds,
    pub screen: OperatorScreen,
    /// The environment the command runs with (node secrets included: never
    /// printed, see the `Debug` impl).
    pub env: Vec<(String, String)>,
    pub events: SyncSender<OperatorEvent>,
}

impl std::fmt::Debug for OperatorOpen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorOpen")
            .field("ids", &self.ids)
            .finish_non_exhaustive()
    }
}

/// How a step's runner thread reaches the relay loop that owns terminals.
pub trait OperatorLink {
    /// Ask for the step's operator terminal; its events arrive on `events`.
    fn open(&self, job: &Job, events: SyncSender<OperatorEvent>) -> Result<(), JobError>;
    /// The step was cancelled: close the terminal unless its command runs.
    fn close_if_confirming(&self);
}

/// How often a waiting step looks at its cancel flag.
const CANCEL_POLL: Duration = Duration::from_millis(200);

/// One interactive step under its rank's locks (`super::runner`).
///
/// Status first: a start or after-join whose service is already alive, or a
/// stop whose service is already stopped, settles without a person (a stop
/// still tears down the units it owns and proves the stop). Otherwise the
/// operator terminal opens and the thread waits, without a deadline, for its
/// person. A stop for the rank (`cancel`) closes a terminal that still shows
/// its confirm screen; a person's accepted run is never cut off, and its
/// proof runs on `verifying` (no cancel flag) with the step's own timeout
/// from the moment the command ended. `None`: the terminal ended without
/// success and the relay loop already answered `operator_closed`.
pub fn run_operator<R: Runtime>(
    executor: &mut Executor,
    job: Job,
    checking: &R,
    verifying: &R,
    link: &impl OperatorLink,
    cancel: &AtomicBool,
) -> Option<Outcome> {
    let budget = Duration::from_millis(job.timeout_ms);
    if executor.done(&job).is_some() {
        return Some(executor.execute(job, checking, Deadline::new(budget)));
    }
    let probe = Deadline::new(STATUS_FIRST_LIMIT.min(budget));
    let status = job
        .status_command
        .as_deref()
        .map(|status| checking.status_until(&job, status, probe));
    match (job.action, status) {
        (JobPhase::Start | JobPhase::AfterJoin, Some(Ok(true))) => {
            return Some(executor.execute(
                job,
                &OperatorRan { inner: checking },
                Deadline::new(budget),
            ));
        }
        (JobPhase::Stop, Some(Ok(false))) => {
            // Already stopped: the owned units go and status proves it.
            return Some(executor.execute(
                job,
                &OperatorRan { inner: checking },
                Deadline::new(budget),
            ));
        }
        _ => {}
    }
    if cancel.load(Ordering::SeqCst) {
        return Some(Outcome::failed(JobError::SessionDisconnected));
    }
    // Durable before a person can run anything.
    let mark = match executor.begin_operator(&job) {
        Ok(mark) => mark,
        Err(error) => return Some(Outcome::failed(error)),
    };
    let (events_tx, events) = std::sync::mpsc::sync_channel(8);
    if let Err(error) = link.open(&job, events_tx) {
        executor.abandon_operator(&job, mark, false);
        return Some(Outcome::failed(error));
    }
    let mut accepted = false;
    let mut close_asked = false;
    let ended_ok = loop {
        let event = match events.recv_timeout(CANCEL_POLL) {
            Ok(event) => event,
            Err(RecvTimeoutError::Disconnected) => break false,
            Err(RecvTimeoutError::Timeout) => {
                if accepted || close_asked || !cancel.load(Ordering::SeqCst) {
                    continue;
                }
                // An Enter already queued wins over the cancel.
                match events.try_recv() {
                    Ok(event) => event,
                    Err(_) => {
                        link.close_if_confirming();
                        close_asked = true;
                        continue;
                    }
                }
            }
        };
        match event {
            OperatorEvent::Accepted => accepted = true,
            OperatorEvent::ExitedOk => break true,
            OperatorEvent::Closed => break false,
        }
    };
    if !ended_ok {
        executor.abandon_operator(&job, mark, accepted);
        return None;
    }
    // A stop's command ran in the terminal; `OperatorRan` never repeats it.
    Some(executor.execute(
        job,
        &OperatorRan { inner: verifying },
        Deadline::new(budget),
    ))
}

/// How long the status-first check may take.
const STATUS_FIRST_LIMIT: Duration = Duration::from_secs(30);

/// The wire exit code of a command: its status, or 128 + its signal.
pub fn exit_code(status: (Option<i32>, Option<i32>)) -> Option<u8> {
    match status {
        (Some(code), _) => u8::try_from(code).ok(),
        (None, Some(signal)) => u8::try_from(128 + signal).ok(),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests;
