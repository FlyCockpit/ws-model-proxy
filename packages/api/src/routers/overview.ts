/**
 * Owner-scoped dashboard overview.
 *
 * Rollup rows carry two users (see usage-rollup.ts): `ownerUserId`, the
 * RESOURCE owner (pool owner, else execution-target owner, else the requester
 * when nothing resolved), and `requesterUserId`, who sent the request.
 *
 * Scope:
 *  - owned traffic ("traffic served by what you own"): rows whose
 *    `ownerUserId` is the session user, from ANY requester (owner, token, pool
 *    grantee, or a since-deleted requester merged into the '' sentinel);
 *  - shared-pool usage ("your traffic on pools shared with you"): rows whose
 *    `requesterUserId` is the session user on a pool they do NOT own, reduced
 *    to per-pool totals. Member/target identities of the owner's pool are not
 *    exposed, and other requesters' traffic on that pool never is.
 *
 * Chat-test and MCP diagnostic traffic are excluded unless
 * `includeTestTraffic` is set; TRANSFORMER hops (internal sub-requests of a
 * pool request) are never counted. Reads only prompt-free aggregates.
 */

import { ORPCError } from "@orpc/server";
import { cliDeviceDisplayName } from "@ws-model-proxy/config/cli-device-name";
import { OVERVIEW_RANGES } from "@ws-model-proxy/config/usage-metrics";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  type Accumulator,
  type AggregateRow,
  accumulateRows,
  type HistogramRow,
  type OverviewStats,
  type OverviewWindow,
  overviewWindow,
  poolSeries,
  type SeriesRow,
  statsFromAccumulator,
  sumAccumulators,
} from "../lib/overview-metrics";

const CLI_HEARTBEAT_STALE_AFTER_MS = 60_000;
const HEALTH_LIST_LIMIT = 20;

const metricsInput = z.object({
  range: z.enum(OVERVIEW_RANGES).default("24h"),
  poolId: z.string().min(1).max(200).optional(),
  includeTestTraffic: z.boolean().default(false),
});

type RelaySource = "API_TOKEN" | "CHAT_TEST" | "MCP" | "TRANSFORMER";

function includedSources(includeTestTraffic: boolean): RelaySource[] {
  return includeTestTraffic ? ["API_TOKEN", "CHAT_TEST", "MCP"] : ["API_TOKEN"];
}

const poolSelect = {
  id: true,
  name: true,
  slug: true,
  PoolMembers: {
    orderBy: [{ tier: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      tier: true,
      healthStatus: true,
      routingStatus: true,
      executionTargetId: true,
      ExecutionTarget: {
        select: {
          id: true,
          kind: true,
          DiscoveredModel: {
            select: {
              upstreamModelId: true,
              Endpoint: {
                select: {
                  label: true,
                  CliDevice: { select: { name: true, reportedHostname: true, slug: true } },
                },
              },
            },
          },
          ProviderModel: {
            select: {
              displayName: true,
              upstreamModelId: true,
              ProviderAccount: { select: { label: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ModelPoolSelect;

type ExecutionTargetLabelRow = {
  kind: "DISCOVERED_MODEL" | "PROVIDER_MODEL";
  DiscoveredModel: {
    upstreamModelId: string;
    Endpoint: {
      label: string;
      CliDevice: { name: string | null; reportedHostname: string | null; slug: string };
    };
  } | null;
  ProviderModel: {
    displayName: string | null;
    upstreamModelId: string;
    ProviderAccount: { label: string };
  } | null;
};

function targetLabels(target: ExecutionTargetLabelRow | null | undefined) {
  if (target?.DiscoveredModel) {
    const model = target.DiscoveredModel;
    return {
      kind: "LOCAL" as const,
      model: model.upstreamModelId,
      location: `${model.Endpoint.label} · ${cliDeviceDisplayName(model.Endpoint.CliDevice)}`,
    };
  }
  if (target?.ProviderModel) {
    const model = target.ProviderModel;
    return {
      kind: "PROVIDER" as const,
      model: model.displayName ?? model.upstreamModelId,
      location: model.ProviderAccount.label,
    };
  }
  return { kind: "UNKNOWN" as const, model: null, location: null };
}

function ownedScopeSql(userId: string, poolId?: string): Prisma.Sql {
  return poolId
    ? Prisma.sql`r."ownerUserId" = ${userId} AND r."poolId" = ${poolId}`
    : Prisma.sql`r."ownerUserId" = ${userId}`;
}

function sharedScopeSql(userId: string): Prisma.Sql {
  return Prisma.sql`r."requesterUserId" = ${userId}
    AND r."ownerUserId" <> ${userId}
    AND r."poolId" <> ''`;
}

async function queryRollups({
  window,
  sources,
  scope,
  perMember,
  withSeries,
}: {
  window: OverviewWindow;
  sources: RelaySource[];
  scope: Prisma.Sql;
  /** false: collapse to one row per pool (shared pools hide the owner's members). */
  perMember: boolean;
  withSeries: boolean;
}) {
  const member = perMember ? Prisma.sql`r."poolMemberId"` : Prisma.sql`''::text`;
  const target = perMember ? Prisma.sql`r."executionTargetId"` : Prisma.sql`''::text`;
  const base = Prisma.sql`
      r."bucketStart" >= ${window.previousStart}
      AND r."bucketStart" < ${window.end}
      AND r.source::text = ANY(${sources}::text[])
      AND ${scope}`;
  return Promise.all([
    prisma.$queryRaw<AggregateRow[]>`
        SELECT (r."bucketStart" >= ${window.start}) AS current,
               r."poolId", ${member} AS "poolMemberId", ${target} AS "executionTargetId",
               SUM(r.requests)::bigint AS requests,
               SUM(r.successes)::bigint AS successes,
               SUM(r.errors)::bigint AS errors,
               SUM(r.cancels)::bigint AS cancels,
               SUM(r.retries)::bigint AS retries,
               SUM(r."usageKnownRequests")::bigint AS "usageKnownRequests",
               SUM(r."inputTokens")::bigint AS "inputTokens",
               SUM(r."outputTokens")::bigint AS "outputTokens",
               SUM(r."cacheReadTokens")::bigint AS "cacheReadTokens",
               SUM(r."cacheWriteTokens")::bigint AS "cacheWriteTokens",
               SUM(r."cacheKnownRequests")::bigint AS "cacheKnownRequests",
               SUM(r."cacheKnownInputTokens")::bigint AS "cacheKnownInputTokens",
               SUM(r."durationCount")::bigint AS "durationCount",
               SUM(r."durationSumMs")::bigint AS "durationSumMs",
               SUM(r."ttftCount")::bigint AS "ttftCount",
               SUM(r."ttftSumMs")::bigint AS "ttftSumMs"
          FROM usage_rollup_minute r
         WHERE ${base}
         GROUP BY 1, 2, 3, 4`,
    prisma.$queryRaw<HistogramRow[]>`
        SELECT (r."bucketStart" >= ${window.start}) AS current,
               r."poolId", ${member} AS "poolMemberId", ${target} AS "executionTargetId",
               'latency' AS kind, h.i AS idx, SUM(h.v)::bigint AS count
          FROM usage_rollup_minute r
         CROSS JOIN LATERAL unnest(r."latencyHistogram") WITH ORDINALITY AS h(v, i)
         WHERE ${base} AND h.v > 0
         GROUP BY 1, 2, 3, 4, 6
        UNION ALL
        SELECT (r."bucketStart" >= ${window.start}) AS current,
               r."poolId", ${member} AS "poolMemberId", ${target} AS "executionTargetId",
               'ttft' AS kind, h.i AS idx, SUM(h.v)::bigint AS count
          FROM usage_rollup_minute r
         CROSS JOIN LATERAL unnest(r."ttftHistogram") WITH ORDINALITY AS h(v, i)
         WHERE ${base} AND h.v > 0
         GROUP BY 1, 2, 3, 4, 6`,
    withSeries
      ? prisma.$queryRaw<SeriesRow[]>`
        SELECT r."poolId", ${member} AS "poolMemberId",
               FLOOR((EXTRACT(EPOCH FROM r."bucketStart") * 1000 - ${window.start.getTime()})
                 / ${window.bucketMs})::int AS bucket,
               SUM(r.requests)::bigint AS requests,
               SUM(r.errors)::bigint AS errors
          FROM usage_rollup_minute r
         WHERE ${base} AND r."bucketStart" >= ${window.start} AND r."poolId" <> ''
         GROUP BY 1, 2, 3`
      : Promise.resolve([] as SeriesRow[]),
  ]);
}

export type OverviewMemberRow = {
  poolMemberId: string;
  /** Stable series key: the member id, or "" for requests never routed. */
  seriesKey: string;
  kind: "LOCAL" | "PROVIDER" | "UNKNOWN";
  model: string | null;
  location: string | null;
  tier: "PRIMARY" | "PUBLIC_OVERFLOW" | null;
  healthStatus: "UNKNOWN" | "HEALTHY" | "HALF_OPEN" | "DEGRADED" | "UNHEALTHY" | null;
  routingStatus: "ACTIVE" | "DRAINING" | "DISABLED" | null;
  /** False when rollups reference a member that has since been removed. */
  present: boolean;
  /** Share of the pool's requests in the current period (0..1). */
  share: number | null;
  stats: OverviewStats;
};

export const overviewRouter = {
  metrics: protectedProcedure.input(metricsInput).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    const now = new Date();
    const window = overviewWindow(input.range, now);
    const sources = includedSources(input.includeTestTraffic);

    const [pools, targets] = await Promise.all([
      prisma.modelPool.findMany({
        where: { userId, ...(input.poolId ? { id: input.poolId } : {}) },
        orderBy: { createdAt: "asc" },
        select: poolSelect,
      }),
      input.poolId
        ? Promise.resolve([])
        : prisma.executionTarget.findMany({
            where: { userId },
            select: {
              id: true,
              kind: true,
              DiscoveredModel: poolSelect.PoolMembers.select.ExecutionTarget.select.DiscoveredModel,
              ProviderModel: poolSelect.PoolMembers.select.ExecutionTarget.select.ProviderModel,
            },
          }),
    ]);
    if (input.poolId && pools.length === 0) {
      throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
    }
    const [[aggregates, histograms, series], [sharedAggregates, sharedHistograms]] =
      await Promise.all([
        queryRollups({
          window,
          sources,
          scope: ownedScopeSql(userId, input.poolId),
          perMember: true,
          withSeries: true,
        }),
        input.poolId
          ? Promise.resolve([[], [], []] as [AggregateRow[], HistogramRow[], SeriesRow[]])
          : queryRollups({
              window,
              sources,
              scope: sharedScopeSql(userId),
              perMember: false,
              withSeries: false,
            }),
      ]);

    const keyed = accumulateRows(aggregates, histograms);
    const statsFor = (map: Map<string, Accumulator>, keys: string[]) =>
      sumAccumulators(keys.map((key) => map.get(key)).filter((value) => value !== undefined));
    const allKeys = [...keyed.identities.keys()];

    const poolCards = pools.map((pool) => {
      const poolKeys = allKeys.filter((key) => keyed.identities.get(key)?.poolId === pool.id);
      const current = statsFor(keyed.current, poolKeys);
      const previous = statsFor(keyed.previous, poolKeys);
      const memberIds = new Set(pool.PoolMembers.map((member) => member.id));
      const byMember = new Map<string, string[]>();
      for (const key of poolKeys) {
        const memberId = keyed.identities.get(key)?.poolMemberId ?? "";
        byMember.set(memberId, [...(byMember.get(memberId) ?? []), key]);
      }
      const members: OverviewMemberRow[] = pool.PoolMembers.map((member) => {
        const labels = targetLabels(member.ExecutionTarget);
        const stats = statsFromAccumulator(statsFor(keyed.current, byMember.get(member.id) ?? []));
        return {
          poolMemberId: member.id,
          seriesKey: member.id,
          ...labels,
          tier: member.tier,
          healthStatus: member.healthStatus,
          routingStatus: member.routingStatus,
          present: true,
          share: current.requests > 0 ? stats.requests / current.requests : null,
          stats,
        };
      });
      // Traffic attributed to members that were removed, or to requests that
      // failed before any member was selected ("" key).
      for (const [memberId, keys] of byMember) {
        if (memberIds.has(memberId)) continue;
        const stats = statsFromAccumulator(statsFor(keyed.current, keys));
        if (stats.requests === 0) continue;
        members.push({
          poolMemberId: memberId,
          seriesKey: memberId,
          kind: "UNKNOWN",
          model: null,
          location: null,
          tier: null,
          healthStatus: null,
          routingStatus: null,
          present: false,
          share: current.requests > 0 ? stats.requests / current.requests : null,
          stats,
        });
      }
      // Configured order (tier, then creation), removed/unrouted last: stable
      // across refreshes so each member keeps its chart colour and table row.
      const seriesKeys = members.map((member) => member.seriesKey);
      return {
        poolId: pool.id,
        name: pool.name,
        slug: pool.slug,
        current: statsFromAccumulator(current),
        previous: statsFromAccumulator(previous),
        members,
        seriesKeys,
        series: poolSeries(
          window,
          series.filter((row) => row.poolId === pool.id),
          seriesKeys,
        ),
      };
    });
    poolCards.sort((left, right) => right.current.requests - left.current.requests);

    const targetById = new Map(targets.map((target) => [target.id, target]));
    const directByTarget = new Map<string, string[]>();
    for (const key of allKeys) {
      const identity = keyed.identities.get(key);
      if (identity?.poolId !== "") continue;
      directByTarget.set(identity.executionTargetId, [
        ...(directByTarget.get(identity.executionTargetId) ?? []),
        key,
      ]);
    }
    const direct = [...directByTarget.entries()]
      .map(([executionTargetId, keys]) => ({
        executionTargetId,
        ...targetLabels(targetById.get(executionTargetId)),
        current: statsFromAccumulator(statsFor(keyed.current, keys)),
        previous: statsFromAccumulator(statsFor(keyed.previous, keys)),
      }))
      .filter((row) => row.current.requests > 0 || row.previous.requests > 0)
      .sort((left, right) => right.current.requests - left.current.requests);

    const scopedKeys = input.poolId
      ? allKeys.filter((key) => keyed.identities.get(key)?.poolId === input.poolId)
      : allKeys;

    // Your own usage of pools other users share with you (per-pool totals).
    const shared = accumulateRows(sharedAggregates, sharedHistograms);
    const sharedPoolIds = [
      ...new Set([...shared.identities.values()].map((identity) => identity.poolId)),
    ];
    const grants =
      sharedPoolIds.length === 0
        ? []
        : await prisma.poolGrant.findMany({
            where: { granteeUserId: userId, poolId: { in: sharedPoolIds } },
            select: {
              poolId: true,
              ModelPool: { select: { name: true, slug: true } },
              Owner: { select: { slug: true } },
            },
          });
    const grantByPool = new Map(grants.map((grant) => [grant.poolId, grant]));
    const sharedPools = sharedPoolIds
      .map((poolId) => {
        const keys = [...shared.identities.keys()].filter(
          (key) => shared.identities.get(key)?.poolId === poolId,
        );
        const grant = grantByPool.get(poolId);
        return {
          poolId,
          // Labelled only while the pool is still shared with you.
          available: grant !== undefined,
          name: grant?.ModelPool.name ?? null,
          slug: grant?.ModelPool.slug ?? null,
          ownerSlug: grant?.Owner.slug ?? null,
          current: statsFromAccumulator(statsFor(shared.current, keys)),
          previous: statsFromAccumulator(statsFor(shared.previous, keys)),
        };
      })
      .filter((row) => row.current.requests > 0 || row.previous.requests > 0)
      .sort((left, right) => right.current.requests - left.current.requests);
    return {
      range: window.range,
      bucketMs: window.bucketMs,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      previousStart: window.previousStart.toISOString(),
      generatedAt: now.toISOString(),
      includeTestTraffic: input.includeTestTraffic,
      totals: {
        current: statsFromAccumulator(statsFor(keyed.current, scopedKeys)),
        previous: statsFromAccumulator(statsFor(keyed.previous, scopedKeys)),
      },
      pools: poolCards,
      direct,
      sharedPools,
      setup: {
        hasPools: pools.length > 0,
        hasDirectTargets: targets.length > 0,
      },
    };
  }),

  health: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const now = new Date();
    const [clis, endpoints, members, tokenCount] = await Promise.all([
      prisma.cliDevice.findMany({
        where: { userId, status: { not: "REVOKED" } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          slug: true,
          name: true,
          reportedHostname: true,
          status: true,
          lastHeartbeatAt: true,
        },
      }),
      prisma.endpoint.findMany({
        where: { userId, published: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, label: true, status: true, cliDeviceId: true },
      }),
      prisma.poolMember.findMany({
        where: { ModelPool: { userId } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          poolId: true,
          healthStatus: true,
          routingStatus: true,
          ModelPool: { select: { name: true } },
          ExecutionTarget: poolSelect.PoolMembers.select.ExecutionTarget,
        },
      }),
      prisma.modelApiToken.count({ where: { userId } }),
    ]);
    const online = (cli: (typeof clis)[number]) =>
      cli.status === "CONNECTED" &&
      cli.lastHeartbeatAt !== null &&
      cli.lastHeartbeatAt.getTime() + CLI_HEARTBEAT_STALE_AFTER_MS > now.getTime();
    const offlineClis = clis.filter((cli) => !online(cli));
    const unhealthyEndpoints = endpoints.filter((endpoint) => endpoint.status !== "ONLINE");
    const memberRow = (member: (typeof members)[number]) => ({
      id: member.id,
      poolId: member.poolId,
      poolName: member.ModelPool.name,
      healthStatus: member.healthStatus,
      ...targetLabels(member.ExecutionTarget),
    });
    const activeMembers = members.filter((member) => member.routingStatus !== "DISABLED");
    const degraded = activeMembers.filter((member) => member.healthStatus === "DEGRADED");
    const circuitOpen = activeMembers.filter(
      (member) => member.healthStatus === "UNHEALTHY" || member.healthStatus === "HALF_OPEN",
    );
    return {
      generatedAt: now.toISOString(),
      clis: {
        total: clis.length,
        online: clis.length - offlineClis.length,
        offline: offlineClis.slice(0, HEALTH_LIST_LIMIT).map((cli) => ({
          id: cli.id,
          displayName: cliDeviceDisplayName(cli),
          status: cli.status,
        })),
      },
      endpoints: {
        total: endpoints.length,
        healthy: endpoints.length - unhealthyEndpoints.length,
        unhealthy: unhealthyEndpoints.slice(0, HEALTH_LIST_LIMIT).map((endpoint) => ({
          id: endpoint.id,
          label: endpoint.label,
          status: endpoint.status,
          cliDeviceId: endpoint.cliDeviceId,
        })),
      },
      poolMembers: {
        total: activeMembers.length,
        degradedCount: degraded.length,
        circuitOpenCount: circuitOpen.length,
        degraded: degraded.slice(0, HEALTH_LIST_LIMIT).map(memberRow),
        circuitOpen: circuitOpen.slice(0, HEALTH_LIST_LIMIT).map(memberRow),
      },
      modelApiTokens: tokenCount,
    };
  }),
};
