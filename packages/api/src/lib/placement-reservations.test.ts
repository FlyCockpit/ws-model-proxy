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
    requiredVersionIds: new Set(),
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

describe("a reservation's GPUs come from one vendor", () => {
  const discrete2: RuntimeResource = { kind: "discrete", gpuCount: 2, vramGb: 8 };
  const worker = (gpus: PlacementNode["gpus"]) =>
    node("w1", { labels: ["ds-worker"], memoryGb: 64, gpus });
  const place = (gpus: PlacementNode["gpus"]) =>
    new PlacementPlanner(context({ nodes: [node("head"), worker(gpus)] })).place(
      request({ reservations: [{ labels: ["ds-worker"], resources: discrete2 }] }),
    );

  it("never mixes vendors when the reservation names none (the launcher gets plain indices)", () => {
    // amd:0 + nvidia:0 would be gpuIds "0,0": one process cannot drive both.
    expect(
      refused(
        place([
          { key: "amd:0", vendor: "amd", vramGb: 24 },
          { key: "nvidia:0", vendor: "nvidia", vramGb: 24 },
        ]),
      ).reason,
    ).toBe("not_enough_memory");
    const result = ok(
      place([
        { key: "amd:0", vendor: "amd", vramGb: 24 },
        { key: "nvidia:0", vendor: "nvidia", vramGb: 24 },
        { key: "nvidia:1", vendor: "nvidia", vramGb: 24 },
      ]),
    );
    expect(result.start.reservations[0]?.resources).toMatchObject({
      gpus: ["nvidia:0", "nvidia:1"],
    });
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
    expect(refusal.message).toMatch(/^Reservation 3 cannot be placed/);
    expect(refusal.message).toContain("(labels ds-worker)");
    // Both labelled nodes fit it, but the other two reservations need them.
    expect(refusal.message).toContain("w1, w2 have room but are needed by other reservations");
    expect(refusal.reservation).toEqual({ index: 2, labels: ["ds-worker"], nodeSlug: null });
  });

  it("refuses with the no-node message when no node at all has the labels", () => {
    const refusal = refused(
      new PlacementPlanner(context()).place(
        request({ labels: ["ds-head"], reservations: [{ labels: ["nowhere"], resources: GB100 }] }),
      ),
    );
    expect(refusal.reason).toBe("not_enough_nodes");
    expect(refusal.message).toContain("no other node has all of its labels");
    expect(refusal.reservation).toEqual({ index: 0, labels: ["nowhere"], nodeSlug: null });
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
    expect(refusal.message).toMatch(/^Reservation 1 cannot be placed/);
    expect(refusal.message).toContain("(labels ds-worker)");
    expect(refusal.message).toContain("not enough room on w1, w2 (the most is 80 GiB free on w2)");
    expect(refusal.reservation).toEqual({ index: 0, labels: ["ds-worker"], nodeSlug: "w2" });
  });

  it("states each reason only for the nodes it applies to (one on hold, one offline)", () => {
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("head", { labels: ["ds-head"] }),
          node("w1", { labels: ["ds-worker"], held: true }),
          node("w2", { labels: ["ds-worker"], online: false }),
        ],
      }),
    );
    const refusal = refused(
      planner.place(
        request({ labels: ["ds-head"], reservations: [WORKERS[0] as RuntimeReservation] }),
      ),
    );
    expect(refusal).toMatchObject({ reason: "node_offline", subjectId: "w2" });
    expect(refusal.message).toContain("w2 is offline");
    expect(refusal.message).toContain("w1 is on hold");
    expect(refusal.message).not.toContain("every");
    expect(refusal.reservation?.nodeSlug).toBe("w2");
  });

  it("a mixed full and offline set names the memory miss and the offline node", () => {
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("head", { labels: ["ds-head"] }),
          node("w1", { labels: ["ds-worker"], memoryGb: 30 }),
          node("w2", { labels: ["ds-worker"], online: false }),
        ],
      }),
    );
    const refusal = refused(
      planner.place(
        request({ labels: ["ds-head"], reservations: [WORKERS[0] as RuntimeReservation] }),
      ),
    );
    expect(refusal).toMatchObject({ reason: "not_enough_memory", subjectId: "w1" });
    expect(refusal.message).toContain("w1 has 30 GiB free, and it needs 100 GiB");
    expect(refusal.message).toContain("w2 is offline");
    expect(refusal.message).not.toContain("every");
  });

  describe("assigns reservations together, not first come first served", () => {
    // The head is pinned; a-special has both labels, z-general only "worker". Taking a-special
    // for the "worker" entry (best fit, then slug) would leave "special" nothing.
    const nodes = () => [
      node("head"),
      node("a-special", { labels: ["worker", "special"] }),
      node("z-general", { labels: ["worker"] }),
    ];
    const generic: RuntimeReservation = { labels: ["worker"], resources: GB100 };
    const special: RuntimeReservation = { labels: ["special"], resources: GB100 };

    it("places [worker, special] by moving worker to the other node", () => {
      const result = ok(
        new PlacementPlanner(context({ nodes: nodes() })).place(
          request({ nodeIds: ["head"], reservations: [generic, special] }),
        ),
      );
      expect(result.start.reservations.map((r) => [r.index, r.nodeId])).toEqual([
        [0, "z-general"],
        [1, "a-special"],
      ]);
    });

    it("places the reversed order on the same nodes", () => {
      const result = ok(
        new PlacementPlanner(context({ nodes: nodes() })).place(
          request({ nodeIds: ["head"], reservations: [special, generic] }),
        ),
      );
      expect(result.start.reservations.map((r) => [r.index, r.nodeId])).toEqual([
        [0, "a-special"],
        [1, "z-general"],
      ]);
    });

    it("by room too: the small entry moves off the only node the large one fits", () => {
      const planner = new PlacementPlanner(
        context({
          nodes: [
            node("head"),
            node("a-big", { labels: ["worker"], memoryGb: 126 }),
            node("z-small", { labels: ["worker"], memoryGb: 30, liveFreeMemoryGb: null }),
          ],
        }),
      );
      // Best fit would give the 20 GiB entry z-small anyway; make the large one second and
      // the small one prefer a-big (a restart's previous node).
      const result = ok(
        planner.place(
          request({
            nodeIds: ["head"],
            reservations: [
              { labels: ["worker"], resources: { kind: "unified", memoryGb: 20 } },
              generic,
            ],
            restart: {
              instanceId: "inst-x",
              ports: [30000],
              distPort: null,
              reservationNodeIds: ["a-big", null],
            },
          }),
        ),
      );
      expect(result.start.reservations.map((r) => r.nodeId)).toEqual(["z-small", "a-big"]);
    });

    it("commits the assignment in the budgets: a later start cannot take either node", () => {
      const planner = new PlacementPlanner(context({ nodes: nodes() }));
      ok(planner.place(request({ nodeIds: ["head"], reservations: [generic, special] })));
      const next = refused(
        planner.place(request({ runtimeId: "rt-next", nodeIds: ["z-general"] })),
      );
      expect(next.reason).toBe("not_enough_memory");
    });
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
    expect(refusal.message).toContain("no other node has all of its labels");
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

// R5-C-1: an impossible reservation never makes the planner redo the same work for every node
// the rank could take, and every planner's work is bounded (`PLACEMENT_WORK_BUDGET`).
describe("placement work bound", () => {
  const N = 2_000;
  const fleet = (labels: (index: number) => string[] = () => [], memoryGb = 126) =>
    Array.from({ length: N }, (_, index) =>
      node(`n${String(index).padStart(4, "0")}`, { labels: labels(index), memoryGb }),
    );
  /** A running instance of another runtime filling `nodeId` (preemptible). */
  const filler = (nodeId: string): PlacementInstance => ({
    id: `fill-${nodeId}`,
    runtimeId: `rt-fill-${nodeId}`,
    ownerId: "u-1",
    startable: true,
    running: true,
    ranks: [
      {
        nodeId,
        port: 30001,
        distPort: null,
        claim: "HELD",
        resources: { kind: "unified", memoryGb: 120 },
      },
    ],
    contributed: false,
    interactiveStop: false,
  });

  it.each([false, true])(
    "refuses a reservation no node has the labels for once, not per head (preempt %s)",
    (preempt) => {
      const planner = new PlacementPlanner(context({ nodes: fleet() }));
      const refusal = refused(
        planner.place(
          request({ preempt, reservations: [{ labels: ["missing"], resources: GB100 }] }),
        ),
      );
      expect(refusal.reason).toBe("not_enough_nodes");
      expect(refusal.message).toContain("no other node has all of its labels");
      expect(refusal.reservation).toEqual({ index: 0, labels: ["missing"], nodeSlug: null });
      // Linear: the labels are read once per node, never once per (head, node). The work count
      // is the bound, not wall time (a busy CI runner made a time limit flaky).
      expect(planner.work).toBeLessThan(10 * N);
    },
  );

  it.each([false, true])(
    "refuses a reservation no labelled node has room for in linear work (preempt %s)",
    (preempt) => {
      // Every node has the label, none has room for it (nor for it after any stop).
      const planner = new PlacementPlanner(context({ nodes: fleet(() => ["worker"]) }));
      const refusal = refused(
        planner.place(
          request({
            preempt,
            resources: [{ kind: "unified", memoryGb: 10 }],
            reservations: [{ labels: ["worker"], resources: { kind: "unified", memoryGb: 500 } }],
          }),
        ),
      );
      expect(refusal.reason).toBe("not_enough_memory");
      expect(refusal.reservation?.labels).toEqual(["worker"]);
      expect(planner.work).toBeLessThan(20 * N);
    },
  );

  it("places a feasible reservation on a large fleet in linear work", () => {
    const planner = new PlacementPlanner(
      context({ nodes: fleet((index) => (index === N - 1 ? ["worker"] : [])) }),
    );
    const result = ok(
      planner.place(request({ reservations: [{ labels: ["worker"], resources: GB100 }] })),
    );
    expect(result.start.reservations.map((r) => r.nodeId)).toEqual([`n${N - 1}`]);
    expect(result.start.placements[0]?.nodeId).not.toBe(`n${N - 1}`);
    expect(planner.work).toBeLessThan(20 * N);
  });

  it("with stops to try for every head, stays inside the budget and says so when spent", () => {
    // Every node is full (a preemptible filler on each), so every head needs a stop and the
    // reservation's room changes per head: the bounded case is the budget.
    const nodes = fleet(() => ["worker"]);
    const planner = new PlacementPlanner(
      context({ nodes, instances: nodes.map((n) => filler(n.id)), workBudget: 50_000 }),
    );
    const result = planner.place(
      request({
        preempt: true,
        resources: [{ kind: "unified", memoryGb: 100 }],
        // Fits nowhere, even after a stop: every head is tried.
        reservations: [{ labels: ["worker"], resources: { kind: "unified", memoryGb: 500 } }],
      }),
    );
    // The bound is the work count, not wall time (a busy CI runner made a time limit flaky).
    expect(refused(result).reason).toBe("placement_too_complex");
    expect(planner.work).toBeLessThanOrEqual(50_000 + N + 2);
    // A spent planner refuses every later plan at once, and committed nothing.
    expect(refused(planner.place(request())).reason).toBe("placement_too_complex");
    expect(planner.stops).toEqual([]);
  });

  it("the default budget fits 64 ordinary starts on 2,000 nodes", () => {
    const planner = new PlacementPlanner(context({ nodes: fleet(() => [], 2_000) }));
    for (let index = 0; index < 64; index++)
      ok(planner.place(request({ resources: [{ kind: "unified", memoryGb: 1 }] })));
  });
});

describe("preemption counts a replaced run's holds", () => {
  it("a pinned start may stop the owner of a node held only by a superseded reservation", () => {
    // The old run's reservation on w1 still holds (its stop not proven); the current one is on
    // w2. Stopping that instance frees w1, as the budgets count it.
    const inst = withReservations("old", "head", ["w2"]);
    inst.ranks.push({
      nodeId: "w1",
      port: 0,
      distPort: null,
      claim: "HELD",
      resources: GB100,
      reservation: true,
      previous: true,
    });
    const planner = new PlacementPlanner(context({ instances: [inst] }));
    const result = planner.place(request({ nodeIds: ["w1"], preempt: true }));
    expect(result.ok).toBe(true);
    expect(planner.stops.map((stop) => stop.instanceId)).toEqual(["old"]);
  });
});
