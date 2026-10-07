/**
 * Model-name aliases (`pools.aliases.*`): a name a caller's harness hard-codes, mapped to one of
 * the pools the caller may use, for every key or for one key. Aliases live in the caller's own
 * namespace: they never grant access (the model API resolves an alias only to a pool the key in
 * use can call, and the send boundary re-checks access as for any callable ID), so agents may
 * manage them like other configuration. Changes are audited (`model_alias.set` / `.delete`).
 */

import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { SignedInContext } from "../contract-procedure";
import { contractProcedure } from "../contract-procedure";
import { MODEL_ALIASES_MAX_PER_USER, poolsContract } from "../contracts/pools";
import { callerActor } from "../lib/caller-actor";
import { notFound, refuse } from "../lib/refuse";

const c = poolsContract.aliases;

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

/** Pools the user may call (own, or shared with them with can use), by id. */
async function callablePools(userId: string) {
  const pools = await prisma.pool.findMany({
    where: { OR: [{ userId }, { Shares: { some: { granteeUserId: userId, canUse: true } } }] },
    select: { id: true, slug: true, User: { select: { slug: true } } },
  });
  return new Map(pools.map((pool) => [pool.id, `${pool.User.slug}/${pool.slug}`]));
}

const ALIAS_SELECT = {
  id: true,
  name: true,
  poolId: true,
  apiKeyId: true,
  Pool: { select: { slug: true, User: { select: { slug: true } } } },
  ApiKey: {
    select: {
      name: true,
      scope: true,
      revokedAt: true,
      expiresAt: true,
      Pools: { select: { poolId: true } },
    },
  },
} satisfies Prisma.ModelAliasSelect;
type AliasRow = Prisma.ModelAliasGetPayload<{ select: typeof ALIAS_SELECT }>;

function keyAllowsPool(key: NonNullable<AliasRow["ApiKey"]>, poolId: string, now: Date): boolean {
  if (key.revokedAt || (key.expiresAt && key.expiresAt.getTime() <= now.getTime())) return false;
  return key.scope === "ALL_POOLS" || key.Pools.some((pool) => pool.poolId === poolId);
}

function aliasView(row: AliasRow, callable: Map<string, string>, now = new Date()) {
  return {
    id: row.id,
    name: row.name,
    poolId: row.poolId,
    callableId: callable.get(row.poolId) ?? `${row.Pool.User.slug}/${row.Pool.slug}`,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.ApiKey?.name ?? null,
    usable: callable.has(row.poolId) && (!row.ApiKey || keyAllowsPool(row.ApiKey, row.poolId, now)),
  };
}

async function audit(
  tx: Pick<Prisma.TransactionClient, "auditEvent">,
  context: SignedInContext,
  input: { aliasId: string; action: string; after?: unknown; note?: string },
) {
  const userId = userIdOf(context);
  const actor = callerActor(context.auth, userId);
  await tx.auditEvent.create({
    data: {
      userId,
      actor: actor.actor,
      actorUserId: actor.actorUserId,
      agentTokenId: actor.agentTokenId,
      mcpGrantId: actor.mcpGrantId,
      action: input.action,
      resourceType: "model_alias",
      resourceId: input.aliasId,
      after: { ...(input.after ?? {}), ...(input.note ? { note: input.note } : {}) },
    },
  });
}

export const modelAliasesRouter = {
  list: contractProcedure(c.list).handler(async ({ context }) => {
    const userId = userIdOf(context);
    const [rows, callable] = await Promise.all([
      prisma.modelAlias.findMany({
        where: { userId },
        select: ALIAS_SELECT,
        orderBy: [{ name: "asc" }, { scopeKey: "asc" }],
      }),
      callablePools(userId),
    ]);
    return { aliases: rows.map((row) => aliasView(row, callable)) };
  }),

  set: contractProcedure(c.set).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const callable = await callablePools(userId);
    if (!callable.has(input.poolId)) throw notFound("That pool does not exist.");
    // Callable IDs always win over an alias: one that equals one would never be used.
    if ([...callable.values()].includes(input.name))
      throw refuse(
        "alias_shadowed",
        "That name is one of your callable IDs already.",
        "BAD_REQUEST",
      );
    const apiKeyId = input.apiKeyId ?? null;
    if (apiKeyId) {
      const key = await prisma.apiKey.findFirst({
        where: { id: apiKeyId, userId, revokedAt: null },
        select: {
          scope: true,
          Pools: { where: { poolId: input.poolId }, select: { poolId: true } },
        },
      });
      if (!key) throw notFound("That key does not exist.");
      if (key.scope === "SELECTED_POOLS" && key.Pools.length === 0)
        throw refuse(
          "alias_key_not_allowed",
          "That key cannot call this pool; add the pool to the key first.",
          "BAD_REQUEST",
        );
    }
    const scopeKey = apiKeyId ?? "";
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.modelAlias.findUnique({
        where: { userId_scopeKey_name: { userId, scopeKey, name: input.name } },
        select: { id: true },
      });
      if (
        !existing &&
        (await tx.modelAlias.count({ where: { userId } })) >= MODEL_ALIASES_MAX_PER_USER
      )
        throw refuse(
          "alias_limit",
          `At most ${MODEL_ALIASES_MAX_PER_USER} aliases; remove one first.`,
          "CONFLICT",
        );
      const saved = await tx.modelAlias.upsert({
        where: { userId_scopeKey_name: { userId, scopeKey, name: input.name } },
        create: { userId, apiKeyId, scopeKey, name: input.name, poolId: input.poolId },
        update: { poolId: input.poolId },
        select: ALIAS_SELECT,
      });
      await audit(tx, context, {
        aliasId: saved.id,
        action: "model_alias.set",
        after: { name: input.name, poolId: input.poolId, apiKeyId },
        note: input.note,
      });
      return saved;
    });
    return aliasView(row, callable);
  }),

  delete: contractProcedure(c.delete).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const alias = await prisma.modelAlias.findFirst({
      where: { id: input.aliasId, userId },
      select: { id: true },
    });
    if (!alias) throw notFound("That alias does not exist.");
    // Owner-scoped again: a concurrent move of the id can only ever be the caller's own row.
    await prisma.modelAlias.deleteMany({ where: { id: alias.id, userId } });
    await audit(prisma, context, {
      aliasId: input.aliasId,
      action: "model_alias.delete",
      note: input.note,
    });
    return { ok: true as const };
  }),
};
