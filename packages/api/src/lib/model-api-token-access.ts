import { ORPCError } from "@orpc/server";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";
import {
  poolOwnerActive,
  userCredentialAccessBlocked,
} from "@ws-model-proxy/db/user-deletion-access";
import { env } from "@ws-model-proxy/env/server";
import { externalFallbackMemberWhere, poolProviderDisclosure } from "./effective-provider-egress";
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
  externalEquivalentModel?: string | null;
  ownKeyProviderModelId?: string | null;
  /**
   * Static availability for this viewer: deployment switch, pool fallback,
   * configured members, and owner or live grant with grantee coverage.
   * Plain pool names never leave the deployment.
   */
  effectiveProviderEgress: boolean;
  /** Owner-private account display names; always empty for grantees. */
  providerAccountLabels: string[];
  /** Coarse provider types only while this viewer is eligible. */
  providerTypes: string[];
  /**
   * External routes `owner/pool:external` can take for this viewer (display
   * only; the send path re-checks everything): the pool's own fallback
   * members, and for grantees their own provider key.
   */
  externalRoutes: ExternalRouteKind[];
  allowLossyDeveloperRoleCollapse: boolean;
  recommendedSurfaceOverride: ModelApiSurface | null;
};

export type ExternalRouteKind = "pool-fallback" | "own-key";

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
  /** Null uses each pool's `externalAfterWaitMs`. Capped per pool at request time. */
  externalAfterWaitMs: number | null;
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
  externalEquivalentModel: true,
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
            select: { ProviderAccount: { select: { label: true, providerType: true } } },
          },
        },
      },
    },
  },
  // Owner lifecycle (#76): a banned or deletion-marked owner's pools are
  // unavailable to every grantee.
  User: { select: { slug: true, banned: true, banExpires: true, deletionRequestedAt: true } },
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
  viewerUserId: string,
  accessGrantId: string | null = null,
): VisibleModelPoolTarget {
  const disclosure = poolProviderDisclosure({
    isOwner: row.userId === viewerUserId,
    hasLiveGrant: Boolean(accessGrantId),
    providerEgressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
    fallbackEnabled: row.fallbackEnabled,
    fallbackForGrantees: row.fallbackForGrantees,
    members: (row.PoolMembers ?? []).map((member) => ({
      tier: member.tier,
      accountLabel: member.ExecutionTarget?.ProviderModel?.ProviderAccount.label,
      providerType: member.ExecutionTarget?.ProviderModel?.ProviderAccount.providerType,
    })),
  });
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
    externalEquivalentModel: row.externalEquivalentModel,
    externalMemberCount: (row.PoolMembers ?? []).length,
    ...disclosure,
    externalRoutes: disclosure.effectiveProviderEgress ? ["pool-fallback"] : [],
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

/**
 * A grantee's saved own-key preference counts only while its provider model
 * and account are enabled, not deleted, and hold an ACTIVE credential. Every
 * surface that lists the own-key route (token preview, Chat Test, Overview)
 * filters with this.
 */
export const readyOwnKeyPreferenceWhere = {
  ProviderModel: {
    enabled: true,
    deletedAt: null,
    ProviderAccount: {
      enabled: true,
      deletedAt: null,
      CurrentCredential: { status: "ACTIVE" },
    },
  },
} satisfies Prisma.PoolFallbackPreferenceWhereInput;

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
        FallbackPreferences: {
          where: readyOwnKeyPreferenceWhere,
          select: { providerModelId: true },
        },
      },
    }),
  ]);

  const directModels = directModelRows.map(serializeDirectModel);
  const ownedPools = ownedPoolRows.map((row) => serializeModelPool(row, userId));
  // A granted pool whose owner is banned (active ban) or marked for deletion
  // is hidden: it is not listed, cannot be resolved by name, and so cannot be
  // used by any grantee (#76). The send claim re-checks the owner at the
  // E0 boundary (recheckExternalSendRequesterValidity).
  const now = new Date();
  const grantedPools = grantedPoolRows.flatMap((grant) => {
    if (!poolOwnerActive(grant.ModelPool.User, now)) return [];
    const pool = serializeModelPool(grant.ModelPool, userId, grant.id);
    const ownKeyProviderModelId = grant.FallbackPreferences?.[0]?.providerModelId ?? null;
    const ownKey = Boolean(
      env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED &&
        pool.externalEquivalentModel &&
        ownKeyProviderModelId,
    );
    return [
      {
        ...pool,
        ownKeyProviderModelId,
        effectiveProviderEgress: pool.effectiveProviderEgress || ownKey,
        externalRoutes: ownKey ? [...pool.externalRoutes, "own-key" as const] : pool.externalRoutes,
      },
    ];
  });

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
export type ExternalConsentStateDenial =
  | "TOKEN_CONSENT_WITHDRAWN"
  | "REQUESTER_NOT_VISIBLE"
  /** The requester's account is banned or marked for deletion. */
  | "REQUESTER_ACCESS_BLOCKED"
  /**
   * The pool owner's account is banned (active ban) or marked for deletion:
   * the pool is unavailable to everyone, own-key sends included (#76).
   */
  | "POOL_OWNER_INACTIVE";

/** Why an `:external` send is refused at the send boundary (lockExternalSendConsent). */
export type ExternalSendConsentDenial =
  | ExternalConsentStateDenial
  /** The pool is gone or its owner turned `fallbackEnabled` off. */
  | "POOL_PRIVATE"
  /** A grantee's request, and the owner turned `fallbackForGrantees` off. */
  | "GRANTEE_NOT_COVERED"
  | "OWN_KEY_CONSENT_WITHDRAWN";

/**
 * The identity an `:external` consent was minted for. `accessGrantId` is the
 * exact grant the request (or the stored-response binding it continues) was
 * resolved under: null for the pool owner, the grant row id for a grantee. A
 * grantee is served only while that same grant row exists; a replacement
 * grant (revoke G1, re-grant G2) is a different consent.
 */
export type ExternalConsentIdentity = {
  requesterUserId: string;
  modelApiTokenId: string | null;
  poolId: string;
  ownerUserId: string;
  accessGrantId: string | null;
  ownKeyProviderModelId?: string;
};

type ConsentReadClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "modelApiTokenAllowlistEntry" | "poolGrant"
>;

type RequesterValidityClient = Pick<Prisma.TransactionClient, "$queryRaw">;

type RequesterValidity = {
  tokenValid: boolean;
  scopeMode: string | null;
  requesterValid: boolean;
  /** The pool owner's account is not banned (active ban) and not deletion-marked (#76). */
  ownerValid: boolean;
};

/**
 * Evaluate the unlocked user snapshot and token expiry in ONE statement, with
 * that statement's database clock. Never compare an old ban expiry with the
 * time its result reaches JS: a concurrently renewed ban could then appear
 * expired even though the requester was continuously banned. Transaction
 * now() is also too old after a provider-lock wait; statement_timestamp()
 * advances for the post-lock recheck.
 *
 * The pool owner's row is evaluated by the same rule in the same statement
 * (#76): an owner whose ban is active or whose deletion is pending makes the
 * pool unavailable to every requester. Ban semantics match
 * `isUserBanned` (@ws-model-proxy/db/user-deletion-access): an expiry exactly
 * at the statement timestamp is still an active ban.
 */
async function readRequesterValidity(db: RequesterValidityClient, input: ExternalConsentIdentity) {
  const [validity] = await db.$queryRaw<RequesterValidity[]>`
    SELECT
      (t.id IS NOT NULL AND t."userId" = ${input.requesterUserId}
        AND t."revokedAt" IS NULL AND t."allowExternal" = true
        AND (t."expiresAt" IS NULL OR t."expiresAt" > statement_timestamp())) AS "tokenValid",
      t."scopeMode" AS "scopeMode",
      (u.id IS NOT NULL AND u."deletionRequestedAt" IS NULL
        AND (u.banned IS NOT TRUE
          OR (u."banExpires" IS NOT NULL AND u."banExpires" < statement_timestamp()))) AS "requesterValid",
      (o.id IS NOT NULL AND o."deletionRequestedAt" IS NULL
        AND (o.banned IS NOT TRUE
          OR (o."banExpires" IS NOT NULL AND o."banExpires" < statement_timestamp()))) AS "ownerValid"
    FROM (VALUES (1)) AS singleton(value)
    LEFT JOIN model_api_token t ON t.id = ${input.modelApiTokenId}
    LEFT JOIN "user" u ON u.id = ${input.requesterUserId}
    LEFT JOIN "user" o ON o.id = ${input.ownerUserId}`;
  return validity;
}

async function readCallerConsentRows(db: ConsentReadClient, input: ExternalConsentIdentity) {
  const [validity, allowlistEntry, grant] = await Promise.all([
    readRequesterValidity(db, input),
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
          select: { id: true, ownerUserId: true },
        }),
  ]);
  return { validity, allowlistEntry, grant };
}

/** Consume the database decision without reinterpreting it against a later clock. */
function requesterValidityDenial(
  input: ExternalConsentIdentity,
  validity: RequesterValidity | undefined,
): ExternalConsentStateDenial | null {
  if (input.modelApiTokenId && validity?.tokenValid !== true) return "TOKEN_CONSENT_WITHDRAWN";
  if (validity?.requesterValid !== true) return "REQUESTER_ACCESS_BLOCKED";
  if (validity?.ownerValid !== true) return "POOL_OWNER_INACTIVE";
  return null;
}

function callerConsentDenial(
  input: ExternalConsentIdentity,
  rows: Awaited<ReturnType<typeof readCallerConsentRows>>,
): ExternalConsentStateDenial | null {
  // A lost exact grant permanently invalidates a binding, even when
  // restorable token or pool consent has also been withdrawn.
  if (
    input.requesterUserId !== input.ownerUserId &&
    (input.accessGrantId === null ||
      rows.grant?.id !== input.accessGrantId ||
      rows.grant.ownerUserId !== input.ownerUserId)
  )
    return "REQUESTER_NOT_VISIBLE";
  const validity = requesterValidityDenial(input, rows.validity);
  if (validity) return validity;
  if (
    input.modelApiTokenId &&
    rows.validity?.scopeMode === "ALLOWLIST" &&
    (rows.allowlistEntry?.target !== "MODEL_POOL" || rows.allowlistEntry.includeExternal !== true)
  )
    return "TOKEN_CONSENT_WITHDRAWN";
  return null;
}

/**
 * Re-reads, from current database state, the caller-side conditions that an
 * `:external` consent was minted from at authentication, so provider dispatch
 * never relies on a snapshot that may be minutes old:
 *   - API token (`modelApiTokenId` non-null): the token still exists, belongs
 *     to the requester, is not revoked or expired, has `allowExternal`, and
 *     for ALLOWLIST tokens still lists this pool with `includeExternal`;
 *   - account (every requester, including Chat Test): the requester's user
 *     row exists, is not banned and has no deletion mark;
 *   - owner (#76): the pool owner's user row exists, is not banned (active
 *     ban) and has no deletion mark;
 *   - visibility (any requester that is not the pool owner, including Chat
 *     Test): the requester still holds the exact grant (`accessGrantId`) the
 *     request was resolved under, from this pool's owner.
 * Returns null when every condition still holds. The pool owner's own flags
 * (fallbackEnabled, fallbackForGrantees) are re-read by the dispatcher.
 *
 * This is an early, unlocked check. The authoritative check is
 * {@link lockExternalSendConsent} plus
 * {@link recheckExternalSendRequesterValidity}, inside the send-claim
 * transaction.
 */
export async function readExternalConsentDenial(
  input: ExternalConsentIdentity,
): Promise<ExternalConsentStateDenial | null> {
  const rows = await readCallerConsentRows(prisma, input);
  return callerConsentDenial(input, rows);
}

/**
 * E0 send boundary, part 1: validates every consent condition of an
 * `:external` send (owner's `fallbackEnabled`, `fallbackForGrantees` for a
 * grantee, the requester's exact grant, the token's `allowExternal`,
 * revocation, expiry and ALLOWLIST `includeExternal`, and the requester's
 * and the pool owner's account state) inside the caller's send-claim transaction, holding the
 * pool, grant, token and allowlist rows FOR SHARE until it commits.
 *
 * Serialization: every consent withdrawal on those rows is an UPDATE or
 * DELETE of one of them (pool flag write, pool delete, grant delete and its
 * pool/user cascades, token revoke / `allowExternal` / `includeExternal`
 * write, token and allowlist cascades from a user delete). Each conflicts
 * with FOR SHARE, so a withdrawal either commits before the lock is granted
 * (and the reads below, later READ COMMITTED statements, see it) or waits
 * until the send is claimed. A grant replacement is a DELETE of the locked
 * grant plus an INSERT of another id, so it is seen as the id mismatch.
 *
 * Two conditions are not frozen by these locks: time (token `expiresAt`, ban
 * expiry) and the requester's and the pool owner's user rows (ban, deletion
 * mark), which this transaction deliberately does not lock. Both are evaluated here as an early
 * refusal and evaluated again by {@link recheckExternalSendRequesterValidity}
 * after the last lock wait of the transaction.
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
    select: { fallbackEnabled: true, fallbackForGrantees: true, externalEquivalentModel: true },
  });
  const rows = await readCallerConsentRows(tx, input);
  const callerDenial = callerConsentDenial(input, rows);
  if (callerDenial === "REQUESTER_NOT_VISIBLE") return callerDenial;
  if (input.ownKeyProviderModelId) {
    if (callerDenial) return callerDenial;
    if (requesterIsOwner || !pool?.externalEquivalentModel) return "OWN_KEY_CONSENT_WITHDRAWN";
    // Preference writers acquire pool -> grant before the preference row.
    // Provider delete/disable takes account -> model before cascading to it;
    // the send claim locks the preference only AFTER account/model.
    return null;
  }
  if (!pool?.fallbackEnabled) return "POOL_PRIVATE";
  if (!requesterIsOwner && !pool.fallbackForGrantees) return "GRANTEE_NOT_COVERED";
  return callerDenial;
}

/**
 * E0 send boundary, part 2: the caller runs this after the last statement of
 * the send-claim transaction that can wait on a lock (the provider
 * account/credential FOR UPDATE) and before the durable claim. It re-reads
 * the token, the requester's account and the pool owner's account and
 * evaluates their validity in one SQL statement against
 * statement_timestamp(), so a token that expired, or a requester or owner
 * account that was banned or marked for deletion while the transaction waited
 * on provider locks is refused before anything is claimed or sent.
 *
 * No user-row lock: every statement after this read (the credential re-read,
 * the `lastUsedAt` write on a row this transaction already holds FOR UPDATE,
 * and commit) is non-blocking, and none of them writes a row the ban or
 * deletion-mark writers read. A mark or ban that commits after this read
 * cannot affect the claim's decision (the send was already decided under the
 * earlier state); its commit may land before or after the claim commits.
 * That is the send-level outcome a FOR SHARE lock would force, without
 * adding the `user` row to the E0 lock order. A mark that commits before this
 * read is seen (a later READ COMMITTED statement).
 */
export async function recheckExternalSendRequesterValidity(
  tx: RequesterValidityClient,
  input: ExternalConsentIdentity,
): Promise<ExternalConsentStateDenial | null> {
  const validity = await readRequesterValidity(tx, input);
  return requesterValidityDenial(input, validity);
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
      externalAfterWaitMs: true,
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

  const lastUsedAt = await touchModelApiTokenLastUsedAt(token.id, token.lastUsedAt);

  return {
    id: token.id,
    userId: token.userId,
    scopeMode: String(token.scopeMode) as ModelApiTokenScopeMode,
    allowExternal: token.allowExternal === true,
    externalAfterWaitMs: token.externalAfterWaitMs ?? null,
    lookupPrefix: token.lookupPrefix,
    expiresAt: token.expiresAt,
    lastUsedAt,
  };
}

/** `lastUsedAt` is display metadata: record it at most once per this interval. */
export const MODEL_API_TOKEN_LAST_USED_DEBOUNCE_MS = 60_000;

/**
 * Records token use without ever waiting on a row lock (L1b, #64). The E0
 * send claim holds the token row FOR SHARE while it waits on the provider
 * account (capacity-lock-order.ts, C3), and FOR SHARE conflicts with the FOR
 * NO KEY UPDATE of this write. A token that serves local traffic must never
 * queue behind provider contention, so the write is debounced (at most once
 * per MODEL_API_TOKEN_LAST_USED_DEBOUNCE_MS) and skips a locked row: a skipped
 * or debounced request leaves the previous value, and a later request records
 * it. Takes no other lock and holds nothing afterwards (autocommit).
 */
async function touchModelApiTokenLastUsedAt(
  tokenId: string,
  previous: Date | null,
): Promise<Date | null> {
  const now = new Date();
  if (previous && now.getTime() - previous.getTime() < MODEL_API_TOKEN_LAST_USED_DEBOUNCE_MS)
    return previous;
  const threshold = new Date(now.getTime() - MODEL_API_TOKEN_LAST_USED_DEBOUNCE_MS);
  const updated = await prisma.$executeRaw`
    UPDATE model_api_token SET "lastUsedAt" = ${now}
     WHERE id = (
       SELECT id FROM model_api_token
        WHERE id = ${tokenId}
          AND ("lastUsedAt" IS NULL OR "lastUsedAt" <= ${threshold})
        FOR NO KEY UPDATE SKIP LOCKED)`;
  return updated > 0 ? now : previous;
}

export function digestModelApiTokenSecret(rawSecret: string): string {
  return hmacDigestForForwarderPurpose({
    purpose: "modelApiToken",
    value: rawSecret,
  });
}
