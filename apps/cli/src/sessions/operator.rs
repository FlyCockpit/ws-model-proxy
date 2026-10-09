//! Operator terminals on the relay loop (see `crate::runtimes::operator`).
//!
//! An operator terminal is a [`TerminalSession`] with [`OperatorState`]. It
//! opens in the confirm stage with no PTY: viewers attach with the ordinary
//! `term.attach` handshake (at every trust level) and see the confirm screen
//! the daemon draws; the writer's keys are read here and never reach a
//! process. Enter spawns a fresh PTY running only the step's command (in
//! the `sudo -k` wrapper); from then on the terminal is an ordinary PTY
//! terminal whose input reaches that command until it exits. The terminal
//! then ends: no prompt, nothing more to type into.

use std::sync::mpsc::SyncSender;

#[cfg(unix)]
use super::valid_id;
use super::{OutboundFrame, TerminalRegistry, TerminalSession};
use crate::protocol::frames::JobStatus;
#[cfg(unix)]
use crate::protocol::{frames::JobError, terminal_supported};
use crate::runtimes::operator::{
    self as op, ConfirmKey, OperatorEvent, OperatorIds, OperatorScreen,
};
#[cfg(unix)]
use crate::runtimes::operator::{MAX_OPERATOR_TERMINALS, OperatorOpen};
use crate::terminal_crypto::TermPlaintextV2;

/// The step behind an operator terminal.
pub(super) struct OperatorState {
    ids: OperatorIds,
    screen: OperatorScreen,
    /// Node secrets included: never logged.
    #[cfg(unix)]
    env: Vec<(String, String)>,
    events: SyncSender<OperatorEvent>,
    /// A person accepted and the command's PTY was spawned.
    running: bool,
}

impl OperatorState {
    /// The terminal ended (`ran`: the command's PTY existed; `status` its
    /// exit). A clean exit of the command hands the step back to its runner
    /// thread for the proof; anything else answers `operator_closed`.
    pub(super) fn ended(self, ran: bool, status: (Option<i32>, Option<i32>)) -> Vec<OutboundFrame> {
        if ran && status == (Some(0), None) {
            tracing::info!(step_id = self.ids.step_id, "operator command exited 0");
            let _ = self.events.try_send(OperatorEvent::ExitedOk);
            return Vec::new();
        }
        let exit = if ran { op::exit_code(status) } else { None };
        tracing::info!(
            step_id = self.ids.step_id,
            ran,
            exit_code = exit,
            "operator terminal closed"
        );
        let _ = self.events.try_send(OperatorEvent::Closed);
        vec![OutboundFrame::Control(
            self.ids.result(JobStatus::OperatorClosed, exit),
        )]
    }
}

/// Operator terminal ids a runner thread has but has not opened yet, and
/// every id this session took. An id opens at most once: a re-delivery
/// while it is pending or after it ended changes nothing.
#[derive(Default)]
pub(crate) struct OperatorBook {
    /// Terminal id → (step id, cancelled before it opened).
    pending: std::collections::BTreeMap<String, (String, bool)>,
    used: std::collections::HashSet<String>,
    #[cfg(unix)]
    used_order: std::collections::VecDeque<String>,
}

/// Ids remembered as used (oldest forgotten first; the server never
/// re-sends one that old).
#[cfg(unix)]
const USED_IDS_MAX: usize = 4096;

impl OperatorBook {
    #[cfg(unix)]
    fn take(&mut self, terminal_id: &str, step_id: &str) {
        self.pending
            .insert(terminal_id.to_string(), (step_id.to_string(), false));
        if self.used.insert(terminal_id.to_string()) {
            self.used_order.push_back(terminal_id.to_string());
            while self.used_order.len() > USED_IDS_MAX {
                if let Some(old) = self.used_order.pop_front() {
                    self.used.remove(&old);
                }
            }
        }
    }

    #[cfg(unix)]
    fn live(&self) -> usize {
        self.pending
            .values()
            .filter(|(_, cancelled)| !cancelled)
            .count()
    }

    fn cancel_where(&mut self, select: impl Fn(&str, &str) -> bool) {
        for (terminal_id, (step_id, cancelled)) in &mut self.pending {
            if select(terminal_id, step_id) {
                *cancelled = true;
            }
        }
    }
}

/// What a received operator job is, before anything is rendered.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OperatorDelivery {
    /// A terminal id this session has not seen.
    New,
    /// A re-delivery: re-report this state, or (`None`) nothing (it is still
    /// pending or it already ended and answered).
    Repeat(Option<JobStatus>),
    /// The id belongs to another step.
    Clash,
}

/// The scrubbed environment an operator command starts from (the browser
/// terminal environment: denied names removed, `TERM`, `WSMP_JOB=1`).
#[cfg(unix)]
pub(crate) fn operator_base_env() -> Vec<(String, String)> {
    super::terminal_env()
}

/// The screen bytes, cut for sealing.
fn chunks(bytes: &[u8]) -> impl Iterator<Item = Vec<u8>> + '_ {
    bytes.chunks(super::SEAL_CHUNK).map(<[u8]>::to_vec)
}

impl TerminalSession {
    /// An operator terminal still on its confirm screen.
    pub(super) fn confirming(&self) -> bool {
        self.operator.as_ref().is_some_and(|state| !state.running)
    }

    fn screen_bytes(&self) -> Option<Vec<u8>> {
        let state = self.operator.as_ref().filter(|state| !state.running)?;
        Some(op::paint(&state.screen, self.pty_size.0, self.pty_size.1))
    }

    /// The confirm screen for one joining viewer (after its join frames).
    pub(super) fn confirm_screen_for(
        &mut self,
        terminal_id: &str,
        viewer_id: &str,
    ) -> Vec<OutboundFrame> {
        let Some(bytes) = self.screen_bytes() else {
            return Vec::new();
        };
        chunks(&bytes)
            .filter_map(|chunk| {
                self.seal_unicast(terminal_id, viewer_id, &TermPlaintextV2::Data(chunk))
            })
            .collect()
    }

    /// The confirm screen again, for every viewer (after a resize).
    pub(super) fn confirm_repaint(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        let Some(bytes) = self.screen_bytes() else {
            return Vec::new();
        };
        chunks(&bytes)
            .filter_map(|chunk| self.seal_broadcast(terminal_id, &TermPlaintextV2::Data(chunk)))
            .collect()
    }
}

impl TerminalRegistry {
    /// Live operator terminals.
    #[cfg(unix)]
    pub(crate) fn operator_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.operator.is_some())
            .count()
    }

    /// A re-delivered job whose terminal is already open: its current state.
    pub(crate) fn operator_status(&self, step_id: &str, terminal_id: &str) -> Option<JobStatus> {
        let session = self.sessions.get(terminal_id)?;
        let state = session.operator.as_ref()?;
        (state.ids.step_id == step_id).then_some(if state.running {
            JobStatus::OperatorRunning
        } else {
            JobStatus::AwaitingOperator
        })
    }

    /// What a received operator job is (see [`OperatorDelivery`]).
    pub(crate) fn operator_delivery(&self, step_id: &str, terminal_id: &str) -> OperatorDelivery {
        if let Some(state) = self
            .sessions
            .get(terminal_id)
            .and_then(|session| session.operator.as_ref())
        {
            return if state.ids.step_id == step_id {
                OperatorDelivery::Repeat(self.operator_status(step_id, terminal_id))
            } else {
                OperatorDelivery::Clash
            };
        }
        if self.sessions.contains_key(terminal_id) {
            return OperatorDelivery::Clash;
        }
        match self.operators.pending.get(terminal_id) {
            Some((pending_step, _)) if pending_step == step_id => OperatorDelivery::Repeat(None),
            Some(_) => OperatorDelivery::Clash,
            None if self.operators.used.contains(terminal_id) => OperatorDelivery::Repeat(None),
            None => OperatorDelivery::New,
        }
    }

    /// Take `terminal_id` for a step about to go to its runner thread. A
    /// newer dispatch of the same step replaces the older one: its terminal
    /// still on the confirm screen closes, and one not opened yet never
    /// opens, so the older thread lets go of the rank. Refused when no PTY
    /// can be offered, at the cap, or while shutting down.
    #[cfg(unix)]
    pub(crate) fn reserve_operator(
        &mut self,
        step_id: &str,
        terminal_id: &str,
    ) -> Result<Vec<OutboundFrame>, JobError> {
        if !valid_id(terminal_id) {
            return Err(JobError::BadJob);
        }
        let frames = self.close_confirming(|state| {
            state.ids.step_id == step_id && state.ids.terminal_id != terminal_id
        });
        self.operators.cancel_where(|pending_id, pending_step| {
            pending_step == step_id && pending_id != terminal_id
        });
        if self.shut_down
            || !terminal_supported()
            || self.operator_count() + self.operators.live() >= MAX_OPERATOR_TERMINALS
        {
            return Err(JobError::OperatorTerminalsDisabled);
        }
        self.operators.take(terminal_id, step_id);
        Ok(frames)
    }

    /// The step's runner thread is done with `terminal_id` (or never got it).
    #[cfg(unix)]
    pub(crate) fn release_operator(&mut self, terminal_id: &str) {
        self.operators.pending.remove(terminal_id);
    }

    /// A server `term.close`. A terminal still pending never opens; one on
    /// its confirm screen closes; a person's run already under way (Enter
    /// raced the close) is left alone and answers when it ends.
    pub(crate) fn close_from_server(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        if let Some((_, cancelled)) = self.operators.pending.get_mut(terminal_id) {
            *cancelled = true;
            return Vec::new();
        }
        if self
            .sessions
            .get(terminal_id)
            .and_then(|session| session.operator.as_ref())
            .is_some_and(|state| state.running)
        {
            tracing::info!(terminal_id, "kept a running operator command on a close");
            return Vec::new();
        }
        self.close(terminal_id)
    }

    /// Open the confirm stage of an operator terminal and answer
    /// `awaiting_operator`. Only a reserved, uncancelled id opens; anything
    /// else answers `operator_closed` (nothing ran) and the runner thread
    /// hears `Closed`.
    #[cfg(unix)]
    pub(crate) fn open_operator(&mut self, open: OperatorOpen) -> Vec<OutboundFrame> {
        let terminal_id = open.ids.terminal_id.clone();
        let reserved = self
            .operators
            .pending
            .remove(&terminal_id)
            .is_some_and(|(step_id, cancelled)| step_id == open.ids.step_id && !cancelled);
        if !reserved || self.sessions.contains_key(&terminal_id) || self.shut_down {
            tracing::info!(
                step_id = open.ids.step_id,
                "an operator terminal was cancelled before it opened"
            );
            let _ = open.events.try_send(OperatorEvent::Closed);
            return vec![OutboundFrame::Control(
                open.ids.result(JobStatus::OperatorClosed, None),
            )];
        }
        let mut frames = Vec::new();
        let out = match super::OutputKey::first() {
            Ok(out) => out,
            Err(error) => {
                tracing::warn!(error = %error, "generating a terminal output key failed");
                let _ = open.events.try_send(OperatorEvent::Closed);
                frames.push(OutboundFrame::Control(
                    open.ids.failed(JobError::OperatorTerminalsDisabled),
                ));
                return frames;
            }
        };
        tracing::info!(
            step_id = open.ids.step_id,
            "operator terminal waits for its person"
        );
        frames.push(OutboundFrame::Control(
            open.ids.result(JobStatus::AwaitingOperator, None),
        ));
        self.sessions.insert(
            terminal_id,
            TerminalSession {
                viewers: std::collections::BTreeMap::new(),
                writer: None,
                pty_size: (80, 24),
                out: Some(out),
                detached_at: None,
                scrollback: std::collections::VecDeque::new(),
                #[cfg(unix)]
                pty: None,
                operator: Some(OperatorState {
                    ids: open.ids,
                    screen: open.screen,
                    env: open.env,
                    events: open.events,
                    running: false,
                }),
            },
        );
        frames
    }

    /// Close every operator terminal still on its confirm screen that
    /// `select` picks. Terminals whose command runs are left alone.
    fn close_confirming(&mut self, select: impl Fn(&OperatorState) -> bool) -> Vec<OutboundFrame> {
        let ids = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session
                    .operator
                    .as_ref()
                    .is_some_and(|state| !state.running && select(state))
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.iter().flat_map(|id| self.close(id)).collect()
    }

    /// The step's runner thread was cancelled (a stop): close its terminal
    /// unless a person's run already started.
    #[cfg(unix)]
    pub(crate) fn close_operator_if_confirming(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        self.close_confirming(|state| state.ids.terminal_id == terminal_id)
    }

    /// A stop for this rank arrived: its operator steps still on their
    /// confirm screen close; a person's run in progress is not cut off.
    pub(crate) fn close_confirming_for_rank(
        &mut self,
        instance_id: &str,
        rank: u8,
    ) -> Vec<OutboundFrame> {
        self.close_confirming(|state| {
            state.ids.instance_id == instance_id && state.ids.rank == rank
        })
    }

    /// Trust lowering: browser shells end, and so do operator terminals still
    /// on (or not yet at) their confirm screen: they were rendered under the
    /// higher trust, and the person reopens them from the frozen copy. A
    /// person's run already under way stays; the registry stays usable.
    pub(crate) fn on_trust_lowered(&mut self) -> Vec<OutboundFrame> {
        let ids = self
            .sessions
            .iter()
            .filter(|(_, session)| session.operator.is_none())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut frames: Vec<OutboundFrame> = ids.iter().flat_map(|id| self.close(id)).collect();
        frames.extend(self.close_confirming(|_| true));
        // Approvals waiting to join survive only for operator terminals still
        // here (running commands); a queued browser-shell open never spawns.
        let sessions = &self.sessions;
        self.pending.retain(|(terminal_id, _), pending| {
            pending.attach
                && sessions
                    .get(terminal_id)
                    .is_some_and(|session| session.operator.is_some())
        });
        self.operators.cancel_where(|_, _| true);
        frames
    }

    /// A key on the confirm screen, from a viewer that becomes the writer.
    pub(super) fn confirm_input(
        &mut self,
        terminal_id: &str,
        viewer_key: &str,
        bytes: &[u8],
    ) -> Vec<OutboundFrame> {
        let mut frames = match self.claim_writer(terminal_id, viewer_key) {
            Ok(frames) => frames,
            Err(_) => return self.close(terminal_id),
        };
        match op::confirm_key(bytes) {
            Some(ConfirmKey::Accept) => frames.extend(self.accept_operator(terminal_id)),
            Some(ConfirmKey::Decline) => {
                tracing::info!(terminal_id, "a person declined an operator step");
                frames.extend(self.close(terminal_id));
            }
            None => {}
        }
        frames
    }

    /// Enter: spawn a fresh PTY that runs only the step's command, then
    /// answer `operator_running`. A spawn failure closes the terminal.
    #[cfg(unix)]
    fn accept_operator(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        let Some(session) = self.sessions.get(terminal_id) else {
            return Vec::new();
        };
        let Some(state) = session.operator.as_ref().filter(|state| !state.running) else {
            return Vec::new();
        };
        let (cols, rows) = session.pty_size;
        let (program, args) = op::wrapper_argv(&state.screen.command);
        let spawned = super::user_home()
            .ok()
            .and_then(|home| crate::child_env::resolve_cwd(None, &home).ok())
            .ok_or_else(|| anyhow::anyhow!("no home directory"))
            .and_then(|cwd| {
                super::spawn_pty(
                    &program,
                    &args,
                    &cwd,
                    &state.env,
                    cols,
                    rows,
                    &self.tx,
                    terminal_id,
                )
            });
        let pty = match spawned {
            Ok(pty) => pty,
            Err(error) => {
                tracing::warn!(error = %error, terminal_id, "starting an operator command failed");
                return self.close(terminal_id);
            }
        };
        let Some(session) = self.sessions.get_mut(terminal_id) else {
            return Vec::new();
        };
        let Some(state) = session.operator.as_mut() else {
            return Vec::new();
        };
        state.running = true;
        let _ = state.events.try_send(OperatorEvent::Accepted);
        let running = state.ids.result(JobStatus::OperatorRunning, None);
        tracing::info!(
            step_id = state.ids.step_id,
            "a person started an operator command"
        );
        session.pty = Some(pty);
        // The command's output starts on a clean screen.
        let clear = b"\x1b[H\x1b[2J";
        super::push_scrollback(&mut session.scrollback, clear);
        let mut frames = session.broadcast_data(terminal_id, clear);
        frames.push(OutboundFrame::Control(running));
        frames
    }

    #[cfg(not(unix))]
    fn accept_operator(&mut self, terminal_id: &str) -> Vec<OutboundFrame> {
        self.close(terminal_id)
    }
}
