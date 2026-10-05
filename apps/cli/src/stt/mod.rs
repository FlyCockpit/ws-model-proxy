//! Live speech-to-text sessions (relay 2.11 `stt.*`), the CLI side.
//!
//! The relay loop owns a [`SttRegistry`]. It validates every `stt.open`
//! against the node's recipe-managed endpoints, enforces the caps, keeps the
//! audio credit window and sequence per session, and hands audio and commands
//! to one thread per session. Session threads answer through the shared
//! worker channel ([`FromWorker::Stt`]); the loop sends those frames with a
//! non-fatal encoder path, so a frame outside the wire contract ends only its
//! own session, never the relay.
//!
//! Only endpoints a recipe deployment manages take sessions: a hand-written
//! `realtime` capability in the local config is not trusted (see the chunk 1
//! notes in the design). Logs carry session ids, sizes and codes only, never
//! audio or transcript text.

pub mod resample;
pub mod segmented;
pub mod vllm;

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use anyhow::{Context, Result};

use crate::config::{
    AudioOperationCapabilities, EndpointAuthMode, EndpointConfig, RealtimeAdapter,
};
use crate::protocol::{ClientControlMessage, RelayFailure};
use crate::relay_bus::FromWorker;
use crate::stt_wire::{SttConfig, SttEvent, SttServerMessage, is_session_id};

/// Live sessions one CLI process serves at once, over all endpoints.
pub const STT_SESSIONS_MAX: usize = 8;
/// Commit, clear and update frames queued for one session thread. Audio is
/// bounded in bytes by the credit window instead, so a burst of small
/// frames within credit is paced, never refused.
const CONTROL_QUEUE_MAX: usize = 64;
/// Audio frames queued for one session thread. The credit window bounds the
/// bytes; this bounds the count too (a hostile server sending 2-byte frames
/// within credit), far above what the coalescing server sends.
const AUDIO_FRAMES_QUEUED_MAX: usize = 4_096;
/// Session threads alive at once, including those still connecting to an
/// engine after their session ended (an engine connect cannot be cut off).
const STT_THREADS_MAX: usize = 2 * STT_SESSIONS_MAX;
/// How often the relay loop compares live sessions with the managed
/// endpoint snapshot (deadlines are checked on every pass).
const ENDPOINT_CHECK_INTERVAL: Duration = Duration::from_secs(1);
/// Past `maxSessionMs` the server should have closed the session; the CLI
/// ends it itself after this grace.
const SESSION_GRACE: Duration = Duration::from_secs(5);
/// Recently ended session ids whose late frames are dropped silently.
const RECENT_CAPACITY: usize = 256;
/// How often a session thread checks for cancellation while idle.
const IDLE_POLL: Duration = Duration::from_millis(100);
/// Turns waiting for the engine behind the one in flight. A full queue
/// stops the session thread taking audio, so credit stops flowing back.
const PENDING_TURNS: usize = 1;

/// The engine connection of a `vllm` session, shut down by the relay loop
/// when the session ends so a thread blocked on the engine wakes at once.
pub(crate) type EngineSocket = Arc<Mutex<Option<TcpStream>>>;

/// Where a session's engine lives and how to authenticate to it.
#[derive(Debug, Clone)]
pub struct EngineEndpoint {
    pub base_url: String,
    /// `(header name, environment variable)` pairs, as configured.
    pub headers: Vec<(String, String)>,
    pub auth: Option<(EndpointAuthMode, String)>,
    pub model: String,
}

impl EngineEndpoint {
    /// The configured headers and typed credential, read from the
    /// environment now. Errors never carry the values.
    pub fn credential_headers(&self) -> Result<Vec<(String, String)>> {
        let mut headers = Vec::with_capacity(self.headers.len() + 1);
        for (name, env) in &self.headers {
            let value =
                std::env::var(env).with_context(|| format!("reading endpoint header `{name}`"))?;
            headers.push((name.clone(), value));
        }
        if let Some((mode, env)) = &self.auth {
            let value = std::env::var(env).context("reading typed endpoint credential")?;
            headers.push(match mode {
                EndpointAuthMode::ApiKey => ("x-api-key".into(), value),
                EndpointAuthMode::Bearer => ("authorization".into(), format!("Bearer {value}")),
            });
        }
        Ok(headers)
    }
}

/// Input for a session thread, in arrival order.
enum Input {
    Audio(Vec<u8>),
    Commit(u32),
    Clear(u32),
    Update(SttConfig),
}

/// One session as the relay loop sees it.
struct Session {
    endpoint_slug: String,
    input: Sender<Input>,
    /// Control inputs queued and not yet taken by the thread.
    controls: Arc<AtomicUsize>,
    /// Audio frames queued and not yet taken by the thread.
    frames: Arc<AtomicUsize>,
    cancel: watch::Sender<bool>,
    /// The `seq` the next `stt.audio` must carry.
    next_seq: u64,
    window: u64,
    /// Audio bytes received and not yet acknowledged.
    outstanding: u64,
    deadline: Instant,
    /// The `vllm` engine connection, when one is open.
    engine: EngineSocket,
    _thread: JoinHandle<()>,
}

/// The relay loop's live speech-to-text sessions.
pub struct SttRegistry {
    sessions: BTreeMap<String, Session>,
    recent: VecDeque<String>,
    recent_set: BTreeSet<String>,
    /// Endpoints with a stop job on its way: no new sessions there.
    stopping: BTreeMap<String, StopMark>,
    /// Session threads still running (see [`STT_THREADS_MAX`]).
    threads: Arc<AtomicUsize>,
    next_endpoint_check: Option<Instant>,
    tx: SyncSender<FromWorker>,
}

impl SttRegistry {
    pub(crate) fn new(tx: SyncSender<FromWorker>) -> Self {
        Self {
            sessions: BTreeMap::new(),
            recent: VecDeque::new(),
            recent_set: BTreeSet::new(),
            stopping: BTreeMap::new(),
            threads: Arc::new(AtomicUsize::new(0)),
            next_endpoint_check: None,
            tx,
        }
    }

    /// A deployment stop for `endpoint_slug` is about to run: its sessions
    /// end now (`not_found`, "model_unavailable") and no new one opens there
    /// until a start job for it arrives, the endpoint leaves the snapshot, or
    /// the stop (`step_id`) is refused or fails ([`Self::stop_failed`]).
    pub fn endpoint_stopping(
        &mut self,
        endpoint_slug: &str,
        step_id: &str,
    ) -> Vec<ClientControlMessage> {
        self.stopping.insert(
            endpoint_slug.to_string(),
            StopMark {
                step_id: step_id.to_string(),
                start_waiting: false,
                stop_done: false,
            },
        );
        let ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.endpoint_slug == endpoint_slug)
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter()
            .flat_map(|id| self.fail(id, RelayFailure::NotFound, "model_unavailable"))
            .collect()
    }

    /// A start job for `endpoint_slug`. While its stop is still running the
    /// endpoint keeps refusing sessions (the engine is about to die); the
    /// mark goes once that stop finishes ([`Self::stop_finished`]). A stop
    /// that already finished leaves nothing to wait for: the mark goes now.
    pub fn endpoint_starting(&mut self, endpoint_slug: &str) {
        let Some(mark) = self.stopping.get_mut(endpoint_slug) else {
            return;
        };
        if mark.stop_done {
            self.stopping.remove(endpoint_slug);
        } else {
            mark.start_waiting = true;
        }
    }

    /// The stop step `step_id` finished. If a start is already waiting, the
    /// endpoint may take sessions again once that start makes it ready;
    /// otherwise the mark stays until a start arrives or the endpoint leaves
    /// the snapshot.
    pub fn stop_finished(&mut self, step_id: &str) {
        self.stopping.retain(|_, mark| {
            if mark.step_id != step_id {
                return true;
            }
            mark.stop_done = true;
            !mark.start_waiting
        });
    }

    /// The deployment step `step_id` was refused or failed. If it was a
    /// stop, its endpoint is still serving, so it takes sessions again.
    pub fn stop_failed(&mut self, step_id: &str) {
        self.stopping.retain(|_, mark| mark.step_id != step_id);
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn is_live(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    /// Audio bytes the server may still send to a live session.
    pub fn credit(&self, session_id: &str) -> Option<u64> {
        self.sessions
            .get(session_id)
            .map(|session| session.window - session.outstanding)
    }

    /// Handles one server control frame; returns the frames to send.
    pub fn handle(
        &mut self,
        message: SttServerMessage,
        managed: &[EndpointConfig],
        now: Instant,
    ) -> Vec<ClientControlMessage> {
        match message {
            SttServerMessage::Open {
                session_id,
                endpoint_slug,
                upstream_model,
                adapter,
                config,
                max_item_seconds,
                max_session_ms,
                audio_window_bytes,
            } => self.open(
                OpenRequest {
                    session_id,
                    endpoint_slug,
                    upstream_model,
                    adapter,
                    config,
                    max_item_seconds,
                    max_session_ms,
                    audio_window_bytes,
                },
                managed,
                now,
            ),
            SttServerMessage::Update { session_id, config } => {
                self.forward(&session_id, Input::Update(config))
            }
            SttServerMessage::Commit {
                session_id,
                item_seq,
            } => self.forward(&session_id, Input::Commit(item_seq)),
            SttServerMessage::Clear {
                session_id,
                item_seq,
            } => self.forward(&session_id, Input::Clear(item_seq)),
            SttServerMessage::Close { session_id, .. } => {
                if self.end(&session_id) {
                    tracing::info!(session_id, "speech-to-text session closed");
                    vec![ClientControlMessage::SttClosed { session_id }]
                } else {
                    Vec::new()
                }
            }
        }
    }

    /// One `stt.audio` frame (metadata and body already checked).
    pub fn audio(
        &mut self,
        session_id: &str,
        seq: u64,
        body: Vec<u8>,
    ) -> Vec<ClientControlMessage> {
        let Some(session) = self.sessions.get_mut(session_id) else {
            // Unknown or ended: late audio is expected after a close.
            return Vec::new();
        };
        if seq != session.next_seq {
            return self.fail(
                session_id,
                RelayFailure::ProtocolError,
                "audio frames arrived out of sequence",
            );
        }
        let bytes = body.len() as u64;
        if session.outstanding + bytes > session.window {
            return self.fail(
                session_id,
                RelayFailure::ProtocolError,
                "audio exceeded the credit window",
            );
        }
        if session.frames.load(Ordering::SeqCst) >= AUDIO_FRAMES_QUEUED_MAX {
            return self.fail(
                session_id,
                RelayFailure::ProtocolError,
                "too many audio frames are queued",
            );
        }
        // A send error means the thread already ended and reported why.
        if session.input.send(Input::Audio(body)).is_ok() {
            session.frames.fetch_add(1, Ordering::SeqCst);
            session.next_seq += 1;
            session.outstanding += bytes;
        }
        Vec::new()
    }

    /// A malformed `stt.*` frame that names `session_id`. A live session
    /// fails (its audio or commands would be lost otherwise); a malformed
    /// `stt.open` for an id never seen is refused by name.
    pub fn malformed(&mut self, session_id: &str, open: bool) -> Vec<ClientControlMessage> {
        if self.is_live(session_id) {
            return self.fail(
                session_id,
                RelayFailure::ProtocolError,
                "malformed stt frame",
            );
        }
        if open && is_session_id(session_id) && !self.recent_set.contains(session_id) {
            self.remember(session_id);
            return vec![error(
                session_id,
                RelayFailure::ProtocolError,
                "malformed stt.open",
            )];
        }
        Vec::new()
    }

    /// A frame a session thread produced. Returns it when it should go out:
    /// frames of ended sessions are dropped, acknowledgements return credit
    /// and an `stt.error` ends the session.
    pub fn outbound(
        &mut self,
        session_id: &str,
        message: ClientControlMessage,
    ) -> Option<ClientControlMessage> {
        let session = self.sessions.get_mut(session_id)?;
        match message {
            ClientControlMessage::SttAudioAck { session_id, bytes } => {
                // Never acknowledge more than was received.
                let bytes = u64::from(bytes).min(session.outstanding);
                session.outstanding -= bytes;
                (bytes > 0).then_some(ClientControlMessage::SttAudioAck {
                    session_id,
                    bytes: bytes as u32,
                })
            }
            ClientControlMessage::SttError { .. } => {
                self.end(session_id);
                Some(message)
            }
            other => Some(other),
        }
    }

    /// Ends a session whose frame the encoder refused, and returns the one
    /// `stt.error` to send instead (always within the contract).
    pub fn refused_by_encoder(&mut self, session_id: &str) -> Option<ClientControlMessage> {
        self.end(session_id);
        if !is_session_id(session_id) {
            return None;
        }
        self.remember(session_id);
        Some(error(
            session_id,
            RelayFailure::ProtocolError,
            "a session frame was outside the wire contract",
        ))
    }

    /// Ends sessions past their deadline (every pass) or whose endpoint is
    /// gone (at most once a second). `managed` is read only then, and only
    /// while a session is live or a stop is pending.
    pub fn poll(
        &mut self,
        now: Instant,
        managed: impl FnOnce() -> Vec<EndpointConfig>,
    ) -> Vec<ClientControlMessage> {
        let mut frames = Vec::new();
        let expired: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| now >= session.deadline)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            frames.extend(self.fail(
                &id,
                RelayFailure::Timeout,
                "the session outlived maxSessionMs",
            ));
        }
        let due = self.next_endpoint_check.is_none_or(|next| now >= next);
        if !due || (self.sessions.is_empty() && self.stopping.is_empty()) {
            return frames;
        }
        self.next_endpoint_check = Some(now + ENDPOINT_CHECK_INTERVAL);
        let live: BTreeSet<String> = managed()
            .into_iter()
            .filter(|endpoint| endpoint.enabled)
            .map(|endpoint| endpoint.slug)
            .collect();
        // A finished stop removed the endpoint; a later start adds it anew.
        self.stopping.retain(|slug, _| live.contains(slug));
        let gone: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| !live.contains(&session.endpoint_slug))
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
            frames.extend(self.fail(&id, RelayFailure::NotFound, "model_unavailable"));
        }
        frames
    }

    /// The relay connection is gone: end every session without a word (the
    /// server fails them itself).
    pub fn abort_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.end(&id);
        }
    }

    fn open(
        &mut self,
        request: OpenRequest,
        managed: &[EndpointConfig],
        now: Instant,
    ) -> Vec<ClientControlMessage> {
        let id = request.session_id.clone();
        if self.is_live(&id) {
            // A reused live id: the session and the request both fail.
            return self.fail(
                &id,
                RelayFailure::ProtocolError,
                "session id is already in use",
            );
        }
        if self.recent_set.contains(&id) {
            return vec![error(
                &id,
                RelayFailure::ProtocolError,
                "session id is already in use",
            )];
        }
        let refuse = |failure, message: &str| {
            tracing::info!(session_id = %id, reason = message, "speech-to-text session refused");
            vec![error(&id, failure, message)]
        };
        if self.stopping.contains_key(&request.endpoint_slug) {
            return refuse(RelayFailure::NotFound, "model_unavailable");
        }
        let Some(endpoint) = managed
            .iter()
            .find(|endpoint| endpoint.enabled && endpoint.slug == request.endpoint_slug)
        else {
            return refuse(
                RelayFailure::NotFound,
                "the endpoint is not a running recipe deployment on this node",
            );
        };
        let realtime = match endpoint
            .default_capabilities
            .audio
            .as_ref()
            .and_then(|audio| audio.transcriptions.as_ref())
        {
            Some(AudioOperationCapabilities::Detailed(caps)) => caps.realtime.clone(),
            _ => None,
        };
        let Some(realtime) = realtime.filter(|realtime| realtime.supported == Some(true)) else {
            return refuse(
                RelayFailure::UnsupportedCapability,
                "the endpoint does not take live sessions",
            );
        };
        if realtime.adapter != request.adapter {
            return refuse(
                RelayFailure::UnsupportedCapability,
                "the endpoint uses a different realtime adapter",
            );
        }
        // vLLM's realtime protocol has no language or prompt.
        if request.adapter == RealtimeAdapter::Vllm && !request.config.is_empty() {
            return refuse(
                RelayFailure::UnsupportedCapability,
                "the vllm adapter takes no language or prompt",
            );
        }
        if !endpoint
            .models
            .iter()
            .any(|model| model.upstream_model_id == request.upstream_model)
        {
            return refuse(
                RelayFailure::NotFound,
                "the endpoint does not serve that model",
            );
        }
        if self.sessions.len() >= STT_SESSIONS_MAX {
            return refuse(
                RelayFailure::RateLimited,
                "this node serves its maximum of live sessions",
            );
        }
        let endpoint_cap = realtime
            .max_sessions
            .map_or(STT_SESSIONS_MAX, |cap| cap as usize);
        let on_endpoint = self
            .sessions
            .values()
            .filter(|session| session.endpoint_slug == request.endpoint_slug)
            .count();
        if on_endpoint >= endpoint_cap {
            return refuse(
                RelayFailure::RateLimited,
                "the endpoint serves its maximum of live sessions",
            );
        }
        // The server derives the turn length from the same profile; never
        // exceed what the recipe declared.
        let declared = realtime.max_item_seconds.unwrap_or(match request.adapter {
            RealtimeAdapter::Segmented => 30,
            RealtimeAdapter::Vllm => 300,
        });
        let max_item_seconds = request.max_item_seconds.min(declared);
        let engine_endpoint = EngineEndpoint {
            base_url: endpoint.base_url.clone(),
            headers: endpoint
                .headers
                .iter()
                .map(|header| (header.name.clone(), header.env.clone()))
                .collect(),
            auth: endpoint
                .auth
                .as_ref()
                .map(|auth| (auth.mode.clone(), auth.env.clone())),
            model: request.upstream_model.clone(),
        };
        if self.threads.load(Ordering::SeqCst) >= STT_THREADS_MAX {
            return refuse(
                RelayFailure::RateLimited,
                "this node is still closing earlier live sessions",
            );
        }
        let (input_tx, input_rx) = mpsc::channel();
        let controls = Arc::new(AtomicUsize::new(0));
        let frames = Arc::new(AtomicUsize::new(0));
        let thread_frames = Arc::clone(&frames);
        let slot = ThreadSlot::take(&self.threads);
        let (cancel, cancel_rx) = watch::channel(false);
        let tx = self.tx.clone();
        let thread_id = id.clone();
        let config = request.config.clone();
        let thread_controls = Arc::clone(&controls);
        let engine: EngineSocket = Arc::default();
        let thread_engine = Arc::clone(&engine);
        let adapter = request.adapter;
        let spawned = thread::Builder::new()
            .name("wsmp-stt".into())
            .spawn(move || {
                // Released when the thread ends, however late that is.
                let _slot = slot;
                let session = SessionThread {
                    session_id: thread_id,
                    endpoint: engine_endpoint,
                    config,
                    max_item_seconds,
                    inbox: SessionInput {
                        input: input_rx,
                        controls: thread_controls,
                        frames: thread_frames,
                    },
                    tx,
                    cancel: cancel_rx,
                };
                match adapter {
                    RealtimeAdapter::Segmented => run_session(session),
                    RealtimeAdapter::Vllm => vllm::run_session(session, &thread_engine),
                }
            });
        let Ok(thread) = spawned else {
            return refuse(RelayFailure::Unknown, "could not start the session");
        };
        tracing::info!(
            session_id = %id,
            endpoint = %request.endpoint_slug,
            max_item_seconds,
            "speech-to-text session opening"
        );
        self.sessions.insert(
            id,
            Session {
                endpoint_slug: request.endpoint_slug,
                input: input_tx,
                controls,
                frames,
                cancel,
                next_seq: 0,
                window: u64::from(request.audio_window_bytes),
                outstanding: 0,
                deadline: now + Duration::from_millis(request.max_session_ms) + SESSION_GRACE,
                engine,
                _thread: thread,
            },
        );
        Vec::new()
    }

    fn forward(&mut self, session_id: &str, input: Input) -> Vec<ClientControlMessage> {
        let Some(session) = self.sessions.get(session_id) else {
            return Vec::new();
        };
        // A thread blocked behind a slow engine still takes audio credit
        // back only as it goes; commands may pile up, but not without bound.
        if session.controls.fetch_add(1, Ordering::SeqCst) >= CONTROL_QUEUE_MAX {
            return self.fail(
                session_id,
                RelayFailure::ProtocolError,
                "too many session commands are queued",
            );
        }
        // A send error means the thread already ended and reported why.
        let _ = session.input.send(input);
        Vec::new()
    }

    fn fail(
        &mut self,
        session_id: &str,
        failure: RelayFailure,
        message: &str,
    ) -> Vec<ClientControlMessage> {
        if !self.end(session_id) {
            return Vec::new();
        }
        tracing::warn!(
            session_id,
            reason = message,
            "speech-to-text session failed"
        );
        vec![error(session_id, failure, message)]
    }

    /// Removes and cancels a live session; false when it was not live.
    fn end(&mut self, session_id: &str) -> bool {
        let Some(session) = self.sessions.remove(session_id) else {
            return false;
        };
        let _ = session.cancel.send(true);
        // A thread blocked on the engine socket wakes now, and the engine
        // sees the hang-up (vLLM then cancels the generation).
        if let Some(socket) = session.engine.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = socket.shutdown(Shutdown::Both);
        }
        // Dropping the input sender wakes an idle thread; the thread detaches.
        drop(session.input);
        self.remember(session_id);
        true
    }

    fn remember(&mut self, session_id: &str) {
        if !self.recent_set.insert(session_id.to_string()) {
            return;
        }
        self.recent.push_back(session_id.to_string());
        if self.recent.len() > RECENT_CAPACITY
            && let Some(oldest) = self.recent.pop_front()
        {
            self.recent_set.remove(&oldest);
        }
    }
}

impl Drop for SttRegistry {
    fn drop(&mut self) {
        self.abort_all();
    }
}

struct OpenRequest {
    session_id: String,
    endpoint_slug: String,
    upstream_model: String,
    adapter: RealtimeAdapter,
    config: SttConfig,
    max_item_seconds: u32,
    max_session_ms: u64,
    audio_window_bytes: u32,
}

/// The session a CLI to server `stt.*` frame names.
pub fn session_of(message: &ClientControlMessage) -> Option<&str> {
    match message {
        ClientControlMessage::SttOpened { session_id }
        | ClientControlMessage::SttAudioAck { session_id, .. }
        | ClientControlMessage::SttEvent { session_id, .. }
        | ClientControlMessage::SttError { session_id, .. }
        | ClientControlMessage::SttClosed { session_id } => Some(session_id),
        _ => None,
    }
}

fn error(session_id: &str, failure: RelayFailure, message: &str) -> ClientControlMessage {
    ClientControlMessage::SttError {
        session_id: session_id.to_string(),
        failure,
        message: Some(message.to_string()),
    }
}

/// Sends from a session thread; false once the relay loop is gone.
fn emit(tx: &SyncSender<FromWorker>, session_id: &str, message: ClientControlMessage) -> bool {
    tx.send(FromWorker::Stt {
        session_id: session_id.to_string(),
        message,
    })
    .is_ok()
}

fn emit_event(tx: &SyncSender<FromWorker>, session_id: &str, event: SttEvent) -> bool {
    emit(
        tx,
        session_id,
        ClientControlMessage::SttEvent {
            session_id: session_id.to_string(),
            event,
        },
    )
}

/// A stop job's mark on its endpoint.
struct StopMark {
    step_id: String,
    /// A start job for the endpoint arrived while the stop still ran.
    start_waiting: bool,
    /// The stop step finished (succeeded); a later start lifts the mark.
    stop_done: bool,
}

/// One running session thread, counted until the thread itself ends.
struct ThreadSlot(Arc<AtomicUsize>);

impl ThreadSlot {
    fn take(threads: &Arc<AtomicUsize>) -> Self {
        threads.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(threads))
    }
}

impl Drop for ThreadSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A session thread's inbox and its counts of queued inputs.
struct SessionInput {
    input: Receiver<Input>,
    controls: Arc<AtomicUsize>,
    frames: Arc<AtomicUsize>,
}

impl SessionInput {
    /// The next input without waiting. `Err(())` once the session is gone.
    fn try_next(&self) -> Result<Option<Input>, ()> {
        match self.input.try_recv() {
            Ok(input) => {
                self.taken(&input);
                Ok(Some(input))
            }
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(()),
        }
    }

    fn taken(&self, input: &Input) {
        if matches!(input, Input::Audio(_)) {
            self.frames.fetch_sub(1, Ordering::SeqCst);
        } else {
            self.controls.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// What every session thread starts with, whatever its adapter.
struct SessionThread {
    session_id: String,
    endpoint: EngineEndpoint,
    config: SttConfig,
    max_item_seconds: u32,
    inbox: SessionInput,
    tx: SyncSender<FromWorker>,
    cancel: watch::Receiver<bool>,
}

fn ack(session_id: &str, bytes: u32) -> ClientControlMessage {
    ClientControlMessage::SttAudioAck {
        session_id: session_id.to_string(),
        bytes,
    }
}

/// One session: resample incoming audio into the open turn, end turns on
/// commit (or at `max_item_seconds`), and hand ended turns, in order, to a
/// transcriber thread so audio keeps flowing while the engine works.
fn run_session(session: SessionThread) {
    let SessionThread {
        session_id,
        endpoint,
        config,
        max_item_seconds,
        inbox,
        tx,
        cancel,
    } = session;
    let (turns_tx, turns_rx) = mpsc::sync_channel::<segmented::Item>(PENDING_TURNS);
    let transcriber = {
        let session_id = session_id.clone();
        let tx = tx.clone();
        let cancel = cancel.clone();
        thread::Builder::new()
            .name("wsmp-stt-turns".into())
            .spawn(move || run_transcriber(&session_id, &endpoint, turns_rx, &tx, cancel))
    };
    if transcriber.is_err() {
        emit(
            &tx,
            &session_id,
            error(
                &session_id,
                RelayFailure::Unknown,
                "could not start the session",
            ),
        );
        return;
    }
    if !emit(
        &tx,
        &session_id,
        ClientControlMessage::SttOpened {
            session_id: session_id.clone(),
        },
    ) {
        return;
    }
    let mut turn = Turn::new(config, max_item_seconds);
    loop {
        if *cancel.borrow() {
            return;
        }
        let next = match inbox.input.recv_timeout(IDLE_POLL) {
            Ok(next) => next,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        inbox.taken(&next);
        let step = match next {
            Input::Audio(bytes) => {
                let received = bytes.len() as u32;
                let ended = turn.audio(&bytes);
                if !emit(&tx, &session_id, ack(&session_id, received)) {
                    return;
                }
                ended.map(|items| (items, true))
            }
            Input::Commit(seq) => turn
                .commit(seq)
                .map(|item| (item.into_iter().collect(), false)),
            Input::Clear(seq) => turn.clear(seq).map(|()| (Vec::new(), false)),
            Input::Update(config) => {
                turn.update(config);
                Ok((Vec::new(), false))
            }
        };
        let (items, automatic) = match step {
            Ok(step) => step,
            Err(message) => {
                emit(
                    &tx,
                    &session_id,
                    error(&session_id, RelayFailure::ProtocolError, message),
                );
                return;
            }
        };
        for item in items {
            if automatic
                && !emit_event(
                    &tx,
                    &session_id,
                    SttEvent::AutoCommitted {
                        item_seq: item.item_seq,
                    },
                )
            {
                return;
            }
            // Blocks while the engine is busy: audio then waits, unacknowledged.
            if turns_tx.send(item).is_err() {
                return;
            }
        }
    }
}

fn run_transcriber(
    session_id: &str,
    endpoint: &EngineEndpoint,
    turns: Receiver<segmented::Item>,
    tx: &SyncSender<FromWorker>,
    mut cancel: watch::Receiver<bool>,
) {
    while let Ok(item) = turns.recv() {
        let started = Instant::now();
        let item_seq = item.item_seq;
        let samples = item.samples.len();
        // Moved in: the samples are freed once the request body holds them.
        let Some(outcome) = segmented::transcribe(endpoint, item, &mut cancel) else {
            return;
        };
        let failed = matches!(outcome, segmented::Outcome::Failed { .. });
        tracing::info!(
            session_id,
            item_seq,
            samples,
            elapsed_ms = started.elapsed().as_millis() as u64,
            failed,
            "speech-to-text turn transcribed"
        );
        for event in segmented::events(item_seq, outcome) {
            if *cancel.borrow() || !emit_event(tx, session_id, event) {
                return;
            }
        }
    }
}

/// The turn being built and the item numbering.
struct Turn {
    resampler: resample::Resampler24To16,
    samples: Vec<i16>,
    item_seq: u32,
    config: SttConfig,
    /// From `stt.update`; applies from the next turn.
    next_config: Option<SttConfig>,
    max_samples: usize,
}

impl Turn {
    fn new(config: SttConfig, max_item_seconds: u32) -> Self {
        Self {
            resampler: resample::Resampler24To16::new(),
            samples: Vec::new(),
            item_seq: 0,
            config,
            next_config: None,
            max_samples: max_item_seconds as usize * segmented::SAMPLE_RATE as usize,
        }
    }

    /// Takes audio; returns the turns the `max_item_seconds` valve ended.
    fn audio(&mut self, bytes: &[u8]) -> Result<Vec<segmented::Item>, &'static str> {
        self.resampler.push(bytes, &mut self.samples);
        let mut ended = Vec::new();
        while self.samples.len() >= self.max_samples {
            let rest = self.samples.split_off(self.max_samples);
            let samples = std::mem::replace(&mut self.samples, rest);
            ended.push(self.end_turn(samples)?);
        }
        Ok(ended)
    }

    /// `stt.commit`: an older item already ended (the valve raced it), so
    /// that is no error; a future item is.
    fn commit(&mut self, seq: u32) -> Result<Option<segmented::Item>, &'static str> {
        if seq < self.item_seq {
            return Ok(None);
        }
        if seq > self.item_seq {
            return Err("commit names an item that has not started");
        }
        let samples = std::mem::take(&mut self.samples);
        self.end_turn(samples).map(Some)
    }

    fn clear(&mut self, seq: u32) -> Result<(), &'static str> {
        if seq < self.item_seq {
            return Ok(());
        }
        if seq > self.item_seq {
            return Err("clear names an item that has not started");
        }
        self.samples.clear();
        self.end_turn(Vec::new()).map(|_| ())
    }

    fn update(&mut self, config: SttConfig) {
        if self.samples.is_empty() {
            // Nothing of the open turn exists yet: it is the next turn.
            self.config = config;
        } else {
            self.next_config = Some(config);
        }
    }

    fn end_turn(&mut self, samples: Vec<i16>) -> Result<segmented::Item, &'static str> {
        let item = segmented::Item {
            item_seq: self.item_seq,
            samples,
            config: self.config.clone(),
        };
        self.item_seq = self
            .item_seq
            .checked_add(1)
            .ok_or("the session ran out of item numbers")?;
        if let Some(config) = self.next_config.take() {
            self.config = config;
        }
        Ok(item)
    }
}

#[cfg(test)]
mod tests;
