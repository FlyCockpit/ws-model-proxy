//! `node.info` and `node.metrics`: the machine the node runs on and its
//! sampled metrics.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::wire::protocol::runtime_spec::DeclaredHardware;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeOs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCpu {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cores: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuVendorWire {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeGpuInfo {
    pub vendor: GpuVendorWire,
    pub index: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    #[serde(
        rename = "vramTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub vram_total_mib: Option<u64>,
    #[serde(
        rename = "gttTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub gtt_total_mib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gfx_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apu: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pci_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInterfaceInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addresses: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_speed_mbps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtu: Option<u32>,
    /// An RDMA device is bound to this interface (fabric suggestions only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rdma: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExecutionMechanism {
    #[serde(rename = "foreground")]
    Foreground,
    #[serde(rename = "systemd")]
    Systemd,
    #[serde(rename = "launchd")]
    Launchd,
    #[serde(rename = "container")]
    Container,
    #[serde(rename = "systemd+linger")]
    SystemdLinger,
    #[serde(rename = "systemd-no-linger")]
    SystemdNoLinger,
    #[serde(rename = "macos")]
    Macos,
    #[serde(rename = "unsupported")]
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Unified,
    Discrete,
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<NodeOs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<NodeCpu>,
    #[serde(
        rename = "memoryTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub memory_total_mib: Option<u64>,
    #[serde(
        rename = "unifiedMemoryMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub unified_memory_mib: Option<u64>,
    #[serde(
        rename = "acceleratorMemoryMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub accelerator_memory_mib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpus: Option<Vec<NodeGpuInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_kind: Option<NodeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfaces: Option<Vec<NodeInterfaceInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mechanism: Option<ExecutionMechanism>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// A node-side hardware declaration. The 0.4.0 node never sends one:
    /// hardware is declared on the server (web app or MCP), not on the node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared: Option<DeclaredHardware>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCpuMetrics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load5: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load15: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeMemoryMetrics {
    #[serde(rename = "totalMiB", default, skip_serializing_if = "Option::is_none")]
    pub total_mib: Option<u64>,
    #[serde(
        rename = "availableMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub available_mib: Option<u64>,
    #[serde(
        rename = "swapTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub swap_total_mib: Option<u64>,
    #[serde(
        rename = "swapFreeMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub swap_free_mib: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeDiskMetrics {
    pub mount: String,
    #[serde(rename = "totalMiB", default, skip_serializing_if = "Option::is_none")]
    pub total_mib: Option<u64>,
    #[serde(rename = "freeMiB", default, skip_serializing_if = "Option::is_none")]
    pub free_mib: Option<u64>,
}

/// `null` and absent both mean "not reported" (nvidia-smi `[N/A]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeGpuMetrics {
    pub index: u8,
    #[serde(
        rename = "vramUsedMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub vram_used_mib: Option<u64>,
    #[serde(
        rename = "vramTotalMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub vram_total_mib: Option<u64>,
    #[serde(
        rename = "gttUsedMiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub gtt_used_mib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature_c: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power_w: Option<f64>,
    #[serde(
        rename = "smClockMHz",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sm_clock_mhz: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeInterfaceMetrics {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMetric {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    pub value: f64,
    pub ts: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricCommandState {
    Active,
    Failing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricCommandError {
    Spawn,
    Timeout,
    ExitStatus,
    OutputTooLarge,
    Parse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricCommandStatus {
    pub name: String,
    pub state: MetricCommandState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MetricCommandError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeMetrics {
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<NodeCpuMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<NodeMemoryMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disks: Option<Vec<NodeDiskMetrics>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpus: Option<Vec<NodeGpuMetrics>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfaces: Option<Vec<NodeInterfaceMetrics>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<Vec<CustomMetric>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_commands: Option<Vec<MetricCommandStatus>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abandoned_recovery: Option<u32>,
}
