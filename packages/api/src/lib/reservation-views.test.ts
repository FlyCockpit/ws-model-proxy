import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: { DbNull: null } }));

import { type NodeDetailRow, toNodeDetail, toNodeSummary } from "../nodes/views";
import { loadPlacementInstances } from "./placement-load";
import { launchIdentity } from "./reservations";
import { RUNTIME_PRESET_LIST } from "./runtime-presets";
import { runtimeSpecSchema } from "./runtime-spec";
import { type PlannedStartWrite, type Tx, writePlannedStarts } from "./runtime-store";
import {
  INSTANCE_INCLUDE,
  type InstanceRow,
  instanceView,
  previousLaunchHashes,
  versionSummary,
} from "./runtime-views";

// Reservations (`launch.reservations`) as the placement loader and the node views read them:
// they hold exactly while the instance's rank does.

const NOW = new Date("2026-10-20T00:00:00Z");
const GB100 = { kind: "unified", memoryGb: 100 };

function instanceRow(rankClaim: "HELD" | "HELD_UNKNOWN" | null) {
  return {
    id: "inst-ds",
    userId: "u1",
    runtimeId: "rt-ds",
    desiredState: "RUNNING",
    Runtime: { kind: "STARTABLE", Models: [] },
    LaunchVersion: { spec: {} },
    // The loader reads only ranks that are not RELEASED.
    Ranks:
      rankClaim === null
        ? []
        : [{ nodeId: "head", port: 30000, distPort: null, resources: GB100, claim: rankClaim }],
    Reservations: [{ nodeId: "w1", resources: GB100 }],
  };
}

function loaderDb(rows: unknown[]) {
  const findMany = vi.fn(async () => rows);
  return { db: { runtimeInstance: { findMany } } as unknown as Tx, findMany };
}

describe("loadPlacementInstances", () => {
  it("loads a holding instance's reservations as claims without a port", async () => {
    const { db, findMany } = loaderDb([instanceRow("HELD")]);
    const [instance] = await loadPlacementInstances(db, ["w1"]);
    expect(instance?.ranks).toEqual([
      { nodeId: "head", port: 30000, distPort: null, resources: GB100, claim: "HELD" },
      { nodeId: "w1", port: 0, distPort: null, resources: GB100, claim: "HELD", reservation: true },
    ]);
    // Instances are found by a reservation on these nodes too, only while a rank holds.
    const where = JSON.stringify(findMany.mock.calls[0]);
    expect(where).toContain('"Reservations":{"some":{"nodeId":{"in":["w1"]}}}');
    expect(where).toContain('"Ranks":{"some":{"claim":{"not":"RELEASED"}}}');
  });

  it("a marked-stopped rank keeps its reservations counted as HELD_UNKNOWN", async () => {
    const { db } = loaderDb([instanceRow("HELD_UNKNOWN")]);
    const [instance] = await loadPlacementInstances(db, ["w1"]);
    expect(instance?.ranks.map((rank) => rank.claim)).toEqual(["HELD_UNKNOWN", "HELD_UNKNOWN"]);
  });

  it("an interactive stop is the stop of the launch that may still run, else the current version's", async () => {
    const preset = RUNTIME_PRESET_LIST.find((item) => item.spec.launch?.management === "service");
    const launch = preset?.spec.launch;
    const first = launch?.commands[0];
    if (!preset || !launch || !first) throw new Error("no service preset");
    const spec = (interactive: boolean) => ({
      ...preset.spec,
      launch: {
        ...launch,
        commands: [
          { ...first, stop: "halt", ...(interactive ? { interactive: { stop: true } } : {}) },
        ],
      },
    });
    for (const interactive of [true, false])
      expect(runtimeSpecSchema.safeParse(spec(interactive)).success).toBe(true);
    const row = (current: boolean) => ({
      ...instanceRow("HELD"),
      LaunchVersion: { spec: spec(current) },
      Ranks: [{ ...instanceRow("HELD").Ranks[0], rank: 0 }],
    });
    const load = async (current: boolean, earlier?: boolean) => {
      const { db } = loaderDb([row(current)]);
      const launched =
        earlier === undefined ? undefined : new Map([["inst-ds", new Map([[0, spec(earlier)]])]]);
      const [instance] = await loadPlacementInstances(db, ["w1"], launched);
      return instance?.interactiveStop;
    };
    // Restarted from an interactive v1 onto a non-interactive v2 that has not launched: the
    // stop runs v1's, a person's.
    expect(await load(false, true)).toBe(true);
    // And the other way round: v1 still runs, its stop needs nobody.
    expect(await load(true, false)).toBe(false);
    // Nothing launched of another version: the current version's.
    expect(await load(true)).toBe(true);
    expect(await load(false)).toBe(false);
  });

  it("drops reservations once the rank released its claim", async () => {
    const { db } = loaderDb([instanceRow(null)]);
    const [instance] = await loadPlacementInstances(db, ["w1"]);
    expect(instance?.ranks).toEqual([]);
  });
});

function nodeRow(reservationRanks: Array<{ claim: "HELD" | "RELEASED" | "HELD_UNKNOWN" }>) {
  const row = {
    id: "w1",
    slug: "w1",
    name: null,
    connection: "ONLINE",
    lastHeartbeatAt: NOW,
    cliVersion: "0.4.0",
    rejectedProtocolVersion: null,
    trust: "FULL",
    trustChangedAt: null,
    trustLowerRequestedAt: null,
    trustLowerRequestedBy: null,
    userId: "u1",
    User: { name: "Owner" },
    labels: ["ds-worker"],
    declaredResources: { kind: "unified", memoryGb: 128 },
    declaredResourcesBy: "USER",
    nodeInfo: null,
    nodeMetrics: null,
    nodeMetricsAt: null,
    holdAt: null,
    holdNote: null,
    holdProfileId: null,
    removeAfterOfflineMs: null,
    Ranks: [],
    Reservations: [
      {
        index: 0,
        instanceId: "inst-ds",
        resources: GB100,
        supersededGeneration: null,
        Instance: {
          id: "inst-ds",
          runtimeId: "rt-ds",
          phase: "READY",
          needsOperator: null,
          Runtime: { slug: "ds41f-tp3" },
          Ranks: reservationRanks,
          _count: { Reservations: 2 },
        },
      },
    ],
    _count: { Runtimes: 0, QueuedCommands: 0 },
    hostname: null,
    features: null,
    heldDefinitions: [],
    portStart: 30000,
    portEnd: 30009,
    metricCommands: [],
    metricCommandsHash: null,
    heldMetricCommandsHash: null,
    fabricsHash: null,
    heldFabricsHash: null,
    commandMaxMs: 60000,
    detectedServers: null,
    detectedServersAt: null,
    FabricMembers: [],
    QueuedCommands: [],
  };
  return row as unknown as NodeDetailRow;
}

const CONTEXT = {
  currentVersionByRuntime: new Map(),
  alwaysOnByBaseUrl: new Map(),
  otherNodes: [],
};

describe("node views", () => {
  it("the summary (and list) count held reservations as reserved memory", () => {
    const row = nodeRow([{ claim: "HELD" }]);
    const summary = toNodeSummary(
      { ...row, Reservations: row.Reservations.map((r) => ({ resources: r.resources })) },
      NOW,
    );
    expect(summary.reservedNowMemoryGb).toBe(100);
    // A reservation is not an instance running here.
    expect(summary.runningInstances).toBe(0);
  });

  it("the detail lists the reservation with its role and counts it while the rank holds", () => {
    const detail = toNodeDetail(nodeRow([{ claim: "HELD" }]), CONTEXT, NOW);
    expect(detail.instances).toEqual([
      {
        instanceId: "inst-ds",
        runtimeId: "rt-ds",
        runtimeSlug: "ds41f-tp3",
        nodeNumber: 1,
        nodeCount: 2,
        phase: "READY",
        reserved: "HELD",
        needsOperator: null,
        role: "reservation",
      },
    ]);
    expect(detail.hardware.reservedNowMemoryGb).toBe(100);
    expect(detail.reservedNowMemoryGb).toBe(100);
  });

  it("a restart's superseded row beside the current one is one entry, counted once (the larger)", () => {
    const row = nodeRow([{ claim: "HELD" }]);
    const [current] = row.Reservations;
    if (!current) throw new Error("no reservation");
    // A shrunk reservation on the same node: the old run's 100 GiB (superseded) and the new
    // plan's 20 GiB, both rows of entry 0 of one instance.
    row.Reservations = [
      { ...current, supersededGeneration: 1 },
      { ...current, resources: { kind: "unified", memoryGb: 20 }, supersededGeneration: null },
    ];
    const detail = toNodeDetail(row, CONTEXT, NOW);
    expect(detail.instances).toHaveLength(1);
    expect(detail.instances[0]).toMatchObject({ instanceId: "inst-ds", role: "reservation" });
    // The old run's 100 GiB and the new plan's 20 overlap (they never run at once): max, not sum.
    expect(detail.hardware.reservedNowMemoryGb).toBe(100);
    expect(detail.reservedNowMemoryGb).toBe(100);
  });

  it("a restarted rank's old claim (prev*) and its new one count once (the larger)", () => {
    const row = nodeRow([{ claim: "HELD" }]);
    const rank = (claim: "HELD" | "RELEASED") => ({
      rank: 0,
      claim,
      resources: { kind: "unified", memoryGb: 20 },
      prevResources: claim === "HELD" ? { kind: "unified", memoryGb: 60 } : null,
      prevPort: claim === "HELD" ? 30000 : null,
      Instance: {
        id: "inst-rank",
        runtimeId: "rt-rank",
        phase: "STARTING",
        needsOperator: null,
        Runtime: { slug: "qwen" },
        _count: { Ranks: 1 },
      },
    });
    row.Ranks = [rank("HELD")];
    // The reservation's 100 GiB (another instance) adds; the rank holds max(20, 60).
    expect(toNodeDetail(row, CONTEXT, NOW).hardware.reservedNowMemoryGb).toBe(160);
    row.Ranks = [rank("RELEASED")];
    expect(toNodeDetail(row, CONTEXT, NOW).hardware.reservedNowMemoryGb).toBe(100);
  });

  it("a released rank releases its reservations in the views", () => {
    const detail = toNodeDetail(nodeRow([{ claim: "RELEASED" }]), CONTEXT, NOW);
    expect(detail.instances[0]?.reserved).toBe("RELEASED");
    expect(detail.hardware.reservedNowMemoryGb).toBe(0);
  });
});

function writerDb() {
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method === "string"
            ? async (args: unknown) => {
                calls.push({ model: name, method, args });
                return method.endsWith("Many") ? { count: 0 } : {};
              }
            : undefined,
      },
    );
  const db = new Proxy({}, { get: (_target, name) => model(String(name)) }) as unknown as Tx;
  return { db, calls };
}

const START: PlannedStartWrite = {
  runtimeId: "rt-ds",
  versionId: "v2",
  instanceId: null,
  placements: [{ nodeId: "head", nodeNumber: 1, port: 30000, resources: GB100 }],
  reservations: [{ index: 0, nodeId: "w1", labels: ["ds-worker"], resources: GB100 }],
  fabric: null,
  distPort: null,
};

describe("writePlannedStarts", () => {
  const input = { userId: "u1", operationId: "op", startedBy: "USER" as const, blockedBy: [[]] };

  it("takes a new instance's reservations in the same write as its rank", async () => {
    const { db, calls } = writerDb();
    await writePlannedStarts(db, { ...input, starts: [START] });
    const create = calls.find(
      (call) => call.model === "runtimeInstance" && call.method === "create",
    );
    const data = (create?.args as { data: Record<string, { create: unknown }> } | undefined)?.data;
    expect(data?.Ranks?.create).toHaveLength(1);
    expect(data?.Reservations?.create).toEqual([
      { nodeId: "w1", index: 0, labels: ["ds-worker"], resources: GB100 },
    ]);
  });

  // A restart's reservation handoff (superseded rows held until the old run stopped):
  // reservation-supersede.test.ts.
});

describe("a version's launchChanged counts reservations (server-only, not in the launch hash)", () => {
  const HASH = "a".repeat(64);
  // A service-managed launcher (the shape runtime-spec-reservations.test.ts parses).
  const launchOf = (reservations?: unknown[]) => ({
    launch: {
      management: "service",
      groupSize: 1,
      resources: [GB100],
      labels: ["ds-head"],
      ...(reservations ? { reservations } : {}),
      commands: [{ start: "launcher up", stop: "launcher down", status: "launcher status" }],
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
    },
  });
  const version = (number: number, spec: unknown) =>
    ({
      id: `v${number}`,
      version: number,
      createdAt: NOW,
      editor: "USER",
      editorUserId: "u1",
      agentTokenId: null,
      note: null,
      launchHash: HASH,
      spec,
    }) as unknown as Parameters<typeof versionSummary>[0];
  const workers = [{ labels: ["ds-worker"], resources: GB100 }];

  it("a reservation-only edit (same launch hash) does not apply live", () => {
    const rows = [version(1, launchOf()), version(2, launchOf(workers))];
    const previous = previousLaunchHashes(rows);
    expect(versionSummary(rows[1] as never, previous.get(2) ?? null).launchChanged).toBe(true);
    // And back: removing them needs a restart too.
    const back = [...rows, version(3, launchOf())];
    expect(
      versionSummary(back[2] as never, previousLaunchHashes(back).get(3) ?? null).launchChanged,
    ).toBe(true);
  });

  it("other edits with the same launch hash and reservations still apply live", () => {
    const rows = [version(1, launchOf(workers)), version(2, launchOf(workers))];
    expect(
      versionSummary(rows[1] as never, previousLaunchHashes(rows).get(2) ?? null).launchChanged,
    ).toBe(false);
    // Without reservations the identity is the launch hash itself (unchanged for old versions).
    expect(launchIdentity({ launchHash: HASH, spec: launchOf() })).toBe(HASH);
    expect(launchIdentity({ launchHash: HASH, spec: launchOf([]) })).toBe(HASH);
  });
});

describe("the instance view shows everything a recovery releases", () => {
  // After a restart moved the reservation (100 GiB on old-worker → 20 GiB on new-worker) and
  // changed the rank's port, the replaced run's worker and port keep holding until its stop is
  // proven: a person marking stopped or releasing must see them too.
  const rows = [
    {
      index: 0,
      nodeId: "old-worker",
      Node: null,
      labels: ["worker"],
      resources: { kind: "unified", memoryGb: 100 },
      supersededGeneration: 1,
    },
    {
      index: 0,
      nodeId: "new-worker",
      Node: null,
      labels: ["worker"],
      resources: { kind: "unified", memoryGb: 20 },
      supersededGeneration: null,
    },
  ];
  function view(claim: "HELD" | "HELD_UNKNOWN" | "RELEASED") {
    // Apply the exported include's row filter, as Prisma does for runtimes.get.
    const where: unknown = Reflect.get(INSTANCE_INCLUDE.Reservations, "where");
    const selected = rows.filter(
      (row) =>
        typeof where !== "object" ||
        where === null ||
        Object.entries(where).every(([key, value]) => Reflect.get(row, key) === value),
    );
    const row = {
      id: "inst",
      runtimeId: "rt",
      handle: "i-abcdefabcdef",
      versionId: "v2",
      launchVersionId: "v2",
      desiredState: "STOPPED",
      phase: "STOPPING",
      phaseReason: null,
      phaseChangedAt: NOW,
      healthDetail: null,
      needsOperator: "MARK_STOPPED",
      startedBy: "USER",
      restartsInWindow: 0,
      nextRestartAt: null,
      engineSlots: null,
      factsAt: null,
      Version: { advanced: {}, version: 2 },
      LaunchVersion: { spec: {}, launchHash: "a".repeat(64), editor: "USER" },
      Fabric: null,
      Ranks: [
        {
          rank: 0,
          nodeId: "head",
          Node: null,
          claim,
          port: 30005,
          unitName: "wsmp-i-abcdefabcdef-r0",
          prevPort: claim === "RELEASED" ? null : 30000,
          prevDistPort: null,
          prevResources: claim === "RELEASED" ? null : { kind: "unified", memoryGb: 64 },
          releasedUnprovenAt: null,
          ReleaseRequests: [],
        },
      ],
      Reservations: selected,
      Steps: [],
    };
    return instanceView(row as unknown as InstanceRow);
  }

  it("lists a replaced run's worker beside the current one, and the rank's previous claim", () => {
    const shown = view("HELD_UNKNOWN");
    expect(shown.reservations.map((row) => row.nodeId)).toEqual(["new-worker"]);
    expect(shown.supersededReservations).toEqual([
      expect.objectContaining({ nodeId: "old-worker", memoryGb: 100, reserved: "HELD_UNKNOWN" }),
    ]);
    expect(shown.ranks[0]?.previousClaim).toEqual({
      port: 30000,
      distPort: null,
      memoryGb: 64,
      gpus: [],
    });
  });

  it("a released claim holds nothing of the replaced run", () => {
    const shown = view("RELEASED");
    expect(shown.supersededReservations).toEqual([]);
    expect(shown.ranks[0]?.previousClaim).toBeNull();
  });
});
