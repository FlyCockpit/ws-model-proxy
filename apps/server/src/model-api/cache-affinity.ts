import { randomUUID } from "node:crypto";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";
import {
  budgetedStableJson,
  CanonicalSizeError,
  type CanonicalWork,
  canonicalizeAffinitySurface,
  continuationEvidence,
  MAX_CANONICAL_BYTES,
  MAX_CANONICAL_DEPTH,
  rawAffinityLayers,
  stableJson,
  visitCanonical,
} from "./cache-affinity-layers.js";
import { requestJsonDepthExceeded } from "./request-json-depth.js";

const DIGEST_VERSION = 5;
const MAX_PREFIXES_PER_REQUEST = 64;
const MAX_INSTRUCTION_PREFIXES = 8;
// Routing-only byte-overflow hints may have no node row. Tag instruction hints
// so a rebase cannot mistake those unproven conversation hints for instructions.
const INSTRUCTION_HINT_PREFIX = "instruction-v5:";

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
   * `resolveAffinitySession`. Absent = a new session on that target.
   */
  matchedSessionIds?: Record<string, string>;
};

/** Durable server-side Responses lineage. Never accepted from request JSON. */
export type AffinitySessionBinding = {
  sessionId: string;
  bindingDigest: string;
  rootDigest: string;
  tipDigest: string;
  tipDepth: number;
  canonicalBytes: number;
  estimatedTokens?: number;
};

export function scopedAffinitySessionId(
  binding: AffinitySessionBinding | null | undefined,
  bindingDigest: string,
): string | undefined {
  return binding?.sessionId &&
    binding.tipDigest &&
    binding.rootDigest &&
    binding.bindingDigest === bindingDigest
    ? binding.sessionId
    : undefined;
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

export const FREE_SAMPLING_PARAMS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "typical_p",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "logit_bias",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "n",
  "best_of",
] as const;
const PARAMETER_EXCLUSIONS = new Set(["model", "stream", ...FREE_SAMPLING_PARAMS]);

type ClientConversationCarrier = { id: string; key?: string };

/** Select once: only the winning valid body carrier is free of root binding. */
function selectClientConversationCarrier(
  headers: Headers | undefined,
  payload: Record<string, unknown>,
  surface: string,
): ClientConversationCarrier | undefined {
  const validate = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const id = value.trim();
    // The + charset quantifier also rejects an empty trimmed id.
    return id.length <= 256 && /^[A-Za-z0-9._:/@=+-]+$/.test(id) ? id : undefined;
  };
  const conversationId = (value: unknown) =>
    validate(
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).id
        : value,
    );
  const canonicalSurface = canonicalizeAffinitySurface(surface);
  const candidates: { id: string | undefined; key?: string }[] = [
    { id: conversationId(payload.conversation), key: "conversation" },
    { id: conversationId(payload.conversation_id), key: "conversation_id" },
    {
      id:
        canonicalSurface === "openai-chat" || canonicalSurface === "openai-responses"
          ? validate(payload.prompt_cache_key)
          : undefined,
      key: "prompt_cache_key",
    },
    ...[
      "x-conversation-id",
      "session_id",
      "session-id",
      "x-session-id",
      "x-claude-code-session-id",
    ].map((name) => ({ id: validate(headers?.get(name)) })),
  ];
  if (canonicalSurface === "anthropic-messages") {
    const metadata = payload.metadata;
    const userId =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).user_id
        : undefined;
    if (typeof userId === "string") {
      // Only Claude Code's embedded session token, never an account-wide user id.
      candidates.push({
        id: userId.match(
          /_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[^A-Za-z0-9-])/i,
        )?.[1],
        key: "metadata.user_id",
      });
    }
  }
  const winner = candidates.find((candidate) => candidate.id !== undefined);
  return winner?.id === undefined ? undefined : { id: winner.id, key: winner.key };
}

/** Request-only carriers, in owner-approved priority order. Invalid values fall through. */
export function extractClientConversationId(
  headers: Headers | undefined,
  payload: Record<string, unknown>,
  surface: string,
): string | undefined {
  return selectClientConversationCarrier(headers, payload, surface)?.id;
}

function sessionFootprintDigest(bindingDigest: string, sessionId: string) {
  return hmacValue(`affinity-session-v5:${bindingDigest}:${sessionId}`);
}

// Bounds the extra affinity delay before Responses EOF; routes fail closed on rejection.
export const AFFINITY_TRANSACTION_LIMITS = { maxWait: 2000, timeout: 2500 } as const;
export const AFFINITY_EXPIRY_BATCH = 200;

function hmacValue(value: string) {
  return hmacDigestForForwarderPurpose({ purpose: "cacheAffinity", value });
}

function cumulativePrefixDigests(
  units: string[],
  encode: (index: number, cumulative: string) => string,
) {
  const digests: string[] = [];
  let cumulative = "";
  for (let index = 0; index < units.length; index += 1) {
    cumulative += `${index}:${units[index]!}\n`;
    if (Buffer.byteLength(cumulative) > MAX_CANONICAL_BYTES) break;
    digests.push(encode(index + 1, cumulative));
  }
  return digests;
}

export type AffinityMaterial = {
  bindingDigest: string;
  rootDigest: string;
  instructionDigests: string[];
  digests: string[];
  /** Complete-chain nodes only: the resolver must never see a truncated chain. */
  nodes: { digest: string; depth: number }[];
  /** Last <=64 under-cap chain nodes for routing; size refusal keeps them, depth/errors do not. */
  routingNodes: { digest: string; depth: number }[];
  conversationDigest: string | null;
  hasExplicitConversation: boolean;
  isContinuation: boolean;
  identifiable: boolean;
  canonicalBytes: number;
  clientSessionId?: string;
  boundSessionId?: string;
  missingParent: boolean;
  parentTipDigest?: string;
  parentTipDepth?: number;
};

function unidentifiableMaterial(canonicalBytes = MAX_CANONICAL_BYTES + 1): AffinityMaterial {
  return {
    bindingDigest: "",
    rootDigest: "",
    instructionDigests: [],
    digests: [],
    nodes: [],
    routingNodes: [],
    conversationDigest: null,
    hasExplicitConversation: false,
    isContinuation: false,
    identifiable: false,
    canonicalBytes,
    missingParent: false,
  };
}

type AffinityRequestArgs = {
  ownerId: string;
  resourceOwnerId: string;
  poolId: string;
  securityScope?: string;
  accessGrantId?: string | null;
  surface: string;
  payload: Record<string, unknown>;
  runtimeIdentity: string;
  sessionBinding?: AffinitySessionBinding;
  headers?: Headers;
};

type CanonicalRequest = {
  surface: ReturnType<typeof canonicalizeAffinitySurface>;
  carrier: ClientConversationCarrier | undefined;
  instructions: string[];
  tools: string | undefined;
  rootSuffix: string;
  rootBytes: number;
  hasRootFields: boolean;
  conversationUnits: string[];
  conversationOverflow: boolean;
  isContinuation: boolean;
  conversation: string | undefined;
  previousResponse: boolean;
};

/** Once per request; all request-derived traversal shares an 8 * 2 MiB node cap. */
export function buildCanonicalRequest(
  { surface, payload, headers }: Pick<AffinityRequestArgs, "surface" | "payload" | "headers">,
  work: CanonicalWork = { steps: 0 },
): CanonicalRequest | null {
  try {
    if (requestJsonDepthExceeded(payload, MAX_CANONICAL_DEPTH, () => visitCanonical(work)))
      return null;
    const canonicalSurface = canonicalizeAffinitySurface(surface);
    if (!canonicalSurface) return null;
    const layers = rawAffinityLayers(canonicalSurface, payload, work);
    const carrier = selectClientConversationCarrier(headers, payload, surface);
    const excluded = new Set([...layers.consumedKeys, ...PARAMETER_EXCLUSIONS]);
    if (carrier?.key && carrier.key !== "metadata.user_id") excluded.add(carrier.key);
    const instructions: string[] = [];
    let instructionBytes = 2;
    let rootOverflow = false;
    const encode = (value: unknown, bytes: number): string | undefined => {
      try {
        return budgetedStableJson(value, bytes, work);
      } catch (error) {
        if (!(error instanceof CanonicalSizeError)) throw error;
        return undefined;
      }
    };
    for (const unit of layers.instructions()) {
      const text = encode(
        unit,
        MAX_CANONICAL_BYTES - instructionBytes - (instructions.length ? 1 : 0),
      );
      if (text === undefined) {
        rootOverflow = true;
        break;
      }
      instructionBytes += Buffer.byteLength(text) + (instructions.length ? 1 : 0);
      instructions.push(text);
    }
    const start = `{"bindingDigest":"${"x".repeat(43)}"`;
    const beforeParams = `,"instructions":[${instructions.join(",")}],"parameters":`;
    const rootFrameBytes =
      Buffer.byteLength(start) +
      Buffer.byteLength(beforeParams) +
      Buffer.byteLength(',"tools":}') +
      2;
    const tools =
      layers.tools === undefined
        ? undefined
        : encode(layers.tools, MAX_CANONICAL_BYTES - rootFrameBytes);
    if (layers.tools !== undefined && tools === undefined) rootOverflow = true;
    const parameters: Record<string, unknown> = Object.create(null);
    let parameterKeyBytes = 2;
    const parameterBudget =
      MAX_CANONICAL_BYTES - rootFrameBytes - Buffer.byteLength(tools ?? "null") + 2;
    let hasParameters = false;
    for (const key in payload) {
      if (rootOverflow) break;
      if (!Object.hasOwn(payload, key) || excluded.has(key)) continue;
      visitCanonical(work);
      const encodedKey = encode(key, parameterBudget - parameterKeyBytes);
      if (encodedKey === undefined) {
        rootOverflow = true;
        break;
      }
      parameterKeyBytes += Buffer.byteLength(encodedKey) + 3;
      if (parameterKeyBytes > parameterBudget) {
        rootOverflow = true;
        break;
      }
      let raw = payload[key];
      if (raw === undefined || typeof raw === "function" || typeof raw === "symbol") continue;
      if (
        carrier?.key === "metadata.user_id" &&
        key === "metadata" &&
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw)
      ) {
        const metadata: Record<string, unknown> = Object.create(null);
        for (const name in raw) {
          if (!Object.hasOwn(raw, name) || name === "user_id") continue;
          visitCanonical(work);
          const text = encode(name, parameterBudget - parameterKeyBytes);
          if (text === undefined) {
            rootOverflow = true;
            break;
          }
          parameterKeyBytes += Buffer.byteLength(text) + 3;
          metadata[name] = (raw as Record<string, unknown>)[name];
        }
        if (Object.keys(metadata).length === 0) {
          hasParameters = Object.keys(parameters).length > 0;
          continue;
        }
        raw = metadata;
      }
      parameters[key] = raw;
      hasParameters = true;
    }
    // SHA-256 base64url binding digests are always 43 ASCII bytes. The suffix is
    // target-independent and exactly the previous stableJson root byte sequence.
    const afterParams = `,"tools":${tools ?? "null"}}`;
    const parameterText = rootOverflow
      ? undefined
      : encode(
          parameters,
          MAX_CANONICAL_BYTES -
            Buffer.byteLength(start) -
            Buffer.byteLength(beforeParams) -
            Buffer.byteLength(afterParams),
        );
    if (parameterText === undefined) rootOverflow = true;
    const rootSuffix = rootOverflow ? "" : `${beforeParams}${parameterText}${afterParams}`;
    const rootBytes = rootOverflow
      ? MAX_CANONICAL_BYTES + 1
      : Buffer.byteLength(start) + Buffer.byteLength(rootSuffix);
    const conversationUnits: string[] = [];
    let bytes = rootBytes;
    let conversationOverflow = rootOverflow;
    if (!rootOverflow) {
      for (const unit of layers.conversation()) {
        if (conversationUnits.length === 4096) {
          conversationOverflow = true;
          break;
        }
        const text = encode(unit, MAX_CANONICAL_BYTES - bytes);
        if (text === undefined) {
          conversationOverflow = true;
          break;
        }
        bytes += Buffer.byteLength(text);
        conversationUnits.push(text);
      }
    }
    const isContinuation = continuationEvidence(layers.conversation(), work);
    const forwardedValue = (value: unknown) =>
      typeof value === "number" && !Number.isFinite(value) ? null : value;
    const conversationValue =
      forwardedValue(payload.conversation) ?? forwardedValue(payload.conversation_id);
    const conversation =
      conversationValue === undefined ? undefined : encode(conversationValue, MAX_CANONICAL_BYTES);
    return {
      surface: canonicalSurface,
      carrier,
      instructions,
      tools,
      rootSuffix,
      rootBytes,
      hasRootFields:
        instructions.length > 0 || rootOverflow || layers.tools !== undefined || hasParameters,
      conversationUnits,
      conversationOverflow,
      isContinuation,
      conversation,
      previousResponse:
        canonicalSurface === "openai-responses" && typeof payload.previous_response_id === "string",
    };
  } catch {
    return null;
  }
}

/** Advisory identity must never reject a served request or expose partial material. */
export function affinityPrefixDigests(args: AffinityRequestArgs): AffinityMaterial {
  const canonical = buildCanonicalRequest(args);
  return materialFromCanonical(args, canonical);
}

function materialFromCanonical(
  args: AffinityRequestArgs,
  canonical: CanonicalRequest | null,
): AffinityMaterial {
  try {
    return canonical ? buildAffinityMaterial(args, canonical) : unidentifiableMaterial();
  } catch {
    return unidentifiableMaterial();
  }
}

/** One chain for both routing warmth and session continuity; only its tail is retained. */
function buildAffinityMaterial(
  {
    ownerId,
    resourceOwnerId,
    poolId,
    securityScope,
    accessGrantId,
    surface,
    runtimeIdentity,
    sessionBinding,
  }: AffinityRequestArgs,
  canonical: CanonicalRequest,
): AffinityMaterial {
  const canonicalSurface = canonical.surface;
  const carrier = canonical.carrier;
  const bindingDigest = hmacValue(
    `affinity-binding-v5:${stableJson({
      v: DIGEST_VERSION,
      ownerId,
      resourceOwnerId,
      poolId,
      securityScope: securityScope ?? ownerId,
      accessGrantId: accessGrantId ?? null,
      surface: canonicalSurface ?? surface,
      runtimeIdentity,
    })}`,
  );
  const clientId = carrier?.id;
  const clientSessionId =
    clientId === undefined
      ? undefined
      : hmacValue(`affinity-client-session-v5:${stableJson({ bindingDigest, id: clientId })}`);
  const rootMaterial = `{"bindingDigest":"${bindingDigest}"${canonical.rootSuffix}`;
  const rootBytes = canonical.rootBytes;
  const computedRoot =
    rootBytes <= MAX_CANONICAL_BYTES ? hmacValue(`affinity-root-v5:${rootMaterial}`) : "";
  const parent = canonical.previousResponse ? sessionBinding : undefined;
  const scopedParent = scopedAffinitySessionId(parent, bindingDigest);
  const hasRootFields = canonical.hasRootFields;
  const boundSessionId =
    scopedParent && (!hasRootFields || computedRoot === parent?.rootDigest)
      ? scopedParent
      : undefined;
  const rootDigest = boundSessionId && parent ? parent.rootDigest : computedRoot;
  let canonicalBytes = boundSessionId && parent ? parent.canonicalBytes : rootBytes;
  let depth = boundSessionId && parent ? parent.tipDepth : 0;
  let tip = boundSessionId && parent ? parent.tipDigest : rootDigest;
  const nodes: AffinityMaterial["nodes"] = [];
  let identifiable = canonicalSurface !== null && canonicalBytes <= MAX_CANONICAL_BYTES;
  for (const unit of canonical.conversationUnits) {
    if (!identifiable) break;
    canonicalBytes += Buffer.byteLength(unit);
    if (canonicalBytes > MAX_CANONICAL_BYTES) {
      identifiable = false;
      break;
    }
    depth += 1;
    tip = hmacValue(`affinity-node-v5:${tip}:${unit}`);
    nodes.push({ digest: tip, depth });
    if (nodes.length > MAX_PREFIXES_PER_REQUEST) nodes.shift();
  }
  if (canonical.conversationOverflow && identifiable) {
    canonicalBytes = MAX_CANONICAL_BYTES + 1;
    identifiable = false;
  }
  const missingParent = canonical.previousResponse && !boundSessionId;
  // An unbound native delta is not full history. Do not publish it as a
  // starter that a later stateless request could mistakenly take as a tip.
  if (missingParent) identifiable = false;
  const routingNodes = missingParent ? [] : [...nodes];
  if (boundSessionId && parent && nodes.length === 0) {
    // An empty native delta still refreshes the committed parent tip and size.
    if (identifiable) nodes.push({ digest: parent.tipDigest, depth: parent.tipDepth });
    routingNodes.push({ digest: parent.tipDigest, depth: parent.tipDepth });
  }
  if (!identifiable) nodes.length = 0;
  const textCap =
    canonical.tools !== undefined ? MAX_INSTRUCTION_PREFIXES - 1 : MAX_INSTRUCTION_PREFIXES;
  const instructionUnits =
    canonical.tools !== undefined
      ? [...canonical.instructions.slice(0, textCap), canonical.tools]
      : canonical.instructions.slice(0, textCap);
  const instructionDigests = cumulativePrefixDigests(
    instructionUnits,
    (index, cumulative) =>
      `${INSTRUCTION_HINT_PREFIX}${hmacValue(`instruction-layer-v5:${bindingDigest}:prefix:${index}:${cumulative}`)}`,
  );
  const conversation = canonical.conversation;
  return {
    bindingDigest,
    rootDigest,
    instructionDigests,
    nodes,
    routingNodes,
    digests: routingNodes.map(({ digest }) => digest),
    canonicalBytes,
    identifiable,
    isContinuation: canonical.isContinuation || boundSessionId !== undefined,
    clientSessionId,
    boundSessionId: identifiable ? boundSessionId : undefined,
    missingParent,
    parentTipDigest: identifiable && boundSessionId ? parent?.tipDigest : undefined,
    parentTipDepth: identifiable && boundSessionId ? parent?.tipDepth : undefined,
    hasExplicitConversation: conversation !== undefined,
    conversationDigest:
      !identifiable || conversation === undefined
        ? null
        : hmacValue(`affinity-conversation-v5:${rootDigest}:${conversation}`),
  };
}

type IdentityDb = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  cacheAffinityNode: Pick<Prisma.TransactionClient["cacheAffinityNode"], "findFirst">;
};
type IdentityScope = {
  userId: string;
  tenantUserId: string;
  poolId: string;
  executionTargetId: string;
};

/**
 * Full-key range and index order allow a bounded seek even when PostgreSQL
 * underestimates correlated tenant/pool predicates. Both endpoints have the
 * same security/root/node/tip prefix, so only expiry/session break the tie.
 */
// Ancestors use this index order only for a bounded walk: two owners always
// mean ambiguity, regardless of their expiry/session order or tip flag.
export function affinityNodeProbeSql(
  scope: IdentityScope,
  rootDigest: string,
  digest: Prisma.Sql,
  isTip: boolean,
  now: Date,
  limit: number,
  gate: Prisma.Sql = Prisma.empty,
): Prisma.Sql {
  return Prisma.sql`SELECT "sessionId" FROM cache_affinity_node
    WHERE ${gate}
      ("userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", "isTip", "expiresAt")
      > (${scope.userId}, ${scope.tenantUserId}, ${scope.poolId}, ${scope.executionTargetId}, ${rootDigest}, ${digest}, ${isTip}, ${now}::timestamp)
      AND ("userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", "isTip", "expiresAt")
      <= (${scope.userId}, ${scope.tenantUserId}, ${scope.poolId}, ${scope.executionTargetId}, ${rootDigest}, ${digest}, ${isTip}, 'infinity'::timestamp)
    ORDER BY "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", "isTip"${isTip ? Prisma.sql`, "expiresAt", "sessionId"` : Prisma.empty}
    LIMIT ${limit}`;
}

/** Bounded LRU index walk, also when scope columns are highly correlated. */
export function affinityRetentionSql(scope: IdentityScope, maxRecords: number): Prisma.Sql {
  return Prisma.sql`SELECT id, "sessionId", "prefixDigest", "expiresAt" FROM cache_affinity_record
    WHERE ("userId", "tenantUserId", "poolId", "executionTargetId", "lastUsedAt")
      > (${scope.userId}, ${scope.tenantUserId}, ${scope.poolId}, ${scope.executionTargetId}, '-infinity'::timestamp)
      AND ("userId", "tenantUserId", "poolId", "executionTargetId", "lastUsedAt")
      <= (${scope.userId}, ${scope.tenantUserId}, ${scope.poolId}, ${scope.executionTargetId}, 'infinity'::timestamp)
    ORDER BY "userId" DESC, "tenantUserId" DESC, "poolId" DESC, "executionTargetId" DESC, "lastUsedAt" DESC, id DESC
    LIMIT ${AFFINITY_EXPIRY_BATCH} OFFSET ${maxRecords}`;
}

/**
 * ONE identity enforcement point: rank predicts; remember rereads after its sole
 * cacheAffinity fence. Equality-seek in index order, LIMIT 1 / 2, never a history
 * population scan. User-only and leading-greeting starters stay fresh: a new starter is indistinguishable
 * from truncation to that starter. Fail closed in this residual case; truncations
 * retaining conversation evidence can link. Root/instruction-only warmth never links.
 */
export async function resolveAffinitySession(
  db: IdentityDb,
  scope: IdentityScope,
  material: AffinityMaterial,
  now: Date,
): Promise<string | null> {
  if (material.clientSessionId) return material.clientSessionId;
  if (
    !material.identifiable ||
    material.nodes.length === 0 ||
    material.missingParent ||
    !material.isContinuation
  )
    return null;
  if (material.boundSessionId) {
    const parent = await db.cacheAffinityNode.findFirst({
      where: {
        ...scope,
        rootDigest: material.rootDigest,
        sessionId: material.boundSessionId,
        nodeDigest: material.parentTipDigest,
        expiresAt: { gt: now },
      },
      select: { sessionId: true },
    });
    return parent?.sessionId ?? null;
  }
  // Same deepest-node, tips-first, sole-ancestor rule, in one bounded round trip.
  // Each lateral probe remains an equality seek in index order with LIMIT 1/2.
  const matches = await db.$queryRaw<{ sessionId: string | null }[]>(
    affinityIdentityProbeSql(scope, material, now),
  );
  return matches[0]?.sessionId ?? null;
}

/** Shared query text: diagnostics must explain the same query the resolver executes. */
export function affinityIdentityProbeSql(
  scope: IdentityScope,
  material: AffinityMaterial,
  now: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT CASE WHEN tips."sessionId" IS NOT NULL THEN tips."sessionId"
                WHEN cardinality(ancestors.sessions) = 1 THEN ancestors.sessions[1]
                ELSE NULL END AS "sessionId"
      FROM jsonb_to_recordset(${JSON.stringify(material.nodes)}::jsonb) AS p(digest text, depth int)
      LEFT JOIN LATERAL (
        ${affinityNodeProbeSql(scope, material.rootDigest, Prisma.sql`p.digest`, true, now, 1)}
      ) tips ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(a."sessionId") AS sessions FROM (
          ${affinityNodeProbeSql(scope, material.rootDigest, Prisma.sql`p.digest`, false, now, 2, Prisma.sql`tips."sessionId" IS NULL AND`)}
        ) a
      ) ancestors ON true
     WHERE tips."sessionId" IS NOT NULL OR cardinality(ancestors.sessions) > 0
     ORDER BY p.depth DESC LIMIT 1`;
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
  sessionBinding,
  headers,
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
  sessionBinding?: AffinitySessionBinding;
  headers?: Headers;
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

  const canonical = buildCanonicalRequest({ surface, payload, headers });
  const materialByIdentity = new Map(
    targets.map((target) => [
      target.targetIdentity,
      materialFromCanonical(
        {
          ownerId,
          resourceOwnerId,
          poolId,
          securityScope: securityScope ?? ownerId,
          accessGrantId,
          surface,
          payload,
          runtimeIdentity: target.targetIdentity,
          sessionBinding,
          headers,
        },
        canonical,
      ),
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
      [...materialByIdentity.values()].flatMap((material) => [
        ...(material.conversationDigest ? [material.conversationDigest] : []),
        ...(material.clientSessionId
          ? [sessionFootprintDigest(material.bindingDigest, material.clientSessionId)]
          : []),
      ]),
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
  const scored = await Promise.all(
    targets.map(async (target, originalIndex) => {
      const material = materialByIdentity.get(target.targetIdentity)!;
      const conversationDepthByDigest = new Map(
        material.routingNodes.map(({ digest, depth }) => [digest, depth]),
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
      const conversation = compatible.some(
        (record) =>
          (material.clientSessionId !== undefined &&
            record.sessionId === material.clientSessionId) ||
          (material.hasExplicitConversation &&
            record.conversationDigest === material.conversationDigest),
      );
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
          ? compatible.find((record) =>
              material.clientSessionId
                ? record.sessionId === material.clientSessionId
                : record.conversationDigest === material.conversationDigest,
            )
          : undefined);
      const prefixTokens = matchedRecord?.estimatedTokens ?? undefined;
      const sessionId = await resolveAffinitySession(
        prisma,
        {
          userId: resourceOwnerId,
          tenantUserId: ownerId,
          poolId,
          executionTargetId: target.executionTargetId,
        },
        material,
        now,
      );
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
    }),
  );
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

export function isAffinityTargetWarm(
  decision: Pick<AffinityDecision, "prefixDepths" | "conversationMatches">,
  executionTargetId: string,
): boolean {
  return (
    (decision.prefixDepths[executionTargetId] ?? 0) > 0 ||
    decision.conversationMatches[executionTargetId] === true
  );
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
  estimatedDeltaTokens,
  engineCacheConfirmed,
  sessionBinding,
  headers,
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
  /** Bound Responses delta estimate computed before dispatch, never at EOF. */
  estimatedDeltaTokens?: number;
  /**
   * Latest engine cache evidence from the served response. `true` (cached
   * prompt tokens reported) and `false` (cache fields reported with zero)
   * overwrite the stored flag; `undefined` (provider does not report cache
   * usage) leaves any previously stored value untouched.
   */
  engineCacheConfirmed?: boolean;
  /** Internal native Responses continuation, read only from the durable sticky row. */
  sessionBinding?: AffinitySessionBinding;
  headers?: Headers;
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
    sessionBinding,
    headers,
  });
  if (
    material.instructionDigests.length === 0 &&
    material.routingNodes.length === 0 &&
    !material.conversationDigest &&
    !material.clientSessionId
  )
    return null;
  if (material.boundSessionId && sessionBinding?.estimatedTokens !== undefined) {
    estimatedTokens = Math.min(
      2_147_483_647,
      sessionBinding.estimatedTokens + (estimatedDeltaTokens ?? 0),
    );
  }
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  // Every record this call writes (created or refreshed) carries the same
  // `lastUsedAt` and `sessionId`: warm-session protection (S-C,
  // ./warm-protection.ts) groups records into one session by the id, dates it
  // by its newest record and sizes it by that instant's `estimatedTokens`.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
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
    // Bitmap plans materialize the full scope before LIMIT. Keep these bounded
    // lookups as streaming index walks; the setting ends with this transaction.
    await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
    // ARRAY makes deletion a primary-key lookup of the bounded ids; an IN
    // subquery can become a population-scanning semi-join under misestimation.
    // Class S drains the backlog; completion only takes an indexed batch from
    // each table while holding the owner/pool fence.
    await tx.$executeRaw`DELETE FROM cache_affinity_record WHERE id = ANY(ARRAY(
      SELECT id FROM cache_affinity_record
      WHERE ("userId", "tenantUserId", "poolId", "expiresAt")
        > (${resourceOwnerId}, ${ownerId}, ${poolId}, '-infinity'::timestamp)
        AND ("userId", "tenantUserId", "poolId", "expiresAt")
        <= (${resourceOwnerId}, ${ownerId}, ${poolId}, ${now}::timestamp)
      ORDER BY "userId", "tenantUserId", "poolId", "expiresAt" LIMIT ${AFFINITY_EXPIRY_BATCH} FOR UPDATE SKIP LOCKED))`;
    await tx.$executeRaw`DELETE FROM cache_affinity_node WHERE id = ANY(ARRAY(
      SELECT id FROM cache_affinity_node
      WHERE ("userId", "tenantUserId", "poolId", "expiresAt")
        > (${resourceOwnerId}, ${ownerId}, ${poolId}, '-infinity'::timestamp)
        AND ("userId", "tenantUserId", "poolId", "expiresAt")
        <= (${resourceOwnerId}, ${ownerId}, ${poolId}, ${now}::timestamp)
      ORDER BY "userId", "tenantUserId", "poolId", "expiresAt" LIMIT ${AFFINITY_EXPIRY_BATCH} FOR UPDATE SKIP LOCKED))`;
    const scope = {
      userId: resourceOwnerId,
      tenantUserId: ownerId,
      poolId,
      executionTargetId: target.executionTargetId,
    };
    const sessionId = (await resolveAffinitySession(tx, scope, material, now)) ?? randomUUID();
    // Refresh <=64 retained rows; insert only delta nodes. Edits discard the old
    // branch. The fence was acquired before all reads; no graph locks or effects.
    const existingNodes = material.identifiable
      ? await tx.cacheAffinityNode.findMany({
          where: { ...scope, sessionId, expiresAt: { gt: now } },
          select: { nodeDigest: true, depth: true, rootDigest: true },
        })
      : [];
    const parentNodes = material.boundSessionId
      ? material.boundSessionId === sessionId
        ? existingNodes
        : await tx.cacheAffinityNode.findMany({
            where: { ...scope, sessionId: material.boundSessionId, expiresAt: { gt: now } },
            select: { nodeDigest: true, depth: true, rootDigest: true },
          })
      : [];
    // A same-root rewrite can replace even this session's chain. The durable
    // binding alone proves the parent tip, not ancestry of the current rows.
    const parentChainProven = parentNodes.some(
      (node) =>
        node.rootDigest === material.rootDigest &&
        node.nodeDigest === material.parentTipDigest &&
        node.depth === material.parentTipDepth,
    );
    const combined = [
      ...(parentChainProven
        ? parentNodes
            .filter(
              (node) =>
                node.rootDigest === material.rootDigest &&
                node.depth <= (material.parentTipDepth ?? 0),
            )
            .map(({ nodeDigest, depth }) => ({ digest: nodeDigest, depth }))
        : []),
      ...material.nodes,
    ];
    const retained = [...new Map(combined.map((node) => [node.digest, node])).values()]
      .sort((a, b) => b.depth - a.depth)
      .slice(0, MAX_PREFIXES_PER_REQUEST);
    const retainedDigests = retained.map((node) => node.digest);
    if (material.identifiable) {
      await tx.cacheAffinityNode.deleteMany({
        where: { ...scope, sessionId, nodeDigest: { notIn: retainedDigests } },
      });
      await tx.cacheAffinityNode.updateMany({
        where: { ...scope, sessionId },
        data: { isTip: false, expiresAt },
      });
    }
    const tip = material.nodes.at(-1);
    if (tip) {
      const oldDigests = new Set(existingNodes.map((node) => node.nodeDigest));
      const inserts = retained.filter(
        (node) => !oldDigests.has(node.digest) || node.digest === tip.digest,
      );
      if (inserts.length)
        await tx.$executeRaw(Prisma.sql`
        INSERT INTO cache_affinity_node
          (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest",
           "nodeDigest", depth, "sessionId", "isTip", "expiresAt") VALUES
          ${Prisma.join(
            inserts.map(
              (node) => Prisma.sql`(${randomUUID()}, ${resourceOwnerId},
            ${ownerId}, ${poolId}, ${target.executionTargetId}, ${material.rootDigest},
            ${node.digest}, ${node.depth}, ${sessionId}, ${node.digest === tip.digest}, ${expiresAt})`,
            ),
          )}
        ON CONFLICT ("userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", "sessionId")
        DO UPDATE SET "isTip" = EXCLUDED."isTip", "expiresAt" = EXCLUDED."expiresAt"`);
    }
    // Read the discarded node digests under the same fence before pruning hints.
    // Instruction hints have no node row, so omitted instructions remain matchable.
    const discardedDigests = existingNodes
      .filter((node) => !retainedDigests.includes(node.nodeDigest))
      .map((node) => node.nodeDigest);
    if (discardedDigests.length)
      await tx.cacheAffinityRecord.deleteMany({
        where: {
          ...scope,
          sessionId,
          prefixDigest: { in: discardedDigests },
        },
      });
    const rebased =
      material.identifiable &&
      (material.boundSessionId
        ? material.boundSessionId !== sessionId || !parentChainProven
        : existingNodes.some((node) => node.rootDigest !== material.rootDigest));
    const inheritedInstructions =
      rebased && parentChainProven
        ? await tx.cacheAffinityRecord.findMany({
            where: {
              ...scope,
              sessionId: {
                in: [
                  material.boundSessionId!,
                  ...(existingNodes.length > 0 &&
                  existingNodes.every((node) => node.rootDigest === material.rootDigest)
                    ? [sessionId]
                    : []),
                ],
              },
              targetIdentity: target.targetIdentity,
              bindingDigest: material.bindingDigest,
              expiresAt: { gt: now },
              prefixDigest: {
                not: null,
                startsWith: INSTRUCTION_HINT_PREFIX,
              },
            },
            select: { prefixDigest: true, prefixDepth: true },
            take: MAX_INSTRUCTION_PREFIXES,
          })
        : [];
    if (rebased) {
      // Same-root instructions also remain valid when their shared record was
      // last stamped by the chosen client. Conversation hints require parent proof.
      // Chosen-client rows describe its old branch and cannot establish ancestry.
      await tx.cacheAffinityRecord.deleteMany({
        where: {
          ...scope,
          sessionId,
          prefixDigest: {
            not: null,
            notIn: [
              ...retainedDigests,
              ...material.instructionDigests,
              ...inheritedInstructions.flatMap((row) =>
                row.prefixDigest ? [row.prefixDigest] : [],
              ),
            ],
          },
        },
      });
    }
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
    const prefixes = [
      ...new Map(
        [
          ...material.instructionDigests.map((digest, index) => ({ digest, depth: index + 1 })),
          ...inheritedInstructions.flatMap((row) =>
            row.prefixDigest ? [{ digest: row.prefixDigest, depth: row.prefixDepth }] : [],
          ),
          ...(material.boundSessionId ? retained : material.routingNodes),
        ].map((node) => [node.digest, node]),
      ).values(),
    ];
    // Small requests avoid bulk serialization; large histories use one statement,
    // never 64 sequential upserts while holding the owner/pool fence.
    if (prefixes.length < 8) {
      for (const { digest, depth } of prefixes) await upsertPrefix(digest, depth);
    } else {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO cache_affinity_record
          (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity",
           "bindingDigest", "prefixDigest", "conversationDigest", "sessionId", "prefixDepth",
           "digestVersion", "estimatedTokens", "engineCacheConfirmed", "lastUsedAt", "expiresAt")
        SELECT p.id, ${resourceOwnerId}, ${ownerId}, ${poolId}, ${target.executionTargetId},
          ${target.targetIdentity}, ${material.bindingDigest}, p.digest, NULL, ${sessionId}, p.depth,
          ${DIGEST_VERSION}, ${estimatedTokens ?? null}, ${engineCacheConfirmed ?? false}, ${now}, ${expiresAt}
        FROM jsonb_to_recordset(${JSON.stringify(prefixes.map((node) => ({ id: randomUUID(), ...node })))}::jsonb)
          AS p(id text, digest text, depth int)
        ON CONFLICT ("tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "prefixDigest")
        DO UPDATE SET "sessionId" = EXCLUDED."sessionId", "lastUsedAt" = EXCLUDED."lastUsedAt",
          "expiresAt" = EXCLUDED."expiresAt", "estimatedTokens" = COALESCE(EXCLUDED."estimatedTokens", cache_affinity_record."estimatedTokens"),
          "engineCacheConfirmed" = COALESCE(${engineCacheConfirmed ?? null}::boolean, cache_affinity_record."engineCacheConfirmed")`);
    }
    const upsertConversation = async (conversationDigest: string) => {
      // Use the partial unique index directly. A nullable-prefix ORM lookup
      // can choose a population scan before inserting a new footprint.
      await tx.$executeRaw`INSERT INTO cache_affinity_record
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity",
         "bindingDigest", "prefixDigest", "conversationDigest", "sessionId", "prefixDepth",
         "digestVersion", "estimatedTokens", "engineCacheConfirmed", "lastUsedAt", "expiresAt")
        VALUES (${randomUUID()}, ${resourceOwnerId}, ${ownerId}, ${poolId},
          ${target.executionTargetId}, ${target.targetIdentity}, ${material.bindingDigest},
          NULL, ${conversationDigest}, ${sessionId}, 0, ${DIGEST_VERSION},
          ${estimatedTokens ?? null}, ${engineCacheConfirmed ?? false}, ${now}, ${expiresAt})
        ON CONFLICT ("tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest")
        WHERE "conversationDigest" IS NOT NULL AND "prefixDigest" IS NULL
        DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt", "expiresAt" = EXCLUDED."expiresAt",
          "sessionId" = EXCLUDED."sessionId", "estimatedTokens" = COALESCE(EXCLUDED."estimatedTokens", cache_affinity_record."estimatedTokens"),
          "engineCacheConfirmed" = COALESCE(${engineCacheConfirmed ?? null}::boolean, cache_affinity_record."engineCacheConfirmed")`;
    };
    // Independent footprint prevents shared routing hints from erasing a sibling.
    if (material.identifiable || material.clientSessionId)
      await upsertConversation(sessionFootprintDigest(material.bindingDigest, sessionId));
    if (material.conversationDigest) await upsertConversation(material.conversationDigest);
    // Normal writes add <=74 hints. A lowered cap or legacy backlog drains
    // across completions instead of extending one fenced transaction.
    // Underestimated correlated scopes can choose a population sort (including
    // Incremental Sort) on a shorter index. Use the ordered retention index.
    // Apply this after identity resolution, whose <=64-node sort stays cheap.
    await tx.$executeRaw`SET LOCAL enable_sort = off`;
    await tx.$executeRaw`SET LOCAL enable_incremental_sort = off`;
    const overflowCandidates = await tx.$queryRaw<
      { id: string; sessionId: string; prefixDigest: string | null; expiresAt: Date }[]
    >(affinityRetentionSql(scope, policy.maxRecords));
    // Filter after the bounded index walk. Filtering expiry in the walk can
    // scan an entire expired backlog to discover there are no more live rows.
    const overflow = overflowCandidates.filter((row) => row.expiresAt > now);
    if (overflow.length) {
      await tx.cacheAffinityRecord.deleteMany({
        where: { id: { in: overflow.map(({ id }) => id) } },
      });
    }
    // Evict nodes with their footprint, even if old routing hints remain.
    // Otherwise a later hint overwrite could strand an unbounded orphan session.
    // Losing an explicit hint at the record bound is conservatively treated
    // the same way: retention pressure may split identity, never merge it.
    const lostFootprints = new Set(
      overflow.filter((row) => row.prefixDigest === null).map((row) => row.sessionId),
    );
    const evictedSessions = [...new Set(overflow.map((row) => row.sessionId))];
    const orphanCandidates = evictedSessions.filter((session) => !lostFootprints.has(session));
    // Keep unconditional footprint eviction separate. OFFSET 0 below preserves
    // a per-session existence probe instead of hashing the entire record table.
    if (lostFootprints.size)
      await tx.$executeRaw(Prisma.sql`
      DELETE FROM cache_affinity_node n
      WHERE n."userId" = ${resourceOwnerId} AND n."tenantUserId" = ${ownerId}
        AND n."poolId" = ${poolId} AND n."executionTargetId" = ${target.executionTargetId}
        AND n."sessionId" IN (${Prisma.join([...lostFootprints])})`);
    if (orphanCandidates.length)
      await tx.$executeRaw(Prisma.sql`
      DELETE FROM cache_affinity_node n
      WHERE n."userId" = ${resourceOwnerId} AND n."tenantUserId" = ${ownerId}
        AND n."poolId" = ${poolId} AND n."executionTargetId" = ${target.executionTargetId}
        AND n."sessionId" IN (${Prisma.join(orphanCandidates)})
        AND NOT EXISTS (
          SELECT 1 FROM cache_affinity_record r WHERE r."userId" = n."userId"
            AND r."tenantUserId" = n."tenantUserId" AND r."poolId" = n."poolId"
            AND r."executionTargetId" = n."executionTargetId" AND r."sessionId" = n."sessionId"
          LIMIT 1 OFFSET 0)`);
    // Footprint-only writes help routing, but cannot publish uncommitted chain lineage.
    if (!tip || lostFootprints.has(sessionId)) return null;
    return {
      sessionId,
      bindingDigest: material.bindingDigest,
      rootDigest: material.rootDigest,
      tipDigest: tip?.digest ?? "",
      tipDepth: tip?.depth ?? 0,
      canonicalBytes: material.canonicalBytes,
      estimatedTokens,
    };
  }, AFFINITY_TRANSACTION_LIMITS);
}

/**
 * Deletes expired records (writer class S): one statement that takes its rows
 * with SKIP LOCKED, so it never waits on a writer's record lock. Records of a
 * deleted pool, target or tenant expire like any other (at most the pool's
 * TTL, seven days) and are never read meanwhile: ranking reads only the
 * records of live targets of a visible pool.
 */
export async function sweepExpiredAffinity({ now = new Date(), limit = 1000 } = {}) {
  const records = await prisma.$executeRaw`
    DELETE FROM cache_affinity_record
     WHERE id IN (
       SELECT id FROM cache_affinity_record
        WHERE "expiresAt" <= ${now}
        ORDER BY "expiresAt", id
        LIMIT ${Math.max(1, Math.min(limit, 10_000))}
          FOR UPDATE SKIP LOCKED)`;
  const nodes = await prisma.$executeRaw`
    DELETE FROM cache_affinity_node WHERE id IN (
      SELECT id FROM cache_affinity_node WHERE "expiresAt" <= ${now}
      ORDER BY "expiresAt", id LIMIT ${Math.max(1, Math.min(limit, 10_000))}
      FOR UPDATE SKIP LOCKED)`;
  return records + nodes;
}
