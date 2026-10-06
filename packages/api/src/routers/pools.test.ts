import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.test" },
}));

import prisma from "@ws-model-proxy/db";
import { callableIdsFor } from "../lib/pool-views";
import { CALLERS, contextFor, OWNER } from "./lane-c-test-helpers";
import { modelsRouter } from "./models";
import { poolsRouter } from "./pools";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

function poolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pool-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: OWNER,
    slug: "chat",
    name: "Chat",
    description: null,
    modelType: "LLM",
    User: { slug: "ann" },
    Routing: null,
    Fallback: null,
    Advanced: null,
    Sidecars: [],
    RoutingRules: [],
    Members: [],
    _count: { Shares: 0 },
    ...overrides,
  };
}

function servingMember(phase = "READY") {
  return {
    id: "mem-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    poolId: "pool-1",
    kind: "LOCAL",
    runtimeModelId: "rm-1",
    providerModelId: null,
    shareId: null,
    weight: 1,
    state: "ACTIVE",
    cloudOrder: null,
    RuntimeModel: {
      upstreamModelId: "qwen",
      runtimeId: "rt-1",
      retired: false,
      Runtime: {
        slug: "qwen",
        nodeId: null,
        Node: null,
        Instances: [{ phase, Ranks: [{ nodeId: "node-1", Node: { slug: "box", userId: OWNER } }] }],
      },
      Targets: [{ health: "HEALTHY" }],
    },
    Share: null,
    ProviderModel: null,
  };
}

function client(auth = CALLERS.person()) {
  return createRouterClient(poolsRouter, { context: contextFor(auth) });
}

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError)
      return (error.data as { reason?: string } | undefined)?.reason ?? error.code;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) => work(db)) as never);
  db.usageRollupHour.findMany.mockResolvedValue([]);
});

describe("callable ids", () => {
  it("adds :external only where the cloud mode covers the caller", () => {
    const base = { ownerSlug: "ann", poolSlug: "chat" };
    expect(callableIdsFor({ ...base, mode: "OFF", callerIsOwner: true })).toEqual(["ann/chat"]);
    expect(callableIdsFor({ ...base, mode: "OWNER", callerIsOwner: true })).toEqual([
      "ann/chat",
      "ann/chat:external",
    ]);
    expect(callableIdsFor({ ...base, mode: "OWNER", callerIsOwner: false })).toEqual(["ann/chat"]);
    expect(callableIdsFor({ ...base, mode: "OWNER_AND_SHARES", callerIsOwner: false })).toEqual([
      "ann/chat",
      "ann/chat:external",
    ]);
  });
});

describe("pools.create", () => {
  it("adds the caller's own served model and shows it serving", async () => {
    db.pool.create.mockResolvedValue({ id: "pool-1", userId: OWNER, modelType: "LLM" } as never);
    db.runtimeModel.findFirst.mockResolvedValue({
      id: "rm-1",
      type: "LLM",
      retired: false,
    } as never);
    db.pool.findFirst.mockResolvedValue(poolRow({ Members: [servingMember()] }) as never);
    const view = await client(CALLERS.fullAgent()).create({
      slug: "chat",
      name: "Chat",
      type: "LLM",
      members: [{ runtimeModelId: "rm-1" }],
    });
    expect(db.runtimeModel.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "rm-1",
      userId: OWNER,
    });
    expect(view.callableIds).toEqual(["ann/chat"]);
    expect(view.members[0]).toMatchObject({ status: "serving", health: "HEALTHY" });
    expect(view.runsOn).toEqual([{ nodeId: "node-1", slug: "box", mine: true, instances: 1 }]);
    expect(view.cloud.mode).toBe("OFF");
  });

  it("refuses someone else's served model and a type mismatch", async () => {
    db.pool.create.mockResolvedValue({ id: "pool-1", userId: OWNER, modelType: "LLM" } as never);
    db.runtimeModel.findFirst.mockResolvedValue(null);
    expect(
      await reasonOf(
        client().create({
          slug: "chat",
          name: "C",
          type: "LLM",
          members: [{ runtimeModelId: "x" }],
        }),
      ),
    ).toBe("not_your_runtime");
    db.runtimeModel.findFirst.mockResolvedValue({
      id: "rm-2",
      type: "EMBEDDINGS",
      retired: false,
    } as never);
    expect(
      await reasonOf(
        client().create({
          slug: "chat",
          name: "C",
          type: "LLM",
          members: [{ runtimeModelId: "rm-2" }],
        }),
      ),
    ).toBe("model_type_mismatch");
  });

  it("answers slug_taken", async () => {
    db.$transaction.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await reasonOf(client().create({ slug: "chat", name: "C", type: "LLM" }))).toBe(
      "slug_taken",
    );
  });
});

describe("pools.update (agent-editable)", () => {
  it("merges Advanced overrides; null returns a key to automatic", async () => {
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-1",
      userId: OWNER,
      modelType: "LLM",
    } as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    db.poolAdvanced.findUnique.mockResolvedValue({
      poolId: "pool-1",
      maxWaitMs: null,
      contextCeiling: null,
      contextMargin: null,
      overrides: { protocolAdaptation: true, affinity: { enabled: false } },
    } as never);
    await client(CALLERS.fullAgent()).update({
      poolId: "pool-1",
      advanced: {
        maxWaitMs: 5_000,
        overrides: { protocolAdaptation: null, affinity: { ttlSeconds: 600 } },
      },
    });
    const call = db.poolAdvanced.upsert.mock.calls[0]?.[0];
    expect(call?.update).toEqual({
      maxWaitMs: 5_000,
      overrides: { affinity: { enabled: false, ttlSeconds: 600 } },
    });
  });

  it("refuses chained sidecars", async () => {
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-1",
      userId: OWNER,
      modelType: "LLM",
    } as never);
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-2",
      modelType: "LLM",
      Sidecars: [{ id: "sc-1" }],
    } as never);
    db.poolSidecar.count.mockResolvedValue(0);
    expect(
      await reasonOf(
        client().update({
          poolId: "pool-1",
          sidecars: [{ input: "IMAGE", targetPoolId: "pool-2" }],
        }),
      ),
    ).toBe("sidecar_chain");
  });

  it("an agent cannot reach another person's pool", async () => {
    db.pool.findFirst.mockResolvedValue(null);
    expect(await reasonOf(client(CALLERS.fullAgent()).update({ poolId: "p", name: "x" }))).toBe(
      "NOT_FOUND",
    );
    expect(db.pool.findFirst.mock.calls[0]?.[0]?.where).toEqual({ id: "p", userId: OWNER });
  });
});

describe("human-only pool settings (cloud spend and own hardware)", () => {
  const calls = [
    (c: ReturnType<typeof client>) => c.cloud.setMode({ poolId: "pool-1", mode: "OWNER" }),
    (c: ReturnType<typeof client>) =>
      c.cloud.setPaidWarmProtection({ poolId: "pool-1", enabled: true }),
    (c: ReturnType<typeof client>) =>
      c.cloud.setOwnKeyEquivalent({ poolId: "pool-1", model: "openai/gpt-x" }),
    (c: ReturnType<typeof client>) =>
      c.routing.setOwnHardwareOnly({ poolId: "pool-1", enabled: true }),
    (c: ReturnType<typeof client>) => c.rules.delete({ ruleId: "rule-1" }),
  ];

  for (const [label, auth] of [
    ["Full agent token", CALLERS.fullAgent()],
    ["OAuth token", CALLERS.oauthAgent()],
    ["cookie without CSRF", CALLERS.cookieWithoutCsrf()],
  ] as const)
    it(`refuses a ${label} before touching the database`, async () => {
      for (const call of calls) expect(await reasonOf(call(client(auth)))).toBe("FORBIDDEN");
      expect(db.pool.findFirst).not.toHaveBeenCalled();
      expect(db.poolFallback.upsert).not.toHaveBeenCalled();
      expect(db.poolRouting.upsert).not.toHaveBeenCalled();
    });

  it("a person sets the cloud mode, audited, and gets :external", async () => {
    db.pool.findFirst.mockResolvedValueOnce({ id: "pool-1" } as never);
    db.pool.findFirst.mockResolvedValue(
      poolRow({
        Fallback: {
          poolId: "pool-1",
          mode: "OWNER",
          embeddingContract: null,
          paidWarmProtection: false,
          ownKeyEquivalentModel: null,
        },
      }) as never,
    );
    const view = await client().cloud.setMode({ poolId: "pool-1", mode: "OWNER" });
    expect(db.poolFallback.upsert.mock.calls[0]?.[0]?.update).toEqual({ mode: "OWNER" });
    expect(db.auditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      action: "pool.fallback.mode",
      actor: "USER",
    });
    expect(view.callableIds).toEqual(["ann/chat", "ann/chat:external"]);
  });
});

describe("contributed members", () => {
  function share(overrides: Record<string, unknown> = {}) {
    return {
      id: "share-1",
      canContribute: true,
      ownerUserId: "someone-else",
      Pool: { modelType: "LLM", Routing: { ownHardwareOnly: false } },
      ...overrides,
    };
  }

  it("refuses without can-contribute, with own-hardware-only, and for another person's model", async () => {
    db.share.findFirst.mockResolvedValue(share({ canContribute: false }) as never);
    const agent = client(CALLERS.fullAgent());
    const input = { poolId: "pool-9", runtimeModelId: "rm-1" };
    expect(await reasonOf(agent.members.addContributed(input))).toBe("contribute_not_allowed");
    db.share.findFirst.mockResolvedValue(
      share({ Pool: { modelType: "LLM", Routing: { ownHardwareOnly: true } } }) as never,
    );
    expect(await reasonOf(agent.members.addContributed(input))).toBe("own_hardware_only");
    db.share.findFirst.mockResolvedValue(share() as never);
    db.runtimeModel.findFirst.mockResolvedValue(null);
    expect(await reasonOf(agent.members.addContributed(input))).toBe("not_your_runtime");
    expect(db.runtimeModel.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "rm-1",
      userId: OWNER,
    });
    expect(db.poolMember.create).not.toHaveBeenCalled();
  });

  it("an agent contributes its own model through its share", async () => {
    db.share.findFirst.mockResolvedValue(share() as never);
    db.runtimeModel.findFirst.mockResolvedValue({
      id: "rm-1",
      type: "LLM",
      retired: false,
    } as never);
    db.poolMember.create.mockResolvedValue({ id: "mem-9" } as never);
    db.poolMember.findUniqueOrThrow.mockResolvedValue({
      ...servingMember(),
      id: "mem-9",
      shareId: "share-1",
      Share: { Grantee: { email: "owner-1@example.test" } },
    } as never);
    const member = await client(CALLERS.fullAgent()).members.addContributed({
      poolId: "pool-9",
      runtimeModelId: "rm-1",
    });
    expect(db.poolMember.create.mock.calls[0]?.[0]?.data).toMatchObject({
      shareId: "share-1",
      runtimeModelId: "rm-1",
    });
    expect(db.auditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      userId: "someone-else",
      actor: "AGENT",
    });
    expect(member.contributorEmail).toBe("owner-1@example.test");
  });

  it("withdraw is limited to the contributor or the pool owner", async () => {
    db.poolMember.findFirst.mockResolvedValue(null);
    expect(
      await reasonOf(client(CALLERS.fullAgent()).members.removeContributed({ memberId: "m" })),
    ).toBe("NOT_FOUND");
    expect(db.poolMember.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "m",
      shareId: { not: null },
      OR: [{ Share: { granteeUserId: OWNER } }, { Pool: { userId: OWNER } }],
    });
    expect(db.poolMember.delete).not.toHaveBeenCalled();
  });
});

describe("models.list", () => {
  it("lists own and can-use pools with callable ids, never direct models", async () => {
    db.pool.findMany.mockResolvedValue([
      {
        id: "pool-2",
        slug: "shared",
        userId: "bob",
        modelType: "LLM",
        User: { slug: "bob", email: "bob@example.test" },
        Fallback: { mode: "OWNER" },
        Members: [],
      },
      {
        id: "pool-1",
        slug: "chat",
        userId: OWNER,
        modelType: "LLM",
        User: { slug: "ann", email: "ann@example.test" },
        Fallback: { mode: "OWNER" },
        Members: [servingMember()],
      },
    ] as never);
    const models = createRouterClient(modelsRouter, { context: contextFor(CALLERS.person()) });
    const result = await models.list();
    expect(result.baseUrl).toBe("https://proxy.example.test/v1");
    expect(result.models.map((model) => [model.callableId, model.status])).toEqual([
      ["ann/chat", "serving"],
      ["ann/chat:external", "serving"],
      ["bob/shared", "unavailable"],
    ]);
    expect(result.models[2]?.owner).toEqual({ slug: "bob", you: false, email: "bob@example.test" });
    expect(db.pool.findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [{ userId: OWNER }, { Shares: { some: { granteeUserId: OWNER, canUse: true } } }],
    });
  });
});
