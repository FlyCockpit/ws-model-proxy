import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com", NODE_ENV: "test", WMP_RATE_LIMIT_SCALE: 1 },
}));
vi.mock("@ws-model-proxy/api/nodes/enroll-exchange", () => ({
  exchangeEnrollmentCode: vi.fn(),
  findEnrollmentCodeOwner: vi.fn(),
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
const lib = vi.hoisted(() => ({
  applyAgentUpdateProgress: vi.fn(async () => ({ applied: true, ended: false, settled: false })),
  expireAgentUpdates: vi.fn(async () => 0),
  advanceAgentUpdateBatches: vi.fn(async () => undefined),
  pruneAgentUpdates: vi.fn(async () => undefined),
}));
vi.mock("@ws-model-proxy/api/lib/agent-updates", () => lib);

import type { CliReleaseManifest } from "../node-http.js";
import { createAgentUpdates } from "./agent-updates.js";

const MANIFEST: CliReleaseManifest = {
  version: "0.4.2",
  commit: null,
  releaseUrl: "https://r.example",
  sourceBuild: false,
  artifacts: { t: { url: "https://r.example/a", sha256: "a".repeat(64) } },
};

function relay() {
  return {
    sendToNode: vi.fn(() => true),
    nodeSession: vi.fn(() => ({
      userId: "owner-1",
      connectionGeneration: 7,
      trust: "full" as const,
      selfUpdate: {
        strategies: ["self-replace"],
        instancesSurvive: true,
        remote: "allowed" as const,
      },
    })),
  };
}

const node = {
  nodeId: "node-1",
  userId: "owner-1",
  slug: "box",
  connectionGeneration: 7,
  trust: "full" as const,
};

beforeEach(() => {
  for (const fn of Object.values(lib)) fn.mockClear();
});

describe("the self-update relay port", () => {
  it("sends agent.update only to the planned, Full-control session of the owner", () => {
    const r = relay();
    const updates = createAgentUpdates(r, { manifest: { get: async () => MANIFEST } });
    const frame = {
      type: "agent.update" as const,
      updateId: "AAAAAAAAAAAAAAAAAAAAAA",
      version: "0.4.2",
      artifactUrl: "https://r.example/a",
      sha256: "a".repeat(64),
      signature: null,
      force: false,
      rollbackAfterSecs: 90,
    };
    updates.port.send("node-1", frame, { connectionGeneration: 7, userId: "owner-1" });
    expect(r.sendToNode).toHaveBeenCalledWith("node-1", frame, {
      connectionGeneration: 7,
      requireFullTrust: true,
      userId: "owner-1",
    });
    expect(updates.port.liveNode("node-1")).toMatchObject({
      trust: "full",
      connectionGeneration: 7,
    });
  });

  it("sends no agent.update to a session that opted out, has no self-update, or reconnected", () => {
    const frame = {
      type: "agent.update" as const,
      updateId: "AAAAAAAAAAAAAAAAAAAAAA",
      version: "0.4.2",
      artifactUrl: "https://r.example/a",
      sha256: "a".repeat(64),
      signature: null,
      force: true,
      rollbackAfterSecs: 90,
    };
    const live = relay().nodeSession();
    for (const session of [
      { ...live, selfUpdate: { ...live.selfUpdate, remote: "off" as const } },
      { ...live, selfUpdate: null },
      { ...live, connectionGeneration: 8 },
      null,
    ]) {
      const r = relay();
      r.nodeSession.mockReturnValue(session as never);
      const updates = createAgentUpdates(r, { manifest: { get: async () => MANIFEST } });
      expect(
        updates.port.send("node-1", frame, { connectionGeneration: 7, userId: "owner-1" }),
      ).toBe(false);
      expect(r.sendToNode).not.toHaveBeenCalled();
    }
    // The inverse: remote allowed on the same connection goes out.
    const r = relay();
    const updates = createAgentUpdates(r, { manifest: { get: async () => MANIFEST } });
    expect(updates.port.send("node-1", frame, { connectionGeneration: 7, userId: "owner-1" })).toBe(
      true,
    );
    expect(r.sendToNode).toHaveBeenCalledTimes(1);
  });

  it("offers nothing when the manifest cannot be read (fail closed)", async () => {
    const updates = createAgentUpdates(relay(), {
      manifest: {
        get: async () => {
          throw new Error("no sha256.sum");
        },
      },
      source: () => ({ kind: "release", baseUrl: "https://r.example" }),
    });
    expect(await updates.port.release()).toMatchObject({ kind: "unavailable" });
    expect(await updates.port.server()).toMatchObject({ sourceBuild: false, commit: null });
  });

  it("reports a source-build server with its commit and cargo command", async () => {
    const rev = "0123456789abcdef0123456789abcdef01234567";
    const updates = createAgentUpdates(relay(), {
      manifest: {
        get: async () => ({ ...MANIFEST, sourceBuild: true, commit: rev, artifacts: {} }),
      },
      source: () => ({ kind: "source", rev }),
    });
    expect(await updates.port.release()).toEqual({ kind: "source", version: "0.4.2", commit: rev });
    expect(await updates.port.server()).toMatchObject({
      sourceBuild: true,
      commit: rev,
      cargoInstall: expect.stringContaining(`--rev ${rev}`),
    });
  });

  it("applies progress for the reporting session's node and owner, and moves batches on an end", async () => {
    const updates = createAgentUpdates(relay(), { manifest: { get: async () => MANIFEST } });
    const frame = {
      type: "agent.update.progress" as const,
      updateId: "AAAAAAAAAAAAAAAAAAAAAA",
      phase: "confirmed" as const,
    };
    lib.applyAgentUpdateProgress.mockResolvedValueOnce({
      applied: true,
      ended: true,
      settled: true,
    });
    await updates.handlers["agent.update.progress"]?.(node, frame);
    // With the session's connection: an offer it carries is bound to it (Install anyway).
    expect(lib.applyAgentUpdateProgress).toHaveBeenCalledWith(
      { nodeId: "node-1", userId: "owner-1", connectionGeneration: 7 },
      frame,
    );
    await updates.tick();
    expect(lib.expireAgentUpdates).toHaveBeenCalled();
    expect(lib.advanceAgentUpdateBatches).toHaveBeenCalled();
  });

  it("acknowledges an end once it is stored, and only then", async () => {
    const r = relay();
    const updates = createAgentUpdates(r, { manifest: { get: async () => MANIFEST } });
    const frame = {
      type: "agent.update.progress" as const,
      updateId: "AAAAAAAAAAAAAAAAAAAAAA",
      phase: "confirmed" as const,
    };
    lib.applyAgentUpdateProgress.mockResolvedValueOnce({
      applied: true,
      ended: true,
      settled: true,
    });
    await updates.handlers["agent.update.progress"]?.(node, frame);
    expect(r.sendToNode).toHaveBeenCalledWith(
      "node-1",
      { type: "agent.update.ack", updateId: frame.updateId },
      { connectionGeneration: node.connectionGeneration, userId: node.userId },
    );
    // Not stored (a write that kept losing): no ack, so the node reports it again.
    r.sendToNode.mockClear();
    lib.applyAgentUpdateProgress.mockResolvedValueOnce({
      applied: false,
      ended: false,
      settled: false,
    });
    await updates.handlers["agent.update.progress"]?.(node, frame);
    // A phase before the end is never acknowledged.
    lib.applyAgentUpdateProgress.mockResolvedValueOnce({
      applied: true,
      ended: false,
      settled: false,
    });
    await updates.handlers["agent.update.progress"]?.(node, { ...frame, phase: "downloading" });
    expect(r.sendToNode).not.toHaveBeenCalled();
  });

  it("ticks deadlines before batches, and never runs two passes at once", async () => {
    const updates = createAgentUpdates(relay(), { manifest: { get: async () => MANIFEST } });
    const order: string[] = [];
    lib.expireAgentUpdates.mockImplementation(async () => {
      order.push("expire");
      return 0;
    });
    lib.advanceAgentUpdateBatches.mockImplementation(async () => {
      order.push("batches");
    });
    await Promise.all([updates.tick(), updates.tick()]);
    // The second call joined the first and asked for one more pass.
    expect(order).toEqual(["expire", "batches", "expire", "batches"]);
  });
});
