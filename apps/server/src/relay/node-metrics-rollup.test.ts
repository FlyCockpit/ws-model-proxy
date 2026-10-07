import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({
  default: {},
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    join: (values: unknown[]) => ({ strings: ["join"], values }),
  },
}));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({ isDbShutdownFenceArmed: () => false }));

import {
  createNodeMetricsRollupWriter,
  incrementKeyString,
  mergeNodeMetricsIncrements,
  NODE_METRICS_ROLLUP_MAX_PENDING,
  type NodeMetricsRollupSample,
  NodeMetricsRollupWriteError,
  truncateToMinute,
  writeNodeMetricsIncrements,
} from "./node-metrics-rollup.js";

const NOW = new Date("2026-09-30T12:00:30.000Z");

function sample(overrides: Partial<NodeMetricsRollupSample> = {}): NodeMetricsRollupSample {
  return {
    ownerUserId: "owner",
    nodeId: "cli-1",
    receivedAt: NOW,
    cpuPercent: 20,
    memoryAvailableMiB: 80_000,
    memoryTotalMiB: 128 * 1024,
    gpuTemperatureC: 55,
    gpuUtilizationPercent: 10,
    ...overrides,
  };
}

describe("node-metrics rollup merge", () => {
  it("truncates to the minute and tracks min/avg/max gauges", () => {
    expect(truncateToMinute(NOW).toISOString()).toBe("2026-09-30T12:00:00.000Z");
    const first = mergeNodeMetricsIncrements(undefined, sample());
    expect(first.samples).toBe(1);
    expect(first.cpuSamples).toBe(1);
    expect(first.minCpuPercent).toBe(20);
    expect(first.maxCpuPercent).toBe(20);
    expect(first.sumCpuPercent).toBe(20);
    expect(first.maxGpuTemperatureC).toBe(55);
    const second = mergeNodeMetricsIncrements(
      first,
      sample({ cpuPercent: 40, memoryAvailableMiB: 60_000, gpuTemperatureC: 70 }),
    );
    expect(second.samples).toBe(2);
    expect(second.minCpuPercent).toBe(20);
    expect(second.maxCpuPercent).toBe(40);
    expect(second.sumCpuPercent).toBe(60);
    expect(second.minMemoryAvailableMiB).toBe(60_000);
    expect(second.maxMemoryAvailableMiB).toBe(80_000);
    expect(second.maxGpuTemperatureC).toBe(70);
    expect(second.maxMemoryUsedPercent).toBeGreaterThan(second.minMemoryUsedPercent ?? 0);
  });

  it("ignores missing CPU in the CPU average count", () => {
    const merged = mergeNodeMetricsIncrements(
      mergeNodeMetricsIncrements(undefined, sample()),
      sample({ cpuPercent: null }),
    );
    expect(merged.samples).toBe(2);
    expect(merged.cpuSamples).toBe(1);
    expect(merged.sumCpuPercent).toBe(20);
  });

  it("keeps the minimum free accelerator memory", () => {
    const merged = mergeNodeMetricsIncrements(
      mergeNodeMetricsIncrements(
        mergeNodeMetricsIncrements(undefined, sample({ acceleratorFreeMiB: 9_000 })),
        sample({ acceleratorFreeMiB: null }),
      ),
      sample({ acceleratorFreeMiB: 4_000 }),
    );
    expect(merged.minAcceleratorFreeMiB).toBe(4_000);
  });

  it("aggregates custom metric values per name, every label set a sample, up to 16 names", () => {
    const first = mergeNodeMetricsIncrements(
      undefined,
      sample({
        custom: [
          { name: "gpu_power", value: 100 },
          { name: "gpu_power", value: 300 },
          { name: "bad name", value: 1 },
          { name: "queue", value: Number.NaN },
        ],
      }),
    );
    expect(first.custom).toEqual({ gpu_power: { min: 100, sum: 400, max: 300, samples: 2 } });
    const second = mergeNodeMetricsIncrements(
      first,
      sample({ custom: [{ name: "gpu_power", value: 50 }] }),
    );
    expect(second.custom.gpu_power).toEqual({ min: 50, sum: 450, max: 300, samples: 3 });
    const many = mergeNodeMetricsIncrements(
      undefined,
      sample({
        custom: Array.from({ length: 20 }, (_, index) => ({ name: `m${index}`, value: 1 })),
      }),
    );
    expect(Object.keys(many.custom)).toHaveLength(16);
    // The first merge's object is not mutated by later samples.
    expect(first.custom.gpu_power?.samples).toBe(2);
  });

  it("sorts upserts by a stable key", () => {
    const left = mergeNodeMetricsIncrements(undefined, sample({ nodeId: "a" }));
    const right = mergeNodeMetricsIncrements(undefined, sample({ nodeId: "b" }));
    expect(incrementKeyString(left) < incrementKeyString(right)).toBe(true);
  });
});

describe("node-metrics rollup writer", () => {
  const writers: Array<ReturnType<typeof createNodeMetricsRollupWriter>> = [];
  afterEach(() => {
    for (const writer of writers) writer.stop();
    writers.length = 0;
  });

  it("flushes merged samples for one device-minute", async () => {
    const writes: unknown[] = [];
    const writer = createNodeMetricsRollupWriter({
      clock: () => NOW.getTime() + 2_000,
      write: async (increments) => {
        writes.push(increments);
        return increments.length;
      },
    });
    writers.push(writer);
    writer.observe(sample());
    writer.observe(sample({ cpuPercent: 30 }));
    await writer.flushNow();
    expect(writes).toHaveLength(1);
    const increments = writes[0] as Array<{ samples: number; maxCpuPercent: number | null }>;
    expect(increments).toHaveLength(1);
    expect(increments[0]).toMatchObject({ samples: 2, maxCpuPercent: 30 });
  });

  it("refuses new pending keys at the process cap while a flush is in flight", async () => {
    let release: (() => void) | undefined;
    const writes: unknown[] = [];
    const writer = createNodeMetricsRollupWriter({
      clock: () => NOW.getTime(),
      write: async (increments) => {
        writes.push(increments);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return increments.length;
      },
    });
    writers.push(writer);
    writer.observe(sample());
    const flushing = writer.flushNow();
    await Promise.resolve();
    expect(release).toBeTypeOf("function");
    for (let index = 0; index < NODE_METRICS_ROLLUP_MAX_PENDING + 5; index += 1) {
      writer.observe(sample({ nodeId: `cli-${index}`, receivedAt: NOW }));
    }
    release?.();
    await flushing;
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it("writes a batch in one statement", async () => {
    const calls: unknown[] = [];
    const written = await writeNodeMetricsIncrements(
      [
        mergeNodeMetricsIncrements(undefined, sample({ nodeId: "a" })),
        mergeNodeMetricsIncrements(undefined, sample({ nodeId: "b" })),
      ],
      {
        $executeRaw: async (sql) => {
          calls.push(sql);
          return 2;
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(written).toBe(2);
  });

  it("isolates a failed increment so later rows still write", async () => {
    const calls: unknown[] = [];
    await expect(
      writeNodeMetricsIncrements(
        [
          mergeNodeMetricsIncrements(undefined, sample({ nodeId: "a" })),
          mergeNodeMetricsIncrements(undefined, sample({ nodeId: "b" })),
        ],
        {
          $executeRaw: async () => {
            calls.push(true);
            if (calls.length === 1) throw { code: "22003" };
            if (calls.length === 2) throw { code: "22003" };
            return 1;
          },
        },
      ),
    ).rejects.toMatchObject({ written: 1, failed: 1 });
    expect(calls).toHaveLength(3);
  });
  it("routes database failures with counts, resumes on restored writes, and joins shutdown", async () => {
    const log = vi.fn();
    let fail = true;
    let finish: (() => void) | undefined;
    const write = vi.fn(async (increments: Parameters<typeof writeNodeMetricsIncrements>[0]) => {
      if (fail) throw new NodeMetricsRollupWriteError(0, increments.length);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return increments.length;
    });
    const writer = createNodeMetricsRollupWriter({ clock: () => NOW.getTime(), write, log });
    writers.push(writer);
    writer.observe(sample());
    await writer.flushNow();
    expect(log).toHaveBeenCalledWith({ written: 0, failed: 1 });
    fail = false;
    writer.observe(sample({ nodeId: "restored" }));
    const flushing = writer.flushNow();
    await Promise.resolve();
    const stopping = writer.stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    writer.observe(sample({ nodeId: "late" }));
    finish?.();
    await stopping;
    await flushing;
    expect(settled).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    await writer.flushNow();
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("reports partial count returns and rate-limits only logging, not future writes", async () => {
    let time = NOW.getTime();
    const log = vi.fn();
    const write = vi.fn(async () => 0);
    const writer = createNodeMetricsRollupWriter({ clock: () => time, write, log });
    writers.push(writer);
    for (let index = 0; index < 3; index++) {
      writer.observe(sample());
      await writer.flushNow();
      time += 1000;
    }
    expect(write).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ written: 0, failed: 1 });
  });

  it("never replays a batch after an uncertain commit acknowledgement", async () => {
    const execute = vi.fn(async () => {
      throw new Error("connection lost after commit");
    });
    await expect(
      writeNodeMetricsIncrements([mergeNodeMetricsIncrements(undefined, sample())], {
        $executeRaw: execute,
      }),
    ).rejects.toMatchObject({ written: 0, failed: 1, uncertain: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
