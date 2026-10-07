/**
 * Admin observability (admin only, read-only): every node, runtime, pool and the request log
 * across accounts, paged, optionally narrowed to owners whose email, name or slug matches.
 * Operational metadata only: no secrets, addresses, definitions, prompts or responses.
 */
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { contractProcedure } from "../contract-procedure";
import { adminObservabilityContract as c } from "../contracts/account";
import { callableIdOf } from "../lib/access-views";
import { nodeTrustView } from "../nodes/trust";

type PageInput = { page: number; pageSize: number; ownerQuery?: string | undefined };

const OWNER_SELECT = { id: true, email: true, name: true, slug: true } as const;
/** Instances that hold or want their node: what an admin counts as running. */
const LIVE_PHASES = ["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"] as const;
/** Request log rows: owners matching a query, at most this many (a narrower query finds more). */
const MAX_MATCHED_OWNERS = 1_000;

function ownerWhere(query: string | undefined): Prisma.UserWhereInput | undefined {
  if (!query) return undefined;
  return {
    OR: [
      { email: { contains: query, mode: "insensitive" } },
      { name: { contains: query, mode: "insensitive" } },
      { slug: { contains: query, mode: "insensitive" } },
    ],
  };
}

function paging(input: PageInput) {
  return { skip: (input.page - 1) * input.pageSize, take: input.pageSize };
}

function pageOf<T>(items: T[], total: number, input: PageInput) {
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export const adminObservabilityRouter = {
  nodes: contractProcedure(c.nodes).handler(async ({ input }) => {
    const owner = ownerWhere(input.ownerQuery);
    const where: Prisma.NodeWhereInput = owner ? { User: owner } : {};
    const [rows, total] = await Promise.all([
      prisma.node.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...paging(input),
        select: {
          id: true,
          slug: true,
          connection: true,
          trust: true,
          trustChangedAt: true,
          trustLowerRequestedAt: true,
          cliVersion: true,
          lastHeartbeatAt: true,
          User: { select: OWNER_SELECT },
          _count: {
            select: { Ranks: { where: { Instance: { phase: { in: [...LIVE_PHASES] } } } } },
          },
        },
      }),
      prisma.node.count({ where }),
    ]);
    return pageOf(
      rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        owner: row.User,
        connection: row.connection,
        trust: nodeTrustView(row).effective,
        version: row.cliVersion,
        lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
        runningInstances: row._count.Ranks,
      })),
      total,
      input,
    );
  }),

  runtimes: contractProcedure(c.runtimes).handler(async ({ input }) => {
    const owner = ownerWhere(input.ownerQuery);
    const where: Prisma.RuntimeWhereInput = owner ? { User: owner } : {};
    const [rows, total] = await Promise.all([
      prisma.runtime.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...paging(input),
        select: {
          id: true,
          slug: true,
          kind: true,
          User: { select: OWNER_SELECT },
          CurrentVersion: { select: { modelType: true } },
          Instances: {
            where: { phase: { not: "STOPPED" } },
            orderBy: { createdAt: "desc" },
            take: 20,
            select: { id: true, phase: true },
          },
        },
      }),
      prisma.runtime.count({ where }),
    ]);
    return pageOf(
      rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        owner: row.User,
        kind: row.kind,
        modelType: row.CurrentVersion?.modelType ?? null,
        instances: row.Instances,
      })),
      total,
      input,
    );
  }),

  pools: contractProcedure(c.pools).handler(async ({ input }) => {
    const owner = ownerWhere(input.ownerQuery);
    const where: Prisma.PoolWhereInput = owner ? { User: owner } : {};
    const [rows, total] = await Promise.all([
      prisma.pool.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...paging(input),
        select: {
          id: true,
          slug: true,
          modelType: true,
          User: { select: OWNER_SELECT },
          _count: { select: { Members: true, Shares: true } },
        },
      }),
      prisma.pool.count({ where }),
    ]);
    return pageOf(
      rows.map((row) => ({
        id: row.id,
        callableId: callableIdOf(row.User.slug, row.slug),
        owner: row.User,
        modelType: row.modelType,
        members: row._count.Members,
        shares: row._count.Shares,
      })),
      total,
      input,
    );
  }),

  relay: contractProcedure(c.relay).handler(async ({ input }) => {
    // The request log has no user relation (hot-path rows): match owners first.
    const owner = ownerWhere(input.ownerQuery);
    const matched = owner
      ? await prisma.user.findMany({
          where: owner,
          select: { id: true },
          take: MAX_MATCHED_OWNERS,
        })
      : null;
    if (matched && matched.length === 0) return pageOf([], 0, input);
    const where: Prisma.RelayRequestWhereInput = matched
      ? { userId: { in: matched.map((user) => user.id) } }
      : {};
    const [rows, total] = await Promise.all([
      prisma.relayRequest.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...paging(input),
        select: {
          id: true,
          createdAt: true,
          userId: true,
          status: true,
          poolId: true,
          external: true,
          durationMs: true,
          errorClass: true,
        },
      }),
      prisma.relayRequest.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const poolIds = [...new Set(rows.flatMap((row) => (row.poolId ? [row.poolId] : [])))];
    const [users, pools] = await Promise.all([
      userIds.length
        ? prisma.user.findMany({ where: { id: { in: userIds } }, select: OWNER_SELECT })
        : [],
      poolIds.length
        ? prisma.pool.findMany({
            where: { id: { in: poolIds } },
            select: { id: true, slug: true, User: { select: { slug: true } } },
          })
        : [],
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const callable = new Map(
      pools.map((pool) => [pool.id, callableIdOf(pool.User.slug, pool.slug)]),
    );
    return pageOf(
      rows.flatMap((row) => {
        const user = usersById.get(row.userId);
        // A deleted requester's rows go with their account.
        if (!user) return [];
        const pool = row.poolId ? callable.get(row.poolId) : undefined;
        return [
          {
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            owner: user,
            status: row.status,
            callableId: pool ? `${pool}${row.external ? ":external" : ""}` : null,
            durationMs: row.durationMs,
            errorClass: row.errorClass,
          },
        ];
      }),
      total,
      input,
    );
  }),
};
