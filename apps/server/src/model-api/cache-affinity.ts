/**
 * Eviction evidence is one SQL snapshot proving the resolved session owns a
 * live tip in this request chain and reading the footprint stored on that node.
 * Only identifiable tip writes set that footprint; overflow-only hint refreshes
 * cannot change it. The matching hint supplies recency and cache confirmation.
 * Routing hints and identity resolution remain independent. Evidence describes
 * the ranking snapshot; later unrelated writers cannot invalidate that claim.
 * Client identity remains authoritative, with no extra query on the write path.
 * Implicit identical tips can lose one observation when the resolver chooses
 * an earlier-expiring session than the last shared-hint writer, failing closed.
 */
import { randomUUID } from "node:crypto";
import {
  effectiveKvBudgetTokens,
  type KvEvictionState,
  kvEvictionCutsApply,
} from "@ws-model-proxy/api/lib/kv-eviction-budget";
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
import { estimatePayloadTokens } from "./capacity/payload-estimate.js";
import { requestJsonDepthExceeded } from "./request-json-depth.js";
import { protectionKvBudgetTokens } from "./warm-protection.js";

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
  /** Score scale for new-conversation KV residency. Default 100; 0 disables. */
  residencyWeight?: number;
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
  /** Member weight: proportional share of new conversations. Default 1. */
  weight?: number;
  /** This request's prompt estimate r. */
  requestTokens?: number;
  /** Reported KV budget K; null selects slot mode. llama.cpp should pass null. */
  kvBudgetTokens?: number | null;
  /** Concurrency cap C; defaults to hardConcurrencyLimit. */
  slots?: number | null;
  lastRoutedAt?: Date | null;
  engineKind?: "GENERIC" | "LLAMA_CPP" | "VLLM" | "SGLANG" | "OLLAMA" | "LM_STUDIO" | null;
  /** Per-capacity image cap passed into the once-per-request unit estimator. */
  imageTokenAllowance?: number | null;
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
   * reported engine tokens when known, else `estimatedTokens`, of the deepest
   * matching prefix record (the conversation record's when the hit is
   * conversation-only). Absent = unknown. Counts only; used to size the
   * cache-holder wait (saturation S-A).
   */
  prefixTokens?: Record<string, number>;
  /**
   * Payload-aware estimate of the current request through the matched prefix
   * depth (root + conversation units 1..depth). Ranking never passes a
   * reported value; the figure is the local request estimate. Absent when the
   * request is not affine on that target.
   */
  matchedPrefixTokens?: Record<string, number>;
  /**
   * The warm session this request continues, per target (S-C): see
   * `resolveAffinitySession`. Absent = a new session on that target.
   */
  matchedSessionIds?: Record<string, string>;
  /** Tip-node footprint proven in one ranking snapshot; not proof of residency. */
  prefixEvidence?: Record<string, { tokens: number; lastUsedAt: number; confirmed: boolean }>;
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
  reportedTokens?: number;
  reportedPromptTokens?: number;
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
  // Anthropic's name for the same stop list. Changing it does not change
  // what a model has cached, so it must not split a conversation (owner, 2026-10-01).
  "stop_sequences",
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
  imageTokenAllowance?: number | null;
};

export type CanonicalRequest = {
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
  /**
   * Payload-aware token prefix sums computed once per request.
   * Index 0 is the root (instructions + tools); index `d` is root plus
   * conversation units `1..d`.
   */
  unitTokenPrefixSums: number[];
};

/** Once per request; all request-derived traversal shares an 8 * 2 MiB node cap. */
export function buildCanonicalRequest(
  {
    surface,
    payload,
    headers,
    imageTokenAllowance,
  }: Pick<AffinityRequestArgs, "surface" | "payload" | "headers" | "imageTokenAllowance">,
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
    const unitTokenPrefixSums = computeUnitTokenPrefixSums(
      instructions,
      tools,
      conversationUnits,
      imageTokenAllowance,
    );
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
      unitTokenPrefixSums,
    };
  } catch {
    return null;
  }
}

/** Root bytes plus encoded conversation units `1..depth` of this request. */
export function prefixBytesAtDepth(canonical: CanonicalRequest, depth: number): number {
  let bytes = canonical.rootBytes;
  const limit = Math.max(0, Math.min(Math.trunc(depth), canonical.conversationUnits.length));
  for (let index = 0; index < limit; index += 1) {
    bytes += Buffer.byteLength(canonical.conversationUnits[index]!);
  }
  return bytes;
}

export function canonicalByteLength(canonical: CanonicalRequest): number {
  return canonical.conversationUnits.reduce(
    (sum, unit) => sum + Buffer.byteLength(unit),
    canonical.rootBytes,
  );
}

function encodedPayloadTokens(encoded: string, imageTokenAllowance?: number | null): number {
  try {
    const tokens = estimatePayloadTokens(JSON.parse(encoded) as unknown, {
      imageTokenAllowance,
    }).tokens;
    return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  } catch {
    return 0;
  }
}

function computeUnitTokenPrefixSums(
  instructions: string[],
  tools: string | undefined,
  conversationUnits: string[],
  imageTokenAllowance?: number | null,
): number[] {
  let tokens = 0;
  for (const instruction of instructions)
    tokens += encodedPayloadTokens(instruction, imageTokenAllowance);
  if (tools) tokens += encodedPayloadTokens(tools, imageTokenAllowance);
  const sums = [tokens];
  for (const unit of conversationUnits) {
    tokens += encodedPayloadTokens(unit, imageTokenAllowance);
    sums.push(tokens);
  }
  return sums;
}

/** Payload-aware tokens of the root plus conversation units `1..depth`. */
export function prefixPayloadTokensAtDepth(canonical: CanonicalRequest, depth: number): number {
  const limit = Math.max(0, Math.min(Math.trunc(depth), canonical.conversationUnits.length));
  return canonical.unitTokenPrefixSums[limit] ?? 0;
}

/**
 * Estimated tokens of the root (instructions, tools) plus conversation units
 * `1..depth`. Each unit is sized with the payload-aware estimator. When
 * engine-reported prompt tokens are known they scale the prefix; otherwise the
 * local request estimate does. Depth 0 is the root only (`instructionTokens`).
 */
export function prefixTokensAtDepth(
  canonical: CanonicalRequest,
  depth: number,
  estimate: number,
  reportedPromptTokens?: number | null,
): number {
  const reported = Number(reportedPromptTokens);
  const local = Number(estimate);
  const scale =
    Number.isFinite(reported) && reported > 0
      ? reported
      : Number.isFinite(local) && local > 0
        ? local
        : 0;
  if (scale <= 0) return 0;
  const total = prefixPayloadTokensAtDepth(canonical, canonical.conversationUnits.length);
  if (total <= 0) return 0;
  return Math.max(
    0,
    Math.min(
      2_147_483_647,
      Math.round((scale * prefixPayloadTokensAtDepth(canonical, depth)) / total),
    ),
  );
}

export function instructionTokens(canonical: CanonicalRequest, estimate: number): number {
  return prefixTokensAtDepth(canonical, 0, estimate);
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
 * from truncation to that starter, including when exactly one live conversation starts with that
 * opening. Fail closed in this residual case (owner, 2026-10-01); truncations
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

/**
 * Deepest node of this request that another live session on the same target
 * and root owns. One bounded equality seek per node, like the identity probe.
 * First write of a session only; the footprint stores the hit once.
 */
export function affinitySharedPrefixProbeSql(
  scope: IdentityScope,
  material: AffinityMaterial,
  sessionId: string,
  now: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT COALESCE(tips."sessionId", others."sessionId") AS "sessionId", p.depth
      FROM jsonb_to_recordset(${JSON.stringify(material.nodes)}::jsonb) AS p(digest text, depth int)
      LEFT JOIN LATERAL (
        ${affinityNodeProbeSql(
          scope,
          material.rootDigest,
          Prisma.sql`p.digest`,
          true,
          now,
          1,
          Prisma.sql`"sessionId" <> ${sessionId} AND`,
        )}
      ) tips ON true
      LEFT JOIN LATERAL (
        ${affinityNodeProbeSql(
          scope,
          material.rootDigest,
          Prisma.sql`p.digest`,
          false,
          now,
          1,
          Prisma.sql`tips."sessionId" IS NULL AND "sessionId" <> ${sessionId} AND`,
        )}
      ) others ON true
     WHERE tips."sessionId" IS NOT NULL OR others."sessionId" IS NOT NULL
     ORDER BY p.depth DESC LIMIT 1`;
}

/**
 * One snapshot of tip ownership and its structurally proven footprint: tokens
 * live on the tip node, written only by an identifiable request. Hint-only
 * refreshes can update recency and confirmation without changing that footprint.
 * Legacy nodes without an estimate provide no evidence.
 * Full unique-key equalities bound index work to this request's <=64 nodes,
 * independent of other sessions.
 * Lateral OFFSET 0 keeps the per-node unique-key lookups correlated instead
 * of letting the planner start from all of a session's historical hint rows.
 * Shared hints stamped by another session prove nothing about this session.
 * Exported so PostgreSQL diagnostics explain the exact production statement.
 */
export function affinityPrefixEvidenceSql(
  scope: IdentityScope,
  targetIdentity: string,
  material: AffinityMaterial,
  sessionId: string,
  now: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT COALESCE(n."reportedTokens", n."estimatedTokens") AS tokens,
           r."lastUsedAt", r."engineCacheConfirmed"
      FROM jsonb_to_recordset(${JSON.stringify(material.nodes)}::jsonb) AS p(digest text, depth int)
      JOIN LATERAL (
        SELECT n."isTip", n."expiresAt", n."estimatedTokens", n."reportedTokens" FROM cache_affinity_node n
         WHERE n."userId" = ${scope.userId}
           AND n."tenantUserId" = ${scope.tenantUserId}
           AND n."poolId" = ${scope.poolId}
           AND n."executionTargetId" = ${scope.executionTargetId}
           AND n."rootDigest" = ${material.rootDigest}
           AND n."nodeDigest" = p.digest
           AND n."sessionId" = ${sessionId}
        OFFSET 0
      ) n ON n."isTip" AND n."expiresAt" > ${now}::timestamp
             AND COALESCE(n."reportedTokens", n."estimatedTokens") IS NOT NULL
      JOIN LATERAL (
        SELECT r."lastUsedAt", r."engineCacheConfirmed",
               r."sessionId", r."digestVersion", r."expiresAt"
          FROM cache_affinity_record r
         WHERE r."tenantUserId" = ${scope.tenantUserId}
           AND r."poolId" = ${scope.poolId}
           AND r."executionTargetId" = ${scope.executionTargetId}
           AND r."targetIdentity" = ${targetIdentity}
           AND r."bindingDigest" = ${material.bindingDigest}
           AND r."prefixDigest" = p.digest
        OFFSET 0
      ) r ON r."sessionId" = ${sessionId}
             AND r."digestVersion" = ${DIGEST_VERSION}
             AND r."expiresAt" > ${now}::timestamp
     ORDER BY p.depth DESC LIMIT 1`;
}

/** Newest unexpired footprints per execution target, for new-conversation placement. */
export const AFFINITY_RESIDENCY_QUERY_LIMIT = 2_000;
/** Slot/unknown occupancy ignores empty footprints so mixed pools stay on [0, 1]. */
export const AFFINITY_RESIDENCY_SESSION_FLOOR = 1;

export type AffinityResidencyRow = {
  capacityId: string;
  sessionId: string;
  tokens: number | null;
  sharedWithSessionId?: string | null;
  sharedPrefixTokens?: number | null;
};

/**
 * Bounded newest-first footprints (`prefixDigest IS NULL`) per execution
 * target, grouped later by `execution_target.inferenceCapacityId`. Each target
 * walks the partial index `cache_affinity_record_residency`
 * (`executionTargetId`, `expiresAt` DESC) WHERE `prefixDigest` IS NULL via
 * `LATERAL ... LIMIT n` so live prefix rows are not scanned. EXPLAIN/buffer
 * coverage lives in `cache-affinity.integration.test.ts` and needs the
 * integration database (`SCHEMA_VALIDATION_DATABASE_URL`).
 */
export function affinityResidencySql(
  ownerUserId: string,
  capacityIds: readonly string[],
  now: Date,
  limitPerTarget = AFFINITY_RESIDENCY_QUERY_LIMIT,
): Prisma.Sql {
  return Prisma.sql`
    SELECT t."inferenceCapacityId" AS "capacityId",
           r."sessionId",
           r.tokens,
           r."sharedWithSessionId",
           r."sharedPrefixTokens"
      FROM execution_target t
      JOIN LATERAL (
        SELECT r2."sessionId",
               r2."estimatedTokens" AS tokens,
               r2."sharedWithSessionId",
               r2."sharedPrefixTokens"
          FROM cache_affinity_record r2
         WHERE r2."userId" = ${ownerUserId}
           AND r2."executionTargetId" = t.id
           AND r2."prefixDigest" IS NULL
           AND r2."expiresAt" > ${now}::timestamp
         ORDER BY r2."expiresAt" DESC, r2.id DESC
         LIMIT ${limitPerTarget}
      ) r ON true
     WHERE t."userId" = ${ownerUserId}
       AND t."inferenceCapacityId" IN (${Prisma.join([...capacityIds])})`;
}

function billedResidentTokens(
  row: AffinityResidencyRow,
  resident: ReadonlyMap<string, AffinityResidencyRow>,
): number {
  const raw = Math.max(0, Number(row.tokens) || 0);
  const shared = Number(row.sharedPrefixTokens);
  const sharer = row.sharedWithSessionId;
  if (!Number.isFinite(shared) || !sharer) return raw;
  const sharerRow = resident.get(sharer);
  if (!sharerRow) return raw;
  // A↔F after TTL: bill the edge once. Ignore the back-pointer (the
  // lexicographically greater session id keeps the shared tokens).
  if (sharerRow.sharedWithSessionId === row.sessionId && sharer >= row.sessionId) return raw;
  return Math.max(0, raw - shared);
}

function preferResidencyRow(left: AffinityResidencyRow, right: AffinityResidencyRow) {
  const leftTokens = Math.max(0, Number(left.tokens) || 0);
  const rightTokens = Math.max(0, Number(right.tokens) || 0);
  if (leftTokens !== rightTokens) return leftTokens >= rightTokens ? left : right;
  if (right.sharedWithSessionId && !left.sharedWithSessionId) return right;
  return left;
}

function residencyByCapacity(rows: readonly AffinityResidencyRow[]) {
  const grouped = new Map<string, Map<string, AffinityResidencyRow>>();
  for (const row of rows) {
    const sessions = grouped.get(row.capacityId) ?? new Map<string, AffinityResidencyRow>();
    const existing = sessions.get(row.sessionId);
    sessions.set(row.sessionId, existing ? preferResidencyRow(existing, row) : row);
    grouped.set(row.capacityId, sessions);
  }
  const byCapacity = new Map<string, { tokens: number; sessions: number }>();
  for (const [capacityId, sessions] of grouped) {
    let tokens = 0;
    let sessionCount = 0;
    for (const row of sessions.values()) {
      const billed = billedResidentTokens(row, sessions);
      tokens += billed;
      if (billed >= AFFINITY_RESIDENCY_SESSION_FLOOR) sessionCount += 1;
    }
    byCapacity.set(capacityId, { tokens, sessions: sessionCount });
  }
  return byCapacity;
}

function residencyProjected({
  residentTokens,
  residentSessions,
  requestTokens,
  savedTokens,
  kvBudgetTokens,
  slots,
  maxResidentSessions,
}: {
  residentTokens: number;
  residentSessions: number;
  requestTokens: number;
  savedTokens: number;
  kvBudgetTokens: number | null;
  slots: number | null;
  maxResidentSessions: number;
}): number {
  if (kvBudgetTokens !== null && kvBudgetTokens > 0) {
    const used = Math.max(0, residentTokens + Math.max(0, requestTokens) - savedTokens);
    return Math.min(1, used / kvBudgetTokens);
  }
  if (slots !== null && slots > 0) return Math.min(1, residentSessions / slots);
  return Math.min(1, residentSessions / Math.max(maxResidentSessions, 1));
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
  collectPrefixEvidence = false,
  evictionFeedbackEnabled = true,
  sessionBinding,
  headers,
  now = new Date(),
  db = prisma,
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
  /** Read the live-tip footprint snapshot only for enabled eviction feedback. */
  collectPrefixEvidence?: boolean;
  /** False freezes residency K: skip stored cuts. Default true. */
  evictionFeedbackEnabled?: boolean;
  sessionBinding?: AffinitySessionBinding;
  headers?: Headers;
  now?: Date;
  /** Read-only injection for real-query interleavings; writers use their own client. */
  db?: Pick<
    typeof prisma,
    | "cacheAffinityRecord"
    | "capacityLease"
    | "capacityWaiter"
    | "$queryRaw"
    | "cacheAffinityNode"
    | "capacityKvEviction"
  >;
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

  const preparedTargets = targets.map((target) => {
    const canonical = buildCanonicalRequest({
      surface,
      payload,
      headers,
      imageTokenAllowance: target.imageTokenAllowance,
    });
    return {
      target,
      canonical,
      material: materialFromCanonical(
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
    };
  });
  const materialByIdentity = new Map(
    preparedTargets.map(({ target, material }) => [target.targetIdentity, material]),
  );
  const canonicalByIdentity = new Map(
    preparedTargets.map(({ target, canonical }) => [target.targetIdentity, canonical]),
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

  const continuationRequest = [...materialByIdentity.values()].every(
    (material) => material.isContinuation,
  );
  const capacityIds = [...new Set(targets.map(({ capacityId }) => capacityId))];
  const residencyWeight = policy.residencyWeight ?? 100;
  const needResidency = residencyWeight > 0 && targets.length >= 2;
  const loadResidency = () =>
    !needResidency || capacityIds.length === 0
      ? Promise.resolve([] as AffinityResidencyRow[])
      : Promise.resolve()
          .then(() =>
            db.$queryRaw<AffinityResidencyRow[]>(
              affinityResidencySql(resourceOwnerId, capacityIds, now),
            ),
          )
          .then((rows) => (Array.isArray(rows) ? rows : []))
          .catch(() => [] as AffinityResidencyRow[]);
  const applyCuts = kvEvictionCutsApply(evictionFeedbackEnabled);
  const loadEvictions = () =>
    !applyCuts || capacityIds.length === 0
      ? Promise.resolve([] as Array<KvEvictionState & { capacityId: string }>)
      : Promise.resolve()
          .then(() =>
            db.capacityKvEviction.findMany({
              where: {
                capacityId: { in: capacityIds },
                userId: resourceOwnerId,
                expiresAt: { gt: now },
              },
            }),
          )
          .then((rows) => (Array.isArray(rows) ? rows : []))
          .catch(() => [] as Array<KvEvictionState & { capacityId: string }>);
  const [records, activeLoads, waitingLoads, residencyRows, evictions] = await Promise.all([
    db.cacheAffinityRecord.findMany({
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
        reportedTokens: true,
      },
    }),
    db.capacityLease.groupBy({
      by: ["capacityId"],
      where: {
        capacityId: { in: targets.map(({ capacityId }) => capacityId) },
        state: "ACTIVE",
        expiresAt: { gt: now },
      },
      _count: { _all: true },
    }),
    db.capacityWaiter.groupBy({
      by: ["capacityId"],
      where: {
        capacityId: { in: targets.map(({ capacityId }) => capacityId) },
        state: "WAITING",
        OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
      },
      _count: { _all: true },
    }),
    continuationRequest || !needResidency
      ? Promise.resolve([] as AffinityResidencyRow[])
      : loadResidency(),
    continuationRequest || !needResidency
      ? Promise.resolve([] as Array<KvEvictionState & { capacityId: string }>)
      : loadEvictions(),
  ]);
  const activeByCapacity = new Map(activeLoads.map((row) => [row.capacityId, row._count._all]));
  const waitingByCapacity = new Map(waitingLoads.map((row) => [row.capacityId, row._count._all]));
  const currentRecords = records.filter((record) => record.digestVersion === DIGEST_VERSION);
  const scored = await Promise.all(
    targets.map(async (target, originalIndex) => {
      const material = materialByIdentity.get(target.targetIdentity)!;
      const canonical = canonicalByIdentity.get(target.targetIdentity);
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
      const prefixTokens =
        matchedRecord?.reportedTokens ?? matchedRecord?.estimatedTokens ?? undefined;
      const scope = {
        userId: resourceOwnerId,
        tenantUserId: ownerId,
        poolId,
        executionTargetId: target.executionTargetId,
      };
      const sessionId = await resolveAffinitySession(db, scope, material, now);
      let prefixEvidence: NonNullable<AffinityDecision["prefixEvidence"]>[string] | undefined;
      if (
        collectPrefixEvidence &&
        sessionId !== null &&
        material.identifiable &&
        material.nodes.length > 0 &&
        !material.missingParent &&
        material.isContinuation
      ) {
        try {
          const [row] = await db.$queryRaw<
            { tokens: number; lastUsedAt: Date; engineCacheConfirmed: boolean }[]
          >(affinityPrefixEvidenceSql(scope, target.targetIdentity, material, sessionId, now));
          if (row)
            prefixEvidence = {
              tokens: row.tokens,
              lastUsedAt: row.lastUsedAt.getTime(),
              confirmed: row.engineCacheConfirmed,
            };
        } catch {
          // Disposable feedback: an unproven footprint must not change ranking.
        }
      }
      const active = target.activeLoad ?? activeByCapacity.get(target.capacityId) ?? 0;
      const waiting = target.waitingLoad ?? waitingByCapacity.get(target.capacityId) ?? 0;
      const normalizedLoad = target.hardConcurrencyLimit
        ? Math.ceil((active * 100) / target.hardConcurrencyLimit) + waiting * 100
        : active * 100 + waiting * 100;
      const loadPenalty = Math.ceil((normalizedLoad * policy.loadPenaltyWeight) / 100);
      const affine = scoredPrefixDepth > 0 || conversation;
      const requestTokens = Math.max(0, Number(target.requestTokens ?? 0) || 0);
      const matchedPrefixTokens =
        affine && canonical
          ? prefixTokensAtDepth(canonical, scoredPrefixDepth, requestTokens)
          : undefined;
      const matchFraction =
        matchedPrefixTokens === undefined
          ? 0
          : requestTokens > 0
            ? matchedPrefixTokens / requestTokens
            : canonical
              ? (() => {
                  const total = prefixPayloadTokensAtDepth(
                    canonical,
                    canonical.conversationUnits.length,
                  );
                  return total > 0
                    ? prefixPayloadTokensAtDepth(canonical, scoredPrefixDepth) / total
                    : 0;
                })()
              : 0;
      return {
        target,
        originalIndex,
        loadPenalty,
        prefixDepth: scoredPrefixDepth,
        instructionDepth,
        conversation,
        confirmed,
        affine,
        active,
        waiting,
        isContinuation: material.isContinuation,
        prefixTokens,
        matchedPrefixTokens,
        matchFraction,
        requestTokens,
        sessionId,
        prefixEvidence,
        canonical,
        score: 0,
      };
    }),
  );
  const anyAffine = scored.some((row) => row.affine);
  let residency = residencyRows;
  let evictionRows = evictions;
  if (!anyAffine && continuationRequest && needResidency) {
    [residency, evictionRows] = await Promise.all([loadResidency(), loadEvictions()]);
  }
  const spreadResidency = !anyAffine && needResidency;
  const resident = spreadResidency ? residencyByCapacity(residency) : new Map();
  const evictionByCapacity = spreadResidency
    ? new Map(evictionRows.map((row) => [row.capacityId, row] as const))
    : new Map();
  const maxResidentSessions = Math.max(0, ...[...resident.values()].map((row) => row.sessions));
  const weights = targets.map((target) => Math.max(0, target.weight ?? 1));
  const meanWeight =
    weights.reduce((sum, weight) => sum + weight, 0) / Math.max(weights.length, 1) || 1;
  for (const row of scored) {
    const penalties =
      row.loadPenalty +
      row.target.healthPenalty +
      row.target.publicEgressPenalty +
      row.target.costPenalty;
    if (row.affine) {
      row.score =
        row.prefixDepth * policy.prefixWeight +
        (row.conversation ? policy.conversationWeight : 0) +
        (row.confirmed ? policy.confirmedCacheWeight : 0) -
        penalties;
      continue;
    }
    if (!spreadResidency) {
      row.score = 0 - penalties;
      continue;
    }
    const occupancy = resident.get(row.target.capacityId) ?? { tokens: 0, sessions: 0 };
    const reportedK = protectionKvBudgetTokens(row.target.engineKind, row.target.kvBudgetTokens);
    const kvBudgetTokens = effectiveKvBudgetTokens(
      reportedK,
      evictionByCapacity.get(row.target.capacityId),
      now,
      evictionFeedbackEnabled,
    );
    const slots = row.target.slots ?? row.target.hardConcurrencyLimit;
    const savedTokens =
      row.instructionDepth > 0 && row.canonical
        ? instructionTokens(row.canonical, row.requestTokens)
        : 0;
    const projected = residencyProjected({
      residentTokens: occupancy.tokens,
      residentSessions: occupancy.sessions,
      requestTokens: row.requestTokens,
      savedTokens,
      kvBudgetTokens,
      slots,
      maxResidentSessions,
    });
    const weight = Math.max(0, row.target.weight ?? 1);
    const cost =
      weight <= 0 || meanWeight <= 0 ? Number.POSITIVE_INFINITY : projected / (weight / meanWeight);
    // Keep the weighted fill off integer ceil so small occupancy differences
    // survive; saturated members then break on lastRoutedAt / originalIndex.
    const residencyPenalty = Number.isFinite(cost) ? cost * residencyWeight : 1_000_000_000;
    row.score = 0 - penalties - residencyPenalty;
  }
  scored.sort((left, right) => {
    const score = right.score - left.score;
    if (score !== 0) return score;
    const instruction = right.instructionDepth - left.instructionDepth;
    if (instruction !== 0) return instruction;
    if (spreadResidency) {
      const routed =
        (left.target.lastRoutedAt?.getTime() ?? 0) - (right.target.lastRoutedAt?.getTime() ?? 0);
      if (routed !== 0) return routed;
    }
    const original = left.originalIndex - right.originalIndex;
    if (original !== 0) return original;
    return spreadResidency ? left.target.poolMemberId.localeCompare(right.target.poolMemberId) : 0;
  });
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
          matchFraction,
        }) => [
          target.executionTargetId,
          `prefix:${prefixDepth};instruction:${instructionDepth};continuation:${isContinuation};conversation:${conversation};confirmed:${confirmed};matchFraction:${Number(matchFraction.toFixed(4))};active:${active};waiting:${waiting};healthPenalty:${target.healthPenalty};publicPenalty:${target.publicEgressPenalty};costPenalty:${target.costPenalty}`,
        ],
      ),
    ),
    matchedPrefixDepth: Math.max(0, ...scored.map(({ prefixDepth }) => prefixDepth)),
    prefixTokens: Object.fromEntries(
      scored.flatMap(({ target, prefixTokens }) =>
        prefixTokens === undefined ? [] : [[target.executionTargetId, prefixTokens]],
      ),
    ),
    matchedPrefixTokens: Object.fromEntries(
      scored.flatMap(({ target, matchedPrefixTokens }) =>
        matchedPrefixTokens === undefined ? [] : [[target.executionTargetId, matchedPrefixTokens]],
      ),
    ),
    ...(collectPrefixEvidence
      ? {
          prefixEvidence: Object.fromEntries(
            scored.flatMap(({ target, prefixEvidence }) =>
              prefixEvidence === undefined ? [] : [[target.executionTargetId, prefixEvidence]],
            ),
          ),
        }
      : {}),
    matchedSessionIds: Object.fromEntries(
      scored.flatMap(({ target, sessionId }) =>
        sessionId === null ? [] : [[target.executionTargetId, sessionId]],
      ),
    ),
  };
}

/** Cheap placement remainder after admission. Must not run inside the hot fence. */
export async function markPoolMemberLastRoutedAt(
  poolMemberId: string | null | undefined,
  at = new Date(),
  db: {
    poolMember: {
      update: (args: { where: { id: string }; data: { lastRoutedAt: Date } }) => Promise<unknown>;
    };
  } = prisma,
): Promise<void> {
  if (!poolMemberId) return;
  try {
    await db.poolMember.update({ where: { id: poolMemberId }, data: { lastRoutedAt: at } });
  } catch {
    // A missed stamp must not fail a granted request.
  }
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

function clampAffinityTokens(value: number | undefined): number | null {
  if (value === undefined) return null;
  return Math.max(0, Math.min(2_147_483_647, Math.trunc(value)));
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
  reportedTokens,
  reportedPromptTokens,
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
  /** Engine-reported prompt + completion for the served turn, when known. */
  reportedTokens?: number;
  /** Engine-reported prompt tokens only; used to scale shared prefixes. */
  reportedPromptTokens?: number;
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
  const requestArgs = {
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
  };
  const canonical = buildCanonicalRequest({
    ...requestArgs,
    imageTokenAllowance: target.imageTokenAllowance,
  });
  const material = materialFromCanonical(requestArgs, canonical);
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
  if (material.boundSessionId && sessionBinding?.reportedTokens !== undefined) {
    reportedTokens = Math.min(
      2_147_483_647,
      sessionBinding.reportedTokens + (estimatedDeltaTokens ?? 0),
    );
  }
  if (material.boundSessionId && sessionBinding?.reportedPromptTokens !== undefined) {
    reportedPromptTokens = Math.min(
      2_147_483_647,
      sessionBinding.reportedPromptTokens + (estimatedDeltaTokens ?? 0),
    );
  }
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  const storedReportedTokens = clampAffinityTokens(reportedTokens);
  const storedReportedPromptTokens = clampAffinityTokens(reportedPromptTokens);
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
    let sharedWithSessionId: string | null = null;
    let sharedPrefixTokens: number | null = null;
    if (
      material.identifiable &&
      existingNodes.length === 0 &&
      material.nodes.length > 0 &&
      !material.boundSessionId
    ) {
      const shared = await tx.$queryRaw<{ sessionId: string; depth: number }[]>(
        affinitySharedPrefixProbeSql(scope, material, sessionId, now),
      );
      const hit = shared[0];
      const depth = Number(hit?.depth);
      if (hit?.sessionId && hit.sessionId !== sessionId && Number.isFinite(depth)) {
        sharedWithSessionId = hit.sessionId;
        sharedPrefixTokens = canonical
          ? prefixTokensAtDepth(canonical, depth, estimatedTokens ?? 0, storedReportedPromptTokens)
          : 0;
      }
    }
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
      const tipEstimatedTokens = clampAffinityTokens(estimatedTokens);
      const tipReportedTokens = storedReportedTokens;
      const oldDigests = new Set(existingNodes.map((node) => node.nodeDigest));
      const inserts = retained.filter(
        (node) => !oldDigests.has(node.digest) || node.digest === tip.digest,
      );
      // Only this write's tip receives its whole-prompt estimate. Replays and
      // promotions replace it even with NULL; non-tip conflicts preserve any
      // footprint from an earlier write that made that node a tip.
      if (inserts.length)
        await tx.$executeRaw(Prisma.sql`
        INSERT INTO cache_affinity_node
          (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest",
           "nodeDigest", depth, "sessionId", "isTip", "estimatedTokens", "reportedTokens", "expiresAt") VALUES
          ${Prisma.join(
            inserts.map(
              (node) => Prisma.sql`(${randomUUID()}, ${resourceOwnerId},
            ${ownerId}, ${poolId}, ${target.executionTargetId}, ${material.rootDigest},
            ${node.digest}, ${node.depth}, ${sessionId}, ${node.digest === tip.digest},
            ${node.digest === tip.digest ? tipEstimatedTokens : null},
            ${node.digest === tip.digest ? tipReportedTokens : null}, ${expiresAt})`,
            ),
          )}
        ON CONFLICT ("userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest", "nodeDigest", "sessionId")
        DO UPDATE SET "isTip" = EXCLUDED."isTip", "expiresAt" = EXCLUDED."expiresAt",
          "estimatedTokens" = CASE WHEN EXCLUDED."isTip" THEN EXCLUDED."estimatedTokens"
            ELSE cache_affinity_node."estimatedTokens" END,
          "reportedTokens" = CASE WHEN EXCLUDED."isTip"
            THEN COALESCE(EXCLUDED."reportedTokens", cache_affinity_node."reportedTokens")
            ELSE cache_affinity_node."reportedTokens" END`);
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
          reportedTokens: storedReportedTokens,
          engineCacheConfirmed: engineCacheConfirmed ?? false,
          lastUsedAt: now,
          expiresAt,
        },
        update: {
          lastUsedAt: now,
          expiresAt,
          sessionId,
          estimatedTokens,
          ...(storedReportedTokens === null ? {} : { reportedTokens: storedReportedTokens }),
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
           "digestVersion", "estimatedTokens", "reportedTokens", "engineCacheConfirmed", "lastUsedAt", "expiresAt")
        SELECT p.id, ${resourceOwnerId}, ${ownerId}, ${poolId}, ${target.executionTargetId},
          ${target.targetIdentity}, ${material.bindingDigest}, p.digest, NULL, ${sessionId}, p.depth,
          ${DIGEST_VERSION}, ${estimatedTokens ?? null}, ${storedReportedTokens}, ${engineCacheConfirmed ?? false}, ${now}, ${expiresAt}
        FROM jsonb_to_recordset(${JSON.stringify(prefixes.map((node) => ({ id: randomUUID(), ...node })))}::jsonb)
          AS p(id text, digest text, depth int)
        ON CONFLICT ("tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "prefixDigest")
        DO UPDATE SET "sessionId" = EXCLUDED."sessionId", "lastUsedAt" = EXCLUDED."lastUsedAt",
          "expiresAt" = EXCLUDED."expiresAt", "estimatedTokens" = COALESCE(EXCLUDED."estimatedTokens", cache_affinity_record."estimatedTokens"),
          "reportedTokens" = COALESCE(EXCLUDED."reportedTokens", cache_affinity_record."reportedTokens"),
          "engineCacheConfirmed" = COALESCE(${engineCacheConfirmed ?? null}::boolean, cache_affinity_record."engineCacheConfirmed")`);
    }
    const upsertConversation = async (conversationDigest: string) => {
      // Use the partial unique index directly. A nullable-prefix ORM lookup
      // can choose a population scan before inserting a new footprint.
      await tx.$executeRaw`INSERT INTO cache_affinity_record
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity",
         "bindingDigest", "prefixDigest", "conversationDigest", "sessionId", "prefixDepth",
         "digestVersion", "estimatedTokens", "reportedTokens", "engineCacheConfirmed", "lastUsedAt", "expiresAt",
         "sharedWithSessionId", "sharedPrefixTokens")
        VALUES (${randomUUID()}, ${resourceOwnerId}, ${ownerId}, ${poolId},
          ${target.executionTargetId}, ${target.targetIdentity}, ${material.bindingDigest},
          NULL, ${conversationDigest}, ${sessionId}, 0, ${DIGEST_VERSION},
          ${estimatedTokens ?? null}, ${storedReportedTokens}, ${engineCacheConfirmed ?? false}, ${now}, ${expiresAt},
          ${sharedWithSessionId}, ${sharedPrefixTokens})
        ON CONFLICT ("tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest")
        WHERE "conversationDigest" IS NOT NULL AND "prefixDigest" IS NULL
        DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt", "expiresAt" = EXCLUDED."expiresAt",
          "sessionId" = EXCLUDED."sessionId", "estimatedTokens" = COALESCE(EXCLUDED."estimatedTokens", cache_affinity_record."estimatedTokens"),
          "reportedTokens" = COALESCE(EXCLUDED."reportedTokens", cache_affinity_record."reportedTokens"),
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
      // A known 200-id IN list can choose a heap scan after VACUUM/reuse
      // changes its cost. The bounded initplan keeps this a primary-key walk,
      // just like the expiry batches above, without disabling sequential scans.
      await tx.$executeRaw`DELETE FROM cache_affinity_record
        WHERE id = ANY(ARRAY(SELECT unnest(${overflow.map(({ id }) => id)}::text[])))`;
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
        AND n."sessionId" = ANY(ARRAY(SELECT unnest(${[...lostFootprints]}::text[])))`);
    if (orphanCandidates.length)
      await tx.$executeRaw(Prisma.sql`
      DELETE FROM cache_affinity_node n
      WHERE n."userId" = ${resourceOwnerId} AND n."tenantUserId" = ${ownerId}
        AND n."poolId" = ${poolId} AND n."executionTargetId" = ${target.executionTargetId}
        AND n."sessionId" = ANY(ARRAY(SELECT unnest(${orphanCandidates}::text[])))
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
      ...(storedReportedTokens === null ? {} : { reportedTokens: storedReportedTokens }),
      ...(storedReportedPromptTokens === null
        ? {}
        : { reportedPromptTokens: storedReportedPromptTokens }),
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
