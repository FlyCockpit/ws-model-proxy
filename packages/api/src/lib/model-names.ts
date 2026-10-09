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
 * (modelAliasNameProblem). So the one invariant left is: **no alias of a person has the name of
 * one of that person's callable IDs.** A clash already in a database from before this check
 * routes deterministically: routing never uses an alias named like any callable ID in the
 * person's namespace (apps/server resolve.ts effectiveAliases, whatever the key's scope or the
 * pool owner's state), so the name reaches the pool or, through a key that cannot call it,
 * nothing; aliases.list shows such an alias as not usable.
 *
 * Guard: the `00:owner:<user>` fence of the person whose namespace changes. Every writer that
 * adds a name to someone's namespace holds that person's owner fence and calls
 * {@link modelNameClashes} under it, then writes in the same transaction:
 *
 * - aliases.set: the caller's alias name;
 * - pools.create / pools.update (slug): the pool's callable ID, for its owner and every can-use
 *   share holder;
 * - access.shares.create / .update (can use turned on) and invite acceptance: the pool's callable
 *   ID, for the share holder;
 * - settings.update (slug): every callable ID of the person's pools, for them and every can-use
 *   share holder of each pool.
 *
 * Writers that only remove names (alias delete, share delete or can use off, pool delete) need
 * no claim. The check asserts the fences ({@link requireOwnerFences}): a writer that forgot one
 * fails instead of racing.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { requireOwnerFences } from "@ws-model-proxy/db/capacity-lock-order";
import { refuse } from "./refuse";

type Tx = Prisma.TransactionClient;

/** A name a writer is about to add to `userId`'s namespace. */
export type ModelNameClaim =
  | { userId: string; alias: string }
  | { userId: string; callableIds: readonly string[] };

/** A claimed name `userId` already has, as the other kind. */
export type ModelNameClash = { userId: string; name: string };

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
      const [ownerSlug, poolSlug, ...rest] = claim.alias.split("/");
      // Only `a/b` can be a callable ID.
      if (!ownerSlug || !poolSlug || rest.length > 0) continue;
      const pool = await tx.pool.findFirst({
        where: {
          slug: poolSlug,
          User: { slug: ownerSlug },
          OR: [
            { userId: claim.userId },
            { Shares: { some: { granteeUserId: claim.userId, canUse: true } } },
          ],
        },
        select: { id: true },
      });
      if (pool) clashes.push({ userId: claim.userId, name: claim.alias });
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
 * Refuses a new callable ID that clashes. `actorUserId` is the person making the change: a clash
 * with their own alias says so; one with anyone else's says only that the name is unavailable
 * to someone the pool is (or would be) shared with, never whose alias or which name.
 */
export function refuseCallableIdClash(clashes: readonly ModelNameClash[], actorUserId: string) {
  if (clashes.length === 0) return;
  if (clashes.some((clash) => clash.userId === actorUserId))
    throw refuse(
      "name_aliased",
      "One of your model-name aliases already uses this callable ID. Remove the alias or pick another name.",
      "CONFLICT",
    );
  throw refuse(
    "name_unavailable",
    "This callable ID is not available to someone this pool is or would be shared with. Pick another name.",
    "CONFLICT",
  );
}

/**
 * The can-use share holders of `poolIds` (whose namespaces hold those pools' callable IDs).
 * A plain read: before the fences it plans them; under the pool owner's fence it is exact, since
 * every share write holds that fence.
 */
export async function canUseHolders(
  db: Pick<Tx, "share">,
  poolIds: readonly string[],
): Promise<Array<{ poolId: string; granteeUserId: string }>> {
  if (poolIds.length === 0) return [];
  return db.share.findMany({
    where: { poolId: { in: [...poolIds] }, canUse: true },
    select: { poolId: true, granteeUserId: true },
    orderBy: [{ poolId: "asc" }, { granteeUserId: "asc" }],
  });
}
