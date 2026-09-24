/**
 * Shared, prompt-free usage-metrics primitives used by the server rollup
 * writer and the overview API reader. Both sides MUST agree on the histogram
 * layout, so it lives here and nowhere else.
 */

/**
 * Fixed log-scale (1-1.5-2-3-5-7.5 per decade) lower bounds in milliseconds.
 * Bucket 0 is [0, 10); bucket i (1..N-1) is [BOUNDS[i-1], BOUNDS[i]); the last
 * bucket is [BOUNDS[N-1], +inf). Changing this array changes the meaning of
 * every stored histogram, so only append buckets (never reorder or edit).
 */
export const LATENCY_HISTOGRAM_BOUNDS_MS = [
  10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 7_500,
  10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000,
] as const;

/** Number of histogram buckets (bounds + the [0, first) bucket). */
export const LATENCY_HISTOGRAM_BUCKETS = LATENCY_HISTOGRAM_BOUNDS_MS.length + 1;

export function emptyLatencyHistogram(): number[] {
  return new Array<number>(LATENCY_HISTOGRAM_BUCKETS).fill(0);
}

/** Bucket index for a non-negative duration in milliseconds. */
export function latencyBucketIndex(durationMs: number): number {
  const value = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  let index = 0;
  while (index < LATENCY_HISTOGRAM_BOUNDS_MS.length && value >= LATENCY_HISTOGRAM_BOUNDS_MS[index]!)
    index += 1;
  return index;
}

/** Element-wise sum; shorter inputs are zero-padded, non-finite entries count as 0. */
export function addHistograms(
  left: readonly number[] | null | undefined,
  right: readonly number[] | null | undefined,
): number[] {
  const length = Math.max(left?.length ?? 0, right?.length ?? 0, LATENCY_HISTOGRAM_BUCKETS);
  const output = new Array<number>(length).fill(0);
  for (let index = 0; index < length; index += 1) {
    const a = Number(left?.[index] ?? 0);
    const b = Number(right?.[index] ?? 0);
    output[index] = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  }
  return output;
}

function bucketLowerBound(index: number): number {
  return index === 0 ? 0 : (LATENCY_HISTOGRAM_BOUNDS_MS[index - 1] ?? 0);
}

function bucketUpperBound(index: number): number | null {
  return LATENCY_HISTOGRAM_BOUNDS_MS[index] ?? null;
}

/**
 * Estimates the q-quantile (0 < q <= 1) from a fixed-bucket histogram.
 * Interpolates linearly inside the bucket (geometrically would overstate the
 * first bucket, whose lower bound is 0). The open-ended last bucket reports
 * its lower bound, i.e. "at least". Returns null for an empty histogram.
 */
export function histogramQuantile(
  histogram: readonly number[] | null | undefined,
  q: number,
): number | null {
  if (!histogram || histogram.length === 0) return null;
  const counts = histogram.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const quantile = Math.min(1, Math.max(Number.EPSILON, q));
  const rank = quantile * total;
  let cumulative = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index] ?? 0;
    if (count === 0) continue;
    if (cumulative + count >= rank) {
      const lower = bucketLowerBound(index);
      const upper = bucketUpperBound(index);
      if (upper === null) return lower;
      const fraction = (rank - cumulative) / count;
      return lower + (upper - lower) * fraction;
    }
    cumulative += count;
  }
  return bucketLowerBound(counts.length - 1);
}

/** Overview time ranges and their chart bucket sizes. */
export const OVERVIEW_RANGES = ["1h", "24h", "7d"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

export const OVERVIEW_RANGE_CONFIG: Record<
  OverviewRange,
  { durationMs: number; bucketMs: number }
> = {
  "1h": { durationMs: 60 * 60 * 1000, bucketMs: 60 * 1000 },
  "24h": { durationMs: 24 * 60 * 60 * 1000, bucketMs: 15 * 60 * 1000 },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
};

/** Minute rollups are kept this long before compaction into hourly rows. */
export const USAGE_ROLLUP_MINUTE_RETENTION_DAYS = 30;
/** Hourly rollups are kept 13 months (395 days). */
export const USAGE_ROLLUP_HOUR_RETENTION_DAYS = 395;
