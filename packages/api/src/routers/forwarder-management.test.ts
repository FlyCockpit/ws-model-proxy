import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import {
  parseDirectModelId,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { forwarderManagementRouter } from "./forwarder-management";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  class TestDecimal {
    readonly value: string;

    constructor(value: string | number) {
      this.value = String(value);
    }

    greaterThan(other: string | number) {
      return Number(this.value) > Number(other);
    }
  }
  return {
    default: mockDeep(),
    Prisma: {
      DbNull: { kind: "DbNull" },
      Decimal: TestDecimal,
      TransactionIsolationLevel: { Serializable: "Serializable" },
    },
  };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {},
  ADMIN_EMAILS: new Set<string>(),
}));

const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: {
    findUnique: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
  };
  discoveredModel: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  appSetting: {
    findUnique: MockInstance;
  };
  modelPool: {
    findMany: MockInstance;
    findUnique: MockInstance;
    findFirst: MockInstance;
    create: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  cliDevice: {
    findMany: MockInstance;
    findUnique: MockInstance;
    delete: MockInstance;
  };
  endpoint: {
    findUnique: MockInstance;
    delete: MockInstance;
  };
  poolMember: {
    create: MockInstance;
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  executionTarget: { findMany: MockInstance; upsert: MockInstance };
  inferenceCapacity: { updateMany: MockInstance };
  providerModel: { findFirst: MockInstance; findMany: MockInstance };
  providerBudgetPolicy: { create: MockInstance; findFirst: MockInstance; findMany: MockInstance };
  providerAuditEvent: { create: MockInstance; findFirst: MockInstance };
  poolGrant: {
    upsert: MockInstance;
    deleteMany: MockInstance;
    findMany: MockInstance;
  };
  capacityAuditEvent: { create: MockInstance };
  cacheAffinityRecord: {
    count: MockInstance;
    groupBy: MockInstance;
    deleteMany: MockInstance;
  };
};

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };
  return {
    session: {
      user: {
        id: "user-id",
        email: "owner@example.com",
        name: "Owner",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "session-id",
        userId: sessionOverride?.user?.id ?? "user-id",
        token: "session-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

function client() {
  return createRouterClient(forwarderManagementRouter, { context: buildContext() });
}

function httpClient(captures?: Array<{ status: number; body: string }>) {
  const handler = new RPCHandler(forwarderManagementRouter);
  const link = new RPCLink({
    url: "https://example.test/rpc",
    fetch: async (request, init) => {
      const result = await handler.handle(new Request(request, init), {
        prefix: "/rpc",
        context: buildContext(),
      });
      if (!result.matched) return new Response(null, { status: 404 });
      if (captures)
        captures.push({
          status: result.response.status,
          body: await result.response.clone().text(),
        });
      return result.response;
    },
  });
  return createORPCClient(link) as ReturnType<
    typeof createRouterClient<typeof forwarderManagementRouter>
  >;
}

function poolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pool-id",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    slug: "general",
    name: "General",
    description: null,
    maxAttachmentBytes: null,
    optimisticBasicTranscription: false,
    protocolAdaptationEnabled: false,
    allowLossyDeveloperRoleCollapse: false,
    recommendedSurfaceOverride: null,
    transformerDiscoveredModelId: null,
    transformerSystemPrompt: null,
    transformerImages: true,
    transformerAudio: false,
    transformerVideo: false,
    transformerCacheMode: "OFF",
    TransformerDiscoveredModel: null,
    User: { slug: "owner" },
    PoolMembers: [],
    PoolGrants: [],
    ...overrides,
  };
}

function guardedLocalModel(
  overrides: Record<string, unknown> = {},
  native: "chat" | "responses" = "responses",
) {
  return {
    id: "local-id",
    upstreamModelId: "local-model",
    capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrides: [],
    capabilityOverrideMetadata: null,
    Endpoint: {
      capabilityMetadata: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: native === "chat", streaming: true },
        responses: { supported: native === "responses", streaming: true },
      },
      defaultCapabilities: [],
    },
    ...overrides,
  };
}

describe("forwarderManagementRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.executionTarget.upsert.mockResolvedValue({ id: "target-id" });
    db.capacityAuditEvent.create.mockResolvedValue({ id: "audit-id" });
    db.appSetting.findUnique.mockResolvedValue(null);
  });

  it("denies guessed provider attachments and public-egress mutations over HTTP", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.modelPool.findFirst.mockResolvedValue(null);
    db.poolMember.findUnique.mockResolvedValue(null);
    db.providerModel.findFirst.mockResolvedValue(null);
    const captures: Array<{ status: number; body: string }> = [];
    const rpc = httpClient(captures);
    const attempts = [
      rpc.updateModelPool({
        id: "foreign-pool",
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
      }),
      rpc.addProviderPoolMember({
        poolId: "foreign-pool",
        providerModelId: "foreign-provider-model",
        publicOrder: 0,
      }),
      rpc.addPoolMember({
        poolId: "foreign-pool",
        discoveredModelId: "foreign-discovered-model",
        weight: 1,
        routingStatus: "ACTIVE",
      }),
      rpc.updatePoolMember({ id: "foreign-member", publicOrder: 1 }),
      rpc.reorderProviderPoolMember({ id: "foreign-member", direction: "EARLIER" }),
      rpc.removePoolMember({ id: "foreign-member" }),
      rpc.deleteModelPool({ id: "foreign-pool" }),
      rpc.grantPoolAccessByEmail({ poolId: "foreign-pool", email: "victim@example.test" }),
      rpc.revokePoolAccessByEmail({ poolId: "foreign-pool", email: "victim@example.test" }),
      rpc.cacheAffinityStats({ poolId: "foreign-pool" }),
      rpc.clearCacheAffinity({ poolId: "foreign-pool" }),
      rpc.removeCliDeviceMetadata({ id: "foreign-cli" }),
      rpc.removeEndpointMetadata({ id: "foreign-endpoint" }),
      rpc.removeDiscoveredModelMetadata({ id: "foreign-discovered-model" }),
      rpc.updateDiscoveredModelCapabilities({
        id: "foreign-discovered-model",
        vision: true,
        audio: false,
        video: false,
      }),
      rpc.setDiscoveredModelCapabilityProfile({
        id: "foreign-discovered-model",
        mode: "inherit",
        optimisticBasicTranscription: false,
      }),
      rpc.updateDiscoveredModelAttachmentLimit({
        id: "foreign-discovered-model",
        maxAttachmentBytes: null,
      }),
    ];
    const results = await Promise.allSettled(attempts);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(captures).toHaveLength(attempts.length);
    for (const capture of captures) {
      expect(capture.status).toBe(404);
      expect(capture.body).toContain("NOT_FOUND");
      for (const identifier of [
        "foreign-pool",
        "foreign-provider-model",
        "foreign-member",
        "foreign-discovered-model",
        "foreign-cli",
        "foreign-endpoint",
      ])
        expect(capture.body).not.toContain(identifier);
    }
    expect(db.executionTarget.upsert).not.toHaveBeenCalled();
    expect(db.poolMember.create).not.toHaveBeenCalled();
    expect(db.poolMember.update).not.toHaveBeenCalled();
    expect(db.poolMember.delete).not.toHaveBeenCalled();
    expect(db.poolGrant.upsert).not.toHaveBeenCalled();
    expect(db.poolGrant.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects guarded overflow without acknowledgement or a positive finite spend cap", async () => {
    const base = {
      slug: "guarded",
      name: "Guarded",
      localModelIds: ["local-id"],
      recommendedSurface: "OPENAI_RESPONSES" as const,
      memberConcurrencyLimit: 1,
      memberContextCeiling: 31_744,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      providerModels: [
        { providerModelId: "provider-id", concurrencyLimit: 1, dailySpendLimit: "10.00" },
      ],
    };
    await expect(
      client().createGuardedModelPool({ ...base, publicEgressAcknowledged: false }),
    ).rejects.toBeDefined();
    await expect(
      client().createGuardedModelPool({
        ...base,
        publicEgressAcknowledged: true,
        providerModels: [
          { providerModelId: "provider-id", concurrencyLimit: 1, dailySpendLimit: "0" },
        ],
      }),
    ).rejects.toBeDefined();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("atomically persists guarded local capacity reuse, ordered providers, budgets, and audits", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(
      poolRow({
        protocolAdaptationEnabled: true,
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
      }),
    );
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "existing-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "shared-capacity",
        InferenceCapacity: { physicalMaxContext: 65_536 },
      },
    ]);
    db.providerModel.findMany.mockResolvedValue([
      {
        id: "provider-b",
        providerAccountId: "account-b",
        PricingVersions: [{ id: "price-b", currency: "USD" }],
      },
      {
        id: "provider-a",
        providerAccountId: "account-a",
        PricingVersions: [{ id: "price-a", currency: "USD" }],
      },
    ]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.executionTarget.upsert
      .mockResolvedValueOnce({ id: "provider-target-b" })
      .mockResolvedValueOnce({ id: "provider-target-a" });
    db.providerBudgetPolicy.create
      .mockResolvedValueOnce({ id: "budget-b" })
      .mockResolvedValueOnce({ id: "budget-a" });

    await client().createGuardedModelPool({
      slug: "guarded",
      name: "Guarded",
      localModelIds: ["local-id"],
      recommendedSurface: "OPENAI_RESPONSES",
      memberConcurrencyLimit: 2,
      memberContextCeiling: 32_768,
      reservedSlots: 1,
      localWaitBudgetMs: 30_000,
      publicEgressAcknowledged: true,
      advanced: {
        physicalCountStrategy: "TEMPLATE_AWARE",
        contextMargin: 2_048,
        borrowPolicy: "NEVER",
        protocolAdaptationEnabled: false,
        allowLossyDeveloperRoleCollapse: true,
        affinity: {
          enabled: true,
          ttlSeconds: 7_200,
          maxRecords: 20_000,
          prefixWeight: 110,
          conversationWeight: 160,
          confirmedCacheWeight: 260,
          loadPenaltyWeight: 120,
        },
        memberOverrides: [
          {
            discoveredModelId: "local-id",
            concurrency: { mode: "LIMITED", limitValue: 2 },
            reservedSlots: 1,
            borrowPolicy: "NEVER",
            waitBudget: { mode: "LIMITED", limitValue: 15_000 },
            contextCeiling: { mode: "LIMITED", limitValue: 30_000 },
            contextMargin: 2_000,
          },
        ],
      },
      providerModels: [
        {
          providerModelId: "provider-b",
          concurrencyLimit: 2,
          dailySpendLimit: "",
          budgetRules: {
            concurrency: { mode: "LIMITED", limitValue: 2 },
            tokensPerAttempt: { mode: "LIMITED", limitValue: 100_000 },
            tokensPerDay: { mode: "LIMITED", limitValue: 1_000_000 },
            tokensPerMonth: { mode: "LIMITED", limitValue: 10_000_000 },
            tokensLifetime: { mode: "UNLIMITED", limitValue: null },
            spendPerDay: { mode: "UNLIMITED", limitValue: null },
            spendPerMonth: { mode: "LIMITED", limitValue: "100" },
          },
        },
        { providerModelId: "provider-a", concurrencyLimit: 1, dailySpendLimit: "4.25" },
      ],
    });

    expect(db.modelPool.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        protocolAdaptationEnabled: false,
        allowLossyDeveloperRoleCollapse: true,
        capacityContextMargin: 2_048,
        capacityBorrowPolicy: "NEVER",
        affinityEnabled: true,
        affinityTtlSeconds: 7_200,
        affinityMaxRecords: 20_000,
      }),
      select: { id: true },
    });
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-id", id: { in: ["shared-capacity"] } },
      data: { countStrategy: "TEMPLATE_AWARE" },
    });

    expect(db.poolMember.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          executionTargetId: "existing-target",
          tier: "PRIMARY",
          capacityConcurrencyMode: "LIMITED",
          capacityConcurrencyLimit: 2,
          capacityReservedSlots: 1,
          capacityBorrowPolicy: "NEVER",
          capacityWaitBudgetMode: "LIMITED",
          capacityWaitBudgetMs: 15_000,
          capacityContextCeilingMode: "LIMITED",
          capacityContextCeiling: 30_000,
          capacityContextMargin: 2_000,
        }),
      }),
    );
    expect(db.poolMember.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ publicOrder: 0 }) }),
    );
    expect(db.poolMember.create).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ data: expect.objectContaining({ publicOrder: 1 }) }),
    );
    expect(db.providerBudgetPolicy.create).toHaveBeenCalledTimes(2);
    expect(db.providerBudgetPolicy.create.mock.calls[0]?.[0].data.Rules.create).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "CONCURRENCY", mode: "LIMITED" }),
        expect.objectContaining({ metric: "SPEND", mode: "LIMITED", currency: "USD" }),
        expect.objectContaining({ metric: "TOKENS", period: "LIFETIME", mode: "UNLIMITED" }),
      ]),
    );
    expect(db.providerBudgetPolicy.create.mock.calls[0]?.[0].data.Rules.create).toHaveLength(7);
    expect(db.providerAuditEvent.create).toHaveBeenCalledTimes(2);
    expect(db.capacityAuditEvent.create).toHaveBeenCalledTimes(1);
    expect(db.executionTarget.upsert.mock.calls).not.toContainEqual([
      expect.objectContaining({
        update: expect.objectContaining({ inferenceCapacityId: expect.anything() }),
      }),
    ]);
  });

  it("refuses guarded setup instead of inventing or overwriting physical capacity mapping", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "existing-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: null,
        InferenceCapacity: null,
      },
    ]);

    await expect(
      client().createGuardedModelPool({
        slug: "guarded",
        name: "Guarded",
        localModelIds: ["local-id"],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 1,
        memberContextCeiling: 32_768,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        publicEgressAcknowledged: false,
        providerModels: [],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(db.modelPool.create).not.toHaveBeenCalled();
    expect(db.executionTarget.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["OPENAI_RESPONSES", "adapted recommendation when a native primary API exists"],
    ["OPENAI_COMPLETIONS", "unavailable primary recommendation"],
  ] as const)("rejects %s as an %s", async (recommendedSurface) => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel({}, "chat")]);

    await expect(
      client().createGuardedModelPool({
        slug: "guarded-recommendation",
        name: "Guarded recommendation",
        localModelIds: ["local-id"],
        recommendedSurface,
        memberConcurrencyLimit: 1,
        memberContextCeiling: 8_192,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        publicEgressAcknowledged: false,
        providerModels: [],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("rolls back guarded setup when a mid-transaction provider budget write fails", async () => {
    let rolledBack = false;
    db.$transaction.mockImplementationOnce(async (callback: (tx: typeof db) => unknown) => {
      try {
        return await callback(db);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "existing-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "shared-capacity",
        InferenceCapacity: { physicalMaxContext: 65_536 },
      },
    ]);
    db.providerModel.findMany.mockResolvedValue([
      {
        id: "provider-id",
        providerAccountId: "account-id",
        PricingVersions: [{ id: "price-id", currency: "USD" }],
      },
    ]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.executionTarget.upsert.mockResolvedValue({ id: "provider-target" });
    db.providerBudgetPolicy.create.mockRejectedValue(new Error("injected budget failure"));

    await expect(
      client().createGuardedModelPool({
        slug: "guarded",
        name: "Guarded",
        localModelIds: ["local-id"],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 1,
        memberContextCeiling: 32_768,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        publicEgressAcknowledged: true,
        advanced: {
          physicalCountStrategy: "ENGINE_REPORTED",
          contextMargin: 1_024,
          borrowPolicy: "WHEN_IDLE",
          protocolAdaptationEnabled: true,
          allowLossyDeveloperRoleCollapse: false,
          affinity: {
            enabled: false,
            ttlSeconds: 3_600,
            maxRecords: 10_000,
            prefixWeight: 100,
            conversationWeight: 150,
            confirmedCacheWeight: 250,
            loadPenaltyWeight: 100,
          },
          memberOverrides: [],
        },
        providerModels: [
          { providerModelId: "provider-id", concurrencyLimit: 1, dailySpendLimit: "5" },
        ],
      }),
    ).rejects.toThrow("injected budget failure");
    expect(rolledBack).toBe(true);
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalled();
    expect(db.capacityAuditEvent.create).not.toHaveBeenCalled();
  });

  it("does not reflect foreign guarded-pool model ids through HTTP response envelopes", async () => {
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        guardedLocalModel({ id: "owned-local-model", upstreamModelId: "owned-model" }),
      ]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "owned-local-target",
        discoveredModelId: "owned-local-model",
        inferenceCapacityId: "owned-capacity",
        InferenceCapacity: { physicalMaxContext: 32_768 },
      },
    ]);
    db.providerModel.findMany.mockResolvedValueOnce([]);
    const captures: Array<{ status: number; body: string }> = [];
    const rpc = httpClient(captures);
    const base = {
      slug: "guarded-auth-proof",
      name: "Guarded auth proof",
      recommendedSurface: "OPENAI_RESPONSES" as const,
      memberConcurrencyLimit: 1,
      memberContextCeiling: 31_744,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      publicEgressAcknowledged: true,
    };

    const localResult = await Promise.allSettled([
      rpc.createGuardedModelPool({
        ...base,
        localModelIds: ["foreign-local-model"],
        providerModels: [],
      }),
    ]);
    const providerResult = await Promise.allSettled([
      rpc.createGuardedModelPool({
        ...base,
        slug: "guarded-provider-auth-proof",
        localModelIds: ["owned-local-model"],
        providerModels: [
          {
            providerModelId: "foreign-provider-model",
            concurrencyLimit: 1,
            dailySpendLimit: "10.00",
          },
        ],
      }),
    ]);

    expect(localResult[0]).toMatchObject({ status: "rejected", reason: { code: "NOT_FOUND" } });
    expect(providerResult[0]).toMatchObject({
      status: "rejected",
      reason: { code: "PRECONDITION_FAILED" },
    });
    expect(captures).toHaveLength(2);
    expect(captures.map((capture) => capture.status)).toEqual([404, 412]);
    expect(captures[0]?.body).toContain("NOT_FOUND");
    expect(captures[1]?.body).toContain("PRECONDITION_FAILED");
    for (const capture of captures) {
      expect(capture.body).not.toContain("foreign-local-model");
      expect(capture.body).not.toContain("foreign-provider-model");
    }
    expect(db.executionTarget.upsert).not.toHaveBeenCalled();
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("previews and updates the current user's slug without changing internal ids", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ id: "user-id", slug: "old-owner" })
      .mockResolvedValueOnce(null);
    db.discoveredModel.findMany.mockResolvedValueOnce([
      {
        id: "model-id",
        upstreamModelId: "org/model 1",
        Endpoint: {
          slug: "local",
          CliDevice: { slug: "desk" },
        },
      },
    ]);
    db.modelPool.findMany.mockResolvedValue([{ id: "pool-id", slug: "general", name: "General" }]);
    db.user.update.mockResolvedValue({ id: "user-id", slug: "new-owner" });

    const result = await client().updateProfileSlug({ slug: "new-owner" });

    expect(result.slug).toBe("new-owner");
    expect(result.preview.affectedModels).toEqual([
      {
        kind: "DIRECT_MODEL",
        id: "model-id",
        upstreamModelId: "org/model 1",
        currentModelId: "old-owner/desk/local/org%2Fmodel%201",
        nextModelId: "new-owner/desk/local/org%2Fmodel%201",
      },
      {
        kind: "MODEL_POOL",
        id: "pool-id",
        name: "General",
        currentModelId: "old-owner/general",
        nextModelId: "new-owner/general",
      },
    ]);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-id" },
      data: { slug: "new-owner" },
      select: { id: true, slug: true },
    });
  });

  it.each([
    "ab",
    "a".repeat(64),
    "api",
    "-abc",
    "abc-",
    "abc--def",
    "abc_def",
    "abc def",
    "abc.def",
    "abc/def",
    "Abc",
  ])("rejects invalid or reserved slugs: %s", async (slug) => {
    await expect(client().previewProfileSlugChange({ slug })).rejects.toThrow();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects globally colliding user slugs", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ id: "user-id", slug: "owner" })
      .mockResolvedValueOnce({ id: "other-user-id" });

    await expect(client().previewProfileSlugChange({ slug: "taken" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("CONFLICT");
        return true;
      },
    );
  });

  it("lists owned CLI metadata with effective capabilities and no endpoint secrets", async () => {
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        slug: "desk",
        label: "Desk",
        status: "CONNECTED",
        lastConnectedAt: new Date("2026-01-01T00:00:00Z"),
        lastDisconnectedAt: null,
        lastHeartbeatAt: new Date("2026-01-01T00:00:30Z"),
        connectionCount: 3,
        User: { slug: "renamed-owner" },
        Endpoints: [
          {
            id: "endpoint-id",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-02"),
            slug: "local",
            label: "Local",
            kind: "OPENAI_COMPATIBLE",
            status: "ONLINE",
            defaultCapabilities: ["TEXT_GENERATION"],
            capabilityMetadata: { chatCompletions: { supported: true } },
            probeSuggestions: null,
            lastSeenAt: new Date("2026-01-01T00:00:30Z"),
            lastHealthCheckAt: null,
            statusChangedAt: null,
            failureReasonCode: null,
            baseUrl: "http://127.0.0.1:11434",
            secret: "endpoint-secret",
            DiscoveredModels: [
              {
                id: "model-id",
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-02"),
                slug: null,
                upstreamModelId: "llama",
                encodedModelId: "old-owner/desk/local/llama",
                capabilityOverrideMode: "OVERRIDE",
                capabilityOverrides: ["TEXT_GENERATION", "VISION_INPUT"],
                capabilityOverrideMetadata: { chatCompletions: { vision: true } },
                probeSuggestions: null,
                lastSeenAt: new Date("2026-01-01T00:00:30Z"),
              },
            ],
          },
        ],
      },
    ]);

    const result = await client().listCliDevices();

    expect(result[0]?.endpoints[0]?.models[0]?.effectiveCapabilities).toEqual({
      coarse: ["TEXT_GENERATION", "VISION_INPUT"],
      metadata: { chatCompletions: { vision: true } },
      source: "MODEL_OVERRIDE",
    });
    expect(result[0]?.endpoints[0]?.models[0]?.canonicalModelId).toBe(
      "renamed-owner/desk/local/llama",
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("endpoint-secret");
  });

  it("removes metadata only when the row belongs to the current user", async () => {
    db.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "other-user-id",
      status: "STALE",
      lastHeartbeatAt: new Date("2026-01-01"),
    });

    await expect(client().removeCliDeviceMetadata({ id: "cli-id" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("NOT_FOUND");
        return true;
      },
    );
    expect(db.cliDevice.delete).not.toHaveBeenCalled();
  });

  it("creates and updates owned model pools without touching grant ids", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "pool-id",
      userId: "user-id",
    });
    db.modelPool.create.mockResolvedValue(poolRow());
    db.modelPool.update.mockResolvedValue(poolRow({ slug: "new-general" }));

    await expect(
      client().createModelPool({ slug: "general", name: "General" }),
    ).resolves.toMatchObject({
      id: "pool-id",
      canonicalModelId: "owner/general",
    });
    await client().updateModelPool({ id: "pool-id", slug: "new-general", name: "New General" });

    expect(db.modelPool.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pool-id" },
        data: { slug: "new-general", name: "New General" },
      }),
    );
    expect(db.poolGrant.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when enabling public egress without acknowledgement", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", publicEgressEnabled: false, publicEgressAcknowledged: false }),
    );

    await expect(
      client().updateModelPool({ id: "pool-id", publicEgressEnabled: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive", { mode: "LIMITED", limitValue: "2" }, null],
    ["LIMITED without a positive limit", { mode: "LIMITED", limitValue: null }, new Date()],
    ["UNLIMITED with a value", { mode: "UNLIMITED", limitValue: "1" }, new Date()],
  ])(
    "rejects public-egress enablement when an attachment policy is %s",
    async (_label, rule, activatedAt) => {
      db.modelPool.findUnique.mockResolvedValue(
        poolRow({ userId: "user-id", publicEgressEnabled: false, publicEgressAcknowledged: false }),
      );
      db.poolMember.findMany.mockResolvedValue([
        {
          id: "member-1",
          ExecutionTarget: {
            ProviderModel: { id: "provider-model", providerAccountId: "provider-account" },
          },
        },
      ]);
      db.providerBudgetPolicy.findMany.mockResolvedValue([
        {
          id: "policy",
          providerModelId: "provider-model",
          providerAccountId: "provider-account",
          activatedAt,
          Rules: [rule],
        },
      ]);
      db.providerAuditEvent.findFirst.mockResolvedValue({ id: "audit" });

      await expect(
        client().updateModelPool({
          id: "pool-id",
          publicEgressEnabled: true,
          publicEgressAcknowledged: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(db.modelPool.update).not.toHaveBeenCalled();
    },
  );

  it("rejects public-egress enablement when an otherwise valid policy lacks an audit", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", publicEgressEnabled: false, publicEgressAcknowledged: false }),
    );
    db.poolMember.findMany.mockResolvedValue([
      {
        id: "member-1",
        ExecutionTarget: {
          ProviderModel: { id: "provider-model", providerAccountId: "provider-account" },
        },
      },
    ]);
    db.providerBudgetPolicy.findMany.mockResolvedValue([
      {
        id: "policy",
        providerModelId: "provider-model",
        providerAccountId: "provider-account",
        activatedAt: new Date(),
        Rules: [{ mode: "LIMITED", limitValue: "2" }],
      },
    ]);
    db.providerAuditEvent.findFirst.mockResolvedValue(null);

    await expect(
      client().updateModelPool({
        id: "pool-id",
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("enables public egress only when every attachment has an audited explicit rule", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", publicEgressEnabled: false, publicEgressAcknowledged: false }),
    );
    db.poolMember.findMany.mockResolvedValue([
      {
        id: "member-1",
        ExecutionTarget: {
          ProviderModel: { id: "provider-model-1", providerAccountId: "provider-account-1" },
        },
      },
      {
        id: "member-2",
        ExecutionTarget: {
          ProviderModel: { id: "provider-model-2", providerAccountId: "provider-account-2" },
        },
      },
    ]);
    db.providerBudgetPolicy.findMany.mockResolvedValue([
      {
        id: "policy-1",
        providerModelId: "provider-model-1",
        providerAccountId: "provider-account-1",
        activatedAt: new Date(),
        Rules: [{ mode: "LIMITED", limitValue: "2" }],
      },
      {
        id: "policy-2",
        providerModelId: "provider-model-2",
        providerAccountId: "provider-account-2",
        activatedAt: new Date(),
        Rules: [{ mode: "UNLIMITED", limitValue: null }],
      },
    ]);
    db.providerAuditEvent.findFirst.mockResolvedValue({ id: "audit" });
    db.modelPool.update.mockResolvedValue(
      poolRow({ publicEgressEnabled: true, publicEgressAcknowledged: true }),
    );

    await expect(
      client().updateModelPool({
        id: "pool-id",
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
      }),
    ).resolves.toMatchObject({ publicEgressEnabled: true, publicEgressAcknowledged: true });
  });

  it("atomically creates a pool and its capacity-policy audit record", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.modelPool.create.mockResolvedValue(poolRow());

    await client().createModelPool({
      slug: "general",
      name: "General",
      capacityPriority: 23,
      capacityConcurrencyLimit: 4,
      capacityReservedSlots: 2,
      capacityWaitBudgetMs: 1_500,
      capacityContextCeiling: 32_768,
      capacityContextMargin: 1_024,
      capacityBorrowPolicy: "NEVER",
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.modelPool.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-id",
        slug: "general",
        capacityPriority: 23,
        capacityConcurrencyLimit: 4,
        capacityReservedSlots: 2,
        capacityWaitBudgetMs: 1_500,
        capacityContextCeiling: 32_768,
        capacityContextMargin: 1_024,
        capacityBorrowPolicy: "NEVER",
      }),
      select: expect.any(Object),
    });
    expect(db.capacityAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-id",
        actorUserId: "user-id",
        action: "CREATE",
        resourceType: "MODEL_POOL",
        resourceId: "pool-id",
        after: expect.objectContaining({
          capacityPriority: 23,
          capacityConcurrencyLimit: 4,
          capacityReservedSlots: 2,
        }),
      }),
    });
    expect(db.capacityAuditEvent.create.mock.calls[0]?.[0].data.after).not.toHaveProperty(
      "description",
    );
    expect(db.modelPool.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.capacityAuditEvent.create.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("fails pool creation when the atomic capacity-policy audit cannot be persisted", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.modelPool.create.mockResolvedValue(poolRow());
    db.capacityAuditEvent.create.mockRejectedValue(new Error("policy audit failed"));

    await expect(
      client().createModelPool({
        slug: "general",
        name: "General",
        capacityConcurrencyLimit: 2,
      }),
    ).rejects.toThrow("policy audit failed");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.modelPool.create).toHaveBeenCalledTimes(1);
    expect(db.capacityAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it("persists explicit protocol policy and reports the full member compatibility matrix", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null);
    db.modelPool.create.mockResolvedValue(
      poolRow({
        protocolAdaptationEnabled: true,
        allowLossyDeveloperRoleCollapse: true,
        recommendedSurfaceOverride: "ANTHROPIC_MESSAGES",
        PoolMembers: [
          {
            id: "member-id",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            discoveredModelId: "model-id",
            weight: 1,
            healthStatus: "HEALTHY",
            routingStatus: "ACTIVE",
            lastFailureClass: null,
            consecutiveRetryableFailures: 0,
            lastFailureAt: null,
            nextRetryAt: null,
            halfOpenTrialStartedAt: null,
            ExecutionTarget: null,
            DiscoveredModel: {
              id: "model-id",
              upstreamModelId: "gpt-local",
              capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
              capabilityOverrides: [],
              capabilityOverrideMetadata: null,
              User: { slug: "owner" },
              Endpoint: {
                id: "endpoint-id",
                slug: "local",
                capabilityMetadata: {
                  version: 1,
                  protocol: "openai-compatible",
                  chatCompletions: { supported: true, streaming: true },
                },
                defaultCapabilities: [],
                CliDevice: { slug: "desktop" },
              },
            },
          },
        ],
      }),
    );

    const result = await client().createModelPool({
      slug: "protocols",
      name: "Protocols",
      protocolAdaptationEnabled: true,
      allowLossyDeveloperRoleCollapse: true,
      recommendedSurfaceOverride: "ANTHROPIC_MESSAGES",
    });

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          protocolAdaptationEnabled: true,
          allowLossyDeveloperRoleCollapse: true,
          recommendedSurfaceOverride: "ANTHROPIC_MESSAGES",
        }),
      }),
    );
    expect(result.members[0]?.model?.surfaces).toMatchObject({
      OPENAI_CHAT_COMPLETIONS: { mode: "native", streaming: true },
      OPENAI_RESPONSES: { mode: "adapted" },
      ANTHROPIC_MESSAGES: { mode: "adapted" },
      OPENAI_COMPLETIONS: { mode: "unavailable" },
    });
    expect(result.compatibility).toMatchObject({
      recommendedSurface: "ANTHROPIC_MESSAGES",
      warnings: expect.arrayContaining([
        "adaptation_strict_subset",
        "developer_role_collapse_lossy",
      ]),
    });
  });

  it("defensively clears an invalid stored recommended surface", async () => {
    db.modelPool.findMany.mockResolvedValue([
      poolRow({ recommendedSurfaceOverride: "UNSUPPORTED_FUTURE_SURFACE" }),
    ]);

    const [result] = await client().listModelPools();

    expect(result).toMatchObject({
      recommendedSurfaceOverride: null,
      compatibility: { recommendedSurface: null, warnings: [] },
    });
  });

  it("persists an in-range pool attachment limit and rejects one above the global policy", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null);
    db.modelPool.create.mockResolvedValue(poolRow({ maxAttachmentBytes: 2 * 1024 * 1024 }));

    await client().createModelPool({
      slug: "limited",
      name: "Limited",
      maxAttachmentBytes: 2 * 1024 * 1024,
    });
    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maxAttachmentBytes: 2 * 1024 * 1024 }),
      }),
    );

    await expect(
      client().createModelPool({
        slug: "too-large",
        name: "Too large",
        maxAttachmentBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
  });

  it("allows a direct model attachment limit to inherit and rejects one above global policy", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.discoveredModel.update.mockResolvedValue({ id: "model-id", maxAttachmentBytes: null });

    await expect(
      client().updateDiscoveredModelAttachmentLimit({ id: "model-id", maxAttachmentBytes: null }),
    ).resolves.toEqual({ id: "model-id", maxAttachmentBytes: null });

    await expect(
      client().updateDiscoveredModelAttachmentLimit({
        id: "model-id",
        maxAttachmentBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
  });

  it("accepts dotted model pool slugs on create and update", async () => {
    db.modelPool.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "pool-id", userId: "user-id" })
      .mockResolvedValueOnce(null);
    db.modelPool.create.mockResolvedValue(poolRow({ slug: "gpt-4.1-mini" }));
    db.modelPool.update.mockResolvedValue(poolRow({ slug: "local.mixtral" }));

    await expect(
      client().createModelPool({ slug: "gpt-4.1-mini", name: "GPT 4.1 Mini" }),
    ).resolves.toMatchObject({
      slug: "gpt-4.1-mini",
      canonicalModelId: "owner/gpt-4.1-mini",
    });
    await client().updateModelPool({ id: "pool-id", slug: "local.mixtral" });

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "gpt-4.1-mini" }),
      }),
    );
    expect(db.modelPool.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pool-id" },
        data: { slug: "local.mixtral" },
      }),
    );
  });

  it("rejects slashes in model pool slugs", async () => {
    await expect(
      client().createModelPool({ slug: "openai/gpt-4.1", name: "OpenAI" }),
    ).rejects.toThrow();
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate pool slugs within the same user namespace", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "other-pool-id" });

    await expect(
      client().createModelPool({ slug: "gpt-4.1-mini", name: "Duplicate" }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("CONFLICT");
      return true;
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("keeps direct model id parsing and non-pool slugs strict", () => {
    expect(validateForwarderSlug("gpt-4.1-mini").ok).toBe(false);
    expect(validateForwarderSlug("openai/gpt-4.1").ok).toBe(false);
    expect(parseDirectModelId("owner/gpt-4.1-mini")).toBeNull();
    expect(parseDirectModelId("owner/desk/local/gpt-4.1-mini")).toEqual({
      userSlug: "owner",
      cliSlug: "desk",
      endpointSlug: "local",
      upstreamModelId: "gpt-4.1-mini",
    });
  });

  it("manages pool members within the owner boundary", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });
    db.poolMember.findUnique.mockResolvedValue({
      id: "member-id",
      ModelPool: { userId: "user-id" },
    });
    db.poolMember.update.mockResolvedValue({
      id: "member-id",
      weight: 0,
      routingStatus: "DISABLED",
    });

    await expect(
      client().addPoolMember({
        poolId: "pool-id",
        discoveredModelId: "model-id",
        weight: 5,
      }),
    ).resolves.toEqual({ id: "member-id", executionTargetId: "target-id" });
    expect(db.poolMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        poolId: "pool-id",
        discoveredModelId: "model-id",
        executionTargetId: "target-id",
      }),
      select: { id: true },
    });
    await expect(
      client().updatePoolMember({
        id: "member-id",
        weight: 0,
        routingStatus: "DISABLED",
      }),
    ).resolves.toEqual({
      id: "member-id",
      weight: 0,
      routingStatus: "DISABLED",
    });
  });

  it("transactionally reindexes public overflow order without duplicate positions", async () => {
    db.poolMember.findUnique.mockResolvedValue({
      id: "member-b",
      poolId: "pool-id",
      tier: "PUBLIC_OVERFLOW",
      ModelPool: { userId: "user-id" },
    });
    db.poolMember.findMany.mockResolvedValue([
      { id: "member-a" },
      { id: "member-b" },
      { id: "member-c" },
    ]);
    db.poolMember.update.mockResolvedValue({});

    await expect(
      client().reorderProviderPoolMember({ id: "member-b", direction: "LATER" }),
    ).resolves.toEqual({ moved: true });
    expect(db.poolMember.update.mock.calls.map(([input]) => input)).toEqual([
      { where: { id: "member-a" }, data: { publicOrder: 0 } },
      { where: { id: "member-c" }, data: { publicOrder: 1 } },
      { where: { id: "member-b" }, data: { publicOrder: 2 } },
    ]);
  });

  it("requires an active explicit concurrency policy before attaching public overflow", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      id: "pool-id",
      publicEgressEnabled: true,
      publicEgressAcknowledged: true,
    });
    db.providerModel.findFirst.mockResolvedValue({
      id: "provider-model",
      providerAccountId: "provider-account",
      enabled: true,
    });
    db.providerBudgetPolicy.findFirst.mockResolvedValue(null);
    await expect(
      client().addProviderPoolMember({
        poolId: "pool-id",
        providerModelId: "provider-model",
        publicOrder: 0,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.executionTarget.upsert).not.toHaveBeenCalled();

    db.providerBudgetPolicy.findFirst.mockResolvedValue({
      id: "policy",
      activatedAt: new Date(),
      Rules: [{ id: "rule", mode: "UNLIMITED", limitValue: null }],
    });
    db.providerAuditEvent.findFirst.mockResolvedValue({ id: "audit" });
    db.executionTarget.upsert.mockResolvedValue({ id: "provider-target" });
    db.poolMember.create.mockResolvedValue({ id: "provider-member" });
    db.poolMember.findMany.mockResolvedValue([]);
    await expect(
      client().addProviderPoolMember({
        poolId: "pool-id",
        providerModelId: "provider-model",
        publicOrder: 0,
      }),
    ).resolves.toEqual({ id: "provider-member", executionTargetId: "provider-target" });
    expect(db.poolMember.update).toHaveBeenCalledWith({
      where: { id: "provider-member" },
      data: { publicOrder: 0 },
    });
  });

  it("makes missing and cross-owner nested pool-member ids indistinguishable", async () => {
    const expectedPoolError = { code: "NOT_FOUND", message: "Model pool not found." };
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "other-pool-id",
      userId: "other-user-id",
    });
    await expect(
      client().addPoolMember({ poolId: "missing-pool", discoveredModelId: "model-id" }),
    ).rejects.toMatchObject(expectedPoolError);
    await expect(
      client().addPoolMember({ poolId: "other-pool-id", discoveredModelId: "model-id" }),
    ).rejects.toMatchObject(expectedPoolError);

    const expectedModelError = { code: "NOT_FOUND", message: "Discovered model not found." };
    db.modelPool.findUnique
      .mockResolvedValueOnce({ id: "pool-id", userId: "user-id" })
      .mockResolvedValueOnce({ id: "pool-id", userId: "user-id" });
    db.discoveredModel.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "other-model-id",
      userId: "other-user-id",
    });
    await expect(
      client().addPoolMember({ poolId: "pool-id", discoveredModelId: "missing-model" }),
    ).rejects.toMatchObject(expectedModelError);
    await expect(
      client().addPoolMember({ poolId: "pool-id", discoveredModelId: "other-model-id" }),
    ).rejects.toMatchObject(expectedModelError);

    expect(db.executionTarget.upsert).not.toHaveBeenCalled();
    expect(db.poolMember.create).not.toHaveBeenCalled();
  });

  it("makes missing and cross-owner transformer ids indistinguishable", async () => {
    const existingPool = {
      id: "pool-id",
      userId: "user-id",
      transformerDiscoveredModelId: null,
      transformerImages: true,
      transformerAudio: false,
      transformerVideo: false,
      transformerCacheMode: "OFF",
    };
    db.modelPool.findUnique.mockResolvedValueOnce(existingPool).mockResolvedValueOnce(existingPool);
    db.discoveredModel.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "other-model-id",
      userId: "other-user-id",
      published: true,
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata: null,
      Endpoint: { published: true, capabilityMetadata: null },
    });

    const expected = { code: "NOT_FOUND", message: "Discovered model not found." };
    await expect(
      client().updateModelPool({ id: "pool-id", transformerDiscoveredModelId: "missing-model" }),
    ).rejects.toMatchObject(expected);
    await expect(
      client().updateModelPool({ id: "pool-id", transformerDiscoveredModelId: "other-model-id" }),
    ).rejects.toMatchObject(expected);
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("grants and revokes pool access by exact case-insensitive email without search", async () => {
    db.modelPool.findUnique.mockResolvedValue({
      id: "pool-id",
      userId: "user-id",
      publicEgressEnabled: false,
    });
    db.user.findFirst.mockResolvedValue({ id: "grantee-id" });
    db.poolGrant.upsert.mockResolvedValue({
      id: "grant-id",
      poolId: "pool-id",
      granteeUserId: "grantee-id",
    });
    db.poolGrant.deleteMany.mockResolvedValue({ count: 1 });

    await client().grantPoolAccessByEmail({ poolId: "pool-id", email: "Friend@Example.com" });
    await expect(
      client().revokePoolAccessByEmail({ poolId: "pool-id", email: "friend@example.com" }),
    ).resolves.toEqual({ revokedCount: 1 });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: "Friend@Example.com", mode: "insensitive" } },
      select: { id: true },
    });
    expect(JSON.stringify(db.user.findFirst.mock.calls)).not.toContain("contains");
  });

  it("requires an exact public-egress acknowledgement before creating a pool grant", async () => {
    db.modelPool.findUnique.mockResolvedValue({
      id: "pool-id",
      userId: "user-id",
      publicEgressEnabled: true,
    });

    await expect(
      client().grantPoolAccessByEmail({
        poolId: "pool-id",
        email: "friend@example.com",
        publicEgressAcknowledged: false,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.poolGrant.upsert).not.toHaveBeenCalled();
  });

  it("returns a generic not-found result for unmatched grant emails", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.user.findFirst.mockResolvedValue(null);

    await expect(
      client().grantPoolAccessByEmail({ poolId: "pool-id", email: "missing@example.com" }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("User not found.");
      return true;
    });
    expect(db.poolGrant.upsert).not.toHaveBeenCalled();
  });

  it("exposes visible model preview with canonical ids and stable internal ids", async () => {
    db.discoveredModel.findMany
      .mockResolvedValueOnce([
        {
          id: "model-id",
          userId: "user-id",
          upstreamModelId: "gpt/local",
          User: { slug: "owner" },
          Endpoint: {
            id: "endpoint-id",
            slug: "local",
            CliDevice: { slug: "desk" },
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "model-id",
          capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrideMetadata: expect.anything(),
          Endpoint: {
            capabilityMetadata: {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true, vision: true, audio: true, video: true },
            },
          },
        },
      ]);
    db.modelPool.findMany
      .mockResolvedValueOnce([
        {
          id: "pool-id",
          userId: "user-id",
          slug: "general",
          name: "General",
          description: null,
          User: { slug: "owner" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pool-id",
          transformerDiscoveredModelId: null,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
          TransformerDiscoveredModel: null,
        },
        {
          id: "grant-pool-id",
          transformerDiscoveredModelId: null,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
          TransformerDiscoveredModel: null,
        },
      ]);
    db.poolMember.findMany.mockResolvedValue([]);
    db.poolGrant.findMany.mockResolvedValue([
      {
        ModelPool: {
          id: "grant-pool-id",
          userId: "other-user-id",
          slug: "shared",
          name: "Shared",
          description: null,
          User: { slug: "friend" },
        },
      },
    ]);

    await expect(client().visibleModels()).resolves.toMatchObject({
      directModels: [
        {
          target: "DIRECT_MODEL",
          id: "model-id",
          modelId: "owner/desk/local/gpt%2Flocal",
          upstreamModelId: "gpt/local",
          ownerUserId: "user-id",
          ownerUserSlug: "owner",
          endpointId: "endpoint-id",
          endpointSlug: "local",
          cliDeviceSlug: "desk",
          attachmentModalities: { image: true, audio: true, video: true },
        },
      ],
      modelPools: [
        {
          target: "MODEL_POOL",
          id: "pool-id",
          modelId: "owner/general",
          name: "General",
          description: null,
          ownerUserId: "user-id",
          ownerUserSlug: "owner",
          poolSlug: "general",
          attachmentModalities: { image: false, audio: false, video: false },
        },
        {
          target: "MODEL_POOL",
          id: "grant-pool-id",
          modelId: "friend/shared",
          name: "Shared",
          description: null,
          ownerUserId: "other-user-id",
          ownerUserSlug: "friend",
          poolSlug: "shared",
          attachmentModalities: { image: false, audio: false, video: false },
        },
      ],
    });
  });

  it("stores a complete v2 model override without collapsing false and unknown fields", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.discoveredModel.update.mockImplementation(async ({ data }: { data: unknown }) => data);

    const capabilities = {
      version: 2 as const,
      protocol: "openai-compatible" as const,
      chatCompletions: { supported: true, audio: false },
      audio: {
        transcriptions: {
          supported: true,
          streaming: false,
          timestampGranularities: ["word", "segment"],
          diarization: true,
          languages: ["en", "es"],
          acceptedMimeTypes: ["audio/wav"],
        },
      },
    };
    await client().setDiscoveredModelCapabilityProfile({
      id: "model-id",
      mode: "override",
      capabilities,
      optimisticBasicTranscription: true,
    });

    expect(db.discoveredModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "DASHBOARD",
          capabilityOverrides: { set: ["TEXT_GENERATION", "AUDIO_INPUT"] },
          capabilityOverrideMetadata: capabilities,
          optimisticBasicTranscription: true,
        }),
      }),
    );
  });

  it("switches a model back to endpoint inheritance", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.discoveredModel.update.mockResolvedValue({ id: "model-id" });

    await client().setDiscoveredModelCapabilityProfile({
      id: "model-id",
      mode: "inherit",
      optimisticBasicTranscription: false,
    });

    expect(db.discoveredModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrideOrigin: "DASHBOARD",
          capabilityOverrides: { set: [] },
          capabilityOverrideMetadata: { kind: "DbNull" },
        }),
      }),
    );
  });

  it("reports and clears cache affinity only after verifying pool ownership", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.cacheAffinityRecord.count.mockResolvedValueOnce(7).mockResolvedValueOnce(2);
    db.cacheAffinityRecord.groupBy.mockResolvedValue([
      {
        executionTargetId: "target-id",
        _count: { _all: 7 },
        _max: { lastUsedAt: new Date("2026-08-25"), expiresAt: new Date("2026-08-26") },
      },
    ]);
    db.cacheAffinityRecord.deleteMany.mockResolvedValue({ count: 7 });

    const stats = await client().cacheAffinityStats({ poolId: "pool-id" });
    const cleared = await client().clearCacheAffinity({ poolId: "pool-id" });

    expect(stats.activeRecords).toBe(7);
    expect(stats.confirmedRecords).toBe(2);
    expect(cleared).toEqual({ deleted: 7 });
    expect(db.cacheAffinityRecord.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-id", poolId: "pool-id" },
    });
  });

  it("does not reveal or mutate another owner's affinity records", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "other-user" });
    await expect(client().cacheAffinityStats({ poolId: "pool-id" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client().clearCacheAffinity({ poolId: "pool-id" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.cacheAffinityRecord.count).not.toHaveBeenCalled();
    expect(db.cacheAffinityRecord.deleteMany).not.toHaveBeenCalled();
  });
});
