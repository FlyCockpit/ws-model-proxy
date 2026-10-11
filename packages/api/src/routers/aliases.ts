/**
 * Model-name aliases (`pools.aliases.*`): a name a caller's harness hard-codes, mapped to one of
 * the pools the caller may use, for every key or for one key. Aliases live in the caller's own
 * namespace: they never grant access (the model API resolves an alias only to a pool the key in
 * use can call, and the send boundary re-checks access as for any callable ID), so agents may
 * manage them like other configuration. Changes are audited (`model_alias.set` / `.delete`).
 */

import prisma, { type Prisma } from "@ws-model-proxy/db";
import { poolOwnerActive } from "@ws-model-proxy/db/user-deletion-access";
import type { SignedInContext } from "../contract-procedure";
import { contractProcedure } from "../contract-procedure";
import { agentRulesApply } from "../contracts/auth-context";
import { MODEL_ALIASES_MAX_PER_USER, poolsContract } from "../contracts/pools";
import { runAccessTransaction } from "../lib/access-transaction";
import { callableIdOf } from "../lib/access-views";
import { callerActor } from "../lib/caller-actor";
import { modelNameClashes } from "../lib/model-names";
import { notFound, refuse } from "../lib/refuse";

const c = poolsContract.aliases;

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

/** `active`: the owner's account is active, so routing reaches the pool now (#76). */
type CallablePools = Map<string, { callableId: string; own: boolean; active: boolean }>;

/** Pools the user may call (own, or shared with them with can use), by id. */
async function callablePools(
  userId: string,
  db: Pick<Prisma.TransactionClient, "pool"> = prisma,
  now = new Date(),
): Promise<CallablePools> {
  const pools = await db.pool.findMany({
    where: { OR: [{ userId }, { Shares: { some: { granteeUserId: userId, canUse: true } } }] },
    select: {
      id: true,
      slug: true,
      userId: true,
      User: { select: { slug: true, banned: true, banExpires: true, deletionRequestedAt: true } },
    },
  });
  return new Map(
    pools.map((pool) => [
      pool.id,
      {
        callableId: callableIdOf(pool.User.slug, pool.slug),
        own: pool.userId === userId,
        active: pool.userId === userId || poolOwnerActive(pool.User, now),
      },
    ]),
  );
}

const ALIAS_SELECT = {
  id: true,
  name: true,
  poolId: true,
  apiKeyId: true,
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

/**
 * The pool an alias hides: one the caller may call now whose callable ID is the alias's name (shared
 * with them after they made the alias, or a clash from before the namespace check). The alias
 * wins for the caller until they rename or delete it (lib/model-names.ts). An alias named like
 * the very pool it points at hides nothing.
 */
function hiddenPool(row: Pick<AliasRow, "name" | "poolId">, callable: CallablePools) {
  for (const [poolId, pool] of callable)
    if (pool.active && pool.callableId === row.name && poolId !== row.poolId)
      return { poolId, callableId: pool.callableId, shared: !pool.own };
  return null;
}

function aliasView(row: AliasRow, callable: CallablePools, agent: boolean, now = new Date()) {
  const hidden = hiddenPool(row, callable);
  return {
    id: row.id,
    name: row.name,
    poolId: row.poolId,
    // Only what the caller may see: a pool no longer callable shows nothing of itself.
    callableId: callable.get(row.poolId)?.callableId ?? null,
    apiKeyId: row.apiKeyId,
    // Keys are managed by people: agents see which key an alias is for, not its name.
    apiKeyName: agent ? null : (row.ApiKey?.name ?? null),
    usable:
      callable.get(row.poolId)?.active === true &&
      (!row.ApiKey || keyAllowsPool(row.ApiKey, row.poolId, now)),
    hides: hidden ? { callableId: hidden.callableId, shared: hidden.shared } : null,
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
    const agent = agentRulesApply(context.auth);
    return { aliases: rows.map((row) => aliasView(row, callable, agent)) };
  }),

  set: contractProcedure(c.set).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const apiKeyId = input.apiKeyId ?? null;
    const scopeKey = apiKeyId ?? "";
    // Under the caller's owner fence (model-names.ts): every writer that adds a name to their
    // namespace holds it, so the clash check and the write are one step.
    const { row, callable } = await runAccessTransaction({ owners: [userId] }, async (tx) => {
      const callable = await callablePools(userId, tx);
      if (!callable.has(input.poolId)) throw notFound("That pool does not exist.");
      // A new alias may not take a callable ID the caller can call now (their own namespace
      // only; an existing alias that a later share collides with wins instead).
      if ((await modelNameClashes(tx, [{ userId, alias: input.name }])).length > 0)
        throw refuse(
          "alias_shadowed",
          "That name is one of your callable IDs already.",
          "BAD_REQUEST",
        );
      if (apiKeyId) {
        const now = new Date();
        const key = await tx.apiKey.findFirst({
          where: {
            id: apiKeyId,
            userId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
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
      return { row: saved, callable };
    });
    return aliasView(row, callable, agentRulesApply(context.auth));
  }),

  delete: contractProcedure(c.delete).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const alias = await prisma.modelAlias.findFirst({
      where: { id: input.aliasId, userId },
      select: { id: true, name: true, poolId: true, apiKeyId: true },
    });
    if (!alias) throw notFound("That alias does not exist.");
    // Owner-scoped again: a concurrent move of the id can only ever be the caller's own row.
    await prisma.modelAlias.deleteMany({ where: { id: alias.id, userId } });
    await audit(prisma, context, {
      aliasId: input.aliasId,
      action: "model_alias.delete",
      after: { name: alias.name, poolId: alias.poolId, apiKeyId: alias.apiKeyId },
      note: input.note,
    });
    return { ok: true as const };
  }),
};
