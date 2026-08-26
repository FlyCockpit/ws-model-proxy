import prisma from "@ws-model-proxy/db";
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
  conversationMatches: Record<string, boolean>;
  reasons: Record<string, string>;
  matchedPrefixDepth: number;
};

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
  now?: Date;
}): Promise<AffinityDecision> {
  const unchanged = {
    orderedTargetIds: targets.map(({ executionTargetId }) => executionTargetId),
    scores: {},
    prefixDepths: {},
    conversationMatches: {},
    reasons: {},
    matchedPrefixDepth: 0,
  };
  if (!policy.enabled || targets.length < 2) return unchanged;

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
  const allDigests = [
    ...new Set([...materialByIdentity.values()].flatMap(({ digests }) => digests)),
  ];
  const conversationDigests = [
    ...new Set(
      [...materialByIdentity.values()]
        .filter(({ hasExplicitConversation }) => hasExplicitConversation)
        .flatMap(({ conversationDigest }) => (conversationDigest ? [conversationDigest] : [])),
    ),
  ];
  if (allDigests.length === 0 && conversationDigests.length === 0) return unchanged;

  const [records, activeLoads, waitingLoads] = await Promise.all([
    prisma.cacheAffinityRecord.findMany({
      where: {
        userId: resourceOwnerId,
        tenantUserId: ownerId,
        poolId,
        expiresAt: { gt: now },
        executionTargetId: { in: targets.map(({ executionTargetId }) => executionTargetId) },
        OR: [
          ...(allDigests.length ? [{ prefixDigest: { in: allDigests } }] : []),
          ...(conversationDigests.length
            ? [{ conversationDigest: { in: conversationDigests } }]
            : []),
        ],
      },
      select: {
        executionTargetId: true,
        targetIdentity: true,
        bindingDigest: true,
        prefixDigest: true,
        conversationDigest: true,
        prefixDepth: true,
        engineCacheConfirmed: true,
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
  const scored = targets.map((target, originalIndex) => {
    const material = materialByIdentity.get(target.targetIdentity)!;
    const digestDepth = new Map(material.digests.map((digest, index) => [digest, index + 1]));
    const compatible = records.filter(
      (record) =>
        record.executionTargetId === target.executionTargetId &&
        record.targetIdentity === target.targetIdentity &&
        record.bindingDigest === material.bindingDigest,
    );
    const prefixDepth = compatible.reduce(
      (best, record) =>
        Math.max(best, record.prefixDigest ? (digestDepth.get(record.prefixDigest) ?? 0) : 0),
      0,
    );
    const conversation =
      material.hasExplicitConversation &&
      compatible.some((record) => record.conversationDigest === material.conversationDigest);
    const confirmed = compatible.some(
      (record) =>
        prefixDepth > 0 &&
        record.prefixDigest !== null &&
        (digestDepth.get(record.prefixDigest) ?? 0) === prefixDepth &&
        record.engineCacheConfirmed,
    );
    const active = target.activeLoad ?? activeByCapacity.get(target.capacityId) ?? 0;
    const waiting = target.waitingLoad ?? waitingByCapacity.get(target.capacityId) ?? 0;
    const normalizedLoad = target.hardConcurrencyLimit
      ? Math.ceil((active * 100) / target.hardConcurrencyLimit) + waiting * 100
      : active * 100 + waiting * 100;
    const score =
      prefixDepth * policy.prefixWeight +
      (conversation ? policy.conversationWeight : 0) +
      (confirmed ? policy.confirmedCacheWeight : 0) -
      Math.ceil((normalizedLoad * policy.loadPenaltyWeight) / 100) -
      target.healthPenalty -
      target.publicEgressPenalty -
      target.costPenalty;
    return { target, originalIndex, score, prefixDepth, conversation, confirmed, active, waiting };
  });
  scored.sort(
    (left, right) => right.score - left.score || left.originalIndex - right.originalIndex,
  );
  return {
    orderedTargetIds: scored.map(({ target }) => target.executionTargetId),
    scores: Object.fromEntries(
      scored.map(({ target, score }) => [target.executionTargetId, score]),
    ),
    prefixDepths: Object.fromEntries(
      scored.map(({ target, prefixDepth }) => [target.executionTargetId, prefixDepth]),
    ),
    conversationMatches: Object.fromEntries(
      scored.map(({ target, conversation }) => [target.executionTargetId, conversation]),
    ),
    reasons: Object.fromEntries(
      scored.map(({ target, prefixDepth, conversation, confirmed, active, waiting }) => [
        target.executionTargetId,
        `prefix:${prefixDepth};conversation:${conversation};confirmed:${confirmed};active:${active};waiting:${waiting};healthPenalty:${target.healthPenalty};publicPenalty:${target.publicEgressPenalty};costPenalty:${target.costPenalty}`,
      ]),
    ),
    matchedPrefixDepth: Math.max(0, ...scored.map(({ prefixDepth }) => prefixDepth)),
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
  engineCacheConfirmed = false,
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
  engineCacheConfirmed?: boolean;
  now?: Date;
}): Promise<void> {
  if (!policy.enabled) return;
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
  if (material.digests.length === 0 && !material.conversationDigest) return;
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  await prisma.$transaction(async (tx) => {
    // Serialize retention enforcement per owner/pool so concurrent successful
    // requests cannot race past the configured bound.
    const lockedPool = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM model_pool
       WHERE id = ${poolId} AND "userId" = ${resourceOwnerId}
       FOR UPDATE
    `;
    if (lockedPool.length !== 1) return;
    await tx.cacheAffinityRecord.deleteMany({
      where: {
        userId: resourceOwnerId,
        tenantUserId: ownerId,
        poolId,
        expiresAt: { lte: now },
      },
    });
    for (const [index, prefixDigest] of material.digests.entries()) {
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
          prefixDepth: index + 1,
          estimatedTokens,
          engineCacheConfirmed,
          expiresAt,
        },
        update: {
          lastUsedAt: now,
          expiresAt,
          estimatedTokens,
          engineCacheConfirmed,
        },
      });
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
          data: { lastUsedAt: now, expiresAt, estimatedTokens, engineCacheConfirmed },
        });
      } else {
        await tx.cacheAffinityRecord.create({
          data: {
            userId: resourceOwnerId,
            ...identity,
            prefixDepth: 0,
            estimatedTokens,
            engineCacheConfirmed,
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
  });
}

export async function sweepExpiredAffinity({ now = new Date(), limit = 1000 } = {}) {
  const expired = await prisma.cacheAffinityRecord.findMany({
    where: { expiresAt: { lte: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(limit, 10_000)),
    select: { id: true },
  });
  if (!expired.length) return 0;
  const result = await prisma.cacheAffinityRecord.deleteMany({
    where: { id: { in: expired.map(({ id }) => id) }, expiresAt: { lte: now } },
  });
  return result.count;
}
