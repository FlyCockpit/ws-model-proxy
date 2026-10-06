import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  node: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  runtime: { findFirst: vi.fn() },
  runtimeVersion: { findMany: vi.fn() },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));

const { buildCompleteOperation, capDesired, createRuntimeSync } = await import("./runtime-sync.js");
const { CHUNK_BUDGET_BYTES, runtimeDefineFrameSchema } = await import("./frames.js");
const { runtimeLaunchHash } = await import("@ws-model-proxy/api/lib/runtime-launch-hash");
const { runtimeSpecSchema } = await import("@ws-model-proxy/api/lib/runtime-spec");

import type { DefinitionEnvelope, ServerToNodeControlFrame } from "./frames.js";
import type { NodeSessionRef } from "./session-manager.js";

function serviceSpec(name: string, padding = 0) {
  const unit = `ws-${name}${"x".repeat(padding)}`;
  return runtimeSpecSchema.parse({
    launch: {
      management: "service",
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 8 }],
      labels: [],
      commands: [
        {
          start: `systemctl --user start ${unit}`,
          stop: `systemctl --user stop ${unit}`,
          status: `systemctl --user is-active ${unit}`,
        },
      ],
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
    },
  });
}

function envelope(n: number, padding = 0): DefinitionEnvelope {
  return {
    runtimeId: `rt${n}`,
    versionId: `v${n}`,
    launchHash: "a".repeat(64),
    kind: "startable",
    slug: `rt-${n}`,
    spec: serviceSpec(`s${n}`, padding),
  };
}

const NODE_PART = {
  portRange: [30000, 30999] as [number, number],
  metricCommands: { hash: "b".repeat(64), commands: [] },
  fabrics: { hash: "c".repeat(64), sets: [] },
  commandMaxMs: 86_400_000,
};

describe("buildCompleteOperation", () => {
  it("keeps what the node holds with the same launch hash and puts the rest", () => {
    const desired = [envelope(1), envelope(2)];
    const frames = buildCompleteOperation({
      opId: "op",
      desired,
      held: [
        { runtimeId: "rt1", versionId: "v1", launchHash: "a".repeat(64) },
        { runtimeId: "rt2", versionId: "v2", launchHash: "f".repeat(64) },
      ],
      node: NODE_PART,
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      complete: true,
      final: true,
      keep: ["v1"],
      node: NODE_PART,
    });
    expect(frames[0]?.put?.map((entry) => entry.versionId)).toEqual(["v2"]);
  });

  it("splits by version count and bytes, node part on the first chunk only", () => {
    const desired = Array.from({ length: 100 }, (_, n) => envelope(n, 1500));
    const frames = buildCompleteOperation({ opId: "op", desired, held: [], node: NODE_PART });
    expect(frames.length).toBeGreaterThan(2);
    frames.forEach((frame, index) => {
      expect(frame.chunkIndex).toBe(index);
      expect(frame.final).toBe(index === frames.length - 1);
      expect(Boolean(frame.node)).toBe(index === 0);
      expect((frame.put?.length ?? 0) + (frame.keep?.length ?? 0)).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(CHUNK_BUDGET_BYTES);
    });
    expect(frames.flatMap((frame) => frame.put ?? []).map((e) => e.versionId)).toEqual(
      desired.map((e) => e.versionId),
    );
  });

  it("sends an empty complete operation when the node should hold nothing", () => {
    const frames = buildCompleteOperation({ opId: "op", desired: [], held: [], node: null });
    expect(frames).toEqual([
      {
        type: "runtime.define",
        opId: "op",
        chunkIndex: 0,
        final: true,
        complete: true,
        put: [],
        keep: [],
      },
    ]);
  });
});

describe("capDesired", () => {
  it("dedupes by version (best priority wins) and keeps live launch versions first", () => {
    const old = new Date("2026-01-01");
    const now = new Date("2026-10-01");
    const startables = Array.from({ length: 130 }, (_, n) => ({
      envelope: envelope(n + 10),
      priority: 4 as const,
      createdAt: now,
    }));
    const capped = capDesired([
      ...startables,
      { envelope: envelope(1), priority: 1, createdAt: old },
      { envelope: envelope(1), priority: 4, createdAt: now },
    ]);
    expect(capped).toHaveLength(128);
    expect(capped[0]?.versionId).toBe("v1");
    expect(capped.filter((e) => e.versionId === "v1")).toHaveLength(1);
  });
});

const ref: NodeSessionRef = {
  nodeId: "node-1",
  userId: "user-1",
  slug: "desk",
  connectionGeneration: 4,
  trust: "full",
};

function mockNode(trust: "FULL" | "RELAY" = "FULL") {
  db.node.findUnique.mockResolvedValue({
    userId: "user-1",
    trust,
    trustLowerRequestedAt: null,
    heldDefinitions: [],
    portStart: 30000,
    portEnd: 30999,
    metricCommands: [],
    commandMaxMs: 86_400_000,
    FabricMembers: [],
  });
}

describe("createRuntimeSync", () => {
  function setup() {
    const sent: ServerToNodeControlFrame[] = [];
    const session: { connectionGeneration: number; trust: "full" | "relay" } = {
      connectionGeneration: 4,
      trust: "full",
    };
    const relay = {
      sendToNode: vi.fn(
        (
          _nodeId: string,
          frame: ServerToNodeControlFrame,
          guard?: { connectionGeneration?: number; requireFullTrust?: boolean },
        ) => {
          if (guard?.requireFullTrust && session.trust !== "full") return false;
          if (
            guard?.connectionGeneration !== undefined &&
            guard.connectionGeneration !== session.connectionGeneration
          )
            return false;
          sent.push(frame);
          return true;
        },
      ),
      nodeSession: vi.fn(() => ({ ...session })),
      getOnlineNodeIds: vi.fn(() => ["node-1"]),
    };
    return { sent, relay, session, sync: createRuntimeSync(relay, { answerWaitMs: 200 }) };
  }

  it("answers expect at Full control and sends one complete operation after hello", async () => {
    mockNode();
    db.runtimeVersion.findMany.mockResolvedValue([]);
    const { sent, sync } = setup();
    expect(await sync.handlers.definitionSync?.(ref)).toBe("expect");
    expect(await sync.handlers.definitionSync?.({ ...ref, trust: "relay" })).toBe("none");
    await sync.handlers.nodeReady?.(ref);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const frame = sent[0];
    expect(frame?.type).toBe("runtime.define");
    if (frame?.type !== "runtime.define") return;
    expect(runtimeDefineFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.node?.metricCommands.commands).toEqual([]);
  });

  it("stores the node's final held set for the current connection", async () => {
    mockNode();
    db.runtimeVersion.findMany.mockResolvedValue([]);
    const { sent, sync } = setup();
    const done = sync.syncNode("node-1");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const opId = sent[0]?.type === "runtime.define" ? sent[0].opId : "";
    const held = [{ runtimeId: "rt1", versionId: "v1", launchHash: "a".repeat(64) }];
    await sync.handlers["runtime.define.result"]?.(ref, {
      type: "runtime.define.result",
      opId,
      chunkIndex: 0,
      final: true,
      results: [],
      held,
      heldMetricCommandsHash: null,
      heldPortRange: [30000, 30999],
      heldFabricsHash: null,
      frozen: false,
    });
    expect(await done).toMatchObject({ held });
    expect(db.node.updateMany).toHaveBeenCalledWith({
      where: { id: "node-1", connectionGeneration: 4 },
      data: { heldDefinitions: held, heldMetricCommandsHash: null, heldFabricsHash: null },
    });
  });

  it("sends nothing to a Relay-only node and reports the push skipped", async () => {
    mockNode("RELAY");
    const { sent, sync } = setup();
    expect(await sync.syncNode("node-1")).toBeNull();
    db.runtime.findFirst.mockResolvedValue({
      kind: "STARTABLE",
      nodeId: null,
      currentVersionId: "v1",
      origin: "SERVER",
    });
    db.node.findMany.mockResolvedValue([
      { id: "node-1", trust: "RELAY", trustLowerRequestedAt: null },
    ]);
    expect(await sync.pushRuntimeDefinitions({ userId: "user-1", runtimeId: "rt1" })).toEqual([
      { nodeId: "node-1", status: "skipped_trust_relay", reason: "trust_relay" },
    ]);
    expect(sent).toHaveLength(0);
  });

  it("reports the node's verdict on the runtime's current version, or pending", async () => {
    mockNode();
    const row = {
      id: "v1",
      createdAt: new Date(),
      launchHash: "",
      spec: serviceSpec("one"),
      Runtime: { id: "rt1", slug: "rt-one", kind: "STARTABLE" as const },
    };
    row.launchHash = runtimeLaunchHash(row.spec);
    db.runtimeVersion.findMany.mockResolvedValue([row]);
    db.runtime.findFirst.mockResolvedValue({
      kind: "STARTABLE",
      nodeId: null,
      currentVersionId: "v1",
      origin: "SERVER",
    });
    db.node.findMany.mockResolvedValue([
      { id: "node-1", trust: "FULL", trustLowerRequestedAt: null },
    ]);
    const { sent, sync } = setup();
    const push = sync.pushRuntimeDefinitions({ userId: "user-1", runtimeId: "rt1" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const frame = sent[0];
    if (frame?.type !== "runtime.define") throw new Error("expected a define");
    expect(frame.put?.map((entry) => entry.versionId)).toEqual(["v1"]);
    await sync.handlers["runtime.define.result"]?.(ref, {
      type: "runtime.define.result",
      opId: frame.opId,
      chunkIndex: 0,
      final: true,
      results: [{ runtimeId: "rt1", versionId: "v1", status: "rejected", reason: "invalid" }],
      held: [],
      heldMetricCommandsHash: null,
      heldPortRange: null,
      heldFabricsHash: null,
      frozen: false,
    });
    expect(await push).toEqual([{ nodeId: "node-1", status: "rejected", reason: "invalid" }]);

    // No answer within the wait: pending.
    const slow = sync.pushRuntimeDefinitions({ userId: "user-1", runtimeId: "rt1" });
    expect(await slow).toEqual([{ nodeId: "node-1", status: "pending", reason: null }]);
  });

  it("runs one operation per node and a queued sync after it", async () => {
    mockNode();
    db.runtimeVersion.findMany.mockResolvedValue([]);
    const { sent, sync } = setup();
    void sync.syncNode("node-1");
    const second = sync.syncNode("node-1");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const first = sent[0];
    if (first?.type !== "runtime.define") throw new Error("expected a define");
    const answer = (opId: string) =>
      sync.handlers["runtime.define.result"]?.(ref, {
        type: "runtime.define.result",
        opId,
        chunkIndex: 0,
        final: true,
        results: [],
        held: [],
        heldMetricCommandsHash: null,
        heldPortRange: null,
        heldFabricsHash: null,
        frozen: false,
      });
    // An answer to another operation is ignored.
    await answer("other");
    expect(sent).toHaveLength(1);
    await answer(first.opId);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const next = sent[1];
    if (next?.type !== "runtime.define") throw new Error("expected a define");
    await answer(next.opId);
    expect(await second).toMatchObject({ held: [] });
  });
});

describe("buildCompleteOperation limits", () => {
  it("sends the node part alone when it does not fit beside the first envelope", () => {
    const unit = (rank: number, part: string) => `ws-${part}-${rank}-${"y".repeat(3000)}`;
    const big = runtimeSpecSchema.parse({
      launch: {
        management: "service",
        groupSize: 4,
        resources: [{ kind: "unified", memoryGb: 8 }],
        labels: [],
        commands: [0, 1, 2, 3].map((rank) => ({
          start: `systemctl --user start ${unit(rank, "a")}`,
          stop: `systemctl --user stop ${unit(rank, "b")}`,
          status: `systemctl --user is-active ${unit(rank, "c")}`,
        })),
        health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
      },
    });
    const node = {
      ...NODE_PART,
      metricCommands: {
        hash: "b".repeat(64),
        commands: Array.from({ length: 16 }, (_, n) => ({
          name: `m${n}`,
          command: `echo ${"z".repeat(1900)}`,
          intervalSecs: 30,
          timeoutSecs: 5,
          format: "lines" as const,
        })),
      },
    };
    const desired = [0, 1].map((n) => ({ ...envelope(n), spec: big }));
    const frames = buildCompleteOperation({ opId: "op", desired, held: [], node });
    expect(frames[0]?.node).toBeDefined();
    expect(frames[0]?.put).toEqual([]);
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(CHUNK_BUDGET_BYTES);
      expect(runtimeDefineFrameSchema.safeParse(frame).success).toBe(true);
    }
    expect(frames.flatMap((frame) => frame.put ?? [])).toHaveLength(2);
  });
});

describe("createRuntimeSync sessions", () => {
  function setupSessions() {
    const sent: ServerToNodeControlFrame[] = [];
    const session = { connectionGeneration: 4, trust: "full" as "full" | "relay" };
    const relay = {
      sendToNode: vi.fn(
        (
          _n: string,
          frame: ServerToNodeControlFrame,
          guard?: { connectionGeneration?: number },
        ) => {
          if (guard?.connectionGeneration !== session.connectionGeneration) return false;
          sent.push(frame);
          return true;
        },
      ),
      nodeSession: vi.fn(() => ({ ...session })),
      getOnlineNodeIds: vi.fn(() => ["node-1"]),
    };
    return { sent, session, sync: createRuntimeSync(relay, { answerWaitMs: 200 }) };
  }
  const final = (opId: string) => ({
    type: "runtime.define.result" as const,
    opId,
    chunkIndex: 0,
    final: true,
    results: [],
    held: [],
    heldMetricCommandsHash: null,
    heldPortRange: null,
    heldFabricsHash: null,
    frozen: false,
  });

  it("a late disconnect of the old session does not end the new session's operation", async () => {
    mockNode();
    db.runtimeVersion.findMany.mockResolvedValue([]);
    const { sent, session, sync } = setupSessions();
    void sync.syncNode("node-1");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    session.connectionGeneration = 5;
    const next = { ...ref, connectionGeneration: 5 };
    sync.handlers.nodeReady?.(next);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    sync.handlers.nodeDisconnected?.(ref);
    const op = sent[1]?.type === "runtime.define" ? sent[1].opId : "";
    // The old session's answer to the new operation is ignored; the new session's counts.
    const updates = db.node.updateMany.mock.calls.length;
    await sync.handlers["runtime.define.result"]?.(ref, final(op));
    expect(db.node.updateMany.mock.calls.length).toBe(updates);
    await sync.handlers["runtime.define.result"]?.(next, final(op));
    expect(db.node.updateMany.mock.calls.length).toBe(updates + 1);
  });

  it("sends an unanswered operation again (bounded) on the same session", async () => {
    mockNode();
    db.runtimeVersion.findMany.mockResolvedValue([]);
    const sent: ServerToNodeControlFrame[] = [];
    const session = { connectionGeneration: 4, trust: "full" as const };
    const sync = createRuntimeSync(
      {
        sendToNode: (_n, frame) => {
          sent.push(frame);
          return true;
        },
        nodeSession: () => ({ ...session }),
        getOnlineNodeIds: () => ["node-1"],
      },
      { operationTimeoutMs: 5, retryBaseMs: 1 },
    );
    expect(await sync.syncNode("node-1")).toBeNull();
    // Three retries, then it waits for the next trigger.
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(4);
  });

  it("drops an operation whose session was replaced while it loaded", async () => {
    mockNode();
    const pending: Array<(rows: never[]) => void> = [];
    db.runtimeVersion.findMany.mockImplementation(
      () =>
        new Promise<never[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { sent, session, sync } = setupSessions();
    const first = sync.syncNode("node-1");
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    session.connectionGeneration = 5;
    db.runtimeVersion.findMany.mockResolvedValue([]);
    sync.handlers.nodeReady?.({ ...ref, connectionGeneration: 5 });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The first load finishes after its session was replaced: nothing more is sent.
    for (const release of pending) release([]);
    expect(await first).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Only the new session's operation was sent.
    expect(sent).toHaveLength(1);
  });
});
