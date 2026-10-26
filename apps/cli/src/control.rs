//! Local, same-user control channel for a running relay daemon.
//!
//! Unix: a `0600` socket in the `0700` state dir, peers checked by
//! `SO_PEERCRED`/`LOCAL_PEERCRED`. Windows: a named pipe whose owner and only
//! ACE are the user's SID, remote clients rejected, peers checked by
//! impersonation (`wsmp_windows`); the client checks the pipe's owner too, so
//! another user cannot serve the name first. A pipe has no half-close, so on
//! Windows both the request and the answer end at a newline.

#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::path::PathBuf;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

#[cfg(unix)]
use nix::sys::socket::{getsockopt, sockopt};
#[cfg(unix)]
use nix::unistd::Uid;

#[cfg(unix)]
use anyhow::Context;
#[cfg(not(windows))]
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[cfg_attr(not(any(unix, windows)), allow(dead_code))]
const CONTROL_MAX_REQUEST_BYTES: usize = 4096;
/// Status gains runtime and instance rows (C2), so it keeps a materially
/// larger bound than the tiny command request. Keep this finite to prevent a
/// compromised local daemon from making the CLI allocate without limit.
#[cfg_attr(not(any(unix, windows)), allow(dead_code))]
const CONTROL_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
#[cfg_attr(not(any(unix, windows)), allow(dead_code))]
const CONTROL_READ_DEADLINE: Duration = Duration::from_secs(2);
#[cfg_attr(not(any(unix, windows)), allow(dead_code))]
const CONTROL_MAX_CLIENTS: usize = 32;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlCommand {
    Status,
    /// Re-read `config.json` and the node secrets now (lower-only for trust).
    Reload,
    /// `wsmp trust relay`: lower now (persisted, frozen, reported).
    TrustRelay,
    /// `wsmp trust full`: raise, after the peer check (never from the job tree).
    TrustFull,
    /// Whether the caller is a process wsmp started, by the relay's own check
    /// on its peer. Windows asks this where Unix reads `/proc` or `ps` itself
    /// (`trust::self_started_by_wsmp`); changes nothing.
    CheckCaller,
    /// Stop the relay as SIGTERM would (graceful, bounded). `wsmp service
    /// restart|uninstall` on Windows, where `schtasks /End` ends only the
    /// task's console host. Lowers nothing it could not already end.
    Stop,
}

/// How long a client waits for the relay's answer.
#[cfg_attr(not(any(unix, windows)), allow(dead_code))]
fn answer_timeout(command: &ControlCommand) -> Duration {
    match command {
        ControlCommand::Status
        | ControlCommand::Reload
        | ControlCommand::CheckCaller
        | ControlCommand::Stop => Duration::from_secs(5),
        // Lowering kills commands and writes files before it answers.
        ControlCommand::TrustRelay | ControlCommand::TrustFull => Duration::from_secs(30),
    }
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
    /// Live websocket state reported by the daemon, never inferred from a PID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<&'a str>,
    /// This node's slug.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<&'a str>,
    /// The node's effective trust (`full` or `relay`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust: Option<&'a str>,
}

#[cfg(unix)]
struct ControlClient {
    stream: UnixStream,
    peer_pid: Option<i32>,
    buffer: Vec<u8>,
    deadline: Instant,
}
#[cfg(unix)]
pub struct ControlServer {
    listener: UnixListener,
    path: PathBuf,
    clients: Vec<ControlClient>,
    /// Removes the socket file if a forced shutdown skips `Drop`.
    _exit_cleanup: crate::shutdown::ExitCleanup,
}

/// The daemon locks this process took (`ControlServer::bind_in`): never released before the
/// process exits, so no other daemon starts while anything of this one (a runtime step worker
/// above all, which may still launch) can still run.
#[cfg(unix)]
static DAEMON_LOCKS: std::sync::Mutex<Vec<nix::fcntl::Flock<fs::File>>> =
    std::sync::Mutex::new(Vec::new());
#[cfg(unix)]
pub struct PendingRequest {
    pub request: ControlRequest,
    /// The peer's process id where the platform reports it.
    pub peer_pid: Option<i32>,
    stream: UnixStream,
}

#[cfg(unix)]
impl ControlServer {
    pub fn bind() -> Result<Self> {
        Self::bind_in(&crate::paths::state_dir()?)
    }

    /// One daemon per state directory: its lock (`relay-daemon.lock`, an exclusive `flock`
    /// kept until the process exits, `DAEMON_LOCKS`) is taken before the control socket is
    /// looked at, so two starting daemons never both get past here (the socket check alone is
    /// not atomic: both could see a stale socket and each bind its own), and a new one starts
    /// only once every thread of the old one ended, and once every runtime command the old one
    /// started ended too (`launch_guard::settle`). Everything the daemon owns (its runtime step
    /// runner above all, whose idle answers prove stops) has one owner per node.
    fn bind_in(state_dir: &std::path::Path) -> Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let path = state_dir.join("relay-control.sock");
        fs::create_dir_all(state_dir)?;
        fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700))?;
        let lock_path = state_dir.join("relay-daemon.lock");
        let lock_file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&lock_path)
            .with_context(|| format!("opening daemon lock `{}`", lock_path.display()))?;
        let daemon_lock =
            match nix::fcntl::Flock::lock(lock_file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
                Ok(lock) => lock,
                Err((_, nix::errno::Errno::EWOULDBLOCK)) => anyhow::bail!(
                    "a relay daemon already runs (it holds `{}`)",
                    lock_path.display()
                ),
                Err((_, error)) => {
                    return Err(error)
                        .with_context(|| format!("locking daemon lock `{}`", lock_path.display()));
                }
            };
        DAEMON_LOCKS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(daemon_lock);
        // An earlier daemon ended by SIGKILL can leave a runtime command its guard is still
        // ending; nothing here answers (an idle rank above all) until it has.
        crate::launch_guard::settle(state_dir, crate::launch_guard::SETTLE_WAIT)?;
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
        let socket_path = path.clone();
        let exit_cleanup = crate::shutdown::register_exit_cleanup(move || {
            let _ = fs::remove_file(&socket_path);
        });
        Ok(Self {
            listener,
            path,
            clients: Vec::new(),
            _exit_cleanup: exit_cleanup,
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
                        let peer_pid = peer_pid(&stream);
                        self.clients.push(ControlClient {
                            stream,
                            peer_pid,
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
            requests.push(PendingRequest {
                request,
                peer_pid: client.peer_pid,
                stream,
            });
            false
        });
        Ok(requests)
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_pid(stream: &UnixStream) -> Option<i32> {
    getsockopt(stream, sockopt::PeerCredentials)
        .ok()
        .map(|peer| peer.pid())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn peer_pid(stream: &UnixStream) -> Option<i32> {
    getsockopt(stream, sockopt::LocalPeerPid).ok()
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
fn peer_pid(_stream: &UnixStream) -> Option<i32> {
    None
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
            connection: None,
            node: None,
            trust: None,
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
/// Send `command` to the running relay; `None` when no relay runs here.
#[cfg(unix)]
pub fn request_if_running(command: ControlCommand) -> Result<Option<serde_json::Value>> {
    let path = crate::paths::state_dir()?.join("relay-control.sock");
    match UnixStream::connect(&path) {
        Ok(stream) => exchange(stream, command).map(Some),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error)
            .with_context(|| format!("connecting to relay control socket `{}`", path.display())),
    }
}

#[cfg(unix)]
pub fn request(command: ControlCommand) -> Result<serde_json::Value> {
    let path = crate::paths::state_dir()?.join("relay-control.sock");
    let stream = UnixStream::connect(&path)
        .with_context(|| format!("connecting to relay control socket `{}`", path.display()))?;
    exchange(stream, command)
}

#[cfg(unix)]
fn exchange(mut stream: UnixStream, command: ControlCommand) -> Result<serde_json::Value> {
    stream.set_read_timeout(Some(answer_timeout(&command)))?;
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
#[cfg(windows)]
pub use windows::{ControlServer, PendingRequest, request, request_if_running, respond};

#[cfg(windows)]
mod windows {
    use std::ffi::OsString;
    use std::io::{self, BufRead, BufReader, Read, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsHandle;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use anyhow::{Context, Result};
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::NamedPipeServer;

    use super::{
        CONTROL_MAX_CLIENTS, CONTROL_MAX_REQUEST_BYTES, CONTROL_MAX_RESPONSE_BYTES,
        CONTROL_READ_DEADLINE, ControlCommand, ControlRequest, ControlResponse, answer_timeout,
    };

    /// `SECURITY_SQOS_PRESENT` is implied by `security_qos_flags`; this is
    /// `SecurityIdentification << 16`: the relay may read who the client is,
    /// but a process squatting on the name cannot act as it.
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_PIPE_BUSY: i32 = 231;
    /// How long the daemon may take to pick a request up and answer it: the
    /// trust commands' 30 s plus the daemon loop's own turn.
    const ANSWER_DEADLINE: Duration = Duration::from_secs(45);

    /// One pipe per state dir, so two state dirs (`WSMP_STATE_DIR`) never share
    /// a relay. The name is a digest; the path itself stays private.
    fn pipe_name() -> Result<OsString> {
        let state_dir = crate::paths::state_dir()?;
        let key = state_dir.to_string_lossy().to_lowercase();
        let digest = Sha256::digest(key.as_bytes());
        let hex: String = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(OsString::from(format!(
            r"\\.\pipe\wsmp-relay-control-{hex}"
        )))
    }

    pub struct PendingRequest {
        pub request: ControlRequest,
        /// The peer's process id, as the kernel recorded it.
        pub peer_pid: Option<i32>,
        reply: tokio::sync::oneshot::Sender<Vec<u8>>,
    }

    /// The pipe server runs on its own thread (a current-thread tokio
    /// runtime) and hands verified requests to the daemon loop, which
    /// [`ControlServer::drain`]s them without blocking.
    pub struct ControlServer {
        requests: mpsc::Receiver<PendingRequest>,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
    }

    impl ControlServer {
        pub fn bind() -> Result<Self> {
            Self::bind_at(pipe_name()?)
        }

        fn bind_at(name: OsString) -> Result<Self> {
            let (ready_tx, ready_rx) = mpsc::sync_channel::<io::Result<()>>(1);
            let (request_tx, requests) = mpsc::channel();
            let (stop, stop_rx) = tokio::sync::oneshot::channel();
            let thread_name = name.clone();
            std::thread::Builder::new()
                .name("wsmp-control".into())
                .spawn(move || serve(thread_name, ready_tx, request_tx, stop_rx))
                .context("starting the relay control thread")?;
            match ready_rx.recv() {
                Ok(Ok(())) => Ok(Self {
                    requests,
                    stop: Some(stop),
                }),
                Ok(Err(error)) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
                    anyhow::bail!(
                        "a relay daemon already owns control pipe `{}`",
                        name.to_string_lossy()
                    )
                }
                Ok(Err(error)) => Err(error).with_context(|| {
                    format!("creating relay control pipe `{}`", name.to_string_lossy())
                }),
                Err(_) => anyhow::bail!("the relay control thread stopped while starting"),
            }
        }

        pub fn drain(&mut self) -> Result<Vec<PendingRequest>> {
            Ok(self.requests.try_iter().collect())
        }
    }

    impl Drop for ControlServer {
        fn drop(&mut self) {
            // The thread closes every instance, so the name goes away.
            if let Some(stop) = self.stop.take() {
                let _ = stop.send(());
            }
        }
    }

    fn serve(
        name: OsString,
        ready: mpsc::SyncSender<io::Result<()>>,
        requests: mpsc::Sender<PendingRequest>,
        mut stop: tokio::sync::oneshot::Receiver<()>,
    ) {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
        runtime.block_on(async move {
            let mut listening = match wsmp_windows::create_control_pipe(&name, true) {
                Ok(server) => server,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            let _ = ready.send(Ok(()));
            let active = Arc::new(AtomicUsize::new(0));
            loop {
                tokio::select! {
                    _ = &mut stop => {
                        // Dropping cancels the pending connect, but mio closes
                        // the handle only once the runtime takes the cancelled
                        // completion: let it turn before the runtime goes,
                        // or the name stays served until the process exits.
                        drop(listening);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        return;
                    }
                    connected = listening.connect() => {
                        // A fresh instance first, so the name is never unserved
                        // while this client is handled.
                        let next = match wsmp_windows::create_control_pipe(&name, false) {
                            Ok(next) => next,
                            Err(error) => {
                                tracing::warn!(error = %error, "creating a relay control pipe instance failed");
                                tokio::time::sleep(Duration::from_millis(200)).await;
                                continue;
                            }
                        };
                        let client = std::mem::replace(&mut listening, next);
                        if connected.is_err() {
                            continue;
                        }
                        if active.load(Ordering::SeqCst) >= CONTROL_MAX_CLIENTS {
                            tokio::spawn(answer_busy(client));
                            continue;
                        }
                        active.fetch_add(1, Ordering::SeqCst);
                        let active = Arc::clone(&active);
                        let requests = requests.clone();
                        tokio::spawn(async move {
                            handle(client, requests).await;
                            active.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                }
            }
        });
    }

    /// Reads one newline-ended request within the deadline, bounded.
    async fn read_request(client: &mut NamedPipeServer) -> Option<Vec<u8>> {
        let read = async {
            let mut body = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let count = client.read(&mut chunk).await.ok()?;
                if count == 0 {
                    return None;
                }
                body.extend_from_slice(&chunk[..count]);
                if let Some(end) = body.iter().position(|byte| *byte == b'\n') {
                    body.truncate(end);
                    return Some(body);
                }
                if body.len() > CONTROL_MAX_REQUEST_BYTES {
                    return None;
                }
            }
        };
        tokio::time::timeout(CONTROL_READ_DEADLINE, read)
            .await
            .ok()
            .flatten()
    }

    async fn handle(mut client: NamedPipeServer, requests: mpsc::Sender<PendingRequest>) {
        let Some(body) = read_request(&mut client).await else {
            return;
        };
        // After a read, as impersonation requires. The DACL already keeps
        // other users out; as on Unix, a peer that fails the check gets no
        // answer and its request is never parsed.
        match wsmp_windows::pipe_client_is_current_user(client.as_handle()) {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!("rejecting a relay control peer of another user");
                return;
            }
            Err(error) => {
                tracing::warn!(error = %error, "rejecting unauthenticated relay control peer");
                return;
            }
        }
        let peer_pid = wsmp_windows::pipe_client_pid(client.as_handle())
            .ok()
            .and_then(|pid| i32::try_from(pid).ok());
        let Ok(request) = serde_json::from_slice::<ControlRequest>(&body) else {
            return;
        };
        let (reply, answer) = tokio::sync::oneshot::channel();
        if requests
            .send(PendingRequest {
                request,
                peer_pid,
                reply,
            })
            .is_err()
        {
            return;
        }
        let Ok(Ok(bytes)) = tokio::time::timeout(ANSWER_DEADLINE, answer).await else {
            return;
        };
        finish(client, &bytes).await;
    }

    /// Writes the answer, then waits (bounded) for the client to hang up:
    /// closing first, or `DisconnectNamedPipe`, could drop an unread answer.
    async fn finish(mut client: NamedPipeServer, bytes: &[u8]) {
        let wrote = tokio::time::timeout(CONTROL_READ_DEADLINE, client.write_all(bytes)).await;
        if matches!(wrote, Ok(Ok(()))) {
            let mut rest = [0_u8; 1];
            let _ = tokio::time::timeout(CONTROL_READ_DEADLINE, client.read(&mut rest)).await;
        }
    }

    async fn answer_busy(mut client: NamedPipeServer) {
        // Read the request first (or give up), so the client is not cut off
        // mid-write and sees the answer.
        if read_request(&mut client).await.is_none() {
            return;
        }
        let response = ControlResponse {
            ok: false,
            state: "busy",
            message: Some("relay control plane is busy; retry shortly"),
            connection: None,
            node: None,
            trust: None,
        };
        if let Ok(bytes) = encode(&response) {
            finish(client, &bytes).await;
        }
    }

    fn encode(response: &ControlResponse<'_>) -> Result<Vec<u8>> {
        let mut bytes = serde_json::to_vec(response).context("serializing control response")?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    pub fn respond(pending: PendingRequest, response: &ControlResponse<'_>) -> Result<()> {
        let bytes = encode(response)?;
        pending
            .reply
            .send(bytes)
            .map_err(|_| anyhow::anyhow!("the control client went away"))
    }

    /// Opens the relay's pipe, waiting out a moment when every instance is
    /// busy. `NotFound` means no relay serves it.
    fn open(name: &OsString) -> Result<Option<std::fs::File>> {
        let deadline = Instant::now() + CONTROL_READ_DEADLINE;
        loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .security_qos_flags(SECURITY_IDENTIFICATION)
                .open(name)
            {
                Ok(file) => return Ok(Some(file)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error)
                    if error.raw_os_error() == Some(ERROR_PIPE_BUSY)
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "connecting to relay control pipe `{}`",
                            name.to_string_lossy()
                        )
                    });
                }
            }
        }
    }

    /// Send `command` to the running relay; `None` when no relay runs here.
    pub fn request_if_running(command: ControlCommand) -> Result<Option<serde_json::Value>> {
        request_at(&pipe_name()?, command)
    }

    fn request_at(name: &OsString, command: ControlCommand) -> Result<Option<serde_json::Value>> {
        match open(name)? {
            Some(file) => exchange(file, command).map(Some),
            None => Ok(None),
        }
    }

    pub fn request(command: ControlCommand) -> Result<serde_json::Value> {
        let name = pipe_name()?;
        request_at(&name, command)?.ok_or_else(|| {
            anyhow::anyhow!(
                "connecting to relay control pipe `{}`: no relay is running",
                name.to_string_lossy()
            )
        })
    }

    fn exchange(file: std::fs::File, command: ControlCommand) -> Result<serde_json::Value> {
        anyhow::ensure!(
            wsmp_windows::pipe_owner_is_current_user(file.as_handle())
                .context("checking the relay control pipe's owner")?,
            "the relay control pipe belongs to another user"
        );
        let timeout = answer_timeout(&command);
        // A blocking pipe read has no timeout of its own; the answer is
        // awaited here and a stuck read is left to end with the process.
        let (done, answer) = mpsc::channel();
        std::thread::Builder::new()
            .name("wsmp-control-client".into())
            .spawn(move || {
                let _ = done.send(exchange_blocking(file, command));
            })
            .context("starting the control request")?;
        match answer.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => anyhow::bail!("the relay did not answer within {} s", timeout.as_secs()),
        }
    }

    fn exchange_blocking(
        mut file: std::fs::File,
        command: ControlCommand,
    ) -> Result<serde_json::Value> {
        let mut request = serde_json::to_vec(&ControlRequest { command })?;
        request.push(b'\n');
        file.write_all(&request)?;
        let mut body = Vec::new();
        BufReader::new(&mut file)
            .take(CONTROL_MAX_RESPONSE_BYTES as u64 + 1)
            .read_until(b'\n', &mut body)?;
        if body.len() > CONTROL_MAX_RESPONSE_BYTES {
            anyhow::bail!("control response exceeded maximum size");
        }
        serde_json::from_slice(&body).context("parsing control response")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn test_pipe(tag: &str) -> OsString {
            OsString::from(format!(
                r"\\.\pipe\wsmp-control-test-{tag}-{}",
                std::process::id()
            ))
        }

        /// The daemon loop's part: drain, answer each request.
        fn answer_until(server: &mut ControlServer, count: usize) -> Vec<Option<i32>> {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut peers = Vec::new();
            while peers.len() < count {
                assert!(Instant::now() < deadline, "no request arrived");
                for pending in server.drain().expect("drain") {
                    peers.push(pending.peer_pid);
                    let response = ControlResponse {
                        ok: true,
                        state: "running",
                        message: None,
                        connection: Some("connected"),
                        node: Some("node-1"),
                        trust: Some("relay"),
                    };
                    respond(pending, &response).expect("respond");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            peers
        }

        #[test]
        fn a_request_reaches_the_relay_and_its_answer_comes_back() {
            let name = test_pipe("roundtrip");
            let mut server = ControlServer::bind_at(name.clone()).expect("bind");
            // A second relay on the same name is refused.
            let second = ControlServer::bind_at(name.clone())
                .err()
                .expect("second bind");
            assert!(format!("{second:#}").contains("already owns"), "{second:#}");

            let client_name = name.clone();
            let client = std::thread::spawn(move || {
                (0..3)
                    .map(|_| request_at(&client_name, ControlCommand::Status))
                    .collect::<Vec<_>>()
            });
            let peers = answer_until(&mut server, 3);
            for answer in client.join().expect("client") {
                let answer = answer.expect("request").expect("a relay answered");
                assert_eq!(answer["state"], "running");
                assert_eq!(answer["node"], "node-1");
            }
            let me = i32::try_from(std::process::id()).expect("pid");
            assert_eq!(peers, vec![Some(me); 3]);

            // Stopped: the name is gone, and a client finds no relay.
            drop(server);
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match request_at(&name, ControlCommand::Status) {
                    Ok(None) => break,
                    _ if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    other => panic!("pipe still served: {other:?}"),
                }
            }
        }

        #[test]
        fn a_request_that_never_ends_gets_no_answer_and_frees_its_slot() {
            let name = test_pipe("stall");
            let mut server = ControlServer::bind_at(name.clone()).expect("bind");
            // Opens and sends half a request, without a newline.
            let mut stalled = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&name)
                .expect("open");
            stalled.write_all(br#"{"command":"#).expect("write");
            let started = Instant::now();
            let mut rest = Vec::new();
            // The relay gives up at its read deadline and hangs up.
            let _ = stalled.read_to_end(&mut rest);
            assert!(rest.is_empty());
            assert!(started.elapsed() < CONTROL_READ_DEADLINE + Duration::from_secs(3));
            assert!(server.drain().expect("drain").is_empty());
            // And still answers the next client.
            let client_name = name.clone();
            let client =
                std::thread::spawn(move || request_at(&client_name, ControlCommand::Status));
            answer_until(&mut server, 1);
            assert!(client.join().expect("client").expect("request").is_some());
        }

        #[test]
        fn pipe_names_follow_the_state_dir() {
            let name = pipe_name().expect("pipe name");
            let name = name.to_string_lossy();
            assert!(name.starts_with(r"\\.\pipe\wsmp-relay-control-"), "{name}");
            assert_eq!(name.len(), r"\\.\pipe\wsmp-relay-control-".len() + 16);
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub fn request_if_running(_command: ControlCommand) -> Result<Option<serde_json::Value>> {
    Ok(None)
}
#[cfg(not(any(unix, windows)))]
pub fn request(_command: ControlCommand) -> Result<serde_json::Value> {
    anyhow::bail!("relay control is unsupported on this platform")
}
#[cfg(not(any(unix, windows)))]
pub struct ControlServer;
#[cfg(not(any(unix, windows)))]
impl ControlServer {
    pub fn bind() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(all(test, unix))]
mod tests {
    #[cfg(unix)]
    #[test]
    fn a_second_daemon_never_binds_while_one_runs() {
        let dir = tempfile::tempdir().expect("state dir");
        let first = super::ControlServer::bind_in(dir.path()).expect("the first daemon binds");
        let refused = super::ControlServer::bind_in(dir.path())
            .err()
            .expect("a second daemon is refused");
        assert!(
            format!("{refused:#}").contains("already runs"),
            "{refused:#}"
        );
        // Even with the first one's socket gone (what a racing start would unlink): refused.
        std::fs::remove_file(dir.path().join("relay-control.sock")).expect("socket");
        assert!(super::ControlServer::bind_in(dir.path()).is_err());
        // Its control server gone (a fatal return), its process (and any step worker it may
        // still run) is not: still refused until the process exits.
        drop(first);
        assert!(super::ControlServer::bind_in(dir.path()).is_err());
    }

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
    fn status_response_uses_camel_case_and_skips_absent_fields() {
        let response = ControlResponse {
            ok: true,
            state: "running",
            message: None,
            connection: Some("connected"),
            node: Some("spark-1"),
            trust: Some("full"),
        };
        let serialized = serde_json::to_string(&response).expect("serialize status response");
        assert_eq!(
            serialized,
            r#"{"ok":true,"state":"running","connection":"connected","node":"spark-1","trust":"full"}"#
        );
        assert!(serialized.len() <= CONTROL_MAX_RESPONSE_BYTES);
    }
}
