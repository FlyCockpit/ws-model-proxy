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
  /** Must be called before credential decryption or any network attempt. */
  releaseLocalCapacity: () => Promise<void>;
  adaptationEnabled: boolean;
  /** True only when the operation resolver proves a second attempt is safe. */
  retrySafe: boolean;
  renderForTarget?: (target: PublicProviderTarget) => Promise<{
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
      attemptCount: number;
      terminal: Promise<{ ok: boolean; responseBytes: number }>;
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
  const healthStatus = success ? ("HEALTHY" as const) : ("DEGRADED" as const);
  const healthCheckedAt = new Date();
  await prisma
    .$transaction([
      prisma.providerModel.updateMany({
        where: { id: target.providerModelId, userId },
        data: { healthStatus, healthCheckedAt },
      }),
      prisma.providerAccount.updateMany({
        where: { id: target.providerAccountId, userId },
        data: { healthStatus, healthCheckedAt },
      }),
    ])
    .catch(() => undefined);
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
  const compatible = listed.targets.filter(
    (target) => publicTargetCompatibility(target, request) === "COMPATIBLE",
  );
  if (compatible.length === 0) return { dispatched: false, reason: "NO_COMPATIBLE_PROVIDER" };

  await request.releaseLocalCapacity();
  const keyringValue = env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  if (!keyringValue) return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
  const keyring = parseProviderCredentialKeyring(keyringValue);
  let lastAdmission: ProviderBudgetAdmission | undefined;
  let attemptCount = 0;

  for (const target of compatible) {
    attemptCount += 1;
    const attemptId = crypto.randomUUID();
    const fencingToken =
      BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000));
    const admission = await admitProviderBudget({
      userId: request.userId,
      providerAccountId: target.providerAccountId,
      providerModelId: target.providerModelId,
      credentialId: target.credential.id,
      poolId: request.poolId,
      requestId: request.requestId,
      attemptId,
      fencingToken,
      liability: request.liability,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    lastAdmission = admission;
    if (!admission.admitted) continue;

    let upstream: { protocol: ProviderProtocol; path: string; headers: Headers; body: Uint8Array };
    try {
      upstream = target.nativeSurfaces.includes(request.requestedSurface)
        ? {
            protocol: request.requestedProtocol,
            path: request.path,
            headers: request.headers,
            body: replaceModel(request.body, target.upstreamModelId),
          }
        : await request.renderForTarget!(target);
      const secret = decryptProviderCredential(
        {
          algorithm: target.credential.algorithm as "AES-256-GCM",
          keyVersion: target.credential.keyVersion,
          ciphertext: target.credential.ciphertext,
          nonce: target.credential.nonce,
          authTag: target.credential.authTag,
        },
        {
          credentialId: target.credential.id,
          userId: request.userId,
          providerAccountId: target.providerAccountId,
          credentialType: target.credential.credentialType,
          aadVersion: target.credential.aadVersion,
        },
        keyring,
      );
      const response = await providerHttpsRequest(
        joinProviderUrl(target.baseUrl, upstream.path),
        {
          method: "POST",
          headers: Object.fromEntries(upstream.headers.entries()),
          body: upstream.body,
          // Keep every live stream inside its durable reservation lifetime so
          // provider concurrency and budget liability cannot expire mid-body.
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
        await recordProviderHealth(target, request.userId, false);
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
        continue;
      }
      const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
      const reader = body.getReader();
      let reconciled = false;
      let responseBytes = 0;
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
        const ok = streamComplete && httpOk;
        if (!request.signal.aborted) {
          await recordProviderHealth(target, request.userId, streamComplete && status < 500);
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
      return {
        dispatched: true,
        target,
        attemptId,
        fencingToken,
        attemptCount,
        terminal,
        response: new Response(bodyForbidden ? null : heldBody, {
          status,
          headers: responseHeaders(response.headers),
        }),
      };
    } catch {
      await recordProviderHealth(target, request.userId, false);
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
      if (!request.retrySafe) break;
    }
  }
  return {
    dispatched: false,
    reason: lastAdmission && !lastAdmission.admitted ? "BUDGET_EXCEEDED" : "PROVIDER_UNAVAILABLE",
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

export type { RawProviderUsage };
