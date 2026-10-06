import type {
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import type { Session } from "@ws-model-proxy/auth";
import type { Prisma } from "@ws-model-proxy/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";
import { CapacityLeaseLostError } from "./capacity/lease-loss.js";
import { CapacityLeaseOwner } from "./capacity/lease-owner.js";
import type { CapacityAdmissionRuntime } from "./capacity/runtime.js";
import { LocalSendRefused } from "./local-send.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  // The generated client, not `importOriginal()`: the real index needs a live env.
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  return { default: mockDeep<typeof import("@ws-model-proxy/db").default>(), Prisma };
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
  listVisibleModelTargetsWithExternalPermissionForToken: vi.fn(),
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
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  user: { findUnique: MockInstance };
  discoveredModel: {
    findUnique: MockInstance;
  };
  executionTarget: {
    findUnique: MockInstance;
  };
  poolMember: {
    findMany: MockInstance;
    findFirst: MockInstance;
  };
  modelPool: {
    findFirst: MockInstance;
    findUnique: MockInstance;
  };
  relayRequest: {
    create: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  relayExecutionEvent: {
    create: MockInstance;
    createMany: MockInstance;
  };
  relayExecutionAttempt: {
    create: MockInstance;
    findFirst: MockInstance;
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
  fallbackEnabled: false,
  fallbackForGrantees: false,
  externalMemberCount: 0,
  effectiveProviderEgress: false,
  providerAccountLabels: [],
  providerTypes: [],
  externalRoutes: [],
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

type PermissionModel = Prisma.DiscoveredModelGetPayload<{
  select: {
    id: true;
    published: true;
    userId: true;
    upstreamModelId: true;
    capabilityOverrideMode: true;
    capabilityOverrideMetadata: true;
    Endpoint: {
      select: {
        id: true;
        slug: true;
        published: true;
        cliDeviceId: true;
        status: true;
        capabilityMetadata: true;
        CliDevice: { select: { status: true; userId: true } };
      };
    };
    ExecutionTarget: { select: { id: true; inferenceCapacityId: true } };
  };
}>;

function directRow() {
  return {
    id: "model-id",
    published: true,
    userId: "user-id",
    upstreamModelId: "gpt-4o-mini",
    capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS" as const,
    capabilityOverrideMetadata: null,
    Endpoint: {
      id: "endpoint-id",
      slug: "local",
      published: true,
      cliDeviceId: "cli-device-id",
      status: "ONLINE" as const,
      capabilityMetadata: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: true, streaming: true },
      },
      CliDevice: { status: "CONNECTED" as const, userId: "user-id" },
    },
    ExecutionTarget: {
      id: "model-target",
      inferenceCapacityId: "model-capacity",
      directContextCeiling: null,
      directContextMargin: 0,
      InferenceCapacity: null,
    },
  } satisfies PermissionModel & {
    ExecutionTarget: NonNullable<PermissionModel["ExecutionTarget"]> & {
      directContextCeiling: null;
      directContextMargin: number;
      InferenceCapacity: null;
    };
  };
}

function directCounterRow() {
  const selected = directRow();
  return {
    ...selected,
    Endpoint: {
      ...selected.Endpoint,
      capabilityMetadata: {
        version: 1,
        protocol: "openai-compatible",
        responses: { supported: true, countTokens: true },
      },
    },
  };
}

function poolMemberRow(native: "chat" | "responses" = "responses") {
  return {
    id: "member-id",
    poolId: "pool-id",
    discoveredModelId: "model-id",
    executionTargetId: "member-target",
    tier: "PRIMARY",
    instanceGate: "OPEN",
    inferenceContributionId: null,
    InferenceContribution: null,
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
      inferenceCapacityId: "member-capacity",
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
    fallbackEnabled: true,
    fallbackForGrantees: false,
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

function appWith(
  manager: FakeRelayManager,
  authSession: Session | null = session,
  capacityRuntime: CapacityAdmissionRuntime = admittingCapacityRuntime(),
  twoFactorRequired: () => Promise<boolean> = async () => false,
) {
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
      capacityRuntime,
      twoFactorRequired,
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
  const transactionFailures: unknown[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    transactionFailures.length = 0;
    db.$transaction.mockImplementation(async (input: unknown) => {
      if (typeof input === "function") {
        try {
          return await input(db);
        } catch (error) {
          transactionFailures.push(error);
          throw error;
        }
      }
      return Promise.all(input as Promise<unknown>[]);
    });
    db.$queryRaw.mockResolvedValue([{ now: new Date("2026-08-26T00:00:00.000Z") }]);
    // #76: the pool owner is read again before every local dispatch.
    db.user.findUnique.mockResolvedValue({
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
    });
    mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
      directModels: [directTarget],
      modelPools: [poolTarget],
    });
    db.discoveredModel.findUnique.mockResolvedValue(directRow());
    db.modelPool.findUnique.mockResolvedValue({
      userId: "user-id",
      transformerDiscoveredModelId: null,
      embeddingContract: null,
    });
    db.poolMember.findFirst.mockImplementation(async () => {
      const members = await vi.mocked(prisma.poolMember.findMany)();
      return members?.[0] ?? null;
    });
    db.executionTarget.findUnique.mockResolvedValue({ id: "execution-target-id" });
    db.relayRequest.create.mockResolvedValue({ id: "relay-request-id" });
    db.relayRequest.update.mockResolvedValue({ id: "relay-request-id" });
    db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
    db.relayExecutionEvent.create.mockResolvedValue({ id: "relay-event-id" });
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.relayExecutionAttempt.create.mockResolvedValue({ attemptId: "attempt-id" });
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
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

  it.each(["/chat/completions", "/responses", "/messages"])(
    "refuses %s to an unenrolled user while 2FA is forced, before any work",
    async (path) => {
      const manager = new FakeRelayManager();
      const policy = vi.fn(async () => true);
      const response = await appWith(manager, session, admittingCapacityRuntime(), policy).request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
        },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "two_factor_required" } });
      expect(policy).toHaveBeenCalled();
      expect(mockedTokenAccess.listVisibleModelTargetsForUser).not.toHaveBeenCalled();
      expect(manager.sent).toHaveLength(0);
    },
  );

  it.each([
    ["an enrolled user while 2FA is forced", true, true],
    ["an unenrolled user while the policy is off", false, false],
  ])("serves %s", async (_label, enrolled, forced) => {
    const manager = new FakeRelayManager();
    const user = { ...session, user: { ...session.user, twoFactorEnabled: enrolled } } as Session;
    const responsePromise = appWith(
      manager,
      user,
      admittingCapacityRuntime(),
      async () => forced,
    ).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: directTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, "data: {}\n\n");
    manager.complete(sent.requestId);
    expect(response.status).toBe(200);
  });

  it("leaves a missing session to the routes' own 401 without reading the policy", async () => {
    const policy = vi.fn(async () => true);
    const response = await appWith(
      new FakeRelayManager(),
      null,
      admittingCapacityRuntime(),
      policy,
    ).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(policy).not.toHaveBeenCalled();
  });

  it("refuses a final requester revocation after admission without sending any relay request", async () => {
    const runtime = admittingCapacityRuntime();
    const acquire = vi.mocked(runtime.acquire).getMockImplementation()!;
    vi.mocked(runtime.acquire).mockImplementation(async (attempt, signal) => {
      const admitted = await acquire(attempt, signal);
      db.user.findUnique.mockResolvedValue({
        banned: true,
        banExpires: null,
        deletionRequestedAt: null,
      });
      return admitted;
    });
    const manager = new FakeRelayManager();
    const response = await appWith(manager, session, runtime).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });
    expect(runtime.acquire).toHaveBeenCalledOnce();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "authentication_error", code: "access_denied" },
    });
    expect(transactionFailures).toHaveLength(1);
    expect(transactionFailures[0]).toBeInstanceOf(LocalSendRefused);
    expect(transactionFailures[0]).toMatchObject({
      denial: "REQUESTER_BLOCKED",
      failure: "access_denied",
    });
    expect(manager.sent).toEqual([]);
    expect(manager.handlers.size).toBe(0);
    expect(runtime.release).toHaveBeenCalledOnce();
    expect(db.relayExecutionEvent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            eventType: "TERMINAL",
            errorClass: "access_denied",
            httpStatusCode: 401,
          }),
        ]),
      }),
    );
  });

  it.each(["removed model", "failed permission check"])(
    "preserves the final %s denial without sending or leaking its admission",
    async (kind) => {
      const runtime = admittingCapacityRuntime();
      const acquire = vi.mocked(runtime.acquire).getMockImplementation()!;
      vi.mocked(runtime.acquire).mockImplementation(async (attempt, signal) => {
        const admitted = await acquire(attempt, signal);
        if (kind === "removed model") db.discoveredModel.findUnique.mockResolvedValue(null);
        else db.$transaction.mockRejectedValueOnce(new Error("permission database unavailable"));
        return admitted;
      });
      const manager = new FakeRelayManager();
      const response = await appWith(manager, session, runtime).request("/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
      });
      expect(response.status).toBe(kind === "removed model" ? 404 : 500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: kind === "removed model" ? "not_found" : "unknown" },
      });
      expect(manager.sent).toEqual([]);
      expect(manager.handlers.size).toBe(0);
      expect(runtime.release).toHaveBeenCalledOnce();
    },
  );

  it("keeps unexpected dispatch setup failures as unknown and releases admission", async () => {
    db.relayExecutionAttempt.create.mockRejectedValueOnce(new Error("telemetry unavailable"));
    const runtime = admittingCapacityRuntime();
    const manager = new FakeRelayManager();
    const response = await appWith(manager, session, runtime).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unknown" } });
    expect(manager.sent).toEqual([]);
    expect(manager.handlers.size).toBe(0);
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it("preserves a requester denial from the direct native counter before admission", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directCounterRow());
    db.relayExecutionAttempt.create.mockImplementationOnce(async () => {
      db.user.findUnique.mockResolvedValue({
        banned: true,
        banExpires: null,
        deletionRequestedAt: null,
      });
      return { attemptId: "counter-attempt" };
    });
    const runtime = admittingCapacityRuntime();
    const manager = new FakeRelayManager();
    const response = await appWith(manager, session, runtime).request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, input: "counter input" }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "authentication_error", code: "access_denied" },
    });
    expect(transactionFailures).toHaveLength(1);
    expect(transactionFailures[0]).toMatchObject({ denial: "REQUESTER_BLOCKED" });
    expect(manager.sent).toEqual([]);
    expect(manager.handlers.size).toBe(0);
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
    expect(db.relayExecutionEvent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            attemptKind: "CONTEXT_COUNT",
            errorClass: "access_denied",
            httpStatusCode: 401,
          }),
        ]),
      }),
    );
  });

  it.each(["exact count", "counter timeout"])(
    "serves the direct Responses request after %s",
    async (kind) => {
      db.discoveredModel.findUnique.mockResolvedValue(directCounterRow());
      const runtime = admittingCapacityRuntime();
      const manager = new FakeRelayManager();
      const pending = appWith(manager, session, runtime).request("/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: directTarget.modelId, input: "counter input" }),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const count = requireSent(manager);
      expect(count.path).toBe("/v1/responses/count_tokens");
      if (kind === "counter timeout") {
        manager.handlers
          .get(count.requestId)
          ?.onError({ type: "relay.error", requestId: count.requestId, failure: "timeout" });
      } else {
        manager.headers(count.requestId, 200, { "content-type": "application/json" });
        manager.body(count.requestId, '{"input_tokens":2}');
        manager.complete(count.requestId);
      }
      await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
      const sent = manager.sent[1]!;
      expect(sent.path).toBe("/v1/responses");
      manager.headers(sent.requestId, 200, { "content-type": "application/json" });
      manager.body(sent.requestId, '{"id":"resp_counter","output":[]}');
      manager.complete(sent.requestId);
      const response = await pending;
      expect(response.status).toBe(200);
      await response.text();
      expect(runtime.acquire).toHaveBeenCalledOnce();
      expect(runtime.hold).toHaveBeenCalledOnce();
    },
  );

  it("keeps caller cancellation during direct native counting as cancelled", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directCounterRow());
    const runtime = admittingCapacityRuntime();
    const manager = new FakeRelayManager();
    const controller = new AbortController();
    const pending = appWith(manager, session, runtime).request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, input: "counter input" }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    controller.abort(new Error("caller left"));
    const response = await pending;
    expect(response.status).toBe(499);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "cancelled" } });
    expect(manager.sent).toHaveLength(1);
    expect(manager.handlers.size).toBe(0);
    expect(runtime.acquire).not.toHaveBeenCalled();
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
          fallbackEnabled: true,
          externalMemberCount: 1,
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
    // With durable global capacity disabled, Chat Test must not even discover
    // provider candidates; the healthy local primary remains available.
    expect(db.modelPool.findFirst).not.toHaveBeenCalled();
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, '{"choices":[{"message":{"role":"assistant","content":"pong"}}]}');
    manager.complete(sent.requestId);
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it("F2-CAP-3: answers a lost Chat Test lease with 503, not a 499 cancellation", async () => {
    const manager = new FakeRelayManager();
    const lease = new AbortController();
    const runtime = admittingCapacityRuntime();
    vi.mocked(runtime.acquire).mockImplementation(async (attempt) => {
      const selected = attempt.candidates[0]!;
      return {
        state: "ADMITTED" as const,
        lease: {
          leaseId: "lease-chat-test",
          attemptId: attempt.attemptId,
          capacityId: selected.capacityId,
          executionTargetId: selected.executionTargetId,
          fencingToken: 1n,
          expiresAt: new Date(Date.now() + 30_000),
          signal: lease.signal,
        },
      };
    });
    const responsePromise = appWith(manager, session, runtime).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    lease.abort(new CapacityLeaseLostError("ownership_lost"));
    const response = await responsePromise;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "capacity_lease_lost" },
    });
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorClass: "capacity_lease_lost" }),
      }),
    );
  });

  it("F2-CAP-6: the Chat Test request scope releases an owner the route never released", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const leaseStore = {
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    };
    const owners: CapacityLeaseOwner[] = [];
    const runtime = admittingCapacityRuntime();
    vi.mocked(runtime.acquire).mockImplementation(async (attempt) => {
      const selected = attempt.candidates[0]!;
      const lease = {
        leaseId: "lease-leaked",
        attemptId: attempt.attemptId,
        capacityId: selected.capacityId,
        executionTargetId: selected.executionTargetId,
        fencingToken: 1n,
        expiresAt: new Date(Date.now() + 30_000),
      };
      const owner = new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
      owners.push(owner);
      return { state: "ADMITTED" as const, lease: { ...lease, signal: owner.signal } };
    });
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager, session, runtime).request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, "{}");
    manager.complete(sent.requestId);
    await response.text();
    await vi.waitFor(() => expect(leaseStore.release).toHaveBeenCalledOnce());
    expect(owners[0]?.signal.reason).toMatchObject({ kind: "request_scope_closed" });
    warn.mockRestore();
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
    await vi.waitFor(() => {
      expect(db.relayExecutionAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            attemptId: sent.requestId,
            state: "ACTIVE",
          }),
          data: expect.objectContaining({ state: "SUCCEEDED" }),
        }),
      );
      expect(db.relayExecutionEvent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              attemptId: sent.requestId,
              eventType: "TERMINAL",
              terminalState: "SUCCEEDED",
              completionTokens: 3,
              usageSource: "CLI_NORMALIZED",
            }),
          ],
          skipDuplicates: true,
        }),
      );
      // The terminal write is status-guarded (the exactly-once rollup claim)
      // and selects the rollup facts; the request source is CHAT_TEST.
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "relay-request-id", status: "PENDING" },
          data: expect.objectContaining({
            status: "SUCCEEDED",
            completionTokens: 3,
            usageKnown: true,
            // Captured once when the outcome is known (not the DB clock of
            // whichever finalization attempt commits).
            completedAt: expect.any(Date),
          }),
          select: expect.objectContaining({ id: true, source: true, status: true }),
        }),
      );
      expect(db.relayRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ source: "CHAT_TEST" }) }),
      );
    });
  });
});
