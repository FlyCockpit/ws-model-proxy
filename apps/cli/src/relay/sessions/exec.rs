//! Node commands (`exec.*`): each runs in its own process group (Unix) or job (Windows) until
//! it ends or its deadline passes, with masked output kept for `exec.poll`.

#[cfg(windows)]
use crate::process::job_tree::Child as ExecChild;
use std::collections::{BTreeMap, VecDeque};
#[cfg(windows)]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
/// Registered with the subreaper, so its scan never reaps the command.
type ExecChild = crate::process::subreaper::Owned<std::process::Child>;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(unix)]
use super::children::kill_process_group;
use super::children::{LiveChild, LiveChildGuard, status_parts};
use super::pump::pump_exec_reader;
use super::{
    Lifecycle, OutboundFrame, REASON_ALREADY_OPEN, REASON_BAD_COMMAND, REASON_BAD_CWD,
    REASON_LIMIT, REASON_SHELL_UNAVAILABLE, REASON_SPAWN_FAILED, REASON_TRUST_RELAY, signal_token,
    user_home, valid_id, wire_exit_code,
};
use crate::process::child_env::{self, scrub_parent_env};
use crate::relay::startup::TerminalStartup;
use crate::services::output_mask::StreamMasker;
use crate::services::relay_bus::FromWorker;
use crate::wire::protocol::NodeFrame;
use crate::wire::protocol::frames::{
    ExecState, ExecStatus, NODE_COMMAND_MAX_MS, NODE_COMMAND_TAIL_MAX_BYTES, RanMode, RanWith,
};
use crate::wire::protocol::runtime_spec::CommandShell;

const MAX_EXECS: usize = 8;
/// A node command's longest lifetime until the node definition says otherwise.
pub(crate) const DEFAULT_COMMAND_MAX: Duration = Duration::from_millis(NODE_COMMAND_MAX_MS);
/// After the child exits, keep the exec slot until both pipes report EOF, or
/// this long, whichever comes first. A grandchild that holds a pipe must not
/// stall the slot; the leftover bytes are then dropped.
const EXEC_OUTPUT_DRAIN: Duration = Duration::from_millis(500);

/// One info line per command operation (`exec`):
/// the operation, the relay command id and a stable outcome code. Never the
/// command text, cwd, environment or output (the server's audit log holds a
/// hash of the command text plus its program name; this log is the CLI-side
/// record of what happened).
fn log_command_op(op: &'static str, command_id: &str, outcome: &str) {
    tracing::info!(op, command_id, outcome, "command operation");
}

fn rejected_outcome(reason: &str) -> String {
    format!("rejected:{reason}")
}

fn done_outcome(exit_code: Option<i32>, signal: Option<i32>, cause: EndCause) -> String {
    if cause == EndCause::TimedOut {
        "timed_out".to_string()
    } else if cause == EndCause::Cancelled {
        "cancelled".to_string()
    } else if cause == EndCause::Interrupted {
        "interrupted".to_string()
    } else if let Some(code) = exit_code {
        format!("exited:{code}")
    } else if let Some(signal) = signal {
        format!("signaled:{signal}")
    } else {
        "ended".to_string()
    }
}

fn exec_rejected(command_id: &str, reason: &str) -> OutboundFrame {
    log_command_op("exec", command_id, &rejected_outcome(reason));
    OutboundFrame::Control(NodeFrame::ExecRejected {
        command_id: command_id.to_string(),
        reason: reason.to_string(),
    })
}

/// Masked output a command keeps for `exec.poll` (a ring: the newest bytes).
const EXEC_OUTPUT_RING_BYTES: usize = 1024 * 1024;
/// Ended commands whose status `exec.poll` still answers.
const EXEC_RECENT_MAX: usize = 64;
/// The tail an unprompted end status carries.
const EXEC_END_TAIL_BYTES: usize = 4 * 1024;

/// The newest masked output bytes of one command, stdout and stderr in the
/// order they were read.
#[derive(Default)]
struct OutputRing {
    bytes: VecDeque<u8>,
    total: u64,
}

impl OutputRing {
    fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len() as u64);
        self.bytes.extend(bytes);
        let overflow = self.bytes.len().saturating_sub(EXEC_OUTPUT_RING_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }
    }

    /// The last at most `max` bytes as text, cut on a character boundary.
    fn tail(&self, max: usize) -> String {
        let start = self.bytes.len().saturating_sub(max);
        let raw = self.bytes.iter().skip(start).copied().collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&raw).into_owned();
        // Lossy decoding can grow the text; keep it within `max`.
        let mut cut = text.len().saturating_sub(max);
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        text[cut..].to_string()
    }
}

struct ExecSession {
    child: ExecChild,
    /// Reader threads exit on their own and are never joined: a grandchild that left the
    /// process group may still hold a pipe.
    _stdout_thread: JoinHandle<()>,
    _stderr_thread: JoinHandle<()>,
    stop: Arc<AtomicBool>,
    /// The end of this command's lifetime: its `timeout_ms`, capped by the
    /// node's `command_max_ms`.
    deadline: Instant,
    started_at: String,
    ends_by: String,
    /// Independent restartable state: stdout cannot open a run on stderr.
    stdout_mask: StreamMasker,
    stderr_mask: StreamMasker,
    output: OutputRing,
    pipes: ExecPipes,
    phase: ExecPhase,
    pid: u32,
    /// Its start time, read once at spawn (the leader may be reaped later).
    start_ticks: Option<u64>,
    _tracked: LiveChildGuard,
    /// The PowerShell script the command runs, removed with the session.
    _script: Option<ScriptFile>,
}

/// A process's exit code and signal, as [`status_parts`] reads them.
type ExitParts = (Option<i32>, Option<i32>);

/// Which of a command's output pipes reached EOF. Pipes close independently of the process
/// (`sleep >/dev/null` closes both and keeps running), so they are not part of [`ExecPhase`].
#[derive(Default)]
struct ExecPipes {
    stdout: bool,
    stderr: bool,
}

impl ExecPipes {
    fn drained(&self) -> bool {
        self.stdout && self.stderr
    }
}

/// Where a running command is in its life. A session leaves the registry when it completes,
/// so there is no "finished" phase: late reader bytes or EOFs for its id find nothing.
///
/// ```text
/// Running --deadline, not reaped--> TimedOut --reaped--> Reaped { timed_out: true }
/// Running --deadline, reaped at once------------------> Reaped { timed_out: true }
/// Running --reaped----------------------------------> Reaped { timed_out: false }
/// Reaped --both pipes closed, or EXEC_OUTPUT_DRAIN--> completed (removed)
/// any phase --cancel or shutdown--> completed (removed)
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExecPhase {
    /// The direct child runs and its deadline has not passed.
    Running,
    /// The deadline passed and the node killed the process group, but the direct child is not
    /// reaped yet. Its pid is still ours, so a later kill may signal it.
    TimedOut,
    /// `try_wait` reaped the direct child at `at`. Its pid may name another process now and is
    /// never signalled again; the output drains until both pipes close or
    /// [`EXEC_OUTPUT_DRAIN`] passes. `timed_out`: the node killed it at its deadline. A child
    /// reaped before its deadline stays `timed_out: false` if the deadline passes while its
    /// output drains.
    Reaped {
        status: ExitParts,
        at: Instant,
        timed_out: bool,
    },
}

impl ExecPhase {
    /// The direct child is reaped: its pid must not be signalled.
    fn reaped(&self) -> bool {
        matches!(self, Self::Reaped { .. })
    }

    /// The node already ended the command at its deadline.
    fn timed_out(&self) -> bool {
        matches!(
            self,
            Self::TimedOut
                | Self::Reaped {
                    timed_out: true,
                    ..
                }
        )
    }

    /// Why the command ended when `requested` ends it now ([`EndCause::Exited`] when it
    /// completes on its own).
    ///
    /// Precedence: a timeout the node already acted on wins (the command was killed at its
    /// deadline, before any later cancel or shutdown), then the requested cause (a cancel or
    /// a shutdown cuts the output drain short, so it is reported even after the child
    /// exited), then a plain exit.
    fn end_cause(&self, requested: EndCause) -> EndCause {
        if self.timed_out() {
            EndCause::TimedOut
        } else {
            requested
        }
    }
}

impl ExecSession {
    /// End the command's process tree. The leader's pid is signalled directly only until it
    /// is reaped (a reaped pid may name another process).
    fn kill_tree(&mut self) {
        kill_exec(self.pid, Some(&mut self.child), !self.phase.reaped());
    }

    /// The direct child's exit status: the one already reaped, or what reaping it now gives.
    fn reap_now(&mut self) -> ExitParts {
        match self.phase {
            ExecPhase::Reaped { status, .. } => status,
            ExecPhase::Running | ExecPhase::TimedOut => reap_child(&mut self.child),
        }
    }

    /// One `poll` step: kill at the deadline, reap, and say whether the command is complete
    /// (its status and why it ended).
    fn advance(&mut self, now: Instant) -> Option<(ExitParts, EndCause)> {
        match self.phase {
            ExecPhase::Running if now >= self.deadline => {
                self.kill_tree();
                let status = reap_child(&mut self.child);
                self.phase = if status.0.is_some() || status.1.is_some() {
                    ExecPhase::Reaped {
                        status,
                        at: now,
                        timed_out: true,
                    }
                } else {
                    ExecPhase::TimedOut
                };
            }
            ExecPhase::Running | ExecPhase::TimedOut => {
                if let Ok(Some(status)) = self.child.try_wait() {
                    // The direct child is already reaped. Kill grandchildren
                    // that stayed in its group, without signalling the pid
                    // itself again.
                    #[cfg(not(windows))]
                    kill_exec(self.pid, None, false);
                    #[cfg(windows)]
                    kill_exec(self.pid, Some(&mut self.child), false);
                    self.phase = ExecPhase::Reaped {
                        status: status_parts(status),
                        at: now,
                        timed_out: self.phase.timed_out(),
                    };
                }
            }
            ExecPhase::Reaped { .. } => {}
        }
        let ExecPhase::Reaped { status, at, .. } = self.phase else {
            return None;
        };
        let waited = now.saturating_duration_since(at) >= EXEC_OUTPUT_DRAIN;
        (self.pipes.drained() || waited).then(|| (status, self.phase.end_cause(EndCause::Exited)))
    }
}

/// A command's script file, removed when dropped.
#[cfg_attr(not(windows), allow(dead_code))]
struct ScriptFile(PathBuf);

impl Drop for ScriptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A node command ready to start: its program and arguments, the script file it reads, and how
/// it runs (`exec.started`'s `ranWith`).
struct ExecProcess {
    process: std::process::Command,
    script: Option<ScriptFile>,
    ran_with: RanWith,
}

/// `ran_with` for a command `shell` reads.
fn in_shell(shell: CommandShell) -> RanWith {
    RanWith {
        shell: Some(shell),
        mode: RanMode::Shell,
    }
}

/// A command that ended, kept for `exec.poll`.
struct EndedCommand {
    status: ExecStatus,
    output: OutputRing,
}

/// How a command ended, when the node itself ended it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EndCause {
    /// It exited (or the node saw it gone).
    Exited,
    Cancelled,
    TimedOut,
    /// The daemon shut down with the command running.
    Interrupted,
}

pub(crate) struct ExecRegistry {
    sessions: BTreeMap<String, ExecSession>,
    ended: VecDeque<(String, EndedCommand)>,
    tx: SyncSender<FromWorker>,
    /// The node's `command_max_ms`: no command lives longer.
    command_max: Duration,
    lifecycle: Lifecycle,
    /// `node-commands.json`: the commands running now, so a daemon that died
    /// can report them `interrupted` (and end their process groups) when it
    /// starts again. `None` in tests that do not persist.
    table: Option<PathBuf>,
    /// Where a PowerShell command's script is written (Windows): beside the table, in the state
    /// directory; in the temporary directory in tests that do not persist.
    scripts: PathBuf,
}

/// Remove the scripts commands left in `dir` (`<command id>.ps1`).
fn sweep_scripts(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "ps1") {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// One running command as persisted (no command text, no output).
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunningCommand {
    command_id: String,
    pid: u32,
    /// `/proc/<pid>/stat` start time, so a reused pid is never signalled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_ticks: Option<u64>,
    started_at: String,
    ends_by: String,
}

#[cfg(target_os = "linux")]
fn process_start_ticks(pid: u32) -> Option<u64> {
    crate::process::process_list::start_ticks(pid)
}

#[cfg(not(target_os = "linux"))]
fn process_start_ticks(_pid: u32) -> Option<u64> {
    None
}

/// The leader is gone but members of its process group, started no earlier
/// than it, remain (a background child of the command).
#[cfg(target_os = "linux")]
fn group_outlived_leader(pgid: u32, leader_ticks: u64) -> bool {
    if std::path::Path::new(&format!("/proc/{pgid}")).exists() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            return false;
        };
        let Ok(stat) = std::fs::read(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some(fields) = crate::process::process_list::stat_fields(&stat) else {
            return false;
        };
        let fields: Vec<&str> = fields.collect();
        // After `pid (comm)`: state ppid pgrp ... starttime is the 20th.
        fields.get(2).and_then(|pgrp| pgrp.parse::<u32>().ok()) == Some(pgid)
            && fields
                .get(19)
                .and_then(|ticks| ticks.parse::<u64>().ok())
                .is_some_and(|ticks| ticks >= leader_ticks)
    })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn group_outlived_leader(_pgid: u32, _leader_ticks: u64) -> bool {
    false
}

impl ExecRegistry {
    pub(crate) fn new(tx: SyncSender<FromWorker>, command_max: Duration) -> Self {
        Self {
            sessions: BTreeMap::new(),
            ended: VecDeque::new(),
            tx,
            command_max,
            lifecycle: Lifecycle::Open,
            table: None,
            scripts: std::env::temp_dir().join(format!("wsmp-exec-scripts-{}", std::process::id())),
        }
    }

    /// Persist running commands to `path`, and report the ones a previous
    /// daemon left running as `interrupted`: their process groups are ended
    /// first (only when the pid still names the same process).
    pub(crate) fn with_table(mut self, path: PathBuf) -> (Self, Vec<OutboundFrame>) {
        let left: Vec<RunningCommand> = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let mut frames = Vec::new();
        for command in left {
            if !valid_id(&command.command_id) {
                continue;
            }
            #[cfg(unix)]
            if let Some(ticks) = command.start_ticks
                && (process_start_ticks(command.pid) == Some(ticks)
                    || group_outlived_leader(command.pid, ticks))
            {
                kill_process_group(command.pid, false);
            }
            let status = ExecStatus {
                command_id: command.command_id.clone(),
                state: ExecState::Interrupted,
                exit_code: None,
                signal: None,
                started_at: Some(command.started_at),
                ends_by: Some(command.ends_by),
                finished_at: Some(crate::time::now_rfc3339()),
                tail: None,
                truncated: None,
                output_bytes: None,
            };
            log_command_op("exec", &command.command_id, "interrupted by a restart");
            self.ended.push_back((
                command.command_id,
                EndedCommand {
                    status: status.clone(),
                    output: OutputRing::default(),
                },
            ));
            frames.push(OutboundFrame::Control(NodeFrame::ExecStatus(status)));
        }
        while self.ended.len() > EXEC_RECENT_MAX {
            self.ended.pop_front();
        }
        // A command's script lives beside the table and goes with the command. Every command a
        // previous daemon started has ended by now: what it left (a crash) holds command text.
        if let Some(dir) = path.parent() {
            self.scripts = dir.join("exec-scripts");
            sweep_scripts(&self.scripts);
        }
        self.table = Some(path);
        self.save_table();
        (self, frames)
    }

    /// The node definition's `commandMaxMs` (applies to later commands).
    /// Node commands running now.
    pub(crate) fn running(&self) -> usize {
        self.sessions.len()
    }

    pub(crate) fn set_command_max(&mut self, command_max: Duration) {
        self.command_max = command_max.min(DEFAULT_COMMAND_MAX);
    }

    fn save_table(&self) {
        if self.lifecycle.is_shut_down() {
            // `kill_all` wrote the rows the next daemon reports.
            return;
        }
        let running: Vec<RunningCommand> = self
            .sessions
            .iter()
            .map(|(id, session)| RunningCommand {
                command_id: id.clone(),
                pid: session.pid,
                start_ticks: session.start_ticks,
                started_at: session.started_at.clone(),
                ends_by: session.ends_by.clone(),
            })
            .collect();
        self.write_rows(&running);
    }

    fn write_rows(&self, running: &[RunningCommand]) {
        let Some(path) = &self.table else {
            return;
        };
        let written = serde_json::to_vec(running)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| {
                crate::node::approvals::write_private_atomic(path, &bytes, "node commands", false)
            });
        if let Err(error) = written {
            tracing::warn!(error = %format!("{error:#}"), "recording running commands failed");
        }
    }

    /// The daemon is shutting down: end every command. Their rows stay in
    /// the table (without a start time, so nothing is signalled again) and
    /// the next daemon reports them `interrupted` too, in case this
    /// connection could not.
    pub(crate) fn kill_all(&mut self) -> Vec<OutboundFrame> {
        if !self.lifecycle.shut_down() {
            return Vec::new();
        }
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let rows: Vec<RunningCommand> = self
            .sessions
            .iter()
            .map(|(id, session)| RunningCommand {
                command_id: id.clone(),
                pid: session.pid,
                start_ticks: None,
                started_at: session.started_at.clone(),
                ends_by: session.ends_by.clone(),
            })
            .collect();
        let mut frames = Vec::new();
        for id in ids {
            frames.extend(self.finish(&id, EndCause::Interrupted));
        }
        self.write_rows(&rows);
        frames
    }

    /// Lowering to Relay only: end every running command (its whole process
    /// tree) and report each `interrupted`. The registry keeps answering polls.
    pub(crate) fn interrupt_all(&mut self) -> Vec<OutboundFrame> {
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let mut frames = Vec::new();
        for id in ids {
            frames.extend(self.finish(&id, EndCause::Interrupted));
        }
        frames
    }

    pub(crate) fn start(
        &mut self,
        startup: &TerminalStartup,
        command_id: &str,
        line: &ExecLine<'_>,
        shell: Option<CommandShell>,
        cwd: Option<&str>,
        timeout_ms: u64,
    ) -> Vec<OutboundFrame> {
        if !valid_id(command_id) {
            return vec![exec_rejected(command_id, REASON_BAD_COMMAND)];
        }
        // After `kill_all` nothing new starts: such a command would run unrecorded (the table
        // is final) and outlive the shutdown.
        if self.lifecycle.is_shut_down() {
            tracing::warn!(command_id, "rejecting an exec after shutdown");
            return vec![exec_rejected(command_id, REASON_SPAWN_FAILED)];
        }
        // Commands run only at Full control.
        if !startup.full_control() {
            return vec![exec_rejected(command_id, REASON_TRUST_RELAY)];
        }
        if self.sessions.contains_key(command_id) {
            return vec![exec_rejected(command_id, REASON_ALREADY_OPEN)];
        }
        if self.sessions.len() >= MAX_EXECS {
            return vec![exec_rejected(command_id, REASON_LIMIT)];
        }
        let checked = match line {
            ExecLine::Text(command) => child_env::validate_command(command),
            ExecLine::Argv(argv) => child_env::validate_argv(argv),
        };
        if let Err(reason) = checked {
            tracing::warn!(command_id, reason, "rejecting an exec command");
            return vec![exec_rejected(command_id, REASON_BAD_COMMAND)];
        }
        let process = match exec_process(line, shell, &self.scripts) {
            Ok(process) => process,
            Err((reason, why)) => {
                tracing::warn!(command_id, why, "rejecting an exec command");
                return vec![exec_rejected(command_id, reason)];
            }
        };
        let home = match user_home() {
            Ok(path) => path,
            Err(reason) => {
                tracing::warn!(command_id, reason, "rejecting an exec command");
                return vec![exec_rejected(command_id, REASON_BAD_CWD)];
            }
        };
        let cwd = match child_env::resolve_cwd(cwd, &home) {
            Ok(path) => path,
            Err(reason) => {
                tracing::warn!(command_id, reason, "rejecting an exec working directory");
                return vec![exec_rejected(command_id, REASON_BAD_CWD)];
            }
        };
        let lifetime = Duration::from_millis(timeout_ms).min(self.command_max);
        let ran_with = process.ran_with;
        match spawn_exec(&self.tx, command_id, process, &line.text(), &cwd, lifetime) {
            Ok(session) => {
                let frame = NodeFrame::ExecStarted {
                    command_id: command_id.to_string(),
                    started_at: session.started_at.clone(),
                    ends_by: session.ends_by.clone(),
                    ran_with,
                };
                // A restarted command id replaces its ended record.
                self.ended.retain(|(id, _)| id != command_id);
                self.sessions.insert(command_id.to_string(), session);
                self.save_table();
                log_command_op("exec", command_id, "started");
                vec![OutboundFrame::Control(frame)]
            }
            Err(error) => {
                tracing::warn!(error = %error, command_id, "starting an exec failed");
                vec![exec_rejected(command_id, REASON_SPAWN_FAILED)]
            }
        }
    }

    /// [`Self::start`] for a text command in the default shell.
    #[cfg(test)]
    pub(crate) fn start_text(
        &mut self,
        startup: &TerminalStartup,
        command_id: &str,
        command: &str,
        cwd: Option<&str>,
        timeout_ms: u64,
    ) -> Vec<OutboundFrame> {
        self.start(
            startup,
            command_id,
            &ExecLine::Text(command),
            None,
            cwd,
            timeout_ms,
        )
    }

    pub(crate) fn cancel(&mut self, command_id: &str) -> Vec<OutboundFrame> {
        self.finish(command_id, EndCause::Cancelled)
    }

    /// `exec.poll`: the command's state and the last `tail_bytes` of its
    /// masked output. An unknown id answers `unknown`.
    pub(crate) fn status(&self, command_id: &str, tail_bytes: usize) -> Vec<OutboundFrame> {
        let tail_bytes = tail_bytes.min(NODE_COMMAND_TAIL_MAX_BYTES);
        let status = if let Some(session) = self.sessions.get(command_id) {
            with_tail(
                ExecStatus {
                    command_id: command_id.to_string(),
                    state: ExecState::Running,
                    exit_code: None,
                    signal: None,
                    started_at: Some(session.started_at.clone()),
                    ends_by: Some(session.ends_by.clone()),
                    finished_at: None,
                    tail: None,
                    truncated: None,
                    output_bytes: None,
                },
                &session.output,
                tail_bytes,
            )
        } else if let Some((_, ended)) = self.ended.iter().find(|(id, _)| id == command_id) {
            with_tail(ended.status.clone(), &ended.output, tail_bytes)
        } else {
            ExecStatus {
                command_id: command_id.to_string(),
                state: ExecState::Unknown,
                exit_code: None,
                signal: None,
                started_at: None,
                ends_by: None,
                finished_at: Some(crate::time::now_rfc3339()),
                tail: None,
                truncated: None,
                output_bytes: None,
            }
        };
        vec![OutboundFrame::Control(NodeFrame::ExecStatus(status))]
    }

    /// An `exec.start` the daemon could not read (for example a string with
    /// an unpaired surrogate): refuse it so the server's request ends now.
    /// Nothing runs. A command already running under that id is untouched.
    pub(crate) fn reject_malformed(&self, command_id: &str) -> Vec<OutboundFrame> {
        if !valid_id(command_id) || self.sessions.contains_key(command_id) {
            return Vec::new();
        }
        vec![exec_rejected(command_id, REASON_BAD_COMMAND)]
    }

    pub(crate) fn on_bytes(&mut self, command_id: &str, stderr: bool, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let Some(session) = self.sessions.get_mut(command_id) else {
            return;
        };
        let masked = if stderr {
            session.stderr_mask.push(bytes)
        } else {
            session.stdout_mask.push(bytes)
        };
        session.output.push(&masked);
    }

    pub(crate) fn on_eof(&mut self, command_id: &str, stderr: bool) {
        let Some(session) = self.sessions.get_mut(command_id) else {
            return;
        };
        let masked = if stderr {
            session.pipes.stderr = true;
            session.stderr_mask.finish()
        } else {
            session.pipes.stdout = true;
            session.stdout_mask.finish()
        };
        // Pipes can close while the process is still running (`sleep
        // >/dev/null`). Reaping happens on `poll` via `try_wait`.
        session.output.push(&masked);
    }

    pub(crate) fn poll(&mut self, now: Instant) -> Vec<OutboundFrame> {
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let mut frames = Vec::new();
        for id in ids {
            let Some(session) = self.sessions.get_mut(&id) else {
                continue;
            };
            if let Some((status, cause)) = session.advance(now) {
                frames.extend(self.complete(&id, status, cause));
            }
        }
        frames
    }

    /// End a command now (`requested`: a cancel or a shutdown). The cause reported follows
    /// [`ExecPhase::end_cause`].
    fn finish(&mut self, command_id: &str, requested: EndCause) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(command_id) else {
            return Vec::new();
        };
        session.stop.store(true, Ordering::SeqCst);
        session.kill_tree();
        let status = session.reap_now();
        let cause = session.phase.end_cause(requested);
        self.complete(command_id, status, cause)
    }

    fn complete(
        &mut self,
        command_id: &str,
        status: (Option<i32>, Option<i32>),
        cause: EndCause,
    ) -> Vec<OutboundFrame> {
        let Some(mut session) = self.sessions.remove(command_id) else {
            return Vec::new();
        };
        self.save_table();
        // Completion/cancel/drain timeout can precede pipe EOF. Keep every
        // held masked tail; late worker bytes cannot reopen a stream.
        for stderr in [false, true] {
            let masked = if stderr {
                session.stderr_mask.finish()
            } else {
                session.stdout_mask.finish()
            };
            session.output.push(&masked);
        }
        session.stop.store(true, Ordering::SeqCst);
        let (state, exit_code) = match cause {
            EndCause::Cancelled => (ExecState::Cancelled, None),
            EndCause::TimedOut => (ExecState::TimedOut, None),
            EndCause::Interrupted => (ExecState::Interrupted, None),
            EndCause::Exited => match status {
                (Some(0), _) => (ExecState::Succeeded, Some(0)),
                (Some(code), _) => (ExecState::Failed, wire_exit_code(Some(code))),
                (None, _) => (ExecState::Failed, None),
            },
        };
        log_command_op("exec", command_id, &done_outcome(status.0, status.1, cause));
        let ended = ExecStatus {
            command_id: command_id.to_string(),
            state,
            exit_code,
            signal: signal_token(status.1),
            started_at: Some(session.started_at.clone()),
            ends_by: Some(session.ends_by.clone()),
            finished_at: Some(crate::time::now_rfc3339()),
            tail: None,
            truncated: None,
            output_bytes: None,
        };
        let frame = with_tail(ended.clone(), &session.output, EXEC_END_TAIL_BYTES);
        self.ended.retain(|(id, _)| id != command_id);
        // A poll reads at most the last 64 KiB: keep only that much.
        let mut output = std::mem::take(&mut session.output);
        let excess = output
            .bytes
            .len()
            .saturating_sub(NODE_COMMAND_TAIL_MAX_BYTES);
        output.bytes.drain(..excess);
        self.ended.push_back((
            command_id.to_string(),
            EndedCommand {
                status: ended,
                output,
            },
        ));
        while self.ended.len() > EXEC_RECENT_MAX {
            self.ended.pop_front();
        }
        vec![OutboundFrame::Control(NodeFrame::ExecStatus(frame))]
    }

    #[cfg(test)]
    pub(super) fn pid(&self, command_id: &str) -> Option<u32> {
        self.sessions.get(command_id).map(|session| session.pid)
    }
}

impl Drop for ExecRegistry {
    fn drop(&mut self) {
        let _ = self.kill_all();
    }
}

/// `status` with the output tail, shrunk until the frame fits one control
/// frame (escaping can grow text past its byte count).
fn with_tail(mut status: ExecStatus, output: &OutputRing, max: usize) -> ExecStatus {
    status.output_bytes = Some(output.total);
    let mut max = max.min(NODE_COMMAND_TAIL_MAX_BYTES);
    loop {
        let tail = output.tail(max);
        status.truncated = Some((tail.len() as u64) < output.total);
        status.tail = (!tail.is_empty()).then_some(tail);
        let fits = serde_json::to_string(&NodeFrame::ExecStatus(status.clone()))
            .is_ok_and(|text| text.len() <= crate::wire::protocol::RELAY_JSON_CONTROL_MAX_BYTES);
        if fits || max == 0 {
            return status;
        }
        max /= 2;
    }
}

fn reap_child(child: &mut ExecChild) -> (Option<i32>, Option<i32>) {
    for _ in 0..32 {
        if let Ok(Some(status)) = child.try_wait() {
            return status_parts(status);
        }
        std::thread::yield_now();
    }
    for _ in 0..20 {
        if let Ok(Some(status)) = child.try_wait() {
            return status_parts(status);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    (None, None)
}

fn kill_exec(pid: u32, child: Option<&mut ExecChild>, fallback_to_pid: bool) {
    #[cfg(unix)]
    {
        kill_process_group(pid, fallback_to_pid);
        let _ = child;
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, fallback_to_pid);
        if let Some(child) = child {
            let _ = child.job().terminate();
        }
    }
}

/// What an `exec.start` runs: text for a shell, or a program and its arguments.
pub(crate) enum ExecLine<'a> {
    Text(&'a str),
    Argv(&'a [String]),
}

impl ExecLine<'_> {
    /// The command as one line (output masking hides secrets written in it).
    fn text(&self) -> String {
        match self {
            Self::Text(command) => (*command).to_string(),
            Self::Argv(argv) => argv.join(" "),
        }
    }
}

/// Why a node command did not start: its `exec.rejected` reason, and what the log says.
type NotStarted = (&'static str, &'static str);

/// The node has no such shell (`shell_unavailable`).
fn no_shell(why: &'static str) -> NotStarted {
    (REASON_SHELL_UNAVAILABLE, why)
}

/// The program and arguments of a node command, before its directory and environment. Text runs
/// in `shell` (absent: [`child_env::exec_shell`]); an argv starts its program directly, each
/// argument passed exactly. Errs when this node has no such shell.
#[cfg(not(windows))]
fn exec_process(
    line: &ExecLine<'_>,
    shell: Option<CommandShell>,
    _scripts: &Path,
) -> Result<ExecProcess, NotStarted> {
    if shell.is_some_and(|shell| shell != CommandShell::Sh) {
        return Err(no_shell("only `sh` runs commands here"));
    }
    let (process, ran_with) = match line {
        ExecLine::Text(command) => {
            let (program, flag) = child_env::exec_shell();
            let mut process = std::process::Command::new(program);
            process.arg(flag).arg(command);
            (process, in_shell(CommandShell::Sh))
        }
        ExecLine::Argv(argv) => {
            let (program, args) = argv
                .split_first()
                .ok_or((REASON_BAD_COMMAND, "the argv is empty"))?;
            let mut process = std::process::Command::new(program);
            process.args(args);
            (
                process,
                RanWith {
                    shell: None,
                    mode: RanMode::Direct,
                },
            )
        }
    };
    Ok(ExecProcess {
        process,
        script: None,
        ran_with,
    })
}

/// The program and arguments of a node command, before its directory and environment. Text runs
/// in `shell` (absent: `pwsh`, else `powershell`); `cmd` gets the text as written (`/d /s /c
/// "…"`, not quoted the way a C program reads its arguments). An argv starts an `.exe`
/// directly with each argument exact, a `.bat` or `.cmd` through std's batch-file escaping, and
/// anything else (a PowerShell command) in `shell` (absent: `pwsh`, else `powershell`), from a
/// script file in `scripts`. Errs when this node has no such shell, or the script cannot be
/// written.
#[cfg(windows)]
fn exec_process(
    line: &ExecLine<'_>,
    shell: Option<CommandShell>,
    scripts: &Path,
) -> Result<ExecProcess, NotStarted> {
    use crate::services::runtimes::executor::windows::{
        find_program, powershell_script, shell_program,
    };
    use rand::distr::{Alphanumeric, SampleString};
    use std::os::windows::process::CommandExt;
    let plain = |process, ran_with| {
        Ok(ExecProcess {
            process,
            script: None,
            ran_with,
        })
    };
    // The default, for text and argv alike (`default_shell`: PowerShell, never what `PATH` has).
    let default_shell = || {
        crate::services::runtimes::executor::windows::default_shell()
            .map_err(|_| no_shell("neither `pwsh` nor `powershell` is installed"))
    };
    let (shell, script) = match line {
        ExecLine::Text(command) => match shell {
            // Not one of the shells this node advertises (`features.launch.shells`).
            Some(CommandShell::Sh) => return Err(no_shell("`sh` is not a command shell here")),
            Some(CommandShell::Cmd) => {
                let mut process = std::process::Command::new(
                    shell_program(CommandShell::Cmd)
                        .map_err(|_| no_shell("`cmd` is not installed"))?,
                );
                process.raw_arg(format!("/d /s /c \"{command}\""));
                return plain(process, in_shell(CommandShell::Cmd));
            }
            Some(shell) => (shell, (*command).to_string()),
            None => (default_shell()?, (*command).to_string()),
        },
        ExecLine::Argv(argv) => {
            match shell {
                Some(CommandShell::Sh) => return Err(no_shell("an argv runs in PowerShell here")),
                Some(CommandShell::Cmd) => return Err(no_shell("cmd cannot run an argv")),
                _ => {}
            }
            // An `.exe` starts with each argument exact. So does a `.bat` or `.cmd` (npm, npx
            // and pnpm are such shims): std runs it in cmd with every argument escaped for cmd's
            // second parse (`%`, `^`, `&`, `"`), or refuses to start it when one cannot be.
            if let Some((program, args)) = argv.split_first()
                && let Some(found) = find_program(program, &scrub_parent_env(&[])).filter(|found| {
                    found
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| {
                            ["exe", "com", "bat", "cmd"]
                                .iter()
                                .any(|known| ext.eq_ignore_ascii_case(known))
                        })
                })
            {
                let ran_with = direct_ran_with(&found);
                let mut process = std::process::Command::new(found);
                process.args(args);
                return plain(process, ran_with);
            }
            // A PowerShell command, or a program not found: PowerShell runs it.
            let shell = match shell {
                Some(shell) => shell,
                None => default_shell()?,
            };
            let script = crate::process::child_env::argv_script(shell, argv)
                .ok_or(no_shell("cmd cannot run an argv"))?;
            (shell, script)
        }
    };
    let program = shell_program(shell).map_err(|_| no_shell("the shell is not installed"))?;
    // `-File`, not `-EncodedCommand`: given a command, PowerShell writes its error, warning and
    // progress streams to a redirected stderr as CLIXML. The file holds the command's text, so
    // it is in wsmp's own state directory, goes with the command, and a crash's leftovers go
    // when the next daemon starts (`ExecRegistry::with_table`). Its name is this node's own
    // random one: the server's command id never becomes a path.
    let unwritten = |error: std::io::Error| {
        tracing::warn!(error = %error, "writing an exec script failed");
        (
            REASON_SPAWN_FAILED,
            "the command's script could not be written",
        )
    };
    std::fs::create_dir_all(scripts).map_err(unwritten)?;
    let path = scripts.join(format!(
        "{}.ps1",
        Alphanumeric.sample_string(&mut rand::rng(), 24)
    ));
    let mut text = String::from('\u{feff}');
    text.push_str(&powershell_script(&script));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(unwritten)?;
    let script_file = ScriptFile(path);
    file.write_all(text.as_bytes()).map_err(unwritten)?;
    drop(file);
    let mut process = std::process::Command::new(program);
    process
        .args(["-NoLogo", "-NoProfile", "-NonInteractive"])
        // Process scope only: the script is this command, which `-Command` would run as well.
        .args(["-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script_file.0);
    Ok(ExecProcess {
        process,
        script: Some(script_file),
        ran_with: in_shell(shell),
    })
}

/// `ran_with` for an argv started as `program` (Windows): no shell for an `.exe` or `.com`; a
/// `.bat` or `.cmd` runs in cmd (std starts it there, each argument escaped for cmd).
#[cfg_attr(not(windows), allow(dead_code))]
fn direct_ran_with(program: &Path) -> RanWith {
    let batch = program
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("bat") || ext.eq_ignore_ascii_case("cmd"));
    RanWith {
        shell: batch.then_some(CommandShell::Cmd),
        mode: RanMode::Direct,
    }
}

fn spawn_exec(
    tx: &SyncSender<FromWorker>,
    command_id: &str,
    exec: ExecProcess,
    command: &str,
    cwd: &Path,
    lifetime: Duration,
) -> anyhow::Result<ExecSession> {
    let ExecProcess {
        mut process,
        script,
        ran_with: _,
    } = exec;
    process
        .current_dir(cwd)
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (name, value) in scrub_parent_env(&[]) {
        process.env(name, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    #[cfg(not(windows))]
    let mut child = crate::process::subreaper::spawn(|| process.spawn(), |child| Some(child.id()))?;
    #[cfg(windows)]
    let mut child = crate::process::job_tree::spawn_hidden(process)?;
    let pid = child.id();
    #[cfg(not(windows))]
    let tracked = LiveChildGuard::track(LiveChild::ExecGroup(pid));
    #[cfg(windows)]
    let tracked = LiveChildGuard::track(LiveChild::ExecJob(child.job()));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("exec stdout is missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("exec stderr is missing"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stdout_id = command_id.to_string();
    let stdout_eof = command_id.to_string();
    let stderr_id = command_id.to_string();
    let stderr_eof = command_id.to_string();
    let stdout_thread = pump_exec_reader(
        stdout,
        tx.clone(),
        Arc::clone(&stop),
        move |bytes| FromWorker::ExecBytes {
            command_id: stdout_id.clone(),
            stderr: false,
            bytes,
        },
        move || FromWorker::ExecEof {
            command_id: stdout_eof.clone(),
            stderr: false,
        },
    );
    let stderr_thread = pump_exec_reader(
        stderr,
        tx.clone(),
        Arc::clone(&stop),
        move |bytes| FromWorker::ExecBytes {
            command_id: stderr_id.clone(),
            stderr: true,
            bytes,
        },
        move || FromWorker::ExecEof {
            command_id: stderr_eof.clone(),
            stderr: true,
        },
    );
    let started = std::time::SystemTime::now();
    Ok(ExecSession {
        child,
        _stdout_thread: stdout_thread,
        _stderr_thread: stderr_thread,
        stop,
        deadline: Instant::now() + lifetime,
        started_at: crate::time::rfc3339(started),
        ends_by: crate::time::rfc3339(started + lifetime),
        stdout_mask: StreamMasker::new(command),
        stderr_mask: StreamMasker::new(command),
        output: OutputRing::default(),
        pipes: ExecPipes::default(),
        phase: ExecPhase::Running,
        pid,
        start_ticks: process_start_ticks(pid),
        _tracked: tracked,
        _script: script,
    })
}

#[cfg(test)]
mod tests;
