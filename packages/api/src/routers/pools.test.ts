import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", async () => ({
  default: mockDeep<PrismaClient>(),
  // The real namespace (pool traffic builds SQL fragments); DbNull stays a readable marker.
  Prisma: {
    ...(await import("../../../db/prisma/generated/internal/prismaNamespace")),
    DbNull: "DbNull",
  },
}));
const fenceLog = vi.hoisted(() => ({ held: [] as string[], deletes: [] as unknown[] }));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...real,
    acquireFences: vi.fn(async (_tx: unknown, requested: Iterable<string>) => {
      fenceLog.held.push(...requested);
      return true;
    }),
    // The model-name check asserts the owner fences: here, against what was requested.
    requireOwnerFences: vi.fn(async (_tx: unknown, userIds: Iterable<string>) => {
      const missing = [...userIds].filter((id) => !fenceLog.held.includes(`00:owner:${id}`));
      if (missing.length > 0) throw new real.MissingOwnerFenceError(missing);
    }),
    fenceParentDelete: vi.fn(async (_tx: unknown, scope: unknown) => {
      fenceLog.deletes.push(scope);
      return [];
    }),
    runCapacityOrderedTransaction: vi.fn(
      (db: { $transaction: (work: unknown) => unknown }, work: (tx: unknown) => unknown) =>
        db.$transaction(work),
    ),
  };
});
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: "configured",
  },
}));

import { LATENCY_HISTOGRAM_BUCKETS } from "@ws-model-proxy/config/usage-metrics";
import prisma, { Prisma } from "@ws-model-proxy/db";
import type { CallerAuth } from "../contracts/auth-context";
import { hiddenInstancesWhere } from "../lib/agent-hidden-nodes";
import { callableIdsFor, poolAdvancedView } from "../lib/pool-views";
import { CALLERS, contextFor, OWNER } from "./lane-c-test-helpers";
import { modelsRouter } from "./models";
import { poolsRouter } from "./pools";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

function scopedAgent(
  kind: "agent_token" | "oauth_access_token",
  nodeIds: string[] | null,
): CallerAuth {
  const auth = kind === "agent_token" ? CALLERS.fullAgent() : CALLERS.oauthAgent();
  if (auth.kind !== "agent_token" && auth.kind !== "oauth_access_token")
    throw new Error("agent expected");
  return { ...auth, access: { ...auth.access, nodeIds } };
}

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
        Instances: [
          {
            id: "inst-1",
            phase,
            engineSlots: 8,
            Ranks: [{ nodeId: "node-1", Node: { slug: "box", userId: OWNER } }],
          },
        ],
      },
      Targets: [{ health: "HEALTHY" }],
    },
    Share: null,
    ProviderModel: null,
  };
}

function memberWithHiddenInstance(
  placement: "bound" | "rank" | "reservation" | "stale target",
  includeAllowed = false,
) {
  const base = servingMember();
  const allowed = { ...base.RuntimeModel.Runtime.Instances[0]!, Reservations: [] };
  const hidden = {
    ...allowed,
    id: "hidden-instance",
    engineSlots: 16,
    Ranks:
      placement === "bound"
        ? []
        : [
            ...allowed.Ranks,
            ...(placement === "rank" || placement === "stale target"
              ? [{ nodeId: "hidden", Node: { slug: "hidden", userId: OWNER } }]
              : []),
          ],
    Reservations: placement === "reservation" ? [{ nodeId: "hidden" }] : [],
  };
  return {
    ...base,
    RuntimeModel: {
      ...base.RuntimeModel,
      Runtime: {
        ...base.RuntimeModel.Runtime,
        nodeId: placement === "bound" ? "hidden" : null,
        Node: placement === "bound" ? { id: "hidden", slug: "hidden", userId: OWNER } : null,
        Instances: [
          ...(includeAllowed ? [allowed] : []),
          ...(placement === "stale target" ? [] : [hidden]),
        ],
      },
      Targets: [
        ...(includeAllowed ? [{ health: "UNHEALTHY", Instance: allowed }] : []),
        { health: "HEALTHY", Instance: hidden },
      ],
    },
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
  fenceLog.held.length = 0;
  fenceLog.deletes.length = 0;
  db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) => work(db)) as never);
  db.$queryRaw.mockResolvedValue([] as never);
  db.executionTarget.findMany.mockResolvedValue([]);
  db.runtimeModel.findMany.mockResolvedValue([]);
  db.runtimeInstance.findMany.mockResolvedValue([]);
  db.runtime.findFirst.mockResolvedValue({ nodeId: null, Node: null, Instances: [] } as never);
  db.modelAlias.findMany.mockResolvedValue([]);
  // A pool being updated is still there under the owner fence.
  db.pool.count.mockResolvedValue(1);
});

describe("callable ids", () => {
  it("adds :external only where the cloud mode covers the caller", () => {
    const base = { ownerSlug: "ann", poolSlug: "chat", cloudEnabled: true };
    expect(
      callableIdsFor({ ...base, cloudEnabled: false, mode: "OWNER", callerIsOwner: true }),
    ).toEqual(["ann/chat"]);
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

describe("pools.get: member live load", () => {
  function latencyRow(bucketCounts: Record<number, number>) {
    const row: Record<string, unknown> = {
      pool: "pool-1",
      runtime: "rt-1",
      provider_model: "",
      requests: 6,
    };
    for (let index = 1; index <= LATENCY_HISTOGRAM_BUCKETS; index += 1)
      row[`l${index}`] = bucketCounts[index] ?? 0;
    return row;
  }

  it("adds the relay's load and the member's recent p95 and share from the owner's rollups", async () => {
    db.pool.findFirst.mockResolvedValue(poolRow({ Members: [servingMember()] }) as never);
    db.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join("").includes("provider_model") ? [latencyRow({ 5: 10 })] : [],
      )) as never);
    const liveLoad = vi.fn(
      () => new Map([["inst-1", { running: 1, waiting: 4, kvUsage: null, at: new Date() }]]),
    );
    const view = await createRouterClient(poolsRouter, {
      context: contextFor(CALLERS.person(), { liveLoad }),
    }).get({ poolId: "pool-1" });
    expect(liveLoad).toHaveBeenCalledWith(["inst-1"]);
    expect(view.members[0]?.live).toMatchObject({ waiting: 4, active: 1, slots: 8, share: 1 });
    expect(view.members[0]?.live.p95LatencyMs).toEqual(expect.any(Number));
    const p95Call = db.$queryRaw.mock.calls.find((call) =>
      (call[0] as unknown as TemplateStringsArray).join("").includes("provider_model"),
    );
    expect(p95Call?.slice(1)).toContain(OWNER);
  });

  it("never reads a contributed member's load (the contributor's engine)", async () => {
    db.pool.findFirst.mockResolvedValue(
      poolRow({
        Members: [{ ...servingMember(), shareId: "share-1", Share: { Grantee: { email: "c@x" } } }],
      }) as never,
    );
    const liveLoad = vi.fn(() => new Map());
    const view = await createRouterClient(poolsRouter, {
      context: contextFor(CALLERS.person(), { liveLoad }),
    }).get({ poolId: "pool-1" });
    expect(liveLoad).not.toHaveBeenCalled();
    expect(view.members[0]?.live).toMatchObject({ waiting: null, active: null, slots: null });
  });

  it("keeps load unknown without the relay service and p95 unknown without traffic", async () => {
    db.pool.findFirst.mockResolvedValue(poolRow({ Members: [servingMember()] }) as never);
    const view = await client().get({ poolId: "pool-1" });
    expect(view.members[0]?.live).toMatchObject({
      waiting: null,
      p95LatencyMs: null,
      share: null,
      active: null,
      slots: 8,
    });
  });
});

describe("pools.create", () => {
  it("adds the caller's own served model and shows it serving", async () => {
    db.pool.create.mockResolvedValue({ id: "pool-1", userId: OWNER, modelType: "LLM" } as never);
    db.runtimeModel.findFirst.mockResolvedValue({
      runtimeId: "rt-1",
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
      runtimeId: "rt-1",
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

  it("refuses a slug whose callable ID is one of the owner's aliases", async () => {
    db.user.findUnique.mockResolvedValue({ slug: "ann" } as never);
    db.modelAlias.findMany.mockResolvedValue([{ userId: OWNER, name: "ann/chat" }] as never);
    expect(await reasonOf(client().create({ slug: "chat", name: "C", type: "LLM" }))).toBe(
      "name_aliased",
    );
    expect(db.modelAlias.findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [{ userId: OWNER, name: { in: ["ann/chat"] } }],
    });
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`]);
    expect(db.pool.create).not.toHaveBeenCalled();

    db.modelAlias.findMany.mockResolvedValue([]);
    db.pool.create.mockResolvedValue({ id: "pool-1", userId: OWNER, modelType: "LLM" } as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    const view = await client().create({ slug: "chat", name: "C", type: "LLM" });
    expect(view.callableIds).toEqual(["ann/chat"]);
    expect(db.pool.create).toHaveBeenCalledTimes(1);
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
    db.pool.findMany.mockResolvedValue([{ userId: OWNER }] as never);
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-2",
      userId: OWNER,
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

  it("refuses kept slots above the pool's cap, also against the stored cap", async () => {
    db.pool.findFirst.mockResolvedValue({ id: "pool-1", userId: OWNER, modelType: "LLM" } as never);
    expect(
      await reasonOf(
        client().update({ poolId: "pool-1", routing: { concurrencyLimit: 2, keptSlots: 3 } }),
      ),
    ).toBe("BAD_REQUEST");
    db.poolRouting.findUnique.mockResolvedValue({ concurrencyLimit: 1, keptSlots: 0 } as never);
    expect(await reasonOf(client().update({ poolId: "pool-1", routing: { keptSlots: 2 } }))).toBe(
      "BAD_REQUEST",
    );
    expect(db.poolRouting.upsert).not.toHaveBeenCalled();
    // A patch that leaves both alone (a stored pool from before the check) still goes through.
    db.poolRouting.findUnique.mockResolvedValue({ concurrencyLimit: 1, keptSlots: 3 } as never);
    db.pool.findFirst.mockReset();
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-1",
      userId: OWNER,
      modelType: "LLM",
    } as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    await client().update({ poolId: "pool-1", routing: { priorityClass: "HIGH" } });
    expect(db.poolRouting.upsert).toHaveBeenCalledTimes(1);
  });

  it("changes the slug unless the owner's own alias has that callable ID, never looking at holders'", async () => {
    const owned = { id: "pool-1", userId: OWNER, modelType: "LLM", slug: "chat" };
    db.pool.findFirst.mockResolvedValue(owned as never);
    db.user.findUnique.mockResolvedValue({ slug: "ann" } as never);
    db.share.findMany.mockResolvedValue([{ poolId: "pool-1", granteeUserId: "bob" }] as never);
    // Answers like the database: only the aliases of the people the read asks about.
    const aliases = [
      { userId: OWNER, name: "ann/talk" },
      { userId: "bob", name: "ann/next" },
    ];
    db.modelAlias.findMany.mockImplementation((async (args: {
      where: { OR: Array<{ userId: string; name: { in: string[] } }> };
    }) =>
      aliases.filter((alias) =>
        args.where.OR.some(
          (claim) => claim.userId === alias.userId && claim.name.in.includes(alias.name),
        ),
      )) as never);
    // The owner's own alias is refused by name.
    expect(await reasonOf(client().update({ poolId: "pool-1", slug: "talk" }))).toBe(
      "name_aliased",
    );
    expect(db.modelAlias.findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [{ userId: OWNER, name: { in: ["ann/talk"] } }],
    });
    // Only the owner's fence: share holders' namespaces are not part of the rename.
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`]);
    expect(db.pool.update).not.toHaveBeenCalled();

    // bob's alias `ann/next` keeps winning for bob; the owner is never told.
    db.pool.findFirst.mockReset();
    db.pool.findFirst
      .mockResolvedValueOnce(owned as never)
      .mockResolvedValueOnce(owned as never)
      .mockResolvedValue(poolRow({ slug: "next" }) as never);
    const view = await client().update({ poolId: "pool-1", slug: "next" });
    expect(db.pool.update.mock.calls[0]?.[0]?.data).toEqual({ slug: "next" });
    expect(view.callableIds).toEqual(["ann/next"]);
    expect(db.share.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ canUse: true }) }),
    );
  });

  it("decides whether the slug changes under the fences, not from the first read", async () => {
    // Read as `chat` before the transaction; a rename to `talk` landed before the fences, so
    // asking for `chat` again is a rename back: checked against the owner's aliases.
    db.pool.findFirst
      .mockResolvedValueOnce({
        id: "pool-1",
        userId: OWNER,
        modelType: "LLM",
        slug: "chat",
      } as never)
      .mockResolvedValueOnce({ slug: "talk" } as never)
      .mockResolvedValue(poolRow() as never);
    db.user.findUnique.mockResolvedValue({ slug: "ann" } as never);
    db.modelAlias.findMany.mockResolvedValue([{ userId: OWNER, name: "ann/chat" }] as never);
    expect(await reasonOf(client().update({ poolId: "pool-1", slug: "chat" }))).toBe(
      "name_aliased",
    );
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`]);
    expect(db.pool.update).not.toHaveBeenCalled();
  });

  it("re-sending the current slug claims and writes no slug", async () => {
    db.pool.findFirst
      .mockResolvedValueOnce({
        id: "pool-1",
        userId: OWNER,
        modelType: "LLM",
        slug: "chat",
      } as never)
      .mockResolvedValueOnce({ slug: "chat" } as never)
      .mockResolvedValue(poolRow() as never);
    db.share.findMany.mockResolvedValue([]);
    await client().update({ poolId: "pool-1", slug: "chat", name: "Chat 2" });
    expect(db.modelAlias.findMany).not.toHaveBeenCalled();
    expect(db.pool.update.mock.calls[0]?.[0]?.data).toEqual({ name: "Chat 2" });
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
      runtimeId: "rt-1",
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

  for (const kind of ["agent_token", "oauth_access_token"] as const) {
    for (const [label, auth, filtered] of [
      ["allowlisted", scopedAgent(kind, ["node-1"]), true],
      ["all nodes", scopedAgent(kind, null), false],
      ["person", CALLERS.person(), false],
    ] as const) {
      for (const placement of ["bound", "rank", "reservation", "stale target"] as const) {
        it(`${kind}, ${label}, ${placement}: filters the contribution response after the write`, async () => {
          db.share.findFirst.mockResolvedValue(share() as never);
          db.runtimeModel.findFirst.mockResolvedValue({
            runtimeId: "rt-1",
            id: "rm-1",
            type: "LLM",
            retired: false,
          } as never);
          // Eligibility sees no placement; the response reread can see a person's later start
          // or a stopped instance's target that eligibility intentionally does not load.
          db.poolMember.create.mockResolvedValue({ id: "mem-1" } as never);
          const row = {
            ...memberWithHiddenInstance(placement),
            shareId: "share-1",
            Share: { Grantee: { email: "owner-1@example.test" } },
          };
          db.poolMember.findUniqueOrThrow.mockResolvedValue(row as never);
          db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
          const liveLoad = vi.fn(() => new Map());
          const member = await createRouterClient(poolsRouter, {
            context: contextFor(auth, { liveLoad }),
          }).members.addContributed({ poolId: "pool-1", runtimeModelId: "rm-1" });
          const count = filtered || placement === "stale target" ? 0 : 1;
          expect(member).toMatchObject({
            status: count ? "serving" : "unavailable",
            health: filtered ? "UNKNOWN" : "HEALTHY",
            contributorEmail: "owner-1@example.test",
            live: {
              instances: count,
              running: count,
              waiting: null,
              active: null,
              slots: null,
              p95LatencyMs: null,
              share: null,
            },
          });
          expect(liveLoad).not.toHaveBeenCalled();
          expect(db.node.findMany).toHaveBeenCalledTimes(filtered ? 1 : 0);
          if (filtered)
            expect(db.node.findMany).toHaveBeenCalledWith({
              where: { userId: OWNER },
              select: { id: true },
            });
          // Filtering the response must not change the stored member or its source rows.
          expect(row.RuntimeModel.Targets).toHaveLength(1);
          expect(row.RuntimeModel.Runtime.Instances).toHaveLength(
            placement === "stale target" ? 0 : 1,
          );
          expect(db.poolMember.create).toHaveBeenCalledTimes(1);
        });
      }
    }

    for (const placement of ["rank", "reservation"] as const) {
      it(`${kind}, ${placement}: a hidden healthy target cannot override visible unhealthy health on contribution`, async () => {
        db.share.findFirst.mockResolvedValue(share() as never);
        db.runtimeModel.findFirst.mockResolvedValue({
          runtimeId: "rt-1",
          id: "rm-1",
          type: "LLM",
          retired: false,
        } as never);
        db.poolMember.create.mockResolvedValue({ id: "mem-1" } as never);
        db.poolMember.findUniqueOrThrow.mockResolvedValue({
          ...memberWithHiddenInstance(placement, true),
          shareId: "share-1",
          Share: { Grantee: { email: "owner-1@example.test" } },
        } as never);
        db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
        const member = await client(scopedAgent(kind, ["node-1"])).members.addContributed({
          poolId: "pool-1",
          runtimeModelId: "rm-1",
        });
        expect(member).toMatchObject({
          status: "serving",
          health: "UNHEALTHY",
          live: { instances: 1, running: 1, waiting: null, active: null, slots: null },
        });
        expect(db.node.findMany).toHaveBeenCalledTimes(1);
      });
    }
  }

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
    expect(db.poolMember.deleteMany).not.toHaveBeenCalled();
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
  it("lists a callable ID one of the caller's aliases hides as the alias's pool", async () => {
    const shared = {
      id: "pool-2",
      slug: "shared",
      userId: "bob",
      modelType: "LLM",
      User: { slug: "bob", email: "bob@example.test" },
      Fallback: { mode: "OWNER_AND_SHARES" },
      Members: [],
    };
    const own = {
      id: "pool-1",
      slug: "chat",
      userId: OWNER,
      modelType: "LLM",
      User: { slug: "ann", email: "ann@example.test" },
      Fallback: { mode: "OFF" },
      Members: [],
    };
    db.pool.findMany.mockResolvedValue([shared, own] as never);
    db.modelAlias.findMany.mockResolvedValue([
      { name: "bob/shared", poolId: "pool-1", apiKeyId: null },
      // Named like the pool it points at: hides nothing.
      { name: "ann/chat", poolId: "pool-1", apiKeyId: null },
    ] as never);
    const models = createRouterClient(modelsRouter, { context: contextFor(CALLERS.person()) });
    const result = await models.list();
    // `bob/shared` is listed once, as the pool the alias reaches (pool-1), owned first.
    expect(result.models.map((model) => [model.callableId, model.poolId])).toEqual([
      ["ann/chat", "pool-1"],
      ["bob/shared", "pool-1"],
    ]);
    expect(db.modelAlias.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER },
      select: { name: true, poolId: true, apiKeyId: true },
    });
  });
});

describe("pools.list shared with me", () => {
  it("flags a can-use share whose callable ID one of the caller's aliases hides", async () => {
    db.pool.findMany.mockResolvedValue([]);
    const active = { banned: false, banExpires: null, deletionRequestedAt: null };
    const share = (poolId: string, slug: string, canUse = true, user = active) => ({
      poolId,
      canUse,
      canContribute: !canUse,
      Owner: { email: "bob@example.test" },
      Pool: {
        slug,
        modelType: "LLM",
        User: { slug: "bob", ...user },
        Fallback: { mode: "OFF" },
      },
    });
    db.share.findMany.mockResolvedValue([
      share("pool-a", "hidden"),
      share("pool-b", "free"),
      share("pool-c", "contrib", false),
      share("pool-d", "banned", true, { ...active, banned: true }),
    ] as never);
    db.modelAlias.findMany.mockResolvedValue([
      { name: "bob/hidden", poolId: "pool-own", apiKeyId: null },
      { name: "bob/contrib", poolId: "pool-own", apiKeyId: null },
      { name: "bob/banned", poolId: "pool-own", apiKeyId: null },
    ] as never);
    const { sharedWithMe } = await client(CALLERS.person()).list();
    expect(sharedWithMe.map((entry) => [entry.poolId, entry.hiddenByAlias])).toEqual([
      ["pool-a", true],
      ["pool-b", false],
      // Not callable for the caller (no can use, or the owner is inactive): nothing to hide.
      ["pool-c", false],
      ["pool-d", false],
    ]);
  });
});

describe("graph-write fences and review follow-ups", () => {
  const owned = { id: "pool-1", userId: OWNER, modelType: "LLM" };

  it("a contribution takes both owners' fences and the model's target fences", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share-1",
      canContribute: true,
      ownerUserId: "bob",
      Pool: { modelType: "LLM", Routing: { ownHardwareOnly: false } },
    } as never);
    db.runtimeModel.findFirst.mockResolvedValue({
      runtimeId: "rt-1",
      id: "rm-1",
      type: "LLM",
      retired: false,
    } as never);
    db.executionTarget.findMany.mockResolvedValue([{ id: "t-1" }] as never);
    db.poolMember.create.mockResolvedValue({ id: "mem-9" } as never);
    db.poolMember.findUniqueOrThrow.mockResolvedValue(servingMember() as never);
    await client(CALLERS.fullAgent()).members.addContributed({
      poolId: "p",
      runtimeModelId: "rm-1",
    });
    expect(fenceLog.held).toEqual(["00:owner:bob", "00:owner:owner-1", "06:capacity-policy:t-1"]);
  });

  it("a sidecar edit fences its target's owner: edits that would chain share that fence", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    db.pool.findMany.mockResolvedValue([{ userId: "bob" }] as never);
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-b",
      userId: "bob",
      modelType: "LLM",
      Sidecars: [],
    } as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    db.poolSidecar.count.mockResolvedValue(0);
    await client().update({
      poolId: "pool-1",
      sidecars: [{ input: "IMAGE", targetPoolId: "pool-b" }],
    });
    expect(fenceLog.held).toEqual(expect.arrayContaining(["00:owner:owner-1", "00:owner:bob"]));
    expect(db.poolSidecar.upsert).toHaveBeenCalled();
  });

  it("a sidecar target the owner may not name takes no fence of its owner", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    // Someone else's private pool: not among the pools the owner may name.
    db.pool.findMany.mockResolvedValue([]);
    expect(
      await reasonOf(
        client().update({
          poolId: "pool-1",
          sidecars: [{ input: "IMAGE", targetPoolId: "pool-x" }],
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(db.pool.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      id: { in: ["pool-x"] },
      OR: [{ userId: OWNER }, { Shares: { some: { granteeUserId: OWNER, canUse: true } } }],
    });
    expect(fenceLog.held).toEqual([]);
    expect(db.poolSidecar.upsert).not.toHaveBeenCalled();
  });

  it("a sidecar target whose owner was not fenced is a conflict, not a write", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    // Owned by bob before the fences; under them, by an owner that was not fenced.
    db.pool.findMany.mockResolvedValue([{ userId: "bob" }] as never);
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-b",
      userId: "carol",
      modelType: "LLM",
      Sidecars: [],
    } as never);
    db.poolSidecar.count.mockResolvedValue(0);
    expect(
      await reasonOf(
        client().update({
          poolId: "pool-1",
          sidecars: [{ input: "IMAGE", targetPoolId: "pool-b" }],
        }),
      ),
    ).toBe("CONFLICT");
    expect(db.poolSidecar.upsert).not.toHaveBeenCalled();
  });

  it("a contribution decides on the model as it is under the fences", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share-1",
      canContribute: true,
      ownerUserId: "bob",
      Pool: { modelType: "LLM", Routing: { ownHardwareOnly: false } },
    } as never);
    // Discovery retires the model between the first read and the fenced one.
    db.runtimeModel.findFirst
      .mockResolvedValueOnce({
        id: "rm-1",
        runtimeId: "rt-1",
        type: "LLM",
        retired: false,
      } as never)
      .mockImplementationOnce((async () => {
        expect(fenceLog.held).toEqual(expect.arrayContaining(["00:owner:bob"]));
        return { id: "rm-1", runtimeId: "rt-1", type: "LLM", retired: true };
      }) as never);
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).members.addContributed({ poolId: "p", runtimeModelId: "rm-1" }),
      ),
    ).toBe("BAD_REQUEST");
    expect(db.poolMember.create).not.toHaveBeenCalled();
  });

  it("removing a contributed member through update fences the contributor too", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    db.poolMember.findMany.mockResolvedValue([{ RuntimeModel: { userId: "carol" } }] as never);
    db.executionTarget.findMany.mockResolvedValue([{ id: "t-2" }] as never);
    await client().update({ poolId: "pool-1", members: { remove: ["mem-c"] } });
    expect(fenceLog.held).toEqual(
      expect.arrayContaining(["00:owner:owner-1", "00:owner:carol", "06:capacity-policy:t-2"]),
    );
  });

  it("changing a contributed member's weight or state fences the contributor too", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    db.poolMember.findMany.mockResolvedValue([{ RuntimeModel: { userId: "carol" } }] as never);
    db.poolMember.updateMany.mockImplementation((async () => {
      expect(fenceLog.held).toContain("00:owner:carol");
      return { count: 1 };
    }) as never);
    await client().update({
      poolId: "pool-1",
      members: { set: [{ memberId: "mem-c", weight: 3 }] },
    });
    expect(db.poolMember.findMany.mock.calls[0]?.[0]?.where).toEqual({
      id: { in: ["mem-c"] },
      poolId: "pool-1",
    });
    expect(db.poolMember.updateMany).toHaveBeenCalled();
  });

  it("deleting a pool goes through the parent-delete fences", async () => {
    // Renamed meanwhile: the audit names the slug read under the fences.
    db.pool.findFirst
      .mockResolvedValueOnce({ id: "pool-1", slug: "chat" } as never)
      .mockResolvedValueOnce({ slug: "talk" } as never);
    db.pool.deleteMany.mockResolvedValue({ count: 1 });
    await client().delete({ poolId: "pool-1" });
    expect(fenceLog.deletes).toEqual([{ userId: OWNER, poolIds: ["pool-1"] }]);
    expect(db.pool.deleteMany).toHaveBeenCalledWith({ where: { id: "pool-1", userId: OWNER } });
    expect(db.auditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      action: "pool.delete",
      after: { slug: "talk" },
    });
  });

  it("a pool deleted meanwhile is neither updated nor set nor audited twice", async () => {
    // Found before the fences, gone under them.
    db.pool.findFirst.mockResolvedValueOnce({ id: "pool-1", slug: "chat" } as never);
    db.pool.findFirst.mockResolvedValueOnce(null);
    await client().delete({ poolId: "pool-1" });
    expect(db.pool.deleteMany).not.toHaveBeenCalled();
    db.pool.findFirst.mockResolvedValue(owned as never);
    db.share.findMany.mockResolvedValue([]);
    db.pool.count.mockResolvedValue(0);
    expect(await reasonOf(client().update({ poolId: "pool-1", name: "Renamed" }))).toBe(
      "NOT_FOUND",
    );
    expect(await reasonOf(client().cloud.setMode({ poolId: "pool-1", mode: "OWNER" }))).toBe(
      "NOT_FOUND",
    );
    expect(
      await reasonOf(
        client().cloud.setOwnKeyEquivalent({ poolId: "pool-1", model: "openai/gpt-x" }),
      ),
    ).toBe("NOT_FOUND");
    expect(db.pool.update).not.toHaveBeenCalled();
    expect(db.poolFallback.upsert).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });

  it("a rule or contributed member deleted meanwhile is not audited twice", async () => {
    db.poolRoutingRule.findFirst.mockResolvedValue({ id: "rule-1", poolId: "pool-1" } as never);
    db.poolRoutingRule.deleteMany.mockResolvedValue({ count: 0 });
    await client().rules.delete({ ruleId: "rule-1" });
    db.poolMember.findFirst.mockResolvedValue({
      id: "mem-c",
      poolId: "pool-1",
      Pool: { userId: OWNER },
    } as never);
    db.poolMember.deleteMany.mockResolvedValue({ count: 0 });
    await client().members.removeContributed({ memberId: "mem-c" });
    expect(db.poolRoutingRule.deleteMany).toHaveBeenCalledWith({ where: { id: "rule-1" } });
    expect(db.poolMember.deleteMany).toHaveBeenCalledWith({ where: { id: "mem-c" } });
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });

  it("refuses a context margin at or above the ceiling", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    db.poolAdvanced.findUnique.mockResolvedValue({
      poolId: "pool-1",
      maxWaitMs: null,
      contextCeiling: 4_096,
      contextMargin: null,
      overrides: {},
    } as never);
    expect(
      await reasonOf(client().update({ poolId: "pool-1", advanced: { contextMargin: 4_096 } })),
    ).toBe("BAD_REQUEST");
    expect(db.poolAdvanced.upsert).not.toHaveBeenCalled();
  });

  it("reordering cloud members keeps their rows", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    db.providerModel.findMany.mockResolvedValue([
      { id: "pm-a", type: "LLM" },
      { id: "pm-b", type: "LLM" },
    ] as never);
    db.poolMember.findMany.mockResolvedValue([
      { id: "m-a", providerModelId: "pm-a", cloudOrder: 0 },
      { id: "m-b", providerModelId: "pm-b", cloudOrder: 1 },
    ] as never);
    await client().update({
      poolId: "pool-1",
      cloudMembers: [{ providerModelId: "pm-b" }, { providerModelId: "pm-a" }],
    });
    expect(db.poolMember.create).not.toHaveBeenCalled();
    expect(db.poolMember.deleteMany).not.toHaveBeenCalled();
    const moves = db.poolMember.update.mock.calls.map((call) => [
      call[0].where.id,
      (call[0].data as { cloudOrder: number }).cloudOrder,
    ]);
    // m-a moves out of the way, m-b takes 0, m-a takes 1.
    expect(moves.at(-1)).toEqual(["m-a", 1]);
    expect(moves).toContainEqual(["m-b", 0]);
  });

  it("keeps a sidecar's prompt and limits when only the target is re-sent", async () => {
    db.pool.findFirst.mockResolvedValueOnce(owned as never);
    db.pool.findMany.mockResolvedValue([{ userId: OWNER }] as never);
    db.pool.findFirst.mockResolvedValueOnce({
      id: "pool-2",
      userId: OWNER,
      modelType: "LLM",
      Sidecars: [],
    } as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    db.poolSidecar.count.mockResolvedValue(0);
    await client().update({
      poolId: "pool-1",
      sidecars: [{ input: "IMAGE", targetPoolId: "pool-2" }],
    });
    expect(db.poolSidecar.upsert.mock.calls[0]?.[0]?.update).toEqual({ targetPoolId: "pool-2" });
  });
});

describe("own-key equivalent (the share holders' consent)", () => {
  const OWN_KEY_CHOSEN = {
    poolId: "pool-1",
    OR: [{ ownKeyProviderModelId: { not: null } }, { ownKeyProtocolAdaptation: true }],
  };

  function owned(equivalent: string | null) {
    db.pool.findFirst.mockResolvedValueOnce({ id: "pool-1" } as never);
    db.pool.findFirst.mockResolvedValue(poolRow() as never);
    db.poolFallback.findUnique.mockResolvedValue({ ownKeyEquivalentModel: equivalent } as never);
  }

  it("a changed equivalent clears every share's own-key choice under the grantees' fences", async () => {
    owned("openai/gpt-x");
    db.share.findMany.mockResolvedValue([{ granteeUserId: "bob" }] as never);
    await client().cloud.setOwnKeyEquivalent({ poolId: "pool-1", model: "openai/gpt-y" });
    expect(db.poolFallback.upsert.mock.calls[0]?.[0]?.update).toEqual({
      ownKeyEquivalentModel: "openai/gpt-y",
    });
    expect(db.share.updateMany).toHaveBeenCalledWith({
      where: OWN_KEY_CHOSEN,
      data: { ownKeyProviderModelId: null, ownKeyProtocolAdaptation: false },
    });
    expect(fenceLog.held).toEqual(["00:owner:owner-1", "00:owner:bob"]);
  });

  it("clearing the equivalent clears the choices too", async () => {
    owned("openai/gpt-x");
    db.share.findMany.mockResolvedValue([]);
    await client().cloud.setOwnKeyEquivalent({ poolId: "pool-1", model: null });
    expect(db.share.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: OWN_KEY_CHOSEN }),
    );
  });

  it("re-saving the same equivalent keeps the choices", async () => {
    owned("openai/gpt-x");
    db.share.findMany.mockResolvedValue([{ granteeUserId: "bob" }] as never);
    await client().cloud.setOwnKeyEquivalent({ poolId: "pool-1", model: "openai/gpt-x" });
    expect(db.poolFallback.upsert).toHaveBeenCalled();
    expect(db.share.updateMany).not.toHaveBeenCalled();
  });

  it("a choice made before the fences restarts the transaction with that grantee fenced", async () => {
    owned("openai/gpt-x");
    // Bob's choice lands between the unfenced read and the owner fence.
    db.share.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ granteeUserId: "bob" }] as never);
    const { runCapacityOrderedTransaction } = await import(
      "@ws-model-proxy/db/capacity-lock-order"
    );
    vi.mocked(runCapacityOrderedTransaction).mockImplementationOnce(async (runner, work) => {
      // The real runner retries a FenceSetChangedError (no row was written yet).
      try {
        return await runner.$transaction(work);
      } catch (error) {
        expect((error as Error).name).toBe("FenceSetChangedError");
        expect(db.share.updateMany).not.toHaveBeenCalled();
        return runner.$transaction(work);
      }
    });
    await client().cloud.setOwnKeyEquivalent({ poolId: "pool-1", model: "openai/gpt-y" });
    // The first attempt fenced only the owner; the retry adds Bob.
    expect(fenceLog.held).toEqual(["00:owner:owner-1", "00:owner:owner-1", "00:owner:bob"]);
    expect(db.share.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("pool Advanced defaults", () => {
  it("translates between API protocols by default and keeps the lossy collapse off", () => {
    const view = poolAdvancedView(null);
    expect(view.protocolAdaptation).toEqual({ effective: true, source: "default" });
    expect(view.allowLossyDeveloperRoleCollapse).toEqual({ effective: false, source: "default" });
    const off = poolAdvancedView({
      poolId: "pool-1",
      maxWaitMs: null,
      contextCeiling: null,
      contextMargin: null,
      overrides: { protocolAdaptation: false },
    } as never);
    expect(off.protocolAdaptation.effective).toBe(false);
  });
});

for (const kind of ["agent_token", "oauth_access_token"] as const) {
  describe(`${kind}: mutation response visibility`, () => {
    for (const procedure of ["create", "update", "members.set"] as const) {
      it(`${procedure}: uses the shared pool/member filter once for the whole response`, async () => {
        const row = poolRow({
          Members: [
            memberWithHiddenInstance("rank", true),
            { ...memberWithHiddenInstance("bound"), id: "mem-2", runtimeModelId: "rm-2" },
          ],
        });
        db.pool.findFirst.mockResolvedValue(row as never);
        db.pool.create.mockResolvedValue({
          id: "pool-1",
          userId: OWNER,
          modelType: "LLM",
        } as never);
        db.poolMember.findMany.mockResolvedValue([{ RuntimeModel: { userId: OWNER } }] as never);
        db.poolMember.findFirst.mockResolvedValue({
          RuntimeModel: { userId: OWNER, runtimeId: "rt-1" },
        } as never);
        db.poolMember.updateMany.mockResolvedValue({ count: 1 });
        db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
        const liveLoad = vi.fn(
          (ids: readonly string[]) =>
            new Map(
              ids.map((id) => [id, { running: 2, waiting: 4, kvUsage: 0.5, at: new Date() }]),
            ),
        );
        const api = createRouterClient(poolsRouter, {
          context: contextFor(scopedAgent(kind, ["node-1"]), { liveLoad }),
        });
        // Placement checks see the runtime before the person starts its hidden instance;
        // rendering the response must independently filter the post-write reread.
        const view =
          procedure === "create"
            ? await api.create({ slug: "chat", name: "Chat", type: "LLM" })
            : await api.update({
                poolId: "pool-1",
                ...(procedure === "members.set"
                  ? { members: { set: [{ memberId: "mem-1", weight: 2 }] } }
                  : { name: "New name" }),
              });
        expect(view.members[0]).toMatchObject({
          status: "serving",
          health: "UNHEALTHY",
          live: { instances: 1, running: 1, waiting: 4, active: 2, slots: 8 },
        });
        expect(view.members[1]).toMatchObject({
          status: "unavailable",
          health: "UNKNOWN",
          live: { instances: 0, running: 0, waiting: null, active: null, slots: null },
        });
        expect(view.runsOn).toEqual([{ nodeId: "node-1", slug: "box", mine: true, instances: 1 }]);
        expect(liveLoad).toHaveBeenCalledExactlyOnceWith(["inst-1"]);
        expect(db.node.findMany).toHaveBeenCalledExactlyOnceWith({
          where: { userId: OWNER },
          select: { id: true },
        });
        for (const [strings, ...values] of db.$queryRaw.mock.calls) {
          const query = Prisma.sql(strings as TemplateStringsArray, ...values);
          expect(query.values).toContainEqual(["hidden"]);
        }
      });
    }
  });

  describe(`${kind}: allowlist aggregates`, () => {
    for (const [label, auth, expected] of [
      ["allowlisted", scopedAgent(kind, ["node-1"]), 1],
      ["all nodes", scopedAgent(kind, null), 3],
      ["person", CALLERS.person(), 3],
    ] as const) {
      it(`${label}: member live load and runsOn exclude whole hidden instances`, async () => {
        const member = servingMember();
        const allowed = { ...member.RuntimeModel.Runtime.Instances[0]!, Reservations: [] };
        member.RuntimeModel.Runtime.Instances = [
          allowed,
          {
            ...allowed,
            id: "hidden-rank",
            Ranks: [
              ...allowed.Ranks,
              { nodeId: "hidden", Node: { slug: "hidden", userId: OWNER } },
            ],
          },
          { ...allowed, id: "hidden-reservation", Reservations: [{ nodeId: "hidden" }] },
        ] as typeof member.RuntimeModel.Runtime.Instances;
        db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
        db.pool.findFirst.mockResolvedValue(poolRow({ Members: [member] }) as never);
        const liveLoad = vi.fn(
          (ids: readonly string[]) =>
            new Map(
              ids.map((id) => [
                id,
                {
                  running: 2,
                  waiting: 4,
                  kvUsage: 0.5,
                  at: new Date(),
                },
              ]),
            ),
        );
        const api = createRouterClient(poolsRouter, { context: contextFor(auth, { liveLoad }) });
        const view = await api.get({ poolId: "pool-1" });
        expect(view.members[0]?.live).toMatchObject({
          instances: expected,
          running: expected,
          waiting: expected * 4,
          active: expected * 2,
          slots: expected * 8,
        });
        expect(view.runsOn.find((node) => node.nodeId === "node-1")?.instances).toBe(expected);
        if (expected === 1) {
          expect(view.runsOn.map((node) => node.nodeId)).toEqual(["node-1"]);
          expect(liveLoad).toHaveBeenCalledWith(["inst-1"]);
        }
      });
    }
  });

  describe(`${kind}: bound always-on instances and target health`, () => {
    for (const [label, auth, filtered] of [
      ["allowlisted", scopedAgent(kind, ["node-1"]), true],
      ["all nodes", scopedAgent(kind, null), false],
      ["person", CALLERS.person(), false],
    ] as const) {
      for (const placement of ["bound", "rank", "reservation"] as const) {
        for (const visibleUnhealthy of [false, true]) {
          it(`${label}: ${placement}, visible unhealthy=${visibleUnhealthy}: get/list health, status and live agree`, async () => {
            const base = servingMember();
            const hiddenInstance = {
              id: "hidden-instance",
              phase: "READY",
              engineSlots: 16,
              Ranks:
                placement === "rank"
                  ? [{ nodeId: "hidden", Node: { slug: "hidden", userId: OWNER } }]
                  : [],
              Reservations: placement === "reservation" ? [{ nodeId: "hidden" }] : [],
            };
            const visibleInstance = {
              ...base.RuntimeModel.Runtime.Instances[0]!,
              Reservations: [],
            };
            const hiddenMember = {
              ...base,
              RuntimeModel: {
                ...base.RuntimeModel,
                Runtime: {
                  ...base.RuntimeModel.Runtime,
                  nodeId: placement === "bound" ? "hidden" : null,
                  Node:
                    placement === "bound" ? { id: "hidden", slug: "hidden", userId: OWNER } : null,
                  Instances: [hiddenInstance],
                },
                Targets: [{ health: "HEALTHY", Instance: hiddenInstance }],
              },
            };
            // A bound runtime cannot also have a visible instance: use a second member.
            const allowedMember = {
              ...base,
              id: "allowed-member",
              runtimeModelId: "allowed-model",
              RuntimeModel: {
                ...base.RuntimeModel,
                runtimeId: "allowed-runtime",
                Targets: [{ health: "UNHEALTHY", Instance: visibleInstance }],
              },
            };
            const mixedMember = {
              ...hiddenMember,
              RuntimeModel: {
                ...hiddenMember.RuntimeModel,
                Runtime: {
                  ...hiddenMember.RuntimeModel.Runtime,
                  Instances: [visibleInstance, hiddenInstance],
                },
                Targets: [
                  { health: "UNHEALTHY", Instance: visibleInstance },
                  { health: "HEALTHY", Instance: hiddenInstance },
                ],
              },
            };
            const members = visibleUnhealthy
              ? placement === "bound"
                ? [hiddenMember, allowedMember]
                : [mixedMember]
              : [hiddenMember];
            const row = poolRow({ Members: members });
            db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
            db.pool.findFirst.mockResolvedValue(row as never);
            db.pool.findMany.mockResolvedValue([row] as never);
            db.share.findMany.mockResolvedValue([]);
            const liveLoad = vi.fn(
              (ids: readonly string[]) =>
                new Map(
                  ids.map((id) => [
                    id,
                    {
                      running: 2,
                      waiting: 4,
                      kvUsage: 0.5,
                      at: new Date(),
                    },
                  ]),
                ),
            );
            const api = createRouterClient(poolsRouter, {
              context: contextFor(auth, { liveLoad }),
            });
            const views = [await api.get({ poolId: "pool-1" }), (await api.list()).pools[0]!];
            for (const view of views) {
              const main = view.members[0]!;
              const visibleInMain = visibleUnhealthy && placement !== "bound";
              const count = (filtered ? 0 : 1) + (visibleInMain ? 1 : 0);
              expect(main.status).toBe(count ? "serving" : "unavailable");
              expect(main.health).toBe(
                filtered ? (visibleInMain ? "UNHEALTHY" : "UNKNOWN") : "HEALTHY",
              );
              expect(main.live).toMatchObject({
                instances: count,
                running: count,
                waiting: count ? count * 4 : null,
                active: count ? count * 2 : null,
                slots: count ? (filtered ? 0 : 16) + (visibleInMain ? 8 : 0) : null,
              });
              if (filtered) {
                expect(view.runsOn.map((node) => node.nodeId)).toEqual(
                  visibleUnhealthy ? ["node-1"] : [],
                );
                expect(view.runsOn[0]?.instances).toBe(visibleUnhealthy ? 1 : undefined);
                for (const [ids] of liveLoad.mock.calls)
                  expect(ids).not.toContain("hidden-instance");
              }
              if (visibleUnhealthy && placement === "bound") {
                expect(view.members[1]?.health).toBe("UNHEALTHY");
                expect(view.members[1]?.live.instances).toBe(1);
              }
            }
          });
        }
      }
    }
  });

  describe(`${kind}: request aggregate allowlist`, () => {
    for (const [label, auth, filtered] of [
      ["allowlisted", scopedAgent(kind, ["node-1"]), true],
      ["all nodes", scopedAgent(kind, null), false],
      ["person", CALLERS.person(), false],
    ] as const) {
      it(`${label}: traffic, sparkline, latency and share exclude hidden-node requests`, async () => {
        db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
        db.pool.findFirst.mockResolvedValue(poolRow({ Members: [servingMember()] }) as never);
        const queries: Prisma.Sql[] = [];
        db.$queryRaw.mockImplementation((async (
          strings: TemplateStringsArray,
          ...parts: unknown[]
        ) => {
          const query = Prisma.sql(strings, ...parts);
          queries.push(query);
          const excludesHidden =
            query.sql.includes('NOT (COALESCE("nodeId"') &&
            query.values.some((value) => Array.isArray(value) && value.includes("hidden"));
          if (query.sql.includes("AS provider_model"))
            return [
              {
                pool: "pool-1",
                runtime: "rt-1",
                provider_model: "",
                requests: excludesHidden ? 4 : 104,
                l1: 4,
                l20: excludesHidden ? 0 : 100,
              },
              { pool: "pool-1", runtime: "", provider_model: "cloud", requests: 6, l1: 6 },
            ];
          return [
            {
              pool: "pool-1",
              t: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
              requests: excludesHidden ? 10 : 110,
              errors: excludesHidden ? 1 : 21,
            },
          ];
        }) as never);
        const view = await client(auth).get({ poolId: "pool-1" });
        expect(view.traffic24h.requests).toBe(filtered ? 10 : 110);
        expect(view.traffic24h.errors).toBe(filtered ? 1 : 21);
        expect(view.traffic24h.sparkline.reduce((a, b) => a + b, 0)).toBe(filtered ? 10 : 110);
        expect(view.members[0]?.live.share).toBeCloseTo(filtered ? 4 / 10 : 104 / 110);
        const latency = view.members[0]?.live.p95LatencyMs;
        expect(latency).not.toBeNull();
        if (filtered) expect(latency).toBeLessThan(10);
        else expect(latency).toBeGreaterThan(10_000);
        expect(queries).toHaveLength(2);
        for (const query of queries) {
          expect(query.sql.includes('NOT (COALESCE("nodeId"')).toBe(filtered);
          expect(query.sql).not.toContain("hidden");
          if (filtered) expect(query.values).toContainEqual(["hidden"]);
          expect(
            query.values.some((value) => Array.isArray(value) && value.includes("hidden")),
          ).toBe(filtered);
        }
        expect(db.node.findMany).toHaveBeenCalledTimes(filtered ? 1 : 0);
      });

      it(`${label}: requests a mixed instance served on an allowed node are left out too`, async () => {
        db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
        // The head of inst-mixed is on node-1; another of its ranks is on the hidden node.
        db.runtimeInstance.findMany.mockResolvedValue([{ id: "inst-mixed" }] as never);
        db.pool.findFirst.mockResolvedValue(poolRow({ Members: [servingMember()] }) as never);
        const queries: Prisma.Sql[] = [];
        db.$queryRaw.mockImplementation((async (
          strings: TemplateStringsArray,
          ...parts: unknown[]
        ) => {
          const query = Prisma.sql(strings, ...parts);
          queries.push(query);
          const excludesMixed =
            query.sql.includes('NOT (COALESCE("instanceId"') &&
            query.values.some((value) => Array.isArray(value) && value.includes("inst-mixed"));
          if (query.sql.includes("AS provider_model"))
            return [
              {
                pool: "pool-1",
                runtime: "rt-1",
                provider_model: "",
                requests: excludesMixed ? 4 : 54,
                l1: 4,
                l20: excludesMixed ? 0 : 50,
              },
              { pool: "pool-1", runtime: "", provider_model: "cloud", requests: 6, l1: 6 },
            ];
          return [
            {
              pool: "pool-1",
              t: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
              requests: excludesMixed ? 10 : 60,
              errors: excludesMixed ? 1 : 11,
            },
          ];
        }) as never);
        const view = await client(auth).get({ poolId: "pool-1" });
        expect(view.traffic24h.requests).toBe(filtered ? 10 : 60);
        expect(view.traffic24h.errors).toBe(filtered ? 1 : 11);
        expect(view.traffic24h.sparkline.reduce((a, b) => a + b, 0)).toBe(filtered ? 10 : 60);
        expect(view.members[0]?.live.share).toBeCloseTo(filtered ? 4 / 10 : 54 / 60);
        const latency = view.members[0]?.live.p95LatencyMs;
        if (filtered) expect(latency).toBeLessThan(10);
        else expect(latency).toBeGreaterThan(10_000);
        expect(queries).toHaveLength(2);
        for (const query of queries) {
          expect(query.sql.includes('NOT (COALESCE("instanceId"')).toBe(filtered);
          expect(query.sql).not.toContain("inst-mixed");
          if (filtered) expect(query.values).toContainEqual(["inst-mixed"]);
        }
        // One lookup per read, through the shared hidden-instance predicate, with no time
        // bound: rollups bucket by completion, which can come long after the instance stopped.
        if (filtered)
          expect(db.runtimeInstance.findMany).toHaveBeenCalledExactlyOnceWith({
            where: hiddenInstancesWhere(["hidden"]),
            select: { id: true },
          });
        else expect(db.runtimeInstance.findMany).not.toHaveBeenCalled();
      });
    }
  });

  describe(`${kind}: member removal allowlist`, () => {
    for (const path of [
      "members.remove",
      "pool_update",
      "pool_delete",
      "contribution withdrawal",
    ] as const) {
      for (const [label, auth, runtimeOwner, bound, denied] of [
        ["hidden node", scopedAgent(kind, ["node-1"]), OWNER, "hidden", true],
        ["hidden rank", scopedAgent(kind, ["node-1"]), OWNER, null, true],
        ["hidden reservation", scopedAgent(kind, ["node-1"]), OWNER, null, true],
        ["allowed node", scopedAgent(kind, ["node-1"]), OWNER, "node-1", false],
        ["other person's runtime", scopedAgent(kind, ["node-1"]), "contributor", "hidden", false],
        ["null allowlist", scopedAgent(kind, null), OWNER, "hidden", false],
        ["person", CALLERS.person(), OWNER, "hidden", false],
      ] as const) {
        it(`${path}: ${label}`, async () => {
          db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
          db.pool.findFirst.mockResolvedValue(poolRow() as never);
          db.poolMember.findFirst.mockResolvedValue({
            id: "mem-1",
            poolId: "pool-1",
            Pool: {
              userId:
                path === "contribution withdrawal" && runtimeOwner === OWNER ? "pool-owner" : OWNER,
            },
            RuntimeModel: { userId: runtimeOwner },
          } as never);
          db.poolMember.findMany.mockImplementation((async () => {
            if (path === "contribution withdrawal") {
              const poolOwner = runtimeOwner === OWNER ? "pool-owner" : OWNER;
              expect(fenceLog.held).toContain(`00:owner:${poolOwner}`);
              expect(fenceLog.held).toContain(`00:owner:${OWNER}`);
            }
            return [{ RuntimeModel: { userId: runtimeOwner, runtimeId: "rt-1" } }];
          }) as never);
          db.runtime.findFirst.mockResolvedValue({
            nodeId: bound,
            Node: bound ? { id: bound, userId: OWNER } : null,
            Instances: bound
              ? []
              : [
                  {
                    id: "inst-1",
                    Ranks: [
                      {
                        rank: 0,
                        claim: "HELD",
                        nodeId: label === "hidden rank" ? "hidden" : "node-1",
                        Node: { id: label === "hidden rank" ? "hidden" : "node-1", userId: OWNER },
                      },
                    ],
                    Reservations:
                      label === "hidden reservation"
                        ? [
                            {
                              index: 0,
                              nodeId: "hidden",
                              supersededGeneration: null,
                              Node: { id: "hidden", userId: OWNER },
                            },
                          ]
                        : [],
                  },
                ],
          } as never);
          db.poolMember.deleteMany.mockResolvedValue({ count: 1 });
          db.pool.deleteMany.mockResolvedValue({ count: 1 });
          const api = client(auth);
          const result =
            path === "pool_delete"
              ? api.delete({ poolId: "pool-1" })
              : path === "contribution withdrawal"
                ? api.members.removeContributed({ memberId: "mem-1" })
                : api.update({
                    poolId: "pool-1",
                    ...(path === "pool_update" ? { name: "Updated" } : {}),
                    members: { remove: ["mem-1"] },
                  });
          if (path === "contribution withdrawal") {
            // graphWrite takes every owner before the placement check and delete.
            const expectedOwner = runtimeOwner === OWNER ? "pool-owner" : OWNER;
            await result.catch(() => undefined);
            expect(fenceLog.held).toContain(`00:owner:${expectedOwner}`);
            expect(fenceLog.held).toContain(`00:owner:${OWNER}`);
            expect(fenceLog.held).toContain(`00:owner:${runtimeOwner}`);
          }
          if (denied) {
            await expect(result).rejects.toMatchObject({
              code: "NOT_FOUND",
              message: "That runtime does not exist.",
            });
            expect(db.poolMember.deleteMany).not.toHaveBeenCalled();
            expect(db.pool.update).not.toHaveBeenCalled();
            expect(db.pool.deleteMany).not.toHaveBeenCalled();
            expect(db.auditEvent.create).not.toHaveBeenCalled();
          } else {
            await result;
            expect(
              path === "pool_delete" ? db.pool.deleteMany : db.poolMember.deleteMany,
            ).toHaveBeenCalled();
          }
        });
      }
    }
  });
}

describe("hidden nodes are only the caller's nodes", () => {
  for (const kind of ["agent_token", "oauth_access_token"] as const) {
    for (const bound of [false, true]) {
      it(`${kind}: keeps another person's contributed health and runsOn, bound=${bound}`, async () => {
        const member = servingMember();
        const instance = {
          ...member.RuntimeModel.Runtime.Instances[0]!,
          Ranks: bound
            ? []
            : [{ nodeId: "contributor-node", Node: { slug: "theirs", userId: "contributor" } }],
          Reservations: [],
        };
        const contributed = {
          ...member,
          shareId: "share-1",
          RuntimeModel: {
            ...member.RuntimeModel,
            Runtime: {
              ...member.RuntimeModel.Runtime,
              nodeId: bound ? "contributor-node" : null,
              Node: bound
                ? { id: "contributor-node", slug: "theirs", userId: "contributor" }
                : null,
              Instances: [instance],
            },
            Targets: [{ health: "HEALTHY", Instance: instance }],
          },
        };
        db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
        db.pool.findFirst.mockResolvedValue(poolRow({ Members: [contributed] }) as never);
        const view = await client(scopedAgent(kind, ["node-1"])).get({ poolId: "pool-1" });
        expect(view.members[0]?.live).toMatchObject({
          instances: 1,
          running: 1,
          active: null,
          slots: null,
        });
        expect(view.members[0]?.health).toBe("HEALTHY");
        expect(view.members[0]?.status).toBe("serving");
        expect(view.runsOn).toEqual([
          { nodeId: "contributor-node", slug: "theirs", mine: false, instances: 1 },
        ]);
        expect(db.node.findMany).toHaveBeenCalledExactlyOnceWith({
          where: { userId: OWNER },
          select: { id: true },
        });
      });
    }
    it(`${kind}: preserves cloud-provider health with an explicit node allowlist`, async () => {
      const cloud = {
        ...servingMember(),
        kind: "CLOUD",
        RuntimeModel: null,
        runtimeModelId: null,
        providerModelId: "provider-model",
        cloudOrder: 0,
        ProviderModel: { upstreamModelId: "cloud-model", Target: { health: "HEALTHY" } },
      };
      db.node.findMany.mockResolvedValue([{ id: "node-1" }, { id: "hidden" }] as never);
      db.pool.findFirst.mockResolvedValue(poolRow({ Members: [cloud] }) as never);
      const view = await client(scopedAgent(kind, ["node-1"])).get({ poolId: "pool-1" });
      expect(view.members[0]).toMatchObject({
        health: "HEALTHY",
        status: "cloud_standby",
        live: { instances: 0, running: 0 },
      });
    });
  }
});
