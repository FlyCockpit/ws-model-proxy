import { ORPCError } from "@orpc/server";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";

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
};

export type VisibleModelPoolTarget = {
  target: "MODEL_POOL";
  id: string;
  modelId: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  ownerUserSlug: string;
  poolSlug: string;
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

type DirectModelRow = {
  id: string;
  userId: string;
  upstreamModelId: string;
  User: { slug: string };
  Endpoint: {
    id: string;
    slug: string;
    CliDevice: { slug: string };
  };
};

type ModelPoolRow = {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string | null;
  User: { slug: string };
};

type PoolGrantRow = {
  ModelPool: ModelPoolRow;
};

type AllowlistEntryRow = {
  target: ModelApiTokenAllowlistTarget;
  discoveredModelId: string | null;
  modelPoolId: string | null;
};

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
  };
}

function serializeModelPool(row: ModelPoolRow): VisibleModelPoolTarget {
  return {
    target: "MODEL_POOL",
    id: row.id,
    modelId: poolModelId({ userSlug: row.User.slug, poolSlug: row.slug }),
    name: row.name,
    description: row.description,
    ownerUserId: row.userId,
    ownerUserSlug: row.User.slug,
    poolSlug: row.slug,
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
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userId: true,
        upstreamModelId: true,
        User: { select: { slug: true } },
        Endpoint: {
          select: {
            id: true,
            slug: true,
            CliDevice: { select: { slug: true } },
          },
        },
      },
    }),
    prisma.modelPool.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userId: true,
        slug: true,
        name: true,
        description: true,
        User: { select: { slug: true } },
      },
    }),
    prisma.poolGrant.findMany({
      where: { granteeUserId: userId },
      orderBy: { createdAt: "desc" },
      select: {
        ModelPool: {
          select: {
            id: true,
            userId: true,
            slug: true,
            name: true,
            description: true,
            User: { select: { slug: true } },
          },
        },
      },
    }),
  ]);

  const directModels = (directModelRows as DirectModelRow[]).map(serializeDirectModel);
  const ownedPools = (ownedPoolRows as ModelPoolRow[]).map(serializeModelPool);
  const grantedPools = (grantedPoolRows as PoolGrantRow[]).map((grant) =>
    serializeModelPool(grant.ModelPool),
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

  const entries = (await prisma.modelApiTokenAllowlistEntry.findMany({
    where: { modelApiTokenId: token.id },
    select: {
      target: true,
      discoveredModelId: true,
      modelPoolId: true,
    },
  })) as AllowlistEntryRow[];

  const allowedDirectIds = new Set(
    entries
      .filter((entry) => entry.target === "DIRECT_MODEL" && entry.discoveredModelId)
      .map((entry) => entry.discoveredModelId),
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
