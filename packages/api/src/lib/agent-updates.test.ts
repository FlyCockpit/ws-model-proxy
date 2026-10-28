import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentUpdateDb, nodeRow } from "./agent-update-test-fake";

const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@ws-model-proxy/db", () => ({
  get default() {
    return fake.db;
  },
}));

import { AGENT_UPDATE_ROLLBACK_SECS_DEFAULT, type AgentUpdateFrame } from "./agent-update-wire";
import {
  type AgentUpdatePort,
  advanceAgentUpdateBatch,
  agentUpdateDeadline,
  agentUpdateEligibility,
  agentUpdateReleaseDigest,
  applyAgentUpdateProgress,
  chooseCanary,
  cleanAgentUpdateDetail,
  expireAgentUpdates,
  manualCommandFor,
  progressAllowed,
  startAgentUpdate,
  untouchedNodeIds,
} from "./agent-updates";

const OWNER = "owner-1";
const ORIGIN = "https://proxy.example.com";
const TARGET = "x86_64-unknown-linux-gnu";
const SELF_UPDATE = {
  strategies: ["self-replace"],
  instancesSurvive: true,
  remote: "allowed" as const,
};

let store: ReturnType<typeof createAgentUpdateDb>;

function port(overrides: Partial<AgentUpdatePort> = {}) {
  const sent: Array<{ nodeId: string; frame: AgentUpdateFrame }> = [];
  const value: AgentUpdatePort = {
    server: async () => ({
      version: "0.4.3",
      commit: null,
      sourceBuild: false,
      cargoInstall:
        "cargo install --git https://example.test/wsmp --tag v0.4.3 --locked --force wsmp",
    }),
    release: async () => ({
      kind: "release",
      version: "0.4.3",
      commit: null,
      releaseUrl: "https://r.example/v0.4.3",
      artifacts: {
        [TARGET]: { url: `https://r.example/v0.4.3/wsmp-${TARGET}.tar.xz`, sha256: "a".repeat(64) },
      },
    }),
    liveNode: (nodeId) =>
      store.tables.node.some((node) => node.id === nodeId && node.connection === "ONLINE")
        ? { userId: OWNER, connectionGeneration: 3, trust: "full", selfUpdate: SELF_UPDATE }
        : null,
    send: (nodeId, frame) => {
      sent.push({ nodeId, frame });
      return true;
    },
    ...overrides,
  };
  return { port: value, sent };
}

function addNodes(...rows: Array<Record<string, unknown>>) {
  store.tables.node.push(...rows.map((row) => nodeRow(row)));
}

beforeEach(() => {
  store = createAgentUpdateDb();
  fake.db = store.client;
});

describe("phases", () => {
  it("only moves forward, and lets the node's final word replace timed_out", () => {
    expect(progressAllowed("requested", "downloading")).toBe(true);
    expect(progressAllowed("verifying", "downloading")).toBe(false);
    expect(progressAllowed("restarting", "confirmed")).toBe(true);
    expect(progressAllowed("confirmed", "failed")).toBe(false);
    expect(progressAllowed("refused", "downloading")).toBe(false);
    expect(progressAllowed("timed_out", "confirmed")).toBe(true);
    expect(progressAllowed("timed_out", "rolled_back")).toBe(true);
    expect(progressAllowed("timed_out", "downloading")).toBe(false);
  });

  it("sets the server deadline per phase (rollbackAfterSecs + 120 s around the restart)", () => {
    const now = new Date(0);
    expect(agentUpdateDeadline("requested", 90, now)?.getTime()).toBe(120_000);
    expect(agentUpdateDeadline("waiting_idle", 90, now)?.getTime()).toBe(31 * 60_000);
    expect(agentUpdateDeadline("swapped", 90, now)?.getTime()).toBe(210_000);
    expect(agentUpdateDeadline("restarting", 300, now)?.getTime()).toBe(420_000);
    expect(agentUpdateDeadline("confirmed", 90, now)).toBeNull();
  });

  it("keeps node text plain: control and bidi characters go, 4000 characters at most", () => {
    expect(cleanAgentUpdateDetail("ok\u0007‮ line\n\tnext")).toBe("ok line\n\tnext");
    expect(Array.from(cleanAgentUpdateDetail("😀".repeat(5000)))).toHaveLength(4000);
  });
});

describe("eligibility", () => {
  const server = {
    version: "0.4.3",
    commit: null,
    sourceBuild: false,
    cargoInstall: "cargo install --git R --tag v0.4.3 --locked --force wsmp",
  };
  const release = {
    kind: "release" as const,
    version: "0.4.3",
    commit: null,
    releaseUrl: "u",
    artifacts: { [TARGET]: { url: "https://u/a", sha256: "a".repeat(64) } },
  };
  const live = {
    userId: OWNER,
    connectionGeneration: 1,
    trust: "full" as const,
    selfUpdate: SELF_UPDATE,
  };
  const check = (
    row: Record<string, unknown>,
    options: Partial<Parameters<typeof agentUpdateEligibility>[0]> = {},
  ) =>
    agentUpdateEligibility({
      row: nodeRow(row) as never,
      live,
      release,
      server,
      origin: ORIGIN,
      active: null,
      ...options,
    });

  it("offers the update to an outdated, online, Full node that allows it", () => {
    const result = check({});
    expect(result).toMatchObject({
      canUpdate: true,
      blockedReason: null,
      strategy: "self-replace",
    });
    expect(result.manualCommand).toBeNull();
  });

  it("says why not, with the command to run on the node", () => {
    expect(check({}, { live: null })).toMatchObject({
      blockedReason: "node_offline",
      manualCommand: `curl -fsSL ${ORIGIN}/install.sh | sh && ~/.cargo/bin/wsmp service restart`,
    });
    expect(check({}, { live: { ...live, trust: "relay" } }).blockedReason).toBe("trust_relay");
    expect(check({ trustLowerRequestedAt: new Date() }).blockedReason).toBe("trust_relay");
    expect(check({ agentUpdatePolicy: "OFF" }).blockedReason).toBe("agent_update_off");
    expect(check({}, { live: { ...live, selfUpdate: null } }).blockedReason).toBe("upgrade_wsmp");
    expect(check({}, { live: { ...live, userId: "someone-else" } }).blockedReason).toBe(
      "node_offline",
    );
    const source = check(
      { cliBuild: { commit: "b".repeat(40), installMethod: "source", target: TARGET } },
      { live: { ...live, selfUpdate: { ...SELF_UPDATE, strategies: [] } } },
    );
    expect(source).toMatchObject({ blockedReason: "agent_update_unsupported" });
    expect(source.manualCommand).toBe(`${server.cargoInstall} && wsmp service restart`);
    expect(
      check({}, { live: { ...live, selfUpdate: { ...SELF_UPDATE, remote: "off" } } }).blockedReason,
    ).toBe("agent_update_opted_out");
    // A server that builds from source has nothing to send (D8).
    expect(
      check({}, { release: { kind: "source", version: "0.4.3", commit: null } }).blockedReason,
    ).toBe("agent_update_unavailable");
    expect(
      check({}, { release: { kind: "unavailable", version: "0.4.3", commit: null } }).blockedReason,
    ).toBe("agent_update_unavailable");
    expect(check({ cliVersion: "0.4.3" })).toMatchObject({
      blockedReason: "agent_update_current",
      manualCommand: null,
    });
    expect(check({}, { active: { phase: "downloading", strategy: "self-replace" } })).toMatchObject(
      { blockedReason: "agent_update_in_progress", manualCommand: null },
    );
  });

  it("offers the update only on platforms it was verified on (Linux, WSL included)", () => {
    const on = (target: string, strategies: string[] = ["self-replace"]) =>
      check(
        { cliBuild: { commit: null, installMethod: "script", target } },
        { live: { ...live, selfUpdate: { ...SELF_UPDATE, strategies } } },
      );
    expect(on(TARGET).canUpdate).toBe(true);
    for (const target of ["x86_64-pc-windows-msvc", "aarch64-apple-darwin"]) {
      expect(on(target)).toMatchObject({
        canUpdate: false,
        blockedReason: "agent_update_platform",
      });
      expect(on(target).manualCommand).not.toBeNull();
    }
    expect(on("aarch64-apple-darwin", ["homebrew"]).blockedReason).toBe("agent_update_platform");
    // Homebrew on Linux has not been verified either.
    expect(on(TARGET, ["homebrew"]).blockedReason).toBe("agent_update_platform");
  });

  it("ignores a strategy it does not know (a newer CLI)", () => {
    expect(
      check({}, { live: { ...live, selfUpdate: { ...SELF_UPDATE, strategies: ["binstall"] } } })
        .blockedReason,
    ).toBe("agent_update_unsupported");
  });

  it("counts a different commit of the same version as outdated", () => {
    const withCommit = { ...server, commit: "c".repeat(40) };
    const build = { commit: "d".repeat(40), installMethod: "script", target: TARGET };
    expect(check({ cliVersion: "0.4.3", cliBuild: build }, { server: withCommit }).outdated).toBe(
      true,
    );
    expect(check({ cliVersion: "0.4.3", cliBuild: build }).outdated).toBe(false);
  });

  it("builds the manual commands", () => {
    const build = (installMethod: string) =>
      ({ commit: null, installMethod, target: TARGET }) as never;
    expect(
      manualCommandFor({ origin: ORIGIN, build: build("homebrew"), windows: false, server }),
    ).toBe("brew reinstall flycockpit/tap/wsmp && wsmp service restart");
    expect(manualCommandFor({ origin: `${ORIGIN}/`, build: null, windows: true, server })).toBe(
      `irm ${ORIGIN}/install.ps1 | iex; & "$env:USERPROFILE\\.cargo\\bin\\wsmp.exe" service restart`,
    );
  });
});

describe("startAgentUpdate", () => {
  it("writes the requested row and sends agent.update with the release artifact", async () => {
    addNodes({});
    const { port: p, sent } = port();
    const outcome = await startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force: false,
      origin: ORIGIN,
    });
    expect(outcome.kind).toBe("started");
    expect(sent).toHaveLength(1);
    const frame = sent[0]?.frame;
    expect(frame).toMatchObject({
      type: "agent.update",
      version: "0.4.3",
      artifactUrl: `https://r.example/v0.4.3/wsmp-${TARGET}.tar.xz`,
      sha256: "a".repeat(64),
      signature: null,
      force: false,
      rollbackAfterSecs: AGENT_UPDATE_ROLLBACK_SECS_DEFAULT,
    });
    expect(frame?.updateId).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({
      id: frame?.updateId,
      phase: "REQUESTED",
      fromVersion: "0.4.2",
      toVersion: "0.4.3",
    });
  });

  it("refuses a second one while one is in flight", async () => {
    addNodes({});
    const { port: p } = port();
    await startAgentUpdate(p, { userId: OWNER, nodeId: "node-1", force: false, origin: ORIGIN });
    const again = await startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force: false,
      origin: ORIGIN,
    });
    expect(again).toMatchObject({ kind: "refused", reason: "agent_update_in_progress" });
  });

  it("finds nothing of another owner's", async () => {
    addNodes({ userId: "someone-else" });
    const { port: p, sent } = port();
    expect(
      await startAgentUpdate(p, { userId: OWNER, nodeId: "node-1", force: false, origin: ORIGIN }),
    ).toEqual({ kind: "not_found" });
    expect(sent).toEqual([]);
  });

  it("undoes the row when the frame could not be sent", async () => {
    addNodes({});
    const { port: p } = port({ send: () => false });
    const outcome = await startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force: false,
      origin: ORIGIN,
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "node_offline" });
    expect(store.tables.nodeAgentUpdate).toEqual([]);
  });

  it("forces an update that waits for idle by resending it, same id, force true", async () => {
    addNodes({});
    const { port: p, sent } = port();
    const first = await startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force: false,
      origin: ORIGIN,
    });
    if (first.kind !== "started") throw new Error("not started");
    await applyAgentUpdateProgress(
      { nodeId: "node-1", userId: OWNER },
      { updateId: first.updateId, phase: "waiting_idle" },
    );
    // Not forced: still refused.
    expect(
      await startAgentUpdate(p, { userId: OWNER, nodeId: "node-1", force: false, origin: ORIGIN }),
    ).toMatchObject({ reason: "agent_update_in_progress" });
    const forced = await startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force: true,
      origin: ORIGIN,
    });
    expect(forced).toEqual({ kind: "started", updateId: first.updateId });
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
    expect(store.tables.nodeAgentUpdate[0]?.force).toBe(true);
    expect(sent.map(({ frame }) => [frame.updateId, frame.force])).toEqual([
      [first.updateId, false],
      [first.updateId, true],
    ]);
  });
});

describe("progress and the deadline", () => {
  async function started() {
    addNodes({});
    const { port: p } = port();
    const outcome = await startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force: false,
      origin: ORIGIN,
    });
    if (outcome.kind !== "started") throw new Error("not started");
    return outcome.updateId;
  }

  it("keeps a report that loses its write to a concurrent one (verifying, then refused)", async () => {
    const id = await started();
    const node = { nodeId: "node-1", userId: OWNER };
    await applyAgentUpdateProgress(node, { updateId: id, phase: "downloading" });
    const table = store.client.nodeAgentUpdate as {
      updateMany: (args: { where?: unknown; data: Record<string, unknown> }) => Promise<{
        count: number;
      }>;
    };
    const write = table.updateMany.bind(table);
    let raced = false;
    table.updateMany = async (args) => {
      if (!raced && args.data.phase === "REFUSED") {
        // `verifying` lands between the refusal's read (downloading) and its write.
        raced = true;
        const row = store.tables.nodeAgentUpdate.find((update) => update.id === id);
        if (row) row.phase = "VERIFYING";
      }
      return write(args);
    };
    expect(
      await applyAgentUpdateProgress(node, {
        updateId: id,
        phase: "refused",
        reason: "checksum_mismatch",
      }),
    ).toEqual({ applied: true, ended: true, settled: true });
    expect(raced).toBe(true);
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({
      phase: "REFUSED",
      reason: "checksum_mismatch",
    });
  });

  it("records each phase, and ignores frames about unknown or another node's updates", async () => {
    const id = await started();
    const node = { nodeId: "node-1", userId: OWNER };
    expect(await applyAgentUpdateProgress(node, { updateId: id, phase: "downloading" })).toEqual({
      applied: true,
      ended: false,
      settled: false,
    });
    // Nothing this node could ever store: acknowledged, so it stops reporting it.
    expect(
      await applyAgentUpdateProgress(node, { updateId: "x".repeat(21) + "A", phase: "failed" }),
    ).toEqual({ applied: false, ended: false, settled: true });
    expect(
      await applyAgentUpdateProgress(
        { nodeId: "node-2", userId: OWNER },
        { updateId: id, phase: "failed" },
      ),
    ).toEqual({ applied: false, ended: false, settled: true });
    expect(
      await applyAgentUpdateProgress(
        { nodeId: "node-1", userId: "someone-else" },
        { updateId: id, phase: "failed" },
      ),
    ).toEqual({ applied: false, ended: false, settled: true });
    expect(store.tables.nodeAgentUpdate[0]?.phase).toBe("DOWNLOADING");
    const done = await applyAgentUpdateProgress(node, {
      updateId: id,
      phase: "refused",
      reason: "busy",
      detail: "wsmp update --force",
    });
    expect(done).toEqual({ applied: true, ended: true, settled: true });
    // The same end again (the node did not get the ack): settled, nothing written.
    expect(
      await applyAgentUpdateProgress(node, { updateId: id, phase: "refused", reason: "busy" }),
    ).toEqual({ applied: false, ended: false, settled: true });
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({
      phase: "REFUSED",
      reason: "busy",
      detail: "wsmp update --force",
      deadlineAt: null,
    });
  });

  it("times an update out at its deadline; a later confirmed still lands", async () => {
    const id = await started();
    const node = { nodeId: "node-1", userId: OWNER };
    const t0 = new Date();
    await applyAgentUpdateProgress(node, { updateId: id, phase: "swapped" }, t0);
    // The default window (180 s) plus the restart slack (120 s).
    expect(await expireAgentUpdates(new Date(t0.getTime() + 290_000))).toBe(0);
    expect(await expireAgentUpdates(new Date(t0.getTime() + 301_000))).toBe(1);
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({
      phase: "TIMED_OUT",
      reason: "swapped",
    });
    // The binary after the restart reports on its next session.
    expect(await applyAgentUpdateProgress(node, { updateId: id, phase: "confirmed" })).toEqual({
      applied: true,
      ended: true,
      settled: true,
    });
  });
});

describe("Update all", () => {
  function batchOf(nodeIds: string[], targetDigest: string | null = null) {
    store.tables.nodeAgentUpdateBatch.push({
      id: "batch-1",
      userId: OWNER,
      canaryNodeId: nodeIds[0],
      nodeIds,
      state: "RUNNING",
      position: 0,
      currentNodeId: null,
      currentUpdateId: null,
      skippedNodeIds: [],
      targetVersion: "0.4.3",
      targetDigest,
      stoppedNodeId: null,
      stoppedReason: null,
      endedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  const batch = () => store.tables.nodeAgentUpdateBatch[0] as Record<string, unknown>;
  const report = (nodeId: string, phase: "confirmed" | "failed" | "rolled_back") => {
    const update = store.tables.nodeAgentUpdate.find(
      (row) => row.nodeId === nodeId && row.endedAt === null,
    );
    if (!update) throw new Error(`no update for ${nodeId}`);
    return applyAgentUpdateProgress(
      { nodeId, userId: OWNER },
      { updateId: update.id as string, phase },
    );
  };

  it("picks the least-used node as the canary", () => {
    expect(
      chooseCanary([
        { nodeId: "a", slug: "a", running: 2 },
        { nodeId: "c", slug: "c", running: 0 },
        { nodeId: "b", slug: "b", running: 0 },
      ]),
    ).toBe("b");
    expect(chooseCanary([])).toBeNull();
  });

  it("updates the canary first, then one at a time after each confirms", async () => {
    addNodes({ id: "n1", slug: "n1" }, { id: "n2", slug: "n2" }, { id: "n3", slug: "n3" });
    batchOf(["n1", "n2", "n3"]);
    const { port: p, sent } = port();
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1"]);
    // Nothing moves while the canary is in flight.
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent).toHaveLength(1);
    await report("n1", "confirmed");
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1", "n2"]);
    await report("n2", "confirmed");
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    await report("n3", "confirmed");
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1", "n2", "n3"]);
    expect(batch()).toMatchObject({ state: "DONE", skippedNodeIds: [] });
  });

  it("stops when the server offers another release than the canary validated", async () => {
    addNodes({ id: "n1", slug: "n1" }, { id: "n2", slug: "n2" }, { id: "n3", slug: "n3" });
    batchOf(["n1", "n2", "n3"]);
    const { port: p, sent } = port();
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    await report("n1", "confirmed");
    // A deploy during the run: the server now offers 0.4.4.
    const newer = port({
      release: async () => ({
        kind: "release",
        version: "0.4.4",
        commit: null,
        releaseUrl: "https://r.example/v0.4.4",
        artifacts: {
          [TARGET]: {
            url: `https://r.example/v0.4.4/wsmp-${TARGET}.tar.xz`,
            sha256: "b".repeat(64),
          },
        },
      }),
    });
    await advanceAgentUpdateBatch(newer.port, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1"]);
    expect(newer.sent).toEqual([]);
    expect(batch()).toMatchObject({ state: "STOPPED", stoppedReason: "release_changed" });
    expect(untouchedNodeIds(batch() as never)).toEqual(["n2", "n3"]);
  });

  it("stops when the same version is offered with other archives (another build)", async () => {
    addNodes({ id: "n1", slug: "n1" }, { id: "n2", slug: "n2" });
    const { port: p, sent } = port();
    batchOf(["n1", "n2"], agentUpdateReleaseDigest(await p.release()));
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1"]);
    await report("n1", "confirmed");
    const rebuilt = port({
      release: async () => ({
        kind: "release",
        version: "0.4.3",
        commit: null,
        releaseUrl: "https://r.example/v0.4.3",
        artifacts: {
          [TARGET]: {
            url: `https://r.example/v0.4.3/wsmp-${TARGET}.tar.xz`,
            sha256: "c".repeat(64),
          },
        },
      }),
    });
    await advanceAgentUpdateBatch(rebuilt.port, "batch-1", ORIGIN);
    expect(rebuilt.sent).toEqual([]);
    expect(batch()).toMatchObject({ state: "STOPPED", stoppedReason: "release_changed" });
  });

  it("stops at the first failure and leaves the rest untouched", async () => {
    addNodes({ id: "n1", slug: "n1" }, { id: "n2", slug: "n2" }, { id: "n3", slug: "n3" });
    batchOf(["n1", "n2", "n3"]);
    const { port: p, sent } = port();
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    await report("n1", "confirmed");
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    await report("n2", "rolled_back");
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1", "n2"]);
    expect(batch()).toMatchObject({
      state: "STOPPED",
      stoppedNodeId: "n2",
      stoppedReason: "rolled_back",
    });
    expect(untouchedNodeIds(batch() as never)).toEqual(["n3"]);
  });

  it("stops when the canary fails or times out: nothing else is touched", async () => {
    addNodes({ id: "n1", slug: "n1" }, { id: "n2", slug: "n2" });
    batchOf(["n1", "n2"]);
    const { port: p, sent } = port();
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    await expireAgentUpdates(new Date(Date.now() + 3_600_000));
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1"]);
    expect(batch()).toMatchObject({ state: "STOPPED", stoppedReason: "timed_out" });
    expect(untouchedNodeIds(batch() as never)).toEqual(["n2"]);
  });

  it("passes over a node that cannot update at its turn, and records it", async () => {
    addNodes(
      { id: "n1", slug: "n1" },
      { id: "n2", slug: "n2", agentUpdatePolicy: "OFF" },
      { id: "n3", slug: "n3", cliVersion: "0.4.3" },
      { id: "n4", slug: "n4" },
    );
    batchOf(["n1", "n2", "n3", "n4"]);
    const { port: p, sent } = port();
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    await report("n1", "confirmed");
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    // n2 turned off since the run started, n3 is already current: n4 is next.
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1", "n4"]);
    await report("n4", "confirmed");
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(batch()).toMatchObject({ state: "DONE", skippedNodeIds: ["n2"] });
    expect(untouchedNodeIds(batch() as never)).toEqual(["n2"]);
  });

  it("stops with refused when the canary cannot update", async () => {
    addNodes({ id: "n1", slug: "n1", agentUpdatePolicy: "OFF" }, { id: "n2", slug: "n2" });
    batchOf(["n1", "n2"]);
    const { port: p, sent } = port();
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent).toEqual([]);
    expect(batch()).toMatchObject({
      state: "STOPPED",
      stoppedReason: "refused",
      stoppedNodeId: "n1",
    });
  });

  it("resumes from the database (a restarted server picks up where it was)", async () => {
    addNodes({ id: "n1", slug: "n1" }, { id: "n2", slug: "n2" });
    batchOf(["n1", "n2"]);
    await advanceAgentUpdateBatch(port().port, "batch-1", ORIGIN);
    await report("n1", "confirmed");
    // A fresh port: nothing in memory carries over.
    const { port: p, sent } = port();
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n2"]);
  });
});
