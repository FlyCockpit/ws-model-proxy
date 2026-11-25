//! Opening the relay websocket (redirects, deadline) and the hello
//! challenge, and how a refusal along the way ends: retried, retried
//! slowly, or stopped with its own exit code ([`StopOn`]).

use std::io;
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use url::Url;

use crate::node::auth::join;
use crate::wire::protocol::{
    ProtocolErrorCode, RELAY_PROTOCOL_VERSION, ServerFrame, hello_rejection_message,
    parse_server_control,
};

use super::backoff::{RELAY_RECONNECT_MAX_DELAY, RetryFloor, RetryFloorSource};
use super::wire::{RelaySessionError, RelaySessionResult, read_poll_woke, websocket_session_error};

/// Bound on waiting for `hello.challenge`.
const HELLO_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(15);

const RELAY_CONNECT_DEADLINE: Duration = Duration::from_secs(30);
const RELAY_MAX_REDIRECTS: usize = 3;

/// Relay handshakes still running on helper threads, given up on or not. One stuck before any
/// I/O (loading the system's root certificates) keeps its place until it ends, so reconnects
/// cannot pile up threads: past this, an attempt fails at once like one that timed out.
const MAX_HANDSHAKE_HELPERS: usize = 8;

static HANDSHAKE_HELPERS: AtomicUsize = AtomicUsize::new(0);

/// One of [`MAX_HANDSHAKE_HELPERS`], held by its helper thread until it ends.
struct HandshakeHelper;

impl HandshakeHelper {
    fn take() -> Option<Self> {
        // A CAS loop, as `fetch_update`'s replacement needs a newer compiler than the MSRV.
        let mut held = HANDSHAKE_HELPERS.load(Ordering::Acquire);
        loop {
            if held >= MAX_HANDSHAKE_HELPERS {
                return None;
            }
            match HANDSHAKE_HELPERS.compare_exchange_weak(
                held,
                held + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self),
                Err(current) => held = current,
            }
        }
    }
}

impl Drop for HandshakeHelper {
    fn drop(&mut self) {
        HANDSHAKE_HELPERS.fetch_sub(1, Ordering::AcqRel);
    }
}

type RelaySocket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

/// Default ports remain equivalent across a TLS upgrade; custom ports must match.
fn relay_redirect_allowed(from: &Url, to: &Url, followed: usize) -> bool {
    let scheme = |url: &Url| match url.scheme() {
        "http" | "ws" => Some(false),
        "https" | "wss" => Some(true),
        _ => None,
    };
    let schemes_allowed = match (scheme(from), scheme(to)) {
        (Some(secure), Some(next_secure)) => !secure || next_secure,
        _ => false,
    };
    followed < RELAY_MAX_REDIRECTS
        && schemes_allowed
        && from.host_str().is_some()
        && from.host_str() == to.host_str()
        && to.username().is_empty()
        && to.password().is_none()
        && (from.port_or_known_default() == to.port_or_known_default()
            || (from.port().is_none() && to.port().is_none()))
}

fn relay_connect_timeout() -> tungstenite::Error {
    io::Error::new(io::ErrorKind::TimedOut, "relay connection deadline elapsed").into()
}

pub(super) fn connect_relay(
    request: tungstenite::handshake::client::Request,
) -> tungstenite::Result<(RelaySocket, tungstenite::handshake::client::Response)> {
    connect_relay_with_deadline(request, RELAY_CONNECT_DEADLINE)
}

fn connect_relay_with_deadline(
    mut request: tungstenite::handshake::client::Request,
    timeout: Duration,
) -> tungstenite::Result<(RelaySocket, tungstenite::handshake::client::Response)> {
    let deadline = Instant::now() + timeout;
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(relay_connect_timeout)
    };
    for followed in 0..=RELAY_MAX_REDIRECTS {
        let url = Url::parse(&request.uri().to_string())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let host = match url.host() {
            Some(url::Host::Domain(host)) => host.to_string(),
            Some(url::Host::Ipv4(host)) => host.to_string(),
            Some(url::Host::Ipv6(host)) => host.to_string(),
            None => {
                return Err(tungstenite::Error::Url(
                    tungstenite::error::UrlError::NoHostName,
                ));
            }
        };
        let port = url.port_or_known_default().ok_or(tungstenite::Error::Url(
            tungstenite::error::UrlError::UnsupportedUrlScheme,
        ))?;
        // The system resolver has no timeout API. Keep its wait within the same
        // deadline as dialing and redirects, without blocking the relay forever.
        let (tx, rx) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("wsmp-relay-dns".into())
            .spawn(move || {
                let _ = tx.send(
                    (host.as_str(), port)
                        .to_socket_addrs()
                        .map(|addrs| addrs.collect::<Vec<_>>()),
                );
            })?;
        let addrs = rx
            .recv_timeout(remaining()?)
            .map_err(|_| relay_connect_timeout())??;
        let mut last_error = io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "no relay addresses resolved",
        );
        let mut connected = None;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, remaining()?.min(Duration::from_secs(10))) {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(error) => last_error = error,
            }
        }
        let stream = connected.ok_or(tungstenite::Error::Io(last_error))?;
        stream.set_nodelay(true)?;
        let handshake_timeout = remaining()?.min(Duration::from_secs(15));
        stream.set_read_timeout(Some(handshake_timeout))?;
        stream.set_write_timeout(Some(handshake_timeout))?;
        // Exactly connect()'s TLS defaults: rustls, the installed ring provider,
        // native root certificates, and no custom WebSocket config or connector.
        // For `wss` that loads the system's root certificates on every call, before
        // any I/O the socket timeouts bound (on macOS from the keychain, which can
        // take a second under load). So the handshake runs on a helper and is waited
        // for within the same deadline, as the resolver is. A handshake given up on
        // has its socket shut down, so it cannot go on talking to the peer.
        let wait = remaining()?;
        let helper = HandshakeHelper::take().ok_or_else(relay_connect_timeout)?;
        let abandon = stream.try_clone()?;
        let (tx, rx) = mpsc::sync_channel(1);
        let handshake_request = request.clone();
        thread::Builder::new()
            .name("wsmp-relay-handshake".into())
            .spawn(move || {
                let _helper = helper;
                let _ = tx.send(tungstenite::client_tls_with_config(
                    handshake_request,
                    stream,
                    None,
                    None,
                ));
            })?;
        let Ok(handshake) = rx.recv_timeout(wait) else {
            let _ = abandon.shutdown(Shutdown::Both);
            return Err(relay_connect_timeout());
        };
        let result = handshake.map_err(|error| match error {
            tungstenite::HandshakeError::Failure(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                relay_connect_timeout()
            }
            tungstenite::HandshakeError::Failure(error) => error,
            tungstenite::HandshakeError::Interrupted(_) => relay_connect_timeout(),
        });
        match result {
            Err(tungstenite::Error::Http(response)) if response.status().is_redirection() => {
                let target = response
                    .headers()
                    .get("Location")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|location| url.join(location).ok());
                let Some(mut target) =
                    target.filter(|to| relay_redirect_allowed(&url, to, followed))
                else {
                    return Err(tungstenite::Error::Http(response));
                };
                let scheme = match target.scheme() {
                    "http" => "ws",
                    "https" => "wss",
                    other => other,
                }
                .to_string();
                target.set_scheme(&scheme).map_err(|()| {
                    io::Error::new(io::ErrorKind::InvalidInput, "invalid relay redirect scheme")
                })?;
                let mut next = target.as_str().into_client_request()?;
                // Preserve the bearer only after the destination passed policy.
                // Host and the handshake key come from the new destination.
                for name in ["Authorization", "Sec-WebSocket-Protocol"] {
                    if let Some(value) = request.headers().get(name) {
                        next.headers_mut().insert(name, value.clone());
                    }
                }
                request = next;
            }
            other => return other,
        }
    }
    Err(relay_connect_timeout())
}

fn unexpected_hello_error(stop: StopOn) -> RelaySessionError {
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
pub(super) fn hello_rejection(
    message: &str,
    code: &ProtocolErrorCode,
    stop: StopOn,
) -> RelaySessionError {
    let text = hello_rejection_message(message, code);
    match code {
        ProtocolErrorCode::UpgradeCli | ProtocolErrorCode::UpgradeServer => {
            protocol_mismatch(anyhow::anyhow!(text), stop)
        }
        ProtocolErrorCode::AccessDenied => unrecoverable(
            anyhow::anyhow!(
                "{text}; if this machine's credential was revoked, run `wsmp login` to enroll it again"
            ),
            crate::exit::ExitCode::CredentialRejected,
            false,
        ),
        ProtocolErrorCode::IdentityMismatch => unrecoverable(
            anyhow::anyhow!("{text}; run `wsmp login` to enroll this machine again"),
            crate::exit::ExitCode::CredentialRejected,
            stop.credential,
        ),
        ProtocolErrorCode::Malformed | ProtocolErrorCode::Internal | ProtocolErrorCode::Unknown => {
            RelaySessionError::Fatal(anyhow::anyhow!(text))
        }
    }
}

pub(super) fn protocol_mismatch(error: anyhow::Error, stop: StopOn) -> RelaySessionError {
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
/// ([`Config::hello_origin`](crate::node::config::Config::hello_origin)). The server never chooses it.
pub(super) fn check_hello_origin(
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
    let fix = crate::node::origin::set_server_command(server_url, challenge_origin)
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

pub(super) fn wait_for_hello_challenge<S>(
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
                    "the server sent no hello.challenge within {} s (upgrade the server if this repeats)",
                    HELLO_CHALLENGE_TIMEOUT.as_secs()
                ),
            });
        }
        if let Some(signal) = crate::process::shutdown::requested() {
            return Err(RelaySessionError::Shutdown(signal));
        }
        match socket.read() {
            Ok(Message::Text(text)) => match parse_server_control(&text) {
                Ok(ServerFrame::HelloChallenge { nonce, origin }) => {
                    if origin.is_empty() {
                        return Err(unexpected_hello_error(stop));
                    }
                    return Ok((nonce, origin));
                }
                Ok(ServerFrame::ProtocolError { message, code, .. }) => {
                    if code == ProtocolErrorCode::Internal {
                        return Err(RelaySessionError::Reconnectable {
                            error: anyhow::anyhow!("relay protocol error: {message}"),
                        });
                    }
                    return Err(hello_rejection(&message, &code, stop));
                }
                Ok(_) => {
                    return Err(RelaySessionError::Fatal(anyhow::anyhow!(
                        "expected hello.challenge, received another control frame; upgrade the WS Model Proxy server"
                    )));
                }
                Err(error) => {
                    return Err(RelaySessionError::Reconnectable {
                        error: anyhow::anyhow!(
                            "could not parse the relay handshake reply before hello.challenge: {error}; reconnecting"
                        ),
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

/// Whether a missing or rejected credential stops the relay (exit 4), and a
/// refused relay protocol stops it (exit 5), rather than being retried
/// in-process (with the normal backoff, capped at 5 min).
/// It stops under the systemd unit (which does not restart on exit 4) and in
/// an interactive terminal (where a person sees the message). Elsewhere, such
/// as a macOS LaunchAgent (`KeepAlive` relaunches every exit) or a detached
/// daemon, exiting would only restart or lose the relay, so it keeps retrying
/// and picks up a new `wsmp login` by itself.
pub(super) fn stop_on_unusable_credential() -> bool {
    std::env::var_os(crate::host::service::STOP_ON_REJECTED_CREDENTIAL_ENV)
        .is_some_and(|value| value == "1")
        || person_watching()
}

/// Whether a person sees this relay's stderr: a terminal, and not a service.
fn person_watching() -> bool {
    use std::io::IsTerminal;
    !crate::host::service::running_as_service() && std::io::stderr().is_terminal()
}

/// Where an unrecoverable refusal may stop the relay instead of retrying it
/// slowly: `credential` (exit 4, see [`stop_on_unusable_credential`]) and
/// `protocol` (exit 5: a unit that does not restart on it, or a terminal).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct StopOn {
    credential: bool,
    protocol: bool,
}

impl StopOn {
    pub(super) fn here() -> Self {
        Self {
            credential: stop_on_unusable_credential(),
            protocol: std::env::var_os(crate::host::service::STOP_ON_PROTOCOL_MISMATCH_ENV)
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

/// The upgrade action in a relay protocol refusal. A plain or unreadable
/// 426 body leaves discovery to the caller.
fn refuses_relay_protocol(body: Option<&[u8]>) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_slice(body?).ok()?;
    let subprotocol = value
        .get("supportedSubprotocol")
        .and_then(serde_json::Value::as_str);
    let versions = value
        .get("supportedVersions")
        .and_then(serde_json::Value::as_array);
    if !matches!(
        value.get("code").and_then(serde_json::Value::as_str),
        Some("upgrade_cli" | "upgrade_server")
    ) && subprotocol.is_none()
        && versions.is_none()
    {
        return None;
    }
    let current = crate::wire::protocol::relay_protocol_major(RELAY_PROTOCOL_VERSION)?;
    let subprotocol_major = subprotocol
        .and_then(|token| token.strip_prefix("ws-model-proxy.relay.v"))
        .and_then(|major| major.parse::<u64>().ok());
    let version_majors: Vec<_> = versions
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter_map(crate::wire::protocol::relay_protocol_major)
        .collect();
    let server_is_older = subprotocol_major.map_or_else(
        || !version_majors.is_empty() && version_majors.iter().all(|major| *major < current),
        |major| major < current,
    );
    Some(relay_upgrade_action(server_is_older))
}

fn relay_upgrade_action(server_is_older: bool) -> &'static str {
    if server_is_older {
        "the server runs WS Model Proxy 0.4 or older; upgrade the server to 1.0 or later (or install the wsmp that server serves)"
    } else {
        "upgrade wsmp by re-running the server's install.sh (`curl -fsSL https://<your server>/install.sh | sh`), then restart wsmp"
    }
}

/// A discovery reply with the current protocol cannot explain a 426; keep the proxy hint.
fn discovered_protocol_action(version: &str) -> Option<&'static str> {
    let server = crate::wire::protocol::relay_protocol_major(version)?;
    let cli = crate::wire::protocol::relay_protocol_major(RELAY_PROTOCOL_VERSION)?;
    (version != RELAY_PROTOCOL_VERSION).then(|| relay_upgrade_action(server < cli))
}

/// The longest `Retry-After` the relay honours; a longer one waits this long.
const RELAY_RETRY_AFTER_MAX: Duration = Duration::from_secs(60 * 60);

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
#[cfg(test)]
fn relay_connect_error(error: tungstenite::Error, stop: StopOn) -> RelaySessionError {
    relay_connect_error_with_discovery(error, stop, || None)
}

pub(super) fn relay_connect_error_with_discovery(
    error: tungstenite::Error,
    stop: StopOn,
    discover: impl FnOnce() -> Option<String>,
) -> RelaySessionError {
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
        && let Some(action) = refuses_relay_protocol(response.body().as_deref())
            .or_else(|| discover().as_deref().and_then(discovered_protocol_action))
    {
        return protocol_mismatch(
            anyhow::Error::new(error).context(format!(
                "the server refused relay protocol {RELAY_PROTOCOL_VERSION} (HTTP 426); \
                 {action}"
            )),
            stop,
        );
    }
    if let tungstenite::Error::Http(response) = &error
        && response.status().is_redirection()
    {
        let location = response
            .headers()
            .get("Location")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("the server's canonical URL (Location missing or invalid)");
        let canonical = Url::parse(location).ok().map(|mut url| {
            // Login accepts HTTP origins, while a relay Location may use WS.
            let scheme = match url.scheme() {
                "ws" => Some("http"),
                "wss" => Some("https"),
                _ => None,
            };
            if let Some(scheme) = scheme {
                let _ = url.set_scheme(scheme);
            }
            url.to_string()
        });
        let canonical =
            crate::display_escape::escape_single_line(canonical.as_deref().unwrap_or(location));
        return RelaySessionError::Reconnectable {
            error: anyhow::anyhow!(
                "relay redirect refused (cross-host, changed port, TLS downgrade, invalid target, or more than {RELAY_MAX_REDIRECTS} redirects); configure the canonical server URL `{canonical}` with `wsmp login <url> --code <code>`"
            ),
        };
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

pub(super) fn websocket_url(server_url: &str) -> Result<Url> {
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

#[cfg(test)]
mod tests {
    use super::super::backoff::{RELAY_RECONNECT_MAX_DELAY, retry_floor};
    use super::super::wire::tests::sink_socket;
    use super::*;
    use crate::node::config::Config;
    use tungstenite::http::HeaderValue;

    #[test]
    fn relay_redirect_policy_allows_only_same_host_equivalent_ports_and_no_downgrade() {
        let allowed = [
            ("ws://example.invalid/a", "ws://example.invalid/b"),
            ("ws://example.invalid/a", "wss://example.invalid/b"),
            (
                "http://example.invalid:80/a",
                "https://example.invalid:443/b",
            ),
            ("wss://example.invalid:443/a", "https://example.invalid/b"),
            (
                "ws://example.invalid:8443/a",
                "wss://example.invalid:8443/b",
            ),
        ];
        for (from, to) in allowed {
            let from = Url::parse(from).expect("from");
            let to = Url::parse(to).expect("to");
            for followed in 0..3 {
                assert!(
                    relay_redirect_allowed(&from, &to, followed),
                    "{from} -> {to}"
                );
            }
            assert!(
                !relay_redirect_allowed(&from, &to, 3),
                "fourth redirect refused"
            );
        }
        for (from, to) in [
            ("ws://example.invalid", "ws://other.invalid"),
            ("wss://example.invalid", "ws://example.invalid"),
            ("https://example.invalid", "http://example.invalid"),
            ("ws://example.invalid:8080", "wss://example.invalid:8443"),
            ("ws://example.invalid", "wss://example.invalid:8443"),
            ("ws://example.invalid", "ftp://example.invalid"),
            ("ws://example.invalid", "ws://user@example.invalid"),
        ] {
            assert!(
                !relay_redirect_allowed(
                    &Url::parse(from).expect("from"),
                    &Url::parse(to).expect("to"),
                    0
                ),
                "{from} -> {to}"
            );
        }
    }

    #[test]
    fn connect_relay_times_out_a_silent_http_or_tls_peer() {
        for scheme in ["ws", "wss"] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            let request = format!(
                "{scheme}://{}/relay",
                listener.local_addr().expect("address")
            )
            .into_client_request()
            .expect("request");
            let (stop, stopped) = mpsc::channel();
            let server = thread::spawn(move || {
                let (_socket, _) = listener.accept().expect("accept");
                let _ = stopped.recv_timeout(Duration::from_secs(3));
            });
            let start = Instant::now();
            let error = connect_relay_with_deadline(request, Duration::from_millis(150))
                .expect_err("timeout");
            let elapsed = start.elapsed();
            let _ = stop.send(());
            server.join().expect("server");
            assert!(
                matches!(&error, tungstenite::Error::Io(io) if io.kind() == io::ErrorKind::TimedOut),
                "{scheme}: {error}"
            );
            assert!(elapsed < Duration::from_secs(1), "{scheme}: {elapsed:?}");
            assert!(matches!(
                relay_connect_error(
                    error,
                    StopOn {
                        credential: true,
                        protocol: true
                    }
                ),
                RelaySessionError::Reconnectable { .. }
            ));
        }
    }

    #[test]
    fn connect_relay_refuses_redirect_before_contacting_another_port() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let other = std::net::TcpListener::bind("127.0.0.1:0").expect("other bind");
        other.set_nonblocking(true).expect("nonblocking");
        let canonical = format!("ws://{}/relay", other.local_addr().expect("address"));
        let location = canonical.clone();
        let mut request = format!("ws://{}/relay", listener.local_addr().expect("address"))
            .into_client_request()
            .expect("request");
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_static("Bearer test-only-token"),
        );
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("timeout");
            let mut buf = [0; 4096];
            assert!(socket.read(&mut buf).expect("request") > 0);
            write!(
                socket,
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
            )
            .expect("redirect");
        });
        let error = connect_relay_with_deadline(request, Duration::from_secs(2))
            .expect_err("redirect refused");
        server.join().expect("server");
        assert!(matches!(other.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock));
        let RelaySessionError::Reconnectable { error } = relay_connect_error(
            error,
            StopOn {
                credential: true,
                protocol: true,
            },
        ) else {
            panic!("reconnectable");
        };
        assert!(
            error
                .to_string()
                .contains(&canonical.replacen("ws://", "http://", 1)),
            "{error}"
        );
        assert!(error.to_string().contains("wsmp login"));
    }

    #[test]
    fn connect_relay_follows_a_same_origin_relative_redirect() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let mut request = format!("ws://{}/old", listener.local_addr().expect("address"))
            .into_client_request()
            .expect("request");
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_static("Bearer test-only-token"),
        );
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("first");
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("timeout");
            let mut buf = [0; 4096];
            assert!(socket.read(&mut buf).expect("request") > 0);
            socket.write_all(b"HTTP/1.1 301 Moved Permanently\r\nLocation: /canonical\r\nContent-Length: 0\r\n\r\n").expect("redirect");
            drop(socket);
            let (mut socket, _) = listener.accept().expect("second");
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("timeout");
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).expect("request byte");
                request.push(byte[0]);
            }
            let text = String::from_utf8(request).expect("text");
            assert!(text.starts_with("GET /canonical "), "{text}");
            assert!(
                text.to_ascii_lowercase()
                    .contains("authorization: bearer test-only-token")
            );
            socket
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .expect("answer");
        });
        let error =
            connect_relay_with_deadline(request, Duration::from_secs(2)).expect_err("final 503");
        server.join().expect("server");
        assert!(
            matches!(error, tungstenite::Error::Http(response) if response.status().as_u16() == 503)
        );
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

    #[test]
    fn hello_challenge_transient_close_reconnects() {
        let mut socket = challenge_socket(Message::Close(None));
        assert!(matches!(
            wait_for_hello_challenge(&mut socket, StopOn::ALL),
            Err(RelaySessionError::Reconnectable { .. })
        ));
    }

    #[test]
    fn hello_challenge_keeps_internal_errors_and_unparsable_replies_retryable() {
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"protocol.error","failure":"protocol_error","message":"database unavailable","code":"internal","supportedVersions":["4.0"]}"#
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
            Err(RelaySessionError::Reconnectable { error }) => {
                let message = crate::exit::message_for(&error);
                assert!(message.contains("could not parse the relay handshake reply"));
                assert!(!message.contains("upgrade"));
                assert_eq!(retry_floor(&error), None);
            }
            _ => panic!("unparsable reply must reconnect"),
        }
    }

    #[test]
    fn hello_challenge_requires_origin_and_accepts_current_server() {
        let mut socket = challenge_socket(Message::Text(
            r#"{"type":"hello.challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAA"}"#.into(),
        ));
        assert!(matches!(
            wait_for_hello_challenge(&mut socket, StopOn::ALL),
            Err(RelaySessionError::Reconnectable { .. })
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

    #[test]
    fn websocket_url_uses_relay_path_and_scheme() {
        assert_eq!(
            websocket_url("https://example.test").expect("url").as_str(),
            "wss://example.test/api/cli/ws"
        );
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
    fn a_refused_relay_protocol_stops_with_its_own_exit_code() {
        let refusals = [
            hello_rejection(
                "This server requires relay protocol 4.0. Upgrade wsmp and restart it.",
                &ProtocolErrorCode::UpgradeCli,
                StopOn::ALL,
            ),
            hello_rejection("too new", &ProtocolErrorCode::UpgradeServer, StopOn::ALL),
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
        let cli = hello_rejection("Upgrade wsmp.", &ProtocolErrorCode::UpgradeCli, StopOn::ALL);
        let RelaySessionError::Fatal(error) = cli else {
            panic!("upgrade_cli must stop");
        };
        assert!(crate::exit::message_for(&error).contains("install.sh"));
    }

    #[test]
    fn a_refused_relay_protocol_retries_slowly_where_exiting_would_relaunch() {
        match hello_rejection(
            "Upgrade wsmp.",
            &ProtocolErrorCode::UpgradeCli,
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
            &ProtocolErrorCode::IdentityMismatch,
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
            &ProtocolErrorCode::AccessDenied,
            StopOn::ALL,
        ) {
            RelaySessionError::Reconnectable { error, .. } => {
                assert_eq!(retry_floor(&error), Some(RELAY_RECONNECT_MAX_DELAY));
                assert!(format!("{error:#}").contains("`wsmp login`"));
            }
            _ => panic!("access_denied must be retried slowly"),
        }
        let RelaySessionError::Fatal(error) =
            hello_rejection("bad", &ProtocolErrorCode::Malformed, StopOn::ALL)
        else {
            panic!("malformed must stay fatal");
        };
        assert_eq!(
            crate::exit::code_for(&error),
            crate::exit::ExitCode::Failure
        );
    }

    #[test]
    fn relay_426_names_the_side_that_must_upgrade() {
        for (subprotocol, versions, action) in [
            (
                Some("ws-model-proxy.relay.v3"),
                vec!["3.0"],
                "the server runs WS Model Proxy 0.4 or older; upgrade the server to 1.0 or later",
            ),
            (
                Some("ws-model-proxy.relay.v1"),
                vec!["1.0"],
                "upgrade the server",
            ),
            (Some("ws-model-proxy.relay.v5"), vec!["5.0"], "upgrade wsmp"),
            (None, vec!["3.0"], "upgrade the server"),
            (None, vec!["10.0"], "upgrade wsmp"),
        ] {
            for stop in [StopOn::ALL, StopOn::NONE] {
                let body = serde_json::json!({
                    "type": "protocol.error", "failure": "protocol_error", "code": "upgrade_cli",
                    "supportedSubprotocol": subprotocol, "supportedVersions": versions
                });
                let response = tungstenite::http::Response::builder()
                    .status(426)
                    .body(Some(serde_json::to_vec(&body).expect("json")))
                    .expect("response");
                match relay_connect_error(tungstenite::Error::Http(Box::new(response)), stop) {
                    RelaySessionError::Fatal(error) => {
                        assert!(stop.protocol);
                        assert_eq!(
                            crate::exit::code_for(&error),
                            crate::exit::ExitCode::RelayProtocolMismatch
                        );
                        assert!(format!("{error:#}").contains(action), "{error:#}");
                    }
                    RelaySessionError::Reconnectable { error } => {
                        assert!(!stop.protocol);
                        assert_eq!(retry_floor(&error), Some(RELAY_RECONNECT_MAX_DELAY));
                        assert!(format!("{error:#}").contains(action), "{error:#}");
                    }
                    _ => panic!("unexpected result"),
                }
            }
        }
    }

    #[test]
    fn discovered_protocol_names_the_side_that_must_upgrade() {
        for (version, expected) in [
            ("3.0", Some("upgrade the server")),
            ("1.0", Some("upgrade the server")),
            ("5.0", Some("upgrade wsmp")),
            ("10.0", Some("upgrade wsmp")),
            ("4.1", Some("upgrade wsmp")),
            (RELAY_PROTOCOL_VERSION, None),
            ("not a version", None),
        ] {
            let action = discovered_protocol_action(version);
            match expected {
                Some(expected) => assert!(action.expect("upgrade action").contains(expected)),
                None => assert_eq!(action, None),
            }
        }
    }

    #[test]
    fn relay_426_with_an_unreadable_body_uses_discovery() {
        for stop in [StopOn::ALL, StopOn::NONE] {
            for version in ["3.0", "5.0"] {
                for body in [None, Some(b"{".to_vec())] {
                    let response = tungstenite::http::Response::builder()
                        .status(426)
                        .body(body)
                        .expect("response");
                    let result = relay_connect_error_with_discovery(
                        tungstenite::Error::Http(Box::new(response)),
                        stop,
                        || Some(version.to_string()),
                    );
                    let error = match result {
                        RelaySessionError::Fatal(error) => {
                            assert!(stop.protocol);
                            assert_eq!(
                                crate::exit::code_for(&error),
                                crate::exit::ExitCode::RelayProtocolMismatch
                            );
                            error
                        }
                        RelaySessionError::Reconnectable { error } => {
                            assert!(!stop.protocol);
                            assert_eq!(retry_floor(&error), Some(RELAY_RECONNECT_MAX_DELAY));
                            error
                        }
                        _ => panic!("unexpected result"),
                    };
                    let expected = if version == "3.0" {
                        "upgrade the server"
                    } else {
                        "upgrade wsmp"
                    };
                    assert!(format!("{error:#}").contains(expected));
                }
            }
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
                r#"{"type":"protocol.error","code":"upgrade_cli","supportedSubprotocol":"ws-model-proxy.relay.v4"}"#,
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
}
