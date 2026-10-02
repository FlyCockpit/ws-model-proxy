//! Hold every telemetry frame to the server's strict 2.7 schemas.
//!
//! The server validates `node.info`, `node.metrics` and `endpoint.load` with
//! `.strict()` zod schemas (`apps/server/src/relay/protocol.ts`). Readings
//! come from the kernel, `nvidia-smi` and engine `/metrics`, so any of them
//! can be out of range (a CPU figure over 100 when iowait steps back, a
//! 40-digit counter, a NUL in a GPU name). [`conform`] is the one place every
//! telemetry frame passes before it is encoded (`telemetry::offer`), and it
//! makes the frame fit:
//!
//! - required counters saturate at their cap (a value at the cap reads "at
//!   least this much");
//! - an optional reading that is non-finite or out of range is omitted;
//! - text loses NUL, is trimmed and cut to its cap on a character boundary,
//!   and is omitted when nothing is left;
//! - lists are cut to their caps, and entries whose key (interface name,
//!   metric name, disk mount) cannot be sent are dropped.
//!
//! The bounds below mirror the server schema one to one; the table-driven
//! test and the shared `relay-2.7/*-extreme.json` vectors (parsed by the
//! server's tests) keep the two sides in step.

use crate::protocol::{
    ClientControlMessage, EndpointLoad, NODE_DISK_MAX, NODE_ENGINE_ADAPTERS_MAX, NODE_GPU_MAX,
    NODE_INTERFACE_ADDRESS_MAX, NODE_INTERFACE_MAX, NODE_METRICS_CUSTOM_MAX,
    NODE_METRICS_SOURCES_MAX, NodeInfo, NodeMetrics,
};
use crate::telemetry::{
    BYTE_COUNTER_MAX, METRIC_SOURCE_INTERVAL_MAX_SECS, METRIC_SOURCE_INTERVAL_MIN_SECS,
    is_label_key, is_metric_name,
};

/// `shortTextSchema`: OS name/version/kernel, CPU model, GPU name.
pub const SHORT_TEXT_MAX: usize = 256;
pub const ARCH_MAX: usize = 32;
pub const GPU_UUID_MAX: usize = 128;
pub const GPU_DRIVER_VERSION_MAX: usize = 64;
pub const CLI_VERSION_MAX: usize = 80;
pub const INTERFACE_ADDRESS_MAX: usize = 64;
pub const DISK_MOUNT_MAX: usize = 256;
pub const CPU_CORES_MAX: u32 = 65_536;
pub const MIB_MAX: u64 = 1_000_000_000;
pub const GPU_INDEX_MAX: u32 = 255;
pub const LINK_SPEED_MBPS_MAX: u64 = 10_000_000;
pub const MTU_MAX: u32 = 1_000_000;
pub const LOAD_AVERAGE_MAX: f64 = 1_000_000.0;
pub const GPU_TEMPERATURE_MIN_C: f64 = -100.0;
pub const GPU_TEMPERATURE_MAX_C: f64 = 300.0;
pub const GPU_POWER_MAX_W: f64 = 100_000.0;
pub const GPU_CLOCK_MAX_MHZ: f64 = 100_000.0;
/// `nonNegativeCountSchema`: `endpoint.load` running/waiting/slotsBusy/deferred.
pub const LOAD_COUNT_MAX: u64 = 1_000_000;
pub const CUSTOM_LABELS_MAX: usize = 16;

/// Make a telemetry frame fit the server schema. Other frames pass unchanged.
pub fn conform(message: &mut ClientControlMessage) {
    match message {
        ClientControlMessage::NodeInfo(info) => conform_node_info(info),
        ClientControlMessage::NodeMetrics(metrics) => conform_node_metrics(metrics),
        ClientControlMessage::EndpointLoad(load) => conform_endpoint_load(load),
        _ => {}
    }
}

/// The characters JavaScript's `String.prototype.trim` (and so zod's
/// `.trim()` on the server) strips: Unicode `White_Space` except U+0085, plus
/// U+FEFF. Rust's `str::trim` differs on exactly those two, so text is
/// trimmed with this set to match what the server will see.
pub fn is_js_trim_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{85}') || character == '\u{FEFF}'
}

/// NUL removed, trimmed like the server trims, cut to `max` bytes on a
/// character boundary (zod counts UTF-16 units, never more than UTF-8
/// bytes), `None` when empty.
fn text(value: Option<String>, max: usize) -> Option<String> {
    let value = value?;
    let cleaned = value.replace('\0', "");
    let trimmed = cleaned.trim_matches(is_js_trim_whitespace);
    let mut end = trimmed.len().min(max);
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    let cut = trimmed[..end].trim_end_matches(is_js_trim_whitespace);
    (!cut.is_empty()).then(|| cut.to_string())
}

fn within(value: Option<f64>, min: f64, max: f64) -> Option<f64> {
    value.filter(|value| value.is_finite() && (min..=max).contains(value))
}

fn mib(value: Option<u64>) -> Option<u64> {
    value.filter(|value| *value <= MIB_MAX)
}

pub fn conform_node_info(info: &mut NodeInfo) {
    if let Some(os) = info.os.as_mut() {
        os.name = text(os.name.take(), SHORT_TEXT_MAX);
        os.version = text(os.version.take(), SHORT_TEXT_MAX);
        os.kernel = text(os.kernel.take(), SHORT_TEXT_MAX);
        os.arch = text(os.arch.take(), ARCH_MAX);
    }
    if let Some(cpu) = info.cpu.as_mut() {
        cpu.model = text(cpu.model.take(), SHORT_TEXT_MAX);
        cpu.cores = cpu
            .cores
            .filter(|cores| (1..=CPU_CORES_MAX).contains(cores));
    }
    info.memory_total_mib = mib(info.memory_total_mib);
    info.gpus.retain(|gpu| gpu.index <= GPU_INDEX_MAX);
    info.gpus.truncate(NODE_GPU_MAX);
    for gpu in &mut info.gpus {
        gpu.name = text(gpu.name.take(), SHORT_TEXT_MAX);
        gpu.uuid = text(gpu.uuid.take(), GPU_UUID_MAX);
        gpu.driver_version = text(gpu.driver_version.take(), GPU_DRIVER_VERSION_MAX);
        gpu.vram_total_mib = mib(gpu.vram_total_mib);
    }
    info.interfaces
        .retain(|interface| is_interface_name(&interface.name));
    info.interfaces.truncate(NODE_INTERFACE_MAX);
    for interface in &mut info.interfaces {
        interface.addresses = std::mem::take(&mut interface.addresses)
            .into_iter()
            .filter_map(|address| text(Some(address), INTERFACE_ADDRESS_MAX))
            .take(NODE_INTERFACE_ADDRESS_MAX)
            .collect();
        interface.link_speed_mbps = interface
            .link_speed_mbps
            .filter(|speed| *speed <= LINK_SPEED_MBPS_MAX);
        interface.mtu = interface.mtu.filter(|mtu| *mtu <= MTU_MAX);
    }
    info.cli_version = text(info.cli_version.take(), CLI_VERSION_MAX);
}

pub fn conform_node_metrics(metrics: &mut NodeMetrics) {
    if let Some(cpu) = metrics.cpu.as_mut() {
        // Over 100 only when the kernel's idle/iowait counters step back.
        cpu.usage_percent = cpu
            .usage_percent
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0));
        cpu.load1 = within(cpu.load1, 0.0, LOAD_AVERAGE_MAX);
        cpu.load5 = within(cpu.load5, 0.0, LOAD_AVERAGE_MAX);
        cpu.load15 = within(cpu.load15, 0.0, LOAD_AVERAGE_MAX);
    }
    if let Some(memory) = metrics.memory.as_mut() {
        memory.total_mib = mib(memory.total_mib);
        memory.available_mib = mib(memory.available_mib);
        memory.swap_total_mib = mib(memory.swap_total_mib);
        memory.swap_free_mib = mib(memory.swap_free_mib);
    }
    metrics.disks.retain_mut(|disk| {
        let Some(mount) = text(Some(std::mem::take(&mut disk.mount)), DISK_MOUNT_MAX) else {
            return false;
        };
        disk.mount = mount;
        disk.total_mib = mib(disk.total_mib);
        disk.free_mib = mib(disk.free_mib);
        true
    });
    metrics.disks.truncate(NODE_DISK_MAX);
    metrics.gpus.retain(|gpu| gpu.index <= GPU_INDEX_MAX);
    metrics.gpus.truncate(NODE_GPU_MAX);
    for gpu in &mut metrics.gpus {
        gpu.vram_used_mib = mib(gpu.vram_used_mib);
        gpu.vram_total_mib = mib(gpu.vram_total_mib);
        gpu.utilization_percent = within(gpu.utilization_percent, 0.0, 100.0);
        gpu.temperature_c = within(
            gpu.temperature_c,
            GPU_TEMPERATURE_MIN_C,
            GPU_TEMPERATURE_MAX_C,
        );
        gpu.power_w = within(gpu.power_w, 0.0, GPU_POWER_MAX_W);
        gpu.sm_clock_mhz = within(gpu.sm_clock_mhz, 0.0, GPU_CLOCK_MAX_MHZ);
    }
    metrics
        .interfaces
        .retain(|interface| is_interface_name(&interface.name));
    metrics.interfaces.truncate(NODE_INTERFACE_MAX);
    for interface in &mut metrics.interfaces {
        interface.rx_bytes = interface.rx_bytes.min(BYTE_COUNTER_MAX);
        interface.tx_bytes = interface.tx_bytes.min(BYTE_COUNTER_MAX);
    }
    metrics.custom.retain(|series| {
        is_metric_name(&series.source)
            && is_metric_name(&series.name)
            && series.value.is_finite()
            && series.labels.len() <= CUSTOM_LABELS_MAX
            && series
                .labels
                .iter()
                .all(|(key, value)| is_label_key(key) && is_metric_name(value))
    });
    metrics.custom.truncate(NODE_METRICS_CUSTOM_MAX);
    metrics
        .sources
        .retain(|source| is_metric_name(&source.name));
    metrics.sources.truncate(NODE_METRICS_SOURCES_MAX);
    metrics
        .engine_adapters
        .retain(|status| (1..=63).contains(&status.endpoint_slug.len()));
    metrics.engine_adapters.truncate(NODE_ENGINE_ADAPTERS_MAX);
    for source in &mut metrics.sources {
        source.command_sha256 = source.command_sha256.take().filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
        source.interval_secs = source.interval_secs.filter(|secs| {
            (METRIC_SOURCE_INTERVAL_MIN_SECS..=METRIC_SOURCE_INTERVAL_MAX_SECS).contains(secs)
        });
    }
}

pub fn conform_endpoint_load(load: &mut EndpointLoad) {
    load.prefix_cache_hits_delta = load
        .prefix_cache_hits_delta
        .map(|value| value.min(BYTE_COUNTER_MAX));
    load.prefix_cache_queries_delta = load
        .prefix_cache_queries_delta
        .map(|value| value.min(BYTE_COUNTER_MAX));
    if load.source == crate::engine::LoadSource::Custom {
        // Adapter normalize already dropped out-of-range values. Do not clamp
        // custom fractions: clamping 95 to 1.0 would mean "always FULL".
        if load.running > LOAD_COUNT_MAX {
            load.running = LOAD_COUNT_MAX;
        }
        load.waiting = load.waiting.filter(|value| *value <= LOAD_COUNT_MAX);
        load.slots_busy = load.slots_busy.filter(|value| *value <= LOAD_COUNT_MAX);
        load.deferred = load.deferred.filter(|value| *value <= LOAD_COUNT_MAX);
        load.kv_usage = load
            .kv_usage
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value));
        load.kv_occupancy = load
            .kv_occupancy
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value));
        return;
    }
    load.running = load.running.min(LOAD_COUNT_MAX);
    load.waiting = load.waiting.map(|value| value.min(LOAD_COUNT_MAX));
    load.slots_busy = load.slots_busy.map(|value| value.min(LOAD_COUNT_MAX));
    load.deferred = load.deferred.map(|value| value.min(LOAD_COUNT_MAX));
    load.kv_usage = load
        .kv_usage
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0));
    load.kv_occupancy = load
        .kv_occupancy
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value));
}

/// `[A-Za-z0-9_.:@-]{1,64}` (the server's `interfaceNameSchema`).
pub fn is_interface_name(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'@' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::LoadSource;
    use crate::protocol::{
        CustomMetric, MetricSourceOrigin, MetricSourceState, MetricSourceStatus, NodeCpu,
        NodeCpuMetrics, NodeDiskMetrics, NodeGpuInfo, NodeGpuMetrics, NodeInterfaceInfo,
        NodeInterfaceMetrics, NodeMemoryMetrics, NodeOs,
    };
    use serde_json::Value;

    #[test]
    fn text_rows() {
        // (input, cap, expected)
        let rows: &[(&str, usize, Option<&str>)] = &[
            ("Ubuntu", 256, Some("Ubuntu")),
            ("  padded  ", 256, Some("padded")),
            ("a\0b", 256, Some("ab")),
            ("\0\0", 256, None),
            ("   ", 256, None),
            ("", 256, None),
            ("abcdef", 4, Some("abcd")),
            ("ab  cd", 3, Some("ab")),
            // A multi-byte character straddling the cap is dropped whole.
            ("aé", 2, Some("a")),
            ("€€", 4, Some("€")),
            ("😀x", 3, None),
            // Trimmed exactly like the server's JS `trim`.
            ("\u{FEFF}", 256, None),
            (" \u{FEFF} name \u{FEFF}", 256, Some("name")),
            ("\u{3000}x\u{2028}", 256, Some("x")),
            // U+0085 is not JS whitespace: kept, as the server keeps it.
            ("\u{85}x", 256, Some("\u{85}x")),
        ];
        for (input, cap, expected) in rows {
            assert_eq!(
                text(Some((*input).to_string()), *cap).as_deref(),
                *expected,
                "{input:?} cap {cap}"
            );
        }
        assert_eq!(text(None, 8), None);
        assert_eq!(
            text(Some("x".repeat(300)), SHORT_TEXT_MAX).map(|v| v.len()),
            Some(256)
        );
    }

    #[test]
    fn reading_rows() {
        // (value, min, max, kept)
        let rows: &[(f64, f64, f64, bool)] = &[
            (0.0, 0.0, 100.0, true),
            (100.0, 0.0, 100.0, true),
            (100.000_1, 0.0, 100.0, false),
            (-0.1, 0.0, 100.0, false),
            (f64::NAN, 0.0, 100.0, false),
            (f64::INFINITY, 0.0, 100.0, false),
            (f64::NEG_INFINITY, -100.0, 300.0, false),
            (-100.0, -100.0, 300.0, true),
            (300.5, -100.0, 300.0, false),
        ];
        for (value, min, max, kept) in rows {
            assert_eq!(
                within(Some(*value), *min, *max).is_some(),
                *kept,
                "{value} in {min}..={max}"
            );
        }
    }

    fn extreme_node_info() -> NodeInfo {
        NodeInfo {
            os: Some(NodeOs {
                name: Some(format!("  {}\0", "n".repeat(300))),
                version: Some("\0".to_string()),
                kernel: Some("6.8.0".to_string()),
                arch: Some("a".repeat(40)),
            }),
            cpu: Some(NodeCpu {
                model: Some("m\0odel".to_string()),
                cores: Some(0),
            }),
            memory_total_mib: Some(MIB_MAX + 1),
            gpus: (0..40)
                .map(|index| NodeGpuInfo {
                    index: if index == 0 { 256 } else { index },
                    name: Some("GPU".to_string()),
                    uuid: Some(format!("GPU-{}", "u".repeat(200))),
                    driver_version: Some("d".repeat(100)),
                    vram_total_mib: Some(u64::MAX),
                })
                .collect(),
            unified_memory: Some(false),
            node_kind: None,
            interfaces: vec![
                NodeInterfaceInfo {
                    name: "bad name".to_string(),
                    ..NodeInterfaceInfo::default()
                },
                NodeInterfaceInfo {
                    name: "br@eth0".to_string(),
                    addresses: (0..20).map(|index| format!("10.0.0.{index}")).collect(),
                    link_speed_mbps: Some(LINK_SPEED_MBPS_MAX + 1),
                    mtu: Some(MTU_MAX + 1),
                },
            ],
            execution_mechanism: None,
            cli_version: Some("v".repeat(100)),
        }
    }

    fn extreme_node_metrics() -> NodeMetrics {
        NodeMetrics {
            ts: "2026-09-28T12:00:00.000Z".to_string(),
            cpu: Some(NodeCpuMetrics {
                usage_percent: Some(101.3),
                load1: Some(f64::NAN),
                load5: Some(-1.0),
                load15: Some(2_000_000.0),
            }),
            memory: Some(NodeMemoryMetrics {
                total_mib: Some(MIB_MAX + 1),
                available_mib: Some(64_000),
                swap_total_mib: Some(u64::MAX),
                swap_free_mib: Some(0),
            }),
            disks: (0..20)
                .map(|index| NodeDiskMetrics {
                    mount: if index == 0 {
                        "\0".to_string()
                    } else {
                        format!("/mnt/{index}")
                    },
                    total_mib: Some(u64::MAX),
                    free_mib: Some(1),
                })
                .collect(),
            gpus: vec![
                NodeGpuMetrics {
                    index: 0,
                    vram_used_mib: Some(MIB_MAX + 1),
                    vram_total_mib: Some(MIB_MAX),
                    utilization_percent: Some(150.0),
                    temperature_c: Some(f64::INFINITY),
                    power_w: Some(-5.0),
                    sm_clock_mhz: Some(100_001.0),
                },
                NodeGpuMetrics {
                    index: 999,
                    ..NodeGpuMetrics::default()
                },
            ],
            interfaces: vec![
                NodeInterfaceMetrics {
                    name: "eth0".to_string(),
                    rx_bytes: u64::MAX,
                    tx_bytes: BYTE_COUNTER_MAX + 1,
                },
                NodeInterfaceMetrics {
                    name: "x".repeat(65),
                    rx_bytes: 1,
                    tx_bytes: 1,
                },
            ],
            custom: vec![
                CustomMetric {
                    source: "fans".to_string(),
                    name: "rpm".to_string(),
                    labels: Default::default(),
                    value: f64::NAN,
                    ts: "2026-09-28T12:00:00.000Z".to_string(),
                },
                CustomMetric {
                    source: "fans".to_string(),
                    name: "bad name".to_string(),
                    labels: Default::default(),
                    value: 1.0,
                    ts: "2026-09-28T12:00:00.000Z".to_string(),
                },
                CustomMetric {
                    source: "fans".to_string(),
                    name: "rpm".to_string(),
                    labels: [("gpu".to_string(), "0".to_string())].into_iter().collect(),
                    value: 1800.0,
                    ts: "2026-09-28T12:00:00.000Z".to_string(),
                },
                // `__proto__` matches the name pattern but the server drops it.
                CustomMetric {
                    source: "fans".to_string(),
                    name: "rpm".to_string(),
                    labels: [("__proto__".to_string(), "0".to_string())]
                        .into_iter()
                        .collect(),
                    value: 1800.0,
                    ts: "2026-09-28T12:00:00.000Z".to_string(),
                },
            ],
            sources: vec![
                MetricSourceStatus {
                    name: "bad name".to_string(),
                    origin: MetricSourceOrigin::Local,
                    state: MetricSourceState::Active,
                    command_sha256: None,
                    interval_secs: Some(10),
                    error: None,
                },
                MetricSourceStatus {
                    name: "fans".to_string(),
                    origin: MetricSourceOrigin::Local,
                    state: MetricSourceState::Active,
                    command_sha256: Some("NOT-A-HASH".to_string()),
                    interval_secs: Some(1),
                    error: None,
                },
            ],
            engine_adapters: Vec::new(),
        }
    }

    fn extreme_load() -> EndpointLoad {
        EndpointLoad {
            endpoint_slug: "vllm".to_string(),
            model_slug: None,
            running: u64::MAX,
            waiting: Some(LOAD_COUNT_MAX + 1),
            kv_usage: Some(f64::NAN),
            kv_occupancy: None,
            slots_busy: Some(2_000_000),
            deferred: Some(LOAD_COUNT_MAX),
            prefix_cache_hits_delta: Some(u64::MAX),
            prefix_cache_queries_delta: Some(BYTE_COUNTER_MAX),
            prefix_cache_reset: None,
            counter_epoch: None,
            source: LoadSource::VllmMetrics,
            ts: "2026-09-28T12:00:01.000Z".to_string(),
        }
    }

    fn conformed(message: ClientControlMessage) -> Value {
        let mut message = message;
        let text = crate::telemetry::encode_telemetry(&mut message).expect("encodes");
        serde_json::from_str(&text).expect("json")
    }

    fn vector(text: &str) -> Value {
        serde_json::from_str(text).expect("vector is JSON")
    }

    // The same vectors are parsed by the server's strict schemas
    // (`apps/server/src/relay/protocol.test.ts`), so a conformed frame is
    // proven acceptable on both sides.
    #[test]
    fn an_extreme_node_info_is_conformed_to_the_shared_vector() {
        assert_eq!(
            conformed(ClientControlMessage::NodeInfo(extreme_node_info())),
            vector(include_str!(
                "../tests/fixtures/relay-2.7/node-info-extreme.json"
            ))
        );
    }

    #[test]
    fn extreme_node_metrics_are_conformed_to_the_shared_vector() {
        assert_eq!(
            conformed(ClientControlMessage::NodeMetrics(extreme_node_metrics())),
            vector(include_str!(
                "../tests/fixtures/relay-2.7/node-metrics-extreme.json"
            ))
        );
    }

    #[test]
    fn an_extreme_endpoint_load_is_conformed_to_the_shared_vector() {
        assert_eq!(
            conformed(ClientControlMessage::EndpointLoad(extreme_load())),
            vector(include_str!(
                "../tests/fixtures/relay-2.7/endpoint-load-extreme.json"
            ))
        );
    }

    #[test]
    fn custom_load_drops_out_of_range_fractions_instead_of_clamping() {
        let mut load = EndpointLoad {
            running: 3,
            waiting: Some(LOAD_COUNT_MAX + 1),
            kv_usage: Some(95.0),
            kv_occupancy: Some(1.5),
            source: LoadSource::Custom,
            ..extreme_load()
        };
        conform_endpoint_load(&mut load);
        assert_eq!(load.running, 3);
        assert_eq!(load.waiting, None);
        assert_eq!(load.kv_usage, None);
        assert_eq!(load.kv_occupancy, None);
    }

    #[test]
    fn in_range_frames_pass_unchanged() {
        for message in [
            ClientControlMessage::EndpointLoad(EndpointLoad {
                running: LOAD_COUNT_MAX,
                waiting: Some(0),
                kv_usage: Some(1.0),
                kv_occupancy: Some(1.0),
                slots_busy: Some(0),
                deferred: None,
                prefix_cache_hits_delta: Some(BYTE_COUNTER_MAX),
                prefix_cache_queries_delta: Some(0),
                ..extreme_load()
            }),
            ClientControlMessage::NodeMetrics(NodeMetrics {
                ts: "2026-09-28T12:00:00.000Z".to_string(),
                cpu: Some(NodeCpuMetrics {
                    usage_percent: Some(100.0),
                    load1: Some(0.0),
                    load5: Some(LOAD_AVERAGE_MAX),
                    load15: None,
                }),
                gpus: vec![NodeGpuMetrics {
                    index: GPU_INDEX_MAX,
                    temperature_c: Some(GPU_TEMPERATURE_MIN_C),
                    ..NodeGpuMetrics::default()
                }],
                ..NodeMetrics::default()
            }),
        ] {
            let mut conformed_message = message.clone();
            conform(&mut conformed_message);
            assert_eq!(
                serde_json::to_value(&conformed_message).expect("json"),
                serde_json::to_value(&message).expect("json")
            );
        }
    }
}
