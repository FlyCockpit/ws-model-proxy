import {
  CUSTOM_METRIC_PATTERN,
  GROUP_BY,
  GROUP_BY_BY_SCOPE,
  type GroupBy,
  LOAD_METRICS,
  METRIC_RANGES,
  METRIC_SCOPES,
  METRIC_STEPS,
  METRICS_MAX_CELLS,
  METRICS_MAX_POINTS,
  type Metric,
  type MetricFamily,
  type MetricScope,
  metricFamily,
  metricSchema,
  NODE_METRICS,
  RANGE_LIMIT_MS,
  RANGE_MS,
  REQUEST_METRICS,
  STEP_MS,
} from "@ws-model-proxy/api/contracts/metrics";

/**
 * The Activity metrics explorer's view, kept in the URL (`/$lang/activity?…`) so a view can be
 * shared. Every field is optional: links to the plain page name none, and the page derives the
 * defaults (first target of the scope, the range's natural step, …).
 */
export type MetricRange = (typeof METRIC_RANGES)[number];
export type MetricStep = (typeof METRIC_STEPS)[number];
export type MetricsView = "chart" | "table";

export type ActivityMetricsSearch = {
  scope?: MetricScope;
  /** The scope's target: a pool, runtime, version, node or instance id. */
  id?: string;
  /** The runtime a version or instance scope picks from. */
  runtime?: string;
  metric?: Metric;
  range?: MetricRange;
  step?: MetricStep;
  groupBy?: GroupBy;
  tests?: boolean;
  view?: MetricsView;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function idOf(value: unknown): string | undefined {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : undefined;
}

export function parseActivityMetricsSearch(search: Record<string, unknown>): ActivityMetricsSearch {
  const metric = metricSchema.safeParse(search.metric);
  const parsed: ActivityMetricsSearch = {
    scope: oneOf(METRIC_SCOPES, search.scope),
    id: idOf(search.id),
    runtime: idOf(search.runtime),
    metric: metric.success ? metric.data : undefined,
    range: oneOf(METRIC_RANGES, search.range),
    step: oneOf(METRIC_STEPS, search.step),
    groupBy: oneOf(GROUP_BY, search.groupBy),
    tests: search.tests === true || search.tests === "true" ? true : undefined,
    view: oneOf(["chart", "table"] as const, search.view),
  };
  // Leave unset fields out so the URL stays short.
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  ) as ActivityMetricsSearch;
}

export const METRIC_GROUPS: ReadonlyArray<{ family: MetricFamily; metrics: readonly Metric[] }> = [
  { family: "request", metrics: REQUEST_METRICS },
  { family: "load", metrics: LOAD_METRICS },
  { family: "node", metrics: NODE_METRICS },
];

export function isCustomMetric(metric: Metric): boolean {
  return CUSTOM_METRIC_PATTERN.test(metric);
}

/** The metrics the totals row shows next to the chart's metric, per family. */
const SUMMARY_METRICS: Record<MetricFamily, readonly Metric[]> = {
  request: [
    "requests",
    "errors",
    "rejections",
    "latency_p95",
    "ttft_p95",
    "queue_wait_p95",
    "input_tokens",
    "output_tokens",
  ],
  load: LOAD_METRICS,
  node: NODE_METRICS,
};

/** The chart's metric first, then the family's summary metrics. */
export function summaryMetrics(metric: Metric): Metric[] {
  return [...new Set<Metric>([metric, ...SUMMARY_METRICS[metricFamily(metric)]])];
}

/** Buckets a range spans at a step (the contract's bound: range / step + 1). */
export function bucketCount(range: MetricRange, step: MetricStep): number {
  return Math.ceil(RANGE_MS[range] / STEP_MS[step]) + 1;
}

/** Ranges a metric is kept for (engine load and node gauges are kept about a week). */
export function rangesFor(metric: Metric): MetricRange[] {
  const limit = RANGE_LIMIT_MS[metricFamily(metric)];
  return METRIC_RANGES.filter((range) => RANGE_MS[range] <= limit.any);
}

/** Steps a range allows: not more buckets than the contract returns, minute steps kept long enough. */
export function stepsFor(range: MetricRange, metric: Metric): MetricStep[] {
  const limit = RANGE_LIMIT_MS[metricFamily(metric)];
  return METRIC_STEPS.filter((step) => {
    const minuteStep = step === "1m" || step === "5m";
    const maxMs = minuteStep ? limit.minuteSteps : limit.any;
    return (
      bucketCount(range, step) <= METRICS_MAX_POINTS &&
      // The totals query asks for up to 9 metrics at once.
      bucketCount(range, step) * summaryMetrics(metric).length <= METRICS_MAX_CELLS &&
      RANGE_MS[range] <= maxMs &&
      STEP_MS[step] < RANGE_MS[range]
    );
  });
}

/** The finest step that keeps a chart readable (≈ 30–300 points). */
const DEFAULT_STEP: Record<MetricRange, MetricStep> = {
  "1h": "1m",
  "24h": "5m",
  "7d": "1h",
  "30d": "1d",
};

export function defaultStep(range: MetricRange, metric: Metric): MetricStep {
  const steps = stepsFor(range, metric);
  const preferred = DEFAULT_STEP[range];
  return steps.includes(preferred) ? preferred : (steps[steps.length - 1] ?? "1d");
}

/** Group-by choices a scope offers for a metric (a pool shared with you: by source only). */
export function groupByOptions(scope: MetricScope, metric: Metric, sharedPool: boolean): GroupBy[] {
  const options = [...GROUP_BY_BY_SCOPE[scope][metricFamily(metric)]];
  return sharedPool ? options.filter((option) => option === "source") : options;
}

// ── Units ──

export type MetricUnit = "count" | "ms" | "tps" | "fraction" | "percent" | "gb" | "celsius" | "raw";

export function metricUnit(metric: Metric): MetricUnit {
  if (isCustomMetric(metric)) return "raw";
  if (/^(ttft|latency|queue_wait)_p/.test(metric)) return "ms";
  if (metric.endsWith("_tps")) return "tps";
  if (metric.endsWith("_pct")) return "percent";
  if (metric.endsWith("_gb")) return "gb";
  if (metric.endsWith("_c")) return "celsius";
  if (
    metric.startsWith("kv_usage") ||
    metric === "full_ratio" ||
    metric === "cache_hit_rate" ||
    metric === "cloud_share"
  )
    return "fraction";
  return "count";
}

/**
 * Request counters: a bucket the answer leaves out had none, so it charts as 0. Every other
 * metric has no value there (a gap).
 */
export function zeroWhenMissing(metric: Metric): boolean {
  return metricFamily(metric) === "request" && metricUnit(metric) === "count";
}

/**
 * A value in its unit, localized (Intl units). Tokens per second have no Intl unit: the caller
 * passes the localized pattern.
 */
export function formatMetricValue(
  metric: Metric,
  value: number,
  locale: string,
  tokensPerSecond: (value: string) => string,
): string {
  const format = (options: Intl.NumberFormatOptions, shown = value) =>
    new Intl.NumberFormat(locale, options).format(shown);
  const unit = (name: string, maximumFractionDigits: number, shown = value) =>
    format({ style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits }, shown);
  switch (metricUnit(metric)) {
    case "count":
      return format({
        notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
        maximumFractionDigits: 1,
      });
    case "ms":
      return Math.abs(value) >= 10_000 ? unit("second", 1, value / 1000) : unit("millisecond", 0);
    case "tps":
      return tokensPerSecond(format({ maximumFractionDigits: 1 }));
    case "fraction":
      return format({ style: "percent", maximumFractionDigits: 1 });
    case "percent":
      return unit("percent", 1);
    case "gb":
      return unit("gigabyte", 1);
    case "celsius":
      return unit("celsius", 0);
    case "raw":
      return format({ maximumFractionDigits: 3 });
  }
}

// ── Chart data ──

export type MetricsSeries = {
  group?: { key: string; label?: string };
  at: number[];
  values: Record<string, Array<number | null>>;
};

export type ChartRow = { at: number; time: number } & Record<string, number | null>;

/**
 * One row per bucket (`start + index × step`), one column per series (`s0`, `s1`, …), for the
 * chart and the table. Counters fill missing buckets with 0; other metrics leave a gap.
 */
export function chartRows(
  series: readonly MetricsSeries[],
  metric: Metric,
  start: string,
  step: MetricStep,
  buckets: number,
): ChartRow[] {
  const startMs = Date.parse(start);
  const stepMs = STEP_MS[step];
  const fill = zeroWhenMissing(metric) ? 0 : null;
  const last = Math.max(buckets, ...series.map((one) => (one.at[one.at.length - 1] ?? -1) + 1));
  const rows: ChartRow[] = [];
  for (let index = 0; index < last; index += 1) {
    const row: ChartRow = { at: index, time: startMs + index * stepMs };
    series.forEach((_, column) => {
      row[`s${column}`] = fill;
    });
    rows.push(row);
  }
  series.forEach((one, column) => {
    const values = one.values[metric] ?? [];
    one.at.forEach((index, position) => {
      const row = rows[index];
      if (row) row[`s${column}`] = values[position] ?? fill;
    });
  });
  return rows;
}
