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
  externalFallbackMemberWhere,
} from "./effective-provider-egress";
import { parseModelApiSurface } from "./model-api-surface";
import type { ModelApiSurface } from "./surface-capabilities";

export {
  effectiveProviderEgress,
  externalFallbackMemberWhere,
  grantPoolAccessServerMessage,
  grantPoolAccessServerMessages,
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
  /** Owner allows external fallback (for `owner/pool:external` requests only). */
  fallbackEnabled: boolean;
  /** Owner pays for grantees' external fallback. */
  fallbackForGrantees: boolean;
  /** Configured external fallback (provider) members, regardless of health. */
  externalMemberCount: number;
  /**
   * True when the pool can send `:external` traffic to a provider for some
   * caller: fallback is on and at least one external member is configured.
   * Plain pool names never leave the deployment.
   */
  effectiveProviderEgress: boolean;
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
  /** Human-set consent for `owner/pool:external`; false (private only) by default. */
  allowExternal: boolean;
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
  fallbackEnabled: true,
  fallbackForGrantees: true,
  allowLossyDeveloperRoleCollapse: true,
  recommendedSurfaceOverride: true,
  PoolMembers: {
    where: externalFallbackMemberWhere,
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
    fallbackEnabled: row.fallbackEnabled,
    fallbackForGrantees: row.fallbackForGrantees,
    externalMemberCount: (row.PoolMembers ?? []).length,
    effectiveProviderEgress: effectiveProviderEgress({
      fallbackEnabled: row.fallbackEnabled,
      externalMemberCount: (row.PoolMembers ?? []).length,
    }),
    providerAccountLabels: egressProviderAccountLabels({
      fallbackEnabled: row.fallbackEnabled,
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

    if (modelId.includes(":") && poolByModelId.has(modelId.slice(0, modelId.indexOf(":")))) {
      throw new ORPCError("BAD_REQUEST", {
        message:
          "Allowlist the pool by its plain name. External access is a separate per-pool token setting.",
      });
    }

    throw new ORPCError("FORBIDDEN", { message: "Model is not visible to this user." });
  }

  return { directModels, modelPools };
}

/**
 * Pools for which this token consents to `owner/pool:external`. ALL_VISIBLE
 * tokens are all-or-nothing (`allowExternal`); ALLOWLIST tokens additionally
 * need the pool entry's `includeExternal`. This is only the token's consent:
 * the deployment switch and the owner's pool settings are separate gates.
 */
export type TokenExternalPermission = ReadonlySet<string>;

export async function listVisibleModelTargetsWithExternalPermissionForToken(
  token: Pick<ModelApiTokenIdentity, "id" | "userId" | "scopeMode" | "allowExternal">,
): Promise<{ targets: VisibleModelTargets; externalPoolIds: TokenExternalPermission }> {
  const visibleTargets = await listVisibleModelTargetsForUser(token.userId);

  if (token.scopeMode === "ALL_VISIBLE") {
    return {
      targets: visibleTargets,
      externalPoolIds: new Set(
        token.allowExternal === true ? visibleTargets.modelPools.map((pool) => pool.id) : [],
      ),
    };
  }

  const entries = await prisma.modelApiTokenAllowlistEntry.findMany({
    where: { modelApiTokenId: token.id },
    select: {
      target: true,
      discoveredModelId: true,
      ExecutionTarget: { select: { discoveredModelId: true } },
      modelPoolId: true,
      includeExternal: true,
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

  const modelPools = visibleTargets.modelPools.filter((pool) => allowedPoolIds.has(pool.id));
  const externalEntryPoolIds = new Set(
    entries.flatMap((entry) =>
      entry.target === "MODEL_POOL" && entry.modelPoolId && entry.includeExternal === true
        ? [entry.modelPoolId]
        : [],
    ),
  );
  return {
    targets: {
      directModels: visibleTargets.directModels.filter((model) => allowedDirectIds.has(model.id)),
      modelPools,
    },
    externalPoolIds: new Set(
      token.allowExternal === true
        ? modelPools.filter((pool) => externalEntryPoolIds.has(pool.id)).map((pool) => pool.id)
        : [],
    ),
  };
}

/** Why a caller's `:external` consent no longer holds (see readExternalConsentDenial). */
export type ExternalConsentStateDenial = "TOKEN_CONSENT_WITHDRAWN" | "REQUESTER_NOT_VISIBLE";

/** Why an `:external` send is refused at the send boundary (lockExternalSendConsent). */
export type ExternalSendConsentDenial =
  | ExternalConsentStateDenial
  /** The pool is gone or its owner turned `fallbackEnabled` off. */
  | "POOL_PRIVATE"
  /** A grantee's request, and the owner turned `fallbackForGrantees` off. */
  | "GRANTEE_NOT_COVERED";

type ExternalConsentIdentity = {
  requesterUserId: string;
  modelApiTokenId: string | null;
  poolId: string;
  ownerUserId: string;
  now?: Date;
};

type ConsentReadClient = Pick<
  Prisma.TransactionClient,
  "modelApiToken" | "modelApiTokenAllowlistEntry" | "poolGrant"
>;

async function readCallerConsentRows(db: ConsentReadClient, input: ExternalConsentIdentity) {
  return Promise.all([
    input.modelApiTokenId
      ? db.modelApiToken.findUnique({
          where: { id: input.modelApiTokenId },
          select: {
            userId: true,
            scopeMode: true,
            allowExternal: true,
            revokedAt: true,
            expiresAt: true,
          },
        })
      : null,
    input.modelApiTokenId
      ? db.modelApiTokenAllowlistEntry.findUnique({
          where: {
            modelApiTokenId_modelPoolId: {
              modelApiTokenId: input.modelApiTokenId,
              modelPoolId: input.poolId,
            },
          },
          select: { target: true, includeExternal: true },
        })
      : null,
    input.requesterUserId === input.ownerUserId
      ? null
      : db.poolGrant.findUnique({
          where: {
            poolId_granteeUserId: { poolId: input.poolId, granteeUserId: input.requesterUserId },
          },
          select: { ownerUserId: true },
        }),
  ]);
}

function callerConsentDenial(
  input: ExternalConsentIdentity,
  [token, allowlistEntry, grant]: Awaited<ReturnType<typeof readCallerConsentRows>>,
): ExternalConsentStateDenial | null {
  const now = input.now ?? new Date();
  if (input.modelApiTokenId) {
    if (
      !token ||
      token.userId !== input.requesterUserId ||
      token.revokedAt ||
      (token.expiresAt && token.expiresAt <= now) ||
      token.allowExternal !== true
    )
      return "TOKEN_CONSENT_WITHDRAWN";
    if (
      String(token.scopeMode) === "ALLOWLIST" &&
      (allowlistEntry?.target !== "MODEL_POOL" || allowlistEntry.includeExternal !== true)
    )
      return "TOKEN_CONSENT_WITHDRAWN";
  }
  if (input.requesterUserId !== input.ownerUserId && grant?.ownerUserId !== input.ownerUserId)
    return "REQUESTER_NOT_VISIBLE";
  return null;
}

/**
 * Re-reads, from current database state, the caller-side conditions that an
 * `:external` consent was minted from at authentication, so provider dispatch
 * never relies on a snapshot that may be minutes old:
 *   - API token (`modelApiTokenId` non-null): the token still exists, belongs
 *     to the requester, is not revoked or expired, has `allowExternal`, and
 *     for ALLOWLIST tokens still lists this pool with `includeExternal`;
 *   - visibility (any requester that is not the pool owner, including Chat
 *     Test): the requester still holds a grant for this pool from its owner,
 *     the same owner-or-grant rule `listVisibleModelTargetsForUser` applies.
 * Returns null when every condition still holds. The pool owner's own flags
 * (fallbackEnabled, fallbackForGrantees) are re-read by the dispatcher.
 *
 * This is an early, unlocked check. The authoritative check is
 * {@link lockExternalSendConsent}, inside the send-claim transaction.
 */
export async function readExternalConsentDenial(
  input: ExternalConsentIdentity,
): Promise<ExternalConsentStateDenial | null> {
  return callerConsentDenial(input, await readCallerConsentRows(prisma, input));
}

/**
 * E0 send boundary: validates every consent condition of an `:external` send
 * (owner's `fallbackEnabled`, `fallbackForGrantees` for a grantee, the
 * requester's grant, and the token's `allowExternal`, revocation, expiry and
 * ALLOWLIST `includeExternal`) inside the caller's send-claim transaction,
 * holding the rows those conditions live on FOR SHARE until it commits.
 *
 * Serialization: every consent withdrawal is an UPDATE or DELETE of one of
 * these rows (pool flag write, pool delete, grant delete and its pool/user
 * cascades, token revoke / `allowExternal` / `includeExternal` write, token
 * and allowlist cascades from a user delete). Each conflicts with FOR SHARE,
 * so a withdrawal either commits before the lock is granted (and the reads
 * below, later READ COMMITTED statements, see it) or waits until the send is
 * claimed. Nothing is sent after a withdrawal that committed first.
 *
 * Lock order (documented in packages/db/src/capacity-lock-order.ts, "E0
 * send-claim transaction"): `model_pool` -> `pool_grant` -> `model_api_token`
 * -> `model_api_token_allowlist_entry`, all FOR SHARE, and then the caller's
 * `provider_account` -> `provider_credential` FOR UPDATE. The transaction
 * holds no lock before this call and takes no capacity lock at all.
 */
export async function lockExternalSendConsent(
  tx: Prisma.TransactionClient,
  input: ExternalConsentIdentity,
): Promise<ExternalSendConsentDenial | null> {
  const requesterIsOwner = input.requesterUserId === input.ownerUserId;
  await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${input.poolId} AND "userId" = ${input.ownerUserId} FOR SHARE`;
  if (!requesterIsOwner)
    await tx.$queryRaw`SELECT id FROM pool_grant WHERE "poolId" = ${input.poolId} AND "granteeUserId" = ${input.requesterUserId} FOR SHARE`;
  if (input.modelApiTokenId) {
    await tx.$queryRaw`SELECT id FROM model_api_token WHERE id = ${input.modelApiTokenId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM model_api_token_allowlist_entry WHERE "modelApiTokenId" = ${input.modelApiTokenId} AND "modelPoolId" = ${input.poolId} FOR SHARE`;
  }
  const pool = await tx.modelPool.findFirst({
    where: { id: input.poolId, userId: input.ownerUserId },
    select: { fallbackEnabled: true, fallbackForGrantees: true },
  });
  if (!pool?.fallbackEnabled) return "POOL_PRIVATE";
  if (!requesterIsOwner && !pool.fallbackForGrantees) return "GRANTEE_NOT_COVERED";
  return callerConsentDenial(input, await readCallerConsentRows(tx, input));
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
      allowExternal: true,
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
      allowExternal: true,
      lookupPrefix: true,
      expiresAt: true,
      lastUsedAt: true,
    },
  });

  return {
    id: updated.id,
    userId: updated.userId,
    scopeMode: String(updated.scopeMode) as ModelApiTokenScopeMode,
    allowExternal: updated.allowExternal === true,
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
