//! Relay 3.0 telemetry: `node.info`, `node.metrics` and `runtime.load`.
//!
//! One sampling thread per relay session collects everything. The relay loop
//! is a single blocking thread, so nothing here runs on it: the sampler hands
//! finished frames to the loop with `try_send` and drops a frame when the
//! outbound queue is full rather than wait. Every external read is bounded:
//! HTTP scrapes use [`crate::engine::LOAD_TIMEOUT`], `nvidia-smi` is killed
//! after [`GPU_QUERY_TIMEOUT`], and its stderr is discarded.
//!
//! Linux reads `/proc`, `/sys/class/net` and `statvfs`; other platforms send
//! what they can (architecture, CPU count, CLI version).
//!
//! Node metric commands ([`crate::metric_sources`]) run on their own
//! short-lived threads; this thread only schedules them and reports their
//! latest values in `node.metrics.custom`.
//!
//! `runtime.load` is keyed by the runtime handle. Until the runtime store
//! lands (C2), the sampled targets are the configured endpoints, whose slug
//! stands in for the handle; only built-in engine scrapes run (`source:
//! builtin`); route and command readers come with the metrics reader (C4).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::config::EndpointConfig;
use crate::engine::{EngineKind, LoadReading};
use crate::metric_sources::Runner;
use crate::protocol::frames::{
    ExecutionMechanism, LoadSource, NodeCpu, NodeCpuMetrics, NodeDiskMetrics, NodeGpuMetrics,
    NodeInfo, NodeInterfaceInfo, NodeInterfaceMetrics, NodeMemoryMetrics, NodeMetrics, NodeOs,
    RuntimeLoad,
};
use crate::protocol::runtime_spec::NodeMetricCommand;
use crate::protocol::{NODE_GPU_MAX, NODE_INTERFACE_MAX, NodeFrame, encode_control};
use crate::relay_bus::FromWorker;

/// Built-in `node.metrics` cadence (the protocol allows 20–30 s).
pub const NODE_METRICS_INTERVAL: Duration = Duration::from_secs(20);
/// The server drops `node.metrics` frames closer together than this.
pub const NODE_METRICS_MIN_GAP: Duration = Duration::from_secs(5);
/// `runtime.load` sampling cadence.
pub const LOAD_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
/// An unchanged load is re-sent this often so the server's copy stays fresh.
pub const LOAD_REFRESH_INTERVAL: Duration = Duration::from_secs(5);
pub const GPU_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const GPU_QUERY_OUTPUT_LIMIT: u64 = 64 * 1024;
const STOP_POLL: Duration = Duration::from_millis(200);
/// Load scrapes in flight at once, across all endpoints. Each worker is
/// bounded by the engine request timeouts (llama.cpp: two requests).
const LOAD_SCRAPE_CONCURRENCY: usize = 16;
const TEXT_FIELD_MAX: usize = 256;

/// Handle owned by one relay session. Dropping it stops the thread; the relay
/// loop never joins it (a scrape may still be finishing).
pub struct Telemetry {
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
}

#[derive(Default)]
struct Shared {
    endpoints: Vec<EndpointConfig>,
    /// Bumped whenever `endpoints` changes, so the load scheduler resyncs.
    endpoints_generation: u64,
    /// Node metric commands the thread has not applied yet.
    metric_commands: Option<Vec<NodeMetricCommand>>,
}

impl Telemetry {
    /// Start sampling after `hello.ok`. `node.info` is the first frame.
    pub(crate) fn start(tx: SyncSender<FromWorker>, endpoints: &[EndpointConfig]) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Shared {
            endpoints: endpoints.to_vec(),
            ..Shared::default()
        }));
        let thread_stop = Arc::clone(&stop);
        let thread_shared = Arc::clone(&shared);
        let spawned = thread::Builder::new()
            .name("wsmp-telemetry".to_string())
            .spawn(move || run(tx, thread_stop, thread_shared));
        if let Err(error) = spawned {
            tracing::warn!(error = %error, "starting the telemetry thread failed; node metrics are off");
        }
        Self { stop, shared }
    }

    /// Replace the targets whose load is sampled.
    pub fn set_endpoints(&self, endpoints: &[EndpointConfig]) {
        if let Ok(mut shared) = self.shared.lock()
            && shared.endpoints != endpoints
        {
            shared.endpoints = endpoints.to_vec();
            shared.endpoints_generation = shared.endpoints_generation.wrapping_add(1);
        }
    }

    /// Replace the node metric commands (from the node definition).
    pub fn set_metric_commands(&self, commands: Vec<NodeMetricCommand>) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.metric_commands = Some(commands);
        }
    }
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// What happened to one telemetry frame handed to the relay loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sent {
    Queued,
    /// The outbound queue was full (or the frame could not be encoded).
    Dropped,
    /// The session is gone; the sampler stops.
    Gone,
}

/// Hand one frame to the relay loop without waiting. Every telemetry frame
/// passes [`crate::telemetry_bounds::conform`] here, so nothing the sampler
/// read can fall outside the server's strict schema.
fn offer(tx: &SyncSender<FromWorker>, mut message: NodeFrame) -> Sent {
    let Some(text) = encode_telemetry(&mut message) else {
        return Sent::Dropped;
    };
    match tx.try_send(FromWorker::Telemetry(text)) {
        Ok(()) => Sent::Queued,
        Err(TrySendError::Full(_)) => {
            tracing::debug!("relay outbound queue full; telemetry frame dropped");
            Sent::Dropped
        }
        Err(TrySendError::Disconnected(_)) => Sent::Gone,
    }
}

/// Conform and encode one telemetry frame; `None` (logged) if it cannot be.
pub fn encode_telemetry(message: &mut NodeFrame) -> Option<String> {
    crate::telemetry_bounds::conform(message);
    // `node.metrics` stays within the chunk budget: drop custom values, last
    // command first, until it fits.
    if let NodeFrame::NodeMetrics(metrics) = message {
        while serde_json::to_vec(&NodeFrame::NodeMetrics(metrics.clone()))
            .map_or(usize::MAX, |bytes| bytes.len())
            > crate::protocol::frames::CHUNK_BUDGET_BYTES
        {
            match metrics.custom.as_mut() {
                Some(custom) if !custom.is_empty() => {
                    custom.pop();
                }
                _ => break,
            }
        }
    }
    match encode_control(message) {
        Ok(text) => Some(text),
        Err(error) => {
            tracing::warn!(error = %error, "encoding a telemetry frame failed; dropped");
            None
        }
    }
}

fn run(tx: SyncSender<FromWorker>, stop: Arc<AtomicBool>, shared: Arc<Mutex<Shared>>) {
    let mut runner = Runner::new();
    let mut gpu = GpuQuery::default();
    let info = collect_node_info(&mut gpu);
    if offer(&tx, NodeFrame::NodeInfo(info)) == Sent::Gone {
        return;
    }
    // Endpoint load has its own scheduler thread: a slow scrape never delays
    // node metrics (nvidia-smi may take seconds), and the reverse.
    let load_tx = tx.clone();
    let load_stop = Arc::clone(&stop);
    let load_shared = Arc::clone(&shared);
    let spawned = thread::Builder::new()
        .name("wsmp-load".to_string())
        .spawn(move || {
            let agent = crate::engine::http_agent(crate::engine::LOAD_TIMEOUT);
            run_loads(&load_tx, &load_stop, &load_shared, move |endpoint, kind| {
                crate::engine::sample_load(&agent, endpoint, *kind)
            });
        });
    if let Err(error) = spawned {
        tracing::warn!(error = %error, "starting the load sampler failed; runtime load is off");
    }
    let mut cpu = CpuSampler::default();
    // Prime the CPU counters so the first metrics frame has a usage figure.
    cpu.sample();
    let mut last_metrics: Option<Instant> = None;
    let mut sources_changed = false;
    let mut next_metrics = Instant::now() + Duration::from_secs(2);
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        if let Some(commands) = shared
            .lock()
            .ok()
            .and_then(|mut shared| shared.metric_commands.take())
        {
            runner.set_commands(&commands);
        }
        runner.tick(now);
        // A finished command run or a changed command state goes out as soon
        // as the minimum gap allows.
        sources_changed |= runner.take_changed();
        let gap_ok = last_metrics.is_none_or(|at| now.duration_since(at) >= NODE_METRICS_MIN_GAP);
        if gap_ok && (now >= next_metrics || sources_changed) {
            sources_changed = false;
            let metrics = collect_node_metrics(&mut cpu, &mut gpu, &runner);
            if offer(&tx, NodeFrame::NodeMetrics(metrics)) == Sent::Gone {
                return;
            }
            last_metrics = Some(Instant::now());
            next_metrics = Instant::now() + NODE_METRICS_INTERVAL;
        }
        thread::sleep(STOP_POLL);
    }
}

const LOAD_COUNTERS_FILE: &str = "load-counters.json";
const LOAD_COUNTERS_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
struct PersistedLoadCounters {
    counter_epoch: u32,
    prefix_hits_total: Option<f64>,
    prefix_queries_total: Option<f64>,
    process_start_time_seconds: Option<f64>,
}

#[derive(Serialize, Deserialize)]
struct LoadCountersFile {
    version: u32,
    endpoints: BTreeMap<String, PersistedLoadCounters>,
}

fn load_counters_path() -> Option<PathBuf> {
    crate::paths::state_dir()
        .ok()
        .map(|dir| dir.join(LOAD_COUNTERS_FILE))
}

fn read_load_counters_from(path: &Path) -> BTreeMap<String, PersistedLoadCounters> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    serde_json::from_slice::<LoadCountersFile>(&bytes)
        .ok()
        .filter(|file| file.version == LOAD_COUNTERS_VERSION)
        .map(|file| file.endpoints)
        .unwrap_or_default()
}

fn write_load_counters_to(path: &Path, map: &BTreeMap<String, PersistedLoadCounters>) -> bool {
    let file = LoadCountersFile {
        version: LOAD_COUNTERS_VERSION,
        endpoints: map.clone(),
    };
    let Ok(mut bytes) = serde_json::to_vec_pretty(&file) else {
        return false;
    };
    bytes.push(b'\n');
    match crate::approvals::write_private_atomic(path, &bytes, "load counters", false) {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(error = %error, "persisting load counters failed; the next idle sample retries");
            false
        }
    }
}

#[derive(Default)]
struct CounterStore {
    desired: BTreeMap<String, PersistedLoadCounters>,
    dirty: bool,
}

impl CounterStore {
    fn update(&mut self, slug: &str, value: PersistedLoadCounters, path: Option<&Path>) {
        if self.desired.get(slug) != Some(&value) {
            self.desired.insert(slug.to_string(), value);
            self.dirty = true;
        }
        self.flush(path);
    }

    fn prune(&mut self, keep: impl Fn(&str) -> bool, path: Option<&Path>) {
        let previous_len = self.desired.len();
        self.desired.retain(|slug, _| keep(slug));
        self.dirty |= previous_len != self.desired.len();
        self.flush(path);
    }

    fn flush(&mut self, path: Option<&Path>) {
        if self.dirty && path.is_some_and(|path| write_load_counters_to(path, &self.desired)) {
            self.dirty = false;
        }
    }
}

fn persisted_load_counters() -> &'static Mutex<CounterStore> {
    static MAP: OnceLock<Mutex<CounterStore>> = OnceLock::new();
    MAP.get_or_init(|| {
        Mutex::new(CounterStore {
            desired: if cfg!(test) {
                BTreeMap::new()
            } else {
                load_counters_path()
                    .map(|path| read_load_counters_from(&path))
                    .unwrap_or_default()
            },
            dirty: false,
        })
    })
}

#[derive(Default)]
struct LoadState {
    last_sent: Option<(Instant, LoadReading)>,
    prefix_hits_total: Option<f64>,
    prefix_queries_total: Option<f64>,
    process_start_time_seconds: Option<f64>,
    counter_epoch: u32,
    /// A reset frame was planned but the outbound queue dropped it. The next
    /// frame still reports `prefixCacheReset` with `delta = current`.
    pending_reset: bool,
}

impl LoadState {
    /// Seed from the process-wide map so a reconnect of this CLI keeps the
    /// epoch and last counters (an engine restart while disconnected still
    /// looks like a drop).
    fn restore(slug: &str) -> Self {
        persisted_load_counters()
            .lock()
            .ok()
            .and_then(|map| map.desired.get(slug).cloned())
            .map(|persisted| Self {
                last_sent: None,
                prefix_hits_total: persisted.prefix_hits_total,
                prefix_queries_total: persisted.prefix_queries_total,
                process_start_time_seconds: persisted.process_start_time_seconds,
                counter_epoch: persisted.counter_epoch,
                pending_reset: false,
            })
            .unwrap_or_default()
    }

    /// Record a frame the relay loop accepted. A dropped frame is not
    /// committed, so its prefix-cache deltas fold into the next one.
    fn commit(&mut self, slug: &str, reading: LoadReading, at: Instant, counter_epoch: u32) {
        self.prefix_hits_total = reading.prefix_cache_hits_total;
        self.prefix_queries_total = reading.prefix_cache_queries_total;
        self.process_start_time_seconds = reading.process_start_time_seconds;
        self.counter_epoch = counter_epoch;
        self.pending_reset = false;
        self.last_sent = Some((at, reading));
        if let Ok(mut map) = persisted_load_counters().lock() {
            let persisted = PersistedLoadCounters {
                counter_epoch,
                prefix_hits_total: self.prefix_hits_total,
                prefix_queries_total: self.prefix_queries_total,
                process_start_time_seconds: self.process_start_time_seconds,
            };
            let path = if cfg!(test) {
                None
            } else {
                load_counters_path()
            };
            map.update(slug, persisted, path.as_deref());
        }
    }
}

/// Configured endpoints with a scrapeable (declared or detected) engine.
pub fn load_targets(endpoints: &[EndpointConfig]) -> Vec<(EndpointConfig, EngineKind)> {
    endpoints
        .iter()
        .filter(|endpoint| endpoint.enabled)
        .filter_map(|endpoint| {
            crate::engine::effective_kind(endpoint)
                .map(|(kind, _)| kind)
                .filter(|kind| kind.has_load_source())
                .map(|kind| (endpoint.clone(), kind))
        })
        .collect()
}

/// One endpoint's place in the load scheduler.
struct LoadSchedule {
    /// Unique per schedule instance: a result is accepted only by the
    /// schedule that started it (not by a same-looking one re-added later).
    epoch: u64,
    target: (EndpointConfig, EngineKind),
    state: LoadState,
    next_due: Instant,
    in_flight: bool,
    interval: Duration,
}

/// A finished scrape, reported by its worker.
struct LoadDone {
    slug: String,
    epoch: u64,
    reading: Option<LoadReading>,
    finished: Instant,
    ts: String,
}

/// Per-endpoint load scheduling. Each endpoint is scraped every
/// [`LOAD_SAMPLE_INTERVAL`] after its previous scrape finished, by at most
/// [`LOAD_SCRAPE_CONCURRENCY`] short-lived workers in total (each bounded by
/// the engine request timeouts). A finished scrape goes out at once, stamped
/// with its own completion time, so a slow endpoint only occupies a worker
/// and never holds back another endpoint's frame. Due endpoints are started
/// oldest-due first, so none starves when more are due than workers exist.
/// A result for an endpoint whose configuration changed (or that was
/// removed) while it was in flight is discarded.
fn run_loads<F>(tx: &SyncSender<FromWorker>, stop: &AtomicBool, shared: &Mutex<Shared>, sample: F)
where
    F: Fn(&EndpointConfig, &EngineKind) -> Option<LoadReading> + Clone + Send + 'static,
{
    let (done_tx, done_rx) = mpsc::channel::<LoadDone>();
    let mut schedules = BTreeMap::<String, LoadSchedule>::new();
    let mut seen_generation = None;
    let mut in_flight = 0_usize;
    let mut next_epoch = 0_u64;
    while !stop.load(Ordering::SeqCst) {
        let (generation, endpoints) = match shared.lock() {
            Ok(shared) if seen_generation != Some(shared.endpoints_generation) => {
                (shared.endpoints_generation, Some(shared.endpoints.clone()))
            }
            Ok(shared) => (shared.endpoints_generation, None),
            Err(_) => return,
        };
        if let Some(endpoints) = endpoints {
            seen_generation = Some(generation);
            let targets = load_targets(&endpoints);
            schedules.retain(|slug, _| targets.iter().any(|(endpoint, _)| endpoint.slug == *slug));
            if let Ok(mut map) = persisted_load_counters().lock() {
                let path = if cfg!(test) {
                    None
                } else {
                    load_counters_path()
                };
                map.prune(
                    |slug| targets.iter().any(|(endpoint, _)| endpoint.slug == slug),
                    path.as_deref(),
                );
            }
            for target in targets {
                let slug = target.0.slug.clone();
                let replace = schedules
                    .get(&slug)
                    .is_none_or(|schedule| schedule.target != target);
                if replace {
                    next_epoch += 1;
                    let interval = LOAD_SAMPLE_INTERVAL;
                    let restored = LoadState::restore(&slug);
                    schedules.insert(
                        slug,
                        LoadSchedule {
                            epoch: next_epoch,
                            target,
                            state: restored,
                            next_due: Instant::now(),
                            in_flight: false,
                            interval,
                        },
                    );
                }
            }
        }

        if let Ok(mut map) = persisted_load_counters().lock() {
            let path = if cfg!(test) {
                None
            } else {
                load_counters_path()
            };
            map.flush(path.as_deref());
        }
        let now = Instant::now();
        let mut due = schedules
            .iter()
            .filter(|(_, schedule)| !schedule.in_flight && schedule.next_due <= now)
            .map(|(slug, schedule)| (schedule.next_due, slug.clone()))
            .collect::<Vec<_>>();
        due.sort();
        for (_, slug) in due
            .into_iter()
            .take(LOAD_SCRAPE_CONCURRENCY.saturating_sub(in_flight))
        {
            let Some(schedule) = schedules.get_mut(&slug) else {
                continue;
            };
            let target = schedule.target.clone();
            let epoch = schedule.epoch;
            let done_tx = done_tx.clone();
            let sample = sample.clone();
            let spawned = thread::Builder::new()
                .name("wsmp-load-scrape".to_string())
                .spawn(move || {
                    let reading = sample(&target.0, &target.1);
                    let _ = done_tx.send(LoadDone {
                        slug,
                        epoch,
                        reading,
                        finished: Instant::now(),
                        ts: now_rfc3339(),
                    });
                });
            if spawned.is_ok() {
                schedule.in_flight = true;
                in_flight += 1;
            } else {
                schedule.next_due = now + schedule.interval;
            }
        }

        let first = match done_rx.recv_timeout(STOP_POLL) {
            Ok(done) => Some(done),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        for done in first
            .into_iter()
            .chain(std::iter::from_fn(|| done_rx.try_recv().ok()))
        {
            in_flight = in_flight.saturating_sub(1);
            let Some(schedule) = schedules.get_mut(&done.slug) else {
                continue;
            };
            if schedule.epoch != done.epoch {
                continue;
            }
            schedule.in_flight = false;
            schedule.next_due = done.finished + schedule.interval;
            let Some(reading) = done.reading else {
                continue;
            };
            let Some(frame) = next_load_frame(
                &schedule.state,
                &done.slug,
                &reading,
                done.finished,
                &done.ts,
            ) else {
                continue;
            };
            let counter_epoch = frame.counter_epoch;
            let reset = frame.prefix_cache_reset == Some(true);
            match offer(tx, NodeFrame::RuntimeLoad(frame)) {
                Sent::Queued => {
                    schedule
                        .state
                        .commit(&done.slug, reading, done.finished, counter_epoch)
                }
                Sent::Dropped => {
                    if reset {
                        schedule.state.pending_reset = true;
                    }
                }
                Sent::Gone => return,
            }
        }
    }
}

fn counter_delta(previous: Option<f64>, current: Option<f64>) -> Option<u64> {
    let (previous, current) = (previous?, current?);
    // A reset (engine restart) is not a delta. The cap is applied again in
    // `telemetry_bounds::conform`; this keeps the float cast in range.
    (current >= previous).then(|| saturating_byte_counter((current - previous).round() as u64))
}

/// Counts since the engine restarted. Used with `prefixCacheReset` so a dropped
/// reset frame still reports the post-restart total instead of discarding it.
fn counter_since_start(current: Option<f64>) -> Option<u64> {
    current.map(|value| saturating_byte_counter(value.round() as u64))
}

fn counter_reset(previous: Option<f64>, current: Option<f64>) -> bool {
    matches!((previous, current), (Some(previous), Some(current)) if current < previous)
}

/// Decide whether a reading goes out: on change, or every
/// `LOAD_REFRESH_INTERVAL` when unchanged. Prefix-cache counters become
/// deltas against the last frame the relay loop accepted. The caller commits
/// the reading ([`LoadState::commit`]) only once the frame was queued.
fn next_load_frame(
    state: &LoadState,
    handle: &str,
    reading: &LoadReading,
    now: Instant,
    ts: &str,
) -> Option<RuntimeLoad> {
    let identity_changed = match (
        state.process_start_time_seconds,
        reading.process_start_time_seconds,
    ) {
        (Some(previous), Some(current)) => previous != current,
        _ => false,
    };
    let hits_reset = state.pending_reset
        || counter_reset(state.prefix_hits_total, reading.prefix_cache_hits_total);
    let queries_reset = state.pending_reset
        || counter_reset(
            state.prefix_queries_total,
            reading.prefix_cache_queries_total,
        );
    let prefix_cache_reset = hits_reset || queries_reset || identity_changed;
    let hits_delta = if prefix_cache_reset {
        counter_since_start(reading.prefix_cache_hits_total)
    } else {
        counter_delta(state.prefix_hits_total, reading.prefix_cache_hits_total)
    };
    let queries_delta = if prefix_cache_reset {
        counter_since_start(reading.prefix_cache_queries_total)
    } else {
        counter_delta(
            state.prefix_queries_total,
            reading.prefix_cache_queries_total,
        )
    };
    let counter_epoch = if prefix_cache_reset {
        state.counter_epoch.wrapping_add(1)
    } else {
        state.counter_epoch
    };
    let changed_counters = prefix_cache_reset
        || hits_delta.is_some_and(|delta| delta > 0)
        || queries_delta.is_some_and(|delta| delta > 0);
    let due = match &state.last_sent {
        None => true,
        Some((at, last)) => {
            now.duration_since(*at) >= LOAD_REFRESH_INTERVAL
                || changed_counters
                || identity_changed
                || !same_load(last, reading)
        }
    };
    if !due {
        return None;
    }
    let count = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);
    Some(RuntimeLoad {
        handle: handle.to_string(),
        model: None,
        running: count(reading.running),
        waiting: reading.waiting.map(count),
        kv_usage: reading.kv_usage,
        kv_occupancy: reading.kv_occupancy,
        slots_busy: reading.slots_busy.map(count),
        deferred: reading.deferred.map(count),
        prefix_cache_hits_delta: hits_delta,
        prefix_cache_queries_delta: queries_delta,
        prefix_cache_reset: prefix_cache_reset.then_some(true),
        counter_epoch,
        // Built-in engine scrapes only until the metrics reader (C4).
        source: LoadSource::Builtin,
        ts: ts.to_string(),
    })
}

fn close_fraction(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (Some(a), Some(b)) => (a - b).abs() < 0.01,
        (None, None) => true,
        _ => false,
    }
}

fn same_load(left: &LoadReading, right: &LoadReading) -> bool {
    left.running == right.running
        && left.waiting == right.waiting
        && left.slots_busy == right.slots_busy
        && left.deferred == right.deferred
        && close_fraction(left.kv_usage, right.kv_usage)
        && close_fraction(left.kv_occupancy, right.kv_occupancy)
}

/// `[A-Za-z0-9_.:-]{1,64}`: the only metric and label text on the wire.
pub fn is_metric_name(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

/// Label keys that match [`is_metric_name`] but cannot be keys: the server
/// turns a label set into an object, which drops `__proto__` silently, so
/// both sides reject it (`RESERVED_LABEL_KEYS` in the relay schema).
pub const RESERVED_LABEL_KEYS: [&str; 1] = ["__proto__"];

/// A custom series' label key: a metric name that is not reserved.
pub fn is_label_key(value: &str) -> bool {
    is_metric_name(value) && !RESERVED_LABEL_KEYS.contains(&value)
}

/// Label values are free text (GPU names have spaces): 1 to 128 characters,
/// no control characters.
pub fn is_label_value(value: &str) -> bool {
    (1..=128).contains(&value.chars().count()) && !value.chars().any(char::is_control)
}

/// UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn now_rfc3339() -> String {
    rfc3339(SystemTime::now())
}

/// `at` as UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn rfc3339(at: SystemTime) -> String {
    let elapsed = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    format_rfc3339(elapsed.as_secs(), elapsed.subsec_millis())
}

fn format_rfc3339(unix_secs: u64, millis: u32) -> String {
    let days = (unix_secs / 86_400) as i64;
    let seconds_of_day = unix_secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        seconds_of_day / 3_600,
        (seconds_of_day / 60) % 60,
        seconds_of_day % 60
    )
}

fn clip(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut end = trimmed.len().min(TEXT_FIELD_MAX);
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    Some(trimmed[..end].to_string())
}

fn read_text(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// `/proc/meminfo` in MiB, keyed by field name.
pub fn parse_meminfo(text: &str) -> BTreeMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            let kib = rest.split_whitespace().next()?.parse::<u64>().ok()?;
            Some((name.trim().to_string(), kib / 1024))
        })
        .collect()
}

pub fn parse_loadavg(text: &str) -> Option<(f64, f64, f64)> {
    let mut parts = text.split_whitespace().map(|part| part.parse::<f64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// `(busy, total)` jiffies from the first `/proc/stat` line.
pub fn parse_proc_stat(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().find(|line| line.starts_with("cpu "))?;
    let values = line
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse::<u64>().ok())
        .collect::<Vec<_>>();
    if values.len() < 4 {
        return None;
    }
    // user nice system idle iowait irq softirq steal (guest is inside user).
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    let total = values.iter().take(8).sum::<u64>();
    Some((total.saturating_sub(idle), total))
}

#[derive(Default)]
struct CpuSampler {
    last: Option<(u64, u64)>,
}

impl CpuSampler {
    fn sample(&mut self) -> Option<f64> {
        let current = read_text("/proc/stat").and_then(|text| parse_proc_stat(&text))?;
        let previous = self.last.replace(current)?;
        let busy = current.0.checked_sub(previous.0)?;
        let total = current.1.checked_sub(previous.1)?;
        (total > 0).then(|| ((busy as f64 / total as f64) * 1000.0).round() / 10.0)
    }
}

/// One `nvidia-smi --query-gpu` row. `[N/A]` and `[Not Supported]` are `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GpuRow {
    pub index: u32,
    pub name: Option<String>,
    pub uuid: Option<String>,
    pub driver_version: Option<String>,
    pub memory_total_mib: Option<u64>,
    /// `memory.total` read exactly `[N/A]` (a unified-memory GPU such as
    /// GB10), not an error like `[Unknown Error]`.
    pub memory_not_applicable: bool,
    pub memory_used_mib: Option<u64>,
    pub utilization_percent: Option<f64>,
    pub temperature_c: Option<f64>,
    pub power_w: Option<f64>,
    pub sm_clock_mhz: Option<f64>,
}

const GPU_QUERY_FIELDS: &str = "index,name,uuid,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,clocks.sm";

fn gpu_field(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty() && !value.starts_with('[') && !value.eq_ignore_ascii_case("n/a"))
        .then_some(value)
}

/// Parse `--format=csv,noheader,nounits` output for [`GPU_QUERY_FIELDS`].
pub fn parse_nvidia_smi(text: &str) -> Vec<GpuRow> {
    text.lines()
        .filter_map(|line| {
            let fields = line.split(',').collect::<Vec<_>>();
            if fields.len() < 10 {
                return None;
            }
            let number =
                |index: usize| gpu_field(fields[index]).and_then(|v| v.parse::<f64>().ok());
            Some(GpuRow {
                index: gpu_field(fields[0])?.parse().ok()?,
                name: gpu_field(fields[1]).and_then(clip),
                uuid: gpu_field(fields[2]).and_then(clip),
                driver_version: gpu_field(fields[3]).and_then(clip),
                memory_total_mib: number(4).map(|value| value as u64),
                memory_not_applicable: fields[4].trim().eq_ignore_ascii_case("[n/a]"),
                memory_used_mib: number(5).map(|value| value as u64),
                utilization_percent: number(6),
                temperature_c: number(7),
                power_w: number(8),
                sm_clock_mhz: number(9),
            })
        })
        .take(NODE_GPU_MAX)
        .collect()
}

/// `nvidia-smi`, disabled for the session once it is missing.
#[derive(Default)]
struct GpuQuery {
    unavailable: bool,
    /// It answered with GPUs at least once: an NVIDIA node, so a failed
    /// query later must not fall back to AMD rows ([`gpu_metrics`]).
    nvidia_seen: bool,
}

impl GpuQuery {
    fn rows(&mut self) -> Vec<GpuRow> {
        if self.unavailable {
            return Vec::new();
        }
        let args = [
            format!("--query-gpu={GPU_QUERY_FIELDS}"),
            "--format=csv,noheader,nounits".to_string(),
        ];
        match run_bounded(
            "nvidia-smi",
            &args,
            GPU_QUERY_TIMEOUT,
            GPU_QUERY_OUTPUT_LIMIT,
        ) {
            Bounded::Output(output) => {
                let rows = parse_nvidia_smi(&output);
                self.nvidia_seen |= !rows.is_empty();
                rows
            }
            Bounded::Failed => Vec::new(),
            Bounded::Unavailable => {
                self.unavailable = true;
                Vec::new()
            }
        }
    }
}

/// What [`run_bounded`] observed.
#[derive(Debug, PartialEq, Eq)]
pub enum Bounded {
    /// The program could not be started (not installed).
    Unavailable,
    /// It failed, timed out (and was killed), or printed non-UTF-8.
    Failed,
    Output(String),
}

/// Run a program under [`crate::bounded_run`] (scrubbed environment, no
/// stdin, stderr discarded, stdout capped at `limit`, killed with its process
/// group at the deadline, and settled within the deadline plus
/// [`crate::bounded_run::REAP_GRACE`] even when the kill does not end it).
/// Success is exactly: stdout closed, the program exited 0 before the
/// deadline, and at most `limit` bytes of UTF-8. The state table is in
/// [`crate::bounded_run`] and `tests/telemetry_bounded.rs`.
pub fn run_bounded(program: &str, args: &[String], timeout: Duration, limit: u64) -> Bounded {
    let limit = usize::try_from(limit).unwrap_or(usize::MAX - 1);
    match crate::bounded_run::run(program, args, timeout, limit, None) {
        Ok(bytes) => String::from_utf8(bytes).map_or(Bounded::Failed, Bounded::Output),
        Err(crate::bounded_run::RunError::Spawn) => Bounded::Unavailable,
        Err(_) => Bounded::Failed,
    }
}

/// How managed runtime units would run here: a live systemd user manager
/// (with or without linger), launchd on macOS, or nothing usable.
fn execution_mechanism() -> ExecutionMechanism {
    #[cfg(target_os = "linux")]
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        let uid = nix::unistd::Uid::effective().as_raw();
        let manager = |args: &[&str], any_status: bool| -> Option<String> {
            let mut invocation = vec![format!("XDG_RUNTIME_DIR=/run/user/{uid}")];
            invocation.extend(args.iter().map(|arg| (*arg).to_string()));
            let run = if any_status {
                crate::bounded_run::run_until_any_status
            } else {
                crate::bounded_run::run_until
            };
            run("env", &invocation, deadline, 8192, None)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
        };
        let live = manager(&["systemctl", "--user", "is-system-running"], true)
            .is_some_and(|state| user_manager_live(&state));
        if !live {
            return ExecutionMechanism::Unsupported;
        }
        let uid_text = uid.to_string();
        if manager(&["loginctl", "show-user", &uid_text, "-p", "Linger"], false)
            .is_some_and(|text| linger_enabled(&text))
        {
            ExecutionMechanism::SystemdLinger
        } else {
            ExecutionMechanism::SystemdNoLinger
        }
    }
    #[cfg(target_os = "macos")]
    {
        ExecutionMechanism::Macos
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        ExecutionMechanism::Unsupported
    }
}

/// Whether `systemctl --user is-system-running` describes a live user
/// manager. It exits nonzero for every state but `running`, so the state is
/// read from stdout: `degraded` and `starting` managers run user services too.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn user_manager_live(state: &str) -> bool {
    matches!(state.trim(), "running" | "degraded" | "starting")
}

/// Whether `loginctl show-user <uid> -p Linger` says linger is on.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linger_enabled(output: &str) -> bool {
    output.lines().any(|line| {
        line.trim()
            .split_once('=')
            .is_some_and(|(key, value)| key.trim() == "Linger" && value.trim() == "yes")
    })
}

/// `/etc/os-release` `NAME` and `VERSION_ID`.
pub fn parse_os_release(text: &str) -> (Option<String>, Option<String>) {
    let value = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .map(|value| value.trim().trim_matches('"'))
            .and_then(clip)
    };
    (value("NAME"), value("VERSION_ID"))
}

/// `/proc/cpuinfo` model name (x86 `model name`, Arm `Model` or `Hardware`),
/// else the Arm core mix from `CPU implementer` / `CPU part` (server and
/// workstation Arm kernels, e.g. GB10, print no model name).
pub fn parse_cpu_model(text: &str) -> Option<String> {
    ["model name", "Model", "Hardware", "cpu model"]
        .iter()
        .find_map(|key| {
            text.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                (name.trim() == *key).then(|| clip(value)).flatten()
            })
        })
        .or_else(|| arm_core_mix(text))
}

/// Arm Ltd (`0x41`) part numbers of cores found in inference machines.
const ARM_PARTS: &[(&str, &str)] = &[
    ("0xd03", "Cortex-A53"),
    ("0xd05", "Cortex-A55"),
    ("0xd08", "Cortex-A72"),
    ("0xd0b", "Cortex-A76"),
    ("0xd0c", "Neoverse-N1"),
    ("0xd40", "Neoverse-V1"),
    ("0xd41", "Cortex-A78"),
    ("0xd44", "Cortex-X1"),
    ("0xd49", "Neoverse-N2"),
    ("0xd4f", "Neoverse-V2"),
    ("0xd80", "Cortex-A520"),
    ("0xd81", "Cortex-A720"),
    ("0xd82", "Cortex-X4"),
    ("0xd84", "Neoverse-V3"),
    ("0xd85", "Cortex-X925"),
    ("0xd87", "Cortex-A725"),
];

/// `10x Arm Cortex-X925 + 10x Arm Cortex-A725`, in first-seen order.
fn arm_core_mix(text: &str) -> Option<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut implementer: Option<String> = None;
    for line in text.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_ascii_lowercase();
        match name.trim() {
            "CPU implementer" => implementer = Some(value),
            "CPU part" => {
                let core = match implementer.as_deref() {
                    Some("0x41") => ARM_PARTS
                        .iter()
                        .find(|(part, _)| *part == value)
                        .map_or_else(
                            || format!("Arm part {value}"),
                            |(_, core)| format!("Arm {core}"),
                        ),
                    Some(other) => format!("implementer {other} part {value}"),
                    None => continue,
                };
                match counts.iter_mut().find(|(known, _)| *known == core) {
                    Some((_, count)) => *count += 1,
                    None => counts.push((core, 1)),
                }
            }
            _ => {}
        }
    }
    if counts.is_empty() {
        return None;
    }
    let mix = counts
        .iter()
        .map(|(core, count)| format!("{count}x {core}"))
        .collect::<Vec<_>>()
        .join(" + ");
    clip(&mix)
}

fn interface_names() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/sys/class/net") else {
        return Vec::new();
    };
    let mut names = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name != "lo" && is_metric_name(name))
        .collect::<Vec<_>>();
    names.sort();
    names.truncate(NODE_INTERFACE_MAX);
    names
}

fn sys_net_number(interface: &str, file: &str) -> Option<u64> {
    read_text(&format!("/sys/class/net/{interface}/{file}"))?
        .trim()
        .parse::<i64>()
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .map(saturating_byte_counter)
}

/// Kernel counters are u64 lifetime totals, but the server's strict schema
/// caps them at `Number.MAX_SAFE_INTEGER` (a JS number loses precision above
/// it and the frame is then rejected as malformed). Saturate to that ceiling;
/// a saturated value reads as "monotonic since boot, capped here".
pub const BYTE_COUNTER_MAX: u64 = 9_007_199_254_740_991;

fn saturating_byte_counter(value: u64) -> u64 {
    value.min(BYTE_COUNTER_MAX)
}

#[cfg(unix)]
pub(crate) fn interface_addresses() -> BTreeMap<String, Vec<String>> {
    let mut addresses = BTreeMap::<String, Vec<String>>::new();
    let Ok(interfaces) = nix::ifaddrs::getifaddrs() else {
        return addresses;
    };
    for interface in interfaces {
        let Some(address) = interface.address else {
            continue;
        };
        let text = if let Some(v4) = address.as_sockaddr_in() {
            v4.ip().to_string()
        } else if let Some(v6) = address.as_sockaddr_in6() {
            v6.ip().to_string()
        } else {
            continue;
        };
        let list = addresses.entry(interface.interface_name).or_default();
        if list.len() < crate::protocol::NODE_INTERFACE_ADDRESS_MAX {
            list.push(text);
        }
    }
    addresses
}

#[cfg(not(unix))]
pub(crate) fn interface_addresses() -> BTreeMap<String, Vec<String>> {
    BTreeMap::new()
}

fn collect_node_info(gpu: &mut GpuQuery) -> NodeInfo {
    let hardware = crate::hardware::detect(gpu.rows());
    let (os_name, os_version) = read_text("/etc/os-release")
        .map(|text| parse_os_release(&text))
        .unwrap_or((None, None));
    let addresses = interface_addresses();
    let interfaces = interface_names()
        .into_iter()
        .map(|name| NodeInterfaceInfo {
            addresses: addresses.get(&name).cloned(),
            // `speed` is -1 (or unreadable) for links without one.
            link_speed_mbps: sys_net_number(&name, "speed").filter(|speed| *speed > 0),
            mtu: sys_net_number(&name, "mtu").and_then(|mtu| u32::try_from(mtu).ok()),
            // RDMA detection lands with fabrics (C5).
            rdma: None,
            name,
        })
        .collect();
    NodeInfo {
        os: Some(NodeOs {
            name: os_name.or_else(|| clip(std::env::consts::OS)),
            version: os_version,
            kernel: read_text("/proc/sys/kernel/osrelease").and_then(|text| clip(&text)),
            arch: clip(std::env::consts::ARCH),
        }),
        cpu: Some(NodeCpu {
            model: hardware.cpu_model.as_deref().and_then(clip),
            cores: thread::available_parallelism()
                .ok()
                .and_then(|count| u32::try_from(count.get()).ok()),
        }),
        memory_total_mib: hardware.memory_total_mib,
        unified_memory_mib: hardware.unified_memory_mib,
        accelerator_memory_mib: hardware.accelerator_memory_mib,
        gpus: Some(hardware.gpus),
        node_kind: Some(hardware.node_kind),
        interfaces: Some(interfaces),
        execution_mechanism: Some(execution_mechanism()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        declared: None,
    }
}

/// One `nvidia-smi` query now (empty when it is missing or fails).
pub fn query_nvidia() -> Vec<GpuRow> {
    GpuQuery::default().rows()
}

// `c_ulong` and `fsblkcnt_t` differ in width across Unix targets.
#[cfg(unix)]
#[allow(clippy::useless_conversion)]
fn root_disk() -> Option<NodeDiskMetrics> {
    let stats = nix::sys::statvfs::statvfs("/").ok()?;
    let fragment = u64::from(stats.fragment_size());
    let mib = |blocks: u64| blocks.saturating_mul(fragment) / (1024 * 1024);
    let (blocks, available) = (
        u64::from(stats.blocks()),
        u64::from(stats.blocks_available()),
    );
    Some(NodeDiskMetrics {
        mount: "/".to_string(),
        total_mib: Some(mib(blocks)),
        free_mib: Some(mib(available)),
    })
}

#[cfg(not(unix))]
fn root_disk() -> Option<NodeDiskMetrics> {
    None
}

/// `nvidia-smi` rows, else (on a node where it never answered with GPUs)
/// AMD sysfs memory use. Metrics rows carry no vendor, so a mixed node
/// reports its NVIDIA GPUs only, and a failed query on an NVIDIA node
/// reports none rather than AMD rows under NVIDIA indexes.
fn gpu_metrics(nvidia: Vec<GpuRow>, nvidia_seen: bool) -> Vec<NodeGpuMetrics> {
    if nvidia.is_empty() {
        if nvidia_seen || !cfg!(target_os = "linux") {
            return Vec::new();
        }
        return crate::hardware::amd_metrics(&crate::hardware::read_amd_sysfs(
            std::path::Path::new("/"),
        ));
    }
    nvidia
        .into_iter()
        .filter_map(|row| {
            Some(NodeGpuMetrics {
                index: u8::try_from(row.index).ok()?,
                vram_used_mib: row.memory_used_mib,
                vram_total_mib: row.memory_total_mib,
                gtt_used_mib: None,
                utilization_percent: row.utilization_percent,
                temperature_c: row.temperature_c,
                power_w: row.power_w,
                sm_clock_mhz: row.sm_clock_mhz,
            })
        })
        .collect()
}

fn collect_node_metrics(
    cpu: &mut CpuSampler,
    gpu: &mut GpuQuery,
    commands: &Runner,
) -> NodeMetrics {
    let (custom, statuses) = commands.report(Instant::now());
    let load = read_text("/proc/loadavg").and_then(|text| parse_loadavg(&text));
    let memory = read_text("/proc/meminfo").map(|text| parse_meminfo(&text));
    let interfaces = interface_names()
        .into_iter()
        .filter_map(|name| {
            Some(NodeInterfaceMetrics {
                rx_bytes: sys_net_number(&name, "statistics/rx_bytes")?,
                tx_bytes: sys_net_number(&name, "statistics/tx_bytes")?,
                name,
            })
        })
        .collect();
    NodeMetrics {
        ts: now_rfc3339(),
        cpu: Some(NodeCpuMetrics {
            usage_percent: cpu.sample(),
            load1: load.map(|(one, _, _)| one),
            load5: load.map(|(_, five, _)| five),
            load15: load.map(|(_, _, fifteen)| fifteen),
        }),
        memory: memory.map(|fields| NodeMemoryMetrics {
            total_mib: fields.get("MemTotal").copied(),
            available_mib: fields.get("MemAvailable").copied(),
            swap_total_mib: fields.get("SwapTotal").copied(),
            swap_free_mib: fields.get("SwapFree").copied(),
        }),
        disks: Some(root_disk().into_iter().collect()),
        gpus: Some({
            let rows = gpu.rows();
            gpu_metrics(rows, gpu.nvidia_seen)
        }),
        interfaces: Some(interfaces),
        custom: (!custom.is_empty()).then_some(custom),
        metric_commands: (!statuses.is_empty()).then_some(statuses),
        abandoned_recovery: {
            #[cfg(unix)]
            {
                crate::file_ops::abandoned_recovery_count()
            }
            #[cfg(not(unix))]
            {
                None
            }
        },
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_failed_nvidia_query_never_reports_amd_rows_on_an_nvidia_node() {
        assert!(super::gpu_metrics(Vec::new(), true).is_empty());
        let rows = super::parse_nvidia_smi(
            "0, NVIDIA GeForce RTX 3090, GPU-1, 550.54, 24576, 1024, 7, 40, 30.5, 210",
        );
        let metrics = super::gpu_metrics(rows, true);
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].vram_used_mib, Some(1024));
    }

    #[test]
    fn node_metrics_drop_custom_values_to_fit_the_chunk_budget() {
        let labels: std::collections::BTreeMap<String, String> = (0..16)
            .map(|index| (format!("label_{index:02}"), "x".repeat(128)))
            .collect();
        let custom = (0..256)
            .map(|index| crate::protocol::frames::CustomMetric {
                name: format!("metric_{index}"),
                labels: Some(labels.clone()),
                value: 1.0,
                ts: "2026-10-06T00:00:00.000Z".to_string(),
            })
            .collect();
        let mut frame = NodeFrame::NodeMetrics(crate::protocol::frames::NodeMetrics {
            ts: "2026-10-06T00:00:00.000Z".to_string(),
            cpu: None,
            memory: None,
            disks: None,
            gpus: None,
            interfaces: None,
            custom: Some(custom),
            metric_commands: None,
            abandoned_recovery: None,
        });
        let text = encode_telemetry(&mut frame).expect("fits once trimmed");
        assert!(text.len() <= crate::protocol::frames::CHUNK_BUDGET_BYTES);
        let NodeFrame::NodeMetrics(metrics) = &frame else {
            panic!("node.metrics");
        };
        let kept = metrics.custom.as_ref().map_or(0, Vec::len);
        assert!(kept > 0 && kept < 256, "{kept}");
        assert!(frame.validate().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn counter_store_filesystem_update_prune_and_idle_retries() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().expect("root");
        let path = root.path().join("counters.json");
        let mut store = super::CounterStore::default();
        let value = super::PersistedLoadCounters {
            counter_epoch: 7,
            ..Default::default()
        };
        store.update("keep", value.clone(), Some(&path));
        let inode = std::fs::metadata(&path).expect("file").ino();
        store.update("keep", value.clone(), Some(&path));
        assert_eq!(
            std::fs::metadata(&path).expect("file").ino(),
            inode,
            "unchanged frame must not replace file"
        );
        std::fs::remove_file(&path).expect("remove fixture");
        std::fs::create_dir(&path).expect("block replacement");
        store.update("remove", value.clone(), Some(&path));
        assert!(store.dirty);
        std::fs::remove_dir(&path).expect("unblock");
        store.update("remove", value.clone(), Some(&path));
        assert!(!store.dirty);
        assert!(super::read_load_counters_from(&path).contains_key("remove"));
        std::fs::remove_file(&path).expect("remove fixture");
        std::fs::create_dir(&path).expect("block prune");
        store.prune(|slug| slug == "keep", Some(&path));
        assert!(store.dirty);
        std::fs::remove_dir(&path).expect("unblock");
        store.flush(Some(&path));
        assert!(!store.dirty);
        let durable = super::read_load_counters_from(&path);
        assert!(durable.contains_key("keep"));
        assert!(!durable.contains_key("remove"));
    }
    use super::*;
    use crate::engine::LoadSource as EngineLoadSource;

    #[test]
    fn byte_counters_saturate_at_the_json_safe_integer() {
        assert_eq!(saturating_byte_counter(0), 0);
        assert_eq!(saturating_byte_counter(BYTE_COUNTER_MAX), BYTE_COUNTER_MAX);
        assert_eq!(saturating_byte_counter(u64::MAX), BYTE_COUNTER_MAX);
        // A 10 Gbit/s box passes MAX_SAFE_INTEGER in ~83 days; the frame must
        // stay parseable instead of being closed as malformed.
        assert_eq!(
            saturating_byte_counter(9_007_199_254_740_992),
            BYTE_COUNTER_MAX
        );
    }

    #[test]
    fn formats_rfc3339_utc() {
        assert_eq!(format_rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_rfc3339(1_790_000_000, 7), "2026-09-21T14:13:20.007Z");
        assert_eq!(format_rfc3339(951_782_400, 999), "2000-02-29T00:00:00.999Z");
    }

    #[test]
    fn nvidia_smi_rows_map_not_available_to_none() {
        let rows = parse_nvidia_smi(
            "0, NVIDIA GeForce RTX 4090, GPU-aaaa, 550.54.14, 24564, 1234, 17, 45, 61.25, 2520\n\
             1, NVIDIA GB10, GPU-bbbb, 580.82.07, [N/A], [N/A], 3, 40, [N/A], 2418\n\
             garbage line\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].memory_total_mib, Some(24_564));
        assert_eq!(rows[0].power_w, Some(61.25));
        assert_eq!(rows[1].memory_total_mib, None);
        assert!(rows[1].memory_not_applicable);
        assert!(!rows[0].memory_not_applicable);
        assert_eq!(rows[1].power_w, None);
        assert_eq!(rows[1].name.as_deref(), Some("NVIDIA GB10"));
    }

    #[test]
    fn proc_parsers_read_linux_formats() {
        let meminfo = parse_meminfo(
            "MemTotal:       131072000 kB\nMemAvailable:    65536000 kB\nSwapTotal: 0 kB\n",
        );
        assert_eq!(meminfo.get("MemTotal"), Some(&128_000));
        assert_eq!(meminfo.get("MemAvailable"), Some(&64_000));
        assert_eq!(
            parse_loadavg("0.50 1.25 2.00 1/234 5678"),
            Some((0.5, 1.25, 2.0))
        );
        assert_eq!(
            parse_proc_stat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n"),
            Some((150, 1000))
        );
        assert_eq!(
            parse_os_release("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\n"),
            (Some("Ubuntu".to_string()), Some("24.04".to_string()))
        );
        assert_eq!(
            parse_cpu_model("processor : 0\nmodel name\t: AMD Ryzen 9 7950X\n").as_deref(),
            Some("AMD Ryzen 9 7950X")
        );
    }

    fn reading(running: u64, hits: Option<f64>) -> LoadReading {
        LoadReading {
            running,
            waiting: Some(0),
            prefix_cache_hits_total: hits,
            source: EngineLoadSource::VllmMetrics,
            ..LoadReading::default()
        }
    }

    /// Plan a frame and, when one is due, commit it as queued.
    fn step(
        state: &mut LoadState,
        reading: LoadReading,
        at: Instant,
        ts: &str,
    ) -> Option<RuntimeLoad> {
        let frame = next_load_frame(state, "vllm", &reading, at, ts)?;
        state.commit("vllm", reading, at, frame.counter_epoch);
        Some(frame)
    }

    #[test]
    fn load_frames_go_out_on_change_or_refresh_with_counter_deltas() {
        let mut state = LoadState::default();
        let start = Instant::now();
        let first =
            step(&mut state, reading(1, Some(100.0)), start, "t0").expect("first reading is sent");
        assert_eq!(first.prefix_cache_hits_delta, None);
        assert!(
            step(
                &mut state,
                reading(1, Some(100.0)),
                start + Duration::from_secs(2),
                "t1"
            )
            .is_none(),
            "unchanged within the refresh interval"
        );
        let changed = step(
            &mut state,
            reading(2, Some(150.0)),
            start + Duration::from_secs(3),
            "t2",
        )
        .expect("a change is sent");
        assert_eq!(changed.prefix_cache_hits_delta, Some(50));
        let refreshed = step(
            &mut state,
            reading(2, Some(150.0)),
            start + Duration::from_secs(9),
            "t3",
        )
        .expect("refresh after the interval");
        assert_eq!(refreshed.prefix_cache_hits_delta, Some(0));
        let reset = step(
            &mut state,
            reading(0, Some(5.0)),
            start + Duration::from_secs(10),
            "t4",
        )
        .expect("a change is sent");
        assert_eq!(
            reset.prefix_cache_hits_delta,
            Some(5),
            "a counter reset reports counts since restart"
        );
        assert_eq!(first.counter_epoch, 0);
        assert_eq!(changed.counter_epoch, 0);
        assert_eq!(reset.counter_epoch, 1);
        assert_eq!(reset.prefix_cache_reset, Some(true));
    }

    fn reading_with_start(running: u64, hits: Option<f64>, start: Option<f64>) -> LoadReading {
        LoadReading {
            process_start_time_seconds: start,
            ..reading(running, hits)
        }
    }

    #[test]
    fn counter_epoch_bumps_when_the_engine_identity_changes() {
        let mut state = LoadState::default();
        let start = Instant::now();
        let first = step(
            &mut state,
            reading_with_start(1, Some(100.0), Some(1_700_000_000.0)),
            start,
            "t0",
        )
        .expect("first");
        assert_eq!(first.counter_epoch, 0);
        assert_eq!(first.prefix_cache_reset, None);
        let restarted = step(
            &mut state,
            reading_with_start(1, Some(100.0), Some(1_700_000_100.0)),
            start + Duration::from_secs(2),
            "t1",
        )
        .expect("identity change is sent");
        assert_eq!(restarted.counter_epoch, 1);
        assert_eq!(restarted.prefix_cache_reset, Some(true));
        let same = step(
            &mut state,
            reading_with_start(1, Some(100.0), Some(1_700_000_100.0)),
            start + Duration::from_secs(8),
            "t2",
        )
        .expect("refresh");
        assert_eq!(same.counter_epoch, 1);
    }

    #[test]
    fn corrupt_or_foreign_load_counters_fail_safe_and_are_replaced() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("load-counters.json");
        let valid_entry = r#"{"counter_epoch":4,"prefix_hits_total":1.0,"prefix_queries_total":2.0,"process_start_time_seconds":null}"#;
        let fixtures: [(&str, String); 7] = [
            ("garbage", "not json at all".to_string()),
            (
                "truncated",
                r#"{"version":1,"endpoints":{"vllm":"#.to_string(),
            ),
            ("empty", String::new()),
            (
                "future version",
                format!(r#"{{"version":2,"endpoints":{{"vllm":{valid_entry}}}}}"#),
            ),
            (
                "legacy version",
                format!(r#"{{"version":0,"endpoints":{{"vllm":{valid_entry}}}}}"#),
            ),
            (
                "missing version",
                format!(r#"{{"endpoints":{{"vllm":{valid_entry}}}}}"#),
            ),
            (
                "wrong entry shape",
                r#"{"version":1,"endpoints":{"vllm":{"counter_epoch":"four"}}}"#.to_string(),
            ),
        ];
        for (label, body) in fixtures {
            std::fs::write(&path, body).expect("write fixture");
            assert!(
                read_load_counters_from(&path).is_empty(),
                "{label}: unreadable counters must restore nothing"
            );
        }
        std::fs::write(&path, b"\xff\xfe\x00binary").expect("write binary fixture");
        assert!(read_load_counters_from(&path).is_empty());
        assert!(read_load_counters_from(&dir.path().join("missing.json")).is_empty());

        // A store that started from a corrupt file overwrites it with a valid
        // current-version document on the next accepted frame.
        let mut store = CounterStore::default();
        store.update(
            "vllm",
            PersistedLoadCounters {
                counter_epoch: 9,
                ..Default::default()
            },
            Some(&path),
        );
        assert!(!store.dirty);
        let restored = read_load_counters_from(&path);
        assert_eq!(
            restored.get("vllm").map(|value| value.counter_epoch),
            Some(9)
        );
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("valid json");
        assert_eq!(raw["version"], serde_json::json!(LOAD_COUNTERS_VERSION));
    }

    #[test]
    fn load_counter_state_round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("load-counters.json");
        let mut map = BTreeMap::new();
        map.insert(
            "vllm".to_string(),
            PersistedLoadCounters {
                counter_epoch: 4,
                prefix_hits_total: Some(12.0),
                prefix_queries_total: Some(20.0),
                process_start_time_seconds: Some(1_700_000_000.0),
            },
        );
        write_load_counters_to(&path, &map);
        let restored = read_load_counters_from(&path);
        assert_eq!(restored.get("vllm"), map.get("vllm"));
        let mut state = LoadState::default();
        state.commit(
            "memory-slug",
            reading_with_start(1, Some(9.0), Some(1_700_000_050.0)),
            Instant::now(),
            7,
        );
        let restored_memory = LoadState::restore("memory-slug");
        assert_eq!(restored_memory.counter_epoch, 7);
        assert_eq!(restored_memory.prefix_hits_total, Some(9.0));
        assert_eq!(
            restored_memory.process_start_time_seconds,
            Some(1_700_000_050.0)
        );
    }

    #[test]
    fn a_dropped_load_frame_keeps_its_prefix_cache_delta_for_the_next_one() {
        let mut state = LoadState::default();
        let start = Instant::now();
        step(&mut state, reading(1, Some(100.0)), start, "t0").expect("first");
        // 100 → 150 is planned but the queue is full: not committed.
        let dropped = next_load_frame(
            &state,
            "vllm",
            &reading(1, Some(150.0)),
            start + Duration::from_secs(2),
            "t1",
        )
        .expect("due");
        assert_eq!(dropped.prefix_cache_hits_delta, Some(50));
        // The next frame covers both intervals.
        let next = step(
            &mut state,
            reading(1, Some(170.0)),
            start + Duration::from_secs(4),
            "t2",
        )
        .expect("due");
        assert_eq!(next.prefix_cache_hits_delta, Some(70));
    }

    #[test]
    fn a_dropped_reset_still_reports_counts_since_restart_after_climb_back() {
        let mut state = LoadState::default();
        let start = Instant::now();
        step(&mut state, reading(1, Some(100.0)), start, "t0").expect("first");
        let dropped = next_load_frame(
            &state,
            "vllm",
            &reading(0, Some(5.0)),
            start + Duration::from_secs(2),
            "t1",
        )
        .expect("reset is due");
        assert_eq!(dropped.prefix_cache_reset, Some(true));
        assert_eq!(dropped.prefix_cache_hits_delta, Some(5));
        state.pending_reset = true;
        let climbed = step(
            &mut state,
            reading(1, Some(120.0)),
            start + Duration::from_secs(4),
            "t2",
        )
        .expect("climb-back after a dropped reset");
        assert_eq!(climbed.prefix_cache_reset, Some(true));
        assert_eq!(climbed.prefix_cache_hits_delta, Some(120));
        assert_eq!(climbed.counter_epoch, 1);
    }

    fn load_endpoint(slug: &str) -> EndpointConfig {
        EndpointConfig {
            slug: slug.to_string(),
            engine: crate::config::EndpointEngine::Vllm,
            ..EndpointConfig::default()
        }
    }

    fn load_slug(text: &str) -> String {
        let value: serde_json::Value = serde_json::from_str(text).expect("frame json");
        value["handle"].as_str().unwrap_or_default().to_string()
    }

    #[test]
    fn a_slow_endpoint_never_holds_back_another_endpoints_load_frame() {
        // Every worker slot but one is taken by an endpoint that answers in
        // 1.2 s. The fast endpoint's frame must go out as soon as its own
        // scrape finishes, not after the slow batch.
        let mut endpoints = (0..LOAD_SCRAPE_CONCURRENCY - 1)
            .map(|index| load_endpoint(&format!("a-slow-{index:02}")))
            .collect::<Vec<_>>();
        endpoints.push(load_endpoint("z-fast"));
        let shared = Arc::new(Mutex::new(Shared {
            endpoints,
            ..Shared::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel(256);
        let started = Instant::now();
        let thread_stop = Arc::clone(&stop);
        let thread_shared = Arc::clone(&shared);
        let scheduler = thread::spawn(move || {
            run_loads(&tx, &thread_stop, &thread_shared, |endpoint, _| {
                if endpoint.slug.starts_with("a-slow") {
                    thread::sleep(Duration::from_millis(1_200));
                }
                Some(LoadReading {
                    running: 1,
                    source: EngineLoadSource::VllmMetrics,
                    ..LoadReading::default()
                })
            });
        });
        let mut fast_at = None;
        let mut first_slow_at = None;
        while started.elapsed() < Duration::from_secs(5)
            && (fast_at.is_none() || first_slow_at.is_none())
        {
            let Ok(FromWorker::Telemetry(text)) = rx.recv_timeout(Duration::from_secs(5)) else {
                break;
            };
            let slug = load_slug(&text);
            if slug == "z-fast" {
                fast_at.get_or_insert(started.elapsed());
            } else {
                first_slow_at.get_or_insert(started.elapsed());
            }
        }
        stop.store(true, Ordering::SeqCst);
        scheduler.join().expect("scheduler");
        let fast_at = fast_at.expect("the fast endpoint reported");
        let first_slow_at = first_slow_at.expect("a slow endpoint reported");
        assert!(
            fast_at < Duration::from_millis(900),
            "fast endpoint waited {fast_at:?}"
        );
        assert!(fast_at < first_slow_at, "{fast_at:?} vs {first_slow_at:?}");
    }

    #[test]
    fn load_scrapes_never_exceed_the_worker_budget() {
        let endpoints = (0..LOAD_SCRAPE_CONCURRENCY * 2)
            .map(|index| load_endpoint(&format!("e-{index:02}")))
            .collect::<Vec<_>>();
        let shared = Arc::new(Mutex::new(Shared {
            endpoints,
            ..Shared::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel(256);
        let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (thread_stop, thread_shared) = (Arc::clone(&stop), Arc::clone(&shared));
        let (worker_live, worker_peak) = (Arc::clone(&live), Arc::clone(&peak));
        let scheduler = thread::spawn(move || {
            run_loads(&tx, &thread_stop, &thread_shared, move |_, _| {
                let now = worker_live.fetch_add(1, Ordering::SeqCst) + 1;
                worker_peak.fetch_max(now, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(300));
                worker_live.fetch_sub(1, Ordering::SeqCst);
                None
            });
        });
        thread::sleep(Duration::from_millis(1_000));
        stop.store(true, Ordering::SeqCst);
        scheduler.join().expect("scheduler");
        drop(rx);
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak <= LOAD_SCRAPE_CONCURRENCY, "peak {peak}");
        assert!(
            peak >= LOAD_SCRAPE_CONCURRENCY / 2,
            "workers ran in parallel: {peak}"
        );
    }

    #[test]
    fn a_result_for_a_changed_endpoint_configuration_is_discarded() {
        let shared = Arc::new(Mutex::new(Shared {
            endpoints: vec![load_endpoint("vllm")],
            ..Shared::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel(256);
        let (thread_stop, thread_shared) = (Arc::clone(&stop), Arc::clone(&shared));
        let scheduler = thread::spawn(move || {
            run_loads(&tx, &thread_stop, &thread_shared, |endpoint, _| {
                // The old configuration's scrape is slow and reports 7.
                let running = if endpoint.base_url.is_empty() {
                    thread::sleep(Duration::from_millis(600));
                    7
                } else {
                    1
                };
                Some(LoadReading {
                    running,
                    source: EngineLoadSource::VllmMetrics,
                    ..LoadReading::default()
                })
            });
        });
        thread::sleep(Duration::from_millis(150));
        {
            let mut shared = shared.lock().expect("shared");
            shared.endpoints[0].base_url = "http://changed".to_string();
            shared.endpoints_generation += 1;
        }
        thread::sleep(Duration::from_millis(1_000));
        stop.store(true, Ordering::SeqCst);
        scheduler.join().expect("scheduler");
        let frames = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|message| match message {
                FromWorker::Telemetry(text) => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(!frames.is_empty(), "the new configuration reported");
        assert!(
            frames.iter().all(|text| !text.contains(r#""running":7"#)),
            "{frames:?}"
        );
    }

    /// Run the scheduler over one vLLM endpoint whose sampler returns the
    /// given readings in order (repeating the last), collecting frames.
    fn run_scheduler_for(
        endpoints: Vec<EndpointConfig>,
        tx: SyncSender<FromWorker>,
        sample: impl Fn(&EndpointConfig, &EngineKind) -> Option<LoadReading> + Clone + Send + 'static,
    ) -> (Arc<AtomicBool>, Arc<Mutex<Shared>>, thread::JoinHandle<()>) {
        let shared = Arc::new(Mutex::new(Shared {
            endpoints,
            ..Shared::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_stop, thread_shared) = (Arc::clone(&stop), Arc::clone(&shared));
        let handle = thread::spawn(move || run_loads(&tx, &thread_stop, &thread_shared, sample));
        (stop, shared, handle)
    }

    #[test]
    fn the_scheduler_folds_a_dropped_frames_prefix_delta_into_the_next_frame() {
        // Queue of one: the first frame fills it, the second is dropped
        // (queue full), the test then drains, and the third frame's delta
        // must cover both intervals (100 → 170), not only the last (150 → 170).
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sampler_calls = Arc::clone(&calls);
        let (tx, rx) = mpsc::sync_channel(1);
        let (stop, _shared, handle) =
            run_scheduler_for(vec![load_endpoint("vllm")], tx, move |_, _| {
                let call = sampler_calls.fetch_add(1, Ordering::SeqCst);
                let hits = [100.0, 150.0, 170.0][call.min(2)];
                Some(reading(1, Some(hits)))
            });
        let text = |message: FromWorker| match message {
            FromWorker::Telemetry(text) => text,
            _ => String::new(),
        };
        // The first frame sits in the queue until the second scrape was
        // offered and dropped.
        let started = Instant::now();
        while calls.load(Ordering::SeqCst) < 2 && started.elapsed() < Duration::from_secs(6) {
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(300));
        let first = text(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("first frame"),
        );
        assert!(!first.contains("prefixCacheHitsDelta"), "{first}");
        let third = text(
            rx.recv_timeout(Duration::from_secs(6))
                .expect("third frame"),
        );
        stop.store(true, Ordering::SeqCst);
        drop(rx);
        handle.join().expect("scheduler");
        assert!(third.contains(r#""prefixCacheHitsDelta":70"#), "{third}");
    }

    #[test]
    fn a_result_for_a_removed_then_re_added_endpoint_is_discarded() {
        // The same endpoint, identical config, is removed and re-added while
        // its first (slow) scrape is in flight: that stale result belongs to
        // the old schedule and must not be sent or clear the new one's flag.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sampler_calls = Arc::clone(&calls);
        let (tx, rx) = mpsc::sync_channel(256);
        let (stop, shared, handle) =
            run_scheduler_for(vec![load_endpoint("vllm")], tx, move |_, _| {
                if sampler_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    thread::sleep(Duration::from_millis(700));
                    return Some(reading(7, None));
                }
                Some(reading(1, None))
            });
        let set = |endpoints: Vec<EndpointConfig>| {
            let mut shared = shared.lock().expect("shared");
            shared.endpoints = endpoints;
            shared.endpoints_generation += 1;
        };
        thread::sleep(Duration::from_millis(100));
        set(Vec::new());
        thread::sleep(Duration::from_millis(300));
        set(vec![load_endpoint("vllm")]);
        thread::sleep(Duration::from_millis(1_200));
        stop.store(true, Ordering::SeqCst);
        handle.join().expect("scheduler");
        let frames = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|message| match message {
                FromWorker::Telemetry(text) => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(!frames.is_empty(), "the re-added schedule reported");
        assert!(
            frames.iter().all(|text| !text.contains(r#""running":7"#)),
            "{frames:?}"
        );
    }

    #[test]
    fn metric_names_match_the_wire_charset() {
        assert!(is_metric_name("a.b:c-d_1"));
        assert!(!is_metric_name(""));
        assert!(!is_metric_name("bad name"));
        assert!(!is_metric_name(&"x".repeat(65)));
    }

    #[test]
    fn label_keys_reject_the_reserved_names_and_keep_similar_names() {
        assert!(!is_label_key("__proto__"));
        for key in [
            "proto",
            "_proto__",
            "__proto",
            "__proto__x",
            "constructor",
            "gpu",
        ] {
            assert!(is_label_key(key), "{key}");
        }
        assert!(!is_label_key(""));
        assert!(!is_label_key("bad key"));
        // As a metric name or a label value it stays legal.
        assert!(is_metric_name("__proto__"));
    }

    #[test]
    fn load_targets_follow_declared_or_detected_engines() {
        let mut vllm = EndpointConfig {
            slug: "vllm".to_string(),
            engine: crate::config::EndpointEngine::Vllm,
            ..EndpointConfig::default()
        };
        let auto = EndpointConfig {
            slug: "auto".to_string(),
            ..EndpointConfig::default()
        };
        let ollama = EndpointConfig {
            slug: "ollama".to_string(),
            engine: crate::config::EndpointEngine::Ollama,
            ..EndpointConfig::default()
        };
        let mut detected = auto.clone();
        detected.slug = "detected".to_string();
        detected.last_probe = Some(crate::config::ProbeSnapshot {
            status: crate::config::ProbeStatus::Online,
            models: Vec::new(),
            suggested_capabilities: crate::config::OpenAiCompatibleCapabilities::default(),
            engine: Some(crate::engine::DetectedEngine {
                kind: Some(EngineKind::LlamaCpp),
                ..crate::engine::DetectedEngine::default()
            }),
        });
        let targets = load_targets(&[vllm.clone(), auto, ollama, detected]);
        let slugs = targets
            .iter()
            .map(|(endpoint, kind)| (endpoint.slug.as_str(), *kind))
            .collect::<Vec<_>>();
        assert_eq!(
            slugs,
            [
                ("vllm", EngineKind::Vllm),
                ("detected", EngineKind::LlamaCpp)
            ]
        );
        vllm.enabled = false;
        assert!(load_targets(&[vllm]).is_empty());
    }

    #[test]
    fn linger_and_user_manager_states_are_read_from_stdout() {
        assert!(user_manager_live("degraded\n"));
        assert!(!user_manager_live("offline"));
        assert!(linger_enabled("UID=1000\nLinger=yes\n"));
        assert!(!linger_enabled("Linger=no"));
    }
}
