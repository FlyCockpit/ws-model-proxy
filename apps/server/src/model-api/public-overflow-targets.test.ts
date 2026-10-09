import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  pool: null as Record<string, unknown> | null,
  share: null as Record<string, unknown> | null,
  ensured: [] as Array<{ userId: string; ids: string[] }>,
  ensureFails: false,
}));

vi.mock("@ws-model-proxy/db", () => ({
  default: {
    pool: { findFirst: async () => world.pool },
    share: { findFirst: async () => world.share },
  },
  Prisma: {},
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true, WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false },
}));
vi.mock("./provider-targets.js", () => ({
  ensureProviderExecutionTargets: async (
    userId: string,
    models: Array<{ id: string; providerAccountId: string }>,
  ) => {
    world.ensured.push({ userId, ids: models.map((model) => model.id) });
    if (world.ensureFails) throw new Error("lock timeout");
    return new Map(models.map((model) => [model.id, `target-of-${model.id}`]));
  },
}));

import { listPublicOverflowTargets } from "./public-overflow.js";

const active = { banned: false, banExpires: null, deletionRequestedAt: null };

function providerModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "owner",
    providerAccountId: "account",
    upstreamModelId: `upstream-${id}`,
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
    nativeCapabilities: { protocols: ["openai"], surfaces: ["openai-chat"], streaming: true },
    health: "HEALTHY",
    healthNextRetryAt: null,
    healthHalfOpenAt: null,
    enabled: true,
    deletedAt: null,
    Target: { id: `target-${id}` },
    Account: {
      id: "account",
      userId: "owner",
      providerType: "openrouter",
      providerVersion: null,
      allowDataCollection: false,
      baseUrl: "https://openrouter.ai/api/v1",
      endpointIdentity: "endpoint",
      endpointVersion: 2,
      authType: "BEARER",
      healthNextRetryAt: null,
      healthHalfOpenAt: null,
      enabled: true,
      deletedAt: null,
      CurrentCredential: {
        id: "credential",
        credentialType: "BEARER",
        aadVersion: 1,
        algorithm: "AES-256-GCM",
        keyVersion: "v1",
        ciphertext: new Uint8Array([1]),
        nonce: new Uint8Array([2]),
        authTag: new Uint8Array([3]),
        status: "ACTIVE",
      },
    },
    ...overrides,
  };
}

function pool(mode: "OFF" | "OWNER" | "OWNER_AND_SHARES", members: unknown[]) {
  return {
    id: "pool",
    userId: "owner",
    User: active,
    Fallback: {
      mode,
      paidWarmProtection: false,
      embeddingContract: null,
      ownKeyEquivalentModel: null,
    },
    Advanced: null,
    Members: members,
  };
}

beforeEach(() => {
  world.pool = null;
  world.share = null;
  world.ensured.length = 0;
  world.ensureFails = false;
});

describe("cloud target listing (0.4.0)", () => {
  it("lists ACTIVE cloud members in cloudOrder with their flags", async () => {
    world.pool = pool("OWNER", [
      { id: "m1", cloudOrder: 0, ProviderModel: providerModel("a") },
      { id: "m2", cloudOrder: 1, ProviderModel: providerModel("b") },
    ]);
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(listed).toMatchObject({ enabled: true, ownerActive: true, fallbackForGrantees: false });
    expect(listed.targets.map((target) => [target.poolMemberId, target.executionTargetId])).toEqual(
      [
        ["m1", "target-a"],
        ["m2", "target-b"],
      ],
    );
    expect(listed.targets[0]).toMatchObject({
      providerModelId: "a",
      protocol: "openai",
      dataCollectionPolicy: "deny",
      usageDialect: "openrouter",
      endpointVersion: 2,
    });
  });

  it("reports the cloud mode: OFF disabled, OWNER_AND_SHARES covers share holders", async () => {
    world.pool = pool("OFF", []);
    expect((await listPublicOverflowTargets("owner", "pool")).enabled).toBe(false);
    world.pool = pool("OWNER_AND_SHARES", []);
    expect(await listPublicOverflowTargets("owner", "pool")).toMatchObject({
      enabled: true,
      fallbackForGrantees: true,
    });
  });

  it("creates a missing provider execution target once and uses it", async () => {
    world.pool = pool("OWNER", [
      { id: "m1", cloudOrder: 0, ProviderModel: providerModel("a", { Target: null }) },
    ]);
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(world.ensured).toEqual([{ userId: "owner", ids: ["a"] }]);
    expect(listed.targets[0]?.executionTargetId).toBe("target-of-a");
  });

  it("never creates a target for a soft-deleted model", async () => {
    world.pool = pool("OWNER", [
      {
        id: "m1",
        cloudOrder: 0,
        ProviderModel: providerModel("a", { Target: null, deletedAt: new Date() }),
      },
    ]);
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(world.ensured).toEqual([]);
    expect([...listed.targets, ...listed.coolingDown, ...listed.unavailable]).toEqual([]);
  });

  it("counts a member whose target could not be created yet as cooling down (transient)", async () => {
    world.ensureFails = true;
    world.pool = pool("OWNER", [
      { id: "m1", cloudOrder: 0, ProviderModel: providerModel("a", { Target: null }) },
    ]);
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(listed.targets).toEqual([]);
    expect(listed.coolingDown.map((target) => target.providerModelId)).toEqual(["a"]);
  });

  it("separates cooling-down and unavailable members from sendable ones", async () => {
    world.pool = pool("OWNER", [
      {
        id: "m1",
        cloudOrder: 0,
        ProviderModel: providerModel("a", { healthNextRetryAt: new Date(Date.now() + 60_000) }),
      },
      { id: "m2", cloudOrder: 1, ProviderModel: providerModel("b", { enabled: false }) },
      {
        id: "m3",
        cloudOrder: 2,
        ProviderModel: providerModel("c", { userId: "someone-else" }),
      },
    ]);
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(listed.targets).toEqual([]);
    expect(listed.coolingDown.map((target) => target.providerModelId)).toEqual(["a"]);
    expect(listed.unavailable.map((target) => target.providerModelId)).toEqual(["b"]);
  });

  it("marks a banned owner inactive", async () => {
    world.pool = { ...pool("OWNER", []), User: { ...active, banned: true } };
    expect((await listPublicOverflowTargets("owner", "pool")).ownerActive).toBe(false);
  });

  it("lists the share holder's own model only while both own-key consents hold", async () => {
    world.pool = pool("OFF", []);
    const ownKey = { requesterUserId: "grantee", providerModelId: "mine", shareId: "share" };
    expect((await listPublicOverflowTargets("owner", "pool", ownKey)).enabled).toBe(false);
    world.pool = {
      ...pool("OFF", []),
      Fallback: {
        mode: "OFF",
        paidWarmProtection: false,
        embeddingContract: null,
        ownKeyEquivalentModel: "openai/gpt-oss-120b",
      },
    };
    world.share = {
      ownKeyProtocolAdaptation: true,
      OwnKeyModel: providerModel("mine", {
        userId: "grantee",
        Account: { ...providerModel("x").Account, userId: "grantee" },
      }),
    };
    const listed = await listPublicOverflowTargets("owner", "pool", ownKey);
    expect(listed.enabled).toBe(true);
    expect(listed.targets).toHaveLength(1);
    expect(listed.targets[0]).toMatchObject({
      ownKey: true,
      ownKeyAdaptationEnabled: true,
      poolMemberId: "",
      providerModelId: "mine",
    });
  });
});
