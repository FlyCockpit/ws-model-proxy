import { describe, expect, it } from "vitest";
import {
  type PlacementContext,
  type PlacementInstance,
  type PlacementNode,
  PlacementPlanner,
  type PlacementRequest,
} from "./placement";

// How claims already on a node are replayed (their GPUs, the room they keep) and how a claim's
// GPUs are searched, on a node whose report or load changed since the claims were admitted.

const gpu = (key: string, vramGb: number) => ({
  key,
  vendor: "nvidia" as const,
  vramGb,
  unified: false,
});

function node(gpus: PlacementNode["gpus"]): PlacementNode {
  return {
    id: "n",
    slug: "node",
    online: true,
    trust: "FULL",
    held: false,
    labels: [],
    portRange: [30000, 30099],
    heldVersionIds: new Set(),
    requiredVersionIds: new Set(),
    frozenFabrics: null,
    memoryGb: 64,
    gpus,
    liveFreeMemoryGb: null,
  };
}

const rank = (resources: unknown, previous = false, port = 30000) => ({
  nodeId: "n",
  port,
  distPort: null,
  claim: "HELD" as const,
  resources,
  ...(previous ? { previous: true } : {}),
});

function instance(id: string, ranks: PlacementInstance["ranks"]): PlacementInstance {
  return {
    id,
    runtimeId: id,
    ownerId: "u",
    startable: true,
    running: true,
    contributed: false,
    interactiveStop: false,
    ranks,
  };
}

const discrete = (count: number, gb: number, keys: string[]) => ({
  kind: "discrete",
  gpuCount: count,
  vramGb: gb,
  gpus: keys,
  unifiedGpus: [],
});

const request = (resources: unknown, restart?: PlacementRequest["restart"]): PlacementRequest =>
  ({
    runtimeId: "new",
    versionId: "v-new",
    launch: { groupSize: 1, labels: [], resources: [resources] },
    nodeIds: ["n"],
    checkFrozen: false,
    preempt: false,
    ...(restart ? { restart } : {}),
  }) as unknown as PlacementRequest;

const context = (n: PlacementNode, instances: PlacementInstance[]): PlacementContext => ({
  callerId: "u",
  agent: false,
  nodes: [n],
  fabrics: [],
  instances,
});

describe("GPU replay and search on a changed node", () => {
  it("a recorded GPU the node no longer reports is held on every GPU it may be now", () => {
    // Both claims recorded nvidia:0 (16 GiB), which the node no longer reports; it reports
    // nvidia:1 and nvidia:2. The process may be on either, so each keeps 16 GiB: another 8 GiB
    // fits beside it, 16 GiB does not. The old and new claims overlap (never counted twice).
    const n = node([gpu("nvidia:1", 24), gpu("nvidia:2", 24)]);
    const current = rank({ ...discrete(1, 16, ["nvidia:0"]), ramGb: 2 });
    const old = rank({ ...discrete(1, 16, ["nvidia:0"]), ramGb: 1 }, true);
    const of = (gb: number) =>
      request({ kind: "discrete", gpuCount: 1, vramGb: gb, vendor: "nvidia" });
    for (const ranks of [[current], [current, old]]) {
      const planner = () => new PlacementPlanner(context(n, [instance("old", ranks)]));
      expect(planner().place(of(8)).ok).toBe(true);
      expect(planner().place(of(16)).ok).toBe(false);
    }
  });

  it("a claim that recorded no GPUs is held on every GPU of its vendor", () => {
    // 16 GiB on one of two 24 GiB GPUs, unknown which: a 24 GiB claim fits on neither.
    const n = node([gpu("nvidia:0", 24), gpu("nvidia:1", 24)]);
    const legacy = instance("legacy", [
      rank({ kind: "discrete", gpuCount: 1, vramGb: 16, vendor: "nvidia" }),
    ]);
    const wanted = (gb: number) =>
      request({ kind: "discrete", gpuCount: 1, vramGb: gb, vendor: "nvidia" });
    expect(new PlacementPlanner(context(n, [legacy])).place(wanted(24)).ok).toBe(false);
    expect(new PlacementPlanner(context(n, [legacy])).place(wanted(8)).ok).toBe(true);
  });

  it("a restart tries the GPU it grows least on, not only the best-fit one", () => {
    // The restart holds 10 GiB on nvidia:1 (its current claim) and 1 GiB on nvidia:0 (its old
    // one); nvidia:2 is over-committed, so the dedicated GPUs have 5 GiB free together. A 10 GiB
    // claim grows 9 GiB on nvidia:0 but nothing on nvidia:1: it fits there.
    const n = node([gpu("nvidia:0", 11), gpu("nvidia:1", 15), gpu("nvidia:2", 10)]);
    const target = instance("target", [
      rank(discrete(1, 10, ["nvidia:1"])),
      rank(discrete(1, 1, ["nvidia:0"]), true),
    ]);
    const other = instance("other", [rank(discrete(1, 20, ["nvidia:2"]), false, 30001)]);
    const restart = { instanceId: "target", ports: [30000], distPort: null };
    expect(
      new PlacementPlanner(context(n, [target, other])).place(
        request({ kind: "discrete", gpuCount: 1, vramGb: 10, vendor: "nvidia" }, restart),
      ).ok,
    ).toBe(true);
  });

  it("an unchanged CPU restart is not refused for another claim's GPU over-commit", () => {
    // 32 GiB claimed on a 24 GiB GPU by another runtime: none of this restart's business.
    const n = node([gpu("nvidia:0", 24)]);
    const target = instance("target", [rank({ kind: "cpu", ramGb: 16 })]);
    const other = instance("other", [rank(discrete(1, 32, ["nvidia:0"]), false, 30001)]);
    const restart = { instanceId: "target", ports: [30000], distPort: null };
    expect(
      new PlacementPlanner(context(n, [target, other])).place(
        request({ kind: "cpu", ramGb: 16 }, restart),
      ).ok,
    ).toBe(true);
  });
  it("a guess about one vendor's GPUs never constrains another vendor's", () => {
    // nvidia:0 is over-committed by a recorded claim; nvidia:1 has 8 GiB free. The vendor's GPUs
    // together have none free, but no NVIDIA claim is a guess: nvidia:1's own room decides. An
    // AMD claim that recorded no GPUs changes nothing for NVIDIA.
    const n = node([
      gpu("nvidia:0", 16),
      gpu("nvidia:1", 8),
      { key: "amd:0", vendor: "amd", vramGb: 16, unified: false },
    ]);
    const over = instance("over", [rank(discrete(1, 24, ["nvidia:0"]))]);
    const legacy = instance("legacy", [
      rank({ kind: "discrete", gpuCount: 1, vramGb: 4, vendor: "amd" }, false, 30001),
    ]);
    const wanted = request({ kind: "discrete", gpuCount: 1, vramGb: 8, vendor: "nvidia" });
    expect(new PlacementPlanner(context(n, [over])).place(wanted).ok).toBe(true);
    expect(new PlacementPlanner(context(n, [over, legacy])).place(wanted).ok).toBe(true);
  });

  it("a claim that recorded no GPUs keeps the node memory a unified GPU it may be on would use", () => {
    // 32 GiB on one NVIDIA GPU, unrecorded: it may be on the unified nvidia:0 (node memory) or
    // the dedicated nvidia:1. 48 GiB more node memory does not fit next to it on 64 GiB.
    const n = node([
      { key: "nvidia:0", vendor: "nvidia", vramGb: 0, unified: true },
      gpu("nvidia:1", 48),
    ]);
    const legacy = instance("legacy", [
      rank({ kind: "discrete", gpuCount: 1, vramGb: 32, vendor: "nvidia" }),
    ]);
    const cpu = request({ kind: "cpu", ramGb: 48 });
    expect(new PlacementPlanner(context(n, [legacy])).place(cpu).ok).toBe(false);
    expect(
      new PlacementPlanner(context(n, [legacy])).place(request({ kind: "cpu", ramGb: 32 })).ok,
    ).toBe(true);
  });

  it("a GPU declared dedicated since a claim took it as unified holds the claim's VRAM there too", () => {
    // Admitted while nvidia:0 was unified (its VRAM node memory); now declared dedicated, 24 GiB.
    // The process may use either: 16 GiB more does not fit on the GPU.
    const n = node([gpu("nvidia:0", 24)]);
    const held = instance("held", [
      rank({ ...discrete(1, 16, ["nvidia:0"]), unifiedGpus: ["nvidia:0"] }),
    ]);
    const wanted = (gb: number) =>
      request({ kind: "discrete", gpuCount: 1, vramGb: gb, vendor: "nvidia" });
    expect(new PlacementPlanner(context(n, [held])).place(wanted(16)).ok).toBe(false);
    expect(new PlacementPlanner(context(n, [held])).place(wanted(8)).ok).toBe(true);
  });
});
