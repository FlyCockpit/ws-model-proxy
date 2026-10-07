/**
 * Callable-ID resolution for the model API (spec §8.3: "target resolution moves to a new
 * resolve.ts"; lane B1 owns it). Everything the request path reads from the graph before it
 * admits a request lives here: API-key authentication, the pools and TEST targets a caller may
 * name, and the per-request route rows (pool member × execution target, with the instance,
 * served model and pool policy each route needs).
 *
 * Nouns: a pool route is one LOCAL member served by one instance (capacityId = instance id);
 * health is per execution target, weight and state per member. A TEST target is a person's or
 * agent's own served model, named `runtime:<runtimeId>:<upstreamModelId>` (D1), reachable only
 * from a session or an agent test, never with an API key. `/v1` with an API key is pools only.
 *
 * Reads only, no locks (writer class: none). The send boundary re-checks access under its own
 * locks (local-send.ts, public-overflow.ts).
 */
import { timingSafeEqual } from "node:crypto";
import type {
  PoolRouteRow,
  TargetFailureClass,
  TargetHealthStatus,
} from "@ws-model-proxy/api/lib/pool-routing";
import { type RequestCompat, storedRequestCompat } from "@ws-model-proxy/api/lib/request-compat";
import {
  POOL_ADVANCED_COLUMNS,
  POOL_ADVANCED_OVERRIDES,
} from "@ws-model-proxy/config/pool-defaults";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  credentialDigest,
  credentialLookupPrefix,
  PRODUCT_CREDENTIAL_PREFIXES,
} from "@ws-model-proxy/db/node-security";
import {
  poolOwnerActive,
  userCredentialAccessBlocked,
} from "@ws-model-proxy/db/user-deletion-access";
import { effectiveInstanceConcurrency } from "./capacity/instance-limits.js";

// ── Callers ──

export type ApiKeyScopeMode = "ALL_POOLS" | "SELECTED_POOLS";

/** A verified API key (was ModelApiTokenIdentity). */
export type ApiKeyIdentity = {
  id: string;
  userId: string;
  scope: ApiKeyScopeMode;
  lookupPrefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies an API key secret: lookup prefix, purpose HMAC digest (timing-safe), not revoked,
 * not expired, owner neither banned nor being deleted. Null for anything else.
 */
export async function authenticateApiKey(
  secret: string,
  now = new Date(),
): Promise<ApiKeyIdentity | null> {
  if (!secret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.apiKey)) return null;
  const row = await prisma.apiKey.findUnique({
    where: { lookupPrefix: credentialLookupPrefix(secret) },
    select: {
      id: true,
      userId: true,
      scope: true,
      lookupPrefix: true,
      secretDigest: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
    },
  });
  if (!row || row.revokedAt) return null;
  if (!sameDigest(row.secretDigest, credentialDigest("apiKey", secret))) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  if (userCredentialAccessBlocked(row.User, now)) return null;
  return {
    id: row.id,
    userId: row.userId,
    scope: row.scope,
    lookupPrefix: row.lookupPrefix,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
  };
}

// ── Callable targets ──

export type FallbackModeValue = "OFF" | "OWNER" | "OWNER_AND_SHARES";
export type ModelApiSurfaceValue =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages";

/** A pool the caller may name as `owner/pool` (was VisibleModelPoolTarget). */
export type CallablePool = {
  target: "POOL";
  id: string;
  /** The callable ID `owner-slug/pool-slug`. */
  modelId: string;
  name: string;
  description: string | null;
  modelType: "LLM" | "EMBEDDINGS" | "TRANSCRIPTION";
  ownerUserId: string;
  ownerUserSlug: string;
  poolSlug: string;
  /** The share the caller reaches the pool through; null for the owner. */
  shareId: string | null;
  maxAttachmentBytes: number | null;
  optimisticBasicTranscription: boolean;
  protocolAdaptationEnabled: boolean;
  allowLossyDeveloperRoleCollapse: boolean;
  recommendedSurfaceOverride: ModelApiSurfaceValue | null;
  /** Who may make this pool spend cloud money (callers still opt in with `:external`). */
  fallbackMode: FallbackModeValue;
  /** CLOUD members configured, regardless of health. */
  externalMemberCount: number;
  /** Own-key consent: the OpenRouter model share holders may use with their own key. */
  externalEquivalentModel: string | null;
  embeddingContract: Prisma.JsonValue | null;
  paidWarmProtection: boolean;
  /** The share holder's own provider model (only while the owner consents). */
  ownKeyProviderModelId: string | null;
};

/** A served model the caller may test directly (D1; was VisibleDirectModelTarget). */
export type TestTarget = {
  target: "TEST";
  /** RuntimeModel id. */
  id: string;
  /** `runtime:<runtimeId>:<upstreamModelId>`. */
  modelId: string;
  runtimeId: string;
  upstreamModelId: string;
  ownerUserId: string;
  ownerUserSlug: string;
  maxAttachmentBytes: number | null;
};

export type CallableTargets = { pools: CallablePool[]; tests: TestTarget[] };

export function testTargetModelId(runtimeId: string, upstreamModelId: string): string {
  return `runtime:${runtimeId}:${upstreamModelId}`;
}

const POOL_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  modelType: true,
  userId: true,
  User: { select: { slug: true, banned: true, banExpires: true, deletionRequestedAt: true } },
  Fallback: true,
  Advanced: true,
  _count: { select: { Members: { where: { kind: "CLOUD" as const } } } },
} satisfies Prisma.PoolSelect;
type PoolSelected = Prisma.PoolGetPayload<{ select: typeof POOL_SELECT }>;

function overridesOf(advanced: { overrides: Prisma.JsonValue } | null): Record<string, unknown> {
  const value = advanced?.overrides;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function overrideGroup(overrides: Record<string, unknown>, key: string): Record<string, unknown> {
  const group = overrides[key];
  return group && typeof group === "object" && !Array.isArray(group)
    ? (group as Record<string, unknown>)
    : {};
}

function boolSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function intSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function callablePool(
  pool: PoolSelected,
  share: { id: string; ownKeyProviderModelId: string | null } | null,
): CallablePool {
  const overrides = overridesOf(pool.Advanced);
  const surface = overrides.recommendedSurface;
  const maxAttachmentBytes = overrides.maxAttachmentBytes;
  const equivalent = pool.Fallback?.ownKeyEquivalentModel ?? null;
  return {
    target: "POOL",
    id: pool.id,
    modelId: `${pool.User.slug}/${pool.slug}`,
    name: pool.name,
    description: pool.description,
    modelType: pool.modelType,
    ownerUserId: pool.userId,
    ownerUserSlug: pool.User.slug,
    poolSlug: pool.slug,
    shareId: share?.id ?? null,
    maxAttachmentBytes: typeof maxAttachmentBytes === "number" ? maxAttachmentBytes : null,
    optimisticBasicTranscription: boolSetting(
      overrides.optimisticBasicTranscription,
      POOL_ADVANCED_OVERRIDES.optimisticBasicTranscription.auto.default,
    ),
    protocolAdaptationEnabled: boolSetting(
      overrides.protocolAdaptation,
      POOL_ADVANCED_OVERRIDES.protocolAdaptation.auto.default,
    ),
    allowLossyDeveloperRoleCollapse: boolSetting(
      overrides.allowLossyDeveloperRoleCollapse,
      POOL_ADVANCED_OVERRIDES.allowLossyDeveloperRoleCollapse.auto.default,
    ),
    recommendedSurfaceOverride:
      surface === "openai_chat_completions" ||
      surface === "openai_responses" ||
      surface === "anthropic_messages"
        ? surface
        : null,
    fallbackMode: pool.Fallback?.mode ?? "OFF",
    externalMemberCount: pool._count.Members,
    externalEquivalentModel: equivalent,
    embeddingContract: pool.Fallback?.embeddingContract ?? null,
    paidWarmProtection: pool.Fallback?.paidWarmProtection ?? false,
    ownKeyProviderModelId: equivalent && share ? share.ownKeyProviderModelId : null,
  };
}

/** Pools the user owns or holds a can-use share of (owner active), plus own TEST targets. */
export async function listCallableTargetsForUser(
  userId: string,
  now = new Date(),
): Promise<CallableTargets> {
  const [owned, shares, models] = await Promise.all([
    prisma.pool.findMany({ where: { userId }, select: POOL_SELECT, orderBy: { slug: "asc" } }),
    prisma.share.findMany({
      where: { granteeUserId: userId, canUse: true },
      select: { id: true, ownKeyProviderModelId: true, Pool: { select: POOL_SELECT } },
    }),
    prisma.runtimeModel.findMany({
      where: { userId, retired: false },
      select: {
        id: true,
        runtimeId: true,
        upstreamModelId: true,
        userId: true,
        Runtime: { select: { User: { select: { slug: true } } } },
      },
      orderBy: [{ runtimeId: "asc" }, { upstreamModelId: "asc" }],
    }),
  ]);
  const pools = [
    ...owned.map((pool) => callablePool(pool, null)),
    ...shares
      .filter((share) => poolOwnerActive(share.Pool.User, now))
      .map((share) => callablePool(share.Pool, share)),
  ];
  const tests: TestTarget[] = models.map((model) => ({
    target: "TEST",
    id: model.id,
    modelId: testTargetModelId(model.runtimeId, model.upstreamModelId),
    runtimeId: model.runtimeId,
    upstreamModelId: model.upstreamModelId,
    ownerUserId: model.userId,
    ownerUserSlug: model.Runtime.User.slug,
    maxAttachmentBytes: null,
  }));
  return { pools, tests };
}

/** An API key reaches pools only (ALL_POOLS: every callable pool; SELECTED_POOLS: its list). */
export async function listCallableTargetsForApiKey(
  key: ApiKeyIdentity,
  now = new Date(),
): Promise<CallableTargets> {
  const all = await listCallableTargetsForUser(key.userId, now);
  if (key.scope === "ALL_POOLS") return { pools: all.pools, tests: [] };
  const selected = new Set(
    (
      await prisma.apiKeyPool.findMany({ where: { apiKeyId: key.id }, select: { poolId: true } })
    ).map((row) => row.poolId),
  );
  return { pools: all.pools.filter((pool) => selected.has(pool.id)), tests: [] };
}

// ── Route rows ──

/** The instance a route runs on, with the limits admission and context checks read. */
export type RouteInstance = {
  /** capacityId. */
  id: string;
  handle: string;
  runtimeId: string;
  versionId: string;
  launchHash: string;
  /** The head node requests are relayed to. */
  nodeId: string | null;
  nodeOnline: boolean;
  ready: boolean;
  engine: EngineValue | null;
  /** Effective physical concurrency (version override, observed slots, engine default). */
  hardConcurrencyLimit: number | null;
  /** Physical context: the version's limit, else the observed max model length. */
  physicalMaxContext: number | null;
  kvBudgetTokens: number | null;
  engineCountContext: EngineCountContextValue | null;
  countStrategy: CountStrategyValue;
  imageTokenAllowance: number | null;
  /** Physical KV-cache incarnation (cache-affinity generations key on it). */
  cacheGeneration: string;
  /** The version's request compatibility setting ({} = automatic). */
  requestCompat: RequestCompat;
  // ── runtime identity (context counters, calibration, cache-affinity identity) ──
  /** The launch hash: equal hashes run the same command line. */
  runtimeIdentityKey: string;
  runtimeModel: string;
  runtimeRevision: string;
  tokenizer: string | null;
  tokenizerVersion: string | null;
  template: string | null;
  templateVersion: string | null;
  cacheNamespace: string;
};

export type EngineValue = "VLLM" | "SGLANG" | "LLAMA_CPP" | "OLLAMA" | "LM_STUDIO" | "OTHER";

export type EngineCountContextValue =
  | "UNSUPPORTED"
  | "VLLM_TOKENIZE"
  | "TGI_CHAT_TOKENIZE"
  | "LLAMA_APPLY_TEMPLATE"
  | "LLAMA_INPUT_TOKENS"
  | "READER_COUNT";

export type CountStrategyValue =
  | "TOKENIZER"
  | "TEMPLATE_AWARE"
  | "ENGINE_REPORTED"
  | "CONSERVATIVE_ESTIMATE"
  | "CALIBRATED_ESTIMATE";

const COUNT_STRATEGIES: Record<string, CountStrategyValue> = {
  tokenizer: "TOKENIZER",
  template_aware: "TEMPLATE_AWARE",
  engine_reported: "ENGINE_REPORTED",
  conservative_estimate: "CONSERVATIVE_ESTIMATE",
  calibrated_estimate: "CALIBRATED_ESTIMATE",
};

export type RouteServedModel = {
  /** RuntimeModel id. */
  id: string;
  userId: string;
  upstreamModelId: string;
  /** Effective capabilities (override when set, else detected). */
  capabilities: string[];
  transcriptionProfile: Prisma.JsonValue | null;
  embeddingContract: Prisma.JsonValue | null;
};

export type RouteTarget = {
  id: string;
  health: TargetHealthStatus;
  lastFailureClass: TargetFailureClass | null;
  consecutiveRetryableFailures: number;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  halfOpenTrialStartedAt: Date | null;
  lastRoutedAt: Date | null;
};

/** The pool settings the request path reads (registry defaults applied). */
export type RoutePoolPolicy = {
  id: string;
  userId: string;
  /** The one max wait (pool_advanced.maxWaitMs). */
  maxWaitMs: number;
  contextCeiling: number | null;
  contextMargin: number;
  fallbackMode: FallbackModeValue;
  paidWarmProtection: boolean;
  embeddingContract: Prisma.JsonValue | null;
  protection: {
    enabled: boolean;
    evictionFeedback: boolean;
    windowSeconds: number;
    minTokens: number;
    share: "EQUAL_SHARE" | "FIRST_COME" | "FIXED_PERCENT";
    fixedPercent: number | null;
  };
  affinity: {
    enabled: boolean;
    ttlSeconds: number;
    maxRecords: number;
    prefixWeight: number;
    conversationWeight: number;
    confirmedCacheWeight: number;
    loadPenaltyWeight: number;
    residencyWeight: number;
  };
};

/** One LOCAL member of a pool served by one instance. */
export type PoolRoute = {
  member: { id: string; poolId: string; shareId: string | null; weight: number; active: boolean };
  target: RouteTarget;
  instance: RouteInstance;
  model: RouteServedModel;
  pool: RoutePoolPolicy;
};

/** A TEST route: one instance serving the caller's own served model. */
export type TestRoute = {
  target: RouteTarget;
  instance: RouteInstance;
  model: RouteServedModel;
};

const PROTECTION_SHARES = {
  equal_share: "EQUAL_SHARE",
  first_come: "FIRST_COME",
  fixed_percent: "FIXED_PERCENT",
} as const;

export function poolPolicy(pool: {
  id: string;
  userId: string;
  Fallback: {
    mode: FallbackModeValue;
    paidWarmProtection: boolean;
    embeddingContract: Prisma.JsonValue | null;
  } | null;
  Advanced: {
    maxWaitMs: number | null;
    contextCeiling: number | null;
    contextMargin: number | null;
    overrides: Prisma.JsonValue;
  } | null;
}): RoutePoolPolicy {
  const overrides = overridesOf(pool.Advanced);
  const protection = overrideGroup(overrides, "protection");
  const affinity = overrideGroup(overrides, "affinity");
  const P = POOL_ADVANCED_OVERRIDES.protection;
  const A = POOL_ADVANCED_OVERRIDES.affinity;
  const share = protection.share;
  return {
    id: pool.id,
    userId: pool.userId,
    maxWaitMs: pool.Advanced?.maxWaitMs ?? POOL_ADVANCED_COLUMNS.maxWaitMs.auto.default,
    contextCeiling: pool.Advanced?.contextCeiling ?? null,
    contextMargin: pool.Advanced?.contextMargin ?? POOL_ADVANCED_COLUMNS.contextMargin.auto.default,
    fallbackMode: pool.Fallback?.mode ?? "OFF",
    paidWarmProtection: pool.Fallback?.paidWarmProtection ?? false,
    embeddingContract: pool.Fallback?.embeddingContract ?? null,
    protection: {
      enabled: boolSetting(protection.enabled, P.enabled.auto.default),
      evictionFeedback: boolSetting(protection.evictionFeedback, P.evictionFeedback.auto.default),
      windowSeconds: intSetting(protection.windowSeconds, P.windowSeconds.auto.default),
      minTokens: intSetting(protection.minTokens, P.minTokens.auto.default),
      share:
        share === "equal_share" || share === "first_come" || share === "fixed_percent"
          ? PROTECTION_SHARES[share]
          : PROTECTION_SHARES[P.share.auto.default],
      fixedPercent:
        share === "fixed_percent"
          ? intSetting(protection.fixedPercent, P.fixedPercent.auto.default)
          : null,
    },
    affinity: {
      enabled: boolSetting(affinity.enabled, A.enabled.auto.default),
      ttlSeconds: intSetting(affinity.ttlSeconds, A.ttlSeconds.auto.default),
      maxRecords: intSetting(affinity.maxRecords, A.maxRecords.auto.default),
      prefixWeight: intSetting(affinity.prefixWeight, A.prefixWeight.auto.default),
      conversationWeight: intSetting(
        affinity.conversationWeight,
        A.conversationWeight.auto.default,
      ),
      confirmedCacheWeight: intSetting(
        affinity.confirmedCacheWeight,
        A.confirmedCacheWeight.auto.default,
      ),
      loadPenaltyWeight: intSetting(affinity.loadPenaltyWeight, A.loadPenaltyWeight.auto.default),
      residencyWeight: intSetting(affinity.residencyWeight, A.residencyWeight.auto.default),
    },
  };
}

const TARGET_SELECT = {
  id: true,
  health: true,
  lastFailureClass: true,
  consecutiveRetryableFailures: true,
  lastFailureAt: true,
  nextRetryAt: true,
  halfOpenTrialStartedAt: true,
  lastRoutedAt: true,
  Instance: {
    select: {
      id: true,
      handle: true,
      runtimeId: true,
      versionId: true,
      phase: true,
      cacheGeneration: true,
      engineSlots: true,
      maxModelLen: true,
      countContext: true,
      observedKvBudgetTokens: true,
      Version: {
        select: {
          engine: true,
          concurrencyLimit: true,
          contextLimit: true,
          kvBudgetTokens: true,
          launchHash: true,
          advanced: true,
          compat: true,
        },
      },
      Runtime: {
        select: { kind: true, nodeId: true, Node: { select: { id: true, connection: true } } },
      },
      Ranks: {
        where: { rank: 0 },
        select: { nodeId: true, Node: { select: { connection: true } } },
      },
    },
  },
  RuntimeModel: {
    select: {
      id: true,
      userId: true,
      upstreamModelId: true,
      detectedCapabilities: true,
      capabilities: true,
      capabilitiesOverridden: true,
      transcriptionProfile: true,
      embeddingContract: true,
      Runtime: {
        select: { User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } } },
      },
    },
  },
} satisfies Prisma.ExecutionTargetSelect;
type TargetSelected = Prisma.ExecutionTargetGetPayload<{ select: typeof TARGET_SELECT }>;

function advancedNumber(advanced: Prisma.JsonValue, key: string): number | null {
  if (!advanced || typeof advanced !== "object" || Array.isArray(advanced)) return null;
  const value = (advanced as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

function advancedString(advanced: Prisma.JsonValue, key: string): string | null {
  if (!advanced || typeof advanced !== "object" || Array.isArray(advanced)) return null;
  const value = (advanced as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function routeParts(row: TargetSelected, now: Date): TestRoute | null {
  const instance = row.Instance;
  const model = row.RuntimeModel;
  if (!instance || !model) return null;
  if (userCredentialAccessBlocked(model.Runtime.User, now)) return null;
  const alwaysOn = instance.Runtime.kind === "ALWAYS_ON";
  const rank0 = instance.Ranks[0];
  const nodeId = alwaysOn ? instance.Runtime.nodeId : (rank0?.nodeId ?? null);
  const nodeOnline = alwaysOn
    ? instance.Runtime.Node?.connection === "ONLINE"
    : rank0?.Node?.connection === "ONLINE";
  const version = instance.Version;
  return {
    target: {
      id: row.id,
      health: row.health,
      lastFailureClass: row.lastFailureClass,
      consecutiveRetryableFailures: row.consecutiveRetryableFailures,
      lastFailureAt: row.lastFailureAt,
      nextRetryAt: row.nextRetryAt,
      halfOpenTrialStartedAt: row.halfOpenTrialStartedAt,
      lastRoutedAt: row.lastRoutedAt,
    },
    instance: {
      id: instance.id,
      handle: instance.handle,
      runtimeId: instance.runtimeId,
      versionId: instance.versionId,
      launchHash: version.launchHash,
      nodeId,
      nodeOnline,
      ready: instance.phase === "READY",
      engine: version.engine,
      hardConcurrencyLimit: effectiveInstanceConcurrency({
        override: version.concurrencyLimit,
        engineSlots: instance.engineSlots,
        engine: version.engine,
      }),
      physicalMaxContext: version.contextLimit ?? instance.maxModelLen,
      kvBudgetTokens: version.kvBudgetTokens ?? instance.observedKvBudgetTokens,
      engineCountContext: instance.countContext,
      countStrategy:
        COUNT_STRATEGIES[advancedString(version.advanced, "countStrategy") ?? ""] ??
        "CONSERVATIVE_ESTIMATE",
      imageTokenAllowance: advancedNumber(version.advanced, "imageTokenAllowance"),
      cacheGeneration: instance.cacheGeneration,
      requestCompat: storedRequestCompat(version.compat),
      runtimeIdentityKey: version.launchHash,
      runtimeModel: model.upstreamModelId,
      runtimeRevision: instance.versionId,
      tokenizer: null,
      tokenizerVersion: null,
      template: null,
      templateVersion: null,
      cacheNamespace: instance.id,
    },
    model: {
      id: model.id,
      userId: model.userId,
      upstreamModelId: model.upstreamModelId,
      capabilities: model.capabilitiesOverridden ? model.capabilities : model.detectedCapabilities,
      transcriptionProfile: model.transcriptionProfile,
      embeddingContract: model.embeddingContract,
    },
  };
}

/**
 * Every LOCAL route of a pool: each member's served model on each instance that serves it.
 * Contributed members count only while their share still allows contributing, the served model
 * belongs to the share's grantee, and the grantee's account is active.
 */
export async function poolRoutes(poolId: string, now = new Date()): Promise<PoolRoute[]> {
  const pool = await prisma.pool.findUnique({
    where: { id: poolId },
    select: {
      id: true,
      userId: true,
      Fallback: { select: { mode: true, paidWarmProtection: true, embeddingContract: true } },
      Advanced: {
        select: { maxWaitMs: true, contextCeiling: true, contextMargin: true, overrides: true },
      },
      Members: {
        where: { kind: "LOCAL", runtimeModelId: { not: null } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          poolId: true,
          shareId: true,
          weight: true,
          state: true,
          runtimeModelId: true,
          Share: { select: { canContribute: true, granteeUserId: true } },
        },
      },
    },
  });
  if (!pool) return [];
  const policy = poolPolicy(pool);
  const modelIds = pool.Members.flatMap((member) =>
    member.runtimeModelId ? [member.runtimeModelId] : [],
  );
  if (modelIds.length === 0) return [];
  const targets = await prisma.executionTarget.findMany({
    where: { kind: "INSTANCE_MODEL", runtimeModelId: { in: modelIds } },
    orderBy: { id: "asc" },
    select: TARGET_SELECT,
  });
  const routes: PoolRoute[] = [];
  for (const member of pool.Members) {
    if (member.shareId && (!member.Share?.canContribute || !member.Share.granteeUserId)) continue;
    for (const row of targets) {
      if (row.RuntimeModel?.id !== member.runtimeModelId) continue;
      const parts = routeParts(row, now);
      if (!parts) continue;
      const expectedOwner = member.shareId ? member.Share?.granteeUserId : pool.userId;
      if (parts.model.userId !== expectedOwner) continue;
      routes.push({
        member: {
          id: member.id,
          poolId: member.poolId,
          shareId: member.shareId,
          weight: member.weight,
          active: member.state === "ACTIVE",
        },
        ...parts,
        pool: policy,
      });
    }
  }
  return routes;
}

/** The TEST routes of one of the caller's own served models (every instance serving it). */
export async function testRoutes(
  runtimeModelId: string,
  ownerUserId: string,
  now = new Date(),
): Promise<TestRoute[]> {
  const targets = await prisma.executionTarget.findMany({
    where: { kind: "INSTANCE_MODEL", runtimeModelId, userId: ownerUserId },
    orderBy: { id: "asc" },
    select: TARGET_SELECT,
  });
  return targets.flatMap((row) => {
    const parts = routeParts(row, now);
    return parts ? [parts] : [];
  });
}

/** The routing view of a pool route for @ws-model-proxy/api/lib/pool-routing. */
export function poolRouteRow(route: PoolRoute): PoolRouteRow {
  return {
    poolMemberId: route.member.id,
    poolId: route.member.poolId,
    runtimeModelId: route.model.id,
    upstreamModelId: route.model.upstreamModelId,
    executionTargetId: route.target.id,
    instanceId: route.instance.id,
    instanceHandle: route.instance.handle,
    nodeId: route.instance.nodeId,
    instanceReady: route.instance.ready,
    nodeOnline: route.instance.nodeOnline,
    memberActive: route.member.active,
    weight: route.member.weight,
    health: route.target.health,
    lastFailureClass: route.target.lastFailureClass,
    consecutiveRetryableFailures: route.target.consecutiveRetryableFailures,
    lastFailureAt: route.target.lastFailureAt,
    nextRetryAt: route.target.nextRetryAt,
    halfOpenTrialStartedAt: route.target.halfOpenTrialStartedAt,
  };
}
