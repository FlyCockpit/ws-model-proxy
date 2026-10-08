/**
 * Activity (lane D): the request log, the command log, what waits for a person, and metrics over
 * the rollup tables (`metrics.query`, lib/metrics-query.ts).
 *
 * The request log shows requests the caller made and requests to the caller's own pools and
 * runtimes (`resourceOwnerUserId`), prompt-free. Only the caller's own finished requests can be
 * deleted.
 */
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { deleteTerminalRelayRequestsWithoutWaiting } from "@ws-model-proxy/db/capacity-lock-order";
import type { z } from "zod";
import { contractProcedure } from "../contract-procedure";
import { activityContract as c, type requestRowSchema } from "../contracts/activity";
import { callableIdOf } from "../lib/access-views";
import { loadAgentNames } from "../lib/agent-names";
import { programOfSubject } from "../lib/command-audit";
import { runMetricsQuery } from "../lib/metrics-query";
import { overviewSummary } from "../lib/overview-summary";

type RequestRow = z.infer<typeof requestRowSchema>;

/** Opaque page cursor: the last row's creation time and id (the index order). */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      const createdAt = new Date(parsed[0]);
      if (!Number.isNaN(createdAt.getTime())) return { createdAt, id: parsed[1] };
    }
  } catch {
    // Fall through to the error below.
  }
  throw new ORPCError("BAD_REQUEST", { message: "Invalid cursor." });
}

function afterCursor(cursor: { createdAt: Date; id: string } | null) {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

const ROUTES = new Set(["local", "cloud", "own_key"]);

const requestSelect = {
  id: true,
  userId: true,
  createdAt: true,
  source: true,
  status: true,
  poolId: true,
  external: true,
  operation: true,
  route: true,
  selectedInstanceId: true,
  selectedVersionId: true,
  selectedNodeId: true,
  selectedProviderModelId: true,
  queueWaitMs: true,
  startedAt: true,
  firstClientByteAt: true,
  durationMs: true,
  promptTokens: true,
  completionTokens: true,
  cacheReadTokens: true,
  usageEstimated: true,
  compat: true,
  rejection: true,
  errorClass: true,
  upstreamErrorExcerpt: true,
  httpStatusCode: true,
  attemptCount: true,
  resourceOwnerUserId: true,
} satisfies Prisma.RelayRequestSelect;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 32)
    : [];
}

/** The stored compat trace (names only), tolerant of anything malformed. */
function compatOf(value: Prisma.JsonValue): RequestRow["compat"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    dropped: stringList(value.dropped),
    rewrites: stringList(value.rewrites),
    headers: stringList(value.headers),
    retried: value.retried === true,
  };
}

const requests = {
  list: contractProcedure(c.requests.list).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const cursor = decodeCursor(input.cursor);
    const versionIds = input.runtimeId
      ? (
          await prisma.runtimeVersion.findMany({
            // The caller's own runtime only (the filter below matches only their resources).
            where: { runtimeId: input.runtimeId, Runtime: { userId } },
            select: { id: true },
            take: 10_000,
          })
        ).map((version) => version.id)
      : null;
    // Filters on where a request ran (runtime, version, node) only ever match requests to the
    // caller's own resources, so they cannot probe another owner's ids.
    const placementFilter =
      input.runtimeId !== undefined || input.versionId !== undefined || input.nodeId !== undefined;
    const where: Prisma.RelayRequestWhereInput = {
      AND: [
        placementFilter
          ? { resourceOwnerUserId: userId }
          : { OR: [{ userId }, { resourceOwnerUserId: userId }] },
        afterCursor(cursor),
        input.versionId ? { selectedVersionId: input.versionId } : {},
        versionIds ? { selectedVersionId: { in: versionIds } } : {},
        {
          ...(input.poolId ? { poolId: input.poolId } : {}),
          ...(input.nodeId ? { selectedNodeId: input.nodeId } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.since ? { createdAt: { gte: new Date(input.since) } } : {}),
        },
      ],
    };
    const rows = await prisma.relayRequest.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: requestSelect,
    });
    const page = rows.slice(0, input.limit);
    const poolIds = [...new Set(page.flatMap((row) => (row.poolId ? [row.poolId] : [])))];
    const pools = poolIds.length
      ? await prisma.pool.findMany({
          where: { id: { in: poolIds } },
          select: { id: true, slug: true, User: { select: { slug: true } } },
        })
      : [];
    const callable = new Map(
      pools.map((pool) => [pool.id, callableIdOf(pool.User.slug, pool.slug)]),
    );
    const items: RequestRow[] = page.map((row) => {
      // Requests to someone else's pool: where it ran is that owner's business.
      const own = row.resourceOwnerUserId === userId || row.resourceOwnerUserId === null;
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        source: row.source,
        status: row.status,
        poolId: row.poolId,
        callableId: row.poolId
          ? `${callable.get(row.poolId) ?? row.poolId}${row.external ? ":external" : ""}`
          : null,
        external: row.external,
        operation: row.operation,
        route:
          own && row.route && ROUTES.has(row.route) ? (row.route as RequestRow["route"]) : null,
        instanceId: own ? row.selectedInstanceId : null,
        versionId: own ? row.selectedVersionId : null,
        nodeId: own ? row.selectedNodeId : null,
        providerModelId: own ? row.selectedProviderModelId : null,
        queueWaitMs: row.queueWaitMs,
        ttftMs: row.firstClientByteAt
          ? Math.max(0, row.firstClientByteAt.getTime() - row.startedAt.getTime())
          : null,
        durationMs: row.durationMs,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        cacheReadTokens: row.cacheReadTokens,
        usageEstimated: row.usageEstimated,
        compat: own ? compatOf(row.compat) : null,
        rejection: row.rejection,
        errorClass: row.errorClass,
        // The runtime's words about someone else's request stay with that requester.
        upstreamError: own && row.userId === userId ? row.upstreamErrorExcerpt : null,
        httpStatusCode: row.httpStatusCode,
        attempts: row.attemptCount,
      };
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }),

  delete: contractProcedure(c.requests.delete).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    // Only the caller's own requests to the caller's own resources (a request to someone
    // else's pool stays in that owner's log), and never one still in flight (its attempts and
    // spend reservations are live hot-path state).
    const ownRows: Prisma.RelayRequestWhereInput = {
      userId,
      status: { not: "PENDING" },
      OR: [{ resourceOwnerUserId: userId }, { resourceOwnerUserId: null }],
    };
    const where: Prisma.RelayRequestWhereInput = {
      ...ownRows,
      ...(input.ids ? { id: { in: input.ids } } : {}),
      ...(input.before ? { createdAt: { lt: new Date(input.before) } } : {}),
    };
    // Bounded: one call deletes at most this many rows; the page calls again for more.
    const ids = await prisma.relayRequest.findMany({
      where,
      select: { id: true },
      take: 5_000,
    });
    if (ids.length === 0) return { deleted: 0 };
    // Writer class S (capacity-lock-order): terminal rows only, taken with SKIP LOCKED, so a
    // delete never waits on a row a finalizer holds (a skipped row stays for the next call).
    const deleted = await prisma.$transaction((tx) =>
      deleteTerminalRelayRequestsWithoutWaiting(
        tx,
        ids.map((row) => row.id),
      ),
    );
    return { deleted };
  }),
};

const commands = {
  list: contractProcedure(c.commands.list).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const cursor = decodeCursor(input.cursor);
    const rows = await prisma.nodeCommand.findMany({
      where: {
        AND: [
          { userId },
          afterCursor(cursor),
          {
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            ...(input.state ? { state: input.state } : {}),
          },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: {
        id: true,
        createdAt: true,
        nodeId: true,
        actor: true,
        agentTokenId: true,
        mcpGrantId: true,
        subject: true,
        state: true,
        exitCode: true,
        startedAt: true,
        endsBy: true,
        finishedAt: true,
        Node: { select: { slug: true } },
      },
    });
    const page = rows.slice(0, input.limit);
    // An agent token's name, or an OAuth client's name for rows that name its grant.
    const agentName = await loadAgentNames(userId, page);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        commandId: row.id,
        nodeId: row.nodeId,
        nodeSlug: row.Node.slug,
        actor: row.actor,
        agentTokenId: row.agentTokenId,
        agentTokenName: agentName(row),
        program: programOfSubject(row.subject),
        state: row.state,
        exitCode: row.exitCode,
        startedAt: row.startedAt.toISOString(),
        endsBy: row.endsBy.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }),
};

const needsYou = {
  list: contractProcedure(c.needsYou.list).handler(async ({ context }) => {
    const userId = context.session.user.id;
    const now = new Date();
    const [instances, queuedCommands] = await Promise.all([
      prisma.runtimeInstance.findMany({
        where: { userId, needsOperator: { not: null } },
        orderBy: { needsOperatorSince: "asc" },
        take: 200,
        select: {
          id: true,
          runtimeId: true,
          needsOperator: true,
          needsOperatorSince: true,
          createdAt: true,
          Runtime: { select: { name: true, nodeId: true } },
          Ranks: { where: { rank: 0 }, select: { nodeId: true }, take: 1 },
          // The step waiting for its person: its terminal (open or closed), a hold, or a
          // person's run past its timeout.
          Steps: {
            where: {
              OR: [
                { state: "AWAITING_OPERATOR" },
                { state: "PENDING", operatorHold: { not: null } },
                {
                  state: "RUNNING",
                  operatorAcceptedAt: { not: null },
                  deadline: { lte: now },
                },
              ],
            },
            orderBy: { createdAt: "asc" },
            select: { id: true },
            take: 1,
          },
        },
      }),
      prisma.queuedNodeCommand.count({
        where: { userId, state: "QUEUED", expiresAt: { gt: now } },
      }),
    ]);
    return {
      items: instances.flatMap((instance) =>
        instance.needsOperator
          ? [
              {
                need: instance.needsOperator,
                instanceId: instance.id,
                runtimeId: instance.runtimeId,
                runtimeName: instance.Runtime.name,
                nodeId: instance.Ranks[0]?.nodeId ?? instance.Runtime.nodeId ?? null,
                since: (instance.needsOperatorSince ?? instance.createdAt).toISOString(),
                stepId: instance.needsOperator === "STEP" ? (instance.Steps[0]?.id ?? null) : null,
              },
            ]
          : [],
      ),
      queuedCommands,
    };
  }),

  /** The nav badge: two counts, polled from every page (cheaper than the list). */
  count: contractProcedure(c.needsYou.count).handler(async ({ context }) => {
    const userId = context.session.user.id;
    const [instances, queued] = await Promise.all([
      prisma.runtimeInstance.count({ where: { userId, needsOperator: { not: null } } }),
      prisma.queuedNodeCommand.count({
        where: { userId, state: "QUEUED", expiresAt: { gt: new Date() } },
      }),
    ]);
    return { count: instances + queued };
  }),
};

export const activityRouter = {
  metrics: {
    query: contractProcedure(c.metrics.query).handler(({ context, input }) =>
      runMetricsQuery(context.session.user.id, input),
    ),
  },
  requests,
  commands,
  overview: {
    summary: contractProcedure(c.overview.summary).handler(({ context, input }) =>
      overviewSummary(context.session.user.id, input.range),
    ),
  },
  needsYou,
};
