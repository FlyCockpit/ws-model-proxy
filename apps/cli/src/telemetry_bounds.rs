//! Hold every telemetry frame to the server's strict 3.0 schemas.
//!
//! The server validates `node.info`, `node.metrics` and `runtime.load` with
//! strict zod schemas (`apps/server/src/relay/frames.ts`). Readings come from
//! the kernel, `nvidia-smi` and engine `/metrics`, so any of them can be out
//! of range (a CPU figure over 100 when iowait steps back, a 40-digit
//! counter, a NUL in a GPU name). [`conform`] is the one place every
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
//! The bounds below mirror the server schema one to one.

use crate::protocol::frames::{LoadSource, NodeInfo, NodeMetrics, RuntimeLoad};
use crate::protocol::{
    NODE_DISK_MAX, NODE_GPU_MAX, NODE_INTERFACE_ADDRESS_MAX, NODE_INTERFACE_MAX,
    NODE_METRIC_COMMANDS_MAX, NODE_METRICS_CUSTOM_MAX, NodeFrame,
};
use crate::telemetry::{BYTE_COUNTER_MAX, is_label_key, is_metric_name};

/// `shortTextSchema`: OS name/version/kernel, CPU model, GPU name.
pub const SHORT_TEXT_MAX: usize = 256;
pub const ARCH_MAX: usize = 32;
pub const GPU_UUID_MAX: usize = 128;
pub const GPU_DRIVER_VERSION_MAX: usize = 64;
pub const VERSION_MAX: usize = 80;
pub const INTERFACE_ADDRESS_MAX: usize = 64;
pub const DISK_MOUNT_MAX: usize = 256;
pub const CPU_CORES_MAX: u32 = 65_536;
pub const MIB_MAX: u64 = 1_000_000_000;
pub const LINK_SPEED_MBPS_MAX: u64 = 10_000_000;
pub const MTU_MAX: u32 = 1_000_000;
pub const LOAD_AVERAGE_MAX: f64 = 1_000_000.0;
pub const GPU_TEMPERATURE_MIN_C: f64 = -100.0;
pub const GPU_TEMPERATURE_MAX_C: f64 = 300.0;
pub const GPU_POWER_MAX_W: f64 = 100_000.0;
pub const GPU_CLOCK_MAX_MHZ: f64 = 100_000.0;
/// `nonNegativeCountSchema`: `runtime.load` running/waiting/slotsBusy/deferred.
pub const LOAD_COUNT_MAX: u32 = 1_000_000;
pub const CUSTOM_LABELS_MAX: usize = 16;

/// Make a telemetry frame fit the server schema. Other frames pass unchanged.
pub fn conform(message: &mut NodeFrame) {
    match message {
        NodeFrame::NodeInfo(info) => conform_node_info(info),
        NodeFrame::NodeMetrics(metrics) => conform_node_metrics(metrics),
        NodeFrame::RuntimeLoad(load) => conform_runtime_load(load),
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
    info.unified_memory_mib = mib(info.unified_memory_mib);
    info.accelerator_memory_mib = mib(info.accelerator_memory_mib);
    if let Some(gpus) = info.gpus.as_mut() {
        gpus.truncate(NODE_GPU_MAX);
        for gpu in gpus.iter_mut() {
            gpu.name = text(gpu.name.take(), SHORT_TEXT_MAX);
            gpu.uuid = text(gpu.uuid.take(), GPU_UUID_MAX);
            gpu.driver_version = text(gpu.driver_version.take(), GPU_DRIVER_VERSION_MAX);
            gpu.vram_total_mib = mib(gpu.vram_total_mib);
            gpu.gtt_total_mib = mib(gpu.gtt_total_mib);
        }
    }
    if let Some(interfaces) = info.interfaces.as_mut() {
        interfaces.retain(|interface| is_interface_name(&interface.name));
        interfaces.truncate(NODE_INTERFACE_MAX);
        for interface in interfaces.iter_mut() {
            interface.addresses = interface.addresses.take().map(|addresses| {
                addresses
                    .into_iter()
                    .filter_map(|address| text(Some(address), INTERFACE_ADDRESS_MAX))
                    .take(NODE_INTERFACE_ADDRESS_MAX)
                    .collect()
            });
            interface.link_speed_mbps = interface
                .link_speed_mbps
                .filter(|speed| *speed <= LINK_SPEED_MBPS_MAX);
            interface.mtu = interface.mtu.filter(|mtu| *mtu <= MTU_MAX);
        }
    }
    info.version = text(info.version.take(), VERSION_MAX);
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
    if let Some(disks) = metrics.disks.as_mut() {
        disks.retain_mut(|disk| {
            let Some(mount) = text(Some(std::mem::take(&mut disk.mount)), DISK_MOUNT_MAX) else {
                return false;
            };
            disk.mount = mount;
            disk.total_mib = mib(disk.total_mib);
            disk.free_mib = mib(disk.free_mib);
            true
        });
        disks.truncate(NODE_DISK_MAX);
    }
    if let Some(gpus) = metrics.gpus.as_mut() {
        gpus.truncate(NODE_GPU_MAX);
        for gpu in gpus.iter_mut() {
            gpu.vram_used_mib = mib(gpu.vram_used_mib);
            gpu.vram_total_mib = mib(gpu.vram_total_mib);
            gpu.gtt_used_mib = mib(gpu.gtt_used_mib);
            gpu.utilization_percent = within(gpu.utilization_percent, 0.0, 100.0);
            gpu.temperature_c = within(
                gpu.temperature_c,
                GPU_TEMPERATURE_MIN_C,
                GPU_TEMPERATURE_MAX_C,
            );
            gpu.power_w = within(gpu.power_w, 0.0, GPU_POWER_MAX_W);
            gpu.sm_clock_mhz = within(gpu.sm_clock_mhz, 0.0, GPU_CLOCK_MAX_MHZ);
        }
    }
    if let Some(interfaces) = metrics.interfaces.as_mut() {
        interfaces.retain(|interface| is_interface_name(&interface.name));
        interfaces.truncate(NODE_INTERFACE_MAX);
        for interface in interfaces.iter_mut() {
            interface.rx_bytes = interface.rx_bytes.min(BYTE_COUNTER_MAX);
            interface.tx_bytes = interface.tx_bytes.min(BYTE_COUNTER_MAX);
        }
    }
    if let Some(custom) = metrics.custom.as_mut() {
        custom.retain(|series| {
            let labels = series.labels.as_ref();
            is_metric_name(&series.name)
                && series.value.is_finite()
                && labels.is_none_or(|labels| {
                    labels.len() <= CUSTOM_LABELS_MAX
                        && labels
                            .iter()
                            .all(|(key, value)| is_label_key(key) && is_metric_name(value))
                })
        });
        custom.truncate(NODE_METRICS_CUSTOM_MAX);
    }
    if let Some(commands) = metrics.metric_commands.as_mut() {
        commands.retain(|command| is_metric_name(&command.name));
        commands.truncate(NODE_METRIC_COMMANDS_MAX);
    }
}

pub fn conform_runtime_load(load: &mut RuntimeLoad) {
    load.prefix_cache_hits_delta = load
        .prefix_cache_hits_delta
        .map(|value| value.min(BYTE_COUNTER_MAX));
    load.prefix_cache_queries_delta = load
        .prefix_cache_queries_delta
        .map(|value| value.min(BYTE_COUNTER_MAX));
    if load.source != LoadSource::Builtin {
        // A reader's values were normalized already; out-of-range ones are
        // dropped, not clamped: clamping 95 to 1.0 would mean "always FULL".
        load.running = load.running.min(LOAD_COUNT_MAX);
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
    use crate::protocol::frames::{
        CustomMetric, GpuVendorWire, MetricCommandState, MetricCommandStatus, NodeCpu,
        NodeCpuMetrics, NodeDiskMetrics, NodeGpuInfo, NodeGpuMetrics, NodeInterfaceInfo,
        NodeInterfaceMetrics, NodeMemoryMetrics, NodeOs,
    };

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

    #[test]
    fn an_extreme_node_info_is_conformed() {
        let mut info = NodeInfo {
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
            unified_memory_mib: None,
            accelerator_memory_mib: Some(MIB_MAX),
            gpus: Some(
                (0..40)
                    .map(|index| NodeGpuInfo {
                        vendor: GpuVendorWire::Nvidia,
                        index,
                        name: Some("GPU".to_string()),
                        uuid: Some(format!("GPU-{}", "u".repeat(200))),
                        driver_version: Some("d".repeat(100)),
                        vram_total_mib: Some(u64::MAX),
                        gtt_total_mib: None,
                        gfx_target: None,
                        apu: None,
                        pci_id: None,
                    })
                    .collect(),
            ),
            node_kind: None,
            interfaces: Some(vec![
                NodeInterfaceInfo {
                    name: "bad name".to_string(),
                    addresses: None,
                    link_speed_mbps: None,
                    mtu: None,
                    rdma: None,
                },
                NodeInterfaceInfo {
                    name: "br@eth0".to_string(),
                    addresses: Some((0..20).map(|index| format!("10.0.0.{index}")).collect()),
                    link_speed_mbps: Some(LINK_SPEED_MBPS_MAX + 1),
                    mtu: Some(MTU_MAX + 1),
                    rdma: None,
                },
            ]),
            execution_mechanism: None,
            version: Some("v".repeat(100)),
            declared: None,
        };
        conform_node_info(&mut info);
        let os = info.os.as_ref().expect("os");
        assert_eq!(os.name.as_ref().map(String::len), Some(SHORT_TEXT_MAX));
        assert_eq!(os.version, None);
        assert_eq!(os.arch.as_ref().map(String::len), Some(ARCH_MAX));
        let cpu = info.cpu.as_ref().expect("cpu");
        assert_eq!(cpu.model.as_deref(), Some("model"));
        assert_eq!(cpu.cores, None);
        assert_eq!(info.memory_total_mib, None);
        assert_eq!(info.accelerator_memory_mib, Some(MIB_MAX));
        let gpus = info.gpus.as_ref().expect("gpus");
        assert_eq!(gpus.len(), NODE_GPU_MAX);
        assert_eq!(gpus[0].uuid.as_ref().map(String::len), Some(GPU_UUID_MAX));
        assert_eq!(gpus[0].vram_total_mib, None);
        let interfaces = info.interfaces.as_ref().expect("interfaces");
        assert_eq!(interfaces.len(), 1);
        assert_eq!(
            interfaces[0].addresses.as_ref().map(Vec::len),
            Some(NODE_INTERFACE_ADDRESS_MAX)
        );
        assert_eq!(interfaces[0].link_speed_mbps, None);
        assert_eq!(interfaces[0].mtu, None);
        assert_eq!(info.version.as_ref().map(String::len), Some(VERSION_MAX));
        // The conformed frame still encodes.
        let mut frame = NodeFrame::NodeInfo(info);
        assert!(crate::telemetry::encode_telemetry(&mut frame).is_some());
    }

    #[test]
    fn extreme_node_metrics_are_conformed() {
        let ts = "2026-09-28T12:00:00.000Z".to_string();
        let series = |name: &str, key: Option<&str>, value: f64| CustomMetric {
            name: name.to_string(),
            labels: key.map(|key| [(key.to_string(), "0".to_string())].into_iter().collect()),
            value,
            ts: ts.clone(),
        };
        let mut metrics = NodeMetrics {
            ts: ts.clone(),
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
            disks: Some(
                (0..20)
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
            ),
            gpus: Some(vec![NodeGpuMetrics {
                index: 0,
                vram_used_mib: Some(MIB_MAX + 1),
                vram_total_mib: Some(MIB_MAX),
                gtt_used_mib: None,
                utilization_percent: Some(150.0),
                temperature_c: Some(f64::INFINITY),
                power_w: Some(-5.0),
                sm_clock_mhz: Some(100_001.0),
            }]),
            interfaces: Some(vec![
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
            ]),
            custom: Some(vec![
                series("rpm", None, f64::NAN),
                series("bad name", None, 1.0),
                series("rpm", Some("gpu"), 1800.0),
                // `__proto__` matches the name pattern but the server drops it.
                series("rpm", Some("__proto__"), 1800.0),
            ]),
            metric_commands: Some(vec![
                MetricCommandStatus {
                    name: "bad name".to_string(),
                    state: MetricCommandState::Active,
                    error: None,
                },
                MetricCommandStatus {
                    name: "fans".to_string(),
                    state: MetricCommandState::Active,
                    error: None,
                },
            ]),
            abandoned_recovery: None,
        };
        conform_node_metrics(&mut metrics);
        let cpu = metrics.cpu.as_ref().expect("cpu");
        assert_eq!(cpu.usage_percent, Some(100.0));
        assert_eq!((cpu.load1, cpu.load5, cpu.load15), (None, None, None));
        let memory = metrics.memory.as_ref().expect("memory");
        assert_eq!(memory.total_mib, None);
        assert_eq!(memory.swap_total_mib, None);
        let disks = metrics.disks.as_ref().expect("disks");
        assert_eq!(disks.len(), NODE_DISK_MAX);
        assert_eq!(disks[0].mount, "/mnt/1");
        let gpu = &metrics.gpus.as_ref().expect("gpus")[0];
        assert_eq!(gpu.vram_used_mib, None);
        assert_eq!(gpu.utilization_percent, None);
        assert_eq!(gpu.temperature_c, None);
        let interfaces = metrics.interfaces.as_ref().expect("interfaces");
        assert_eq!(interfaces.len(), 1);
        assert_eq!(interfaces[0].rx_bytes, BYTE_COUNTER_MAX);
        let custom = metrics.custom.as_ref().expect("custom");
        assert_eq!(custom.len(), 1);
        assert!(custom[0].labels.is_some());
        let commands = metrics.metric_commands.as_ref().expect("commands");
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "fans");
        let mut frame = NodeFrame::NodeMetrics(metrics);
        assert!(crate::telemetry::encode_telemetry(&mut frame).is_some());
    }

    fn load(source: LoadSource) -> RuntimeLoad {
        RuntimeLoad {
            handle: "vllm".to_string(),
            model: None,
            running: u32::MAX,
            waiting: Some(LOAD_COUNT_MAX + 1),
            kv_usage: Some(f64::NAN),
            kv_occupancy: None,
            slots_busy: Some(2_000_000),
            deferred: Some(LOAD_COUNT_MAX),
            prefix_cache_hits_delta: Some(u64::MAX),
            prefix_cache_queries_delta: Some(BYTE_COUNTER_MAX),
            prefix_cache_reset: None,
            counter_epoch: 0,
            source,
            ts: "2026-09-28T12:00:01.000Z".to_string(),
        }
    }

    #[test]
    fn an_extreme_builtin_load_saturates() {
        let mut frame = load(LoadSource::Builtin);
        conform_runtime_load(&mut frame);
        assert_eq!(frame.running, LOAD_COUNT_MAX);
        assert_eq!(frame.waiting, Some(LOAD_COUNT_MAX));
        assert_eq!(frame.slots_busy, Some(LOAD_COUNT_MAX));
        assert_eq!(frame.kv_usage, None);
        assert_eq!(frame.prefix_cache_hits_delta, Some(BYTE_COUNTER_MAX));
    }

    #[test]
    fn reader_load_drops_out_of_range_fractions_instead_of_clamping() {
        let mut frame = RuntimeLoad {
            running: 3,
            kv_usage: Some(95.0),
            kv_occupancy: Some(1.5),
            ..load(LoadSource::Route)
        };
        conform_runtime_load(&mut frame);
        assert_eq!(frame.running, 3);
        assert_eq!(frame.waiting, None);
        assert_eq!(frame.kv_usage, None);
        assert_eq!(frame.kv_occupancy, None);
    }

    #[test]
    fn in_range_frames_pass_unchanged() {
        let message = NodeFrame::RuntimeLoad(RuntimeLoad {
            running: LOAD_COUNT_MAX,
            waiting: Some(0),
            kv_usage: Some(1.0),
            kv_occupancy: Some(1.0),
            slots_busy: Some(0),
            deferred: None,
            prefix_cache_hits_delta: Some(BYTE_COUNTER_MAX),
            prefix_cache_queries_delta: Some(0),
            ..load(LoadSource::Builtin)
        });
        let mut conformed = message.clone();
        conform(&mut conformed);
        assert_eq!(conformed, message);
    }
}
