//! Foreground websocket relay daemon.
//!
//! Request bodies are streamed to the upstream endpoint as they arrive over the
//! websocket instead of being fully buffered first. Each relayed request runs on
//! its own worker thread so a slow upstream cannot stall sibling requests
//! multiplexed on the shared socket. The single websocket writer stays on the
//! main loop: workers hand outbound frames back through a channel that the main
//! loop drains, and the server paces request-body frames with credit-based flow
//! control (`relay.request.body.ack`).

#[cfg(unix)]
use std::collections::HashMap;
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
use crate::config::{Config, ConfigLock};
use crate::control::ControlServer;
#[cfg(unix)]
use crate::control::{
    self, ControlCommand, ControlEndpointStatus, ControlResponse, PendingRequest,
};

#[cfg(unix)]
type PendingReload = (String, Config, Config, Option<PendingRequest>, Instant);
#[cfg(unix)]
// A timeout restores the previous map immediately. Keep the candidate only for
// bounded late-ack correlation, and the previous map for late rejection.
type TimedOutReload = (Config, Config);

/// Correlation records for acknowledgement timeouts. Insertion order is kept
/// separately so bounding this state evicts only the oldest record rather than
/// dropping every still-relevant late acknowledgement at once.
#[cfg(unix)]
struct TimedOutReloads {
    by_id: HashMap<String, TimedOutReload>,
    order: VecDeque<String>,
}

#[cfg(unix)]
impl TimedOutReloads {
    fn new() -> Self {
        Self {
            by_id: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn insert(&mut self, id: String, reload: TimedOutReload) {
        if self.by_id.remove(&id).is_some() {
            self.order.retain(|existing| existing != &id);
        }
        while self.by_id.len() >= TIMED_OUT_RELOAD_ID_CAPACITY {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.by_id.remove(&oldest);
        }
        self.order.push_back(id.clone());
        self.by_id.insert(id, reload);
    }

    fn remove(&mut self, id: &str) -> Option<TimedOutReload> {
        let reload = self.by_id.remove(id)?;
        self.order.retain(|existing| existing != id);
        Some(reload)
    }

    fn clear_for_new_reload(&mut self) {
        self.by_id.clear();
        self.order.clear();
    }
}
use crate::media::{
    FetchedMedia, MEDIA_EXPAND_MAX_ASSET_BYTES, MEDIA_EXPAND_MAX_BODY_BYTES, MediaExpandError,
    TrustedOrigins, expand_media_in_body, trusted_media_urls_in_body,
};
use crate::probe::{ProbeReport, apply_probe_report, probe_endpoint};
use crate::protocol::{
    CliCapabilities, CliInventory, ClientControlMessage, EndpointInventory, EndpointStatus,
    RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS, RELAY_PROTOCOL_VERSION, RELAY_REQUEST_BODY_WINDOW_CHUNKS,
    RELAY_SUBPROTOCOL, RelayBinaryFrameMetadata, RelayBinaryFrameType, RelayFailure,
    ServerControlMessage, encode_binary_frame, encode_control, endpoint_inventory,
    parse_binary_frame, parse_server_control,
};
use crate::slug::generated_slug;
use crate::tokens::{CompletionTextCollector, standardized_completion_metrics};

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
/// Keep enough of a streaming completion to parse a terminal OpenAI usage
/// event without retaining an unbounded generated response in the relay.
const RELAY_USAGE_TAIL_MAX_BYTES: usize = 256 * 1024;

#[cfg(unix)]
const INVENTORY_ACK_TIMEOUT: Duration = Duration::from_secs(15);
/// Avoid serially multiplying the per-endpoint probe timeout during reload
/// while also preventing a large configuration from opening unbounded local
/// connections.
const INVENTORY_PROBE_CONCURRENCY: usize = 4;
/// The async handoff owns one request chunk after a credit is returned. The
/// ingress queue must still accept the whole advertised window before the new
/// worker has had a chance to run.
const UPSTREAM_BODY_HANDOFF_CAPACITY: usize = 1;
const REQUEST_BODY_INGRESS_CAPACITY: usize = RELAY_REQUEST_BODY_WINDOW_CHUNKS;
#[cfg(unix)]
const TIMED_OUT_RELOAD_ID_CAPACITY: usize = 64;

// Request workers are synchronous threads, but their HTTP work is async. Keep
// one process-long runtime and connection pool instead of constructing a Tokio
// reactor and reqwest client for every relayed request.
static UPSTREAM_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static UPSTREAM_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const UPSTREAM_RESPONSE_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

fn upstream_runtime() -> Result<&'static tokio::runtime::Runtime> {
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

fn upstream_http_client() -> Result<&'static reqwest::Client> {
    if let Some(client) = UPSTREAM_HTTP_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
        .build()
        .context("building shared cancellable upstream client")?;
    let _ = UPSTREAM_HTTP_CLIENT.set(client);
    UPSTREAM_HTTP_CLIENT
        .get()
        .context("initializing shared cancellable upstream client")
}

/// A frame produced by a worker for the main loop to write to the websocket.
enum WsFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// Message from a request worker to the main loop.
enum FromWorker {
    Send {
        request_id: String,
        frame: WsFrame,
    },
    Finished(String),
    #[cfg(unix)]
    InventoryPrepared {
        candidate: Config,
    },
    #[cfg(unix)]
    InventoryPreparationFailed {
        message: String,
    },
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
                    let ack = ClientControlMessage::RelayRequestBodyAck {
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

pub fn connect_foreground() -> Result<()> {
    let mut config = Config::load_required()?;
    config.validate()?;
    let mut control = ControlServer::bind()?;
    let mut last_inventory_revision = None;
    // The mtime accompanies the last server-acknowledged local snapshot. It
    // prevents an edit-and-revert from being treated as an unchanged desired
    // inventory on reconnect.
    let mut acknowledged_config_modified_at = None;
    let mut reconnect_delay = RELAY_RECONNECT_INITIAL_DELAY;
    loop {
        // Reuse only a locally unchanged snapshot that the server has already
        // acknowledged. Reconnect registration still replaces the server
        // inventory, but no network probe or config rewrite is needed.
        let (candidate, endpoints) = match reconnect_inventory_candidate(
            &config,
            last_inventory_revision.as_ref(),
            acknowledged_config_modified_at,
        ) {
            Ok(candidate) => candidate,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    retry_delay_secs = reconnect_delay.as_secs(),
                    "preparing relay inventory failed; retrying before websocket connection"
                );
                wait_for_reconnect(
                    &mut control,
                    &config,
                    &last_inventory_revision,
                    reconnect_delay,
                )?;
                reconnect_delay = next_reconnect_delay(reconnect_delay);
                continue;
            }
        };
        config = candidate;
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

        tracing::info!(url = %ws_url, "connecting relay websocket");
        match run_relay_session(
            &mut config,
            &cli_slug,
            &ws_url,
            auth_value,
            endpoints,
            &mut control,
            &mut last_inventory_revision,
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
        }
        acknowledged_config_modified_at =
            acknowledged_inventory_matches_config(&config, last_inventory_revision.as_ref())
                .then(config_file_modified_at)
                .transpose()?;
        wait_for_reconnect(
            &mut control,
            &config,
            &last_inventory_revision,
            reconnect_delay,
        )?;
        // Do not replace the live routing snapshot from disk during reconnect.
        // A local file write is only desired state; replacing this map before a
        // durable inventory acknowledgement would route requests through an
        // unpublished candidate. `reload` owns candidate loading and swaps it
        // only after `inventory.ok`.
        reconnect_delay = next_reconnect_delay(reconnect_delay);
    }
}

fn load_reconnect_candidate(active: &Config) -> Result<(Config, SystemTime)> {
    let _lock = ConfigLock::exclusive()?;
    let candidate = Config::load_required()?;
    candidate.validate()?;
    if candidate.server_url != active.server_url
        || candidate.cli_slug != active.cli_slug
        || candidate.cli_token_env != active.cli_token_env
    {
        anyhow::bail!(
            "server URL, CLI slug, or credential source changed; restart the relay to apply it"
        );
    }
    Ok((candidate, config_file_modified_at()?))
}

fn config_file_modified_at() -> Result<SystemTime> {
    let path = crate::paths::config_file()?;
    std::fs::metadata(&path)
        .with_context(|| format!("reading config metadata `{}`", path.display()))?
        .modified()
        .with_context(|| format!("reading config modification time `{}`", path.display()))
}

fn inventory_snapshot_from_config(config: &Config) -> Vec<EndpointInventory> {
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

fn acknowledged_inventory_matches_config(
    config: &Config,
    revision: Option<&crate::protocol::InventoryRevision>,
) -> bool {
    revision.is_some_and(|value| {
        value.inventory_digest
            == crate::protocol::inventory_digest(&inventory_snapshot_from_config(config))
    })
}

fn should_reuse_reconnect_inventory(
    active: &Config,
    desired: &Config,
    acknowledged_modified_at: Option<SystemTime>,
    desired_modified_at: SystemTime,
    revision: Option<&crate::protocol::InventoryRevision>,
) -> bool {
    active == desired
        && acknowledged_modified_at == Some(desired_modified_at)
        && acknowledged_inventory_matches_config(active, revision)
}

fn reconnect_inventory_candidate(
    active: &Config,
    revision: Option<&crate::protocol::InventoryRevision>,
    acknowledged_modified_at: Option<SystemTime>,
) -> Result<(Config, Vec<EndpointInventory>)> {
    let (desired, desired_modified_at) = load_reconnect_candidate(active)?;
    if should_reuse_reconnect_inventory(
        active,
        &desired,
        acknowledged_modified_at,
        desired_modified_at,
        revision,
    ) {
        return Ok((active.clone(), inventory_snapshot_from_config(active)));
    }
    prepare_inventory_candidate(active)
}

/// Probe a stable desired snapshot without holding the config lock across
/// network I/O. Before persisting the probe results, reacquire the lock and
/// ensure no standalone mutation replaced the snapshot. This avoids both lost
/// updates and a long-held lock that would make control status wait on probes.
fn prepare_inventory_candidate(active: &Config) -> Result<(Config, Vec<EndpointInventory>)> {
    let (mut candidate, _) = load_reconnect_candidate(active)?;
    let desired_before_probe = candidate.clone();
    let inventory = inventory_from_config(&mut candidate);

    let _lock = ConfigLock::exclusive()?;
    let current = Config::load_required()?;
    if current != desired_before_probe {
        anyhow::bail!(
            "local endpoint configuration changed while probing; retry reload so the final desired snapshot can be published"
        );
    }
    candidate.save()?;
    Ok((candidate, inventory))
}

#[cfg(unix)]
fn wait_for_reconnect(
    control: &mut ControlServer,
    config: &Config,
    revision: &Option<crate::protocol::InventoryRevision>,
    delay: Duration,
) -> Result<()> {
    let deadline = Instant::now() + delay;
    while Instant::now() < deadline {
        for pending in control.drain()? {
            if matches!(pending.request.command, ControlCommand::Status) {
                let desired = desired_config_snapshot().unwrap_or_else(|error| {
                    tracing::warn!(error = %error, "reading desired config for relay status");
                    config.clone()
                });
                let response =
                    live_status_response(&desired, revision.as_ref(), "reconnecting", None);
                let _ = control::respond(pending, &response);
                continue;
            }
            let response = ControlResponse {
                ok: false,
                state: "reconnecting",
                message: Some("relay websocket is reconnecting; retry reload after it registers"),
                endpoints: None,
                inventory_seq: None,
                connection: Some("reconnecting"),
                desired_inventory_digest: None,
                config_modified_at_ms: None,
                desired_endpoints: None,
                inventory_digest: None,
                inventory_acknowledged_at: None,
            };
            let _ = control::respond(pending, &response);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
    Ok(())
}

#[cfg(not(unix))]
fn wait_for_reconnect(
    _control: &mut ControlServer,
    _config: &Config,
    _revision: &Option<crate::protocol::InventoryRevision>,
    delay: Duration,
) -> Result<()> {
    thread::sleep(delay);
    Ok(())
}

fn run_relay_session(
    config: &mut Config,
    cli_slug: &str,
    ws_url: &Url,
    auth_value: HeaderValue,
    endpoints: Vec<EndpointInventory>,
    _control: &mut ControlServer,
    last_inventory_revision: &mut Option<crate::protocol::InventoryRevision>,
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
    #[cfg(unix)]
    // The candidate is adopted before `inventory.update` leaves this process.
    // That closes the server-persisted/CLI-old-map routing window; rejection
    // and acknowledgement timeout restore the prior acknowledged map. A late
    // matching acknowledgement is the only timeout recovery that adopts it.
    let mut pending_reload: Option<PendingReload> = None;
    #[cfg(unix)]
    let mut timed_out_reload_candidates = TimedOutReloads::new();
    #[cfg(unix)]
    let mut rejected_inventory_digest: Option<String> = None;
    #[cfg(unix)]
    let mut pending_preparation: Option<PendingRequest> = None;
    #[cfg(unix)]
    let mut reload_preparing = false;

    let mut next_heartbeat =
        Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
    let result = loop {
        if let Err(error) = drain_worker_output(
            &mut socket,
            config,
            &worker_rx,
            &mut workers,
            &mut recent_finished,
            #[cfg(unix)]
            &mut reload_preparing,
            #[cfg(unix)]
            &mut pending_preparation,
            #[cfg(unix)]
            &mut pending_reload,
        ) {
            break Err(error);
        }

        #[cfg(unix)]
        if pending_reload
            .as_ref()
            .is_some_and(|(_, _, _, _, deadline)| Instant::now() >= *deadline)
        {
            if let Some((id, candidate, previous, pending, _)) = pending_reload.take() {
                if let Some(pending) = pending {
                    let _ = control::respond(
                        pending,
                        &ControlResponse {
                            ok: false,
                            state: "publish_uncertain",
                            message: Some("timed out waiting for inventory acknowledgement"),
                            endpoints: None,
                            inventory_seq: None,
                            connection: Some("connected"),
                            desired_inventory_digest: None,
                            config_modified_at_ms: None,
                            desired_endpoints: None,
                            inventory_digest: None,
                            inventory_acknowledged_at: None,
                        },
                    );
                }
                // `published` means durably acknowledged. A timeout therefore
                // restores the previous acknowledged routes immediately rather
                // than leaving removed slugs executable indefinitely. Keep only
                // a bounded correlation record: a late `inventory.ok` can make
                // the exact candidate live, while a late rejection confirms the
                // already-restored previous map.
                restore_previous_routing_after_timeout(config, &previous);
                timed_out_reload_candidates.insert(id, (candidate, previous));
            }
        }

        #[cfg(unix)]
        if let Err(error) = handle_control_requests(
            _control,
            &mut socket,
            config,
            last_inventory_revision,
            &mut pending_reload,
            &mut timed_out_reload_candidates,
            &mut pending_preparation,
            &mut reload_preparing,
            &mut rejected_inventory_digest,
            &worker_tx,
        ) {
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
                last_inventory_revision,
                #[cfg(unix)]
                &mut pending_reload,
                #[cfg(unix)]
                &mut timed_out_reload_candidates,
                #[cfg(unix)]
                &mut rejected_inventory_digest,
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

    #[cfg(unix)]
    if let Some(pending) = pending_preparation.take() {
        let _ = control::respond(
            pending,
            &ControlResponse {
                ok: false,
                state: "reconnecting",
                message: Some("relay disconnected while preparing inventory reload"),
                endpoints: None,
                inventory_seq: None,
                connection: Some("disconnected"),
                desired_inventory_digest: None,
                config_modified_at_ms: None,
                desired_endpoints: None,
                inventory_digest: None,
                inventory_acknowledged_at: None,
            },
        );
    }
    #[cfg(unix)]
    if let Some((_, _, _, Some(pending), _)) = pending_reload.take() {
        let _ = control::respond(
            pending,
            &ControlResponse {
                ok: false,
                state: "publish_uncertain",
                message: Some("relay disconnected before inventory acknowledgement"),
                endpoints: None,
                inventory_seq: None,
                connection: Some("disconnected"),
                desired_inventory_digest: None,
                config_modified_at_ms: None,
                desired_endpoints: None,
                inventory_digest: None,
                inventory_acknowledged_at: None,
            },
        );
    }
    abort_all_workers(workers);
    result
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

#[allow(clippy::too_many_arguments)]
fn drain_worker_output<S>(
    socket: &mut tungstenite::WebSocket<S>,
    _config: &mut Config,
    worker_rx: &Receiver<FromWorker>,
    workers: &mut BTreeMap<String, WorkerHandle>,
    recent_finished: &mut RecentlyFinished,
    #[cfg(unix)] reload_preparing: &mut bool,
    #[cfg(unix)] pending_preparation: &mut Option<PendingRequest>,
    #[cfg(unix)] pending_reload: &mut Option<PendingReload>,
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
                if !worker_frame_is_current(workers, &request_id) {
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
                recent_finished.record(&request_id);
                if let Some(worker) = workers.remove(&request_id) {
                    let _ = worker.join.join();
                }
            }
            #[cfg(unix)]
            Ok(FromWorker::InventoryPrepared { candidate }) => {
                *reload_preparing = false;
                let Some(pending) = pending_preparation.take() else {
                    continue;
                };
                let endpoints = candidate
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
                    .collect();
                let id = next_id("inventory");
                if let Err(error) = send_control(
                    socket,
                    &ClientControlMessage::InventoryUpdate {
                        id: id.clone(),
                        endpoints,
                    },
                    "sending inventory update",
                ) {
                    let _ = control::respond(
                        pending,
                        &ControlResponse {
                            ok: false,
                            state: "reconnecting",
                            message: Some("relay disconnected before inventory could be published"),
                            endpoints: None,
                            inventory_seq: None,
                            connection: Some("disconnected"),
                            desired_inventory_digest: None,
                            config_modified_at_ms: None,
                            desired_endpoints: None,
                            inventory_digest: None,
                            inventory_acknowledged_at: None,
                        },
                    );
                    return Err(error);
                }
                // Make the endpoint-targeted routing map ready before the
                // server can durably expose this inventory. If the server
                // rejects it we restore `previous`; before persistence the
                // candidate cannot receive a server-selected request.
                let previous = _config.clone();
                *_config = pending_reload_routing_map(&previous, &candidate);
                *pending_reload = Some((
                    id,
                    candidate,
                    previous,
                    Some(pending),
                    Instant::now() + INVENTORY_ACK_TIMEOUT,
                ));
            }
            #[cfg(unix)]
            Ok(FromWorker::InventoryPreparationFailed { message }) => {
                *reload_preparing = false;
                if let Some(pending) = pending_preparation.take() {
                    let _ = control::respond(
                        pending,
                        &ControlResponse {
                            ok: false,
                            state: "local_invalid",
                            message: Some(&message),
                            endpoints: None,
                            inventory_seq: None,
                            connection: Some("connected"),
                            desired_inventory_digest: None,
                            config_modified_at_ms: None,
                            desired_endpoints: None,
                            inventory_digest: None,
                            inventory_acknowledged_at: None,
                        },
                    );
                }
            }
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

/// While an inventory replacement is pending, preserve routes for the old
/// acknowledged slugs and make candidate slugs available for an early server
/// dispatch. The exact candidate becomes live only at `inventory.ok`.
#[cfg(unix)]
fn pending_reload_routing_map(previous: &Config, candidate: &Config) -> Config {
    let mut combined = candidate.clone();
    for endpoint in &previous.endpoints {
        if combined.endpoint(&endpoint.slug).is_none() {
            combined.endpoints.push(endpoint.clone());
        }
    }
    combined
}

#[cfg(unix)]
fn restore_previous_routing_after_timeout(config: &mut Config, previous: &Config) {
    *config = previous.clone();
}

#[cfg(unix)]
fn inventory_digest_for_config(config: &Config) -> String {
    let inventory = config
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
        .collect::<Vec<_>>();
    crate::protocol::inventory_digest(&inventory)
}

#[cfg(unix)]
fn restore_timed_out_reload_on_rejection(
    timed_out_reloads: &mut TimedOutReloads,
    id: &str,
    config: &mut Config,
    rejected_inventory_digest: &mut Option<String>,
) -> bool {
    let Some((candidate, previous)) = timed_out_reloads.remove(id) else {
        return false;
    };
    *config = previous;
    *rejected_inventory_digest = Some(inventory_digest_for_config(&candidate));
    true
}

#[cfg(unix)]
fn adopt_timed_out_reload_ack(
    timed_out_reloads: &mut TimedOutReloads,
    id: &str,
    revision: crate::protocol::InventoryRevision,
    config: &mut Config,
    last_inventory_revision: &mut Option<crate::protocol::InventoryRevision>,
) -> bool {
    let Some((candidate, _)) = timed_out_reloads.remove(id) else {
        return false;
    };
    *config = candidate;
    *last_inventory_revision = Some(revision);
    true
}

#[cfg(unix)]
fn live_status_response<'a>(
    config: &'a Config,
    revision: Option<&'a crate::protocol::InventoryRevision>,
    connection: &'a str,
    rejected_inventory_digest: Option<&str>,
) -> ControlResponse<'a> {
    let config_modified_at_ms = crate::paths::config_file()
        .ok()
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    // Never infer publication from a live connection or from an unrelated
    // earlier acknowledgement. The desired on-disk identity is current only
    // when it exactly equals the server acknowledgement retained by the live
    // daemon.
    let desired_digest = inventory_digest_for_config(config);
    let rejected = rejected_inventory_digest.is_some_and(|digest| digest == desired_digest);
    let published = if rejected {
        "rejected"
    } else {
        match revision {
            Some(revision) if revision.inventory_digest == desired_digest => "current",
            Some(_) => "pending",
            None => "unconfirmed",
        }
    };
    let desired_endpoints = config
        .endpoints
        .iter()
        .map(|endpoint| {
            let local_probe = if !endpoint.enabled {
                "disabled"
            } else {
                match endpoint.last_probe.as_ref().map(|probe| &probe.status) {
                    Some(crate::config::ProbeStatus::Online) => "online",
                    Some(crate::config::ProbeStatus::Offline) => "offline",
                    None => "unknown",
                }
            };
            ControlEndpointStatus {
                slug: &endpoint.slug,
                enabled: endpoint.enabled,
                local_probe,
                model_count: endpoint.models.len(),
                published: if endpoint.enabled {
                    published
                } else {
                    "unpublished"
                },
            }
        })
        .collect();
    ControlResponse {
        ok: !rejected,
        state: if rejected { "rejected" } else { connection },
        message: rejected
            .then_some("server rejected the desired inventory; revise it and retry reload"),
        endpoints: Some(
            config
                .endpoints
                .iter()
                .filter(|endpoint| endpoint.enabled)
                .count(),
        ),
        inventory_seq: revision.map(|value| value.inventory_seq),
        connection: Some(connection),
        desired_inventory_digest: Some(desired_digest),
        config_modified_at_ms,
        desired_endpoints: Some(desired_endpoints),
        inventory_digest: revision.map(|value| value.inventory_digest.as_str()),
        inventory_acknowledged_at: revision.map(|value| value.inventory_acknowledged_at.as_str()),
    }
}

/// Read desired disk state while participating in the transitional config lock.
/// The daemon's active routing map intentionally remains unchanged until an
/// acknowledgement, so it is not an honest source for `wsmp status` desired
/// state after a standalone mutation.
#[cfg(unix)]
fn desired_config_snapshot() -> Result<Config> {
    let _lock = ConfigLock::exclusive()?;
    Config::load_required()
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn handle_control_requests<S>(
    control_server: &mut ControlServer,
    _socket: &mut tungstenite::WebSocket<S>,
    config: &mut Config,
    last_inventory_revision: &mut Option<crate::protocol::InventoryRevision>,
    pending_reload: &mut Option<PendingReload>,
    timed_out_reload_candidates: &mut TimedOutReloads,
    pending_preparation: &mut Option<PendingRequest>,
    reload_preparing: &mut bool,
    rejected_inventory_digest: &mut Option<String>,
    worker_tx: &SyncSender<FromWorker>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    for pending in control_server.drain().map_err(RelaySessionError::Fatal)? {
        match pending.request.command {
            ControlCommand::Status => {
                let desired = desired_config_snapshot().unwrap_or_else(|error| {
                    tracing::warn!(error = %error, "reading desired config for relay status");
                    config.clone()
                });
                let response = live_status_response(
                    &desired,
                    last_inventory_revision.as_ref(),
                    "connected",
                    rejected_inventory_digest.as_deref(),
                );
                let _ = control::respond(pending, &response);
            }
            ControlCommand::Reload => {
                if last_inventory_revision.is_none() {
                    let _ = control::respond(
                        pending,
                        &ControlResponse {
                            ok: false,
                            state: "registering",
                            message: Some("relay registration has not been acknowledged"),
                            endpoints: None,
                            inventory_seq: None,
                            connection: Some("connected"),
                            desired_inventory_digest: None,
                            config_modified_at_ms: None,
                            desired_endpoints: None,
                            inventory_digest: None,
                            inventory_acknowledged_at: None,
                        },
                    );
                    continue;
                }
                if *reload_preparing || pending_preparation.is_some() || pending_reload.is_some() {
                    let _ = control::respond(
                        pending,
                        &ControlResponse {
                            ok: false,
                            state: "reload_in_progress",
                            message: Some(
                                "an inventory reload is already awaiting acknowledgement",
                            ),
                            endpoints: None,
                            inventory_seq: None,
                            connection: Some("connected"),
                            desired_inventory_digest: None,
                            config_modified_at_ms: None,
                            desired_endpoints: None,
                            inventory_digest: None,
                            inventory_acknowledged_at: None,
                        },
                    );
                    continue;
                }
                // A new explicit reload supersedes every earlier uncertain
                // attempt. A late A acknowledgement/rejection must never
                // overwrite the successful candidate B the operator just
                // requested.
                timed_out_reload_candidates.clear_for_new_reload();
                *reload_preparing = true;
                *rejected_inventory_digest = None;
                *pending_preparation = Some(pending);
                let active_config = config.clone();
                let tx = worker_tx.clone();
                thread::spawn(move || {
                    let outcome = prepare_inventory_candidate(&active_config)
                        .map(|(candidate, _inventory)| candidate);
                    let message = match outcome {
                        Ok(candidate) => FromWorker::InventoryPrepared { candidate },
                        Err(error) => FromWorker::InventoryPreparationFailed {
                            message: error.to_string(),
                        },
                    };
                    let _ = tx.send(message);
                });
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle_text<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &mut Config,
    last_inventory_revision: &mut Option<crate::protocol::InventoryRevision>,
    #[cfg(unix)] pending_reload: &mut Option<PendingReload>,
    #[cfg(unix)] timed_out_reload_candidates: &mut TimedOutReloads,
    #[cfg(unix)] rejected_inventory_digest: &mut Option<String>,
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
        ServerControlMessage::HelloOk {
            id,
            revision,
            desired_capabilities: _,
            ..
        } => {
            *last_inventory_revision = Some(revision);
            tracing::info!(id, "relay registration accepted");
        }
        ServerControlMessage::HeartbeatPong { id, .. } => {
            tracing::debug!(id, "relay heartbeat acknowledged");
        }
        ServerControlMessage::InventoryOk {
            id,
            revision,
            desired_capabilities: _,
        } => {
            #[cfg(not(unix))]
            let _ = &id;
            #[cfg(unix)]
            if pending_reload
                .as_ref()
                .is_some_and(|(pending_id, _, _, _, _)| pending_id == &id)
            {
                if let Some((_, candidate, _, pending, _)) = pending_reload.take() {
                    *last_inventory_revision = Some(revision.clone());
                    *rejected_inventory_digest = None;
                    tracing::info!(id, inventory_seq = revision.inventory_seq, inventory_digest = %revision.inventory_digest, acknowledged_at = %revision.inventory_acknowledged_at, "relay inventory acknowledged");
                    let endpoints = candidate
                        .endpoints
                        .iter()
                        .filter(|endpoint| endpoint.enabled)
                        .count();
                    *config = candidate;
                    if let Some(pending) = pending {
                        let _ = control::respond(
                            pending,
                            &ControlResponse {
                                ok: true,
                                state: "published",
                                message: None,
                                endpoints: Some(endpoints),
                                inventory_seq: Some(revision.inventory_seq),
                                connection: Some("connected"),
                                desired_inventory_digest: None,
                                config_modified_at_ms: None,
                                desired_endpoints: None,
                                inventory_digest: Some(&revision.inventory_digest),
                                inventory_acknowledged_at: Some(
                                    &revision.inventory_acknowledged_at,
                                ),
                            },
                        );
                    }
                    return Ok(());
                }
            }
            #[cfg(unix)]
            if adopt_timed_out_reload_ack(
                timed_out_reload_candidates,
                &id,
                revision.clone(),
                config,
                last_inventory_revision,
            ) {
                tracing::info!(id, inventory_seq = revision.inventory_seq, inventory_digest = %revision.inventory_digest, acknowledged_at = %revision.inventory_acknowledged_at, "late inventory acknowledgement resolved uncertain publish");
                return Ok(());
            }
            #[cfg(unix)]
            if pending_reload
                .as_ref()
                .is_none_or(|(pending_id, _, _, _, _)| pending_id != &id)
            {
                tracing::warn!(
                    id,
                    "ignoring uncorrelated inventory acknowledgement after an uncertain publish"
                );
            }
            #[cfg(not(unix))]
            {
                *last_inventory_revision = Some(revision);
            }
        }
        ServerControlMessage::InventoryError { id, message } => {
            tracing::warn!(id, message, "relay inventory rejected");
            #[cfg(unix)]
            if pending_reload
                .as_ref()
                .is_some_and(|(pending_id, _, _, _, _)| pending_id == &id)
            {
                if let Some((_, candidate, previous, pending, _)) = pending_reload.take() {
                    *config = previous;
                    *rejected_inventory_digest = Some(inventory_digest_for_config(&candidate));
                    if let Some(pending) = pending {
                        let _ = control::respond(
                            pending,
                            &ControlResponse {
                                ok: false,
                                state: "rejected",
                                message: Some(&message),
                                endpoints: None,
                                inventory_seq: None,
                                connection: Some("connected"),
                                desired_inventory_digest: None,
                                config_modified_at_ms: None,
                                desired_endpoints: None,
                                inventory_digest: None,
                                inventory_acknowledged_at: None,
                            },
                        );
                    }
                }
            }
            #[cfg(unix)]
            if restore_timed_out_reload_on_rejection(
                timed_out_reload_candidates,
                &id,
                config,
                rejected_inventory_digest,
            ) {
                // The caller already received `publish_uncertain`, but an
                // explicit late rejection is authoritative. Revert the
                // temporary union map so removed routes cannot remain
                // executable, and retain the rejected desired identity for
                // truthful status reporting against the on-disk candidate.
                tracing::warn!(id, "late inventory rejection resolved uncertain publish");
            }
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
                worker.cancellation.cancel();
                drop(worker.body_tx);
                drop(worker.join);
                let cancelled = ClientControlMessage::RelayCancelled { request_id };
                send_control(
                    socket,
                    &cancelled,
                    "sending relay cancellation acknowledgement",
                )?;
            }
        }
        ServerControlMessage::RelayRequest {
            request_id,
            method,
            path,
            headers,
            timeout_ms,
            endpoint_slug,
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
                endpoint_slug,
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
    endpoint_slug: String,
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

    let Some(endpoint) = config
        .endpoints
        .iter()
        .find(|endpoint| endpoint.enabled && endpoint.slug == endpoint_slug)
    else {
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::NotFound,
            Some(format!("endpoint `{endpoint_slug}` is not enabled")),
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
    if !cancellation.cancelled.load(Ordering::SeqCst) {
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
    for (name, value) in &spec.request_headers {
        // When streaming a body, let the HTTP client frame it (chunked). Drop any
        // caller-provided framing headers to avoid a content-length mismatch.
        if spec.has_body && (name == "content-length" || name == "transfer-encoding") {
            continue;
        }
        builder = builder.header(name, value);
    }
    for (name, env) in &spec.endpoint_headers {
        let value = std::env::var(env)
            .with_context(|| format!("reading endpoint header `{name}` from `{env}`"))?;
        builder = builder.header(name, value);
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
        let body = streaming_request_body(
            rx,
            tx.clone(),
            spec.request_id.clone(),
            cancellation_rx.clone(),
        );
        builder.body(reqwest::Body::wrap_stream(body))
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
        .collect::<BTreeMap<_, _>>();
    worker_send_control(
        tx,
        &ClientControlMessage::RelayResponseHeaders {
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
            bytes = tokio::time::timeout(UPSTREAM_RESPONSE_IDLE_TIMEOUT, response.chunk()) => {
                bytes.context("upstream response idle timeout")?
                    .context("reading upstream response body")?
            },
        };
        let Some(bytes) = bytes else { break };
        append_usage_tail(&mut usage_tail, &bytes);
        completion_text.feed(&bytes);
        relay_response_chunk(tx, &spec.request_id, &bytes, &mut index)?;
    }
    let metadata = RelayBinaryFrameMetadata {
        r#type: RelayBinaryFrameType::ResponseBody,
        request_id: spec.request_id.clone(),
        chunk_id: index.to_string(),
        final_chunk: Some(true),
    };
    worker_send_binary(tx, &metadata, &[])?;
    // Preserve provider usage while attaching separate `cl100k_base` metrics
    // for comparable cross-model Chat Test TPS. A bounded collector returns
    // `None` rather than retaining a huge response.
    let usage = terminal_usage_from_response(&usage_tail);
    let metrics = standardized_completion_metrics(completion_text.finish().as_deref());
    worker_send_control(
        tx,
        &ClientControlMessage::RelayComplete {
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

/// Extract upstream-provided terminal usage from either a JSON completion or
/// the final OpenAI SSE `data:` event. Shared-tokenizer accounting is separate
/// from usage and happens in [`standardized_completion_metrics`].
fn terminal_usage_from_response(bytes: &[u8]) -> Option<crate::protocol::RelayUsage> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Completion {
        usage: Option<crate::protocol::RelayUsage>,
    }

    serde_json::from_slice::<Completion>(bytes)
        .ok()
        .and_then(|completion| completion.usage)
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
            })
        })
}

/// Parse a complete `usage` object from a bounded trailing window of a large
/// non-stream JSON response. Unlike deserializing the whole tail, this remains
/// valid when the beginning of the document was intentionally discarded.
fn terminal_usage_from_json_tail(bytes: &[u8]) -> Option<crate::protocol::RelayUsage> {
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
            serde_json::from_slice(&bytes[index..end]).ok()
        })
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
        &ClientControlMessage::RelayError {
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

fn worker_send_control(tx: &SyncSender<FromWorker>, message: &ClientControlMessage) -> Result<()> {
    let request_id = match message {
        ClientControlMessage::RelayRequestBodyAck { request_id, .. }
        | ClientControlMessage::RelayResponseHeaders { request_id, .. }
        | ClientControlMessage::RelayComplete { request_id, .. }
        | ClientControlMessage::RelayError { request_id, .. }
        | ClientControlMessage::RelayCancelled { request_id } => request_id.clone(),
        ClientControlMessage::Hello { .. }
        | ClientControlMessage::InventoryUpdate { .. }
        | ClientControlMessage::Heartbeat { .. } => {
            anyhow::bail!("worker emitted non-request relay control")
        }
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
    metadata: &RelayBinaryFrameMetadata,
    body: &[u8],
) -> Result<()> {
    let request_id = metadata.request_id.clone();
    let frame = encode_binary_frame(metadata, body)?;
    tx.send(FromWorker::Send {
        request_id,
        frame: WsFrame::Binary(frame),
    })
    .map_err(|_| anyhow::anyhow!("relay outbound channel closed"))
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
        let metadata = RelayBinaryFrameMetadata {
            r#type: RelayBinaryFrameType::ResponseBody,
            request_id: request_id.to_string(),
            chunk_id: index.to_string(),
            final_chunk: None,
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

/// Probe a candidate snapshot and construct its inventory. Persistence belongs
/// to `prepare_inventory_candidate`, which rechecks the desired snapshot under
/// the short-lived config lock before it writes anything.
fn inventory_from_config(config: &mut Config) -> Vec<EndpointInventory> {
    let enabled = config
        .endpoints
        .iter()
        .filter(|endpoint| endpoint.enabled)
        .cloned()
        .collect::<Vec<_>>();
    let mut reports = Vec::with_capacity(enabled.len());
    for batch in enabled.chunks(INVENTORY_PROBE_CONCURRENCY) {
        let batch_reports = thread::scope(|scope| {
            let handles = batch
                .iter()
                .cloned()
                .map(|endpoint| {
                    let probe_endpoint_config = endpoint.clone();
                    (
                        endpoint,
                        scope.spawn(move || probe_endpoint(&probe_endpoint_config)),
                    )
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|(endpoint, handle)| match handle.join() {
                    Ok(report) => report,
                    Err(_) => {
                        tracing::warn!(endpoint = %endpoint.slug, "endpoint probe worker panicked");
                        ProbeReport {
                            endpoint_slug: endpoint.slug,
                            status: crate::config::ProbeStatus::Offline,
                            discovered_model_ids: Vec::new(),
                            suggested_default_capabilities: endpoint.default_capabilities,
                            model_suggestions: Vec::new(),
                            error: Some("endpoint probe worker panicked".to_string()),
                        }
                    }
                })
                .collect::<Vec<_>>()
        });
        reports.extend(batch_reports);
    }
    for report in reports {
        if let Err(error) = apply_probe_report(config, &report, false) {
            tracing::warn!(error = %error, endpoint = report.endpoint_slug, "failed to apply probe report");
        }
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
    let request_path = request_path.trim_start_matches('/');
    // Upstreams commonly document either their origin or their `/v1` base URL.
    // Keep the configured URL intact, but avoid duplicating that version prefix
    // when the relay receives an OpenAI-shaped `/v1/...` request from WMP.
    let request_path = if base.path().trim_end_matches('/').ends_with("/v1") {
        request_path.strip_prefix("v1/").unwrap_or(request_path)
    } else {
        request_path
    };
    if !base.path().ends_with('/') {
        let next = format!("{}/", base.path());
        base.set_path(&next);
    }
    base.join(request_path)
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
    use std::io::Write;

    #[cfg(unix)]
    #[test]
    fn status_json_exposes_local_probe_and_server_acknowledgement() {
        let mut config = Config::default();
        config.endpoints.push(crate::config::EndpointConfig {
            slug: "local".to_string(),
            label: "Local".to_string(),
            enabled: true,
            models: vec![crate::config::ModelConfig::default()],
            last_probe: Some(crate::config::ProbeSnapshot {
                status: crate::config::ProbeStatus::Online,
                models: vec!["model-a".to_string()],
                suggested_capabilities: crate::config::OpenAiCompatibleCapabilities::default(),
            }),
            ..Default::default()
        });
        let desired_inventory = config
            .endpoints
            .iter()
            .filter(|endpoint| endpoint.enabled)
            .map(|endpoint| endpoint_inventory(endpoint, EndpointStatus::Online))
            .collect::<Vec<_>>();
        let revision = crate::protocol::InventoryRevision {
            inventory_seq: 42,
            inventory_digest: crate::protocol::inventory_digest(&desired_inventory),
            inventory_acknowledged_at: "2026-08-05T00:00:00Z".to_string(),
        };

        let value = serde_json::to_value(live_status_response(
            &config,
            Some(&revision),
            "connected",
            None,
        ))
        .expect("serialize status");

        assert_eq!(value["connection"], "connected");
        assert_eq!(value["inventorySeq"], 42);
        assert_eq!(value["inventoryDigest"], revision.inventory_digest);
        assert_eq!(value["inventoryAcknowledgedAt"], "2026-08-05T00:00:00Z");
        assert_eq!(
            value["desiredInventoryDigest"].as_str().map(str::len),
            Some(64)
        );
        assert_eq!(value["desiredEndpoints"][0]["localProbe"], "online");
        assert_eq!(value["desiredEndpoints"][0]["published"], "current");
    }

    #[cfg(unix)]
    #[test]
    fn status_marks_a_server_rejected_desired_inventory_as_rejected() {
        let config = Config::default();
        let revision = crate::protocol::InventoryRevision {
            inventory_seq: 7,
            inventory_digest: crate::protocol::inventory_digest(&[]),
            inventory_acknowledged_at: "2026-08-05T00:00:00Z".to_string(),
        };
        let rejected = crate::protocol::inventory_digest(&[]);
        let value = serde_json::to_value(live_status_response(
            &config,
            Some(&revision),
            "connected",
            Some(&rejected),
        ))
        .expect("serialize rejected status");

        assert_eq!(value["ok"], false);
        assert_eq!(value["state"], "rejected");
        assert!(
            value["message"]
                .as_str()
                .is_some_and(|message| message.contains("server rejected"))
        );
    }

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
            let (metadata, body) = parse_binary_frame(&encoded).expect("parse bounded frame");
            assert_eq!(metadata.chunk_id, expected_index.to_string());
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
            &worker_tx,
            &mut workers,
            &recent_finished,
            "req-1".to_string(),
            "POST".to_string(),
            "/v1/chat/completions".to_string(),
            BTreeMap::new(),
            1_000,
            "local".to_string(),
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
            "local".to_string(),
            false,
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
    fn endpoint_url_does_not_duplicate_a_configured_v1_prefix() {
        assert_eq!(
            endpoint_url("http://localhost:11434/v1", "/v1/chat/completions")
                .expect("URL should join")
                .as_str(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url("http://localhost:11434/v1/", "/v1/chat/completions")
                .expect("URL should join")
                .as_str(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url("http://localhost:11434", "/v1/chat/completions")
                .expect("URL should join")
                .as_str(),
            "http://localhost:11434/v1/chat/completions"
        );
        // Base paths that merely contain `v1` as a longer segment keep the request path.
        assert_eq!(
            endpoint_url("http://localhost:11434/api/v1beta", "/v1/models")
                .expect("URL should join")
                .as_str(),
            "http://localhost:11434/api/v1beta/v1/models"
        );
        // Non-versioned request paths still join normally onto a `/v1` base.
        assert_eq!(
            endpoint_url("http://localhost:11434/v1", "/models")
                .expect("URL should join")
                .as_str(),
            "http://localhost:11434/v1/models"
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
    fn reconnect_reuses_only_an_unchanged_acknowledged_snapshot() {
        let active = Config::default();
        let inventory = inventory_snapshot_from_config(&active);
        let revision = crate::protocol::InventoryRevision {
            inventory_seq: 7,
            inventory_digest: crate::protocol::inventory_digest(&inventory),
            inventory_acknowledged_at: "2026-08-06T00:00:00Z".to_string(),
        };
        let modified_at = UNIX_EPOCH + Duration::from_secs(42);

        assert!(should_reuse_reconnect_inventory(
            &active,
            &active,
            Some(modified_at),
            modified_at,
            Some(&revision),
        ));

        let mut changed = active.clone();
        changed.endpoints.push(crate::config::EndpointConfig {
            slug: "changed-endpoint".to_string(),
            ..Default::default()
        });
        assert!(!should_reuse_reconnect_inventory(
            &active,
            &changed,
            Some(modified_at),
            modified_at,
            Some(&revision),
        ));
        assert!(!should_reuse_reconnect_inventory(
            &active,
            &active,
            Some(modified_at),
            modified_at + Duration::from_secs(1),
            Some(&revision),
        ));
    }

    #[test]
    fn terminal_usage_comes_from_the_final_sse_completion_event() {
        let response = b"data: {\"usage\":{\"completionTokens\":2}}\n\ndata: {\"usage\":{\"promptTokens\":3,\"completionTokens\":5,\"totalTokens\":8}}\n\ndata: [DONE]\n\n";
        assert_eq!(
            terminal_usage_from_response(response),
            Some(crate::protocol::RelayUsage {
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
            Some(crate::protocol::RelayUsage {
                prompt_tokens: Some(3),
                completion_tokens: Some(5),
                total_tokens: Some(8),
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn pending_reload_routes_both_old_and_candidate_slugs_until_acknowledgement() {
        let mut live = Config::default();
        live.endpoints.push(crate::config::EndpointConfig {
            slug: "old-endpoint".to_string(),
            enabled: true,
            ..Default::default()
        });
        let mut candidate = Config::default();
        candidate.endpoints.push(crate::config::EndpointConfig {
            slug: "new-endpoint".to_string(),
            enabled: true,
            ..Default::default()
        });

        let pending = pending_reload_routing_map(&live, &candidate);

        // A request selected from the already acknowledged inventory still
        // reaches its old endpoint, while an early server dispatch selected
        // from the candidate can reach the new endpoint.
        assert!(pending.endpoint("old-endpoint").is_some());
        assert!(pending.endpoint("new-endpoint").is_some());
        // `inventory.ok` is the atomic cutover point.
        assert!(candidate.endpoint("old-endpoint").is_none());
        assert!(candidate.endpoint("new-endpoint").is_some());
    }

    #[cfg(unix)]
    #[test]
    fn acknowledgement_timeout_restores_previous_routes_before_late_acknowledgement() {
        let mut previous = Config::default();
        previous.endpoints.push(crate::config::EndpointConfig {
            slug: "old-endpoint".to_string(),
            enabled: true,
            ..Default::default()
        });
        let mut candidate = Config::default();
        candidate.endpoints.push(crate::config::EndpointConfig {
            slug: "new-endpoint".to_string(),
            enabled: true,
            ..Default::default()
        });
        let mut live = pending_reload_routing_map(&previous, &candidate);

        restore_previous_routing_after_timeout(&mut live, &previous);

        assert_eq!(live, previous);
        assert!(live.endpoint("new-endpoint").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn late_inventory_rejection_restores_the_previous_routing_map() {
        let mut previous = Config::default();
        previous.endpoints.push(crate::config::EndpointConfig {
            slug: "old-endpoint".to_string(),
            enabled: true,
            ..Default::default()
        });
        let mut candidate = Config::default();
        candidate.endpoints.push(crate::config::EndpointConfig {
            slug: "new-endpoint".to_string(),
            enabled: true,
            ..Default::default()
        });
        let candidate_digest = inventory_digest_for_config(&candidate);
        let mut live = pending_reload_routing_map(&previous, &candidate);
        let mut timed_out = TimedOutReloads::new();
        timed_out.insert("inventory-1".to_string(), (candidate, previous.clone()));
        let mut rejected_digest = None;

        assert!(restore_timed_out_reload_on_rejection(
            &mut timed_out,
            "inventory-1",
            &mut live,
            &mut rejected_digest,
        ));
        assert_eq!(live, previous);
        assert_eq!(rejected_digest.as_deref(), Some(candidate_digest.as_str()));
        assert!(timed_out.by_id.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn late_ack_for_superseded_a_cannot_clobber_successful_b() {
        let mut candidate_a = Config::default();
        candidate_a.endpoints.push(crate::config::EndpointConfig {
            slug: "candidate-a".to_string(),
            ..Default::default()
        });
        let mut candidate_b = Config::default();
        candidate_b.endpoints.push(crate::config::EndpointConfig {
            slug: "candidate-b".to_string(),
            ..Default::default()
        });
        let revision_b = crate::protocol::InventoryRevision {
            inventory_seq: 2,
            inventory_digest: "digest-b".to_string(),
            inventory_acknowledged_at: "2026-08-05T00:00:00Z".to_string(),
        };
        let mut timed_out = TimedOutReloads::new();
        timed_out.insert("inventory-a".to_string(), (candidate_a, Config::default()));

        // Starting B deliberately supersedes uncertain A before B is prepared.
        timed_out.clear_for_new_reload();
        let mut live = candidate_b.clone();
        let mut acknowledged = Some(revision_b.clone());
        let late_a = crate::protocol::InventoryRevision {
            inventory_seq: 1,
            inventory_digest: "digest-a".to_string(),
            inventory_acknowledged_at: "2026-08-05T00:00:01Z".to_string(),
        };

        assert!(!adopt_timed_out_reload_ack(
            &mut timed_out,
            "inventory-a",
            late_a,
            &mut live,
            &mut acknowledged,
        ));
        assert_eq!(live, candidate_b);
        assert_eq!(
            acknowledged.as_ref().map(|revision| revision.inventory_seq),
            Some(revision_b.inventory_seq)
        );
        assert_eq!(
            acknowledged
                .as_ref()
                .map(|revision| revision.inventory_digest.as_str()),
            Some(revision_b.inventory_digest.as_str())
        );
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_reload_capacity_evicts_only_the_oldest_candidate() {
        let mut timed_out = TimedOutReloads::new();
        for index in 0..=TIMED_OUT_RELOAD_ID_CAPACITY {
            timed_out.insert(
                format!("inventory-{index}"),
                (Config::default(), Config::default()),
            );
        }

        assert_eq!(timed_out.by_id.len(), TIMED_OUT_RELOAD_ID_CAPACITY);
        assert!(!timed_out.by_id.contains_key("inventory-0"));
        assert!(timed_out.by_id.contains_key("inventory-1"));
        assert!(
            timed_out
                .by_id
                .contains_key(&format!("inventory-{TIMED_OUT_RELOAD_ID_CAPACITY}"))
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
            timeout_ms: 2_000,
            has_body: false,
            expand_media: false,
            trusted_origins: TrustedOrigins::new(None, &[]),
        }
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
            thread::sleep(Duration::from_millis(300));
        });
        let (tx, rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        let (cancellation, cancellation_rx) = CancellationHandle::new();
        let cancel = thread::spawn(move || {
            accepted_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("upstream should receive request before cancellation");
            assert!(cancellation.cancel());
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_millis(150),
                    execute_upstream(
                        local_upstream_spec(format!("http://{address}")),
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
        server.join().expect("test upstream thread");
        assert!(
            rx.try_recv().is_err(),
            "cancelled request must not emit late relay frames"
        );
    }
}
