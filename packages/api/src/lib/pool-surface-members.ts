import type { Prisma } from "@ws-model-proxy/db";
import {
  discoveredModelSurfaceCapabilities,
  type PoolSurfaceMember,
  providerModelSurfaceCapabilities,
} from "./pool-recommended-surface";

export const poolMemberSurfaceSelect = {
  id: true,
  poolId: true,
  tier: true,
  discoveredModelId: true,
  DiscoveredModel: {
    select: {
      capabilityOverrideMode: true,
      capabilityOverrideMetadata: true,
      capabilityOverrides: true,
      Endpoint: { select: { capabilityMetadata: true, defaultCapabilities: true } },
    },
  },
  ExecutionTarget: {
    select: {
      DiscoveredModel: {
        select: {
          capabilityOverrideMode: true,
          capabilityOverrideMetadata: true,
          capabilityOverrides: true,
          Endpoint: { select: { capabilityMetadata: true, defaultCapabilities: true } },
        },
      },
      ProviderModel: { select: { nativeCapabilities: true } },
    },
  },
} as const satisfies Prisma.PoolMemberSelect;

type PoolMemberSurfaceRow = Prisma.PoolMemberGetPayload<{
  select: typeof poolMemberSurfaceSelect;
}>;

export type PoolSurfaceMemberSnapshot = PoolSurfaceMember & { id: string };

/**
 * Maps one pool-member row (selected with `poolMemberSurfaceSelect`) onto the
 * selectability member view, resolving each member's servable capabilities
 * through the single shared resolution path (the same one pool serialization
 * uses): the execution target's discovered model, else the direct model
 * relation, else the provider's native capabilities (structured inventory,
 * with the legacy raw-surface shape normalized).
 */
export function poolSurfaceMemberFromRow(member: PoolMemberSurfaceRow): PoolSurfaceMemberSnapshot {
  const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
  if (model) {
    return {
      id: member.id,
      tier: member.tier,
      capabilities: discoveredModelSurfaceCapabilities(model),
    };
  }
  return {
    id: member.id,
    tier: member.tier,
    capabilities: providerModelSurfaceCapabilities(
      member.ExecutionTarget?.ProviderModel?.nativeCapabilities,
    ),
  };
}

/**
 * Loads a pool's members as selectability inputs through the shared row
 * mapper above.
 */
export async function loadPoolSurfaceMembers(
  tx: Pick<Prisma.TransactionClient, "poolMember">,
  poolId: string,
  excludeMemberId?: string,
): Promise<PoolSurfaceMemberSnapshot[]> {
  const members =
    (await tx.poolMember.findMany({
      where: excludeMemberId ? { poolId, id: { not: excludeMemberId } } : { poolId },
      select: poolMemberSurfaceSelect,
    })) ?? [];
  return members.map(poolSurfaceMemberFromRow);
}
