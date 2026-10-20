import { beforeEach, describe, expect, it, vi } from "vitest";

// A single-node instance with a reservation (`launch.reservations`) on another node: the
// engine's live watch on a mocked Prisma. The reservation node going offline makes the instance
// UNAVAILABLE and stops it after unavailableStopMs, like a group member; coming back first
// recovers it. Nothing is ever sent to the reservation node.

type Call = { model: string; method: string; args: unknown };

const store = vi.hoisted(() => ({
  calls: [] as Call[],
  online: new Map<string, boolean>(),
  instance: null as Record<string, unknown> | null,
}));

const db = vi.hoisted(() => {
  const empty = (method: string) => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method === "aggregate") return { _max: { sequence: null } };
    if (method.endsWith("Many")) return { count: 0 };
    return null;
  };
  const answer = (model: string, method: string, args: unknown): unknown => {
    const where = (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    const instance = store.instance;
    if (model === "runtimeInstance" && instance) {
      if (method === "findMany" && where.desiredState === "RUNNING" && where.phase)
        return [{ id: instance.id, userId: instance.userId }];
      if (method === "findUnique" || method === "findUniqueOrThrow") return { ...instance };
      if (method === "update") {
        Object.assign(instance, (args as { data: Record<string, unknown> }).data);
        return { ...instance };
      }
    }
    if (model === "node" && method === "findMany") {
      const ids = ((where.id as { in?: string[] } | undefined)?.in ?? []) as string[];
      return ids.map((id) => ({
        id,
        connection: store.online.get(id) ? "ONLINE" : "OFFLINE",
        lastDisconnectedAt: store.online.get(id) ? null : new Date(0),
        lastHeartbeatAt: store.online.get(id) ? new Date(8_000_000_000_000) : null,
      }));
    }
    return empty(method);
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, key) =>
          typeof key === "string"
            ? async (args: unknown) => {
                store.calls.push({ model: name, method: key, args });
                return answer(name, key, args);
              }
            : undefined,
      },
    );
  const models: Record<string, unknown> = {};
  return new Proxy(models, {
    get: (target, key) => {
      if (typeof key !== "string") return Reflect.get(target, key);
      if (key === "$transaction")
        return async (work: (tx: unknown) => Promise<unknown>) => work(db);
      models[key] ??= model(key);
      return models[key];
    },
  });
});

vi.mock("@ws-model-proxy/db", () => ({ default: db }));
vi.mock("@ws-model-proxy/db/user-deletion-access", () => ({
  userCredentialAccessBlocked: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/api/lib/graph-write", () => ({
  graphWrite: vi.fn(async (_owners: Iterable<string>, work: (tx: unknown) => Promise<unknown>) =>
    work(db),
  ),
  instanceCapacityFences: vi.fn(async (ids: string[]) => ({ instanceId: ids[0] })),
}));

const { RuntimeLifecycle } = await import("./lifecycle.js");

const STOP_AFTER_MS = 60_000;
// Well past the engine's startup grace (measured from the real clock).
let clock = new Date(Date.now() + 3_600_000);
const sent: Array<{ nodeId: string; frame: unknown }> = [];

function engine() {
  return new RuntimeLifecycle(
    {
      sendToNode: (nodeId: string, frame: unknown) => {
        sent.push({ nodeId, frame });
        return true;
      },
      nodeSession: () => ({ userId: "u1", connectionGeneration: 1, trust: "full" }),
      onlineNodeIds: () => [...store.online].filter(([, up]) => up).map(([id]) => id),
    } as unknown as ConstructorParameters<typeof RuntimeLifecycle>[0],
    { now: () => clock },
  );
}

function seed(overrides: Record<string, unknown> = {}) {
  store.instance = {
    id: "inst-ds",
    userId: "u1",
    runtimeId: "rt-ds",
    handle: "i-ds",
    versionId: "v1",
    launchVersionId: "v1",
    operationId: null,
    fabricId: null,
    desiredState: "RUNNING",
    phase: "READY",
    phaseReason: null,
    phaseChangedAt: new Date(clock.getTime() - 1_000),
    unavailableSince: null,
    unhealthySince: null,
    lastHealthAt: clock,
    needsOperator: null,
    Ranks: [
      {
        id: "rank-0",
        instanceId: "inst-ds",
        nodeId: "head",
        rank: 0,
        port: 30000,
        distPort: null,
        claim: "HELD",
        blockedBy: [],
        resources: { kind: "unified", memoryGb: 100 },
      },
    ],
    Reservations: [{ nodeId: "w1" }],
    LaunchVersion: {
      spec: {},
      launchHash: "h".repeat(64),
      advanced: { unavailableStopMs: STOP_AFTER_MS },
      editor: "USER",
    },
    ...overrides,
  };
}

function instanceUpdates(): Array<Record<string, unknown>> {
  return store.calls
    .filter((call) => call.model === "runtimeInstance" && call.method === "update")
    .map((call) => (call.args as { data: Record<string, unknown> }).data);
}

beforeEach(() => {
  clock = new Date(Date.now() + 3_600_000);
  store.calls = [];
  sent.length = 0;
  store.online = new Map([
    ["head", true],
    ["w1", true],
  ]);
  seed();
});

describe("a reservation node in the live watch", () => {
  it("leaves a healthy instance alone while both nodes are online", async () => {
    await engine().runOnce();
    expect(instanceUpdates().filter((data) => data.phase)).toEqual([]);
  });

  it("marks the instance UNAVAILABLE when the reservation node goes offline", async () => {
    store.online.set("w1", false);
    await engine().runOnce();
    expect(instanceUpdates()).toContainEqual(
      expect.objectContaining({ phase: "UNAVAILABLE", phaseReason: "node_offline" }),
    );
  });

  it("stops it once the reservation node stayed offline for unavailableStopMs", async () => {
    store.online.set("w1", false);
    const lc = engine();
    await lc.runOnce();
    // Not yet: only marked.
    expect(instanceUpdates().some((data) => data.phase === "STOPPING")).toBe(false);
    clock = new Date(clock.getTime() + STOP_AFTER_MS + 1_000);
    store.calls = [];
    await lc.runOnce();
    expect(instanceUpdates()).toContainEqual(
      expect.objectContaining({ phase: "STOPPING", phaseReason: "node_offline" }),
    );
    // Nothing is ever sent to the reservation node.
    expect(sent.map((entry) => entry.nodeId)).not.toContain("w1");
    const stepNodes = store.calls
      .filter((call) => call.model === "instanceStep" && call.method.startsWith("create"))
      .flatMap((call) => {
        const data = (call.args as { data: unknown }).data;
        return (Array.isArray(data) ? data : [data]).map(
          (row) => (row as { nodeId?: string }).nodeId,
        );
      });
    expect(stepNodes).not.toContain("w1");
  });

  it("recovers when the reservation node is back before the delay", async () => {
    store.online.set("w1", false);
    const lc = engine();
    await lc.runOnce();
    store.online.set("w1", true);
    store.calls = [];
    await lc.runOnce();
    expect(instanceUpdates()).toContainEqual(
      expect.objectContaining({ phase: "STARTING", phaseReason: null, unavailableSince: null }),
    );
    expect(instanceUpdates().some((data) => data.phase === "STOPPING")).toBe(false);
  });

  it("stops at once when the reservation node was deleted", async () => {
    seed({ Reservations: [{ nodeId: null }] });
    const lc = engine();
    await lc.runOnce();
    store.calls = [];
    await lc.runOnce();
    expect(instanceUpdates()).toContainEqual(
      expect.objectContaining({ phase: "STOPPING", phaseReason: "node_deleted" }),
    );
  });

  it("keeps today's behaviour without reservations: a lone offline head is not stopped", async () => {
    seed({ Reservations: [] });
    store.online.set("head", false);
    const lc = engine();
    await lc.runOnce();
    clock = new Date(clock.getTime() + STOP_AFTER_MS + 1_000);
    await lc.runOnce();
    expect(instanceUpdates().some((data) => data.phase === "UNAVAILABLE")).toBe(true);
    expect(instanceUpdates().some((data) => data.phase === "STOPPING")).toBe(false);
  });
});
