/**
 * `metrics_query` / `activity.metrics.query` (spec §6.2 #7): the metric names, which rollup each
 * reads, and which `groupBy` values are valid for each scope. Every groupBy is a rollup key;
 * percentiles come from the fixed, versioned histogram bounds (HISTOGRAM_BOUNDS_V1).
 */
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
/** Minute buckets cover 30 days, hour buckets 13 months. */
export const MINUTE_STEP_MAX_RANGE_MS = 30 * DAY_MS;
export const HOUR_STEP_MAX_RANGE_MS = 396 * DAY_MS;

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
    /** Include AGENT_TEST traffic (default: true here, false on the Overview). */
    includeAgentTests: z.boolean().default(true),
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
        ? { "1h": 3_600_000, "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS }[input.range]
        : Date.parse(input.range.to) - Date.parse(input.range.from);
    if (rangeMs <= 0) ctx.addIssue({ code: "custom", path: ["range"], message: "Empty range." });
    if ((input.step === "1m" || input.step === "5m") && rangeMs > MINUTE_STEP_MAX_RANGE_MS)
      ctx.addIssue({ code: "custom", path: ["step"], message: "Minute steps cover 30 days." });
    if (rangeMs > HOUR_STEP_MAX_RANGE_MS)
      ctx.addIssue({ code: "custom", path: ["range"], message: "History covers 13 months." });
  });

const metricValues = z.record(z.string(), z.number().nullable());
export const metricsQueryOutputSchema = z
  .object({
    series: z.array(
      z
        .object({
          /** Null when not grouped. */
          group: z.object({ key: z.string(), label: z.string() }).strict().nullable(),
          points: z.array(z.object({ t: isoDateSchema }).catchall(z.number().nullable())),
        })
        .strict(),
    ),
    totals: metricValues,
    histogramVersion: z.literal("v1"),
  })
  .strict();
