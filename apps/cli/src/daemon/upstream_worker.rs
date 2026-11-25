//! One relayed request's worker thread: count-first, media expansion and
//! the upstream HTTP request, its response streamed back as relay frames.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::watch;
use url::Url;

use crate::config::EndpointAuthMode;
use crate::media::{
    FetchedMedia, MEDIA_EXPAND_MAX_ASSET_BYTES, MEDIA_EXPAND_MAX_BODY_BYTES, MediaExpandError,
    TrustedOrigins, expand_media_in_body, trusted_media_urls_in_body,
};
use crate::protocol::frames::CountMethod;
use crate::protocol::{
    NodeBinaryMetadata, NodeFrame, RelayFailure, encode_binary_frame, encode_control,
};
use crate::relay_bus::{FromWorker, WsFrame};
use crate::tokens::{CompletionTextCollector, standardized_completion_metrics};

use super::request_body::{
    BodyChunk, BufferedBody, CollectError, PrefixedBody, UNSIZED_BODY_BUFFER_BYTES,
    buffer_body_prefix, collect_request_body, exact_length_body, streaming_request_body,
};
use super::usage::{append_usage_tail, terminal_usage_from_response};

/// Per-request timeout for fetching a WMP media URL during media expansion.
/// Independent of the upstream request timeout so a slow asset fetch fails on its
/// own clock rather than silently eating the whole upstream budget.
const RELAY_MEDIA_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// A cancellation request is idempotent and wakes the async HTTP operation.
/// Dropping its selected request/response future closes the upstream connection,
/// including while DNS/connect, upload, or an idle response read is pending.
#[derive(Clone)]
pub(super) struct CancellationHandle {
    pub(super) cancelled: Arc<AtomicBool>,
    notify: watch::Sender<bool>,
}

impl CancellationHandle {
    pub(super) fn new() -> (Self, watch::Receiver<bool>) {
        let (notify, receiver) = watch::channel(false);
        (
            Self {
                cancelled: Arc::new(AtomicBool::new(false)),
                notify,
            },
            receiver,
        )
    }

    pub(super) fn cancel(&self) -> bool {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return false;
        }
        let _ = self.notify.send(true);
        true
    }
}

/// Everything a worker thread needs to perform one upstream request.
pub(super) struct UpstreamRequestSpec {
    pub(super) request_id: String,
    pub(super) method: String,
    pub(super) base_url: String,
    pub(super) path: String,
    pub(super) request_headers: BTreeMap<String, String>,
    pub(super) endpoint_headers: Vec<(String, String)>,
    pub(super) endpoint_auth: Option<(EndpointAuthMode, String)>,
    pub(super) timeout_ms: u64,
    pub(super) has_body: bool,
    /// The body length the server declared. A streamed body is sent with this
    /// Content-Length: strict OpenAI-compatible servers (TensorFold, gufo)
    /// answer a chunked request body with 400.
    pub(super) body_bytes: Option<u64>,
    /// When set, buffer a chat-shaped JSON body and inline trusted media URLs as
    /// `data:` URLs before forwarding. Off for the plain streaming relay path.
    pub(super) expand_media: bool,
    /// Origins whose `/media/{id}` URLs may be fetched during expansion.
    pub(super) trusted_origins: TrustedOrigins,
}

const COUNT_FIRST_TIMEOUT_MS: u64 = 5_000;

fn count_first_exceeds_ceiling(tokens: u64, ceiling: Option<u64>) -> bool {
    ceiling.is_some_and(|max| tokens > max)
}

pub(super) struct CountFirstPlan {
    pub(super) method: Option<crate::engine_facts::CountContextMethod>,
    pub(super) adapter_count_route: Option<String>,
    pub(super) count_ceiling: Option<u64>,
}

pub(super) fn run_count_first_worker(
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
pub(super) fn run_upstream_worker(
    spec: UpstreamRequestSpec,
    body_rx: Option<Receiver<BodyChunk>>,
    tx: SyncSender<FromWorker>,
    cancellation: CancellationHandle,
    cancellation_rx: watch::Receiver<bool>,
) {
    let request_id = spec.request_id.clone();
    let mut phase = ResponsePhase::Requesting;
    let result = crate::upstream::runtime().and_then(|runtime| {
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
    let url = crate::upstream::endpoint_url(&spec.base_url, &spec.path)?;
    let client = crate::upstream::http_client()?;
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

/// The engine tokenize route this endpoint's last probe found.
pub(super) fn endpoint_count_method(
    endpoint: &crate::config::EndpointConfig,
) -> Option<crate::engine_facts::CountContextMethod> {
    endpoint
        .last_probe
        .as_ref()
        .and_then(|probe| probe.engine.as_ref())
        .and_then(|engine| engine.count_context)
        .and_then(crate::engine_facts::CountContextFact::method)
}

/// The wire name of a count method (`AdapterCount` is a reader count).
fn count_method(method: crate::engine_facts::CountContextMethod) -> CountMethod {
    use crate::engine_facts::CountContextMethod as Local;
    match method {
        Local::VllmTokenize => CountMethod::VllmTokenize,
        Local::TgiChatTokenize => CountMethod::TgiChatTokenize,
        Local::LlamaApplyTemplate => CountMethod::LlamaApplyTemplate,
        Local::LlamaInputTokens => CountMethod::LlamaInputTokens,
        Local::AdapterCount => CountMethod::ReaderCount,
    }
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

#[cfg(test)]
mod tests {
    use super::super::link::RELAY_WORKER_OUTBOUND_CAPACITY;
    use super::*;
    use crate::protocol::decode_binary_frame;
    use std::io;
    use std::io::Write;
    use std::thread::{self, JoinHandle};

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
    fn count_first_exceeds_ceiling_is_exclusive() {
        assert!(!count_first_exceeds_ceiling(8, None));
        assert!(!count_first_exceeds_ceiling(8, Some(8)));
        assert!(count_first_exceeds_ceiling(9, Some(8)));
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
}
