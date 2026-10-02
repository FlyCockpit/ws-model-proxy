import { describe, expect, it } from "vitest";
import {
  assertUsableBudgetWrite,
  buildNodeCardSnapshot,
  defaultUsableVramGb,
  gpuBudgetKey,
  NODE_GPU_VRAM_RESERVE_GB,
  NODE_MEMORY_RESERVE_GB,
  NODE_VRAM_KEYS_MAX,
  nodeHasAllLabels,
  nodeHealthWarnings,
  nodeLabelsSchema,
  normalizeDecimalInput,
  normalizeNodeLabels,
  parseNodeInfo,
  resolveUsableBudgets,
  shapeNodeMetricsMinute,
  shapeNodeMetricsRange,
  suggestNodeLabels,
  tryShapeNodeMetricsMinute,
  usableVramGbSchema,
} from "./node-inventory";
import { overviewWindow } from "./overview-metrics";

describe("suggestNodeLabels", () => {
  it("suggests dgx-spark and unified-memory for a GB10 node", () => {
    expect(
      suggestNodeLabels({
        nodeKind: "unified",
        unifiedMemory: true,
        memoryTotalMiB: 128 * 1024,
        gpus: [{ index: 0, name: "NVIDIA GB10" }],
      }),
    ).toEqual(["dgx-spark", "unified-memory"]);
  });

  it("does not suggest apple-silicon for Ubuntu aarch64 GB10 / DGX Spark", () => {
    expect(
      suggestNodeLabels({
        nodeKind: "unified",
        unifiedMemory: true,
        memoryTotalMiB: 128 * 1024,
        os: { name: "Ubuntu", arch: "aarch64" },
        gpus: [{ index: 0, name: "NVIDIA GB10" }],
      }),
    ).toEqual(["dgx-spark", "unified-memory"]);
  });

  it("suggests apple-silicon only on macOS when no M-series model matched", () => {
    expect(
      suggestNodeLabels({
        nodeKind: "unified",
        unifiedMemory: true,
        os: { name: "macOS", arch: "arm64" },
      }),
    ).toEqual(["apple-silicon", "unified-memory"]);
    expect(
      suggestNodeLabels({
        nodeKind: "unified",
        unifiedMemory: true,
        os: { name: "Ubuntu", arch: "aarch64" },
      }),
    ).toEqual(["unified-memory"]);
  });

  it("suggests strix-halo from the GPU name", () => {
    expect(
      suggestNodeLabels({
        nodeKind: "unified",
        unifiedMemory: true,
        gpus: [{ index: 0, name: "AMD Radeon 8060S Strix Halo" }],
      }),
    ).toContain("strix-halo");
  });

  it("suggests rtx-3090 on a discrete card and skips unified-memory", () => {
    expect(
      suggestNodeLabels({
        nodeKind: "discrete",
        unifiedMemory: false,
        memoryTotalMiB: 64 * 1024,
        gpus: [{ index: 0, name: "NVIDIA GeForce RTX 3090", vramTotalMiB: 24 * 1024 }],
      }),
    ).toEqual(["rtx-3090"]);
  });

  it("suggests apple-m4 from the CPU model", () => {
    expect(
      suggestNodeLabels({
        nodeKind: "unified",
        unifiedMemory: true,
        os: { name: "macOS", arch: "arm64" },
        cpu: { model: "Apple M4 Max" },
      }),
    ).toEqual(["apple-m4", "unified-memory"]);
  });

  it("suggests low-power for a small CPU-only node", () => {
    expect(
      suggestNodeLabels({
        nodeKind: "cpu",
        memoryTotalMiB: 8 * 1024,
      }),
    ).toEqual(["low-power"]);
  });
});

describe("normalizeDecimalInput", () => {
  it("trims and turns one comma into a dot", () => {
    expect(normalizeDecimalInput(" 1,5 ")).toBe("1.5");
    expect(normalizeDecimalInput("1.5")).toBe("1.5");
    expect(normalizeDecimalInput("1,5,0")).toBe("1,5,0");
    expect(normalizeDecimalInput("1.5,0")).toBe("1.5,0");
    expect(normalizeDecimalInput("")).toBe("");
  });
});

describe("node labels", () => {
  it("normalizes, dedupes, and drops invalid labels", () => {
    expect(normalizeNodeLabels(["DGX-Spark", " dgx-spark ", "Nope!", "ok-1", ""])).toEqual([
      "dgx-spark",
      "ok-1",
    ]);
  });

  it("rejects negation and expressions in the write schema", () => {
    expect(nodeLabelsSchema.safeParse(["dgx-spark", "!low-power"]).success).toBe(false);
    expect(nodeLabelsSchema.safeParse(["unified-memory=true"]).success).toBe(false);
    expect(nodeLabelsSchema.safeParse(["dgx-spark", "dgx-spark"]).success).toBe(false);
    expect(nodeLabelsSchema.safeParse(["dgx-spark", "unified-memory"]).success).toBe(true);
  });

  it("matches selectors as has-all-of-these sets", () => {
    expect(nodeHasAllLabels(["dgx-spark", "unified-memory"], ["dgx-spark"])).toBe(true);
    expect(nodeHasAllLabels(["dgx-spark"], ["dgx-spark", "unified-memory"])).toBe(false);
    expect(nodeHasAllLabels(["dgx-spark"], [])).toBe(true);
  });
});

describe("usable budgets", () => {
  it("defaults unified memory to total minus 2 GB with no percentage cap", () => {
    const info = parseNodeInfo({
      nodeKind: "unified",
      memoryTotalMiB: 128 * 1024,
      gpus: [{ index: 0, name: "GB10" }],
    });
    expect(info).not.toBeNull();
    const budgets = resolveUsableBudgets(info, {});
    expect(budgets.usableMemoryGb).toBe(128 - NODE_MEMORY_RESERVE_GB);
    expect(budgets.usableRamGb).toBeNull();
    expect(budgets.usableMemoryGbDefault).toBe(true);
    expect(budgets.usableVramGb).toEqual({});
  });

  it("treats a missing nodeKind as RAM-only so memory is not shown twice", () => {
    const budgets = resolveUsableBudgets(
      { memoryTotalMiB: 32 * 1024, gpus: [{ index: 0, uuid: "GPU-aaa", vramTotalMiB: 8 * 1024 }] },
      {},
    );
    expect(budgets.usableMemoryGb).toBeNull();
    expect(budgets.usableRamGb).toBe(32 - NODE_MEMORY_RESERVE_GB);
    expect(budgets.usableVramGb["GPU-aaa"]).toBe(8 - NODE_GPU_VRAM_RESERVE_GB);
  });

  it("defaults per-GPU VRAM minus 0.5 GB keyed by UUID with index fallback", () => {
    const info = {
      nodeKind: "discrete" as const,
      memoryTotalMiB: 32 * 1024,
      gpus: [
        { index: 0, uuid: "GPU-aaa", vramTotalMiB: 24 * 1024 },
        { index: 1, vramTotalMiB: 12 * 1024 },
      ],
    };
    expect(gpuBudgetKey(info.gpus[0]!)).toBe("GPU-aaa");
    expect(gpuBudgetKey(info.gpus[1]!)).toBe("index:1");
    const defaults = defaultUsableVramGb(info);
    expect(defaults["GPU-aaa"]).toBe(24 - NODE_GPU_VRAM_RESERVE_GB);
    expect(defaults["index:1"]).toBe(12 - NODE_GPU_VRAM_RESERVE_GB);
    const custom = resolveUsableBudgets(info, {
      usableRamGb: 28,
      usableVramGb: { "GPU-aaa": 23.5 },
    });
    expect(custom.usableRamGb).toBe(28);
    expect(custom.usableRamGbDefault).toBe(false);
    expect(custom.usableVramGb["GPU-aaa"]).toBe(23.5);
    expect(custom.usableVramGbDefaults["GPU-aaa"]).toBe(false);
    expect(custom.usableVramGb["index:1"]).toBe(12 - NODE_GPU_VRAM_RESERVE_GB);
    expect(custom.usableVramGbDefaults["index:1"]).toBe(true);
  });

  it("rejects a malformed VRAM map", () => {
    expect(usableVramGbSchema.safeParse({ "index:0": 10 }).success).toBe(true);
    expect(usableVramGbSchema.safeParse({ "index:999": 10 }).success).toBe(false);
    expect(usableVramGbSchema.safeParse({ "": 10 }).success).toBe(false);
    const tooMany: Record<string, number> = {};
    for (let index = 0; index <= NODE_VRAM_KEYS_MAX; index += 1) tooMany[`GPU-${index}`] = 1;
    expect(usableVramGbSchema.safeParse(tooMany).success).toBe(false);
  });

  it("prunes unknown GPU keys on read", () => {
    const budgets = resolveUsableBudgets(
      {
        nodeKind: "discrete",
        memoryTotalMiB: 32 * 1024,
        gpus: [{ index: 0, uuid: "GPU-aaa", vramTotalMiB: 24 * 1024 }],
      },
      { usableVramGb: { "GPU-aaa": 20, "GPU-missing": 8, "index:9": 4 } },
    );
    expect(budgets.usableVramGb["GPU-aaa"]).toBe(20);
    expect(budgets.usableVramGb["GPU-missing"]).toBeUndefined();
    expect(budgets.usableVramGb["index:9"]).toBeUndefined();
  });

  it("rejects writes that do not apply, name an unknown GPU, or exceed physical totals", () => {
    const discrete = {
      nodeKind: "discrete" as const,
      memoryTotalMiB: 32 * 1024,
      gpus: [{ index: 0, uuid: "GPU-aaa", vramTotalMiB: 24 * 1024 }],
    };
    expect(
      assertUsableBudgetWrite(discrete, { usableRamGb: 28, usableVramGb: { "GPU-aaa": 23.5 } }),
    ).toBeNull();
    expect(assertUsableBudgetWrite(discrete, { usableRamGb: null })).toBeNull();
    expect(assertUsableBudgetWrite(discrete, { usableMemoryGb: 16 })?.fields).toEqual([
      "usableMemoryGb",
    ]);
    expect(assertUsableBudgetWrite(discrete, { usableRamGb: 40 })?.fields).toEqual(["usableRamGb"]);
    expect(assertUsableBudgetWrite(discrete, { usableVramGb: { "index:9": 8 } })?.fields).toEqual([
      "usableVramGb",
    ]);
    expect(assertUsableBudgetWrite(discrete, { usableVramGb: { "GPU-aaa": 30 } })?.fields).toEqual([
      "usableVramGb",
    ]);
    expect(
      assertUsableBudgetWrite(
        { nodeKind: "unified", memoryTotalMiB: 64 * 1024 },
        { usableRamGb: 8 },
      )?.fields,
    ).toEqual(["usableRamGb"]);
    expect(
      assertUsableBudgetWrite(
        { nodeKind: "cpu", memoryTotalMiB: 16 * 1024 },
        { usableVramGb: { "index:0": 8 } },
      )?.fields,
    ).toEqual(["usableVramGb"]);
    expect(assertUsableBudgetWrite(null, { usableRamGb: 8 })?.message).toMatch(/inventory/i);
  });
});

describe("nodeHealthWarnings", () => {
  it("flags memory pressure, thermal, driver skew, fabric MTU, disk, and a missing model path", () => {
    const codes = nodeHealthWarnings(
      {
        nodeKind: "discrete",
        gpus: [
          { index: 0, driverVersion: "580.1" },
          { index: 1, driverVersion: "570.2" },
        ],
        interfaces: [
          { name: "eth0", mtu: 1500, linkSpeedMbps: 1000 },
          { name: "mlx0", mtu: 1500, linkSpeedMbps: 200_000 },
        ],
      },
      {
        memory: { totalMiB: 32 * 1024, availableMiB: 512 },
        gpus: [{ index: 0, temperatureC: 91 }],
        disks: [
          { mount: "/", freeMiB: 1024, totalMiB: 100_000 },
          { mount: "/models", freeMiB: 0, totalMiB: 0 },
        ],
      },
    ).map((warning) => warning.code);
    expect(codes).toEqual([
      "pressure",
      "thermal",
      "driver_skew",
      "mtu",
      "disk",
      "missing_model_path",
    ]);
  });

  it("flags abandoned file recovery from node.metrics", () => {
    expect(
      nodeHealthWarnings({ nodeKind: "cpu" }, { abandonedRecovery: 1 }).map(
        (warning) => warning.code,
      ),
    ).toEqual(["abandoned_recovery"]);
  });

  it("does not flag a healthy unified node", () => {
    expect(
      nodeHealthWarnings(
        {
          nodeKind: "unified",
          gpus: [{ index: 0, driverVersion: "580.1" }],
          interfaces: [{ name: "eth0", mtu: 1500, linkSpeedMbps: 1000 }],
        },
        {
          memory: { totalMiB: 128 * 1024, availableMiB: 80 * 1024 },
          gpus: [{ index: 0, temperatureC: 52 }],
          disks: [{ mount: "/", freeMiB: 200_000, totalMiB: 500_000 }],
        },
      ),
    ).toEqual([]);
  });
});

describe("buildNodeCardSnapshot", () => {
  it("combines live metrics, labels, suggestions, and defaults", () => {
    const card = buildNodeCardSnapshot({
      nodeInfo: {
        nodeKind: "unified",
        unifiedMemory: true,
        memoryTotalMiB: 128 * 1024,
        gpus: [{ index: 0, name: "NVIDIA GB10", uuid: "GPU-1" }],
      },
      nodeMetrics: {
        cpu: { usagePercent: 12 },
        memory: { totalMiB: 128 * 1024, availableMiB: 90 * 1024 },
      },
      labels: [],
    });
    expect(card.kind).toBe("unified");
    expect(card.suggestedLabels).toEqual(["dgx-spark", "unified-memory"]);
    expect(card.labels).toEqual([]);
    expect(card.usableMemoryGb).toBe(126);
    expect(card.memoryAvailableGb).toBeCloseTo(90);
    expect(card.cpuPercent).toBe(12);
  });
});

describe("shapeNodeMetricsMinute", () => {
  it("computes averages from sums and per-metric sample counts", () => {
    const point = shapeNodeMetricsMinute({
      bucketStart: new Date("2026-09-30T12:00:00.000Z"),
      samples: 3,
      cpuSamples: 2,
      minCpuPercent: 10,
      sumCpuPercent: 30,
      maxCpuPercent: 20,
      memorySamples: 3,
      minMemoryAvailableMiB: 1000,
      sumMemoryAvailableMiB: 6000,
      maxMemoryAvailableMiB: 3000,
      minMemoryUsedPercent: 40,
      sumMemoryUsedPercent: 150,
      maxMemoryUsedPercent: 70,
      maxGpuTemperatureC: 61,
      maxGpuUtilizationPercent: 80,
    });
    expect(point.avgCpuPercent).toBe(15);
    expect(point.avgMemoryAvailableMiB).toBe(2000);
    expect(point.avgMemoryUsedPercent).toBe(50);
    expect(point.start).toBe("2026-09-30T12:00:00.000Z");
    expect(point.gap).toBe(false);
  });
});

function minuteRow(start: string, cpu: number) {
  return {
    bucketStart: new Date(start),
    samples: 1,
    cpuSamples: 1,
    minCpuPercent: cpu,
    sumCpuPercent: cpu,
    maxCpuPercent: cpu,
    memorySamples: 0,
    minMemoryAvailableMiB: null,
    sumMemoryAvailableMiB: null,
    maxMemoryAvailableMiB: null,
    minMemoryUsedPercent: null,
    sumMemoryUsedPercent: null,
    maxMemoryUsedPercent: null,
    maxGpuTemperatureC: null,
    maxGpuUtilizationPercent: null,
  };
}

describe("tryShapeNodeMetricsMinute", () => {
  it("skips malformed minutes instead of throwing", () => {
    expect(tryShapeNodeMetricsMinute(null)).toBeNull();
    expect(tryShapeNodeMetricsMinute({ bucketStart: "nope" })).toBeNull();
    expect(tryShapeNodeMetricsMinute(minuteRow("2026-10-02T12:00:00.000Z", 5))).toMatchObject({
      avgCpuPercent: 5,
      gap: false,
    });
  });
});

describe("shapeNodeMetricsRange", () => {
  it("gap-fills 24h buckets and skips a malformed row", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const window = overviewWindow("24h", now);
    expect(window.bucketCount).toBe(96);
    const first = window.start.toISOString();
    const points = shapeNodeMetricsRange(
      [minuteRow(first, 10), { bucketStart: "not-a-date" }, null],
      window,
    );
    expect(points).toHaveLength(96);
    expect(points[0]).toMatchObject({ start: first, avgCpuPercent: 10, gap: false });
    expect(points[1]).toMatchObject({ gap: true, samples: 0 });
  });

  it("gap-fills 7d hourly buckets from the 7-day minutes", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const window = overviewWindow("7d", now);
    expect(window.bucketCount).toBe(168);
    const points = shapeNodeMetricsRange([minuteRow(window.start.toISOString(), 40)], window);
    expect(points).toHaveLength(168);
    expect(points[0]).toMatchObject({ avgCpuPercent: 40, gap: false });
    expect(points.filter((point) => point.gap)).toHaveLength(167);
  });
});
