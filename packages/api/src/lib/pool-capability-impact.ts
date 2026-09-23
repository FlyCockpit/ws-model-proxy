import type { Prisma } from "@ws-model-proxy/db";
import { parseModelApiSurface } from "./model-api-surface";
import { type PoolSurfaceMember, recommendedSurfaceViolation } from "./pool-recommended-surface";
import { poolMemberSurfaceSelect, poolSurfaceMemberFromRow } from "./pool-surface-members";
import type { ModelApiSurface } from "./surface-capabilities";

/**
 * Advisory-only impact visibility for capability edits.
 *
 * Capability-side mutations (discovered-model capability edits and deletion,
 * provider nativeCapabilities edits) are deliberately NOT gated: an operator
 * correcting an inventory must not be blocked. Instead, the mutation response
 * reports which pools' effective recommended surface would become unservable
 * as a result of the already-applied edit. Everything here reuses the exact
 * selectability code paths (`poolMemberSurfaceSelect`, the shared row mapper,
 * and `recommendedSurfaceViolation`) so the advisory can never disagree with
 * the hard gates, and it never throws — a reporting failure must not fail a
 * successful edit.
 */

export type ImpactedPoolAdvisory = {
  id: string;
  slug: string;
  surface: ModelApiSurface;
};

type ImpactDb = Pick<Prisma.TransactionClient, "poolMember" | "modelPool">;

/** Members that resolve capabilities through a discovered model (direct or via execution target). */
export function discoveredModelPoolMemberWhere(
  discoveredModelId: string,
): Prisma.PoolMemberWhereInput {
  return { OR: [{ discoveredModelId }, { ExecutionTarget: { discoveredModelId } }] };
}

/** Members that resolve capabilities through a provider model's native inventory. */
export function providerModelPoolMemberWhere(providerModelId: string): Prisma.PoolMemberWhereInput {
  return { ExecutionTarget: { providerModelId } };
}

/**
 * Distinct pool ids owning at least one member matching `memberWhere`. Call
 * this BEFORE a deletion (the matching members cascade away with the model);
 * for capability edits it may be called before or after the write.
 */
export async function poolIdsWithMembers(
  db: Pick<Prisma.TransactionClient, "poolMember">,
  userId: string,
  memberWhere: Prisma.PoolMemberWhereInput,
): Promise<string[]> {
  const rows =
    (await db.poolMember.findMany({
      where: { ...memberWhere, ModelPool: { userId } },
      select: { poolId: true },
    })) ?? [];
  return [...new Set(rows.map((row) => row.poolId))];
}

/**
 * Computes which of the given pools now have an effective recommended surface
 * no PRIMARY member can serve (natively or under the deployment adaptation
 * gate), reading the post-edit member state through the shared selectability
 * inputs. Advisory only: any error yields an empty report.
 */
export async function capabilityEditImpactedPools(
  db: ImpactDb,
  { userId, poolIds }: { userId: string; poolIds: string[] },
): Promise<ImpactedPoolAdvisory[]> {
  if (poolIds.length === 0) return [];
  try {
    const pools =
      (await db.modelPool.findMany({
        where: { id: { in: poolIds }, userId },
        select: {
          id: true,
          slug: true,
          recommendedSurfaceOverride: true,
          protocolAdaptationEnabled: true,
        },
      })) ?? [];
    if (pools.length === 0) return [];
    const memberRows =
      (await db.poolMember.findMany({
        where: { poolId: { in: pools.map((pool) => pool.id) }, ModelPool: { userId } },
        select: poolMemberSurfaceSelect,
      })) ?? [];
    const membersByPool = new Map<string, PoolSurfaceMember[]>();
    for (const row of memberRows) {
      const list = membersByPool.get(row.poolId) ?? [];
      list.push(poolSurfaceMemberFromRow(row));
      membersByPool.set(row.poolId, list);
    }
    const impacted: ImpactedPoolAdvisory[] = [];
    for (const pool of pools) {
      const violation = recommendedSurfaceViolation({
        override: parseModelApiSurface(pool.recommendedSurfaceOverride),
        members: membersByPool.get(pool.id) ?? [],
        adaptationEnabled: pool.protocolAdaptationEnabled,
      });
      if (violation) impacted.push({ id: pool.id, slug: pool.slug, surface: violation });
    }
    return impacted;
  } catch (error) {
    // Advisory-only: a reporting failure must never fail a successful edit,
    // but it must not vanish silently either.
    console.error("[pool-capability-impact] advisory computation failed:", error);
    return [];
  }
}
