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
import { type PlacementNodeRow, placementNodeOf } from "./placement-load";
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
      claim: "HELD",
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

  it("takes its GPUs from one vendor when it names none", () => {
    const mixed = (extra: PlacementNode["gpus"]) =>
      new PlacementPlanner(
        context({
          nodes: [
            node("m", {
              memoryGb: 64,
              gpus: [
                { key: "amd:0", vendor: "amd", vramGb: 24 },
                { key: "nvidia:0", vendor: "nvidia", vramGb: 24 },
                ...extra,
              ],
            }),
          ],
        }),
      ).place(request({ resources: [{ kind: "discrete", gpuCount: 2, vramGb: 8 }] }));
    expect(mixed([]).ok).toBe(false);
    const result = ok(mixed([{ key: "amd:1", vendor: "amd", vramGb: 24 }]));
    expect(result.start.placements[0]?.resources.gpus).toEqual(["amd:0", "amd:1"]);
  });

  it("tries another vendor when the best-fitting GPUs' vendor lacks the room in total", () => {
    // A claim from before claims recorded their GPUs: 30 GiB of NVIDIA, charged (a guess) to
    // nvidia:0 (24 GiB, the hardware shrank). Where it really sits is not known, so the NVIDIA
    // GPUs must have the room together: nvidia:1 and nvidia:2 fit 6 GiB each, but together they
    // are 2 GiB short. Both AMD GPUs fit.
    const claims = [
      running("old", ["m"], 0, {
        ranks: [
          {
            nodeId: "m",
            port: 30001,
            distPort: null,
            claim: "HELD",
            resources: {
              kind: "discrete",
              gpuCount: 1,
              vramGb: 30,
              vendor: "nvidia",
            },
          },
        ],
      }),
    ];
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("m", {
            memoryGb: 100,
            gpus: [
              { key: "nvidia:0", vendor: "nvidia", vramGb: 24 },
              { key: "nvidia:1", vendor: "nvidia", vramGb: 8 },
              { key: "nvidia:2", vendor: "nvidia", vramGb: 8 },
              { key: "amd:0", vendor: "amd", vramGb: 16 },
              { key: "amd:1", vendor: "amd", vramGb: 16 },
            ],
          }),
        ],
        instances: claims,
      }),
    );
    const result = ok(
      planner.place(request({ resources: [{ kind: "discrete", gpuCount: 2, vramGb: 6 }] })),
    );
    expect(result.start.placements[0]?.resources.gpus).toEqual(["amd:0", "amd:1"]);
  });

  it("keeps a claim's unified-GPU memory held when the node stops reporting the GPU", () => {
    // 96 GiB taken on a unified GPU of a 128 GiB node; reconnected after a failed detection, the
    // node reports no GPU. A 64 GiB CPU start must not fit in memory the claim still uses.
    const place = (resources: Record<string, unknown>, gpus: PlacementNode["gpus"] = []) =>
      new PlacementPlanner(
        context({
          nodes: [node("m", { memoryGb: 128, gpus })],
          instances: [
            running("old", ["m"], 0, {
              ranks: [{ nodeId: "m", port: 30001, distPort: null, claim: "HELD", resources }],
            }),
          ],
        }),
      ).place(request({ resources: [{ kind: "cpu", ramGb: 64 }] }));
    const discrete = { kind: "discrete", gpuCount: 1, vramGb: 96, gpus: ["nvidia:0"] };
    expect(place({ ...discrete, unifiedGpus: ["nvidia:0"] })).toMatchObject({
      ok: false,
      refusal: { reason: "not_enough_memory" },
    });
    // A claim recorded before claims said which GPUs were unified: held the same way.
    expect(place(discrete)).toMatchObject({ ok: false, refusal: { reason: "not_enough_memory" } });
    // Control: a discrete GPU's VRAM is not node memory.
    expect(place({ ...discrete, unifiedGpus: [] }).ok).toBe(true);
    // Control: reported, the unified GPU charges node memory as before.
    expect(
      place(discrete, [{ key: "nvidia:0", vendor: "nvidia", vramGb: 0, unified: true }]),
    ).toMatchObject({ ok: false, refusal: { reason: "not_enough_memory" } });
  });

  it("charges a recorded shared GPU once when the node reports another unified GPU", () => {
    // 80 GiB recorded on unified nvidia:0; the node now reports only unified nvidia:1. The claim
    // still takes 80 GiB of node memory, once: a 32 GiB CPU start fits on 128 GiB.
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("m", {
            memoryGb: 128,
            gpus: [{ key: "nvidia:1", vendor: "nvidia", vramGb: 0, unified: true }],
          }),
        ],
        instances: [
          running("old", ["m"], 0, {
            ranks: [
              {
                nodeId: "m",
                port: 30001,
                distPort: null,
                claim: "HELD",
                resources: {
                  kind: "discrete",
                  gpuCount: 1,
                  vramGb: 80,
                  gpus: ["nvidia:0"],
                  unifiedGpus: ["nvidia:0"],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(ok(planner.place(request({ resources: [{ kind: "cpu", ramGb: 32 }] }))).ok).toBe(true);
    expect(
      planner.place(request({ runtimeId: "rt-big", resources: [{ kind: "cpu", ramGb: 20 }] })).ok,
    ).toBe(false);
  });

  it("takes a dedicated GPU instead of a second unified one when node memory runs short", () => {
    // 64 GiB of memory, two unified AMD GPUs and one 128 GiB dedicated one: two GPUs of 48 GiB
    // each do not fit as two unified (96 GiB of node memory), but one unified and the dedicated
    // one do.
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("m", {
            memoryGb: 64,
            gpus: [
              { key: "amd:0", vendor: "amd", vramGb: 0, unified: true },
              { key: "amd:1", vendor: "amd", vramGb: 0, unified: true },
              { key: "amd:2", vendor: "amd", vramGb: 128 },
            ],
          }),
        ],
      }),
    );
    const placed = ok(
      planner.place(request({ resources: [{ kind: "discrete", gpuCount: 2, vramGb: 48 }] })),
    );
    expect(placed.start.placements[0]?.resources.gpus).toHaveLength(2);
    expect(placed.start.placements[0]?.resources.gpus).toContain("amd:2");
  });

  it("a GPU over-committed by a claim that recorded it does not block another with room", () => {
    // amd:1 is over-committed (24 GiB recorded on 16 GiB, the hardware shrank): that claim sits
    // there, so amd:0's own 16 GiB are free for a new 16 GiB claim.
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("m", {
            memoryGb: 64,
            gpus: [
              { key: "amd:0", vendor: "amd", vramGb: 16 },
              { key: "amd:1", vendor: "amd", vramGb: 16 },
              { key: "amd:2", vendor: "amd", vramGb: 0, unified: true },
            ],
          }),
        ],
        instances: [
          running("old", ["m"], 0, {
            ranks: [
              {
                nodeId: "m",
                port: 30001,
                distPort: null,
                claim: "HELD",
                resources: {
                  kind: "discrete",
                  gpuCount: 1,
                  vramGb: 24,
                  gpus: ["amd:1"],
                  unifiedGpus: [],
                },
              },
            ],
          }),
        ],
      }),
    );
    const placed = ok(
      planner.place(request({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 16 }] })),
    );
    expect(placed.start.placements[0]?.resources.gpus).toEqual(["amd:0"]);
  });

  it("charges a dedicated GPU gone from the report to another GPU of the claim's own vendor", () => {
    // Recorded on nvidia:0 (16 GiB, no vendor named); the node now reports nvidia:1 and amd:0.
    // The claim keeps its room on NVIDIA: another 16 GiB NVIDIA GPU does not fit on 24 GiB.
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("m", {
            memoryGb: 128,
            gpus: [
              { key: "nvidia:1", vendor: "nvidia", vramGb: 24 },
              { key: "amd:0", vendor: "amd", vramGb: 80 },
            ],
          }),
        ],
        instances: [
          running("old", ["m"], 0, {
            ranks: [
              {
                nodeId: "m",
                port: 30001,
                distPort: null,
                claim: "HELD",
                resources: {
                  kind: "discrete",
                  gpuCount: 1,
                  vramGb: 16,
                  gpus: ["nvidia:0"],
                  unifiedGpus: [],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(
      planner.place(
        request({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 16, vendor: "nvidia" }] }),
      ).ok,
    ).toBe(false);
  });

  it("records which of a claim's GPUs share node memory", () => {
    const planner = new PlacementPlanner(
      context({
        nodes: [
          node("u", {
            memoryGb: 128,
            gpus: [{ key: "nvidia:0", vendor: "nvidia", vramGb: 0, unified: true }],
          }),
        ],
      }),
    );
    const placed = ok(
      planner.place(request({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 40 }] })),
    );
    expect(placed.start.placements[0]?.resources).toMatchObject({
      gpus: ["nvidia:0"],
      unifiedGpus: ["nvidia:0"],
    });
  });

  it("prefers a node free now over one an instance already stopping frees", () => {
    const stopping = running("old", ["h1"], 100, { running: false });
    const planner = new PlacementPlanner(context({ instances: [stopping] }));
    const result = ok(planner.place(request({ labels: ["strix"] })));
    expect(nodesOf(result)).toEqual(["h2"]);
    expect(result.start.blockedBy).toEqual([]);
    expect(result.warnings).toEqual([]);
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
            ranks: [
              {
                nodeId: "b",
                port: 30003,
                distPort: null,
                claim: "HELD",
                resources: { kind: "none" },
              },
            ],
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

  it("a restart fits over its own claim (it overlaps the new one) and keeps its ports", () => {
    const self = running("self", ["h1"], 120, {
      ranks: [
        {
          nodeId: "h1",
          port: 30005,
          distPort: null,
          claim: "HELD",
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

  it("a restart whose port another claim took gets another port of the range", () => {
    const self = running("self", ["h1"], 10, {
      ranks: [
        { nodeId: "h1", port: 30005, distPort: null, claim: "HELD", resources: { kind: "none" } },
      ],
      running: false,
    });
    const thief = running("thief", ["h1"], 10, {
      ranks: [
        { nodeId: "h1", port: 30005, distPort: null, claim: "HELD", resources: { kind: "none" } },
      ],
    });
    const planner = new PlacementPlanner(context({ instances: [self, thief] }));
    const result = ok(
      planner.place(
        request({
          nodeIds: ["h1"],
          restart: { instanceId: "self", ports: [30005], distPort: null },
        }),
      ),
    );
    expect(result.start.placements[0]?.port).toBe(30000);
  });

  it("a restart keeps its own ports only inside the node's current range", () => {
    // The node's range moved from 30000-30009 to 31000-31009 since the instance took 30005 (a
    // dynamic port; the node refuses one outside its range), and its gang's dist port 30006.
    const moved = [
      node("a", { portRange: [31000, 31009] }),
      node("b", { portRange: [31000, 31009] }),
    ];
    const fabrics = [
      {
        id: "f-ab",
        name: "ab",
        members: [
          { nodeId: "a", ip: "10.0.0.1" },
          { nodeId: "b", ip: "10.0.0.2" },
        ],
      },
    ];
    const self = running("self", ["a", "b"], 10, {
      ranks: ["a", "b"].map((nodeId) => ({
        nodeId,
        port: 30005,
        distPort: 30006,
        claim: "HELD" as const,
        resources: { kind: "none" as const },
      })),
    });
    const result = ok(
      new PlacementPlanner(context({ nodes: moved, fabrics, instances: [self] })).place(
        request({
          groupSize: 2,
          resources: [{ kind: "none" }],
          nodeIds: ["a", "b"],
          restart: { instanceId: "self", ports: [30005, 30005], distPort: 30006 },
        }),
      ),
    );
    for (const placement of result.start.placements) {
      expect(placement.port).toBeGreaterThanOrEqual(31000);
      expect(placement.port).toBeLessThanOrEqual(31009);
    }
    expect(result.start.distPort).toBeGreaterThanOrEqual(31000);
    // A version that fixes its port still gets exactly that one, in range or not.
    const fixed = ok(
      new PlacementPlanner(context({ nodes: moved, fabrics, instances: [self] })).place(
        request({
          groupSize: 2,
          resources: [{ kind: "none" }],
          port: { fixed: 30005 },
          nodeIds: ["a", "b"],
          restart: { instanceId: "self", ports: [30005, 30005], distPort: 30006 },
        }),
      ),
    );
    expect(fixed.start.placements.map((placement) => placement.port)).toEqual([30005, 30005]);
  });
});

describe("a restart's old and new claims overlap", () => {
  const box = () => [node("h1", { labels: ["strix"] })];
  const unified = (memoryGb: number): RuntimeResource => ({ kind: "unified", memoryGb });
  const restartOf = (id: string, resources: RuntimeResource[], port = 30000) =>
    request({
      resources,
      nodeIds: ["h1"],
      restart: { instanceId: id, ports: [port], distPort: null },
    });
  const fits = (planner: PlacementPlanner, memoryGb: number) =>
    planner.place(request({ labels: ["strix"], resources: [unified(memoryGb)] })).ok;

  it("restarting one of two models side by side costs its growth, never old + new", () => {
    // A (60) and B (50) on one 126 GiB node; A restarts with 70 while its old run still runs.
    const a = running("a", ["h1"], 60);
    const b = running("b", ["h1"], 50, {
      ranks: [{ nodeId: "h1", port: 30001, distPort: null, claim: "HELD", resources: unified(50) }],
    });
    const planner = new PlacementPlanner(context({ nodes: box(), instances: [a, b] }));
    ok(planner.place(restartOf("a", [unified(70)])));
    // A holds max(60, 70) next to B: 6 GiB are left.
    expect(fits(planner, 7)).toBe(false);
    expect(fits(planner, 6)).toBe(true);
  });

  it("a shrinking restart keeps the old run's room held until it stopped", () => {
    // 126 GiB node, the instance runs with 100 and restarts with 20.
    const planner = new PlacementPlanner(
      context({ nodes: box(), instances: [running("a", ["h1"], 100)] }),
    );
    ok(planner.place(restartOf("a", [unified(20)])));
    expect(fits(planner, 100)).toBe(false);
    expect(fits(planner, 26)).toBe(true);
  });

  it("an instance's loaded old and new claims on a node count once (the larger)", () => {
    const a = running("a", ["h1"], 20, {
      ranks: [
        { nodeId: "h1", port: 30000, distPort: null, claim: "HELD", resources: unified(20) },
        {
          nodeId: "h1",
          port: 30005,
          distPort: null,
          claim: "HELD",
          resources: unified(100),
          previous: true,
        },
      ],
    });
    const planner = new PlacementPlanner(context({ nodes: box(), instances: [a] }));
    // max(20, 100) = 100: 26 free (a sum would leave 6). Both ports stay taken.
    expect(fits(planner, 27)).toBe(false);
    const placed = ok(planner.place(request({ labels: ["strix"], resources: [unified(26)] })));
    expect(placed.start.placements[0]?.port).toBe(30001);
    expect(
      new PlacementPlanner(context({ nodes: box(), instances: [a] })).place(
        request({ labels: ["strix"], resources: [unified(1)], port: { fixed: 30005 } }),
      ),
    ).toMatchObject({ ok: false, refusal: { reason: "port_in_use" } });
  });

  it("a port-changing restart keeps its old port taken for later plans", () => {
    const planner = new PlacementPlanner(
      context({ nodes: box(), instances: [running("a", ["h1"], 10)] }),
    );
    const moved = ok(
      planner.place({
        ...restartOf("a", [unified(10)]),
        launch: { ...restartOf("a", [unified(10)]).launch, port: { fixed: 30005 } },
      }),
    );
    expect(moved.start.placements[0]?.port).toBe(30005);
    expect(
      planner.place(
        request({ labels: ["strix"], resources: [unified(1)], port: { fixed: 30000 } }),
      ),
    ).toMatchObject({ ok: false, refusal: { reason: "port_in_use" } });
  });

  it("prefers the GPUs it held and keeps both held when it moves to another", () => {
    const gpus = () => [
      node("g", {
        labels: ["rtx"],
        memoryGb: 64,
        gpus: [
          { key: "nvidia:0", vendor: "nvidia", vramGb: 24 },
          { key: "nvidia:1", vendor: "nvidia", vramGb: 24 },
        ],
      }),
    ];
    const discrete = (vramGb: number, keys?: string[]) => ({
      kind: "discrete" as const,
      gpuCount: 1,
      vramGb,
      ...(keys ? { gpus: keys } : {}),
    });
    const held = (other: boolean) => [
      running("a", ["g"], 0, {
        ranks: [
          {
            nodeId: "g",
            port: 30000,
            distPort: null,
            claim: "HELD_UNKNOWN",
            resources: discrete(20, ["nvidia:1"]),
          },
        ],
      }),
      ...(other
        ? [
            running("o", ["g"], 0, {
              ranks: [
                {
                  nodeId: "g",
                  port: 30001,
                  distPort: null,
                  claim: "HELD",
                  resources: discrete(4, ["nvidia:1"]),
                },
              ],
            }),
          ]
        : []),
    ];
    const restartOnG = (vramGb: number) =>
      request({
        resources: [discrete(vramGb)],
        nodeIds: ["g"],
        restart: { instanceId: "a", ports: [30000], distPort: null },
        retake: true,
      });
    // The GPU it held fits the change: it stays there (an unchanged retake keeps its GPUs).
    const same = ok(
      new PlacementPlanner(context({ nodes: gpus(), instances: held(false) })).place(
        restartOnG(22),
      ),
    );
    expect(same.start.placements[0]?.resources.gpus).toEqual(["nvidia:1"]);
    // Another claim leaves its GPU 0 GiB free beyond its own: it moves to nvidia:0, and the old
    // run's 20 GiB on nvidia:1 stay held until its stop is proven.
    const planner = new PlacementPlanner(context({ nodes: gpus(), instances: held(true) }));
    const moved = ok(planner.place(restartOnG(22)));
    expect(moved.start.placements[0]?.resources.gpus).toEqual(["nvidia:0"]);
    expect(planner.place(request({ labels: ["rtx"], resources: [discrete(20)] }))).toMatchObject({
      ok: false,
      refusal: { reason: "not_enough_memory" },
    });
  });

  it("a restart that only fits once the old run's claims are gone is refused with that reason", () => {
    // The instance is stopping (100 GiB) and another start (100 GiB) already queued behind its
    // stop. A restart with 20 GiB would fit once the old run's 100 are released, not before.
    const a = running("a", ["h1"], 100, { running: false });
    const b = running("b", ["h1"], 100, {
      ranks: [
        { nodeId: "h1", port: 30001, distPort: null, claim: "HELD", resources: unified(100) },
      ],
    });
    const planner = new PlacementPlanner(context({ nodes: box(), instances: [a, b] }));
    expect(planner.place(restartOf("a", [unified(20)]))).toMatchObject({
      ok: false,
      refusal: { reason: "restart_overlap_no_room", subjectId: "h1" },
    });
    // One that does not fit even then is plain not_enough_memory.
    expect(planner.place(restartOf("a", [unified(100)]))).toMatchObject({
      ok: false,
      refusal: { reason: "not_enough_memory" },
    });
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

  it("an agent never stops an instance whose live launch names a node not at Full control", () => {
    // pair-a holds Full-control nodes, but a launch of it that may still run (released without
    // proof) named Relay-only s8: its stop reaches s8, so an agent may not make it.
    const nodes = lab().map((n) => (n.id === "s8" ? { ...n, trust: "RELAY" as const } : n));
    // s5-s8 are taken by instances an agent may not stop.
    const others = [
      running("contrib", ["s5"], 120, { contributed: true }),
      running("interactive", ["s6"], 120, { interactiveStop: true }),
      running("spans-relay", ["s7", "s8"], 120),
    ];
    const instances = [
      ...others,
      running("pair-a", ["s1", "s2"], 120, { cleanupNodeIds: ["s8"] }),
      running("pair-b", ["s3", "s4"], 120),
    ];
    const agent = new PlacementPlanner(context({ nodes, instances, agent: true }));
    const result = ok(agent.place(request({ ...QWEN_FLASH, labels: ["spark"], preempt: true })));
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["pair-b"]);
    // A node that is gone (not the caller's) counts as not Full.
    const gone = new PlacementPlanner(
      context({
        nodes,
        agent: true,
        instances: [
          ...others,
          running("pair-a", ["s1", "s2"], 120, { cleanupNodeIds: ["gone"] }),
          running("pair-b", ["s3", "s4"], 120, { cleanupNodeIds: ["s5"] }),
        ],
      }),
    );
    expect(
      ok(gone.place(request({ ...QWEN_FLASH, labels: ["spark"], preempt: true }))).stops.map(
        (stop) => stop.instanceId,
      ),
    ).toEqual(["pair-b"]);
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

  it("on one shared fabric, stops one two-node instance rather than two singles", () => {
    const instances = [
      running("glm", ["s1", "s2"], 110),
      ...["s3", "s4", "s5", "s6", "s7", "s8"].map((id) => running(`q-${id}`, [id], 100)),
    ];
    const planner = new PlacementPlanner(context({ fabrics: [SWITCH], instances }));
    const result = ok(
      planner.place(
        request({ groupSize: 2, resources: [{ kind: "unified", memoryGb: 96 }], preempt: true }),
      ),
    );
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["glm"]);
    expect(nodesOf(result).sort()).toEqual(["s1", "s2"]);
  });
});

describe("review fixes", () => {
  const twoGpus = () =>
    node("gpu", {
      memoryGb: 64,
      gpus: [
        { key: "nvidia:0", vendor: "nvidia", vramGb: 12 },
        { key: "nvidia:1", vendor: "nvidia", vramGb: 12 },
      ],
    });
  const discrete = (vramGb: number): RuntimeResource[] => [
    { kind: "discrete", gpuCount: 1, vramGb },
  ];

  it("records the GPUs a rank takes and replays them, whatever the instance ids", () => {
    // Place b, c, d (4 each) and a (6) in that order, then carry the claims to a new plan.
    const first = new PlacementPlanner(context({ nodes: [twoGpus()] }));
    const claims: PlacementInstance[] = [];
    for (const [id, vram] of [
      ["b", 4],
      ["c", 4],
      ["d", 4],
      ["a", 6],
    ] as const) {
      const placed = ok(first.place(request({ runtimeId: `rt-${id}`, resources: discrete(vram) })));
      const placement = placed.start.placements[0];
      if (!placement) throw new Error("placement");
      expect(placement.resources.gpus).toHaveLength(1);
      claims.push(
        running(id, ["gpu"], 0, {
          ranks: [
            {
              nodeId: "gpu",
              port: placement.port,
              distPort: null,
              claim: "HELD",
              resources: placement.resources,
            },
          ],
        }),
      );
    }
    // 24 - 18 = 6 GiB are left on one GPU: a 6 GiB start fits there in the next plan too.
    const next = new PlacementPlanner(context({ nodes: [twoGpus()], instances: claims }));
    expect(ok(next.place(request({ runtimeId: "rt-e", resources: discrete(6) }))).ok).toBe(true);
    const full = next.place(request({ runtimeId: "rt-f", resources: discrete(2) }));
    expect(full.ok).toBe(false);
  });

  it("never admits more VRAM than the GPUs have, even for over-committed claims", () => {
    // 26 GiB claimed on 24 GiB without recorded GPUs (claims from before lane F).
    const claims = [
      running("x", ["gpu"], 0, {
        ranks: [
          { nodeId: "gpu", port: 30000, distPort: null, claim: "HELD", resources: discrete(10)[0] },
        ],
      }),
      running("y", ["gpu"], 0, {
        ranks: [
          { nodeId: "gpu", port: 30001, distPort: null, claim: "HELD", resources: discrete(10)[0] },
        ],
      }),
      running("z", ["gpu"], 0, {
        ranks: [
          { nodeId: "gpu", port: 30002, distPort: null, claim: "HELD", resources: discrete(6)[0] },
        ],
      }),
    ];
    const planner = new PlacementPlanner(context({ nodes: [twoGpus()], instances: claims }));
    expect(planner.place(request({ resources: discrete(2) })).ok).toBe(false);
  });

  it("keeps the fingerprinted warning text free of live numbers", () => {
    const nodes = [node("h1", { liveFreeMemoryGb: 10 })];
    const planner = new PlacementPlanner(context({ nodes }));
    const result = ok(planner.place(request()));
    expect(result.warnings).toEqual([
      {
        code: "low_free_memory",
        nodeId: "h1",
        detail: "The node reports less free memory than this rank declares.",
      },
    ]);
  });

  it("explains a multi-node refusal by the fabric's nodes, not unrelated ones", () => {
    const nodes = [
      ...lab().map((n) => (n.id === "s1" ? { ...n, held: true } : n)),
      node("far", { online: false }),
    ];
    const planner = new PlacementPlanner(
      context({ nodes, fabrics: [PAIRS[0] as PlacementFabric] }),
    );
    const result = planner.place(request({ ...GLM }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("node_held");
  });

  it("says no_free_ports when stopping others would free memory but not a port", () => {
    const nodes = [node("a", { portRange: [30000, 30000] })];
    const planner = new PlacementPlanner(
      context({ nodes, instances: [running("busy", ["a"], 126)] }),
    );
    const result = planner.place(request({ preempt: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("no_free_ports");
  });

  it("never stops an instance the chosen placement does not need", () => {
    // Second review's repro: seeding S moved the best fit, but B + A fit without stopping S.
    const nodes = [
      node("a", { memoryGb: 8, gpus: [{ key: "nvidia:0", vendor: "nvidia", vramGb: 24 }] }),
      node("b", { memoryGb: 7 }),
      node("e", { memoryGb: 2 }),
    ];
    const s = running("s", ["a", "e"], 2);
    const planner = new PlacementPlanner(
      context({ nodes, instances: [s], fabrics: [fabric("abe", ["a", "b", "e"])] }),
    );
    const result = planner.place(
      request({
        groupSize: 2,
        resources: [
          { kind: "unified", memoryGb: 5 },
          { kind: "discrete", gpuCount: 1, vramGb: 10, ramGb: 5 },
        ],
        preempt: true,
      }),
    );
    expect(ok(result).stops).toEqual([]);
    expect(planner.stops).toEqual([]);
    expect(nodesOf(result)).toEqual(["b", "a"]);
  });

  it("replays claims that recorded their GPUs before older claims", () => {
    const gpuNode = node("gpu", {
      memoryGb: 64,
      gpus: [
        { key: "nvidia:0", vendor: "nvidia", vramGb: 24 },
        { key: "nvidia:1", vendor: "nvidia", vramGb: 24 },
      ],
    });
    const claim = (id: string, resources: unknown, port: number) =>
      running(id, ["gpu"], 0, {
        ranks: [{ nodeId: "gpu", port, distPort: null, claim: "HELD", resources }],
      });
    const planner = new PlacementPlanner(
      context({
        nodes: [gpuNode],
        instances: [
          // "a" predates the record; "b" recorded nvidia:0. "a" must land on nvidia:1.
          claim("a", { kind: "discrete", gpuCount: 1, vramGb: 20 }, 30000),
          claim("b", { kind: "discrete", gpuCount: 1, vramGb: 20, gpus: ["nvidia:0"] }, 30001),
        ],
      }),
    );
    expect(
      planner.place(request({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 5 }] })).ok,
    ).toBe(false);
    expect(
      ok(planner.place(request({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 4 }] })))
        .start.placements[0]?.resources.gpus,
    ).toHaveLength(1);
  });

  it("a restart takes the new version's fixed port", () => {
    const self = running("self", ["h1"], 10, {
      ranks: [
        { nodeId: "h1", port: 30005, distPort: null, claim: "HELD", resources: { kind: "none" } },
      ],
    });
    const planner = new PlacementPlanner(context({ instances: [self] }));
    const result = ok(
      planner.place(
        request({
          port: { fixed: 31000 },
          nodeIds: ["h1"],
          restart: { instanceId: "self", ports: [30005], distPort: null },
        }),
      ),
    );
    expect(result.start.placements[0]?.port).toBe(31000);
  });
});

/** A fabric with explicit member IPs (node id → IP), in this order. */
function netFabric(name: string, ips: Record<string, string>): PlacementFabric {
  return {
    id: `f-${name}`,
    name,
    members: Object.entries(ips).map(([nodeId, ip]) => ({ nodeId, ip })),
  };
}

/** A Relay-only node that froze the `net` fabric (or `fabricId`) with these member IPs. */
function relayNode(
  id: string,
  memberIps: readonly string[],
  fabricId = "f-net",
  name = "net",
): PlacementNode {
  return node(id, { trust: "RELAY", frozenFabrics: [{ fabricId, name, memberIps }] });
}

/** A node row as `loadPlacementContext` reads it (b, online, no hardware info). */
function nodeRow(overrides: Partial<PlacementNodeRow> = {}): PlacementNodeRow {
  return {
    id: "b",
    slug: "b",
    connection: "ONLINE",
    trust: "FULL",
    trustChangedAt: null,
    trustLowerRequestedAt: null,
    labels: [],
    holdAt: null,
    portStart: 30000,
    portEnd: 30009,
    heldDefinitions: [],
    frozenFabrics: null,
    fabricsHash: null,
    heldFabricsHash: null,
    declaredResources: { memoryGb: 128 },
    nodeInfo: null,
    nodeMetrics: null,
    nodeMetricsAt: null,
    ...overrides,
  };
}

const NET = netFabric("net", { a: "10.0.0.1", b: "10.0.0.2", c: "10.0.0.3" });
const PAIR = { groupSize: 2, resources: [{ kind: "unified", memoryGb: 10 }] as RuntimeResource[] };

describe("Relay-only nodes and their frozen fabrics", () => {
  it("accepts a Relay-only worker whose frozen fabric holds the head", () => {
    const nodes = [node("a"), relayNode("b", ["10.0.0.1", "10.0.0.2"])];
    const planner = new PlacementPlanner(context({ nodes, fabrics: [NET] }));
    const result = ok(planner.place(request(PAIR)));
    expect(nodesOf(result)).toEqual(["a", "b"]);
    expect(result.start.fabric?.headAddr).toBe("10.0.0.1");
  });

  it("makes another member the head when a Relay-only node froze the fabric without it", () => {
    // b froze the fabric before a joined: with a as the head b would refuse (definition_frozen).
    const nodes = [node("a"), relayNode("b", ["10.0.0.2", "10.0.0.3"]), node("c")];
    const planner = new PlacementPlanner(context({ nodes, fabrics: [NET] }));
    const result = ok(planner.place(request(PAIR)));
    expect(nodesOf(result)).toEqual(["b", "a"]);
    expect(result.start.fabric?.headAddr).toBe("10.0.0.2");
  });

  it("leaves out a Relay-only node that would refuse every head, and uses another set", () => {
    const nodes = [node("a"), relayNode("b", ["10.9.0.2"], "f-old"), node("c")];
    const planner = new PlacementPlanner(context({ nodes, fabrics: [NET] }));
    expect(nodesOf(planner.place(request(PAIR)))).toEqual(["a", "c"]);
  });

  it("refuses head_not_in_frozen_fabric when no node set works", () => {
    const nodes = [node("a"), relayNode("b", ["10.0.0.1", "10.0.0.2"], "f-old")];
    const fabrics = [netFabric("net", { a: "10.0.0.1", b: "10.0.0.2" })];
    const result = new PlacementPlanner(context({ nodes, fabrics })).place(
      request({ ...PAIR, preempt: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("head_not_in_frozen_fabric");
  });

  it("explicit nodes: refuses naming the node that would refuse, and accepts its own head", () => {
    const nodes = [node("a"), relayNode("b", ["10.0.0.2", "10.0.0.3"]), node("c")];
    const planner = new PlacementPlanner(context({ nodes, fabrics: [NET] }));
    const refused = planner.place(request({ ...PAIR, nodeIds: ["a", "b"] }));
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.refusal).toMatchObject({
        reason: "head_not_in_frozen_fabric",
        subjectId: "b",
      });
    const swapped = ok(planner.place(request({ ...PAIR, nodeIds: ["b", "a"] })));
    expect(swapped.start.fabric?.headAddr).toBe("10.0.0.2");
  });

  it("loads the fabrics a node froze while it reports Relay only", () => {
    const frozen = [
      { fabricId: "f-net", name: "net", selfIp: "10.0.0.2", memberIps: ["10.0.0.1", "10.0.0.2"] },
    ];
    const now = new Date();
    expect(
      placementNodeOf(nodeRow({ trust: "RELAY", frozenFabrics: frozen }), now, new Set())
        .frozenFabrics,
    ).toEqual([{ fabricId: "f-net", name: "net", memberIps: ["10.0.0.1", "10.0.0.2"] }]);
    // Unreadable: nothing frozen, so the node refuses any head (as it would).
    expect(
      placementNodeOf(nodeRow({ trust: "RELAY", frozenFabrics: [{ bad: true }] }), now, new Set())
        .frozenFabrics,
    ).toEqual([]);
    expect(placementNodeOf(nodeRow({ trust: "RELAY" }), now, new Set()).frozenFabrics).toEqual([]);
    expect(placementNodeOf(nodeRow(), now, new Set()).frozenFabrics).toBeNull();
  });

  it("a pending lower in sync is checked against its current memberships", () => {
    const now = new Date();
    const pending = (held: string | null) =>
      placementNodeOf(
        nodeRow({ trustLowerRequestedAt: new Date(0), fabricsHash: "h1", heldFabricsHash: held }),
        now,
        new Set(),
      );
    expect(pending("h1").trust).toBe("RELAY");
    expect(pending("h1").frozenFabrics).toBe("current");
    // Not in sync: what it will freeze is unknown, so it is not checked.
    expect(pending("h0").frozenFabrics).toBeNull();
    // Current memberships hold the head, so the planner places it (the CLI agrees).
    for (const b of [pending("h1"), pending("h0")]) {
      const planner = new PlacementPlanner(context({ nodes: [node("a"), b], fabrics: [NET] }));
      expect(nodesOf(planner.place(request(PAIR)))).toEqual(["a", "b"]);
    }
  });

  it("a launch that pins a fabric needs the frozen copy to carry that name", () => {
    // b froze f-net under its old name: the CLI refuses a pinned launch.fabric that differs.
    const nodes = [node("a"), relayNode("b", ["10.0.0.1", "10.0.0.2"], "f-net", "old-name")];
    const fabrics = [netFabric("net", { a: "10.0.0.1", b: "10.0.0.2" })];
    const planner = new PlacementPlanner(context({ nodes, fabrics }));
    const pinned = planner.place(request({ ...PAIR, fabric: "net" }));
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.refusal.reason).toBe("head_not_in_frozen_fabric");
    expect(nodesOf(planner.place(request(PAIR)))).toEqual(["a", "b"]);
  });

  it("names the first refusing node of a set-level refusal", () => {
    const nodes = [node("a"), relayNode("b", ["10.0.0.2"], "f-old")];
    const fabrics = [netFabric("net", { a: "10.0.0.1", b: "10.0.0.2" })];
    const result = new PlacementPlanner(context({ nodes, fabrics })).place(request(PAIR));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.refusal).toMatchObject({ reason: "head_not_in_frozen_fabric", subjectId: "b" });
  });

  it("stops after the set budget when every Relay-only node refuses every head, deterministically", () => {
    const ids = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
    const nodes = ids.map((id) => relayNode(id, ["10.9.0.1"], "f-old"));
    const fabrics = [
      netFabric("net", Object.fromEntries(ids.map((id, index) => [id, `10.0.0.${index + 1}`]))),
    ];
    const plan = (ctx: PlacementContext) =>
      new PlacementPlanner(ctx).place(request({ groupSize: 4, resources: PAIR.resources }));
    const forward = plan(context({ nodes, fabrics }));
    expect(forward.ok).toBe(false);
    if (!forward.ok)
      expect(forward.refusal).toMatchObject({
        reason: "head_not_in_frozen_fabric",
        subjectId: "n1",
      });
    expect(plan(context({ nodes: [...nodes].reverse(), fabrics }))).toEqual(forward);
  });

  it("names no_free_ports over head_not_in_frozen_fabric (the closer miss)", () => {
    // {a, b} fails only on the dist port (b's second port is taken); any set with c fails the
    // frozen rule.
    const nodes = [
      node("a", { portRange: [30000, 30001] }),
      node("b", { portRange: [30000, 30001] }),
      relayNode("c", ["10.9.0.3"], "f-old"),
    ];
    const taken = running("x", ["b"], 0, {
      ranks: [
        { nodeId: "b", port: 30001, distPort: null, claim: "HELD", resources: { kind: "none" } },
      ],
    });
    const result = new PlacementPlanner(
      context({ nodes, fabrics: [NET], instances: [taken] }),
    ).place(request(PAIR));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("no_free_ports");
  });
});

describe("instances already stopping", () => {
  const strix = () => [node("h1", { labels: ["strix"] })];

  it("plans over a stopping instance's HELD claims and waits for it instead of refusing", () => {
    const old = running("old", ["h1"], 100, { running: false });
    const planner = new PlacementPlanner(context({ nodes: strix(), instances: [old] }));
    const result = ok(planner.place(request({ labels: ["strix"] })));
    expect(nodesOf(result)).toEqual(["h1"]);
    // Its port stays taken until the node releases the claim.
    expect(result.start.placements[0]?.port).toBe(30001);
    expect(result.start.blockedBy).toEqual(["old"]);
    expect(result.stops).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "waits_for_stop", nodeId: "h1" }),
    ]);
    // The same instance still running leaves no room.
    const busy = new PlacementPlanner(
      context({ nodes: strix(), instances: [running("old", ["h1"], 100)] }),
    ).place(request({ labels: ["strix"] }));
    expect(busy.ok).toBe(false);
  });

  it("keeps counting a HELD_UNKNOWN claim: no stop releases it", () => {
    const markedStopped = running("old", ["h1"], 100, {
      running: false,
      ranks: [
        {
          nodeId: "h1",
          port: 30000,
          distPort: null,
          claim: "HELD_UNKNOWN",
          resources: { kind: "unified", memoryGb: 100 },
        },
      ],
    });
    const result = new PlacementPlanner(
      context({ nodes: strix(), instances: [markedStopped] }),
    ).place(request({ labels: ["strix"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("not_enough_memory");
  });

  it("waits for a stop already requested rather than stopping another instance", () => {
    const nodes = [node("h1", { labels: ["strix"] }), node("h2", { labels: ["strix"] })];
    const instances = [
      running("old", ["h1"], 100, { running: false }),
      running("own", ["h2"], 100),
    ];
    const result = ok(
      new PlacementPlanner(context({ nodes, instances })).place(
        request({ labels: ["strix"], preempt: true }),
      ),
    );
    expect(nodesOf(result)).toEqual(["h1"]);
    expect(result.stops).toEqual([]);
    expect(result.start.blockedBy).toEqual(["old"]);
  });

  it("an agent waits only on a Full node and never stops anything", () => {
    const nodes = [
      node("h1", { labels: ["strix"], trust: "RELAY" }),
      node("h2", { labels: ["strix"] }),
    ];
    const instances = [
      running("on-relay", ["h1"], 100, { running: false }),
      running("on-full", ["h2"], 100, { running: false }),
    ];
    const result = ok(
      new PlacementPlanner(context({ agent: true, nodes, instances })).place(
        request({ labels: ["strix"], preempt: true }),
      ),
    );
    expect(nodesOf(result)).toEqual(["h2"]);
    expect(result.start.blockedBy).toEqual(["on-full"]);
    expect(result.stops).toEqual([]);
  });

  it("shares the room a stopping instance frees across place() calls of one planner", () => {
    const old = running("old", ["h1"], 100, { running: false });
    const planner = new PlacementPlanner(context({ nodes: strix(), instances: [old] }));
    const sixty = request({ labels: ["strix"], resources: [{ kind: "unified", memoryGb: 60 }] });
    const first = ok(planner.place(sixty));
    const second = ok(planner.place(sixty));
    expect([first.start.blockedBy, second.start.blockedBy]).toEqual([["old"], ["old"]]);
    expect([first, second].map((result) => result.start.placements[0]?.port)).toEqual([
      30001, 30002,
    ]);
    const third = planner.place(sixty);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.refusal.reason).toBe("not_enough_memory");
  });

  it("once restarted, a stopping instance is no longer waited for", () => {
    const self = running("self", ["h1"], 10, { running: false });
    const planner = new PlacementPlanner(context({ nodes: strix(), instances: [self] }));
    ok(
      planner.place(
        request({
          resources: [{ kind: "unified", memoryGb: 10 }],
          nodeIds: ["h1"],
          restart: { instanceId: "self", ports: [30000], distPort: null },
        }),
      ),
    );
    const next = ok(planner.place(request({ labels: ["strix"] })));
    expect(next.start.blockedBy).toEqual([]);
    expect(next.warnings).toEqual([]);
  });

  it("a restart of a stopping instance never waits for itself", () => {
    const self = running("self", ["h1"], 120, { running: false });
    const planner = new PlacementPlanner(context({ nodes: strix(), instances: [self] }));
    const result = ok(
      planner.place(
        request({
          resources: [{ kind: "unified", memoryGb: 120 }],
          nodeIds: ["h1"],
          restart: { instanceId: "self", ports: [30000], distPort: null },
        }),
      ),
    );
    expect(result.start.blockedBy).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("dist port across node sets", () => {
  const nodes = () => [
    node("a", { portRange: [30000, 30001] }),
    node("b", { portRange: [30000, 30001] }),
    node("c", { portRange: [30000, 30009] }),
  ];
  // b's second port is taken, so no set with b has a dist port free on every rank.
  const taken = running("x", ["b"], 0, {
    ranks: [
      { nodeId: "b", port: 30001, distPort: null, claim: "HELD", resources: { kind: "none" } },
    ],
  });

  it("tries another node set when the first has no dist port free on every rank", () => {
    const planner = new PlacementPlanner(
      context({ nodes: nodes(), fabrics: [NET], instances: [taken] }),
    );
    const result = ok(planner.place(request(PAIR)));
    expect(nodesOf(result)).toEqual(["a", "c"]);
    expect(result.start.distPort).toBe(30001);
  });

  it("refuses no_free_ports when no node set has one", () => {
    const fabrics = [netFabric("net", { a: "10.0.0.1", b: "10.0.0.2" })];
    const result = new PlacementPlanner(
      context({ nodes: nodes().slice(0, 2), fabrics, instances: [taken] }),
    ).place(request(PAIR));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("no_free_ports");
      expect(result.refusal.message).toContain("dist port");
    }
  });
});

describe("dist port and the members' port ranges", () => {
  const pairFabric = () => [netFabric("net", { a: "10.0.0.1", b: "10.0.0.2" })];

  it("refuses fabric_port_ranges_disjoint, naming the nodes, when the ranges share no port", () => {
    const nodes = [
      node("a", { portRange: [30000, 30009] }),
      node("b", { portRange: [31000, 31009] }),
    ];
    for (const nodeIds of [["a", "b"], undefined]) {
      const result = new PlacementPlanner(context({ nodes, fabrics: pairFabric() })).place(
        request({ ...PAIR, ...(nodeIds ? { nodeIds } : {}) }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.reason).toBe("fabric_port_ranges_disjoint");
        expect(result.refusal.message).toContain("a (30000-30009)");
        expect(result.refusal.message).toContain("b (31000-31009)");
      }
    }
  });

  it("takes the dist port from the intersection, moving a rank off the only common port", () => {
    // The ranges overlap in one port, which b's own (lowest) port would otherwise take.
    const nodes = [
      node("a", { portRange: [30000, 30009] }),
      node("b", { portRange: [30009, 30018] }),
    ];
    for (const nodeIds of [["a", "b"], undefined]) {
      const result = ok(
        new PlacementPlanner(context({ nodes, fabrics: pairFabric() })).place(
          request({ ...PAIR, ...(nodeIds ? { nodeIds } : {}) }),
        ),
      );
      expect(result.start.distPort).toBe(30009);
      const ports = Object.fromEntries(
        result.start.placements.map((placement) => [placement.nodeId, placement.port]),
      );
      expect(ports).toEqual({ a: 30000, b: 30010 });
    }
  });

  it("still says no_free_ports when the common ports are all taken", () => {
    const nodes = [
      node("a", { portRange: [30000, 30009] }),
      node("b", { portRange: [30009, 30009] }),
    ];
    const result = new PlacementPlanner(context({ nodes, fabrics: pairFabric() })).place(
      request(PAIR),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("no_free_ports");
  });
});

describe("dist port on restarts", () => {
  it("moves a restart's serving port off the only common port (never a fixed one), and says disjoint before trying its own dist port", () => {
    const fabrics = [netFabric("net", { a: "10.0.0.1", b: "10.0.0.2" })];
    const overlapOne = [
      node("a", { portRange: [30000, 30009] }),
      node("b", { portRange: [30009, 30018] }),
    ];
    // A restart onto two nodes with no dist port yet: b's kept serving port 30009 is the one
    // common port. Kept ports are a preference, as a start's: b's moves, and 30009 is the dist
    // port.
    const restart = { instanceId: "i-1", ports: [30000, 30009], distPort: null };
    const moved = ok(
      new PlacementPlanner(context({ nodes: overlapOne, fabrics })).place(
        request({ ...PAIR, nodeIds: ["a", "b"], restart }),
      ),
    );
    expect(moved.start.placements.map((placement) => placement.port)).toEqual([30000, 30010]);
    expect(moved.start.distPort).toBe(30009);
    // A fixed serving port never moves: the one common port stays taken.
    const fixed = new PlacementPlanner(context({ nodes: overlapOne, fabrics })).place(
      request({
        ...PAIR,
        port: { fixed: 30009 },
        nodeIds: ["a", "b"],
        restart: { instanceId: "i-1", ports: [30009, 30009], distPort: null },
      }),
    );
    expect(fixed.ok).toBe(false);
    if (!fixed.ok) expect(fixed.refusal.reason).toBe("no_free_ports");
    const disjoint = [
      node("a", { portRange: [30000, 30009] }),
      node("b", { portRange: [31000, 31009] }),
    ];
    const result = new PlacementPlanner(context({ nodes: disjoint, fabrics })).place(
      request({
        ...PAIR,
        nodeIds: ["a", "b"],
        restart: { instanceId: "i-1", ports: [30000, 31000], distPort: 30001 },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("fabric_port_ranges_disjoint");
  });
});

describe("unified GPUs (GB10, APUs)", () => {
  const SPARK_GPU = { key: "nvidia:0", vendor: "nvidia" as const, vramGb: 0, unified: true };
  const discrete = (vramGb: number, ramGb?: number): RuntimeResource[] => [
    { kind: "discrete", gpuCount: 1, vramGb, ...(ramGb ? { ramGb } : {}) },
  ];

  it("loads a GB10 node's GPU as unified, sharing the node's usable memory", () => {
    const placement = placementNodeOf(
      nodeRow({
        declaredResources: { reservedMemoryGb: 10 },
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 131072,
          unifiedMemoryMiB: 131072,
          gpus: [{ vendor: "nvidia", index: 0, name: "NVIDIA GB10", vramTotalMiB: null }],
        },
      }),
      new Date(),
      new Set(),
    );
    // 128 GiB − 10 reserved − 2 headroom.
    expect(placement.memoryGb).toBe(116);
    expect(placement.gpus).toEqual([
      { key: "nvidia:0", vendor: "nvidia", vramGb: 0, unified: true },
    ]);
  });

  it("takes a discrete rank's VRAM on a unified GPU from node memory", () => {
    const planner = new PlacementPlanner(
      context({ nodes: [node("s1", { memoryGb: 126, gpus: [SPARK_GPU] })], fabrics: [] }),
    );
    expect(nodesOf(planner.place(request({ resources: discrete(60, 4) })))).toEqual(["s1"]);
    // 126 − 64 = 62 left: a 60 GiB rank with 4 GiB of RAM no longer fits, a 50 GiB one does.
    const tooBig = planner.place(request({ resources: discrete(60, 4) }));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.refusal.reason).toBe("not_enough_memory");
    expect(nodesOf(planner.place(request({ resources: discrete(50) })))).toEqual(["s1"]);
    // 12 GiB left for unified claims too.
    expect(planner.place(request({ resources: [{ kind: "unified", memoryGb: 13 }] })).ok).toBe(
      false,
    );
    expect(planner.place(request({ resources: [{ kind: "unified", memoryGb: 12 }] })).ok).toBe(
      true,
    );
  });

  it("places on a declared unified GPU (a hand-declared Strix Halo) from node memory", () => {
    const strix = placementNodeOf(
      nodeRow({
        declaredResources: {
          kind: "unified",
          memoryGb: 128,
          gpus: [{ vendor: "amd", index: 0, unified: true }],
        },
      }),
      new Date(),
      new Set(),
    );
    expect(strix.memoryGb).toBe(126);
    expect(strix.gpus).toEqual([{ key: "amd:0", vendor: "amd", vramGb: 0, unified: true }]);
    const planner = new PlacementPlanner(context({ nodes: [strix], fabrics: [] }));
    const amd = (vramGb: number): RuntimeResource[] => [
      { kind: "discrete", gpuCount: 1, vramGb, vendor: "amd" },
    ];
    expect(nodesOf(planner.place(request({ resources: amd(100) })))).toEqual(["b"]);
    expect(planner.place(request({ resources: amd(30) })).ok).toBe(false);
    expect(planner.place(request({ resources: [{ kind: "unified", memoryGb: 26 }] })).ok).toBe(
      true,
    );
  });

  it("warns about low free memory counting VRAM on a unified GPU", () => {
    const planner = new PlacementPlanner(
      context({
        nodes: [node("s1", { memoryGb: 126, gpus: [SPARK_GPU], liveFreeMemoryGb: 50 })],
        fabrics: [],
      }),
    );
    const result = ok(planner.place(request({ resources: discrete(60) })));
    expect(result.warnings.map((warning) => warning.code)).toEqual(["low_free_memory"]);
  });

  it("frees a unified GPU's VRAM back to node memory when preempting", () => {
    const held: PlacementInstance = {
      ...running("old", ["s1"], 0),
      ranks: [
        {
          nodeId: "s1",
          port: 30000,
          distPort: null,
          claim: "HELD",
          resources: { kind: "discrete", gpuCount: 1, vramGb: 100, gpus: ["nvidia:0"] },
        },
      ],
    };
    const planner = new PlacementPlanner(
      context({
        nodes: [node("s1", { memoryGb: 126, gpus: [SPARK_GPU] })],
        fabrics: [],
        instances: [held],
      }),
    );
    const big = request({ resources: [{ kind: "unified", memoryGb: 120 }] });
    expect(planner.place(big).ok).toBe(false);
    const result = ok(planner.place({ ...big, preempt: true }));
    expect(result.stops.map((stop) => stop.instanceId)).toEqual(["old"]);
    expect(nodesOf(result)).toEqual(["s1"]);
  });

  it("takes VRAM reserved on a unified GPU from node memory", () => {
    const placement = placementNodeOf(
      nodeRow({
        declaredResources: { reservedVramGb: { "nvidia:0": 6 } },
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 131072,
          unifiedMemoryMiB: 131072,
          gpus: [{ vendor: "nvidia", index: 0, vramTotalMiB: null, apu: true }],
        },
      }),
      new Date(),
      new Set(),
    );
    // 128 GiB − 6 reserved on the GPU − 2 headroom.
    expect(placement.memoryGb).toBe(120);
  });

  it("counts existing claims on a unified GPU against node memory", () => {
    const held: PlacementInstance = {
      ...running("old", ["s1"], 0),
      ranks: [
        {
          nodeId: "s1",
          port: 30000,
          distPort: null,
          claim: "HELD",
          resources: { kind: "discrete", gpuCount: 1, vramGb: 100, gpus: ["nvidia:0"] },
        },
      ],
    };
    const planner = new PlacementPlanner(
      context({
        nodes: [node("s1", { memoryGb: 126, gpus: [SPARK_GPU] })],
        fabrics: [],
        instances: [held],
      }),
    );
    expect(planner.place(request({ resources: [{ kind: "unified", memoryGb: 27 }] })).ok).toBe(
      false,
    );
    expect(planner.place(request({ resources: [{ kind: "unified", memoryGb: 26 }] })).ok).toBe(
      true,
    );
  });
});

describe("definition slots (RUNTIME_DEFINITIONS_MAX)", () => {
  const GB20: RuntimeResource = { kind: "unified", memoryGb: 20 };
  /** `count` version ids a node already requires (`v-0` ...), plus `extra`. */
  const required = (count: number, ...extra: string[]) =>
    new Set([...Array.from({ length: count }, (_, index) => `v-${index}`), ...extra]);
  const withRequired = (ids: ReadonlySet<string>, id = "h1") =>
    lab().map((entry) => (entry.id === id ? { ...entry, requiredVersionIds: ids } : entry));

  it("refuses a new version on a Full-control node that already requires 128, allows one it requires", () => {
    const planner = new PlacementPlanner(context({ nodes: withRequired(required(128)) }));
    const refused = planner.place(request({ nodeIds: ["h1"] }));
    expect(refused).toMatchObject({
      ok: false,
      refusal: { reason: "definition_slots_full", subjectId: "h1" },
    });
    expect(refused.ok ? "" : refused.refusal.message).toContain("128");
    // A version the node already requires takes no new slot.
    ok(planner.place(request({ nodeIds: ["h1"], versionId: "v-7" })));
    // A node-origin runtime's version lives on the node: no slot either.
    ok(planner.place(request({ nodeIds: ["h1"], nodeOrigin: true })));
  });

  it("an unpinned start goes to another node", () => {
    const result = ok(
      new PlacementPlanner(context({ nodes: withRequired(required(128)) })).place(
        request({ labels: ["strix"] }),
      ),
    );
    expect(result.start.placements[0]?.nodeId).toBe("h2");
    // Every node full: the refusal says why.
    const full = lab().map((entry) => ({ ...entry, requiredVersionIds: required(128) }));
    expect(new PlacementPlanner(context({ nodes: full })).place(request())).toMatchObject({
      ok: false,
      refusal: { reason: "definition_slots_full", subjectId: null },
    });
  });

  it("counts several place() calls of one planner", () => {
    const planner = new PlacementPlanner(context({ nodes: withRequired(required(127)) }));
    ok(planner.place(request({ nodeIds: ["h1"], versionId: "v-a", runtimeId: "rt-a" })));
    // The same version again needs no new slot; another one would be the 129th.
    ok(planner.place(request({ nodeIds: ["h1"], versionId: "v-a", runtimeId: "rt-a" })));
    expect(
      planner.place(request({ nodeIds: ["h1"], versionId: "v-b", runtimeId: "rt-b" })),
    ).toMatchObject({ ok: false, refusal: { reason: "definition_slots_full" } });
  });

  it("a restart counts the old and the new version until the old run's stop is proven", () => {
    const self = running("self", ["h1"], 20, {
      ranks: [
        {
          nodeId: "h1",
          port: 30005,
          distPort: null,
          claim: "HELD",
          resources: { kind: "unified", memoryGb: 20 },
        },
      ],
    });
    const restart = { instanceId: "self", ports: [30005], distPort: null };
    // The instance's own old version is one of the 127 the node requires: the new one fits.
    const room = new PlacementPlanner(
      context({ nodes: withRequired(required(126, "v-old")), instances: [self] }),
    );
    ok(room.place(request({ nodeIds: ["h1"], restart, resources: [GB20] })));
    // Its old version stays required beside the new one: nothing else fits after it.
    expect(
      room.place(request({ nodeIds: ["h1"], versionId: "v-other", runtimeId: "rt-other" })),
    ).toMatchObject({ ok: false, refusal: { reason: "definition_slots_full" } });
    // At 128 with its old version, the new one would be the 129th.
    const full = new PlacementPlanner(
      context({ nodes: withRequired(required(127, "v-old")), instances: [self] }),
    );
    expect(full.place(request({ nodeIds: ["h1"], restart, resources: [GB20] }))).toMatchObject({
      ok: false,
      refusal: { reason: "definition_slots_full", subjectId: "h1" },
    });
    // Restarting onto the version it runs needs no slot.
    ok(
      new PlacementPlanner(
        context({ nodes: withRequired(required(127, "v-old")), instances: [self] }),
      ).place(request({ nodeIds: ["h1"], restart, resources: [GB20], versionId: "v-old" })),
    );
  });

  it("preemption cannot free a slot (a stop frees none until it is proven)", () => {
    const victim = running("victim", ["h1"], 100);
    const result = new PlacementPlanner(
      context({ nodes: withRequired(required(128)), instances: [victim] }),
    ).place(request({ nodeIds: ["h1"], preempt: true }));
    expect(result).toMatchObject({ ok: false, refusal: { reason: "definition_slots_full" } });
  });

  it("a reservation takes no slot, and a Relay-only node is counted too", () => {
    const base = request({ labels: ["rtx"], resources: [{ kind: "unified", memoryGb: 8 }] });
    const withReservation: PlacementRequest = {
      ...base,
      launch: {
        ...base.launch,
        reservations: [{ labels: ["strix"], resources: { kind: "unified", memoryGb: 10 } }],
      },
    };
    const full = lab().map((entry) =>
      entry.labels.includes("strix") ? { ...entry, requiredVersionIds: required(128) } : entry,
    );
    const placed = ok(new PlacementPlanner(context({ nodes: full })).place(withReservation));
    expect(placed.start.placements[0]?.nodeId).toBe("g1");
    expect(placed.start.reservations[0]?.nodeId).toMatch(/^h[12]$/);
    // A Relay-only node counts as well: raised to Full control, it is sent everything it
    // requires, so a 129th requirement is refused whatever its trust now.
    const relay = withRequired(required(128)).map((entry) =>
      entry.id === "h1" ? { ...entry, trust: "RELAY" as const } : entry,
    );
    expect(
      new PlacementPlanner(context({ nodes: relay })).place(request({ nodeIds: ["h1"] })),
    ).toMatchObject({ ok: false, refusal: { reason: "definition_slots_full" } });
    const room = withRequired(required(127)).map((entry) =>
      entry.id === "h1" ? { ...entry, trust: "RELAY" as const } : entry,
    );
    ok(new PlacementPlanner(context({ nodes: room })).place(request({ nodeIds: ["h1"] })));
  });
});
