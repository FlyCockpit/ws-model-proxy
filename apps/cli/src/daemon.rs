//! Foreground websocket relay daemon.

use std::collections::BTreeMap;
use std::io::Read;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::{Message, connect};
use url::Url;

use crate::auth::{join, resolve_credential};
use crate::config::{Config, EndpointConfig};
use crate::probe::{apply_probe_report, probe_endpoint};
use crate::protocol::{
    CliCapabilities, CliInventory, ClientControlMessage, EndpointInventory, EndpointStatus,
    RELAY_BINARY_CHUNK_MAX_BYTES, RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS, RELAY_PROTOCOL_VERSION,
    RELAY_SUBPROTOCOL, RelayBinaryFrameMetadata, RelayBinaryFrameType, RelayFailure,
    ServerControlMessage, encode_binary_frame, encode_control, endpoint_inventory,
    parse_binary_frame, parse_server_control,
};
use crate::slug::generated_slug;

const RELAY_MAX_BUFFERED_REQUEST_BODY_CHUNKS: usize = 8;
const RELAY_RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(1);
const RELAY_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(300);

struct PendingRelayRequest {
    request_id: String,
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    timeout_ms: u64,
    body_chunks: Vec<Vec<u8>>,
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
    set_plain_read_timeout(socket.get_mut());

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
        .send(Message::Text(hello))
        .map_err(|error| websocket_session_error(error, "sending relay hello", false))?;

    let mut next_heartbeat =
        Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
    let mut pending_requests = BTreeMap::<String, PendingRelayRequest>::new();
    loop {
        if Instant::now() >= next_heartbeat {
            let heartbeat = ClientControlMessage::Heartbeat {
                id: next_id("heartbeat"),
                sent_at: None,
            };
            send_control(&mut socket, &heartbeat, "sending relay heartbeat")?;
            next_heartbeat =
                Instant::now() + Duration::from_secs(RELAY_CLIENT_HEARTBEAT_INTERVAL_SECS);
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                handle_text(&mut socket, config, &text, &mut pending_requests)?;
            }
            Ok(Message::Binary(bytes)) => {
                handle_binary(&mut socket, config, &bytes, &mut pending_requests)?;
            }
            Ok(Message::Close(frame)) => {
                tracing::warn!(?frame, "relay websocket closed by server");
                return Err(RelaySessionError::Reconnectable {
                    error: anyhow::anyhow!("relay websocket closed by server"),
                    reset_backoff: true,
                });
            }
            Ok(Message::Ping(bytes)) => socket
                .send(Message::Pong(bytes))
                .map_err(|error| websocket_session_error(error, "sending relay pong", true))?,
            Ok(Message::Pong(_)) => {}
            Ok(Message::Frame(_)) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut => {}
            Err(err) => {
                return Err(websocket_session_error(
                    err,
                    "reading relay websocket",
                    true,
                ));
            }
        }
    }
}

fn handle_text<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    text: &str,
    pending_requests: &mut BTreeMap<String, PendingRelayRequest>,
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
            pending_requests.remove(&request_id);
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
            ..
        } => {
            if expects_request_body(&method, &headers) {
                pending_requests.insert(
                    request_id.clone(),
                    PendingRelayRequest {
                        request_id,
                        method,
                        path,
                        headers,
                        timeout_ms,
                        body_chunks: Vec::new(),
                    },
                );
            } else {
                handle_relay_request(
                    socket,
                    config,
                    RelayRequestToForward {
                        request_id: &request_id,
                        method: &method,
                        path: &path,
                        headers: &headers,
                        timeout_ms,
                        body: &[],
                    },
                )?;
            }
        }
    }
    Ok(())
}

fn handle_binary<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    bytes: &[u8],
    pending_requests: &mut BTreeMap<String, PendingRelayRequest>,
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

    let Some(pending) = pending_requests.get_mut(&metadata.request_id) else {
        send_relay_error(
            socket,
            &metadata.request_id,
            RelayFailure::ProtocolError,
            Some("request body chunk arrived before request metadata".to_string()),
            None,
        )?;
        return Ok(());
    };

    if pending.body_chunks.len() >= RELAY_MAX_BUFFERED_REQUEST_BODY_CHUNKS {
        let request_id = pending.request_id.clone();
        pending_requests.remove(&request_id);
        send_relay_error(
            socket,
            &request_id,
            RelayFailure::RequestTooLarge,
            Some("request body has too many chunks".to_string()),
            None,
        )?;
        return Ok(());
    }

    tracing::debug!(
        request_id = metadata.request_id,
        bytes = body.len(),
        "received relay request body chunk"
    );
    pending.body_chunks.push(body);

    if metadata.final_chunk == Some(true) {
        let Some(pending) = pending_requests.remove(&metadata.request_id) else {
            return Ok(());
        };
        let body = pending.body_chunks.concat();
        handle_relay_request(
            socket,
            config,
            RelayRequestToForward {
                request_id: &pending.request_id,
                method: &pending.method,
                path: &pending.path,
                headers: &pending.headers,
                timeout_ms: pending.timeout_ms,
                body: &body,
            },
        )?;
    }
    Ok(())
}

struct RelayRequestToForward<'a> {
    request_id: &'a str,
    method: &'a str,
    path: &'a str,
    headers: &'a BTreeMap<String, String>,
    timeout_ms: u64,
    body: &'a [u8],
}

fn handle_relay_request<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    relay_request: RelayRequestToForward<'_>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let Some(endpoint) = config.endpoints.iter().find(|endpoint| endpoint.enabled) else {
        send_relay_error(
            socket,
            relay_request.request_id,
            RelayFailure::NotFound,
            Some("no enabled endpoints are configured".to_string()),
            None,
        )?;
        return Ok(());
    };
    match open_upstream_response(endpoint, &relay_request) {
        Ok(response) => {
            let status = response.status();
            let headers = response
                .headers_names()
                .into_iter()
                .filter_map(|name| {
                    response
                        .header(&name)
                        .map(|value| (name.to_ascii_lowercase(), value.to_string()))
                })
                .collect::<BTreeMap<_, _>>();
            let header_frame = ClientControlMessage::RelayResponseHeaders {
                request_id: relay_request.request_id.to_string(),
                status,
                headers,
            };
            send_control(socket, &header_frame, "sending relay response headers")?;
            let mut reader = response.into_reader();
            let mut chunk = vec![0_u8; RELAY_BINARY_CHUNK_MAX_BYTES];
            let mut index = 0_usize;
            loop {
                let read = reader.read(&mut chunk).map_err(|error| {
                    RelaySessionError::Fatal(
                        anyhow::Error::new(error).context("reading upstream response body"),
                    )
                })?;
                if read == 0 {
                    break;
                }
                let metadata = RelayBinaryFrameMetadata {
                    r#type: RelayBinaryFrameType::ResponseBody,
                    request_id: relay_request.request_id.to_string(),
                    chunk_id: index.to_string(),
                    final_chunk: None,
                };
                let frame = encode_binary_frame(&metadata, &chunk[..read])
                    .map_err(RelaySessionError::Fatal)?;
                send_binary(socket, frame, "sending relay response body chunk")?;
                index += 1;
            }
            let metadata = RelayBinaryFrameMetadata {
                r#type: RelayBinaryFrameType::ResponseBody,
                request_id: relay_request.request_id.to_string(),
                chunk_id: index.to_string(),
                final_chunk: Some(true),
            };
            let frame = encode_binary_frame(&metadata, &[]).map_err(RelaySessionError::Fatal)?;
            send_binary(socket, frame, "sending final relay response body chunk")?;
            send_control(
                socket,
                &ClientControlMessage::RelayComplete {
                    request_id: relay_request.request_id.to_string(),
                },
                "sending relay completion",
            )?;
        }
        Err(error) => {
            tracing::warn!(error = %error, "relay upstream request failed");
            send_relay_error(
                socket,
                relay_request.request_id,
                RelayFailure::Transport,
                Some("upstream request failed".to_string()),
                None,
            )?;
        }
    }
    Ok(())
}

fn open_upstream_response(
    endpoint: &EndpointConfig,
    relay_request: &RelayRequestToForward<'_>,
) -> Result<ureq::Response> {
    let url = endpoint_url(&endpoint.base_url, relay_request.path)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(relay_request.timeout_ms))
        .build();
    let mut request = agent.request(relay_request.method, url.as_str());
    for (name, value) in relay_request.headers {
        request = request.set(name, value);
    }
    for header in &endpoint.headers {
        let value = std::env::var(&header.env).with_context(|| {
            format!(
                "reading endpoint header `{}` from `{}`",
                header.name, header.env
            )
        })?;
        request = request.set(&header.name, &value);
    }
    let response = match if relay_request.body.is_empty() {
        request.call()
    } else {
        request.send_bytes(relay_request.body)
    } {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(error).context("forwarding relay request to upstream endpoint"),
    };
    Ok(response)
}

fn expects_request_body(method: &str, headers: &BTreeMap<String, String>) -> bool {
    let method = method.to_ascii_uppercase();
    if matches!(method.as_str(), "GET" | "HEAD" | "DELETE") {
        return false;
    }
    headers
        .get("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .is_none_or(|length| length > 0)
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
        .send(Message::Text(text))
        .map_err(|error| websocket_session_error(error, context, true))
}

fn send_binary<S>(
    socket: &mut tungstenite::WebSocket<S>,
    bytes: Vec<u8>,
    context: &'static str,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    socket
        .send(Message::Binary(bytes))
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

fn set_plain_read_timeout(stream: &mut tungstenite::stream::MaybeTlsStream<std::net::TcpStream>) {
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = stream {
        if let Err(error) = stream.set_read_timeout(Some(Duration::from_secs(1))) {
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
