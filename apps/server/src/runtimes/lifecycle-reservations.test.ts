import type { RuntimeLaunch } from "@ws-model-proxy/api/lib/runtime-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A single-node instance with a reservation (`launch.reservations`) on another node, through
// the production engine (`runOnce`, dispatch, job results) on in-memory tables. Every fenced
// write is a transaction: a write that throws leaves nothing behind, and any engine error
// fails the test (no swallowed errors). Covered: the live watch (offline reservation node →
// UNAVAILABLE → gang stop after unavailableStopMs, recovery, deleted node), a stop that is
// dispatched to the head only and releases the reservation once proven, the automatic
// restart's capacity check (it never retakes room another runtime took), a restart's
// superseded reservations held until the new run's leading stop succeeded, the watch's phase
// recheck under the fence, and queued starts waiting for a blocker's hold on a reservation
// node. Nothing is ever sent to a reserved node.

type Row = Record<string, unknown>;
type Rank = Row & {
  id: string;
  instanceId: string;
  nodeId: string | null;
  rank: number;
  claim: string;
  port: number;
  distPort: number | null;
  resources: Row;
  blockedBy: string[];
};
type Reservation = Row & {
  id: string;
  instanceId: string;
  nodeId: string | null;
  index: number;
  labels: string[];
  resources: Row;
  supersededGeneration: number | null;
};
type Instance = Row & {
  id: string;
  userId: string;
  phase: string;
  desiredState: string | null;
  Ranks: Rank[];
  Reservations: Reservation[];
};
type NodeRow = { id: string; online: boolean; labels: string[]; memoryGb: number };

const store = vi.hoisted(() => ({
  instances: [] as Instance[],
  steps: [] as Row[],
  nodes: [] as NodeRow[],
  /** Runs once, inside the next fenced write before its work (another writer got there first). */
  beforeNextWrite: null as (() => void) | null,
  nextId: 1,
}));

const db = vi.hoisted(() => {
  const instanceOf = (id: unknown) => store.instances.find((item) => item.id === id);
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, filter]) => {
      if (filter === undefined) return true;
      if (key === "NOT") return !matches(row, filter as Row);
      if (key === "AND") return (filter as Row[]).every((part) => matches(row, part));
      if (key === "OR") return (filter as Row[]).some((part) => matches(row, part));
      if (key === "Instance") {
        const parent = instanceOf(row.instanceId);
        return !!parent && matches(parent, filter as Row);
      }
      // Every owner is active and every runtime STARTABLE here.
      if (key === "Runtime") return true;
      if (key === "Ranks" || key === "Reservations") {
        const some = (filter as { some?: Row }).some;
        const rows = ((row[key] as Row[] | undefined) ?? []).map((child) => ({
          ...child,
          instanceId: row.id,
        }));
        return some ? rows.some((child) => matches(child, some)) : true;
      }
      if (key === "intent") {
        const json = filter as { path: string[]; equals: unknown };
        return (
          !!row.intent && Reflect.get(row.intent as object, json.path[0] ?? "") === json.equals
        );
      }
      const actual = row[key];
      if (filter === null) return actual === null || actual === undefined;
      if (typeof filter === "object" && !(filter instanceof Date) && !Array.isArray(filter)) {
        const f = filter as Row;
        if ("in" in f && !(f.in as unknown[]).includes(actual)) return false;
        if ("notIn" in f && (f.notIn as unknown[]).includes(actual)) return false;
        if ("not" in f && (f.not === null ? actual == null : actual === f.not)) return false;
        if ("equals" in f && actual !== f.equals) return false;
        const num = (input: unknown) => (input instanceof Date ? input.getTime() : Number(input));
        if ("lt" in f && (actual == null || num(actual) >= num(f.lt))) return false;
        if ("lte" in f && (actual == null || num(actual) > num(f.lte))) return false;
        if ("gt" in f && (actual == null || num(actual) <= num(f.gt))) return false;
        if ("gte" in f && (actual == null || num(actual) < num(f.gte))) return false;
        return true;
      }
      return actual === filter;
    });
  const patch = (row: Row, data: Row) => {
    for (const [key, next] of Object.entries(data)) {
      if (next && typeof next === "object" && "increment" in next)
        row[key] = Number(row[key] ?? 0) + Number(Reflect.get(next, "increment"));
      else if (next && typeof next === "object" && "decrement" in next)
        row[key] = Number(row[key] ?? 0) - Number(Reflect.get(next, "decrement"));
      else row[key] = next;
    }
  };
  /** An instance as a read returns it: the include/select's relation `where`s applied. */
  const shape = (instance: Instance, relations: Row = {}): Row => {
    const filtered = (key: "Ranks" | "Reservations") => {
      const where = (relations[key] as { where?: Row } | undefined)?.where;
      const rows = instance[key] as Row[];
      return where
        ? rows.filter((child) => matches({ ...child, instanceId: instance.id }, where))
        : rows;
    };
    return { ...instance, Ranks: filtered("Ranks"), Reservations: filtered("Reservations") };
  };
  const relationsOf = (args: Row) => (args.include ?? args.select ?? {}) as Row;
  const nodeRow = (node: NodeRow) => ({
    ...node,
    userId: "u1",
    slug: node.id,
    connection: node.online ? "ONLINE" : "OFFLINE",
    lastDisconnectedAt: node.online ? null : new Date(0),
    lastHeartbeatAt: node.online ? new Date(8e12) : null,
    trust: "FULL",
    trustChangedAt: null,
    trustLowerRequestedAt: null,
    holdAt: null,
    portStart: 30000,
    portEnd: 30009,
    heldDefinitions: [],
    frozenFabrics: null,
    fabricsHash: null,
    heldFabricsHash: null,
    declaredResources: { kind: "unified", memoryGb: node.memoryGb },
    nodeInfo: null,
    nodeMetrics: null,
    nodeMetricsAt: null,
    connectionGeneration: 1,
  });
  const answer = (model: string, method: string, args: Row = {}): unknown => {
    const where = (args.where ?? {}) as Row;
    if (model === "node") {
      const rows = store.nodes
        .map(nodeRow)
        .filter((node) => matches(node, where.id ? { id: where.id } : {}));
      return method === "findMany" ? rows : (rows[0] ?? null);
    }
    if (model === "user") return { banned: false, banExpires: null, deletionRequestedAt: null };
    if (model === "runtimeInstance") {
      const hit = store.instances.filter((item) => matches(item, where));
      if (method === "update" || method === "updateMany") {
        for (const item of hit) patch(item, args.data as Row);
        return method === "update" ? hit[0] : { count: hit.length };
      }
      if (method === "findMany") return hit.map((item) => shape(item, relationsOf(args)));
      if (method === "count") return hit.length;
      if (method === "findUniqueOrThrow" && !hit[0]) throw new Error("not found");
      return hit[0] ? shape(hit[0], relationsOf(args)) : null;
    }
    if (model === "instanceRank") {
      const all = store.instances.flatMap((item) => item.Ranks);
      if (method === "update") {
        const key = where.instanceId_rank as { instanceId: string; rank: number } | undefined;
        const rank = all.find((row) =>
          key ? row.instanceId === key.instanceId && row.rank === key.rank : row.id === where.id,
        );
        if (!rank) throw new Error("rank not found");
        patch(rank, args.data as Row);
        return rank;
      }
      const hit = all.filter((row) => matches(row, where));
      if (method === "updateMany") {
        for (const row of hit) patch(row, args.data as Row);
        return { count: hit.length };
      }
      if (method === "count") return hit.length;
      if (method === "findMany")
        return hit.map((row) => ({ ...row, Instance: instanceOf(row.instanceId) }));
      return hit[0] ?? null;
    }
    if (model === "instanceReservation") {
      const all = store.instances.flatMap((item) => item.Reservations);
      if (method === "createMany") {
        for (const row of args.data as Array<Omit<Reservation, "id" | "supersededGeneration">>)
          instanceOf(row.instanceId)?.Reservations.push({
            ...row,
            id: `res-${store.nextId++}`,
            supersededGeneration: null,
          } as Reservation);
        return { count: (args.data as Row[]).length };
      }
      const hit = all.filter((row) => matches(row, where));
      if (method === "deleteMany") {
        for (const item of store.instances)
          item.Reservations = item.Reservations.filter((row) => !hit.includes(row));
        return { count: hit.length };
      }
      if (method === "updateMany" || method === "update") {
        for (const row of hit) patch(row, args.data as Row);
        return method === "update" ? hit[0] : { count: hit.length };
      }
      if (method === "count") return hit.length;
      return method === "findMany" ? hit : (hit[0] ?? null);
    }
    if (model === "instanceStep") {
      if (method === "create") {
        const created = {
          id: `step-${store.nextId++}`,
          state: "PENDING",
          attempts: 0,
          notBefore: null,
          operatorHold: null,
          operatorTerminalId: null,
          operatorAcceptedAt: null,
          errorCode: null,
          createdAt: new Date(),
          ...(args.data as Row),
        };
        store.steps.push(created);
        return created;
      }
      const hit = store.steps.filter((row) => matches(row, where));
      if (method === "updateMany" || method === "update") {
        for (const row of hit) patch(row, args.data as Row);
        return method === "update" ? hit[0] : { count: hit.length };
      }
      if (method === "count") return hit.length;
      if (method === "aggregate") {
        const generations = hit.map((row) => Number(row.generation ?? 0));
        return {
          _max: {
            generation: generations.length > 0 ? Math.max(...generations) : null,
            sequence: null,
          },
        };
      }
      const withInstance = (row: Row) => {
        const parent = instanceOf(row.instanceId);
        const nested = (relationsOf(args).Instance as { include?: Row } | undefined)?.include;
        return { ...row, Instance: parent ? shape(parent, nested ?? {}) : undefined };
      };
      if (method === "findMany") return hit.map(withInstance);
      if (method === "groupBy") return [];
      return hit[0] ? withInstance(hit[0]) : null;
    }
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    return null;
  };
  const models = new Map<string, object>();
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        if (!models.has(key))
          models.set(
            key,
            new Proxy(
              {},
              {
                get: (_model, method) =>
                  typeof method === "string"
                    ? async (args: Row) => answer(key, method, args)
                    : undefined,
              },
            ),
          );
        return models.get(key);
      },
    },
  );
});

vi.mock("@ws-model-proxy/db", () => ({ default: db, Prisma: { DbNull: "DbNull" } }));
vi.mock("@ws-model-proxy/db/user-deletion-access", () => ({
  userCredentialAccessBlocked: () => false,
}));
// A fenced write is one transaction: what it changed is rolled back when it throws.
vi.mock("@ws-model-proxy/api/lib/graph-write", () => ({
  graphWrite: async (_owners: Iterable<string>, work: (tx: unknown) => Promise<unknown>) => {
    const hook = store.beforeNextWrite;
    store.beforeNextWrite = null;
    hook?.();
    const instances = structuredClone(store.instances);
    const steps = structuredClone(store.steps);
    try {
      return await work(db);
    } catch (error) {
      store.instances = instances;
      store.steps = steps;
      throw error;
    }
  },
  instanceCapacityFences: async () => [],
}));

const { RuntimeLifecycle } = await import("./lifecycle.js");
const { writePlannedStarts } = await import("@ws-model-proxy/api/lib/runtime-store");
const { loadPlacementContext, loadPlacementInstances } = await import(
  "../../../../packages/api/src/lib/placement-load"
);
const { PlacementPlanner } = await import("../../../../packages/api/src/lib/placement");

const STOP_AFTER_MS = 60_000;
const GB100 = { kind: "unified" as const, memoryGb: 100 };
const launch: RuntimeLaunch = {
  management: "service",
  groupSize: 1,
  labels: [],
  resources: [GB100],
  reservations: [{ labels: ["worker"], resources: GB100 }],
  commands: [{ start: "vendor up", stop: "vendor down", status: "vendor status" }],
  health: { intervalMs: 30_000, failureThreshold: 3, successThreshold: 1 },
};

let clock = new Date(Date.now() + 3_600_000);
const sent: Array<{ nodeId: string; frame: Row }> = [];
let errors: unknown[][] = [];

function engine() {
  return new RuntimeLifecycle(
    {
      onlineNodeIds: () => store.nodes.filter((node) => node.online).map((node) => node.id),
      nodeSession: () => ({ userId: "u1", connectionGeneration: 1, trust: "full" }),
      sendToNode: (nodeId: string, frame: unknown) => {
        sent.push({ nodeId, frame: frame as Row });
        return true;
      },
    } as unknown as ConstructorParameters<typeof RuntimeLifecycle>[0],
    { now: () => clock },
  );
}

type Engine = InstanceType<typeof RuntimeLifecycle>;
type JobResult = Parameters<Engine["handleJobResult"]>[1];

const ref = () => ({
  nodeId: "head",
  userId: "u1",
  slug: "head",
  connectionGeneration: 1,
  trust: "full" as const,
});

function instance(id: string, overrides: Partial<Instance> = {}): Instance {
  return {
    id,
    userId: "u1",
    runtimeId: `rt-${id}`,
    handle: `i-${id}`,
    versionId: "v1",
    launchVersionId: "v1",
    operationId: `op-${id}`,
    fabricId: null,
    startedBy: "USER",
    desiredState: "RUNNING",
    phase: "READY",
    phaseReason: null,
    phaseChangedAt: new Date(clock.getTime() - 1_000),
    lastHealthAt: clock,
    unavailableSince: null,
    unhealthySince: null,
    nextRestartAt: null,
    needsOperator: null,
    // A row from before runs existed (the column's default): bootstrapped from its steps.
    runGeneration: 0,
    restartsInWindow: 0,
    restartWindowStartedAt: null,
    healthFailures: 0,
    healthSuccesses: 0,
    Ranks: [
      {
        id: `rank-${id}`,
        instanceId: id,
        nodeId: "head",
        rank: 0,
        claim: "HELD",
        port: 30000,
        distPort: null,
        resources: GB100,
        blockedBy: [],
        lastStopCheckAt: clock,
        stoppedAt: null,
        markedStoppedAt: null,
      },
    ],
    Reservations: [
      {
        id: `res-${id}`,
        instanceId: id,
        nodeId: "w1",
        index: 0,
        labels: ["worker"],
        resources: GB100,
        supersededGeneration: null,
        plannedGeneration: 0,
      },
    ],
    LaunchVersion: {
      spec: { launch },
      launchHash: "a".repeat(64),
      editor: "USER",
      advanced: { unavailableStopMs: STOP_AFTER_MS },
    },
    Runtime: { kind: "STARTABLE", Models: [] },
    ...overrides,
  };
}

/** Generation 1 of `id` ran: its START and READINESS succeeded on the head. */
function ranGeneration1(id: string) {
  for (const [phase, sequence] of [
    ["START", 120],
    ["READINESS", 140],
  ] as const)
    store.steps.push({
      id: `${id}-${phase}`,
      instanceId: id,
      nodeId: "head",
      rank: 0,
      phase,
      generation: 1,
      sequence,
      state: "SUCCEEDED",
      attempts: 1,
      intent: { operationId: `op-${id}`, interactive: false },
    });
}

function main(id = "inst"): Instance {
  const found = store.instances.find((item) => item.id === id);
  if (!found) throw new Error(`no instance ${id}`);
  return found;
}

function setOnline(id: string, online: boolean) {
  const node = store.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`no node ${id}`);
  node.online = online;
}

const holds = (item: Instance) => item.Ranks.some((rank) => rank.claim !== "RELEASED");
const framesTo = (phase: string) => sent.filter((entry) => entry.frame.phase === phase);

function result(frame: Row, outcome: Partial<JobResult>): JobResult {
  return {
    type: "runtime.job.result",
    stepId: String(frame.stepId),
    instanceId: String(frame.instanceId),
    rank: Number(frame.rank ?? 0),
    intentHash: String(frame.intentHash),
    ownerEpoch: String(frame.ownerEpoch),
    ...outcome,
  } as JobResult;
}

beforeEach(() => {
  clock = new Date(Date.now() + 3_600_000);
  store.instances = [];
  store.steps = [];
  store.beforeNextWrite = null;
  store.nextId = 1;
  store.nodes = [
    { id: "head", online: true, labels: [], memoryGb: 128 },
    { id: "w1", online: true, labels: ["worker"], memoryGb: 128 },
  ];
  sent.length = 0;
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // No engine error was swallowed (a failed fenced write logs and retries).
  expect(errors).toEqual([]);
  // Nothing is ever sent to, or stepped on, a node an instance only reserves.
  const reservedOnly = (instanceId: unknown, nodeId: unknown) => {
    const item = store.instances.find((entry) => entry.id === instanceId);
    if (!item) return false;
    const rankNodes = new Set(item.Ranks.map((rank) => rank.nodeId));
    return item.Reservations.some(
      (row) => row.nodeId === nodeId && !rankNodes.has(nodeId as string),
    );
  };
  expect(sent.filter((entry) => reservedOnly(entry.frame.instanceId, entry.nodeId))).toEqual([]);
  expect(store.steps.filter((step) => reservedOnly(step.instanceId, step.nodeId))).toEqual([]);
});

describe("a reservation node in the live watch", () => {
  it("leaves a healthy instance alone while both nodes are online", async () => {
    store.instances = [instance("inst")];
    ranGeneration1("inst");
    await engine().runOnce();
    expect(main().phase).toBe("READY");
    expect(framesTo("stop")).toEqual([]);
  });

  it("goes UNAVAILABLE, stops on the head after unavailableStopMs, and releases the reservation once the stop is proven", async () => {
    store.instances = [instance("inst")];
    ranGeneration1("inst");
    setOnline("w1", false);
    const lc = engine();
    await lc.runOnce();
    expect(main()).toMatchObject({ phase: "UNAVAILABLE", phaseReason: "node_offline" });
    expect(framesTo("stop")).toEqual([]);
    clock = new Date(clock.getTime() + STOP_AFTER_MS + 1_000);
    await lc.runOnce();
    expect(main()).toMatchObject({ phase: "STOPPING", phaseReason: "node_offline" });
    // The stop went out (to the head) and the reservation holds until it is proven.
    const [stop] = framesTo("stop");
    if (!stop) throw new Error("no stop dispatched");
    expect(stop.nodeId).toBe("head");
    expect(holds(main())).toBe(true);
    await lc.handleJobResult(ref(), result(stop.frame, { status: "succeeded", stopped: true }));
    await lc.runOnce();
    await lc.stop();
    expect(main().phase).toBe("STOPPED");
    expect(holds(main())).toBe(false);
  });

  it("recovers when the reservation node is back before the delay", async () => {
    store.instances = [instance("inst")];
    ranGeneration1("inst");
    setOnline("w1", false);
    const lc = engine();
    await lc.runOnce();
    expect(main().phase).toBe("UNAVAILABLE");
    setOnline("w1", true);
    await lc.runOnce();
    expect(main()).toMatchObject({ phase: "READY", phaseReason: null, unavailableSince: null });
    expect(framesTo("stop")).toEqual([]);
    expect(holds(main())).toBe(true);
  });

  it("stops at once (head only) when the reservation node was deleted", async () => {
    const item = instance("inst");
    const [reservation] = item.Reservations;
    if (reservation) reservation.nodeId = null;
    store.instances = [item];
    ranGeneration1("inst");
    const lc = engine();
    await lc.runOnce();
    await lc.runOnce();
    expect(main()).toMatchObject({ phase: "STOPPING", phaseReason: "node_deleted" });
    expect(framesTo("stop").map((entry) => entry.nodeId)).toEqual(["head"]);
  });

  it("keeps today's behaviour without reservations: a lone offline head is not stopped", async () => {
    store.instances = [instance("inst", { Reservations: [] })];
    ranGeneration1("inst");
    setOnline("head", false);
    const lc = engine();
    await lc.runOnce();
    clock = new Date(clock.getTime() + STOP_AFTER_MS + 1_000);
    await lc.runOnce();
    expect(main().phase).toBe("UNAVAILABLE");
  });

  it("does not resurrect a run that failed between the watch's read and its fence", async () => {
    store.instances = [instance("inst")];
    ranGeneration1("inst");
    setOnline("w1", false);
    // Another writer ends the run (restart budget spent) after the watch listed it.
    store.beforeNextWrite = () => {
      const item = main();
      item.phase = "FAILED";
      item.phaseReason = "restart_budget_exhausted";
      for (const rank of item.Ranks) rank.claim = "RELEASED";
    };
    await engine().runOnce();
    expect(main()).toMatchObject({ phase: "FAILED", phaseReason: "restart_budget_exhausted" });
  });
});

describe("the automatic restart checks for room like a start", () => {
  /** `id` crashed and backed off: STOPPED, claims released, its restart due now. */
  function backedOff(id: string, overrides: Partial<Instance> = {}): Instance {
    const item = instance(id, {
      phase: "STOPPED",
      phaseReason: "crashed",
      nextRestartAt: new Date(clock.getTime() - 1_000),
      restartsInWindow: 1,
      restartWindowStartedAt: new Date(clock.getTime() - 10_000),
      ...overrides,
    });
    for (const rank of item.Ranks) {
      rank.claim = "RELEASED";
      rank.stoppedAt = clock;
    }
    return item;
  }

  /** Another runtime's running 100 GiB rank on `nodeId`. */
  function occupant(nodeId: string): Instance {
    const item = instance(`other-${nodeId}`, { Reservations: [] });
    const [rank] = item.Ranks;
    if (rank) rank.nodeId = nodeId;
    return item;
  }

  it("waits (STOPPED, waiting_not_enough_memory, budget kept) while another runtime holds the reservation's room", async () => {
    store.instances = [backedOff("inst"), occupant("w1")];
    ranGeneration1("inst");
    await engine().runOnce();
    expect(main()).toMatchObject({
      phase: "STOPPED",
      phaseReason: "waiting_not_enough_memory",
      restartsInWindow: 1,
    });
    expect((main().nextRestartAt as Date).getTime()).toBeGreaterThan(clock.getTime());
    // Nothing retaken, nothing generated, nothing sent.
    expect(holds(main())).toBe(false);
    expect(store.steps.filter((step) => step.generation === 2)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("moves the reservation to another labelled node with room, and restarts", async () => {
    store.nodes.push({ id: "w2", online: true, labels: ["worker"], memoryGb: 128 });
    store.instances = [backedOff("inst"), occupant("w1")];
    ranGeneration1("inst");
    await engine().runOnce();
    expect(main()).toMatchObject({ phase: "STARTING", phaseReason: "restarting" });
    expect(main().restartsInWindow).toBe(2);
    expect(holds(main())).toBe(true);
    expect(main().Reservations.map((row) => [row.nodeId, row.supersededGeneration])).toEqual([
      ["w2", null],
    ]);
    // The new run's leading stop goes to the head only.
    expect(framesTo("stop").map((entry) => entry.nodeId)).toEqual(["head"]);
  });

  it("keeps its previous reservation node when it still has room", async () => {
    store.nodes.push({ id: "w2", online: true, labels: ["worker"], memoryGb: 128 });
    store.instances = [backedOff("inst")];
    ranGeneration1("inst");
    await engine().runOnce();
    expect(main().phase).toBe("STARTING");
    expect(main().Reservations.map((row) => row.nodeId)).toEqual(["w1"]);
  });

  it("waits while another runtime holds its own (rank) node, with or without reservations", async () => {
    store.instances = [backedOff("inst", { Reservations: [] }), occupant("head")];
    ranGeneration1("inst");
    await engine().runOnce();
    expect(main()).toMatchObject({ phase: "STOPPED", phaseReason: "waiting_not_enough_memory" });
    expect(holds(main())).toBe(false);
  });

  it("restarts a runtime without reservations whose node is free (unchanged)", async () => {
    store.instances = [backedOff("inst", { Reservations: [] })];
    ranGeneration1("inst");
    await engine().runOnce();
    expect(main()).toMatchObject({ phase: "STARTING", phaseReason: "restarting" });
    expect(holds(main())).toBe(true);
  });

  it("fails at once when a reservation's node was deleted", async () => {
    const item = backedOff("inst");
    const [reservation] = item.Reservations;
    if (reservation) reservation.nodeId = null;
    store.instances = [item];
    await engine().runOnce();
    expect(main()).toMatchObject({ phase: "FAILED", phaseReason: "node_deleted" });
    expect(main().nextRestartAt).toBeNull();
    expect(holds(main())).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("a restart's superseded reservation holds until the new run's leading stop", () => {
  /** A restart was written: generation 1 runs; w1 is superseded, w2 is the new plan's. */
  function restarted(): Instance {
    store.nodes.push({ id: "w2", online: true, labels: ["worker"], memoryGb: 128 });
    const item = instance("inst", {
      phase: "STARTING",
      phaseReason: "restart_requested",
      operationId: "op-restart",
    });
    const [old] = item.Reservations;
    if (!old) throw new Error("no reservation");
    item.Reservations = [
      { ...old, supersededGeneration: 1 },
      {
        id: "res-new",
        instanceId: "inst",
        nodeId: "w2",
        index: 0,
        labels: ["worker"],
        resources: GB100,
        supersededGeneration: null,
      },
    ];
    return item;
  }

  it("keeps it while the leading stop runs, drops it when generation 2's START is claimed", async () => {
    store.instances = [restarted()];
    ranGeneration1("inst");
    const lc = engine();
    await lc.runOnce();
    const [stop] = framesTo("stop");
    if (!stop) throw new Error("no leading stop");
    expect(framesTo("start")).toEqual([]);
    expect(main().Reservations.map((row) => row.nodeId)).toEqual(["w1", "w2"]);
    await lc.handleJobResult(ref(), result(stop.frame, { status: "succeeded", stopped: true }));
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("start")).toHaveLength(1);
    expect(main().Reservations.map((row) => [row.nodeId, row.supersededGeneration])).toEqual([
      ["w2", null],
    ]);
  });

  it("keeps it when the leading stop fails (the old run may still run)", async () => {
    store.instances = [restarted()];
    ranGeneration1("inst");
    const lc = engine();
    await lc.runOnce();
    const [stop] = framesTo("stop");
    if (!stop) throw new Error("no leading stop");
    await lc.handleJobResult(
      ref(),
      result(stop.frame, { status: "failed", stopped: false, error: "command_failed" }),
    );
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("start")).toEqual([]);
    expect(main().Reservations.map((row) => row.nodeId)).toContain("w1");
  });
});

describe("a queued start waits for what a blocker holds on its reservation node", () => {
  for (const claim of ["HELD", "RELEASED"] as const)
    it(`blocker claim ${claim}: ${claim === "HELD" ? "waits" : "starts"}`, async () => {
      const blocker = instance("blocker", {
        desiredState: "STOPPED",
        phase: claim === "HELD" ? "STOPPING" : "STOPPED",
        Reservations: [],
      });
      const [blockerRank] = blocker.Ranks;
      if (!blockerRank) throw new Error("no rank");
      blockerRank.nodeId = "w1";
      blockerRank.claim = claim;
      // The blocker ran on w1 and its stop is out (not proven yet when HELD).
      store.steps.push(
        {
          id: "blocker-start",
          instanceId: "blocker",
          nodeId: "w1",
          rank: 0,
          phase: "START",
          generation: 1,
          sequence: 120,
          state: "SUCCEEDED",
          attempts: 1,
          intent: { operationId: "op-blocker", interactive: false },
        },
        {
          id: "blocker-stop",
          instanceId: "blocker",
          nodeId: "w1",
          rank: 0,
          phase: "STOP",
          generation: 1,
          sequence: 150,
          state: claim === "HELD" ? "RUNNING" : "SUCCEEDED",
          attempts: 1,
          deadline: new Date(clock.getTime() + 60_000),
          leaseExpiresAt: new Date(clock.getTime() + 60_000),
          intent: { operationId: "op-blocker", interactive: false },
        },
      );
      const queued = instance("queued", { phase: "STARTING" });
      const [queuedRank] = queued.Ranks;
      if (queuedRank) queuedRank.blockedBy = ["blocker"];
      store.instances = [blocker, queued];
      // The queued rank runs on the head; only its reservation (w1) shares a node with the
      // blocker, so only the reservation can make it wait.
      await engine().runOnce();
      const started = framesTo("start").some((entry) => entry.frame.instanceId === "queued");
      expect(started).toBe(claim !== "HELD");
    });
});

// Superseded rows exist only to protect memory a run that may still be running uses
// (reviewer C's R2 probes P3, P5, P6, P7, kept as regressions).
describe("superseded reservations never outlive the run they protect", () => {
  /** STOPPED after a crash, claims released, due to restart now, its spec without reservations. */
  function stoppedWithoutReservations() {
    const item = instance("inst", {
      phase: "STOPPED",
      phaseReason: "crashed",
      nextRestartAt: new Date(clock.getTime() - 1_000),
      restartsInWindow: 1,
      restartWindowStartedAt: new Date(clock.getTime() - 10_000),
      LaunchVersion: {
        spec: { launch: { ...launch, reservations: [] } },
        launchHash: "a".repeat(64),
        editor: "USER",
        advanced: {},
      },
    });
    for (const rank of item.Ranks) {
      rank.claim = "RELEASED";
      rank.stoppedAt = clock;
    }
    // Only a row an earlier restart superseded (the old run's reservation on w1).
    item.Reservations = [
      {
        id: "old-row",
        instanceId: "inst",
        nodeId: "w1",
        index: 0,
        labels: ["worker"],
        resources: GB100,
        supersededGeneration: 1,
        plannedGeneration: 0,
      },
    ];
    return item;
  }
  function occupying(nodeId: string) {
    const item = instance("occupant", { Reservations: [] });
    for (const rank of item.Ranks) {
      rank.nodeId = nodeId;
      rank.port = 30001;
    }
    return item;
  }
  async function reservedOn(nodeId: string, instanceId: string) {
    const loaded = await loadPlacementInstances(db as never, [nodeId]);
    return (loaded.find((row) => row.id === instanceId)?.ranks ?? []).filter(
      (rank) => rank.nodeId === nodeId && "reservation" in rank,
    );
  }

  it("a retake after a proven stop deletes superseded-only rows instead of holding them again", async () => {
    store.instances = [stoppedWithoutReservations(), occupying("w1")];
    ranGeneration1("inst");
    await engine().runOnce();
    expect(main().phase).toBe("STARTING");
    expect(holds(main())).toBe(true);
    expect(main().Reservations).toEqual([]);
    expect(await reservedOn("w1", "inst")).toEqual([]);
  });

  it("an offline head after that retake strands nothing on the removed reservation's node", async () => {
    store.instances = [stoppedWithoutReservations(), occupying("w1")];
    ranGeneration1("inst");
    setOnline("head", false);
    const lc = engine();
    await lc.runOnce();
    clock = new Date(clock.getTime() + 48 * 3_600_000);
    main("occupant").lastHealthAt = clock;
    await lc.runOnce();
    await lc.stop();
    // Only the occupant's 100 GiB is counted on w1.
    const loaded = await loadPlacementInstances(db as never, ["w1"]);
    const onW1 = loaded
      .flatMap((row) => row.ranks)
      .filter((rank) => rank.nodeId === "w1")
      .reduce((total, rank) => total + Number((rank.resources as Row).memoryGb ?? 0), 0);
    expect(onW1).toBe(100);
  });

  it("removal, a failed leading stop, a proven gang stop, then a retake: no obsolete charge", async () => {
    store.instances = [instance("inst")];
    ranGeneration1("inst");
    await writePlannedStarts(db as never, {
      userId: "u1",
      operationId: "op-remove",
      startedBy: "USER",
      blockedBy: [[]],
      starts: [
        {
          runtimeId: "rt-inst",
          versionId: "v2",
          instanceId: "inst",
          placements: [{ nodeId: "head", nodeNumber: 1, port: 30000, resources: GB100 }],
          reservations: [],
          fabric: null,
          distPort: null,
        },
      ],
    });
    main().LaunchVersion = {
      spec: { launch: { ...launch, reservations: [] } },
      launchHash: "a".repeat(64),
      editor: "USER",
      advanced: {},
    };
    // The old run (generation 1) ran: its w1 row stays held, superseded.
    expect(main().Reservations.map((row) => row.supersededGeneration)).toEqual([1]);
    const lc = engine();
    await lc.runOnce();
    const leading = framesTo("stop").at(-1);
    if (!leading) throw new Error("no leading stop");
    await lc.handleJobResult(
      ref(),
      result(leading.frame, { status: "failed", stopped: false, error: "command_failed" }),
    );
    // The leading stop failed: the old run may still run, its row still holds.
    expect(main().Reservations).toHaveLength(1);
    await lc.runOnce();
    const gang = framesTo("stop").at(-1);
    if (!gang || gang.frame.stepId === leading.frame.stepId) throw new Error("no gang stop");
    await lc.handleJobResult(ref(), result(gang.frame, { status: "succeeded", stopped: true }));
    await lc.runOnce();
    await lc.stop();
    expect(main().phase).toBe("STOPPED");
    expect(holds(main())).toBe(false);
    store.instances.push(occupying("w1"));
    clock = new Date((main().nextRestartAt as Date).getTime() + 1);
    setOnline("head", false);
    const successor = engine();
    await successor.runOnce();
    await successor.stop();
    expect(main().Reservations).toEqual([]);
    expect(await reservedOn("w1", "inst")).toEqual([]);
  });

  it("twenty restarts alternating two reservation nodes before any stop keep at most two rows", async () => {
    store.nodes.push({ id: "w2", online: true, labels: ["worker", "only-w2"], memoryGb: 128 });
    store.nodes.find((node) => node.id === "w1")?.labels.push("only-w1");
    store.instances = [instance("inst")];
    ranGeneration1("inst");
    for (let attempt = 0; attempt < 20; attempt++) {
      const nodeId = attempt % 2 === 0 ? "w2" : "w1";
      const context = await loadPlacementContext(db as never, {
        userId: "u1",
        agent: false,
        now: clock,
      });
      const planned = new PlacementPlanner(context).place({
        runtimeId: "rt-inst",
        versionId: `v-${nodeId}`,
        nodeIds: ["head"],
        restart: {
          instanceId: "inst",
          ports: [30000],
          distPort: null,
          reservationNodeIds: main()
            .Reservations.filter((row) => row.supersededGeneration === null)
            .map((row) => row.nodeId),
        },
        launch: { ...launch, reservations: [{ labels: [`only-${nodeId}`], resources: GB100 }] },
        checkFrozen: false,
        preempt: false,
      });
      if (!planned.ok) throw new Error(planned.refusal.message);
      await writePlannedStarts(db as never, {
        userId: "u1",
        operationId: `op-restart-${attempt}`,
        startedBy: "USER",
        blockedBy: [planned.start.blockedBy],
        starts: [
          { ...planned.start, runtimeId: "rt-inst", versionId: `v-${nodeId}`, instanceId: "inst" },
        ],
      });
      expect(main().Reservations.length).toBeLessThanOrEqual(2);
    }
    expect(sent).toEqual([]);
    // The old run's w1 (generation 1 ran there) and the newest plan's node are held, once each.
    const w1 = await reservedOn("w1", "inst");
    const w2 = await reservedOn("w2", "inst");
    expect(w1.length).toBe(1);
    expect(w2.length).toBeLessThanOrEqual(1);
  });
});
