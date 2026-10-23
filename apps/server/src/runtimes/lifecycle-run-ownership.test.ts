import type { RuntimeLaunch } from "@ws-model-proxy/api/lib/runtime-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Run ownership (design v2, packages/api/src/lib/instance-run.ts): every restart begins a new run
// in the transaction that commits it; a step of an earlier run is never dispatched and its
// answers change nothing about the successor; inside a run, an observation proves a stop only
// when nothing of the run was launched after it. Production engine (`runOnce`, dispatch, job
// results, inventory), the production restart write (`writePlannedStarts`) and `releaseClaim`,
// over in-memory tables. Every fenced write is a transaction (a write that throws leaves
// nothing behind) and no engine error may be swallowed. Test IDs follow the design's §11.

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
  plannedGeneration: number;
};
type Instance = Row & {
  id: string;
  userId: string;
  phase: string;
  desiredState: string | null;
  runGeneration: number;
  Ranks: Rank[];
  Reservations: Reservation[];
};
type NodeRow = { id: string; online: boolean; labels: string[]; memoryGb: number };

const store = vi.hoisted(() => ({
  instances: [] as Instance[],
  steps: [] as Row[],
  nodes: [] as NodeRow[],
  versions: [] as Row[],
  /** prepareStarts' candidate scan finds nothing (its bounded batch skipped the row). */
  skipPrepare: false,
  /** Fenced writes of these owners fail (a transient database error, C4C / sweep tests). */
  failOwners: new Set<string>(),
  /** Fabric member addresses by node id (`fabricMember.findFirst`). */
  fabricIps: new Map<string, string>(),
  /** Runs after a fenced write that claimed a job, before its frame is sent (dispatch race). */
  afterClaim: null as null | (() => Promise<void>),
  nextId: 1,
}));

const db = vi.hoisted(() => {
  const instanceOf = (id: unknown) => store.instances.find((item) => item.id === id);
  const num = (input: unknown) => (input instanceof Date ? input.getTime() : Number(input));
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
      if (key === "Runtime" || key === "Rank") return true;
      if (key === "Ranks" || key === "Reservations") {
        const some = (filter as { some?: Row }).some;
        const rows = ((row[key] as Row[] | undefined) ?? []).map((child) => ({
          ...child,
          instanceId: row.id,
        }));
        return some ? rows.some((child) => matches(child, some)) : true;
      }
      if (key === "intent" && filter && typeof filter === "object" && "path" in filter) {
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
        if ("lt" in f && (actual == null || num(actual) >= num(f.lt))) return false;
        if ("lte" in f && (actual == null || num(actual) > num(f.lte))) return false;
        if (
          "gt" in f &&
          (actual == null ||
            (typeof f.gt === "string" ? String(actual) <= f.gt : num(actual) <= num(f.gt)))
        )
          return false;
        if ("gte" in f && (actual == null || num(actual) < num(f.gte))) return false;
        return true;
      }
      return actual === filter;
    });
  /** A findMany's `orderBy` and `take`, as the database applies them (sweeps page by them). */
  const page = <T extends Row>(rows: T[], args: Row): T[] => {
    const order = ((Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy ?? {}]) as Row[])
      .flatMap((entry) => Object.entries(entry))
      .map(([key, way]) => [
        key,
        typeof way === "object" ? Reflect.get(way as object, "sort") : way,
      ]);
    const value = (row: Row, key: string) => {
      const field = row[key];
      return field instanceof Date ? field.getTime() : field;
    };
    const sorted = [...rows].sort((a, b) => {
      for (const [key, way] of order) {
        const x = value(a, String(key));
        const y = value(b, String(key));
        if (x === y) continue;
        if (x == null) return -1;
        if (y == null) return 1;
        const less = typeof x === "string" ? x < String(y) : Number(x) < Number(y);
        return (less ? -1 : 1) * (way === "desc" ? -1 : 1);
      }
      return 0;
    });
    return typeof args.take === "number" ? sorted.slice(0, args.take) : sorted;
  };
  const patch = (row: Row, data: Row) => {
    for (const [key, next] of Object.entries(data)) {
      if (next && typeof next === "object" && "increment" in next)
        row[key] = Number(row[key] ?? 0) + Number(Reflect.get(next, "increment"));
      else if (next && typeof next === "object" && "decrement" in next)
        row[key] = Number(row[key] ?? 0) - Number(Reflect.get(next, "decrement"));
      else row[key] = next;
    }
    row.updatedAt = new Date(clock.now);
  };
  const clock = { now: 0 };
  /** An instance as a read returns it: the include/select's relation `where`s applied. */
  const shape = (instance: Instance, relations: Row = {}): Row => {
    const filtered = (key: "Ranks" | "Reservations") => {
      const where = (relations[key] as { where?: Row } | undefined)?.where;
      const rows = instance[key] as Row[];
      return where
        ? rows.filter((child) => matches({ ...child, instanceId: instance.id }, where))
        : rows;
    };
    const version = store.versions.find((entry) => entry.id === instance.launchVersionId);
    return {
      ...instance,
      Ranks: filtered("Ranks"),
      Reservations: filtered("Reservations"),
      LaunchVersion: version ?? instance.LaunchVersion,
      // The activity router's needs-you read (R5-B-1): this instance's steps, filtered.
      Steps: store.steps.filter(
        (step) =>
          step.instanceId === instance.id &&
          matches(step, ((relations.Steps as Row | undefined)?.where ?? {}) as Row),
      ),
    };
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
    trustLowerRequestedAt: null,
    connectionGeneration: 1,
  });
  const answer = (model: string, method: string, args: Row = {}): unknown => {
    const where = (args.where ?? {}) as Row;
    if (model === "node") {
      const rows = store.nodes
        .map(nodeRow)
        .filter((node) => matches(node, where.id ? { id: where.id } : {}));
      return method === "count" ? rows.length : method === "findMany" ? rows : (rows[0] ?? null);
    }
    if (model === "user") return { banned: false, banExpires: null, deletionRequestedAt: null };
    if (model === "fabricMember") {
      const ip = store.fabricIps.get(String(where.nodeId));
      return ip ? { ip } : null;
    }
    if (model === "runtimeVersion") {
      // An owner-scoped read (`Runtime: { userId }`) never sees another owner's version.
      const owner = (where.Runtime as { userId?: string } | undefined)?.userId;
      const hit = store.versions.filter(
        (row) =>
          matches(row, where) &&
          (owner === undefined || row.ownerId === undefined || row.ownerId === owner),
      );
      return method === "findMany" ? hit : (hit[0] ?? null);
    }
    if (model === "runtimeInstance") {
      if (method === "findMany" && store.skipPrepare && where.phase === "STARTING") return [];
      const hit = store.instances.filter((item) => matches(item, where));
      if (method === "update" || method === "updateMany") {
        for (const item of hit) patch(item, args.data as Row);
        return method === "update" ? hit[0] : { count: hit.length };
      }
      if (method === "findMany")
        return page(hit, args).map((item) => shape(item, relationsOf(args)));
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
      if (method === "findUniqueOrThrow" && !hit[0]) throw new Error("not found");
      return hit[0] ?? null;
    }
    if (model === "instanceReservation") {
      const all = store.instances.flatMap((item) => item.Reservations);
      if (method === "createMany") {
        for (const row of args.data as Array<Omit<Reservation, "id" | "supersededGeneration">>)
          instanceOf(row.instanceId)?.Reservations.push({
            plannedGeneration: 0,
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
        const data = args.data as Row;
        // The SQL trigger instance_step_run_order: a new step belongs to the current run.
        const owner = instanceOf(data.instanceId);
        if (!owner || owner.runGeneration < 1 || data.generation !== owner.runGeneration)
          throw new Error("a new step belongs to its instance's current run");
        const created = {
          id: `step-${store.nextId++}`,
          state: "PENDING",
          attempts: 0,
          notBefore: null,
          operatorHold: null,
          operatorTerminalId: null,
          operatorSince: null,
          operatorAcceptedAt: null,
          ownerEpoch: null,
          deadline: null,
          errorCode: null,
          createdAt: new Date(clock.now),
          updatedAt: new Date(clock.now),
          ...data,
        };
        store.steps.push(created);
        return created;
      }
      const hit = store.steps.filter((row) => matches(row, where));
      if (method === "updateMany" || method === "update") {
        for (const row of hit) {
          if ("generation" in (args.data as Row)) throw new Error("a step keeps its generation");
          // The CHECK `instance_step_operator_shape`: an acceptance needs its screen's time.
          const next = { ...row, ...(args.data as Row) };
          if (next.operatorAcceptedAt != null && next.operatorSince == null)
            throw new Error("instance_step_operator_shape: an acceptance needs operatorSince");
          patch(row, args.data as Row);
        }
        return method === "update" ? hit[0] : { count: hit.length };
      }
      if (method === "deleteMany") {
        store.steps = store.steps.filter((row) => !hit.includes(row));
        return { count: hit.length };
      }
      if (method === "count") return hit.length;
      if (method === "aggregate") {
        const max = (key: string) => {
          const values = hit.map((row) => Number(row[key] ?? 0));
          return values.length > 0 ? Math.max(...values) : null;
        };
        return { _max: { generation: max("generation"), sequence: max("sequence") } };
      }
      const withInstance = (row: Row) => {
        const parent = instanceOf(row.instanceId);
        const nested = (relationsOf(args).Instance as { include?: Row } | undefined)?.include;
        return { ...row, Instance: parent ? shape(parent, nested ?? {}) : undefined };
      };
      if (method === "findMany") return page(hit, args).map(withInstance);
      if (method === "groupBy") return [];
      if (method === "findFirst" && args.orderBy) {
        const sorted = [...hit].sort((a, b) => Number(b.sequence) - Number(a.sequence));
        return sorted[0] ? withInstance(sorted[0]) : null;
      }
      if (method === "findUniqueOrThrow" && !hit[0]) throw new Error("not found");
      return hit[0] ? withInstance(hit[0]) : null;
    }
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    return null;
  };
  const models = new Map<string, object>();
  const client = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "__clock") return clock;
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
  return client as Record<string, Record<string, (args?: Row) => Promise<unknown>>> & {
    __clock: { now: number };
  };
});

vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
vi.mock("@ws-model-proxy/env/shared", () => ({ env: {} }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: async () => false,
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db, Prisma: { DbNull: "DbNull" } }));
vi.mock("@ws-model-proxy/db/user-deletion-access", () => ({
  userCredentialAccessBlocked: () => false,
}));
// A fenced write is one transaction: what it changed is rolled back when it throws.
vi.mock("@ws-model-proxy/api/lib/graph-write", () => ({
  graphWrite: async (owners: Iterable<string>, work: (tx: unknown) => Promise<unknown>) => {
    if ([...owners].some((owner) => store.failOwners.has(owner)))
      throw new Error("injected transient database failure");
    const instances = structuredClone(store.instances);
    const steps = structuredClone(store.steps);
    try {
      const value = await work(db);
      const hook = store.afterClaim;
      if (
        hook &&
        value &&
        typeof value === "object" &&
        Reflect.get(value, "type") === "runtime.job"
      ) {
        store.afterClaim = null;
        await hook();
      }
      return value;
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
const { DbNull } = await import("@ws-model-proxy/db/json-null");
const { releaseClaim } = await import("@ws-model-proxy/api/lib/claim-release");
const { beginRun, resolveRun, slotOf, owned } = await import(
  "@ws-model-proxy/api/lib/instance-run"
);
const { reservationClaim } = await import("@ws-model-proxy/api/lib/reservations");
const { generationSteps, stopStep, healthStep, intentHash } = await import("./steps.js");

const GB100 = { kind: "unified" as const, memoryGb: 100 };
const launchOf = (overrides: Partial<RuntimeLaunch> = {}): RuntimeLaunch => ({
  management: "service",
  groupSize: 1,
  labels: [],
  resources: [GB100],
  reservations: [{ labels: ["worker"], resources: GB100 }],
  commands: [{ start: "vendor up", stop: "vendor down", status: "vendor status" }],
  health: { intervalMs: 30_000, failureThreshold: 2, successThreshold: 1 },
  ...overrides,
});
const launch = launchOf();
const interactiveLaunch = launchOf({
  commands: [
    {
      start: "vendor up",
      stop: "vendor down",
      status: "vendor status",
      interactive: { start: true },
    },
  ],
});
const HASH = { v1: "a".repeat(64), v2: "b".repeat(64) };

let now = new Date(Date.now() + 3_600_000);
const sent: Array<{ nodeId: string; frame: Row }> = [];
const closed: string[] = [];
let closeAnswer: "closed" | "running" | "absent" = "closed";
/** Per node, instance and rank: the highest run whose start-phase job was sent (the relay's). */
const startedRuns = new Map<string, number>();
let errors: unknown[][] = [];

function setNow(date: Date) {
  now = date;
  db.__clock.now = date.getTime();
}

function engine() {
  return new RuntimeLifecycle(
    {
      onlineNodeIds: () => store.nodes.filter((node) => node.online).map((node) => node.id),
      nodeSession: (nodeId: string) =>
        store.nodes.find((node) => node.id === nodeId)?.online
          ? { userId: "u1", connectionGeneration: 1, trust: "full", operatorTerminals: true }
          : null,
      sendToNode: (nodeId: string, frame: unknown) => {
        const job = frame as Row;
        // The session's last check (`staleRunJob`): no stop, status or health job of a run
        // older than a start already sent for the rank.
        const key = `${nodeId}:${job.instanceId}:${job.rank}`;
        const generation = Number(job.generation);
        const startPhase = ["prepare", "start", "after_join", "readiness"].includes(
          String(job.phase),
        );
        if (!startPhase && generation < (startedRuns.get(key) ?? -1)) return false;
        if (startPhase && generation > (startedRuns.get(key) ?? -1))
          startedRuns.set(key, generation);
        sent.push({ nodeId, frame: job });
        return true;
      },
      operatorRoom: () => true,
      closeOperatorStep: (stepId: string) => {
        closed.push(stepId);
        return closeAnswer;
      },
    } as unknown as ConstructorParameters<typeof RuntimeLifecycle>[0],
    { now: () => now },
  );
}

type Engine = InstanceType<typeof RuntimeLifecycle>;
type JobResult = Parameters<Engine["handleJobResult"]>[1];

const REF = {
  nodeId: "head",
  userId: "u1",
  slug: "head",
  connectionGeneration: 1,
  trust: "full" as const,
};

function instance(id: string, overrides: Partial<Instance> = {}): Instance {
  return {
    id,
    userId: "u1",
    runtimeId: "rt",
    handle: `i-${id.padEnd(12, "0").slice(0, 12)}`,
    versionId: "v1",
    launchVersionId: "v1",
    operationId: `op-${id}`,
    fabricId: null,
    startedBy: "USER",
    desiredState: "RUNNING",
    phase: "STARTING",
    phaseReason: null,
    phaseChangedAt: new Date(now.getTime() - 1_000),
    lastHealthAt: now,
    unavailableSince: null,
    unhealthySince: null,
    nextRestartAt: null,
    needsOperator: null,
    restartsInWindow: 0,
    restartWindowStartedAt: null,
    healthFailures: 0,
    healthSuccesses: 0,
    runGeneration: 1,
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
        lastStopCheckAt: now,
        stoppedAt: null,
        markedStoppedAt: null,
        plannedGeneration: 0,
        prevResources: null,
        prevPort: null,
        prevDistPort: null,
        prevGeneration: null,
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
    LaunchVersion: store.versions[0],
    ...overrides,
  };
}

function main(id = "inst"): Instance {
  const found = store.instances.find((item) => item.id === id);
  if (!found) throw new Error(`no instance ${id}`);
  return found;
}
const rank = (id = "inst") => {
  const [row] = main(id).Ranks;
  if (!row) throw new Error("no rank");
  return row;
};
const reserved = (id = "inst") =>
  reservationClaim(main(id).Ranks as Array<{ claim: "HELD" | "HELD_UNKNOWN" | "RELEASED" }>);
const stepsOf = (id = "inst") => store.steps.filter((step) => step.instanceId === id);
const stepById = (stepId: unknown) => {
  const found = store.steps.find((step) => step.id === stepId);
  if (!found) throw new Error(`no step ${String(stepId)}`);
  return found;
};
const framesTo = (phase: string) => sent.filter((entry) => entry.frame.phase === phase);
const lastFrame = (phase: string) => {
  const frame = framesTo(phase).at(-1)?.frame;
  if (!frame) throw new Error(`no ${phase} frame`);
  return frame;
};

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
const ok = (frame: Row) => result(frame, { status: "succeeded", stopped: true });

const INPUT = (id: string, versionId = "v1") => ({
  id,
  handle: main(id).handle as string,
  runtimeId: "rt",
  launchVersionId: versionId,
  launchHash: versionId === "v1" ? HASH.v1 : HASH.v2,
  fabricId: null,
});
const RANK0 = { rank: 0, port: 30000, distPort: null, resources: GB100 };

/** Steps of generation `generation` written as they would be (any state), at the instance's run. */
function addGeneration(
  id: string,
  generation: number,
  states: Partial<Record<"STOP" | "START" | "READINESS", { state: string; attempts?: number }>>,
  versionId = "v1",
  operationId: string = main(id).operationId as string,
): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const step of generationSteps({
    instance: INPUT(id, versionId),
    ranks: [RANK0],
    launch,
    generation,
    operationId,
  })) {
    const wanted = states[step.phase as "STOP" | "START" | "READINESS"];
    const row = {
      ...step,
      id: `${id}-g${generation}-${step.phase}`,
      instanceId: id,
      nodeId: "head",
      state: wanted?.state ?? "PENDING",
      attempts: wanted?.attempts ?? (wanted && wanted.state !== "PENDING" ? 1 : 0),
      notBefore: null,
      errorCode: null,
      operatorHold: null,
      operatorTerminalId: null,
      operatorSince: null,
      operatorAcceptedAt: null,
      ownerEpoch: null,
      deadline: null,
      createdAt: now,
      updatedAt: now,
    };
    store.steps.push(row);
    out[step.phase] = row;
  }
  return out;
}

function addStop(
  id: string,
  generation: number,
  attempt: number,
  state: string,
  phase: "STOP" | "STATUS" = "STOP",
): Row {
  const step = stopStep({
    instance: INPUT(id),
    rank: RANK0,
    nnodes: 1,
    launch,
    generation,
    attempt,
    operationId: null,
    phase,
  });
  const row = {
    ...step,
    id: `${id}-g${generation}-${phase}-${attempt}`,
    instanceId: id,
    nodeId: "head",
    state,
    attempts: state === "PENDING" ? 0 : 1,
    notBefore: null,
    errorCode: null,
    operatorHold: null,
    operatorTerminalId: null,
    operatorSince: null,
    operatorAcceptedAt: null,
    ownerEpoch: null,
    deadline: null,
    createdAt: now,
    updatedAt: now,
  };
  store.steps.push(row);
  return row;
}

/** `runtime_start` on the live instance: the one restart write (begins the next run). */
async function restart(
  id = "inst",
  options: { versionId?: string; port?: number; reservationNode?: string } = {},
) {
  await writePlannedStarts(db as never, {
    userId: "u1",
    operationId: `restart-${store.nextId++}`,
    startedBy: "USER",
    blockedBy: [[]],
    starts: [
      {
        runtimeId: "rt",
        versionId: options.versionId ?? "v1",
        instanceId: id,
        placements: [
          { nodeId: "head", nodeNumber: 1, port: options.port ?? 30000, resources: GB100 },
        ],
        reservations: [
          {
            index: 0,
            nodeId: options.reservationNode ?? "w1",
            labels: ["worker"],
            resources: GB100,
          },
        ],
        fabric: null,
        distPort: null,
      },
    ],
  });
}

function inventoryRecord(id: string, phase: string, stepId?: string) {
  return {
    instanceId: id,
    rank: 0,
    phase,
    launchVersionId: "v1",
    launchHash: HASH.v1,
    intentHash: "c".repeat(64),
    ...(stepId ? { stepId } : {}),
    unitName: `wsmp-${main(id).handle}-r0`,
    port: 30000,
    handle: main(id).handle as string,
    models: [],
  };
}
async function inventory(records: ReturnType<typeof inventoryRecord>[]) {
  // Stopped first: the inventory's own wake-up tick does not run (each test drives its ticks).
  const lc = engine();
  await lc.stop();
  return lc.runtimeInventory(REF, {
    snapshotId: "A".repeat(32),
    instances: records as never,
    alwaysOn: [],
  });
}

beforeEach(() => {
  setNow(new Date(Date.now() + 3_600_000));
  store.instances = [];
  store.steps = [];
  store.skipPrepare = false;
  store.failOwners = new Set();
  store.fabricIps = new Map();
  store.nextId = 1;
  store.nodes = [
    { id: "head", online: true, labels: [], memoryGb: 512 },
    { id: "w1", online: true, labels: ["worker"], memoryGb: 512 },
    { id: "w2", online: true, labels: ["worker"], memoryGb: 512 },
  ];
  store.versions = [
    {
      id: "v1",
      spec: { launch },
      launchHash: HASH.v1,
      editor: "USER",
      advanced: { restartBudget: 0 },
    },
    {
      id: "v2",
      spec: {
        launch: launchOf({
          commands: [{ start: "vendor2 up", stop: "vendor2 down", status: "vendor2 status" }],
        }),
      },
      launchHash: HASH.v2,
      editor: "USER",
      advanced: { restartBudget: 0 },
    },
  ];
  sent.length = 0;
  startedRuns.clear();
  store.afterClaim = null;
  closed.length = 0;
  closeAnswer = "closed";
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // No engine error was swallowed (a failed fenced write logs and is retried).
  expect(errors).toEqual([]);
  // Nothing is ever sent to a node an instance only reserves.
  const executionNodes = new Set(
    store.instances.flatMap((row) => row.Ranks.map((rank) => rank.nodeId)),
  );
  expect(sent.filter((entry) => !executionNodes.has(entry.nodeId))).toEqual([]);
});

describe("instance-run helpers", () => {
  it("orders a run by phase slot at any generation (T9, DCR-P3 inverted)", () => {
    for (const generation of [1, 2, 3, 9_000, 20_000]) {
      const steps = generationSteps({
        instance: {
          id: "x",
          handle: "i-x00000000000",
          runtimeId: "rt",
          launchVersionId: "v1",
          launchHash: HASH.v1,
          fabricId: null,
        },
        ranks: [RANK0],
        launch,
        generation,
        operationId: null,
      });
      const slot = (phase: string) => {
        const step = steps.find((entry) => entry.phase === phase);
        if (!step) throw new Error(phase);
        return slotOf(step);
      };
      if (generation > 1) expect(slot("STOP")).toBe(0);
      expect(slot("START")).toBe(20);
      expect(slot("READINESS")).toBe(40);
      const status = stopStep({
        instance: {
          id: "x",
          handle: "i-x00000000000",
          runtimeId: "rt",
          launchVersionId: "v1",
          launchHash: HASH.v1,
          fabricId: null,
        },
        rank: RANK0,
        nnodes: 1,
        launch,
        generation,
        attempt: 7,
        operationId: null,
        phase: "STATUS",
      });
      // The raw sequence of a status probe is below a high generation's START...
      if (generation >= 20_000) expect(status.sequence).toBeLessThan(steps[1]?.sequence ?? 0);
      // ...but its slot is after every launch of the run.
      expect(slotOf(status)).toBe(70);
      const gang = stopStep({
        instance: {
          id: "x",
          handle: "i-x00000000000",
          runtimeId: "rt",
          launchVersionId: "v1",
          launchHash: HASH.v1,
          fabricId: null,
        },
        rank: RANK0,
        nnodes: 1,
        launch,
        generation,
        attempt: 0,
        operationId: null,
      });
      expect(slotOf(gang)).toBe(50);
      const health = healthStep({
        instance: {
          id: "x",
          handle: "i-x00000000000",
          runtimeId: "rt",
          launchVersionId: "v1",
          launchHash: HASH.v1,
          fabricId: null,
        },
        head: RANK0,
        nnodes: 1,
        launch,
        generation,
        sequence: 1_000_000,
      });
      expect(slotOf(health)).toBe(60);
    }
    expect(owned({ generation: 3 }, 3)).toBe(true);
    expect(owned({ generation: 2 }, 3)).toBe(false);
  });

  it("bootstraps a legacy row once, counting a committed but unprepared restart (T8 unit)", async () => {
    store.instances = [instance("inst", { runGeneration: 0, phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    expect(await resolveRun(db as never, "inst")).toBe(1);
    expect(main().runGeneration).toBe(1);
    store.instances = [
      instance("legacy", { runGeneration: 0, phase: "STARTING", operationId: "op-B" }),
    ];
    addGeneration("legacy", 1, { START: { state: "PENDING" } }, "v1", "op-A");
    // Operation B committed, its steps never prepared: B is run 2.
    expect(await resolveRun(db as never, "legacy")).toBe(2);
    expect(main("legacy").runGeneration).toBe(2);
    expect(await beginRun(db as never, "legacy")).toBe(3);
  });
});

describe("a restart begins its run at commit (R3-A-1)", () => {
  it("T1: an old START prepared before the restart never goes out; the never-dispatched row is gone", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    // Generation 1 is prepared while the head is not connected: nothing is dispatched.
    store.nodes[0] = { ...(store.nodes[0] as NodeRow), online: false };
    await lc.runOnce();
    const oldStart = stepsOf().find((step) => step.phase === "START" && step.generation === 1);
    expect(oldStart?.state).toBe("PENDING");
    // A person restarts it, moving its reservation to w2: run 2 begins at this commit.
    await restart("inst", { reservationNode: "w2" });
    expect(main().runGeneration).toBe(2);
    // The never-dispatched w1 row is deleted, the w2 row is current.
    expect(main().Reservations.map((row) => [row.nodeId, row.supersededGeneration])).toEqual([
      ["w2", null],
    ]);
    store.nodes[0] = { ...(store.nodes[0] as NodeRow), online: true };
    await lc.runOnce();
    await lc.stop();
    // No START of generation 1 left; the old step is cancelled (it never ran).
    expect(framesTo("start").filter((entry) => entry.frame.generation === 1)).toEqual([]);
    expect(stepById(oldStart?.id).state).toBe("CANCELLED");
    // Run 2 proceeds with its leading stop.
    expect(lastFrame("stop").generation).toBe(2);
  });

  it("T1 control: without a restart the same START goes out", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("start").generation).toBe(1);
  });

  it("T2: an old READINESS answering after the restart leaves the successor STARTING", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    await lc.handleJobResult(REF, ok(lastFrame("start")));
    await lc.runOnce();
    const readiness = lastFrame("readiness");
    await restart();
    await lc.handleJobResult(REF, result(readiness, { status: "succeeded" }));
    await lc.stop();
    expect(main().phase).toBe("STARTING");
    expect(stepById(readiness.stepId).state).toBe("SUCCEEDED");
  });

  it("T3: an old START failing, or timing out, after the restart does not stop the successor", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    const start = lastFrame("start");
    await restart();
    await lc.handleJobResult(REF, result(start, { status: "failed", error: "command_failed" }));
    expect(main().phase).toBe("STARTING");
    // A second instance: its old START times out after the restart.
    store.instances.push(instance("late"));
    sent.length = 0;
    await lc.runOnce();
    const lateStart = framesTo("start").find((entry) => entry.frame.instanceId === "late")?.frame;
    if (!lateStart) throw new Error("no start of late");
    await restart("late");
    setNow(new Date(now.getTime() + 3_600_000));
    await lc.runOnce();
    await lc.stop();
    expect(stepById(lateStart.stepId)).toMatchObject({
      state: "FAILED",
      errorCode: "job_deadline",
    });
    expect(main("late").phase).toBe("STARTING");
  });

  it("T3 control: a START of the current run failing gang-stops it", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    await lc.handleJobResult(
      REF,
      result(lastFrame("start"), { status: "failed", error: "command_failed" }),
    );
    await lc.stop();
    expect(main().phase).toBe("STOPPING");
  });

  it("T5: a restart committed, the head offline then back: STARTING, not the old run's READY", async () => {
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    await restart();
    // The watch saw the head go away before run 2 was prepared.
    Object.assign(main(), { phase: "UNAVAILABLE", unavailableSince: now });
    const lc = engine();
    // (prepareStarts reaches only STARTING rows.)
    await lc.runOnce();
    await lc.stop();
    expect(main().phase).toBe("STARTING");
  });
});

describe("the definition update's restart begins a run (DP-1, T4, T12)", () => {
  /** What `runtimes.update` with restartRunning writes per restarted instance. */
  async function updateRestart(id = "inst") {
    await resolveRun(db as never, id);
    Object.assign(main(id), {
      versionId: "v2",
      launchVersionId: "v2",
      operationId: "op-update",
      phase: "STARTING",
      phaseReason: "definition_changed",
    });
    await beginRun(db as never, id);
  }

  it("T4: a crashed run's late gang STOP releases nothing; the new leading STOP names the old version", async () => {
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    const lc = engine();
    // The node lost it: a crash, a gang STOP goes out.
    await inventory([inventoryRecord("inst", "stopped", "inst-g1-READINESS")]);
    expect(main().phase).toBe("STOPPING");
    await lc.runOnce();
    const gangStop = lastFrame("stop");
    expect(gangStop.generation).toBe(1);
    // The definition changes with restartRunning while the stop is out.
    await updateRestart();
    await lc.handleJobResult(REF, ok(gangStop));
    expect(rank().claim).toBe("HELD");
    expect(reserved()).toBe("HELD");
    expect(main().phase).toBe("STARTING");
    // Run 2's leading stop goes out naming what physically runs: version 1's unit.
    await lc.runOnce();
    const leading = lastFrame("stop");
    expect(leading.generation).toBe(2);
    expect(leading).toMatchObject({ launchVersionId: "v1", launchHash: HASH.v1 });
    await lc.handleJobResult(REF, ok(leading));
    await lc.runOnce();
    await lc.stop();
    // Proven: run 2 starts with version 2.
    expect(lastFrame("start")).toMatchObject({ generation: 2, launchVersionId: "v2" });
    expect(rank().claim).toBe("HELD");
  });

  it("T12: a version- and port-changing runtime_start restart stops the old unit by its own identity", async () => {
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    await restart("inst", { versionId: "v2", port: 30005 });
    Object.assign(main(), { launchVersionId: "v2", versionId: "v2" });
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    const leading = lastFrame("stop");
    expect(leading).toMatchObject({
      generation: 2,
      launchVersionId: "v1",
      launchHash: HASH.v1,
      placeholders: expect.objectContaining({ port: 30000 }),
    });
    // The old version's stop timeout and interactivity (from its own spec).
    expect(stepById(leading.stepId).intent).toMatchObject({ launchVersionId: "v1", port: 30000 });
  });

  it("an interactive stop of an earlier launch names that version's author, never the successor's", async () => {
    // v1 (an agent wrote it) stops in an operator terminal; v2 is a person's.
    store.versions[0] = {
      ...(store.versions[0] as Row),
      editor: "AGENT",
      spec: {
        launch: launchOf({
          commands: [
            {
              start: "vendor up",
              stop: "vendor down",
              status: "vendor status",
              interactive: { stop: true },
            },
          ],
        }),
      },
    };
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    await restart("inst", { versionId: "v2" });
    Object.assign(main(), { launchVersionId: "v2", versionId: "v2" });
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    const leading = lastFrame("stop");
    expect(leading).toMatchObject({ generation: 2, launchVersionId: "v1" });
    expect(leading.operator).toMatchObject({ commandAuthor: "agent" });
  });

  it("T12 control: a never-launched rank's leading stop uses the run's own identity", async () => {
    store.instances = [instance("inst")];
    await restart("inst", { versionId: "v2" });
    Object.assign(main(), { launchVersionId: "v2", versionId: "v2" });
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("stop")).toMatchObject({ generation: 2, launchVersionId: "v2" });
  });
});

describe("stop proofs are of the current run, after its launches (F5, R3-B-1, C3-UPGRADE)", () => {
  it("T19 path 1: a late gang STOP of the run before a manual restart releases nothing", async () => {
    store.instances = [instance("inst", { phase: "STOPPING" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" } });
    const lc = engine();
    await lc.runOnce();
    const stop = lastFrame("stop");
    await restart();
    await lc.handleJobResult(REF, ok(stop));
    await lc.stop();
    expect(rank().claim).toBe("HELD");
    expect(reserved()).toBe("HELD");
  });

  it("T19 path 1 control: the same gang STOP releases when no restart came", async () => {
    store.instances = [instance("inst", { phase: "STOPPING", desiredState: "STOPPED" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" } });
    const lc = engine();
    await lc.runOnce();
    await lc.handleJobResult(REF, ok(lastFrame("stop")));
    await lc.stop();
    expect(rank().claim).toBe("RELEASED");
    expect(reserved()).toBe("RELEASED");
  });

  it("T6: a delayed leading-STOP record after this run's START is stale: nothing released, handle kept", async () => {
    store.instances = [instance("inst", { phase: "STOPPING", runGeneration: 2 })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" } });
    const g2 = addGeneration("inst", 2, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "SUCCEEDED" },
      READINESS: { state: "SUCCEEDED" },
    });
    const answer = await inventory([inventoryRecord("inst", "stopped", g2.STOP?.id as string)]);
    expect(rank().claim).toBe("HELD");
    expect(reserved()).toBe("HELD");
    expect(main().phase).toBe("STOPPING");
    expect(answer).toEqual({ ok: true, stale: [main().handle] });
  });

  it("T6 control (I3): a record naming this run's gang STOP releases", async () => {
    store.instances = [
      instance("inst", { phase: "STOPPING", runGeneration: 2, desiredState: "STOPPED" }),
    ];
    addGeneration("inst", 2, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "SUCCEEDED" },
      READINESS: { state: "SUCCEEDED" },
    });
    const gang = addStop("inst", 2, 0, "SUCCEEDED");
    const answer = await inventory([inventoryRecord("inst", "stopped", gang.id as string)]);
    expect(rank().claim).toBe("RELEASED");
    expect(answer).toEqual({ ok: true, stale: [] });
  });

  it("T7: legacy rows (run 0): generation 1's inventory and requeued STATUS release nothing; generation 2's STATUS does", async () => {
    store.instances = [
      instance("inst", { runGeneration: 0, phase: "STOPPED", desiredState: "STOPPED" }),
    ];
    Object.assign(rank(), { claim: "HELD_UNKNOWN", markedStoppedAt: now, lastStopCheckAt: now });
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" } });
    const g1stop = addStop("inst", 1, 0, "SUCCEEDED");
    addGeneration("inst", 2, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "SUCCEEDED" },
      READINESS: { state: "SUCCEEDED" },
    });
    // Generation 1's stop record arrives late.
    await inventory([inventoryRecord("inst", "stopped", g1stop.id as string)]);
    expect(rank().claim).toBe("HELD_UNKNOWN");
    expect(main().runGeneration).toBe(2);
    // A generation-1 status probe re-queued by a reconnect (attempts 1) is not re-sent.
    const g1status = addStop("inst", 1, 0, "PENDING", "STATUS");
    g1status.attempts = 1;
    const lc = engine();
    await lc.runOnce();
    expect(framesTo("status").filter((entry) => entry.frame.generation === 1)).toEqual([]);
    expect(stepById(g1status.id)).toMatchObject({ state: "FAILED", errorCode: "superseded" });
    expect(rank().claim).toBe("HELD_UNKNOWN");
    // Control (I8): generation 2's own status probe proves it.
    rank().lastStopCheckAt = null;
    // The probe is written at the end of a pass and sent on the next one.
    await lc.runOnce();
    await lc.runOnce();
    const probe = lastFrame("status");
    expect(probe.generation).toBe(2);
    await lc.handleJobResult(REF, ok(probe));
    await lc.stop();
    expect(rank().claim).toBe("RELEASED");
  });

  it("T8: a legacy committed restart not reached by prepareStarts: the old START never goes out", async () => {
    store.instances = [
      instance("inst", { runGeneration: 0, phase: "STARTING", operationId: "op-B" }),
    ];
    // Operation A's generation 1 was prepared (not sent) before B was committed.
    const g1 = addGeneration("inst", 1, { START: { state: "PENDING" } }, "v1", "op-A");
    store.skipPrepare = true;
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("start")).toEqual([]);
    expect(stepById(g1.START?.id).state).toBe("CANCELLED");
    expect(main().runGeneration).toBe(2);
  });

  it("T9: at generation 20,000 a fresh status probe and the current gang stop release; the leading stop after START does not", async () => {
    const G = 20_000;
    store.instances = [
      instance("inst", { phase: "STOPPING", runGeneration: G, desiredState: "STOPPED" }),
    ];
    const g = addGeneration("inst", G, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "SUCCEEDED" },
      READINESS: { state: "SUCCEEDED" },
    });
    const status = addStop("inst", G, 3, "SUCCEEDED", "STATUS");
    expect(Number(status.sequence)).toBeLessThan(Number(g.START?.sequence));
    const tx = db as never;
    // The leading stop (observed before START) proves nothing now.
    expect(
      await releaseClaim(tx, rank().id, now, { observation: { stepId: g.STOP?.id as string } }),
    ).toBe(false);
    expect(
      await releaseClaim(tx, rank().id, now, { result: { stepId: g.STOP?.id as string } }),
    ).toBe(false);
    expect(rank().claim).toBe("HELD");
    // The probe (slot 70) is after the run's launches.
    expect(
      await releaseClaim(tx, rank().id, now, { result: { stepId: status.id as string } }),
    ).toBe(true);
    expect(rank().claim).toBe("RELEASED");
    // A gap 3 → 9,000: the current gang stop's record releases.
    store.instances = [instance("gap", { phase: "STOPPING", runGeneration: 9_000 })];
    addGeneration("gap", 9_000, { STOP: { state: "SUCCEEDED" }, START: { state: "SUCCEEDED" } });
    const gang = addStop("gap", 9_000, 0, "SUCCEEDED");
    expect(
      await releaseClaim(tx, rank("gap").id, now, { observation: { stepId: gang.id as string } }),
    ).toBe(true);
  });

  it("T16: releaseClaim refuses a step of another rank, an unfinished result, a leading stop over HELD; never-ran is evaluated here", async () => {
    store.instances = [
      instance("inst", { phase: "STOPPING", runGeneration: 2 }),
      instance("other", { phase: "STOPPING", runGeneration: 2 }),
    ];
    const tx = db as never;
    const g2 = addGeneration("inst", 2, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "SUCCEEDED" },
    });
    const otherStop = addStop("other", 2, 0, "SUCCEEDED");
    const running = addStop("inst", 2, 0, "RUNNING");
    expect(
      await releaseClaim(tx, rank().id, now, { result: { stepId: otherStop.id as string } }),
    ).toBe(false);
    expect(
      await releaseClaim(tx, rank().id, now, { result: { stepId: running.id as string } }),
    ).toBe(false);
    expect(
      await releaseClaim(tx, rank().id, now, { result: { stepId: g2.START?.id as string } }),
    ).toBe(false);
    expect(
      await releaseClaim(tx, rank().id, now, { result: { stepId: g2.STOP?.id as string } }),
    ).toBe(false);
    // The START ran: never-ran is false.
    expect(await releaseClaim(tx, rank().id, now, { neverRan: true })).toBe(false);
    // A person's release still takes only a claim marked stopped.
    expect(
      await releaseClaim(tx, rank().id, now, { unproven: { by: "u1", reason: "checked" } }),
    ).toBe(false);
    expect(rank().claim).toBe("HELD");
    // Control: the current gang stop's result releases.
    running.state = "SUCCEEDED";
    expect(
      await releaseClaim(tx, rank().id, now, { result: { stepId: running.id as string } }),
    ).toBe(true);
    // An inventory observation waits for every start of the rank sent and unanswered.
    store.instances.push(instance("busy", { phase: "STOPPING", runGeneration: 2 }));
    const busyStart = addGeneration("busy", 1, { START: { state: "RUNNING" } }).START as Row;
    const busyGang = {
      ...addStop("busy", 1, 0, "SUCCEEDED"),
      id: "busy-gang",
      generation: 2,
      sequence: 250,
    };
    store.steps.push(busyGang);
    expect(
      await releaseClaim(tx, rank("busy").id, now, { observation: { stepId: "busy-gang" } }),
    ).toBe(false);
    busyStart.state = "FAILED";
    expect(
      await releaseClaim(tx, rank("busy").id, now, { observation: { stepId: "busy-gang" } }),
    ).toBe(true);
    // Never-ran control: a run whose START was cancelled and whose leading stop succeeded.
    store.instances.push(instance("never", { phase: "STOPPING", runGeneration: 2 }));
    addGeneration("never", 2, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "CANCELLED", attempts: 0 },
    });
    expect(
      await releaseClaim(tx, rank("never").id, now, {
        neverRan: true,
      }),
    ).toBe(true);
  });
});

describe("inventory without ordered evidence (DC8, T14, T15)", () => {
  it("T14: a missing record after READY (restart budget 0) asks a health probe instead of a crash", async () => {
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    await inventory([]);
    expect(main().phase).toBe("READY");
    expect(main().lastHealthAt).toBeNull();
    const lc = engine();
    await lc.runOnce();
    // A health probe went out; failing ones still make it UNHEALTHY.
    const probe = lastFrame("health");
    await lc.handleJobResult(REF, result(probe, { status: "failed", error: "health_failed" }));
    expect(main().healthFailures).toBe(1);
    main().lastHealthAt = null;
    await lc.runOnce();
    const second = lastFrame("health");
    expect(second.stepId).not.toBe(probe.stepId);
    await lc.handleJobResult(REF, result(second, { status: "failed", error: "health_failed" }));
    await lc.stop();
    expect(main().phase).toBe("UNHEALTHY");
    expect(rank().claim).toBe("HELD");
  });

  it("T14: a record without a step id (before 0.4.0) does not crash the run either", async () => {
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    await inventory([inventoryRecord("inst", "stopped")]);
    expect(main().phase).toBe("READY");
  });

  it("T15: a current-run record naming its HEALTH step, stopped, is a crash (I6)", async () => {
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    const lc = engine();
    main().lastHealthAt = null;
    await lc.runOnce();
    const probe = lastFrame("health");
    await lc.handleJobResult(REF, result(probe, { status: "succeeded" }));
    await lc.stop();
    await inventory([inventoryRecord("inst", "stopped", String(probe.stepId))]);
    expect(main()).toMatchObject({ phase: "STOPPING", phaseReason: "crashed" });
  });

  it("DP-4: a READY successor ignores a stale stopped record naming the previous run's gang stop", async () => {
    store.instances = [instance("inst", { phase: "READY", runGeneration: 2 })];
    addGeneration("inst", 2, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "SUCCEEDED" },
      READINESS: { state: "SUCCEEDED" },
    });
    // A gang stop row of run 1 (written before run 2 began).
    const old = {
      ...addStop("inst", 2, 0, "SUCCEEDED"),
      id: "old-gang",
      generation: 1,
      sequence: 150,
    };
    store.steps.push(old);
    const answer = await inventory([inventoryRecord("inst", "stopped", "old-gang")]);
    expect(main().phase).toBe("READY");
    expect(answer).toEqual({ ok: true, stale: [main().handle] });
  });
});

describe("operator screens of an earlier run (DC3, T10, T11)", () => {
  async function interactiveStartOut() {
    store.versions[0] = { ...(store.versions[0] as Row), spec: { launch: interactiveLaunch } };
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    const start = lastFrame("start");
    const operator = start.operator as { terminalId: string } | undefined;
    if (!operator) throw new Error("not an operator start");
    return { lc, start, terminalId: operator.terminalId };
  }

  it("T10: an old screen coming up after the restart is closed and changes nothing for the successor", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await restart();
    // No pass runs after the answer: the result handler alone settles it.
    await lc.stop();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    expect(main().needsOperator).toBeNull();
    expect(closed).toContain(start.stepId);
    expect(stepById(start.stepId).state).toMatch(/CANCELLED|FAILED/);
  });

  it("T10 control: the current run's screen needs its person", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    await lc.stop();
    expect(main().needsOperator).toBe("STEP");
  });

  it("T11: an accepted old run holds the successor's leading stop until it answers", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    await lc.handleJobResult(REF, result(start, { status: "operator_running", terminalId }));
    await restart();
    sent.length = 0;
    await lc.runOnce();
    expect(framesTo("stop")).toEqual([]);
    await lc.handleJobResult(REF, result(start, { status: "succeeded", terminalId }));
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("stop").generation).toBe(2);
    // The old run's answer changed nothing for the successor.
    expect(main().phase).toBe("STARTING");
  });

  it("T13 (operator): an old screen whose command already runs holds the leading stop", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    // The person's command already runs in that terminal: it cannot be closed.
    closeAnswer = "running";
    await restart();
    sent.length = 0;
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("stop")).toEqual([]);
    // R5-B-1: the relay's running answer is the person's acceptance this database never got:
    // recorded now (its deadline from its screen), so it is an accepted old run like T11's.
    expect(stepById(start.stepId)).toMatchObject({ state: "RUNNING" });
    expect(stepById(start.stepId).operatorAcceptedAt).not.toBeNull();
    expect(stepById(start.stepId).deadline).not.toBeNull();
    expect(main().needsOperator).toBeNull();
  });

  it("R5-B-1: accepted physical work stays discoverable when recording its acceptance failed", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    // The relay has observed operator_running before the engine's write, which fails once.
    store.failOwners.add("u1");
    await expect(
      lc.handleJobResult(REF, result(start, { status: "operator_running", terminalId })),
    ).rejects.toThrow();
    store.failOwners.clear();
    expect(stepById(start.stepId)).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorAcceptedAt: null,
    });
    // The person's command runs on the node: the relay keeps it (closeOperatorStep: running).
    closeAnswer = "running";
    await restart();
    setNow(new Date(now.getTime() + 86_400_000));
    sent.length = 0;
    await lc.runOnce();
    await lc.stop();
    // The successor keeps waiting behind it, holding its claims; nothing is cut off.
    expect(main().phase).toBe("STARTING");
    expect(rank().claim).toBe("HELD");
    expect(framesTo("stop")).toEqual([]);
    expect(stepById(start.stepId)).toMatchObject({ state: "RUNNING" });
    // Its person is asked (any run), and Needs-you lists the step to attach to.
    expect(main().needsOperator).toBe("STEP");
    Object.assign(main(), { Runtime: { name: "Runtime", nodeId: null }, createdAt: now });
    const { activityRouter } = await import("../../../../packages/api/src/routers/activity");
    const { createRouterClient } = await import("@orpc/server");
    const client = createRouterClient(activityRouter, {
      context: {
        session: {
          user: {
            id: "u1",
            email: "a@example.test",
            name: "Owner",
            role: "user",
            emailVerified: true,
          },
          session: { id: "session", userId: "u1", expiresAt: new Date(now.getTime() + 86_400_000) },
        } as never,
        auth: { kind: "cookie_session", userId: "u1", sessionId: "session", csrfVerified: true },
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const needs = await client.needsYou.list();
    vi.useRealTimers();
    expect(needs.items.map((item) => item.stepId)).toContain(String(start.stepId));
  });

  it("T11 / R4-B-2: an accepted old run past its timeout asks its person, and authorizes nothing", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    await lc.handleJobResult(REF, result(start, { status: "operator_running", terminalId }));
    expect(main().needsOperator).toBeNull();
    await restart();
    sent.length = 0;
    setNow(new Date(now.getTime() + 86_400_000));
    await lc.runOnce();
    // The old run keeps running (a person's run is never cut off) and holds the stop back, and
    // its person is asked to look at it (needsYou lists the instance with this step).
    expect(stepById(start.stepId).state).toBe("RUNNING");
    expect(main().needsOperator).toBe("STEP");
    expect(framesTo("stop")).toEqual([]);
    // Its answer still changes nothing about the successor but its need: the successor stays
    // STARTING and its leading stop goes out next.
    await lc.handleJobResult(REF, result(start, { status: "succeeded", terminalId }));
    expect(main().needsOperator).toBeNull();
    expect(main().phase).toBe("STARTING");
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("stop").generation).toBe(2);
  });

  it("T11: the successor's gang stop also waits for an accepted old run", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    await lc.handleJobResult(REF, result(start, { status: "operator_running", terminalId }));
    await restart();
    // The successor is stopped before it starts: a gang stop of run 2 is due.
    Object.assign(main(), { desiredState: "STOPPED", phase: "STOPPING" });
    sent.length = 0;
    await lc.runOnce();
    await lc.runOnce();
    expect(stepsOf().some((step) => step.phase === "STOP" && step.generation === 2)).toBe(true);
    expect(framesTo("stop")).toEqual([]);
    await lc.handleJobResult(REF, result(start, { status: "succeeded", terminalId }));
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("stop").generation).toBe(2);
  });

  it("T11 inverse: an unaccepted old screen does not hold the leading stop", async () => {
    const { lc, start, terminalId } = await interactiveStartOut();
    await lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId }));
    expect(main().needsOperator).toBe("STEP");
    await restart();
    sent.length = 0;
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("stop").generation).toBe(2);
    expect(closed).toContain(start.stepId);
    expect(main().needsOperator).toBeNull();
  });
});

describe("launch linearization and the re-dispatch bound (DC10, DC7, T13, T17)", () => {
  it("T13: the leading stop waits for an old START still out; old rows stay held meanwhile", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    const start = lastFrame("start");
    await restart("inst", { reservationNode: "w2" });
    // The old START was dispatched: its w1 row is kept, superseded.
    expect(
      main()
        .Reservations.map((row) => [row.nodeId, row.supersededGeneration])
        .sort(),
    ).toEqual([
      ["w1", 1],
      ["w2", null],
    ]);
    sent.length = 0;
    await lc.runOnce();
    expect(framesTo("stop")).toEqual([]);
    // It answers (late, superseded): the leading stop goes out now.
    await lc.handleJobResult(REF, result(start, { status: "succeeded" }));
    await lc.runOnce();
    const leading = lastFrame("stop");
    expect(leading.generation).toBe(2);
    expect(reserved()).toBe("HELD");
    // Proven: run 2's START is claimed and the superseded row goes.
    await lc.handleJobResult(REF, ok(leading));
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("start").generation).toBe(2);
    expect(main().Reservations.map((row) => row.nodeId)).toEqual(["w2"]);
  });

  it("T13: a lost session re-queues the old START, which then never goes out, and the leading stop follows", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    const start = lastFrame("start");
    await restart();
    await lc.nodeDisconnected(REF);
    sent.length = 0;
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("start")).toEqual([]);
    expect(stepById(start.stepId)).toMatchObject({ state: "FAILED", errorCode: "superseded" });
    expect(lastFrame("stop").generation).toBe(2);
  });

  it("T17: a START re-queued while STARTING is re-sent within the run (bounded unit jobs); in STOPPING it fails", async () => {
    store.instances = [instance("inst", { runGeneration: 2 })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" } });
    const lc = engine();
    await lc.runOnce();
    await lc.handleJobResult(REF, ok(lastFrame("stop")));
    await lc.runOnce();
    const start = lastFrame("start");
    await lc.nodeDisconnected(REF);
    await lc.runOnce();
    // Re-sent once, same step.
    expect(framesTo("start").map((entry) => entry.frame.stepId)).toEqual([
      start.stepId,
      start.stepId,
    ]);
    const unitJobs = sent.filter((entry) => entry.frame.instanceId === "inst");
    expect(unitJobs.length).toBeLessThanOrEqual(5);
    // Requeued again, then the run is stopped: it fails, never re-sent.
    await lc.nodeDisconnected(REF);
    Object.assign(main(), { desiredState: "STOPPED", phase: "STOPPING" });
    sent.length = 0;
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("start")).toEqual([]);
    expect(stepById(start.stepId)).toMatchObject({ state: "FAILED", errorCode: "stopped" });
  });
});

describe("queued starts wait while a blocker's claim is not RELEASED (D13, carried)", () => {
  function queued(blockerClaim: string, blockerReservationOnly = false) {
    store.instances = [
      instance("blocker", {
        phase: "STOPPING",
        Ranks: [
          {
            ...(instance("blocker").Ranks[0] as Rank),
            nodeId: blockerReservationOnly ? "w9" : "head",
            claim: blockerClaim,
            markedStoppedAt: blockerClaim === "HELD_UNKNOWN" ? now : null,
          },
        ],
        Reservations: [
          {
            ...(instance("blocker").Reservations[0] as Reservation),
            nodeId: "w1",
          },
        ],
      }),
      instance("inst"),
    ];
    rank("inst").blockedBy = ["blocker"];
    store.nodes.push({ id: "w9", online: false, labels: [], memoryGb: 64 });
    // The blocker's own stop is out already (nothing more to send for it here).
    addStop("blocker", 1, 0, "RUNNING");
  }

  it("waits for a blocker rank marked stopped (HELD_UNKNOWN) on its node", async () => {
    queued("HELD_UNKNOWN");
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("start")).toEqual([]);
  });

  it("waits for a blocker's reservation whose claim is marked stopped", async () => {
    queued("HELD_UNKNOWN", true);
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(framesTo("start")).toEqual([]);
  });

  it("sends the START once every blocker claim is RELEASED (inverse control)", async () => {
    queued("RELEASED");
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("start").instanceId).toBe("inst");
    expect(rank("inst").blockedBy).toEqual([]);
  });
});

// ── Batched sweeps reach every row (./sweep.ts; R4-A-1..4, R4-B-2, R4-C-1) ──
// Each prefix is at least one page of rows that a pass cannot act on, sorted (by id) ahead of
// the instance that needs the sweep; the database's ordering and `take` are honored above.
// The 255 / 63 rows control is the pre-existing behaviour; the full-page case is the fix.

/** Prefix instance `i` on its own head and reservation node (no shared port or memory). */
function distributePrefix(id: string, i: number) {
  store.nodes.push(
    { id: `head${i}`, online: true, labels: [], memoryGb: 512 },
    { id: `worker${i}`, online: true, labels: ["worker"], memoryGb: 512 },
  );
  const row = main(id);
  if (row.Ranks[0]) row.Ranks[0].nodeId = `head${i}`;
  if (row.Reservations[0]) row.Reservations[0].nodeId = `worker${i}`;
}

/** Steps of a prefix instance on its own node, interactive starts re-hashed. */
function onPrefixNode(i: number, steps: Row[], interactive: boolean) {
  for (const step of steps) {
    step.nodeId = `head${i}`;
    if (interactive && step.phase === "START")
      step.intent = { ...(step.intent as Row), interactive: true };
    step.intentHash = intentHash(step.intent as never);
  }
}

const prefixId = (kind: string, i: number) => `a-${kind}${i.toString().padStart(6, "0")}`;

describe("batched sweeps reach every row (SWEEP, ./sweep.ts)", () => {
  it.each([255, 256])(
    "R4-A-2 prepareStarts: a newer run is prepared behind %i prepared runs waiting for their person",
    async (count) => {
      store.versions[0] = { ...(store.versions[0] as Row), spec: { launch: interactiveLaunch } };
      for (let i = 0; i < count; i++) {
        const id = prefixId("wait", i);
        store.instances.push(
          instance(id, {
            phaseChangedAt: new Date(now.getTime() - 100_000 - i),
            needsOperator: "STEP",
          }),
        );
        distributePrefix(id, i);
        const g = addGeneration(id, 1, { START: { state: "AWAITING_OPERATOR", attempts: 0 } });
        onPrefixNode(i, Object.values(g), true);
        Object.assign(g.START as Row, {
          operatorSince: new Date(now.getTime() - 60_000),
        });
      }
      store.instances.push(instance("inst", { phaseChangedAt: now }));
      const lc = engine();
      for (let tick = 0; tick < 4; tick++) await lc.runOnce();
      await lc.stop();
      expect(stepsOf("inst").filter((step) => step.phase === "START")).toHaveLength(1);
    },
    120_000,
  );

  it.each([255, 256])(
    "R4-A-3 dispatchSteps: a leading STOP that may go is sent behind %i waiting ones",
    async (count) => {
      store.versions[0] = { ...(store.versions[0] as Row), spec: { launch: interactiveLaunch } };
      for (let i = 0; i < count; i++) {
        const id = prefixId("busy", i);
        store.instances.push(instance(id, { runGeneration: 2 }));
        distributePrefix(id, i);
        const old = addGeneration(id, 1, {
          START: { state: "RUNNING" },
          READINESS: { state: "CANCELLED", attempts: 0 },
        });
        // A person's accepted run of the previous run, within its timeout: the leading STOP of
        // run 2 waits behind it (DC10), PENDING.
        Object.assign(old.START as Row, {
          operatorTerminalId: `terminal-${i}`,
          operatorSince: now,
          operatorAcceptedAt: now,
          ownerEpoch: "irrelevant",
          deadline: new Date(now.getTime() + 3_600_000),
        });
        const next = addGeneration(id, 2, {
          STOP: { state: "PENDING" },
          START: { state: "PENDING" },
          READINESS: { state: "PENDING" },
        });
        onPrefixNode(i, [...Object.values(old), ...Object.values(next)], true);
      }
      store.instances.push(instance("inst", { runGeneration: 2 }));
      addGeneration("inst", 2, {
        STOP: { state: "PENDING" },
        START: { state: "PENDING" },
        READINESS: { state: "PENDING" },
      });
      const lc = engine();
      for (let tick = 0; tick < 6; tick++) await lc.runOnce();
      await lc.stop();
      expect(framesTo("stop").filter((job) => job.frame.instanceId === "inst")).toHaveLength(1);
    },
    120_000,
  );

  it.each([255, 256])(
    "R4-A-4 watchLive: a reservation node going offline is noticed behind %i live instances (D4)",
    async (count) => {
      for (let i = 0; i < count; i++) {
        const id = prefixId("live", i);
        store.instances.push(instance(id, { phase: "READY" }));
        distributePrefix(id, i);
      }
      store.instances.push(instance("inst", { phase: "READY" }));
      const reservation = main().Reservations[0];
      if (reservation) reservation.nodeId = "w2";
      const w2 = store.nodes.find((node) => node.id === "w2");
      if (w2) w2.online = false;
      setNow(new Date(now.getTime() + 120_000));
      const lc = engine();
      for (let tick = 0; tick < 2; tick++) await lc.runOnce();
      await lc.stop();
      expect(main().phase).toBe("UNAVAILABLE");
    },
    120_000,
  );

  it.each([63, 64])(
    "R4-A-1 / R4-B-2 expireSteps: %i earlier runs' accepted commands past their timeout ask their person and starve no deadline",
    async (count) => {
      store.versions[0] = { ...(store.versions[0] as Row), spec: { launch: interactiveLaunch } };
      for (let i = 0; i < count; i++) {
        const id = prefixId("past", i);
        store.instances.push(instance(id, { runGeneration: 2 }));
        distributePrefix(id, i);
        const old = addGeneration(id, 1, {
          START: { state: "RUNNING" },
          READINESS: { state: "CANCELLED", attempts: 0 },
        });
        const next = addGeneration(id, 2, {
          STOP: { state: "PENDING" },
          START: { state: "PENDING" },
          READINESS: { state: "PENDING" },
        });
        Object.assign(old.START as Row, {
          operatorTerminalId: `terminal-${i}`,
          operatorSince: new Date(now.getTime() - 600_001),
          operatorAcceptedAt: new Date(now.getTime() - 600_000),
          ownerEpoch: "old",
          deadline: new Date(now.getTime() - 120_000),
        });
        onPrefixNode(i, [...Object.values(old), ...Object.values(next)], true);
      }
      store.instances.push(
        instance("inst", { runGeneration: 2, launchVersionId: "v2", versionId: "v2" }),
      );
      const old = addGeneration(
        "inst",
        1,
        { START: { state: "RUNNING" }, READINESS: { state: "CANCELLED", attempts: 0 } },
        "v2",
      );
      Object.assign(old.START as Row, {
        deadline: new Date(now.getTime() - 60_000),
        ownerEpoch: "earlier",
      });
      addGeneration(
        "inst",
        2,
        {
          STOP: { state: "PENDING" },
          START: { state: "PENDING" },
          READINESS: { state: "PENDING" },
        },
        "v2",
      );
      const lc = engine();
      for (let tick = 0; tick < 3; tick++) await lc.runOnce();
      await lc.stop();
      // Each person is asked to look at their still-running command (needsYou), which is
      // still never cut off and still holds its successor's stop back.
      for (let i = 0; i < count; i++) {
        expect(main(prefixId("past", i)).needsOperator).toBe("STEP");
        expect(stepById(`${prefixId("past", i)}-g1-START`).state).toBe("RUNNING");
      }
      expect(
        framesTo("stop").filter((job) => String(job.frame.instanceId).startsWith("a-")),
      ).toEqual([]);
      // The unrelated expired START settles, and its successor's leading STOP goes out.
      expect(stepById(old.START?.id)).toMatchObject({ state: "FAILED", errorCode: "job_deadline" });
      expect(framesTo("stop").filter((job) => job.frame.instanceId === "inst")).toHaveLength(1);
    },
    120_000,
  );

  it.each([63, 64])(
    "expireSteps: %i screens that never came up but whose command runs do not starve a deadline",
    async (count) => {
      store.versions[0] = { ...(store.versions[0] as Row), spec: { launch: interactiveLaunch } };
      for (let i = 0; i < count; i++) {
        const id = prefixId("screen", i);
        store.instances.push(instance(id));
        distributePrefix(id, i);
        const g = addGeneration(id, 1, { START: { state: "RUNNING" } });
        Object.assign(g.START as Row, {
          operatorTerminalId: `terminal-${i}`,
          ownerEpoch: "this",
          deadline: new Date(now.getTime() - 120_000),
        });
        onPrefixNode(i, Object.values(g), true);
      }
      // Their terminals report a command running: a reissue would run it twice, so they stay.
      closeAnswer = "running";
      store.instances.push(instance("inst"));
      const victim = addGeneration("inst", 1, { START: { state: "RUNNING" } }).START as Row;
      Object.assign(victim, { deadline: new Date(now.getTime() - 60_000), ownerEpoch: "this" });
      const lc = engine();
      await lc.stop();
      const sweep = lc as unknown as { expireSteps(): Promise<void> };
      for (let pass = 0; pass < 3; pass++) await sweep.expireSteps();
      expect(stepById(victim.id)).toMatchObject({ state: "FAILED", errorCode: "job_deadline" });
      expect(main().phase).toBe("STOPPING");
    },
    120_000,
  );

  it.each([63, 64])(
    "restartDue: an automatic restart is reached behind %i whose writes keep failing",
    async (count) => {
      for (let i = 0; i < count; i++) {
        const id = prefixId("down", i);
        store.instances.push(
          instance(id, {
            userId: "u-failing",
            phase: "STOPPED",
            nextRestartAt: new Date(now.getTime() - 1_000),
          }),
        );
        distributePrefix(id, i);
      }
      store.failOwners.add("u-failing");
      // The target has a stop of its previous run still out: its restart waits RETAKE_RETRY_MS
      // (the observable that the sweep reached it, without the planner).
      store.instances.push(
        instance("inst", { phase: "STOPPED", nextRestartAt: new Date(now.getTime() - 1_000) }),
      );
      addStop("inst", 1, 1, "RUNNING");
      const lc = engine();
      await lc.stop();
      const sweep = lc as unknown as { restartDue(): Promise<void> };
      for (let pass = 0; pass < 3; pass++) await sweep.restartDue();
      expect((main().nextRestartAt as Date).getTime()).toBeGreaterThan(now.getTime());
      errors = [];
    },
    120_000,
  );

  it.each([255, 256])(
    "pruneHealth: finished probes are pruned behind %i whose owner's writes keep failing",
    async (count) => {
      for (let i = 0; i < count; i++) {
        const id = prefixId("prune", i);
        store.instances.push(instance(id, { userId: "u-failing", phase: "READY" }));
        distributePrefix(id, i);
      }
      store.instances.push(instance("inst", { phase: "READY" }));
      const old = new Date(now.getTime() - 2 * 3_600_000);
      for (const row of store.instances)
        store.steps.push({
          id: `${row.id}-health`,
          instanceId: row.id,
          nodeId: row.Ranks[0]?.nodeId,
          rank: 0,
          phase: "HEALTH",
          sequence: 5_000,
          generation: 1,
          state: "SUCCEEDED",
          attempts: 1,
          createdAt: old,
          updatedAt: old,
        });
      store.failOwners.add("u-failing");
      const lc = engine();
      await lc.stop();
      const sweep = lc as unknown as { pruneHealth(): Promise<void> };
      for (let pass = 0; pass < 3; pass++) await sweep.pruneHealth();
      expect(store.steps.some((step) => step.id === "inst-health")).toBe(false);
      errors = [];
    },
    120_000,
  );
});

// ── Legacy bootstrap through offline and recovery (DP-2 / DC1-legacy, C4C) ──

describe("a legacy committed restart survives offline and recovery (DP-2, C4C)", () => {
  it.each([false, true])(
    "offline before the run was first resolved (pre-resolved control=%s): back as STARTING in run 2",
    async (preResolved) => {
      store.instances = [instance("inst", { runGeneration: 0, operationId: "op-B" })];
      addGeneration(
        "inst",
        1,
        { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } },
        "v1",
        "op-A",
      );
      store.skipPrepare = true;
      if (preResolved) expect(await resolveRun(db as never, "inst")).toBe(2);
      const lc = engine();
      const head = store.nodes.find((node) => node.id === "head");
      if (!head) throw new Error("no head");
      head.online = false;
      await lc.runOnce();
      expect(main().phase).toBe("UNAVAILABLE");
      // Persisted before the phase changed.
      expect(main().runGeneration).toBe(2);
      head.online = true;
      await lc.runOnce();
      await lc.stop();
      expect(main()).toMatchObject({ phase: "STARTING", runGeneration: 2 });
    },
  );

  it("an upgrade with an already UNAVAILABLE unprepared restart keeps that restart", async () => {
    store.instances = [
      instance("inst", { phase: "UNAVAILABLE", runGeneration: 0, operationId: "op-B" }),
    ];
    addGeneration(
      "inst",
      1,
      { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } },
      "v1",
      "op-A",
    );
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(main()).toMatchObject({ phase: "STARTING", runGeneration: 2 });
  });

  it("inverse: a legacy UNAVAILABLE row of a prepared run recovers READY at its run", async () => {
    store.instances = [
      instance("inst", { phase: "UNAVAILABLE", runGeneration: 0, operationId: "op-A" }),
    ];
    addGeneration(
      "inst",
      1,
      { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } },
      "v1",
      "op-A",
    );
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    expect(main()).toMatchObject({ phase: "READY", runGeneration: 1 });
  });
});

// ── Inventory classification fails closed (R4-B-3 / DC4 error path, C4C) ──

describe("inventory classification fails closed (R4-B-3)", () => {
  it("a record whose classification failed refuses the snapshot: nothing is acknowledged as applied", async () => {
    store.instances = [instance("inst", { phase: "READY", runGeneration: 2 })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    addGeneration("inst", 2, {
      STOP: { state: "SUCCEEDED" },
      START: { state: "SUCCEEDED" },
      READINESS: { state: "SUCCEEDED" },
    });
    store.failOwners.add("u1");
    const answer = await inventory([inventoryRecord("inst", "stopped", "inst-g1-READINESS")]);
    store.failOwners.clear();
    expect(errors.map((entry) => entry[0])).toEqual(["[lifecycle] applying inventory failed"]);
    errors = [];
    // Refused: the relay keeps what it served (runtime.inventory.error), the run is untouched.
    expect(answer.ok).toBe(false);
    expect(main().phase).toBe("READY");
    expect(rank().claim).toBe("HELD");
    // Control: classified, the same stale record is reported stale and acknowledged.
    const classified = await inventory([inventoryRecord("inst", "stopped", "inst-g1-READINESS")]);
    expect(classified).toEqual({ ok: true, stale: [main().handle] });
  });
});

// ── A gang whose head node was deleted (finding 6): its stops name the launch's head address ──

describe("a gang's stops after its head node was deleted", () => {
  const gang = launchOf({ groupSize: 2, reservations: [] });
  const RANK1 = { ...RANK0, rank: 1 };

  /** A 2-rank instance stopping after its head's node was deleted; run 1 launched both ranks. */
  function headless(headAddr: string | null) {
    store.versions = [{ ...(store.versions[0] as Row), spec: { launch: gang } }];
    const item = instance("inst", {
      phase: "STOPPING",
      desiredState: "STOPPED",
      fabricId: "fabric-1",
      Reservations: [],
    });
    const head = { ...(item.Ranks[0] as Rank), nodeId: null, claim: "RELEASED", stoppedAt: now };
    const worker = { ...head, id: "rank-worker", rank: 1, nodeId: "w1", claim: "HELD" };
    item.Ranks = [head, worker];
    store.instances = [item];
    for (const step of generationSteps({
      instance: { ...INPUT("inst"), fabricId: "fabric-1" },
      ranks: [RANK0, RANK1],
      launch: gang,
      generation: 1,
      operationId: "op-inst",
    }))
      store.steps.push({
        ...step,
        id: `old-${step.phase}-${step.rank}`,
        instanceId: "inst",
        nodeId: step.rank === 0 ? "head" : "w1",
        state: "SUCCEEDED",
        attempts: 1,
        errorCode: null,
        // What dispatch records on a multi-node launch (null: dispatched before it did).
        headAddr: step.phase === "READINESS" ? null : headAddr,
        createdAt: now,
        updatedAt: now,
        operatorTerminalId: null,
        operatorSince: null,
        operatorAcceptedAt: null,
        operatorHold: null,
      });
  }

  it("stops the surviving worker with the head address its launch was sent with", async () => {
    headless("10.0.0.1");
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    const stops = framesTo("stop").filter((entry) => entry.nodeId === "w1");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.frame).toMatchObject({
      placeholders: expect.objectContaining({ head_addr: "10.0.0.1" }),
    });
    const stored = store.steps.find((step) => step.phase === "STOP" && step.state !== "SUCCEEDED");
    expect(stored).toMatchObject({ rank: 1, headAddr: "10.0.0.1", state: "RUNNING" });
  });

  it("a launch recorded without its head address cannot be stopped: a person marks it stopped", async () => {
    headless(null);
    const lc = engine();
    // Every stop and status probe fails locally (no head address): retried, then given up on.
    for (let tick = 0; tick < 12; tick++) {
      await lc.runOnce();
      setNow(new Date(now.getTime() + 10 * 60_000));
    }
    await lc.stop();
    expect(framesTo("stop")).toEqual([]);
    expect(
      store.steps.filter((step) => step.phase === "STOP" && step.errorCode === "bad_job").length,
    ).toBeGreaterThan(0);
    expect(main("inst").needsOperator).toBe("MARK_STOPPED");
  });

  it("a multi-node START records the head address it is dispatched with", async () => {
    store.fabricIps.set("head", "10.0.0.1");
    store.versions = [{ ...(store.versions[0] as Row), spec: { launch: gang } }];
    const item = instance("inst", { fabricId: "fabric-1", Reservations: [] });
    item.Ranks = [
      item.Ranks[0] as Rank,
      { ...(item.Ranks[0] as Rank), id: "rank-worker", rank: 1, nodeId: "w1", port: 30001 },
    ];
    store.instances = [item];
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    const starts = store.steps.filter((step) => step.phase === "START" && step.attempts === 1);
    expect(starts.map((step) => [step.rank, step.headAddr])).toEqual([
      [0, "10.0.0.1"],
      [1, "10.0.0.1"],
    ]);
  });
});

// ── A restart's old rank claim holds until the new run's START is claimed (finding 1) ──

describe("a restart keeps the old run's rank claim until its stop is proven", () => {
  it("keeps the replaced port and resources as prev* until the new run's START is claimed", async () => {
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    await restart("inst", { port: 30005 });
    expect(rank()).toMatchObject({
      port: 30005,
      prevPort: 30000,
      prevResources: GB100,
      prevGeneration: 1,
      plannedGeneration: 1,
    });
    const lc = engine();
    await lc.runOnce();
    // The leading stop goes out; nothing of the old claim is dropped before it succeeded.
    expect(rank().prevPort).toBe(30000);
    await lc.handleJobResult(REF, ok(lastFrame("stop")));
    await lc.runOnce();
    await lc.stop();
    expect(lastFrame("start")).toMatchObject({ generation: 2 });
    expect(rank()).toMatchObject({ prevPort: null, prevGeneration: null, prevDistPort: null });
    expect(rank().prevResources).toBe(DbNull);
  });
});

describe("Group C: operator recovery and delivery order", () => {
  it("an already-claimed stop of an earlier run is not delivered after the successor's START, and releases nothing", async () => {
    store.instances = [instance("inst", { phase: "STOPPING", desiredState: "STOPPED" })];
    addGeneration("inst", 1, { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } });
    const a = engine();
    store.afterClaim = async () => {
      await restart();
      const b = engine();
      await b.runOnce();
      const leading = lastFrame("stop");
      expect(leading.generation).toBe(2);
      await b.handleJobResult(REF, ok(leading));
      await b.runOnce();
      await b.stop();
      expect(lastFrame("start").generation).toBe(2);
    };
    await a.runOnce();
    await a.stop();
    const startIndex = sent.findIndex(
      (entry) => entry.frame.phase === "start" && entry.frame.generation === 2,
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(sent.slice(startIndex + 1).filter((entry) => entry.frame.generation === 1)).toEqual([]);
    // The undelivered stop went back and its run gate ended it: the successor's claim holds.
    const c = engine();
    await c.runOnce();
    await c.stop();
    expect(rank().claim).toBe("HELD");
    expect(
      stepsOf().filter(
        (step) => step.generation === 1 && step.phase === "STOP" && step.state === "RUNNING",
      ),
    ).toEqual([]);
  });

  it("a lost awaiting_operator write does not lose the person's accepted run", async () => {
    store.versions[0] = { ...(store.versions[0] as Row), spec: { launch: interactiveLaunch } };
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    const start = lastFrame("start");
    const terminalId = (start.operator as { terminalId: string }).terminalId;
    store.failOwners.add("u1");
    await expect(
      lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId })),
    ).rejects.toThrow();
    store.failOwners.clear();
    await lc.handleJobResult(REF, result(start, { status: "operator_running", terminalId }));
    // Recorded as accepted, with the screen's time (the CHECK holds).
    expect(stepById(start.stepId)).toMatchObject({ state: "RUNNING" });
    expect(stepById(start.stepId).operatorAcceptedAt).not.toBeNull();
    expect(stepById(start.stepId).operatorSince).not.toBeNull();
    closeAnswer = "running";
    setNow(new Date(now.getTime() + 86_400_000));
    await lc.runOnce();
    await lc.stop();
    expect(errors).toEqual([]);
    expect(main().needsOperator).toBe("STEP");
  });

  it("the deadline sweep records a run the relay saw accepted after a lost screen write", async () => {
    store.versions[0] = { ...(store.versions[0] as Row), spec: { launch: interactiveLaunch } };
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    const start = lastFrame("start");
    const terminalId = (start.operator as { terminalId: string }).terminalId;
    store.failOwners.add("u1");
    await expect(
      lc.handleJobResult(REF, result(start, { status: "awaiting_operator", terminalId })),
    ).rejects.toThrow();
    store.failOwners.clear();
    // operator_running never arrives here; the relay holds the person's run.
    closeAnswer = "running";
    setNow(new Date(now.getTime() + 3_600_000));
    await lc.runOnce();
    expect(errors).toEqual([]);
    const step = stepById(start.stepId);
    expect(step.state).toBe("RUNNING");
    expect(step.operatorAcceptedAt).not.toBeNull();
    expect(step.operatorSince).not.toBeNull();
    // Past its timeout the person is asked to look at it.
    setNow(new Date(now.getTime() + 86_400_000));
    await lc.runOnce();
    await lc.stop();
    expect(errors).toEqual([]);
    expect(main().needsOperator).toBe("STEP");
  });

  it("a stop of a recorded launch reads that launch's version only from the instance's owner", async () => {
    // A recorded intent naming a version of another owner (never written by the server, but
    // the lookup must not trust it): its interactive stop is not used.
    store.versions[1] = {
      ...(store.versions[1] as Row),
      ownerId: "u2",
      spec: {
        launch: launchOf({
          commands: [
            {
              start: "other up",
              stop: "other down",
              status: "other status",
              interactive: { stop: true },
            },
          ],
        }),
      },
    };
    store.instances = [instance("inst", { phase: "READY" })];
    addGeneration(
      "inst",
      1,
      { START: { state: "SUCCEEDED" }, READINESS: { state: "SUCCEEDED" } },
      "v2",
    );
    await restart();
    const lc = engine();
    await lc.runOnce();
    await lc.stop();
    const stop = lastFrame("stop");
    expect(stop.generation).toBe(2);
    expect(stop.operator).toBeUndefined();
  });
});

describe("an attempt that may have run is never erased by a later refusal", () => {
  it("a replay refused before admission keeps the claim and stops what the lost dispatch started", async () => {
    store.instances = [instance("inst")];
    const lc = engine();
    await lc.runOnce();
    const first = lastFrame("start");
    expect(stepById(first.stepId).attempts).toBe(1);
    // The first dispatch may have launched a persistent service before its session was lost.
    await lc.nodeDisconnected(REF);
    expect(stepById(first.stepId)).toMatchObject({
      state: "PENDING",
      attempts: 1,
      mayHaveRun: true,
    });
    await lc.runOnce();
    const replay = lastFrame("start");
    expect(replay.stepId).toBe(first.stepId);
    expect(stepById(replay.stepId).attempts).toBe(2);
    // The node refuses the replay before admission (a port-range edit makes it a bad job): that
    // proves only the replay never ran.
    await lc.handleJobResult(REF, result(replay, { status: "failed", error: "bad_job" }));
    expect(stepById(replay.stepId)).toMatchObject({
      state: "FAILED",
      errorCode: "bad_job",
      mayHaveRun: true,
    });
    await lc.runOnce();
    await lc.runOnce();
    await lc.stop();
    // Held (its reservations with it: they hold while a rank does).
    expect(main().Ranks.map((row) => row.claim)).toEqual(["HELD"]);
    // The gang stop goes out, naming the launch the lost dispatch may have started.
    const stop = lastFrame("stop");
    expect(stop).toMatchObject({ instanceId: "inst", rank: 0 });
  });
});
