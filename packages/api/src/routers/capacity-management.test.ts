import { createRouterClient } from "@orpc/server";
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
  appSetting: { findUnique: MockInstance };
  inferenceCapacity: {
    findMany: MockInstance;
    findUnique: MockInstance;
    create: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  executionTarget: { findUnique: MockInstance; update: MockInstance };
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

describe("capacityManagementRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
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
});
