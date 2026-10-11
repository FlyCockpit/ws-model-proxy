/**
 * The model-name namespace of one person: every name a caller of theirs may send as `model`.
 *
 * - Callable IDs `owner-slug/pool-slug` of the pools they own and of the pools shared with them
 *   with can use (whether or not the owner is active), each also as `…:external`.
 * - Their model-name aliases (`model_alias`, for every key or for one key; a key-level alias
 *   may reuse a user-level alias's name on purpose: it wins for that key).
 * - TEST targets `runtime:<runtimeId>:<model>` (sessions only).
 *
 * Callable IDs never clash with each other (user slugs and per-owner pool slugs are unique, and
 * neither holds a `/`), and an alias can never be a TEST name or an `:external` form
 * (modelAliasNameProblem). An alias can share its name with a callable ID, though: **the alias
 * wins, for its person only, until they delete it.** Routing, API-key routing, `/v1/models`,
 * `models.list` and the Test page treat a callable ID as hidden for a person when one of their
 * aliases (any scope) has its name and points at another pool (apps/server resolve.ts,
 * {@link sessionNames}); aliases.list marks the alias as hiding that pool (`hides`),
 * pools.list marks the share (`hiddenByAlias`), and the Overview warns about it.
 *
 * Nobody is refused because of someone else's alias: sharing a pool, turning can use on,
 * accepting an invite, and an owner's pool or account slug change never look at the share
 * holders' aliases, so an owner learns nothing about them. The person's own actions are refused
 * when they would create a clash in their own namespace (they learn only about their own names):
 *
 * - aliases.set: an alias named like a callable ID they can call now (alias_shadowed);
 * - pools.create / pools.update (slug) and settings.update (slug): a callable ID of their own
 *   pools named like one of their own aliases (name_aliased).
 *
 * Guard: the `00:owner:<user>` fence of the person whose namespace changes. Each of those writers
 * holds it and calls {@link modelNameClashes} under it, then writes in the same transaction. The
 * check asserts the fences ({@link requireOwnerFences}): a writer that forgot one fails instead
 * of racing.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { requireOwnerFences } from "@ws-model-proxy/db/capacity-lock-order";
import { poolOwnerActive } from "@ws-model-proxy/db/user-deletion-access";
import { refuse } from "./refuse";

type Tx = Prisma.TransactionClient;

/** A name a writer is about to add to `userId`'s own namespace. */
export type ModelNameClaim =
  | { userId: string; alias: string }
  | { userId: string; callableIds: readonly string[] };

/** A claimed name `userId` already has, as the other kind. */
export type ModelNameClash = { userId: string; name: string };

/** Only `a/b` (one slash, both halves non-empty) can ever be a callable ID. */
export function isCallableIdShaped(name: string): boolean {
  const [ownerSlug, poolSlug, ...rest] = name.split("/");
  return Boolean(ownerSlug && poolSlug) && rest.length === 0;
}

/**
 * The claims that clash with what is already in the claimants' namespaces. The caller must hold
 * the owner fence of every claimant (checked) and write its change in the same transaction.
 */
export async function modelNameClashes(
  tx: Tx,
  claims: readonly ModelNameClaim[],
): Promise<ModelNameClash[]> {
  if (claims.length === 0) return [];
  await requireOwnerFences(
    tx,
    claims.map((claim) => claim.userId),
  );
  const clashes: ModelNameClash[] = [];
  const callableByUser = new Map<string, Set<string>>();
  for (const claim of claims) {
    if ("alias" in claim) {
      if (!isCallableIdShaped(claim.alias)) continue;
      const [ownerSlug, poolSlug] = claim.alias.split("/");
      const pool = await tx.pool.findFirst({
        where: {
          slug: poolSlug,
          User: { slug: ownerSlug },
          OR: [
            { userId: claim.userId },
            { Shares: { some: { granteeUserId: claim.userId, canUse: true } } },
          ],
        },
        select: {
          userId: true,
          User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
        },
      });
      // Only a pool they can call now (routing skips an inactive owner's pools; the alias wins
      // for them once the owner is back).
      if (pool && (pool.userId === claim.userId || poolOwnerActive(pool.User, new Date())))
        clashes.push({ userId: claim.userId, name: claim.alias });
    } else if (claim.callableIds.length > 0) {
      const names = callableByUser.get(claim.userId) ?? new Set<string>();
      for (const name of claim.callableIds) names.add(name);
      callableByUser.set(claim.userId, names);
    }
  }
  if (callableByUser.size > 0) {
    const aliases = await tx.modelAlias.findMany({
      where: {
        OR: [...callableByUser].map(([userId, names]) => ({ userId, name: { in: [...names] } })),
      },
      select: { userId: true, name: true },
      orderBy: [{ userId: "asc" }, { name: "asc" }],
    });
    const seen = new Set<string>();
    for (const alias of aliases) {
      const key = `${alias.userId}\n${alias.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clashes.push({ userId: alias.userId, name: alias.name });
    }
  }
  return clashes;
}

/**
 * Refuses a new callable ID of the actor's own pools that one of their own aliases already has.
 * Claims are only ever about the actor's own namespace, so this says nothing about anyone else.
 */
export function refuseCallableIdClash(clashes: readonly ModelNameClash[]) {
  if (clashes.length === 0) return;
  throw refuse(
    "name_aliased",
    "One of your model-name aliases already uses this callable ID. Remove the alias or pick another name.",
    "CONFLICT",
  );
}

/**
 * How a person's session (no API key) resolves names shaped like callable IDs, as apps/server
 * resolve.ts routes it: `models.list`, the Test page and model tests use it.
 */
export type SessionNames = {
  /**
   * Whether an alias hides `callableId` (the ID of pool `poolId`): an alias for every key named
   * like the ID decides (hidden unless it points at that very pool); without one, a key's alias
   * of that name pointing at another pool hides the ID everywhere (the name is the alias's,
   * which a session cannot use).
   */
  hides(callableId: string, poolId: string): boolean;
  /** The pool a session reaches by `name` through its alias for every key (it wins), if any. */
  aliasPool(name: string): string | undefined;
};

export async function sessionNames(
  db: Pick<Tx, "modelAlias">,
  userId: string,
): Promise<SessionNames> {
  const rows = await db.modelAlias.findMany({
    where: { userId },
    select: { name: true, poolId: true, apiKeyId: true },
  });
  const byName = new Map<string, Array<{ poolId: string; apiKeyId: string | null }>>();
  for (const row of rows) {
    if (!isCallableIdShaped(row.name)) continue;
    const named = byName.get(row.name) ?? [];
    named.push(row);
    byName.set(row.name, named);
  }
  return {
    hides(callableId, poolId) {
      const named = byName.get(callableId);
      if (!named) return false;
      const forEveryKey = named.find((row) => row.apiKeyId === null);
      if (forEveryKey) return forEveryKey.poolId !== poolId;
      return named.some((row) => row.poolId !== poolId);
    },
    aliasPool(name) {
      return byName.get(name)?.find((row) => row.apiKeyId === null)?.poolId;
    },
  };
}
