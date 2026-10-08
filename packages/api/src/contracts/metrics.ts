/**
 * `metrics_query` / `activity.metrics.query` (spec §6.2 #7): the metric names, which rollup each
 * reads, and which `groupBy` values are valid for each scope. Every groupBy is a rollup key;
 * percentiles come from the fixed, versioned histogram bounds: `histogramVersion: "v1"` =
 * `LATENCY_HISTOGRAM_BOUNDS_MS` in `@ws-model-proxy/config/usage-metrics` (a change is a new
 * version).
 */
import {
  ENGINE_LOAD_ROLLUP_MINUTE_RETENTION_DAYS,
  NODE_METRICS_MINUTE_RETENTION_DAYS,
  USAGE_ROLLUP_HOUR_RETENTION_DAYS,
  USAGE_ROLLUP_MINUTE_RETENTION_DAYS,
} from "@ws-model-proxy/config/usage-metrics";
import { z } from "zod";
import { idSchema, isoDateSchema } from "./common";

/** Request metrics: `UsageRollupMinute/Hour`. */
export const REQUEST_METRICS = [
  "requests",
  "errors",
  "rejections",
  "rejections_capacity",
  "rejections_context",
  "rejections_spend",
  "rejections_other",
  "ttft_p50",
  "ttft_p95",
  "latency_p50",
  "latency_p95",
  "queue_wait_p50",
  "queue_wait_p95",
  "decode_tps",
  "prefill_tps",
  "input_tokens",
  "output_tokens",
  "cache_hit_rate",
  "cloud_share",
] as const;
/** Engine load: `RuntimeLoadMinute` (per instance, 8 days). */
export const LOAD_METRICS = [
  "kv_usage_avg",
  "kv_usage_max",
  "running_max",
  "waiting_max",
  "full_ratio",
] as const;
/** Node gauges: `NodeMetricsMinute` (7 days), plus `custom:<name>` from node metric commands. */
export const NODE_METRICS = [
  "cpu_pct",
  "memory_available_gb",
  "accelerator_free_gb",
  "gpu_util_pct",
  "gpu_temp_c",
] as const;
export const CUSTOM_METRIC_PATTERN = /^custom:[A-Za-z0-9_.:-]{1,64}$/;

export type MetricFamily = "request" | "load" | "node";
export const metricSchema = z.union([
  z.enum([...REQUEST_METRICS, ...LOAD_METRICS, ...NODE_METRICS]),
  z.string().regex(CUSTOM_METRIC_PATTERN),
]);
export type Metric = z.infer<typeof metricSchema>;

export function metricFamily(metric: Metric): MetricFamily {
  if ((REQUEST_METRICS as readonly string[]).includes(metric)) return "request";
  if ((LOAD_METRICS as readonly string[]).includes(metric)) return "load";
  return "node";
}

export const METRIC_SCOPES = ["pool", "runtime", "version", "node", "instance"] as const;
export type MetricScope = (typeof METRIC_SCOPES)[number];
export const GROUP_BY = [
  "runtime",
  "version",
  "node",
  "instance",
  "model",
  "member",
  "source",
] as const;
export type GroupBy = (typeof GROUP_BY)[number];

/**
 * Valid groupBy per scope and metric family. `member` = pool × served model × instance;
 * `model` = served model (or provider model for cloud traffic); `source` = API key, test,
 * agent test, sidecar. Load metrics have no model/member/source keys; node metrics are per node.
 */
export const GROUP_BY_BY_SCOPE: Record<MetricScope, Record<MetricFamily, readonly GroupBy[]>> = {
  pool: {
    request: ["runtime", "version", "node", "instance", "model", "member", "source"],
    load: ["runtime", "version", "node", "instance"],
    node: ["node"],
  },
  runtime: {
    request: ["version", "node", "instance", "model", "source"],
    load: ["version", "node", "instance"],
    node: ["node"],
  },
  version: {
    request: ["node", "instance", "model", "source"],
    load: ["node", "instance"],
    node: ["node"],
  },
  node: {
    request: ["runtime", "version", "instance", "model", "source"],
    load: ["runtime", "version", "instance"],
    node: [],
  },
  instance: { request: ["model", "source"], load: [], node: [] },
};

export const METRIC_RANGES = ["1h", "24h", "7d", "30d"] as const;
export const METRIC_STEPS = ["1m", "5m", "1h", "1d"] as const;
const DAY_MS = 86_400_000;
export const RANGE_MS: Record<(typeof METRIC_RANGES)[number], number> = {
  "1h": 3_600_000,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};
export const STEP_MS: Record<(typeof METRIC_STEPS)[number], number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": DAY_MS,
};
/**
 * Output bounds (MCP answers stay small): at most this many buckets per series, and buckets ×
 * metrics per series. Grouped answers keep the largest groups that fit `METRICS_MAX_VALUES`.
 */
export const METRICS_MAX_POINTS = 720;
export const METRICS_MAX_CELLS = 2_880;
export const METRICS_MAX_VALUES = 8_000;
export const METRICS_MAX_GROUPS = 10;

/** Buckets a query spans: the first one starts at the range start rounded down to the step. */
export function metricBuckets(fromMs: number, toMs: number, stepMs: number): number {
  const start = Math.floor(fromMs / stepMs) * stepMs;
  return Math.max(1, Math.ceil((toMs - start) / stepMs));
}
/**
 * How far back each family is kept, so a query never promises more than the tables hold:
 * request rollups 30 days per minute and 13 months per hour; engine load (per minute only) 8
 * days; node gauges (per minute only) 7 days. Load and node rows carry no pool key: a pool scope
 * follows the pool's CURRENT members back in time.
 */
export const RANGE_LIMIT_MS: Record<MetricFamily, { minuteSteps: number; any: number }> = {
  request: {
    minuteSteps: USAGE_ROLLUP_MINUTE_RETENTION_DAYS * DAY_MS,
    any: USAGE_ROLLUP_HOUR_RETENTION_DAYS * DAY_MS,
  },
  load: {
    minuteSteps: ENGINE_LOAD_ROLLUP_MINUTE_RETENTION_DAYS * DAY_MS,
    any: ENGINE_LOAD_ROLLUP_MINUTE_RETENTION_DAYS * DAY_MS,
  },
  node: {
    minuteSteps: NODE_METRICS_MINUTE_RETENTION_DAYS * DAY_MS,
    any: NODE_METRICS_MINUTE_RETENTION_DAYS * DAY_MS,
  },
};

export const metricsQueryInputSchema = z
  .object({
    scope: z.union([
      z.object({ pool: idSchema }).strict(),
      z.object({ runtime: idSchema }).strict(),
      z.object({ version: idSchema }).strict(),
      z.object({ node: idSchema }).strict(),
      z.object({ instance: idSchema }).strict(),
    ]),
    metrics: z.array(metricSchema).min(1).max(16),
    range: z.union([
      z.enum(METRIC_RANGES),
      z.object({ from: isoDateSchema, to: isoDateSchema }).strict(),
    ]),
    step: z.enum(METRIC_STEPS),
    groupBy: z.enum(GROUP_BY).optional(),
    /**
     * Count agent tests (`model_test`) in the request metrics. Off by default (as on the
     * Overview): metrics describe real load, and the tests left out are counted in `totals.tests`.
     */
    includeAgentTests: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, ctx) => {
    const scope = Object.keys(input.scope)[0] as MetricScope;
    if (input.groupBy)
      for (const metric of input.metrics)
        if (!GROUP_BY_BY_SCOPE[scope][metricFamily(metric)].includes(input.groupBy))
          ctx.addIssue({
            code: "custom",
            path: ["groupBy"],
            message: `groupBy ${input.groupBy} is not available for ${metric} in a ${scope} scope.`,
          });
    const rangeMs =
      typeof input.range === "string"
        ? RANGE_MS[input.range]
        : Date.parse(input.range.to) - Date.parse(input.range.from);
    if (rangeMs <= 0) ctx.addIssue({ code: "custom", path: ["range"], message: "Empty range." });
    const points = Math.ceil(rangeMs / STEP_MS[input.step]) + 1;
    if (points > METRICS_MAX_POINTS || points * input.metrics.length > METRICS_MAX_CELLS)
      ctx.addIssue({
        code: "custom",
        path: ["step"],
        message: `Too many points: use a coarser step, a shorter range or fewer metrics (≤${METRICS_MAX_POINTS} buckets, ≤${METRICS_MAX_CELLS} buckets × metrics).`,
      });
    const minuteStep = input.step === "1m" || input.step === "5m";
    // How far back the range reaches: a custom range may start long ago and be short.
    const reachMs =
      typeof input.range === "string"
        ? rangeMs
        : Math.max(rangeMs, Date.now() - Date.parse(input.range.from));
    for (const metric of input.metrics) {
      const limit = RANGE_LIMIT_MS[metricFamily(metric)];
      const maxMs = minuteStep ? limit.minuteSteps : limit.any;
      if (reachMs > maxMs)
        ctx.addIssue({
          code: "custom",
          path: ["range"],
          message: `${metric} is kept ${Math.round(maxMs / DAY_MS)} days for this step.`,
        });
    }
  });

/**
 * Compact on purpose (MCP answers are read by agents): no input is echoed, a bucket with no data
 * is left out (`at` lists the buckets that have some), a metric with no data is left out of
 * `totals`, and only the largest groups are returned (`truncated`). A point's time is
 * `start + at × step`. Units: ms (latency, ttft, queue wait), tokens/s, GB, percent (`*_pct`),
 * fractions 0–1 (kv usage, ratios, shares). `totals.tests` (not a metric) counts the agent tests
 * the request metrics left out, when there are any.
 */
export const metricsQueryOutputSchema = z
  .object({
    start: isoDateSchema,
    series: z.array(
      z
        .object({
          /** Absent when not grouped; `key` "" collects rows without one (e.g. cloud traffic). */
          group: z.object({ key: z.string(), label: z.string().optional() }).strict().optional(),
          at: z.array(z.number().int()),
          /** One value per `at` entry; null where the metric has no data in that bucket. */
          values: z.record(z.string(), z.array(z.number().nullable())),
        })
        .strict(),
    ),
    totals: z.record(z.string(), z.number()),
    truncated: z.literal(true).optional(),
    histogramVersion: z.literal("v1"),
  })
  .strict();
