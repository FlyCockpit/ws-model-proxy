import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import type { Prisma } from "@ws-model-proxy/db";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {},
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { capacityManagementRouter } = await import("./capacity-management");
const { backfillDiscoveredInferenceCapacities, ensureDiscoveredInferenceCapacity } = await import(
  "../lib/discovered-inference-capacity"
);
const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  $transaction: MockInstance;
  appSetting: { findUnique: MockInstance };
  inferenceCapacity: {
    findMany: MockInstance;
    findUnique: MockInstance;
    create: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    upsert: MockInstance;
    delete: MockInstance;
  };
  executionTarget: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  modelPool: { findUnique: MockInstance; update: MockInstance };
  poolMember: { findUnique: MockInstance; findMany: MockInstance; update: MockInstance };
  capacityAuditEvent: { create: MockInstance; findMany: MockInstance };
};

const context: Context = {
  session: {
    user: {
      id: "owner",
      email: "owner@example.com",
      name: "Owner",
      emailVerified: true,
      role: "user",
      twoFactorEnabled: false,
      image: null,
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    session: {
      id: "session",
      userId: "owner",
      token: "token",
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as Session,
};

function httpClient(captures?: Array<{ status: number; body: string }>) {
  const handler = new RPCHandler(capacityManagementRouter);
  const link = new RPCLink({
    url: "https://example.test/rpc",
    fetch: async (request, init) => {
      const result = await handler.handle(new Request(request, init), {
        prefix: "/rpc",
        context,
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
    typeof createRouterClient<typeof capacityManagementRouter>
  >;
}

describe("capacityManagementRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.capacityAuditEvent.create.mockResolvedValue({ id: "audit" });
  });

  it("lists owner-scoped capacities with aggregate load only", async () => {
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(client.list()).resolves.toEqual([]);
    expect(db.inferenceCapacity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner" },
        include: {
          _count: {
            select: {
              ExecutionTargets: true,
              CapacityLeases: { where: { state: "ACTIVE" } },
              CapacityWaiters: { where: { state: "WAITING" } },
            },
          },
        },
      }),
    );
  });

  it("writes capacity creation and policy mutation audits in the same transaction", async () => {
    db.inferenceCapacity.create.mockResolvedValue({ id: "capacity", userId: "owner" });
    const client = createRouterClient(capacityManagementRouter, { context });
    await client.create({
      label: "GPU",
      runtimeIdentityKey: "host:model",
      runtimeModel: "model",
      hardConcurrencyLimit: 2,
      physicalMaxContext: 4096,
      countStrategy: "CONSERVATIVE_ESTIMATE",
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.capacityAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner",
        actorUserId: "owner",
        action: "CREATE",
        resourceType: "INFERENCE_CAPACITY",
        resourceId: "capacity",
      }),
    });
  });

  it("lists audit history only for its owner", async () => {
    db.capacityAuditEvent.findMany.mockResolvedValue([]);
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(client.listAudit({ limit: 10 })).resolves.toEqual([]);
    expect(db.capacityAuditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner" }, take: 10 }),
    );
  });

  it("makes a cross-owner target or capacity indistinguishable from missing", async () => {
    db.executionTarget.findUnique.mockResolvedValue({ userId: "other" });
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(
      client.updateDirectPolicy({
        executionTargetId: "guessed-target",
        inferenceCapacityId: "guessed-capacity",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.inferenceCapacity.findUnique).not.toHaveBeenCalled();
    expect(db.executionTarget.update).not.toHaveBeenCalled();
  });

  it("rejects guessed capacity graph substitutions at the HTTP boundary", async () => {
    db.inferenceCapacity.findUnique.mockResolvedValue(null);
    db.executionTarget.findUnique.mockResolvedValue(null);
    db.modelPool.findUnique.mockResolvedValue(null);
    db.poolMember.findUnique.mockResolvedValue(null);
    const captures: Array<{ status: number; body: string }> = [];
    const client = httpClient(captures);
    const attempts = [
      client.update({ id: "foreign-capacity", label: "guess" }),
      client.remove({ id: "foreign-capacity" }),
      client.updateDirectPolicy({
        executionTargetId: "foreign-target",
        inferenceCapacityId: "foreign-capacity",
      }),
      client.updatePoolPolicy({
        modelPoolId: "foreign-pool",
        capacityPriority: 10,
      }),
      client.updateMemberPolicy({
        poolMemberId: "foreign-member",
        capacityPriority: 10,
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
        "foreign-capacity",
        "foreign-target",
        "foreign-pool",
        "foreign-member",
      ])
        expect(capture.body).not.toContain(identifier);
    }
    expect(db.executionTarget.update).not.toHaveBeenCalled();
    expect(db.modelPool.update).not.toHaveBeenCalled();
    expect(db.poolMember.update).not.toHaveBeenCalled();
  });

  it("rejects deleting attached capacity and invalid policy bounds", async () => {
    db.inferenceCapacity.findUnique.mockResolvedValue({
      userId: "owner",
      _count: { ExecutionTargets: 1 },
    });
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(client.remove({ id: "capacity" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.updateDirectPolicy({ executionTargetId: "target", directPriority: 32 }),
    ).rejects.toBeTruthy();
    expect(db.inferenceCapacity.delete).not.toHaveBeenCalled();
  });

  it("rejects lossy collapse through the pool-policy path when adaptation is disabled", async () => {
    db.modelPool.findUnique.mockResolvedValue({
      id: "pool",
      userId: "owner",
      PoolMembers: [],
      capacityPriority: 16,
      capacityConcurrencyLimit: null,
      capacityReservedSlots: 0,
      capacityBorrowPolicy: "WHEN_IDLE",
      capacityWaitBudgetMs: null,
      capacityContextCeiling: null,
      capacityContextMargin: 0,
      protocolAdaptationEnabled: false,
      allowLossyDeveloperRoleCollapse: false,
    });
    const client = createRouterClient(capacityManagementRouter, { context });

    await expect(
      client.updatePoolPolicy({ modelPoolId: "pool", allowLossyDeveloperRoleCollapse: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  describe("updatePoolPolicy recommended-surface gate", () => {
    const surfaceMemberRow = (native: "chat" | "responses") => ({
      id: `member-${native}`,
      tier: "PRIMARY",
      discoveredModelId: null,
      DiscoveredModel: null,
      ExecutionTarget: {
        DiscoveredModel: {
          capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrides: [],
          capabilityOverrideMetadata: null,
          Endpoint: {
            capabilityMetadata: {
              version: 1,
              protocol: "openai-compatible",
              ...(native === "chat"
                ? { chatCompletions: { supported: true, streaming: true } }
                : { responses: { supported: true, streaming: true } }),
            },
            defaultCapabilities: [],
          },
        },
        ProviderModel: null,
      },
    });

    function surfacePoolRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "pool",
        userId: "owner",
        PoolMembers: [],
        capacityPriority: 16,
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityBorrowPolicy: "WHEN_IDLE",
        capacityWaitBudgetMs: null,
        capacityContextCeiling: null,
        capacityContextMargin: 0,
        protocolAdaptationEnabled: false,
        allowLossyDeveloperRoleCollapse: false,
        recommendedSurfaceOverride: "OPENAI_RESPONSES",
        ...overrides,
      };
    }

    it("rejects disabling adaptation when the override only stays servable through it", async () => {
      db.modelPool.findUnique.mockResolvedValue(
        surfacePoolRow({ protocolAdaptationEnabled: true }),
      );
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("chat")]);
      const client = createRouterClient(capacityManagementRouter, { context });

      await expect(
        client.updatePoolPolicy({ modelPoolId: "pool", protocolAdaptationEnabled: false }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      });
      expect(db.modelPool.update).not.toHaveBeenCalled();
    });

    it("keeps adaptation-flag updates non-retroactive for unchanged or absent input", async () => {
      // Stored state is valid (adaptation on lets the chat primary serve the
      // responses override): re-asserting the same flag must still succeed.
      db.modelPool.findUnique.mockResolvedValue(
        surfacePoolRow({ protocolAdaptationEnabled: true }),
      );
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("chat")]);
      db.modelPool.update.mockResolvedValue(surfacePoolRow({ protocolAdaptationEnabled: true }));
      const client = createRouterClient(capacityManagementRouter, { context });
      await expect(
        client.updatePoolPolicy({ modelPoolId: "pool", protocolAdaptationEnabled: true }),
      ).resolves.toBeTruthy();
      expect(db.modelPool.update).toHaveBeenCalledTimes(1);

      // Absent adaptation input never triggers the gate: even a stranded
      // stored override (adapt off, responses override, chat-only primary)
      // still allows unrelated capacity-policy edits.
      vi.clearAllMocks();
      db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
        callback(db),
      );
      db.modelPool.findUnique.mockResolvedValue(surfacePoolRow());
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("chat")]);
      db.modelPool.update.mockResolvedValue(surfacePoolRow({ capacityPriority: 8 }));
      await expect(
        client.updatePoolPolicy({ modelPoolId: "pool", capacityPriority: 8 }),
      ).resolves.toBeTruthy();
      expect(db.modelPool.update).toHaveBeenCalledTimes(1);
      expect(db.poolMember.findMany).not.toHaveBeenCalled();
    });

    it("accepts enabling adaptation when the post-state serves the override", async () => {
      db.modelPool.findUnique.mockResolvedValue(surfacePoolRow());
      db.poolMember.findMany.mockResolvedValue([surfaceMemberRow("chat")]);
      db.modelPool.update.mockResolvedValue(surfacePoolRow({ protocolAdaptationEnabled: true }));
      const client = createRouterClient(capacityManagementRouter, { context });

      await expect(
        client.updatePoolPolicy({ modelPoolId: "pool", protocolAdaptationEnabled: true }),
      ).resolves.toBeTruthy();
      expect(db.modelPool.update).toHaveBeenCalledWith({
        where: { id: "pool" },
        data: expect.objectContaining({ protocolAdaptationEnabled: true }),
      });
    });
  });

  it("denies cross-owner capacity substitution and reserved overcommit", async () => {
    db.executionTarget.findUnique.mockResolvedValue({ userId: "owner" });
    db.inferenceCapacity.findUnique
      .mockResolvedValueOnce({ userId: "other", hardConcurrencyLimit: 2 })
      .mockResolvedValueOnce({ userId: "owner", hardConcurrencyLimit: 2 });
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(
      client.updateDirectPolicy({ executionTargetId: "target", inferenceCapacityId: "other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      client.updateDirectPolicy({
        executionTargetId: "target",
        inferenceCapacityId: "own",
        directReservedSlots: 3,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.executionTarget.update).not.toHaveBeenCalled();
  });

  it("validates direct changes against the already attached capacity", async () => {
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target",
      userId: "owner",
      inferenceCapacityId: "capacity",
      directConcurrencyLimit: null,
      directReservedSlots: 0,
      InferenceCapacity: { hardConcurrencyLimit: 2 },
    });
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(
      client.updateDirectPolicy({ executionTargetId: "target", directConcurrencyLimit: 3 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.executionTarget.update).not.toHaveBeenCalled();
  });

  it("rejects a capacity attachment that invalidates any inherited membership policy", async () => {
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target",
      userId: "owner",
      inferenceCapacityId: null,
      directConcurrencyLimit: null,
      directReservedSlots: 0,
      InferenceCapacity: null,
      PoolMembers: [
        {
          capacityConcurrencyMode: "INHERIT",
          capacityConcurrencyLimit: null,
          capacityReservedSlots: null,
          ModelPool: { capacityConcurrencyLimit: 4, capacityReservedSlots: 0 },
        },
      ],
    });
    db.inferenceCapacity.findUnique.mockResolvedValue({
      userId: "owner",
      hardConcurrencyLimit: 2,
    });
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(
      client.updateDirectPolicy({
        executionTargetId: "target",
        inferenceCapacityId: "capacity",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.executionTarget.update).not.toHaveBeenCalled();
  });

  it("marks every user-authored hard limit USER, including explicit unlimited", async () => {
    db.inferenceCapacity.create.mockResolvedValue({ id: "capacity", userId: "owner" });
    const client = createRouterClient(capacityManagementRouter, { context });
    await client.create({
      label: "GPU",
      runtimeIdentityKey: "host:model",
      runtimeModel: "model",
      hardConcurrencyLimit: null,
      physicalMaxContext: null,
      countStrategy: "CONSERVATIVE_ESTIMATE",
    });
    expect(db.inferenceCapacity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        hardConcurrencyLimit: null,
        hardConcurrencyLimitSource: "USER",
      }),
    });

    const current = {
      id: "capacity",
      userId: "owner",
      hardConcurrencyLimit: 2,
      physicalMaxContext: null,
      ExecutionTargets: [],
    };
    db.inferenceCapacity.findUnique.mockResolvedValue(current);
    db.inferenceCapacity.update.mockResolvedValue(current);
    await client.update({ id: "capacity", hardConcurrencyLimit: 5 });
    expect(db.inferenceCapacity.update).toHaveBeenLastCalledWith({
      where: { id: "capacity" },
      data: { hardConcurrencyLimit: 5, hardConcurrencyLimitSource: "USER" },
    });

    // An edit that does not touch the limit leaves its source alone.
    await client.update({ id: "capacity", label: "Renamed" });
    expect(db.inferenceCapacity.update).toHaveBeenLastCalledWith({
      where: { id: "capacity" },
      data: { label: "Renamed" },
    });
  });

  it("keeps a saved unlimited limit through startup backfill and CLI re-registration", async () => {
    // One stateful auto-discovered capacity row shared by every code path.
    const row = {
      id: "cap_auto",
      userId: "owner",
      label: "Discovered model dm-1",
      runtimeIdentityKey: "execution-target:target-1",
      hardConcurrencyLimit: 1 as number | null,
      hardConcurrencyLimitSource: "AUTO" as "AUTO" | "USER",
      physicalMaxContext: null,
      ExecutionTargets: [],
    };
    type Where = {
      id?: string;
      userId?: string;
      hardConcurrencyLimit?: number | null;
      hardConcurrencyLimitSource?: "AUTO" | "USER";
      runtimeIdentityKey?: { in?: readonly string[] };
    };
    type Data = {
      hardConcurrencyLimit?: number | null;
      hardConcurrencyLimitSource?: "AUTO" | "USER";
    };
    const matches = (where: Where) =>
      (where.id === undefined || where.id === row.id) &&
      (where.userId === undefined || where.userId === row.userId) &&
      (where.hardConcurrencyLimit === undefined ||
        where.hardConcurrencyLimit === row.hardConcurrencyLimit) &&
      (where.hardConcurrencyLimitSource === undefined ||
        where.hardConcurrencyLimitSource === row.hardConcurrencyLimitSource) &&
      (where.runtimeIdentityKey?.in === undefined ||
        where.runtimeIdentityKey.in.includes(row.runtimeIdentityKey));
    const apply = (data: Data) => {
      if ("hardConcurrencyLimit" in data)
        row.hardConcurrencyLimit = data.hardConcurrencyLimit ?? null;
      if (data.hardConcurrencyLimitSource)
        row.hardConcurrencyLimitSource = data.hardConcurrencyLimitSource;
    };
    db.inferenceCapacity.findUnique.mockImplementation(async () => ({ ...row }));
    db.inferenceCapacity.update.mockImplementation(async (args: { data: Data }) => {
      apply(args.data);
      return { ...row };
    });
    db.inferenceCapacity.updateMany.mockImplementation(
      async (args: { where: Where; data: Data }) => {
        if (!matches(args.where)) return { count: 0 };
        apply(args.data);
        return { count: 1 };
      },
    );
    db.inferenceCapacity.upsert.mockResolvedValue({ id: row.id });

    const client = createRouterClient(capacityManagementRouter, { context });
    await client.update({ id: row.id, hardConcurrencyLimit: null });
    expect(row).toMatchObject({ hardConcurrencyLimit: null, hardConcurrencyLimitSource: "USER" });

    // Startup backfill: the attached-target scan filters on AUTO, so a USER
    // row is not returned; simulate a stale scan that still lists it.
    db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "target-1",
        userId: "owner",
        discoveredModelId: "dm-1",
        inferenceCapacityId: row.id,
        InferenceCapacity: {
          runtimeIdentityKey: row.runtimeIdentityKey,
          hardConcurrencyLimit: null,
          hardConcurrencyLimitSource: "AUTO",
        },
      },
    ]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target-1",
      userId: "owner",
      kind: "DISCOVERED_MODEL",
      discoveredModelId: "dm-1",
      inferenceCapacityId: row.id,
    });
    await backfillDiscoveredInferenceCapacities();
    expect(row).toMatchObject({ hardConcurrencyLimit: null, hardConcurrencyLimitSource: "USER" });

    // CLI re-registration reports a finite concurrency for the same model.
    await ensureDiscoveredInferenceCapacity(db as unknown as Prisma.TransactionClient, {
      userId: "owner",
      discoveredModelId: "dm-1",
      upstreamModelId: "llama",
      executionTargetId: "target-1",
      reportedConcurrency: 4,
    });
    expect(row).toMatchObject({ hardConcurrencyLimit: null, hardConcurrencyLimitSource: "USER" });
  });

  it("rejects hard-limit reductions that invalidate attached direct or pool policies", async () => {
    db.inferenceCapacity.findUnique.mockResolvedValue({
      id: "capacity",
      userId: "owner",
      ExecutionTargets: [
        {
          directConcurrencyLimit: 4,
          directReservedSlots: 0,
          PoolMembers: [],
        },
      ],
    });
    const client = createRouterClient(capacityManagementRouter, { context });
    await expect(client.update({ id: "capacity", hardConcurrencyLimit: 3 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
  });

  it("requires coherent tagged member limits and normalizes legacy finite writes", async () => {
    db.poolMember.findUnique.mockResolvedValue({
      id: "member",
      capacityConcurrencyMode: "INHERIT",
      capacityConcurrencyLimit: null,
      capacityReservedSlots: null,
      ModelPool: {
        userId: "owner",
        capacityConcurrencyLimit: 4,
        capacityReservedSlots: 0,
      },
      ExecutionTarget: { InferenceCapacity: { hardConcurrencyLimit: 4 } },
    });
    db.poolMember.update.mockResolvedValue({ id: "member" });
    const client = createRouterClient(capacityManagementRouter, { context });

    await expect(
      client.updateMemberPolicy({
        poolMemberId: "member",
        capacityConcurrencyMode: "UNLIMITED",
        capacityConcurrencyLimit: 2,
      }),
    ).rejects.toBeTruthy();

    await client.updateMemberPolicy({
      poolMemberId: "member",
      capacityConcurrencyLimit: 2,
    });
    expect(db.poolMember.update).toHaveBeenCalledWith({
      where: { id: "member" },
      data: expect.objectContaining({
        capacityConcurrencyMode: "LIMITED",
        capacityConcurrencyLimit: 2,
      }),
    });

    await client.updateMemberPolicy({
      poolMemberId: "member",
      capacityConcurrencyMode: "UNLIMITED",
    });
    expect(db.poolMember.update).toHaveBeenLastCalledWith({
      where: { id: "member" },
      data: expect.objectContaining({
        capacityConcurrencyMode: "UNLIMITED",
        capacityConcurrencyLimit: null,
      }),
    });
  });
});
