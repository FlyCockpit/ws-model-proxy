/**
 * `activity.overview.summary`: the Overview page. KPIs over the caller's traffic (requests to
 * their own pools and runtimes, from anyone, plus their own requests to pools shared with them;
 * agent tests excluded), the nodes strip, the caller's pool cards with a request sparkline, and
 * the getting-started state. Reads the minute rollups (24h and 7d are always minute rows).
 */
import { histogramQuantile, LATENCY_HISTOGRAM_BUCKETS } from "@ws-model-proxy/config/usage-metrics";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { effectiveTrust } from "../nodes/trust";
import { callableIdOf } from "./access-views";
import { compactNumber } from "./metrics-query";
import { memberLatencyKey } from "./pool-views";
import { realTraffic } from "./test-traffic";

export type OverviewRange = "24h" | "7d";

const HOUR_MS = 3_600_000;
/** Range and sparkline bucket: 24 hourly points, or 28 six-hour points. */
const RANGES: Record<OverviewRange, { rangeMs: number; bucketMs: number }> = {
  "24h": { rangeMs: 24 * HOUR_MS, bucketMs: HOUR_MS },
  "7d": { rangeMs: 7 * 24 * HOUR_MS, bucketMs: 6 * HOUR_MS },
};
const MAX_POOLS = 50;
const MAX_NODES = 50;

type KpiRow = Record<string, unknown>;

function num(row: KpiRow | undefined, column: string): number {
  const value = row?.[column];
  const parsed = typeof value === "number" ? value : value == null ? 0 : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** One summed column per histogram bucket; `filter` limits the rows each sum adds. */
function histogramColumns(column: string, prefix: string, filter = Prisma.empty): Prisma.Sql[] {
  return Array.from(
    { length: LATENCY_HISTOGRAM_BUCKETS },
    (_, index) =>
      Prisma.sql`SUM(COALESCE(${Prisma.raw(`"${column}"`)}[${Prisma.raw(String(index + 1))}], 0)) ${filter}::float8 AS ${Prisma.raw(`"${prefix}${index + 1}"`)}`,
  );
}

function p95(row: KpiRow | undefined, prefix: string): number | null {
  const histogram = Array.from({ length: LATENCY_HISTOGRAM_BUCKETS }, (_, index) =>
    num(row, `${prefix}${index + 1}`),
  );
  const value = histogramQuantile(histogram, 0.95);
  return value === null ? null : compactNumber(value);
}

/** The window of a range: a fixed number of buckets, the last one the current (partial) one. */
function windowOf(range: OverviewRange, now: Date) {
  const { rangeMs, bucketMs } = RANGES[range];
  const end = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
  return { from: new Date(end - rangeMs), bucketMs, buckets: rangeMs / bucketMs };
}

export type PoolTraffic = { requests: number; errors: number; sparkline: number[] };

/**
 * Requests and errors to the owner's pools over a range, with a request sparkline (agent tests
 * excluded). Recent traffic lives in the minute rollup (hourly rows only hold what compaction
 * moved out after 30 days).
 */
export async function poolTraffic(
  ownerId: string,
  poolIds: readonly string[],
  range: OverviewRange,
  now = new Date(),
): Promise<Map<string, PoolTraffic>> {
  const { from, bucketMs, buckets } = windowOf(range, now);
  const byPool = new Map(
    poolIds.map((id) => [
      id,
      { requests: 0, errors: 0, sparkline: new Array<number>(buckets).fill(0) },
    ]),
  );
  if (poolIds.length === 0) return byPool;
  const rows = await prisma.$queryRaw<KpiRow[]>`SELECT "poolId" AS pool,
      date_bin(make_interval(secs => ${bucketMs / 1000}::float8), "bucketStart", TIMESTAMP '1970-01-01') AS t,
      SUM(requests)::float8 AS requests, SUM(errors)::float8 AS errors
    FROM usage_rollup_minute
    WHERE "ownerUserId" = ${ownerId} AND "poolId" = ANY(${[...poolIds]}::text[])
      AND "bucketStart" >= ${from} AND ${realTraffic()}
    GROUP BY 1, 2`;
  for (const row of rows) {
    const entry = byPool.get(String(row.pool));
    const t = row.t instanceof Date ? row.t.getTime() : Date.parse(String(row.t));
    if (!entry || !Number.isFinite(t)) continue;
    const index = Math.round((t - from.getTime()) / bucketMs);
    const requests = num(row, "requests");
    entry.requests += requests;
    entry.errors += num(row, "errors");
    if (index >= 0 && index < buckets)
      entry.sparkline[index] = (entry.sparkline[index] ?? 0) + requests;
  }
  return byPool;
}

/** The window a pool member's p95 latency covers. */
const MEMBER_LATENCY_WINDOW_MS = 15 * 60_000;
/** The window a pool member's traffic share covers (the length of the pool page's stats row's). */
const MEMBER_SHARE_WINDOW_MS = RANGES["24h"].rangeMs;

/** Recent traffic of the members of the owner's pools, keyed by `memberLatencyKey`. */
export type MemberRecentTraffic = {
  /** p95 latency (ms) over the last 15 minutes. */
  p95: Map<string, number>;
  /** Requests over the last 24 hours. */
  requests: Map<string, number>;
  /**
   * Each pool's requests over the last 24 hours that a member served (members since removed
   * included; requests refused before reaching one left out), so the shares add up to 1.
   */
  poolRequests: Map<string, number>;
};

/**
 * Each member of the owner's pools: its p95 latency over the last 15 minutes and its requests
 * over the last 24 hours, of real traffic (minute rollups, one bounded query; agent tests
 * excluded).
 */
export async function memberRecentTraffic(
  ownerId: string,
  poolIds: readonly string[],
  now = new Date(),
): Promise<MemberRecentTraffic> {
  const traffic: MemberRecentTraffic = {
    p95: new Map(),
    requests: new Map(),
    poolRequests: new Map(),
  };
  if (poolIds.length === 0) return traffic;
  const latencyFrom = new Date(now.getTime() - MEMBER_LATENCY_WINDOW_MS);
  const shareFrom = new Date(now.getTime() - MEMBER_SHARE_WINDOW_MS);
  // Pool traffic records the serving version (and instance), not the runtime model: the
  // version names the runtime.
  const rows = await prisma.$queryRaw<KpiRow[]>`SELECT "poolId" AS pool,
      COALESCE(NULLIF("runtimeId", ''),
        (SELECT v."runtimeId" FROM runtime_version v WHERE v.id = "versionId"), '') AS runtime,
      "providerModelId" AS provider_model,
      SUM(requests)::float8 AS requests,
      ${Prisma.join(
        histogramColumns(
          "latencyHistogram",
          "l",
          Prisma.sql`FILTER (WHERE "bucketStart" >= ${latencyFrom})`,
        ),
        ", ",
      )}
    FROM usage_rollup_minute
    WHERE "ownerUserId" = ${ownerId} AND "poolId" = ANY(${[...poolIds]}::text[])
      AND "bucketStart" >= ${shareFrom} AND "bucketStart" <= ${now} AND ${realTraffic()}
    GROUP BY 1, 2, 3`;
  for (const row of rows) {
    const pool = String(row.pool);
    const key = memberLatencyKey(pool, {
      runtimeId: row.runtime ? String(row.runtime) : null,
      providerModelId: row.provider_model ? String(row.provider_model) : null,
    });
    const requests = num(row, "requests");
    if (row.runtime || row.provider_model) {
      traffic.requests.set(key, (traffic.requests.get(key) ?? 0) + requests);
      traffic.poolRequests.set(pool, (traffic.poolRequests.get(pool) ?? 0) + requests);
    }
    const value = p95(row, "l");
    if (value !== null) traffic.p95.set(key, value);
  }
  return traffic;
}

export async function overviewSummary(userId: string, range: OverviewRange, now = new Date()) {
  const { from } = windowOf(range, now);

  const [user, nodes, pools, counts, kpiRows] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { slug: true, onboardingDoneAt: true },
    }),
    prisma.node.findMany({
      where: { userId },
      orderBy: { slug: "asc" },
      take: MAX_NODES,
      select: {
        id: true,
        slug: true,
        connection: true,
        trust: true,
        trustLowerRequestedAt: true,
        trustChangedAt: true,
      },
    }),
    prisma.pool.findMany({
      where: { userId },
      orderBy: { slug: "asc" },
      take: MAX_POOLS,
      select: { id: true, slug: true },
    }),
    Promise.all([
      prisma.node.count({ where: { userId } }),
      prisma.runtime.count({ where: { userId } }),
      prisma.pool.count({ where: { userId } }),
      prisma.mcpGrant.count({ where: { userId, revokedAt: null } }),
      prisma.apiKey.count({
        where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      }),
      prisma.node.count({ where: { userId, connection: "ONLINE" } }),
    ]),
    prisma.$queryRaw<KpiRow[]>`SELECT
        SUM(requests)::float8 AS requests, SUM(errors)::float8 AS errors,
        SUM("cloudRequests")::float8 AS "cloudRequests",
        ${Prisma.join(
          [
            ...histogramColumns("latencyHistogram", "l"),
            ...histogramColumns("ttftHistogram", "t"),
            ...histogramColumns("queueWaitHistogram", "q"),
          ],
          ", ",
        )}
      FROM usage_rollup_minute
      WHERE ("ownerUserId" = ${userId} OR "requesterUserId" = ${userId})
        AND "bucketStart" >= ${from} AND ${realTraffic()}`,
  ]);

  const byPool = await poolTraffic(
    userId,
    pools.map((pool) => pool.id),
    range,
    now,
  );

  const kpi = kpiRows[0];
  const requests = num(kpi, "requests");
  const [nodeCount, runtimeCount, poolCount, agentCount, apiKeyCount, onlineCount] = counts;
  const steps = {
    node: nodeCount > 0,
    runtime: runtimeCount > 0,
    pool: poolCount > 0,
    agent: agentCount > 0,
    apiKey: apiKeyCount > 0,
  };
  return {
    kpis: {
      requests,
      errors: num(kpi, "errors"),
      p95LatencyMs: p95(kpi, "l"),
      p95TtftMs: p95(kpi, "t"),
      p95QueueWaitMs: p95(kpi, "q"),
      cloudShare: requests > 0 ? compactNumber(num(kpi, "cloudRequests") / requests) : null,
    },
    nodes: nodes.map((node) => ({
      id: node.id,
      slug: node.slug,
      online: node.connection === "ONLINE",
      trust: effectiveTrust(node),
    })),
    nodesTotal: nodeCount,
    nodesOnline: onlineCount,
    pools: pools.map((pool) => {
      const entry = byPool.get(pool.id);
      return {
        id: pool.id,
        callableId: callableIdOf(user?.slug ?? "", pool.slug),
        requests: entry?.requests ?? 0,
        errors: entry?.errors ?? 0,
        sparkline: entry?.sparkline ?? [],
      };
    }),
    onboarding: {
      done: user?.onboardingDoneAt != null || Object.values(steps).every(Boolean),
      steps,
    },
  };
}
