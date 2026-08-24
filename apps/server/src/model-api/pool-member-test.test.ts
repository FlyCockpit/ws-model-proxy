import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { createPoolMemberTestRoutes, isSuccessfulChatProbeReply } = await import(
  "./pool-member-test.js"
);
const { ModelApiConcurrencyLimiter } = await import("./limits.js");
const { default: prisma } = await import("@ws-model-proxy/db");

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

const db = prisma as unknown as {
  poolMember: {
    findUnique: MockInstance;
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
    ModelPool: { userId: ownerUserId },
    DiscoveredModel: {
      id: "model-id",
      published,
      upstreamModelId: "upstream-chat",
      capabilityOverrideMode,
      capabilityOverrides,
      capabilityOverrideMetadata,
      Endpoint: {
        published: endpointPublished,
        slug: "local",
        cliDeviceId: "cli-device-id",
        capabilityMetadata: null,
        defaultCapabilities,
        CliDevice: { status: "CONNECTED" },
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
  app.route("/", createPoolMemberTestRoutes({ manager, concurrencyLimiter: limiter }));
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
    db.poolMember.findUnique.mockResolvedValue(memberRow());
    db.poolMember.update.mockResolvedValue({ id: "member-id" });
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

  it("rejects embeddings-only members instead of sending a chat probe", async () => {
    db.poolMember.findUnique.mockResolvedValue(
      memberRow({
        capabilityOverrideMetadata: {
          version: 1,
          protocol: "openai-compatible",
          embeddings: { supported: true },
        },
        capabilityOverrides: ["EMBEDDING"],
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
    expect(db.poolMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-id" },
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

  it("does not reset health on HTML 200 or a chat completion without pong", async () => {
    for (const body of [
      "<html>ok</html>",
      JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
    ]) {
      db.poolMember.update.mockClear();
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
      expect(db.poolMember.update).not.toHaveBeenCalled();
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
    expect(db.poolMember.update).not.toHaveBeenCalled();
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
    expect(db.poolMember.update).not.toHaveBeenCalled();
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
