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
  // As the real one: `allowed` runs in the stop's transaction before anything is recorded.
  stopInstancesOnNode: vi.fn(
    async (
      _context: unknown,
      _userId: string,
      nodeId: string,
      allowed?: (tx: never) => Promise<boolean>,
    ) => {
      if (allowed && !(await allowed(fake.db as never))) return null;
      stops.calls.push(nodeId);
      return "op-1";
    },
  ),
}));

import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import type { AgentUpdatePort, AgentUpdateRelease } from "../lib/agent-updates";
import { nodesRouter } from "../routers/nodes";
import {
  NOT_A_PERSON,
  OWNER,
  PERSON,
  procedureAt,
  READ_AGENT,
  session,
} from "./lane-b-test-helpers";

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
      store.note("send");
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
  // Each operation with an input it accepts from a person, so a refusal can only be the
  // caller's (never the input's): normal, forced and Install-anyway starts included.
  const operations: ReadonlyArray<readonly [string, unknown]> = [
    ["overview", undefined],
    ["start", { nodeId: "node-1" }],
    ["start", { nodeId: "node-1", force: true }],
    ["start", { nodeId: "node-1", version: "0.4.4" }],
    ["startAll", {}],
    ["stopAll", { batchId: "batch-1" }],
    ["setPolicy", { nodeId: "node-1", policy: "OFF" }],
  ];
  const denied: ReadonlyArray<readonly [string, Context["auth"], "FORBIDDEN" | "UNAUTHORIZED"]> = [
    ...NOT_A_PERSON.map(([label, auth]) => [label, auth, "FORBIDDEN"] as const),
    ["Read agent token", READ_AGENT, "FORBIDDEN"],
    ["anonymous caller", { kind: "anonymous" }, "UNAUTHORIZED"],
  ];
  for (const [label, auth, code] of denied)
    for (const [operation, input] of operations)
      it(`refuses a ${label} ${operation} ${JSON.stringify(input) ?? ""} with ${code} (never MCP, OAuth or an agent token)`, async () => {
        const api = createRouterClient(nodesRouter, {
          context: { session, auth, services: { agentUpdates: makePort() } },
        });
        await expect(procedureAt(api.agentUpdate, operation)(input)).rejects.toMatchObject({
          code,
        });
        expect(sent).toEqual([]);
        expect(store.tables.nodeAgentUpdate).toEqual([]);
        expect(store.tables.node[0]?.agentUpdatePolicy).toBe("ALLOWED");
      });

  it("accepts each of those inputs from the person (the refusals above are the caller's)", async () => {
    const api = client();
    for (const [operation, input] of operations)
      await procedureAt(
        api,
        operation,
      )(input).catch((error: { code?: string }) => {
        // Refused for what the node or batch is, never for the input or the caller.
        expect(["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]).not.toContain(error.code);
      });
  });

  for (const [operation, input] of operations.filter(([operation]) => operation !== "overview"))
    it(`refuses ${operation} ${JSON.stringify(input)} through an impersonation session`, async () => {
      const impersonated = {
        ...session,
        session: { ...session.session, impersonatedBy: "admin-1" },
      } as unknown as Session;
      await expect(
        procedureAt(client(makePort(), PERSON, impersonated), operation)(input),
      ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "human_only" } });
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

  // F-FA-1 (P-REPLAY): the node's operator turned remote updates off after the update started
  // waiting (`node.state` already reported it): no forced resend, no force mark, no stop.
  it("never forces a waiting update on a node that opted out since", async () => {
    stops.calls = [];
    const feature = { ...SELF_UPDATE, instancesSurvive: false };
    const port = makePort({ selfUpdate: feature });
    const first = await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    feature.remote = "off";
    await expect(client(port).start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
      data: { reason: "agent_update_opted_out", subjectId: "node-1" },
    });
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({ id: first.id, force: false });
    expect(sent.map((frame) => frame.force)).toEqual([false]);
    expect(stops.calls).toEqual([]);
    // The inverse: remote allowed again, the same update is forced and resent, and stopped for.
    feature.remote = "allowed";
    const forced = await client(port).start({ nodeId: "node-1", force: true });
    expect(forced).toMatchObject({ id: first.id, force: true });
    expect(sent.at(-1)).toMatchObject({ updateId: first.id, force: true });
    expect(stops.calls).toEqual(["node-1"]);
  });

  // F-FA-1 (P-LIVE-ENTRY): remote off arrives while the release is looked up, on a forced
  // first start: the claim reads the live session again, so nothing is claimed, sent or stopped.
  it("refuses a forced first start whose node opted out during the release lookup", async () => {
    stops.calls = [];
    const port = makePort({ selfUpdate: { ...SELF_UPDATE, instancesSurvive: false } });
    let live = port.liveNode("node-1");
    port.liveNode = () => live;
    port.release = async () => {
      if (live)
        live = { ...live, selfUpdate: { ...SELF_UPDATE, instancesSurvive: false, remote: "off" } };
      return RELEASE;
    };
    await expect(client(port).start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
      data: { reason: "agent_update_opted_out" },
    });
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(sent).toEqual([]);
    expect(stops.calls).toEqual([]);
  });

  it("sends nothing when the node opts out between the claim and the send", async () => {
    stops.calls = [];
    const feature = { ...SELF_UPDATE, instancesSurvive: false };
    const port = makePort({ selfUpdate: feature });
    const first = await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    // The opt-out lands right after the claim's transaction (the force mark) commits.
    const transaction = store.client.$transaction;
    store.client.$transaction = async (work) => {
      const result = await transaction(work);
      feature.remote = "off";
      return result;
    };
    await expect(client(port).start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
      data: { reason: "agent_update_opted_out" },
    });
    // The mark is undone, nothing more went out, and nothing was stopped.
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({ id: first.id, force: false });
    expect(sent).toHaveLength(1);
    expect(stops.calls).toEqual([]);
  });

  it("records no stop when the node opts out after the forced send", async () => {
    stops.calls = [];
    const feature = { ...SELF_UPDATE, instancesSurvive: false };
    const port = makePort({ selfUpdate: feature });
    await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    const send = port.send;
    port.send = (...args) => {
      const out = send(...args);
      feature.remote = "off";
      return out;
    };
    const forced = await client(port).start({ nodeId: "node-1", force: true });
    expect(forced.force).toBe(true);
    expect(sent.at(-1)?.force).toBe(true);
    // The node refuses the update itself; the server stops none of its instances.
    expect(stops.calls).toEqual([]);
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
      // Refused on this connection (the port's generation 1); the build has no commit.
      availableGeneration: 1,
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

  // F-FA-3 (P-CAPABILITY): with no commit on either side, the refusal proved the tap check only
  // for the wsmp on that connection; after a reconnect the node must refuse again.
  it("does not reuse a refusal from another connection when no build commit is known", async () => {
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: null, installMethod: "homebrew", target: MAC },
    });
    const port = makePort({ release: macRelease, selfUpdate: HOMEBREW });
    await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, {
      phase: "REFUSED",
      reason: "version_mismatch",
      availableVersion: "0.4.4",
      availableGeneration: 1,
      endedAt: new Date(),
    });
    const before = port.liveNode;
    port.liveNode = (id) => {
      const live = before(id);
      return live ? { ...live, connectionGeneration: 2 } : null;
    };
    expect((await client(port).overview()).nodes[0]?.availableVersion).toBeNull();
    await expect(client(port).start({ nodeId: "node-1", version: "0.4.4" })).rejects.toMatchObject({
      data: { reason: "agent_update_unavailable" },
    });
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
    // A refusal stored without its connection (an older server's row) proves nothing either.
    port.liveNode = before;
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { availableGeneration: null });
    expect((await client(port).overview()).nodes[0]?.availableVersion).toBeNull();
  });

  it("reuses a refusal across connections only for the same known build", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit, installMethod: "homebrew", target: MAC },
    });
    const port = makePort({ release: macRelease, selfUpdate: HOMEBREW });
    await client(port).start({ nodeId: "node-1" });
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, {
      phase: "REFUSED",
      reason: "version_mismatch",
      availableVersion: "0.4.4",
      availableGeneration: 1,
      endedAt: new Date(),
    });
    const before = port.liveNode;
    port.liveNode = (id) => {
      const live = before(id);
      return live ? { ...live, connectionGeneration: 2 } : null;
    };
    expect((await client(port).overview()).nodes[0]?.availableVersion).toBe("0.4.4");
    // Another build of the same version: not the wsmp that refused.
    Object.assign(store.tables.node[0] ?? {}, {
      cliBuild: { commit: "f".repeat(40), installMethod: "homebrew", target: MAC },
    });
    expect((await client(port).overview()).nodes[0]?.availableVersion).toBeNull();
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
    const lock = {
      sql: 'SELECT "agentUpdatePolicy", trust, "trustLowerRequestedAt", features, connection, "connectionGeneration", "cliVersion", "cliBuild" FROM node WHERE id = ? AND "userId" = ? FOR UPDATE',
      values: ["node-1", OWNER],
    };
    const claimed = {
      sql: 'SELECT phase, "endedAt", force FROM node_agent_update WHERE id = ? AND "userId" = ? AND "nodeId" = ? FOR UPDATE',
      values: [store.tables.nodeAgentUpdate[0]?.id, OWNER, "node-1"],
    };
    // The claim's lock, then the send's: the node row, then the claimed update's row.
    expect(store.rawQueries).toEqual([lock, lock, claimed]);
    // In the same transaction as the create, and before it; never outside a transaction.
    expect(claimTransaction("nodeAgentUpdate.create")).toEqual([
      "lockNode",
      "nodeAgentUpdate.create",
    ]);
    expect(
      store.operations.filter((entry) => entry.tx === null && entry.op === "lockNode"),
    ).toEqual([]);
  });

  it("sends in a transaction of its own after the claim's, under the node's lock, then the update's", async () => {
    await client().start({ nodeId: "node-1" });
    const send = store.operations.find((entry) => entry.op === "send");
    const claim = store.operations.find((entry) => entry.op === "nodeAgentUpdate.create");
    expect(send?.tx).not.toBeNull();
    // Later than the claim's (committed first: the node's first report finds the row).
    expect(send?.tx).toBeGreaterThan(claim?.tx ?? Number.POSITIVE_INFINITY);
    expect(store.operations.filter((entry) => entry.tx === send?.tx).map((e) => e.op)).toEqual([
      "lockNode",
      "lockUpdate",
      "send",
    ]);
  });

  it("sets the policy under the same lock", async () => {
    await client().setPolicy({ nodeId: "node-1", policy: "OFF" });
    expect(claimTransaction("node.updateMany")).toEqual(["lockNode", "node.updateMany"]);
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
      availableGeneration: 1,
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

describe("nodes.agentUpdate sends only under the update-authority lock (F-FA-1)", () => {
  const turnOff = () => client().setPolicy({ nodeId: "node-1", policy: "OFF" });
  // The node turned remote updates off: the server stored it (`node.state`), its session's copy
  // changes a turn later.
  const optOutStored = async () => {
    Object.assign(store.tables.node[0] ?? {}, {
      features: { selfUpdate: { ...SELF_UPDATE, remote: "off" } },
    });
  };
  const lowerTrust = async () => {
    Object.assign(store.tables.node[0] ?? {}, { trustLowerRequestedAt: new Date() });
  };
  const nothing = async () => undefined;

  /** Runs `change` once the next `count`-th transaction has committed (the claim's). */
  function afterClaim(change: () => Promise<unknown>, count = 1) {
    const transaction = store.client.$transaction;
    let seen = 0;
    store.client.$transaction = async (work) => {
      const result = await transaction(work);
      seen += 1;
      if (seen === count) await change();
      return result;
    };
  }

  function batch() {
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
  }

  it.each([
    ["policy off", turnOff, "agent_update_off"],
    ["a stored opt-out", optOutStored, "agent_update_opted_out"],
    ["a trust lowering", lowerTrust, "trust_relay"],
  ] as const)(
    "refuses a first start when %s commits after the claim",
    async (_label, change, reason) => {
      afterClaim(change);
      await expect(client().start({ nodeId: "node-1" })).rejects.toMatchObject({
        data: { reason },
      });
      expect(store.tables.nodeAgentUpdate).toEqual([]);
      expect(sent).toEqual([]);
    },
  );

  it("refuses a forced first start when policy off commits after the claim", async () => {
    afterClaim(turnOff);
    await expect(client().start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
      data: { reason: "agent_update_off" },
    });
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each([
    ["policy off", turnOff, "agent_update_off"],
    ["a stored opt-out", optOutStored, "agent_update_opted_out"],
  ] as const)(
    "does not resend a forced update when %s commits after its claim",
    async (_label, change, reason) => {
      const port = makePort();
      const first = await client(port).start({ nodeId: "node-1" });
      Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
      afterClaim(change);
      await expect(client(port).start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
        data: { reason },
      });
      expect(store.tables.nodeAgentUpdate[0]).toMatchObject({ id: first.id, force: false });
      expect(sent.map((frame) => frame.force)).toEqual([false]);
    },
  );

  it("does not send Install anyway when policy off commits after its claim", async () => {
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
      availableGeneration: 1,
      endedAt: new Date(),
    });
    afterClaim(turnOff);
    await expect(client(port).start({ nodeId: "node-1", version: "0.4.4" })).rejects.toMatchObject({
      data: { reason: "agent_update_off" },
    });
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("does not send a batch's step when policy off commits after its claim, and frees the run", async () => {
    batch();
    afterClaim(turnOff);
    const { advanceAgentUpdateBatch } = await import("../lib/agent-updates");
    await advanceAgentUpdateBatch(makePort(), "batch-1", "https://proxy.example.com");
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(sent).toEqual([]);
    // The claim's pointer was undone under the lock (the run then stops: its canary was refused).
    expect(store.tables.nodeAgentUpdateBatch[0]).toMatchObject({ currentUpdateId: null });
  });

  it("refuses a send whose live session opted out after the claim", async () => {
    const port = makePort();
    const live = port.liveNode;
    let off = false;
    port.liveNode = (nodeId) => {
      const node = live(nodeId);
      return node && off
        ? { ...node, selfUpdate: { ...SELF_UPDATE, remote: "off" } as never }
        : node;
    };
    afterClaim(async () => {
      off = true;
    });
    await expect(client(port).start({ nodeId: "node-1" })).rejects.toMatchObject({
      data: { reason: "agent_update_opted_out" },
    });
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("starts as before when nothing changes after the claim (allowed control)", async () => {
    afterClaim(nothing);
    const started = await client().start({ nodeId: "node-1" });
    expect(started).toMatchObject({ phase: "requested" });
    expect(sent).toHaveLength(1);
    batch();
    store.tables.nodeAgentUpdate.length = 0;
    sent.length = 0;
    const { advanceAgentUpdateBatch } = await import("../lib/agent-updates");
    await advanceAgentUpdateBatch(makePort(), "batch-1", "https://proxy.example.com");
    expect(sent).toHaveLength(1);
    expect(store.tables.nodeAgentUpdateBatch[0]?.currentUpdateId).toBe(
      store.tables.nodeAgentUpdate[0]?.id,
    );
  });

  it("undoes the claim when the socket refuses the frame (send failure)", async () => {
    batch();
    const port = makePort();
    port.send = () => false;
    const { advanceAgentUpdateBatch } = await import("../lib/agent-updates");
    await advanceAgentUpdateBatch(port, "batch-1", "https://proxy.example.com");
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(store.tables.nodeAgentUpdateBatch[0]).toMatchObject({ currentUpdateId: null });
    await expect(client(port).start({ nodeId: "node-1" })).rejects.toMatchObject({
      data: { reason: "node_offline" },
    });
    expect(store.tables.nodeAgentUpdate).toEqual([]);
  });

  it("counts a frame that went out as started even if the lock's commit fails", async () => {
    const transaction = store.client.$transaction;
    let calls = 0;
    store.client.$transaction = async (work) => {
      calls += 1;
      const result = await transaction(work);
      // The second transaction is the send's: it wrote nothing, so a failed commit changes nothing.
      if (calls === 2) throw new Error("commit failed");
      return result;
    };
    await expect(client().start({ nodeId: "node-1" })).resolves.toMatchObject({
      phase: "requested",
    });
    expect(sent).toHaveLength(1);
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
  });

  it("calls the socket in exactly one place, after the locked check, with no await between", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../lib/agent-updates.ts", import.meta.url), "utf8");
    expect(source.split("port.send(").length - 1).toBe(1);
    const body = source.slice(source.indexOf("async function sendUnderAuthority("));
    const node = body.indexOf("await lockAgentUpdateAuthority(");
    // The node's lock first, then the claimed update's (the lock order everywhere).
    const lock = body.indexOf("await lockClaimedUpdate(");
    const send = body.indexOf("port.send(");
    expect(node).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(node);
    expect(send).toBeGreaterThan(lock);
    const between = body.slice(lock + "await lockClaimedUpdate(".length, send);
    expect(between).toContain("agentUpdateAuthorityRefusal(");
    expect(between).toContain("claimPermitsSend(");
    expect(between).not.toContain("await");
  });
});
