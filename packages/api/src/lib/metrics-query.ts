/**
 * `activity.metrics.query` / MCP `metrics_query`: reads the rollup tables, never the request
 * log. Request metrics come from `usage_rollup_minute` (+ `usage_rollup_hour` for hour and day
 * steps, which hold what compaction moved), engine load from `runtime_load_minute`, node gauges
 * and node metric command values from `node_metrics_minute`.
 *
 * Ownership: the scope is resolved through owner-scoped lookups first (NOT_FOUND otherwise), so
 * every id the SQL filters on is the caller's. Load and node rows are also filtered on
 * `ownerUserId` (they are the node owner's). A pool shared with the caller gives request metrics
 * of the caller's own requests to it only (`requesterUserId`), ungrouped or by source.
 *
 * Bounds: the contract caps buckets and buckets × metrics; here a grouped answer keeps the
 * largest groups that fit `METRICS_MAX_VALUES` values (two queries per family: totals by group,
 * then the series of the kept groups).
 */
import { ORPCError } from "@orpc/server";
import { histogramQuantile, LATENCY_HISTOGRAM_BUCKETS } from "@ws-model-proxy/config/usage-metrics";
import prisma, { Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import {
  type GroupBy,
  METRICS_MAX_GROUPS,
  METRICS_MAX_VALUES,
  type Metric,
  type MetricFamily,
  metricBuckets,
  metricFamily,
  type metricsQueryInputSchema,
  type metricsQueryOutputSchema,
  RANGE_MS,
  STEP_MS,
} from "../contracts/metrics";

export type MetricsQueryInput = z.output<typeof metricsQueryInputSchema>;
export type MetricsQueryOutput = z.infer<typeof metricsQueryOutputSchema>;

// ── Scope resolution (owner-scoped) ──

type ResolvedScope =
  | { kind: "pool"; id: string; shared: boolean; runtimeIds: string[] }
  | { kind: "runtime"; id: string; nodeIds: string[] }
  | { kind: "version"; id: string; nodeIds: string[] }
  | { kind: "node"; id: string }
  | { kind: "instance"; id: string; nodeIds: string[] };

const notFound = () =>
  new ORPCError("NOT_FOUND", { message: "No such pool, runtime, version, node or instance." });

function uniq(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

async function resolveScope(
  userId: string,
  scope: MetricsQueryInput["scope"],
): Promise<ResolvedScope> {
  if ("pool" in scope) {
    const pool = await prisma.pool.findFirst({
      where: { id: scope.pool, userId },
      select: {
        id: true,
        Members: {
          // Engine load and node gauges of the caller's own member runtimes only (a member a
          // share holder contributed runs on their nodes).
          where: { RuntimeModel: { userId } },
          select: { RuntimeModel: { select: { runtimeId: true } } },
        },
      },
    });
    if (pool)
      return {
        kind: "pool",
        id: pool.id,
        shared: false,
        runtimeIds: uniq(pool.Members.map((member) => member.RuntimeModel?.runtimeId)),
      };
    const share = await prisma.share.findFirst({
      where: { poolId: scope.pool, granteeUserId: userId, canUse: true },
      select: { poolId: true },
    });
    if (share) return { kind: "pool", id: share.poolId, shared: true, runtimeIds: [] };
    throw notFound();
  }
  if ("runtime" in scope) {
    const runtime = await prisma.runtime.findFirst({
      where: { id: scope.runtime, userId },
      select: {
        id: true,
        nodeId: true,
        Instances: { select: { Ranks: { select: { nodeId: true } } }, take: 100 },
      },
    });
    if (!runtime) throw notFound();
    return {
      kind: "runtime",
      id: runtime.id,
      nodeIds: uniq([
        runtime.nodeId,
        ...runtime.Instances.flatMap((instance) => instance.Ranks.map((rank) => rank.nodeId)),
      ]),
    };
  }
  if ("version" in scope) {
    const version = await prisma.runtimeVersion.findFirst({
      where: { id: scope.version, Runtime: { userId } },
      select: {
        id: true,
        Runtime: { select: { nodeId: true } },
        Instances: { select: { Ranks: { select: { nodeId: true } } }, take: 100 },
      },
    });
    if (!version) throw notFound();
    return {
      kind: "version",
      id: version.id,
      nodeIds: uniq([
        version.Runtime.nodeId,
        ...version.Instances.flatMap((instance) => instance.Ranks.map((rank) => rank.nodeId)),
      ]),
    };
  }
  if ("node" in scope) {
    const node = await prisma.node.findFirst({
      where: { id: scope.node, userId },
      select: { id: true },
    });
    if (!node) throw notFound();
    return { kind: "node", id: node.id };
  }
  const instance = await prisma.runtimeInstance.findFirst({
    where: { id: scope.instance, userId },
    select: { id: true, Ranks: { select: { nodeId: true } } },
  });
  if (!instance) throw notFound();
  return {
    kind: "instance",
    id: instance.id,
    nodeIds: uniq(instance.Ranks.map((rank) => rank.nodeId)),
  };
}

// ── SQL ──

type Row = Record<string, unknown> & { t?: Date | string; g?: string; n?: string };

const REQUEST_COUNTERS = [
  "requests",
  "errors",
  "cloudRequests",
  "rejectedCapacity",
  "rejectedContext",
  "rejectedSpend",
  "rejectedOther",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheKnownInputTokens",
  "generationTokens",
  "generationMs",
  "prefillTokens",
  "prefillMs",
] as const;
const HISTOGRAMS = {
  latency: "latencyHistogram",
  ttft: "ttftHistogram",
  queue_wait: "queueWaitHistogram",
} as const;
type HistogramName = keyof typeof HISTOGRAMS;

function histogramOf(metric: Metric): HistogramName | null {
  if (metric.startsWith("latency_")) return "latency";
  if (metric.startsWith("ttft_")) return "ttft";
  if (metric.startsWith("queue_wait_")) return "queue_wait";
  return null;
}

const ident = (name: string) => Prisma.raw(`"${name}"`);
const zero = () => Prisma.sql`''`;

/**
 * The group expression of a family's rows (`r` usage, `l` load, `n` node). In a pool, a member a
 * share holder contributed runs on their runtime and node: those placement keys collapse into
 * "" (the pool owner sees that the traffic happened, not where).
 */
function requestGroup(groupBy: GroupBy | undefined, userId: string, pool: boolean): Prisma.Sql {
  const model = Prisma.sql`CASE WHEN r."runtimeModelId" <> '' THEN r."runtimeModelId" ELSE r."providerModelId" END`;
  const own = (key: Prisma.Sql) =>
    pool
      ? Prisma.sql`CASE WHEN r."versionId" IN (SELECT v.id FROM runtime_version v
          JOIN runtime rt ON rt.id = v."runtimeId" WHERE rt."userId" = ${userId})
          THEN ${key} ELSE '' END`
      : key;
  switch (groupBy) {
    case undefined:
      return zero();
    case "runtime":
      // Older rows carry the runtime only through their version.
      return own(
        Prisma.sql`COALESCE(NULLIF(r."runtimeId", ''), (SELECT v."runtimeId" FROM runtime_version v WHERE v.id = r."versionId"), '')`,
      );
    case "version":
      return own(Prisma.sql`r."versionId"`);
    case "node":
      return own(Prisma.sql`r."nodeId"`);
    case "instance":
      return own(Prisma.sql`r."instanceId"`);
    case "model":
      return model;
    case "member":
      return Prisma.sql`(${model}) || ${own(Prisma.sql`CASE WHEN r."instanceId" <> '' THEN '/' || r."instanceId" ELSE '' END`)}`;
    case "source":
      return Prisma.sql`r.source::text`;
  }
}

function loadGroup(groupBy: GroupBy | undefined): Prisma.Sql {
  switch (groupBy) {
    case "runtime":
      return Prisma.sql`l."runtimeId"`;
    case "version":
      return Prisma.sql`l."versionId"`;
    case "node":
      return Prisma.sql`l."nodeId"`;
    case "instance":
      return Prisma.sql`l."instanceId"`;
    default:
      return zero();
  }
}

function bucketExpr(alias: string, stepMs: number): Prisma.Sql {
  return Prisma.sql`date_bin(make_interval(secs => ${stepMs / 1000}::float8), ${Prisma.raw(alias)}."bucketStart", TIMESTAMP '1970-01-01')`;
}

type Window = { from: Date; to: Date; stepMs: number };

function requestWhere(
  userId: string,
  scope: ResolvedScope,
  window: Window,
  includeAgentTests: boolean,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`"bucketStart" >= ${window.from}`,
    Prisma.sql`"bucketStart" < ${window.to}`,
  ];
  if (!includeAgentTests) parts.push(Prisma.sql`source <> 'AGENT_TEST'::"RequestSource"`);
  // Placement scopes count traffic of the caller's own pools and direct calls only (as the
  // request log does): a runtime contributed to someone else's pool serves that owner's users.
  if (scope.kind !== "pool") parts.push(Prisma.sql`"ownerUserId" = ${userId}`);
  switch (scope.kind) {
    case "pool":
      parts.push(Prisma.sql`"poolId" = ${scope.id}`);
      parts.push(
        scope.shared
          ? Prisma.sql`"requesterUserId" = ${userId}`
          : Prisma.sql`"ownerUserId" = ${userId}`,
      );
      break;
    case "runtime":
      parts.push(
        Prisma.sql`("runtimeId" = ${scope.id} OR "versionId" IN (SELECT id FROM runtime_version WHERE "runtimeId" = ${scope.id}))`,
      );
      break;
    case "version":
      parts.push(Prisma.sql`"versionId" = ${scope.id}`);
      break;
    case "node":
      parts.push(Prisma.sql`"nodeId" = ${scope.id}`);
      break;
    case "instance":
      parts.push(Prisma.sql`"instanceId" = ${scope.id}`);
      break;
  }
  return Prisma.join(parts, " AND ");
}

function requestColumns(histograms: readonly HistogramName[]): Prisma.Sql {
  const columns = [
    "bucketStart",
    "poolId",
    "runtimeId",
    "versionId",
    "nodeId",
    "instanceId",
    "runtimeModelId",
    "providerModelId",
    "source",
    ...REQUEST_COUNTERS,
    ...histograms.map((name) => HISTOGRAMS[name]),
  ];
  return Prisma.raw(columns.map((column) => `"${column}"`).join(", "));
}

function requestAggregates(histograms: readonly HistogramName[]): Prisma.Sql {
  const parts = REQUEST_COUNTERS.map(
    (column) => Prisma.sql`SUM(r.${ident(column)})::float8 AS ${ident(column)}`,
  );
  for (const name of histograms)
    for (let index = 1; index <= LATENCY_HISTOGRAM_BUCKETS; index += 1)
      parts.push(
        Prisma.sql`SUM(COALESCE(r.${ident(HISTOGRAMS[name])}[${Prisma.raw(String(index))}], 0))::float8 AS ${ident(`${name}_${index}`)}`,
      );
  return Prisma.join(parts, ", ");
}

const loadAggregates =
  () => Prisma.sql`SUM(l.samples)::float8 AS samples, SUM(l."kvSamples")::float8 AS "kvSamples",
  SUM(l."sumKvUsage")::float8 AS "sumKvUsage", MAX(l."maxKvUsage")::float8 AS "maxKvUsage",
  MAX(l."maxRunning")::float8 AS "maxRunning", MAX(l."maxWaiting")::float8 AS "maxWaiting",
  SUM(l."fullSamples")::float8 AS "fullSamples"`;

function nodeAggregates(customNames: readonly string[]): Prisma.Sql {
  const parts = [
    Prisma.sql`SUM(n.samples)::float8 AS samples`,
    Prisma.sql`SUM(n."cpuSamples")::float8 AS "cpuSamples"`,
    Prisma.sql`SUM(n."sumCpuPercent")::float8 AS "sumCpuPercent"`,
    Prisma.sql`SUM(n."memorySamples")::float8 AS "memorySamples"`,
    Prisma.sql`SUM(n."sumMemoryAvailableMiB")::float8 AS "sumMemoryAvailableMiB"`,
    Prisma.sql`MIN(n."minAcceleratorFreeMiB")::float8 AS "minAcceleratorFreeMiB"`,
    Prisma.sql`MAX(n."maxGpuTemperatureC")::float8 AS "maxGpuTemperatureC"`,
    Prisma.sql`MAX(n."maxGpuUtilizationPercent")::float8 AS "maxGpuUtilizationPercent"`,
  ];
  customNames.forEach((name, index) => {
    parts.push(
      Prisma.sql`SUM((n.custom -> ${name} ->> 'sum')::float8) AS ${ident(`c${index}_sum`)}`,
      Prisma.sql`SUM((n.custom -> ${name} ->> 'samples')::float8) AS ${ident(`c${index}_n`)}`,
    );
  });
  return Prisma.join(parts, ", ");
}

/** Keys filter for the series query of a grouped answer. */
function keysFilter(group: Prisma.Sql, keys: readonly string[] | null): Prisma.Sql {
  return keys === null ? Prisma.sql`TRUE` : Prisma.sql`(${group}) = ANY(${[...keys]}::text[])`;
}

type FamilyPlan = {
  family: MetricFamily;
  /** Totals by group (no time); the weight orders groups. */
  totals: () => Promise<Row[]>;
  /** Series by time and group, for the kept keys (null = all). */
  series: (keys: readonly string[] | null) => Promise<Row[]>;
};

function requestPlan(
  userId: string,
  scope: ResolvedScope,
  window: Window,
  input: MetricsQueryInput,
  histograms: readonly HistogramName[],
): FamilyPlan {
  const where = requestWhere(userId, scope, window, input.includeAgentTests);
  const columns = requestColumns(histograms);
  // Hour and day steps also read the hourly rows compaction moved out of the minute table.
  const withHours = window.stepMs >= STEP_MS["1h"];
  const source = withHours
    ? Prisma.sql`(SELECT ${columns} FROM usage_rollup_minute WHERE ${where} UNION ALL SELECT ${columns} FROM usage_rollup_hour WHERE ${where})`
    : Prisma.sql`(SELECT ${columns} FROM usage_rollup_minute WHERE ${where})`;
  const group = requestGroup(input.groupBy, userId, scope.kind === "pool");
  const aggregates = requestAggregates(histograms);
  return {
    family: "request",
    totals: () =>
      prisma.$queryRaw<Row[]>`SELECT ${group} AS g, ${aggregates} FROM ${source} r
        GROUP BY 1 ORDER BY SUM(r.requests) DESC`,
    series: (keys) =>
      prisma.$queryRaw<
        Row[]
      >`SELECT ${bucketExpr("r", window.stepMs)} AS t, ${group} AS g, ${aggregates}
        FROM ${source} r WHERE ${keysFilter(group, keys)} GROUP BY 1, 2`,
  };
}

function loadPlan(
  userId: string,
  scope: ResolvedScope,
  window: Window,
  groupBy: GroupBy | undefined,
): FamilyPlan | null {
  let filter: Prisma.Sql;
  switch (scope.kind) {
    case "pool":
      if (scope.runtimeIds.length === 0) return null;
      filter = Prisma.sql`l."runtimeId" = ANY(${scope.runtimeIds}::text[])`;
      break;
    case "runtime":
      filter = Prisma.sql`l."runtimeId" = ${scope.id}`;
      break;
    case "version":
      filter = Prisma.sql`l."versionId" = ${scope.id}`;
      break;
    case "node":
      filter = Prisma.sql`l."nodeId" = ${scope.id}`;
      break;
    case "instance":
      filter = Prisma.sql`l."instanceId" = ${scope.id}`;
      break;
  }
  const where = Prisma.sql`l."ownerUserId" = ${userId} AND ${filter}
    AND l."bucketStart" >= ${window.from} AND l."bucketStart" < ${window.to}`;
  const group = loadGroup(groupBy);
  return {
    family: "load",
    totals: () =>
      prisma.$queryRaw<Row[]>`SELECT ${group} AS g, ${loadAggregates()} FROM runtime_load_minute l
        WHERE ${where} GROUP BY 1 ORDER BY SUM(l.samples) DESC`,
    series: (keys) =>
      prisma.$queryRaw<
        Row[]
      >`SELECT ${bucketExpr("l", window.stepMs)} AS t, ${group} AS g, ${loadAggregates()}
        FROM runtime_load_minute l WHERE ${where} AND ${keysFilter(group, keys)} GROUP BY 1, 2`,
  };
}

/**
 * Node gauges are per node: rows come back per node (`n`) so memory and free VRAM add up across
 * nodes, CPU averages by samples and GPU peaks take the maximum.
 */
function nodePlan(
  userId: string,
  scope: ResolvedScope,
  window: Window,
  grouped: boolean,
  customNames: readonly string[],
): FamilyPlan | null {
  let nodes: Prisma.Sql;
  switch (scope.kind) {
    case "node":
      nodes = Prisma.sql`n."nodeId" = ${scope.id}`;
      break;
    case "pool":
      if (scope.runtimeIds.length === 0) return null;
      // Nodes the caller's member runtimes ran on in the range (and their current nodes).
      nodes = Prisma.sql`n."nodeId" IN (SELECT DISTINCT "nodeId" FROM runtime_load_minute
        WHERE "ownerUserId" = ${userId} AND "runtimeId" = ANY(${scope.runtimeIds}::text[])
          AND "bucketStart" >= ${window.from} AND "bucketStart" < ${window.to}
        UNION SELECT "nodeId" FROM runtime WHERE id = ANY(${scope.runtimeIds}::text[]) AND "nodeId" IS NOT NULL)`;
      break;
    case "runtime":
    case "version":
    case "instance": {
      const column = Prisma.raw(
        scope.kind === "runtime"
          ? `"runtimeId"`
          : scope.kind === "version"
            ? `"versionId"`
            : `"instanceId"`,
      );
      nodes = Prisma.sql`(n."nodeId" = ANY(${scope.nodeIds}::text[]) OR n."nodeId" IN (
        SELECT DISTINCT "nodeId" FROM runtime_load_minute WHERE "ownerUserId" = ${userId}
          AND ${column} = ${scope.id}
          AND "bucketStart" >= ${window.from} AND "bucketStart" < ${window.to}))`;
      break;
    }
  }
  const where = Prisma.sql`n."ownerUserId" = ${userId} AND ${nodes}
    AND n."bucketStart" >= ${window.from} AND n."bucketStart" < ${window.to}`;
  const group = grouped ? Prisma.sql`n."nodeId"` : zero();
  const aggregates = nodeAggregates(customNames);
  return {
    family: "node",
    totals: () =>
      prisma.$queryRaw<
        Row[]
      >`SELECT ${group} AS g, n."nodeId" AS n, ${aggregates} FROM node_metrics_minute n
        WHERE ${where} GROUP BY 1, 2 ORDER BY SUM(n.samples) DESC`,
    series: (keys) =>
      prisma.$queryRaw<
        Row[]
      >`SELECT ${bucketExpr("n", window.stepMs)} AS t, ${group} AS g, n."nodeId" AS n, ${aggregates}
        FROM node_metrics_minute n WHERE ${where} AND ${keysFilter(group, keys)} GROUP BY 1, 2, 3`,
  };
}

// ── Values ──

function num(row: Row | undefined, column: string): number {
  const value = row?.[column];
  const parsed = typeof value === "number" ? value : value == null ? 0 : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maybe(row: Row | undefined, column: string): number | null {
  const value = row?.[column];
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const ratio = (top: number, bottom: number) => (bottom > 0 ? top / bottom : null);

function histogramFrom(row: Row | undefined, name: HistogramName): number[] {
  return Array.from({ length: LATENCY_HISTOGRAM_BUCKETS }, (_, index) =>
    num(row, `${name}_${index + 1}`),
  );
}

function requestValue(metric: Metric, row: Row | undefined): number | null {
  const histogram = histogramOf(metric);
  if (histogram) {
    const quantile = metric.endsWith("_p50") ? 0.5 : 0.95;
    return histogramQuantile(histogramFrom(row, histogram), quantile);
  }
  switch (metric) {
    case "requests":
      return num(row, "requests");
    case "errors":
      return num(row, "errors");
    case "rejections":
      return (
        num(row, "rejectedCapacity") +
        num(row, "rejectedContext") +
        num(row, "rejectedSpend") +
        num(row, "rejectedOther")
      );
    case "rejections_capacity":
      return num(row, "rejectedCapacity");
    case "rejections_context":
      return num(row, "rejectedContext");
    case "rejections_spend":
      return num(row, "rejectedSpend");
    case "rejections_other":
      return num(row, "rejectedOther");
    case "decode_tps":
      return ratio(num(row, "generationTokens"), num(row, "generationMs") / 1000);
    case "prefill_tps":
      return ratio(num(row, "prefillTokens"), num(row, "prefillMs") / 1000);
    case "input_tokens":
      return num(row, "inputTokens");
    case "output_tokens":
      return num(row, "outputTokens");
    case "cache_hit_rate":
      return ratio(num(row, "cacheReadTokens"), num(row, "cacheKnownInputTokens"));
    case "cloud_share":
      return ratio(num(row, "cloudRequests"), num(row, "requests"));
    default:
      return null;
  }
}

function loadValue(metric: Metric, row: Row | undefined): number | null {
  if (!row) return null;
  switch (metric) {
    case "kv_usage_avg":
      return ratio(num(row, "sumKvUsage"), num(row, "kvSamples"));
    case "kv_usage_max":
      return maybe(row, "maxKvUsage");
    case "running_max":
      return maybe(row, "maxRunning");
    case "waiting_max":
      return maybe(row, "maxWaiting");
    case "full_ratio":
      return ratio(num(row, "fullSamples"), num(row, "samples"));
    default:
      return null;
  }
}

/** Per-node rows of one bucket (or of the whole range) combined into node metric values. */
function nodeValue(
  metric: Metric,
  rows: readonly Row[],
  customNames: readonly string[],
): number | null {
  if (rows.length === 0) return null;
  const sumOver = (pick: (row: Row) => number | null) => {
    let total: number | null = null;
    for (const row of rows) {
      const value = pick(row);
      if (value !== null) total = (total ?? 0) + value;
    }
    return total;
  };
  const maxOver = (column: string) => {
    let best: number | null = null;
    for (const row of rows) {
      const value = maybe(row, column);
      if (value !== null) best = best === null ? value : Math.max(best, value);
    }
    return best;
  };
  switch (metric) {
    case "cpu_pct":
      return ratio(
        sumOver((row) => num(row, "sumCpuPercent")) ?? 0,
        sumOver((row) => num(row, "cpuSamples")) ?? 0,
      );
    case "memory_available_gb": {
      // Each node's average over the bucket, added up across nodes.
      const total = sumOver((row) =>
        ratio(num(row, "sumMemoryAvailableMiB"), num(row, "memorySamples")),
      );
      return total === null ? null : total / 1024;
    }
    case "accelerator_free_gb": {
      const total = sumOver((row) => maybe(row, "minAcceleratorFreeMiB"));
      return total === null ? null : total / 1024;
    }
    case "gpu_util_pct":
      return maxOver("maxGpuUtilizationPercent");
    case "gpu_temp_c":
      return maxOver("maxGpuTemperatureC");
    default: {
      const index = customNames.indexOf(metric.slice("custom:".length));
      if (index < 0) return null;
      return ratio(
        sumOver((row) => maybe(row, `c${index}_sum`)) ?? 0,
        sumOver((row) => maybe(row, `c${index}_n`)) ?? 0,
      );
    }
  }
}

/** Fewer tokens: integers stay, others keep 3 significant digits (whole numbers past 100). */
export function compactNumber(value: number): number {
  if (Number.isInteger(value)) return value;
  if (Math.abs(value) >= 100) return Math.round(value);
  return Number(value.toPrecision(3));
}

// ── Labels (owner-scoped; a key the caller does not own keeps no label) ──

async function labelsFor(
  userId: string,
  groupBy: GroupBy,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const ids = keys.filter((key) => key !== "");
  const labels = new Map<string, string>();
  if (ids.length === 0 || groupBy === "source") return labels;
  const instanceLabels = async (instanceIds: string[]) => {
    const rows = await prisma.runtimeInstance.findMany({
      where: { id: { in: instanceIds }, userId },
      select: { id: true, Runtime: { select: { slug: true } } },
    });
    return new Map(rows.map((row) => [row.id, `${row.Runtime.slug} ${row.id.slice(-6)}`]));
  };
  const modelLabels = async (modelIds: string[]) => {
    const [local, cloud] = await Promise.all([
      prisma.runtimeModel.findMany({
        where: { id: { in: modelIds }, userId },
        select: { id: true, upstreamModelId: true },
      }),
      prisma.providerModel.findMany({
        where: { id: { in: modelIds }, userId },
        select: { id: true, upstreamModelId: true, displayName: true },
      }),
    ]);
    return new Map([
      ...local.map((row) => [row.id, row.upstreamModelId] as const),
      ...cloud.map((row) => [row.id, row.displayName ?? row.upstreamModelId] as const),
    ]);
  };
  switch (groupBy) {
    case "runtime": {
      const rows = await prisma.runtime.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true, slug: true },
      });
      for (const row of rows) labels.set(row.id, row.slug);
      break;
    }
    case "version": {
      const rows = await prisma.runtimeVersion.findMany({
        where: { id: { in: ids }, Runtime: { userId } },
        select: { id: true, version: true, Runtime: { select: { slug: true } } },
      });
      for (const row of rows) labels.set(row.id, `${row.Runtime.slug} v${row.version}`);
      break;
    }
    case "node": {
      const rows = await prisma.node.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true, slug: true },
      });
      for (const row of rows) labels.set(row.id, row.slug);
      break;
    }
    case "instance":
      return instanceLabels(ids);
    case "model":
      return modelLabels(ids);
    case "member": {
      const parts = ids.map((key) => key.split("/"));
      const [models, instances] = await Promise.all([
        modelLabels(uniq(parts.map(([model]) => model))),
        instanceLabels(uniq(parts.map(([, instance]) => instance))),
      ]);
      for (const [index, [model, instance]] of parts.entries()) {
        const modelLabel = model ? models.get(model) : undefined;
        if (!modelLabel) continue;
        const instanceLabel = instance ? instances.get(instance) : undefined;
        labels.set(
          ids[index] ?? "",
          instanceLabel ? `${modelLabel} @ ${instanceLabel}` : modelLabel,
        );
      }
      break;
    }
  }
  return labels;
}

// ── The query ──

function windowOf(input: MetricsQueryInput, now: Date): Window {
  const stepMs = STEP_MS[input.step];
  const toMs = typeof input.range === "string" ? now.getTime() : Date.parse(input.range.to);
  const fromMs =
    typeof input.range === "string" ? toMs - RANGE_MS[input.range] : Date.parse(input.range.from);
  return { from: new Date(Math.floor(fromMs / stepMs) * stepMs), to: new Date(toMs), stepMs };
}

function bucketIndex(row: Row, window: Window): number | null {
  const t =
    row.t instanceof Date
      ? row.t.getTime()
      : typeof row.t === "string"
        ? Date.parse(row.t)
        : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return Math.round((t - window.from.getTime()) / window.stepMs);
}

export async function runMetricsQuery(
  userId: string,
  input: MetricsQueryInput,
  now: Date = new Date(),
): Promise<MetricsQueryOutput> {
  const scope = await resolveScope(userId, input.scope);
  const metrics = [...new Set(input.metrics)];
  const families = new Map<MetricFamily, Metric[]>();
  for (const metric of metrics) {
    const family = metricFamily(metric);
    families.set(family, [...(families.get(family) ?? []), metric]);
  }
  if (scope.kind === "pool" && scope.shared) {
    // A pool shared with the caller: their own requests to it, nothing of where they ran.
    if (
      families.has("load") ||
      families.has("node") ||
      (input.groupBy && input.groupBy !== "source")
    )
      throw new ORPCError("FORBIDDEN", {
        message:
          "A pool shared with you gives request metrics of your own requests, ungrouped or by source.",
      });
  }
  const window = windowOf(input, now);
  const grouped = input.groupBy !== undefined;
  const histograms = [
    ...new Set(metrics.map(histogramOf).filter((name): name is HistogramName => name !== null)),
  ];
  const customNames = metrics
    .filter((metric) => metric.startsWith("custom:"))
    .map((metric) => metric.slice("custom:".length));

  const plans: FamilyPlan[] = [];
  for (const family of families.keys()) {
    const plan =
      family === "request"
        ? requestPlan(userId, scope, window, input, histograms)
        : family === "load"
          ? loadPlan(userId, scope, window, input.groupBy)
          : nodePlan(userId, scope, window, grouped, customNames);
    if (plan) plans.push(plan);
  }
  // The family of the first metric orders the groups.
  const primary = metricFamily(metrics[0] as Metric);
  plans.sort((a, b) => Number(b.family === primary) - Number(a.family === primary));

  const totalsByFamily = await Promise.all(plans.map((plan) => plan.totals()));

  const points = metricBuckets(window.from.getTime(), window.to.getTime(), window.stepMs);
  const maxGroups = Math.max(
    1,
    Math.min(METRICS_MAX_GROUPS, Math.floor(METRICS_MAX_VALUES / (points * metrics.length))),
  );
  let keys: string[] | null = null;
  let truncated = false;
  if (grouped) {
    // Rows come ordered by weight; node rows repeat a key per node.
    const ordered = [
      ...new Set(totalsByFamily.flatMap((rows) => rows.map((row) => String(row.g ?? "")))),
    ];
    truncated = ordered.length > maxGroups;
    keys = ordered.slice(0, maxGroups);
  }
  const seriesByFamily = await Promise.all(plans.map((plan) => plan.series(keys)));

  const metricValue = (family: MetricFamily, metric: Metric, rows: readonly Row[]) =>
    family === "request"
      ? requestValue(metric, rows[0])
      : family === "load"
        ? loadValue(metric, rows[0])
        : nodeValue(metric, rows, customNames);

  // Totals over every group.
  const totals: Record<string, number> = {};
  plans.forEach((plan, index) => {
    const rows = totalsByFamily[index] ?? [];
    const merged =
      plan.family === "node" ? rows : rows.length === 0 ? [] : [mergeRows(rows, plan.family)];
    for (const metric of families.get(plan.family) ?? []) {
      const value =
        merged.length === 0 && plan.family !== "request"
          ? null
          : metricValue(plan.family, metric, merged);
      if (value !== null) totals[metric] = compactNumber(value);
    }
  });

  // Series: per group, per bucket, per family.
  type Cell = Map<MetricFamily, Row[]>;
  const groups = new Map<string, Map<number, Cell>>();
  plans.forEach((plan, index) => {
    for (const row of seriesByFamily[index] ?? []) {
      const at = bucketIndex(row, window);
      if (at === null || at < 0 || at >= points) continue;
      const key = String(row.g ?? "");
      const buckets = groups.get(key) ?? new Map<number, Cell>();
      groups.set(key, buckets);
      const cell = buckets.get(at) ?? new Map<MetricFamily, Row[]>();
      buckets.set(at, cell);
      cell.set(plan.family, [...(cell.get(plan.family) ?? []), row]);
    }
  });
  const order = keys ?? [...groups.keys()];
  const labels =
    grouped && input.groupBy
      ? await labelsFor(userId, input.groupBy, order)
      : new Map<string, string>();
  const series: MetricsQueryOutput["series"] = [];
  for (const key of order) {
    const buckets = groups.get(key);
    if (!buckets) continue;
    const at = [...buckets.keys()].sort((a, b) => a - b);
    const values: Record<string, Array<number | null>> = {};
    for (const metric of metrics) {
      const family = metricFamily(metric);
      values[metric] = at.map((index) => {
        const rows = buckets.get(index)?.get(family) ?? [];
        if (rows.length === 0 && family !== "request") return null;
        const value = metricValue(family, metric, rows);
        return value === null ? null : compactNumber(value);
      });
    }
    const label = labels.get(key);
    series.push({
      ...(grouped ? { group: label ? { key, label } : { key } } : {}),
      at,
      values,
    });
  }
  return {
    start: window.from.toISOString(),
    series,
    totals,
    ...(truncated ? { truncated: true as const } : {}),
    histogramVersion: "v1",
  };
}

/** Totals of several groups of one family (load: sums and maxima; request: sums). */
function mergeRows(rows: readonly Row[], family: MetricFamily): Row {
  const merged: Row = {};
  const maxColumns = new Set(["maxKvUsage", "maxRunning", "maxWaiting"]);
  for (const row of rows)
    for (const column of Object.keys(row)) {
      if (column === "g" || column === "t" || column === "n") continue;
      const next = maybe(row, column);
      if (next === null) continue;
      const current = maybe(merged, column);
      merged[column] =
        current === null
          ? next
          : family === "load" && maxColumns.has(column)
            ? Math.max(current, next)
            : current + next;
    }
  return merged;
}
