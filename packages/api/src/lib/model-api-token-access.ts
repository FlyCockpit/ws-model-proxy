import { ORPCError } from "@orpc/server";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import {
  effectiveProviderEgress,
  egressProviderAccountLabels,
  providerPrimaryMemberWhere,
} from "./effective-provider-egress";
import { parseModelApiSurface } from "./model-api-surface";
import type { ModelApiSurface } from "./surface-capabilities";

export {
  effectiveProviderEgress,
  grantPoolAccessServerMessage,
  grantPoolAccessServerMessages,
  providerPrimaryMemberCount,
  providerPrimaryMemberWhere,
} from "./effective-provider-egress";

export const modelApiTokenScopeModes = ["ALL_VISIBLE", "ALLOWLIST"] as const;
export type ModelApiTokenScopeMode = (typeof modelApiTokenScopeModes)[number];

export const modelApiTokenAllowlistTargets = ["DIRECT_MODEL", "MODEL_POOL"] as const;
export type ModelApiTokenAllowlistTarget = (typeof modelApiTokenAllowlistTargets)[number];

export type VisibleDirectModelTarget = {
  target: "DIRECT_MODEL";
  id: string;
  modelId: string;
  upstreamModelId: string;
  ownerUserId: string;
  ownerUserSlug: string;
  endpointId: string;
  endpointSlug: string;
  cliDeviceSlug: string;
  maxAttachmentBytes: number | null;
};

export type VisibleModelPoolTarget = {
  target: "MODEL_POOL";
  id: string;
  modelId: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  ownerUserSlug: string;
  /** Exact grant row establishing visibility; null for the pool owner. */
  accessGrantId: string | null;
  poolSlug: string;
  maxAttachmentBytes: number | null;
  optimisticBasicTranscription: boolean;
  protocolAdaptationEnabled: boolean;
  publicEgressEnabled: boolean;
  publicEgressAcknowledged: boolean;
  /**
   * True when a grant must acknowledge provider egress: public overflow is on,
   * or a PRIMARY member is a provider model. Overflow-only provider members
   * do not count unless public overflow is on.
   */
  effectiveProviderEgress: boolean;
  providerPrimaryMemberCount: number;
  /** Display names of provider accounts that can receive traffic. Never credentials. */
  providerAccountLabels: string[];
  allowLossyDeveloperRoleCollapse: boolean;
  recommendedSurfaceOverride: ModelApiSurface | null;
};

export type VisibleModelTargets = {
  directModels: VisibleDirectModelTarget[];
  modelPools: VisibleModelPoolTarget[];
};

export type ModelApiTokenIdentity = {
  id: string;
  userId: string;
  scopeMode: ModelApiTokenScopeMode;
  lookupPrefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

const directModelSelect = {
  id: true,
  userId: true,
  upstreamModelId: true,
  maxAttachmentBytes: true,
  optimisticBasicTranscription: true,
  User: { select: { slug: true } },
  Endpoint: {
    select: {
      id: true,
      slug: true,
      CliDevice: { select: { slug: true } },
    },
  },
} satisfies Prisma.DiscoveredModelSelect;

const modelPoolSelect = {
  id: true,
  userId: true,
  slug: true,
  name: true,
  description: true,
  maxAttachmentBytes: true,
  optimisticBasicTranscription: true,
  protocolAdaptationEnabled: true,
  publicEgressEnabled: true,
  publicEgressAcknowledged: true,
  allowLossyDeveloperRoleCollapse: true,
  recommendedSurfaceOverride: true,
  PoolMembers: {
    where: {
      OR: [
        providerPrimaryMemberWhere,
        { tier: "PUBLIC_OVERFLOW", ExecutionTarget: { providerModelId: { not: null } } },
      ],
    },
    select: {
      id: true,
      tier: true,
      ExecutionTarget: {
        select: {
          ProviderModel: {
            select: { ProviderAccount: { select: { label: true } } },
          },
        },
      },
    },
  },
  User: { select: { slug: true } },
} satisfies Prisma.ModelPoolSelect;

type DirectModelRow = Prisma.DiscoveredModelGetPayload<{
  select: typeof directModelSelect;
}>;
type ModelPoolRow = Prisma.ModelPoolGetPayload<{ select: typeof modelPoolSelect }>;

function serializeDirectModel(row: DirectModelRow): VisibleDirectModelTarget {
  return {
    target: "DIRECT_MODEL",
    id: row.id,
    modelId: directModelId({
      userSlug: row.User.slug,
      cliSlug: row.Endpoint.CliDevice.slug,
      endpointSlug: row.Endpoint.slug,
      upstreamModelId: row.upstreamModelId,
    }),
    upstreamModelId: row.upstreamModelId,
    ownerUserId: row.userId,
    ownerUserSlug: row.User.slug,
    endpointId: row.Endpoint.id,
    endpointSlug: row.Endpoint.slug,
    cliDeviceSlug: row.Endpoint.CliDevice.slug,
    maxAttachmentBytes: row.maxAttachmentBytes,
  };
}

function serializeModelPool(
  row: ModelPoolRow,
  accessGrantId: string | null = null,
): VisibleModelPoolTarget {
  return {
    target: "MODEL_POOL",
    id: row.id,
    modelId: poolModelId({ userSlug: row.User.slug, poolSlug: row.slug }),
    name: row.name,
    description: row.description,
    ownerUserId: row.userId,
    ownerUserSlug: row.User.slug,
    accessGrantId,
    poolSlug: row.slug,
    maxAttachmentBytes: row.maxAttachmentBytes,
    optimisticBasicTranscription: row.optimisticBasicTranscription,
    protocolAdaptationEnabled: row.protocolAdaptationEnabled,
    publicEgressEnabled: row.publicEgressEnabled,
    publicEgressAcknowledged: row.publicEgressAcknowledged,
    effectiveProviderEgress: effectiveProviderEgress({
      publicEgressEnabled: row.publicEgressEnabled,
      providerPrimaryMemberCount: (row.PoolMembers ?? []).filter(
        (member) => member.tier === "PRIMARY",
      ).length,
    }),
    providerPrimaryMemberCount: (row.PoolMembers ?? []).filter(
      (member) => member.tier === "PRIMARY",
    ).length,
    providerAccountLabels: egressProviderAccountLabels({
      publicEgressEnabled: row.publicEgressEnabled,
      members: (row.PoolMembers ?? []).map((member) => ({
        tier: member.tier,
        accountLabel: member.ExecutionTarget?.ProviderModel?.ProviderAccount.label ?? null,
      })),
    }),
    allowLossyDeveloperRoleCollapse: row.allowLossyDeveloperRoleCollapse,
    recommendedSurfaceOverride: parseModelApiSurface(row.recommendedSurfaceOverride),
  };
}

function dedupePools(pools: VisibleModelPoolTarget[]): VisibleModelPoolTarget[] {
  const seen = new Set<string>();
  const deduped: VisibleModelPoolTarget[] = [];
  for (const pool of pools) {
    if (seen.has(pool.id)) continue;
    seen.add(pool.id);
    deduped.push(pool);
  }
  return deduped;
}

export async function listVisibleModelTargetsForUser(userId: string): Promise<VisibleModelTargets> {
  const [directModelRows, ownedPoolRows, grantedPoolRows] = await Promise.all([
    prisma.discoveredModel.findMany({
      where: { userId, published: true, Endpoint: { published: true } },
      orderBy: { createdAt: "desc" },
      select: directModelSelect,
    }),
    prisma.modelPool.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: modelPoolSelect,
    }),
    prisma.poolGrant.findMany({
      where: { granteeUserId: userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        ModelPool: { select: modelPoolSelect },
      },
    }),
  ]);

  const directModels = directModelRows.map(serializeDirectModel);
  const ownedPools = ownedPoolRows.map((row) => serializeModelPool(row));
  const grantedPools = grantedPoolRows.map((grant) =>
    serializeModelPool(grant.ModelPool, grant.id),
  );

  return {
    directModels,
    modelPools: dedupePools([...ownedPools, ...grantedPools]),
  };
}

export async function resolveAllowlistedModelTargets({
  userId,
  modelIds,
}: {
  userId: string;
  modelIds: string[];
}): Promise<VisibleModelTargets> {
  const visibleTargets = await listVisibleModelTargetsForUser(userId);
  const directByModelId = new Map(
    visibleTargets.directModels.map((model) => [model.modelId, model] as const),
  );
  const poolByModelId = new Map(
    visibleTargets.modelPools.map((pool) => [pool.modelId, pool] as const),
  );

  const directModels: VisibleDirectModelTarget[] = [];
  const modelPools: VisibleModelPoolTarget[] = [];
  const seen = new Set<string>();

  for (const modelId of modelIds) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);

    const directModel = directByModelId.get(modelId);
    if (directModel) {
      directModels.push(directModel);
      continue;
    }

    const modelPool = poolByModelId.get(modelId);
    if (modelPool) {
      modelPools.push(modelPool);
      continue;
    }

    throw new ORPCError("FORBIDDEN", { message: "Model is not visible to this user." });
  }

  return { directModels, modelPools };
}

export async function listVisibleModelTargetsForToken(
  token: Pick<ModelApiTokenIdentity, "id" | "userId" | "scopeMode">,
): Promise<VisibleModelTargets> {
  const visibleTargets = await listVisibleModelTargetsForUser(token.userId);

  if (token.scopeMode === "ALL_VISIBLE") {
    return visibleTargets;
  }

  const entries = await prisma.modelApiTokenAllowlistEntry.findMany({
    where: { modelApiTokenId: token.id },
    select: {
      target: true,
      discoveredModelId: true,
      ExecutionTarget: { select: { discoveredModelId: true } },
      modelPoolId: true,
    },
  });

  const allowedDirectIds = new Set(
    entries
      .filter((entry) => entry.target === "DIRECT_MODEL")
      .map((entry) => entry.ExecutionTarget?.discoveredModelId ?? entry.discoveredModelId)
      .filter((id): id is string => Boolean(id)),
  );
  const allowedPoolIds = new Set(
    entries
      .filter((entry) => entry.target === "MODEL_POOL" && entry.modelPoolId)
      .map((entry) => entry.modelPoolId),
  );

  return {
    directModels: visibleTargets.directModels.filter((model) => allowedDirectIds.has(model.id)),
    modelPools: visibleTargets.modelPools.filter((pool) => allowedPoolIds.has(pool.id)),
  };
}

export async function authenticateModelApiTokenSecret(
  rawSecret: string,
): Promise<ModelApiTokenIdentity | null> {
  if (!rawSecret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.modelApiToken)) {
    return null;
  }

  const lookupPrefix = credentialLookupPrefix(rawSecret);
  const token = await prisma.modelApiToken.findUnique({
    where: { lookupPrefix },
    select: {
      id: true,
      userId: true,
      scopeMode: true,
      lookupPrefix: true,
      secretDigest: true,
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= new Date())) {
    return null;
  }
  const owner = await prisma.user.findUnique({
    where: { id: token.userId },
    select: { banned: true, banExpires: true, deletionRequestedAt: true },
  });
  if (!owner || userCredentialAccessBlocked(owner, new Date())) return null;

  const matches = verifyForwarderHmacDigest({
    purpose: "modelApiToken",
    value: rawSecret,
    digest: token.secretDigest,
  });
  if (!matches) {
    return null;
  }

  const updated = await prisma.modelApiToken.update({
    where: { id: token.id },
    data: { lastUsedAt: new Date() },
    select: {
      id: true,
      userId: true,
      scopeMode: true,
      lookupPrefix: true,
      expiresAt: true,
      lastUsedAt: true,
    },
  });

  return {
    id: updated.id,
    userId: updated.userId,
    scopeMode: String(updated.scopeMode) as ModelApiTokenScopeMode,
    lookupPrefix: updated.lookupPrefix,
    expiresAt: updated.expiresAt,
    lastUsedAt: updated.lastUsedAt,
  };
}

export function digestModelApiTokenSecret(rawSecret: string): string {
  return hmacDigestForForwarderPurpose({
    purpose: "modelApiToken",
    value: rawSecret,
  });
}
