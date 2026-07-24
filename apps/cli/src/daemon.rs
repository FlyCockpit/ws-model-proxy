//! Foreground websocket relay daemon.
//!
//! Request bodies are streamed to the upstream endpoint as they arrive over the
//! websocket instead of being fully buffered first. Each relayed request runs on
//! its own worker thread so a slow upstream cannot stall sibling requests
//! multiplexed on the shared socket. The single websocket writer stays on the
//! main loop: workers hand outbound frames back through a channel that the main
//! loop drains, and the server paces request-body frames with credit-based flow
//! control (`relay.request.body.ack`).

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::{self, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::{Message, connect};
use ureq::SendBody;
use url::Url;

use crate::auth::{join, resolve_credential};
use crate::config::Config;
use crate::media::{
    FetchedMedia, MEDIA_EXPAND_MAX_ASSET_BYTES, MEDIA_EXPAND_MAX_BODY_BYTES, MediaExpandError,
    TrustedOrigins, expand_media_in_body,
};
use crate::probe::{apply_probe_report, probe_endpoint};
use crate::protocol::{
    CliCapabilities, CliInventory, ClientControlMessage, EndpointInventory, EndpointStatus,
    RELAY_BINARY_CHUNK_MAX_BYTES, RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS, RELAY_PROTOCOL_VERSION,
    RELAY_REQUEST_BODY_WINDOW_CHUNKS, RELAY_SUBPROTOCOL, RelayBinaryFrameMetadata,
    RelayBinaryFrameType, RelayFailure, ServerControlMessage, encode_binary_frame, encode_control,
    endpoint_inventory, parse_binary_frame, parse_server_control,
};
use crate::slug::generated_slug;

const RELAY_RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(1);
const RELAY_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(300);
/// How long the main loop parks in `socket.read()` before waking to drain worker
/// output and send heartbeats. Bounds worker-frame latency (response streaming)
/// without busy-spinning.
const RELAY_SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// Bounded capacity for the worker -> main-loop outbound frame channel. Provides
/// backpressure toward workers (and therefore upstream response reads) so a fast
/// upstream cannot grow unbounded memory ahead of the websocket writer.
const RELAY_WORKER_OUTBOUND_CAPACITY: usize = 64;
/// Per-request timeout for fetching a WMP media URL during media expansion.
/// Independent of the upstream request timeout so a slow asset fetch fails on its
/// own clock rather than silently eating the whole upstream budget.
const RELAY_MEDIA_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// A frame produced by a worker for the main loop to write to the websocket.
enum WsFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// Message from a request worker to the main loop.
enum FromWorker {
    Send(WsFrame),
    Finished(String),
}

/// A request-body chunk delivered to a worker's upstream request reader.
struct BodyChunk {
    data: Vec<u8>,
    last: bool,
}

/// Handle the main loop keeps for an in-flight relayed request.
struct WorkerHandle {
    /// Sender feeding streamed request-body chunks to the worker. `None` for
    /// requests without a body. Dropping it aborts the upstream request body.
    body_tx: Option<SyncSender<BodyChunk>>,
    cancelled: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

/// How many recently-finished request ids to remember so late body chunks can
/// be dropped silently instead of provoking a bogus protocol error. A fast
/// upstream can respond and be reaped before the server has flushed the tail of
/// the request body, so a handful of trailing chunks per finished request is
/// normal; keeping the ring small bounds memory while still absorbing them.
const RECENT_FINISHED_CAPACITY: usize = 256;

/// Bounded record of request ids whose workers have already finished (completed,
/// cancelled, or rejected). Late `relay.request.body` chunks for these ids are
/// expected and dropped silently; only ids that were *never* seen still earn the
/// genuine "before request metadata" protocol error. Oldest ids are evicted once
/// the ring is full — a client streaming body that far behind a finished
/// response is misbehaving and can take the protocol error.
struct RecentlyFinished {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl RecentlyFinished {
    fn new() -> Self {
        Self {
            order: VecDeque::new(),
            ids: HashSet::new(),
        }
    }

    fn record(&mut self, request_id: &str) {
        if self.ids.insert(request_id.to_string()) {
            self.order.push_back(request_id.to_string());
            if self.order.len() > RECENT_FINISHED_CAPACITY {
                if let Some(evicted) = self.order.pop_front() {
                    self.ids.remove(&evicted);
                }
            }
        }
    }

    fn contains(&self, request_id: &str) -> bool {
        self.ids.contains(request_id)
    }
}

/// Everything a worker thread needs to perform one upstream request.
struct UpstreamRequestSpec {
    request_id: String,
    method: String,
    base_url: String,
    path: String,
    request_headers: BTreeMap<String, String>,
    endpoint_headers: Vec<(String, String)>,
    timeout_ms: u64,
    has_body: bool,
    /// When set, buffer a chat-shaped JSON body and inline trusted media URLs as
    /// `data:` URLs before forwarding. Off for the plain streaming relay path.
    expand_media: bool,
    /// Origins whose `/media/{id}` URLs may be fetched during expansion.
    trusted_origins: TrustedOrigins,
}

/// Reader that streams a relayed request body from the websocket into the
/// upstream HTTP request. It pulls chunks from a bounded channel and returns one
/// flow-control credit to the server for each chunk it consumes.
struct ChannelBodyReader {
    rx: Receiver<BodyChunk>,
    tx: SyncSender<FromWorker>,
    request_id: String,
    current: Vec<u8>,
    pos: usize,
    ended: bool,
}

impl ChannelBodyReader {
    fn new(rx: Receiver<BodyChunk>, tx: SyncSender<FromWorker>, request_id: String) -> Self {
        Self {
            rx,
            tx,
            request_id,
            current: Vec::new(),
            pos: 0,
            ended: false,
        }
    }
}

impl Read for ChannelBodyReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.pos < self.current.len() {
                let n = (self.current.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            if self.ended {
                return Ok(0);
            }
            match self.rx.recv() {
                Ok(BodyChunk { data, last }) => {
                    // Returning a credit frees the slot we just consumed so the
                    // server may send another body chunk within the window.
                    let ack = ClientControlMessage::RelayRequestBodyAck {
                        request_id: self.request_id.clone(),
                        credits: 1,
                    };
                    let text = encode_control(&ack).map_err(io::Error::other)?;
                    if self.tx.send(FromWorker::Send(WsFrame::Text(text))).is_err() {
                        return Err(io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            "relay outbound channel closed",
                        ));
                    }
                    self.current = data;
                    self.pos = 0;
                    self.ended = last;
                }
                Err(_) => {
                    // The sender was dropped before end-of-body: the request was
                    // aborted (websocket disconnect or cancellation). Surface an
                    // error so the upstream request is torn down.
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "relay request body aborted",
                    ));
                }
            }
        }
    }
}

/// Outcome of routing an inbound request-body frame to a worker.
enum BodyRoute {
    Delivered,
    /// The worker's body channel is gone (upstream finished/rejected early).
    WorkerGone,
    /// The server exceeded the granted flow-control window: protocol violation.
    OverCredit,
}

fn deliver_body_chunk(body_tx: &SyncSender<BodyChunk>, data: Vec<u8>, last: bool) -> BodyRoute {
    match body_tx.try_send(BodyChunk { data, last }) {
        Ok(()) => BodyRoute::Delivered,
        Err(TrySendError::Full(_)) => BodyRoute::OverCredit,
        Err(TrySendError::Disconnected(_)) => BodyRoute::WorkerGone,
    }
}

enum RelaySessionError {
    Reconnectable {
        error: anyhow::Error,
        reset_backoff: bool,
    },
    Fatal(anyhow::Error),
}

type RelaySessionResult<T> = std::result::Result<T, RelaySessionError>;

pub fn ensure_cli_slug(config: &mut Config) -> Result<String> {
    if let Some(slug) = &config.cli_slug {
        crate::slug::validate_slug(slug)?;
        return Ok(slug.clone());
    }
    let slug = generated_slug("cli");
    config.cli_slug = Some(slug.clone());
    config.save()?;
    Ok(slug)
}

pub fn connect_foreground() -> Result<()> {
    let mut config = Config::load_required()?;
    config.validate()?;
    let cli_slug = ensure_cli_slug(&mut config)?;
    let credential = resolve_credential(&config)?;
    let secret = match credential {
        crate::auth::ResolvedCredential::CliToken { secret, .. } => secret,
        crate::auth::ResolvedCredential::Device { secret } => secret,
    };
    let server_url = config
        .server_url
        .clone()
        .context("server URL is not configured; run `wsmp config set-server <URL>`")?;
    let ws_url = websocket_url(&server_url)?;
    let auth_value = HeaderValue::from_str(&format!("Bearer {secret}"))
        .context("building websocket authorization header")?;

    let mut reconnect_delay = RELAY_RECONNECT_INITIAL_DELAY;
    loop {
        tracing::info!(url = %ws_url, "connecting relay websocket");
        match run_relay_session(&mut config, &cli_slug, &ws_url, auth_value.clone()) {
            Ok(()) => {
                tracing::warn!(
                    retry_delay_secs = reconnect_delay.as_secs(),
                    "relay websocket session ended; reconnecting after backoff"
                );
            }
            Err(RelaySessionError::Reconnectable {
                error,
                reset_backoff,
            }) => {
                if reset_backoff {
                    reconnect_delay = RELAY_RECONNECT_INITIAL_DELAY;
                }
                tracing::warn!(
                    error = %error,
                    retry_delay_secs = reconnect_delay.as_secs(),
                    "relay websocket disconnected; reconnecting after backoff"
                );
            }
            Err(RelaySessionError::Fatal(error)) => return Err(error),
        }
        thread::sleep(reconnect_delay);
        reconnect_delay = next_reconnect_delay(reconnect_delay);
    }
}

fn run_relay_session(
    config: &mut Config,
    cli_slug: &str,
    ws_url: &Url,
    auth_value: HeaderValue,
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
    let (mut socket, response) =
        connect(request).map_err(|error| RelaySessionError::Reconnectable {
            error: anyhow::Error::new(error).context("opening relay websocket"),
            reset_backoff: false,
        })?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        != Some(RELAY_SUBPROTOCOL)
    {
        return Err(RelaySessionError::Fatal(anyhow::anyhow!(
            "server did not accept relay websocket subprotocol `{RELAY_SUBPROTOCOL}`"
        )));
    }
    set_socket_read_timeout(socket.get_mut(), RELAY_SOCKET_POLL_INTERVAL);

    let endpoints = inventory_from_config(config);
    let hello = ClientControlMessage::Hello {
        id: next_id("hello"),
        protocol_version: RELAY_PROTOCOL_VERSION.to_string(),
        cli: CliInventory {
            slug: cli_slug.to_string(),
            label: config
                .cli_label
                .clone()
                .unwrap_or_else(|| "CLI device".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            capabilities: CliCapabilities::default(),
        },
        endpoints,
    };
    let hello = encode_control(&hello).map_err(RelaySessionError::Fatal)?;
    socket
        .send(Message::Text(hello.into()))
        .map_err(|error| websocket_session_error(error, "sending relay hello", false))?;

    let (worker_tx, worker_rx) = mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
    let mut workers = BTreeMap::<String, WorkerHandle>::new();
    let mut recent_finished = RecentlyFinished::new();

    let mut next_heartbeat =
        Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
    let result = loop {
        if let Err(error) =
            drain_worker_output(&mut socket, &worker_rx, &mut workers, &mut recent_finished)
        {
            break Err(error);
        }

        if Instant::now() >= next_heartbeat {
            let heartbeat = ClientControlMessage::Heartbeat {
                id: next_id("heartbeat"),
                sent_at: None,
            };
            if let Err(error) = send_control(&mut socket, &heartbeat, "sending relay heartbeat") {
                break Err(error);
            }
            next_heartbeat =
                Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
        }

        let outcome = match socket.read() {
            Ok(Message::Text(text)) => handle_text(
                &mut socket,
                config,
                &text,
                &worker_tx,
                &mut workers,
                &mut recent_finished,
            ),
            Ok(Message::Binary(bytes)) => {
                handle_binary(&mut socket, &bytes, &mut workers, &mut recent_finished)
            }
            Ok(Message::Close(frame)) => {
                tracing::warn!(?frame, "relay websocket closed by server");
                Err(RelaySessionError::Reconnectable {
                    error: anyhow::anyhow!("relay websocket closed by server"),
                    reset_backoff: true,
                })
            }
            Ok(Message::Ping(bytes)) => socket
                .send(Message::Pong(bytes))
                .map_err(|error| websocket_session_error(error, "sending relay pong", true)),
            Ok(Message::Pong(_)) => Ok(()),
            Ok(Message::Frame(_)) => Ok(()),
            Err(tungstenite::Error::Io(err))
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                Ok(())
            }
            Err(err) => Err(websocket_session_error(
                err,
                "reading relay websocket",
                true,
            )),
        };
        if let Err(error) = outcome {
            break Err(error);
        }
    };

    abort_all_workers(workers);
    result
}

/// Mark every in-flight worker cancelled and drop their handles. Dropping each
/// body sender aborts any streaming request body; response streaming loops
/// observe the cancelled flag or fail to send and exit on their own. We do not
/// join here so a slow upstream cannot delay reconnection.
fn abort_all_workers(workers: BTreeMap<String, WorkerHandle>) {
    for (_, worker) in workers {
        worker.cancelled.store(true, Ordering::SeqCst);
        drop(worker.body_tx);
        // Detach: the thread exits once its upstream call unwinds.
        drop(worker.join);
    }
}

fn drain_worker_output<S>(
    socket: &mut tungstenite::WebSocket<S>,
    worker_rx: &Receiver<FromWorker>,
    workers: &mut BTreeMap<String, WorkerHandle>,
    recent_finished: &mut RecentlyFinished,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    loop {
        match worker_rx.try_recv() {
            Ok(FromWorker::Send(WsFrame::Text(text))) => socket
                .send(Message::Text(text.into()))
                .map_err(|error| websocket_session_error(error, "sending relay frame", true))?,
            Ok(FromWorker::Send(WsFrame::Binary(bytes))) => socket
                .send(Message::Binary(bytes.into()))
                .map_err(|error| websocket_session_error(error, "sending relay frame", true))?,
            Ok(FromWorker::Finished(request_id)) => {
                // Remember the id so late body chunks the server is still
                // flushing get dropped silently instead of faulted as
                // "before request metadata".
                recent_finished.record(&request_id);
                if let Some(worker) = workers.remove(&request_id) {
                    let _ = worker.join.join();
                }
            }
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

fn handle_text<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    text: &str,
    worker_tx: &SyncSender<FromWorker>,
    workers: &mut BTreeMap<String, WorkerHandle>,
    recent_finished: &mut RecentlyFinished,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let message = parse_server_control(text).map_err(RelaySessionError::Fatal)?;
    match message {
        ServerControlMessage::HelloOk { id, .. } => {
            tracing::info!(id, "relay registration accepted");
        }
        ServerControlMessage::HeartbeatPong { id, .. } => {
            tracing::debug!(id, "relay heartbeat acknowledged");
        }
        ServerControlMessage::ProtocolError { message, .. } => {
            return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                "relay protocol error: {message}"
            )));
        }
        ServerControlMessage::RelayCancel { request_id, reason } => {
            tracing::warn!(request_id, ?reason, "relay request cancelled");
            // Cancelled request: any body chunks still in flight are late, not
            // premature — drop them silently rather than faulting them.
            recent_finished.record(&request_id);
            if let Some(worker) = workers.remove(&request_id) {
                worker.cancelled.store(true, Ordering::SeqCst);
                drop(worker.body_tx);
                drop(worker.join);
            }
            let cancelled = ClientControlMessage::RelayCancelled { request_id };
            send_control(
                socket,
                &cancelled,
                "sending relay cancellation acknowledgement",
            )?;
        }
        ServerControlMessage::RelayRequest {
            request_id,
            method,
            path,
            headers,
            timeout_ms,
            expect_body,
            ..
        } => {
            start_relay_request(
                socket,
                config,
                worker_tx,
                workers,
                recent_finished,
                request_id,
                method,
                path,
                headers,
                timeout_ms,
                expect_body,
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn start_relay_request<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    worker_tx: &SyncSender<FromWorker>,
    workers: &mut BTreeMap<String, WorkerHandle>,
    recent_finished: &RecentlyFinished,
    request_id: String,
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    timeout_ms: u64,
    expect_body: bool,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    // Reject a `relay.request` whose id is already live or was recently seen. The
    // server assigns globally-unique request ids and rejects its own duplicates,
    // so any reuse is a protocol violation. Spawning a second worker for a live id
    // would corrupt the routing maps (the `workers` insert below would orphan the
    // first worker's handle); a ring hit means the server is reusing a just-
    // finished id, which it never legitimately does. Fault both without spawning.
    if workers.contains_key(&request_id) || recent_finished.contains(&request_id) {
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::ProtocolError,
            Some("request id is already in use".to_string()),
            None,
        )?;
        return Ok(());
    }

    let Some(endpoint) = config.endpoints.iter().find(|endpoint| endpoint.enabled) else {
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::NotFound,
            Some("no enabled endpoints are configured".to_string()),
            None,
        )?;
        return Ok(());
    };

    let spec = UpstreamRequestSpec {
        request_id: request_id.clone(),
        method,
        base_url: endpoint.base_url.clone(),
        path,
        request_headers: headers,
        endpoint_headers: endpoint
            .headers
            .iter()
            .map(|header| (header.name.clone(), header.env.clone()))
            .collect(),
        timeout_ms,
        has_body: expect_body,
        expand_media: endpoint.expand_media,
        trusted_origins: TrustedOrigins::new(
            config.server_url.as_deref(),
            &config.media_trusted_origins,
        ),
    };

    let cancelled = Arc::new(AtomicBool::new(false));
    let thread_tx = worker_tx.clone();
    let thread_cancelled = Arc::clone(&cancelled);

    let (body_tx, body_rx) = if expect_body {
        // Invariant (flow-control window): the body channel capacity equals the
        // credit window, so at most `RELAY_REQUEST_BODY_WINDOW_CHUNKS` sent-unacked
        // chunks can be buffered for one request. The worker acks (returns one
        // credit) only as it consumes each chunk, so outstanding chunks never
        // exceed the window even if the server sends acks it should not have —
        // `deliver_body_chunk`'s `try_send` faults an over-window chunk as an
        // `OverCredit` protocol violation rather than growing memory unbounded.
        let (tx, rx) = mpsc::sync_channel::<BodyChunk>(RELAY_REQUEST_BODY_WINDOW_CHUNKS);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };

    let handle = thread::spawn(move || {
        run_upstream_worker(spec, body_rx, thread_tx, thread_cancelled);
    });

    workers.insert(
        request_id,
        WorkerHandle {
            body_tx,
            cancelled,
            join: handle,
        },
    );
    Ok(())
}

fn handle_binary<S>(
    socket: &mut tungstenite::WebSocket<S>,
    bytes: &[u8],
    workers: &mut BTreeMap<String, WorkerHandle>,
    recent_finished: &mut RecentlyFinished,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let (metadata, body) = parse_binary_frame(bytes).map_err(RelaySessionError::Fatal)?;
    if metadata.r#type != RelayBinaryFrameType::RequestBody {
        return Err(RelaySessionError::Fatal(anyhow::anyhow!(
            "unexpected relay binary frame type"
        )));
    }

    let last = metadata.final_chunk == Some(true);
    let request_id = metadata.request_id.clone();

    let Some(worker) = workers.get(&request_id) else {
        // The worker is gone. Distinguish "already finished" (a fast upstream
        // responded and was reaped before the server flushed the body tail)
        // from a genuinely unknown id: the former is expected and dropped
        // silently, only the latter is a protocol violation.
        if recent_finished.contains(&request_id) {
            tracing::debug!(
                request_id = request_id,
                "dropping late relay body chunk for an already-finished request"
            );
            return Ok(());
        }
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::ProtocolError,
            Some("request body chunk arrived before request metadata".to_string()),
            None,
        )?;
        return Ok(());
    };
    let Some(body_tx) = worker.body_tx.as_ref() else {
        // Body frame for a request that declared no body.
        if let Some(worker) = workers.remove(&request_id) {
            worker.cancelled.store(true, Ordering::SeqCst);
        }
        recent_finished.record(&request_id);
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::ProtocolError,
            Some("unexpected request body chunk for a body-less request".to_string()),
            None,
        )?;
        return Ok(());
    };

    tracing::debug!(
        request_id = request_id,
        bytes = body.len(),
        "received relay request body chunk"
    );

    match deliver_body_chunk(body_tx, body, last) {
        BodyRoute::Delivered => Ok(()),
        BodyRoute::WorkerGone => {
            // Upstream already finished or rejected the request early; drop
            // further body frames. The worker reports the terminal outcome.
            Ok(())
        }
        BodyRoute::OverCredit => {
            if let Some(worker) = workers.remove(&request_id) {
                worker.cancelled.store(true, Ordering::SeqCst);
                drop(worker.body_tx);
            }
            recent_finished.record(&request_id);
            send_relay_error(
                socket,
                &request_id,
                RelayFailure::ProtocolError,
                Some("request body exceeded the granted flow-control window".to_string()),
                None,
            )?;
            Ok(())
        }
    }
}

/// Run one upstream request on a worker thread: stream the request body (if any)
/// to the endpoint and stream the response back as relay frames.
fn run_upstream_worker(
    spec: UpstreamRequestSpec,
    body_rx: Option<Receiver<BodyChunk>>,
    tx: SyncSender<FromWorker>,
    cancelled: Arc<AtomicBool>,
) {
    let request_id = spec.request_id.clone();
    let result = execute_upstream(spec, body_rx, &tx, &cancelled);
    if !cancelled.load(Ordering::SeqCst) {
        if let Err(error) = result {
            tracing::warn!(error = %error, "relay upstream request failed");
            let _ = worker_send_control(
                &tx,
                &ClientControlMessage::RelayError {
                    request_id: request_id.clone(),
                    failure: RelayFailure::Transport,
                    message: Some("upstream request failed".to_string()),
                    upstream_status_code: None,
                },
            );
        }
    }
    let _ = tx.send(FromWorker::Finished(request_id));
}

fn execute_upstream(
    spec: UpstreamRequestSpec,
    body_rx: Option<Receiver<BodyChunk>>,
    tx: &SyncSender<FromWorker>,
    cancelled: &Arc<AtomicBool>,
) -> Result<()> {
    let url = endpoint_url(&spec.base_url, &spec.path)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(spec.timeout_ms)))
        .http_status_as_error(false)
        .build()
        .into();

    let mut builder = ureq::http::Request::builder()
        .method(spec.method.as_str())
        .uri(url.as_str());
    for (name, value) in &spec.request_headers {
        // When streaming a body, let the HTTP client frame it (chunked). Drop any
        // caller-provided framing headers to avoid a content-length mismatch.
        if spec.has_body && (name == "content-length" || name == "transfer-encoding") {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_str());
    }
    for (name, env) in &spec.endpoint_headers {
        let value = std::env::var(env)
            .with_context(|| format!("reading endpoint header `{name}` from `{env}`"))?;
        builder = builder.header(name.as_str(), value.as_str());
    }

    // Media expansion only applies to chat-shaped JSON bodies on an opted-in
    // endpoint. Every other shape (non-JSON, body-less) stays on the streaming
    // relay path untouched.
    let expand = spec.expand_media && spec.has_body && is_json_content_type(&spec.request_headers);

    let response = if expand {
        let rx = body_rx.context("missing request body channel for a body request")?;
        // Buffer the whole body, returning one flow-control credit per consumed
        // chunk so the server keeps sending within its window exactly as the
        // streaming reader would.
        let raw = match collect_request_body(&rx, tx, &spec.request_id, MEDIA_EXPAND_MAX_BODY_BYTES)
        {
            Ok(raw) => raw,
            // The websocket disconnected or the request was cancelled mid-body.
            Err(CollectError::Aborted) => return Ok(()),
            Err(CollectError::TooLarge) => {
                send_media_error(tx, &spec.request_id, &MediaExpandError::InputTooLarge)?;
                return Ok(());
            }
        };
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        let media_agent = build_media_fetch_agent();
        let transformed = match expand_media_in_body(
            &raw,
            &spec.trusted_origins,
            &|target| fetch_media(&media_agent, target),
            MEDIA_EXPAND_MAX_BODY_BYTES,
        ) {
            Ok(bytes) => bytes,
            Err(error) => {
                send_media_error(tx, &spec.request_id, &error)?;
                return Ok(());
            }
        };
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        // Sized body: ureq sets Content-Length from the Vec; the caller's framing
        // headers were already dropped above.
        let request = builder
            .body(transformed)
            .context("building relay request to upstream endpoint")?;
        agent.run(request)
    } else if spec.has_body {
        let rx = body_rx.context("missing request body channel for a body request")?;
        let reader = ChannelBodyReader::new(rx, tx.clone(), spec.request_id.clone());
        let request = builder
            .body(SendBody::from_owned_reader(reader))
            .context("building relay request to upstream endpoint")?;
        agent.run(request)
    } else {
        let request = builder
            .body(())
            .context("building relay request to upstream endpoint")?;
        agent.run(request)
    }
    .context("forwarding relay request to upstream endpoint")?;

    if cancelled.load(Ordering::SeqCst) {
        return Ok(());
    }

    relay_response_back(response, &spec, tx, cancelled)
}

/// Stream an upstream HTTP response back to the server as relay frames.
fn relay_response_back(
    response: ureq::http::Response<ureq::Body>,
    spec: &UpstreamRequestSpec,
    tx: &SyncSender<FromWorker>,
    cancelled: &Arc<AtomicBool>,
) -> Result<()> {
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    worker_send_control(
        tx,
        &ClientControlMessage::RelayResponseHeaders {
            request_id: spec.request_id.clone(),
            status,
            headers,
        },
    )?;

    let mut reader = response.into_body().into_reader();
    let mut chunk = vec![0_u8; RELAY_BINARY_CHUNK_MAX_BYTES];
    let mut index = 0_usize;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        let read = reader
            .read(&mut chunk)
            .context("reading upstream response body")?;
        if read == 0 {
            break;
        }
        let metadata = RelayBinaryFrameMetadata {
            r#type: RelayBinaryFrameType::ResponseBody,
            request_id: spec.request_id.clone(),
            chunk_id: index.to_string(),
            final_chunk: None,
        };
        worker_send_binary(tx, &metadata, &chunk[..read])?;
        index += 1;
    }
    let metadata = RelayBinaryFrameMetadata {
        r#type: RelayBinaryFrameType::ResponseBody,
        request_id: spec.request_id.clone(),
        chunk_id: index.to_string(),
        final_chunk: Some(true),
    };
    worker_send_binary(tx, &metadata, &[])?;
    worker_send_control(
        tx,
        &ClientControlMessage::RelayComplete {
            request_id: spec.request_id.clone(),
        },
    )?;
    Ok(())
}

/// True when the request declares a JSON content type (media expansion only
/// touches chat-completions-shaped JSON bodies).
fn is_json_content_type(headers: &BTreeMap<String, String>) -> bool {
    headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .unwrap_or(value)
            .trim()
            .eq_ignore_ascii_case("application/json")
    })
}

/// Outcome of buffering a relay request body for media expansion.
#[derive(Debug)]
enum CollectError {
    /// End-of-body never arrived (disconnect or cancellation).
    Aborted,
    /// The buffered body exceeded the cap.
    TooLarge,
}

/// Drain the streamed request body into memory, returning one flow-control
/// credit to the server per consumed chunk so buffered mode keeps the same
/// credit accounting as the streaming reader.
fn collect_request_body(
    rx: &Receiver<BodyChunk>,
    tx: &SyncSender<FromWorker>,
    request_id: &str,
    max_bytes: usize,
) -> std::result::Result<Vec<u8>, CollectError> {
    let mut buffer = Vec::new();
    loop {
        match rx.recv() {
            Ok(BodyChunk { data, last }) => {
                if !send_body_credit(tx, request_id) {
                    return Err(CollectError::Aborted);
                }
                if buffer.len().saturating_add(data.len()) > max_bytes {
                    return Err(CollectError::TooLarge);
                }
                buffer.extend_from_slice(&data);
                if last {
                    return Ok(buffer);
                }
            }
            Err(_) => return Err(CollectError::Aborted),
        }
    }
}

/// Return one request-body flow-control credit to the server. Returns false when
/// the outbound channel is gone.
fn send_body_credit(tx: &SyncSender<FromWorker>, request_id: &str) -> bool {
    let ack = ClientControlMessage::RelayRequestBodyAck {
        request_id: request_id.to_string(),
        credits: 1,
    };
    match encode_control(&ack) {
        Ok(text) => tx.send(FromWorker::Send(WsFrame::Text(text))).is_ok(),
        Err(_) => false,
    }
}

/// Report a media-expansion failure as an OpenAI-shaped relay error, mirroring
/// how upstream connect failures are surfaced. Never echoes the `sig` query.
fn send_media_error(
    tx: &SyncSender<FromWorker>,
    request_id: &str,
    error: &MediaExpandError,
) -> Result<()> {
    let upstream_status_code = match error {
        MediaExpandError::Status { status, .. } => Some(*status),
        _ => None,
    };
    worker_send_control(
        tx,
        &ClientControlMessage::RelayError {
            request_id: request_id.to_string(),
            failure: error.relay_failure(),
            message: Some(error.message()),
            upstream_status_code,
        },
    )
}

/// Build the dedicated agent used to fetch WMP media URLs during expansion.
///
/// Follows NO redirects: the trusted-origin check happens before the fetch, so a
/// trusted (or compromised) WMP server must not be able to 30x-redirect the CLI
/// to an arbitrary internal URL after the check (SSRF via redirect hop). With
/// `max_redirects` at 0 ureq returns the 3xx response as-is (it does not error),
/// so `fetch_media` surfaces it as a `Status` failure naming the code — never
/// following the `Location` header.
fn build_media_fetch_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(RELAY_MEDIA_FETCH_TIMEOUT))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

/// Fetch a single WMP media URL. Reads at most `MEDIA_EXPAND_MAX_ASSET_BYTES`
/// (a tighter per-asset cap than the whole-body ceiling so one asset cannot eat
/// the entire budget) and reports failures with the URL path only (never the
/// signature). The agent follows no redirects (see the media-fetch agent config).
fn fetch_media(
    agent: &ureq::Agent,
    url: &Url,
) -> std::result::Result<FetchedMedia, MediaExpandError> {
    let path = url.path().to_string();
    let response = agent
        .get(url.as_str())
        .call()
        .map_err(|error| MediaExpandError::Fetch {
            path: path.clone(),
            reason: media_fetch_reason(&error),
        })?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(MediaExpandError::Status { path, status });
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let cap = MEDIA_EXPAND_MAX_ASSET_BYTES as u64;
    let mut reader = response.into_body().into_reader().take(cap + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| MediaExpandError::Fetch {
            path: path.clone(),
            reason: format!("reading response body failed: {}", error.kind()),
        })?;
    if bytes.len() as u64 > cap {
        return Err(MediaExpandError::AssetTooLarge { path });
    }
    Ok(FetchedMedia {
        content_type,
        bytes,
    })
}

/// A concise failure reason for a media fetch that never includes the request
/// URI (and therefore never the `sig` query parameter).
fn media_fetch_reason(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Timeout(_) => "request timed out".to_string(),
        ureq::Error::HostNotFound => "host not found".to_string(),
        ureq::Error::ConnectionFailed => "connection failed".to_string(),
        ureq::Error::Io(err) => format!("io error: {}", err.kind()),
        ureq::Error::Tls(reason) => format!("tls error: {reason}"),
        ureq::Error::Protocol(_) => "http protocol error".to_string(),
        _ => "request failed".to_string(),
    }
}

fn worker_send_control(tx: &SyncSender<FromWorker>, message: &ClientControlMessage) -> Result<()> {
    let text = encode_control(message)?;
    tx.send(FromWorker::Send(WsFrame::Text(text)))
        .map_err(|_| anyhow::anyhow!("relay outbound channel closed"))
}

fn worker_send_binary(
    tx: &SyncSender<FromWorker>,
    metadata: &RelayBinaryFrameMetadata,
    body: &[u8],
) -> Result<()> {
    let frame = encode_binary_frame(metadata, body)?;
    tx.send(FromWorker::Send(WsFrame::Binary(frame)))
        .map_err(|_| anyhow::anyhow!("relay outbound channel closed"))
}

fn send_relay_error<S>(
    socket: &mut tungstenite::WebSocket<S>,
    request_id: &str,
    failure: RelayFailure,
    message: Option<String>,
    upstream_status_code: Option<u16>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    send_control(
        socket,
        &ClientControlMessage::RelayError {
            request_id: request_id.to_string(),
            failure,
            message,
            upstream_status_code,
        },
        "sending relay error",
    )?;
    Ok(())
}

fn send_control<S>(
    socket: &mut tungstenite::WebSocket<S>,
    message: &ClientControlMessage,
    context: &'static str,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let text = encode_control(message).map_err(RelaySessionError::Fatal)?;
    socket
        .send(Message::Text(text.into()))
        .map_err(|error| websocket_session_error(error, context, true))
}

fn websocket_session_error(
    error: tungstenite::Error,
    context: &'static str,
    reset_backoff: bool,
) -> RelaySessionError {
    match error {
        error @ (tungstenite::Error::ConnectionClosed
        | tungstenite::Error::AlreadyClosed
        | tungstenite::Error::Io(_)
        | tungstenite::Error::Tls(_)) => RelaySessionError::Reconnectable {
            error: anyhow::Error::new(error).context(context),
            reset_backoff,
        },
        error => RelaySessionError::Fatal(anyhow::Error::new(error).context(context)),
    }
}

fn next_reconnect_delay(current: Duration) -> Duration {
    current
        .checked_mul(2)
        .unwrap_or(RELAY_RECONNECT_MAX_DELAY)
        .min(RELAY_RECONNECT_MAX_DELAY)
}

fn inventory_from_config(config: &mut Config) -> Vec<EndpointInventory> {
    let reports = config
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.enabled)
        .map(probe_endpoint)
        .collect::<Vec<_>>();
    for report in reports {
        if let Err(error) = apply_probe_report(config, &report) {
            tracing::warn!(error = %error, endpoint = report.endpoint_slug, "failed to apply probe report");
        }
    }
    if let Err(error) = config.save() {
        tracing::warn!(error = %error, "failed to persist probe inventory");
    }
    config
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.enabled)
        .map(|endpoint| {
            let status = match endpoint.last_probe.as_ref().map(|probe| &probe.status) {
                Some(crate::config::ProbeStatus::Online) => EndpointStatus::Online,
                Some(crate::config::ProbeStatus::Offline) => EndpointStatus::Offline,
                None => EndpointStatus::Unknown,
            };
            endpoint_inventory(endpoint, status)
        })
        .collect()
}

fn set_socket_read_timeout(
    stream: &mut tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
    timeout: Duration,
) {
    let tcp = match stream {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => Some(stream),
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => Some(&mut stream.sock),
        _ => None,
    };
    if let Some(tcp) = tcp {
        if let Err(error) = tcp.set_read_timeout(Some(timeout)) {
            tracing::warn!(error = %error, "failed to set websocket read timeout");
        }
    }
}

fn websocket_url(server_url: &str) -> Result<Url> {
    let mut url = join(server_url, "/api/cli/ws")?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => anyhow::bail!("unsupported server URL scheme `{other}`"),
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("setting websocket URL scheme"))?;
    Ok(url)
}

fn endpoint_url(base_url: &str, request_path: &str) -> Result<Url> {
    let mut base =
        Url::parse(base_url).with_context(|| format!("parsing endpoint URL `{base_url}`"))?;
    if !base.path().ends_with('/') {
        let next = format!("{}/", base.path());
        base.set_path(&next);
    }
    base.join(request_path.trim_start_matches('/'))
        .with_context(|| format!("joining endpoint URL `{base_url}` with path `{request_path}`"))
}

fn next_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{prefix}-{millis}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain_acks(rx: &Receiver<FromWorker>) -> Vec<String> {
        let mut acks = Vec::new();
        while let Ok(FromWorker::Send(WsFrame::Text(text))) = rx.try_recv() {
            acks.push(text);
        }
        acks
    }

    #[test]
    fn collect_request_body_buffers_and_returns_a_credit_per_chunk() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: b"hello ".to_vec(),
                last: false,
            })
            .expect("send chunk");
        body_tx
            .send(BodyChunk {
                data: b"world".to_vec(),
                last: true,
            })
            .expect("send final chunk");

        let body =
            collect_request_body(&body_rx, &out_tx, "request-1", MEDIA_EXPAND_MAX_BODY_BYTES)
                .expect("collect");
        assert_eq!(body, b"hello world");

        // Buffered mode must return the same one-credit-per-chunk flow control as
        // the streaming reader so the server keeps sending within its window.
        let acks = drain_acks(&out_rx);
        assert_eq!(acks.len(), 2);
        for ack in acks {
            assert!(ack.contains(r#""type":"relay.request.body.ack""#));
            assert!(ack.contains(r#""requestId":"request-1""#));
            assert!(ack.contains(r#""credits":1"#));
        }
    }

    #[test]
    fn collect_request_body_enforces_the_cap() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: vec![0_u8; 8],
                last: false,
            })
            .expect("send chunk");
        body_tx
            .send(BodyChunk {
                data: vec![0_u8; 8],
                last: true,
            })
            .expect("send final chunk");

        let result = collect_request_body(&body_rx, &out_tx, "request-1", 10);
        assert!(matches!(result, Err(CollectError::TooLarge)));
        // The first (in-window) chunk was still acked before the cap tripped.
        assert_eq!(drain_acks(&out_rx).len(), 2);
    }

    #[test]
    fn collect_request_body_aborts_when_sender_dropped_before_end() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, _out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: b"partial".to_vec(),
                last: false,
            })
            .expect("send chunk");
        drop(body_tx);

        let result =
            collect_request_body(&body_rx, &out_tx, "request-1", MEDIA_EXPAND_MAX_BODY_BYTES);
        assert!(matches!(result, Err(CollectError::Aborted)));
    }

    #[test]
    fn is_json_content_type_matches_json_with_parameters() {
        let mut headers = BTreeMap::new();
        assert!(!is_json_content_type(&headers));
        headers.insert("content-type".to_string(), "text/plain".to_string());
        assert!(!is_json_content_type(&headers));
        headers.insert(
            "content-type".to_string(),
            "application/json; charset=utf-8".to_string(),
        );
        assert!(is_json_content_type(&headers));
    }

    #[test]
    fn channel_body_reader_forwards_chunks_in_order_and_ends() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: b"hello ".to_vec(),
                last: false,
            })
            .expect("send chunk");
        body_tx
            .send(BodyChunk {
                data: b"world".to_vec(),
                last: true,
            })
            .expect("send final chunk");

        let mut reader = ChannelBodyReader::new(body_rx, out_tx, "request-1".to_string());
        let mut collected = Vec::new();
        reader.read_to_end(&mut collected).expect("read body");

        assert_eq!(collected, b"hello world");

        // One flow-control credit per consumed chunk.
        let acks = drain_acks(&out_rx);
        assert_eq!(acks.len(), 2);
        for ack in acks {
            assert!(ack.contains(r#""type":"relay.request.body.ack""#));
            assert!(ack.contains(r#""requestId":"request-1""#));
            assert!(ack.contains(r#""credits":1"#));
        }
    }

    #[test]
    fn channel_body_reader_aborts_when_sender_dropped_before_end() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, _out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: b"partial".to_vec(),
                last: false,
            })
            .expect("send chunk");
        drop(body_tx);

        let mut reader = ChannelBodyReader::new(body_rx, out_tx, "request-1".to_string());
        let mut buf = [0_u8; 32];
        let first = reader.read(&mut buf).expect("first read");
        assert_eq!(&buf[..first], b"partial");
        let aborted = reader.read(&mut buf);
        assert!(aborted.is_err());
        assert_eq!(
            aborted.expect_err("expected abort error").kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    #[test]
    fn deliver_body_chunk_reports_over_credit_when_window_is_full() {
        let (body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(1);
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![1], false),
            BodyRoute::Delivered
        ));
        // Second chunk exceeds the one-slot window before the receiver drains.
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![2], false),
            BodyRoute::OverCredit
        ));
        drop(body_rx);
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![3], true),
            BodyRoute::WorkerGone
        ));
    }

    #[test]
    fn recently_finished_remembers_ids_and_dedups_records() {
        let mut recent = RecentlyFinished::new();
        assert!(!recent.contains("req-1"));

        recent.record("req-1");
        recent.record("req-1"); // idempotent: recording twice keeps one slot
        assert!(recent.contains("req-1"));
        assert_eq!(recent.order.len(), 1);
        assert_eq!(recent.ids.len(), 1);
    }

    #[test]
    fn recently_finished_evicts_oldest_beyond_capacity() {
        let mut recent = RecentlyFinished::new();
        // Fill exactly to capacity, then push one more.
        for i in 0..RECENT_FINISHED_CAPACITY {
            recent.record(&format!("req-{i}"));
        }
        assert!(recent.contains("req-0"));
        assert_eq!(recent.order.len(), RECENT_FINISHED_CAPACITY);

        recent.record("req-overflow");
        // Memory stays bounded and the oldest id was evicted.
        assert_eq!(recent.order.len(), RECENT_FINISHED_CAPACITY);
        assert_eq!(recent.ids.len(), RECENT_FINISHED_CAPACITY);
        assert!(!recent.contains("req-0"));
        assert!(recent.contains("req-1"));
        assert!(recent.contains("req-overflow"));
    }

    /// A write-only in-memory stream so a `tungstenite::WebSocket` can be driven
    /// in a unit test without a real socket. Reads report end-of-stream; writes
    /// accumulate the encoded frame bytes for assertions.
    struct SinkStream {
        written: Vec<u8>,
    }

    impl io::Read for SinkStream {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Ok(0)
        }
    }

    impl io::Write for SinkStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn sink_socket() -> tungstenite::WebSocket<SinkStream> {
        tungstenite::WebSocket::from_raw_socket(
            SinkStream {
                written: Vec::new(),
            },
            tungstenite::protocol::Role::Server,
            None,
        )
    }

    #[test]
    fn duplicate_request_id_in_workers_is_rejected_without_spawning() {
        // FIX 4: a `relay.request` reusing a live request id must be faulted, not
        // spawn a second worker (which would orphan the first worker's handle).
        let mut socket = sink_socket();
        let config = Config::default();
        let (worker_tx, _worker_rx) =
            mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
        let mut workers = BTreeMap::<String, WorkerHandle>::new();
        let recent_finished = RecentlyFinished::new();

        // Seed a live worker for "req-1".
        let cancelled = Arc::new(AtomicBool::new(false));
        let join = thread::spawn(|| {});
        workers.insert(
            "req-1".to_string(),
            WorkerHandle {
                body_tx: None,
                cancelled,
                join,
            },
        );

        let result = start_relay_request(
            &mut socket,
            &config,
            &worker_tx,
            &mut workers,
            &recent_finished,
            "req-1".to_string(),
            "POST".to_string(),
            "/v1/chat/completions".to_string(),
            BTreeMap::new(),
            1_000,
            false,
        );
        assert!(result.is_ok(), "start_relay_request should not error");

        // No second worker spawned: the map still holds exactly the seeded entry.
        assert_eq!(workers.len(), 1);
        // A protocol error frame was written back to the socket.
        let written = &socket.get_ref().written;
        assert!(!written.is_empty());
    }

    #[test]
    fn recently_finished_request_id_is_rejected_without_spawning() {
        // FIX 4: the server never reuses request ids, so a `relay.request` whose id
        // sits in the recently-finished ring is a protocol violation — reject it
        // rather than spawning a fresh worker.
        let mut socket = sink_socket();
        let config = Config::default();
        let (worker_tx, _worker_rx) =
            mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
        let mut workers = BTreeMap::<String, WorkerHandle>::new();
        let mut recent_finished = RecentlyFinished::new();
        recent_finished.record("req-done");

        let result = start_relay_request(
            &mut socket,
            &config,
            &worker_tx,
            &mut workers,
            &recent_finished,
            "req-done".to_string(),
            "POST".to_string(),
            "/v1/chat/completions".to_string(),
            BTreeMap::new(),
            1_000,
            false,
        );
        assert!(result.is_ok(), "start_relay_request should not error");

        assert!(workers.is_empty());
        assert!(!socket.get_ref().written.is_empty());
    }

    #[test]
    fn media_fetch_agent_forbids_redirects() {
        // FIX 1 (SSRF via redirect hop): the media fetcher must not follow any
        // redirect after the trusted-origin check. `max_redirects == 0` also means
        // ureq returns a 3xx as-is, so `fetch_media` reports it as a `Status`
        // failure rather than chasing the `Location`.
        let agent = build_media_fetch_agent();
        assert_eq!(agent.config().max_redirects(), 0);
    }

    #[test]
    fn websocket_url_uses_relay_path_and_scheme() {
        assert_eq!(
            websocket_url("https://example.test").expect("url").as_str(),
            "wss://example.test/api/cli/ws"
        );
    }

    #[test]
    fn reconnect_backoff_grows_exponentially() {
        assert_eq!(
            next_reconnect_delay(RELAY_RECONNECT_INITIAL_DELAY),
            Duration::from_secs(2)
        );
        assert_eq!(
            next_reconnect_delay(Duration::from_secs(2)),
            Duration::from_secs(4)
        );
    }

    #[test]
    fn reconnect_backoff_caps_at_five_minutes() {
        assert_eq!(
            next_reconnect_delay(Duration::from_secs(256)),
            RELAY_RECONNECT_MAX_DELAY
        );
        assert_eq!(RELAY_RECONNECT_MAX_DELAY, Duration::from_secs(300));
    }

    #[test]
    fn reconnect_backoff_stays_capped_without_overflow() {
        let mut delay = RELAY_RECONNECT_MAX_DELAY;
        for _ in 0..100 {
            delay = next_reconnect_delay(delay);
            assert_eq!(delay, RELAY_RECONNECT_MAX_DELAY);
        }
    }
}
