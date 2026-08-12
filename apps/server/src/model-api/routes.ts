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
import { resolveEffectiveCapabilityMetadata } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import prisma from "@ws-model-proxy/db";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";
import { Hono } from "hono";
import { type OpenAiCompatibleCapabilities, type RelayFailure } from "../relay/protocol.js";
import { type RelaySessionManager, relaySessionManager } from "../relay/session-manager.js";
import {
  MODEL_API_MAX_REQUEST_BODY_BYTES,
  MODEL_API_RELAY_TIMEOUT_MS,
  ModelApiConcurrencyLimiter,
  ModelApiLimitError,
  type ModelApiLimitLease,
  modelApiConcurrencyLimiter,
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
  openAiErrorBody,
  openAiFailureJsonResponse,
  relayFailureHttpStatus,
} from "./openai-errors.js";
import { type RelayAttemptTerminal, startRelayAttempt } from "./relay-executor.js";

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
};

type JsonObject = Record<string, unknown>;

type ModelApiEndpointFamily =
  | "chat.completions"
  | "completions"
  | "embeddings"
  | "responses"
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
  | "responses.compact";

type BuiltRelayRequest = {
  headers: Headers;
  body: Uint8Array;
};

type RelayRequestBuilder = (upstreamModelId: string) => Promise<BuiltRelayRequest>;

type RelayOperation = {
  family: ModelApiEndpointFamily;
  method: string;
  path: string;
  capability: ModelApiCapability;
  additionalCapabilities?: ModelApiCapability[];
  stream: boolean;
  // Chat Test is an internal consumer that can accept a final SSE metrics event
  // derived from the relay's standardized RelayComplete metrics. Public
  // OpenAI-compatible routes retain the upstream byte stream unchanged.
  appendTerminalUsage?: boolean;
  buildRequest: RelayRequestBuilder;
  responseStickiness?: ResponseStickinessCapture;
};

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

type PreparedModeledRequest = {
  model: string;
  payload: JsonObject | null;
  stream: boolean;
  buildRequest: RelayRequestBuilder;
  transformDebug?: TransformDebug;
};

type ResponseStickinessCapture = {
  requester: RelayRequester;
  targetDiscoveredModelId?: string;
  targetModelPoolId?: string;
};

type ResponseStickinessRecordRow = {
  userId: string;
  modelApiTokenId: string | null;
  targetDiscoveredModelId: string | null;
  targetModelPoolId: string | null;
  selectedDiscoveredModelId: string | null;
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
};

type RelayRequester = {
  userId: string;
  limitKey: string;
  modelApiTokenId: string | null;
  modelApiTokenLookupPrefix: string | null;
  exposeTransformDebug?: boolean;
};

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

function relayRequestHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("content-length");
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("x-csrf-token");
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
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
}: {
  capabilities: OpenAiCompatibleCapabilities | null;
  capability: ModelApiCapability;
  stream: boolean;
}): boolean {
  if (capability === "chat.completions") {
    if (capabilities?.chatCompletions?.supported !== true) return false;
    if (stream && capabilities.chatCompletions.streaming === false) return false;
    return true;
  }

  if (capability === "completions") {
    if (capabilities?.completions?.supported !== true) return false;
    if (stream && capabilities.completions.streaming === false) return false;
    return true;
  }

  if (capability === "embeddings") {
    return capabilities?.embeddings?.supported === true;
  }

  if (capability === "audio.transcriptions") {
    return capabilities?.audio?.transcriptions === true;
  }

  if (capability === "audio.translations") {
    return capabilities?.audio?.translations === true;
  }

  if (capability === "audio.speech") {
    return capabilities?.audio?.speech === true;
  }

  if (capability === "responses.create") {
    if (capabilities?.responses?.supported !== true) return false;
    if (stream && capabilities.responses.streaming === false) return false;
    return true;
  }

  if (capability === "responses.statefulFollowUps") {
    return capabilities?.responses?.statefulFollowUps === true;
  }

  if (capability === "responses.retrieve") {
    return capabilities?.responses?.retrieve === true;
  }

  if (capability === "responses.delete") {
    return capabilities?.responses?.delete === true;
  }

  if (capability === "responses.cancel") {
    return capabilities?.responses?.cancel === true;
  }

  if (capability === "responses.listInputItems") {
    return capabilities?.responses?.listInputItems === true;
  }

  if (capability === "responses.countTokens") {
    return capabilities?.responses?.countTokens === true;
  }

  return capabilities?.responses?.compact === true;
}

function supportsOperation({
  capabilities,
  operation,
}: {
  capabilities: OpenAiCompatibleCapabilities | null;
  operation: Pick<RelayOperation, "capability" | "additionalCapabilities" | "stream">;
}): boolean {
  if (
    !supportsCapability({
      capabilities,
      capability: operation.capability,
      stream: operation.stream,
    })
  ) {
    return false;
  }

  return (operation.additionalCapabilities ?? []).every((capability) =>
    supportsCapability({ capabilities, capability, stream: operation.stream }),
  );
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

async function serializeFormDataForRelay({
  request,
  formData,
  upstreamModelId,
}: {
  request: Request;
  formData: FormData;
  upstreamModelId: string;
}): Promise<BuiltRelayRequest> {
  const nextFormData = new FormData();
  for (const [name, value] of formData.entries()) {
    if (name === "model") continue;
    nextFormData.append(name, value);
  }
  nextFormData.set("model", upstreamModelId);

  const serialized = new Request("http://model-api.local/body", {
    method: "POST",
    body: nextFormData,
  });
  const headers = relayRequestHeaders(request);
  const contentType = serialized.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  return {
    headers,
    body: new Uint8Array(await serialized.arrayBuffer()),
  };
}

async function prepareMultipartModeledRequest(
  request: Request,
): Promise<PreparedModeledRequest | Response> {
  const body = await readModelApiBody(request);
  if (body instanceof Response) return body;
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

  let formData: FormData;
  try {
    formData = await new Request("http://model-api.local/body", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();
  } catch {
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

  const model = formData.get("model");
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

  return {
    model,
    payload: null,
    stream: false,
    buildRequest: (upstreamModelId) =>
      serializeFormDataForRelay({ request, formData, upstreamModelId }),
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
      modelApiTokenId: input.modelApiTokenId ?? null,
      modelApiTokenLookupPrefix: input.modelApiTokenLookupPrefix ?? null,
      requestedDiscoveredModelId: input.requestedDiscoveredModelId ?? null,
      requestedModelPoolId: input.requestedModelPoolId ?? null,
      transformerLatencyMs: input.transformerLatencyMs ?? null,
      transformerCacheHit: input.transformerCacheHit ?? null,
      transformerErrorClass: input.transformerErrorClass ?? null,
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
  await prisma.relayRequest.update({
    where: { id: relayRequestId },
    data: {
      selectedDiscoveredModelId: update.selectedDiscoveredModelId ?? null,
      status: update.status,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - update.startedAt.getTime()),
      promptTokens: update.terminal.usage?.promptTokens ?? null,
      completionTokens: update.terminal.usage?.completionTokens ?? null,
      totalTokens: update.terminal.usage?.totalTokens ?? null,
      httpStatusCode:
        update.terminal.httpStatusCode ?? (failure ? relayFailureHttpStatus(failure) : null),
      upstreamStatusCode: update.terminal.upstreamStatusCode,
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
}: {
  relayRequestId: string;
  startedAt: Date;
  failure: RelayFailure;
  selectedDiscoveredModelId?: string;
  transformerErrorClass?: string | null;
  transformerLatencyMs?: number | null;
}) {
  await updateRelayMetadata(relayRequestId, {
    selectedDiscoveredModelId,
    status: failure === "cancelled" ? "CANCELED" : "FAILED",
    startedAt,
    fallbackFailure: failure,
    transformerErrorClass,
    transformerLatencyMs,
    terminal: {
      ok: false,
      failure,
      httpStatusCode: relayFailureHttpStatus(failure),
      upstreamStatusCode: null,
      usage: null,
      metrics: null,
    },
  });
}

function metadataUpdateError(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.warn(`[model-api] relay metadata update failed: ${message}`);
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
      targetDiscoveredModelId: targetDiscoveredModelId ?? null,
      targetModelPoolId: targetModelPoolId ?? null,
      selectedDiscoveredModelId,
      expiresAt,
    },
    update: {
      modelApiTokenId: requester.modelApiTokenId,
      targetDiscoveredModelId: targetDiscoveredModelId ?? null,
      targetModelPoolId: targetModelPoolId ?? null,
      selectedDiscoveredModelId,
      expiresAt,
    },
    select: { id: true },
  });
}

function stickinessWriteError(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.warn(`[model-api] responses stickiness write failed: ${message}`);
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
      modelApiTokenId: true,
      targetDiscoveredModelId: true,
      targetModelPoolId: true,
      selectedDiscoveredModelId: true,
      expiresAt: true,
    },
  })) as ResponseStickinessRecordRow | null;

  if (
    !record ||
    record.userId !== requester.userId ||
    record.modelApiTokenId !== requester.modelApiTokenId ||
    !record.selectedDiscoveredModelId ||
    (record.expiresAt !== null && record.expiresAt <= new Date())
  ) {
    return openAiFailureJsonResponse(
      "not_found",
      "Response routing metadata was not found or has expired.",
    );
  }

  if (record.targetDiscoveredModelId) {
    const visibleTarget =
      targets.directModels.find((target) => target.id === record.targetDiscoveredModelId) ?? null;
    if (!visibleTarget) {
      return openAiFailureJsonResponse(
        "access_denied",
        "Response routing metadata is no longer accessible.",
      );
    }
    return {
      target: "DIRECT_MODEL",
      visibleTarget,
      selectedDiscoveredModelId: record.selectedDiscoveredModelId,
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
      selectedDiscoveredModelId: record.selectedDiscoveredModelId,
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
  return (await prisma.poolMember.findMany({
    where: { poolId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      poolId: true,
      discoveredModelId: true,
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
  })) as PoolMemberRelayRow[];
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
          where: { poolId: { in: poolIds } },
          select: {
            poolId: true,
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
        const dm = row.DiscoveredModel;
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
}: {
  request: Request;
  requester: RelayRequester;
  target: VisibleDirectModelTarget;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    modelApiTokenId: requester.modelApiTokenId,
    modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
    requestedDiscoveredModelId: target.id,
  });
  const selected = await directModelRow(target.id);
  if (!selected) {
    await failRelayMetadata({ relayRequestId, startedAt, failure: "not_found" });
    return openAiFailureJsonResponse("not_found");
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
    return openAiFailureJsonResponse("unsupported_capability");
  }
  if (!isEndpointConnected(selected, new Set(manager.getActiveCliDeviceIds()))) {
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "disconnected",
      selectedDiscoveredModelId: selected.id,
    });
    return openAiFailureJsonResponse("disconnected");
  }

  let globalLease: ModelApiLimitLease;
  let cliLease: ModelApiLimitLease;
  try {
    globalLease = limiter.acquireGlobal({
      tokenId: requester.limitKey,
      userId: requester.userId,
    });
    cliLease = limiter.acquireCli(selected.Endpoint.cliDeviceId);
  } catch (error) {
    if (error instanceof ModelApiLimitError) {
      await failRelayMetadata({
        relayRequestId,
        startedAt,
        failure: error.failure,
        selectedDiscoveredModelId: selected.id,
      });
      return openAiFailureJsonResponse(error.failure);
    }
    throw error;
  }

  const builtRequest = await operation.buildRequest(selected.upstreamModelId);
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
    body: builtRequest.body,
    timeoutMs: MODEL_API_RELAY_TIMEOUT_MS,
    abortSignal: request.signal,
    onResponseBodyChunk: responseIdCapture
      ? (chunk) => responseIdCapture.push(chunk, operation.stream)
      : undefined,
  });

  try {
    const started = await attempt.started;
    const finalize = attempt.terminal
      .then(async (terminal) => {
        cliLease.release();
        globalLease.release();
        await updateRelayMetadata(relayRequestId, {
          selectedDiscoveredModelId: selected.id,
          status: terminalStatus(terminal),
          startedAt,
          terminal,
        });
        const responseId = responseIdCapture?.finish(operation.stream) ?? null;
        if (terminal.ok && responseId && operation.responseStickiness) {
          await writeResponseStickiness({
            ...operation.responseStickiness,
            responseId,
            targetDiscoveredModelId: target.id,
            selectedDiscoveredModelId: selected.id,
          }).catch(stickinessWriteError);
        }
      })
      .catch(metadataUpdateError);
    void finalize;
    return new Response(
      responseBodyForOperation({
        body: started.body,
        headers: started.headers,
        terminal: attempt.terminal,
        operation,
      }),
      { status: started.status, headers: started.headers },
    );
  } catch {
    const terminal = await attempt.terminal;
    cliLease.release();
    globalLease.release();
    await updateRelayMetadata(relayRequestId, {
      selectedDiscoveredModelId: selected.id,
      status: terminalStatus(terminal),
      startedAt,
      terminal,
    });
    return openAiFailureJsonResponse(terminal.failure ?? "unknown");
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
}: {
  request: Request;
  requester: RelayRequester;
  target: VisibleModelPoolTarget;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
  transformDebug?: TransformDebug;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    modelApiTokenId: requester.modelApiTokenId,
    modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
    requestedModelPoolId: target.id,
    transformerLatencyMs: transformDebug?.latencyMs ?? null,
    transformerCacheHit: transformDebug?.cacheHit ?? null,
    transformerErrorClass: transformDebug?.error ?? null,
  });

  let globalLease: ModelApiLimitLease;
  try {
    globalLease = limiter.acquireGlobal({
      tokenId: requester.limitKey,
      userId: requester.userId,
    });
  } catch (error) {
    if (error instanceof ModelApiLimitError) {
      await failRelayMetadata({ relayRequestId, startedAt, failure: error.failure });
      return openAiFailureJsonResponse(error.failure);
    }
    throw error;
  }

  const members = await poolMemberRows(target.id);
  const eligibleMembers = members.filter((member) =>
    supportsOperation({
      capabilities: effectivePoolMemberCapabilities(member),
      operation,
    }),
  );
  if (eligibleMembers.length === 0) {
    globalLease.release();
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "unsupported_capability",
    });
    return openAiFailureJsonResponse("unsupported_capability");
  }

  const routeSequence = buildPoolRouteSequence({
    members: eligibleMembers,
    activeCliDeviceIds: manager.getActiveCliDeviceIds(),
    now: new Date(),
  });
  if (!routeSequence.ok) {
    globalLease.release();
    await failRelayMetadata({ relayRequestId, startedAt, failure: "disconnected" });
    return openAiFailureJsonResponse("disconnected");
  }

  const memberById = new Map(eligibleMembers.map((member) => [member.id, member] as const));
  let finalFailure: RelayFailure = "unknown";

  for (const candidate of routeSequence.candidates) {
    const member = memberById.get(candidate.poolMemberId);
    if (!member) continue;

    let cliLease: ModelApiLimitLease;
    try {
      cliLease = limiter.acquireCli(candidate.cliDeviceId);
    } catch (error) {
      if (error instanceof ModelApiLimitError) {
        finalFailure = error.failure;
        continue;
      }
      throw error;
    }

    const builtRequest = await operation.buildRequest(candidate.upstreamModelId);
    if (candidate.healthStatus === "HALF_OPEN") {
      const claimed = await markPoolMemberHalfOpenTrial({
        poolMemberId: candidate.poolMemberId,
      });
      if (claimed === 0) {
        cliLease.release();
        continue;
      }
    }
    const responseIdCapture =
      operation.responseStickiness && operation.family === "responses"
        ? createResponseIdCapture()
        : null;
    const attempt = startRelayAttempt({
      manager,
      cliDeviceId: candidate.cliDeviceId,
      endpointSlug: member.DiscoveredModel.Endpoint.slug,
      family: operation.family,
      method: operation.method,
      path: operation.path,
      headers: builtRequest.headers,
      body: builtRequest.body,
      timeoutMs: MODEL_API_RELAY_TIMEOUT_MS,
      abortSignal: request.signal,
      onResponseBodyChunk: responseIdCapture
        ? (chunk) => responseIdCapture.push(chunk, operation.stream)
        : undefined,
    });

    try {
      const started = await attempt.started;
      if (started.status >= 500) {
        attempt.cancel("upstream_5xx");
        await attempt.terminal;
        cliLease.release();
        finalFailure = "upstream_5xx";
        await recordPoolMemberRelayFailure({
          poolMemberId: candidate.poolMemberId,
          failure: "upstream_5xx",
        });
        continue;
      }

      const finalize = attempt.terminal
        .then(async (terminal) => {
          cliLease.release();
          globalLease.release();
          if (terminal.ok) {
            await markPoolMemberRelaySuccess(candidate.poolMemberId);
          }
          await updateRelayMetadata(relayRequestId, {
            selectedDiscoveredModelId: member.discoveredModelId,
            status: terminalStatus(terminal),
            startedAt,
            terminal,
          });
          const responseId = responseIdCapture?.finish(operation.stream) ?? null;
          if (terminal.ok && responseId && operation.responseStickiness) {
            await writeResponseStickiness({
              ...operation.responseStickiness,
              responseId,
              targetModelPoolId: target.id,
              selectedDiscoveredModelId: member.discoveredModelId,
            }).catch(stickinessWriteError);
          }
        })
        .catch(metadataUpdateError);
      void finalize;
      return new Response(
        responseBodyForOperation({
          body: started.body,
          headers: started.headers,
          terminal: attempt.terminal,
          operation,
        }),
        { status: started.status, headers: started.headers },
      );
    } catch {
      const terminal = await attempt.terminal;
      cliLease.release();
      const failure = terminal.failure ?? "unknown";
      finalFailure = failure;
      if (isPoolRelayFailureClass(failure) && isRetryablePoolMemberRelayFailure(failure)) {
        await recordPoolMemberRelayFailure({
          poolMemberId: candidate.poolMemberId,
          failure,
        });
        continue;
      }
      globalLease.release();
      await updateRelayMetadata(relayRequestId, {
        selectedDiscoveredModelId: member.discoveredModelId,
        status: terminalStatus(terminal),
        startedAt,
        terminal,
      });
      return openAiFailureJsonResponse(failure);
    }
  }

  globalLease.release();
  await failRelayMetadata({ relayRequestId, startedAt, failure: finalFailure });
  return openAiFailureJsonResponse(finalFailure);
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
}: {
  request: Request;
  requester: RelayRequester;
  selectedDiscoveredModelId: string;
  requestedDiscoveredModelId?: string;
  requestedModelPoolId?: string;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    modelApiTokenId: requester.modelApiTokenId,
    modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
    requestedDiscoveredModelId,
    requestedModelPoolId,
  });
  const selected = await directModelRow(selectedDiscoveredModelId);
  if (!selected) {
    await failRelayMetadata({ relayRequestId, startedAt, failure: "not_found" });
    return openAiFailureJsonResponse("not_found");
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
    return openAiFailureJsonResponse("unsupported_capability");
  }

  if (!isEndpointConnected(selected, new Set(manager.getActiveCliDeviceIds()))) {
    await failRelayMetadata({
      relayRequestId,
      startedAt,
      failure: "disconnected",
      selectedDiscoveredModelId: selected.id,
    });
    return openAiFailureJsonResponse("disconnected");
  }

  let globalLease: ModelApiLimitLease;
  let cliLease: ModelApiLimitLease;
  try {
    globalLease = limiter.acquireGlobal({
      tokenId: requester.limitKey,
      userId: requester.userId,
    });
    cliLease = limiter.acquireCli(selected.Endpoint.cliDeviceId);
  } catch (error) {
    if (error instanceof ModelApiLimitError) {
      await failRelayMetadata({
        relayRequestId,
        startedAt,
        failure: error.failure,
        selectedDiscoveredModelId: selected.id,
      });
      return openAiFailureJsonResponse(error.failure);
    }
    throw error;
  }

  const builtRequest = await operation.buildRequest(selected.upstreamModelId);
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
    body: builtRequest.body,
    timeoutMs: MODEL_API_RELAY_TIMEOUT_MS,
    abortSignal: request.signal,
    onResponseBodyChunk: responseIdCapture
      ? (chunk) => responseIdCapture.push(chunk, operation.stream)
      : undefined,
  });

  try {
    const started = await attempt.started;
    const finalize = attempt.terminal
      .then(async (terminal) => {
        cliLease.release();
        globalLease.release();
        await updateRelayMetadata(relayRequestId, {
          selectedDiscoveredModelId: selected.id,
          status: terminalStatus(terminal),
          startedAt,
          terminal,
        });
        const responseId = responseIdCapture?.finish(operation.stream) ?? null;
        if (terminal.ok && responseId && operation.responseStickiness) {
          await writeResponseStickiness({
            ...operation.responseStickiness,
            responseId,
            selectedDiscoveredModelId: selected.id,
          }).catch(stickinessWriteError);
        }
      })
      .catch(metadataUpdateError);
    void finalize;
    return new Response(
      responseBodyForOperation({
        body: started.body,
        headers: started.headers,
        terminal: attempt.terminal,
        operation,
      }),
      { status: started.status, headers: started.headers },
    );
  } catch {
    const terminal = await attempt.terminal;
    cliLease.release();
    globalLease.release();
    await updateRelayMetadata(relayRequestId, {
      selectedDiscoveredModelId: selected.id,
      status: terminalStatus(terminal),
      startedAt,
      terminal,
    });
    return openAiFailureJsonResponse(terminal.failure ?? "unknown");
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
}: {
  request: Request;
  requester: RelayRequester;
  targets: {
    directModels: VisibleDirectModelTarget[];
    modelPools: VisibleModelPoolTarget[];
  };
  prepared: PreparedModeledRequest;
  operation: Omit<RelayOperation, "stream" | "buildRequest">;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}) {
  const directTarget = directTargetByModelId(targets.directModels, prepared.model);
  if (directTarget) {
    const relayOperation: RelayOperation = {
      ...operation,
      stream: prepared.stream,
      buildRequest: prepared.buildRequest,
    };
    return relayDirect({
      request,
      requester,
      target: directTarget,
      operation: relayOperation,
      manager,
      limiter,
    });
  }

  const poolTarget = poolTargetByModelId(targets.modelPools, prepared.model);
  if (poolTarget) {
    const maybeTransformed = await maybeApplyPoolMediaTransformer({
      request,
      requester,
      poolId: poolTarget.id,
      prepared,
      operationFamily: operation.family,
      manager,
      limiter,
    });
    if (maybeTransformed instanceof Response) return maybeTransformed;
    prepared = maybeTransformed;

    const relayOperation: RelayOperation = {
      ...operation,
      stream: prepared.stream,
      buildRequest: prepared.buildRequest,
    };
    const response = await relayPool({
      request,
      requester,
      target: poolTarget,
      operation: relayOperation,
      manager,
      limiter,
      transformDebug: prepared.transformDebug,
    });
    if (requester.exposeTransformDebug && prepared.transformDebug) {
      return attachTransformDebug(response, prepared.transformDebug);
    }
    return response;
  }

  return openAiFailureJsonResponse("not_found");
}

async function authenticatedModeledHandler({
  request,
  operation,
  prepare,
  manager,
  limiter,
}: {
  request: Request;
  operation: Omit<RelayOperation, "stream" | "buildRequest">;
  prepare: (request: Request) => Promise<PreparedModeledRequest | Response>;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}) {
  const token = await authenticateRequest(request);
  if (!token)
    return openAiFailureJsonResponse("access_denied", "Missing or invalid model API token.");
  const prepared = await prepare(request);
  if (prepared instanceof Response) return prepared;
  const requester = requesterFromToken(token);
  const targets = await listVisibleModelTargetsForToken(token);
  return relayPreparedModeledRequest({
    request,
    requester,
    targets,
    prepared,
    operation,
    manager,
    limiter,
  });
}

async function completionsHandler({
  request,
  family,
  manager,
  limiter,
}: {
  request: Request;
  family: "chat.completions" | "completions";
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
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
}: {
  request: Request;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
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
}: {
  request: Request;
  responseId: string;
  method: string;
  path: string;
  capability: ModelApiCapability;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
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
  });
}

export function createModelApiRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
}: ModelApiRouteDependencies = {}) {
  const app = new Hono();

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
    }),
  );

  app.post("/completions", async (c) =>
    completionsHandler({
      request: c.req.raw,
      family: "completions",
      manager,
      limiter: concurrencyLimiter,
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
    });
  });

  app.all("/*", () => openAiFailureJsonResponse("not_found"));

  return app;
}
