import { randomUUID } from "node:crypto";
import prisma from "@ws-model-proxy/db";
import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";
import {
  asJson,
  canonicalizeAffinitySurface,
  extractAffinityLayers,
  type JsonValue,
} from "./cache-affinity-layers.js";

const DIGEST_VERSION = 4;
const MAX_PREFIXES_PER_REQUEST = 64;
const MAX_INSTRUCTION_PREFIXES = 8;
const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;

export type AffinityPolicy = {
  enabled: boolean;
  ttlSeconds: number;
  maxRecords: number;
  prefixWeight: number;
  conversationWeight: number;
  confirmedCacheWeight: number;
  loadPenaltyWeight: number;
};

export type AffinityTarget = {
  poolMemberId: string;
  executionTargetId: string;
  targetIdentity: string;
  capacityId: string;
  hardConcurrencyLimit: number | null;
  healthPenalty: number;
  publicEgressPenalty: number;
  costPenalty: number;
  /** Precomputed load for targets that do not use the local capacity tables. */
  activeLoad?: number;
  waitingLoad?: number;
};

export type AffinityDecision = {
  orderedTargetIds: string[];
  scores: Record<string, number>;
  prefixDepths: Record<string, number>;
  instructionDepths?: Record<string, number>;
  conversationMatches: Record<string, boolean>;
  reasons: Record<string, string>;
  matchedPrefixDepth: number;
  /**
   * Estimated size, in tokens, of the matched warm prefix per target: the
   * `estimatedTokens` of the deepest matching prefix record (the conversation
   * record's when the hit is conversation-only). Absent = unknown. Counts
   * only; used to size the cache-holder wait (saturation S-A).
   */
  prefixTokens?: Record<string, number>;
  /**
   * The warm session this request continues, per target (S-C): see
   * `continuedSessionKey`. Absent = a new session on that target.
   */
  matchedSessionIds?: Record<string, string>;
};

/** Durable internal Responses binding; the digest binds caller, pool, grant and runtime. */
export type AffinitySessionBinding = { sessionId: string; bindingDigest: string };

export function scopedAffinitySessionId(
  binding: AffinitySessionBinding | null | undefined,
  bindingDigest: string,
): string | undefined {
  return binding?.sessionId && binding.bindingDigest === bindingDigest
    ? binding.sessionId
    : undefined;
}

/** A stored record as far as session identity is concerned. */
export type SessionIdentityRecord = {
  id: string;
  sessionId: string | null;
  prefixDigest: string | null;
  conversationDigest: string | null;
  lastUsedAt?: Date;
};

/**
 * The ONE place that decides which existing warm session a request continues
 * (routing reads it to link a lease to its session, and `rememberAffinity` to
 * stamp the records it writes). `records` are the target's stored records that
 * share the request's binding. Order of authority:
 * 1. the explicit conversation's own record (a caller-supplied conversation id
 *    is the session, whatever the history or the request parameters do);
 * 2. only for a continuation, the deepest cumulative-prefix record the
 *    request's history still contains (an edited or shortened history still
 *    shares its earlier prefix); most recently used among equal depths.
 * Instruction-layer records are not conversation evidence and never link.
 * Returns the record's `sessionId`, or its own id for rows from before
 * session ids existed; null = a new session.
 */
export function continuedSessionKey(
  records: readonly SessionIdentityRecord[],
  request: {
    conversationDigest: string | null;
    isContinuation: boolean;
    /** Cumulative prefix digests of the request's conversation, depth = index + 1. */
    digests: readonly string[];
  },
): string | null {
  const key = (record: SessionIdentityRecord) => record.sessionId ?? record.id;
  const newest = (left: SessionIdentityRecord, right: SessionIdentityRecord) =>
    (right.lastUsedAt?.getTime() ?? 0) - (left.lastUsedAt?.getTime() ?? 0);
  if (request.conversationDigest) {
    const own = records
      .filter(
        (record) =>
          record.prefixDigest === null && record.conversationDigest === request.conversationDigest,
      )
      .sort(newest)[0];
    if (own) return key(own);
  }
  if (!request.isContinuation) return null;
  const depthByDigest = new Map(request.digests.map((digest, index) => [digest, index + 1]));
  let best: { depth: number; record: SessionIdentityRecord } | null = null;
  for (const record of records) {
    const depth = record.prefixDigest ? (depthByDigest.get(record.prefixDigest) ?? 0) : 0;
    if (depth === 0) continue;
    if (!best || depth > best.depth || (depth === best.depth && newest(best.record, record) > 0))
      best = { depth, record };
  }
  return best ? key(best.record) : null;
}

export function buildAffinityTargetIdentity(parts: {
  executionTargetId: string;
  endpointIdentity: string;
  upstreamModelId: string;
  runtimeIdentityKey: string;
  runtimeModel: string;
  runtimeRevision: string | null;
  tokenizer: string | null;
  tokenizerVersion: string | null;
  template: string | null;
  templateVersion: string | null;
  engine: string | null;
  cacheNamespace: string | null;
  requestedSurface: string;
  nativeSurface: string;
  mode: string;
  adapterVersion: string;
}) {
  return hmacDigestForForwarderPurpose({
    purpose: "cacheAffinity",
    value: stableJson({ version: 2, ...parts }),
  });
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

const PARAMETER_EXCLUSIONS = new Set(["model", "stream", "conversation", "conversation_id"]);

function hmacValue(value: string) {
  return hmacDigestForForwarderPurpose({ purpose: "cacheAffinity", value });
}

function cumulativePrefixDigests(
  units: JsonValue[],
  encode: (index: number, cumulative: string) => string,
) {
  const digests: string[] = [];
  let cumulative = "";
  for (let index = 0; index < units.length; index += 1) {
    cumulative += `${index}:${stableJson(units[index]!)}\n`;
    if (Buffer.byteLength(cumulative) > MAX_CANONICAL_BYTES) break;
    digests.push(encode(index + 1, cumulative));
  }
  return digests;
}

/**
 * Produces layered HMAC prefixes without retaining source material.
 * Conversation `digests` exclude instruction roles. Instruction warmth is a
 * separate cumulative list. Object key order does not affect canonical JSON.
 */
export function affinityPrefixDigests({
  ownerId,
  resourceOwnerId,
  poolId,
  securityScope,
  accessGrantId,
  surface,
  payload,
  runtimeIdentity,
}: {
  ownerId: string;
  resourceOwnerId: string;
  poolId: string;
  securityScope?: string;
  accessGrantId?: string | null;
  surface: string;
  payload: Record<string, unknown>;
  runtimeIdentity: string;
}): {
  bindingDigest: string;
  instructionDigests: string[];
  digests: string[];
  conversationDigest: string | null;
  hasExplicitConversation: boolean;
  isContinuation: boolean;
} {
  const canonicalSurface = canonicalizeAffinitySurface(surface);
  const layers = extractAffinityLayers(canonicalSurface, payload);
  const excluded = new Set([...layers.consumedKeys, ...PARAMETER_EXCLUSIONS]);
  // Bind every other JSON field, including unknown native extensions. False
  // negatives are safe; matching requests whose unknown semantics differ is
  // not. Only consumed content keys and transport/session framing are omitted.
  const parameters = Object.fromEntries(
    Object.entries(payload).flatMap(([key, raw]) => {
      if (excluded.has(key)) return [];
      const value = asJson(raw);
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
  const binding = stableJson({
    v: DIGEST_VERSION,
    ownerId,
    resourceOwnerId,
    poolId,
    securityScope: securityScope ?? ownerId,
    accessGrantId: accessGrantId ?? null,
    surface: canonicalSurface ?? surface,
    runtimeIdentity,
  });
  const bindingDigest = hmacValue(`affinity-binding-v4:${binding}`);
  const prefixBindingDigest = hmacValue(
    `affinity-prefix-binding-v4:${stableJson({
      bindingDigest,
      instructions: layers.instructionUnits,
      tools: layers.tools ?? null,
      parameters,
    })}`,
  );
  const digests = cumulativePrefixDigests(
    layers.conversationUnits.slice(0, MAX_PREFIXES_PER_REQUEST),
    (index, cumulative) =>
      hmacValue(`prefix-binding:${prefixBindingDigest}\nprefix:${index}\n${cumulative}`),
  );
  const textCap =
    layers.tools !== undefined ? MAX_INSTRUCTION_PREFIXES - 1 : MAX_INSTRUCTION_PREFIXES;
  const hmacInstructionUnits =
    layers.tools !== undefined
      ? [...layers.instructionUnits.slice(0, textCap), layers.tools]
      : layers.instructionUnits.slice(0, textCap);
  const instructionDigests = cumulativePrefixDigests(hmacInstructionUnits, (index, cumulative) =>
    hmacValue(`instruction-layer-v4:${bindingDigest}\nprefix:${index}\n${cumulative}`),
  );
  const conversationSource = asJson(payload.conversation ?? payload.conversation_id);
  return {
    bindingDigest,
    instructionDigests,
    digests,
    isContinuation: layers.isContinuation,
    hasExplicitConversation: conversationSource !== undefined,
    conversationDigest:
      conversationSource === undefined
        ? null
        : hmacValue(
            `affinity-conversation-v4:${stableJson({
              v: DIGEST_VERSION,
              ownerId,
              resourceOwnerId,
              poolId,
              securityScope: securityScope ?? ownerId,
              accessGrantId: accessGrantId ?? null,
              conversation: conversationSource,
            })}`,
          ),
  };
}

export async function rankAffinityTargets({
  ownerId,
  resourceOwnerId,
  poolId,
  securityScope,
  accessGrantId,
  policy,
  surface,
  payload,
  targets,
  scoreSingleTarget = false,
  now = new Date(),
}: {
  ownerId: string;
  resourceOwnerId: string;
  poolId: string;
  securityScope?: string;
  accessGrantId?: string | null;
  policy: AffinityPolicy;
  surface: string;
  payload: Record<string, unknown>;
  targets: AffinityTarget[];
  /** Score one target too (local pool routing with warm-session protection). */
  scoreSingleTarget?: boolean;
  now?: Date;
}): Promise<AffinityDecision> {
  const unchanged = {
    orderedTargetIds: targets.map(({ executionTargetId }) => executionTargetId),
    scores: {},
    prefixDepths: {},
    instructionDepths: {},
    conversationMatches: {},
    reasons: {},
    matchedPrefixDepth: 0,
    matchedSessionIds: {},
  };
  // With `scoreSingleTarget`, a single target is still scored: warm-session
  // protection (S-C) needs to know whether this request continues a session
  // on it (an affinity hit is never redirected), even with nothing to reorder.
  if (!policy.enabled || targets.length < (scoreSingleTarget ? 1 : 2)) return unchanged;

  const materialByIdentity = new Map(
    targets.map((target) => [
      target.targetIdentity,
      affinityPrefixDigests({
        ownerId,
        resourceOwnerId,
        poolId,
        securityScope: securityScope ?? ownerId,
        accessGrantId,
        surface,
        payload,
        runtimeIdentity: target.targetIdentity,
      }),
    ]),
  );
  const conversationPrefixDigests = [
    ...new Set([...materialByIdentity.values()].flatMap(({ digests }) => digests)),
  ];
  const instructionPrefixDigests = [
    ...new Set(
      [...materialByIdentity.values()].flatMap(({ instructionDigests }) => instructionDigests),
    ),
  ];
  const sessionDigests = [
    ...new Set(
      [...materialByIdentity.values()]
        .filter(({ hasExplicitConversation }) => hasExplicitConversation)
        .flatMap(({ conversationDigest }) => (conversationDigest ? [conversationDigest] : [])),
    ),
  ];
  const prefixQueryDigests = [
    ...new Set([...conversationPrefixDigests, ...instructionPrefixDigests]),
  ];
  if (
    conversationPrefixDigests.length === 0 &&
    instructionPrefixDigests.length === 0 &&
    sessionDigests.length === 0
  ) {
    return unchanged;
  }

  const [records, activeLoads, waitingLoads] = await Promise.all([
    prisma.cacheAffinityRecord.findMany({
      where: {
        userId: resourceOwnerId,
        tenantUserId: ownerId,
        poolId,
        digestVersion: DIGEST_VERSION,
        expiresAt: { gt: now },
        executionTargetId: { in: targets.map(({ executionTargetId }) => executionTargetId) },
        OR: [
          ...(prefixQueryDigests.length ? [{ prefixDigest: { in: prefixQueryDigests } }] : []),
          ...(sessionDigests.length ? [{ conversationDigest: { in: sessionDigests } }] : []),
        ],
      },
      select: {
        id: true,
        sessionId: true,
        lastUsedAt: true,
        executionTargetId: true,
        targetIdentity: true,
        bindingDigest: true,
        prefixDigest: true,
        conversationDigest: true,
        prefixDepth: true,
        digestVersion: true,
        engineCacheConfirmed: true,
        estimatedTokens: true,
      },
    }),
    prisma.capacityLease.groupBy({
      by: ["capacityId"],
      where: {
        capacityId: { in: targets.map(({ capacityId }) => capacityId) },
        state: "ACTIVE",
        expiresAt: { gt: now },
      },
      _count: { _all: true },
    }),
    prisma.capacityWaiter.groupBy({
      by: ["capacityId"],
      where: {
        capacityId: { in: targets.map(({ capacityId }) => capacityId) },
        state: "WAITING",
        OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
      },
      _count: { _all: true },
    }),
  ]);
  const activeByCapacity = new Map(activeLoads.map((row) => [row.capacityId, row._count._all]));
  const waitingByCapacity = new Map(waitingLoads.map((row) => [row.capacityId, row._count._all]));
  const currentRecords = records.filter((record) => record.digestVersion === DIGEST_VERSION);
  const scored = targets.map((target, originalIndex) => {
    const material = materialByIdentity.get(target.targetIdentity)!;
    const conversationDepthByDigest = new Map(
      material.digests.map((digest, index) => [digest, index + 1]),
    );
    const instructionDepthByDigest = new Map(
      material.instructionDigests.map((digest, index) => [digest, index + 1]),
    );
    const compatible = currentRecords.filter(
      (record) =>
        record.executionTargetId === target.executionTargetId &&
        record.targetIdentity === target.targetIdentity &&
        record.bindingDigest === material.bindingDigest,
    );
    const conversationDepth = compatible.reduce(
      (best, record) =>
        Math.max(
          best,
          record.prefixDigest ? (conversationDepthByDigest.get(record.prefixDigest) ?? 0) : 0,
        ),
      0,
    );
    const instructionDepth = compatible.reduce(
      (best, record) =>
        Math.max(
          best,
          record.prefixDigest ? (instructionDepthByDigest.get(record.prefixDigest) ?? 0) : 0,
        ),
      0,
    );
    const scoredPrefixDepth = material.isContinuation ? conversationDepth : 0;
    const conversation =
      material.hasExplicitConversation &&
      compatible.some((record) => record.conversationDigest === material.conversationDigest);
    const confirmed = compatible.some(
      (record) =>
        scoredPrefixDepth > 0 &&
        record.prefixDigest !== null &&
        (conversationDepthByDigest.get(record.prefixDigest) ?? 0) === scoredPrefixDepth &&
        record.engineCacheConfirmed,
    );
    const matchedPrefixRecord =
      scoredPrefixDepth > 0
        ? compatible.find(
            (record) =>
              record.prefixDigest !== null &&
              conversationDepthByDigest.get(record.prefixDigest) === scoredPrefixDepth,
          )
        : undefined;
    const matchedRecord =
      matchedPrefixRecord ??
      (conversation
        ? compatible.find((record) => record.conversationDigest === material.conversationDigest)
        : undefined);
    const prefixTokens = matchedRecord?.estimatedTokens ?? undefined;
    const sessionId = continuedSessionKey(compatible, {
      conversationDigest: material.hasExplicitConversation ? material.conversationDigest : null,
      isContinuation: material.isContinuation,
      digests: material.digests,
    });
    const active = target.activeLoad ?? activeByCapacity.get(target.capacityId) ?? 0;
    const waiting = target.waitingLoad ?? waitingByCapacity.get(target.capacityId) ?? 0;
    const normalizedLoad = target.hardConcurrencyLimit
      ? Math.ceil((active * 100) / target.hardConcurrencyLimit) + waiting * 100
      : active * 100 + waiting * 100;
    const score =
      scoredPrefixDepth * policy.prefixWeight +
      (conversation ? policy.conversationWeight : 0) +
      (confirmed ? policy.confirmedCacheWeight : 0) -
      Math.ceil((normalizedLoad * policy.loadPenaltyWeight) / 100) -
      target.healthPenalty -
      target.publicEgressPenalty -
      target.costPenalty;
    return {
      target,
      originalIndex,
      score,
      prefixDepth: scoredPrefixDepth,
      instructionDepth,
      conversation,
      confirmed,
      active,
      waiting,
      isContinuation: material.isContinuation,
      prefixTokens,
      sessionId,
    };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.instructionDepth - left.instructionDepth ||
      left.originalIndex - right.originalIndex,
  );
  return {
    orderedTargetIds: scored.map(({ target }) => target.executionTargetId),
    scores: Object.fromEntries(
      scored.map(({ target, score }) => [target.executionTargetId, score]),
    ),
    prefixDepths: Object.fromEntries(
      scored.map(({ target, prefixDepth }) => [target.executionTargetId, prefixDepth]),
    ),
    instructionDepths: Object.fromEntries(
      scored.map(({ target, instructionDepth }) => [target.executionTargetId, instructionDepth]),
    ),
    conversationMatches: Object.fromEntries(
      scored.map(({ target, conversation }) => [target.executionTargetId, conversation]),
    ),
    reasons: Object.fromEntries(
      scored.map(
        ({
          target,
          prefixDepth,
          instructionDepth,
          conversation,
          confirmed,
          active,
          waiting,
          isContinuation,
        }) => [
          target.executionTargetId,
          `prefix:${prefixDepth};instruction:${instructionDepth};continuation:${isContinuation};conversation:${conversation};confirmed:${confirmed};active:${active};waiting:${waiting};healthPenalty:${target.healthPenalty};publicPenalty:${target.publicEgressPenalty};costPenalty:${target.costPenalty}`,
        ],
      ),
    ),
    matchedPrefixDepth: Math.max(0, ...scored.map(({ prefixDepth }) => prefixDepth)),
    prefixTokens: Object.fromEntries(
      scored.flatMap(({ target, prefixTokens }) =>
        prefixTokens === undefined ? [] : [[target.executionTargetId, prefixTokens]],
      ),
    ),
    matchedSessionIds: Object.fromEntries(
      scored.flatMap(({ target, sessionId }) =>
        sessionId === null ? [] : [[target.executionTargetId, sessionId]],
      ),
    ),
  };
}

export async function rememberAffinity({
  ownerId,
  resourceOwnerId,
  poolId,
  securityScope,
  accessGrantId,
  policy,
  surface,
  payload,
  target,
  estimatedTokens,
  engineCacheConfirmed,
  sessionBinding,
  now = new Date(),
}: {
  ownerId: string;
  resourceOwnerId: string;
  poolId: string;
  securityScope?: string;
  accessGrantId?: string | null;
  policy: AffinityPolicy;
  surface: string;
  payload: Record<string, unknown>;
  target: AffinityTarget;
  estimatedTokens?: number;
  /**
   * Latest engine cache evidence from the served response. `true` (cached
   * prompt tokens reported) and `false` (cache fields reported with zero)
   * overwrite the stored flag; `undefined` (provider does not report cache
   * usage) leaves any previously stored value untouched.
   */
  engineCacheConfirmed?: boolean;
  /** Internal native Responses continuation, read only from the durable sticky row. */
  sessionBinding?: AffinitySessionBinding;
  now?: Date;
}): Promise<AffinitySessionBinding | null> {
  if (!policy.enabled) return null;
  const material = affinityPrefixDigests({
    ownerId,
    resourceOwnerId,
    poolId,
    securityScope: securityScope ?? ownerId,
    accessGrantId,
    surface,
    payload,
    runtimeIdentity: target.targetIdentity,
  });
  if (
    material.instructionDigests.length === 0 &&
    material.digests.length === 0 &&
    !material.conversationDigest
  ) {
    return null;
  }
  const boundSessionId = scopedAffinitySessionId(sessionBinding, material.bindingDigest);
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  // Every record this call writes (created or refreshed) carries the same
  // `lastUsedAt` and `sessionId`: warm-session protection (S-C,
  // ./warm-protection.ts) groups records into one session by the id, dates it
  // by its newest record and sizes it by that instant's `estimatedTokens`.
  return prisma.$transaction(async (tx) => {
    // Serialize retention enforcement per owner/pool so concurrent successful
    // requests cannot race past the configured bound: the cache-affinity
    // fence, taken before any row (writer class H,
    // @ws-model-proxy/db/capacity-lock-order). No pool row is locked; the
    // pool is read without a lock and its records carry plain ids, so a pool
    // deleted meanwhile leaves records the expiry sweep removes.
    await acquireFences(tx, [fences.cacheAffinity(resourceOwnerId, poolId)]);
    const pool = await tx.modelPool.findFirst({
      where: { id: poolId, userId: resourceOwnerId },
      select: { id: true },
    });
    if (!pool) return null;
    await tx.cacheAffinityRecord.deleteMany({
      where: {
        userId: resourceOwnerId,
        tenantUserId: ownerId,
        poolId,
        expiresAt: { lte: now },
      },
    });
    // The session this request continues (or a new one), read under the pool
    // fence so concurrent writers of one conversation agree on it. A scoped
    // native binding also identifies continuations carrying only the new input.
    const sessionId =
      boundSessionId ??
      continuedSessionKey(
        await tx.cacheAffinityRecord.findMany({
          where: {
            userId: resourceOwnerId,
            tenantUserId: ownerId,
            poolId,
            executionTargetId: target.executionTargetId,
            targetIdentity: target.targetIdentity,
            bindingDigest: material.bindingDigest,
            digestVersion: DIGEST_VERSION,
            expiresAt: { gt: now },
            OR: [
              ...(material.digests.length ? [{ prefixDigest: { in: material.digests } }] : []),
              ...(material.conversationDigest
                ? [{ conversationDigest: material.conversationDigest }]
                : []),
            ],
          },
          select: {
            id: true,
            sessionId: true,
            prefixDigest: true,
            conversationDigest: true,
            lastUsedAt: true,
          },
        }),
        {
          conversationDigest: material.conversationDigest,
          isContinuation: material.isContinuation,
          digests: material.digests,
        },
      ) ??
      randomUUID();
    const upsertPrefix = async (prefixDigest: string, prefixDepth: number) => {
      await tx.cacheAffinityRecord.upsert({
        where: {
          tenantUserId_poolId_executionTargetId_targetIdentity_bindingDigest_prefixDigest: {
            tenantUserId: ownerId,
            poolId,
            executionTargetId: target.executionTargetId,
            targetIdentity: target.targetIdentity,
            bindingDigest: material.bindingDigest,
            prefixDigest,
          },
        },
        create: {
          userId: resourceOwnerId,
          tenantUserId: ownerId,
          poolId,
          executionTargetId: target.executionTargetId,
          targetIdentity: target.targetIdentity,
          bindingDigest: material.bindingDigest,
          prefixDigest,
          conversationDigest: null,
          sessionId,
          prefixDepth,
          digestVersion: DIGEST_VERSION,
          estimatedTokens,
          engineCacheConfirmed: engineCacheConfirmed ?? false,
          lastUsedAt: now,
          expiresAt,
        },
        update: {
          lastUsedAt: now,
          expiresAt,
          sessionId,
          estimatedTokens,
          ...(engineCacheConfirmed === undefined ? {} : { engineCacheConfirmed }),
        },
      });
    };
    for (const [index, prefixDigest] of material.instructionDigests.entries()) {
      await upsertPrefix(prefixDigest, index + 1);
    }
    for (const [index, prefixDigest] of material.digests.entries()) {
      await upsertPrefix(prefixDigest, index + 1);
    }
    if (material.conversationDigest) {
      const identity = {
        tenantUserId: ownerId,
        poolId,
        executionTargetId: target.executionTargetId,
        targetIdentity: target.targetIdentity,
        bindingDigest: material.bindingDigest,
        prefixDigest: null,
        conversationDigest: material.conversationDigest,
      };
      const existing = await tx.cacheAffinityRecord.findFirst({
        where: identity,
        select: { id: true },
      });
      if (existing) {
        await tx.cacheAffinityRecord.update({
          where: { id: existing.id },
          data: {
            lastUsedAt: now,
            expiresAt,
            sessionId,
            estimatedTokens,
            ...(engineCacheConfirmed === undefined ? {} : { engineCacheConfirmed }),
          },
        });
      } else {
        await tx.cacheAffinityRecord.create({
          data: {
            userId: resourceOwnerId,
            ...identity,
            sessionId,
            prefixDepth: 0,
            digestVersion: DIGEST_VERSION,
            estimatedTokens,
            engineCacheConfirmed: engineCacheConfirmed ?? false,
            lastUsedAt: now,
            expiresAt,
          },
        });
      }
    }
    const overflow = await tx.cacheAffinityRecord.findMany({
      where: {
        userId: resourceOwnerId,
        tenantUserId: ownerId,
        poolId,
        executionTargetId: target.executionTargetId,
      },
      orderBy: [{ lastUsedAt: "desc" }, { id: "desc" }],
      skip: policy.maxRecords,
      select: { id: true },
    });
    if (overflow.length) {
      await tx.cacheAffinityRecord.deleteMany({
        where: { id: { in: overflow.map(({ id }) => id) } },
      });
    }
    return { sessionId, bindingDigest: material.bindingDigest };
  });
}

/**
 * Deletes expired records (writer class S): one statement that takes its rows
 * with SKIP LOCKED, so it never waits on a writer's record lock. Records of a
 * deleted pool, target or tenant expire like any other (at most the pool's
 * TTL, seven days) and are never read meanwhile: ranking reads only the
 * records of live targets of a visible pool.
 */
export async function sweepExpiredAffinity({ now = new Date(), limit = 1000 } = {}) {
  return prisma.$executeRaw`
    DELETE FROM cache_affinity_record
     WHERE id IN (
       SELECT id FROM cache_affinity_record
        WHERE "expiresAt" <= ${now}
        ORDER BY "expiresAt", id
        LIMIT ${Math.max(1, Math.min(limit, 10_000))}
          FOR UPDATE SKIP LOCKED)`;
}
