import { TEST_INSTANCE_HEADER } from "@ws-model-proxy/api/contracts";
import {
  embeddingContractsMatch,
  parseEmbeddingContract,
} from "@ws-model-proxy/api/lib/embedding-contract";
import { engineCountContextSupportsNative } from "@ws-model-proxy/api/lib/engine-facts";
import {
  getConfiguredMediaAttachmentMaxBytes,
  resolveAttachmentLimit,
} from "@ws-model-proxy/api/lib/media-attachment-limits";
import {
  normalizeTranscriptionCapabilities,
  openAiCapabilitiesFromCoarse,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  buildPoolRouteSequence,
  isRetryableTargetRelayFailure,
  markTargetHalfOpenTrial,
  markTargetRelaySuccess,
  type PoolRouteRow,
  type RelayFailureClass,
  recordTargetRelayFailure,
  relayFailureClasses,
  releaseTargetHalfOpenTrial,
  routeKey,
  targetHealthFailure,
} from "@ws-model-proxy/api/lib/pool-routing";
import { ANTHROPIC_DEFAULT_API_VERSION } from "@ws-model-proxy/api/lib/provider-protocol";
import {
  resolveExecutionPath,
  type SurfaceRequestRequirements,
} from "@ws-model-proxy/api/lib/surface-capabilities";
import prisma from "@ws-model-proxy/db";
import { hmacDigestForPurpose } from "@ws-model-proxy/db/node-security";
import {
  poolOwnerActive,
  userCredentialAccessBlocked,
} from "@ws-model-proxy/db/user-deletion-access";
import { env } from "@ws-model-proxy/env/server";
import { Hono } from "hono";
import { getMediaConfig } from "../media/config.js";
import { type OpenAiCompatibleCapabilities, type RelayFailure } from "../relay/protocol.js";
import { type RelaySessionManager, relaySessionManager } from "../relay/session-manager.js";
import {
  type AnthropicIngress,
  anthropicErrorResponse,
  anthropicRelayHeaders,
  parseAnthropicIngress,
} from "./anthropic-protocol.js";
import {
  type AffinityDecision,
  type AffinityPolicy,
  type AffinitySessionBinding,
  affinityPrefixDigests,
  affinityRuntimeIdentity,
  buildAffinityTargetIdentity,
  isAffinityTargetWarm,
  rankAffinityTargets,
  rememberAffinity,
  resolveAffinitySession,
} from "./cache-affinity.js";
import { captureAffinityTargetGenerations } from "./cache-affinity-residency.js";
import {
  type CacheHolderPlan,
  cacheHolderOutcome,
  planCacheHolderWait,
  spillDelayMs,
} from "./cache-holder-wait.js";
import {
  calibratedContextTokens,
  calibratedFootprintTokens,
  observeContextCalibration,
} from "./capacity/calibration.js";
import {
  type ContextCountTelemetry,
  contextFitsLimits,
  contextTokensFitCeiling,
  countSerializedRequestContext,
  withCalibratedContextCount,
} from "./capacity/context.js";
import { contextCounterRegistry } from "./capacity/counter-registry.js";
import {
  capacityLeaseLostSignal,
  precommitLeaseLost,
  servedLocalTerminal,
} from "./capacity/lease-loss.js";
import { estimatePayloadTokens } from "./capacity/payload-estimate.js";
import { PostgresCapacityAdmissionStore } from "./capacity/postgres-store.js";
import { capacityRequestScopeMiddleware } from "./capacity/request-scope.js";
import { releaseCapacityLeaseWithRetry } from "./capacity/response-lease.js";
import {
  type CapacityAdmissionRuntime,
  StoreCapacityAdmissionRuntime,
} from "./capacity/runtime.js";
import { type CapacityLeaseHandle, NORMAL_PRIORITY_RANK } from "./capacity/types.js";
import {
  allowsChatTestExecutionMode,
  resolveChatTestRoutingMode,
} from "./chat-test-routing-mode.js";
import { responseWithFirstClientByte } from "./client-byte-commit.js";
import { clientCredential } from "./client-credential.js";
import { recordLearnedFix, recordLearnedHeader } from "./compat/profile-store.js";
import type { CompatRefusal } from "./compat/request-policy.js";
import type { ProxyExtras } from "./compat/runtime-compat.js";
import {
  addCompatReport,
  applyCompatToBuilt,
  type CompatExtra,
  type CompatTrace,
  compatExtrasFor,
  compatLaunchFor,
  compatRetryDecision,
  compatTraceData,
  launchKeyString,
  MAX_COMPAT_ERROR_BYTES,
  newCompatTrace,
  normalizeNativeResponse,
  peekStream,
} from "./compat/send.js";
import {
  EXTERNAL_MODEL_VARIANT,
  type ExternalEgressConsent,
  type ExternalEgressDenial,
  type ExternalRouteError,
  evaluateExternalEgress,
  externalDenialError,
  externalModelId,
  externalRouteErrorResponse,
  externalUnavailableMessage,
  FALLBACK_HEADER,
  FALLBACK_REASON_HEADER,
  type FallbackRoute,
  GRANTEE_SPEND_CAP_MESSAGE,
  ROUTE_HEADER,
  resolveRequestedModelName,
  SERVED_MODEL_HEADER,
  withResponseHeaders,
} from "./external-route.js";
import {
  evictionContinuationKind,
  kvEvictionResetGeneration,
  kvEvictionResetMs,
  observeKvEviction,
} from "./kv-eviction-feedback.js";
import {
  MODEL_API_MAX_REQUEST_BODY_BYTES,
  MODEL_API_RELAY_TIMEOUT_MS,
  ModelApiConcurrencyLimiter,
  ModelApiLimitError,
  type ModelApiLimitLease,
  modelApiConcurrencyLimiter,
  remainingRelayBudgetMs,
} from "./limits.js";
import {
  LOCAL_SEND_DENIAL_FAILURE,
  type LocalSendBinding,
  type LocalSendDenial,
  LocalSendRefused,
  startAuthorizedLocalRelayAttempt,
} from "./local-send.js";
import {
  ensureTransformPolicySystemMessage,
  messagesContainTransformEnvelope,
  type TransformDebug,
} from "./media-transform.js";
import { applyMetricRoutingVerdicts } from "./metric-routing-order.js";
import {
  multimodalFlagsFromCapabilities,
  openAiModelListExtensions,
  poolModelListFlags,
} from "./model-list-modalities.js";
import {
  MultipartIngressError,
  type MultipartScalarPart,
  parseMultipartToSpool,
  type ReplayableMultipart,
} from "./multipart-form-data.js";
import { nativeRequestHeaders } from "./native-request-headers.js";
import {
  type ModelApiFailure,
  openAiErrorBody,
  openAiFailureJsonResponse,
  relayFailureHttpStatus,
  relayFailureMessage,
} from "./openai-errors.js";
import {
  OPENROUTER_DATA_POLICY_ERROR_CODE,
  OPENROUTER_DATA_POLICY_ERROR_MESSAGE,
} from "./openrouter-privacy.js";
import { prefillSpeedSource } from "./prefill-estimator.js";
import {
  ADAPTER_VERSION,
  AdapterError,
  type AdapterLogContext,
  adaptNonstreamResponse,
  type CanonicalRequest,
  CanonicalStreamRenderer,
  createProtocolAdaptationTransform,
  executionTargetAcceptsTopK,
  executionTargetSupportsStreamUsage,
  isRequestDepthError,
  type ProtocolSurface,
  parseCanonicalRequest,
  reasoningControlForSurface,
  renderCanonicalRequest,
  renderProtocolError,
  renderProtocolErrorMetadata,
  safeProviderRateCount,
  safeProviderRateReset,
  safeProviderRequestId,
  safeProviderRetryAfter,
} from "./protocols/index.js";
import {
  conservativeProviderLiability,
  conservativeSerializedInputTokens,
  dispatchPublicOverflow,
  isExternalConsentDenialReason,
  listPublicOverflowTargets,
  matchesChatTestProviderMode,
  matchesExactResponsesBinding,
  orderChatTestProviderTargets,
  type PublicOverflowReason,
  type PublicOverflowRequest,
  type PublicOverflowSkipReason,
  type PublicProviderTarget,
  payloadAwareInputTokens,
  publicTargetCompatibility,
  resolvePublicProviderExecution,
} from "./public-overflow.js";
import { type RelayAttemptTerminal, type startRelayAttempt } from "./relay-executor.js";
import { reportRelayRequestCreated } from "./relay-request-observer.js";
import { classifyEngineContextOverflow, shouldRetryRelayOperation } from "./relay-retry-policy.js";
import {
  LOCAL_RELAY_ATTEMPT_TTL_MS,
  LOCAL_RELAY_PROCESS_EPOCH,
  runLocalAttemptFinalization,
  trackLocalRelayAttempt,
} from "./relay-telemetry-recovery.js";
import {
  engineCacheConfirmedFromUsageFacts,
  type RelayUsageFacts,
  reportedAffinityTokens,
  usageFactsFromProviderUsage,
  usageFactsFromRelayTerminal,
  withEstimatedUsage,
} from "./relay-usage-facts.js";
import { type RelayBodySource } from "./request-body-source.js";
import { profileSurfaceRequest } from "./request-feature-profiler.js";
import { REQUEST_JSON_DEPTH_ERROR, requestJsonDepthExceeded } from "./request-json-depth.js";
import {
  type ApiKeyIdentity,
  authenticateApiKey,
  type CallablePool,
  type CallableTargets,
  listCallableTargetsForApiKey,
  listCallableTargetsForUser,
  type PoolRoute,
  poolRoutes,
  type RouteInstance,
  type RoutePoolPolicy,
  type RouteServedModel,
  type RouteTarget,
  type TestRoute,
  type TestTarget,
  testRoutes,
} from "./resolve.js";
import {
  RESPONSE_NOT_STORED_MESSAGE,
  storedResponseUnavailable,
  unsupportedCapabilityMessage,
} from "./responses-storage.js";
import {
  isBasicTranscriptionRequest,
  TranscriptionRequestError,
  type TranscriptionRequestProfile,
  transcriptionCapabilityCompatible,
  transcriptionRequestProfileFromParts,
} from "./transcription-request.js";
import { readUpstreamErrorExcerpt } from "./upstream-error-excerpt.js";
import { type RelayRequestSourceValue, transitionRelayRequestTerminal } from "./usage-rollup.js";
import {
  assessWarmProtection,
  type ProtectionEngineKind,
  protectionKvBudgetTokens,
  protectionRouting,
  type WarmProtectionPolicy,
  warmProtectionSource,
} from "./warm-protection.js";

type ModelApiRouteDependencies = {
  manager?: Pick<
    RelaySessionManager,
    | "getOnlineNodeIds"
    | "registerRelayResponseHandlers"
    | "sendRelayRequest"
    | "cancelRelayRequest"
    | "completeRelayRequest"
    | "supportsCountContext"
  >;
  concurrencyLimiter?: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
};

async function holdOrReleaseCapacityResponse(
  runtime: CapacityAdmissionRuntime,
  response: Response,
  lease: CapacityLeaseHandle,
  signal?: AbortSignal,
): Promise<Response> {
  if (response.body) return runtime.hold(response, lease, signal);
  await releaseCapacityLeaseWithRetry({ store: runtime, lease });
  return response;
}

type JsonObject = Record<string, unknown>;

type ModelApiEndpointFamily =
  | "chat.completions"
  | "embeddings"
  | "responses"
  | "messages"
  | "audio";

type ModelApiCapability =
  | "chat.completions"
  | "embeddings"
  | "audio.transcriptions"
  | "audio.translations"
  | "audio.speech"
  | "responses.create"
  | "responses.statefulFollowUps"
  | "responses.retrieve"
  | "responses.delete"
  | "responses.cancel"
  | "responses.listInputItems"
  | "responses.countTokens"
  | "responses.compact"
  | "messages.create"
  | "messages.countTokens";

type BuiltRelayRequest = {
  headers: Headers;
  body: Uint8Array | RelayBodySource;
};

function relayAttemptBody(body: Uint8Array | RelayBodySource) {
  return body instanceof Uint8Array ? { body } : { bodySource: body };
}

type RelayRequestBuilder = (upstreamModelId: string) => Promise<BuiltRelayRequest>;

type RelayOperation = {
  /** Synthetic member diagnostics settle transport capacity here and classify probe health in diagnostics.ts. */
  memberProbe?: boolean;
  family: ModelApiEndpointFamily;
  method: "GET" | "POST" | "DELETE";
  path: string;
  capability: ModelApiCapability;
  additionalCapabilities?: ModelApiCapability[];
  stream: boolean;
  transcriptionProfile?: TranscriptionRequestProfile;
  // Chat Test is an internal consumer that can accept a final SSE metrics event
  // derived from the relay's standardized RelayComplete metrics. Public
  // OpenAI-compatible routes retain the upstream byte stream unchanged.
  appendTerminalUsage?: boolean;
  buildRequest: RelayRequestBuilder;
  responseStickiness?: ResponseStickinessCapture;
  /** Internal local Responses binding, never copied from the caller payload. */
  sessionBinding?: AffinitySessionBinding;
  anthropicIngress?: AnthropicIngress;
  dispose?: () => Promise<void>;
  contextCount?: ContextCountTelemetry;
  contextInput?: JsonObject;
  adaptation?: {
    poolEnabled: boolean;
    allowLossyDeveloperRoleCollapse: boolean;
    requestedSurface: ProtocolSurface;
    payload: JsonObject;
  };
};

function operationFailureResponse(
  operation: Pick<RelayOperation, "family">,
  failure: ModelApiFailure,
  message?: string,
) {
  if (operation.family !== "messages") return openAiFailureJsonResponse(failure, message);
  const status = relayFailureHttpStatus(failure);
  return anthropicErrorResponse(
    status,
    message ?? relayFailureMessage(failure),
    status === 404
      ? "not_found_error"
      : status === 401 || status === 403
        ? "authentication_error"
        : status === 429
          ? "rate_limit_error"
          : failure === "request_too_large"
            ? "request_too_large"
            : status >= 500
              ? "api_error"
              : "invalid_request_error",
  );
}

type ContextExceededDetails = {
  estimatedInputTokens: number;
  estimateMethod: ContextCountTelemetry["method"];
  contextMarginTokens: number;
  effectiveContextCeilingTokens: number;
};

class ContextCeilingExceededError extends Error {
  readonly name = "ContextCeilingExceededError";
  constructor(readonly details: ContextExceededDetails) {
    super("Request context exceeds the configured execution capacity ceiling.");
  }
}

function countFirstCeilingTokens(
  physicalMaxContext: number | null | undefined,
  effectiveContextCeiling: number | null | undefined,
  contextMargin: number | null | undefined,
): number | null {
  const ceiling = effectiveContextCeilingTokens(physicalMaxContext, effectiveContextCeiling);
  if (ceiling == null || !Number.isSafeInteger(ceiling) || ceiling <= 0) return null;
  const margin =
    typeof contextMargin === "number" && Number.isSafeInteger(contextMargin) && contextMargin > 0
      ? contextMargin
      : 0;
  const inclusive = ceiling - margin;
  if (!Number.isSafeInteger(inclusive) || inclusive <= 0) return null;
  return inclusive;
}

function strictlyLargerCeilingRoutes<T extends { poolMemberId: string }>({
  candidates,
  fromMemberId,
  fromCeiling,
  memberCeiling,
  sharesTokenizer = () => true,
  minTokens = null,
}: {
  candidates: readonly T[];
  fromMemberId: string;
  fromCeiling: number | null;
  memberCeiling: (poolMemberId: string) => number | null;
  sharesTokenizer?: (poolMemberId: string) => boolean;
  minTokens?: number | null;
}): T[] {
  return candidates.filter((route) => {
    if (route.poolMemberId === fromMemberId) return false;
    if (!sharesTokenizer(route.poolMemberId)) return true;
    const ceiling = memberCeiling(route.poolMemberId);
    if (fromCeiling === null || ceiling === null) return false;
    if (ceiling <= fromCeiling) return false;
    return minTokens === null || ceiling >= minTokens;
  });
}

function contextExceededResponse(
  operation: Pick<RelayOperation, "family">,
  message: string,
  details: ContextExceededDetails,
  engineSnippet?: string,
) {
  const counts = `Estimated input tokens: ${details.estimatedInputTokens}; estimate method: ${details.estimateMethod}; context margin: ${details.contextMarginTokens}; effective context ceiling: ${details.effectiveContextCeilingTokens}.`;
  const engine = engineSnippet ? ` Engine: ${engineSnippet}` : "";
  if (operation.family === "messages") {
    return anthropicErrorResponse(
      400,
      `prompt is too long. ${message} ${counts}${engine}`,
      "invalid_request_error",
    );
  }
  return new Response(
    JSON.stringify({
      error: {
        message: `${message} ${counts}${engine}`.trim(),
        type: "invalid_request_error",
        param: null,
        code: "context_length_exceeded",
        details,
      },
    }),
    { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

function effectiveContextCeilingTokens(
  physicalMaxContext: number | null | undefined,
  configuredContextCeiling: number | null | undefined,
): number | null {
  const ceilings = [physicalMaxContext, configuredContextCeiling].filter(
    (ceiling): ceiling is number => ceiling !== null && ceiling !== undefined,
  );
  return ceilings.length === 0 ? null : Math.min(...ceilings);
}

function decodeUtf8Bytes(bytes: Uint8Array | null | undefined): string {
  if (!bytes || bytes.byteLength === 0) return "";
  return new TextDecoder().decode(bytes);
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readStreamBytes(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) chunks.push(result.value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type CalibrationCapacity = {
  id: string;
  runtimeIdentityKey?: string | null;
  runtimeModel?: string | null;
  runtimeRevision?: string | null;
  imageTokenAllowance?: number | null;
};

function jsonPayloadFromRelayBody(
  body: Uint8Array | RelayBodySource | unknown,
): unknown | undefined {
  if (body instanceof Uint8Array) {
    try {
      return JSON.parse(decodeUtf8Bytes(body));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function recordCalibrationFromUsage(
  capacity: CalibrationCapacity | null | undefined,
  payload: unknown,
  usageFacts: RelayUsageFacts,
): void {
  if (!capacity || usageFacts.promptTokens === null) return;
  try {
    const estimate = estimatePayloadTokens(payload, {
      imageTokenAllowance: capacity.imageTokenAllowance,
    });
    observeContextCalibration({
      capacityId: capacity.id,
      identity: capacity,
      textEstimate: estimate.textTokens,
      promptTokens: usageFacts.promptTokens,
      mediaParts: estimate.mediaParts,
    });
  } catch {
    /* Payload estimate failures must not fail the served request. */
  }
}

function estimatedAffinityTokens(
  capacity: CalibrationCapacity | null | undefined,
  payload: unknown,
  fallback?: number,
): number | undefined {
  if (!capacity) return fallback;
  try {
    const estimate = estimatePayloadTokens(payload, {
      imageTokenAllowance: capacity.imageTokenAllowance,
    });
    return (
      calibratedFootprintTokens(capacity.id, capacity, estimate.textTokens, estimate.mediaTokens) ??
      estimate.tokens
    );
  } catch {
    return fallback;
  }
}

function responseBodyForOperation({
  body,
  headers,
  terminal,
  operation,
}: {
  body: ReadableStream<Uint8Array>;
  headers: Headers;
  terminal: Promise<RelayAttemptTerminal>;
  operation: RelayOperation;
}): ReadableStream<Uint8Array> {
  if (
    !operation.appendTerminalUsage ||
    !operation.stream ||
    !headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
  ) {
    return body;
  }

  const reader = body.getReader();
  const encoder = new TextEncoder();
  let upstreamEnded = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!upstreamEnded) {
          const chunk = await reader.read();
          if (!chunk.done) {
            controller.enqueue(chunk.value);
            return;
          }
          upstreamEnded = true;
        }
        const result = await terminal;
        // Standardized relay metrics are private to Chat Test. Public
        // OpenAI-compatible routes retain the upstream byte stream unchanged.
        if (result.ok && result.metrics) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                wsmp_metrics: {
                  completion_tokens: result.metrics.completionTokens,
                  tokenizer: result.metrics.tokenizer,
                },
              })}\n\n`,
            ),
          );
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const NATIVE_CONTEXT_COUNT_MAX_BYTES = 64 * 1024;
const ENGINE_COUNT_NEAR_CEILING_RATIO = 0.85;

function isNearContextCeiling(tokens: number, ceiling: number): boolean {
  return tokens >= Math.ceil(ceiling * ENGINE_COUNT_NEAR_CEILING_RATIO);
}

function chatCountFirstRelayFields({
  family,
  contextCount,
  contextInput,
  engineCountContext,
  physicalMaxContext,
  effectiveContextCeiling,
  contextMargin,
  manager,
  nodeId,
  relayRequestId,
  operation,
}: {
  family: RelayOperation["family"];
  contextCount: ContextCountTelemetry | undefined;
  contextInput: RelayOperation["contextInput"];
  engineCountContext: Parameters<typeof engineCountContextSupportsNative>[0];
  physicalMaxContext: number | null | undefined;
  effectiveContextCeiling: number | null | undefined;
  contextMargin?: number | null;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  nodeId: string;
  relayRequestId: string;
  operation: RelayOperation;
}): {
  countFirst?: true;
  countCeiling?: number;
  onCountResult?: (message: {
    tokens: number;
    method:
      | "vllm_tokenize"
      | "tgi_chat_tokenize"
      | "llama_apply_template"
      | "llama_input_tokens"
      | "reader_count"
      | "adapter_count";
  }) => void;
} {
  if (family !== "chat.completions") return {};
  if (!engineCountContextSupportsNative(engineCountContext)) return {};
  if (!manager.supportsCountContext(nodeId)) return {};
  const ceiling = countFirstCeilingTokens(
    physicalMaxContext,
    effectiveContextCeiling,
    contextMargin,
  );
  if (ceiling == null || !contextCount || !isNearContextCeiling(contextCount.tokens, ceiling)) {
    return {};
  }
  return {
    countFirst: true,
    countCeiling: ceiling,
    onCountResult(message) {
      const exactCount: ContextCountTelemetry = {
        tokens: message.tokens,
        method: "NATIVE",
        exact: true,
        confidence: "EXACT",
        safetyMargin: 1,
        serializedChars: JSON.stringify(contextInput ?? {}).length,
      };
      operation.contextCount = exactCount;
      void updateContextCountMetadata(relayRequestId, exactCount).catch(metadataUpdateError);
    },
  };
}

async function readBoundedJson(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<unknown> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel("native_count_response_too_large");
      throw new Error("Native count response exceeds its size limit.");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

async function nativeContextCount({
  request,
  selected,
  operation,
  manager,
  relayRequestId,
  requester,
  pool,
}: {
  request: Request;
  selected: ContextCountModelRow;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  relayRequestId: string;
  requester: RelayRequester;
  /** A pool member's count; `ownerUserId` + `shareId` feed the send gate (#76, #95). */
  pool?: {
    id: string;
    memberId: string;
    contributedShareId: string | null;
    ownerUserId: string;
    shareId: string | null;
  };
}): Promise<ContextCountTelemetry | null> {
  if (!operation.contextInput) return null;
  const capacity = selected.instance;
  // Undefined is retained for compatibility with pre-capacity mocks/rows that
  // behaved as native-first before countStrategy was projected here.
  const countStrategy = capacity?.countStrategy ?? "ENGINE_REPORTED";
  const registeredCounter = capacity
    ? contextCounterRegistry.resolve({
        runtimeIdentityKey: capacity.runtimeIdentityKey,
        runtimeModel: capacity.runtimeModel,
        runtimeRevision: capacity.runtimeRevision,
        tokenizer: capacity.tokenizer,
        tokenizerVersion: capacity.tokenizerVersion,
        template: capacity.template,
        templateVersion: capacity.templateVersion,
      })
    : null;
  const countWithConfiguredCounter = async () => {
    const useRegistry =
      countStrategy === "TOKENIZER" ||
      countStrategy === "TEMPLATE_AWARE" ||
      countStrategy === "ENGINE_REPORTED";
    const raw = await countSerializedRequestContext({
      input: operation.contextInput,
      counters: useRegistry && registeredCounter ? [registeredCounter] : [],
      useTokenEstimate: true,
      imageTokenAllowance: capacity?.imageTokenAllowance,
      signal: request.signal,
    });
    if (raw.exact || raw.method === "TOKENIZER_TEMPLATE") return raw;
    if (
      !capacity ||
      (countStrategy !== "CALIBRATED_ESTIMATE" &&
        countStrategy !== "TOKENIZER" &&
        countStrategy !== "TEMPLATE_AWARE")
    )
      return raw;
    const calibrated = calibratedContextTokens(
      capacity.id,
      capacity,
      raw.textTokens ?? raw.tokens,
      raw.mediaTokens ?? 0,
    );
    return calibrated === null ? raw : withCalibratedContextCount(raw, calibrated);
  };
  if (
    operation.capability === "responses.countTokens" ||
    operation.capability === "messages.countTokens"
  )
    return null;
  if (countStrategy !== "ENGINE_REPORTED") return countWithConfiguredCounter();
  const countCapability =
    operation.family === "responses"
      ? ("responses.countTokens" as const)
      : operation.family === "messages"
        ? ("messages.countTokens" as const)
        : null;
  if (!countCapability) return countWithConfiguredCounter();
  const countOperation: RelayOperation = {
    family: operation.family,
    method: "POST",
    path:
      operation.family === "responses" ? "/v1/responses/count_tokens" : "/v1/messages/count_tokens",
    capability: countCapability,
    stream: false,
    buildRequest: operation.buildRequest,
  };
  if (
    !supportsOperation({
      capabilities: effectiveDirectCapabilities(selected),
      operation: countOperation,
    })
  ) {
    return countWithConfiguredCounter();
  }
  let built: BuiltRelayRequest | undefined;
  let attempt: ReturnType<typeof startRelayAttempt> | undefined;
  const localExecution: LocalExecutionTelemetry = {
    attemptKind: "CONTEXT_COUNT",
    selectedExecutionTargetId: selected.target.id,
    selectedPoolMemberId: pool?.memberId,
    instance: selected.instance,
    nativeSurface: telemetrySurfaceForOperation(countOperation),
    requestedSurface: telemetrySurfaceForOperation(countOperation),
    adapterMode: "NATIVE",
    localAttemptId: crypto.randomUUID(),
    poolId: pool?.id,
    contextCount: operation.contextCount,
  };
  try {
    built = await operation.buildRequest(selected.upstreamModelId);
    if (!(built.body instanceof Uint8Array)) return countWithConfiguredCounter();
    await startLocalExecutionTelemetry(relayRequestId, requester.userId, localExecution);
    attempt = await startAuthorizedLocalRelayAttempt(
      localSendBinding(
        selected,
        requester,
        pool
          ? {
              id: pool.id,
              ownerUserId: pool.ownerUserId,
              shareId: pool.shareId,
              memberId: pool.memberId,
              contributedShareId: pool.contributedShareId,
            }
          : undefined,
      ),
      {
        requestId: localExecution.localAttemptId,
        manager,
        nodeId: selected.instance.nodeId,
        handle: selected.instance.handle,
        family: operation.family,
        method: "POST",
        path: countOperation.path,
        headers: built.headers,
        body: built.body,
        timeoutMs: 5_000,
        abortSignal: request.signal,
      },
    );
    const started = await attempt.started;
    if (started.status < 200 || started.status >= 300) {
      await started.body.cancel("native_count_status");
      const terminal = await attempt.terminal;
      await recordLocalTerminal(relayRequestId, requester.userId, localExecution, terminal);
      return countWithConfiguredCounter();
    }
    const payload = await readBoundedJson(started.body, NATIVE_CONTEXT_COUNT_MAX_BYTES);
    const terminal = await attempt.terminal;
    if (!terminal.ok || !isJsonObject(payload)) {
      await recordLocalTerminal(relayRequestId, requester.userId, localExecution, terminal);
      return countWithConfiguredCounter();
    }
    const tokens = payload.input_tokens;
    if (!Number.isSafeInteger(tokens) || (tokens as number) < 0) {
      await recordLocalTerminal(relayRequestId, requester.userId, localExecution, terminal);
      return countWithConfiguredCounter();
    }
    const exactCount = {
      tokens: tokens as number,
      method: "NATIVE" as const,
      exact: true as const,
      confidence: "EXACT" as const,
      safetyMargin: 1,
      serializedChars: JSON.stringify(operation.contextInput).length,
    };
    await recordLocalTerminal(
      relayRequestId,
      requester.userId,
      { ...localExecution, contextCount: exactCount },
      terminal,
    );
    return exactCount;
  } catch (error) {
    attempt?.cancel(request.signal.aborted ? "cancelled" : "protocol_error");
    if (attempt) {
      const terminal = await attempt.terminal.catch(() => rejectedRelayTerminal());
      await recordLocalTerminal(relayRequestId, requester.userId, localExecution, terminal).catch(
        metadataUpdateError,
      );
    } else if (error instanceof LocalSendRefused) {
      // Nothing was sent; the dispatch gate ends the request later.
      await recordLocalTerminal(
        relayRequestId,
        requester.userId,
        localExecution,
        rejectedRelayTerminal(error.failure),
      ).catch(metadataUpdateError);
    }
    if (request.signal.aborted) throw request.signal.reason;
    // An authorization refusal is terminal, never a reason to fall back to
    // the estimate (the caller ends the request); only a member that became
    // unavailable, or an ordinary counter error, keeps the estimate.
    if (error instanceof LocalSendRefused && error.denial !== "MEMBER_UNAVAILABLE") throw error;
    return countWithConfiguredCounter();
  }
}

type PreparedModeledRequest = {
  model: string;
  payload: JsonObject | null;
  stream: boolean;
  transcriptionProfile?: TranscriptionRequestProfile;
  buildRequest: RelayRequestBuilder;
  transformDebug?: TransformDebug;
  dispose?: () => Promise<void>;
};

type ResponseStickinessCapture = {
  requester: RelayRequester;
  targetRuntimeModelId?: string;
  targetPoolId?: string;
  /** Exact grant a grantee reached `targetPoolId` through; null for its owner. */
  shareId?: string | null;
};

type StickyRoute =
  | {
      target: "TEST";
      visibleTarget: TestTarget;
      selectedRuntimeModelId: string;
      selectedExecutionTargetId: string;
    }
  | {
      target: "POOL";
      visibleTarget: CallablePool;
      selectedRuntimeModelId: string;
      selectedExecutionTargetId: string;
      sessionBinding?: AffinitySessionBinding;
    }
  | {
      target: "PROVIDER";
      route?: "pool-external" | "own-key";
      visibleTarget: CallablePool;
      binding: {
        executionTargetId: string;
        providerAccountId: string;
        providerModelId: string;
        endpointIdentity: string;
        endpointVersion: number;
        upstreamModelId: string;
      };
    };

/**
 * A served model on one instance, as local sends and native context counts read it. `id` is
 * the RuntimeModel id.
 */
type ContextCountModelRow = {
  id: string;
  userId: string;
  upstreamModelId: string;
  target: RouteTarget;
  instance: LocalInstance;
  model: RouteServedModel;
};

/** An instance with a head node to relay to (routes without one are dropped at load). */
type LocalInstance = RouteInstance & { nodeId: string };

function hasHeadNode<T extends { instance: RouteInstance }>(
  route: T,
): route is T & { instance: LocalInstance } {
  return route.instance.nodeId !== null;
}

/** The TEST route a direct (session or agent) request runs on. */
type DirectModelRelayRow = ContextCountModelRow;

function servedRoute(
  route: (TestRoute | PoolMemberRelayRow) & { instance: LocalInstance },
): ContextCountModelRow {
  return {
    id: route.model.id,
    userId: route.model.userId,
    upstreamModelId: route.model.upstreamModelId,
    target: route.target,
    instance: route.instance,
    model: route.model,
  };
}

/**
 * One LOCAL pool route: a member's served model on one instance serving it (see
 * `poolMemberRows`). A member served by several instances has one row per instance, so rows
 * are keyed by `id` (pool-routing `routeKey`: member and target) and `memberId` names the
 * PoolMember for persisted facts.
 */
type PoolMemberRelayRow = {
  id: string;
  memberId: string;
  poolId: string;
  /** The contributing share of a contributed member; null for the owner's own. */
  contributedShareId: string | null;
  weight: number;
  active: boolean;
  target: RouteTarget;
  instance: LocalInstance;
  model: RouteServedModel;
  pool: RoutePoolPolicy;
};

function poolMemberRow(route: PoolRoute & { instance: LocalInstance }): PoolMemberRelayRow {
  return {
    id: routeKey({ poolMemberId: route.member.id, executionTargetId: route.target.id }),
    memberId: route.member.id,
    poolId: route.member.poolId,
    contributedShareId: route.member.shareId,
    weight: route.member.weight,
    active: route.member.active,
    target: route.target,
    instance: route.instance,
    model: route.model,
    pool: route.pool,
  };
}

/** Warm protection and affinity name the generic engine GENERIC. */
function protectionEngineKind(engine: RouteInstance["engine"]): ProtectionEngineKind | null {
  return engine === "OTHER" ? "GENERIC" : engine;
}

/**
 * The routing view of a pool route. Its `poolMemberId` is the ROUTE key (`row.id`), so the
 * candidates buildPoolRouteSequence returns are keyed like every in-memory map of the pool
 * path; `memberIdOfRoute` gives back the PoolMember for persisted facts.
 */
function poolRouteRowOf(row: PoolMemberRelayRow): PoolRouteRow {
  return {
    poolMemberId: row.id,
    poolId: row.poolId,
    runtimeModelId: row.model.id,
    upstreamModelId: row.model.upstreamModelId,
    executionTargetId: row.target.id,
    instanceId: row.instance.id,
    instanceHandle: row.instance.handle,
    nodeId: row.instance.nodeId,
    instanceReady: row.instance.ready,
    nodeOnline: row.instance.nodeOnline,
    memberActive: row.active,
    weight: row.weight,
    health: row.target.health,
    lastFailureClass: row.target.lastFailureClass,
    consecutiveRetryableFailures: row.target.consecutiveRetryableFailures,
    lastFailureAt: row.target.lastFailureAt,
    nextRetryAt: row.target.nextRetryAt,
    halfOpenTrialStartedAt: row.target.halfOpenTrialStartedAt,
  };
}

type RelayMetadataCreate = {
  /** Pool requests start "local"; external dispatch rewrites it. Null for direct. */
  fallbackRoute?: FallbackRoute;
  userId: string;
  source: RelayRequestSourceValue;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  /** The served model a TEST request names directly. */
  requestedRuntimeModelId?: string;
  requestedPoolId?: string;
  /** The caller asked for `:external`. */
  external?: boolean;
  /** The internal sidecar hop that described media for this request. */
  transformerLatencyMs?: number | null;
  operation?: ModelApiCapability;
  requestBytes?: number | null;
  contextCount?: ContextCountTelemetry;
  requestedSurface: string;
};

/** The route a request was decided on; persisted as RelayRequest.route / selected*. */
type RouteIdentity = {
  fallbackRoute: FallbackRoute | null;
  selectedExecutionTargetId: string | null;
  selectedRuntimeModelId: string | null;
  selectedPoolMemberId: string | null;
  selectedProviderModelId?: string | null;
};

class RouteIdentityPersistenceError extends Error {}

/** RelayRequest.route values ("local" | "cloud" | "own_key"). */
function routeColumn(route: FallbackRoute | null | undefined): string | null {
  if (!route) return null;
  if (route === "pool-external") return "cloud";
  if (route === "own-key") return "own_key";
  return "local";
}

function routeIdentityData(identity: RouteIdentity) {
  return {
    route: routeColumn(identity.fallbackRoute),
    selectedTargetId: identity.selectedExecutionTargetId,
    selectedProviderModelId: identity.selectedProviderModelId ?? null,
    // A cloud or own-key route supersedes any local instance chosen before it.
    ...(identity.fallbackRoute && identity.fallbackRoute !== "local"
      ? { selectedInstanceId: null, selectedVersionId: null, selectedNodeId: null }
      : {}),
  };
}

/**
 * RelayRequest.rejection for a request refused before any upstream answered. The prefix is
 * the rollup family (capacity, context, spend, other).
 */
function rejectionForFailure(failure: ModelApiFailure): string | null {
  switch (failure) {
    case "rate_limited":
      return "capacity_wait_expired";
    case "capacity_lease_lost":
      return "capacity_lease_lost";
    case "request_too_large":
      return "context_too_large";
    case "not_found":
    case "unsupported_capability":
    case "access_denied":
    case "disconnected":
      return failure;
    default:
      return null;
  }
}

type RelayMetadataUpdate = {
  routeIdentity?: RouteIdentity;
  selectedRuntimeModelId?: string;
  status: "SUCCEEDED" | "FAILED" | "CANCELED";
  startedAt: Date;
  terminal: RelayAttemptTerminal;
  fallbackFailure?: ModelApiFailure;
  /** Set when the request was refused before any upstream answered. */
  rejection?: string | null;
  transformerLatencyMs?: number | null;
  attemptCount?: number;
  affinity?: {
    outcome: string;
    score: number;
    prefixDepth: number;
    reason: string;
    /** Local admission time spent waiting for the cache holder (S-A window). */
    waitMs?: number | null;
  };
  execution?: {
    selectedExecutionTargetId?: string;
    selectedPoolMemberId?: string;
    nativeSurface: string;
    adapterMode: "NATIVE" | "ADAPTED";
    adapterVersion?: string;
    localAttemptId: string;
    /** The instance the attempt ran on (RelayRequest.selectedInstance/Version/Node). */
    instance?: Pick<RouteInstance, "id" | "versionId" | "nodeId">;
  };
  localExecution?: LocalExecutionTelemetry;
  userId?: string;
  localTerminal?: RelayAttemptTerminal;
  /**
   * Usage facts the caller already parsed from `terminal` (the pool path needs
   * them for affinity evidence too); parsed here when absent. Never both.
   */
  usage?: RelayUsageFacts;
  /** Pool route decided for this request; omitted leaves the column as is. */
  fallbackRoute?: FallbackRoute;
};

type RelayRequester = {
  userId: string;
  /** Entry point, persisted on the RelayRequest and keyed in usage rollups. */
  source: RelayRequestSourceValue;
  limitKey: string;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  exposeTransformDebug?: boolean;
};

/** The pool's one max wait (pool_advanced.maxWaitMs) bounds every local candidate. */
function effectiveMemberWaitBudget(member: PoolMemberRelayRow): number | null {
  return member.pool.maxWaitMs;
}

/**
 * Local admission wait for one candidate. A consented `:external` caller with
 * an external plan waits the caller wait (pool floor, optionally lengthened),
 * and never longer than the member/pool budget. Null means no budget (only
 * the request deadline). The capacity store turns this into a database-clock
 * deadline.
 */
export function localAdmissionWaitBudget(
  memberBudgetMs: number | null,
  externalAfterWaitMs: number | null,
): number | null {
  if (externalAfterWaitMs === null) return memberBudgetMs;
  const external = Math.max(0, externalAfterWaitMs);
  return memberBudgetMs === null ? external : Math.min(memberBudgetMs, external);
}

function poolAdmissionCandidate(
  member: PoolMemberRelayRow,
  candidateOrder: number,
  requestDeadlineMs: number,
  externalAfterWaitMs: number | null = null,
) {
  return {
    capacityId: member.instance.id,
    executionTargetId: member.target.id,
    poolMemberId: member.memberId,
    candidateOrder,
    deadlineAt: new Date(requestDeadlineMs),
    waitBudgetMs: localAdmissionWaitBudget(effectiveMemberWaitBudget(member), externalAfterWaitMs),
  };
}

function warmProtectionPolicyForMember(
  member: PoolMemberRelayRow | undefined,
): WarmProtectionPolicy {
  const protection = member?.pool.protection;
  return {
    enabled: protection?.enabled ?? false,
    evictionFeedbackEnabled: protection?.evictionFeedback ?? true,
    windowSeconds: protection?.windowSeconds ?? 300,
    minTokens: protection?.minTokens ?? 8192,
    share: protection?.share ?? "EQUAL_SHARE",
    fixedPercent: protection?.fixedPercent ?? null,
  };
}

function affinityPolicyForMember(member: PoolMemberRelayRow): AffinityPolicy {
  return { ...member.pool.affinity };
}

function affinityTargetForMember(
  member: PoolMemberRelayRow,
  requestedSurface: ProtocolSurface,
  execution: { mode: string; nativeSurface?: string } | null | undefined,
  effectiveHealthStatus = member.target.health,
) {
  const target = member.target;
  const capacity = member.instance;
  // Target and endpoint IDs are immutable. The runtime identity includes the
  // model/revision/tokenizer/template/engine/cache namespace tuple.
  const targetIdentity = buildAffinityTargetIdentity({
    executionTargetId: target.id,
    endpointIdentity: member.instance.id,
    upstreamModelId: member.model.upstreamModelId,
    runtimeIdentityKey: capacity.runtimeIdentityKey,
    runtimeModel: capacity.runtimeModel,
    runtimeRevision: capacity.runtimeRevision,
    tokenizer: capacity.tokenizer,
    tokenizerVersion: capacity.tokenizerVersion,
    template: capacity.template,
    templateVersion: capacity.templateVersion,
    engine: capacity.engine,
    cacheNamespace: capacity.cacheNamespace,
    requestedSurface,
    nativeSurface: execution?.nativeSurface ?? requestedSurface,
    mode: execution?.mode ?? "legacy-native",
    adapterVersion: execution?.mode === "adapted" ? ADAPTER_VERSION : "native",
  });
  const healthPenalty =
    effectiveHealthStatus === "HALF_OPEN"
      ? 200
      : effectiveHealthStatus === "DEGRADED"
        ? 100
        : effectiveHealthStatus === "UNKNOWN"
          ? 25
          : 0;
  return {
    poolMemberId: member.id,
    executionTargetId: target.id,
    targetIdentity,
    capacityId: capacity.id,
    hardConcurrencyLimit: capacity.hardConcurrencyLimit,
    healthPenalty,
    publicEgressPenalty: 0,
    costPenalty: 0,
    imageTokenAllowance: capacity.imageTokenAllowance,
  };
}

const poolRelayFailureClassSet: ReadonlySet<string> = new Set(relayFailureClasses);
const RESPONSES_STICKINESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESPONSE_ID_CAPTURE_MAX_CHARS = 1024 * 1024;

function isPoolRelayFailureClass(failure: ModelApiFailure): failure is RelayFailureClass {
  return poolRelayFailureClassSet.has(failure);
}

/**
 * D9: the client-facing error for OpenRouter's data-policy refusal, in the
 * requested surface's shape (OpenAI error object or Anthropic envelope).
 */
function dataPolicyRefusalResponse(family: string): Response {
  return externalRouteErrorResponse(family, {
    code: OPENROUTER_DATA_POLICY_ERROR_CODE,
    message: OPENROUTER_DATA_POLICY_ERROR_MESSAGE,
  });
}

/** The caller's API key from Authorization: Bearer, x-api-key or api-key (one key only). */
export async function authenticateRequest(request: Request): Promise<ApiKeyIdentity | null> {
  const credential = clientCredential(request.headers);
  if (credential.kind !== "key") return null;
  return authenticateApiKey(credential.key);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequestPayload(body: Uint8Array, anthropic = false): JsonObject | Response {
  const invalid = (message: string, code = "invalid_json") =>
    anthropic
      ? anthropicErrorResponse(400, message)
      : new Response(
          JSON.stringify(openAiErrorBody({ message, type: "invalid_request_error", code })),
          { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
        );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return invalid("Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return invalid("Request body must be a JSON object.");
  if (requestJsonDepthExceeded(parsed))
    return invalid(REQUEST_JSON_DEPTH_ERROR, "request_json_too_deep");
  return parsed;
}

function requestedModel(payload: JsonObject): string | Response {
  const model = payload.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    return new Response(
      JSON.stringify(
        openAiErrorBody({
          message: "Missing required string field: model.",
          type: "invalid_request_error",
          param: "model",
          code: "missing_model",
        }),
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return model;
}

function isStreaming(payload: JsonObject): boolean {
  return payload.stream === true;
}

function upstreamBody(payload: JsonObject, upstreamModelId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ...payload, model: upstreamModelId }));
}

function emptyBody(): Uint8Array {
  return new Uint8Array();
}

function dataUrlByteSize(value: string): number | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma === -1) return null;
  const header = value.slice(0, comma).toLowerCase();
  const payload = value.slice(comma + 1);
  if (!header.includes(";base64")) return new TextEncoder().encode(payload).byteLength;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function referencedMediaIds(value: unknown, ids: Set<string>, inlineSizes: number[]): void {
  if (typeof value === "string") {
    const dataSize = dataUrlByteSize(value);
    if (dataSize !== null) inlineSizes.push(dataSize);
    try {
      const url = new URL(value);
      const segments = url.pathname.split("/").filter(Boolean);
      const mediaIndex = segments.findIndex(
        (segment) => segment === "media" || segment === "files",
      );
      const id = mediaIndex === -1 ? null : segments[mediaIndex + 1];
      if (id && /^[a-zA-Z0-9_-]+$/.test(id)) ids.add(id);
    } catch {
      // Non-URL strings (including ordinary message text) are not stored media.
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) referencedMediaIds(item, ids, inlineSizes);
    return;
  }
  if (isJsonObject(value)) {
    for (const child of Object.values(value)) referencedMediaIds(child, ids, inlineSizes);
  }
}

async function attachmentLimitResponse({
  payload,
  requesterUserId,
  modelOrPoolMaxBytes,
}: {
  payload: JsonObject | null;
  requesterUserId: string;
  modelOrPoolMaxBytes: number | null;
}): Promise<Response | null> {
  if (!payload) return null;
  const mediaIds = new Set<string>();
  const inlineSizes: number[] = [];
  referencedMediaIds(payload, mediaIds, inlineSizes);
  if (inlineSizes.length === 0 && mediaIds.size === 0) return null;
  const maxBytes = resolveAttachmentLimit({
    configuredBytes: await getConfiguredMediaAttachmentMaxBytes(),
    deploymentMaxBytes: getMediaConfig()?.maxUploadBytes,
    modelOrPoolMaxBytes,
  });
  if (inlineSizes.some((size) => size > maxBytes)) {
    return openAiFailureJsonResponse(
      "request_too_large",
      `An attachment exceeds this model's ${maxBytes}-byte limit.`,
    );
  }
  if (mediaIds.size === 0) return null;
  const assets = await prisma.mediaAsset.findMany({
    where: {
      id: { in: [...mediaIds] },
      userId: requesterUserId,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, sizeBytes: true },
  });
  if (assets.some((asset) => asset.sizeBytes > maxBytes)) {
    return openAiFailureJsonResponse(
      "request_too_large",
      `An attachment exceeds this model's ${maxBytes}-byte limit.`,
    );
  }
  return null;
}

async function transcriptionUploadLimitResponse({
  profile,
  modelOrPoolMaxBytes,
}: {
  profile: TranscriptionRequestProfile | undefined;
  modelOrPoolMaxBytes: number | null;
}): Promise<Response | null> {
  if (profile?.fileSize === undefined) return null;
  const maxBytes = resolveAttachmentLimit({
    configuredBytes: await getConfiguredMediaAttachmentMaxBytes(),
    // Multipart ingress enforces this deployment value before model routing;
    // include it here as a defense-in-depth absolute ceiling.
    deploymentMaxBytes: env.MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES,
    modelOrPoolMaxBytes,
  });
  if (profile.fileSize <= maxBytes) return null;
  return openAiFailureJsonResponse(
    "request_too_large",
    `The transcription file exceeds this model's ${maxBytes}-byte limit.`,
  );
}

function relayRequestHeaders(request: Request): Headers {
  return nativeRequestHeaders(request, "openai");
}

/**
 * A served model's request capabilities: its effective coarse capabilities (the owner's
 * override, else detected) with its embedding vector-space contract. Surface-level (v3/v4)
 * metadata such as Anthropic Messages is not modelled on RuntimeModel yet.
 */
function servedModelCapabilities(model: RouteServedModel): OpenAiCompatibleCapabilities {
  const capabilities = openAiCapabilitiesFromCoarse(model.capabilities);
  const contract = parseEmbeddingContract(model.embeddingContract);
  if (capabilities.version === 1 && capabilities.embeddings && contract)
    return { ...capabilities, embeddings: { ...capabilities.embeddings, contract } };
  return capabilities;
}

function effectiveDirectCapabilities(row: ContextCountModelRow): OpenAiCompatibleCapabilities {
  return servedModelCapabilities(row.model);
}

function effectivePoolMemberCapabilities(row: PoolMemberRelayRow): OpenAiCompatibleCapabilities {
  return servedModelCapabilities(row.model);
}

function supportsCapability({
  capabilities,
  capability,
  stream,
  transcriptionProfile,
  anthropicIngress,
}: {
  capabilities: OpenAiCompatibleCapabilities | null;
  capability: ModelApiCapability;
  stream: boolean;
  transcriptionProfile?: TranscriptionRequestProfile;
  anthropicIngress?: AnthropicIngress;
}): boolean {
  if (capability === "chat.completions") {
    return (
      resolveExecutionPath({
        capabilities,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        request: { stream },
      }).mode === "native"
    );
  }

  if (capability === "embeddings") {
    return capabilities?.embeddings?.supported === true;
  }

  if (capability === "audio.transcriptions") {
    const profile = normalizeTranscriptionCapabilities(capabilities?.audio?.transcriptions);
    return transcriptionProfile
      ? transcriptionCapabilityCompatible({ capability: profile, request: transcriptionProfile })
      : profile?.supported === true;
  }

  if (capability === "audio.translations") {
    const profile = normalizeTranscriptionCapabilities(capabilities?.audio?.translations);
    return transcriptionProfile
      ? transcriptionCapabilityCompatible({ capability: profile, request: transcriptionProfile })
      : profile?.supported === true;
  }

  if (capability === "audio.speech") {
    return capabilities?.audio?.speech === true;
  }

  if (capability === "responses.create") {
    return (
      resolveExecutionPath({
        capabilities,
        requestedSurface: "OPENAI_RESPONSES",
        request: { stream, responsesOperation: "create" },
      }).mode === "native"
    );
  }

  if (capability === "messages.create" || capability === "messages.countTokens") {
    if (capabilities?.version !== 3 && capabilities?.version !== 4) return false;
    const result = resolveExecutionPath({
      capabilities,
      requestedSurface: "ANTHROPIC_MESSAGES",
      request: {
        stream,
        countTokens: capability === "messages.countTokens",
        protocolVersion: anthropicIngress?.version,
        betaFeatures: anthropicIngress?.betaFeatures,
      },
    });
    return result.mode === "native";
  }

  if (capability === "responses.statefulFollowUps") {
    if (capabilities?.version === 3 || capabilities?.version === 4)
      return (
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { stateful: true, responsesOperation: "statefulFollowUps" },
        }).mode === "native"
      );
    return capabilities?.responses?.statefulFollowUps === true;
  }

  if (capability === "responses.retrieve") {
    if (capabilities?.version === 3 || capabilities?.version === 4)
      return (
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { stateful: true, responsesOperation: "retrieve" },
        }).mode === "native"
      );
    return capabilities?.responses?.retrieve === true;
  }

  if (capability === "responses.delete") {
    if (capabilities?.version === 3 || capabilities?.version === 4)
      return (
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { stateful: true, responsesOperation: "delete" },
        }).mode === "native"
      );
    return capabilities?.responses?.delete === true;
  }

  if (capability === "responses.cancel") {
    if (capabilities?.version === 3 || capabilities?.version === 4)
      return (
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { stateful: true, responsesOperation: "cancel" },
        }).mode === "native"
      );
    return capabilities?.responses?.cancel === true;
  }

  if (capability === "responses.listInputItems") {
    if (capabilities?.version === 3 || capabilities?.version === 4)
      return (
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { stateful: true, responsesOperation: "listInputItems" },
        }).mode === "native"
      );
    return capabilities?.responses?.listInputItems === true;
  }

  if (capability === "responses.countTokens") {
    if (capabilities?.version === 3 || capabilities?.version === 4)
      return (
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { countTokens: true, responsesOperation: "countTokens" },
        }).mode === "native"
      );
    return capabilities?.responses?.countTokens === true;
  }

  if (capabilities?.version === 3 || capabilities?.version === 4)
    return (
      resolveExecutionPath({
        capabilities,
        requestedSurface: "OPENAI_RESPONSES",
        request: { responsesOperation: "compact" },
      }).mode === "native"
    );
  return capabilities?.responses?.compact === true;
}

function supportsOperation({
  capabilities,
  operation,
}: {
  capabilities: OpenAiCompatibleCapabilities | null;
  operation: Pick<
    RelayOperation,
    "capability" | "additionalCapabilities" | "stream" | "transcriptionProfile" | "anthropicIngress"
  >;
}): boolean {
  if (
    !supportsCapability({
      capabilities,
      capability: operation.capability,
      stream: operation.stream,
      transcriptionProfile: operation.transcriptionProfile,
      anthropicIngress: operation.anthropicIngress,
    })
  ) {
    return false;
  }

  return (operation.additionalCapabilities ?? []).every((capability) =>
    supportsCapability({
      capabilities,
      capability,
      stream: operation.stream,
      transcriptionProfile: operation.transcriptionProfile,
    }),
  );
}

function requestedSurfaceForOperation(operation: RelayOperation): ProtocolSurface | null {
  // Embeddings use the native OpenAI transport, with separate operation gates.
  if (operation.family === "chat.completions" || operation.family === "embeddings")
    return "openai-chat";
  if (operation.family === "responses") return "openai-responses";
  if (operation.family === "messages" && operation.capability === "messages.create")
    return "anthropic-messages";
  return null;
}

function telemetrySurfaceForOperation(operation: RelayOperation): string {
  if (operation.family === "chat.completions") return "OPENAI_CHAT_COMPLETIONS";
  if (operation.family === "embeddings") return "OPENAI_EMBEDDINGS";
  if (operation.family === "responses") return "OPENAI_RESPONSES";
  if (operation.family === "messages") return "ANTHROPIC_MESSAGES";
  return "OPENAI_AUDIO";
}

function modelApiSurface(surface: ProtocolSurface) {
  return surface === "openai-chat"
    ? ("OPENAI_CHAT_COMPLETIONS" as const)
    : surface === "openai-responses"
      ? ("OPENAI_RESPONSES" as const)
      : ("ANTHROPIC_MESSAGES" as const);
}

function protocolSurface(surface: string): ProtocolSurface | null {
  if (surface === "OPENAI_CHAT_COMPLETIONS") return "openai-chat";
  if (surface === "OPENAI_RESPONSES") return "openai-responses";
  if (surface === "ANTHROPIC_MESSAGES") return "anthropic-messages";
  return null;
}

function nativeRouteForSurface(surface: ProtocolSurface) {
  if (surface === "openai-chat")
    return { family: "chat.completions" as const, path: "/v1/chat/completions" };
  if (surface === "openai-responses")
    return { family: "responses" as const, path: "/v1/responses" };
  return { family: "messages" as const, path: "/v1/messages" };
}

function adaptedResponseBody({
  body,
  source,
  target,
  stream,
  status,
  headers,
  signal,
  onProtocolError,
  recoverBeforeOutput,
  request,
  logContext,
}: {
  body: ReadableStream<Uint8Array>;
  source: ProtocolSurface;
  target: ProtocolSurface;
  stream: boolean;
  status: number;
  headers: Headers;
  signal: AbortSignal;
  onProtocolError?: (error: unknown) => void;
  /** With `onProtocolError`: headers are committed, so always end with a terminal error. */
  recoverBeforeOutput?: boolean;
  request?: CanonicalRequest;
  logContext?: AdapterLogContext;
}): ReadableStream<Uint8Array> {
  if (stream)
    return body.pipeThrough(
      createProtocolAdaptationTransform({
        source,
        target,
        signal,
        request,
        recoverProtocolErrors: onProtocolError !== undefined,
        recoverBeforeOutput,
        onProtocolError,
        logContext,
      }),
      { signal },
    );
  const reader = body.getReader();
  return new ReadableStream({
    async start(controller) {
      try {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > MODEL_API_MAX_REQUEST_BODY_BYTES)
            throw new Error("adapted response exceeded bounded buffer");
          chunks.push(result.value);
        }
        const merged = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const parsed = JSON.parse(new TextDecoder().decode(merged)) as unknown;
        const adapted = adaptNonstreamResponse({
          source,
          target,
          body: parsed,
          status,
          headers,
          logContext,
        });
        const output = adapted.ok ? adapted.body : renderProtocolError(target, adapted.error);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(output)));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function readAdaptedNonstreamBody({
  body,
  source,
  target,
  status,
  headers,
  signal,
  logContext,
}: {
  body: ReadableStream<Uint8Array> | null;
  source: ProtocolSurface;
  target: ProtocolSurface;
  status: number;
  headers: Headers;
  signal: AbortSignal;
  logContext?: AdapterLogContext;
}): Promise<Uint8Array> {
  if (!body) {
    const adapted = adaptNonstreamResponse({
      source,
      target,
      body: null,
      status,
      headers,
      logContext,
    });
    const output = adapted.ok ? adapted.body : renderProtocolError(target, adapted.error);
    return new TextEncoder().encode(JSON.stringify(output));
  }
  const reader = body.getReader();
  const abort = () => void reader.cancel(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let discardedOversizedError = false;
    while (true) {
      if (signal.aborted) throw signal.reason;
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MODEL_API_MAX_REQUEST_BODY_BYTES) {
        if (status >= 200 && status < 300)
          throw new Error("adapted response exceeded bounded buffer");
        discardedOversizedError = true;
        chunks.length = 0;
        await reader.cancel("oversized provider error discarded");
        break;
      }
      chunks.push(result.value);
    }
    const merged = new Uint8Array(discardedOversizedError ? 0 : bytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(merged).trim();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // Non-success provider bodies are never reflected. Malformed JSON is
        // equivalent to an absent body at this trust boundary.
      }
    }
    const adapted = adaptNonstreamResponse({
      source,
      target,
      body: parsed,
      status,
      headers,
      logContext,
    });
    const output = adapted.ok ? adapted.body : renderProtocolError(target, adapted.error);
    return new TextEncoder().encode(JSON.stringify(output));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function adaptedProviderResponseHeaders(
  source: ProtocolSurface,
  target: ProtocolSurface,
  sourceHeaders: Headers,
  adapted = true,
): Headers {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (adapted) headers.set("x-wsmp-adapter-version", "1.0.0");
  const validatedRetryAfter = safeProviderRetryAfter(sourceHeaders.get("retry-after"));
  if (validatedRetryAfter) headers.set("retry-after", validatedRetryAfter);
  const requestId = safeProviderRequestId(
    source === "anthropic-messages"
      ? sourceHeaders.get("request-id")
      : sourceHeaders.get("x-request-id"),
  );
  if (requestId)
    headers.set(target === "anthropic-messages" ? "request-id" : "x-request-id", requestId);
  const rateHeaderPairs = [
    ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit", "count"],
    ["x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining", "count"],
    ["x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset", "reset"],
    ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit", "count"],
    ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining", "count"],
    ["x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset", "reset"],
  ] as const;
  for (const [openAiName, anthropicName, kind] of rateHeaderPairs) {
    const sourceName = source === "anthropic-messages" ? anthropicName : openAiName;
    const raw = sourceHeaders.get(sourceName);
    const limitName = sourceName.replace("remaining", "limit");
    const value =
      kind === "count"
        ? safeProviderBoundedRemaining(
            raw,
            sourceName.includes("remaining"),
            sourceHeaders.get(limitName),
          )
        : source === target
          ? safeProviderRateReset(raw, source === "anthropic-messages")
          : undefined;
    if (value) headers.set(target === "anthropic-messages" ? anthropicName : openAiName, value);
  }
  return headers;
}

function safeProviderBoundedRemaining(
  raw: string | null,
  isRemaining: boolean,
  rawLimit: string | null,
): string | undefined {
  const value = safeProviderRateCount(raw);
  if (!value || !isRemaining) return value;
  const limit = safeProviderRateCount(rawLimit);
  return !limit || BigInt(value) <= BigInt(limit) ? value : undefined;
}

async function primeReadableStream(
  stream: ReadableStream<Uint8Array>,
  target: ProtocolSurface,
): Promise<{
  body: ReadableStream<Uint8Array>;
  completion: Promise<"ok" | "protocol_error" | "cancelled">;
}> {
  const reader = stream.getReader();
  const first = await reader.read();
  let pending = first.done ? null : first.value;
  let terminalObserved = pending ? targetStreamTerminal(target, pending) : false;
  let nextResponsesSequence = pending ? responseSequenceAfter(pending) : 0;
  let resolveCompletion: (result: "ok" | "protocol_error" | "cancelled") => void = () => undefined;
  const completion = new Promise<"ok" | "protocol_error" | "cancelled">((resolve) => {
    resolveCompletion = resolve;
  });
  if (first.done) resolveCompletion("ok");
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pending) {
          controller.enqueue(pending);
          pending = null;
          return;
        }
        const next = await reader.read();
        if (next.done) {
          resolveCompletion("ok");
          controller.close();
        } else {
          terminalObserved ||= targetStreamTerminal(target, next.value);
          nextResponsesSequence = Math.max(
            nextResponsesSequence,
            responseSequenceAfter(next.value),
          );
          controller.enqueue(next.value);
        }
      } catch {
        resolveCompletion("protocol_error");
        if (!terminalObserved) {
          for (const chunk of renderCommittedProtocolError(target, nextResponsesSequence))
            controller.enqueue(chunk);
        }
        controller.close();
      }
    },
    async cancel(reason) {
      resolveCompletion("cancelled");
      return reader.cancel(reason);
    },
  });
  return { body, completion };
}

function responseSequenceAfter(chunk: Uint8Array): number {
  let next = 0;
  for (const match of new TextDecoder().decode(chunk).matchAll(/"sequence_number":(\d+)/g))
    next = Math.max(next, Number(match[1]) + 1);
  return next;
}

function renderCommittedProtocolError(
  target: ProtocolSurface,
  responsesSequence: number,
): Uint8Array[] {
  if (target === "openai-responses") {
    return [
      new TextEncoder().encode(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          sequence_number: responsesSequence,
          code: "protocol_error",
          message: "The upstream stream violated the adapted protocol.",
          param: null,
        })}\n\n`,
      ),
    ];
  }
  const renderer = new CanonicalStreamRenderer(target);
  return renderer.push({
    type: "error",
    error: {
      code: "protocol_error",
      message: "The upstream stream violated the adapted protocol.",
      upstreamStatus: 502,
    },
  });
}

function targetStreamTerminal(target: ProtocolSurface, chunk: Uint8Array): boolean {
  const text = new TextDecoder().decode(chunk);
  if (target === "openai-chat") return text.includes("data: [DONE]");
  if (target === "openai-responses")
    return /event: (?:response\.(?:completed|incomplete|failed)|error)\r?\n/.test(text);
  return /event: (?:message_stop|error)\r?\n/.test(text);
}

/**
 * A request the runtime's compatibility policy refuses (strict unknown field, or a semantic
 * field the engine rejected): a 400 in the caller's protocol naming the field.
 */
function compatRefusalResponse(surface: ProtocolSurface | null, refusal: CompatRefusal): Response {
  if (surface) {
    const canonicalError = {
      code: "invalid_request_error",
      message: refusal.message,
      parameter: refusal.path,
      upstreamStatus: 400,
    };
    const metadata = renderProtocolErrorMetadata(surface, canonicalError);
    return new Response(JSON.stringify(renderProtocolError(surface, canonicalError)), {
      status: metadata.status,
      headers: metadata.headers,
    });
  }
  return new Response(
    JSON.stringify(
      openAiErrorBody({
        message: refusal.message,
        type: "invalid_request_error",
        param: refusal.path,
        code: refusal.code,
      }),
    ),
    { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

function adapterRequestErrorResponse(surface: ProtocolSurface, error: AdapterError): Response {
  const canonicalError = {
    code: "invalid_request_error",
    message: error.message,
    parameter: error.parameter,
    upstreamStatus: 400,
  };
  const metadata = renderProtocolErrorMetadata(surface, canonicalError);
  return new Response(JSON.stringify(renderProtocolError(surface, canonicalError)), {
    status: metadata.status,
    headers: metadata.headers,
  });
}

function renderForExecutionTarget({
  request,
  target,
  model,
  allowLossyDeveloperRoleCollapse,
  capabilities,
  extras,
}: {
  request: CanonicalRequest;
  target: ProtocolSurface;
  model: string;
  allowLossyDeveloperRoleCollapse?: boolean;
  capabilities: OpenAiCompatibleCapabilities | null | undefined;
  /** A runtime's gates on fields the proxy adds (absent: providers, by capabilities only). */
  extras?: ProxyExtras;
}) {
  return renderCanonicalRequest({
    request,
    target,
    model,
    allowLossyDeveloperRoleCollapse,
    acceptsTopK: extras?.topK ?? executionTargetAcceptsTopK({ capabilityInventory: capabilities }),
    streamUsage: executionTargetSupportsStreamUsage(capabilities) && (extras?.streamUsage ?? true),
    reasoning: reasoningControlForSurface(capabilities ?? null, target),
  });
}

function executionPathForPoolMember(
  capabilities: OpenAiCompatibleCapabilities | null,
  operation: RelayOperation,
  canonical?: ReturnType<typeof parseCanonicalRequest> | null,
) {
  // Vector inference has its own capability contract and never uses chat adaptation.
  if (operation.family === "embeddings") return null;
  const requestedSurface = requestedSurfaceForOperation(operation);
  if (!requestedSurface) return null;
  const adaptationEnabled = operation.adaptation?.poolEnabled === true;
  const responsesOperation = responsesOperationForRelay(operation);
  const rawRequirements = operation.adaptation
    ? profileSurfaceRequest(operation.adaptation.payload)
    : {};
  return resolveExecutionPath({
    capabilities,
    requestedSurface: modelApiSurface(requestedSurface),
    request: {
      stream: operation.stream,
      protocolVersion: operation.anthropicIngress?.version,
      betaFeatures: operation.anthropicIngress?.betaFeatures,
      responsesOperation,
      stateful:
        responsesOperation !== undefined &&
        responsesOperation !== "create" &&
        responsesOperation !== "countTokens",
      ...rawRequirements,
      ...(canonical ? canonicalRequestRequirements(canonical) : {}),
    },
    adaptationEnabled,
  });
}

function responsesOperationForRelay(
  operation: RelayOperation,
): SurfaceRequestRequirements["responsesOperation"] {
  if (operation.additionalCapabilities?.includes("responses.statefulFollowUps"))
    return "statefulFollowUps";
  const mapping: Partial<
    Record<ModelApiCapability, SurfaceRequestRequirements["responsesOperation"]>
  > = {
    "responses.create": "create",
    "responses.statefulFollowUps": "statefulFollowUps",
    "responses.retrieve": "retrieve",
    "responses.delete": "delete",
    "responses.cancel": "cancel",
    "responses.listInputItems": "listInputItems",
    "responses.countTokens": "countTokens",
    "responses.compact": "compact",
  };
  return mapping[operation.capability];
}

function canonicalRequestRequirements(
  request: ReturnType<typeof parseCanonicalRequest>,
): SurfaceRequestRequirements {
  return {
    stream: request.stream,
    tools: request.tools.length > 0,
    inputImages: request.messages.some((message) =>
      message.content.some((content) => content.type === "image"),
    ),
  };
}

function isEndpointConnected(row: ContextCountModelRow, onlineNodeIds: Set<string>): boolean {
  return routeIsServing(row, onlineNodeIds);
}

async function readModelApiBody(request: Request): Promise<Uint8Array | Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MODEL_API_MAX_REQUEST_BODY_BYTES) {
    return openAiFailureJsonResponse("request_too_large");
  }
  return body;
}

async function prepareJsonModeledRequest(
  request: Request,
  defaultResponsesStorage = false,
): Promise<PreparedModeledRequest | Response> {
  const body = await readModelApiBody(request);
  if (body instanceof Response) return body;
  const payload = parseRequestPayload(body);
  if (payload instanceof Response) return payload;
  const model = requestedModel(payload);
  if (model instanceof Response) return model;
  if (defaultResponsesStorage) {
    if (payload.store !== undefined && typeof payload.store !== "boolean")
      return openAiFailureJsonResponse("unsupported_capability", "store must be a boolean.");
    payload.store = payload.store === true;
  }

  return {
    model,
    payload,
    stream: isStreaming(payload),
    buildRequest: async (upstreamModelId) => ({
      headers: relayRequestHeaders(request),
      body: upstreamBody(payload, upstreamModelId),
    }),
  };
}

async function prepareMultipartModeledRequest(
  request: Request,
): Promise<PreparedModeledRequest | Response> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    return new Response(
      JSON.stringify(
        openAiErrorBody({
          message: "Request body must be multipart/form-data.",
          type: "invalid_request_error",
          code: "invalid_multipart",
        }),
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  let multipart: ReplayableMultipart;
  try {
    multipart = await parseMultipartToSpool(request, contentType);
  } catch (error) {
    console.warn("[model-api] multipart ingress rejected", {
      code: error instanceof MultipartIngressError ? error.code : "invalid_multipart",
    });
    if (error instanceof MultipartIngressError && error.code !== "invalid_multipart") {
      return openAiFailureJsonResponse(error.code);
    }
    return new Response(
      JSON.stringify(
        openAiErrorBody({
          message: "Request body must be valid multipart/form-data.",
          type: "invalid_request_error",
          code: "invalid_multipart",
        }),
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  const modelValues = multipart.parts
    .filter((part): part is MultipartScalarPart => part.kind === "field" && part.name === "model")
    .map((part) => part.value);
  const model = modelValues[0];
  if (modelValues.length !== 1 || !model?.trim()) {
    await multipart.dispose();
    return new Response(
      JSON.stringify(
        openAiErrorBody({
          message:
            modelValues.length > 1
              ? "model must not be provided more than once."
              : "Missing required string field: model.",
          type: "invalid_request_error",
          param: "model",
          code: modelValues.length > 1 ? "duplicate_model" : "missing_model",
        }),
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  let transcriptionProfile: TranscriptionRequestProfile;
  try {
    transcriptionProfile = transcriptionRequestProfileFromParts(multipart.parts);
  } catch (error) {
    if (!(error instanceof TranscriptionRequestError)) {
      await multipart.dispose();
      throw error;
    }
    await multipart.dispose();
    return new Response(
      JSON.stringify(
        openAiErrorBody({
          message: error.message,
          type: "invalid_request_error",
          param: error.param,
          code: error.code,
        }),
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  return {
    model,
    payload: null,
    stream: transcriptionProfile.stream,
    transcriptionProfile,
    buildRequest: async (upstreamModelId) => {
      const built = multipart.build(upstreamModelId);
      const headers = relayRequestHeaders(request);
      headers.set("content-type", built.contentType);
      return { headers, body: built.body };
    },
    dispose: multipart.dispose,
  };
}

function prepareEmptyRelayRequest(request: Request): RelayRequestBuilder {
  return async () => ({
    headers: relayRequestHeaders(request),
    body: emptyBody(),
  });
}

async function createRelayMetadata(input: RelayMetadataCreate): Promise<string> {
  const row = await prisma.relayRequest.create({
    data: {
      userId: input.userId,
      source: input.source,
      apiKeyId: input.apiKeyId ?? null,
      apiKeyPrefix: input.apiKeyPrefix ?? null,
      runtimeModelId: input.requestedRuntimeModelId ?? null,
      poolId: input.requestedPoolId ?? null,
      external: input.external ?? false,
      sidecarLatencyMs: input.transformerLatencyMs ?? null,
      requestedSurface: input.requestedSurface,
      operation: input.operation ?? null,
      requestBytes: input.requestBytes == null ? null : BigInt(input.requestBytes),
      contextTokenCount: input.contextCount?.tokens ?? null,
      contextCountMethod: input.contextCount?.method ?? null,
      contextCountExact: input.contextCount?.exact ?? null,
      route: routeColumn(input.fallbackRoute),
      status: "PENDING",
    },
    select: { id: true },
  });
  reportRelayRequestCreated(row.id);
  return row.id;
}

function requesterFromToken(token: ApiKeyIdentity): RelayRequester {
  return {
    userId: token.userId,
    source: "API_KEY",
    limitKey: token.id,
    apiKeyId: token.id,
    apiKeyPrefix: token.lookupPrefix,
  };
}

/** A signed-in person's Test page request, or an agent's model test (MCP). */
function requesterFromChatTestUser(
  userId: string,
  source: "TEST" | "AGENT_TEST" = "TEST",
): RelayRequester {
  return {
    userId,
    source,
    limitKey: `chat-test:${userId}`,
    apiKeyId: null,
    apiKeyPrefix: null,
    exposeTransformDebug: true,
  };
}

/**
 * Records what request compatibility did to a request (field names, rewrites, stripped
 * headers, whether a learned fix retried it); nothing when it changed nothing. Best effort.
 */
async function writeCompatTrace(relayRequestId: string, trace: CompatTrace): Promise<void> {
  const data = compatTraceData(trace);
  if (!data) return;
  await prisma.relayRequest
    .updateMany({ where: { id: relayRequestId }, data: { compat: data } })
    .catch(metadataUpdateError);
}

async function updateRelayMetadata(relayRequestId: string, update: RelayMetadataUpdate) {
  // The request's completion facts are captured ONCE, here, when its outcome
  // is known: completion time, duration, and the parsed usage counts. A local
  // finalization that only commits on a later registry retry reuses them, so
  // a retry never moves the completion time, inflates the latency, or shifts
  // the rollup bucket, and the retained closure holds only compact facts.
  const completedAt = new Date();
  const failure = update.terminal.failure ?? update.fallbackFailure ?? null;
  // Usage is parsed once from the executor's retained response windows
  // (falling back to CLI-normalized usage): here, or by a caller that also
  // needs it and passes the facts in. Counts only.
  const executionInstance = update.execution?.instance ?? update.localExecution?.instance;
  // Engines that report no usage (some never do; others only when asked) get an estimate,
  // marked as such and never counted as known usage.
  const usage = withEstimatedUsage(
    update.usage ?? usageFactsFromRelayTerminal(update.terminal),
    update.terminal,
    update.localExecution?.contextCount?.tokens,
  );
  const relayData = {
    status: update.status,
    completedAt,
    durationMs: Math.max(0, completedAt.getTime() - update.startedAt.getTime()),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    usageKnown: usage.usageKnown,
    usageEstimated: usage.usageEstimated,
    httpStatusCode:
      update.terminal.httpStatusCode ?? (failure ? relayFailureHttpStatus(failure) : null),
    upstreamStatusCode: update.terminal.upstreamStatusCode,
    upstreamErrorExcerpt: update.terminal.upstreamErrorExcerpt ?? null,
    requestBytes: BigInt(update.terminal.requestBytes),
    responseBytes: BigInt(update.terminal.responseBytes),
    ...(update.rejection !== undefined ? { rejection: update.rejection } : {}),
    ...(update.attemptCount !== undefined ? { attemptCount: update.attemptCount } : {}),
    ...(update.affinity
      ? {
          affinityOutcome: update.affinity.outcome,
          affinityScore: update.affinity.score,
          affinityPrefixDepth: update.affinity.prefixDepth,
          ...(update.affinity.waitMs !== undefined
            ? { affinityWaitMs: update.affinity.waitMs }
            : {}),
        }
      : {}),
    ...(update.execution?.selectedExecutionTargetId
      ? { selectedTargetId: update.execution.selectedExecutionTargetId }
      : {}),
    ...(executionInstance
      ? {
          selectedInstanceId: executionInstance.id,
          selectedVersionId: executionInstance.versionId,
          selectedNodeId: executionInstance.nodeId,
        }
      : {}),
    errorClass: failure,
    ...(update.transformerLatencyMs !== undefined
      ? { sidecarLatencyMs: update.transformerLatencyMs }
      : {}),
    ...(update.fallbackRoute ? { route: routeColumn(update.fallbackRoute) } : {}),
    ...(update.routeIdentity ? routeIdentityData(update.routeIdentity) : {}),
  };
  if (update.localExecution && update.userId) {
    const localTerminal = update.localTerminal ?? update.terminal;
    // Two independent claims, each with exactly one guard:
    //  - the ATTEMPT row claim (ACTIVE -> terminal, own epoch) gates only the
    //    attempt's terminal event, so the event is written at most once;
    //  - the REQUEST transition is claimed solely by its own status guard
    //    (`transitionRelayRequestTerminal`, PENDING -> terminal + rollup).
    // The request transition is deliberately NOT gated on winning the attempt
    // claim: losing it means another writer (an earlier `recordLocalTerminal`
    // of this attempt, or crash repair) already finalized the ATTEMPT, which
    // says nothing about the REQUEST. Crash repair transitions the request
    // itself, so the guarded transition is then a no-op; otherwise this call
    // is the request's only finalizer and must not skip it.
    await runLocalAttemptFinalization(
      update.localExecution.localAttemptId,
      localFinalization({
        attempt: localAttemptTerminalFacts(
          relayRequestId,
          update.userId,
          update.localExecution,
          localTerminal,
          completedAt,
        ),
        request: { relayRequestId, data: relayData, completedAt },
      }),
    );
    return;
  }
  await prisma.$transaction((tx) =>
    transitionRelayRequestTerminal(tx, relayRequestId, relayData, completedAt),
  );
}

/** Attempt event sequence numbers: one row per lifecycle step, so writes are idempotent. */
const ATTEMPT_EVENT_SEQUENCE = { started: 1, first_byte: 2, terminal: 3 } as const;

/**
 * Compact, buffer-free facts of one local attempt's terminal, computed once
 * when the terminal is known. Finalization closures (which the in-flight
 * registry may retain for retries) capture only these, never the terminal
 * itself, whose `usageSample` holds up to ~1 MiB of response windows.
 */
type LocalAttemptTerminalFacts = {
  attemptId: string;
  state: "COMPLETED" | "FAILED" | "CANCELLED";
  terminalAt: Date;
  data: ReturnType<typeof localTerminalAttemptData>;
  event: ReturnType<typeof localTerminalEventData>;
};

function attemptState(
  status: "SUCCEEDED" | "FAILED" | "CANCELED",
): "COMPLETED" | "FAILED" | "CANCELLED" {
  if (status === "SUCCEEDED") return "COMPLETED";
  return status === "CANCELED" ? "CANCELLED" : "FAILED";
}

function localAttemptTerminalFacts(
  relayRequestId: string,
  userId: string,
  execution: LocalExecutionTelemetry,
  terminal: RelayAttemptTerminal,
  terminalAt: Date,
): LocalAttemptTerminalFacts {
  return {
    attemptId: execution.localAttemptId,
    state: attemptState(terminalStatus(terminal)),
    terminalAt,
    data: localTerminalAttemptData(terminal),
    event: localTerminalEventData(relayRequestId, userId, execution, terminal),
  };
}

type LocalRequestTransition = {
  relayRequestId: string;
  data: Parameters<typeof transitionRelayRequestTerminal>[2];
  completedAt: Date;
};

/**
 * Builds a local attempt's finalization transaction from precomputed facts:
 * claims the attempt row (own epoch, ACTIVE -> terminal) and writes its
 * terminal event only on winning that claim; with `request`, also performs
 * the request's guarded PENDING -> terminal transition + rollup.
 * Re-running the returned closure is idempotent and reuses the same facts.
 */
function localFinalization({
  attempt,
  request,
}: {
  attempt: LocalAttemptTerminalFacts;
  request?: LocalRequestTransition;
}) {
  return () =>
    prisma.$transaction(async (tx) => {
      const claimed = await tx.attempt.updateMany({
        where: {
          id: attempt.attemptId,
          ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH,
          state: "ACTIVE",
        },
        data: {
          state: attempt.state,
          terminalAt: attempt.terminalAt,
          ...attempt.data,
        },
      });
      if (claimed.count > 0)
        await tx.attemptEvent.createMany({ data: [attempt.event], skipDuplicates: true });
      if (request)
        await transitionRelayRequestTerminal(
          tx,
          request.relayRequestId,
          request.data,
          request.completedAt,
        );
    });
}

async function updateContextCountMetadata(
  relayRequestId: string,
  contextCount: ContextCountTelemetry,
) {
  await prisma.relayRequest.update({
    where: { id: relayRequestId },
    data: {
      contextTokenCount: contextCount.tokens,
      contextCountMethod: contextCount.method,
      contextCountExact: contextCount.exact,
    },
  });
}

type LocalExecutionTelemetry = NonNullable<RelayMetadataUpdate["execution"]> & {
  requestedSurface: string;
  /** Pool requests: a local attempt starting decides the "local" route. */
  fallbackRoute?: FallbackRoute;
  attemptKind?: "EXECUTION" | "CONTEXT_COUNT";
  poolId?: string;
  contextCount?: ContextCountTelemetry;
  admission?: {
    attemptId: string;
    leaseId: string;
    fencingToken: bigint;
    waitDurationMs?: number;
  };
};

function attemptPurpose(execution: LocalExecutionTelemetry): "EXECUTION" | "COUNT" {
  return execution.attemptKind === "CONTEXT_COUNT" ? "COUNT" : "EXECUTION";
}

async function startLocalExecutionTelemetry(
  relayRequestId: string,
  userId: string,
  execution: LocalExecutionTelemetry,
) {
  // Held (heartbeated) from before its row exists until its finalization
  // commits; see the liveness predicate in relay-telemetry-recovery.ts.
  trackLocalRelayAttempt(execution.localAttemptId, relayRequestId);
  await prisma.$transaction(async (tx) => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!clock) throw new Error("Database clock query returned no row");
    const now = clock.now;
    await tx.attempt.create({
      data: {
        id: execution.localAttemptId,
        userId,
        requestId: relayRequestId,
        kind: "LOCAL",
        purpose: attemptPurpose(execution),
        ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH,
        // Local attempts are fenced by their owner epoch; the token matters for cloud.
        fencingToken: 0n,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + LOCAL_RELAY_ATTEMPT_TTL_MS),
        requestedSurface: execution.requestedSurface,
        nativeSurface: execution.nativeSurface,
        adapterMode: execution.adapterMode,
        adapterVersion: execution.adapterVersion ?? null,
        poolId: execution.poolId ?? null,
        poolMemberId: execution.selectedPoolMemberId ?? null,
        targetId: execution.selectedExecutionTargetId ?? null,
        instanceId: execution.instance?.id ?? null,
        versionId: execution.instance?.versionId ?? null,
        nodeId: execution.instance?.nodeId ?? null,
        admissionLeaseId: execution.admission?.leaseId ?? null,
        queueWaitMs: execution.admission?.waitDurationMs ?? null,
        contextTokens: execution.contextCount?.tokens ?? null,
      },
    });
    await tx.attemptEvent.create({
      data: {
        userId,
        attemptId: execution.localAttemptId,
        requestId: relayRequestId,
        sequence: ATTEMPT_EVENT_SEQUENCE.started,
        eventType: "dispatched",
        metadata: {
          ...(execution.contextCount
            ? {
                contextCountMethod: execution.contextCount.method,
                contextCountConfidence: execution.contextCount.confidence,
              }
            : {}),
          ...(execution.admission ? { admissionAttemptId: execution.admission.attemptId } : {}),
        },
      },
    });
    if (execution.attemptKind === "CONTEXT_COUNT") return;
    await tx.relayRequest.update({
      where: { id: relayRequestId },
      data: {
        ...(execution.selectedExecutionTargetId
          ? { selectedTargetId: execution.selectedExecutionTargetId }
          : {}),
        ...(execution.instance
          ? {
              selectedInstanceId: execution.instance.id,
              selectedVersionId: execution.instance.versionId,
              selectedNodeId: execution.instance.nodeId,
            }
          : {}),
        ...(execution.fallbackRoute ? { route: routeColumn(execution.fallbackRoute) } : {}),
      },
      select: { id: true },
    });
  });
}

async function recordLocalTerminal(
  relayRequestId: string,
  userId: string,
  execution: LocalExecutionTelemetry,
  terminal: RelayAttemptTerminal,
) {
  // Attempt-only finalization: never transitions the RelayRequest. Callers
  // use it for attempts that are NOT the request's last word (a retried pool
  // member, a context-count side attempt, or an attempt followed by a
  // separate non-local request finalizer). When the attempt IS the request's
  // outcome, call `updateRelayMetadata` with `localExecution` instead, which
  // claims the attempt and transitions the request together; calling both
  // for one attempt would make two claimants of one attempt row.
  await runLocalAttemptFinalization(
    execution.localAttemptId,
    localFinalization({
      attempt: localAttemptTerminalFacts(relayRequestId, userId, execution, terminal, new Date()),
    }),
  );
}

function localTerminalAttemptData(terminal: RelayAttemptTerminal) {
  return {
    terminalReason: terminal.failure ?? null,
    httpStatusCode: terminal.httpStatusCode,
    upstreamStatusCode: terminal.upstreamStatusCode,
    errorClass: terminal.failure ?? null,
    promptTokens: terminal.usage?.promptTokens ?? null,
    completionTokens: terminal.usage?.completionTokens ?? null,
    usageSource: terminal.usage ? "CLI_NORMALIZED" : null,
    requestBytes: BigInt(terminal.requestBytes),
    responseBytes: BigInt(terminal.responseBytes),
  };
}

function localTerminalEventData(
  relayRequestId: string,
  userId: string,
  execution: LocalExecutionTelemetry,
  terminal: RelayAttemptTerminal,
) {
  return {
    userId,
    attemptId: execution.localAttemptId,
    requestId: relayRequestId,
    sequence: ATTEMPT_EVENT_SEQUENCE.terminal,
    eventType: "terminal",
    reason: terminal.failure ?? terminalStatus(terminal).toLowerCase(),
  };
}

async function markLocalFirstClientByte(
  relayRequestId: string,
  userId: string,
  execution: LocalExecutionTelemetry,
) {
  await prisma.$transaction(async (tx) => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!clock) throw new Error("Database clock query returned no row");
    const now = clock.now;
    const claimed = await tx.attempt.updateMany({
      where: {
        id: execution.localAttemptId,
        ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH,
        state: "ACTIVE",
      },
      data: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + LOCAL_RELAY_ATTEMPT_TTL_MS),
        firstByteAt: now,
        streamCommitted: true,
      },
    });
    if (claimed.count === 0) {
      const ownedTerminal = await tx.attempt.findFirst({
        where: {
          id: execution.localAttemptId,
          ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH,
          state: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
        },
        select: { id: true },
      });
      if (!ownedTerminal) return;
    }
    await tx.attemptEvent.createMany({
      data: [
        {
          userId,
          attemptId: execution.localAttemptId,
          requestId: relayRequestId,
          sequence: ATTEMPT_EVENT_SEQUENCE.first_byte,
          eventType: "first_byte",
        },
      ],
      skipDuplicates: true,
    });
    await tx.relayRequest.updateMany({
      where: { id: relayRequestId, firstClientByteAt: null },
      data: { firstClientByteAt: now },
    });
  });
}

/** Adds one admission's queue wait to the request's total (RelayRequest.queueWaitMs). */
async function updateAdmissionMetadata(relayRequestId: string, waitDurationMs: number) {
  const waitMs = Math.max(0, Math.floor(waitDurationMs));
  const row = await prisma.relayRequest.findUnique({
    where: { id: relayRequestId },
    select: { queueWaitMs: true },
  });
  await prisma.relayRequest.update({
    where: { id: relayRequestId },
    data: { queueWaitMs: (row?.queueWaitMs ?? 0) + waitMs },
    select: { id: true },
  });
}

async function acquireCapacityWithTelemetry({
  runtime,
  relayRequestId,
  attempt,
  signal,
}: {
  runtime: CapacityAdmissionRuntime;
  relayRequestId: string;
  attempt: Parameters<CapacityAdmissionRuntime["acquire"]>[0];
  signal: AbortSignal;
}) {
  const waitingStartedAt = Date.now();
  try {
    const result = await runtime.acquire(attempt, signal);
    try {
      await updateAdmissionMetadata(relayRequestId, Date.now() - waitingStartedAt);
    } catch (error) {
      if (result.state === "ADMITTED") await runtime.release(result.lease);
      throw error;
    }
    return result;
  } catch (error) {
    await updateAdmissionMetadata(relayRequestId, Date.now() - waitingStartedAt).catch(
      metadataUpdateError,
    );
    throw error;
  }
}

function terminalStatus(terminal: RelayAttemptTerminal): "SUCCEEDED" | "FAILED" | "CANCELED" {
  if (terminal.failure === "cancelled") return "CANCELED";
  return terminal.ok ? "SUCCEEDED" : "FAILED";
}

/**
 * Request status when the client is served an ERROR response for this
 * attempt. The attempt itself may have succeeded upstream (e.g. a body-less
 * response whose capacity release then failed); the request did not.
 */
function servedFailureStatus(terminal: RelayAttemptTerminal): "FAILED" | "CANCELED" {
  return terminal.failure === "cancelled" ? "CANCELED" : "FAILED";
}

async function failRelayMetadata({
  relayRequestId,
  startedAt,
  failure,
  selectedRuntimeModelId,
  transformerLatencyMs,
  attemptCount,
  requestBytes,
  responseBytes,
  localExecution,
  userId,
  localTerminal,
  fallbackRoute,
  routeIdentity,
  httpStatusCode,
  upstreamStatusCode,
  rejection,
  upstreamErrorExcerpt,
}: {
  relayRequestId: string;
  startedAt: Date;
  failure: ModelApiFailure;
  selectedRuntimeModelId?: string;
  transformerLatencyMs?: number | null;
  attemptCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  localExecution?: LocalExecutionTelemetry;
  userId?: string;
  localTerminal?: RelayAttemptTerminal;
  fallbackRoute?: FallbackRoute;
  routeIdentity?: RouteIdentity;
  httpStatusCode?: number;
  upstreamStatusCode?: number;
  /** Overrides the refusal reason derived from `failure` (refusals without an upstream). */
  rejection?: string | null;
  /** The last runtime error answer of this request (default: `localTerminal`'s). */
  upstreamErrorExcerpt?: string | null;
}) {
  if (requestBytes !== undefined) {
    await prisma.relayRequest.update({
      where: { id: relayRequestId },
      data: { requestBytes: BigInt(requestBytes) },
      select: { id: true },
    });
  }
  await updateRelayMetadata(relayRequestId, {
    selectedRuntimeModelId,
    status: failure === "cancelled" ? "CANCELED" : "FAILED",
    startedAt,
    fallbackFailure: failure,
    // A failure after an upstream attempt is not a refusal.
    rejection:
      rejection !== undefined
        ? rejection
        : localExecution || upstreamStatusCode !== undefined
          ? null
          : rejectionForFailure(failure),
    transformerLatencyMs,
    attemptCount,
    localExecution,
    userId,
    localTerminal,
    fallbackRoute,
    routeIdentity,
    terminal: {
      ok: false,
      failure,
      httpStatusCode: httpStatusCode ?? relayFailureHttpStatus(failure),
      upstreamStatusCode: upstreamStatusCode ?? null,
      usage: null,
      metrics: null,
      responseBytes: responseBytes ?? 0,
      requestBytes: requestBytes ?? 0,
      upstreamErrorExcerpt: upstreamErrorExcerpt ?? localTerminal?.upstreamErrorExcerpt ?? null,
    },
  });
}

function metadataUpdateError(error: unknown) {
  void error;
  console.warn("[model-api] relay metadata update failed");
}

function responseStickinessDigest({
  requester,
  responseId,
}: {
  requester: RelayRequester;
  responseId: string;
}): string {
  // Derive the sticky-routing digest through the shared forwarder-security
  // purpose key (itself derived from BETTER_AUTH_SECRET) instead of hashing the
  // secret inline. Same rotation semantics; keeps all HMAC purposes in one place.
  //
  // MIGRATION NOTE: the digest format changed from an inline hex HMAC to this
  // purpose-derived base64url form. Sticky rows written by a pre-change build
  // therefore won't match the digest computed post-deploy — a one-time miss that
  // simply falls back to normal (non-sticky) routing for that request. This is
  // intentionally accepted: the stale rows self-heal by expiring naturally via
  // their TTL (RESPONSES_STICKINESS_TTL_MS); no migration or backfill is needed.
  return hmacDigestForPurpose({
    purpose: "responsesStickiness",
    value: `${requester.userId}:${requester.apiKeyId ?? "session"}:${responseId}`,
  });
}

function upstreamResponseIdDigest(responseId: string): string {
  return hmacDigestForPurpose({
    purpose: "responsesStickinessUpstreamId",
    value: responseId,
  });
}

async function writeProviderResponseStickiness(input: {
  requester: RelayRequester;
  responseId: string;
  targetPoolId: string;
  executionTargetId: string;
  providerAccountId: string;
  providerModelId: string;
  endpointIdentity: string;
  endpointVersion: number;
  upstreamModelId: string;
  shareId: string | null;
  ownKey?: boolean;
}) {
  const routingKeyDigest = responseStickinessDigest(input);
  const binding = {
    apiKeyId: input.requester.apiKeyId,
    poolId: input.targetPoolId,
    selectedTargetId: input.executionTargetId,
    providerAccountId: input.providerAccountId,
    providerModelId: input.providerModelId,
    providerEndpointIdentity: input.endpointIdentity,
    providerEndpointVersion: input.endpointVersion,
    providerUpstreamModelId: input.upstreamModelId,
    shareId: input.shareId,
    nativeSurface: "OPENAI_RESPONSES",
    upstreamResponseIdDigest: upstreamResponseIdDigest(input.responseId),
    // Provider bindings exist only for consented `owner/pool:external`
    // requests (tryPublicOverflow and bound follow-ups).
    route: input.ownKey ? "own_key" : "cloud",
    warmSessionId: null,
    warmBindingDigest: null,
    warmRootDigest: null,
    warmTipDigest: null,
    warmTipDepth: null,
    warmCanonicalBytes: null,
    warmEstimatedTokens: null,
    expiresAt: new Date(Date.now() + RESPONSES_STICKINESS_TTL_MS),
  };
  await prisma.responseStickinessRecord.upsert({
    where: {
      userId_routingKeyDigest: { userId: input.requester.userId, routingKeyDigest },
    },
    create: { userId: input.requester.userId, routingKeyDigest, ...binding },
    // Submit the complete tuple on conflict, so a refresh can never keep part of an older
    // binding.
    update: binding,
    select: { id: true },
  });
}

/**
 * Binds a stored local response to the target that produced it. A TEST binding has no pool;
 * a pool binding is tied to the exact share a grantee reached the pool through.
 */
async function writeResponseStickiness({
  requester,
  responseId,
  targetPoolId,
  shareId,
  selectedExecutionTargetId,
  sessionBinding,
}: ResponseStickinessCapture & {
  responseId: string;
  selectedExecutionTargetId: string;
  sessionBinding?: AffinitySessionBinding | null;
}) {
  const routingKeyDigest = responseStickinessDigest({ requester, responseId });
  const pooled = Boolean(targetPoolId);
  const binding = {
    apiKeyId: requester.apiKeyId,
    poolId: targetPoolId ?? null,
    shareId: pooled ? (shareId ?? null) : null,
    selectedTargetId: selectedExecutionTargetId,
    providerAccountId: null,
    providerModelId: null,
    providerEndpointIdentity: null,
    providerEndpointVersion: null,
    providerUpstreamModelId: null,
    nativeSurface: null,
    upstreamResponseIdDigest: null,
    route: "local",
    warmSessionId: pooled ? (sessionBinding?.sessionId ?? null) : null,
    warmBindingDigest: pooled ? (sessionBinding?.bindingDigest ?? null) : null,
    warmRootDigest: pooled ? (sessionBinding?.rootDigest ?? null) : null,
    warmTipDigest: pooled ? (sessionBinding?.tipDigest ?? null) : null,
    warmTipDepth: pooled ? (sessionBinding?.tipDepth ?? null) : null,
    warmCanonicalBytes: pooled ? (sessionBinding?.canonicalBytes ?? null) : null,
    warmEstimatedTokens: pooled ? (sessionBinding?.estimatedTokens ?? null) : null,
    expiresAt: new Date(Date.now() + RESPONSES_STICKINESS_TTL_MS),
  };
  await prisma.responseStickinessRecord.upsert({
    where: { userId_routingKeyDigest: { userId: requester.userId, routingKeyDigest } },
    create: { userId: requester.userId, routingKeyDigest, ...binding },
    update: binding,
    select: { id: true },
  });
}

function stickinessWriteError(error: unknown) {
  void error;
  console.warn("[model-api] responses stickiness write failed");
}

/**
 * The local Responses binding write for one served attempt, run at most once.
 * It waits for the attempt's terminal and writes the binding only for a
 * successful response whose id was captured. Both the client EOF gate
 * ({@link holdEofUntilDurable}) and the detached finalizer await the same
 * write, so a client that disconnects early still gets its binding.
 */
function localStickinessPersister(input: {
  terminal: Promise<{ ok: boolean }>;
  capture: ReturnType<typeof createResponseIdCapture> | null;
  streaming: boolean;
  write: ((responseId: string) => Promise<void>) | null;
}): (() => Promise<void>) | null {
  const { capture, write } = input;
  if (!capture || !write) return null;
  let persisted: Promise<void> | undefined;
  return () => {
    persisted ??= (async () => {
      const terminal = await input.terminal;
      if (!terminal.ok) return;
      const responseId = capture.finish(input.streaming);
      if (responseId) await write(responseId);
    })();
    return persisted;
  };
}

/**
 * Holds the client-visible end of a successful response until `durable`
 * settles, as the provider path does (captureProviderResponseBinding): a
 * follow-up sent as soon as EOF is observed can then never race the binding
 * row. If the write fails, the stream errors instead of ending cleanly, so
 * the client never sees a completed response it cannot continue.
 */
function holdEofUntilDurable(
  body: ReadableStream<Uint8Array>,
  durable: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      try {
        await durable();
      } catch (error) {
        stickinessWriteError(error);
        controller.error(new Error("Response routing metadata could not be persisted"));
        return;
      }
      controller.close();
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

function reportCleanupFailures(results: readonly PromiseSettledResult<unknown>[]) {
  const failures = results.filter(({ status }) => status === "rejected").length;
  if (failures) console.warn(`[model-api] ${failures} relay cleanup operation(s) failed`);
}

async function settleRelayCleanup(tasks: readonly (() => unknown | PromiseLike<unknown>)[]) {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  reportCleanupFailures(results);
}

function rejectedRelayTerminal(failure: ModelApiFailure = "unknown"): RelayAttemptTerminal {
  return {
    ok: false,
    failure,
    httpStatusCode: relayFailureHttpStatus(failure),
    upstreamStatusCode: null,
    usage: null,
    metrics: null,
    responseBytes: 0,
    requestBytes: 0,
  };
}

function extractResponseIdFromJson(value: unknown): string | null {
  if (!isJsonObject(value)) return null;
  const directId = value.id;
  if (typeof directId === "string" && directId.trim().length > 0) {
    const object = value.object;
    const type = value.type;
    if (
      object === "response" ||
      (typeof object === "string" && object.startsWith("response.")) ||
      (typeof type === "string" && type.startsWith("response."))
    ) {
      return directId;
    }
  }

  const nestedResponse = value.response;
  if (isJsonObject(nestedResponse)) {
    const nestedId = nestedResponse.id;
    if (typeof nestedId === "string" && nestedId.trim().length > 0) {
      return nestedId;
    }
  }

  return null;
}

function createResponseIdCapture() {
  let responseId: string | null = null;
  let captured = "";
  let sseBuffer = "";
  const decoder = new TextDecoder();

  function tryJson(text: string) {
    if (responseId) return;
    try {
      responseId = extractResponseIdFromJson(JSON.parse(text));
    } catch {
      // Response chunks may split JSON/SSE frames. Incomplete text is retried later.
    }
  }

  function processSseLine(line: string) {
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") return;
    tryJson(data);
  }

  return {
    push(chunk: Uint8Array, streaming: boolean) {
      if (responseId || captured.length >= RESPONSE_ID_CAPTURE_MAX_CHARS) return;
      const text = decoder.decode(chunk, { stream: true });
      if (!streaming) {
        captured = `${captured}${text}`.slice(0, RESPONSE_ID_CAPTURE_MAX_CHARS);
        return;
      }

      sseBuffer = `${sseBuffer}${text}`;
      let newlineIndex = sseBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = sseBuffer.slice(0, newlineIndex).trimEnd();
        sseBuffer = sseBuffer.slice(newlineIndex + 1);
        processSseLine(line);
        if (responseId) return;
        newlineIndex = sseBuffer.indexOf("\n");
      }
    },
    finish(streaming: boolean) {
      if (!responseId && streaming && sseBuffer) {
        processSseLine(sseBuffer.trimEnd());
      }
      if (!responseId && !streaming && captured) {
        tryJson(captured);
      }
      return responseId;
    },
  };
}

export function captureProviderResponseBinding(input: {
  response: Response;
  streaming: boolean;
  requester: RelayRequester;
  targetPoolId: string;
  shareId: string | null;
  target: {
    executionTargetId: string;
    providerAccountId: string;
    providerModelId: string;
    endpointIdentity: string;
    endpointVersion: number;
    upstreamModelId: string;
    ownKey?: boolean;
  };
  terminal: Promise<{ ok: boolean }>;
}): Response {
  if (!input.response.body || input.response.status < 200 || input.response.status >= 300)
    return input.response;
  const reader = input.response.body.getReader();
  const capture = createResponseIdCapture();
  let finished = false;
  const persist = async () => {
    if (finished) return;
    finished = true;
    const responseId = capture.finish(input.streaming);
    const terminal = await input.terminal;
    if (!terminal.ok) throw new Error("Provider response did not complete successfully");
    if (!responseId) throw new Error("Provider response did not include a response id");
    try {
      await writeProviderResponseStickiness({
        requester: input.requester,
        responseId,
        targetPoolId: input.targetPoolId,
        shareId: input.shareId,
        ...input.target,
      });
    } catch (error) {
      stickinessWriteError(error);
      throw new Error("Response routing metadata could not be persisted");
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await persist();
          // The successful upstream response is not observably complete until
          // its correctness-required binding is durable. A follow-up issued as
          // soon as EOF is observed can therefore never race the database row.
          controller.close();
          return;
        }
        capture.push(next.value, input.streaming);
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  });
}

async function resolveStickyRoute({
  requester,
  responseId,
  targets,
}: {
  requester: RelayRequester;
  responseId: string;
  targets: {
    tests: TestTarget[];
    pools: CallablePool[];
  };
}): Promise<StickyRoute | Response> {
  const routingKeyDigest = responseStickinessDigest({ requester, responseId });
  const record = await prisma.responseStickinessRecord.findUnique({
    where: {
      userId_routingKeyDigest: {
        userId: requester.userId,
        routingKeyDigest,
      },
    },
    select: {
      userId: true,
      warmSessionId: true,
      warmBindingDigest: true,
      warmRootDigest: true,
      warmTipDigest: true,
      warmTipDepth: true,
      warmCanonicalBytes: true,
      warmEstimatedTokens: true,
      apiKeyId: true,
      poolId: true,
      selectedTargetId: true,
      providerAccountId: true,
      providerModelId: true,
      providerEndpointIdentity: true,
      providerEndpointVersion: true,
      providerUpstreamModelId: true,
      nativeSurface: true,
      upstreamResponseIdDigest: true,
      route: true,
      shareId: true,
      expiresAt: true,
    },
  });
  // Routing is kept for a stored response (or a follow-up) only, for
  // RESPONSES_STICKINESS_TTL_MS: anything else was never stored, so say that rather than
  // "expired" (docs/external-fallback.md, "Stored responses").
  const unavailable = storedResponseUnavailable(record, requester, new Date());
  if (unavailable !== null || !record?.selectedTargetId)
    return openAiFailureJsonResponse("not_found", unavailable ?? RESPONSE_NOT_STORED_MESSAGE);
  // Stickiness is hot-path history (@ws-model-proxy/db/capacity-lock-order):
  // it names its share and target by plain id, with no foreign key. A
  // deleted share or target simply is not found, which fails closed below.
  const [share, selectedTarget] = await Promise.all([
    record.shareId
      ? prisma.share.findUnique({
          where: { id: record.shareId },
          select: { id: true, poolId: true, ownerUserId: true, granteeUserId: true, canUse: true },
        })
      : null,
    prisma.executionTarget.findUnique({
      where: { id: record.selectedTargetId },
      select: { id: true, runtimeModelId: true },
    }),
  ]);
  // Honor a pool binding only through the access that created it: the owner's own (no
  // share), or the grantee's same live share. A replaced share never resurrects an older
  // binding.
  const sameAccess = (visibleTarget: CallablePool) => {
    const recordShareId = record.shareId ?? null;
    if (visibleTarget.shareId !== recordShareId) return false;
    if (recordShareId === null) return visibleTarget.ownerUserId === requester.userId;
    return (
      share?.id === recordShareId &&
      share.canUse &&
      share.poolId === visibleTarget.id &&
      share.ownerUserId === visibleTarget.ownerUserId &&
      share.granteeUserId === requester.userId
    );
  };

  if (record.route === "cloud" || record.route === "own_key") {
    const visibleTarget = record.poolId
      ? (targets.pools.find((target) => target.id === record.poolId) ?? null)
      : null;
    if (
      !visibleTarget ||
      !sameAccess(visibleTarget) ||
      record.upstreamResponseIdDigest !== upstreamResponseIdDigest(responseId)
    )
      return openAiFailureJsonResponse(
        "not_found",
        "This stored response is no longer accessible with this API key.",
      );
    if (
      !record.providerAccountId ||
      !record.providerModelId ||
      !record.providerEndpointIdentity ||
      !record.providerEndpointVersion ||
      !record.providerUpstreamModelId ||
      record.nativeSurface !== "OPENAI_RESPONSES"
    )
      return openAiFailureJsonResponse("not_found", "Response routing metadata is incomplete.");
    return {
      target: "PROVIDER",
      route: record.route === "own_key" ? "own-key" : "pool-external",
      visibleTarget,
      binding: {
        executionTargetId: record.selectedTargetId,
        providerAccountId: record.providerAccountId,
        providerModelId: record.providerModelId,
        endpointIdentity: record.providerEndpointIdentity,
        endpointVersion: record.providerEndpointVersion,
        upstreamModelId: record.providerUpstreamModelId,
      },
    };
  }

  const selectedRuntimeModelId = selectedTarget?.runtimeModelId ?? null;
  if (!selectedTarget || !selectedRuntimeModelId)
    return openAiFailureJsonResponse("not_found", "Response routing target no longer exists.");

  if (!record.poolId) {
    const visibleTarget =
      targets.tests.find((target) => target.id === selectedRuntimeModelId) ?? null;
    if (!visibleTarget) {
      return openAiFailureJsonResponse(
        "access_denied",
        "Response routing metadata is no longer accessible.",
      );
    }
    return {
      target: "TEST",
      visibleTarget,
      selectedRuntimeModelId,
      selectedExecutionTargetId: selectedTarget.id,
    };
  }

  const visibleTarget = targets.pools.find((target) => target.id === record.poolId) ?? null;
  // A pool no longer visible (share lost, or #76 owner banned or deletion-marked) is not
  // found, as at arrival and for provider bindings; a visible pool reached through different
  // access than the binding's is access_denied (#95).
  if (!visibleTarget) {
    return openAiFailureJsonResponse(
      "not_found",
      "Response routing metadata is no longer accessible.",
    );
  }
  if (!sameAccess(visibleTarget)) {
    return openAiFailureJsonResponse(
      "access_denied",
      "Response routing metadata is no longer accessible.",
    );
  }
  return {
    target: "POOL",
    visibleTarget,
    selectedRuntimeModelId,
    selectedExecutionTargetId: selectedTarget.id,
    sessionBinding:
      record.warmSessionId &&
      record.warmBindingDigest &&
      record.warmRootDigest &&
      record.warmTipDigest &&
      record.warmTipDepth !== null &&
      record.warmCanonicalBytes !== null
        ? {
            sessionId: record.warmSessionId,
            bindingDigest: record.warmBindingDigest,
            rootDigest: record.warmRootDigest,
            tipDigest: record.warmTipDigest,
            tipDepth: record.warmTipDepth,
            canonicalBytes: record.warmCanonicalBytes,
            estimatedTokens: record.warmEstimatedTokens ?? undefined,
          }
        : undefined,
  };
}

/**
 * The TEST route for one of the caller's own served models: the pinned instance when the Test
 * page names one (`x-wsmp-instance`), else the first ready instance on an online node, else
 * the first instance (which then fails as disconnected).
 */
async function directModelRow(
  runtimeModelId: string,
  ownerUserId: string,
  instanceId?: string | null,
): Promise<DirectModelRelayRow | null> {
  const routes = (await testRoutes(runtimeModelId, ownerUserId)).filter(hasHeadNode);
  const route = instanceId
    ? routes.find((candidate) => candidate.instance.id === instanceId)
    : (routes.find((candidate) => candidate.instance.ready && candidate.instance.nodeOnline) ??
      routes[0]);
  return route ? servedRoute(route) : null;
}

/** Every LOCAL route of a pool (one row per member and instance), in a stable order. */
async function poolMemberRows(poolId: string): Promise<PoolMemberRelayRow[]> {
  return (await poolRoutes(poolId)).filter(hasHeadNode).map(poolMemberRow);
}

/**
 * Early local rejection (#76 owner, #95 share/sticky access,
 * requester re-validation). Every pool-scoped send of a request to a local
 * machine receives an early advisory check here; local-send.ts owns acceptance,
 * after every wait and after any half-open trial claim. Reads current state
 * (JS clock, the same rules as arrival):
 *  - the pool owner is active (`poolOwnerActive`: not banned, not deletion-marked);
 *  - the REQUESTER is not banned or deletion-marked (one extra row read;
 *    none when the requester is the owner);
 *  - the requester still reaches the pool through the exact access the
 *    request was resolved under (the owner with no share, or the grantee's
 *    same share row with canUse: a replacement share is different access);
 *  - the route (when given) is still an ACTIVE member route of the pool.
 * This is an early advisory rejection only; local-send.ts owns actual send authority.
 * No unlocked read can authorize enqueue. A
 * change that commits before these reads is refused; actual dispatch rechecks under locks.
 * A failed read is a denial, never a pass.
 */
type LocalSendInput = {
  embeddingContract?: unknown;
  poolId: string;
  ownerUserId: string;
  requesterUserId: string;
  shareId: string | null;
  /** The route (`PoolMemberRelayRow.id`) about to be used; null for gates that send to none. */
  poolMemberId: string | null;
};
async function earlyLocalSendDenial(input: LocalSendInput): Promise<LocalSendDenial | null> {
  try {
    const requesterIsOwner = input.requesterUserId === input.ownerUserId;
    if (requesterIsOwner !== (input.shareId === null)) return "ACCESS_REVOKED";
    const userAccessRow = (id: string) =>
      prisma.user.findUnique({
        where: { id },
        select: { banned: true, banExpires: true, deletionRequestedAt: true },
      });
    const [owner, requester, share, members] = await Promise.all([
      userAccessRow(input.ownerUserId),
      // The requester row: the one extra read. The owner is read once when
      // it is also the requester.
      requesterIsOwner ? null : userAccessRow(input.requesterUserId),
      input.shareId === null
        ? null
        : prisma.share.findFirst({
            where: {
              id: input.shareId,
              poolId: input.poolId,
              ownerUserId: input.ownerUserId,
              granteeUserId: input.requesterUserId,
              canUse: true,
            },
            select: { id: true },
          }),
      input.poolMemberId === null ? null : poolMemberRows(input.poolId),
    ]);
    const now = new Date();
    if (!owner || !poolOwnerActive(owner, now)) return "OWNER_INACTIVE";
    const requesterRow = requesterIsOwner ? owner : requester;
    if (!requesterRow || userCredentialAccessBlocked(requesterRow, now)) return "REQUESTER_BLOCKED";
    if (input.shareId !== null && share?.id !== input.shareId) return "ACCESS_REVOKED";
    if (input.poolMemberId !== null) {
      const member = members?.find((row) => row.id === input.poolMemberId);
      if (!member?.active) return "MEMBER_UNAVAILABLE";
      if (
        input.embeddingContract &&
        (!embeddingContractsMatch(input.embeddingContract, member.pool.embeddingContract) ||
          !embeddingContractsMatch(input.embeddingContract, member.model.embeddingContract))
      )
        return "MEMBER_UNAVAILABLE";
    }
    return null;
  } catch {
    return "CHECK_FAILED";
  }
}

/** Exact snapshot used by all local sends, including direct and count operations. */
function localSendBinding(
  selected: ContextCountModelRow,
  requester: RelayRequester,
  pool?: LocalSendBinding["pool"],
): LocalSendBinding {
  return {
    requesterUserId: requester.userId,
    apiKeyId: requester.apiKeyId,
    engineOwnerUserId: selected.userId,
    runtimeModelId: selected.id,
    executionTargetId: selected.target.id,
    capacityId: selected.instance.id,
    nodeId: selected.instance.nodeId,
    handle: selected.instance.handle,
    upstreamModelId: selected.upstreamModelId,
    pool,
  };
}

/** A route is serving: an ACTIVE member on a READY instance whose head node is connected. */
function routeIsServing(
  route: { instance: RouteInstance; active?: boolean },
  onlineNodeIds: Set<string>,
): boolean {
  return (
    route.active !== false &&
    route.instance.ready &&
    route.instance.nodeOnline &&
    route.instance.nodeId !== null &&
    onlineNodeIds.has(route.instance.nodeId)
  );
}

/**
 * OpenAI-compatible model list with additive multimodal advertisement fields
 * (supports_vision, capabilities, architecture.input_modalities, …). See
 * `model-list-modalities.ts`. Official OpenAI only requires id/created/object/owned_by.
 * Pools advertise the union of their LOCAL members' served-model capabilities; FULL /
 * saturated pools stay listed (health and KV occupancy are not a hide).
 */
async function modelListResponse(
  targets: CallableTargets,
  external?: {
    requester: RelayRequester;
    onlineNodeIds?: Iterable<string>;
  },
) {
  const onlineNodeIds = new Set(external?.onlineNodeIds ?? []);
  const directFlagsById = new Map<string, ReturnType<typeof multimodalFlagsFromCapabilities>>();
  const servingDirectIds = new Set<string>();
  await Promise.all(
    targets.tests.map(async (test) => {
      const routes = await testRoutes(test.id, test.ownerUserId);
      if (routes.some((route) => routeIsServing(route, onlineNodeIds)))
        servingDirectIds.add(test.id);
      const model = routes[0]?.model;
      directFlagsById.set(
        test.id,
        multimodalFlagsFromCapabilities(
          model ? openAiCapabilitiesFromCoarse(model.capabilities) : null,
        ),
      );
    }),
  );
  const poolFlagsById = new Map<string, ReturnType<typeof multimodalFlagsFromCapabilities>>();
  const servingPoolIds = new Set<string>();
  await Promise.all(
    targets.pools.map(async (pool) => {
      const rows = await poolMemberRows(pool.id);
      if (rows.some((row) => routeIsServing(row, onlineNodeIds))) servingPoolIds.add(pool.id);
      poolFlagsById.set(pool.id, poolModelListFlags(rows));
    }),
  );

  return {
    object: "list" as const,
    data: [
      ...targets.tests.flatMap((model) => {
        if (!servingDirectIds.has(model.id)) return [];
        const flags = directFlagsById.get(model.id) ?? multimodalFlagsFromCapabilities(null);
        return [
          {
            id: model.modelId,
            object: "model" as const,
            created: 0,
            owned_by: model.ownerUserSlug,
            ...openAiModelListExtensions(flags),
          },
        ];
      }),
      ...targets.pools.flatMap((pool) => {
        const flags = poolFlagsById.get(pool.id) ?? multimodalFlagsFromCapabilities(null);
        const entry = (id: string) => ({
          id,
          object: "model" as const,
          created: 0,
          owned_by: pool.ownerUserSlug,
          ...openAiModelListExtensions(flags),
        });
        const plain = servingPoolIds.has(pool.id) ? [entry(pool.modelId)] : [];
        // `owner/pool:external` is listed only when this caller could be served
        // that way, from static configuration (never live health): switch on,
        // the pool's fallback mode covers this requester, and at least one cloud
        // member (or the requester's own key) is configured. No provider labels
        // or upstream ids are advertised.
        const externalListed =
          external !== undefined &&
          servingPoolIds.has(pool.id) &&
          (pool.externalMemberCount > 0 ||
            Boolean(pool.externalEquivalentModel && pool.ownKeyProviderModelId)) &&
          evaluateExternalEgress({
            requested: true,
            requester: external.requester,
            pool,
          }).granted;
        return externalListed ? [...plain, entry(externalModelId(pool.modelId))] : plain;
      }),
      // The caller's aliases, listed like the pool they name (hard-coded harness names).
      ...(targets.aliases ?? []).flatMap((alias) => {
        const pool = targets.pools.find((candidate) => candidate.id === alias.poolId);
        // A callable ID always wins over an alias of the same name.
        if (targets.pools.some((candidate) => candidate.modelId === alias.name)) return [];
        if (!pool || !servingPoolIds.has(pool.id)) return [];
        const flags = poolFlagsById.get(pool.id) ?? multimodalFlagsFromCapabilities(null);
        return [
          {
            id: alias.name,
            object: "model" as const,
            created: 0,
            owned_by: pool.ownerUserSlug,
            ...openAiModelListExtensions(flags),
          },
        ];
      }),
    ],
  };
}

async function relayDirect({
  request,
  requester,
  target,
  operation,
  manager,
  limiter,
  capacityRuntime,
}: {
  request: Request;
  requester: RelayRequester;
  target: TestTarget;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    source: requester.source,
    apiKeyId: requester.apiKeyId,
    apiKeyPrefix: requester.apiKeyPrefix,
    requestedRuntimeModelId: target.id,
    requestedSurface: telemetrySurfaceForOperation(operation),
    operation: operation.capability,
    requestBytes: null,
    contextCount: operation.contextCount,
  });
  const selected = await directModelRow(
    target.id,
    target.ownerUserId,
    request.headers.get(TEST_INSTANCE_HEADER),
  );
  if (!selected) {
    await operation.dispose?.();
    await failRelayMetadata({ relayRequestId, startedAt, failure: "not_found" });
    return operationFailureResponse(operation, "not_found");
  }
  const capabilities = effectiveDirectCapabilities(selected);
  if (!supportsOperation({ capabilities, operation })) {
    await operation.dispose?.();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unsupported_capability",
      selectedRuntimeModelId: selected.id,
    });
    return operationFailureResponse(operation, "unsupported_capability");
  }
  if (!isEndpointConnected(selected, new Set(manager.getOnlineNodeIds()))) {
    await operation.dispose?.();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "disconnected",
      selectedRuntimeModelId: selected.id,
    });
    return operationFailureResponse(operation, "disconnected");
  }

  if (capacityRuntime && operation.contextInput) {
    try {
      const exactCount = await nativeContextCount({
        request,
        selected,
        operation,
        manager,
        relayRequestId,
        requester,
      });
      if (exactCount) {
        operation.contextCount = exactCount;
        await updateContextCountMetadata(relayRequestId, exactCount);
      }
    } catch (error) {
      await operation.dispose?.();
      const failure = error instanceof LocalSendRefused ? error.failure : "cancelled";
      await failRelayMetadata({ relayRequestId, startedAt, failure });
      return operationFailureResponse(operation, failure);
    }
  }

  let capacityLease: Awaited<ReturnType<CapacityAdmissionRuntime["acquire"]>> | undefined;
  if (capacityRuntime) {
    if (
      operation.contextCount?.exact === true &&
      !contextFitsLimits({
        count: operation.contextCount,
        physicalMaxContext: selected.instance.physicalMaxContext,
        effectiveContextCeiling: null,
        contextMargin: 0,
      })
    ) {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "request_too_large" });
      return contextExceededResponse(
        operation,
        "Request context exceeds the configured execution capacity ceiling.",
        {
          estimatedInputTokens: operation.contextCount.tokens,
          estimateMethod: operation.contextCount.method,
          contextMarginTokens: 0,
          effectiveContextCeilingTokens: effectiveContextCeilingTokens(
            selected.instance.physicalMaxContext,
            null,
          )!,
        },
      );
    }
    try {
      capacityLease = await acquireCapacityWithTelemetry({
        runtime: capacityRuntime,
        relayRequestId,
        attempt: {
          // Every retry gets a unique attemptId while retaining the durable
          // relay request link. AdmissionRequest/Lease rows therefore preserve
          // the full attempt history even though RelayRequest exposes the most
          // recently active admission as a convenience projection.
          requestId: crypto.randomUUID(),
          relayRequestId,
          attemptId: crypto.randomUUID(),
          ownerId: selected.userId,
          sourceKind: "TEST",
          basePriority: NORMAL_PRIORITY_RANK,
          connectionOwner: "model-api",
          deadlineAt: new Date(startedAt.getTime() + MODEL_API_RELAY_TIMEOUT_MS),
          candidates: [
            {
              capacityId: selected.instance.id,
              executionTargetId: selected.target.id,
              candidateOrder: 0,
              // Database-clock budget; 0 admits only if free now.
              waitBudgetMs: null,
            },
          ],
        },
        signal: request.signal,
      });
    } catch {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "unknown" });
      return operationFailureResponse(operation, "unknown");
    }
    if (capacityLease.state === "LEASE_LOST") {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "capacity_lease_lost" });
      return operationFailureResponse(operation, "capacity_lease_lost");
    }
    if (capacityLease.state !== "ADMITTED") {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "rate_limited" });
      return operationFailureResponse(operation, "rate_limited");
    }
  }

  let globalLease: ModelApiLimitLease | undefined;
  let cliLease: ModelApiLimitLease | undefined;
  try {
    globalLease = limiter.acquireGlobal({
      tokenId: requester.limitKey,
      userId: requester.userId,
    });
    cliLease = limiter.acquireCli(selected.instance.nodeId);
  } catch (error) {
    await settleRelayCleanup([
      () => cliLease?.release(),
      () => globalLease?.release(),
      () =>
        capacityLease?.state === "ADMITTED"
          ? capacityRuntime?.release(capacityLease.lease)
          : undefined,
      () => operation.dispose?.(),
    ]);
    if (error instanceof ModelApiLimitError) {
      await failRelayMetadata({
        relayRequestId,
        startedAt,
        failure: error.failure,
        selectedRuntimeModelId: selected.id,
      });
      return operationFailureResponse(operation, error.failure);
    }
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unknown",
      selectedRuntimeModelId: selected.id,
    });
    return operationFailureResponse(operation, "unknown");
  }

  let builtRequest: BuiltRelayRequest;
  try {
    builtRequest = await operation.buildRequest(selected.upstreamModelId);
  } catch {
    await settleRelayCleanup([
      () => cliLease.release(),
      () => globalLease?.release(),
      () =>
        capacityLease?.state === "ADMITTED"
          ? capacityRuntime?.release(capacityLease.lease)
          : undefined,
      () => operation.dispose?.(),
    ]);
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unknown",
      selectedRuntimeModelId: selected.id,
    });
    return operationFailureResponse(operation, "unknown");
  }
  // The runtime's request compatibility (the same policy pools apply).
  const compatLaunch = await compatLaunchFor(selected.instance, selected.model.userId);
  const compatTrace = newCompatTrace();
  const preCompatBuilt = builtRequest;
  let directAttemptCount = 1;
  const finishDirect = async (failure: ModelApiFailure, response: Response) => {
    await settleRelayCleanup([
      () => cliLease.release(),
      () => globalLease?.release(),
      () =>
        capacityLease?.state === "ADMITTED"
          ? capacityRuntime?.release(capacityLease.lease)
          : undefined,
      () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      () => operation.dispose?.(),
    ]);
    await writeCompatTrace(relayRequestId, compatTrace);
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure,
      selectedRuntimeModelId: selected.id,
      attemptCount: directAttemptCount,
    });
    return response;
  };
  const directRefusal = (refusal: CompatRefusal) =>
    finishDirect(
      "unsupported_capability",
      compatRefusalResponse(requestedSurfaceForOperation(operation), refusal),
    );
  const applied = applyCompatToBuilt({
    launch: compatLaunch,
    family: operation.family,
    built: builtRequest,
    clientHeaders: request.headers,
  });
  if (!applied.ok) return directRefusal(applied.refusal);
  builtRequest = applied.built;
  addCompatReport(compatTrace, applied.report);
  let responseIdCapture =
    operation.responseStickiness && operation.family === "responses"
      ? createResponseIdCapture()
      : null;
  let attempt: ReturnType<typeof startRelayAttempt> | null = null;
  let localExecution: LocalExecutionTelemetry = {
    selectedExecutionTargetId: selected.target.id,
    nativeSurface: telemetrySurfaceForOperation(operation),
    requestedSurface: telemetrySurfaceForOperation(operation),
    adapterMode: "NATIVE",
    localAttemptId: crypto.randomUUID(),
    contextCount: operation.contextCount,
    admission:
      capacityLease?.state === "ADMITTED"
        ? {
            attemptId: capacityLease.lease.attemptId,
            leaseId: capacityLease.lease.leaseId,
            fencingToken: capacityLease.lease.fencingToken,
          }
        : undefined,
  };
  const sendDirectAttempt = (execution: LocalExecutionTelemetry, built: BuiltRelayRequest) =>
    startAuthorizedLocalRelayAttempt(localSendBinding(selected, requester), {
      requestId: execution.localAttemptId,
      manager,
      nodeId: selected.instance.nodeId,
      handle: selected.instance.handle,
      family: operation.family,
      method: operation.method,
      path: operation.path,
      headers: built.headers,
      ...relayAttemptBody(built.body),
      timeoutMs: MODEL_API_RELAY_TIMEOUT_MS,
      abortSignal:
        capacityLease?.state === "ADMITTED"
          ? (capacityLease.lease.signal ?? request.signal)
          : request.signal,
      onResponseBodyChunk: responseIdCapture
        ? (chunk) => responseIdCapture?.push(chunk, operation.stream)
        : undefined,
      ...chatCountFirstRelayFields({
        family: operation.family,
        contextCount: operation.contextCount,
        contextInput: operation.contextInput,
        engineCountContext: selected.instance?.engineCountContext,
        physicalMaxContext: selected.instance?.physicalMaxContext,
        effectiveContextCeiling: null,
        contextMargin: 0,
        manager,
        nodeId: selected.instance.nodeId,
        relayRequestId,
        operation,
      }),
    });
  try {
    await startLocalExecutionTelemetry(relayRequestId, requester.userId, localExecution);
    attempt = await sendDirectAttempt(localExecution, builtRequest);
  } catch (error) {
    const failure = error instanceof LocalSendRefused ? error.failure : "unknown";
    attempt?.cancel(failure);
    await settleRelayCleanup([
      () => cliLease.release(),
      () => globalLease?.release(),
      () =>
        capacityLease?.state === "ADMITTED"
          ? capacityRuntime?.release(capacityLease.lease)
          : undefined,
      () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      () => operation.dispose?.(),
    ]);
    // The attempt row may already exist (telemetry committed, dispatch
    // threw): finalize it together with the request, one claimant.
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure,
      selectedRuntimeModelId: selected.id,
      attemptCount: directAttemptCount,
      localExecution,
      userId: requester.userId,
      localTerminal: rejectedRelayTerminal(failure),
    });
    return operationFailureResponse(operation, failure);
  }
  if (!attempt) throw new Error("local relay attempt was not initialized");

  try {
    let started = await attempt.started;
    if (
      (started.status === 400 || started.status === 422) &&
      builtRequest.body instanceof Uint8Array
    ) {
      const peeked = await peekStream(started.body, MAX_COMPAT_ERROR_BYTES);
      const decision = !peeked.complete
        ? null
        : compatRetryDecision({
            launch: compatLaunch,
            family: operation.family,
            status: started.status,
            errorText: decodeUtf8Bytes(peeked.prefix),
            sentBody: builtRequest.body,
            sentHeaders: builtRequest.headers,
          });
      if (decision) {
        const firstTerminal = await attempt.terminal;
        await recordLocalTerminal(
          relayRequestId,
          requester.userId,
          localExecution,
          firstTerminal,
        ).catch(metadataUpdateError);
      }
      if (decision?.kind === "refuse") return await directRefusal(decision.refusal);
      if (decision) {
        const extra: CompatExtra = { fixes: [], stripHeaders: [] };
        if (decision.kind === "learn") extra.fixes.push(decision.fix);
        else extra.stripHeaders.push(decision.name);
        compatTrace.retried = true;
        const reapplied = applyCompatToBuilt({
          launch: compatLaunch,
          family: operation.family,
          built: preCompatBuilt,
          clientHeaders: request.headers,
          extra,
        });
        if (!reapplied.ok) return await directRefusal(reapplied.refusal);
        builtRequest = reapplied.built;
        addCompatReport(compatTrace, reapplied.report);
        directAttemptCount += 1;
        // The first attempt's error must not reach the stored-response capture.
        responseIdCapture =
          operation.responseStickiness && operation.family === "responses"
            ? createResponseIdCapture()
            : null;
        localExecution = { ...localExecution, localAttemptId: crypto.randomUUID() };
        try {
          await startLocalExecutionTelemetry(relayRequestId, requester.userId, localExecution);
          attempt = await sendDirectAttempt(localExecution, builtRequest);
        } catch (error) {
          const failure = error instanceof LocalSendRefused ? error.failure : "unknown";
          await recordLocalTerminal(
            relayRequestId,
            requester.userId,
            localExecution,
            rejectedRelayTerminal(failure),
          ).catch(metadataUpdateError);
          return await finishDirect(failure, operationFailureResponse(operation, failure));
        }
        started = await attempt.started;
        // Remembered for the launch only once the fix worked.
        if (started.status >= 200 && started.status < 300) {
          if (decision.kind === "learn")
            await recordLearnedFix(compatLaunch.key, decision.endpoint, decision.fix);
          else if (decision.remember) await recordLearnedHeader(compatLaunch.key, decision.name);
        }
      } else started = { ...started, body: peeked.body };
    }
    let startedBody = started.body;
    if (started.status >= 400 && started.status < 500) {
      const errorBytes = await readStreamBytes(startedBody);
      const overflow = classifyEngineContextOverflow(started.status, decodeUtf8Bytes(errorBytes));
      if (overflow.overflow) {
        attempt.cancel("request_too_large");
        cliLease.release();
        globalLease.release();
        if (capacityLease?.state === "ADMITTED")
          await capacityRuntime?.release(capacityLease.lease);
        if (!(builtRequest.body instanceof Uint8Array)) await builtRequest.body.dispose();
        await operation.dispose?.();
        await failRelayMetadata({
          relayRequestId,
          startedAt,
          failure: "request_too_large",
          selectedRuntimeModelId: selected.id,
          attemptCount: directAttemptCount,
          localExecution,
          userId: requester.userId,
          localTerminal: rejectedRelayTerminal(),
        });
        return contextExceededResponse(
          operation,
          "Engine rejected the request as exceeding context length.",
          {
            estimatedInputTokens: operation.contextCount?.tokens ?? 0,
            estimateMethod: operation.contextCount?.method ?? "TOKEN_ESTIMATE",
            contextMarginTokens: 0,
            effectiveContextCeilingTokens:
              effectiveContextCeilingTokens(selected.instance.physicalMaxContext, null) ?? 1,
          },
          overflow.snippet,
        );
      }
      startedBody = bytesToReadableStream(errorBytes);
    }
    const stickiness = operation.responseStickiness;
    // The client sees EOF only once this response's binding is durable.
    const persistBinding = localStickinessPersister({
      terminal: attempt.terminal.catch(() => rejectedRelayTerminal()),
      capture: responseIdCapture,
      streaming: operation.stream,
      write: stickiness
        ? (responseId) =>
            writeResponseStickiness({
              ...stickiness,
              responseId,
              targetRuntimeModelId: target.id,
              selectedExecutionTargetId: selected.target.id,
            })
        : null,
    });
    const forwardedBody = responseBodyForOperation({
      body: startedBody,
      headers: started.headers,
      terminal: attempt.terminal,
      operation,
    });
    const responseBody =
      started.status >= 200 && started.status < 300
        ? normalizeNativeResponse({
            body: forwardedBody,
            contentType: started.headers.get("content-type"),
            family: operation.family,
            launch: compatLaunch,
            estimate:
              operation.contextCount !== undefined
                ? { inputTokens: operation.contextCount.tokens }
                : null,
          })
        : forwardedBody;
    void writeCompatTrace(relayRequestId, compatTrace);
    const response = responseWithFirstClientByte(
      new Response(
        persistBinding ? holdEofUntilDurable(responseBody, persistBinding) : responseBody,
        {
          status: started.status,
          headers: started.headers,
        },
      ),
      () => markLocalFirstClientByte(relayRequestId, requester.userId, localExecution),
    );
    const served =
      capacityLease?.state === "ADMITTED" && capacityRuntime
        ? await holdOrReleaseCapacityResponse(
            capacityRuntime,
            response,
            capacityLease.lease,
            request.signal,
          )
        : response;
    // Only now is this attempt definitively the request's outcome (the
    // response goes to the client), so only now is its finalizer scheduled.
    // Anything above that throws lands in the catch below, which is then the
    // attempt's single claimant and records what the client actually got.
    const finalize = attempt.terminal
      .catch(() => rejectedRelayTerminal())
      .then(async (terminal) => {
        if (terminal.ok) {
          recordCalibrationFromUsage(
            selected.instance,
            jsonPayloadFromRelayBody(builtRequest.body) ?? operation.contextInput,
            usageFactsFromRelayTerminal(terminal),
          );
        }
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => cliLease.release()),
          Promise.resolve().then(() => globalLease.release()),
          builtRequest.body instanceof Uint8Array ? Promise.resolve() : builtRequest.body.dispose(),
          operation.dispose?.() ?? Promise.resolve(),
        ]);
        reportCleanupFailures(cleanup);
        await Promise.allSettled([
          updateRelayMetadata(relayRequestId, {
            selectedRuntimeModelId: selected.id,
            status: terminalStatus(terminal),
            startedAt,
            terminal,
            attemptCount: directAttemptCount,
            localExecution,
            userId: requester.userId,
          }).catch(metadataUpdateError),
          persistBinding ? persistBinding().catch(stickinessWriteError) : Promise.resolve(),
        ]);
      })
      .catch(metadataUpdateError);
    void finalize;
    return served;
  } catch (caught) {
    // No finalizer was scheduled (see above). Settle an attempt that may
    // still be streaming (no-op once its terminal is known), then claim it
    // together with the request as the error the client receives.
    const leaseLost = precommitLeaseLost(
      caught,
      capacityLease?.state === "ADMITTED" ? capacityLease.lease.signal : undefined,
      request.signal,
    );
    attempt.cancel("unknown");
    const terminal = servedLocalTerminal(
      await attempt.terminal.catch(() => rejectedRelayTerminal()),
      leaseLost,
    );
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => cliLease.release()),
      Promise.resolve().then(() => globalLease?.release()),
      capacityLease?.state === "ADMITTED"
        ? (capacityRuntime?.release(capacityLease.lease) ?? Promise.resolve(false))
        : Promise.resolve(),
      builtRequest.body instanceof Uint8Array ? Promise.resolve() : builtRequest.body.dispose(),
      operation.dispose?.() ?? Promise.resolve(),
    ]);
    reportCleanupFailures(cleanup);
    await updateRelayMetadata(relayRequestId, {
      selectedRuntimeModelId: selected.id,
      status: servedFailureStatus(terminal),
      startedAt,
      terminal,
      fallbackFailure: terminal.failure ?? "unknown",
      attemptCount: directAttemptCount,
      localExecution,
      userId: requester.userId,
    });
    if (terminal.failure === "request_too_large" && operation.contextCount?.exact) {
      return contextExceededResponse(
        operation,
        "Request context exceeds the configured execution capacity ceiling.",
        {
          estimatedInputTokens: operation.contextCount.tokens,
          estimateMethod: operation.contextCount.method,
          contextMarginTokens: 0,
          effectiveContextCeilingTokens:
            effectiveContextCeilingTokens(selected.instance.physicalMaxContext, null) ?? 1,
        },
      );
    }
    return operationFailureResponse(operation, terminal.failure ?? "unknown");
  }
}

async function relayPool({
  request,
  requester,
  target,
  operation,
  manager,
  limiter,
  transformDebug,
  capacityRuntime,
  external,
  externalAttempt,
}: {
  request: Request;
  requester: RelayRequester;
  target: CallablePool;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  transformDebug?: TransformDebug;
  capacityRuntime?: CapacityAdmissionRuntime;
  external: PoolExternalRoute;
  /** Set when a consented external attempt did not dispatch (D5 header). */
  externalAttempt: ExternalAttemptRecord;
}): Promise<Response> {
  const startedAt = new Date();
  const evictionResetGeneration = kvEvictionResetGeneration();
  const requestedSurface = requestedSurfaceForOperation(operation);
  const testRoutingMode = resolveChatTestRoutingMode(
    request.headers.get("x-wsmp-chat-test-routing-mode"),
    requester.exposeTransformDebug === true,
  );
  const forcedPoolMemberId =
    requester.exposeTransformDebug === true
      ? request.headers.get("x-wsmp-chat-test-member-id")?.trim() || undefined
      : undefined;
  const relayDeadlineMs = startedAt.getTime() + MODEL_API_RELAY_TIMEOUT_MS;
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    source: requester.source,
    apiKeyId: requester.apiKeyId,
    apiKeyPrefix: requester.apiKeyPrefix,
    requestedPoolId: target.id,
    requestedSurface: telemetrySurfaceForOperation(operation),
    transformerLatencyMs: transformDebug?.latencyMs ?? null,
    operation: operation.capability,
    requestBytes: null,
    contextCount: operation.contextCount,
    // Provider route intent is persisted at the send boundary. A tier that
    // does not commit supersedes it before returning to local or pool routing.
  });
  let routeIdentity: RouteIdentity = {
    fallbackRoute: null,
    selectedExecutionTargetId: null,
    selectedRuntimeModelId: null,
    selectedPoolMemberId: null,
  };
  const providerRouteIdentity = (provider: PublicProviderTarget): RouteIdentity => ({
    fallbackRoute: provider.ownKey ? "own-key" : "pool-external",
    selectedExecutionTargetId: provider.executionTargetId,
    selectedRuntimeModelId: null,
    selectedPoolMemberId: provider.ownKey ? null : provider.poolMemberId,
  });
  const persistRouteIdentity = async (identity: RouteIdentity) => {
    // Await supersession before admitting another tier or writing terminal
    // metadata. A failed write stops routing; it cannot leak stale identity
    // into a subsequent route's finalizer or rollup.
    try {
      await prisma.relayRequest.update({
        where: { id: relayRequestId },
        data: routeIdentityData(identity),
      });
    } catch (cause) {
      throw new RouteIdentityPersistenceError("Could not persist routing identity", { cause });
    }
    routeIdentity = identity;
  };
  let externalFailure: Extract<
    Awaited<ReturnType<typeof dispatchPublicOverflow>>,
    {
      dispatched: false;
    }
  >["providerFailure"];
  let ownKeyOutcome = false;
  const failPoolRelayMetadata = (input: Parameters<typeof failRelayMetadata>[0]) =>
    failRelayMetadata({ ...input, routeIdentity });
  const updatePoolRelayMetadata = (relayRequestId: string, update: RelayMetadataUpdate) =>
    updateRelayMetadata(relayRequestId, {
      ...update,
      routeIdentity,
    });

  // The caller's own concurrency caps (per token, per user) are never a
  // fallback trigger, and external dispatch keeps counting against them: the
  // caller lease is held across provider dispatch and released only when the
  // provider response settles.
  let globalLease: ModelApiLimitLease | undefined;

  /**
   * External fallback, at most one attempt per request. Returns
   * `not_applicable` (behave as the plain name) unless this request carries
   * an issued caller consent, which exists only when the caller asked for
   * `owner/pool:external`, its credential allows external providers, the
   * deployment switch is on, and the owner allows it for this requester.
   * dispatchPublicOverflow re-checks the switch, the owner's pool flags, and
   * the caller's token and grant against fresh state before any credential
   * is decrypted. Every consented attempt that does not dispatch returns
   * `unavailable` and is recorded for the `x-wsmp-fallback` header; a later
   * trigger returns the same outcome without retrying.
   */
  const tryPublicOverflow = async (
    reason: PublicOverflowReason,
    releaseLocalCapacity: () => Promise<void>,
  ): Promise<ExternalAttemptOutcome> => {
    if (!external.consent) return { kind: "not_applicable" };
    // A client that disconnected after an earlier external phase is a cancel,
    // whatever that phase's own outcome was.
    if (externalAttempt.unavailable)
      return {
        kind: "unavailable",
        reason: request.signal.aborted ? "CANCELLED" : externalAttempt.unavailable,
      };
    const outcome = await attemptPublicOverflow(external.consent, reason, releaseLocalCapacity);
    if (outcome instanceof Response) return { kind: "response", response: outcome };
    const unavailable = externalUnavailableReason(outcome.reason, request.signal.aborted);
    externalAttempt.unavailable = unavailable;
    if (unavailable === "POOL_UNAVAILABLE" || unavailable === "REQUESTER_BLOCKED")
      externalAttempt.accessLost = true;
    return { kind: "unavailable", reason: unavailable };
  };
  const attemptPublicOverflow = async (
    consent: ExternalEgressConsent,
    reason: PublicOverflowReason,
    releaseLocalCapacity: () => Promise<void>,
  ): Promise<Response | { dispatched: false; reason: PublicOverflowSkipReason }> => {
    // Public provider dispatch is intentionally limited to replayable modern
    // JSON operations. Multipart/audio paths must retain their exact target or
    // fail safely.
    if (!operation.contextInput || !requestedSurface)
      return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
    const providerResponsesStickiness =
      operation.family === "responses" && operation.responseStickiness !== undefined;
    let built: BuiltRelayRequest;
    try {
      built = await operation.buildRequest("__public_provider_model__");
    } catch {
      return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
    }
    if (!(built.body instanceof Uint8Array)) {
      await built.body.dispose();
      return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
    }
    const publicRequestBytes = built.body.byteLength;
    const requestedProtocol: "openai" | "anthropic" =
      operation.family === "messages" ? "anthropic" : "openai";
    const maxOutput = operation.contextInput.max_output_tokens ?? operation.contextInput.max_tokens;
    const requestedFeatures = profileSurfaceRequest(operation.contextInput);
    const requiredFeatures = Object.entries(requestedFeatures)
      .filter(([, enabled]) => enabled === true)
      .map(([feature]) => feature);
    const requestedOutputTokens =
      operation.family === "embeddings"
        ? 0n
        : typeof maxOutput === "number" && Number.isSafeInteger(maxOutput) && maxOutput >= 0
          ? BigInt(maxOutput)
          : undefined;
    const estimatedInputTokens =
      payloadAwareInputTokens(built.body) ?? conservativeSerializedInputTokens(publicRequestBytes);
    const canonical = operation.adaptation
      ? (() => {
          try {
            return parseCanonicalRequest(
              operation.adaptation!.requestedSurface,
              operation.adaptation!.payload,
            );
          } catch {
            return null;
          }
        })()
      : null;
    let localCapacityReleased = false;
    const releaseProviderCapacity = async () => {
      if (localCapacityReleased) return;
      localCapacityReleased = true;
      await releaseLocalCapacity();
    };
    const providerRequest = {
      // Provider configuration and budgets belong to the pool owner. The
      // requester may be an explicitly granted tenant; relay metadata and the
      // stickiness visibility tuple remain requester/token scoped.
      userId: target.ownerUserId,
      affinityTenantUserId: requester.userId,
      affinitySecurityScope: requester.limitKey,
      affinityAccessGrantId: target.shareId,
      poolId: target.id,
      requestId: relayRequestId,
      reason,
      externalConsent: consent,
      requesterUserId: requester.userId,
      requesterModelApiTokenId: requester.apiKeyId,
      requestedProtocol,
      requestedSurface,
      embeddingContract:
        operation.family === "embeddings"
          ? (parseEmbeddingContract(target.embeddingContract) ?? undefined)
          : undefined,
      stream: operation.stream,
      requiredFeatures,
      path: operation.path,
      headers: built.headers,
      affinityHeaders: request.headers,
      body: built.body,
      signal: request.signal,
      releaseLocalCapacity: releaseProviderCapacity,
      adaptationEnabled: operation.adaptation?.poolEnabled === true,
      chatTestRoutingMode: testRoutingMode,
      forcedPoolMemberId,
      retrySafe:
        shouldRetryRelayOperation(operation, "precommit_5xx") &&
        shouldRetryRelayOperation(operation, "precommit_transport"),
      requireNativeSurface: providerResponsesStickiness ? "openai-responses" : undefined,
      liability:
        requestedOutputTokens === undefined
          ? { accountingVersion: "provider-billable-v1" }
          : conservativeProviderLiability({ estimatedInputTokens, requestedOutputTokens }),
      estimatedInputTokens,
      contextTokens:
        requestedOutputTokens === undefined
          ? undefined
          : estimatedInputTokens + requestedOutputTokens,
      requestedOutputTokens,
      contextCountMethod: operation.contextCount?.method,
      contextCountConfidence: operation.contextCount?.confidence,
      renderForTarget: canonical
        ? async (providerTarget, targetSurface) => {
            const payload = renderForExecutionTarget({
              request: canonical,
              target: targetSurface,
              model: providerTarget.upstreamModelId,
              allowLossyDeveloperRoleCollapse: providerTarget.ownKey
                ? false
                : operation.adaptation?.allowLossyDeveloperRoleCollapse,
              capabilities: providerTarget.capabilityInventory,
            });
            const headers = new Headers({ "content-type": "application/json" });
            if (providerTarget.protocol === "anthropic")
              headers.set(
                "anthropic-version",
                providerTarget.providerVersion ?? ANTHROPIC_DEFAULT_API_VERSION,
              );
            return {
              protocol: providerTarget.protocol,
              path:
                targetSurface === "anthropic-messages"
                  ? "/v1/messages"
                  : targetSurface === "openai-responses"
                    ? "/v1/responses"
                    : "/v1/chat/completions",
              headers,
              body: new TextEncoder().encode(JSON.stringify(payload)),
            };
          }
        : undefined,
    } satisfies PublicOverflowRequest;
    const dispatchExternalTier = async (
      ownKey = false,
    ): Promise<Awaited<ReturnType<typeof dispatchPublicOverflow>>> => {
      const tierRequest: PublicOverflowRequest = ownKey
        ? {
            ...providerRequest,
            userId: requester.userId,
            ownKeyProviderModelId: consent.ownKeyProviderModelId,
            // Own-key adaptation is selected by the requester-owned preference.
            adaptationEnabled: false,
          }
        : providerRequest;
      const listTier = () =>
        ownKey
          ? listPublicOverflowTargets(target.ownerUserId, target.id, {
              requesterUserId: requester.userId,
              providerModelId: consent.ownKeyProviderModelId!,
              shareId: consent.shareId,
            })
          : listPublicOverflowTargets(target.ownerUserId, target.id);
      // Owner and pool flags gate provider admission (F-C, #64; #76): a
      // request whose consent no longer holds must not take or wait for a
      // provider capacity slot. These are early exits with the dispatcher's
      // own reasons; the send claim still re-checks every condition. They are
      // read again before every later member's admission (CF-b1).
      const flagDenial = (
        current: Awaited<ReturnType<typeof listTier>>,
      ): PublicOverflowSkipReason | null => {
        if (!current.ownerActive) return "POOL_OWNER_INACTIVE";
        if (ownKey && !current.enabled) return "OWN_KEY_CONSENT_WITHDRAWN";
        if (!ownKey && !current.enabled) return "POOL_PRIVATE";
        if (!ownKey && !consent.requesterIsOwner && !current.fallbackForGrantees)
          return "GRANTEE_NOT_COVERED";
        return null;
      };
      const listed = await listTier();
      const denied = flagDenial(listed);
      if (denied) return { dispatched: false, reason: denied };
      const compatibleTargets = (providerTargets: typeof listed.targets) =>
        providerTargets.flatMap((providerTarget) => {
          if (forcedPoolMemberId && providerTarget.poolMemberId !== forcedPoolMemberId) return [];
          const resolvedExecution = resolvePublicProviderExecution(providerTarget, tierRequest);
          const resolvedTarget = { ...providerTarget, resolvedExecution };
          return publicTargetCompatibility(providerTarget, tierRequest) === "COMPATIBLE" &&
            matchesChatTestProviderMode(resolvedTarget, requestedSurface, testRoutingMode)
            ? [resolvedTarget]
            : [];
        });
      let providerDepthError: AdapterError | undefined;
      const compatibleAll = compatibleTargets(listed.targets).filter((providerTarget) => {
        const nativeSurface = providerTarget.resolvedExecution?.nativeSurface;
        if (!canonical || !nativeSurface || nativeSurface === requestedSurface) return true;
        try {
          renderForExecutionTarget({
            request: canonical,
            target: nativeSurface,
            model: providerTarget.upstreamModelId,
            allowLossyDeveloperRoleCollapse: providerTarget.ownKey
              ? false
              : operation.adaptation?.allowLossyDeveloperRoleCollapse,
            capabilities: providerTarget.capabilityInventory,
          });
        } catch (error) {
          if (isRequestDepthError(error)) {
            providerDepthError = error;
            return false;
          }
        }
        return true;
      });
      if (providerDepthError && compatibleAll.length === 0) throw providerDepthError;
      const compatible = orderChatTestProviderTargets(
        compatibleAll,
        requestedSurface,
        testRoutingMode,
      );
      // Compatible members exist but every one is in a provider health
      // cooldown: a transient 503-class condition, never 400.
      if (compatible.length === 0 && compatibleTargets(listed.coolingDown).length > 0)
        return { dispatched: false, reason: "PROVIDER_UNHEALTHY" };
      if (compatible.length === 0) return { dispatched: false, reason: "NO_COMPATIBLE_PROVIDER" };
      // 0.4.0 cloud members have no physical capacity: the provider is the capacity, and the
      // monthly spend caps (reserved before every send) bound what they may spend. They are
      // dispatched without a capacity lease; dispatchPublicOverflow walks the ranked members
      // itself (spend admission, health trial and the E0 send claim per member).
      await releaseProviderCapacity();
      // The relay deadline bounds the start of external work.
      if (request.signal.aborted || remainingRelayBudgetMs(relayDeadlineMs) <= 0)
        return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
      const previousRoute = routeIdentity;
      const result = await dispatchPublicOverflow({
        ...tierRequest,
        // Only the members this tier found servable (e.g. renderable at this depth).
        eligibleExecutionTargetIds: compatible.map((item) => item.executionTargetId),
        retrySingleTargetPrecommit: ownKey,
        beforeProviderSend: ownKey
          ? (provider) => persistRouteIdentity(providerRouteIdentity(provider))
          : undefined,
      });
      if (!result.dispatched && ownKey) await persistRouteIdentity(previousRoute);
      return result;
    };
    // H1: take (or acquire) the caller's own concurrency lease before any
    // provider work. A caller at its own cap gets 429 exactly as it would for
    // a local member; its cap is never a reason to go external.
    const outerCallerLease = globalLease;
    globalLease = undefined;
    let callerLease: ModelApiLimitLease;
    if (outerCallerLease) callerLease = outerCallerLease;
    else {
      try {
        callerLease = limiter.acquireGlobal({
          tokenId: requester.limitKey,
          userId: requester.userId,
        });
      } catch (error) {
        const failure: RelayFailure =
          error instanceof ModelApiLimitError ? error.failure : "unknown";
        await settleRelayCleanup([() => releaseProviderCapacity(), () => operation.dispose?.()]);
        await failPoolRelayMetadata({ relayRequestId, startedAt, failure }).catch(
          metadataUpdateError,
        );
        return operationFailureResponse(operation, failure);
      }
    }
    let callerLeaseReleased = false;
    const releaseCallerLease = () => {
      if (callerLeaseReleased) return;
      callerLeaseReleased = true;
      callerLease.release();
    };
    // Terminal transition for a dispatched external attempt. Registered only
    // once the response has actually committed to the client (or when a
    // hand-off error ends the request).
    let externalFinalizationScheduled = false;
    let externalProtocolFailure = false;
    let externalAdaptationCompletion: Promise<"ok" | "protocol_error" | "cancelled"> =
      Promise.resolve("ok");
    const scheduleExternalFinalization = (
      committedResult: Extract<
        Awaited<ReturnType<typeof dispatchPublicOverflow>>,
        { dispatched: true }
      >,
    ) => {
      if (externalFinalizationScheduled) return;
      externalFinalizationScheduled = true;
      void committedResult.terminal
        .then(async (terminal) => {
          const adaptationOutcome = await externalAdaptationCompletion;
          externalProtocolFailure ||=
            adaptationOutcome === "protocol_error" && !request.signal.aborted;
          releaseCallerLease();
          const completedAt = new Date();
          const usage = usageFactsFromProviderUsage(terminal.usage);
          await Promise.allSettled([
            prisma.$transaction((tx) =>
              transitionRelayRequestTerminal(
                tx,
                relayRequestId,
                {
                  selectedTargetId: committedResult.target.executionTargetId,
                  status:
                    terminal.ok && !externalProtocolFailure
                      ? "SUCCEEDED"
                      : request.signal.aborted
                        ? "CANCELED"
                        : "FAILED",
                  completedAt,
                  durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
                  httpStatusCode: externalProtocolFailure ? 502 : committedResult.response.status,
                  upstreamStatusCode: committedResult.response.status,
                  requestBytes: BigInt(publicRequestBytes),
                  responseBytes: BigInt(terminal.responseBytes),
                  attemptCount: committedResult.attemptCount,
                  errorClass: externalProtocolFailure
                    ? "protocol_error"
                    : terminal.ok
                      ? null
                      : request.signal.aborted
                        ? "cancelled"
                        : "unknown",
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                  usageKnown: usage.usageKnown,
                },
                completedAt,
              ),
            ),
            operation.dispose?.() ?? Promise.resolve(),
          ]);
        })
        .catch(metadataUpdateError)
        .finally(releaseCallerLease);
    };
    let committed: Extract<
      Awaited<ReturnType<typeof dispatchPublicOverflow>>,
      { dispatched: true }
    > | null = null;
    let heldByCaller = false;
    try {
      const ownResult =
        consent.ownKeyProviderModelId && !forcedPoolMemberId
          ? await dispatchExternalTier(true)
          : undefined;
      // No retry after a response has committed, including an errored stream.
      // Requester-wide withdrawals end the request; clearing only the own-key
      // choice still allows independently consented owner-paid fallback.
      let result =
        ownResult &&
        (ownResult.dispatched ||
          (isExternalConsentDenialReason(ownResult.reason) &&
            ownResult.reason !== "OWN_KEY_CONSENT_WITHDRAWN") ||
          (!providerRequest.retrySafe && ownResult.providerIoStarted))
          ? ownResult
          : await dispatchExternalTier();
      // An absent or independently forbidden owner-paid plan must not erase
      // a useful own-key outcome (including the upstream status/Retry-After).
      if (
        ownResult &&
        !ownResult.dispatched &&
        !result.dispatched &&
        ["POOL_PRIVATE", "GRANTEE_NOT_COVERED", "NO_COMPATIBLE_PROVIDER"].includes(result.reason)
      )
        result = ownResult;
      ownKeyOutcome = result === ownResult;
      if (!result.dispatched) {
        // Hand the caller lease back to the local path that owned it.
        if (outerCallerLease && !localCapacityReleased) {
          callerLeaseReleased = true;
          globalLease = outerCallerLease;
        } else releaseCallerLease();
        externalFailure = ownKeyOutcome ? result.providerFailure : undefined;
        return {
          dispatched: false,
          reason: externalFailure?.status === 429 ? "PROVIDER_SATURATED" : result.reason,
        };
      }
      committed = result;
      heldByCaller = true;
      return await commitExternalResponse();
    } catch (error) {
      if (!heldByCaller && isRequestDepthError(error)) {
        releaseCallerLease();
        await settleRelayCleanup([() => releaseProviderCapacity(), () => operation.dispose?.()]);
        await failPoolRelayMetadata({
          relayRequestId,
          startedAt,
          failure: "unsupported_capability",
        }).catch(metadataUpdateError);
        return adapterRequestErrorResponse(requestedSurface, error);
      }
      if (heldByCaller) {
        // Nothing reached the client: release the caller lease before answering. A hand-off
        // error ends the request with this attempt as its outcome; let its terminal
        // transition claim the row.
        releaseCallerLease();
        if (error instanceof AdapterError && error.code !== "cancelled" && !request.signal.aborted)
          externalProtocolFailure = true;
        if (committed) scheduleExternalFinalization(committed);
        if (externalProtocolFailure) return operationFailureResponse(operation, "protocol_error");
        throw error;
      }
      // Nothing was dispatched and the error ends the request: release the
      // caller lease and the local capacity lease exactly once (both are
      // idempotent here), dispose the operation, and finalize the request so
      // it never lingers PENDING (R-J).
      releaseCallerLease();
      await settleRelayCleanup([() => releaseProviderCapacity(), () => operation.dispose?.()]);
      const failure: ModelApiFailure = request.signal.aborted
        ? "cancelled"
        : error instanceof RouteIdentityPersistenceError
          ? "disconnected"
          : "unknown";
      await failPoolRelayMetadata({
        relayRequestId,
        startedAt,
        failure,
      }).catch(metadataUpdateError);
      if (error instanceof RouteIdentityPersistenceError) {
        metadataUpdateError(error);
        return operationFailureResponse(operation, failure);
      }
      throw error;
    }

    async function commitExternalResponse() {
      const committedResult = committed;
      if (!committedResult) throw new Error("external response commit without a dispatch result.");
      routeIdentity = providerRouteIdentity(committedResult.target);
      const externalReason = externalFallbackReasonHeader(reason);
      await prisma.relayRequest
        .update({
          where: { id: relayRequestId },
          data: {
            selectedExecutionTargetId: committedResult.target.executionTargetId,
            selectedRuntimeModelId: null,
            selectedPoolMemberId: committedResult.target.ownKey
              ? null
              : committedResult.target.poolMemberId,
            selectedNativeSurface:
              operation.family === "embeddings"
                ? "OPENAI_EMBEDDINGS"
                : modelApiSurface(committedResult.nativeSurface),
            adapterMode: committedResult.nativeSurface === requestedSurface ? "NATIVE" : "ADAPTED",
            adapterVersion: committedResult.nativeSurface === requestedSurface ? null : "1.0.0",
            publicEgress: true,
            publicOverflowReason: reason,
            fallbackRoute: committedResult.target.ownKey ? "own-key" : "pool-external",
            providerAccountId: committedResult.target.providerAccountId,
            providerModelId: committedResult.target.providerModelId,
            providerAttemptId: committedResult.attemptId,
            providerFencingToken: committedResult.fencingToken,
            attemptCount: committedResult.attemptCount,
            affinityOutcome: committedResult.affinity?.outcome ?? "DISABLED",
            affinityScore: committedResult.affinity?.score,
            affinityPrefixDepth: committedResult.affinity?.prefixDepth,
            affinityReason: committedResult.affinity?.reason,
          },
          select: { id: true },
        })
        .catch(metadataUpdateError);
      const routeHeaders = {
        [ROUTE_HEADER]: committedResult.target.ownKey ? "own-key" : "pool-fallback",
        [FALLBACK_REASON_HEADER]: externalReason,
        [SERVED_MODEL_HEADER]: committedResult.target.upstreamModelId,
      };
      const adapterLogContext: AdapterLogContext = {
        relayRequestId,
        poolMemberId: committedResult.target.poolMemberId,
        executionTargetId: committedResult.target.executionTargetId,
      };
      const externalBodyRead = (
        body: ReadableStream<Uint8Array> | null,
        bodySource: ProtocolSurface,
        bodyTarget: ProtocolSurface,
        status: number,
        headers: Headers,
      ): Promise<Uint8Array> =>
        readAdaptedNonstreamBody({
          body,
          source: bodySource,
          target: bodyTarget,
          status,
          headers,
          signal: request.signal,
          logContext: adapterLogContext,
        });
      // Native response bytes remain opaque. Cross-protocol provider response
      // adaptation is handled by the same strict streaming/non-streaming state
      // machines as local targets. The response `model` is always the provider's
      // served upstream id (adapters copy the source response's model).
      const commitAwareResponse = async (response: Response) => {
        const held = responseWithFirstClientByte(response, committedResult.markFirstClientByte);
        // The response is now the request's committed outcome: only now may the
        // request-terminal finalizer claim it.
        scheduleExternalFinalization(committedResult);
        return withResponseHeaders(held, routeHeaders);
      };
      // D9: WMP's own mapped refusal (typed, in-process flag), rendered in
      // the requested surface's error shape with the route headers. Never
      // derived from provider bytes, which stay sanitized below.
      if (committedResult.dataPolicyRefusal) {
        await committedResult.response.body?.cancel().catch(() => undefined);
        return await commitAwareResponse(dataPolicyRefusalResponse(operation.family));
      }
      if (
        committedResult.nativeSurface === requestedSurface &&
        (committedResult.response.status < 200 || committedResult.response.status >= 300)
      ) {
        const sanitized = await externalBodyRead(
          committedResult.response.body,
          requestedSurface,
          requestedSurface,
          committedResult.response.status,
          committedResult.response.headers,
        );
        return await commitAwareResponse(
          new Response(sanitized, {
            status:
              committedResult.response.status >= 400 && committedResult.response.status <= 599
                ? committedResult.response.status
                : 502,
            headers: adaptedProviderResponseHeaders(
              requestedSurface,
              requestedSurface,
              committedResult.response.headers,
              false,
            ),
          }),
        );
      }
      if (committedResult.nativeSurface === requestedSurface || !operation.adaptation) {
        const response =
          providerResponsesStickiness && committedResult.nativeSurface === "openai-responses"
            ? captureProviderResponseBinding({
                response: committedResult.response,
                streaming: operation.stream,
                requester,
                targetPoolId: target.id,
                shareId: target.shareId,
                target: committedResult.target,
                terminal: committedResult.terminal,
              })
            : committedResult.response;
        return await commitAwareResponse(response);
      }
      const source: ProtocolSurface = committedResult.nativeSurface;
      const adaptedRequestLimitations = (() => {
        try {
          return parseCanonicalRequest(
            operation.adaptation.requestedSurface,
            operation.adaptation.payload,
          ).limitations;
        } catch {
          return [];
        }
      })();
      const adapterLimitations = [
        "strict_common_subset",
        ...(source === "anthropic-messages" ? adaptedRequestLimitations : []),
      ].join(",");
      // Providers return ordinary JSON error envelopes even when the successful
      // operation would have streamed. Adapt that envelope as JSON; never feed
      // it into an SSE state machine or advertise it as an event stream.
      if (committedResult.response.status < 200 || committedResult.response.status >= 300) {
        const adapted = await externalBodyRead(
          committedResult.response.body,
          source,
          operation.adaptation.requestedSurface,
          committedResult.response.status,
          committedResult.response.headers,
        );
        const adaptedHeaders = adaptedProviderResponseHeaders(
          source,
          operation.adaptation.requestedSurface,
          committedResult.response.headers,
        );
        adaptedHeaders.set("x-wsmp-adapter-limitations", adapterLimitations);
        return await commitAwareResponse(
          new Response(adapted, {
            status:
              committedResult.response.status >= 400 && committedResult.response.status <= 599
                ? committedResult.response.status
                : 502,
            headers: adaptedHeaders,
          }),
        );
      }
      if (operation.stream) {
        if (!committedResult.response.body) {
          const headers = new Headers(committedResult.response.headers);
          headers.set("x-wsmp-adapter-version", "1.0.0");
          headers.set("x-wsmp-adapter-limitations", adapterLimitations);
          return await commitAwareResponse(
            new Response(null, { status: committedResult.response.status, headers }),
          );
        }
        let protocolFailureObserved = false;
        const primed = await primeReadableStream(
          adaptedResponseBody({
            body: committedResult.response.body,
            source,
            target: operation.adaptation.requestedSurface,
            stream: true,
            status: committedResult.response.status,
            headers: committedResult.response.headers,
            signal: request.signal,
            logContext: adapterLogContext,
            request: canonical ?? undefined,
            // Prime before hand-off so an invalid first event can return 502.
            // After output, end with the target protocol's terminal error event.
            onProtocolError: () => {
              protocolFailureObserved = true;
            },
          }),
          operation.adaptation.requestedSurface,
        );
        externalAdaptationCompletion = primed.completion.then((outcome) =>
          protocolFailureObserved && outcome === "ok" ? "protocol_error" : outcome,
        );
        return await commitAwareResponse(
          new Response(primed.body, {
            status: committedResult.response.status,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "x-wsmp-adapter-version": "1.0.0",
              "x-wsmp-adapter-limitations": adapterLimitations,
            },
          }),
        );
      }
      const bytes = new Uint8Array(await committedResult.response.arrayBuffer());
      const adapted = await externalBodyRead(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        source,
        operation.adaptation.requestedSurface,
        committedResult.response.status,
        committedResult.response.headers,
      );
      return await commitAwareResponse(
        new Response(adapted, {
          status: committedResult.response.status,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-wsmp-adapter-version": "1.0.0",
            "x-wsmp-adapter-limitations": adapterLimitations,
          },
        }),
      );
    }
  };

  const listedMembers = await poolMemberRows(target.id);
  const members = forcedPoolMemberId
    ? listedMembers.filter((member) => member.memberId === forcedPoolMemberId)
    : listedMembers;
  // C2: a Chat Test forced member may name an external member only on the
  // `:external` name (where consent exists). On a plain name it can never
  // turn into provider egress.
  if (forcedPoolMemberId && members.length === 0 && !external.consent) {
    await operation.dispose?.();
    await failPoolRelayMetadata({ relayRequestId, startedAt, failure: "unsupported_capability" });
    return externalRouteErrorResponse(operation.family, {
      code: "forced_member_requires_external",
      message: `The forced member is not a local member of "${target.modelId}". External members can be forced only with "${externalModelId(target.modelId)}".`,
    });
  }
  // A pool whose only members are external cannot serve its plain name:
  // plain names never leave the deployment.
  if (listedMembers.length === 0 && target.externalMemberCount > 0 && !external.consent) {
    await operation.dispose?.();
    await failPoolRelayMetadata({ relayRequestId, startedAt, failure: "unsupported_capability" });
    // Token counting never uses external providers, whatever name was sent.
    if (operationTreatsExternalAsBase(operation))
      return externalRouteErrorResponse(operation.family, {
        code: "local_members_required",
        message: `"${target.modelId}" has only external members, and token counting is always done by local members, so it is not available for this pool${external.variantIgnored ? ` (":${EXTERNAL_MODEL_VARIANT}" is counted as "${target.modelId}")` : ""}.`,
      });
    if (!external.requested)
      return externalRouteErrorResponse(operation.family, {
        code: "external_required",
        message: `"${target.modelId}" has no local members, and plain pool names never leave this deployment. Use "${externalModelId(target.modelId)}" to allow external providers.`,
      });
    return externalRouteErrorResponse(
      operation.family,
      {
        code: "external_unavailable",
        message: externalUnavailableMessage(external.denial ?? "NO_EXTERNAL_MEMBERS", target),
      },
      { [FALLBACK_HEADER]: "unavailable" },
    );
  }
  // Routing is decided from here on: a pool with local members serves or
  // fails on the local path unless an external response commits.
  const providerOnly =
    listedMembers.length === 0 ||
    (forcedPoolMemberId != null && members.length === 0 && external.consent);
  if (!providerOnly) {
    routeIdentity = { ...routeIdentity, fallbackRoute: "local" };
    externalAttempt.localRouteDecided = true;
  }
  /**
   * X1 / D5: a consented `:external` request on a pool with no local members
   * whose external attempt did not dispatch. Never 400 for a transient
   * condition; the caller sees `x-wsmp-fallback: unavailable`.
   */
  const providerOnlyUnavailableResponse = async (
    reason: ExternalUnavailableReason,
  ): Promise<Response> => {
    // `reason` already reads as CANCELLED when the client left during the
    // external phase (externalUnavailableReason): a cancel (499), not the
    // phase's own rate_limited / 429.
    const terminal = terminalExternalFailure({ kind: "unavailable", reason });
    const failure: ModelApiFailure =
      terminal ??
      (reason === "NO_COMPATIBLE"
        ? "unsupported_capability"
        : reason === "SATURATED" || reason === "GRANTEE_SPEND_CAP"
          ? "rate_limited"
          : reason === "CANCELLED"
            ? "cancelled"
            : "disconnected");
    await operation.dispose?.();
    // Final attribution is telemetry, not permission to send or switch tiers.
    // Write it with the terminal transition; a failure must not change the
    // already-decided response. Only own-key preserves upstream failure facts.
    if (externalFailure) routeIdentity = providerRouteIdentity(externalFailure.target);
    // A cancel or a lost access is never reported with a provider status.
    const providerStatus = terminal ? undefined : externalFailure?.status;
    await failPoolRelayMetadata({
      relayRequestId,
      startedAt,
      failure,
      upstreamStatusCode: externalFailure?.status,
      httpStatusCode: providerStatus,
    }).catch(metadataUpdateError);
    if (externalFailure && !terminal) {
      const response = operationFailureResponse(operation, failure);
      const headers = new Headers(response.headers);
      if (reason === "SATURATED") headers.set("retry-after", "1");
      const retryAfter = safeProviderRetryAfter(externalFailure.retryAfter ?? null);
      if (retryAfter) headers.set("retry-after", retryAfter);
      return new Response(response.body, {
        status: providerStatus ?? response.status,
        headers,
      });
    }
    if (reason === "GRANTEE_SPEND_CAP") {
      return externalRouteErrorResponse(operation.family, {
        code: "grantee_spend_cap",
        message: GRANTEE_SPEND_CAP_MESSAGE,
      });
    }
    if (reason !== "UNAVAILABLE") {
      const response = operationFailureResponse(operation, failure);
      if (ownKeyOutcome && reason === "SATURATED") response.headers.set("retry-after", "1");
      return response;
    }
    return externalRouteErrorResponse(operation.family, {
      code: "external_unavailable",
      message: `No external provider for "${externalModelId(target.modelId)}" is available right now, and the pool has no local members. Try again later.`,
    });
  };
  const nativeCounts = new Map<string, ContextCountTelemetry>();
  // Native counts belong to the selected engine/tokenizer, never the pool.
  const initialContextCount = operation.contextCount;
  if (capacityRuntime && operation.contextInput) {
    // Same gate as the send: an early exit before counting the admitted
    // member. Counts stay off the owner's machines when the pool is already
    // unavailable (banned owner, revoked grant, failed check).
    const countRefusal = await earlyLocalSendDenial({
      poolId: target.id,
      ownerUserId: target.ownerUserId,
      requesterUserId: requester.userId,
      shareId: target.shareId,
      poolMemberId: null,
    });
    if (countRefusal) {
      const countFailure = LOCAL_SEND_DENIAL_FAILURE[countRefusal];
      externalAttempt.accessLost = true;
      await operation.dispose?.();
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure: countFailure });
      return operationFailureResponse(operation, countFailure);
    }
  }
  // The pool's context ceiling and margin (pool_advanced) apply to every member.
  const configuredContextCeilingForMember = (member: PoolMemberRelayRow) =>
    member.pool.contextCeiling;
  const contextMarginForMember = (member: PoolMemberRelayRow) => member.pool.contextMargin;
  // Estimates rank at `estimateFitIds`. Each selected engine counts its own
  // input after admission; token counts never filter unrelated tokenizers.
  const contextEligibleMembers = members;
  // Each member's request compatibility (its runtime launch's setting, description and what
  // was learned), read once per request; fixes learned during this request are added here.
  const compatByMember = new Map(
    await Promise.all(
      members.map(
        async (member) =>
          [member.id, await compatLaunchFor(member.instance, member.model.userId)] as const,
      ),
    ),
  );
  const compatExtraByLaunch = new Map<string, CompatExtra>();
  const compatTrace = newCompatTrace();
  let compatRetried = false;
  let canonicalAdaptationRequest: ReturnType<typeof parseCanonicalRequest> | null = null;
  // Why the strict adapter refused this request (it names the feature): the answer when only
  // adapted members could have served it.
  let adaptationRefusal: AdapterError | undefined;
  if (operation.adaptation?.poolEnabled === true) {
    try {
      canonicalAdaptationRequest = parseCanonicalRequest(
        operation.adaptation.requestedSurface,
        operation.adaptation.payload,
      );
    } catch (error) {
      // Native members may still accept extensions outside the strict adapted subset.
      if (error instanceof AdapterError) adaptationRefusal = error;
    }
  }
  const executionByMember = new Map(
    contextEligibleMembers.map((member) => [
      member.id,
      executionPathForPoolMember(
        effectivePoolMemberCapabilities(member),
        operation,
        canonicalAdaptationRequest,
      ),
    ]),
  );
  let adaptationDepthError: AdapterError | undefined;
  let adaptedMemberRefused = false;
  const protocolCandidates = contextEligibleMembers.filter((member) => {
    if (
      operation.family === "embeddings" &&
      external.requested &&
      !embeddingContractsMatch(
        target.embeddingContract,
        effectivePoolMemberCapabilities(member)?.embeddings?.contract,
      )
    )
      return false;
    const execution = executionByMember.get(member.id);
    if (!execution)
      return supportsOperation({
        capabilities: effectivePoolMemberCapabilities(member),
        operation,
      });
    if (execution.mode === "unavailable") return false;
    if (execution.mode === "native") return true;
    const source = execution.nativeSurface ? protocolSurface(execution.nativeSurface) : null;
    if (!source || !canonicalAdaptationRequest) {
      adaptedMemberRefused = true;
      return false;
    }
    try {
      renderForExecutionTarget({
        request: canonicalAdaptationRequest,
        target: source,
        model: member.model.upstreamModelId,
        allowLossyDeveloperRoleCollapse: operation.adaptation?.allowLossyDeveloperRoleCollapse,
        capabilities: effectivePoolMemberCapabilities(member),
        extras: compatExtrasFor(compatByMember.get(member.id)),
      });
      return true;
    } catch (error) {
      if (isRequestDepthError(error)) adaptationDepthError = error;
      else if (error instanceof AdapterError) adaptationRefusal ??= error;
      adaptedMemberRefused = true;
      return false;
    }
  });
  if (adaptationDepthError && operation.adaptation && protocolCandidates.length === 0) {
    await operation.dispose?.();
    await failPoolRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unsupported_capability",
    }).catch(metadataUpdateError);
    return adapterRequestErrorResponse(operation.adaptation.requestedSurface, adaptationDepthError);
  }
  const nativeProtocolCandidates = protocolCandidates.filter(
    (member) => executionByMember.get(member.id)?.mode === "native",
  );
  // Native-compatible members are preferred as a class before health/weight scoring.
  const adaptedProtocolCandidates = protocolCandidates.filter(
    (member) => executionByMember.get(member.id)?.mode === "adapted",
  );
  const legacyProtocolCandidates = protocolCandidates.filter(
    (member) => executionByMember.get(member.id) == null,
  );
  const selectedNativeProtocolCandidates = allowsChatTestExecutionMode(testRoutingMode, "native")
    ? nativeProtocolCandidates
    : [];
  const selectedAdaptedProtocolCandidates = allowsChatTestExecutionMode(testRoutingMode, "adapted")
    ? adaptedProtocolCandidates
    : [];
  const selectedLegacyProtocolCandidates = allowsChatTestExecutionMode(testRoutingMode, "legacy")
    ? legacyProtocolCandidates
    : [];
  const knownEligibleMembers = [
    ...selectedNativeProtocolCandidates,
    ...selectedAdaptedProtocolCandidates,
    ...selectedLegacyProtocolCandidates,
  ];
  const knownIds = new Set(knownEligibleMembers.map((member) => member.id));
  const unknownFallbackMembers =
    target.optimisticBasicTranscription &&
    operation.capability === "audio.transcriptions" &&
    operation.transcriptionProfile &&
    isBasicTranscriptionRequest(operation.transcriptionProfile)
      ? contextEligibleMembers.filter((member) => {
          if (knownIds.has(member.id)) return false;
          const capability = normalizeTranscriptionCapabilities(
            effectivePoolMemberCapabilities(member)?.audio?.transcriptions,
          );
          return capability?.supported === undefined;
        })
      : [];
  // Known-compatible members always route before optimistic unknown fallbacks.
  const eligibleMembers = [...knownEligibleMembers, ...unknownFallbackMembers];
  if (eligibleMembers.length === 0) {
    // (b) No compatible local member.
    const overflow = await tryPublicOverflow(
      "NO_COMPATIBLE_HEALTHY_PRIMARY",
      async () => undefined,
    );
    if (overflow.kind === "response") return overflow.response;
    if (providerOnly && overflow.kind === "unavailable")
      return providerOnlyUnavailableResponse(overflow.reason);
    const externalFailure = terminalExternalFailure(overflow);
    const failure = externalFailure ?? "unsupported_capability";
    if (
      failure === "unsupported_capability" &&
      operation.adaptation &&
      allowsChatTestExecutionMode(testRoutingMode, "adapted") &&
      adaptedMemberRefused &&
      adaptationRefusal
    ) {
      // Fail closed with the feature the adapter cannot translate, never a generic refusal.
      await operation.dispose?.();
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure }).catch(
        metadataUpdateError,
      );
      return adapterRequestErrorResponse(operation.adaptation.requestedSurface, adaptationRefusal);
    }
    await operation.dispose?.();
    await failPoolRelayMetadata({ relayRequestId, startedAt, failure });
    return operationFailureResponse(
      operation,
      failure,
      externalFailure ? undefined : unsupportedCapabilityMessage(operation),
    );
  }

  const onlineNodeIds = manager.getOnlineNodeIds();
  const now = new Date();
  const groupRows = [
    selectedNativeProtocolCandidates.map(poolRouteRowOf),
    selectedAdaptedProtocolCandidates.map(poolRouteRowOf),
    selectedLegacyProtocolCandidates.map(poolRouteRowOf),
    unknownFallbackMembers.map(poolRouteRowOf),
  ] as const;
  // A degraded route of one group falls back only when no known-compatible group has a
  // healthy route (an optimistic unknown-capability member is no alternative).
  const alternatives = groupRows.slice(0, 3).flat();
  // Native first, then adapted, legacy and unknown (the sort below keeps that rank).
  const localRouteCandidates = groupRows.flatMap((routes) => {
    const sequence = buildPoolRouteSequence({ routes, onlineNodeIds, now, alternatives });
    return sequence.ok ? sequence.candidates : [];
  });
  const routeModeRank = (candidate: (typeof localRouteCandidates)[number]) => {
    const mode = executionByMember.get(candidate.poolMemberId)?.mode;
    return mode === "native" ? 0 : mode === "adapted" ? 1 : 2;
  };
  // Estimates never fail closed; they only prefer members whose full estimate
  // (media included) still fits the same ceiling as admission.
  const estimateFitIds = new Set(
    operation.contextCount
      ? eligibleMembers
          .filter((member) =>
            contextTokensFitCeiling({
              tokens: operation.contextCount!.tokens,
              physicalMaxContext: member.instance?.physicalMaxContext,
              effectiveContextCeiling: configuredContextCeilingForMember(member),
              contextMargin: contextMarginForMember(member),
            }),
          )
          .map((member) => member.id)
      : eligibleMembers.map((member) => member.id),
  );
  const estimateFitRank = (poolMemberId: string) => (estimateFitIds.has(poolMemberId) ? 0 : 1);
  // PRIMARY members are always local. Native compatibility is the first class;
  // member weight remains only as a stable pre-affinity order (new
  // conversations treat weight as a proportional share inside ranking).
  let routeCandidates = [...localRouteCandidates].sort(
    (left, right) =>
      routeModeRank(left) - routeModeRank(right) ||
      estimateFitRank(left.poolMemberId) - estimateFitRank(right.poolMemberId) ||
      right.weight - left.weight ||
      left.poolMemberId.localeCompare(right.poolMemberId),
  );
  if (routeCandidates.length === 0) {
    // (b) No healthy local member.
    const overflow = await tryPublicOverflow(
      "NO_COMPATIBLE_HEALTHY_PRIMARY",
      async () => undefined,
    );
    if (overflow.kind === "response") return overflow.response;
    const externalFailure = terminalExternalFailure(overflow);
    const failure = externalFailure ?? "disconnected";
    await operation.dispose?.();
    await failPoolRelayMetadata({ relayRequestId, startedAt, failure });
    // No member is routable now (not ready, node offline, or every target waiting out its
    // health backoff): say so, rather than blame a connection the caller cannot see.
    return operationFailureResponse(
      operation,
      failure,
      externalFailure
        ? undefined
        : "No member of this pool can serve the request right now. Retry shortly.",
    );
  }

  const memberById = new Map(eligibleMembers.map((member) => [member.id, member] as const));
  // An `:external` caller with an external plan leaves the local queue after
  // the pool's one max wait (pool_advanced.maxWaitMs), then runs the external phase.
  const externalAfterWaitMs =
    external.consent && (target.externalMemberCount > 0 || external.consent.ownKeyProviderModelId)
      ? (eligibleMembers[0]?.pool.maxWaitMs ?? null)
      : null;
  // Local wait per admission (X1): "shortened" waits min(B, E) and then runs
  // the external phase once (one external phase per request; precommit
  // failover across external members follows the existing retry rules);
  // after an external phase that did not dispatch, the same
  // candidates wait the rest, B - min(B, E) ("remaining"), so `:external`
  // never gets less local service than the plain name; every later admission
  // waits the full budget ("full"). Without an external plan it is "full".
  let localWaitMode: "shortened" | "remaining" | "full" =
    externalAfterWaitMs !== null ? "shortened" : "full";
  // Saturation S-A: the spill-over plan (cache-holder wait) and the local wait
  // clock. A "shortened" round after the first (a pre-commit retry) re-anchors
  // to the FIRST local attempt's database-clock schedule (AdmissionAttempt.
  // schedule), so it reuses the original spill instant and external deadline
  // exactly; lock waits before its transaction cannot extend them. Other
  // later rounds ("remaining"/"full" budgets are fresh by design) measure the
  // remaining spill window from the process-monotonic anchor below; only that
  // duration uses the process clock, the store turns it into a DB instant.
  let cacheHolderPlan: CacheHolderPlan | null = null;
  let localWaitAnchorMs: number | null = null;
  let firstLocalAttemptId: string | null = null;
  let cacheHolderWaitedMs: number | null = null;
  // The member the planned (spill-over) admission granted. HOLDER_WAITED /
  // HOLDER_SPILLED describe only that admission; a member serving after a
  // pre-commit failover keeps the ordinary affinity outcome.
  let cacheHolderAdmittedMemberId: string | null = null;
  const localWaitElapsedMs = () =>
    localWaitAnchorMs === null ? 0 : Math.floor(performance.now() - localWaitAnchorMs);
  const admissionCandidateForRoute = (
    candidate: (typeof routeCandidates)[number],
    candidateOrder: number,
    holderInRound: boolean,
  ) => {
    const member = memberById.get(candidate.poolMemberId);
    if (!member) return null;
    const admission = poolAdmissionCandidate(member, candidateOrder, relayDeadlineMs);
    if (!admission) return null;
    // Shortened rounds are scheduled from the first attempt's DB-clock anchor
    // (see admitLocalCandidates), so they pass the ORIGINAL window and budget.
    const anchored = externalAfterWaitMs !== null && localWaitMode === "shortened";
    const elapsedMs = anchored ? 0 : localWaitElapsedMs();
    const notBeforeMs = spillDelayMs(
      cacheHolderPlan,
      candidate.poolMemberId,
      holderInRound,
      elapsedMs,
    );
    const scheduled = notBeforeMs === undefined ? admission : { ...admission, notBeforeMs };
    if (externalAfterWaitMs === null || localWaitMode === "full") return scheduled;
    const memberBudgetMs = effectiveMemberWaitBudget(member);
    return {
      ...scheduled,
      // The store counts this budget from the (first round's) spill instant,
      // so the external phase starts at max(notBefore) + min(B, E), never
      // while a cold local member is free and eligible, and a retry round
      // never waits another full E (no N x E total).
      waitBudgetMs: anchored
        ? (localAdmissionWaitBudget(memberBudgetMs, externalAfterWaitMs) ?? 0)
        : resumedLocalWaitBudget(memberBudgetMs, externalAfterWaitMs),
    };
  };
  /** Admission candidates of one round, in route order (candidateOrder = index). */
  const admissionCandidatesForRoutes = (
    candidates: readonly (typeof routeCandidates)[number][],
  ) => {
    const plan = cacheHolderPlan;
    const holderInRound =
      plan !== null &&
      candidates.some(({ poolMemberId }) => plan.holderMemberIds.has(poolMemberId));
    return candidates.map((candidate, candidateOrder) =>
      admissionCandidateForRoute(candidate, candidateOrder, holderInRound),
    );
  };
  const admitLocalCandidates = async (
    runtime: CapacityAdmissionRuntime,
    initialCandidates: NonNullable<ReturnType<typeof admissionCandidateForRoute>>[],
  ) => {
    let candidates = initialCandidates;
    // A member whose lease is lost while confirming ownership is excluded and
    // the remaining members are re-admitted (each retry is a new attempt);
    // LEASE_LOST surfaces only when no member is left or the deadline passed.
    while (true) {
      const attemptId = crypto.randomUUID();
      // Every shortened attempt after the first (pre-commit and lease-loss
      // retries alike) re-anchors to the FIRST local attempt's DB schedule.
      const schedule =
        firstLocalAttemptId !== null &&
        externalAfterWaitMs !== null &&
        localWaitMode === "shortened"
          ? {
              anchorAttemptId: firstLocalAttemptId,
              spillDelayMs: cacheHolderPlan?.windowMs ?? 0,
            }
          : undefined;
      firstLocalAttemptId ??= attemptId;
      const admission = await acquireCapacityWithTelemetry({
        runtime,
        relayRequestId,
        attempt: {
          requestId: crypto.randomUUID(),
          relayRequestId,
          attemptId,
          ownerId: target.ownerUserId,
          sourceKind: "POOL",
          poolId: target.id,
          basePriority: NORMAL_PRIORITY_RANK,
          // S-C: the grant's queue priority (if set) replaces the pool/member
          // priority for this grantee's waiters; the store reads it.
          priorityShareId: target.shareId,
          // S-C: the warm sessions this request continues, so its lease can
          // be told apart from an idle slot holding a protected session.
          warmSessionIds: Object.values(affinityDecision?.matchedSessionIds ?? {}),
          connectionOwner: "model-api",
          deadlineAt: new Date(relayDeadlineMs),
          candidates,
          ...(schedule ? { schedule } : {}),
          // The shortened local phase of an `:external` caller with an external
          // plan must not fail open on metric-FULL members: it goes external.
          metricFailOpen: !(externalAfterWaitMs !== null && localWaitMode === "shortened"),
        },
        signal: request.signal,
      });
      if (admission.state !== "LEASE_LOST") return admission;
      candidates = candidates
        .filter(
          (candidate) =>
            candidate.executionTargetId !== admission.executionTargetId ||
            (admission.poolMemberId !== undefined &&
              candidate.poolMemberId !== admission.poolMemberId),
        )
        .map((candidate, candidateOrder) => ({ ...candidate, candidateOrder }));
      if (
        candidates.length === 0 ||
        request.signal.aborted ||
        remainingRelayBudgetMs(relayDeadlineMs) <= 0
      )
        return admission;
    }
  };
  let affinityDecision: AffinityDecision | null = null;
  const affinityPayload = operation.contextInput ?? operation.adaptation?.payload ?? null;
  const affinityPolicy: AffinityPolicy =
    eligibleMembers[0] && operation.family !== "embeddings"
      ? affinityPolicyForMember(eligibleMembers[0])
      : {
          enabled: false,
          ttlSeconds: 3600,
          maxRecords: 10_000,
          prefixWeight: 100,
          conversationWeight: 150,
          confirmedCacheWeight: 250,
          loadPenaltyWeight: 100,
          residencyWeight: 100,
        };
  const protectionPolicy = warmProtectionPolicyForMember(eligibleMembers[0]);
  if (requestedSurface && affinityPayload && affinityPolicy.enabled) {
    const affinityTargets = routeCandidates.flatMap((candidate) => {
      const member = memberById.get(candidate.poolMemberId);
      const affinityTarget = member
        ? affinityTargetForMember(
            member,
            requestedSurface,
            executionByMember.get(member.id),
            candidate.health,
          )
        : null;
      const capacity = member?.instance;
      return affinityTarget && member && capacity
        ? [
            {
              ...affinityTarget,
              weight: member.weight,
              lastRoutedAt: member.target.lastRoutedAt,
              requestTokens: (nativeCounts.get(member.id) ?? operation.contextCount)?.tokens ?? 0,
              kvBudgetTokens: protectionKvBudgetTokens(
                protectionEngineKind(capacity.engine),
                capacity.kvBudgetTokens,
              ),
              slots: capacity.hardConcurrencyLimit,
              engineKind: protectionEngineKind(capacity.engine),
            },
          ]
        : [];
    });
    if (affinityTargets.length === routeCandidates.length) {
      try {
        affinityDecision = await rankAffinityTargets({
          ownerId: requester.userId,
          resourceOwnerId: target.ownerUserId,
          poolId: target.id,
          securityScope: requester.limitKey,
          accessGrantId: target.shareId,
          policy: affinityPolicy,
          surface: requestedSurface,
          payload: affinityPayload,
          headers: request.headers,
          targets: affinityTargets,
          // S-C: even one member must know whether this is a continuation
          // (only protection needs it: a pool without it pays no extra reads).
          scoreSingleTarget: Boolean(capacityRuntime) && protectionPolicy.enabled,
          collectPrefixEvidence:
            Boolean(capacityRuntime) &&
            protectionPolicy.enabled &&
            (protectionPolicy.evictionFeedbackEnabled ?? true),
          evictionFeedbackEnabled: protectionPolicy.evictionFeedbackEnabled ?? true,
        });
        const affinityOrder = new Map(
          affinityDecision.orderedTargetIds.map((executionTargetId, index) => [
            executionTargetId,
            index,
          ]),
        );
        routeCandidates = routeCandidates
          .map((candidate, originalIndex) => ({ candidate, originalIndex }))
          .sort((left, right) => {
            const classDifference = routeModeRank(left.candidate) - routeModeRank(right.candidate);
            if (classDifference !== 0) return classDifference;
            const leftTarget = memberById.get(left.candidate.poolMemberId)?.target.id;
            const rightTarget = memberById.get(right.candidate.poolMemberId)?.target.id;
            return (
              (leftTarget
                ? (affinityOrder.get(leftTarget) ?? left.originalIndex)
                : left.originalIndex) -
                (rightTarget
                  ? (affinityOrder.get(rightTarget) ?? right.originalIndex)
                  : right.originalIndex) || left.originalIndex - right.originalIndex
            );
          })
          .map(({ candidate }) => candidate);
      } catch {
        // Affinity is optional and never makes an otherwise valid route unavailable.
        affinityDecision = null;
      }
    }
  }
  // Metric routing rules (S-B part 2), after compatibility and affinity:
  // metric-FULL members are dropped (all kept when every one is FULL; then
  // admission fails open, except an `:external` caller's shortened local
  // phase), and `avoid` members rank last. Grant time re-checks FULL.
  const metricOrder = await applyMetricRoutingVerdicts(routeCandidates, {
    memberIdOf: (candidate) => memberById.get(candidate.poolMemberId)?.memberId ?? "",
  });
  routeCandidates = metricOrder.candidates;
  if (metricOrder.allFull) {
    console.warn("[model-api] every pool candidate is metric-FULL", {
      poolId: target.id,
      relayRequestId,
    });
  }
  // Saturation S-C: warm-session protection (redirect-only). A new session
  // avoids members whose idle capacity holds protected warm sessions (including
  // the requester's own; a session an active lease is serving holds a busy
  // slot, not an idle one): such members route last, and with an external plan
  // they are left out of the first local admission (or, when nothing else can
  // serve, the request goes external first). It needs the affinity decision to tell a
  // continuation (never redirected) from a new session, so without one
  // nothing changes. Like affinity, it is an optimization only.
  let protectionInitialCandidates: typeof routeCandidates | null = null;
  let protectionExternalFirst = false;
  if (capacityRuntime && affinityDecision && protectionPolicy.enabled) {
    const decision = affinityDecision;
    const affineMember = (poolMemberId: string) => {
      const executionTargetId = memberById.get(poolMemberId)?.target.id;
      return executionTargetId ? isAffinityTargetWarm(decision, executionTargetId) : false;
    };
    try {
      const verdicts = await assessWarmProtection({
        ownerId: target.ownerUserId,
        policy: protectionPolicy,
        members: routeCandidates.flatMap(({ poolMemberId }) => {
          const member = memberById.get(poolMemberId);
          const capacity = member?.instance;
          if (!member || !capacity) return [];
          return [
            {
              poolMemberId,
              capacityId: capacity.id,
              slots: capacity.hardConcurrencyLimit,
              // Token mode uses the engine KV budget (protocol 2.7) when the
              // engine reports one; llama.cpp stays slot-based with a
              // smaller window (assessWarmProtection).
              kvBudgetTokens: capacity.kvBudgetTokens,
              engineKind: protectionEngineKind(capacity.engine),
              affine: affineMember(poolMemberId),
              requestTokens:
                (nativeCounts.get(poolMemberId) ?? operation.contextCount)?.tokens ?? 0,
            },
          ];
        }),
        source: warmProtectionSource,
      });
      const routing = protectionRouting({
        candidates: routeCandidates.map(({ poolMemberId }) => ({
          poolMemberId,
          affine: affineMember(poolMemberId),
        })),
        verdicts,
        externalPlan:
          externalAfterWaitMs !== null && eligibleMembers[0]?.pool.paidWarmProtection === true,
      });
      const candidateById = new Map(
        routeCandidates.map((candidate) => [candidate.poolMemberId, candidate] as const),
      );
      const resolve = (ids: readonly string[]) =>
        ids.flatMap((id) => {
          const candidate = candidateById.get(id);
          return candidate ? [candidate] : [];
        });
      routeCandidates = resolve(routing.order);
      protectionInitialCandidates =
        routing.initial.length === routing.order.length ? null : resolve(routing.initial);
      protectionExternalFirst = routing.externalFirst;
    } catch {
      protectionInitialCandidates = null;
      protectionExternalFirst = false;
    }
  }
  let capacityLease: Awaited<ReturnType<CapacityAdmissionRuntime["acquire"]>> | undefined;
  let selectedRouteCandidates = routeCandidates;
  const memberEffectiveCeiling = (poolMemberId: string) => {
    const member = memberById.get(poolMemberId);
    if (!member) return null;
    const ceiling = effectiveContextCeilingTokens(
      member.instance?.physicalMaxContext,
      configuredContextCeilingForMember(member),
    );
    return ceiling === null ? null : ceiling - contextMarginForMember(member);
  };
  /** Only complete matching runtime identities count tokens the same way. */
  const sameRuntimeIdentity = (fromMemberId: string, toMemberId: string) => {
    const from = memberById.get(fromMemberId)?.instance;
    const to = memberById.get(toMemberId)?.instance;
    return Boolean(
      from &&
        to &&
        from.runtimeIdentityKey &&
        from.runtimeIdentityKey === to.runtimeIdentityKey &&
        from.runtimeModel === to.runtimeModel &&
        from.runtimeRevision === to.runtimeRevision,
    );
  };
  const attemptedLocalMembers = new Set<string>();
  let mostPermissiveRejection: ContextExceededDetails | undefined;
  const remainingContextRoutes = (memberId: string, details: ContextExceededDetails) => {
    attemptedLocalMembers.add(memberId);
    if (
      !mostPermissiveRejection ||
      details.effectiveContextCeilingTokens - details.contextMarginTokens >
        mostPermissiveRejection.effectiveContextCeilingTokens -
          mostPermissiveRejection.contextMarginTokens
    )
      mostPermissiveRejection = details;
    // A different tokenizer can fit even on a smaller nominal context window,
    // so each such member is tried at most once and its own gate decides. A
    // member with the same runtime identity counts the same tokens: one whose
    // usable ceiling is below this count can never fit and is not tried (a busy
    // one would otherwise answer a retryable 429 for a request that cannot fit).
    return routeCandidates.filter((route) => {
      if (attemptedLocalMembers.has(route.poolMemberId)) return false;
      if (!sameRuntimeIdentity(memberId, route.poolMemberId)) return true;
      const ceiling = memberEffectiveCeiling(route.poolMemberId);
      return ceiling === null || ceiling >= details.estimatedInputTokens;
    });
  };
  const respondLocalContextCeiling = async (details: ContextExceededDetails) => {
    const overflow = await tryPublicOverflow("LOCAL_CONTEXT_CEILING", async () => undefined);
    if (overflow.kind === "response") return overflow.response;
    const lostAccess = terminalExternalFailure(overflow);
    await operation.dispose?.();
    if (lostAccess) {
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure: lostAccess });
      return operationFailureResponse(operation, lostAccess);
    }
    await failPoolRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "request_too_large",
    }).catch(metadataUpdateError);
    return contextExceededResponse(
      operation,
      "Request context exceeds the configured execution capacity ceiling.",
      mostPermissiveRejection ?? details,
    );
  };
  const applyMemberContextCount = async (poolMemberId: string) => {
    const member = memberById.get(poolMemberId);
    if (!member) return;
    operation.contextCount = nativeCounts.get(poolMemberId) ?? initialContextCount;
    let count = nativeCounts.get(poolMemberId);
    if (!count && capacityRuntime && operation.contextInput) {
      const selected = servedRoute(member);
      if (isEndpointConnected(selected, new Set(manager.getOnlineNodeIds()))) {
        const next = await nativeContextCount({
          request,
          selected,
          operation,
          manager,
          relayRequestId,
          requester,
          pool: {
            id: target.id,
            memberId: member.memberId,
            contributedShareId: member.contributedShareId,
            ownerUserId: target.ownerUserId,
            shareId: target.shareId,
          },
        });
        if (next) {
          count = next;
          nativeCounts.set(member.id, next);
        }
      }
    }
    if (!count) return;
    operation.contextCount = count;
    await updateContextCountMetadata(relayRequestId, count);
    const ceiling = effectiveContextCeilingTokens(
      member.instance?.physicalMaxContext,
      configuredContextCeilingForMember(member),
    );
    const margin = contextMarginForMember(member);
    if (
      count.exact &&
      !contextFitsLimits({
        count,
        physicalMaxContext: member.instance?.physicalMaxContext,
        effectiveContextCeiling: configuredContextCeilingForMember(member),
        contextMargin: margin,
      })
    ) {
      throw new ContextCeilingExceededError({
        estimatedInputTokens: count.tokens,
        estimateMethod: count.method,
        contextMarginTokens: margin,
        effectiveContextCeilingTokens: ceiling ?? 1,
      });
    }
  };
  if (capacityRuntime && affinityDecision) {
    try {
      cacheHolderPlan = await planCacheHolderWait({
        decision: affinityDecision,
        candidates: routeCandidates.map(({ poolMemberId }) => ({
          poolMemberId,
          executionTargetId: memberById.get(poolMemberId)?.target.id,
        })),
        poolOverrideMs: undefined,
        speedSource: prefillSpeedSource,
      });
    } catch {
      // Like affinity itself, the wait is an optimization only.
      cacheHolderPlan = null;
    }
  }
  if (capacityRuntime && protectionExternalFirst) {
    // S-C decision step 4: only PROTECTED (or PROTECTED + FULL) members and a
    // live external plan: go external now. When the attempt does not
    // dispatch, protection never blocks: admit over every member (PROTECTED
    // last, oldest/cheapest first) with the full local budget, since the one
    // external phase of this request is used up.
    const overflow = await tryPublicOverflow("LOCAL_SATURATED_PROTECTED", async () => undefined);
    if (overflow.kind === "response") return overflow.response;
    // A cancel or a lost access (#76) ends the request; never resume locally.
    const terminal = terminalExternalFailure(overflow);
    if (terminal) {
      await operation.dispose?.();
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure: terminal });
      return operationFailureResponse(operation, terminal);
    }
    localWaitMode = "full";
  }
  if (capacityRuntime) {
    localWaitAnchorMs = performance.now();
    // S-C: with an external plan, PROTECTED members sit out the first
    // admission; every later round (resume after the external phase,
    // pre-commit retries) may use them.
    const admissionCandidates = admissionCandidatesForRoutes(
      protectionInitialCandidates ?? routeCandidates,
    );
    if (admissionCandidates.some((candidate) => candidate === null)) {
      await operation.dispose?.();
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure: "unsupported_capability" });
      return operationFailureResponse(operation, "unsupported_capability");
    }
    try {
      capacityLease = await admitLocalCandidates(
        capacityRuntime,
        admissionCandidates.filter((candidate) => candidate !== null),
      );
    } catch {
      await operation.dispose?.();
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure: "unknown" });
      return operationFailureResponse(operation, "unknown");
    }
    if (capacityLease.state === "LEASE_LOST") {
      // Every local member's lease was lost while confirming ownership: a
      // retryable precommit failure of this process's leases, never a rate
      // limit. Try the consented external tier, else answer 503.
      const overflow = await tryPublicOverflow(
        "RETRYABLE_PRECOMMIT_PRIMARY_FAILURE",
        async () => undefined,
      );
      if (overflow.kind === "response") return overflow.response;
      // A cancel or a lost access (#76) observed by the external phase, or a
      // client that left meanwhile, is terminal and outranks the lease loss.
      const leaseLostFailure: ModelApiFailure = request.signal.aborted
        ? "cancelled"
        : (terminalExternalFailure(overflow) ?? "capacity_lease_lost");
      await operation.dispose?.();
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure: leaseLostFailure });
      return operationFailureResponse(operation, leaseLostFailure);
    }
    if (capacityLease.state !== "ADMITTED" || !capacityLease.lease.poolMemberId) {
      // (a) Local wait expired (member/pool budget, or externalAfterWaitMs
      // for a consented `:external` caller), measured on the database clock.
      const overflow = await tryPublicOverflow("LOCAL_WAIT_EXPIRED", async () => undefined);
      if (overflow.kind === "response") return overflow.response;
      // A cancel or a lost access (#76) ends the request; never resume.
      const lostAccess = terminalExternalFailure(overflow);
      if (overflow.kind === "unavailable" && !lostAccess && localWaitMode === "shortened") {
        // External did not dispatch: resume the local wait for the same
        // candidates with the rest of the budget (queue position is not kept).
        localWaitMode = "remaining";
        try {
          capacityLease = await admitLocalCandidates(
            capacityRuntime,
            admissionCandidatesForRoutes(routeCandidates).flatMap((resumed) =>
              resumed ? [resumed] : [],
            ),
          );
        } catch {
          await operation.dispose?.();
          await failPoolRelayMetadata({ relayRequestId, startedAt, failure: "unknown" });
          return operationFailureResponse(operation, "unknown");
        } finally {
          localWaitMode = "full";
        }
      }
      if (capacityLease.state !== "ADMITTED" || !capacityLease.lease.poolMemberId) {
        // A client that left during the (resumed) local wait is a cancel
        // (499), not the wait's own rate_limited / 429.
        const failure: ModelApiFailure = request.signal.aborted
          ? "cancelled"
          : (lostAccess ??
            (capacityLease.state === "LEASE_LOST" ? "capacity_lease_lost" : "rate_limited"));
        await operation.dispose?.();
        await failPoolRelayMetadata({ relayRequestId, startedAt, failure });
        return operationFailureResponse(operation, failure);
      }
    }
    // The admitted route (rows and candidates are keyed by member and target).
    const selectedPoolMemberId = routeKey({
      poolMemberId: capacityLease.lease.poolMemberId,
      executionTargetId: capacityLease.lease.executionTargetId,
    });
    // Telemetry: how long the local admission held this request for the cache
    // holder (the window's share of the wait; beyond it any wait is ordinary
    // saturation, not a holder wait).
    if (cacheHolderPlan) {
      cacheHolderWaitedMs = Math.round(Math.min(localWaitElapsedMs(), cacheHolderPlan.windowMs));
      cacheHolderAdmittedMemberId = selectedPoolMemberId;
    }
    try {
      await applyMemberContextCount(selectedPoolMemberId);
    } catch (error) {
      const admittedLease = capacityLease.lease;
      if (error instanceof ContextCeilingExceededError) {
        const larger = remainingContextRoutes(selectedPoolMemberId, error.details);
        await settleRelayCleanup([() => capacityRuntime.release(admittedLease)]);
        capacityLease = undefined;
        if (larger.length > 0) {
          selectedRouteCandidates = larger;
        } else {
          return respondLocalContextCeiling(error.details);
        }
      } else {
        await settleRelayCleanup([
          () => capacityRuntime.release(admittedLease),
          () => operation.dispose?.(),
        ]);
        if (error instanceof LocalSendRefused && error.denial !== "MEMBER_UNAVAILABLE") {
          const countFailure = LOCAL_SEND_DENIAL_FAILURE[error.denial];
          externalAttempt.accessLost = true;
          await failPoolRelayMetadata({ relayRequestId, startedAt, failure: countFailure });
          return operationFailureResponse(operation, countFailure);
        }
        await failPoolRelayMetadata({ relayRequestId, startedAt, failure: "unknown" }).catch(
          metadataUpdateError,
        );
        return operationFailureResponse(operation, "unknown");
      }
    }
    if (capacityLease?.state === "ADMITTED") {
      selectedRouteCandidates = [
        ...routeCandidates.filter(({ poolMemberId }) => poolMemberId === selectedPoolMemberId),
        ...routeCandidates.filter(({ poolMemberId }) => poolMemberId !== selectedPoolMemberId),
      ];
    }
  }
  try {
    globalLease = limiter.acquireGlobal({
      tokenId: requester.limitKey,
      userId: requester.userId,
    });
  } catch (error) {
    await settleRelayCleanup([
      () =>
        capacityLease?.state === "ADMITTED"
          ? capacityRuntime?.release(capacityLease.lease)
          : undefined,
      () => operation.dispose?.(),
    ]);
    if (error instanceof ModelApiLimitError) {
      await failPoolRelayMetadata({ relayRequestId, startedAt, failure: error.failure });
      return operationFailureResponse(operation, error.failure);
    }
    await failPoolRelayMetadata({ relayRequestId, startedAt, failure: "unknown" }).catch(
      metadataUpdateError,
    );
    return operationFailureResponse(operation, "unknown");
  }
  let finalFailure: ModelApiFailure = "unknown";
  // The last member's error answer, kept for the request row when every member failed.
  let lastUpstreamErrorExcerpt: string | null = null;
  // H1: set when the caller's own per-token/per-user cap stopped the retry
  // loop. That is never a fallback trigger; the caller gets 429.
  let callerLimitReached = false;
  // #76: set when the pool owner lost access while this request waited. The
  // pool is then unavailable to everyone, the external tier included.
  let poolOwnerLostAccess = false;
  let attemptCount = 0;
  // One wall-clock deadline covers body rebuild/reopen, every upstream attempt,
  // and retry bookkeeping. Pool size never multiplies the public timeout.
  let cumulativeRequestBytes = 0;
  let cumulativeResponseBytes = 0;
  const releaseCapacityAttempt = async () => {
    if (capacityLease?.state !== "ADMITTED") return;
    const lease = capacityLease.lease;
    capacityLease = undefined;
    const localGlobalLease = globalLease;
    globalLease = undefined;
    await settleRelayCleanup([
      () => localGlobalLease?.release(),
      () => capacityRuntime?.release(lease),
    ]);
  };

  for (let candidateIndex = 0; candidateIndex < selectedRouteCandidates.length; candidateIndex++) {
    let candidate = selectedRouteCandidates[candidateIndex]!;
    if (capacityRuntime && capacityLease?.state !== "ADMITTED") {
      const remaining = selectedRouteCandidates.slice(candidateIndex);
      const admissionCandidates = admissionCandidatesForRoutes(remaining).map((resolved) => {
        if (!resolved)
          throw new Error("Capacity-enabled pool member lost execution target identity.");
        return resolved;
      });
      try {
        capacityLease = await admitLocalCandidates(capacityRuntime, admissionCandidates);
      } catch {
        finalFailure = "unknown";
        break;
      }
      if (capacityLease.state === "LEASE_LOST") {
        finalFailure = "capacity_lease_lost";
        localWaitMode = "full";
        break;
      }
      if (
        (capacityLease.state !== "ADMITTED" || !capacityLease.lease.poolMemberId) &&
        localWaitMode === "shortened"
      ) {
        // (a) inside the retry loop: this round's shortened wait expired.
        const overflow = await tryPublicOverflow("LOCAL_WAIT_EXPIRED", async () => undefined);
        if (overflow.kind === "response") return overflow.response;
        if (overflow.kind === "unavailable" && !terminalExternalFailure(overflow)) {
          localWaitMode = "remaining";
          try {
            capacityLease = await admitLocalCandidates(
              capacityRuntime,
              admissionCandidatesForRoutes(remaining).map((resumed) => {
                if (!resumed)
                  throw new Error("Capacity-enabled pool member lost execution target identity.");
                return resumed;
              }),
            );
          } catch {
            finalFailure = "unknown";
            break;
          } finally {
            localWaitMode = "full";
          }
        } else localWaitMode = "full";
      }
      if (capacityLease.state !== "ADMITTED" || !capacityLease.lease.poolMemberId) {
        finalFailure =
          capacityLease.state === "LEASE_LOST" ? "capacity_lease_lost" : "rate_limited";
        break;
      }
      const admittedPoolMemberId = routeKey({
        poolMemberId: capacityLease.lease.poolMemberId,
        executionTargetId: capacityLease.lease.executionTargetId,
      });
      try {
        await applyMemberContextCount(admittedPoolMemberId);
      } catch (error) {
        await releaseCapacityAttempt();
        if (error instanceof ContextCeilingExceededError) {
          const larger = remainingContextRoutes(admittedPoolMemberId, error.details);
          if (larger.length > 0) {
            selectedRouteCandidates = larger;
            candidateIndex = -1;
            continue;
          }
          globalLease?.release();
          return respondLocalContextCeiling(error.details);
        }
        if (error instanceof LocalSendRefused && error.denial !== "MEMBER_UNAVAILABLE") {
          finalFailure = LOCAL_SEND_DENIAL_FAILURE[error.denial];
          poolOwnerLostAccess = true;
          externalAttempt.accessLost = true;
          break;
        }
        finalFailure = "unknown";
        break;
      }
      const selectedIndex = selectedRouteCandidates.findIndex(
        ({ poolMemberId }, index) =>
          index >= candidateIndex && poolMemberId === admittedPoolMemberId,
      );
      if (selectedIndex < 0) {
        const unexpectedLease = capacityLease.lease;
        await settleRelayCleanup([() => capacityRuntime.release(unexpectedLease)]);
        capacityLease = undefined;
        finalFailure = "unknown";
        break;
      }
      if (selectedIndex !== candidateIndex) {
        const [selected] = selectedRouteCandidates.splice(selectedIndex, 1);
        if (selected) selectedRouteCandidates.splice(candidateIndex, 0, selected);
      }
      candidate = selectedRouteCandidates[candidateIndex]!;
    }
    if (!globalLease) {
      try {
        globalLease = limiter.acquireGlobal({
          tokenId: requester.limitKey,
          userId: requester.userId,
        });
      } catch (error) {
        await releaseCapacityAttempt();
        finalFailure = error instanceof ModelApiLimitError ? error.failure : "unknown";
        callerLimitReached = error instanceof ModelApiLimitError;
        break;
      }
    }
    if (remainingRelayBudgetMs(relayDeadlineMs) === 0) {
      finalFailure = "timeout";
      break;
    }
    const member = memberById.get(candidate.poolMemberId);
    if (!member) continue;
    if (!capacityRuntime)
      operation.contextCount = nativeCounts.get(member.id) ?? initialContextCount;

    let cliLease: ModelApiLimitLease;
    try {
      cliLease = limiter.acquireCli(candidate.nodeId);
    } catch (error) {
      if (error instanceof ModelApiLimitError) {
        finalFailure = error.failure;
        await releaseCapacityAttempt();
        continue;
      }
      finalFailure = "unknown";
      await releaseCapacityAttempt();
      break;
    }

    // The half-open trial this attempt claimed, if any; given back on every
    // exit that sends nothing (C4-1), fenced on its own timestamp.
    let claimedTrialAt: Date | null = null;
    const releaseUnusedTrial = async () => {
      const trialStartedAt = claimedTrialAt;
      claimedTrialAt = null;
      if (trialStartedAt)
        await releaseTargetHalfOpenTrial({
          executionTargetId: candidate.executionTargetId,
          trialStartedAt,
        }).catch(metadataUpdateError);
    };
    if (candidate.health === "HALF_OPEN") {
      let claimed: number;
      const trialStartedAt = new Date();
      try {
        claimed = await markTargetHalfOpenTrial({
          now: trialStartedAt,
          executionTargetId: candidate.executionTargetId,
          // `buildPoolRouteSequence` emits this only for a degraded route with
          // no healthy alternative. Passing explicit authority keeps a
          // degraded row from being claimed by other half-open callers.
          allowDegradedFallback: candidate.degradedFallback,
        });
      } catch {
        await settleRelayCleanup([() => cliLease.release()]);
        finalFailure = "unknown";
        await releaseCapacityAttempt();
        break;
      }
      if (claimed === 0) {
        await settleRelayCleanup([() => cliLease.release()]);
        await releaseCapacityAttempt();
        continue;
      }
      claimedTrialAt = trialStartedAt;
    }
    let builtRequest: BuiltRelayRequest;
    const execution = executionByMember.get(member.id);
    const adaptedSource =
      execution?.mode === "adapted" && execution.nativeSurface
        ? protocolSurface(execution.nativeSurface)
        : null;
    try {
      builtRequest = await operation.buildRequest(candidate.upstreamModelId);
      if (adaptedSource && operation.adaptation) {
        if (!canonicalAdaptationRequest)
          throw new AdapterError(
            "unsupported_adaptation",
            "Request is outside the strict adapted subset.",
          );
        const rendered = renderForExecutionTarget({
          request: canonicalAdaptationRequest,
          target: adaptedSource,
          model: candidate.upstreamModelId,
          allowLossyDeveloperRoleCollapse: operation.adaptation.allowLossyDeveloperRoleCollapse,
          capabilities: effectivePoolMemberCapabilities(member),
          extras: compatExtrasFor(compatByMember.get(member.id)),
        });
        if (!(builtRequest.body instanceof Uint8Array)) await builtRequest.body.dispose();
        const adaptedHeaders = new Headers(builtRequest.headers);
        adaptedHeaders.delete("content-length");
        if (adaptedSource === "anthropic-messages") {
          adaptedHeaders.set("anthropic-version", "2023-06-01");
          adaptedHeaders.delete("anthropic-beta");
        } else {
          adaptedHeaders.delete("anthropic-version");
          adaptedHeaders.delete("anthropic-beta");
        }
        builtRequest = {
          headers: adaptedHeaders,
          body: new TextEncoder().encode(JSON.stringify(rendered)),
        };
      }
    } catch (error) {
      await releaseUnusedTrial();
      if (error instanceof AdapterError && operation.adaptation) {
        await settleRelayCleanup([
          () => cliLease.release(),
          () => globalLease?.release(),
          () =>
            capacityLease?.state === "ADMITTED"
              ? capacityRuntime?.release(capacityLease.lease)
              : undefined,
          () => operation.dispose?.(),
        ]);
        const canonicalError = {
          code: "invalid_request_error",
          message: error.message,
          parameter: error.parameter,
          upstreamStatus: 400,
        };
        const metadata = renderProtocolErrorMetadata(
          operation.adaptation.requestedSurface,
          canonicalError,
        );
        return new Response(
          JSON.stringify(
            renderProtocolError(operation.adaptation.requestedSurface, canonicalError),
          ),
          { status: metadata.status, headers: metadata.headers },
        );
      }
      await settleRelayCleanup([() => cliLease.release()]);
      finalFailure = "unknown";
      await recordTargetRelayFailure({
        executionTargetId: candidate.executionTargetId,
        trialStartedAt: claimedTrialAt,
        failure: "unknown",
      }).catch(metadataUpdateError);
      await releaseCapacityAttempt();
      continue;
    }
    // The runtime's request compatibility, on the exact body this member receives (native or
    // adapted). The pre-compat request is kept: a learned fix re-applies to it.
    const compatLaunch = compatByMember.get(member.id);
    const compatFamily = adaptedSource
      ? nativeRouteForSurface(adaptedSource).family
      : operation.family;
    const preCompatBuilt = builtRequest;
    if (compatLaunch) {
      const applied = applyCompatToBuilt({
        launch: compatLaunch,
        family: compatFamily,
        built: builtRequest,
        clientHeaders: request.headers,
        extra: compatExtraByLaunch.get(launchKeyString(compatLaunch)),
      });
      if (!applied.ok) {
        await releaseUnusedTrial();
        await settleRelayCleanup([
          () => cliLease.release(),
          () => globalLease?.release(),
          () =>
            capacityLease?.state === "ADMITTED"
              ? capacityRuntime?.release(capacityLease.lease)
              : undefined,
          () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
          () => operation.dispose?.(),
        ]);
        await failPoolRelayMetadata({
          relayRequestId,
          startedAt,
          failure: "unsupported_capability",
        }).catch(metadataUpdateError);
        return compatRefusalResponse(requestedSurface, applied.refusal);
      }
      builtRequest = applied.built;
      addCompatReport(compatTrace, applied.report);
    }
    let responseIdCapture =
      operation.responseStickiness && operation.family === "responses"
        ? createResponseIdCapture()
        : null;
    let attemptTimeoutMs = remainingRelayBudgetMs(relayDeadlineMs);
    if (attemptTimeoutMs === 0) {
      await releaseUnusedTrial();
      await settleRelayCleanup([
        () => cliLease.release(),
        () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      ]);
      finalFailure = "timeout";
      break;
    }
    attemptCount += 1;
    const attemptAffinityBase = requestedSurface
      ? affinityTargetForMember(
          member,
          requestedSurface,
          executionByMember.get(member.id),
          candidate.health,
        )
      : null;
    const servedAffinityTarget =
      attemptAffinityBase && affinityPolicy.enabled
        ? ((await captureAffinityTargetGenerations([attemptAffinityBase], target.id))[0] ?? null)
        : null;
    let attempt: ReturnType<typeof startRelayAttempt> | null = null;
    // When this attempt was handed to the relay: warm-prefix age for eviction
    // evidence is judged here, not at request arrival or after a long stream.
    let attemptDispatchedAt = new Date();
    let localExecution: LocalExecutionTelemetry = {
      selectedExecutionTargetId: member.target.id,
      selectedPoolMemberId: member.memberId,
      instance: member.instance,
      nativeSurface: execution?.nativeSurface ?? telemetrySurfaceForOperation(operation),
      requestedSurface: telemetrySurfaceForOperation(operation),
      adapterMode: adaptedSource ? "ADAPTED" : "NATIVE",
      adapterVersion: adaptedSource ? "1.0.0" : undefined,
      localAttemptId: crypto.randomUUID(),
      poolId: target.id,
      fallbackRoute: "local",
      contextCount: operation.contextCount,
      admission:
        capacityLease?.state === "ADMITTED"
          ? {
              attemptId: capacityLease.lease.attemptId,
              leaseId: capacityLease.lease.leaseId,
              fencingToken: capacityLease.lease.fencingToken,
            }
          : undefined,
    };
    routeIdentity = {
      fallbackRoute: "local",
      selectedExecutionTargetId: member.target.id,
      selectedRuntimeModelId: member.model.id,
      selectedPoolMemberId: member.memberId,
    };
    const attemptLeaseSignal =
      capacityLease?.state === "ADMITTED" ? capacityLease.lease.signal : undefined;
    const sendAttempt = (execution: LocalExecutionTelemetry, built: BuiltRelayRequest) =>
      startAuthorizedLocalRelayAttempt(
        localSendBinding(servedRoute(member), requester, {
          id: target.id,
          ownerUserId: target.ownerUserId,
          shareId: target.shareId,
          memberId: member.memberId,
          contributedShareId: member.contributedShareId,
          embeddingContract:
            operation.family === "embeddings" && external.requested
              ? target.embeddingContract
              : undefined,
        }),
        {
          requestId: execution.localAttemptId,
          manager,
          nodeId: candidate.nodeId,
          handle: member.instance.handle,
          family: adaptedSource ? nativeRouteForSurface(adaptedSource).family : operation.family,
          method: operation.method,
          path: adaptedSource ? nativeRouteForSurface(adaptedSource).path : operation.path,
          headers: built.headers,
          ...relayAttemptBody(built.body),
          timeoutMs: attemptTimeoutMs,
          abortSignal:
            capacityLease?.state === "ADMITTED"
              ? (capacityLease.lease.signal ?? request.signal)
              : request.signal,
          onResponseBodyChunk: (chunk) => {
            responseIdCapture?.push(chunk, operation.stream);
          },
          ...chatCountFirstRelayFields({
            family: adaptedSource ? nativeRouteForSurface(adaptedSource).family : operation.family,
            contextCount: operation.contextCount,
            contextInput: operation.contextInput,
            engineCountContext: member.instance?.engineCountContext,
            physicalMaxContext: member.instance?.physicalMaxContext,
            effectiveContextCeiling: configuredContextCeilingForMember(member),
            contextMargin: contextMarginForMember(member),
            manager,
            nodeId: candidate.nodeId,
            relayRequestId,
            operation,
          }),
        },
      );
    try {
      await startLocalExecutionTelemetry(relayRequestId, requester.userId, localExecution);
      attemptDispatchedAt = new Date();
      attemptedLocalMembers.add(member.id);
      attempt = await sendAttempt(localExecution, builtRequest);
    } catch (error) {
      attempt?.cancel("unknown");
      // Nothing was sent unless the attempt started: the trial goes back.
      if (!attempt) await releaseUnusedTrial();
      // Attempt-only finalization (the request moves on to the next member
      // or the post-loop finalizer); a no-op claim if no row was written.
      await recordLocalTerminal(
        relayRequestId,
        requester.userId,
        localExecution,
        rejectedRelayTerminal(error instanceof LocalSendRefused ? error.failure : "unknown"),
      ).catch(metadataUpdateError);
      await settleRelayCleanup([
        () => cliLease.release(),
        () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      ]);
      if (error instanceof LocalSendRefused) {
        await releaseCapacityAttempt();
        finalFailure = error.failure;
        if (error.denial === "MEMBER_UNAVAILABLE") {
          // Removed or disabled meanwhile: skipped like any unavailable member.
          continue;
        }
        // Owner or requester lost access, grant revoked, or the check failed:
        // no other member, no external phase. The member is not at fault.
        poolOwnerLostAccess = true;
        externalAttempt.accessLost = true;
        break;
      }
      finalFailure = "unknown";
      await recordTargetRelayFailure({
        executionTargetId: candidate.executionTargetId,
        trialStartedAt: claimedTrialAt,
        failure: "unknown",
      }).catch(metadataUpdateError);
      await releaseCapacityAttempt();
      continue;
    }
    if (!attempt) throw new Error("pool relay attempt was not initialized");

    try {
      let started = await attempt.started;
      // An engine 400 about a field or header this proxy can fix: send once more on the same
      // member with the fix, before any byte reached the client (the fix is remembered for the
      // launch only once that retry succeeded); a semantic field gets a clear refusal instead.
      if (
        compatLaunch &&
        !compatRetried &&
        (started.status === 400 || started.status === 422) &&
        builtRequest.body instanceof Uint8Array
      ) {
        const peeked = await peekStream(started.body, MAX_COMPAT_ERROR_BYTES);
        const retryBudgetMs = remainingRelayBudgetMs(relayDeadlineMs);
        const decided = !peeked.complete
          ? null
          : compatRetryDecision({
              launch: compatLaunch,
              family: compatFamily,
              status: started.status,
              errorText: decodeUtf8Bytes(peeked.prefix),
              sentBody: builtRequest.body,
              sentHeaders: builtRequest.headers,
            });
        // No time left for a second send: the engine's answer passes on.
        const decision = decided?.kind !== "refuse" && retryBudgetMs === 0 ? null : decided;
        if (decision) {
          const firstTerminal = await attempt.terminal;
          await recordLocalTerminal(
            relayRequestId,
            requester.userId,
            localExecution,
            firstTerminal,
          ).catch(metadataUpdateError);
          cumulativeRequestBytes += firstTerminal.requestBytes;
          cumulativeResponseBytes += firstTerminal.responseBytes;
        }
        const finishCompat = async (failure: ModelApiFailure, response: Response) => {
          await releaseUnusedTrial();
          await settleRelayCleanup([
            () => cliLease.release(),
            () => globalLease?.release(),
            () =>
              capacityLease?.state === "ADMITTED"
                ? capacityRuntime?.release(capacityLease.lease)
                : undefined,
            () => operation.dispose?.(),
          ]);
          await writeCompatTrace(relayRequestId, compatTrace);
          await failPoolRelayMetadata({
            relayRequestId,
            startedAt,
            failure,
            attemptCount,
            requestBytes: cumulativeRequestBytes,
            responseBytes: cumulativeResponseBytes,
          }).catch(metadataUpdateError);
          return response;
        };
        const refuseCompat = (refusal: CompatRefusal) =>
          finishCompat("unsupported_capability", compatRefusalResponse(requestedSurface, refusal));
        if (decision?.kind === "refuse") return await refuseCompat(decision.refusal);
        if (decision) {
          const launchKey = launchKeyString(compatLaunch);
          const extra = compatExtraByLaunch.get(launchKey) ?? { fixes: [], stripHeaders: [] };
          if (decision.kind === "learn") extra.fixes.push(decision.fix);
          else extra.stripHeaders.push(decision.name);
          compatExtraByLaunch.set(launchKey, extra);
          compatRetried = true;
          compatTrace.retried = true;
          const reapplied = applyCompatToBuilt({
            launch: compatLaunch,
            family: compatFamily,
            built: preCompatBuilt,
            clientHeaders: request.headers,
            extra,
          });
          if (!reapplied.ok) return await refuseCompat(reapplied.refusal);
          builtRequest = reapplied.built;
          addCompatReport(compatTrace, reapplied.report);
          attemptCount += 1;
          attemptTimeoutMs = retryBudgetMs;
          // The first attempt's error must not reach the stored-response capture.
          responseIdCapture =
            operation.responseStickiness && operation.family === "responses"
              ? createResponseIdCapture()
              : null;
          localExecution = { ...localExecution, localAttemptId: crypto.randomUUID() };
          try {
            await startLocalExecutionTelemetry(relayRequestId, requester.userId, localExecution);
            attemptDispatchedAt = new Date();
            attempt = await sendAttempt(localExecution, builtRequest);
          } catch (error) {
            const failure = error instanceof LocalSendRefused ? error.failure : "unknown";
            await recordLocalTerminal(
              relayRequestId,
              requester.userId,
              localExecution,
              rejectedRelayTerminal(failure),
            ).catch(metadataUpdateError);
            if (error instanceof LocalSendRefused && error.denial !== "MEMBER_UNAVAILABLE")
              externalAttempt.accessLost = true;
            return await finishCompat(failure, operationFailureResponse(operation, failure));
          }
          started = await attempt.started;
          if (started.status >= 200 && started.status < 300) {
            if (decision.kind === "learn")
              await recordLearnedFix(compatLaunch.key, decision.endpoint, decision.fix);
            else if (decision.remember) await recordLearnedHeader(compatLaunch.key, decision.name);
          }
        } else started = { ...started, body: peeked.body };
      }
      if (started.status >= 500 && shouldRetryRelayOperation(operation, "precommit_5xx")) {
        // What the runtime said, for the request row if no other member serves it.
        lastUpstreamErrorExcerpt =
          (await readUpstreamErrorExcerpt(started.body)) ?? lastUpstreamErrorExcerpt;
        attempt.cancel("upstream_5xx");
        const terminal = await attempt.terminal;
        await recordLocalTerminal(relayRequestId, requester.userId, localExecution, terminal).catch(
          metadataUpdateError,
        );
        cumulativeRequestBytes += terminal.requestBytes;
        cumulativeResponseBytes += terminal.responseBytes;
        await settleRelayCleanup([
          () => cliLease.release(),
          () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
        ]);
        finalFailure = "upstream_5xx";
        await recordTargetRelayFailure({
          executionTargetId: candidate.executionTargetId,
          trialStartedAt: claimedTrialAt,
          failure: targetHealthFailure("upstream_5xx", adaptedSource !== null),
        }).catch(metadataUpdateError);
        await releaseCapacityAttempt();
        continue;
      }

      let startedBody = started.body;
      if (started.status >= 400 && started.status < 500) {
        const errorBytes = await readStreamBytes(startedBody);
        const overflow = classifyEngineContextOverflow(started.status, decodeUtf8Bytes(errorBytes));
        if (overflow.overflow) {
          const thisCeiling = effectiveContextCeilingTokens(
            member.instance?.physicalMaxContext,
            configuredContextCeilingForMember(member),
          );
          // Retry each remaining engine at most once. Counts constrain only
          // matching runtime identities; another tokenizer gets its own gate.
          const overflowNeed = overflow.requestedTokens ?? overflow.promptTokens;
          const overflowRetryCandidates = strictlyLargerCeilingRoutes({
            candidates: routeCandidates.filter(
              (route) => !attemptedLocalMembers.has(route.poolMemberId),
            ),
            fromMemberId: candidate.poolMemberId,
            fromCeiling: memberEffectiveCeiling(candidate.poolMemberId),
            memberCeiling: memberEffectiveCeiling,
            minTokens: overflowNeed,
            sharesTokenizer: (id) => sameRuntimeIdentity(candidate.poolMemberId, id),
          });
          const retryOverflow =
            overflowRetryCandidates.length > 0 &&
            shouldRetryRelayOperation(operation, "precommit_context_exceeded");
          attempt.cancel("request_too_large");
          const overflowTerminal = await attempt.terminal;
          await recordLocalTerminal(
            relayRequestId,
            requester.userId,
            localExecution,
            overflowTerminal,
          ).catch(metadataUpdateError);
          cumulativeRequestBytes += overflowTerminal.requestBytes;
          cumulativeResponseBytes += overflowTerminal.responseBytes;
          await settleRelayCleanup([
            () => cliLease.release(),
            () =>
              builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose(),
          ]);
          finalFailure = "request_too_large";
          await releaseUnusedTrial();
          if (retryOverflow) {
            await releaseCapacityAttempt();
            selectedRouteCandidates = overflowRetryCandidates;
            candidateIndex = -1;
            continue;
          }
          await releaseCapacityAttempt();
          globalLease?.release();
          const overflowResponse = await tryPublicOverflow(
            "LOCAL_CONTEXT_CEILING",
            async () => undefined,
          );
          if (overflowResponse.kind === "response") return overflowResponse.response;
          const lostAccess = terminalExternalFailure(overflowResponse);
          await operation.dispose?.();
          if (lostAccess) {
            await failPoolRelayMetadata({ relayRequestId, startedAt, failure: lostAccess });
            return operationFailureResponse(operation, lostAccess);
          }
          await failPoolRelayMetadata({
            relayRequestId,
            startedAt,
            failure: "request_too_large",
          });
          return contextExceededResponse(
            operation,
            "Engine rejected the request as exceeding context length.",
            {
              estimatedInputTokens: operation.contextCount?.tokens ?? 0,
              estimateMethod: operation.contextCount?.method ?? "TOKEN_ESTIMATE",
              contextMarginTokens: contextMarginForMember(member),
              effectiveContextCeilingTokens: thisCeiling ?? 1,
            },
            overflow.snippet,
          );
        }
        startedBody = bytesToReadableStream(errorBytes);
      }

      if (adaptedSource && operation.adaptation && started.status >= 200 && started.status < 300) {
        const upstreamSse =
          started.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ===
          true;
        if (upstreamSse !== operation.stream) {
          attempt.cancel("protocol_error");
          const terminal = await attempt.terminal;
          await recordLocalTerminal(
            relayRequestId,
            requester.userId,
            localExecution,
            terminal,
          ).catch(metadataUpdateError);
          cumulativeRequestBytes += terminal.requestBytes;
          cumulativeResponseBytes += terminal.responseBytes;
          await settleRelayCleanup([
            () => cliLease.release(),
            () =>
              builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose(),
          ]);
          finalFailure = "protocol_error";
          await recordTargetRelayFailure({
            executionTargetId: candidate.executionTargetId,
            trialStartedAt: claimedTrialAt,
            failure: targetHealthFailure("protocol_error", adaptedSource !== null),
          }).catch(metadataUpdateError);
          if (!shouldRetryRelayOperation(operation, "precommit_content_type_mismatch")) break;
          await releaseCapacityAttempt();
          continue;
        }
      }

      let validatedAdaptedNonstream: Uint8Array | null = null;
      let primedAdaptedStream: ReadableStream<Uint8Array> | null = null;
      let adaptationCompletion: Promise<"ok" | "protocol_error" | "cancelled"> =
        Promise.resolve("ok");
      const nonSuccess = started.status < 200 || started.status >= 300;
      const canonicalNonSuccess = nonSuccess && requestedSurface !== null;
      if (canonicalNonSuccess || (adaptedSource && operation.adaptation && !operation.stream)) {
        try {
          validatedAdaptedNonstream = await readAdaptedNonstreamBody({
            body: startedBody,
            source: adaptedSource ?? requestedSurface ?? "openai-responses",
            target:
              operation.adaptation?.requestedSurface ?? requestedSurface ?? "openai-responses",
            status: started.status,
            headers: started.headers,
            signal: request.signal,
            logContext: { relayRequestId, poolMemberId: candidate.poolMemberId },
          });
        } catch (error) {
          // A body that errored because the lease was lost is not a protocol
          // failure of the member: the outer catch fails over without penalty.
          if (capacityLeaseLostSignal(attemptLeaseSignal)) throw error;
          attempt.cancel("protocol_error");
          const terminal = await attempt.terminal;
          await recordLocalTerminal(
            relayRequestId,
            requester.userId,
            localExecution,
            terminal,
          ).catch(metadataUpdateError);
          cumulativeRequestBytes += terminal.requestBytes;
          cumulativeResponseBytes += terminal.responseBytes;
          await settleRelayCleanup([
            () => cliLease.release(),
            () =>
              builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose(),
          ]);
          finalFailure = "protocol_error";
          await recordTargetRelayFailure({
            executionTargetId: candidate.executionTargetId,
            trialStartedAt: claimedTrialAt,
            failure: targetHealthFailure("protocol_error", adaptedSource !== null),
          }).catch(metadataUpdateError);
          await releaseCapacityAttempt();
          continue;
        }
      }
      if (adaptedSource && operation.adaptation && operation.stream && !canonicalNonSuccess) {
        try {
          let protocolFailureObserved = false;
          const primed = await primeReadableStream(
            adaptedResponseBody({
              body: startedBody,
              source: adaptedSource,
              target: operation.adaptation.requestedSurface,
              stream: true,
              status: started.status,
              headers: started.headers,
              signal: request.signal,
              logContext: { relayRequestId, poolMemberId: candidate.poolMemberId },
              request: canonicalAdaptationRequest ?? undefined,
              onProtocolError: () => {
                protocolFailureObserved = true;
              },
            }),
            operation.adaptation.requestedSurface,
          );
          primedAdaptedStream = primed.body;
          adaptationCompletion = primed.completion.then((outcome) =>
            protocolFailureObserved && outcome === "ok" ? "protocol_error" : outcome,
          );
          // Observed by the finalizer once the response is served; until then
          // (or if serving throws) keep a rejection from going unhandled.
          adaptationCompletion.catch(() => undefined);
        } catch (error) {
          // A body that errored because the lease was lost is not a protocol
          // failure of the member: the outer catch fails over without penalty.
          if (capacityLeaseLostSignal(attemptLeaseSignal)) throw error;
          attempt.cancel("protocol_error");
          const terminal = await attempt.terminal;
          await recordLocalTerminal(
            relayRequestId,
            requester.userId,
            localExecution,
            terminal,
          ).catch(metadataUpdateError);
          cumulativeRequestBytes += terminal.requestBytes;
          cumulativeResponseBytes += terminal.responseBytes;
          await settleRelayCleanup([
            () => cliLease.release(),
            () =>
              builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose(),
          ]);
          finalFailure = "protocol_error";
          await recordTargetRelayFailure({
            executionTargetId: candidate.executionTargetId,
            trialStartedAt: claimedTrialAt,
            failure: targetHealthFailure("protocol_error", adaptedSource !== null),
          }).catch(metadataUpdateError);
          await releaseCapacityAttempt();
          continue;
        }
      }

      let responseHeaders = new Headers(started.headers);
      const adaptedRequestLimitations = operation.adaptation
        ? (() => {
            try {
              return parseCanonicalRequest(
                operation.adaptation.requestedSurface,
                operation.adaptation.payload,
              ).limitations;
            } catch {
              return [];
            }
          })()
        : [];
      const adapterLimitations = [
        "strict_common_subset",
        ...(adaptedSource === "anthropic-messages" ? adaptedRequestLimitations : []),
      ].join(",");
      let responseBody = primedAdaptedStream
        ? primedAdaptedStream
        : validatedAdaptedNonstream
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(validatedAdaptedNonstream as Uint8Array);
                controller.close();
              },
            })
          : responseBodyForOperation({
              body: startedBody,
              headers: started.headers,
              terminal: attempt.terminal,
              operation,
            });
      if (!adaptedSource && compatLaunch && !nonSuccess)
        responseBody = normalizeNativeResponse({
          body: responseBody,
          contentType: started.headers.get("content-type"),
          family: operation.family,
          launch: compatLaunch,
          estimate:
            operation.contextCount !== undefined
              ? { inputTokens: operation.contextCount.tokens }
              : null,
        });
      if (canonicalNonSuccess) {
        responseHeaders = adaptedProviderResponseHeaders(
          adaptedSource ?? requestedSurface ?? "openai-responses",
          operation.adaptation?.requestedSurface ?? requestedSurface ?? "openai-responses",
          started.headers,
          Boolean(adaptedSource && operation.adaptation),
        );
        if (adaptedSource && operation.adaptation)
          responseHeaders.set("x-wsmp-adapter-limitations", adapterLimitations);
      } else if (adaptedSource && operation.adaptation) {
        const sourceHeaders = responseHeaders;
        const adaptedStreaming =
          operation.stream &&
          responseHeaders.get("content-type")?.toLowerCase().startsWith("text/event-stream") ===
            true;
        if (adaptedStreaming && !primedAdaptedStream)
          responseBody = adaptedResponseBody({
            body: responseBody,
            source: adaptedSource,
            target: operation.adaptation.requestedSurface,
            stream: true,
            status: started.status,
            headers: responseHeaders,
            signal: request.signal,
            logContext: { relayRequestId, poolMemberId: candidate.poolMemberId },
            request: canonicalAdaptationRequest ?? undefined,
          });
        responseHeaders = new Headers();
        responseHeaders.set(
          "content-type",
          adaptedStreaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
        );
        responseHeaders.set("x-wsmp-adapter-version", "1.0.0");
        responseHeaders.set("x-wsmp-adapter-limitations", adapterLimitations);
        const retryAfter = safeProviderRetryAfter(sourceHeaders.get("retry-after"));
        if (retryAfter) responseHeaders.set("retry-after", retryAfter);
        const sourceRequestId = safeProviderRequestId(
          adaptedSource === "anthropic-messages"
            ? sourceHeaders.get("request-id")
            : sourceHeaders.get("x-request-id"),
        );
        if (sourceRequestId)
          responseHeaders.set(
            operation.adaptation.requestedSurface === "anthropic-messages"
              ? "request-id"
              : "x-request-id",
            sourceRequestId,
          );
        const rateHeaderPairs = [
          ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit", "count"],
          ["x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining", "count"],
          ["x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset", "reset"],
          ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit", "count"],
          ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining", "count"],
          ["x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset", "reset"],
        ] as const;
        for (const [openAiName, anthropicName, kind] of rateHeaderPairs) {
          const sourceName = adaptedSource === "anthropic-messages" ? anthropicName : openAiName;
          const rawValue = sourceHeaders.get(sourceName);
          const value =
            kind === "count"
              ? safeProviderBoundedRemaining(
                  rawValue,
                  sourceName.includes("remaining"),
                  sourceHeaders.get(sourceName.replace("remaining", "limit")),
                )
              : adaptedSource === operation.adaptation.requestedSurface
                ? safeProviderRateReset(rawValue, adaptedSource === "anthropic-messages")
                : undefined;
          if (value)
            responseHeaders.set(
              operation.adaptation.requestedSurface === "anthropic-messages"
                ? anthropicName
                : openAiName,
              value,
            );
        }
      }
      // The adapted outcome decides success: an adaptation failure is not a
      // successful response and writes no binding.
      const attemptOutcome = Promise.allSettled([attempt.terminal, adaptationCompletion]).then(
        ([terminalResult, adaptationResult]) => {
          const upstreamTerminal =
            terminalResult.status === "fulfilled" ? terminalResult.value : rejectedRelayTerminal();
          const adaptationOutcome =
            adaptationResult.status === "fulfilled" ? adaptationResult.value : "protocol_error";
          const terminal: RelayAttemptTerminal =
            adaptationOutcome !== "ok" && upstreamTerminal.ok
              ? {
                  ...upstreamTerminal,
                  ok: false,
                  failure: adaptationOutcome === "cancelled" ? "cancelled" : "protocol_error",
                }
              : upstreamTerminal;
          return { upstreamTerminal, adaptationOutcome, terminal };
        },
      );
      const stickiness = operation.responseStickiness;
      let affinityWrite: Promise<AffinitySessionBinding | null> | undefined;
      const persistAffinity = () =>
        (affinityWrite ??= attemptOutcome
          .then(({ terminal, upstreamTerminal }) => {
            if (!terminal.ok || !requestedSurface || !affinityPayload || !servedAffinityTarget)
              return null;
            const usageFacts = usageFactsFromRelayTerminal(upstreamTerminal);
            const capacity = member.instance;
            recordCalibrationFromUsage(
              capacity,
              jsonPayloadFromRelayBody(builtRequest.body) ?? affinityPayload,
              usageFacts,
            );
            return rememberAffinity({
              ownerId: requester.userId,
              resourceOwnerId: target.ownerUserId,
              poolId: target.id,
              securityScope: requester.limitKey,
              accessGrantId: target.shareId,
              policy: affinityPolicy,
              surface: requestedSurface,
              payload: affinityPayload,
              headers: request.headers,
              target: servedAffinityTarget,
              engineCacheConfirmed: engineCacheConfirmedFromUsageFacts(usageFacts),
              estimatedTokens: estimatedAffinityTokens(
                capacity,
                affinityPayload,
                operation.contextCount?.tokens,
              ),
              reportedTokens: reportedAffinityTokens(usageFacts),
              reportedPromptTokens: usageFacts.promptTokens ?? undefined,
            });
          })
          .catch((error) => {
            metadataUpdateError(error);
            return null;
          }));
      // Cache identity is durable before the binding reaches the client's EOF.
      // Both EOF and finalization await this single successful cache write.
      const persistBinding = localStickinessPersister({
        terminal: attemptOutcome.then(({ terminal }) => terminal),
        capture: responseIdCapture,
        streaming: operation.stream,
        write: stickiness
          ? async (responseId) =>
              writeResponseStickiness({
                ...stickiness,
                responseId,
                targetPoolId: target.id,
                shareId: target.shareId,
                selectedExecutionTargetId: member.target.id,
                sessionBinding: await persistAffinity(),
              })
          : null,
      });
      void writeCompatTrace(relayRequestId, compatTrace);
      const response = responseWithFirstClientByte(
        new Response(
          persistBinding ? holdEofUntilDurable(responseBody, persistBinding) : responseBody,
          {
            status:
              nonSuccess && (started.status < 400 || started.status > 599) ? 502 : started.status,
            headers: responseHeaders,
          },
        ),
        () => markLocalFirstClientByte(relayRequestId, requester.userId, localExecution),
      );
      const served =
        capacityLease?.state === "ADMITTED" && capacityRuntime
          ? await holdOrReleaseCapacityResponse(
              capacityRuntime,
              response,
              capacityLease.lease,
              request.signal,
            )
          : response;
      // Only now is this attempt definitively the request's outcome (its
      // response goes to the client), so only now is its finalizer scheduled.
      // Anything above that throws lands in the catch below, which is then the
      // attempt's single claimant: it either records the error the client
      // receives or finalizes only the attempt and moves on to the next
      // member, whose attempt then decides the request's outcome.
      const finalize = attemptOutcome
        .then(async ({ upstreamTerminal, adaptationOutcome, terminal }) => {
          const cumulativeTerminal = {
            ...terminal,
            requestBytes: cumulativeRequestBytes + terminal.requestBytes,
            responseBytes: cumulativeResponseBytes + terminal.responseBytes,
          };
          const cleanup = await Promise.allSettled([
            Promise.resolve().then(() => cliLease.release()),
            Promise.resolve().then(() => globalLease?.release()),
            builtRequest.body instanceof Uint8Array
              ? Promise.resolve()
              : builtRequest.body.dispose(),
            operation.dispose?.() ?? Promise.resolve(),
          ]);
          reportCleanupFailures(cleanup);
          // The relay executor retains the bounded prefix and tail windows of
          // THIS attempt's response (per-attempt, so retries cannot
          // contaminate each other's evidence); the prefix keeps early usage
          // events (Anthropic message_start) on streams beyond the tail window.
          // These facts feed the request's usage columns and rollup;
          // affinity persistence derives cache evidence from the same terminal.
          const usage = usageFactsFromRelayTerminal(upstreamTerminal);
          const affinityTarget = requestedSurface
            ? affinityTargetForMember(
                member,
                requestedSurface,
                executionByMember.get(member.id),
                candidate.health,
              )
            : null;
          const selectedAffinityScore = affinityTarget
            ? (affinityDecision?.scores[affinityTarget.executionTargetId] ?? 0)
            : 0;
          const selectedAffinityPrefixDepth = affinityTarget
            ? (affinityDecision?.prefixDepths[affinityTarget.executionTargetId] ?? 0)
            : 0;
          const selectedConversationMatch = affinityTarget
            ? (affinityDecision?.conversationMatches[affinityTarget.executionTargetId] ?? false)
            : false;
          const selectedAffinityReason = affinityTarget
            ? (affinityDecision?.reasons[affinityTarget.executionTargetId] ?? "no_match")
            : "identity_unavailable";
          // Feedback is an optimization after the response is determined. Never
          // await its flush or let it interfere with other finalization writes.
          try {
            const capacity = member.instance;
            const sessionId = affinityTarget
              ? affinityDecision?.matchedSessionIds?.[affinityTarget.executionTargetId]
              : undefined;
            const continuationKind =
              affinityTarget && capacity && sessionId
                ? evictionContinuationKind({
                    policy: protectionPolicy,
                    engineKind: protectionEngineKind(capacity.engine),
                    kvBudgetTokens: capacity.kvBudgetTokens,
                    ok: terminal.ok,
                    usage,
                    evidence: affinityDecision?.prefixEvidence?.[affinityTarget.executionTargetId],
                    now: attemptDispatchedAt,
                    resetAtMs: kvEvictionResetMs(capacity.id, evictionResetGeneration),
                  })
                : null;
            if (affinityTarget && capacity && sessionId && continuationKind)
              // The same owner id the protection read filters by.
              observeKvEviction(capacity.id, target.ownerUserId, sessionId, continuationKind);
          } catch {
            /* Disposable feedback never changes the response. */
          }
          const terminalWrites = await Promise.allSettled([
            operation.memberProbe
              ? releaseUnusedTrial()
              : terminal.ok
                ? markTargetRelaySuccess(candidate.executionTargetId, {
                    trialStartedAt: claimedTrialAt,
                  })
                : adaptationOutcome === "protocol_error" &&
                    upstreamTerminal.failure !== "capacity_lease_lost"
                  ? recordTargetRelayFailure({
                      executionTargetId: candidate.executionTargetId,
                      trialStartedAt: claimedTrialAt,
                      failure: targetHealthFailure("protocol_error", adaptedSource !== null),
                    })
                  : // A served attempt that settled neither way (client abort
                    // mid-stream, non-member failure) gives its trial back; a
                    // no-op once success/failure already cleared it.
                    releaseUnusedTrial(),
            updatePoolRelayMetadata(relayRequestId, {
              selectedRuntimeModelId: member.model.id,
              status: terminalStatus(terminal),
              startedAt,
              terminal: cumulativeTerminal,
              usage,
              attemptCount,
              localExecution,
              userId: requester.userId,
              localTerminal: terminal,
              affinity: {
                outcome:
                  (candidate.poolMemberId === cacheHolderAdmittedMemberId
                    ? cacheHolderOutcome(cacheHolderPlan, candidate.poolMemberId)
                    : null) ??
                  (affinityDecision &&
                  (selectedAffinityPrefixDepth > 0 || selectedConversationMatch)
                    ? "PREDICTED_MATCH"
                    : affinityPolicy.enabled
                      ? "NO_MATCH"
                      : "DISABLED"),
                waitMs: cacheHolderPlan ? cacheHolderWaitedMs : null,
                score: selectedAffinityScore,
                prefixDepth: selectedAffinityPrefixDepth,
                reason: selectedAffinityReason,
              },
            }).catch(metadataUpdateError),
            persistBinding ? persistBinding().catch(stickinessWriteError) : Promise.resolve(),
            persistAffinity(),
          ]);
          reportCleanupFailures(terminalWrites);
        })
        .catch(metadataUpdateError);
      void finalize;
      return served;
    } catch (caught) {
      // No finalizer was scheduled for this attempt (see above). Settle it if
      // it may still be streaming (a no-op once its terminal is known).
      const leaseLostNow = precommitLeaseLost(
        caught,
        capacityLease?.state === "ADMITTED" ? capacityLease.lease.signal : undefined,
        request.signal,
      );
      attempt.cancel("unknown");
      const terminal = servedLocalTerminal(
        await attempt.terminal.catch(() => rejectedRelayTerminal()),
        leaseLostNow,
      );
      const failure = terminal.failure ?? "unknown";
      if (failure === "request_too_large" && operation.contextCount?.exact) {
        const thisCeiling =
          effectiveContextCeilingTokens(
            member.instance?.physicalMaxContext,
            configuredContextCeilingForMember(member),
          ) ?? 1;
        const details = {
          estimatedInputTokens: operation.contextCount.tokens,
          estimateMethod: operation.contextCount.method,
          contextMarginTokens: contextMarginForMember(member),
          effectiveContextCeilingTokens: thisCeiling,
        };
        nativeCounts.set(member.id, operation.contextCount);
        const larger = remainingContextRoutes(candidate.poolMemberId, details);
        await recordLocalTerminal(relayRequestId, requester.userId, localExecution, terminal).catch(
          metadataUpdateError,
        );
        cumulativeRequestBytes += terminal.requestBytes;
        cumulativeResponseBytes += terminal.responseBytes;
        await releaseUnusedTrial();
        await settleRelayCleanup([
          () => cliLease.release(),
          () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
        ]);
        await releaseCapacityAttempt();
        if (larger.length > 0) {
          selectedRouteCandidates = larger;
          candidateIndex = -1;
          continue;
        }
        globalLease?.release();
        return respondLocalContextCeiling(details);
      }
      const operationRetryable = shouldRetryRelayOperation(operation, "precommit_transport");
      const memberRetryable =
        isPoolRelayFailureClass(failure) && isRetryableTargetRelayFailure(failure);
      // F2-CAP-3: a lost capacity lease before the first client byte is a
      // retryable precommit failure of THIS PROCESS's lease (a database-side
      // event), never the member's fault: fail over without a health penalty.
      const leaseLost = failure === "capacity_lease_lost";
      // Single claimant per attempt row: when this attempt is the request's
      // outcome (operation retryable, member failure not retryable), the
      // attempt is claimed by `updateRelayMetadata` below together with the
      // request transition. Every other outcome hands the request to a later
      // finalizer (next member, or the post-loop overflow/failRelayMetadata),
      // so only the attempt is finalized here.
      const attemptIsRequestOutcome = operationRetryable && !memberRetryable && !leaseLost;
      if (!attemptIsRequestOutcome)
        await recordLocalTerminal(relayRequestId, requester.userId, localExecution, terminal).catch(
          metadataUpdateError,
        );
      cumulativeRequestBytes += terminal.requestBytes;
      cumulativeResponseBytes += terminal.responseBytes;
      await settleRelayCleanup([
        () => cliLease.release(),
        () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      ]);
      finalFailure = failure;
      lastUpstreamErrorExcerpt = terminal.upstreamErrorExcerpt ?? lastUpstreamErrorExcerpt;
      // Only a retryable operation with a member-attributable failure writes
      // member health below (which clears the trial). Every other exit (client
      // abort, lease loss, non-member failure, or a non-retryable operation such
      // as a stateful follow-up that breaks before the failure write) gives the
      // claimed trial back instead of waiting out the lease.
      if (!(operationRetryable && memberRetryable && isPoolRelayFailureClass(failure)))
        await releaseUnusedTrial();
      if (!operationRetryable) break;
      if (leaseLost) {
        await releaseCapacityAttempt();
        continue;
      }
      if (memberRetryable && isPoolRelayFailureClass(failure)) {
        await recordTargetRelayFailure({
          executionTargetId: candidate.executionTargetId,
          trialStartedAt: claimedTrialAt,
          failure: targetHealthFailure(failure, adaptedSource !== null),
        }).catch(metadataUpdateError);
        await releaseCapacityAttempt();
        continue;
      }
      await settleRelayCleanup([
        () => globalLease?.release(),
        () =>
          capacityLease?.state === "ADMITTED"
            ? capacityRuntime?.release(capacityLease.lease)
            : undefined,
        () => operation.dispose?.(),
      ]);
      await updatePoolRelayMetadata(relayRequestId, {
        selectedRuntimeModelId: member.model.id,
        status: servedFailureStatus(terminal),
        startedAt,
        terminal: {
          ...terminal,
          requestBytes: cumulativeRequestBytes,
          responseBytes: cumulativeResponseBytes,
        },
        fallbackFailure: failure,
        attemptCount,
        localExecution,
        userId: requester.userId,
        localTerminal: terminal,
      });
      return operationFailureResponse(operation, failure);
    }
  }

  // (a) local wait expired, or (d) a retryable pre-first-byte local failure
  // after the other local members were tried. Never the caller's own caps.
  const overflowReason: PublicOverflowReason =
    finalFailure === "rate_limited" || finalFailure === "timeout"
      ? "LOCAL_WAIT_EXPIRED"
      : "RETRYABLE_PRECOMMIT_PRIMARY_FAILURE";
  const overflow: ExternalAttemptOutcome =
    callerLimitReached || poolOwnerLostAccess
      ? { kind: "not_applicable" }
      : await tryPublicOverflow(overflowReason, async () => {
          const lease = capacityLease?.state === "ADMITTED" ? capacityLease.lease : undefined;
          capacityLease = undefined;
          await settleRelayCleanup([() => (lease ? capacityRuntime?.release(lease) : undefined)]);
        });
  if (overflow.kind === "response") return overflow.response;
  // The client left during or after an external phase that did not dispatch
  // (499), or the pool or requester lost access (#76): that, not the local
  // failure that triggered the phase.
  finalFailure = terminalExternalFailure(overflow) ?? finalFailure;

  await settleRelayCleanup([
    () => globalLease?.release(),
    () =>
      capacityLease?.state === "ADMITTED"
        ? capacityRuntime?.release(capacityLease.lease)
        : undefined,
    () => operation.dispose?.(),
  ]);
  await writeCompatTrace(relayRequestId, compatTrace);
  await failPoolRelayMetadata({
    relayRequestId,
    startedAt,
    failure: finalFailure,
    attemptCount,
    requestBytes: cumulativeRequestBytes,
    responseBytes: cumulativeResponseBytes,
    upstreamErrorExcerpt: lastUpstreamErrorExcerpt,
  });
  return operationFailureResponse(operation, finalFailure);
}

async function relaySelectedModelNoFailover({
  request,
  requester,
  selectedRuntimeModelId,
  selectedExecutionTargetId,
  requestedRuntimeModelId,
  requestedPoolId,
  poolAccess,
  operation,
  manager,
  limiter,
  capacityRuntime,
}: {
  request: Request;
  requester: RelayRequester;
  selectedRuntimeModelId: string;
  /** The exact instance target the stored response was produced on. */
  selectedExecutionTargetId: string;
  requestedRuntimeModelId?: string;
  requestedPoolId?: string;
  /** How the requester reaches `requestedPoolId`: re-checked at the send boundary. */
  poolAccess?: { ownerUserId: string; shareId: string | null };
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    source: requester.source,
    apiKeyId: requester.apiKeyId,
    apiKeyPrefix: requester.apiKeyPrefix,
    requestedRuntimeModelId,
    requestedPoolId,
    requestedSurface: telemetrySurfaceForOperation(operation),
    operation: operation.capability,
    requestBytes: null,
    contextCount: operation.contextCount,
  });
  // A pool binding is honored only while its route is still a local, active route of that
  // pool; a removed member is no longer reachable through the pool (or its share), even for
  // a stored response. A TEST binding needs the caller's own served model on that target.
  const selectedPoolMember = requestedPoolId
    ? (await poolMemberRows(requestedPoolId)).find(
        (member) =>
          member.target.id === selectedExecutionTargetId &&
          member.model.id === selectedRuntimeModelId,
      )
    : undefined;
  const selected = requestedPoolId
    ? selectedPoolMember?.active
      ? servedRoute(selectedPoolMember)
      : null
    : ((await testRoutes(selectedRuntimeModelId, requester.userId))
        .filter(hasHeadNode)
        .map(servedRoute)
        .find((route) => route.target.id === selectedExecutionTargetId) ?? null);
  if (!selected) {
    await operation.dispose?.();
    await failRelayMetadata({ relayRequestId, startedAt, failure: "not_found" });
    return operationFailureResponse(operation, "not_found");
  }

  if (
    !supportsOperation({
      capabilities: effectiveDirectCapabilities(selected),
      operation,
    })
  ) {
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unsupported_capability",
      selectedRuntimeModelId: selected.id,
    });
    return operationFailureResponse(operation, "unsupported_capability");
  }

  if (!isEndpointConnected(selected, new Set(manager.getOnlineNodeIds()))) {
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "disconnected",
      selectedRuntimeModelId: selected.id,
    });
    return operationFailureResponse(operation, "disconnected");
  }

  const boundAffinityBase =
    requestedPoolId &&
    selectedPoolMember?.pool.affinity.enabled &&
    operation.method === "POST" &&
    operation.capability === "responses.create" &&
    operation.contextInput
      ? affinityTargetForMember(
          selectedPoolMember,
          "openai-responses",
          executionPathForPoolMember(
            effectivePoolMemberCapabilities(selectedPoolMember),
            // Capability authorization above checks the stateful follow-up.
            // Identity names the native create path that populated this KV.
            { ...operation, additionalCapabilities: undefined },
            null,
          ),
        )
      : null;
  const boundAffinityTarget = boundAffinityBase
    ? ((
        await captureAffinityTargetGenerations([boundAffinityBase], requestedPoolId ?? undefined)
      )[0] ?? null)
    : null;
  let boundMaterial: ReturnType<typeof affinityPrefixDigests> | null = null;
  if (boundAffinityTarget && requestedPoolId) {
    try {
      boundMaterial = affinityPrefixDigests({
        ownerId: requester.userId,
        resourceOwnerId: poolAccess?.ownerUserId ?? selected.userId,
        poolId: requestedPoolId,
        securityScope: requester.limitKey,
        accessGrantId: poolAccess?.shareId,
        surface: "OPENAI_RESPONSES",
        payload: operation.contextInput!,
        headers: request.headers,
        sessionBinding: operation.sessionBinding,
        runtimeIdentity: affinityRuntimeIdentity(boundAffinityTarget),
      });
    } catch (error) {
      metadataUpdateError(error);
    }
  }
  const boundSessionId =
    selectedPoolMember?.pool.affinity.enabled &&
    boundMaterial &&
    boundAffinityTarget &&
    requestedPoolId
      ? await resolveAffinitySession(
          prisma,
          {
            userId: poolAccess?.ownerUserId ?? selected.userId,
            tenantUserId: requester.userId,
            poolId: requestedPoolId,
            executionTargetId: boundAffinityTarget.executionTargetId,
            cacheGeneration: boundAffinityTarget.cacheGeneration,
          },
          boundMaterial,
          new Date(),
        ).catch((error) => {
          metadataUpdateError(error);
          return null;
        })
      : null;
  // Estimate native delta input before provider I/O. EOF only awaits the
  // bounded affinity transaction, and never repeats serialization/tokenization.
  const estimatedDeltaTokens =
    boundMaterial?.boundSessionId && operation.contextInput?.input !== undefined
      ? (
          await countSerializedRequestContext({
            input: { input: operation.contextInput.input },
            signal: request.signal,
          })
        ).tokens
      : 0;
  let capacityLease: Awaited<ReturnType<CapacityAdmissionRuntime["acquire"]>> | undefined;
  if (capacityRuntime) {
    try {
      capacityLease = await acquireCapacityWithTelemetry({
        runtime: capacityRuntime,
        relayRequestId,
        attempt: {
          requestId: crypto.randomUUID(),
          relayRequestId,
          attemptId: crypto.randomUUID(),
          ownerId: selected.userId,
          sourceKind: requestedPoolId ? "POOL" : "TEST",
          poolId: requestedPoolId,
          basePriority: NORMAL_PRIORITY_RANK,
          priorityShareId: requestedPoolId ? poolAccess?.shareId : undefined,
          warmSessionIds: boundSessionId ? [boundSessionId] : [],
          connectionOwner: "model-api",
          deadlineAt: new Date(startedAt.getTime() + MODEL_API_RELAY_TIMEOUT_MS),
          candidates: [
            {
              capacityId: selected.instance.id,
              executionTargetId: selected.target.id,
              poolMemberId: selectedPoolMember?.memberId,
              candidateOrder: 0,
              // Database-clock budget; a TEST follow-up waits until the request deadline.
              waitBudgetMs: selectedPoolMember
                ? effectiveMemberWaitBudget(selectedPoolMember)
                : null,
            },
          ],
        },
        signal: request.signal,
      });
    } catch {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "unknown" });
      return operationFailureResponse(operation, "unknown");
    }
    if (capacityLease.state === "LEASE_LOST") {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "capacity_lease_lost" });
      return operationFailureResponse(operation, "capacity_lease_lost");
    }
    if (capacityLease.state !== "ADMITTED") {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "rate_limited" });
      return operationFailureResponse(operation, "rate_limited");
    }
  }

  let globalLease: ModelApiLimitLease | undefined;
  let cliLease: ModelApiLimitLease | undefined;
  try {
    globalLease = limiter.acquireGlobal({
      tokenId: requester.limitKey,
      userId: requester.userId,
    });
    cliLease = limiter.acquireCli(selected.instance.nodeId);
  } catch (error) {
    cliLease?.release();
    globalLease?.release();
    if (capacityLease?.state === "ADMITTED") await capacityRuntime?.release(capacityLease.lease);
    if (error instanceof ModelApiLimitError) {
      await failRelayMetadata({
        relayRequestId,
        startedAt,
        failure: error.failure,
        selectedRuntimeModelId: selected.id,
      });
      return operationFailureResponse(operation, error.failure);
    }
    throw error;
  }

  let builtRequest: BuiltRelayRequest;
  try {
    builtRequest = await operation.buildRequest(selected.upstreamModelId);
  } catch {
    cliLease.release();
    globalLease.release();
    if (capacityLease?.state === "ADMITTED") await capacityRuntime?.release(capacityLease.lease);
    await operation.dispose?.();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unknown",
      selectedRuntimeModelId: selected.id,
    });
    return operationFailureResponse(operation, "unknown");
  }
  const responseIdCapture =
    operation.responseStickiness && operation.family === "responses"
      ? createResponseIdCapture()
      : null;
  const localExecution: LocalExecutionTelemetry = {
    selectedExecutionTargetId: selected.target.id,
    selectedPoolMemberId: selectedPoolMember?.memberId,
    instance: selected.instance,
    nativeSurface: telemetrySurfaceForOperation(operation),
    requestedSurface: telemetrySurfaceForOperation(operation),
    adapterMode: "NATIVE",
    localAttemptId: crypto.randomUUID(),
    poolId: requestedPoolId,
    contextCount: operation.contextCount,
    admission:
      capacityLease?.state === "ADMITTED"
        ? {
            attemptId: capacityLease.lease.attemptId,
            leaseId: capacityLease.lease.leaseId,
            fencingToken: capacityLease.lease.fencingToken,
          }
        : undefined,
  };
  let attempt: ReturnType<typeof startRelayAttempt>;
  try {
    await startLocalExecutionTelemetry(relayRequestId, requester.userId, localExecution);
    if (requestedPoolId && (!poolAccess || !selectedPoolMember))
      throw new LocalSendRefused("ACCESS_REVOKED");
    attempt = await startAuthorizedLocalRelayAttempt(
      localSendBinding(
        selected,
        requester,
        requestedPoolId && poolAccess && selectedPoolMember
          ? {
              id: requestedPoolId,
              ownerUserId: poolAccess.ownerUserId,
              shareId: poolAccess.shareId,
              memberId: selectedPoolMember.memberId,
              contributedShareId: selectedPoolMember.contributedShareId,
            }
          : undefined,
      ),
      {
        requestId: localExecution.localAttemptId,
        manager,
        nodeId: selected.instance.nodeId,
        handle: selected.instance.handle,
        family: operation.family,
        method: operation.method,
        path: operation.path,
        headers: builtRequest.headers,
        ...relayAttemptBody(builtRequest.body),
        timeoutMs: MODEL_API_RELAY_TIMEOUT_MS,
        abortSignal:
          capacityLease?.state === "ADMITTED"
            ? (capacityLease.lease.signal ?? request.signal)
            : request.signal,
        onResponseBodyChunk: responseIdCapture
          ? (chunk) => responseIdCapture.push(chunk, operation.stream)
          : undefined,
        ...chatCountFirstRelayFields({
          family: operation.family,
          contextCount: operation.contextCount,
          contextInput: operation.contextInput,
          engineCountContext: selected.instance?.engineCountContext,
          physicalMaxContext: selected.instance?.physicalMaxContext,
          effectiveContextCeiling: null,
          contextMargin: 0,
          manager,
          nodeId: selected.instance.nodeId,
          relayRequestId,
          operation,
        }),
      },
    );
  } catch (error) {
    const failure: RelayFailure = error instanceof LocalSendRefused ? error.failure : "unknown";
    cliLease.release();
    globalLease.release();
    if (capacityLease?.state === "ADMITTED") await capacityRuntime?.release(capacityLease.lease);
    if (!(builtRequest.body instanceof Uint8Array)) await builtRequest.body.dispose();
    await operation.dispose?.();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure,
      selectedRuntimeModelId: selected.id,
      attemptCount: 1,
      localExecution,
      userId: requester.userId,
      localTerminal: rejectedRelayTerminal(failure),
    });
    const refused = operationFailureResponse(operation, failure);
    if (error instanceof LocalSendRefused) poolAccessLostResponses.add(refused);
    return refused;
  }

  try {
    const started = await attempt.started;
    let startedBody = started.body;
    if (started.status >= 400 && started.status < 500) {
      const errorBytes = await readStreamBytes(startedBody);
      const overflow = classifyEngineContextOverflow(started.status, decodeUtf8Bytes(errorBytes));
      if (overflow.overflow) {
        attempt.cancel("request_too_large");
        cliLease.release();
        globalLease.release();
        if (capacityLease?.state === "ADMITTED")
          await capacityRuntime?.release(capacityLease.lease);
        if (!(builtRequest.body instanceof Uint8Array)) await builtRequest.body.dispose();
        await operation.dispose?.();
        await failRelayMetadata({
          relayRequestId,
          startedAt,
          failure: "request_too_large",
          selectedRuntimeModelId: selected.id,
        });
        return contextExceededResponse(
          operation,
          "Engine rejected the request as exceeding context length.",
          {
            estimatedInputTokens: operation.contextCount?.tokens ?? 0,
            estimateMethod: operation.contextCount?.method ?? "TOKEN_ESTIMATE",
            contextMarginTokens: 0,
            effectiveContextCeilingTokens:
              effectiveContextCeilingTokens(selected.instance.physicalMaxContext, null) ?? 1,
          },
          overflow.snippet,
        );
      }
      startedBody = bytesToReadableStream(errorBytes);
    }
    const stickiness = operation.responseStickiness;
    let affinityWrite: Promise<AffinitySessionBinding | null> | undefined;
    // Bound Responses continuations are not eviction evidence: this path has
    // neither a ranked affinity decision nor a matched record's age/footprint.
    const persistAffinity = () =>
      (affinityWrite ??= attempt.terminal
        .then((terminal) => {
          if (
            !terminal.ok ||
            !boundAffinityTarget ||
            !requestedPoolId ||
            !selectedPoolMember ||
            !operation.contextInput
          )
            return null;
          const usageFacts = usageFactsFromRelayTerminal(terminal);
          const capacity = selected.instance;
          return rememberAffinity({
            ownerId: requester.userId,
            resourceOwnerId: poolAccess?.ownerUserId ?? selected.userId,
            poolId: requestedPoolId,
            securityScope: requester.limitKey,
            accessGrantId: poolAccess?.shareId,
            policy: affinityPolicyForMember(selectedPoolMember),
            surface: "OPENAI_RESPONSES",
            payload: operation.contextInput,
            headers: request.headers,
            target: boundAffinityTarget,
            sessionBinding: boundSessionId ? operation.sessionBinding : undefined,
            estimatedTokens: estimatedAffinityTokens(
              capacity,
              operation.contextInput,
              operation.contextCount?.tokens,
            ),
            estimatedDeltaTokens,
            reportedTokens: reportedAffinityTokens(usageFacts),
            reportedPromptTokens: usageFacts.promptTokens ?? undefined,
            engineCacheConfirmed: engineCacheConfirmedFromUsageFacts(usageFacts),
          });
        })
        .catch((error) => {
          metadataUpdateError(error);
          return null;
        }));
    // Cache identity precedes the durable next-response binding; one write shared with finalization.
    const persistBinding = localStickinessPersister({
      terminal: attempt.terminal.catch(() => rejectedRelayTerminal()),
      capture: responseIdCapture,
      streaming: operation.stream,
      write: stickiness
        ? async (responseId) =>
            writeResponseStickiness({
              ...stickiness,
              responseId,
              selectedExecutionTargetId: selected.target.id,
              sessionBinding: await persistAffinity(),
            })
        : null,
    });
    const responseBody = responseBodyForOperation({
      body: startedBody,
      headers: started.headers,
      terminal: attempt.terminal,
      operation,
    });
    const response = responseWithFirstClientByte(
      new Response(
        persistBinding ? holdEofUntilDurable(responseBody, persistBinding) : responseBody,
        {
          status: started.status,
          headers: started.headers,
        },
      ),
      () => markLocalFirstClientByte(relayRequestId, requester.userId, localExecution),
    );
    const served =
      capacityLease?.state === "ADMITTED" && capacityRuntime
        ? await holdOrReleaseCapacityResponse(
            capacityRuntime,
            response,
            capacityLease.lease,
            request.signal,
          )
        : response;
    // Only now is this attempt definitively the request's outcome (the
    // response goes to the client), so only now is its finalizer scheduled.
    // Anything above that throws lands in the catch below, which is then the
    // attempt's single claimant and records what the client actually got.
    const finalize = attempt.terminal
      .catch(() => rejectedRelayTerminal())
      .then(async (terminal) => {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => cliLease.release()),
          Promise.resolve().then(() => globalLease.release()),
          builtRequest.body instanceof Uint8Array ? Promise.resolve() : builtRequest.body.dispose(),
          operation.dispose?.() ?? Promise.resolve(),
        ]);
        reportCleanupFailures(cleanup);
        await Promise.allSettled([
          updateRelayMetadata(relayRequestId, {
            selectedRuntimeModelId: selected.id,
            status: terminalStatus(terminal),
            startedAt,
            terminal,
            attemptCount: 1,
            localExecution,
            userId: requester.userId,
          }).catch(metadataUpdateError),
          persistBinding ? persistBinding().catch(stickinessWriteError) : Promise.resolve(),
          persistAffinity(),
        ]);
      })
      .catch(metadataUpdateError);
    void finalize;
    return served;
  } catch (caught) {
    // No finalizer was scheduled (see above): this catch is the attempt's
    // single claimant and records the error the client receives.
    const leaseLost = precommitLeaseLost(
      caught,
      capacityLease?.state === "ADMITTED" ? capacityLease.lease.signal : undefined,
      request.signal,
    );
    attempt.cancel("unknown");
    const terminal = servedLocalTerminal(
      await attempt.terminal.catch(() => rejectedRelayTerminal()),
      leaseLost,
    );
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => cliLease.release()),
      Promise.resolve().then(() => globalLease.release()),
      capacityLease?.state === "ADMITTED"
        ? (capacityRuntime?.release(capacityLease.lease) ?? Promise.resolve(false))
        : Promise.resolve(),
      builtRequest.body instanceof Uint8Array ? Promise.resolve() : builtRequest.body.dispose(),
      operation.dispose?.() ?? Promise.resolve(),
    ]);
    reportCleanupFailures(cleanup);
    await updateRelayMetadata(relayRequestId, {
      selectedRuntimeModelId: selected.id,
      status: servedFailureStatus(terminal),
      startedAt,
      terminal,
      fallbackFailure: terminal.failure ?? "unknown",
      attemptCount: 1,
      localExecution,
      userId: requester.userId,
    });
    if (terminal.failure === "request_too_large" && operation.contextCount?.exact) {
      return contextExceededResponse(
        operation,
        "Request context exceeds the configured execution capacity ceiling.",
        {
          estimatedInputTokens: operation.contextCount.tokens,
          estimateMethod: operation.contextCount.method,
          contextMarginTokens: 0,
          effectiveContextCeilingTokens:
            effectiveContextCeilingTokens(selected.instance.physicalMaxContext, null) ?? 1,
        },
      );
    }
    return operationFailureResponse(operation, terminal.failure ?? "unknown");
  }
}

/**
 * Pool media sidecars (0.4.0 `PoolSidecar`: per media input, a hop to a target pool that
 * describes the media as text, recorded as a SIDECAR request under this one).
 *
 * S0 stub: the sidecar hop is not run yet (its send authority through the target pool is
 * lane R work). Raw media reaches the pool's members unchanged and is served or refused by
 * their own capabilities. Transform envelopes already in the history are still fenced with
 * the policy system message, so prior or spoofed envelope text is never treated as
 * unguarded instructions.
 */
function guardTransformEnvelopes({
  request,
  prepared,
  operationFamily,
}: {
  request: Request;
  prepared: PreparedModeledRequest;
  operationFamily: ModelApiEndpointFamily;
}): PreparedModeledRequest {
  if (operationFamily !== "chat.completions") return prepared;
  if (!prepared.payload || !Array.isArray(prepared.payload.messages)) return prepared;
  if (!messagesContainTransformEnvelope(prepared.payload.messages)) return prepared;
  const guarded = ensureTransformPolicySystemMessage(prepared.payload.messages as unknown[]);
  const nextPayload: JsonObject = { ...prepared.payload, messages: guarded };
  return {
    ...prepared,
    payload: nextPayload,
    buildRequest: async (upstreamModelId) => ({
      headers: relayRequestHeaders(request),
      body: upstreamBody(nextPayload, upstreamModelId),
    }),
  };
}

function attachTransformDebug(response: Response, debug: TransformDebug): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "x-wsmp-transform",
    JSON.stringify({
      modelId: debug.modelId,
      latencyMs: debug.latencyMs,
      cacheHit: debug.cacheHit,
      includePrimaryTools: debug.includePrimaryTools,
      toolCount: debug.toolCount,
      error: debug.error,
    }),
  );
  const exposed = headers.get("access-control-expose-headers");
  headers.set(
    "access-control-expose-headers",
    exposed ? `${exposed}, x-wsmp-transform` : "x-wsmp-transform",
  );
  const contentType = (headers.get("content-type") ?? "").toLowerCase();
  if (!response.body || !contentType.includes("text/event-stream")) {
    return new Response(response.body, { status: response.status, headers });
  }
  const prefix = `event: wsmp.transform\ndata: ${JSON.stringify(debug)}\n\n`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const upstream = response.body;
  let sentPrefix = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(prefixBytes);
        return;
      }
      reader ??= upstream.getReader();
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    cancel(reason) {
      return reader ? reader.cancel(reason) : upstream.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers });
}

/**
 * Per-request external route decision for a pool. `consent` is non-null only
 * when every egress condition holds for this request (see external-route.ts);
 * member availability is still checked at dispatch time.
 */
type PoolExternalRoute = {
  /** The caller asked for `owner/pool:external`. */
  requested: boolean;
  consent: ExternalEgressConsent | null;
  /** Why an `:external` request has no consent (serve local, `x-wsmp-fallback: unavailable`). */
  denial: ExternalEgressDenial | null;
  /** count_tokens named `:external`; it is counted as the plain name. */
  variantIgnored?: boolean;
};

const NO_EXTERNAL_ROUTE: PoolExternalRoute = { requested: false, consent: null, denial: null };

/**
 * Why a consented `:external` request needed an external dispatch but none
 * happened. Drives the provider-only pool status (D5 / X1):
 *   NO_COMPATIBLE -> 400 unsupported_capability (no configured external
 *                    target fits the request, cooling down or not);
 *   SATURATED     -> 429 rate_limited (provider admission did not admit);
 *   UNAVAILABLE   -> 503 external_unavailable (every compatible target in a
 *                    provider health cooldown, precommit failure, owner or
 *                    caller consent withdrawn at dispatch or at the send
 *                    boundary, ...);
 *   CANCELLED     -> the client went away; stays a cancel (499).
 *   POOL_UNAVAILABLE  -> 404 not_found: the pool owner is banned or
 *                        deletion-marked (#76);
 *   REQUESTER_BLOCKED -> 401 access_denied: the requester is.
 * The last two are request-wide access losses, not fallback outcomes, on
 * every pool shape: the request ends there and never resumes on a local
 * member (terminalExternalFailure).
 */
type ExternalUnavailableReason =
  | "NO_COMPATIBLE"
  | "SATURATED"
  | "UNAVAILABLE"
  | "GRANTEE_SPEND_CAP"
  | "CANCELLED"
  | "POOL_UNAVAILABLE"
  | "REQUESTER_BLOCKED";

/**
 * Typed result of one external fallback attempt in relayPool:
 *   response        -> return it (dispatched, or a terminal error such as the
 *                      caller's own cap);
 *   not_applicable  -> the request has no caller consent; behave exactly as
 *                      the plain name;
 *   unavailable     -> consented, a trigger fired, nothing was dispatched.
 */
type ExternalAttemptOutcome =
  | { kind: "response"; response: Response }
  | { kind: "not_applicable" }
  | { kind: "unavailable"; reason: ExternalUnavailableReason };

/** Observed by the caller of relayPool to set `x-wsmp-fallback: unavailable`. */
type ExternalAttemptRecord = {
  unavailable: ExternalUnavailableReason | null;
  /** Set when the request commits to the local member path (for response headers). */
  localRouteDecided?: boolean;
  /**
   * Set when the pool (#76 owner) or the requester lost access mid-request:
   * the answer then looks like arrival's, without route headers.
   */
  accessLost?: boolean;
};

function externalUnavailableReason(
  reason: PublicOverflowSkipReason,
  aborted: boolean,
): ExternalUnavailableReason {
  if (aborted) return "CANCELLED";
  if (reason === "POOL_OWNER_INACTIVE") return "POOL_UNAVAILABLE";
  if (reason === "REQUESTER_ACCESS_BLOCKED") return "REQUESTER_BLOCKED";
  if (reason === "NO_COMPATIBLE_PROVIDER") return "NO_COMPATIBLE";
  if (reason === "PROVIDER_SATURATED") return "SATURATED";
  if (reason === "GRANTEE_BUDGET_EXCEEDED" || reason === "GRANTEE_CAP_UNPRICEABLE")
    return "GRANTEE_SPEND_CAP";
  return "UNAVAILABLE";
}

/** Failures from the local-send gate that must not carry route headers (#76). */
const poolAccessLostResponses = new WeakSet<Response>();

/**
 * The relay failure that ends the request after an external phase, or null
 * when the local path may still serve it. A client cancel is 499; a pool
 * whose owner lost access is not found (404, as at arrival, #76); a
 * requester who lost access is denied. Fallback-only withdrawals (owner
 * turned fallback off, token consent withdrawn) keep independently
 * authorized local service.
 */
function terminalExternalFailure(outcome: ExternalAttemptOutcome): RelayFailure | null {
  if (outcome.kind !== "unavailable") return null;
  if (outcome.reason === "CANCELLED") return "cancelled";
  if (outcome.reason === "POOL_UNAVAILABLE") return "not_found";
  if (outcome.reason === "REQUESTER_BLOCKED") return "access_denied";
  return null;
}

/**
 * Remaining local wait after an external attempt that did not dispatch:
 * externalAfterWaitMs only shortens the local wait in favour of an external
 * target, so the total local wait is still the member/pool budget B:
 * B - min(B, E). Null (no budget) stays null; 0 admits only if free now.
 */
export function resumedLocalWaitBudget(
  memberBudgetMs: number | null,
  externalAfterWaitMs: number,
): number | null {
  if (memberBudgetMs === null) return null;
  return memberBudgetMs - Math.min(memberBudgetMs, Math.max(0, externalAfterWaitMs));
}

/** Only these operations may ever be dispatched to an external provider. */
function operationAcceptsExternalVariant(
  operation: Pick<RelayOperation, "family" | "capability">,
): boolean {
  return (
    operation.capability === "chat.completions" ||
    operation.capability === "responses.create" ||
    operation.capability === "messages.create" ||
    operation.capability === "embeddings"
  );
}

/** count_tokens treats `:external` as the base pool and never egresses. */
function operationTreatsExternalAsBase(
  operation: Pick<RelayOperation, "family" | "capability">,
): boolean {
  return (
    operation.capability === "messages.countTokens" ||
    operation.capability === "responses.countTokens"
  );
}

function externalFallbackReasonHeader(reason: PublicOverflowReason): string {
  if (reason === "LOCAL_WAIT_EXPIRED") return "local_wait_expired";
  if (reason === "LOCAL_SATURATED_PROTECTED") return "local_saturated_protected";
  if (reason === "NO_COMPATIBLE_HEALTHY_PRIMARY") return "no_local_member";
  if (reason === "LOCAL_CONTEXT_CEILING") return "local_context_ceiling";
  return "local_failure";
}

/**
 * Evaluates the egress gate for a resolved pool name. Returns an error
 * response when the request must stop (switch off, token not permitted, MCP,
 * or an operation that cannot use the variant); otherwise the route decision.
 */
function resolvePoolExternalRoute({
  requester,
  pool,
  externalRequested,
  operation,
}: {
  requester: RelayRequester;
  pool: CallablePool;
  externalRequested: boolean;
  operation: Pick<RelayOperation, "family" | "capability">;
}): PoolExternalRoute | ExternalRouteError {
  if (!externalRequested) return NO_EXTERNAL_ROUTE;
  if (operationTreatsExternalAsBase(operation))
    return { ...NO_EXTERNAL_ROUTE, variantIgnored: true };
  if (!operationAcceptsExternalVariant(operation))
    return {
      code: "external_variant_unsupported",
      message: `The ":${EXTERNAL_MODEL_VARIANT}" variant is available only for chat completions, Responses, Messages, and embeddings. Use "${pool.modelId}" for this endpoint; it is always served by local members.`,
    };
  const decision = evaluateExternalEgress({
    requested: true,
    requester,
    pool,
  });
  if (decision.granted) return { requested: true, consent: decision.consent, denial: null };
  const error = externalDenialError(decision.denial, pool);
  if (error) return error;
  return { requested: true, consent: null, denial: decision.denial };
}

async function relayPreparedModeledRequest({
  request,
  requester,
  targets,
  prepared,
  operation,
  manager,
  limiter,
  capacityRuntime,
}: {
  request: Request;
  requester: RelayRequester;
  targets: CallableTargets;
  prepared: PreparedModeledRequest;
  operation: Omit<RelayOperation, "stream" | "buildRequest">;
  capacityRuntime?: CapacityAdmissionRuntime;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}) {
  // Name resolution happens against VISIBLE targets only, after
  // authentication, so no error reveals whether an invisible pool exists.
  const resolution = resolveRequestedModelName(targets, prepared.model);
  if (resolution.kind === "not_found") {
    await prepared.dispose?.();
    return operationFailureResponse(operation, "not_found");
  }
  if (resolution.kind === "error") {
    await prepared.dispose?.();
    return externalRouteErrorResponse(operation.family, resolution.error);
  }
  let external: PoolExternalRoute = NO_EXTERNAL_ROUTE;
  if (resolution.kind === "pool") {
    if (operation.family === "embeddings" && resolution.externalRequested) {
      const contract = parseEmbeddingContract(resolution.target.embeddingContract);
      if (
        !contract ||
        (prepared.payload?.dimensions !== undefined &&
          prepared.payload.dimensions !== contract.dimensions)
      ) {
        await prepared.dispose?.();
        return externalRouteErrorResponse(operation.family, {
          code: "external_variant_unsupported",
          message:
            "External embeddings require an explicit compatible vector-space contract and matching dimensions.",
        });
      }
      if (prepared.payload) prepared.payload.dimensions = contract.dimensions;
    }
    const route = resolvePoolExternalRoute({
      requester,
      pool: resolution.target,
      externalRequested: resolution.externalRequested,
      operation,
    });
    if ("code" in route) {
      await prepared.dispose?.();
      return externalRouteErrorResponse(operation.family, route);
    }
    external = route;
  }
  let contextCount: ContextCountTelemetry | undefined;
  if (prepared.payload) {
    try {
      contextCount = await countSerializedRequestContext({
        input: prepared.payload,
        signal: request.signal,
      });
    } catch {
      await prepared.dispose?.();
      return operationFailureResponse(operation, request.signal.aborted ? "cancelled" : "unknown");
    }
  }
  if (resolution.kind === "test") {
    const directTarget = resolution.target;
    const transcriptionLimitError = await transcriptionUploadLimitResponse({
      profile: prepared.transcriptionProfile,
      modelOrPoolMaxBytes: directTarget.maxAttachmentBytes,
    });
    if (transcriptionLimitError) {
      await prepared.dispose?.();
      return transcriptionLimitError;
    }
    const limitError = await attachmentLimitResponse({
      payload: prepared.payload,
      requesterUserId: requester.userId,
      modelOrPoolMaxBytes: directTarget.maxAttachmentBytes,
    });
    if (limitError) {
      await prepared.dispose?.();
      return limitError;
    }
    const relayOperation: RelayOperation = {
      ...operation,
      stream: prepared.stream,
      buildRequest: prepared.buildRequest,
      transcriptionProfile: prepared.transcriptionProfile,
      dispose: prepared.dispose,
      contextCount,
      contextInput: capacityRuntime ? (prepared.payload ?? undefined) : undefined,
    };
    return relayDirect({
      request,
      requester,
      target: directTarget,
      operation: relayOperation,
      manager,
      limiter,
      capacityRuntime,
    });
  }

  const poolTarget = resolution.target;
  const transcriptionLimitError = await transcriptionUploadLimitResponse({
    profile: prepared.transcriptionProfile,
    modelOrPoolMaxBytes: poolTarget.maxAttachmentBytes,
  });
  if (transcriptionLimitError) {
    await prepared.dispose?.();
    return transcriptionLimitError;
  }
  const limitError = await attachmentLimitResponse({
    payload: prepared.payload,
    requesterUserId: requester.userId,
    modelOrPoolMaxBytes: poolTarget.maxAttachmentBytes,
  });
  if (limitError) {
    await prepared.dispose?.();
    return limitError;
  }
  prepared = guardTransformEnvelopes({ request, prepared, operationFamily: operation.family });
  if (prepared.payload) {
    try {
      // Media descriptions can grow or shrink the serialized request. Pool
      // eligibility must use the payload that will actually reach members.
      contextCount = await countSerializedRequestContext({
        input: prepared.payload,
        signal: request.signal,
      });
    } catch {
      await prepared.dispose?.();
      return operationFailureResponse(operation, request.signal.aborted ? "cancelled" : "unknown");
    }
  }

  const relayOperation: RelayOperation = {
    ...operation,
    stream: prepared.stream,
    buildRequest: prepared.buildRequest,
    transcriptionProfile: prepared.transcriptionProfile,
    dispose: prepared.dispose,
    contextCount,
    contextInput: prepared.payload ?? undefined,
    ...(prepared.payload &&
    (operation.family === "chat.completions" ||
      (operation.family === "responses" && operation.capability === "responses.create") ||
      (operation.family === "messages" && operation.capability === "messages.create"))
      ? {
          adaptation: {
            poolEnabled: poolTarget.protocolAdaptationEnabled,
            allowLossyDeveloperRoleCollapse: poolTarget.allowLossyDeveloperRoleCollapse,
            requestedSurface:
              operation.family === "chat.completions"
                ? ("openai-chat" as const)
                : operation.family === "responses" && operation.capability === "responses.create"
                  ? ("openai-responses" as const)
                  : ("anthropic-messages" as const),
            payload: prepared.payload,
          },
        }
      : {}),
  };
  const externalAttempt: ExternalAttemptRecord = { unavailable: null };
  let response = await relayPool({
    request,
    requester,
    target: poolTarget,
    operation: relayOperation,
    manager,
    limiter,
    transformDebug: prepared.transformDebug,
    capacityRuntime,
    external,
    externalAttempt,
  });
  // Tell the client which route served it. External responses already carry
  // `x-wsmp-route: pool-fallback | own-key`, the reason, and the served model.
  // `x-wsmp-fallback: unavailable` is set exactly when `:external` was asked
  // for and not served externally because there was no consent (owner-side
  // denial), no external members, or a needed external dispatch did not
  // happen. A consented request served locally before any trigger fired
  // carries no header. A request that ended because the pool (#76 owner) or
  // the requester lost access answers like arrival, without either header.
  if (!response.headers.has(ROUTE_HEADER) && !externalAttempt.accessLost) {
    const noExternalPlan =
      external.requested &&
      (!external.consent ||
        (poolTarget.externalMemberCount === 0 && !external.consent?.ownKeyProviderModelId) ||
        externalAttempt.unavailable !== null);
    const headers: Record<string, string> = {};
    if (externalAttempt.localRouteDecided) headers[ROUTE_HEADER] = "local";
    if (noExternalPlan) headers[FALLBACK_HEADER] = "unavailable";
    if (Object.keys(headers).length > 0) response = withResponseHeaders(response, headers);
  }
  if (requester.exposeTransformDebug && prepared.transformDebug) {
    return attachTransformDebug(response, prepared.transformDebug);
  }
  return response;
}

async function authenticatedModeledHandler({
  request,
  operation,
  prepare,
  manager,
  limiter,
  capacityRuntime,
}: {
  request: Request;
  operation: Omit<RelayOperation, "stream" | "buildRequest">;
  prepare: (request: Request) => Promise<PreparedModeledRequest | Response>;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  const token = await authenticateRequest(request);
  if (!token) return openAiFailureJsonResponse("access_denied", "Missing or invalid API key.");
  const prepared = await prepare(request);
  if (prepared instanceof Response) return prepared;
  // Every downstream path may attempt cleanup (including asynchronous relay
  // completion). Make it idempotent, and retain handler-level ownership until
  // routing has been handed off so unexpected DB/limiter/health failures cannot
  // orphan a prepared spool.
  const originalDispose = prepared.dispose;
  let disposed = false;
  prepared.dispose = originalDispose
    ? async () => {
        if (disposed) return;
        disposed = true;
        await originalDispose();
      }
    : undefined;
  let responseReturned = false;
  try {
    const requester = requesterFromToken(token);
    const targets = await listCallableTargetsForApiKey(token);
    const response = await relayPreparedModeledRequest({
      request,
      requester,
      targets,
      prepared,
      operation,
      manager,
      limiter,
      capacityRuntime,
    });
    responseReturned = true;
    return response;
  } finally {
    if (!responseReturned) await prepared.dispose?.();
  }
}

async function completionsHandler({
  request,
  family,
  manager,
  limiter,
  capacityRuntime,
}: {
  request: Request;
  family: "chat.completions";
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  return authenticatedModeledHandler({
    request,
    operation: {
      family,
      method: "POST",
      path: "/v1/chat/completions",
      capability: family,
    },
    prepare: prepareJsonModeledRequest,
    manager,
    limiter,
    capacityRuntime,
  });
}

/** Owner diagnostic uses the same routing, physical admission, accounting and final send boundary. */
export async function poolMemberDiagnosticHandler({
  request,
  userId,
  poolId,
  manager,
  limiter,
  capacityRuntime,
  embeddings,
}: {
  request: Request;
  userId: string;
  poolId: string;
  embeddings: boolean;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime: CapacityAdmissionRuntime;
}): Promise<Response> {
  const targets = await listCallableTargetsForUser(userId);
  const target = targets.pools.find((pool) => pool.id === poolId && pool.ownerUserId === userId);
  if (!target) return openAiFailureJsonResponse("not_found");
  const prepared = await prepareJsonModeledRequest(request);
  if (prepared instanceof Response) return prepared;
  prepared.model = target.modelId;
  return relayPreparedModeledRequest({
    request,
    requester: { ...requesterFromChatTestUser(userId), limitKey: `pool-member-test:${userId}` },
    targets,
    prepared,
    operation: embeddings
      ? {
          memberProbe: true,
          family: "embeddings",
          method: "POST",
          path: "/v1/embeddings",
          capability: "embeddings",
        }
      : {
          memberProbe: true,
          family: "chat.completions",
          method: "POST",
          path: "/v1/chat/completions",
          capability: "chat.completions",
          appendTerminalUsage: true,
        },
    manager,
    limiter,
    capacityRuntime,
  });
}

export async function chatTestCompletionsHandler({
  request,
  userId,
  manager,
  limiter,
  capacityRuntime,
  source = "TEST",
}: {
  request: Request;
  userId: string;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
  /** MCP diagnostics reuse this core; tag their traffic separately. */
  source?: "TEST" | "AGENT_TEST";
}) {
  const prepared = await prepareJsonModeledRequest(request);
  if (prepared instanceof Response) return prepared;

  const requester = requesterFromChatTestUser(userId, source);
  const targets = await listCallableTargetsForUser(userId);
  return relayPreparedModeledRequest({
    request,
    requester,
    targets,
    prepared,
    operation: {
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      capability: "chat.completions",
      appendTerminalUsage: true,
    },
    manager,
    limiter,
    capacityRuntime,
  });
}

const MODEL_TEST_OPERATIONS = {
  chat: {
    family: "chat.completions",
    method: "POST",
    path: "/v1/chat/completions",
    capability: "chat.completions",
    appendTerminalUsage: true,
  },
  embeddings: {
    family: "embeddings",
    method: "POST",
    path: "/v1/embeddings",
    capability: "embeddings",
  },
  transcription: {
    family: "audio",
    method: "POST",
    path: "/v1/audio/transcriptions",
    capability: "audio.transcriptions",
  },
} as const satisfies Record<string, Omit<RelayOperation, "stream" | "buildRequest">>;

/**
 * `models.test` (model-test.ts): one chat, embeddings or transcription request as `userId`
 * through the same targets, admission and routing as the Test page, tagged `AGENT_TEST`. The
 * web Test page's embeddings and transcription requests use it with source `TEST`.
 */
export async function modelTestHandler({
  request,
  userId,
  kind,
  manager,
  limiter,
  capacityRuntime,
  source = "AGENT_TEST",
}: {
  request: Request;
  userId: string;
  kind: keyof typeof MODEL_TEST_OPERATIONS;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime: CapacityAdmissionRuntime;
  /** `TEST`: the person's Test page (its own slots, as Chat Test). */
  source?: "TEST" | "AGENT_TEST";
}): Promise<Response> {
  const prepared =
    kind === "transcription"
      ? await prepareMultipartModeledRequest(request)
      : await prepareJsonModeledRequest(request);
  if (prepared instanceof Response) return prepared;
  // A prepared multipart spool is owned here until routing takes it, and every path may try
  // to clean it up, so cleanup runs once (as in authenticatedModeledHandler).
  const originalDispose = prepared.dispose;
  let disposed = false;
  prepared.dispose = originalDispose
    ? async () => {
        if (disposed) return;
        disposed = true;
        await originalDispose();
      }
    : undefined;
  let responseReturned = false;
  try {
    const targets = await listCallableTargetsForUser(userId);
    const response = await relayPreparedModeledRequest({
      request,
      // Own limit key (as pool member tests): agent tests and benches do not use up the
      // person's Test page slots; the per-user global cap still applies.
      requester:
        source === "TEST"
          ? requesterFromChatTestUser(userId)
          : {
              ...requesterFromChatTestUser(userId, "AGENT_TEST"),
              limitKey: `model-test:${userId}`,
            },
      targets,
      prepared,
      operation: MODEL_TEST_OPERATIONS[kind],
      manager,
      limiter,
      capacityRuntime,
    });
    responseReturned = true;
    return response;
  } finally {
    if (!responseReturned) await prepared.dispose?.();
  }
}

function responsePathWithQuery(request: Request, path: string): string {
  const url = new URL(request.url);
  return `${path}${url.search}`;
}

function encodedResponsePath(responseId: string, suffix = ""): string {
  return `/v1/responses/${encodeURIComponent(responseId)}${suffix}`;
}

function previousResponseId(payload: JsonObject | null): string | null {
  const value = payload?.previous_response_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function relayBoundProviderResponse(input: {
  request: Request;
  requester: RelayRequester;
  stickyRoute: Extract<StickyRoute, { target: "PROVIDER" }>;
  method: string;
  path: string;
  capability: ModelApiCapability;
  body: Uint8Array;
  headers: Headers;
  stream: boolean;
  captureReturnedResponse: boolean;
  contextInput?: JsonObject;
  contextCount?: ContextCountTelemetry;
  capacityRuntime?: CapacityAdmissionRuntime;
  /** The caller's own concurrency caps; external dispatch counts against them (H1). */
  limiter: ModelApiConcurrencyLimiter;
  /** Caller consent for this bound external route (all egress conditions). */
  externalConsent: ExternalEgressConsent;
}): Promise<Response> {
  const boundStartedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: input.requester.userId,
    source: input.requester.source,
    apiKeyId: input.requester.apiKeyId,
    apiKeyPrefix: input.requester.apiKeyPrefix,
    requestedPoolId: input.stickyRoute.visibleTarget.id,
    requestedSurface: "OPENAI_RESPONSES",
    operation: input.capability,
    requestBytes: input.body.byteLength,
    contextCount: input.contextCount,
    // Own-key send intent is durable before transport; pool fallback records
    // its route when the response commits. Bound requests never change targets.
  });
  // H1: the caller's own cap applies to every bound operation exactly as to
  // relayPool: a caller at its cap gets 429 before any listing or dispatch,
  // and the lease is held until the provider response settles. Released
  // exactly once on every exit (not dispatched, throw, precommit throw,
  // terminal including abort and client disconnect).
  let boundRouteIdentity: RouteIdentity = {
    fallbackRoute: null,
    selectedExecutionTargetId: null,
    selectedRuntimeModelId: null,
    selectedPoolMemberId: null,
  };
  let callerLease: ModelApiLimitLease;
  try {
    callerLease = input.limiter.acquireGlobal({
      tokenId: input.requester.limitKey,
      userId: input.requester.userId,
    });
  } catch (error) {
    const failure: RelayFailure = error instanceof ModelApiLimitError ? error.failure : "unknown";
    await failRelayMetadata({
      relayRequestId,
      startedAt: boundStartedAt,
      failure,
      routeIdentity: boundRouteIdentity,
    }).catch(metadataUpdateError);
    return openAiFailureJsonResponse(failure);
  }
  let callerLeaseReleased = false;
  const releaseCallerLease = () => {
    if (callerLeaseReleased) return;
    callerLeaseReleased = true;
    callerLease.release();
  };
  const maxOutput = input.contextInput?.max_output_tokens;
  // An omitted limit is unknown, not zero: liability then comes from the
  // target's own output ceiling (or the request is refused), exactly as on the
  // main path, so spend caps cannot reserve input cost only.
  const requestedOutputTokens =
    typeof maxOutput === "number" && Number.isSafeInteger(maxOutput) && maxOutput >= 0
      ? BigInt(maxOutput)
      : undefined;
  const estimatedInputTokens = input.contextInput
    ? input.contextCount?.tokens === undefined
      ? (payloadAwareInputTokens(input.body) ??
        conservativeSerializedInputTokens(input.body.byteLength))
      : BigInt(input.contextCount.tokens)
    : 0n;
  const ownKey = input.stickyRoute.route === "own-key";
  const boundRequest = {
    userId: ownKey ? input.requester.userId : input.stickyRoute.visibleTarget.ownerUserId,
    ownKeyProviderModelId: ownKey ? input.stickyRoute.binding.providerModelId : undefined,
    poolId: input.stickyRoute.visibleTarget.id,
    requestId: relayRequestId,
    reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
    externalConsent: input.externalConsent,
    requesterUserId: input.requester.userId,
    requesterModelApiTokenId: input.requester.apiKeyId,
    requestedProtocol: "openai",
    requestedSurface: "openai-responses",
    stream: input.stream,
    requiredFeatures: [],
    method: input.method,
    path: input.path,
    headers: input.headers,
    affinityHeaders: input.request.headers,
    body: input.body,
    signal: input.request.signal,
    liability:
      requestedOutputTokens === undefined
        ? { accountingVersion: "provider-billable-v1" as const }
        : conservativeProviderLiability({ estimatedInputTokens, requestedOutputTokens }),
    estimatedInputTokens,
    requestedOutputTokens,
    contextTokens:
      requestedOutputTokens === undefined
        ? undefined
        : estimatedInputTokens + requestedOutputTokens,
    releaseLocalCapacity: async () => undefined,
    adaptationEnabled: false,
    retrySafe: false,
    exactResponsesBinding: input.stickyRoute.binding,
    skipContextValidation: input.contextInput === undefined,
  } satisfies PublicOverflowRequest;
  // A bound follow-up targets exactly the external member that served the
  // original response; there is no failover to other members or tiers.
  const dispatchBoundTarget = async (): Promise<
    Awaited<ReturnType<typeof dispatchPublicOverflow>>
  > => {
    const listed = ownKey
      ? await listPublicOverflowTargets(
          input.stickyRoute.visibleTarget.ownerUserId,
          input.stickyRoute.visibleTarget.id,
          {
            requesterUserId: input.requester.userId,
            providerModelId: input.stickyRoute.binding.providerModelId,
            shareId: input.externalConsent.shareId,
          },
        )
      : await listPublicOverflowTargets(
          input.stickyRoute.visibleTarget.ownerUserId,
          input.stickyRoute.visibleTarget.id,
        );
    // Owner and pool flags gate provider admission (F-C, #64; #76), with the
    // dispatcher's reasons: consent withdrawn is 403, not a 429 after a
    // wasted capacity wait. The send claim still re-checks every condition.
    if (!listed.ownerActive) return { dispatched: false, reason: "POOL_OWNER_INACTIVE" };
    if (!ownKey && !listed.enabled) return { dispatched: false, reason: "POOL_PRIVATE" };
    if (!ownKey && !input.externalConsent.requesterIsOwner && !listed.fallbackForGrantees)
      return { dispatched: false, reason: "GRANTEE_NOT_COVERED" };
    if (ownKey && !listed.enabled) {
      const model = await prisma.providerModel.findFirst({
        where: {
          id: input.stickyRoute.binding.providerModelId,
          userId: input.requester.userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      return {
        dispatched: false,
        reason: model ? "OWN_KEY_CONSENT_WITHDRAWN" : "BOUND_TARGET_INVALID",
      };
    }
    // The full immutable binding (execution target, account, model, endpoint
    // identity and version, upstream model, native Responses support), the
    // same predicate the dispatcher applies.
    const isBoundTarget = (target: Parameters<typeof matchesExactResponsesBinding>[0]) =>
      matchesExactResponsesBinding(target, input.stickyRoute.binding);
    const exactTarget = listed.targets.find(isBoundTarget);
    if (!exactTarget && listed.unavailable.some(isBoundTarget))
      return { dispatched: false, reason: "PROVIDER_UNAVAILABLE" };
    // The bound member still matches but is in a provider health cooldown or
    // has a half-open trial in flight: temporarily unavailable (503), not gone.
    if (!exactTarget && listed.coolingDown.some(isBoundTarget))
      return { dispatched: false, reason: "PROVIDER_UNHEALTHY" };
    // No member matches the binding: it can never be served again (404).
    if (!exactTarget) return { dispatched: false, reason: "BOUND_TARGET_INVALID" };
    const boundBeforeSend = ownKey
      ? async (provider: PublicProviderTarget) => {
          const identity: RouteIdentity = {
            fallbackRoute: "own-key",
            selectedRuntimeModelId: null,
            selectedPoolMemberId: null,
            selectedExecutionTargetId: provider.executionTargetId,
          };
          await prisma.relayRequest.update({
            where: { id: relayRequestId },
            data: routeIdentityData(identity),
          });
          boundRouteIdentity = identity;
        }
      : undefined;
    // 0.4.0 cloud members have no physical capacity (spend caps bound them): no lease.
    return dispatchPublicOverflow({
      ...boundRequest,
      admittedExecutionTargetId: exactTarget.executionTargetId,
      forcedPoolMemberId: exactTarget.poolMemberId,
      beforeProviderSend: boundBeforeSend,
    });
  };
  let result: Awaited<ReturnType<typeof dispatchBoundTarget>>;
  try {
    result = await dispatchBoundTarget();
  } catch (error) {
    // Admission/dispatch threw before any provider terminal exists: finalize
    // the request here so it never lingers PENDING (and is counted once).
    releaseCallerLease();
    await failRelayMetadata({
      relayRequestId,
      startedAt: boundStartedAt,
      routeIdentity: boundRouteIdentity,
      failure: input.request.signal.aborted ? "cancelled" : "unknown",
    }).catch(metadataUpdateError);
    throw error;
  }
  if (!result.dispatched) {
    releaseCallerLease();
    const denied = boundDispatchDenial(result.reason, input.stickyRoute.visibleTarget);
    // Only a permanently invalid binding is "gone" (404). Every other
    // non-consent reason (cooldown, half-open trial in flight, send-claim
    // failure, transport failure, budget) is temporary (503).
    const failure: ModelApiFailure = input.request.signal.aborted
      ? "cancelled"
      : denied
        ? "access_denied"
        : result.reason === "PROVIDER_SATURATED" ||
            result.reason === "GRANTEE_BUDGET_EXCEEDED" ||
            result.reason === "GRANTEE_CAP_UNPRICEABLE"
          ? "rate_limited"
          : result.reason === "BOUND_TARGET_INVALID" ||
              result.reason === "REQUESTER_NOT_VISIBLE" ||
              result.reason === "POOL_OWNER_INACTIVE"
            ? "not_found"
            : "disconnected";
    await failRelayMetadata({
      relayRequestId,
      startedAt: boundStartedAt,
      failure,
      routeIdentity: boundRouteIdentity,
    }).catch(metadataUpdateError);
    // Restorable consent withdrawals are permission errors; a lost exact
    // grant permanently invalidates the binding, just as at arrival.
    if (denied) return externalRouteErrorResponse("responses", denied);
    if (result.reason === "GRANTEE_BUDGET_EXCEEDED" || result.reason === "GRANTEE_CAP_UNPRICEABLE")
      return externalRouteErrorResponse("responses", {
        code: "grantee_spend_cap",
        message: GRANTEE_SPEND_CAP_MESSAGE,
      });
    if (failure === "rate_limited" || failure === "cancelled")
      return openAiFailureJsonResponse(failure);
    if (failure === "disconnected")
      return externalRouteErrorResponse("responses", {
        code: "external_unavailable",
        message: "The bound provider Responses target is temporarily unavailable. Try again later.",
      });
    return openAiFailureJsonResponse(
      "not_found",
      "The bound provider Responses target is no longer available.",
    );
  }
  await prisma.relayRequest
    .update({
      where: { id: relayRequestId },
      data: {
        selectedExecutionTargetId: result.target.executionTargetId,
        selectedRuntimeModelId: null,
        selectedPoolMemberId: result.target.ownKey ? null : result.target.poolMemberId,
        selectedNativeSurface: "OPENAI_RESPONSES",
        adapterMode: "NATIVE",
        publicEgress: true,
        providerAccountId: result.target.providerAccountId,
        providerModelId: result.target.providerModelId,
        providerAttemptId: result.attemptId,
        providerFencingToken: result.fencingToken,
        attemptCount: 1,
        fallbackRoute: result.target.ownKey ? "own-key" : "pool-external",
      },
      select: { id: true },
    })
    .catch(metadataUpdateError);
  const dispatched = result;
  // Terminal transition for the bound attempt. Scheduled only once the
  // response is the request's committed outcome (or a hand-off error ends the
  // request).
  let boundFinalizationScheduled = false;
  const scheduleBoundFinalization = () => {
    if (boundFinalizationScheduled) return;
    boundFinalizationScheduled = true;
    void dispatched.terminal
      .then((terminal) => {
        releaseCallerLease();
        const completedAt = new Date();
        const usage = usageFactsFromProviderUsage(terminal.usage);
        return prisma.$transaction((tx) =>
          transitionRelayRequestTerminal(
            tx,
            relayRequestId,
            {
              status: terminal.ok
                ? "SUCCEEDED"
                : input.request.signal.aborted
                  ? "CANCELED"
                  : "FAILED",
              completedAt,
              durationMs: Math.max(0, completedAt.getTime() - boundStartedAt.getTime()),
              httpStatusCode: dispatched.response.status,
              upstreamStatusCode: dispatched.response.status,
              responseBytes: BigInt(terminal.responseBytes),
              errorClass: terminal.ok
                ? null
                : input.request.signal.aborted
                  ? "cancelled"
                  : "unknown",
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              usageKnown: usage.usageKnown,
            },
            completedAt,
          ),
        );
      })
      .catch(metadataUpdateError)
      .finally(releaseCallerLease);
  };
  try {
    let response = result.response;
    if (result.dataPolicyRefusal) {
      await response.body?.cancel().catch(() => undefined);
      response = dataPolicyRefusalResponse("responses");
    } else if (response.status < 200 || response.status >= 300) {
      const sanitized = await readAdaptedNonstreamBody({
        body: response.body,
        source: "openai-responses",
        target: "openai-responses",
        status: response.status,
        headers: response.headers,
        signal: input.request.signal,
        logContext: { relayRequestId, executionTargetId: result.target.executionTargetId },
      });
      response = new Response(sanitized, {
        status: response.status >= 400 && response.status <= 599 ? response.status : 502,
        headers: adaptedProviderResponseHeaders(
          "openai-responses",
          "openai-responses",
          response.headers,
          false,
        ),
      });
    }
    if (input.captureReturnedResponse) {
      response = captureProviderResponseBinding({
        response,
        streaming: input.stream,
        requester: input.requester,
        targetPoolId: input.stickyRoute.visibleTarget.id,
        shareId: input.stickyRoute.visibleTarget.shareId,
        target: result.target,
        terminal: result.terminal,
      });
    }
    const held = responseWithFirstClientByte(response, result.markFirstClientByte);
    // The response is now the request's committed outcome.
    scheduleBoundFinalization();
    return withResponseHeaders(held, {
      [ROUTE_HEADER]: result.target.ownKey ? "own-key" : "pool-fallback",
      [SERVED_MODEL_HEADER]: result.target.upstreamModelId,
    });
  } catch (error) {
    // Precommit throw: nothing reaches the client, so the caller lease may not
    // wait for a terminal that no reader will drive. The hand-off error ends
    // the request with this attempt as its outcome: let its terminal
    // transition claim the row.
    releaseCallerLease();
    scheduleBoundFinalization();
    throw error;
  }
}

/**
 * Bound follow-up refusals that mean the caller's consent is gone at dispatch
 * time (C3 / E0-TOCTOU). Null for availability failures.
 */
function boundDispatchDenial(
  reason: PublicOverflowSkipReason,
  pool: Pick<CallablePool, "modelId">,
): ExternalRouteError | null {
  // The pool is no longer visible to this caller (lost grant, or #76 owner
  // banned or deletion-marked): answered as not found, as at arrival.
  if (reason === "REQUESTER_NOT_VISIBLE" || reason === "POOL_OWNER_INACTIVE") return null;
  if (reason === "DEPLOYMENT_GATE_DISABLED")
    return externalDenialError("DEPLOYMENT_DISABLED", pool);
  if (isExternalConsentDenialReason(reason))
    return {
      code: "external_not_permitted",
      message: `This response was served by an external provider, and external fallback for "${pool.modelId}" is no longer allowed for this caller.`,
    };
  return null;
}

function responseIdParam(responseId: string | undefined): string | Response {
  // Hono can preserve the raw query suffix in a route parameter when this app
  // is mounted below another Hono router. Never let that suffix become part of
  // the encoded upstream response ID; responsePathWithQuery forwards it once.
  const normalized = responseId?.split(/\?|%3f/i, 1)[0]?.trim();
  if (!normalized) {
    return openAiFailureJsonResponse("not_found", "Response ID is required.");
  }
  return normalized;
}

export async function responsesCreateHandler({
  request,
  manager,
  limiter,
  capacityRuntime,
  chatTestUserId,
}: {
  request: Request;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
  chatTestUserId?: string;
}) {
  const token = chatTestUserId ? null : await authenticateRequest(request);
  if (!token && !chatTestUserId)
    return openAiFailureJsonResponse("access_denied", "Missing or invalid API key.");

  const prepared = await prepareJsonModeledRequest(request, true);
  if (prepared instanceof Response) return prepared;
  const requester = chatTestUserId
    ? requesterFromChatTestUser(chatTestUserId)
    : requesterFromToken(token!);
  const targets = chatTestUserId
    ? await listCallableTargetsForUser(chatTestUserId)
    : await listCallableTargetsForApiKey(token!);
  const previousId = previousResponseId(prepared.payload);
  const operation: Omit<RelayOperation, "stream" | "buildRequest"> = {
    family: "responses",
    method: "POST",
    path: "/v1/responses",
    capability: "responses.create",
    additionalCapabilities: previousId ? ["responses.statefulFollowUps"] : undefined,
    // Only explicitly stored Responses create a follow-up route.
    responseStickiness: prepared.payload?.store === true ? { requester } : undefined,
  };

  if (!previousId) {
    return relayPreparedModeledRequest({
      request,
      requester,
      targets,
      prepared,
      operation,
      manager,
      limiter,
      capacityRuntime,
    });
  }

  const stickyRoute = await resolveStickyRoute({ requester, responseId: previousId, targets });
  if (stickyRoute instanceof Response) {
    await prepared.dispose?.();
    return stickyRoute;
  }
  // Follow-ups match the original route on the canonical base name, so an
  // `:external` follow-up to a locally served response stays pinned locally.
  const resolution = resolveRequestedModelName(targets, prepared.model);
  if (resolution.kind === "error") {
    await prepared.dispose?.();
    return externalRouteErrorResponse(operation.family, resolution.error);
  }
  const matchesRoute =
    resolution.kind !== "not_found" &&
    resolution.target.id === stickyRoute.visibleTarget.id &&
    (stickyRoute.target === "TEST" ? resolution.kind === "test" : resolution.kind === "pool");
  if (!matchesRoute) {
    await prepared.dispose?.();
    return openAiFailureJsonResponse(
      "access_denied",
      "Response follow-up model does not match the original route.",
    );
  }
  const externalRequested = resolution.kind === "pool" && resolution.externalRequested;
  if (stickyRoute.target === "PROVIDER") {
    // C3: a response served by an external provider can only be continued
    // with explicit, still-valid consent for the same pool.
    if (!externalRequested) {
      await prepared.dispose?.();
      return externalRouteErrorResponse(operation.family, {
        code: "external_required",
        message: `This response was served by an external provider. Continue it with "${externalModelId(stickyRoute.visibleTarget.modelId)}"; "${stickyRoute.visibleTarget.modelId}" never leaves this deployment.`,
      });
    }
    const consent = boundExternalConsent({
      requester,
      pool: stickyRoute.visibleTarget,
      ownKeyProviderModelId:
        stickyRoute.route === "own-key" ? stickyRoute.binding.providerModelId : undefined,
    });
    if ("code" in consent) {
      await prepared.dispose?.();
      return externalRouteErrorResponse(operation.family, consent);
    }
    const built = await prepared.buildRequest(stickyRoute.binding.upstreamModelId);
    if (!(built.body instanceof Uint8Array)) {
      await built.body.dispose();
      return openAiFailureJsonResponse("unsupported_capability");
    }
    return relayBoundProviderResponse({
      request,
      requester,
      stickyRoute,
      method: "POST",
      path: "/v1/responses",
      capability: "responses.create",
      body: built.body,
      headers: built.headers,
      stream: prepared.stream,
      captureReturnedResponse: true,
      contextInput: prepared.payload ?? undefined,
      capacityRuntime,
      limiter,
      externalConsent: consent,
    });
  }
  if (externalRequested && stickyRoute.target === "POOL") {
    // The follow-up stays on its local member, but an `:external` name still
    // honours the switch and the token's consent like any other request.
    const route = resolvePoolExternalRoute({
      requester,
      pool: stickyRoute.visibleTarget,
      externalRequested,
      operation,
    });
    if ("code" in route) {
      await prepared.dispose?.();
      return externalRouteErrorResponse(operation.family, route);
    }
  }

  const response = await relaySelectedModelNoFailover({
    request,
    requester,
    selectedRuntimeModelId: stickyRoute.selectedRuntimeModelId,
    selectedExecutionTargetId: stickyRoute.selectedExecutionTargetId,
    requestedRuntimeModelId:
      stickyRoute.target === "TEST" ? stickyRoute.visibleTarget.id : undefined,
    requestedPoolId: stickyRoute.target === "POOL" ? stickyRoute.visibleTarget.id : undefined,
    poolAccess:
      stickyRoute.target === "POOL"
        ? {
            ownerUserId: stickyRoute.visibleTarget.ownerUserId,
            shareId: stickyRoute.visibleTarget.shareId,
          }
        : undefined,
    operation: {
      ...operation,
      stream: prepared.stream,
      buildRequest: prepared.buildRequest,
      contextInput: prepared.payload ?? undefined,
      sessionBinding: stickyRoute.target === "POOL" ? stickyRoute.sessionBinding : undefined,
      responseStickiness: {
        requester,
        targetRuntimeModelId:
          stickyRoute.target === "TEST" ? stickyRoute.visibleTarget.id : undefined,
        targetPoolId: stickyRoute.target === "POOL" ? stickyRoute.visibleTarget.id : undefined,
        shareId: stickyRoute.target === "POOL" ? stickyRoute.visibleTarget.shareId : null,
      },
    },
    manager,
    limiter,
    capacityRuntime,
  });
  // A pool that became unavailable (#76) answers like arrival: no route header.
  return stickyRoute.target === "POOL" && !poolAccessLostResponses.has(response)
    ? withResponseHeaders(response, { [ROUTE_HEADER]: "local" })
    : response;
}

/**
 * Consent for reaching an externally served response again (follow-up,
 * retrieve, cancel, compact, input items, delete). The binding itself was
 * created with consent; the caller must still hold it now.
 */
function boundExternalConsent({
  requester,
  pool,
  ownKeyProviderModelId,
}: {
  requester: RelayRequester;
  pool: CallablePool;
  ownKeyProviderModelId?: string;
}): ExternalEgressConsent | ExternalRouteError {
  const decision = evaluateExternalEgress({
    requested: true,
    requester,
    pool: ownKeyProviderModelId
      ? { ...pool, ownKeyProviderModelId }
      : { ...pool, ownKeyProviderModelId: null },
  });
  if (decision.granted) return decision.consent;
  return (
    externalDenialError(decision.denial, pool) ?? {
      code: "external_not_permitted",
      message: `This response was served by an external provider, and external fallback for "${pool.modelId}" is no longer allowed for this caller.`,
    }
  );
}

async function responsesStickyHandler({
  request,
  responseId,
  method,
  path,
  capability,
  manager,
  limiter,
  capacityRuntime,
}: {
  request: Request;
  responseId: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  capability: ModelApiCapability;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  const token = await authenticateRequest(request);
  if (!token) return openAiFailureJsonResponse("access_denied", "Missing or invalid API key.");

  const requester = requesterFromToken(token);
  const targets = await listCallableTargetsForApiKey(token);
  const stickyRoute = await resolveStickyRoute({ requester, responseId, targets });
  if (stickyRoute instanceof Response) return stickyRoute;

  if (stickyRoute.target === "PROVIDER") {
    // C3: retrieve, delete, cancel, compact, and input items on an externally
    // served response need a consented binding (resolveStickyRoute) AND the
    // caller's current consent (switch, token, owner flags). Every egress
    // condition is re-checked again inside dispatchPublicOverflow.
    const consent = boundExternalConsent({
      requester,
      pool: stickyRoute.visibleTarget,
      ownKeyProviderModelId:
        stickyRoute.route === "own-key" ? stickyRoute.binding.providerModelId : undefined,
    });
    if ("code" in consent) return externalRouteErrorResponse("responses", consent);
    const built = prepareEmptyRelayRequest(request);
    const prepared = await built(stickyRoute.binding.upstreamModelId);
    if (!(prepared.body instanceof Uint8Array)) {
      await prepared.body.dispose();
      return openAiFailureJsonResponse("unsupported_capability");
    }
    return relayBoundProviderResponse({
      request,
      requester,
      stickyRoute,
      method,
      path,
      capability,
      body: prepared.body,
      headers: prepared.headers,
      stream: false,
      captureReturnedResponse: false,
      capacityRuntime,
      limiter,
      externalConsent: consent,
    });
  }

  return relaySelectedModelNoFailover({
    request,
    requester,
    selectedRuntimeModelId: stickyRoute.selectedRuntimeModelId,
    selectedExecutionTargetId: stickyRoute.selectedExecutionTargetId,
    requestedRuntimeModelId:
      stickyRoute.target === "TEST" ? stickyRoute.visibleTarget.id : undefined,
    requestedPoolId: stickyRoute.target === "POOL" ? stickyRoute.visibleTarget.id : undefined,
    poolAccess:
      stickyRoute.target === "POOL"
        ? {
            ownerUserId: stickyRoute.visibleTarget.ownerUserId,
            shareId: stickyRoute.visibleTarget.shareId,
          }
        : undefined,
    operation: {
      family: "responses",
      method,
      path,
      capability,
      stream: false,
      buildRequest: prepareEmptyRelayRequest(request),
    },
    manager,
    limiter,
    capacityRuntime,
  });
}

async function prepareAnthropicModeledRequest(
  request: Request,
  ingress: AnthropicIngress,
): Promise<PreparedModeledRequest | Response> {
  const body = await readModelApiBody(request);
  if (body instanceof Response) {
    return anthropicErrorResponse(
      413,
      relayFailureMessage("request_too_large"),
      "request_too_large",
    );
  }
  const payload = parseRequestPayload(body, true);
  if (payload instanceof Response) return payload;
  if (typeof payload.model !== "string" || payload.model.trim().length === 0) {
    return anthropicErrorResponse(400, "model is required and must be a non-empty string.");
  }
  return {
    model: payload.model,
    payload,
    stream: payload.stream === true,
    buildRequest: async (upstreamModelId) => ({
      headers: anthropicRelayHeaders(request, ingress),
      body: upstreamBody(payload, upstreamModelId),
    }),
  };
}

export async function anthropicMessagesHandler({
  request,
  countTokens,
  manager,
  limiter,
  capacityRuntime,
  chatTestUserId,
}: {
  request: Request;
  countTokens: boolean;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
  chatTestUserId?: string;
}) {
  const token = chatTestUserId ? null : await authenticateRequest(request);
  if (!token && !chatTestUserId) {
    return anthropicErrorResponse(401, "Missing or invalid API key.", "authentication_error");
  }
  const ingress = parseAnthropicIngress(request.headers);
  if (ingress instanceof Response) return ingress;
  const prepared = await prepareAnthropicModeledRequest(request, ingress);
  if (prepared instanceof Response) return prepared;
  if (countTokens) prepared.stream = false;
  const targets = chatTestUserId
    ? await listCallableTargetsForUser(chatTestUserId)
    : await listCallableTargetsForApiKey(token!);
  const response = await relayPreparedModeledRequest({
    request,
    requester: chatTestUserId
      ? requesterFromChatTestUser(chatTestUserId)
      : requesterFromToken(token!),
    targets,
    prepared,
    operation: {
      family: "messages",
      method: "POST",
      path: countTokens ? "/v1/messages/count_tokens" : "/v1/messages",
      capability: countTokens ? "messages.countTokens" : "messages.create",
      anthropicIngress: ingress,
    },
    manager,
    limiter,
    capacityRuntime,
  });
  // Native upstream success and error bytes are intentionally opaque here.
  // Reading or cloning the stream would violate streaming and backpressure.
  return response;
}

export function createModelApiRoutes(dependencies: ModelApiRouteDependencies = {}) {
  const manager = dependencies.manager ?? relaySessionManager;
  const concurrencyLimiter = dependencies.concurrencyLimiter ?? modelApiConcurrencyLimiter;
  const app = new Hono();
  // Durable admission is the default. Production always passes the process
  // runtime. Omitting the property builds the Postgres store so a caller
  // cannot silently fall back to the in-process limiter. An explicit
  // capacityRuntime: undefined is only the unit-test double.
  const admissionRuntime =
    "capacityRuntime" in dependencies
      ? dependencies.capacityRuntime
      : new StoreCapacityAdmissionRuntime(new PostgresCapacityAdmissionStore());
  // F2-CAP-6: every capacity lease owner created while serving a request is
  // released when that request's response ends, even if a route forgot to.
  app.use("*", capacityRequestScopeMiddleware);

  app.get("/models", async (c) => {
    const token = await authenticateRequest(c.req.raw);
    if (!token) {
      return openAiFailureJsonResponse("access_denied", "Missing or invalid API key.");
    }
    const targets = await listCallableTargetsForApiKey(token);
    return c.json(
      await modelListResponse(targets, {
        requester: requesterFromToken(token),
        onlineNodeIds: manager.getOnlineNodeIds(),
      }),
    );
  });

  app.post("/chat/completions", async (c) =>
    completionsHandler({
      request: c.req.raw,
      family: "chat.completions",
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    }),
  );

  app.post("/embeddings", async (c) =>
    authenticatedModeledHandler({
      request: c.req.raw,
      operation: {
        family: "embeddings",
        method: "POST",
        path: "/v1/embeddings",
        capability: "embeddings",
      },
      prepare: prepareJsonModeledRequest,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    }),
  );

  app.post("/audio/transcriptions", async (c) =>
    authenticatedModeledHandler({
      request: c.req.raw,
      operation: {
        family: "audio",
        method: "POST",
        path: "/v1/audio/transcriptions",
        capability: "audio.transcriptions",
      },
      prepare: prepareMultipartModeledRequest,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    }),
  );

  app.post("/audio/translations", async (c) =>
    authenticatedModeledHandler({
      request: c.req.raw,
      operation: {
        family: "audio",
        method: "POST",
        path: "/v1/audio/translations",
        capability: "audio.translations",
      },
      prepare: prepareMultipartModeledRequest,
      manager,
      limiter: concurrencyLimiter,
    }),
  );

  app.post("/audio/speech", async (c) =>
    authenticatedModeledHandler({
      request: c.req.raw,
      operation: {
        family: "audio",
        method: "POST",
        path: "/v1/audio/speech",
        capability: "audio.speech",
      },
      prepare: prepareJsonModeledRequest,
      manager,
      limiter: concurrencyLimiter,
    }),
  );

  app.post("/responses", async (c) =>
    responsesCreateHandler({
      request: c.req.raw,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    }),
  );

  app.post("/messages", async (c) =>
    anthropicMessagesHandler({
      request: c.req.raw,
      countTokens: false,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    }),
  );

  app.post("/messages/count_tokens", async (c) =>
    anthropicMessagesHandler({
      request: c.req.raw,
      countTokens: true,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    }),
  );

  app.post("/responses/count_tokens", async (c) =>
    authenticatedModeledHandler({
      request: c.req.raw,
      operation: {
        family: "responses",
        method: "POST",
        path: "/v1/responses/count_tokens",
        capability: "responses.countTokens",
      },
      prepare: prepareJsonModeledRequest,
      manager,
      limiter: concurrencyLimiter,
    }),
  );

  app.get("/responses/:responseId", async (c) => {
    const responseId = responseIdParam(c.req.param("responseId"));
    if (responseId instanceof Response) return responseId;
    return responsesStickyHandler({
      request: c.req.raw,
      responseId,
      method: "GET",
      path: responsePathWithQuery(c.req.raw, encodedResponsePath(responseId)),
      capability: "responses.retrieve",
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.delete("/responses/:responseId", async (c) => {
    const responseId = responseIdParam(c.req.param("responseId"));
    if (responseId instanceof Response) return responseId;
    return responsesStickyHandler({
      request: c.req.raw,
      responseId,
      method: "DELETE",
      path: encodedResponsePath(responseId),
      capability: "responses.delete",
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.post("/responses/:responseId/cancel", async (c) => {
    const responseId = responseIdParam(c.req.param("responseId"));
    if (responseId instanceof Response) return responseId;
    return responsesStickyHandler({
      request: c.req.raw,
      responseId,
      method: "POST",
      path: encodedResponsePath(responseId, "/cancel"),
      capability: "responses.cancel",
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.get("/responses/:responseId/input_items", async (c) => {
    const responseId = responseIdParam(c.req.param("responseId"));
    if (responseId instanceof Response) return responseId;
    return responsesStickyHandler({
      request: c.req.raw,
      responseId,
      method: "GET",
      path: responsePathWithQuery(c.req.raw, encodedResponsePath(responseId, "/input_items")),
      capability: "responses.listInputItems",
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.post("/responses/:responseId/compact", async (c) => {
    const responseId = responseIdParam(c.req.param("responseId"));
    if (responseId instanceof Response) return responseId;
    return responsesStickyHandler({
      request: c.req.raw,
      responseId,
      method: "POST",
      path: encodedResponsePath(responseId, "/compact"),
      capability: "responses.compact",
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.all("/*", () => openAiFailureJsonResponse("not_found"));

  return app;
}
