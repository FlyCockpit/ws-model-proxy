import { describe, expect, it } from "vitest";
import {
  type PlacementContext,
  type PlacementFabric,
  type PlacementInstance,
  type PlacementNode,
  PlacementPlanner,
  type PlacementRequest,
  type PlacementResult,
} from "./placement";
import type { RuntimeResource } from "./runtime-spec";

// ── Fixtures: the owner's lab ──
// 8 DGX Sparks (128 GiB unified, 126 usable), 2 Strix Halos (128 GiB unified, 126 usable) and
// a 3090 box (64 GiB RAM, one 24 GiB GPU). Today the Sparks are wired in direct pairs.

const SPARKS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

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
    memoryGb: 126,
    gpus: [],
    liveFreeMemoryGb: null,
    ...overrides,
  };
}

function lab(): PlacementNode[] {
  return [
    ...SPARKS.map((id) =>
      node(id, { labels: ["spark"], gpus: [{ key: "nvidia:0", vendor: "nvidia", vramGb: 0 }] }),
    ),
    node("h1", { labels: ["strix"] }),
    node("h2", { labels: ["strix"] }),
    node("g1", {
      labels: ["rtx"],
      memoryGb: 64,
      gpus: [{ key: "nvidia:0", vendor: "nvidia", vramGb: 24 }],
    }),
  ];
}

function fabric(name: string, nodeIds: readonly string[]): PlacementFabric {
  return {
    id: `f-${name}`,
    name,
    members: nodeIds.map((nodeId) => ({
      nodeId,
      ip: `10.${name.length}.0.${SPARKS.indexOf(nodeId) + 1}`,
    })),
  };
}

/** The direct spark-to-spark pairs of today. */
const PAIRS = [
  fabric("pair-12", ["s1", "s2"]),
  fabric("pair-34", ["s3", "s4"]),
  fabric("pair-56", ["s5", "s6"]),
  fabric("pair-78", ["s7", "s8"]),
];
/** The switch of later. */
const SWITCH = fabric("switch", SPARKS);

function context(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    callerId: "u-1",
    agent: false,
    nodes: lab(),
    instances: [],
    fabrics: PAIRS,
    ...overrides,
  };
}

function request(
  overrides: Partial<Omit<PlacementRequest, "launch">> & {
    groupSize?: number;
    resources?: RuntimeResource[];
    labels?: string[];
    port?: { fixed: number };
    fabric?: string;
  } = {},
): PlacementRequest {
  const { groupSize, resources, labels, port, fabric: fabricName, ...rest } = overrides;
  return {
    runtimeId: "rt-new",
    versionId: "v-new",
    launch: {
      groupSize: groupSize ?? 1,
      resources: resources ?? [{ kind: "unified", memoryGb: 40 }],
      labels: labels ?? [],
      ...(port ? { port } : {}),
      ...(fabricName ? { fabric: fabricName } : {}),
    },
    checkFrozen: false,
    preempt: false,
    ...rest,
  };
}

function running(
  id: string,
  nodeIds: readonly string[],
  memoryGb: number,
  overrides: Partial<PlacementInstance> = {},
): PlacementInstance {
  return {
    id,
    runtimeId: `rt-${id}`,
    ownerId: "u-1",
    startable: true,
    running: true,
    ranks: nodeIds.map((nodeId, index) => ({
      nodeId,
      port: 30000 + index,
      distPort: null,
      resources: { kind: "unified", memoryGb },
    })),
    contributed: false,
    interactiveStop: false,
    ...overrides,
  };
}

function ok(result: PlacementResult) {
  if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.message}`);
  return result;
}

function nodesOf(result: PlacementResult): string[] {
  return ok(result).start.placements.map((placement) => placement.nodeId);
}

const GLM = { groupSize: 2, resources: [{ kind: "unified", memoryGb: 110 }] as RuntimeResource[] };
const QWEN_FLASH = { resources: [{ kind: "unified", memoryGb: 100 }] as RuntimeResource[] };

describe("owner scenarios", () => {
  it("places 4 GLM instances on the 4 spark pairs, each inside its own pair fabric", () => {
    const planner = new PlacementPlanner(context());
    const placed = [1, 2, 3, 4].map(() =>
      ok(planner.place(request({ ...GLM, labels: ["spark"] }))),
    );
    expect(placed.map((result) => result.start.fabric?.name)).toEqual([
      "pair-12",
      "pair-34",
      "pair-56",
      "pair-78",
    ]);
    const first = placed[0];
    expect(first?.start.placements.map((p) => [p.nodeId, p.nodeNumber, p.fabricIp])).toEqual([
      ["s1", 1, "10.7.0.1"],
      ["s2", 2, "10.7.0.2"],
    ]);
    expect(first?.start.fabric?.headAddr).toBe("10.7.0.1");
    expect(first?.start.distPort).toBe(30001);
    expect(first?.stops).toEqual([]);
    // A fifth does not fit: memory, not fabrics, is what is missing.
    const fifth = planner.place(request({ ...GLM, labels: ["spark"] }));
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.refusal.reason).toBe("not_enough_memory");
  });

  it("places 4 two-node DSV4 Flash the same way, and prefers a pair over the switch", () => {
    const planner = new PlacementPlanner(context({ fabrics: [SWITCH, ...PAIRS] }));
    const dsv4 = request({
      groupSize: 2,
      resources: [{ kind: "unified", memoryGb: 96 }],
      labels: ["spark"],
    });
    const fabrics = [1, 2, 3, 4].map(() => ok(planner.place(dsv4)).start.fabric?.name);
    expect(fabrics).toEqual(["pair-12", "pair-34", "pair-56", "pair-78"]);
  });

  it("places 8 one-node Qwen 3.8 Flash, one per spark", () => {
    const planner = new PlacementPlanner(context());
    const placed = SPARKS.map(() =>
      nodesOf(planner.place(request({ ...QWEN_FLASH, labels: ["spark"] }))),
    );
    expect(placed.flat().sort()).toEqual(SPARKS);
  });

  it("mixes and matches: 2 GLM pairs and 4 Qwen on the remaining sparks", () => {
    const planner = new PlacementPlanner(context());
    const glm = [1, 2].map(() => nodesOf(planner.place(request({ ...GLM, labels: ["spark"] }))));
    const qwen = [1, 2, 3, 4].map(() =>
      nodesOf(planner.place(request({ ...QWEN_FLASH, runtimeId: "rt-qwen", labels: ["spark"] }))),
    );
    expect(glm).toEqual([
      ["s1", "s2"],
      ["s3", "s4"],
    ]);
    expect(qwen.flat().sort()).toEqual(["s5", "s6", "s7", "s8"]);
  });

  it("packs a single-node start next to a running one so whole pairs stay free", () => {
    // Qwen 40 GiB on s3; a second 40 GiB start goes to s3 too (best fit), leaving pairs whole.
    const planner = new PlacementPlanner(context({ instances: [running("q", ["s3"], 40)] }));
    expect(nodesOf(planner.place(request({ labels: ["spark"] })))).toEqual(["s3"]);
    // A GLM pair then still finds pair-12 whole.
    expect(nodesOf(planner.place(request({ ...GLM, labels: ["spark"] })))).toEqual(["s1", "s2"]);
  });

  it("runs full GLM 5.3 across all 8 sparks on the switch once the profile stops the rest", () => {
    const instances = [
      running("glm-a", ["s1", "s2"], 110),
      running("glm-b", ["s3", "s4"], 110),
      running("q5", ["s5"], 100),
      running("q6", ["s6"], 100),
      running("q7", ["s7"], 100),
      running("q8", ["s8"], 100),
    ];
    const planner = new PlacementPlanner(
      context({
        fabrics: [SWITCH, ...PAIRS],
        instances,
        stopping: new Set(instances.map((instance) => instance.id)),
      }),
    );
    const result = ok(
      planner.place(
        request({
          groupSize: 8,
          resources: [{ kind: "unified", memoryGb: 118 }],
          labels: ["spark"],
          allowedNodeIds: new Set(SPARKS),
        }),
      ),
    );
    expect(result.start.fabric?.name).toBe("switch");
    expect(result.start.placements.map((p) => p.nodeId)).toEqual(SPARKS);
    expect(result.start.blockedBy).toEqual(instances.map((i) => i.id).sort());
    // The profile's stops are its own; the planner adds none.
    expect(result.stops).toEqual([]);
    // Ports of stopping instances stay claimed until they release.
    expect(result.start.placements[0]?.port).toBe(30001);
  });

  it("refuses an 8-node start on pair fabrics only (no_shared_fabric)", () => {
    const planner = new PlacementPlanner(context());
    const result = planner.place(
      request({ groupSize: 8, resources: [{ kind: "unified", memoryGb: 50 }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("no_shared_fabric");
  });

  it("puts several small runtimes on one Strix Halo", () => {
    const planner = new PlacementPlanner(context());
    const qwen = ok(
      planner.place(
        request({
          runtimeId: "rt-qwen36",
          resources: [{ kind: "unified", memoryGb: 40 }],
          labels: ["strix"],
        }),
      ),
    );
    const embed = ok(
      planner.place(
        request({
          runtimeId: "rt-embed",
          resources: [{ kind: "unified", memoryGb: 8 }],
          labels: ["strix"],
        }),
      ),
    );
    expect(qwen.start.placements[0]?.nodeId).toBe("h1");
    expect(embed.start.placements[0]?.nodeId).toBe("h1");
    expect(embed.start.placements[0]?.port).toBe(30001);
    expect(embed.start.fabric).toBeNull();
    expect(embed.start.distPort).toBeNull();
  });

  it("never uses a held node, not even with preemption", () => {
    const nodes = lab().map((n) => (n.id === "h1" ? { ...n, held: true } : n));
    const planner = new PlacementPlanner(
      context({ nodes, instances: [running("busy", ["h2"], 120)] }),
    );
    const result = planner.place(request({ labels: ["strix"], preempt: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("not_enough_memory");
    const preempting = ok(planner.place(request({ labels: ["strix"], preempt: true })));
    expect(preempting.start.placements[0]?.nodeId).toBe("h2");
    expect(preempting.stops.map((stop) => stop.instanceId)).toEqual(["busy"]);
    // Held only: refused node_held.
    const allHeld = lab().map((n) => (n.labels.includes("strix") ? { ...n, held: true } : n));
    const refused = new PlacementPlanner(context({ nodes: allHeld })).place(
      request({ labels: ["strix"], preempt: true }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("node_held");
    const explicit = new PlacementPlanner(context({ nodes })).place(request({ nodeIds: ["h1"] }));
    expect(explicit.ok).toBe(false);
    if (!explicit.ok)
      expect(explicit.refusal).toMatchObject({ reason: "node_held", subjectId: "h1" });
  });

  it("counts a service runtime (no served models) like any other claim", () => {
    // A service takes a whole Strix Halo; the next start goes to the other one.
    const service = running("svc", ["h1"], 126);
    const planner = new PlacementPlanner(context({ instances: [service] }));
    expect(nodesOf(planner.place(request({ labels: ["strix"] })))).toEqual(["h2"]);
  });
});

describe("accounting", () => {
  it("shares one 24 GiB GPU between two discrete runtimes and refuses a third", () => {
    const planner = new PlacementPlanner(context());
    const llm = request({
      runtimeId: "rt-llm",
      resources: [{ kind: "discrete", gpuCount: 1, vramGb: 18, ramGb: 16 }],
    });
    const embed = request({
      runtimeId: "rt-embed",
      resources: [{ kind: "discrete", gpuCount: 1, vramGb: 4 }],
    });
    expect(nodesOf(planner.place(llm))).toEqual(["g1"]);
    expect(nodesOf(planner.place(embed))).toEqual(["g1"]);
    const third = planner.place(
      request({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 4 }] }),
    );
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.refusal.reason).toBe("not_enough_memory");
  });

  it("needs as many GPUs as gpuCount, of the vendor named", () => {
    const planner = new PlacementPlanner(context());
    const two = planner.place(
      request({ resources: [{ kind: "discrete", gpuCount: 2, vramGb: 8 }] }),
    );
    expect(two.ok).toBe(false);
    const amd = planner.place(
      request({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 8, vendor: "amd" }] }),
    );
    expect(amd.ok).toBe(false);
  });

  it("counts HELD_UNKNOWN and stopping claims that are not this plan's (they arrive as ranks)", () => {
    const stopping = running("old", ["h1"], 100, { running: false });
    const planner = new PlacementPlanner(context({ instances: [stopping] }));
    expect(nodesOf(planner.place(request({ labels: ["strix"] })))).toEqual(["h2"]);
  });

  it("subtracts claims of another user's instance on the node, and never preempts it", () => {
    const foreign = running("foreign", ["h1"], 100, { ownerId: "u-2" });
    const own = running("own", ["h2"], 100);
    const planner = new PlacementPlanner(context({ instances: [foreign, own] }));
    const result = ok(planner.place(request({ labels: ["strix"], preempt: true })));
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["own"]);
  });

  it("takes the first free port, a fixed port, and refuses ports that are taken", () => {
    const planner = new PlacementPlanner(
      context({ nodes: [node("a", { portRange: [30000, 30001] })] }),
    );
    expect(ok(planner.place(request({ port: { fixed: 31000 } }))).start.placements[0]?.port).toBe(
      31000,
    );
    const fixedAgain = planner.place(request({ port: { fixed: 31000 } }));
    expect(fixedAgain.ok).toBe(false);
    if (!fixedAgain.ok) expect(fixedAgain.refusal.reason).toBe("port_in_use");
    expect(
      ok(planner.place(request({ resources: [{ kind: "none" }] }))).start.placements[0]?.port,
    ).toBe(30000);
    expect(
      ok(planner.place(request({ resources: [{ kind: "none" }] }))).start.placements[0]?.port,
    ).toBe(30001);
    const full = planner.place(request({ resources: [{ kind: "none" }], preempt: true }));
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.refusal.reason).toBe("no_free_ports");
  });

  it("gives a multi-node instance one dist port free on every rank's node", () => {
    const nodes = [
      node("a", { portRange: [30000, 30005] }),
      node("b", { portRange: [30002, 30009] }),
    ];
    const planner = new PlacementPlanner(
      context({
        nodes,
        fabrics: [fabric("ab", ["a", "b"])],
        instances: [
          running("x", ["b"], 1, {
            ranks: [{ nodeId: "b", port: 30003, distPort: null, resources: { kind: "none" } }],
          }),
        ],
      }),
    );
    const result = ok(
      planner.place(request({ groupSize: 2, resources: [{ kind: "unified", memoryGb: 10 }] })),
    );
    expect(result.start.placements.map((p) => p.port)).toEqual([30000, 30002]);
    expect(result.start.distPort).toBe(30004);
  });

  it("is deterministic whatever order the inputs arrive in", () => {
    const instances = [
      running("q1", ["s1"], 60),
      running("q2", ["h1"], 30),
      running("q3", ["s4"], 60),
    ];
    const plan = (ctx: PlacementContext) => {
      const planner = new PlacementPlanner(ctx);
      return [
        planner.place(request({ labels: ["spark"] })),
        planner.place(request({ ...GLM, labels: ["spark"] })),
        planner.place(request({ ...QWEN_FLASH, labels: ["spark"], preempt: true })),
      ];
    };
    const forward = plan(context({ instances, fabrics: [SWITCH, ...PAIRS] }));
    const reversed = plan(
      context({
        instances: [...instances].reverse(),
        nodes: lab().reverse(),
        fabrics: [...PAIRS].reverse().concat(SWITCH),
      }),
    );
    expect(reversed).toEqual(forward);
  });
});

describe("trust, labels and frozen definitions", () => {
  it("refuses an agent on a Relay-only node, and auto placement skips it", () => {
    const nodes = [node("relay", { trust: "RELAY" }), node("full", { memoryGb: 10 })];
    const agent = new PlacementPlanner(context({ nodes, agent: true }));
    const explicit = agent.place(request({ nodeIds: ["relay"] }));
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) expect(explicit.refusal.reason).toBe("trust_relay");
    const auto = agent.place(request());
    expect(auto.ok).toBe(false);
    if (!auto.ok) expect(auto.refusal.reason).toBe("not_enough_memory");
    const onlyRelay = new PlacementPlanner(
      context({ nodes: [nodes[0] as PlacementNode], agent: true }),
    );
    const refused = onlyRelay.place(request());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("trust_relay");
  });

  it("refuses a version a Relay-only node does not hold when asked to (profiles)", () => {
    const nodes = [node("relay", { trust: "RELAY", heldVersionIds: new Set(["v-old"]) })];
    const planner = new PlacementPlanner(context({ nodes }));
    const refused = planner.place(request({ checkFrozen: true }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("definition_frozen");
    expect(ok(planner.place(request({ versionId: "v-old", checkFrozen: true }))).ok).toBe(true);
  });

  it("names the closest miss: an offline node with the label beats one without it", () => {
    const nodes = [node("off", { online: false, labels: ["gpu"] }), node("on")];
    const planner = new PlacementPlanner(context({ nodes }));
    const result = planner.place(request({ labels: ["gpu"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("node_offline");
    const none = planner.place(request({ labels: ["tpu"] }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.refusal.reason).toBe("label_mismatch");
  });
});

describe("explicit nodes and restarts", () => {
  it("places on exactly the given nodes and refuses a split across fabrics", () => {
    const planner = new PlacementPlanner(context());
    const result = ok(planner.place(request({ ...GLM, nodeIds: ["s2", "s1"] })));
    expect(result.start.placements.map((p) => p.nodeId)).toEqual(["s2", "s1"]);
    expect(result.start.fabric?.headAddr).toBe("10.7.0.2");
    const split = planner.place(request({ ...GLM, nodeIds: ["s3", "s5"] }));
    expect(split.ok).toBe(false);
    if (!split.ok) expect(split.refusal.reason).toBe("no_shared_fabric");
    const pinned = planner.place(request({ ...GLM, fabric: "switch", nodeIds: ["s3", "s4"] }));
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.refusal.reason).toBe("no_shared_fabric");
    const wrongCount = planner.place(request({ ...GLM, nodeIds: ["s3"] }));
    expect(wrongCount.ok).toBe(false);
    if (!wrongCount.ok) expect(wrongCount.refusal.reason).toBe("invalid_node_count");
    const unknown = planner.place(request({ nodeIds: ["nope"] }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.refusal.reason).toBe("unknown_node");
  });

  it("a restart does not count its own claim and keeps its ports", () => {
    const self = running("self", ["h1"], 120, {
      ranks: [
        {
          nodeId: "h1",
          port: 30005,
          distPort: null,
          resources: { kind: "unified", memoryGb: 120 },
        },
      ],
    });
    const planner = new PlacementPlanner(context({ instances: [self] }));
    const result = ok(
      planner.place(
        request({
          resources: [{ kind: "unified", memoryGb: 120 }],
          nodeIds: ["h1"],
          restart: { instanceId: "self", ports: [30005], distPort: null },
        }),
      ),
    );
    expect(result.start.placements[0]?.port).toBe(30005);
    expect(result.stops).toEqual([]);
  });

  it("a restart is refused when another claim took its port", () => {
    const self = running("self", ["h1"], 10, {
      ranks: [{ nodeId: "h1", port: 30005, distPort: null, resources: { kind: "none" } }],
      running: false,
    });
    const thief = running("thief", ["h1"], 10, {
      ranks: [{ nodeId: "h1", port: 30005, distPort: null, resources: { kind: "none" } }],
    });
    const planner = new PlacementPlanner(context({ instances: [self, thief] }));
    const result = planner.place(
      request({ nodeIds: ["h1"], restart: { instanceId: "self", ports: [30005], distPort: null } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.refusal).toMatchObject({ reason: "port_in_use", subjectId: "h1" });
  });
});

describe("preemption", () => {
  const full = () => [
    running("glm-12", ["s1", "s2"], 110),
    running("glm-34", ["s3", "s4"], 110),
    running("q5", ["s5"], 100),
    running("q6", ["s6"], 100),
    running("q7", ["s7"], 100),
    running("q8", ["s8"], 100),
  ];

  it("stops nothing when the start fits, and refuses without preempt when it does not", () => {
    const planner = new PlacementPlanner(context({ instances: full() }));
    const result = planner.place(request({ ...QWEN_FLASH, labels: ["spark"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("not_enough_memory");
      expect(result.refusal.message).toContain("100 GiB");
    }
  });

  it("stops one single-node instance rather than a two-node one", () => {
    const planner = new PlacementPlanner(context({ instances: full() }));
    const result = ok(planner.place(request({ ...QWEN_FLASH, labels: ["spark"], preempt: true })));
    expect(result.stops).toEqual([{ instanceId: "q5", runtimeId: "rt-q5", reason: "preempted" }]);
    expect(result.start.placements[0]?.nodeId).toBe("s5");
    expect(result.start.blockedBy).toEqual(["q5"]);
    expect(planner.stops.map((stop) => stop.instanceId)).toEqual(["q5"]);
  });

  it("frees a pair for a two-node start by stopping one two-node instance, not two singles", () => {
    const planner = new PlacementPlanner(context({ instances: full() }));
    const result = ok(planner.place(request({ ...GLM, labels: ["spark"], preempt: true })));
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["glm-12"]);
    expect(result.start.fabric?.name).toBe("pair-12");
    expect(result.start.placements.map((p) => p.nodeId)).toEqual(["s1", "s2"]);
  });

  it("stops the smallest set that frees enough on one node", () => {
    const instances = [
      running("small-a", ["h1"], 20),
      running("small-b", ["h1"], 20),
      running("big", ["h1"], 80),
      running("other", ["h2"], 126),
    ];
    const planner = new PlacementPlanner(context({ instances }));
    // 126 - 120 = 6 free on h1; 70 needed: stopping "big" alone frees 86.
    const result = ok(
      planner.place(
        request({
          resources: [{ kind: "unified", memoryGb: 70 }],
          labels: ["strix"],
          preempt: true,
        }),
      ),
    );
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["big"]);
  });

  it("never stops an always-on runtime, an instance of the same runtime, or another user's", () => {
    const instances = [
      running("ao", ["h1"], 126, { startable: false }),
      running("same", ["h2"], 126, { runtimeId: "rt-new" }),
    ];
    const planner = new PlacementPlanner(context({ instances }));
    const result = planner.place(request({ labels: ["strix"], preempt: true }));
    expect(result.ok).toBe(false);
  });

  it("an agent never stops a contributed instance, one on a Relay-only node, or an interactive stop", () => {
    const nodes = lab().map((n) => (n.id === "s8" ? { ...n, trust: "RELAY" as const } : n));
    const instances = [
      running("contrib", ["s5"], 120, { contributed: true }),
      running("interactive", ["s6"], 120, { interactiveStop: true }),
      running("spans-relay", ["s7", "s8"], 120),
      running("pair-a", ["s1", "s2"], 120),
      running("pair-b", ["s3", "s4"], 120),
    ];
    const agent = new PlacementPlanner(context({ nodes, instances, agent: true }));
    const result = ok(agent.place(request({ ...QWEN_FLASH, labels: ["spark"], preempt: true })));
    // The only stops an agent may make: a whole Full-control pair.
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["pair-a"]);

    // A person prefers the cheapest single, and stops a contributed one only as a last resort.
    const person = new PlacementPlanner(context({ nodes, instances }));
    const personal = ok(person.place(request({ ...QWEN_FLASH, labels: ["spark"], preempt: true })));
    expect(personal.stops.map((stop) => stop.instanceId)).toEqual(["interactive"]);
    expect(personal.warnings.map((w) => w.code)).toContain("interactive_needs_person");
  });

  it("a person stops a contributed instance only when nothing else frees room", () => {
    const instances = [
      running("contrib", ["h1"], 126, { contributed: true }),
      running("pair", ["h2"], 126),
    ];
    const planner = new PlacementPlanner(context({ instances }));
    const first = ok(planner.place(request({ labels: ["strix"], preempt: true })));
    expect(first.stops.map((stop) => stop.instanceId)).toEqual(["pair"]);
    const second = ok(
      planner.place(request({ runtimeId: "rt-other", labels: ["strix"], preempt: true })),
    );
    // h2 still has room after the first start (126 - 40).
    expect(second.stops).toEqual([]);
    const third = ok(
      planner.place(
        request({
          runtimeId: "rt-third",
          resources: [{ kind: "unified", memoryGb: 100 }],
          labels: ["strix"],
          preempt: true,
        }),
      ),
    );
    expect(third.stops.map((stop) => stop.instanceId)).toEqual(["contrib"]);
  });

  it("frees a stopped instance's memory once, on every node it held", () => {
    const planner = new PlacementPlanner(context({ instances: full() }));
    ok(planner.place(request({ ...GLM, labels: ["spark"], preempt: true })));
    // glm-12 was stopped and its pair re-used; nothing else is free.
    const next = planner.place(request({ runtimeId: "rt-x", ...QWEN_FLASH, labels: ["spark"] }));
    expect(next.ok).toBe(false);
  });
});
