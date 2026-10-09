import type { Prisma } from "@ws-model-proxy/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The engine's rotating passes on a mocked Prisma: in-memory tables of ranks marked stopped and of
// STOPPING instances that answer each pass's where/orderBy/take and its claim writes, and default
// empty answers for the rest of a tick.

type Rank = {
  id: string;
  nodeId: string | null;
  rank: number;
  instanceId: string;
  claim: "HELD" | "HELD_UNKNOWN" | "RELEASED";
  lastStopCheckAt: Date | null;
  Instance: { userId: string };
};

type Stopping = {
  id: string;
  userId: string;
  phase: "STOPPING" | "STOPPED";
  phaseChangedAt: Date;
  lastStopReconcileAt: Date | null;
};

type DateFilter = { lte?: Date } | null | undefined;
type StepArgs = { where: { instanceId?: string; phase?: string } };
type InstanceArgs = {
  where: { id?: unknown; phase?: unknown; lastStopReconcileAt?: Date | null };
  take?: number;
  data?: { lastStopReconcileAt?: Date | null };
};

const store = vi.hoisted(() => ({
  ranks: [] as Rank[],
  instances: [] as Stopping[],
  /** Ids the passes claimed, in order (ranks and instances). */
  claims: [] as string[],
  /** Instance ids whose fenced write throws (a check or settle that keeps failing). */
  failing: new Set<string>(),
  /** STATUS steps the probe sees for a rank id (finished or live). */
  probes: new Map<string, { state: string; updatedAt: Date }[]>(),
  /** Runs before a claim write (another server process racing this one). */
  beforeClaim: null as ((id: string) => void) | null,
}));

function rankMatches(rank: Rank, where: Prisma.InstanceRankWhereInput): boolean {
  if (typeof where.id === "string" && rank.id !== where.id) return false;
  if (typeof where.claim === "string" && rank.claim !== where.claim) return false;
  const node = where.nodeId;
  if (node && typeof node === "object" && "in" in node && Array.isArray(node.in))
    if (rank.nodeId === null || !node.in.includes(rank.nodeId)) return false;
  if (where.OR) {
    const at = rank.lastStopCheckAt;
    const ok = where.OR.some((branch) => {
      const filter = branch.lastStopCheckAt as DateFilter;
      if (filter === null) return at === null;
      if (filter?.lte) return at !== null && at.getTime() <= filter.lte.getTime();
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

const time = (at: Date | null) => at?.getTime() ?? Number.NEGATIVE_INFINITY;
const byCheck = (a: Rank, b: Rank) =>
  time(a.lastStopCheckAt) - time(b.lastStopCheckAt) || a.id.localeCompare(b.id);
const byReconcile = (a: Stopping, b: Stopping) =>
  time(a.lastStopReconcileAt) - time(b.lastStopReconcileAt) ||
  a.phaseChangedAt.getTime() - b.phaseChangedAt.getTime() ||
  a.id.localeCompare(b.id);

const instanceRank = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));
const instanceStep = vi.hoisted(() => ({
  findMany: vi.fn<(args: StepArgs) => Promise<{ state: string; updatedAt: Date }[]>>(),
}));
const runtimeInstance = vi.hoisted(() => ({
  findMany: vi.fn<(args: InstanceArgs) => Promise<Stopping[]>>(),
  updateMany: vi.fn<(args: InstanceArgs) => Promise<{ count: number }>>(),
}));

const db = vi.hoisted(() => {
  const empty = (method: string) => {
    if (method === "findMany" || method === "groupBy") return async () => [];
    if (method === "count") return async () => 0;
    if (method === "aggregate") return async () => ({ _max: { sequence: null } });
    if (method.endsWith("Many")) return async () => ({ count: 0 });
    return async () => null;
  };
  const model = (overrides: Record<string, unknown> = {}) =>
    new Proxy(overrides, {
      get: (target, key) =>
        typeof key === "string" ? (target[key] ?? empty(key)) : Reflect.get(target, key),
    });
  const models: Record<string, unknown> = {
    instanceRank: model(instanceRank),
    instanceStep: model(instanceStep),
    runtimeInstance: model(runtimeInstance),
  };
  return new Proxy(models, {
    get: (target, key) => {
      if (typeof key !== "string") return Reflect.get(target, key);
      models[key] ??= model();
      return models[key];
    },
  });
});

vi.mock("@ws-model-proxy/db", () => ({ default: db }));
vi.mock("@ws-model-proxy/db/user-deletion-access", () => ({
  userCredentialAccessBlocked: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/api/lib/graph-write", () => ({
  graphWrite: vi.fn(
    async (
      _owners: Iterable<string>,
      work: (tx: unknown) => Promise<unknown>,
      fences: () => Promise<{ instanceId: string }>,
    ) => {
      const { instanceId } = await fences();
      if (store.failing.has(instanceId)) throw new Error("serialization failure");
      return work(db);
    },
  ),
  // The fence callback hands the mocked write the instance it is for.
  instanceCapacityFences: vi.fn(async (ids: string[]) => ({ instanceId: ids[0] })),
}));

const { RuntimeLifecycle, HELD_UNKNOWN_PROBE_MS } = await import("./lifecycle.js");

const NODE = "node-1";
const PASS = 64;
const RECONCILE_PASS = PASS * 4;
let clock = new Date("2026-10-01T00:00:00Z");

const id = (prefix: string, index: number) => `${prefix}${String(index).padStart(4, "0")}`;

function engine(connected = true) {
  return new RuntimeLifecycle(
    {
      sendToNode: () => true,
      nodeSession: () =>
        connected ? { userId: "u1", connectionGeneration: 1, trust: "full" } : null,
      onlineNodeIds: () => [NODE],
    },
    { now: () => clock },
  );
}

function seedRanks(count: number, at: (index: number) => Date | null = () => null) {
  store.ranks = Array.from({ length: count }, (_, index) => ({
    id: id("r", index),
    nodeId: NODE,
    rank: 0,
    instanceId: id("i", index),
    claim: "HELD_UNKNOWN",
    lastStopCheckAt: at(index),
    Instance: { userId: "u1" },
  }));
}

function seedStopping(count: number) {
  store.instances = Array.from({ length: count }, (_, index) => ({
    id: id("s", index),
    userId: "u1",
    phase: "STOPPING",
    phaseChangedAt: new Date(clock.getTime() - (count - index) * 1_000),
    lastStopReconcileAt: null,
  }));
}

/** One tick; returns the ids the passes claimed, in order. */
async function pass(lc: InstanceType<typeof RuntimeLifecycle>, prefix: "r" | "s") {
  store.claims = [];
  await lc.runOnce();
  return store.claims.filter((claimed) => claimed.startsWith(prefix));
}

beforeEach(() => {
  clock = new Date("2026-10-01T00:00:00Z");
  store.ranks = [];
  store.instances = [];
  store.claims = [];
  store.failing.clear();
  store.probes.clear();
  store.beforeClaim = null;
  instanceRank.findMany.mockImplementation(
    async (args: { where: Prisma.InstanceRankWhereInput; take: number }) =>
      store.ranks
        .filter((rank) => rankMatches(rank, args.where))
        .sort(byCheck)
        .slice(0, args.take),
  );
  instanceRank.updateMany.mockImplementation(
    async (args: {
      where: Prisma.InstanceRankWhereInput;
      data: { lastStopCheckAt?: Date | null };
    }) => {
      // The pass's claim is the write that carries the due filter (OR).
      const claim = args.where.OR !== undefined && typeof args.where.id === "string";
      if (claim && typeof args.where.id === "string") store.beforeClaim?.(args.where.id);
      let count = 0;
      for (const rank of store.ranks)
        if (rankMatches(rank, args.where) && args.data.lastStopCheckAt !== undefined) {
          rank.lastStopCheckAt = args.data.lastStopCheckAt;
          count++;
          if (claim) store.claims.push(rank.id);
        }
      return { count };
    },
  );
  instanceStep.findMany.mockImplementation(async (args) => {
    if (args.where.phase !== "STATUS") return [];
    const rank = store.ranks.find((row) => row.instanceId === args.where.instanceId);
    return rank ? (store.probes.get(rank.id) ?? []) : [];
  });
  runtimeInstance.findMany.mockImplementation(async (args) => {
    if (args.where.phase !== "STOPPING") return [];
    return store.instances
      .filter((row) => row.phase === "STOPPING")
      .sort(byReconcile)
      .slice(0, args.take);
  });
  runtimeInstance.updateMany.mockImplementation(async (args) => {
    // Only the reconciler's claim compares the stamp it read.
    if (!("lastStopReconcileAt" in args.where) || typeof args.where.id !== "string")
      return { count: 0 };
    store.beforeClaim?.(args.where.id);
    const row = store.instances.find((candidate) => candidate.id === args.where.id);
    const read = args.where.lastStopReconcileAt ?? null;
    if (!row || row.phase !== args.where.phase || time(row.lastStopReconcileAt) !== time(read))
      return { count: 0 };
    row.lastStopReconcileAt = args.data?.lastStopReconcileAt ?? null;
    store.claims.push(row.id);
    return { count: 1 };
  });
});

describe("held-unknown probe pass", () => {
  it("reaches every rank marked stopped across passes when there are more than a pass takes", async () => {
    seedRanks(150);
    const lc = engine();
    const first = await pass(lc, "r");
    const second = await pass(lc, "r");
    const third = await pass(lc, "r");
    expect(first).toHaveLength(PASS);
    expect(second).toHaveLength(PASS);
    expect(third).toHaveLength(150 - 2 * PASS);
    expect(new Set([...first, ...second, ...third]).size).toBe(150);
    // Nothing is due again until its check ages out.
    expect(await pass(lc, "r")).toEqual([]);
    for (const rank of store.ranks) expect(rank.lastStopCheckAt).toEqual(clock);
  });

  it("checks the oldest first: never checked, then least recently checked; recent ones wait", async () => {
    const base = clock.getTime();
    // r0000..r0099 checked long ago (r0099 oldest), r0100..r0119 never, r0120..r0139 just now.
    seedRanks(140, (index) =>
      index < 100
        ? new Date(base - HELD_UNKNOWN_PROBE_MS - (index + 1) * 1_000)
        : index < 120
          ? null
          : new Date(base - 1_000),
    );
    const lc = engine();
    const first = await pass(lc, "r");
    expect(first.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => id("r", 100 + i)));
    expect(first.slice(20)).toEqual(Array.from({ length: 44 }, (_, i) => id("r", 99 - i)));
    expect(await pass(lc, "r")).toEqual(Array.from({ length: 56 }, (_, i) => id("r", 55 - i)));
    expect(await pass(lc, "r")).toEqual([]);
    // Once their checks age out, the ones checked first come first again.
    clock = new Date(base + HELD_UNKNOWN_PROBE_MS);
    const later = await pass(lc, "r");
    expect(later.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => id("r", 120 + i)));
    expect(later).toHaveLength(PASS);
  });

  it("ranks whose check always fails go to the back; the others are still reached", async () => {
    // A whole pass's worth of failing ranks sorts first (lowest ids, never checked).
    seedRanks(PASS + 6);
    for (let index = 0; index < PASS; index++) store.failing.add(id("i", index));
    const lc = engine();
    const first = await pass(lc, "r");
    expect(first).toEqual(Array.from({ length: PASS }, (_, i) => id("r", i)));
    for (const rank of store.ranks.slice(0, PASS)) expect(rank.lastStopCheckAt).toEqual(clock);
    expect(await pass(lc, "r")).toEqual(Array.from({ length: 6 }, (_, i) => id("r", PASS + i)));
    // Five minutes on they are retried, still oldest first.
    clock = new Date(clock.getTime() + HELD_UNKNOWN_PROBE_MS);
    expect((await pass(lc, "r")).slice(0, 3)).toEqual([id("r", 0), id("r", 1), id("r", 2)]);
  });

  it("a rank whose node has no session here after all goes to the back unprobed", async () => {
    seedRanks(1);
    expect(await pass(engine(false), "r")).toEqual(["r0000"]);
    expect(store.ranks[0]?.lastStopCheckAt).toEqual(clock);
    expect(instanceStep.findMany.mock.calls.some(([args]) => args.where.phase === "STATUS")).toBe(
      false,
    );
  });

  it("stamps a rank whose probe finished recently with that probe's time", async () => {
    seedRanks(1);
    const finished = new Date(clock.getTime() - 60_000);
    store.probes.set("r0000", [{ state: "FAILED", updatedAt: finished }]);
    await pass(engine(), "r");
    expect(store.ranks[0]?.lastStopCheckAt).toEqual(finished);
  });

  it("skips a rank another server process claimed after this pass read it", async () => {
    seedRanks(2);
    const other = new Date(clock.getTime() - 1_000);
    store.beforeClaim = (claimed) => {
      const rank = store.ranks.find((row) => row.id === claimed);
      if (claimed === "r0000" && rank) rank.lastStopCheckAt = other;
      store.beforeClaim = null;
    };
    expect(await pass(engine(), "r")).toEqual(["r0001"]);
    expect(store.ranks[0]?.lastStopCheckAt).toEqual(other);
    const probed = instanceStep.findMany.mock.calls
      .map(([args]) => args.where)
      .filter((where) => where.phase === "STATUS")
      .map((where) => where.instanceId);
    expect(probed).toEqual(["i0001"]);
  });
});

describe("stopping reconciler pass", () => {
  it("writes nothing while one pass takes every STOPPING instance", async () => {
    seedStopping(RECONCILE_PASS - 1);
    expect(await pass(engine(), "s")).toEqual([]);
    expect(store.instances.every((row) => row.lastStopReconcileAt === null)).toBe(true);
  });

  it("reaches every STOPPING instance across passes when there are more than a pass takes", async () => {
    seedStopping(RECONCILE_PASS + 44);
    const lc = engine();
    const first = await pass(lc, "s");
    expect(first).toEqual(Array.from({ length: RECONCILE_PASS }, (_, i) => id("s", i)));
    clock = new Date(clock.getTime() + 1_000);
    const second = await pass(lc, "s");
    // Never taken first, then the least recently taken.
    expect(second.slice(0, 44)).toEqual(
      Array.from({ length: 44 }, (_, i) => id("s", RECONCILE_PASS + i)),
    );
    expect(second.slice(44)).toEqual(
      Array.from({ length: RECONCILE_PASS - 44 }, (_, i) => id("s", i)),
    );
    expect(new Set([...first, ...second]).size).toBe(RECONCILE_PASS + 44);
  });

  it("an instance whose settle always fails goes to the back; the others are still reached", async () => {
    seedStopping(RECONCILE_PASS + 10);
    for (let index = 0; index < RECONCILE_PASS; index++) store.failing.add(id("s", index));
    const lc = engine();
    await pass(lc, "s");
    clock = new Date(clock.getTime() + 1_000);
    const second = await pass(lc, "s");
    expect(second.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, i) => id("s", RECONCILE_PASS + i)),
    );
  });

  it("skips an instance another server process took after this pass read it", async () => {
    seedStopping(RECONCILE_PASS + 1);
    store.beforeClaim = (claimed) => {
      const row = store.instances.find((candidate) => candidate.id === claimed);
      if (claimed === "s0000" && row) row.lastStopReconcileAt = new Date(clock.getTime() - 1);
      store.beforeClaim = null;
    };
    const claimed = await pass(engine(), "s");
    expect(claimed).not.toContain("s0000");
    expect(claimed[0]).toBe("s0001");
  });
});
