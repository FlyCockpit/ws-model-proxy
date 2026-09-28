import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const { poolFallbackRouter } = await import("./pool-fallback");

function session(userId: string, sessionId = `s-${userId}`) {
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
      id: sessionId,
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

function clientFor(userId: string, sessionId?: string) {
  const context: Context = { session: session(userId, sessionId) };
  return createRouterClient(poolFallbackRouter, { context });
}

const SETTINGS = { fallbackEnabled: false, fallbackForGrantees: false, externalAfterWaitMs: 2000 };

beforeEach(() => {
  mockReset(db);
  state.enabled = true;
  db.$transaction.mockImplementation(async (callback) => {
    if (typeof callback !== "function") throw new Error("expected transaction");
    return callback(db);
  });
  db.$queryRaw.mockResolvedValue([]);
});

function ownerPoolRow() {
  return {
    id: "pool",
    slug: "pool",
    ...SETTINGS,
    fallbackEnabled: true,
    externalEquivalentModel: "vendor/model",
    User: { slug: "owner" },
    PoolMembers: [
      {
        id: "member-a",
        tier: "PUBLIC_OVERFLOW",
        publicOrder: 0,
        ExecutionTarget: {
          ProviderModel: {
            id: "provider-model",
            upstreamModelId: "vendor/model",
            enabled: true,
            deletedAt: null,
            ProviderAccount: {
              id: "account",
              label: "Owner OpenRouter",
              providerType: "openrouter",
              enabled: true,
              deletedAt: null,
            },
          },
        },
      },
    ],
  };
}

describe("poolFallback.get", () => {
  it("returns the owner's switches, ordered external members and own-key count", async () => {
    db.modelPool.findFirst.mockResolvedValue(ownerPoolRow() as never);
    db.relayRequest.count.mockResolvedValue(4);
    const view = await clientFor("owner").get({ poolId: "pool" });
    expect(view).toMatchObject({
      role: "owner",
      poolId: "pool",
      modelId: "owner/pool",
      fallbackEnabled: true,
      fallbackForGrantees: false,
      externalAfterWaitMs: 2000,
      externalEquivalentModel: "vendor/model",
      effectiveProviderEgress: true,
      ownKeyRequestCount: 4,
      members: [
        {
          memberId: "member-a",
          publicOrder: 0,
          providerType: "openrouter",
          providerAccountLabel: "Owner OpenRouter",
          enabled: true,
        },
      ],
    });
    expect(db.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pool", userId: "owner" } }),
    );
    expect(db.relayRequest.count).toHaveBeenCalledWith({
      where: { requestedModelPoolId: "pool", fallbackRoute: "own-key", status: "SUCCEEDED" },
    });
  });

  it("gives grantees provider types only, never the owner's labels or members", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    db.poolGrant.findFirst.mockResolvedValue({
      ModelPool: {
        id: "pool",
        slug: "pool",
        fallbackEnabled: true,
        fallbackForGrantees: true,
        externalEquivalentModel: "vendor/model",
        User: { slug: "owner" },
        PoolMembers: [
          {
            tier: "PUBLIC_OVERFLOW",
            // What a wider select would return: the owner's account id and
            // label must still never reach the grantee view.
            id: "owner-member",
            ExecutionTarget: {
              ProviderModel: {
                upstreamModelId: "owner/private-model",
                ProviderAccount: {
                  id: "owner-account",
                  label: "Owner OpenRouter",
                  providerType: "openrouter",
                },
              },
            },
          },
        ],
      },
      FallbackPreferences: [],
    } as never);
    db.modelApiToken.findMany.mockResolvedValue([]);
    const view = await clientFor("grantee").get({ poolId: "pool" });
    expect(view).toMatchObject({
      role: "grantee",
      poolFallback: { available: true, providerTypes: ["openrouter"] },
      ownKey: { configured: false, ready: false },
      tokenAllowed: false,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain("Owner OpenRouter");
    expect(text).not.toContain("owner-account");
    expect(text).not.toContain("owner-member");
    expect(text).not.toContain("owner/private-model");
    expect(text).not.toContain("members");
    expect(text).not.toContain("fallbackEnabled");
    expect(db.poolGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          poolId: "pool",
          granteeUserId: "grantee",
          ModelPool: { userId: { not: "grantee" } },
        },
      }),
    );
    // The owner's accounts are read for their provider TYPE only.
    expect(db.poolGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          ModelPool: {
            select: expect.objectContaining({
              PoolMembers: expect.objectContaining({
                select: {
                  tier: true,
                  ExecutionTarget: {
                    select: {
                      ProviderModel: {
                        select: { ProviderAccount: { select: { providerType: true } } },
                      },
                    },
                  },
                },
              }),
            }),
          },
        }),
      }),
    );
  });

  it("hides owner-paid availability from grantees the owner does not cover", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    db.poolGrant.findFirst.mockResolvedValue({
      ModelPool: {
        id: "pool",
        slug: "pool",
        fallbackEnabled: true,
        fallbackForGrantees: false,
        externalEquivalentModel: null,
        User: { slug: "owner" },
        PoolMembers: [
          {
            tier: "PUBLIC_OVERFLOW",
            ExecutionTarget: { ProviderModel: { ProviderAccount: { providerType: "openrouter" } } },
          },
        ],
      },
      FallbackPreferences: [],
    } as never);
    db.modelApiToken.findMany.mockResolvedValue([]);
    const view = await clientFor("grantee").get({ poolId: "pool" });
    expect(view).toMatchObject({ poolFallback: { available: false, providerTypes: [] } });
  });

  it("is NOT_FOUND for a pool the caller neither owns nor was granted", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    db.poolGrant.findFirst.mockResolvedValue(null);
    await expect(clientFor("stranger").get({ poolId: "pool" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("poolFallback.update", () => {
  function mockPool(before = SETTINGS, capacityWaitBudgetMs: number | null = null) {
    db.modelPool.findFirst
      .mockResolvedValueOnce({
        id: "pool",
        capacityWaitBudgetMs,
        externalAfterWaitMs: before.externalAfterWaitMs,
      } as never)
      .mockResolvedValueOnce(before as never);
  }

  it("changes the grantee switch and audits it with the change source", async () => {
    mockPool();
    db.modelPool.update.mockResolvedValue({ ...SETTINGS, fallbackForGrantees: true } as never);
    const result = await clientFor("owner", "mcp:owner").update({
      poolId: "pool",
      fallbackForGrantees: true,
    });
    expect(result).toEqual({
      poolId: "pool",
      ...SETTINGS,
      fallbackForGrantees: true,
      changed: true,
    });
    expect(db.modelPool.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pool" }, data: { fallbackForGrantees: true } }),
    );
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        action: "POOL_FALLBACK_UPDATED",
        subjectId: "pool",
        metadata: {
          source: "mcp",
          changes: { fallbackForGrantees: { before: false, after: true } },
        },
      },
    });
  });

  it("records the dashboard as the source for browser sessions", async () => {
    mockPool();
    db.modelPool.update.mockResolvedValue({ ...SETTINGS, externalAfterWaitMs: 0 } as never);
    await clientFor("owner").update({ poolId: "pool", externalAfterWaitMs: 0 });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: {
          source: "dashboard",
          changes: { externalAfterWaitMs: { before: 2000, after: 0 } },
        },
      }),
    });
  });

  it("writes no audit event when nothing changed", async () => {
    mockPool();
    db.modelPool.update.mockResolvedValue(SETTINGS as never);
    const result = await clientFor("owner").update({ poolId: "pool", fallbackEnabled: false });
    expect(result.changed).toBe(false);
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("turning fallback on requires the deployment switch", async () => {
    state.enabled = false;
    mockPool();
    await expect(
      clientFor("owner").update({ poolId: "pool", fallbackEnabled: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("turning fallback on requires an audited protection policy on every external member", async () => {
    mockPool();
    db.poolMember.findMany.mockResolvedValue([
      {
        id: "member",
        ExecutionTarget: { ProviderModel: { id: "model", providerAccountId: "account" } },
      },
    ] as never);
    db.providerBudgetPolicy.findMany.mockResolvedValue([]);
    await expect(
      clientFor("owner").update({ poolId: "pool", fallbackEnabled: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.update).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a new external wait beyond the local wait budget", async () => {
    mockPool(SETTINGS, 1000);
    await expect(
      clientFor("owner").update({ poolId: "pool", externalAfterWaitMs: 5000 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is owner-only: a grantee or stranger gets NOT_FOUND", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    await expect(
      clientFor("grantee").update({ poolId: "pool", fallbackForGrantees: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pool", userId: "grantee" } }),
    );
    expect(db.modelPool.update).not.toHaveBeenCalled();
  });

  it("accepts no other fields: token external consent stays dashboard-only", async () => {
    for (const extra of [{ allowExternal: true }, { includeExternal: true }, { name: "x" }]) {
      await expect(
        clientFor("owner").update({
          poolId: "pool",
          fallbackEnabled: false,
          ...extra,
        } as { poolId: string; fallbackEnabled: boolean }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(clientFor("owner").update({ poolId: "pool" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.modelPool.findFirst).not.toHaveBeenCalled();
  });
});
