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

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::config::EndpointConfig;
use crate::engine::{EngineKind, LoadReading};
use crate::protocol::{
    ClientControlMessage, EndpointLoad, ExecutionMechanism, MetricSourceOrigin, MetricSourceState,
    MetricSourceStatus, NODE_GPU_MAX, NODE_INTERFACE_ADDRESS_MAX, NODE_INTERFACE_MAX,
    NODE_METRICS_SOURCES_MAX, NodeCpu, NodeCpuMetrics, NodeDiskMetrics, NodeGpuInfo,
    NodeGpuMetrics, NodeInfo, NodeInterfaceInfo, NodeInterfaceMetrics, NodeKind, NodeMemoryMetrics,
    NodeMetrics, NodeOs, RemoteMetricSource, encode_control,
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
const LOAD_SCRAPE_CONCURRENCY: usize = 8;
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
    remote_sources: Vec<RemoteMetricSource>,
    /// Set when `metrics.sources.set` arrived; the next metrics frame goes
    /// out as soon as the minimum gap allows.
    sources_changed: bool,
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

    /// Replace the endpoints whose load is sampled (after an acknowledged reload).
    pub fn set_endpoints(&self, endpoints: &[EndpointConfig]) {
        if let Ok(mut shared) = self.shared.lock()
            && shared.endpoints != endpoints
        {
            shared.endpoints = endpoints.to_vec();
        }
    }

    /// `metrics.sources.set`: remember the remote definitions. This CLI does
    /// not run remote sources; each is reported as `unsupported`. More than
    /// [`NODE_METRICS_SOURCES_MAX`] entries are dropped so a hostile or buggy
    /// server cannot grow the status list past the server's own schema bound.
    pub fn set_remote_sources(&self, sources: Vec<RemoteMetricSource>) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.remote_sources = bounded_remote_sources(&sources);
            shared.sources_changed = true;
        }
    }
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Hand one frame to the relay loop without waiting. `false` once the
/// session is gone.
fn offer(tx: &SyncSender<FromWorker>, message: &ClientControlMessage) -> bool {
    let text = match encode_control(message) {
        Ok(text) => text,
        Err(error) => {
            tracing::warn!(error = %error, "encoding a telemetry frame failed; dropped");
            return true;
        }
    };
    match tx.try_send(FromWorker::Telemetry(text)) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            tracing::debug!("relay outbound queue full; telemetry frame dropped");
            true
        }
        Err(TrySendError::Disconnected(_)) => false,
    }
}

fn run(tx: SyncSender<FromWorker>, stop: Arc<AtomicBool>, shared: Arc<Mutex<Shared>>) {
    let mut gpu = GpuQuery::default();
    let info = collect_node_info(&mut gpu);
    if !offer(&tx, &ClientControlMessage::NodeInfo(info)) {
        return;
    }
    let mut cpu = CpuSampler::default();
    // Prime the CPU counters so the first metrics frame has a usage figure.
    cpu.sample();
    let mut load_state = BTreeMap::<String, LoadState>::new();
    let mut last_metrics: Option<Instant> = None;
    let mut next_metrics = Instant::now() + Duration::from_secs(2);
    let mut next_load = Instant::now();
    let agent = crate::engine::http_agent(crate::engine::LOAD_TIMEOUT);
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        let sources_changed = shared
            .lock()
            .map(|shared| shared.sources_changed)
            .unwrap_or(false);
        let gap_ok = last_metrics.is_none_or(|at| now.duration_since(at) >= NODE_METRICS_MIN_GAP);
        if gap_ok && (now >= next_metrics || sources_changed) {
            let remote = match shared.lock() {
                Ok(mut shared) => {
                    shared.sources_changed = false;
                    shared.remote_sources.clone()
                }
                Err(_) => Vec::new(),
            };
            let metrics = collect_node_metrics(&mut cpu, &mut gpu, &remote);
            if !offer(&tx, &ClientControlMessage::NodeMetrics(metrics)) {
                return;
            }
            last_metrics = Some(Instant::now());
            next_metrics = Instant::now() + NODE_METRICS_INTERVAL;
        }
        if now >= next_load {
            let endpoints = shared
                .lock()
                .map(|shared| shared.endpoints.clone())
                .unwrap_or_default();
            for load in sample_loads(&agent, &endpoints, &mut load_state, &stop) {
                if !offer(&tx, &ClientControlMessage::EndpointLoad(load)) {
                    return;
                }
            }
            next_load = Instant::now() + LOAD_SAMPLE_INTERVAL;
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

fn sample_loads(
    agent: &ureq::Agent,
    endpoints: &[EndpointConfig],
    state: &mut BTreeMap<String, LoadState>,
    stop: &AtomicBool,
) -> Vec<EndpointLoad> {
    let targets = load_targets(endpoints);
    state.retain(|slug, _| targets.iter().any(|(endpoint, _)| &endpoint.slug == slug));
    let mut frames = Vec::new();
    for batch in targets.chunks(LOAD_SCRAPE_CONCURRENCY) {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let readings = thread::scope(|scope| {
            let handles = batch
                .iter()
                .map(|(endpoint, kind)| {
                    (
                        endpoint.slug.clone(),
                        scope.spawn(move || crate::engine::sample_load(agent, endpoint, *kind)),
                    )
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|(slug, handle)| (slug, handle.join().ok().flatten()))
                .collect::<Vec<_>>()
        });
        let now = Instant::now();
        for (slug, reading) in readings {
            let Some(reading) = reading else { continue };
            let entry = state.entry(slug.clone()).or_default();
            if let Some(frame) = next_load_frame(entry, &slug, reading, now, &now_rfc3339()) {
                frames.push(frame);
            }
        }
    }
    frames
}

fn counter_delta(previous: Option<f64>, current: Option<f64>) -> Option<u64> {
    let (previous, current) = (previous?, current?);
    // A reset (engine restart) is not a negative delta.
    (current >= previous).then(|| saturating_byte_counter((current - previous).round() as u64))
}

/// Decide whether a reading goes out: on change, or every
/// `LOAD_REFRESH_INTERVAL` when unchanged. Prefix-cache counters become deltas.
fn next_load_frame(
    state: &mut LoadState,
    endpoint_slug: &str,
    reading: LoadReading,
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
                || !same_load(last, &reading)
        }
    };
    if !due {
        return None;
    }
    state.prefix_hits_total = reading.prefix_cache_hits_total;
    state.prefix_queries_total = reading.prefix_cache_queries_total;
    let frame = EndpointLoad {
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
    };
    state.last_sent = Some((now, reading));
    Some(frame)
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

/// Status of every remotely defined source: `unsupported` until S-B part 2.
pub fn remote_source_statuses(sources: &[RemoteMetricSource]) -> Vec<MetricSourceStatus> {
    sources
        .iter()
        .filter(|source| is_metric_name(&source.name))
        .take(NODE_METRICS_SOURCES_MAX)
        .map(|source| MetricSourceStatus {
            name: source.name.clone(),
            origin: MetricSourceOrigin::Remote,
            state: MetricSourceState::Unsupported,
            command_sha256: Some(sha256_hex(source.command.as_bytes())),
            error: None,
        })
        .collect()
}

/// Cap a remotely defined source list at the server's schema bound.
fn bounded_remote_sources(sources: &[RemoteMetricSource]) -> Vec<RemoteMetricSource> {
    sources
        .iter()
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

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
/// stdout capped at `limit`, killed after `timeout`.
///
/// On Unix the child leads its own process group, and a timeout kills the
/// whole group: `nvidia-smi` and similar tools may spawn helpers (NVIDIA's
/// persistenced probes, vendor wrappers) that inherit the stdout pipe, and
/// killing only the direct child would leave them holding it open.
pub fn run_bounded(program: &str, args: &[String], timeout: Duration, limit: u64) -> Bounded {
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
        kill_child_group(&mut child);
        return Bounded::Failed;
    };
    let (done_tx, done_rx) = mpsc::channel();
    // The reader owns the pipe so a full pipe cannot stall the child; the
    // result arrives on a channel so a leaked pipe never blocks this thread.
    let _reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.take(limit).read_to_end(&mut buffer);
        let _ = done_tx.send(buffer);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                kill_child_group(&mut child);
                break None;
            }
        }
    };
    if !status.is_some_and(|status| status.success()) {
        return Bounded::Failed;
    }
    let remaining = deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(200);
    let Ok(buffer) = done_rx.recv_timeout(remaining) else {
        return Bounded::Failed;
    };
    String::from_utf8(buffer).map_or(Bounded::Failed, Bounded::Output)
}

/// Kill the child and, on Unix, every process that stayed in its group.
#[cfg(unix)]
fn kill_child_group(child: &mut std::process::Child) {
    // `killpg` reaches helpers the child spawned into its group before the
    // direct `kill` below reaps it.
    if let Ok(raw) = i32::try_from(child.id())
        && raw > 1
    {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(raw),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Kill the child (no process-group semantics off Unix).
#[cfg(not(unix))]
fn kill_child_group(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
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
        if list.len() < NODE_INTERFACE_ADDRESS_MAX {
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

fn collect_node_metrics(
    cpu: &mut CpuSampler,
    gpu: &mut GpuQuery,
    remote_sources: &[RemoteMetricSource],
) -> NodeMetrics {
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
        custom: Vec::new(),
        sources: remote_source_statuses(remote_sources),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::LoadSource;
    use crate::protocol::MetricSourceFormat;

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

    #[test]
    fn load_frames_go_out_on_change_or_refresh_with_counter_deltas() {
        let mut state = LoadState::default();
        let start = Instant::now();
        let first = next_load_frame(&mut state, "vllm", reading(1, Some(100.0)), start, "t0")
            .expect("first reading is sent");
        assert_eq!(first.prefix_cache_hits_delta, None);
        assert!(
            next_load_frame(
                &mut state,
                "vllm",
                reading(1, Some(100.0)),
                start + Duration::from_secs(2),
                "t1"
            )
            .is_none(),
            "unchanged within the refresh interval"
        );
        let changed = next_load_frame(
            &mut state,
            "vllm",
            reading(2, Some(150.0)),
            start + Duration::from_secs(3),
            "t2",
        )
        .expect("a change is sent");
        assert_eq!(changed.prefix_cache_hits_delta, Some(50));
        let refreshed = next_load_frame(
            &mut state,
            "vllm",
            reading(2, Some(150.0)),
            start + Duration::from_secs(9),
            "t3",
        )
        .expect("refresh after the interval");
        assert_eq!(refreshed.prefix_cache_hits_delta, Some(0));
        let reset = next_load_frame(
            &mut state,
            "vllm",
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
        assert_eq!(
            remote_source_statuses(&many).len(),
            NODE_METRICS_SOURCES_MAX
        );
        assert_eq!(bounded_remote_sources(&many[..2]).len(), 2);
    }

    #[test]
    fn remote_sources_are_reported_unsupported_with_command_hash() {
        let statuses = remote_source_statuses(&[
            RemoteMetricSource {
                name: "gpu_fan".to_string(),
                command: "echo 1".to_string(),
                interval_secs: 10,
                timeout_secs: 5,
                format: MetricSourceFormat::Number,
            },
            RemoteMetricSource {
                name: "bad name!".to_string(),
                command: "echo 2".to_string(),
                interval_secs: 10,
                timeout_secs: 5,
                format: MetricSourceFormat::Number,
            },
        ]);
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].state, MetricSourceState::Unsupported);
        assert_eq!(statuses[0].origin, MetricSourceOrigin::Remote);
        let hash = statuses[0].command_sha256.as_deref().expect("hash");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, sha256_hex(b"echo 1"));
        assert!(
            !format!("{statuses:?}").contains("echo 1"),
            "the command itself is not reported"
        );
        assert!(is_metric_name("a.b:c-d_1"));
        assert!(!is_metric_name(""));
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
