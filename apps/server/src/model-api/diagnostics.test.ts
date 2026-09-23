import type {
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";
import type { CapacityAdmissionRuntime } from "./capacity/runtime.js";

/**
 * Phase 5 extracted diagnostic cores: `runPoolMemberTest` and
 * `runChatCompletionDiagnostic` are the ONE application layer shared by the
 * Hono chat-test/pool-member-test routes and the MCP diagnostic tools. These
 * tests drive the cores directly (typed outcomes), pin Hono-vs-core parity
 * for the ownership and success paths, and pin the module-lifetime
 * diagnostics capacity-runtime singleton.
 */

const envState = vi.hoisted(() => ({
  values: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
  },
}));

vi.mock("@ws-model-proxy/env/server", () => ({ env: envState.values }));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/api/lib/model-api-token-access", () => ({
  authenticateModelApiTokenSecret: vi.fn(),
  listVisibleModelTargetsForUser: vi.fn(),
  listVisibleModelTargetsForToken: vi.fn(),
}));

const { diagnosticsCapacityRuntime, runChatCompletionDiagnostic, runPoolMemberTest } = await import(
  "./diagnostics"
);

function admittingCapacityRuntime(): CapacityAdmissionRuntime {
  return {
    acquire: vi.fn(async (attempt) => {
      const selected = attempt.candidates[0];
      if (!selected) return { state: "CANCELLED" as const };
      return {
        state: "ADMITTED" as const,
        lease: {
          leaseId: `lease-${selected.poolMemberId ?? selected.executionTargetId}`,
          attemptId: attempt.attemptId,
          capacityId: selected.capacityId,
          executionTargetId: selected.executionTargetId,
          poolMemberId: selected.poolMemberId,
          fencingToken: 1n,
          expiresAt: new Date(Date.now() + 30_000),
        },
      };
    }),
    release: vi.fn(async () => true),
    hold: vi.fn((response) => response),
  };
}
const { createPoolMemberTestRoutes } = await import("./pool-member-test");
const { ModelApiConcurrencyLimiter } = await import("./limits");
const { default: prisma } = await import("@ws-model-proxy/db");
const tokenAccess = await import("@ws-model-proxy/api/lib/model-api-token-access");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  poolMember: { findUnique: MockInstance; update: MockInstance };
  discoveredModel: { findUnique: MockInstance };
  executionTarget: { findUnique: MockInstance };
  modelPool: { findFirst: MockInstance };
  relayRequest: { create: MockInstance; update: MockInstance; updateMany: MockInstance };
  relayExecutionEvent: { create: MockInstance; createMany: MockInstance };
  relayExecutionAttempt: { create: MockInstance; updateMany: MockInstance };
};

const mockedTokenAccess = tokenAccess as unknown as {
  listVisibleModelTargetsForUser: MockInstance;
};

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

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
    handler?.onError({ type: "relay.error", requestId, failure, message: failure });
  }
}

function requireSent(manager: FakeRelayManager): SendRelayRequestArgs {
  const sent = manager.sent[0];
  if (!sent) throw new Error("Expected relay request to be sent.");
  return sent;
}

function requireSentAt(manager: FakeRelayManager, index: number): SendRelayRequestArgs {
  const sent = manager.sent[index];
  if (!sent) throw new Error(`Expected relay request #${index} to be sent.`);
  return sent;
}

function memberRow({
  ownerUserId = "user-id",
  published = true,
  endpointPublished = true,
  capabilityOverrideMetadata = {
    version: 1,
    protocol: "openai-compatible",
    chatCompletions: { supported: true, streaming: true },
  },
  capabilityOverrides = ["TEXT_GENERATION"],
  withModel = true,
}: {
  ownerUserId?: string;
  published?: boolean;
  endpointPublished?: boolean;
  capabilityOverrideMetadata?: Record<string, unknown> | null;
  capabilityOverrides?: string[];
  withModel?: boolean;
} = {}) {
  return {
    id: "member-id",
    ModelPool: { userId: ownerUserId },
    DiscoveredModel: withModel
      ? {
          id: "model-id",
          published,
          upstreamModelId: "upstream-chat",
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrides,
          capabilityOverrideMetadata,
          Endpoint: {
            published: endpointPublished,
            slug: "local",
            cliDeviceId: "cli-device-id",
            capabilityMetadata: null,
            defaultCapabilities: ["TEXT_GENERATION"],
            CliDevice: { status: "CONNECTED" },
          },
        }
      : null,
  };
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
  providerAccountLabels: [],
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
};

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
    ExecutionTarget: {
      id: "model-target",
      inferenceCapacityId: "model-capacity",
      directContextCeiling: null,
      directContextMargin: 0,
      InferenceCapacity: null,
    },
  };
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

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (input: unknown) => {
    if (typeof input === "function") return input(db);
    return Promise.all(input as Promise<unknown>[]);
  });
  db.$queryRaw.mockResolvedValue([{ now: new Date("2026-08-26T00:00:00.000Z") }]);
  db.poolMember.findUnique.mockResolvedValue(memberRow());
  db.poolMember.update.mockResolvedValue({ id: "member-id" });
  mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
    directModels: [directTarget],
    modelPools: [poolTarget],
  });
  db.discoveredModel.findUnique.mockResolvedValue(directRow());
  db.executionTarget.findUnique.mockResolvedValue({ id: "execution-target-id" });
  db.relayRequest.create.mockResolvedValue({ id: "relay-request-id" });
  db.relayRequest.update.mockResolvedValue({ id: "relay-request-id" });
  db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
  db.relayExecutionEvent.create.mockResolvedValue({ id: "relay-event-id" });
  db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
  db.relayExecutionAttempt.create.mockResolvedValue({ attemptId: "attempt-id" });
  db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
});

describe("runPoolMemberTest — typed core outcomes", () => {
  it("hides foreign-owned and missing members behind the same not-found", async () => {
    db.poolMember.findUnique.mockResolvedValue(memberRow({ ownerUserId: "other-user" }));
    await expect(runPoolMemberTest({ userId: "user-id", memberId: "member-id" })).resolves.toEqual({
      outcome: "not-found",
    });
    db.poolMember.findUnique.mockResolvedValue(null);
    await expect(runPoolMemberTest({ userId: "user-id", memberId: "missing" })).resolves.toEqual({
      outcome: "not-found",
    });
  });

  it("classifies non-relay, unpublished, non-chat, and disconnected members before any lease", async () => {
    db.poolMember.findUnique.mockResolvedValue(memberRow({ withModel: false }));
    await expect(runPoolMemberTest({ userId: "user-id", memberId: "m" })).resolves.toEqual({
      outcome: "not-relay-capable",
    });
    db.poolMember.findUnique.mockResolvedValue(memberRow({ published: false }));
    await expect(runPoolMemberTest({ userId: "user-id", memberId: "m" })).resolves.toEqual({
      outcome: "unpublished",
    });
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
    await expect(runPoolMemberTest({ userId: "user-id", memberId: "m" })).resolves.toEqual({
      outcome: "not-chat-capable",
    });
    db.poolMember.findUnique.mockResolvedValue(memberRow());
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = [];
    await expect(runPoolMemberTest({ userId: "user-id", memberId: "m", manager })).resolves.toEqual(
      { outcome: "cli-disconnected" },
    );
    expect(manager.sent).toEqual([]);
  });

  it("returns rate-limited when the global lease is exhausted, without taking a CLI lease", async () => {
    const limiter = new ModelApiConcurrencyLimiter();
    const held = Array.from({ length: 8 }, () =>
      limiter.acquireGlobal({ tokenId: "pool-member-test:user-id", userId: "user-id" }),
    );
    const manager = new FakeRelayManager();
    await expect(
      runPoolMemberTest({ userId: "user-id", memberId: "m", manager, concurrencyLimiter: limiter }),
    ).resolves.toEqual({ outcome: "rate-limited" });
    expect(manager.sent).toEqual([]);
    expect(() => limiter.acquireCli("cli-device-id")).not.toThrow();
    for (const lease of held) lease.release();
  });

  it("maps a successful pong probe to ok, marks health, and releases both leases", async () => {
    const limiter = new ModelApiConcurrencyLimiter();
    const manager = new FakeRelayManager();
    const corePromise = runPoolMemberTest({
      userId: "user-id",
      memberId: "member-id",
      manager,
      concurrencyLimiter: limiter,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.path).toBe("/v1/chat/completions");
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    manager.complete(sent.requestId);
    await expect(corePromise).resolves.toMatchObject({ outcome: "ok", status: 200 });
    expect(db.poolMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-id" },
        data: expect.objectContaining({ healthStatus: "HEALTHY" }),
      }),
    );
    // Both leases were released: the diagnostic bucket accepts a full burst
    // again and the CLI bucket stays available.
    const leases = Array.from({ length: 8 }, () =>
      limiter.acquireGlobal({ tokenId: "pool-member-test:user-id", userId: "user-id" }),
    );
    expect(() =>
      limiter.acquireGlobal({ tokenId: "pool-member-test:user-id", userId: "user-id" }),
    ).toThrow(/Too many active/);
    for (const lease of leases) lease.release();
    expect(() => limiter.acquireCli("cli-device-id")).not.toThrow();
  });

  it("maps a 200-without-pong reply to probe-failed without marking health", async () => {
    const manager = new FakeRelayManager();
    const corePromise = runPoolMemberTest({
      userId: "user-id",
      memberId: "member-id",
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
    manager.complete(sent.requestId);
    await expect(corePromise).resolves.toMatchObject({
      outcome: "probe-failed",
      status: 200,
    });
    expect(db.poolMember.update).not.toHaveBeenCalled();
  });

  it("maps a relay terminal failure after headers to probe-failed with the failure reason", async () => {
    const manager = new FakeRelayManager();
    const corePromise = runPoolMemberTest({
      userId: "user-id",
      memberId: "member-id",
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.error(sent.requestId, "timeout");
    await expect(corePromise).resolves.toMatchObject({
      outcome: "probe-failed",
      reason: expect.stringContaining("timeout"),
    });
    expect(db.poolMember.update).not.toHaveBeenCalled();
  });
});

describe("Hono route ↔ core parity (pool member test)", () => {
  function routeApp(manager: FakeRelayManager) {
    const app = new Hono<{ Variables: { session: Session | null } }>();
    app.use("*", async (c, next) => {
      c.set("session", session);
      await next();
    });
    app.route(
      "/",
      createPoolMemberTestRoutes({ manager, concurrencyLimiter: new ModelApiConcurrencyLimiter() }),
    );
    return app;
  }

  it("the route's 404 for a foreign member is the core's not-found outcome", async () => {
    const manager = new FakeRelayManager();
    const app = routeApp(manager);
    db.poolMember.findUnique.mockResolvedValue(memberRow({ ownerUserId: "other-user" }));
    const response = await app.request("/members/member-id/test", { method: "POST" });
    expect(response.status).toBe(404);
    await expect(
      runPoolMemberTest({ userId: "user-id", memberId: "member-id", manager }),
    ).resolves.toEqual({ outcome: "not-found" });
    expect(manager.sent).toEqual([]);
  });

  it("a core success and the route success agree on the probe (both saw the relay)", async () => {
    const manager = new FakeRelayManager();
    const app = routeApp(manager);
    const routePromise = app.request("/members/member-id/test", { method: "POST" });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    manager.complete(sent.requestId);
    const response = await routePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: 200 });
  });
});

describe("runChatCompletionDiagnostic — bounded provider-safe summary", () => {
  it("projects a successful completion without ever returning the raw body", async () => {
    const manager = new FakeRelayManager();
    const diagnosticPromise = runChatCompletionDiagnostic({
      capacityRuntime: admittingCapacityRuntime(),
      userId: "user-id",
      body: {
        model: directTarget.modelId,
        stream: true, // MUST be forced to false by the core.
        messages: [{ role: "user", content: "Reply with pong." }],
      },
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(
      sent.requestId,
      JSON.stringify({
        model: "gpt-4o-mini",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    manager.complete(sent.requestId);
    await expect(diagnosticPromise).resolves.toEqual({
      outcome: "ok",
      status: 200,
      model: "gpt-4o-mini",
      finishReason: "stop",
      assistantText: "pong",
      usage: { promptTokens: 11, completionTokens: 7 },
    });
    // stream was forced off before dispatch: the relayed body is one JSON
    // completion, not an SSE request.
    const relayedBody = await readSentBody(sent);
    expect(JSON.parse(relayedBody)).toMatchObject({ stream: false, model: "gpt-4o-mini" });
  });

  it("bounds the assistant excerpt length", async () => {
    const manager = new FakeRelayManager();
    const longText = "x".repeat(5_000);
    const diagnosticPromise = runChatCompletionDiagnostic({
      capacityRuntime: admittingCapacityRuntime(),
      userId: "user-id",
      body: {
        model: directTarget.modelId,
        messages: [{ role: "user", content: "hi" }],
      },
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(
      sent.requestId,
      JSON.stringify({
        model: "gpt-4o-mini",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: longText } }],
      }),
    );
    manager.complete(sent.requestId);
    const result = await diagnosticPromise;
    expect(result).toMatchObject({ outcome: "ok" });
    if (result.outcome === "ok") {
      expect(result.assistantText?.length).toBe(2_000);
    }
  });

  it("surfaces upstream rejections as the provider error type, never the message", async () => {
    const manager = new FakeRelayManager();
    const diagnosticPromise = runChatCompletionDiagnostic({
      capacityRuntime: admittingCapacityRuntime(),
      userId: "user-id",
      body: { model: directTarget.modelId, messages: [{ role: "user", content: "hi" }] },
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 429, { "content-type": "application/json" });
    manager.body(
      sent.requestId,
      JSON.stringify({
        error: { type: "rate_limit_exceeded", message: "SECRET PROVIDER MESSAGE" },
      }),
    );
    manager.complete(sent.requestId);
    await expect(diagnosticPromise).resolves.toEqual({
      outcome: "upstream-rejected",
      status: 429,
      errorType: "rate_limit_exceeded",
    });
  });

  it("maps unparseable upstream bodies and completions without assistant text", async () => {
    const manager = new FakeRelayManager();
    const first = runChatCompletionDiagnostic({
      capacityRuntime: admittingCapacityRuntime(),
      userId: "user-id",
      body: { model: directTarget.modelId, messages: [{ role: "user", content: "hi" }] },
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    let sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/html" });
    manager.body(sent.requestId, "<html>not json</html>");
    manager.complete(sent.requestId);
    await expect(first).resolves.toEqual({ outcome: "unparseable-response", status: 200 });

    const second = runChatCompletionDiagnostic({
      capacityRuntime: admittingCapacityRuntime(),
      userId: "user-id",
      body: { model: directTarget.modelId, messages: [{ role: "user", content: "hi" }] },
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    sent = requireSentAt(manager, 1);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ choices: [] }));
    manager.complete(sent.requestId);
    await expect(second).resolves.toEqual({ outcome: "no-completion", status: 200 });
  });

  it("maps the core's own request validation failure to invalid-request", async () => {
    await expect(
      runChatCompletionDiagnostic({
        capacityRuntime: admittingCapacityRuntime(),
        userId: "user-id",
        body: { messages: [] },
        manager: new FakeRelayManager(),
      }),
    ).resolves.toEqual({
      outcome: "invalid-request",
      reason: "chat completion request rejected",
    });
  });
});

describe("diagnosticsCapacityRuntime — module-lifetime singleton", () => {
  it("returns the SAME instance across calls and transports", () => {
    const first = diagnosticsCapacityRuntime();
    const second = diagnosticsCapacityRuntime();
    expect(second).toBe(first);
  });
});

describe("G2 — stable outcomes only (failure data never crosses the core)", () => {
  it("a health-write DB failure becomes the stable probe-error reason — the hostile message never crosses", async () => {
    const manager = new FakeRelayManager();
    db.poolMember.update.mockRejectedValue(
      new Error("R63_DB_SENTINEL PrismaClientKnownRequestError P2025 SECRET_SQL"),
    );
    const corePromise = runPoolMemberTest({
      userId: "user-id",
      memberId: "member-id",
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    manager.complete(sent.requestId);
    const result = await corePromise;
    expect(result).toMatchObject({ outcome: "probe-error", reason: "Member test failed." });
    expect(JSON.stringify(result)).not.toContain("R63_DB_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("SECRET_SQL");
  });

  it("a relay transport exception also maps to a stable reason (no hostile message)", async () => {
    const manager = new FakeRelayManager();
    const corePromise = runPoolMemberTest({
      userId: "user-id",
      memberId: "member-id",
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    // Body-stream failure after headers: the read throws with the relay
    // failure — the catch arm must collapse it to the stable reason.
    manager.error(sent.requestId, "disconnected");
    const result = await corePromise;
    expect(["probe-error", "probe-failed"]).toContain(result.outcome);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("an unknown upstream error.type maps to the generic stable kind", async () => {
    const manager = new FakeRelayManager();
    const diagnosticPromise = runChatCompletionDiagnostic({
      capacityRuntime: admittingCapacityRuntime(),
      userId: "user-id",
      body: { model: directTarget.modelId, messages: [{ role: "user", content: "hi" }] },
      manager,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 500, { "content-type": "application/json" });
    manager.body(
      sent.requestId,
      JSON.stringify({ error: { type: "R64_ERROR_TYPE_SENTINEL", message: "SECRET" } }),
    );
    manager.complete(sent.requestId);
    await expect(diagnosticPromise).resolves.toEqual({
      outcome: "upstream-rejected",
      status: 500,
      errorType: "provider_error",
    });
  });
});

describe("G7 — upstream 400 releases the capacity lease", () => {
  it("cancels the abandoned body so an upstream-400-held lease releases", async () => {
    const releases: string[] = [];
    const heartbeats: string[] = [];
    const lease: import("./capacity/types.js").CapacityLeaseHandle = {
      leaseId: "lease-1",
      attemptId: "attempt-1",
      capacityId: "cap-1",
      executionTargetId: "target-1",
      fencingToken: 1n,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const store = {
      acquire: vi.fn(async () => ({ state: "ADMITTED" as const, lease })),
      heartbeat: vi.fn(async () => {
        heartbeats.push(lease.leaseId);
        return true;
      }),
      release: vi.fn(async () => {
        releases.push(lease.leaseId);
        return true;
      }),
      terminalizeAttempt: vi.fn(async () => ({ state: "MISSING" as const })),
      reclaimExpired: vi.fn(async () => 0),
    };
    const { holdCapacityLeaseForResponse } = await import("./capacity/response-lease.js");
    const runtime = {
      acquire: store.acquire,
      release: store.release,
      hold: (response: Response, l: typeof lease, signal?: AbortSignal) =>
        holdCapacityLeaseForResponse({
          response,
          store,
          lease: l,
          signal,
          heartbeatIntervalMs: 10_000,
        }),
    };
    // The capacity admission path requires the direct target's ExecutionTarget
    // to carry an inferenceCapacityId (the candidate the lease is held for).
    db.discoveredModel.findUnique.mockResolvedValue({
      ...directRow(),
      ExecutionTarget: { id: "execution-target-id", inferenceCapacityId: "cap-1" },
    });
    const manager = new FakeRelayManager();
    const diagnosticPromise = runChatCompletionDiagnostic({
      userId: "user-id",
      body: { model: directTarget.modelId, messages: [{ role: "user", content: "hi" }] },
      manager,
      capacityRuntime: runtime,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 400, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ error: { message: "upstream rejected" } }));
    manager.complete(sent.requestId);
    await expect(diagnosticPromise).resolves.toMatchObject({ outcome: "invalid-request" });
    // The upstream-400 exit CANCELLED the body: the lease RELEASED instead
    // of leaking with a heartbeat running (the R63 probe shape).
    await vi.waitFor(() => expect(releases).toEqual([lease.leaseId]));
  });
});

describe("G1 — caller-signal cancellation threads into the cores", () => {
  it("aborting the pool core's signal cancels the relay attempt", async () => {
    const manager = new FakeRelayManager();
    const controller = new AbortController();
    const corePromise = runPoolMemberTest({
      userId: "user-id",
      memberId: "member-id",
      manager,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    controller.abort();
    const result = await corePromise;
    expect(manager.cancelled.length).toBeGreaterThanOrEqual(1);
    expect(["probe-error", "probe-failed"]).toContain(result.outcome);
  });

  it("aborting the chat core's signal cancels the synthetic request's relay attempt", async () => {
    const manager = new FakeRelayManager();
    const controller = new AbortController();
    const diagnosticPromise = runChatCompletionDiagnostic({
      capacityRuntime: admittingCapacityRuntime(),
      userId: "user-id",
      body: { model: directTarget.modelId, messages: [{ role: "user", content: "hi" }] },
      manager,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    controller.abort();
    // The handler maps an aborted dispatch to a rejected/terminal outcome;
    // either way it must SETTLE promptly and the relay must be cancelled.
    await diagnosticPromise.catch(() => undefined);
    expect(manager.cancelled.length).toBeGreaterThanOrEqual(1);
  });
});

/** Read the relayed request body (chunks or source) for assertions. */
async function readSentBody(sent: SendRelayRequestArgs): Promise<string> {
  if (sent.bodyChunks && sent.bodyChunks.length > 0) {
    return sent.bodyChunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
  }
  throw new Error("Expected relayed body chunks.");
}
