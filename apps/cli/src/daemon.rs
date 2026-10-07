//! Foreground websocket relay daemon (relay protocol 3.0).
//!
//! Request bodies are streamed to the upstream endpoint as they arrive over the
//! websocket instead of being fully buffered first. Each relayed request runs on
//! its own worker thread so a slow upstream cannot stall sibling requests
//! multiplexed on the shared socket. The single websocket writer stays on the
//! main loop: workers hand outbound frames back through a channel that the main
//! loop drains, and the server paces request-body frames with credit-based flow
//! control (`relay.request.body.ack`).
//!
//! Runtime handles resolve only through held definitions
//! (`crate::runtime_store`) and the node's instance records. Trust is the
//! node's own (`crate::trust`): lowered by `trust.lower`, `wsmp trust relay`
//! or a hand edit (hot reload), raised only by `wsmp trust full`.
//!
//! Not implemented yet: `runtime.detect` answers an empty scan.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::future::Future;
use std::io::{self};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures_core::Stream;
use tokio::sync::{mpsc as tokio_mpsc, watch};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::{Message, connect};
use url::Url;

use crate::auth::{join, resolve_credential};
use crate::config::{Config, ConfigLock, EndpointAuthMode};
use crate::control::ControlServer;
#[cfg(unix)]
use crate::control::{self, ControlCommand, ControlResponse};
use crate::media::{
    FetchedMedia, MEDIA_EXPAND_MAX_ASSET_BYTES, MEDIA_EXPAND_MAX_BODY_BYTES, MediaExpandError,
    TrustedOrigins, expand_media_in_body, trusted_media_urls_in_body,
};
#[cfg(test)]
use crate::protocol::decode_binary_frame;
use crate::protocol::frames::{
    CountMethod, HttpMethod, InstancePhase, InstanceRecord, JobError, JobPhase, JobStatus,
    RelayUsage, SecretRefusal, SecretStatus, TrustValue,
};
use crate::protocol::{
    FrameFault, NodeBinaryMetadata, NodeFrame, ProtocolErrorCode,
    RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS, RELAY_PROTOCOL_VERSION, RELAY_REQUEST_BODY_WINDOW_CHUNKS,
    RELAY_SUBPROTOCOL, RelayFailure, ServerBinaryMetadata, ServerFrame, binary_frame_fault,
    control_frame_fault, encode_binary_frame, encode_control, hello_rejection_message,
    parse_server_control,
};
use crate::relay_bus::{FromWorker, WsFrame};
use crate::runtime_store::{Defines, Store};
use crate::runtimes::endpoints::Target;
use crate::runtimes::executor::Job;
use crate::sessions::{
    DEFAULT_COMMAND_MAX, ExecRegistry, OutboundFrame, TermHandshake, TerminalRegistry,
};
use crate::slug::generated_slug;
use crate::startup::TerminalStartup;
use crate::stt_wire::SttServerMessage;
use crate::tokens::{CompletionTextCollector, standardized_completion_metrics};

const RELAY_RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(1);
const RELAY_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(300);
/// How long the main loop parks in `socket.read()` before waking to drain worker
/// output and send heartbeats. Bounds worker-frame latency (response streaming)
/// without busy-spinning.
const RELAY_SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// Bound on waiting for `hello.challenge`. An old server never sends it.
const HELLO_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounded capacity for the worker -> main-loop outbound frame channel. Provides
/// backpressure toward workers (and therefore upstream response reads) so a fast
/// upstream cannot grow unbounded memory ahead of the websocket writer.
const RELAY_WORKER_OUTBOUND_CAPACITY: usize = 64;
/// Per-request timeout for fetching a WMP media URL during media expansion.
/// Independent of the upstream request timeout so a slow asset fetch fails on its
/// own clock rather than silently eating the whole upstream budget.
const RELAY_MEDIA_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Keep enough of a streaming completion to parse a terminal OpenAI usage
/// event without retaining an unbounded generated response in the relay.
const RELAY_USAGE_TAIL_MAX_BYTES: usize = 256 * 1024;

/// How often the relay loop hands the live endpoint list to the telemetry thread.
const TELEMETRY_SYNC_INTERVAL: Duration = Duration::from_secs(5);
/// The async handoff owns one request chunk after a credit is returned. The
/// ingress queue must still accept the whole advertised window before the new
/// worker has had a chance to run.
const UPSTREAM_BODY_HANDOFF_CAPACITY: usize = 1;
const REQUEST_BODY_INGRESS_CAPACITY: usize = RELAY_REQUEST_BODY_WINDOW_CHUNKS;

// Request workers are synchronous threads, but their HTTP work is async. Keep
// one process-long runtime and connection pool instead of constructing a Tokio
// reactor and reqwest client for every relayed request.
static UPSTREAM_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static UPSTREAM_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn upstream_runtime() -> Result<&'static tokio::runtime::Runtime> {
    if let Some(runtime) = UPSTREAM_RUNTIME.get() {
        return Ok(runtime);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("creating shared cancellable upstream runtime")?;
    let _ = UPSTREAM_RUNTIME.set(runtime);
    UPSTREAM_RUNTIME
        .get()
        .context("initializing shared cancellable upstream runtime")
}

pub(crate) fn upstream_http_client() -> Result<&'static reqwest::Client> {
    if let Some(client) = UPSTREAM_HTTP_CLIENT.get() {
        return Ok(client);
    }
    crate::tls::install_crypto_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
        // Redirects are an execution boundary: replaying configured credentials
        // to a Location target (even same-origin) is not safe without validating
        // every hop. Native relay therefore exposes 3xx to the caller unchanged.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("building shared cancellable upstream client")?;
    let _ = UPSTREAM_HTTP_CLIENT.set(client);
    UPSTREAM_HTTP_CLIENT
        .get()
        .context("initializing shared cancellable upstream client")
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
    cancellation: CancellationHandle,
    join: JoinHandle<()>,
}

/// A cancellation request is idempotent and wakes the async HTTP operation.
/// Dropping its selected request/response future closes the upstream connection,
/// including while DNS/connect, upload, or an idle response read is pending.
#[derive(Clone)]
struct CancellationHandle {
    cancelled: Arc<AtomicBool>,
    notify: watch::Sender<bool>,
}

impl CancellationHandle {
    fn new() -> (Self, watch::Receiver<bool>) {
        let (notify, receiver) = watch::channel(false);
        (
            Self {
                cancelled: Arc::new(AtomicBool::new(false)),
                notify,
            },
            receiver,
        )
    }

    fn cancel(&self) -> bool {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return false;
        }
        let _ = self.notify.send(true);
        true
    }
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
            if self.order.len() > RECENT_FINISHED_CAPACITY
                && let Some(evicted) = self.order.pop_front()
            {
                self.ids.remove(&evicted);
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
    endpoint_auth: Option<(EndpointAuthMode, String)>,
    timeout_ms: u64,
    has_body: bool,
    /// The body length the server declared. A streamed body is sent with this
    /// Content-Length: strict OpenAI-compatible servers (TensorFold, gufo)
    /// answer a chunked request body with 400.
    body_bytes: Option<u64>,
    /// When set, buffer a chat-shaped JSON body and inline trusted media URLs as
    /// `data:` URLs before forwarding. Off for the plain streaming relay path.
    expand_media: bool,
    /// Origins whose `/media/{id}` URLs may be fetched during expansion.
    trusted_origins: TrustedOrigins,
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

/// A streamed body that fails if it yields more or fewer than `length` bytes,
/// so a declared Content-Length always frames exactly what is sent.
struct ExactLengthBody<S> {
    inner: S,
    length: u64,
    sent: u64,
    done: bool,
}

fn exact_length_body<S>(inner: S, length: u64) -> ExactLengthBody<S> {
    ExactLengthBody {
        inner,
        length,
        sent: 0,
        done: false,
    }
}

impl<S> Stream for ExactLengthBody<S>
where
    S: Stream<Item = std::result::Result<Vec<u8>, io::Error>> + Unpin,
{
    type Item = std::result::Result<Vec<u8>, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        if self.done {
            return Poll::Ready(None);
        }
        let mismatch =
            || io::Error::new(io::ErrorKind::InvalidData, "request body length mismatch");
        let item = match std::pin::Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(item) => item,
        };
        let result = match item {
            Some(Ok(chunk)) => {
                self.sent = self.sent.saturating_add(chunk.len() as u64);
                if self.sent > self.length {
                    Err(mismatch())
                } else {
                    return Poll::Ready(Some(Ok(chunk)));
                }
            }
            Some(Err(error)) => Err(error),
            None if self.sent != self.length => Err(mismatch()),
            None => {
                self.done = true;
                return Poll::Ready(None);
            }
        };
        self.done = true;
        Poll::Ready(Some(result))
    }
}

/// Bridge the websocket's synchronous, credit-limited request channel to the
/// async HTTP body. The bridge polls its cancellation receiver while waiting
/// for a body frame, so a cancelled upload cannot pin a worker on `recv()`.
fn streaming_request_body(
    rx: Receiver<BodyChunk>,
    tx: SyncSender<FromWorker>,
    request_id: String,
    cancellation_rx: watch::Receiver<bool>,
) -> impl Stream<Item = std::result::Result<Vec<u8>, io::Error>> + Send + 'static {
    let (body_tx, body_rx) = tokio_mpsc::channel(UPSTREAM_BODY_HANDOFF_CAPACITY);
    let clean_eof = Arc::new(AtomicBool::new(false));
    let bridge_clean_eof = Arc::clone(&clean_eof);
    thread::spawn(move || {
        loop {
            if *cancellation_rx.borrow() {
                return;
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(BodyChunk { data, last }) => {
                    // Return a protocol credit only after this chunk entered
                    // the async handoff. Acknowledging before `blocking_send`
                    // lets the server refill the websocket channel while the
                    // handoff is still full, exceeding the advertised window.
                    if body_tx.blocking_send(Ok(data)).is_err() {
                        return;
                    }
                    let ack = NodeFrame::RelayRequestBodyAck {
                        request_id: request_id.clone(),
                        credits: 1,
                    };
                    let Ok(text) = encode_control(&ack) else {
                        return;
                    };
                    if tx
                        .send(FromWorker::Send {
                            request_id: request_id.clone(),
                            frame: WsFrame::Text(text),
                        })
                        .is_err()
                    {
                        return;
                    }
                    if last {
                        bridge_clean_eof.store(true, Ordering::SeqCst);
                        return;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                // A sender disappearing before its final chunk is a truncated
                // upload, never a valid HTTP EOF. Let the body stream surface
                // a broken pipe instead of completing the upstream request.
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    TokioBodyStream {
        receiver: body_rx,
        clean_eof,
        terminated: false,
    }
}

struct TokioBodyStream {
    receiver: tokio_mpsc::Receiver<std::result::Result<Vec<u8>, io::Error>>,
    clean_eof: Arc<AtomicBool>,
    terminated: bool,
}

impl Stream for TokioBodyStream {
    type Item = std::result::Result<Vec<u8>, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        match self.receiver.poll_recv(cx) {
            std::task::Poll::Ready(None) if self.clean_eof.load(Ordering::SeqCst) => {
                std::task::Poll::Ready(None)
            }
            std::task::Poll::Ready(None) if !self.terminated => {
                self.terminated = true;
                std::task::Poll::Ready(Some(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "relay request body ended before final chunk",
                ))))
            }
            std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
            std::task::Poll::Ready(Some(item)) => std::task::Poll::Ready(Some(item)),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

enum RelaySessionError {
    Reconnectable {
        error: anyhow::Error,
        reset_backoff: bool,
    },
    Fatal(anyhow::Error),
    /// A shutdown signal arrived; the session has already cleaned up.
    Shutdown(i32),
}

type RelaySessionResult<T> = std::result::Result<T, RelaySessionError>;

pub fn ensure_cli_slug(config: &mut Config) -> Result<String> {
    if let Some(slug) = &config.cli_slug {
        crate::slug::validate_slug(slug)?;
        return Ok(slug.clone());
    }
    // The initial daemon bootstrap is also a read-modify-write. Re-read while
    // holding the transitional lock so a simultaneous login/config command
    // cannot have its generated device slug overwritten by this stale map.
    let _config_lock = ConfigLock::exclusive()?;
    let mut current = Config::load_required()?;
    if let Some(slug) = current.cli_slug.clone() {
        crate::slug::validate_slug(&slug)?;
        *config = current;
        return Ok(slug);
    }
    let slug = generated_slug("cli");
    current.cli_slug = Some(slug.clone());
    current.save()?;
    *config = current;
    Ok(slug)
}

/// Stop the relay after a shutdown signal. `main` maps this to the signal's
/// exit status.
fn check_shutdown() -> Result<()> {
    match crate::shutdown::requested() {
        Some(signal) => Err(crate::shutdown::ShutdownRequested { signal }.into()),
        None => Ok(()),
    }
}

pub fn connect_foreground() -> Result<()> {
    // First, so a stop that lands during startup still unwinds cleanly.
    crate::shutdown::install()?;
    let mut config = Config::load_required()?;
    config.validate()?;
    let mut control = ControlServer::bind()?;
    let startup = TerminalStartup::capture(&config)?;
    #[cfg(unix)]
    crate::file_ops::report_abandoned_recovery();
    let mut link =
        NodeLink::new(&crate::runtime_store::load_for(startup.trust_value()).unwrap_or_default());
    let mut reconnect_delay = RELAY_RECONNECT_INITIAL_DELAY;
    loop {
        check_shutdown()?;
        let node_slug = ensure_cli_slug(&mut config)?;
        let credential = match resolve_credential() {
            Ok(credential) => credential,
            // Definitely no credential: stop only where nothing restarts us in
            // a loop (see `stop_on_unusable_credential`).
            Err(error)
                if crate::auth::is_missing_credential(&error) && stop_on_unusable_credential() =>
            {
                return Err(error.context(crate::exit::CodedError::new(
                    crate::exit::ExitCode::CredentialRejected,
                )));
            }
            Err(error) => {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    retry_delay_secs = reconnect_delay.as_secs(),
                    "relay credential unavailable; retrying"
                );
                wait_for_reconnect(
                    &mut control,
                    &startup,
                    &node_slug,
                    reconnect_delay,
                    &mut link,
                )?;
                reconnect_delay = next_reconnect_delay(reconnect_delay);
                continue;
            }
        };
        let secret = credential;
        let server_url = config
            .server_url
            .clone()
            .context("this node is not enrolled; run `wsmp login <url> --code <code>`")?;
        let ws_url = websocket_url(&server_url)?;
        let auth_value = HeaderValue::from_str(&format!("Bearer {secret}"))
            .context("building websocket authorization header")?;

        tracing::info!(url = %ws_url, "connecting relay websocket");
        match run_relay_session(
            &config,
            &startup,
            &node_slug,
            &ws_url,
            auth_value,
            &mut control,
            &mut link,
        ) {
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
            Err(RelaySessionError::Shutdown(signal)) => {
                tracing::info!(signal, "relay stopped cleanly after a shutdown signal");
                return Err(crate::shutdown::ShutdownRequested { signal }.into());
            }
        }
        wait_for_reconnect(
            &mut control,
            &startup,
            &node_slug,
            reconnect_delay,
            &mut link,
        )?;
        // Endpoint edits apply on reconnect (hot reload lands with config v3).
        match Config::load_required().and_then(|fresh| fresh.validate().map(|()| fresh)) {
            Ok(fresh) => config = fresh,
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "re-reading the config failed; keeping the previous one"
            ),
        }
        reconnect_delay = next_reconnect_delay(reconnect_delay);
    }
}

/// What a control request or a hot reload changed, for the live session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeChange {
    /// Trust went down to Relay only (persisted and frozen already).
    Lowered,
    /// Trust went up to Full control (persisted and unfrozen already).
    Raised,
    /// Features changed (secrets, runtime hosts): report `node.state`.
    Features,
}

/// Lower to Relay only: freeze (today's set when coming from Full),
/// persist, latch. Whether it changed. The latch holds even when writing
/// fails.
fn apply_lower(startup: &TerminalStartup) -> Result<bool> {
    let persisted = if startup.full_control() {
        crate::trust::persist_lowering()
    } else {
        crate::trust::persist_relay()
    };
    let changed = startup.lower_trust();
    persisted.map(|()| changed)
}

/// Hot reload (every 2 s on a changed `config.json`, and on `Reload`):
/// runtime hosts follow the file; trust only ever goes down. A file that
/// says `full` while the node is Relay only is written back to `relay`.
fn reload_config(startup: &TerminalStartup) -> Result<Vec<NodeChange>> {
    let mut changes = vec![NodeChange::Features];
    // Trust first, from the raw file: a config that does not parse (a typo
    // anywhere) or lacks `trust: full` reads as Relay only.
    let file_trust = crate::trust::configured_on_disk();
    match Config::load_required() {
        Ok(config) => startup.set_runtime_hosts(config.runtime_hosts.clone()),
        Err(error) => tracing::warn!(
            error = %format!("{error:#}"),
            "config.json does not load; keeping the runtime hosts"
        ),
    }
    match (startup.trust_value(), file_trust) {
        (TrustValue::Full, TrustValue::Relay) => {
            // The effects apply even when saving fails (the latch holds).
            if let Err(error) = apply_lower(startup) {
                tracing::error!(
                    error = %format!("{error:#}"),
                    "persisting the lowered trust failed"
                );
            }
            tracing::warn!("config.json lowered this node to Relay only");
            changes.push(NodeChange::Lowered);
        }
        (TrustValue::Relay, TrustValue::Full) => {
            tracing::warn!(
                "config.json says `full`, but only `wsmp trust full` raises trust; keeping relay only"
            );
            crate::trust::persist_relay()?;
        }
        _ => {}
    }
    Ok(changes)
}

/// Polls `config.json` for edits (mtime, every 2 s).
struct ConfigWatch {
    seen: Option<SystemTime>,
    next: Instant,
}

impl ConfigWatch {
    fn new() -> Self {
        Self {
            seen: Self::mtime(),
            next: Instant::now() + CONFIG_POLL_INTERVAL,
        }
    }

    fn mtime() -> Option<SystemTime> {
        crate::paths::config_file()
            .ok()
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|meta| meta.modified().ok())
    }

    /// Whether the file changed since the last look.
    fn changed(&mut self) -> bool {
        if Instant::now() < self.next {
            return false;
        }
        self.next = Instant::now() + CONFIG_POLL_INTERVAL;
        let now = Self::mtime();
        let changed = now != self.seen;
        self.seen = now;
        changed
    }
}

const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(2);

#[cfg(unix)]
fn status_response<'a>(
    startup: &TerminalStartup,
    node_slug: &'a str,
    connection: &'a str,
) -> ControlResponse<'a> {
    ControlResponse {
        ok: true,
        state: "running",
        message: None,
        connection: Some(connection),
        node: Some(node_slug),
        trust: Some(crate::trust::word(startup.trust_value())),
    }
}

#[cfg(unix)]
fn simple_response(ok: bool, state: &str, message: Option<&str>) -> ControlResponse<'static> {
    let state: &'static str = match state {
        "changed" => "changed",
        "unchanged" => "unchanged",
        _ => "refused",
    };
    ControlResponse {
        ok,
        state,
        message: message.map(|text| -> &'static str {
            match text {
                "raise" => "a process wsmp started cannot raise trust",
                _ => "the relay could not apply the change; see its log",
            }
        }),
        connection: None,
        node: None,
        trust: None,
    }
}

/// Answer local control requests; returns what changed for the session.
#[cfg(unix)]
fn answer_control_requests(
    control: &mut ControlServer,
    startup: &TerminalStartup,
    node_slug: &str,
    connection: &str,
) -> Result<Vec<NodeChange>> {
    let mut changes = Vec::new();
    for pending in control.drain()? {
        match pending.request.command {
            ControlCommand::Status => {
                let _ = control::respond(pending, &status_response(startup, node_slug, connection));
            }
            ControlCommand::Reload => {
                let response = match reload_config(startup) {
                    Ok(found) => {
                        changes.extend(found);
                        simple_response(true, "changed", None)
                    }
                    Err(error) => {
                        tracing::warn!(error = %format!("{error:#}"), "reloading the config failed");
                        simple_response(false, "refused", Some("failed"))
                    }
                };
                let _ = control::respond(pending, &response);
            }
            ControlCommand::TrustRelay => {
                let was_full = startup.full_control();
                let lowered = apply_lower(startup);
                if was_full {
                    changes.push(NodeChange::Lowered);
                }
                let response = match lowered {
                    Ok(true) => {
                        tracing::warn!("`wsmp trust relay` lowered this node to Relay only");
                        simple_response(true, "changed", None)
                    }
                    Ok(false) => simple_response(true, "unchanged", None),
                    Err(error) => {
                        tracing::warn!(error = %format!("{error:#}"), "lowering trust failed");
                        simple_response(false, "refused", Some("failed"))
                    }
                };
                let _ = control::respond(pending, &response);
            }
            ControlCommand::TrustFull => {
                // No peer pid, no raise.
                let allowed = pending.peer_pid.is_some_and(|pid| {
                    crate::trust::peer_may_raise(pid, std::process::id()).is_ok()
                });
                let response = if !allowed {
                    tracing::warn!("refused a trust raise from a process wsmp started");
                    simple_response(false, "refused", Some("raise"))
                } else if startup.full_control() {
                    simple_response(true, "unchanged", None)
                } else {
                    match crate::trust::persist_full() {
                        Ok(()) => {
                            startup.raise_trust();
                            tracing::warn!("`wsmp trust full` raised this node to Full control");
                            changes.push(NodeChange::Raised);
                            simple_response(true, "changed", None)
                        }
                        Err(error) => {
                            tracing::warn!(error = %format!("{error:#}"), "raising trust failed");
                            simple_response(false, "refused", Some("failed"))
                        }
                    }
                };
                let _ = control::respond(pending, &response);
            }
        }
    }
    Ok(changes)
}

#[cfg(not(unix))]
fn answer_control_requests(
    _control: &mut ControlServer,
    _startup: &TerminalStartup,
    _node_slug: &str,
    _connection: &str,
) -> Result<Vec<NodeChange>> {
    Ok(Vec::new())
}

fn wait_for_reconnect(
    control: &mut ControlServer,
    startup: &TerminalStartup,
    node_slug: &str,
    delay: Duration,
    link: &mut NodeLink,
) -> Result<()> {
    let deadline = Instant::now() + delay;
    let mut watch = ConfigWatch::new();
    while Instant::now() < deadline {
        check_shutdown()?;
        link.drain_offline();
        // Trust and features changed while disconnected reach the next hello.
        let changes = answer_control_requests(control, startup, node_slug, "reconnecting")?;
        if changes.contains(&NodeChange::Lowered) {
            let interrupted = link.execs.interrupt_all();
            link.deferred.extend(interrupted);
        }
        if watch.changed() {
            match reload_config(startup) {
                Ok(changes) if changes.contains(&NodeChange::Lowered) => {
                    let interrupted = link.execs.interrupt_all();
                    link.deferred.extend(interrupted);
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(error = %format!("{error:#}"), "reloading the config failed");
                }
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
    Ok(())
}

/// Held definitions and what their handles reach, for the current trust.
struct NodeRuntimes {
    store: Store,
    /// `runtimeHosts` as last read: always-on addresses are re-checked.
    runtime_hosts: Vec<String>,
    targets: BTreeMap<String, Target>,
    /// Every instance rank on this node, as last observed.
    instances: Vec<(Job, InstanceRecord)>,
}

impl NodeRuntimes {
    fn load(trust: TrustValue, runtime_hosts: &[String]) -> Self {
        let store = crate::runtime_store::load_for(trust).unwrap_or_else(|error| {
            tracing::warn!(
                error = %format!("{error:#}"),
                "reading held definitions failed; holding none"
            );
            Store::default()
        });
        let mut runtimes = Self {
            store,
            runtime_hosts: runtime_hosts.to_vec(),
            targets: BTreeMap::new(),
            instances: Vec::new(),
        };
        runtimes.retarget();
        runtimes
    }

    /// Reload the held set for `trust`, keeping the observed instances.
    fn reload(&mut self, trust: TrustValue, runtime_hosts: &[String]) {
        let instances = std::mem::take(&mut self.instances);
        *self = Self::load(trust, runtime_hosts);
        self.instances = instances;
        self.retarget();
    }

    #[cfg(unix)]
    fn set_instances(&mut self, instances: Vec<(Job, InstanceRecord)>) {
        self.instances = instances;
        self.retarget();
    }

    fn retarget(&mut self) {
        let mut targets = crate::runtimes::endpoints::always_on_targets(&self.store);
        // An address no longer allowed (a host removed from `runtimeHosts`)
        // stops being reachable at once.
        targets.retain(|slug, target| {
            let allowed = crate::runtime_store::validate::check_base_url(
                &target.endpoint.base_url,
                &self.runtime_hosts,
            )
            .is_ok();
            if !allowed {
                tracing::warn!(
                    runtime = slug,
                    "an always-on address is no longer allowed here"
                );
            }
            allowed
        });
        targets.extend(crate::runtimes::endpoints::instance_targets(
            &self.instances,
        ));
        self.targets = targets;
    }

    /// Ports live instances hold, by the runtime they run.
    fn busy_ports(&self) -> BTreeMap<u16, String> {
        self.instances
            .iter()
            .filter(|(_, record)| record.phase != InstancePhase::Stopped)
            .map(|(job, _)| (job.port, job.runtime_id.clone()))
            .collect()
    }

    fn instance_records(&self) -> Vec<InstanceRecord> {
        self.instances
            .iter()
            .map(|(_, record)| record.clone())
            .collect()
    }

    fn endpoints(&self) -> Vec<crate::config::EndpointConfig> {
        self.targets
            .values()
            .map(|target| target.endpoint.clone())
            .collect()
    }
}

/// Everything one relay connection owns. Dropping it ends every terminal,
/// command, file op and speech session it started.
struct Session<'a> {
    worker_tx: SyncSender<FromWorker>,
    workers: BTreeMap<String, WorkerHandle>,
    recent_finished: RecentlyFinished,
    terminals: TerminalRegistry,
    /// Node commands outlive a connection (daemon lifetime, `NodeLink`).
    execs: &'a mut ExecRegistry,
    /// Command statuses held until this connection is registered.
    deferred: &'a mut Vec<OutboundFrame>,
    stt: crate::stt::SttRegistry,
    #[cfg(unix)]
    files: crate::file_relay::FileRelay,
    registered: bool,
    telemetry: Option<crate::telemetry::Telemetry>,
    defines: Defines,
    runtimes: NodeRuntimes,
    #[cfg(unix)]
    runner: Option<crate::runtimes::runner::Runner>,
    /// The newest instance observation applied.
    #[cfg(unix)]
    observed_generation: u64,
    /// The metric commands hash the telemetry thread runs.
    metric_commands_applied: Option<String>,
}

/// The command lifetime cap the held node definition sets (24 h without one).
fn command_max(store: &Store) -> Duration {
    store
        .command_max_ms()
        .map_or(DEFAULT_COMMAND_MAX, Duration::from_millis)
}

/// What outlives one relay connection: the worker channel and the node
/// commands (a long command keeps running through a reconnect), plus the
/// command results that ended while disconnected.
struct NodeLink {
    worker_tx: SyncSender<FromWorker>,
    worker_rx: Receiver<FromWorker>,
    execs: ExecRegistry,
    deferred: Vec<OutboundFrame>,
}

impl NodeLink {
    fn new(store: &Store) -> Self {
        let (worker_tx, worker_rx) =
            mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
        let mut execs = ExecRegistry::new(worker_tx.clone(), DEFAULT_COMMAND_MAX);
        let mut deferred = Vec::new();
        match crate::paths::state_dir() {
            Ok(dir) => {
                let (with_table, interrupted) = execs.with_table(dir.join("node-commands.json"));
                execs = with_table;
                deferred = interrupted;
            }
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "running commands are not recorded"
            ),
        }
        execs.set_command_max(command_max(store));
        Self {
            worker_tx,
            worker_rx,
            execs,
            deferred,
        }
    }

    /// While disconnected: keep command output flowing into the registry
    /// (so commands never block on a full pipe) and keep their end results
    /// for the next connection. Everything else from a closed session drops.
    fn drain_offline(&mut self) {
        while let Ok(message) = self.worker_rx.try_recv() {
            match message {
                FromWorker::ExecBytes {
                    command_id,
                    stderr,
                    bytes,
                } => self.execs.on_bytes(&command_id, stderr, &bytes),
                FromWorker::ExecEof { command_id, stderr } => {
                    self.execs.on_eof(&command_id, stderr);
                }
                _ => {}
            }
        }
        let ended = self.execs.poll(Instant::now());
        self.deferred.extend(ended);
    }
}

/// The hello `features`, with the names of the node's secrets.
fn node_features(startup: &TerminalStartup) -> crate::protocol::runtime_spec::NodeFeatures {
    let mut features = startup.features();
    features.secrets = crate::secrets::entries();
    features
}

fn run_relay_session(
    config: &Config,
    startup: &TerminalStartup,
    node_slug: &str,
    ws_url: &Url,
    auth_value: HeaderValue,
    control: &mut ControlServer,
    link: &mut NodeLink,
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
    let (mut socket, response) = connect(request)
        .map_err(|error| relay_connect_error(error, stop_on_unusable_credential()))?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        != Some(RELAY_SUBPROTOCOL)
    {
        return Err(RelaySessionError::Fatal(anyhow::anyhow!(
            "server did not accept relay websocket subprotocol `{RELAY_SUBPROTOCOL}`; upgrade the WS Model Proxy server"
        )));
    }
    set_socket_timeouts(
        socket.get_mut(),
        RELAY_SOCKET_POLL_INTERVAL,
        Duration::from_secs(5),
    )
    .map_err(|error| RelaySessionError::Reconnectable {
        error,
        reset_backoff: false,
    })?;

    // Created before hello so an early `?` still drops (and kills) every child.
    let worker_tx = link.worker_tx.clone();
    let worker_rx = &link.worker_rx;
    // The watch starts before the pre-hello reload: no edit falls between.
    let mut config_watch = ConfigWatch::new();
    let mut session = Session {
        worker_tx: worker_tx.clone(),
        workers: BTreeMap::new(),
        recent_finished: RecentlyFinished::new(),
        terminals: TerminalRegistry::new(worker_tx.clone()),
        execs: &mut link.execs,
        deferred: &mut link.deferred,
        // Live speech-to-text sessions; dropping the registry ends them all.
        stt: crate::stt::SttRegistry::new(worker_tx.clone()),
        // Node file ops run on the daemon's file pool, never on this loop;
        // the relay keeps only the ops it has pending.
        #[cfg(unix)]
        files: {
            let runtime = crate::file_relay::shared_runtime(
                startup.allow_file_tools_as_root(),
                startup.file_roots(),
            );
            let tx = worker_tx.clone();
            let sink: crate::file_relay::FileSink = Arc::new(move |op_id, frames| {
                let _ = tx.send(FromWorker::FileFrames { op_id, frames });
            });
            crate::file_relay::FileRelay::new(runtime, startup.full_control(), sink)
        },
        registered: false,
        telemetry: None,
        defines: Defines::default(),
        runtimes: NodeRuntimes::load(startup.trust_value(), &startup.runtime_hosts()),
        #[cfg(unix)]
        runner: crate::runtimes::runner::Runner::start()
            .inspect_err(|error| {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    "runtime steps are unavailable"
                );
            })
            .ok(),
        #[cfg(unix)]
        observed_generation: 0,
        metric_commands_applied: None,
    };

    let server_url = config.server_url.as_deref().unwrap_or_default();
    let hello_origin = config.hello_origin().map_err(RelaySessionError::Fatal)?;
    let identity = startup.identity().ok_or_else(|| {
        RelaySessionError::Fatal(anyhow::anyhow!(
            "CLI identity key is unavailable; cannot bind this node"
        ))
    })?;
    let (nonce, origin) = wait_for_hello_challenge(&mut socket)?;
    check_hello_origin(&origin, &hello_origin, server_url)?;
    let identity_signature = identity
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
        definitions: session.runtimes.store.held_definitions(),
        held_metric_commands_hash: session.runtimes.store.metric_commands_hash(),
        held_port_range: session.runtimes.store.port_range(),
        held_fabrics_hash: session.runtimes.store.fabrics_hash(),
    };
    send_control(&mut socket, &hello, "sending relay hello")?;

    let mut next_telemetry_sync = Instant::now();
    let mut next_heartbeat =
        Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
    let result = 'session: loop {
        if let Some(signal) = crate::shutdown::requested() {
            break 'session Err(RelaySessionError::Shutdown(signal));
        }
        if session.registered && !session.deferred.is_empty() {
            // Commands that ended (or were interrupted) while disconnected.
            let pending = std::mem::take(session.deferred);
            if let Err(error) = send_outbound_frames(&mut socket, pending) {
                break Err(error);
            }
        }
        if let Err(error) = drain_worker_output(&mut socket, worker_rx, &mut session) {
            break Err(error);
        }
        if let Err(error) = drain_runner(&mut socket, &mut session) {
            break Err(error);
        }
        let now = Instant::now();
        #[cfg(unix)]
        if let Err(error) = send_outbound_frames(&mut socket, session.terminals.poll(now)) {
            break Err(error);
        }
        let ended = session.execs.poll(now);
        if session.registered {
            if let Err(error) = send_outbound_frames(&mut socket, ended) {
                break Err(error);
            }
        } else {
            // Nothing but hello before `hello.ok`.
            session.deferred.extend(ended);
        }
        let endpoints = session.runtimes.endpoints();
        let stt_frames = session.stt.poll(now, || endpoints.clone());
        if let Err(error) = send_stt_frames(&mut socket, &mut session.stt, stt_frames) {
            break Err(error);
        }
        #[cfg(unix)]
        if let Err(error) = send_file_frames(&mut socket, session.files.expire_stale(now)) {
            break Err(error);
        }
        let connection = if session.registered {
            "connected"
        } else {
            "registering"
        };
        let mut changes = match answer_control_requests(control, startup, node_slug, connection) {
            Ok(changes) => changes,
            Err(error) => break Err(RelaySessionError::Fatal(error)),
        };
        if config_watch.changed() {
            match reload_config(startup) {
                Ok(found) => changes.extend(found),
                Err(error) => tracing::warn!(
                    error = %format!("{error:#}"),
                    "reloading the config failed"
                ),
            }
        }
        if let Err(error) = apply_node_changes(&mut socket, startup, &mut session, &changes) {
            break Err(error);
        }
        if session.registered && Instant::now() >= next_telemetry_sync {
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
        if session.registered && Instant::now() >= next_heartbeat {
            let heartbeat = NodeFrame::Heartbeat {
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
            Ok(Message::Text(text)) => {
                handle_text(&mut socket, config, startup, &mut session, &text)
            }
            Ok(Message::Binary(bytes)) => handle_binary(&mut socket, &bytes, &mut session),
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
            Err(tungstenite::Error::Io(err)) if read_poll_woke(&err) => Ok(()),
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

    // Stops the sampling thread; a scrape in flight finishes on its own.
    drop(session.telemetry.take());
    let _ = send_outbound_frames(&mut socket, session.terminals.kill_all());
    // Commands outlive a reconnect; a shutdown ends them (interrupted).
    if crate::shutdown::requested().is_some() {
        let _ = send_outbound_frames(&mut socket, session.execs.kill_all());
    }
    // In-flight file ops are cancelled; their results are dropped.
    #[cfg(unix)]
    session.files.cancel_all();
    // The server fails these sessions itself when the relay drops.
    session.stt.abort_all();
    abort_all_workers(std::mem::take(&mut session.workers));
    let result = settle_after_shutdown(result, crate::shutdown::requested());
    if matches!(result, Err(RelaySessionError::Shutdown(_))) {
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

/// Mark every in-flight worker cancelled and drop their handles. Dropping each
/// body sender aborts any streaming request body; response streaming loops
/// observe the cancelled flag or fail to send and exit on their own. We do not
/// join here so a slow upstream cannot delay reconnection.
fn abort_all_workers(workers: BTreeMap<String, WorkerHandle>) {
    for (_, worker) in workers {
        worker.cancellation.cancel();
        drop(worker.body_tx);
        // Detach: the thread exits once its upstream call unwinds.
        drop(worker.join);
    }
}

fn worker_frame_is_current(workers: &BTreeMap<String, WorkerHandle>, request_id: &str) -> bool {
    workers.contains_key(request_id)
}

fn drain_worker_output<S>(
    socket: &mut tungstenite::WebSocket<S>,
    worker_rx: &Receiver<FromWorker>,
    session: &mut Session,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    loop {
        match worker_rx.try_recv() {
            Ok(FromWorker::Send { request_id, frame }) => {
                // A cancellation removes the live handle before acknowledging
                // it. Suppress any racing worker frame already queued behind
                // that cancellation so cancelled requests never complete late.
                if !worker_frame_is_current(&session.workers, &request_id) {
                    continue;
                }
                match frame {
                    WsFrame::Text(text) => socket.send(Message::Text(text.into())),
                    WsFrame::Binary(bytes) => socket.send(Message::Binary(bytes.into())),
                }
                .map_err(|error| websocket_session_error(error, "sending relay frame", true))?;
            }
            Ok(FromWorker::Finished(request_id)) => {
                // Remember the id so late body chunks the server is still
                // flushing get dropped silently instead of faulted as
                // "before request metadata".
                session.recent_finished.record(&request_id);
                if let Some(worker) = session.workers.remove(&request_id) {
                    let _ = worker.join.join();
                }
            }
            #[cfg(unix)]
            Ok(FromWorker::TerminalBytes { terminal_id, bytes }) => {
                send_outbound_frames(socket, session.terminals.on_bytes(&terminal_id, &bytes))?;
            }
            #[cfg(unix)]
            Ok(FromWorker::TerminalEof { terminal_id }) => {
                send_outbound_frames(socket, session.terminals.on_eof(&terminal_id))?;
            }
            #[cfg(unix)]
            Ok(FromWorker::TerminalWriteFailed { terminal_id }) => {
                tracing::warn!(
                    terminal_id,
                    "writing terminal input failed; closing the terminal"
                );
                send_outbound_frames(socket, session.terminals.close(&terminal_id))?;
            }
            Ok(FromWorker::ExecBytes {
                command_id,
                stderr,
                bytes,
            }) => session.execs.on_bytes(&command_id, stderr, &bytes),
            Ok(FromWorker::ExecEof { command_id, stderr }) => {
                session.execs.on_eof(&command_id, stderr);
            }
            Ok(FromWorker::Stt {
                session_id,
                message,
            }) => {
                if let Some(message) = session.stt.outbound(&session_id, *message) {
                    send_stt(socket, &mut session.stt, message)?;
                }
            }
            // A frame queued by a closed session's worker never precedes
            // this session's hello.
            Ok(FromWorker::Telemetry(_)) if !session.registered => {}
            Ok(FromWorker::Telemetry(text)) => {
                socket
                    .send(Message::Text(text.into()))
                    .map_err(|error| websocket_session_error(error, "sending telemetry", true))?;
            }
            #[cfg(unix)]
            Ok(FromWorker::FileFrames { op_id, frames }) => {
                // Cancelled or torn-down ops are no longer pending: drop them.
                if session.files.complete(&op_id) {
                    send_file_frames(socket, frames)?;
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
    startup: &TerminalStartup,
    session: &mut Session,
    text: &str,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let frame = match parse_server_control(text) {
        Ok(frame) => frame,
        Err(error) => {
            let fault = control_frame_fault(text);
            if let Some(result) = apply_stt_fault(socket, &mut session.stt, &fault) {
                return result;
            }
            return apply_frame_fault(socket, fault, &mut session.terminals, session.execs, &error);
        }
    };
    if let Some(message) = SttServerMessage::from_frame(&frame) {
        let endpoints = if matches!(message, SttServerMessage::Open { .. }) {
            session.runtimes.endpoints()
        } else {
            Vec::new()
        };
        let frames = session.stt.handle(message, &endpoints, Instant::now());
        return send_stt_frames(socket, &mut session.stt, frames);
    }
    let state_dir = crate::paths::state_dir().ok();
    match frame {
        ServerFrame::HelloOk {
            id,
            node_id,
            definition_sync,
            ..
        } => {
            if session.registered {
                return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                    "duplicate relay registration acknowledgement"
                )));
            }
            session.registered = true;
            tracing::info!(id, node_id, ?definition_sync, "relay registration accepted");
            send_inventory(session);
        }
        ServerFrame::HelloChallenge { .. } => {
            return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                "server sent hello.challenge after hello"
            )));
        }
        ServerFrame::ProtocolError { message, code, .. } => {
            if code == ProtocolErrorCode::Internal {
                return Err(RelaySessionError::Reconnectable {
                    error: anyhow::anyhow!("relay protocol error: {message}"),
                    reset_backoff: false,
                });
            }
            let text = if session.registered {
                format!("relay protocol error: {message}")
            } else {
                hello_rejection_message(&message, Some(&code))
            };
            return Err(RelaySessionError::Fatal(anyhow::anyhow!(text)));
        }
        ServerFrame::HeartbeatPong { id, .. } => {
            tracing::debug!(id, "relay heartbeat acknowledged");
        }
        ServerFrame::TrustLower { id, .. } => {
            lower_trust(socket, startup, session, &id)?;
        }
        ServerFrame::RuntimeDefine { .. } => {
            let runtime_hosts = startup.runtime_hosts();
            let busy_ports = session.runtimes.busy_ports();
            let ctx = crate::runtime_store::DefineContext {
                trust: startup.trust_value(),
                runtime_hosts: &runtime_hosts,
                busy_ports: &busy_ports,
            };
            let live = crate::runtime_store::live_path().map_err(RelaySessionError::Fatal)?;
            match session.defines.handle(text, &frame, &ctx, &live) {
                Ok(outcome) => {
                    send_control(socket, &outcome.answer, "answering a runtime definition")?;
                    if outcome.changed {
                        session
                            .runtimes
                            .reload(startup.trust_value(), &startup.runtime_hosts());
                        session
                            .execs
                            .set_command_max(command_max(&session.runtimes.store));
                        sync_metric_commands(session);
                        send_inventory(session);
                    }
                }
                Err(error) => {
                    // Out-of-order chunks or an unreadable store: the server
                    // times the operation out and retries it whole.
                    tracing::warn!(
                        error = %format!("{error:#}"),
                        "a runtime definition could not be applied"
                    );
                }
            }
        }
        ServerFrame::RuntimeDetect { id } => {
            send_control(
                socket,
                &NodeFrame::RuntimeDetected {
                    id: Some(id),
                    scanned_at: crate::telemetry::now_rfc3339(),
                    servers: Vec::new(),
                },
                "answering a detection scan",
            )?;
        }
        ServerFrame::RuntimeInventoryOk { snapshot_id } => {
            tracing::debug!(snapshot_id, "runtime inventory acknowledged");
        }
        ServerFrame::RuntimeInventoryError {
            snapshot_id,
            message,
        } => {
            tracing::warn!(
                snapshot_id,
                message,
                "the server rejected the runtime inventory"
            );
        }
        ServerFrame::RuntimeJob(job) => {
            handle_runtime_job(socket, config, startup, session, *job)?;
        }
        ServerFrame::SecretSet(secret) => {
            let result = crate::secrets::set(startup.full_control(), &secret.name, &secret.value);
            for frame in secret_answer(secret.id, secret.name, result, || node_state(startup)) {
                send_control(socket, &frame, "answering a secret write")?;
            }
        }
        ServerFrame::SecretDelete { id, name } => {
            let result = crate::secrets::delete(startup.full_control(), &name);
            for frame in secret_answer(id, name, result, || node_state(startup)) {
                send_control(socket, &frame, "answering a secret removal")?;
            }
        }
        ServerFrame::RelayCancel { request_id, reason } => {
            tracing::warn!(request_id, ?reason, "relay request cancelled");
            // Cancelled request: any body chunks still in flight are late, not
            // premature — drop them silently rather than faulting them.
            session.recent_finished.record(&request_id);
            if let Some(worker) = session.workers.remove(&request_id) {
                worker.cancellation.cancel();
                drop(worker.body_tx);
                drop(worker.join);
                send_control(
                    socket,
                    &NodeFrame::RelayCancelled { request_id },
                    "sending relay cancellation acknowledgement",
                )?;
            }
        }
        ServerFrame::RelayRequest {
            request_id,
            method,
            path,
            headers,
            timeout_ms,
            handle,
            expect_body,
            body_bytes,
            count_first,
            count_ceiling,
            ..
        } => {
            start_relay_request(
                socket,
                config,
                &session.runtimes.targets,
                &session.worker_tx,
                &mut session.workers,
                &session.recent_finished,
                RelayRequest {
                    request_id,
                    method: match method {
                        HttpMethod::Get => "GET",
                        HttpMethod::Post => "POST",
                        HttpMethod::Delete => "DELETE",
                    }
                    .to_string(),
                    path,
                    headers,
                    timeout_ms,
                    handle,
                    expect_body,
                    body_bytes,
                    count_first: count_first.unwrap_or(false),
                    count_ceiling,
                },
            )?;
        }
        ServerFrame::TermOpen {
            terminal_id,
            viewer_id,
            cols,
            rows,
            browser_public_key,
            browser_nonce,
            identity,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.open(
                    startup,
                    config,
                    state_dir.as_deref(),
                    TermHandshake {
                        terminal_id: &terminal_id,
                        viewer_id: viewer_id.as_deref(),
                        cols,
                        rows,
                        browser_public_key: &browser_public_key,
                        browser_nonce: &browser_nonce,
                        identity: identity.as_ref(),
                    },
                ),
            )?;
        }
        ServerFrame::TermAttach {
            terminal_id,
            viewer_id,
            browser_public_key,
            browser_nonce,
            identity,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.attach(
                    startup,
                    state_dir.as_deref(),
                    TermHandshake {
                        terminal_id: &terminal_id,
                        viewer_id: viewer_id.as_deref(),
                        cols: 0,
                        rows: 0,
                        browser_public_key: &browser_public_key,
                        browser_nonce: &browser_nonce,
                        identity: identity.as_ref(),
                    },
                ),
            )?;
        }
        ServerFrame::TermDetach {
            terminal_id,
            viewer_id,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.detach(&terminal_id, viewer_id.as_deref()),
            )?;
        }
        ServerFrame::TermClose { terminal_id } => {
            send_outbound_frames(socket, session.terminals.close_from_server(&terminal_id))?;
        }
        ServerFrame::TermAuth {
            terminal_id,
            viewer_id,
            signature,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.auth(
                    startup,
                    config,
                    state_dir.as_deref(),
                    &terminal_id,
                    viewer_id.as_deref(),
                    &signature,
                ),
            )?;
        }
        ServerFrame::ExecStart {
            command_id,
            command,
            cwd,
            timeout_ms,
        } => {
            send_outbound_frames(
                socket,
                session.execs.start(
                    startup,
                    config,
                    &command_id,
                    &command,
                    cwd.as_deref(),
                    timeout_ms,
                ),
            )?;
        }
        ServerFrame::ExecPoll {
            command_id,
            tail_bytes,
        } => {
            send_outbound_frames(
                socket,
                session
                    .execs
                    .status(&command_id, usize::try_from(tail_bytes).unwrap_or(0)),
            )?;
        }
        ServerFrame::ExecCancel { command_id } => {
            send_outbound_frames(socket, session.execs.cancel(&command_id))?;
        }
        ServerFrame::FileOp {
            op_id,
            op,
            args,
            body_bytes,
        } => {
            #[cfg(unix)]
            send_file_frames(
                socket,
                session.files.handle_op(
                    &op_id,
                    crate::file_relay::op_name(op),
                    args,
                    body_bytes.and_then(|bytes| usize::try_from(bytes).ok()),
                ),
            )?;
            #[cfg(not(unix))]
            {
                let _ = (op, args, body_bytes);
                send_control(
                    socket,
                    &NodeFrame::FileRejected {
                        op_id,
                        reason: "unsupported".to_string(),
                        detail: None,
                    },
                    "sending a file op rejection",
                )?;
            }
        }
        ServerFrame::FileCancel { op_id } => {
            #[cfg(unix)]
            session.files.handle_cancel(&op_id);
            #[cfg(not(unix))]
            let _ = op_id;
        }
        // Speech frames were handled above.
        ServerFrame::SttOpen { .. }
        | ServerFrame::SttUpdate { .. }
        | ServerFrame::SttCommit { .. }
        | ServerFrame::SttClear { .. }
        | ServerFrame::SttClose { .. } => {}
    }
    Ok(())
}

/// `trust.lower`: Relay only from now on, persisted and frozen, then the
/// same effects as any lowering. Answered with `node.state`.
fn lower_trust<S>(
    socket: &mut tungstenite::WebSocket<S>,
    startup: &TerminalStartup,
    session: &mut Session,
    id: &str,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    if let Err(error) = apply_lower(startup) {
        // Latched for this daemon anyway; the frozen copy, when it was
        // written, keeps the node lowered after a restart.
        tracing::error!(
            error = %format!("{error:#}"),
            "persisting the lowered trust failed"
        );
    }
    tracing::warn!(id, "a person lowered this node to Relay only");
    apply_node_changes(socket, startup, session, &[NodeChange::Lowered])
}

/// Session effects of a trust or feature change, then `node.state`.
/// Lowering ends every Full-only session: commands (whole process tree,
/// reported `interrupted`), browser terminals and file ops, and switches the
/// held set to the frozen copy.
fn apply_node_changes<S>(
    socket: &mut tungstenite::WebSocket<S>,
    startup: &TerminalStartup,
    session: &mut Session,
    changes: &[NodeChange],
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    if changes.is_empty() {
        return Ok(());
    }
    if changes.contains(&NodeChange::Lowered) {
        #[cfg(unix)]
        session.files.lower_trust();
        let interrupted = session.execs.interrupt_all();
        // Operator terminals are allowed at Relay only: they stay.
        if session.registered {
            send_outbound_frames(socket, session.terminals.on_trust_lowered())?;
            send_outbound_frames(socket, interrupted)?;
        } else {
            let _ = session.terminals.on_trust_lowered();
            session.deferred.extend(interrupted);
        }
    }
    if changes.contains(&NodeChange::Raised) {
        #[cfg(unix)]
        session.files.raise_trust();
    }
    // Trust changes switch the held set; host changes re-check addresses.
    session
        .runtimes
        .reload(startup.trust_value(), &startup.runtime_hosts());
    session
        .execs
        .set_command_max(command_max(&session.runtimes.store));
    sync_metric_commands(session);
    if !session.registered {
        return Ok(());
    }
    send_control(socket, &node_state(startup), "reporting the node state")
}

/// `runtime.job`: render from the held/frozen definition and run it off this
/// loop, or refuse before admission. A stop or check of an instance whose
/// version the server since dropped runs from the instance's own record.
///
/// An interactive step (`job.operator`) runs in its operator terminal
/// (`crate::runtimes::operator`); every answer to it names that terminal. A
/// re-delivery of a terminal already open re-reports its state. A stop for a
/// rank closes that rank's operator terminals still on their confirm screen
/// (a person's run in progress is never cut off: the stop waits for it).
fn handle_runtime_job<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    startup: &TerminalStartup,
    session: &mut Session,
    job: crate::protocol::frames::RuntimeJob,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let terminal_id = job
        .operator
        .as_ref()
        .map(|operator| operator.terminal_id.clone());
    let refusal = |error: JobError, detail: Option<String>| NodeFrame::RuntimeJobResult {
        step_id: job.step_id.clone(),
        instance_id: job.instance_id.clone(),
        rank: job.rank,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        status: JobStatus::Failed,
        stopped: false,
        error: Some(error),
        detail,
        terminal_id: terminal_id.clone(),
        exit_code: None,
    };
    if let Some(operator) = &job.operator {
        use crate::sessions::OperatorDelivery;
        match session
            .terminals
            .operator_delivery(&job.step_id, &operator.terminal_id)
        {
            OperatorDelivery::New => {}
            // Already open (re-report it), still pending or already ended:
            // never a second run under one terminal id.
            OperatorDelivery::Repeat(status) => {
                let Some(status) = status else {
                    return Ok(());
                };
                let ids = operator_ids(&job, &operator.terminal_id);
                return send_control(socket, &ids.result(status, None), "re-reporting a step");
            }
            OperatorDelivery::Clash => {
                return send_control(
                    socket,
                    &refusal(JobError::BadJob, Some("operator".into())),
                    "refusing an operator step",
                );
            }
        }
    }
    let facts = crate::runtimes::render::NodeFacts::current();
    let trust = startup.trust_value();
    let missing = if trust == TrustValue::Full {
        JobError::DefinitionMissing
    } else {
        JobError::DefinitionFrozen
    };
    let refused_with = |error: JobError, detail: &str| crate::runtimes::render::Refusal {
        error,
        detail: Some(detail.to_string()),
    };
    let rendered = if let Err(refused) = crate::runtimes::render::check_ids(&job) {
        Err(refused)
    } else if matches!(
        job.phase,
        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
    ) {
        crate::runtimes::render::render(&job, trust, &session.runtimes.store, &facts)
    } else {
        // Checks and stops run the commands the rank was launched with (its
        // own record), never re-rendered. Checks still need the version held;
        // a stop also works after the server dropped it.
        let held = session
            .runtimes
            .store
            .find(&job.launch_version_id, &job.launch_hash)
            .is_some();
        #[cfg(unix)]
        let recorded =
            crate::runtimes::runner::recorded_job(&job.instance_id, job.rank).filter(|known| {
                known.version_id == job.launch_version_id
                    && known.launch_hash == job.launch_hash
                    && known.unit_name == job.unit_name
                    && known.handle == job.handle
                    && known.runtime_id == job.runtime_id
            });
        #[cfg(not(unix))]
        let recorded: Option<Job> = None;
        if !held && job.phase != JobPhase::Stop {
            Err(refused_with(missing, "launchVersionId"))
        } else if let Some(known) = recorded {
            from_record(&job, known)
        } else if held {
            // No record: the executor answers `instance_unknown`.
            crate::runtimes::render::render(&job, trust, &session.runtimes.store, &facts)
        } else {
            Err(refused_with(missing, "launchVersionId"))
        }
    };
    let rendered = match rendered {
        Ok(rendered) => rendered,
        Err(refused) => {
            tracing::warn!(
                step_id = job.step_id,
                error = ?refused.error,
                detail = refused.detail.as_deref().unwrap_or(""),
                "refused a runtime job before admission"
            );
            return send_control(
                socket,
                &refusal(refused.error, refused.detail),
                "refusing a runtime job",
            );
        }
    };
    // Only an admitted stop closes the rank's confirm screens (a person's
    // run in progress is never cut off: the stop waits for it).
    if job.phase == JobPhase::Stop {
        let closed = session
            .terminals
            .close_confirming_for_rank(&job.instance_id, job.rank);
        send_outbound_frames(socket, closed)?;
    }
    #[cfg(unix)]
    {
        let ticket = match &job.operator {
            None => None,
            Some(operator) => {
                // Taken now, before the runner thread exists: a re-delivery
                // or a newer dispatch of the step sees it (see `reserve_operator`).
                match session
                    .terminals
                    .reserve_operator(&job.step_id, &operator.terminal_id)
                {
                    Ok(closed) => send_outbound_frames(socket, closed)?,
                    Err(error) => {
                        return send_control(
                            socket,
                            &refusal(error, None),
                            "refusing an operator step",
                        );
                    }
                }
                Some(operator_ticket(&job, operator, &rendered, config))
            }
        };
        let submitted = match (session.runner.as_ref(), ticket) {
            (Some(runner), Some(ticket)) => runner.submit_operator(rendered, ticket),
            (Some(runner), None) => runner.submit(rendered),
            (None, _) => Err(anyhow::anyhow!("runtime steps are unavailable")),
        };
        if let Err(error) = submitted {
            if let Some(terminal_id) = &terminal_id {
                session.terminals.release_operator(terminal_id);
            }
            tracing::warn!(error = %format!("{error:#}"), "could not run a runtime job");
            return send_control(
                socket,
                &refusal(JobError::SessionDisconnected, None),
                "refusing a runtime job",
            );
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (rendered, config);
        send_control(
            socket,
            &refusal(JobError::ExecutionMechanismUnavailable, None),
            "refusing a runtime job",
        )
    }
}

/// A check or stop from the rank's own record (never re-rendered). An
/// interactive stop runs only in its operator terminal, and only an
/// interactive stop gets one.
fn from_record(
    job: &crate::protocol::frames::RuntimeJob,
    known: Job,
) -> Result<Job, crate::runtimes::render::Refusal> {
    let interactive = known
        .parsed_spec()
        .is_some_and(|spec| crate::runtimes::render::interactive_phase(&spec, job.rank, job.phase));
    if interactive != job.operator.is_some() {
        return Err(crate::runtimes::render::Refusal {
            error: JobError::BadJob,
            detail: Some("operator".into()),
        });
    }
    Ok(Job {
        step_id: job.step_id.clone(),
        action: job.phase,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        timeout_ms: job.timeout_ms.clamp(1, 3_600_000),
        command: String::new(),
        ..known
    })
}

/// The operator ticket of an admitted interactive job. The screen shows
/// what the node itself rendered (or recorded), never server-supplied text.
#[cfg(unix)]
fn operator_ticket(
    job: &crate::protocol::frames::RuntimeJob,
    operator: &crate::protocol::frames::JobOperator,
    rendered: &Job,
    config: &Config,
) -> crate::runtimes::runner::OperatorTicket {
    let command = if rendered.action == JobPhase::Stop {
        rendered.stop_command.clone()
    } else {
        rendered.command.clone()
    };
    crate::runtimes::runner::OperatorTicket {
        ids: operator_ids(job, &operator.terminal_id),
        screen: crate::runtimes::operator::OperatorScreen {
            node: crate::runtimes::operator::node_name(),
            handle: rendered.handle.clone(),
            phase: rendered.action,
            rank: rendered.rank,
            command,
            author: operator.command_author,
        },
        base_env: crate::sessions::operator_base_env(config),
    }
}

/// Who an operator step's answers name.
fn operator_ids(
    job: &crate::protocol::frames::RuntimeJob,
    terminal_id: &str,
) -> crate::runtimes::operator::OperatorIds {
    crate::runtimes::operator::OperatorIds {
        step_id: job.step_id.clone(),
        instance_id: job.instance_id.clone(),
        rank: job.rank,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        terminal_id: terminal_id.to_string(),
    }
}

/// Step results and instance observations from the runner.
fn drain_runner<S>(
    socket: &mut tungstenite::WebSocket<S>,
    session: &mut Session,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    #[cfg(unix)]
    while let Some(update) = session
        .runner
        .as_ref()
        .and_then(|runner| runner.try_update())
    {
        if let Some(request) = update.operator {
            use crate::runtimes::runner::OperatorRequest;
            let frames = match request {
                OperatorRequest::Open(open) => session.terminals.open_operator(*open),
                OperatorRequest::CloseIfConfirming { terminal_id } => {
                    session.terminals.close_operator_if_confirming(&terminal_id)
                }
            };
            if session.registered {
                send_outbound_frames(socket, frames)?;
            }
            continue;
        }
        if update.generation > session.observed_generation {
            session.observed_generation = update.generation;
            session.runtimes.set_instances(update.instances);
        }
        // An operator step's runner thread is done with its terminal id.
        if let Some(NodeFrame::RuntimeJobResult {
            terminal_id: Some(terminal_id),
            ..
        }) = &update.result
        {
            session.terminals.release_operator(terminal_id);
        }
        if !session.registered {
            continue;
        }
        if let Some(result) = &update.result {
            send_control(socket, result, "sending a runtime job result")?;
        }
        send_inventory(session);
    }
    #[cfg(not(unix))]
    let _ = (socket, session);
    Ok(())
}

/// Node metric commands follow the held (frozen at Relay only) node
/// definition; applied as soon as it changes.
fn sync_metric_commands(session: &mut Session<'_>) {
    let hash = session.runtimes.store.metric_commands_hash();
    if hash != session.metric_commands_applied
        && let Some(telemetry) = session.telemetry.as_ref()
    {
        telemetry.set_metric_commands(session.runtimes.store.metric_commands().to_vec());
        session.metric_commands_applied = hash;
    }
}

/// Send a fresh `runtime.inventory` (built off this loop).
fn send_inventory(session: &Session) {
    crate::runtimes::inventory::spawn(
        session.worker_tx.clone(),
        session.runtimes.store.clone(),
        session.runtimes.instance_records(),
    );
}

/// The `node.state` this node reports now (trust and features).
fn node_state(startup: &TerminalStartup) -> NodeFrame {
    NodeFrame::NodeState {
        trust: startup.trust(),
        features: node_features(startup),
    }
}

/// The answer to a secret write, then (when the secret set changed) a
/// `node.state` whose features carry the new secret names, so the server
/// lists them without waiting for the next hello.
fn secret_answer(
    id: String,
    name: String,
    result: Result<crate::secrets::Outcome, SecretRefusal>,
    state: impl FnOnce() -> NodeFrame,
) -> Vec<NodeFrame> {
    let changed = matches!(
        result,
        Ok(crate::secrets::Outcome::Set { .. } | crate::secrets::Outcome::Deleted)
    );
    let mut frames = vec![secret_result(id, name, result)];
    if changed {
        frames.push(state());
    }
    frames
}

fn secret_result(
    id: String,
    name: String,
    result: Result<crate::secrets::Outcome, SecretRefusal>,
) -> NodeFrame {
    let (status, reason, updated_at) = match result {
        Ok(crate::secrets::Outcome::Set { updated_at }) => {
            (SecretStatus::Set, None, Some(updated_at))
        }
        Ok(crate::secrets::Outcome::Deleted) => (SecretStatus::Deleted, None, None),
        Ok(crate::secrets::Outcome::NotFound) => (SecretStatus::NotFound, None, None),
        Err(reason) => (SecretStatus::Refused, Some(reason), None),
    };
    NodeFrame::SecretResult {
        id,
        name,
        status,
        reason,
        updated_at,
    }
}

/// One `relay.request`, as the daemon routes it.
struct RelayRequest {
    request_id: String,
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    timeout_ms: u64,
    handle: String,
    expect_body: bool,
    body_bytes: Option<u64>,
    count_first: bool,
    count_ceiling: Option<u64>,
}

fn start_relay_request<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    targets: &BTreeMap<String, Target>,
    worker_tx: &SyncSender<FromWorker>,
    workers: &mut BTreeMap<String, WorkerHandle>,
    recent_finished: &RecentlyFinished,
    request: RelayRequest,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let RelayRequest {
        request_id,
        method,
        path,
        headers,
        timeout_ms,
        handle,
        expect_body,
        body_bytes,
        count_first,
        count_ceiling,
    } = request;
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

    let Some(target) = targets.get(&handle) else {
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::NotFound,
            Some(format!("runtime `{handle}` is not available on this node")),
            None,
        )?;
        return Ok(());
    };
    // §4.8: only the routes this runtime's API, model type and definition
    // name, checked on the path as sent, before any connection is opened.
    if !crate::runtimes::allowlist::allowed(&target.spec, &method, &path) {
        tracing::warn!(
            request_id,
            handle,
            method,
            "refused a relayed path outside the allowlist"
        );
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::AccessDenied,
            Some(crate::runtimes::allowlist::PATH_NOT_ALLOWED.to_string()),
            None,
        )?;
        return Ok(());
    }
    let endpoint = &target.endpoint;

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
        endpoint_auth: endpoint
            .auth
            .as_ref()
            .map(|auth| (auth.mode.clone(), auth.env.clone())),
        timeout_ms,
        has_body: expect_body,
        body_bytes: body_bytes.filter(|_| expect_body),
        expand_media: endpoint.expand_media,
        trusted_origins: TrustedOrigins::new(
            config.server_url.as_deref(),
            &config.media_trusted_origins,
        ),
    };

    if count_first && expect_body {
        let (cancellation, cancellation_rx) = CancellationHandle::new();
        let thread_tx = worker_tx.clone();
        let thread_cancellation = cancellation.clone();
        let (body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(REQUEST_BODY_INGRESS_CAPACITY);
        let endpoint = endpoint.clone();
        let plan = CountFirstPlan {
            method: endpoint_count_method(&endpoint),
            adapter_count_route: None,
            count_ceiling,
        };
        let handle = thread::spawn(move || {
            run_count_first_worker(
                spec,
                endpoint,
                plan,
                body_rx,
                thread_tx,
                thread_cancellation,
                cancellation_rx,
            );
        });
        workers.insert(
            request_id,
            WorkerHandle {
                body_tx: Some(body_tx),
                cancellation,
                join: handle,
            },
        );
        return Ok(());
    }

    let (cancellation, cancellation_rx) = CancellationHandle::new();
    let thread_tx = worker_tx.clone();
    let thread_cancellation = cancellation.clone();

    let (body_tx, body_rx) = if expect_body {
        // The server may send every credited chunk before this just-spawned
        // worker gets scheduled. Credits are returned only after a chunk has
        // entered the async handoff, keeping the total unacknowledged burst
        // bounded by the negotiated window.
        let (tx, rx) = mpsc::sync_channel::<BodyChunk>(REQUEST_BODY_INGRESS_CAPACITY);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };

    let handle = thread::spawn(move || {
        run_upstream_worker(
            spec,
            body_rx,
            thread_tx,
            thread_cancellation,
            cancellation_rx,
        );
    });

    workers.insert(
        request_id,
        WorkerHandle {
            body_tx,
            cancellation,
            join: handle,
        },
    );
    Ok(())
}

/// Sends one `stt.*` frame without risking the relay: a frame the encoder
/// refuses ends only its session, with an `stt.error` in its place. Socket
/// errors stay what they are for every frame.
fn send_stt<S>(
    socket: &mut tungstenite::WebSocket<S>,
    stt: &mut crate::stt::SttRegistry,
    message: NodeFrame,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let text = match encode_control(&message) {
        Ok(text) => text,
        Err(_) => {
            let Some(session_id) = crate::stt::session_of(&message) else {
                return Ok(());
            };
            tracing::warn!(
                session_id,
                "a speech-to-text frame was outside the wire contract; ending that session"
            );
            let Some(refusal) = stt.refused_by_encoder(session_id) else {
                return Ok(());
            };
            match encode_control(&refusal) {
                Ok(text) => text,
                Err(_) => return Ok(()),
            }
        }
    };
    socket
        .send(Message::Text(text.into()))
        .map_err(|error| websocket_session_error(error, "sending a speech-to-text frame", true))
}

fn send_stt_frames<S>(
    socket: &mut tungstenite::WebSocket<S>,
    stt: &mut crate::stt::SttRegistry,
    frames: Vec<NodeFrame>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    for frame in frames {
        send_stt(socket, stt, frame)?;
    }
    Ok(())
}

/// A malformed frame that names a speech-to-text session concerns only it.
fn apply_stt_fault<S>(
    socket: &mut tungstenite::WebSocket<S>,
    stt: &mut crate::stt::SttRegistry,
    fault: &FrameFault,
) -> Option<RelaySessionResult<()>>
where
    S: std::io::Read + std::io::Write,
{
    let frames = match fault {
        FrameFault::RejectStt { session_id } => stt.malformed(session_id, true),
        FrameFault::FailStt { session_id } => stt.malformed(session_id, false),
        _ => return None,
    };
    tracing::warn!("a malformed speech-to-text frame");
    Some(send_stt_frames(socket, stt, frames))
}

fn apply_frame_fault<S>(
    socket: &mut tungstenite::WebSocket<S>,
    fault: FrameFault,
    terminals: &mut TerminalRegistry,
    execs: &mut ExecRegistry,
    error: &anyhow::Error,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    match fault {
        FrameFault::Fatal => {
            let _ = error;
            Err(RelaySessionError::Fatal(anyhow::anyhow!(
                "malformed relay frame"
            )))
        }
        FrameFault::Ignore => {
            tracing::warn!("ignoring a malformed or unknown relay frame");
            Ok(())
        }
        FrameFault::CloseTerminal { terminal_id } => {
            tracing::warn!(terminal_id, "closing a terminal after a malformed frame");
            send_outbound_frames(socket, terminals.close_from_server(&terminal_id))
        }
        FrameFault::DropViewer {
            terminal_id,
            viewer_id,
        } => {
            tracing::warn!(
                terminal_id,
                "removing a terminal viewer after a malformed frame"
            );
            send_outbound_frames(socket, terminals.drop_viewer(&terminal_id, &viewer_id))
        }
        FrameFault::CloseCommand { command_id } => {
            tracing::warn!(command_id, "closing a command after a malformed frame");
            send_outbound_frames(socket, execs.cancel(&command_id))
        }
        FrameFault::RejectExec { command_id } => {
            tracing::warn!(command_id, "refusing a malformed exec command request");
            // `reject_malformed` builds the refusal through `exec_rejected`,
            // which logs that command's one outcome line.
            send_outbound_frames(socket, execs.reject_malformed(&command_id))
        }
        FrameFault::RejectFile { op_id } => {
            tracing::warn!("refusing a malformed file op");
            send_control(
                socket,
                &NodeFrame::FileRejected {
                    op_id,
                    reason: "bad_frame".to_string(),
                    detail: None,
                },
                "sending a file op rejection",
            )
        }
        // Speech-to-text faults go to the session registry first
        // (`apply_stt_fault`); one arriving here has nothing left to name.
        FrameFault::RejectStt { .. } | FrameFault::FailStt { .. } => {
            tracing::warn!("ignoring a malformed speech-to-text frame");
            Ok(())
        }
    }
}

fn handle_binary<S>(
    socket: &mut tungstenite::WebSocket<S>,
    bytes: &[u8],
    session: &mut Session,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let (metadata, body) = match binary_frame_fault(bytes) {
        Ok(parsed) => parsed,
        Err(fault) => {
            if let Some(result) = apply_stt_fault(socket, &mut session.stt, &fault) {
                return result;
            }
            return apply_frame_fault(
                socket,
                fault,
                &mut session.terminals,
                session.execs,
                &anyhow::anyhow!("malformed relay binary frame"),
            );
        }
    };
    let (request_id, is_final) = match metadata {
        ServerBinaryMetadata::RelayRequestBody {
            request_id,
            is_final,
            ..
        } => (request_id, is_final),
        ServerBinaryMetadata::TermSealed {
            terminal_id,
            seq,
            viewer_id,
            ..
        } => {
            return send_outbound_frames(
                socket,
                session
                    .terminals
                    .handle_sealed(&terminal_id, viewer_id.as_deref(), seq, &body),
            );
        }
        ServerBinaryMetadata::FileBody { op_id } => {
            #[cfg(unix)]
            send_file_frames(socket, session.files.handle_body(&op_id, body))?;
            #[cfg(not(unix))]
            let _ = (&op_id, &body);
            return Ok(());
        }
        ServerBinaryMetadata::SttAudio { session_id, seq } => {
            let frames = session.stt.audio(&session_id, seq, body);
            return send_stt_frames(socket, &mut session.stt, frames);
        }
    };

    let last = is_final == Some(true);
    let workers = &mut session.workers;
    let recent_finished = &mut session.recent_finished;

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
            worker.cancellation.cancel();
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
                worker.cancellation.cancel();
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

const COUNT_FIRST_TIMEOUT_MS: u64 = 5_000;

fn count_first_exceeds_ceiling(tokens: u64, ceiling: Option<u64>) -> bool {
    ceiling.is_some_and(|max| tokens > max)
}

struct CountFirstPlan {
    method: Option<crate::count_context::CountContextMethod>,
    adapter_count_route: Option<String>,
    count_ceiling: Option<u64>,
}

fn run_count_first_worker(
    spec: UpstreamRequestSpec,
    endpoint: crate::config::EndpointConfig,
    plan: CountFirstPlan,
    body_rx: Receiver<BodyChunk>,
    tx: SyncSender<FromWorker>,
    cancellation: CancellationHandle,
    cancellation_rx: watch::Receiver<bool>,
) {
    let request_id = spec.request_id.clone();
    let proceed = (|| {
        let bytes = match collect_request_body(
            &body_rx,
            &tx,
            &request_id,
            crate::count_context::COUNT_CONTEXT_MAX_BODY_BYTES,
        ) {
            Ok(bytes) => bytes,
            Err(CollectError::Aborted) => return None,
            Err(CollectError::TooLarge) => {
                let _ = worker_send_control(
                    &tx,
                    &NodeFrame::RelayError {
                        request_id: request_id.clone(),
                        failure: RelayFailure::RequestTooLarge,
                        message: Some("request body exceeds its size limit".to_string()),
                        upstream_status_code: None,
                    },
                );
                return None;
            }
        };
        if cancellation.cancelled.load(Ordering::SeqCst) {
            return None;
        }
        let Some(method) = plan.method else {
            return Some(bytes);
        };
        let body = match crate::count_context::parse_count_context_body(&bytes) {
            Ok(body) => body,
            Err(error) => {
                let _ = worker_send_control(
                    &tx,
                    &NodeFrame::ContextCountError {
                        request_id: request_id.clone(),
                        failure: error.kind.relay_failure(),
                        message: Some(error.message),
                    },
                );
                return Some(bytes);
            }
        };
        let model = body
            .get("model")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let timeout = Duration::from_millis(COUNT_FIRST_TIMEOUT_MS.min(spec.timeout_ms).max(1));
        match crate::count_context::count_chat(
            &endpoint,
            &model,
            &body,
            Some(method),
            plan.adapter_count_route.as_deref(),
            timeout,
        ) {
            Ok(outcome) => {
                let _ = worker_send_control(
                    &tx,
                    &NodeFrame::ContextCountResult {
                        request_id: request_id.clone(),
                        tokens: outcome.tokens,
                        method: count_method(outcome.method),
                    },
                );
                if count_first_exceeds_ceiling(outcome.tokens, plan.count_ceiling) {
                    let _ = worker_send_control(
                        &tx,
                        &NodeFrame::RelayError {
                            request_id: request_id.clone(),
                            failure: RelayFailure::RequestTooLarge,
                            message: Some("prompt exceeds the context ceiling".to_string()),
                            upstream_status_code: None,
                        },
                    );
                    return None;
                }
            }
            Err(error) => {
                let _ = worker_send_control(
                    &tx,
                    &NodeFrame::ContextCountError {
                        request_id: request_id.clone(),
                        failure: error.kind.relay_failure(),
                        message: Some(error.message),
                    },
                );
            }
        }
        Some(bytes)
    })();
    if cancellation.cancelled.load(Ordering::SeqCst) {
        let _ = tx.send(FromWorker::Finished(request_id));
        return;
    }
    let Some(bytes) = proceed else {
        let _ = tx.send(FromWorker::Finished(request_id));
        return;
    };
    let mut spec = spec;
    // The buffered body is exactly what goes upstream.
    spec.body_bytes = Some(bytes.len() as u64);
    let (body_tx, body_rx) = mpsc::sync_channel(1);
    let _ = body_tx.send(BodyChunk {
        data: bytes,
        last: true,
    });
    drop(body_tx);
    run_upstream_worker(spec, Some(body_rx), tx, cancellation, cancellation_rx);
}

/// Run one upstream request on a worker thread: stream the request body (if any)
/// to the endpoint and stream the response back as relay frames.
fn run_upstream_worker(
    spec: UpstreamRequestSpec,
    body_rx: Option<Receiver<BodyChunk>>,
    tx: SyncSender<FromWorker>,
    cancellation: CancellationHandle,
    cancellation_rx: watch::Receiver<bool>,
) {
    let request_id = spec.request_id.clone();
    let result = upstream_runtime().and_then(|runtime| {
        runtime.block_on(execute_upstream(spec, body_rx, &tx, cancellation_rx))
    });
    if !cancellation.cancelled.load(Ordering::SeqCst)
        && let Err(error) = result
    {
        tracing::warn!(error = %error, "relay upstream request failed");
        let _ = worker_send_control(
            &tx,
            &NodeFrame::RelayError {
                request_id: request_id.clone(),
                failure: RelayFailure::Transport,
                message: Some("upstream request failed".to_string()),
                upstream_status_code: None,
            },
        );
    }
    let _ = tx.send(FromWorker::Finished(request_id));
}

async fn execute_upstream(
    spec: UpstreamRequestSpec,
    body_rx: Option<Receiver<BodyChunk>>,
    tx: &SyncSender<FromWorker>,
    mut cancellation_rx: watch::Receiver<bool>,
) -> Result<()> {
    let url = endpoint_url(&spec.base_url, &spec.path)?;
    let client = upstream_http_client()?;
    let method = reqwest::Method::from_bytes(spec.method.as_bytes())
        .context("parsing relay request method")?;
    let mut builder = client
        .request(method, url.as_str())
        .timeout(Duration::from_millis(spec.timeout_ms));
    // Only plain request metadata from the server reaches the engine: no
    // framing, hop-by-hop, Host, forwarding or credential headers (a
    // server-chosen Content-Length could smuggle a second request past the
    // allowlist on a kept-alive connection).
    let node_header_names: Vec<String> = spec
        .endpoint_headers
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect();
    for (name, value) in &spec.request_headers {
        let lower = name.to_ascii_lowercase();
        if !crate::runtimes::allowlist::request_header_allowed(&lower)
            || node_header_names.contains(&lower)
        {
            continue;
        }
        builder = builder.header(lower, value);
    }
    // The node's own credentials replace anything of the same name.
    let mut credentials = reqwest::header::HeaderMap::new();
    for (name, env) in &spec.endpoint_headers {
        let value = crate::secrets::credential(env)
            .with_context(|| format!("reading endpoint header `{name}` from `{env}`"))?;
        credentials.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .context("an endpoint header name is invalid")?,
            reqwest::header::HeaderValue::from_str(&value)
                .context("an endpoint header value is invalid")?,
        );
    }
    if let Some((mode, env)) = &spec.endpoint_auth {
        let value = crate::secrets::credential(env).context("reading typed endpoint credential")?;
        let (name, value) = match mode {
            EndpointAuthMode::ApiKey => {
                (reqwest::header::HeaderName::from_static("x-api-key"), value)
            }
            EndpointAuthMode::Bearer => (reqwest::header::AUTHORIZATION, format!("Bearer {value}")),
        };
        credentials.insert(
            name,
            reqwest::header::HeaderValue::from_str(&value)
                .context("the endpoint credential is not a valid header value")?,
        );
    }
    builder = builder.headers(credentials);

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
        if *cancellation_rx.borrow() {
            return Ok(());
        }
        let media_client = build_media_fetch_client()?;
        let mut fetched_media = BTreeMap::new();
        for target in trusted_media_urls_in_body(&raw, &spec.trusted_origins) {
            let fetched = match fetch_media(&media_client, &target, &mut cancellation_rx).await {
                Ok(Some(fetched)) => fetched,
                Ok(None) => return Ok(()),
                Err(error) => {
                    if *cancellation_rx.borrow() {
                        return Ok(());
                    }
                    send_media_error(tx, &spec.request_id, &error)?;
                    return Ok(());
                }
            };
            fetched_media.insert(target.to_string(), fetched);
        }
        if *cancellation_rx.borrow() {
            return Ok(());
        }
        let transformed = match expand_media_in_body(
            &raw,
            &spec.trusted_origins,
            &|target| {
                fetched_media
                    .get(target.as_str())
                    .cloned()
                    .ok_or_else(|| MediaExpandError::Fetch {
                        path: target.path().to_string(),
                        reason: "media fetch result unavailable".to_string(),
                    })
            },
            MEDIA_EXPAND_MAX_BODY_BYTES,
        ) {
            Ok(bytes) => bytes,
            Err(error) => {
                if *cancellation_rx.borrow() {
                    return Ok(());
                }
                send_media_error(tx, &spec.request_id, &error)?;
                return Ok(());
            }
        };
        if *cancellation_rx.borrow() {
            return Ok(());
        }
        builder.body(transformed)
    } else if spec.has_body {
        let rx = body_rx.context("missing request body channel for a body request")?;
        match spec.body_bytes {
            // hyper frames a body with an explicit Content-Length by that
            // length; the stream fails rather than send more or fewer bytes.
            Some(length) => {
                let body = streaming_request_body(
                    rx,
                    tx.clone(),
                    spec.request_id.clone(),
                    cancellation_rx.clone(),
                );
                builder
                    .header(reqwest::header::CONTENT_LENGTH, length)
                    .body(reqwest::Body::wrap_stream(exact_length_body(
                        Box::pin(body),
                        length,
                    )))
            }
            // No declared length: buffer up to a cap so the body still goes
            // with a Content-Length; only a larger body is sent chunked.
            None => {
                match buffer_body_prefix(&rx, tx, &spec.request_id, UNSIZED_BODY_BUFFER_BYTES) {
                    BufferedBody::Whole(raw) => builder.body(raw),
                    BufferedBody::Prefix(prefix) => {
                        let rest = streaming_request_body(
                            rx,
                            tx.clone(),
                            spec.request_id.clone(),
                            cancellation_rx.clone(),
                        );
                        builder.body(reqwest::Body::wrap_stream(PrefixedBody {
                            prefix: prefix.into(),
                            rest: Box::pin(rest),
                        }))
                    }
                    BufferedBody::Aborted => return Ok(()),
                }
            }
        }
    } else {
        builder
    };
    tokio::select! {
        _ = cancellation_rx.changed() => Ok(()),
        response = response.send() => {
            let response = response.context("forwarding relay request to upstream endpoint")?;
            relay_response_back(response, &spec, tx, &mut cancellation_rx).await
        }
    }
}

/// Stream an upstream HTTP response back to the server as relay frames.
async fn relay_response_back(
    response: reqwest::Response,
    spec: &UpstreamRequestSpec,
    tx: &SyncSender<FromWorker>,
    cancellation_rx: &mut watch::Receiver<bool>,
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
        .collect::<Vec<_>>();
    worker_send_control(
        tx,
        &NodeFrame::RelayResponseHeaders {
            request_id: spec.request_id.clone(),
            status,
            headers,
        },
    )?;

    let mut response = response;
    let mut usage_tail = Vec::new();
    let mut completion_text = CompletionTextCollector::default();
    let mut index = 0_usize;
    loop {
        let bytes = tokio::select! {
            _ = cancellation_rx.changed() => return Ok(()),
            bytes = response.chunk() => bytes.context("reading upstream response body")?,
        };
        let Some(bytes) = bytes else { break };
        append_usage_tail(&mut usage_tail, &bytes);
        completion_text.feed(&bytes);
        relay_response_chunk(tx, &spec.request_id, &bytes, &mut index)?;
    }
    let metadata = NodeBinaryMetadata::RelayResponseBody {
        request_id: spec.request_id.clone(),
        chunk_id: index.to_string(),
        is_final: Some(true),
    };
    worker_send_binary(tx, &metadata, &[])?;
    // Preserve provider usage while attaching separate `cl100k_base` metrics
    // for comparable cross-model Chat Test TPS. A bounded collector returns
    // `None` rather than retaining a huge response.
    let usage = terminal_usage_from_response(&usage_tail);
    let metrics = standardized_completion_metrics(completion_text.finish().as_deref());
    worker_send_control(
        tx,
        &NodeFrame::RelayComplete {
            request_id: spec.request_id.clone(),
            usage,
            metrics,
        },
    )?;
    Ok(())
}

fn append_usage_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.len() >= RELAY_USAGE_TAIL_MAX_BYTES {
        tail.clear();
        tail.extend_from_slice(&chunk[chunk.len() - RELAY_USAGE_TAIL_MAX_BYTES..]);
        return;
    }
    let excess = tail
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(RELAY_USAGE_TAIL_MAX_BYTES);
    if excess > 0 {
        tail.drain(..excess);
    }
    tail.extend_from_slice(chunk);
}

/// The engine tokenize route this endpoint's last probe found.
fn endpoint_count_method(
    endpoint: &crate::config::EndpointConfig,
) -> Option<crate::count_context::CountContextMethod> {
    endpoint
        .last_probe
        .as_ref()
        .and_then(|probe| probe.engine.as_ref())
        .and_then(|engine| engine.count_context)
        .and_then(crate::count_context::CountContextFact::method)
}

/// The wire name of a count method (`AdapterCount` is a reader count).
fn count_method(method: crate::count_context::CountContextMethod) -> CountMethod {
    use crate::count_context::CountContextMethod as Local;
    match method {
        Local::VllmTokenize => CountMethod::VllmTokenize,
        Local::TgiChatTokenize => CountMethod::TgiChatTokenize,
        Local::LlamaApplyTemplate => CountMethod::LlamaApplyTemplate,
        Local::LlamaInputTokens => CountMethod::LlamaInputTokens,
        Local::AdapterCount => CountMethod::ReaderCount,
    }
}

/// Usage as an OpenAI-compatible upstream reports it (snake_case, with
/// extra fields the relay ignores).
#[derive(serde::Deserialize)]
struct UpstreamUsage {
    #[serde(default, alias = "promptTokens")]
    prompt_tokens: Option<u64>,
    #[serde(default, alias = "completionTokens")]
    completion_tokens: Option<u64>,
    #[serde(default, alias = "totalTokens")]
    total_tokens: Option<u64>,
}

impl From<UpstreamUsage> for RelayUsage {
    fn from(usage: UpstreamUsage) -> Self {
        Self {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
        }
    }
}

/// Extract upstream-provided terminal usage from either a JSON completion or
/// the final OpenAI SSE `data:` event. Shared-tokenizer accounting is separate
/// from usage and happens in [`standardized_completion_metrics`].
fn terminal_usage_from_response(bytes: &[u8]) -> Option<RelayUsage> {
    #[derive(serde::Deserialize)]
    struct Completion {
        usage: Option<UpstreamUsage>,
    }

    serde_json::from_slice::<Completion>(bytes)
        .ok()
        .and_then(|completion| completion.usage)
        .map(RelayUsage::from)
        .or_else(|| terminal_usage_from_json_tail(bytes))
        .or_else(|| {
            std::str::from_utf8(bytes).ok().and_then(|body| {
                body.lines()
                    .filter_map(|line| {
                        line.strip_prefix("data: ")
                            .filter(|data| *data != "[DONE]")
                            .and_then(|data| serde_json::from_str::<Completion>(data).ok())
                            .and_then(|completion| completion.usage)
                    })
                    .next_back()
                    .map(RelayUsage::from)
            })
        })
}

/// Parse a complete `usage` object from a bounded trailing window of a large
/// non-stream JSON response. Unlike deserializing the whole tail, this remains
/// valid when the beginning of the document was intentionally discarded.
fn terminal_usage_from_json_tail(bytes: &[u8]) -> Option<RelayUsage> {
    const USAGE_KEY: &[u8] = b"\"usage\"";
    bytes
        .windows(USAGE_KEY.len())
        .enumerate()
        .rev()
        .filter_map(|(index, window)| (window == USAGE_KEY).then_some(index + USAGE_KEY.len()))
        .find_map(|after_key| {
            let mut index = after_key;
            while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
            }
            if bytes.get(index) != Some(&b':') {
                return None;
            }
            index += 1;
            while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
            }
            let end = json_object_end(bytes, index)?;
            serde_json::from_slice::<UpstreamUsage>(&bytes[index..end])
                .ok()
                .map(RelayUsage::from)
        })
}

fn worker_send_control(tx: &SyncSender<FromWorker>, message: &NodeFrame) -> Result<()> {
    let request_id = match message {
        NodeFrame::RelayRequestBodyAck { request_id, .. }
        | NodeFrame::RelayResponseHeaders { request_id, .. }
        | NodeFrame::RelayComplete { request_id, .. }
        | NodeFrame::RelayError { request_id, .. }
        | NodeFrame::RelayCancelled { request_id }
        | NodeFrame::ContextCountResult { request_id, .. }
        | NodeFrame::ContextCountError { request_id, .. } => request_id.clone(),
        _ => anyhow::bail!("worker emitted non-request relay control"),
    };
    let text = encode_control(message)?;
    tx.send(FromWorker::Send {
        request_id,
        frame: WsFrame::Text(text),
    })
    .map_err(|_| anyhow::anyhow!("relay outbound channel closed"))
}

fn worker_send_binary(
    tx: &SyncSender<FromWorker>,
    metadata: &NodeBinaryMetadata,
    body: &[u8],
) -> Result<()> {
    let NodeBinaryMetadata::RelayResponseBody { request_id, .. } = metadata else {
        anyhow::bail!("worker emitted a non-request binary frame");
    };
    let frame = encode_binary_frame(metadata, body)?;
    tx.send(FromWorker::Send {
        request_id: request_id.clone(),
        frame: WsFrame::Binary(frame),
    })
    .map_err(|_| anyhow::anyhow!("relay outbound channel closed"))
}

/// Return the exclusive end of a JSON object starting at `start`, respecting
/// nested objects/arrays and quoted escape sequences.
fn json_object_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'{') {
        return None;
    }
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'\"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'\"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(start + offset + 1);
                }
            }
            _ => {}
        }
    }
    None
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

/// The most a body without a declared length is buffered to send it with a
/// Content-Length (the server's JSON body cap).
const UNSIZED_BODY_BUFFER_BYTES: usize = 32 * 1024 * 1024;

/// A body read up to a cap: whole, or the chunks read before the cap.
enum BufferedBody {
    Whole(Vec<u8>),
    Prefix(Vec<Vec<u8>>),
    Aborted,
}

/// Read body chunks (one credit each, as the streaming reader returns them)
/// until the final chunk or until more than `max_bytes` arrived.
fn buffer_body_prefix(
    rx: &Receiver<BodyChunk>,
    tx: &SyncSender<FromWorker>,
    request_id: &str,
    max_bytes: usize,
) -> BufferedBody {
    let mut chunks = Vec::new();
    let mut total = 0_usize;
    loop {
        let Ok(BodyChunk { data, last }) = rx.recv() else {
            return BufferedBody::Aborted;
        };
        if !send_body_credit(tx, request_id) {
            return BufferedBody::Aborted;
        }
        total = total.saturating_add(data.len());
        chunks.push(data);
        if last {
            return BufferedBody::Whole(chunks.concat());
        }
        if total > max_bytes {
            return BufferedBody::Prefix(chunks);
        }
    }
}

/// Chunks already read, then the rest of the streamed body.
struct PrefixedBody<S> {
    prefix: std::collections::VecDeque<Vec<u8>>,
    rest: S,
}

impl<S> Stream for PrefixedBody<S>
where
    S: Stream<Item = std::result::Result<Vec<u8>, io::Error>> + Unpin,
{
    type Item = std::result::Result<Vec<u8>, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if let Some(chunk) = self.prefix.pop_front() {
            return std::task::Poll::Ready(Some(Ok(chunk)));
        }
        std::pin::Pin::new(&mut self.rest).poll_next(cx)
    }
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
    let ack = NodeFrame::RelayRequestBodyAck {
        request_id: request_id.to_string(),
        credits: 1,
    };
    match encode_control(&ack) {
        Ok(text) => tx
            .send(FromWorker::Send {
                request_id: request_id.to_string(),
                frame: WsFrame::Text(text),
            })
            .is_ok(),
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
        &NodeFrame::RelayError {
            request_id: request_id.to_string(),
            failure: error.relay_failure(),
            message: Some(error.message()),
            upstream_status_code,
        },
    )
}

/// Build the dedicated client used to fetch WMP media URLs during expansion.
///
/// Follows NO redirects: the trusted-origin check happens before the fetch, so a
/// trusted (or compromised) WMP server must not be able to 30x-redirect the CLI
/// to an arbitrary internal URL after the check. A no-redirect policy leaves a
/// 3xx response visible to `fetch_media` as a `Status` error rather than chasing
/// its `Location` header.
fn build_media_fetch_client() -> Result<reqwest::Client> {
    crate::tls::install_crypto_provider();
    reqwest::Client::builder()
        .timeout(RELAY_MEDIA_FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("building cancellable media fetch client")
}

/// Fetch a single WMP media URL. Reads at most `MEDIA_EXPAND_MAX_ASSET_BYTES`
/// (a tighter per-asset cap than the whole-body ceiling so one asset cannot eat
/// the entire budget) and reports failures with the URL path only (never the
/// signature). `None` means cancellation was observed; the selected reqwest
/// future is dropped immediately, closing any in-flight connection while DNS,
/// connect, header wait, or body read is pending.
async fn fetch_media(
    client: &reqwest::Client,
    url: &Url,
    cancellation_rx: &mut watch::Receiver<bool>,
) -> std::result::Result<Option<FetchedMedia>, MediaExpandError> {
    if *cancellation_rx.borrow() {
        return Ok(None);
    }
    let path = url.path().to_string();
    let Some(response) = await_or_cancel(cancellation_rx, client.get(url.as_str()).send()).await
    else {
        return Ok(None);
    };
    let response = response.map_err(|error| MediaExpandError::Fetch {
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
    let cap = MEDIA_EXPAND_MAX_ASSET_BYTES;
    let mut response = response;
    let mut bytes = Vec::new();
    loop {
        let Some(chunk) = await_or_cancel(cancellation_rx, response.chunk()).await else {
            return Ok(None);
        };
        let chunk = chunk.map_err(|error| MediaExpandError::Fetch {
            path: path.clone(),
            reason: media_fetch_reason(&error),
        })?;
        let Some(chunk) = chunk else { break };
        if bytes.len().saturating_add(chunk.len()) > cap {
            return Err(MediaExpandError::AssetTooLarge { path });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(FetchedMedia {
        content_type,
        bytes,
    }))
}

/// Await one media transport operation unless the relay request is cancelled.
/// Dropping `operation` on the cancellation branch aborts reqwest's pending
/// connect/header/body-read future and tears down its connection.
async fn await_or_cancel<T>(
    cancellation_rx: &mut watch::Receiver<bool>,
    operation: impl Future<Output = T>,
) -> Option<T> {
    if *cancellation_rx.borrow() {
        return None;
    }
    tokio::select! {
        _ = cancellation_rx.changed() => None,
        value = operation => Some(value),
    }
}

/// A concise failure reason for a media fetch that never includes the request
/// URI (and therefore never the `sig` query parameter).
fn media_fetch_reason(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "request timed out".to_string()
    } else if error.is_connect() {
        "connection failed".to_string()
    } else if error.is_request() {
        "request failed".to_string()
    } else if error.is_body() {
        "reading response body failed".to_string()
    } else {
        "request failed".to_string()
    }
}

/// Encode an upstream transport chunk as one or more bounded relay frames.
fn relay_response_chunk(
    tx: &SyncSender<FromWorker>,
    request_id: &str,
    bytes: &[u8],
    index: &mut usize,
) -> Result<()> {
    // A reqwest chunk is not bounded by the relay frame limit. Preserve the
    // response while splitting it into protocol-valid binary frames.
    for chunk in bytes.chunks(crate::protocol::RELAY_BINARY_CHUNK_MAX_BYTES) {
        let metadata = NodeBinaryMetadata::RelayResponseBody {
            request_id: request_id.to_string(),
            chunk_id: index.to_string(),
            is_final: None,
        };
        worker_send_binary(tx, &metadata, chunk)?;
        *index += 1;
    }
    Ok(())
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
        &NodeFrame::RelayError {
            request_id: request_id.to_string(),
            failure,
            message,
            upstream_status_code,
        },
        "sending relay error",
    )?;
    Ok(())
}

#[cfg(unix)]
fn send_file_frames<S>(
    socket: &mut tungstenite::WebSocket<S>,
    frames: Vec<crate::file_relay::FileFrame>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    use crate::file_relay::FileFrame;
    for frame in frames {
        match frame {
            FileFrame::Control(message) => {
                send_control(socket, &message, "sending a file op frame")?;
            }
            FileFrame::Binary(metadata, body) => {
                let encoded =
                    encode_binary_frame(&metadata, &body).map_err(RelaySessionError::Fatal)?;
                socket
                    .send(Message::Binary(encoded.into()))
                    .map_err(|error| {
                        websocket_session_error(error, "sending a file op frame", true)
                    })?;
            }
        }
    }
    Ok(())
}

fn send_outbound_frames<S>(
    socket: &mut tungstenite::WebSocket<S>,
    frames: Vec<OutboundFrame>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    for frame in frames {
        match frame {
            OutboundFrame::Control(message) => {
                send_control(socket, &message, "sending terminal or exec frame")?;
            }
            OutboundFrame::Binary(metadata, body) => {
                let encoded =
                    encode_binary_frame(&metadata, &body).map_err(RelaySessionError::Fatal)?;
                socket
                    .send(Message::Binary(encoded.into()))
                    .map_err(|error| {
                        websocket_session_error(error, "sending terminal or exec frame", true)
                    })?;
            }
        }
    }
    Ok(())
}

fn old_server_upgrade_error() -> RelaySessionError {
    RelaySessionError::Fatal(anyhow::anyhow!(
        "the server did not complete the relay handshake for protocol {RELAY_PROTOCOL_VERSION}; upgrade the WS Model Proxy server"
    ))
}

/// Refuses to sign a hello origin other than the one this CLI trusts.
///
/// The signature binds the origin so it cannot be replayed to another server.
/// Signing whatever origin the challenge names would let a relay or a
/// wrong-URL server that already holds the bearer credential forward a valid
/// signature to the real server. So the origin must be `expected`: the public
/// origin a person pinned on this machine, else the server URL's origin
/// ([`Config::hello_origin`]). The server never chooses it.
fn check_hello_origin(
    challenge_origin: &str,
    expected: &str,
    server_url: &str,
) -> RelaySessionResult<()> {
    if challenge_origin == expected {
        return Ok(());
    }
    let shown = crate::display_escape::escape_single_line(challenge_origin);
    // Suggest the pin only for a value that is itself a valid public origin,
    // with both arguments quoted for this platform's shell.
    let fix = crate::config::set_server_command(server_url, challenge_origin)
        .map(|command| {
            format!(
                " If `{shown}` is your server's public address, run `{}` and restart wsmp; \
                 no new login is needed.",
                crate::display_escape::escape_single_line(&command)
            )
        })
        .unwrap_or_else(|| {
            " Check the server URL and public origin with `wsmp config show`.".to_string()
        });
    Err(RelaySessionError::Fatal(anyhow::anyhow!(
        "server hello names origin `{shown}`, but this CLI signs only `{expected}`; \
         refusing to sign it.{fix}"
    )))
}

/// A reply to the hello wait that strict 3.0 parsing refused, read loosely:
/// an older server sends `protocol.error` without a code, or a challenge
/// without an origin. Both mean "upgrade the server".
fn older_server_reply(text: &str) -> Option<RelaySessionError> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    match value.get("type").and_then(serde_json::Value::as_str)? {
        "protocol.error" => {
            let message = value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("protocol error");
            Some(RelaySessionError::Fatal(anyhow::anyhow!(
                hello_rejection_message(message, None)
            )))
        }
        "hello.challenge" => Some(old_server_upgrade_error()),
        _ => None,
    }
}

fn wait_for_hello_challenge<S>(
    socket: &mut tungstenite::WebSocket<S>,
) -> RelaySessionResult<(String, String)>
where
    S: std::io::Read + std::io::Write,
{
    let deadline = Instant::now() + HELLO_CHALLENGE_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err(old_server_upgrade_error());
        }
        if let Some(signal) = crate::shutdown::requested() {
            return Err(RelaySessionError::Shutdown(signal));
        }
        match socket.read() {
            Ok(Message::Text(text)) => match parse_server_control(&text) {
                Ok(ServerFrame::HelloChallenge { nonce, origin }) => {
                    if origin.is_empty() {
                        return Err(old_server_upgrade_error());
                    }
                    return Ok((nonce, origin));
                }
                Ok(ServerFrame::ProtocolError { message, code, .. }) => {
                    if code == ProtocolErrorCode::Internal {
                        return Err(RelaySessionError::Reconnectable {
                            error: anyhow::anyhow!("relay protocol error: {message}"),
                            reset_backoff: false,
                        });
                    }
                    return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                        hello_rejection_message(&message, Some(&code))
                    )));
                }
                Ok(_) => {
                    return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                        "expected hello.challenge, received another control frame"
                    )));
                }
                Err(error) => {
                    if let Some(refusal) = older_server_reply(&text) {
                        return Err(refusal);
                    }
                    return Err(RelaySessionError::Reconnectable {
                        error: anyhow::anyhow!("invalid hello.challenge frame: {error}"),
                        reset_backoff: false,
                    });
                }
            },
            Ok(Message::Ping(bytes)) => {
                socket
                    .send(Message::Pong(bytes))
                    .map_err(|error| websocket_session_error(error, "sending relay pong", true))?;
            }
            Ok(Message::Pong(_) | Message::Frame(_)) => {}
            Ok(Message::Binary(_)) => {
                return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                    "unexpected binary frame before hello"
                )));
            }
            Ok(Message::Close(frame)) => {
                tracing::warn!(?frame, "relay websocket closed by server before hello");
                return Err(RelaySessionError::Reconnectable {
                    error: anyhow::anyhow!("relay websocket closed before hello.challenge"),
                    reset_backoff: false,
                });
            }
            Err(tungstenite::Error::Io(err)) if read_poll_woke(&err) => {}
            Err(err) => {
                return Err(websocket_session_error(
                    err,
                    "reading hello.challenge",
                    true,
                ));
            }
        }
    }
}

fn send_control<S>(
    socket: &mut tungstenite::WebSocket<S>,
    message: &NodeFrame,
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

/// Set by the systemd unit `wsmp service install` writes, which also lists
/// exit 4 in `RestartPreventExitStatus=`: there, stopping on an unusable
/// credential cannot turn into a restart loop.
pub const STOP_ON_REJECTED_CREDENTIAL_ENV: &str = "WSMP_STOP_ON_REJECTED_CREDENTIAL";

/// Whether a missing or rejected credential stops the relay (exit 4) rather
/// than being retried in-process with the normal backoff (capped at 5 min).
/// It stops under the systemd unit (which does not restart on exit 4) and in
/// an interactive terminal (where a person sees the message). Elsewhere, such
/// as a macOS LaunchAgent (`KeepAlive` relaunches every exit) or a detached
/// daemon, exiting would only restart or lose the relay, so it keeps retrying
/// and picks up a new `wsmp login` by itself.
fn stop_on_unusable_credential() -> bool {
    use std::io::IsTerminal;
    std::env::var_os(STOP_ON_REJECTED_CREDENTIAL_ENV).is_some_and(|value| value == "1")
        || std::io::stderr().is_terminal()
}

/// Classify a failed relay websocket handshake. A 401 means the server
/// rejected the credential (revoked, replaced by a newer login, invalid, or
/// temporarily banned); with `stop` it is fatal and asks for `wsmp login`,
/// otherwise it is retried with backoff. Everything else, including a 403
/// from a proxy or firewall in front of the server, 429 and 5xx, reconnects.
fn relay_connect_error(error: tungstenite::Error, stop: bool) -> RelaySessionError {
    if let tungstenite::Error::Http(response) = &error
        && response.status().as_u16() == 401
    {
        let rejected = anyhow::anyhow!(
            "the server rejected this machine's relay credential (HTTP 401); it is revoked or invalid. Run `wsmp login` to sign in again"
        );
        return if stop {
            RelaySessionError::Fatal(rejected.context(crate::exit::CodedError::new(
                crate::exit::ExitCode::CredentialRejected,
            )))
        } else {
            RelaySessionError::Reconnectable {
                error: rejected,
                reset_backoff: false,
            }
        };
    }
    RelaySessionError::Reconnectable {
        error: anyhow::Error::new(error).context("opening relay websocket"),
        reset_backoff: false,
    }
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

/// A relay socket read that returned without data and can simply be retried:
/// the poll timeout set by [`set_socket_timeouts`], or a shutdown signal
/// that landed on this thread (`EINTR`; a socket timeout keeps the read from
/// restarting). The loop then checks for shutdown as after a timeout.
fn read_poll_woke(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

fn set_socket_timeouts(
    stream: &mut tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
    read_timeout: Duration,
    write_timeout: Duration,
) -> Result<()> {
    let tcp = match stream {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => Some(stream),
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => Some(&mut stream.sock),
        _ => None,
    };
    let tcp = tcp.context("unsupported websocket transport timeout configuration")?;
    tcp.set_read_timeout(Some(read_timeout))
        .context("setting websocket read timeout")?;
    tcp.set_write_timeout(Some(write_timeout))
        .context("setting websocket write timeout")?;
    Ok(())
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

/// The upstream URL for `request_path` on a runtime at `base_url` (§4.8):
/// API paths (`/v1/...`) join onto the base URL, whose API prefix replaces the
/// leading `/v1`; engine routes (readiness, metrics reader, count route) join
/// onto the origin. The result must stay on the base URL's origin.
pub(crate) fn endpoint_url(base_url: &str, request_path: &str) -> Result<Url> {
    let base =
        Url::parse(base_url).with_context(|| format!("parsing endpoint URL `{base_url}`"))?;
    anyhow::ensure!(
        crate::runtimes::allowlist::path_is_plain(request_path),
        "the request path is not a plain path"
    );
    let prefix = base.path().trim_end_matches('/');
    let path = match request_path.strip_prefix("/v1") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            // No prefix: keep `/v1`. A prefix replaces it.
            if prefix.is_empty() {
                request_path.to_string()
            } else {
                format!("{prefix}{rest}")
            }
        }
        _ => request_path.to_string(),
    };
    let mut url = base.clone();
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    anyhow::ensure!(
        url.origin() == base.origin() && url.path() == path,
        "the request path leaves the runtime's address"
    );
    Ok(url)
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
    use std::io::Write;

    // Unix only: Windows `shutdown` does not interrupt a blocked send (see
    // `PublicationWatchdog`).
    fn drain_acks(rx: &Receiver<FromWorker>) -> Vec<String> {
        let mut acks = Vec::new();
        while let Ok(message) = rx.try_recv() {
            if let FromWorker::Send {
                frame: WsFrame::Text(text),
                ..
            } = message
            {
                acks.push(text);
            }
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
    fn ingress_accepts_the_full_advertised_credit_burst_before_worker_runs() {
        let (body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(REQUEST_BODY_INGRESS_CAPACITY);
        for index in 0..RELAY_REQUEST_BODY_WINDOW_CHUNKS {
            assert!(matches!(
                deliver_body_chunk(&body_tx, vec![index as u8], false),
                BodyRoute::Delivered
            ));
        }
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![255], true),
            BodyRoute::OverCredit
        ));
        drop(body_rx);
    }

    #[test]
    fn oversized_upstream_chunk_is_split_into_protocol_sized_binary_frames() {
        let payload = vec![7_u8; crate::protocol::RELAY_BINARY_CHUNK_MAX_BYTES * 2 + 17];
        let (tx, rx) = mpsc::sync_channel::<FromWorker>(4);
        let mut index = 0;

        relay_response_chunk(&tx, "request-1", &payload, &mut index).expect("split response chunk");

        assert_eq!(index, 3);
        let frames = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(frames.len(), 3);
        let mut rebuilt = Vec::new();
        for (expected_index, frame) in frames.into_iter().enumerate() {
            let FromWorker::Send {
                frame: WsFrame::Binary(encoded),
                ..
            } = frame
            else {
                panic!("expected binary response frame");
            };
            let (metadata, body) =
                decode_binary_frame::<NodeBinaryMetadata>(&encoded).expect("parse bounded frame");
            let NodeBinaryMetadata::RelayResponseBody { chunk_id, .. } = metadata else {
                panic!("expected a response body frame");
            };
            assert_eq!(chunk_id, expected_index.to_string());
            assert!(body.len() <= crate::protocol::RELAY_BINARY_CHUNK_MAX_BYTES);
            rebuilt.extend(body);
        }
        assert_eq!(rebuilt, payload);
    }

    #[test]
    fn cancellation_is_idempotent_and_notifies_the_async_transport_once() {
        let (cancellation, mut receiver) = CancellationHandle::new();
        assert!(cancellation.cancel());
        assert!(
            !cancellation.cancel(),
            "duplicate relay.cancel must be inert"
        );
        assert!(cancellation.cancelled.load(Ordering::SeqCst));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            receiver.changed().await.expect("cancellation notification");
            assert!(*receiver.borrow());
            assert!(
                tokio::time::timeout(Duration::from_millis(5), receiver.changed())
                    .await
                    .is_err(),
                "duplicate cancellation must not notify twice"
            );
        });
    }

    #[test]
    fn cancelled_worker_suppresses_queued_late_frames() {
        let (cancellation, _receiver) = CancellationHandle::new();
        let mut workers = BTreeMap::new();
        workers.insert(
            "request-1".to_string(),
            WorkerHandle {
                body_tx: None,
                cancellation,
                join: thread::spawn(|| {}),
            },
        );
        assert!(worker_frame_is_current(&workers, "request-1"));
        let worker = workers.remove("request-1").expect("live worker");
        assert!(worker.cancellation.cancel());
        drop(worker.join);
        assert!(!worker_frame_is_current(&workers, "request-1"));
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

    /// Collects `tracing` output for tests (an in-memory writer).
    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuf {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Ok(mut inner) = self.0.lock() {
                inner.extend_from_slice(bytes);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = LogBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
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

    fn challenge_socket(message: Message) -> tungstenite::WebSocket<io::Cursor<Vec<u8>>> {
        let mut server = sink_socket();
        server.send(message).unwrap();
        tungstenite::WebSocket::from_raw_socket(
            io::Cursor::new(server.get_ref().written.clone()),
            tungstenite::protocol::Role::Client,
            None,
        )
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
            reset_backoff: true,
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

    #[test]
    fn hello_challenge_transient_close_and_parse_failure_reconnect() {
        for message in [Message::Close(None), Message::Text("{garbled".into())] {
            let mut socket = challenge_socket(message);
            assert!(matches!(
                wait_for_hello_challenge(&mut socket),
                Err(RelaySessionError::Reconnectable {
                    reset_backoff: false,
                    ..
                })
            ));
        }
    }

    #[test]
    fn hello_challenge_keeps_coded_internal_retryable_and_old_server_actionable() {
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"protocol.error","failure":"protocol_error","message":"database unavailable","code":"internal","supportedVersions":["3.0"]}"#
                .into(),
        ));
        assert!(matches!(
            wait_for_hello_challenge(&mut socket),
            Err(RelaySessionError::Reconnectable {
                reset_backoff: false,
                ..
            })
        ));
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"protocol.error","failure":"protocol_error","message":"Registration was not received in time."}"#
                .into(),
        ));
        match wait_for_hello_challenge(&mut socket) {
            Err(RelaySessionError::Fatal(error)) => assert!(
                error
                    .to_string()
                    .contains("upgrade the WS Model Proxy server")
            ),
            _ => panic!("expected actionable old server refusal"),
        }
    }

    #[test]
    fn hello_challenge_requires_origin_and_accepts_current_server() {
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"hello.challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAA"}"#.into(),
        ));
        assert!(matches!(
            wait_for_hello_challenge(&mut socket),
            Err(RelaySessionError::Fatal(_))
        ));
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"hello.challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAA","origin":"https://example.test"}"#.into()));
        assert_eq!(
            wait_for_hello_challenge(&mut socket).ok().unwrap(),
            (
                "AAAAAAAAAAAAAAAAAAAAAA".to_string(),
                "https://example.test".to_string()
            )
        );
    }

    fn config_with(server_url: &str, public_origin: Option<&str>) -> Config {
        Config {
            server_url: Some(server_url.to_string()),
            public_origin: public_origin.map(str::to_string),
            ..Config::default()
        }
    }

    fn refusal(origin: &str, config: &Config) -> String {
        let expected = config.hello_origin().expect("hello origin");
        let server_url = config.server_url.as_deref().expect("server URL");
        match check_hello_origin(origin, &expected, server_url) {
            Err(RelaySessionError::Fatal(error)) => error.to_string(),
            _ => panic!("{origin:?} must be refused as fatal"),
        }
    }

    #[test]
    fn hello_origin_defaults_to_the_server_url_origin() {
        for (server_url, origin) in [
            (
                "https://proxy.example.com/base/",
                "https://proxy.example.com",
            ),
            ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
            ("https://proxy.example.com:443", "https://proxy.example.com"),
            // An http LAN URL with no pin keeps working as before.
            ("http://10.0.0.5:3000", "http://10.0.0.5:3000"),
        ] {
            let config = config_with(server_url, None);
            assert_eq!(config.hello_origin().unwrap(), origin);
            assert!(check_hello_origin(origin, origin, server_url).is_ok());
        }

        let config = config_with("https://proxy.example.com", None);
        for origin in [
            "https://other.example.com",
            "http://proxy.example.com",
            "https://proxy.example.com:8443",
            "https://proxy.example.com/",
            "https://PROXY.example.com",
            "null",
        ] {
            assert!(refusal(origin, &config).contains("refusing to sign"));
        }
    }

    #[test]
    fn a_pinned_public_origin_is_the_only_origin_signed() {
        // Connect over the LAN, sign the public origin.
        let config = config_with("http://10.0.0.5:3000", Some("https://wsmp.example.com"));
        assert_eq!(config.hello_origin().unwrap(), "https://wsmp.example.com");
        assert!(
            check_hello_origin(
                "https://wsmp.example.com",
                "https://wsmp.example.com",
                "http://10.0.0.5:3000"
            )
            .is_ok()
        );
        // The connect address itself is no longer signed once a pin exists.
        let error = refusal("http://10.0.0.5:3000", &config);
        assert!(
            error.contains("signs only `https://wsmp.example.com`"),
            "{error}"
        );
    }

    #[test]
    fn hello_origin_refusal_names_the_exact_fix() {
        let config = config_with("http://10.0.0.5:3000", None);
        let error = refusal("https://wsmp.example.com", &config);
        assert!(
            error.contains(
                "run `wsmp config set-server 'http://10.0.0.5:3000' --public-origin 'https://wsmp.example.com'` and restart wsmp; no new login is needed"
            ),
            "{error}"
        );
        // A plain-http LAN origin can be pinned too.
        let error = refusal("http://wsmp.lan:3000", &config);
        assert!(
            error.contains("--public-origin 'http://wsmp.lan:3000'"),
            "{error}"
        );
        // A host the URL parser accepts but a shell would run gets no command,
        // and terminal control characters are shown escaped.
        for hostile in [
            "https://a$({touch,pwned}).com",
            "https://a`id`.com",
            "https://a;id.com",
            "https://a&calc.com",
            "http://evil.example\u{1b}]8;;x\u{7}",
        ] {
            let error = refusal(hostile, &config);
            assert!(!error.contains("--public-origin"), "{error}");
            assert!(!error.contains("set-server"), "{error}");
            assert!(!error.chars().any(|ch| ch.is_control()), "{error}");
        }
    }

    /// A malformed `exec.start` / `term.spawn` names a command but cannot be
    /// read as a request, so it never reaches a registry. The daemon still
    /// owes that command its one outcome line (AC 8): without the explicit
    /// log here, a refused command would leave no CLI-side record at all.
    #[test]
    fn malformed_command_requests_log_one_rejection_each() {
        let _capture = crate::logging::test_capture_lock();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let (tx, _rx) = mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
            let mut terminals = TerminalRegistry::new(tx);
            let (exec_tx, _exec_rx) =
                mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
            let mut execs = ExecRegistry::new(exec_tx, DEFAULT_COMMAND_MAX);
            let error = anyhow::anyhow!("malformed relay frame");
            // The frame names a command but its command string is NUL-bearing
            // (and it lacks `timeoutMs`): `control_frame_fault` attributes it
            // and `apply_frame_fault` refuses it without reaching a registry.
            let frame = r#"{"type":"exec.start","commandId":"cmd-exec-9f3a","command":"x\u0000y"}"#;
            {
                let mut socket = sink_socket();
                let fault = crate::protocol::control_frame_fault(frame);
                assert!(
                    apply_frame_fault(&mut socket, fault, &mut terminals, &mut execs, &error)
                        .is_ok(),
                    "a refused command is not fatal"
                );
                assert!(
                    !socket.get_ref().written.is_empty(),
                    "the refusal frame is written back"
                );
            }
        });
        let log = String::from_utf8(buf.0.lock().map(|b| b.clone()).unwrap_or_default())
            .unwrap_or_default();
        // Count only the outcome lines: the `warn!` above also names the id.
        let outcomes = |command_id: &str| {
            log.lines()
                .filter(|line| line.contains("command operation") && line.contains(command_id))
                .count()
        };
        assert_eq!(outcomes("cmd-exec-9f3a"), 1, "{log}");
        assert!(log.contains("rejected:bad_command"), "{log}");
        assert!(
            !log.contains("x\\u0000y") && !log.contains("x\u{0}"),
            "the command text leaked: {log}"
        );
    }

    #[test]
    fn a_refused_stt_frame_ends_only_its_session_and_never_the_relay() {
        let session = "AAECAwQFBgcICQoLDA0ODw";
        let (tx, _rx) = mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
        let mut stt = crate::stt::SttRegistry::new(tx);
        let mut socket = sink_socket();
        // A transcript over the wire limit: the encoder refuses it, the
        // session gets one stt.error, and the relay goes on.
        let oversized = NodeFrame::SttEvent {
            session_id: session.to_string(),
            event: crate::stt_wire::SttEvent::Delta {
                item_seq: 0,
                text: "secret ".repeat(4_000),
            },
        };
        assert!(send_stt(&mut socket, &mut stt, oversized).is_ok());
        let written = String::from_utf8_lossy(&socket.get_ref().written).to_string();
        assert!(written.contains("stt.error") && written.contains("protocol_error"));
        assert!(
            !written.contains("secret"),
            "the refused text never goes out"
        );

        // A malformed open that names its session is refused by name, not fatally.
        let mut socket = sink_socket();
        let other = "AQIDBAUGBwgJCgsMDQ4PEA";
        let malformed = format!(r#"{{"type":"stt.open","sessionId":"{other}"}}"#);
        let fault = crate::protocol::control_frame_fault(&malformed);
        let outcome = apply_stt_fault(&mut socket, &mut stt, &fault).expect("an stt fault");
        assert!(outcome.is_ok());
        let written = String::from_utf8_lossy(&socket.get_ref().written).to_string();
        assert!(written.contains("stt.error") && written.contains(other));
        // A malformed frame for a session that is not live sends nothing.
        let mut socket = sink_socket();
        let commit = format!(r#"{{"type":"stt.commit","sessionId":"{session}","itemSeq":-1}}"#);
        let fault = crate::protocol::control_frame_fault(&commit);
        assert!(apply_stt_fault(&mut socket, &mut stt, &fault).is_some_and(|r| r.is_ok()));
        assert!(socket.get_ref().written.is_empty());
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
        let (cancellation, _cancellation_rx) = CancellationHandle::new();
        let join = thread::spawn(|| {});
        workers.insert(
            "req-1".to_string(),
            WorkerHandle {
                body_tx: None,
                cancellation,
                join,
            },
        );

        let result = start_relay_request(
            &mut socket,
            &config,
            &BTreeMap::new(),
            &worker_tx,
            &mut workers,
            &recent_finished,
            RelayRequest {
                request_id: "req-1".to_string(),
                method: "POST".to_string(),
                path: "/v1/chat/completions".to_string(),
                headers: BTreeMap::new(),
                timeout_ms: 1_000,
                handle: "local".to_string(),
                expect_body: false,
                body_bytes: None,
                count_first: false,
                count_ceiling: None,
            },
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
            &BTreeMap::new(),
            &worker_tx,
            &mut workers,
            &recent_finished,
            RelayRequest {
                request_id: "req-done".to_string(),
                method: "POST".to_string(),
                path: "/v1/chat/completions".to_string(),
                headers: BTreeMap::new(),
                timeout_ms: 1_000,
                handle: "local".to_string(),
                expect_body: false,
                body_bytes: None,
                count_first: false,
                count_ceiling: None,
            },
        );
        assert!(result.is_ok(), "start_relay_request should not error");

        assert!(workers.is_empty());
        assert!(!socket.get_ref().written.is_empty());
    }

    #[test]
    fn media_fetch_cancellation_interrupts_pending_transport_operation() {
        let (cancellation, mut cancellation_rx) = CancellationHandle::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let (operation_started_tx, operation_started_rx) = tokio::sync::oneshot::channel();
            let cancellation_task = cancellation.clone();
            let cancel = tokio::spawn(async move {
                operation_started_rx
                    .await
                    .expect("pending transport operation should begin polling");
                assert!(cancellation_task.cancel());
            });
            let outcome = tokio::time::timeout(
                Duration::from_secs(1),
                await_or_cancel(&mut cancellation_rx, async move {
                    operation_started_tx
                        .send(())
                        .expect("signal pending transport operation");
                    std::future::pending::<()>().await
                }),
            )
            .await
            .expect("fetch should observe cancellation promptly");
            assert!(outcome.is_none());
            cancel.await.expect("cancel task");
        });
    }

    #[test]
    fn media_fetch_client_builds_with_no_redirect_policy() {
        // The redirect policy is security-sensitive: trusted URL validation
        // happens before fetch, so the client must not chase an attacker-owned
        // Location response afterwards.
        assert!(build_media_fetch_client().is_ok());
    }

    #[test]
    fn websocket_url_uses_relay_path_and_scheme() {
        assert_eq!(
            websocket_url("https://example.test").expect("url").as_str(),
            "wss://example.test/api/cli/ws"
        );
    }

    #[test]
    fn api_paths_take_the_prefix_and_engine_routes_the_origin() {
        let join = |base: &str, path: &str| endpoint_url(base, path).map(|url| url.to_string());
        for (base, path, want) in [
            (
                "http://127.0.0.1:8080/v1",
                "/v1/chat/completions",
                "http://127.0.0.1:8080/v1/chat/completions",
            ),
            (
                "http://127.0.0.1:8080",
                "/v1/chat/completions",
                "http://127.0.0.1:8080/v1/chat/completions",
            ),
            (
                "http://127.0.0.1:8080/openai",
                "/v1/chat/completions",
                "http://127.0.0.1:8080/openai/chat/completions",
            ),
            (
                "http://127.0.0.1:8080/api/v1",
                "/v1/models",
                "http://127.0.0.1:8080/api/v1/models",
            ),
            (
                "http://127.0.0.1:8080/v1",
                "/slots",
                "http://127.0.0.1:8080/slots",
            ),
            (
                "http://[::1]:8080/v1",
                "/v1/models",
                "http://[::1]:8080/v1/models",
            ),
            (
                "http://127.0.0.1:8080/v1",
                "/v1x/models",
                "http://127.0.0.1:8080/v1x/models",
            ),
        ] {
            assert_eq!(join(base, path).expect(path), want, "{base} {path}");
        }
    }

    #[test]
    fn a_request_path_never_leaves_the_runtime_address() {
        for path in [
            "http://evil.example/x",
            "/https://evil.example/x",
            "https:evil.example",
            "/https:evil.example/x",
            "/ws:evil.example/x",
            "/file:etc/passwd",
            "\\\\evil.example/x",
            "/v1/../../admin",
            "//evil.example/x",
            "/v1/%2e%2e/admin",
            "/v1/models?x=1",
        ] {
            assert!(
                endpoint_url("http://127.0.0.1:8000/v1", path).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn rejected_relay_credentials_are_fatal_but_server_trouble_reconnects() {
        let http = |status: u16| {
            let response = tungstenite::http::Response::builder()
                .status(status)
                .body(None)
                .expect("response");
            tungstenite::Error::Http(Box::new(response))
        };
        match relay_connect_error(http(401), true) {
            RelaySessionError::Fatal(error) => {
                assert_eq!(
                    crate::exit::code_for(&error),
                    crate::exit::ExitCode::CredentialRejected
                );
                assert!(crate::exit::message_for(&error).contains("`wsmp login`"));
            }
            _ => panic!("HTTP 401 must be fatal where stopping is safe"),
        }
        // Where exiting would only be relaunched (launchd), 401 is retried.
        match relay_connect_error(http(401), false) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert!(format!("{error:#}").contains("`wsmp login`"));
            }
            _ => panic!("HTTP 401 must be retried without the stop marker"),
        }
        // 403 can come from a proxy or firewall: never fatal.
        for status in [403, 429, 500, 502, 503] {
            for stop in [true, false] {
                assert!(matches!(
                    relay_connect_error(http(status), stop),
                    RelaySessionError::Reconnectable { .. }
                ));
            }
        }
        let io =
            tungstenite::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(matches!(
            relay_connect_error(io, true),
            RelaySessionError::Reconnectable { .. }
        ));
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

    #[test]
    fn count_first_exceeds_ceiling_is_exclusive() {
        assert!(!count_first_exceeds_ceiling(8, None));
        assert!(!count_first_exceeds_ceiling(8, Some(8)));
        assert!(count_first_exceeds_ceiling(9, Some(8)));
    }

    #[test]
    fn terminal_usage_comes_from_the_final_sse_completion_event() {
        let response = b"data: {\"usage\":{\"completionTokens\":2}}\n\ndata: {\"usage\":{\"promptTokens\":3,\"completionTokens\":5,\"totalTokens\":8}}\n\ndata: [DONE]\n\n";
        assert_eq!(
            terminal_usage_from_response(response),
            Some(RelayUsage {
                prompt_tokens: Some(3),
                completion_tokens: Some(5),
                total_tokens: Some(8),
            })
        );
    }

    #[test]
    fn terminal_usage_never_fabricates_missing_metrics() {
        assert_eq!(terminal_usage_from_response(br#"{"choices":[]}"#), None);
    }

    #[test]
    fn terminal_usage_survives_a_truncated_large_non_stream_json_tail() {
        let response = format!(
            r#"{{"choices":[{{"text":"{}"}}],"usage":{{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}}}"#,
            "x".repeat(RELAY_USAGE_TAIL_MAX_BYTES + 1),
        );
        let mut tail = Vec::new();
        append_usage_tail(&mut tail, response.as_bytes());

        assert_eq!(
            terminal_usage_from_response(&tail),
            Some(RelayUsage {
                prompt_tokens: Some(3),
                completion_tokens: Some(5),
                total_tokens: Some(8),
            })
        );
    }

    #[test]
    fn disconnected_request_body_is_not_reported_as_clean_eof() {
        let (body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(1);
        let (out_tx, _out_rx) = mpsc::sync_channel::<FromWorker>(1);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        let mut stream =
            streaming_request_body(body_rx, out_tx, "request-1".to_string(), cancellation_rx);
        drop(body_tx);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let item = runtime
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    std::future::poll_fn(|cx| std::pin::Pin::new(&mut stream).poll_next(cx)),
                )
                .await
            })
            .expect("body stream should terminate")
            .expect("truncated body must yield an item");
        let error = item.expect_err("truncated body must fail closed");
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn cancelled_request_body_is_not_reported_as_clean_eof() {
        let (_body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(1);
        let (out_tx, _out_rx) = mpsc::sync_channel::<FromWorker>(1);
        let (cancellation, cancellation_rx) = CancellationHandle::new();
        let mut stream =
            streaming_request_body(body_rx, out_tx, "request-1".to_string(), cancellation_rx);
        assert!(cancellation.cancel());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let item = runtime
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    std::future::poll_fn(|cx| std::pin::Pin::new(&mut stream).poll_next(cx)),
                )
                .await
            })
            .expect("body stream should terminate")
            .expect("cancelled body must yield an item");
        assert_eq!(
            item.expect_err("cancelled body must fail closed").kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    fn local_upstream_spec(base_url: String) -> UpstreamRequestSpec {
        UpstreamRequestSpec {
            request_id: "local-http-test".to_string(),
            method: "POST".to_string(),
            base_url,
            path: "/v1/chat/completions".to_string(),
            request_headers: BTreeMap::new(),
            endpoint_headers: Vec::new(),
            endpoint_auth: None,
            timeout_ms: 2_000,
            has_body: false,
            body_bytes: None,
            expand_media: false,
            trusted_origins: TrustedOrigins::new(None, &[]),
        }
    }

    /// A strict OpenAI-compatible upstream (TensorFold, gufo): answers 400
    /// unless the request carries a Content-Length and no chunked framing.
    fn strict_length_upstream() -> Option<(std::net::SocketAddr, JoinHandle<String>)> {
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return None,
            Err(error) => panic!("bind strict upstream: {error}"),
        };
        let address = listener.local_addr().expect("address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let mut seen = Vec::new();
            let mut buffer = [0_u8; 4096];
            // Read the head, then exactly Content-Length body bytes.
            let head_end = loop {
                let size = std::io::Read::read(&mut stream, &mut buffer).expect("read");
                assert!(size > 0, "request ended early");
                seen.extend_from_slice(&buffer[..size]);
                if let Some(end) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let head = String::from_utf8_lossy(&seen[..head_end]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok());
            let response: &[u8] = match length {
                Some(length) if !head.contains("transfer-encoding") => {
                    while seen.len() < head_end + length {
                        let size = std::io::Read::read(&mut stream, &mut buffer).expect("read");
                        assert!(size > 0, "body ended early");
                        seen.extend_from_slice(&buffer[..size]);
                    }
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}"
                }
                _ => b"HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: 39\r\nconnection: close\r\n\r\n{\"error\":\"Content-Length is required\"}\n",
            };
            stream.write_all(response).expect("write");
            String::from_utf8_lossy(&seen).into_owned()
        });
        Some((address, server))
    }

    fn relay_status(frames: &[FromWorker]) -> Option<u16> {
        frames.iter().find_map(|frame| match frame {
            FromWorker::Send {
                frame: WsFrame::Text(text),
                ..
            } if text.contains(r#""type":"relay.response.headers""#) => {
                let value: serde_json::Value = serde_json::from_str(text).ok()?;
                value["status"].as_u64().and_then(|s| u16::try_from(s).ok())
            }
            _ => None,
        })
    }

    /// I11: a relayed body with a declared length reaches a strict upstream
    /// with Content-Length framing, split across relay chunks as sent.
    #[test]
    fn a_declared_body_length_is_sent_as_content_length_not_chunked() {
        let Some((address, upstream)) = strict_length_upstream() else {
            return;
        };
        let body = br#"{"model":"GLM-5.3-Flash-EXL3","messages":[{"role":"user","content":"hi"}]}"#;
        let mut spec = local_upstream_spec(format!("http://{address}"));
        spec.has_body = true;
        spec.body_bytes = Some(body.len() as u64);
        spec.request_headers
            .insert("content-type".to_string(), "application/json".to_string());
        let (body_tx, body_rx) = mpsc::sync_channel(4);
        body_tx
            .send(BodyChunk {
                data: body[..10].to_vec(),
                last: false,
            })
            .expect("first chunk");
        body_tx
            .send(BodyChunk {
                data: body[10..].to_vec(),
                last: true,
            })
            .expect("last chunk");
        let (tx, rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(execute_upstream(spec, Some(body_rx), &tx, cancellation_rx))
            .expect("relay");
        let seen = upstream.join().expect("upstream");
        let frames = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(relay_status(&frames), Some(200), "{seen}");
        assert!(
            seen.to_ascii_lowercase()
                .contains(&format!("content-length: {}", body.len()))
        );
        assert!(
            seen.ends_with(std::str::from_utf8(body).expect("utf8")),
            "{seen}"
        );
    }

    /// A body without a declared length is still sent with Content-Length
    /// (buffered under the cap).
    #[test]
    fn an_undeclared_body_length_is_buffered_and_sent_sized() {
        let Some((address, upstream)) = strict_length_upstream() else {
            return;
        };
        let body = br#"{"model":"m","messages":[{"role":"user","content":"hi"}]}"#;
        let mut spec = local_upstream_spec(format!("http://{address}"));
        spec.has_body = true;
        let (body_tx, body_rx) = mpsc::sync_channel(body.len());
        for (index, part) in body.chunks(7).enumerate() {
            body_tx
                .send(BodyChunk {
                    data: part.to_vec(),
                    last: (index + 1) * 7 >= body.len(),
                })
                .expect("chunk");
        }
        let (tx, rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(execute_upstream(spec, Some(body_rx), &tx, cancellation_rx))
            .expect("relay");
        let seen = upstream.join().expect("upstream");
        let frames = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(relay_status(&frames), Some(200), "{seen}");
        let credits = frames
            .iter()
            .filter(|frame| matches!(frame, FromWorker::Send { frame: WsFrame::Text(text), .. } if text.contains("relay.request.body.ack")))
            .count();
        assert_eq!(credits, body.chunks(7).count());
    }

    #[test]
    fn a_body_over_the_buffer_cap_keeps_its_prefix_and_streams_the_rest() {
        let (body_tx, body_rx) = mpsc::sync_channel(4);
        body_tx
            .send(BodyChunk {
                data: vec![1; 4],
                last: false,
            })
            .expect("a");
        body_tx
            .send(BodyChunk {
                data: vec![2; 4],
                last: false,
            })
            .expect("b");
        let (tx, _rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        match buffer_body_prefix(&body_rx, &tx, "r", 6) {
            BufferedBody::Prefix(prefix) => assert_eq!(prefix, vec![vec![1; 4], vec![2; 4]]),
            _ => panic!("expected a prefix"),
        }
        drop(body_tx);
        assert!(matches!(
            buffer_body_prefix(&body_rx, &tx, "r", 6),
            BufferedBody::Aborted
        ));
    }

    /// A body longer than its declared length fails instead of being cut
    /// (or smuggling the rest as a second request).
    #[test]
    fn a_body_longer_than_declared_fails_closed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        let chunks = vec![Ok(b"12345".to_vec()), Ok(b"678".to_vec())];
        let mut body = exact_length_body(Box::pin(tokio_stream_of(chunks)), 6);
        let first = runtime.block_on(next_item(&mut body));
        assert!(matches!(first, Some(Ok(_))));
        let second = runtime.block_on(next_item(&mut body));
        assert!(matches!(second, Some(Err(_))));
        assert!(runtime.block_on(next_item(&mut body)).is_none());

        let mut short = exact_length_body(Box::pin(tokio_stream_of(vec![Ok(b"12".to_vec())])), 6);
        assert!(matches!(
            runtime.block_on(next_item(&mut short)),
            Some(Ok(_))
        ));
        assert!(matches!(
            runtime.block_on(next_item(&mut short)),
            Some(Err(_))
        ));
    }

    type TestBodyItem = std::result::Result<Vec<u8>, io::Error>;

    struct VecStream(std::collections::VecDeque<TestBodyItem>);

    impl Stream for VecStream {
        type Item = TestBodyItem;
        fn poll_next(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<TestBodyItem>> {
            std::task::Poll::Ready(self.0.pop_front())
        }
    }

    fn tokio_stream_of(items: Vec<TestBodyItem>) -> VecStream {
        VecStream(items.into())
    }

    async fn next_item<S: Stream<Item = TestBodyItem> + Unpin>(
        stream: &mut S,
    ) -> Option<TestBodyItem> {
        std::future::poll_fn(|cx| std::pin::Pin::new(&mut *stream).poll_next(cx)).await
    }

    #[test]
    fn reqwest_relay_reads_terminal_usage_from_a_real_local_http_response() {
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            // Restricted CI sandboxes can deny loopback bind entirely. The
            // deterministic parser coverage remains below; normal CI runs the
            // real transport integration check.
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test upstream: {error}"),
        };
        let address = listener.local_addr().expect("read test upstream address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept relay request");
            let mut request = [0_u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut request).expect("read relay request");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: {\"usage\":{\"promptTokens\":3,\"completionTokens\":5,\"totalTokens\":8}}\n\ndata: [DONE]\n\n",
                )
                .expect("write test upstream response");
        });
        let (tx, rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime
            .block_on(execute_upstream(
                local_upstream_spec(format!("http://{address}")),
                None,
                &tx,
                cancellation_rx,
            ))
            .expect("relay local HTTP response");
        server.join().expect("test upstream thread");

        let frames = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert!(frames.iter().any(|frame| matches!(
            frame,
            FromWorker::Send { frame: WsFrame::Text(text), .. }
                if text.contains(r#""type":"relay.response.headers""#)
        )));
        assert!(frames.iter().any(|frame| matches!(
            frame,
            FromWorker::Send { frame: WsFrame::Text(text), .. }
                if text.contains(r#""type":"relay.complete""#)
                    && text.contains(r#""completionTokens":5"#)
                    && text.contains(r#""totalTokens":8"#)
        )));
    }

    /// Framing, Host and credential headers from the server never reach the
    /// engine; the node's own credential is the only one sent.
    #[test]
    fn server_headers_cannot_smuggle_framing_or_credentials() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind upstream");
        let address = listener.local_addr().expect("address");
        let upstream = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let size = std::io::Read::read(&mut stream, &mut request).expect("read");
            let text = String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
                .expect("write");
            text
        });
        let mut spec = local_upstream_spec(format!("http://{address}"));
        spec.method = "GET".to_string();
        spec.has_body = false;
        for (name, value) in [
            ("Content-Length", "40"),
            ("host", "admin.internal"),
            ("authorization", "Bearer server-chosen"),
            ("x-api-key", "server-chosen"),
            ("transfer-encoding", "chunked"),
            ("x-forwarded-for", "1.2.3.4"),
            ("content-type", "application/json"),
        ] {
            spec.request_headers
                .insert(name.to_string(), value.to_string());
        }
        crate::secrets::test_secrets()
            .lock()
            .expect("test secrets")
            .insert(
                "WSMP_SECRET_HEADER_TEST".to_string(),
                "node-own".to_string(),
            );
        spec.endpoint_auth = Some((
            EndpointAuthMode::Bearer,
            "WSMP_SECRET_HEADER_TEST".to_string(),
        ));
        let (tx, _rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(execute_upstream(spec, None, &tx, cancellation_rx))
            .expect("relay");
        let seen = upstream.join().expect("upstream");
        assert!(!seen.contains("content-length: 40"), "{seen}");
        assert!(!seen.contains("admin.internal"), "{seen}");
        assert!(!seen.contains("server-chosen"), "{seen}");
        assert!(!seen.contains("transfer-encoding"), "{seen}");
        assert!(!seen.contains("x-forwarded-for"), "{seen}");
        assert!(seen.contains("authorization: bearer node-own"), "{seen}");
        assert!(seen.contains("content-type: application/json"), "{seen}");
    }

    #[test]
    fn reqwest_relay_does_not_follow_cross_origin_redirects_or_replay_credentials() {
        let first = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind redirect source: {error}"),
        };
        let second = std::net::TcpListener::bind("127.0.0.1:0").expect("bind redirect target");
        second
            .set_nonblocking(true)
            .expect("nonblocking redirect target");
        let first_address = first.local_addr().expect("source address");
        let second_address = second.local_addr().expect("target address");
        let source = thread::spawn(move || {
            let (mut stream, _) = first.accept().expect("accept source request");
            let mut request = [0_u8; 4096];
            let size = std::io::Read::read(&mut stream, &mut request).expect("read source request");
            let text = String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
            assert!(text.contains("x-api-key: redirect-test-secret"));
            stream.write_all(format!(
                "HTTP/1.1 307 Temporary Redirect\r\nlocation: http://{second_address}/credential-sink\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            ).as_bytes()).expect("write redirect");
        });
        let mut spec = local_upstream_spec(format!("http://{first_address}"));
        crate::secrets::test_secrets()
            .lock()
            .expect("test secrets")
            .insert(
                "WSMP_SECRET_REDIRECT_TEST".to_string(),
                "redirect-test-secret".to_string(),
            );
        spec.endpoint_auth = Some((
            EndpointAuthMode::ApiKey,
            "WSMP_SECRET_REDIRECT_TEST".to_string(),
        ));
        let (tx, rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(execute_upstream(spec, None, &tx, cancellation_rx))
            .expect("relay redirect");
        source.join().expect("source thread");
        // No sleep: `execute_upstream` has returned, so a followed redirect would already
        // have completed its TCP handshake with `second` (and, since `second` never
        // answers, the call above would not have returned at all).
        assert!(matches!(second.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock));
        let frames = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert!(frames.iter().any(|frame| matches!(frame,
            FromWorker::Send { frame: WsFrame::Text(text), .. }
                if text.contains(r#""type":"relay.response.headers""#)
        )));
    }

    #[test]
    fn reqwest_relay_does_not_follow_same_origin_redirects() {
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind redirect source: {error}"),
        };
        let address = listener.local_addr().expect("source address");
        let (client_done_tx, client_done_rx) = mpsc::channel::<()>();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept initial request");
            let mut request = [0_u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut request).expect("read initial request");
            stream
                .write_all(
                    format!("HTTP/1.1 308 Permanent Redirect\r\nlocation: http://{address}/same-origin\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes(),
                )
                .expect("write redirect");
            drop(stream);
            // Check for a followed redirect only once the client has finished: a
            // follow would already be queued on this listener, so no sleep is needed.
            client_done_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("client should finish");
            listener
                .set_nonblocking(true)
                .expect("nonblocking listener");
            assert!(
                matches!(listener.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
            );
        });
        let (tx, _rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(execute_upstream(
                local_upstream_spec(format!("http://{address}")),
                None,
                &tx,
                cancellation_rx,
            ))
            .expect("relay same-origin redirect");
        client_done_tx.send(()).expect("signal client done");
        server.join().expect("redirect server");
    }

    #[test]
    fn reqwest_relay_cancellation_interrupts_a_real_http_header_wait() {
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("bind test upstream: {error}"),
        };
        let address = listener.local_addr().expect("read test upstream address");
        let (accepted_tx, accepted_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept relay request");
            let mut request = [0_u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut request).expect("read relay request");
            accepted_tx.send(()).expect("signal accepted request");
            // Hold the header wait open until the client goes away (EOF or reset): a
            // cancellation that does not drop the connection leaves the request waiting,
            // so the 10 s bound below trips instead of a fixed sleep racing it. The read
            // timeout keeps this thread from hanging the test if the socket is never closed.
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .expect("set upstream read timeout");
            while std::io::Read::read(&mut stream, &mut request).is_ok_and(|read| read > 0) {}
        });
        let (tx, rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (cancellation, cancellation_rx) = CancellationHandle::new();
        let cancel = thread::spawn(move || {
            accepted_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("upstream should receive request before cancellation");
            assert!(cancellation.cancel());
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime
            .block_on(async {
                // Only a hang bound: the upstream holds its response until the client
                // disconnects, so this elapses only if cancellation fails to end the wait.
                tokio::time::timeout(
                    Duration::from_secs(10),
                    execute_upstream(
                        // A long request timeout so only cancellation (or the hang
                        // bound above) can end the wait, not the request's own clock.
                        UpstreamRequestSpec {
                            timeout_ms: 60_000,
                            ..local_upstream_spec(format!("http://{address}"))
                        },
                        None,
                        &tx,
                        cancellation_rx,
                    ),
                )
                .await
            })
            .expect("cancellation should end the header wait promptly")
            .expect("cancellation is not an upstream error");
        cancel.join().expect("cancellation thread");
        // The runtime owns the client's pooled connection; dropping it closes the socket,
        // which is what lets the upstream thread (waiting for EOF) finish.
        drop(runtime);
        server.join().expect("test upstream thread");
        assert!(
            rx.try_recv().is_err(),
            "cancelled request must not emit late relay frames"
        );
    }

    fn stop_job(operator: bool) -> crate::protocol::frames::RuntimeJob {
        crate::protocol::frames::RuntimeJob {
            step_id: "step1".into(),
            instance_id: "in1".into(),
            runtime_id: "rt1".into(),
            launch_version_id: "vr1".into(),
            launch_hash: "h".repeat(64),
            generation: 1,
            rank: 0,
            nnodes: 1,
            phase: JobPhase::Stop,
            handle: "i-abcdefabcdef".into(),
            unit_name: "wsmp-i-abcdefabcdef-r0".into(),
            placeholders: crate::protocol::frames::JobPlaceholders {
                port: 30001,
                dist_port: None,
                head_addr: None,
                gpu_ids: None,
                memory_gb: None,
                vram_gb: None,
                memory_fraction: None,
            },
            fabric_id: None,
            timeout_ms: 60_000,
            owner_epoch: "epoch:1".into(),
            intent_hash: "b".repeat(64),
            operator: operator.then(|| crate::protocol::frames::JobOperator {
                terminal_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
                command_author: crate::protocol::frames::CommandAuthor::User,
            }),
        }
    }

    fn recorded(interactive_stop: bool) -> Job {
        let mut commands = serde_json::json!({
            "start": "sudo systemctl start x", "stop": "sudo systemctl stop x",
            "status": "systemctl is-active x"
        });
        if interactive_stop {
            commands["interactive"] = serde_json::json!({ "stop": true });
        }
        Job {
            step_id: "start-step".into(),
            instance_id: "in1".into(),
            runtime_id: "rt1".into(),
            version_id: "vr1".into(),
            launch_hash: "h".repeat(64),
            rank: 0,
            action: JobPhase::Start,
            intent_hash: "a".repeat(64),
            owner_epoch: "epoch:0".into(),
            command: "sudo systemctl start x".into(),
            stop_command: "sudo systemctl stop x".into(),
            status_command: Some("systemctl is-active x".into()),
            health_command: None,
            secrets: Vec::new(),
            timeout_ms: 60_000,
            unit_name: "wsmp-i-abcdefabcdef-r0".into(),
            handle: "i-abcdefabcdef".into(),
            port: 30001,
            gpu_ids: None,
            host: "127.0.0.1".into(),
            spec: serde_json::json!({
                "api": "openai", "engine": "vllm", "modelType": "llm",
                "launch": {
                    "management": "service", "groupSize": 1,
                    "resources": [{ "kind": "none" }], "labels": [],
                    "commands": [commands],
                    "health": { "intervalMs": 30000, "failureThreshold": 2, "successThreshold": 1 }
                }
            }),
        }
    }

    #[test]
    fn a_recorded_stop_runs_in_an_operator_terminal_exactly_when_it_is_interactive() {
        for (interactive, operator) in [(true, false), (false, true)] {
            let refused = from_record(&stop_job(operator), recorded(interactive))
                .expect_err("operator mismatch");
            assert_eq!(refused.error, JobError::BadJob);
            assert_eq!(refused.detail.as_deref(), Some("operator"));
        }
        for interactive in [true, false] {
            let job = from_record(&stop_job(interactive), recorded(interactive)).expect("admitted");
            assert_eq!(job.action, JobPhase::Stop);
            assert_eq!(job.step_id, "step1");
            assert_eq!(job.stop_command, "sudo systemctl stop x");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_operator_screen_shows_what_the_node_rendered_not_the_server_handle() {
        let mut job = stop_job(true);
        job.handle = "i-zzzzzzzzzzzz".into();
        let rendered = recorded(true);
        let Some(operator) = job.operator.clone() else {
            panic!("operator job");
        };
        let ticket = operator_ticket(&job, &operator, &rendered, &Config::default());
        assert_eq!(ticket.screen.handle, "i-abcdefabcdef");
        assert_eq!(ticket.screen.command, "sudo systemctl start x");
        assert_eq!(ticket.ids.terminal_id, "AAAAAAAAAAAAAAAAAAAAAA");
    }

    /// A secret write that changed the set is followed by a `node.state`, so
    /// the server lists the new name at once; a refusal or no-op is not.
    #[test]
    fn a_changed_secret_set_reports_the_node_state() {
        // Stands in for the real `node.state` (built from the startup).
        let state = || NodeFrame::RelayCancelled {
            request_id: "state".into(),
        };
        let kinds = |frames: Vec<NodeFrame>| {
            frames
                .iter()
                .map(|frame| match frame {
                    NodeFrame::SecretResult { .. } => "secret.result",
                    NodeFrame::RelayCancelled { .. } => "node.state",
                    _ => "other",
                })
                .collect::<Vec<_>>()
        };
        let set = Ok(crate::secrets::Outcome::Set {
            updated_at: "2026-10-07T00:00:00Z".to_string(),
        });
        assert_eq!(
            kinds(secret_answer(
                "1".into(),
                "WSMP_SECRET_A".into(),
                set,
                state
            )),
            ["secret.result", "node.state"]
        );
        let deleted = Ok(crate::secrets::Outcome::Deleted);
        assert_eq!(
            kinds(secret_answer(
                "2".into(),
                "WSMP_SECRET_A".into(),
                deleted,
                state
            )),
            ["secret.result", "node.state"]
        );
        let missing = Ok(crate::secrets::Outcome::NotFound);
        assert_eq!(
            kinds(secret_answer(
                "3".into(),
                "WSMP_SECRET_A".into(),
                missing,
                state
            )),
            ["secret.result"]
        );
        let refused = Err(SecretRefusal::TrustRelay);
        assert_eq!(
            kinds(secret_answer(
                "4".into(),
                "WSMP_SECRET_A".into(),
                refused,
                state
            )),
            ["secret.result"]
        );
    }
}
