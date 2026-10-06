import { describe, expect, it } from "vitest";
import type { RuntimeSpec } from "../lib/runtime-spec";
import { type PlanInput, type PlanNode, profilePlan } from "./plan";

function node(id: string, overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    slug: id,
    online: true,
    trust: "FULL",
    labels: [],
    hold: { holdAt: null, holdProfileId: null },
    portRange: [30000, 30002],
    heldVersionIds: new Set(),
    usableMemoryGb: 64,
    usableGpuGb: 0,
    gpuCount: 0,
    liveFreeMemoryGb: null,
    ...overrides,
  };
}

function launchSpec(overrides: Partial<NonNullable<RuntimeSpec["launch"]>> = {}): RuntimeSpec {
  return {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: "m" }],
    launch: {
      management: "process",
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 40 }],
      labels: [],
      commands: [{ start: "serve --port {{port}}", stop: "kill" }],
      readiness: { path: "/health", expectedStatus: 200, timeoutMs: 60_000 },
      health: { intervalMs: 10_000, failureThreshold: 3, successThreshold: 1 },
      ...overrides,
    },
  } as RuntimeSpec;
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    profileId: "p-1",
    owned: [
      { nodeId: "a", hold: false, holdNote: null },
      { nodeId: "b", hold: false, holdNote: null },
    ],
    nodes: new Map([
      ["a", node("a")],
      ["b", node("b")],
    ]),
    items: [
      { id: "it-1", position: 0, runtimeId: "rt-1", versionId: "v-1", count: 1, nodeIds: [] },
    ],
    versions: new Map([
      [
        "v-1",
        {
          id: "v-1",
          runtimeId: "rt-1",
          runtimeSlug: "qwen",
          currentVersionId: "v-1",
          spec: launchSpec(),
        },
      ],
    ]),
    instances: [],
    claims: [],
    fabrics: [],
    agentRules: false,
    ...overrides,
  };
}

describe("profilePlan", () => {
  it("starts a missing item on a node that fits, with the first free port", () => {
    const plan = profilePlan(input());
    expect(plan.preview.refusals).toEqual([]);
    expect(plan.preview.starts).toHaveLength(1);
    expect(plan.preview.starts[0]?.placements[0]).toMatchObject({ port: 30000, nodeNumber: 1 });
    expect(plan.preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a matching instance and stops everything else on owned nodes", () => {
    const plan = profilePlan(
      input({
        instances: [
          {
            id: "i-keep",
            runtimeId: "rt-1",
            launchVersionId: "v-1",
            desiredRunning: true,
            rankNodeIds: ["a"],
          },
          {
            id: "i-old",
            runtimeId: "rt-1",
            launchVersionId: "v-0",
            desiredRunning: true,
            rankNodeIds: ["b"],
          },
          {
            id: "i-other",
            runtimeId: "rt-9",
            launchVersionId: "v-9",
            desiredRunning: true,
            rankNodeIds: ["b"],
          },
        ],
      }),
    );
    expect(plan.preview.kept).toEqual(["i-keep"]);
    expect(plan.preview.stops.map((stop) => stop.instanceId).sort()).toEqual(["i-old", "i-other"]);
    expect(plan.preview.starts).toEqual([]);
  });

  it("frees memory of stopped instances but keeps their ports taken", () => {
    const plan = profilePlan(
      input({
        owned: [{ nodeId: "a", hold: false, holdNote: null }],
        instances: [
          {
            id: "i-other",
            runtimeId: "rt-9",
            launchVersionId: "v-9",
            desiredRunning: true,
            rankNodeIds: ["a"],
          },
        ],
        claims: [
          {
            instanceId: "i-other",
            nodeId: "a",
            port: 30000,
            distPort: null,
            resources: { kind: "unified", memoryGb: 60 },
          },
        ],
      }),
    );
    expect(plan.preview.refusals).toEqual([]);
    expect(plan.preview.starts[0]?.placements[0]?.port).toBe(30001);
  });

  it("refuses not_enough_memory when no node fits", () => {
    const plan = profilePlan(
      input({
        nodes: new Map([
          ["a", node("a", { usableMemoryGb: 8 })],
          ["b", node("b", { usableMemoryGb: 8 })],
        ]),
      }),
    );
    expect(plan.preview.refusals[0]?.reason).toBe("not_enough_memory");
  });

  it("holds hold-line nodes, stops what runs there and never places there", () => {
    const plan = profilePlan(
      input({
        owned: [
          { nodeId: "a", hold: true, holdNote: null },
          { nodeId: "b", hold: false, holdNote: null },
        ],
        instances: [
          {
            id: "i-1",
            runtimeId: "rt-1",
            launchVersionId: "v-1",
            desiredRunning: true,
            rankNodeIds: ["a"],
          },
        ],
      }),
    );
    expect(plan.holdNodeIds).toEqual(["a"]);
    expect(plan.preview.stops.map((stop) => stop.instanceId)).toEqual(["i-1"]);
    expect(plan.preview.starts[0]?.placements[0]?.nodeId).toBe("b");
  });

  it("a person's apply releases holds on owned nodes without a hold line (planProfileHolds)", () => {
    const nodes = new Map([
      ["a", node("a", { hold: { holdAt: new Date(), holdProfileId: "p-1" } })],
      ["b", node("b", { hold: { holdAt: new Date(), holdProfileId: null } })],
    ]);
    const person = profilePlan(input({ nodes }));
    expect(person.releaseNodeIds).toEqual(["a", "b"]);
    expect(person.preview.refusals).toEqual([]);
    const agent = profilePlan(input({ nodes, agentRules: true }));
    expect(agent.preview.refusals.map((entry) => [entry.reason, entry.subjectId])).toContainEqual([
      "node_held",
      "b",
    ]);
    expect(agent.releaseNodeIds).toEqual([]);
  });

  it("keeps someone else's hold on a hold-line node and places nothing there", () => {
    const plan = profilePlan(
      input({
        owned: [
          { nodeId: "a", hold: true, holdNote: null },
          { nodeId: "b", hold: false, holdNote: null },
        ],
        nodes: new Map([
          ["a", node("a", { hold: { holdAt: new Date(), holdProfileId: "p-other" } })],
          ["b", node("b")],
        ]),
        agentRules: true,
      }),
    );
    expect(plan.holdNodeIds).toEqual([]);
    expect(plan.preview.refusals).toEqual([]);
    expect(plan.preview.starts[0]?.placements[0]?.nodeId).toBe("b");
  });

  it("refuses an agent whole when an owned node is Relay only or held by a person", () => {
    const plan = profilePlan(
      input({
        agentRules: true,
        nodes: new Map([
          ["a", node("a", { trust: "RELAY" })],
          ["b", node("b", { hold: { holdAt: new Date(), holdProfileId: null } })],
        ]),
      }),
    );
    expect(plan.preview.refusals.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["trust_relay", "node_held"]),
    );
  });

  it("lets a person start only a frozen version on a Relay-only node", () => {
    const frozen = profilePlan(
      input({
        owned: [{ nodeId: "a", hold: false, holdNote: null }],
        nodes: new Map([["a", node("a", { trust: "RELAY" })]]),
      }),
    );
    expect(frozen.preview.refusals[0]?.reason).toBe("definition_frozen");
    const held = profilePlan(
      input({
        owned: [{ nodeId: "a", hold: false, holdNote: null }],
        nodes: new Map([["a", node("a", { trust: "RELAY", heldVersionIds: new Set(["v-1"]) })]]),
      }),
    );
    expect(held.preview.refusals).toEqual([]);
  });

  it("places a multi-node instance inside one fabric, or refuses no_shared_fabric", () => {
    const spec = launchSpec({ groupSize: 2, resources: [{ kind: "unified", memoryGb: 30 }] });
    const versions = new Map([
      ["v-1", { id: "v-1", runtimeId: "rt-1", runtimeSlug: "big", currentVersionId: "v-1", spec }],
    ]);
    const none = profilePlan(input({ versions }));
    expect(none.preview.refusals[0]?.reason).toBe("no_shared_fabric");
    const ok = profilePlan(
      input({ versions, fabrics: [{ id: "f-1", name: "qsfp", nodeIds: ["a", "b"] }] }),
    );
    expect(ok.preview.starts[0]?.placements.map((placement) => placement.nodeNumber)).toEqual([
      1, 2,
    ]);
  });

  it("changes the fingerprint when the plan changes", () => {
    const one = profilePlan(input()).preview.fingerprint;
    const two = profilePlan(
      input({
        items: [
          { id: "it-1", position: 0, runtimeId: "rt-1", versionId: "v-1", count: 2, nodeIds: [] },
        ],
      }),
    ).preview.fingerprint;
    expect(one).not.toBe(two);
    expect(profilePlan(input()).preview.fingerprint).toBe(one);
  });

  it("warns about outdated pins", () => {
    const versions = new Map([
      [
        "v-1",
        {
          id: "v-1",
          runtimeId: "rt-1",
          runtimeSlug: "qwen",
          currentVersionId: "v-2",
          spec: launchSpec(),
        },
      ],
    ]);
    expect(profilePlan(input({ versions })).preview.warnings.map((w) => w.code)).toContain(
      "pins_outdated",
    );
  });

  it("counts GPUs already claimed on a discrete node", () => {
    const spec = launchSpec({ resources: [{ kind: "discrete", gpuCount: 1, vramGb: 10 }] });
    const versions = new Map([
      ["v-1", { id: "v-1", runtimeId: "rt-1", runtimeSlug: "gpu", currentVersionId: "v-1", spec }],
    ]);
    const plan = profilePlan(
      input({
        owned: [{ nodeId: "a", hold: false, holdNote: null }],
        nodes: new Map([["a", node("a", { usableGpuGb: 48, gpuCount: 1 })]]),
        versions,
        claims: [
          {
            instanceId: "i-x",
            nodeId: "a",
            port: 30005,
            distPort: null,
            resources: { kind: "discrete", gpuCount: 1, vramGb: 10 },
          },
        ],
      }),
    );
    expect(plan.preview.refusals[0]?.reason).toBe("not_enough_memory");
  });

  it("stops a matching instance that also runs on a node outside the profile", () => {
    const plan = profilePlan(
      input({
        instances: [
          {
            id: "i-wide",
            runtimeId: "rt-1",
            launchVersionId: "v-1",
            desiredRunning: true,
            rankNodeIds: ["elsewhere", "a"],
          },
        ],
      }),
    );
    expect(plan.preview.kept).toEqual([]);
    expect(plan.preview.stops.map((stop) => stop.instanceId)).toEqual(["i-wide"]);
  });

  it("gives the same fingerprint whatever order the owned nodes come in", () => {
    const reversed = profilePlan(
      input({
        owned: [
          { nodeId: "b", hold: false, holdNote: null },
          { nodeId: "a", hold: false, holdNote: null },
        ],
      }),
    );
    expect(reversed.preview.fingerprint).toBe(profilePlan(input()).preview.fingerprint);
  });
});
