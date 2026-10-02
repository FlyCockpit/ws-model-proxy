import { describe, expect, it } from "vitest";
import {
  bucketStartMs,
  ENGINE_LOAD_HISTORY_BUCKET_MS,
  ENGINE_LOAD_HISTORY_MAX_KEYS,
  ENGINE_LOAD_HISTORY_MAX_KEYS_PER_DEVICE,
  ENGINE_LOAD_HISTORY_POINTS,
  ENGINE_LOAD_HISTORY_WINDOW_MS,
  EngineLoadHistoryStore,
  expandHistorySeries,
  mergeSampleIntoBucket,
  windowStartMs,
} from "./engine-load-history.js";

const T0 = new Date("2026-09-28T12:00:00.000Z");

function sample(
  overrides: Partial<Parameters<typeof mergeSampleIntoBucket>[1]> = {},
): Parameters<typeof mergeSampleIntoBucket>[1] {
  return { running: 1, receivedAt: T0, ...overrides };
}

describe("engine-load history ring", () => {
  it("pins the window to 10 s buckets for 30 minutes", () => {
    expect(ENGINE_LOAD_HISTORY_BUCKET_MS).toBe(10_000);
    expect(ENGINE_LOAD_HISTORY_POINTS).toBe(180);
    expect(ENGINE_LOAD_HISTORY_WINDOW_MS).toBe(1_800_000);
    expect(bucketStartMs(T0.getTime() + 9_999)).toBe(T0.getTime());
    expect(windowStartMs(T0.getTime())).toBe(T0.getTime() - 1_790_000);
  });

  it("keeps max gauges and summed prefix deltas in one bucket", () => {
    const first = mergeSampleIntoBucket(undefined, {
      running: 2,
      waiting: 1,
      kvUsage: 0.4,
      kvOccupancy: 0.7,
      slotsBusy: 1,
      prefixCacheHitsDelta: 3,
      prefixCacheQueriesDelta: 5,
      source: "custom",
      receivedAt: T0,
    });
    const merged = mergeSampleIntoBucket(first, {
      running: 5,
      waiting: 0,
      kvUsage: 0.2,
      kvOccupancy: 0.9,
      slotsBusy: 3,
      prefixCacheHitsDelta: 4,
      prefixCacheQueriesDelta: 1,
      source: "vllm-metrics",
      receivedAt: new Date(T0.getTime() + 4_000),
    });
    expect(merged).toMatchObject({
      startMs: T0.getTime(),
      running: 5,
      waiting: 1,
      kvUsage: 0.4,
      kvOccupancy: 0.9,
      slotsBusy: 3,
      prefixCacheHits: 7,
      prefixCacheQueries: 6,
      source: "vllm-metrics",
    });
  });

  it("marks missing buckets as gaps with null gauges", () => {
    const points = expandHistorySeries(
      [mergeSampleIntoBucket(undefined, sample({ running: 4, waiting: 2, receivedAt: T0 }))],
      T0,
    );
    expect(points).toHaveLength(ENGINE_LOAD_HISTORY_POINTS);
    expect(points.at(-1)).toMatchObject({
      start: T0,
      running: 4,
      waiting: 2,
      gap: false,
    });
    expect(points.at(-2)).toMatchObject({
      start: new Date(T0.getTime() - ENGINE_LOAD_HISTORY_BUCKET_MS),
      running: null,
      waiting: null,
      kvUsage: null,
      kvOccupancy: null,
      gap: true,
      prefixCacheHits: 0,
    });
    expect(points[0]?.gap).toBe(true);
  });

  it("prunes buckets past the window and drops empty keys", () => {
    const store = new EngineLoadHistoryStore();
    expect(store.record("d1", "gpu", null, sample({ running: 3, receivedAt: T0 }))).toBe(true);
    const later = new Date(
      T0.getTime() + ENGINE_LOAD_HISTORY_WINDOW_MS + ENGINE_LOAD_HISTORY_BUCKET_MS,
    );
    store.prune(later);
    expect(store.size).toBe(0);
    const series = store.series("d1", "gpu", null, later);
    expect(series.every((point) => point.gap)).toBe(true);
  });

  it("refuses new live keys at the cap and only evicts rings older than the window", () => {
    const store = new EngineLoadHistoryStore();
    for (let i = 0; i < ENGINE_LOAD_HISTORY_MAX_KEYS_PER_DEVICE; i += 1) {
      expect(store.record("d1", `ep-${i}`, null, sample({ receivedAt: T0 }))).toBe(true);
    }
    expect(
      store.record("d1", "overflow", null, sample({ receivedAt: new Date(T0.getTime() + 90_000) })),
    ).toBe(false);
    expect(store.deviceKeyCount("d1")).toBe(ENGINE_LOAD_HISTORY_MAX_KEYS_PER_DEVICE);
    expect(store.series("d1", "ep-0", null, T0).at(-1)).toMatchObject({ running: 1, gap: false });
    expect(
      store.record(
        "d1",
        "ep-1",
        null,
        sample({ running: 9, receivedAt: new Date(T0.getTime() + 90_000) }),
      ),
    ).toBe(true);

    const stale = new Date(
      T0.getTime() + ENGINE_LOAD_HISTORY_WINDOW_MS + ENGINE_LOAD_HISTORY_BUCKET_MS,
    );
    const aged = new EngineLoadHistoryStore();
    for (let i = 0; i < ENGINE_LOAD_HISTORY_MAX_KEYS_PER_DEVICE; i += 1) {
      expect(aged.record("d1", `ep-${i}`, null, sample({ receivedAt: T0 }))).toBe(true);
    }
    expect(aged.record("d1", "fresh", null, sample({ receivedAt: stale }))).toBe(true);
    expect(aged.deviceKeyCount("d1")).toBe(1);
    expect(aged.series("d1", "fresh", null, stale).at(-1)).toMatchObject({
      running: 1,
      gap: false,
    });

    const other = new EngineLoadHistoryStore();
    for (let i = 0; i < ENGINE_LOAD_HISTORY_MAX_KEYS; i += 1) {
      expect(other.record(`d-${i}`, "gpu", null, sample({ receivedAt: T0 }))).toBe(true);
    }
    expect(
      other.record(
        "d-overflow",
        "gpu",
        null,
        sample({ receivedAt: new Date(T0.getTime() + 90_000) }),
      ),
    ).toBe(false);
    expect(other.size).toBe(ENGINE_LOAD_HISTORY_MAX_KEYS);
    expect(other.series("d-0", "gpu", null, T0).at(-1)).toMatchObject({ running: 1, gap: false });
  });

  it("drops a device's keys", () => {
    const store = new EngineLoadHistoryStore();
    store.record("d1", "gpu", null, sample({ running: 4 }));
    store.record("d2", "gpu", null, sample({ running: 5 }));
    store.dropDevice("d1");
    expect(store.deviceKeyCount("d1")).toBe(0);
    expect(store.series("d1", "gpu", null, T0).every((point) => point.gap)).toBe(true);
    expect(store.series("d2", "gpu", null, T0).at(-1)).toMatchObject({ running: 5, gap: false });
  });

  it("falls back to the endpoint-wide ring when the sample slug is null", () => {
    const store = new EngineLoadHistoryStore();
    store.record("d1", "gpu", null, sample({ running: 7, kvUsage: 0.3 }));
    const forModel = store.series("d1", "gpu", "qwen", T0);
    expect(forModel.at(-1)).toMatchObject({ running: 7, kvUsage: 0.3, gap: false });
    const endpointWide = store.series("d1", "gpu", null, T0);
    expect(endpointWide.at(-1)).toMatchObject({ running: 7, gap: false });
    store.record("d1", "gpu", "qwen", sample({ running: 2, receivedAt: T0 }));
    const modelSpecific = store.series("d1", "gpu", "qwen", T0);
    expect(modelSpecific.at(-1)).toMatchObject({ running: 2, gap: false });
    expect(store.series("d1", "other", "qwen", T0).every((point) => point.gap)).toBe(true);
  });

  it("keeps history across a reconnect of the same manager store", () => {
    const store = new EngineLoadHistoryStore();
    store.record("d1", "gpu", null, sample({ running: 6, kvOccupancy: 0.5, source: "custom" }));
    const afterReconnect = store.series("d1", "gpu", null, T0);
    expect(afterReconnect.at(-1)).toMatchObject({
      running: 6,
      kvOccupancy: 0.5,
      source: "custom",
      gap: false,
    });
    store.record(
      "d1",
      "gpu",
      null,
      sample({ running: 8, receivedAt: new Date(T0.getTime() + ENGINE_LOAD_HISTORY_BUCKET_MS) }),
    );
    const next = store.series(
      "d1",
      "gpu",
      null,
      new Date(T0.getTime() + ENGINE_LOAD_HISTORY_BUCKET_MS),
    );
    expect(next.at(-2)).toMatchObject({ running: 6, gap: false });
    expect(next.at(-1)).toMatchObject({ running: 8, gap: false });
  });
});
