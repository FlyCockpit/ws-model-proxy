import type { Prisma } from "@ws-model-proxy/db";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const {
  backfillDiscoveredInferenceCapacities,
  discoveredHardConcurrencyLimit,
  ensureDiscoveredInferenceCapacity,
} = await import("./discovered-inference-capacity.js");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  executionTarget: {
    findMany: MockInstance;
    findUnique: MockInstance;
    updateMany: MockInstance;
    delete: MockInstance;
    deleteMany: MockInstance;
  };
  inferenceCapacity: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    upsert: MockInstance;
    delete: MockInstance;
    deleteMany: MockInstance;
  };
};

type CapacityWriteArgs = {
  where?: {
    id?: string;
    userId?: string;
    hardConcurrencyLimit?: number | null;
    hardConcurrencyLimitSource?: "AUTO" | "USER";
    runtimeIdentityKey?: { in?: readonly string[] };
  };
  data?: { hardConcurrencyLimit?: number | null; hardConcurrencyLimitSource?: "AUTO" | "USER" };
};

function applyCapacityWrite(
  row: {
    id: string;
    userId: string;
    runtimeIdentityKey: string;
    hardConcurrencyLimit: number | null;
    hardConcurrencyLimitSource?: "AUTO" | "USER";
  },
  args: CapacityWriteArgs,
): { count: number } {
  const where = args.where ?? {};
  if (where.id !== undefined && where.id !== row.id) return { count: 0 };
  if (where.userId !== undefined && where.userId !== row.userId) return { count: 0 };
  if (
    where.hardConcurrencyLimit !== undefined &&
    where.hardConcurrencyLimit !== row.hardConcurrencyLimit
  ) {
    return { count: 0 };
  }
  if (
    where.hardConcurrencyLimitSource !== undefined &&
    where.hardConcurrencyLimitSource !== (row.hardConcurrencyLimitSource ?? "AUTO")
  ) {
    return { count: 0 };
  }
  const keys = where.runtimeIdentityKey?.in;
  if (keys && !keys.includes(row.runtimeIdentityKey)) return { count: 0 };
  if (args.data && "hardConcurrencyLimit" in args.data) {
    row.hardConcurrencyLimit = args.data.hardConcurrencyLimit ?? null;
  }
  if (args.data?.hardConcurrencyLimitSource !== undefined) {
    row.hardConcurrencyLimitSource = args.data.hardConcurrencyLimitSource;
  }
  return { count: 1 };
}

/** The fence arrays passed to `wsmp_acquire_fences`, one per call, in call order. */
function fenceCalls(): string[][] {
  return db.$queryRaw.mock.calls
    .filter((call) =>
      String((call[0] as readonly string[]).join("?")).includes("wsmp_acquire_fences"),
    )
    .map((call) => call[1] as string[]);
}

describe("discovered inference capacity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.executionTarget.findMany.mockReset();
    db.$queryRaw.mockResolvedValue([{ acquired: true }]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findUnique.mockResolvedValue(null);
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "new-capacity" });
    db.inferenceCapacity.updateMany.mockReset();
    db.inferenceCapacity.updateMany.mockResolvedValue({ count: 0 });
    db.executionTarget.updateMany.mockResolvedValue({ count: 1 });
  });

  it("uses the pool-wizard default when no finite concurrency was reported", () => {
    expect(discoveredHardConcurrencyLimit(undefined)).toBe(1);
    expect(discoveredHardConcurrencyLimit(null)).toBe(1);
    expect(discoveredHardConcurrencyLimit(0)).toBe(1);
    expect(discoveredHardConcurrencyLimit(4)).toBe(4);
  });

  it("creates a capacity for a null target and leaves one that already has one", async () => {
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "bare-target",
        userId: "user-id",
        discoveredModelId: "model-bare",
        DiscoveredModel: { upstreamModelId: "llama" },
      },
      {
        id: "kept-target",
        userId: "user-id",
        discoveredModelId: "model-kept",
        DiscoveredModel: { upstreamModelId: "other" },
      },
    ]);
    db.executionTarget.findUnique
      .mockResolvedValueOnce({
        id: "bare-target",
        userId: "user-id",
        kind: "DISCOVERED_MODEL",
        discoveredModelId: "model-bare",
        inferenceCapacityId: null,
        capacityAssignmentSource: "AUTO",
      })
      .mockResolvedValueOnce({
        id: "kept-target",
        userId: "user-id",
        kind: "DISCOVERED_MODEL",
        discoveredModelId: "model-kept",
        inferenceCapacityId: "kept-capacity",
      });

    await expect(backfillDiscoveredInferenceCapacities()).resolves.toEqual({
      attached: 1,
      unchanged: 1,
    });

    // Writer class M: the owner fence alone first, then (after reading the
    // adoptable capacity candidates) the target's capacity-policy fence,
    // all before the first write.
    expect(fenceCalls()).toEqual([
      ["00:owner:user-id"],
      ["06:capacity-policy:bare-target"],
      ["00:owner:user-id"],
      ["06:capacity-policy:kept-target"],
    ]);
    const policyFence = db.$queryRaw.mock.invocationCallOrder[1] ?? Number.NaN;
    expect(policyFence).toBeLessThan(
      db.inferenceCapacity.upsert.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(policyFence).toBeLessThan(
      db.executionTarget.updateMany.mock.invocationCallOrder[0] ?? Number.NaN,
    );

    expect(db.executionTarget.findMany).toHaveBeenCalledWith({
      where: {
        inferenceCapacityId: null,
        capacityAssignmentSource: "AUTO",
        kind: "DISCOVERED_MODEL",
        discoveredModelId: { not: null },
      },
      select: {
        id: true,
        userId: true,
        discoveredModelId: true,
        DiscoveredModel: { select: { upstreamModelId: true } },
      },
    });
    expect(db.inferenceCapacity.upsert).toHaveBeenCalledTimes(1);
    expect(db.inferenceCapacity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          userId: "user-id",
          label: "Discovered model model-bare",
          runtimeIdentityKey: "discovered-model:model-bare",
          runtimeModel: "llama",
          hardConcurrencyLimit: 1,
          hardConcurrencyLimitSource: "AUTO",
          countStrategy: "CONSERVATIVE_ESTIMATE",
        }),
      }),
    );
    expect(db.executionTarget.updateMany).toHaveBeenCalledTimes(1);
    expect(db.executionTarget.updateMany).toHaveBeenCalledWith({
      where: {
        id: "bare-target",
        userId: "user-id",
        inferenceCapacityId: null,
        capacityAssignmentSource: "AUTO",
      },
      data: { inferenceCapacityId: "new-capacity" },
    });
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: {
        id: "new-capacity",
        userId: "user-id",
        hardConcurrencyLimit: null,
        hardConcurrencyLimitSource: "AUTO",
        runtimeIdentityKey: {
          in: ["execution-target:bare-target", "discovered-model:model-bare"],
        },
      },
      data: { hardConcurrencyLimit: 1, hardConcurrencyLimitSource: "AUTO" },
    });

    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.upsert.mockClear();
    db.inferenceCapacity.updateMany.mockClear();
    db.executionTarget.updateMany.mockClear();
    await expect(backfillDiscoveredInferenceCapacities()).resolves.toEqual({
      attached: 0,
      unchanged: 0,
    });
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("does not fill an existing destination during automatic move preflight", async () => {
    db.inferenceCapacity.findUnique.mockResolvedValue({ id: "existing" });
    expect(
      await ensureDiscoveredInferenceCapacity(prisma, {
        userId: "user-id",
        discoveredModelId: "model",
        executionTargetId: "target",
        upstreamModelId: "a",
        fillExistingLimit: false,
      }),
    ).toBe("existing");
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
    db.inferenceCapacity.findUnique.mockResolvedValue(null);
    await ensureDiscoveredInferenceCapacity(prisma, {
      userId: "user-id",
      discoveredModelId: "model",
      upstreamModelId: "a",
      fillExistingLimit: false,
    });
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("rechecks durable owner detach after the startup scan", async () => {
    db.executionTarget.findMany
      .mockResolvedValueOnce([
        {
          id: "target",
          userId: "user-id",
          discoveredModelId: "model",
          DiscoveredModel: { upstreamModelId: "a" },
        },
      ])
      .mockResolvedValueOnce([]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target",
      userId: "user-id",
      kind: "DISCOVERED_MODEL",
      discoveredModelId: "model",
      inferenceCapacityId: null,
      capacityAssignmentSource: "OWNER",
    });
    expect(await backfillDiscoveredInferenceCapacities()).toEqual({ attached: 0, unchanged: 1 });
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
  });

  it("reuses a schema-hardening capacity instead of creating another", async () => {
    db.executionTarget.findMany.mockResolvedValue([
      {
        id: "bare-target",
        userId: "user-id",
        discoveredModelId: "model-bare",
        DiscoveredModel: { upstreamModelId: "llama" },
      },
    ]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "bare-target",
      userId: "user-id",
      kind: "DISCOVERED_MODEL",
      discoveredModelId: "model-bare",
      inferenceCapacityId: null,
      capacityAssignmentSource: "AUTO",
    });
    db.inferenceCapacity.findUnique.mockResolvedValue({ id: "legacy-capacity" });
    db.inferenceCapacity.findMany.mockResolvedValue([{ id: "legacy-capacity" }]);

    await expect(backfillDiscoveredInferenceCapacities()).resolves.toEqual({
      attached: 1,
      unchanged: 0,
    });

    // The adoptable capacity is fenced with the target's policy fence.
    expect(db.inferenceCapacity.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-id",
        runtimeIdentityKey: {
          in: ["execution-target:bare-target", "discovered-model:model-bare"],
        },
      },
      select: { id: true },
    });
    expect(fenceCalls()).toEqual([
      ["00:owner:user-id"],
      ["06:capacity-policy:bare-target", "08:capacity:legacy-capacity"],
    ]);

    expect(db.inferenceCapacity.findUnique).toHaveBeenCalledWith({
      where: {
        userId_runtimeIdentityKey: {
          userId: "user-id",
          runtimeIdentityKey: "execution-target:bare-target",
        },
      },
      select: { id: true },
    });
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).toHaveBeenCalledWith({
      where: {
        id: "bare-target",
        userId: "user-id",
        inferenceCapacityId: null,
        capacityAssignmentSource: "AUTO",
      },
      data: { inferenceCapacityId: "legacy-capacity" },
    });
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: {
        id: "legacy-capacity",
        userId: "user-id",
        hardConcurrencyLimit: null,
        hardConcurrencyLimitSource: "AUTO",
        runtimeIdentityKey: {
          in: ["execution-target:bare-target", "discovered-model:model-bare"],
        },
      },
      data: { hardConcurrencyLimit: 1, hardConcurrencyLimitSource: "AUTO" },
    });
  });

  it("fills a null limit on a kept legacy capacity and does not rewrite 4", async () => {
    const tx = db as unknown as Prisma.TransactionClient;
    const open = {
      id: "legacy-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:bare-target",
      hardConcurrencyLimit: null as number | null,
    };
    db.inferenceCapacity.findUnique.mockResolvedValue({ id: open.id });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(open, args),
    );

    await expect(
      ensureDiscoveredInferenceCapacity(tx, {
        userId: "user-id",
        discoveredModelId: "model-bare",
        upstreamModelId: "llama",
        executionTargetId: "bare-target",
        reportedConcurrency: 4,
      }),
    ).resolves.toBe("legacy-capacity");
    expect(open.hardConcurrencyLimit).toBe(4);
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();

    const kept = {
      id: "legacy-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:bare-target",
      hardConcurrencyLimit: 4,
    };
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(kept, args),
    );
    await ensureDiscoveredInferenceCapacity(tx, {
      userId: "user-id",
      discoveredModelId: "model-bare",
      upstreamModelId: "llama",
      executionTargetId: "bare-target",
    });
    expect(kept.hardConcurrencyLimit).toBe(4);
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
  });

  it("fills a pre-attached trigger capacity whose hard limit is null", async () => {
    // The schema-hardening trigger was not executed. Prisma is mocked.
    const row = {
      id: "trigger-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:trigger-target",
      hardConcurrencyLimit: null as number | null,
    };
    db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "trigger-target",
        userId: "user-id",
        discoveredModelId: "model-trigger",
        inferenceCapacityId: row.id,
        InferenceCapacity: {
          runtimeIdentityKey: row.runtimeIdentityKey,
          hardConcurrencyLimit: null,
          hardConcurrencyLimitSource: "AUTO",
        },
      },
    ]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "trigger-target",
      userId: "user-id",
      kind: "DISCOVERED_MODEL",
      discoveredModelId: "model-trigger",
      inferenceCapacityId: row.id,
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await expect(backfillDiscoveredInferenceCapacities()).resolves.toEqual({
      attached: 0,
      unchanged: 0,
    });

    expect(row.hardConcurrencyLimit).toBe(1);
    expect(fenceCalls()).toEqual([
      ["00:owner:user-id", "06:capacity-policy:trigger-target", "08:capacity:trigger-capacity"],
    ]);
    expect(db.$queryRaw.mock.invocationCallOrder[0] ?? Number.NaN).toBeLessThan(
      db.inferenceCapacity.updateMany.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    expect(db.executionTarget.delete).not.toHaveBeenCalled();
    expect(db.executionTarget.deleteMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.delete).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.deleteMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: {
        id: "trigger-capacity",
        userId: "user-id",
        hardConcurrencyLimit: null,
        hardConcurrencyLimitSource: "AUTO",
        runtimeIdentityKey: {
          in: ["execution-target:trigger-target", "discovered-model:model-trigger"],
        },
      },
      data: { hardConcurrencyLimit: 1, hardConcurrencyLimitSource: "AUTO" },
    });
    expect(db.executionTarget.findMany).toHaveBeenCalledWith({
      where: {
        kind: "DISCOVERED_MODEL",
        discoveredModelId: { not: null },
        inferenceCapacityId: { not: null },
        InferenceCapacity: {
          is: {
            hardConcurrencyLimit: null,
            hardConcurrencyLimitSource: "AUTO",
            OR: [
              { runtimeIdentityKey: { startsWith: "discovered-model:" } },
              { runtimeIdentityKey: { startsWith: "execution-target:" } },
              { runtimeIdentityKey: { startsWith: "engine-process:" } },
            ],
          },
        },
      },
      select: {
        id: true,
        userId: true,
        discoveredModelId: true,
        inferenceCapacityId: true,
        DiscoveredModel: { select: { endpointId: true } },
        InferenceCapacity: {
          select: {
            runtimeIdentityKey: true,
            hardConcurrencyLimit: true,
            hardConcurrencyLimitSource: true,
          },
        },
      },
    });
  });

  it("leaves every shared limit for the inventory aggregate at startup", async () => {
    for (const [key, source, expected] of [
      ["engine-process:ep", "AUTO", null],
      ["engine-process:other", "AUTO", null],
      ["engine-process:ep", "USER", null],
    ] as const) {
      const row = {
        id: "shared",
        userId: "user-id",
        runtimeIdentityKey: key,
        hardConcurrencyLimit: null as number | null,
        hardConcurrencyLimitSource: source,
      };
      db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: "target",
          userId: "user-id",
          discoveredModelId: "model",
          inferenceCapacityId: "shared",
          DiscoveredModel: { endpointId: "ep" },
          InferenceCapacity: row,
        },
      ]);
      db.executionTarget.findUnique.mockResolvedValue({
        id: "target",
        userId: "user-id",
        kind: "DISCOVERED_MODEL",
        discoveredModelId: "model",
        inferenceCapacityId: "shared",
      });
      db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
        applyCapacityWrite(row, args),
      );
      await backfillDiscoveredInferenceCapacities();
      expect(row.hardConcurrencyLimit).toBe(expected);
    }
  });

  it("does not rewrite a pre-attached auto capacity whose hard limit is 4", async () => {
    const row = {
      id: "trigger-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:trigger-target",
      hardConcurrencyLimit: 4,
    };
    db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "trigger-target",
        userId: "user-id",
        discoveredModelId: "model-trigger",
        inferenceCapacityId: row.id,
        InferenceCapacity: {
          runtimeIdentityKey: row.runtimeIdentityKey,
          hardConcurrencyLimit: 4,
          hardConcurrencyLimitSource: "AUTO",
        },
      },
    ]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "trigger-target",
      userId: "user-id",
      kind: "DISCOVERED_MODEL",
      discoveredModelId: "model-trigger",
      inferenceCapacityId: row.id,
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await backfillDiscoveredInferenceCapacities();

    expect(row.hardConcurrencyLimit).toBe(4);
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    expect(db.executionTarget.deleteMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.deleteMany).not.toHaveBeenCalled();
  });

  it("does not change a pre-attached capacity whose runtime key is not this target's", async () => {
    const row = {
      id: "custom-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:other-target",
      hardConcurrencyLimit: null as number | null,
    };
    db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "trigger-target",
        userId: "user-id",
        discoveredModelId: "model-trigger",
        inferenceCapacityId: row.id,
        InferenceCapacity: {
          runtimeIdentityKey: row.runtimeIdentityKey,
          hardConcurrencyLimit: null,
          hardConcurrencyLimitSource: "AUTO",
        },
      },
    ]);
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await backfillDiscoveredInferenceCapacities();

    expect(row.hardConcurrencyLimit).toBeNull();
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
  });

  it("does not replace a foreign key that is already set", async () => {
    const row = {
      id: "trigger-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:trigger-target",
      hardConcurrencyLimit: null as number | null,
    };
    db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "trigger-target",
        userId: "user-id",
        discoveredModelId: "model-trigger",
        inferenceCapacityId: row.id,
        InferenceCapacity: {
          runtimeIdentityKey: row.runtimeIdentityKey,
          hardConcurrencyLimit: null,
          hardConcurrencyLimitSource: "AUTO",
        },
      },
    ]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "trigger-target",
      userId: "user-id",
      kind: "DISCOVERED_MODEL",
      discoveredModelId: "model-trigger",
      inferenceCapacityId: "replaced-capacity",
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await backfillDiscoveredInferenceCapacities();

    expect(row.hardConcurrencyLimit).toBeNull();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("never fills a USER-sourced null (explicit unlimited) during startup backfill", async () => {
    const row = {
      id: "trigger-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:trigger-target",
      hardConcurrencyLimit: null as number | null,
      hardConcurrencyLimitSource: "USER" as "AUTO" | "USER",
    };
    // Even if a stale read reported the row as AUTO, the write predicate
    // re-checks the source against the current row.
    db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "trigger-target",
        userId: "user-id",
        discoveredModelId: "model-trigger",
        inferenceCapacityId: row.id,
        InferenceCapacity: {
          runtimeIdentityKey: row.runtimeIdentityKey,
          hardConcurrencyLimit: null,
          hardConcurrencyLimitSource: "AUTO",
        },
      },
    ]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "trigger-target",
      userId: "user-id",
      kind: "DISCOVERED_MODEL",
      discoveredModelId: "model-trigger",
      inferenceCapacityId: row.id,
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await backfillDiscoveredInferenceCapacities();

    expect(row.hardConcurrencyLimit).toBeNull();
    expect(row.hardConcurrencyLimitSource).toBe("USER");
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          hardConcurrencyLimit: null,
          hardConcurrencyLimitSource: "AUTO",
        }),
      }),
    );
  });

  it("skips a USER-sourced null read by the startup backfill without writing", async () => {
    db.executionTarget.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "trigger-target",
        userId: "user-id",
        discoveredModelId: "model-trigger",
        inferenceCapacityId: "trigger-capacity",
        InferenceCapacity: {
          runtimeIdentityKey: "execution-target:trigger-target",
          hardConcurrencyLimit: null,
          hardConcurrencyLimitSource: "USER",
        },
      },
    ]);

    await backfillDiscoveredInferenceCapacities();

    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("does not let a CLI-reported limit overwrite a USER unlimited or USER number", async () => {
    const tx = db as unknown as Prisma.TransactionClient;
    for (const userLimit of [null, 3]) {
      const row = {
        id: "legacy-capacity",
        userId: "user-id",
        runtimeIdentityKey: "execution-target:bare-target",
        hardConcurrencyLimit: userLimit as number | null,
        hardConcurrencyLimitSource: "USER" as "AUTO" | "USER",
      };
      db.inferenceCapacity.findUnique.mockResolvedValue({ id: row.id });
      db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
        applyCapacityWrite(row, args),
      );

      await ensureDiscoveredInferenceCapacity(tx, {
        userId: "user-id",
        discoveredModelId: "model-bare",
        upstreamModelId: "llama",
        executionTargetId: "bare-target",
        reportedConcurrency: 8,
      });

      expect(row.hardConcurrencyLimit).toBe(userLimit);
      expect(row.hardConcurrencyLimitSource).toBe("USER");
    }
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
  });

  it("still fills an AUTO null row with the CLI-reported limit and keeps it AUTO", async () => {
    const tx = db as unknown as Prisma.TransactionClient;
    const row = {
      id: "new-capacity",
      userId: "user-id",
      runtimeIdentityKey: "discovered-model:model-bare",
      hardConcurrencyLimit: null as number | null,
      hardConcurrencyLimitSource: "AUTO" as "AUTO" | "USER",
    };
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await ensureDiscoveredInferenceCapacity(tx, {
      userId: "user-id",
      discoveredModelId: "model-bare",
      upstreamModelId: "llama",
      reportedConcurrency: 6,
    });

    expect(row.hardConcurrencyLimit).toBe(6);
    expect(row.hardConcurrencyLimitSource).toBe("AUTO");
  });
});
