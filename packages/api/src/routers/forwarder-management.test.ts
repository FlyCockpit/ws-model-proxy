import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildContext,
  client,
  db,
  fenceCalls,
  firstRowLockOrder,
  forwarderManagementRouter,
  guardedLocalModel,
  httpClient,
  isFenceCall,
  lastFenceOrder,
  poolRow,
  prisma,
  sqlOf,
  testEnv,
} from "./forwarder-test-helpers";

describe("forwarderManagementRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.poolMember.count.mockResolvedValue(0);
    db.poolGrant.findMany.mockResolvedValue([]);
    db.poolGrant.findFirst.mockResolvedValue(null);
    db.$queryRaw.mockResolvedValue([]);
    db.executionTarget.upsert.mockResolvedValue({ id: "target-id" });
    db.executionTarget.findUnique.mockResolvedValue(null);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "provider-capacity-id" });
    db.capacityAuditEvent.create.mockResolvedValue({ id: "audit-id" });
    db.appSetting.findUnique.mockResolvedValue(null);
  });
  it("denies guessed provider attachments and public-egress mutations over HTTP", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.modelPool.findFirst.mockResolvedValue(null);
    db.poolMember.findUnique.mockResolvedValue(null);
    db.providerModel.findFirst.mockResolvedValue(null);
    // A foreign CLI device matches no owner-scoped row.
    db.cliDevice.updateMany.mockResolvedValue({ count: 0 });
    const captures: Array<{ status: number; body: string }> = [];
    const rpc = httpClient(captures);
    const attempts = [
      rpc.updateModelPool({
        id: "foreign-pool",
        fallbackEnabled: true,
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

  it("rejects guarded provider primaries or a non-positive spend cap before any write", async () => {
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
    // Provider models are external fallback members only (plain pool names
    // never leave the deployment); no grant-time acknowledgement exists.
    await expect(
      client().createGuardedModelPool({
        ...base,
        providerModels: [
          {
            providerModelId: "provider-id",
            tier: "PRIMARY",
            concurrencyLimit: 1,
            dailySpendLimit: "10.00",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client().createGuardedModelPool({
        ...base,
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

    await httpClient().createGuardedModelPool({
      slug: "default-context",
      name: "Default context",
      localModelIds: ["local-id"],
      recommendedSurface: "OPENAI_RESPONSES",
      memberConcurrencyLimit: 1,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      providerModels: [],
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
    };

    // `advanced` omitted entirely: affinity defaults ON with standard fallbacks.
    await client().createGuardedModelPool(base);
    // No external members: fallback stays at its schema default, which is not
    // a fallback change, so no POOL_FALLBACK_UPDATED event (G1-2).
    expect(db.providerAuditEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "POOL_FALLBACK_UPDATED" }),
      }),
    );
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
          affinityResidencyWeight: 100,
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
        fallbackEnabled: true,
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
    // Two BUDGET_CREATED events plus the fallback turn-on (issue #67).
    expect(db.providerAuditEvent.create).toHaveBeenCalledTimes(3);
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "POOL_FALLBACK_UPDATED",
        metadata: {
          source: "dashboard",
          changes: { fallbackEnabled: { before: null, after: true } },
        },
      }),
    });
    expect(db.capacityAuditEvent.create).toHaveBeenCalledTimes(1);
    expect(db.inferenceCapacity.upsert).toHaveBeenCalledTimes(2);
    expect(db.executionTarget.updateMany).toHaveBeenCalledWith({
      where: {
        id: expect.stringMatching(/^provider-target-/),
        inferenceCapacityId: null,
        capacityAssignmentSource: "AUTO",
      },
      data: { inferenceCapacityId: "provider-capacity-id", capacityAssignmentSource: "OWNER" },
    });
    // Writer class M: the owner fence, then the provider identity fences and
    // the capacity-policy fences of every existing target it changes (one
    // ascending call), then the provider account -> model rows (sorted, FOR
    // KEY SHARE), and only then the graph writes.
    expect(fenceCalls()).toEqual([
      ["00:owner:user-id"],
      [
        "02:execution-target:provider-model:provider-a",
        "02:execution-target:provider-model:provider-b",
        "06:capacity-policy:existing-target",
      ],
    ]);
    const rowLocks = (db.$queryRaw.mock.calls as unknown[][]).filter((call) => !isFenceCall(call));
    expect(rowLocks.map((call) => [sqlOf(call).match(/FROM (\w+)/)?.[1], call[1]])).toEqual([
      ["provider_account", ["account-a", "account-b"]],
      ["provider_model", ["provider-a", "provider-b"]],
    ]);
    for (const call of rowLocks) expect(sqlOf(call)).toContain("FOR KEY SHARE");
    expect(lastFenceOrder()).toBeLessThan(firstRowLockOrder());
    expect(lastFenceOrder()).toBeLessThan(
      db.modelPool.create.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(firstRowLockOrder()).toBeLessThan(
      db.executionTarget.upsert.mock.invocationCallOrder[0] ?? Number.NaN,
    );
  });

  it("creates a provider-only pool as external fallback with fallback enabled", async () => {
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
        providerModels: [
          {
            providerModelId: "provider-primary",
            tier: "PUBLIC_OVERFLOW",
            concurrencyLimit: 2,
            dailySpendLimit: "10.00",
          },
        ],
      }),
    ).resolves.toBeDefined();

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // External members exist, so the owner's fallback is on; callers
          // still opt in per request with `owner/pool:external`.
          fallbackEnabled: true,
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
        }),
      }),
    );
    expect(db.poolMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executionTargetId: "provider-primary-target",
          tier: "PUBLIC_OVERFLOW",
          publicOrder: 0,
          weight: 0,
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
    providerModels: [] as Array<Record<string, unknown>>,
  };

  it("reports the egress-gate failure reason for guarded pool create", async () => {
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;

    await expect(
      client().createGuardedModelPool({
        ...guardedCreateBase,
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

  it.each([
    ["OPENAI_RESPONSES", "a surface a chat-native primary cannot serve without adaptation"],
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

  it("accepts a natively served recommended API when the pool opts into adaptation", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(poolRow());
    db.discoveredModel.findMany.mockResolvedValue([guardedLocalModel({}, "chat")]);
    db.executionTarget.findMany.mockResolvedValue([guardedLocalTarget()]);
    db.providerModel.findMany.mockResolvedValue([]);
    db.modelPool.create.mockResolvedValue({ id: "pool-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    // The chat-native member serves OPENAI_CHAT_COMPLETIONS natively, so
    // opting the pool into adaptation must not block that surface.
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

    // A PUBLIC_OVERFLOW-only pool has an empty primary matrix, so any
    // recommended API is accepted as the override.
    await client().createGuardedModelPool({
      slug: "guarded-overflow-only",
      name: "Guarded overflow only",
      localModelIds: [],
      recommendedSurface: "ANTHROPIC_MESSAGES",
      memberConcurrencyLimit: 1,
      memberContextCeiling: null,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
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
        data: expect.objectContaining({ recommendedSurfaceOverride: "ANTHROPIC_MESSAGES" }),
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
});

describe("metric routing procedures (S-B part 2)", () => {
  const deep = prisma as unknown as {
    modelPool: { findFirst: MockInstance; updateMany: MockInstance };
    inferenceCapacity: { findFirst: MockInstance };
    capacityKvEviction: { findMany: MockInstance };
    poolMemberRoutingVerdict: { findMany: MockInstance; deleteMany: MockInstance };
    poolRoutingRule: { deleteMany: MockInstance; createMany: MockInstance };
    cliDevice: { findUnique: MockInstance; findMany: MockInstance; updateMany: MockInstance };
    nodeMetricsMinute: { findMany: MockInstance };
  };
  const source = {
    name: "fans",
    command: "sensors -j",
    intervalSecs: 10,
    timeoutSecs: 5,
    format: "json" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.$queryRaw.mockResolvedValue([]);
    deep.capacityKvEviction.findMany.mockResolvedValue([]);
    deep.nodeMetricsMinute.findMany.mockResolvedValue([]);
  });

  function client(services?: Record<string, unknown>) {
    return createRouterClient(forwarderManagementRouter, {
      context: { ...buildContext(), ...(services ? { services } : {}) },
    });
  }

  it.each([
    {
      name: "active",
      cut: 0.5,
      engineKind: "VLLM",
      reported: 100_000,
      effective: 50_000,
      placement: 50_000,
      active: true,
    },
    {
      name: "no row",
      cut: null,
      engineKind: "VLLM",
      reported: 100_000,
      effective: 100_000,
      placement: 100_000,
      active: false,
    },
    {
      name: "recovered",
      cut: 0,
      engineKind: "VLLM",
      reported: 100_000,
      effective: 100_000,
      placement: 100_000,
      active: false,
    },
    {
      name: "llama slot",
      cut: 0.5,
      engineKind: "LLAMA_CPP",
      reported: 100_000,
      effective: null,
      placement: null,
      active: false,
    },
    {
      name: "unknown budget slot",
      cut: 0.5,
      engineKind: "VLLM",
      reported: null,
      effective: null,
      placement: null,
      active: false,
    },
    {
      name: "read failure",
      cut: null,
      engineKind: "VLLM",
      reported: 100_000,
      effective: 100_000,
      placement: 100_000,
      active: false,
      fail: true,
    },
    {
      name: "protection off hides a live cut",
      cut: 0.5,
      engineKind: "VLLM",
      reported: 100_000,
      effective: 100_000,
      placement: 50_000,
      active: false,
      protectionEnabled: false,
    },
  ])(
    "KV budget visibility: $name",
    async ({
      cut,
      engineKind,
      reported,
      effective,
      placement,
      active,
      fail,
      protectionEnabled = true,
    }) => {
      vi.useFakeTimers();
      const now = new Date("2026-09-30T12:00:00Z");
      vi.setSystemTime(now);
      try {
        deep.modelPool.findFirst.mockResolvedValue({
          id: "pool-1",
          slug: "coder",
          PoolRoutingRules: [],
          protectionEnabled,
          PoolMembers: [
            {
              id: "m1",
              engineLoadMode: "AUTO",
              kvFullThreshold: null,
              ExecutionTarget: {
                InferenceCapacity: {
                  id: "cap-1",
                  engineKind,
                  engineSlots: 4,
                  kvBudgetTokens: reported,
                  kvBudgetTokensSource: "CONFIG",
                },
                DiscoveredModel: {
                  slug: "qwen",
                  upstreamModelId: "qwen",
                  Endpoint: { slug: "gpu", cliDeviceId: "cli-1", CliDevice: { name: "GPU" } },
                },
              },
            },
          ],
        });
        deep.poolMemberRoutingVerdict.findMany.mockResolvedValue([]);
        deep.cliDevice.findMany.mockResolvedValue([]);
        const expiresAt = new Date(now.getTime() + 1_800_000);
        if (fail) deep.capacityKvEviction.findMany.mockRejectedValueOnce(new Error("offline"));
        else
          deep.capacityKvEviction.findMany.mockResolvedValue(
            cut === null
              ? []
              : [
                  {
                    capacityId: "cap-1",
                    userId: "user-id",
                    cutFraction: cut,
                    observedAt: now,
                    expiresAt,
                  },
                ],
          );
        const result = await client().getPoolRoutingRules({ poolId: "pool-1" });
        expect(result.members[0]?.engineLoad.kvBudget).toEqual({
          reportedTokens: engineKind === "LLAMA_CPP" ? null : reported,
          effectiveTokens: effective,
          placementTokens: placement,
          source: engineKind === "LLAMA_CPP" || reported == null ? null : "CONFIG",
          cutFraction: active ? cut : 0,
          floorFraction: 0.5,
          lastObservedAt: cut === null ? null : now,
          expiresAt: cut === null ? null : expiresAt,
          active,
        });
        expect(deep.capacityKvEviction.findMany).toHaveBeenCalledWith({
          where: { capacityId: { in: ["cap-1"] }, userId: "user-id", expiresAt: { gt: now } },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("replaces a pool's rules, scoped to the owner, and asks the relay to clear its verdicts (M never writes an H table)", async () => {
    deep.modelPool.findFirst.mockResolvedValue({ id: "pool-1", PoolMembers: [{ id: "m1" }] });
    deep.poolRoutingRule.deleteMany.mockResolvedValue({ count: 0 });
    deep.poolRoutingRule.createMany.mockResolvedValue({ count: 1 });
    const onPoolRoutingRulesChanged = vi.fn(async () => undefined);
    const rules = [
      {
        metric: "node.gpu.temperature_c",
        labels: { gpu: "0" },
        op: ">",
        threshold: 85,
        effect: "full",
      },
    ] as const;
    const result = await client({ onPoolRoutingRulesChanged }).setPoolRoutingRules({
      poolId: "pool-1",
      rules: [...rules],
    });
    expect(result.rules[0]).toMatchObject({ aggregate: "max", effect: "full" });
    expect(deep.poolRoutingRule.deleteMany).toHaveBeenCalledWith({ where: { poolId: "pool-1" } });
    expect(deep.poolRoutingRule.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          poolId: "pool-1",
          position: 0,
          metric: "node.gpu.temperature_c",
          memberId: null,
          exclude: false,
        }),
      ],
    });
    expect(onPoolRoutingRulesChanged).toHaveBeenCalledWith("pool-1");
    expect(deep.poolMemberRoutingVerdict.deleteMany).not.toHaveBeenCalled();
  });

  it("persists label-less rules as SQL NULL, not JSON null", async () => {
    deep.modelPool.findFirst.mockResolvedValue({ id: "pool-1", PoolMembers: [{ id: "m1" }] });
    deep.poolRoutingRule.deleteMany.mockResolvedValue({ count: 0 });
    deep.poolRoutingRule.createMany.mockResolvedValue({ count: 1 });
    const { Prisma } = await import("@ws-model-proxy/db");
    await client().setPoolRoutingRules({
      poolId: "pool-1",
      rules: [{ metric: "node.gpu.temperature_c", op: ">", threshold: 85, effect: "full" }],
    });
    expect(deep.poolRoutingRule.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          poolId: "pool-1",
          labels: Prisma.DbNull,
        }),
      ],
    });
    expect(Prisma.DbNull).not.toEqual(Prisma.JsonNull);
  });

  it("rejects a member-scoped rule whose id is not in the pool", async () => {
    deep.modelPool.findFirst.mockResolvedValue({ id: "pool-1", PoolMembers: [{ id: "m1" }] });
    await expect(
      client().setPoolRoutingRules({
        poolId: "pool-1",
        rules: [{ metric: "x", op: ">", threshold: 1, effect: "avoid", memberId: "other-pool" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client().setPoolRoutingRules({
        poolId: "pool-1",
        rules: [
          { metric: "x", op: ">", threshold: 1, effect: "avoid", excludeMemberId: "other-pool" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deep.poolRoutingRule.createMany).not.toHaveBeenCalled();
  });

  it("rejects another user's pool and invalid rules without writing", async () => {
    deep.modelPool.findFirst.mockResolvedValue(null);
    await expect(
      client().setPoolRoutingRules({
        poolId: "pool-1",
        rules: [{ metric: "x", op: ">", threshold: 1, effect: "avoid" }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deep.poolMemberRoutingVerdict.deleteMany).not.toHaveBeenCalled();
    expect(deep.poolRoutingRule.createMany).not.toHaveBeenCalled();
    await expect(
      client().setPoolRoutingRules({
        poolId: "pool-1",
        rules: [{ metric: "bad name", op: ">", threshold: 1, effect: "avoid" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports each member's verdict, staleness and the metrics its device offers", async () => {
    const now = Date.now();
    const model = (upstreamModelId: string) => ({
      slug: null,
      upstreamModelId,
      Endpoint: {
        slug: "gpu",
        cliDeviceId: "cli-id",
        CliDevice: { slug: "desk", name: null, reportedHostname: "desk.local" },
      },
    });
    deep.modelPool.findFirst.mockResolvedValue({
      id: "pool-1",
      slug: "coder",
      PoolRoutingRules: [{ metric: "fan_rpm", op: ">", threshold: 3000, effect: "avoid" }],
      PoolMembers: [
        { id: "m1", DiscoveredModel: null, ExecutionTarget: { DiscoveredModel: model("a") } },
        { id: "m2", DiscoveredModel: null, ExecutionTarget: { DiscoveredModel: model("b") } },
        { id: "m3", DiscoveredModel: null, ExecutionTarget: { DiscoveredModel: model("c") } },
      ],
    });
    deep.poolMemberRoutingVerdict.findMany.mockResolvedValue([
      {
        poolMemberId: "m1",
        verdict: "AVOID",
        ruleStates: ["triggered"],
        evaluatedAt: new Date(now - 1_000),
        expiresAt: new Date(now + 20_000),
      },
      {
        poolMemberId: "m2",
        verdict: "AVOID",
        ruleStates: ["triggered"],
        evaluatedAt: new Date(now - 60_000),
        expiresAt: new Date(now - 30_000),
      },
    ]);
    deep.cliDevice.findMany.mockResolvedValue([]);
    const receivedAt = new Date(now - 2_000);
    const result = await client({
      getLiveNodeTelemetry: (ids: readonly string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              nodeMetrics: {
                ts: receivedAt.toISOString(),
                custom: [
                  {
                    source: "fans",
                    name: "fan_rpm",
                    value: 3200,
                    ts: receivedAt.toISOString(),
                  },
                ],
                sources: [{ name: "fans", origin: "local", state: "active", intervalSecs: 10 }],
              },
              nodeMetricsReceivedAt: receivedAt,
              endpointLoad: [
                {
                  endpointSlug: "gpu",
                  modelSlug: null,
                  running: 2,
                  waiting: 1,
                  source: "vllm-metrics",
                  ts: receivedAt.toISOString(),
                  receivedAt,
                },
              ],
            },
          ]),
        ),
    }).getPoolRoutingRules({ poolId: "pool-1" });
    expect(deep.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pool-1", userId: "user-id" } }),
    );
    expect(
      result.members.map((member) => [member.poolMemberId, member.state, member.verdict]),
    ).toEqual([
      ["m1", "active", "avoid"],
      ["m2", "stale", null],
      ["m3", "unevaluated", null],
    ]);
    expect(result.devices[0]).toMatchObject({ label: "desk.local", live: true });
    expect(result.devices[0]?.series).toEqual([
      expect.objectContaining({ name: "fan_rpm", value: 3200, stale: false, origin: "custom" }),
    ]);
    expect(result.members[0]?.endpointSeries.map((entry) => entry.name)).toEqual([
      "endpoint.running",
      "endpoint.waiting",
    ]);
  });

  it("reports live engine load, the override and the verdict state per member (S-D)", async () => {
    const now = Date.now();
    const model = (upstreamModelId: string) => ({
      slug: null,
      upstreamModelId,
      Endpoint: {
        slug: "gpu",
        cliDeviceId: "cli-id",
        CliDevice: { slug: "desk", name: null, reportedHostname: "desk.local" },
      },
    });
    const target = (engineKind: string) => ({
      InferenceCapacity: { engineKind, engineSlots: 4 },
      DiscoveredModel: model("a"),
    });
    deep.modelPool.findFirst.mockResolvedValue({
      id: "pool-1",
      slug: "coder",
      PoolRoutingRules: [],
      PoolMembers: [
        {
          id: "m1",
          engineLoadMode: "AUTO",
          kvFullThreshold: null,
          DiscoveredModel: null,
          ExecutionTarget: target("VLLM"),
        },
        {
          id: "m2",
          engineLoadMode: "OFF",
          kvFullThreshold: 0.5,
          DiscoveredModel: null,
          ExecutionTarget: target("VLLM"),
        },
        {
          id: "m3",
          engineLoadMode: "AUTO",
          kvFullThreshold: null,
          DiscoveredModel: null,
          ExecutionTarget: target("OLLAMA"),
        },
        {
          id: "m4",
          engineLoadMode: "AUTO",
          kvFullThreshold: null,
          DiscoveredModel: null,
          ExecutionTarget: target("VLLM"),
        },
        {
          id: "m5",
          engineLoadMode: "AUTO",
          kvFullThreshold: null,
          DiscoveredModel: null,
          ExecutionTarget: {
            InferenceCapacity: { engineKind: "VLLM", engineSlots: 4 },
            DiscoveredModel: {
              slug: null,
              upstreamModelId: "stale",
              Endpoint: {
                slug: "stale-gpu",
                cliDeviceId: "cli-id",
                CliDevice: { slug: "desk", name: null, reportedHostname: "desk.local" },
              },
            },
          },
        },
      ],
    });
    deep.poolMemberRoutingVerdict.findMany.mockResolvedValue([
      {
        poolMemberId: "m1",
        verdict: "FULL",
        ruleStates: [],
        engineState: "full_waiting",
        evaluatedAt: new Date(now - 1_000),
        expiresAt: new Date(now + 10_000),
      },
      {
        poolMemberId: "m4",
        verdict: "FULL",
        ruleStates: [],
        engineState: "full_kv",
        evaluatedAt: new Date(now - 60_000),
        expiresAt: new Date(now - 30_000),
      },
    ]);
    deep.cliDevice.findMany.mockResolvedValue([]);
    const fresh = new Date(now - 2_000);
    // Outside the 15 s staleness window: ageSeconds > 15 and `live.stale` true.
    const stale = new Date(now - 20_000);
    const result = await client({
      getLiveNodeTelemetry: (ids: readonly string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              nodeMetrics: null,
              nodeMetricsReceivedAt: null,
              endpointLoad: [
                {
                  endpointSlug: "gpu",
                  modelSlug: null,
                  running: 4,
                  waiting: 2,
                  kvUsage: 0.5,
                  waitingStreak: 3,
                  prefixCacheHitsTotal: 30,
                  prefixCacheQueriesTotal: 60,
                  source: "vllm-metrics",
                  ts: fresh.toISOString(),
                  receivedAt: fresh,
                },
                {
                  endpointSlug: "stale-gpu",
                  modelSlug: null,
                  running: 1,
                  waiting: 2,
                  kvUsage: 0.1,
                  waitingStreak: 3,
                  source: "vllm-metrics",
                  ts: stale.toISOString(),
                  receivedAt: stale,
                },
              ],
            },
          ]),
        ),
    }).getPoolRoutingRules({ poolId: "pool-1" });
    const byId = new Map(result.members.map((member) => [member.poolMemberId, member.engineLoad]));
    expect(byId.get("m1")).toMatchObject({
      mode: "auto",
      engineKind: "VLLM",
      hasSignal: true,
      state: "full_waiting",
      full: true,
      snapshotState: "full_waiting",
      live: {
        running: 4,
        waiting: 2,
        kvUsage: 0.5,
        waitingStreak: 3,
        stale: false,
        prefixCacheHits: 30,
        prefixCacheQueries: 60,
      },
    });
    // 'off' ignores the same reading; the threshold override is reported.
    expect(byId.get("m2")).toMatchObject({
      mode: "off",
      state: "off",
      full: false,
      kvFullThreshold: 0.5,
      effectiveKvFullThreshold: 0.5,
    });
    // An expired snapshot row is not reported as the shared state.
    expect(byId.get("m4")?.snapshotState).toBeNull();
    // A reading older than the staleness window reports its own age and does
    // not hold FULL (fail open to lease counts).
    expect(byId.get("m5")).toMatchObject({
      state: "stale",
      full: false,
      live: { stale: true, ageSeconds: 20 },
    });
    // Ollama has no engine signal.
    expect(byId.get("m3")).toMatchObject({ hasSignal: false, state: "none", full: false });
  });

  it("does not report snapshotState FULL for observe-only custom members", async () => {
    const now = Date.now();
    deep.modelPool.findFirst.mockResolvedValue({
      id: "pool-1",
      slug: "coder",
      PoolRoutingRules: [],
      PoolMembers: [
        {
          id: "m-observe",
          engineLoadMode: "AUTO",
          customEngineLoadMode: "OBSERVE",
          kvFullThreshold: null,
          DiscoveredModel: null,
          ExecutionTarget: {
            InferenceCapacity: {
              engineKind: "GENERIC",
              engineSlots: null,
              engineLoadSource: "CUSTOM",
              engineLoadSignals: ["kvUsage"],
            },
            DiscoveredModel: {
              slug: null,
              upstreamModelId: "custom",
              Endpoint: {
                slug: "gpu",
                cliDeviceId: "cli-id",
                CliDevice: { slug: "desk", name: null, reportedHostname: "desk.local" },
              },
            },
          },
        },
        {
          id: "m-enforce",
          engineLoadMode: "AUTO",
          customEngineLoadMode: "ENFORCE",
          kvFullThreshold: null,
          DiscoveredModel: null,
          ExecutionTarget: {
            InferenceCapacity: {
              engineKind: "GENERIC",
              engineSlots: null,
              engineLoadSource: "CUSTOM",
              engineLoadSignals: ["kvUsage"],
            },
            DiscoveredModel: {
              slug: null,
              upstreamModelId: "custom",
              Endpoint: {
                slug: "gpu",
                cliDeviceId: "cli-id",
                CliDevice: { slug: "desk", name: null, reportedHostname: "desk.local" },
              },
            },
          },
        },
      ],
    });
    deep.poolMemberRoutingVerdict.findMany.mockResolvedValue([
      {
        poolMemberId: "m-observe",
        verdict: "NONE",
        ruleStates: [],
        engineState: "full_kv",
        evaluatedAt: new Date(now - 1_000),
        expiresAt: new Date(now + 10_000),
      },
      {
        poolMemberId: "m-enforce",
        verdict: "FULL",
        ruleStates: [],
        engineState: "full_kv",
        evaluatedAt: new Date(now - 1_000),
        expiresAt: new Date(now + 10_000),
      },
    ]);
    deep.cliDevice.findMany.mockResolvedValue([]);
    const fresh = new Date(now - 2_000);
    const result = await client({
      getLiveNodeTelemetry: (ids: readonly string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              nodeMetrics: null,
              nodeMetricsReceivedAt: null,
              endpointLoad: [
                {
                  endpointSlug: "gpu",
                  modelSlug: null,
                  running: 1,
                  kvUsage: 1,
                  source: "custom",
                  ts: fresh.toISOString(),
                  receivedAt: fresh,
                },
              ],
            },
          ]),
        ),
    }).getPoolRoutingRules({ poolId: "pool-1" });
    const byId = new Map(result.members.map((member) => [member.poolMemberId, member.engineLoad]));
    expect(byId.get("m-observe")).toMatchObject({
      customMode: "observe",
      state: "full_kv",
      full: true,
      enforced: false,
      snapshotState: null,
    });
    expect(byId.get("m-enforce")).toMatchObject({
      customMode: "enforce",
      state: "full_kv",
      full: true,
      enforced: true,
      snapshotState: "full_kv",
    });
  });

  it("sets a member's engine load override, scoped to the owner, and has the relay clear the pool's verdicts (S-D)", async () => {
    deep.poolMember.updateMany.mockResolvedValue({ count: 1 });
    const onPoolRoutingRulesChanged = vi.fn(async () => undefined);
    deep.poolMember.findFirst.mockResolvedValue({
      id: "m1",
      poolId: "pool-1",
      engineLoadMode: "OFF",
      kvFullThreshold: 0.8,
    });
    const result = await client({ onPoolRoutingRulesChanged }).setPoolMemberEngineLoad({
      poolMemberId: "m1",
      mode: "off",
      kvFullThreshold: 0.8,
    });
    expect(deep.poolMember.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", ModelPool: { userId: "user-id" } },
      data: { engineLoadMode: "OFF", kvFullThreshold: 0.8 },
    });
    expect(onPoolRoutingRulesChanged).toHaveBeenCalledWith("pool-1");
    // The H-class verdict table is never written by this M writer.
    expect(deep.poolMemberRoutingVerdict.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "off", kvFullThreshold: 0.8 });
  });

  it("leaves the threshold alone when omitted and rejects foreign members and bad thresholds (S-D)", async () => {
    deep.poolMember.updateMany.mockResolvedValue({ count: 1 });
    deep.poolMember.findFirst.mockResolvedValue({
      id: "m1",
      poolId: "pool-1",
      engineLoadMode: "AUTO",
      kvFullThreshold: null,
    });
    await client().setPoolMemberEngineLoad({ poolMemberId: "m1", mode: "auto" });
    expect(deep.poolMember.updateMany).toHaveBeenLastCalledWith({
      where: { id: "m1", ModelPool: { userId: "user-id" } },
      data: { engineLoadMode: "AUTO" },
    });
    deep.poolMember.updateMany.mockResolvedValue({ count: 0 });
    deep.poolMemberRoutingVerdict.deleteMany.mockClear();
    await expect(
      client().setPoolMemberEngineLoad({ poolMemberId: "other", mode: "off" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deep.poolMemberRoutingVerdict.deleteMany).not.toHaveBeenCalled();
    for (const bad of [0, 1.5, -0.1]) {
      await expect(
        client().setPoolMemberEngineLoad({
          poolMemberId: "m1",
          mode: "auto",
          kvFullThreshold: bad,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("stores remote metric sources only while the device is unsupervised and pushes them", async () => {
    deep.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
    });
    deep.cliDevice.updateMany.mockResolvedValue({ count: 1 });
    const pushed: string[] = [];
    const result = await client({
      onRemoteMetricSourcesChanged: async (id: string) => {
        pushed.push(id);
        return true;
      },
    }).setCliDeviceMetricSources({ cliDeviceId: "cli-id", sources: [source] });
    expect(deep.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-id", userId: "user-id", mcpCommandMode: "UNSUPERVISED" },
      data: { remoteMetricSources: [source], remoteMetricSourcesAt: expect.any(Date) },
    });
    expect(pushed).toEqual(["cli-id"]);
    expect(result).toMatchObject({ delivered: true });
    expect(result.sources[0]?.commandSha256).toMatch(/^[0-9a-f]{64}$/);

    for (const mode of ["OFF", "SUPERVISED"]) {
      vi.clearAllMocks();
      deep.cliDevice.findUnique.mockResolvedValue({
        id: "cli-id",
        userId: "user-id",
        mcpCommandMode: mode,
      });
      await expect(
        client().setCliDeviceMetricSources({ cliDeviceId: "cli-id", sources: [source] }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(deep.cliDevice.updateMany).not.toHaveBeenCalled();
    }
  });

  it("lists rule-addressable series and the server-held remote sources in device metrics", async () => {
    const at = new Date(Date.now() - 1_000);
    deep.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "user-id",
      slug: "desk",
      status: "CONNECTED",
      nodeInfo: null,
      nodeInfoAt: null,
      nodeMetrics: {
        ts: at.toISOString(),
        cpu: { usagePercent: 40 },
        gpus: [{ index: 1, temperatureC: 70 }],
      },
      nodeMetricsAt: at,
      mcpCommandMode: "SUPERVISED",
      remoteMetricSources: [source],
      remoteMetricSourcesAt: at,
    });
    const result = await client().getCliDeviceMetrics({ cliDeviceId: "cli-id" });
    expect(result.series.map((entry) => [entry.name, entry.labels])).toEqual([
      ["node.cpu.usage_percent", {}],
      ["node.gpu.temperature_c", { gpu: "1" }],
    ]);
    expect(result.remoteMetricSources).toEqual([
      { ...source, commandSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(result.remoteMetricSourcesAllowed).toBe(false);
  });

  it("refuses when the mode changed during the write, and hides other users' devices", async () => {
    deep.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
    });
    deep.cliDevice.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      client().setCliDeviceMetricSources({ cliDeviceId: "cli-id", sources: [source] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    deep.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "someone-else",
      mcpCommandMode: "UNSUPERVISED",
    });
    await expect(
      client().setCliDeviceMetricSources({ cliDeviceId: "cli-id", sources: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      client().setCliDeviceMetricSources({ cliDeviceId: "cli-id", sources: [source, source] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stores remote engine adapters only while the device is unsupervised and pushes them", async () => {
    const adapter = {
      endpointSlug: "gpu",
      input: { command: "echo 1" },
      format: "json" as const,
      intervalSecs: 2,
      timeoutSecs: 2,
    };
    deep.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
    });
    deep.cliDevice.updateMany.mockResolvedValue({ count: 1 });
    const pushed: string[] = [];
    const result = await client({
      onRemoteEngineAdaptersChanged: async (id: string) => {
        pushed.push(id);
        return true;
      },
    }).setCliDeviceEngineAdapters({ cliDeviceId: "cli-id", adapters: [adapter] });
    expect(deep.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-id", userId: "user-id", mcpCommandMode: "UNSUPERVISED" },
      data: { remoteEngineAdapters: [adapter], remoteEngineAdaptersAt: expect.any(Date) },
    });
    expect(pushed).toEqual(["cli-id"]);
    expect(result.delivered).toBe(true);
    expect(result.adapters[0]?.specSha256).toMatch(/^[0-9a-f]{64}$/);

    for (const mode of ["OFF", "SUPERVISED"]) {
      vi.clearAllMocks();
      deep.cliDevice.findUnique.mockResolvedValue({
        id: "cli-id",
        userId: "user-id",
        mcpCommandMode: mode,
      });
      await expect(
        client().setCliDeviceEngineAdapters({ cliDeviceId: "cli-id", adapters: [adapter] }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(deep.cliDevice.updateMany).not.toHaveBeenCalled();
    }

    vi.clearAllMocks();
    deep.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
    });
    deep.cliDevice.updateMany.mockResolvedValue({ count: 1 });
    await client({
      onRemoteEngineAdaptersChanged: async () => true,
    }).clearCliDeviceEngineAdapters({ cliDeviceId: "cli-id" });
    expect(deep.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-id", userId: "user-id", mcpCommandMode: "UNSUPERVISED" },
      data: { remoteEngineAdapters: [], remoteEngineAdaptersAt: expect.any(Date) },
    });
  });

  it("returns engine-load history for an owned pool and NOT_FOUND for a foreign one", async () => {
    deep.modelPool.findFirst.mockResolvedValue({
      PoolMembers: [
        {
          id: "m1",
          kvFullThreshold: 0.9,
          ExecutionTarget: {
            InferenceCapacity: {
              id: "cap-1",
              kvBudgetTokens: 262_144,
              engineLoadSource: "CUSTOM",
              engineLoadSignals: ["kvUsage"],
            },
            DiscoveredModel: {
              slug: "qwen",
              upstreamModelId: "qwen",
              Endpoint: { slug: "gpu", cliDeviceId: "cli-1", CliDevice: { name: "GPU" } },
            },
          },
        },
      ],
    });
    const series = [
      {
        start: new Date("2026-09-28T12:00:00.000Z"),
        running: 4,
        waiting: null,
        kvUsage: 0.8,
        kvOccupancy: 0.9,
        slotsBusy: null,
        prefixCacheHits: 2,
        prefixCacheQueries: 5,
        source: "custom",
        gap: false,
      },
    ];
    const result = await client({
      getLiveEngineLoadHistory: () => [
        { cliDeviceId: "cli-1", endpointSlug: "gpu", modelSlug: null, series },
      ],
    }).getEngineLoadHistory({ poolId: "pool-1" });
    expect(result.members).toEqual([
      {
        poolMemberId: "m1",
        capacityId: "cap-1",
        endpointSlug: "gpu",
        modelSlug: "qwen",
        cliDeviceId: "cli-1",
        source: "custom",
        signals: ["kvUsage"],
        effectiveKvFullThreshold: 0.9,
        kvBudgetTokens: 262_144,
        series,
      },
    ]);

    deep.modelPool.findFirst.mockResolvedValue(null);
    await expect(client().getEngineLoadHistory({ poolId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    deep.inferenceCapacity.findFirst.mockResolvedValue(null);
    await expect(client().getEngineLoadHistory({ capacityId: "cap-x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
