import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const actual = await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
  return { default: mockDeep(), Prisma: actual.Prisma };
});

// pool-member-test.ts now delegates to the extracted diagnostics core, whose
// module graph includes routes.ts (the chat-test completions handler). That
// chain reads env.BETTER_AUTH_SECRET via @ws-model-proxy/db/forwarder-security
// and pulls @ws-model-proxy/env/server validation. Mock env so no real
// validation runs (same pattern as chat-test.test.ts).
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://member-test", NODE_ENV: "test" },
}));

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!" },
}));

vi.mock("@ws-model-proxy/api/lib/model-api-token-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ws-model-proxy/api/lib/model-api-token-access")>();
  return {
    ...actual,
    listVisibleModelTargetsForUser: vi.fn(async () => ({
      directModels: [],
      modelPools: [
        {
          id: "pool-id",
          target: "MODEL_POOL",
          modelId: "owner/pool",
          ownerUserId: "user-id",
          accessGrantId: null,
          protocolAdaptationEnabled: false,
          optimisticBasicTranscription: false,
        },
      ],
    })),
  };
});
const { createPoolMemberTestRoutes } = await import("./pool-member-test.js");
const { classifyChatProbeReply } = await import("./diagnostics.js");
const isSuccessfulChatProbeReply = (status: number, raw: string) =>
  classifyChatProbeReply(status, raw) === "pong";
const { ModelApiConcurrencyLimiter } = await import("./limits.js");
const { default: prisma } = await import("@ws-model-proxy/db");

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  modelPool: { findUnique: MockInstance };
  poolMemberRoutingVerdict: { findMany: MockInstance };
  user: { findUnique: MockInstance };
  relayRequest: { create: MockInstance; update: MockInstance; updateMany: MockInstance };
  relayExecutionAttempt: { create: MockInstance; updateMany: MockInstance };
  relayExecutionEvent: { create: MockInstance; createMany: MockInstance };
  poolMember: {
    findUnique: MockInstance;
    findFirst: MockInstance;
    findMany: MockInstance;
    updateMany: MockInstance;
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

  supportsCountContext() {
    return false;
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
    handler?.onComplete({ type: "relay.complete", requestId });
  }

  error(requestId: string, failure: "timeout" | "disconnected" = "timeout") {
    const handler = this.handlers.get(requestId);
    this.handlers.delete(requestId);
    handler?.onError({
      type: "relay.error",
      requestId,
      failure,
      message: failure,
    });
  }
}

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

function memberRow({
  ownerUserId = "user-id",
  published = true,
  endpointPublished = true,
  capabilityOverrideMode = "OVERRIDE",
  capabilityOverrideMetadata = {
    version: 1,
    protocol: "openai-compatible",
    chatCompletions: { supported: true, streaming: true },
  },
  capabilityOverrides = ["TEXT_GENERATION"],
  defaultCapabilities = ["TEXT_GENERATION"],
}: {
  ownerUserId?: string;
  published?: boolean;
  endpointPublished?: boolean;
  capabilityOverrideMode?: string;
  capabilityOverrideMetadata?: Record<string, unknown> | null;
  capabilityOverrides?: string[];
  defaultCapabilities?: string[];
} = {}) {
  return {
    id: "member-id",
    poolId: "pool-id",
    tier: "PRIMARY",
    instanceGate: "OPEN",
    routingStatus: "ACTIVE",
    healthStatus: "HEALTHY",
    weight: 1,
    ExecutionTarget: {
      id: "model-target",
      inferenceCapacityId: "model-capacity",
      DiscoveredModel: null,
    },
    inferenceContributionId: null,
    InferenceContribution: null,
    ModelPool: { userId: ownerUserId },
    DiscoveredModel: {
      id: "model-id",
      userId: ownerUserId,
      published,
      upstreamModelId: "upstream-chat",
      capabilityOverrideMode,
      capabilityOverrides,
      capabilityOverrideMetadata,
      Endpoint: {
        id: "endpoint-id",
        status: "ONLINE",
        published: endpointPublished,
        slug: "local",
        cliDeviceId: "cli-device-id",
        capabilityMetadata: null,
        defaultCapabilities,
        CliDevice: { status: "CONNECTED", userId: ownerUserId },
      },
    },
  };
}

function appWith({
  manager = new FakeRelayManager(),
  limiter = new ModelApiConcurrencyLimiter(),
  authSession = session,
}: {
  manager?: FakeRelayManager;
  limiter?: InstanceType<typeof ModelApiConcurrencyLimiter>;
  authSession?: Session | null;
} = {}) {
  const app = new Hono<{ Variables: { session: Session | null } }>();
  app.use("*", async (c, next) => {
    c.set("session", authSession);
    await next();
  });
  app.route(
    "/",
    createPoolMemberTestRoutes({
      manager,
      concurrencyLimiter: limiter,
      capacityRuntime: {
        acquire: vi.fn(async (attempt) => ({
          state: "ADMITTED" as const,
          lease: {
            leaseId: "lease",
            attemptId: attempt.attemptId,
            capacityId: "model-capacity",
            executionTargetId: "model-target",
            poolMemberId: "member-id",
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        })),
        release: vi.fn(async () => true),
        hold: (response) => response,
      },
    }),
  );
  return { app, manager, limiter };
}

function requireSent(manager: FakeRelayManager): SendRelayRequestArgs {
  const sent = manager.sent[0];
  if (!sent) throw new Error("Expected relay request to be sent.");
  return sent;
}

describe("isSuccessfulChatProbeReply", () => {
  it("requires HTTP 200 and a chat completion that contains pong", () => {
    expect(
      isSuccessfulChatProbeReply(
        200,
        JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
      ),
    ).toBe(true);
    expect(
      isSuccessfulChatProbeReply(
        200,
        JSON.stringify({ choices: [{ message: { content: "Pong!" } }] }),
      ),
    ).toBe(true);
    expect(
      isSuccessfulChatProbeReply(
        302,
        JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
      ),
    ).toBe(false);
    expect(isSuccessfulChatProbeReply(200, "<html>pong</html>")).toBe(false);
    expect(
      isSuccessfulChatProbeReply(
        200,
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      ),
    ).toBe(false);
  });
});

describe("pool member test routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (work: unknown) =>
      typeof work === "function" ? work(db) : Promise.all(work as Promise<unknown>[]),
    );
    db.$queryRaw.mockResolvedValue([{ now: new Date() }]);
    db.modelPool.findUnique.mockResolvedValue({
      userId: "user-id",
      transformerDiscoveredModelId: null,
    });
    db.poolMemberRoutingVerdict.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
    });
    db.poolMember.findMany.mockImplementation(async () => {
      const row = await prisma.poolMember.findUnique({ where: { id: "member-id" } });
      return row ? [row] : [];
    });
    db.poolMember.findFirst.mockImplementation(async () =>
      prisma.poolMember.findUnique({ where: { id: "member-id" } }),
    );
    db.relayRequest.create.mockResolvedValue({ id: "relay-request-id" });
    db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
    db.relayRequest.update.mockResolvedValue({ id: "relay-request-id" });
    db.relayExecutionAttempt.create.mockResolvedValue({ attemptId: "attempt-id" });
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
    db.relayExecutionEvent.create.mockResolvedValue({ id: "event-id" });
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.poolMember.findUnique.mockResolvedValue(memberRow());
    db.poolMember.updateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects unauthenticated requests", async () => {
    const { app } = appWith({ authSession: null });
    const response = await app.request("/members/member-id/test", { method: "POST" });
    expect(response.status).toBe(401);
    expect(db.poolMember.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a member owned by another user", async () => {
    db.poolMember.findUnique.mockResolvedValue(memberRow({ ownerUserId: "other-user" }));
    const { app, manager } = appWith();
    const response = await app.request("/members/member-id/test", { method: "POST" });
    expect(response.status).toBe(404);
    expect(manager.sent).toEqual([]);
  });

  it("rejects a disconnected member CLI", async () => {
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = [];
    const { app } = appWith({ manager });
    const response = await app.request("/members/member-id/test", { method: "POST" });
    expect(response.status).toBe(503);
    expect(manager.sent).toEqual([]);
  });

  it("rejects a member without a supported diagnostic surface", async () => {
    db.poolMember.findUnique.mockResolvedValue(
      memberRow({
        capabilityOverrideMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: false },
        },
        capabilityOverrides: [],
      }),
    );
    const { app, manager } = appWith();
    const response = await app.request("/members/member-id/test", { method: "POST" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/chat/i),
    });
    expect(manager.sent).toEqual([]);
  });

  it("resets member health after a successful chat probe and releases both leases", async () => {
    const limiter = new ModelApiConcurrencyLimiter();
    const { app, manager } = appWith({ limiter });
    const responsePromise = app.request("/members/member-id/test", { method: "POST" });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.path).toBe("/v1/chat/completions");

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    manager.complete(sent.requestId);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: 200 });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "member-id" }),
        data: expect.objectContaining({ healthStatus: "HEALTHY" }),
      }),
    );

    const leases = Array.from({ length: 8 }, () =>
      limiter.acquireGlobal({ tokenId: "pool-member-test:user-id", userId: "user-id" }),
    );
    expect(() =>
      limiter.acquireGlobal({ tokenId: "pool-member-test:user-id", userId: "user-id" }),
    ).toThrow(/Too many active/);
    for (const lease of leases) lease.release();
    expect(() => limiter.acquireCli("cli-device-id")).not.toThrow();
  });

  it("reports a reasoning-only length-capped reply as ok with a distinct detail", async () => {
    const { app, manager } = appWith();
    const responsePromise = app.request("/members/member-id/test", { method: "POST" });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(
      sent.requestId,
      JSON.stringify({
        choices: [
          { finish_reason: "length", message: { content: "", reasoning_content: "Thinking" } },
        ],
      }),
    );
    manager.complete(sent.requestId);
    const response = await responsePromise;
    const json = (await response.json()) as { ok: boolean; detail?: string };
    expect(json.ok).toBe(true);
    expect(json.detail).toMatch(/reasoning/i);
    expect(json.detail).not.toMatch(/did not return/i);
  });

  it("does not reset health on HTML 200 or a chat completion without pong", async () => {
    for (const body of [
      "<html>ok</html>",
      JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
    ]) {
      db.poolMember.updateMany.mockClear();
      const { app, manager } = appWith();
      const responsePromise = app.request("/members/member-id/test", { method: "POST" });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      manager.headers(sent.requestId, 200, { "content-type": "text/html" });
      manager.body(sent.requestId, body);
      manager.complete(sent.requestId);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: false });
      expect(db.poolMember.updateMany).not.toHaveBeenCalled();
    }
  });

  it("does not reset health on a 3xx completed response", async () => {
    const { app, manager } = appWith();
    const responsePromise = app.request("/members/member-id/test", { method: "POST" });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 302, { location: "/login" });
    manager.body(sent.requestId, "");
    manager.complete(sent.requestId);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(db.poolMember.updateMany).not.toHaveBeenCalled();
  });

  it("does not reset health when the relay terminal fails after 200 headers", async () => {
    const { app, manager } = appWith();
    const responsePromise = app.request("/members/member-id/test", { method: "POST" });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.error(sent.requestId, "timeout");

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(db.poolMember.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a test when the global lease is already exhausted and does not take a CLI lease", async () => {
    const limiter = new ModelApiConcurrencyLimiter();
    const held = Array.from({ length: 8 }, () =>
      limiter.acquireGlobal({ tokenId: "pool-member-test:user-id", userId: "user-id" }),
    );
    const { app, manager } = appWith({ limiter });
    const response = await app.request("/members/member-id/test", { method: "POST" });
    expect(response.status).toBe(429);
    expect(manager.sent).toEqual([]);
    expect(() => limiter.acquireCli("cli-device-id")).not.toThrow();
    for (const lease of held) lease.release();
  });
});
