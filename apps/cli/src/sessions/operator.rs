//! Operator terminals: the PTY in which a person runs an interactive
//! deployment step (relay 2.4, `DeploymentJob.operator`).
//!
//! The deployment worker persists the pending step and checks status first;
//! only a step that still needs a person reaches [`TerminalRegistry::spawn_operator`].
//! The terminal runs `wsmp terminal supervised-run --deployment`, whose
//! markers (`ready -> accepted -> exited;<code>`, retried while the code is
//! not 0) become deployment progress for the server:
//!
//! - `ready` (the first, or after a failed run): `awaiting_operator`;
//! - `accepted`: a fresh `go` is written, then `operator_running`;
//! - `exited;<n>` with n != 0: `awaiting_operator` again (the child shows the
//!   failure and its retry screen);
//! - `exited;0` and the child itself exiting 0: only a trigger: the worker
//!   checks the recipe's status proof and sends the final result;
//! - anything else (declined, the terminal closed or cancelled, a malformed
//!   marker): `operator_closed` with the last attempt's exit code.
//!
//! The terminal is announced by its `awaiting_operator` result, not by
//! `term.spawned` (that frame names an agent command). Viewers attach with
//! the ordinary `term.attach` handshake under the job's `operator.terminalId`.
//! Operator terminals are gated by their own local switch
//! (`allowDeploymentOperatorTerminal`, plus `allowDeployments`), read fresh
//! for every job, Enter and viewer, and by terminal support; not by the
//! browser terminal switch or the MCP command mode. They never offer a shell
//! and never idle-close: a step may wait for its person indefinitely.

use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

use super::{
    Config, OutboundFrame, OutputKey, PrivateBody, SUPERVISED_ENV_MARKER_FILE,
    SUPERVISED_ENV_OPERATOR, TerminalRegistry, TerminalSession, push_scrollback, spawn_pty,
    supervised_pty, terminal_crypto, terminal_env, user_home, valid_id,
};
use crate::deployments::{Job, OperatorOpen, OperatorProgress};
use crate::supervised_run::operator::OperatorRequest;

/// Live operator terminals per CLI. The server opens at most a few per node
/// (one per instance at a time); this only bounds a misbehaving server.
pub(super) const MAX_OPERATOR_TERMINALS: usize = 8;
/// Ended operator terminals remembered, so a re-sent job reports its
/// outcome instead of reopening the same terminal id.
const ENDED_OPERATOR_MEMORY: usize = 64;
/// Stops held at once; the oldest is dropped beyond this (the server
/// re-sends an unanswered stop).
const DEFERRED_JOBS_MAX: usize = 32;
/// How often waiting operator terminals re-check the local deployments switch.
pub(super) const OPERATOR_GATE_RECHECK: Duration = Duration::from_secs(2);

/// Whether operator terminals are allowed now: local deployments and the
/// operator-terminal switch are both on (read fresh from the config).
pub(super) fn operator_terminals_allowed() -> bool {
    Config::load()
        .is_ok_and(|config| config.allow_deployments && config.allow_deployment_operator_terminal)
}

/// What an operator terminal reports to the session loop, which turns it
/// into deployment frames and worker requests.
#[derive(Debug, Clone)]
pub(crate) enum OperatorEvent {
    /// Send this progress result for the job.
    Progress(Job, OperatorProgress),
    /// A person pressed Enter (the `go` is already written): persist it.
    Accepted(Job),
    /// The command exited 0 and the child exited cleanly: check the proof.
    Verify(Job),
}

/// An operator terminal's state, beside its PTY in the `TerminalSession`.
pub(super) struct OperatorTerminal {
    pub(super) job: Job,
    pub(super) child: supervised_pty::ChildLink,
    /// The child drew its screen at least once; input may reach the PTY.
    pub(super) ready_seen: bool,
    /// `awaiting_operator` was reported since the last `operator_running`.
    awaiting_reported: bool,
    /// Between `accepted` and `exited`.
    running: bool,
    /// The last failed attempt's exit code.
    last_exit: Option<u8>,
    /// The child reported `exited;0`.
    exited_ok: bool,
    /// The child broke the marker grammar (or `go` could not be written).
    pub(super) invalid: bool,
    /// A stop for the instance arrived while the command ran: end the
    /// terminal once this run ends instead of offering a retry.
    cancel_after_run: bool,
    /// Kept until the terminal ends; the child removes the file itself.
    _marker_file: PrivateBody,
}

impl OperatorTerminal {
    /// The event that ends this terminal, given the confirm child's exit
    /// status: `Verify` only when the command reported exit 0 and the child
    /// itself exited 0 (its exit status cannot come from command output).
    fn ending(&self, status: (Option<i32>, Option<i32>)) -> OperatorEvent {
        if self.exited_ok && !self.invalid && status == (Some(0), None) {
            OperatorEvent::Verify(self.job.clone())
        } else {
            OperatorEvent::Progress(self.job.clone(), OperatorProgress::Closed(self.last_exit))
        }
    }
}

/// This machine's name for the confirm screen: the reported hostname when
/// the screen can show it as plain text, else a neutral fallback.
fn node_name() -> String {
    crate::hostname::reported_hostname()
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 256
                && !name
                    .chars()
                    .any(|ch| ch == '\n' || crate::display_escape::needs_escape(ch))
        })
        .unwrap_or_else(|| "this machine".to_string())
}

impl TerminalRegistry {
    /// Opens the operator terminal for `open.job` (its `operator.terminalId`).
    /// A repeated delivery of the same terminal re-reports its state; a new
    /// terminal for a step that already has one replaces it (the server
    /// minted a new one: the old one can no longer be accepted). `Err` names
    /// why no terminal opened; nothing ran.
    pub(crate) fn spawn_operator(
        &mut self,
        config: &Config,
        open: &OperatorOpen,
    ) -> Result<Vec<OutboundFrame>, &'static str> {
        let job = &open.job;
        let Some(operator) = job
            .operator
            .as_ref()
            .filter(|_| job.interactive == Some(true))
        else {
            return Err("bad_job");
        };
        let terminal_id = operator.terminal_id.as_str();
        if self.shut_down || !crate::protocol::terminal_supported() {
            return Err("operator_terminal_unavailable");
        }
        if !valid_id(terminal_id) {
            return Err("bad_job");
        }
        // A terminal id is used once: a job re-sent after its terminal ended
        // gets that terminal's outcome again, never a second terminal.
        if let Some((_, ended)) = self
            .ended_operators
            .iter()
            .find(|(id, _)| id == terminal_id)
        {
            let ended_job = match ended {
                OperatorEvent::Progress(job, _)
                | OperatorEvent::Accepted(job)
                | OperatorEvent::Verify(job) => job,
            };
            if ended_job.step_id != job.step_id || ended_job.intent_hash != job.intent_hash {
                return Err("operator_terminal_conflict");
            }
            let again = ended.clone();
            self.operator_events.push(again);
            return Ok(Vec::new());
        }
        if let Some(session) = self.sessions.get(terminal_id) {
            return match session.operator.as_ref() {
                Some(existing)
                    if existing.job.step_id == job.step_id
                        && existing.job.intent_hash == job.intent_hash =>
                {
                    if existing.ready_seen && !existing.running {
                        self.operator_events.push(OperatorEvent::Progress(
                            existing.job.clone(),
                            OperatorProgress::Awaiting,
                        ));
                    }
                    Ok(Vec::new())
                }
                _ => Err("operator_terminal_conflict"),
            };
        }
        let request = OperatorRequest::from_job(job, &node_name(), open.previous_run_unknown)
            .map_err(|_| "bad_job")?;
        let request = serde_json::to_string(&request).map_err(|_| "bad_job")?;
        // A step has one terminal: the server's newest.
        let mut frames = Vec::new();
        let stale = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session
                    .operator
                    .as_ref()
                    .is_some_and(|existing| existing.job.step_id == job.step_id)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in stale {
            frames.extend(self.close(&id));
        }
        if self.operator_count() >= MAX_OPERATOR_TERMINALS {
            return Err("operator_terminal_limit");
        }
        let marker = terminal_crypto::random_nonce()
            .map_err(|_| "operator_terminal_failed")?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let marker_file =
            PrivateBody::create(marker.as_bytes()).map_err(|_| "operator_terminal_failed")?;
        let out = OutputKey::first().map_err(|_| "operator_terminal_failed")?;
        let (program, args) = match self.operator_program.clone() {
            Some(program) => program,
            None => (
                std::env::current_exe()
                    .map_err(|_| "operator_terminal_failed")?
                    .to_string_lossy()
                    .into_owned(),
                vec![
                    "terminal".to_string(),
                    "supervised-run".to_string(),
                    "--deployment".to_string(),
                ],
            ),
        };
        let cwd = user_home().map_err(|_| "operator_terminal_failed")?;
        let mut env = terminal_env(config);
        env.push((SUPERVISED_ENV_OPERATOR.to_string(), request));
        env.push((
            SUPERVISED_ENV_MARKER_FILE.to_string(),
            marker_file.path.to_string_lossy().into_owned(),
        ));
        let (cols, rows) = (80, 24);
        let pty = spawn_pty(
            &program,
            &args,
            &cwd,
            &env,
            cols,
            rows,
            &self.tx,
            terminal_id,
        )
        .map_err(|error| {
            tracing::warn!(error = %error, terminal_id, "starting an operator terminal failed");
            "operator_terminal_failed"
        })?;
        self.sessions.insert(
            terminal_id.to_string(),
            TerminalSession {
                viewers: BTreeMap::new(),
                writer: None,
                pty_size: (cols, rows),
                out: Some(out),
                detached_at: Some(Instant::now()),
                scrollback: VecDeque::new(),
                pty: Some(pty),
                supervised: None,
                operator: Some(OperatorTerminal {
                    job: job.clone(),
                    child: supervised_pty::ChildLink::operator(&marker),
                    ready_seen: false,
                    awaiting_reported: false,
                    running: false,
                    last_exit: None,
                    exited_ok: false,
                    invalid: false,
                    cancel_after_run: false,
                    _marker_file: marker_file,
                }),
            },
        );
        tracing::info!(
            terminal_id,
            step_id = %job.step_id,
            "opened a deployment operator terminal"
        );
        Ok(frames)
    }

    pub(super) fn operator_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.operator.is_some())
            .count()
    }

    /// A stop for `instance_id` arrived (step `keep_step`): closes the
    /// instance's other operator terminals still waiting for their person.
    /// A terminal whose command is running is never killed: it ends after
    /// that run (no retry is offered), and `true` says the stop must wait for
    /// it (see [`TerminalRegistry::defer_until_runs_end`]).
    pub(crate) fn close_operator_for_instance(
        &mut self,
        instance_id: &str,
        keep_step: &str,
    ) -> (Vec<OutboundFrame>, bool) {
        let mut waiting = Vec::new();
        let mut busy = false;
        for (id, session) in &mut self.sessions {
            let Some(operator) = session.operator.as_mut() else {
                continue;
            };
            if operator.job.instance_id != instance_id || operator.job.step_id == keep_step {
                continue;
            }
            if operator.running || operator.exited_ok || operator.cancel_after_run {
                operator.cancel_after_run = true;
                busy = true;
            } else {
                waiting.push(id.clone());
            }
        }
        let mut frames = Vec::new();
        for id in waiting {
            frames.extend(self.close(&id));
        }
        (frames, busy)
    }

    /// Holds `job` (a stop) until no other operator terminal of its instance
    /// is left: a person's run is never cut off, and the stop never settles
    /// from status while that run may still be starting the service. A newer
    /// delivery of the same step replaces a held one.
    pub(crate) fn defer_until_runs_end(&mut self, job: Job) {
        self.deferred_jobs
            .retain(|held| held.step_id != job.step_id || held.instance_id != job.instance_id);
        if self.deferred_jobs.len() >= DEFERRED_JOBS_MAX {
            let dropped = self.deferred_jobs.remove(0);
            tracing::warn!(step_id = %dropped.step_id, "dropping the oldest held deployment stop");
        }
        self.deferred_jobs.push(job);
    }

    /// Held jobs whose instance has no other operator terminal left.
    pub(crate) fn take_released_jobs(&mut self) -> Vec<Job> {
        let (released, held): (Vec<Job>, Vec<Job>) = std::mem::take(&mut self.deferred_jobs)
            .into_iter()
            .partition(|job| {
                !self.sessions.values().any(|session| {
                    session.operator.as_ref().is_some_and(|operator| {
                        operator.job.instance_id == job.instance_id
                            && operator.job.step_id != job.step_id
                    })
                })
            });
        self.deferred_jobs = held;
        released
    }

    /// With local deployments or operator terminals switched off, waiting
    /// operator terminals close
    /// (a running command is left to finish). Checked every
    /// [`OPERATOR_GATE_RECHECK`] while any operator terminal is open.
    pub(super) fn recheck_operator_gate(&mut self, now: Instant) -> Vec<OutboundFrame> {
        if self.operator_count() == 0 || self.next_operator_gate_check.is_some_and(|at| now < at) {
            return Vec::new();
        }
        self.next_operator_gate_check = Some(now + OPERATOR_GATE_RECHECK);
        if (self.operator_allowed)() {
            return Vec::new();
        }
        let waiting = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.operator.as_ref().is_some_and(|operator| {
                    !operator.running && !operator.exited_ok && !operator.cancel_after_run
                })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
        for id in waiting {
            tracing::info!(terminal_id = %id, "deployments are off; closing an operator terminal");
            frames.extend(self.close(&id));
        }
        frames
    }

    /// Events for the session loop, oldest first.
    pub(crate) fn take_operator_events(&mut self) -> Vec<OperatorEvent> {
        std::mem::take(&mut self.operator_events)
    }

    /// Operator PTY output: markers become events and never reach viewers;
    /// everything else is ordinary terminal output.
    pub(super) fn operator_bytes(&mut self, terminal_id: &str, bytes: &[u8]) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        let Some(operator) = session.operator.as_mut() else {
            return Vec::new();
        };
        let mut display = Vec::new();
        let mut events = Vec::new();
        for piece in operator.child.scanner.feed(bytes) {
            // Ending: nothing after this counts (the terminal closes below).
            if operator.invalid {
                break;
            }
            match piece {
                supervised_pty::Piece::Bytes(bytes) => display.extend(bytes),
                supervised_pty::Piece::Event(event) => match event {
                    supervised_pty::MarkerEvent::Ready => {
                        operator.ready_seen = true;
                        if !operator.awaiting_reported {
                            operator.awaiting_reported = true;
                            events.push(OperatorEvent::Progress(
                                operator.job.clone(),
                                OperatorProgress::Awaiting,
                            ));
                        }
                    }
                    supervised_pty::MarkerEvent::Accepted => {
                        // The scanner's grammar guarantees a drawn screen.
                        // Local deployments must still be on when Enter
                        // starts the command; otherwise nothing runs.
                        if !(self.operator_allowed)() {
                            tracing::info!(
                                terminal_id,
                                "deployments are off; the operator command does not start"
                            );
                            operator.invalid = true;
                            continue;
                        }
                        let released = session
                            .pty
                            .as_ref()
                            .map(|pty| pty.input.push_control(operator.child.go.clone()));
                        if let Some(Ok(())) = released {
                            operator.running = true;
                            operator.awaiting_reported = false;
                            events.push(OperatorEvent::Accepted(operator.job.clone()));
                            events.push(OperatorEvent::Progress(
                                operator.job.clone(),
                                OperatorProgress::Running,
                            ));
                        } else {
                            // The PTY is going away; nothing starts.
                            operator.invalid = true;
                        }
                    }
                    supervised_pty::MarkerEvent::Exited(0) => {
                        operator.running = false;
                        operator.exited_ok = true;
                    }
                    supervised_pty::MarkerEvent::Exited(code) => {
                        operator.running = false;
                        operator.last_exit = Some(code);
                        if operator.cancel_after_run {
                            // A stop is waiting for this run: no retry.
                            operator.invalid = true;
                            continue;
                        }
                        // Waiting for the person again: the child shows the
                        // failure, then its retry screen.
                        operator.awaiting_reported = true;
                        events.push(OperatorEvent::Progress(
                            operator.job.clone(),
                            OperatorProgress::Awaiting,
                        ));
                    }
                    supervised_pty::MarkerEvent::Blocked(_)
                    | supervised_pty::MarkerEvent::Invalid => {
                        operator.invalid = true;
                    }
                },
            }
        }
        let invalid = operator.invalid;
        self.operator_events.extend(events);
        let mut frames = Vec::new();
        if !display.is_empty() {
            push_scrollback(&mut session.scrollback, &display);
            frames.extend(session.broadcast_data(terminal_id, &display));
        }
        if invalid {
            tracing::info!(terminal_id, "closing an operator terminal");
            frames.extend(self.close(terminal_id));
        }
        frames
    }

    /// Ends an operator session removed by `close`: reports `Verify` or
    /// `operator_closed` once, given the child's exit status.
    pub(super) fn finish_operator(
        &mut self,
        operator: &OperatorTerminal,
        status: (Option<i32>, Option<i32>),
    ) {
        let event = operator.ending(status);
        tracing::info!(
            step_id = %operator.job.step_id,
            verify = matches!(event, OperatorEvent::Verify(_)),
            "deployment operator terminal ended"
        );
        if let Some(operator_ref) = operator.job.operator.as_ref() {
            if self.ended_operators.len() >= ENDED_OPERATOR_MEMORY {
                self.ended_operators.pop_front();
            }
            self.ended_operators
                .push_back((operator_ref.terminal_id.clone(), event.clone()));
        }
        self.operator_events.push(event);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::relay_bus::FromWorker;

    fn golden(name: &str) -> Job {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/relay-current/deployment-jobs.json"
        ))
        .expect("golden JSON");
        serde_json::from_value(golden["jobs"][name].clone()).expect(name)
    }

    fn open(job: Job) -> OperatorOpen {
        OperatorOpen {
            job,
            previous_run_unknown: false,
        }
    }

    /// Stands in for `wsmp terminal supervised-run --deployment`: takes the
    /// marker file, then per attempt draws, waits for a line (`q` declines),
    /// prints `accepted`, waits for the exact `go`, and reports the next exit
    /// code from `codes`. After `exited;0` it exits with `final_exit`.
    fn fake_operator(codes: &[u8], final_exit: u8) -> String {
        let go_len =
            crate::sessions::supervised_marker("go", "00112233445566778899aabbccddeeff").len();
        let codes = codes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            r#"marker=$(cat "$WSMP_SUPERVISED_MARKER_FILE") || exit 98
rm -f "$WSMP_SUPERVISED_MARKER_FILE"
printf '%s' "$WSMP_SUPERVISED_OPERATOR" | grep -q '"commandAuthor":"user"' || exit 97
m() {{ printf '\033]7717;wsmp-supervised;%s;%s\007' "$1" "$marker"; }}
for code in {codes}; do
  printf 'SCREEN\n'
  m ready
  IFS= read -r line
  case "$line" in q*) printf 'Declined\n'; exit 0;; esac
  stty -echo -icanon min 1 time 0
  m accepted
  go=$(head -c {go_len})
  stty echo icanon
  [ "$go" = "$(printf '\033]7717;wsmp-supervised;go;%s\007' "$marker")" ] || exit 99
  printf 'ran-%s\n' "$code"
  m "exited;$code"
  [ "$code" = 0 ] && exit {final_exit}
done
exit 0
"#
        )
    }

    fn registry(tx: mpsc::SyncSender<FromWorker>, script: &str) -> TerminalRegistry {
        crate::logging::init_test_subscriber();
        let mut terminals = TerminalRegistry::with_shell(
            tx,
            Duration::from_millis(1),
            "/bin/sh",
            &["-c", "sleep 30"],
        );
        terminals.operator_program = Some((
            "/bin/sh".to_string(),
            vec!["-c".to_string(), script.to_string()],
        ));
        terminals.operator_allowed = || true;
        terminals
    }

    fn label(event: &OperatorEvent) -> String {
        match event {
            OperatorEvent::Progress(_, OperatorProgress::Awaiting) => "awaiting".into(),
            OperatorEvent::Progress(_, OperatorProgress::Running) => "running".into(),
            OperatorEvent::Progress(_, OperatorProgress::Closed(code)) => {
                format!("closed:{code:?}")
            }
            OperatorEvent::Accepted(_) => "accepted".into(),
            OperatorEvent::Verify(_) => "verify".into(),
        }
    }

    /// Runs the relay loop's terminal steps until `events` (labels) holds
    /// `want` events, typing the next of `answers` whenever a screen waits.
    fn pump(
        terminals: &mut TerminalRegistry,
        rx: &mpsc::Receiver<FromWorker>,
        events: &mut Vec<String>,
        want: usize,
        answers: &[&[u8]],
    ) -> Vec<OutboundFrame> {
        let mut answers = answers.iter();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut frames = Vec::new();
        while events.len() < want {
            assert!(Instant::now() < deadline, "timed out: {events:?}");
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(FromWorker::TerminalBytes { terminal_id, bytes }) => {
                    frames.extend(terminals.on_bytes(&terminal_id, &bytes));
                }
                Ok(FromWorker::TerminalEof { terminal_id }) => {
                    frames.extend(terminals.on_eof(&terminal_id));
                }
                _ => {}
            }
            frames.extend(terminals.poll(Instant::now() + Duration::from_secs(3600)));
            for event in terminals.take_operator_events() {
                let label = label(&event);
                if label == "awaiting" {
                    let id = match &event {
                        OperatorEvent::Progress(job, _) => job
                            .operator
                            .as_ref()
                            .map(|operator| operator.terminal_id.clone())
                            .expect("operator"),
                        _ => unreachable!("progress"),
                    };
                    if let Some(answer) = answers.next() {
                        let _ = terminals.enqueue_input(&id, answer.to_vec());
                    }
                }
                events.push(label);
            }
        }
        frames
    }

    fn terminal_id(job: &Job) -> String {
        job.operator.as_ref().expect("operator").terminal_id.clone()
    }

    #[test]
    fn a_failed_run_waits_again_and_a_clean_success_asks_for_the_proof() {
        let (tx, rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, &fake_operator(&[1, 0], 0));
        let job = golden("interactiveStart");
        let frames = terminals
            .spawn_operator(&Config::default(), &open(job.clone()))
            .expect("spawned");
        assert!(frames.is_empty());
        let id = terminal_id(&job);
        let session = terminals.sessions.get(&id).expect("session");
        assert!(!session.accepts_input(), "no input before the screen");
        // Operator terminals are not human terminals and never idle-close.
        assert_eq!(terminals.human_count(), 0);
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 7, &[b"\n", b"\n"]);
        assert_eq!(
            events,
            [
                "awaiting", "accepted", "running", "awaiting", "accepted", "running", "verify"
            ]
        );
        assert!(!terminals.sessions.contains_key(&id));
    }

    #[test]
    fn exit_zero_without_a_clean_child_exit_is_not_a_success() {
        let (tx, rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, &fake_operator(&[0], 5));
        let job = golden("interactiveStart");
        terminals
            .spawn_operator(&Config::default(), &open(job))
            .expect("spawned");
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 4, &[b"\n"]);
        assert_eq!(events, ["awaiting", "accepted", "running", "closed:None"]);
    }

    #[test]
    fn a_decline_after_a_failure_closes_with_the_last_exit_code() {
        let (tx, rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, &fake_operator(&[2, 0], 0));
        let job = golden("interactiveStart");
        terminals
            .spawn_operator(&Config::default(), &open(job))
            .expect("spawned");
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 5, &[b"\n", b"q\n"]);
        assert_eq!(events[..4], ["awaiting", "accepted", "running", "awaiting"]);
        assert_eq!(events[4], "closed:Some(2)");
    }

    #[test]
    fn cancelling_or_replacing_a_terminal_closes_it_without_running_anything() {
        let (tx, rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, &fake_operator(&[0], 0));
        let job = golden("interactiveStart");
        terminals
            .spawn_operator(&Config::default(), &open(job.clone()))
            .expect("spawned");
        let mut events = Vec::new();
        // No answer typed: the screen waits.
        pump(&mut terminals, &rx, &mut events, 1, &[]);
        assert_eq!(events, ["awaiting"]);
        // The same terminal delivered again re-reports, and opens nothing new.
        assert!(
            terminals
                .spawn_operator(&Config::default(), &open(job.clone()))
                .expect("duplicate")
                .is_empty()
        );
        assert_eq!(
            terminals
                .take_operator_events()
                .iter()
                .map(label)
                .collect::<Vec<_>>(),
            ["awaiting"]
        );
        assert_eq!(terminals.operator_count(), 1);
        // A new terminal for the same step replaces the old one.
        let mut reopened = job.clone();
        if let Some(operator) = reopened.operator.as_mut() {
            operator.terminal_id = "AAECAwQFBgcICQoLDA0OAA".into();
        }
        let frames = terminals
            .spawn_operator(&Config::default(), &open(reopened.clone()))
            .expect("reopened");
        assert!(!frames.is_empty(), "the old terminal exits");
        assert!(!terminals.sessions.contains_key(&terminal_id(&job)));
        assert!(terminals.sessions.contains_key(&terminal_id(&reopened)));
        assert_eq!(
            terminals
                .take_operator_events()
                .iter()
                .map(label)
                .collect::<Vec<_>>(),
            ["closed:None"]
        );
        // A stop for the instance cancels it.
        let stop = golden("interactiveStop");
        let (frames, busy) =
            terminals.close_operator_for_instance(&stop.instance_id, &stop.step_id);
        assert!(!frames.is_empty());
        assert!(!busy, "a waiting terminal holds nothing");
        assert_eq!(terminals.operator_count(), 0);
        assert_eq!(
            terminals
                .take_operator_events()
                .iter()
                .map(label)
                .collect::<Vec<_>>(),
            ["closed:None"]
        );
        drop(rx);
    }

    #[test]
    fn a_marker_out_of_order_closes_the_terminal() {
        let (tx, rx) = mpsc::sync_channel(64);
        let script = r#"marker=$(cat "$WSMP_SUPERVISED_MARKER_FILE")
printf '\033]7717;wsmp-supervised;accepted;%s\007' "$marker"
sleep 5
"#;
        let mut terminals = registry(tx, script);
        let job = golden("interactiveStart");
        terminals
            .spawn_operator(&Config::default(), &open(job.clone()))
            .expect("spawned");
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 1, &[]);
        assert_eq!(events, ["closed:None"]);
        assert!(!terminals.sessions.contains_key(&terminal_id(&job)));
    }

    #[test]
    fn only_interactive_jobs_open_terminals() {
        let (tx, _rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, "exit 0");
        assert_eq!(
            terminals
                .spawn_operator(&Config::default(), &open(golden("plainStart")))
                .err(),
            Some("bad_job")
        );
        assert_eq!(terminals.operator_count(), 0);
        let _ = terminals.kill_all();
        assert_eq!(
            terminals
                .spawn_operator(&Config::default(), &open(golden("interactiveStart")))
                .err(),
            Some("operator_terminal_unavailable")
        );
    }

    #[test]
    fn a_stop_never_kills_a_running_command_and_waits_for_the_run_to_end() {
        let (tx, rx) = mpsc::sync_channel(64);
        let go_len =
            crate::sessions::supervised_marker("go", "00112233445566778899aabbccddeeff").len();
        let script = format!(
            r#"marker=$(cat "$WSMP_SUPERVISED_MARKER_FILE")
rm -f "$WSMP_SUPERVISED_MARKER_FILE"
m() {{ printf '\033]7717;wsmp-supervised;%s;%s\007' "$1" "$marker"; }}
while :; do
  m ready
  IFS= read -r line
  stty -echo -icanon min 1 time 0
  m accepted
  go=$(head -c {go_len})
  stty echo icanon
  sleep 0.6
  m "exited;1"
done
"#
        );
        let mut terminals = registry(tx, &script);
        let job = golden("interactiveStart");
        terminals
            .spawn_operator(&Config::default(), &open(job.clone()))
            .expect("spawned");
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 3, &[b"\n"]);
        assert_eq!(events, ["awaiting", "accepted", "running"]);
        // The stop arrives mid-run: nothing is killed, and it is held.
        let stop = golden("interactiveStop");
        let (frames, busy) =
            terminals.close_operator_for_instance(&stop.instance_id, &stop.step_id);
        assert!(frames.is_empty() && busy);
        assert!(terminals.sessions.contains_key(&terminal_id(&job)));
        terminals.defer_until_runs_end(stop.clone());
        terminals.defer_until_runs_end(stop.clone());
        assert!(terminals.take_released_jobs().is_empty());
        // The run ends: no retry is offered, the terminal closes, and the
        // stop goes ahead (once).
        pump(&mut terminals, &rx, &mut events, 4, &[]);
        assert_eq!(events[3], "closed:Some(1)");
        assert!(!terminals.sessions.contains_key(&terminal_id(&job)));
        let released = terminals.take_released_jobs();
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].step_id, stop.step_id);
    }

    #[test]
    fn a_job_resent_after_its_terminal_ended_reports_the_outcome_again() {
        let (tx, rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, &fake_operator(&[0], 0));
        let job = golden("interactiveStart");
        terminals
            .spawn_operator(&Config::default(), &open(job.clone()))
            .expect("spawned");
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 2, &[b"q\n"]);
        assert_eq!(events, ["awaiting", "closed:None"]);
        assert!(
            terminals
                .spawn_operator(&Config::default(), &open(job.clone()))
                .expect("re-sent")
                .is_empty()
        );
        assert_eq!(terminals.operator_count(), 0, "never reopened");
        assert_eq!(
            terminals
                .take_operator_events()
                .iter()
                .map(label)
                .collect::<Vec<_>>(),
            ["closed:None"]
        );
        // The same id for another step is a conflict.
        let mut other = golden("interactiveStop");
        other.operator = job.operator.clone();
        assert_eq!(
            terminals
                .spawn_operator(&Config::default(), &open(other))
                .err(),
            Some("operator_terminal_conflict")
        );
    }

    #[test]
    fn with_deployments_off_enter_runs_nothing_and_waiting_terminals_close() {
        let (tx, rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, &fake_operator(&[0], 0));
        terminals.operator_allowed = || false;
        // Only the Enter-time check: the periodic one is far away.
        terminals.next_operator_gate_check = Some(Instant::now() + Duration::from_secs(100_000));
        let job = golden("interactiveStart");
        terminals
            .spawn_operator(&Config::default(), &open(job.clone()))
            .expect("spawned");
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 2, &[b"\n"]);
        assert_eq!(events, ["awaiting", "closed:None"], "no go, nothing ran");

        // The periodic check closes a terminal still waiting.
        let (tx, rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, &fake_operator(&[0], 0));
        terminals
            .spawn_operator(&Config::default(), &open(job))
            .expect("spawned");
        let mut events = Vec::new();
        pump(&mut terminals, &rx, &mut events, 1, &[]);
        assert_eq!(events, ["awaiting"]);
        terminals.operator_allowed = || false;
        let frames = terminals.poll(Instant::now() + Duration::from_secs(7200));
        assert!(!frames.is_empty());
        assert_eq!(terminals.operator_count(), 0);
        assert_eq!(
            terminals
                .take_operator_events()
                .iter()
                .map(label)
                .collect::<Vec<_>>(),
            ["closed:None"]
        );
    }

    #[test]
    fn held_stops_are_bounded() {
        let (tx, _rx) = mpsc::sync_channel(64);
        let mut terminals = registry(tx, "exit 0");
        let stop = golden("interactiveStop");
        for n in 0..(DEFERRED_JOBS_MAX + 5) {
            let mut held = stop.clone();
            held.step_id = format!("held-{n}");
            terminals.defer_until_runs_end(held);
        }
        assert_eq!(terminals.deferred_jobs.len(), DEFERRED_JOBS_MAX);
        assert_eq!(terminals.deferred_jobs[0].step_id, "held-5");
        // Nothing runs for the instance, so all are released at once.
        assert_eq!(terminals.take_released_jobs().len(), DEFERRED_JOBS_MAX);
    }
}
