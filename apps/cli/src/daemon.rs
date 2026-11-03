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
//! `runtime.detect` scans loopback ports off this loop
//! (`crate::runtimes::detect`).

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
    DEFAULT_COMMAND_MAX, ExecLine, ExecRegistry, OutboundFrame, TermHandshake, TerminalRegistry,
};
use crate::slug::generated_slug;
use crate::startup::TerminalStartup;
use crate::stt_wire::SttServerMessage;
use crate::tokens::{CompletionTextCollector, standardized_completion_metrics};

const RELAY_RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(1);
const RELAY_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(300);
/// The first wait after a session failed fatally (see the relay loop).
const RELAY_FATAL_INITIAL_DELAY: Duration = Duration::from_secs(5);
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

/// Where a live request's body stands, as the main loop routes its frames.
enum RequestBody {
    /// The request declared no body: any body frame is a protocol fault.
    None,
    /// Chunks feed the worker through this sender. Dropping it before the
    /// final chunk aborts the upstream request body.
    Open(SyncSender<BodyChunk>),
    /// The final chunk went to the worker (the sender is dropped; queued
    /// chunks still reach it). A chunk after it is dropped with a warning.
    Complete,
}

/// Handle the main loop keeps for an in-flight relayed request.
struct WorkerHandle {
    body: RequestBody,
    cancellation: CancellationHandle,
    join: JoinHandle<()>,
}

/// Why a request leaves the live set ([`RelayRequests::retire`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Retire {
    /// Its worker reported `Finished`: joined (it is done).
    Finished,
    /// The server cancelled it (`relay.cancel`).
    Cancelled,
    /// The node faulted it (`relay.error` already sent or about to be).
    Faulted,
}

/// What the main loop knows about one request id.
enum RequestState<'a> {
    Live(&'a mut WorkerHandle),
    /// Retired recently: late frames for it are expected and dropped.
    Retired,
    /// Never seen (or retired too long ago to remember).
    Unknown,
}

/// Every relayed request of one session: the live ones and the recently
/// retired ids. One place moves a request from live to retired
/// ([`Self::retire`]), so every exit records it the same way.
struct RelayRequests {
    live: BTreeMap<String, WorkerHandle>,
    retired: RecentlyFinished,
}

impl RelayRequests {
    fn new() -> Self {
        Self {
            live: BTreeMap::new(),
            retired: RecentlyFinished::new(),
        }
    }

    /// Frames a worker queued for `request_id` may still go out.
    fn is_live(&self, request_id: &str) -> bool {
        self.live.contains_key(request_id)
    }

    /// Live, or retired recently: a `relay.request` reusing it is a fault.
    fn in_use(&self, request_id: &str) -> bool {
        self.is_live(request_id) || self.retired.contains(request_id)
    }

    fn state(&mut self, request_id: &str) -> RequestState<'_> {
        if let Some(worker) = self.live.get_mut(request_id) {
            return RequestState::Live(worker);
        }
        if self.retired.contains(request_id) {
            RequestState::Retired
        } else {
            RequestState::Unknown
        }
    }

    fn start(&mut self, request_id: String, worker: WorkerHandle) {
        self.live.insert(request_id, worker);
    }

    /// Take `request_id` out of the live set for `reason` and remember it,
    /// so late body chunks the server is still flushing are dropped instead
    /// of faulted as "before request metadata". Whether it was live.
    fn retire(&mut self, request_id: &str, reason: Retire) -> bool {
        self.retired.record(request_id);
        let Some(worker) = self.live.remove(request_id) else {
            return false;
        };
        match reason {
            Retire::Finished => {
                let _ = worker.join.join();
            }
            Retire::Cancelled | Retire::Faulted => {
                worker.cancellation.cancel();
                drop(worker.body);
                // Detach: the thread exits once its upstream call unwinds.
                drop(worker.join);
            }
        }
        true
    }

    /// Session teardown: cancel every live request without joining, so a
    /// slow upstream cannot delay reconnection.
    fn abort_all(&mut self) {
        abort_all_workers(std::mem::take(&mut self.live));
    }
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
                    // The end rides in band with the last chunk: a channel
                    // that closes without it is a truncated upload.
                    if body_tx.blocking_send(BodyHandoff { data, last }).is_err() {
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
        state: BodyStreamState::Open,
    }
}

/// One request-body chunk on its way from the bridge thread to the HTTP body.
struct BodyHandoff {
    data: Vec<u8>,
    last: bool,
}

/// Where the upstream request body stream stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyStreamState {
    /// More chunks may come.
    Open,
    /// The final chunk was yielded: a clean EOF.
    Ended,
    /// The channel closed before the final chunk: the error was yielded.
    Truncated,
}

struct TokioBodyStream {
    receiver: tokio_mpsc::Receiver<BodyHandoff>,
    state: BodyStreamState,
}

impl Stream for TokioBodyStream {
    type Item = std::result::Result<Vec<u8>, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        if self.state != BodyStreamState::Open {
            return Poll::Ready(None);
        }
        match self.receiver.poll_recv(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(BodyHandoff { data, last })) => {
                if last {
                    self.state = BodyStreamState::Ended;
                }
                Poll::Ready(Some(Ok(data)))
            }
            Poll::Ready(None) => {
                self.state = BodyStreamState::Truncated;
                Poll::Ready(Some(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "relay request body ended before final chunk",
                ))))
            }
        }
    }
}

enum RelaySessionError {
    /// Lost or refused for now: reconnect after the backoff
    /// ([`ReconnectBackoff`] decides how long from how far the attempt got).
    Reconnectable {
        error: anyhow::Error,
    },
    Fatal(anyhow::Error),
    /// A shutdown signal arrived; the session has already cleaned up.
    Shutdown(i32),
    /// An update is in place: exit with `RestartForUpdate` so the service
    /// starts the new binary.
    RestartForUpdate,
}

type RelaySessionResult<T> = std::result::Result<T, RelaySessionError>;

/// How far one connection attempt got: what the reconnect backoff reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectProgress {
    /// Opening the websocket (or no credential to open it with).
    Connecting,
    /// The upgrade was accepted.
    Upgraded,
    /// `hello.challenge` arrived.
    Challenged,
    /// The hello went out; `hello.ok` has not arrived.
    HelloSent,
    /// `hello.ok` arrived at `since`.
    Registered { since: Instant },
}

/// How long a registered session must have lasted for its end to start the
/// backoff over. A server that accepts the hello and then drops the node at
/// once keeps the backoff growing instead of being redialled every second.
const RELAY_STABLE_SESSION: Duration = Duration::from_secs(30);

impl ConnectProgress {
    /// The attempt ran a registered session for at least
    /// [`RELAY_STABLE_SESSION`] by `now`.
    fn stable_at(self, now: Instant) -> bool {
        matches!(self, Self::Registered { since } if now.saturating_duration_since(since) >= RELAY_STABLE_SESSION)
    }
}

/// How a connection attempt ended, for the backoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptEnd {
    /// No credential to connect with, or the session ended without an error.
    Retry,
    /// A reconnectable error, waiting at least `floor` when it carries one.
    Reconnectable { floor: Option<Duration> },
    /// A failure fatal to the session that is not a stop: its own, slower
    /// backoff.
    Fatal,
}

/// The relay's reconnect backoff: one place decides every wait.
///
/// Reconnects wait 1 s, then twice as long each time, up to 5 minutes; a
/// session that keeps failing fatally waits 5 s, then twice as long, up to
/// 5 minutes. Both start over only after an attempt that ran a stable
/// registered session ([`ConnectProgress::stable_at`]): an error before
/// `hello.ok` (a refused challenge, a lost socket while registering) never
/// resets them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReconnectBackoff {
    delay: Duration,
    fatal_delay: Duration,
}

impl ReconnectBackoff {
    fn new() -> Self {
        Self {
            delay: RELAY_RECONNECT_INITIAL_DELAY,
            fatal_delay: RELAY_FATAL_INITIAL_DELAY,
        }
    }

    /// The wait before the next attempt, after one that got to `progress`
    /// and ended as `end` (judged at `now`); grows the backoff for the one
    /// after.
    fn next_wait(&mut self, end: AttemptEnd, progress: ConnectProgress, now: Instant) -> Duration {
        if progress.stable_at(now) {
            *self = Self::new();
        }
        let wait = match end {
            AttemptEnd::Retry => reconnect_wait(self.delay, None),
            AttemptEnd::Reconnectable { floor } => {
                let wait = reconnect_wait(self.delay, floor);
                if let Some(floor) = floor {
                    // Grow the backoff from the server's floor, not below it.
                    self.delay = self.delay.max(floor).min(RELAY_RECONNECT_MAX_DELAY);
                }
                wait
            }
            AttemptEnd::Fatal => {
                let wait = reconnect_wait(self.fatal_delay, None);
                self.fatal_delay = next_reconnect_delay(self.fatal_delay);
                wait
            }
        };
        self.delay = next_reconnect_delay(self.delay);
        wait
    }
}

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
    // Orphans of commands re-parent to the relay (Linux), so `trust` still
    // finds it above them; see `subreaper`.
    crate::subreaper::start();
    // Windows: before anything is started, so all of it is in the job that
    // `trust::started_by_wsmp` asks.
    crate::trust::join_relay_job();
    let mut config = Config::load_required()?;
    config.validate()?;
    let mut control = ControlServer::bind()?;
    let startup = TerminalStartup::capture(&config)?;
    #[cfg(unix)]
    crate::file_ops::report_abandoned_recovery();
    // A new build that keeps failing to confirm rolls itself back here (exit 75).
    let updates = crate::update::agent::DaemonUpdate::start()?;
    let mut link = NodeLink::new(
        &crate::runtime_store::load_for(startup.trust_value()).unwrap_or_default(),
        updates,
        startup.trust_snapshot().lowerings,
    )?;
    let mut backoff = ReconnectBackoff::new();
    loop {
        check_shutdown()?;
        let node_slug = ensure_cli_slug(&mut config)?;
        let mut progress = ConnectProgress::Connecting;
        let wait = match resolve_credential() {
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
                let wait = backoff.next_wait(AttemptEnd::Retry, progress, Instant::now());
                tracing::warn!(
                    error = %format!("{error:#}"),
                    retry_delay_secs = wait.as_secs(),
                    "relay credential unavailable; retrying"
                );
                wait
            }
            Ok(secret) => {
                let server_url = config
                    .server_url
                    .clone()
                    .context("this node is not enrolled; run `wsmp login <url> --code <code>`")?;
                let ws_url = websocket_url(&server_url)?;
                let auth_value = HeaderValue::from_str(&format!("Bearer {secret}"))
                    .context("building websocket authorization header")?;

                tracing::info!(url = %ws_url, "connecting relay websocket");
                let result = run_relay_session(
                    &config,
                    &startup,
                    &node_slug,
                    &ws_url,
                    auth_value,
                    &mut control,
                    &mut link,
                    &mut progress,
                );
                let now = Instant::now();
                match result {
                    Ok(()) => {
                        let wait = backoff.next_wait(AttemptEnd::Retry, progress, now);
                        tracing::warn!(
                            retry_delay_secs = wait.as_secs(),
                            "relay websocket session ended; reconnecting after backoff"
                        );
                        wait
                    }
                    Err(RelaySessionError::Reconnectable { error }) => {
                        let floor = retry_floor(&error);
                        let wait =
                            backoff.next_wait(AttemptEnd::Reconnectable { floor }, progress, now);
                        tracing::warn!(
                            error = %format!("{error:#}"),
                            retry_delay_secs = wait.as_secs(),
                            "relay websocket disconnected; reconnecting after backoff"
                        );
                        wait
                    }
                    // Only a stop code (a rejected credential, a refused protocol)
                    // ends the process: the service does not restart it after those.
                    // Anything else fatal to the session (a frame it cannot read, a
                    // broken server) reconnects in this process, slower each time,
                    // instead of exiting into a tight service restart loop.
                    Err(RelaySessionError::Fatal(error))
                        if crate::exit::code_for(&error) != crate::exit::ExitCode::Failure =>
                    {
                        return Err(error);
                    }
                    Err(RelaySessionError::Fatal(error)) => {
                        let wait = backoff.next_wait(AttemptEnd::Fatal, progress, now);
                        tracing::error!(
                            error = %format!("{error:#}"),
                            retry_delay_secs = wait.as_secs(),
                            "relay session failed; reconnecting after backoff"
                        );
                        wait
                    }
                    Err(RelaySessionError::Shutdown(signal)) => {
                        tracing::info!(signal, "relay stopped cleanly after a shutdown signal");
                        return Err(crate::shutdown::ShutdownRequested { signal }.into());
                    }
                    Err(RelaySessionError::RestartForUpdate) => {
                        tracing::info!("restarting into the installed update");
                        return Err(anyhow::anyhow!("restarting into the installed update")
                            .context(crate::exit::CodedError::new(
                                crate::exit::ExitCode::RestartForUpdate,
                            )));
                    }
                }
            }
        };
        wait_for_reconnect(&mut control, &startup, &node_slug, wait, &mut link)?;
        // Every retry re-reads the config, a credential retry included: a
        // `wsmp login` meanwhile changes the server URL and node slug, and
        // endpoint edits apply on reconnect.
        match Config::load_required().and_then(|fresh| fresh.validate().map(|()| fresh)) {
            Ok(fresh) => config = fresh,
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "re-reading the config failed; keeping the previous one"
            ),
        }
    }
}

/// What a control request or a hot reload changed, for the live session.
///
/// Trust itself is not carried here: the effects of a lowering follow the
/// daemon's [`crate::startup::TrustAuthority`] (its lowering count against
/// the one last applied, [`take_lowering`]), so changes that land in any
/// order in one loop turn end at whatever trust is now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeChange {
    /// Trust went down or up (persisted already): report `node.state`.
    Trust,
    /// Features changed (secrets, runtime hosts): report `node.state`.
    Features,
    /// `config.json` turned `allowHumanTerminal` off (latched already).
    HumanTerminalsDisabled,
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

/// Whether trust was lowered since the lowering count `applied` (and marks
/// it applied). Every lowering counts, even one raised again since: what was
/// started under the earlier grant still ends.
fn take_lowering(applied: &mut u64, startup: &TerminalStartup) -> bool {
    let now = startup.trust_snapshot().lowerings;
    if now == *applied {
        return false;
    }
    *applied = now;
    true
}

/// Hot reload (every 2 s on a changed `config.json`, and on `Reload`):
/// runtime hosts follow the file; trust and the browser terminal switch only
/// ever go down. A file that says `full` while the node is Relay only is
/// written back to `relay`.
fn reload_config(startup: &TerminalStartup) -> Result<Vec<NodeChange>> {
    let mut changes = vec![NodeChange::Features];
    // Trust first, from the raw file: a config that does not parse (a typo
    // anywhere) or lacks `trust: full` reads as Relay only.
    let file_trust = crate::trust::configured_on_disk();
    match Config::load_required() {
        Ok(config) => {
            startup.set_runtime_hosts(config.runtime_hosts.clone());
            changes.extend(reload_human_terminal(startup, &config));
        }
        // A config that does not load reads as Relay only below, which ends
        // browser shells too.
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
            changes.push(NodeChange::Trust);
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

/// The browser terminal switch on hot reload: off latches now (and ends
/// browser shells); on takes a restart of the relay.
fn reload_human_terminal(startup: &TerminalStartup, config: &Config) -> Option<NodeChange> {
    if !config.allow_human_terminal && startup.disable_human_terminal() {
        tracing::warn!("config.json turned browser terminals off; ending browser shells");
        return Some(NodeChange::HumanTerminalsDisabled);
    }
    if config.allow_human_terminal && !startup.allow_human_terminal() {
        tracing::warn!("config.json turns browser terminals on; that takes a restart of the relay");
    }
    None
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

/// Everything local that changed since the last look, the same way online
/// and offline: control requests first, then a hot reload when `config.json`
/// changed. A failed reload is logged and changes nothing.
fn local_changes(
    control: &mut ControlServer,
    startup: &TerminalStartup,
    node_slug: &str,
    connection: &str,
    watch: &mut ConfigWatch,
) -> Result<Vec<NodeChange>> {
    let mut changes = answer_control_requests(control, startup, node_slug, connection)?;
    if watch.changed() {
        match reload_config(startup) {
            Ok(found) => changes.extend(found),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "reloading the config failed");
            }
        }
    }
    Ok(changes)
}

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
                "caller" => "the caller is a process wsmp started",
                _ => "the relay could not apply the change; see its log",
            }
        }),
        connection: None,
        node: None,
        trust: None,
    }
}

/// Answer local control requests; returns what changed for the session.
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
                    changes.push(NodeChange::Trust);
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
            ControlCommand::Stop => {
                // Answer first: the client waits for it, and the relay then
                // unwinds through its normal shutdown on the next turn.
                let _ = control::respond(pending, &simple_response(true, "changed", None));
                tracing::info!("stopping at the request of a local `wsmp` command");
                crate::shutdown::request_stop("wsmp service");
            }
            ControlCommand::CheckCaller => {
                // No peer pid: refused, as for a raise.
                let response = match pending
                    .peer_pid
                    .map(|pid| crate::trust::started_by_wsmp(pid, std::process::id()))
                {
                    Some(Ok(())) => simple_response(true, "unchanged", None),
                    _ => simple_response(false, "refused", Some("caller")),
                };
                let _ = control::respond(pending, &response);
            }
            ControlCommand::TrustFull => {
                // No peer pid, no raise.
                let allowed = pending.peer_pid.is_some_and(|pid| {
                    crate::trust::started_by_wsmp(pid, std::process::id()).is_ok()
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
                            changes.push(NodeChange::Trust);
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
        // An update that finished installing while disconnected restarts now,
        // not on the next connection: its rollback deadline is already running.
        // (Offline, its progress frames stay queued; the new build reports.)
        let (_, restart) = link.update.poll(startup.full_control());
        if restart {
            tracing::info!("restarting into the installed update");
            return Err(
                anyhow::anyhow!("restarting into the installed update").context(
                    crate::exit::CodedError::new(crate::exit::ExitCode::RestartForUpdate),
                ),
            );
        }
        // Trust and features changed while disconnected reach the next hello;
        // only the commands outlive the connection, so a lowering here ends
        // them (the next session starts with no terminal or file op).
        let _ = local_changes(control, startup, node_slug, "reconnecting", &mut watch)?;
        if take_lowering(&mut link.lowerings_applied, startup) {
            let interrupted = link.execs.interrupt_all();
            link.deferred.extend(interrupted);
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
    requests: RelayRequests,
    terminals: TerminalRegistry,
    /// Node commands outlive a connection (daemon lifetime, `NodeLink`).
    execs: &'a mut ExecRegistry,
    /// Command statuses held until a connection is registered (across
    /// connections: [`FrameClass::Command`]).
    deferred: &'a mut Vec<OutboundFrame>,
    /// This connection's own frames held until `hello.ok`, dropped with it
    /// ([`Gate::Hold`]).
    held: Vec<OutboundFrame>,
    /// The lowering count whose effects were applied (`NodeLink`).
    lowerings_applied: &'a mut u64,
    stt: crate::stt::SttRegistry,
    files: crate::file_relay::FileRelay,
    phase: SessionPhase,
    telemetry: Option<crate::telemetry::Telemetry>,
    defines: Defines,
    runtimes: NodeRuntimes,
    /// The daemon's runner (`NodeLink::runner`), shared by every connection.
    runner: Option<&'a crate::runtimes::runner::Runner>,
    /// The daemon's inventory worker (`NodeLink::inventories`), shared by every connection.
    inventories: Arc<crate::runtimes::inventory::Inventories>,
    /// The newest instance observation applied.
    observed_generation: u64,
    /// The metric commands hash the telemetry thread runs.
    metric_commands_applied: Option<String>,
    /// The daemon's update tracker (across reconnects).
    update: &'a mut crate::update::agent::DaemonUpdate,
    /// When the node's idleness was last read for a waiting update.
    update_idle_checked: Option<Instant>,
}

/// Where one relay connection stands. Nothing but the hello may reach the
/// server before `hello.ok` (it closes the socket otherwise), so every
/// outbound frame that is not a direct answer to a server frame passes
/// [`gate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionPhase {
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
    fn is_registered(self) -> bool {
        matches!(self, Self::Registered { .. })
    }

    /// The `connection` word `wsmp status` shows.
    fn connection(self) -> &'static str {
        if self.is_registered() {
            "connected"
        } else {
            "registering"
        }
    }
}

/// What kind of node frame is about to go out, for [`gate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameClass {
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
enum Gate {
    Send,
    /// Keep it in this session until `hello.ok` ([`Session::held`]).
    Hold,
    /// Keep it for whichever connection registers next ([`Session::deferred`]).
    Defer,
    Drop,
}

/// The one policy for node frames by session phase.
fn gate(phase: SessionPhase, class: FrameClass) -> Gate {
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
fn emit<S>(
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
fn emit_control<S>(
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

/// The command lifetime cap the held node definition sets (24 h without one).
fn command_max(store: &Store) -> Duration {
    store
        .command_max_ms()
        .map_or(DEFAULT_COMMAND_MAX, Duration::from_millis)
}

/// What outlives one relay connection: the worker channel and the node
/// commands (a long command keeps running through a reconnect), plus the
/// command results that ended while disconnected and the image worker's
/// storage quota and pending cleanup, and the runtime step runner.
struct NodeLink {
    // One owner across reconnects: cleanup cannot reset or bypass the node quota.
    images: Arc<crate::terminal_images::ImageWorker>,
    worker_tx: SyncSender<FromWorker>,
    worker_rx: Receiver<FromWorker>,
    execs: ExecRegistry,
    deferred: Vec<OutboundFrame>,
    /// One runner across reconnects: a step admitted under an earlier
    /// connection still runs, and a stop under a later one cancels it
    /// (`admit_step`), and a stop's or status probe's answer says whether
    /// any step that may launch is still in flight there (`rank_idle`).
    runner: Option<crate::runtimes::runner::Runner>,
    /// The one inventory worker, across reconnects (`runtimes::inventory::Inventories`): it
    /// sends snapshots in capture order, so an older one never reaches the server after a newer
    /// one.
    inventories: Arc<crate::runtimes::inventory::Inventories>,
    /// The update in flight or awaiting confirmation, across reconnects.
    update: crate::update::agent::DaemonUpdate,
    /// The trust lowering count whose effects were applied, online or off
    /// ([`take_lowering`]).
    lowerings_applied: u64,
}

impl NodeLink {
    fn new(
        store: &Store,
        update: crate::update::agent::DaemonUpdate,
        lowerings_applied: u64,
    ) -> Result<Self> {
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
        let inventories = crate::runtimes::inventory::Inventories::start()
            .context("starting the runtime inventory worker")?;
        Ok(Self {
            images: Arc::new(crate::terminal_images::ImageWorker::new()),
            worker_tx,
            worker_rx,
            execs,
            deferred,
            runner: crate::runtimes::runner::Runner::start()
                .inspect_err(|error| {
                    tracing::warn!(
                        error = %format!("{error:#}"),
                        "runtime steps are unavailable"
                    );
                })
                .ok(),
            inventories: Arc::new(inventories),
            update,
            lowerings_applied,
        })
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
        // Step results and observations of a closed session drop (as when
        // each connection had its own runner): the next connection observes
        // afresh. Drained so the runner's threads never block on a full
        // channel while offline.
        if let Some(runner) = self.runner.as_ref() {
            while runner.try_update().is_some() {}
        }
    }
}

/// The hello `features`, with the names of the node's secrets.
fn node_features(startup: &TerminalStartup) -> crate::protocol::runtime_spec::NodeFeatures {
    let mut features = startup.features();
    features.secrets = crate::secrets::entries();
    features.self_update = Some(crate::update::agent::features());
    features
}

/// One relay connection. `progress` says how far it got (the reconnect
/// backoff reads it), whatever it returns.
#[allow(clippy::too_many_arguments)]
fn run_relay_session(
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
    let (mut socket, response) =
        connect(request).map_err(|error| relay_connect_error(error, StopOn::here()))?;
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
    // This connection's server says at `hello.ok` what it accepts; until then, nothing new.
    link.execs.set_report_ran_with(false);
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
    let identity = startup.identity().ok_or_else(|| {
        RelaySessionError::Fatal(anyhow::anyhow!(
            "CLI identity key is unavailable; cannot bind this node"
        ))
    })?;
    let (nonce, origin) = wait_for_hello_challenge(&mut socket, StopOn::here())?;
    *progress = ConnectProgress::Challenged;
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
    session.phase = SessionPhase::AwaitingHelloOk;
    *progress = ConnectProgress::HelloSent;

    let mut next_telemetry_sync = Instant::now();
    let mut next_heartbeat =
        Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
    let result = 'session: loop {
        if let Some(signal) = crate::shutdown::requested() {
            break 'session Err(RelaySessionError::Shutdown(signal));
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
        if let Err(error) = drain_worker_output(&mut socket, worker_rx, &mut session) {
            break Err(error);
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
                })
            }
            Ok(Message::Ping(bytes)) => socket
                .send(Message::Pong(bytes))
                .map_err(|error| websocket_session_error(error, "sending relay pong")),
            Ok(Message::Pong(_)) => Ok(()),
            Ok(Message::Frame(_)) => Ok(()),
            Err(tungstenite::Error::Io(err)) if read_poll_woke(&err) => Ok(()),
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

/// Mark every in-flight worker cancelled and drop their handles. Dropping each
/// body sender aborts any streaming request body; response streaming loops
/// observe the cancelled flag or fail to send and exit on their own. We do not
/// join here so a slow upstream cannot delay reconnection.
fn abort_all_workers(workers: BTreeMap<String, WorkerHandle>) {
    for (_, worker) in workers {
        worker.cancellation.cancel();
        drop(worker.body);
        // Detach: the thread exits once its upstream call unwinds.
        drop(worker.join);
    }
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
                if !session.requests.is_live(&request_id) {
                    continue;
                }
                match frame {
                    WsFrame::Text(text) => socket.send(Message::Text(text.into())),
                    WsFrame::Binary(bytes) => socket.send(Message::Binary(bytes.into())),
                }
                .map_err(|error| websocket_session_error(error, "sending relay frame"))?;
            }
            Ok(FromWorker::Finished(request_id)) => {
                session.requests.retire(&request_id, Retire::Finished);
            }
            Ok(FromWorker::TerminalBytes { terminal_id, bytes }) => {
                send_outbound_frames(socket, session.terminals.on_bytes(&terminal_id, &bytes))?;
            }
            Ok(FromWorker::TerminalEof { terminal_id }) => {
                send_outbound_frames(socket, session.terminals.on_eof(&terminal_id))?;
            }
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
            Ok(FromWorker::Telemetry(text)) => {
                if gate(session.phase, FrameClass::Periodic) == Gate::Send {
                    socket
                        .send(Message::Text(text.into()))
                        .map_err(|error| websocket_session_error(error, "sending telemetry"))?;
                }
            }
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

/// A control frame that does not parse: what it concerns (one request, one
/// terminal, one command, ...) is refused by name, or the session ends
/// ([`FrameFault::Fatal`]). The log names the frame's type and serde's message,
/// which names the field that failed.
fn handle_unreadable<S>(
    socket: &mut tungstenite::WebSocket<S>,
    session: &mut Session,
    text: &str,
    error: &anyhow::Error,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let value = serde_json::from_str::<serde_json::Value>(text).ok();
    let frame_type = value
        .as_ref()
        .and_then(|value| value.get("type")?.as_str().map(str::to_owned));
    // The JSON path that failed, when serde can place it (`$` when it cannot).
    let path = value
        .as_ref()
        .and_then(crate::runtime_store::repair::first_error::<ServerFrame>)
        .map(|(path, _)| path);
    tracing::warn!(
        frame_type = frame_type.as_deref().unwrap_or("(none)"),
        path = path.as_deref().unwrap_or("(unknown)"),
        error = %format!("{error:#}"),
        "a relay frame could not be read"
    );
    let fault = control_frame_fault(text);
    if let Some(result) = apply_stt_fault(socket, &mut session.stt, &fault) {
        return result;
    }
    apply_frame_fault(socket, fault, &mut session.terminals, session.execs, error)
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
    // A `runtime.define` with one definition (or a node part) this build cannot
    // read: those parts are refused by id and the rest is handled, instead of
    // the whole frame ending the session (`runtime_store::repair`).
    let mut repaired_text = None;
    let mut define_refusals = None;
    let frame = match parse_server_control(text) {
        Ok(frame) => frame,
        Err(error) => {
            if let Some(repaired) = crate::runtime_store::repair::repair_runtime_define(
                text,
                parse_server_control,
                |part| {
                    tracing::warn!(
                        part = %part.part,
                        path = %part.path,
                        error = %part.error,
                        "refusing a runtime definition this wsmp cannot read"
                    );
                },
            ) {
                repaired_text = Some(repaired.text);
                define_refusals = Some(repaired.refusals);
                repaired.frame
            } else {
                return handle_unreadable(socket, session, text, &error);
            }
        }
    };
    let text = repaired_text.as_deref().unwrap_or(text);
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
            features,
            ..
        } => {
            if session.phase.is_registered() {
                return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                    "duplicate relay registration acknowledgement"
                )));
            }
            session.phase = SessionPhase::Registered {
                since: Instant::now(),
            };
            // Optional node frame fields go only to a server that said it accepts them.
            session
                .execs
                .set_report_ran_with(features.unwrap_or_default().exec_ran_with);
            tracing::info!(id, node_id, ?definition_sync, "relay registration accepted");
            session.update.on_hello_ok(
                definition_sync,
                features.unwrap_or_default().agent_update_available_version,
            );
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
                });
            }
            if session.phase.is_registered() {
                return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                    "relay protocol error: {message}"
                )));
            }
            return Err(hello_rejection(&message, Some(&code), StopOn::here()));
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
            let is_final = matches!(frame, ServerFrame::RuntimeDefine { is_final: true, .. });
            match session.defines.handle(text, &frame, &ctx, &live) {
                Ok(mut outcome) => {
                    if let Some(refusals) = &define_refusals {
                        refusals.merge_into(&mut outcome.answer);
                    }
                    send_control(socket, &outcome.answer, "answering a runtime definition")?;
                    if is_final {
                        session.update.on_definitions_applied();
                    }
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
        ServerFrame::AgentUpdate {
            update_id,
            version,
            artifact_url,
            sha256,
            signature,
            force,
            rollback_after_secs,
        } => {
            let identity = crate::update::build::identity();
            // Taken first: a lowering from here on revokes the update, at once.
            let trust = startup.trust_watch();
            let gate = crate::update::agent::Gate {
                full_control: startup.full_control(),
                remote: Config::load_required()
                    .map(|config| config.remote_updates)
                    .unwrap_or_default(),
                method: identity.method,
                has_live: identity.live.is_some(),
                under_service: under_service_manager(),
            };
            tracing::info!(update_id, version, force, "update requested");
            let frames = session.update.request(
                crate::update::agent::UpdateFrame {
                    update_id,
                    version,
                    artifact_url,
                    sha256,
                    signature,
                    force,
                    rollback_after_secs,
                },
                &gate,
                trust,
            );
            for frame in frames {
                send_control(socket, &frame, "answering an update")?;
            }
        }
        ServerFrame::AgentUpdateAck { update_id } => session.update.acked(&update_id),
        ServerFrame::RuntimeDetect { id } => {
            // Off this loop: a scan takes seconds. Ports the node's own
            // instances hold are runtimes already, not discoveries.
            crate::runtimes::detect::spawn(
                session.worker_tx.clone(),
                id,
                session.runtimes.busy_ports().into_keys().collect(),
            );
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
            handle_runtime_job(socket, startup, session, *job)?;
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
            if session.requests.retire(&request_id, Retire::Cancelled) {
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
                &mut session.requests,
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
            shell,
        } => {
            send_outbound_frames(
                socket,
                session.terminals.open(
                    startup,
                    state_dir.as_deref(),
                    TermHandshake {
                        terminal_id: &terminal_id,
                        viewer_id: viewer_id.as_deref(),
                        cols,
                        rows,
                        browser_public_key: &browser_public_key,
                        browser_nonce: &browser_nonce,
                        identity: identity.as_ref(),
                        shell: shell.as_deref(),
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
                        shell: None,
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
            argv,
            shell,
            cwd,
            timeout_ms,
        } => {
            // The frame rules let exactly one of `command` and `argv` through.
            if session.update.holds_new_work() {
                return send_control(
                    socket,
                    &NodeFrame::ExecRejected {
                        command_id,
                        reason: "updating".into(),
                    },
                    "refusing a command during an update",
                );
            }
            let line = match (&command, &argv) {
                (Some(text), _) => ExecLine::Text(text),
                (None, Some(argv)) => ExecLine::Argv(argv),
                (None, None) => ExecLine::Argv(&[]),
            };
            send_outbound_frames(
                socket,
                session.execs.start(
                    startup,
                    &command_id,
                    &line,
                    shell,
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
            send_file_frames(
                socket,
                session.files.handle_op(
                    &op_id,
                    crate::file_relay::op_name(op),
                    args,
                    body_bytes.and_then(|bytes| usize::try_from(bytes).ok()),
                ),
            )?;
        }
        ServerFrame::FileCancel { op_id } => {
            session.files.handle_cancel(&op_id);
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
    apply_node_changes(socket, startup, session, &[NodeChange::Trust])
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
fn apply_node_changes<S>(
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
        .set_command_max(command_max(&session.runtimes.store));
    sync_metric_commands(session);
    emit_control(socket, session, FrameClass::NodeState, node_state(startup))
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
        rank_idle: None,
    };
    // About to restart into a new build: nothing new starts (the server sends
    // a start refused this way again, without counting an attempt).
    if session.update.holds_new_work()
        && matches!(
            job.phase,
            JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
        )
    {
        return send_control(
            socket,
            &refusal(
                JobError::SessionDisconnected,
                Some("wsmp is restarting into an update".into()),
            ),
            "refusing a runtime step during an update",
        );
    }
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
        let recorded =
            crate::runtimes::runner::recorded_job(&job.instance_id, job.rank).filter(|known| {
                known.version_id == job.launch_version_id
                    && known.launch_hash == job.launch_hash
                    && known.unit_name == job.unit_name
                    && known.handle == job.handle
                    && known.runtime_id == job.runtime_id
            });
        // A stop, and a status probe proving one, also work after the server dropped it.
        if !held && job.phase != JobPhase::Stop && job.phase != JobPhase::Status {
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
                Some(operator_ticket(&job, operator, &rendered))
            }
        };
        // Live speech-to-text sessions on the instance end before its stop
        // runs, and none opens there meanwhile.
        let ended = stt_step_submitting(&mut session.stt, &job);
        send_stt_frames(socket, &mut session.stt, ended)?;
        let submitted = match (session.runner.as_ref(), ticket) {
            (Some(runner), Some(ticket)) => runner.submit_operator(rendered, ticket),
            (Some(runner), None) => runner.submit(rendered),
            (None, _) => Err(anyhow::anyhow!("runtime steps are unavailable")),
        };
        stt_step_submitted(&mut session.stt, &job, submitted.is_ok());
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
}

/// What a runtime step about to be submitted does to live speech-to-text:
/// a stop ends the sessions on its instance's endpoint (its handle) and
/// marks the endpoint, so none opens there until the stop is settled
/// ([`crate::stt::SttRegistry::endpoint_stopping`]). Every rank's stop marks
/// the handle; only the node running rank 0 serves it, and the endpoint
/// check drops a mark on an endpoint this node does not serve.
fn stt_step_submitting(
    stt: &mut crate::stt::SttRegistry,
    job: &crate::protocol::frames::RuntimeJob,
) -> Vec<NodeFrame> {
    if job.phase == JobPhase::Stop {
        stt.endpoint_stopping(&job.handle, &job.step_id)
    } else {
        Vec::new()
    }
}

/// After the runner took (`admitted`) or refused a runtime step: a refused
/// stop leaves its endpoint serving; an admitted start lifts the stop mark,
/// at once if the stop is done, else when it finishes.
fn stt_step_submitted(
    stt: &mut crate::stt::SttRegistry,
    job: &crate::protocol::frames::RuntimeJob,
    admitted: bool,
) {
    match job.phase {
        JobPhase::Stop if !admitted => stt.stop_failed(&job.step_id),
        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin if admitted => {
            stt.endpoint_starting(&job.handle);
        }
        _ => {}
    }
}

/// A runtime step its runner thread is done with: a stop that succeeded
/// may let a waiting start take sessions again; one that failed (or whose
/// operator terminal closed without success) leaves its endpoint serving.
/// Any other step's id names no mark.
fn stt_step_ended(stt: &mut crate::stt::SttRegistry, ended: &crate::runtimes::runner::StepEnded) {
    if ended.succeeded {
        stt.stop_finished(&ended.step_id);
    } else {
        stt.stop_failed(&ended.step_id);
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
    // The job's reservations, else those of the launch it checks or stops.
    let reservations = if job.reservations.is_empty() {
        known.reservations.clone()
    } else {
        job.reservations.clone()
    };
    Ok(Job {
        step_id: job.step_id.clone(),
        action: job.phase,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        timeout_ms: job.timeout_ms.clamp(1, 3_600_000),
        command: String::new(),
        reservations,
        ..known
    })
}

/// The operator ticket of an admitted interactive job. The screen shows
/// what the node itself rendered (or recorded), never server-supplied text.
fn operator_ticket(
    job: &crate::protocol::frames::RuntimeJob,
    operator: &crate::protocol::frames::JobOperator,
    rendered: &Job,
) -> crate::runtimes::runner::OperatorTicket {
    let command = rendered.operator_cmd().script.to_string();
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
        base_env: crate::sessions::operator_base_env(),
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
///
/// Operator terminal frames and step results are this connection's own
/// ([`FrameClass::SessionScoped`]): one that lands between the hello and
/// `hello.ok` is held until `hello.ok` (it used to be dropped there, which
/// lost a step result the server was waiting for).
fn drain_runner<S>(
    socket: &mut tungstenite::WebSocket<S>,
    session: &mut Session,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    use crate::runtimes::runner::{OperatorRequest, Update};
    while let Some(update) = session
        .runner
        .as_ref()
        .and_then(|runner| runner.try_update())
    {
        match update {
            Update::Operator(request) => {
                let frames = match request {
                    OperatorRequest::Open(open) => session.terminals.open_operator(*open),
                    OperatorRequest::CloseIfConfirming { terminal_id } => {
                        session.terminals.close_operator_if_confirming(&terminal_id)
                    }
                };
                emit(socket, session, FrameClass::SessionScoped, frames)?;
            }
            Update::Observation {
                generation,
                result,
                ended,
                instances,
            } => {
                if generation > session.observed_generation {
                    session.observed_generation = generation;
                    session.runtimes.set_instances(instances);
                }
                if let Some(ended) = &ended {
                    stt_step_ended(&mut session.stt, ended);
                }
                // An operator step's runner thread is done with its terminal id.
                if let Some(NodeFrame::RuntimeJobResult {
                    terminal_id: Some(terminal_id),
                    ..
                }) = &result
                {
                    session.terminals.release_operator(terminal_id);
                }
                if let Some(result) = result {
                    emit_control(socket, session, FrameClass::SessionScoped, result)?;
                }
                // `hello.ok` sends one anyway.
                if session.phase.is_registered() {
                    send_inventory(session);
                }
            }
        }
    }
    Ok(())
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
    session.inventories.capture(
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
    requests: &mut RelayRequests,
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
    if requests.in_use(&request_id) {
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
    if !crate::runtimes::allowlist::allowed(&target.spec, &method, &path)
        && !crate::runtimes::allowlist::engine_description_allowed(
            &target.spec,
            &target.endpoint.base_url,
            &method,
            &path,
        )
    {
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
        requests.start(
            request_id,
            WorkerHandle {
                body: RequestBody::Open(body_tx),
                cancellation,
                join: handle,
            },
        );
        return Ok(());
    }

    let (cancellation, cancellation_rx) = CancellationHandle::new();
    let thread_tx = worker_tx.clone();
    let thread_cancellation = cancellation.clone();

    let (body, body_rx) = if expect_body {
        // The server may send every credited chunk before this just-spawned
        // worker gets scheduled. Credits are returned only after a chunk has
        // entered the async handoff, keeping the total unacknowledged burst
        // bounded by the negotiated window.
        let (tx, rx) = mpsc::sync_channel::<BodyChunk>(REQUEST_BODY_INGRESS_CAPACITY);
        (RequestBody::Open(tx), Some(rx))
    } else {
        (RequestBody::None, None)
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

    requests.start(
        request_id,
        WorkerHandle {
            body,
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
        .map_err(|error| websocket_session_error(error, "sending a speech-to-text frame"))
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
        FrameFault::RejectUpdate { update_id } => {
            tracing::warn!(update_id, "refusing a malformed update request");
            send_control(
                socket,
                &NodeFrame::AgentUpdateProgress {
                    update_id,
                    phase: crate::protocol::frames::UpdatePhase::Failed,
                    reason: Some(crate::protocol::frames::UpdateReason::Internal),
                    detail: Some("the node could not read this `agent.update`".into()),
                    available_version: None,
                },
                "refusing an update",
            )
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
            send_file_frames(socket, session.files.handle_body(&op_id, body))?;
            return Ok(());
        }
        ServerBinaryMetadata::SttAudio { session_id, seq } => {
            let frames = session.stt.audio(&session_id, seq, body);
            return send_stt_frames(socket, &mut session.stt, frames);
        }
    };

    let last = is_final == Some(true);
    let requests = &mut session.requests;
    let worker = match requests.state(&request_id) {
        RequestState::Live(worker) => worker,
        // A fast upstream responded and was reaped before the server
        // flushed the body tail: expected, dropped silently.
        RequestState::Retired => {
            tracing::debug!(
                request_id = request_id,
                "dropping late relay body chunk for an already-finished request"
            );
            return Ok(());
        }
        // Only a genuinely unknown id is a protocol violation.
        RequestState::Unknown => {
            send_relay_error(
                socket,
                &request_id,
                RelayFailure::ProtocolError,
                Some("request body chunk arrived before request metadata".to_string()),
                None,
            )?;
            return Ok(());
        }
    };
    let body_tx = match &worker.body {
        RequestBody::Open(body_tx) => body_tx,
        RequestBody::Complete => {
            // The server never sends past `isFinal`; nothing reads it.
            tracing::warn!(
                request_id = request_id,
                "dropping a relay body chunk after the final one"
            );
            return Ok(());
        }
        RequestBody::None => {
            // Body frame for a request that declared no body.
            requests.retire(&request_id, Retire::Faulted);
            send_relay_error(
                socket,
                &request_id,
                RelayFailure::ProtocolError,
                Some("unexpected request body chunk for a body-less request".to_string()),
                None,
            )?;
            return Ok(());
        }
    };

    tracing::debug!(
        request_id = request_id,
        bytes = body.len(),
        "received relay request body chunk"
    );

    match deliver_body_chunk(body_tx, body, last) {
        BodyRoute::Delivered | BodyRoute::WorkerGone => {
            // Gone: upstream already finished or rejected the request early;
            // further body frames drop and the worker reports the outcome.
            if last {
                // Queued chunks still reach the worker after the sender drops.
                worker.body = RequestBody::Complete;
            }
            Ok(())
        }
        BodyRoute::OverCredit => {
            requests.retire(&request_id, Retire::Faulted);
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
    let mut phase = ResponsePhase::Requesting;
    let result = upstream_runtime().and_then(|runtime| {
        runtime.block_on(execute_upstream_tracked(
            spec,
            body_rx,
            &tx,
            cancellation_rx,
            &mut phase,
        ))
    });
    if !cancellation.cancelled.load(Ordering::SeqCst)
        && let Err(error) = result
        && let Some(frame) = upstream_failure_frame(&request_id, phase)
    {
        match phase {
            ResponsePhase::Requesting => {
                tracing::warn!(error = %error, "relay upstream request failed");
            }
            _ => tracing::warn!(
                error = %error,
                ?phase,
                "relay upstream response failed after its headers"
            ),
        }
        let _ = worker_send_control(&tx, &frame);
    }
    let _ = tx.send(FromWorker::Finished(request_id));
}

/// How far a relayed response got: what a failure ends it with
/// ([`upstream_failure_frame`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResponsePhase {
    /// No `relay.response.headers` went out yet.
    Requesting,
    /// Headers went out; body chunks are streaming.
    Streaming,
    /// The final (empty) body chunk went out; `relay.complete` has not.
    BodyEnded,
    /// `relay.complete` went out: the request is settled.
    Completed,
}

/// The frame that ends a failed upstream request, by how far its response
/// got. The server settles a request on `relay.error` in any phase before
/// `relay.complete` (headers already sent or not), so every phase but
/// [`ResponsePhase::Completed`] gets the same `transport` error as before.
fn upstream_failure_frame(request_id: &str, phase: ResponsePhase) -> Option<NodeFrame> {
    match phase {
        ResponsePhase::Requesting | ResponsePhase::Streaming | ResponsePhase::BodyEnded => {
            Some(NodeFrame::RelayError {
                request_id: request_id.to_string(),
                failure: RelayFailure::Transport,
                message: Some("upstream request failed".to_string()),
                upstream_status_code: None,
            })
        }
        ResponsePhase::Completed => None,
    }
}

/// [`execute_upstream_tracked`] when the caller does not need the phase.
#[cfg(test)]
async fn execute_upstream(
    spec: UpstreamRequestSpec,
    body_rx: Option<Receiver<BodyChunk>>,
    tx: &SyncSender<FromWorker>,
    cancellation_rx: watch::Receiver<bool>,
) -> Result<()> {
    let mut phase = ResponsePhase::Requesting;
    execute_upstream_tracked(spec, body_rx, tx, cancellation_rx, &mut phase).await
}

async fn execute_upstream_tracked(
    spec: UpstreamRequestSpec,
    body_rx: Option<Receiver<BodyChunk>>,
    tx: &SyncSender<FromWorker>,
    mut cancellation_rx: watch::Receiver<bool>,
    phase: &mut ResponsePhase,
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
            relay_response_back(response, &spec, tx, &mut cancellation_rx, phase).await
        }
    }
}

/// Stream an upstream HTTP response back to the server as relay frames.
async fn relay_response_back(
    response: reqwest::Response,
    spec: &UpstreamRequestSpec,
    tx: &SyncSender<FromWorker>,
    cancellation_rx: &mut watch::Receiver<bool>,
    phase: &mut ResponsePhase,
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
    *phase = ResponsePhase::Streaming;

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
    *phase = ResponsePhase::BodyEnded;
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
    *phase = ResponsePhase::Completed;
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
                    .map_err(|error| websocket_session_error(error, "sending a file op frame"))?;
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
                        websocket_session_error(error, "sending terminal or exec frame")
                    })?;
            }
        }
    }
    Ok(())
}

fn old_server_upgrade_error(stop: StopOn) -> RelaySessionError {
    protocol_mismatch(
        anyhow::anyhow!(
            "the server did not complete the relay handshake for protocol {RELAY_PROTOCOL_VERSION}; upgrade the WS Model Proxy server"
        ),
        stop,
    )
}

/// A refusal before `hello.ok` that the same binary cannot get past by
/// retrying soon. Where stopping is safe ([`StopOn`]) it exits with its own
/// code, which the systemd unit does not restart: a protocol mismatch exits
/// 5, a credential enrolled with another identity exits 4. A malformed-frame
/// refusal is a bug and exits 1. Elsewhere the relay keeps the message in its
/// log and retries only every few minutes, so a service manager that
/// relaunches every exit (launchd) cannot turn it into a storm. An
/// `access_denied` (revoked credential, an owner who is not active, a
/// rebound credential) may clear up by itself (an owner reactivated): it is
/// always retried slowly.
fn hello_rejection(
    message: &str,
    code: Option<&ProtocolErrorCode>,
    stop: StopOn,
) -> RelaySessionError {
    let text = hello_rejection_message(message, code);
    match code {
        None | Some(ProtocolErrorCode::UpgradeCli | ProtocolErrorCode::UpgradeServer) => {
            protocol_mismatch(anyhow::anyhow!(text), stop)
        }
        Some(ProtocolErrorCode::AccessDenied) => unrecoverable(
            anyhow::anyhow!(
                "{text}; if this machine's credential was revoked, run `wsmp login` to enroll it again"
            ),
            crate::exit::ExitCode::CredentialRejected,
            false,
        ),
        Some(ProtocolErrorCode::IdentityMismatch) => unrecoverable(
            anyhow::anyhow!("{text}; run `wsmp login` to enroll this machine again"),
            crate::exit::ExitCode::CredentialRejected,
            stop.credential,
        ),
        Some(
            ProtocolErrorCode::Malformed | ProtocolErrorCode::Internal | ProtocolErrorCode::Unknown,
        ) => RelaySessionError::Fatal(anyhow::anyhow!(text)),
    }
}

fn protocol_mismatch(error: anyhow::Error, stop: StopOn) -> RelaySessionError {
    // A unit written before exit 5 existed restarts on it: retry slowly there,
    // and say how to get the unit that stops instead.
    let error = if !stop.protocol && stop.credential {
        error.context(
            "this wsmp.service predates the protocol-mismatch exit code; after installing the matching wsmp, \
             run `wsmp service install` to update it",
        )
    } else {
        error
    };
    unrecoverable(
        error,
        crate::exit::ExitCode::RelayProtocolMismatch,
        stop.protocol,
    )
}

/// Stops with `code` where stopping is safe; elsewhere retries no sooner than
/// the backoff cap.
fn unrecoverable(
    error: anyhow::Error,
    code: crate::exit::ExitCode,
    stop: bool,
) -> RelaySessionError {
    if stop {
        RelaySessionError::Fatal(error.context(crate::exit::CodedError::new(code)))
    } else {
        RelaySessionError::Reconnectable {
            error: error.context(RetryFloor {
                delay: RELAY_RECONNECT_MAX_DELAY,
                source: RetryFloorSource::Refusal,
            }),
        }
    }
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

/// A reply to the hello wait that 3.0 parsing refused, read loosely:
/// an older server sends `protocol.error` without a code, or a challenge
/// without an origin. Both mean "upgrade the server".
fn older_server_reply(text: &str, stop: StopOn) -> Option<RelaySessionError> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    match value.get("type").and_then(serde_json::Value::as_str)? {
        "protocol.error" => {
            let message = value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("protocol error");
            Some(hello_rejection(message, None, stop))
        }
        "hello.challenge" => Some(old_server_upgrade_error(stop)),
        _ => None,
    }
}

fn wait_for_hello_challenge<S>(
    socket: &mut tungstenite::WebSocket<S>,
    stop: StopOn,
) -> RelaySessionResult<(String, String)>
where
    S: std::io::Read + std::io::Write,
{
    let deadline = Instant::now() + HELLO_CHALLENGE_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err(RelaySessionError::Reconnectable {
                error: anyhow::anyhow!(
                    "the server sent no hello.challenge within {} s (a server older than relay protocol {RELAY_PROTOCOL_VERSION} never does; upgrade it if this repeats)",
                    HELLO_CHALLENGE_TIMEOUT.as_secs()
                ),
            });
        }
        if let Some(signal) = crate::shutdown::requested() {
            return Err(RelaySessionError::Shutdown(signal));
        }
        match socket.read() {
            Ok(Message::Text(text)) => match parse_server_control(&text) {
                Ok(ServerFrame::HelloChallenge { nonce, origin }) => {
                    if origin.is_empty() {
                        return Err(old_server_upgrade_error(stop));
                    }
                    return Ok((nonce, origin));
                }
                Ok(ServerFrame::ProtocolError { message, code, .. }) => {
                    if code == ProtocolErrorCode::Internal {
                        return Err(RelaySessionError::Reconnectable {
                            error: anyhow::anyhow!("relay protocol error: {message}"),
                        });
                    }
                    return Err(hello_rejection(&message, Some(&code), stop));
                }
                Ok(_) => {
                    return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                        "expected hello.challenge, received another control frame"
                    )));
                }
                Err(error) => {
                    if let Some(refusal) = older_server_reply(&text, stop) {
                        return Err(refusal);
                    }
                    return Err(RelaySessionError::Reconnectable {
                        error: anyhow::anyhow!("invalid hello.challenge frame: {error}"),
                    });
                }
            },
            Ok(Message::Ping(bytes)) => {
                socket
                    .send(Message::Pong(bytes))
                    .map_err(|error| websocket_session_error(error, "sending relay pong"))?;
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
                });
            }
            Err(tungstenite::Error::Io(err)) if read_poll_woke(&err) => {}
            Err(err) => {
                return Err(websocket_session_error(err, "reading hello.challenge"));
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
        .map_err(|error| websocket_session_error(error, context))
}

/// Set by the systemd unit `wsmp service install` writes, which also lists
/// exit 4 in `RestartPreventExitStatus=`: there, stopping on an unusable
/// credential cannot turn into a restart loop.
pub const STOP_ON_REJECTED_CREDENTIAL_ENV: &str = "WSMP_STOP_ON_REJECTED_CREDENTIAL";

/// Whether a missing or rejected credential stops the relay (exit 4), and a
/// refused relay protocol stops it (exit 5), rather than being retried
/// in-process (with the normal backoff, capped at 5 min).
/// It stops under the systemd unit (which does not restart on exit 4) and in
/// an interactive terminal (where a person sees the message). Elsewhere, such
/// as a macOS LaunchAgent (`KeepAlive` relaunches every exit) or a detached
/// daemon, exiting would only restart or lose the relay, so it keeps retrying
/// and picks up a new `wsmp login` by itself.
fn stop_on_unusable_credential() -> bool {
    std::env::var_os(STOP_ON_REJECTED_CREDENTIAL_ENV).is_some_and(|value| value == "1")
        || person_watching()
}

/// Set by `wsmp run --service`: a service manager started this relay. The
/// Windows task runs it under `conhost --headless`, whose console stderr is
/// a terminal that nobody sees.
static AS_SERVICE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn run_as_service() {
    AS_SERVICE.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Whether the installed relay service runs this relay, so an exit is
/// restarted: the systemd unit `wsmp service install` writes (it sets
/// [`STOP_ON_REJECTED_CREDENTIAL_ENV`]), its launchd agent (launchd names the
/// job in `XPC_SERVICE_NAME`), or the Windows task (`wsmp run --service`).
pub fn under_service_manager() -> bool {
    if cfg!(target_os = "macos") {
        return std::env::var("XPC_SERVICE_NAME").is_ok_and(|name| name == "com.flycockpit.wsmp");
    }
    if cfg!(windows) {
        return AS_SERVICE.load(std::sync::atomic::Ordering::SeqCst);
    }
    std::env::var_os(STOP_ON_REJECTED_CREDENTIAL_ENV).is_some_and(|value| value == "1")
}

/// Whether a person sees this relay's stderr: a terminal, and not a service.
fn person_watching() -> bool {
    use std::io::IsTerminal;
    !AS_SERVICE.load(std::sync::atomic::Ordering::SeqCst) && std::io::stderr().is_terminal()
}

/// Set by a systemd unit that also lists exit 5 in `RestartPreventExitStatus=`
/// (units written before exit 5 existed do not set it, and would restart on
/// it every 5 seconds).
pub const STOP_ON_PROTOCOL_MISMATCH_ENV: &str = "WSMP_STOP_ON_PROTOCOL_MISMATCH";

/// Where an unrecoverable refusal may stop the relay instead of retrying it
/// slowly: `credential` (exit 4, see [`stop_on_unusable_credential`]) and
/// `protocol` (exit 5: a unit that does not restart on it, or a terminal).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StopOn {
    credential: bool,
    protocol: bool,
}

impl StopOn {
    fn here() -> Self {
        Self {
            credential: stop_on_unusable_credential(),
            protocol: std::env::var_os(STOP_ON_PROTOCOL_MISMATCH_ENV)
                .is_some_and(|value| value == "1")
                || person_watching(),
        }
    }

    #[cfg(test)]
    const ALL: Self = Self {
        credential: true,
        protocol: true,
    };
    #[cfg(test)]
    const NONE: Self = Self {
        credential: false,
        protocol: false,
    };
}

/// Whether a 426 body is the server's relay protocol refusal (`upgrade_cli`,
/// with the subprotocol it speaks), not a proxy's or the server's plain
/// "WebSocket upgrade required" (an `Upgrade` header lost on the way).
fn refuses_relay_protocol(body: Option<&[u8]>) -> bool {
    body.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
        .is_some_and(|value| {
            value.get("code").and_then(serde_json::Value::as_str) == Some("upgrade_cli")
                || value.get("supportedSubprotocol").is_some()
        })
}

/// The longest `Retry-After` the relay honours; a longer one waits this long.
const RELAY_RETRY_AFTER_MAX: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryFloorSource {
    /// The server's `Retry-After` header.
    Server,
    /// A refusal that retrying soon cannot fix.
    Refusal,
}

/// The least time the reconnect loop waits before the next attempt. Attached
/// to a reconnectable error as context, so it also shows in the logged chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryFloor {
    delay: Duration,
    source: RetryFloorSource,
}

impl std::fmt::Display for RetryFloor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.source {
            RetryFloorSource::Server => write!(
                f,
                "the server asked to wait {} s (Retry-After) before reconnecting",
                self.delay.as_secs()
            ),
            RetryFloorSource::Refusal => write!(
                f,
                "retrying in {} s; restarting wsmp unchanged cannot fix this",
                self.delay.as_secs()
            ),
        }
    }
}

impl std::error::Error for RetryFloor {}

/// The wait floor a reconnectable error carries, if any.
fn retry_floor(error: &anyhow::Error) -> Option<Duration> {
    // A `.context(RetryFloor)` is found by anyhow's downcast; the chain walk
    // finds one nested inside another error.
    error
        .downcast_ref::<RetryFloor>()
        .or_else(|| {
            error
                .chain()
                .find_map(|cause| cause.downcast_ref::<RetryFloor>())
        })
        .map(|floor| floor.delay)
}

/// How long to wait before reconnecting: the backoff with up to 20% taken off
/// at random (so many nodes do not reconnect in step, and the cap holds), and
/// never less than `floor` (plus up to 10%, for the same reason).
fn reconnect_wait(backoff: Duration, floor: Option<Duration>) -> Duration {
    let jittered = backoff.mul_f64(rand::random_range(0.8..=1.0));
    match floor {
        Some(floor) => jittered.max(floor.mul_f64(rand::random_range(1.0..=1.1))),
        None => jittered,
    }
}

/// A `Retry-After` in delta-seconds (the form this server sends), capped at
/// [`RELAY_RETRY_AFTER_MAX`]. An HTTP-date form is ignored.
fn retry_after_header(response: &tungstenite::http::Response<Option<Vec<u8>>>) -> Option<Duration> {
    let seconds = response
        .headers()
        .get(tungstenite::http::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(Duration::from_secs(seconds).min(RELAY_RETRY_AFTER_MAX))
}

/// Classify a failed relay websocket handshake. A 401 means the server
/// rejected the credential (revoked, replaced by a newer login, invalid, or
/// temporarily banned); with `stop` it is fatal and asks for `wsmp login`,
/// otherwise it is retried with backoff. A 426 means the server refused this
/// wsmp's relay protocol (exit 5 with `stop`). Everything else, including a
/// 403 from a proxy or firewall in front of the server, 429 and 5xx,
/// reconnects, no sooner than a `Retry-After` the server sent.
fn relay_connect_error(error: tungstenite::Error, stop: StopOn) -> RelaySessionError {
    if let tungstenite::Error::Http(response) = &error
        && response.status().as_u16() == 401
    {
        let rejected = anyhow::anyhow!(
            "the server rejected this machine's relay credential (HTTP 401); it is revoked or invalid. Run `wsmp login` to sign in again"
        );
        return if stop.credential {
            RelaySessionError::Fatal(rejected.context(crate::exit::CodedError::new(
                crate::exit::ExitCode::CredentialRejected,
            )))
        } else {
            RelaySessionError::Reconnectable { error: rejected }
        };
    }
    if let tungstenite::Error::Http(response) = &error
        && response.status().as_u16() == 426
        && refuses_relay_protocol(response.body().as_deref())
    {
        return protocol_mismatch(
            anyhow::Error::new(error).context(format!(
                "the server refused relay protocol {RELAY_PROTOCOL_VERSION} (HTTP 426); \
                 install the server's build by re-running its install.sh \
                 (`curl -fsSL https://<your server>/install.sh | sh`), then restart wsmp"
            )),
            stop,
        );
    }
    let retry_after = match &error {
        tungstenite::Error::Http(response) => retry_after_header(response),
        _ => None,
    };
    let upgrade_lost =
        matches!(&error, tungstenite::Error::Http(response) if response.status().as_u16() == 426);
    let error = anyhow::Error::new(error).context("opening relay websocket");
    let error = if upgrade_lost {
        error.context(
            "the WebSocket upgrade did not reach the relay (HTTP 426 without a protocol refusal); \
             check that the proxy in front of the server forwards WebSocket upgrades",
        )
    } else {
        error
    };
    RelaySessionError::Reconnectable {
        error: match retry_after {
            Some(delay) => error.context(RetryFloor {
                delay,
                source: RetryFloorSource::Server,
            }),
            None => error,
        },
    }
}

fn websocket_session_error(error: tungstenite::Error, context: &'static str) -> RelaySessionError {
    match error {
        error @ (tungstenite::Error::ConnectionClosed
        | tungstenite::Error::AlreadyClosed
        | tungstenite::Error::Io(_)
        | tungstenite::Error::Tls(_)) => RelaySessionError::Reconnectable {
            error: anyhow::Error::new(error).context(context),
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

    fn idle_worker(body: RequestBody) -> (WorkerHandle, CancellationHandle) {
        let (cancellation, _receiver) = CancellationHandle::new();
        (
            WorkerHandle {
                body,
                cancellation: cancellation.clone(),
                join: thread::spawn(|| {}),
            },
            cancellation,
        )
    }

    #[test]
    fn cancelled_worker_suppresses_queued_late_frames() {
        let mut requests = RelayRequests::new();
        let (worker, cancellation) = idle_worker(RequestBody::None);
        requests.start("request-1".to_string(), worker);
        assert!(requests.is_live("request-1"));
        assert!(requests.retire("request-1", Retire::Cancelled));
        assert!(cancellation.cancelled.load(Ordering::SeqCst));
        assert!(!requests.is_live("request-1"));
        // Retired: in use (a reuse is a fault), and late frames are expected.
        assert!(requests.in_use("request-1"));
        assert!(matches!(requests.state("request-1"), RequestState::Retired));
        assert!(matches!(requests.state("other"), RequestState::Unknown));
        // A second retire finds nothing live (no second `relay.cancelled`).
        assert!(!requests.retire("request-1", Retire::Cancelled));
    }

    #[test]
    fn every_retire_reason_records_the_id_and_only_finished_joins() {
        for reason in [Retire::Finished, Retire::Cancelled, Retire::Faulted] {
            let mut requests = RelayRequests::new();
            let (worker, cancellation) = idle_worker(RequestBody::None);
            requests.start("r".to_string(), worker);
            assert!(requests.retire("r", reason));
            assert!(matches!(requests.state("r"), RequestState::Retired));
            assert_eq!(
                cancellation.cancelled.load(Ordering::SeqCst),
                reason != Retire::Finished,
                "{reason:?}"
            );
        }
    }

    /// A chunk after `isFinal` is dropped (nothing reads it any more) and
    /// changes nothing: no fault, the request stays live.
    #[test]
    fn a_body_chunk_after_the_final_one_is_dropped() {
        let mut socket = sink_socket();
        let mut requests = RelayRequests::new();
        let (tx, rx) = mpsc::sync_channel::<BodyChunk>(REQUEST_BODY_INGRESS_CAPACITY);
        let (worker, _cancellation) = idle_worker(RequestBody::Open(tx));
        requests.start("req-1".to_string(), worker);
        let chunk = |data: &[u8], last: bool, requests: &mut RelayRequests| {
            let RequestState::Live(worker) = requests.state("req-1") else {
                panic!("live");
            };
            match &worker.body {
                RequestBody::Open(body_tx) => {
                    assert!(matches!(
                        deliver_body_chunk(body_tx, data.to_vec(), last),
                        BodyRoute::Delivered
                    ));
                    if last {
                        worker.body = RequestBody::Complete;
                    }
                    true
                }
                _ => false,
            }
        };
        assert!(chunk(b"a", false, &mut requests));
        assert!(chunk(b"b", true, &mut requests));
        assert!(!chunk(b"late", false, &mut requests));
        // Both chunks still reach the worker after the sender dropped.
        assert_eq!(rx.recv().expect("first").data, b"a");
        let last = rx.recv().expect("last");
        assert!(last.last);
        assert!(rx.recv().is_err());
        assert!(requests.is_live("req-1"));
        assert!(socket.get_mut().written.is_empty());
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
                wait_for_hello_challenge(&mut socket, StopOn::ALL),
                Err(RelaySessionError::Reconnectable { .. })
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
            wait_for_hello_challenge(&mut socket, StopOn::ALL),
            Err(RelaySessionError::Reconnectable { .. })
        ));
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"protocol.error","failure":"protocol_error","message":"Registration was not received in time."}"#
                .into(),
        ));
        match wait_for_hello_challenge(&mut socket, StopOn::ALL) {
            Err(RelaySessionError::Fatal(error)) => {
                assert!(
                    crate::exit::message_for(&error).contains("upgrade the WS Model Proxy server")
                );
                assert_eq!(
                    crate::exit::code_for(&error),
                    crate::exit::ExitCode::RelayProtocolMismatch
                );
            }
            _ => panic!("expected actionable old server refusal"),
        }
    }

    #[test]
    fn hello_challenge_requires_origin_and_accepts_current_server() {
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"hello.challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAA"}"#.into(),
        ));
        assert!(matches!(
            wait_for_hello_challenge(&mut socket, StopOn::ALL),
            Err(RelaySessionError::Fatal(_))
        ));
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"hello.challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAA","origin":"https://example.test"}"#.into()));
        assert_eq!(
            wait_for_hello_challenge(&mut socket, StopOn::ALL)
                .ok()
                .unwrap(),
            (
                "AAAAAAAAAAAAAAAAAAAAAA".to_string(),
                "https://example.test".to_string()
            )
        );
    }

    #[test]
    fn hot_reload_turns_browser_terminals_off_but_never_on() {
        let on = Config {
            allow_human_terminal: true,
            ..Config::default()
        };
        let off = Config::default();
        let startup = TerminalStartup::from_key(
            crate::terminal_crypto::CliTerminalKey::generate().expect("key"),
            &on,
        );
        assert!(reload_human_terminal(&startup, &on).is_none());
        assert!(startup.allow_human_terminal());
        assert_eq!(
            reload_human_terminal(&startup, &off),
            Some(NodeChange::HumanTerminalsDisabled)
        );
        assert!(!startup.allow_human_terminal());
        // Reported once; turning it back on in the file takes a restart.
        assert!(reload_human_terminal(&startup, &off).is_none());
        assert!(reload_human_terminal(&startup, &on).is_none());
        assert!(!startup.allow_human_terminal());
        assert!(!startup.features().terminals.supported);
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
        let mut requests = RelayRequests::new();

        // Seed a live worker for "req-1".
        let (worker, _cancellation) = idle_worker(RequestBody::None);
        requests.start("req-1".to_string(), worker);

        let result = start_relay_request(
            &mut socket,
            &config,
            &BTreeMap::new(),
            &worker_tx,
            &mut requests,
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
        assert_eq!(requests.live.len(), 1);
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
        let mut requests = RelayRequests::new();
        requests.retired.record("req-done");

        let result = start_relay_request(
            &mut socket,
            &config,
            &BTreeMap::new(),
            &worker_tx,
            &mut requests,
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

        assert!(requests.live.is_empty());
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
        match relay_connect_error(http(401), StopOn::ALL) {
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
        match relay_connect_error(http(401), StopOn::NONE) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert!(format!("{error:#}").contains("`wsmp login`"));
            }
            _ => panic!("HTTP 401 must be retried without the stop marker"),
        }
        // 403 can come from a proxy or firewall: never fatal.
        for status in [403, 429, 500, 502, 503] {
            for stop in [StopOn::ALL, StopOn::NONE] {
                assert!(matches!(
                    relay_connect_error(http(status), stop),
                    RelaySessionError::Reconnectable { .. }
                ));
            }
        }
        let io =
            tungstenite::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(matches!(
            relay_connect_error(io, StopOn::ALL),
            RelaySessionError::Reconnectable { .. }
        ));
    }

    fn http_error(status: u16, retry_after: Option<&str>) -> tungstenite::Error {
        let mut builder = tungstenite::http::Response::builder().status(status);
        if let Some(value) = retry_after {
            builder = builder.header("Retry-After", value);
        }
        tungstenite::Error::Http(Box::new(builder.body(None).expect("response")))
    }

    #[test]
    fn a_rate_limited_upgrade_waits_at_least_retry_after_and_logs_it() {
        for stop in [StopOn::ALL, StopOn::NONE] {
            match relay_connect_error(http_error(429, Some("120")), stop) {
                RelaySessionError::Reconnectable { error, .. } => {
                    assert_eq!(retry_floor(&error), Some(Duration::from_secs(120)));
                    let logged = format!("{error:#}");
                    assert!(logged.contains("429"), "{logged}");
                    assert!(logged.contains("Retry-After"), "{logged}");
                    assert!(logged.contains("120 s"), "{logged}");
                }
                _ => panic!("HTTP 429 must reconnect"),
            }
        }
        // A huge or missing Retry-After: capped, or none at all.
        match relay_connect_error(http_error(503, Some("999999")), StopOn::ALL) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert_eq!(retry_floor(&error), Some(RELAY_RETRY_AFTER_MAX));
            }
            _ => panic!("HTTP 503 must reconnect"),
        }
        for value in [None, Some("Wed, 21 Oct 2015 07:28:00 GMT"), Some("soon")] {
            match relay_connect_error(http_error(429, value), StopOn::ALL) {
                RelaySessionError::Reconnectable { error, .. } => {
                    assert_eq!(retry_floor(&error), None);
                }
                _ => panic!("HTTP 429 must reconnect"),
            }
        }
    }

    #[test]
    fn reconnect_wait_keeps_jitter_the_cap_and_the_floor() {
        for _ in 0..200 {
            let wait = reconnect_wait(RELAY_RECONNECT_MAX_DELAY, None);
            assert!(wait <= RELAY_RECONNECT_MAX_DELAY);
            assert!(wait >= RELAY_RECONNECT_MAX_DELAY.mul_f64(0.8));
            let floored = reconnect_wait(Duration::from_secs(2), Some(Duration::from_secs(60)));
            assert!(floored >= Duration::from_secs(60), "{floored:?}");
            assert!(floored <= Duration::from_secs(66), "{floored:?}");
            // The backoff still wins when it is longer than the floor.
            let longer = reconnect_wait(Duration::from_secs(256), Some(Duration::from_secs(1)));
            assert!(longer >= Duration::from_secs(204), "{longer:?}");
        }
    }

    #[test]
    fn a_refused_relay_protocol_stops_with_its_own_exit_code() {
        let refusals = [
            hello_rejection(
                "This server requires relay protocol 3.0. Upgrade wsmp and restart it.",
                Some(&ProtocolErrorCode::UpgradeCli),
                StopOn::ALL,
            ),
            hello_rejection(
                "too new",
                Some(&ProtocolErrorCode::UpgradeServer),
                StopOn::ALL,
            ),
            hello_rejection("Malformed relay protocol message.", None, StopOn::ALL),
        ];
        for refusal in refusals {
            match refusal {
                RelaySessionError::Fatal(error) => {
                    assert_eq!(
                        crate::exit::code_for(&error),
                        crate::exit::ExitCode::RelayProtocolMismatch
                    );
                    let message = crate::exit::message_for(&error);
                    assert!(
                        message.contains("upgrade") || message.contains("install.sh"),
                        "{message}"
                    );
                }
                _ => panic!("a refused protocol must stop where stopping is safe"),
            }
        }
        let cli = hello_rejection(
            "Upgrade wsmp.",
            Some(&ProtocolErrorCode::UpgradeCli),
            StopOn::ALL,
        );
        let RelaySessionError::Fatal(error) = cli else {
            panic!("upgrade_cli must stop");
        };
        assert!(crate::exit::message_for(&error).contains("install.sh"));
    }

    #[test]
    fn a_refused_relay_protocol_retries_slowly_where_exiting_would_relaunch() {
        match hello_rejection(
            "Upgrade wsmp.",
            Some(&ProtocolErrorCode::UpgradeCli),
            StopOn::NONE,
        ) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert_eq!(retry_floor(&error), Some(RELAY_RECONNECT_MAX_DELAY));
                assert!(format!("{error:#}").contains("install.sh"));
            }
            _ => panic!("without the stop marker a refused protocol must be retried"),
        }
    }

    #[test]
    fn a_hello_credential_refusal_asks_for_login_and_malformed_stays_generic() {
        let RelaySessionError::Fatal(error) = hello_rejection(
            "another identity key",
            Some(&ProtocolErrorCode::IdentityMismatch),
            StopOn::ALL,
        ) else {
            panic!("an identity mismatch must stop where stopping is safe");
        };
        assert_eq!(
            crate::exit::code_for(&error),
            crate::exit::ExitCode::CredentialRejected
        );
        assert!(crate::exit::message_for(&error).contains("`wsmp login`"));
        // Access denied (revoked, owner not active) may clear up: retried slowly.
        match hello_rejection(
            "The node's owner is not active.",
            Some(&ProtocolErrorCode::AccessDenied),
            StopOn::ALL,
        ) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert_eq!(retry_floor(&error), Some(RELAY_RECONNECT_MAX_DELAY));
                assert!(format!("{error:#}").contains("`wsmp login`"));
            }
            _ => panic!("access_denied must be retried slowly"),
        }
        let RelaySessionError::Fatal(error) =
            hello_rejection("bad", Some(&ProtocolErrorCode::Malformed), StopOn::ALL)
        else {
            panic!("malformed must stay fatal");
        };
        assert_eq!(
            crate::exit::code_for(&error),
            crate::exit::ExitCode::Failure
        );
    }

    #[test]
    fn an_old_unit_retries_a_refused_protocol_slowly_and_says_to_reinstall_it() {
        let old_unit = StopOn {
            credential: true,
            protocol: false,
        };
        match hello_rejection(
            "Upgrade wsmp.",
            Some(&ProtocolErrorCode::UpgradeCli),
            old_unit,
        ) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert_eq!(retry_floor(&error), Some(RELAY_RECONNECT_MAX_DELAY));
                assert!(format!("{error:#}").contains("`wsmp service install`"));
            }
            _ => panic!("an old unit restarts on exit 5: retry instead"),
        }
    }

    #[test]
    fn a_plain_426_is_a_lost_upgrade_not_a_protocol_mismatch() {
        let refusal = |body: &str| {
            let response = tungstenite::http::Response::builder()
                .status(426)
                .body(Some(body.as_bytes().to_vec()))
                .expect("response");
            tungstenite::Error::Http(Box::new(response))
        };
        match relay_connect_error(
            refusal(r#"{"error":"WebSocket upgrade required."}"#),
            StopOn::ALL,
        ) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert!(format!("{error:#}").contains("forwards WebSocket upgrades"));
            }
            _ => panic!("a lost upgrade must reconnect"),
        }
        let RelaySessionError::Fatal(error) = relay_connect_error(
            refusal(
                r#"{"type":"protocol.error","code":"upgrade_cli","supportedSubprotocol":"ws-model-proxy.relay.v3"}"#,
            ),
            StopOn::ALL,
        ) else {
            panic!("the server's protocol refusal must stop");
        };
        assert_eq!(
            crate::exit::code_for(&error),
            crate::exit::ExitCode::RelayProtocolMismatch
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
            reservations: Vec::new(),
        }
    }

    /// The instance `stop_job` names, served as a live STT endpoint, and another.
    fn stt_endpoints() -> Vec<crate::config::EndpointConfig> {
        use crate::stt::tests::{endpoint, segmented};
        vec![
            endpoint(
                "i-abcdefabcdef",
                "http://127.0.0.1:9",
                segmented(None, None),
            ),
            endpoint(
                "i-000000000000",
                "http://127.0.0.1:9",
                segmented(None, None),
            ),
        ]
    }

    fn opens(
        stt: &mut crate::stt::SttRegistry,
        managed: &[crate::config::EndpointConfig],
        n: u8,
        slug: &str,
    ) -> bool {
        use crate::stt::tests::{open, session_id};
        stt.handle(open(&session_id(n), slug), managed, Instant::now())
            .is_empty()
    }

    fn job_in(phase: JobPhase, step_id: &str) -> crate::protocol::frames::RuntimeJob {
        crate::protocol::frames::RuntimeJob {
            step_id: step_id.into(),
            phase,
            ..stop_job(false)
        }
    }

    fn ended(step_id: &str, succeeded: bool) -> crate::runtimes::runner::StepEnded {
        crate::runtimes::runner::StepEnded {
            step_id: step_id.into(),
            succeeded,
        }
    }

    #[test]
    fn a_stop_job_ends_the_stt_sessions_on_its_instance_before_it_runs() {
        use crate::stt::tests::{is_error, registry, session_id};
        let (mut stt, _rx) = registry();
        let managed = stt_endpoints();
        assert!(opens(&mut stt, &managed, 1, "i-abcdefabcdef"));
        assert!(opens(&mut stt, &managed, 2, "i-000000000000"));
        let stop = stop_job(false);
        let frames = stt_step_submitting(&mut stt, &stop);
        assert_eq!(frames.len(), 1);
        assert!(is_error(
            &frames[0],
            crate::protocol::RelayFailure::NotFound
        ));
        assert!(!stt.is_live(&session_id(1)));
        assert!(stt.is_live(&session_id(2)), "another instance's session");
        stt_step_submitted(&mut stt, &stop, true);
        assert!(
            !opens(&mut stt, &managed, 3, "i-abcdefabcdef"),
            "no session opens while the stop runs"
        );
        // Other steps change nothing: no sessions end, no mark.
        for phase in [JobPhase::Status, JobPhase::Health, JobPhase::Readiness] {
            assert!(stt_step_submitting(&mut stt, &job_in(phase, "probe")).is_empty());
        }
        assert!(stt.is_live(&session_id(2)));
        stt.abort_all();
    }

    #[test]
    fn a_refused_or_failed_stop_lifts_its_stt_mark() {
        let (mut stt, _rx) = crate::stt::tests::registry();
        let managed = stt_endpoints();
        // The runner refuses the stop: its endpoint still serves.
        let stop = stop_job(false);
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, false);
        assert!(opens(&mut stt, &managed, 1, "i-abcdefabcdef"));
        // The stop runs and fails (or its operator terminal closes).
        let stop = job_in(JobPhase::Stop, "step2");
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        stt_step_ended(&mut stt, &ended("other", false));
        assert!(!opens(&mut stt, &managed, 2, "i-abcdefabcdef"));
        stt_step_ended(&mut stt, &ended("step2", false));
        assert!(opens(&mut stt, &managed, 3, "i-abcdefabcdef"));
        stt.abort_all();
    }

    #[test]
    fn a_start_after_a_stop_takes_stt_sessions_once_the_stop_is_done() {
        let (mut stt, _rx) = crate::stt::tests::registry();
        let managed = stt_endpoints();
        // A start admitted while the stop runs waits for it.
        let stop = stop_job(false);
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        let start = job_in(JobPhase::Start, "start1");
        stt_step_submitting(&mut stt, &start);
        stt_step_submitted(&mut stt, &start, true);
        assert!(!opens(&mut stt, &managed, 1, "i-abcdefabcdef"));
        // A re-delivery of the stop keeps the start waiting.
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        // The start's own result names no mark.
        stt_step_ended(&mut stt, &ended("start1", true));
        assert!(!opens(&mut stt, &managed, 2, "i-abcdefabcdef"));
        stt_step_ended(&mut stt, &ended("step1", true));
        assert!(opens(&mut stt, &managed, 3, "i-abcdefabcdef"));

        // A stop that finished first: a refused start keeps the mark, an
        // admitted prepare lifts it.
        let stop = job_in(JobPhase::Stop, "step2");
        stt_step_submitting(&mut stt, &stop);
        stt_step_submitted(&mut stt, &stop, true);
        stt_step_ended(&mut stt, &ended("step2", true));
        assert!(!opens(&mut stt, &managed, 4, "i-abcdefabcdef"));
        let prepare = job_in(JobPhase::Prepare, "prep1");
        stt_step_submitted(&mut stt, &prepare, false);
        assert!(!opens(&mut stt, &managed, 5, "i-abcdefabcdef"));
        stt_step_submitted(&mut stt, &prepare, true);
        assert!(opens(&mut stt, &managed, 6, "i-abcdefabcdef"));
        stt.abort_all();
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
            command_argv: None,
            stop_argv: None,
            status_argv: None,
            health_argv: None,
            shell: crate::protocol::runtime_spec::CommandShell::Sh,
            secrets: Vec::new(),
            timeout_ms: 60_000,
            unit_name: "wsmp-i-abcdefabcdef-r0".into(),
            handle: "i-abcdefabcdef".into(),
            port: 30001,
            gpu_ids: None,
            dist_port: None,
            host: "127.0.0.1".into(),
            reservations: Vec::new(),
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

    #[test]
    fn a_recorded_stop_uses_the_jobs_reservations_else_the_launch_reservations() {
        let reservation = |index: u8, node: &str| crate::protocol::frames::JobReservation {
            index,
            node_id: format!("wk{index}"),
            node: node.into(),
            gpu_ids: None,
        };
        let mut launched = recorded(false);
        launched.reservations = vec![reservation(0, "worker-a")];
        // A stop that names none sees the worker the launch was started with.
        let job = from_record(&stop_job(false), launched.clone()).expect("admitted");
        assert_eq!(job.reservations, vec![reservation(0, "worker-a")]);
        // A stop that names its own uses them.
        let mut naming = stop_job(false);
        naming.reservations = vec![reservation(1, "worker-b")];
        let job = from_record(&naming, launched).expect("admitted");
        assert_eq!(job.reservations, vec![reservation(1, "worker-b")]);
    }

    #[test]
    fn the_operator_screen_shows_what_the_node_rendered_not_the_server_handle() {
        let mut job = stop_job(true);
        job.handle = "i-zzzzzzzzzzzz".into();
        let rendered = recorded(true);
        let Some(operator) = job.operator.clone() else {
            panic!("operator job");
        };
        let ticket = operator_ticket(&job, &operator, &rendered);
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

    /// Backoff after attempts that never registered keeps growing, whatever
    /// failed (a lost socket while registering used to reset it, which
    /// redialled a refusing server every second).
    #[test]
    fn the_backoff_grows_through_errors_before_hello_ok() {
        let now = Instant::now();
        let mut backoff = ReconnectBackoff::new();
        for progress in [
            ConnectProgress::Connecting,
            ConnectProgress::Upgraded,
            ConnectProgress::Challenged,
            ConnectProgress::HelloSent,
            ConnectProgress::Registered { since: now },
        ] {
            let before = backoff.delay;
            let wait = backoff.next_wait(AttemptEnd::Reconnectable { floor: None }, progress, now);
            assert!(
                wait <= before && wait >= before.mul_f64(0.8),
                "{progress:?}"
            );
            assert_eq!(backoff.delay, next_reconnect_delay(before), "{progress:?}");
        }
        assert_eq!(backoff.delay, Duration::from_secs(32));
        assert_eq!(backoff.fatal_delay, RELAY_FATAL_INITIAL_DELAY);
    }

    #[test]
    fn a_stable_registered_session_starts_the_backoff_over() {
        let since = Instant::now();
        let mut backoff = ReconnectBackoff {
            delay: RELAY_RECONNECT_MAX_DELAY,
            fatal_delay: RELAY_RECONNECT_MAX_DELAY,
        };
        // Registered, but dropped before it was stable: no reset.
        let short = since + RELAY_STABLE_SESSION - Duration::from_secs(1);
        let progress = ConnectProgress::Registered { since };
        assert!(!progress.stable_at(short));
        backoff.next_wait(AttemptEnd::Retry, progress, short);
        assert_eq!(backoff.delay, RELAY_RECONNECT_MAX_DELAY);
        // Stable: both backoffs start over, then grow for the next attempt.
        let stable = since + RELAY_STABLE_SESSION;
        let wait = backoff.next_wait(AttemptEnd::Reconnectable { floor: None }, progress, stable);
        assert!(wait <= RELAY_RECONNECT_INITIAL_DELAY);
        assert_eq!(backoff.delay, RELAY_RECONNECT_INITIAL_DELAY * 2);
        assert_eq!(backoff.fatal_delay, RELAY_FATAL_INITIAL_DELAY);
    }

    #[test]
    fn the_backoff_honours_floors_and_keeps_its_fatal_track() {
        let now = Instant::now();
        let mut backoff = ReconnectBackoff::new();
        let floor = Duration::from_secs(120);
        let wait = backoff.next_wait(
            AttemptEnd::Reconnectable { floor: Some(floor) },
            ConnectProgress::Connecting,
            now,
        );
        assert!(wait >= floor && wait <= floor.mul_f64(1.1));
        // Grown from the floor.
        assert_eq!(backoff.delay, floor * 2);
        let mut backoff = ReconnectBackoff::new();
        let wait = backoff.next_wait(AttemptEnd::Fatal, ConnectProgress::HelloSent, now);
        assert!(wait <= RELAY_FATAL_INITIAL_DELAY);
        assert_eq!(backoff.fatal_delay, RELAY_FATAL_INITIAL_DELAY * 2);
        assert_eq!(backoff.delay, RELAY_RECONNECT_INITIAL_DELAY * 2);
    }

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

    /// F-trust: `wsmp trust full` then `wsmp trust relay` drained in one
    /// loop turn (or a raise and a hot-reload lowering) end at Relay only,
    /// and file ops are refused: the file relay reads the daemon's trust, so
    /// no change applied after the other can leave it at Full control.
    #[test]
    fn a_raise_then_a_lowering_in_one_turn_leaves_file_ops_refused() {
        let config = Config::default();
        let startup = TerminalStartup::from_key(
            crate::terminal_crypto::CliTerminalKey::generate().expect("key"),
            &config,
        );
        let mut applied = startup.trust_snapshot().lowerings;
        let policy = crate::file_ops::Policy::from_environment(vec![std::env::temp_dir()], false)
            .with_euid(1000);
        let runtime = Arc::new(crate::file_relay::FileRuntime::new(
            crate::file_ops::FileOps::new(policy, crate::file_ops::EtagKey::random()),
        ));
        let sink: crate::file_relay::FileSink = Arc::new(|_, _| {});
        let mut files = crate::file_relay::FileRelay::new(runtime, startup.trust_authority(), sink);
        let stat = |files: &mut crate::file_relay::FileRelay, n: u8| {
            use base64::Engine;
            let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([n; 16]);
            let frames = files.handle_op(
                &id,
                "stat",
                serde_json::json!({ "path": std::env::temp_dir() }),
                None,
            );
            frames.iter().any(|frame| {
                matches!(
                    frame,
                    crate::file_relay::FileFrame::Control(message)
                        if serde_json::to_value(message).expect("json")["reason"] == "trust_relay"
                )
            })
        };
        assert!(stat(&mut files, 1), "Relay only at start");

        // Raised, then lowered, then the session applies the turn's changes.
        assert!(startup.raise_trust());
        assert!(startup.lower_trust());
        assert!(take_lowering(&mut applied, &startup));
        files.on_trust_changed();
        assert_eq!(startup.trust_value(), TrustValue::Relay);
        assert!(stat(&mut files, 2), "the lowering applied last wins");

        // Raised, lowered, then raised again: Full control, and the lowering still counts.
        assert!(startup.raise_trust());
        assert!(startup.lower_trust());
        assert!(startup.raise_trust());
        assert!(take_lowering(&mut applied, &startup));
        assert!(!take_lowering(&mut applied, &startup), "applied once");
        files.on_trust_changed();
        assert!(!stat(&mut files, 3), "raised last: admitted");
    }
}
