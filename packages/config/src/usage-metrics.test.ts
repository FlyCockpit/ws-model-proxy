import { describe, expect, it } from "vitest";
import {
  addHistograms,
  emptyLatencyHistogram,
  histogramQuantile,
  LATENCY_HISTOGRAM_BOUNDS_MS,
  LATENCY_HISTOGRAM_BUCKETS,
  latencyBucketIndex,
  OVERVIEW_RANGE_CONFIG,
} from "./usage-metrics";

describe("latency histogram layout", () => {
  it("has one more bucket than bounds and strictly increasing bounds", () => {
    expect(LATENCY_HISTOGRAM_BUCKETS).toBe(LATENCY_HISTOGRAM_BOUNDS_MS.length + 1);
    for (let index = 1; index < LATENCY_HISTOGRAM_BOUNDS_MS.length; index += 1)
      expect(LATENCY_HISTOGRAM_BOUNDS_MS[index]).toBeGreaterThan(
        LATENCY_HISTOGRAM_BOUNDS_MS[index - 1]!,
      );
    expect(emptyLatencyHistogram()).toHaveLength(LATENCY_HISTOGRAM_BUCKETS);
  });

  it("maps durations onto [lower, upper) buckets", () => {
    expect(latencyBucketIndex(0)).toBe(0);
    expect(latencyBucketIndex(9.9)).toBe(0);
    expect(latencyBucketIndex(10)).toBe(1);
    expect(latencyBucketIndex(999)).toBe(LATENCY_HISTOGRAM_BOUNDS_MS.indexOf(750) + 1);
    expect(latencyBucketIndex(1_000)).toBe(LATENCY_HISTOGRAM_BOUNDS_MS.indexOf(1_000) + 1);
    expect(latencyBucketIndex(10_000_000)).toBe(LATENCY_HISTOGRAM_BUCKETS - 1);
    expect(latencyBucketIndex(-5)).toBe(0);
    expect(latencyBucketIndex(Number.NaN)).toBe(0);
  });

  it("adds histograms element-wise, padding the shorter one", () => {
    const added = addHistograms([1, 2], [3, 4, 5]);
    expect(added.slice(0, 3)).toEqual([4, 6, 5]);
    expect(added).toHaveLength(LATENCY_HISTOGRAM_BUCKETS);
    expect(addHistograms(null, undefined)).toEqual(emptyLatencyHistogram());
  });
});

describe("histogramQuantile", () => {
  it("returns null for an empty histogram", () => {
    expect(histogramQuantile([], 0.5)).toBeNull();
    expect(histogramQuantile(emptyLatencyHistogram(), 0.95)).toBeNull();
    expect(histogramQuantile(null, 0.5)).toBeNull();
  });

  it("interpolates inside the bucket that holds the rank", () => {
    const histogram = emptyLatencyHistogram();
    // 100 samples in [100, 150).
    histogram[latencyBucketIndex(120)] = 100;
    expect(histogramQuantile(histogram, 0.5)).toBeCloseTo(125, 5);
    expect(histogramQuantile(histogram, 0.95)).toBeCloseTo(147.5, 5);
  });

  it("separates p50 from p95 across buckets", () => {
    const histogram = emptyLatencyHistogram();
    histogram[latencyBucketIndex(40)] = 90; // [30, 50)
    histogram[latencyBucketIndex(2_500)] = 10; // [2000, 3000)
    const p50 = histogramQuantile(histogram, 0.5)!;
    const p95 = histogramQuantile(histogram, 0.95)!;
    expect(p50).toBeGreaterThanOrEqual(30);
    expect(p50).toBeLessThan(50);
    expect(p95).toBeGreaterThanOrEqual(2_000);
    expect(p95).toBeLessThan(3_000);
  });

  it("reports the lower bound of the open-ended last bucket", () => {
    const histogram = emptyLatencyHistogram();
    histogram[LATENCY_HISTOGRAM_BUCKETS - 1] = 3;
    expect(histogramQuantile(histogram, 0.95)).toBe(
      LATENCY_HISTOGRAM_BOUNDS_MS[LATENCY_HISTOGRAM_BOUNDS_MS.length - 1],
    );
  });

  it("ignores negative and non-finite counts", () => {
    const histogram = emptyLatencyHistogram();
    histogram[0] = -10;
    histogram[1] = Number.NaN;
    expect(histogramQuantile(histogram, 0.5)).toBeNull();
  });
});

describe("overview ranges", () => {
  it("uses 1 min / 15 min / 1 h buckets that divide the range", () => {
    expect(OVERVIEW_RANGE_CONFIG["1h"].bucketMs).toBe(60_000);
    expect(OVERVIEW_RANGE_CONFIG["24h"].bucketMs).toBe(15 * 60_000);
    expect(OVERVIEW_RANGE_CONFIG["7d"].bucketMs).toBe(60 * 60_000);
    for (const config of Object.values(OVERVIEW_RANGE_CONFIG))
      expect(config.durationMs % config.bucketMs).toBe(0);
  });
});
