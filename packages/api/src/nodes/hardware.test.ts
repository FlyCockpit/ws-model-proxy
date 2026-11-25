import { describe, expect, it } from "vitest";
import { nodesContract } from "../contracts/nodes";
import { declaredHardwareSchema } from "../lib/runtime-spec";
import { effectiveHardware, fabricSuggestions, ramOnlyMemoryBudgetGb } from "./hardware";

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

/** What a DGX Spark's CLI reports (`apps/cli/src/host/hardware.rs`, fixture dgx-spark-gb10). */
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

  it("counts VRAM held on a unified GPU in what runtimes reserve now", () => {
    const hardware = effectiveHardware({
      declaredResources: null,
      nodeInfo: GB10_INFO,
      nodeMetrics: null,
      nodeMetricsAt: null,
      heldClaims: [
        {
          current: [{ kind: "discrete", gpuCount: 1, vramGb: 40, ramGb: 4, gpus: ["nvidia:0"] }],
          previous: [],
        },
        // Written before claims recorded their GPUs: every GPU here is unified.
        { current: [{ kind: "discrete", gpuCount: 1, vramGb: 10 }], previous: [] },
        { current: [{ kind: "unified", memoryGb: 20 }], previous: [] },
      ],
      now: NOW,
    });
    expect(hardware.reservedNowMemoryGb).toBe(74);
  });

  it("keeps the memory a claim took on a unified GPU when the node stops reporting it", () => {
    // Reconnected after a failed GPU detection: the node reports its memory and no GPU.
    const held = (claim: Record<string, unknown>) =>
      effectiveHardware({
        declaredResources: null,
        nodeInfo: { ...GB10_INFO, gpus: [] },
        nodeMetrics: null,
        nodeMetricsAt: null,
        heldClaims: [{ current: [claim], previous: [] }],
        now: NOW,
      }).reservedNowMemoryGb;
    const discrete = { kind: "discrete", gpuCount: 1, vramGb: 96, gpus: ["nvidia:0"] };
    // Recorded unified when admitted.
    expect(held({ ...discrete, unifiedGpus: ["nvidia:0"] })).toBe(96);
    // Recorded before claims said which: a GPU gone from the report may have been unified.
    expect(held(discrete)).toBe(96);
    // Recorded as a discrete GPU: its VRAM was never node memory.
    expect(held({ ...discrete, unifiedGpus: [] })).toBe(0);
  });

  it("counts the unified memory a claim without recorded GPUs may hold on a mixed node, as placement does", () => {
    // One unified and one dedicated NVIDIA GPU: an unrecorded 32 GiB claim may be on either.
    const hardware = effectiveHardware({
      declaredResources: null,
      nodeInfo: {
        nodeKind: "unified",
        memoryTotalMiB: 65536,
        unifiedMemoryMiB: 65536,
        gpus: [
          { vendor: "nvidia", index: 0, name: "iGPU", vramTotalMiB: null, apu: true },
          { vendor: "nvidia", index: 1, name: "dGPU", vramTotalMiB: 49152 },
        ],
      },
      nodeMetrics: null,
      nodeMetricsAt: null,
      heldClaims: [
        {
          current: [{ kind: "discrete", gpuCount: 1, vramGb: 32, vendor: "nvidia" }],
          previous: [],
        },
      ],
      now: NOW,
    });
    expect(hardware.reservedNowMemoryGb).toBe(32);
  });

  it("counts a restart's old and new claims of one instance once (the larger), instances adding", () => {
    const hardware = effectiveHardware({
      declaredResources: null,
      nodeInfo: GB10_INFO,
      nodeMetrics: null,
      nodeMetricsAt: null,
      heldClaims: [
        // Restarted from 100 to 20 while the old run may still run: max(20, 100).
        {
          current: [{ kind: "unified", memoryGb: 20 }],
          previous: [{ kind: "unified", memoryGb: 100 }],
        },
        // Restarted from 10 to 30: max(30, 10).
        {
          current: [{ kind: "unified", memoryGb: 30 }],
          previous: [{ kind: "unified", memoryGb: 10 }],
        },
        { current: [{ kind: "unified", memoryGb: 5 }], previous: [] },
      ],
      now: NOW,
    });
    expect(hardware.reservedNowMemoryGb).toBe(135);
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

describe("declared unified GPUs", () => {
  /** A Strix Halo declared by hand (no AMD detection). */
  const STRIX = {
    kind: "unified",
    memoryGb: 128,
    gpus: [{ vendor: "amd", index: 0, name: "Radeon 8060S", unified: true }],
  };

  it("accepts unified GPUs without vramGb and requires vramGb on discrete ones", () => {
    expect(declaredHardwareSchema.safeParse(STRIX).success).toBe(true);
    const both = declaredHardwareSchema.safeParse({
      gpus: [{ vendor: "amd", index: 0, unified: true, vramGb: 96 }],
    });
    expect(both.success).toBe(false);
    expect(both.error?.issues.map((issue) => issue.path)).toEqual([["gpus", 0, "vramGb"]]);
    const neither = declaredHardwareSchema.safeParse({ gpus: [{ vendor: "nvidia", index: 0 }] });
    expect(neither.success).toBe(false);
    expect(neither.error?.issues[0]?.message).toContain("needs vramGb");
    expect(
      declaredHardwareSchema.safeParse({
        gpus: [{ vendor: "nvidia", index: 0, unified: false, vramGb: 24 }],
      }).success,
    ).toBe(true);
  });

  it("is accepted by nodes.update (node_update over MCP)", () => {
    const input = nodesContract.update.input.safeParse({ nodeId: "node_1", hardware: STRIX });
    expect(input.error?.issues ?? []).toEqual([]);
  });

  it("treats a declared unified GPU exactly like a detected one", () => {
    const declared = effectiveHardware({
      declaredResources: { ...STRIX, reservedVramGb: { "amd:0": 4 } },
      nodeInfo: null,
      nodeMetrics: null,
      nodeMetricsAt: null,
      heldClaims: [
        { current: [{ kind: "discrete", gpuCount: 1, vramGb: 60, ramGb: 2 }], previous: [] },
      ],
      now: NOW,
    });
    expect(declared.gpus).toEqual([
      {
        key: "amd:0",
        vendor: "amd",
        index: 0,
        name: "Radeon 8060S",
        vramGb: null,
        unified: true,
        reservedVramGb: 4,
        source: "browser",
      },
    ]);
    // 128 − 4 reserved on the GPU − 2 headroom; the claim's VRAM is node memory.
    expect(declared.usableMemoryGb).toBe(122);
    expect(declared.reservedNowMemoryGb).toBe(62);
    const detected = effectiveHardware({
      declaredResources: { reservedVramGb: { "amd:0": 4 } },
      nodeInfo: {
        nodeKind: "unified",
        unifiedMemoryMiB: 131072,
        gpus: [{ vendor: "amd", index: 0, name: "Radeon 8060S", vramTotalMiB: 512, apu: true }],
      },
      nodeMetrics: null,
      nodeMetricsAt: null,
      heldClaims: [
        { current: [{ kind: "discrete", gpuCount: 1, vramGb: 60, ramGb: 2 }], previous: [] },
      ],
      now: NOW,
    });
    expect(detected.gpus.map(({ source: _source, ...gpu }) => gpu)).toEqual(
      declared.gpus.map(({ source: _source, ...gpu }) => gpu),
    );
    expect(detected.usableMemoryGb).toBe(declared.usableMemoryGb);
    expect(detected.reservedNowMemoryGb).toBe(declared.reservedNowMemoryGb);
  });

  it("lets a declared unified GPU override a detected discrete reading of the same key", () => {
    const hardware = effectiveHardware({
      declaredResources: { gpus: [{ vendor: "nvidia", index: 0, unified: true }] },
      nodeInfo: { nodeKind: "discrete", gpus: [{ vendor: "nvidia", index: 0, vramTotalMiB: 0 }] },
      nodeMetrics: null,
      nodeMetricsAt: null,
      heldClaims: [],
      now: NOW,
    });
    expect(hardware.gpus[0]).toMatchObject({ vramGb: null, unified: true, source: "browser" });
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

describe("physical RAM versus accelerator-addressable memory", () => {
  it.each([
    // Default 128 GB Strix Halo: 512 MiB carve-out plus 62812 MiB GTT/TTM.
    ["Strix Halo", 126136, 63324, 123.18, 61.84, 121.18],
    // Default 16 GB Phoenix: 2 GiB carve-out plus 6963 MiB GTT/TTM.
    ["Phoenix", 15974, 9011, 15.6, 8.8, 13.6],
    // Apple keeps its wired GPU limit separate from hw.memsize.
    ["Apple", 131072, 98304, 128, 96, 126],
    ["GB10", 122357, 122357, 119.49, 119.49, 117.49],
  ])(
    "uses OS total for %s, keeping its GPU pool separate",
    (_name, total, pool, memory, accelerator, usable) => {
      const hardware = hardwareOf({
        nodeKind: "unified",
        memoryTotalMiB: total,
        unifiedMemoryMiB: pool,
        acceleratorMemoryMiB: pool,
      });
      expect(hardware.memoryGb).toEqual({ value: memory, source: "detected" });
      expect(hardware.acceleratorMemoryGb.value).toBe(accelerator);
      expect(hardware.usableMemoryGb).toBe(usable);
    },
  );

  it("uses the legacy pool only without an OS total and preserves a reported zero total", () => {
    expect(hardwareOf({ nodeKind: "unified", unifiedMemoryMiB: 63324 }).memoryGb.value).toBe(61.84);
    expect(hardwareOf({ memoryTotalMiB: 0, unifiedMemoryMiB: 63324 }).memoryGb.value).toBe(0);
  });

  it("keeps browser/agent declarations above node config and both above detection", () => {
    const info = {
      nodeKind: "unified",
      memoryTotalMiB: 126136,
      unifiedMemoryMiB: 63324,
      acceleratorMemoryMiB: 63324,
      declared: { memoryGb: 110, acceleratorMemoryGb: 55 },
    };
    expect(hardwareOf(info).memoryGb).toEqual({ value: 110, source: "node" });
    expect(hardwareOf(info).acceleratorMemoryGb).toEqual({ value: 55, source: "node" });
    const hardware = hardwareOf(info, { memoryGb: 120, acceleratorMemoryGb: 60 });
    expect(hardware.memoryGb).toEqual({ value: 120, source: "browser" });
    expect(hardware.acceleratorMemoryGb).toEqual({ value: 60, source: "browser" });
  });

  it("shows the real Strix Halo live free memory independently of its accelerator cap", () => {
    const hardware = effectiveHardware({
      declaredResources: null,
      nodeInfo: {
        nodeKind: "unified",
        memoryTotalMiB: 126136,
        unifiedMemoryMiB: 63324,
        acceleratorMemoryMiB: 63324,
      },
      nodeMetrics: { memory: { availableMiB: 123392 } },
      nodeMetricsAt: NOW,
      heldClaims: [],
      now: NOW,
    });
    expect(hardware.memoryGb.value).toBe(123.18);
    expect(hardware.acceleratorMemoryGb.value).toBe(61.84);
    expect(hardware.usableMemoryGb).toBe(121.18);
    expect(hardware.liveFreeMemoryGb).toBe(120.5);
  });
});

describe("detected APU host RAM budget", () => {
  const info = {
    nodeKind: "unified",
    memoryTotalMiB: 129922,
    acceleratorMemoryMiB: 114113,
    gpus: [{ vendor: "amd", index: 0, apu: true, vramTotalMiB: 98304 }],
  };
  it("subtracts AMD carve-outs and RAM reserves, but not shared GPU reserves", () => {
    expect(ramOnlyMemoryBudgetGb(hardwareOf(info), info)).toBe(28.88);
    expect(
      ramOnlyMemoryBudgetGb(
        hardwareOf(info, { reservedMemoryGb: 3, reservedVramGb: { "amd:0": 8 } }),
        info,
      ),
    ).toBe(25.88);
    const two = {
      ...info,
      gpus: [...info.gpus, { vendor: "amd", index: 1, apu: true, vramTotalMiB: 1024 }],
    };
    // The CLI adds only the first APU's carve-out to the total, so only that one comes off.
    expect(ramOnlyMemoryBudgetGb(hardwareOf(two), two)).toBe(28.88);
  });
  it("does not infer carve-outs for declared totals, legacy totals or other GPU vendors", () => {
    expect(ramOnlyMemoryBudgetGb(hardwareOf(info, { memoryGb: 120 }), info)).toBeNull();
    const declared = { ...info, declared: { memoryGb: 120 } };
    expect(ramOnlyMemoryBudgetGb(hardwareOf(declared), declared)).toBeNull();
    const legacy = { nodeKind: "unified", unifiedMemoryMiB: 114113, gpus: info.gpus };
    expect(ramOnlyMemoryBudgetGb(hardwareOf(legacy), legacy)).toBeNull();
    for (const vendor of ["apple", "nvidia"]) {
      const other = { ...info, gpus: [{ ...info.gpus[0], vendor }] };
      expect(ramOnlyMemoryBudgetGb(hardwareOf(other), other)).toBeNull();
    }
    const zero = { ...info, memoryTotalMiB: 0 };
    expect(ramOnlyMemoryBudgetGb(hardwareOf(zero), zero)).toBe(0);
  });
});
