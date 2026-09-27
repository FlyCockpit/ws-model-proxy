import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, expect, it, vi } from "vitest";
import type { Context } from "../context";

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    get WMP_PUBLIC_PROVIDER_EGRESS_ENABLED() {
      return state.enabled;
    },
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const { default: prisma } = await import("@ws-model-proxy/db");
const { mockDeep, mockReset } = await import("vitest-mock-extended");
const db = prisma as ReturnType<typeof mockDeep<typeof prisma>>;
const { poolFallbackPreferencesRouter } = await import("./pool-fallback-preferences");
function session(userId: string) {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
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
      id: `s-${userId}`,
      userId,
      token: "token",
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as Session;
}
const context: Context = { session: session("owner") };

const client = createRouterClient(poolFallbackPreferencesRouter, { context });
beforeEach(() => {
  mockReset(db);
  state.enabled = true;
  db.$transaction.mockImplementation(async (callback) => {
    if (typeof callback !== "function") throw new Error("expected transaction");
    return callback(db);
  });
  db.$queryRaw.mockResolvedValue([]);
});
it("empty preferences list is readable when disabled", async () => {
  state.enabled = false;
  db.poolGrant.findMany.mockResolvedValue([]);
  db.modelApiToken.findMany.mockResolvedValue([]);
  expect(await client.list()).toEqual({ enabled: false, pools: [] });
  expect(db.poolGrant.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { granteeUserId: "owner", ModelPool: { userId: { not: "owner" } } },
    }),
  );
});
it("disabled deployment refuses set but permits requester-scoped clear", async () => {
  state.enabled = false;
  await expect(client.set({ poolId: "pool", providerModelId: "model" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await client.clear({ poolId: "pool" });
  expect(db.poolFallbackPreference.deleteMany).toHaveBeenCalledWith({
    where: { poolId: "pool", userId: "owner" },
  });
  expect(db.poolFallbackPreference.upsert).not.toHaveBeenCalled();
});
it("refuses absent grant or undeclared equivalent", async () => {
  db.poolGrant.findFirst.mockResolvedValue(null);
  await expect(client.set({ poolId: "pool", providerModelId: "model" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(db.poolFallbackPreference.upsert).not.toHaveBeenCalled();
});
it("owner aggregate returns only a count after checking ownership", async () => {
  db.modelPool.findFirst.mockResolvedValue({ id: "pool" } as Awaited<
    ReturnType<typeof prisma.modelPool.findFirst>
  >);
  db.relayRequest.count.mockResolvedValue(9);
  expect(await client.ownerAggregate({ poolId: "pool" })).toEqual({ count: 9 });
  expect(db.modelPool.findFirst).toHaveBeenCalledWith({
    where: { id: "pool", userId: "owner" },
    select: { id: true },
  });
  expect(db.relayRequest.count).toHaveBeenCalledWith({
    where: { requestedModelPoolId: "pool", fallbackRoute: "own-key" },
  });
  expect(db.relayRequest.findMany).not.toHaveBeenCalled();
  db.modelPool.findFirst.mockResolvedValue(null);
  await expect(client.ownerAggregate({ poolId: "pool" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
it("sets the exact live grant and checks requester-owned enabled resources", async () => {
  db.poolGrant.findFirst.mockResolvedValue({ id: "grant" } as Awaited<
    ReturnType<typeof prisma.poolGrant.findFirst>
  >);
  db.providerModel.findFirst.mockResolvedValue({
    id: "model",
    providerAccountId: "account",
  } as Awaited<ReturnType<typeof prisma.providerModel.findFirst>>);
  db.poolFallbackPreference.upsert.mockResolvedValue({ providerModelId: "model" } as Awaited<
    ReturnType<typeof prisma.poolFallbackPreference.upsert>
  >);
  expect(await client.set({ poolId: "pool", providerModelId: "model" })).toEqual({
    providerModelId: "model",
  });
  expect(db.poolFallbackPreference.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: {
        poolId: "pool",
        providerModelId: "model",
        protocolAdaptationEnabled: false,
        userId: "owner",
        poolGrantId: "grant",
      },
    }),
  );
  expect(db.providerModel.findFirst).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        userId: "owner",
        enabled: true,
        deletedAt: null,
        ProviderAccount: expect.objectContaining({
          userId: "owner",
          enabled: true,
          deletedAt: null,
          CurrentCredential: { status: "ACTIVE" },
        }),
      }),
    }),
  );
});
