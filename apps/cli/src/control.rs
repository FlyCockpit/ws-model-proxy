//! Local, same-user control channel for a running relay daemon.

#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
use nix::sys::socket::{getsockopt, sockopt};
#[cfg(unix)]
use nix::unistd::Uid;

#[cfg(unix)]
use anyhow::Context;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[cfg(unix)]
const CONTROL_MAX_REQUEST_BYTES: usize = 4096;
/// Status includes one row per locally configured endpoint, so it needs a
/// materially larger bound than the tiny command request. Keep this finite to
/// prevent a compromised local daemon from making the CLI allocate without
/// limit.
#[cfg(unix)]
const CONTROL_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
#[cfg(unix)]
const CONTROL_READ_DEADLINE: Duration = Duration::from_secs(2);
#[cfg(unix)]
const CONTROL_MAX_CLIENTS: usize = 32;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlCommand {
    Reload,
    Status,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ControlRequest {
    pub command: ControlCommand,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse<'a> {
    pub ok: bool,
    pub state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_seq: Option<u64>,
    /// Live websocket state reported by the daemon, never inferred from a PID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<&'a str>,
    /// Digest of the daemon's desired local inventory snapshot. This is
    /// intentionally separate from the server acknowledgement below.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_inventory_digest: Option<String>,
    /// Last modification timestamp of the desired config file, as Unix epoch
    /// milliseconds so the JSON schema is stable without locale formatting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_modified_at_ms: Option<u64>,
    /// Desired local endpoint/probe state from the daemon's active config.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_endpoints: Option<Vec<ControlEndpointStatus<'a>>>,
    /// Server-authoritative acknowledgement fields. They are absent until hello
    /// or an inventory update has been durably accepted by the server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_digest: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_acknowledged_at: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEndpointStatus<'a> {
    pub slug: &'a str,
    pub enabled: bool,
    pub local_probe: &'a str,
    pub model_count: usize,
    pub published: &'a str,
}

#[cfg(unix)]
struct ControlClient {
    stream: UnixStream,
    buffer: Vec<u8>,
    deadline: Instant,
}
#[cfg(unix)]
pub struct ControlServer {
    listener: UnixListener,
    path: PathBuf,
    clients: Vec<ControlClient>,
}
#[cfg(unix)]
pub struct PendingRequest {
    pub request: ControlRequest,
    stream: UnixStream,
}

#[cfg(unix)]
impl ControlServer {
    pub fn bind() -> Result<Self> {
        let path = crate::paths::state_dir()?.join("relay-control.sock");
        let state_dir = crate::paths::state_dir()?;
        fs::create_dir_all(&state_dir)?;
        fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700))?;
        if path.exists() {
            match UnixStream::connect(&path) {
                Ok(_) => anyhow::bail!(
                    "a relay daemon already owns control socket `{}`",
                    path.display()
                ),
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                    fs::remove_file(&path).with_context(|| {
                        format!("removing stale control socket `{}`", path.display())
                    })?
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("checking control socket `{}`", path.display()));
                }
            }
        }
        let listener = UnixListener::bind(&path)
            .with_context(|| format!("binding relay control socket `{}`", path.display()))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            path,
            clients: Vec::new(),
        })
    }

    pub fn drain(&mut self) -> Result<Vec<PendingRequest>> {
        for _ in 0..8 {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if self.clients.len() >= CONTROL_MAX_CLIENTS {
                        let _ = respond_busy(stream);
                    } else if let Err(error) = verify_same_user(&stream) {
                        // Filesystem mode is only defense in depth. Do not parse
                        // a request or reveal daemon state to an unauthenticated
                        // local peer.
                        tracing::warn!(error = %error, "rejecting unauthenticated relay control peer");
                    } else {
                        stream.set_nonblocking(true)?;
                        self.clients.push(ControlClient {
                            stream,
                            buffer: Vec::new(),
                            deadline: Instant::now() + CONTROL_READ_DEADLINE,
                        });
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error).context("accepting control request"),
            }
        }

        let mut requests = Vec::new();
        let now = Instant::now();
        self.clients.retain_mut(|client| {
            let mut chunk = [0_u8; 1024];
            let mut eof = false;
            loop {
                match client.stream.read(&mut chunk) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(count) => {
                        if client.buffer.len().saturating_add(count) > CONTROL_MAX_REQUEST_BYTES {
                            return false;
                        }
                        client.buffer.extend_from_slice(&chunk[..count]);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => return false,
                }
            }
            if now >= client.deadline {
                return false;
            }
            if !eof {
                return true;
            }
            let Ok(body) = std::str::from_utf8(&client.buffer) else {
                return false;
            };
            let Ok(request) = serde_json::from_str(body) else {
                return false;
            };
            let stream = match client.stream.try_clone() {
                Ok(stream) => stream,
                Err(_) => return false,
            };
            requests.push(PendingRequest { request, stream });
            false
        });
        Ok(requests)
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn verify_same_user(stream: &UnixStream) -> Result<()> {
    let peer = getsockopt(stream, sockopt::PeerCredentials)
        .context("reading Unix control peer credentials")?;
    require_same_uid(peer.uid())
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "dragonfly"
))]
fn verify_same_user(stream: &UnixStream) -> Result<()> {
    let peer = getsockopt(stream, sockopt::LocalPeerCred)
        .context("reading Unix control peer credentials")?;
    require_same_uid(peer.uid())
}

#[cfg(unix)]
fn require_same_uid(peer_uid: u32) -> Result<()> {
    let current = Uid::current().as_raw();
    if peer_uid != current {
        anyhow::bail!("control peer UID {peer_uid} does not match daemon UID {current}");
    }
    Ok(())
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly"
    ))
))]
fn verify_same_user(_stream: &UnixStream) -> Result<()> {
    anyhow::bail!(
        "relay control sockets require an authenticated peer-credential implementation on this Unix platform"
    )
}
#[cfg(unix)]
fn respond_busy(mut stream: UnixStream) -> Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    serde_json::to_writer(
        &mut stream,
        &ControlResponse {
            ok: false,
            state: "busy",
            message: Some("relay control plane is busy; retry shortly"),
            endpoints: None,
            inventory_seq: None,
            connection: None,
            desired_inventory_digest: None,
            config_modified_at_ms: None,
            desired_endpoints: None,
            inventory_digest: None,
            inventory_acknowledged_at: None,
        },
    )?;
    stream.write_all(b"\n")?;
    stream.shutdown(Shutdown::Both)?;
    Ok(())
}

#[cfg(unix)]
impl Drop for ControlServer {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
#[cfg(unix)]
pub fn respond(mut pending: PendingRequest, response: &ControlResponse<'_>) -> Result<()> {
    pending.stream.set_nonblocking(false)?;
    pending
        .stream
        .set_write_timeout(Some(Duration::from_secs(2)))?;
    serde_json::to_writer(&mut pending.stream, response).context("serializing control response")?;
    pending.stream.write_all(
        b"
",
    )?;
    pending.stream.shutdown(Shutdown::Both)?;
    Ok(())
}
#[cfg(unix)]
pub fn request(command: ControlCommand) -> Result<serde_json::Value> {
    let path = crate::paths::state_dir()?.join("relay-control.sock");
    let mut stream = UnixStream::connect(&path)
        .with_context(|| format!("connecting to relay control socket `{}`", path.display()))?;
    let read_timeout = match command {
        ControlCommand::Reload => Duration::from_secs(5 * 60),
        ControlCommand::Status => Duration::from_secs(5),
    };
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    serde_json::to_writer(&mut stream, &ControlRequest { command })?;
    stream.shutdown(Shutdown::Write)?;
    let mut body = String::new();
    (&mut stream)
        .take(CONTROL_MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_string(&mut body)?;
    if body.len() > CONTROL_MAX_RESPONSE_BYTES {
        anyhow::bail!("control response exceeded maximum size");
    }
    serde_json::from_str(&body).context("parsing control response")
}
#[cfg(not(unix))]
pub fn request(_command: ControlCommand) -> Result<serde_json::Value> {
    anyhow::bail!(
        "relay control sockets are unsupported on Windows pending authenticated named-pipe peer verification"
    )
}
#[cfg(not(unix))]
pub struct ControlServer;
#[cfg(not(unix))]
impl ControlServer {
    pub fn bind() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_same_user_control_peer() {
        let (server, _client) = UnixStream::pair().expect("create Unix socket pair");
        // Some sandboxed CI runtimes deny `getsockopt(SO_PEERCRED)` even for
        // the calling process. Production treats that denial as an
        // authentication failure; the portable UID comparison is covered below.
        if let Err(error) = verify_same_user(&server) {
            assert!(
                format!("{error:#}").contains("Operation not permitted"),
                "the test process owns both socket ends: {error}"
            );
        }
    }

    #[test]
    fn rejects_a_mismatched_control_peer_uid() {
        let current = Uid::current().as_raw();
        let mismatched = if current == 0 { 1 } else { 0 };
        assert!(require_same_uid(mismatched).is_err());
    }

    #[test]
    fn response_limit_allows_a_multi_endpoint_status_payload() {
        let endpoints = (0..128)
            .map(|index| ControlEndpointStatus {
                slug: "endpoint-with-a-deliberately-long-name",
                enabled: true,
                local_probe: "online",
                model_count: index,
                published: "current",
            })
            .collect();
        let digest = "b".repeat(64);
        let response = ControlResponse {
            ok: true,
            state: "connected",
            message: None,
            endpoints: Some(128),
            inventory_seq: Some(42),
            connection: Some("connected"),
            desired_inventory_digest: Some("a".repeat(64)),
            config_modified_at_ms: Some(1),
            desired_endpoints: Some(endpoints),
            inventory_digest: Some(&digest),
            inventory_acknowledged_at: Some("2026-08-05T00:00:00Z"),
        };
        let serialized = serde_json::to_vec(&response).expect("serialize status response");
        assert!(serialized.len() > CONTROL_MAX_REQUEST_BYTES);
        assert!(serialized.len() <= CONTROL_MAX_RESPONSE_BYTES);
    }
}
