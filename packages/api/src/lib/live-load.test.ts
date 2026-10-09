import { describe, expect, it } from "vitest";
import { aggregateInstanceLoad, type InstanceLiveLoad, readLiveLoad } from "./live-load";
import { type MemberRow, memberLatencyKey, memberView } from "./pool-views";
import { type InstanceRow, instanceView } from "./runtime-views";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const STALE_MS = 15_000;

function reading(
  instanceId: string,
  overrides: Partial<{
    modelSlug: string | null;
    running: number;
    waiting: number;
    kvUsage: number;
    ageMs: number;
  }> = {},
) {
  const { ageMs = 1_000, ...rest } = overrides;
  return {
    instanceId,
    modelSlug: null,
    running: 2,
    receivedAt: new Date(NOW - ageMs),
    ...rest,
  };
}

describe("aggregateInstanceLoad", () => {
  it("reads only the wanted instances' fresh readings", () => {
    const result = aggregateInstanceLoad(
      [
        reading("a", { waiting: 3, kvUsage: 0.4 }),
        reading("b", { ageMs: STALE_MS + 1, waiting: 9 }),
        reading("other", { waiting: 5 }),
      ],
      new Set(["a", "b"]),
      NOW,
      STALE_MS,
    );
    expect([...result.keys()]).toEqual(["a"]);
    expect(result.get("a")).toEqual({
      running: 2,
      waiting: 3,
      kvUsage: 0.4,
      at: new Date(NOW - 1_000),
    });
  });

  it("lets the freshest engine-wide reading speak for the instance", () => {
    const result = aggregateInstanceLoad(
      [
        reading("a", { modelSlug: "m1", running: 7, waiting: 7 }),
        reading("a", { running: 1, waiting: 1, ageMs: 5_000 }),
        reading("a", { running: 4, waiting: 0, ageMs: 2_000 }),
      ],
      new Set(["a"]),
      NOW,
      STALE_MS,
    );
    expect(result.get("a")).toMatchObject({ running: 4, waiting: 0, kvUsage: null });
  });

  it("adds per-model readings up, KV the fullest model's, unreported fields null", () => {
    const result = aggregateInstanceLoad(
      [
        reading("a", { modelSlug: "m1", running: 1, kvUsage: 0.2 }),
        reading("a", { modelSlug: "m2", running: 2, kvUsage: 0.7, ageMs: 500 }),
      ],
      new Set(["a"]),
      NOW,
      STALE_MS,
    );
    expect(result.get("a")).toEqual({
      running: 3,
      waiting: null,
      kvUsage: 0.7,
      at: new Date(NOW - 500),
    });
  });
});

describe("readLiveLoad", () => {
  it("knows nothing without a reader, without ids, or when the reader fails", () => {
    expect(readLiveLoad(undefined, ["a"]).size).toBe(0);
    expect(
      readLiveLoad(() => {
        throw new Error("boom");
      }, ["a"]).size,
    ).toBe(0);
    let called = false;
    readLiveLoad(() => {
      called = true;
      return new Map();
    }, []);
    expect(called).toBe(false);
  });
});

const LOAD: InstanceLiveLoad = {
  running: 2,
  waiting: 5,
  kvUsage: 0.62,
  at: new Date("2026-10-08T11:59:59Z"),
};

function instanceRow(): InstanceRow {
  return {
    id: "inst1",
    runtimeId: "rt1",
    handle: "i-abcdefabcdef",
    versionId: "ver1",
    launchVersionId: "ver1",
    desiredState: "RUNNING",
    phase: "READY",
    phaseReason: null,
    phaseChangedAt: new Date("2026-10-08T11:00:00Z"),
    needsOperator: null,
    startedBy: "USER",
    restartsInWindow: 0,
    nextRestartAt: null,
    engineSlots: 8,
    factsAt: new Date("2026-10-08T11:30:00Z"),
    Ranks: [],
    Steps: [],
    Version: { version: 1, advanced: {} },
    LaunchVersion: { spec: {}, editor: "USER", launchHash: "a".repeat(64) },
    Fabric: null,
  } as unknown as InstanceRow;
}

describe("instanceView live load", () => {
  it("shows the relay's reading for the instance", () => {
    expect(instanceView(instanceRow(), new Map(), new Map([["inst1", LOAD]])).live).toEqual({
      running: 2,
      waiting: 5,
      kvUsage: 0.62,
      slots: 8,
      at: "2026-10-08T11:59:59.000Z",
    });
  });

  it("keeps load unknown (null, never 0) when this process holds no reading", () => {
    expect(instanceView(instanceRow()).live).toEqual({
      running: null,
      waiting: null,
      kvUsage: null,
      slots: 8,
      at: "2026-10-08T11:30:00.000Z",
    });
  });
});

function memberRow(
  instanceIds: string[],
  kind: "LOCAL" | "CLOUD" = "LOCAL",
  engineSlots: number | null = 4,
  shareId: string | null = null,
): MemberRow {
  return {
    id: "mem1",
    poolId: "pool1",
    kind,
    state: "ACTIVE",
    weight: 1,
    runtimeModelId: kind === "LOCAL" ? "rm1" : null,
    providerModelId: kind === "CLOUD" ? "pm1" : null,
    shareId,
    cloudOrder: kind === "CLOUD" ? 0 : null,
    Share: null,
    ProviderModel:
      kind === "CLOUD" ? { upstreamModelId: "gpt", Target: { health: "HEALTHY" } } : null,
    RuntimeModel:
      kind === "LOCAL"
        ? {
            upstreamModelId: "m",
            runtimeId: "rt1",
            retired: false,
            Runtime: {
              slug: "rt",
              nodeId: null,
              Node: null,
              Instances: instanceIds.map((id) => ({ id, phase: "READY", engineSlots, Ranks: [] })),
            },
            Targets: [],
          }
        : null,
  } as unknown as MemberRow;
}

describe("memberView live", () => {
  const key = memberLatencyKey("pool1", { runtimeId: "rt1" });
  const traffic = {
    p95: new Map([[key, 840]]),
    requests: new Map([[key, 30]]),
    poolRequests: new Map([["pool1", 40]]),
  };

  it("adds the load of instances with a known reading, with the member's p95 and share", () => {
    const load = new Map([
      ["i1", LOAD],
      ["i2", { ...LOAD, waiting: 1 }],
      ["i3", { ...LOAD, running: null, waiting: null }],
    ]);
    expect(memberView(memberRow(["i1", "i2", "i3", "i4"]), { load, ...traffic }).live).toEqual({
      instances: 4,
      running: 4,
      waiting: 6,
      p95LatencyMs: 840,
      share: 0.75,
      active: 2 * (LOAD.running ?? 0),
      slots: 16,
    });
  });

  it("keeps load, p95 and share unknown when nothing is known", () => {
    expect(memberView(memberRow(["i1"])).live).toEqual({
      instances: 1,
      running: 1,
      waiting: null,
      p95LatencyMs: null,
      share: null,
      active: null,
      slots: 4,
    });
  });

  it("gives a member without pool traffic of its own a zero share", () => {
    const quiet = { ...traffic, requests: new Map() };
    expect(memberView(memberRow(["i1"]), { load: new Map(), ...quiet }).live.share).toBe(0);
  });

  it("knows no slot limit when an instance's limit is unknown, nor any of a contributed one", () => {
    const load = new Map([["i1", LOAD]]);
    expect(memberView(memberRow(["i1"], "LOCAL", null), { load, ...traffic }).live).toMatchObject({
      active: LOAD.running,
      slots: null,
    });
    expect(
      memberView(memberRow(["i1"], "LOCAL", 4, "share1"), { load, ...traffic }).live,
    ).toMatchObject({ active: null, slots: null, share: 0.75 });
  });

  it("keys a cloud member's p95 and share by its provider model", () => {
    const cloudKey = memberLatencyKey("pool1", { providerModelId: "pm1" });
    const live = memberView(memberRow([], "CLOUD"), {
      load: new Map(),
      p95: new Map([[cloudKey, 1200]]),
      requests: new Map([[cloudKey, 10]]),
      poolRequests: new Map([["pool1", 40]]),
    }).live;
    expect(live).toMatchObject({ p95LatencyMs: 1200, share: 0.25, active: null, slots: null });
  });
});
