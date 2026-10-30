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
let sent: Array<{ nodeId: string; force: boolean; updateId: string; version?: string }>;

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
      windowsUpdates: false,
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
      sent.push({
        nodeId,
        force: frame.force,
        updateId: frame.updateId,
        ...(frame.version !== "0.4.3" ? { version: frame.version } : {}),
      });
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

describe("nodes.agentUpdate Install anyway (Homebrew tap)", () => {
  const MAC = "aarch64-apple-darwin";
  const HOMEBREW = {
    strategies: ["homebrew"],
    instancesSurvive: false,
    remote: "allowed",
  };
  const macRelease: AgentUpdateRelease = {
    ...RELEASE,
    artifacts: { [MAC]: { url: "https://r.example/v0.4.3/m.tar.xz", sha256: "c".repeat(64) } },
  };

  it("lists the tap's version after its refusal and installs it on request", async () => {
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: null, installMethod: "homebrew", target: MAC },
    });
    const api = client(makePort({ release: macRelease, selfUpdate: HOMEBREW }));
    const first = await api.start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, {
      phase: "REFUSED",
      reason: "version_mismatch",
      availableVersion: "0.4.4",
      endedAt: new Date(),
    });
    const overview = await api.overview();
    expect(overview.nodes[0]).toMatchObject({
      canUpdate: true,
      availableVersion: "0.4.4",
      availableVersionAhead: true,
      newerThanServer: false,
      latest: { id: first.id, phase: "refused", reason: "version_mismatch" },
    });
    const anyway = await api.start({ nodeId: "node-1", version: "0.4.4" });
    expect(anyway).toMatchObject({ toVersion: "0.4.4", fromVersion: "0.4.2" });
    expect(sent.at(-1)).toMatchObject({ updateId: anyway.id, version: "0.4.4" });
    await expect(api.start({ nodeId: "node-1", version: "0.4.4" })).rejects.toMatchObject({
      data: { reason: "agent_update_in_progress" },
    });
  });

  it("shows each attempt with the strategy it used, after a reinstall either way", async () => {
    // A Homebrew attempt; the node is then reinstalled with the install script.
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: null, installMethod: "homebrew", target: MAC },
    });
    const viaBrew = await client(makePort({ release: macRelease, selfUpdate: HOMEBREW })).start({
      nodeId: "node-1",
    });
    expect(viaBrew.strategy).toBe("homebrew");
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, {
      phase: "FAILED",
      reason: "version_mismatch",
      endedAt: new Date(),
    });
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: null, installMethod: "script", target: MAC },
    });
    const script = client(
      makePort({ release: macRelease, selfUpdate: { ...HOMEBREW, strategies: ["self-replace"] } }),
    );
    const afterBrew = (await script.overview()).nodes[0];
    expect(afterBrew?.latest).toMatchObject({
      id: viaBrew.id,
      strategy: "homebrew",
    });
    // The explanation is Homebrew's; the repair is the script's, how the node is installed now.
    expect(afterBrew?.manualCommand).toBe(
      "curl -fsSL https://proxy.example.com/install.sh | sh && ~/.cargo/bin/wsmp service restart",
    );
    // A self-replace attempt; the node is then reinstalled with Homebrew.
    const viaSwap = await script.start({ nodeId: "node-1" });
    expect(viaSwap.strategy).toBe("self-replace");
    const swapRow = store.tables.nodeAgentUpdate.find((row) => row.id === viaSwap.id);
    Object.assign(swapRow ?? {}, {
      phase: "FAILED",
      reason: "version_mismatch",
      endedAt: new Date(),
    });
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: null, installMethod: "homebrew", target: MAC },
    });
    const brew = client(makePort({ release: macRelease, selfUpdate: HOMEBREW }));
    expect((await brew.overview()).nodes[0]?.latest).toMatchObject({
      id: viaSwap.id,
      strategy: "self-replace",
    });
    // Offline, it needs a hand update: Homebrew's command, how the node is installed now.
    Object.assign(store.tables.node[0] ?? {}, { connection: "OFFLINE" });
    expect((await brew.overview()).nodes[0]?.manualCommand).toBe(
      "brew reinstall flycockpit/tap/wsmp && wsmp service restart",
    );
  });

  it("refuses a version the node did not offer", async () => {
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: null, installMethod: "homebrew", target: MAC },
    });
    const api = client(makePort({ release: macRelease, selfUpdate: HOMEBREW }));
    await expect(api.start({ nodeId: "node-1", version: "0.4.4" })).rejects.toMatchObject({
      data: { reason: "agent_update_unavailable", subjectId: "node-1" },
    });
    expect(sent).toEqual([]);
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

describe("nodes.agentUpdate claims against a concurrent policy or trust change", () => {
  // `setPolicy` (or a trust lowering) commits while the start awaits the release lookup, after
  // the start's own checks: the claim re-reads both under the node's row lock and is refused.
  function offDuringLookup(port: AgentUpdatePort, change: () => Promise<unknown>) {
    const release = port.release;
    port.release = async () => {
      await change();
      return release();
    };
  }
  const turnOff = () => client().setPolicy({ nodeId: "node-1", policy: "OFF" });
  const lowerTrust = async () => {
    Object.assign(store.tables.node[0] ?? {}, { trustLowerRequestedAt: new Date() });
  };

  it.each([
    ["policy off", turnOff, "agent_update_off"],
    ["a trust lowering", lowerTrust, "trust_relay"],
  ] as const)("refuses a start when %s commits during it", async (_label, change, reason) => {
    const port = makePort();
    offDuringLookup(port, change);
    await expect(client(port).start({ nodeId: "node-1" })).rejects.toMatchObject({
      data: { reason, subjectId: "node-1" },
    });
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(sent).toEqual([]);
  });

  /** The operations of the transaction that ran `claim`: the lock must come first, in it. */
  function claimTransaction(claim: string) {
    const write = store.operations.find((entry) => entry.op === claim);
    expect(write, claim).toBeDefined();
    expect(write?.tx, `${claim} runs in a transaction`).not.toBeNull();
    return store.operations.filter((entry) => entry.tx === write?.tx).map((entry) => entry.op);
  }

  it("locks the node row in the claim's transaction before it writes the update", async () => {
    await client().start({ nodeId: "node-1" });
    expect(store.rawQueries).toEqual([
      {
        sql: 'SELECT "agentUpdatePolicy", trust, "trustLowerRequestedAt" FROM node WHERE id = ? AND "userId" = ? FOR UPDATE',
        values: ["node-1", OWNER],
      },
    ]);
    // In the same transaction as the create, and before it; never outside a transaction.
    expect(claimTransaction("nodeAgentUpdate.create")).toEqual([
      "lockNode",
      "nodeAgentUpdate.create",
    ]);
    expect(
      store.operations.filter((entry) => entry.tx === null && entry.op === "lockNode"),
    ).toEqual([]);
  });

  it("locks the node row in the transaction that marks a waiting update forced", async () => {
    const port = makePort();
    await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    store.operations.length = 0;
    await client(port).start({ nodeId: "node-1", force: true });
    expect(claimTransaction("nodeAgentUpdate.updateMany")).toEqual([
      "lockNode",
      "nodeAgentUpdate.updateMany",
    ]);
  });

  it("locks the node row in the transaction that claims a batch's node", async () => {
    const port = makePort();
    store.tables.nodeAgentUpdateBatch.push({
      id: "batch-1",
      userId: OWNER,
      nodeIds: ["node-1"],
      position: 0,
      currentUpdateId: null,
      currentNodeId: null,
      skippedNodeIds: [],
      targetVersion: "0.4.3",
      targetDigest: null,
      updatedAt: new Date(),
      state: "RUNNING",
    });
    const { advanceAgentUpdateBatch } = await import("../lib/agent-updates");
    await advanceAgentUpdateBatch(port, "batch-1", "https://proxy.example.com");
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
    expect(claimTransaction("nodeAgentUpdate.create")).toEqual([
      "lockNode",
      "nodeAgentUpdate.create",
      "nodeAgentUpdateBatch.updateMany",
    ]);
  });

  it("refuses Install anyway when policy off commits during it", async () => {
    const MAC = "aarch64-apple-darwin";
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: null, installMethod: "homebrew", target: MAC },
    });
    const port = makePort({
      release: {
        ...RELEASE,
        artifacts: { [MAC]: { url: "https://r.example/m.tar.xz", sha256: "c".repeat(64) } },
      },
      selfUpdate: { strategies: ["homebrew"], instancesSurvive: false, remote: "allowed" },
    });
    await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, {
      phase: "REFUSED",
      reason: "version_mismatch",
      availableVersion: "0.4.4",
      endedAt: new Date(),
    });
    offDuringLookup(port, turnOff);
    await expect(client(port).start({ nodeId: "node-1", version: "0.4.4" })).rejects.toMatchObject({
      data: { reason: "agent_update_off" },
    });
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("does not force a waiting update when policy off commits during it", async () => {
    const port = makePort();
    const first = await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    offDuringLookup(port, turnOff);
    await expect(client(port).start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
      data: { reason: "agent_update_off" },
    });
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({ id: first.id, force: false });
    expect(sent.map((frame) => frame.force)).toEqual([false]);
  });

  it("does not start a batch's node when policy off commits during it", async () => {
    const port = makePort();
    offDuringLookup(port, turnOff);
    store.tables.nodeAgentUpdateBatch.push({
      id: "batch-1",
      userId: OWNER,
      nodeIds: ["node-1"],
      position: 0,
      currentUpdateId: null,
      currentNodeId: null,
      skippedNodeIds: [],
      targetVersion: "0.4.3",
      targetDigest: null,
      updatedAt: new Date(),
      state: "RUNNING",
    });
    const { advanceAgentUpdateBatch } = await import("../lib/agent-updates");
    await advanceAgentUpdateBatch(port, "batch-1", "https://proxy.example.com");
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(sent).toEqual([]);
  });
});
