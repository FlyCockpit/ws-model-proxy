//! `wsmp hardware`: what this node detects, so a person can check it before
//! declaring overrides. Placement uses a declaration (Nodes page, or the
//! node's own config) first and these detected values only as a fallback.

use anyhow::Result;
use serde::Serialize;

use crate::display_escape::escape_single_line;
use crate::hardware::Hardware;
use crate::output;
use crate::protocol::frames::{GpuVendorWire, NodeGpuInfo, NodeKind};

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit the detected hardware as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    detected: &'a Hardware,
}

pub fn run(args: &Args) -> Result<()> {
    let hardware = crate::hardware::detect(crate::telemetry::query_nvidia());
    if args.json {
        return output::json(&Report {
            detected: &hardware,
        });
    }
    for line in format_hardware(&hardware) {
        output::line(line)?;
    }
    Ok(())
}

fn size(mib: u64) -> String {
    format!("{:.1} GiB ({mib} MiB)", mib as f64 / 1024.0)
}

fn vendor(vendor: GpuVendorWire) -> &'static str {
    match vendor {
        GpuVendorWire::Nvidia => "nvidia",
        GpuVendorWire::Amd => "amd",
        GpuVendorWire::Intel => "intel",
        GpuVendorWire::Apple => "apple",
        GpuVendorWire::Other => "other",
    }
}

fn gpu_line(gpu: &NodeGpuInfo) -> String {
    let mut parts = vec![format!("{}:{}", vendor(gpu.vendor), gpu.index)];
    parts.push(
        gpu.name
            .as_deref()
            .map_or_else(|| "unnamed".to_string(), escape_single_line),
    );
    if gpu.apu == Some(true) {
        parts.push("integrated".into());
    }
    match gpu.vram_total_mib {
        Some(mib) => parts.push(format!("vram {}", size(mib))),
        None => parts.push("vram shared".into()),
    }
    if let Some(gtt) = gpu.gtt_total_mib {
        parts.push(format!("gtt {}", size(gtt)));
    }
    for extra in [&gpu.gfx_target, &gpu.pci_id, &gpu.driver_version]
        .into_iter()
        .flatten()
    {
        parts.push(escape_single_line(extra));
    }
    parts.join("  ")
}

/// The text report.
pub fn format_hardware(hardware: &Hardware) -> Vec<String> {
    let kind = match hardware.node_kind {
        NodeKind::Unified => "unified",
        NodeKind::Discrete => "discrete",
        NodeKind::Cpu => "cpu",
    };
    let unknown = || "unknown".to_string();
    let mut lines = vec![
        format!("kind: {kind}"),
        format!(
            "cpu: {}",
            hardware
                .cpu_model
                .as_deref()
                .map_or_else(unknown, escape_single_line)
        ),
        format!(
            "memory: {}",
            hardware.memory_total_mib.map_or_else(unknown, size)
        ),
    ];
    if hardware.node_kind == NodeKind::Unified {
        lines.push(format!(
            "model memory (unified pool): {}",
            hardware.unified_memory_mib.map_or_else(unknown, size)
        ));
    } else if hardware.node_kind == NodeKind::Discrete {
        lines.push(format!(
            "accelerator memory: {}",
            hardware.accelerator_memory_mib.map_or_else(unknown, size)
        ));
    }
    if hardware.gpus.is_empty() {
        lines.push("gpus: none".into());
    } else {
        lines.push("gpus:".into());
        lines.extend(
            hardware
                .gpus
                .iter()
                .map(|gpu| format!("  {}", gpu_line(gpu))),
        );
    }
    if !hardware.notes.is_empty() {
        lines.push("notes:".into());
        lines.extend(hardware.notes.iter().map(|note| format!("  - {note}")));
    }
    lines.push(
        "placement uses a declaration (Nodes page, or this node's config) before these values"
            .into(),
    );
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::assemble;
    use crate::hardware::fixtures::{MACHINES, sources};

    #[test]
    fn the_text_report_names_the_pool_for_each_recorded_machine() {
        let strix = format_hardware(&assemble(sources("strix-halo")));
        assert_eq!(strix[0], "kind: unified");
        assert!(strix.contains(&"model memory (unified pool): 120.5 GiB (123392 MiB)".into()));
        assert!(strix.iter().any(|line| line
            == "  amd:0  AMD Radeon 8060S Graphics  integrated  vram 0.5 GiB (512 MiB)  gtt 120.0 GiB (122880 MiB)  gfx1151  1002:1586"));

        let spark = format_hardware(&assemble(sources("dgx-spark-gb10")));
        assert!(spark.contains(&"model memory (unified pool): 119.5 GiB (122357 MiB)".into()));
        assert!(
            spark
                .iter()
                .any(|line| line.contains("nvidia:0  NVIDIA GB10  integrated  vram shared"))
        );

        let rtx = format_hardware(&assemble(sources("rtx-3090")));
        assert_eq!(rtx[0], "kind: discrete");
        assert!(rtx.contains(&"accelerator memory: 24.0 GiB (24576 MiB)".into()));
        assert!(!rtx.iter().any(|line| line.starts_with("  amd:")));

        for machine in MACHINES {
            let lines = format_hardware(&assemble(sources(machine)));
            assert!(
                lines.iter().all(|line| !line.contains('\u{1b}')),
                "{machine}"
            );
        }
    }

    #[test]
    fn untrusted_names_are_escaped() {
        let mut hardware = assemble(sources("rtx-3090"));
        hardware.gpus[0].name = Some("evil\u{1b}]8;;x\u{7}name".into());
        let lines = format_hardware(&hardware);
        assert!(lines.iter().all(|line| !line.contains('\u{1b}')));
    }
}
