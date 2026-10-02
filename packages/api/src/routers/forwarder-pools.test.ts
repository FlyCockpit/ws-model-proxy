import { createRouterClient, ORPCError } from "@orpc/server";
import {
  parseDirectModelId,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import { FenceSetChangedError } from "@ws-model-proxy/db/capacity-lock-order";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPoolSlugAvailable,
  buildContext,
  client,
  db,
  fenceCalls,
  fenceParentDelete,
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

describe("forwarderManagementRouter pools", () => {
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

  it("refuses turning pool fallback on with a machine-readable reason when the switch is off", async () => {
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;
    db.modelPool.findUnique.mockResolvedValueOnce(poolRow({ userId: "user-id" }));
    await expect(
      client().updateModelPool({ id: "pool-id", fallbackEnabled: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", data: { reason: "PROVIDER_EGRESS_DISABLED" } });
    await expect(
      client().createModelPool({ slug: "fresh-pool", name: "Fresh", fallbackEnabled: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", data: { reason: "PROVIDER_EGRESS_DISABLED" } });
    expect(db.modelPool.update).not.toHaveBeenCalled();
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("creates and updates owned model pools without touching grant ids", async () => {
    db.modelPool.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(poolRow({ userId: "user-id", fallbackEnabled: false }));
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

  it("G1-2: a create leaves omitted fallback fields to the schema defaults and audits only explicit ones", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.modelPool.create.mockResolvedValue(poolRow({ externalAfterWaitMs: 2000 }));
    await client().createModelPool({ slug: "plain", name: "Plain" });
    const plain = db.modelPool.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    for (const field of ["fallbackEnabled", "fallbackForGrantees", "externalAfterWaitMs"])
      expect(plain.data).not.toHaveProperty(field);
    expect(db.providerAuditEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "POOL_FALLBACK_UPDATED" }),
      }),
    );

    db.modelPool.create.mockResolvedValue(poolRow({ externalAfterWaitMs: 500 }));
    await client().createModelPool({ slug: "fast", name: "Fast", externalAfterWaitMs: 500 });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "POOL_FALLBACK_UPDATED",
        metadata: {
          source: "dashboard",
          changes: { externalAfterWaitMs: { before: null, after: 500 } },
        },
      }),
    });
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
          affinityResidencyWeight: 100,
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
        fallbackEnabled: false,
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
        fallbackEnabled: false,
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

  it("enables fallback without any acknowledgement and stores the owner settings", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({
        userId: "user-id",
        fallbackEnabled: false,
        fallbackForGrantees: false,
        externalAfterWaitMs: 2000,
        capacityWaitBudgetMs: 30_000,
      }),
    );
    db.poolMember.findMany.mockResolvedValue([]);
    db.providerBudgetPolicy.findMany.mockResolvedValue([]);
    db.modelPool.update.mockResolvedValue(
      poolRow({ fallbackEnabled: true, fallbackForGrantees: true, externalAfterWaitMs: 500 }),
    );

    await expect(
      client().updateModelPool({
        id: "pool-id",
        fallbackEnabled: true,
        fallbackForGrantees: true,
        externalAfterWaitMs: 500,
      }),
    ).resolves.toMatchObject({
      fallbackEnabled: true,
      fallbackForGrantees: true,
      externalAfterWaitMs: 500,
    });
    const update = db.modelPool.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(update.data).toMatchObject({
      fallbackEnabled: true,
      fallbackForGrantees: true,
      externalAfterWaitMs: 500,
    });
    // Issue #67: every fallback change is audited, with its source.
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "user-id",
        action: "POOL_FALLBACK_UPDATED",
        subjectId: "pool-id",
        metadata: {
          source: "dashboard",
          changes: {
            fallbackEnabled: { before: false, after: true },
            fallbackForGrantees: { before: false, after: true },
            externalAfterWaitMs: { before: 2000, after: 500 },
          },
        },
      },
    });
  });

  it("writes no fallback audit event when a save leaves the fallback settings unchanged", async () => {
    const settings = {
      fallbackEnabled: true,
      fallbackForGrantees: false,
      externalAfterWaitMs: 2000,
    };
    db.modelPool.findUnique.mockResolvedValue(poolRow({ userId: "user-id", ...settings }));
    db.modelPool.update.mockResolvedValue(poolRow({ name: "Renamed", ...settings }));
    await client().updateModelPool({ id: "pool-id", name: "Renamed" });
    expect(db.providerAuditEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "POOL_FALLBACK_UPDATED" }),
      }),
    );
  });

  it("turns fallback off while external members stay configured, even with the switch off", async () => {
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", fallbackEnabled: true }),
    );
    db.poolMember.count.mockResolvedValue(2);
    db.modelPool.update.mockResolvedValue(poolRow({ fallbackEnabled: false }));

    await expect(
      client().updateModelPool({ id: "pool-id", fallbackEnabled: false }),
    ).resolves.toMatchObject({ fallbackEnabled: false });
    // Disabling never inspects or removes the external members.
    expect(db.poolMember.findMany).not.toHaveBeenCalled();
    expect(db.poolMember.delete).not.toHaveBeenCalled();
  });

  it("stores the cache-holder wait override (auto, off, fixed) and caps it at 30 s", async () => {
    db.modelPool.findUnique.mockResolvedValue(poolRow({ userId: "user-id" }));
    for (const value of [750, 0, null]) {
      db.modelPool.update.mockResolvedValueOnce(poolRow({ cacheHolderWaitMs: value }));
      await expect(
        client().updateModelPool({ id: "pool-id", cacheHolderWaitMs: value }),
      ).resolves.toMatchObject({ cacheHolderWaitMs: value });
      const update = db.modelPool.update.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };
      expect(update.data).toMatchObject({ cacheHolderWaitMs: value });
    }
    await expect(
      client().updateModelPool({ id: "pool-id", cacheHolderWaitMs: 30_001 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Unrelated saves leave the stored override untouched.
    db.modelPool.update.mockResolvedValueOnce(poolRow({ name: "Renamed" }));
    await client().updateModelPool({ id: "pool-id", name: "Renamed" });
    const rename = db.modelPool.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(rename.data).not.toHaveProperty("cacheHolderWaitMs");
  });

  it("stores the new-conversation residency weight", async () => {
    db.modelPool.findUnique.mockResolvedValue(poolRow({ userId: "user-id" }));
    db.modelPool.update.mockResolvedValue(poolRow({ affinityResidencyWeight: 250 }));
    await expect(
      client().updateModelPool({ id: "pool-id", affinityResidencyWeight: 250 }),
    ).resolves.toMatchObject({ affinity: { residencyWeight: 250 } });
    const update = db.modelPool.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(update.data).toMatchObject({ affinityResidencyWeight: 250 });
    await expect(
      client().updateModelPool({ id: "pool-id", affinityResidencyWeight: 10_001 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stores warm-session protection settings and keeps the share mode consistent", async () => {
    db.modelPool.findUnique.mockResolvedValue(poolRow({ userId: "user-id" }));
    db.modelPool.update.mockResolvedValue(poolRow());
    const lastUpdate = () =>
      (db.modelPool.update.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;

    await client().updateModelPool({
      id: "pool-id",
      protectionEnabled: false,
      protectionWindowSeconds: 120,
      protectMinTokens: 4096,
      protectionShare: "FIXED_PERCENT",
      protectionFixedPercent: 25,
      ownerProtectionPercent: 0,
    });
    expect(lastUpdate()).toMatchObject({
      protectionEnabled: false,
      protectionWindowSeconds: 120,
      protectMinTokens: 4096,
      protectionShare: "FIXED_PERCENT",
      protectionFixedPercent: 25,
      ownerProtectionPercent: 0,
    });
    await client().updateModelPool({ id: "pool-id", evictionFeedbackEnabled: false });
    expect(lastUpdate()).toMatchObject({ evictionFeedbackEnabled: false });
    await client().updateModelPool({ id: "pool-id", evictionFeedbackEnabled: true });
    expect(lastUpdate()).toMatchObject({ evictionFeedbackEnabled: true });
    // FIXED_PERCENT needs a percent; any other mode stores none.
    await expect(
      client().updateModelPool({ id: "pool-id", protectionShare: "FIXED_PERCENT" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", protectionShare: "FIXED_PERCENT", protectionFixedPercent: 25 }),
    );
    await client().updateModelPool({ id: "pool-id", protectionShare: "EQUAL_SHARE" });
    expect(lastUpdate()).toMatchObject({
      protectionShare: "EQUAL_SHARE",
      protectionFixedPercent: null,
    });
    // Changing only the percent of a FIXED_PERCENT pool keeps the mode.
    await client().updateModelPool({ id: "pool-id", protectionFixedPercent: 60 });
    expect(lastUpdate()).toMatchObject({
      protectionShare: "FIXED_PERCENT",
      protectionFixedPercent: 60,
    });
    // Out-of-range values never reach the database.
    const updates = db.modelPool.update.mock.calls.length;
    for (const input of [
      { protectionWindowSeconds: 0 },
      { protectionWindowSeconds: 3_601 },
      { ownerProtectionPercent: 101 },
      { protectionFixedPercent: 0 },
    ])
      await expect(client().updateModelPool({ id: "pool-id", ...input })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    expect(db.modelPool.update).toHaveBeenCalledTimes(updates);
    // Unrelated saves leave the protection settings untouched.
    await client().updateModelPool({ id: "pool-id", name: "Renamed" });
    expect(Object.keys(lastUpdate()).filter((key) => key.startsWith("protect"))).toEqual([]);
  });

  it("creates a pool with protection on by default", async () => {
    db.modelPool.findUnique.mockResolvedValue(null);
    db.modelPool.create.mockResolvedValue(poolRow());
    await client().createModelPool({ slug: "fresh", name: "Fresh" });
    expect(
      (db.modelPool.create.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      protectionEnabled: true,
      evictionFeedbackEnabled: true,
      protectionWindowSeconds: 300,
      protectMinTokens: 8192,
      protectionShare: "EQUAL_SHARE",
      protectionFixedPercent: null,
      ownerProtectionPercent: null,
    });
  });

  it("lets only the pool owner set a grant's protection override and queue priority", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.$queryRaw.mockResolvedValue([{ id: "pool-id" }]);
    db.poolGrant.updateMany.mockResolvedValue({ count: 1 });
    db.poolGrant.findUniqueOrThrow.mockResolvedValue({
      id: "grant-id",
      poolId: "pool-id",
      granteeUserId: "grantee-id",
      protectionOverridePercent: 0,
      queuePriority: 24,
    });

    await expect(
      client().updatePoolGrant({
        poolId: "pool-id",
        grantId: "grant-id",
        protectionOverridePercent: 0,
        queuePriority: 24,
      }),
    ).resolves.toMatchObject({ protectionOverridePercent: 0, queuePriority: 24 });
    expect(db.poolGrant.updateMany).toHaveBeenCalledWith({
      where: { id: "grant-id", poolId: "pool-id", ownerUserId: "user-id" },
      data: { protectionOverridePercent: 0, queuePriority: 24 },
    });
    // Writer class M: the owner fence is the first lock operation, before the pool row lock.
    expect(fenceCalls()).toEqual([["00:owner:user-id"]]);
    expect(lastFenceOrder()).toBeLessThan(firstRowLockOrder());
    // Omitted fields stay; null means "inherit".
    await client().updatePoolGrant({ poolId: "pool-id", grantId: "grant-id", queuePriority: null });
    expect(db.poolGrant.updateMany).toHaveBeenLastCalledWith({
      where: { id: "grant-id", poolId: "pool-id", ownerUserId: "user-id" },
      data: { queuePriority: null },
    });
    // Ranges are 0..100 and 0..31.
    for (const input of [{ protectionOverridePercent: 101 }, { queuePriority: 32 }])
      await expect(
        client().updatePoolGrant({ poolId: "pool-id", grantId: "grant-id", ...input }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A grant of another pool (or owner) is not found, never written.
    db.poolGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      client().updatePoolGrant({ poolId: "pool-id", grantId: "other-grant", queuePriority: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A grantee (not the owner) cannot reach it: the pool is not theirs.
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "someone-else" });
    const writes = db.poolGrant.updateMany.mock.calls.length;
    await expect(
      client().updatePoolGrant({ poolId: "pool-id", grantId: "grant-id", queuePriority: 31 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.poolGrant.updateMany).toHaveBeenCalledTimes(writes);
  });

  it("lets the pool owner set and clear a per-grant owner-paid spend cap", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.$queryRaw.mockResolvedValue([{ id: "pool-id" }]);
    db.poolGrant.findFirst.mockResolvedValue({ granteeUserId: "grantee-id" });
    db.poolGrant.updateMany.mockResolvedValue({ count: 1 });
    db.poolMember.findMany.mockResolvedValue([]);
    db.providerBudgetPolicy.findFirst.mockResolvedValue(null);
    db.providerBudgetPolicy.create.mockResolvedValue({ id: "grant-cap" });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    db.poolGrant.findUniqueOrThrow.mockResolvedValue({
      id: "grant-id",
      poolId: "pool-id",
      granteeUserId: "grantee-id",
      protectionOverridePercent: null,
      queuePriority: null,
    });
    db.providerBudgetPolicy.findMany.mockResolvedValue([
      { Rules: [{ limitValue: "25.5", currency: "USD", period: "UTC_MONTH" }] },
    ]);

    await expect(
      client().updatePoolGrant({
        poolId: "pool-id",
        grantId: "grant-id",
        fallbackSpend: { limit: "25.5", currency: "USD", period: "UTC_MONTH" },
      }),
    ).resolves.toMatchObject({
      fallbackSpend: { limit: "25.5", currency: "USD", period: "UTC_MONTH" },
    });
    expect(db.providerBudgetPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scopeType: "POOL_GRANT",
          poolGrantId: "grant-id",
          poolId: "pool-id",
          granteeUserId: "grantee-id",
          providerAccountId: null,
          active: true,
        }),
      }),
    );
    expect(fenceCalls()).toEqual([
      ["00:owner:user-id"],
      ["03:provider-budget-grant:user-id:pool-id:grantee-id"],
    ]);
    expect(lastFenceOrder()).toBeLessThan(firstRowLockOrder());

    db.providerBudgetPolicy.findFirst.mockResolvedValue({
      id: "grant-cap",
      active: true,
      version: 1,
      Rules: [{ limitValue: "25.5", currency: "USD", period: "UTC_MONTH" }],
    });
    db.providerBudgetPolicy.update.mockResolvedValue({ id: "grant-cap" });
    db.providerBudgetPolicy.findMany.mockResolvedValue([]);
    await expect(
      client().updatePoolGrant({ poolId: "pool-id", grantId: "grant-id", fallbackSpend: null }),
    ).resolves.toMatchObject({ fallbackSpend: null });
    expect(db.providerBudgetPolicy.update).toHaveBeenCalledWith({
      where: { id: "grant-cap" },
      data: { active: false, deactivatedAt: expect.any(Date) },
    });
  });

  it("rejects an external wait longer than the pool's local wait budget", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", fallbackEnabled: true, capacityWaitBudgetMs: 1_000 }),
    );

    await expect(
      client().updateModelPool({ id: "pool-id", externalAfterWaitMs: 3_000 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("validates a new external wait against the budget set in the same save", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({
        userId: "user-id",
        fallbackEnabled: true,
        capacityWaitBudgetMs: 60_000,
        externalAfterWaitMs: 2_000,
      }),
    );
    await expect(
      client().updateModelPool({
        id: "pool-id",
        capacityWaitBudgetMs: 1_000,
        externalAfterWaitMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("never rejects a save that leaves a stored external wait above the budget unchanged", async () => {
    // Stored default 2000 ms is above this pool's 1000 ms budget; the runtime
    // uses min(budget, externalAfterWaitMs), so unrelated saves must succeed.
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({
        userId: "user-id",
        fallbackEnabled: true,
        capacityWaitBudgetMs: 1_000,
        externalAfterWaitMs: 2_000,
      }),
    );
    db.modelPool.update.mockResolvedValue(
      poolRow({ fallbackEnabled: true, fallbackForGrantees: true }),
    );
    await expect(
      client().updateModelPool({ id: "pool-id", fallbackForGrantees: true }),
    ).resolves.toMatchObject({ fallbackForGrantees: true });
    // Re-sending the unchanged stored value is not a change either.
    await expect(
      client().updateModelPool({ id: "pool-id", externalAfterWaitMs: 2_000 }),
    ).resolves.toBeDefined();
    // Lowering only the budget below the stored wait is also allowed.
    await expect(
      client().updateModelPool({ id: "pool-id", capacityWaitBudgetMs: 500 }),
    ).resolves.toBeDefined();
    expect(db.modelPool.update).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["inactive", { mode: "LIMITED", limitValue: "2" }, null],
    ["LIMITED without a positive limit", { mode: "LIMITED", limitValue: null }, new Date()],
    ["UNLIMITED with a value", { mode: "UNLIMITED", limitValue: "1" }, new Date()],
  ])(
    "rejects public-egress enablement when an attachment policy is %s",
    async (_label, rule, activatedAt) => {
      db.modelPool.findUnique.mockResolvedValue(
        poolRow({ userId: "user-id", fallbackEnabled: false }),
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
          fallbackEnabled: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(db.modelPool.update).not.toHaveBeenCalled();
    },
  );

  it("rejects public-egress enablement when an otherwise valid policy lacks an audit", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", fallbackEnabled: false }),
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
        fallbackEnabled: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("enables public egress only when every attachment has an audited explicit rule", async () => {
    db.modelPool.findUnique.mockResolvedValue(
      poolRow({ userId: "user-id", fallbackEnabled: false }),
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
    db.modelPool.update.mockResolvedValue(poolRow({ fallbackEnabled: true }));

    await expect(
      client().updateModelPool({
        id: "pool-id",
        fallbackEnabled: true,
      }),
    ).resolves.toMatchObject({ fallbackEnabled: true });
  });

  describe("caller-controlled external fallback", () => {
    const grantee = {
      granteeUserId: "grantee-id",
      Grantee: { email: "ada@example.com", name: "Ada", locale: "en-US" },
    };

    function privateSharedPool() {
      db.modelPool.findUnique.mockResolvedValue(
        poolRow({
          userId: "user-id",
          name: "Shared",
          fallbackEnabled: false,
        }),
      );
      db.poolMember.findMany.mockResolvedValue([]);
      db.providerBudgetPolicy.findMany.mockResolvedValue([]);
      // One external member is configured; turning fallback on makes the
      // pool able to send `:external` traffic out.
      db.poolMember.count.mockResolvedValue(1);
      db.poolGrant.findMany.mockResolvedValue([grantee]);
      db.modelPool.update.mockResolvedValue(
        poolRow({
          name: "Shared",
          fallbackEnabled: true,
        }),
      );
    }

    it("enables shared fallback without consulting grantees", async () => {
      privateSharedPool();
      await expect(
        client().updateModelPool({ id: "pool-id", fallbackEnabled: true }),
      ).resolves.toMatchObject({ fallbackEnabled: true });
      expect(db.poolGrant.findMany).not.toHaveBeenCalled();
    });

    it("does not require confirmation when the shared pool has no grantees", async () => {
      privateSharedPool();
      db.poolGrant.findMany.mockResolvedValue([]);

      await expect(
        client().updateModelPool({
          id: "pool-id",
          fallbackEnabled: true,
        }),
      ).resolves.toMatchObject({ fallbackEnabled: true });
    });

    it("does not require confirmation when the pool is already non-private", async () => {
      privateSharedPool();
      db.modelPool.findUnique.mockResolvedValue(
        poolRow({
          userId: "user-id",
          name: "Shared",
          fallbackEnabled: true,
        }),
      );
      db.poolMember.count.mockResolvedValue(1);

      await expect(
        client().updateModelPool({
          id: "pool-id",
          fallbackEnabled: true,
        }),
      ).resolves.toMatchObject({ fallbackEnabled: true });
    });

    it("attaches the first external member of an enabled shared pool", async () => {
      db.modelPool.findFirst.mockResolvedValue({
        id: "pool-id",
        name: "Shared",
        fallbackEnabled: true,
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
      db.poolMember.findMany.mockResolvedValue([]);
      db.poolMember.count.mockResolvedValue(0);
      db.poolGrant.findMany.mockResolvedValue([grantee]);
      db.executionTarget.upsert.mockResolvedValue({ id: "provider-target" });
      db.poolMember.create.mockResolvedValue({ id: "external-provider-member" });

      await expect(
        httpClient().addProviderPoolMember({
          poolId: "pool-id",
          providerModelId: "provider-model",
          tier: "PUBLIC_OVERFLOW",
          publicOrder: 0,
        }),
      ).resolves.toEqual({
        id: "external-provider-member",
        executionTargetId: "provider-target",
      });
      // Writer class M: the owner fence, then (no target or capacity yet) the
      // provider-model identity fence, then the pool row and the provider
      // account -> model rows (FOR KEY SHARE), then the writes.
      expect(fenceCalls()).toEqual([
        ["00:owner:user-id"],
        ["02:execution-target:provider-model:provider-model"],
      ]);
      const rowLocks = (db.$queryRaw.mock.calls as unknown[][])
        .filter((call) => !isFenceCall(call))
        .map((call) =>
          sqlOf(call)
            .match(/FROM (\w+)[\s\S]*FOR ((NO )?KEY \w+|UPDATE)/)
            ?.slice(1, 3),
        );
      expect(rowLocks).toEqual([
        ["model_pool", "NO KEY UPDATE"],
        ["provider_account", "KEY SHARE"],
        ["provider_model", "KEY SHARE"],
      ]);
      expect(lastFenceOrder()).toBeLessThan(firstRowLockOrder());
      expect(firstRowLockOrder()).toBeLessThan(
        db.executionTarget.upsert.mock.invocationCallOrder[0] ?? Number.NaN,
      );
    });

    it("never promotes a provider member to PRIMARY", async () => {
      const member = {
        id: "member-id",
        poolId: "pool-id",
        tier: "PUBLIC_OVERFLOW",
        publicOrder: 0,
        weight: 0,
        routingStatus: "ACTIVE",
        capacityConcurrencyMode: "INHERIT",
        capacityConcurrencyLimit: null,
        capacityReservedSlots: null,
        capacityContextCeilingMode: "INHERIT",
        capacityContextCeiling: null,
        capacityContextMargin: null,
        ExecutionTarget: {
          ProviderModel: { id: "provider-model", providerAccountId: "provider-account" },
          InferenceCapacity: { physicalMaxContext: null, hardConcurrencyLimit: null },
        },
        ModelPool: {
          userId: "user-id",
          name: "Shared",
          fallbackEnabled: false,
          recommendedSurfaceOverride: null,
          protocolAdaptationEnabled: false,
          capacityConcurrencyLimit: null,
          capacityReservedSlots: 0,
          capacityContextCeiling: null,
          capacityContextMargin: 0,
        },
      };
      db.poolMember.findUnique
        .mockResolvedValueOnce({
          id: "member-id",
          poolId: "pool-id",
          executionTargetId: null,
          ModelPool: { userId: "user-id" },
        })
        .mockResolvedValueOnce(member);

      await expect(
        client().updatePoolMember({
          id: "member-id",
          tier: "PRIMARY",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(db.poolMember.update).not.toHaveBeenCalled();
    });
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
      fallbackEnabled: false,
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
    });
    expect(result.compatibility).toMatchObject({
      recommendedSurface: "ANTHROPIC_MESSAGES",
      warnings: expect.arrayContaining([
        "adaptation_strict_subset",
        "developer_role_collapse_lossy",
      ]),
    });
  });

  it("serializes adapted surfaces from the pool adaptation flag alone", async () => {
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

    expect(result?.compatibility.surfaces.OPENAI_RESPONSES).toMatchObject({
      adapted: 1,
    });
    expect(result?.compatibility.warnings).toContain("developer_role_collapse_lossy");
  });

  it("rejects legacy Completions as a recommended pool API", async () => {
    await expect(
      client().createModelPool({
        slug: "legacy-completions",
        name: "Legacy Completions",
        // @ts-expect-error Legacy completions is not a pool recommendation.
        recommendedSurfaceOverride: "OPENAI_COMPLETIONS",
      }),
    ).rejects.toThrow();
    await expect(
      client().updateModelPool({
        id: "pool-id",
        // @ts-expect-error Legacy completions is not a pool recommendation.
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

  it("marks a pool external only when fallback is on and an external member exists", async () => {
    const member = (tier: "PRIMARY" | "PUBLIC_OVERFLOW", providerModelId: string | null) => ({
      id: `${tier}-${providerModelId ?? "local"}`,
      tier,
      routingStatus: "ACTIVE",
      ExecutionTarget: { providerModelId, DiscoveredModel: null, ProviderModel: null },
      DiscoveredModel: null,
    });
    db.modelPool.findMany.mockResolvedValue([
      poolRow({
        id: "enabled-external",
        slug: "enabled-external",
        fallbackEnabled: true,
        PoolMembers: [member("PRIMARY", null), member("PUBLIC_OVERFLOW", "overflow-model")],
      }),
      poolRow({
        id: "enabled-local-only",
        slug: "enabled-local-only",
        fallbackEnabled: true,
        PoolMembers: [member("PRIMARY", null)],
      }),
      poolRow({
        id: "disabled-external",
        slug: "disabled-external",
        fallbackEnabled: false,
        PoolMembers: [member("PUBLIC_OVERFLOW", "overflow-model")],
      }),
    ]);

    const pools = await client().listModelPools();

    expect(pools.map((pool) => [pool.id, pool.effectiveProviderEgress])).toEqual([
      ["enabled-external", true],
      ["enabled-local-only", false],
      ["disabled-external", false],
    ]);
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
      .mockResolvedValueOnce(poolRow({ userId: "user-id", fallbackEnabled: false }))
      .mockResolvedValueOnce(poolRow({ userId: "user-id", fallbackEnabled: false }));
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

  it("fences the owner, then the target policy and adopted capacity, before the pool row and any write", async () => {
    // Writer class M: a target without a capacity adopts its auto capacity
    // and fills a null AUTO limit. The owner fence comes first; the planned
    // target's capacity-policy fence and the candidate capacity's fence are
    // taken (one ascending call) before the pool row lock, the fill and the
    // link. No execution_target or inference_capacity row lock remains.
    const raw = prisma as unknown as { $queryRaw: MockInstance; $executeRaw: MockInstance };
    const extra = prisma as unknown as {
      inferenceCapacity: { findUnique: MockInstance };
      executionTarget: { updateMany: MockInstance };
    };
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
      upstreamModelId: "model",
    });
    // The planning read (before any row lock) finds the existing target.
    db.executionTarget.findUnique.mockResolvedValueOnce({
      id: "target-id",
      inferenceCapacityId: null,
    });
    db.executionTarget.upsert.mockResolvedValue({
      id: "target-id",
      inferenceCapacityId: null,
      InferenceCapacity: null,
    });
    db.inferenceCapacity.findMany.mockResolvedValue([{ id: "auto-capacity" }]);
    extra.inferenceCapacity.findUnique.mockResolvedValue({ id: "auto-capacity" });
    db.inferenceCapacity.updateMany.mockResolvedValue({ count: 1 });
    extra.executionTarget.updateMany.mockResolvedValue({ count: 1 });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });

    await client().addPoolMember({ poolId: "pool-id", discoveredModelId: "model-id" });

    const calls = raw.$queryRaw.mock.calls as unknown[][];
    const sqlOf = (call: unknown[]) => (call[0] as readonly string[]).join("?");
    const fenceIndexes = calls.flatMap((call, index) =>
      sqlOf(call).includes("wsmp_acquire_fences") ? [index] : [],
    );
    expect(fenceIndexes.map((index) => calls[index]?.[1])).toEqual([
      ["00:owner:user-id"],
      ["06:capacity-policy:target-id", "08:capacity:auto-capacity"],
    ]);
    const poolLockIndex = calls.findIndex((call) =>
      /FROM model_pool[\s\S]*FOR NO KEY UPDATE/.test(sqlOf(call)),
    );
    expect(poolLockIndex).toBeGreaterThan(-1);
    expect(
      calls.some((call) => /FROM (execution_target|inference_capacity)/.test(sqlOf(call))),
    ).toBe(false);
    const order = raw.$queryRaw.mock.invocationCallOrder;
    const policyFence = order[fenceIndexes[1] ?? -1] ?? Number.NaN;
    const poolLock = order[poolLockIndex] ?? Number.NaN;
    const upsert = db.executionTarget.upsert.mock.invocationCallOrder[0] ?? Number.NaN;
    const fill = db.inferenceCapacity.updateMany.mock.invocationCallOrder[0] ?? Number.NaN;
    const link = extra.executionTarget.updateMany.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(order[fenceIndexes[0] ?? -1] ?? Number.NaN).toBeLessThan(policyFence);
    expect(policyFence).toBeLessThan(poolLock);
    expect(poolLock).toBeLessThan(upsert);
    expect(upsert).toBeLessThan(fill);
    expect(upsert).toBeLessThan(link);
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

  it("transactionally validates and updates external member routing and capacity policy", async () => {
    db.poolMember.findUnique
      .mockResolvedValueOnce({
        id: "provider-primary-member",
        poolId: "pool-id",
        ModelPool: { userId: "user-id" },
      })
      .mockResolvedValueOnce({
        id: "provider-primary-member",
        poolId: "pool-id",
        tier: "PUBLIC_OVERFLOW",
        publicOrder: 0,
        weight: 0,
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
          fallbackEnabled: false,
          capacityConcurrencyLimit: 6,
          capacityReservedSlots: 1,
        },
      });
    db.poolMember.findMany.mockResolvedValue([]);
    db.poolMember.update.mockResolvedValue({
      id: "provider-primary-member",
      weight: 0,
      routingStatus: "ACTIVE",
      tier: "PUBLIC_OVERFLOW",
      publicOrder: 0,
    });

    await expect(
      httpClient().updatePoolMember({
        id: "provider-primary-member",
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
    ).resolves.toMatchObject({ id: "provider-primary-member", tier: "PUBLIC_OVERFLOW" });

    expect(db.poolMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "provider-primary-member" },
        data: expect.objectContaining({
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
      tier: "PUBLIC_OVERFLOW",
      publicOrder: 0,
      weight: 0,
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
        fallbackEnabled: false,
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
      tier: "PUBLIC_OVERFLOW",
      publicOrder: 0,
      weight: 0,
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
        fallbackEnabled: false,
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
      weight: 0,
      routingStatus: "ACTIVE",
      tier: "PUBLIC_OVERFLOW",
      publicOrder: 0,
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
      fallbackEnabled: true,
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
    expect(db.executionTarget.updateMany).toHaveBeenCalledWith({
      where: { id: "provider-target", capacityAssignmentSource: "AUTO" },
      data: { inferenceCapacityId: "provider-capacity-id", capacityAssignmentSource: "OWNER" },
    });
  });

  it("rejects attaching an external member when inherited pool capacity exceeds its hard limit", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      id: "pool-id",
      fallbackEnabled: false,
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
        tier: "PUBLIC_OVERFLOW",
        publicOrder: 0,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.providerBudgetPolicy.findFirst).not.toHaveBeenCalled();
    expect(db.poolMember.create).not.toHaveBeenCalled();
  });

  it("never attaches a provider model at the PRIMARY tier", async () => {
    await expect(
      client().addProviderPoolMember({
        poolId: "pool-id",
        providerModelId: "provider-model",
        tier: "PRIMARY",
        weight: 7,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("external fallback"),
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.poolMember.create).not.toHaveBeenCalled();
  });

  it("attaches an external member while fallback is off, without any acknowledgement", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      id: "private-pool",
      name: "Private",
      fallbackEnabled: false,
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
    db.poolMember.create.mockResolvedValue({ id: "external-provider-member" });
    db.poolMember.findMany.mockResolvedValue([]);

    await expect(
      client().addProviderPoolMember({
        poolId: "private-pool",
        providerModelId: "provider-model",
        tier: "PUBLIC_OVERFLOW",
        publicOrder: 0,
      }),
    ).resolves.toEqual({
      id: "external-provider-member",
      executionTargetId: "provider-target",
    });
    expect(db.poolMember.create).toHaveBeenCalledWith({
      data: {
        poolId: "private-pool",
        executionTargetId: "provider-target",
        tier: "PUBLIC_OVERFLOW",
        publicOrder: 0,
        weight: 0,
      },
      select: { id: true },
    });
    // Fallback stays off: nothing about the pool's consent changes.
    expect(db.modelPool.update).not.toHaveBeenCalled();
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
      fallbackEnabled: false,
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
    // A grant links two owners' graphs: both owner fences (sorted, one call)
    // before the pool row lock and the upsert; the revoke takes the same
    // fences before its single delete statement.
    expect(fenceCalls()).toEqual([
      ["00:owner:grantee-id", "00:owner:user-id"],
      ["00:owner:grantee-id", "00:owner:user-id"],
    ]);
    const calls = db.$queryRaw.mock.calls as unknown[][];
    const order = db.$queryRaw.mock.invocationCallOrder;
    const poolLock = calls.findIndex((call) =>
      /FROM model_pool[\s\S]*FOR NO KEY UPDATE/.test(sqlOf(call)),
    );
    expect(order[0] ?? Number.NaN).toBeLessThan(order[poolLock] ?? Number.NaN);
    expect(order[poolLock] ?? Number.NaN).toBeLessThan(
      db.poolGrant.upsert.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(lastFenceOrder()).toBeLessThan(
      db.poolGrant.deleteMany.mock.invocationCallOrder[0] ?? Number.NaN,
    );
  });

  it("grants access to a pool with external fallback without any egress acknowledgement", async () => {
    db.modelPool.findUnique.mockResolvedValue({
      id: "pool-id",
      userId: "user-id",
      fallbackEnabled: true,
    });
    db.user.findFirst.mockResolvedValue({ id: "grantee-id" });
    db.poolGrant.upsert.mockResolvedValue({
      id: "grant-id",
      poolId: "pool-id",
      granteeUserId: "grantee-id",
    });

    await expect(
      client().grantPoolAccessByEmail({ poolId: "pool-id", email: "friend@example.com" }),
    ).resolves.toMatchObject({ id: "grant-id" });
    // A grantee's data leaves only with its own `:external` opt-in and the
    // owner's fallbackForGrantees; the grant itself never inspects members.
    expect(db.poolMember.findFirst).not.toHaveBeenCalled();
    expect(db.poolGrant.upsert).toHaveBeenCalled();
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
    db.cacheAffinityNode.count.mockResolvedValue(3);
    db.cacheAffinityNode.deleteMany.mockResolvedValue({ count: 3 });
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
    expect(stats.activeNodes).toBe(3);
    expect(cleared).toEqual({ deleted: 10 });
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

  describe("poolCacheStats", () => {
    function cacheRow(overrides: Record<string, unknown> = {}) {
      return {
        bucketStart: new Date(Date.now() - 5 * 60_000),
        poolMemberId: "member-a",
        requests: 10n,
        cacheReadTokens: 40n,
        cacheKnownRequests: 8n,
        cacheKnownInputTokens: 80n,
        continuationRequests: 4n,
        continuationInputTokens: 40n,
        continuationCacheReadTokens: 30n,
        ...overrides,
      };
    }

    it("lets the owner see every requester on their pool", async () => {
      db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
      db.$queryRaw.mockResolvedValue([cacheRow()]);
      const stats = await client().poolCacheStats({ poolId: "pool-id", lastMinutes: 60 });
      expect(stats.hitRate).toBeCloseTo(0.5);
      expect(stats.continuationHitRate).toBeCloseTo(0.75);
      expect(db.poolGrant.findFirst).not.toHaveBeenCalled();
      const dumped = JSON.stringify(db.$queryRaw.mock.calls);
      expect(dumped).toContain("ownerUserId");
      expect(dumped).toContain("usage_rollup_minute");
    });

    it("lets a grantee see only their own requests", async () => {
      db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "owner-id" });
      db.poolGrant.findFirst.mockResolvedValue({ id: "grant-id" });
      db.$queryRaw.mockResolvedValue([cacheRow({ continuationInputTokens: 0n })]);
      const grantee = createRouterClient(forwarderManagementRouter, {
        context: buildContext({ user: { id: "grantee-id" } }),
      });
      const stats = await grantee.poolCacheStats({ poolId: "pool-id", lastMinutes: 60 });
      expect(stats.hitRate).toBeCloseTo(0.5);
      expect(stats.continuationHitRate).toBeNull();
      expect(db.poolGrant.findFirst).toHaveBeenCalledWith({
        where: { poolId: "pool-id", granteeUserId: "grantee-id" },
        select: { id: true },
      });
      const dumped = JSON.stringify(db.$queryRaw.mock.calls);
      expect(dumped).toContain("requesterUserId");
      expect(dumped).toContain("ownerUserId");
    });

    it("returns NOT_FOUND for a foreign pool or member", async () => {
      db.modelPool.findUnique.mockResolvedValue(null);
      await expect(
        client().poolCacheStats({ poolId: "missing", lastMinutes: 60 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(db.$queryRaw.mock.calls.some((call) => !isFenceCall(call))).toBe(false);

      db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "other-user" });
      db.poolGrant.findFirst.mockResolvedValue(null);
      await expect(
        client().poolCacheStats({ poolId: "pool-id", lastMinutes: 60 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
      db.poolMember.findUnique.mockResolvedValue({ id: "member-x", poolId: "other-pool" });
      await expect(
        client().poolCacheStats({
          poolId: "pool-id",
          poolMemberId: "member-x",
          lastMinutes: 60,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
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

    it("accepts an adapted-only override when the pool adaptation flag is on", async () => {
      db.modelPool.findUnique.mockResolvedValue(
        surfacePoolRow({ protocolAdaptationEnabled: true }),
      );
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("member-a", "chat")]);
      db.modelPool.update.mockResolvedValue(surfacePoolRow({ protocolAdaptationEnabled: true }));

      await expect(
        client().updateModelPool({ id: "pool-id", recommendedSurfaceOverride: "OPENAI_RESPONSES" }),
      ).resolves.toMatchObject({ id: "pool-id" });
      expect(db.modelPool.update).toHaveBeenCalledTimes(1);
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

    it("skips the surface fence for provider overflow attaches", async () => {
      db.modelPool.findFirst.mockResolvedValue({
        id: "pool-id",
        fallbackEnabled: true,
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
      // Writer class M: the parent-delete fences come first in the delete
      // transaction, before the pool row lock and the DELETE.
      expect(fenceParentDelete).toHaveBeenCalledWith(expect.anything(), {
        userId: "user-id",
        poolMemberIds: ["member-a"],
      });
      const fenceOrder = fenceParentDelete.mock.invocationCallOrder.at(-1) ?? Number.NaN;
      const poolLockIndex = db.$queryRaw.mock.calls.findIndex((call) =>
        (call[0] as readonly string[]).join("?").includes("FROM model_pool"),
      );
      expect(fenceOrder).toBeLessThan(
        db.$queryRaw.mock.invocationCallOrder[poolLockIndex] ?? Number.NaN,
      );
      expect(fenceOrder).toBeLessThan(
        db.poolMember.delete.mock.invocationCallOrder.at(-1) ?? Number.NaN,
      );
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

    it("removeEndpointMetadata passes endpointIds in the parent-delete fence scope", async () => {
      db.endpoint.findUnique.mockResolvedValue({
        id: "endpoint-id",
        userId: "user-id",
        cliDeviceId: "cli-device-id",
        lastSeenAt: null,
      });
      db.endpoint.delete.mockResolvedValue({ id: "endpoint-id" });

      await expect(client().removeEndpointMetadata({ id: "endpoint-id" })).resolves.toEqual({
        deleted: true,
      });
      // The fences (owner fences of every user the cascade writes) are the
      // first statement of the delete transaction; the cascade is resolved
      // under them, so no target plan is passed in.
      expect(fenceParentDelete).toHaveBeenCalledWith(expect.anything(), {
        userId: "user-id",
        endpointIds: ["endpoint-id"],
      });
      const fenceOrder = fenceParentDelete.mock.invocationCallOrder.at(-1) ?? Number.NaN;
      // Precheck read, then (under the fences) the owner re-read and the delete.
      expect(fenceOrder).toBeLessThan(
        db.endpoint.findUnique.mock.invocationCallOrder[1] ?? Number.NaN,
      );
      expect(fenceOrder).toBeLessThan(
        db.endpoint.delete.mock.invocationCallOrder.at(-1) ?? Number.NaN,
      );
    });

    it("removeDiscoveredModelMetadata computes the post-deletion surface after capturing affected pools", async () => {
      db.discoveredModel.findUnique.mockResolvedValue({
        id: "model-id",
        userId: "user-id",
        lastSeenAt: null,
        Endpoint: { cliDeviceId: "cli-device-id" },
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
      // The parent-delete fences precede the DELETE.
      expect(fenceParentDelete).toHaveBeenCalledWith(expect.anything(), {
        userId: "user-id",
        discoveredModelIds: ["model-id"],
      });
      expect(fenceParentDelete.mock.invocationCallOrder.at(-1) ?? Number.NaN).toBeLessThan(
        db.discoveredModel.delete.mock.invocationCallOrder.at(-1) ?? Number.NaN,
      );
    });

    describe("deletion CONFLICT reasons", () => {
      const recent = new Date("2026-06-01T00:00:00Z");
      const staleBefore = new Date("2026-05-31T00:00:00Z");

      it("endpoint: a recent precheck heartbeat is not_stale", async () => {
        db.endpoint.findUnique.mockResolvedValue({ userId: "user-id", lastSeenAt: recent });
        await expect(
          client().removeEndpointMetadata({ id: "endpoint-id", staleBefore }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message: "Endpoint is not stale.",
          data: { reason: "not_stale" },
        });
        expect(fenceParentDelete).not.toHaveBeenCalled();
      });

      it("endpoint: a heartbeat under the locks is not_stale", async () => {
        db.endpoint.findUnique
          .mockResolvedValueOnce({ userId: "user-id", lastSeenAt: null })
          .mockResolvedValueOnce({ id: "endpoint-id", userId: "user-id", cliDeviceId: "cli" })
          .mockResolvedValueOnce({ lastSeenAt: recent });
        db.executionTarget.findMany.mockResolvedValue([]);
        await expect(
          client().removeEndpointMetadata({ id: "endpoint-id", staleBefore }),
        ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "not_stale" } });
        expect(db.endpoint.delete).not.toHaveBeenCalled();
      });

      it("discovered model: precheck and under-lock heartbeats are not_stale", async () => {
        db.discoveredModel.findUnique.mockResolvedValueOnce({
          userId: "user-id",
          lastSeenAt: recent,
        });
        await expect(
          client().removeDiscoveredModelMetadata({ id: "model-id", staleBefore }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message: "Discovered model is not stale.",
          data: { reason: "not_stale" },
        });
        db.discoveredModel.findUnique
          .mockResolvedValueOnce({ userId: "user-id", lastSeenAt: null })
          .mockResolvedValueOnce({
            id: "model-id",
            userId: "user-id",
            Endpoint: { cliDeviceId: "cli" },
          })
          .mockResolvedValueOnce({ lastSeenAt: recent });
        db.executionTarget.findMany.mockResolvedValue([]);
        await expect(
          client().removeDiscoveredModelMetadata({ id: "model-id", staleBefore }),
        ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "not_stale" } });
        expect(db.discoveredModel.delete).not.toHaveBeenCalled();
      });

      it("pool: a plain delete after the parent-delete fences (no history drain)", async () => {
        db.modelPool.findUnique.mockResolvedValue({
          id: "pool-id",
          userId: "user-id",
          fallbackEnabled: false,
        });
        db.modelPool.delete.mockResolvedValue({ id: "pool-id" });
        await expect(client().deleteModelPool({ id: "pool-id" })).resolves.toEqual({
          deleted: true,
        });
        expect(fenceParentDelete).toHaveBeenCalledWith(expect.anything(), {
          userId: "user-id",
          poolIds: ["pool-id"],
        });
        expect(fenceParentDelete.mock.invocationCallOrder.at(-1) ?? Number.NaN).toBeLessThan(
          db.modelPool.delete.mock.invocationCallOrder.at(-1) ?? Number.NaN,
        );
      });

      it("pool: an owner set that keeps changing under the fences is delete_contended", async () => {
        db.modelPool.findUnique.mockResolvedValue({
          id: "pool-id",
          userId: "user-id",
          fallbackEnabled: false,
        });
        fenceParentDelete.mockRejectedValue(new FenceSetChangedError());
        try {
          await expect(client().deleteModelPool({ id: "pool-id" })).rejects.toMatchObject({
            code: "CONFLICT",
            data: { reason: "delete_contended" },
          });
        } finally {
          fenceParentDelete.mockReset();
          fenceParentDelete.mockImplementation(async () => []);
        }
        // Retried with a fresh plan each time, never deleting.
        expect(db.$transaction).toHaveBeenCalledTimes(5);
        expect(db.modelPool.delete).not.toHaveBeenCalled();
      });
    });
  });
});

describe("MCP pool summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pages pool summaries without member models and returns the full pool from get", async () => {
    db.modelPool.findMany.mockResolvedValue([
      {
        id: "pool-id",
        createdAt: new Date("2026-01-03T00:00:00Z"),
        slug: "general",
        name: "General",
        PoolGrants: [
          {
            id: "grant-id",
            createdAt: new Date("2026-01-04T00:00:00Z"),
            granteeUserId: "grantee",
            protectionOverridePercent: null,
            queuePriority: null,
            Grantee: { email: "g@example.com", name: "G" },
          },
        ],
        PoolMembers: [
          {
            id: "member-id",
            tier: "PRIMARY",
            healthStatus: "HEALTHY",
            routingStatus: "ACTIVE",
            DiscoveredModel: {
              upstreamModelId: "should-not-leak",
              capabilityOverrideMetadata: { chatCompletions: { supported: true } },
              Endpoint: {
                slug: "local",
                capabilityMetadata: { chatCompletions: { supported: true } },
                CliDevice: { slug: "desk" },
              },
            },
            ExecutionTarget: {
              DiscoveredModel: {
                upstreamModelId: "target-model",
                Endpoint: {
                  slug: "gpu",
                  capabilityMetadata: { responses: { supported: true } },
                  CliDevice: { slug: "gx10" },
                },
              },
            },
          },
          {
            id: "provider-member-id",
            tier: "PUBLIC_OVERFLOW",
            healthStatus: "HEALTHY",
            routingStatus: "ACTIVE",
            DiscoveredModel: null,
            ExecutionTarget: {
              DiscoveredModel: null,
              ProviderModel: {
                id: "provider-model-id",
                upstreamModelId: "anthropic/claude",
                displayName: "Claude",
                ProviderAccount: { label: "OpenRouter" },
              },
            },
          },
        ],
      },
    ]);

    const page = await client().listModelPoolSummaries({});
    expect(page.nextCursor).toBeNull();
    expect(db.modelPool.findMany.mock.calls[0]?.[0]?.take).toBe(21);
    expect(page.items).toEqual([
      {
        id: "pool-id",
        slug: "general",
        name: "General",
        grantCount: 1,
        memberCount: 2,
        grants: [
          {
            id: "grant-id",
            createdAt: new Date("2026-01-04T00:00:00Z"),
            granteeUserId: "grantee",
            granteeEmail: "g@example.com",
            granteeName: "G",
            protectionOverridePercent: null,
            queuePriority: null,
            fallbackSpend: null,
          },
        ],
        members: [
          {
            id: "member-id",
            tier: "PRIMARY",
            routingStatus: "ACTIVE",
            healthStatus: "HEALTHY",
            kind: "LOCAL",
            endpointSlug: "gpu",
            cliDeviceSlug: "gx10",
            providerAccountLabel: null,
            providerModel: null,
          },
          {
            id: "provider-member-id",
            tier: "PUBLIC_OVERFLOW",
            routingStatus: "ACTIVE",
            healthStatus: "HEALTHY",
            kind: "PROVIDER",
            endpointSlug: null,
            cliDeviceSlug: null,
            providerAccountLabel: "OpenRouter",
            providerModel: "Claude",
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("target-model");
    expect(serialized).not.toContain("chatCompletions");
    const memberSelect = db.modelPool.findMany.mock.calls[0]?.[0]?.select?.PoolMembers?.select;
    expect(memberSelect?.DiscoveredModel?.select).not.toHaveProperty("upstreamModelId");
    expect(memberSelect?.DiscoveredModel?.select).not.toHaveProperty("capabilityOverrideMetadata");
    expect(memberSelect?.ExecutionTarget?.select?.DiscoveredModel?.select).not.toHaveProperty(
      "capabilityMetadata",
    );
    expect(memberSelect?.ExecutionTarget?.select?.ProviderModel?.select).toMatchObject({
      id: true,
      upstreamModelId: true,
      displayName: true,
      ProviderAccount: { select: { label: true } },
    });

    db.modelPool.findUnique.mockResolvedValueOnce({ ...poolRow(), userId: "user-id" });
    const full = await client().getModelPool({ poolId: "pool-id" });
    expect(full).toMatchObject({ id: "pool-id", slug: "general", members: [] });
    expect(full).toHaveProperty("compatibility");

    db.modelPool.findUnique.mockResolvedValueOnce(null);
    await expect(client().getModelPool({ poolId: "missing" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("NOT_FOUND");
        return true;
      },
    );
  });
});

function disclosurePool() {
  return {
    id: "disclosure-pool",
    userId: "owner-private",
    slug: "shared",
    name: "Shared",
    description: null,
    fallbackEnabled: true,
    fallbackForGrantees: true,
    User: { slug: "owner" },
    PoolGrants: [],
    PoolMembers: [
      {
        id: "private-member",
        tier: "PUBLIC_OVERFLOW",
        healthStatus: "UNHEALTHY",
        ExecutionTarget: {
          id: "private-target",
          providerModelId: "private-provider-model",
          ProviderModel: {
            id: "private-provider-model",
            upstreamModelId: "private-upstream",
            PricingVersions: [],
            ProviderAccount: {
              id: "private-account-id",
              label: "Owner private billing label",
              providerType: "openrouter",
              baseUrl: "https://owner-private.example.test",
              credentialMetadata: "private-credential",
            },
          },
        },
      },
    ],
  };
}

describe("provider disclosure at the serialized API boundary", () => {
  it.each([
    ["owner", true, true, true, true],
    ["eligible grantee", false, true, true, true],
    ["grantee coverage off", false, true, true, false],
    ["deployment off", false, false, true, true],
    ["fallback off", false, true, false, true],
  ] as const)(
    "visibleModels: %s",
    async (_case, owner, enabled, fallbackEnabled, fallbackForGrantees) => {
      const { env } = await import("@ws-model-proxy/env/server");
      env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = enabled;
      const row = {
        ...disclosurePool(),
        fallbackEnabled,
        fallbackForGrantees,
        userId: owner ? "user-id" : "owner-private",
      };
      db.appSetting.findUnique.mockResolvedValue(null);
      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockImplementation(async (args: { where?: { userId?: string } }) =>
        args.where?.userId ? (owner ? [row] : []) : [row],
      );
      db.poolGrant.findMany.mockResolvedValue(owner ? [] : [{ id: "live-grant", ModelPool: row }]);
      db.poolMember.findMany.mockResolvedValue([]);
      try {
        const result = await httpClient().visibleModels();
        const wire = JSON.stringify(result);
        const pool = result.modelPools[0];
        const eligible = enabled && fallbackEnabled && (owner || fallbackForGrantees);
        expect(pool?.providerAccountLabels).toEqual(
          owner && fallbackEnabled ? ["Owner private billing label"] : [],
        );
        expect(pool).toHaveProperty("providerTypes", eligible ? ["openrouter"] : []);
        if (!owner) {
          expect(wire).not.toMatch(
            /Owner private billing label|private-account-id|owner-private\.example|private-credential|private-provider-model|private-upstream|private-target|private-member/,
          );
          if (!eligible) expect(wire).not.toContain("openrouter");
        }
      } finally {
        env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
      }
    },
  );
});

it("omits a shared pool entirely after its grant is revoked", async () => {
  db.appSetting.findUnique.mockResolvedValue(null);
  db.discoveredModel.findMany.mockResolvedValue([]);
  db.modelPool.findMany.mockResolvedValue([]);
  db.poolGrant.findMany.mockResolvedValue([]);
  const result = await httpClient().visibleModels();
  expect(result.modelPools).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/openrouter|Owner private billing label/);
});
