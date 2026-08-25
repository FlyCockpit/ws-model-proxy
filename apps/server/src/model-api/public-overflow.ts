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
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import type { ProtocolSurface } from "./protocols/index.js";
import {
  allocateProviderFence,
  claimProviderHealthTrial,
  classifyProviderFailure,
  finishProviderAttempt,
  heartbeatProviderAttempt,
  parseRetryAfter,
  recordProviderAttemptEvent,
  recordProviderOutcome,
} from "./provider-attempt-runtime.js";
import {
  admitProviderBudget,
  type ProviderBudgetAdmission,
  type ProviderLiability,
  type RawProviderUsage,
  reconcileProviderBudget,
} from "./provider-budget.js";

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
  requestedOutputTokens: bigint;
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
}

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
    affinityOutcome: "NONE",
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
  >,
): "COMPATIBLE" | "CONTEXT_UNKNOWN" | "CONTEXT_EXCEEDED" | "PROTOCOL_UNAVAILABLE" {
  if (target.contextWindow === null || request.liability.tokens === undefined)
    return "CONTEXT_UNKNOWN";
  if (request.liability.tokens > BigInt(target.contextWindow)) return "CONTEXT_EXCEEDED";
  if (
    target.maxOutputTokens === null ||
    request.requestedOutputTokens > BigInt(target.maxOutputTokens)
  )
    return "CONTEXT_EXCEEDED";
  if (request.stream && !target.supportsStreaming) return "PROTOCOL_UNAVAILABLE";
  if (request.requiredFeatures.some((feature) => !target.supportedFeatures.includes(feature)))
    return "PROTOCOL_UNAVAILABLE";
  if (target.nativeSurfaces.includes(request.requestedSurface)) return "COMPATIBLE";
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
): Promise<{ enabled: boolean; acknowledged: boolean; targets: PublicProviderTarget[] }> {
  const pool = await prisma.modelPool.findFirst({
    where: { id: poolId, userId },
    select: {
      publicEgressEnabled: true,
      publicEgressAcknowledged: true,
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
                  nativeCapabilities: true,
                  healthStatus: true,
                  enabled: true,
                  deletedAt: true,
                  ProviderAccount: {
                    select: {
                      id: true,
                      userId: true,
                      providerType: true,
                      providerVersion: true,
                      baseUrl: true,
                      authType: true,
                      healthStatus: true,
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
  if (!pool) return { enabled: false, acknowledged: false, targets: [] };
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
      model.healthStatus === "UNAVAILABLE" ||
      account.healthStatus === "UNAVAILABLE"
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

function usageFromObject(value: unknown): RawProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;
  const raw = (root.usage ?? root.message) as Record<string, unknown> | undefined;
  const usage =
    raw?.usage && typeof raw.usage === "object" ? (raw.usage as Record<string, unknown>) : raw;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = usageInteger(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = usageInteger(usage.output_tokens ?? usage.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: usageInteger(usage.cache_read_input_tokens),
    cacheWriteTokens: usageInteger(usage.cache_creation_input_tokens),
    categoriesComplete: false,
    accountingVersion: "provider-billable-v1",
    confidence: "REPORTED",
  };
}

export function parseProviderUsage(chunks: readonly Uint8Array[]) {
  if (chunks.length === 0) return undefined;
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const candidates = [text];
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
  }
  let found: RawProviderUsage | undefined;
  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue;
    try {
      const observed = usageFromObject(JSON.parse(candidate));
      if (observed) {
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
  return found
    ? {
        ...found,
        categoriesComplete: found.inputTokens !== undefined && found.outputTokens !== undefined,
      }
    : undefined;
}

async function recordProviderHealth(
  target: PublicProviderTarget,
  userId: string,
  success: boolean,
): Promise<void> {
  await recordProviderOutcome({
    userId,
    providerAccountId: target.providerAccountId,
    providerModelId: target.providerModelId,
    success,
  }).catch(() => undefined);
}

function selectedNativeSurface(target: PublicProviderTarget, requested: ProtocolSurface) {
  if (target.nativeSurfaces.includes(requested)) return requested;
  return target.nativeSurfaces.find((surface) =>
    target.protocol === "anthropic"
      ? surface === "anthropic-messages"
      : surface === "openai-responses" || surface === "openai-chat",
  );
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
        liability: { ...request.liability, tokens: 0n },
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

  await request.releaseLocalCapacity();
  const keyringValue = env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  if (!keyringValue) return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
  const keyring = parseProviderCredentialKeyring(keyringValue);
  let lastAdmission: ProviderBudgetAdmission | undefined;
  let attemptCount = 0;

  for (const target of compatible) {
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
    const renderedLiability = conservativeProviderLiability({
      estimatedInputTokens: conservativeSerializedInputTokens(upstream.body.byteLength),
      requestedOutputTokens: request.requestedOutputTokens,
    });
    const renderedCompatibility = publicTargetCompatibility(target, {
      ...request,
      liability: renderedLiability,
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
        contextTokens: renderedLiability.tokens,
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
        contextTokens: renderedLiability.tokens,
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
      providerModelId: target.providerModelId,
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
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(14 * 60_000)]),
        },
        {
          egressEnabled: true,
          allowPrivateNetworks: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
          timeoutMs: 60_000,
        },
        upstream.protocol,
        providerAuth(target, secret),
      );
      const status = response.statusCode ?? 502;
      // Retry only before exposing headers/body to the caller.
      if (
        request.retrySafe &&
        (status === 408 || status === 409 || status === 429 || status >= 500)
      ) {
        const closed = response.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              response.once("close", resolve);
              response.once("end", resolve);
            });
        response.destroy();
        await closed;
        await recordProviderOutcome({
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          providerModelId: target.providerModelId,
          success: false,
          failureClass: classifyProviderFailure(status),
          retryAfterMs: parseRetryAfter(response.headers["retry-after"]),
        }).catch(() => undefined);
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
      const heartbeatTimer = setInterval(() => {
        void heartbeatProviderAttempt({ attemptId, fencingToken, extensionMs: 15 * 60_000 })
          .then((alive) => {
            if (!alive) response.destroy(new Error("provider attempt lease expired"));
          })
          .catch(() => response.destroy(new Error("provider attempt heartbeat failed")));
      }, 10_000);
      heartbeatTimer.unref();
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
        clearInterval(heartbeatTimer);
        const ok = streamComplete && httpOk;
        if (!request.signal.aborted) {
          await recordProviderHealth(
            target,
            request.userId,
            streamComplete && ![408, 409, 429].includes(status) && status < 500,
          );
        }
        const usage = streamComplete ? parseProviderUsage(usageChunks) : undefined;
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
              if (usageBytes + chunk.value.byteLength <= 4 * 1024 * 1024) {
                usageChunks.push(chunk.value.slice());
                usageBytes += chunk.value.byteLength;
              }
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
        terminal,
        markFirstClientByte,
        response: new Response(bodyForbidden ? null : heldBody, {
          status,
          headers: responseHeaders(response.headers),
        }),
      };
    } catch {
      await recordProviderOutcome({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        success: false,
        failureClass: "TRANSPORT",
      }).catch(() => undefined);
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
