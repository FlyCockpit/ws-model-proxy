import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({
  default: {},
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
}));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({ isDbShutdownFenceArmed: () => false }));

import {
  createEngineLoadRollupWriter,
  ENGINE_LOAD_ROLLUP_MAX_PENDING,
  type EngineLoadRollupSample,
  incrementKeyString,
  mergeEngineLoadIncrements,
  truncateToMinute,
} from "./engine-load-rollup.js";

const NOW = new Date("2026-09-30T12:00:30.000Z");

function sample(overrides: Partial<EngineLoadRollupSample> = {}): EngineLoadRollupSample {
  return {
    ownerUserId: "owner",
    cliDeviceId: "cli-1",
    endpointSlug: "gpu",
    modelSlug: "qwen",
    receivedAt: NOW,
    running: 2,
    waiting: 1,
    kvUsage: 0.4,
    kvOccupancy: 0.8,
    slotsBusy: 3,
    prefixCacheHitsDelta: 4,
    prefixCacheQueriesDelta: 5,
    source: "custom",
    ...overrides,
  };
}

describe("engine-load rollup merge", () => {
  it("truncates to the minute and keeps occupancy as a display gauge", () => {
    expect(truncateToMinute(NOW).toISOString()).toBe("2026-09-30T12:00:00.000Z");
    const merged = mergeEngineLoadIncrements(undefined, sample(), "cap-1");
    expect(merged.maxKvOccupancy).toBe(0.8);
    expect(merged.maxKvUsage).toBe(0.4);
    expect(merged.samples).toBe(1);
    const second = mergeEngineLoadIncrements(
      merged,
      sample({ running: 5, kvOccupancy: 0.5, waiting: undefined, prefixCacheHitsDelta: 2 }),
      "cap-1",
    );
    expect(second.maxRunning).toBe(5);
    expect(second.maxWaiting).toBe(1);
    expect(second.maxKvOccupancy).toBe(0.8);
    expect(second.prefixCacheHits).toBe(6);
    expect(second.samples).toBe(2);
  });

  it("sorts upserts by a stable key", () => {
    const left = mergeEngineLoadIncrements(undefined, sample({ endpointSlug: "a" }), "cap-1");
    const right = mergeEngineLoadIncrements(undefined, sample({ endpointSlug: "b" }), "cap-1");
    expect(incrementKeyString(left) < incrementKeyString(right)).toBe(true);
  });
});

describe("engine-load rollup writer", () => {
  const writers: Array<ReturnType<typeof createEngineLoadRollupWriter>> = [];
  afterEach(() => {
    for (const writer of writers) writer.stop();
    writers.length = 0;
  });

  it("flushes merged samples for a resolved capacity and skips unknown endpoints", async () => {
    const writes: unknown[] = [];
    const writer = createEngineLoadRollupWriter({
      clock: () => NOW.getTime() + 2_000,
      write: async (increments) => {
        writes.push(increments);
        return increments.length;
      },
      resolveCapacities: async () => [
        { capacityId: "cap-1", endpointSlug: "gpu", modelSlug: "qwen" },
      ],
    });
    writers.push(writer);
    writer.observe(sample());
    writer.observe(sample({ endpointSlug: "missing", running: 9 }));
    await writer.flushNow();
    expect(writes).toHaveLength(1);
    const increments = writes[0] as Array<{
      capacityId: string;
      maxRunning: number;
      maxKvOccupancy: number | null;
      endpointSlug: string;
    }>;
    expect(increments).toHaveLength(1);
    expect(increments[0]).toMatchObject({
      capacityId: "cap-1",
      maxRunning: 2,
      maxKvOccupancy: 0.8,
      endpointSlug: "gpu",
    });
  });

  it("maps a null sample slug onto every capacity on that endpoint", async () => {
    const writes: unknown[] = [];
    const writer = createEngineLoadRollupWriter({
      clock: () => NOW.getTime() + 2_000,
      write: async (increments) => {
        writes.push(increments);
        return increments.length;
      },
      resolveCapacities: async () => [
        { capacityId: "cap-qwen", endpointSlug: "gpu", modelSlug: "qwen" },
        { capacityId: "cap-other", endpointSlug: "gpu", modelSlug: "other" },
        { capacityId: "cap-cpu", endpointSlug: "cpu", modelSlug: "qwen" },
      ],
    });
    writers.push(writer);
    writer.observe(sample({ modelSlug: null, running: 6, kvOccupancy: 0.4 }));
    await writer.flushNow();
    expect(writes).toHaveLength(1);
    const increments = writes[0] as Array<{
      capacityId: string;
      modelSlug: string;
      maxRunning: number;
      maxKvOccupancy: number | null;
    }>;
    expect(increments).toHaveLength(2);
    expect(increments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capacityId: "cap-qwen",
          modelSlug: "qwen",
          maxRunning: 6,
          maxKvOccupancy: 0.4,
        }),
        expect.objectContaining({
          capacityId: "cap-other",
          modelSlug: "other",
          maxRunning: 6,
          maxKvOccupancy: 0.4,
        }),
      ]),
    );
    expect(increments.some((row) => row.capacityId === "cap-cpu")).toBe(false);
  });

  it("keeps a non-null sample slug on its own capacity", async () => {
    const writes: unknown[] = [];
    const writer = createEngineLoadRollupWriter({
      clock: () => NOW.getTime() + 2_000,
      write: async (increments) => {
        writes.push(increments);
        return increments.length;
      },
      resolveCapacities: async () => [
        { capacityId: "cap-qwen", endpointSlug: "gpu", modelSlug: "qwen" },
        { capacityId: "cap-other", endpointSlug: "gpu", modelSlug: "other" },
      ],
    });
    writers.push(writer);
    writer.observe(sample({ modelSlug: "qwen", running: 3 }));
    await writer.flushNow();
    const increments = writes[0] as Array<{ capacityId: string; modelSlug: string }>;
    expect(increments).toEqual([
      expect.objectContaining({ capacityId: "cap-qwen", modelSlug: "qwen" }),
    ]);
  });

  it("refuses new pending keys at the process cap while a flush is in flight", async () => {
    const rows = [{ capacityId: "cap-1", endpointSlug: "gpu", modelSlug: "qwen" }];
    let releaseFirst: ((value: typeof rows) => void) | undefined;
    const writes: unknown[] = [];
    const writer = createEngineLoadRollupWriter({
      clock: () => NOW.getTime(),
      write: async (increments) => {
        writes.push(increments);
        return increments.length;
      },
      resolveCapacities: () =>
        releaseFirst
          ? Promise.resolve(rows)
          : new Promise((resolve) => {
              releaseFirst = resolve;
            }),
    });
    writers.push(writer);
    writer.observe(sample());
    await Promise.resolve();
    expect(releaseFirst).toBeTypeOf("function");
    for (let index = 0; index < ENGINE_LOAD_ROLLUP_MAX_PENDING + 25; index += 1) {
      writer.observe(
        sample({
          endpointSlug: `ep-${index}`,
          receivedAt: new Date(NOW.getTime() + (index + 1) * 60_000),
        }),
      );
    }
    releaseFirst?.(rows);
    await writer.flushNow();
    const flushed = writes.flat() as Array<{ endpointSlug: string }>;
    expect(flushed.length).toBeLessThanOrEqual(ENGINE_LOAD_ROLLUP_MAX_PENDING + 1);
    expect(flushed.some((row) => row.endpointSlug === "ep-2010")).toBe(false);
  });
});
