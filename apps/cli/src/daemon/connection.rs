//! One relay connection, from dial to teardown: the hello, the session
//! loop (worker output, heartbeats, local changes, server frames) and the
//! goodbye.

use std::io;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use url::Url;

use crate::config::Config;
use crate::control::ControlServer;
use crate::protocol::{
    NodeFrame, RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS, RELAY_PROTOCOL_VERSION, RELAY_SUBPROTOCOL,
};
use crate::relay_bus::{FromWorker, WsFrame};
use crate::runtime_store::Defines;
use crate::sessions::TerminalRegistry;
use crate::startup::TerminalStartup;

use super::backoff::ConnectProgress;
use super::dispatch::{handle_binary, handle_text};
use super::handshake::{
    StopOn, check_hello_origin, connect_relay, protocol_mismatch,
    relay_connect_error_with_discovery, wait_for_hello_challenge,
};
use super::link::NodeLink;
use super::local::{ConfigWatch, local_changes, reload_config};
use super::node_runtimes::NodeRuntimes;
use super::requests::{RelayRequests, Retire};
use super::runtime_jobs::drain_runner;
use super::session::{
    FrameClass, Gate, Session, SessionPhase, apply_node_changes, emit, gate, node_features,
    sync_metric_commands,
};
use super::wire::{
    RelaySessionError, RelaySessionResult, next_id, read_poll_woke, send_control, send_file_frames,
    send_outbound_frames, send_stt, send_stt_frames, set_read_poll, set_socket_timeouts,
    websocket_session_error,
};

/// How long the main loop parks in `socket.read()` before waking to drain worker
/// output and send heartbeats. Bounds worker-frame latency (response streaming)
/// without busy-spinning.
const RELAY_SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(25);
const RELAY_SOCKET_BUSY_POLL: Duration = Duration::from_millis(1);
const DRAIN_MAX_MESSAGES: usize = 256;
const DRAIN_MAX_TIME: Duration = Duration::from_millis(20);

/// Bound on registration after this node sends `hello`.
const HELLO_OK_TIMEOUT: Duration = Duration::from_secs(60);

/// How often the relay loop hands the live endpoint list to the telemetry thread.
const TELEMETRY_SYNC_INTERVAL: Duration = Duration::from_secs(5);

/// Dead-peer detection starts at the first heartbeat sent after the last inbound
/// frame, so a stall of this loop without a sent heartbeat never reads as silence.
const RELAY_HEARTBEAT_ANSWER_TIMEOUT: Duration =
    Duration::from_secs(2 * RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);

#[derive(Default)]
struct PeerWatch {
    unanswered_since: Option<Instant>,
}

impl PeerWatch {
    fn on_inbound(&mut self) {
        self.unanswered_since = None;
    }

    fn on_heartbeat_sent(&mut self, now: Instant) {
        self.unanswered_since.get_or_insert(now);
    }

    fn is_dead(&self, now: Instant) -> bool {
        self.unanswered_since.is_some_and(|since| {
            now.saturating_duration_since(since) >= RELAY_HEARTBEAT_ANSWER_TIMEOUT
        })
    }
}

struct HelloOkDeadline(Instant);

impl HelloOkDeadline {
    fn expired(&self, registered: bool, now: Instant) -> bool {
        !registered && now.saturating_duration_since(self.0) >= HELLO_OK_TIMEOUT
    }
}

/// One relay connection. `progress` says how far it got (the reconnect
/// backoff reads it), whatever it returns.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_relay_session(
    config: &Config,
    startup: &TerminalStartup,
    node_slug: &str,
    ws_url: &Url,
    auth_value: HeaderValue,
    control: &mut ControlServer,
    link: &mut NodeLink,
    progress: &mut ConnectProgress,
) -> RelaySessionResult<()> {
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| RelaySessionError::Fatal(anyhow::Error::new(error)))?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static(RELAY_SUBPROTOCOL),
    );
    request.headers_mut().insert("Authorization", auth_value);
    let (mut socket, response) = connect_relay(request).map_err(|error| {
        relay_connect_error_with_discovery(error, StopOn::here(), || {
            crate::auth::fetch_well_known_document(config.server_url.as_deref().unwrap_or_default())
                .ok()
                .map(|known| known.protocol_version)
        })
    })?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        != Some(RELAY_SUBPROTOCOL)
    {
        return Err(protocol_mismatch(
            anyhow::anyhow!(
                "server did not accept relay websocket subprotocol `{RELAY_SUBPROTOCOL}`; upgrade the WS Model Proxy server"
            ),
            StopOn::here(),
        ));
    }
    *progress = ConnectProgress::Upgraded;
    set_socket_timeouts(
        socket.get_mut(),
        RELAY_SOCKET_POLL_INTERVAL,
        Duration::from_secs(5),
    )
    .map_err(|error| RelaySessionError::Reconnectable { error })?;

    // Created before hello so an early `?` still drops (and kills) every child.
    let worker_tx = link.worker_tx.clone();
    let worker_rx = &link.worker_rx;
    // The watch starts before the pre-hello reload: no edit falls between.
    let mut config_watch = ConfigWatch::new();
    let mut session = Session {
        worker_tx: worker_tx.clone(),
        requests: RelayRequests::new(),
        terminals: TerminalRegistry::with_image_worker(worker_tx.clone(), Arc::clone(&link.images)),
        execs: &mut link.execs,
        deferred: &mut link.deferred,
        held: Vec::new(),
        lowerings_applied: &mut link.lowerings_applied,
        // Live speech-to-text sessions; dropping the registry ends them all.
        stt: crate::stt::SttRegistry::new(worker_tx.clone()),
        // Node file ops run on the daemon's file pool, never on this loop;
        // the relay keeps only the ops it has pending.
        files: {
            let runtime = crate::file_relay::shared_runtime(
                startup.allow_file_tools_as_root(),
                startup.file_roots(),
            );
            let tx = worker_tx.clone();
            let sink: crate::file_relay::FileSink = Arc::new(move |op_id, frames| {
                let _ = tx.send(FromWorker::FileFrames { op_id, frames });
            });
            crate::file_relay::FileRelay::new(runtime, startup.trust_authority(), sink)
        },
        phase: SessionPhase::PreHello,
        telemetry: None,
        defines: Defines::default(),
        runtimes: NodeRuntimes::load(startup.trust_value(), &startup.runtime_hosts()),
        runner: link.runner.as_ref().inspect(|runner| runner.observe()),
        inventories: Arc::clone(&link.inventories),
        observed_generation: 0,
        metric_commands_applied: None,
        update: &mut link.update,
        update_idle_checked: None,
    };

    let server_url = config.server_url.as_deref().unwrap_or_default();
    let hello_origin = config.hello_origin().map_err(RelaySessionError::Fatal)?;
    startup
        .ensure_identity()
        .map_err(RelaySessionError::Fatal)?;
    let (nonce, origin) = wait_for_hello_challenge(&mut socket, StopOn::here())?;
    *progress = ConnectProgress::Challenged;
    check_hello_origin(&origin, &hello_origin, server_url)?;
    let identity_signature = startup
        .sign_hello(&nonce, node_slug, &origin)
        .map_err(RelaySessionError::Fatal)?;
    // Any edit made while connecting (a hand-written `relay`) applies before
    // the hello reports trust.
    match reload_config(startup) {
        Ok(changes) => apply_node_changes(&mut socket, startup, &mut session, &changes)?,
        Err(error) => tracing::warn!(
            error = %format!("{error:#}"),
            "reloading the config failed"
        ),
    }
    let hello = NodeFrame::Hello {
        id: next_id("hello"),
        protocol_version: RELAY_PROTOCOL_VERSION.to_string(),
        node: startup.hello_node(node_slug, identity_signature),
        trust: startup.trust(),
        features: node_features(startup),
        definitions: session.runtimes.held_definitions(),
        held_metric_commands_hash: session.runtimes.metric_commands_hash(),
        held_port_range: session.runtimes.port_range(),
        held_fabrics_hash: session.runtimes.fabrics_hash(),
    };
    send_control(&mut socket, &hello, "sending relay hello")?;
    let hello_ok_deadline = HelloOkDeadline(Instant::now());
    session.phase = SessionPhase::AwaitingHelloOk;
    *progress = ConnectProgress::HelloSent;

    let mut next_telemetry_sync = Instant::now();
    let mut next_heartbeat =
        Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
    let mut peer = PeerWatch::default();
    let mut busy_poll = false;
    let result = 'session: loop {
        if let Some(signal) = crate::shutdown::requested() {
            break 'session Err(RelaySessionError::Shutdown(signal));
        }
        if hello_ok_deadline.expired(session.phase.is_registered(), Instant::now()) {
            break Err(RelaySessionError::Reconnectable {
                error: anyhow::anyhow!(
                    "the server sent no hello.ok within {} s after hello; reconnecting",
                    HELLO_OK_TIMEOUT.as_secs()
                ),
            });
        }
        if session.phase.is_registered() {
            // Commands that ended (or were interrupted) while disconnected,
            // then this connection's frames held until `hello.ok`.
            let pending = std::mem::take(session.deferred);
            let held = std::mem::take(&mut session.held);
            if let Err(error) = send_outbound_frames(&mut socket, pending)
                .and_then(|()| send_outbound_frames(&mut socket, held))
            {
                break Err(error);
            }
        }
        let drain = match drain_worker_output(&mut socket, worker_rx, &mut session) {
            Ok(drain) => drain,
            Err(error) => break Err(error),
        };
        let more_output = drain == Drain::More;
        if more_output != busy_poll {
            let interval = if more_output {
                RELAY_SOCKET_BUSY_POLL
            } else {
                RELAY_SOCKET_POLL_INTERVAL
            };
            if let Err(error) = set_read_poll(socket.get_mut(), interval) {
                break Err(RelaySessionError::Reconnectable { error });
            }
            busy_poll = more_output;
        }
        if let Err(error) = drain_runner(&mut socket, &mut session) {
            break Err(error);
        }
        if let Err(error) = poll_updates(&mut socket, startup, &mut session) {
            break Err(error);
        }
        let now = Instant::now();
        let terminal_frames = session.terminals.poll(now);
        if let Err(error) = emit(
            &mut socket,
            &mut session,
            FrameClass::SessionScoped,
            terminal_frames,
        ) {
            break Err(error);
        }
        let ended = session.execs.poll(now);
        if let Err(error) = emit(&mut socket, &mut session, FrameClass::Command, ended) {
            break Err(error);
        }
        let endpoints = session.runtimes.endpoints();
        let stt_frames = session.stt.poll(now, || endpoints.clone());
        if let Err(error) = send_stt_frames(&mut socket, &mut session.stt, stt_frames) {
            break Err(error);
        }
        if let Err(error) = send_file_frames(&mut socket, session.files.expire_stale(now)) {
            break Err(error);
        }
        let changes = match local_changes(
            control,
            startup,
            node_slug,
            session.phase.connection(),
            &mut config_watch,
        ) {
            Ok(changes) => changes,
            Err(error) => break Err(RelaySessionError::Fatal(error)),
        };
        if let Err(error) = apply_node_changes(&mut socket, startup, &mut session, &changes) {
            break Err(error);
        }
        if session.phase.is_registered() && Instant::now() >= next_telemetry_sync {
            let endpoints = session.runtimes.endpoints();
            match session.telemetry.as_ref() {
                Some(telemetry) => telemetry.set_endpoints(&endpoints),
                None => {
                    session.telemetry = Some(crate::telemetry::Telemetry::start(
                        worker_tx.clone(),
                        &endpoints,
                    ));
                }
            }
            sync_metric_commands(&mut session);
            next_telemetry_sync = Instant::now() + TELEMETRY_SYNC_INTERVAL;
        }
        if gate(session.phase, FrameClass::Periodic) == Gate::Send
            && Instant::now() >= next_heartbeat
        {
            let heartbeat = NodeFrame::Heartbeat {
                id: next_id("heartbeat"),
                sent_at: None,
            };
            if let Err(error) = send_control(&mut socket, &heartbeat, "sending relay heartbeat") {
                break Err(error);
            }
            peer.on_heartbeat_sent(Instant::now());
            next_heartbeat =
                Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
        }

        let incoming = socket.read();
        if incoming.is_ok() {
            peer.on_inbound();
        }
        let outcome = match incoming {
            Ok(Message::Text(text)) => {
                handle_text(&mut socket, config, startup, &mut session, &text)
            }
            Ok(Message::Binary(bytes)) => handle_binary(&mut socket, &bytes, &mut session),
            Ok(Message::Close(frame)) => {
                tracing::warn!(?frame, "relay websocket closed by server");
                Err(RelaySessionError::Reconnectable {
                    error: anyhow::anyhow!("relay websocket closed by server"),
                })
            }
            Ok(Message::Ping(bytes)) => socket
                .send(Message::Pong(bytes))
                .map_err(|error| websocket_session_error(error, "sending relay pong")),
            Ok(Message::Pong(_)) => Ok(()),
            Ok(Message::Frame(_)) => Ok(()),
            Err(tungstenite::Error::Io(err)) if read_poll_woke(&err) => {
                if peer.is_dead(Instant::now()) {
                    Err(RelaySessionError::Reconnectable {
                        error: anyhow::anyhow!(
                            "no answer from the server for {} s after a heartbeat; reconnecting",
                            RELAY_HEARTBEAT_ANSWER_TIMEOUT.as_secs()
                        ),
                    })
                } else {
                    Ok(())
                }
            }
            Err(err) => Err(websocket_session_error(err, "reading relay websocket")),
        };
        if let Err(error) = outcome {
            break Err(error);
        }
    };

    if let SessionPhase::Registered { since } = session.phase {
        *progress = ConnectProgress::Registered { since };
    }
    session.phase = SessionPhase::Closing;
    session.update.on_session_end();
    // Stops the sampling thread; a scrape in flight finishes on its own.
    drop(session.telemetry.take());
    let killed = session.terminals.kill_all();
    let _ = emit(&mut socket, &mut session, FrameClass::SessionScoped, killed);
    // Commands outlive a reconnect; a shutdown ends them (interrupted).
    if crate::shutdown::requested().is_some() {
        let killed = session.execs.kill_all();
        let _ = emit(&mut socket, &mut session, FrameClass::Command, killed);
    }
    // In-flight file ops are cancelled; their results are dropped.
    session.files.cancel_all();
    // The server fails these sessions itself when the relay drops.
    session.stt.abort_all();
    session.requests.abort_all();
    let result = settle_after_shutdown(result, crate::shutdown::requested());
    if matches!(
        result,
        Err(RelaySessionError::Shutdown(_) | RelaySessionError::RestartForUpdate)
    ) {
        // The connection is still open: say goodbye so the server marks the
        // node offline now instead of waiting for a heartbeat timeout. The
        // shutdown deadline bounds a peer that never answers.
        let _ = socket.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Away,
            reason: "cli shutting down".into(),
        }));
        flush_through_interrupts(&mut socket);
    }
    result
}

/// A session that failed after a shutdown signal arrived still ends as a
/// shutdown. The signal itself can cause the failure: a relay write blocked
/// under the socket's send timeout returns `EINTR` when the handler runs on
/// this thread, which would otherwise read as a lost connection and skip the
/// goodbye close frame.
fn settle_after_shutdown<T>(
    result: RelaySessionResult<T>,
    requested: Option<i32>,
) -> RelaySessionResult<T> {
    match (result, requested) {
        (
            Err(RelaySessionError::Reconnectable { error, .. } | RelaySessionError::Fatal(error)),
            Some(signal),
        ) => {
            tracing::debug!(
                error = %format!("{error:#}"),
                signal,
                "relay session error after a shutdown signal; stopping as shut down"
            );
            Err(RelaySessionError::Shutdown(signal))
        }
        (result, _) => result,
    }
}

/// Flush the queued close frame, retrying a write a signal interrupted
/// (bounded, so a peer that keeps failing cannot hold the shutdown).
fn flush_through_interrupts<S: io::Read + io::Write>(socket: &mut tungstenite::WebSocket<S>) {
    for _ in 0..8 {
        match socket.flush() {
            Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::Interrupted => {}
            _ => return,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Drain {
    Empty,
    More,
}

/// Bound each drain so socket reads and control work run even under output floods.
fn drain_bounded<T>(
    rx: &Receiver<T>,
    max: usize,
    budget: Duration,
    mut send: impl FnMut(T) -> RelaySessionResult<()>,
) -> RelaySessionResult<Drain> {
    let started = Instant::now();
    let mut count = 0;
    loop {
        if count >= max || started.elapsed() >= budget {
            return Ok(Drain::More);
        }
        match rx.try_recv() {
            Ok(message) => {
                send(message)?;
                count += 1;
            }
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => {
                return Ok(Drain::Empty);
            }
        }
    }
}

fn drain_worker_output<S>(
    socket: &mut tungstenite::WebSocket<S>,
    worker_rx: &Receiver<FromWorker>,
    session: &mut Session,
) -> RelaySessionResult<Drain>
where
    S: std::io::Read + std::io::Write,
{
    drain_bounded(worker_rx, DRAIN_MAX_MESSAGES, DRAIN_MAX_TIME, |message| {
        match message {
            FromWorker::Send { request_id, frame } => {
                // A cancellation removes the live handle before acknowledging
                // it. Suppress any racing worker frame already queued behind
                // that cancellation so cancelled requests never complete late.
                if !session.requests.is_live(&request_id) {
                    return Ok(());
                }
                match frame {
                    WsFrame::Text(text) => socket.send(Message::Text(text.into())),
                    WsFrame::Binary(bytes) => socket.send(Message::Binary(bytes.into())),
                }
                .map_err(|error| websocket_session_error(error, "sending relay frame"))?;
            }
            FromWorker::Finished(request_id) => {
                session.requests.retire(&request_id, Retire::Finished);
            }
            FromWorker::TerminalBytes { terminal_id, bytes } => {
                send_outbound_frames(socket, session.terminals.on_bytes(&terminal_id, &bytes))?;
            }
            FromWorker::TerminalEof { terminal_id } => {
                send_outbound_frames(socket, session.terminals.on_eof(&terminal_id))?;
            }
            FromWorker::TerminalWriteFailed { terminal_id } => {
                tracing::warn!(
                    terminal_id,
                    "writing terminal input failed; closing the terminal"
                );
                send_outbound_frames(socket, session.terminals.close(&terminal_id))?;
            }
            FromWorker::ExecBytes {
                command_id,
                stderr,
                bytes,
            } => session.execs.on_bytes(&command_id, stderr, &bytes),
            FromWorker::ExecEof { command_id, stderr } => {
                session.execs.on_eof(&command_id, stderr);
            }
            FromWorker::Stt {
                session_id,
                message,
            } => {
                if let Some(message) = session.stt.outbound(&session_id, *message) {
                    send_stt(socket, &mut session.stt, message)?;
                }
            }
            // A frame queued by a closed session's worker never precedes
            // this session's hello.
            FromWorker::Telemetry(text) => {
                if gate(session.phase, FrameClass::Periodic) == Gate::Send {
                    socket
                        .send(Message::Text(text.into()))
                        .map_err(|error| websocket_session_error(error, "sending telemetry"))?;
                }
            }
            FromWorker::FileFrames { op_id, frames } => {
                // Cancelled or torn-down ops are no longer pending: drop them.
                if session.files.complete(&op_id) {
                    send_file_frames(socket, frames)?;
                }
            }
        }
        Ok(())
    })
}

/// How often a waiting update reads whether the node is idle.
const UPDATE_IDLE_CHECK: Duration = Duration::from_secs(2);

/// Drive the update tracker: idleness for a waiting update, progress frames,
/// the confirmation, and the restart. A forced update's instances are stopped
/// by the server, through its normal stop operations.
fn poll_updates<S>(
    socket: &mut tungstenite::WebSocket<S>,
    startup: &TerminalStartup,
    session: &mut Session,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    if session.update.wants_idle()
        && session
            .update_idle_checked
            .is_none_or(|at| at.elapsed() >= UPDATE_IDLE_CHECK)
    {
        session.update_idle_checked = Some(Instant::now());
        let running = crate::update::agent::running_instances();
        session
            .update
            .set_idle(running.is_empty(), session.execs.running() == 0);
    }
    let (frames, restart) = session.update.poll(startup.full_control());
    for frame in frames {
        send_control(socket, &frame, "sending update progress")?;
    }
    if restart {
        return Err(RelaySessionError::RestartForUpdate);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_ok_deadline_expires_after_hello_and_is_disabled_when_registered() {
        let sent = Instant::now();
        let deadline = HelloOkDeadline(sent);
        assert!(!deadline.expired(false, sent));
        assert!(!deadline.expired(false, sent + HELLO_OK_TIMEOUT - Duration::from_nanos(1)));
        assert!(deadline.expired(false, sent + HELLO_OK_TIMEOUT));
        assert!(deadline.expired(false, sent + HELLO_OK_TIMEOUT * 2));
        assert!(!deadline.expired(true, sent + HELLO_OK_TIMEOUT * 2));
    }

    #[test]
    fn peer_watch_unarmed_stays_alive_through_a_loop_stall() {
        let peer = PeerWatch::default();
        let now = Instant::now();
        assert!(!peer.is_dead(now));
        assert!(!peer.is_dead(now + Duration::from_secs(300)));
    }

    #[test]
    fn peer_watch_expires_forty_seconds_after_the_first_unanswered_heartbeat() {
        let now = Instant::now();
        let mut peer = PeerWatch::default();
        peer.on_heartbeat_sent(now);
        assert!(!peer.is_dead(now + Duration::from_secs(39)));
        assert!(peer.is_dead(now + Duration::from_secs(40)));
    }

    #[test]
    fn peer_watch_later_heartbeats_do_not_extend_the_deadline() {
        let now = Instant::now();
        let mut peer = PeerWatch::default();
        peer.on_heartbeat_sent(now);
        peer.on_heartbeat_sent(now + Duration::from_secs(20));
        assert!(peer.is_dead(now + Duration::from_secs(40)));
    }

    #[test]
    fn peer_watch_any_inbound_frame_resets_the_window() {
        let now = Instant::now();
        let mut peer = PeerWatch::default();
        peer.on_heartbeat_sent(now);
        peer.on_inbound();
        assert!(!peer.is_dead(now + Duration::from_secs(300)));
        peer.on_heartbeat_sent(now + Duration::from_secs(300));
        assert!(!peer.is_dead(now + Duration::from_secs(339)));
        assert!(peer.is_dead(now + Duration::from_secs(340)));
    }

    #[test]
    fn drain_bounded_caps_message_count_and_leaves_the_rest_queued() {
        let (tx, rx) = mpsc::sync_channel(300);
        for message in 0..300 {
            tx.send(message).expect("queue message");
        }
        let mut sent = Vec::new();
        let drained = drain_bounded(&rx, 256, Duration::from_secs(10), |message| {
            sent.push(message);
            Ok(())
        });
        assert!(matches!(drained, Ok(Drain::More)));
        assert_eq!(sent, (0..256).collect::<Vec<_>>());
        assert_eq!(
            rx.try_iter().collect::<Vec<_>>(),
            (256..300).collect::<Vec<_>>()
        );
    }

    #[test]
    fn drain_bounded_returns_empty_after_a_short_queue_or_disconnection() {
        let (tx, rx) = mpsc::sync_channel(10);
        for message in 0..10 {
            tx.send(message).expect("queue message");
        }
        let mut sent = 0;
        assert!(matches!(
            drain_bounded(&rx, 256, Duration::from_secs(10), |_| {
                sent += 1;
                Ok(())
            }),
            Ok(Drain::Empty)
        ));
        assert_eq!(sent, 10);
        drop(tx);
        assert!(matches!(
            drain_bounded(&rx, 256, Duration::from_secs(10), |_| Ok(())),
            Ok(Drain::Empty)
        ));
    }

    #[test]
    fn drain_bounded_yields_when_the_time_budget_expires() {
        let (tx, rx) = mpsc::sync_channel(10);
        for message in 0..10 {
            tx.send(message).expect("queue message");
        }
        let mut sent = 0;
        assert!(matches!(
            drain_bounded(&rx, 256, Duration::from_millis(20), |_| {
                sent += 1;
                std::thread::sleep(Duration::from_millis(5));
                Ok(())
            }),
            Ok(Drain::More)
        ));
        assert!(sent <= 5);
        assert_eq!(rx.try_iter().count(), 10 - sent);
    }

    #[test]
    fn drain_bounded_propagates_sender_errors() {
        let (tx, rx) = mpsc::sync_channel(2);
        tx.send(1).expect("first message");
        tx.send(2).expect("second message");
        let result = drain_bounded(&rx, 256, Duration::from_secs(10), |_| {
            Err(RelaySessionError::Reconnectable {
                error: anyhow::anyhow!("send failed"),
            })
        });
        assert!(
            matches!(result, Err(RelaySessionError::Reconnectable { error }) if error.to_string() == "send failed")
        );
        assert_eq!(rx.try_recv().expect("remaining message"), 2);
    }

    /// Fails the first `interrupts` writes with `EINTR`, as a write blocked
    /// under a send timeout does when a signal handler runs on the thread.
    struct InterruptedStream {
        interrupts: usize,
        written: Vec<u8>,
    }

    impl io::Read for InterruptedStream {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Ok(0)
        }
    }

    impl io::Write for InterruptedStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.interrupts > 0 {
                self.interrupts -= 1;
                return Err(io::ErrorKind::Interrupted.into());
            }
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn session_errors_after_a_shutdown_signal_end_as_shutdown() {
        let interrupted = || RelaySessionError::Reconnectable {
            error: anyhow::Error::new(io::Error::from(io::ErrorKind::Interrupted)),
        };
        assert!(matches!(
            settle_after_shutdown::<()>(Err(interrupted()), Some(15)),
            Err(RelaySessionError::Shutdown(15))
        ));
        assert!(matches!(
            settle_after_shutdown::<()>(
                Err(RelaySessionError::Fatal(anyhow::anyhow!("x"))),
                Some(2)
            ),
            Err(RelaySessionError::Shutdown(2))
        ));
        assert!(matches!(
            settle_after_shutdown::<()>(Err(interrupted()), None),
            Err(RelaySessionError::Reconnectable { .. })
        ));
        assert!(matches!(
            settle_after_shutdown::<()>(Err(RelaySessionError::Shutdown(1)), Some(15)),
            Err(RelaySessionError::Shutdown(1))
        ));
        assert!(settle_after_shutdown(Ok(()), Some(15)).is_ok());
    }

    #[test]
    fn the_goodbye_close_frame_survives_interrupted_writes() {
        let mut socket = tungstenite::WebSocket::from_raw_socket(
            InterruptedStream {
                interrupts: 2,
                written: Vec::new(),
            },
            // Server role: frames are unmasked, so the reason can be read back.
            tungstenite::protocol::Role::Server,
            None,
        );
        let _ = socket.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Away,
            reason: "cli shutting down".into(),
        }));
        flush_through_interrupts(&mut socket);
        let written = &socket.get_ref().written;
        assert_eq!(written.first(), Some(&0x88), "a close frame was written");
        assert!(
            written
                .windows(b"cli shutting down".len())
                .any(|window| window == b"cli shutting down".as_slice()),
            "the close frame was written whole"
        );
    }
}
