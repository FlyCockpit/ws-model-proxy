import type {
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// chat-test.ts imports the shared completions handler from routes.ts, which
// derives the stickiness digest via @ws-model-proxy/db/forwarder-security
// (reads env.BETTER_AUTH_SECRET). Mock env so no real validation runs.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!" },
}));

vi.mock("@ws-model-proxy/api/lib/model-api-token-access", () => ({
  authenticateModelApiTokenSecret: vi.fn(),
  listVisibleModelTargetsForUser: vi.fn(),
  listVisibleModelTargetsForToken: vi.fn(),
}));

const { createChatTestRoutes } = await import("./chat-test.js");
const { ModelApiConcurrencyLimiter } = await import("./limits.js");
const tokenAccess = await import("@ws-model-proxy/api/lib/model-api-token-access");
const { default: prisma } = await import("@ws-model-proxy/db");

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

const mockedTokenAccess = tokenAccess as unknown as {
  listVisibleModelTargetsForUser: MockInstance;
};

const db = prisma as unknown as {
  discoveredModel: {
    findUnique: MockInstance;
  };
  poolMember: {
    findMany: MockInstance;
  };
  modelPool: {
    findFirst: MockInstance;
  };
  relayRequest: {
    create: MockInstance;
    update: MockInstance;
  };
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
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
  }

  completeWithoutUsage(requestId: string) {
    const handler = this.handlers.get(requestId);
    this.handlers.delete(requestId);
    handler?.onComplete({ type: "relay.complete", requestId });
  }

  completeWithStandardizedMetrics(requestId: string) {
    const handler = this.handlers.get(requestId);
    this.handlers.delete(requestId);
    handler?.onComplete({
      type: "relay.complete",
      requestId,
      usage: { completionTokens: 3 },
      metrics: { completionTokens: 2, tokenizer: "cl100k_base" },
    });
  }
}

const directTarget: VisibleDirectModelTarget = {
  target: "DIRECT_MODEL",
  id: "model-id",
  modelId: "owner/desk/local/gpt-4o-mini",
  upstreamModelId: "gpt-4o-mini",
  ownerUserId: "user-id",
  ownerUserSlug: "owner",
  endpointId: "endpoint-id",
  endpointSlug: "local",
  cliDeviceSlug: "desk",
  maxAttachmentBytes: null,
};

const poolTarget: VisibleModelPoolTarget = {
  target: "MODEL_POOL",
  id: "pool-id",
  modelId: "owner/general",
  name: "General",
  description: null,
  ownerUserId: "user-id",
  ownerUserSlug: "owner",
  accessGrantId: null,
  poolSlug: "general",
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
  protocolAdaptationEnabled: false,
  publicEgressEnabled: false,
  publicEgressAcknowledged: false,
  effectiveProviderEgress: false,
  providerPrimaryMemberCount: 0,
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
};

const session = {
  user: {
    id: "user-id",
    email: "user@example.com",
    name: "User",
    emailVerified: true,
    role: "user",
    twoFactorEnabled: false,
    image: null,
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
  session: {
    id: "session-id",
    userId: "user-id",
    token: "session-token",
    expiresAt: new Date("2026-01-02"),
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
} as Session;

function directRow() {
  return {
    id: "model-id",
    published: true,
    userId: "user-id",
    upstreamModelId: "gpt-4o-mini",
    capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrideMetadata: null,
    Endpoint: {
      id: "endpoint-id",
      slug: "local",
      published: true,
      cliDeviceId: "cli-device-id",
      status: "ONLINE",
      capabilityMetadata: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: true, streaming: true },
      },
      CliDevice: { status: "CONNECTED" },
    },
  };
}

function poolMemberRow(native: "chat" | "responses" = "responses") {
  return {
    id: "member-id",
    poolId: "pool-id",
    discoveredModelId: "model-id",
    weight: 1,
    healthStatus: "HEALTHY",
    routingStatus: "ACTIVE",
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    halfOpenTrialStartedAt: null,
    capacityContextCeiling: null,
    capacityContextMargin: 0,
    capacityWaitBudgetMode: "INHERIT",
    capacityWaitBudgetMs: null,
    ModelPool: {
      capacityWaitBudgetMs: 30_000,
      affinityEnabled: false,
      affinityTtlSeconds: 3600,
      affinityMaxRecords: 10_000,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
    },
    ExecutionTarget: {
      id: "member-target",
      inferenceCapacityId: null,
      InferenceCapacity: null,
      DiscoveredModel: null,
    },
    DiscoveredModel: {
      ...directRow(),
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: native === "chat", streaming: true },
        responses: { supported: native === "responses", streaming: true },
      },
    },
  };
}

function publicOverflowPoolRow() {
  return {
    publicEgressEnabled: true,
    publicEgressAcknowledged: true,
    PoolMembers: [
      {
        id: "provider-member-id",
        publicOrder: 0,
        ExecutionTarget: {
          id: "provider-target-id",
          ProviderModel: {
            id: "provider-model-id",
            userId: "user-id",
            upstreamModelId: "provider-chat",
            contextWindow: 128_000,
            maxOutputTokens: 4_096,
            nativeCapabilities: {
              protocols: ["openai"],
              surfaces: ["openai-chat"],
              streaming: true,
              features: [],
            },
            healthStatus: "HEALTHY",
            healthNextRetryAt: null,
            enabled: true,
            deletedAt: null,
            ProviderAccount: {
              id: "provider-account-id",
              userId: "user-id",
              providerType: "openai",
              providerVersion: null,
              baseUrl: "https://provider.invalid",
              authType: "BEARER",
              healthStatus: "HEALTHY",
              healthNextRetryAt: null,
              enabled: true,
              deletedAt: null,
              CurrentCredential: {
                id: "credential-id",
                credentialType: "BEARER",
                aadVersion: 1,
                algorithm: "AES-256-GCM",
                keyVersion: "v1",
                ciphertext: new Uint8Array(),
                nonce: new Uint8Array(),
                authTag: new Uint8Array(),
                status: "ACTIVE",
              },
            },
          },
        },
      },
    ],
  };
}

function appWith(manager: FakeRelayManager, authSession: Session | null = session) {
  const app = new Hono<{ Variables: { session: Session | null } }>();
  app.use("*", async (c, next) => {
    c.set("session", authSession);
    await next();
  });
  app.route(
    "/",
    createChatTestRoutes({
      manager,
      concurrencyLimiter: new ModelApiConcurrencyLimiter(),
    }),
  );
  return app;
}

function requireSent(manager: FakeRelayManager): SendRelayRequestArgs {
  const sent = manager.sent[0];
  if (!sent) throw new Error("Expected relay request to be sent.");
  return sent;
}

describe("chat test routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
      directModels: [directTarget],
      modelPools: [poolTarget],
    });
    db.discoveredModel.findUnique.mockResolvedValue(directRow());
    db.relayRequest.create.mockResolvedValue({ id: "relay-request-id" });
    db.relayRequest.update.mockResolvedValue({ id: "relay-request-id" });
  });

  it("requires a cookie-authenticated session", async () => {
    const response = await appWith(new FakeRelayManager(), null).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });

    expect(response.status).toBe(401);
    expect(mockedTokenAccess.listVisibleModelTargetsForUser).not.toHaveBeenCalled();
  });

  it("streams a visible model through the websocket relay without a browser token", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: directTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "secret prompt" }],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.path).toBe("/v1/chat/completions");
    expect(mockedTokenAccess.listVisibleModelTargetsForUser).toHaveBeenCalledWith("user-id");

    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, "data: {}\n\n");
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("data: {}\n\n");
    expect(db.relayRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-id",
          modelApiTokenId: null,
          modelApiTokenLookupPrefix: null,
          requestedDiscoveredModelId: "model-id",
        }),
      }),
    );
  });

  it("applies the selected Responses surface, native mode, and forced local member", async () => {
    const manager = new FakeRelayManager();
    mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
      directModels: [directTarget],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([poolMemberRow()]);
    const responsePromise = appWith(manager).request("/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wsmp-chat-test-member-id": "member-id",
        "x-wsmp-chat-test-routing-mode": "REQUIRE_NATIVE",
      },
      body: JSON.stringify({
        model: poolTarget.modelId,
        input: "Reply with pong.",
        stream: false,
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.path).toBe("/v1/responses");
    expect(sent.endpointSlug).toBe("local");
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, '{"id":"resp_1","output":[]}');
    manager.complete(sent.requestId);
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it("keeps PREFERRED on the recommended native primary without unexpected public overflow", async () => {
    const manager = new FakeRelayManager();
    mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
      directModels: [directTarget],
      modelPools: [
        {
          ...poolTarget,
          protocolAdaptationEnabled: true,
          publicEgressEnabled: true,
          publicEgressAcknowledged: true,
          recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS",
        },
      ],
    });
    db.poolMember.findMany.mockResolvedValue([poolMemberRow("chat")]);
    db.modelPool.findFirst.mockResolvedValue(publicOverflowPoolRow());
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wsmp-chat-test-routing-mode": "PREFER_NATIVE",
      },
      body: JSON.stringify({
        model: poolTarget.modelId,
        messages: [{ role: "user", content: "Reply with pong." }],
        stream: false,
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.cliDeviceId).toBe("cli-device-id");
    expect(db.modelPool.findFirst).not.toHaveBeenCalled();
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, '{"choices":[{"message":{"role":"assistant","content":"pong"}}]}');
    manager.complete(sent.requestId);
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it("cancels the websocket relay request when the browser stops reading", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    await response.body?.cancel();

    expect(manager.cancelled).toContainEqual({
      cliDeviceId: "cli-device-id",
      requestId: sent.requestId,
      reason: "cancelled",
    });
  });

  it("does not fabricate a terminal usage event when RelayComplete has no usage", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, stream: true, messages: [] }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, "data: {}\n\n");
    manager.completeWithoutUsage(sent.requestId);

    await expect(response.text()).resolves.toBe("data: {}\n\n");
  });

  it("forwards standardized metrics separately from upstream usage", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, stream: true, messages: [] }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, "data: {}\n\n");
    manager.completeWithStandardizedMetrics(sent.requestId);

    await expect(response.text()).resolves.toBe(
      'data: {}\n\ndata: {"wsmp_metrics":{"completion_tokens":2,"tokenizer":"cl100k_base"}}\n\n',
    );
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ completionTokens: 3 }),
        }),
      ),
    );
  });
});
