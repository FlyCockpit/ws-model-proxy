import {
  getConfiguredMediaAttachmentMaxBytes,
  resolveAttachmentLimit,
} from "@ws-model-proxy/api/lib/media-attachment-limits";
import {
  authenticateModelApiTokenSecret,
  listVisibleModelTargetsForToken,
  listVisibleModelTargetsForUser,
  type ModelApiTokenIdentity,
  type VisibleDirectModelTarget,
  type VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import {
  buildPoolRouteSequence,
  isPublishedEndpointExecutable,
  isRetryablePoolMemberRelayFailure,
  markPoolMemberHalfOpenTrial,
  markPoolMemberRelaySuccess,
  type PoolMemberRouteRow,
  type RelayFailureClass,
  recordPoolMemberRelayFailure,
  relayFailureClasses,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import {
  normalizeTranscriptionCapabilities,
  resolveEffectiveCapabilityMetadata,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  resolveExecutionPath,
  type SurfaceRequestRequirements,
} from "@ws-model-proxy/api/lib/surface-capabilities";
import prisma from "@ws-model-proxy/db";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";
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
  type ContextCountTelemetry,
  contextFitsLimits,
  countSerializedRequestContext,
} from "./capacity/context.js";
import { contextCounterRegistry } from "./capacity/counter-registry.js";
import { PostgresCapacityAdmissionStore } from "./capacity/postgres-store.js";
import {
  type CapacityAdmissionRuntime,
  StoreCapacityAdmissionRuntime,
} from "./capacity/runtime.js";
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
  anyTransformModalityEnabled,
  buildTransformerChatPayload,
  clampTransformerMaxAssets,
  clampTransformerMaxToolChars,
  clampTransformerMaxTools,
  clampTransformerTimeoutMs,
  collectMessageTransformJobs,
  countAssetsInJobs,
  effectiveTransformModalities,
  ensureTransformPolicySystemMessage,
  extractAssistantTextFromChatCompletion,
  formatPrimaryToolsBlock,
  getCachedTransformDescription,
  hashPrimaryTools,
  hashTransformMediaParts,
  MODEL_API_TRANSFORMER_MAX_JOBS,
  MODEL_API_TRANSFORMER_MAX_TOTAL_DESCRIPTION_CHARS,
  MODEL_API_TRANSFORMER_REQUEST_DEADLINE_MS,
  messagesContainTransformEnvelope,
  messagesHaveTransformableMedia,
  readResponseUtf8,
  rewriteMessagesWithPerMessageEnvelopes,
  setCachedTransformDescription,
  shouldCacheTransformDescription,
  summarizePrimaryTools,
  type TransformDebug,
  TransformerResponseTooLargeError,
  type TransformModalities,
  transformerModalityMismatchErrors,
  transformerSupportedModalities,
  wrapTransformEnvelope,
} from "./media-transform.js";
import {
  multimodalFlagsFromCapabilities,
  openAiModelListExtensions,
  unionMultimodalFlags,
} from "./model-list-modalities.js";
import {
  MultipartIngressError,
  type MultipartScalarPart,
  parseMultipartToSpool,
  type ReplayableMultipart,
} from "./multipart-form-data.js";
import { nativeRequestHeaders } from "./native-request-headers.js";
import {
  openAiErrorBody,
  openAiFailureJsonResponse,
  relayFailureHttpStatus,
} from "./openai-errors.js";
import {
  AdapterError,
  adaptNonstreamResponse,
  CanonicalStreamRenderer,
  createProtocolAdaptationTransform,
  type ProtocolSurface,
  parseCanonicalRequest,
  renderCanonicalRequest,
  renderProtocolError,
  renderProtocolErrorMetadata,
} from "./protocols/index.js";
import {
  conservativeProviderLiability,
  conservativeSerializedInputTokens,
  dispatchPublicOverflow,
  type PublicOverflowReason,
} from "./public-overflow.js";
import { type RelayAttemptTerminal, startRelayAttempt } from "./relay-executor.js";
import { shouldRetryRelayOperation } from "./relay-retry-policy.js";
import { type RelayBodySource } from "./request-body-source.js";
import { profileSurfaceRequest } from "./request-feature-profiler.js";
import {
  isBasicTranscriptionRequest,
  TranscriptionRequestError,
  type TranscriptionRequestProfile,
  transcriptionCapabilityCompatible,
  transcriptionRequestProfileFromParts,
} from "./transcription-request.js";

type ModelApiRouteDependencies = {
  manager?: Pick<
    RelaySessionManager,
    | "getActiveCliDeviceIds"
    | "registerRelayResponseHandlers"
    | "sendRelayRequest"
    | "cancelRelayRequest"
    | "completeRelayRequest"
  >;
  concurrencyLimiter?: ModelApiConcurrencyLimiter;
  /** Test/deployment release gate; defaults to the validated env flag. */
  anthropicEnabled?: boolean;
  /** Independent release gate for opt-in pool protocol adaptation. */
  protocolAdaptationEnabled?: boolean;
  capacityEnabled?: boolean;
  capacityRuntime?: CapacityAdmissionRuntime;
};

type JsonObject = Record<string, unknown>;

type ModelApiEndpointFamily =
  | "chat.completions"
  | "completions"
  | "embeddings"
  | "responses"
  | "messages"
  | "audio";

type ModelApiCapability =
  | "chat.completions"
  | "completions"
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
  family: ModelApiEndpointFamily;
  method: string;
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
  anthropicIngress?: AnthropicIngress;
  dispose?: () => Promise<void>;
  contextCount?: ContextCountTelemetry;
  contextInput?: JsonObject;
  adaptation?: {
    featureEnabled: boolean;
    poolEnabled: boolean;
    allowLossyDeveloperRoleCollapse: boolean;
    requestedSurface: ProtocolSurface;
    payload: JsonObject;
  };
};

function operationFailureResponse(
  operation: Pick<RelayOperation, "family">,
  failure: RelayFailure,
  message?: string,
) {
  if (operation.family !== "messages") return openAiFailureJsonResponse(failure, message);
  const status = relayFailureHttpStatus(failure);
  return anthropicErrorResponse(
    status,
    message ??
      (failure === "request_too_large"
        ? "Request body is too large."
        : failure === "unsupported_capability"
          ? "The requested Anthropic operation is not supported by this target."
          : failure === "not_found"
            ? "The requested model was not found."
            : failure === "access_denied"
              ? "Access denied."
              : "The request could not be completed."),
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

function contextExceededResponse(operation: Pick<RelayOperation, "family">, message: string) {
  if (operation.family === "messages") {
    return anthropicErrorResponse(400, message, "invalid_request_error");
  }
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code: "context_exceeded",
      },
    }),
    { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
  );
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
}: {
  request: Request;
  selected: DirectModelRelayRow;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
}): Promise<ContextCountTelemetry | null> {
  if (!operation.contextInput) return null;
  const capacity = selected.ExecutionTarget?.InferenceCapacity;
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
    return countSerializedRequestContext({
      input: operation.contextInput,
      counters: useRegistry && registeredCounter ? [registeredCounter] : [],
      useTokenEstimate: true,
      signal: request.signal,
    });
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
  try {
    built = await operation.buildRequest(selected.upstreamModelId);
    if (!(built.body instanceof Uint8Array)) return countWithConfiguredCounter();
    attempt = startRelayAttempt({
      manager,
      cliDeviceId: selected.Endpoint.cliDeviceId,
      endpointSlug: selected.Endpoint.slug,
      family: operation.family,
      method: "POST",
      path: countOperation.path,
      headers: built.headers,
      body: built.body,
      timeoutMs: 5_000,
      abortSignal: request.signal,
    });
    const started = await attempt.started;
    if (started.status < 200 || started.status >= 300) {
      await started.body.cancel("native_count_status");
      await attempt.terminal;
      return countWithConfiguredCounter();
    }
    const payload = await readBoundedJson(started.body, NATIVE_CONTEXT_COUNT_MAX_BYTES);
    const terminal = await attempt.terminal;
    if (!terminal.ok || !isJsonObject(payload)) return countWithConfiguredCounter();
    const tokens = payload.input_tokens;
    if (!Number.isSafeInteger(tokens) || (tokens as number) < 0)
      return countWithConfiguredCounter();
    return {
      tokens: tokens as number,
      method: "NATIVE",
      exact: true,
      confidence: "EXACT",
      safetyMargin: 1,
      serializedChars: JSON.stringify(operation.contextInput).length,
    };
  } catch {
    attempt?.cancel(request.signal.aborted ? "cancelled" : "protocol_error");
    if (request.signal.aborted) throw request.signal.reason;
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
  targetDiscoveredModelId?: string;
  targetModelPoolId?: string;
};

type ResponseStickinessRecordRow = {
  routingVersion?: number;
  userId: string;
  modelApiTokenId: string | null;
  targetDiscoveredModelId: string | null;
  targetModelPoolId: string | null;
  selectedDiscoveredModelId: string | null;
  TargetExecutionTarget: { discoveredModelId: string | null } | null;
  SelectedExecutionTarget: { discoveredModelId: string | null } | null;
  expiresAt: Date | null;
};

type StickyRoute =
  | {
      target: "DIRECT_MODEL";
      visibleTarget: VisibleDirectModelTarget;
      selectedDiscoveredModelId: string;
    }
  | {
      target: "MODEL_POOL";
      visibleTarget: VisibleModelPoolTarget;
      selectedDiscoveredModelId: string;
    };

type DirectModelRelayRow = {
  id: string;
  published: boolean;
  userId: string;
  upstreamModelId: string;
  capabilityOverrideMode: string;
  capabilityOverrideMetadata: unknown | null;
  optimisticBasicTranscription: boolean;
  ExecutionTarget: {
    id: string;
    inferenceCapacityId: string | null;
    directContextCeiling?: number | null;
    directContextMargin?: number;
    directWaitBudgetMs?: number | null;
    InferenceCapacity?: {
      physicalMaxContext: number | null;
      countStrategy: "TOKENIZER" | "TEMPLATE_AWARE" | "ENGINE_REPORTED" | "CONSERVATIVE_ESTIMATE";
      runtimeIdentityKey: string;
      runtimeModel: string;
      runtimeRevision: string | null;
      tokenizer: string | null;
      tokenizerVersion: string | null;
      template: string | null;
      templateVersion: string | null;
      engine: string | null;
    } | null;
  } | null;
  Endpoint: {
    id: string;
    slug: string;
    published: boolean;
    cliDeviceId: string;
    status: string | null;
    capabilityMetadata: unknown | null;
    CliDevice: { status: string } | null;
  };
};

type PoolMemberRelayRow = PoolMemberRouteRow & {
  ExecutionTarget: {
    id: string;
    inferenceCapacityId: string | null;
    InferenceCapacity?: {
      physicalMaxContext: number | null;
      countStrategy: "TOKENIZER" | "TEMPLATE_AWARE" | "ENGINE_REPORTED" | "CONSERVATIVE_ESTIMATE";
      runtimeIdentityKey: string;
      runtimeModel: string;
      runtimeRevision: string | null;
      tokenizer: string | null;
      tokenizerVersion: string | null;
      template: string | null;
      templateVersion: string | null;
      engine: string | null;
    } | null;
    DiscoveredModel: PoolMemberRouteRow["DiscoveredModel"] & {
      id: string;
      userId: string;
      capabilityOverrideMode: string;
      capabilityOverrideMetadata: unknown | null;
      Endpoint: PoolMemberRouteRow["DiscoveredModel"]["Endpoint"] & {
        capabilityMetadata: unknown | null;
      };
    };
  } | null;
  capacityContextCeiling?: number | null;
  capacityContextCeilingMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
  capacityContextMargin?: number | null;
  capacityWaitBudgetMs?: number | null;
  capacityWaitBudgetMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
  ModelPool?: {
    capacityContextCeiling: number | null;
    capacityContextMargin: number;
    capacityWaitBudgetMs: number | null;
  };
  DiscoveredModel: PoolMemberRouteRow["DiscoveredModel"] & {
    id: string;
    userId: string;
    capabilityOverrideMode: string;
    capabilityOverrideMetadata: unknown | null;
    Endpoint: PoolMemberRouteRow["DiscoveredModel"]["Endpoint"] & {
      capabilityMetadata: unknown | null;
    };
  };
};

type RelayMetadataCreate = {
  userId: string;
  modelApiTokenId?: string | null;
  modelApiTokenLookupPrefix?: string | null;
  requestedDiscoveredModelId?: string;
  requestedModelPoolId?: string;
  transformerLatencyMs?: number | null;
  transformerCacheHit?: boolean | null;
  transformerErrorClass?: string | null;
  operation?: ModelApiCapability;
  requestBytes?: number | null;
  contextCount?: ContextCountTelemetry;
};

type RelayMetadataUpdate = {
  selectedDiscoveredModelId?: string;
  status: "SUCCEEDED" | "FAILED" | "CANCELED";
  startedAt: Date;
  terminal: RelayAttemptTerminal;
  fallbackFailure?: RelayFailure;
  transformerLatencyMs?: number | null;
  transformerCacheHit?: boolean | null;
  transformerErrorClass?: string | null;
  attemptCount?: number;
};

type RelayRequester = {
  userId: string;
  limitKey: string;
  modelApiTokenId: string | null;
  modelApiTokenLookupPrefix: string | null;
  exposeTransformDebug?: boolean;
};

function boundedAdmissionDeadline(
  nowMs: number,
  requestDeadlineMs: number,
  waitBudgetMs: number | null,
) {
  return new Date(
    Math.min(requestDeadlineMs, waitBudgetMs === null ? requestDeadlineMs : nowMs + waitBudgetMs),
  );
}

function effectiveMemberWaitBudget(member: PoolMemberRelayRow): number | null {
  if (member.capacityWaitBudgetMode === "UNLIMITED") return null;
  if (
    member.capacityWaitBudgetMode === "LIMITED" ||
    (member.capacityWaitBudgetMode === undefined && member.capacityWaitBudgetMs != null)
  )
    return member.capacityWaitBudgetMs ?? 0;
  return member.ModelPool?.capacityWaitBudgetMs ?? null;
}

function poolAdmissionCandidate(
  member: PoolMemberRelayRow,
  candidateOrder: number,
  nowMs: number,
  requestDeadlineMs: number,
) {
  const identity = member.ExecutionTarget;
  if (!identity?.inferenceCapacityId) return null;
  return {
    capacityId: identity.inferenceCapacityId,
    executionTargetId: identity.id,
    poolMemberId: member.id,
    candidateOrder,
    deadlineAt: boundedAdmissionDeadline(
      nowMs,
      requestDeadlineMs,
      effectiveMemberWaitBudget(member),
    ),
  };
}

const poolRelayFailureClassSet: ReadonlySet<string> = new Set(relayFailureClasses);
const RESPONSES_STICKINESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESPONSE_ID_CAPTURE_MAX_CHARS = 1024 * 1024;

function isPoolRelayFailureClass(failure: RelayFailure): failure is RelayFailureClass {
  return poolRelayFailureClassSet.has(failure);
}

function transformerFailureResponse(failure: RelayFailure, message: string): Response {
  const prefixed = message.startsWith("Transformer error:")
    ? message
    : `Transformer error: ${message}`;
  return openAiFailureJsonResponse(failure, prefixed);
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export async function authenticateRequest(request: Request): Promise<ModelApiTokenIdentity | null> {
  const token = bearerToken(request);
  if (!token) return null;
  return authenticateModelApiTokenSecret(token);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequestPayload(body: Uint8Array): JsonObject | Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response(
      JSON.stringify(
        openAiErrorBody({
          message: "Request body must be valid JSON.",
          type: "invalid_request_error",
          code: "invalid_json",
        }),
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  if (!isJsonObject(parsed)) {
    return new Response(
      JSON.stringify(
        openAiErrorBody({
          message: "Request body must be a JSON object.",
          type: "invalid_request_error",
          code: "invalid_json",
        }),
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
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

/** Nested transform prepass must not reuse client Idempotency-Key. */
function transformerRelayRequestHeaders(request: Request): Headers {
  const headers = relayRequestHeaders(request);
  headers.delete("idempotency-key");
  return headers;
}

/**
 * Resolve effective OpenAI-compatible capabilities for a discovered model.
 * Delegates to the shared API helper so management-time validation and
 * request-time routing use identical OVERRIDE fallback behavior.
 */
function effectiveCapabilitiesFrom({
  capabilityOverrideMode,
  capabilityOverrideMetadata,
  endpointCapabilityMetadata,
}: {
  capabilityOverrideMode: string;
  capabilityOverrideMetadata: unknown | null;
  endpointCapabilityMetadata: unknown | null;
}): OpenAiCompatibleCapabilities | null {
  return resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode,
    capabilityOverrideMetadata,
    endpointCapabilityMetadata,
  });
}

function effectiveDirectCapabilities(
  row: DirectModelRelayRow,
): OpenAiCompatibleCapabilities | null {
  return effectiveCapabilitiesFrom({
    capabilityOverrideMode: row.capabilityOverrideMode,
    capabilityOverrideMetadata: row.capabilityOverrideMetadata,
    endpointCapabilityMetadata: row.Endpoint.capabilityMetadata,
  });
}

function effectivePoolMemberCapabilities(
  row: PoolMemberRelayRow,
): OpenAiCompatibleCapabilities | null {
  return effectiveCapabilitiesFrom({
    capabilityOverrideMode: row.DiscoveredModel.capabilityOverrideMode,
    capabilityOverrideMetadata: row.DiscoveredModel.capabilityOverrideMetadata,
    endpointCapabilityMetadata: row.DiscoveredModel.Endpoint.capabilityMetadata,
  });
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

  if (capability === "completions") {
    return (
      resolveExecutionPath({
        capabilities,
        requestedSurface: "OPENAI_COMPLETIONS",
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
    if (capabilities?.version !== 3) return false;
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
    if (capabilities?.version === 3)
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
    if (capabilities?.version === 3)
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
    if (capabilities?.version === 3)
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
    if (capabilities?.version === 3)
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
    if (capabilities?.version === 3)
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
    if (capabilities?.version === 3)
      return (
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { countTokens: true, responsesOperation: "countTokens" },
        }).mode === "native"
      );
    return capabilities?.responses?.countTokens === true;
  }

  if (capabilities?.version === 3)
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
  if (operation.family === "chat.completions") return "openai-chat";
  if (operation.family === "responses") return "openai-responses";
  if (operation.family === "messages" && operation.capability === "messages.create")
    return "anthropic-messages";
  return null;
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
}: {
  body: ReadableStream<Uint8Array>;
  source: ProtocolSurface;
  target: ProtocolSurface;
  stream: boolean;
  status: number;
  headers: Headers;
  signal: AbortSignal;
  onProtocolError?: (error: unknown) => void;
}): ReadableStream<Uint8Array> {
  if (stream)
    return body.pipeThrough(
      createProtocolAdaptationTransform({
        source,
        target,
        signal,
        recoverProtocolErrors: onProtocolError !== undefined,
        onProtocolError,
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
        const adapted = adaptNonstreamResponse({ source, target, body: parsed, status, headers });
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
}: Omit<Parameters<typeof adaptedResponseBody>[0], "stream">): Promise<Uint8Array> {
  const reader = body.getReader();
  const abort = () => void reader.cancel(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      if (signal.aborted) throw signal.reason;
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
    const adapted = adaptNonstreamResponse({ source, target, body: parsed, status, headers });
    const output = adapted.ok ? adapted.body : renderProtocolError(target, adapted.error);
    return new TextEncoder().encode(JSON.stringify(output));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
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

function executionPathForPoolMember(
  capabilities: OpenAiCompatibleCapabilities | null,
  operation: RelayOperation,
  canonical?: ReturnType<typeof parseCanonicalRequest> | null,
) {
  const requestedSurface = requestedSurfaceForOperation(operation);
  if (!requestedSurface) return null;
  const adaptationEnabled =
    operation.adaptation?.featureEnabled === true && operation.adaptation.poolEnabled;
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

function isEndpointConnected(row: DirectModelRelayRow, activeCliDeviceIds: Set<string>): boolean {
  return isPublishedEndpointExecutable({
    modelPublished: row.published,
    endpointPublished: row.Endpoint.published,
    endpointStatus: row.Endpoint.status,
    cliDeviceId: row.Endpoint.cliDeviceId,
    cliDeviceStatus: row.Endpoint.CliDevice?.status,
    activeCliDeviceIds,
  });
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
): Promise<PreparedModeledRequest | Response> {
  const body = await readModelApiBody(request);
  if (body instanceof Response) return body;
  const payload = parseRequestPayload(body);
  if (payload instanceof Response) return payload;
  const model = requestedModel(payload);
  if (model instanceof Response) return model;

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
  const requestedExecutionTarget = input.requestedDiscoveredModelId
    ? await prisma.executionTarget.findUnique({
        where: { discoveredModelId: input.requestedDiscoveredModelId },
        select: { id: true },
      })
    : null;
  const row = await prisma.relayRequest.create({
    data: {
      userId: input.userId,
      modelApiTokenId: input.modelApiTokenId ?? null,
      modelApiTokenLookupPrefix: input.modelApiTokenLookupPrefix ?? null,
      requestedDiscoveredModelId: input.requestedDiscoveredModelId ?? null,
      requestedExecutionTargetId: requestedExecutionTarget?.id ?? null,
      requestedModelPoolId: input.requestedModelPoolId ?? null,
      transformerLatencyMs: input.transformerLatencyMs ?? null,
      transformerCacheHit: input.transformerCacheHit ?? null,
      transformerErrorClass: input.transformerErrorClass ?? null,
      operation: input.operation ?? null,
      requestBytes: input.requestBytes == null ? null : BigInt(input.requestBytes),
      contextTokenCount: input.contextCount?.tokens ?? null,
      contextCountMethod: input.contextCount?.method ?? null,
      contextCountConfidence: input.contextCount?.confidence ?? null,
      contextCountExact: input.contextCount?.exact ?? null,
      contextSafetyMargin: input.contextCount?.safetyMargin ?? null,
      contextSerializedChars: input.contextCount?.serializedChars ?? null,
      status: "PENDING",
    },
    select: { id: true },
  });
  return row.id;
}

function requesterFromToken(token: ModelApiTokenIdentity): RelayRequester {
  return {
    userId: token.userId,
    limitKey: token.id,
    modelApiTokenId: token.id,
    modelApiTokenLookupPrefix: token.lookupPrefix,
  };
}

function requesterFromChatTestUser(userId: string): RelayRequester {
  return {
    userId,
    limitKey: `chat-test:${userId}`,
    modelApiTokenId: null,
    modelApiTokenLookupPrefix: null,
    exposeTransformDebug: true,
  };
}

async function updateRelayMetadata(relayRequestId: string, update: RelayMetadataUpdate) {
  const completedAt = new Date();
  const failure = update.terminal.failure ?? update.fallbackFailure ?? null;
  const selectedExecutionTarget = update.selectedDiscoveredModelId
    ? await prisma.executionTarget.findUnique({
        where: { discoveredModelId: update.selectedDiscoveredModelId },
        select: { id: true },
      })
    : null;
  await prisma.relayRequest.update({
    where: { id: relayRequestId },
    data: {
      selectedDiscoveredModelId: update.selectedDiscoveredModelId ?? null,
      selectedExecutionTargetId: selectedExecutionTarget?.id ?? null,
      status: update.status,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - update.startedAt.getTime()),
      promptTokens: update.terminal.usage?.promptTokens ?? null,
      completionTokens: update.terminal.usage?.completionTokens ?? null,
      totalTokens: update.terminal.usage?.totalTokens ?? null,
      httpStatusCode:
        update.terminal.httpStatusCode ?? (failure ? relayFailureHttpStatus(failure) : null),
      upstreamStatusCode: update.terminal.upstreamStatusCode,
      requestBytes: BigInt(update.terminal.requestBytes),
      responseBytes: BigInt(update.terminal.responseBytes),
      ...(update.attemptCount !== undefined ? { attemptCount: update.attemptCount } : {}),
      errorClass: failure,
      ...(update.transformerLatencyMs !== undefined
        ? { transformerLatencyMs: update.transformerLatencyMs }
        : {}),
      ...(update.transformerCacheHit !== undefined
        ? { transformerCacheHit: update.transformerCacheHit }
        : {}),
      ...(update.transformerErrorClass !== undefined
        ? { transformerErrorClass: update.transformerErrorClass }
        : {}),
    },
    select: { id: true },
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
      contextCountConfidence: contextCount.confidence,
      contextCountExact: contextCount.exact,
      contextSafetyMargin: contextCount.safetyMargin,
      contextSerializedChars: contextCount.serializedChars,
    },
  });
}

async function updateAdmissionMetadata(
  relayRequestId: string,
  input: {
    attemptId: string;
    waitDurationMs: number;
    result: Awaited<ReturnType<CapacityAdmissionRuntime["acquire"]>>;
  },
) {
  const lease = input.result.state === "ADMITTED" ? input.result.lease : null;
  await prisma.relayRequest.update({
    where: { id: relayRequestId },
    data: {
      admissionAttemptId: input.attemptId,
      admissionLeaseId: lease?.leaseId ?? null,
      admissionCapacityId: lease?.capacityId ?? null,
      admissionFencingToken: lease?.fencingToken ?? null,
      admissionWaitDurationMs: Math.max(0, input.waitDurationMs),
      admissionReservationClass: lease?.reservationClass ?? null,
      admissionBorrowed: lease?.borrowed ?? null,
      admissionTerminalState: input.result.state,
    },
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
      await updateAdmissionMetadata(relayRequestId, {
        attemptId: attempt.attemptId,
        waitDurationMs: Date.now() - waitingStartedAt,
        result,
      });
    } catch (error) {
      if (result.state === "ADMITTED") await runtime.release(result.lease);
      throw error;
    }
    return result;
  } catch (error) {
    await prisma.relayRequest
      .update({
        where: { id: relayRequestId },
        data: {
          admissionAttemptId: attempt.attemptId,
          admissionWaitDurationMs: Math.max(0, Date.now() - waitingStartedAt),
          admissionTerminalState: signal.aborted ? "CANCELLED" : "ERROR",
        },
        select: { id: true },
      })
      .catch(metadataUpdateError);
    throw error;
  }
}

function terminalStatus(terminal: RelayAttemptTerminal): "SUCCEEDED" | "FAILED" | "CANCELED" {
  if (terminal.failure === "cancelled") return "CANCELED";
  return terminal.ok ? "SUCCEEDED" : "FAILED";
}

async function failRelayMetadata({
  relayRequestId,
  startedAt,
  failure,
  selectedDiscoveredModelId,
  transformerErrorClass,
  transformerLatencyMs,
  attemptCount,
  requestBytes,
  responseBytes,
}: {
  relayRequestId: string;
  startedAt: Date;
  failure: RelayFailure;
  selectedDiscoveredModelId?: string;
  transformerErrorClass?: string | null;
  transformerLatencyMs?: number | null;
  attemptCount?: number;
  requestBytes?: number;
  responseBytes?: number;
}) {
  if (requestBytes !== undefined) {
    await prisma.relayRequest.update({
      where: { id: relayRequestId },
      data: { requestBytes: BigInt(requestBytes) },
      select: { id: true },
    });
  }
  await updateRelayMetadata(relayRequestId, {
    selectedDiscoveredModelId,
    status: failure === "cancelled" ? "CANCELED" : "FAILED",
    startedAt,
    fallbackFailure: failure,
    transformerErrorClass,
    transformerLatencyMs,
    attemptCount,
    terminal: {
      ok: false,
      failure,
      httpStatusCode: relayFailureHttpStatus(failure),
      upstreamStatusCode: null,
      usage: null,
      metrics: null,
      responseBytes: responseBytes ?? 0,
      requestBytes: requestBytes ?? 0,
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
  return hmacDigestForForwarderPurpose({
    purpose: "responsesStickiness",
    value: `${requester.userId}:${requester.modelApiTokenId ?? "session"}:${responseId}`,
  });
}

async function writeResponseStickiness({
  requester,
  responseId,
  targetDiscoveredModelId,
  targetModelPoolId,
  selectedDiscoveredModelId,
}: ResponseStickinessCapture & {
  responseId: string;
  selectedDiscoveredModelId: string;
}) {
  const routingKeyDigest = responseStickinessDigest({ requester, responseId });
  const expiresAt = new Date(Date.now() + RESPONSES_STICKINESS_TTL_MS);
  const [targetExecutionTarget, selectedExecutionTarget] = await Promise.all([
    targetDiscoveredModelId
      ? prisma.executionTarget.findUnique({
          where: { discoveredModelId: targetDiscoveredModelId },
          select: { id: true },
        })
      : null,
    prisma.executionTarget.findUnique({
      where: { discoveredModelId: selectedDiscoveredModelId },
      select: { id: true },
    }),
  ]);
  await prisma.responseStickinessRecord.upsert({
    where: {
      userId_routingKeyDigest: {
        userId: requester.userId,
        routingKeyDigest,
      },
    },
    create: {
      userId: requester.userId,
      modelApiTokenId: requester.modelApiTokenId,
      routingKeyDigest,
      routingVersion: 2,
      targetDiscoveredModelId: targetDiscoveredModelId ?? null,
      targetExecutionTargetId: targetExecutionTarget?.id ?? null,
      targetModelPoolId: targetModelPoolId ?? null,
      selectedDiscoveredModelId,
      selectedExecutionTargetId: selectedExecutionTarget?.id ?? null,
      expiresAt,
    },
    update: {
      routingVersion: 2,
      modelApiTokenId: requester.modelApiTokenId,
      targetDiscoveredModelId: targetDiscoveredModelId ?? null,
      targetExecutionTargetId: targetExecutionTarget?.id ?? null,
      targetModelPoolId: targetModelPoolId ?? null,
      selectedDiscoveredModelId,
      selectedExecutionTargetId: selectedExecutionTarget?.id ?? null,
      expiresAt,
    },
    select: { id: true },
  });
}

function stickinessWriteError(error: unknown) {
  void error;
  console.warn("[model-api] responses stickiness write failed");
}

function reportCleanupFailures(results: readonly PromiseSettledResult<unknown>[]) {
  const failures = results.filter(({ status }) => status === "rejected").length;
  if (failures) console.warn(`[model-api] ${failures} relay cleanup operation(s) failed`);
}

async function settleRelayCleanup(tasks: readonly (() => unknown | PromiseLike<unknown>)[]) {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  reportCleanupFailures(results);
}

function rejectedRelayTerminal(): RelayAttemptTerminal {
  return {
    ok: false,
    failure: "unknown",
    httpStatusCode: 500,
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

async function resolveStickyRoute({
  requester,
  responseId,
  targets,
}: {
  requester: RelayRequester;
  responseId: string;
  targets: {
    directModels: VisibleDirectModelTarget[];
    modelPools: VisibleModelPoolTarget[];
  };
}): Promise<StickyRoute | Response> {
  const routingKeyDigest = responseStickinessDigest({ requester, responseId });
  const record = (await prisma.responseStickinessRecord.findUnique({
    where: {
      userId_routingKeyDigest: {
        userId: requester.userId,
        routingKeyDigest,
      },
    },
    select: {
      userId: true,
      routingVersion: true,
      modelApiTokenId: true,
      targetDiscoveredModelId: true,
      targetModelPoolId: true,
      selectedDiscoveredModelId: true,
      TargetExecutionTarget: { select: { discoveredModelId: true } },
      SelectedExecutionTarget: { select: { discoveredModelId: true } },
      expiresAt: true,
    },
  })) as ResponseStickinessRecordRow | null;

  const targetBound = (record?.routingVersion ?? 1) >= 2;
  if (
    targetBound &&
    (!record?.SelectedExecutionTarget ||
      (record.targetDiscoveredModelId !== null && !record.TargetExecutionTarget))
  ) {
    return openAiFailureJsonResponse("not_found", "Response routing target no longer exists.");
  }

  const targetDiscoveredModelId =
    record?.TargetExecutionTarget?.discoveredModelId ??
    (targetBound ? null : record?.targetDiscoveredModelId) ??
    null;
  const selectedDiscoveredModelId =
    record?.SelectedExecutionTarget?.discoveredModelId ??
    (targetBound ? null : record?.selectedDiscoveredModelId) ??
    null;

  if (
    !record ||
    record.userId !== requester.userId ||
    record.modelApiTokenId !== requester.modelApiTokenId ||
    !selectedDiscoveredModelId ||
    (record.expiresAt !== null && record.expiresAt <= new Date())
  ) {
    return openAiFailureJsonResponse(
      "not_found",
      "Response routing metadata was not found or has expired.",
    );
  }

  if (targetDiscoveredModelId) {
    const visibleTarget =
      targets.directModels.find((target) => target.id === targetDiscoveredModelId) ?? null;
    if (!visibleTarget) {
      return openAiFailureJsonResponse(
        "access_denied",
        "Response routing metadata is no longer accessible.",
      );
    }
    return {
      target: "DIRECT_MODEL",
      visibleTarget,
      selectedDiscoveredModelId,
    };
  }

  if (record.targetModelPoolId) {
    const visibleTarget =
      targets.modelPools.find((target) => target.id === record.targetModelPoolId) ?? null;
    if (!visibleTarget) {
      return openAiFailureJsonResponse(
        "access_denied",
        "Response routing metadata is no longer accessible.",
      );
    }
    return {
      target: "MODEL_POOL",
      visibleTarget,
      selectedDiscoveredModelId,
    };
  }

  return openAiFailureJsonResponse("not_found", "Response routing metadata is incomplete.");
}

async function directModelRow(discoveredModelId: string): Promise<DirectModelRelayRow | null> {
  return (await prisma.discoveredModel.findUnique({
    where: { id: discoveredModelId },
    select: {
      id: true,
      published: true,
      userId: true,
      upstreamModelId: true,
      capabilityOverrideMode: true,
      capabilityOverrideMetadata: true,
      optimisticBasicTranscription: true,
      ExecutionTarget: {
        select: {
          id: true,
          inferenceCapacityId: true,
          directContextCeiling: true,
          directContextMargin: true,
          directWaitBudgetMs: true,
          InferenceCapacity: {
            select: {
              physicalMaxContext: true,
              countStrategy: true,
              runtimeIdentityKey: true,
              runtimeModel: true,
              runtimeRevision: true,
              tokenizer: true,
              tokenizerVersion: true,
              template: true,
              templateVersion: true,
              engine: true,
            },
          },
        },
      },
      Endpoint: {
        select: {
          id: true,
          slug: true,
          published: true,
          cliDeviceId: true,
          status: true,
          capabilityMetadata: true,
          CliDevice: { select: { status: true } },
        },
      },
    },
  })) as DirectModelRelayRow | null;
}

async function poolMemberRows(poolId: string): Promise<PoolMemberRelayRow[]> {
  const rows = await prisma.poolMember.findMany({
    // The relay scheduler is exclusively the local/primary execution path.
    // Public overflow members are provider-backed and must only be considered
    // by public-overflow.ts after its egress, policy, budget, and credential
    // gates have run. Requiring the concrete target kind also prevents legacy
    // or partially-backfilled rows from leaking into local routing.
    where: {
      poolId,
      tier: "PRIMARY",
      ExecutionTarget: { DiscoveredModel: { isNot: null } },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      poolId: true,
      discoveredModelId: true,
      capacityContextCeiling: true,
      capacityContextCeilingMode: true,
      capacityContextMargin: true,
      capacityWaitBudgetMs: true,
      capacityWaitBudgetMode: true,
      ModelPool: {
        select: {
          capacityContextCeiling: true,
          capacityContextMargin: true,
          capacityWaitBudgetMs: true,
        },
      },
      ExecutionTarget: {
        select: {
          id: true,
          inferenceCapacityId: true,
          InferenceCapacity: {
            select: {
              physicalMaxContext: true,
              countStrategy: true,
              runtimeIdentityKey: true,
              runtimeModel: true,
              runtimeRevision: true,
              tokenizer: true,
              tokenizerVersion: true,
              template: true,
              templateVersion: true,
              engine: true,
            },
          },
          DiscoveredModel: {
            select: {
              id: true,
              userId: true,
              published: true,
              upstreamModelId: true,
              capabilityOverrideMode: true,
              capabilityOverrideMetadata: true,
              Endpoint: {
                select: {
                  id: true,
                  slug: true,
                  published: true,
                  cliDeviceId: true,
                  status: true,
                  capabilityMetadata: true,
                  CliDevice: { select: { status: true } },
                },
              },
            },
          },
        },
      },
      weight: true,
      healthStatus: true,
      routingStatus: true,
      lastFailureClass: true,
      consecutiveRetryableFailures: true,
      lastFailureAt: true,
      nextRetryAt: true,
      halfOpenTrialStartedAt: true,
      DiscoveredModel: {
        select: {
          id: true,
          userId: true,
          published: true,
          upstreamModelId: true,
          capabilityOverrideMode: true,
          capabilityOverrideMetadata: true,
          Endpoint: {
            select: {
              id: true,
              slug: true,
              published: true,
              cliDeviceId: true,
              status: true,
              capabilityMetadata: true,
              CliDevice: { select: { status: true } },
            },
          },
        },
      },
    },
  });
  return rows.flatMap((row) => {
    const discoveredModel = row.ExecutionTarget?.DiscoveredModel ?? row.DiscoveredModel;
    if (!discoveredModel) return [];
    return [{ ...row, discoveredModelId: discoveredModel.id, DiscoveredModel: discoveredModel }];
  }) as PoolMemberRelayRow[];
}

function directTargetByModelId(targets: VisibleDirectModelTarget[], modelId: string) {
  return targets.find((target) => target.modelId === modelId) ?? null;
}

function poolTargetByModelId(targets: VisibleModelPoolTarget[], modelId: string) {
  return targets.find((target) => target.modelId === modelId) ?? null;
}

/**
 * OpenAI-compatible model list with additive multimodal advertisement fields
 * (supports_vision, capabilities, architecture.input_modalities, …). See
 * `model-list-modalities.ts`. Official OpenAI only requires id/created/object/owned_by.
 */
async function modelListResponse(targets: {
  directModels: VisibleDirectModelTarget[];
  modelPools: VisibleModelPoolTarget[];
}) {
  const directIds = targets.directModels.map((model) => model.id);
  const poolIds = targets.modelPools.map((pool) => pool.id);

  const directRows =
    directIds.length === 0
      ? []
      : await prisma.discoveredModel.findMany({
          where: { id: { in: directIds } },
          select: {
            id: true,
            capabilityOverrideMode: true,
            capabilityOverrideMetadata: true,
            Endpoint: { select: { capabilityMetadata: true } },
          },
        });

  const directCapsById = new Map(
    directRows.map((row) => {
      const caps = effectiveCapabilitiesFrom({
        capabilityOverrideMode: row.capabilityOverrideMode,
        capabilityOverrideMetadata: row.capabilityOverrideMetadata,
        endpointCapabilityMetadata: row.Endpoint.capabilityMetadata,
      });
      return [row.id, multimodalFlagsFromCapabilities(caps)] as const;
    }),
  );

  const poolMemberRows =
    poolIds.length === 0
      ? []
      : await prisma.poolMember.findMany({
          // Model-list capabilities describe the local pool. Provider overflow
          // is deliberately not advertised as ordinary local capacity.
          where: {
            poolId: { in: poolIds },
            tier: "PRIMARY",
            ExecutionTarget: { DiscoveredModel: { isNot: null } },
          },
          select: {
            poolId: true,
            ExecutionTarget: {
              select: {
                DiscoveredModel: {
                  select: {
                    capabilityOverrideMode: true,
                    capabilityOverrideMetadata: true,
                    Endpoint: { select: { capabilityMetadata: true } },
                  },
                },
              },
            },
            DiscoveredModel: {
              select: {
                capabilityOverrideMode: true,
                capabilityOverrideMetadata: true,
                Endpoint: { select: { capabilityMetadata: true } },
              },
            },
          },
        });

  // Pool advertisement is a union of member flags (optimistic): if any member
  // supports vision/video/audio, the pool lists it. A single request still
  // routes to one member that may lack that modality — not a hard guarantee.
  // Pools with a media transformer also advertise the modalities they transform.
  const poolTransformerRows =
    poolIds.length === 0
      ? []
      : await prisma.modelPool.findMany({
          where: { id: { in: poolIds } },
          select: {
            id: true,
            transformerDiscoveredModelId: true,
            transformerImages: true,
            transformerAudio: true,
            transformerVideo: true,
          },
        });
  const poolTransformerById = new Map(poolTransformerRows.map((row) => [row.id, row] as const));

  const transformerModelIds = [
    ...new Set(
      poolTransformerRows
        .map((row) => row.transformerDiscoveredModelId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const transformerModelRows =
    transformerModelIds.length === 0
      ? []
      : await prisma.discoveredModel.findMany({
          where: { id: { in: transformerModelIds } },
          select: {
            id: true,
            published: true,
            capabilityOverrideMode: true,
            capabilityOverrideMetadata: true,
            Endpoint: {
              select: {
                published: true,
                capabilityMetadata: true,
              },
            },
          },
        });
  const transformerCapsById = new Map(
    transformerModelRows.map((row) => {
      // Unpublished transformers must not advertise modalities (request path fails closed).
      if (!row.published || !row.Endpoint.published) {
        return [row.id, { images: false, audio: false, video: false }] as const;
      }
      // Same resolver as pool management (strict schema parse + malformed override fallback).
      const caps = effectiveCapabilitiesFrom({
        capabilityOverrideMode: row.capabilityOverrideMode,
        capabilityOverrideMetadata: row.capabilityOverrideMetadata,
        endpointCapabilityMetadata: row.Endpoint.capabilityMetadata,
      });
      return [row.id, transformerSupportedModalities(caps)] as const;
    }),
  );

  const poolFlagsById = new Map<string, ReturnType<typeof multimodalFlagsFromCapabilities>>();
  for (const poolId of poolIds) {
    const memberFlags = poolMemberRows
      .filter((row) => row.poolId === poolId)
      .map((row) => {
        const dm = row.ExecutionTarget?.DiscoveredModel ?? row.DiscoveredModel;
        if (!dm) return multimodalFlagsFromCapabilities(null);
        const caps = effectiveCapabilitiesFrom({
          capabilityOverrideMode: dm.capabilityOverrideMode,
          capabilityOverrideMetadata: dm.capabilityOverrideMetadata,
          endpointCapabilityMetadata: dm.Endpoint.capabilityMetadata,
        });
        return multimodalFlagsFromCapabilities(caps);
      });
    let flags = unionMultimodalFlags(memberFlags);
    const transformer = poolTransformerById.get(poolId);
    if (transformer?.transformerDiscoveredModelId) {
      const supported = transformerCapsById.get(transformer.transformerDiscoveredModelId) ?? {
        images: false,
        audio: false,
        video: false,
      };
      const effective = effectiveTransformModalities({
        pool: {
          images: transformer.transformerImages,
          audio: transformer.transformerAudio,
          video: transformer.transformerVideo,
        },
        transformerCaps: supported,
      });
      flags = unionMultimodalFlags([
        flags,
        {
          text: true,
          vision: effective.images,
          video: effective.video,
          audioInput: effective.audio,
          audioOutput: false,
          audioTranscription: false,
          audioTranslation: false,
        },
      ]);
    }
    poolFlagsById.set(poolId, flags);
  }

  return {
    object: "list" as const,
    data: [
      ...targets.directModels.map((model) => {
        const flags = directCapsById.get(model.id) ?? multimodalFlagsFromCapabilities(null);
        return {
          id: model.modelId,
          object: "model" as const,
          created: 0,
          owned_by: model.ownerUserSlug,
          ...openAiModelListExtensions(flags),
        };
      }),
      ...targets.modelPools.map((pool) => {
        const flags = poolFlagsById.get(pool.id) ?? multimodalFlagsFromCapabilities(null);
        return {
          id: pool.modelId,
          object: "model" as const,
          created: 0,
          owned_by: pool.ownerUserSlug,
          ...openAiModelListExtensions(flags),
        };
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
  target: VisibleDirectModelTarget;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    modelApiTokenId: requester.modelApiTokenId,
    modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
    requestedDiscoveredModelId: target.id,
    operation: operation.capability,
    requestBytes: null,
    contextCount: operation.contextCount,
  });
  const selected = await directModelRow(target.id);
  if (!selected) {
    await operation.dispose?.();
    await failRelayMetadata({ relayRequestId, startedAt, failure: "not_found" });
    return operationFailureResponse(operation, "not_found");
  }
  const capabilities = effectiveDirectCapabilities(selected);
  const optimisticBasic =
    selected.optimisticBasicTranscription &&
    operation.capability === "audio.transcriptions" &&
    operation.transcriptionProfile &&
    isBasicTranscriptionRequest(operation.transcriptionProfile) &&
    normalizeTranscriptionCapabilities(capabilities?.audio?.transcriptions)?.supported ===
      undefined;
  if (
    !optimisticBasic &&
    !supportsOperation({
      capabilities,
      operation,
    })
  ) {
    await operation.dispose?.();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unsupported_capability",
      selectedDiscoveredModelId: selected.id,
    });
    return operationFailureResponse(operation, "unsupported_capability");
  }
  if (!isEndpointConnected(selected, new Set(manager.getActiveCliDeviceIds()))) {
    await operation.dispose?.();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "disconnected",
      selectedDiscoveredModelId: selected.id,
    });
    return operationFailureResponse(operation, "disconnected");
  }

  if (capacityRuntime && operation.contextInput) {
    try {
      const exactCount = await nativeContextCount({ request, selected, operation, manager });
      if (exactCount) {
        operation.contextCount = exactCount;
        await updateContextCountMetadata(relayRequestId, exactCount);
      }
    } catch {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "cancelled" });
      return operationFailureResponse(operation, "cancelled");
    }
  }

  let capacityLease: Awaited<ReturnType<CapacityAdmissionRuntime["acquire"]>> | undefined;
  if (capacityRuntime) {
    const identity = selected.ExecutionTarget;
    if (!identity?.inferenceCapacityId) {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "unsupported_capability" });
      return operationFailureResponse(operation, "unsupported_capability");
    }
    if (
      operation.contextCount &&
      !contextFitsLimits({
        count: operation.contextCount,
        physicalMaxContext: identity.InferenceCapacity?.physicalMaxContext,
        effectiveContextCeiling: identity.directContextCeiling,
        contextMargin: identity.directContextMargin ?? 0,
      })
    ) {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "request_too_large" });
      return contextExceededResponse(
        operation,
        "Request context exceeds the configured execution capacity ceiling.",
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
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "model-api",
          deadlineAt: boundedAdmissionDeadline(
            Date.now(),
            startedAt.getTime() + MODEL_API_RELAY_TIMEOUT_MS,
            identity.directWaitBudgetMs ?? null,
          ),
          candidates: [
            {
              capacityId: identity.inferenceCapacityId,
              executionTargetId: identity.id,
              candidateOrder: 0,
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
    cliLease = limiter.acquireCli(selected.Endpoint.cliDeviceId);
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
        selectedDiscoveredModelId: selected.id,
      });
      return operationFailureResponse(operation, error.failure);
    }
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unknown",
      selectedDiscoveredModelId: selected.id,
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
      selectedDiscoveredModelId: selected.id,
    });
    return operationFailureResponse(operation, "unknown");
  }
  const responseIdCapture =
    operation.responseStickiness && operation.family === "responses"
      ? createResponseIdCapture()
      : null;
  let attempt: ReturnType<typeof startRelayAttempt>;
  try {
    attempt = startRelayAttempt({
      manager,
      cliDeviceId: selected.Endpoint.cliDeviceId,
      endpointSlug: selected.Endpoint.slug,
      family: operation.family,
      method: operation.method,
      path: operation.path,
      headers: builtRequest.headers,
      ...relayAttemptBody(builtRequest.body),
      timeoutMs: MODEL_API_RELAY_TIMEOUT_MS,
      abortSignal: request.signal,
      onResponseBodyChunk: responseIdCapture
        ? (chunk) => responseIdCapture.push(chunk, operation.stream)
        : undefined,
    });
  } catch {
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
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unknown",
      selectedDiscoveredModelId: selected.id,
      attemptCount: 1,
    });
    return operationFailureResponse(operation, "unknown");
  }

  try {
    const started = await attempt.started;
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
        const responseId = responseIdCapture?.finish(operation.stream) ?? null;
        await Promise.allSettled([
          updateRelayMetadata(relayRequestId, {
            selectedDiscoveredModelId: selected.id,
            status: terminalStatus(terminal),
            startedAt,
            terminal,
            attemptCount: 1,
          }).catch(metadataUpdateError),
          terminal.ok && responseId && operation.responseStickiness
            ? writeResponseStickiness({
                ...operation.responseStickiness,
                responseId,
                targetDiscoveredModelId: target.id,
                selectedDiscoveredModelId: selected.id,
              }).catch(stickinessWriteError)
            : Promise.resolve(),
        ]);
      })
      .catch(metadataUpdateError);
    void finalize;
    const response = new Response(
      responseBodyForOperation({
        body: started.body,
        headers: started.headers,
        terminal: attempt.terminal,
        operation,
      }),
      { status: started.status, headers: started.headers },
    );
    return capacityLease?.state === "ADMITTED"
      ? (capacityRuntime?.hold(response, capacityLease.lease, request.signal) ?? response)
      : response;
  } catch {
    const terminal = await attempt.terminal.catch(() => rejectedRelayTerminal());
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
      selectedDiscoveredModelId: selected.id,
      status: terminalStatus(terminal),
      startedAt,
      terminal,
      attemptCount: 1,
    });
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
}: {
  request: Request;
  requester: RelayRequester;
  target: VisibleModelPoolTarget;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  transformDebug?: TransformDebug;
  capacityRuntime?: CapacityAdmissionRuntime;
}): Promise<Response> {
  const startedAt = new Date();
  const relayDeadlineMs = startedAt.getTime() + MODEL_API_RELAY_TIMEOUT_MS;
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    modelApiTokenId: requester.modelApiTokenId,
    modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
    requestedModelPoolId: target.id,
    transformerLatencyMs: transformDebug?.latencyMs ?? null,
    transformerCacheHit: transformDebug?.cacheHit ?? null,
    transformerErrorClass: transformDebug?.error ?? null,
    operation: operation.capability,
    requestBytes: null,
    contextCount: operation.contextCount,
  });

  const tryPublicOverflow = async (
    reason: PublicOverflowReason,
    releaseLocalCapacity: () => Promise<void>,
  ): Promise<Response | null> => {
    // Public provider dispatch is intentionally limited to replayable modern
    // JSON operations. Stateful Responses and multipart/audio paths must retain
    // their exact target or fail safely.
    if (!operation.contextInput || operation.responseStickiness) return null;
    let built: BuiltRelayRequest;
    try {
      built = await operation.buildRequest("__public_provider_model__");
    } catch {
      return null;
    }
    if (!(built.body instanceof Uint8Array)) {
      await built.body.dispose();
      return null;
    }
    const publicRequestBytes = built.body.byteLength;
    const requestedProtocol: "openai" | "anthropic" =
      operation.family === "messages" ? "anthropic" : "openai";
    const requestedSurface: ProtocolSurface =
      operation.family === "messages"
        ? "anthropic-messages"
        : operation.family === "responses"
          ? "openai-responses"
          : "openai-chat";
    const maxOutput = operation.contextInput.max_output_tokens ?? operation.contextInput.max_tokens;
    const requestedFeatures = profileSurfaceRequest(operation.contextInput);
    const requiredFeatures = Object.entries(requestedFeatures)
      .filter(([, enabled]) => enabled === true)
      .map(([feature]) => feature);
    const requestedOutputTokens =
      typeof maxOutput === "number" && Number.isSafeInteger(maxOutput) && maxOutput >= 0
        ? BigInt(maxOutput)
        : 4096n;
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
    const result = await dispatchPublicOverflow({
      userId: requester.userId,
      poolId: target.id,
      requestId: relayRequestId,
      reason,
      requestedProtocol,
      requestedSurface,
      stream: operation.stream,
      requiredFeatures,
      path: operation.path,
      headers: built.headers,
      body: built.body,
      signal: request.signal,
      releaseLocalCapacity,
      adaptationEnabled:
        operation.adaptation?.featureEnabled === true && operation.adaptation.poolEnabled,
      retrySafe:
        shouldRetryRelayOperation(operation, "precommit_5xx") &&
        shouldRetryRelayOperation(operation, "precommit_transport"),
      liability: conservativeProviderLiability({
        estimatedInputTokens:
          operation.contextCount?.tokens !== undefined
            ? BigInt(operation.contextCount.tokens)
            : conservativeSerializedInputTokens(publicRequestBytes),
        requestedOutputTokens,
      }),
      requestedOutputTokens,
      renderForTarget: canonical
        ? async (providerTarget, targetSurface) => {
            const payload = renderCanonicalRequest({
              request: canonical,
              target: targetSurface,
              model: providerTarget.upstreamModelId,
              allowLossyDeveloperRoleCollapse:
                operation.adaptation?.allowLossyDeveloperRoleCollapse,
            });
            const headers = new Headers({ "content-type": "application/json" });
            if (providerTarget.protocol === "anthropic")
              headers.set("anthropic-version", providerTarget.providerVersion ?? "2023-06-01");
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
    });
    if (!result.dispatched) return null;
    await prisma.relayRequest
      .update({
        where: { id: relayRequestId },
        data: {
          selectedExecutionTargetId: result.target.executionTargetId,
          publicEgress: true,
          publicOverflowReason: reason,
          selectedPoolMemberTier: "PUBLIC_OVERFLOW",
          providerAccountId: result.target.providerAccountId,
          providerModelId: result.target.providerModelId,
          providerAttemptId: result.attemptId,
          providerFencingToken: result.fencingToken,
          attemptCount: result.attemptCount,
        },
        select: { id: true },
      })
      .catch(metadataUpdateError);
    void result.terminal
      .then(async (terminal) => {
        const completedAt = new Date();
        await Promise.allSettled([
          prisma.relayRequest.update({
            where: { id: relayRequestId },
            data: {
              selectedExecutionTargetId: result.target.executionTargetId,
              status: terminal.ok ? "SUCCEEDED" : request.signal.aborted ? "CANCELED" : "FAILED",
              completedAt,
              durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
              httpStatusCode: result.response.status,
              upstreamStatusCode: result.response.status,
              requestBytes: BigInt(publicRequestBytes),
              responseBytes: BigInt(terminal.responseBytes),
              attemptCount: result.attemptCount,
              errorClass: terminal.ok ? null : request.signal.aborted ? "cancelled" : "unknown",
            },
            select: { id: true },
          }),
          operation.dispose?.() ?? Promise.resolve(),
        ]);
      })
      .catch(metadataUpdateError);
    // Native response bytes remain opaque. Cross-protocol provider response
    // adaptation is handled by the same strict streaming/non-streaming state
    // machines as local targets.
    if (result.nativeSurface === requestedSurface || !operation.adaptation) return result.response;
    const source: ProtocolSurface = result.nativeSurface;
    // Providers return ordinary JSON error envelopes even when the successful
    // operation would have streamed. Adapt that envelope as JSON; never feed
    // it into an SSE state machine or advertise it as an event stream.
    if (result.response.status < 200 || result.response.status >= 300) {
      if (!result.response.body) return result.response;
      const adapted = await readAdaptedNonstreamBody({
        body: result.response.body,
        source,
        target: operation.adaptation.requestedSurface,
        status: result.response.status,
        headers: result.response.headers,
        signal: request.signal,
      });
      return new Response(adapted, {
        status: result.response.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-wsmp-adapter-version": "1.0.0",
        },
      });
    }
    if (operation.stream) {
      if (!result.response.body) return result.response;
      return new Response(
        adaptedResponseBody({
          body: result.response.body,
          source,
          target: operation.adaptation.requestedSurface,
          stream: true,
          status: result.response.status,
          headers: result.response.headers,
          signal: request.signal,
        }),
        {
          status: result.response.status,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-wsmp-adapter-version": "1.0.0",
          },
        },
      );
    }
    const bytes = new Uint8Array(await result.response.arrayBuffer());
    const adapted = await readAdaptedNonstreamBody({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      source,
      target: operation.adaptation.requestedSurface,
      status: result.response.status,
      headers: result.response.headers,
      signal: request.signal,
    });
    return new Response(adapted, {
      status: result.response.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-wsmp-adapter-version": "1.0.0",
      },
    });
  };

  let globalLease: ModelApiLimitLease | undefined;

  const members = await poolMemberRows(target.id);
  const nativeCounts = new Map<string, ContextCountTelemetry>();
  if (capacityRuntime && operation.contextInput) {
    await Promise.all(
      members.map(async (member) => {
        const selected = {
          ...member.DiscoveredModel,
          optimisticBasicTranscription: false,
          ExecutionTarget: member.ExecutionTarget,
          Endpoint: {
            ...member.DiscoveredModel.Endpoint,
            status: member.DiscoveredModel.Endpoint.status ?? null,
            CliDevice: member.DiscoveredModel.Endpoint.CliDevice ?? null,
          },
        } satisfies DirectModelRelayRow;
        if (!isEndpointConnected(selected, new Set(manager.getActiveCliDeviceIds()))) return;
        try {
          const count = await nativeContextCount({ request, selected, operation, manager });
          if (count) nativeCounts.set(member.id, count);
        } catch {
          // The request-level abort is handled by admission/relay below; an
          // individual unavailable counter safely retains the estimate.
        }
      }),
    );
  }
  const contextEligibleMembers = operation.contextCount
    ? members.filter((member) =>
        contextFitsLimits({
          count: nativeCounts.get(member.id) ?? operation.contextCount!,
          physicalMaxContext: member.ExecutionTarget?.InferenceCapacity?.physicalMaxContext,
          effectiveContextCeiling:
            member.capacityContextCeilingMode === "UNLIMITED"
              ? null
              : member.capacityContextCeilingMode === "LIMITED" ||
                  (member.capacityContextCeilingMode === undefined &&
                    member.capacityContextCeiling != null)
                ? member.capacityContextCeiling
                : member.ModelPool?.capacityContextCeiling,
          contextMargin:
            member.capacityContextMargin ?? member.ModelPool?.capacityContextMargin ?? 0,
        }),
      )
    : members;
  if (members.length > 0 && contextEligibleMembers.length === 0) {
    const overflow = await tryPublicOverflow("LOCAL_CONTEXT_CEILING", async () => undefined);
    if (overflow) return overflow;
    await operation.dispose?.();
    await failRelayMetadata({ relayRequestId, startedAt, failure: "request_too_large" });
    return contextExceededResponse(
      operation,
      "Request context exceeds every compatible pool member ceiling.",
    );
  }
  let canonicalAdaptationRequest: ReturnType<typeof parseCanonicalRequest> | null = null;
  if (operation.adaptation?.featureEnabled === true && operation.adaptation.poolEnabled) {
    try {
      canonicalAdaptationRequest = parseCanonicalRequest(
        operation.adaptation.requestedSurface,
        operation.adaptation.payload,
      );
    } catch {
      // Native members may still accept extensions outside the strict adapted subset.
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
  const protocolCandidates = contextEligibleMembers.filter((member) => {
    const execution = executionByMember.get(member.id);
    if (!execution)
      return supportsOperation({
        capabilities: effectivePoolMemberCapabilities(member),
        operation,
      });
    if (execution.mode === "unavailable") return false;
    if (execution.mode === "native") return true;
    const source = execution.nativeSurface ? protocolSurface(execution.nativeSurface) : null;
    if (!source || !canonicalAdaptationRequest) return false;
    try {
      renderCanonicalRequest({
        request: canonicalAdaptationRequest,
        target: source,
        model: member.DiscoveredModel.upstreamModelId,
        allowLossyDeveloperRoleCollapse: operation.adaptation?.allowLossyDeveloperRoleCollapse,
      });
      return true;
    } catch {
      return false;
    }
  });
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
  const knownEligibleMembers = [
    ...nativeProtocolCandidates,
    ...adaptedProtocolCandidates,
    ...legacyProtocolCandidates,
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
    const overflow = await tryPublicOverflow(
      "NO_COMPATIBLE_HEALTHY_PRIMARY",
      async () => undefined,
    );
    if (overflow) return overflow;
    globalLease?.release();
    await operation.dispose?.();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unsupported_capability",
    });
    return operationFailureResponse(operation, "unsupported_capability");
  }

  const activeCliDeviceIds = manager.getActiveCliDeviceIds();
  const now = new Date();
  const nativeSequence = buildPoolRouteSequence({
    members: nativeProtocolCandidates,
    activeCliDeviceIds,
    now,
  });
  const adaptedSequence = buildPoolRouteSequence({
    members: adaptedProtocolCandidates,
    activeCliDeviceIds,
    now,
  });
  const legacySequence = buildPoolRouteSequence({
    members: legacyProtocolCandidates,
    activeCliDeviceIds,
    now,
  });
  const unknownSequence = buildPoolRouteSequence({
    members: unknownFallbackMembers,
    activeCliDeviceIds,
    now,
  });
  const routeCandidates = [
    ...(nativeSequence.ok ? nativeSequence.candidates : []),
    ...(adaptedSequence.ok ? adaptedSequence.candidates : []),
    ...(legacySequence.ok ? legacySequence.candidates : []),
    ...(unknownSequence.ok ? unknownSequence.candidates : []),
  ];
  if (routeCandidates.length === 0) {
    const overflow = await tryPublicOverflow(
      "NO_COMPATIBLE_HEALTHY_PRIMARY",
      async () => undefined,
    );
    if (overflow) return overflow;
    globalLease?.release();
    await operation.dispose?.();
    await failRelayMetadata({ relayRequestId, startedAt, failure: "disconnected" });
    return operationFailureResponse(operation, "disconnected");
  }

  const memberById = new Map(eligibleMembers.map((member) => [member.id, member] as const));
  let capacityLease: Awaited<ReturnType<CapacityAdmissionRuntime["acquire"]>> | undefined;
  let selectedRouteCandidates = routeCandidates;
  const applyMemberContextCount = async (poolMemberId: string) => {
    const count = nativeCounts.get(poolMemberId);
    if (!count) return;
    operation.contextCount = count;
    await updateContextCountMetadata(relayRequestId, count);
  };
  if (capacityRuntime) {
    const admissionStartedAt = Date.now();
    const admissionCandidates = routeCandidates.map((candidate, candidateOrder) => {
      const member = memberById.get(candidate.poolMemberId);
      return member
        ? poolAdmissionCandidate(member, candidateOrder, admissionStartedAt, relayDeadlineMs)
        : null;
    });
    if (admissionCandidates.some((candidate) => candidate === null)) {
      globalLease?.release();
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "unsupported_capability" });
      return operationFailureResponse(operation, "unsupported_capability");
    }
    try {
      capacityLease = await acquireCapacityWithTelemetry({
        runtime: capacityRuntime,
        relayRequestId,
        attempt: {
          requestId: crypto.randomUUID(),
          relayRequestId,
          attemptId: crypto.randomUUID(),
          ownerId: requester.userId,
          sourceKind: "POOL",
          poolId: target.id,
          basePriority: 16,
          connectionOwner: "model-api",
          deadlineAt: new Date(relayDeadlineMs),
          candidates: admissionCandidates.filter((candidate) => candidate !== null),
        },
        signal: request.signal,
      });
    } catch {
      globalLease?.release();
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "unknown" });
      return operationFailureResponse(operation, "unknown");
    }
    if (capacityLease.state !== "ADMITTED" || !capacityLease.lease.poolMemberId) {
      const overflow = await tryPublicOverflow("LOCAL_WAIT_EXPIRED", async () => undefined);
      if (overflow) return overflow;
      globalLease?.release();
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "rate_limited" });
      return operationFailureResponse(operation, "rate_limited");
    }
    const selectedPoolMemberId = capacityLease.lease.poolMemberId;
    try {
      await applyMemberContextCount(selectedPoolMemberId);
    } catch {
      const admittedLease = capacityLease.lease;
      await settleRelayCleanup([
        () => capacityRuntime.release(admittedLease),
        () => operation.dispose?.(),
      ]);
      await failRelayMetadata({ relayRequestId, startedAt, failure: "unknown" }).catch(
        metadataUpdateError,
      );
      return operationFailureResponse(operation, "unknown");
    }
    selectedRouteCandidates = [
      ...routeCandidates.filter(({ poolMemberId }) => poolMemberId === selectedPoolMemberId),
      ...routeCandidates.filter(({ poolMemberId }) => poolMemberId !== selectedPoolMemberId),
    ];
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
      await failRelayMetadata({ relayRequestId, startedAt, failure: error.failure });
      return operationFailureResponse(operation, error.failure);
    }
    await failRelayMetadata({ relayRequestId, startedAt, failure: "unknown" }).catch(
      metadataUpdateError,
    );
    return operationFailureResponse(operation, "unknown");
  }
  let finalFailure: RelayFailure = "unknown";
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
      const admissionStartedAt = Date.now();
      const admissionCandidates = remaining.map((remainingCandidate, candidateOrder) => {
        const member = memberById.get(remainingCandidate.poolMemberId);
        if (!member)
          throw new Error("Capacity-enabled pool member lost execution target identity.");
        const resolved = poolAdmissionCandidate(
          member,
          candidateOrder,
          admissionStartedAt,
          relayDeadlineMs,
        );
        if (!resolved)
          throw new Error("Capacity-enabled pool member lost execution target identity.");
        return resolved;
      });
      try {
        capacityLease = await acquireCapacityWithTelemetry({
          runtime: capacityRuntime,
          relayRequestId,
          attempt: {
            requestId: crypto.randomUUID(),
            relayRequestId,
            attemptId: crypto.randomUUID(),
            ownerId: requester.userId,
            sourceKind: "POOL",
            poolId: target.id,
            basePriority: 16,
            connectionOwner: "model-api",
            deadlineAt: new Date(relayDeadlineMs),
            candidates: admissionCandidates,
          },
          signal: request.signal,
        });
      } catch {
        finalFailure = "unknown";
        break;
      }
      if (capacityLease.state !== "ADMITTED" || !capacityLease.lease.poolMemberId) {
        finalFailure = "rate_limited";
        break;
      }
      const admittedPoolMemberId = capacityLease.lease.poolMemberId;
      try {
        await applyMemberContextCount(admittedPoolMemberId);
      } catch {
        await releaseCapacityAttempt();
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
        break;
      }
    }
    if (remainingRelayBudgetMs(relayDeadlineMs) === 0) {
      finalFailure = "timeout";
      break;
    }
    const member = memberById.get(candidate.poolMemberId);
    if (!member) continue;

    let cliLease: ModelApiLimitLease;
    try {
      cliLease = limiter.acquireCli(candidate.cliDeviceId);
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

    if (candidate.healthStatus === "HALF_OPEN") {
      let claimed: number;
      try {
        claimed = await markPoolMemberHalfOpenTrial({
          poolMemberId: candidate.poolMemberId,
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
        const rendered = renderCanonicalRequest({
          request: canonicalAdaptationRequest,
          target: adaptedSource,
          model: candidate.upstreamModelId,
          allowLossyDeveloperRoleCollapse: operation.adaptation.allowLossyDeveloperRoleCollapse,
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
      await recordPoolMemberRelayFailure({
        poolMemberId: candidate.poolMemberId,
        failure: "unknown",
      }).catch(metadataUpdateError);
      await releaseCapacityAttempt();
      continue;
    }
    const responseIdCapture =
      operation.responseStickiness && operation.family === "responses"
        ? createResponseIdCapture()
        : null;
    const attemptTimeoutMs = remainingRelayBudgetMs(relayDeadlineMs);
    if (attemptTimeoutMs === 0) {
      await settleRelayCleanup([
        () => cliLease.release(),
        () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      ]);
      finalFailure = "timeout";
      break;
    }
    attemptCount += 1;
    let attempt: ReturnType<typeof startRelayAttempt>;
    try {
      attempt = startRelayAttempt({
        manager,
        cliDeviceId: candidate.cliDeviceId,
        endpointSlug: member.DiscoveredModel.Endpoint.slug,
        family: adaptedSource ? nativeRouteForSurface(adaptedSource).family : operation.family,
        method: operation.method,
        path: adaptedSource ? nativeRouteForSurface(adaptedSource).path : operation.path,
        headers: builtRequest.headers,
        ...relayAttemptBody(builtRequest.body),
        timeoutMs: attemptTimeoutMs,
        abortSignal: request.signal,
        onResponseBodyChunk: responseIdCapture
          ? (chunk) => responseIdCapture.push(chunk, operation.stream)
          : undefined,
      });
    } catch {
      await settleRelayCleanup([
        () => cliLease.release(),
        () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      ]);
      finalFailure = "unknown";
      await recordPoolMemberRelayFailure({
        poolMemberId: candidate.poolMemberId,
        failure: "unknown",
      }).catch(metadataUpdateError);
      await releaseCapacityAttempt();
      continue;
    }

    try {
      const started = await attempt.started;
      if (started.status >= 500 && shouldRetryRelayOperation(operation, "precommit_5xx")) {
        attempt.cancel("upstream_5xx");
        const terminal = await attempt.terminal;
        cumulativeRequestBytes += terminal.requestBytes;
        cumulativeResponseBytes += terminal.responseBytes;
        await settleRelayCleanup([
          () => cliLease.release(),
          () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
        ]);
        finalFailure = "upstream_5xx";
        await recordPoolMemberRelayFailure({
          poolMemberId: candidate.poolMemberId,
          failure: "upstream_5xx",
        }).catch(metadataUpdateError);
        await releaseCapacityAttempt();
        continue;
      }

      if (adaptedSource && operation.adaptation && started.status >= 200 && started.status < 300) {
        const upstreamSse =
          started.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ===
          true;
        if (upstreamSse !== operation.stream) {
          attempt.cancel("protocol_error");
          const terminal = await attempt.terminal;
          cumulativeRequestBytes += terminal.requestBytes;
          cumulativeResponseBytes += terminal.responseBytes;
          await settleRelayCleanup([
            () => cliLease.release(),
            () =>
              builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose(),
          ]);
          finalFailure = "protocol_error";
          await recordPoolMemberRelayFailure({
            poolMemberId: candidate.poolMemberId,
            failure: "protocol_error",
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
      if (adaptedSource && operation.adaptation && !operation.stream) {
        try {
          validatedAdaptedNonstream = await readAdaptedNonstreamBody({
            body: started.body,
            source: adaptedSource,
            target: operation.adaptation.requestedSurface,
            status: started.status,
            headers: started.headers,
            signal: request.signal,
          });
        } catch {
          attempt.cancel("protocol_error");
          const terminal = await attempt.terminal;
          cumulativeRequestBytes += terminal.requestBytes;
          cumulativeResponseBytes += terminal.responseBytes;
          await settleRelayCleanup([
            () => cliLease.release(),
            () =>
              builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose(),
          ]);
          finalFailure = "protocol_error";
          await recordPoolMemberRelayFailure({
            poolMemberId: candidate.poolMemberId,
            failure: "protocol_error",
          }).catch(metadataUpdateError);
          await releaseCapacityAttempt();
          continue;
        }
      }
      if (adaptedSource && operation.adaptation && operation.stream) {
        try {
          let protocolFailureObserved = false;
          const primed = await primeReadableStream(
            adaptedResponseBody({
              body: started.body,
              source: adaptedSource,
              target: operation.adaptation.requestedSurface,
              stream: true,
              status: started.status,
              headers: started.headers,
              signal: request.signal,
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
        } catch {
          attempt.cancel("protocol_error");
          const terminal = await attempt.terminal;
          cumulativeRequestBytes += terminal.requestBytes;
          cumulativeResponseBytes += terminal.responseBytes;
          await settleRelayCleanup([
            () => cliLease.release(),
            () =>
              builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose(),
          ]);
          finalFailure = "protocol_error";
          await recordPoolMemberRelayFailure({
            poolMemberId: candidate.poolMemberId,
            failure: "protocol_error",
          }).catch(metadataUpdateError);
          await releaseCapacityAttempt();
          continue;
        }
      }

      const finalize = Promise.allSettled([attempt.terminal, adaptationCompletion])
        .then(async ([terminalResult, adaptationResult]) => {
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
          const responseId = responseIdCapture?.finish(operation.stream) ?? null;
          const terminalWrites = await Promise.allSettled([
            terminal.ok
              ? markPoolMemberRelaySuccess(candidate.poolMemberId)
              : adaptationOutcome === "protocol_error"
                ? recordPoolMemberRelayFailure({
                    poolMemberId: candidate.poolMemberId,
                    failure: "protocol_error",
                  })
                : Promise.resolve(),
            updateRelayMetadata(relayRequestId, {
              selectedDiscoveredModelId: member.discoveredModelId,
              status: terminalStatus(terminal),
              startedAt,
              terminal: cumulativeTerminal,
              attemptCount,
            }).catch(metadataUpdateError),
            terminal.ok && responseId && operation.responseStickiness
              ? writeResponseStickiness({
                  ...operation.responseStickiness,
                  responseId,
                  targetModelPoolId: target.id,
                  selectedDiscoveredModelId: member.discoveredModelId,
                }).catch(stickinessWriteError)
              : Promise.resolve(),
          ]);
          reportCleanupFailures(terminalWrites);
        })
        .catch(metadataUpdateError);
      void finalize;
      let responseHeaders = new Headers(started.headers);
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
              body: started.body,
              headers: started.headers,
              terminal: attempt.terminal,
              operation,
            });
      if (adaptedSource && operation.adaptation) {
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
          });
        responseHeaders = new Headers();
        responseHeaders.set(
          "content-type",
          adaptedStreaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
        );
        responseHeaders.set("x-wsmp-adapter-version", "1.0.0");
        responseHeaders.set("x-wsmp-adapter-limitations", "strict_common_subset");
        const retryAfter = sourceHeaders.get("retry-after");
        if (retryAfter) responseHeaders.set("retry-after", retryAfter);
        const sourceRequestId =
          adaptedSource === "anthropic-messages"
            ? sourceHeaders.get("request-id")
            : sourceHeaders.get("x-request-id");
        if (sourceRequestId)
          responseHeaders.set(
            operation.adaptation.requestedSurface === "anthropic-messages"
              ? "request-id"
              : "x-request-id",
            sourceRequestId,
          );
        const rateHeaderPairs = [
          ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"],
          ["x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"],
          ["x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset"],
        ] as const;
        for (const [openAiName, anthropicName] of rateHeaderPairs) {
          const value = sourceHeaders.get(
            adaptedSource === "anthropic-messages" ? anthropicName : openAiName,
          );
          if (value)
            responseHeaders.set(
              operation.adaptation.requestedSurface === "anthropic-messages"
                ? anthropicName
                : openAiName,
              value,
            );
        }
      }
      const response = new Response(responseBody, {
        status: started.status,
        headers: responseHeaders,
      });
      return capacityLease?.state === "ADMITTED"
        ? (capacityRuntime?.hold(response, capacityLease.lease, request.signal) ?? response)
        : response;
    } catch {
      const terminal = await attempt.terminal.catch(() => rejectedRelayTerminal());
      cumulativeRequestBytes += terminal.requestBytes;
      cumulativeResponseBytes += terminal.responseBytes;
      await settleRelayCleanup([
        () => cliLease.release(),
        () => (builtRequest.body instanceof Uint8Array ? undefined : builtRequest.body.dispose()),
      ]);
      const failure = terminal.failure ?? "unknown";
      finalFailure = failure;
      if (!shouldRetryRelayOperation(operation, "precommit_transport")) break;
      if (isPoolRelayFailureClass(failure) && isRetryablePoolMemberRelayFailure(failure)) {
        await recordPoolMemberRelayFailure({
          poolMemberId: candidate.poolMemberId,
          failure,
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
      await updateRelayMetadata(relayRequestId, {
        selectedDiscoveredModelId: member.discoveredModelId,
        status: terminalStatus(terminal),
        startedAt,
        terminal: {
          ...terminal,
          requestBytes: cumulativeRequestBytes,
          responseBytes: cumulativeResponseBytes,
        },
        attemptCount,
      });
      return operationFailureResponse(operation, failure);
    }
  }

  const overflowReason: PublicOverflowReason =
    finalFailure === "rate_limited" || finalFailure === "timeout"
      ? "LOCAL_WAIT_EXPIRED"
      : "RETRYABLE_PRECOMMIT_PRIMARY_FAILURE";
  const overflow = await tryPublicOverflow(overflowReason, async () => {
    const lease = capacityLease?.state === "ADMITTED" ? capacityLease.lease : undefined;
    capacityLease = undefined;
    const acquiredGlobalLease = globalLease;
    globalLease = undefined;
    await settleRelayCleanup([
      () => acquiredGlobalLease?.release(),
      () => (lease ? capacityRuntime?.release(lease) : undefined),
    ]);
  });
  if (overflow) return overflow;

  await settleRelayCleanup([
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
    failure: finalFailure,
    attemptCount,
    requestBytes: cumulativeRequestBytes,
    responseBytes: cumulativeResponseBytes,
  });
  return operationFailureResponse(operation, finalFailure);
}

async function relaySelectedModelNoFailover({
  request,
  requester,
  selectedDiscoveredModelId,
  requestedDiscoveredModelId,
  requestedModelPoolId,
  operation,
  manager,
  limiter,
  capacityRuntime,
}: {
  request: Request;
  requester: RelayRequester;
  selectedDiscoveredModelId: string;
  requestedDiscoveredModelId?: string;
  requestedModelPoolId?: string;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    modelApiTokenId: requester.modelApiTokenId,
    modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
    requestedDiscoveredModelId,
    requestedModelPoolId,
    operation: operation.capability,
    requestBytes: null,
    contextCount: operation.contextCount,
  });
  const selected = await directModelRow(selectedDiscoveredModelId);
  if (!selected) {
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
      selectedDiscoveredModelId: selected.id,
    });
    return operationFailureResponse(operation, "unsupported_capability");
  }

  if (!isEndpointConnected(selected, new Set(manager.getActiveCliDeviceIds()))) {
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "disconnected",
      selectedDiscoveredModelId: selected.id,
    });
    return operationFailureResponse(operation, "disconnected");
  }

  let capacityLease: Awaited<ReturnType<CapacityAdmissionRuntime["acquire"]>> | undefined;
  if (capacityRuntime) {
    const poolMember = requestedModelPoolId
      ? (await poolMemberRows(requestedModelPoolId)).find(
          (member) => member.discoveredModelId === selectedDiscoveredModelId,
        )
      : undefined;
    const identity = poolMember?.ExecutionTarget ?? selected.ExecutionTarget;
    if (!identity?.inferenceCapacityId || (requestedModelPoolId && !poolMember)) {
      await operation.dispose?.();
      await failRelayMetadata({ relayRequestId, startedAt, failure: "unsupported_capability" });
      return operationFailureResponse(operation, "unsupported_capability");
    }
    try {
      capacityLease = await acquireCapacityWithTelemetry({
        runtime: capacityRuntime,
        relayRequestId,
        attempt: {
          requestId: crypto.randomUUID(),
          relayRequestId,
          attemptId: crypto.randomUUID(),
          ownerId: selected.userId,
          sourceKind: requestedModelPoolId ? "POOL" : "DIRECT",
          basePriority: 16,
          connectionOwner: "model-api",
          deadlineAt: boundedAdmissionDeadline(
            Date.now(),
            startedAt.getTime() + MODEL_API_RELAY_TIMEOUT_MS,
            poolMember
              ? effectiveMemberWaitBudget(poolMember)
              : (selected.ExecutionTarget?.directWaitBudgetMs ?? null),
          ),
          candidates: [
            {
              capacityId: identity.inferenceCapacityId,
              executionTargetId: identity.id,
              poolMemberId: poolMember?.id,
              candidateOrder: 0,
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
    cliLease = limiter.acquireCli(selected.Endpoint.cliDeviceId);
  } catch (error) {
    cliLease?.release();
    globalLease?.release();
    if (capacityLease?.state === "ADMITTED") await capacityRuntime?.release(capacityLease.lease);
    if (error instanceof ModelApiLimitError) {
      await failRelayMetadata({
        relayRequestId,
        startedAt,
        failure: error.failure,
        selectedDiscoveredModelId: selected.id,
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
      selectedDiscoveredModelId: selected.id,
    });
    return operationFailureResponse(operation, "unknown");
  }
  const responseIdCapture =
    operation.responseStickiness && operation.family === "responses"
      ? createResponseIdCapture()
      : null;
  const attempt = startRelayAttempt({
    manager,
    cliDeviceId: selected.Endpoint.cliDeviceId,
    endpointSlug: selected.Endpoint.slug,
    family: operation.family,
    method: operation.method,
    path: operation.path,
    headers: builtRequest.headers,
    ...relayAttemptBody(builtRequest.body),
    timeoutMs: MODEL_API_RELAY_TIMEOUT_MS,
    abortSignal: request.signal,
    onResponseBodyChunk: responseIdCapture
      ? (chunk) => responseIdCapture.push(chunk, operation.stream)
      : undefined,
  });

  try {
    const started = await attempt.started;
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
        const responseId = responseIdCapture?.finish(operation.stream) ?? null;
        await Promise.allSettled([
          updateRelayMetadata(relayRequestId, {
            selectedDiscoveredModelId: selected.id,
            status: terminalStatus(terminal),
            startedAt,
            terminal,
            attemptCount: 1,
          }).catch(metadataUpdateError),
          terminal.ok && responseId && operation.responseStickiness
            ? writeResponseStickiness({
                ...operation.responseStickiness,
                responseId,
                selectedDiscoveredModelId: selected.id,
              }).catch(stickinessWriteError)
            : Promise.resolve(),
        ]);
      })
      .catch(metadataUpdateError);
    void finalize;
    const response = new Response(
      responseBodyForOperation({
        body: started.body,
        headers: started.headers,
        terminal: attempt.terminal,
        operation,
      }),
      { status: started.status, headers: started.headers },
    );
    return capacityLease?.state === "ADMITTED"
      ? (capacityRuntime?.hold(response, capacityLease.lease, request.signal) ?? response)
      : response;
  } catch {
    const terminal = await attempt.terminal.catch(() => rejectedRelayTerminal());
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
      selectedDiscoveredModelId: selected.id,
      status: terminalStatus(terminal),
      startedAt,
      terminal,
      attemptCount: 1,
    });
    return operationFailureResponse(operation, terminal.failure ?? "unknown");
  }
}

/**
 * If the pool has a media transformer and the chat body has raw media, call the
 * transformer once per originating message (skipping turns that only have prior
 * envelopes), inject descriptions in place, then return a rewritten primary payload.
 */
async function maybeApplyPoolMediaTransformer({
  request,
  requester,
  poolId,
  prepared,
  operationFamily,
  manager,
  limiter,
}: {
  request: Request;
  requester: RelayRequester;
  poolId: string;
  prepared: PreparedModeledRequest;
  operationFamily: ModelApiEndpointFamily;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}): Promise<PreparedModeledRequest | Response> {
  if (operationFamily !== "chat.completions") return prepared;
  if (!prepared.payload || !Array.isArray(prepared.payload.messages)) return prepared;

  const pool = (await prisma.modelPool.findUnique({
    where: { id: poolId },
    select: {
      transformerDiscoveredModelId: true,
      transformerSystemPrompt: true,
      transformerImages: true,
      transformerAudio: true,
      transformerVideo: true,
      transformerCacheMode: true,
      transformerIncludePrimaryTools: true,
      transformerMaxTools: true,
      transformerMaxToolChars: true,
      transformerTimeoutMs: true,
      transformerMaxAssets: true,
    },
  })) as {
    transformerDiscoveredModelId: string | null;
    transformerSystemPrompt: string | null;
    transformerImages: boolean;
    transformerAudio: boolean;
    transformerVideo: boolean;
    transformerCacheMode: string;
    transformerIncludePrimaryTools: boolean;
    transformerMaxTools: number;
    transformerMaxToolChars: number;
    transformerTimeoutMs: number | null;
    transformerMaxAssets: number | null;
  } | null;

  if (!pool?.transformerDiscoveredModelId) return prepared;

  // Pool toggles only — used to detect whether this request needs transform work.
  // Do not validate the transformer model until we know media is present.
  const poolModalities: TransformModalities = {
    images: pool.transformerImages,
    audio: pool.transformerAudio,
    video: pool.transformerVideo,
  };
  if (!anyTransformModalityEnabled(poolModalities)) {
    return prepared;
  }

  const hasRawMedia = messagesHaveTransformableMedia(prepared.payload.messages, poolModalities);
  const hasEnvelopes = messagesContainTransformEnvelope(prepared.payload.messages);

  // Text-only / no media: never touch the transformer (broken transformers must
  // not break plain text pool traffic).
  if (!hasRawMedia) {
    // Envelope-only history: still inject policy system so prior/spoofed
    // envelope text is not treated as unguarded instructions.
    if (!hasEnvelopes) return prepared;
    const guarded = ensureTransformPolicySystemMessage(prepared.payload.messages as unknown[]);
    const nextPayload: JsonObject = { ...prepared.payload, messages: guarded };
    return {
      model: prepared.model,
      payload: nextPayload,
      stream: prepared.stream,
      buildRequest: async (upstreamModelId) => ({
        headers: relayRequestHeaders(request),
        body: upstreamBody(nextPayload, upstreamModelId),
      }),
    };
  }

  // From here the request has raw media — validate transformer and run prepass.
  const transformer = await directModelRow(pool.transformerDiscoveredModelId);
  if (!transformer?.published || !transformer.Endpoint.published) {
    return transformerFailureResponse(
      "not_found",
      "Pool media transformer model is unavailable or unpublished.",
    );
  }

  const transformerCaps = effectiveDirectCapabilities(transformer);
  if (
    !supportsOperation({
      capabilities: transformerCaps,
      operation: {
        capability: "chat.completions",
        stream: false,
      },
    })
  ) {
    return transformerFailureResponse(
      "unsupported_capability",
      "Pool media transformer does not support chat completions.",
    );
  }

  const supported = transformerSupportedModalities(transformerCaps);
  const mismatch = transformerModalityMismatchErrors({
    pool: poolModalities,
    transformerCaps: supported,
  });
  if (mismatch.length > 0) {
    return transformerFailureResponse("unsupported_capability", mismatch.join(" "));
  }

  const modalities = effectiveTransformModalities({
    pool: poolModalities,
    transformerCaps: supported,
  });
  if (!anyTransformModalityEnabled(modalities)) {
    return transformerFailureResponse(
      "unsupported_capability",
      "Pool media transformer cannot handle the enabled media modalities.",
    );
  }

  // Re-check with effective modalities (pool ∩ transformer).
  if (!messagesHaveTransformableMedia(prepared.payload.messages, modalities)) {
    return prepared;
  }

  const jobs = collectMessageTransformJobs(prepared.payload.messages, modalities);
  if (jobs.length === 0) return prepared;

  const maxAssets = clampTransformerMaxAssets(pool.transformerMaxAssets);
  const hopTimeoutMs = clampTransformerTimeoutMs(pool.transformerTimeoutMs);
  if (jobs.length > MODEL_API_TRANSFORMER_MAX_JOBS) {
    return transformerFailureResponse(
      "request_too_large",
      `Too many messages with media to transform (max ${MODEL_API_TRANSFORMER_MAX_JOBS}).`,
    );
  }
  const assetCount = countAssetsInJobs(jobs);
  if (assetCount > maxAssets) {
    return transformerFailureResponse(
      "request_too_large",
      `Too many media attachments to transform (max ${maxAssets}).`,
    );
  }

  if (!isEndpointConnected(transformer, new Set(manager.getActiveCliDeviceIds()))) {
    return transformerFailureResponse(
      "disconnected",
      "Pool media transformer endpoint is disconnected.",
    );
  }

  const transformerVisibleId = directModelIdFromRow(transformer);
  const summarizedTools = pool.transformerIncludePrimaryTools
    ? summarizePrimaryTools(prepared.payload.tools, {
        maxTools: clampTransformerMaxTools(pool.transformerMaxTools),
        maxToolChars: clampTransformerMaxToolChars(pool.transformerMaxToolChars),
      })
    : [];
  const primaryToolsBlock = formatPrimaryToolsBlock(summarizedTools);
  const primaryToolsHash = summarizedTools.length > 0 ? hashPrimaryTools(summarizedTools) : null;
  const envelopesByMessageIndex = new Map<number, string>();
  const prepassStartedAt = Date.now();
  let totalDescriptionChars = 0;
  let cacheHits = 0;

  for (const job of jobs) {
    const remainingDeadlineMs =
      MODEL_API_TRANSFORMER_REQUEST_DEADLINE_MS - (Date.now() - prepassStartedAt);
    if (remainingDeadlineMs <= 0 || request.signal?.aborted) {
      return transformerFailureResponse(
        "timeout",
        "Pool media transformer prepass exceeded the request deadline.",
      );
    }

    const cacheKey = hashTransformMediaParts({
      // Scope by the *requesting* user so pool grantees do not share cache entries.
      ownerUserId: requester.userId,
      discoveredModelId: transformer.id,
      endpointId: transformer.Endpoint.id,
      upstreamModelId: transformer.upstreamModelId,
      mediaParts: job.mediaParts,
      systemPrompt: pool.transformerSystemPrompt,
      primaryToolsHash,
    });
    const canCache = shouldCacheTransformDescription({
      mode: pool.transformerCacheMode,
      mediaParts: job.mediaParts,
    });
    const cached = canCache ? getCachedTransformDescription(cacheKey) : null;
    if (cached !== null) {
      cacheHits += 1;
      totalDescriptionChars += cached.length;
      if (totalDescriptionChars > MODEL_API_TRANSFORMER_MAX_TOTAL_DESCRIPTION_CHARS) {
        return transformerFailureResponse(
          "request_too_large",
          "Pool media transformer total description size exceeded limit.",
        );
      }
      envelopesByMessageIndex.set(
        job.messageIndex,
        wrapTransformEnvelope({
          text: cached,
          transformerModelId: transformerVisibleId,
          assetCount: job.mediaParts.length,
        }),
      );
      continue;
    }

    let globalLease: ModelApiLimitLease | null = null;
    let cliLease: ModelApiLimitLease | null = null;
    try {
      globalLease = limiter.acquireGlobal({
        tokenId: requester.limitKey,
        userId: requester.userId,
      });
      try {
        cliLease = limiter.acquireCli(transformer.Endpoint.cliDeviceId);
      } catch (error) {
        globalLease.release();
        globalLease = null;
        if (error instanceof ModelApiLimitError) {
          return openAiFailureJsonResponse(error.failure);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ModelApiLimitError) {
        return openAiFailureJsonResponse(error.failure);
      }
      throw error;
    }

    const transformerPayload = buildTransformerChatPayload({
      upstreamModelId: transformer.upstreamModelId,
      mediaParts: job.mediaParts,
      systemPrompt: pool.transformerSystemPrompt,
      primaryToolsBlock,
    });
    const transformerBody = new TextEncoder().encode(JSON.stringify(transformerPayload));
    const callTimeoutMs = Math.min(hopTimeoutMs, remainingDeadlineMs);
    const hopStartedAt = new Date();
    let transformRelayRequestId: string;
    try {
      transformRelayRequestId = await createRelayMetadata({
        userId: requester.userId,
        modelApiTokenId: requester.modelApiTokenId,
        modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
        requestedDiscoveredModelId: transformer.id,
        requestedModelPoolId: poolId,
        operation: "chat.completions",
      });
    } catch (error) {
      cliLease.release();
      globalLease.release();
      throw error;
    }

    const attempt = startRelayAttempt({
      manager,
      cliDeviceId: transformer.Endpoint.cliDeviceId,
      endpointSlug: transformer.Endpoint.slug,
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: transformerRelayRequestHeaders(request),
      body: transformerBody,
      timeoutMs: callTimeoutMs,
      abortSignal: request.signal,
    });

    try {
      const started = await attempt.started;
      const rawText = await readResponseUtf8(started.body, {
        onOverflow: () => attempt.cancel("request_too_large"),
      });
      const terminal = await attempt.terminal;
      cliLease.release();
      globalLease.release();
      cliLease = null;
      globalLease = null;

      if (!terminal.ok || started.status >= 400) {
        await updateRelayMetadata(transformRelayRequestId, {
          selectedDiscoveredModelId: transformer.id,
          status: terminalStatus(terminal),
          startedAt: hopStartedAt,
          terminal,
          fallbackFailure: terminal.failure ?? "upstream_4xx",
          transformerErrorClass: terminal.failure ?? "upstream_4xx",
          transformerLatencyMs: Math.max(0, Date.now() - hopStartedAt.getTime()),
        }).catch(metadataUpdateError);
        return transformerFailureResponse(
          terminal.failure ?? "upstream_4xx",
          requester.exposeTransformDebug
            ? (transformerUpstreamErrorMessage(started.status, rawText) ??
                "Pool media transformer request failed.")
            : "Pool media transformer request failed.",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        await failRelayMetadata({
          relayRequestId: transformRelayRequestId,
          startedAt: hopStartedAt,
          failure: "protocol_error",
          selectedDiscoveredModelId: transformer.id,
          transformerErrorClass: "protocol_error",
          transformerLatencyMs: Math.max(0, Date.now() - hopStartedAt.getTime()),
        }).catch(metadataUpdateError);
        return transformerFailureResponse(
          "protocol_error",
          "Pool media transformer returned non-JSON.",
        );
      }
      const description = extractAssistantTextFromChatCompletion(parsed);
      if (!description?.trim()) {
        await failRelayMetadata({
          relayRequestId: transformRelayRequestId,
          startedAt: hopStartedAt,
          failure: "protocol_error",
          selectedDiscoveredModelId: transformer.id,
          transformerErrorClass: "protocol_error",
          transformerLatencyMs: Math.max(0, Date.now() - hopStartedAt.getTime()),
        }).catch(metadataUpdateError);
        return transformerFailureResponse(
          "protocol_error",
          "Pool media transformer returned an empty description.",
        );
      }

      totalDescriptionChars += description.length;
      if (totalDescriptionChars > MODEL_API_TRANSFORMER_MAX_TOTAL_DESCRIPTION_CHARS) {
        await failRelayMetadata({
          relayRequestId: transformRelayRequestId,
          startedAt: hopStartedAt,
          failure: "request_too_large",
          selectedDiscoveredModelId: transformer.id,
          transformerErrorClass: "request_too_large",
          transformerLatencyMs: Math.max(0, Date.now() - hopStartedAt.getTime()),
        }).catch(metadataUpdateError);
        return transformerFailureResponse(
          "request_too_large",
          "Pool media transformer total description size exceeded limit.",
        );
      }

      await updateRelayMetadata(transformRelayRequestId, {
        selectedDiscoveredModelId: transformer.id,
        status: "SUCCEEDED",
        startedAt: hopStartedAt,
        terminal: { ...terminal, ok: true, failure: null },
        transformerLatencyMs: Math.max(0, Date.now() - hopStartedAt.getTime()),
        transformerCacheHit: false,
      }).catch(metadataUpdateError);

      if (canCache) {
        setCachedTransformDescription(cacheKey, description);
      }
      envelopesByMessageIndex.set(
        job.messageIndex,
        wrapTransformEnvelope({
          text: description,
          transformerModelId: transformerVisibleId,
          assetCount: job.mediaParts.length,
        }),
      );
    } catch (error) {
      const terminal = await attempt.terminal.catch(() => null);
      cliLease?.release();
      globalLease?.release();
      const failure: RelayFailure =
        error instanceof TransformerResponseTooLargeError
          ? "request_too_large"
          : (terminal?.failure ?? "unknown");
      await failRelayMetadata({
        relayRequestId: transformRelayRequestId,
        startedAt: hopStartedAt,
        failure,
        selectedDiscoveredModelId: transformer.id,
        transformerErrorClass: failure,
        transformerLatencyMs: Math.max(0, Date.now() - hopStartedAt.getTime()),
      }).catch(metadataUpdateError);
      if (error instanceof TransformerResponseTooLargeError) {
        return transformerFailureResponse(
          "request_too_large",
          "Pool media transformer response exceeded size limit.",
        );
      }
      return transformerFailureResponse(
        terminal?.failure ?? "unknown",
        "Pool media transformer request failed.",
      );
    }
  }

  const nextMessages = rewriteMessagesWithPerMessageEnvelopes({
    messages: prepared.payload.messages as unknown[],
    modalities,
    envelopesByMessageIndex,
  });
  const nextPayload: JsonObject = {
    ...prepared.payload,
    messages: nextMessages,
  };
  const envelopeText = [...envelopesByMessageIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, envelope]) => envelope)
    .join("\n\n");
  return {
    model: prepared.model,
    payload: nextPayload,
    stream: prepared.stream,
    transformDebug: {
      modelId: transformerVisibleId,
      latencyMs: Math.max(0, Date.now() - prepassStartedAt),
      cacheHit: cacheHits === jobs.length && jobs.length > 0,
      includePrimaryTools: pool.transformerIncludePrimaryTools,
      toolCount: summarizedTools.length,
      envelope: envelopeText,
      error: null,
    },
    buildRequest: async (upstreamModelId) => ({
      headers: relayRequestHeaders(request),
      body: upstreamBody(nextPayload, upstreamModelId),
    }),
  };
}

function transformerUpstreamErrorMessage(status: number, rawText: string): string | null {
  const snippet = rawText.trim().slice(0, 400);
  if (!snippet) return `Upstream returned HTTP ${status}.`;
  try {
    const parsed: unknown = JSON.parse(snippet);
    if (
      isJsonObject(parsed) &&
      isJsonObject(parsed.error) &&
      typeof parsed.error.message === "string"
    ) {
      return `HTTP ${status}: ${parsed.error.message}`;
    }
  } catch {
    // fall through to raw snippet
  }
  return `HTTP ${status}: ${snippet}`;
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

function directModelIdFromRow(row: DirectModelRelayRow): string {
  // Best-effort label for the envelope; not used for routing.
  return `${row.Endpoint.slug}/${row.upstreamModelId}`;
}

async function relayPreparedModeledRequest({
  request,
  requester,
  targets,
  prepared,
  operation,
  manager,
  limiter,
  adaptationFeatureEnabled = false,
  capacityRuntime,
}: {
  request: Request;
  requester: RelayRequester;
  targets: {
    directModels: VisibleDirectModelTarget[];
    modelPools: VisibleModelPoolTarget[];
  };
  prepared: PreparedModeledRequest;
  operation: Omit<RelayOperation, "stream" | "buildRequest">;
  adaptationFeatureEnabled?: boolean;
  capacityRuntime?: CapacityAdmissionRuntime;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}) {
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
  const directTarget = directTargetByModelId(targets.directModels, prepared.model);
  if (directTarget) {
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

  const poolTarget = poolTargetByModelId(targets.modelPools, prepared.model);
  if (poolTarget) {
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
    const maybeTransformed = await maybeApplyPoolMediaTransformer({
      request,
      requester,
      poolId: poolTarget.id,
      prepared,
      operationFamily: operation.family,
      manager,
      limiter,
    });
    if (maybeTransformed instanceof Response) {
      await prepared.dispose?.();
      return maybeTransformed;
    }
    prepared = maybeTransformed;
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
        return operationFailureResponse(
          operation,
          request.signal.aborted ? "cancelled" : "unknown",
        );
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
              featureEnabled: adaptationFeatureEnabled,
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
    const response = await relayPool({
      request,
      requester,
      target: poolTarget,
      operation: relayOperation,
      manager,
      limiter,
      transformDebug: prepared.transformDebug,
      capacityRuntime,
    });
    if (requester.exposeTransformDebug && prepared.transformDebug) {
      return attachTransformDebug(response, prepared.transformDebug);
    }
    return response;
  }

  await prepared.dispose?.();
  return operationFailureResponse(operation, "not_found");
}

async function authenticatedModeledHandler({
  request,
  operation,
  prepare,
  manager,
  limiter,
  adaptationFeatureEnabled,
  capacityRuntime,
}: {
  request: Request;
  operation: Omit<RelayOperation, "stream" | "buildRequest">;
  prepare: (request: Request) => Promise<PreparedModeledRequest | Response>;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  adaptationFeatureEnabled?: boolean;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  const token = await authenticateRequest(request);
  if (!token)
    return openAiFailureJsonResponse("access_denied", "Missing or invalid model API token.");
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
    const targets = await listVisibleModelTargetsForToken(token);
    const response = await relayPreparedModeledRequest({
      request,
      requester,
      targets,
      prepared,
      operation,
      manager,
      limiter,
      adaptationFeatureEnabled,
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
  adaptationFeatureEnabled,
  capacityRuntime,
}: {
  request: Request;
  family: "chat.completions" | "completions";
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  adaptationFeatureEnabled?: boolean;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  return authenticatedModeledHandler({
    request,
    operation: {
      family,
      method: "POST",
      path: family === "chat.completions" ? "/v1/chat/completions" : "/v1/completions",
      capability: family,
    },
    prepare: prepareJsonModeledRequest,
    manager,
    limiter,
    adaptationFeatureEnabled,
    capacityRuntime,
  });
}

export async function chatTestCompletionsHandler({
  request,
  userId,
  manager,
  limiter,
}: {
  request: Request;
  userId: string;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}) {
  const prepared = await prepareJsonModeledRequest(request);
  if (prepared instanceof Response) return prepared;

  const requester = requesterFromChatTestUser(userId);
  const targets = await listVisibleModelTargetsForUser(userId);
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
  });
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

function responseIdParam(responseId: string | undefined): string | Response {
  if (typeof responseId !== "string" || responseId.trim().length === 0) {
    return openAiFailureJsonResponse("not_found", "Response ID is required.");
  }
  return responseId;
}

async function responsesCreateHandler({
  request,
  manager,
  limiter,
  capacityRuntime,
  adaptationFeatureEnabled,
}: {
  request: Request;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  adaptationFeatureEnabled?: boolean;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  const token = await authenticateRequest(request);
  if (!token)
    return openAiFailureJsonResponse("access_denied", "Missing or invalid model API token.");

  const prepared = await prepareJsonModeledRequest(request);
  if (prepared instanceof Response) return prepared;
  const requester = requesterFromToken(token);
  const targets = await listVisibleModelTargetsForToken(token);
  const previousId = previousResponseId(prepared.payload);
  const operation: Omit<RelayOperation, "stream" | "buildRequest"> = {
    family: "responses",
    method: "POST",
    path: "/v1/responses",
    capability: "responses.create",
    additionalCapabilities: previousId ? ["responses.statefulFollowUps"] : undefined,
    responseStickiness: { requester },
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
      adaptationFeatureEnabled,
      capacityRuntime,
    });
  }

  const stickyRoute = await resolveStickyRoute({ requester, responseId: previousId, targets });
  if (stickyRoute instanceof Response) return stickyRoute;
  if (
    (stickyRoute.target === "DIRECT_MODEL" &&
      prepared.model !== stickyRoute.visibleTarget.modelId) ||
    (stickyRoute.target === "MODEL_POOL" && prepared.model !== stickyRoute.visibleTarget.modelId)
  ) {
    return openAiFailureJsonResponse(
      "access_denied",
      "Response follow-up model does not match the original route.",
    );
  }

  return relaySelectedModelNoFailover({
    request,
    requester,
    selectedDiscoveredModelId: stickyRoute.selectedDiscoveredModelId,
    requestedDiscoveredModelId:
      stickyRoute.target === "DIRECT_MODEL" ? stickyRoute.visibleTarget.id : undefined,
    requestedModelPoolId:
      stickyRoute.target === "MODEL_POOL" ? stickyRoute.visibleTarget.id : undefined,
    operation: {
      ...operation,
      stream: prepared.stream,
      buildRequest: prepared.buildRequest,
      responseStickiness: {
        requester,
        targetDiscoveredModelId:
          stickyRoute.target === "DIRECT_MODEL" ? stickyRoute.visibleTarget.id : undefined,
        targetModelPoolId:
          stickyRoute.target === "MODEL_POOL" ? stickyRoute.visibleTarget.id : undefined,
      },
    },
    manager,
    limiter,
    capacityRuntime,
  });
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
  method: string;
  path: string;
  capability: ModelApiCapability;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  const token = await authenticateRequest(request);
  if (!token)
    return openAiFailureJsonResponse("access_denied", "Missing or invalid model API token.");

  const requester = requesterFromToken(token);
  const targets = await listVisibleModelTargetsForToken(token);
  const stickyRoute = await resolveStickyRoute({ requester, responseId, targets });
  if (stickyRoute instanceof Response) return stickyRoute;

  return relaySelectedModelNoFailover({
    request,
    requester,
    selectedDiscoveredModelId: stickyRoute.selectedDiscoveredModelId,
    requestedDiscoveredModelId:
      stickyRoute.target === "DIRECT_MODEL" ? stickyRoute.visibleTarget.id : undefined,
    requestedModelPoolId:
      stickyRoute.target === "MODEL_POOL" ? stickyRoute.visibleTarget.id : undefined,
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
    return anthropicErrorResponse(413, "Request body is too large.", "request_too_large");
  }
  let payload: JsonObject;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
    payload = parsed as JsonObject;
  } catch {
    return anthropicErrorResponse(400, "Request body must be a JSON object.");
  }
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

async function anthropicMessagesHandler({
  request,
  countTokens,
  manager,
  limiter,
  adaptationFeatureEnabled,
  capacityRuntime,
}: {
  request: Request;
  countTokens: boolean;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  adaptationFeatureEnabled?: boolean;
  capacityRuntime?: CapacityAdmissionRuntime;
}) {
  const token = await authenticateRequest(request);
  if (!token) {
    return anthropicErrorResponse(
      401,
      "Missing or invalid WSMP bearer token.",
      "authentication_error",
    );
  }
  const ingress = parseAnthropicIngress(request.headers);
  if (ingress instanceof Response) return ingress;
  const prepared = await prepareAnthropicModeledRequest(request, ingress);
  if (prepared instanceof Response) return prepared;
  if (countTokens) prepared.stream = false;
  const targets = await listVisibleModelTargetsForToken(token);
  const response = await relayPreparedModeledRequest({
    request,
    requester: requesterFromToken(token),
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
    adaptationFeatureEnabled,
    capacityRuntime,
  });
  // Native upstream success and error bytes are intentionally opaque here.
  // Reading or cloning the stream would violate streaming and backpressure.
  return response;
}

export function createModelApiRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  anthropicEnabled = env.MODEL_API_ANTHROPIC_ENABLED,
  protocolAdaptationEnabled = env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
  capacityEnabled = env.MODEL_API_GLOBAL_CAPACITY_ENABLED,
  capacityRuntime,
}: ModelApiRouteDependencies = {}) {
  const app = new Hono();
  const admissionRuntime = capacityEnabled
    ? (capacityRuntime ?? new StoreCapacityAdmissionRuntime(new PostgresCapacityAdmissionStore()))
    : undefined;

  app.get("/models", async (c) => {
    const token = await authenticateRequest(c.req.raw);
    if (!token) {
      return openAiFailureJsonResponse("access_denied", "Missing or invalid model API token.");
    }
    const targets = await listVisibleModelTargetsForToken(token);
    return c.json(await modelListResponse(targets));
  });

  app.post("/chat/completions", async (c) =>
    completionsHandler({
      request: c.req.raw,
      family: "chat.completions",
      manager,
      limiter: concurrencyLimiter,
      adaptationFeatureEnabled: protocolAdaptationEnabled,
      capacityRuntime: admissionRuntime,
    }),
  );

  app.post("/completions", async (c) =>
    completionsHandler({
      request: c.req.raw,
      family: "completions",
      manager,
      limiter: concurrencyLimiter,
      adaptationFeatureEnabled: protocolAdaptationEnabled,
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
      adaptationFeatureEnabled: protocolAdaptationEnabled,
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
      adaptationFeatureEnabled: protocolAdaptationEnabled,
      capacityRuntime: admissionRuntime,
    }),
  );

  if (anthropicEnabled) {
    app.post("/messages", async (c) =>
      anthropicMessagesHandler({
        request: c.req.raw,
        countTokens: false,
        manager,
        limiter: concurrencyLimiter,
        adaptationFeatureEnabled: protocolAdaptationEnabled,
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
  }

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
