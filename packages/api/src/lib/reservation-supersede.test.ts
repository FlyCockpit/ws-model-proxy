import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: { DbNull: null } }));

import { DbNull } from "@ws-model-proxy/db/json-null";
import { type PlacementContext, PlacementPlanner } from "./placement";
import { loadPlacementInstances } from "./placement-load";
import { dropSupersededHolds } from "./reservations";
import type { RuntimeResource } from "./runtime-spec";
import { type PlannedStartWrite, type Tx, writePlannedStarts } from "./runtime-store";

// A restart of a run that may still be running (F1): the old run's reservations keep holding
// (superseded), and its rank claims too (`prev*`), until the new run's leading stop proved the
// old run stopped, so another start cannot take that memory (or port) while the old launcher may
// still use it. The old and new claims of the instance on one node overlap (max, not sum).
// In-memory tables answer the writer, the placement loader and the drop; the production planner
// decides.

type Claim = "HELD" | "HELD_UNKNOWN" | "RELEASED";
type RankRow = {
  id: string;
  instanceId: string;
  nodeId: string | null;
  rank: number;
  claim: Claim;
  resources: Record<string, unknown>;
  port: number;
  distPort: number | null;
  plannedGeneration: number;
  prevResources: Record<string, unknown> | null;
  prevPort: number | null;
  prevDistPort: number | null;
  prevGeneration: number | null;
};
type ReservationRow = {
  id: string;
  instanceId: string;
  nodeId: string | null;
  index: number;
  labels: string[];
  resources: Record<string, unknown>;
  supersededGeneration: number | null;
  plannedGeneration: number;
};

const GB100 = { kind: "unified", memoryGb: 100 } as const;
const GB20 = { kind: "unified", memoryGb: 20 } as const;

/**
 * `generation`: the instance's latest step generation; `dispatched`: the latest one with a start
 * step that was sent (its run may be running).
 */
function memoryDb(rankClaim: Claim, generation: number, dispatched = generation) {
  // `run`: the instance's run (`runGeneration`); the latest step generation is its run here.
  const steps = { generation, dispatched, run: generation };
  const ranks: RankRow[] = [
    {
      id: "k0",
      instanceId: "old",
      nodeId: "head",
      rank: 0,
      claim: rankClaim,
      resources: GB100,
      port: 30000,
      distPort: null,
      plannedGeneration: 0,
      prevResources: null,
      prevPort: null,
      prevDistPort: null,
      prevGeneration: null,
    },
  ];
  /** Prisma's write data with `Prisma.DbNull` read as the null it stores. */
  const plain = (data: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, value === DbNull ? null : value]),
    );
  let nextId = 1;
  const reservations: ReservationRow[] = [
    {
      id: "r0",
      instanceId: "old",
      nodeId: "w1",
      index: 0,
      labels: ["worker"],
      resources: GB100,
      supersededGeneration: null,
      plannedGeneration: 0,
    },
  ];
  const matches = (row: ReservationRow, where: Record<string, unknown>) => {
    if (where.instanceId !== undefined && row.instanceId !== where.instanceId) return false;
    const id = where.id as { in?: string[] } | undefined;
    if (id?.in && !id.in.includes(row.id)) return false;
    const superseded = where.supersededGeneration as null | { lt?: number } | undefined;
    if (superseded === null && row.supersededGeneration !== null) return false;
    if (superseded && typeof superseded === "object" && superseded.lt !== undefined)
      if (row.supersededGeneration === null || row.supersededGeneration >= superseded.lt)
        return false;
    return true;
  };
  const db = {
    runtimeInstance: {
      findUnique: async () => ({ runGeneration: steps.run, phase: "READY", operationId: "op-0" }),
      // A restart begins the next run (`beginRun`).
      update: async (args: { data: { runGeneration?: number } }) => {
        if (args.data.runGeneration !== undefined) steps.run = args.data.runGeneration;
        return {};
      },
      // The loader: instances holding a claim on these nodes (ranks, or reservations while a
      // rank holds), with every reservation row.
      findMany: async () => {
        const held = ranks.filter((rank) => rank.claim !== "RELEASED");
        if (held.length === 0) return [];
        return [
          {
            id: "old",
            userId: "u1",
            runtimeId: "rt-old",
            desiredState: "RUNNING",
            Runtime: { kind: "STARTABLE", Models: [] },
            LaunchVersion: { spec: {} },
            Ranks: held.map((rank) => ({
              nodeId: rank.nodeId,
              port: rank.port,
              distPort: rank.distPort,
              resources: rank.resources,
              claim: rank.claim,
              prevResources: rank.prevResources,
              prevPort: rank.prevPort,
              prevDistPort: rank.prevDistPort,
            })),
            Reservations: [...reservations]
              .sort((a, b) => a.index - b.index)
              .map((row) => ({
                nodeId: row.nodeId,
                resources: row.resources,
                supersededGeneration: row.supersededGeneration,
              })),
          },
        ];
      },
    },
    instanceRank: {
      findMany: async () => ranks.map((rank) => ({ ...rank })),
      update: async (args: {
        where: { id?: string; instanceId_rank?: { rank: number } };
        data: Record<string, unknown>;
      }) => {
        const rank = ranks.find((row) =>
          args.where.id !== undefined
            ? row.id === args.where.id
            : row.rank === args.where.instanceId_rank?.rank,
        );
        if (!rank) throw new Error("no rank row");
        Object.assign(rank, plain(args.data));
        return rank;
      },
      updateMany: async (args: {
        where: { instanceId: string; prevGeneration?: { lt: number } };
        data: Record<string, unknown>;
      }) => {
        const hit = ranks.filter(
          (rank) =>
            rank.instanceId === args.where.instanceId &&
            (args.where.prevGeneration === undefined ||
              (rank.prevGeneration !== null && rank.prevGeneration < args.where.prevGeneration.lt)),
        );
        for (const rank of hit) Object.assign(rank, plain(args.data));
        return { count: hit.length };
      },
    },
    instanceStep: {
      aggregate: async (args: { where: { attempts?: unknown } }) => ({
        _max: { generation: args.where.attempts ? steps.dispatched : steps.generation },
      }),
    },
    claimReleaseRequest: { updateMany: async () => ({ count: 0 }) },
    instanceReservation: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        reservations.filter((row) => matches(row, args.where)),
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: { supersededGeneration: number | null };
      }) => {
        const hit = reservations.filter((row) => matches(row, args.where));
        for (const row of hit) row.supersededGeneration = args.data.supersededGeneration;
        return { count: hit.length };
      },
      update: async (args: { where: { id: string }; data: Partial<ReservationRow> }) => {
        const row = reservations.find((entry) => entry.id === args.where.id);
        if (!row) throw new Error("no reservation row");
        Object.assign(row, args.data);
        return row;
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        const keep = reservations.filter((row) => !matches(row, args.where));
        const count = reservations.length - keep.length;
        reservations.splice(0, reservations.length, ...keep);
        return { count };
      },
      createMany: async (args: {
        data: Array<Omit<ReservationRow, "id" | "supersededGeneration">>;
      }) => {
        for (const row of args.data)
          reservations.push({ ...row, id: `n${nextId++}`, supersededGeneration: null });
        return { count: args.data.length };
      },
    },
  };
  return { db: db as unknown as Tx, ranks, reservations, steps };
}

function context(instances: PlacementContext["instances"]): PlacementContext {
  return {
    callerId: "u1",
    agent: false,
    instances,
    fabrics: [],
    nodes: ["head", "w1", "w2"].map((id) => ({
      id,
      slug: id,
      online: true,
      trust: "FULL" as const,
      held: false,
      labels: ["worker"],
      portRange: [30000, 30009] as const,
      heldVersionIds: new Set<string>(),
      requiredVersionIds: new Set<string>(),
      frozenFabrics: null,
      memoryGb: 126,
      gpus: [],
      liveFreeMemoryGb: null,
    })),
  };
}

/** Whether another runtime's 100 GiB rank fits on `nodeId` now. */
async function admitsOn(db: Tx, nodeId: string): Promise<boolean> {
  const instances = await loadPlacementInstances(db, ["head", "w1", "w2"]);
  return new PlacementPlanner(context(instances)).place({
    runtimeId: "rt-other",
    versionId: "v9",
    launch: { groupSize: 1, labels: [], resources: [GB100] },
    nodeIds: [nodeId],
    checkFrozen: false,
    preempt: false,
  }).ok;
}

function restart(reservations: PlannedStartWrite["reservations"]): PlannedStartWrite {
  return {
    runtimeId: "rt-old",
    versionId: "v2",
    instanceId: "old",
    placements: [{ nodeId: "head", nodeNumber: 1, port: 30000, resources: GB100 }],
    reservations,
    fabric: null,
    distPort: null,
  };
}

const write = (db: Tx, start: PlannedStartWrite) =>
  writePlannedStarts(db, {
    userId: "u1",
    operationId: "op-restart",
    startedBy: "USER",
    starts: [start],
    blockedBy: [[]],
  });

describe("a restart of a running instance keeps the old run's reservations held", () => {
  it("a moved reservation: the old node stays counted until a later generation's START", async () => {
    const { db, reservations } = memoryDb("HELD", 1);
    // Control: the old run's reservation fills w1.
    expect(await admitsOn(db, "w1")).toBe(false);
    await write(db, restart([{ index: 0, nodeId: "w2", labels: ["worker"], resources: GB100 }]));
    // The old run has not been stopped yet: w1 is still held (and w2 by the new plan).
    expect(await admitsOn(db, "w1")).toBe(false);
    expect(await admitsOn(db, "w2")).toBe(false);
    expect(reservations.map((row) => [row.nodeId, row.supersededGeneration])).toEqual([
      ["w1", 1],
      ["w2", null],
    ]);
    // A START of generation 1 (the old run's own) proves nothing about the old run.
    await dropSupersededHolds(db, "old", 1);
    expect(await admitsOn(db, "w1")).toBe(false);
    // Generation 2's START is claimed only after its leading stop succeeded: w1 is free.
    await dropSupersededHolds(db, "old", 2);
    expect(await admitsOn(db, "w1")).toBe(true);
    expect(reservations.map((row) => row.nodeId)).toEqual(["w2"]);
  });

  it("a removed reservation stays counted until the old run stopped", async () => {
    const { db, reservations } = memoryDb("HELD", 3);
    await write(db, restart([]));
    expect(await admitsOn(db, "w1")).toBe(false);
    expect(reservations.map((row) => row.supersededGeneration)).toEqual([3]);
    await dropSupersededHolds(db, "old", 4);
    expect(await admitsOn(db, "w1")).toBe(true);
  });

  it("a shrunk reservation keeps the old amount counted next to the new one", async () => {
    const { db } = memoryDb("HELD", 1);
    await write(db, restart([{ index: 0, nodeId: "w1", labels: ["worker"], resources: GB20 }]));
    const instances = await loadPlacementInstances(db, ["head", "w1", "w2"]);
    const onW1 = instances
      .flatMap((instance) => instance.ranks)
      .filter((rank) => rank.nodeId === "w1")
      .map((rank) => (rank.resources as { memoryGb: number }).memoryGb);
    expect(onW1.sort()).toEqual([100, 20].sort());
    await dropSupersededHolds(db, "old", 2);
    const after = (await loadPlacementInstances(db, ["head", "w1", "w2"]))
      .flatMap((instance) => instance.ranks)
      .filter((rank) => rank.nodeId === "w1");
    expect(after.map((rank) => (rank.resources as { memoryGb: number }).memoryGb)).toEqual([20]);
  });

  it("an unchanged reservation stays the same row (nothing counted twice)", async () => {
    const { db, reservations } = memoryDb("HELD", 1);
    await write(db, restart([{ index: 0, nodeId: "w1", labels: ["worker"], resources: GB100 }]));
    expect(reservations).toEqual([
      expect.objectContaining({ id: "r0", nodeId: "w1", supersededGeneration: null }),
    ]);
  });

  it("a marked-stopped (HELD_UNKNOWN) run keeps its moved reservation held too", async () => {
    const { db } = memoryDb("HELD_UNKNOWN", 1);
    await write(db, restart([{ index: 0, nodeId: "w2", labels: ["worker"], resources: GB100 }]));
    expect(await admitsOn(db, "w1")).toBe(false);
  });

  it("an old run proven stopped (claims RELEASED) frees its old reservations at once", async () => {
    const { db, reservations } = memoryDb("RELEASED", 1);
    await write(db, restart([{ index: 0, nodeId: "w2", labels: ["worker"], resources: GB100 }]));
    expect(reservations.map((row) => [row.nodeId, row.supersededGeneration])).toEqual([
      ["w2", null],
    ]);
    expect(await admitsOn(db, "w1")).toBe(true);
  });
});

const on = (nodeId: string) => [{ index: 0, nodeId, labels: [`only-${nodeId}`], resources: GB100 }];

describe("superseded reservations stay bounded to the last run that was dispatched", () => {
  it("alternating restarts before the old run stopped keep at most the old row and the new one", async () => {
    // Generation 1 (on w1) ran; twenty restarts alternate w2 and w1, none of them dispatched.
    const { db, reservations } = memoryDb("HELD", 1);
    reservations[0] = { ...(reservations[0] as ReservationRow), labels: ["only-w1"] };
    for (let attempt = 0; attempt < 20; attempt++) {
      await write(db, restart(on(attempt % 2 === 0 ? "w2" : "w1")));
      expect(reservations.length).toBeLessThanOrEqual(2);
      // The old run's w1 stays held throughout.
      expect(await admitsOn(db, "w1")).toBe(false);
    }
    // Back on w1: the old run's own row is current again, nothing else is left.
    expect(reservations.map((row) => [row.id, row.nodeId, row.supersededGeneration])).toEqual([
      ["r0", "w1", null],
    ]);
    expect(await admitsOn(db, "w2")).toBe(true);
  });

  it("restarts to new nodes each time keep only the dispatched run's row plus the newest plan", async () => {
    const { db, reservations } = memoryDb("HELD", 1);
    for (const nodeId of ["w2", "head", "w2", "head"]) {
      await write(db, restart(on(nodeId)));
      expect(reservations.map((row) => [row.nodeId, row.supersededGeneration])).toEqual([
        ["w1", 1],
        [nodeId, null],
      ]);
    }
  });

  it("a row whose plan was dispatched is superseded, not deleted, when the next restart drops it", async () => {
    const { db, reservations, steps } = memoryDb("HELD", 1);
    await write(db, restart(on("w2")));
    // Generation 2 (the w2 plan) was dispatched after its leading stop: the w1 row went.
    steps.generation = 2;
    steps.dispatched = 2;
    await dropSupersededHolds(db, "old", 2);
    await write(db, restart(on("head")));
    expect(reservations.map((row) => [row.nodeId, row.supersededGeneration])).toEqual([
      ["w2", 2],
      ["head", null],
    ]);
    expect(await admitsOn(db, "w2")).toBe(false);
  });

  it("a retake after the old run stopped deletes superseded rows (the retaken claim never holds them)", async () => {
    const { db, reservations } = memoryDb("RELEASED", 2);
    reservations.push({
      id: "old-superseded",
      instanceId: "old",
      nodeId: "w2",
      index: 0,
      labels: ["worker"],
      resources: GB100,
      supersededGeneration: 1,
      plannedGeneration: 0,
    });
    // The new plan has no reservations at all.
    await write(db, restart([]));
    expect(reservations).toEqual([]);
    expect(await admitsOn(db, "w2")).toBe(true);
    expect(await admitsOn(db, "w1")).toBe(true);
  });
});

/** Whether another runtime's rank with these resources (and fixed port) fits on `nodeId` now. */
async function admitsOther(
  db: Tx,
  nodeId: string,
  resources: RuntimeResource,
  fixedPort?: number,
): Promise<boolean> {
  const instances = await loadPlacementInstances(db, ["head", "w1", "w2"]);
  return new PlacementPlanner(context(instances)).place({
    runtimeId: "rt-other",
    versionId: "v9",
    launch: {
      groupSize: 1,
      labels: [],
      resources: [resources],
      ...(fixedPort === undefined ? {} : { port: { fixed: fixedPort } }),
    },
    nodeIds: [nodeId],
    checkFrozen: false,
    preempt: false,
  }).ok;
}

/** A restart onto these rank resources and port (its reservation unchanged on w1). */
function rankRestart(resources: Record<string, unknown>, port = 30000): PlannedStartWrite {
  return {
    ...restart([{ index: 0, nodeId: "w1", labels: ["worker"], resources: GB100 }]),
    placements: [{ nodeId: "head", nodeNumber: 1, port, resources }],
  };
}

describe("a restart keeps the running rank's claim held until the old run stopped (prev*)", () => {
  it("a shrunk rank keeps its old memory held: another 100 GiB does not fit before the stop", async () => {
    const { db, ranks } = memoryDb("HELD", 1);
    await write(db, rankRestart(GB20));
    expect(ranks[0]).toMatchObject({
      resources: GB20,
      prevResources: GB100,
      prevPort: 30000,
      prevGeneration: 1,
      plannedGeneration: 1,
    });
    // 126 GiB: the old run's 100 GiB overlaps the new 20 (max, not sum): 26 GiB are free.
    expect(await admitsOther(db, "head", GB100)).toBe(false);
    expect(await admitsOther(db, "head", { kind: "unified", memoryGb: 26 })).toBe(true);
    expect(await admitsOther(db, "head", { kind: "unified", memoryGb: 27 })).toBe(false);
    // A START of the old run's own generation proves nothing.
    await dropSupersededHolds(db, "old", 1);
    expect(await admitsOther(db, "head", GB100)).toBe(false);
    // The new run's START is claimed after its leading STOP: the old claim goes.
    await dropSupersededHolds(db, "old", 2);
    expect(ranks[0]).toMatchObject({ prevResources: null, prevPort: null, prevGeneration: null });
    expect(await admitsOther(db, "head", GB100)).toBe(true);
  });

  it("a port-changing restart keeps the old port taken until the old run stopped", async () => {
    const { db } = memoryDb("HELD", 1);
    await write(db, rankRestart(GB20, 30005));
    expect(await admitsOther(db, "head", { kind: "none" }, 30000)).toBe(false);
    expect(await admitsOther(db, "head", { kind: "none" }, 30005)).toBe(false);
    await dropSupersededHolds(db, "old", 2);
    expect(await admitsOther(db, "head", { kind: "none" }, 30000)).toBe(true);
  });

  it("a claim that never ran is replaced without being kept", async () => {
    // Generation 1 was planned but its START never dispatched.
    const { db, ranks } = memoryDb("HELD", 1, 0);
    await write(db, rankRestart(GB20, 30005));
    expect(ranks[0]).toMatchObject({ resources: GB20, port: 30005, prevPort: null });
    expect(await admitsOther(db, "head", { kind: "none" }, 30000)).toBe(true);
  });

  it("a restart before the new claim ran keeps the old run's claim, not the unused one", async () => {
    const { db, ranks } = memoryDb("HELD", 1);
    await write(db, rankRestart(GB20, 30005));
    // Run 2 never dispatched; run 3 replaces its unused claim, the old run's stays kept.
    await write(db, rankRestart({ kind: "unified", memoryGb: 40 }, 30006));
    expect(ranks[0]).toMatchObject({
      resources: { kind: "unified", memoryGb: 40 },
      port: 30006,
      prevResources: GB100,
      prevPort: 30000,
      prevGeneration: 1,
      plannedGeneration: 2,
    });
    expect(await admitsOther(db, "head", { kind: "none" }, 30005)).toBe(true);
    expect(await admitsOther(db, "head", { kind: "none" }, 30000)).toBe(false);
  });

  it("an unchanged restart keeps nothing and keeps the claim's plan (it may still be in use)", async () => {
    const { db, ranks } = memoryDb("HELD", 1);
    await write(db, rankRestart(GB100));
    expect(ranks[0]).toMatchObject({ prevPort: null, plannedGeneration: 0 });
    // Its next change, before run 2 ran, still keeps the claim run 1 uses.
    await write(db, rankRestart(GB20));
    expect(ranks[0]).toMatchObject({ prevResources: GB100, prevGeneration: 2 });
  });

  it("a retake after the old run was proven stopped keeps nothing of it", async () => {
    const { db, ranks } = memoryDb("RELEASED", 1);
    await write(db, rankRestart(GB20, 30005));
    expect(ranks[0]).toMatchObject({ claim: "HELD", prevPort: null, plannedGeneration: 1 });
    expect(await admitsOther(db, "head", GB100)).toBe(true);
  });

  it("an unchanged claim retaken after it was released is planned for the new run", async () => {
    // Run 1 (100 GiB) was proven stopped; the retake keeps the same claim, then shrinks it
    // before the new run is dispatched: run 1's stopped dispatch must not resurrect 100 GiB.
    const { db, ranks } = memoryDb("RELEASED", 1);
    await write(db, rankRestart(GB100));
    expect(ranks[0]).toMatchObject({ claim: "HELD", prevPort: null, plannedGeneration: 1 });
    await write(db, rankRestart(GB20));
    expect(ranks[0]).toMatchObject({ prevPort: null, prevGeneration: null });
    expect(await admitsOther(db, "head", GB100)).toBe(true);
  });

  it("a kept claim and a dispatched current claim at once is refused, never dropped", async () => {
    const { db, ranks, steps } = memoryDb("HELD", 1);
    await write(db, rankRestart(GB20, 30005));
    // Run 2's START dispatched without its claim dropping the kept one: the order is broken.
    steps.dispatched = 2;
    await expect(write(db, rankRestart({ kind: "unified", memoryGb: 40 }))).rejects.toThrow(
      /previous claim is still held/,
    );
    expect(ranks[0]?.prevResources).toEqual(GB100);
  });

  it("a shrunk reservation counts the larger amount once, not both", async () => {
    const { db } = memoryDb("HELD", 1);
    await write(db, restart([{ index: 0, nodeId: "w1", labels: ["worker"], resources: GB20 }]));
    // w1 (126 GiB) holds max(100, 20): 26 GiB free, not 6.
    expect(await admitsOther(db, "w1", { kind: "unified", memoryGb: 26 })).toBe(true);
    expect(await admitsOther(db, "w1", { kind: "unified", memoryGb: 27 })).toBe(false);
  });

  it("deleting the head keeps the workers' reservations held while the rank stays held", async () => {
    // node_delete_release leaves a rank with reservations on surviving nodes HELD (its node
    // cleared); only a person's release (without proof) frees them.
    const { db, ranks } = memoryDb("HELD", 1);
    (ranks[0] as RankRow).nodeId = null;
    expect(await admitsOther(db, "w1", GB100)).toBe(false);
    (ranks[0] as RankRow).claim = "RELEASED";
    expect(await admitsOther(db, "w1", GB100)).toBe(true);
  });
});
