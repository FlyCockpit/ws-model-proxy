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
  isRetryablePoolMemberRelayFailure,
  markPoolMemberRelaySuccess,
  type PoolMemberRouteRow,
  type RelayFailureClass,
  recordPoolMemberRelayFailure,
  relayFailureClasses,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import prisma from "@ws-model-proxy/db";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";
import { Hono } from "hono";
import {
  type OpenAiCompatibleCapabilities,
  openAiCompatibleCapabilitiesSchema,
  type RelayFailure,
} from "../relay/protocol.js";
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
  buildRequest: RelayRequestBuilder;
  responseStickiness?: ResponseStickinessCapture;
};

type PreparedModeledRequest = {
  model: string;
  payload: JsonObject | null;
  stream: boolean;
  buildRequest: RelayRequestBuilder;
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
  userId: string;
  upstreamModelId: string;
  capabilityOverrideMode: string;
  capabilityOverrideMetadata: unknown | null;
  Endpoint: {
    id: string;
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
};

type RelayMetadataUpdate = {
  selectedDiscoveredModelId?: string;
  status: "SUCCEEDED" | "FAILED" | "CANCELED";
  startedAt: Date;
  terminal: RelayAttemptTerminal;
  fallbackFailure?: RelayFailure;
};

type RelayRequester = {
  userId: string;
  limitKey: string;
  modelApiTokenId: string | null;
  modelApiTokenLookupPrefix: string | null;
};

const poolRelayFailureClassSet: ReadonlySet<string> = new Set(relayFailureClasses);
const RESPONSES_STICKINESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESPONSE_ID_CAPTURE_MAX_CHARS = 1024 * 1024;

function isPoolRelayFailureClass(failure: RelayFailure): failure is RelayFailureClass {
  return poolRelayFailureClassSet.has(failure);
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

function parseCapabilities(value: unknown): OpenAiCompatibleCapabilities | null {
  const parsed = openAiCompatibleCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function effectiveDirectCapabilities(
  row: DirectModelRelayRow,
): OpenAiCompatibleCapabilities | null {
  const modelMetadata =
    row.capabilityOverrideMode === "OVERRIDE"
      ? parseCapabilities(row.capabilityOverrideMetadata)
      : null;
  if (modelMetadata) return modelMetadata;
  return parseCapabilities(row.Endpoint.capabilityMetadata);
}

function effectivePoolMemberCapabilities(
  row: PoolMemberRelayRow,
): OpenAiCompatibleCapabilities | null {
  const modelMetadata =
    row.DiscoveredModel.capabilityOverrideMode === "OVERRIDE"
      ? parseCapabilities(row.DiscoveredModel.capabilityOverrideMetadata)
      : null;
  if (modelMetadata) return modelMetadata;
  return parseCapabilities(row.DiscoveredModel.Endpoint.capabilityMetadata);
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
  return (
    row.Endpoint.status !== "OFFLINE" &&
    row.Endpoint.CliDevice?.status === "CONNECTED" &&
    activeCliDeviceIds.has(row.Endpoint.cliDeviceId)
  );
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
}: {
  relayRequestId: string;
  startedAt: Date;
  failure: RelayFailure;
  selectedDiscoveredModelId?: string;
}) {
  await updateRelayMetadata(relayRequestId, {
    selectedDiscoveredModelId,
    status: failure === "cancelled" ? "CANCELED" : "FAILED",
    startedAt,
    fallbackFailure: failure,
    terminal: {
      ok: false,
      failure,
      httpStatusCode: relayFailureHttpStatus(failure),
      upstreamStatusCode: null,
      usage: null,
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
      userId: true,
      upstreamModelId: true,
      capabilityOverrideMode: true,
      capabilityOverrideMetadata: true,
      Endpoint: {
        select: {
          id: true,
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
          upstreamModelId: true,
          capabilityOverrideMode: true,
          capabilityOverrideMetadata: true,
          Endpoint: {
            select: {
              id: true,
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

function modelListResponse(targets: {
  directModels: VisibleDirectModelTarget[];
  modelPools: VisibleModelPoolTarget[];
}) {
  return {
    object: "list",
    data: [
      ...targets.directModels.map((model) => ({
        id: model.modelId,
        object: "model",
        created: 0,
        owned_by: model.ownerUserSlug,
      })),
      ...targets.modelPools.map((pool) => ({
        id: pool.modelId,
        object: "model",
        created: 0,
        owned_by: pool.ownerUserSlug,
      })),
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
    return new Response(started.body, { status: started.status, headers: started.headers });
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
}: {
  request: Request;
  requester: RelayRequester;
  target: VisibleModelPoolTarget;
  operation: RelayOperation;
  manager: NonNullable<ModelApiRouteDependencies["manager"]>;
  limiter: ModelApiConcurrencyLimiter;
}): Promise<Response> {
  const startedAt = new Date();
  const relayRequestId = await createRelayMetadata({
    userId: requester.userId,
    modelApiTokenId: requester.modelApiTokenId,
    modelApiTokenLookupPrefix: requester.modelApiTokenLookupPrefix,
    requestedModelPoolId: target.id,
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
    const responseIdCapture =
      operation.responseStickiness && operation.family === "responses"
        ? createResponseIdCapture()
        : null;
    const attempt = startRelayAttempt({
      manager,
      cliDeviceId: candidate.cliDeviceId,
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
      return new Response(started.body, { status: started.status, headers: started.headers });
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
    return new Response(started.body, { status: started.status, headers: started.headers });
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
  const relayOperation: RelayOperation = {
    ...operation,
    stream: prepared.stream,
    buildRequest: prepared.buildRequest,
  };
  const directTarget = directTargetByModelId(targets.directModels, prepared.model);
  if (directTarget) {
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
    return relayPool({
      request,
      requester,
      target: poolTarget,
      operation: relayOperation,
      manager,
      limiter,
    });
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
    return c.json(modelListResponse(targets));
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
