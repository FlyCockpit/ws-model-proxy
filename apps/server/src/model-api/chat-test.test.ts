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
};

const poolTarget: VisibleModelPoolTarget = {
  target: "MODEL_POOL",
  id: "pool-id",
  modelId: "owner/general",
  name: "General",
  description: null,
  ownerUserId: "user-id",
  ownerUserSlug: "owner",
  poolSlug: "general",
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
    userId: "user-id",
    upstreamModelId: "gpt-4o-mini",
    capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrideMetadata: null,
    Endpoint: {
      id: "endpoint-id",
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
});
