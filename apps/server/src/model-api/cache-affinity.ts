import prisma from "@ws-model-proxy/db";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";

const DIGEST_VERSION = 1;
const MAX_PREFIXES_PER_REQUEST = 64;
const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
};

export type AffinityDecision = {
  orderedTargetIds: string[];
  scores: Record<string, number>;
  prefixDepths: Record<string, number>;
  reasons: Record<string, string>;
  matchedPrefixDepth: number;
};

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

function asJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const values = value.map(asJson);
    return values.some((entry) => entry === undefined) ? undefined : (values as JsonValue[]);
  }
  if (typeof value !== "object") return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    const parsed = asJson(nested);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

const RELEVANT_PARAMETER_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "seed",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning",
  "thinking",
] as const;

/**
 * Produces cumulative canonical prefixes without retaining source material.
 * Array order and content-block/tool order remain significant; object key order
 * does not. Transport-only and client metadata fields are deliberately absent.
 */
export function affinityPrefixDigests({
  ownerId,
  surface,
  payload,
  runtimeIdentity,
}: {
  ownerId: string;
  surface: string;
  payload: Record<string, unknown>;
  runtimeIdentity: string;
}): { digests: string[]; conversationDigest: string | null } {
  const ordered =
    (Array.isArray(payload.input) && payload.input) ||
    (Array.isArray(payload.messages) && payload.messages) ||
    (Array.isArray(payload.prompt) && payload.prompt) ||
    [];
  const instructions = asJson(payload.instructions ?? payload.system);
  const tools = asJson(payload.tools);
  const parameters = Object.fromEntries(
    RELEVANT_PARAMETER_KEYS.flatMap((key) => {
      const value = asJson(payload[key]);
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
  const binding = stableJson({
    v: DIGEST_VERSION,
    ownerId,
    surface,
    runtimeIdentity,
    instructions: instructions ?? null,
    tools: tools ?? null,
    parameters,
  });
  const units = ordered
    .slice(0, MAX_PREFIXES_PER_REQUEST)
    .map(asJson)
    .filter(Boolean) as JsonValue[];
  const digests: string[] = [];
  let cumulative = "";
  for (let index = 0; index < units.length; index += 1) {
    cumulative += `${index}:${stableJson(units[index]!)}\n`;
    if (Buffer.byteLength(cumulative) > MAX_CANONICAL_BYTES) break;
    digests.push(
      hmacDigestForForwarderPurpose({
        purpose: "cacheAffinity",
        value: `${binding}\nprefix:${index + 1}\n${cumulative}`,
      }),
    );
  }
  const conversationSource = asJson(payload.conversation ?? payload.conversation_id);
  return {
    digests,
    conversationDigest:
      conversationSource === undefined
        ? null
        : hmacDigestForForwarderPurpose({
            purpose: "cacheAffinity",
            value: `${binding}\nconversation:${stableJson(conversationSource)}`,
          }),
  };
}

export async function rankAffinityTargets({
  ownerId,
  poolId,
  policy,
  surface,
  payload,
  targets,
  now = new Date(),
}: {
  ownerId: string;
  poolId: string;
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
    reasons: {},
    matchedPrefixDepth: 0,
  };
  if (!policy.enabled || targets.length < 2) return unchanged;

  const materialByIdentity = new Map(
    targets.map((target) => [
      target.targetIdentity,
      affinityPrefixDigests({ ownerId, surface, payload, runtimeIdentity: target.targetIdentity }),
    ]),
  );
  const allDigests = [
    ...new Set([...materialByIdentity.values()].flatMap(({ digests }) => digests)),
  ];
  const conversationDigests = [
    ...new Set(
      [...materialByIdentity.values()].flatMap(({ conversationDigest }) =>
        conversationDigest ? [conversationDigest] : [],
      ),
    ),
  ];
  if (allDigests.length === 0 && conversationDigests.length === 0) return unchanged;

  const [records, activeLoads] = await Promise.all([
    prisma.cacheAffinityRecord.findMany({
      where: {
        userId: ownerId,
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
        prefixDigest: true,
        conversationDigest: true,
        prefixDepth: true,
        engineCacheConfirmed: true,
      },
    }),
    prisma.capacityLease.groupBy({
      by: ["executionTargetId"],
      where: {
        executionTargetId: { in: targets.map(({ executionTargetId }) => executionTargetId) },
        state: "ACTIVE",
        expiresAt: { gt: now },
      },
      _count: { _all: true },
    }),
  ]);
  const loadByTarget = new Map(activeLoads.map((row) => [row.executionTargetId, row._count._all]));
  const scored = targets.map((target, originalIndex) => {
    const material = materialByIdentity.get(target.targetIdentity)!;
    const digestDepth = new Map(material.digests.map((digest, index) => [digest, index + 1]));
    const compatible = records.filter(
      (record) =>
        record.executionTargetId === target.executionTargetId &&
        record.targetIdentity === target.targetIdentity,
    );
    const prefixDepth = compatible.reduce(
      (best, record) => Math.max(best, digestDepth.get(record.prefixDigest) ?? 0),
      0,
    );
    const conversation = compatible.some(
      (record) =>
        material.conversationDigest !== null &&
        record.conversationDigest === material.conversationDigest,
    );
    const confirmed = compatible.some(
      (record) =>
        (digestDepth.get(record.prefixDigest) ?? 0) === prefixDepth && record.engineCacheConfirmed,
    );
    const load = loadByTarget.get(target.executionTargetId) ?? 0;
    const score =
      prefixDepth * policy.prefixWeight +
      (conversation ? policy.conversationWeight : 0) +
      (confirmed ? policy.confirmedCacheWeight : 0) -
      load * policy.loadPenaltyWeight;
    return { target, originalIndex, score, prefixDepth, conversation, confirmed, load };
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
    reasons: Object.fromEntries(
      scored.map(({ target, prefixDepth, conversation, confirmed, load }) => [
        target.executionTargetId,
        `prefix:${prefixDepth};conversation:${conversation};confirmed:${confirmed};load:${load}`,
      ]),
    ),
    matchedPrefixDepth: Math.max(0, ...scored.map(({ prefixDepth }) => prefixDepth)),
  };
}

export async function rememberAffinity({
  ownerId,
  poolId,
  policy,
  surface,
  payload,
  target,
  estimatedTokens,
  engineCacheConfirmed = false,
  now = new Date(),
}: {
  ownerId: string;
  poolId: string;
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
    surface,
    payload,
    runtimeIdentity: target.targetIdentity,
  });
  if (material.digests.length === 0) return;
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  await prisma.$transaction(async (tx) => {
    // Serialize retention enforcement per owner/pool so concurrent successful
    // requests cannot race past the configured bound.
    const lockedPool = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM model_pool
       WHERE id = ${poolId} AND "userId" = ${ownerId}
       FOR UPDATE
    `;
    if (lockedPool.length !== 1) return;
    await tx.cacheAffinityRecord.deleteMany({
      where: { userId: ownerId, poolId, expiresAt: { lte: now } },
    });
    for (const [index, prefixDigest] of material.digests.entries()) {
      await tx.cacheAffinityRecord.upsert({
        where: {
          userId_poolId_executionTargetId_targetIdentity_prefixDigest: {
            userId: ownerId,
            poolId,
            executionTargetId: target.executionTargetId,
            targetIdentity: target.targetIdentity,
            prefixDigest,
          },
        },
        create: {
          userId: ownerId,
          poolId,
          executionTargetId: target.executionTargetId,
          targetIdentity: target.targetIdentity,
          prefixDigest,
          conversationDigest: material.conversationDigest,
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
    const overflow = await tx.cacheAffinityRecord.findMany({
      where: { userId: ownerId, poolId, executionTargetId: target.executionTargetId },
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
