import { describe, expect, it } from "vitest";
import {
  CACHE_STATS_MAX_SERIES_POINTS,
  coverageFrom,
  hitRateFrom,
  resolveCacheStatsWindow,
  shapeCacheStats,
  stabilityFromBuckets,
} from "./cache-stats";

const NOW = new Date("2026-09-24T12:00:00.000Z");

function row(overrides: Partial<Parameters<typeof shapeCacheStats>[0]["rows"][number]> = {}) {
  return {
    bucketStart: new Date("2026-09-24T11:30:00.000Z"),
    poolMemberId: "member-a",
    requests: 10,
    cacheReadTokens: 40,
    cacheKnownRequests: 8,
    cacheKnownInputTokens: 80,
    continuationRequests: 4,
    continuationInputTokens: 40,
    continuationCacheReadTokens: 30,
    ...overrides,
  };
}

describe("hitRateFrom / coverageFrom", () => {
  it("returns null when nothing reported cache usage, never 0 for unknown", () => {
    expect(hitRateFrom(0, 0)).toBeNull();
    expect(hitRateFrom(10, 0)).toBeNull();
    expect(coverageFrom(0, 0)).toBeNull();
  });

  it("caps the token-weighted hit rate at 1", () => {
    expect(hitRateFrom(50, 100)).toBe(0.5);
    expect(hitRateFrom(150, 100)).toBe(1);
  });
});

describe("resolveCacheStatsWindow", () => {
  it("uses minute rollups for lastMinutes and picks a bucket with at most 120 points", () => {
    const hour = resolveCacheStatsWindow({ lastMinutes: 60 }, NOW);
    expect(hour.source).toBe("minute");
    expect(hour.hourUntil).toBeNull();
    expect(hour.bucketMs).toBe(60_000);
    expect(hour.bucketCount).toBeLessThanOrEqual(CACHE_STATS_MAX_SERIES_POINTS);
    expect(hour.truncated).toBe(false);

    const long = resolveCacheStatsWindow({ lastMinutes: 240 }, NOW);
    expect(long.source).toBe("minute");
    expect(long.bucketCount).toBeLessThanOrEqual(CACHE_STATS_MAX_SERIES_POINTS);
    expect(long.bucketMs).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it("reads minute rollups for lastDays within retention and hours beyond 30 days", () => {
    const week = resolveCacheStatsWindow({ lastDays: 7 }, NOW);
    expect(week.source).toBe("minute");
    expect(week.hourUntil).toBeNull();
    expect(week.bucketCount).toBeLessThanOrEqual(CACHE_STATS_MAX_SERIES_POINTS);

    const twoMonths = resolveCacheStatsWindow({ lastDays: 60 }, NOW);
    expect(twoMonths.source).toBe("mixed");
    expect(twoMonths.hourUntil).not.toBeNull();
    expect(twoMonths.bucketMs).toBeGreaterThanOrEqual(3_600_000);
    expect(twoMonths.bucketCount).toBeLessThanOrEqual(CACHE_STATS_MAX_SERIES_POINTS);
  });

  it("marks windows that start before hour retention as truncated", () => {
    const window = resolveCacheStatsWindow({ lastDays: 395 }, NOW);
    expect(window.source === "mixed" || window.source === "hour").toBe(true);
    // 395 days equals hour retention; alignment to the bucket may clip the start.
    expect(window.end.getTime() - window.start.getTime()).toBeLessThanOrEqual(
      395 * 24 * 60 * 60 * 1000 + window.bucketMs,
    );
  });

  it("honors an explicit bucket size unless it would exceed 120 points", () => {
    const fine = resolveCacheStatsWindow({ lastMinutes: 60, bucket: 1 }, NOW);
    expect(fine.bucketMs).toBe(60_000);
    const coarse = resolveCacheStatsWindow({ lastMinutes: 60, bucket: 15 }, NOW);
    expect(coarse.bucketMs).toBe(15 * 60_000);
    const tooFine = resolveCacheStatsWindow({ lastMinutes: 43_200, bucket: 1 }, NOW);
    expect(tooFine.bucketCount).toBeLessThanOrEqual(CACHE_STATS_MAX_SERIES_POINTS);
    expect(tooFine.bucketMs).toBeGreaterThan(60_000);
  });
});

describe("shapeCacheStats", () => {
  const window = resolveCacheStatsWindow({ lastMinutes: 60 }, NOW);

  it("aggregates rates over the window and fills every bucket", () => {
    const shaped = shapeCacheStats({
      window,
      rows: [
        row({ bucketStart: new Date("2026-09-24T11:30:00.000Z") }),
        row({
          bucketStart: new Date("2026-09-24T11:31:00.000Z"),
          cacheReadTokens: 80,
          cacheKnownInputTokens: 80,
        }),
      ],
    });
    expect(shaped.series).toHaveLength(window.bucketCount);
    expect(shaped.hitRate).toBeCloseTo(120 / 160);
    expect(shaped.continuationHitRate).toBeCloseTo(60 / 80);
    expect(shaped.coverage).toBeCloseTo(16 / 20);
    expect(shaped.notes).not.toContain("engine_reports_no_cache_fields");
    expect(shaped.series.every((point) => typeof point.start === "string")).toBe(true);
  });

  it("returns null hit rates when no cache fields were reported", () => {
    const shaped = shapeCacheStats({
      window,
      rows: [
        row({
          cacheReadTokens: 0,
          cacheKnownRequests: 0,
          cacheKnownInputTokens: 0,
          continuationRequests: 0,
          continuationInputTokens: 0,
          continuationCacheReadTokens: 0,
        }),
      ],
    });
    expect(shaped.hitRate).toBeNull();
    expect(shaped.continuationHitRate).toBeNull();
    expect(shaped.notes).toContain("engine_reports_no_cache_fields");
  });

  it("leaves continuationHitRate null when continuation columns are all zero", () => {
    const shaped = shapeCacheStats({
      window,
      rows: [
        row({
          continuationRequests: 0,
          continuationInputTokens: 0,
          continuationCacheReadTokens: 0,
        }),
      ],
    });
    expect(shaped.hitRate).toBeCloseTo(0.5);
    expect(shaped.continuationHitRate).toBeNull();
    const predating = shaped.series.filter((point) => point.requests === 0);
    expect(predating.every((point) => point.continuationHitRate === null)).toBe(true);
  });

  it("caps an over-unity bucket hit rate at 1", () => {
    const shaped = shapeCacheStats({
      window,
      rows: [row({ cacheReadTokens: 400, cacheKnownInputTokens: 80 })],
    });
    expect(shaped.hitRate).toBe(1);
  });

  it("notes low coverage when few requests reported cache usage", () => {
    const shaped = shapeCacheStats({
      window,
      rows: [row({ requests: 100, cacheKnownRequests: 10 })],
    });
    expect(shaped.coverage).toBeCloseTo(0.1);
    expect(shaped.notes).toContain("low_coverage");
  });

  it("notes hour resolution and retention truncation from the window", () => {
    const mixed = resolveCacheStatsWindow({ lastDays: 60 }, NOW);
    const shaped = shapeCacheStats({ window: mixed, rows: [] });
    expect(shaped.notes).toContain("hour_resolution");
    expect(shaped.notes).toContain("engine_reports_no_cache_fields");
    expect(shaped.hitRate).toBeNull();
  });

  it("splits one series per member when requested", () => {
    const shaped = shapeCacheStats({
      window,
      split: "member",
      rows: [
        row({ poolMemberId: "b", cacheReadTokens: 10, cacheKnownInputTokens: 100 }),
        row({ poolMemberId: "a", cacheReadTokens: 90, cacheKnownInputTokens: 100 }),
      ],
    });
    expect(shaped.members?.map((member) => member.poolMemberId)).toEqual(["a", "b"]);
    expect(shaped.members?.[0]?.hitRate).toBeCloseTo(0.9);
    expect(shaped.members?.[1]?.hitRate).toBeCloseTo(0.1);
    expect(shaped.series.some((point) => point.poolMemberId === "a")).toBe(true);
  });
});

describe("stabilityFromBuckets", () => {
  it("computes token-weighted median, p10, stddev, and half-window change", () => {
    const buckets = [
      { hitRate: 0.2, cacheKnownInputTokens: 20 },
      { hitRate: 0.5, cacheKnownInputTokens: 20 },
      { hitRate: 0.8, cacheKnownInputTokens: 80 },
      { hitRate: 0.9, cacheKnownInputTokens: 80 },
    ];
    const stability = stabilityFromBuckets(buckets);
    expect(stability.median).toBeCloseTo(0.8);
    expect(stability.p10).toBeCloseTo(0.2);
    expect(stability.bucketsBelowHalf).toBe(1);
    expect(stability.stddev).toBeGreaterThan(0);
    expect(stability.firstHalfHitRate).toBeCloseTo((0.2 * 20 + 0.5 * 20) / 40);
    expect(stability.secondHalfHitRate).toBeCloseTo((0.8 * 80 + 0.9 * 80) / 160);
    expect(stability.change).toBeCloseTo(
      (stability.secondHalfHitRate ?? 0) - (stability.firstHalfHitRate ?? 0),
    );
  });

  it("returns nulls when no bucket reported cache usage", () => {
    expect(stabilityFromBuckets([{ hitRate: null, cacheKnownInputTokens: 0 }])).toMatchObject({
      median: null,
      p10: null,
      stddev: null,
      bucketsBelowHalf: 0,
      change: null,
    });
  });
});
