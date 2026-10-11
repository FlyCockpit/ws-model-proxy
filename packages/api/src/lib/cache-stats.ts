/**
 * Pure shaping for pool prompt-cache hit-rate stats. The router queries
 * usage rollups; everything here is deterministic and database-free so window
 * choice, rate math, and stability figures are unit-tested directly.
 *
 * hitRate is null when nothing reported cache usage (never 0 for unknown) and
 * is capped at 1. continuationHitRate is the same ratio for matched-affinity
 * requests; it is null when those columns are all zero (including windows that
 * predate the columns).
 */

import {
  USAGE_ROLLUP_HOUR_RETENTION_DAYS,
  USAGE_ROLLUP_MINUTE_RETENTION_DAYS,
} from "@ws-model-proxy/config/usage-metrics";

export const CACHE_STATS_MAX_SERIES_POINTS = 120;
export const CACHE_STATS_LOW_COVERAGE = 0.5;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type CacheStatsNote =
  | "low_coverage"
  | "window_truncated_by_retention"
  | "hour_resolution"
  | "engine_reports_no_cache_fields";

export type CacheStatsWindowInput = {
  lastMinutes?: number;
  lastDays?: number;
  bucket?: number;
};

export type CacheStatsSource = "minute" | "hour" | "mixed";

export type CacheStatsWindow = {
  start: Date;
  end: Date;
  bucketMs: number;
  bucketCount: number;
  source: CacheStatsSource;
  /** Exclusive end of hour-sourced data; null when minutes cover the window. */
  hourUntil: Date | null;
  truncated: boolean;
};

export type CacheStatsQueryRow = {
  bucketStart: Date;
  poolMemberId: string;
  requests: bigint | number;
  cacheReadTokens: bigint | number;
  cacheKnownRequests: bigint | number;
  cacheKnownInputTokens: bigint | number;
  continuationRequests: bigint | number;
  continuationInputTokens: bigint | number;
  continuationCacheReadTokens: bigint | number;
};

export type CacheStatsPoint = {
  start: string;
  requests: number;
  hitRate: number | null;
  continuationHitRate: number | null;
  coverage: number | null;
  poolMemberId?: string;
};

export type CacheStatsStability = {
  median: number | null;
  p10: number | null;
  stddev: number | null;
  bucketsBelowHalf: number;
  firstHalfHitRate: number | null;
  secondHalfHitRate: number | null;
  change: number | null;
};

export type CacheStatsTotals = {
  requests: number;
  cacheReadTokens: number;
  cacheKnownRequests: number;
  cacheKnownInputTokens: number;
  continuationRequests: number;
  continuationInputTokens: number;
  continuationCacheReadTokens: number;
  hitRate: number | null;
  continuationHitRate: number | null;
  coverage: number | null;
};

export type CacheStatsResult = CacheStatsTotals & {
  window: {
    start: string;
    end: string;
    bucketMinutes: number;
    source: CacheStatsSource;
  };
  series: CacheStatsPoint[];
  members?: Array<
    CacheStatsTotals & {
      poolMemberId: string;
      series: CacheStatsPoint[];
      stability: CacheStatsStability;
    }
  >;
  stability: CacheStatsStability;
  notes: CacheStatsNote[];
};

type RateCounts = {
  requests: number;
  cacheReadTokens: number;
  cacheKnownRequests: number;
  cacheKnownInputTokens: number;
  continuationRequests: number;
  continuationInputTokens: number;
  continuationCacheReadTokens: number;
};

function emptyCounts(): RateCounts {
  return {
    requests: 0,
    cacheReadTokens: 0,
    cacheKnownRequests: 0,
    cacheKnownInputTokens: 0,
    continuationRequests: 0,
    continuationInputTokens: 0,
    continuationCacheReadTokens: 0,
  };
}

function addCounts(target: RateCounts, add: RateCounts): void {
  target.requests += add.requests;
  target.cacheReadTokens += add.cacheReadTokens;
  target.cacheKnownRequests += add.cacheKnownRequests;
  target.cacheKnownInputTokens += add.cacheKnownInputTokens;
  target.continuationRequests += add.continuationRequests;
  target.continuationInputTokens += add.continuationInputTokens;
  target.continuationCacheReadTokens += add.continuationCacheReadTokens;
}

function num(value: bigint | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function hitRateFrom(read: number, knownInput: number): number | null {
  if (knownInput <= 0) return null;
  return Math.min(1, read / knownInput);
}

export function coverageFrom(knownRequests: number, requests: number): number | null {
  if (requests <= 0) return null;
  return Math.min(1, knownRequests / requests);
}

function totalsFrom(counts: RateCounts): CacheStatsTotals {
  return {
    ...counts,
    hitRate: hitRateFrom(counts.cacheReadTokens, counts.cacheKnownInputTokens),
    continuationHitRate: hitRateFrom(
      counts.continuationCacheReadTokens,
      counts.continuationInputTokens,
    ),
    coverage: coverageFrom(counts.cacheKnownRequests, counts.requests),
  };
}

function defaultBucketMs(windowMs: number, hourAligned: boolean): number {
  const unit = hourAligned ? HOUR_MS : MINUTE_MS;
  const windowUnits = Math.max(1, Math.ceil(windowMs / unit));
  const bucketUnits = Math.max(1, Math.ceil(windowUnits / CACHE_STATS_MAX_SERIES_POINTS));
  return bucketUnits * unit;
}

function capBucketMs(windowMs: number, bucketMs: number, hourAligned: boolean): number {
  const unit = hourAligned ? HOUR_MS : MINUTE_MS;
  let ms = Math.max(unit, Math.ceil(bucketMs / unit) * unit);
  const span = Math.max(unit, windowMs);
  if (Math.ceil(span / ms) > CACHE_STATS_MAX_SERIES_POINTS) {
    ms = Math.ceil(span / CACHE_STATS_MAX_SERIES_POINTS / unit) * unit;
  }
  return ms;
}

export function resolveCacheStatsWindow(input: CacheStatsWindowInput, now: Date): CacheStatsWindow {
  const lastMinutes = input.lastMinutes;
  const lastDays = input.lastDays;
  const durationMs =
    lastMinutes != null ? lastMinutes * MINUTE_MS : Math.max(1, lastDays ?? 1) * DAY_MS;
  const minuteRetentionMs = USAGE_ROLLUP_MINUTE_RETENTION_DAYS * DAY_MS;
  const hourRetentionMs = USAGE_ROLLUP_HOUR_RETENTION_DAYS * DAY_MS;
  const minutesOnly = lastMinutes != null;
  const retentionMs = minutesOnly ? minuteRetentionMs : hourRetentionMs;
  const usesHour = !minutesOnly && durationMs > minuteRetentionMs;
  let bucketMs =
    input.bucket != null && input.bucket > 0
      ? capBucketMs(Math.min(durationMs, retentionMs), input.bucket * MINUTE_MS, usesHour)
      : defaultBucketMs(Math.min(durationMs, retentionMs), usesHour);
  bucketMs = capBucketMs(Math.min(durationMs, retentionMs), bucketMs, usesHour);

  const nowMs = now.getTime();
  const endMs = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs;
  const requestedStartMs = endMs - durationMs;
  const retentionStartMs = nowMs - retentionMs;
  const truncated = requestedStartMs < retentionStartMs;
  const startMs = Math.max(requestedStartMs, retentionStartMs);
  const alignedStartMs = Math.floor(startMs / bucketMs) * bucketMs;
  const bucketCount = Math.max(1, Math.round((endMs - alignedStartMs) / bucketMs));
  const minuteCutoffMs = nowMs - minuteRetentionMs;
  const hourUntilMs = usesHour ? Math.max(alignedStartMs, minuteCutoffMs) : null;

  return {
    start: new Date(alignedStartMs),
    end: new Date(endMs),
    bucketMs,
    bucketCount,
    source: usesHour ? (alignedStartMs < minuteCutoffMs ? "mixed" : "hour") : "minute",
    hourUntil: hourUntilMs === null ? null : new Date(hourUntilMs),
    truncated,
  };
}

function weightedQuantile(
  samples: readonly { rate: number; weight: number }[],
  q: number,
): number | null {
  const total = samples.reduce((sum, sample) => sum + sample.weight, 0);
  if (total <= 0 || samples.length === 0) return null;
  const ranked = [...samples].sort((a, b) => a.rate - b.rate);
  const target = Math.min(1, Math.max(Number.EPSILON, q)) * total;
  let cumulative = 0;
  for (const sample of ranked) {
    cumulative += sample.weight;
    if (cumulative >= target) return sample.rate;
  }
  return ranked[ranked.length - 1]?.rate ?? null;
}

export function stabilityFromBuckets(
  buckets: readonly { hitRate: number | null; cacheKnownInputTokens: number }[],
): CacheStatsStability {
  const samples = buckets
    .filter(
      (bucket): bucket is { hitRate: number; cacheKnownInputTokens: number } =>
        bucket.hitRate !== null && bucket.cacheKnownInputTokens > 0,
    )
    .map((bucket) => ({ rate: bucket.hitRate, weight: bucket.cacheKnownInputTokens }));
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const mean =
    totalWeight > 0
      ? samples.reduce((sum, sample) => sum + sample.rate * sample.weight, 0) / totalWeight
      : null;
  const variance =
    mean === null || totalWeight <= 0
      ? null
      : samples.reduce((sum, sample) => sum + sample.weight * (sample.rate - mean) ** 2, 0) /
        totalWeight;
  const mid = Math.floor(buckets.length / 2);
  const half = (slice: readonly { hitRate: number | null; cacheKnownInputTokens: number }[]) => {
    let read = 0;
    let known = 0;
    for (const bucket of slice) {
      if (bucket.hitRate === null || bucket.cacheKnownInputTokens <= 0) continue;
      known += bucket.cacheKnownInputTokens;
      read += bucket.hitRate * bucket.cacheKnownInputTokens;
    }
    return hitRateFrom(read, known);
  };
  const firstHalfHitRate = half(buckets.slice(0, Math.max(1, mid)));
  const secondHalfHitRate = half(buckets.slice(Math.max(1, mid)));
  return {
    median: weightedQuantile(samples, 0.5),
    p10: weightedQuantile(samples, 0.1),
    stddev: variance === null ? null : Math.sqrt(variance),
    bucketsBelowHalf: buckets.filter((bucket) => bucket.hitRate !== null && bucket.hitRate < 0.5)
      .length,
    firstHalfHitRate,
    secondHalfHitRate,
    change:
      firstHalfHitRate === null || secondHalfHitRate === null
        ? null
        : secondHalfHitRate - firstHalfHitRate,
  };
}

function bucketIndex(window: CacheStatsWindow, bucketStart: Date): number {
  return Math.floor((bucketStart.getTime() - window.start.getTime()) / window.bucketMs);
}

function rowCounts(row: CacheStatsQueryRow): RateCounts {
  return {
    requests: num(row.requests),
    cacheReadTokens: num(row.cacheReadTokens),
    cacheKnownRequests: num(row.cacheKnownRequests),
    cacheKnownInputTokens: num(row.cacheKnownInputTokens),
    continuationRequests: num(row.continuationRequests),
    continuationInputTokens: num(row.continuationInputTokens),
    continuationCacheReadTokens: num(row.continuationCacheReadTokens),
  };
}

function pointsFromBuckets(
  window: CacheStatsWindow,
  buckets: RateCounts[],
  poolMemberId?: string,
): CacheStatsPoint[] {
  return buckets.map((counts, index) => {
    const totals = totalsFrom(counts);
    const point: CacheStatsPoint = {
      start: new Date(window.start.getTime() + index * window.bucketMs).toISOString(),
      requests: totals.requests,
      hitRate: totals.hitRate,
      continuationHitRate: totals.continuationHitRate,
      coverage: totals.coverage,
    };
    if (poolMemberId !== undefined) point.poolMemberId = poolMemberId;
    return point;
  });
}

function emptyBuckets(window: CacheStatsWindow): RateCounts[] {
  return Array.from({ length: window.bucketCount }, () => emptyCounts());
}

function foldRows(window: CacheStatsWindow, rows: readonly CacheStatsQueryRow[]): RateCounts[] {
  const buckets = emptyBuckets(window);
  for (const row of rows) {
    const index = bucketIndex(window, row.bucketStart);
    const bucket = buckets[index];
    if (!bucket) continue;
    addCounts(bucket, rowCounts(row));
  }
  return buckets;
}

function stabilityBuckets(
  buckets: readonly RateCounts[],
): Array<{ hitRate: number | null; cacheKnownInputTokens: number }> {
  return buckets.map((bucket) => ({
    hitRate: hitRateFrom(bucket.cacheReadTokens, bucket.cacheKnownInputTokens),
    cacheKnownInputTokens: bucket.cacheKnownInputTokens,
  }));
}

function notesFor(totals: CacheStatsTotals, window: CacheStatsWindow): CacheStatsNote[] {
  const notes: CacheStatsNote[] = [];
  if (totals.coverage !== null && totals.coverage < CACHE_STATS_LOW_COVERAGE) {
    notes.push("low_coverage");
  }
  if (window.truncated) notes.push("window_truncated_by_retention");
  if (window.source === "hour" || window.source === "mixed") notes.push("hour_resolution");
  if (totals.cacheKnownRequests <= 0) notes.push("engine_reports_no_cache_fields");
  return notes;
}

export function shapeCacheStats({
  window,
  rows,
  split,
}: {
  window: CacheStatsWindow;
  rows: readonly CacheStatsQueryRow[];
  split?: "member";
}): CacheStatsResult {
  const poolBuckets = foldRows(window, rows);
  const poolTotals = totalsFrom(
    poolBuckets.reduce((counts, bucket) => {
      addCounts(counts, bucket);
      return counts;
    }, emptyCounts()),
  );
  const poolSeries = pointsFromBuckets(window, poolBuckets);
  const result: CacheStatsResult = {
    ...poolTotals,
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      bucketMinutes: window.bucketMs / MINUTE_MS,
      source: window.source,
    },
    series: poolSeries,
    stability: stabilityFromBuckets(stabilityBuckets(poolBuckets)),
    notes: notesFor(poolTotals, window),
  };
  if (split !== "member") return result;

  const byMember = new Map<string, CacheStatsQueryRow[]>();
  for (const row of rows) {
    const list = byMember.get(row.poolMemberId) ?? [];
    list.push(row);
    byMember.set(row.poolMemberId, list);
  }
  result.members = [...byMember.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((poolMemberId) => {
      const memberBuckets = foldRows(window, byMember.get(poolMemberId) ?? []);
      const totals = totalsFrom(
        memberBuckets.reduce((counts, bucket) => {
          addCounts(counts, bucket);
          return counts;
        }, emptyCounts()),
      );
      return {
        poolMemberId,
        ...totals,
        series: pointsFromBuckets(window, memberBuckets, poolMemberId),
        stability: stabilityFromBuckets(stabilityBuckets(memberBuckets)),
      };
    });
  result.series = result.members.flatMap((member) => member.series);
  return result;
}
