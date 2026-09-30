import { randomUUID } from "node:crypto";
import prisma, { Prisma } from "@ws-model-proxy/db";
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
const SESSION_RECORD_SELECT = {
  id: true,
  sessionId: true,
  historyDigests: true,
  explicitConversationDigest: true,
  writeDigest: true,
  completedWriteDigests: true,
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
} satisfies Prisma.CacheAffinityRecordSelect;

type HistoryLookupScope = {
  userId: string;
  tenantUserId: string;
  poolId: string;
  executionTargetId: string;
  targetIdentity: string;
  bindingDigest: string;
  now: Date;
};

type SnapshotMatch = Prisma.CacheAffinityRecordGetPayload<{ select: typeof SESSION_RECORD_SELECT }>;

async function matchingHistorySnapshots(
  client: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  scope: HistoryLookupScope,
  historyDigests: readonly string[],
) {
  // Call only inside a transaction. Keep the GIN predicate separate from
  // scope filters and discourage sequential scans locally: sparse array stats,
  // a GIN pending list and LIMIT 2 otherwise let the planner scan every history.
  // Digests already HMAC-bind the full scope; verify it outside the materialized
  // index candidate query too. Its outer limit consumes only two matching rows,
  // enough to prove ambiguity within the preferred containment class. Order
  // contained snapshots before edited ones before applying the read bound.
  // At most 64 indexed probes return at most two snapshots per target.
  await client.$executeRaw`SET LOCAL enable_seqscan = off`;
  for (const digest of [...historyDigests].reverse()) {
    const rows = await client.$queryRaw<SnapshotMatch[]>(Prisma.sql`
      WITH matching AS MATERIALIZED (
        SELECT id, "userId", "tenantUserId", "poolId", "expiresAt",
               "sessionId", "historyDigests", "explicitConversationDigest", "writeDigest", "completedWriteDigests",
               "lastUsedAt", "executionTargetId", "targetIdentity", "bindingDigest",
               "prefixDigest", "conversationDigest", "prefixDepth", "digestVersion",
               "engineCacheConfirmed", "estimatedTokens"
          FROM cache_affinity_record
         WHERE "historyDigests" && ARRAY[${digest}]::text[]
      ) SELECT * FROM matching
         WHERE "userId" = ${scope.userId} AND "tenantUserId" = ${scope.tenantUserId}
           AND "poolId" = ${scope.poolId} AND "executionTargetId" = ${scope.executionTargetId}
           AND "targetIdentity" = ${scope.targetIdentity} AND "bindingDigest" = ${scope.bindingDigest}
           AND "digestVersion" = ${DIGEST_VERSION} AND "expiresAt" > ${scope.now}
           AND "prefixDigest" IS NULL AND "sessionId" IS NOT NULL
           AND "explicitConversationDigest" IS NULL
         ORDER BY ("historyDigests"[cardinality("historyDigests")] = ${digest}) DESC
         LIMIT 2
    `);
    if (rows.length) return rows;
  }
  return [];
}
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

/** Durable internal Responses binding; its HMAC covers tenant/pool/grant/runtime. */
export type AffinitySessionBinding = { sessionId: string; bindingDigest: string };

export function scopedAffinitySessionId(
  binding: AffinitySessionBinding | null | undefined,
  bindingDigest: string,
): string | undefined {
  return binding?.bindingDigest === bindingDigest ? binding.sessionId : undefined;
}

/** A stored record as far as session identity is concerned. */
export type SessionIdentityRecord = {
  id: string;
  sessionId: string | null;
  prefixDigest: string | null;
  conversationDigest: string | null;
  historyDigests?: readonly string[];
  explicitConversationDigest?: string | null;
  writeDigest?: string | null;
  completedWriteDigests?: readonly string[];
  lastUsedAt?: Date;
};

function hasRememberedWrite(
  record: SessionIdentityRecord,
  writeDigest: string,
  conversationDigest: string | null,
  boundSessionId?: string,
) {
  return (
    record.prefixDigest === null &&
    (record.writeDigest === writeDigest ||
      record.completedWriteDigests?.includes(writeDigest) === true) &&
    (record.sessionId === boundSessionId ||
      (record.explicitConversationDigest ?? null) === conversationDigest)
  );
}

/**
 * ONE identity decision for routing's lease link and rememberAffinity's writes.
 * Callers scope live records to the tenant, pool, target, binding and version.
 * Explicit ids only join their own conversation. Implicit continuations use
 * the deepest shared cumulative history, independent of sampling parameters
 * but bound to instructions/tools. At equal depth, a fully contained history
 * takes precedence over an edited one; several contained histories are ambiguous.
 * Exact prefixes also support legacy rows without history snapshots. Multiple
 * sessions in the preferred class are ambiguous: never guess by recency.
 *
 * Shared routing hints are mutable and cannot establish session ownership.
 * New evidence comes from each session's latest durable snapshot; legacy
 * null-session prefixes stand for their own row. Instruction digests are never
 * supplied.
 */
export function continuedSessionKey(
  records: readonly SessionIdentityRecord[],
  request: {
    conversationDigest: string | null;
    isContinuation: boolean;
    digests: readonly string[];
    historyDigests: readonly string[];
    /** Successful-request write identity, only supplied by rememberAffinity. */
    writeDigest?: string;
    /** Scoped durable Responses binding, never supplied by the caller. */
    boundSessionId?: string;
  },
): string | null {
  const key = (record: SessionIdentityRecord) => record.sessionId ?? record.id;
  const unique = (keys: Set<string>) => (keys.size === 1 ? [...keys][0]! : null);
  if (request.writeDigest) {
    const remembered = new Set(
      records
        .filter((record) =>
          hasRememberedWrite(
            record,
            request.writeDigest!,
            request.conversationDigest,
            request.boundSessionId,
          ),
        )
        .map(key),
    );
    if (remembered.size > 0) return unique(remembered);
  }
  if (request.boundSessionId) {
    return unique(
      new Set(
        records
          .filter(
            (record) => record.prefixDigest === null && record.sessionId === request.boundSessionId,
          )
          .map(key),
      ),
    );
  }
  if (request.conversationDigest) {
    return unique(
      new Set(
        records
          .filter((record) => {
            if (record.prefixDigest !== null) return false;
            return (
              (record.explicitConversationDigest ?? record.conversationDigest) ===
              request.conversationDigest
            );
          })
          .map(key),
      ),
    );
  }
  if (!request.isContinuation) return null;
  const prefixes = new Map(request.digests.map((digest, index) => [digest, index + 1]));
  const history = new Map(request.historyDigests.map((digest, index) => [digest, index + 1]));
  let bestDepth = 0;
  let bestContained = false;
  const matches = new Set<string>();
  for (const record of records) {
    if (record.explicitConversationDigest) continue;
    const snapshot = record.prefixDigest === null && record.sessionId !== null;
    if (!snapshot && (record.sessionId !== null || record.prefixDigest === null)) continue;
    const depth = snapshot
      ? Math.max(0, ...(record.historyDigests ?? []).map((digest) => history.get(digest) ?? 0))
      : (prefixes.get(record.prefixDigest!) ?? 0);
    const stored = record.historyDigests ?? [];
    const contained =
      snapshot &&
      stored.length > 0 &&
      stored[stored.length - 1] === request.historyDigests[stored.length - 1];
    if (depth === 0 || depth < bestDepth) continue;
    if (depth === bestDepth && bestContained && !contained) continue;
    if (depth > bestDepth || (contained && !bestContained)) {
      bestDepth = depth;
      bestContained = contained;
      matches.clear();
    }
    matches.add(key(record));
  }
  const sessionId = unique(matches);
  // A retained prefix of this same session remains valid after an edit or
  // shortening. A stronger hint owned by another session contradicts the
  // weaker history match, and must not put that victim in flight.
  if (
    sessionId !== null &&
    records.some(
      (record) =>
        (prefixes.get(record.prefixDigest ?? "") ?? 0) > bestDepth && key(record) !== sessionId,
    )
  )
    return null;
  return sessionId;
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
  /**
   * Cumulative conversation digests bound to scope, instructions and tools,
   * allowing sampling parameters to change between turns (session identity).
   */
  historyDigests: string[];
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
  const historyBindingDigest = hmacValue(
    `affinity-history-binding-v1:${stableJson({
      bindingDigest,
      instructions: layers.instructionUnits,
      tools: layers.tools ?? null,
    })}`,
  );
  const historyDigests = cumulativePrefixDigests(
    layers.conversationUnits.slice(0, MAX_PREFIXES_PER_REQUEST),
    (index, cumulative) =>
      hmacValue(`history-v4:${historyBindingDigest}\nprefix:${index}\n${cumulative}`),
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
    historyDigests,
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
  const explicitDigests = [
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
    explicitDigests.length === 0
  ) {
    return unchanged;
  }

  const [hintRecords, historyRecords, activeLoads, waitingLoads] = await Promise.all([
    prisma.cacheAffinityRecord.findMany({
      where: {
        userId: resourceOwnerId,
        tenantUserId: ownerId,
        poolId,
        digestVersion: DIGEST_VERSION,
        expiresAt: { gt: now },
        executionTargetId: { in: targets.map(({ executionTargetId }) => executionTargetId) },
        // Explicit ids do not encode the runtime binding. Scope that indexed
        // lookup here too, rather than fetching snapshots from obsolete runtimes.
        AND: [
          {
            OR: targets.map((target) => ({
              executionTargetId: target.executionTargetId,
              targetIdentity: target.targetIdentity,
              bindingDigest: materialByIdentity.get(target.targetIdentity)!.bindingDigest,
            })),
          },
        ],
        OR: [
          ...(prefixQueryDigests.length ? [{ prefixDigest: { in: prefixQueryDigests } }] : []),
          ...(explicitDigests.length
            ? [
                { explicitConversationDigest: { in: explicitDigests } },
                // Existing explicit conversation rows remain an indexed fallback.
                { conversationDigest: { in: explicitDigests } },
              ]
            : []),
        ],
      },
      select: SESSION_RECORD_SELECT,
    }),
    Promise.all(
      targets.map((target) => {
        const material = materialByIdentity.get(target.targetIdentity)!;
        return material.isContinuation && !material.hasExplicitConversation
          ? prisma.$transaction((tx) =>
              matchingHistorySnapshots(
                tx,
                {
                  userId: resourceOwnerId,
                  tenantUserId: ownerId,
                  poolId,
                  executionTargetId: target.executionTargetId,
                  targetIdentity: target.targetIdentity,
                  bindingDigest: material.bindingDigest,
                  now,
                },
                material.historyDigests,
              ),
            )
          : [];
      }),
    ),
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
  const currentRecords = [...hintRecords, ...historyRecords.flat()].filter(
    (record) => record.digestVersion === DIGEST_VERSION,
  );
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
    const sessionId = continuedSessionKey(compatible, {
      conversationDigest: material.hasExplicitConversation ? material.conversationDigest : null,
      isContinuation: material.isContinuation,
      digests: material.digests,
      historyDigests: material.historyDigests,
    });
    const conversation = material.hasExplicitConversation && sessionId !== null;
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
        ? compatible
            .filter(
              (record) =>
                (record.sessionId ?? record.id) === sessionId && record.prefixDigest === null,
            )
            .sort(
              (left, right) =>
                (right.lastUsedAt?.getTime() ?? 0) - (left.lastUsedAt?.getTime() ?? 0) ||
                (right.estimatedTokens ?? 0) - (left.estimatedTokens ?? 0),
            )[0]
        : undefined);
    const prefixTokens = matchedRecord?.estimatedTokens ?? undefined;
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
  requestId,
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
  /** Stable relay request id: retained completion HMACs make re-entry a no-op (64 max). */
  requestId?: string;
  /**
   * Latest engine cache evidence from the served response. `true` (cached
   * prompt tokens reported) and `false` (cache fields reported with zero)
   * overwrite the stored flag; `undefined` (provider does not report cache
   * usage) leaves any previously stored value untouched.
   */
  engineCacheConfirmed?: boolean;
  /** Internal native Responses continuation, validated against the current scope. */
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
  const writeDigest = requestId
    ? hmacValue(
        `affinity-session-write-v1:${material.bindingDigest}:${target.executionTargetId}:${requestId}`,
      )
    : undefined;
  const boundSessionId = scopedAffinitySessionId(sessionBinding, material.bindingDigest);
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  // Shared prefix/instruction rows are routing hints, not durable identity.
  // One snapshot per session retains ownership, age and size even when
  // another conversation refreshes every shared hint. All writes and identity
  // lookup run under the cache-affinity fence, including explicit conversation anchors.
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
    // The session this request continues (or a new one), read under the
    // fence so concurrent writers of one conversation agree on it.
    const hintRecords = await tx.cacheAffinityRecord.findMany({
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
          ...([...material.digests, ...material.instructionDigests].length
            ? [{ prefixDigest: { in: [...material.digests, ...material.instructionDigests] } }]
            : []),
          ...(material.conversationDigest
            ? [
                { explicitConversationDigest: material.conversationDigest },
                { conversationDigest: material.conversationDigest },
              ]
            : []),
          ...(writeDigest
            ? [{ writeDigest }, { completedWriteDigests: { has: writeDigest } }]
            : []),
          ...(boundSessionId ? [{ sessionId: boundSessionId, prefixDigest: null }] : []),
        ],
      },
      select: SESSION_RECORD_SELECT,
    });
    const historyRecords =
      material.isContinuation && !material.hasExplicitConversation && !boundSessionId
        ? await matchingHistorySnapshots(
            tx,
            {
              userId: resourceOwnerId,
              tenantUserId: ownerId,
              poolId,
              executionTargetId: target.executionTargetId,
              targetIdentity: target.targetIdentity,
              bindingDigest: material.bindingDigest,
              now,
            },
            material.historyDigests,
          )
        : [];
    const records = [...hintRecords, ...historyRecords];
    const continuedSessionId = continuedSessionKey(records, {
      conversationDigest: material.conversationDigest,
      isContinuation: material.isContinuation,
      digests: material.digests,
      historyDigests: material.historyDigests,
      writeDigest,
      boundSessionId,
    });
    // A retried completion is a no-op, including TTL, sizes and shared hints.
    if (
      writeDigest &&
      records.some((record) =>
        hasRememberedWrite(record, writeDigest, material.conversationDigest, boundSessionId),
      )
    )
      return continuedSessionId
        ? { sessionId: continuedSessionId, bindingDigest: material.bindingDigest }
        : null;
    const sessionId = continuedSessionId ?? randomUUID();
    const previousSnapshot = records.find(
      (record) => record.prefixDigest === null && record.sessionId === sessionId,
    );
    if (previousSnapshot && previousSnapshot.lastUsedAt > now)
      return { sessionId, bindingDigest: material.bindingDigest };
    const upsertPrefix = async (prefixDigest: string, prefixDepth: number) => {
      // A delayed completion must not move a newer hint's clock backwards.
      const previous = records.find((record) => record.prefixDigest === prefixDigest);
      if (previous && previous.lastUsedAt > now) return;
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
          createdAt: now,
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
    const prefixes = [...material.instructionDigests, ...material.digests].map(
      (prefixDigest, index) => ({
        prefixDigest,
        prefixDepth:
          index < material.instructionDigests.length
            ? index + 1
            : index - material.instructionDigests.length + 1,
      }),
    );
    if (prefixes.length > MAX_INSTRUCTION_PREFIXES) {
      // Long histories still use one hint write, rather than up to 72 Prisma
      // upsert round trips. Preserve the same per-row monotone clock and latest
      // evidence semantics, under the same fence and uniqueness constraint.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO cache_affinity_record
          (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity",
           "bindingDigest", "prefixDigest", "prefixDepth", "sessionId", "digestVersion",
           "estimatedTokens", "engineCacheConfirmed", "createdAt", "lastUsedAt", "expiresAt")
        VALUES ${Prisma.join(
          prefixes.map(
            ({ prefixDigest, prefixDepth }) => Prisma.sql`
          (${randomUUID()}, ${resourceOwnerId}, ${ownerId}, ${poolId}, ${target.executionTargetId},
           ${target.targetIdentity}, ${material.bindingDigest}, ${prefixDigest}, ${prefixDepth},
           ${sessionId}, ${DIGEST_VERSION}, ${estimatedTokens ?? null}, ${engineCacheConfirmed ?? false},
           ${now}, ${now}, ${expiresAt})
        `,
          ),
        )}
        ON CONFLICT ("tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "prefixDigest")
        DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt", "expiresAt" = EXCLUDED."expiresAt",
                      "sessionId" = EXCLUDED."sessionId",
                      "estimatedTokens" = COALESCE(EXCLUDED."estimatedTokens", cache_affinity_record."estimatedTokens")
                      ${engineCacheConfirmed === undefined ? Prisma.empty : Prisma.sql`, "engineCacheConfirmed" = EXCLUDED."engineCacheConfirmed"`}
        WHERE cache_affinity_record."lastUsedAt" <= EXCLUDED."lastUsedAt"
      `);
    } else {
      for (const { prefixDigest, prefixDepth } of prefixes)
        await upsertPrefix(prefixDigest, prefixDepth);
    }
    if (material.digests.length > 0 || material.conversationDigest) {
      // The immutable conversation-row identity is derived ONLY from sessionId,
      // domain-separated from caller ids. Every turn updates the same row; the
      // indexed history list holds only the latest snapshot (at most 64 digests).
      const identity = {
        tenantUserId: ownerId,
        poolId,
        executionTargetId: target.executionTargetId,
        targetIdentity: target.targetIdentity,
        bindingDigest: material.bindingDigest,
        prefixDigest: null,
        conversationDigest: hmacValue(`affinity-session-snapshot-v1:${sessionId}`),
      };
      const existing = await tx.cacheAffinityRecord.findFirst({
        where: identity,
        select: {
          id: true,
          lastUsedAt: true,
          sessionTokenEstimates: true,
          sessionTokenTimes: true,
          writeDigest: true,
          completedWriteDigests: true,
        },
      });
      // Bounded size samples preserve sub-floor age refreshes without keeping
      // old snapshot rows. Retain at most 64 undominated estimates within TTL;
      // protection applies its own window and floor when reading these samples.
      const samples = (existing?.sessionTokenTimes ?? []).flatMap((time, index) => {
        const tokens = existing?.sessionTokenEstimates[index];
        return tokens !== undefined &&
          time.getTime() > now.getTime() - policy.ttlSeconds * 1000 &&
          // A newer equal/larger estimate covers every floor the older sample
          // could cover. Keep only undominated sizes before applying the cap,
          // so repeated sub-floor turns do not push out the eligible sample.
          (estimatedTokens === undefined || tokens > estimatedTokens)
          ? [{ time, tokens }]
          : [];
      });
      if (estimatedTokens !== undefined) samples.push({ time: now, tokens: estimatedTokens });
      const boundedSamples = samples.slice(-MAX_PREFIXES_PER_REQUEST);
      const data = {
        sessionId,
        // Keep an identical list untouched: rewriting its toasted value would
        // churn the GIN index even on turns that only change parameters.
        historyDigests:
          existing &&
          previousSnapshot?.id === existing.id &&
          previousSnapshot.historyDigests.length === material.historyDigests.length &&
          previousSnapshot.historyDigests.every(
            (digest, index) => digest === material.historyDigests[index],
          )
            ? undefined
            : material.historyDigests.slice(0, MAX_PREFIXES_PER_REQUEST),
        explicitConversationDigest:
          boundSessionId && previousSnapshot
            ? previousSnapshot.explicitConversationDigest
            : material.conversationDigest,
        writeDigest: writeDigest ?? null,
        completedWriteDigests: [
          ...new Set([
            ...(existing?.completedWriteDigests ?? []),
            ...(existing?.writeDigest ? [existing.writeDigest] : []),
            ...(writeDigest ? [writeDigest] : []),
          ]),
        ].slice(-MAX_PREFIXES_PER_REQUEST),
        sessionTokenEstimates: boundedSamples.map(({ tokens }) => tokens),
        sessionTokenTimes: boundedSamples.map(({ time }) => time),
        // Unknown latest size is not a newly dated copy of an old estimate.
        // Eligible older sizes live only in the timestamped sample list.
        estimatedTokens: estimatedTokens ?? null,
        lastUsedAt: now,
        expiresAt,
      };
      if (existing) {
        if (existing.lastUsedAt <= now)
          await tx.cacheAffinityRecord.update({
            where: { id: existing.id },
            data: {
              ...data,
              ...(engineCacheConfirmed === undefined ? {} : { engineCacheConfirmed }),
            },
          });
      } else {
        await tx.cacheAffinityRecord.create({
          data: {
            userId: resourceOwnerId,
            ...identity,
            ...data,
            createdAt: now,
            prefixDepth: 0,
            digestVersion: DIGEST_VERSION,
            engineCacheConfirmed: engineCacheConfirmed ?? false,
          },
        });
      }
    }
    // maxRecords is a shared per-tenant/pool/target budget. Reserve space for
    // ALL depth-zero snapshots first, ordered by recency, then spend the rest on
    // hints using their existing recency/depth order. Hints cannot evict their
    // session; only excess live sessions evict older snapshots. Both eviction
    // queries return ids only: once bounded, a write adds at most 64 + 8 hints
    // and one snapshot, so their combined result is at most 73 ids.
    const retentionScope = {
      userId: resourceOwnerId,
      tenantUserId: ownerId,
      poolId,
      executionTargetId: target.executionTargetId,
    };
    const snapshotCount = await tx.cacheAffinityRecord.count({
      where: { ...retentionScope, prefixDepth: 0 },
    });
    const [snapshotOverflow, hintOverflow] = await Promise.all([
      tx.cacheAffinityRecord.findMany({
        where: { ...retentionScope, prefixDepth: 0 },
        orderBy: [{ lastUsedAt: "desc" }, { id: "desc" }],
        skip: policy.maxRecords,
        select: { id: true },
      }),
      tx.cacheAffinityRecord.findMany({
        where: { ...retentionScope, prefixDepth: { gt: 0 } },
        orderBy: [{ lastUsedAt: "desc" }, { prefixDepth: "asc" }, { id: "desc" }],
        skip: Math.max(0, policy.maxRecords - snapshotCount),
        select: { id: true },
      }),
    ]);
    const overflowIds = [...new Set([...snapshotOverflow, ...hintOverflow].map(({ id }) => id))];
    if (overflowIds.length) {
      await tx.cacheAffinityRecord.deleteMany({ where: { id: { in: overflowIds } } });
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
