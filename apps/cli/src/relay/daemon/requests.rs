//! The relayed requests of one session, as the main loop tracks them: the
//! live workers, the recently retired ids, and starting a worker for a
//! `relay.request`.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};

use crate::node::config::Config;
use crate::services::media::TrustedOrigins;
use crate::services::relay_bus::FromWorker;
use crate::wire::protocol::RelayFailure;

use super::node_runtimes::NodeRuntimes;
use super::request_body::{BodyChunk, REQUEST_BODY_INGRESS_CAPACITY};
use super::upstream_worker::{
    CancellationHandle, CountFirstPlan, UpstreamRequestSpec, endpoint_count_method,
    run_count_first_worker, run_upstream_worker,
};
use super::wire::{RelaySessionResult, send_relay_error};

/// Where a live request's body stands, as the main loop routes its frames.
pub(super) enum RequestBody {
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
pub(super) struct WorkerHandle {
    pub(super) body: RequestBody,
    cancellation: CancellationHandle,
    join: JoinHandle<()>,
}

/// Why a request leaves the live set ([`RelayRequests::retire`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Retire {
    /// Its worker reported `Finished`: joined (it is done).
    Finished,
    /// The server cancelled it (`relay.cancel`).
    Cancelled,
    /// The node faulted it (`relay.error` already sent or about to be).
    Faulted,
}

/// What the main loop knows about one request id.
pub(super) enum RequestState<'a> {
    Live(&'a mut WorkerHandle),
    /// Retired recently: late frames for it are expected and dropped.
    Retired,
    /// Never seen (or retired too long ago to remember).
    Unknown,
}

/// Every relayed request of one session: the live ones and the recently
/// retired ids. One place moves a request from live to retired
/// ([`Self::retire`]), so every exit records it the same way.
pub(super) struct RelayRequests {
    live: BTreeMap<String, WorkerHandle>,
    retired: RecentlyFinished,
}

impl RelayRequests {
    pub(super) fn new() -> Self {
        Self {
            live: BTreeMap::new(),
            retired: RecentlyFinished::new(),
        }
    }

    /// Frames a worker queued for `request_id` may still go out.
    pub(super) fn is_live(&self, request_id: &str) -> bool {
        self.live.contains_key(request_id)
    }

    /// Live, or retired recently: a `relay.request` reusing it is a fault.
    fn in_use(&self, request_id: &str) -> bool {
        self.is_live(request_id) || self.retired.contains(request_id)
    }

    pub(super) fn state(&mut self, request_id: &str) -> RequestState<'_> {
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
    pub(super) fn retire(&mut self, request_id: &str, reason: Retire) -> bool {
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
    pub(super) fn abort_all(&mut self) {
        abort_all_workers(std::mem::take(&mut self.live));
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

/// One `relay.request`, as the daemon routes it.
pub(super) struct RelayRequest {
    pub(super) request_id: String,
    pub(super) method: String,
    pub(super) path: String,
    pub(super) headers: BTreeMap<String, String>,
    pub(super) timeout_ms: u64,
    pub(super) handle: String,
    pub(super) expect_body: bool,
    pub(super) body_bytes: Option<u64>,
    pub(super) count_first: bool,
    pub(super) count_ceiling: Option<u64>,
}

pub(super) fn start_relay_request<S>(
    socket: &mut tungstenite::WebSocket<S>,
    config: &Config,
    runtimes: &NodeRuntimes,
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

    let Some(target) = runtimes.target(&handle) else {
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
    if !crate::services::runtimes::allowlist::allowed(&target.spec, &method, &path)
        && !crate::services::runtimes::allowlist::engine_description_allowed(
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
            Some(crate::services::runtimes::allowlist::PATH_NOT_ALLOWED.to_string()),
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

#[cfg(test)]
mod tests {
    use super::super::link::RELAY_WORKER_OUTBOUND_CAPACITY;
    use super::super::request_body::{BodyRoute, deliver_body_chunk};
    use super::super::wire::tests::sink_socket;
    use super::*;
    use std::sync::atomic::Ordering;

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
            &NodeRuntimes::default(),
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
            &NodeRuntimes::default(),
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
}
