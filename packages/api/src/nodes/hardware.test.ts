import { describe, expect, it } from "vitest";
import { effectiveHardware, fabricSuggestions } from "./hardware";

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

function iface(
  name: string,
  address: string,
  link: { linkSpeedMbps?: number; rdma?: boolean } = {},
) {
  return { name, addresses: [address], ...link };
}

describe("fabricSuggestions", () => {
  it("suggests only peers whose link on that subnet is also fast or RDMA", () => {
    const spark = {
      interfaces: [
        iface("enp1s0", "192.168.1.10/24", { linkSpeedMbps: 10_000 }),
        iface("wlan0", "192.168.2.10/24", { linkSpeedMbps: 1_000 }),
      ],
    };
    const otherSpark = {
      id: "spark-2",
      nodeInfo: { interfaces: [iface("enp1s0", "192.168.1.11/24", { linkSpeedMbps: 25_000 })] },
    };
    // A Strix Halo on the plain LAN of the same /24.
    const strix = {
      id: "strix",
      nodeInfo: { interfaces: [iface("eno1", "192.168.1.20/24", { linkSpeedMbps: 2_500 })] },
    };
    const unknownSpeed = {
      id: "unknown",
      nodeInfo: { interfaces: [iface("eth0", "192.168.1.30/24")] },
    };
    expect(fabricSuggestions(spark, [strix, otherSpark, unknownSpeed])).toEqual([
      { ip: "192.168.1.10", linkSpeedMbps: 10_000, rdma: false, peerNodeIds: ["spark-2"] },
    ]);
  });

  it("accepts a slow link with RDMA on either side", () => {
    const local = { interfaces: [iface("ib0", "10.0.0.1/24", { rdma: true })] };
    const peer = {
      id: "p",
      nodeInfo: { interfaces: [iface("ib0", "10.0.0.2/24", { rdma: true })] },
    };
    expect(fabricSuggestions(local, [peer])).toEqual([
      { ip: "10.0.0.1", linkSpeedMbps: null, rdma: true, peerNodeIds: ["p"] },
    ]);
  });

  it("prefers RDMA links, and RDMA peers within a link", () => {
    const local = {
      interfaces: [
        iface("enp1s0", "10.1.0.1/24", { linkSpeedMbps: 100_000 }),
        iface("rdma0", "10.2.0.1/24", { linkSpeedMbps: 200_000, rdma: true }),
        iface("enp2s0", "10.3.0.1/24", { linkSpeedMbps: 10_000 }),
      ],
    };
    const tcp = {
      id: "tcp",
      nodeInfo: { interfaces: [iface("enp1s0", "10.2.0.2/24", { linkSpeedMbps: 100_000 })] },
    };
    const rdma = {
      id: "rdma",
      nodeInfo: { interfaces: [iface("rdma0", "10.2.0.3/24", { rdma: true })] },
    };
    const result = fabricSuggestions(local, [tcp, rdma]);
    expect(result.map((suggestion) => suggestion.ip)).toEqual(["10.2.0.1", "10.1.0.1", "10.3.0.1"]);
    expect(result[0]?.peerNodeIds).toEqual(["rdma", "tcp"]);
  });
});
