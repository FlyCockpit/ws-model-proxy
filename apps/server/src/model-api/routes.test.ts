import type {
  ModelApiTokenIdentity,
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// routes.ts now derives the responses-stickiness digest through
// @ws-model-proxy/db/forwarder-security, which reads env.BETTER_AUTH_SECRET.
// Mock the env module so the suite never runs real env validation.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!" },
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

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

const db = prisma as unknown as {
  discoveredModel: {
    findUnique: MockInstance;
  };
  poolMember: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
  };
  relayRequest: {
    create: MockInstance;
    update: MockInstance;
  };
  responseStickinessRecord: {
    findUnique: MockInstance;
    upsert: MockInstance;
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
    this.handlers.get(requestId)?.onBody(new TextEncoder().encode(text), {
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
} = {}) {
  return {
    id,
    userId: "user-id",
    upstreamModelId,
    capabilityOverrideMode: capabilityOverrideMetadata ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrideMetadata,
    Endpoint: {
      id: "endpoint-id",
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
      userId: "user-id",
      upstreamModelId,
      capabilityOverrideMode: capabilityOverrideMetadata ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata,
      Endpoint: {
        id: `${id}-endpoint-id`,
        cliDeviceId,
        status: "ONLINE",
        capabilityMetadata: directRow().Endpoint.capabilityMetadata,
        CliDevice: { status: connected ? "CONNECTED" : "DISCONNECTED" },
      },
    },
  };
}

function appWith(manager: FakeRelayManager) {
  return createModelApiRoutes({
    manager,
    concurrencyLimiter: new ModelApiConcurrencyLimiter(),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTokenAccess.authenticateModelApiTokenSecret.mockResolvedValue(token);
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [directTarget],
      modelPools: [poolTarget],
    });
    db.discoveredModel.findUnique.mockResolvedValue(directRow());
    db.relayRequest.create.mockResolvedValue({ id: "relay-request-id" });
    db.relayRequest.update.mockResolvedValue({ id: "relay-request-id" });
    db.responseStickinessRecord.findUnique.mockResolvedValue(null);
    db.responseStickinessRecord.upsert.mockResolvedValue({ id: "stickiness-id" });
  });

  it("lists only model targets visible to the bearer token", async () => {
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
        },
        {
          id: poolTarget.modelId,
          object: "model",
          created: 0,
          owned_by: "owner",
        },
      ],
    });
    expect(mockedTokenAccess.authenticateModelApiTokenSecret).toHaveBeenCalledWith(
      "wsmp_model_test",
    );
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

    expect(response.status).toBe(429);
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
      const metadataCalls = JSON.stringify([
        db.relayRequest.create.mock.calls,
        db.relayRequest.update.mock.calls,
      ]);
      expect(metadataCalls).not.toContain("secret prompt");
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
    const metadataCalls = JSON.stringify([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("secret prompt");
    expect(metadataCalls).not.toContain("SECRET_IMAGE_BYTES");
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
    const metadataCalls = JSON.stringify([
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
    await vi.waitFor(() => expect(translationManager.sent).toHaveLength(1));
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

    const metadataCalls = JSON.stringify([
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

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("audio");
    expect(sent.path).toBe("/v1/audio/transcriptions");
    expect(sentHeader(sent, "content-type")).toContain("multipart/form-data");
    const relayedBody = firstBodyChunkText(sent);
    expect(relayedBody).toContain("gpt-4o-mini");
    expect(relayedBody).not.toContain(directTarget.modelId);

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ text: "transcript" }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await response.text();
    const metadataCalls = JSON.stringify([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("SECRET_AUDIO_BYTES");
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

  it("fails over pool requests across every currently routable member before returning success", async () => {
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
    const persistenceCalls = JSON.stringify([
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
        selectedDiscoveredModelId: "model-id",
      },
    });
  });

  it("uses metadata-only sticky routing for Responses API follow-up requests", async () => {
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: "model-id",
      targetModelPoolId: null,
      selectedDiscoveredModelId: "model-id",
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
});
