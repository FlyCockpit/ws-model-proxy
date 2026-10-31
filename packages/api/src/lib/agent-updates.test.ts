import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentUpdateDb, nodeRow } from "./agent-update-test-fake";

const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@ws-model-proxy/db", () => ({
  get default() {
    return fake.db;
  },
}));

import {
  AGENT_UPDATE_ROLLBACK_SECS_DEFAULT,
  type AgentUpdateFrame,
  agentReleaseVersionSchema,
  compareReleaseVersions,
} from "./agent-update-wire";
import {
  type AgentUpdatePort,
  advanceAgentUpdateBatch,
  advanceAgentUpdateBatches,
  agentUpdateDeadline,
  agentUpdateEligibility,
  agentUpdateReleaseDigest,
  applyAgentUpdateProgress,
  chooseCanary,
  cleanAgentUpdateDetail,
  expireAgentUpdates,
  isOutdated,
  manualCommandFor,
  progressAllowed,
  startAgentUpdate,
  untouchedNodeIds,
} from "./agent-updates";
import { type NodeEvent, onNodeEvent } from "./node-events";

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
  // Stored on the connection the port's live sessions report (generation 3).
  store.tables.node.push(...rows.map((row) => nodeRow({ connectionGeneration: 3, ...row })));
}

beforeEach(() => {
  store = createAgentUpdateDb();
  fake.db = store.client;
});

describe("phases", () => {
  it("only moves forward, and lets the node's final word replace timed_out", () => {
    expect(progressAllowed("requested", "downloading")).toBe(true);
    expect(progressAllowed("verifying", "downloading")).toBe(false);
    // Busy again after the download: the node waits for idle once more.
    expect(progressAllowed("downloading", "waiting_idle")).toBe(true);
    expect(progressAllowed("verifying", "waiting_idle")).toBe(true);
    expect(progressAllowed("armed", "waiting_idle")).toBe(false);
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
    windowsUpdates: false,
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

  it("offers the update only on platforms it was verified on; Windows only when turned on", () => {
    const WINDOWS = "x86_64-pc-windows-msvc";
    const MAC = "aarch64-apple-darwin";
    const everywhere = {
      ...release,
      artifacts: {
        ...release.artifacts,
        [WINDOWS]: { url: "https://u/w", sha256: "b".repeat(64) },
        [MAC]: { url: "https://u/m", sha256: "c".repeat(64) },
      },
    };
    const on = (target: string, strategies: string[] = ["self-replace"], windowsUpdates = false) =>
      check(
        { cliBuild: { commit: null, installMethod: "script", target } },
        {
          live: { ...live, selfUpdate: { ...SELF_UPDATE, strategies } },
          release: everywhere,
          server: { ...server, windowsUpdates },
        },
      );
    expect(on(TARGET).canUpdate).toBe(true);
    expect(on(MAC).canUpdate).toBe(true);
    expect(on(WINDOWS)).toMatchObject({
      canUpdate: false,
      blockedReason: "agent_update_platform",
    });
    expect(on(WINDOWS).manualCommand).not.toBeNull();
    expect(on(WINDOWS, ["self-replace"], true).canUpdate).toBe(true);
    expect(on(MAC, ["homebrew"]).canUpdate).toBe(true);
    // Homebrew on Linux has not been verified.
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

  it("gives the recovery command for how the node is installed now, not how it last updated", () => {
    const BREW = "brew reinstall flycockpit/tap/wsmp && wsmp service restart";
    const SCRIPT = `curl -fsSL ${ORIGIN}/install.sh | sh && ~/.cargo/bin/wsmp service restart`;
    const failed = (strategy: string, phase: "failed" | "timed_out" = "failed") => ({
      phase,
      strategy,
      reason: "internal",
    });
    const homebrewNow = { commit: null, installMethod: "homebrew", target: TARGET };
    const scriptNow = { commit: null, installMethod: "script", target: TARGET };
    // A Homebrew update that did not confirm (no rollback) needs a hand repair: after a
    // reinstall with the script, the script's command, not Homebrew's.
    for (const phase of ["failed", "timed_out"] as const) {
      expect(
        check({ cliBuild: scriptNow }, { latest: failed("homebrew", phase) }).manualCommand,
      ).toBe(SCRIPT);
      expect(
        check({ cliBuild: homebrewNow }, { latest: failed("homebrew", phase) }).manualCommand,
      ).toBe(BREW);
    }
    // The reverse: a self-replace attempt, then reinstalled with Homebrew. A self-replace failure
    // rolls back by itself, so only a blocked update shows a command, and it is Homebrew's.
    expect(
      check({ cliBuild: homebrewNow }, { latest: failed("self-replace") }).manualCommand,
    ).toBeNull();
    expect(
      check({ cliBuild: homebrewNow }, { live: null, latest: failed("self-replace") })
        .manualCommand,
    ).toBe(BREW);
    expect(
      check({ cliBuild: scriptNow }, { live: null, latest: failed("homebrew") }).manualCommand,
    ).toBe(SCRIPT);
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
    expect(forced).toEqual({
      kind: "started",
      updateId: first.updateId,
      connectionGeneration: 3,
    });
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
    expect(store.tables.nodeAgentUpdate[0]?.force).toBe(true);
    expect(sent.map(({ frame }) => [frame.updateId, frame.force])).toEqual([
      [first.updateId, false],
      [first.updateId, true],
    ]);
  });
});

describe("versions", () => {
  // F-FB-2: the server accepts exactly the release versions the node reads (the CLI's
  // `is_release_version` checks the same vectors), so it never offers or sends one the node
  // cannot install.
  it("accepts exactly the release versions the node accepts", () => {
    const shared = JSON.parse(
      readFileSync(new URL("./agent-release-version-vectors.json", import.meta.url), "utf8"),
    ) as { vectors: Array<{ value: string; valid: boolean }> };
    expect(shared.vectors.length).toBeGreaterThan(30);
    expect(shared.vectors.some((vector) => vector.valid)).toBe(true);
    expect(shared.vectors.some((vector) => !vector.valid)).toBe(true);
    for (const { value, valid } of shared.vectors)
      expect(agentReleaseVersionSchema.safeParse(value).success, JSON.stringify(value)).toBe(valid);
  });

  // F-FB-1: the server orders every accepted version exactly as the node does (the CLI's
  // `compare_release` checks the same pairs), including an empty pre-release before `+`.
  it("orders release versions exactly as the node does", () => {
    const shared = JSON.parse(
      readFileSync(new URL("./agent-release-version-vectors.json", import.meta.url), "utf8"),
    ) as { comparisons: Array<[string, string, number]> };
    expect(shared.comparisons.length).toBeGreaterThan(1000);
    for (const [a, b, order] of shared.comparisons)
      expect(compareReleaseVersions(a, b), `${a} vs ${b}`).toBe(order);
    expect(compareReleaseVersions("1.2.3-+foo", "1.2.3")).toBe(-1);
    expect(compareReleaseVersions("1.2.3", "1.2.3-+foo")).toBe(1);
  });

  it("orders release versions by SemVer precedence", () => {
    expect(compareReleaseVersions("0.4.4", "0.4.3")).toBe(1);
    expect(compareReleaseVersions("0.4.3", "0.4.10")).toBe(-1);
    expect(compareReleaseVersions("0.4.3", "0.4.3")).toBe(0);
    expect(compareReleaseVersions("0.4.4-rc.1", "0.4.4")).toBe(-1);
    expect(compareReleaseVersions("0.4.4-rc.2", "0.4.4-rc.10")).toBe(-1);
    expect(compareReleaseVersions("0.4.4-beta.1", "0.4.4-alpha.9")).toBe(1);
    expect(compareReleaseVersions("0.4.4-rc.1", "0.4.3")).toBe(1);
    expect(compareReleaseVersions("0.4.3+abc", "0.4.3")).toBe(0);
    expect(compareReleaseVersions("latest", "0.4.3")).toBeNull();
    // Numerically equal identifiers spelled differently: the next ones decide, as on the node.
    expect(compareReleaseVersions("1.0.0-01.a", "1.0.0-1.b")).toBe(-1);
    expect(compareReleaseVersions("1.0.0-1.b", "1.0.0-01.a")).toBe(1);
    expect(compareReleaseVersions("1.0.0-01.a", "1.0.0-1.a")).toBe(0);
    expect(compareReleaseVersions("1.0.0-01", "1.0.0-1.a")).toBe(-1);
    // Past 2^53 a double rounds both to the same number.
    expect(compareReleaseVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
    expect(compareReleaseVersions("0.0.9007199254740992", "0.0.9007199254740993")).toBe(-1);
    expect(compareReleaseVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(1);
  });

  it("does not call a node newer than the server outdated", () => {
    const server = { version: "0.4.3", commit: null };
    expect(isOutdated("0.4.4", null, server)).toBe(false);
    expect(isOutdated("0.4.2", null, server)).toBe(true);
    expect(isOutdated("0.4.3-rc.1", null, server)).toBe(true);
    expect(isOutdated(null, null, server)).toBe(true);
    expect(isOutdated("garbage", null, server)).toBe(true);
  });
});

describe("Homebrew: Install anyway and forced resends", () => {
  const MAC = "aarch64-apple-darwin";
  const HOMEBREW = {
    strategies: ["homebrew"],
    instancesSurvive: false,
    remote: "allowed" as const,
  };
  const macRelease = (sha256 = "c".repeat(64)) => ({
    kind: "release" as const,
    version: "0.4.3",
    commit: null,
    releaseUrl: "https://r.example/v0.4.3",
    artifacts: { [MAC]: { url: `https://r.example/v0.4.3/wsmp-${MAC}.tar.xz`, sha256 } },
  });
  function homebrewPort(selfUpdate: Record<string, unknown> = HOMEBREW, sha256?: string) {
    let release = macRelease(sha256);
    const made = port({
      release: async () => release,
      liveNode: (nodeId) =>
        store.tables.node.some((node) => node.id === nodeId && node.connection === "ONLINE")
          ? {
              userId: OWNER,
              connectionGeneration: 3,
              trust: "full",
              selfUpdate: selfUpdate as never,
            }
          : null,
    });
    return { ...made, rebuild: (sha: string) => (release = macRelease(sha)) };
  }
  const macNode = (overrides: Record<string, unknown> = {}) =>
    addNodes({
      cliBuild: { commit: null, installMethod: "homebrew", target: MAC },
      features: { selfUpdate: HOMEBREW },
      ...overrides,
    });
  const start = (p: AgentUpdatePort, extra: Partial<Parameters<typeof startAgentUpdate>[1]> = {}) =>
    startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force: false,
      origin: ORIGIN,
      ...extra,
    });
  // The reports arrive on the live session (generation 3), which an offer is bound to.
  const node = { nodeId: "node-1", userId: OWNER, connectionGeneration: 3 };
  /**
   * The node refused the server's version: its tap has `available`. `null`: the refusal came
   * without `availableVersion` (an older wsmp, or a server that did not advertise it).
   */
  async function refusedForTap(p: AgentUpdatePort, available: string | null = "0.4.4") {
    const first = await start(p);
    if (first.kind !== "started") throw new Error("not started");
    await applyAgentUpdateProgress(node, {
      updateId: first.updateId,
      phase: "refused",
      reason: "version_mismatch",
      detail: `the Homebrew tap has wsmp ${available ?? "0.4.4"}, not 0.4.3`,
      ...(available !== null ? { availableVersion: available } : {}),
    });
    return first.updateId;
  }
  const eligibilityNow = async (p: AgentUpdatePort) => {
    const row = store.tables.node[0] as never;
    const latest = [...store.tables.nodeAgentUpdate].sort(
      (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
    )[0];
    return agentUpdateEligibility({
      row,
      live: p.liveNode("node-1"),
      release: await p.release(),
      server: await p.server(),
      origin: ORIGIN,
      active: null,
      latest: latest
        ? {
            phase: String(latest.phase).toLowerCase() as never,
            strategy: latest.strategy as string,
            reason: latest.reason as string | null,
            fromVersion: latest.fromVersion as string | null,
            fromCommit: (latest.fromCommit as string | null) ?? null,
            availableVersion: (latest.availableVersion as string | null) ?? null,
            availableGeneration: (latest.availableGeneration as number | null) ?? null,
          }
        : null,
    });
  };

  /** Runs `between` right before the next transaction's work (after the reads before it). */
  const beforeNextTransaction = (between: () => void) => {
    const base = store.client;
    fake.db = {
      ...base,
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        fake.db = base;
        between();
        return base.$transaction(work);
      },
    };
  };

  it("rechecks the Install-anyway approval under the lock: a newer refusal offers another version (F-FA-1)", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    const refusedId = await refusedForTap(p);
    sent.length = 0;
    // After the eligibility read, before the claim: the node's latest answer now offers 0.4.5.
    beforeNextTransaction(() => {
      Object.assign(store.tables.nodeAgentUpdate.find((row) => row.id === refusedId) ?? {}, {
        availableVersion: "0.4.5",
      });
    });
    expect(await start(p, { version: "0.4.4" })).toMatchObject({
      kind: "refused",
      reason: "agent_update_unavailable",
    });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
  });

  it("refuses Install anyway after a hello stored the next connection, while the session map still holds the one the offer came on (F-FA-1)", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p);
    sent.length = 0;
    // The successor hello committed generation 4; this process still serves generation 3.
    beforeNextTransaction(() => {
      Object.assign(store.tables.node[0] ?? {}, { connectionGeneration: 4 });
    });
    expect(await start(p, { version: "0.4.4" })).toMatchObject({
      kind: "refused",
      reason: "node_offline",
    });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
  });

  it("stores the tap's version from a refusal, offers it, and installs it end to end", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    const refusedId = await refusedForTap(p);
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({
      id: refusedId,
      phase: "REFUSED",
      reason: "version_mismatch",
      availableVersion: "0.4.4",
      availableGeneration: 3,
      artifactSha256: "c".repeat(64),
    });
    expect(await eligibilityNow(p)).toMatchObject({
      canUpdate: true,
      availableVersion: "0.4.4",
    });

    const anyway = await start(p, { version: "0.4.4" });
    if (anyway.kind !== "started") throw new Error(`not started: ${JSON.stringify(anyway)}`);
    expect(sent.map(({ frame }) => frame.version)).toEqual(["0.4.3", "0.4.4"]);
    expect(sent[1]?.frame).toMatchObject({ updateId: anyway.updateId, sha256: "c".repeat(64) });
    expect(store.tables.nodeAgentUpdate.find((row) => row.id === anyway.updateId)).toMatchObject({
      toVersion: "0.4.4",
      fromVersion: "0.4.2",
      strategy: "homebrew",
    });

    // The node restarts into 0.4.4 and confirms: newer than the server, not outdated, nothing
    // more to offer (Update all passes it as current).
    await applyAgentUpdateProgress(node, { updateId: anyway.updateId, phase: "downloading" });
    await applyAgentUpdateProgress(node, { updateId: anyway.updateId, phase: "restarting" });
    await applyAgentUpdateProgress(node, { updateId: anyway.updateId, phase: "confirmed" });
    (store.tables.node[0] as Record<string, unknown>).cliVersion = "0.4.4";
    expect(await eligibilityNow(p)).toMatchObject({
      outdated: false,
      newerThanServer: true,
      canUpdate: false,
      blockedReason: "agent_update_current",
      availableVersion: null,
    });
  });

  it("offers nothing after a refusal without availableVersion, and refuses its start", async () => {
    // An older wsmp (which would `brew upgrade` blindly) never sends it, and a capable one
    // sends it only to a server that advertised it: no proof, no offer.
    macNode();
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p, null);
    expect(store.tables.nodeAgentUpdate[0]?.availableVersion ?? null).toBeNull();
    expect((await eligibilityNow(p)).availableVersion).toBeNull();
    expect(await start(p, { version: "0.4.4" })).toMatchObject({
      kind: "refused",
      reason: "agent_update_unavailable",
    });
    expect(sent).toHaveLength(1);
    expect(store.tables.nodeAgentUpdate).toHaveLength(1);
  });

  it("installs only the exact version the node offered, for the wsmp it still runs", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p);
    expect(await start(p, { version: "0.4.5" })).toMatchObject({
      kind: "refused",
      reason: "agent_update_unavailable",
    });
    // The node was upgraded by hand since: that refusal was about another wsmp.
    (store.tables.node[0] as Record<string, unknown>).cliVersion = "0.4.2-rc.1";
    expect((await eligibilityNow(p)).availableVersion).toBeNull();
    expect(await start(p, { version: "0.4.4" })).toMatchObject({ kind: "refused" });
    expect(sent).toHaveLength(1);
  });

  it("offers nothing once the node runs another build of that version", async () => {
    macNode({
      cliBuild: { commit: "1".repeat(40), installMethod: "homebrew", target: MAC },
    });
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p);
    expect((await eligibilityNow(p)).availableVersion).toBe("0.4.4");
    // Reinstalled since from another commit (same version string): the refusal proved nothing
    // about it.
    (store.tables.node[0] as Record<string, unknown>).cliBuild = {
      commit: "2".repeat(40),
      installMethod: "homebrew",
      target: MAC,
    };
    expect((await eligibilityNow(p)).availableVersion).toBeNull();
    expect(await start(p, { version: "0.4.4" })).toMatchObject({ kind: "refused" });
    expect(sent).toHaveLength(1);
  });

  it("never offers an older tap version than the node runs", async () => {
    macNode({ cliVersion: "0.4.2" });
    const { port: p } = homebrewPort();
    await refusedForTap(p, "0.4.1");
    expect((await eligibilityNow(p)).availableVersion).toBeNull();
  });

  it("keeps availableVersion only with a version_mismatch refusal", async () => {
    macNode();
    const { port: p } = homebrewPort();
    const first = await start(p);
    if (first.kind !== "started") throw new Error("not started");
    await applyAgentUpdateProgress(node, {
      updateId: first.updateId,
      phase: "failed",
      reason: "internal",
      availableVersion: "0.4.4",
    });
    expect(store.tables.nodeAgentUpdate[0]?.availableVersion ?? null).toBeNull();
  });

  it("never installs anyway in Update all", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p);
    expect(
      await start(p, { version: "0.4.4", batch: { id: "batch-1", position: 0 } }),
    ).toMatchObject({ kind: "refused", reason: "agent_update_unavailable" });
    // The batch driver sends the server's own version, whatever the node offered.
    store.tables.nodeAgentUpdateBatch.push({
      id: "batch-1",
      userId: OWNER,
      canaryNodeId: "node-1",
      nodeIds: ["node-1"],
      state: "RUNNING",
      position: 0,
      currentNodeId: null,
      currentUpdateId: null,
      skippedNodeIds: [],
      targetVersion: "0.4.3",
      targetDigest: null,
      stoppedNodeId: null,
      stoppedReason: null,
      endedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN);
    expect(sent.map(({ frame }) => frame.version)).toEqual(["0.4.3", "0.4.3"]);
  });

  it("forces a waiting update only with the archive it was sent (D4)", async () => {
    macNode();
    const { port: p, sent, rebuild } = homebrewPort();
    const first = await start(p);
    if (first.kind !== "started") throw new Error("not started");
    await applyAgentUpdateProgress(node, { updateId: first.updateId, phase: "waiting_idle" });
    // The same version, built again (a redeploy): not what was asked for.
    rebuild("d".repeat(64));
    expect(await start(p, { force: true })).toMatchObject({
      kind: "refused",
      reason: "agent_update_unavailable",
    });
    expect(store.tables.nodeAgentUpdate[0]?.force).toBe(false);
    expect(sent).toHaveLength(1);
    // Back to the archive it was sent: the forced resend goes out.
    rebuild("c".repeat(64));
    expect(await start(p, { force: true })).toEqual({
      kind: "started",
      updateId: first.updateId,
      connectionGeneration: 3,
    });
    expect(sent.map(({ frame }) => [frame.version, frame.force])).toEqual([
      ["0.4.3", false],
      ["0.4.3", true],
    ]);
  });

  it("never resends a waiting update stored without its archive checksum", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    store.tables.nodeAgentUpdate.push({
      id: "q8Zr0T3vX1yB2nC4dE5fGw",
      userId: OWNER,
      nodeId: "node-1",
      batchId: null,
      fromVersion: "0.4.2",
      fromCommit: null,
      toVersion: "0.4.3",
      strategy: "homebrew",
      force: false,
      rollbackAfterSecs: AGENT_UPDATE_ROLLBACK_SECS_DEFAULT,
      phase: "WAITING_IDLE",
      reason: null,
      detail: null,
      artifactSha256: null,
      availableVersion: null,
      deadlineAt: new Date(Date.now() + 60_000),
      endedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await start(p, { force: true })).toMatchObject({
      kind: "refused",
      reason: "agent_update_unavailable",
    });
    expect(sent).toEqual([]);
  });

  it("forces a waiting Install anyway update with the version the owner chose", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p);
    const anyway = await start(p, { version: "0.4.4" });
    if (anyway.kind !== "started") throw new Error("not started");
    await applyAgentUpdateProgress(node, { updateId: anyway.updateId, phase: "waiting_idle" });
    expect(await start(p, { force: true })).toEqual({
      kind: "started",
      updateId: anyway.updateId,
      connectionGeneration: 3,
    });
    expect(sent.at(-1)?.frame).toMatchObject({ version: "0.4.4", force: true });
  });

  it("does not resend an Install anyway update after a reconnect when no build commit is known", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p);
    const anyway = await start(p, { version: "0.4.4" });
    if (anyway.kind !== "started") throw new Error("not started");
    expect(store.tables.nodeAgentUpdate.find((row) => row.id === anyway.updateId)).toMatchObject({
      availableGeneration: 3,
    });
    await applyAgentUpdateProgress(node, { updateId: anyway.updateId, phase: "waiting_idle" });
    // The node reconnected (generation 4) with the same version and still no commit: it may be
    // another wsmp, so the tap's version is not resent.
    const live = p.liveNode;
    p.liveNode = (id) => {
      const session = live(id);
      return session ? { ...session, connectionGeneration: 4 } : null;
    };
    expect(await start(p, { force: true })).toMatchObject({
      kind: "refused",
      reason: "agent_update_unavailable",
    });
    expect(store.tables.nodeAgentUpdate.find((row) => row.id === anyway.updateId)?.force).toBe(
      false,
    );
    expect(sent.map(({ frame }) => frame.version)).toEqual(["0.4.3", "0.4.4"]);
  });

  it("does not resend an Install anyway update once another wsmp runs", async () => {
    macNode();
    const { port: p, sent } = homebrewPort();
    await refusedForTap(p);
    const anyway = await start(p, { version: "0.4.4" });
    if (anyway.kind !== "started") throw new Error("not started");
    await applyAgentUpdateProgress(node, { updateId: anyway.updateId, phase: "waiting_idle" });
    // The node was reinstalled by hand meanwhile (another wsmp, unknown capability).
    (store.tables.node[0] as Record<string, unknown>).cliVersion = "0.4.1";
    expect(await start(p, { force: true })).toMatchObject({
      kind: "refused",
      reason: "agent_update_unavailable",
    });
    expect(sent.map(({ frame }) => frame.version)).toEqual(["0.4.3", "0.4.4"]);
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

  it("tells the owner's open tabs about a start, each stored report and a timeout (#255)", async () => {
    const events: NodeEvent[] = [];
    const unsubscribe = onNodeEvent((event) => events.push(event));
    const id = await started();
    const node = { nodeId: "node-1", userId: OWNER };
    const t0 = new Date();
    await applyAgentUpdateProgress(node, { updateId: id, phase: "swapped" }, t0);
    // Not stored (another node's update): nothing to tell.
    await applyAgentUpdateProgress(
      { nodeId: "node-2", userId: OWNER },
      { updateId: id, phase: "failed" },
    );
    await expireAgentUpdates(new Date(t0.getTime() + 301_000));
    unsubscribe();
    expect(events).toEqual([
      { type: "node.agentUpdate", userId: OWNER, nodeId: "node-1" },
      { type: "node.agentUpdate", userId: OWNER, nodeId: "node-1" },
      { type: "node.agentUpdate", userId: OWNER, nodeId: "node-1" },
    ]);
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

  // F-FB-7: the node's progress as the Homebrew worker sends it
  // (`a_homebrew_update_reports_downloading_when_idle_before_it_waits_for_the_lock`): the tap
  // refresh, a wait for idle of 29 minutes, `downloading` once idle, a 4-minute wait for
  // Homebrew's lock, `downloading` again under it, then the upgrade and the restart. Through the
  // server's tick (expiry first, then the batch driver, as `relay/agent-updates.ts` runs them).
  it.each([
    ["reports downloading once idle (the node's sequence)", true],
    ["stays waiting_idle until the lock (the sequence before the fix)", false],
  ])("a Homebrew step that waits for idle, then for the lock, %s", async (_label, idleReport) => {
    addNodes({ id: "n1", slug: "n1" }, { id: "n2", slug: "n2" });
    batchOf(["n1", "n2"]);
    const { port: p, sent } = port();
    const t0 = new Date(Date.UTC(2026, 9, 31, 8, 0, 0));
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    const tick = async (now: Date) => {
      await expireAgentUpdates(now);
      await advanceAgentUpdateBatches(p, ORIGIN, now);
    };
    await advanceAgentUpdateBatch(p, "batch-1", ORIGIN, t0);
    const id = sent[0]?.frame.updateId as string;
    const node = { nodeId: "n1", userId: OWNER, connectionGeneration: 3 };
    const progress = (
      phase: "downloading" | "waiting_idle" | "restarting" | "confirmed",
      m: number,
    ) => applyAgentUpdateProgress(node, { updateId: id, phase }, at(m));
    await progress("downloading", 0.01);
    await progress("waiting_idle", 0.02);
    if (idleReport) await progress("downloading", 29);
    await tick(at(32));
    const row = () => store.tables.nodeAgentUpdate.find((update) => update.id === id);
    if (!idleReport) {
      // What the reviewer replayed: the idle window ran out while the node waited for the lock.
      expect(row()?.phase).toBe("TIMED_OUT");
      expect(batch()).toMatchObject({ state: "STOPPED", stoppedReason: "timed_out" });
      return;
    }
    expect(row()?.phase).toBe("DOWNLOADING");
    expect(batch()).toMatchObject({ state: "RUNNING", currentUpdateId: id });
    await progress("downloading", 33);
    await tick(at(40));
    expect(row()?.phase).toBe("DOWNLOADING");
    await progress("restarting", 41);
    await progress("confirmed", 42);
    await tick(at(42.5));
    expect(row()?.phase).toBe("CONFIRMED");
    expect(sent.map(({ nodeId }) => nodeId)).toEqual(["n1", "n2"]);
    expect(batch()).toMatchObject({ state: "RUNNING", position: 1 });
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

describe("a send stays bound to the stored connection and to its live claim (F-FA-1, F-FA-2)", () => {
  /** Runs `after` once, right after the next transaction committed (the claim's). */
  function afterNextCommit(after: () => Promise<void> | void) {
    const base = store.client;
    fake.db = {
      ...base,
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        const result = await base.$transaction(work);
        fake.db = base;
        await after();
        return result;
      },
    };
  }
  const start = (p: AgentUpdatePort, force = false) =>
    startAgentUpdate(p, {
      userId: OWNER,
      nodeId: "node-1",
      force,
      origin: ORIGIN,
      now: new Date(0),
    });

  beforeEach(() => addNodes({}));

  it("allowed control: sends when nothing changed between the claim and the send", async () => {
    const { port: p, sent } = port();
    afterNextCommit(() => undefined);
    expect(await start(p)).toMatchObject({ kind: "started", connectionGeneration: 3 });
    expect(sent).toHaveLength(1);
  });

  it("P3a: a claim that expired before the send is not sent", async () => {
    const { port: p, sent } = port();
    afterNextCommit(async () => {
      expect(await expireAgentUpdates(new Date(120_001))).toBe(1);
    });
    expect(await start(p)).toMatchObject({ kind: "refused", reason: "agent_update_in_progress" });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({ phase: "TIMED_OUT" });
  });

  it("P3b: a forced resend of an update the node ended meanwhile is not sent", async () => {
    const { port: p, sent } = port();
    const first = await start(p);
    if (first.kind !== "started") throw new Error("not started");
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    sent.length = 0;
    afterNextCommit(async () => {
      expect(
        await applyAgentUpdateProgress(
          { nodeId: "node-1", userId: OWNER },
          { updateId: first.updateId, phase: "refused", reason: "busy" },
        ),
      ).toMatchObject({ applied: true, ended: true });
    });
    expect(await start(p, true)).toMatchObject({
      kind: "refused",
      reason: "agent_update_in_progress",
    });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({ phase: "REFUSED" });
  });

  it("a forced resend of an update that left the idle wait meanwhile is not sent", async () => {
    const { port: p, sent } = port();
    const first = await start(p);
    if (first.kind !== "started") throw new Error("not started");
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    sent.length = 0;
    afterNextCommit(async () => {
      await applyAgentUpdateProgress(
        { nodeId: "node-1", userId: OWNER },
        { updateId: first.updateId, phase: "downloading" },
      );
    });
    expect(await start(p, true)).toMatchObject({ kind: "refused" });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate[0]).toMatchObject({ phase: "DOWNLOADING", endedAt: null });
  });

  it("allowed control: a forced resend of an update still waiting for idle is sent", async () => {
    const { port: p, sent } = port();
    await start(p);
    Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, { phase: "WAITING_IDLE" });
    sent.length = 0;
    afterNextCommit(() => undefined);
    expect(await start(p, true)).toMatchObject({ kind: "started" });
    expect(sent.map(({ frame }) => frame.force)).toEqual([true]);
  });

  it("P3c: refuses a target whose stored generation is not the session's, though the map still holds it", async () => {
    Object.assign(store.tables.node[0] ?? {}, { connectionGeneration: 4 });
    const { port: p, sent } = port();
    expect(await start(p)).toMatchObject({ kind: "refused", reason: "node_offline" });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate).toEqual([]);
  });

  it("refuses the send when a successor hello committed between the claim and the send", async () => {
    const { port: p, sent } = port();
    afterNextCommit(() => {
      Object.assign(store.tables.node[0] ?? {}, { connectionGeneration: 4 });
    });
    expect(await start(p)).toMatchObject({ kind: "refused", reason: "node_offline" });
    expect(sent).toEqual([]);
    // Nothing reached the node: the claim went.
    expect(store.tables.nodeAgentUpdate).toEqual([]);
  });

  it("refuses the send when the disconnect committed OFFLINE before the session map dropped it", async () => {
    const { port: p, sent } = port({
      liveNode: () => ({
        userId: OWNER,
        connectionGeneration: 3,
        trust: "full",
        selfUpdate: SELF_UPDATE,
      }),
    });
    afterNextCommit(() => {
      Object.assign(store.tables.node[0] ?? {}, { connection: "OFFLINE" });
    });
    expect(await start(p)).toMatchObject({ kind: "refused", reason: "node_offline" });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate).toEqual([]);
  });

  it("P3d (control): browser updates turned off after the claim refuse the send and undo the claim", async () => {
    const { port: p, sent } = port();
    afterNextCommit(() => {
      Object.assign(store.tables.node[0] ?? {}, { agentUpdatePolicy: "OFF" });
    });
    expect(await start(p)).toMatchObject({ kind: "refused", reason: "agent_update_off" });
    expect(sent).toEqual([]);
    expect(store.tables.nodeAgentUpdate).toEqual([]);
  });
});
