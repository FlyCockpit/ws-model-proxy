import { describe, expect, it } from "vitest";
import { effectiveHardware } from "./hardware";

const NOW = new Date("2026-10-08T00:00:00Z");

function hardwareOf(nodeInfo: unknown, declaredResources: unknown = null) {
  return effectiveHardware({
    declaredResources,
    nodeInfo,
    nodeMetrics: null,
    nodeMetricsAt: null,
    heldClaims: [],
    now: NOW,
  });
}

/** What a DGX Spark's CLI reports (`apps/cli/src/hardware.rs`, fixture dgx-spark-gb10). */
const GB10_INFO = {
  nodeKind: "unified",
  memoryTotalMiB: 122357,
  unifiedMemoryMiB: 122357,
  acceleratorMemoryMiB: 122357,
  gpus: [{ vendor: "nvidia", index: 0, name: "NVIDIA GB10", vramTotalMiB: null, apu: true }],
};

describe("effectiveHardware: unified GPUs", () => {
  it("reports a GB10 as sharing system memory, not 0 GiB of VRAM", () => {
    const hardware = hardwareOf(GB10_INFO);
    expect(hardware.kind.value).toBe("unified");
    expect(hardware.gpus).toEqual([
      {
        key: "nvidia:0",
        vendor: "nvidia",
        index: 0,
        name: "NVIDIA GB10",
        vramGb: null,
        unified: true,
        reservedVramGb: 0,
        source: "detected",
      },
    ]);
    expect(hardware.acceleratorMemoryGb.value).toBe(119.49);
    expect(hardware.usableMemoryGb).toBe(117.49);
  });

  it("treats a GPU without VRAM of its own on a unified node as shared, even without apu", () => {
    const hardware = hardwareOf({
      ...GB10_INFO,
      gpus: [{ vendor: "nvidia", index: 0, name: "NVIDIA GB10", vramTotalMiB: null }],
    });
    expect(hardware.gpus[0]).toMatchObject({ vramGb: null, unified: true });
  });

  it("treats an APU's carve-out as shared memory, not VRAM", () => {
    const hardware = hardwareOf({
      nodeKind: "unified",
      memoryTotalMiB: 131072,
      unifiedMemoryMiB: 114113,
      gpus: [{ vendor: "amd", index: 0, vramTotalMiB: 512, apu: true }],
    });
    expect(hardware.gpus[0]).toMatchObject({ vramGb: null, unified: true });
    expect(hardware.acceleratorMemoryGb.value).toBeNull();
  });

  it("keeps discrete VRAM, and a declared GPU is never unified", () => {
    const hardware = hardwareOf(
      {
        nodeKind: "discrete",
        memoryTotalMiB: 65536,
        gpus: [{ vendor: "nvidia", index: 0, vramTotalMiB: 24576 }],
      },
      { gpus: [{ vendor: "amd", index: 1, vramGb: 16 }] },
    );
    expect(hardware.gpus.map((gpu) => [gpu.key, gpu.vramGb, gpu.unified])).toEqual([
      ["amd:1", 16, false],
      ["nvidia:0", 24, false],
    ]);
  });
});
