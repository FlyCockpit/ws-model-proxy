import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentUpdateDb, nodeRow } from "../lib/agent-update-test-fake";

const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@ws-model-proxy/db", () => ({
  get default() {
    return fake.db;
  },
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com" },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({ env: {} }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/db/node-security", () => ({ credentialDigest: vi.fn() }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
const stops = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../routers/runtime-lifecycle", async (original) => ({
  ...(await original<typeof import("../routers/runtime-lifecycle")>()),
  stopInstancesOnNode: vi.fn(async (_context: unknown, _userId: string, nodeId: string) => {
    stops.calls.push(nodeId);
    return "op-1";
  }),
}));

import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import type { AgentUpdatePort, AgentUpdateRelease } from "../lib/agent-updates";
import { nodesRouter } from "../routers/nodes";
import { NOT_A_PERSON, OWNER, PERSON, procedureAt, session } from "./lane-b-test-helpers";

const TARGET = "x86_64-unknown-linux-gnu";
const SELF_UPDATE = { strategies: ["self-replace"], instancesSurvive: true, remote: "allowed" };
const RELEASE: AgentUpdateRelease = {
  kind: "release",
  version: "0.4.3",
  commit: null,
  releaseUrl: "https://r.example/v0.4.3",
  artifacts: { [TARGET]: { url: "https://r.example/v0.4.3/a.tar.xz", sha256: "a".repeat(64) } },
};

let store: ReturnType<typeof createAgentUpdateDb>;
let sent: Array<{ nodeId: string; force: boolean; updateId: string }>;

function makePort(
  options: {
    release?: AgentUpdateRelease;
    sourceBuild?: boolean;
    trust?: "full" | "relay";
    selfUpdate?: unknown;
  } = {},
): AgentUpdatePort {
  return {
    server: async () => ({
      version: "0.4.3",
      commit: null,
      sourceBuild: options.sourceBuild ?? false,
      cargoInstall: "cargo install --git R --tag v0.4.3 --locked --force wsmp",
    }),
    release: async () => options.release ?? RELEASE,
    liveNode: (nodeId) => {
      const node = store.tables.node.find((row) => row.id === nodeId);
      if (node?.connection !== "ONLINE") return null;
      return {
        userId: node.userId as string,
        connectionGeneration: 1,
        trust: options.trust ?? "full",
        selfUpdate: (options.selfUpdate === undefined ? SELF_UPDATE : options.selfUpdate) as never,
      };
    },
    send: (nodeId, frame) => {
      sent.push({ nodeId, force: frame.force, updateId: frame.updateId });
      return true;
    },
  };
}

function client(
  port: AgentUpdatePort = makePort(),
  auth: CallerAuth = PERSON,
  who: Session = session,
) {
  const context: Context = { session: who, auth, services: { agentUpdates: port } };
  return createRouterClient(nodesRouter, { context }).agentUpdate;
}

beforeEach(() => {
  store = createAgentUpdateDb();
  fake.db = store.client;
  sent = [];
  store.tables.node.push(nodeRow({ userId: OWNER }));
});

describe("nodes.agentUpdate access", () => {
  for (const [label, auth] of NOT_A_PERSON)
    it(`refuses a ${label} (never MCP, OAuth or an agent token)`, async () => {
      const api = createRouterClient(nodesRouter, {
        context: { session, auth, services: { agentUpdates: makePort() } },
      });
      for (const path of ["overview", "start", "startAll", "stopAll", "setPolicy"])
        await expect(
          procedureAt(api.agentUpdate, path)({ nodeId: "node-1", batchId: "b", policy: "OFF" }),
        ).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|BAD_REQUEST)$/) });
      expect(sent).toEqual([]);
    });

  it("refuses an admin acting through an impersonation session", async () => {
    const impersonated = {
      ...session,
      session: { ...session.session, impersonatedBy: "admin-1" },
    } as unknown as Session;
    await expect(
      client(makePort(), PERSON, impersonated).start({ nodeId: "node-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "human_only" } });
    await expect(
      client(makePort(), PERSON, impersonated).setPolicy({ nodeId: "node-1", policy: "OFF" }),
    ).rejects.toMatchObject({ data: { reason: "human_only" } });
    expect(sent).toEqual([]);
  });

  it("finds no node of another owner (NOT_FOUND, nothing sent or written)", async () => {
    store.tables.node.push(nodeRow({ id: "node-b", userId: "someone-else", slug: "b-box" }));
    await expect(client().start({ nodeId: "node-b" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client().setPolicy({ nodeId: "node-b", policy: "OFF" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client().startAll({ canaryNodeId: "node-b" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(store.tables.node.find((row) => row.id === "node-b")?.agentUpdatePolicy).toBe("ALLOWED");
    expect(sent).toEqual([]);
    const overview = await client().overview();
    expect(overview.nodes.map((node) => node.nodeId)).toEqual(["node-1"]);
  });
});

describe("nodes.agentUpdate.start", () => {
  it("starts an update and returns it", async () => {
    const update = await client().start({ nodeId: "node-1" });
    expect(update).toMatchObject({
      phase: "requested",
      fromVersion: "0.4.2",
      toVersion: "0.4.3",
      force: false,
      endedAt: null,
    });
    expect(sent).toEqual([{ nodeId: "node-1", force: false, updateId: update.id }]);
  });

  it.each([
    ["a Relay-only node", { trust: "relay" as const }, {}, "trust_relay"],
    ["policy off", {}, { agentUpdatePolicy: "OFF" }, "agent_update_off"],
    ["an offline node", {}, { connection: "OFFLINE" }, "node_offline"],
    ["a wsmp without self-update", { selfUpdate: null }, {}, "upgrade_wsmp"],
    [
      "a source-build server",
      { release: { kind: "source", version: "0.4.3", commit: null } as const, sourceBuild: true },
      {},
      "agent_update_unavailable",
    ],
    [
      "a release without the checksum",
      { release: { kind: "unavailable", version: "0.4.3", commit: null } as const },
      {},
      "agent_update_unavailable",
    ],
    ["a current node", {}, { cliVersion: "0.4.3" }, "agent_update_current"],
  ])("refuses %s", async (_label, portOptions, row, reason) => {
    Object.assign(store.tables.node[0] ?? {}, row);
    await expect(client(makePort(portOptions)).start({ nodeId: "node-1" })).rejects.toMatchObject({
      data: { reason, subjectId: "node-1" },
    });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate).toEqual([]);
  });

  it("refuses a second update while one is in flight, and forces a waiting one in place", async () => {
    const first = await client().start({ nodeId: "node-1" });
    await expect(client().start({ nodeId: "node-1" })).rejects.toMatchObject({
      data: { reason: "agent_update_in_progress" },
    });
    // Forcing works only while the update waits for idle.
    await expect(client().start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
      data: { reason: "agent_update_in_progress" },
    });
    const row = store.tables.nodeAgentUpdate[0];
    if (row) row.phase = "WAITING_IDLE";
    const forced = await client().start({ nodeId: "node-1", force: true });
    expect(forced).toMatchObject({ id: first.id, force: true, phase: "waiting_idle" });
    expect(sent.map((frame) => [frame.updateId, frame.force])).toEqual([
      [first.id, false],
      [first.id, true],
    ]);
    // Instances survive this node's restart: nothing to stop.
    expect(stops.calls).toEqual([]);
  });

  it("stops a node's instances through the server when forcing an update they would not survive", async () => {
    stops.calls = [];
    const port = makePort({ selfUpdate: { ...SELF_UPDATE, instancesSurvive: false } });
    const first = await client(port).start({ nodeId: "node-1" });
    expect(stops.calls).toEqual([]);
    const row = store.tables.nodeAgentUpdate[0];
    if (row) row.phase = "WAITING_IDLE";
    const forced = await client(port).start({ nodeId: "node-1", force: true });
    expect(forced).toMatchObject({ id: first.id, force: true });
    // One normal STOP operation, by the server; the node only waits for it.
    expect(stops.calls).toEqual(["node-1"]);
  });
});

describe("nodes.agentUpdate.overview", () => {
  it("explains a node that cannot update itself, with its command", async () => {
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: "b".repeat(40), installMethod: "source", target: TARGET },
      environment: { wsl: true },
    });
    const overview = await client(
      makePort({ selfUpdate: { ...SELF_UPDATE, strategies: [] } }),
    ).overview();
    expect(overview.server).toEqual({ version: "0.4.3", commit: null, sourceBuild: false });
    expect(overview.defaultCanaryNodeId).toBeNull();
    expect(overview.nodes[0]).toMatchObject({
      nodeId: "node-1",
      outdated: true,
      wsl: true,
      canUpdate: false,
      blockedReason: "agent_update_unsupported",
      manualCommand:
        "cargo install --git R --tag v0.4.3 --locked --force wsmp && wsmp service restart",
      policy: "ALLOWED",
      latest: null,
      runningInstances: [],
    });
  });

  it("names the default canary and what Force would stop", async () => {
    store.tables.node.push(nodeRow({ id: "node-2", slug: "box-2" }));
    store.tables.instanceRank.push({
      nodeId: "node-1",
      userId: OWNER,
      phase: "READY",
      Instance: { id: "inst-1", Runtime: { name: "Qwen" } },
    });
    const overview = await client().overview();
    expect(overview.defaultCanaryNodeId).toBe("node-2");
    expect(overview.nodes.find((node) => node.nodeId === "node-1")?.runningInstances).toEqual([
      { id: "inst-1", name: "Qwen" },
    ]);
  });

  it("reports a source-build server", async () => {
    const overview = await client(
      makePort({ release: { kind: "source", version: "0.4.3", commit: null }, sourceBuild: true }),
    ).overview();
    expect(overview.server.sourceBuild).toBe(true);
    expect(overview.nodes[0]?.blockedReason).toBe("agent_update_unavailable");
  });
});

describe("nodes.agentUpdate.startAll / stopAll / setPolicy", () => {
  it("starts the canary first and refuses a second run", async () => {
    store.tables.node.push(
      nodeRow({ id: "node-2", slug: "box-2" }),
      nodeRow({ id: "node-3", slug: "box-3", agentUpdatePolicy: "OFF" }),
    );
    const batch = await client().startAll({ canaryNodeId: "node-2" });
    expect(batch).toMatchObject({
      state: "running",
      canaryNodeId: "node-2",
      // Only nodes that can update now; the one with updates off is not in the run.
      nodeIds: ["node-2", "node-1"],
      currentNodeId: "node-2",
      stoppedReason: null,
      untouchedNodeIds: [],
    });
    expect(sent.map((frame) => frame.nodeId)).toEqual(["node-2"]);
    await expect(client().startAll({})).rejects.toMatchObject({
      data: { reason: "agent_update_in_progress" },
    });
    const stopped = await client().stopAll({ batchId: batch.id });
    expect(stopped).toMatchObject({
      state: "stopped",
      stoppedReason: "stopped",
      // The canary's update goes on; the rest is not touched.
      untouchedNodeIds: ["node-1"],
    });
    expect((await client().overview()).batch?.id).toBe(batch.id);
  });

  it("refuses a canary that cannot update, and a run with nothing to update", async () => {
    Object.assign(store.tables.node[0] ?? {}, { agentUpdatePolicy: "OFF" });
    await expect(client().startAll({ canaryNodeId: "node-1" })).rejects.toMatchObject({
      data: { reason: "agent_update_off" },
    });
    await expect(client().startAll({})).rejects.toMatchObject({
      data: { reason: "agent_update_unavailable" },
    });
  });

  it("sets the policy of the owner's node", async () => {
    expect(await client().setPolicy({ nodeId: "node-1", policy: "OFF" })).toEqual({
      policy: "OFF",
    });
    expect(store.tables.node[0]?.agentUpdatePolicy).toBe("OFF");
  });
});
