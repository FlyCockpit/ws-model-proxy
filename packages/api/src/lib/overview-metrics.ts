/**
 * Pure shaping for the dashboard overview metrics. The router runs the SQL
 * aggregation over `usage_rollup_minute`; everything here is deterministic
 * and database-free so the percentile and rate math is unit-tested directly.
 */

import {
  addHistograms,
  emptyLatencyHistogram,
  histogramQuantile,
  OVERVIEW_RANGE_CONFIG,
  type OverviewRange,
} from "@ws-model-proxy/config/usage-metrics";

export type OverviewWindow = {
  range: OverviewRange;
  bucketMs: number;
  bucketCount: number;
  /** Inclusive start of the current period (bucket aligned). */
  start: Date;
  /** Exclusive end of the current period (end of the current bucket). */
  end: Date;
  /** Inclusive start of the previous, equally long period. */
  previousStart: Date;
};

export function overviewWindow(range: OverviewRange, now: Date): OverviewWindow {
  const { durationMs, bucketMs } = OVERVIEW_RANGE_CONFIG[range];
  const endMs = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
  const startMs = endMs - durationMs;
  return {
    range,
    bucketMs,
    bucketCount: Math.round(durationMs / bucketMs),
    start: new Date(startMs),
    end: new Date(endMs),
    previousStart: new Date(startMs - durationMs),
  };
}

/** Raw per-key aggregate row as returned by the aggregation query. */
export type AggregateRow = {
  current: boolean;
  poolId: string;
  poolMemberId: string;
  executionTargetId: string;
  requests: bigint | number;
  successes: bigint | number;
  errors: bigint | number;
  cancels: bigint | number;
  retries: bigint | number;
  usageKnownRequests: bigint | number;
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  cacheReadTokens: bigint | number;
  cacheWriteTokens: bigint | number;
  cacheKnownRequests: bigint | number;
  cacheKnownInputTokens: bigint | number;
  durationCount: bigint | number;
  durationSumMs: bigint | number;
  ttftCount: bigint | number;
  ttftSumMs: bigint | number;
};

export type HistogramRow = {
  current: boolean;
  poolId: string;
  poolMemberId: string;
  executionTargetId: string;
  kind: "latency" | "ttft";
  /** 1-based ordinal from `unnest ... WITH ORDINALITY`. */
  idx: number | bigint;
  count: bigint | number;
};

export type SeriesRow = {
  poolId: string;
  poolMemberId: string;
  /** 0-based bucket index relative to the window start. */
  bucket: number | bigint;
  requests: bigint | number;
  errors: bigint | number;
};

export type Accumulator = {
  requests: number;
  successes: number;
  errors: number;
  cancels: number;
  retries: number;
  usageKnownRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheKnownRequests: number;
  cacheKnownInputTokens: number;
  durationCount: number;
  durationSumMs: number;
  ttftCount: number;
  ttftSumMs: number;
  latencyHistogram: number[];
  ttftHistogram: number[];
};

export function emptyAccumulator(): Accumulator {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    cancels: 0,
    retries: 0,
    usageKnownRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheKnownRequests: 0,
    cacheKnownInputTokens: 0,
    durationCount: 0,
    durationSumMs: 0,
    ttftCount: 0,
    ttftSumMs: 0,
    latencyHistogram: emptyLatencyHistogram(),
    ttftHistogram: emptyLatencyHistogram(),
  };
}

const COUNTER_KEYS = [
  "requests",
  "successes",
  "errors",
  "cancels",
  "retries",
  "usageKnownRequests",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheKnownRequests",
  "cacheKnownInputTokens",
  "durationCount",
  "durationSumMs",
  "ttftCount",
  "ttftSumMs",
] as const;

export function addAccumulators(target: Accumulator, add: Accumulator): Accumulator {
  for (const key of COUNTER_KEYS) target[key] += add[key];
  target.latencyHistogram = addHistograms(target.latencyHistogram, add.latencyHistogram);
  target.ttftHistogram = addHistograms(target.ttftHistogram, add.ttftHistogram);
  return target;
}

/** Aggregate statistics exposed to the dashboard. Rates are 0..1. */
export type OverviewStats = {
  requests: number;
  successes: number;
  errors: number;
  cancels: number;
  retries: number;
  /** errors / requests; null when there were no requests. */
  errorRate: number | null;
  usageKnownRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /**
   * Token-weighted prompt-cache hit rate over requests whose upstream reported
   * cache usage; null ("not reported") when none did.
   */
  cacheHitRate: number | null;
  cacheReportedRequests: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
};

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export function statsFromAccumulator(value: Accumulator): OverviewStats {
  return {
    requests: value.requests,
    successes: value.successes,
    errors: value.errors,
    cancels: value.cancels,
    retries: value.retries,
    errorRate: value.requests > 0 ? value.errors / value.requests : null,
    usageKnownRequests: value.usageKnownRequests,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cachedTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    cacheHitRate:
      value.cacheKnownRequests > 0 && value.cacheKnownInputTokens > 0
        ? Math.min(1, value.cacheReadTokens / value.cacheKnownInputTokens)
        : null,
    cacheReportedRequests: value.cacheKnownRequests,
    avgLatencyMs: value.durationCount > 0 ? round(value.durationSumMs / value.durationCount) : null,
    p50LatencyMs: round(histogramQuantile(value.latencyHistogram, 0.5)),
    p95LatencyMs: round(histogramQuantile(value.latencyHistogram, 0.95)),
    p50TtftMs: round(histogramQuantile(value.ttftHistogram, 0.5)),
    p95TtftMs: round(histogramQuantile(value.ttftHistogram, 0.95)),
  };
}

export function metricKey(row: {
  poolId: string;
  poolMemberId: string;
  executionTargetId: string;
}): string {
  return `${row.poolId}\u0000${row.poolMemberId}\u0000${row.executionTargetId}`;
}

export type KeyedAccumulators = {
  current: Map<string, Accumulator>;
  previous: Map<string, Accumulator>;
  identities: Map<string, { poolId: string; poolMemberId: string; executionTargetId: string }>;
};

/** Folds the aggregate and histogram rows into per-key accumulators. */
export function accumulateRows(
  aggregates: readonly AggregateRow[],
  histograms: readonly HistogramRow[],
): KeyedAccumulators {
  const result: KeyedAccumulators = {
    current: new Map(),
    previous: new Map(),
    identities: new Map(),
  };
  const bucketFor = (row: { current: boolean } & Parameters<typeof metricKey>[0]) => {
    const key = metricKey(row);
    result.identities.set(key, {
      poolId: row.poolId,
      poolMemberId: row.poolMemberId,
      executionTargetId: row.executionTargetId,
    });
    const map = row.current ? result.current : result.previous;
    let value = map.get(key);
    if (!value) {
      value = emptyAccumulator();
      map.set(key, value);
    }
    return value;
  };
  for (const row of aggregates) {
    const value = bucketFor(row);
    for (const key of COUNTER_KEYS) value[key] += Number(row[key]);
  }
  for (const row of histograms) {
    const value = bucketFor(row);
    const index = Number(row.idx) - 1;
    if (!Number.isInteger(index) || index < 0) continue;
    const target = row.kind === "ttft" ? value.ttftHistogram : value.latencyHistogram;
    while (target.length <= index) target.push(0);
    target[index] = (target[index] ?? 0) + Number(row.count);
  }
  return result;
}

export function sumAccumulators(values: Iterable<Accumulator>): Accumulator {
  const total = emptyAccumulator();
  for (const value of values) addAccumulators(total, value);
  return total;
}

/**
 * Requests-per-minute series for one pool, one numeric column per series key
 * (member id, or "" for requests that failed before a member was selected).
 * Every bucket of the window is present so charts never interpolate gaps.
 */
export function poolSeries(
  window: OverviewWindow,
  rows: readonly SeriesRow[],
  seriesKeys: readonly string[],
): Array<{ bucketStart: string; values: Record<string, number> }> {
  const perMinute = window.bucketMs / 60_000;
  const buckets = Array.from({ length: window.bucketCount }, (_, index) => ({
    bucketStart: new Date(window.start.getTime() + index * window.bucketMs).toISOString(),
    values: Object.fromEntries(seriesKeys.map((key) => [key, 0])) as Record<string, number>,
  }));
  for (const row of rows) {
    const index = Number(row.bucket);
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.values[row.poolMemberId] =
      (bucket.values[row.poolMemberId] ?? 0) + Number(row.requests) / perMinute;
  }
  for (const bucket of buckets)
    for (const key of Object.keys(bucket.values))
      bucket.values[key] = Math.round((bucket.values[key] ?? 0) * 100) / 100;
  return buckets;
}
