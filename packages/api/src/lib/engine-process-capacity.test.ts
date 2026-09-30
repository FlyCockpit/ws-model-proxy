import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  return { default: mockDeep(), Prisma };
});
const { default: prisma } = await import("@ws-model-proxy/db");
const {
  planEngineProcessCapacity,
  sweepOrphanAutoCapacities,
  repointTargetCapacity,
  ensureEngineProcessCapacity,
  applyEngineProcessCapacityPlan,
} = await import("./engine-process-capacity");

import type { EngineKindName, WireEngineFacts } from "./engine-facts";
import type { EngineProcessTarget } from "./engine-process-capacity";

const auto = (key: string) => ({ runtimeIdentityKey: key, hardConcurrencyLimitSource: "AUTO" });
const own = (id: string): EngineProcessTarget => ({
  id,
  upstreamModelId: id,
  capacityAssignmentSource: "AUTO",
  capacity: auto(`discovered-model:${id}`),
});
function plan(
  engine: EngineKindName | undefined,
  aliases: string[] | undefined,
  targets = [own("a"), own("b")],
  inventory = ["a", "b"],
) {
  const facts: WireEngineFacts = {
    ...(engine ? { engine: { value: engine, source: "probe" } } : {}),
    ...(aliases ? { servedModelAliases: { value: aliases, source: "probe" } } : {}),
  };
  return planEngineProcessCapacity({
    endpointId: "ep",
    engineFacts: facts,
    inventoryModelIds: inventory,
    targets,
  });
}

describe("process capacity proof table", () => {
  // Positive rows fail without #91; negative rows pin the fail-closed boundary
  // and would pass old code, which never re-pointed any target.
  it.each(["llama.cpp", "vllm", "sglang"] as const)(
    "accepts %s process proof with every auto provenance",
    (engine) => {
      for (const capacity of [
        null,
        auto("discovered-model:a"),
        auto("execution-target:a"),
        auto("engine-process:ep"),
      ]) {
        expect(plan(engine, ["a", "b"], [{ ...own("a"), capacity }, own("b")])).toEqual({
          sharedTargetIds: ["a", "b"],
          splitTargetIds: [],
        });
      }
    },
  );
  it.each(["ollama", "lm-studio", "generic", undefined] as const)(
    "never merges %s even with aliases",
    (engine) => {
      expect(plan(engine, ["a", "b"]).sharedTargetIds).toEqual([]);
    },
  );
  it.each([
    undefined,
    [],
    ["a"],
    ["a", "a"],
    ["a", "B"],
    ["a", " b"],
    ["a", "b "],
    ["a", "outside"],
    Array.from({ length: 65 }, (_, i) => (i < 2 ? ["a", "b"][i]! : `x${i}`)),
  ])("requires two exact inventory ids: %j", (aliases) => {
    expect(plan("llama.cpp", aliases).sharedTargetIds).toEqual([]);
  });
  it.each([null, auto("discovered-model:a"), auto("engine-process:ep")])(
    "preserves durable owner assignments and detach: %j",
    (capacity) => {
      const target = { ...own("a"), capacity, capacityAssignmentSource: "OWNER" };
      expect(plan("llama.cpp", ["a", "b"], [target, own("b")])).toEqual({
        sharedTargetIds: [],
        splitTargetIds: [],
      });
      expect(plan("llama.cpp", undefined, [target, own("b")]).splitTargetIds).toEqual([]);
    },
  );
  it("deduplicates proof, intersects inventory, and excludes user choices", () => {
    for (const capacity of [
      { ...auto("discovered-model:c"), hardConcurrencyLimitSource: "USER" },
      auto("owner:c"),
    ]) {
      const targets = [own("a"), own("b"), { ...own("c"), capacity }];
      expect(
        plan("llama.cpp", ["a", "b", "a", "outside", "c"], targets, ["a", "b", "c"])
          .sharedTargetIds,
      ).toEqual(["a", "b"]);
      expect(plan("llama.cpp", ["a", "c"], targets, ["a", "c"]).sharedTargetIds).toEqual([]);
    }
    expect(
      plan("llama.cpp", ["a", "b", "c"], [own("a"), own("b"), own("c")], ["a", "b", "c"])
        .sharedTargetIds,
    ).toEqual(["a", "b", "c"]);
    expect(plan("llama.cpp", ["a", "b"], [own("a"), own("a")]).sharedTargetIds).toEqual([]);
    expect(
      plan("llama.cpp", ["a", "b"], [own("a"), { ...own("b"), id: "a" }]).sharedTargetIds,
    ).toEqual([]);
  });
  it("splits missing aliases, absent inventory ids, and engine changes, preserving user assignments", () => {
    const targets = ["a", "b", "c"].map((id) => ({
      ...own(id),
      capacity: auto("engine-process:ep"),
    }));
    for (const engine of ["llama.cpp", "ollama", undefined] as const) {
      expect(plan(engine, undefined, targets).splitTargetIds).toEqual(["a", "b", "c"]);
    }
    expect(plan("llama.cpp", ["a", "b", "c"], targets).splitTargetIds).toEqual(["c"]);
    expect(
      plan(
        "llama.cpp",
        undefined,
        targets.map((target) => ({
          ...target,
          capacity: { ...auto("engine-process:ep"), hardConcurrencyLimitSource: "USER" },
        })),
      ).splitTargetIds,
    ).toEqual([]);
  });
});

describe("lifecycle transaction seams", () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([
    {
      name: "idle auto",
      source: "AUTO",
      lease: null,
      waiter: null,
      context: null,
      ceiling: 2048,
      expected: 1,
    },
    {
      name: "owner auto destination",
      source: "OWNER",
      lease: null,
      waiter: null,
      context: null,
      ceiling: null,
      expected: 0,
    },
    {
      name: "live lease",
      source: "AUTO",
      lease: { id: "l" },
      waiter: null,
      context: null,
      ceiling: null,
      expected: 0,
    },
    {
      name: "waiting waiter",
      source: "AUTO",
      lease: null,
      waiter: { id: "w" },
      context: null,
      ceiling: null,
      expected: 0,
    },
    {
      name: "unconfigured AUTO hard limit",
      source: "AUTO",
      lease: null,
      waiter: null,
      context: null,
      ceiling: null,
      hardLimit: null,
      expected: 0,
    },
    {
      name: "known context too small",
      source: "AUTO",
      lease: null,
      waiter: null,
      context: 1024,
      ceiling: 2048,
      expected: 0,
    },
  ])(
    "guards automatic repoint: $name",
    async ({ source, lease, waiter, context, ceiling, expected, hardLimit = 1 }) => {
      vi.mocked(prisma.executionTarget.findUnique).mockResolvedValue({
        id: "t",
        userId: "u",
        inferenceCapacityId: "old",
        capacityAssignmentSource: source,
        InferenceCapacity: auto("discovered-model:t"),
        directConcurrencyLimit: null,
        directReservedSlots: 0,
        directContextCeiling: ceiling,
        directContextMargin: 0,
        PoolMembers: [],
      } as unknown as Awaited<ReturnType<typeof prisma.executionTarget.findUnique>>);
      vi.mocked(prisma.inferenceCapacity.findUnique).mockResolvedValue({
        id: "new",
        userId: "u",
        ...auto("engine-process:ep"),
        hardConcurrencyLimit: hardLimit,
        physicalMaxContext: context,
      } as Awaited<ReturnType<typeof prisma.inferenceCapacity.findUnique>>);
      vi.mocked(prisma.capacityLease.findFirst).mockResolvedValue(
        lease as Awaited<ReturnType<typeof prisma.capacityLease.findFirst>>,
      );
      vi.mocked(prisma.capacityWaiter.findFirst).mockResolvedValue(
        waiter as Awaited<ReturnType<typeof prisma.capacityWaiter.findFirst>>,
      );
      vi.mocked(prisma.executionTarget.updateMany).mockResolvedValue({ count: 1 });
      expect(
        await repointTargetCapacity(prisma, {
          userId: "u",
          targetId: "t",
          fromCapacityId: "old",
          toCapacityId: "new",
        }),
      ).toBe(expected);
      expect(prisma.executionTarget.updateMany).toHaveBeenCalledTimes(expected);
      if (expected)
        expect(prisma.executionTarget.updateMany).toHaveBeenCalledWith({
          where: {
            id: "t",
            userId: "u",
            inferenceCapacityId: "old",
            capacityAssignmentSource: "AUTO",
          },
          data: { inferenceCapacityId: "new" },
        });
      expect(
        await repointTargetCapacity(prisma, {
          userId: "u",
          targetId: "t",
          fromCapacityId: "new",
          toCapacityId: "new",
        }),
      ).toBe(0);
    },
  );
  it.each([
    { name: "unrelated AUTO lease", busy: "unrelated", source: "AUTO", waiter: false, moved: true },
    {
      name: "unrelated USER shared lease",
      busy: "unrelated",
      source: "OWNER",
      waiter: false,
      moved: true,
    },
    {
      name: "involved source lease",
      busy: "a-private",
      source: "AUTO",
      waiter: false,
      moved: false,
    },
    {
      name: "involved destination lease",
      busy: "shared",
      source: "AUTO",
      waiter: false,
      moved: false,
    },
    {
      name: "involved source waiter",
      busy: "a-private",
      source: "AUTO",
      waiter: true,
      moved: false,
    },
    {
      name: "live unchanged sibling on destination",
      busy: "shared",
      source: "AUTO",
      waiter: false,
      moved: false,
      same: true,
    },
  ])("coordinator idle boundary: $name", async ({ busy, source, waiter, moved, same }) => {
    const capacity = (id: string, key: string, provenance = "AUTO") => ({
      id,
      userId: "u",
      runtimeIdentityKey: key,
      hardConcurrencyLimitSource: provenance,
      hardConcurrencyLimit: 2,
      physicalMaxContext: null,
      engineSlots: null,
    });
    const capacities = [
      capacity("a-private", "execution-target:a"),
      capacity("b-private", "execution-target:b"),
      capacity("shared", "engine-process:ep"),
      capacity(
        "unrelated",
        source === "OWNER" ? "owner:shared" : "execution-target:c",
        source === "OWNER" ? "USER" : "AUTO",
      ),
    ];
    const targets = ["a", "b", "c"].map((id, i) => ({
      id,
      userId: "u",
      discoveredModelId: `dm-${id}`,
      DiscoveredModel: { upstreamModelId: id },
      inferenceCapacityId: same && id === "a" ? "shared" : capacities[i === 2 ? 3 : i]!.id,
      InferenceCapacity: same && id === "a" ? capacities[2]! : capacities[i === 2 ? 3 : i]!,
      capacityAssignmentSource: id === "c" ? source : "AUTO",
      capacityAutoConcurrencyLimit: 1,
      directConcurrencyLimit: null,
      directReservedSlots: 0,
      directContextCeiling: null,
      directContextMargin: 0,
      PoolMembers: [],
    }));
    vi.mocked(prisma.executionTarget.findMany).mockImplementation(
      async (args) =>
        (args?.where?.inferenceCapacityId
          ? targets.filter((t) => t.inferenceCapacityId === args.where!.inferenceCapacityId)
          : targets) as unknown as Awaited<ReturnType<typeof prisma.executionTarget.findMany>>,
    );
    vi.mocked(prisma.executionTarget.findUnique).mockImplementation(
      async (args) =>
        targets.find((t) => t.id === args.where.id) as unknown as Awaited<
          ReturnType<typeof prisma.executionTarget.findUnique>
        >,
    );
    vi.mocked(prisma.executionTarget.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.inferenceCapacity.findUnique).mockImplementation(
      async (args) =>
        (args.where.id ? capacities.find((c) => c.id === args.where.id) : capacities[2]) as Awaited<
          ReturnType<typeof prisma.inferenceCapacity.findUnique>
        >,
    );
    vi.mocked(prisma.inferenceCapacity.findMany).mockResolvedValue(
      capacities as Awaited<ReturnType<typeof prisma.inferenceCapacity.findMany>>,
    );
    vi.mocked(prisma.inferenceCapacity.upsert).mockResolvedValue(
      capacities[2]! as Awaited<ReturnType<typeof prisma.inferenceCapacity.upsert>>,
    );
    const liveFor = (args: { where?: { capacityId?: unknown } } | undefined) => {
      const filter = args?.where?.capacityId as { in?: string[] } | undefined;
      return filter?.in?.includes(busy) ? { id: "live" } : null;
    };
    vi.mocked(prisma.capacityLease.findFirst).mockImplementation(
      async (args) =>
        (waiter ? null : liveFor(args)) as Awaited<
          ReturnType<typeof prisma.capacityLease.findFirst>
        >,
    );
    vi.mocked(prisma.capacityWaiter.findFirst).mockImplementation(
      async (args) =>
        (waiter ? liveFor(args) : null) as Awaited<
          ReturnType<typeof prisma.capacityWaiter.findFirst>
        >,
    );
    const result = await applyEngineProcessCapacityPlan(prisma, {
      userId: "u",
      endpointId: "ep",
      endpointSlug: "engine",
      inventoryModelIds: ["a", "b", "c"],
      engineFacts: {
        engine: { value: "vllm", source: "probe" },
        servedModelAliases: { value: ["a", "b"], source: "probe" },
      },
    });
    expect([...result.assignments.keys()]).toEqual(moved ? ["a", "b"] : []);
    for (const call of vi.mocked(prisma.capacityLease.findFirst).mock.calls)
      expect(call[0]?.where?.capacityId).not.toEqual(
        expect.objectContaining({ in: expect.arrayContaining(["unrelated"]) }),
      );
  });

  it("seeds shared limits without mutating existing rows before preflight", async () => {
    vi.mocked(prisma.inferenceCapacity.upsert).mockResolvedValue({ id: "shared" } as Awaited<
      ReturnType<typeof prisma.inferenceCapacity.upsert>
    >);
    expect(
      await ensureEngineProcessCapacity(prisma, {
        userId: "u",
        endpointId: "ep",
        endpointSlug: "llama",
        reportedConcurrency: [undefined, null, 0, 7, 3],
      }),
    ).toBe("shared");
    expect(prisma.inferenceCapacity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimeIdentityKey: "engine-process:ep",
          label: "Engine process llama",
          hardConcurrencyLimit: 13,
          hardConcurrencyLimitSource: "AUTO",
        }),
      }),
    );
    expect(prisma.inferenceCapacity.updateMany).not.toHaveBeenCalled();
    for (const [slots, expected] of [
      [5, 5],
      [0, 3],
      [10_001, 3],
      [1.5, 3],
    ] as const) {
      vi.mocked(prisma.inferenceCapacity.upsert).mockClear();
      await ensureEngineProcessCapacity(prisma, {
        userId: "u",
        endpointId: "ep",
        endpointSlug: "llama",
        slots,
        reportedConcurrency: [1, 2],
      });
      expect(prisma.inferenceCapacity.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ hardConcurrencyLimit: expected }),
        }),
      );
    }
  });

  it("retries a conflicted sweep, fences before deletion, and advances its keyset", async () => {
    vi.mocked(prisma.inferenceCapacity.findMany)
      .mockResolvedValueOnce([{ id: "c", userId: "u" }] as Awaited<
        ReturnType<typeof prisma.inferenceCapacity.findMany>
      >)
      .mockResolvedValueOnce([{ id: "c" }] as Awaited<
        ReturnType<typeof prisma.inferenceCapacity.findMany>
      >)
      .mockResolvedValueOnce([]);
    vi.mocked(prisma.$transaction)
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementation(async (work) => {
        if (typeof work !== "function") throw new Error("Expected interactive transaction");
        return work(prisma);
      });
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ acquired: true }]);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
    expect(await sweepOrphanAutoCapacities({ batchSize: 1 })).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(prisma.$queryRaw).mock.calls;
    expect(calls.map((call) => call[1])).toEqual([["00:owner:u"], ["08:capacity:c"]]);
    expect(vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(prisma.$executeRaw).mock.invocationCallOrder.at(-1)!,
    );
    expect(prisma.inferenceCapacity.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { gt: "c" } }), take: 1 }),
    );
  });

  it.each(["live", "contended"])(
    "advances past the last scanned retained %s row, never the first or last deleted",
    async (retention) => {
      const rows = ["01", "02", "03", "04"].map((id) => ({ id, userId: "u" }));
      const pages = [rows.slice(0, 2), rows.slice(2), []];
      vi.mocked(prisma.inferenceCapacity.findMany).mockImplementation(async (args) => {
        if (args?.take)
          return pages.shift()! as Awaited<ReturnType<typeof prisma.inferenceCapacity.findMany>>;
        return rows.filter((row) =>
          (args?.where?.id as { in?: string[] } | undefined)?.in?.includes(row.id),
        ) as Awaited<ReturnType<typeof prisma.inferenceCapacity.findMany>>;
      });
      vi.mocked(prisma.$transaction).mockImplementation(async (work) => {
        if (typeof work !== "function") throw new Error("Expected interactive transaction");
        return work(prisma);
      });
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ acquired: retention === "live" }]);
      let deletedPage = false;
      vi.mocked(prisma.$executeRaw).mockImplementation(async (query) => {
        const sql = "sql" in query ? query.sql : query.join("");
        if (!/DELETE\s+FROM\s+inference_capacity/.test(sql)) return 0;
        const count = deletedPage ? 0 : 1;
        deletedPage = true;
        return count;
      });
      expect(await sweepOrphanAutoCapacities({ batchSize: 2 })).toBe(retention === "live" ? 1 : 0);
      const scans = vi
        .mocked(prisma.inferenceCapacity.findMany)
        .mock.calls.filter((call) => call[0]?.take);
      expect(scans.map((call) => call[0]?.where?.id)).toEqual([
        undefined,
        { gt: "02" },
        { gt: "04" },
      ]);
      expect(scans).toHaveLength(3);
    },
  );

  it("pins the default sweep batch and rejects unbounded or non-progressing batches", async () => {
    vi.mocked(prisma.inferenceCapacity.findMany).mockResolvedValue([]);
    expect(await sweepOrphanAutoCapacities()).toBe(0);
    expect(prisma.inferenceCapacity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, orderBy: { id: "asc" } }),
    );
    for (const batchSize of [0, -1, 201, 1.5])
      await expect(sweepOrphanAutoCapacities({ batchSize })).rejects.toThrow("Invalid");
  });
});
