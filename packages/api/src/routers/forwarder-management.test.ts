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
import { assertPoolSlugAvailable, forwarderManagementRouter } from "./forwarder-management";

const testEnv = vi.hoisted(() => ({
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
  MODEL_API_PROTOCOL_ADAPTATION_ENABLED: true,
  MODEL_API_GLOBAL_CAPACITY_ENABLED: true,
}));

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
  env: testEnv,
  ADMIN_EMAIL: undefined,
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
  executionTarget: { findMany: MockInstance; findUnique: MockInstance; upsert: MockInstance };
  inferenceCapacity: { findMany: MockInstance; updateMany: MockInstance; upsert: MockInstance };
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
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
    testEnv.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = true;
    testEnv.MODEL_API_GLOBAL_CAPACITY_ENABLED = true;
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.executionTarget.upsert.mockResolvedValue({ id: "target-id" });
    db.executionTarget.findUnique.mockResolvedValue(null);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "provider-capacity-id" });
    db.capacityAuditEvent.create.mockResolvedValue({ id: "audit-id" });
    db.appSetting.findUnique.mockResolvedValue(null);
  });

  it("fails provider attachment closed when the deployment egress gate is disabled", async () => {
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;
    await expect(
      client().addProviderPoolMember({
        poolId: "pool-id",
        providerModelId: "provider-model",
        tier: "PRIMARY",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("denies guessed provider attachments and public-egress mutations over HTTP", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
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

  it("rejects guarded lossy collapse when protocol adaptation is disabled", async () => {
    await expect(
      client().createGuardedModelPool({
        slug: "guarded-invalid-protocol-policy",
        name: "Guarded invalid protocol policy",
        localModelIds: ["local-id"],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 1,
        memberContextCeiling: null,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        publicEgressAcknowledged: false,
        providerModels: [],
        advanced: {
          physicalCountStrategy: "ENGINE_REPORTED",
          contextMargin: 0,
          borrowPolicy: "WHEN_IDLE",
          protocolAdaptationEnabled: false,
          allowLossyDeveloperRoleCollapse: true,
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
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "LOSSY_COLLAPSE_REQUIRES_ADAPTATION" },
    });
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();
  });

  it("creates a guarded local pool without an implicit context ceiling or member override", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "existing-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "shared-capacity",
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: null },
      },
    ]);
    db.providerModel.findMany.mockResolvedValue([]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    await client().createGuardedModelPool({
      slug: "default-context",
      name: "Default context",
      localModelIds: ["local-id"],
      recommendedSurface: "OPENAI_RESPONSES",
      memberConcurrencyLimit: 1,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      providerModels: [],
      publicEgressAcknowledged: false,
    });

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ capacityContextCeiling: null, capacityContextMargin: 0 }),
      }),
    );
    expect(db.poolMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capacityContextCeilingMode: "INHERIT",
          capacityContextCeiling: null,
          capacityContextMargin: null,
        }),
      }),
    );
  });

  it("defaults cache-affinity routing on for new guarded pools while honoring an explicit opt-out", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "existing-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "shared-capacity",
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: null },
      },
    ]);
    db.providerModel.findMany.mockResolvedValue([]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    const base = {
      slug: "affinity-default",
      name: "Affinity default",
      localModelIds: ["local-id"],
      recommendedSurface: "OPENAI_RESPONSES" as const,
      memberConcurrencyLimit: 1,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      providerModels: [],
      publicEgressAcknowledged: false,
    };

    // `advanced` omitted entirely: affinity defaults ON with standard fallbacks.
    await client().createGuardedModelPool(base);
    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          affinityEnabled: true,
          affinityTtlSeconds: 3600,
          affinityMaxRecords: 10_000,
          affinityPrefixWeight: 100,
          affinityConversationWeight: 150,
          affinityConfirmedCacheWeight: 250,
          affinityLoadPenaltyWeight: 100,
        }),
      }),
    );

    // Explicit opt-out through the full advanced envelope persists false.
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    await client().createGuardedModelPool({
      ...base,
      slug: "affinity-opt-out",
      advanced: {
        physicalCountStrategy: "CONSERVATIVE_ESTIMATE",
        contextMargin: 0,
        borrowPolicy: "WHEN_IDLE",
        protocolAdaptationEnabled: false,
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
    });
    expect(db.modelPool.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ affinityEnabled: false }),
      }),
    );
  });

  it("skips a declared seed that the pending guarded-pool member policy would exceed", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([
      guardedLocalModel({
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrideMetadata: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              streaming: true,
              maxContextTokens: 8_192,
              operations: ["create"],
            },
          },
        },
      }),
    ]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "local-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "capacity-id",
        InferenceCapacity: { physicalMaxContext: null, hardConcurrencyLimit: null },
      },
    ]);
    db.providerModel.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "local-target",
            directContextCeiling: null,
            directContextMargin: null,
            PoolMembers: [],
          },
        ],
      },
    ]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    await expect(
      client().createGuardedModelPool({
        slug: "seed-guard",
        name: "Seed guard",
        localModelIds: ["local-id"],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 1,
        memberContextCeiling: 31_744,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        providerModels: [],
        publicEgressAcknowledged: false,
      }),
    ).resolves.toMatchObject({ id: "pool-id" });

    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
    expect(db.modelPool.create).toHaveBeenCalled();
  });

  it("seeds a declared context window for an unlimited pending member override", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([
      guardedLocalModel({
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrideMetadata: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              streaming: true,
              maxContextTokens: 8_192,
              operations: ["create"],
            },
          },
        },
      }),
    ]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "local-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "capacity-id",
        InferenceCapacity: { physicalMaxContext: null, hardConcurrencyLimit: null },
      },
    ]);
    db.providerModel.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "local-target",
            directContextCeiling: null,
            directContextMargin: null,
            PoolMembers: [],
          },
        ],
      },
    ]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    await expect(
      client().createGuardedModelPool({
        slug: "seed-unlimited-override",
        name: "Seed unlimited override",
        localModelIds: ["local-id"],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 1,
        memberContextCeiling: 31_744,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        providerModels: [],
        publicEgressAcknowledged: false,
        advanced: {
          physicalCountStrategy: "ENGINE_REPORTED",
          contextMargin: 0,
          borrowPolicy: "WHEN_IDLE",
          protocolAdaptationEnabled: false,
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
          memberOverrides: [
            {
              discoveredModelId: "local-id",
              concurrency: { mode: "UNLIMITED", limitValue: null },
              reservedSlots: 0,
              borrowPolicy: "WHEN_IDLE",
              waitBudget: { mode: "UNLIMITED", limitValue: null },
              contextCeiling: { mode: "UNLIMITED", limitValue: null },
              contextMargin: 0,
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ id: "pool-id" });

    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { id: "capacity-id", userId: "user-id", physicalMaxContext: null },
      data: { physicalMaxContext: 8_192 },
    });
    expect(db.modelPool.create).toHaveBeenCalled();
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
        protocolAdaptationEnabled: true,
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
        protocolAdaptationEnabled: true,
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
    expect(db.inferenceCapacity.upsert).toHaveBeenCalledTimes(2);
    expect(db.executionTarget.update).toHaveBeenCalledWith({
      where: { id: expect.stringMatching(/^provider-target-/) },
      data: { inferenceCapacityId: "provider-capacity-id" },
    });
  });

  it("creates a provider-only PRIMARY pool and derives its recommended surface", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.providerModel.findMany.mockResolvedValue([
      {
        id: "provider-primary",
        providerAccountId: "account-primary",
        upstreamModelId: "provider-upstream",
        contextWindow: 65_536,
        concurrencyLimit: 4,
        nativeCapabilities: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "provider",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
        PricingVersions: [{ id: "price-primary", currency: "USD" }],
      },
    ]);
    db.modelPool.create.mockResolvedValue({ id: "provider-only-pool" });
    db.executionTarget.upsert.mockResolvedValue({ id: "provider-primary-target" });
    db.providerBudgetPolicy.create.mockResolvedValue({ id: "provider-primary-budget" });

    await expect(
      client().createGuardedModelPool({
        slug: "provider-only",
        name: "Provider only",
        localModelIds: [],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 2,
        memberContextCeiling: 32_768,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        publicEgressAcknowledged: true,
        providerModels: [
          {
            providerModelId: "provider-primary",
            tier: "PRIMARY",
            concurrencyLimit: 2,
            dailySpendLimit: "10.00",
          },
        ],
      }),
    ).resolves.toBeDefined();

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publicEgressEnabled: false,
          publicEgressAcknowledged: true,
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
        }),
      }),
    );
    expect(db.poolMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executionTargetId: "provider-primary-target",
          tier: "PRIMARY",
          publicOrder: null,
          weight: 1,
        }),
      }),
    );
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

  it("rejects guarded setup when inherited local concurrency exceeds physical capacity", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "existing-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "capacity-id",
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 2 },
      },
    ]);

    await expect(
      client().createGuardedModelPool({
        slug: "guarded-capacity",
        name: "Guarded capacity",
        localModelIds: ["local-id"],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 3,
        memberContextCeiling: 32_768,
        reservedSlots: 1,
        localWaitBudgetMs: 30_000,
        publicEgressAcknowledged: false,
        providerModels: [],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  const guardedCreateBase = {
    slug: "guarded-reasons",
    name: "Guarded reasons",
    localModelIds: ["local-id"],
    recommendedSurface: "OPENAI_RESPONSES" as const,
    memberConcurrencyLimit: 1,
    memberContextCeiling: null,
    reservedSlots: 0,
    localWaitBudgetMs: 30_000,
    publicEgressAcknowledged: false,
    providerModels: [] as Array<Record<string, unknown>>,
  };

  it("reports the egress-gate failure reason for guarded pool create", async () => {
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        publicEgressAcknowledged: true,
        providerModels: [
          { providerModelId: "provider-id", concurrencyLimit: 1, dailySpendLimit: "10.00" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { reason: "PROVIDER_EGRESS_DISABLED" },
    });
  });

  it("reports the slug-taken failure reason for guarded pool create", async () => {
    db.modelPool.findUnique.mockResolvedValue(poolRow());

    await expect(client().createGuardedModelPool(guardedCreateBase)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "SLUG_TAKEN" },
    });
  });

  it("reports the provider-not-ready failure reason for guarded pool create", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.providerModel.findMany.mockResolvedValue([]);

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        publicEgressAcknowledged: true,
        providerModels: [
          { providerModelId: "provider-id", concurrencyLimit: 1, dailySpendLimit: "10.00" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "PROVIDER_NOT_READY" },
    });
  });

  it("reports the surface-mismatch failure reason for guarded pool create", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel({}, "chat")]);

    await expect(client().createGuardedModelPool(guardedCreateBase)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "SURFACE_NOT_SUPPORTED" },
    });
  });

  it("reports the local-capacity-required failure reason for guarded pool create", async () => {
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

    await expect(client().createGuardedModelPool(guardedCreateBase)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "LOCAL_CAPACITY_REQUIRED" },
    });
  });

  it("reports the concurrency-physical failure reason for guarded pool create", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "existing-target",
        discoveredModelId: "local-id",
        inferenceCapacityId: "capacity-id",
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 2 },
      },
    ]);

    await expect(
      client().createGuardedModelPool({ ...guardedCreateBase, memberConcurrencyLimit: 3 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CONCURRENCY_EXCEEDS_PHYSICAL" },
    });
  });

  const guardedAdvancedBase = (overrides: Record<string, unknown> = {}) => ({
    physicalCountStrategy: "CONSERVATIVE_ESTIMATE",
    contextMargin: 0,
    borrowPolicy: "WHEN_IDLE",
    protocolAdaptationEnabled: false,
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
    memberOverrides: [] as Array<Record<string, unknown>>,
    ...overrides,
  });

  const guardedMemberOverride = (overrides: Record<string, unknown> = {}) => ({
    discoveredModelId: "local-id",
    concurrency: { mode: "LIMITED", limitValue: 1 },
    reservedSlots: 0,
    borrowPolicy: "WHEN_IDLE",
    waitBudget: { mode: "LIMITED", limitValue: 30_000 },
    contextCeiling: { mode: "INHERIT", limitValue: null },
    contextMargin: 0,
    ...overrides,
  });

  const guardedLocalTarget = (
    capacity: { physicalMaxContext?: number; hardConcurrencyLimit?: number } = {},
  ) => ({
    id: "existing-target",
    discoveredModelId: "local-id",
    inferenceCapacityId: "capacity-id",
    InferenceCapacity: {
      physicalMaxContext: capacity.physicalMaxContext ?? 65_536,
      hardConcurrencyLimit: capacity.hardConcurrencyLimit ?? 2,
    },
  });

  function mockGuardedLocalSetup(capacity?: {
    physicalMaxContext?: number;
    hardConcurrencyLimit?: number;
  }) {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel()]);
    db.executionTarget.findMany.mockResolvedValue([guardedLocalTarget(capacity)]);
  }

  it("reports the pool-policy-invalid failure reason for guarded pool create", async () => {
    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        memberContextCeiling: 8_192,
        advanced: guardedAdvancedBase({ contextMargin: 8_192 }),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "POOL_POLICY_INVALID" },
    });
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();
  });

  it("rejects guarded create slugs at input validation before the slug helper", async () => {
    // The SLUG_INVALID reason branch in assertPoolSlugAvailable is defensively
    // unreachable through the typed contract: poolSlugSchema runs the same
    // validateForwarderPoolSlug check during input parsing, so an invalid slug
    // must fail before the handler runs. Pin that structural bound: the
    // rejection carries the oRPC input-parse envelope (zod issues on slug),
    // not the handler's SLUG_INVALID reason envelope.
    let inputError: ORPCError | undefined;
    await client()
      .createGuardedModelPool({ ...guardedCreateBase, slug: "Invalid Slug!" })
      .catch((error: ORPCError) => {
        inputError = error;
      });
    expect(inputError).toBeInstanceOf(ORPCError);
    expect(inputError?.code).toBe("BAD_REQUEST");
    expect(inputError?.message).toBe("Input validation failed");
    const data = inputError?.data as
      | { issues?: Array<{ message?: string; path?: string[] }>; reason?: unknown }
      | undefined;
    expect(data?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "forwarderSlug.format", path: ["slug"] }),
      ]),
    );
    expect(data?.reason).toBeUndefined();
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();
  });

  it("reports the local-model-unavailable failure reason for guarded pool create", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);

    await expect(client().createGuardedModelPool(guardedCreateBase)).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { reason: "LOCAL_MODEL_UNAVAILABLE" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("reports the member-override-mismatch failure reason for guarded pool create", async () => {
    mockGuardedLocalSetup();

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        advanced: guardedAdvancedBase({
          memberOverrides: [guardedMemberOverride({ discoveredModelId: "other-model" })],
        }),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "MEMBER_OVERRIDE_MISMATCH" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("reports the reserved-exceeds-concurrency failure reason for guarded pool create", async () => {
    mockGuardedLocalSetup({ hardConcurrencyLimit: 20 });

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        memberConcurrencyLimit: 10,
        advanced: guardedAdvancedBase({
          memberOverrides: [
            guardedMemberOverride({
              concurrency: { mode: "LIMITED", limitValue: 2 },
              reservedSlots: 3,
            }),
          ],
        }),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "RESERVED_EXCEEDS_CONCURRENCY" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("reports the reserved-exceeds-physical failure reason for guarded pool create", async () => {
    mockGuardedLocalSetup({ hardConcurrencyLimit: 2 });

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        advanced: guardedAdvancedBase({
          memberOverrides: [
            guardedMemberOverride({
              concurrency: { mode: "UNLIMITED", limitValue: null },
              reservedSlots: 3,
            }),
          ],
        }),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "RESERVED_EXCEEDS_PHYSICAL" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("reports the context-exceeds-physical failure reason for guarded pool create", async () => {
    mockGuardedLocalSetup({ physicalMaxContext: 65_536 });

    await expect(
      client().createGuardedModelPool({ ...guardedCreateBase, memberContextCeiling: 70_000 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CONTEXT_EXCEEDS_PHYSICAL" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("reports the context-margin-exceeds-ceiling failure reason for guarded pool create", async () => {
    mockGuardedLocalSetup({ physicalMaxContext: 65_536, hardConcurrencyLimit: 2 });

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        advanced: guardedAdvancedBase({
          memberOverrides: [
            guardedMemberOverride({
              contextCeiling: { mode: "LIMITED", limitValue: 100 },
              contextMargin: 100,
            }),
          ],
        }),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CONTEXT_MARGIN_EXCEEDS_CEILING" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("reports the provider-context-exceeded failure reason for guarded pool create", async () => {
    mockGuardedLocalSetup({ physicalMaxContext: 65_536, hardConcurrencyLimit: 2 });
    db.providerModel.findMany.mockResolvedValue([
      {
        id: "provider-primary",
        providerAccountId: "account-primary",
        upstreamModelId: "provider-upstream",
        contextWindow: 8_192,
        concurrencyLimit: 4,
        nativeCapabilities: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "provider",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
        PricingVersions: [{ id: "price-primary", currency: "USD" }],
      },
    ]);

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        memberContextCeiling: 16_384,
        publicEgressAcknowledged: true,
        providerModels: [
          {
            providerModelId: "provider-primary",
            tier: "PRIMARY",
            concurrencyLimit: 1,
            dailySpendLimit: "10.00",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "PROVIDER_CONTEXT_EXCEEDED" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it.each([
    ["OPENAI_RESPONSES", "a surface a chat-native primary cannot serve without adaptation"],
    ["OPENAI_COMPLETIONS", "a surface no primary can ever serve"],
  ] as const)("rejects %s as %s", async (recommendedSurface) => {
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
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "SURFACE_NOT_SUPPORTED" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("accepts a valid-but-not-top-ranked recommended API across mixed primary members", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([
      guardedLocalModel(),
      guardedLocalModel({ id: "local-id-2", upstreamModelId: "local-model-2" }, "chat"),
    ]);
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "target-1",
        discoveredModelId: "local-id",
        inferenceCapacityId: "capacity-1",
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: null },
      },
      {
        id: "target-2",
        discoveredModelId: "local-id-2",
        inferenceCapacityId: "capacity-2",
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: null },
      },
    ]);
    db.providerModel.findMany.mockResolvedValue([]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    // The mixed responses/chat primary set ranks OPENAI_RESPONSES first, but
    // every member can serve OPENAI_CHAT_COMPLETIONS (natively or adapted),
    // so the operator's non-top-ranked choice must be accepted and stored.
    await client().createGuardedModelPool({
      slug: "guarded-ranked-choice",
      name: "Guarded ranked choice",
      localModelIds: ["local-id", "local-id-2"],
      recommendedSurface: "OPENAI_CHAT_COMPLETIONS",
      memberConcurrencyLimit: 1,
      memberContextCeiling: null,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      publicEgressAcknowledged: false,
      providerModels: [],
      advanced: guardedAdvancedBase({ protocolAdaptationEnabled: true }),
    });

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS" }),
      }),
    );
  });

  it("rejects the recommended API when a primary member cannot serve it natively or via adaptation", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([
      guardedLocalModel(),
      guardedLocalModel({ id: "local-id-2", upstreamModelId: "local-model-2" }, "chat"),
    ]);

    // Without adaptation the chat-native member cannot serve OPENAI_RESPONSES.
    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        slug: "guarded-unservable",
        name: "Guarded unservable",
        localModelIds: ["local-id", "local-id-2"],
        recommendedSurface: "OPENAI_RESPONSES",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "SURFACE_NOT_SUPPORTED" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("ignores the pool adaptation flag when the deployment adaptation gate is disabled", async () => {
    // The pool opts into adaptation, but the deployment gate is off: an
    // adapted-only surface for the selection must still be rejected, while a
    // natively-served surface stays acceptable under the same env.
    testEnv.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = false;
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel({}, "chat")]);

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        advanced: guardedAdvancedBase({ protocolAdaptationEnabled: true }),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "SURFACE_NOT_SUPPORTED" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("accepts a natively-served recommended API while the deployment adaptation gate is disabled", async () => {
    testEnv.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = false;
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel({}, "chat")]);
    db.executionTarget.findMany.mockResolvedValue([guardedLocalTarget()]);
    db.providerModel.findMany.mockResolvedValue([]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    // The chat-native member serves OPENAI_CHAT_COMPLETIONS natively, so the
    // disabled adaptation gate must not block the create even though the pool
    // payload carries protocolAdaptationEnabled: true.
    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        recommendedSurface: "OPENAI_CHAT_COMPLETIONS",
        advanced: guardedAdvancedBase({ protocolAdaptationEnabled: true }),
      }),
    ).resolves.toBeDefined();
    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS" }),
      }),
    );
  });

  it("rejects the recommended API when a PRIMARY provider cannot serve it natively or via adaptation", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.providerModel.findMany.mockResolvedValue([
      {
        id: "provider-primary",
        providerAccountId: "account-primary",
        upstreamModelId: "provider-upstream",
        contextWindow: 65_536,
        concurrencyLimit: 4,
        nativeCapabilities: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "provider",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
        PricingVersions: [{ id: "price-primary", currency: "USD" }],
      },
    ]);

    // The chat-native PRIMARY provider cannot serve OPENAI_RESPONSES without
    // adaptation; the surface fence must hold for provider members too, not
    // just locals.
    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
        slug: "guarded-provider-unservable",
        name: "Guarded provider unservable",
        localModelIds: [],
        publicEgressAcknowledged: true,
        providerModels: [
          {
            providerModelId: "provider-primary",
            tier: "PRIMARY",
            concurrencyLimit: 1,
            dailySpendLimit: "10.00",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "SURFACE_NOT_SUPPORTED" },
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
    expect(db.executionTarget.upsert).not.toHaveBeenCalled();
  });

  it("accepts any recommended API when the pool has no primary members", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.providerModel.findMany.mockResolvedValue([
      {
        id: "provider-overflow",
        providerAccountId: "account-id",
        upstreamModelId: "provider-upstream",
        contextWindow: 8_192,
        concurrencyLimit: 4,
        nativeCapabilities: null,
        PricingVersions: [{ id: "price-id", currency: "USD" }],
      },
    ]);
    db.executionTarget.upsert.mockResolvedValue({
      id: "provider-target",
      providerModelId: "provider-overflow",
      inferenceCapacityId: null,
    });
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "provider-capacity" });
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });
    db.providerBudgetPolicy.create.mockResolvedValue({ id: "budget-id" });

    // A PUBLIC_OVERFLOW-only pool has an empty primary matrix: even
    // OPENAI_COMPLETIONS (never adaptable) is accepted as the override.
    await client().createGuardedModelPool({
      slug: "guarded-overflow-only",
      name: "Guarded overflow only",
      localModelIds: [],
      recommendedSurface: "OPENAI_COMPLETIONS",
      memberConcurrencyLimit: 1,
      memberContextCeiling: null,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      publicEgressAcknowledged: true,
      providerModels: [
        {
          providerModelId: "provider-overflow",
          tier: "PUBLIC_OVERFLOW",
          concurrencyLimit: 1,
          dailySpendLimit: "10.00",
        },
      ],
    });

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recommendedSurfaceOverride: "OPENAI_COMPLETIONS" }),
      }),
    );
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
                ExecutionTarget: null,
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
    expect(result[0]?.endpoints[0]?.models[0]?.executionTarget).toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("endpoint-secret");

    const findManySelect = db.cliDevice.findMany.mock.calls[0]?.[0]?.select;
    expect(
      findManySelect?.Endpoints?.select?.DiscoveredModels?.select?.ExecutionTarget,
    ).toBeDefined();
    expect(findManySelect?.Endpoints?.select?.DiscoveredModels?.select).not.toHaveProperty(
      "ExecutionTargets",
    );
  });

  it("lists execution targets on discovered models when present", async () => {
    const executionTarget = {
      id: "target-id",
      inferenceCapacityId: "capacity-id",
      directPriority: 0,
      directConcurrencyLimit: 2,
      directReservedSlots: 1,
      directBorrowPolicy: "ALLOW",
      directWaitBudgetMs: 5000,
      directContextCeiling: 8192,
      directContextMargin: 256,
    };
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
        User: { slug: "owner" },
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
            capabilityMetadata: null,
            probeSuggestions: null,
            lastSeenAt: new Date("2026-01-01T00:00:30Z"),
            lastHealthCheckAt: null,
            statusChangedAt: null,
            failureReasonCode: null,
            DiscoveredModels: [
              {
                id: "model-id",
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-02"),
                slug: null,
                upstreamModelId: "llama",
                encodedModelId: "owner/desk/local/llama",
                capabilityOverrideMode: "INHERIT",
                capabilityOverrides: [],
                capabilityOverrideMetadata: null,
                optimisticBasicTranscription: false,
                probeSuggestions: null,
                lastSeenAt: new Date("2026-01-01T00:00:30Z"),
                published: true,
                unpublishedAt: null,
                maxAttachmentBytes: null,
                ExecutionTarget: executionTarget,
              },
            ],
          },
        ],
      },
    ]);

    const result = await client().listCliDevices();

    expect(result[0]?.endpoints[0]?.models[0]?.executionTarget).toEqual(executionTarget);
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
    db.modelPool.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(
        poolRow({ userId: "user-id", publicEgressEnabled: false, publicEgressAcknowledged: false }),
      );
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

  it("defaults cache-affinity routing on for legacy creates while honoring an explicit opt-out", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.modelPool.create.mockResolvedValue(poolRow());

    // Affinity input omitted: defaults ON with the shared fallback tuple.
    await client().createModelPool({ slug: "affinity-default", name: "Affinity default" });
    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          affinityEnabled: true,
          affinityTtlSeconds: 3600,
          affinityMaxRecords: 10_000,
          affinityPrefixWeight: 100,
          affinityConversationWeight: 150,
          affinityConfirmedCacheWeight: 250,
          affinityLoadPenaltyWeight: 100,
        }),
      }),
    );

    // Explicit opt-out persists false.
    await client().createModelPool({
      slug: "affinity-opt-out",
      name: "Affinity opt out",
      affinityEnabled: false,
    });
    expect(db.modelPool.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ affinityEnabled: false }),
      }),
    );
  });

  it("rejects lossy collapse without adaptation and resolves partial updates from the stored pool", async () => {
    await expect(
      client().createModelPool({
        slug: "invalid-protocol-policy",
        name: "Invalid protocol policy",
        protocolAdaptationEnabled: false,
        allowLossyDeveloperRoleCollapse: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.create).not.toHaveBeenCalled();

    db.modelPool.findUnique.mockResolvedValue(
      poolRow({
        userId: "user-id",
        publicEgressEnabled: false,
        publicEgressAcknowledged: false,
        protocolAdaptationEnabled: false,
        allowLossyDeveloperRoleCollapse: false,
      }),
    );
    await expect(
      client().updateModelPool({ id: "pool-id", allowLossyDeveloperRoleCollapse: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();

    db.modelPool.findUnique.mockResolvedValue(
      poolRow({
        userId: "user-id",
        publicEgressEnabled: false,
        publicEgressAcknowledged: false,
        protocolAdaptationEnabled: true,
        allowLossyDeveloperRoleCollapse: false,
      }),
    );
    db.modelPool.update.mockResolvedValue(
      poolRow({ protocolAdaptationEnabled: true, allowLossyDeveloperRoleCollapse: true }),
    );
    await expect(
      client().updateModelPool({ id: "pool-id", allowLossyDeveloperRoleCollapse: true }),
    ).resolves.toMatchObject({ allowLossyDeveloperRoleCollapse: true });
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

  it("only applies the capacity deployment gate when a pool capacity field is supplied", async () => {
    testEnv.MODEL_API_GLOBAL_CAPACITY_ENABLED = false;
    const existing = poolRow({ id: "pool-id", userId: "user-id" });
    db.modelPool.findUnique.mockResolvedValue(existing);
    db.modelPool.update.mockResolvedValue(existing);

    await expect(
      client().updateModelPool({ id: "pool-id", name: "Renamed" }),
    ).resolves.toMatchObject({
      id: "pool-id",
    });
    await expect(
      client().updateModelPool({ id: "pool-id", capacityPriority: 17 }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Capacity management is disabled for this deployment.",
    });
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

  it("persists identical transformer settings through pool create and update", async () => {
    const transformer = {
      id: "transformer-id",
      userId: "user-id",
      published: true,
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata: null,
      Endpoint: {
        published: true,
        capabilityMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, vision: true, audio: false, video: false },
        },
      },
    };
    const input = {
      transformerDiscoveredModelId: "transformer-id",
      transformerSystemPrompt: "Describe the image.",
      transformerImages: true,
      transformerAudio: false,
      transformerVideo: false,
      transformerCacheMode: "MEMORY" as const,
      transformerIncludePrimaryTools: true,
      transformerMaxTools: 8,
      transformerMaxToolChars: 1024,
      transformerTimeoutMs: 30_000,
      transformerMaxAssets: 4,
    };
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findUnique.mockResolvedValue(transformer);
    db.modelPool.create.mockResolvedValue(poolRow());

    await client().createModelPool({ slug: "general", name: "General", ...input });
    const createData = db.modelPool.create.mock.calls[0]?.[0].data;

    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ id: "pool-id", userId: "user-id", ...input }),
    );
    db.modelPool.update.mockResolvedValue(poolRow());
    await client().updateModelPool({ id: "pool-id", ...input });
    const updateData = db.modelPool.update.mock.calls[0]?.[0].data;

    for (const [key, value] of Object.entries(input)) {
      expect(createData).toHaveProperty(key, value);
      expect(updateData).toHaveProperty(key, value);
    }
  });

  it("rejects a cross-owner transformer model when creating a pool", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.discoveredModel.findUnique.mockResolvedValue({
      id: "other-transformer",
      userId: "other-user-id",
      published: true,
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata: null,
      Endpoint: { published: true, capabilityMetadata: null },
    });

    await expect(
      client().createModelPool({
        slug: "general",
        name: "General",
        transformerDiscoveredModelId: "other-transformer",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Discovered model not found." });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "reserved slots above the limit",
      { capacityConcurrencyLimit: 2, capacityReservedSlots: 3 },
      "Reserved slots exceed the pool concurrency limit.",
    ],
    [
      "a context margin equal to the ceiling",
      { capacityContextCeiling: 100, capacityContextMargin: 100 },
      "Pool context margin must be smaller than the context ceiling.",
    ],
    [
      "a context ceiling plus margin above physical capacity",
      { capacityContextCeiling: 90, capacityContextMargin: 20 },
      "Effective context policy exceeds physical capacity.",
    ],
  ])("enforces pool capacity policy invariants for %s", async (_name, policy, message) => {
    db.modelPool.findUnique.mockResolvedValue({
      id: "pool-id",
      userId: "user-id",
      transformerDiscoveredModelId: null,
      transformerImages: true,
      transformerAudio: false,
      transformerVideo: false,
      publicEgressEnabled: false,
      publicEgressAcknowledged: false,
      protocolAdaptationEnabled: false,
      allowLossyDeveloperRoleCollapse: false,
      capacityConcurrencyLimit: 2,
      capacityReservedSlots: 0,
      capacityContextCeiling: 80,
      capacityContextMargin: 0,
      PoolMembers: [
        {
          executionTargetId: "target-id",
          capacityConcurrencyMode: "INHERIT",
          capacityConcurrencyLimit: null,
          capacityReservedSlots: null,
          capacityContextCeilingMode: "INHERIT",
          capacityContextCeiling: null,
          capacityContextMargin: null,
          ExecutionTarget: {
            InferenceCapacity: { hardConcurrencyLimit: 4, physicalMaxContext: 100 },
          },
        },
      ],
    });

    await expect(client().updateModelPool({ id: "pool-id", ...policy })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message,
    });
    expect(db.modelPool.update).not.toHaveBeenCalled();
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

  it("uses the deployment protocol gate for compatibility serialization", async () => {
    testEnv.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = false;
    db.modelPool.findMany.mockResolvedValue([
      poolRow({
        protocolAdaptationEnabled: true,
        allowLossyDeveloperRoleCollapse: true,
        PoolMembers: [
          {
            id: "member-id",
            tier: "PRIMARY",
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
    ]);

    const [result] = await client().listModelPools();

    expect(result?.protocolAdaptationAvailable).toBe(false);
    expect(result?.compatibility.surfaces.OPENAI_RESPONSES).toMatchObject({
      adapted: 0,
      unavailable: 1,
    });
    expect(result?.compatibility.warnings).not.toContain("developer_role_collapse_lossy");
  });

  it("rejects legacy Completions as a recommended pool API", async () => {
    await expect(
      client().createModelPool({
        slug: "legacy-completions",
        name: "Legacy Completions",
        // @ts-expect-error OPENAI_COMPLETIONS is a native protocol, not a pool recommendation.
        recommendedSurfaceOverride: "OPENAI_COMPLETIONS",
      }),
    ).rejects.toThrow();
    await expect(
      client().updateModelPool({
        id: "pool-id",
        // @ts-expect-error OPENAI_COMPLETIONS is a native protocol, not a pool recommendation.
        recommendedSurfaceOverride: "OPENAI_COMPLETIONS",
      }),
    ).rejects.toThrow();

    expect(db.modelPool.create).not.toHaveBeenCalled();
    expect(db.modelPool.update).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(
        poolRow({ userId: "user-id", publicEgressEnabled: false, publicEgressAcknowledged: false }),
      )
      .mockResolvedValueOnce(
        poolRow({ userId: "user-id", publicEgressEnabled: false, publicEgressAcknowledged: false }),
      );
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

  it("keeps sibling pool create and update slug errors free of reason data", async () => {
    // createModelPool and updateModelPool share assertPoolSlugAvailable with
    // guarded create but omit reasons; their error envelope must stay exactly
    // as before, with no `data` field attached.
    let createError: ORPCError | undefined;
    db.modelPool.findUnique.mockResolvedValueOnce({ id: "other-pool-id" });
    await client()
      .createModelPool({ slug: "gpt-4.1-mini", name: "Duplicate" })
      .catch((error: ORPCError) => {
        createError = error;
      });
    expect(createError).toBeInstanceOf(ORPCError);
    expect(createError?.code).toBe("CONFLICT");
    expect(createError?.data).toBeUndefined();

    let updateError: ORPCError | undefined;
    db.modelPool.findUnique
      .mockResolvedValueOnce({ id: "pool-id", userId: "user-id" })
      .mockResolvedValueOnce({ id: "other-pool-id" });
    await client()
      .updateModelPool({ id: "pool-id", slug: "gpt-4.1-mini" })
      .catch((error: ORPCError) => {
        updateError = error;
      });
    expect(updateError).toBeInstanceOf(ORPCError);
    expect(updateError?.code).toBe("CONFLICT");
    expect(updateError?.data).toBeUndefined();
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("attaches slug reasons only when the caller opts in", async () => {
    // SLUG_INVALID is unreachable through createGuardedModelPool (input zod
    // runs the same slug check first), so the branch is pinned here directly:
    // opt-in reasons attach data.reason per branch; omitted reasons keep the
    // pre-reason envelope with no data field at all.
    const reasons = { invalid: "SLUG_INVALID", taken: "SLUG_TAKEN" } as const;

    await expect(
      assertPoolSlugAvailable("Invalid Slug!", "user-id", undefined, reasons),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "SLUG_INVALID" } });
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();

    let invalidError: ORPCError | undefined;
    await assertPoolSlugAvailable("Invalid Slug!", "user-id").catch((error: ORPCError) => {
      invalidError = error;
    });
    expect(invalidError).toBeInstanceOf(ORPCError);
    expect(invalidError?.code).toBe("BAD_REQUEST");
    expect(invalidError?.data).toBeUndefined();
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();

    db.modelPool.findUnique.mockResolvedValueOnce({ id: "other-pool-id" });
    await expect(
      assertPoolSlugAvailable("gpt-4.1-mini", "user-id", undefined, reasons),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "SLUG_TAKEN" } });

    db.modelPool.findUnique.mockResolvedValueOnce({ id: "other-pool-id" });
    let takenError: ORPCError | undefined;
    await assertPoolSlugAvailable("gpt-4.1-mini", "user-id").catch((error: ORPCError) => {
      takenError = error;
    });
    expect(takenError).toBeInstanceOf(ORPCError);
    expect(takenError?.code).toBe("CONFLICT");
    expect(takenError?.data).toBeUndefined();
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
    db.modelPool.findFirst.mockResolvedValue({
      capacityConcurrencyLimit: null,
      capacityReservedSlots: 0,
    });
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

  it("uses a fresh-null seed result when the pending inherited member would exceed", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.modelPool.findFirst.mockResolvedValue({
      capacityConcurrencyLimit: null,
      capacityReservedSlots: 0,
      capacityContextCeiling: 31_744,
      capacityContextMargin: 1_024,
    });
    db.discoveredModel.findUnique.mockResolvedValue({
      id: "model-id",
      userId: "user-id",
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata: null,
      Endpoint: {
        capabilityMetadata: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "declared",
              confidence: "exact",
              streaming: true,
              maxContextTokens: 8_192,
              operations: ["create"],
            },
          },
        },
      },
    });
    db.executionTarget.upsert.mockResolvedValue({
      id: "target-id",
      inferenceCapacityId: "capacity-id",
      InferenceCapacity: { hardConcurrencyLimit: null, physicalMaxContext: null },
    });
    db.executionTarget.findMany.mockResolvedValue([{ id: "target-id" }]);
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "target-id",
            directContextCeiling: null,
            directContextMargin: 0,
            PoolMembers: [],
          },
        ],
      },
    ]);
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    await expect(
      client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" }),
    ).resolves.toMatchObject({ id: "member-id" });

    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
    expect(db.poolMember.create).toHaveBeenCalled();
  });

  it("seeds a default-topology member capacity from its declared context window", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.modelPool.findFirst.mockResolvedValue({
      capacityConcurrencyLimit: null,
      capacityReservedSlots: 0,
      capacityContextCeiling: null,
      capacityContextMargin: 0,
    });
    db.discoveredModel.findUnique.mockResolvedValue({
      id: "model-id",
      userId: "user-id",
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata: null,
      Endpoint: {
        capabilityMetadata: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "declared",
              confidence: "exact",
              streaming: true,
              maxContextTokens: 128_000,
              operations: ["create"],
            },
          },
        },
      },
    });
    db.executionTarget.upsert.mockResolvedValue({
      id: "target-id",
      inferenceCapacityId: "capacity-id",
      InferenceCapacity: { hardConcurrencyLimit: null, physicalMaxContext: null },
    });
    db.executionTarget.findMany.mockResolvedValue([{ id: "target-id" }]);
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "target-id",
            directContextCeiling: null,
            directContextMargin: null,
            PoolMembers: [],
          },
        ],
      },
    ]);
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    await client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" });

    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { id: "capacity-id", userId: "user-id", physicalMaxContext: null },
      data: { physicalMaxContext: 128_000 },
    });
  });

  it("maps duplicate local pool members to CONFLICT without swallowing other errors", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.modelPool.findFirst.mockResolvedValue({
      capacityConcurrencyLimit: null,
      capacityReservedSlots: 0,
    });
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    const duplicate = Object.assign(new Error("unique"), { code: "P2002" });
    db.poolMember.create.mockRejectedValueOnce(duplicate);

    await expect(
      client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "That model is already a member of this pool.",
    });

    const other = Object.assign(new Error("database unavailable"), { code: "P1001" });
    db.poolMember.create.mockRejectedValueOnce(other);
    await expect(
      client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" }),
    ).rejects.toBe(other);
  });

  it("rejects attaching a local target when inherited pool capacity exceeds its hard limit", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.executionTarget.upsert.mockResolvedValue({
      id: "target-id",
      InferenceCapacity: { hardConcurrencyLimit: 2 },
    });
    db.modelPool.findFirst.mockResolvedValue({
      capacityConcurrencyLimit: 3,
      capacityReservedSlots: 0,
    });

    await expect(
      client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.poolMember.create).not.toHaveBeenCalled();
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

  it("transactionally validates and updates provider primary routing and capacity policy", async () => {
    db.poolMember.findUnique
      .mockResolvedValueOnce({
        id: "provider-primary-member",
        poolId: "pool-id",
        ModelPool: { userId: "user-id" },
      })
      .mockResolvedValueOnce({
        id: "provider-primary-member",
        poolId: "pool-id",
        tier: "PRIMARY",
        publicOrder: null,
        weight: 1,
        routingStatus: "ACTIVE",
        capacityConcurrencyMode: "INHERIT",
        capacityConcurrencyLimit: null,
        capacityReservedSlots: null,
        capacityContextCeilingMode: "INHERIT",
        capacityContextCeiling: null,
        capacityContextMargin: null,
        ExecutionTarget: {
          ProviderModel: { id: "provider-model", providerAccountId: "provider-account" },
          InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 8 },
        },
        ModelPool: {
          userId: "user-id",
          publicEgressEnabled: false,
          publicEgressAcknowledged: true,
          capacityConcurrencyLimit: 6,
          capacityReservedSlots: 1,
        },
      });
    db.poolMember.findMany.mockResolvedValue([]);
    db.poolMember.update.mockResolvedValue({
      id: "provider-primary-member",
      weight: 5,
      routingStatus: "ACTIVE",
      tier: "PRIMARY",
      publicOrder: null,
    });

    await expect(
      client().updatePoolMember({
        id: "provider-primary-member",
        weight: 5,
        capacityPriority: 24,
        capacityConcurrencyMode: "LIMITED",
        capacityConcurrencyLimit: 4,
        capacityReservedSlots: 2,
        capacityBorrowPolicy: "NEVER",
        capacityWaitBudgetMode: "LIMITED",
        capacityWaitBudgetMs: 15_000,
        capacityContextCeilingMode: "LIMITED",
        capacityContextCeiling: 32_768,
        capacityContextMargin: 1_024,
      }),
    ).resolves.toMatchObject({ id: "provider-primary-member", weight: 5, tier: "PRIMARY" });

    expect(db.poolMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "provider-primary-member" },
        data: expect.objectContaining({
          weight: 5,
          capacityPriority: 24,
          capacityConcurrencyMode: "LIMITED",
          capacityConcurrencyLimit: 4,
          capacityReservedSlots: 2,
          capacityBorrowPolicy: "NEVER",
          capacityWaitBudgetMode: "LIMITED",
          capacityWaitBudgetMs: 15_000,
          capacityContextCeilingMode: "LIMITED",
          capacityContextCeiling: 32_768,
          capacityContextMargin: 1_024,
        }),
      }),
    );
  });

  it("rejects finite and inherited member policies above physical concurrency", async () => {
    const member = (mode: "INHERIT" | "LIMITED" | "UNLIMITED") => ({
      id: "member-id",
      poolId: "pool-id",
      tier: "PRIMARY",
      publicOrder: null,
      weight: 1,
      routingStatus: "ACTIVE",
      capacityConcurrencyMode: mode,
      capacityConcurrencyLimit: mode === "LIMITED" ? 2 : null,
      capacityReservedSlots: null,
      capacityContextCeilingMode: "INHERIT",
      capacityContextCeiling: null,
      capacityContextMargin: null,
      ExecutionTarget: {
        ProviderModel: { id: "provider-model", providerAccountId: "provider-account" },
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 4 },
      },
      ModelPool: {
        userId: "user-id",
        publicEgressEnabled: false,
        publicEgressAcknowledged: true,
        capacityConcurrencyLimit: 6,
        capacityReservedSlots: 1,
      },
    });
    db.poolMember.findUnique
      .mockResolvedValueOnce({
        id: "member-id",
        poolId: "pool-id",
        ModelPool: { userId: "user-id" },
      })
      .mockResolvedValueOnce(member("INHERIT"));
    await expect(client().updatePoolMember({ id: "member-id", weight: 2 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    db.poolMember.findUnique
      .mockResolvedValueOnce({
        id: "member-id",
        poolId: "pool-id",
        ModelPool: { userId: "user-id" },
      })
      .mockResolvedValueOnce(member("LIMITED"));
    await expect(
      client().updatePoolMember({
        id: "member-id",
        capacityConcurrencyMode: "LIMITED",
        capacityConcurrencyLimit: 5,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.poolMember.update).not.toHaveBeenCalled();
  });

  it("allows unlimited member policy while enforcing its reservation against physical capacity", async () => {
    const base = {
      id: "member-id",
      poolId: "pool-id",
      tier: "PRIMARY",
      publicOrder: null,
      weight: 1,
      routingStatus: "ACTIVE",
      capacityConcurrencyMode: "INHERIT",
      capacityConcurrencyLimit: null,
      capacityReservedSlots: null,
      capacityContextCeilingMode: "INHERIT",
      capacityContextCeiling: null,
      capacityContextMargin: null,
      ExecutionTarget: {
        ProviderModel: { id: "provider-model", providerAccountId: "provider-account" },
        InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 4 },
      },
      ModelPool: {
        userId: "user-id",
        publicEgressEnabled: false,
        publicEgressAcknowledged: true,
        capacityConcurrencyLimit: 8,
        capacityReservedSlots: 0,
      },
    };
    db.poolMember.findUnique
      .mockResolvedValueOnce({
        id: "member-id",
        poolId: "pool-id",
        ModelPool: { userId: "user-id" },
      })
      .mockResolvedValueOnce(base);
    db.poolMember.findMany.mockResolvedValue([]);
    db.poolMember.update.mockResolvedValue({
      id: "member-id",
      weight: 1,
      routingStatus: "ACTIVE",
      tier: "PRIMARY",
      publicOrder: null,
    });
    await expect(
      client().updatePoolMember({
        id: "member-id",
        capacityConcurrencyMode: "UNLIMITED",
        capacityReservedSlots: 4,
      }),
    ).resolves.toMatchObject({ id: "member-id" });
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

  it("rejects attaching a provider primary when inherited pool capacity exceeds its hard limit", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      id: "pool-id",
      publicEgressEnabled: false,
      publicEgressAcknowledged: true,
      capacityConcurrencyLimit: 5,
      capacityReservedSlots: 1,
    });
    db.providerModel.findFirst.mockResolvedValue({
      id: "provider-model",
      providerAccountId: "provider-account",
      concurrencyLimit: 4,
      enabled: true,
    });

    await expect(
      client().addProviderPoolMember({
        poolId: "pool-id",
        providerModelId: "provider-model",
        tier: "PRIMARY",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.providerBudgetPolicy.findFirst).not.toHaveBeenCalled();
    expect(db.poolMember.create).not.toHaveBeenCalled();
  });

  it("attaches a provider PRIMARY without enabling public overflow", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      id: "private-pool",
      publicEgressEnabled: false,
      publicEgressAcknowledged: true,
    });
    db.providerModel.findFirst.mockResolvedValue({
      id: "provider-model",
      providerAccountId: "provider-account",
      enabled: true,
    });
    db.providerBudgetPolicy.findFirst.mockResolvedValue({
      id: "policy",
      activatedAt: new Date(),
      Rules: [{ id: "rule", mode: "LIMITED", limitValue: 2 }],
    });
    db.providerAuditEvent.findFirst.mockResolvedValue({ id: "audit" });
    db.executionTarget.upsert.mockResolvedValue({ id: "provider-target" });
    db.poolMember.create.mockResolvedValue({ id: "primary-provider-member" });
    // The PRIMARY surface fence reads the existing members; the pool has none,
    // so the attachment stays valid and no overflow reorder write happens.
    db.poolMember.findMany.mockResolvedValue([]);

    await expect(
      client().addProviderPoolMember({
        poolId: "private-pool",
        providerModelId: "provider-model",
        tier: "PRIMARY",
        weight: 7,
      }),
    ).resolves.toEqual({
      id: "primary-provider-member",
      executionTargetId: "provider-target",
    });
    expect(db.poolMember.create).toHaveBeenCalledWith({
      data: {
        poolId: "private-pool",
        executionTargetId: "provider-target",
        tier: "PRIMARY",
        publicOrder: null,
        weight: 7,
      },
      select: { id: true },
    });
    expect(db.poolMember.update).not.toHaveBeenCalled();
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

  it("requires provider-egress acknowledgement for provider PRIMARY grants", async () => {
    db.modelPool.findUnique.mockResolvedValue({
      id: "pool-id",
      userId: "user-id",
      publicEgressEnabled: false,
    });
    db.poolMember.findFirst.mockResolvedValue({ id: "provider-primary-member" });

    await expect(
      client().grantPoolAccessByEmail({
        poolId: "pool-id",
        email: "friend@example.com",
        publicEgressAcknowledged: false,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.poolMember.findFirst).toHaveBeenCalledWith({
      where: {
        poolId: "pool-id",
        tier: "PRIMARY",
        ExecutionTarget: { ProviderModel: { isNot: null } },
      },
      select: { id: true },
    });
    expect(db.poolGrant.upsert).not.toHaveBeenCalled();
  });

  it("returns a generic not-found result for unmatched grant emails", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.poolMember.findFirst.mockResolvedValue(null);
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
      ])
      .mockResolvedValueOnce([
        {
          id: "model-id",
          capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrideMetadata: null,
          Endpoint: {
            capabilityMetadata: {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true },
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
          reasoning: { OPENAI_CHAT_COMPLETIONS: { supported: false, levelsUnknown: false } },
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
          reasoning: {},
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
          reasoning: {},
        },
      ],
    });
  });

  it("preserves v4 reasoningConfig when a dashboard vision toggle updates capabilities", async () => {
    const capabilities = {
      version: 4 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiChatCompletions: {
          source: "declared" as const,
          confidence: "exact" as const,
          operations: ["create"] as const,
          reasoning: true,
          reasoningConfig: {
            supportedLevels: ["low", "high"] as const,
            defaultLevel: "high" as const,
            encoding: { kind: "openai_reasoning_effort" as const },
          },
        },
      },
    };
    db.discoveredModel.findUnique.mockResolvedValue({
      id: "model-id",
      userId: "user-id",
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: capabilities,
      capabilityOverrides: ["TEXT_GENERATION"],
      Endpoint: { capabilityMetadata: null, defaultCapabilities: [] },
    });
    db.discoveredModel.update.mockImplementation(async ({ data }: { data: unknown }) => data);

    await client().updateDiscoveredModelCapabilities({
      id: "model-id",
      vision: true,
      audio: false,
      video: false,
    });

    expect(db.discoveredModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilityOverrideMetadata: expect.objectContaining({
            surfaces: expect.objectContaining({
              openaiChatCompletions: expect.objectContaining({
                inputImages: true,
                reasoningConfig: capabilities.surfaces.openaiChatCompletions.reasoningConfig,
              }),
            }),
          }),
        }),
      }),
    );
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

  describe("update-path recommended-surface revalidation", () => {
    const chatNativeCapabilities = {
      version: 3,
      protocol: "openai-compatible",
      surfaces: {
        openaiChatCompletions: {
          source: "provider",
          confidence: "exact",
          supported: true,
          streaming: true,
        },
      },
    };
    const responsesNativeCapabilities = {
      version: 3,
      protocol: "openai-compatible",
      surfaces: {
        openaiResponses: {
          source: "provider",
          confidence: "exact",
          supported: true,
          streaming: true,
        },
      },
    };

    function surfaceMemberRow(
      id: string,
      native: "chat" | "responses",
      tier: "PRIMARY" | "PUBLIC_OVERFLOW" = "PRIMARY",
    ) {
      return {
        id,
        tier,
        discoveredModelId: null,
        DiscoveredModel: null,
        ExecutionTarget: {
          DiscoveredModel: guardedLocalModel({}, native),
          ProviderModel: null,
        },
      };
    }

    function surfacePoolRow(overrides: Record<string, unknown> = {}) {
      return poolRow({
        userId: "user-id",
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
        ...overrides,
      });
    }

    it("keeps unrelated updates non-retroactive on a legacy-invalid stored override", async () => {
      const stored = surfacePoolRow();
      db.modelPool.findUnique.mockResolvedValue(stored);
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "chat")]);
      db.modelPool.update.mockResolvedValue(surfacePoolRow({ name: "Renamed" }));

      // The stored override is already unservable, but a rename touches no
      // selectability input and must keep succeeding.
      await expect(
        client().updateModelPool({ id: "pool-id", name: "Renamed" }),
      ).resolves.toMatchObject({ id: "pool-id" });
      expect(db.modelPool.update).toHaveBeenCalledTimes(1);
    });

    it("rejects re-setting an unservable override with the create-path envelope", async () => {
      db.modelPool.findUnique.mockResolvedValue(surfacePoolRow());
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "chat")]);

      await expect(
        client().updateModelPool({ id: "pool-id", recommendedSurfaceOverride: "OPENAI_RESPONSES" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message:
          "Every selected primary member must serve the recommended API natively or via protocol adaptation.",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.modelPool.update).not.toHaveBeenCalled();
    });

    it("accepts an input-touching update when the post-state serves the override", async () => {
      db.modelPool.findUnique.mockResolvedValue(surfacePoolRow());
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "responses")]);
      db.modelPool.update.mockResolvedValue(surfacePoolRow());

      await expect(
        client().updateModelPool({
          id: "pool-id",
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
        }),
      ).resolves.toMatchObject({ id: "pool-id" });
      expect(db.modelPool.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recommendedSurfaceOverride: "OPENAI_RESPONSES" }),
        }),
      );
    });

    it("repairs a stored unservable override with a servable input override", async () => {
      // Stored state is invalid (responses override, chat-only primary). The
      // update sends a servable chat override: the gate must validate the
      // INPUT override, not the stored one, so the repair succeeds and
      // persists the new value.
      db.modelPool.findUnique.mockResolvedValue(surfacePoolRow());
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "chat")]);
      db.modelPool.update.mockResolvedValue(
        surfacePoolRow({ recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS" }),
      );

      await expect(
        client().updateModelPool({
          id: "pool-id",
          recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS",
        }),
      ).resolves.toMatchObject({ id: "pool-id" });
      expect(db.modelPool.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS" }),
        }),
      );
    });

    it("resolves legacy provider inventories identically across the gate and the dashboard display", async () => {
      const legacyProviderNative = { surfaces: ["openai-chat"], streaming: true };
      const legacyProviderSurfaceRow = {
        id: "provider-member",
        tier: "PRIMARY",
        discoveredModelId: null,
        DiscoveredModel: null,
        ExecutionTarget: {
          DiscoveredModel: null,
          ProviderModel: { nativeCapabilities: legacyProviderNative },
        },
      };

      // Gated update path: the loader resolves the legacy inventory through
      // the shared provider-capability path, so the chat override (which
      // serializePool renders as natively available) must be accepted.
      db.modelPool.findUnique.mockResolvedValue(surfacePoolRow());
      db.poolMember.findMany.mockResolvedValue([legacyProviderSurfaceRow]);
      db.modelPool.update.mockResolvedValue(
        surfacePoolRow({ recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS" }),
      );
      await expect(
        client().updateModelPool({
          id: "pool-id",
          recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS",
        }),
      ).resolves.toMatchObject({ id: "pool-id" });
      expect(db.modelPool.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS" }),
        }),
      );

      // Dashboard display: the same legacy inventory serializes as a
      // chat-native provider member, consistent with the accepted gate.
      db.modelPool.findMany.mockResolvedValue([
        poolRow({
          recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS",
          PoolMembers: [
            {
              id: "provider-member",
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
              discoveredModelId: null,
              tier: "PRIMARY",
              publicOrder: null,
              weight: 1,
              healthStatus: "HEALTHY",
              routingStatus: "ACTIVE",
              lastFailureClass: null,
              consecutiveRetryableFailures: 0,
              lastFailureAt: null,
              nextRetryAt: null,
              halfOpenTrialStartedAt: null,
              ExecutionTarget: {
                id: "provider-target",
                kind: "PROVIDER_MODEL",
                inferenceCapacityId: "provider-capacity",
                DiscoveredModel: null,
                ProviderModel: {
                  id: "provider-model",
                  upstreamModelId: "provider/model",
                  displayName: "Provider Model",
                  nativeCapabilities: legacyProviderNative,
                  contextWindow: 65_536,
                  concurrencyLimit: 4,
                  healthStatus: "HEALTHY",
                  enabled: true,
                  PricingVersions: [],
                  ProviderAccount: {
                    id: "provider-account",
                    label: "Account",
                    providerType: "OPENAI",
                    enabled: true,
                  },
                },
              },
              DiscoveredModel: null,
            },
          ],
        }),
      ]);
      const [pool] = await client().listModelPools();
      expect(pool?.compatibility.surfaces.OPENAI_CHAT_COMPLETIONS).toMatchObject({
        native: 1,
        unavailable: 0,
      });
      expect(pool?.members[0]?.providerModel?.surfaces.OPENAI_CHAT_COMPLETIONS).toMatchObject({
        mode: "native",
        streaming: true,
      });
      expect(pool?.compatibility.recommendedSurface).toBe("OPENAI_CHAT_COMPLETIONS");
    });

    it("rejects disabling adaptation when the override only stays servable through it", async () => {
      // Stored state is valid: adaptation on lets the chat-native member serve
      // the responses override. Turning the flag off strands the surface.
      db.modelPool.findUnique.mockResolvedValue(
        surfacePoolRow({ protocolAdaptationEnabled: true }),
      );
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "chat")]);

      await expect(
        client().updateModelPool({ id: "pool-id", protocolAdaptationEnabled: false }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.modelPool.update).not.toHaveBeenCalled();

      // Keeping adaptation on touches the same input but leaves a servable
      // post-state, so it must succeed.
      db.modelPool.update.mockResolvedValue(surfacePoolRow({ protocolAdaptationEnabled: true }));
      await expect(
        client().updateModelPool({ id: "pool-id", protocolAdaptationEnabled: true }),
      ).resolves.toMatchObject({ id: "pool-id" });
      expect(db.modelPool.update).toHaveBeenCalledTimes(1);
    });

    it("ignores the pool adaptation flag on update when the deployment gate is disabled", async () => {
      testEnv.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = false;
      db.modelPool.findUnique.mockResolvedValue(
        surfacePoolRow({ protocolAdaptationEnabled: true }),
      );
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "chat")]);

      // The pool flag stays on, but the deployment gate is off: the
      // adaptation-only override must still be rejected on revalidation.
      await expect(
        client().updateModelPool({ id: "pool-id", recommendedSurfaceOverride: "OPENAI_RESPONSES" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.modelPool.update).not.toHaveBeenCalled();
    });

    it("accepts any override on update for a pool with no primary members", async () => {
      db.modelPool.findUnique.mockResolvedValue(surfacePoolRow());
      db.poolMember.findMany.mockResolvedValue([
        surfaceMemberRow("overflow-a", "chat", "PUBLIC_OVERFLOW"),
      ]);
      db.modelPool.update.mockResolvedValue(surfacePoolRow());

      await expect(
        client().updateModelPool({
          id: "pool-id",
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
        }),
      ).resolves.toMatchObject({ id: "pool-id" });
      expect(db.modelPool.update).toHaveBeenCalledTimes(1);
    });

    it("rejects attaching a local primary that cannot serve the stored override", async () => {
      db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
      db.modelPool.findFirst.mockResolvedValue({
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityContextCeiling: null,
        capacityContextMargin: 0,
      });
      db.discoveredModel.findUnique.mockResolvedValue(
        guardedLocalModel({ id: "model-id", userId: "user-id" }, "chat"),
      );
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "responses")]);

      await expect(
        client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.executionTarget.upsert).not.toHaveBeenCalled();
      expect(db.poolMember.create).not.toHaveBeenCalled();
    });

    it("accepts attaching a local primary that serves the stored override", async () => {
      db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
      db.modelPool.findFirst.mockResolvedValue({
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityContextCeiling: null,
        capacityContextMargin: 0,
      });
      db.discoveredModel.findUnique.mockResolvedValue(
        guardedLocalModel({ id: "model-id", userId: "user-id" }, "responses"),
      );
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "responses")]);
      db.poolMember.create.mockResolvedValue({ id: "member-id" });

      await expect(
        client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" }),
      ).resolves.toMatchObject({ id: "member-id" });
      expect(db.poolMember.create).toHaveBeenCalledTimes(1);
    });

    it("rejects a provider primary attach that cannot serve the stored override", async () => {
      db.modelPool.findFirst.mockResolvedValue({
        id: "pool-id",
        publicEgressEnabled: false,
        publicEgressAcknowledged: true,
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityContextCeiling: null,
        capacityContextMargin: 0,
      });
      db.providerModel.findFirst.mockResolvedValue({
        id: "provider-model",
        providerAccountId: "provider-account",
        contextWindow: 8_192,
        concurrencyLimit: 4,
        nativeCapabilities: chatNativeCapabilities,
        enabled: true,
      });
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "responses")]);

      await expect(
        client().addProviderPoolMember({
          poolId: "pool-id",
          providerModelId: "provider-model",
          tier: "PRIMARY",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.executionTarget.upsert).not.toHaveBeenCalled();
      expect(db.poolMember.create).not.toHaveBeenCalled();
    });

    it("skips the surface fence for provider overflow attaches", async () => {
      db.modelPool.findFirst.mockResolvedValue({
        id: "pool-id",
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityContextCeiling: null,
        capacityContextMargin: 0,
      });
      db.providerModel.findFirst.mockResolvedValue({
        id: "provider-model",
        providerAccountId: "provider-account",
        contextWindow: 8_192,
        concurrencyLimit: 4,
        nativeCapabilities: chatNativeCapabilities,
        enabled: true,
      });
      db.providerBudgetPolicy.findFirst.mockResolvedValue({
        id: "policy",
        activatedAt: new Date(),
        Rules: [{ id: "rule", mode: "UNLIMITED", limitValue: null }],
      });
      db.providerAuditEvent.findFirst.mockResolvedValue({ id: "audit" });
      db.executionTarget.upsert.mockResolvedValue({ id: "provider-target" });
      db.poolMember.create.mockResolvedValue({ id: "member-id" });
      // Overflow attaches never change the primary set. Pin the skip with a
      // real unservable primary post-state: the chat-native primary cannot
      // serve the stored responses override, so an always-on fence (or a fence
      // that wrongly included overflow tiers) would reject this attach.
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("primary-a", "chat")]);

      await expect(
        client().addProviderPoolMember({
          poolId: "pool-id",
          providerModelId: "provider-model",
          publicOrder: 0,
        }),
      ).resolves.toMatchObject({ id: "member-id" });
      expect(db.poolMember.create).toHaveBeenCalledTimes(1);
    });

    it("rejects demoting the only primary serving the stored override", async () => {
      const memberModelPool = {
        userId: "user-id",
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityContextCeiling: null,
        capacityContextMargin: 0,
      };
      db.poolMember.findUnique
        .mockResolvedValueOnce({
          id: "member-id",
          poolId: "pool-id",
          executionTargetId: "target-id",
          ModelPool: { userId: "user-id" },
        })
        .mockResolvedValueOnce({
          id: "member-id",
          poolId: "pool-id",
          tier: "PRIMARY",
          publicOrder: null,
          weight: 1,
          routingStatus: "ACTIVE",
          capacityConcurrencyMode: "INHERIT",
          capacityConcurrencyLimit: null,
          capacityReservedSlots: null,
          capacityContextCeilingMode: "INHERIT",
          capacityContextCeiling: null,
          capacityContextMargin: null,
          ExecutionTarget: {
            ProviderModel: {
              id: "provider-model",
              providerAccountId: "provider-account",
              nativeCapabilities: responsesNativeCapabilities,
            },
            InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 4 },
          },
          ModelPool: memberModelPool,
        });
      db.providerBudgetPolicy.findFirst.mockResolvedValue({
        id: "policy",
        activatedAt: new Date(),
        Rules: [{ id: "rule", mode: "UNLIMITED", limitValue: null }],
      });
      db.providerAuditEvent.findFirst.mockResolvedValue({ id: "audit" });
      // The exclusion-free member set includes the transitioning member
      // (member-id, responses-native). The in-place re-tag demotes it, so the
      // remaining primary is chat-native and cannot serve the responses
      // override once member-id leaves the primary tier.
      db.poolMember.findMany.mockResolvedValue([
        surfaceMemberRow("member-id", "responses"),
        surfaceMemberRow("member-a", "chat"),
      ]);

      await expect(
        client().updatePoolMember({ id: "member-id", tier: "PUBLIC_OVERFLOW", publicOrder: 0 }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.poolMember.update).not.toHaveBeenCalled();
      expect(db.poolMember.updateMany).not.toHaveBeenCalled();
    });

    it("rejects promoting an overflow member that strands the stored override", async () => {
      const memberModelPool = {
        userId: "user-id",
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityContextCeiling: null,
        capacityContextMargin: 0,
      };
      db.poolMember.findUnique
        .mockResolvedValueOnce({
          id: "member-id",
          poolId: "pool-id",
          executionTargetId: "target-id",
          ModelPool: { userId: "user-id" },
        })
        .mockResolvedValueOnce({
          id: "member-id",
          poolId: "pool-id",
          tier: "PUBLIC_OVERFLOW",
          publicOrder: 0,
          weight: 1,
          routingStatus: "ACTIVE",
          capacityConcurrencyMode: "INHERIT",
          capacityConcurrencyLimit: null,
          capacityReservedSlots: null,
          capacityContextCeilingMode: "INHERIT",
          capacityContextCeiling: null,
          capacityContextMargin: null,
          ExecutionTarget: {
            ProviderModel: {
              id: "provider-model",
              providerAccountId: "provider-account",
              nativeCapabilities: chatNativeCapabilities,
            },
            InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 4 },
          },
          ModelPool: memberModelPool,
        });
      // The promotion re-tags member-id (chat-native) to PRIMARY in place:
      // the post-state primaries include a member that cannot serve the
      // responses override, so the promotion must be fenced.
      db.poolMember.findMany.mockResolvedValue([
        surfaceMemberRow("member-id", "chat", "PUBLIC_OVERFLOW"),
        surfaceMemberRow("member-a", "responses"),
      ]);

      await expect(
        client().updatePoolMember({ id: "member-id", tier: "PRIMARY" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.poolMember.update).not.toHaveBeenCalled();
      expect(db.poolMember.updateMany).not.toHaveBeenCalled();
    });

    it("accepts a tier transition that keeps the override servable", async () => {
      db.poolMember.findUnique
        .mockResolvedValueOnce({
          id: "member-id",
          poolId: "pool-id",
          executionTargetId: "target-id",
          ModelPool: { userId: "user-id" },
        })
        .mockResolvedValueOnce({
          id: "member-id",
          poolId: "pool-id",
          tier: "PRIMARY",
          publicOrder: null,
          weight: 1,
          routingStatus: "ACTIVE",
          capacityConcurrencyMode: "INHERIT",
          capacityConcurrencyLimit: null,
          capacityReservedSlots: null,
          capacityContextCeilingMode: "INHERIT",
          capacityContextCeiling: null,
          capacityContextMargin: null,
          ExecutionTarget: {
            ProviderModel: {
              id: "provider-model",
              providerAccountId: "provider-account",
              nativeCapabilities: chatNativeCapabilities,
            },
            InferenceCapacity: { physicalMaxContext: 65_536, hardConcurrencyLimit: 4 },
          },
          ModelPool: {
            userId: "user-id",
            publicEgressEnabled: true,
            publicEgressAcknowledged: true,
            recommendedSurfaceOverride: "OPENAI_RESPONSES",
            protocolAdaptationEnabled: true,
            capacityConcurrencyLimit: null,
            capacityReservedSlots: 0,
            capacityContextCeiling: null,
            capacityContextMargin: 0,
          },
        });
      db.providerBudgetPolicy.findFirst.mockResolvedValue({
        id: "policy",
        activatedAt: new Date(),
        Rules: [{ id: "rule", mode: "UNLIMITED", limitValue: null }],
      });
      db.providerAuditEvent.findFirst.mockResolvedValue({ id: "audit" });
      // Demoting the chat-only member leaves a responses-native primary that
      // serves the override natively, so the transition must proceed.
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "responses")]);
      db.poolMember.update.mockResolvedValue({
        id: "member-id",
        weight: 0,
        routingStatus: "ACTIVE",
        tier: "PUBLIC_OVERFLOW",
        publicOrder: null,
      });

      await expect(
        client().updatePoolMember({ id: "member-id", tier: "PUBLIC_OVERFLOW", publicOrder: 0 }),
      ).resolves.toMatchObject({ id: "member-id", tier: "PUBLIC_OVERFLOW" });
      expect(db.poolMember.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "member-id" },
          data: expect.objectContaining({ tier: "PUBLIC_OVERFLOW" }),
        }),
      );
    });

    it("rejects detaching the primary that serves the stored override", async () => {
      db.poolMember.findUnique.mockResolvedValue({
        id: "member-a",
        poolId: "pool-id",
        tier: "PRIMARY",
        ModelPool: {
          userId: "user-id",
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
          protocolAdaptationEnabled: false,
        },
      });
      // Only the detached member serves the override; the survivor cannot.
      // (The mock models the exclusion query: members other than member-a.)
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-b", "chat")]);

      await expect(client().removePoolMember({ id: "member-a" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.poolMember.delete).not.toHaveBeenCalled();
    });

    it("accepts detaching a primary when the survivors serve the override", async () => {
      db.poolMember.findUnique.mockResolvedValue({
        id: "member-a",
        poolId: "pool-id",
        tier: "PRIMARY",
        ModelPool: {
          userId: "user-id",
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
          protocolAdaptationEnabled: false,
        },
      });
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-b", "responses")]);

      await expect(client().removePoolMember({ id: "member-a" })).resolves.toEqual({
        deleted: true,
      });
      expect(db.poolMember.delete).toHaveBeenCalledWith({
        where: { id: "member-a" },
      });
      expect(db.poolMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { poolId: "pool-id", id: { not: "member-a" } } }),
      );
    });

    it("accepts detaching the last primary, leaving an empty primary set", async () => {
      db.poolMember.findUnique.mockResolvedValue({
        id: "member-a",
        poolId: "pool-id",
        tier: "PRIMARY",
        ModelPool: {
          userId: "user-id",
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
          protocolAdaptationEnabled: false,
        },
      });
      // The surviving overflow member cannot serve the override, but an empty
      // primary set accepts any surface (create-path parity).
      db.poolMember.findMany.mockResolvedValue([
        surfaceMemberRow("overflow-b", "chat", "PUBLIC_OVERFLOW"),
      ]);

      await expect(client().removePoolMember({ id: "member-a" })).resolves.toEqual({
        deleted: true,
      });
      expect(db.poolMember.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("capability-edit impact advisory (non-blocking)", () => {
    function impactMemberRow(
      id: string,
      poolId: string,
      native: "chat" | "responses",
      tier: "PRIMARY" | "PUBLIC_OVERFLOW" = "PRIMARY",
    ) {
      return {
        id,
        poolId,
        tier,
        discoveredModelId: null,
        DiscoveredModel: null,
        ExecutionTarget: { DiscoveredModel: guardedLocalModel({}, native), ProviderModel: null },
      };
    }

    /**
     * The impact helper issues two member queries: a poolId lookup for the
     * affected pools (no `where.poolId`) and the post-edit surface-member load
     * (`where.poolId.in`). Dispatch on that.
     */
    function mockImpactQueries(options: {
      affectedPoolIds: string[];
      memberRows: ReturnType<typeof impactMemberRow>[];
      pools: Array<Record<string, unknown>>;
    }) {
      db.poolMember.findMany.mockImplementation(
        async ({ where }: { where?: { poolId?: { in?: string[] } } } = {}) =>
          where?.poolId
            ? options.memberRows.filter((row) => where.poolId?.in?.includes(row.poolId))
            : options.affectedPoolIds.map((poolId) => ({ poolId })),
      );
      db.modelPool.findMany.mockResolvedValue(options.pools);
    }

    const impactPools = [
      {
        id: "pool-a",
        slug: "alpha",
        userId: "user-id",
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        protocolAdaptationEnabled: false,
      },
      {
        id: "pool-b",
        slug: "beta",
        userId: "user-id",
        recommendedSurfaceOverride: null,
        protocolAdaptationEnabled: false,
      },
    ];

    it("updateDiscoveredModelCapabilities succeeds and reports only the unservable pool", async () => {
      db.discoveredModel.findUnique.mockResolvedValue({
        id: "model-id",
        userId: "user-id",
        capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
        capabilityOverrideMetadata: null,
        capabilityOverrides: [],
        Endpoint: { capabilityMetadata: null, defaultCapabilities: [] },
      });
      db.discoveredModel.update.mockImplementation(async ({ data }) => data);
      // Post-edit: pool-a's only primary is chat-only under a responses
      // override (unservable); pool-b suggests from its chat primary.
      mockImpactQueries({
        affectedPoolIds: ["pool-a", "pool-b"],
        memberRows: [
          impactMemberRow("m-a", "pool-a", "chat"),
          impactMemberRow("m-b", "pool-b", "chat"),
        ],
        pools: impactPools,
      });

      const result = await client().updateDiscoveredModelCapabilities({
        id: "model-id",
        vision: true,
        audio: false,
        video: false,
      });
      // The edit itself succeeded (non-blocking) and the advisory is exact.
      expect(db.discoveredModel.update).toHaveBeenCalledTimes(1);
      expect(result.impactedPools).toEqual([
        { id: "pool-a", slug: "alpha", surface: "OPENAI_RESPONSES" },
      ]);
    });

    it("updateDiscoveredModelCapabilities reports impacted pools on the v4 metadata branch", async () => {
      db.discoveredModel.findUnique.mockResolvedValue({
        id: "model-id",
        userId: "user-id",
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrideMetadata: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "dashboard",
              confidence: "exact",
              streaming: true,
              operations: ["create"],
            },
          },
        },
        capabilityOverrides: [],
        Endpoint: { capabilityMetadata: null, defaultCapabilities: [] },
      });
      db.discoveredModel.update.mockImplementation(async ({ data }) => data);
      mockImpactQueries({
        affectedPoolIds: ["pool-a"],
        memberRows: [impactMemberRow("m-a", "pool-a", "chat")],
        pools: [impactPools[0]],
      });

      const result = await client().updateDiscoveredModelCapabilities({
        id: "model-id",
        vision: true,
        audio: false,
        video: false,
      });
      // The v4 branch preserved the structured surface and flipped the media
      // input flags, and the advisory still reports the unservable pool.
      expect(result.capabilityOverrideMetadata).toMatchObject({
        version: 4,
        surfaces: {
          openaiChatCompletions: { inputImages: true, inputAudio: false, inputVideo: false },
        },
      });
      expect(result.impactedPools).toEqual([
        { id: "pool-a", slug: "alpha", surface: "OPENAI_RESPONSES" },
      ]);
    });

    it("setDiscoveredModelCapabilityProfile returns an empty advisory when nothing is impacted", async () => {
      db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
      db.discoveredModel.update.mockImplementation(async ({ data }) => data);
      mockImpactQueries({
        affectedPoolIds: ["pool-b"],
        memberRows: [impactMemberRow("m-b", "pool-b", "chat")],
        pools: [impactPools[1]],
      });

      const result = await client().setDiscoveredModelCapabilityProfile({
        id: "model-id",
        mode: "override",
        capabilities: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: { source: "dashboard", confidence: "exact", supported: true },
          },
        },
        optimisticBasicTranscription: false,
      });
      expect(result.impactedPools).toEqual([]);
    });

    it("removeDiscoveredModelMetadata computes the post-deletion surface after capturing affected pools", async () => {
      db.discoveredModel.findUnique.mockResolvedValue({
        id: "model-id",
        userId: "user-id",
        lastSeenAt: null,
      });
      db.discoveredModel.delete.mockResolvedValue({ id: "model-id" });
      // The responses-native member cascades away with the deleted model, so
      // the post-deletion primary set of pool-a is chat-only under a stored
      // responses override: unservable.
      mockImpactQueries({
        affectedPoolIds: ["pool-a"],
        memberRows: [impactMemberRow("m-a", "pool-a", "chat")],
        pools: [impactPools[0]],
      });

      await expect(client().removeDiscoveredModelMetadata({ id: "model-id" })).resolves.toEqual({
        deleted: true,
        impactedPools: [{ id: "pool-a", slug: "alpha", surface: "OPENAI_RESPONSES" }],
      });
      expect(db.discoveredModel.delete).toHaveBeenCalledWith({ where: { id: "model-id" } });
    });
  });
});
