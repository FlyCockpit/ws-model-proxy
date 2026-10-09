import type { Prisma } from "@ws-model-proxy/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The held-unknown probe pass on a mocked Prisma: an in-memory table of ranks marked stopped
// that answers the pass's where/orderBy/take, and default empty answers for the rest of a tick.

type Rank = {
  id: string;
  nodeId: string | null;
  rank: number;
  instanceId: string;
  claim: "HELD" | "HELD_UNKNOWN" | "RELEASED";
  lastStopCheckAt: Date | null;
  Instance: { userId: string };
};

type DateFilter = { lte?: Date } | null | undefined;

const store = vi.hoisted(() => ({
  ranks: [] as Rank[],
  /** Rank ids in the order the pass re-read them under the owner's fence. */
  visits: [] as string[],
  /** STATUS steps the probe sees for a rank id (finished or live). */
  probes: new Map<string, { state: string; updatedAt: Date }[]>(),
  /** Runs inside the fence before the pass's work (another server process racing it). */
  beforeWork: null as (() => void) | null,
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

const byCheck = (a: Rank, b: Rank) => {
  const at = a.lastStopCheckAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bt = b.lastStopCheckAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return at - bt || a.id.localeCompare(b.id);
};

const instanceRank = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
}));
type StepArgs = { where: { instanceId?: string; phase?: string } };
const instanceStep = vi.hoisted(() => ({
  findMany: vi.fn<(args: StepArgs) => Promise<{ state: string; updatedAt: Date }[]>>(),
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
  graphWrite: vi.fn(async (_owners: Iterable<string>, work: (tx: unknown) => Promise<unknown>) => {
    store.beforeWork?.();
    return work(db);
  }),
  instanceCapacityFences: vi.fn(async () => []),
}));

const { RuntimeLifecycle, HELD_UNKNOWN_PROBE_MS } = await import("./lifecycle.js");

const NODE = "node-1";
let clock = new Date("2026-10-01T00:00:00Z");

function engine() {
  return new RuntimeLifecycle(
    {
      sendToNode: () => true,
      nodeSession: () => ({ userId: "u1", connectionGeneration: 1, trust: "full" }),
      onlineNodeIds: () => [NODE],
    },
    { now: () => clock },
  );
}

function seed(count: number, at: (index: number) => Date | null = () => null) {
  store.ranks = Array.from({ length: count }, (_, index) => ({
    id: `r${String(index).padStart(4, "0")}`,
    nodeId: NODE,
    rank: 0,
    instanceId: `i${index}`,
    claim: "HELD_UNKNOWN",
    lastStopCheckAt: at(index),
    Instance: { userId: "u1" },
  }));
}

/** One tick; returns the ranks the probe pass checked, in order. */
async function pass(lc: InstanceType<typeof RuntimeLifecycle>) {
  store.visits = [];
  await lc.runOnce();
  return [...store.visits];
}

beforeEach(() => {
  clock = new Date("2026-10-01T00:00:00Z");
  store.ranks = [];
  store.visits = [];
  store.probes.clear();
  store.beforeWork = null;
  instanceRank.findMany.mockImplementation(
    async (args: { where: Prisma.InstanceRankWhereInput; take: number }) =>
      store.ranks
        .filter((rank) => rankMatches(rank, args.where))
        .sort(byCheck)
        .slice(0, args.take),
  );
  instanceRank.findFirst.mockImplementation(
    async (args: { where: Prisma.InstanceRankWhereInput }) => {
      const rank = store.ranks.find((row) => rankMatches(row, args.where));
      if (typeof args.where.id === "string") store.visits.push(args.where.id);
      return rank ? { id: rank.id } : null;
    },
  );
  instanceRank.updateMany.mockImplementation(
    async (args: {
      where: Prisma.InstanceRankWhereInput;
      data: { lastStopCheckAt?: Date | null };
    }) => {
      let count = 0;
      for (const rank of store.ranks)
        if (rankMatches(rank, args.where) && args.data.lastStopCheckAt !== undefined) {
          rank.lastStopCheckAt = args.data.lastStopCheckAt;
          count++;
        }
      return { count };
    },
  );
  instanceStep.findMany.mockImplementation(async (args) => {
    if (args.where.phase !== "STATUS") return [];
    const rank = store.ranks.find((row) => row.instanceId === args.where.instanceId);
    return rank ? (store.probes.get(rank.id) ?? []) : [];
  });
});

describe("held-unknown probe pass", () => {
  it("reaches every rank marked stopped across passes when there are more than a pass takes", async () => {
    seed(150);
    const lc = engine();
    const first = await pass(lc);
    const second = await pass(lc);
    const third = await pass(lc);
    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(third).toHaveLength(22);
    const all = new Set([...first, ...second, ...third]);
    expect(all.size).toBe(150);
    // Nothing is due again until its check ages out.
    expect(await pass(lc)).toEqual([]);
    for (const rank of store.ranks) expect(rank.lastStopCheckAt).toEqual(clock);
  });

  it("checks the oldest first: never checked, then least recently checked; recent ones wait", async () => {
    const base = clock.getTime();
    // r0000..r0099 checked long ago (r0099 oldest), r0100..r0119 never, r0120..r0139 just now.
    seed(140, (index) =>
      index < 100
        ? new Date(base - HELD_UNKNOWN_PROBE_MS - (index + 1) * 1_000)
        : index < 120
          ? null
          : new Date(base - 1_000),
    );
    const lc = engine();
    const first = await pass(lc);
    expect(first.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, i) => `r${String(100 + i).padStart(4, "0")}`),
    );
    expect(first.slice(20)).toEqual(
      Array.from({ length: 44 }, (_, i) => `r${String(99 - i).padStart(4, "0")}`),
    );
    const second = await pass(lc);
    expect(second).toEqual(
      Array.from({ length: 56 }, (_, i) => `r${String(55 - i).padStart(4, "0")}`),
    );
    expect(await pass(lc)).toEqual([]);
    // Once their checks age out, the ones checked first come first again.
    clock = new Date(base + HELD_UNKNOWN_PROBE_MS);
    const later = await pass(lc);
    expect(later.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, i) => `r${String(120 + i).padStart(4, "0")}`),
    );
    expect(later).toHaveLength(64);
  });

  it("stamps a rank whose probe finished recently with that probe's time", async () => {
    seed(1);
    const finished = new Date(clock.getTime() - 60_000);
    store.probes.set("r0000", [{ state: "FAILED", updatedAt: finished }]);
    await pass(engine());
    expect(store.ranks[0]?.lastStopCheckAt).toEqual(finished);
  });

  it("skips a rank another server process checked after this pass read it", async () => {
    seed(2);
    store.beforeWork = () => {
      const other = store.ranks.find((rank) => rank.id === "r0000");
      if (other) other.lastStopCheckAt = new Date(clock.getTime() - 1_000);
      store.beforeWork = null;
    };
    await pass(engine());
    expect(store.visits).toEqual(["r0000", "r0001"]);
    expect(store.ranks[0]?.lastStopCheckAt).toEqual(new Date(clock.getTime() - 1_000));
    expect(store.ranks[1]?.lastStopCheckAt).toEqual(clock);
    const probed = instanceStep.findMany.mock.calls
      .map(([args]) => args.where)
      .filter((where) => where.phase === "STATUS")
      .map((where) => where.instanceId);
    expect(probed).toEqual(["i1"]);
  });
});
