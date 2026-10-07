//! What this node's hardware is: memory, accelerators and the memory a model
//! can occupy. Feeds `node.info` (placement reads it as the last fallback
//! after the browser and node declarations) and `wsmp hardware`.
//!
//! Sources, each optional:
//! - NVIDIA: `nvidia-smi` rows ([`crate::telemetry::parse_nvidia_smi`]). A
//!   GPU whose `memory.total` is `[N/A]` (GB10 / DGX Spark) shares system
//!   memory: the node is unified and its pool is `MemTotal`.
//! - AMD: sysfs `/sys/class/drm/card*/device` (`mem_info_vram_total`,
//!   `mem_info_gtt_total`, `uevent`) joined with the KFD topology
//!   (`gfx_target_version`) by render minor. `amd-smi` (else `rocm-smi`)
//!   only names the GPUs. An APU (Strix Halo, Phoenix, ...) can address its
//!   VRAM carve-out plus GTT (capped by `ttm.pages_limit`), never more than
//!   physical memory. An integrated GPU beside a discrete one is left out.
//! - NVIDIA errors (`[Unknown Error]`) never make a node unified: only an
//!   exact `[N/A]` on GB10 / Thor or an Arm host does.
//! - Apple silicon: `sysctl` `hw.memsize`, the chip name, and the GPU wired
//!   limit (`iogpu.wired_limit_mb`, else macOS's default share).
//!
//! Values are conservative: a pool is the smaller of what the GPU can
//! address and what physically exists, and nothing unknown is guessed.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::protocol::frames::{GpuVendorWire, NodeGpuInfo, NodeGpuMetrics, NodeKind};
use crate::telemetry::GpuRow;

const TOOL_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_OUTPUT_LIMIT: u64 = 256 * 1024;
const SYSFS_FILE_LIMIT: u64 = 64 * 1024;
const TEXT_MAX: usize = 256;
const MIB: u64 = 1024 * 1024;

/// What this node detects. `notes` say how each memory figure was derived.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub node_kind: NodeKind,
    /// Physical memory: `MemTotal` (plus an AMD APU's VRAM carve-out, which
    /// `MemTotal` excludes), or `hw.memsize`.
    #[serde(rename = "memoryTotalMiB", skip_serializing_if = "Option::is_none")]
    pub memory_total_mib: Option<u64>,
    /// Unified nodes: the pool a model can occupy.
    #[serde(rename = "unifiedMemoryMiB", skip_serializing_if = "Option::is_none")]
    pub unified_memory_mib: Option<u64>,
    /// Memory the accelerators can hold: discrete VRAM, or the unified pool.
    #[serde(
        rename = "acceleratorMemoryMiB",
        skip_serializing_if = "Option::is_none"
    )]
    pub accelerator_memory_mib: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_model: Option<String>,
    pub gpus: Vec<NodeGpuInfo>,
    pub notes: Vec<String>,
}

/// One AMD GPU from sysfs and the KFD topology.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmdGpu {
    /// KFD topology node: ROCm (HIP) numbers GPUs in this order, integrated
    /// ones included.
    pub kfd_node: Option<u64>,
    pub pci_slot: String,
    pub pci_id: Option<String>,
    pub vram_bytes: Option<u64>,
    pub gtt_bytes: Option<u64>,
    /// `mem_info_vram_used` / `mem_info_gtt_used` when read (node.metrics).
    pub vram_used_bytes: Option<u64>,
    pub gtt_used_bytes: Option<u64>,
    pub gfx_target: Option<String>,
    pub name: Option<String>,
}

impl AmdGpu {
    pub fn device_id(&self) -> Option<&str> {
        self.pci_id.as_deref()?.split_once(':').map(|(_, id)| id)
    }

    /// Integrated GPUs share system memory: known APU targets or device ids.
    pub fn is_apu(&self) -> bool {
        self.gfx_target
            .as_deref()
            .is_some_and(|target| APU_GFX_TARGETS.contains(&target))
            || self
                .device_id()
                .is_some_and(|id| APU_DEVICES.iter().any(|(known, _)| *known == id))
    }
}

/// gfx targets that only ship as integrated GPUs.
const APU_GFX_TARGETS: &[&str] = &[
    "gfx902", "gfx909", "gfx90c", "gfx1013", "gfx1033", "gfx1035", "gfx1036", "gfx1037", "gfx1103",
    "gfx1150", "gfx1151", "gfx1152", "gfx1153",
];

/// Integrated GPU PCI device ids and names (when no tool names them).
const APU_DEVICES: &[(&str, &str)] = &[
    ("1586", "Radeon 8050S/8060S (Strix Halo)"),
    ("150e", "Radeon 880M/890M (Strix Point)"),
    ("1114", "Radeon 840M/860M (Krackan Point)"),
    ("15bf", "Radeon 760M/780M (Phoenix)"),
    ("15c8", "Radeon 740M (Phoenix 2)"),
    ("1681", "Radeon 680M (Rembrandt)"),
    ("164e", "Radeon Graphics (Raphael)"),
    ("13c0", "Radeon Graphics (Granite Ridge)"),
    ("1636", "Radeon Graphics (Renoir)"),
    ("1638", "Radeon Graphics (Cezanne)"),
    ("164c", "Radeon Graphics (Lucienne)"),
    ("15d8", "Radeon Vega (Picasso)"),
    ("15dd", "Radeon Vega (Raven Ridge)"),
];

/// Apple silicon facts from `sysctl`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AppleFacts {
    pub memsize_bytes: Option<u64>,
    pub chip: Option<String>,
    pub wired_limit_mib: Option<u64>,
}

/// Everything [`assemble`] reads; [`detect`] fills it from this machine.
#[derive(Debug, Clone, Default)]
pub struct Sources {
    pub meminfo_total_mib: Option<u64>,
    pub cpu_model: Option<String>,
    pub nvidia: Vec<GpuRow>,
    pub amd: Vec<AmdGpu>,
    /// `/sys/module/ttm/parameters/pages_limit`: TTM caps GTT (and KFD)
    /// allocations here even when `mem_info_gtt_total` says more.
    pub ttm_pages_limit: Option<u64>,
    pub apple: Option<AppleFacts>,
}

/// TTM pages are 4 KiB on the x86 APUs this applies to.
const TTM_PAGE_BYTES: u64 = 4096;

/// Read the TTM page limit under `root`.
pub fn read_ttm_pages_limit(root: &Path) -> Option<u64> {
    sysfs_number(&root.join("sys/module/ttm/parameters/pages_limit")).filter(|pages| *pages > 0)
}

/// Detect this machine's hardware. `nvidia` are this round's `nvidia-smi`
/// rows (the telemetry thread already runs it).
pub fn detect(nvidia: Vec<GpuRow>) -> Hardware {
    assemble(gather(nvidia))
}

fn read_text(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut text = String::new();
    file.take(SYSFS_FILE_LIMIT).read_to_string(&mut text).ok()?;
    Some(text)
}

fn gather(nvidia: Vec<GpuRow>) -> Sources {
    let meminfo_total_mib = read_text(Path::new("/proc/meminfo")).and_then(|text| {
        crate::telemetry::parse_meminfo(&text)
            .get("MemTotal")
            .copied()
    });
    let mut sources = Sources {
        meminfo_total_mib,
        cpu_model: read_text(Path::new("/proc/cpuinfo"))
            .and_then(|text| crate::telemetry::parse_cpu_model(&text)),
        nvidia,
        amd: read_amd_sysfs(Path::new("/")),
        ttm_pages_limit: read_ttm_pages_limit(Path::new("/")),
        apple: None,
    };
    if !sources.amd.is_empty() {
        let names = amd_tool_names();
        name_amd_gpus(&mut sources.amd, &names);
    }
    if cfg!(target_os = "macos") {
        let mut text = String::new();
        for key in [
            "hw.memsize",
            "machdep.cpu.brand_string",
            "iogpu.wired_limit_mb",
        ] {
            if let crate::telemetry::Bounded::Output(output) = crate::telemetry::run_bounded(
                "sysctl",
                &[key.to_string()],
                TOOL_TIMEOUT,
                TOOL_OUTPUT_LIMIT,
            ) {
                text.push_str(&output);
                text.push('\n');
            }
        }
        sources.apple = Some(parse_sysctl(&text));
    }
    sources
}

/// `amd-smi static --asic --bus --json`, else `rocm-smi --showproductname
/// --showbus --json`: names by lowercase PCI slot.
fn amd_tool_names() -> BTreeMap<String, String> {
    let run = |program: &str, args: &[&str]| -> Option<String> {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        match crate::telemetry::run_bounded(program, &args, TOOL_TIMEOUT, TOOL_OUTPUT_LIMIT) {
            crate::telemetry::Bounded::Output(output) => Some(output),
            _ => None,
        }
    };
    if let Some(names) = run("amd-smi", &["static", "--asic", "--bus", "--json"])
        .map(|text| parse_amd_smi_names(&text))
        .filter(|names| !names.is_empty())
    {
        return names;
    }
    run("rocm-smi", &["--showproductname", "--showbus", "--json"])
        .map(|text| parse_rocm_smi_names(&text))
        .unwrap_or_default()
}

/// The JSON document in a tool's stdout (some versions print a banner,
/// which may hold brackets itself): the first line that starts one.
fn json_in(text: &str) -> Option<serde_json::Value> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.trim_start().starts_with(['[', '{'])
            && let Some(Ok(value)) = serde_json::Deserializer::from_str(&text[offset..])
                .into_iter::<serde_json::Value>()
                .next()
        {
            return Some(value);
        }
        offset += line.len();
    }
    None
}

fn usable_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.eq_ignore_ascii_case("n/a") || name.len() > TEXT_MAX {
        return None;
    }
    (!name.chars().any(char::is_control)).then(|| name.to_string())
}

/// `amd-smi static --asic --bus --json`: a list of GPUs (or an object
/// holding one), each with `asic.market_name` and `bus.bdf`.
pub fn parse_amd_smi_names(text: &str) -> BTreeMap<String, String> {
    let Some(value) = json_in(text) else {
        return BTreeMap::new();
    };
    let list = match value {
        serde_json::Value::Array(list) => list,
        serde_json::Value::Object(mut object) => match object.remove("gpu_data") {
            Some(serde_json::Value::Array(list)) => list,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    list.iter()
        .filter_map(|gpu| {
            let name = gpu.pointer("/asic/market_name")?.as_str()?;
            let bdf = gpu.pointer("/bus/bdf")?.as_str()?;
            Some((bdf.trim().to_ascii_lowercase(), usable_name(name)?))
        })
        .collect()
}

/// `rocm-smi --showproductname --showbus --json`: `{"card0": {"PCI Bus",
/// "Card Series", ...}}`.
pub fn parse_rocm_smi_names(text: &str) -> BTreeMap<String, String> {
    let Some(serde_json::Value::Object(cards)) = json_in(text) else {
        return BTreeMap::new();
    };
    cards
        .values()
        .filter_map(|card| {
            let bus = card.get("PCI Bus")?.as_str()?;
            let name = card.get("Card Series")?.as_str()?;
            Some((bus.trim().to_ascii_lowercase(), usable_name(name)?))
        })
        .collect()
}

/// Generic marketing names say less than the device table.
fn is_generic_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "amd radeon graphics" | "radeon graphics" | "amd radeon(tm) graphics"
    )
}

/// Name each GPU: a specific tool name, else the device table, else a
/// generic tool name.
pub fn name_amd_gpus(gpus: &mut [AmdGpu], names: &BTreeMap<String, String>) {
    for gpu in gpus {
        let tool = names.get(&gpu.pci_slot).cloned();
        let table = gpu.device_id().and_then(|id| {
            APU_DEVICES
                .iter()
                .find(|(known, _)| *known == id)
                .map(|(_, name)| format!("AMD {name}"))
        });
        gpu.name = match tool {
            Some(name) if !is_generic_name(&name) => Some(name),
            other => table.or(other),
        };
    }
}

/// KFD `gfx_target_version` (`major*10000 + minor*100 + stepping`) as the
/// LLVM target name, e.g. 110501 is `gfx1151`, 90012 is `gfx90c`.
pub fn gfx_target(version: u64) -> Option<String> {
    let (major, minor, step) = (version / 10_000, (version / 100) % 100, version % 100);
    if !(1..=99).contains(&major) || minor > 15 || step > 15 {
        return None;
    }
    Some(format!("gfx{major}{minor:x}{step:x}"))
}

fn sysfs_number(path: &Path) -> Option<u64> {
    read_text(path)?.trim().parse().ok()
}

fn uevent_fields(text: &str) -> BTreeMap<&str, &str> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect()
}

/// KFD topology: node id and gfx target by DRM render minor.
fn kfd_nodes(root: &Path) -> BTreeMap<u64, (u64, Option<String>)> {
    let nodes = root.join("sys/class/kfd/kfd/topology/nodes");
    let Ok(entries) = std::fs::read_dir(nodes) else {
        return BTreeMap::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let node = entry.file_name().to_str()?.parse::<u64>().ok()?;
            let text = read_text(&entry.path().join("properties"))?;
            let field = |key: &str| {
                text.lines().find_map(|line| {
                    let (name, value) = line.split_once(' ')?;
                    (name == key).then(|| value.trim().parse::<u64>().ok())?
                })
            };
            let minor = field("drm_render_minor").filter(|minor| *minor > 0)?;
            let target = field("gfx_target_version").and_then(gfx_target);
            Some((minor, (node, target)))
        })
        .collect()
}

/// The render minor of a DRM card (`device/drm/renderD<minor>`).
fn render_minor(device: &Path) -> Option<u64> {
    std::fs::read_dir(device.join("drm"))
        .ok()?
        .filter_map(Result::ok)
        .find_map(|entry| {
            entry
                .file_name()
                .to_str()?
                .strip_prefix("renderD")?
                .parse()
                .ok()
        })
}

/// Every `amdgpu` device under `root/sys/class/drm`, in PCI slot order.
pub fn read_amd_sysfs(root: &Path) -> Vec<AmdGpu> {
    let Ok(entries) = std::fs::read_dir(root.join("sys/class/drm")) else {
        return Vec::new();
    };
    let kfd = kfd_nodes(root);
    let mut gpus: BTreeMap<String, AmdGpu> = BTreeMap::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(card) = name.to_str().and_then(|name| name.strip_prefix("card")) else {
            continue;
        };
        if card.is_empty() || !card.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let device = entry.path().join("device");
        let Some(uevent) = read_text(&device.join("uevent")) else {
            continue;
        };
        let fields = uevent_fields(&uevent);
        if fields.get("DRIVER") != Some(&"amdgpu") {
            continue;
        }
        let Some(slot) = fields.get("PCI_SLOT_NAME") else {
            continue;
        };
        let pci_id = fields
            .get("PCI_ID")
            .map(|id| id.to_ascii_lowercase())
            .filter(|id| is_pci_id(id));
        let gpu = AmdGpu {
            pci_slot: slot.to_ascii_lowercase(),
            pci_id,
            vram_bytes: sysfs_number(&device.join("mem_info_vram_total")),
            gtt_bytes: sysfs_number(&device.join("mem_info_gtt_total")),
            vram_used_bytes: sysfs_number(&device.join("mem_info_vram_used")),
            gtt_used_bytes: sysfs_number(&device.join("mem_info_gtt_used")),
            kfd_node: None,
            gfx_target: None,
            name: None,
        };
        let (kfd_node, gfx_target) = render_minor(&device)
            .and_then(|minor| kfd.get(&minor).cloned())
            .map_or((None, None), |(node, target)| (Some(node), target));
        gpus.entry(gpu.pci_slot.clone()).or_insert(AmdGpu {
            kfd_node,
            gfx_target,
            ..gpu
        });
    }
    // HIP's order: KFD nodes, then (unknown to KFD) PCI slot order.
    let mut gpus: Vec<AmdGpu> = gpus.into_values().collect();
    gpus.sort_by_key(|gpu| (gpu.kfd_node.unwrap_or(u64::MAX), gpu.pci_slot.clone()));
    gpus
}

fn is_pci_id(id: &str) -> bool {
    id.len() == 9
        && id.split_once(':').is_some_and(|(vendor, device)| {
            [vendor, device]
                .iter()
                .all(|part| part.len() == 4 && part.bytes().all(|b| b.is_ascii_hexdigit()))
        })
}

/// `sysctl` `name: value` lines.
pub fn parse_sysctl(text: &str) -> AppleFacts {
    let value = |key: &str| {
        text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == key).then(|| value.trim().to_string())
        })
    };
    AppleFacts {
        memsize_bytes: value("hw.memsize").and_then(|value| value.parse().ok()),
        chip: value("machdep.cpu.brand_string").and_then(|value| usable_name(&value)),
        wired_limit_mib: value("iogpu.wired_limit_mb")
            .and_then(|value| value.parse().ok())
            .filter(|limit| *limit > 0),
    }
}

/// macOS lets the GPU wire about two thirds of memory up to 36 GiB and three
/// quarters above (Metal's recommended working set), unless
/// `iogpu.wired_limit_mb` says otherwise.
fn apple_gpu_limit_mib(memsize_mib: u64, wired_limit_mib: Option<u64>) -> u64 {
    match wired_limit_mib {
        Some(limit) => limit.min(memsize_mib),
        None if memsize_mib <= 36 * 1024 => memsize_mib * 2 / 3,
        None => memsize_mib * 3 / 4,
    }
}

fn mib(bytes: u64) -> u64 {
    bytes / MIB
}

/// A GPU sharing system memory: `memory.total` exactly `[N/A]` on a
/// unified part (GB10, Thor) or an Arm host. An error such as
/// `[Unknown Error]` on a discrete card never makes the node unified.
fn is_unified_nvidia(row: &GpuRow) -> bool {
    row.memory_total_mib.is_none()
        && row.memory_not_applicable
        && (cfg!(target_arch = "aarch64")
            || row
                .name
                .as_deref()
                .is_some_and(|name| name.contains("GB10") || name.contains("Thor")))
}

fn nvidia_info(row: &GpuRow) -> Option<NodeGpuInfo> {
    Some(NodeGpuInfo {
        vendor: GpuVendorWire::Nvidia,
        index: u8::try_from(row.index).ok()?,
        name: row.name.clone(),
        uuid: row.uuid.clone(),
        driver_version: row.driver_version.clone(),
        vram_total_mib: row.memory_total_mib,
        gtt_total_mib: None,
        gfx_target: None,
        apu: is_unified_nvidia(row).then_some(true),
        pci_id: None,
    })
}

/// AMD GPUs with their HIP ordinal (position among all AMD GPUs in KFD
/// order), kept when some are left out, so `amd:N` selects device N.
fn amd_infos<'a>(
    gpus: impl Iterator<Item = (usize, &'a AmdGpu)>,
    gtt_cap_mib: Option<u64>,
) -> Vec<NodeGpuInfo> {
    gpus.filter_map(|(index, gpu)| {
        let gtt = gpu.gtt_bytes.map(mib);
        Some(NodeGpuInfo {
            vendor: GpuVendorWire::Amd,
            index: u8::try_from(index).ok()?,
            name: gpu.name.clone(),
            uuid: None,
            driver_version: None,
            vram_total_mib: gpu.vram_bytes.map(mib),
            gtt_total_mib: match (gtt, gtt_cap_mib) {
                (Some(gtt), Some(cap)) => Some(gtt.min(cap)),
                (gtt, _) => gtt,
            },
            gfx_target: gpu.gfx_target.clone(),
            apu: Some(gpu.is_apu()),
            pci_id: gpu.pci_id.clone(),
        })
    })
    .collect()
}

/// `node.metrics` rows for AMD GPUs: memory in use from sysfs, indexed like
/// [`amd_infos`] (HIP ordinals, an integrated GPU beside a discrete one left
/// out). Metrics rows carry no vendor, so the caller sends these only when
/// no NVIDIA GPU answered.
pub fn amd_metrics(gpus: &[AmdGpu]) -> Vec<NodeGpuMetrics> {
    let any_discrete = gpus.iter().any(|gpu| !gpu.is_apu());
    gpus.iter()
        .enumerate()
        .filter(|(_, gpu)| !(any_discrete && gpu.is_apu()))
        .filter_map(|(index, gpu)| {
            Some(NodeGpuMetrics {
                index: u8::try_from(index).ok()?,
                vram_used_mib: gpu.vram_used_bytes.map(mib),
                vram_total_mib: gpu.vram_bytes.map(mib),
                gtt_used_mib: gpu.gtt_used_bytes.map(mib),
                utilization_percent: None,
                temperature_c: None,
                power_w: None,
                sm_clock_mhz: None,
            })
        })
        .take(crate::protocol::NODE_GPU_MAX)
        .collect()
}

fn describe(gpu: &AmdGpu) -> String {
    gpu.name
        .clone()
        .or_else(|| gpu.pci_id.clone())
        .unwrap_or_else(|| gpu.pci_slot.clone())
}

/// Build the report from gathered sources. Pure.
pub fn assemble(sources: Sources) -> Hardware {
    let mut notes = Vec::new();
    let meminfo = sources.meminfo_total_mib;
    let gtt_cap_mib = sources
        .ttm_pages_limit
        .map(|pages| mib(pages.saturating_mul(TTM_PAGE_BYTES)));
    let cpu_model = sources
        .cpu_model
        .clone()
        .or_else(|| sources.apple.as_ref().and_then(|facts| facts.chip.clone()));
    let apple_silicon = sources.apple.as_ref().filter(|facts| {
        facts
            .chip
            .as_deref()
            .is_some_and(|chip| chip.starts_with("Apple"))
    });
    let physical_mib = meminfo.or_else(|| {
        sources
            .apple
            .as_ref()
            .and_then(|facts| facts.memsize_bytes.map(mib))
    });

    let nvidia_unified = sources.nvidia.iter().any(is_unified_nvidia);
    let nvidia_other = sources.nvidia.iter().any(|row| !is_unified_nvidia(row));
    let amd_discrete: Vec<&AmdGpu> = sources.amd.iter().filter(|gpu| !gpu.is_apu()).collect();

    // Discrete accelerators decide the kind: an integrated GPU beside one
    // (a desktop CPU's iGPU) is not where models go, and listing it would
    // make it a placement target.
    if nvidia_other || !amd_discrete.is_empty() {
        let mut gpus: Vec<NodeGpuInfo> = sources.nvidia.iter().filter_map(nvidia_info).collect();
        gpus.extend(amd_infos(
            sources
                .amd
                .iter()
                .enumerate()
                .filter(|(_, gpu)| !gpu.is_apu()),
            gtt_cap_mib,
        ));
        gpus.truncate(crate::protocol::NODE_GPU_MAX);
        let unknown = sources
            .nvidia
            .iter()
            .filter(|row| row.memory_total_mib.is_none())
            .count();
        let total = sources
            .nvidia
            .iter()
            .filter_map(|row| row.memory_total_mib)
            .chain(
                amd_discrete
                    .iter()
                    .filter_map(|gpu| gpu.vram_bytes.map(mib)),
            )
            .fold(0u64, u64::saturating_add);
        notes.push(format!(
            "discrete: accelerator memory is the sum of dedicated VRAM ({total} MiB)"
        ));
        if unknown > 0 {
            notes.push(format!(
                "{unknown} NVIDIA GPU(s) reported no memory total (a driver error?): listed, not counted"
            ));
        }
        for apu in sources.amd.iter().filter(|gpu| gpu.is_apu()) {
            notes.push(format!(
                "integrated GPU {} beside discrete ones: not listed, not counted",
                describe(apu)
            ));
        }
        return Hardware {
            node_kind: NodeKind::Discrete,
            memory_total_mib: physical_mib,
            unified_memory_mib: None,
            accelerator_memory_mib: (total > 0).then_some(total),
            cpu_model,
            gpus,
            notes,
        };
    }

    let mut gpus: Vec<NodeGpuInfo> = sources.nvidia.iter().filter_map(nvidia_info).collect();
    gpus.extend(amd_infos(sources.amd.iter().enumerate(), gtt_cap_mib));
    if let Some(facts) = apple_silicon {
        gpus.push(NodeGpuInfo {
            vendor: GpuVendorWire::Apple,
            index: 0,
            name: facts.chip.clone(),
            uuid: None,
            driver_version: None,
            vram_total_mib: None,
            gtt_total_mib: None,
            gfx_target: None,
            apu: Some(true),
            pci_id: None,
        });
    }
    gpus.truncate(crate::protocol::NODE_GPU_MAX);
    let unified = |pool: Option<u64>, physical: Option<u64>, notes: Vec<String>, gpus| Hardware {
        node_kind: NodeKind::Unified,
        memory_total_mib: physical,
        unified_memory_mib: pool,
        accelerator_memory_mib: pool,
        cpu_model: cpu_model.clone(),
        gpus,
        notes,
    };

    if nvidia_unified {
        notes.push(
            "unified (NVIDIA, no dedicated VRAM): the pool is MemTotal; \
             the server keeps 2 GiB headroom"
                .into(),
        );
        return unified(meminfo, meminfo, notes, gpus);
    }

    if let Some(apu) = sources.amd.iter().find(|gpu| gpu.is_apu()) {
        let vram = apu.vram_bytes.map(mib).unwrap_or(0);
        let raw_gtt = apu.gtt_bytes.map(mib).unwrap_or(0);
        let gtt = gtt_cap_mib.map_or(raw_gtt, |cap| raw_gtt.min(cap));
        // `MemTotal` excludes the BIOS carve-out.
        let physical = meminfo.map(|total| total.saturating_add(vram));
        let addressable = vram.saturating_add(gtt);
        // Unknown GPU limits leave the pool unreported: placement then falls
        // back to physical memory, as it would without this report.
        let pool = (addressable > 0).then(|| physical.map_or(addressable, |p| addressable.min(p)));
        let unknown = || "unknown".to_string();
        notes.push(format!(
            "unified (AMD APU): pool = min(VRAM carve-out {vram} MiB + GTT {gtt} MiB, \
             physical {} MiB)",
            physical.map_or_else(unknown, |value| value.to_string())
        ));
        if gtt < raw_gtt {
            notes.push(format!(
                "GTT is {raw_gtt} MiB but ttm.pages_limit caps allocations at {gtt} MiB; \
                 raise ttm.pages_limit (and ttm.page_pool_size) to use more"
            ));
        }
        return unified(pool, physical, notes, gpus);
    }

    if let Some(facts) = apple_silicon {
        let physical = facts.memsize_bytes.map(mib);
        let pool = physical.map(|total| apple_gpu_limit_mib(total, facts.wired_limit_mib));
        notes.push(match facts.wired_limit_mib {
            Some(limit) => format!("unified (Apple): pool = iogpu.wired_limit_mb ({limit} MiB)"),
            None => {
                "unified (Apple): pool = macOS default GPU share (2/3 up to 36 GiB, 3/4 above); \
                     set iogpu.wired_limit_mb to change it"
                    .into()
            }
        });
        return unified(pool, physical, notes, gpus);
    }

    notes.push("cpu: no accelerator found".into());
    Hardware {
        node_kind: NodeKind::Cpu,
        memory_total_mib: physical_mib,
        unified_memory_mib: None,
        accelerator_memory_mib: None,
        cpu_model,
        gpus,
        notes,
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::telemetry::{parse_cpu_model, parse_meminfo, parse_nvidia_smi};
    use std::path::PathBuf;

    pub const MACHINES: &[&str] = &[
        "dgx-spark-gb10",
        "strix-halo",
        "strix-halo-uma96",
        "rtx-3090",
        "apple-m3-max",
    ];

    fn fixture_dir(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/hardware")
            .join(name)
    }

    fn fixture(machine: &str, file: &str) -> String {
        std::fs::read_to_string(fixture_dir(machine).join(file)).unwrap_or_default()
    }

    pub fn sources(machine: &str) -> Sources {
        let root = fixture_dir(machine).join("root");
        let mut amd = read_amd_sysfs(&root);
        let mut names = parse_amd_smi_names(&fixture(machine, "amd-smi-static.json"));
        if names.is_empty() {
            names = parse_rocm_smi_names(&fixture(machine, "rocm-smi.json"));
        }
        name_amd_gpus(&mut amd, &names);
        let sysctl = fixture(machine, "sysctl.txt");
        Sources {
            meminfo_total_mib: parse_meminfo(&fixture(machine, "root/proc/meminfo"))
                .get("MemTotal")
                .copied(),
            cpu_model: parse_cpu_model(&fixture(machine, "root/proc/cpuinfo")),
            nvidia: parse_nvidia_smi(&fixture(machine, "nvidia-smi.csv")),
            amd,
            ttm_pages_limit: read_ttm_pages_limit(&root),
            apple: (!sysctl.is_empty()).then(|| parse_sysctl(&sysctl)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{MACHINES, sources};
    use super::*;

    #[test]
    fn dgx_spark_gb10_is_unified_with_memtotal_as_its_pool() {
        let hardware = assemble(sources("dgx-spark-gb10"));
        assert_eq!(hardware.node_kind, NodeKind::Unified);
        assert_eq!(hardware.memory_total_mib, Some(122357));
        assert_eq!(hardware.unified_memory_mib, Some(122357));
        assert_eq!(hardware.accelerator_memory_mib, Some(122357));
        assert_eq!(hardware.gpus.len(), 1);
        let gpu = &hardware.gpus[0];
        assert_eq!(gpu.vendor, GpuVendorWire::Nvidia);
        assert_eq!(gpu.name.as_deref(), Some("NVIDIA GB10"));
        assert_eq!(gpu.vram_total_mib, None);
        assert_eq!(gpu.apu, Some(true));
        assert_eq!(gpu.driver_version.as_deref(), Some("580.95.05"));
        assert_eq!(
            hardware.cpu_model.as_deref(),
            Some("10x Arm Cortex-X925 + 10x Arm Cortex-A725")
        );
    }

    #[test]
    fn strix_halo_pool_is_carve_out_plus_gtt_within_physical_memory() {
        let hardware = assemble(sources("strix-halo"));
        assert_eq!(hardware.node_kind, NodeKind::Unified);
        // MemTotal 127494 MiB + 512 MiB carve-out.
        assert_eq!(hardware.memory_total_mib, Some(128006));
        // 512 MiB VRAM + 120 GiB GTT (ttm.pages_limit=31457280).
        assert_eq!(hardware.unified_memory_mib, Some(123392));
        assert_eq!(hardware.accelerator_memory_mib, Some(123392));
        let gpu = &hardware.gpus[0];
        assert_eq!(gpu.vendor, GpuVendorWire::Amd);
        assert_eq!(gpu.name.as_deref(), Some("AMD Radeon 8060S Graphics"));
        assert_eq!(gpu.gfx_target.as_deref(), Some("gfx1151"));
        assert_eq!(gpu.pci_id.as_deref(), Some("1002:1586"));
        assert_eq!(gpu.vram_total_mib, Some(512));
        assert_eq!(gpu.gtt_total_mib, Some(122880));
        assert_eq!(gpu.apu, Some(true));
        assert_eq!(
            hardware.cpu_model.as_deref(),
            Some("AMD RYZEN AI MAX+ 395 w/ Radeon 8060S")
        );
    }

    #[test]
    fn strix_halo_with_a_96_gib_carve_out_and_default_gtt() {
        let hardware = assemble(sources("strix-halo-uma96"));
        assert_eq!(hardware.node_kind, NodeKind::Unified);
        // MemTotal 31618 MiB excludes the 96 GiB carve-out.
        assert_eq!(hardware.memory_total_mib, Some(31618 + 98304));
        // 96 GiB VRAM + default GTT (half of MemTotal, 15809 MiB).
        assert_eq!(hardware.unified_memory_mib, Some(98304 + 15809));
        // rocm-smi names it generically: the device table is more specific.
        assert_eq!(
            hardware.gpus[0].name.as_deref(),
            Some("AMD Radeon 8050S/8060S (Strix Halo)")
        );
    }

    #[test]
    fn rtx_3090_is_discrete_and_an_integrated_gpu_beside_it_is_not_counted() {
        let hardware = assemble(sources("rtx-3090"));
        assert_eq!(hardware.node_kind, NodeKind::Discrete);
        assert_eq!(hardware.memory_total_mib, Some(63943));
        assert_eq!(hardware.unified_memory_mib, None);
        assert_eq!(hardware.accelerator_memory_mib, Some(24576));
        let nvidia = &hardware.gpus[0];
        assert_eq!(nvidia.name.as_deref(), Some("NVIDIA GeForce RTX 3090"));
        assert_eq!(nvidia.vram_total_mib, Some(24576));
        assert_eq!(nvidia.apu, None);
        // The Raphael iGPU is not a placement target: only a note names it.
        assert_eq!(hardware.gpus.len(), 1);
        assert!(
            hardware
                .notes
                .iter()
                .any(|note| note.contains("AMD Radeon Graphics (Raphael)"))
        );
        let raphael = read_amd_sysfs(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hardware/rtx-3090/root"),
        );
        assert_eq!(raphael[0].gfx_target.as_deref(), Some("gfx1036"));
        assert!(raphael[0].is_apu());
    }

    #[test]
    fn a_driver_error_on_a_discrete_nvidia_gpu_never_makes_the_node_unified() {
        let mut sources = sources("rtx-3090");
        sources.nvidia = crate::telemetry::parse_nvidia_smi(
            "0, NVIDIA GeForce RTX 3090, GPU-x, 580.82.09, [Unknown Error], [Unknown Error], 0, 34, 28.61, 210\n",
        );
        let hardware = assemble(sources);
        assert_eq!(hardware.node_kind, NodeKind::Discrete);
        assert_eq!(hardware.unified_memory_mib, None);
        assert_eq!(hardware.accelerator_memory_mib, None);
        assert_eq!(hardware.gpus[0].apu, None);
        assert!(
            hardware
                .notes
                .iter()
                .any(|note| note.contains("no memory total"))
        );
    }

    #[test]
    fn gtt_beyond_the_ttm_page_limit_is_not_counted() {
        // `amdgpu.gttsize=122880` without `ttm.pages_limit`: TTM keeps its
        // default, half of RAM (127494 MiB / 2 in 4 KiB pages).
        let mut sources = sources("strix-halo");
        sources.ttm_pages_limit = Some(127_494 * 256 / 2);
        let hardware = assemble(sources);
        assert_eq!(hardware.unified_memory_mib, Some(512 + 63_747));
        assert_eq!(hardware.gpus[0].gtt_total_mib, Some(63_747));
        assert!(
            hardware
                .notes
                .iter()
                .any(|note| note.contains("ttm.pages_limit"))
        );
    }

    #[test]
    fn apple_silicon_pool_follows_the_wired_limit() {
        let hardware = assemble(sources("apple-m3-max"));
        assert_eq!(hardware.node_kind, NodeKind::Unified);
        assert_eq!(hardware.memory_total_mib, Some(131072));
        assert_eq!(hardware.unified_memory_mib, Some(98304));
        assert_eq!(hardware.gpus[0].vendor, GpuVendorWire::Apple);
        assert_eq!(hardware.gpus[0].name.as_deref(), Some("Apple M3 Max"));
        assert_eq!(hardware.cpu_model.as_deref(), Some("Apple M3 Max"));

        let mut tuned = parse_sysctl(
            "hw.memsize: 137438953472\nmachdep.cpu.brand_string: Apple M3 Max\niogpu.wired_limit_mb: 122880\n",
        );
        assert_eq!(tuned.wired_limit_mib, Some(122880));
        tuned.wired_limit_mib = Some(999_999);
        assert_eq!(apple_gpu_limit_mib(131072, tuned.wired_limit_mib), 131072);
        assert_eq!(apple_gpu_limit_mib(16384, None), 10922);
    }

    #[test]
    fn an_apu_with_unreadable_memory_files_reports_no_pool() {
        let hardware = assemble(Sources {
            meminfo_total_mib: Some(127494),
            amd: vec![AmdGpu {
                kfd_node: None,
                pci_slot: "0000:c5:00.0".into(),
                pci_id: Some("1002:1586".into()),
                vram_bytes: None,
                gtt_bytes: None,
                vram_used_bytes: None,
                gtt_used_bytes: None,
                gfx_target: None,
                name: None,
            }],
            ..Sources::default()
        });
        assert_eq!(hardware.node_kind, NodeKind::Unified);
        assert_eq!(hardware.memory_total_mib, Some(127494));
        assert_eq!(hardware.unified_memory_mib, None);
        assert_eq!(hardware.accelerator_memory_mib, None);
    }

    #[test]
    fn no_accelerator_is_a_cpu_node() {
        let hardware = assemble(Sources {
            meminfo_total_mib: Some(64000),
            ..Sources::default()
        });
        assert_eq!(hardware.node_kind, NodeKind::Cpu);
        assert_eq!(hardware.memory_total_mib, Some(64000));
        assert_eq!(hardware.accelerator_memory_mib, None);
        assert!(hardware.gpus.is_empty());
    }

    #[test]
    fn amd_indexes_stay_hip_ordinals_when_an_igpu_comes_first() {
        let card = |node: u64, slot: &str, id: &str, gfx: &str, vram_gib: u64| AmdGpu {
            kfd_node: Some(node),
            pci_slot: slot.into(),
            pci_id: Some(id.into()),
            vram_bytes: Some(vram_gib * 1024 * MIB),
            gtt_bytes: Some(32 * 1024 * MIB),
            vram_used_bytes: Some(MIB),
            gtt_used_bytes: None,
            gfx_target: Some(gfx.into()),
            name: None,
        };
        let hardware = assemble(Sources {
            meminfo_total_mib: Some(64000),
            amd: vec![
                card(1, "0000:03:00.0", "1002:744c", "gfx1100", 24),
                card(2, "0000:13:00.0", "1002:164e", "gfx1036", 0),
                card(3, "0000:2a:00.0", "1002:744c", "gfx1100", 24),
            ],
            ..Sources::default()
        });
        let indexes: Vec<u8> = hardware.gpus.iter().map(|gpu| gpu.index).collect();
        assert_eq!(indexes, vec![0, 2]);
        assert_eq!(hardware.accelerator_memory_mib, Some(49152));
        let cards = [
            card(1, "0000:03:00.0", "1002:744c", "gfx1100", 24),
            card(2, "0000:13:00.0", "1002:164e", "gfx1036", 0),
            card(3, "0000:2a:00.0", "1002:744c", "gfx1100", 24),
        ];
        let metrics = amd_metrics(&cards);
        let indexes: Vec<u8> = metrics.iter().map(|gpu| gpu.index).collect();
        assert_eq!(indexes, vec![0, 2]);
        assert_eq!(metrics[0].vram_used_mib, Some(1));
        assert_eq!(metrics[0].vram_total_mib, Some(24576));
    }

    #[test]
    fn sysfs_cards_are_ordered_by_kfd_node() {
        let gpus = read_amd_sysfs(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hardware/strix-halo/root"),
        );
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].kfd_node, Some(1));
        assert_eq!(gpus[0].gfx_target.as_deref(), Some("gfx1151"));
        let metrics = amd_metrics(&gpus);
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].index, 0);
        assert_eq!(metrics[0].vram_used_mib, Some(256));
        assert_eq!(metrics[0].gtt_used_mib, Some(2048));
    }

    #[test]
    fn a_discrete_amd_card_counts_its_vram() {
        let gpu = AmdGpu {
            kfd_node: Some(1),
            pci_slot: "0000:03:00.0".into(),
            pci_id: Some("1002:744c".into()),
            vram_bytes: Some(24 * 1024 * MIB),
            gtt_bytes: Some(32 * 1024 * MIB),
            vram_used_bytes: None,
            gtt_used_bytes: None,
            gfx_target: Some("gfx1100".into()),
            name: Some("AMD Radeon RX 7900 XTX".into()),
        };
        assert!(!gpu.is_apu());
        let hardware = assemble(Sources {
            meminfo_total_mib: Some(64000),
            amd: vec![gpu],
            ..Sources::default()
        });
        assert_eq!(hardware.node_kind, NodeKind::Discrete);
        assert_eq!(hardware.accelerator_memory_mib, Some(24576));
    }

    #[test]
    fn gfx_targets_and_tool_outputs_parse() {
        assert_eq!(gfx_target(110501).as_deref(), Some("gfx1151"));
        assert_eq!(gfx_target(90012).as_deref(), Some("gfx90c"));
        assert_eq!(gfx_target(100300).as_deref(), Some("gfx1030"));
        assert_eq!(gfx_target(0), None);
        assert_eq!(gfx_target(4_294_967_295), None);
        // A banner holding brackets before the JSON.
        let names = parse_amd_smi_names(
            "[WARNING] driver {old}\n[{\"gpu\":0,\"asic\":{\"market_name\":\"AMD Radeon RX 7900 XTX\"},\"bus\":{\"bdf\":\"0000:03:00.0\"}}]",
        );
        assert_eq!(names.len(), 1);
        // And a footer after it.
        let names = parse_amd_smi_names(
            "[{\"gpu\":0,\"asic\":{\"market_name\":\"AMD Radeon RX 7900 XTX\"},\"bus\":{\"bdf\":\"0000:03:00.0\"}}]\nWARNING: done\n",
        );
        assert_eq!(names.len(), 1);
        // A banner before the JSON and an `N/A` name.
        let names = parse_amd_smi_names(
            "WARNING: something\n[{\"gpu\":0,\"asic\":{\"market_name\":\"N/A\"},\"bus\":{\"bdf\":\"0000:03:00.0\"}}]",
        );
        assert!(names.is_empty());
        let names = parse_amd_smi_names(
            "{\"gpu_data\":[{\"gpu\":0,\"asic\":{\"market_name\":\"AMD Radeon RX 7900 XTX\"},\"bus\":{\"bdf\":\"0000:03:00.0\"}}]}",
        );
        assert_eq!(
            names.get("0000:03:00.0").map(String::as_str),
            Some("AMD Radeon RX 7900 XTX")
        );
    }

    #[test]
    fn the_wire_frame_built_from_each_fixture_is_valid_json_for_node_info() {
        for machine in MACHINES {
            let hardware = assemble(sources(machine));
            for gpu in &hardware.gpus {
                if let Some(target) = &gpu.gfx_target {
                    let digits = target.strip_prefix("gfx").unwrap_or_default();
                    assert!(
                        (3..=5).contains(&digits.len())
                            && digits
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                        "{target}"
                    );
                }
                if let Some(id) = &gpu.pci_id {
                    assert!(is_pci_id(id), "{id}");
                }
            }
            assert!(serde_json::to_string(&hardware).is_ok(), "{machine}");
        }
    }
}
