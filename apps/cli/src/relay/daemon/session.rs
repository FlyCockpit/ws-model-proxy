//! One relay connection's state ([`Session`]) and the policy for which of
//! its frames go out in which phase ([`gate`]).

use std::sync::Arc;
use std::sync::mpsc::SyncSender;
use std::time::Instant;

use crate::node::runtime_store::Defines;
use crate::relay::sessions::{ExecRegistry, OutboundFrame, TerminalRegistry};
use crate::relay::startup::TerminalStartup;
use crate::services::relay_bus::FromWorker;
use crate::wire::protocol::NodeFrame;

use super::local::{NodeChange, take_lowering};
use super::node_runtimes::NodeRuntimes;
use super::requests::RelayRequests;
use super::wire::{RelaySessionResult, send_outbound_frames};

/// Everything one relay connection owns. Dropping it ends every terminal,
/// command, file op and speech session it started.
pub(super) struct Session<'a> {
    pub(super) worker_tx: SyncSender<FromWorker>,
    pub(super) requests: RelayRequests,
    pub(super) terminals: TerminalRegistry,
    /// Node commands outlive a connection (daemon lifetime, `NodeLink`).
    pub(super) execs: &'a mut ExecRegistry,
    /// Command statuses held until a connection is registered (across
    /// connections: [`FrameClass::Command`]).
    pub(super) deferred: &'a mut Vec<OutboundFrame>,
    /// This connection's own frames held until `hello.ok`, dropped with it
    /// ([`Gate::Hold`]).
    pub(super) held: Vec<OutboundFrame>,
    /// The lowering count whose effects were applied (`NodeLink`).
    pub(super) lowerings_applied: &'a mut u64,
    pub(super) stt: crate::services::stt::SttRegistry,
    pub(super) files: crate::services::file_relay::FileRelay,
    pub(super) phase: SessionPhase,
    pub(super) telemetry: Option<crate::services::telemetry::Telemetry>,
    pub(super) defines: Defines,
    pub(super) runtimes: NodeRuntimes,
    /// The daemon's runner (`NodeLink::runner`), shared by every connection.
    pub(super) runner: Option<&'a crate::services::runtimes::runner::Runner>,
    /// The daemon's inventory worker (`NodeLink::inventories`), shared by every connection.
    pub(super) inventories: Arc<crate::services::runtimes::inventory::Inventories>,
    /// The newest instance observation applied.
    pub(super) observed_generation: u64,
    /// The metric commands hash the telemetry thread runs.
    pub(super) metric_commands_applied: Option<String>,
    /// The daemon's update tracker (across reconnects).
    pub(super) update: &'a mut crate::relay::update::agent::DaemonUpdate,
    /// When the node's idleness was last read for a waiting update.
    pub(super) update_idle_checked: Option<Instant>,
}

/// Where one relay connection stands. Nothing but the hello may reach the
/// server before `hello.ok` (it closes the socket otherwise), so every
/// outbound frame that is not a direct answer to a server frame passes
/// [`gate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SessionPhase {
    /// Connected; the hello has not gone out.
    PreHello,
    /// The hello went out; `hello.ok` has not arrived.
    AwaitingHelloOk,
    /// `hello.ok` arrived at `since`.
    Registered { since: Instant },
    /// The session is ending: last frames go out best effort.
    Closing,
}

impl SessionPhase {
    pub(super) fn is_registered(self) -> bool {
        matches!(self, Self::Registered { .. })
    }

    /// The `connection` word `wsmp status` shows.
    pub(super) fn connection(self) -> &'static str {
        if self.is_registered() {
            "connected"
        } else {
            "registering"
        }
    }
}

/// What kind of node frame is about to go out, for [`gate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FrameClass {
    /// Heartbeats and telemetry samples: worthless once stale.
    Periodic,
    /// `node.state`: the hello reports trust and features, so only a change
    /// after the hello went out must still reach the server.
    NodeState,
    /// Frames of this connection's own work (operator and browser
    /// terminals, runtime step results): they mean nothing on another
    /// connection.
    SessionScoped,
    /// Command statuses: commands outlive the connection, so do they.
    Command,
}

/// What [`gate`] decides for one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Gate {
    Send,
    /// Keep it in this session until `hello.ok` ([`Session::held`]).
    Hold,
    /// Keep it for whichever connection registers next ([`Session::deferred`]).
    Defer,
    Drop,
}

/// The one policy for node frames by session phase.
pub(super) fn gate(phase: SessionPhase, class: FrameClass) -> Gate {
    match (phase, class) {
        (SessionPhase::Registered { .. }, _) => Gate::Send,
        (_, FrameClass::Periodic) => Gate::Drop,
        // The hello (still to go out) reports it; a closing session is past caring.
        (SessionPhase::PreHello | SessionPhase::Closing, FrameClass::NodeState) => Gate::Drop,
        (SessionPhase::AwaitingHelloOk, FrameClass::NodeState) => Gate::Hold,
        // Teardown sends terminal ends and interrupted commands best effort.
        (SessionPhase::Closing, FrameClass::SessionScoped | FrameClass::Command) => Gate::Send,
        (_, FrameClass::SessionScoped) => Gate::Hold,
        (_, FrameClass::Command) => Gate::Defer,
    }
}

/// Send `frames` as [`gate`] decides for `class` in the session's phase.
pub(super) fn emit<S>(
    socket: &mut tungstenite::WebSocket<S>,
    session: &mut Session,
    class: FrameClass,
    frames: Vec<OutboundFrame>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    if frames.is_empty() {
        return Ok(());
    }
    match gate(session.phase, class) {
        Gate::Send => send_outbound_frames(socket, frames),
        Gate::Hold => {
            session.held.extend(frames);
            Ok(())
        }
        Gate::Defer => {
            session.deferred.extend(frames);
            Ok(())
        }
        Gate::Drop => Ok(()),
    }
}

/// [`emit`] for one control frame.
pub(super) fn emit_control<S>(
    socket: &mut tungstenite::WebSocket<S>,
    session: &mut Session,
    class: FrameClass,
    frame: NodeFrame,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    emit(socket, session, class, vec![OutboundFrame::Control(frame)])
}

/// The hello `features`, with the names of the node's secrets.
pub(super) fn node_features(
    startup: &TerminalStartup,
) -> crate::wire::protocol::runtime_spec::NodeFeatures {
    let mut features = startup.features();
    features.secrets = crate::node::secrets::entries();
    features.self_update = Some(crate::relay::update::agent::features());
    features
}

/// Session effects of a trust or feature change, then `node.state`.
/// Lowering ends every Full-only session: commands (whole process tree,
/// reported `interrupted`), browser terminals and file ops, and switches the
/// held set to the frozen copy.
///
/// The lowering is read from the daemon's trust ([`take_lowering`]), not
/// from `changes`: a raise and a lowering in one loop turn, in any order,
/// end every session the lowering revoked, and the file relay admits by the
/// trust as it is now.
pub(super) fn apply_node_changes<S>(
    socket: &mut tungstenite::WebSocket<S>,
    startup: &TerminalStartup,
    session: &mut Session,
    changes: &[NodeChange],
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let lowered = take_lowering(session.lowerings_applied, startup);
    if changes.is_empty() && !lowered {
        return Ok(());
    }
    session.files.on_trust_changed();
    if lowered {
        let interrupted = session.execs.interrupt_all();
        // Operator terminals are allowed at Relay only: they stay.
        let closed = session.terminals.on_trust_lowered();
        emit(socket, session, FrameClass::SessionScoped, closed)?;
        emit(socket, session, FrameClass::Command, interrupted)?;
    } else if changes.contains(&NodeChange::HumanTerminalsDisabled) {
        // Operator terminals do not need the switch: they stay.
        let closed = session.terminals.on_human_terminals_disabled();
        emit(socket, session, FrameClass::SessionScoped, closed)?;
    }
    // Trust changes switch the held set; host changes re-check addresses.
    session
        .runtimes
        .reload(startup.trust_value(), &startup.runtime_hosts());
    session
        .execs
        .set_command_max(session.runtimes.command_max());
    sync_metric_commands(session);
    emit_control(socket, session, FrameClass::NodeState, node_state(startup))
}

/// Node metric commands follow the held (frozen at Relay only) node
/// definition; applied as soon as it changes.
pub(super) fn sync_metric_commands(session: &mut Session<'_>) {
    let hash = session.runtimes.metric_commands_hash();
    if hash != session.metric_commands_applied
        && let Some(telemetry) = session.telemetry.as_ref()
    {
        telemetry.set_metric_commands(session.runtimes.metric_commands());
        session.metric_commands_applied = hash;
    }
}

/// Send a fresh `runtime.inventory` (built off this loop).
pub(super) fn send_inventory(session: &Session) {
    session.inventories.capture(
        session.worker_tx.clone(),
        session.runtimes.store.clone(),
        session.runtimes.instance_records(),
    );
}

/// The `node.state` this node reports now (trust and features).
pub(super) fn node_state(startup: &TerminalStartup) -> NodeFrame {
    NodeFrame::NodeState {
        trust: startup.trust(),
        features: node_features(startup),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_frame_gate_sends_only_the_hello_before_hello_ok() {
        let registered = SessionPhase::Registered {
            since: Instant::now(),
        };
        let classes = [
            FrameClass::Periodic,
            FrameClass::NodeState,
            FrameClass::SessionScoped,
            FrameClass::Command,
        ];
        for class in classes {
            assert_eq!(gate(registered, class), Gate::Send, "{class:?}");
            assert_ne!(gate(SessionPhase::PreHello, class), Gate::Send, "{class:?}");
            assert_ne!(
                gate(SessionPhase::AwaitingHelloOk, class),
                Gate::Send,
                "{class:?}"
            );
        }
        // The hello carries trust; a change after it waits for `hello.ok`.
        assert_eq!(
            gate(SessionPhase::PreHello, FrameClass::NodeState),
            Gate::Drop
        );
        assert_eq!(
            gate(SessionPhase::AwaitingHelloOk, FrameClass::NodeState),
            Gate::Hold
        );
        // Step results and terminal frames wait in the session; command
        // statuses wait for whichever connection registers.
        assert_eq!(
            gate(SessionPhase::AwaitingHelloOk, FrameClass::SessionScoped),
            Gate::Hold
        );
        assert_eq!(
            gate(SessionPhase::AwaitingHelloOk, FrameClass::Command),
            Gate::Defer
        );
        assert_eq!(
            gate(SessionPhase::Closing, FrameClass::Periodic),
            Gate::Drop
        );
        assert_eq!(gate(SessionPhase::Closing, FrameClass::Command), Gate::Send);
        assert_eq!(SessionPhase::AwaitingHelloOk.connection(), "registering");
        assert_eq!(registered.connection(), "connected");
    }
}
