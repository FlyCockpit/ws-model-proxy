import { ORPCError } from "@orpc/server";
import { DEPLOYMENT_COMMAND_MAX_BYTES } from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it } from "vitest";
import {
  type DeploymentNode,
  deploymentHeadAddress,
  deploymentPermission,
  type ExistingDeployment,
  planDeployment,
  renderDeploymentCommand,
} from "./deployment-planner";
import { deploymentVariantSchema } from "./deployment-spec";

const variant = deploymentVariantSchema.parse({
  key: "spark",
  groupSize: 2,
  labels: ["dgx-spark"],
  resources: [{ kind: "unified", memoryGb: 110 }],
  commands: [{ management: "ownedProcess", start: "serve --host {{head_addr}}", stop: "stop" }],
  iface: "eth0",
  readiness: {},
  models: ["glm"],
  attachment: { type: "llm", poolId: "pool" },
  hardConcurrencyLimit: 2,
});
function node(id: string): DeploymentNode {
  return {
    id,
    online: true,
    protocolVersion: "2.4",
    allowDeployments: true,
    reportedDeployments: true,
    mode: "UNSUPERVISED",
    localMode: "UNSUPERVISED",
    execution: "systemd+linger",
    labels: ["dgx-spark"],
    info: {
      nodeKind: "unified",
      memoryTotalMiB: 128 * 1024,
      interfaces: [{ name: "eth0", addresses: ["10.0.0.1"] }],
    },
    budgets: {
      usableMemoryGb: 124,
      usableRamGb: null,
      usableVramGb: {},
      usableMemoryGbDefault: false,
      usableRamGbDefault: false,
      usableVramGbDefaults: {},
    },
    portStart: 30000,
    portEnd: 30020,
  };
}
function existing(id: string, nodeIds: string[], memory = 100): ExistingDeployment {
  return {
    id,
    startedBy: "AGENT",
    agentsMayPreempt: false,
    nodes: nodeIds.map((nodeId) => ({
      nodeId,
      resources: { kind: "unified", memoryGb: memory, ramGb: 0, gpus: [] },
      port: 30000,
      distPort: null,
      blockedBy: [],
    })),
  };
}
describe("durable deployment placement policy", () => {
  it.each(["2.3", "2.5", "2.11", "3.0", "2.4.0"])(
    "refuses incompatible plan protocol %s",
    (protocolVersion) => {
      expect(() =>
        planDeployment({
          nodes: [{ ...node("1"), protocolVersion }, node("2")],
          existing: [],
          variant,
          nodeIds: ["1", "2"],
          groupCount: 1,
          actor: "USER",
        }),
      ).toThrow("CLI upgrade required");
    },
  );
  it("requires an explicit supported engine and preserves the conservative default", () => {
    expect(variant.engine).toBe("other");
    expect(deploymentVariantSchema.parse({ ...variant, engine: "llama.cpp" }).engine).toBe(
      "llama.cpp",
    );
    expect(() => deploymentVariantSchema.parse({ ...variant, engine: "guessed" })).toThrow();
  });
  it("allows an offline stopped rank to retain claims pending reconnect", () => {
    const result = planDeployment({
      nodes: [node("1"), node("2"), { ...node("3"), online: false }],
      existing: [existing("old", ["1", "3"])],
      variant,
      nodeIds: ["1", "2"],
      groupCount: 1,
      actor: "USER",
    });
    expect(result.stopIds).toEqual(["old"]);
    expect(result.affectedNodeIds).toEqual(["1", "2", "3"]);
    expect(() =>
      planDeployment({
        nodes: [{ ...node("1"), online: false }, node("2")],
        existing: [],
        variant,
        nodeIds: ["1", "2"],
        groupCount: 1,
        actor: "USER",
      }),
    ).toThrow("offline");
  });
  it("replaces two affected single-node instances and leaves other nodes untouched", () => {
    const result = planDeployment({
      nodes: [1, 2, 3, 4].map((n) => node(String(n))),
      existing: [1, 2, 3, 4].map((n) => existing(`q${n}`, [String(n)])),
      variant,
      nodeIds: ["1", "2"],
      groupCount: 1,
      actor: "USER",
    });
    expect(result.stopIds).toEqual(["q1", "q2"]);
    expect(result.affectedNodeIds).toEqual(["1", "2"]);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.placements.every((p) => p.port === 30001)).toBe(true);
  });
  it("cascades a conflict to every node in the old group", () => {
    const result = planDeployment({
      nodes: [1, 2, 3, 4].map((n) => node(String(n))),
      existing: [existing("old", ["1", "3"]), existing("other", ["4"])],
      variant,
      nodeIds: ["1", "2"],
      groupCount: 1,
      actor: "USER",
    });
    expect(result.stopIds).toEqual(["old"]);
    expect(result.affectedNodeIds).toEqual(["1", "2", "3"]);
  });
  it("includes stopped nodes in lowest command mode and protected policy", () => {
    const nodes = [node("1"), node("2"), { ...node("3"), mode: "SUPERVISED" as const }];
    const old = { ...existing("old", ["1", "3"]), startedBy: "USER" as const };
    expect(
      planDeployment({
        nodes,
        existing: [old],
        variant,
        nodeIds: ["1", "2"],
        groupCount: 1,
        actor: "AGENT",
      }).requiresConfirmation,
    ).toBe(true);
    nodes[2] = node("3");
    expect(() =>
      planDeployment({
        nodes,
        existing: [old],
        variant,
        nodeIds: ["1", "2"],
        groupCount: 1,
        actor: "AGENT",
      }),
    ).toThrow("protected");
    nodes[2] = { ...node("3"), localMode: "OFF" };
    expect(() =>
      planDeployment({
        nodes,
        existing: [old],
        variant,
        nodeIds: ["1", "2"],
        groupCount: 1,
        actor: "AGENT",
      }),
    ).toThrow("off");
  });
  it("retains uninvolved GPU allocations", () => {
    const n = {
      ...node("1"),
      info: {
        nodeKind: "discrete" as const,
        gpus: [
          { index: 0, uuid: "gpu0", vramTotalMiB: 24 * 1024 },
          { index: 1, uuid: "gpu1", vramTotalMiB: 24 * 1024 },
        ],
      },
      budgets: {
        ...node("1").budgets,
        usableMemoryGb: null,
        usableRamGb: 64,
        usableVramGb: { gpu0: 24, gpu1: 24 },
      },
    };
    const claim = (id: string, key: string, index: number): ExistingDeployment => ({
      ...existing(id, ["1"]),
      nodes: [
        {
          nodeId: "1",
          resources: {
            kind: "discrete",
            memoryGb: 0,
            ramGb: 0,
            gpus: [{ key, index, vramGb: 20 }],
          },
          port: 30000 + index,
          distPort: null,
          blockedBy: [],
        },
      ],
    });
    const v = deploymentVariantSchema.parse({
      ...variant,
      groupSize: 1,
      labels: [],
      resources: [{ kind: "discrete", gpuCount: 1, vramGb: 24 }],
      iface: undefined,
    });
    expect(
      planDeployment({
        nodes: [n],
        existing: [claim("a", "gpu0", 0), claim("b", "gpu1", 1)],
        variant: v,
        nodeIds: ["1"],
        groupCount: 1,
        actor: "USER",
      }).stopIds,
    ).toEqual(["a"]);
  });
  it("never places on resources held until an earlier service is proven stopped", () => {
    const held = [
      {
        instanceId: "gone",
        nodeId: "1",
        resources: { kind: "unified" as const, memoryGb: 100, ramGb: 0, gpus: [] },
        port: 30000,
        distPort: 30001,
      },
    ];
    // Nothing to stop frees them: the plan is refused with the reason.
    expect(() =>
      planDeployment({
        nodes: [node("1"), node("2")],
        existing: [],
        held,
        variant,
        nodeIds: ["1", "2"],
        groupCount: 1,
        actor: "USER",
      }),
    ).toThrow("stay held until WS Model Proxy confirms");
    // Free nodes are preferred over a node with held resources, and held ports stay taken.
    const plan = planDeployment({
      nodes: [node("1"), node("2"), node("3")],
      existing: [],
      held,
      variant,
      groupCount: 1,
      actor: "USER",
    });
    expect(plan.placements.map((p) => p.nodeId)).toEqual(["2", "3"]);
    expect(plan.stopIds).toEqual([]);
    const small = deploymentVariantSchema.parse({
      ...variant,
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 10 }],
      iface: undefined,
    });
    const beside = planDeployment({
      nodes: [node("1")],
      existing: [],
      held,
      variant: small,
      nodeIds: ["1"],
      groupCount: 1,
      actor: "USER",
    });
    expect(beside.placements[0]?.port).toBe(30002);
  });
  it("uses free nodes first and never preempts when fit is sufficient", () => {
    const result = planDeployment({
      nodes: [node("1"), node("2"), node("3")],
      existing: [existing("old", ["1"])],
      variant,
      groupCount: 1,
      actor: "USER",
    });
    expect(result.placements.map((p) => p.nodeId)).toEqual(["2", "3"]);
    expect(result.stopIds).toEqual([]);
    expect(result.requiresConfirmation).toBe(false);
  });
  it("lists the skipped nodes and their reasons when it picks nodes itself", () => {
    let thrown: unknown;
    try {
      planDeployment({
        nodes: [
          node("spark-1"),
          { ...node("spark-2"), reportedDeployments: false },
          { ...node("spark-3"), labels: [] },
        ],
        existing: [],
        variant,
        groupCount: 1,
        actor: "AGENT",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ORPCError);
    const error = thrown as ORPCError<string, unknown>;
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.message).toBe(
      "This plan needs 2 eligible nodes but 1 qualifies. Skipped: spark-2: Deployments require local opt-in and server grant; spark-3: Does not have every label the recipe requires.",
    );
    expect(error.data).toEqual({
      reason: "not_enough_nodes",
      nodeIds: ["spark-2", "spark-3"],
      skippedNodes: [
        {
          nodeId: "spark-2",
          reason: "deployments_not_enabled",
          message: "Deployments require local opt-in and server grant",
        },
        {
          nodeId: "spark-3",
          reason: "label_mismatch",
          message: "Does not have every label the recipe requires",
        },
      ],
    });
  });
  it("carries a stable reason and the node on every gate refusal", () => {
    expect(() => deploymentPermission([{ ...node("1"), online: false }], [], "USER")).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        message: "Node 1 is offline",
        data: { reason: "node_offline", nodeIds: ["1"] },
      }),
    );
    expect(() =>
      deploymentPermission([{ ...node("1"), execution: "systemd-no-linger" }], [], "USER"),
    ).toThrow(
      expect.objectContaining({
        code: "PRECONDITION_FAILED",
        message: "Unsupported deployment execution on 1; Linux requires user systemd and linger",
        data: { reason: "unsupported_execution", nodeIds: ["1"] },
      }),
    );
  });
  it("requires both opt-in and grant and refuses unsupported mechanisms", () => {
    expect(() =>
      deploymentPermission([{ ...node("1"), reportedDeployments: false }], [], "USER"),
    ).toThrow("opt-in");
    expect(() =>
      deploymentPermission([{ ...node("1"), allowDeployments: false }], [], "USER"),
    ).toThrow("grant");
    expect(() =>
      deploymentPermission([{ ...node("1"), execution: "systemd-no-linger" }], [], "USER"),
    ).toThrow("linger");
    expect(deploymentPermission([node("1")], [], "AGENT").requiresConfirmation).toBe(false);
    // No node to read a command mode from fails closed for agents.
    expect(() => deploymentPermission([], [], "AGENT")).toThrow(/off on an affected node/);
    expect(deploymentPermission([], [], "USER").effectiveMode).toBe("UNSUPERVISED");
    // A rank that runs nothing is not gated, but its command mode still binds agents.
    const revoked = { ...node("2"), allowDeployments: false, mode: "OFF" as const };
    expect(deploymentPermission([], [], "USER", new Set(), [revoked]).requiresConfirmation).toBe(
      false,
    );
    expect(() => deploymentPermission([], [], "AGENT", new Set(), [revoked])).toThrow(
      /off on an affected node/,
    );
    expect(() => deploymentPermission([revoked], [], "USER")).toThrow();
  });
  it("rejects oversized, duplicate nodes and infeasible resource plans", () => {
    expect(() =>
      planDeployment({
        nodes: [node("1")],
        existing: [],
        variant,
        nodeIds: ["1", "1"],
        groupCount: 1,
        actor: "USER",
      }),
    ).toThrow("distinct");
    expect(() =>
      planDeployment({
        nodes: [{ ...node("1"), budgets: { ...node("1").budgets, usableMemoryGb: 50 } }, node("2")],
        existing: [],
        variant,
        nodeIds: ["1", "2"],
        groupCount: 1,
        actor: "USER",
      }),
    ).toThrow("budgets");
  });
  it("refuses shell-special placeholder values and substitutes safe ones bare in any position", () => {
    for (const hostile of ["x'; touch /tmp/unwanted; '", "$(touch /tmp/x)", "a b", "`id`", '"'])
      expect(() =>
        renderDeploymentCommand(`sh -c 'serve --host "{{head_addr}}"'`, { head_addr: hostile }),
      ).toThrow("unsafe value");
    // Inside the recipe's own quotes the value is not altered by added quoting.
    expect(
      renderDeploymentCommand('serve --host "{{head_addr}}" --port {{port}} --gpus {{gpu_ids}}', {
        head_addr: "10.0.0.2",
        port: 30000,
        gpu_ids: "0,1",
      }),
    ).toBe('serve --host "10.0.0.2" --port 30000 --gpus 0,1');
    expect(() => renderDeploymentCommand("start {{unknown}}", {})).toThrow("Unknown");
  });

  it("refuses a rendered command longer than the CLI's byte limit", () => {
    expect(DEPLOYMENT_COMMAND_MAX_BYTES).toBe(4096);
    const exact = "a".repeat(DEPLOYMENT_COMMAND_MAX_BYTES - 8);
    expect(renderDeploymentCommand(`${exact}{{port}}`, { port: 30000123 })).toHaveLength(
      DEPLOYMENT_COMMAND_MAX_BYTES,
    );
    // Substitution can push a saved command that fits over the limit.
    expect(() => renderDeploymentCommand(`${exact}{{port}}`, { port: 300001234 })).toThrow(
      "exceeds 4096 bytes",
    );
    const gpus = Array.from({ length: 256 }, (_, i) => i).join(",");
    const template = "x {{gpu_ids}}".repeat(40);
    expect(new TextEncoder().encode(template).byteLength).toBeLessThan(
      DEPLOYMENT_COMMAND_MAX_BYTES,
    );
    expect(() => renderDeploymentCommand(template, { gpu_ids: gpus })).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
    // Bytes, not UTF-16 units: 2,048 two-byte characters plus one more byte is too long.
    expect(() => renderDeploymentCommand(`${"é".repeat(2048)}a`, {})).toThrow("exceeds");
    expect(renderDeploymentCommand("é".repeat(2048), {})).toHaveLength(2048);
  });

  it("takes the head address only as a non-loopback IPv4 literal", () => {
    const interfaces = [
      {
        name: "eth0",
        addresses: ["$(touch /tmp/x)", "127.0.0.2", "fe80::1", "0.0.0.0", "10.0.0.010", "10.0.0.2"],
      },
    ];
    expect(deploymentHeadAddress(interfaces, "eth0")).toBe("10.0.0.2");
    expect(deploymentHeadAddress([{ name: "eth0", addresses: ["$(id)"] }], "eth0")).toBeUndefined();
    expect(deploymentHeadAddress(interfaces, "eth1")).toBeUndefined();
  });
});
