import { latencyBucketIndex } from "@ws-model-proxy/config/usage-metrics";
import { describe, expect, it } from "vitest";
import {
  accumulateRows,
  emptyAccumulator,
  overviewWindow,
  poolSeries,
  statsFromAccumulator,
} from "./overview-metrics";

describe("overviewWindow", () => {
  it("aligns the window to whole buckets and includes the current bucket", () => {
    const now = new Date("2026-09-24T10:17:30.000Z");
    const window = overviewWindow("24h", now);
    expect(window.end.toISOString()).toBe("2026-09-24T10:30:00.000Z");
    expect(window.start.toISOString()).toBe("2026-09-23T10:30:00.000Z");
    expect(window.previousStart.toISOString()).toBe("2026-09-22T10:30:00.000Z");
    expect(window.bucketCount).toBe(96);
    expect(overviewWindow("1h", now).bucketCount).toBe(60);
    expect(overviewWindow("7d", now).bucketCount).toBe(168);
  });
});

describe("statsFromAccumulator", () => {
  it("reports nulls, not zeros, for rates and percentiles without data", () => {
    expect(statsFromAccumulator(emptyAccumulator())).toMatchObject({
      requests: 0,
      errorRate: null,
      cacheHitRate: null,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      p95TtftMs: null,
    });
  });

  it("weights cache hit rate by tokens over cache-reporting requests only", () => {
    const value = emptyAccumulator();
    value.requests = 3;
    value.cacheKnownRequests = 2;
    value.cacheKnownInputTokens = 1000;
    value.cacheReadTokens = 250;
    value.inputTokens = 5000; // includes a non-reporting upstream's prompt tokens
    expect(statsFromAccumulator(value).cacheHitRate).toBeCloseTo(0.25);
  });
});

describe("accumulateRows", () => {
  it("adds 1-based histogram ordinals into the matching bucket and period", () => {
    const keyed = accumulateRows(
      [],
      [
        {
          current: true,
          poolId: "p",
          poolMemberId: "m",
          executionTargetId: "t",
          kind: "ttft",
          idx: latencyBucketIndex(250) + 1,
          count: 4n,
        },
        {
          current: false,
          poolId: "p",
          poolMemberId: "m",
          executionTargetId: "t",
          kind: "latency",
          idx: 0,
          count: 9n,
        },
      ],
    );
    const current = [...keyed.current.values()][0]!;
    expect(current.ttftHistogram[latencyBucketIndex(250)]).toBe(4);
    // idx 0 is not a valid ordinal and is ignored.
    const previous = [...keyed.previous.values()][0]!;
    expect(previous.latencyHistogram.every((value) => value === 0)).toBe(true);
  });
});

describe("poolSeries", () => {
  it("emits every bucket with a zero default and converts to requests per minute", () => {
    const window = overviewWindow("1h", new Date("2026-09-24T10:17:30.000Z"));
    const series = poolSeries(
      window,
      [
        { poolId: "p", poolMemberId: "m", bucket: 59, requests: 6n, errors: 0n },
        { poolId: "p", poolMemberId: "m", bucket: 99, requests: 1n, errors: 0n },
      ],
      ["m", ""],
    );
    expect(series).toHaveLength(60);
    expect(series[0]!.values).toEqual({ m: 0, "": 0 });
    expect(series[59]!.values.m).toBe(6);
    expect(series[59]!.bucketStart).toBe("2026-09-24T10:17:00.000Z");
  });
});
