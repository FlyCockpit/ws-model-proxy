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
} = await import("./engine-process-capacity");

import type { EngineKindName, WireEngineFacts } from "./engine-facts";
import type { EngineProcessTarget } from "./engine-process-capacity";

const auto = (key: string) => ({ runtimeIdentityKey: key, hardConcurrencyLimitSource: "AUTO" });
const own = (id: string): EngineProcessTarget => ({
  id,
  upstreamModelId: id,
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
  it("guards a re-point by owner and original FK, and treats an identical FK as a no-op", async () => {
    vi.mocked(prisma.executionTarget.updateMany).mockResolvedValue({ count: 1 });
    expect(
      await repointTargetCapacity(prisma, {
        userId: "u",
        targetId: "t",
        fromCapacityId: "old",
        toCapacityId: "new",
      }),
    ).toBe(1);
    expect(prisma.executionTarget.updateMany).toHaveBeenCalledWith({
      where: { id: "t", userId: "u", inferenceCapacityId: "old" },
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
    expect(prisma.executionTarget.updateMany).toHaveBeenCalledTimes(1);
  });
  it("seeds the shared limit from engine slots, else the summed member seeds, and guards null fills", async () => {
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
    expect(prisma.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: {
        id: "shared",
        userId: "u",
        hardConcurrencyLimit: null,
        hardConcurrencyLimitSource: "AUTO",
      },
      data: { hardConcurrencyLimit: 13 },
    });
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
      vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0]!,
    );
    expect(prisma.inferenceCapacity.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { gt: "c" } }), take: 1 }),
    );
  });

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
