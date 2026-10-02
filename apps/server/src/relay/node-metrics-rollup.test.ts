import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({
  default: {},
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
}));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({ isDbShutdownFenceArmed: () => false }));

import {
  createNodeMetricsRollupWriter,
  incrementKeyString,
  mergeNodeMetricsIncrements,
  NODE_METRICS_ROLLUP_MAX_PENDING,
  type NodeMetricsRollupSample,
  truncateToMinute,
} from "./node-metrics-rollup.js";

const NOW = new Date("2026-09-30T12:00:30.000Z");

function sample(overrides: Partial<NodeMetricsRollupSample> = {}): NodeMetricsRollupSample {
  return {
    ownerUserId: "owner",
    cliDeviceId: "cli-1",
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

  it("sorts upserts by a stable key", () => {
    const left = mergeNodeMetricsIncrements(undefined, sample({ cliDeviceId: "a" }));
    const right = mergeNodeMetricsIncrements(undefined, sample({ cliDeviceId: "b" }));
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
      writer.observe(sample({ cliDeviceId: `cli-${index}`, receivedAt: NOW }));
    }
    release?.();
    await flushing;
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });
});
