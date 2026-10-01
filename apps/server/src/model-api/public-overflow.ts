import { Readable } from "node:stream";
import type { ReadableStreamReadResult } from "node:stream/web";
import {
  type ExternalSendConsentDenial,
  lockExternalSendConsent,
  readExternalConsentDenial,
  recheckExternalSendRequesterValidity,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import {
  type OpenAiCompatibleCapabilities,
  parseOpenAiCompatibleCapabilities,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  decryptProviderCredential,
  parseProviderCredentialKeyring,
} from "@ws-model-proxy/api/lib/provider-credential-crypto";
import {
  type ProviderEgressAuth,
  type ProviderProtocol,
  providerHttpsRequest,
} from "@ws-model-proxy/api/lib/provider-egress";
import {
  providerProtocolForType,
  providerRequestPathname,
} from "@ws-model-proxy/api/lib/provider-protocol";
import {
  resolveExecutionPath,
  surfaceAvailabilityMatrix,
} from "@ws-model-proxy/api/lib/surface-capabilities";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { poolOwnerActive } from "@ws-model-proxy/db/user-deletion-access";
import { env } from "@ws-model-proxy/env/server";
import {
  type AffinityDecision,
  type AffinityPolicy,
  type AffinityTarget,
  buildAffinityTargetIdentity,
  rankAffinityTargets,
  rememberAffinity,
} from "./cache-affinity.js";
import { capacityLeaseLostSignal } from "./capacity/lease-loss.js";
import { estimatePayloadTokens } from "./capacity/payload-estimate.js";
import { type ExternalEgressConsent, isIssuedExternalConsent } from "./external-route.js";
import {
  applyOpenRouterDataCollection,
  mapOpenRouterDataPolicyRefusal,
  type OpenRouterDataCollectionPolicy,
  openRouterDataCollectionPolicy,
} from "./openrouter-privacy.js";
import { ADAPTER_VERSION } from "./protocols/canonical.js";
import { isRequestDepthError, isResponseDepthError } from "./protocols/errors.js";
import type { ProtocolSurface } from "./protocols/index.js";
import { parseProtocolResponse } from "./protocols/nonstream.js";
import { SseDecoder, type SseRecord } from "./protocols/sse.js";
import { CanonicalStreamParser } from "./protocols/streams.js";
import {
  allocateProviderFence,
  claimProviderHealthTrial,
  classifyProviderFailure,
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
import { providerHealthCoolingDown } from "./provider-health-state.js";
import {
  calculatedCostForUsage,
  liabilityFromPricing,
  type ProviderPricingSchedule,
  resolveActiveProviderPricing,
} from "./provider-pricing.js";

/** Bound accounting observation after a client terminal; an incomplete drain keeps liability. */
export const POST_TERMINAL_DRAIN_MAX_BYTES = 256 * 1024;
export const POST_TERMINAL_DRAIN_MAX_MS = 2_000;

export type PublicOverflowReason =
  | "NO_COMPATIBLE_HEALTHY_PRIMARY"
  | "LOCAL_WAIT_EXPIRED"
  /**
   * Saturation S-C: no local member is FREE for this new session; the ones
   * with an idle slot hold protected warm sessions (including the caller's own).
   */
  | "LOCAL_SATURATED_PROTECTED"
  | "LOCAL_CONTEXT_CEILING"
  | "RETRYABLE_PRECOMMIT_PRIMARY_FAILURE";

export type PublicOverflowSkipReason =
  | "DEPLOYMENT_GATE_DISABLED"
  | "CALLER_CONSENT_MISSING"
  /** The caller's token no longer allows `:external` for this pool (revoked,
   * expired, `allowExternal` or `includeExternal` turned off). */
  | "CALLER_CONSENT_WITHDRAWN"
  /** A non-owner requester no longer holds the exact grant the request was resolved under. */
  | "REQUESTER_NOT_VISIBLE"
  /** The requester's account is banned or marked for deletion. */
  | "REQUESTER_ACCESS_BLOCKED"
  /**
   * The pool owner's account is banned (active ban) or marked for deletion:
   * the pool is unavailable to everyone (#76).
   */
  | "POOL_OWNER_INACTIVE"
  /** Durable provider admission did not admit within its wait budget. */
  | "PROVIDER_SATURATED"
  | "OWN_KEY_CONSENT_WITHDRAWN"
  | "POOL_PRIVATE"
  | "GRANTEE_NOT_COVERED"
  | "ADAPTATION_GATE_DISABLED"
  | "NO_COMPATIBLE_PROVIDER"
  | "PROVIDER_UNHEALTHY"
  | "BUDGET_EXCEEDED"
  | "PROTECTION_POLICY_MISSING"
  /**
   * Transient: no provider attempt could be sent right now (fence allocation,
   * transport failure before a response, and similar). Retrying may succeed.
   */
  | "PROVIDER_UNAVAILABLE"
  /**
   * Transient: the send-claim transaction failed before any provider I/O
   * (lock or connection timeout, including the claim's own `lock_timeout`
   * (EXTERNAL_SEND_CLAIM_LOCK_TIMEOUT_MS), credential rotated or revoked
   * meanwhile, decrypt failure). No provider health verdict is recorded for
   * it; the attempt's budget reservation is settled as not sent. Callers
   * answer it as temporarily unavailable (503).
   */
  | "SEND_CLAIM_FAILED"
  /**
   * Permanent: a stored-response binding (`exactResponsesBinding`) no longer
   * matches any configured member (target gone, endpoint identity or version,
   * upstream model, or native Responses support changed). Waiting never
   * makes it servable again.
   */
  | "BOUND_TARGET_INVALID";

/**
 * Skip reasons meaning the `:external` consent itself no longer holds (kill
 * switch, owner flags, token, grant). They are request-wide: no other
 * external member may be tried after one.
 */
export function isExternalConsentDenialReason(reason: PublicOverflowSkipReason): boolean {
  return (
    reason === "DEPLOYMENT_GATE_DISABLED" ||
    reason === "CALLER_CONSENT_MISSING" ||
    reason === "CALLER_CONSENT_WITHDRAWN" ||
    reason === "REQUESTER_NOT_VISIBLE" ||
    reason === "REQUESTER_ACCESS_BLOCKED" ||
    reason === "POOL_OWNER_INACTIVE" ||
    reason === "OWN_KEY_CONSENT_WITHDRAWN" ||
    reason === "POOL_PRIVATE" ||
    reason === "GRANTEE_NOT_COVERED"
  );
}

export interface PublicOverflowRequest {
  userId: string;
  /** Set only for requester-owned DIRECT dispatch; never a pool member. */
  ownKeyProviderModelId?: string;
  admittedExecutionTargetId?: string;
  /** Persist route/target intent after setup and consent, before any transport I/O. */
  beforeProviderSend?: (target: PublicProviderTarget) => Promise<void>;
  /** Requester and credential scopes remain distinct from the pool owner. */
  affinityTenantUserId?: string;
  affinitySecurityScope?: string;
  /** Exact visibility grant; replacement or revocation invalidates affinity. */
  affinityAccessGrantId?: string | null;
  poolId: string;
  requestId: string;
  reason: PublicOverflowReason;
  /**
   * Caller consent minted by evaluateExternalEgress for exactly this pool.
   * Dispatch fails closed without an issued consent, and re-checks the
   * deployment switch, the owner's pool flags, and the caller's token and
   * grant against fresh state.
   */
  externalConsent: ExternalEgressConsent;
  /** The request's requester; must equal the consent's requester. */
  requesterUserId: string;
  /** The request's API token (null for Chat Test); must equal the consent's token. */
  requesterModelApiTokenId: string | null;
  requestedProtocol: ProviderProtocol;
  requestedSurface: ProtocolSurface;
  stream: boolean;
  requiredFeatures: readonly string[];
  path: string;
  headers: Headers;
  /** Original authenticated request headers; kept separate from upstream allowlists. */
  affinityHeaders?: Headers;
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
  /** Cookie-authenticated Chat Test may constrain provider execution mode. */
  chatTestRoutingMode?: "PREFER_NATIVE" | "REQUIRE_NATIVE" | "REQUIRE_ADAPTED";
  /** Cookie-authenticated member probe can constrain dispatch to one pool member. */
  forcedPoolMemberId?: string;
  /** True only when the operation resolver proves a second attempt is safe. */
  retrySafe: boolean;
  /** The caller admitted one target at a time and has another capacity-fenced
   * candidate available. Consume and settle a retryable response, then return
   * uncommitted so the caller can admit the next target. */
  retrySingleTargetPrecommit?: boolean;
  requireNativeSurface?: ProtocolSurface;
  /** Correctness-required Responses binding. It disables ranking, adaptation,
   * and all post-binding failover and validates the immutable endpoint tuple. */
  exactResponsesBinding?: {
    executionTargetId: string;
    providerAccountId: string;
    providerModelId: string;
    endpointIdentity: string;
    endpointVersion: number;
    upstreamModelId: string;
  };
  method?: string;
  skipContextValidation?: boolean;
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
  ownKey?: boolean;
  ownKeyAdaptationEnabled?: boolean;
  poolMemberId: string;
  executionTargetId: string;
  inferenceCapacityId?: string | null;
  capacityWaitBudgetMs?: number | null;
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
  /**
   * OpenRouter privacy preference forced into every body sent to this
   * target (`provider.data_collection`); null for other provider types and
   * for OpenRouter accounts that allow data collection. Required so every
   * target builder decides it explicitly. This is the policy at listing
   * time; the send claim re-reads the locked account and can only tighten it.
   */
  dataCollectionPolicy: OpenRouterDataCollectionPolicy;
  baseUrl: string;
  authType: "API_KEY" | "BEARER";
  healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  nativeProtocols: readonly ProviderProtocol[];
  nativeSurfaces: readonly ProtocolSurface[];
  supportsStreaming: boolean;
  supportedFeatures: readonly string[];
  capabilityInventory?: OpenAiCompatibleCapabilities | null;
  /** Provider usage vocabulary for settlement; absent means the generic parser. */
  usageDialect?: ProviderUsageDialect;
  /** Exact operation-aware resolver result carried through ranking and send. */
  resolvedExecution?: ProviderSurfaceExecution;
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

export type ProviderSurfaceExecution = {
  mode: "native" | "adapted";
  nativeSurface: ProtocolSurface;
  limitations: readonly string[];
};

export function matchesChatTestProviderMode(
  target: Pick<PublicProviderTarget, "nativeSurfaces" | "resolvedExecution">,
  requestedSurface: ProtocolSurface,
  mode: PublicOverflowRequest["chatTestRoutingMode"],
) {
  if (target.resolvedExecution) {
    if (mode === "REQUIRE_NATIVE") return target.resolvedExecution.mode === "native";
    if (mode === "REQUIRE_ADAPTED") return target.resolvedExecution.mode === "adapted";
  }
  if (mode === "REQUIRE_NATIVE") return target.nativeSurfaces.includes(requestedSurface);
  if (mode === "REQUIRE_ADAPTED")
    return target.nativeSurfaces.some(
      (surface) =>
        surface !== requestedSurface &&
        (surface === "anthropic-messages" ||
          surface === "openai-responses" ||
          surface === "openai-chat"),
    );
  return true;
}

export function targetsForForcedPoolMember<T extends Pick<PublicProviderTarget, "poolMemberId">>(
  targets: readonly T[],
  forcedPoolMemberId: string | undefined,
) {
  return forcedPoolMemberId
    ? targets.filter((target) => target.poolMemberId === forcedPoolMemberId)
    : [...targets];
}

export function orderChatTestProviderTargets<
  T extends Pick<PublicProviderTarget, "nativeSurfaces" | "resolvedExecution">,
>(
  targets: readonly T[],
  requestedSurface: ProtocolSurface,
  mode: PublicOverflowRequest["chatTestRoutingMode"],
) {
  if (mode !== "PREFER_NATIVE") return [...targets];
  return [
    ...targets.filter((target) =>
      target.resolvedExecution
        ? target.resolvedExecution.mode === "native"
        : target.nativeSurfaces.includes(requestedSurface),
    ),
    ...targets.filter((target) =>
      target.resolvedExecution
        ? target.resolvedExecution.mode !== "native"
        : !target.nativeSurfaces.includes(requestedSurface),
    ),
  ];
}

export function exactResponsesNativeSurface(
  target: Pick<PublicProviderTarget, "nativeSurfaces" | "capabilityInventory" | "protocol">,
): "openai-responses" | undefined {
  if (target.protocol !== "openai") return undefined;
  if (target.nativeSurfaces.includes("openai-responses")) return "openai-responses";
  return target.capabilityInventory?.version === 4 &&
    target.capabilityInventory.surfaces.openaiResponses !== undefined
    ? "openai-responses"
    : undefined;
}

export function matchesExactResponsesBinding(
  target: Pick<
    PublicProviderTarget,
    | "executionTargetId"
    | "providerAccountId"
    | "providerModelId"
    | "endpointIdentity"
    | "endpointVersion"
    | "upstreamModelId"
    | "nativeSurfaces"
    | "protocol"
    | "capabilityInventory"
  >,
  binding: NonNullable<PublicOverflowRequest["exactResponsesBinding"]>,
): boolean {
  return (
    target.executionTargetId === binding.executionTargetId &&
    target.providerAccountId === binding.providerAccountId &&
    target.providerModelId === binding.providerModelId &&
    target.endpointIdentity === binding.endpointIdentity &&
    target.endpointVersion === binding.endpointVersion &&
    target.upstreamModelId === binding.upstreamModelId &&
    exactResponsesNativeSurface(target) === "openai-responses"
  );
}

type ListedPublicOverflowTargets = {
  /** Owner's fallback switch (`ModelPool.fallbackEnabled`). */
  enabled: boolean;
  /**
   * The pool owner's account is neither banned (active ban) nor marked for
   * deletion (#76). An early, unlocked read: the send claim re-checks it.
   */
  ownerActive: boolean;
  /** Owner pays for grantees' external fallback. */
  fallbackForGrantees: boolean;
  affinityPolicy: AffinityPolicy;
  /** Members that can be sent to now. */
  targets: PublicProviderTarget[];
  /**
   * Members that are configured and enabled but whose provider model or
   * account is in a health cooldown right now. Never dispatched; they only
   * let callers tell "temporarily unavailable" (503) from "no compatible
   * external target" (400).
   */
  coolingDown: PublicProviderTarget[];
  /** Live identities unavailable due to model/account disablement or missing active credentials. */
  unavailable: Array<Parameters<typeof matchesExactResponsesBinding>[0]>;
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
    poolId: input.target.ownKey ? undefined : input.request.poolId,
    poolMemberId: input.target.ownKey ? undefined : input.target.poolMemberId,
    executionTargetId: input.target.executionTargetId,
    memberTier: "PUBLIC_OVERFLOW",
    triggerReason: input.request.reason,
    affinityOutcome: input.target.affinity?.outcome ?? "NONE",
    contextCountMethod: input.request.contextCountMethod,
    contextCountConfidence: input.request.contextCountConfidence,
  };
}

/** The consent identity an `:external` send is re-validated against at the send boundary. */
export type ExternalSendConsentIdentity = {
  requesterUserId: string;
  modelApiTokenId: string | null;
  poolId: string;
  ownerUserId: string;
  /** The exact grant the request or its stored-response binding was resolved under; null for the owner. */
  accessGrantId: string | null;
  ownKeyProviderModelId?: string;
};

type ExternalConsentSkipReason = Extract<
  PublicOverflowSkipReason,
  | "CALLER_CONSENT_WITHDRAWN"
  | "REQUESTER_NOT_VISIBLE"
  | "REQUESTER_ACCESS_BLOCKED"
  | "POOL_OWNER_INACTIVE"
  | "OWN_KEY_CONSENT_WITHDRAWN"
  | "POOL_PRIVATE"
  | "GRANTEE_NOT_COVERED"
>;

function consentSkipReason(denial: ExternalSendConsentDenial): ExternalConsentSkipReason {
  return denial === "TOKEN_CONSENT_WITHDRAWN" ? "CALLER_CONSENT_WITHDRAWN" : denial;
}

export type PublicProviderSendClaim =
  | {
      claimed: true;
      secret: string;
      /**
       * D9 policy of the provider account as read under its send-claim row
       * lock. An opt-out withdrawn after listing is observed here.
       */
      dataCollectionPolicy: OpenRouterDataCollectionPolicy;
    }
  | {
      claimed: false;
      reason:
        | "DEPLOYMENT_GATE_DISABLED"
        | "BOUND_TARGET_INVALID"
        | "PROVIDER_UNAVAILABLE"
        | ExternalConsentSkipReason;
    };

/**
 * Upper bound on each lock wait of the send-claim transaction (L1b, #64):
 * a transaction-local `lock_timeout`. While the claim waits on the hot
 * `provider_account` row (budget admission, settlement and the provider
 * runtime lock it) it holds the pool, grant, token and allowlist rows FOR
 * SHARE, which blocks their writers. The bound keeps that hold short; a
 * timed-out claim throws (SQLSTATE 55P03), nothing is sent, and the
 * dispatcher settles it as `SEND_CLAIM_FAILED` (transient, 503).
 */
export const EXTERNAL_SEND_CLAIM_LOCK_TIMEOUT_MS = 2_000;

/**
 * E0 send boundary, target part (#64 "decide" item, coordinator decision
 * 2026-09-28): re-reads, after the claim's last lock wait, whether the target
 * listed for this attempt is still current.
 *
 *   - provider model: exists, not deleted, enabled, same account, upstream
 *     model and execution target; its account keeps the listed endpoint
 *     identity and version. The model row is held FOR SHARE (C5) and its
 *     account FOR UPDATE, and every provider writer takes the account first.
 *   - pool member (pool fallback only; own-key has none): still in this pool
 *     for the same execution target, PUBLIC_OVERFLOW tier, routing ACTIVE.
 *     Read WITHOUT a lock, like the `user` rows: nothing after this read
 *     waits, and the claim writes no row a member writer reads. A removal or
 *     disable committing after the read cannot affect the claim's decision
 *     (the send was already decided under the earlier state); its commit may
 *     land before or after the claim commits.
 *
 * Returns null when the target is current. A member, model or endpoint that
 * no longer matches is `BOUND_TARGET_INVALID` for a stored-response binding
 * or own-key (never servable again as bound), otherwise
 * `PROVIDER_UNAVAILABLE`; a disabled model or account is
 * `PROVIDER_UNAVAILABLE`. These are availability results, not consent
 * denials: the dispatcher tries the next member only when retry-safe.
 */
async function recheckExternalSendTarget(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    target: PublicProviderTarget;
    consent: ExternalSendConsentIdentity;
    exactBinding?: boolean;
  },
): Promise<"BOUND_TARGET_INVALID" | "PROVIDER_UNAVAILABLE" | null> {
  const ownKey = Boolean(input.consent.ownKeyProviderModelId);
  const gone = input.exactBinding || ownKey ? "BOUND_TARGET_INVALID" : "PROVIDER_UNAVAILABLE";
  const [model, member] = await Promise.all([
    tx.providerModel.findFirst({
      where: {
        id: input.target.providerModelId,
        userId: input.userId,
        deletedAt: null,
        providerAccountId: input.target.providerAccountId,
        upstreamModelId: input.target.upstreamModelId,
        ExecutionTarget: { id: input.target.executionTargetId },
        ProviderAccount: {
          userId: input.userId,
          deletedAt: null,
          endpointIdentity: input.target.endpointIdentity,
          endpointVersion: input.target.endpointVersion,
        },
      },
      select: { enabled: true, ProviderAccount: { select: { enabled: true } } },
    }),
    ownKey
      ? Promise.resolve({ id: "" })
      : tx.poolMember.findFirst({
          where: {
            id: input.target.poolMemberId,
            poolId: input.consent.poolId,
            executionTargetId: input.target.executionTargetId,
            tier: "PUBLIC_OVERFLOW",
            routingStatus: "ACTIVE",
          },
          select: { id: true },
        }),
  ]);
  if (!model || !member) return gone;
  if (!model.enabled || !model.ProviderAccount.enabled) return "PROVIDER_UNAVAILABLE";
  return null;
}

/**
 * The E0 send boundary: the last step before provider I/O. In one
 * transaction it (1) re-validates every `:external` consent condition while
 * holding the consent rows FOR SHARE (lockExternalSendConsent), (2) takes the
 * provider account and credential locks, the last statements that can wait,
 * and re-reads the account's D9 data-collection policy under the account lock
 * (returned so the dispatcher can tighten the rendered body), (3) re-evaluates
 * the time- and account-dependent validity of the requester (token expiry,
 * ban, deletion mark), and the pool owner's (ban, deletion mark, #76), at a
 * fresh `now` (recheckExternalSendRequesterValidity) and that the listed
 * target is still current (recheckExternalSendTarget), then (4) atomically claims the
 * current credential. `lastUsedAt` is the durable boundary: credential
 * lifecycle changes serialize on the account/credential rows, consent
 * withdrawals on the consent rows, and the actual provider request happens
 * after commit. A withdrawal that commits before this transaction reaches
 * the corresponding check is observed here; one that commits after it cannot
 * cancel a send that has already been claimed.
 *
 * A throw from this function (lock or connection timeout, including the
 * transaction-local EXTERNAL_SEND_CLAIM_LOCK_TIMEOUT_MS, credential no longer
 * current, decrypt failure) means nothing was sent; the dispatcher settles it
 * without a provider health verdict.
 *
 * Lock order: model_pool -> pool_grant -> model_api_token ->
 * model_api_token_allowlist_entry (FOR SHARE), then provider_account FOR
 * UPDATE -> provider_model FOR SHARE -> provider_credential FOR UPDATE (and,
 * own-key, pool_fallback_preference FOR SHARE). See
 * packages/db/src/capacity-lock-order.ts.
 */
export async function claimPublicProviderCredentialForSend(input: {
  userId: string;
  target: PublicProviderTarget;
  keyring: ReturnType<typeof parseProviderCredentialKeyring>;
  consent: ExternalSendConsentIdentity;
  /** The attempt serves a stored-response binding (exactResponsesBinding). */
  exactBinding?: boolean;
}): Promise<PublicProviderSendClaim> {
  if (!env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED)
    return { claimed: false, reason: "DEPLOYMENT_GATE_DISABLED" };
  if (
    input.consent.ownKeyProviderModelId &&
    input.target.providerModelId !== input.consent.ownKeyProviderModelId
  )
    return { claimed: false, reason: "OWN_KEY_CONSENT_WITHDRAWN" };
  return prisma.$transaction(
    async (tx): Promise<PublicProviderSendClaim> => {
      // First statement: bound every lock wait below (L1b). Not a lock.
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${EXTERNAL_SEND_CLAIM_LOCK_TIMEOUT_MS}ms`}, true)`;
      const denial = await lockExternalSendConsent(tx, input.consent);
      if (denial) return { claimed: false, reason: consentSkipReason(denial) };
      await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.target.providerAccountId} AND "userId" = ${input.userId} FOR UPDATE`;
      // D9: the privacy switch commits under this same account row lock
      // (providerManagement.setAllowDataCollection), so this read sees every
      // withdrawal that committed before the claim. Not a lock.
      const privacyAccount = await tx.providerAccount.findFirst({
        where: { id: input.target.providerAccountId, userId: input.userId, deletedAt: null },
        select: { providerType: true, allowDataCollection: true },
      });
      // C5: the provider model FOR SHARE on every path (pool fallback and
      // own-key), so its enabled state and identity re-read below are frozen
      // until the claim commits.
      await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${input.target.providerModelId} AND "userId" = ${input.userId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM provider_credential WHERE id = ${input.target.credential.id} AND "userId" = ${input.userId} FOR UPDATE`;
      if (input.consent.ownKeyProviderModelId) {
        await tx.$queryRaw`SELECT id FROM pool_fallback_preference WHERE "poolId" = ${input.consent.poolId} AND "userId" = ${input.userId} FOR SHARE`;
        const preference = await tx.poolFallbackPreference.findFirst({
          where: {
            poolId: input.consent.poolId,
            userId: input.userId,
            poolGrantId: input.consent.accessGrantId ?? "",
            providerModelId: input.consent.ownKeyProviderModelId,
          },
          select: { id: true },
        });
        if (!preference) return { claimed: false, reason: "OWN_KEY_CONSENT_WITHDRAWN" };
      }
      // Nothing below waits on a lock: re-evaluate what time or an unlocked
      // row (the requester's and the pool owner's accounts) can have changed
      // while we waited.
      const lapsed = await recheckExternalSendRequesterValidity(tx, input.consent);
      if (lapsed) return { claimed: false, reason: consentSkipReason(lapsed) };
      // Target availability, after consent (a consent denial wins): the
      // listed member, provider model and endpoint must still be the ones
      // this attempt was admitted and rendered for.
      const changed = await recheckExternalSendTarget(tx, input);
      if (changed) return { claimed: false, reason: changed };
      // A deleted account is classified by the target re-check above
      // (C6-3); a missing policy row past it is an invariant break.
      if (!privacyAccount) throw new Error("provider account is no longer available");
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
      return {
        claimed: true,
        secret,
        dataCollectionPolicy: openRouterDataCollectionPolicy(privacyAccount),
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

export function resolvePublicProviderExecution(
  target: Pick<PublicProviderTarget, "capabilityInventory" | "ownKey" | "ownKeyAdaptationEnabled">,
  request: Pick<
    PublicOverflowRequest,
    "requestedSurface" | "stream" | "requiredFeatures" | "adaptationEnabled"
  > &
    Partial<Pick<PublicOverflowRequest, "path" | "headers" | "method" | "exactResponsesBinding">>,
): ProviderSurfaceExecution | undefined {
  if (!target.capabilityInventory) return undefined;
  const requestedSurface = {
    "openai-chat": "OPENAI_CHAT_COMPLETIONS",
    "openai-responses": "OPENAI_RESPONSES",
    "anthropic-messages": "ANTHROPIC_MESSAGES",
  }[request.requestedSurface] as
    | "OPENAI_CHAT_COMPLETIONS"
    | "OPENAI_RESPONSES"
    | "ANTHROPIC_MESSAGES";
  const responsePath = new URL(request.path ?? "/v1/messages", "http://wsmp.invalid").pathname;
  const responsesOperation = responsePath.endsWith("/input_items")
    ? "listInputItems"
    : responsePath.endsWith("/cancel")
      ? "cancel"
      : responsePath.endsWith("/compact")
        ? "compact"
        : responsePath.endsWith("/count_tokens")
          ? "countTokens"
          : /^\/v1\/responses\/[^/]+$/u.test(responsePath)
            ? request.method === "DELETE"
              ? "delete"
              : "retrieve"
            : "create";
  const betaFeatures = (request.headers?.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
  const resolved = resolveExecutionPath({
    capabilities: target.capabilityInventory,
    requestedSurface,
    request: {
      stream: request.stream,
      ...Object.fromEntries(request.requiredFeatures.map((feature) => [feature, true])),
      responsesOperation,
      countTokens:
        request.requestedSurface === "anthropic-messages" && responsePath.endsWith("/count_tokens"),
      protocolVersion: request.headers?.get("anthropic-version") ?? undefined,
      betaFeatures,
    },
    adaptationEnabled: request.exactResponsesBinding
      ? false
      : target.ownKey
        ? target.ownKeyAdaptationEnabled === true
        : request.adaptationEnabled,
  });
  if (resolved.mode === "unavailable" || !resolved.nativeSurface) return undefined;
  const nativeSurface =
    resolved.nativeSurface === "OPENAI_CHAT_COMPLETIONS"
      ? "openai-chat"
      : resolved.nativeSurface === "OPENAI_RESPONSES"
        ? "openai-responses"
        : resolved.nativeSurface === "ANTHROPIC_MESSAGES"
          ? "anthropic-messages"
          : undefined;
  return nativeSurface
    ? { mode: resolved.mode, nativeSurface, limitations: resolved.limitations }
    : undefined;
}

export function publicTargetCompatibility(
  target: Pick<
    PublicProviderTarget,
    | "ownKey"
    | "ownKeyAdaptationEnabled"
    | "contextWindow"
    | "maxOutputTokens"
    | "nativeProtocols"
    | "nativeSurfaces"
    | "supportsStreaming"
    | "supportedFeatures"
    | "protocol"
    | "capabilityInventory"
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
    | "skipContextValidation"
  > &
    Partial<Pick<PublicOverflowRequest, "path" | "headers" | "method" | "exactResponsesBinding">>,
): "COMPATIBLE" | "CONTEXT_UNKNOWN" | "CONTEXT_EXCEEDED" | "PROTOCOL_UNAVAILABLE" {
  if (!inventoryMatchesProtocol(target.capabilityInventory, target.protocol))
    return "PROTOCOL_UNAVAILABLE";
  const requestedOutputTokens =
    request.requestedOutputTokens ??
    (target.maxOutputTokens === null ? undefined : BigInt(target.maxOutputTokens));
  const contextTokens =
    request.estimatedInputTokens !== undefined && requestedOutputTokens !== undefined
      ? checkedContextTokens(request.estimatedInputTokens, requestedOutputTokens)
      : (request.contextTokens ?? request.liability.tokens);
  if (!request.skipContextValidation) {
    if (target.contextWindow === null || contextTokens === undefined) return "CONTEXT_UNKNOWN";
    if (!Number.isSafeInteger(target.contextWindow) || target.contextWindow <= 0)
      return "CONTEXT_UNKNOWN";
    if (contextTokens > BigInt(target.contextWindow)) return "CONTEXT_EXCEEDED";
    if (target.maxOutputTokens === null || requestedOutputTokens === undefined)
      return "CONTEXT_UNKNOWN";
    if (requestedOutputTokens > BigInt(target.maxOutputTokens)) return "CONTEXT_EXCEEDED";
  }
  if (!target.capabilityInventory && request.stream && !target.supportsStreaming)
    return "PROTOCOL_UNAVAILABLE";
  if (
    !target.capabilityInventory &&
    request.requiredFeatures.some((feature) => !target.supportedFeatures.includes(feature))
  )
    return "PROTOCOL_UNAVAILABLE";
  if (target.capabilityInventory) {
    return resolvePublicProviderExecution(target, request) ? "COMPATIBLE" : "PROTOCOL_UNAVAILABLE";
  }
  if (target.nativeSurfaces.includes(request.requestedSurface)) return "COMPATIBLE";
  return !request.exactResponsesBinding &&
    (target.ownKey ? target.ownKeyAdaptationEnabled : request.adaptationEnabled) &&
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

export type PublicOverflowTerminal = {
  ok: boolean;
  responseBytes: number;
  usage?: RawProviderUsage;
};

export type PublicOverflowResult =
  | {
      dispatched: true;
      response: Response;
      target: PublicProviderTarget;
      attemptId: string;
      fencingToken: bigint;
      nativeSurface: ProtocolSurface;
      attemptCount: number;
      /**
       * Settles once the provider response is reconciled. `usage` is the same
       * parsed provider usage that settled billing (absent when the provider
       * reported none or the attempt failed before reconciliation).
       */
      terminal: Promise<PublicOverflowTerminal>;
      /** Record commitment only when the final rendered response emits a byte. */
      markFirstClientByte: () => Promise<void>;
      affinity: PublicProviderTarget["affinity"];
      /**
       * D9: `response` is WMP's mapped 503 for OpenRouter's data-policy 404.
       * The route layer renders its own surface-shaped error for it instead
       * of sanitizing it like an untrusted provider body. In-process only.
       */
      dataPolicyRefusal?: true;
    }
  | {
      dispatched: false;
      reason: PublicOverflowSkipReason;
      detail?: string;
      /** True if any transport invocation may have reached the provider. */
      providerIoStarted?: true;
      /** Retain the last rejected provider response when no later tier can serve. */
      providerFailure?: { target: PublicProviderTarget; status?: number; retryAfter?: string };
    };

function targetProtocol(providerType: string): ProviderProtocol | null {
  return providerProtocolForType(providerType);
}

function inventoryMatchesProtocol(
  inventory: OpenAiCompatibleCapabilities | null | undefined,
  protocol: ProviderProtocol,
) {
  if (!inventory) return true;
  return (
    inventory.protocol === (protocol === "anthropic" ? "anthropic-compatible" : "openai-compatible")
  );
}

function nativeProtocols(value: unknown): ProviderProtocol[] {
  const inventory = parseOpenAiCompatibleCapabilities(value);
  if (inventory) return [inventory.protocol === "anthropic-compatible" ? "anthropic" : "openai"];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const values = Array.isArray(record.protocols) ? record.protocols : [];
  const parsed = values.filter(
    (item): item is ProviderProtocol => item === "openai" || item === "anthropic",
  );
  return parsed;
}

function nativeSurfaces(value: unknown): ProtocolSurface[] {
  const inventory = parseOpenAiCompatibleCapabilities(value);
  if (inventory) {
    const matrix = surfaceAvailabilityMatrix({ capabilities: inventory });
    return [
      ...(matrix.OPENAI_CHAT_COMPLETIONS.mode === "native" ? (["openai-chat"] as const) : []),
      ...(matrix.OPENAI_RESPONSES.mode === "native" ? (["openai-responses"] as const) : []),
      ...(matrix.ANTHROPIC_MESSAGES.mode === "native" ? (["anthropic-messages"] as const) : []),
    ];
  }
  if (!value || typeof value !== "object") return [];
  const values = (value as Record<string, unknown>).surfaces;
  if (!Array.isArray(values)) return [];
  return values.filter(
    (item): item is ProtocolSurface =>
      item === "openai-chat" || item === "openai-responses" || item === "anthropic-messages",
  );
}

function supportsStreaming(value: unknown): boolean {
  const inventory = parseOpenAiCompatibleCapabilities(value);
  if (inventory)
    return Object.values(surfaceAvailabilityMatrix({ capabilities: inventory })).some(
      (surface) => surface.mode === "native" && surface.streaming,
    );
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

/**
 * External fallback (PUBLIC_OVERFLOW) provider targets of an owned pool.
 * PRIMARY members are always local, so provider targets exist only here.
 */
const providerTargetModelSelect = {
  id: true,
  userId: true,
  upstreamModelId: true,
  contextWindow: true,
  maxOutputTokens: true,
  concurrencyLimit: true,
  nativeCapabilities: true,
  healthStatus: true,
  healthNextRetryAt: true,
  healthHalfOpenAt: true,
  enabled: true,
  deletedAt: true,
  ProviderAccount: {
    select: {
      id: true,
      userId: true,
      providerType: true,
      providerVersion: true,
      allowDataCollection: true,
      baseUrl: true,
      endpointIdentity: true,
      endpointVersion: true,
      authType: true,
      healthStatus: true,
      healthNextRetryAt: true,
      healthHalfOpenAt: true,
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
} satisfies Prisma.ProviderModelSelect;

export async function listPublicOverflowTargets(
  userId: string,
  poolId: string,
  ownKey?: { requesterUserId: string; providerModelId: string; accessGrantId: string | null },
): Promise<ListedPublicOverflowTargets> {
  const pool = await prisma.modelPool.findFirst({
    where: { id: poolId, userId },
    select: {
      fallbackEnabled: true,
      fallbackForGrantees: true,
      externalEquivalentModel: true,
      affinityEnabled: true,
      affinityTtlSeconds: true,
      affinityMaxRecords: true,
      affinityPrefixWeight: true,
      affinityConversationWeight: true,
      affinityConfirmedCacheWeight: true,
      affinityLoadPenaltyWeight: true,
      affinityResidencyWeight: true,
      capacityWaitBudgetMs: true,
      User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
      PoolMembers: {
        where: {
          tier: "PUBLIC_OVERFLOW",
          routingStatus: "ACTIVE",
          ExecutionTarget: { ProviderModel: { isNot: null } },
        },
        orderBy: [{ publicOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          publicOrder: true,
          capacityWaitBudgetMs: true,
          capacityWaitBudgetMode: true,
          ExecutionTarget: {
            select: {
              id: true,
              inferenceCapacityId: true,
              ProviderModel: {
                select: providerTargetModelSelect,
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
    residencyWeight: 100,
  };
  if (!pool)
    return {
      enabled: false,
      ownerActive: false,
      fallbackForGrantees: false,
      affinityPolicy: defaultAffinityPolicy,
      targets: [],
      coolingDown: [],
      unavailable: [],
    };
  let ownKeyAdaptationEnabled = false;
  if (ownKey) {
    const preference =
      pool.externalEquivalentModel && ownKey.accessGrantId && ownKey.requesterUserId !== userId
        ? await prisma.poolFallbackPreference.findFirst({
            where: {
              poolId,
              userId: ownKey.requesterUserId,
              poolGrantId: ownKey.accessGrantId,
              providerModelId: ownKey.providerModelId,
              PoolGrant: { ownerUserId: userId, granteeUserId: ownKey.requesterUserId, poolId },
            },
            select: {
              protocolAdaptationEnabled: true,
              ProviderModel: {
                select: {
                  ...providerTargetModelSelect,
                  ExecutionTarget: { select: { id: true, inferenceCapacityId: true } },
                },
              },
            },
          })
        : null;
    ownKeyAdaptationEnabled = preference?.protocolAdaptationEnabled === true;
    const model = preference?.ProviderModel;
    pool.PoolMembers = model?.ExecutionTarget
      ? [
          {
            id: "",
            publicOrder: 0,
            capacityWaitBudgetMs: null,
            capacityWaitBudgetMode: "INHERIT",
            ExecutionTarget: { ...model.ExecutionTarget, ProviderModel: model },
          },
        ]
      : [];
    pool.fallbackEnabled = Boolean(pool.externalEquivalentModel && preference);
    pool.fallbackForGrantees = true;
    pool.affinityEnabled = false;
  }
  const providerOwnerId = ownKey?.requesterUserId ?? userId;
  const now = new Date();
  const unavailable: ListedPublicOverflowTargets["unavailable"] = [];
  const listed = pool.PoolMembers.flatMap((member) => {
    const model = member.ExecutionTarget?.ProviderModel;
    const account = model?.ProviderAccount;
    const credential = account?.CurrentCredential;
    const protocol = account ? targetProtocol(account.providerType) : null;
    const capabilityInventory = parseOpenAiCompatibleCapabilities(model?.nativeCapabilities);
    if (
      !model ||
      !account ||
      !protocol ||
      !inventoryMatchesProtocol(capabilityInventory, protocol) ||
      member.publicOrder == null ||
      model.userId !== providerOwnerId ||
      account.userId !== providerOwnerId ||
      model.deletedAt ||
      account.deletedAt
    )
      return [];
    // Preserve the immutable live identity BEFORE applying readiness filters.
    // A credential can be restored and enablement can be toggled without
    // changing the binding; neither makes a stored response permanently gone.
    const identity = {
      executionTargetId: member.ExecutionTarget!.id,
      providerModelId: model.id,
      upstreamModelId: model.upstreamModelId,
      protocol,
      providerAccountId: account.id,
      endpointIdentity: account.endpointIdentity,
      endpointVersion: account.endpointVersion,
      nativeSurfaces: nativeSurfaces(model.nativeCapabilities),
      capabilityInventory,
    };
    if (!model.enabled || !account.enabled || !credential || credential.status !== "ACTIVE") {
      unavailable.push(identity);
      return [];
    }
    // The same rule claimProviderHealthTrial applies under its locks: a
    // pending backoff or a live half-open trial on the account or the model.
    const coolingDown =
      providerHealthCoolingDown(model, now) || providerHealthCoolingDown(account, now);
    return [
      {
        coolingDown,
        target: {
          ...identity,
          ownKey: Boolean(ownKey),
          ownKeyAdaptationEnabled,
          poolMemberId: member.id,
          inferenceCapacityId: member.ExecutionTarget!.inferenceCapacityId,
          capacityWaitBudgetMs:
            member.capacityWaitBudgetMode === "UNLIMITED"
              ? null
              : member.capacityWaitBudgetMode === "LIMITED"
                ? member.capacityWaitBudgetMs
                : pool.capacityWaitBudgetMs,
          publicOrder: member.publicOrder ?? 0,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          concurrencyLimit: model.concurrencyLimit,
          providerVersion: account.providerVersion,
          dataCollectionPolicy: openRouterDataCollectionPolicy(account),
          baseUrl: account.baseUrl,
          authType: account.authType,
          healthStatus: model.healthStatus,
          nativeProtocols: nativeProtocols(model.nativeCapabilities),
          usageDialect: providerUsageDialect(account.providerType),
          supportsStreaming: supportsStreaming(model.nativeCapabilities),
          supportedFeatures: supportedFeatures(model.nativeCapabilities),
          credential,
        } satisfies PublicProviderTarget,
      },
    ];
  });
  return {
    enabled: pool.fallbackEnabled,
    // Fail closed on a partial row: the owner relation is required.
    ownerActive: pool.User ? poolOwnerActive(pool.User, now) : false,
    fallbackForGrantees: pool.fallbackForGrantees,
    affinityPolicy: {
      enabled: pool.affinityEnabled,
      ttlSeconds: pool.affinityTtlSeconds,
      maxRecords: pool.affinityMaxRecords,
      prefixWeight: pool.affinityPrefixWeight,
      conversationWeight: pool.affinityConversationWeight,
      confirmedCacheWeight: pool.affinityConfirmedCacheWeight,
      loadPenaltyWeight: pool.affinityLoadPenaltyWeight,
      residencyWeight: pool.affinityResidencyWeight,
    },
    targets: listed.flatMap((item) => (item.coolingDown ? [] : [item.target])),
    coolingDown: listed.flatMap((item) => (item.coolingDown ? [item.target] : [])),
    unavailable,
  };
}

/**
 * Request path on the provider for `path` (e.g. `/v1/chat/completions`). A
 * base URL stored with a trailing `/v1` (as providers document it) does not
 * produce `/v1/v1/...`; see `providerRequestPathname`.
 */
export function joinProviderPath(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const requested = new URL(path, "http://provider-path.invalid");
  return `${providerRequestPathname(base.pathname, requested.pathname)}${requested.search}`;
}

const SAFE_CONTENT_ENCODINGS = new Set(["br", "deflate", "gzip", "identity", "zstd"]);

function validatedContentEncoding(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const joined = Array.isArray(value) ? value.join(",") : value;
  const encodings = joined
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  if (
    encodings.length === 0 ||
    encodings.length > 4 ||
    encodings.some((encoding) => !SAFE_CONTENT_ENCODINGS.has(encoding))
  )
    return null;
  return encodings.join(", ");
}

function isOpaqueJsonOrSseContentType(value: string | string[] | undefined): boolean {
  if (value === undefined || Array.isArray(value)) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    mediaType === "text/event-stream" ||
    (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"))
  );
}

export function providerResponseHeaders(
  headers: import("node:http").IncomingHttpHeaders,
  preserveOpaqueRepresentation: boolean,
): Headers {
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
  // node:http exposes the provider's wire bytes without transparent
  // decompression. Preserve a validated encoding only when those exact bytes
  // are passed through natively. Adapted responses are decoded and rendered,
  // so their representation validators and encoding must be stripped.
  if (preserveOpaqueRepresentation && isOpaqueJsonOrSseContentType(headers["content-type"])) {
    const encoding = validatedContentEncoding(headers["content-encoding"]);
    if (encoding) result.set("content-encoding", encoding);
  }
  return result;
}

function providerAuth(target: PublicProviderTarget, secret: string): ProviderEgressAuth {
  if (target.authType !== target.credential.credentialType) throw new Error("credential mismatch");
  return target.authType === "API_KEY"
    ? { type: "API_KEY", apiKey: secret }
    : { type: "BEARER", token: secret };
}

/**
 * D9: OpenRouter's "no endpoints match your data policy" 404 becomes a clear
 * 503 only for requests that were sent with `data_collection: "deny"`.
 */
async function mapDataPolicyRefusal(
  sentPolicy: OpenRouterDataCollectionPolicy,
  response: Response,
): Promise<{ response: Response; dataPolicyRefusal?: true }> {
  if (sentPolicy !== "deny") return { response };
  const mapped = await mapOpenRouterDataPolicyRefusal(response);
  return mapped.refused
    ? { response: mapped.response, dataPolicyRefusal: true }
    : { response: mapped.response };
}

function replaceModel(body: Uint8Array, model: string): Uint8Array {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  parsed.model = model;
  return new TextEncoder().encode(JSON.stringify(parsed));
}

/**
 * Durable facts for a provider attempt whose dispatch signal aborted. The
 * signal is the capacity lease's: a lost lease is a server-side failure
 * (F2-CAP-3), recorded as such and never as a client cancellation. Neither
 * counts against provider health (callers skip health on any abort).
 */
function abortedAttemptFacts(signal: AbortSignal) {
  return capacityLeaseLostSignal(signal)
    ? ({ reason: "CAPACITY_LEASE_LOST", terminalState: "FAILED", budgetReason: "FAILED" } as const)
    : ({ reason: "CANCELLED", terminalState: "CANCELLED", budgetReason: "CANCELLED" } as const);
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

/**
 * Provider-specific usage vocabulary. `generic` is the shared parser every
 * provider type uses; a dialect only widens the accepted vocabulary for the
 * provider type that documents it, so other providers keep failing closed on
 * the same keys (#62; a generic relaxation changed billing for all providers).
 */
export type ProviderUsageDialect = "generic" | "openrouter";

export function providerUsageDialect(
  providerType: string | null | undefined,
): ProviderUsageDialect {
  return providerType?.trim().toLowerCase() === "openrouter" ? "openrouter" : "generic";
}

/** OpenRouter `usage.cost_details` keys (credits/USD metadata, never tokens). */
const OPENROUTER_COST_DETAIL_KEYS = new Set([
  "upstream_inference_cost",
  "upstream_inference_prompt_cost",
  "upstream_inference_completions_cost",
  // Responses API spelling (live capture, 2026-09-29).
  "upstream_inference_input_cost",
  "upstream_inference_output_cost",
  "server_tool_cost",
]);
/**
 * Usage spellings the generic parser merges with `??`. In the OpenRouter
 * dialect two present spellings are ambiguous: only the first would be read.
 */
const OPENROUTER_ALIAS_PAIRS = [
  ["prompt_tokens_details", "input_tokens_details"],
  ["completion_tokens_details", "output_tokens_details"],
  ["input_tokens", "prompt_tokens"],
  ["output_tokens", "completion_tokens"],
  ["cost", "total_cost"],
] as const;
const OPENROUTER_DETAIL_CONTAINERS = [
  "prompt_tokens_details",
  "input_tokens_details",
  "completion_tokens_details",
  "output_tokens_details",
] as const;
/** OpenRouter `usage.server_tool_use` counters: non-token charges outside token budgets. */
const OPENROUTER_SERVER_TOOL_KEYS = new Set(["web_search_requests"]);

function openRouterMetadataValid(usage: Record<string, unknown>): boolean {
  // Every capture carries a boolean. `is_byok` decides whether the upstream
  // provider cost is added to `cost`, so a missing, null or non-boolean value
  // is invalid usage, not "not BYOK".
  if (typeof usage.is_byok !== "boolean") return false;
  if (Object.hasOwn(usage, "cost_details") && usage.cost_details !== null) {
    const details = usageRecord(usage.cost_details);
    if (
      !details ||
      Object.entries(details).some(
        ([key, item]) =>
          !OPENROUTER_COST_DETAIL_KEYS.has(key) ||
          (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0)),
      )
    )
      return false;
  }
  if (Object.hasOwn(usage, "server_tool_use") && usage.server_tool_use !== null) {
    const counters = usageRecord(usage.server_tool_use);
    if (
      !counters ||
      Object.entries(counters).some(
        ([key, item]) => !OPENROUTER_SERVER_TOOL_KEYS.has(key) || usageInteger(item) === undefined,
      )
    )
      return false;
  }
  return true;
}

export function usageFromObject(
  value: unknown,
  dialect: ProviderUsageDialect = "generic",
): RawProviderUsage | undefined {
  const openRouter = dialect === "openrouter";
  if (!value || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;
  // OpenRouter (Chat only) reports usage in a root `usage` object. Only one
  // container is read: another root container, or a `usage` nested inside the
  // top-level one, would hide the other counts and charge. The dialect keeps
  // any such record as evidence only.
  if (
    openRouter &&
    (usageRecord(root.usage) === undefined ||
      [root.usage, root.response, root.message].filter((item) => item != null).length > 1 ||
      usageRecord(root.usage)?.usage != null)
  ) {
    const observed = usageFromObject(value, "generic");
    return observed && unattributableUsage(observed);
  }
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
  // OpenRouter reports cache writes inside `prompt_tokens` (its documented
  // `total_tokens` is the sum of prompt and completion tokens), exactly like
  // `cached_tokens`, so they are subtracted from input below.
  const openRouterCacheWriteTokens = openRouter
    ? usageInteger(promptDetails?.cache_write_tokens)
    : undefined;
  const cacheWriteTokens = openRouter
    ? (openRouterCacheWriteTokens ?? usageInteger(usage.cache_creation_input_tokens))
    : usageInteger(usage.cache_creation_input_tokens);
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
  const promptSubsets = [cacheReadTokens, inputAudioTokens, openRouterCacheWriteTokens];
  const inputTokens = openAiShape ? exclusiveMany(promptTotal, promptSubsets) : promptTotal;
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
  const reportedCost = usageCost(usage.cost ?? usage.total_cost);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    authoritativeBillableTokens === undefined &&
    reasoningTokens === undefined &&
    usageInteger(usage.tool_tokens) === undefined &&
    additionalBillableTokens === undefined &&
    reportedCost === undefined
  )
    return undefined;
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
  if (openRouter)
    for (const key of ["is_byok", "cost_details", "server_tool_use"]) knownUsageKeys.add(key);
  const knownPromptDetailKeys = new Set(["cached_tokens", "audio_tokens"]);
  const knownCompletionDetailKeys = new Set([
    "reasoning_tokens",
    "audio_tokens",
    "accepted_prediction_tokens",
    "rejected_prediction_tokens",
  ]);
  // OpenRouter always emits `video_tokens` / `image_tokens` breakdowns. They
  // have no priced category here, so only an explicit zero is accepted; a
  // positive count keeps the observation incomplete (fail closed).
  // `cache_write_tokens` is a subset of `prompt_tokens` (verified by a live
  // Chat capture, 2026-09-29: prompt 7671 = 9 uncached + 7662 cache writes;
  // inferred for Responses `input_tokens`, whose captures had no cache
  // activity) and is settled as cache-write tokens.
  const openRouterZeroOnlyDetails = [
    [promptDetails, "video_tokens"],
    [completionDetails, "image_tokens"],
  ] as const;
  if (openRouter) {
    knownPromptDetailKeys.add("cache_write_tokens");
    knownPromptDetailKeys.add("video_tokens");
    knownCompletionDetailKeys.add("image_tokens");
  }
  const hasOpenRouterUnknown =
    openRouter &&
    (!openRouterMetadataValid(usage) ||
      // The generic parser reads only the first of two alias spellings and
      // ignores a non-object detail container. Both would let a second
      // representation hide counts or unknown keys, so the dialect rejects them.
      OPENROUTER_ALIAS_PAIRS.some(
        ([first, second]) => usage[first] != null && usage[second] != null,
      ) ||
      OPENROUTER_DETAIL_CONTAINERS.some(
        (key) => usage[key] != null && usageRecord(usage[key]) === undefined,
      ) ||
      (usage.cache_read_input_tokens != null && promptDetails?.cached_tokens != null) ||
      // Two cache-write spellings in one observation are ambiguous.
      (promptDetails !== undefined &&
        Object.hasOwn(promptDetails, "cache_write_tokens") &&
        Object.hasOwn(usage, "cache_creation_input_tokens")) ||
      (promptDetails !== undefined &&
        Object.hasOwn(promptDetails, "cache_write_tokens") &&
        openRouterCacheWriteTokens === undefined) ||
      openRouterZeroOnlyDetails.some(
        ([details, key]) =>
          details !== undefined && Object.hasOwn(details, key) && details[key] !== 0,
      ));
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
    (promptTotal !== undefined && exclusiveMany(promptTotal, promptSubsets) === undefined) ||
    (completionTotal !== undefined &&
      exclusiveMany(completionTotal, [
        reasoningTokens,
        outputAudioTokens,
        acceptedPredictionTokens,
        rejectedPredictionTokens,
      ]) === undefined);
  const hasUnknownCategories =
    hasOpenRouterUnknown ||
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
  dialect: ProviderUsageDialect = "generic",
  surface: ProtocolSurface = "openai-chat",
) {
  if (chunks.length === 0) return undefined;
  if (dialect === "openrouter") return openRouterRecords(chunks, surface).settle(pricing);
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
      const observed = usageFromObject(JSON.parse(candidate), dialect);
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
      found.outputTokens !== undefined
        ? categoriesComplete
        : found.categoriesComplete,
  };
  return withCalculatedCost(normalized, pricing);
}

function withCalculatedCost(
  normalized: RawProviderUsage,
  pricing: ProviderPricingSchedule | undefined,
): RawProviderUsage {
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

/**
 * Derives the latest engine cache-affinity evidence from a normalized usage
 * observation. Cached prompt tokens > 0 confirm a warm engine prefix;
 * cache fields reported with zero reset a prior confirmation; a provider that
 * does not report cache usage yields `undefined` so callers can leave the
 * stored affinity flag untouched.
 */
export function engineCacheConfirmedFromUsage(
  usage: Pick<RawProviderUsage, "cacheReadTokens"> | undefined,
): boolean | undefined {
  return usage?.cacheReadTokens === undefined ? undefined : usage.cacheReadTokens > 0n;
}

function reportedTokensFromSettledUsage(usage: RawProviderUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const parts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
  ];
  let total = 0n;
  let known = false;
  for (const part of parts) {
    if (part === undefined) continue;
    known = true;
    total += part;
  }
  if (!known) return undefined;
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}

/**
 * Derives engine cache-affinity evidence directly from retained response-body
 * chunks (SSE or JSON) using the shared provider usage normalizer. Never
 * throws: affinity is a best-effort routing hint.
 */
export function engineCacheConfirmedFromResponseChunks(
  chunks: readonly Uint8Array[],
): boolean | undefined {
  try {
    return engineCacheConfirmedFromUsage(parseProviderUsage(chunks));
  } catch {
    return undefined;
  }
}

function classifyTerminalRecord(
  record: SseRecord,
  surface: ProtocolSurface,
): "SUCCESS" | "FAILED" | undefined {
  if (surface === "openai-chat") {
    if (record.data === "[DONE]") return "SUCCESS";
    try {
      const value = JSON.parse(record.data) as Record<string, unknown>;
      return value.error === undefined ? undefined : "FAILED";
    } catch {
      return undefined;
    }
  }
  try {
    const value = JSON.parse(record.data) as Record<string, unknown>;
    const dataType = typeof value.type === "string" ? value.type : undefined;
    // A terminal needs an explicit `event:` line that agrees with the record's
    // `type`. OpenRouter's native Responses stream sends no `event:` lines, so
    // its terminal is deliberately NOT recognised (the surface is unclaimed
    // and the full hold stays). Reading to EOF for accounting does not itself
    // certify protocol completion.
    if (!record.event || record.event !== dataType) return undefined;
    if (record.event === "error") return "FAILED";
    if (surface === "anthropic-messages")
      return record.event === "message_stop" ? "SUCCESS" : undefined;
    if (record.event === "response.completed") return "SUCCESS";
    if (["response.failed", "response.cancelled", "response.incomplete"].includes(record.event))
      return "FAILED";
  } catch {
    return undefined;
  }
  return undefined;
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

/**
 * Retains the first `maxBytes` of response bytes. Streaming APIs report some
 * usage categories in early events (Anthropic `message_start` carries
 * `cache_read_input_tokens`), which fall out of the bounded tail window once
 * a stream grows beyond it. Mirrored by relay attempts for affinity evidence.
 */
export function retainProviderUsagePrefix(
  chunks: Uint8Array[],
  currentBytes: number,
  chunk: Uint8Array,
  maxBytes = 64 * 1024,
): number {
  if (currentBytes >= maxBytes) return currentBytes;
  const prefix = chunk.subarray(0, maxBytes - currentBytes);
  if (prefix.byteLength === 0) return currentBytes;
  chunks.push(prefix);
  return currentBytes + prefix.byteLength;
}

/**
 * How one OpenRouter response record relates to usage, per response surface
 * (design: orchestration design-openrouter-usage.md):
 * - `final`: the record whose usage is the response's authoritative total
 *   (Chat: a root `usage`; Messages: the non-stream `message` body or the
 *   `message_delta` event; Responses: the non-stream `response` body or the
 *   terminal `response.completed` / `.incomplete` / `.failed` event);
 * - `superseded`: Messages `message_start` usage, a partial snapshot that the
 *   final `message_delta` replaces (it may never exceed the final usage);
 * - `ambiguous`: usage in any other root carrier (`usage`, `response.usage`,
 *   `message.usage`; nested objects are never read), or in two carriers of
 *   one record;
 * - undefined: no usage (null usage is absence).
 */
type OpenRouterRecordUsage =
  | { kind: "final"; usage: unknown }
  | { kind: "superseded"; usage: unknown }
  | { kind: "ambiguous" };

const RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

function openRouterRecordUsage(
  surface: ProtocolSurface,
  value: unknown,
): OpenRouterRecordUsage | undefined {
  const root = usageRecord(value);
  if (!root) return undefined;
  const rootUsage = root.usage ?? null;
  if (surface === "openai-chat") {
    // Chat carries usage only in a root `usage` object; any other root
    // container (even without usage) is a second representation.
    const present = [rootUsage, root.response ?? null, root.message ?? null].filter(
      (item) => item !== null,
    ).length;
    if (present === 0) return undefined;
    if (present > 1 || usageRecord(rootUsage)?.usage != null) return { kind: "ambiguous" };
    return { kind: "final", usage: rootUsage };
  }
  const responseUsage = usageRecord(root.response)?.usage ?? null;
  const messageUsage = usageRecord(root.message)?.usage ?? null;
  const carriers = [rootUsage, responseUsage, messageUsage].filter((item) => item !== null);
  if (carriers.length === 0) return undefined;
  if (carriers.length > 1) return { kind: "ambiguous" };
  const type = typeof root.type === "string" ? root.type : undefined;
  if (surface === "anthropic-messages") {
    if (type === "message_start" && messageUsage !== null)
      return { kind: "superseded", usage: messageUsage };
    if ((type === "message_delta" || type === "message") && rootUsage !== null)
      return { kind: "final", usage: rootUsage };
    return { kind: "ambiguous" };
  }
  if (surface === "openai-responses") {
    if (type !== undefined && RESPONSES_TERMINAL_EVENTS.has(type) && responseUsage !== null)
      return { kind: "final", usage: responseUsage };
    if (type === undefined && root.object === "response" && rootUsage !== null)
      return { kind: "final", usage: rootUsage };
    return { kind: "ambiguous" };
  }
  return { kind: "ambiguous" };
}

/**
 * Collects the usage of one OpenRouter response record by record (bounded
 * memory over an arbitrarily long stream) and decides, in `settle`, the ONE
 * place OpenRouter usage becomes settleable: exactly one distinct final usage,
 * at most one superseded snapshot, nothing ambiguous, every record readable,
 * and the dialect accepts that usage as complete. Anything else is evidence
 * only (the admitted liability stays); no usage at all is missing usage.
 */
export class OpenRouterUsageRecords {
  readonly #surface: ProtocolSurface;
  readonly #finals = new Map<string, unknown>();
  readonly #snapshots: unknown[] = [];
  #superseded = 0;
  #ambiguous = false;
  #readable = true;

  constructor(surface: ProtocolSurface) {
    this.#surface = surface;
  }

  observe(value: unknown) {
    const classified = openRouterRecordUsage(this.#surface, value);
    if (!classified) return;
    if (classified.kind === "ambiguous") this.#ambiguous = true;
    else if (classified.kind === "superseded") {
      this.#superseded += 1;
      // Only the first snapshot is ever compared (and settlement requires at
      // most one superseded record), so one slot is enough.
      if (this.#snapshots.length < 1) this.#snapshots.push(classified.usage);
    } else if (this.#finals.size < 2)
      this.#finals.set(JSON.stringify(classified.usage), classified.usage);
  }

  observeData(data: string) {
    if (data === "[DONE]") return;
    try {
      this.observe(JSON.parse(data));
    } catch {
      // OpenRouter sends only JSON records. A non-JSON one may be a usage
      // record merged by unusual framing (or carrying trailing bytes): it
      // cannot be read, so no other record may settle alone.
      this.#readable = false;
    }
  }

  /** Marks the response as not fully decoded (a record may be missing). */
  markUnreadable() {
    this.#readable = false;
  }

  settle(pricing?: ProviderPricingSchedule): RawProviderUsage | undefined {
    const finals = [...this.#finals.values()];
    if (finals.length === 0 && this.#superseded === 0 && !this.#ambiguous) return undefined;
    const normalize = (usage: unknown) =>
      this.#surface === "anthropic-messages"
        ? openRouterAnthropicUsage(usage)
        : usageFromObject({ usage }, "openrouter");
    const only =
      finals.length === 1 &&
      this.#superseded <= 1 &&
      !this.#ambiguous &&
      this.#readable &&
      !openRouterUsageRegressed(this.#snapshots[0], finals[0])
        ? normalize(finals[0])
        : undefined;
    const charged =
      only?.categoriesComplete === true ? openRouterCharge(finals[0], only) : undefined;
    if (charged) return withCalculatedCost(charged, pricing);
    const evidence = finals.length > 0 ? normalize(finals.at(-1)) : undefined;
    const rawUsage = finals.map(
      (usage) => JSON.parse(JSON.stringify(usage)) as Prisma.InputJsonValue,
    );
    return unattributableUsage({
      ...(evidence ?? { accountingVersion: "provider-billable-v1", confidence: "REPORTED" }),
      rawUsage: rawUsage.length === 1 ? rawUsage[0] : rawUsage,
    });
  }
}

const OPENROUTER_MONOTONIC_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

/**
 * Messages usage only grows: the final `message_delta` counts are at least the
 * `message_start` snapshot's. A final lower in any counted field cannot be
 * attributed (rejected, not repaired with a per-field maximum, so a lower
 * total is never charged); an unreadable snapshot counter fails closed too.
 */
function openRouterUsageRegressed(snapshot: unknown, final: unknown): boolean {
  if (snapshot === undefined) return false;
  const early = usageRecord(snapshot);
  const last = usageRecord(final);
  if (!early || !last) return true;
  return OPENROUTER_MONOTONIC_KEYS.some((key) => {
    // An absent counter is zero; a PRESENT one (null included) must be a
    // readable integer, or the snapshot cannot bound the final.
    const before = Object.hasOwn(early, key) ? usageInteger(early[key]) : 0;
    const after = Object.hasOwn(last, key) ? usageInteger(last[key]) : 0;
    return before === undefined || after === undefined || after < before;
  });
}

/**
 * Decodes a retained OpenRouter body into records: its SSE `data:` records when
 * it is an SSE stream, otherwise the whole body as one JSON document. Comment
 * lines, and usage-looking text outside a complete record, never become one.
 */
function openRouterRecords(
  chunks: readonly Uint8Array[],
  surface: ProtocolSurface,
): OpenRouterUsageRecords {
  const collected = new OpenRouterUsageRecords(surface);
  const decoder = new SseDecoder();
  let sawRecord = false;
  try {
    for (const chunk of chunks)
      for (const record of decoder.push(chunk)) {
        sawRecord = true;
        collected.observeData(record.data);
      }
    for (const record of decoder.finish()) {
      sawRecord = true;
      collected.observeData(record.data);
    }
  } catch {
    // Not SSE: read the whole body as JSON below. A stream that stops being
    // valid SSE after some records may hide a later record: unreadable.
    if (sawRecord) collected.markUnreadable();
  }
  if (sawRecord) return collected;
  try {
    collected.observe(
      JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))),
    );
  } catch {
    // A truncated or non-JSON body carries no attributable usage.
  }
  return collected;
}

const OPENROUTER_ANTHROPIC_USAGE_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "output_tokens_details",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_creation",
  "inference_geo",
  "server_tool_use",
  "service_tier",
  "speed",
  "cost",
  "is_byok",
  "cost_details",
]);

/**
 * OpenRouter's Anthropic Messages usage (Anthropic semantics: `input_tokens`
 * excludes cache reads and writes; `output_tokens` includes thinking). Only
 * the captured vocabulary is accepted; anything else is an unknown category.
 */
function openRouterAnthropicUsage(value: unknown): RawProviderUsage | undefined {
  const usage = usageRecord(value);
  if (!usage) return undefined;
  const input = usageInteger(usage.input_tokens);
  const output = usageInteger(usage.output_tokens);
  const cacheRead = usageInteger(usage.cache_read_input_tokens ?? 0);
  const cacheWrite = usageInteger(usage.cache_creation_input_tokens ?? 0);
  const outputDetails =
    usage.output_tokens_details == null ? {} : usageRecord(usage.output_tokens_details);
  const thinking = usageInteger(outputDetails?.thinking_tokens ?? 0);
  const creation = usage.cache_creation == null ? undefined : usageRecord(usage.cache_creation);
  const fiveMinute = usageInteger(creation?.ephemeral_5m_input_tokens ?? 0);
  const oneHour = usageInteger(creation?.ephemeral_1h_input_tokens ?? 0);
  const optionalString = (item: unknown) => item == null || typeof item === "string";
  const valid =
    Object.keys(usage).every((key) => OPENROUTER_ANTHROPIC_USAGE_KEYS.has(key)) &&
    input !== undefined &&
    output !== undefined &&
    cacheRead !== undefined &&
    cacheWrite !== undefined &&
    outputDetails !== undefined &&
    Object.keys(outputDetails).every((key) => key === "thinking_tokens") &&
    thinking !== undefined &&
    thinking <= output &&
    (usage.cache_creation == null ||
      (creation !== undefined &&
        Object.keys(creation).every(
          (key) => key === "ephemeral_5m_input_tokens" || key === "ephemeral_1h_input_tokens",
        ) &&
        fiveMinute !== undefined &&
        oneHour !== undefined &&
        fiveMinute + oneHour === cacheWrite &&
        // One-hour cache writes have their own rate: not a settled category.
        oneHour === 0n)) &&
    optionalString(usage.inference_geo) &&
    optionalString(usage.service_tier) &&
    optionalString(usage.speed) &&
    openRouterMetadataValid(usage);
  const reportedCost = usageCost(usage.cost);
  return {
    inputTokens: input,
    outputTokens: output !== undefined && thinking !== undefined ? output - thinking : undefined,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: thinking,
    categoriesComplete: valid,
    rawUsage: JSON.parse(JSON.stringify(usage)),
    reportedCost,
    reportedCostSource: reportedCost === undefined ? undefined : "provider-runtime",
    accountingVersion: "provider-billable-v1",
    confidence: "REPORTED",
  };
}

/**
 * The spend an accepted OpenRouter usage settles. OpenRouter documents `cost`
 * as "the total amount charged to your account" and
 * `cost_details.upstream_inference_cost` as "the actual cost charged by the
 * upstream AI provider" (openrouter.ai/docs/use-cases/usage-accounting,
 * ResponseUsage in openrouter.ai/docs/api-reference/overview). With BYOK
 * (`is_byok: true`) the upstream provider bills the key owner directly, so the
 * spend is their sum (owner decision, #62/#87). A BYOK usage without a valid
 * upstream cost is unattributable (undefined).
 */
function openRouterCharge(
  usage: unknown,
  normalized: RawProviderUsage,
): RawProviderUsage | undefined {
  const record = usageRecord(usage);
  if (record?.is_byok !== true) return normalized;
  const cost = usageCost(record.cost);
  const details = usageRecord(record.cost_details);
  const upstream = details?.upstream_inference_cost;
  if (
    cost === undefined ||
    typeof upstream !== "number" ||
    !Number.isFinite(upstream) ||
    upstream < 0
  )
    return undefined;
  return {
    ...normalized,
    reportedCost: new Prisma.Decimal(cost).plus(upstream).toString(),
    reportedCostSource: "provider-runtime",
  };
}

/** Drops a window's calculated cost; only the merged categories may be priced. */
function withoutCalculatedCost({
  calculatedCost: _cost,
  calculatedCostCurrency: _currency,
  calculatedCostPricingVersion: _version,
  calculatedCostSource: _source,
  calculatedCostConfidence: _confidence,
  ...usage
}: RawProviderUsage) {
  return usage;
}

/**
 * OpenRouter reports usage once per response. Two distinct observations cannot
 * be attributed to one final snapshot: an earlier total or charge could
 * outlive later counts. Keep them as audit evidence only, so settlement keeps
 * the admitted liability (no charge, no authoritative total, incomplete).
 */
function unattributableUsage(usage: RawProviderUsage): RawProviderUsage {
  const {
    authoritativeBillableTokens: _total,
    reportedCost: _cost,
    reportedCostCurrency: _currency,
    reportedCostPricingVersion: _version,
    reportedCostSource: _source,
    ...rest
  } = withoutCalculatedCost(usage);
  return { ...rest, categoriesComplete: false };
}

/**
 * Overlays tail-window usage onto prefix-window usage with tail precedence:
 * categories defined in the tail win, and categories only reported early
 * (before the response exceeded the tail window) are preserved from the
 * prefix. Undefined in both windows stays undefined.
 */
export function mergeProviderUsage(
  initial: RawProviderUsage | undefined,
  tail: RawProviderUsage | undefined,
  surface?: ProtocolSurface,
): RawProviderUsage | undefined {
  if (!initial || !tail) return tail ?? initial;
  // A calculated cost describes only the window it was priced from. The merged
  // categories must be priced again (the dispatcher does); keeping either
  // window's cost could settle spend for an observation that is incomplete.
  return {
    ...withoutCalculatedCost(initial),
    ...Object.fromEntries(
      Object.entries(withoutCalculatedCost(tail)).filter(([, value]) => value !== undefined),
    ),
    inputTokens: tail.inputTokens ?? initial.inputTokens,
    outputTokens: tail.outputTokens ?? initial.outputTokens,
    categoriesComplete:
      initial.categoriesComplete === false || tail.categoriesComplete === false
        ? false
        : surface === "anthropic-messages" &&
            (tail.inputTokens ?? initial.inputTokens) !== undefined &&
            (tail.outputTokens ?? initial.outputTokens) !== undefined
          ? true
          : (tail.categoriesComplete ?? initial.categoriesComplete),
    rawUsage: [initial.rawUsage, tail.rawUsage],
  } as RawProviderUsage;
}

/**
 * Derives engine cache-affinity evidence from retained prefix+tail response
 * chunks. When the response exceeded the tail window, early usage events only
 * survive in the prefix, so both windows are parsed and merged with the same
 * tail-precedence semantics the usage reconcile applies. Never throws.
 */
export function engineCacheConfirmedFromRetainedResponse(
  prefixChunks: readonly Uint8Array[],
  tailChunks: readonly Uint8Array[],
  responseBytes: number,
  tailWindowBytes = 1024 * 1024,
): boolean | undefined {
  try {
    if (responseBytes <= tailWindowBytes) {
      return engineCacheConfirmedFromUsage(parseProviderUsage(tailChunks));
    }
    return engineCacheConfirmedFromUsage(
      mergeProviderUsage(parseProviderUsage(prefixChunks), parseProviderUsage(tailChunks)),
    );
  } catch {
    return undefined;
  }
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
const providerBodyTeardowns = new WeakMap<Pick<Readable, "pause" | "destroy">, Promise<void>>();

function providerBodyTornDown(response: Pick<Readable, "pause" | "destroy">): boolean {
  return providerBodyTeardowns.has(response);
}

function teardownProviderBody(
  response: Pick<Readable, "pause" | "destroy">,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  // Readable.toWeb can still have a flowing data tick queued when cancel
  // closes its controller. Stop that flow synchronously before cancellation.
  response.pause();
  const existing = providerBodyTeardowns.get(response);
  if (existing) return existing;
  const teardown = (async () => {
    try {
      if (reader) await reader.cancel(reason);
    } catch {
      // Cancellation failure must not leave the upstream socket alive.
    } finally {
      response.destroy(reason instanceof Error ? reason : undefined);
    }
  })();
  providerBodyTeardowns.set(response, teardown);
  return teardown;
}

async function readRetryableProviderUsage(
  response: AsyncIterable<Uint8Array> & Pick<Readable, "pause" | "destroy"> & { complete: boolean },
  pricing?: ProviderPricingSchedule,
  dialect: ProviderUsageDialect = "generic",
  surface: ProtocolSurface = "openai-chat",
): Promise<RawProviderUsage | undefined> {
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let receivedBytes = 0;
  try {
    for await (const rawChunk of response) {
      const chunk = Uint8Array.from(rawChunk);
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_RETRYABLE_PROVIDER_BODY_BYTES) {
        await teardownProviderBody(
          response,
          undefined,
          new Error("Retryable provider response exceeded accounting limit"),
        );
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
  if (!response.complete) return undefined;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  } catch {
    return undefined;
  }
  const usage = parseProviderUsage(chunks, pricing, dialect, surface);
  return usage ? { ...usage, observationComplete: true } : undefined;
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
  if (target.resolvedExecution) return target.resolvedExecution.nativeSurface;
  if (target.nativeSurfaces.includes(requested)) return requested;
  return target.nativeSurfaces.find((surface) =>
    target.protocol === "anthropic"
      ? surface === "anthropic-messages"
      : surface === "openai-responses" || surface === "openai-chat",
  );
}

function selectedProviderSurface(
  target: PublicProviderTarget,
  requested: ProtocolSurface,
  mode: PublicOverflowRequest["chatTestRoutingMode"],
) {
  if (target.resolvedExecution) {
    if (mode === "REQUIRE_ADAPTED" && target.resolvedExecution.mode !== "adapted") return undefined;
    return target.resolvedExecution.nativeSurface;
  }
  if (mode !== "REQUIRE_ADAPTED") return selectedNativeSurface(target, requested);
  return target.nativeSurfaces.find(
    (surface) =>
      surface !== requested &&
      (target.protocol === "anthropic"
        ? surface === "anthropic-messages"
        : surface === "openai-responses" || surface === "openai-chat"),
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
  if (!input.policy.enabled) return { targets: input.targets, decision: null };
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(input.request.body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { targets: input.targets, decision: null };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { targets: input.targets, decision: null };
  }
  const affinityTargets = await buildProviderAffinityTargets({
    request: input.request,
    targets: input.targets,
  });
  const decision = await rankAffinityTargets({
    ownerId: input.request.affinityTenantUserId ?? input.request.userId,
    resourceOwnerId: input.request.userId,
    poolId: input.request.poolId,
    securityScope: input.request.affinitySecurityScope ?? input.request.userId,
    accessGrantId: input.request.affinityAccessGrantId,
    policy: input.policy,
    surface: input.request.requestedSurface,
    headers: input.request.affinityHeaders ?? input.request.headers,
    payload,
    targets: affinityTargets,
    // Dispatch may already be pinned by capacity admission. Still resolve
    // identity so rank and the eventual write agree on client carriers.
    scoreSingleTarget: true,
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

export async function buildProviderAffinityTargets(input: {
  request: Pick<
    PublicOverflowRequest,
    "userId" | "requestedSurface" | "estimatedInputTokens" | "requestedOutputTokens" | "liability"
  >;
  targets: PublicProviderTarget[];
}): Promise<AffinityTarget[]> {
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
  const liabilities = input.targets.map((_target, index) => {
    const targetPricing = pricing[index];
    return input.request.estimatedInputTokens !== undefined &&
      input.request.requestedOutputTokens !== undefined
      ? liabilityFromPricing({
          estimatedInputTokens: input.request.estimatedInputTokens,
          requestedOutputTokens: input.request.requestedOutputTokens,
          pricing: targetPricing,
        })
      : input.request.liability;
  });
  const comparableCurrency =
    liabilities.every(({ spend }) => spend !== undefined) &&
    new Set(liabilities.map(({ currency }) => currency ?? null)).size === 1;
  return input.targets.map((target, index) => {
    const liability = liabilities[index] ?? input.request.liability;
    return {
      poolMemberId: target.poolMemberId,
      executionTargetId: target.executionTargetId,
      targetIdentity: buildAffinityTargetIdentity({
        executionTargetId: target.executionTargetId,
        endpointIdentity: `${target.providerAccountId}:${target.endpointIdentity}:${target.endpointVersion}`,
        upstreamModelId: `${target.providerModelId}:${target.upstreamModelId}`,
        runtimeIdentityKey: target.providerAccountId,
        runtimeModel: target.upstreamModelId,
        runtimeRevision: target.providerVersion ?? null,
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
        mode:
          target.resolvedExecution?.mode ??
          (target.nativeSurfaces.includes(input.request.requestedSurface) ? "native" : "adapted"),
        adapterVersion:
          (target.resolvedExecution?.mode ??
            (target.nativeSurfaces.includes(input.request.requestedSurface)
              ? "native"
              : "adapted")) === "native"
            ? "native"
            : ADAPTER_VERSION,
      }),
      capacityId: `provider:${target.providerModelId}`,
      hardConcurrencyLimit: target.concurrencyLimit ?? null,
      activeLoad: loadByModel.get(target.providerModelId) ?? 0,
      waitingLoad: 0,
      weight: 1,
      requestTokens: Number(input.request.estimatedInputTokens ?? 0) || 0,
      kvBudgetTokens: null,
      slots: target.concurrencyLimit ?? null,
      healthPenalty: providerHealthPenalty(target.healthStatus),
      publicEgressPenalty: 100,
      costPenalty: comparableCurrency ? providerCostPenalty(liability) : 0,
    };
  });
}

/**
 * Dispatches ordered provider attempts. Every attempt owns a distinct durable
 * budget reservation and is reconciled before the next target is considered.
 * A returned response is committed: later body/stream failures never fail over.
 */
export async function dispatchPublicOverflow(
  request: PublicOverflowRequest,
): Promise<PublicOverflowResult> {
  // Kill switch: when WMP_PUBLIC_PROVIDER_EGRESS_ENABLED is false, no provider
  // attempt leaves WSMP. Existing database state and an earlier consent must
  // not bypass an explicit disable. The flag defaults to on; on does not send
  // data by itself.
  if (!env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED)
    return { dispatched: false, reason: "DEPLOYMENT_GATE_DISABLED" };
  // Caller consent: only evaluateExternalEgress mints a consent, and only for
  // an explicit `owner/pool:external` request whose credential allows it.
  // The consent is bound to the pool, its owner, and the exact requester and
  // token of this request.
  const consent = request.externalConsent;
  if (
    !isIssuedExternalConsent(consent) ||
    consent.poolId !== request.poolId ||
    (request.ownKeyProviderModelId ? consent.requesterUserId : consent.ownerUserId) !==
      request.userId ||
    (request.ownKeyProviderModelId !== undefined &&
      consent.ownKeyProviderModelId !== request.ownKeyProviderModelId) ||
    consent.requesterUserId !== request.requesterUserId ||
    consent.modelApiTokenId !== request.requesterModelApiTokenId ||
    consent.requesterIsOwner !== (consent.requesterUserId === consent.ownerUserId) ||
    consent.requesterIsOwner !== (consent.accessGrantId === null)
  )
    return { dispatched: false, reason: "CALLER_CONSENT_MISSING" };
  const sendConsent: ExternalSendConsentIdentity = {
    requesterUserId: consent.requesterUserId,
    modelApiTokenId: consent.modelApiTokenId,
    poolId: consent.poolId,
    ownerUserId: consent.ownerUserId,
    accessGrantId: consent.accessGrantId,
    ownKeyProviderModelId: request.ownKeyProviderModelId,
  };
  // Owner and caller consent, re-read from the database at dispatch time
  // (the consent was minted at authentication, possibly minutes ago): the
  // owner's fallback flags, the caller's token consent, and the requester's
  // exact grant, and the requester's account state. Nothing is decrypted or
  // sent unless all of them still hold.
  const [listed, callerDenial] = await Promise.all([
    listPublicOverflowTargets(
      consent.ownerUserId,
      request.poolId,
      request.ownKeyProviderModelId
        ? {
            requesterUserId: request.userId,
            providerModelId: request.ownKeyProviderModelId,
            accessGrantId: consent.accessGrantId,
          }
        : undefined,
    ),
    readExternalConsentDenial(sendConsent),
  ]);
  if (callerDenial === "REQUESTER_NOT_VISIBLE") return { dispatched: false, reason: callerDenial };
  // #76: a banned or deletion-marked owner's pool is unavailable to everyone,
  // own-key included (request-wide, never a fall-through to another tier).
  if (!listed.ownerActive) return { dispatched: false, reason: "POOL_OWNER_INACTIVE" };
  if (!listed.enabled)
    return {
      dispatched: false,
      reason: request.ownKeyProviderModelId ? "OWN_KEY_CONSENT_WITHDRAWN" : "POOL_PRIVATE",
    };
  if (!consent.requesterIsOwner && !listed.fallbackForGrantees)
    return { dispatched: false, reason: "GRANTEE_NOT_COVERED" };
  if (callerDenial) return { dispatched: false, reason: consentSkipReason(callerDenial) };
  // Payload size may change during cross-protocol rendering. Do the initial
  // pass with zero input solely to reject protocol/feature/output mismatches;
  // each target is checked again with its actual rendered wire size below.
  const binding = request.exactResponsesBinding;
  const compatibilityRequest = {
    ...request,
    liability: request.liability,
    contextTokens: 0n,
  };
  const compatibleTargets = (targets: PublicProviderTarget[]) => {
    const memberEligible = targetsForForcedPoolMember(targets, request.forcedPoolMemberId);
    const eligible = binding
      ? memberEligible.filter((target) => matchesExactResponsesBinding(target, binding))
      : request.requireNativeSurface
        ? memberEligible.filter(
            (target) =>
              target.nativeSurfaces.includes(request.requireNativeSurface!) &&
              (request.requireNativeSurface !== "anthropic-messages" ||
                target.protocol === "anthropic"),
          )
        : memberEligible;
    return eligible.flatMap((target) => {
      if (
        request.admittedExecutionTargetId &&
        target.executionTargetId !== request.admittedExecutionTargetId
      )
        return [];
      const resolvedExecution = resolvePublicProviderExecution(target, compatibilityRequest);
      const resolvedTarget = { ...target, resolvedExecution };
      if (
        publicTargetCompatibility(target, compatibilityRequest) !== "COMPATIBLE" ||
        !matchesChatTestProviderMode(
          resolvedTarget,
          request.requestedSurface,
          request.chatTestRoutingMode,
        )
      )
        return [];
      return [resolvedTarget];
    });
  };
  const compatible = compatibleTargets(listed.targets);
  // A compatible member exists but its provider is in a health cooldown:
  // temporarily unavailable, not an incompatible request.
  if (compatible.length === 0 && compatibleTargets(listed.coolingDown).length > 0)
    return { dispatched: false, reason: "PROVIDER_UNHEALTHY" };
  if (binding && listed.unavailable.some((target) => matchesExactResponsesBinding(target, binding)))
    return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
  // A stored-response binding that matches no live member is
  // permanently invalid: no retry can make it match again.
  if (compatible.length === 0 && binding)
    return { dispatched: false, reason: "BOUND_TARGET_INVALID" };
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

  let ranked: Awaited<ReturnType<typeof rankPublicOverflowTargets>>;
  try {
    ranked =
      binding || request.ownKeyProviderModelId
        ? { decision: null, targets: compatible }
        : await rankPublicOverflowTargets({
            request,
            policy: listed.affinityPolicy,
            targets: compatible,
          });
  } catch {
    ranked = {
      decision: null,
      targets: compatible.map((target) => ({
        ...target,
        affinity: { outcome: "NO_MATCH", score: 0, prefixDepth: 0, reason: "affinity_error" },
      })),
    };
  }

  await request.releaseLocalCapacity();
  const keyringValue = env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  if (!keyringValue) return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
  const keyring = parseProviderCredentialKeyring(keyringValue);
  let lastAdmission: ProviderBudgetAdmission | undefined;
  // The transient reason the last admitted attempt did not send, when it
  // reached the health claim or beyond (see the final return).
  let anyProviderIoStarted = false;
  let providerFailure: Extract<PublicOverflowResult, { dispatched: false }>["providerFailure"];
  let lastSendFailure:
    | "PROVIDER_UNHEALTHY"
    | "SEND_CLAIM_FAILED"
    | "PROVIDER_UNAVAILABLE"
    | "BOUND_TARGET_INVALID"
    | undefined;
  let attemptCount = 0;

  const rankedTargets = orderChatTestProviderTargets(
    ranked.targets,
    request.requestedSurface,
    request.chatTestRoutingMode,
  );
  for (const [rankedIndex, target] of rankedTargets.entries()) {
    const nativeSurface = binding
      ? exactResponsesNativeSurface(target)
      : selectedProviderSurface(target, request.requestedSurface, request.chatTestRoutingMode);
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
      upstream = binding
        ? {
            protocol: "openai",
            path: request.path,
            headers: request.headers,
            body: request.body,
          }
        : nativeSurface === request.requestedSurface
          ? {
              protocol: request.requestedProtocol,
              path: request.path,
              headers: request.headers,
              body: replaceModel(request.body, target.upstreamModelId),
            }
          : await request.renderForTarget!(target, nativeSurface);
      // D9: every body sent to an OpenRouter account carries the account's
      // data-collection preference, whichever path rendered it. A body that
      // cannot carry it is never sent (REQUEST_RENDER_FAILED below).
      upstream = {
        ...upstream,
        body: applyOpenRouterDataCollection(upstream.body, target.dataCollectionPolicy),
      };
    } catch (error) {
      if (isRequestDepthError(error)) throw error;
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
    const byteEstimate = conservativeSerializedInputTokens(upstream.body.byteLength);
    const renderedInputTokens =
      payloadAwareInputTokens(upstream.body) ?? request.estimatedInputTokens ?? byteEstimate;
    const renderedLiability = liabilityFromPricing({
      estimatedInputTokens: byteEstimate,
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
        poolId: request.ownKeyProviderModelId ? undefined : request.poolId,
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
      // Another trial is in flight or the cooldown started after listing:
      // temporarily unavailable.
      lastSendFailure = "PROVIDER_UNHEALTHY";
      await reconcileProviderBudget({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        credentialId: target.credential.id,
        poolId: request.ownKeyProviderModelId ? undefined : request.poolId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        reason: "FAILED",
        dispatchOutcome: "NOT_SENT",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }).catch(() => undefined);
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

    // E0 send boundary, the last step before provider I/O. One transaction
    // re-validates the caller's and owner's consent while holding the consent
    // rows FOR SHARE, takes the same account-then-credential locks used by
    // lifecycle mutations, re-evaluates the requester's time- and
    // account-dependent validity after those waits, then claims the
    // credential. A consent withdrawal, revoke or grant replacement that
    // commits before this transaction is rejected here; one that commits
    // afterwards cannot retroactively cancel a send that has already been
    // claimed. Never hold database locks across provider I/O.
    let claim: PublicProviderSendClaim | "FAILED";
    try {
      claim = await claimPublicProviderCredentialForSend({
        userId: request.userId,
        target,
        keyring,
        consent: sendConsent,
        exactBinding: Boolean(binding),
      });
    } catch {
      // The claim failed before any provider I/O (lock or connection
      // timeout, credential rotated or revoked meanwhile, decrypt failure).
      // That is no evidence about the provider: hand the health trial back
      // without a verdict and settle the attempt as never sent.
      claim = "FAILED";
    }
    // D9: the policy read under the send-claim account lock can only
    // tighten what was rendered at listing time. An opt-out withdrawn after
    // listing adds the deny now; a body that cannot carry it is never sent
    // (settled as a failed claim, before any provider I/O). A later opt-in
    // never relaxes a body already rendered with the deny.
    let sentDataCollectionPolicy = target.dataCollectionPolicy;
    if (
      claim !== "FAILED" &&
      claim.claimed &&
      claim.dataCollectionPolicy === "deny" &&
      sentDataCollectionPolicy !== "deny"
    ) {
      try {
        upstream = { ...upstream, body: applyOpenRouterDataCollection(upstream.body, "deny") };
        sentDataCollectionPolicy = "deny";
      } catch {
        claim = "FAILED";
      }
    }
    // A claim that returned a denial (N6-1) is handled below whatever the
    // abort state: the denial is request-wide and must be returned as such,
    // never relabeled SEND_CLAIM_FAILED or followed by another member. Only a
    // failed claim, or a successful claim whose request or attempt was
    // aborted meanwhile, is settled here.
    if (
      claim === "FAILED" ||
      (claim.claimed && (request.signal.aborted || attemptController.signal.aborted))
    ) {
      stopHeartbeat();
      lastSendFailure = "SEND_CLAIM_FAILED";
      await releaseProviderHealthTrial({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        attemptId,
        fencingToken,
      }).catch(() => false);
      await reconcileProviderBudget({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        credentialId: target.credential.id,
        poolId: request.ownKeyProviderModelId ? undefined : request.poolId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        reason: request.signal.aborted
          ? abortedAttemptFacts(request.signal).budgetReason
          : "FAILED",
        dispatchOutcome: "NOT_SENT",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }).catch(() => undefined);
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        providerAttemptId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: request.signal.aborted
          ? abortedAttemptFacts(request.signal).reason
          : "SEND_CLAIM_FAILED",
        ...providerEventRouting({ request, target, nativeSurface }),
        reservationId: admission.reservationIds[0],
        reservationIds: admission.reservationIds,
        waitDurationMs: providerWaitDurationMs,
        terminalState: request.signal.aborted
          ? abortedAttemptFacts(request.signal).terminalState
          : "FAILED",
        contextTokens: renderedLiability.tokens,
        streamCommitted: false,
      }).catch(() => undefined);
      if (!request.retrySafe) break;
      continue;
    }
    if (!claim.claimed) {
      // Nothing was sent. Settle this attempt's reservations and hand back
      // the half-open health trial without a health verdict. A consent
      // denial is caller/pool-wide: no other target may be tried, and the
      // same typed denial as the dispatch-entry check is returned. A target
      // that changed since listing (member removed, model disabled, endpoint
      // version changed) is availability: the next member is tried only when
      // the operation is retry-safe. Callers release the provider capacity
      // lease and the caller lease on this result.
      stopHeartbeat();
      await releaseProviderHealthTrial({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        attemptId,
        fencingToken,
      }).catch(() => false);
      await reconcileProviderBudget({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        credentialId: target.credential.id,
        poolId: request.ownKeyProviderModelId ? undefined : request.poolId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        reason: "CANCELLED",
        dispatchOutcome: "NOT_SENT",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }).catch(() => undefined);
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        providerAttemptId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: claim.reason,
        ...providerEventRouting({ request, target, nativeSurface }),
        reservationId: admission.reservationIds[0],
        reservationIds: admission.reservationIds,
        waitDurationMs: providerWaitDurationMs,
        terminalState: "CANCELLED",
        contextTokens: renderedLiability.tokens,
        streamCommitted: false,
      }).catch(() => undefined);
      if (claim.reason === "PROVIDER_UNAVAILABLE" || claim.reason === "BOUND_TARGET_INVALID") {
        lastSendFailure = claim.reason;
        if (request.retrySafe && !binding) continue;
      }
      return {
        dispatched: false,
        reason: claim.reason,
        ...(anyProviderIoStarted ? { providerIoStarted: true as const } : {}),
        providerFailure,
      };
    }
    let providerIoStarted = false;
    try {
      // Finish local argument construction before marking I/O as possible.
      // A malformed URL/auth value can throw without invoking the transport.
      const options = {
        method: request.method ?? "POST",
        path: joinProviderPath(target.baseUrl, upstream.path),
        headers: Object.fromEntries(upstream.headers.entries()),
        body: upstream.body,
        signal: AbortSignal.any([
          request.signal,
          attemptController.signal,
          AbortSignal.timeout(14 * 60_000),
        ]),
      };
      const auth = providerAuth(target, claim.secret);
      await request.beforeProviderSend?.(target);
      providerIoStarted = true;
      anyProviderIoStarted = true;
      providerFailure = { target };
      const response = await providerHttpsRequest(
        target.baseUrl,
        options,
        {
          egressEnabled: true,
          allowPrivateNetworks: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
          timeoutMs: 60_000,
        },
        upstream.protocol,
        auth,
      );
      destroyAttempt = (error) => {
        void teardownProviderBody(response, undefined, error).catch(() => undefined);
      };
      const status = response.statusCode ?? 502;
      // Retry only before exposing headers/body to the caller.
      if (
        request.retrySafe &&
        (rankedIndex < ranked.targets.length - 1 || request.retrySingleTargetPrecommit === true) &&
        (status === 408 || status === 409 || status === 429 || status >= 500)
      ) {
        // Failed/rate-limited calls may still be billed. Consume only a strict
        // bounded body before retry, retaining raw usage/cost when present;
        // ambiguous, truncated, or oversized bodies keep conservative liability.
        const retryUsage = await readRetryableProviderUsage(
          response,
          pricing,
          target.usageDialect,
          nativeSurface,
        );
        const retryAfter = response.headers["retry-after"];
        providerFailure = {
          target,
          status,
          retryAfter: typeof retryAfter === "string" ? retryAfter : undefined,
        };
        if (!response.complete) await teardownProviderBody(response);
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
          poolId: request.ownKeyProviderModelId ? undefined : request.poolId,
          requestId: request.requestId,
          attemptId,
          fencingToken,
          reason: "FAILED",
          revisionSequence: 1n,
          revisionKind: "SNAPSHOT",
          observationComplete: response.complete,
          usageSource: retryUsage ? `${upstream.protocol}-retryable-response` : undefined,
          usage: retryUsage,
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
      destroyAttempt = (error) => {
        void teardownProviderBody(response, reader, error).catch(() => undefined);
      };
      let reconciliation: Promise<void> | undefined;
      let responseBytes = 0;
      let firstClientByteAt: Date | undefined;
      let firstClientBytePersistence: Promise<void> | undefined;
      const usageChunks: Uint8Array[] = [];
      let settledUsage: RawProviderUsage | undefined;
      const initialUsageChunks: Uint8Array[] = [];
      let initialUsageBytes = 0;
      const nonstreamChunks: Uint8Array[] = [];
      let nonstreamBytes = 0;
      let nonstreamOverflow = false;
      let usageBytes = 0;
      let resolveTerminal!: (value: PublicOverflowTerminal) => void;
      const terminal = new Promise<PublicOverflowTerminal>((resolve) => {
        resolveTerminal = resolve;
      });
      const httpOk = status >= 200 && status < 400;
      let clientCancelled = false;
      let protocolTerminal = false;
      let protocolFailed = false;
      // Observe the serializer depth bound before durable attempt settlement.
      // Routes still own adaptation and client-facing protocol errors.
      const adaptedSurface = nativeSurface !== request.requestedSurface ? nativeSurface : undefined;
      let depthParser =
        adaptedSurface && request.stream ? new CanonicalStreamParser(adaptedSurface) : undefined;
      const observeAdaptedDepth = (chunk?: Uint8Array) => {
        if (!depthParser) return;
        try {
          if (chunk) depthParser.push(chunk);
          else depthParser.finish();
        } catch (error) {
          if (isResponseDepthError(error)) protocolFailed = true;
          depthParser = undefined;
        }
      };
      let deliveredProtocolTerminal = false;
      let accountingIncomplete = request.stream;
      const terminalDecoder = request.stream ? new SseDecoder() : undefined;
      // Observe every record through EOF, including after a client terminal.
      // A bounded post-terminal drain that cannot reach EOF keeps liability;
      // OpenRouter never settles from only the retained prefix/tail windows.
      const openRouterStreamRecords =
        terminalDecoder && target.usageDialect === "openrouter"
          ? new OpenRouterUsageRecords(nativeSurface ?? request.requestedSurface)
          : undefined;
      const reconcile = (streamComplete: boolean): Promise<void> => {
        if (reconciliation) return reconciliation;
        reconciliation = (async () => {
          stopHeartbeat();
          // Choose one outcome before any health/budget await. A later client
          // disconnect stops delivery without splitting this durable settlement.
          const cancelledAtSettlement = clientCancelled;
          const settleFacts = request.signal.aborted ? abortedAttemptFacts(request.signal) : null;
          const settleCancelled = cancelledAtSettlement && !capacityLeaseLostSignal(request.signal);
          const transportComplete = streamComplete && (response.complete || protocolTerminal);
          const surface = nativeSurface ?? request.requestedSurface;
          let nonstreamEnvelope: Record<string, unknown> | undefined;
          if (!request.stream && !nonstreamOverflow) {
            try {
              const parsed = JSON.parse(
                new TextDecoder().decode(
                  Buffer.concat(nonstreamChunks.map((chunk) => Buffer.from(chunk))),
                ),
              );
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                nonstreamEnvelope = parsed as Record<string, unknown>;
            } catch {
              nonstreamEnvelope = undefined;
            }
          }
          if (adaptedSurface && !request.stream && nonstreamEnvelope) {
            try {
              parseProtocolResponse({
                surface: adaptedSurface,
                body: nonstreamEnvelope,
                status,
              });
            } catch (error) {
              if (isResponseDepthError(error)) protocolFailed = true;
            }
          }
          const streamTerminal = !request.stream || protocolTerminal;
          const providerFailed =
            protocolFailed ||
            (!request.stream &&
              (nonstreamEnvelope?.error != null ||
                (surface === "anthropic-messages" && nonstreamEnvelope?.type === "error") ||
                (surface === "openai-responses" &&
                  ["failed", "cancelled", "incomplete"].includes(
                    typeof nonstreamEnvelope?.status === "string" ? nonstreamEnvelope.status : "",
                  ))));
          const ok =
            transportComplete &&
            httpOk &&
            streamTerminal &&
            (request.stream || nonstreamEnvelope !== undefined) &&
            !providerFailed &&
            !cancelledAtSettlement;
          const healthOutcome = providerHealthOutcome(status);
          const attemptAborted =
            request.signal.aborted || attemptController.signal.aborted || cancelledAtSettlement;
          if (!attemptAborted && healthOutcome !== "NEUTRAL") {
            await recordProviderHealth(
              target,
              request.userId,
              ok && healthOutcome === "SUCCESS",
              { status, retryAfter: response.headers["retry-after"] },
              { attemptId, fencingToken },
            ).catch(() => undefined);
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
          const combinedUsage = openRouterStreamRecords
            ? openRouterStreamRecords.settle(pricing)
            : target.usageDialect === "openrouter" && !request.stream
              ? // The whole body is the one record; an overflowing body has none.
                nonstreamOverflow
                ? undefined
                : parseProviderUsage(nonstreamChunks, pricing, "openrouter", surface)
              : mergeProviderUsage(
                  responseBytes > 1024 * 1024
                    ? parseProviderUsage(initialUsageChunks, pricing, target.usageDialect)
                    : undefined,
                  parseProviderUsage(
                    !request.stream && !nonstreamOverflow ? nonstreamChunks : usageChunks,
                    pricing,
                    target.usageDialect,
                  ),
                  surface,
                );
          const combinedCost =
            combinedUsage && pricing ? calculatedCostForUsage(combinedUsage, pricing) : undefined;
          const observedUsage: RawProviderUsage | undefined = combinedCost
            ? ({
                ...combinedUsage,
                calculatedCost: combinedCost,
                calculatedCostCurrency: pricing!.currency,
                calculatedCostPricingVersion: pricing!.version,
                calculatedCostSource: "wsmp-pricing",
                calculatedCostConfidence:
                  pricing!.confidence === "REPORTED" ? "CALCULATED" : pricing!.confidence,
              } as RawProviderUsage)
            : combinedUsage;
          const observationComplete =
            transportComplete &&
            !accountingIncomplete &&
            (request.stream
              ? protocolTerminal && !protocolFailed
              : nonstreamEnvelope !== undefined && !nonstreamOverflow);
          const usage = observedUsage
            ? {
                ...observedUsage,
                // Transport completion is independent from whether the provider
                // exposes every token category. A complete cost-only observation
                // may settle spend, while truncated observations remain audit-only.
                observationComplete,
              }
            : undefined;
          // Publish the settled usage before the terminal resolves so the
          // best-effort affinity write observes the same evidence as billing.
          settledUsage = usage;
          await reconcileProviderBudget({
            userId: request.userId,
            providerAccountId: target.providerAccountId,
            providerModelId: target.providerModelId,
            credentialId: target.credential.id,
            poolId: request.ownKeyProviderModelId ? undefined : request.poolId,
            requestId: request.requestId,
            attemptId,
            fencingToken,
            reason: settleCancelled
              ? "CANCELLED"
              : (settleFacts?.budgetReason ?? (ok ? "COMPLETED" : "FAILED")),
            revisionSequence: 1n,
            revisionKind: "SNAPSHOT",
            observationComplete,
            usageSource: usage ? `${upstream.protocol}-response` : "missing-provider-usage",
            usage,
          });
          const state = settleCancelled
            ? "CANCELLED"
            : settleFacts
              ? settleFacts.terminalState
              : ok
                ? "COMPLETED"
                : "FAILED";
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
            reason: settleCancelled
              ? "CANCELLED"
              : settleFacts
                ? settleFacts.reason
                : ok
                  ? "COMPLETED"
                  : "FAILED",
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
            metadata: { status, responseBytes, streamComplete: response.complete === true },
          }).catch(() => undefined);
          resolveTerminal({ ok, responseBytes, usage });
        })();
        return reconciliation;
      };
      const heldBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (clientCancelled) return;
          if (deliveredProtocolTerminal) {
            controller.close();
            return;
          }
          let reachedEof = false;
          let heldTerminalChunk: Uint8Array | undefined;
          let postTerminalBytes = 0;
          let drainDeadline: number | undefined;
          try {
            while (true) {
              const remainingMs =
                drainDeadline === undefined ? undefined : drainDeadline - Date.now();
              let chunk: ReadableStreamReadResult<Uint8Array> | undefined;
              let drainTimer: ReturnType<typeof setTimeout> | undefined;
              try {
                if (remainingMs === undefined) {
                  chunk = await reader.read();
                } else if (remainingMs > 0 && postTerminalBytes < POST_TERMINAL_DRAIN_MAX_BYTES) {
                  chunk = await Promise.race([
                    reader.read(),
                    new Promise<undefined>((resolve) => {
                      drainTimer = setTimeout(() => resolve(undefined), remainingMs);
                    }),
                  ]);
                }
              } finally {
                if (drainTimer !== undefined) clearTimeout(drainTimer);
              }
              // Cancellation can resolve a read as done while discarding queued
              // records. Client cancel owns settlement; other teardown is an error,
              // even if the upstream transport has already marked itself complete.
              if (clientCancelled) return;
              // Defense in depth: a response the egress layer already errored is
              // never a clean EOF (natural auto-destruction sets no error).
              if (response.errored) throw response.errored;
              if (providerBodyTornDown(response) || attemptController.signal.aborted) {
                throw (
                  attemptController.signal.reason ??
                  new Error("Provider response body was torn down before EOF")
                );
              }
              if (!chunk) {
                accountingIncomplete = true;
                openRouterStreamRecords?.markUnreadable();
                await reconcile(true);
                await teardownProviderBody(response, reader);
                if (clientCancelled) return;
                deliveredProtocolTerminal = true;
                controller.enqueue(heldTerminalChunk!);
                return;
              }
              if (chunk.done) {
                observeAdaptedDepth();
                reachedEof = true;
                if (terminalDecoder) {
                  const records = terminalDecoder.finish();
                  for (const record of records) {
                    openRouterStreamRecords?.observeData(record.data);
                    const outcome = classifyTerminalRecord(
                      record,
                      nativeSurface ?? request.requestedSurface,
                    );
                    protocolTerminal ||= outcome !== undefined;
                    protocolFailed ||= outcome === "FAILED";
                  }
                }
                if (terminalDecoder && response.complete) accountingIncomplete = false;
                else if (protocolTerminal && !response.complete) {
                  openRouterStreamRecords?.markUnreadable();
                }
                // Do not expose either a streaming terminal event or EOF until
                // correctness-required settlement and health release are durable.
                await reconcile(response.complete);
                if (clientCancelled) return;
                if (heldTerminalChunk) {
                  deliveredProtocolTerminal = true;
                  controller.enqueue(heldTerminalChunk);
                  return;
                }
                if (response.complete || !httpOk) {
                  controller.close();
                } else
                  controller.error(
                    new Error("Provider response ended before transport completion"),
                  );
                return;
              }
              if (heldTerminalChunk) postTerminalBytes += chunk.value.byteLength;
              responseBytes += chunk.value.byteLength;
              observeAdaptedDepth(chunk.value);
              if (!request.stream && !nonstreamOverflow) {
                if (nonstreamBytes + chunk.value.byteLength <= 8 * 1024 * 1024) {
                  nonstreamChunks.push(chunk.value);
                  nonstreamBytes += chunk.value.byteLength;
                } else {
                  nonstreamOverflow = true;
                  nonstreamChunks.length = 0;
                }
              }
              initialUsageBytes = retainProviderUsagePrefix(
                initialUsageChunks,
                initialUsageBytes,
                chunk.value,
              );
              // Retain the bounded tail, not merely the prefix. Streaming APIs
              // report authoritative usage in terminal events, which may occur
              // after arbitrarily large content deltas.
              usageBytes = retainProviderUsageTail(usageChunks, usageBytes, chunk.value);
              if (terminalDecoder) {
                terminalDecoder.push(chunk.value, (record, endByteOffset) => {
                  openRouterStreamRecords?.observeData(record.data);
                  const outcome = classifyTerminalRecord(
                    record,
                    nativeSurface ?? request.requestedSurface,
                  );
                  // Include bytes following the first terminal in its own chunk.
                  // Absolute decoder offsets exclude earlier streamed content.
                  if (!protocolTerminal && outcome !== undefined)
                    postTerminalBytes = responseBytes - endByteOffset;
                  protocolTerminal ||= outcome !== undefined;
                  protocolFailed ||= outcome === "FAILED";
                });
              }
              if (protocolTerminal) {
                heldTerminalChunk ??= chunk.value;
                drainDeadline ??= Date.now() + POST_TERMINAL_DRAIN_MAX_MS;
                continue;
              }
              controller.enqueue(chunk.value);
              return;
            }
          } catch (error) {
            accountingIncomplete = true;
            openRouterStreamRecords?.markUnreadable();
            await teardownProviderBody(response, reader);
            if (clientCancelled) return;
            if (reachedEof && reconciliation) {
              // A failed durable success terminal remains ACTIVE for retry or
              // crash repair; never rewrite it as a transport failure.
              resolveTerminal({ ok: false, responseBytes });
            } else {
              // A provider-side truncation is itself the terminal observation.
              // Persist its conservative failure settlement before resolving
              // the terminal promise, while preserving the stream error.
              try {
                await reconcile(false);
              } catch (reconcileError) {
                resolveTerminal({ ok: false, responseBytes });
                if (!clientCancelled) controller.error(reconcileError);
                return;
              }
            }
            if (!clientCancelled) controller.error(error);
          }
        },
        async cancel(reason) {
          // A rejecting response adapter cancels its source too. That is an
          // upstream failure, while a caller cancellation keeps its own outcome.
          clientCancelled = !isResponseDepthError(reason);
          if (!clientCancelled) protocolFailed = true;
          await teardownProviderBody(response, reader, reason);
          await reconcile(false).catch(() => resolveTerminal({ ok: false, responseBytes }));
        },
      });
      const bodyForbidden = status === 204 || status === 205 || status === 304;
      if (bodyForbidden) {
        await teardownProviderBody(response, reader);
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
          // Time-to-first-token for usage rollups; first commitment wins.
          prisma.relayRequest.updateMany({
            where: { id: request.requestId, firstClientByteAt: null },
            data: { firstClientByteAt },
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
          if (outcome.ok && !request.ownKeyProviderModelId && target.affinityTarget) {
            try {
              const parsed: unknown = JSON.parse(new TextDecoder().decode(request.body));
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                await rememberAffinity({
                  ownerId: request.affinityTenantUserId ?? request.userId,
                  resourceOwnerId: request.userId,
                  poolId: request.poolId,
                  securityScope: request.affinitySecurityScope ?? request.userId,
                  accessGrantId: request.affinityAccessGrantId,
                  policy: listed.affinityPolicy,
                  surface: request.requestedSurface,
                  payload: parsed as Record<string, unknown>,
                  headers: request.affinityHeaders ?? request.headers,
                  target: target.affinityTarget,
                  engineCacheConfirmed: engineCacheConfirmedFromUsage(settledUsage),
                  estimatedTokens:
                    request.estimatedInputTokens === undefined
                      ? undefined
                      : Number(
                          request.estimatedInputTokens > BigInt(Number.MAX_SAFE_INTEGER)
                            ? BigInt(Number.MAX_SAFE_INTEGER)
                            : request.estimatedInputTokens,
                        ),
                  reportedTokens: reportedTokensFromSettledUsage(settledUsage),
                });
            } catch {
              // Affinity is a best-effort routing hint and cannot change a terminal result.
            }
          }
          return outcome;
        }),
        markFirstClientByte,
        affinity: target.affinity,
        ...(await mapDataPolicyRefusal(
          sentDataCollectionPolicy,
          new Response(bodyForbidden ? null : heldBody, {
            status,
            headers: providerResponseHeaders(
              response.headers,
              nativeSurface === request.requestedSurface &&
                target.resolvedExecution?.mode !== "adapted",
            ),
          }),
        )),
      };
    } catch {
      stopHeartbeat();
      lastSendFailure = "PROVIDER_UNAVAILABLE";
      // A caller disappearing before provider response is not evidence that
      // the provider transport is unhealthy. Keep the existing health state;
      // cancellation still terminalizes and reconciles the durable attempt.
      if (providerIoStarted && !request.signal.aborted && !attemptController.signal.aborted) {
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
      if (!providerIoStarted || request.signal.aborted || attemptController.signal.aborted) {
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
        poolId: request.ownKeyProviderModelId ? undefined : request.poolId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        reason: request.signal.aborted
          ? abortedAttemptFacts(request.signal).budgetReason
          : "FAILED",
        dispatchOutcome: providerIoStarted ? undefined : "NOT_SENT",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }).catch(() => undefined);
      await recordProviderAttemptEvent({
        userId: request.userId,
        providerAccountId: target.providerAccountId,
        providerModelId: target.providerModelId,
        providerAttemptId,
        requestId: request.requestId,
        attemptId,
        fencingToken,
        eventType: "TERMINAL",
        reason: request.signal.aborted
          ? abortedAttemptFacts(request.signal).reason
          : providerIoStarted
            ? "TRANSPORT"
            : "REQUEST_SETUP_FAILED",
        ...providerEventRouting({ request, target, nativeSurface }),
        reservationId: admission.reservationIds[0],
        reservationIds: admission.reservationIds,
        waitDurationMs: providerWaitDurationMs,
        terminalState: request.signal.aborted
          ? abortedAttemptFacts(request.signal).terminalState
          : "FAILED",
        contextTokens: renderedLiability.tokens,
        streamCommitted: false,
      }).catch(() => undefined);
      if (!request.retrySafe) break;
    }
  }
  // Every reason below is transient (retry later), except
  // BOUND_TARGET_INVALID from a send claim that found the own-key target gone
  // (a stored-response binding returns it directly, never continues).
  return {
    dispatched: false,
    ...(anyProviderIoStarted ? { providerIoStarted: true as const } : {}),
    providerFailure,
    reason:
      lastAdmission && !lastAdmission.admitted
        ? lastAdmission.reason === "PROTECTION_POLICY_MISSING"
          ? "PROTECTION_POLICY_MISSING"
          : "BUDGET_EXCEEDED"
        : (lastSendFailure ?? "PROVIDER_UNAVAILABLE"),
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

/** Context-fit estimate for a rendered JSON body. Byte-per-token stays on the
 * budget hold, which is settled from real usage. */
export function payloadAwareInputTokens(serializedBody: Uint8Array): bigint | undefined {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(serializedBody),
    );
    return BigInt(estimatePayloadTokens(parsed).tokens);
  } catch {
    return undefined;
  }
}

export type { RawProviderUsage };
