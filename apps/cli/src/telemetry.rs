//! Relay 2.7 telemetry: `node.info`, `node.metrics` and `endpoint.load`.
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
//! Custom metric sources ([`crate::metric_sources`]) run on their own
//! short-lived threads; this thread only schedules them and reports their
//! latest values in `node.metrics.custom`.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config::EndpointConfig;
use crate::engine::{EngineKind, LoadReading};
use crate::metric_sources::{Runner, RunnerSettings};
use crate::protocol::{
    ClientControlMessage, EndpointLoad, ExecutionMechanism, MetricSourceOrigin, MetricSourceState,
    MetricSourceStatus, NODE_GPU_MAX, NODE_INTERFACE_MAX, NODE_METRICS_SOURCES_MAX, NodeCpu,
    NodeCpuMetrics, NodeDiskMetrics, NodeGpuInfo, NodeGpuMetrics, NodeInfo, NodeInterfaceInfo,
    NodeInterfaceMetrics, NodeKind, NodeMemoryMetrics, NodeMetrics, NodeOs, RemoteMetricSource,
    encode_control,
};
use crate::relay_bus::FromWorker;

/// Built-in `node.metrics` cadence (the protocol allows 20–30 s).
pub const NODE_METRICS_INTERVAL: Duration = Duration::from_secs(20);
/// The server drops `node.metrics` frames closer together than this.
pub const NODE_METRICS_MIN_GAP: Duration = Duration::from_secs(5);
/// `endpoint.load` sampling cadence.
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
/// A metric source's interval bounds (`intervalSecs` on both wire directions).
pub const METRIC_SOURCE_INTERVAL_MIN_SECS: u32 = 5;
pub const METRIC_SOURCE_INTERVAL_MAX_SECS: u32 = 86_400;

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
    /// A `metrics.sources.set` list the thread has not applied yet.
    remote_sources: Option<Vec<RemoteMetricSource>>,
}

impl Telemetry {
    /// Start sampling after `hello.ok`. `node.info` is the first frame.
    pub(crate) fn start(
        tx: SyncSender<FromWorker>,
        endpoints: &[EndpointConfig],
        sources: RunnerSettings,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Shared {
            endpoints: endpoints.to_vec(),
            ..Shared::default()
        }));
        let thread_stop = Arc::clone(&stop);
        let thread_shared = Arc::clone(&shared);
        let spawned = thread::Builder::new()
            .name("wsmp-telemetry".to_string())
            .spawn(move || run(tx, thread_stop, thread_shared, sources));
        if let Err(error) = spawned {
            tracing::warn!(error = %error, "starting the telemetry thread failed; node metrics are off");
        }
        Self { stop, shared }
    }

    /// Replace the endpoints whose load is sampled (after an acknowledged reload).
    pub fn set_endpoints(&self, endpoints: &[EndpointConfig]) {
        if let Ok(mut shared) = self.shared.lock()
            && shared.endpoints != endpoints
        {
            shared.endpoints = endpoints.to_vec();
            shared.endpoints_generation = shared.endpoints_generation.wrapping_add(1);
        }
    }

    /// `metrics.sources.set`: replace the remote definitions. They run only
    /// with the local opt-in and an approval of each exact command. More than
    /// [`NODE_METRICS_SOURCES_MAX`] entries are dropped so a hostile or buggy
    /// server cannot grow the status list past the server's own schema bound.
    pub fn set_remote_sources(&self, sources: Vec<RemoteMetricSource>) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.remote_sources = Some(bounded_remote_sources(&sources));
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
fn offer(tx: &SyncSender<FromWorker>, mut message: ClientControlMessage) -> Sent {
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
pub fn encode_telemetry(message: &mut ClientControlMessage) -> Option<String> {
    crate::telemetry_bounds::conform(message);
    match encode_control(message) {
        Ok(text) => Some(text),
        Err(error) => {
            tracing::warn!(error = %error, "encoding a telemetry frame failed; dropped");
            None
        }
    }
}

fn run(
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    sources: RunnerSettings,
) {
    let mut runner = Runner::new(sources);
    let mut gpu = GpuQuery::default();
    let info = collect_node_info(&mut gpu);
    if offer(&tx, ClientControlMessage::NodeInfo(info)) == Sent::Gone {
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
                crate::engine::sample_load(&agent, endpoint, kind)
            });
        });
    if let Err(error) = spawned {
        tracing::warn!(error = %error, "starting the load sampler failed; endpoint load is off");
    }
    let mut cpu = CpuSampler::default();
    // Prime the CPU counters so the first metrics frame has a usage figure.
    cpu.sample();
    let mut last_metrics: Option<Instant> = None;
    let mut sources_changed = false;
    let mut next_metrics = Instant::now() + Duration::from_secs(2);
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        if let Some(remote) = shared
            .lock()
            .ok()
            .and_then(|mut shared| shared.remote_sources.take())
        {
            runner.set_remote(remote);
        }
        runner.tick(now);
        // A finished source run or a changed source state goes out as soon
        // as the minimum gap allows.
        sources_changed |= runner.take_changed();
        let gap_ok = last_metrics.is_none_or(|at| now.duration_since(at) >= NODE_METRICS_MIN_GAP);
        if gap_ok && (now >= next_metrics || sources_changed) {
            sources_changed = false;
            let metrics = collect_node_metrics(&mut cpu, &mut gpu, &runner);
            if offer(&tx, ClientControlMessage::NodeMetrics(metrics)) == Sent::Gone {
                return;
            }
            last_metrics = Some(Instant::now());
            next_metrics = Instant::now() + NODE_METRICS_INTERVAL;
        }
        thread::sleep(STOP_POLL);
    }
}

#[derive(Default)]
struct LoadState {
    last_sent: Option<(Instant, LoadReading)>,
    prefix_hits_total: Option<f64>,
    prefix_queries_total: Option<f64>,
}

impl LoadState {
    /// Record a frame the relay loop accepted. A dropped frame is not
    /// committed, so its prefix-cache deltas fold into the next one.
    fn commit(&mut self, reading: LoadReading, at: Instant) {
        self.prefix_hits_total = reading.prefix_cache_hits_total;
        self.prefix_queries_total = reading.prefix_cache_queries_total;
        self.last_sent = Some((at, reading));
    }
}

/// Endpoints with a scrapeable engine, paired with their kind.
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
    F: Fn(&EndpointConfig, EngineKind) -> Option<LoadReading> + Clone + Send + 'static,
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
            for target in targets {
                let slug = target.0.slug.clone();
                let replace = schedules
                    .get(&slug)
                    .is_none_or(|schedule| schedule.target != target);
                if replace {
                    next_epoch += 1;
                    schedules.insert(
                        slug,
                        LoadSchedule {
                            epoch: next_epoch,
                            target,
                            state: LoadState::default(),
                            next_due: Instant::now(),
                            in_flight: false,
                        },
                    );
                }
            }
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
                    let reading = sample(&target.0, target.1);
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
                schedule.next_due = now + LOAD_SAMPLE_INTERVAL;
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
            schedule.next_due = done.finished + LOAD_SAMPLE_INTERVAL;
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
            match offer(tx, ClientControlMessage::EndpointLoad(frame)) {
                Sent::Queued => schedule.state.commit(reading, done.finished),
                Sent::Dropped => {}
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

/// Decide whether a reading goes out: on change, or every
/// `LOAD_REFRESH_INTERVAL` when unchanged. Prefix-cache counters become
/// deltas against the last frame the relay loop accepted. The caller commits
/// the reading ([`LoadState::commit`]) only once the frame was queued.
fn next_load_frame(
    state: &LoadState,
    endpoint_slug: &str,
    reading: &LoadReading,
    now: Instant,
    ts: &str,
) -> Option<EndpointLoad> {
    let hits_delta = counter_delta(state.prefix_hits_total, reading.prefix_cache_hits_total);
    let queries_delta = counter_delta(
        state.prefix_queries_total,
        reading.prefix_cache_queries_total,
    );
    let changed_counters =
        hits_delta.is_some_and(|delta| delta > 0) || queries_delta.is_some_and(|delta| delta > 0);
    let due = match &state.last_sent {
        None => true,
        Some((at, last)) => {
            now.duration_since(*at) >= LOAD_REFRESH_INTERVAL
                || changed_counters
                || !same_load(last, reading)
        }
    };
    if !due {
        return None;
    }
    Some(EndpointLoad {
        endpoint_slug: endpoint_slug.to_string(),
        model_slug: None,
        running: reading.running,
        waiting: reading.waiting,
        kv_usage: reading.kv_usage,
        slots_busy: reading.slots_busy,
        deferred: reading.deferred,
        prefix_cache_hits_delta: hits_delta,
        prefix_cache_queries_delta: queries_delta,
        source: reading.source,
        ts: ts.to_string(),
    })
}

fn same_load(left: &LoadReading, right: &LoadReading) -> bool {
    left.running == right.running
        && left.waiting == right.waiting
        && left.slots_busy == right.slots_busy
        && left.deferred == right.deferred
        && match (left.kv_usage, right.kv_usage) {
            (Some(a), Some(b)) => (a - b).abs() < 0.01,
            (None, None) => true,
            _ => false,
        }
}

/// Cap a remotely defined source list at the server's schema bound. Invalid
/// names are dropped first (as the source runner does), so they
/// cannot use up slots that valid sources after them need.
fn bounded_remote_sources(sources: &[RemoteMetricSource]) -> Vec<RemoteMetricSource> {
    sources
        .iter()
        .filter(|source| is_metric_name(&source.name))
        .take(NODE_METRICS_SOURCES_MAX)
        .cloned()
        .collect()
}

/// `[A-Za-z0-9_.:-]{1,64}`: the only metric and label text on the wire.
pub fn is_metric_name(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

/// UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn now_rfc3339() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
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
            Bounded::Output(output) => parse_nvidia_smi(&output),
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

/// Run a program with a scrubbed environment, no stdin, stderr discarded,
/// stdout capped at `limit` (more is a failure), killed after `timeout`.
///
/// The output is complete when stdout closes (every process holding the pipe
/// exited or closed it). The run then waits, until the same deadline, for
/// the program itself to exit: many tools close stdout just before they exit
/// (coreutils' `close_stdout`), so stdout closing does not mean the program
/// is done. Only then, on every path, is whatever is left of the child's
/// process group killed, before the child is reaped where the platform
/// allows it (see [`finish`]). A helper the tool left behind (forked into
/// the background, or holding the pipe after the tool exited) never outlives
/// the call. Success is exactly: stdout closed, the program exited 0 before
/// the deadline, and at most `limit` bytes of UTF-8. The state table is in
/// `tests/telemetry_bounded.rs`.
pub fn run_bounded(program: &str, args: &[String], timeout: Duration, limit: u64) -> Bounded {
    let deadline = Instant::now() + timeout;
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(crate::child_env::scrub_parent_env(&[]))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let Ok(mut child) = command.spawn() else {
        return Bounded::Unavailable;
    };
    let Some(stdout) = child.stdout.take() else {
        finish(&mut child, Instant::now());
        return Bounded::Failed;
    };
    let (done_tx, done_rx) = mpsc::channel();
    // The reader owns the pipe so a full pipe cannot stall the child; the
    // result arrives on a channel so a leaked pipe never blocks this thread.
    // It reads one byte past the limit to tell "exactly the limit" from "more".
    let _reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout
            .take(limit.saturating_add(1))
            .read_to_end(&mut buffer);
        let _ = done_tx.send(buffer);
    });
    let output = done_rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok();
    // Over the limit: the output is refused anyway, so do not wait for exit.
    let wait_until = match &output {
        Some(buffer) if buffer.len() as u64 <= limit => deadline,
        _ => Instant::now(),
    };
    let status = finish(&mut child, wait_until);
    let Some(buffer) = output else {
        return Bounded::Failed;
    };
    if buffer.len() as u64 > limit || !status.is_some_and(|status| status.success()) {
        return Bounded::Failed;
    }
    String::from_utf8(buffer).map_or(Bounded::Failed, Bounded::Output)
}

/// The one exit path of [`run_bounded`] after spawn: wait until `until` for
/// the child to exit (without reaping it where possible), kill every process
/// left in its group, then reap it and return its status. A child still
/// running at `until` is killed with its group.
///
/// On Linux the wait uses `waitid(WNOWAIT)`, so the child stays a zombie and
/// its pid (the group id) cannot be recycled before the group kill. Other
/// Unix targets reap first: POSIX does not reuse a pid while a process group
/// with that id has members, so a surviving helper keeps the id safe; with no
/// helper left the kill can only miss (a recycled pid would also have to have
/// become a group leader in the microseconds between).
#[cfg(unix)]
fn finish(child: &mut std::process::Child, until: Instant) -> Option<std::process::ExitStatus> {
    wait_for_exit(child, until);
    if let Ok(raw) = i32::try_from(child.id())
        && raw > 1
    {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(raw),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    // A child that already exited keeps the status it exited with; SIGKILL
    // cannot change it. std caches a status `try_wait` already reaped.
    child.wait().ok()
}

/// Poll until the child has exited or `until` passes, leaving it unreaped.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn wait_for_exit(child: &mut std::process::Child, until: Instant) {
    use nix::sys::wait::{Id, WaitPidFlag, WaitStatus, waitid};
    let Ok(raw) = i32::try_from(child.id()) else {
        return;
    };
    let flags = WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT;
    loop {
        match waitid(Id::Pid(nix::unistd::Pid::from_raw(raw)), flags) {
            Ok(WaitStatus::StillAlive) if Instant::now() < until => {
                thread::sleep(Duration::from_millis(5));
            }
            _ => return,
        }
    }
}

/// Poll until the child has exited or `until` passes (reaps; see [`finish`]).
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
fn wait_for_exit(child: &mut std::process::Child, until: Instant) {
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < until {
        thread::sleep(Duration::from_millis(5));
    }
}

/// Wait until `until`, then kill the child if still running (no process
/// groups off Unix), and reap it.
#[cfg(not(unix))]
fn finish(child: &mut std::process::Child, until: Instant) -> Option<std::process::ExitStatus> {
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < until {
        thread::sleep(Duration::from_millis(5));
    }
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
    child.wait().ok()
}

fn node_kind(gpus: &[GpuRow]) -> (NodeKind, bool) {
    if gpus.is_empty() {
        // Apple silicon shares memory between CPU and GPU.
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return (NodeKind::Unified, true);
        }
        return (NodeKind::Cpu, false);
    }
    // GB10 and other unified-memory GPUs report no dedicated VRAM total.
    if gpus.iter().any(|gpu| gpu.memory_total_mib.is_none()) {
        (NodeKind::Unified, true)
    } else {
        (NodeKind::Discrete, false)
    }
}

fn execution_mechanism() -> ExecutionMechanism {
    let exists = |path: &str| std::path::Path::new(path).exists();
    if exists("/.dockerenv") || exists("/run/.containerenv") {
        return ExecutionMechanism::Container;
    }
    if std::env::var_os("INVOCATION_ID").is_some() {
        return ExecutionMechanism::Systemd;
    }
    if cfg!(target_os = "macos")
        && std::env::var_os("XPC_SERVICE_NAME").is_some_and(|name| name != "0")
    {
        return ExecutionMechanism::Launchd;
    }
    ExecutionMechanism::Foreground
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

/// `/proc/cpuinfo` model name (x86 `model name`, Arm `Model` or `Hardware`).
pub fn parse_cpu_model(text: &str) -> Option<String> {
    ["model name", "Model", "Hardware", "cpu model"]
        .iter()
        .find_map(|key| {
            text.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                (name.trim() == *key).then(|| clip(value)).flatten()
            })
        })
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
fn interface_addresses() -> BTreeMap<String, Vec<String>> {
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
fn interface_addresses() -> BTreeMap<String, Vec<String>> {
    BTreeMap::new()
}

fn collect_node_info(gpu: &mut GpuQuery) -> NodeInfo {
    let gpus = gpu.rows();
    let (kind, unified) = node_kind(&gpus);
    let (os_name, os_version) = read_text("/etc/os-release")
        .map(|text| parse_os_release(&text))
        .unwrap_or((None, None));
    let addresses = interface_addresses();
    let interfaces = interface_names()
        .into_iter()
        .map(|name| NodeInterfaceInfo {
            addresses: addresses.get(&name).cloned().unwrap_or_default(),
            // `speed` is -1 (or unreadable) for links without one.
            link_speed_mbps: sys_net_number(&name, "speed").filter(|speed| *speed > 0),
            mtu: sys_net_number(&name, "mtu").and_then(|mtu| u32::try_from(mtu).ok()),
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
            model: read_text("/proc/cpuinfo").and_then(|text| parse_cpu_model(&text)),
            cores: thread::available_parallelism()
                .ok()
                .and_then(|count| u32::try_from(count.get()).ok()),
        }),
        memory_total_mib: read_text("/proc/meminfo")
            .map(|text| parse_meminfo(&text))
            .and_then(|fields| fields.get("MemTotal").copied()),
        gpus: gpus
            .iter()
            .map(|row| NodeGpuInfo {
                index: row.index,
                name: row.name.clone(),
                uuid: row.uuid.clone(),
                driver_version: row.driver_version.clone(),
                vram_total_mib: row.memory_total_mib,
            })
            .collect(),
        unified_memory: Some(unified),
        node_kind: Some(kind),
        interfaces,
        execution_mechanism: Some(execution_mechanism()),
        cli_version: Some(env!("CARGO_PKG_VERSION").to_string()),
    }
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

fn collect_node_metrics(cpu: &mut CpuSampler, gpu: &mut GpuQuery, sources: &Runner) -> NodeMetrics {
    let (custom, sources) = sources.report(Instant::now());
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
        disks: root_disk().into_iter().collect(),
        gpus: gpu
            .rows()
            .into_iter()
            .map(|row| NodeGpuMetrics {
                index: row.index,
                vram_used_mib: row.memory_used_mib,
                vram_total_mib: row.memory_total_mib,
                utilization_percent: row.utilization_percent,
                temperature_c: row.temperature_c,
                power_w: row.power_w,
                sm_clock_mhz: row.sm_clock_mhz,
            })
            .collect(),
        interfaces,
        custom,
        sources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::LoadSource;

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
        assert_eq!(rows[1].power_w, None);
        assert_eq!(rows[1].name.as_deref(), Some("NVIDIA GB10"));
        assert_eq!(node_kind(&rows).0, NodeKind::Unified);
        assert_eq!(node_kind(&rows[..1]).0, NodeKind::Discrete);
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
            waiting: 0,
            prefix_cache_hits_total: hits,
            source: LoadSource::VllmMetrics,
            ..LoadReading::default()
        }
    }

    /// Plan a frame and, when one is due, commit it as queued.
    fn step(
        state: &mut LoadState,
        reading: LoadReading,
        at: Instant,
        ts: &str,
    ) -> Option<EndpointLoad> {
        let frame = next_load_frame(state, "vllm", &reading, at, ts)?;
        state.commit(reading, at);
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
            reset.prefix_cache_hits_delta, None,
            "a counter reset is not a delta"
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

    fn load_endpoint(slug: &str) -> EndpointConfig {
        EndpointConfig {
            slug: slug.to_string(),
            engine: crate::config::EndpointEngine::Vllm,
            ..EndpointConfig::default()
        }
    }

    fn load_slug(text: &str) -> String {
        let value: serde_json::Value = serde_json::from_str(text).expect("frame json");
        value["endpointSlug"]
            .as_str()
            .unwrap_or_default()
            .to_string()
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
                    source: LoadSource::VllmMetrics,
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
                    source: LoadSource::VllmMetrics,
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

    #[test]
    fn remote_sources_are_capped_at_the_schema_bound() {
        // A server may not send more than NODE_METRICS_SOURCES_MAX; a buggy or
        // hostile one must not grow the CLI's stored list (or the reported
        // statuses) past the same bound.
        let source = |index: usize| RemoteMetricSource {
            name: format!("m{index}"),
            command: "echo 1".to_string(),
            interval_secs: 10,
            timeout_secs: 5,
            format: MetricSourceFormat::Number,
        };
        let many = (0..NODE_METRICS_SOURCES_MAX + 10)
            .map(source)
            .collect::<Vec<_>>();
        assert_eq!(
            bounded_remote_sources(&many).len(),
            NODE_METRICS_SOURCES_MAX
        );
        assert_eq!(bounded_remote_sources(&many[..2]).len(), 2);
    }

    /// Run the scheduler over one vLLM endpoint whose sampler returns the
    /// given readings in order (repeating the last), collecting frames.
    fn run_scheduler_for(
        endpoints: Vec<EndpointConfig>,
        tx: SyncSender<FromWorker>,
        sample: impl Fn(&EndpointConfig, EngineKind) -> Option<LoadReading> + Clone + Send + 'static,
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
}
