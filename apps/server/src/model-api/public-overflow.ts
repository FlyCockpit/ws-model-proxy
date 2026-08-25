import { Readable } from "node:stream";
import {
  decryptProviderCredential,
  parseProviderCredentialKeyring,
} from "@ws-model-proxy/api/lib/provider-credential-crypto";
import {
  type ProviderEgressAuth,
  type ProviderProtocol,
  providerHttpsRequest,
} from "@ws-model-proxy/api/lib/provider-egress";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import {
  type AffinityDecision,
  type AffinityPolicy,
  type AffinityTarget,
  buildAffinityTargetIdentity,
  rankAffinityTargets,
  rememberAffinity,
} from "./cache-affinity.js";
import type { ProtocolSurface } from "./protocols/index.js";
import { SseDecoder } from "./protocols/sse.js";
import {
  allocateProviderFence,
  claimProviderHealthTrial,
  classifyProviderFailure,
  finishProviderAttempt,
  heartbeatProviderAttempt,
  parseRetryAfter,
  recordProviderAttemptEvent,
  recordProviderOutcome,
  releaseProviderHealthTrial,
} from "./provider-attempt-runtime.js";
import {
  admitProviderBudget,
  type ProviderBudgetAdmission,
  type ProviderLiability,
  type RawProviderUsage,
  reconcileProviderBudget,
} from "./provider-budget.js";
import {
  calculatedCostForUsage,
  liabilityFromPricing,
  type ProviderPricingSchedule,
  resolveActiveProviderPricing,
} from "./provider-pricing.js";

export type PublicOverflowReason =
  | "NO_COMPATIBLE_HEALTHY_PRIMARY"
  | "LOCAL_WAIT_EXPIRED"
  | "LOCAL_CONTEXT_CEILING"
  | "RETRYABLE_PRECOMMIT_PRIMARY_FAILURE";

export type PublicOverflowSkipReason =
  | "DEPLOYMENT_GATE_DISABLED"
  | "POOL_PRIVATE"
  | "POOL_ACKNOWLEDGEMENT_MISSING"
  | "ADAPTATION_GATE_DISABLED"
  | "NO_COMPATIBLE_PROVIDER"
  | "PROVIDER_UNHEALTHY"
  | "BUDGET_EXCEEDED"
  | "PROTECTION_POLICY_MISSING"
  | "PROVIDER_UNAVAILABLE";

export interface PublicOverflowRequest {
  userId: string;
  poolId: string;
  requestId: string;
  reason: PublicOverflowReason;
  requestedProtocol: ProviderProtocol;
  requestedSurface: ProtocolSurface;
  stream: boolean;
  requiredFeatures: readonly string[];
  path: string;
  headers: Headers;
  body: Uint8Array;
  signal: AbortSignal;
  liability: ProviderLiability;
  /** Conservative rendered input bound before any provider output. */
  estimatedInputTokens?: bigint;
  /** Conservative rendered input plus requested output, used only for context fit. */
  contextTokens?: bigint;
  /** Undefined means reserve the selected provider model's maximum output. */
  requestedOutputTokens?: bigint;
  contextCountMethod?: string;
  contextCountConfidence?: string;
  /** Must be called before credential decryption or any network attempt. */
  releaseLocalCapacity: () => Promise<void>;
  adaptationEnabled: boolean;
  /** True only when the operation resolver proves a second attempt is safe. */
  retrySafe: boolean;
  renderForTarget?: (
    target: PublicProviderTarget,
    nativeSurface: ProtocolSurface,
  ) => Promise<{
    protocol: ProviderProtocol;
    path: string;
    headers: Headers;
    body: Uint8Array;
  }>;
}

export interface PublicProviderTarget {
  poolMemberId: string;
  executionTargetId: string;
  publicOrder: number;
  providerModelId: string;
  upstreamModelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  protocol: ProviderProtocol;
  providerAccountId: string;
  endpointIdentity: string;
  endpointVersion: number;
  concurrencyLimit: number | null;
  providerVersion: string | null;
  baseUrl: string;
  authType: "API_KEY" | "BEARER";
  healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  nativeProtocols: readonly ProviderProtocol[];
  nativeSurfaces: readonly ProtocolSurface[];
  supportsStreaming: boolean;
  supportedFeatures: readonly string[];
  credential: {
    id: string;
    credentialType: "API_KEY" | "BEARER";
    keyVersion: string;
    aadVersion: number;
    algorithm: string;
    ciphertext: Uint8Array<ArrayBuffer>;
    nonce: Uint8Array<ArrayBuffer>;
    authTag: Uint8Array<ArrayBuffer>;
  };
  affinity?: { outcome: string; score?: number; prefixDepth?: number; reason?: string };
  affinityTarget?: AffinityTarget;
}

type ListedPublicOverflowTargets = {
  enabled: boolean;
  acknowledged: boolean;
  affinityPolicy: AffinityPolicy;
  targets: PublicProviderTarget[];
};

function providerEventRouting(input: {
  request: PublicOverflowRequest;
  target: PublicProviderTarget;
  nativeSurface?: ProtocolSurface;
}) {
  return {
    requestedSurface: input.request.requestedSurface,
    nativeSurface: input.nativeSurface,
    adapterMode: input.nativeSurface
      ? input.nativeSurface === input.request.requestedSurface
        ? "native"
        : "adapted"
      : undefined,
    adapterVersion:
      input.nativeSurface && input.nativeSurface !== input.request.requestedSurface
        ? "1.0.0"
        : undefined,
    poolId: input.request.poolId,
    poolMemberId: input.target.poolMemberId,
    executionTargetId: input.target.executionTargetId,
    memberTier: "PUBLIC_OVERFLOW",
    triggerReason: input.request.reason,
    affinityOutcome: input.target.affinity?.outcome ?? "NONE",
    contextCountMethod: input.request.contextCountMethod,
    contextCountConfidence: input.request.contextCountConfidence,
  };
}

/**
 * Atomically claims the current credential for a send that is about to start.
 * `lastUsedAt` is the durable boundary: credential lifecycle changes serialize
 * on the same rows, while the actual provider request happens after commit.
 */
export async function claimPublicProviderCredentialForSend(input: {
  userId: string;
  target: PublicProviderTarget;
  keyring: ReturnType<typeof parseProviderCredentialKeyring>;
}): Promise<string> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.target.providerAccountId} AND "userId" = ${input.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM provider_credential WHERE id = ${input.target.credential.id} AND "userId" = ${input.userId} FOR UPDATE`;
      const current = await tx.providerCredential.findFirst({
        where: {
          id: input.target.credential.id,
          userId: input.userId,
          providerAccountId: input.target.providerAccountId,
          status: "ACTIVE",
          CurrentForAccount: {
            id: input.target.providerAccountId,
            enabled: true,
            deletedAt: null,
            currentCredentialId: input.target.credential.id,
          },
        },
      });
      if (!current) throw new Error("provider credential is no longer current");
      const secret = decryptProviderCredential(
        {
          algorithm: current.algorithm as "AES-256-GCM",
          keyVersion: current.keyVersion,
          ciphertext: new Uint8Array(current.ciphertext),
          nonce: new Uint8Array(current.nonce),
          authTag: new Uint8Array(current.authTag),
        },
        {
          credentialId: current.id,
          userId: input.userId,
          providerAccountId: input.target.providerAccountId,
          credentialType: current.credentialType,
          aadVersion: current.aadVersion,
        },
        input.keyring,
      );
      await tx.providerCredential.update({
        where: { id: current.id },
        data: { lastUsedAt: new Date() },
      });
      return secret;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

export function publicTargetCompatibility(
  target: Pick<
    PublicProviderTarget,
    | "contextWindow"
    | "maxOutputTokens"
    | "nativeProtocols"
    | "nativeSurfaces"
    | "supportsStreaming"
    | "supportedFeatures"
    | "protocol"
  >,
  request: Pick<
    PublicOverflowRequest,
    | "requestedProtocol"
    | "requestedSurface"
    | "stream"
    | "requiredFeatures"
    | "requestedOutputTokens"
    | "adaptationEnabled"
    | "renderForTarget"
    | "liability"
    | "estimatedInputTokens"
    | "contextTokens"
  >,
): "COMPATIBLE" | "CONTEXT_UNKNOWN" | "CONTEXT_EXCEEDED" | "PROTOCOL_UNAVAILABLE" {
  const requestedOutputTokens =
    request.requestedOutputTokens ??
    (target.maxOutputTokens === null ? undefined : BigInt(target.maxOutputTokens));
  const contextTokens =
    request.estimatedInputTokens !== undefined && requestedOutputTokens !== undefined
      ? checkedContextTokens(request.estimatedInputTokens, requestedOutputTokens)
      : (request.contextTokens ?? request.liability.tokens);
  if (target.contextWindow === null || contextTokens === undefined) return "CONTEXT_UNKNOWN";
  if (contextTokens > BigInt(target.contextWindow)) return "CONTEXT_EXCEEDED";
  if (target.maxOutputTokens === null || requestedOutputTokens === undefined)
    return "CONTEXT_UNKNOWN";
  if (requestedOutputTokens > BigInt(target.maxOutputTokens)) return "CONTEXT_EXCEEDED";
  if (request.stream && !target.supportsStreaming) return "PROTOCOL_UNAVAILABLE";
  if (request.requiredFeatures.some((feature) => !target.supportedFeatures.includes(feature)))
    return "PROTOCOL_UNAVAILABLE";
  if (target.nativeSurfaces.includes(request.requestedSurface)) return "COMPATIBLE";
  // OpenAI streams cannot provide Anthropic's required initial input usage.
  // Reject before provider commitment instead of failing the adapter after a
  // successful upstream stream has begun.
  if (
    request.stream &&
    request.requestedSurface === "anthropic-messages" &&
    target.protocol === "openai"
  )
    return "PROTOCOL_UNAVAILABLE";
  return request.adaptationEnabled &&
    request.renderForTarget !== undefined &&
    target.nativeProtocols.includes(target.protocol) &&
    target.nativeSurfaces.some((surface) =>
      target.protocol === "anthropic"
        ? surface === "anthropic-messages"
        : surface !== "anthropic-messages",
    )
    ? "COMPATIBLE"
    : "PROTOCOL_UNAVAILABLE";
}

export type PublicOverflowResult =
  | {
      dispatched: true;
      response: Response;
      target: PublicProviderTarget;
      attemptId: string;
      fencingToken: bigint;
      nativeSurface: ProtocolSurface;
      attemptCount: number;
      terminal: Promise<{ ok: boolean; responseBytes: number }>;
      /** Record commitment only when the final rendered response emits a byte. */
      markFirstClientByte: () => Promise<void>;
      affinity: PublicProviderTarget["affinity"];
    }
  | { dispatched: false; reason: PublicOverflowSkipReason; detail?: string };

function targetProtocol(providerType: string): ProviderProtocol | null {
  const normalized = providerType.trim().toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "openai" || normalized === "openai-compatible") return "openai";
  return null;
}

function nativeProtocols(value: unknown): ProviderProtocol[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const values = Array.isArray(record.protocols) ? record.protocols : [];
  const parsed = values.filter(
    (item): item is ProviderProtocol => item === "openai" || item === "anthropic",
  );
  return parsed;
}

function nativeSurfaces(value: unknown): ProtocolSurface[] {
  if (!value || typeof value !== "object") return [];
  const values = (value as Record<string, unknown>).surfaces;
  if (!Array.isArray(values)) return [];
  return values.filter(
    (item): item is ProtocolSurface =>
      item === "openai-chat" || item === "openai-responses" || item === "anthropic-messages",
  );
}

function supportsStreaming(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && (value as Record<string, unknown>).streaming === true,
  );
}

function supportedFeatures(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const features = (value as Record<string, unknown>).features;
  return Array.isArray(features)
    ? features.filter((feature): feature is string => typeof feature === "string")
    : [];
}

export async function listPublicOverflowTargets(
  userId: string,
  poolId: string,
): Promise<ListedPublicOverflowTargets> {
  const pool = await prisma.modelPool.findFirst({
    where: { id: poolId, userId },
    select: {
      publicEgressEnabled: true,
      publicEgressAcknowledged: true,
      affinityEnabled: true,
      affinityTtlSeconds: true,
      affinityMaxRecords: true,
      affinityPrefixWeight: true,
      affinityConversationWeight: true,
      affinityConfirmedCacheWeight: true,
      affinityLoadPenaltyWeight: true,
      PoolMembers: {
        where: { tier: "PUBLIC_OVERFLOW", routingStatus: "ACTIVE" },
        orderBy: [{ publicOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          publicOrder: true,
          ExecutionTarget: {
            select: {
              id: true,
              ProviderModel: {
                select: {
                  id: true,
                  userId: true,
                  upstreamModelId: true,
                  contextWindow: true,
                  maxOutputTokens: true,
                  concurrencyLimit: true,
                  nativeCapabilities: true,
                  healthStatus: true,
                  healthNextRetryAt: true,
                  enabled: true,
                  deletedAt: true,
                  ProviderAccount: {
                    select: {
                      id: true,
                      userId: true,
                      providerType: true,
                      providerVersion: true,
                      baseUrl: true,
                      endpointIdentity: true,
                      endpointVersion: true,
                      authType: true,
                      healthStatus: true,
                      healthNextRetryAt: true,
                      enabled: true,
                      deletedAt: true,
                      CurrentCredential: {
                        select: {
                          id: true,
                          credentialType: true,
                          aadVersion: true,
                          algorithm: true,
                          keyVersion: true,
                          ciphertext: true,
                          nonce: true,
                          authTag: true,
                          status: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const defaultAffinityPolicy: AffinityPolicy = {
    enabled: false,
    ttlSeconds: 3600,
    maxRecords: 10_000,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 250,
    loadPenaltyWeight: 100,
  };
  if (!pool)
    return {
      enabled: false,
      acknowledged: false,
      affinityPolicy: defaultAffinityPolicy,
      targets: [],
    };
  const targets = pool.PoolMembers.flatMap((member) => {
    const model = member.ExecutionTarget?.ProviderModel;
    const account = model?.ProviderAccount;
    const credential = account?.CurrentCredential;
    const protocol = account ? targetProtocol(account.providerType) : null;
    if (
      !model ||
      !account ||
      !credential ||
      !protocol ||
      member.publicOrder == null ||
      model.userId !== userId ||
      account.userId !== userId ||
      !model.enabled ||
      !account.enabled ||
      model.deletedAt ||
      account.deletedAt ||
      credential.status !== "ACTIVE" ||
      (model.healthStatus === "UNAVAILABLE" && model.healthNextRetryAt === null) ||
      (account.healthStatus === "UNAVAILABLE" && account.healthNextRetryAt === null)
    )
      return [];
    return [
      {
        poolMemberId: member.id,
        executionTargetId: member.ExecutionTarget!.id,
        publicOrder: member.publicOrder,
        providerModelId: model.id,
        upstreamModelId: model.upstreamModelId,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        protocol,
        providerAccountId: account.id,
        endpointIdentity: account.endpointIdentity,
        endpointVersion: account.endpointVersion,
        concurrencyLimit: model.concurrencyLimit,
        providerVersion: account.providerVersion,
        baseUrl: account.baseUrl,
        authType: account.authType,
        healthStatus: model.healthStatus,
        nativeProtocols: nativeProtocols(model.nativeCapabilities),
        nativeSurfaces: nativeSurfaces(model.nativeCapabilities),
        supportsStreaming: supportsStreaming(model.nativeCapabilities),
        supportedFeatures: supportedFeatures(model.nativeCapabilities),
        credential,
      } satisfies PublicProviderTarget,
    ];
  });
  return {
    enabled: pool.publicEgressEnabled,
    acknowledged: pool.publicEgressAcknowledged,
    affinityPolicy: {
      enabled: pool.affinityEnabled,
      ttlSeconds: pool.affinityTtlSeconds,
      maxRecords: pool.affinityMaxRecords,
      prefixWeight: pool.affinityPrefixWeight,
      conversationWeight: pool.affinityConversationWeight,
      confirmedCacheWeight: pool.affinityConfirmedCacheWeight,
      loadPenaltyWeight: pool.affinityLoadPenaltyWeight,
    },
    targets,
  };
}

function joinProviderUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const cleanBase = base.pathname.replace(/\/$/u, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  base.pathname = `${cleanBase}${cleanPath}`;
  return base.toString();
}

function responseHeaders(headers: import("node:http").IncomingHttpHeaders): Headers {
  const result = new Headers();
  const allowed = new Set([
    "content-type",
    "cache-control",
    "retry-after",
    "request-id",
    "x-request-id",
    "anthropic-request-id",
    "openai-processing-ms",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name.toLowerCase()) || value === undefined) continue;
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

function providerAuth(target: PublicProviderTarget, secret: string): ProviderEgressAuth {
  if (target.authType !== target.credential.credentialType) throw new Error("credential mismatch");
  return target.authType === "API_KEY"
    ? { type: "API_KEY", apiKey: secret }
    : { type: "BEARER", token: secret };
}

function replaceModel(body: Uint8Array, model: string): Uint8Array {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  parsed.model = model;
  return new TextEncoder().encode(JSON.stringify(parsed));
}

function terminalReason(signal: AbortSignal, ok: boolean) {
  return signal.aborted
    ? ("CANCELLED" as const)
    : ok
      ? ("COMPLETED" as const)
      : ("FAILED" as const);
}

function usageInteger(value: unknown): bigint | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : undefined;
}

function usageString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function usageCost(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const candidate = usageString(value);
  if (!candidate) return undefined;
  try {
    const parsed = new Prisma.Decimal(candidate);
    return parsed.isFinite() && !parsed.isNegative() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exclusiveMany(
  total: bigint | undefined,
  subsets: readonly (bigint | undefined)[],
): bigint | undefined {
  if (total === undefined) return undefined;
  const represented = subsets.reduce<bigint>((sum, item) => sum + (item ?? 0n), 0n);
  return represented <= total ? total - represented : undefined;
}

export function usageFromObject(value: unknown): RawProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;
  // Responses terminal stream events nest the authoritative usage object in
  // `response.usage`; Chat and Anthropic expose it at the other two shapes.
  const raw = (root.usage ?? root.response ?? root.message) as Record<string, unknown> | undefined;
  const usage =
    raw?.usage && typeof raw.usage === "object" ? (raw.usage as Record<string, unknown>) : raw;
  if (!usage || typeof usage !== "object") return undefined;
  const promptDetails = usageRecord(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const completionDetails = usageRecord(
    usage.completion_tokens_details ?? usage.output_tokens_details,
  );
  const cacheReadTokens = usageInteger(
    usage.cache_read_input_tokens ?? promptDetails?.cached_tokens,
  );
  const cacheWriteTokens = usageInteger(usage.cache_creation_input_tokens);
  const reasoningTokens = usageInteger(completionDetails?.reasoning_tokens);
  const inputAudioTokens = usageInteger(promptDetails?.audio_tokens);
  const outputAudioTokens = usageInteger(completionDetails?.audio_tokens);
  const acceptedPredictionTokens = usageInteger(completionDetails?.accepted_prediction_tokens);
  const rejectedPredictionTokens = usageInteger(completionDetails?.rejected_prediction_tokens);
  const promptTotal = usageInteger(usage.input_tokens ?? usage.prompt_tokens);
  const completionTotal = usageInteger(usage.output_tokens ?? usage.completion_tokens);
  const openAiShape =
    usage.prompt_tokens !== undefined ||
    usage.completion_tokens !== undefined ||
    usage.input_tokens_details !== undefined ||
    usage.output_tokens_details !== undefined ||
    usage.prompt_tokens_details !== undefined ||
    usage.completion_tokens_details !== undefined;
  const inputTokens = openAiShape
    ? exclusiveMany(promptTotal, [cacheReadTokens, inputAudioTokens])
    : promptTotal;
  const outputTokens = openAiShape
    ? exclusiveMany(completionTotal, [
        reasoningTokens,
        outputAudioTokens,
        acceptedPredictionTokens,
        rejectedPredictionTokens,
      ])
    : completionTotal;
  const explicitAdditional = usageInteger(usage.additional_billable_tokens);
  const additionalParts = [
    explicitAdditional,
    inputAudioTokens,
    outputAudioTokens,
    acceptedPredictionTokens,
    rejectedPredictionTokens,
  ];
  const additionalBillableTokens = additionalParts.some((item) => item !== undefined)
    ? additionalParts.reduce<bigint>((sum, item) => sum + (item ?? 0n), 0n)
    : undefined;
  const authoritativeBillableTokens = usageInteger(usage.billable_tokens);
  const reportedTotalTokens = usageInteger(usage.total_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    authoritativeBillableTokens === undefined &&
    reasoningTokens === undefined &&
    usageInteger(usage.tool_tokens) === undefined &&
    additionalBillableTokens === undefined
  )
    return undefined;
  const reportedCost = usageCost(usage.cost ?? usage.total_cost);
  const knownUsageKeys = new Set([
    "input_tokens",
    "prompt_tokens",
    "output_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens_details",
    "prompt_tokens_details",
    "output_tokens_details",
    "completion_tokens_details",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "billable_tokens",
    "tool_tokens",
    "additional_billable_tokens",
    "cost",
    "total_cost",
    "currency",
    "pricing_version",
  ]);
  const knownPromptDetailKeys = new Set(["cached_tokens", "audio_tokens"]);
  const knownCompletionDetailKeys = new Set([
    "reasoning_tokens",
    "audio_tokens",
    "accepted_prediction_tokens",
    "rejected_prediction_tokens",
  ]);
  const hasUnknownUsageCategory = Object.keys(usage).some((key) => !knownUsageKeys.has(key));
  const hasUnknownPromptDetail =
    promptDetails !== undefined &&
    Object.keys(promptDetails).some((key) => !knownPromptDetailKeys.has(key));
  const hasUnknownCompletionDetail =
    completionDetails !== undefined &&
    Object.keys(completionDetails).some((key) => !knownCompletionDetailKeys.has(key));
  const hasInvalidKnownDetail = [
    [promptDetails, "cached_tokens"],
    [promptDetails, "audio_tokens"],
    [completionDetails, "reasoning_tokens"],
    [completionDetails, "audio_tokens"],
    [completionDetails, "accepted_prediction_tokens"],
    [completionDetails, "rejected_prediction_tokens"],
  ].some(
    ([details, key]) =>
      details !== undefined &&
      Object.hasOwn(details as Record<string, unknown>, key as string) &&
      usageInteger((details as Record<string, unknown>)[key as string]) === undefined,
  );
  const knownIntegerFields = [
    "input_tokens",
    "prompt_tokens",
    "output_tokens",
    "completion_tokens",
    "total_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "billable_tokens",
    "tool_tokens",
    "additional_billable_tokens",
  ];
  const hasInvalidKnownInteger = knownIntegerFields.some(
    (key) => Object.hasOwn(usage, key) && usageInteger(usage[key]) === undefined,
  );
  const impossibleBreakdown =
    (promptTotal !== undefined &&
      exclusiveMany(promptTotal, [cacheReadTokens, inputAudioTokens]) === undefined) ||
    (completionTotal !== undefined &&
      exclusiveMany(completionTotal, [
        reasoningTokens,
        outputAudioTokens,
        acceptedPredictionTokens,
        rejectedPredictionTokens,
      ]) === undefined);
  const hasUnknownCategories =
    hasUnknownUsageCategory ||
    hasUnknownPromptDetail ||
    hasUnknownCompletionDetail ||
    hasInvalidKnownDetail ||
    hasInvalidKnownInteger ||
    impossibleBreakdown;
  const normalizedCategoryTotal =
    inputTokens !== undefined && outputTokens !== undefined
      ? [
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
          usageInteger(usage.tool_tokens),
          additionalBillableTokens,
        ].reduce<bigint>((sum, item) => sum + (item ?? 0n), 0n)
      : undefined;
  const categoriesComplete = hasUnknownCategories
    ? false
    : authoritativeBillableTokens !== undefined ||
        inputTokens === undefined ||
        outputTokens === undefined
      ? undefined
      : !(reportedTotalTokens !== undefined && reportedTotalTokens !== normalizedCategoryTotal);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    toolTokens: usageInteger(usage.tool_tokens),
    additionalBillableTokens,
    authoritativeBillableTokens,
    reportedTotalTokens,
    categoriesComplete,
    rawUsage: JSON.parse(JSON.stringify(usage)),
    reportedCost,
    reportedCostCurrency: usageString(usage.currency)?.toUpperCase(),
    reportedCostPricingVersion: usageString(usage.pricing_version),
    reportedCostSource: reportedCost === undefined ? undefined : "provider-runtime",
    accountingVersion: "provider-billable-v1",
    confidence: "REPORTED",
  };
}

export function parseProviderUsage(
  chunks: readonly Uint8Array[],
  pricing?: ProviderPricingSchedule,
) {
  if (chunks.length === 0) return undefined;
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const candidates = [text];
  // SSE observations are decoded in wire order below. Tail extraction is for
  // a bounded/truncated JSON response only; adding it for SSE would reorder
  // and duplicate the terminal observation ahead of earlier events.
  const tailUsage = /(?:^|\r?\n)data:/u.test(text) ? undefined : extractTailUsageObject(text);
  if (tailUsage) candidates.push(JSON.stringify({ usage: tailUsage }));
  const decoder = new SseDecoder();
  try {
    for (const chunk of chunks) {
      for (const event of decoder.push(chunk)) candidates.push(event.data);
    }
    for (const event of decoder.finish()) candidates.push(event.data);
  } catch {
    // A non-SSE JSON response or a truncated error body is still considered
    // through the whole-body candidate above.
  }
  let found: RawProviderUsage | undefined;
  let categoriesComplete = true;
  const rawObservations: Prisma.InputJsonValue[] = [];
  const rawObservationKeys = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue;
    try {
      const observed = usageFromObject(JSON.parse(candidate));
      if (observed) {
        if (observed.categoriesComplete === false) categoriesComplete = false;
        if (observed.rawUsage !== undefined) {
          const observationKey = JSON.stringify(observed.rawUsage);
          if (!rawObservationKeys.has(observationKey)) {
            rawObservationKeys.add(observationKey);
            rawObservations.push(observed.rawUsage);
          }
        }
        const definedObserved = Object.fromEntries(
          Object.entries(observed).filter(([, item]) => item !== undefined),
        );
        found = { ...found, ...definedObserved } as RawProviderUsage;
      }
    } catch {
      // Arbitrary stream splits and non-JSON events are expected. Missing
      // trustworthy usage settles at the conservative admission liability.
    }
  }
  if (!found) return undefined;
  const normalized: RawProviderUsage = {
    ...found,
    rawUsage: rawObservations.length === 1 ? found.rawUsage : rawObservations,
    categoriesComplete:
      found.authoritativeBillableTokens === undefined &&
      found.inputTokens !== undefined &&
      found.outputTokens !== undefined &&
      categoriesComplete,
  };
  const calculated = pricing ? calculatedCostForUsage(normalized, pricing) : undefined;
  return calculated
    ? {
        ...normalized,
        calculatedCost: calculated,
        calculatedCostCurrency: pricing!.currency,
        calculatedCostPricingVersion: pricing!.version,
        calculatedCostSource: "wsmp-pricing",
        calculatedCostConfidence:
          pricing!.confidence === "REPORTED" ? "CALCULATED" : pricing!.confidence,
        pricingVersion: pricing!.version,
        currency: pricing!.currency,
        accountingVersion: pricing!.accountingVersion,
      }
    : normalized;
}

export function providerStreamHasTerminalUsageEvent(
  chunks: readonly Uint8Array[],
  surface: ProtocolSurface,
): boolean {
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  if (surface === "anthropic-messages")
    return (
      /(?:^|\n)event:\s*message_stop\s*(?:\r?\n|$)/u.test(text) ||
      /"type"\s*:\s*"message_stop"/u.test(text)
    );
  if (surface === "openai-responses")
    return /"type"\s*:\s*"response\.(?:completed|failed|cancelled|incomplete)"/u.test(text);
  return /(?:^|\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/u.test(text);
}

export function extractTailUsageObject(text: string): Record<string, unknown> | undefined {
  const marker = text.lastIndexOf('"usage"');
  if (marker < 0) return undefined;
  const colon = text.indexOf(":", marker + 7);
  const start = colon < 0 ? -1 : text.indexOf("{", colon + 1);
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return usageRecord(JSON.parse(text.slice(start, index + 1)));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function retainProviderUsageTail(
  chunks: Uint8Array[],
  currentBytes: number,
  chunk: Uint8Array,
  maxBytes = 1024 * 1024,
): number {
  const overflowed = currentBytes + chunk.byteLength > maxBytes;
  const chunkView = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const prior = Buffer.concat(chunks.map((item) => Buffer.from(item)));
  let retained =
    chunk.byteLength >= maxBytes
      ? chunkView.subarray(-maxBytes)
      : Buffer.concat([prior, chunkView]).subarray(-maxBytes);
  // If truncation cut through an SSE event, begin at the next complete event.
  // This prevents a partial multi-megabyte content delta from poisoning the
  // decoder before it reaches terminal usage.
  if (overflowed) {
    const boundaries = [
      retained.indexOf("\n\n"),
      retained.indexOf("\r\n\r\n"),
      retained.indexOf("\r\r"),
    ]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    const boundary = boundaries[0];
    if (boundary !== undefined) {
      const width = retained
        .subarray(boundary, boundary + 4)
        .toString()
        .startsWith("\r\n\r\n")
        ? 4
        : 2;
      retained = retained.subarray(boundary + width);
    }
  }
  chunks.splice(0, chunks.length, new Uint8Array(retained));
  return retained.byteLength;
}

const MAX_RETRYABLE_PROVIDER_BODY_BYTES = 1024 * 1024;

async function readRetryableProviderUsage(
  response: AsyncIterable<Uint8Array> & { complete: boolean; destroy(error?: Error): void },
  pricing?: ProviderPricingSchedule,
): Promise<RawProviderUsage | undefined> {
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let receivedBytes = 0;
  try {
    for await (const rawChunk of response) {
      const chunk = Uint8Array.from(rawChunk);
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_RETRYABLE_PROVIDER_BODY_BYTES) {
        response.destroy(new Error("Retryable provider response exceeded accounting limit"));
        return undefined;
      }
      retainedBytes = retainProviderUsageTail(
        chunks,
        retainedBytes,
        chunk,
        MAX_RETRYABLE_PROVIDER_BODY_BYTES,
      );
    }
  } catch {
    return undefined;
  }
  return response.complete ? parseProviderUsage(chunks, pricing) : undefined;
}

async function recordProviderHealth(
  target: PublicProviderTarget,
  userId: string,
  success: boolean,
  response?: { status: number; retryAfter?: string | string[] },
  owner?: { attemptId: string; fencingToken: bigint },
): Promise<void> {
  await recordProviderOutcome({
    userId,
    providerAccountId: target.providerAccountId,
    providerModelId: target.providerModelId,
    success,
    failureClass: success ? undefined : classifyProviderFailure(response?.status),
    retryAfterMs: success ? undefined : parseRetryAfter(response?.retryAfter),
    ...owner,
  }).catch(() => undefined);
}

export function providerHealthOutcome(status: number): "SUCCESS" | "FAILURE" | "NEUTRAL" {
  if (status >= 200 && status < 400) return "SUCCESS";
  if (status === 408 || status === 409 || status === 429 || status >= 500) return "FAILURE";
  // Ordinary client errors demonstrate neither provider recovery nor provider
  // failure. In particular they must not clear an existing cooldown.
  return "NEUTRAL";
}

function selectedNativeSurface(target: PublicProviderTarget, requested: ProtocolSurface) {
  if (target.nativeSurfaces.includes(requested)) return requested;
  return target.nativeSurfaces.find((surface) =>
    target.protocol === "anthropic"
      ? surface === "anthropic-messages"
      : surface === "openai-responses" || surface === "openai-chat",
  );
}

function providerHealthPenalty(status: PublicProviderTarget["healthStatus"]): number {
  return status === "UNAVAILABLE"
    ? 200
    : status === "DEGRADED"
      ? 100
      : status === "UNKNOWN"
        ? 25
        : 0;
}

function providerCostPenalty(liability: ProviderLiability): number {
  if (!liability.spend) return 0;
  // One score point per micro-unit of the provider's configured currency. The
  // value is derived from the selected immutable pricing schedule, not labels
  // or administrator ordering.
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.ceil(Number(liability.spend.toString()) * 1_000_000),
  );
}

export async function rankPublicOverflowTargets(input: {
  request: PublicOverflowRequest;
  policy: AffinityPolicy;
  targets: PublicProviderTarget[];
}): Promise<{ targets: PublicProviderTarget[]; decision: AffinityDecision | null }> {
  if (!input.policy.enabled || input.targets.length < 2)
    return { targets: input.targets, decision: null };
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(input.request.body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { targets: input.targets, decision: null };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { targets: input.targets, decision: null };
  }
  const [loads, pricing] = await Promise.all([
    prisma.providerAttempt.groupBy({
      by: ["providerModelId"],
      where: {
        userId: input.request.userId,
        state: "ACTIVE",
        providerModelId: { in: input.targets.map((target) => target.providerModelId) },
      },
      _count: { _all: true },
    }),
    Promise.all(
      input.targets.map((target) =>
        resolveActiveProviderPricing({
          userId: input.request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
        }),
      ),
    ),
  ]);
  const loadByModel = new Map(loads.map((row) => [row.providerModelId, row._count._all]));
  const affinityTargets = input.targets.map((target, index) => {
    const targetPricing = pricing[index];
    const liability =
      input.request.estimatedInputTokens !== undefined &&
      input.request.requestedOutputTokens !== undefined
        ? liabilityFromPricing({
            estimatedInputTokens: input.request.estimatedInputTokens,
            requestedOutputTokens: input.request.requestedOutputTokens,
            pricing: targetPricing,
          })
        : input.request.liability;
    return {
      poolMemberId: target.poolMemberId,
      executionTargetId: target.executionTargetId,
      targetIdentity: buildAffinityTargetIdentity({
        executionTargetId: target.executionTargetId,
        endpointIdentity: `${target.providerAccountId}:${target.endpointIdentity}:${target.endpointVersion}`,
        upstreamModelId: `${target.providerModelId}:${target.upstreamModelId}`,
        runtimeIdentityKey: target.providerAccountId,
        runtimeModel: target.upstreamModelId,
        runtimeRevision: target.providerVersion,
        tokenizer: null,
        tokenizerVersion: null,
        template: null,
        templateVersion: null,
        engine: target.protocol,
        cacheNamespace: null,
        requestedSurface: input.request.requestedSurface,
        nativeSurface:
          selectedNativeSurface(target, input.request.requestedSurface) ??
          input.request.requestedSurface,
        mode: target.nativeSurfaces.includes(input.request.requestedSurface) ? "native" : "adapted",
        adapterVersion: target.nativeSurfaces.includes(input.request.requestedSurface)
          ? "native"
          : "1.0.0",
      }),
      capacityId: `provider:${target.providerModelId}`,
      hardConcurrencyLimit: target.concurrencyLimit ?? null,
      activeLoad: loadByModel.get(target.providerModelId) ?? 0,
      waitingLoad: 0,
      healthPenalty: providerHealthPenalty(target.healthStatus),
      publicEgressPenalty: 100,
      costPenalty: providerCostPenalty(liability),
    };
  });
  const decision = await rankAffinityTargets({
    ownerId: input.request.userId,
    resourceOwnerId: input.request.userId,
    poolId: input.request.poolId,
    policy: input.policy,
    surface: input.request.requestedSurface,
    payload,
    targets: affinityTargets,
  });
  const byId = new Map(input.targets.map((target) => [target.executionTargetId, target]));
  return {
    decision,
    targets: decision.orderedTargetIds.flatMap((id) => {
      const target = byId.get(id);
      return target
        ? [
            {
              ...target,
              affinityTarget: affinityTargets.find(
                (candidate) => candidate.executionTargetId === id,
              ),
              affinity: {
                outcome:
                  (decision.prefixDepths[id] ?? 0) > 0 || decision.conversationMatches[id]
                    ? "PREDICTED_MATCH"
                    : "NO_MATCH",
                score: decision.scores[id],
                prefixDepth: decision.prefixDepths[id],
                reason: decision.reasons[id],
              },
            },
          ]
        : [];
    }),
  };
}

/**
 * Dispatches ordered provider attempts. Every attempt owns a distinct durable
 * budget reservation and is reconciled before the next target is considered.
 * A returned response is committed: later body/stream failures never fail over.
 */
export async function dispatchPublicOverflow(
  request: PublicOverflowRequest,
): Promise<PublicOverflowResult> {
  if (!env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED)
    return { dispatched: false, reason: "DEPLOYMENT_GATE_DISABLED" };
  const listed = await listPublicOverflowTargets(request.userId, request.poolId);
  if (!listed.enabled) return { dispatched: false, reason: "POOL_PRIVATE" };
  if (!listed.acknowledged) return { dispatched: false, reason: "POOL_ACKNOWLEDGEMENT_MISSING" };
  // Payload size may change during cross-protocol rendering. Do the initial
  // pass with zero input solely to reject protocol/feature/output mismatches;
  // each target is checked again with its actual rendered wire size below.
  const compatible = listed.targets.filter(
    (target) =>
      publicTargetCompatibility(target, {
        ...request,
        liability: request.liability,
        contextTokens: 0n,
      }) === "COMPATIBLE",
  );
  if (compatible.length === 0) {
    await Promise.allSettled(
      listed.targets.map((target) =>
        recordProviderAttemptEvent({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          requestId: request.requestId,
          attemptId: `${request.requestId}:compatibility-skip:${target.providerModelId}`,
          eventType: "SKIP",
          reason: publicTargetCompatibility(target, request),
          ...providerEventRouting({ request, target }),
        }),
      ),
    );
    return { dispatched: false, reason: "NO_COMPATIBLE_PROVIDER" };
  }

  const ranked = await rankPublicOverflowTargets({
    request,
    policy: listed.affinityPolicy,
    targets: compatible,
  });

  await request.releaseLocalCapacity();
  const keyringValue = env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  if (!keyringValue) return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
  const keyring = parseProviderCredentialKeyring(keyringValue);
  let lastAdmission: ProviderBudgetAdmission | undefined;
  let attemptCount = 0;

  for (const target of ranked.targets) {
    const nativeSurface = selectedNativeSurface(target, request.requestedSurface);
    if (!nativeSurface) continue;
    attemptCount += 1;
    const attemptId = crypto.randomUUID();
    let fencingToken: bigint;
    try {
      fencingToken = await allocateProviderFence({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
      });
    } catch {
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        requestId: request.requestId,
        attemptId,
        eventType: "TERMINAL",
        reason: "FENCE_ALLOCATION_FAILED",
        ...providerEventRouting({ request, target, nativeSurface }),
        terminalState: "FAILED",
      }).catch(() => undefined);
      continue;
    }
    let upstream: { protocol: ProviderProtocol; path: string; headers: Headers; body: Uint8Array };
    try {
      upstream =
        nativeSurface === request.requestedSurface
          ? {
              protocol: request.requestedProtocol,
              path: request.path,
              headers: request.headers,
              body: replaceModel(request.body, target.upstreamModelId),
            }
          : await request.renderForTarget!(target, nativeSurface);
    } catch {
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: "REQUEST_RENDER_FAILED",
        ...providerEventRouting({ request, target, nativeSurface }),
        terminalState: "SKIPPED",
      }).catch(() => undefined);
      continue;
    }
    // Resolve by immutable account/model identity and admission time. This is
    // intentionally per attempt so fallback cannot inherit another target's
    // price, currency, or accounting contract.
    const pricing = await resolveActiveProviderPricing({
      userId: request.userId,
      providerAccountId: target.providerAccountId,
      providerModelId: target.providerModelId,
    }).catch(() => undefined);
    const requestedOutputTokens =
      request.requestedOutputTokens ??
      (target.maxOutputTokens === null ? undefined : BigInt(target.maxOutputTokens));
    if (requestedOutputTokens === undefined) {
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: "OUTPUT_BOUND_UNAVAILABLE",
        ...providerEventRouting({ request, target, nativeSurface }),
        terminalState: "SKIPPED",
      }).catch(() => undefined);
      continue;
    }
    const renderedInputTokens = conservativeSerializedInputTokens(upstream.body.byteLength);
    const renderedLiability = liabilityFromPricing({
      estimatedInputTokens: renderedInputTokens,
      requestedOutputTokens,
      pricing,
    });
    const renderedContextTokens = checkedContextTokens(renderedInputTokens, requestedOutputTokens);
    const renderedCompatibility = publicTargetCompatibility(target, {
      ...request,
      liability: renderedLiability,
      estimatedInputTokens: renderedInputTokens,
      contextTokens: renderedContextTokens,
      requestedOutputTokens,
    });
    if (renderedCompatibility !== "COMPATIBLE") {
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: renderedCompatibility,
        ...providerEventRouting({ request, target, nativeSurface }),
        contextTokens: renderedContextTokens,
        terminalState: "SKIPPED",
      }).catch(() => undefined);
      continue;
    }
    const admissionStartedAt = Date.now();
    let admission: ProviderBudgetAdmission;
    try {
      admission = await admitProviderBudget({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        credentialId: target.credential.id,
        poolId: request.poolId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        liability: renderedLiability,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
    } catch {
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: "BUDGET_ADMISSION_FAILED",
        ...providerEventRouting({ request, target, nativeSurface }),
        contextTokens: renderedContextTokens,
        terminalState: "FAILED",
      }).catch(() => undefined);
      continue;
    }
    const providerWaitDurationMs = Math.max(0, Date.now() - admissionStartedAt);
    lastAdmission = admission;
    if (!admission.admitted) {
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: admission.reason,
        ...providerEventRouting({ request, target, nativeSurface }),
        waitDurationMs: providerWaitDurationMs,
        contextTokens: renderedLiability.tokens,
        terminalState: "SKIPPED",
      }).catch(() => undefined);
      continue;
    }
    const providerAttemptId = admission.providerAttemptId;

    const healthClaim = await claimProviderHealthTrial({
      userId: request.userId,
      providerAccountId: target.providerAccountId,
      providerModelId: target.providerModelId,
      attemptId,
      fencingToken,
    }).catch(() => "COOLDOWN" as const);
    if (healthClaim === "COOLDOWN") {
      await reconcileProviderBudget({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        credentialId: target.credential.id,
        poolId: request.poolId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        reason: "FAILED",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }).catch(() => undefined);
      await finishProviderAttempt({
        attemptId,
        fencingToken,
        state: "FAILED",
        reason: "PROVIDER_HEALTH_COOLDOWN",
      }).catch(() => false);
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        providerAttemptId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: "PROVIDER_HEALTH_COOLDOWN",
        ...providerEventRouting({ request, target, nativeSurface }),
        reservationId: admission.reservationIds[0],
        reservationIds: admission.reservationIds,
        waitDurationMs: providerWaitDurationMs,
        contextTokens: renderedLiability.tokens,
        terminalState: "FAILED",
      }).catch(() => undefined);
      continue;
    }

    // Start before credential lookup and provider connection establishment:
    // either can consume most of the 14-minute end-to-end timeout. Renewal is
    // fenced to this exact account+model claim, so an orphan cannot revive a
    // successor's half-open lease.
    let destroyAttempt: ((error: Error) => void) | undefined;
    const attemptController = new AbortController();
    let heartbeatActive = true;
    const stopHeartbeat = () => {
      heartbeatActive = false;
      clearInterval(heartbeatTimer);
    };
    const loseOwnership = (error: Error) => {
      if (!heartbeatActive) return;
      heartbeatActive = false;
      attemptController.abort(error);
      destroyAttempt?.(error);
    };
    const heartbeatTimer = setInterval(() => {
      void heartbeatProviderAttempt({ attemptId, fencingToken, extensionMs: 15 * 60_000 })
        .then((alive) => {
          if (!alive) loseOwnership(new Error("provider attempt lease expired"));
        })
        .catch(() => loseOwnership(new Error("provider attempt heartbeat failed")));
    }, 10_000);
    heartbeatTimer.unref();

    await recordProviderAttemptEvent({
      userId: request.userId,
      providerAccountId: target.providerAccountId,
      providerModelId: target.providerModelId,
      providerAttemptId,
      requestId: request.requestId,
      attemptId,
      fencingToken,
      eventType: "DISPATCH",
      reason: request.reason,
      ...providerEventRouting({ request, target, nativeSurface }),
      reservationId: admission.reservationIds[0],
      reservationIds: admission.reservationIds,
      waitDurationMs: providerWaitDurationMs,
      contextTokens: renderedLiability.tokens,
      metadata: { healthClaim },
    }).catch(() => undefined);

    try {
      // Establish a durable send-start boundary while holding the same
      // account-then-credential locks used by lifecycle mutations. A revoke or
      // replacement that commits before this transaction is rejected here; one
      // that commits afterwards cannot retroactively cancel a send that has
      // already been claimed. Never hold database locks across provider I/O.
      const secret = await claimPublicProviderCredentialForSend({
        userId: request.userId,
        target,
        keyring,
      });
      const response = await providerHttpsRequest(
        joinProviderUrl(target.baseUrl, upstream.path),
        {
          method: "POST",
          headers: Object.fromEntries(upstream.headers.entries()),
          body: upstream.body,
          signal: AbortSignal.any([
            request.signal,
            attemptController.signal,
            AbortSignal.timeout(14 * 60_000),
          ]),
        },
        {
          egressEnabled: true,
          allowPrivateNetworks: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
          timeoutMs: 60_000,
        },
        upstream.protocol,
        providerAuth(target, secret),
      );
      destroyAttempt = (error) => response.destroy(error);
      const status = response.statusCode ?? 502;
      // Retry only before exposing headers/body to the caller.
      if (
        request.retrySafe &&
        target !== compatible.at(-1) &&
        (status === 408 || status === 409 || status === 429 || status >= 500)
      ) {
        // Failed/rate-limited calls may still be billed. Consume only a strict
        // bounded body before retry, retaining raw usage/cost when present;
        // ambiguous, truncated, or oversized bodies keep conservative liability.
        const retryUsage = await readRetryableProviderUsage(response, pricing);
        if (!response.complete) response.destroy();
        // Heartbeat loss means a successor may already own health state. Do
        // not let this orphan's retryable response mutate that state. The
        // fenced release is deliberately attempted in either case: it clears
        // only this exact half-open owner and is a no-op for READY attempts or
        // a successor-owned probe.
        if (!attemptController.signal.aborted) {
          await recordProviderOutcome({
            userId: request.userId,
            providerAccountId: target.providerAccountId,
            providerModelId: target.providerModelId,
            success: false,
            failureClass: classifyProviderFailure(status),
            retryAfterMs: parseRetryAfter(response.headers["retry-after"]),
            attemptId,
            fencingToken,
          }).catch(() => undefined);
        } else {
          await releaseProviderHealthTrial({
            userId: request.userId,
            providerAccountId: target.providerAccountId,
            providerModelId: target.providerModelId,
            attemptId,
            fencingToken,
          }).catch(() => false);
        }
        stopHeartbeat();
        await reconcileProviderBudget({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          credentialId: target.credential.id,
          poolId: request.poolId,
          requestId: request.requestId,
          attemptId,
          fencingToken,
          reason: "FAILED",
          revisionSequence: 1n,
          revisionKind: "SNAPSHOT",
          usageSource: retryUsage ? `${upstream.protocol}-retryable-response` : undefined,
          usage: retryUsage,
        });
        await finishProviderAttempt({
          attemptId,
          fencingToken,
          state: "FAILED",
          reason: `HTTP_${status}`,
        });
        await recordProviderAttemptEvent({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          providerAttemptId,
          requestId: request.requestId,
          attemptId,
          fencingToken,
          eventType: "TERMINAL",
          reason: classifyProviderFailure(status),
          ...providerEventRouting({ request, target, nativeSurface }),
          reservationId: admission.reservationIds[0],
          reservationIds: admission.reservationIds,
          waitDurationMs: providerWaitDurationMs,
          terminalState: "FAILED",
          contextTokens: renderedLiability.tokens,
        }).catch(() => undefined);
        continue;
      }
      const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
      const reader = body.getReader();
      let reconciled = false;
      let responseBytes = 0;
      let firstClientByteAt: Date | undefined;
      let firstClientBytePersistence: Promise<void> | undefined;
      const usageChunks: Uint8Array[] = [];
      let usageBytes = 0;
      let resolveTerminal!: (value: { ok: boolean; responseBytes: number }) => void;
      const terminal = new Promise<{ ok: boolean; responseBytes: number }>((resolve) => {
        resolveTerminal = resolve;
      });
      const httpOk = status >= 200 && status < 400;
      const reconcile = async (streamComplete: boolean) => {
        if (reconciled) return;
        reconciled = true;
        stopHeartbeat();
        const ok = streamComplete && httpOk;
        const healthOutcome = providerHealthOutcome(status);
        const attemptAborted = request.signal.aborted || attemptController.signal.aborted;
        if (!attemptAborted && healthOutcome !== "NEUTRAL") {
          await recordProviderHealth(
            target,
            request.userId,
            streamComplete && healthOutcome === "SUCCESS",
            { status, retryAfter: response.headers["retry-after"] },
            { attemptId, fencingToken },
          );
        }
        if (attemptAborted || healthOutcome === "NEUTRAL") {
          await releaseProviderHealthTrial({
            userId: request.userId,
            providerAccountId: target.providerAccountId,
            providerModelId: target.providerModelId,
            attemptId,
            fencingToken,
          }).catch(() => false);
        }
        const observedUsage = parseProviderUsage(usageChunks, pricing);
        const observationComplete =
          streamComplete &&
          (!request.stream ||
            providerStreamHasTerminalUsageEvent(
              usageChunks,
              nativeSurface ?? request.requestedSurface,
            ));
        const usage = observedUsage
          ? {
              ...observedUsage,
              // A terminal usage event may not have arrived. Retain the partial
              // provider observation for audit, but never release conservative
              // liability based on it.
              categoriesComplete: observationComplete ? observedUsage.categoriesComplete : false,
            }
          : undefined;
        await reconcileProviderBudget({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          credentialId: target.credential.id,
          poolId: request.poolId,
          requestId: request.requestId,
          attemptId,
          fencingToken,
          reason: terminalReason(request.signal, ok),
          revisionSequence: 1n,
          revisionKind: "SNAPSHOT",
          usageSource: usage ? `${upstream.protocol}-response` : "missing-provider-usage",
          usage,
        }).catch(() => undefined);
        const state = request.signal.aborted ? "CANCELLED" : ok ? "COMPLETED" : "FAILED";
        await finishProviderAttempt({
          attemptId,
          fencingToken,
          state,
          reason: terminalReason(request.signal, ok),
        }).catch(() => false);
        // If client commitment already began, retain event creation order
        // without ever making client delivery wait for telemetry persistence.
        await firstClientBytePersistence;
        await recordProviderAttemptEvent({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          providerAttemptId,
          requestId: request.requestId,
          attemptId,
          fencingToken,
          eventType: "TERMINAL",
          reason: terminalReason(request.signal, ok),
          ...providerEventRouting({ request, target, nativeSurface }),
          reservationId: admission.reservationIds[0],
          reservationIds: admission.reservationIds,
          waitDurationMs: providerWaitDurationMs,
          terminalState: state,
          firstClientByteAt,
          streamCommitted: firstClientByteAt !== undefined,
          usage: usage
            ? {
                inputTokens: usage.inputTokens?.toString() ?? null,
                outputTokens: usage.outputTokens?.toString() ?? null,
                cacheReadTokens: usage.cacheReadTokens?.toString() ?? null,
                cacheWriteTokens: usage.cacheWriteTokens?.toString() ?? null,
                reasoningTokens: usage.reasoningTokens?.toString() ?? null,
                toolTokens: usage.toolTokens?.toString() ?? null,
                categoriesComplete: usage.categoriesComplete ?? null,
                accountingVersion: usage.accountingVersion,
                confidence: usage.confidence,
              }
            : undefined,
          metadata: { status, responseBytes, streamComplete },
        }).catch(() => undefined);
        resolveTerminal({ ok, responseBytes });
      };
      const heldBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              await reconcile(true);
            } else {
              responseBytes += chunk.value.byteLength;
              // Retain the bounded tail, not merely the prefix. Streaming APIs
              // report authoritative usage in terminal events, which may occur
              // after arbitrarily large content deltas.
              usageBytes = retainProviderUsageTail(usageChunks, usageBytes, chunk.value);
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            controller.error(error);
            await reconcile(false);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason).catch(() => undefined);
          response.destroy(reason instanceof Error ? reason : undefined);
          await reconcile(false);
        },
      });
      const bodyForbidden = status === 204 || status === 205 || status === 304;
      if (bodyForbidden) {
        await reader.cancel().catch(() => undefined);
        response.destroy();
        await reconcile(true);
      }
      const markFirstClientByte = async () => {
        if (firstClientByteAt) return;
        firstClientByteAt = new Date();
        firstClientBytePersistence = Promise.allSettled([
          prisma.relayRequest.updateMany({
            where: { id: request.requestId, providerAttemptId: attemptId },
            data: { streamCommitted: true },
          }),
          recordProviderAttemptEvent({
            userId: request.userId,
            providerAccountId: target.providerAccountId,
            providerModelId: target.providerModelId,
            providerAttemptId,
            requestId: request.requestId,
            attemptId,
            fencingToken,
            eventType: "FIRST_CLIENT_BYTE",
            reason: "RESPONSE_COMMITTED",
            ...providerEventRouting({ request, target, nativeSurface }),
            reservationId: admission.reservationIds[0],
            reservationIds: admission.reservationIds,
            waitDurationMs: providerWaitDurationMs,
            contextTokens: renderedLiability.tokens,
            firstClientByteAt,
            streamCommitted: true,
          }),
        ]).then(() => undefined);
        await firstClientBytePersistence;
      };
      return {
        dispatched: true,
        target,
        attemptId,
        fencingToken,
        nativeSurface,
        attemptCount,
        terminal: terminal.then(async (outcome) => {
          if (outcome.ok && target.affinityTarget) {
            try {
              const parsed: unknown = JSON.parse(new TextDecoder().decode(request.body));
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                await rememberAffinity({
                  ownerId: request.userId,
                  resourceOwnerId: request.userId,
                  poolId: request.poolId,
                  policy: listed.affinityPolicy,
                  surface: request.requestedSurface,
                  payload: parsed as Record<string, unknown>,
                  target: target.affinityTarget,
                  estimatedTokens:
                    request.estimatedInputTokens === undefined
                      ? undefined
                      : Number(
                          request.estimatedInputTokens > BigInt(Number.MAX_SAFE_INTEGER)
                            ? BigInt(Number.MAX_SAFE_INTEGER)
                            : request.estimatedInputTokens,
                        ),
                });
            } catch {
              // Affinity is a best-effort routing hint and cannot change a terminal result.
            }
          }
          return outcome;
        }),
        markFirstClientByte,
        affinity: target.affinity,
        response: new Response(bodyForbidden ? null : heldBody, {
          status,
          headers: responseHeaders(response.headers),
        }),
      };
    } catch {
      stopHeartbeat();
      // A caller disappearing before provider response is not evidence that
      // the provider transport is unhealthy. Keep the existing health state;
      // cancellation still terminalizes and reconciles the durable attempt.
      if (!request.signal.aborted && !attemptController.signal.aborted) {
        await recordProviderOutcome({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          success: false,
          failureClass: "TRANSPORT",
          attemptId,
          fencingToken,
        }).catch(() => undefined);
      }
      if (request.signal.aborted || attemptController.signal.aborted) {
        await releaseProviderHealthTrial({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          attemptId,
          fencingToken,
        }).catch(() => false);
      }
      await reconcileProviderBudget({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        credentialId: target.credential.id,
        poolId: request.poolId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        reason: request.signal.aborted ? "CANCELLED" : "FAILED",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }).catch(() => undefined);
      await finishProviderAttempt({
        attemptId,
        fencingToken,
        state: request.signal.aborted ? "CANCELLED" : "FAILED",
        reason: request.signal.aborted ? "CANCELLED" : "TRANSPORT",
      }).catch(() => false);
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        providerAttemptId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: request.signal.aborted ? "CANCELLED" : "TRANSPORT",
        ...providerEventRouting({ request, target, nativeSurface }),
        reservationId: admission.reservationIds[0],
        reservationIds: admission.reservationIds,
        waitDurationMs: providerWaitDurationMs,
        terminalState: request.signal.aborted ? "CANCELLED" : "FAILED",
        contextTokens: renderedLiability.tokens,
        streamCommitted: false,
      }).catch(() => undefined);
      if (!request.retrySafe) break;
    }
  }
  return {
    dispatched: false,
    reason:
      lastAdmission && !lastAdmission.admitted
        ? lastAdmission.reason === "PROTECTION_POLICY_MISSING"
          ? "PROTECTION_POLICY_MISSING"
          : "BUDGET_EXCEEDED"
        : "PROVIDER_UNAVAILABLE",
  };
}

export function conservativeProviderLiability(input: {
  estimatedInputTokens: bigint;
  requestedOutputTokens: bigint;
  estimatedSpend?: string;
  currency?: string;
  pricingVersion?: string;
}): ProviderLiability {
  return {
    tokens: input.estimatedInputTokens + input.requestedOutputTokens,
    spend: input.estimatedSpend,
    currency: input.currency,
    pricingVersion: input.pricingVersion,
    accountingVersion: "provider-billable-v1",
  };
}

function checkedContextTokens(inputTokens: bigint, outputTokens: bigint): bigint {
  const total = inputTokens + outputTokens;
  return total <= 9_223_372_036_854_775_807n ? total : 9_223_372_036_854_775_807n;
}

/**
 * Fail-safe input estimate for public egress when the local tokenizer did not
 * produce a count. UTF-8 bytes are used rather than JavaScript string length:
 * one token per byte is intentionally pessimistic for known provider
 * tokenizers, and the additional 10% plus fixed envelope covers provider-side
 * chat templates and small serialization differences. Most importantly, an
 * absent count can never become a zero-token budget reservation.
 */
export function conservativeSerializedInputTokens(serializedBytes: number): bigint {
  if (!Number.isSafeInteger(serializedBytes) || serializedBytes < 0)
    throw new TypeError("serializedBytes must be a non-negative safe integer");
  const bytes = BigInt(serializedBytes);
  return (bytes * 11n + 9n) / 10n + 64n;
}

export type { RawProviderUsage };
