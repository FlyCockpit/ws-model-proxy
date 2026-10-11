import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://mcp-nodes-rows-test", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { MCP_TOOLS } = await import("@ws-model-proxy/api/contracts");
const { runMcpTool } = await import("./tools");
const { testDispatch } = await import("./tools.test-helper");
const prisma = (await import("@ws-model-proxy/db")).default;
const { mockDeep } = await import("vitest-mock-extended");
type Db = ReturnType<typeof mockDeep<typeof prisma>>;
const db = prisma as unknown as Db;

/** A node as the list reads it: one GPU, one fabric with one peer, two secrets, online. */
function nodeRow() {
  return {
    id: "node-1",
    slug: "spark",
    name: null,
    connection: "ONLINE",
    lastHeartbeatAt: new Date("2026-10-07T10:00:00.000Z"),
    cliVersion: "0.4.0",
    rejectedProtocolVersion: null,
    trust: "FULL",
    trustChangedAt: null,
    trustLowerRequestedAt: null,
    labels: [],
    declaredResources: null,
    nodeInfo: {
      unifiedMemoryMiB: 131_072,
      nodeKind: "unified",
      gpus: [{ vendor: "nvidia", index: 0, name: "NVIDIA GB10", vramTotalMiB: null }],
    },
    nodeMetrics: null,
    nodeMetricsAt: null,
    holdAt: null,
    holdNote: null,
    holdProfileId: null,
    removeAfterOfflineMs: null,
    Ranks: [],
    _count: { Runtimes: 1, QueuedCommands: 0 },
    hostname: "spark-01",
    features: {
      terminals: { supported: true, max: 4, approvalRequired: false },
      operatorTerminals: true,
      files: { roots: ["/home/me"], asRoot: false, source: "default" },
      runtimeHosts: [],
      mediaExpand: true,
      liveStt: true,
      secrets: [
        { name: "WSMP_SECRET_HF", updatedAt: "2026-10-06T10:00:00.000Z" },
        { name: "WSMP_SECRET_NGC", updatedAt: "2026-10-06T10:00:00.000Z" },
      ],
    },
    FabricMembers: [{ ip: "10.10.0.1", Fabric: { name: "qsfp", _count: { Members: 2 } } }],
  };
}

const nodesGet = MCP_TOOLS.find((tool) => tool.name === "nodes_get");

describe("nodes_get list rows", () => {
  it("carry hostname, fabrics, GPUs and secret names, without nulls or empty lists", async () => {
    if (!nodesGet) throw new Error("no nodes_get");
    db.node.findMany.mockResolvedValue([nodeRow()] as never);
    const result = await runMcpTool(nodesGet, { dispatch: testDispatch("READ"), args: {} });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    console.info(`[budget] nodes_get list row: ${text.length} bytes`);
    expect(JSON.parse(text)).toEqual({
      nodes: [
        {
          id: "node-1",
          slug: "spark",
          connection: "ONLINE",
          lastHeartbeatAt: "2026-10-07T10:00:00.000Z",
          version: "0.4.0",
          trust: expect.any(Object),
          hardwareKind: "unified",
          runningInstances: 0,
          alwaysOnRuntimes: 1,
          needsYou: 0,
          hostname: "spark-01",
          fabrics: [{ name: "qsfp", ip: "10.10.0.1", peerCount: 1 }],
          gpus: [{ vendor: "nvidia", name: "NVIDIA GB10" }],
          secretNames: ["WSMP_SECRET_HF", "WSMP_SECRET_NGC"],
        },
      ],
    });
    expect(text).not.toContain("null");
    // Measured 2026-10-07: 426 bytes before (nulls, no fabrics/GPUs/secrets), 472 after.
    expect(text.length).toBeLessThanOrEqual(520);
  });
});
