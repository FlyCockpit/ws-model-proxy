import type {
  ModelApiTokenIdentity,
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";
import officialAnthropicFixture from "./fixtures/anthropic-2023-06-01.json";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// routes.ts now derives the responses-stickiness digest through
// @ws-model-proxy/db/forwarder-security, which reads env.BETTER_AUTH_SECRET.
// Mock the env module so the suite never runs real env validation.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!",
    MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 101 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_SPOOL_BYTES: 1024 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_CONCURRENT_UPLOADS: 4,
    MODEL_API_TRANSCRIPTION_MIN_FREE_BYTES: 0,
    MODEL_API_TRANSCRIPTION_UPLOAD_TIMEOUT_MS: 30_000,
    MODEL_API_ANTHROPIC_ENABLED: true,
  },
}));

vi.mock("@ws-model-proxy/api/lib/model-api-token-access", () => ({
  authenticateModelApiTokenSecret: vi.fn(),
  listVisibleModelTargetsForUser: vi.fn(),
  listVisibleModelTargetsForToken: vi.fn(),
}));

const { createModelApiRoutes } = await import("./routes.js");
const { MODEL_API_MAX_REQUEST_BODY_BYTES, ModelApiConcurrencyLimiter } = await import(
  "./limits.js"
);
const tokenAccess = await import("@ws-model-proxy/api/lib/model-api-token-access");
const { default: prisma } = await import("@ws-model-proxy/db");

const MODEL_API_MAX_ACTIVE_PER_TOKEN = 8;

function stringifyPersistenceCalls(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

const db = prisma as unknown as {
  executionTarget: { findUnique: MockInstance };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
  };
  poolMember: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
  };
  modelPool: {
    findUnique: MockInstance;
    findMany: MockInstance;
  };
  relayRequest: {
    create: MockInstance;
    update: MockInstance;
  };
  responseStickinessRecord: {
    findUnique: MockInstance;
    upsert: MockInstance;
  };
  appSetting: {
    findUnique: MockInstance;
  };
  mediaAsset: {
    findMany: MockInstance;
  };
};

const mockedTokenAccess = tokenAccess as unknown as {
  authenticateModelApiTokenSecret: MockInstance;
  listVisibleModelTargetsForUser: MockInstance;
  listVisibleModelTargetsForToken: MockInstance;
};

class FakeRelayManager {
  activeCliDeviceIds = ["cli-device-id"];
  sent: SendRelayRequestArgs[] = [];
  cancelled: CancelRelayRequestArgs[] = [];
  completed: string[] = [];
  handlers = new Map<string, ActiveRelayResponseHandlers>();

  getActiveCliDeviceIds() {
    return this.activeCliDeviceIds;
  }

  registerRelayResponseHandlers({
    requestId,
    handlers,
  }: {
    cliDeviceId: string;
    requestId: string;
    handlers: ActiveRelayResponseHandlers;
  }) {
    this.handlers.set(requestId, handlers);
  }

  sendRelayRequest(args: SendRelayRequestArgs) {
    this.sent.push(args);
    const byteLength =
      args.bodySource?.size ??
      args.bodyChunks?.reduce((total, chunk) => total + chunk.byteLength, 0) ??
      0;
    if (byteLength > 0) this.handlers.get(args.requestId)?.onRequestBodySent?.(byteLength);
  }

  cancelRelayRequest(args: CancelRelayRequestArgs) {
    this.cancelled.push(args);
    this.handlers.delete(args.requestId);
  }

  completeRelayRequest(requestId: string) {
    this.completed.push(requestId);
  }

  headers(requestId: string, status: number, headers: Record<string, string>) {
    this.handlers.get(requestId)?.onHeaders({
      type: "relay.response.headers",
      requestId,
      status,
      headers,
    });
  }

  body(requestId: string, text: string) {
    this.bodyBytes(requestId, new TextEncoder().encode(text));
  }

  bodyBytes(requestId: string, bytes: Uint8Array) {
    this.handlers.get(requestId)?.onBody(bytes, {
      type: "relay.response.body",
      requestId,
      chunkId: "0",
    });
  }

  complete(requestId: string) {
    const handler = this.handlers.get(requestId);
    this.handlers.delete(requestId);
    handler?.onComplete({
      type: "relay.complete",
      requestId,
      usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    });
  }
}

const token: ModelApiTokenIdentity = {
  id: "token-id",
  userId: "user-id",
  scopeMode: "ALL_VISIBLE",
  lookupPrefix: "wsmp_model_lookup",
  expiresAt: null,
  lastUsedAt: null,
};

const directTarget: VisibleDirectModelTarget = {
  target: "DIRECT_MODEL",
  id: "model-id",
  modelId: "owner/desktop/local/gpt-4o-mini",
  upstreamModelId: "gpt-4o-mini",
  ownerUserId: "user-id",
  ownerUserSlug: "owner",
  endpointId: "endpoint-id",
  endpointSlug: "local",
  cliDeviceSlug: "desktop",
  maxAttachmentBytes: null,
};

const poolTarget: VisibleModelPoolTarget = {
  target: "MODEL_POOL",
  id: "pool-id",
  modelId: "owner/gpt-4.1-mini",
  name: "GPT 4.1 Mini",
  description: null,
  ownerUserId: "user-id",
  ownerUserSlug: "owner",
  poolSlug: "gpt-4.1-mini",
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
};

function directRow({
  id = "model-id",
  upstreamModelId = "gpt-4o-mini",
  cliDeviceId = "cli-device-id",
  connected = true,
  completions = true,
  embeddings = true,
  audioTranscriptions = true,
  audioTranslations = true,
  audioSpeech = true,
  responses = true,
  capabilityOverrideMetadata = null,
  optimisticBasicTranscription = false,
}: {
  id?: string;
  upstreamModelId?: string;
  cliDeviceId?: string;
  connected?: boolean;
  completions?: boolean;
  embeddings?: boolean;
  audioTranscriptions?: boolean;
  audioTranslations?: boolean;
  audioSpeech?: boolean;
  responses?: boolean;
  capabilityOverrideMetadata?: Record<string, unknown> | null;
  optimisticBasicTranscription?: boolean;
} = {}) {
  return {
    id,
    published: true,
    userId: "user-id",
    upstreamModelId,
    capabilityOverrideMode: capabilityOverrideMetadata ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrideMetadata,
    optimisticBasicTranscription,
    Endpoint: {
      id: "endpoint-id",
      slug: "endpoint-default",
      published: true,
      cliDeviceId,
      status: "ONLINE",
      capabilityMetadata: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: true, streaming: true, vision: true },
        completions: { supported: completions, streaming: true },
        embeddings: { supported: embeddings },
        audio: {
          transcriptions: audioTranscriptions,
          translations: audioTranslations,
          speech: audioSpeech,
        },
        responses: {
          supported: responses,
          streaming: true,
          statefulFollowUps: true,
          retrieve: true,
          delete: true,
          cancel: true,
          listInputItems: true,
          countTokens: true,
          compact: true,
        },
      },
      CliDevice: { status: connected ? "CONNECTED" : "DISCONNECTED" },
    },
  };
}

function poolMemberRow({
  id,
  discoveredModelId,
  upstreamModelId,
  cliDeviceId,
  weight = 1,
  healthStatus = "HEALTHY",
  routingStatus = "ACTIVE",
  connected = true,
  capabilityOverrideMetadata = null,
}: {
  id: string;
  discoveredModelId: string;
  upstreamModelId: string;
  cliDeviceId: string;
  weight?: number;
  healthStatus?: "UNKNOWN" | "HEALTHY" | "HALF_OPEN" | "DEGRADED" | "UNHEALTHY";
  routingStatus?: "ACTIVE" | "DRAINING" | "DISABLED";
  connected?: boolean;
  capabilityOverrideMetadata?: Record<string, unknown> | null;
}) {
  return {
    id,
    poolId: "pool-id",
    discoveredModelId,
    weight,
    healthStatus,
    routingStatus,
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    halfOpenTrialStartedAt: null,
    DiscoveredModel: {
      id: discoveredModelId,
      published: true,
      userId: "user-id",
      upstreamModelId,
      capabilityOverrideMode: capabilityOverrideMetadata ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata,
      Endpoint: {
        id: `${id}-endpoint-id`,
        slug: `${id}-endpoint`,
        published: true,
        cliDeviceId,
        status: "ONLINE",
        capabilityMetadata: directRow().Endpoint.capabilityMetadata,
        CliDevice: { status: connected ? "CONNECTED" : "DISCONNECTED" },
      },
    },
  };
}

function appWith(manager: FakeRelayManager, anthropicEnabled = true) {
  return createModelApiRoutes({
    manager,
    concurrencyLimiter: new ModelApiConcurrencyLimiter(),
    anthropicEnabled,
  });
}

function requestBody(model = directTarget.modelId) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "secret prompt" }],
  });
}

function requireSent(manager: FakeRelayManager, index = 0): SendRelayRequestArgs {
  const sent = manager.sent[index];
  if (!sent) throw new Error("Expected relay request to be sent.");
  return sent;
}

function sentHeader(sent: SendRelayRequestArgs, name: string): string | undefined {
  if (sent.headers instanceof Headers) {
    return sent.headers.get(name) ?? undefined;
  }
  return sent.headers[name];
}

function firstBodyChunkText(sent: SendRelayRequestArgs): string {
  const chunk = sent.bodyChunks?.[0];
  if (!chunk) throw new Error("Expected relay body chunk.");
  return new TextDecoder().decode(chunk);
}

async function relayBodyText(sent: SendRelayRequestArgs): Promise<string> {
  if (sent.bodyChunks) {
    return new TextDecoder().decode(Buffer.concat(sent.bodyChunks));
  }
  if (!sent.bodySource) throw new Error("Expected relay body source.");
  const chunks: Uint8Array[] = [];
  for await (const chunk of sent.bodySource.open()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function completeJsonRelay({
  manager,
  requestId,
  body = { id: "ok" },
}: {
  manager: FakeRelayManager;
  requestId: string;
  body?: unknown;
}) {
  manager.headers(requestId, 200, { "content-type": "application/json" });
  manager.body(requestId, JSON.stringify(body));
  manager.complete(requestId);
}

describe("model API routes", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    mockedTokenAccess.authenticateModelApiTokenSecret.mockResolvedValue(token);
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [directTarget],
      modelPools: [poolTarget],
    });
    db.discoveredModel.findUnique.mockResolvedValue(directRow());
    db.executionTarget.findUnique.mockResolvedValue({ id: "execution-target-id" });
    db.modelPool.findMany.mockResolvedValue([]);
    db.modelPool.findUnique.mockResolvedValue({
      transformerDiscoveredModelId: null,
      transformerSystemPrompt: null,
      transformerImages: true,
      transformerAudio: false,
      transformerVideo: false,
      transformerCacheMode: "OFF",
      transformerIncludePrimaryTools: false,
      transformerMaxTools: 32,
      transformerMaxToolChars: 8000,
      transformerTimeoutMs: null,
      transformerMaxAssets: null,
    });
    db.relayRequest.create.mockResolvedValue({ id: "relay-request-id" });
    db.appSetting.findUnique.mockResolvedValue(null);
    db.relayRequest.update.mockResolvedValue({ id: "relay-request-id" });
    db.responseStickinessRecord.findUnique.mockResolvedValue(null);
    db.responseStickinessRecord.upsert.mockResolvedValue({ id: "stickiness-id" });
  });

  it("lists only model targets visible to the bearer token", async () => {
    db.discoveredModel.findMany.mockResolvedValue([
      {
        id: directTarget.id,
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrideMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: {
            supported: true,
            streaming: true,
            vision: true,
            video: true,
            audio: true,
          },
        },
        Endpoint: { capabilityMetadata: null },
      },
    ]);
    db.poolMember.findMany.mockResolvedValue([]);

    const manager = new FakeRelayManager();
    const response = await appWith(manager).request("/models", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: "list",
      data: [
        {
          id: directTarget.modelId,
          object: "model",
          created: 0,
          owned_by: "owner",
          supports_vision: true,
          supports_video_input: true,
          supports_audio_input: true,
          supports_audio_output: false,
          supports_audio_transcription: false,
          supports_audio_translation: false,
          capabilities: {
            vision: true,
            video_input: true,
            audio_input: true,
            audio_output: false,
            audio_transcription: false,
            audio_translation: false,
          },
          architecture: {
            input_modalities: ["text", "image", "audio", "video"],
            output_modalities: ["text"],
            modality: "text+image+audio+video->text",
          },
        },
        {
          id: poolTarget.modelId,
          object: "model",
          created: 0,
          owned_by: "owner",
          // Empty pool → text-only advertisement defaults.
          supports_vision: false,
          supports_video_input: false,
          supports_audio_input: false,
          supports_audio_output: false,
          supports_audio_transcription: false,
          supports_audio_translation: false,
          capabilities: {
            vision: false,
            video_input: false,
            audio_input: false,
            audio_output: false,
            audio_transcription: false,
            audio_translation: false,
          },
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
            modality: "text->text",
          },
        },
      ],
    });
    expect(mockedTokenAccess.authenticateModelApiTokenSecret).toHaveBeenCalledWith(
      "wsmp_model_test",
    );
  });

  it("falls back to endpoint capabilities when OVERRIDE metadata is unparseable", async () => {
    // Mirrors effectiveDirectCapabilities: OVERRIDE + bad override JSON still
    // advertises endpoint vision so /v1/models matches request-time routing.
    db.discoveredModel.findMany.mockResolvedValue([
      {
        id: directTarget.id,
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrideMetadata: { not: "a valid capabilities object" },
        Endpoint: {
          capabilityMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: true },
          },
        },
      },
    ]);
    db.poolMember.findMany.mockResolvedValue([]);

    const response = await appWith(new FakeRelayManager()).request("/models", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; supports_vision: boolean }>;
    };
    const direct = body.data.find((entry) => entry.id === directTarget.modelId);
    expect(direct?.supports_vision).toBe(true);
  });

  it("rejects missing or invalid bearer tokens with 401", async () => {
    mockedTokenAccess.authenticateModelApiTokenSecret.mockResolvedValue(null);

    const response = await appWith(new FakeRelayManager()).request("/models", {
      headers: { authorization: "Bearer invalid" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "authentication_error", code: "access_denied" },
    });
    expect(db.relayRequest.create).not.toHaveBeenCalled();
  });

  it("relays direct chat completion requests over the registered CLI websocket", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.path).toBe("/v1/chat/completions");
    expect(sentHeader(sent, "authorization")).toBeUndefined();
    expect(firstBodyChunkText(sent)).toContain('"model":"gpt-4o-mini"');

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "chatcmpl", choices: [] });
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SUCCEEDED",
            promptTokens: 3,
            completionTokens: 5,
            totalTokens: 8,
            errorClass: null,
          }),
        }),
      ),
    );
  });

  it("strips every inbound provider credential alias before endpoint authentication", async () => {
    const manager = new FakeRelayManager();
    const pending = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
        "x-api-key": "client-x-api-key",
        "api-key": "client-api-key",
        "openai-api-key": "client-openai-key",
        "anthropic-api-key": "client-anthropic-key",
      },
      body: requestBody(),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    for (const name of ["x-api-key", "api-key", "openai-api-key", "anthropic-api-key"]) {
      expect(sentHeader(sent, name)).toBeUndefined();
    }
    await completeJsonRelay({ manager, requestId: sent.requestId, body: { choices: [] } });
    expect((await pending).status).toBe(200);
  });

  it("routes v3 OpenAI Chat, Responses, and native-only Completions surfaces", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              stateful: true,
            },
            openaiCompletions: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
      }),
    );
    for (const [route, expectedPath, body] of [
      [
        "/chat/completions",
        "/v1/chat/completions",
        { messages: [{ role: "user", content: "hi" }] },
      ],
      ["/responses", "/v1/responses", { input: "hi" }],
      ["/completions", "/v1/completions", { prompt: "hi" }],
    ] as const) {
      const manager = new FakeRelayManager();
      const pending = appWith(manager).request(route, {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: JSON.stringify({ model: directTarget.modelId, ...body }),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      expect(sent.path).toBe(expectedPath);
      await completeJsonRelay({ manager, requestId: sent.requestId, body: { id: "native" } });
      expect((await pending).status).toBe(200);
    }
  });

  it("relays native Anthropic Messages with strict WSMP/upstream header isolation", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              countTokens: true,
              protocolVersion: "2023-06-01",
              betaFeatures: ["prompt-caching-2024-07-31"],
            },
          },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": " prompt-caching-2024-07-31 ",
        cookie: "must-not-forward=1",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        max_tokens: 32,
        messages: [{ role: "user", content: "secret prompt" }],
        unknown_native_field: { preserve: true },
        tools: [
          {
            name: "lookup",
            description: "native",
            input_schema: { type: "object", additionalProperties: true },
          },
        ],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("messages");
    expect(sent.path).toBe("/v1/messages");
    expect(sentHeader(sent, "authorization")).toBeUndefined();
    expect(sentHeader(sent, "x-api-key")).toBeUndefined();
    expect(sentHeader(sent, "cookie")).toBeUndefined();
    expect(sentHeader(sent, "anthropic-version")).toBe("2023-06-01");
    expect(sentHeader(sent, "anthropic-beta")).toBe("prompt-caching-2024-07-31");
    expect(JSON.parse(firstBodyChunkText(sent))).toMatchObject({
      model: "gpt-4o-mini",
      unknown_native_field: { preserve: true },
      tools: [{ name: "lookup", input_schema: { additionalProperties: true } }],
    });

    manager.headers(sent.requestId, 200, {
      "content-type": "application/json",
      "request-id": "req_anthropic",
    });
    const response = await responsePromise;
    const nativeBody = { id: "msg_123", type: "message", content: [] };
    manager.body(sent.requestId, JSON.stringify(nativeBody));
    manager.complete(sent.requestId);
    expect(response.headers.get("request-id")).toBe("req_anthropic");
    await expect(response.json()).resolves.toEqual(nativeBody);
  });

  it("gates Anthropic routes off explicitly", async () => {
    const response = await appWith(new FakeRelayManager(), false).request("/messages", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "anthropic-version": "2023-06-01" },
    });
    expect(response.status).toBe(404);
  });

  it("returns the official Anthropic request-too-large envelope for oversized bodies", async () => {
    const response = await appWith(new FakeRelayManager()).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": officialAnthropicFixture.protocolVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        padding: "x".repeat(MODEL_API_MAX_REQUEST_BODY_BYTES),
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "request_too_large", message: "Request body is too large." },
    });
    expect(db.relayRequest.create).not.toHaveBeenCalled();
  });

  it("relays Anthropic count_tokens with the official fixture shape", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              countTokens: true,
              protocolVersion: "2023-06-01",
            },
          },
        },
      }),
    );
    const countManager = new FakeRelayManager();
    const countPromise = appWith(countManager).request("/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        messages: officialAnthropicFixture.countTokensRequest.messages,
      }),
    });
    await vi.waitFor(() => expect(countManager.sent).toHaveLength(1));
    const countSent = requireSent(countManager);
    expect(countSent.path).toBe("/v1/messages/count_tokens");
    await completeJsonRelay({
      manager: countManager,
      requestId: countSent.requestId,
      body: officialAnthropicFixture.countTokensResponse,
    });
    await expect((await countPromise).json()).resolves.toEqual(
      officialAnthropicFixture.countTokensResponse,
    );

    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              countTokens: false,
              protocolVersion: "2023-06-01",
            },
          },
        },
      }),
    );
    const rejectedCount = await appWith(new FakeRelayManager()).request("/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });
    expect(rejectedCount.status).toBe(400);
    await expect(rejectedCount.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  it("uses Anthropic-shaped errors for authentication, version, and beta rejection", async () => {
    const app = appWith(new FakeRelayManager());
    const unauthenticated = await app.request("/messages", { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });

    const unsupportedVersion = await app.request("/messages", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "anthropic-version": "2099-01-01" },
    });
    expect(unsupportedVersion.status).toBe(400);
    await expect(unsupportedVersion.json()).resolves.toMatchObject({ type: "error" });

    const upstreamCredentialAttempt = await app.request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "x-api-key": "must-not-be-accepted",
      },
    });
    expect(upstreamCredentialAttempt.status).toBe(400);
    await expect(upstreamCredentialAttempt.json()).resolves.toMatchObject({ type: "error" });
  });

  it("does not fail over direct model requests after an upstream failure", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 500, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ error: { message: "upstream failed" } }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(500);
    await response.text();
    expect(manager.sent).toHaveLength(1);
    expect(manager.cancelled).toEqual([]);
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            selectedDiscoveredModelId: "model-id",
            status: "FAILED",
            errorClass: "upstream_5xx",
          }),
        }),
      ),
    );
  });

  it("preserves streaming SSE chunks without buffering the full answer first", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "secret prompt" }],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, 'data: {"choices":[]}\n\n');
    manager.body(sent.requestId, "data: [DONE]\n\n");
    manager.complete(sent.requestId);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toBe('data: {"choices":[]}\n\ndata: [DONE]\n\n');
  });

  it("returns not found for model IDs outside token visibility", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [],
    });

    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody("owner/private/model"),
    });

    expect(response.status).toBe(404);
    expect(db.relayRequest.create).not.toHaveBeenCalled();
  });

  it("fails oversized request bodies before metadata is created or body text is persisted", async () => {
    const oversizedBody = JSON.stringify({
      model: directTarget.modelId,
      input: "secret oversized body",
      padding: "x".repeat(MODEL_API_MAX_REQUEST_BODY_BYTES),
    });

    const response = await appWith(new FakeRelayManager()).request("/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: oversizedBody,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
    expect(db.relayRequest.create).not.toHaveBeenCalled();
    expect(JSON.stringify(db.relayRequest.update.mock.calls)).not.toContain(
      "secret oversized body",
    );
  });

  it("records concurrency limit failures with duration metadata and no request body text", async () => {
    const limiter = new ModelApiConcurrencyLimiter();
    const leases = Array.from({ length: MODEL_API_MAX_ACTIVE_PER_TOKEN }, () =>
      limiter.acquireGlobal({ tokenId: token.id, userId: token.userId }),
    );

    try {
      const response = await createModelApiRoutes({
        manager: new FakeRelayManager(),
        concurrencyLimiter: limiter,
      }).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(),
      });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "rate_limited" },
      });
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "FAILED",
            errorClass: "rate_limited",
            durationMs: expect.any(Number),
          }),
        }),
      );
      const metadataCalls = stringifyPersistenceCalls([
        db.relayRequest.create.mock.calls,
        db.relayRequest.update.mock.calls,
      ]);
      expect(metadataCalls).not.toContain("secret prompt");
    } finally {
      for (const lease of leases) lease.release();
    }
  });

  it("returns Anthropic's rate-limit envelope and status for local admission failures", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              countTokens: true,
              protocolVersion: "2023-06-01",
            },
          },
        },
      }),
    );
    const limiter = new ModelApiConcurrencyLimiter();
    const leases = Array.from({ length: MODEL_API_MAX_ACTIVE_PER_TOKEN }, () =>
      limiter.acquireGlobal({ tokenId: token.id, userId: token.userId }),
    );

    try {
      const response = await createModelApiRoutes({
        manager: new FakeRelayManager(),
        concurrencyLimiter: limiter,
      }).request("/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: directTarget.modelId, max_tokens: 8, messages: [] }),
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      await expect(response.json()).resolves.toEqual({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "The request could not be completed.",
        },
      });
    } finally {
      for (const lease of leases) lease.release();
    }
  });

  it("returns retryable 503 when the selected CLI is disconnected", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directRow({ connected: false }));

    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "disconnected" },
    });
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorClass: "disconnected",
        }),
      }),
    );
  });

  it("returns a clear OpenAI error when completions are unsupported", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directRow({ completions: false }));

    const response = await appWith(new FakeRelayManager()).request("/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, prompt: "secret prompt" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorClass: "unsupported_capability",
        }),
      }),
    );
  });

  it("does not persist prompt text or image payload bytes in relay metadata", async () => {
    const manager = new FakeRelayManager();
    const imageDataUrl = "data:image/png;base64,SECRET_IMAGE_BYTES";
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "secret prompt" },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);
    await response.text();

    expect(firstBodyChunkText(sent)).toContain(imageDataUrl);
    await vi.waitFor(() => expect(db.relayRequest.update).toHaveBeenCalled());
    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("secret prompt");
    expect(metadataCalls).not.toContain("SECRET_IMAGE_BYTES");
  });

  it("rejects an inline attachment above the selected model's limit before relaying", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [{ ...directTarget, maxAttachmentBytes: 3 }],
      modelPools: [],
    });
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } }],
          },
        ],
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
    expect(manager.sent).toHaveLength(0);
  });

  it("relays embeddings requests with the selected upstream model", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        input: "secret embedding input",
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("embeddings");
    expect(sent.path).toBe("/v1/embeddings");
    expect(firstBodyChunkText(sent)).toContain('"model":"gpt-4o-mini"');

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ object: "list", data: [] }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ object: "list", data: [] });
    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("secret embedding input");
  });

  it("uses per-model capability overrides instead of endpoint defaults across endpoint families", async () => {
    const overrideCapabilities = {
      version: 1,
      protocol: "openai-compatible",
      chatCompletions: { supported: true, streaming: true },
      completions: { supported: false, streaming: false },
      embeddings: { supported: true },
      audio: {
        transcriptions: false,
        translations: true,
        speech: true,
      },
      responses: {
        supported: true,
        streaming: true,
        statefulFollowUps: true,
        retrieve: true,
        delete: true,
        cancel: true,
        listInputItems: true,
        countTokens: true,
        compact: true,
      },
    };
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        completions: true,
        embeddings: false,
        audioTranslations: false,
        audioSpeech: false,
        responses: false,
        capabilityOverrideMetadata: overrideCapabilities,
      }),
    );

    const rejectedCompletion = await appWith(new FakeRelayManager()).request("/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, prompt: "secret prompt" }),
    });
    expect(rejectedCompletion.status).toBe(400);
    await expect(rejectedCompletion.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });

    const embeddingsManager = new FakeRelayManager();
    const embeddingsResponsePromise = appWith(embeddingsManager).request("/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, input: "secret embedding input" }),
    });
    await vi.waitFor(() => expect(embeddingsManager.sent).toHaveLength(1));
    await completeJsonRelay({
      manager: embeddingsManager,
      requestId: requireSent(embeddingsManager).requestId,
      body: { object: "list", data: [] },
    });
    await expect((await embeddingsResponsePromise).json()).resolves.toEqual({
      object: "list",
      data: [],
    });

    const translationBody = new FormData();
    translationBody.set("model", directTarget.modelId);
    translationBody.set("file", new Blob(["SECRET_AUDIO_BYTES"], { type: "audio/wav" }));
    const translationManager = new FakeRelayManager();
    const translationResponsePromise = appWith(translationManager).request("/audio/translations", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body: translationBody,
    });
    await vi.waitFor(() => expect(translationManager.sent).toHaveLength(1), { timeout: 5000 });
    expect(requireSent(translationManager).path).toBe("/v1/audio/translations");
    await completeJsonRelay({
      manager: translationManager,
      requestId: requireSent(translationManager).requestId,
      body: { text: "translation" },
    });
    await expect((await translationResponsePromise).json()).resolves.toEqual({
      text: "translation",
    });

    const speechManager = new FakeRelayManager();
    const speechResponsePromise = appWith(speechManager).request("/audio/speech", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        input: "secret speech input",
        voice: "alloy",
      }),
    });
    await vi.waitFor(() => expect(speechManager.sent).toHaveLength(1));
    expect(requireSent(speechManager).path).toBe("/v1/audio/speech");
    await completeJsonRelay({
      manager: speechManager,
      requestId: requireSent(speechManager).requestId,
      body: { ok: true },
    });
    expect((await speechResponsePromise).status).toBe(200);

    const responsesManager = new FakeRelayManager();
    const responsesResponsePromise = appWith(responsesManager).request("/responses/count_tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, input: "secret response input" }),
    });
    await vi.waitFor(() => expect(responsesManager.sent).toHaveLength(1));
    expect(requireSent(responsesManager).path).toBe("/v1/responses/count_tokens");
    await completeJsonRelay({
      manager: responsesManager,
      requestId: requireSent(responsesManager).requestId,
      body: { total_tokens: 9 },
    });
    await expect((await responsesResponsePromise).json()).resolves.toEqual({ total_tokens: 9 });

    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("secret embedding input");
    expect(metadataCalls).not.toContain("SECRET_AUDIO_BYTES");
    expect(metadataCalls).not.toContain("secret speech input");
    expect(metadataCalls).not.toContain("secret response input");
  });

  it("relays multipart audio transcription requests without persisting uploaded bytes", async () => {
    const manager = new FakeRelayManager();
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["SECRET_AUDIO_BYTES"], { type: "audio/wav" }), "input.wav");

    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1), { timeout: 5000 });
    const sent = requireSent(manager);
    expect(sent.family).toBe("audio");
    expect(sent.path).toBe("/v1/audio/transcriptions");
    expect(sentHeader(sent, "content-type")).toContain("multipart/form-data");
    const relayedBody = await relayBodyText(sent);
    expect(relayedBody).toContain("gpt-4o-mini");
    expect(relayedBody).not.toContain(directTarget.modelId);

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ text: "transcript" }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await response.text();
    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("SECRET_AUDIO_BYTES");
  });

  it.each([
    ["missing_model", (body: FormData) => body.delete("model")],
    ["duplicate_model", (body: FormData) => body.append("model", "second/model")],
    ["missing_file", (body: FormData) => body.delete("file")],
    ["duplicate_file", (body: FormData) => body.append("file", new Blob(["two"]), "two.wav")],
  ] as const)("rejects malformed transcription form data with %s", async (code, mutate) => {
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    mutate(body);
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(manager.sent).toEqual([]);
  });

  it("preserves transcription fields and passes successful SSE through without retrying", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 2,
          protocol: "openai-compatible",
          audio: {
            transcriptions: {
              supported: true,
              streaming: true,
              timestampGranularities: ["word", "segment"],
              diarization: true,
              languages: ["fr"],
              responseFormats: ["verbose_json"],
            },
          },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["SSE_AUDIO"], { type: "audio/wav" }), "input.wav");
    body.set("stream", "true");
    body.set("language", "fr");
    body.set("response_format", "verbose_json");
    body.append("timestamp_granularities[]", "word");
    body.set("diarization", "true");
    body.set("vendor_extension", "preserve-me");

    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1), { timeout: 5000 });
    const sent = requireSent(manager);
    const relayedBody = await relayBodyText(sent);
    expect(relayedBody).toContain('name="stream"\r\n\r\ntrue');
    expect(relayedBody).toContain('name="language"\r\n\r\nfr');
    expect(relayedBody).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(relayedBody).toContain('name="timestamp_granularities[]"\r\n\r\nword');
    expect(relayedBody).toContain('name="diarization"\r\n\r\ntrue');
    expect(relayedBody).toContain('name="vendor_extension"\r\n\r\npreserve-me');
    expect(relayedBody).toContain('name="model"\r\n\r\ngpt-4o-mini');
    expect(relayedBody).not.toContain(directTarget.modelId);

    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, 'event: transcript.text.delta\ndata: {"delta":"bon"}\n\n');
    manager.body(sent.requestId, "data: [DONE]\n\n");
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toBe(
      'event: transcript.text.delta\ndata: {"delta":"bon"}\n\ndata: [DONE]\n\n',
    );
    expect(manager.sent).toHaveLength(1);
    expect(manager.cancelled).toEqual([]);
  });

  it.each([
    [
      "json",
      "application/json",
      new Uint8Array([123, 34, 116, 101, 120, 116, 34, 58, 34, 120, 34, 125]),
    ],
    [
      "verbose_json",
      "application/json; charset=utf-8",
      new Uint8Array([123, 34, 119, 111, 114, 100, 115, 34, 58, 91, 93, 125]),
    ],
    ["text", "text/plain; charset=utf-8", new Uint8Array([104, 105, 10])],
    ["srt", "application/x-subrip", new Uint8Array([49, 10, 48, 48, 58, 48, 48])],
    ["vtt", "text/vtt", new Uint8Array([87, 69, 66, 86, 84, 84, 10])],
    ["diarized_json", "application/vnd.vendor.diarized+json", new Uint8Array([0, 255, 1, 128])],
  ] as const)(
    "passes %s transcription response content type and bytes through unchanged",
    async (responseFormat, contentType, output) => {
      db.discoveredModel.findUnique.mockResolvedValue(
        directRow({
          capabilityOverrideMetadata: {
            version: 2,
            protocol: "openai-compatible",
            audio: {
              transcriptions: {
                supported: true,
                diarization: responseFormat === "diarized_json",
                responseFormats: [responseFormat],
              },
            },
          },
        }),
      );
      const manager = new FakeRelayManager();
      const body = new FormData();
      body.set("model", directTarget.modelId);
      body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
      body.set("response_format", responseFormat);

      const responsePromise = appWith(manager).request("/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test" },
        body,
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      manager.headers(sent.requestId, 200, { "content-type": contentType, "x-upstream": "kept" });
      const response = await responsePromise;
      manager.bodyBytes(sent.requestId, output);
      manager.complete(sent.requestId);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("x-upstream")).toBeNull();
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(output);
      expect(manager.sent).toHaveLength(1);
    },
  );

  it("uses a persisted opt-in only for direct basic transcription with unknown support", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        optimisticBasicTranscription: true,
        capabilityOverrideMetadata: {
          version: 2,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, audio: false },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    await completeJsonRelay({
      manager,
      requestId: requireSent(manager).requestId,
      body: { text: "ok" },
    });
    expect((await responsePromise).status).toBe(200);

    const advanced = new FormData();
    advanced.set("model", directTarget.modelId);
    advanced.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    advanced.set("stream", "true");
    const denied = await appWith(new FakeRelayManager()).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body: advanced,
    });
    expect(denied.status).toBe(400);
  });

  it("enforces a direct model's attachment limit for transcription uploads", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [{ ...directTarget, maxAttachmentBytes: 3 }],
      modelPools: [],
    });
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
    expect(manager.sent).toHaveLength(0);
  });

  it("enforces a pool's attachment limit for transcription uploads", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, maxAttachmentBytes: 3 }],
    });
    const body = new FormData();
    body.set("model", poolTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
    expect(manager.sent).toHaveLength(0);
  });

  it("rejects audio endpoints when effective model capabilities do not allow them", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directRow({ audioTranscriptions: false }));
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");

    const response = await appWith(new FakeRelayManager()).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });
  });

  it("relays a one-member pool whose member is still UNKNOWN (the create default)", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
        healthStatus: "UNKNOWN",
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a"];
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.cliDeviceId).toBe("cli-a");
    expect(firstBodyChunkText(sent)).toContain('"model":"upstream-a"');

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "chatcmpl", choices: [] });
  });

  it("returns Anthropic-shaped pool compatibility failures", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-openai",
        discoveredModelId: "model-openai",
        upstreamModelId: "upstream-openai",
        cliDeviceId: "cli-openai",
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-openai"];
    const response = await appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: poolTarget.modelId, max_tokens: 8, messages: [] }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(manager.sent).toHaveLength(0);
  });

  it("fails over pool requests across every currently routable member before returning success", async () => {
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "upstream-b",
        cliDeviceId: "cli-b",
      }),
    ]);
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
    });

    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a", "cli-b"];
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const failed = requireSent(manager);
    expect(failed.cliDeviceId).toBe("cli-a");
    expect(firstBodyChunkText(failed)).toContain('"model":"upstream-a"');
    manager.headers(failed.requestId, 500, { "content-type": "application/json" });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    const retried = requireSent(manager, 1);
    expect(retried.cliDeviceId).toBe("cli-b");
    expect(firstBodyChunkText(retried)).toContain('"model":"upstream-b"');
    expect(retried.timeoutMs).toBeLessThan(failed.timeoutMs);
    expect(manager.cancelled).toContainEqual({
      cliDeviceId: "cli-a",
      requestId: failed.requestId,
      reason: "upstream_5xx",
    });
    expect(db.poolMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "member-a" } }),
    );

    manager.headers(retried.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(retried.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(retried.requestId);

    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            selectedDiscoveredModelId: "model-b",
            status: "SUCCEEDED",
          }),
        }),
      ),
    );
    const firstRequestBytes = Buffer.concat(failed.bodyChunks ?? []).byteLength;
    const secondRequestBytes = Buffer.concat(retried.bodyChunks ?? []).byteLength;
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestBytes: BigInt(firstRequestBytes + secondRequestBytes),
        }),
      }),
    );
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptCount: 2, responseBytes: expect.any(BigInt) }),
      }),
    );
    now.mockRestore();
  });

  it("replays a spooled transcription across compatible pool members and accounts both attempts", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "asr-a",
        cliDeviceId: "cli-a",
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "asr-b",
        cliDeviceId: "cli-b",
      }),
    ]);
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
    });
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a", "cli-b"];
    const form = new FormData();
    form.set("model", poolTarget.modelId);
    form.set("file", new Blob(["REPLAY_AUDIO_SENTINEL"], { type: "audio/wav" }), "voice.wav");

    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body: form,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const first = requireSent(manager);
    const firstBody = await relayBodyText(first);
    expect(firstBody).toContain("REPLAY_AUDIO_SENTINEL");
    expect(firstBody).toContain("asr-a");
    manager.headers(first.requestId, 500, { "content-type": "application/json" });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    const second = requireSent(manager, 1);
    const secondBody = await relayBodyText(second);
    expect(secondBody).toContain("REPLAY_AUDIO_SENTINEL");
    expect(secondBody).toContain("asr-b");
    expect(secondBody).not.toContain("asr-a");
    manager.headers(second.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(second.requestId, JSON.stringify({ text: "done" }));
    manager.complete(second.requestId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "done" });
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attemptCount: 2,
            requestBytes: BigInt((first.bodySource?.size ?? 0) + (second.bodySource?.size ?? 0)),
          }),
        }),
      ),
    );
  });

  it("returns a no-routable pool error when every member is skipped", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
        connected: false,
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "upstream-b",
        cliDeviceId: "cli-b",
        routingStatus: "DISABLED",
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = [];

    const response = await appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "disconnected" },
    });
    expect(manager.sent).toEqual([]);
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorClass: "disconnected",
        }),
      }),
    );
  });

  it("relays Responses API create streams and stores only sticky routing metadata", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        stream: true,
        input: "secret response prompt",
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.path).toBe("/v1/responses");
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, 'data: {"id":"resp_123","object":"response"}\n\n');
    manager.body(sent.requestId, "data: [DONE]\n\n");
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("resp_123");
    await vi.waitFor(() => expect(db.responseStickinessRecord.upsert).toHaveBeenCalled());
    const persistenceCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
      db.responseStickinessRecord.upsert.mock.calls,
    ]);
    expect(persistenceCalls).not.toContain("secret response prompt");
    expect(persistenceCalls).not.toContain("resp_123");
    expect(db.responseStickinessRecord.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: {
        userId: "user-id",
        modelApiTokenId: "token-id",
        targetDiscoveredModelId: "model-id",
        targetExecutionTargetId: "execution-target-id",
        selectedDiscoveredModelId: "model-id",
        selectedExecutionTargetId: "execution-target-id",
      },
    });
  });

  it("uses metadata-only sticky routing for Responses API follow-up requests", async () => {
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: null,
      targetModelPoolId: null,
      selectedDiscoveredModelId: null,
      TargetExecutionTarget: { discoveredModelId: "model-id" },
      SelectedExecutionTarget: { discoveredModelId: "model-id" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        previous_response_id: "resp_123",
        input: "follow-up prompt",
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.path).toBe("/v1/responses");
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "resp_456", object: "response" }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await response.text();
    const findCall = JSON.stringify(db.responseStickinessRecord.findUnique.mock.calls);
    expect(findCall).not.toContain("resp_123");
    expect(manager.sent).toHaveLength(1);
  });

  it("routes Responses retrieve through the sticky selected model with no request body", async () => {
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: "model-id",
      targetModelPoolId: null,
      selectedDiscoveredModelId: "model-id",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/responses/resp_123?include[]=output", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.method).toBe("GET");
    expect(sent.path).toBe("/v1/responses/resp_123?include[]=output");
    expect(sent.bodyChunks).toEqual([]);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "resp_123", object: "response" }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
  });

  describe("pool media transformer", () => {
    const transformerId = "transformer-model-id";
    const transformerUpstream = "vlm-upstream";

    function enablePoolTransformer(overrides: Record<string, unknown> = {}) {
      db.modelPool.findUnique.mockResolvedValue({
        transformerDiscoveredModelId: transformerId,
        transformerSystemPrompt: null,
        transformerImages: true,
        transformerAudio: false,
        transformerVideo: false,
        transformerCacheMode: "OFF",
        transformerIncludePrimaryTools: false,
        transformerMaxTools: 32,
        transformerMaxToolChars: 8000,
        transformerTimeoutMs: null,
        transformerMaxAssets: null,
        ...overrides,
      });
      db.discoveredModel.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
        if (args.where.id === transformerId) {
          const row = directRow();
          return {
            ...row,
            id: transformerId,
            upstreamModelId: transformerUpstream,
            Endpoint: {
              ...row.Endpoint,
              id: "transformer-endpoint-id",
              slug: "transformer-endpoint",
              cliDeviceId: "cli-transformer",
            },
          };
        }
        return {
          ...directRow(),
          id: args.where.id,
        };
      });
    }

    it("transforms media then forwards rewritten chat to the pool primary", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
              ],
            },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const transformReq = requireSent(manager, 0);
      expect(transformReq.cliDeviceId).toBe("cli-transformer");
      expect(transformReq.path).toBe("/v1/chat/completions");
      expect(firstBodyChunkText(transformReq)).toContain("data:image/png;base64,abc");
      expect(firstBodyChunkText(transformReq)).toContain(`"stream":false`);
      // Nested transform must not reuse client Idempotency-Key
      const transformHeaders =
        transformReq.headers instanceof Headers
          ? transformReq.headers
          : new Headers(transformReq.headers as Record<string, string>);
      expect(transformHeaders.get("idempotency-key")).toBeNull();

      manager.headers(transformReq.requestId, 200, { "content-type": "application/json" });
      manager.body(
        transformReq.requestId,
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "A red button labeled Save." } }],
        }),
      );
      manager.complete(transformReq.requestId);

      await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
      const primaryReq = requireSent(manager, 1);
      expect(primaryReq.cliDeviceId).toBe("cli-a");
      const primaryBody = firstBodyChunkText(primaryReq);
      expect(primaryBody).not.toContain("image_url");
      expect(primaryBody).toContain("wmp_media_transform");
      // Plain-text description for the primary model (not base64).
      expect(primaryBody).toContain("A red button labeled Save.");
      expect(primaryBody).toContain("untrusted perception");
      expect(primaryBody).toContain("wmp-media-transform-policy:v1");
      expect(primaryBody).not.toContain('encoding="base64"');

      manager.headers(primaryReq.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(primaryReq.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
      manager.complete(primaryReq.requestId);
      expect(response.status).toBe(200);
    });

    it("preserves multi-turn placement: each image stays on its originating message", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "first" },
                { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
              ],
            },
            { role: "assistant", content: "ok" },
            {
              role: "user",
              content: [
                { type: "text", text: "second" },
                { type: "image_url", image_url: { url: "data:image/png;base64,bbb" } },
              ],
            },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      manager.headers(requireSent(manager, 0).requestId, 200, {
        "content-type": "application/json",
      });
      manager.body(
        requireSent(manager, 0).requestId,
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "desc-first" } }],
        }),
      );
      manager.complete(requireSent(manager, 0).requestId);

      await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
      manager.headers(requireSent(manager, 1).requestId, 200, {
        "content-type": "application/json",
      });
      manager.body(
        requireSent(manager, 1).requestId,
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "desc-second" } }],
        }),
      );
      manager.complete(requireSent(manager, 1).requestId);

      await vi.waitFor(() => expect(manager.sent).toHaveLength(3));
      const primaryBody = JSON.parse(firstBodyChunkText(requireSent(manager, 2))) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMessages = primaryBody.messages.filter((m) => m.role === "user");
      expect(JSON.stringify(userMessages[0])).toContain("desc-first");
      expect(JSON.stringify(userMessages[0])).not.toContain("desc-second");
      expect(JSON.stringify(userMessages[1])).toContain("desc-second");
      expect(JSON.stringify(userMessages[1])).not.toContain("desc-first");
      expect(JSON.stringify(primaryBody)).not.toContain("image_url");

      manager.headers(requireSent(manager, 2).requestId, 200, {
        "content-type": "application/json",
      });
      const response = await responsePromise;
      manager.body(requireSent(manager, 2).requestId, "{}");
      manager.complete(requireSent(manager, 2).requestId);
      expect(response.status).toBe(200);
    });

    it("fails closed when the transformer errors", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }],
            },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const transformReq = requireSent(manager, 0);
      manager.headers(transformReq.requestId, 500, { "content-type": "application/json" });
      manager.body(transformReq.requestId, JSON.stringify({ error: "boom" }));
      manager.complete(transformReq.requestId);

      const response = await responsePromise;
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(manager.sent).toHaveLength(1);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.objectContaining({ message: expect.stringMatching(/transformer/i) }),
      });
    });

    it("advertises vision on pools only when transformer actually supports it", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      db.poolMember.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([
        {
          id: poolTarget.id,
          transformerDiscoveredModelId: transformerId,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
        },
      ]);
      db.discoveredModel.findMany.mockResolvedValue([
        {
          id: transformerId,
          published: true,
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: true },
          },
          Endpoint: { published: true, capabilityMetadata: null },
        },
      ]);

      const response = await appWith(new FakeRelayManager()).request("/models", {
        headers: { authorization: "Bearer wsmp_model_test" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{ id: string; supports_vision?: boolean }>;
      };
      const pool = body.data.find((row) => row.id === poolTarget.modelId);
      expect(pool?.supports_vision).toBe(true);

      // Text-only transformer + image toggle should not advertise vision
      db.discoveredModel.findMany.mockResolvedValue([
        {
          id: transformerId,
          published: true,
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: false },
          },
          Endpoint: { published: true, capabilityMetadata: null },
        },
      ]);
      const response2 = await appWith(new FakeRelayManager()).request("/models", {
        headers: { authorization: "Bearer wsmp_model_test" },
      });
      const body2 = (await response2.json()) as {
        data: Array<{ id: string; supports_vision?: boolean }>;
      };
      const pool2 = body2.data.find((row) => row.id === poolTarget.modelId);
      expect(pool2?.supports_vision).toBe(false);
    });

    it("does not advertise transformer modalities when the transformer is unpublished", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      db.poolMember.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([
        {
          id: poolTarget.id,
          transformerDiscoveredModelId: transformerId,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
        },
      ]);
      db.discoveredModel.findMany.mockResolvedValue([
        {
          id: transformerId,
          published: false,
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: true },
          },
          Endpoint: { published: true, capabilityMetadata: null },
        },
      ]);

      const response = await appWith(new FakeRelayManager()).request("/models", {
        headers: { authorization: "Bearer wsmp_model_test" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{ id: string; supports_vision?: boolean }>;
      };
      const pool = body.data.find((row) => row.id === poolTarget.modelId);
      expect(pool?.supports_vision).toBe(false);
    });

    it("does not fail text-only pool requests when the transformer is unpublished", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.discoveredModel.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
        if (args.where.id === transformerId) {
          const row = directRow();
          return {
            ...row,
            id: transformerId,
            published: false,
            upstreamModelId: transformerUpstream,
            Endpoint: {
              ...row.Endpoint,
              id: "transformer-endpoint-id",
              slug: "transformer-endpoint",
              cliDeviceId: "cli-transformer",
              published: true,
            },
          };
        }
        return { ...directRow(), id: args.where.id };
      });
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-a", "cli-transformer"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [{ role: "user", content: "plain text only, no media" }],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const primary = requireSent(manager, 0);
      expect(primary.cliDeviceId).toBe("cli-a");
      expect(firstBodyChunkText(primary)).toContain("plain text only");
      manager.headers(primary.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(primary.requestId, "{}");
      manager.complete(primary.requestId);
      expect(response.status).toBe(200);
    });

    it("skips retransform when history only has envelopes but still injects policy", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: `<wmp_media_transform model="x" assets="1">\nold desc\n</wmp_media_transform>`,
            },
            { role: "user", content: "follow up without new media" },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const primary = requireSent(manager, 0);
      expect(primary.cliDeviceId).toBe("cli-a");
      const body = firstBodyChunkText(primary);
      expect(body).toContain("old desc");
      expect(body).toContain("untrusted perception");
      expect(body).toContain("wmp-media-transform-policy:v1");
      expect(manager.sent).toHaveLength(1);
      manager.headers(primary.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(primary.requestId, "{}");
      manager.complete(primary.requestId);
      expect(response.status).toBe(200);
    });
  });
});
