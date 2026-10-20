import { describe, expect, it } from "vitest";
import {
  type PlacementContext,
  type PlacementInstance,
  type PlacementNode,
  PlacementPlanner,
  type PlacementRequest,
  type PlacementResult,
} from "./placement";
import type { RuntimeReservation, RuntimeResource } from "./runtime-spec";

// The ds41f shape: a launcher on a head node starts ranks on two worker nodes over SSH.

function node(id: string, overrides: Partial<PlacementNode> = {}): PlacementNode {
  return {
    id,
    slug: id,
    online: true,
    trust: "FULL",
    held: false,
    labels: [],
    portRange: [30000, 30009],
    heldVersionIds: new Set(),
    frozenFabrics: null,
    memoryGb: 126,
    gpus: [],
    liveFreeMemoryGb: null,
    ...overrides,
  };
}

function lab(): PlacementNode[] {
  return [
    node("head", { labels: ["ds-head"] }),
    node("w1", { labels: ["ds-worker"] }),
    node("w2", { labels: ["ds-worker"] }),
    node("spare"),
  ];
}

function context(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return { callerId: "u-1", agent: false, nodes: lab(), instances: [], fabrics: [], ...overrides };
}

const GB100: RuntimeResource = { kind: "unified", memoryGb: 100 };
const WORKERS: RuntimeReservation[] = [
  { labels: ["ds-worker"], resources: GB100 },
  { labels: ["ds-worker"], resources: GB100 },
];

function request(
  overrides: Partial<Omit<PlacementRequest, "launch">> & {
    labels?: string[];
    resources?: RuntimeResource[];
    reservations?: RuntimeReservation[];
    port?: { fixed: number };
  } = {},
): PlacementRequest {
  const { labels, resources, reservations, port, ...rest } = overrides;
  return {
    runtimeId: "rt-ds",
    versionId: "v-ds",
    launch: {
      groupSize: 1,
      resources: resources ?? [GB100],
      labels: labels ?? [],
      ...(port ? { port } : {}),
      ...(reservations ? { reservations } : {}),
    },
    checkFrozen: false,
    preempt: false,
    ...rest,
  };
}

function ok(result: PlacementResult) {
  if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.message}`);
  return result;
}

function refused(result: PlacementResult) {
  if (result.ok) throw new Error("placed, expected a refusal");
  return result.refusal;
}

/** A running instance whose rank is on `head` and whose reservations are on `reserved`. */
function withReservations(
  id: string,
  head: string,
  reserved: readonly string[],
  overrides: Partial<PlacementInstance> = {},
): PlacementInstance {
  return {
    id,
    runtimeId: `rt-${id}`,
    ownerId: "u-1",
    startable: true,
    running: true,
    ranks: [
      { nodeId: head, port: 30000, distPort: null, claim: "HELD", resources: GB100 },
      ...reserved.map((nodeId) => ({
        nodeId,
        port: 0,
        distPort: null,
        claim: "HELD" as const,
        resources: GB100,
        reservation: true,
      })),
    ],
    contributed: false,
    interactiveStop: false,
    ...overrides,
  };
}

describe("placement without reservations", () => {
  it("plans no reservations (the default case is unchanged)", () => {
    const result = ok(new PlacementPlanner(context()).place(request()));
    expect(result.start.reservations).toEqual([]);
    expect(result.start.placements.map((p) => [p.nodeId, p.port])).toEqual([["head", 30000]]);
  });

  it("treats an empty reservation list like none", () => {
    const result = ok(new PlacementPlanner(context()).place(request({ reservations: [] })));
    expect(result.start.reservations).toEqual([]);
  });
});

describe("placement with reservations", () => {
  it("places each reservation on its own labelled node, never the rank's", () => {
    const result = ok(
      new PlacementPlanner(context()).place(
        request({ labels: ["ds-head"], reservations: WORKERS }),
      ),
    );
    expect(result.start.placements.map((p) => p.nodeId)).toEqual(["head"]);
    expect(result.start.reservations).toEqual([
      {
        index: 0,
        nodeId: "w1",
        nodeSlug: "w1",
        labels: ["ds-worker"],
        resources: GB100,
        memoryGb: 100,
      },
      {
        index: 1,
        nodeId: "w2",
        nodeSlug: "w2",
        labels: ["ds-worker"],
        resources: GB100,
        memoryGb: 100,
      },
    ]);
  });

  it("counts reservations against the node: a later start in the same plan cannot take them", () => {
    const planner = new PlacementPlanner(context());
    ok(planner.place(request({ labels: ["ds-head"], reservations: WORKERS })));
    // 100 GiB is held on head, w1 and w2: only `spare` has room.
    const next = ok(planner.place(request({ runtimeId: "rt-other" })));
    expect(next.start.placements.map((p) => p.nodeId)).toEqual(["spare"]);
    const full = refused(planner.place(request({ runtimeId: "rt-third" })));
    expect(full.reason).toBe("not_enough_memory");
  });

  it("counts loaded reservation claims (HELD and HELD_UNKNOWN) and takes no port with them", () => {
    const planner = new PlacementPlanner(
      context({
        instances: [
          withReservations("ds", "head", ["w1"]),
          withReservations("ds2", "spare", ["w2"], {
            ranks: [
              {
                nodeId: "spare",
                port: 30000,
                distPort: null,
                claim: "HELD_UNKNOWN",
                resources: GB100,
              },
              {
                nodeId: "w2",
                port: 0,
                distPort: null,
                claim: "HELD_UNKNOWN",
                resources: GB100,
                reservation: true,
              },
            ],
          }),
        ],
      }),
    );
    const big = refused(planner.place(request({ runtimeId: "rt-other" })));
    expect(big.reason).toBe("not_enough_memory");
    // 26 GiB is left on w1: a small runtime fits there on the first port of its range, which
    // the reservation (port 0, no port) does not take.
    const small = ok(
      planner.place(
        request({
          runtimeId: "rt-small",
          resources: [{ kind: "unified", memoryGb: 20 }],
          nodeIds: ["w1"],
        }),
      ),
    );
    expect(small.start.placements[0]?.port).toBe(30000);
    // ... and no more than those 26 GiB.
    refused(
      planner.place(
        request({
          runtimeId: "rt-more",
          resources: [{ kind: "unified", memoryGb: 20 }],
          nodeIds: ["w1"],
        }),
      ),
    );
  });

  it("moves the rank off the only node a reservation could use", () => {
    // Best fit alone would put the rank on w1 (least memory left), leaving the reservation
    // nowhere; the next node for the rank works.
    const planner = new PlacementPlanner(
      context({
        nodes: [node("w1", { labels: ["ds-worker"], memoryGb: 110 }), node("big")],
      }),
    );
    const result = ok(
      planner.place(request({ reservations: [{ labels: ["ds-worker"], resources: GB100 }] })),
    );
    expect(result.start.placements[0]?.nodeId).toBe("big");
    expect(result.start.reservations.map((r) => r.nodeId)).toEqual(["w1"]);
  });

  it("keeps the rank where nodeIds pin it and places reservations by their labels", () => {
    const result = ok(
      new PlacementPlanner(context()).place(request({ nodeIds: ["spare"], reservations: WORKERS })),
    );
    expect(result.start.placements[0]?.nodeId).toBe("spare");
    expect(result.start.reservations.map((r) => r.nodeId)).toEqual(["w1", "w2"]);
  });

  it("refuses naming the labels when no other node has them", () => {
    const refusal = refused(
      new PlacementPlanner(context()).place(
        request({
          labels: ["ds-head"],
          reservations: [...WORKERS, { labels: ["ds-worker"], resources: GB100 }],
        }),
      ),
    );
    expect(refusal.reason).toBe("not_enough_nodes");
    expect(refusal.message).toContain("Reservation 3 (labels ds-worker)");
    expect(refusal.message).toContain("no other node has these labels");
  });

  it("refuses naming the labels and the node when memory is short", () => {
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("head", { labels: ["ds-head"] }),
          node("w1", { labels: ["ds-worker"], memoryGb: 60 }),
          node("w2", { labels: ["ds-worker"], memoryGb: 80 }),
        ],
      }),
    );
    const refusal = refused(
      planner.place(
        request({ labels: ["ds-head"], reservations: [WORKERS[0] as RuntimeReservation] }),
      ),
    );
    expect(refusal).toMatchObject({ reason: "not_enough_memory", subjectId: "w2" });
    expect(refusal.message).toContain("Reservation 1 (labels ds-worker)");
    expect(refusal.message).toContain("w2 has the most memory free");
  });

  it("refuses when every node with the labels is offline", () => {
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("head", { labels: ["ds-head"] }),
          node("w1", { labels: ["ds-worker"], online: false }),
        ],
      }),
    );
    const refusal = refused(
      planner.place(
        request({ labels: ["ds-head"], reservations: [WORKERS[0] as RuntimeReservation] }),
      ),
    );
    expect(refusal).toMatchObject({ reason: "node_offline", subjectId: "w1" });
    expect(refusal.message).toContain("labels ds-worker");
  });

  it("keeps agents off Relay-only reservation nodes", () => {
    const planner = new PlacementPlanner(
      context({
        agent: true,
        nodes: [
          node("head", { labels: ["ds-head"] }),
          node("w1", { labels: ["ds-worker"], trust: "RELAY" }),
        ],
      }),
    );
    const refusal = refused(
      planner.place(
        request({ labels: ["ds-head"], reservations: [WORKERS[0] as RuntimeReservation] }),
      ),
    );
    expect(refusal.reason).toBe("trust_relay");
  });

  it("places reservations only within reservationNodeIds when given", () => {
    const refusal = refused(
      new PlacementPlanner(context()).place(
        request({
          labels: ["ds-head"],
          reservations: [WORKERS[0] as RuntimeReservation],
          reservationNodeIds: new Set(["head", "spare"]),
        }),
      ),
    );
    expect(refusal.message).toContain("no other node has these labels");
  });

  it("a restart frees its own reservations and prefers their nodes", () => {
    const planner = new PlacementPlanner(
      context({
        nodes: [...lab(), node("w3", { labels: ["ds-worker"] })],
        instances: [withReservations("ds", "head", ["w3", "w2"])],
      }),
    );
    const result = ok(
      planner.place(
        request({
          labels: ["ds-head"],
          reservations: WORKERS,
          nodeIds: ["head"],
          restart: {
            instanceId: "ds",
            ports: [30000],
            distPort: null,
            reservationNodeIds: ["w3", "w2"],
          },
        }),
      ),
    );
    expect(result.start.reservations.map((r) => r.nodeId)).toEqual(["w3", "w2"]);
    expect(result.start.blockedBy).toEqual([]);
  });

  it("stops another instance to make room for a reservation when preemption is allowed", () => {
    const victim: PlacementInstance = {
      id: "victim",
      runtimeId: "rt-victim",
      ownerId: "u-1",
      startable: true,
      running: true,
      ranks: [{ nodeId: "w1", port: 30000, distPort: null, claim: "HELD", resources: GB100 }],
      contributed: false,
      interactiveStop: false,
    };
    const planner = new PlacementPlanner(
      context({
        nodes: [node("head", { labels: ["ds-head"] }), node("w1", { labels: ["ds-worker"] })],
        instances: [victim],
      }),
    );
    const without = refused(
      planner.place(
        request({ labels: ["ds-head"], reservations: [WORKERS[0] as RuntimeReservation] }),
      ),
    );
    expect(without.reason).toBe("not_enough_memory");
    const result = ok(
      planner.place(
        request({
          labels: ["ds-head"],
          reservations: [WORKERS[0] as RuntimeReservation],
          preempt: true,
        }),
      ),
    );
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["victim"]);
    expect(result.start.reservations.map((r) => r.nodeId)).toEqual(["w1"]);
    expect(result.start.blockedBy).toEqual(["victim"]);
  });

  it("waits for an instance already stopping that holds a reservation on its node", () => {
    const planner = new PlacementPlanner(
      context({ instances: [withReservations("old", "spare", ["head"], { running: false })] }),
    );
    const result = ok(planner.place(request({ labels: ["ds-head"] })));
    expect(result.start.placements[0]?.nodeId).toBe("head");
    expect(result.start.blockedBy).toEqual(["old"]);
    expect(result.warnings.map((warning) => warning.code)).toContain("waits_for_stop");
  });
});
