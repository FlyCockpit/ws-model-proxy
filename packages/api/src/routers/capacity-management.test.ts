import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { MODEL_API_GLOBAL_CAPACITY_ENABLED: true },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { capacityManagementRouter } = await import("./capacity-management");
const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  $transaction: MockInstance;
  appSetting: { findUnique: MockInstance };
  inferenceCapacity: {
    findMany: MockInstance;
    findUnique: MockInstance;
    create: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  executionTarget: { findUnique: MockInstance; update: MockInstance };
  modelPool: { findUnique: MockInstance; update: MockInstance };
  poolMember: { findUnique: MockInstance; update: MockInstance };
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

function httpClient() {
  const handler = new RPCHandler(capacityManagementRouter);
  const link = new RPCLink({
    url: "https://example.test/rpc",
    fetch: async (request, init) => {
      const result = await handler.handle(new Request(request, init), {
        prefix: "/rpc",
        context,
      });
      return result.matched ? result.response : new Response(null, { status: 404 });
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
    const client = httpClient();
    const results = await Promise.allSettled([
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
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "NOT_FOUND" });
    }
    const serialized = JSON.stringify(results);
    for (const identifier of [
      "foreign-capacity",
      "foreign-target",
      "foreign-pool",
      "foreign-member",
    ])
      expect(serialized).not.toContain(identifier);
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
