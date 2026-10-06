/**
 * Activity (lane D): the request log, the command log and what waits for a person. Metrics and
 * the overview summary are still stubs (`metrics.query` reads the rollup tables; a later chunk).
 *
 * The request log shows requests the caller made and requests to the caller's own pools and
 * runtimes (`resourceOwnerUserId`), prompt-free. Only the caller's own finished requests can be
 * deleted.
 */
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { deleteTerminalRelayRequestsWithoutWaiting } from "@ws-model-proxy/db/capacity-lock-order";
import type { z } from "zod";
import { contractProcedure, stub } from "../contract-procedure";
import { activityContract as c, type requestRowSchema } from "../contracts/activity";
import { callableIdOf } from "../lib/access-views";
import { programOfSubject } from "../lib/command-audit";

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
  rejection: true,
  errorClass: true,
  httpStatusCode: true,
  attemptCount: true,
  resourceOwnerUserId: true,
} satisfies Prisma.RelayRequestSelect;

const requests = {
  list: contractProcedure(c.requests.list).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const cursor = decodeCursor(input.cursor);
    const versionIds = input.runtimeId
      ? (
          await prisma.runtimeVersion.findMany({
            where: { runtimeId: input.runtimeId },
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
        rejection: row.rejection,
        errorClass: row.errorClass,
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
    const tokenIds = [
      ...new Set(page.flatMap((row) => (row.agentTokenId ? [row.agentTokenId] : []))),
    ];
    const tokens = tokenIds.length
      ? await prisma.agentToken.findMany({
          where: { id: { in: tokenIds }, userId },
          select: { id: true, name: true },
        })
      : [];
    const tokenName = new Map(tokens.map((token) => [token.id, token.name]));
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        commandId: row.id,
        nodeId: row.nodeId,
        nodeSlug: row.Node.slug,
        actor: row.actor,
        agentTokenId: row.agentTokenId,
        agentTokenName: row.agentTokenId ? (tokenName.get(row.agentTokenId) ?? null) : null,
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
          Steps: {
            where: { state: "AWAITING_OPERATOR" },
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
};

export const activityRouter = {
  metrics: {
    query: stub(c.metrics.query),
  },
  requests,
  commands,
  overview: {
    summary: stub(c.overview.summary),
  },
  needsYou,
};
